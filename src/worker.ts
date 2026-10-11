// Inside an AX task's microVM: `factory worker serve` is the task's command. It runs the station's
// agent (Claude, codex or pi) headless on the brief, then each prompt the laptop queues (a nudge, a mail, the time warning)
// as another turn of the same session. The factory commands a worker runs only append to the outbox;
// the laptop pulls it with `factory worker poll` and replays it there.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const own = () => process.env.FACTORY_WORKER_DIR ?? '/workspace/w/.factory-worker'
const repo = () => process.env.FACTORY_WORKER_REPO ?? '/workspace/w/repo'
const outbox = () => process.env.FACTORY_OUTBOX ?? join(own(), 'outbox.jsonl')
const prompts = () => join(own(), 'prompts')
const stateFile = () => join(own(), 'state.json')

type State = { status: 'working' | 'idle'; session?: string; pid: number }
const state = (): State | null =>
  existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), 'utf8')) : null
const save = (s: State) => writeFileSync(stateFile(), JSON.stringify(s))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** what `factory report|mail|memory add` does in a VM: queue the command line for the laptop to run */
export function queue(argv: string[]) {
  appendFileSync(outbox(), JSON.stringify({ argv, from: process.env.FACTORY_FROM, at: Date.now() }) + '\n')
}

type Harness = 'claude' | 'codex' | 'pi'
const harness = (): Harness => (process.env.FACTORY_HARNESS as Harness | undefined) ?? 'claude'

/**
 * the argv of one headless turn of an agent: the brief when there is no session yet, else the next prompt
 * resuming it. Claude: `-p --resume <id>`; codex: `exec`, then `exec resume <id>`; pi: `-p --session-id <id>`,
 * which pi creates on first use. The agents' permission prompts are off: the microVM is the sandbox.
 */
export function turnArgv(
  h: Harness,
  text: string,
  o: { model?: string; provider?: string; session?: string; claudeFlags?: string[]; piDir?: string } = {},
) {
  const model = (flag: string) => (o.model ? [flag, o.model] : [])
  switch (h) {
    case 'claude':
      return [
        process.env.FACTORY_CLAUDE ?? 'claude',
        ...['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
        ...(o.claudeFlags ?? []),
        ...model('--model'),
        ...(o.session ? ['--resume', o.session] : []),
        text,
      ]
    case 'codex':
      return [
        process.env.FACTORY_CODEX ?? 'codex',
        ...['exec', ...(o.session ? ['resume'] : [])],
        ...['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
        ...model('-m'),
        // after --, so a prompt that starts with a dash is not a flag
        ...['--', ...(o.session ? [o.session] : []), text],
      ]
    case 'pi':
      return [
        process.env.FACTORY_PI ?? 'pi',
        ...['-p', '--session-dir', o.piDir!, '--session-id', o.session!],
        ...(o.provider ? ['--provider', o.provider] : []),
        ...model('--model'),
        text,
      ]
  }
}

/** the session a turn's output names: Claude's init event, codex's thread.started; pi's id is ours, given up front */
export function sessionIn(h: Harness, out: string) {
  if (h === 'claude') return out.match(/"session_id":"([^"]+)"/)?.[1]
  if (h === 'codex') return out.match(/"type":"thread\.started"[^\n]*?"thread_id":"([^"]+)"/)?.[1]
}

/** one turn of the station's agent; returns its session id, given the one before */
async function turn(text: string, model?: string, session?: string) {
  const h = harness()
  // pi has no output to read an id from: it takes one on first use
  const id = h === 'pi' ? (session ?? crypto.randomUUID()) : session
  const argv = turnArgv(h, text, {
    model,
    provider: process.env.FACTORY_PROVIDER,
    session: id,
    claudeFlags: process.env.FACTORY_CLAUDE_FLAGS ? JSON.parse(process.env.FACTORY_CLAUDE_FLAGS) : [],
    piDir: join(own(), 'pi'),
  })
  // env spelled out: Bun's default is the env at startup, without what setup() added
  const p = Bun.spawn(argv, { cwd: repo(), env: { ...process.env }, stdout: 'pipe', stderr: 'inherit' })
  const out = await new Response(p.stdout).text()
  await p.exited
  appendFileSync(join(own(), `${h}.jsonl`), out)
  return h === 'pi' ? id : (sessionIn(h, out) ?? session)
}

function sh(cmd: string[], cwd?: string) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env }, stderr: 'pipe' })
  return { ok: p.exitCode === 0, err: p.stderr.toString().trim() }
}

/**
 * every start, since only the workspace survives a suspend: trust the egress gateway's CA (it decrypts all
 * HTTPS out) and clone the run's branch, retrying while the task's egress policy does not exist yet
 */
export async function setup({ tries = 60, waitMs = 5000 } = {}) {
  if (process.env.FACTORY_CA) {
    const ca = join(own(), 'egress-ca.crt')
    writeFileSync(ca, process.env.FACTORY_CA)
    // the gateway re-signs every HTTPS host the VM may reach, so its CA is the only root needed
    Object.assign(process.env, { NODE_EXTRA_CA_CERTS: ca, GIT_SSL_CAINFO: ca, SSL_CERT_FILE: ca })
  }
  const remote = process.env.FACTORY_REPO
  if (!remote || existsSync(join(repo(), '.git'))) return
  let err = ''
  for (let i = 0; i < tries; i++) {
    rmSync(repo(), { recursive: true, force: true })
    const r = sh(['git', 'clone', '--branch', process.env.FACTORY_BRANCH ?? 'main', remote, repo()])
    if (r.ok) return
    err = r.err
    await Bun.sleep(waitMs)
  }
  throw new Error(`git clone ${remote}: ${err}`)
}

/**
 * the worker: the brief once, then queued prompts in order, one turn at a time. A resumed task restarts
 * it with the workspace as it was, so a session already started is never briefed again.
 */
export async function serve(model?: string, { idleMs = 1000, once = false } = {}) {
  mkdirSync(prompts(), { recursive: true })
  await setup()
  let session = state()?.session
  const set = (status: State['status']) => save({ status, session, pid: process.pid })
  if (!session) {
    const brief = process.env.FACTORY_BRIEF
    if (!brief) throw new Error('FACTORY_BRIEF is not set: the task carries the brief in its env')
    set('working')
    session = await turn(brief, model)
  }
  for (;;) {
    const next = readdirSync(prompts()).sort()[0]
    if (!next) {
      set('idle')
      if (once) return
      await Bun.sleep(idleMs)
      continue
    }
    set('working')
    const file = join(prompts(), next)
    session = await turn(readFileSync(file, 'utf8'), model, session)
    rmSync(file) // after the turn: a prompt cut off by a crash runs again
  }
}

/** the laptop's view: the worker's state and the outbox past its cursor */
export function poll(cursor: number) {
  const s = state()
  const lines = existsSync(outbox()) ? readFileSync(outbox(), 'utf8').split('\n').filter(Boolean) : []
  return {
    status: !s || !alive(s.pid) ? 'exited' : s.status,
    session: s?.session,
    lines: lines.slice(cursor),
  }
}

export function prompt(base64: string) {
  mkdirSync(prompts(), { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  writeFileSync(join(prompts(), name), Buffer.from(base64, 'base64').toString())
}
