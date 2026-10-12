// Inside an AX task's microVM: `factory worker serve` is the task's command. It runs the station's
// agent (Claude, codex or pi) headless on the brief, then each prompt the laptop queues (a nudge, a mail, the time warning)
// as another turn of the same session. The factory commands a worker runs only append to the outbox;
// the laptop pulls it with `factory worker poll` and replays it there.
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
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

/** the env values the laptop sent in chunks (ax.chunkEnv), joined back under their names */
export function joinEnv(env: Record<string, string | undefined> = process.env) {
  const parts = Object.keys(env)
    .map(k => /^(.+)__(\d+)$/.exec(k))
    .filter(m => m !== null)
    .sort((a, b) => Number(a[2]) - Number(b[2]))
  for (const [key, name] of parts) {
    env[name!] = (env[name!] ?? '') + env[key!]
    delete env[key!]
  }
}

/** a bd command line that changes the store: the VM's own store takes it, and the laptop's gets it through the outbox */
export function isBdWrite([cmd, sub]: string[]) {
  if (['create', 'update', 'close', 'reopen', 'comment'].includes(cmd ?? '')) return true
  if (cmd === 'comments' || cmd === 'label') return sub === 'add' || sub === 'remove'
  return cmd === 'dep' && !['list', 'tree', 'cycles'].includes(sub ?? '')
}

/** the files a bd write reads, as the values they hold: on the laptop the path would name the laptop's file */
const BD_FILE_FLAGS: Record<string, string> = {
  '--body-file': '--description',
  '--design-file': '--design',
  '--reason-file': '--reason',
}
export function inlineBdFiles(args: string[], read = (f: string) => readFileSync(f, 'utf8')) {
  return args.flatMap((a, i) => {
    const [flag, value] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]
    if (BD_FILE_FLAGS[args[i - 1] ?? ''] && !args[i - 1]!.includes('=')) return [] // taken with its flag
    if (!BD_FILE_FLAGS[flag!]) return [a]
    const file = value ?? args[i + 1]!
    return [BD_FILE_FLAGS[flag!]!, file === '-' ? '' : read(file)]
  })
}

/** the id bd create printed: `Created issue: <id>`, or the JSON with --json */
export const createdId = (out: string) =>
  out.match(/Created issue: (\S+)/)?.[1] ?? out.match(/"id":\s*"([^"]+)"/)?.[1]

/**
 * `bd` in the VM (a shim on the agent's PATH runs this): the VM's own store, loaded from the laptop's open
 * issues, answers, and a write that succeeded is queued for the laptop's store too, a create with the id
 * the VM's store gave it, so later commands naming that id hold on both sides
 */
export function bd(args: string[]) {
  const write = isBdWrite(args)
  const argv = write ? inlineBdFiles(args) : args
  const p = Bun.spawnSync([process.env.FACTORY_BD ?? '/usr/local/bin/bd', ...argv], {
    env: { ...process.env },
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const out = p.stdout.toString()
  process.stdout.write(out)
  if (p.exitCode === 0 && write) {
    const id =
      argv[0] === 'create' && !argv.some(a => a === '--id' || a.startsWith('--id=')) && createdId(out)
    queue(['bd', ...argv, ...(id ? ['--id', id] : [])])
  }
  return p.exitCode ?? 1
}

/**
 * the VM's beads, when the laptop sent a snapshot (FACTORY_BEADS: gzip, base64, bd export lines): a store of
 * its own, loaded once (a resumed task keeps it), which the agent's bd finds through BEADS_DIR and the shim
 */
function setupBeads() {
  const snapshot = process.env.FACTORY_BEADS
  if (!snapshot) return
  // past 128 KB an env string is too long to exec the agent with
  delete process.env.FACTORY_BEADS
  const dir = join(own(), 'beads')
  const bin = join(own(), 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bd'), '#!/bin/sh\nexec factory worker bd "$@"\n')
  chmodSync(join(bin, 'bd'), 0o755)
  Object.assign(process.env, { BEADS_DIR: join(dir, '.beads'), PATH: `${bin}:${process.env.PATH}` })
  delete process.env.BEADS_DOLT_SHARED_SERVER
  if (existsSync(join(dir, '.beads'))) return
  mkdirSync(dir, { recursive: true })
  const file = join(own(), 'beads.jsonl')
  writeFileSync(file, Bun.gunzipSync(Buffer.from(snapshot, 'base64')))
  const real = process.env.FACTORY_BD ?? '/usr/local/bin/bd'
  for (const cmd of [
    ['git', 'init', '-q', '.'],
    [real, 'init', '--prefix', process.env.FACTORY_BEADS_PREFIX ?? 'bd', '-q', '--skip-agents'],
    [real, 'import', file],
  ]) {
    const r = sh(cmd, dir)
    if (!r.ok) throw new Error(`beads in the VM: ${cmd.join(' ')}: ${r.err}`)
  }
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
  joinEnv()
  if (process.env.FACTORY_CA) {
    const ca = join(own(), 'egress-ca.crt')
    writeFileSync(ca, process.env.FACTORY_CA)
    // the gateway re-signs every HTTPS host the VM may reach, so its CA is the only root needed
    Object.assign(process.env, { NODE_EXTRA_CA_CERTS: ca, GIT_SSL_CAINFO: ca, SSL_CERT_FILE: ca })
  }
  setupBeads()
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
    tail: lastTurn(s?.session),
  }
}

/** a Claude session's last assistant entry: the laptop reads a usage limit and the context size from it */
export function lastTurn(session?: string) {
  if (harness() !== 'claude' || !session) return undefined
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const file = join(dir, 'projects', repo().replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  if (!existsSync(file)) return undefined
  const size = statSync(file).size
  const buf = Buffer.alloc(Math.min(size, 512 * 1024))
  const fd = openSync(file, 'r')
  readSync(fd, buf, 0, buf.length, size - buf.length)
  closeSync(fd)
  return buf
    .toString()
    .split('\n')
    .findLast(l => l.includes('"type":"assistant"'))
}

export function prompt(base64: string) {
  mkdirSync(prompts(), { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  writeFileSync(join(prompts(), name), Buffer.from(base64, 'base64').toString())
}
