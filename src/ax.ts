// The AX runner: a station's worker as an AX Task in a microVM on the cluster instead of a herdr pane.
// The laptop drives it through the `ax` CLI; inside, `factory worker serve` runs Claude headless and
// queues what the worker's `factory report|mail|memory add` would have done in an outbox, which the
// laptop pulls each tick and replays. See docs/remote-runner.md.

import { WORKER_USER } from './worker'

const AX = () => process.env.FACTORY_AX ?? 'ax'
const KUBECTL = () => process.env.FACTORY_KUBECTL ?? 'kubectl'
/** the cluster's kube context for both ax and kubectl; unset, their current context */
const context = () => (process.env.FACTORY_AX_CONTEXT ? ['--context', process.env.FACTORY_AX_CONTEXT] : [])
export const ATESPACE = () => process.env.FACTORY_AX_ATESPACE ?? 'factory'
/** where the task's one workspace is mounted, and the repo and the worker's own files inside it */
export const WS = '/workspace/w'
export const REPO = `${WS}/repo`
export const OWN = `${WS}/.factory-worker`

/**
 * what a task adds to its container's default capabilities (spec.capabilities): enough for serve to make the
 * workspace the worker user's and become it. An AX without spec.capabilities refuses the field, and
 * FACTORY_AX_CAPABILITIES= (empty) leaves it out, so the worker stays root
 */
export const CAPABILITIES = () =>
  (process.env.FACTORY_AX_CAPABILITIES ?? 'SETUID,SETGID,CHOWN').split(',').filter(Boolean)

/** a worker's address in the run's context: `ax://<task>` where a herdr worker has its pane id */
export const taskOf = (address: string) => address.slice('ax://'.length)

