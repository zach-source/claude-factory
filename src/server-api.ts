// Client API of `factory server` on port 8444 (claude-factory-akiq.7). Contract: specs/004-factory-server/contracts/client-api.md.
import { createHash } from 'node:crypto'
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
import { join, resolve, sep } from 'node:path'

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

export type RunResult = { code: number; out: string; err: string; timedOut?: boolean }
/** run one CLI form; `text` is mail text that the runner passes by file */
export type Runner = (argv: string[], text?: string) => Promise<RunResult>
export type ClientOpts = {
  home: string
  run: Runner
  /** the last tick result, null before the first tick */
  board: () => unknown
  log?: (line: string) => void
}

const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const KEY = /^[A-Za-z0-9-]{8,128}$/
const MAX_BODY = 128 * 1024
const MAX_TEXT = 65536
const DAY = 24 * 3600_000

type Field = 'seg' | 'text' | 'note' | 'abs' | 'manager' | 'true' | 'stop|resume'
type Body = Record<string, string | boolean>
type Route = {
  method: 'GET' | 'POST'
  path: string // ':' matches one SEG
  query?: Record<string, 'seg' | '1'>
  body?: Record<string, Field>
  optional?: string[]
  /** argv for the CLI; mail text goes separately */
  argv: (p: string[], q: URLSearchParams, b: Body) => string[]
}

/** the closed route table of contracts/client-api.md: 8 GET forms and 7 POST forms */
const ROUTES: Route[] = [
  { method: 'GET', path: '/v1/runs/:', argv: p => ['show', p[0]!] },
  {
    method: 'GET',
    path: '/v1/status',
    query: { run: 'seg' },
    argv: (_, q) => (q.has('run') ? ['status', q.get('run')!] : ['status']),
  },
  { method: 'GET', path: '/v1/prs', argv: () => ['prs'] },
  { method: 'GET', path: '/v1/backlog', argv: () => ['backlog'] },
  { method: 'GET', path: '/v1/decisions', argv: () => ['decisions', 'list'] },
  { method: 'GET', path: '/v1/plan', argv: () => ['plan', 'show'] },
  {
    method: 'GET',
    path: '/v1/metrics',
    query: { rig: 'seg', since: 'seg', json: '1', tokens: '1' },
    argv: (_, q) => [
      'metrics',
      ...(q.has('rig') ? ['--rig', q.get('rig')!] : []),
      ...(q.has('since') ? ['--since', q.get('since')!] : []),
      ...(q.has('json') ? ['--json'] : []),
      ...(q.has('tokens') ? ['--tokens'] : []),
    ],
  },
  {
    method: 'POST',
    path: '/v1/runs/:/decide',
    body: { outcome: 'seg', note: 'note' },
    argv: (p, _, b) => ['decide', p[0]!, b.outcome as string, ...(b.note ? [b.note as string] : [])],
  },
  {
    method: 'POST',
    path: '/v1/runs/:/mail',
    body: { to: 'seg', text: 'text', from: 'manager', cwd: 'abs', wake: 'true' },
    optional: ['wake'],
    argv: (p, _, b) => ['mail', p[0]!, b.to as string, ...(b.wake ? ['--wake'] : [])],
  },
  {
    method: 'POST',
    path: '/v1/runs/:/goto',
    body: { node: 'seg' },
    argv: (p, _, b) => ['goto', p[0]!, b.node as string],
  },
  { method: 'POST', path: '/v1/runs/:/abort', body: {}, argv: p => ['abort', p[0]!] },
  {
    method: 'POST',
    path: '/v1/start',
    body: { factory: 'seg', station: 'seg', rig: 'seg', goal: 'text', owned: 'true' },
    optional: ['station', 'owned'],
    argv: (_, __, b) => [
      'start',
      b.station ? `${b.factory}@${b.station}` : (b.factory as string),
      b.rig as string,
      b.goal as string,
      ...(b.owned ? ['--owned'] : []),
    ],
  },
  { method: 'POST', path: '/v1/halt', body: { mode: 'stop|resume' }, argv: (_, __, b) => [b.mode as string] },
  {
    method: 'POST',
    path: '/v1/decisions/:/:/answer',
    body: { text: 'text' },
    argv: (p, _, b) => ['decisions', 'answer', p[0]!, p[1]!, b.text as string],
  },
]

