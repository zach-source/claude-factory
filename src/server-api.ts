// Client API of `factory server` on port 8444 (claude-factory-akiq.7). Contract: specs/004-factory-server/contracts/client-api.md.
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { STATUS_CODES } from 'node:http'
import type { Socket } from 'node:net'
import { join, resolve, sep } from 'node:path'
import { createServer as createTlsServer, type TLSSocket, type TlsOptions } from 'node:tls'
import {
  CATALOG,
  boardView,
  OpError,
  readBody,
  readQuery,
  type Ctx,
  type Input,
  type Op,
  type Port,
  type RunResult,
  type Runner,
} from './core/catalog'
import { where } from './machine'
import { check } from './tokens'
export type { RunResult, Runner } from './core/catalog'

const NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Make a new folder with the person CA, the person certificate and the server certificate.
 * If the folder exists or the name is bad, throw before any write. Call openssl with an argv array, not a shell.
 * ponytail: the person CA also signs the server certificate, because the client pins one ca.crt. That certificate has serverAuth only, so the CA does not accept it as a client certificate.
 */
export function personCerts(dir: string, serverName: string) {
  if (!NAME.test(serverName)) throw new Error('server-name must match ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$')
  if (existsSync(dir)) throw new Error(`${dir} exists: choose a new folder, no key is overwritten`)
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
  const ssl = (...a: string[]) => {
    const r = Bun.spawnSync(['openssl', ...a], { cwd: dir })
    if (r.exitCode !== 0) throw new Error(`openssl ${a[0]} failed: ${r.stderr.toString().slice(0, 300)}`)
  }
  const key = (n: string) => {
    ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${n}.key`)
    chmodSync(join(dir, `${n}.key`), 0o600)
  }
  const leaf = (n: string, cn: string, ext: string) => {
    key(n)
    ssl('req', '-new', '-key', `${n}.key`, '-subj', `/CN=${cn}`, '-out', `${n}.csr`)
    writeFileSync(join(dir, `${n}.ext`), ext)
    ssl(
      ...['x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial'],
      ...['-days', '825', '-sha256', '-extfile', `${n}.ext`, '-out', `${n}.crt`],
    )
  }
  try {
    key('ca')
    ssl(
      ...[
        'req',
        '-x509',
        '-new',
        '-key',
        'ca.key',
        '-sha256',
        '-days',
        '825',
        '-subj',
        '/CN=factory-person-ca',
      ],
      ...[
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign',
        '-out',
        'ca.crt',
      ],
    )
    leaf('person', 'person', 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n')
    const san = IPV4.test(serverName) ? `IP:${serverName}` : `DNS:${serverName}`
    leaf(
      'server',
      serverName,
      `extendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nsubjectAltName=${san}\n`,
    )
    for (const f of ['person.csr', 'person.ext', 'server.csr', 'server.ext', 'ca.srl'])
      rmSync(join(dir, f), { force: true })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  return [
    `made ${dir}: ca.key ca.crt person.key person.crt server.key server.crt. Next steps for the owner:`,
    `  1. Copy person.crt, person.key and ca.crt to ~/.config/factory/ on the laptop (person.key mode 0600).`,
    `  2. kubectl -n factory create secret tls factory-server-tls --cert=${dir}/server.crt --key=${dir}/server.key`,
    `  3. kubectl -n factory create secret generic factory-person-ca --from-file=ca.crt=${dir}/ca.crt`,
    `  4. Keep ca.key offline: move it off this machine.`,
  ].join('\n')
}

export type ClientOpts = {
  home: string
  run: Runner
  /** the cli.ts helpers that the in-process operations call */
  port: Port
  /** the last tick result, null before the first tick */
  board: () => unknown
  log?: (line: string) => void
  /** the limit of one call, 60 s by default */
  callTimeoutMs?: number
}

const WORKER_ENV = [
  'FACTORY_SERVER',
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'FACTORY_OUTBOX',
  'BEADS_ACTOR',
]

/** the env of a CLI call for the person: no worker marker, no server mode, and the server home */
export function personEnv(env: Record<string, string | undefined>, home: string) {
  const e = { ...env }
  for (const n of WORKER_ENV) delete e[n]
  return { ...e, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' } as Record<string, string>
}

/**
 * The real runner: one `bun cli.ts <argv>` process for each call, with cwd = home. It has no shell.
 * Report and mail text use <home>/text/<uuid>.md and their file flags. The file is gone when the call ends.
 * ponytail: one bun process per call (about 0.3 s). Upgrade path: export the command functions from cli.ts and call them in process.
 */
export function cliRunner(
  home: string,
  cli = join(import.meta.dir, 'cli.ts'),
  timeoutMs = 60_000,
): (argv: string[], text?: string, env?: Record<string, string>) => Promise<RunResult> {
  return async (argv, text, env) => {
    let file: string | undefined
    try {
      if (text !== undefined) {
        mkdirSync(join(home, 'text'), { recursive: true })
        file = join(home, 'text', `${randomUUID()}.md`)
        writeFileSync(file, text, { mode: 0o600 })
      }
      const proc = Bun.spawn(
        [
          process.execPath,
          cli,
          ...argv,
          ...(file ? [argv[0] === 'report' ? '--summary-file' : '--text-file', file] : []),
        ],
        {
          cwd: home,
          env: env ?? personEnv(process.env, home),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      let timedOut = false as boolean
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeoutMs)
      try {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { code, out, err, ...(timedOut ? { timedOut } : {}) }
      } finally {
        clearTimeout(timer)
      }
    } finally {
      if (file) rmSync(file, { force: true })
    }
  }
}

const KEY = /^[A-Za-z0-9-]{8,128}$/
const MAX_BODY = 128 * 1024
const DAY = 24 * 3600_000
const EVENTS_KEEP = 256

const reply = (status: number, body: string, json = true) =>
  new Response(body, { status, headers: { 'content-type': json ? 'application/json' : 'text/plain' } })
const refuse = (status: number, why: string) => reply(status, `${JSON.stringify({ refused: why })}\n`)
const looksJson = (s: string) => /^\s*[{[]/.test(s)

/** match a request path to an operation of the catalog; the segments are not checked yet */
function match(method: string, path: string): { op: Op; params: string[] } | undefined {
  const parts = path.split('/')
  for (const op of CATALOG) {
    const want = op.route.path.split('/')
    if (op.route.method !== method || want.length !== parts.length) continue
    if (want.every((w, i) => w.startsWith(':') || w === parts[i]))
      return { op, params: parts.filter((_, i) => want[i]!.startsWith(':')) }
  }
}

/** true when `cwd` is the run worktree or under it (a path separator bounds the prefix) */
function insideRunWorktree(home: string, id: string, cwd: string): boolean {
  let run: { worktree?: unknown; repo?: unknown }
  try {
    run = JSON.parse(readFileSync(join(home, 'runs', id, 'run.json'), 'utf8'))
  } catch {
    return false // no run: the CLI answers that
  }
  if (typeof run.worktree !== 'string' || !run.worktree || run.worktree === run.repo) return false
  const real = (p: string) => {
    try {
      return realpathSync(resolve(p))
    } catch {
      return resolve(p)
    }
  }
  const wt = real(run.worktree)
  const here = real(cwd)
  return here === wt || here.startsWith(wt + sep)
}

type Row = { at: number; hash: string; status: number; body: string }

/** the store rows, {} when the file is missing, 'bad' when it does not parse */
function readStore(file: string): Record<string, Row> | 'bad' {
  if (!existsSync(file)) return {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : 'bad'
  } catch {
    return 'bad'
  }
}

function writeStore(file: string, rows: Record<string, Row>, now: number) {
  const keep = Object.fromEntries(Object.entries(rows).filter(([, r]) => now - r.at < DAY))
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(keep))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file) // atomic: a reader never sees half a store
}

/**
 * The handler of the client port. The listener has already checked the person certificate (the TLS handshake is the identity).
 * Each refusal answers before the runner and writes no idempotency row. Actions run one at a time.
 */
export function clientHandler(o: ClientOpts) {
  const storeFile = join(o.home, 'client-idempotency.json')
  const auditFile = join(o.home, 'client-actions.jsonl')
  let chain: Promise<unknown> = Promise.resolve()
  // The ring of board changes. ponytail: volatile, 256 events, the ids restart with the process. Upgrade path: a durable log.
  let lastJson = 'null'
  let lastId = 0n
  const ring: { id: bigint; frame: string }[] = []
  type Sub = { send: (id: bigint, frame: string) => void }
  const subs = new Set<Sub>()
  const publish = (board: unknown) => {
    let view: unknown
    try {
      view = boardView(board) // a client frame never holds env, params or beadsRemote
    } catch {
      return // fail closed: a malformed board makes no frame
    }
    const json = JSON.stringify(view ?? null)
    if (json === lastJson) return
    lastJson = json
    const ev = { id: ++lastId, frame: `id: ${lastId}\ndata: ${json}\n\n` }
    ring.push(ev)
    if (ring.length > EVENTS_KEEP) ring.shift()
    for (const sub of [...subs]) sub.send(ev.id, ev.frame)
  }
  const events = (after: bigint, signal?: AbortSignal): Response => {
    const enc = new TextEncoder()
    let sub: Sub
    let seen = after
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          // a slow client that leaves more than 256 frames unread is closed, never skipped
          sub = {
            send(id, frame) {
              if (id <= seen) return
              if ((c.desiredSize ?? 0) <= 0) {
                subs.delete(sub)
                return c.close()
              }
              seen = id
              c.enqueue(enc.encode(frame))
            },
          }
          const stop = () => {
            subs.delete(sub)
            try {
              c.close()
            } catch {}
          }
          if (signal?.aborted) return stop()
          signal?.addEventListener('abort', stop, { once: true })
          for (const ev of ring) sub.send(ev.id, ev.frame)
          subs.add(sub)
        },
        cancel: () => void subs.delete(sub),
      },
      { highWaterMark: EVENTS_KEEP },
    )
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
  const call = async (op: Op, input: Input): Promise<Response> => {
    // a new env for each call, as cliRunner gave a new env to each subprocess
    const ctx: Ctx = {
      home: o.home,
      cli: o.run,
      board: o.board,
      env: personEnv(process.env, o.home),
      port: o.port,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // the work can continue after the 504 (ponytail: no cancel; upgrade path: an AbortSignal in the port)
      const limit = new Promise<{ timedOut: true }>(res => {
        timer = setTimeout(() => res({ timedOut: true }), o.callTimeoutMs ?? 60_000)
      })
      const r = await Promise.race([op.run(ctx, input), limit])
      if (r.timedOut) return refuse(504, 'the command timed out')
      if (r.code !== 0) return refuse(422, r.err.slice(0, 500))
      if (op.name === 'gc.run') return reply(200, JSON.stringify(r), true)
      return reply(200, r.out, op.output === 'json' || looksJson(r.out))
    } catch (e) {
      if (e instanceof OpError) return refuse(e.status, e.message)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  const handle = async (req: Request, ip: string): Promise<Response> => {
    // A worker token must not open this port, whatever the value or the route (FR-010).
    if (req.headers.has('authorization'))
      return refuse(403, 'worker tokens are not accepted on the client port')
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const a = /^(?:|\?after=([0-9]+))$/.exec(url.search)
      return a
        ? events(BigInt(a[1] ?? 0), req.signal)
        : refuse(400, 'the query must be empty or after=<digits>')
    }
    const m = match(req.method, url.pathname)
    if (!m) return refuse(404, 'no such route')
    const { op, params } = m
    const q = readQuery(op, params, url.search)
    if (typeof q === 'string') return refuse(400, q)
    // ponytail: op.rights is not enforced. Every caller holds the person certificate, so every caller is the owner. Enforcement needs identity transport (aya5.6).
    if (op.route.method === 'GET') {
      try {
        return await call(op, q)
      } catch (e) {
        return refuse(500, `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      }
    }

    const key = req.headers.get('idempotency-key') ?? ''
    if (op.mutates && !KEY.test(key)) return refuse(400, 'Idempotency-Key must match ^[A-Za-z0-9-]{8,128}$')
    if (!/^application\/json\s*(;.*)?$/i.test(req.headers.get('content-type') ?? ''))
      return refuse(400, 'content-type must be application/json')
    const len = Number(req.headers.get('content-length') ?? 0)
    if (len > MAX_BODY) return refuse(400, 'body over 128 KiB')
    const raw = await req.text()
    if (Buffer.byteLength(raw) > MAX_BODY) return refuse(400, 'body over 128 KiB')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return refuse(400, 'body is not JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return refuse(400, 'body must be an object')
    const body = readBody(op, q, parsed as Record<string, unknown>)
    if (typeof body === 'string') return refuse(400, body)
    if (op.name === 'runs.start' && (body.goal as string).split(/\s+/).includes('--owned'))
      return refuse(400, 'the goal must not hold the word --owned: set owned')
    if (op.name === 'runs.mail' && insideRunWorktree(o.home, body.id as string, body.cwd as string))
      return refuse(403, 'a worker cannot send mail as the manager from inside the run worktree')

    if (!op.mutates) {
      try {
        return await call(op, body)
      } catch (e) {
        return refuse(500, `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      }
    }

    const path = url.pathname
    const hash = createHash('sha256').update(`${req.method}\0${path}\0${raw}`).digest('hex')
    const work = async (): Promise<Response> => {
      const rows = readStore(storeFile)
      let res: Response
      if (rows === 'bad') res = refuse(503, 'the idempotency store is corrupt')
      else {
        const now = Date.now()
        const row = rows[key]
        if (row && now - row.at < DAY) {
          res =
            row.hash === hash
              ? reply(row.status, row.body, looksJson(row.body))
              : refuse(409, 'Idempotency-Key was used for another request')
        } else {
          res = await call(op, body)
          rows[key] = { at: now, hash, status: res.status, body: await res.clone().text() }
          writeStore(storeFile, rows, now)
        }
      }
      const line: Record<string, unknown> = {
        at: new Date().toISOString(),
        ip,
        method: req.method,
        path,
        key,
        status: res.status,
      }
      if (op.name === 'gates.decide') line.outcome = body.outcome
      try {
        appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 })
      } catch (e) {
        o.log?.(`audit write failed: ${(e as Error).message}`)
      }
      o.log?.(`client ${req.method} ${path} ${res.status} from ${ip}`)
      return res
    }
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next.catch(e => refuse(500, `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
  }
  return Object.assign(handle, {
    /** record a board; an equal board adds no event */
    publish,
    /** the number of open event streams */
    subscribers: () => subs.size,
  })
}

export type WorkerRunner = (
  argv: string[],
  text: string | undefined,
  env: Record<string, string>,
) => Promise<RunResult>

type CallRow = {
  at: number
  run: string
  node: string
  seq: number
  token: string // the token id from check, never the raw token
  kind: 'report' | 'mail' | 'progress'
  args: Record<string, unknown> | null
  status: 'pending' | 'applied' | 'refused'
  reason: string | null
  hash: string
  http: number
  body: string
}

const WEEK = 7 * DAY
// a row keeps the call args only when their JSON is this short; else it keeps the byte count
const ARGS_MAX = 2048
// the same cap as OUTBOX_MAX_BYTES in src/worker.ts
const TEXT_MAX = 102_400
const WORKER_KINDS = { '/v1/report': 'report', '/v1/mail': 'mail', '/v1/progress': 'progress' } as const
const WORKER_KEYS = {
  report: ['outcome', 'summary'],
  mail: ['to', 'text'],
  progress: ['note'],
} as const
const IDENT = ['run', 'node', 'seq']
const BEARER = /^Bearer ([A-Za-z0-9._-]{1,4096})$/

/** the call rows, {} when the file is missing, 'bad' when it does not parse */
function readCalls(file: string): Record<string, CallRow> | 'bad' {
  return readStore(file) as Record<string, CallRow> | 'bad'
}

/** write the rows that are under 7 days old; atomic, mode 0600 */
function writeCalls(file: string, rows: Record<string, CallRow>, now: number) {
  const keep = Object.fromEntries(Object.entries(rows).filter(([, r]) => now - r.at < WEEK))
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(keep))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

const nonBlank = (v: unknown, max: number, units: 'bytes' | 'chars'): v is string =>
  typeof v === 'string' && v.trim() !== '' && (units === 'bytes' ? Buffer.byteLength(v) : v.length) <= max

/** the grammar of one body; return the reason of the first rule that fails */
function workerBody(kind: keyof typeof WORKER_KEYS, b: Record<string, unknown>): string | undefined {
  const want = WORKER_KEYS[kind]
  const keys = Object.keys(b).filter(k => !IDENT.includes(k))
  if (keys.length !== want.length || !want.every(k => keys.includes(k)))
    return `body keys must be ${want.join(', ')} (and the optional ${IDENT.join(', ')})`
  if (kind === 'report') {
    if (typeof b.outcome !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(b.outcome))
      return 'outcome must match ^[a-z][a-z0-9-]{0,63}$'
    if (!nonBlank(b.summary, TEXT_MAX, 'bytes'))
      return 'summary must be a non-blank string of at most 102400 bytes'
  } else if (kind === 'mail') {
    if (typeof b.to !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(b.to))
      return 'to must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    if (!nonBlank(b.text, TEXT_MAX, 'bytes')) return 'text must be a non-blank string of at most 102400 bytes'
  } else if (!nonBlank(b.note, 2000, 'chars'))
    return 'note must be a non-blank string of at most 2000 characters'
}

/**
 * The handler of the worker port (claude-factory-akiq.9). Contract: specs/004-factory-server/contracts/worker-api.md.
 * The run, node and seq come only from the Bearer token. A body that names another value gets 403.
 * Each call that has a live token and a good Idempotency-Key makes one row in <home>/worker-calls.json.
 * A repeated key replays the first answer and runs nothing. Calls run one at a time, in a chain of their own.
 * ponytail: the rows are a JSON file on the PVC, kept 7 days. Upgrade path: the Dolt worker_calls table (spec step S6).
 */
export function workerHandler(o: {
  home: string
  key: Buffer
  run: WorkerRunner
  held: () => boolean
  log?: (line: string) => void
  now?: () => number
}): (req: Request, ip: string) => Promise<Response> {
  const file = join(o.home, 'worker-calls.json')
  const clock = o.now ?? Date.now
  let chain: Promise<unknown> = Promise.resolve()
  return async (req, ip) => {
    const no = (status: number, why: string) => {
      o.log?.(`worker refused ${status} ${why} from ${ip}`)
      return refuse(status, why)
    }
    const url = new URL(req.url)
    const kind =
      req.method === 'POST' && url.search === ''
        ? WORKER_KINDS[url.pathname as keyof typeof WORKER_KINDS]
        : undefined
    if (!kind) return no(404, 'no such route')
    if (!o.held()) return no(503, 'this server does not hold the lease')
    const m = BEARER.exec(req.headers.get('authorization') ?? '')
    if (!m) return no(403, 'a Bearer worker token is required')
    const chk = check(o.home, o.key, m[1]!, clock())
    if (!chk.ok) return no(403, `token ${chk.reason}`)
    const { id: tokenId, claims } = chk
    if (
      claims.run === '.' ||
      claims.run === '..' ||
      claims.node === '.' ||
      claims.node === '..' ||
      claims.node === 'manager'
    )
      return no(403, 'token claims are not a run station')
    const key = req.headers.get('idempotency-key') ?? ''
    if (!KEY.test(key)) return no(400, 'Idempotency-Key must match ^[A-Za-z0-9-]{8,128}$')
    const raw = await req.text()

    const work = async (): Promise<Response> => {
      const live = check(o.home, o.key, m[1]!, clock())
      if (!live.ok) return no(403, `token ${live.reason}`)
      const rows = readCalls(file)
      if (rows === 'bad') return no(503, 'the worker call store is corrupt')
      const t = clock()
      const hash = createHash('sha256').update(`${req.method}\0${url.pathname}\0${raw}`).digest('hex')
      const old = rows[key]
      if (old && t - old.at < WEEK) {
        if (old.token !== tokenId || old.hash !== hash)
          return no(409, 'Idempotency-Key was used for another request')
        if (old.status === 'pending')
          return no(409, 'the first call with this key did not finish; its result is unknown')
        return reply(old.http, old.body)
      }
      if (!o.held()) return no(503, 'this server does not hold the lease')

      const put = (row: CallRow) => {
        const cur = readCalls(file)
        if (cur === 'bad') throw new Error('the worker call store is corrupt')
        cur[key] = row
        writeCalls(file, cur, clock())
      }
      const base = { at: t, run: claims.run, node: claims.node, seq: claims.seq, token: tokenId, kind, hash }
      let args: Record<string, unknown> | null = null
      const refused = (res: Response, why: string, text: string): Response => {
        put({ ...base, args, status: 'refused', reason: why, http: res.status, body: text })
        o.log?.(`worker ${kind} ${claims.run}/${claims.node}/${claims.seq} ${res.status} refused`)
        return res
      }
      const bad = (status: number, why: string) => {
        const text = `${JSON.stringify({ refused: why })}\n`
        return refused(reply(status, text), why, text)
      }

      const type = req.headers.get('content-type') ?? ''
      if (!/^application\/json\s*(;.*)?$/i.test(type))
        return bad(400, 'content-type must be application/json')
      if (Buffer.byteLength(raw) > MAX_BODY) return bad(400, 'body over 128 KiB')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return bad(400, 'body is not JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return bad(400, 'body must be an object')
      const b = parsed as Record<string, unknown>
      const cut = Object.fromEntries(
        Object.entries(b).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v]),
      )
      args = JSON.stringify(cut).length <= ARGS_MAX ? cut : { bytes: Buffer.byteLength(raw) }
      for (const [k, v] of Object.entries({ run: claims.run, node: claims.node, seq: claims.seq }))
        if (Object.hasOwn(b, k) && b[k] !== v)
          return bad(403, `the token is for run ${claims.run} node ${claims.node} seq ${claims.seq}`)
      const why = workerBody(kind, b)
      if (why) return bad(400, why)

      let at: { node: string; seq: unknown } | undefined
      try {
        const st = JSON.parse(readFileSync(join(o.home, 'runs', claims.run, 'state.json'), 'utf8'))
        at = { node: where(st.snapshot.value)[0], seq: st.snapshot.context.seq }
      } catch {}
      if (!at) return bad(409, 'no such run')
      if (at.node !== claims.node || at.seq !== claims.seq)
        return bad(
          409,
          `stale: the run is at ${at.node} seq ${at.seq}; this token is for ${claims.node} seq ${claims.seq}`,
        )

      try {
        put({ ...base, args, status: 'pending', reason: null, http: 0, body: '' })
      } catch {
        return no(503, 'the worker call store cannot be written')
      }
      let res: Response
      let status: 'applied' | 'refused' = 'refused'
      let why2: string | null = null
      try {
        let r: RunResult = { code: 0, out: '', err: '' }
        if (kind !== 'progress') {
          const env = {
            ...personEnv(process.env, o.home),
            FACTORY_FROM: claims.node,
            FACTORY_RUN: claims.run,
          }
          r =
            kind === 'report'
              ? await o.run(
                  ['report', claims.run, String(claims.seq), b.outcome as string],
                  b.summary as string,
                  env,
                )
              : await o.run(['mail', claims.run, b.to as string], b.text as string, env)
        }
        if (r.timedOut) {
          why2 = 'the command timed out; it can have applied'
          res = refuse(504, why2)
        } else if (r.code === 0) {
          status = 'applied'
          res = reply(
            200,
            `${JSON.stringify(kind === 'progress' ? { ok: true } : { ok: true, out: r.out.trim().slice(0, 2000) })}\n`,
          )
        } else {
          why2 = r.err.trim().slice(0, 500)
          res = refuse(409, why2)
        }
      } catch {
        why2 = 'internal error'
        res = refuse(500, why2)
      }
      try {
        put({ ...base, args, status, reason: why2, http: res.status, body: await res.clone().text() })
      } catch {
        return refuse(500, 'the call ran but its row was not saved; do not retry with a new key')
      }
      o.log?.(`worker ${kind} ${claims.run}/${claims.node}/${claims.seq} ${res.status} ${status}`)
      return res
    }
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next.catch(() => refuse(500, 'internal error'))
  }
}

/**
 * Read the worker token key. A read that fails throws its path; a key under 32 bytes throws too. The error never holds the key.
 */
export function workerKey(path: string): Buffer {
  let k: Buffer
  try {
    k = readFileSync(path)
  } catch {
    throw new Error(`cannot read ${path}`)
  }
  if (k.length < 32) throw new Error(`worker key in ${path} must be at least 32 bytes`)
  return k
}

const HEAD_MAX = 16 * 1024
const BODY_MAX = 256 * 1024
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const HEADER = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):[ \t]*([^\r\n\0]*?)[ \t]*$/

