// CLI client mode (claude-factory-akiq.6, spec 004-factory-server FR-016, FR-018).
// With FACTORY_SERVER set, a closed table of CLI forms calls the client API (contracts/client-api.md).
// Without it, nothing here runs. It must not import cli.ts: that file runs code at import.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { argsInput as gcInput } from './core/ops/gc'
import { refuseWorker } from './core/caller'

type Env = Record<string, string | undefined>
export type Req = { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }
export type Io = { out: (s: string) => void; err: (s: string) => void }

const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** commands that stay on this machine in server mode */
const LOCAL = new Set(['help', '--help', '-h', 'check', 'mutate', 'ci', 'pg-scratch', 'devenv', 'parity'])
const PATROL_REFUSED = new Set(['tick', 'stop', 'resume', 'decide', 'start'])
/** with FACTORY_FROM set (the manager), local mode refuses all but mail and reads */
const FROM_ALLOWED = new Set(['mail', 'show', 'status', 'prs', 'backlog', 'decisions', 'plan', 'metrics'])

/** a worker keeps the local path (FR-018); FACTORY_FROM=manager is the manager, not a worker */
export function isWorker(env: Env): boolean {
  return !!(
    (env.FACTORY_FROM && env.FACTORY_FROM !== 'manager') ||
    env.FACTORY_RUN ||
    env.FACTORY_DEF_NAME ||
    env.BEADS_ACTOR?.startsWith('factory/')
  )
}

/** true when this process must send the command to the server */
export function serverMode(env: Env): boolean {
  return !!env.FACTORY_SERVER && !isWorker(env)
}

/** the server origin, or why FACTORY_SERVER is refused: https, or http on a loopback host only */
export function serverUrl(env: Env): { url: URL } | { error: string } | null {
  const raw = env.FACTORY_SERVER
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: 'FACTORY_SERVER is not a URL' }
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    return { error: 'FACTORY_SERVER must be https, or http on 127.0.0.1, localhost or [::1]' }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    return { error: 'FACTORY_SERVER must be an origin only: no user, path, query or hash' }
  return { url }
}

/** the request for one CLI form, `{local: true}` for a command that stays local, or the refusal text */
export function route(cmd: string | undefined, args: string[]): Req | { local: true } | string {
  if (!cmd || LOCAL.has(cmd)) return { local: true }
  const no = `factory ${cmd} has no server mode: unset FACTORY_SERVER to run it on the local home`
  const bad = `usage: factory ${cmd} ...: the server mode form is not valid (see specs/004-factory-server/contracts/client-api.md)`
  const seg = (...s: (string | undefined)[]) => s.every(x => x !== undefined && SEG.test(x))
  const [a, b, c] = args
  const n = args.length
  switch (cmd) {
    case 'gc':
      try {
        return { method: 'POST', path: '/v1/gc', body: gcInput(args) }
      } catch (e) {
        return (e as Error).message
      }
    case 'tick':
      if (n === 2 && a === '--board' && b === '--slim') return { method: 'GET', path: '/v1/board?slim=1' }
      return n === 0 ? { method: 'GET', path: '/v1/board' } : bad
    case 'snapshot':
      return n === 2 && a === '--views' && /^[a-z]+(,[a-z]+)*$/.test(b!)
        ? { method: 'GET', path: `/v1/snapshot?views=${b}` }
        : bad
    case 'show':
      return n === 1 && seg(a) ? { method: 'GET', path: `/v1/runs/${a}` } : bad
    case 'status':
      if (n === 0) return { method: 'GET', path: '/v1/status' }
      return n === 1 && seg(a) ? { method: 'GET', path: `/v1/status?run=${a}` } : bad
    case 'prs':
    case 'backlog':
      return n === 0 ? { method: 'GET', path: `/v1/${cmd}` } : bad
    case 'plan':
      return n === 0 || (n === 1 && a === 'show') ? { method: 'GET', path: '/v1/plan' } : bad
    case 'metrics': {
      const q = new URLSearchParams()
      for (let i = 0; i < n; i++) {
        const f = args[i]!
        if (f === '--json') q.set('json', '1')
        else if (f === '--tokens') q.set('tokens', '1')
        else if ((f === '--rig' || f === '--since') && seg(args[i + 1])) q.set(f.slice(2), args[++i]!)
        else return bad
      }
      return { method: 'GET', path: `/v1/metrics${q.size ? `?${q}` : ''}` }
    }
    case 'decisions':
      if (n === 0 || (n === 1 && a === 'list')) return { method: 'GET', path: '/v1/decisions' }
      if (a === 'answer' && seg(b, c) && n >= 4)
        return {
          method: 'POST',
          path: `/v1/decisions/${b}/${c}/answer`,
          body: { text: args.slice(3).join(' ') },
        }
      return bad
    case 'decide':
      return n >= 2 && seg(a)
        ? {
            method: 'POST',
            path: `/v1/runs/${a}/decide`,
            body: { outcome: b, note: args.slice(2).join(' ') },
          }
        : bad
    case 'mail': {
      // cli.ts expands --text-file before this call
      const wake = args[2] === '--wake'
      const text = args.slice(wake || args[2] === '--' ? 3 : 2).join(' ')
      return n >= 3 && seg(a, b) && text
        ? {
            method: 'POST',
            path: `/v1/runs/${a}/mail`,
            body: { to: b, text, from: 'manager', cwd: process.cwd(), ...(wake && { wake: true }) },
          }
        : bad
    }
    case 'goto':
      return n === 2 && seg(a, b) ? { method: 'POST', path: `/v1/runs/${a}/goto`, body: { node: b } } : bad
    case 'abort':
      return n === 1 && seg(a) ? { method: 'POST', path: `/v1/runs/${a}/abort`, body: {} } : bad
    case 'stop':
    case 'resume':
      return n === 0 ? { method: 'POST', path: '/v1/halt', body: { mode: cmd } } : bad
    case 'start': {
      const [target, rig, ...rest] = args
      const [factory, station, extra] = (target ?? '').split('@')
      const goal = rest.filter(w => w !== '--owned').join(' ')
      if (extra !== undefined || !seg(factory, rig) || (station !== undefined && !seg(station)) || !goal)
        return bad
      return {
        method: 'POST',
        path: '/v1/start',
        body: {
          factory,
          ...(station && { station }),
          rig,
          goal,
          ...(rest.includes('--owned') && { owned: true }),
        },
      }
    }
    default:
      return no
  }
}