/** an RFC 1123 label of at most 63 characters, unique per worker launch */
export function taskName(run: string, seq: number) {
  const tail = `-${seq}`
  const head = `f-${run}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 63 - tail.length)
    .replace(/-+$/, '')
  return head + tail
}

/** where the image keeps the factory (Dockerfile.worker), and with it the workers' system prompt */
export const FACTORY_DIR = '/opt/factory'

/** the station's model, read from its agent command (`--model 'claude-sonnet-5[1m]'`, codex's `-m o3`) */
export const modelOf = (agent: string) => agent.match(/(?:^|\s)(?:--model|-m)[\s=]+'?([^'\s]+)'?/)?.[1]
/** pi's provider, read from its agent command (`--provider anthropic`); pi defaults to google */
export const providerOf = (agent: string) => agent.match(/(?:^|\s)--provider[\s=]+'?([^'\s]+)'?/)?.[1]

/** the agents a VM can run headless and resume: see worker.ts */
export type Harness = 'claude' | 'codex' | 'pi'

/**
 * a rig's extra egress rule: HTTPS to `hosts`, and with a vault `key` the gateway puts that agent-vault credential in
 * `header` (after `prefix`) on the way out. No key: reachable as it is. `port` when not 443 (a Dolt remotesapi)
 */
export type Egress = { hosts: string[]; key?: string; header?: string; prefix?: string; port?: number }

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
/**
 * `--egress <host>[,<host>...][=<KEY>[:<Header>:<Prefix>]]`: hosts, then optionally the vault key that is
 * injected, and the header and prefix it goes in (default `Authorization` and `Bearer `)
 */
export function parseEgress(spec: string): Egress {
  const eq = spec.indexOf('=')
  const hosts = (eq < 0 ? spec : spec.slice(0, eq)).split(',')
  const bad = hosts.find(h => !HOST.test(h))
  if (bad !== undefined) throw new Error(`--egress host "${bad}" is not a hostname (api.openai.com)`)
  if (eq < 0) return { hosts }
  const [key, header, ...prefix] = spec.slice(eq + 1).split(':')
  if (!/^[A-Z][A-Z0-9_]*$/.test(key!))
    throw new Error(`--egress key "${key}" is SCREAMING_SNAKE_CASE, as agent-vault names it (OPENAI)`)
  if (header !== undefined && !/^[A-Za-z][A-Za-z0-9-]*$/.test(header))
    throw new Error(`--egress header "${header}" is a header name (Authorization)`)
  return { hosts, key, ...(header !== undefined && { header, prefix: prefix.join(':') }) }
}

export type Launch = {
  name: string
  /** an https remote the VM clones, and the run's branch, already pushed */
  repo: string
  branch: string
  image: string
  /** the brief in the task's env; without it, the laptop sends brief.md once the task runs */
  brief?: string
  model?: string
  /** the agent the VM runs (claude when absent) and, for pi, its provider */
  harness?: Harness
  provider?: string
  /** Claude's flags for a worker: tools, settings, system prompt (what workerFlags gives a pane's Claude) */
  claudeFlags?: string[]
  env: Record<string, string>
  /** the rig origin's host when it is GitLab: its tokens are injected like GitHub's */
  gitlabHost?: string
}

/** the Task and its Workspace as a multi-document manifest; JSON is YAML, so no YAML library */
export function manifest(l: Launch) {
  const metadata = { name: l.name, atespace: ATESPACE() }
  const workspace = {
    apiVersion: 'ax.io/v1alpha1',
    kind: 'Workspace',
    metadata,
    // ponytail: no git here. AX clones inside the VM before the task's egress policy exists, so the clone
    // fails and the workspace is still Ready; `factory worker serve` clones once it can
    spec: {},
  }
  const task = {
    apiVersion: 'ax.io/v1alpha1',
    kind: 'Task',
    metadata,
    spec: {
      image: l.image,
      command: ['factory', 'worker', 'serve', ...(l.model ? ['--model', l.model] : [])],
      env: Object.entries({
        ...l.env,
        FACTORY_OUTBOX: `${OWN}/outbox.jsonl`,
        FACTORY_REPO: l.repo,
        FACTORY_BRANCH: l.branch,
        // AX v0.3.1's Workspace has no files: a short brief rides in the env
        ...(l.brief !== undefined && { FACTORY_BRIEF: l.brief }),
        FACTORY_HARNESS: l.harness ?? 'claude',
        ...(l.provider && { FACTORY_PROVIDER: l.provider }),
        ...(l.claudeFlags?.length && { FACTORY_CLAUDE_FLAGS: JSON.stringify(l.claudeFlags) }),
      }).map(([name, value]) => ({
        name,
        value,
      })),
      workspaces: [{ name: l.name, path: WS }],
      // ax ssh is how the laptop polls and prompts the worker; the microVM is the boundary
      debug: true,
      // so serve can run as the image's worker user instead of root (worker.ts asWorker)
      ...(CAPABILITIES().length && { capabilities: CAPABILITIES() }),
    },
  }
  return [workspace, task].map(d => JSON.stringify(d, null, 2)).join('\n---\n')
}

/** a task's phase from `ax get task` (YAML): Pending, Running, Suspended, Failed, Terminating; null when gone */
export const phaseOf = (yaml: string) => yaml.match(/^\s+phase:\s*"?(\w+)/m)?.[1] ?? null

/** Pending tasks cannot start while the shared controller is down; preserve them instead of retrying. */
export function unavailable(): string | undefined {
  const unknown = 'AX executor unavailable: controller readiness could not be observed'
  try {
    const p = Bun.spawnSync(
      [
        KUBECTL(),
        ...context(),
        'get',
        'deployment',
        'ax-controller',
        '-n',
        'ax-system',
        '-o',
        'json',
        '--request-timeout=5s',
      ],
      { timeout: 6_000 },
    )
    if (p.exitCode !== 0) return unknown
    const d = JSON.parse(p.stdout.toString())
    const generation = d?.metadata?.generation
    const status = d?.status
    if (
      !d?.metadata?.deletionTimestamp &&
      Number.isSafeInteger(generation) &&
      generation > 0 &&
      Number.isSafeInteger(status?.observedGeneration) &&
      status.observedGeneration >= generation &&
      Number.isSafeInteger(d?.spec?.replicas) &&
      d.spec.replicas > 0 &&
      Number.isSafeInteger(status?.readyReplicas) &&
      status.readyReplicas > 0 &&
      Number.isSafeInteger(status?.availableReplicas) &&
      status.availableReplicas > 0
    )
      return undefined
    return 'AX executor unavailable: ax-system/ax-controller is not ready at its current generation'
  } catch {
    return unknown
  }
}

/** what `factory worker poll` prints: the worker's state and the outbox lines past the cursor */
export type Poll = {
  status: 'working' | 'idle' | 'exited'
  session?: string
  lines: string[]
  /** a Claude worker's last transcript entry */
  tail?: string
  /** the worker repo's `git rev-parse HEAD`, read inside the VM */
  head?: string
  /** the size, in bytes, of the harness's live stream copy (own()/<h>.jsonl): grows while a turn runs */
  bytes?: number
  /** the end of serve.log: serve's errors and its agent's stderr */
  log?: string
  /** an egress-gateway outage serve is retrying a turn through: see worker.ts egressFailure */
  egress?: { since: number; tries: number; last: string }
}

function ax(args: string[], stdin?: string, timeout = 30_000) {
  const p = Bun.spawnSync([AX(), ...context(), '-a', ATESPACE(), ...args], {
    stdin: stdin ? Buffer.from(stdin) : undefined,
    timeout, // a tick waits on it: an ssh into a VM that is still waking fails this tick, not every run's
  })
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString(),
    err: p.stderr.toString().trim(),
  }
}
function must(args: string[], stdin?: string) {
  const r = ax(args, stdin)
  if (!r.ok) throw new Error(`ax ${args.slice(0, 2).join(' ')}: ${r.err || r.out.trim()}`)
  return r.out
}

const EGRESS_CA = 'egress-mitm.ate.dev:mitm:primary-bundle'
/**
 * the egress gateway's public CA, which the VM must trust because every HTTPS request out is decrypted by the
 * gateway; Substrate hands it only to actors whose template asks for it, and AX's templates don't
 */
export function egressCA() {
  const p = Bun.spawnSync([
    KUBECTL(),
    ...context(),
    ...['get', 'clustertrustbundle', EGRESS_CA, '-o', 'jsonpath={.spec.trustBundle}'],
  ])
  const ca = p.stdout.toString().trim()
  if (p.exitCode !== 0 || !ca)
    throw new Error(`the egress gateway's CA: ${p.stderr.toString().trim() || 'empty'}`)
  return ca
}

