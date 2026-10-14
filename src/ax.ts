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

/** what `factory worker poll` prints: the worker's state and the outbox lines past the cursor */
export type Poll = {
  status: 'working' | 'idle' | 'exited'
  session?: string
  lines: string[]
  /** a Claude worker's last transcript entry */
  tail?: string
  /** the end of serve.log: serve's errors and its agent's stderr */
  log?: string
  /** an egress-gateway outage serve is retrying a turn through: see worker.ts egressFailure */
  egress?: { since: number; tries: number; last: string }
}

function ax(args: string[], stdin?: string) {
  const p = Bun.spawnSync([AX(), ...context(), '-a', ATESPACE(), ...args], {
    stdin: stdin ? Buffer.from(stdin) : undefined,
    timeout: 30_000, // a tick waits on it: an ssh into a VM that is still waking fails this tick, not every run's
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
 * a worker's EgressPolicy: HTTPS to Anthropic and GitHub, plus the rig's own rules, and nothing else. With FACTORY_AX_VAULT=<vault> the gateway
 * swaps the placeholder in each auth header for that agent-vault vault's credential: `ANTHROPIC` (a Claude OAuth token),
 * `GITHUB` (a GitHub App installation token) and `GITHUB_BASIC` (base64 of `x-access-token:<token>`, which git sends as
 * Basic auth). agent-vault reads them from their sources; the atespace's wildcard agent holds the grant.
 */
export function egressPolicy(vault = process.env.FACTORY_AX_VAULT, extra: Egress[] = []) {
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
      // the binary caches the image's Nix installs tools and a repo's devenv from; their packages are signed. And
      // Nix's global flake registry, which the worker user has no cached copy of: turning it off in nix.conf would
      // change every devenv's derivation, and so miss the rig's cached devenv
      { https: { hostnames: ['cache.nixos.org', 'devenv.cachix.org', 'channels.nixos.org'] } },
      ...extra.map(({ hosts, key, header, prefix, port }) =>
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
export function createPolicy(task: string, extra: Egress[] = []) {
  // a kubectl plugin takes kubectl's flags only after its name
  const p = Bun.spawnSync(
    [KUBECTL(), 'ate', ...context(), 'create', 'egress-policy', task, '-a', ATESPACE(), '-f', '-'],
    { stdin: Buffer.from(JSON.stringify(egressPolicy(undefined, extra))), timeout: 30_000 },
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
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic placeholder',
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
// base64: ax parses its own flags anywhere on the line, so a prompt starting with -a or -n would be eaten
export const prompt = (task: string, text: string) =>
  must([
    'ssh',
    task,
    '--',
    ...asWorker(['factory', 'worker', 'prompt', Buffer.from(text).toString('base64')]),
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
