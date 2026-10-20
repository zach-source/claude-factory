// The policy broker: a small in-cluster HTTP server that creates and deletes worker egress policies and reads
// the egress gateway's CA for the AX manager. The manager's VM cannot reach ate-api (TLS to a Substrate pod-cert
// CA), so it asks this broker, which holds a Kubernetes ServiceAccount token that ate-api accepts.
// See docs/remote-runner.md, Policy broker.

import { keyHosts } from './ax-hosts'
import { CONTROLLER_UNKNOWN, controllerReadiness } from './ax-ready'

export const MAX_BODY = 64 * 1024
const EGRESS_CA = 'egress-mitm.ate.dev:mitm:primary-bundle'
/** an RFC 1123 label, as an atespace or an actor name */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export type Run = (argv: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>
export type Config = {
  atespaces: string[]
  /** the manager's actor: its policy is made from the laptop, and the broker never changes it */
  manager: string
  run: Run
  /** the `kubectl ate` prefix, with the token file and, when set, the endpoint */
  ate: string[]
  kubectl: string
  /** the agent-vault vault a policy may name; unset, no policy may carry a credential */
  vault?: string
  /** the hosts each vault key may go to (ax-hosts.ts) */
  keys: Record<string, string[]>
  /** this broker's own service hosts, which no worker policy may name */
  hosts: string[]
}

async function spawn(argv: string[], stdin?: string) {
  const p = Bun.spawn(argv, {
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => p.kill(), 30_000)
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  clearTimeout(timer)
  return { code, out, err }
}

export const configFrom = (env: Record<string, string | undefined>, run: Run = spawn): Config => {
  const kubectl = env.FACTORY_KUBECTL ?? 'kubectl'
  return {
    atespaces: (env.FACTORY_BROKER_ATESPACES ?? 'factory').split(',').filter(Boolean),
    manager: env.FACTORY_AX_MANAGER ?? 'f-manager',
    vault: env.FACTORY_AX_VAULT,
    keys: keyHosts(env.FACTORY_AX_GITHUB_KEYS, env.FACTORY_BROKER_KEY_HOSTS),
    hosts: (env.FACTORY_BROKER_HOSTS ?? 'factory-policy-broker.factory-broker.svc')
      .split(',')
      .filter(Boolean),
    run,
    kubectl,
    ate: [
      kubectl,
      'ate',
      ...(env.FACTORY_BROKER_ENDPOINT ? ['--endpoint', env.FACTORY_BROKER_ENDPOINT] : []),
      '--token-file',
      env.FACTORY_BROKER_TOKEN_FILE ?? '/var/run/secrets/ate-api/token',
    ],
  }
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } })

/** what a request asks for, or the refusal: `PUT|DELETE /policy/<atespace>/<actor>`, `GET /ca`, `GET /ax-ready`, `GET /healthz` */
export function route(method: string, path: string, c: Pick<Config, 'atespaces' | 'manager'>) {
  if (method === 'GET' && path === '/healthz') return { op: 'health' as const }
  if (method === 'GET' && path === '/ca') return { op: 'ca' as const }
  if (method === 'GET' && path === '/ax-ready') return { op: 'ready' as const }
  const m = /^\/policy\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m || (method !== 'PUT' && method !== 'DELETE')) return { status: 404, error: 'not found' }
  const [atespace, actor] = [m[1]!, m[2]!]
  if (!LABEL.test(atespace) || !LABEL.test(actor)) return { status: 400, error: 'not an RFC 1123 label' }
  if (!c.atespaces.includes(atespace)) return { status: 403, error: `atespace ${atespace} is not served` }
  if (actor === c.manager) return { status: 403, error: 'the manager policy is not changed here' }
  return { op: method === 'PUT' ? ('put' as const) : ('delete' as const), atespace, actor }
}

/** the body, or null when it is larger than MAX_BODY */
async function body(req: Request) {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return null
  const raw = await req.text()
  return raw.length > MAX_BODY ? null : raw
}

/** every value of `field` anywhere in `v`, however deep */
function collect(v: unknown, field: string): unknown[] {
  if (!v || typeof v !== 'object') return []
  return Object.entries(v).flatMap(([k, x]) => (k === field ? [x] : []).concat(collect(x, field)))
}

const URI = /^ate-secret:\/\/agent-vault\/([^/]+)\/([A-Z][A-Z0-9_]*)$/

/** does the hostname name this broker (its service name, or a wildcard that would cover it)? */
const isBroker = (h: string, own: string[]) =>
  h.includes('*') ||
  own.some(o => h.toLowerCase().replace(/\.$/, '') === o || h.split('.')[0] === o.split('.')[0])