/**
 * registry hosts a rig's egress might list directly: once a pkg-gate is in front (FACTORY_AX_PKG_GATE), these
 * never belong in a task's egress again -- the gate is the only registry host a task may reach, so every
 * toolchain's fetches go through its age check, nix-provided ones included. See claude-factory-ei0.
 */
export const REGISTRY_HOSTS = [
  'proxy.golang.org',
  'sum.golang.org',
  'goproxy.io',
  'goproxy.cn',
  'registry.npmjs.org',
  'registry.npmjs.com',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'pypi.org',
  'pypi.python.org',
  'test.pypi.org',
  'files.pythonhosted.org',
]

/** DNS is case-insensitive and tolerates a trailing dot (an absolute FQDN); --egress's HOST regex accepts
 * both, so comparing against REGISTRY_HOSTS has to normalize the same way or a differently-cased or
 * dot-terminated registry host slips through both the strip below and the rig-add warning (ei0.16) */
const normalizeHost = (h: string) => h.toLowerCase().replace(/\.$/, '')
export const isRegistryHost = (h: string) => REGISTRY_HOSTS.includes(normalizeHost(h))

/** an extra rule with every REGISTRY_HOSTS host dropped; a rule left with none is dropped entirely */
function stripRegistryHosts(extra: Egress[]): Egress[] {
  return extra
    .map(e => ({ ...e, hosts: e.hosts.filter(h => !isRegistryHost(h)) }))
    .filter(e => e.hosts.length > 0)
}

/** the gate's own egress rule: an https rule for https://, a Substrate HTTPRule ({http: ...}) for http:// */
function gateRule(gateUrl: string) {
  const u = new URL(gateUrl)
  const defaultPort = u.protocol === 'https:' ? 443 : 80
  const port = u.port ? Number(u.port) : defaultPort
  const ports = port !== defaultPort ? { ports: { numbers: [port] } } : {}
  return u.protocol === 'https:'
    ? { https: { hostnames: [u.hostname], ...ports } }
    : { http: { hostnames: [u.hostname], ...ports } }
}

/** a GitLab host's one rule: glab sends an access token as `PRIVATE-TOKEN` (checked against glab 1.99) and git
 * sends Basic auth; the vault's `GITLAB` and `GITLAB_BASIC` keys are what the gateway puts in their place */
const gitlabRule = (host: string, uri?: (key: string) => string) => ({
  https: {
    hostnames: [host],
    ...(uri && {
      effects: {
        replaceHeaders: [
          { header: 'PRIVATE-TOKEN', prefix: '', credentialUri: uri('GITLAB') },
          { header: 'Authorization', prefix: 'Basic ', credentialUri: uri('GITLAB_BASIC') },
        ],
      },
    }),
  },
})

