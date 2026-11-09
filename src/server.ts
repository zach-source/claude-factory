// `factory server`: one long-lived process that ticks, holds the writer lease and answers /healthz
// (claude-factory-akiq.1, spec 004-factory-server FR-001, FR-007).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { CATALOG_VERSION, type Op } from './core/catalog'
import { commandStore } from './core/commands'
import { eventLog, sseResponse } from './core/events'
import * as managerLease from './lease'
import { clientHandler, clientListener, cliRunner, type RunResult, type Runner } from './server-api'

export type Lease = { holder: string; until: number }

export const leaseFile = (home: string) => join(home, 'server-lease.json')

function read(file: string): Lease | null | 'bad' {
  if (!existsSync(file)) return null
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))
    return typeof l?.holder === 'string' && Number.isFinite(l.until) ? l : 'bad'
  } catch {
    return 'bad'
  }
}

const other = (file: string): Lease | null => {
  const l = read(file)
  return l === 'bad' ? null : l
}

/**
 * Take, renew or refuse the lease. Return the lease in the file and whether `holder` owns it.
 * Take a lease that is missing or expired (until <= now). A corrupt file counts as live until its
 * mtime is older than ttlMs, so the check fails closed.
 * ponytail: two takers of one expired lease can both write. The last rename wins. The other taker
 * steps down at its next claim. A holder whose event loop blocks past ttlMs loses the lease, and its running tick still finishes and writes. Upgrade path: a Dolt `lease` row with compare-and-set (spec step S6).
 */
export function claim(
  file: string,
  holder: string,
  now: number,
  ttlMs: number,
): { held: boolean; lease: Lease | null } {
  const cur = read(file)
  if (cur === 'bad') {
    let age = 0
    try {
      age = now - statSync(file).mtimeMs
    } catch {}
    if (age <= ttlMs) return { held: false, lease: null }
  } else if (cur && cur.holder !== holder && cur.until > now) return { held: false, lease: cur }
  const mine: Lease = { holder, until: now + ttlMs }
  const tmp = `${file}.${holder.replace(/\W/g, '_')}.tmp`
  try {
    if (!cur) writeFileSync(file, JSON.stringify(mine), { flag: 'wx' })
    else {
      writeFileSync(tmp, JSON.stringify(mine))
      renameSync(tmp, file)
    }
  } catch {
    return { held: false, lease: other(file) }
  }
  const back = other(file)
  return back?.holder === holder ? { held: true, lease: mine } : { held: false, lease: back }
}

/** remove the lease only when `holder` owns it; never throws */
export function release(file: string, holder: string) {
  try {
    if (other(file)?.holder === holder) rmSync(file, { force: true })
  } catch {}
}

export const newHolder = () => `${hostname()}/${process.pid}/${randomBytes(4).toString('hex')}`

export type ServeOpts = {
  home: string
  port: number
  everyMs: number
  leaseMs: number
  tick: () => unknown
  holder?: string
  log?: (line: string) => void
  /** the client API on its own mTLS listener; `ca` is the person CA text; `handle` gets the request and the peer address */
  client?: {
    port: number
    cert: string
    key: string
    ca: string
    handle: (req: Request, ip: string) => Promise<Response>
    /** idle limit while the request is read, in ms; default 30000 */
    idleMs?: number
  }
}

/**
 * Run the tick loop under the lease and answer GET /healthz. `stop()` finishes the tick that runs and releases the lease.
 * With `client`, also serve the client API over mTLS. The `board` function gives the last tick result, null before the first tick.
 */