/**
 * Read one HTTP/1.1 request from a TLS socket. Write one response, then close.
 * The parser refuses transfer encoding and repeated headers, except Accept.
 * The optional policy checks the raw target and sets the body limit and read deadline.
 * With that policy, the handler receives the raw method as its third argument.
 */
export function serveSocket(
  sock: Socket,
  handle: (req: Request, ip: string, method?: string) => Promise<Response>,
  idleMs: number,
  policy?: {
    bodyMax: number
    validTarget: (target: string) => boolean
    onInvalid?: (status: 400 | 503) => void
  },
) {
  const reply = (status: number, body: string, type = 'application/json', extra = '') => {
    sock.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Status'}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n${extra}\r\n${body}`,
    )
  }
  const bad = (status: number, why: string) => {
    done = true
    if (deadline) clearTimeout(deadline)
    if (policy) {
      const code = status < 500 ? 400 : 503
      policy.onInvalid?.(code)
      reply(code, JSON.stringify({ error: code === 400 ? 'invalid_request' : 'unavailable' }))
    } else reply(status, `${JSON.stringify({ refused: why })}\n`)
  }
  const deadline = policy ? setTimeout(() => sock.destroy(), idleMs) : undefined
  sock.once('close', () => {
    if (deadline) clearTimeout(deadline)
  })
  // the idle limit covers the read of the request only: a CLI call can run to its own 60 s limit and answer 504
  sock.setTimeout(idleMs, () => sock.destroy())
  sock.on('error', () => sock.destroy())
  let buf = Buffer.alloc(0)
  let head: { method: string; target: string; headers: Headers; length: number; end: number } | undefined
  let done = false
  const finish = async () => {
    done = true
    if (deadline) clearTimeout(deadline)
    sock.setTimeout(0)
    try {
      const body = buf.subarray(head!.end, head!.end + head!.length)
      const ip = sock.remoteAddress ?? ''
      const gone = new AbortController()
      sock.once('close', () => gone.abort())
      const req = new Request(`https://client.invalid${head!.target}`, {
        signal: gone.signal,
        method: policy && /^(CONNECT|TRACE|TRACK)$/.test(head!.method) ? 'POST' : head!.method,
        headers: head!.headers,
        ...(head!.method !== 'GET' && head!.method !== 'HEAD' && { body }),
      })
      const res = policy ? await handle(req, ip, head!.method) : await handle(req, ip)
      if (res.headers.get('content-type')?.startsWith('text/event-stream') && res.body) {
        // close-delimited stream: no content-length, and the socket drain paces the reader
        // wait for drain or close when a write returns false; remove both paired listeners
        const flushed = (ok: boolean) =>
          ok || sock.destroyed
            ? undefined
            : new Promise<void>(r => {
                const go = () => {
                  sock.off('drain', go)
                  sock.off('close', go)
                  r()
                }
                sock.on('drain', go)
                sock.on('close', go)
              })
        const rd = res.body.getReader()
        sock.on('close', () => void rd.cancel().catch(() => {}))
        try {
          await flushed(
            sock.write(
              `HTTP/1.1 200 OK\r\ncontent-type: ${res.headers.get('content-type')}\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n`,
            ),
          )
          for (;;) {
            const { value, done } = await rd.read()
            if (done || sock.destroyed) break
            await flushed(sock.write(value))
          }
        } finally {
          sock.end()
        }
        return
      }
      const out = Buffer.from(await res.arrayBuffer())
      sock.write(
        `HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? 'Status'}\r\ncontent-type: ${res.headers.get('content-type') ?? 'text/plain'}\r\ncontent-length: ${out.length}\r\nconnection: close\r\n\r\n`,
      )
      sock.end(out)
    } catch {
      if (!sock.destroyed) bad(500, 'internal error')
    }
  }
  sock.on('data', (chunk: Buffer) => {
    if (done) return
    let tail: Buffer | undefined
    if (policy && !head) {
      const prefix = Buffer.concat([buf, chunk.subarray(0, HEAD_MAX + 4 - buf.length)])
      const at = prefix.indexOf('\r\n\r\n')
      if (at < 0) {
        buf = prefix
        return buf.length > HEAD_MAX ? bad(400, 'request head too large') : undefined
      }
      tail = chunk.subarray(at + 4 - buf.length)
      buf = prefix.subarray(0, at + 4)
    } else {
      if (policy && head && buf.length + chunk.length > head.end + head.length)
        return bad(400, 'unexpected data')
      buf = Buffer.concat([buf, chunk])
    }
    if (!head) {
      const at = buf.indexOf('\r\n\r\n')
      if (at < 0) return buf.length > HEAD_MAX ? bad(431, 'request head too large') : undefined
      if (at > HEAD_MAX) return bad(431, 'request head too large')
      const [line, ...rest] = buf.subarray(0, at).toString('latin1').split('\r\n')
      const m = /^([A-Z]{1,16}) (\/\S{0,4000}) HTTP\/1\.1$/.exec(line ?? '')
      if (!m) return bad(400, 'bad request line')
      if (policy && !policy.validTarget(m[2]!)) return bad(400, 'bad target')
      const headers = new Headers()
      const seen = new Set<string>()
      for (const l of rest) {
        const h = HEADER.exec(l)
        if (!h || !TOKEN.test(h[1]!)) return bad(400, 'bad header')
        const name = h[1]!.toLowerCase()
        // a repeated header could mean two things to two parsers
        if (seen.has(name) && name !== 'accept') return bad(400, 'repeated header')
        seen.add(name)
        headers.append(name, h[2]!)
      }
      if (seen.has('transfer-encoding') || seen.has('expect') || seen.has('upgrade'))
        return bad(400, 'chunked bodies, Expect and Upgrade are not served')
      const cl = headers.get('content-length')
      if (cl !== null && !/^\d{1,9}$/.test(cl)) return bad(400, 'bad content-length')
      const length = cl === null ? 0 : Number(cl)
      if (length > (policy?.bodyMax ?? BODY_MAX)) return bad(400, 'body too large')
      if (policy && (m[1] === 'GET' || m[1] === 'HEAD') && length !== 0) return bad(400, 'unexpected body')
      head = { method: m[1]!, target: m[2]!, headers, length, end: at + 4 }
    }
    if (tail) {
      if (tail.length > head.length) return bad(400, 'unexpected data')
      buf = Buffer.concat([buf, tail])
    }
    if (buf.length >= head.end + head.length) void finish()
  })
}

