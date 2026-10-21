// The policy broker: a small in-cluster HTTP server that creates and deletes worker egress policies and reads
// the egress gateway's CA for the AX manager. The manager's VM cannot reach ate-api (TLS to a Substrate pod-cert
// CA), so it asks this broker, which holds a Kubernetes ServiceAccount token that ate-api accepts.
// See docs/remote-runner.md, Policy broker.

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
  /** the token swap command. It is null when CLAUDE_TOKEN_ITEM is unset, and the broker does not serve POST /token/best */
  swap: string[] | null
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
    run,
    kubectl,
    swap: env.CLAUDE_TOKEN_ITEM ? [env.FACTORY_BROKER_TOKEN_CMD ?? 'claude-token', 'best'] : null,
    ate: [
      kubectl,
      'ate',
      ...(env.FACTORY_BROKER_ENDPOINT ? ['--endpoint', env.FACTORY_BROKER_ENDPOINT] : []),
      '--token-file',
      env.FACTORY_BROKER_TOKEN_FILE ?? '/var/run/secrets/ate-api/token',
    ],
  }
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
/** one swap at a time: two runs would race on the same op item */
let swapping = false

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } })

/** what a request asks for, or the refusal: `PUT|DELETE /policy/<atespace>/<actor>`, `GET /ca`, `GET /controller`, `POST /token/best`, `GET /healthz` */
export function route(
  method: string,
  path: string,
  c: Pick<Config, 'atespaces' | 'manager'> & { swap?: string[] | null },
) {
  if (method === 'GET' && path === '/healthz') return { op: 'health' as const }
  if (method === 'GET' && path === '/ca') return { op: 'ca' as const }
  if (method === 'GET' && path === '/controller') return { op: 'controller' as const }
  if (method === 'POST' && path === '/token/best' && c.swap) return { op: 'swap' as const }
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

/** a policy that is not a JSON object with a rules array is not made */
function policyText(raw: string) {
  try {
    const p = JSON.parse(raw)
    return p && typeof p === 'object' && Array.isArray(p.rules) ? JSON.stringify(p) : null
  } catch {
    return null
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
  if (r.op === 'controller') {
    const p = await c.run([
      c.kubectl,
      'get',
      'deployment',
      'ax-controller',
      '-n',
      'ax-system',
      '-o',
      'json',
      '--request-timeout=5s',
    ])
    // only the readiness fields leave the broker, not the Deployment's env or annotations
    try {
      const d = JSON.parse(p.out)
      if (p.code !== 0 || !d) throw new Error()
      return text(
        200,
        JSON.stringify({
          metadata: { generation: d.metadata?.generation, deletionTimestamp: d.metadata?.deletionTimestamp },
          spec: { replicas: d.spec?.replicas },
          status: {
            observedGeneration: d.status?.observedGeneration,
            readyReplicas: d.status?.readyReplicas,
            availableReplicas: d.status?.availableReplicas,
          },
        }) + '\n',
      )
    } catch {
      return text(502, `controller: ${firstLine(p.err) || 'not a Deployment'}\n`)
    }
  }
  if (r.op === 'swap') {
    if (swapping) return text(409, 'a token swap is running\n')
    swapping = true
    try {
      const p = await c.run(c.swap!)
      // the first line only: the script prints "slot N is live", and a token must never leave in a response
      return p.code === 0
        ? text(200, firstLine(p.out) + '\n')
        : text(502, `${firstLine(p.err) || 'token swap failed'}\n`)
    } finally {
      swapping = false
    }
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
  const policy = policyText(raw)
  if (!policy) return text(400, 'body is not an EgressPolicy (a JSON object with rules)\n')
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