export function serve(o: ServeOpts) {
  let last: unknown = null
  const file = leaseFile(o.home)
  const holder = o.holder ?? newHolder()
  const log = o.log ?? ((l: string) => console.log(l))
  const h = {
    lease: 'waiting',
    holder: '',
    until: 0,
    ticks: 0,
    tickOk: null as boolean | null,
    tickAt: null as string | null,
  }
  let held = false
  let stopping = false
  let running: Promise<void> = Promise.resolve()
  let seen = ''
  const take = () => {
    const c = claim(file, holder, Date.now(), o.leaseMs)
    if (c.held && !held) log(`lease taken by ${holder}`)
    if (!c.held && held) log(`lease lost to ${c.lease?.holder ?? 'unknown'}`)
    if (!c.held && c.lease) {
      if (c.lease.holder !== seen)
        log(`lease held by ${c.lease.holder} until ${new Date(c.lease.until).toISOString()}`)
      seen = c.lease.holder
    }
    held = c.held
    h.lease = held ? 'held' : 'waiting'
    h.holder = c.lease?.holder ?? ''
    h.until = c.lease?.until ?? 0
    return held
  }
  const step = async () => {
    if (!take()) return
    try {
      const r = await o.tick()
      // a tick that found the lock busy has no rows: keep the last full result
      if (!(r as { busy?: boolean } | undefined)?.busy) last = r ?? null
      h.tickOk = true
    } catch (e) {
      h.tickOk = false
      log(
        `tick failed: ${String((e as Error)?.message ?? e)
          .split('\n')[0]!
          .slice(0, 300)}`,
      )
    }
    h.ticks++
    h.tickAt = new Date().toISOString()
  }
  let timer: ReturnType<typeof setTimeout>
  const next = () => {
    if (stopping) return
    running = step().finally(() => {
      if (!stopping) timer = setTimeout(next, o.everyMs)
    })
  }
  // Bun.serve first: if the port is busy it throws before any timer keeps the process alive.
  const server = Bun.serve({
    port: o.port,
    fetch(req) {
      const u = new URL(req.url)
      if (req.method === 'GET' && u.pathname === '/healthz') return Response.json(h)
      return new Response('not found\n', { status: 404 })
    },
  })
  // Not Bun.serve: its rejectUnauthorized did not gate the handler (see clientListener).
  let client: ReturnType<typeof clientListener> | undefined
  if (o.client) {
    try {
      client = clientListener(o.client)
    } catch (e) {
      void server.stop(true)
      throw e
    }
  }
  // A long tick keeps the lease. A blocked event loop does not run this timer, so leaseMs must outlast those stretches.
  const renew = setInterval(() => held && take(), Math.max(1, Math.floor(o.leaseMs / 3)))
  timer = setTimeout(next, 0)
  return {
    port: server.port,
    clientPort: client?.port,
    board: () => last,
    holder,
    async stop() {
      stopping = true
      clearTimeout(timer)
      await running
      clearInterval(renew)
      if (held) {
        held = false
        release(file, holder)
        log('lease released')
      }
      await server.stop(true)
      client?.stop()
    },
  }
}

const USAGE =
  'usage: factory server [--port 8080] [--every-ms 5000] [--lease-ms 60000] [--client-port 8444 --tls-cert <path> --tls-key <path> --person-ca <path>]'
const NUMS = {
  '--port': 'port',
  '--every-ms': 'everyMs',
  '--lease-ms': 'leaseMs',
  '--client-port': 'clientPort',
} as const
const PATHS = { '--tls-cert': 'cert', '--tls-key': 'key', '--person-ca': 'ca' } as const

/** Parse the flags of `factory server`. The four client flags come all together or not at all. Throw the usage text on a bad value. */
export function parseFlags(args: string[]) {
  const v = { port: 8080, everyMs: 5000, leaseMs: 60000, clientPort: undefined as number | undefined }
  const files: Partial<Record<(typeof PATHS)[keyof typeof PATHS], string>> = {}
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? ''
    const raw = args[i + 1]
    if (raw === undefined || seen.has(flag)) throw new Error(USAGE)
    seen.add(flag)
    if (flag in NUMS) {
      if (!/^\d+$/.test(raw)) throw new Error(USAGE)
      v[NUMS[flag as keyof typeof NUMS]] = Number(raw)
    } else if (flag in PATHS) {
      if (!raw || raw.startsWith('--')) throw new Error(USAGE)
      files[PATHS[flag as keyof typeof PATHS]] = raw
    } else throw new Error(USAGE)
  }
  if (v.everyMs <= 0 || v.leaseMs < 2 * v.everyMs || v.port > 65535) throw new Error(USAGE)
  const { clientPort, ...base } = v
  const given = [clientPort !== undefined, !!files.cert, !!files.key, !!files.ca].filter(Boolean).length
  if (given !== 0 && given !== 4) throw new Error(USAGE)
  if (clientPort === undefined) return { ...base, client: undefined }
  if (clientPort > 65535 || clientPort === v.port) throw new Error(USAGE)
  return { ...base, client: { port: clientPort, ...(files as Record<'cert' | 'key' | 'ca', string>) } }
}