/**
 * why a rule is refused, or null. A rule may not name the broker. Every `credentialUri` in it, wherever it sits,
 * must be the factory vault's and a key whose hosts include all of the rule's hostnames: what egressPolicy builds.
 * ponytail: no shared bearer token; the NetworkPolicy (deploy/broker.yaml) and this check cover the caller
 */
export function ruleRefusal(rule: unknown, c: Pick<Config, 'vault' | 'keys' | 'hosts'>): string | null {
  const names = collect(rule, 'hostnames').flat()
  if (names.some(h => typeof h !== 'string')) return 'hostnames are strings'
  if ((names as string[]).some(h => isBroker(h, c.hosts))) return 'a rule names the broker'
  for (const uri of collect(rule, 'credentialUri')) {
    const m = typeof uri === 'string' ? URI.exec(uri) : null
    if (!m || !c.vault || m[1] !== c.vault) return 'a credential is not from the factory vault'
    const allowed = c.keys[m[2]!]
    if (!allowed) return `credential key ${m[2]} is not known`
    const bad = (names as string[]).find(h => !allowed.includes(h))
    if (bad) return `credential key ${m[2]} does not go to ${bad}`
  }
  return null
}

/** the policy as text, or why it is refused: it must be a JSON object with a rules array, and each rule must pass */
function policyText(raw: string, c: Config): { policy: string } | { error: string } {
  const bad = { error: 'body is not an EgressPolicy (a JSON object with rules)' }
  try {
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object' || !Array.isArray(p.rules)) return bad
    const error = p.rules.map((r: unknown) => ruleRefusal(r, c)).find(Boolean)
    return error ? { error } : { policy: JSON.stringify(p) }
  } catch {
    return bad
  }
}

export async function handle(req: Request, c: Config): Promise<Response> {
  const r = route(req.method, new URL(req.url).pathname, c)
  if ('error' in r) return text(r.status ?? 500, r.error + '\n')
  if (r.op === 'health') return text(200, 'ok\n')
  if (r.op === 'ca') {
    const p = await c.run([
      c.kubectl,
      'get',
      'clustertrustbundle',
      EGRESS_CA,
      '-o',
      'jsonpath={.spec.trustBundle}',
    ])
    return p.code === 0 && p.out.trim()
      ? text(200, p.out.trim() + '\n')
      : text(502, `ca: ${p.err.trim() || 'empty'}\n`)
  }
  if (r.op === 'ready') {
    // no --request-timeout: in a pod, any client flag makes kubectl skip the in-cluster config and call
    // localhost:8080, which is this broker. run() stops the call after 30 s
    const p = await c.run([c.kubectl, 'get', 'deployment', 'ax-controller', '-n', 'ax-system', '-o', 'json'])
    const why = p.code === 0 ? controllerReadiness(p.out) : CONTROLLER_UNKNOWN
    return why ? text(503, why + '\n') : text(200, 'ready\n')
  }
  const target = [r.actor, '-a', r.atespace]
  if (r.op === 'delete') {
    const p = await c.run([...c.ate, 'delete', 'egress-policy', ...target])
    // a policy that is gone already is fine
    return p.code === 0 || /not ?found/i.test(p.err)
      ? text(200, 'deleted\n')
      : text(502, `delete: ${p.err.trim()}\n`)
  }
  const raw = await body(req)
  if (raw === null) return text(413, 'body too large\n')
  const checked = policyText(raw, c)
  if ('error' in checked) return text(400, checked.error + '\n')
  const policy = checked.policy
  // ponytail: delete then create, so a repeat is not an error; the actor has no policy for a moment between them.
  // Replacing in place (update egress-policy) needs the stored version; not worth it for one writer
  await c.run([...c.ate, 'delete', 'egress-policy', ...target])
  const p = await c.run([...c.ate, 'create', 'egress-policy', ...target, '-f', '-'], policy)
  return p.code === 0 ? text(200, 'created\n') : text(502, `create: ${p.err.trim()}\n`)
}

export function serve(port: number, c: Config = configFrom(process.env)) {
  return Bun.serve({
    port,
    idleTimeout: 60,
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      const res = await handle(req, c).catch(e => text(500, `${e}\n`))
      console.log(`${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname} ${res.status}`)
      return res
    },
  })
}

/** `factory broker serve [--port 8080]` */
export function main(args: string[]) {
  if (args[0] !== 'serve') throw new Error('usage: factory broker serve [--port 8080]')
  const i = args.indexOf('--port')
  const port = Number(i >= 0 ? args[i + 1] : 8080)
  if (!Number.isInteger(port) || port <= 0) throw new Error('--port takes a port number')
  const s = serve(port)
  console.log(`policy broker on :${s.port}`)
}

if (import.meta.main) main(process.argv.slice(2))