/**
 * a worker's EgressPolicy: HTTPS to Anthropic and GitHub, plus the rig's own rules, and nothing else. With FACTORY_AX_VAULT=<vault> the gateway
 * swaps the placeholder in each auth header for that agent-vault vault's credential: `ANTHROPIC` (a Claude OAuth token),
 * `GITHUB` (a GitHub App installation token) and `GITHUB_BASIC` (base64 of `x-access-token:<token>`, which git sends as
 * Basic auth). A rig on GitLab host H gets H the same way, with `GITLAB` (an access token) and `GITLAB_BASIC`
 * (base64 of `<user>:<token>`, git's Basic auth). agent-vault reads them from their sources; the atespace's wildcard agent holds the grant.
 *
 * With FACTORY_AX_PKG_GATE=<scheme://host[:port]> set (on the laptop; unset leaves this byte-identical to
 * before), the gate's own host is added and every REGISTRY_HOSTS host is stripped from the rig's extra rules
 * -- nix-provided go/npm/pip/uv included, since the strip is what enforces the gate's age check, not launch()'s
 * convenience env (below).
 */
export function egressPolicy(
  vault = process.env.FACTORY_AX_VAULT,
  extra: Egress[] = [],
  gate = process.env.FACTORY_AX_PKG_GATE,
  gitlabHost?: string,
) {
  const uri = (key: string) => `ate-secret://agent-vault/${vault}/${key}`
  const rule = (hostnames: string[], header: string, prefix: string, key: string, port?: number) => ({
    https: {
      hostnames,
      ...(port && { ports: { numbers: [port] } }),
      ...(vault && { effects: { replaceHeaders: [{ header, prefix, credentialUri: uri(key) }] } }),
    },
  })
  return {
    rules: [
      rule(['api.anthropic.com'], 'Authorization', 'Bearer ', 'ANTHROPIC'),
      rule(['api.github.com', 'uploads.github.com'], 'Authorization', 'Bearer ', 'GITHUB'),
      rule(['github.com'], 'Authorization', 'Basic ', 'GITHUB_BASIC'),
      ...(gitlabHost ? [gitlabRule(gitlabHost, vault ? uri : undefined)] : []),
      // the binary caches the image's Nix installs tools and a repo's devenv from; their packages are signed. And
      // Nix's global flake registry, which the worker user has no cached copy of: turning it off in nix.conf would
      // change every devenv's derivation, and so miss the rig's cached devenv
      { https: { hostnames: ['cache.nixos.org', 'devenv.cachix.org', 'channels.nixos.org'] } },
      ...(gate ? [gateRule(gate)] : []),
      ...(gate ? stripRegistryHosts(extra) : extra).map(({ hosts, key, header, prefix, port }) =>
        key
          ? rule(hosts, header ?? 'Authorization', prefix ?? 'Bearer ', key, port)
          : { https: { hostnames: hosts, ...(port && { ports: { numbers: [port] } }) } },
      ),
    ],
  }
}

/**
 * the task's egress policy; false while its actor, which appears a moment after `ax apply`, is not there yet.
 * One try: the tick that launched the task does not wait, the next ones try again.
 */
export function createPolicy(task: string, extra: Egress[] = [], gitlabHost?: string) {
  // a kubectl plugin takes kubectl's flags only after its name
  const p = Bun.spawnSync(
    [KUBECTL(), 'ate', ...context(), 'create', 'egress-policy', task, '-a', ATESPACE(), '-f', '-'],
    {
      stdin: Buffer.from(JSON.stringify(egressPolicy(undefined, extra, undefined, gitlabHost))),
      timeout: 30_000,
    },
  )
  return p.exitCode === 0
}

/**
 * apply the task; its egress policy comes after (createPolicy), and until it exists the VM can reach nothing,
 * which `serve` waits out. The keys in the VM are placeholders: the gateway puts the real ones in on the way out.
 */