const reply = (status: number, body: string, json = true) =>
  new Response(body, { status, headers: { 'content-type': json ? 'application/json' : 'text/plain' } })
const refuse = (status: number, why: string) => reply(status, `${JSON.stringify({ refused: why })}\n`)
const looksJson = (s: string) => /^\s*[{[]/.test(s)

function fieldOk(kind: Field, v: unknown): boolean {
  switch (kind) {
    case 'seg':
      return typeof v === 'string' && SEG.test(v)
    case 'text':
    case 'note':
      return (
        typeof v === 'string' &&
        v.length <= MAX_TEXT &&
        (kind === 'note' || v.length >= 1) &&
        !v.includes('\u0000')
      )
    case 'abs':
      return typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !v.includes('\u0000')
    case 'manager':
      return v === 'manager'
    case 'true':
      return v === true
    case 'stop|resume':
      return v === 'stop' || v === 'resume'
  }
}

/** match a request path to a route; the segments are not checked yet */
function match(method: string, path: string): { route: Route; params: string[] } | undefined {
  const parts = path.split('/')
  for (const route of ROUTES) {
    const want = route.path.split('/')
    if (route.method !== method || want.length !== parts.length) continue
    if (want.every((w, i) => w === ':' || w === parts[i]))
      return { route, params: parts.filter((_, i) => want[i] === ':') }
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
  const answer = async (r: RunResult) =>
    r.timedOut
      ? refuse(504, 'the command timed out')
      : r.code === 0
        ? reply(200, r.out, looksJson(r.out))
        : refuse(422, r.err.slice(0, 500))

  return async (req: Request, ip: string): Promise<Response> => {
    // A worker token must not open this port, whatever the value or the route (FR-010).
    if (req.headers.has('authorization'))
      return refuse(403, 'worker tokens are not accepted on the client port')
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/v1/board') {
      if (url.search) return refuse(400, 'bad query')
      const b = o.board()
      return b === null || b === undefined ? refuse(503, 'no tick yet') : reply(200, JSON.stringify(b) + '\n')
    }
    const m = match(req.method, url.pathname)
    if (!m) return refuse(404, 'no such route')
    const { route, params } = m
    if (!params.every(p => SEG.test(p))) return refuse(400, 'bad path segment')
    const q = url.searchParams
    const keys = [...q.keys()]
    const allowed = route.query ?? {}
    if (new Set(keys).size !== keys.length || keys.some(k => !(k in allowed))) return refuse(400, 'bad query')
    for (const k of keys)
      if (allowed[k] === '1' ? q.get(k) !== '1' : !SEG.test(q.get(k)!)) return refuse(400, 'bad query')

    if (route.method === 'GET') {
      const r = await o.run(route.argv(params, q, {}))
      return answer(r)
    }

    const key = req.headers.get('idempotency-key') ?? ''
    if (!KEY.test(key)) return refuse(400, 'Idempotency-Key must match ^[A-Za-z0-9-]{8,128}$')
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
    const spec = route.body ?? {}
    const b = parsed as Record<string, unknown>
    const optional = route.optional ?? []
    if (
      Object.keys(b).some(k => !(k in spec)) ||
      Object.keys(spec).some(k => !optional.includes(k) && !(k in b)) ||
      Object.entries(b).some(([k, v]) => !fieldOk(spec[k]!, v))
    )
      return refuse(400, 'bad body')
    const body = b as Body
    if (url.pathname === '/v1/start' && (body.goal as string).split(/\s+/).includes('--owned'))
      return refuse(400, 'the goal must not hold the word --owned: set owned')
    if (/\/mail$/.test(url.pathname) && insideRunWorktree(o.home, params[0]!, body.cwd as string))
      return refuse(403, 'a worker cannot send mail as the manager from inside the run worktree')

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
          const text = path.endsWith('/mail') ? (body.text as string) : undefined
          res = await answer(await o.run(route.argv(params, q, body), text))
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
      if (path.endsWith('/decide')) line.outcome = body.outcome
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
}
