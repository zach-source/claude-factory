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
export type Req = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}
export type Io = { out: (s: string) => void; err: (s: string) => void }

const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** commands that stay on this machine in server mode */
const LOCAL = new Set(['help', '--help', '-h', 'check', 'mutate', 'ci', 'pg-scratch', 'devenv', 'parity'])
const PATROL_REFUSED = new Set(['tick', 'stop', 'resume', 'decide', 'start'])
const RIG_FLAGS: Record<string, string> = {
  '--max': 'max',
  '--sweeps': 'sweeps',
  '--runner': 'runner',
  '--agent': 'agent',
  '--cluster-runs': 'clusterRuns',
  '--auto-queue': 'autoQueue',
  '--skills': 'skills',
  '--otel-content': 'otelContent',
  '--sandbox-class': 'sandboxClass',
}
/** flags that can repeat: the values go in one text, one for each line */
const RIG_LINES: Record<string, string> = {
  '--param': 'param',
  '--push-rule': 'pushRule',
  '--sensitive-path': 'sensitivePath',
}
const GATE_KEY = /^gate:([A-Za-z0-9][A-Za-z0-9._-]{0,127})@(\d+)$/

/** leading flags of a form: `value` flags take one word, `bool` flags none. Undefined if a flag repeats or is unknown. */
function flags(args: string[], value: string[], bool: string[] = []) {
  const v: Record<string, string | true> = {}
  let i = 0
  for (; args[i]?.startsWith('--'); i++) {
    const f = args[i]!
    const isBool = bool.includes(f)
    if ((!isBool && !value.includes(f)) || f in v || (!isBool && args[i + 1] === undefined)) return undefined
    v[f] = isBool ? true : args[++i]!
  }
  return { v, rest: args.slice(i) }
}

