// The AX runner: a station's worker as an AX Task in a microVM on the cluster instead of a herdr pane.
// The laptop drives it through the `ax` CLI; inside, `factory worker serve` runs Claude headless and
// queues what the worker's `factory report|mail|memory add` would have done in an outbox, which the
// laptop pulls each tick and replays. See docs/remote-runner.md.

const AX = () => process.env.FACTORY_AX ?? 'ax'
export const ATESPACE = () => process.env.FACTORY_AX_ATESPACE ?? 'factory'
/** where the task's one workspace is mounted, and the repo and the worker's own files inside it */
export const WS = '/workspace/w'
export const REPO = `${WS}/repo`
export const OWN = `${WS}/.factory-worker`

/** a worker's address in the run's context: `ax:<task>` where a herdr worker has its pane id */
export const isAx = (pane: string | null | undefined): pane is string => !!pane?.startsWith('ax:')
export const taskOf = (pane: string) => pane.slice(3)

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

/** the station's model, read from its herdr agent command (`--model 'claude-sonnet-5[1m]'`) */
export const modelOf = (agent: string) => agent.match(/--model\s+'?([^'\s]+)'?/)?.[1]

export type Launch = {
  name: string
  /** an https remote the VM can clone, and the run's branch, already pushed */
  repo: string
  branch: string
  image: string
  brief: string
  model?: string
  env: Record<string, string>
}

/** the Task and its Workspace as a multi-document manifest; JSON is YAML, so no YAML library */
export function manifest(l: Launch) {
  const metadata = { name: l.name, atespace: ATESPACE() }
  const workspace = {
    apiVersion: 'ax.io/v1alpha1',
    kind: 'Workspace',
    metadata,
    spec: {
      git: [{ name: 'origin', repo: l.repo, branch: l.branch, dir: 'repo' }],
    },
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
        // AX v0.3.1's Workspace has no files, so the brief rides in the env
        FACTORY_BRIEF: l.brief,
      }).map(([name, value]) => ({
        name,
        value,
      })),
      workspaces: [{ name: l.name, path: WS }],
      // ax ssh is how the laptop polls and prompts the worker; the microVM is the boundary
      debug: true,
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
}

function ax(args: string[], stdin?: string) {
  const p = Bun.spawnSync([AX(), '-a', ATESPACE(), ...args], {
    stdin: stdin ? Buffer.from(stdin) : undefined,
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

const VAULT_CLI = () => process.env.FACTORY_AGENT_VAULT ?? 'agent-vault'
/** FACTORY_AX_VAULT=<vault>@<host:port>, the agent-vault proxy as the VM reaches it; unset, no per-task agent */
const vaultOf = () =>
  process.env.FACTORY_AX_VAULT?.match(/^([^@]+)@(.+)$/)?.slice(1) as [string, string] | undefined
function vault(args: string[]) {
  const p = Bun.spawnSync([VAULT_CLI(), ...args])
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

/**
 * the proxy env for one task: AX can't mount a Secret, so the agent token rides in the Task's env, and each
 * task gets its own proxy-only agent, named after it and deleted with it, so a leaked token dies with its run
 */
export function proxyEnv(task: string): Record<string, string> {
  const v = vaultOf()
  if (!v) return {}
  const r = vault(['agent', 'create', task, '--vault', `${v[0]}:proxy`, '--token-only'])
  if (!r.ok || !r.out) throw new Error(`agent-vault agent create: ${r.err || 'no token'}`)
  const url = `http://${r.out}:${v[0]}@${v[1]}`
  return { HTTPS_PROXY: url, HTTP_PROXY: url }
}

export const launch = (l: Launch) => {
  const env = { ...l.env, ...proxyEnv(l.name) }
  try {
    must(['apply', '-f', '-'], manifest({ ...l, env }))
  } catch (e) {
    if (vaultOf()) vault(['agent', 'delete', l.name])
    throw e
  }
  return `ax:${l.name}`
}
export function phase(task: string) {
  const r = ax(['get', 'task', task])
  if (r.ok) return phaseOf(r.out)
  if (/not ?found/i.test(r.err)) return null
  throw new Error(`ax get task: ${r.err}`)
}
export const poll = (task: string, cursor: number): Poll =>
  JSON.parse(must(['ssh', task, '--', 'factory', 'worker', 'poll', String(cursor)]))
// base64: ax parses its own flags anywhere on the line, so a prompt starting with -a or -n would be eaten
export const prompt = (task: string, text: string) =>
  must(['ssh', task, '--', 'factory', 'worker', 'prompt', Buffer.from(text).toString('base64')])
export const suspend = (task: string) => must(['suspend', 'task', task])
export const resume = (task: string) => must(['resume', 'task', task])
/** the task, its workspace and its agent; gone already is fine */
export function remove(task: string) {
  ax(['delete', 'task', task])
  ax(['delete', 'workspace', task])
  if (vaultOf()) vault(['agent', 'delete', task])
}