/** read a file the server needs; a missing file throws its path, never its text */
function need(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${path}`)
  }
}

/** `factory server [--port 8080] [--every-ms 5000] [--lease-ms 60000] [--client-port ... --tls-cert ... --tls-key ... --person-ca ...]`. The caller passes the tick, so there is no import cycle with cli.ts. */
export function main(args: string[], home: string, tick: () => unknown) {
  const f = parseFlags(args)
  let s: ReturnType<typeof serve> | undefined
  const log = (l: string) => console.log(l)
  const client = f.client && {
    port: f.client.port,
    cert: need(f.client.cert),
    key: need(f.client.key),
    ca: need(f.client.ca),
    handle: clientHandler({ home, run: cliRunner(home), board: () => s?.board() ?? null, log }),
  }
  s = serve({ home, port: f.port, everyMs: f.everyMs, leaseMs: f.leaseMs, tick, client })
  console.log(
    `factory server on :${s.port}${s.clientPort ? ` and client API on :${s.clientPort}` : ''} as ${s.holder}`,
  )
  const stop = () => void s!.stop().then(() => process.exit(0))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

// ---- the local core: `factory core` (claude-factory-hpmc.4, specs/008-frontend-parity/contracts/local-core.md) ----

export class CoreRefusal extends Error {}

const CORE_USAGE =
  'usage: factory core [--home <dir>] [--port <n>] | factory core [--home <dir>] status | factory core [--home <dir>] stop'

export type CoreFlags = { sub?: 'status' | 'stop'; home?: string; port?: number }

/** Parse the words after `factory core`. Throw the usage text on a bad form. */
export function parseCoreFlags(args: string[]): CoreFlags {
  const f: CoreFlags = {}
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '--home' || w === '--port') {
      const v = args[++i]
      if (v === undefined || v === '' || v.startsWith('--')) throw new Error(CORE_USAGE)
      if (w === '--home') {
        if (f.home !== undefined) throw new Error(CORE_USAGE)
        f.home = v
      } else {
        if (f.port !== undefined || !/^\d+$/.test(v) || Number(v) > 65535) throw new Error(CORE_USAGE)
        f.port = Number(v)
      }
    } else if ((w === 'status' || w === 'stop') && !f.sub) f.sub = w
    else throw new Error(CORE_USAGE)
  }
  if (f.sub && f.port !== undefined) throw new Error(CORE_USAGE)
  return f
}

/** Each step runs as `factory <argv>` in a child, so a long model call never blocks the listener or the lease renew. */
export const CORE_STEPS = [
  { name: 'patrol', everyMs: 60_000, argv: ['patrol', '--once'] },
  { name: 'brief', everyMs: 120_000, argv: ['brief', '--once'] },
  { name: 'review', everyMs: 300_000, argv: ['review', '--once'] },
  { name: 'decisions', everyMs: 300_000, argv: ['decisions'] },
  { name: 'pm', everyMs: 3_600_000, argv: ['pm', '--once'] },
]

/** pure: the steps to start now. A running step is never due. A halted board starts none. */
export function dueSteps(
  now: number,
  steps: { name: string; everyMs: number }[],
  ran: Record<string, number>,
  running: ReadonlySet<string>,
  halted: boolean,
): string[] {
  if (halted) return []
  return steps
    .filter(s => !running.has(s.name) && (ran[s.name] === undefined || now - ran[s.name]! >= s.everyMs))
    .map(s => s.name)
}

export type CoreDeps = {
  /** the tick; cli.ts keeps the result for the patrol (keepTick) */
  tick: () => Promise<unknown>
  /** takes or renews the manager lease: undefined when the core holds it, else the lease that blocks it */
  lease: () => managerLease.Lease | undefined
  /** the runner of the catalog operations */
  runner: Runner
  /** runs one step as a child process */
  step: (argv: string[], signal: AbortSignal) => Promise<RunResult>
}

export type CoreOpts = CoreDeps & {
  home: string
  port?: number
  everyMs: number
  steps?: typeof CORE_STEPS
  ops?: Op[]
  log?: (line: string) => void
}

const TOKEN_RE = /^[0-9a-f]{64}\n?$/
const sha = (s: string) => createHash('sha256').update(s).digest()
const coreRefuse = (status: number, why: string, extra: Record<string, string> = {}) =>
  new Response(`${JSON.stringify({ refused: why })}\n`, {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  })

function writeJsonAtomic(file: string, v: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(v)}\n`)
  renameSync(tmp, file)
}