/** `rig set <rig> ...`: the settings go in one body. --goal is the rest of the line, as in the CLI. */
function rigSet(args: string[]): Req | undefined {
  const [, rig] = args
  if (!rig || !SEG.test(rig)) return undefined
  const body: Record<string, string> = {}
  for (let i = 2; i < args.length; i++) {
    const f = args[i]!
    const goal = args.slice(i + 1).join(' ')
    if (f === '--goal') {
      if (!goal || 'goal' in body) return undefined
      body.goal = goal
      break
    }
    const value = args[++i]
    if (value === undefined) return undefined
    if (RIG_FLAGS[f] && !(RIG_FLAGS[f]! in body)) body[RIG_FLAGS[f]!] = value
    else if (RIG_LINES[f])
      body[RIG_LINES[f]!] = [body[RIG_LINES[f]!], value].filter(x => x !== undefined).join('\n')
    else return undefined
  }
  return Object.keys(body).length ? { method: 'PATCH', path: `/v1/rigs/${rig}`, body } : undefined
}

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
export function route(
  cmd: string | undefined,
  args: string[],
  resolveMail?: (args: string[]) => string[],
  readFile: (path: string) => string = p => readFileSync(p, 'utf8'),
): Req | { local: true } | string {
  if (!cmd || LOCAL.has(cmd)) return { local: true }
  const no = `factory ${cmd} has no server mode: unset FACTORY_SERVER to run it on the local home`
  const bad = `usage: factory ${cmd} ...: the server mode form is not valid (see specs/004-factory-server/contracts/client-api.md)`
  const seg = (...s: (string | undefined)[]) => s.every(x => x !== undefined && SEG.test(x))
  const [a, b, c] = args
  const n = args.length
  /** a request whose text field is the text of a local file (the CLI forms `plan set <file>` and the like) */
  const fileBody = (
    method: 'PUT',
    path: string,
    field: string,
    file: string,
    rest: Record<string, unknown> = {},
  ): Req | string => {
    try {
      return { method, path, body: { ...rest, [field]: readFile(file) } }
    } catch (e) {
      return `factory ${cmd}: cannot read ${file}: ${(e as Error).message}`
    }
  }
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
      if (!((n === 2 || n === 4) && a === '--views' && /^[a-z]+(\.[a-z]+)?(,[a-z]+(\.[a-z]+)?)*$/.test(b!)))
        return bad
      if (n === 2) return { method: 'GET', path: `/v1/snapshot?views=${b}` }
      return args[2] === '--max-age' && /^\d+$/.test(args[3]!)
        ? { method: 'GET', path: `/v1/snapshot?views=${b}&maxAge=${args[3]}` }
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
      if (n === 1 && a === 'facts') return { method: 'GET', path: '/v1/plan/facts' }
      if (n === 2 && a === 'set') return fileBody('PUT', '/v1/plan', 'answer', b!)
      return n === 0 || (n === 1 && a === 'show') ? { method: 'GET', path: '/v1/plan' } : bad
    case 'gate-brief': {
      if (n === 2 && a === 'facts' && seg(b)) return { method: 'GET', path: `/v1/runs/${b}/brief` }
      const key = GATE_KEY.exec(b ?? '')
      return n === 3 && a === 'set' && key
        ? fileBody('PUT', `/v1/gate-brief/${key[1]}`, 'text', c!, { startedAt: key[2] })
        : bad
    }
    case 'review':
      if (n === 2 && a === 'facts')
        return { method: 'GET', path: `/v1/review?${new URLSearchParams({ key: b! })}` }
      return n === 3 && a === 'set' ? fileBody('PUT', '/v1/review', 'text', c!, { key: b }) : bad
    case 'poke':
      return n >= 1 && seg(a)
        ? { method: 'POST', path: `/v1/runs/${a}/poke`, body: n > 1 ? { text: args.slice(1).join(' ') } : {} }
        : bad
    case 'retry':
      return n === 1 && seg(a) ? { method: 'POST', path: `/v1/runs/${a}/retry`, body: {} } : bad
    case 'fork':
      return n >= 2 && seg(a, b)
        ? {
            method: 'POST',
            path: `/v1/runs/${a}/fork`,
            body: { station: b, ...(n > 2 && { note: args.slice(2).join(' ') }) },
          }
        : bad
    case 'rm':
      return n === 1 && seg(a) ? { method: 'DELETE', path: `/v1/runs/${a}`, body: {} } : bad
    case 'queue':
      return (n === 2 || n === 3) && seg(a, b) && (n === 2 || seg(c))
        ? { method: 'POST', path: '/v1/queue', body: { rig: a, bead: b, ...(c && { station: c }) } }
        : bad
    case 'unhold':
      return (n === 1 || (n === 2 && b === '--codex')) && seg(a)
        ? { method: 'POST', path: `/v1/rigs/${a}/unhold`, body: n === 2 ? { codex: true } : {} }
        : bad
    case 'adopt':
      return (n === 1 || n === 2) && seg(a) && (n === 1 || seg(b))
        ? { method: 'POST', path: '/v1/adopt', body: { rig: a, ...(b && { template: b }) } }
        : bad
    case 'sweep':
      return n === 0 ? { method: 'POST', path: '/v1/sweeps/all', body: {} } : bad
    case 'rig':
      return (a === 'set' && rigSet(args)) || bad
    case 'say':
      return n >= 1 ? { method: 'POST', path: '/v1/manager/say', body: { text: args.join(' ') } } : bad
    case 'manager':
      if (n === 1 && (a === 'show' || a === 'brief' || a === 'context'))
        return { method: 'GET', path: a === 'show' ? '/v1/manager' : `/v1/manager/${a}` }
      if (a === 'image' && n === 2) return { method: 'POST', path: '/v1/manager/image', body: { image: b! } }
      if (a === 'suspend' && (n === 1 || (n === 2 && b === '--resume')))
        return { method: 'POST', path: '/v1/manager/suspend', body: n === 2 ? { resume: true } : {} }
      return a === 'log' && n >= 3 && seg(b)
        ? { method: 'POST', path: `/v1/manager/log/${b}`, body: { entry: args.slice(2).join(' ') } }
        : bad
    case 'memory': {
      if (a === 'search') {
        const p = flags(args.slice(1), ['--rig', '--from'], ['--no-core'])
        if (!p?.rest.length) return bad
        const q = new URLSearchParams({ query: p.rest.join(' ') })
        if (p.v['--rig']) q.set('rig', p.v['--rig'] as string)
        if (p.v['--from']) q.set('from', p.v['--from'] as string)
        if (p.v['--no-core']) q.set('noCore', '1')
        return { method: 'GET', path: `/v1/memory/search?${q}` }
      }
      const p =
        a === 'add'
          ? flags(args.slice(1), ['--kind', '--rig', '--from', '--until', '--supersedes'], ['--anyway'])
          : undefined
      if (!p || !p.v['--kind'] || !p.rest.length) return bad
      const [summary, ...body] = p.rest
      return {
        method: 'POST',
        path: '/v1/memory',
        body: {
          kind: p.v['--kind'],
          summary,
          ...(body.length && { body: body.join(' ') }),
          ...(p.v['--rig'] && { rig: p.v['--rig'] }),
          ...(p.v['--from'] && { from: p.v['--from'] }),
          ...(p.v['--until'] && { until: p.v['--until'] }),
          ...(p.v['--supersedes'] && { supersedes: p.v['--supersedes'] }),
          ...(p.v['--anyway'] && { anyway: true }),
        },
      }
    }
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
      const wake = args[2] === '--wake'
      const at = wake ? 3 : 2
      if (args.slice(at).some(w => w === '--text-file' || w.startsWith('--text-file='))) {
        if (!seg(a, b) || args[at] !== '--text-file' || n !== at + 2 || !resolveMail) return bad
        args = resolveMail(args)
      }
      const text = args.slice(at).join(' ')
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
  resolveMail?: (args: string[]) => string[],
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
  const req = route(cmd, args, resolveMail)
  if (typeof req !== 'string' && 'local' in req) return null
  const found = serverUrl(env)
  if (!found) return null
  if ('error' in found) return refuse(found.error)
  if (typeof req === 'string') return refuse(req)
  const answer = cmd === 'decisions' && args[0] === 'answer'
  // the server refuses by role (op.rights): the manager certificate gets 403 for an owner operation
  if (env.FACTORY_PATROL && (PATROL_REFUSED.has(cmd!) || answer))
    return refuse(`a patrol cannot run factory ${cmd}: leave it for the person or the manager`)
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
        req.method !== 'GET' ? { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() } : {},
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