/**
 * The mTLS listener of the client API. It checks the client certificate itself with node:tls, before it reads a byte of the request.
 * Bun.serve with rejectUnauthorized did not gate the handler in Bun 1.3.13: it ran for a certificate from another CA
 * in 4 to 8 percent of the tries that sent the request at once (claude-factory-akiq.7).
 * An authorized client has a certificate that the person CA signed for client use. The server certificate has serverAuth only, so Node refuses it.
 * ponytail: one request for each connection and no keep-alive. Upgrade path: Bun.serve, when its client-certificate check gates the handler.
 */
export function clientListener(o: {
  port: number
  cert: string
  key: string
  ca: string
  handle: (req: Request, ip: string) => Promise<Response>
  idleMs?: number
}) {
  return listen({
    port: o.port,
    label: 'client',
    tls: {
      cert: o.cert,
      key: o.key,
      ca: [o.ca],
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
    authorize: s => s.authorized,
    handle: o.handle,
    idleMs: o.idleMs ?? 30_000,
  })
}

/**
 * The TLS listener of the worker API. A worker has no client certificate: its Bearer token is the identity, and the handler checks it.
 * It serves the same one-request sockets as clientListener.
 */
export function workerListener(o: {
  port: number
  cert: string
  key: string
  handle: (req: Request, ip: string) => Promise<Response>
  idleMs?: number
}) {
  return listen({
    port: o.port,
    label: 'worker',
    tls: { cert: o.cert, key: o.key, minVersion: 'TLSv1.2' },
    authorize: () => true,
    handle: o.handle,
    idleMs: o.idleMs ?? 30_000,
  })
}

function listen(o: {
  port: number
  label: 'client' | 'worker'
  tls: TlsOptions
  authorize: (s: TLSSocket) => boolean
  handle: (req: Request, ip: string) => Promise<Response>
  idleMs: number
}) {
  const open = new Set<Socket>()
  const srv = createTlsServer(o.tls, sock => {
    if (!o.authorize(sock)) return sock.destroy()
    open.add(sock)
    sock.on('close', () => open.delete(sock))
    serveSocket(sock, o.handle, o.idleMs)
  })
  srv.on('tlsClientError', () => {})
  srv.on('error', () => {})
  srv.listen(o.port)
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error(`cannot listen on ${o.label} port ${o.port}`)
  return {
    port: addr.port,
    stop() {
      for (const s of open) s.destroy()
      srv.close()
    },
  }
}
