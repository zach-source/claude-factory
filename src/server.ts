// `factory server`: one long-lived process that ticks, holds the writer lease and answers /healthz
// (claude-factory-akiq.1, spec 004-factory-server FR-001, FR-007).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Port } from './core/catalog'
import { EXCLUDES, type BackupCfg } from './homebackup'
import { clientHandler, clientListener, cliRunner } from './server-api'

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
  /** called with each accepted tick result (not a busy one), before the next tick */
  onBoard?: (board: unknown) => void
  /** the home backup: `run` starts every `everyMs` while this server holds the lease and no earlier `run` is pending */
  backup?: { everyMs: number; run: () => Promise<unknown> }
  /** the manager patrol (claude-factory-akiq.15): the same rules as `backup`, with its own pending flag */
  patrol?: { everyMs: number; run: () => Promise<unknown>; kill?: () => void }
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
      if (!(r as { busy?: boolean } | undefined)?.busy) {
        last = r ?? null
        o.onBoard?.(last)
      }
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
  // one timer for each job; a job never overlaps itself, and runs only while this server holds the lease
  const job = (name: string, j?: { everyMs: number; run: () => Promise<unknown> }) => {
    let pending = false
    return j
      ? setInterval(() => {
          if (!held || pending || stopping) return
          pending = true
          void Promise.resolve()
            .then(j.run)
            .catch(e =>
              log(
                `${name} failed: ${String((e as Error)?.message ?? e)
                  .split('\n')[0]!
                  .slice(0, 300)}`,
              ),
            )
            .finally(() => {
              pending = false
            })
        }, j.everyMs)
      : undefined
  }
  const backupTimer = job('backup', o.backup)
  const patrolTimer = job('patrol', o.patrol)
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
      clearInterval(backupTimer)
      clearInterval(patrolTimer)
      o.patrol?.kill?.()
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
  'usage: factory server [--port 8080] [--every-ms 5000] [--lease-ms 60000] [--patrol-every-ms 0] [--client-port 8444 --tls-cert <path> --tls-key <path> --person-ca <path>]'
const NUMS = {
  '--port': 'port',
  '--every-ms': 'everyMs',
  '--lease-ms': 'leaseMs',
  '--patrol-every-ms': 'patrolMs',
  '--client-port': 'clientPort',
} as const
const PATHS = { '--tls-cert': 'cert', '--tls-key': 'key', '--person-ca': 'ca' } as const

/** Parse the flags of `factory server`. The four client flags come all together or not at all. Throw the usage text on a bad value. */
export function parseFlags(args: string[]) {
  const v = {
    port: 8080,
    everyMs: 5000,
    leaseMs: 60000,
    patrolMs: 0,
    clientPort: undefined as number | undefined,
  }
  const files: Partial<Record<(typeof PATHS)[keyof typeof PATHS], string>> = {}
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? ''
    const raw = args[i + 1]
    if (raw === undefined || seen.has(flag)) throw new Error(USAGE)
    seen.add(flag)
    if (Object.hasOwn(NUMS, flag)) {
      if (!/^\d+$/.test(raw)) throw new Error(USAGE)
      v[NUMS[flag as keyof typeof NUMS]] = Number(raw)
    } else if (Object.hasOwn(PATHS, flag)) {
      if (!raw || raw.startsWith('--')) throw new Error(USAGE)
      files[PATHS[flag as keyof typeof PATHS]] = raw
    } else throw new Error(USAGE)
  }
  if (v.everyMs <= 0 || v.leaseMs < 2 * v.everyMs || v.port > 65535) throw new Error(USAGE)
  if (v.patrolMs !== 0) throw new Error('server patrol needs an isolated runner; use --patrol-every-ms 0')
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

const REMOTE = /^(https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s@]+|\/[^\s]+)$/
const BRANCH = /^[\w.-]+(\/[\w.-]+)*$/

/**
 * The server home backup (claude-factory-a962) from env. The backup is on only when every check passes; the first failure wins.
 * Return undefined with no remote, { off } with the reason (never the remote or the token), else the config and the period.
 * The token is in a file (a Kubernetes Secret), never in env, so no child process inherits it.
 */
export function serverBackupCfg(
  env: Record<string, string | undefined>,
  home: string,
): undefined | { off: string } | { cfg: BackupCfg; everyMs: number } {
  const remote = env.FACTORY_SERVER_BACKUP_REMOTE
  if (!remote) return undefined
  if (!REMOTE.test(remote)) return { off: 'backup off: the remote is not an https URL with no user info' }
  if (basename(home) !== 'home') return { off: 'backup off: FACTORY_HOME is not <workspace>/home' }
  const branch = env.FACTORY_SERVER_BACKUP_BRANCH || 'server-home'
  if (!BRANCH.test(branch) || branch === 'manager-home') return { off: 'backup off: bad branch' }
  const file = env.FACTORY_SERVER_BACKUP_AUTH_FILE
  if (!file) return { off: 'backup off: no auth file' }
  let auth: string
  try {
    auth = readFileSync(file, 'utf8').trim()
  } catch {
    return { off: `backup off: cannot read the auth file ${file}` }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(auth)) return { off: 'backup off: the auth file is not base64' }
  const every = env.FACTORY_SERVER_BACKUP_EVERY
  const ms = every && /^\d+$/.test(every) && Number(every) >= 60_000 ? Number(every) : 600_000
  return {
    cfg: { ws: dirname(home), remote, branch, auth, excludes: [...EXCLUDES, '/home/server-lease.json*'] },
    everyMs: ms,
  }
}

/** `factory server [--port 8080] [--every-ms 5000] [--lease-ms 60000] [--client-port ... --tls-cert ... --tls-key ... --person-ca ...]`. The caller passes the tick, so there is no import cycle with cli.ts. */
export function main(
  args: string[],
  home: string,
  tick: () => unknown,
  port: Port,
  backup?: () => Promise<unknown>,
) {
  const f = parseFlags(args)
  let s: ReturnType<typeof serve> | undefined
  const log = (l: string) => console.log(l)
  const handle = clientHandler({ home, run: cliRunner(home), port, board: () => s?.board() ?? null, log })
  const client = f.client && {
    port: f.client.port,
    cert: need(f.client.cert),
    key: need(f.client.key),
    ca: need(f.client.ca),
    handle,
  }
  const b = serverBackupCfg(process.env, home)
  s = serve({
    home,
    port: f.port,
    everyMs: f.everyMs,
    leaseMs: f.leaseMs,
    tick,
    onBoard: handle.publish,
    client,
    backup: b && 'cfg' in b && backup ? { everyMs: b.everyMs, run: backup } : undefined,
  })
  console.log(
    `factory server on :${s.port}${s.clientPort ? ` and client API on :${s.clientPort}` : ''} as ${s.holder}`,
  )
  if (b) console.log('off' in b ? b.off : `backup on: branch ${b.cfg.branch} every ${b.everyMs} ms`)
  const stop = () => void s!.stop().then(() => process.exit(0))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