/**
 * The token of the core. A new one is 32 random bytes in hex, written with mode 0600 and linked into place, so no reader sees part of it.
 * The core starts only on a regular file that the user owns, that no other user can read, and that holds a token.
 */
function coreToken(home: string): string {
  const file = join(home, 'core.token')
  const bad = (why: string) => new CoreRefusal(`${file} ${why}: remove the file and start the core again`)
  let exists = true
  try {
    lstatSync(file)
  } catch {
    exists = false
  }
  if (!exists) {
    const tmp = `${file}.${process.pid}.tmp`
    rmSync(tmp, { force: true })
    writeFileSync(tmp, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
    chmodSync(tmp, 0o600)
    try {
      linkSync(tmp, file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e // two cores start at once: the other one won
    } finally {
      rmSync(tmp, { force: true })
    }
  }
  const st = lstatSync(file)
  if (!st.isFile()) throw bad('is not a regular file')
  if (st.uid !== process.getuid!()) throw bad('is not owned by you')
  if (st.mode & 0o077) throw bad('can be read by other users')
  const t = readFileSync(file, 'utf8')
  if (!TOKEN_RE.test(t)) throw bad('does not hold a token')
  return t.replace(/\n$/, '')
}

/** the port that the last core of this home used, when core.json holds one */
function lastPort(home: string): number | undefined {
  try {
    const p = (JSON.parse(readFileSync(join(home, 'core.json'), 'utf8')) as { port?: unknown }).port
    return Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535 ? (p as number) : undefined
  } catch {
    return undefined
  }
}

const firstLine = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split('\n')[0]!
    .slice(0, 300)

/**
 * The local core: token, lease, bind, core.json, then the tick loop, the lease renew and the step timers.
 * A refusal throws CoreRefusal and undoes what the start did. `handle` is the fetch handler of the listener.
 * ponytail: the event log and the command records live in memory (see core/events.ts and core/commands.ts).
 */
export function startCore(o: CoreOpts) {
  if (!Number.isInteger(o.everyMs) || o.everyMs < 100 || o.everyMs > 5000)
    throw new CoreRefusal('FACTORY_CORE_TICK_MS must be an integer from 100 to 5000')
  const log = o.log ?? ((l: string) => console.log(l))
  const steps = o.steps ?? CORE_STEPS
  mkdirSync(o.home, { recursive: true, mode: 0o700 })
  const token = coreToken(o.home)
  const wantAuth = sha(`Bearer ${token}`)

  const holder = `core:${process.pid}`
  const line = (l: managerLease.Lease) =>
    typeof l.at === 'number' ? managerLease.leaseLine(l, Date.now()) : `${l.holder} holds the manager lease`
  const busy = (l: managerLease.Lease) =>
    l.holder === 'unknown' || l.holder === holder || managerLease.isStale(l, Date.now())
  let held: managerLease.Lease | undefined
  let taken = false
  for (let i = 0; i < 10 && !taken; i++) {
    held = o.lease()
    if (!held) taken = true
    else if (!busy(held)) break
    else if (i < 9) Bun.sleepSync(200)
  }
  if (!taken) throw new CoreRefusal(`factory core: ${line(held!)}`)
  const undo = () => {
    if (managerLease.readLease(o.home)?.holder === holder) managerLease.release(o.home)
  }

  const events = eventLog()
  const cmds = commandStore(id => events.emit(`command:${id}`))
  const startedAt = new Date().toISOString()
  const status: Record<string, { lastAt: string | null; code: number | null; running: boolean }> = {}
  for (const s of steps) status[s.name] = { lastAt: null, code: null, running: false }
  let state: 'ticking' | 'stopping' = 'ticking'
  let board: unknown
  let ticks = 0
  let lastTickAt: string | null = null
  let lastTickOk: boolean | null = null
  let rowsSeen = new Map<string, string>()
  let boardSig = ''
  let lastDecisions: string | undefined
  let port = 0

  const api = clientHandler({
    home: o.home,
    run: o.runner,
    board: () => board ?? null,
    log,
    ops: o.ops,
    long: (op, run) => cmds.start(op.name, run),
  })

  const hostOk = (h: string | null) => h === `127.0.0.1:${port}` || h === `localhost:${port}`
  /** the guard, in order: Host, bearer token, browser rule. It returns the refusal, or undefined to pass. */
  const guard = (req: Request): Response | undefined => {
    if (!hostOk(req.headers.get('host'))) return coreRefuse(403, 'bad host')
    const got = sha(req.headers.get('authorization') ?? '')
    if (!timingSafeEqual(got, wantAuth))
      return coreRefuse(401, 'bearer token required', { 'www-authenticate': 'Bearer' })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin')
      const site = req.headers.get('sec-fetch-site')
      if (origin !== null || site !== null) {
        const own = origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
        if (
          !own ||
          req.headers.get('x-factory-intent') !== 'operator-ui-v1' ||
          (site !== null && site !== 'same-origin')
        )
          return coreRefuse(403, 'browser request needs the core origin and X-Factory-Intent: operator-ui-v1')
      }
    }
    return undefined
  }

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method === 'GET') {
      if (url.pathname === '/v1/core')
        return Response.json({
          state,
          holder,
          pid: process.pid,
          port,
          startedAt,
          catalogVersion: CATALOG_VERSION,
          ticks,
          lastTickAt,
          lastTickOk,
          steps: status,
          eventSeq: events.last(),
        })
      if (url.pathname === '/v1/events')
        return sseResponse(events, url.searchParams.get('after') ?? undefined)
      const m = /^\/v1\/commands\/([^/]+)$/.exec(url.pathname)
      if (m) {
        const c = cmds.get(m[1]!)
        return c ? Response.json(c) : coreRefuse(404, 'no such command')
      }
    }
    const h = new Headers(req.headers)
    h.delete('authorization')
    return api(new Request(req, { headers: h }), '127.0.0.1')
  }

  const handle = async (req: Request): Promise<Response> => {
    const res =
      guard(req) ?? (await route(req).catch(e => coreRefuse(500, `internal error: ${firstLine(e)}`)))
    const out = new Response(res.body, res)
    out.headers.set('cache-control', 'no-store')
    out.headers.set('x-content-type-options', 'nosniff')
    return out
  }

  let server: ReturnType<typeof Bun.serve>
  const bind = (p: number) =>
    Bun.serve({ hostname: '127.0.0.1', port: p, idleTimeout: 255, fetch: req => handle(req) })
  try {
    const want = o.port ?? lastPort(o.home) ?? 0
    try {
      server = bind(want)
    } catch (e) {
      if (o.port !== undefined || want === 0) throw e
      server = bind(0) // the last port is busy: any free port will do
    }
    port = server.port!
  } catch (e) {
    undo()
    throw new CoreRefusal(`factory core: cannot listen on 127.0.0.1: ${firstLine(e)}`)
  }
  const coreJson = join(o.home, 'core.json')
  writeJsonAtomic(coreJson, { port, pid: process.pid, holder, startedAt, catalogVersion: CATALOG_VERSION })

  let doneCode!: (c: number) => void
  const done = new Promise<number>(r => (doneCode = r))
  const ac = new AbortController()
  const inflight = new Set<Promise<void>>()
  const running = new Set<string>()
  const ran: Record<string, number> = {}
  let stopping = false

  const diff = (out: { runs?: unknown; halt?: unknown } | undefined) => {
    const cur = new Map<string, string>()
    if (Array.isArray(out?.runs))
      for (const r of out.runs) if (typeof r?.id === 'string') cur.set(r.id, JSON.stringify(r))
    for (const [id, s] of cur) if (rowsSeen.get(id) !== s) events.emit(`run:${id}`)
    for (const id of rowsSeen.keys()) if (!cur.has(id)) events.emit(`run:${id}`)
    rowsSeen = cur
    const sig = JSON.stringify([out?.runs, out?.halt])
    if (sig !== boardSig) {
      boardSig = sig
      events.emit('board')
    }
  }

  const runTick = async () => {
    try {
      const out = (await o.tick()) as { busy?: boolean; runs?: unknown; halt?: unknown } | undefined
      lastTickOk = true
      if (!out?.busy) {
        board = out ?? null
        diff(out)
      }
    } catch (e) {
      lastTickOk = false
      log(`tick failed: ${firstLine(e)}`)
    }
    ticks++
    lastTickAt = new Date().toISOString()
  }

  const launch = (s: { name: string; argv: string[] }) => {
    running.add(s.name)
    ran[s.name] = Date.now()
    status[s.name]!.running = true
    const t0 = Date.now()
    const p: Promise<void> = (async () => {
      let r: RunResult
      try {
        r = await o.step(s.argv, ac.signal)
      } catch (e) {
        r = { code: 1, out: '', err: firstLine(e) }
      }
      running.delete(s.name)
      log(`step ${s.name} exit ${r.code} in ${Math.round((Date.now() - t0) / 1000)}s`)
      status[s.name] = { lastAt: new Date().toISOString(), code: r.code, running: false }
      events.emit(`step:${s.name}`)
      if (s.name === 'decisions' && r.out !== lastDecisions) {
        lastDecisions = r.out
        events.emit('decisions')
      }
    })().finally(() => inflight.delete(p))
    inflight.add(p)
  }
  const startDue = () => {
    const halted = !!(board as { halt?: unknown } | null | undefined)?.halt
    for (const n of dueSteps(Date.now(), steps, ran, running, halted)) launch(steps.find(s => s.name === n)!)
  }

  let wake = () => {}
  const pause = (ms: number) =>
    new Promise<void>(r => {
      const t = setTimeout(r, ms)
      wake = () => {
        clearTimeout(t)
        r()
      }
    })

  let stopP: Promise<void> | undefined
  /** `keep` leaves the lease alone (it was lost); `code` is the exit code that `done` gives */
  const stop = (keep = false, code = 0): Promise<void> =>
    (stopP ??= (async () => {
      state = 'stopping'
      stopping = true
      clearInterval(renew)
      wake()
      await loop
      ac.abort() // each step child gets SIGTERM now, SIGKILL after 10 s (cliRunner)
      await Promise.all([...inflight])
      events.close()
      await server.stop(true)
      // the steps are gone, so none can write the lease after this check
      if (!keep) undo()
      writeJsonAtomic(coreJson, {
        port,
        catalogVersion: CATALOG_VERSION,
        stoppedAt: new Date().toISOString(),
      })
      doneCode(code)
    })())

  const renew = setInterval(() => {
    if (stopping) return
    let r: managerLease.Lease | undefined
    try {
      r = o.lease()
    } catch (e) {
      log(`lease renew failed: ${firstLine(e)}`)
      return
    }
    if (!r || busy(r)) return // a busy lock: the next interval tries again
    log(`lease lost: ${line(r)}`)
    void stop(true, 1)
  }, o.everyMs)

  const loop = (async () => {
    while (!stopping) {
      await runTick()
      if (stopping) break
      try {
        startDue()
      } catch (e) {
        log(`step start failed: ${firstLine(e)}`)
      }
      await pause(o.everyMs)
    }
  })()

  return { port, holder, handle, stop: () => stop(), done }
}

/** Reads FACTORY_CORE_TICK_MS, starts the core and prints the start line. SIGTERM and SIGINT stop it. A refusal prints to stderr and exits 1. */
export function coreMain(flags: CoreFlags, home: string, deps: CoreDeps) {
  const raw = process.env.FACTORY_CORE_TICK_MS
  const everyMs = raw === undefined ? 5000 : /^\d+$/.test(raw) ? Number(raw) : NaN
  let core: ReturnType<typeof startCore>
  try {
    core = startCore({ ...deps, home, port: flags.port, everyMs })
  } catch (e) {
    console.error(e instanceof CoreRefusal ? e.message : `factory core: ${firstLine(e)}`)
    process.exit(1)
  }
  console.log(`core ${core.holder} runs on http://127.0.0.1:${core.port} (home ${home})`)
  const stop = () => void core.stop()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  void core.done.then(c => process.exit(c))
}
