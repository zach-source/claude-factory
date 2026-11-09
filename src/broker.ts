// The policy broker: a small in-cluster HTTP server that creates and deletes worker egress policies and reads
// the egress gateway's CA for the AX manager and the factory server pod. The manager's VM cannot reach ate-api (TLS to a Substrate pod-cert
// CA), so it asks this broker, which holds a Kubernetes ServiceAccount token that ate-api accepts.
// See docs/remote-runner.md, Policy broker.

export const MAX_BODY = 64 * 1024
const EGRESS_CA = 'egress-mitm.ate.dev:mitm:primary-bundle'
/** an RFC 1123 label, as an atespace or an actor name */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/** `op` is true only for the token swap: the other children (kubectl) do not inherit OP_SERVICE_ACCOUNT_TOKEN */
export type Run = (
  argv: string[],
  stdin?: string,
  op?: boolean,
) => Promise<{ code: number; out: string; err: string }>
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
  /** vault keys that are not built in, each with the hosts it can go to (FACTORY_BROKER_KEY_HOSTS) */
  keyHosts: Record<string, string[]>
}

async function spawn(argv: string[], stdin?: string, op = false) {
  const { OP_SERVICE_ACCOUNT_TOKEN: _op, ...rest } = process.env
  const p = Bun.spawn(argv, {
    env: op ? process.env : rest,
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

const GITHUB_HOSTS = ['api.github.com', 'uploads.github.com', 'github.com']
const CHATGPT = ['chatgpt.com']
/** the hosts of the vault keys that the factory itself puts in a worker policy (a key that starts with GITHUB has GITHUB_HOSTS) */
const BUILTIN_KEY_HOSTS: Record<string, readonly string[]> = {
  ANTHROPIC: ['api.anthropic.com'],
  XAI_API_KEY: ['api.x.ai'],
  CURSOR_API_KEY: ['api2.cursor.sh'],
  CODEX_CHATGPT: CHATGPT,
  CODEX_CHATGPT_ACCOUNT: CHATGPT,
}
/** a lower-case host name: no wildcard, no port, no trailing dot (src/ax.ts HOST without /i; broker.ts imports nothing) */
const KEY_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * FACTORY_BROKER_KEY_HOSTS: a JSON object of vault key name to its host list, for the keys that are not built in
 * (GITLAB, DOLT_BASIC, a rig's own keys). It comes from the broker Deployment, which the manager VM cannot change.
 * Unset or empty gives {}. A bad value throws, so a broker with a wrong map does not start.
 */
export function keyHostsFrom(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {}
  const bad = (why: string): never => {
    throw new Error(`FACTORY_BROKER_KEY_HOSTS ${why}`)
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return bad('is not JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('is not a JSON object')
  for (const [k, hosts] of Object.entries(v)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || k.startsWith('GITHUB') || Object.hasOwn(BUILTIN_KEY_HOSTS, k))
      bad(
        `names ${JSON.stringify(k)}, which is not a key that can be set (upper case, not GITHUB*, not built in)`,
      )
    if (!Array.isArray(hosts) || !hosts.length || hosts.some(h => typeof h !== 'string' || !KEY_HOST.test(h)))
      bad(`has hosts for ${k} that are not a non-empty list of lower-case host names`)
  }
  return v as Record<string, string[]>
}

export const configFrom = (env: Record<string, string | undefined>, run: Run = spawn): Config => {
  const kubectl = env.FACTORY_KUBECTL ?? 'kubectl'
  return {
    atespaces: (env.FACTORY_BROKER_ATESPACES ?? 'factory').split(',').filter(Boolean),
    manager: env.FACTORY_AX_MANAGER ?? 'f-manager',
    run,
    kubectl,
    keyHosts: keyHostsFrom(env.FACTORY_BROKER_KEY_HOSTS),
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

/** only the manager task can use these vault keys: they give full AX control or write access to the backup repo */
const MANAGER_ONLY_KEYS = /(^|[^A-Za-z0-9_])(AX_AUTH|GITHUB_BASIC_MANAGER)([^A-Za-z0-9_]|$)/i
/** a vault name is a-z, 0-9 and hyphen, as agent-vault makes it: no percent escape, dot or upper case */
const vaultUri = (key: string) => new RegExp('^ate-secret://agent-vault/[a-z0-9-]+/' + key + '$')
const CREDENTIAL_URI = vaultUri('[A-Z][A-Z0-9_]*')
const REVIEWER_URI = vaultUri('GITHUB_REVIEWER')
const REVIEWER_BASIC_URI = vaultUri('GITHUB_REVIEWER_BASIC')

const same = (a: unknown, b: unknown[]) => JSON.stringify(a) === JSON.stringify(b)
const safeSegment = (x: string) => /^[A-Za-z0-9_.-]+$/.test(x) && x !== '.' && x !== '..'

/**
 * True for the one path rule that a worker policy can have on a github host. It gives the reviewer key on the
 * GitHub API for one repo (/repos/<owner>/<repo>/) and for /graphql, which gh pr view, checks and review use.
 * The grammar is closed. The broker refuses any other key, host, path or header.
 */
function reviewerApiRule(o: Record<string, unknown>): boolean {
  if (!same(Object.keys(o).sort(), ['effects', 'hostnames', 'pathPrefixes', 'paths'])) return false
  const hosts = o.hostnames
  if (
    !Array.isArray(hosts) ||
    !hosts.length ||
    hosts.some(h => h !== 'api.github.com' && h !== 'uploads.github.com')
  )
    return false
  const p = Array.isArray(o.pathPrefixes) && o.pathPrefixes.length === 1 ? o.pathPrefixes[0] : null
  const m = typeof p === 'string' && /^\/repos\/([^/]+)\/([^/]+)\/$/.exec(p)
  if (!m || !safeSegment(m[1]!) || !safeSegment(m[2]!) || !same(o.paths, ['/graphql'])) return false
  const e = o.effects as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || !same(Object.keys(e), ['replaceHeaders'])) return false
  const r = e.replaceHeaders
  if (!Array.isArray(r) || r.length !== 1 || !r[0] || typeof r[0] !== 'object') return false
  const h = r[0] as Record<string, unknown>
  return (
    same(Object.keys(h).sort(), ['credentialUri', 'header', 'prefix']) &&
    h.header === 'Authorization' &&
    h.prefix === 'Bearer ' &&
    typeof h.credentialUri === 'string' &&
    REVIEWER_URI.test(h.credentialUri)
  )
}

/**
 * True for the one github.com rule that gives the reviewer Basic key for git. egressPolicy builds this rule for
 * a reviewer task. The broker refuses any other key, host or header, as in reviewerApiRule.
 */
function reviewerGitRule(o: Record<string, unknown>): boolean {
  if (!same(Object.keys(o).sort(), ['effects', 'hostnames']) || !same(o.hostnames, ['github.com']))
    return false
  const e = o.effects as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || !same(Object.keys(e), ['replaceHeaders'])) return false
  const r = e.replaceHeaders
  if (!Array.isArray(r) || r.length !== 1 || !r[0] || typeof r[0] !== 'object') return false
  const h = r[0] as Record<string, unknown>
  return (
    same(Object.keys(h).sort(), ['credentialUri', 'header', 'prefix']) &&
    h.header === 'Authorization' &&
    h.prefix === 'Basic ' &&
    typeof h.credentialUri === 'string' &&
    REVIEWER_BASIC_URI.test(h.credentialUri)
  )
}

/** a hostname pattern that can match a github host: github.com, *.github.com, and the Substrate patterns * and *.com */
const githubHost = (x: string) => /^(\*|\*\.com|(.*\.)?github\.com)$/.test(x.toLowerCase().replace(/\.$/, ''))

/** a string that names a reviewer key in any spelling: case, underscores and other punctuation do not count */
const namesReviewerKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .includes('githubreviewer')

/**
 * The reason the broker refuses a worker policy, or null. A worker policy can name a reviewer key only in one
 * reviewerApiRule and one reviewerGitRule. Each must be a whole rule in rules[i]. The git rule needs the API rule.
 * A worker policy must not name a manager-only
 * vault key or have a pathPrefixes or paths rule (except reviewerApiRule) on a hostname pattern that can match a github host (github.com,
 * *.github.com, and the Substrate patterns * and *.com). Those belong to the manager policy. Substrate ignores key
 * case and underscores, and it folds some non-ASCII letters. So a key with a non-ASCII character fails closed.
 * With a reviewer API rule, no other rule can have a GitHub author key (a vault key that starts with GITHUB)
 * or an extra key on a github host. One policy cannot hold the two keys.
 */
export function workerPolicyRefusal(policy: unknown): string | null {
  const norm = (k: string) => k.toLowerCase().replaceAll('_', '')
  const reviewerRules = new Set<unknown>()
  let apiRules = 0
  let gitRules = 0
  const top = (policy as { rules?: unknown } | null)?.rules
  for (const r of Array.isArray(top) ? top : []) {
    const https =
      r && typeof r === 'object' && same(Object.keys(r), ['https']) ? (r as { https: unknown }).https : null
    if (!https || typeof https !== 'object' || Array.isArray(https)) continue
    const h = https as Record<string, unknown>
    const api = reviewerApiRule(h)
    if (api || reviewerGitRule(h)) {
      reviewerRules.add(https)
      if (api) apiRules++
      else gitRules++
    }
  }
  if (apiRules > 1 || gitRules > 1) return 'has more than one reviewer rule'
  if (gitRules && !apiRules) return 'has a reviewer git rule without a reviewer API rule'
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 32) return 'is nested too deep'
    if (typeof v === 'string') {
      const m = MANAGER_ONLY_KEYS.exec(v)
      if (m) return `names manager-only vault key ${m[2]!.toUpperCase()}`
      return namesReviewerKey(v) ? 'names a reviewer-only vault key outside the reviewer rules' : null
    }
    if (!v || typeof v !== 'object') return null
    if (reviewerRules.has(v)) return null
    const o = v as Record<string, unknown>
    const keys = Array.isArray(v) ? [] : Object.keys(o)
    for (const k of keys) {
      if (/[^\x20-\x7e]/.test(k)) return 'has a key with a non-ASCII character'
      const bad = walk(k, depth + 1)
      if (bad) return bad
      if (norm(k) === 'credentialuri' && !(typeof o[k] === 'string' && CREDENTIAL_URI.test(o[k] as string)))
        return 'has a credentialUri that is not an ate-secret://agent-vault/<vault>/<KEY> string (vault: a-z, 0-9, -)'
      if (apiRules && norm(k) === 'credentialuri' && /\/GITHUB[A-Z0-9_]*$/.test(o[k] as string))
        return 'has a GitHub vault key beside the reviewer rule'
      if (norm(k) === 'pathprefixes' || norm(k) === 'paths') {
        const h = keys.find(x => norm(x) === 'hostnames')
        const hosts = h === undefined ? null : o[h]
        if (!Array.isArray(hosts) || !hosts.length || hosts.some(x => typeof x !== 'string'))
          return 'has a path rule without a list of hostnames'
        if (hosts.some(githubHost) && !reviewerApiRule(o)) return 'has a path rule on a github host'
      }
      if (apiRules && norm(k) === 'hostnames') {
        const hosts = o[k]
        if (!Array.isArray(hosts) || hosts.some(x => typeof x !== 'string'))
          return 'has hostnames that are not a list of strings beside the reviewer rule'
        if (hosts.some(githubHost) && keys.some(x => norm(x) !== 'hostnames' && norm(x) !== 'ports'))
          return 'has a key on a github host beside the reviewer rule'
      }
    }
    for (const x of Array.isArray(v) ? v : Object.values(o)) {
      const bad = walk(x, depth + 1)
      if (bad) return bad
    }
    return null
  }
  return walk(policy, 0)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The reason the broker refuses a worker policy because of where a vault key goes, or null. Call it after
 * workerPolicyRefusal. A vault key can be only in rules[i].https.effects.replaceHeaders[j].credentialUri, in a rule
 * with this closed shape, and every hostname of that rule must be a host the key is pinned to (exact text, no case
 * fold, no wildcard). A key that starts with GITHUB, and the built-in keys, have fixed hosts. Any other key has the
 * hosts of keyHosts (FACTORY_BROKER_KEY_HOSTS), else none. A credentialUri or effects field anywhere else is refused.
 */
export function keyHostRefusal(policy: unknown, keyHosts: Record<string, string[]>): string | null {
  const norm = (k: string) => k.toLowerCase().replaceAll('_', '')
  const vetted = new Set<unknown>()
  const rules = isObj(policy) ? policy.rules : null
  for (const r of Array.isArray(rules) ? rules : []) {
    const h = isObj(r) ? r.https : null
    if (!isObj(h) || !Object.hasOwn(h, 'effects')) continue
    if (!same(Object.keys(r as object), ['https'])) return 'has a keyed rule that is not one https object'
    if (Object.keys(h).some(k => !['hostnames', 'ports', 'pathPrefixes', 'paths', 'effects'].includes(k)))
      return 'has a keyed rule with a field other than hostnames, ports, pathPrefixes, paths and effects'
    const hosts = h.hostnames
    if (!Array.isArray(hosts) || !hosts.length || hosts.some(x => typeof x !== 'string'))
      return 'has a keyed rule whose hostnames are not a non-empty list of strings'
    const e = h.effects
    if (!isObj(e) || !same(Object.keys(e), ['replaceHeaders']) || !Array.isArray(e.replaceHeaders))
      return 'has effects that are not one replaceHeaders list'
    vetted.add(h)
    for (const entry of e.replaceHeaders) {
      if (
        !isObj(entry) ||
        Object.keys(entry).some(k => !['header', 'prefix', 'credentialUri'].includes(k)) ||
        typeof entry.credentialUri !== 'string' ||
        !CREDENTIAL_URI.test(entry.credentialUri)
      )
        return 'has a replaceHeaders entry with a field other than header, prefix and credentialUri'
      vetted.add(entry)
      const key = entry.credentialUri.slice(entry.credentialUri.lastIndexOf('/') + 1)
      const pinned = key.startsWith('GITHUB')
        ? GITHUB_HOSTS
        : Object.hasOwn(BUILTIN_KEY_HOSTS, key)
          ? BUILTIN_KEY_HOSTS[key]!
          : Object.hasOwn(keyHosts, key)
            ? keyHosts[key]!
            : []
      const stray = (hosts as string[]).find(x => !pinned.includes(x))
      if (stray !== undefined)
        return `sends vault key ${key} to ${stray}, a host that the key is not pinned to`
    }
  }
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 32) return 'is nested too deep'
    if (!v || typeof v !== 'object') return null
    if (
      !Array.isArray(v) &&
      !vetted.has(v) &&
      Object.keys(v).some(k => ['credentialuri', 'effects'].includes(norm(k)))
    )
      return 'has a credentialUri or effects outside rules[i].https.effects.replaceHeaders'
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      const bad = walk(x, depth + 1)
      if (bad) return bad
    }
    return null
  }
  return walk(policy, 0)
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
    // no --request-timeout: in a pod, that flag makes kubectl skip the in-cluster config and call
    // localhost:8080, which is this broker. run() stops the call after 30 s
    const p = await c.run([c.kubectl, 'get', 'deployment', 'ax-controller', '-n', 'ax-system', '-o', 'json'])
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
      const p = await c.run(c.swap!, undefined, true)
      // the first line only: the script prints "slot N is live", and a token must never leave in a response
      if (p.code === 0) return text(200, firstLine(p.out) + '\n')
      // op's stderr can echo the token from argv: log the exit code only, answer with a fixed body
      console.error(`token swap failed: exit ${p.code}`)
      return text(502, 'token swap failed\n')
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
  const parsed = JSON.parse(policy)
  const why = workerPolicyRefusal(parsed) ?? keyHostRefusal(parsed, c.keyHosts)
  if (why) {
    // JSON.stringify escapes a newline in an attacker's host, and the cap bounds the line: one refusal, one log line
    console.error(`policy refused for ${r.atespace}/${r.actor}: ${JSON.stringify(why).slice(0, 300)}`)
    return text(400, `policy refused: it ${why}\n`)
  }
  // update a stored policy in place, so the actor always has one; with no stored policy, create one
  const got = await c.run([...c.ate, 'get', 'egress-policy', ...target, '-o', 'json'])
  const update = got.code === 0 ? updateBody(policy, got.out) : undefined
  const op = update ? 'update' : 'create'
  const p = await c.run([...c.ate, op, 'egress-policy', ...target, '-f', '-'], update ?? policy)
  return p.code === 0 ? text(200, `${op}d\n`) : text(502, `${op}: ${p.err.trim()}\n`)
}

/**
 * the body for `kubectl ate update egress-policy`: the new rules with the stored metadata, since the update
 * needs its uid and version. undefined when `stored` (the `get -o json` text) has no uid or version
 */
export function updateBody(policy: string, stored: string): string | undefined {
  try {
    const m = JSON.parse(stored)?.metadata
    if (!m?.uid || !m?.version) return undefined
    return JSON.stringify({ ...JSON.parse(policy), metadata: m })
  } catch {
    return undefined
  }
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