export const launch = (l: Launch) => {
  const env = {
    ...l.env,
    FACTORY_CA: egressCA(),
    // the policy allows only the hosts it names, so skip the telemetry it would refuse
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // only when the gateway injects: GitHub answers a placeholder Basic header with 400, even for a public clone
    ...(process.env.FACTORY_AX_VAULT && {
      // each agent sends its key as `Authorization: Bearer`; the rig's egress rule names the vault key behind it
      ...((l.harness ?? 'claude') === 'claude' && { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder' }),
      ...(l.harness === 'codex' && { OPENAI_API_KEY: 'placeholder', CODEX_API_KEY: 'placeholder' }),
      GH_TOKEN: 'placeholder',
      // git's config from the env, so every git in the VM sends the header
      GIT_CONFIG_COUNT: l.gitlabHost ? '2' : '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic placeholder',
      ...(l.gitlabHost && {
        GITLAB_TOKEN: 'placeholder',
        GITLAB_HOST: l.gitlabHost,
        GIT_CONFIG_KEY_1: `http.https://${l.gitlabHost}/.extraHeader`,
        GIT_CONFIG_VALUE_1: 'Authorization: Basic placeholder',
      }),
    }),
    // convenience only: what actually enforces the gate is egressPolicy's REGISTRY_HOSTS strip above, so a
    // worker that unsets these (or reaches for `nix shell nixpkgs#go` directly) still hits a refused host
    ...(process.env.FACTORY_AX_PKG_GATE && {
      GOPROXY: `${process.env.FACTORY_AX_PKG_GATE}/go`,
      NPM_CONFIG_REGISTRY: `${process.env.FACTORY_AX_PKG_GATE}/npm/`,
      BUN_CONFIG_REGISTRY: `${process.env.FACTORY_AX_PKG_GATE}/npm/`,
      YARN_NPM_REGISTRY_SERVER: `${process.env.FACTORY_AX_PKG_GATE}/npm/`,
      PIP_INDEX_URL: `${process.env.FACTORY_AX_PKG_GATE}/pypi/simple`,
      UV_DEFAULT_INDEX: `${process.env.FACTORY_AX_PKG_GATE}/pypi/simple`,
      UV_INDEX_URL: `${process.env.FACTORY_AX_PKG_GATE}/pypi/simple`,
      ...(process.env.FACTORY_AX_PKG_GATE.startsWith('http://') && {
        PIP_TRUSTED_HOST: new URL(process.env.FACTORY_AX_PKG_GATE).hostname,
        UV_INSECURE_HOST: new URL(process.env.FACTORY_AX_PKG_GATE).hostname,
        // yarn berry refuses to even try an http:// registry (npmRegistryServer) unless its host is on this
        // whitelist, same reason pip and uv need their own overrides above (ei0.19)
        YARN_UNSAFE_HTTP_WHITELIST: new URL(process.env.FACTORY_AX_PKG_GATE).hostname,
      }),
    }),
  }
  must(['apply', '-f', '-'], manifest({ ...l, env }))
  return `ax://${l.name}`
}
export function phase(task: string) {
  const r = ax(['get', 'task', task])
  if (r.ok) return phaseOf(r.out)
  if (/not ?found/i.test(r.err)) return null
  throw new Error(`ax get task: ${r.err}`)
}
/**
 * a VM command as the worker user, not root: root over `ax ssh` has no DAC_OVERRIDE or CAP_FOWNER (see
 * docs/remote-runner.md), so it cannot write `.factory-worker`, which `serve` gave to WORKER_USER. setpriv
 * keeps root's HOME, which the worker cannot read, so `env` resets it (mirrors the env asWorker's re-exec
 * gives serve, worker.ts:381). Without SETUID and SETGID (no spec.capabilities, serve stays root) the
 * command goes over as given, since there is then nobody else to become.
 */
function asWorker(argv: string[]) {
  const caps = CAPABILITIES()
  if (!caps.includes('SETUID') || !caps.includes('SETGID')) return argv
  return [
    'setpriv',
    `--reuid=${WORKER_USER}`,
    `--regid=${WORKER_USER}`,
    '--init-groups',
    'env',
    `HOME=/home/${WORKER_USER}`,
    `USER=${WORKER_USER}`,
    ...argv,
  ]
}
export const poll = (task: string, cursor: number): Poll =>
  JSON.parse(must(['ssh', task, '--', ...asWorker(['factory', 'worker', 'poll', String(cursor)])]))
/**
 * the byte budget for prompt()'s text, before it is base64'd onto the ssh argv: base64 blows up a byte
 * count by 4/3, and Linux's execve() caps one argv string at MAX_ARG_STRLEN (131072 bytes). 90,000 bytes
 * encodes to about 120,000, with headroom for the ssh command itself and the clip marker below
 * (claude-factory-kcg)
 */
export const PROMPT_MAX_BYTES = 90_000
/**
 * text clipped to at most `maxBytes` UTF-8 bytes, a marker appended naming both sizes: never cuts a
 * multi-byte character in half. A UTF-8 continuation byte (10xxxxxx) never starts a character, so backing
 * up over any at the cut point lands on the start of the character it belongs to, and that whole character
 * is dropped rather than left half-decoded
 */
export function clipBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return `${buf.subarray(0, end).toString('utf8')}\n[clipped: ${end} of ${buf.length} bytes]`
}
// base64: ax parses its own flags anywhere on the line, so a prompt starting with -a or -n would be eaten
export const prompt = (task: string, text: string) =>
  must([
    'ssh',
    task,
    '--',
    ...asWorker([
      'factory',
      'worker',
      'prompt',
      Buffer.from(clipBytes(text, PROMPT_MAX_BYTES), 'utf8').toString('base64'),
    ]),
  ])
/**
 * one part of a file for the VM, over ssh: Substrate takes no env value past 32 KiB, so what is bigger (the
 * run's beads copy) comes after the task starts. A part stays under the 128 KiB an argument may be.
 * `ok: false` while the VM is still waking, or when the worker user cannot be reached: the caller decides,
 * from `err`, whether to try again or give up
 */
export function put(task: string, name: string, part: number, parts: number, base64: string) {
  const r = ax([
    'ssh',
    task,
    '--',
    ...asWorker(['factory', 'worker', 'put', name, String(part), String(parts), base64]),
  ])
  return r.ok ? { ok: true as const } : { ok: false as const, err: r.err }
}
export const PUT_PART = 96_000
export const suspend = (task: string) => must(['suspend', 'task', task])
export const resume = (task: string) => must(['resume', 'task', task])
/** the task (its actor's egress policy goes with it) and its workspace; gone already is fine */
export function remove(task: string) {
  ax(['delete', 'task', task])
  ax(['delete', 'workspace', task])
}

/** the AX task the manager runs in; it is the one-manager lease (docs/remote-runner.md, Attach to the AX manager) */
export const managerTask = () => process.env.FACTORY_AX_MANAGER ?? 'f-manager'
const MANAGER_PANE = () => process.env.FACTORY_AX_MANAGER_PANE ?? '1'

/** why this process must not run a manager or tick: the manager task lives, and this is not inside it */
export function managerRefusal(phase: string | null, env: Record<string, string | undefined>, task: string) {
  if (env.FACTORY_IN_AX === '1' || !['Running', 'Pending', 'Suspended'].includes(phase ?? ''))
    return undefined
  return `the factory manager runs in AX task ${task} (${phase}): attach with \`factory attach\`, steer with \`factory say <text>\``
}

/**
 * ponytail: the task is the lease, one `ax get task` with a 5 s timeout. Only with a cluster configured
 * (FACTORY_AX_CONTEXT), and an unreachable AX does not block: a laptop with no cluster must still work. The
 * ceiling: AX down while the manager runs lets the laptop start a second one; a lease record would close it
 */
export function remoteManager(): string | undefined {
  if (process.env.FACTORY_IN_AX === '1' || !process.env.FACTORY_AX_CONTEXT) return undefined
  const task = managerTask()
  const r = ax(['get', 'task', task], undefined, 5_000)
  if (r.ok) return managerRefusal(phaseOf(r.out), process.env, task)
  if (!/not ?found/i.test(r.err))
    console.error(`warning: AX unreachable, manager lease not checked: ${r.err}`)
  return undefined
}

/** a command in the manager's VM, as the worker user when the task drops to it (same rule as the worker's) */
const managerCmd = (argv: string[]) => ['ssh', managerTask(), '--', ...asWorker(argv)]

/** the manager pane's recent text; `ax ssh` has no TTY or stdin, so this is a snapshot, not herdr attach */
export const attachRead = () => must(managerCmd(['herdr', 'pane', 'read', MANAGER_PANE(), '--lines', '60']))

/**
 * type `text` and Enter into the manager pane. The text travels base64 and the VM decodes it: ax parses -a, -n,
 * --server and --context anywhere on its line, and base64 has no quote, so no shell string is built from the text
 */
export const say = (text: string) =>
  must(
    managerCmd([
      'sh',
      '-c',
      `herdr pane send-text ${MANAGER_PANE()} -- "$(echo ${Buffer.from(text, 'utf8').toString('base64')} | base64 -d)" && herdr pane send-keys ${MANAGER_PANE()} Enter`,
    ]),
  )