/** the person certificate for https; the error names a missing path and never a file's text */
export function tlsFor(url: URL, home: string): { cert: string; key: string; ca: string } | undefined {
  if (url.protocol !== 'https:') return undefined
  const dir = join(home, '.config', 'factory')
  const read = (f: string) => {
    const p = join(dir, f)
    if (!existsSync(p)) throw new Error(`the person certificate file ${p} is missing`)
    return readFileSync(p, 'utf8')
  }
  return { cert: read('person.crt'), key: read('person.key'), ca: read('ca.crt') }
}

const stdio: Io = { out: s => process.stdout.write(s), err: s => process.stderr.write(`${s}\n`) }

/** run one CLI call against the server; null when the command stays local, else the exit code */
export async function main(
  cmd: string | undefined,
  args: string[],
  env: Env,
  fetchFn: typeof fetch = fetch,
  io: Io = stdio,
): Promise<number | null> {
  if (!env.FACTORY_SERVER) return null
  const refuse = (s: string) => (io.err(s), 1)
  if (cmd === 'gc') {
    try {
      refuseWorker(env, 'gc', true)
    } catch (e) {
      return refuse((e as Error).message)
    }
  }
  const req = route(cmd, args)
  if (typeof req !== 'string' && 'local' in req) return null
  const found = serverUrl(env)
  if (!found) return null
  if ('error' in found) return refuse(found.error)
  if (typeof req === 'string') return refuse(req)
  const answer = cmd === 'decisions' && args[0] === 'answer'
  if (env.FACTORY_PATROL && (PATROL_REFUSED.has(cmd!) || answer))
    return refuse(`a patrol cannot run factory ${cmd}: leave it for the person or the manager`)
  if (env.FACTORY_FROM && (!FROM_ALLOWED.has(cmd!) || answer))
    return refuse(`a worker cannot run factory ${cmd} (FACTORY_FROM is set): mail the manager instead`)
  let tls
  try {
    tls = tlsFor(found.url, env.HOME ?? homedir())
  } catch (e) {
    return refuse((e as Error).message)
  }
  const origin = found.url.origin
  let res: Response
  let text: string
  try {
    res = await fetchFn(origin + req.path, {
      method: req.method,
      headers:
        req.method === 'POST' ? { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() } : {},
      ...(req.body && { body: JSON.stringify(req.body) }),
      ...(tls && { tls }),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    } as RequestInit)
    text = await res.text()
  } catch (e) {
    return refuse(
      `factory server ${origin} unreachable: ${(e as Error).message}; unset FACTORY_SERVER to work on the local home`,
    )
  }
  if (!res.ok) return refuse(`factory server: ${res.status} ${text.slice(0, 500)}`)
  if (cmd === 'gc') {
    let result: { code?: unknown; out?: unknown; err?: unknown } | null
    try {
      result = JSON.parse(text)
    } catch {
      return refuse('factory server: invalid gc result')
    }
    if (!result || result.code !== 0 || typeof result.out !== 'string' || typeof result.err !== 'string')
      return refuse('factory server: invalid gc result')
    io.out(result.out)
    if (result.err) io.err(result.err.replace(/\n$/, ''))
    return 0
  }
  io.out(text.endsWith('\n') ? text : `${text}\n`)
  return 0
}
