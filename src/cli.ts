// The factory runner: owns .factory/, drives herdr, feeds the xstate machines.
// Only `tick` writes run state (under a lock); every other command appends to
// the run's inbox.jsonl, which the next tick drains in order.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { createActor, type Snapshot } from 'xstate'
import {
  compile,
  extend,
  fill,
  isParked,
  WORKER_OUTCOMES,
  parkDelayMin,
  prsIn,
  reach,
  unread,
  validate,
  where,
  type Ctx,
  type Edge,
  type Entry,
  type Extension,
  type Ev,
  type Factory,
  type Mail,
} from './machine'
import {
  actorOf,
  backlogOf,
  beads,
  dispatchable,
  goalOf,
  hasBeads,
  isOwned,
  stationOf,
  type Bead,
} from './beads'
import { claudeCommand, command, harnessOf, readMcp, sq, writeLaunch } from './harness'
import { tokens, waiting } from './sidebar'
import * as devenv from './devenv'
import * as memory from './memory'
import * as ax from './ax'
import type { Egress } from './ax'
import * as worker from './worker'
import * as pkggate from './pkggate'
import { DEFAULT_RUNNER, runnerOf, runners, type Job, type Runner, type WorkerInfo } from './runner'
import {
  createdAt,
  fate,
  metrics,
  render,
  renderTokens,
  sessionOf,
  type RunRecord,
  type Session,
} from './metrics'
import {
  asPrsFile,
  buildPrs,
  DEFAULT_BUDGET,
  forgeNote,
  forgeOf,
  gitlabForge,
  mrsIn,
  parseGitlabLabeled,
  parseRemote,
  sameFile,
  spawnGh,
  spawnGlab,
  type ForgeKind,
  type PrsFile,
  type RunMeta,
} from './prs'

const ROOT = resolve(import.meta.dir, '..')
/** a factory is a directory holding its rigs.json (Gas Town's town); its runs live there too */
const factoryAt = (dir: string): string | undefined =>
  existsSync(join(dir, 'rigs.json')) ? dir : dirname(dir) === dir ? undefined : factoryAt(dirname(dir))
// a session or `loop` started inside a factory's directory works that factory
// absolute, so a relative FACTORY_HOME (`FACTORY_HOME=.`) still matches pane cwds and survives a cd
const HOME = process.env.FACTORY_HOME
  ? resolve(process.env.FACTORY_HOME)
  : (factoryAt(process.cwd()) ?? join(ROOT, '.factory-state'))
/** where a repo keeps its own factories, versioned with its code */
const OWN = '.factory'
const CLI = join(ROOT, 'bin', 'factory')
// yolo: workers run unattended in their own worktree, so permission prompts would only stall them
const AGENT = `${claudeCommand()} --dangerously-skip-permissions`
const MAX_BUSY = Number(process.env.FACTORY_MAX_RUNS ?? 8)
const DISPATCH_MS = 30_000 // how often the rigs' ready beads are looked at
const SYNC_MS = 5 * 60_000 // how often each rig's beads sync with its Dolt remote
const LABELS_MS = 2 * 60_000 // how often the rigs' pull requests are checked for the labels below
// ponytail: pr-merger's default label names; make them a rig setting when a repo uses others
const CLOSE_LABEL = 'close'
const CONFLICT_LABEL = 'conflict'
const REWORK_LABEL = 'rework'
const REWORK_LABELS = [CONFLICT_LABEL, REWORK_LABEL]
const WATCH_MS = 5 * 60_000 // how often the pull requests parked stations wait on are looked at
/** what the factory's workers learned, shared by every run and groomed by the dream */
const MEMORY = join(HOME, 'memory')
const DREAM_MS = 24 * 3600_000
const HALT_GRACE_MS = 5 * 60_000 // how long stop waits for a working worker to commit and go quiet

/**
 * a graceful stop (`factory stop`): each working worker is told to commit and wait, its pane closes once
 * it is quiet or the grace is up, and the factory stays paused until `factory resume` brings each one back
 * in its own conversation. While halted nothing launches, nudges, times out, dispatches or dreams.
 */
type Halt = {
  state: 'stopping' | 'paused'
  at: number
  told: Record<string, number>
  closed: Record<string, number>
}
const haltFile = () => join(HOME, 'halt.json')
const resumeFile_ = () => join(HOME, 'resume.json')
const halted = (): Halt | null => (existsSync(haltFile()) ? readJson(haltFile()) : null)

/** what a stop does next to one working worker */
export function haltStep(isAlive: boolean, isTold: boolean, isWorking: boolean, sinceToldMs: number) {
  if (!isAlive) return 'gone'
  if (!isTold) return 'tell'
  return isWorking && sinceToldMs < HALT_GRACE_MS ? 'wait' : 'close'
}
const STOP_NOTE =
  '[factory] The factory is shutting down. Commit your work in progress now (a WIP commit is fine: say in its message what is left), then stop and wait. Do not report: you will be resumed in this conversation, and carry on from there.'
const DREAM_SOON_MS = 2 * 3600_000
const INBOX_FULL = 12
const HEARTBEAT_MS = 120_000 // well inside bd's claim lease (5 min)
const GRACE_MS = 90_000 // a worker idle this long without reporting gets nudged...
const STALL_MS = 20 * 60_000 // a working worker whose tail and branch head stand still this long is nudged, then failed
const NUDGES = 4 // ...this many times, each wait twice the last (90s to 24 min), then fails
// a worker whose Claude has not appeared this long after launch never started: the shell was still
// starting (direnv, under load) when herdr typed the command, and swallowed the Enter
const LAUNCH_MS = 90_000
const TIME_UP = 'minutes are up' // marks the deadline's warning among the factory's mail
const HANDOFF_ASK = "past the factory's limit" // marks the ask to hand off

export type Run = {
  id: string
  /** the factory this run follows, pinned into the run dir when it started */
  factory: string
  /** where that pinned copy came from */
  factoryFrom?: string
  repo: string
  goal: string
  ws: string
  worktree: string
  branch: string
  /** the commit the run branched from: what its stations committed is base..HEAD */
  base?: string
  forkedFrom?: string
  /** the bead this run works: its epic in the repo's beads tracker */
  bead?: string
}
type Saved = {
  cursor: number
  snapshot: Snapshot<unknown> & { value: unknown; context: Ctx }
  /** where bead bookkeeping was kept before it moved to track.json */
  track?: Track
}
/** bead bookkeeping, the beads pass's own file: journal entries mirrored, last heartbeat, whether the run's
 * end was recorded, and what last went wrong */
type Track = { mirrored: number; beatAt: number; isSettled: boolean; error?: string }
type Input = Ev extends infer E ? (E extends Ev ? Omit<E, 'at'> : never) : never
export type Row = {
  id: string
  factory?: string
  goal?: string
  node?: string
  sub?: string
  attempt?: number
  attempts?: number
  pane?: string | null
  agent?: string | null
  ws?: string
  error?: string | null
  last?: Entry
  gate?: { question: string; outcomes: string[] }
  bead?: string
  /** the rig whose repo the run works, when one is defined for it */
  rig?: string
  /** the stations of the last 40 reports, oldest first: the board draws the run's path from it */
  trail?: string[]
  /** when the current worker started, or when a timed wait ends */
  since?: number
  wakeAt?: number
  /** when its current station's box last got mail: a reply to what it asked */
  mailedAt?: number
  /** a rig row, not a run: the rig has room and nothing to start */
  idle?: string
  /** minutes its current worker has run */
  inMin?: number
  /** minutes since its worker's tail or branch head last changed */
  quietMin?: number
  /** when its runner's usage limit lifts, while the runner waits on it */
  limitUntil?: number
}

const runDir = (id: string) => join(HOME, 'runs', id)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'))
/** written and fsynced: a report or snapshot outlives a power cut, not just a crash */
function durable(path: string, text: string, flag: 'w' | 'a') {
  const fd = openSync(path, flag)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function writeJson(path: string, value: unknown) {
  durable(`${path}.tmp`, JSON.stringify(value, null, 2), 'w')
  renameSync(`${path}.tmp`, path) // atomic: a reader never sees half a snapshot
}
const fail = (msg: string): never => {
  throw new Error(msg)
}

/**
 * PKG_GATE_MIN_DAYS, parsed and validated: `Number('four')` is NaN, and NaN makes every age comparison in
 * pkggate's `decide()` false, which allows every version through -- fail closed here instead (claude-factory-ei0.10)
 */
export function parsePkgGateMinDays(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) fail(`PKG_GATE_MIN_DAYS "${raw}" is not a finite, non-negative number`)
  return n
}

/**
 * PKG_GATE_ALLOWLIST_GO / _NPM / _PYPI, one list per ecosystem: a single shared PKG_GATE_ALLOWLIST let an
 * entry meant for one ecosystem unlock the same spelling in the others, a typosquat surface
 * (claude-factory-ei0.22). The old PKG_GATE_ALLOWLIST is refused outright rather than reinterpreted, so a
 * deploy still carrying it fails loudly instead of its meaning silently changing underneath it.
 */
export function parsePkgGateAllowlist(env: Record<string, string | undefined>): pkggate.Allowlist | undefined {
  if (env.PKG_GATE_ALLOWLIST)
    fail(
      'PKG_GATE_ALLOWLIST no longer exists (one list covered go, npm and pypi alike, so an entry for one ' +
        'ecosystem unlocked the same name in the others). Set PKG_GATE_ALLOWLIST_GO / _NPM / _PYPI instead.',
    )
  const split = (raw: string | undefined) => (raw ? raw.split(':').filter(Boolean) : undefined)
  const go = split(env.PKG_GATE_ALLOWLIST_GO)
  const npm = split(env.PKG_GATE_ALLOWLIST_NPM)
  const pypi = split(env.PKG_GATE_ALLOWLIST_PYPI)
  return go || npm || pypi ? { ...(go && { go }), ...(npm && { npm }), ...(pypi && { pypi }) } : undefined
}

function herdr(...args: string[]) {
  // a leading space keeps the typed launch out of the person's shell history (zsh HIST_IGNORE_SPACE, atuin)
  if (args[0] === 'pane' && args[1] === 'run') args = [...args.slice(0, 3), ` ${args[3]}`, ...args.slice(4)]
  const p = Bun.spawnSync(['herdr', ...args])
  const out = p.stdout.toString().trim()
  if (p.exitCode !== 0) fail(`herdr ${args.slice(0, 2).join(' ')}: ${p.stderr.toString().trim() || out}`)
  return out.startsWith('{') ? JSON.parse(out).result : out
}

/**
 * types a worker's launch, resume or retype into its pane: never the command itself (its run ID,
 * paths and prompt can hold any 2-char sequence, including zsh-vi-mode's 'jk' insert-mode escape,
 * which cuts a typed line mid-command, claude-factory-r21). `cmd` goes to a script in the pane's own
 * FACTORY_HOME instead, and only the fixed LAUNCH_LINE that sources it is ever typed.
 */
function typeLaunch(pane: string, cmd: string) {
  herdr('pane', 'run', pane, writeLaunch(HOME, pane, cmd))
}

/** the pane's agent status and Claude session id, or null once the pane is gone */
function paneInfo(pane: string): { status: string; agent?: string; session?: string } | null {
  const p = Bun.spawnSync(['herdr', 'pane', 'get', pane])
  // herdr answers a missing pane on stderr
  const out = JSON.parse(p.stdout.toString() || p.stderr.toString() || '{}')
  if (out.error?.code === 'pane_not_found') return null
  if (p.exitCode !== 0) fail(`herdr pane get: ${out.error?.message ?? p.stderr.toString()}`)
  const info = out.result.pane
  return {
    status: info.agent_status,
    agent: info.agent,
    session: info.agent ? info.agent_session?.value : undefined,
  }
}

/** what the laptop keeps of a task it launched: whose worker it is, and whether its egress policy is in */
/** `put`: the files still to send the VM once its task runs (the brief, the beads copy), from `<run>/<task>.<name>` */
type TaskSide = {
  node: string
  seq: number
  egress?: ax.Egress[]
  /** the rig origin's host when it is GitLab, for the egress policy's rule */
  gitlabHost?: string
  policy: boolean
  put?: string[]
  /** when a put has been failing over ax ssh since, and its ax stderr; a success clears both */
  putFailedAt?: number
  putError?: string
  /** where the VM shares the rig's beads, as at its launch: absent, the repo's GitHub origin */
  beadsRemote?: Rig['beadsRemote']
}
const sideFile = (run: Run, task: string) => join(runDir(run.id), `${task}.json`)
/** how long a failing put is retried before the attempt fails: a VM still waking fails ssh for a tick or two */
const PUT_GRACE_MS = 5 * 60_000

const hashLine = (line: string) => createHash('sha256').update(line).digest('hex')
const seenFile = (run: Run, task: string) => join(runDir(run.id), `${task}.seen`)
/** how many times each outbox line (by content) has already been replayed here, and how many lines were
 * missing (edited away after replay) as of the last time that was told to the worker. Migrates a task still
 * on the old line-count `<task>.cursor` (absent `.seen`) by treating its first `min(cursor, len)` lines, as
 * polled right now, as already replayed -- the only cursor value that file ever held -- then stops touching
 * it; leaving it on disk is harmless (claude-factory-4x1) */
function loadSeen(run: Run, task: string, lines: string[]): { seen: Record<string, number>; missing: number } {
  const file = seenFile(run, task)
  if (existsSync(file)) return readJson(file)
  const legacy = join(runDir(run.id), `${task}.cursor`)
  const n = existsSync(legacy) ? Number(readFileSync(legacy, 'utf8')) : 0
  const seen: Record<string, number> = {}
  for (const line of lines.slice(0, Math.min(n, lines.length))) {
    const h = hashLine(line)
    seen[h] = (seen[h] ?? 0) + 1
  }
  const state = { seen, missing: 0 }
  writeJson(file, state)
  return state
}

/**
 * the factory command a VM worker's outbox line may run here, as its station: a report on its own attempt,
 * mail on its own run, memory add. null for anything else (decide, goto, start...): the VM's agent writes the
 * outbox, and it may be steered by what it read.
 */
export function replayable(
  argv: string[],
  side: { node: string; seq: number },
  run: string,
): string[] | null {
  const [cmd, id, seq] = argv
  if (cmd === 'report' && id === run && seq === String(side.seq)) return argv
  if (cmd === 'mail' && id === run) return argv
  if (cmd === 'memory' && id === 'add') {
    const rest = argv.slice(2).filter((w, i, a) => w !== '--from' && a[i - 1] !== '--from')
    return ['memory', 'add', ...rest, '--from', side.node]
  }
  return null
}

/** an outbox line's argv; null for a line that is not `{argv: string[]}`, which the VM may write */
export function outboxArgv(line: string): string[] | null {
  try {
    const { argv } = JSON.parse(line)
    return Array.isArray(argv) && argv.every(a => typeof a === 'string') ? argv : null
  } catch {
    return null
  }
}

/** where bd keeps a repo's store: its Dolt server and database (`bd dolt show --json`) */
type DoltConn = { host: string; port: number; database: string; user: string; tls: boolean }

/**
 * the command that moves a rig's beads to or from where its VMs share them: its beadsRemote, else the repo's
 * GitHub origin. A push or pull runs inside the laptop's Dolt server, which holds the remote's password, and
 * only SQL can tell it the user (`bd dolt push` pushes as the server's own). Through the dolt CLI, not
 * `bd sql`: bd drops the connection after 10 s, mid-fetch on a large store, and the merge never happens
 */
export function rigBeadsSync(r: Rig['beadsRemote'], way: 'push' | 'pull', conn?: DoltConn) {
  if (!r) return ['bd', 'dolt', way]
  if (![r.name, r.user].every(s => /^[\w.-]+$/.test(s))) fail(`beadsRemote name and user are [A-Za-z0-9_.-]`)
  if (!conn) return fail(`beads: bd shows no Dolt server for this repo`)
  const call = `CALL DOLT_${way.toUpperCase()}('--user', '${r.user}', '${r.name}', 'main')`
  return [
    ...['dolt', '--host', conn.host, '--port', String(conn.port), '--user', conn.user],
    ...(conn.tls ? [] : ['--no-tls']),
    ...['--use-db', conn.database, 'sql', '-r', 'json', '-q'],
    way === 'push' ? call : pullResolving(call),
  ]
}
/**
 * a pull that cannot stall the rig on a conflict: in one transaction the laptop's pending writes are committed,
 * the pull merges, and where the laptop and a VM changed the same row the VM's stands (it did the work it
 * reports on). The issues' conflicts are read first, so each overwritten issue can say what the laptop had
 */
const pullResolving = (call: string) =>
  [
    'SET @@autocommit = 0',
    "CALL DOLT_COMMIT('-Am', 'laptop beads before the pull', '--skip-empty')",
    call,
    'SELECT * FROM dolt_conflicts_issues',
    "CALL DOLT_CONFLICTS_RESOLVE('--theirs', '.')",
    "CALL DOLT_COMMIT('-Am', 'merge the beads VMs pushed, keeping theirs on a conflict', '--skip-empty')",
    'COMMIT',
  ].join('; ')

/** the comment for each issue whose laptop version a pull overwrote, from its conflict rows (`dolt sql -r json`) */
export function overwritten(out: string) {
  const rows = out
    .split('\n')
    .flatMap(l => (l.startsWith('{"rows"') ? (JSON.parse(l).rows as Record<string, unknown>[]) : []))
    .filter(row => 'our_diff_type' in row)
  return rows.map(row => {
    const id = String(row.our_id ?? row.their_id)
    const had = Object.keys(row)
      .filter(k => k.startsWith('our_') && k !== 'our_diff_type' && k !== 'our_id')
      .map(k => k.slice('our_'.length))
      .filter(k => String(row[`our_${k}`]) !== String(row[`their_${k}`]))
      .map(k => `${k}=${String(row[`our_${k}`]).slice(0, 200)}`)
    const what =
      row.our_diff_type === 'removed' ? 'had deleted it' : `had ${had.join(', ') || 'the same values'}`
    return {
      id,
      text: `[factory] The laptop and a VM both changed this issue; the VM's version was kept. The laptop ${what}.`,
    }
  })
}

function syncRigBeads(
  run: Pick<Run, 'repo' | 'worktree'>,
  way: 'push' | 'pull',
  r = rigOf(run.repo)?.beadsRemote,
) {
  const show = r ? Bun.spawnSync(['bd', 'dolt', 'show', '--json'], { cwd: run.worktree }) : null
  const conn = show?.exitCode === 0 ? (JSON.parse(show.stdout.toString()) as DoltConn) : undefined
  // the server's own user; its password, if it has one, as bd takes it
  const env = { ...process.env, DOLT_CLI_PASSWORD: process.env.BEADS_DOLT_PASSWORD ?? '' }
  const p = Bun.spawnSync(rigBeadsSync(r, way, conn), { cwd: run.worktree, env })
  // ponytail: only the issues table's conflicts are said on the issue; labels and the rest just take the VM's
  if (r && way === 'pull' && p.exitCode === 0)
    for (const { id, text } of overwritten(p.stdout.toString()))
      try {
        beads(run.repo, 'factory').comment(id, text)
      } catch {} // the issue the VM deleted: nothing to comment on
  return p
}

/** dispatch's sync for a rig whose remote needs its user: `bd sync` would pull and push as the server's own */
function syncAsRemoteUser(rig: Rig) {
  for (const way of ['pull', 'push'] as const) {
    const p = syncRigBeads({ repo: rig.repo, worktree: rig.repo }, way, rig.beadsRemote)
    if (p.exitCode !== 0)
      throw new Error(`beads ${way}: ${`${p.stderr}`.trim().split('\n').at(-1) || 'failed'}`)
  }
}

/**
 * an AX worker's status, after replaying here the commands its outbox holds since the last look; a pending
 * or suspended task is not polled, and a failed or deleted one is gone, like a closed pane
 */
function taskInfo(run: Run, pane: string): WorkerInfo | null {
  const task = ax.taskOf(pane)
  const phase = ax.phase(task)
  // `agent` set: the VM's agent is always there, so the reconciler never relaunches or restarts it as a pane's
  if (phase === 'Pending' || phase === 'Suspended') return { status: phase.toLowerCase(), agent: 'ax' }
  // gone, and why, kept next to the task's other files; `failed` carries it into the attempt's FAIL reason
  // (task .2's reconciler check) instead of the generic "worker pane ... was closed"
  const gone = (why: string): WorkerInfo => (
    writeFileSync(join(runDir(run.id), `${task}.gone`), `${new Date().toISOString()} ${why}\n`),
    { status: 'gone', failed: clip(why, 500) }
  )
  if (phase !== 'Running') return gone(`phase ${phase ?? 'not found'}`)
  // a task this laptop did not launch (or launched before this file) has no station to act as: nothing replays
  const side: TaskSide | null = existsSync(sideFile(run, task)) ? readJson(sideFile(run, task)) : null
  if (side && !side.policy) {
    // until it is in, the VM reaches nothing; the station's deadline fails a task whose actor never shows
    if (!ax.createPolicy(task, side.egress, side.gitlabHost)) return { status: 'pending', agent: 'ax' }
    writeJson(sideFile(run, task), { ...side, policy: true })
  }
  // what is too big for the task's env goes over ssh, in parts, and serve waits for it
  for (const name of side?.put ?? []) {
    const b64 = readFileSync(join(runDir(run.id), `${task}.${name}`)).toString('base64')
    const parts = Math.max(1, Math.ceil(b64.length / ax.PUT_PART))
    for (let i = 0; i < parts; i++) {
      const r = ax.put(task, name, i, parts, b64.slice(i * ax.PUT_PART, (i + 1) * ax.PUT_PART))
      if (r.ok) continue
      // a VM still waking fails ssh too: this stays pending until the failure is PUT_GRACE_MS old
      const failedAt = side!.putFailedAt ?? Date.now()
      const err = clip(r.err.replace(/\s+/g, ' ').trim(), 300)
      writeJson(sideFile(run, task), { ...side, putFailedAt: failedAt, putError: err })
      if (Date.now() - failedAt < PUT_GRACE_MS) return { status: 'pending', agent: 'ax' }
      return {
        status: 'failed',
        agent: 'ax',
        failed: `factory worker put ${name} failed for 5 min over ax ssh: ${err}`,
      }
    }
    side!.put = side!.put!.filter(n => n !== name)
    side!.putFailedAt = undefined
    side!.putError = undefined
    writeJson(sideFile(run, task), side)
  }
  // always ask for everything: which lines are already replayed lives here, keyed by content (see `loadSeen`
  // below), not as a line count the VM slices by -- a worker that edits outbox.jsonl (claude-factory-4x1)
  // would otherwise push later real lines below a stale count and hide them forever
  const polled = ax.poll(task, 0)
  const seen = loadSeen(run, task, polled.lines)
  const occurs: Record<string, number> = {}
  for (const line of polled.lines) {
    const h = hashLine(line)
    occurs[h] = (occurs[h] ?? 0) + 1
    if (occurs[h] <= (seen.seen[h] ?? 0)) continue // this occurrence of this line already replayed
    const argv = outboxArgv(line)
    const cmd = side && argv && replayable(argv, side, run.id)
    // FACTORY_OUTBOX off: here the command must act, not queue itself again; the sender is the station
    const env = { ...process.env, FACTORY_HOME: HOME, FACTORY_OUTBOX: '', FACTORY_FROM: side?.node }
    const p = cmd ? Bun.spawnSync([CLI, ...cmd], { env }) : null
    if (!p)
      ax.prompt(
        task,
        `[factory] \`${argv?.join(' ') ?? line.slice(0, 200)}\` is not yours to run: a worker reports on its own attempt, mails and adds memory`,
      )
    else if (p.exitCode !== 0)
      ax.prompt(task, `[factory] \`${argv!.join(' ')}\` was refused: ${p.stderr.toString().trim()}`)
    // the worker pushed before reporting, and the local worktree is what the next launch pushes back:
    // best effort, the report stands either way
    // the same for its bd writes, which it pushed where the rig's VMs share its beads
    else if (argv![0] === 'report') {
      Bun.spawnSync(['git', '-C', run.worktree, 'pull', '--ff-only', 'origin', run.branch])
      // from where this VM was told to push, which a rig changed since does not move
      if (run.bead) syncRigBeads(run, 'pull', side?.beadsRemote)
    }
    seen.seen[h] = (seen.seen[h] ?? 0) + 1
    writeJson(seenFile(run, task), seen)
  }
  // a line this laptop already counted as replayed, now missing from the outbox: the worker edited it after
  // the fact (claude-factory-4x1). Told once per increase, not every tick the edit stays
  let missing = 0
  let consumed = 0
  for (const [h, n] of Object.entries(seen.seen)) {
    consumed += n
    missing += Math.max(0, n - (occurs[h] ?? 0))
  }
  if (missing > seen.missing) {
    appendFileSync(
      join(runDir(run.id), `${task}.outbox-edited`),
      `${new Date().toISOString()} missing ${missing} of ${consumed} consumed lines\n`,
    )
    ax.prompt(
      task,
      `[factory] outbox.jsonl is append-only: nothing already written to it may be edited or deleted, even to retract a probe`,
    )
    seen.missing = missing
    writeJson(seenFile(run, task), seen)
  }
  return polled.status === 'exited'
    ? gone(`serve exited; its log: ${polled.log || '(empty)'}`)
    : {
        status: polled.status,
        agent: 'ax',
        session: polled.session,
        tail: polled.tail,
        head: polled.head,
        bytes: polled.bytes,
        egress: polled.egress,
      }
}

const herdrRunner: Runner = {
  name: 'herdr',
  local: true,
  launch: launchPane,
  info: (_run, pane) => paneInfo(pane),
  deliver: (pane, text) => (herdr('agent', 'prompt', pane, text), true),
  close: pane => void Bun.spawnSync(['herdr', 'pane', 'close', pane]), // gone already is fine
  phase: pane => paneInfo(pane)?.status ?? null,
}

const axRunner: Runner = {
  name: 'ax',
  local: false,
  launch: launchTask,
  info: taskInfo,
  /** a suspended task is woken, and the prompt waits for the next tick */
  deliver(address, text) {
    const task = ax.taskOf(address)
    if (ax.phase(task) !== 'Running') return (ax.resume(task), false)
    ax.prompt(task, text.replaceAll(CLI, 'factory'))
    return true
  },
  close: address => ax.remove(ax.taskOf(address)),
  // waiting on the manager costs nothing: the VM is snapshotted until the answer wakes it
  suspend: address => ax.suspend(ax.taskOf(address)),
  phase: address => ax.phase(ax.taskOf(address))?.toLowerCase() ?? null,
}
Object.assign(runners, { herdr: herdrRunner, ax: axRunner })

/**
 * commits on the run's base that name its bead: a quarter of triage's rejects were beads already fixed by a
 * commit naming them. ponytail: handed to the worker, not a skip, as a third of hits are partial earlier work
 */
function priorWork(run: Run) {
  if (!run.bead || !run.base) return ''
  // commits name a bead by its short id too, with or without a prefix: infra-blocks-4t9a, ib-4t9a, (4t9a)
  const short = run.bead.slice(run.bead.lastIndexOf('-') + 1).replaceAll('.', '\\.')
  const grep = `--grep=(^|[^a-z0-9.])([a-z]+-)*${short}([^a-z0-9.]|$)`
  // not git(): a missing base must not stop the worker's launch
  const p = Bun.spawnSync([
    'git',
    '-C',
    run.worktree,
    'log',
    run.base,
    '-n',
    '10',
    '--format=%h %s',
    '-E',
    grep,
  ])
  return p.exitCode === 0 ? p.stdout.toString().trim() : ''
}

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args])
  return p.exitCode === 0 ? p.stdout.toString().trim() : fail(`git ${args[0]}: ${p.stderr.toString().trim()}`)
}

/**
 * the factory a new run follows: a path as given; else the repo's own `.factory/<name>.ts` in `checkout`
 * (the run's worktree, so the version in the commit it starts from); else the template of that name
 */
/** a factory is a module (default export) or data: JSON, YAML or TOML, in that order of precedence after .ts */
const FACTORY_EXTS = ['.ts', '.json', '.yaml', '.yml', '.toml']
const findIn = (dir: string, spec: string, except?: string) =>
  FACTORY_EXTS.map(ext => join(dir, `${spec}${ext}`)).find(f => f !== except && existsSync(f))
function factorySource(spec: string, checkout: string) {
  if (existsSync(spec)) return resolve(spec)
  return (
    findIn(join(checkout, OWN), spec) ??
    findIn(join(ROOT, 'factories'), spec) ??
    join(ROOT, 'factories', `${spec}.ts`)
  )
}
/** what `extends` names, from the extending file's directory: a path, a sibling, else a built-in; never itself */
function baseSource(spec: string, file: string) {
  const at = resolve(dirname(file), spec)
  if (at !== file && existsSync(at)) return at
  return (
    findIn(dirname(file), spec, file) ??
    findIn(join(ROOT, 'factories'), spec, file) ??
    fail(`extends "${spec}": no such factory`)
  )
}
async function readFactory(file: string, seen: string[] = []): Promise<Factory> {
  const text = () => readFileSync(file, 'utf8')
  const ext = extname(file)
  const raw =
    ext === '.ts'
      ? (await import(file)).default
      : ext === '.json'
        ? JSON.parse(text())
        : ext === '.toml'
          ? Bun.TOML.parse(text())
          : Bun.YAML.parse(text())
  if (!raw?.extends) return raw
  if (seen.includes(file)) throw new Error(`extends loops: ${[...seen, file].join(' → ')}`)
  const { extends: spec, ...rest } = raw as Extension
  return extend(await readFactory(baseSource(spec, file), [...seen, file]), rest)
}

/** a template made the repo's own: no import back into this project, and a note on how it is changed */
export function ownCopy(template: string, name: string) {
  const body = template
    .replace(/^import type \{ Factory \} from '[^']*'\n+/m, '')
    .replace(/\}\s*satisfies Factory\s*$/, '}\n')
  return (
    `// This repo's own factory, from claude-factory's "${name}" template (factory adopt).\n` +
    `// A run follows the version in the commit it starts from, so change it like code: in a run or a\n` +
    `// commit, checked with \`factory check ${OWN}/${name}.ts\`. The improve sweep proposes changes to it.\n\n` +
    body
  )
}

/**
 * what a new run branches from: the remote's default branch when it already holds everything local
 * (fetched, so merged work, factory changes included, reaches new runs); local HEAD otherwise
 */
function freshBase(repo: string) {
  const head = git(repo, 'rev-parse', 'HEAD')
  const remote = Bun.spawnSync(['git', '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (remote.exitCode !== 0) return head
  const ref = remote.stdout.toString().trim()
  Bun.spawnSync(['git', '-C', repo, 'fetch', '--quiet', 'origin'], { timeout: 30_000 }) // offline: what we have
  const isBehind = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', head, ref]).exitCode === 0
  return isBehind ? git(repo, 'rev-parse', ref) : head
}
export const loadFactory = async (file: string): Promise<Factory> => {
  const def = validate(await readFactory(file))
  const unknown = Object.entries(def.nodes).filter(([, n]) => n.runner && !(n.runner in runners))
  if (unknown.length)
    throw new Error(
      `factory ${def.name}:\n  ${unknown.map(([id, n]) => `${id}: runner "${n.runner}" is not ${Object.keys(runners).join(' or ')}`).join('\n  ')}`,
    )
  return def
}
// a run moved to another factory leaves a link behind, so its workers' reports still reach it:
// only the factory holding the run's directory ticks and lists it
const runIds = () =>
  existsSync(join(HOME, 'runs'))
    ? readdirSync(join(HOME, 'runs'), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
    : []
function loadRun(id: string | undefined): Run {
  const file = join(runDir(id ?? ''), 'run.json')
  return existsSync(file) ? readJson(file) : fail(`no run "${id}" (runs: ${runIds().join(', ') || 'none'})`)
}
/** complete lines only: a writer may be mid-append */
const inboxLines = (id: string) => {
  const file = join(runDir(id), 'inbox.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1) : []
}
const post = (id: string, e: Input) =>
  durable(join(runDir(id), 'inbox.jsonl'), JSON.stringify({ ...e, at: Date.now() }) + '\n', 'a')

const edgeText = (e: Edge) => (typeof e === 'string' ? e : `${e.to} after ${e.delayMin} min`)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function brief(run: Run, def: Factory, node: string, c: Ctx, inbox: Mail[]) {
  const n = def.nodes[node]!
  const lastFail = c.attempt > 1 ? c.log.findLast(e => e.node === node && e.outcome === 'fail') : undefined
  const parked = isParked(c, node) ? c.log.at(-1) : undefined
  const handedOff =
    c.log.at(-1)?.node === node && c.log.at(-1)?.outcome === 'handoff' ? c.log.at(-1) : undefined
  // a fresh worker is told what earlier ones already committed, so it builds on it rather than redoing it
  const committed = run.base ? git(run.worktree, 'log', '--oneline', '-n', '30', `${run.base}..HEAD`) : ''
  const prior = node === def.start ? priorWork(run) : ''
  const origin = originRef(run.repo)
  return [
    `You are the "${node}" station of the software factory "${def.name}" (run ${run.id}, attempt ${c.attempt} of ${1 + (n.retries ?? 2)}).`,
    `You work in the git worktree ${run.worktree} on branch ${run.branch}. Commit your work there and touch no other checkout.`,
    `This run follows the factory pinned when it started (${run.factoryFrom ?? run.factory}): changes to ${OWN}/ on any branch reach only runs that start after they merge. Check an edited factory file with ${CLI} check <file>.`,
    ...(def.rules ? ['', '## House rules', def.rules.trim()] : []),
    '',
    ...remembered(run, node),
    ...forgeNote(origin?.forge === 'gitlab' ? origin.host : undefined),
    '',
    '## Goal',
    run.goal,
    '',
    '## Your task',
    n.prompt.trim(),
    // the journal is the run's memory: every station's report, so a plan or a baseline reaches every later station
    ...(c.log.length
      ? [
          '',
          '## Run journal (what each station reported, oldest first)',
          ...c.log
            .slice(-25)
            .map(e =>
              inbox.some(m => m.from === e.node && m.at === e.at)
                ? `- ${e.node}#${e.attempt} ${e.outcome}: in full in your Inbox below`
                : `- ${e.node}#${e.attempt} ${e.outcome}: ${clip(e.summary, 1500)}`,
            ),
        ]
      : []),
    ...(lastFail ? ['', '## The previous attempt failed', lastFail.summary] : []),
    ...(handedOff
      ? [
          '',
          '## You take over from a worker that handed off',
          'Its context grew too long, so it stopped and left you these notes. Its commits are on the branch; check git status for anything it left uncommitted, and carry on from where it stopped.',
          handedOff.summary,
        ]
      : []),
    ...(parked
      ? [
          '',
          '## The previous worker was blocked',
          parked.summary,
          'Check whether that still holds before anything else; if it does, report blocked again.',
        ]
      : []),
    ...(prior
      ? [
          '',
          '## Commits already on the default branch that name this bead',
          prior,
          'Check whether they already do what the goal asks before planning anything new: some are only part of it.',
        ]
      : []),
    ...(committed
      ? ['', '## Already committed on this branch (build on it, do not redo it)', committed]
      : []),
    ...(inbox.length ? ['', '## Inbox', ...inbox.map(m => `- from ${m.from}: ${m.text}`)] : []),
    '',
    '## Reporting (required)',
    'When you are finished, report exactly once and then stop:',
    `    ${CLI} report ${run.id} ${c.seq} <outcome> "<summary for the next station>"`,
    'Outcomes:',
    ...Object.entries(n.next).map(([outcome, edge]) => `- ${outcome}: goes to ${edgeText(edge)}`),
    '- fail: you cannot do it; a fresh worker retries',
    `- blocked: you are waiting on something outside this run (a person's decision, a human review or merge, another run): say exactly what, with the link of each pull request it waits on. The run parks without using an attempt, and a fresh worker checks again in ${n.parkMin ?? 60} min or as soon as this station is mailed; one named pull request changing (merged, closed, reviewed, commented on, pushed to) mails it. When it waits on a person's decision or direction, end the summary with a line \`Question: <the one question they must answer>\` and, when there are a few clear choices, a line \`Options: <first> | <second> | <third>\`, the one you recommend first: the person answers it in the console's Interview tab, and the answer arrives in this station's inbox.`,
    // workers idled on a background bazel or CI watch, ended their turn, and were failed as lost
    "Do not end your turn to wait on a background build, test or CI watch: wait for it in the foreground. If a wait will outlast this station's time, commit and report (blocked when it waits on CI or a merge) instead.",
    `To ask the manager, run \`${CLI} mail ${run.id} manager "<question>"\` and wait: replies arrive as [factory mail] messages, and you are not nudged while a question is open.`,
    '',
    ...tracking(run, node),
  ].join('\n')
}

/** the memory's top two levels, and how to reach the third: search before, add what was learned */
function remembered(run: Run, node: string) {
  const rig = rigOf(run.repo)?.name
  const { core, topics } = memory.outline(MEMORY, rig)
  return [
    '## Factory memory',
    `What this factory's workers learned before you, in ${MEMORY}.`,
    ...(core ? [core] : []),
    ...(topics.length ? ['Topics (search finds their notes):', ...topics] : []),
    `- Before you start, search it for what you are about to do: ${CLI} memory search${rig ? ` --rig ${rig}` : ''} "<query>". It prints the closest notes in full.`,
    `- When you learn what a later worker would otherwise relearn the hard way (a command that works, a trap, an unwritten convention, why something failed), save it: ${CLI} memory add --from ${run.id}/${node}${rig ? ` [--rig ${rig}]` : ''} "<one-line summary>" "<what, why, how you know>"${rig ? ` (--rig when it holds only in ${rig})` : ''}. Only what is verified, reusable and not obvious, at most three per station; when a note proved wrong, add one saying so. A lesson that holds only while a bead is open names it ("until <bead> closes"). What one bead's status is (already fixed, a duplicate) goes in its bd comments, not here.`,
    `- When a note saved you time or a mistake, say so: ${CLI} memory helped <note path>. That is how the most useful notes rise to the top of what later workers read.`,
  ]
}

/** how a worker records tasks and files separate work: beads when the repo has them */
function tracking(run: Run, node: string) {
  const b = run.bead
  if (!b)
    return [
      '## Tracking',
      "This repo has no beads tracker: keep the run's tasks as a checklist in your report summary.",
      `- Separate work that starts on its own: check \`${CLI} status\` for a duplicate, then ${CLI} start ${run.factory}[@station] ${run.repo} "<goal>" (@station starts it at that station)`,
      `- Separate work for a person to prioritize: mail it to the manager.`,
    ]
  return [
    '## Tracking (beads)',
    `This run is bead ${b} (bd show ${b}); its tasks are the bead's children. Your bd writes are recorded as ${actorOf(run.id)}/${node}.`,
    `- The plan's tasks: bd children ${b}; the unblocked ones: bd ready --parent ${b}`,
    `- Add a task: bd create "<title>" --parent ${b} -t task|bug -p <0-4> -d "<what, and how to verify it>"; order two with bd dep <first> --blocks <second>`,
    `- Work a task: bd update <id> -s in_progress, then bd close <id> --reason "<what changed, the commit>"`,
    `- Separate work outside this run: look for it first (bd search "<words>"), then bd create "<title>" -t bug|task|feature -p <0-4> -d "<evidence>" --deps discovered-from:${b}`,
    `  - that starts on its own: add -l factory; for a person to prioritize: no factory label`,
    `  - to start at a station: add -l station:<name>`,
    `- Never close or defer ${b} itself: the factory does when the run ends.`,
    // a fabriek verify worker's bd init held the shared server's lock for minutes, stalling every repo's bd
    ...(process.env.BEADS_DOLT_SHARED_SERVER === '1'
      ? [
          `- bd here shares one Dolt server with every repo on this machine, and bd init, migrations and other server-wide operations lock all of them for minutes. For a scratch database (a test, an experiment) use BEADS_DOLT_SHARED_SERVER=0 bd init in a temporary directory, unless the task is about the shared server itself.`,
        ]
      : []),
  ]
}

const resumeNote = (run: Run, node: string, c: Ctx) =>
  `[factory] Your pane closed and this session was resumed. Carry on as the "${node}" station where you left off: ` +
  `check git status and git log first. When finished, report exactly once: ${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`

/** where a station's workers run: the station's own runner, else the rig's */
const runnerOfStation = (run: Run, def: Factory, node: string) =>
  runners[def.nodes[node]?.runner ?? rigOf(run.repo)?.runner ?? DEFAULT_RUNNER] ?? runners[DEFAULT_RUNNER]!

/** a worker for a station, wherever the rig runs them; given a session, it resumes that conversation */
function spawn(run: Run, def: Factory, node: string, c: Ctx, session?: string) {
  const file = session ? resumeFile(run, node, c) : promptOf(run, node, c)
  const full = () => brief(run, def, node, c, c.mail[node] ?? [])
  if (!session) writeFileSync(file, full())
  return runnerOfStation(run, def, node).launch({ run, def, node, c, session, file, brief: full })
}

/** a worker in a new tab of the run's workspace; given a session, it resumes that conversation */
function launchPane({ run, def, node, c, session, file }: Job) {
  const tab = () =>
    herdr(
      ...['tab', 'create', '--workspace', run.ws, '--cwd', run.worktree],
      ...['--label', `${node}#${c.attempt}`, '--no-focus'],
      ...['--env', `FACTORY_FROM=${node}`, '--env', `FACTORY_HOME=${HOME}`],
      ...['--env', `BEADS_ACTOR=${actorOf(run.id)}/${node}`],
    )
  let created
  try {
    created = tab()
  } catch {
    // the person closed the run's workspace: reopen the worktree and carry on
    const opened = herdr(
      'worktree',
      'open',
      '--cwd',
      run.repo,
      '--branch',
      run.branch,
      '--no-focus',
      '--json',
    )
    run.ws = opened.workspace.workspace_id
    writeJson(join(runDir(run.id), 'run.json'), run)
    created = tab()
  }
  const pane: string = created.root_pane.pane_id
  typeLaunch(pane, launch(run, def, node, file, session))
  return pane
}

/** an https remote a VM can clone: the egress gateway puts GitHub's credential in, and the VM has no ssh key */
export const httpsRemote = (url: string) => url.replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$1/')

/**
 * a worker in an AX task on the cluster: the run's branch, pushed, is its workspace. Its brief names the CLI
 * and the worktree as the VM sees them, and FACTORY_AX_ENV (a JSON file) adds to its env.
 */
function launchTask({ run, def, node, c, brief: text }: Job) {
  const image =
    process.env.FACTORY_AX_IMAGE ?? fail('FACTORY_AX_IMAGE is not set: the worker image for AX tasks')
  const rig = rigOf(run.repo)
  const agent = agentOfNode(run, def, node)
  const harness = harnessOf(agent)
  if (!harness) fail(`the ax runner runs claude, codex or pi workers, not "${agent}"`)
  // a worker that pushed and never reported (its VM went, its time ran out) left the branch ahead of the
  // worktree, or rewrote it (rebased onto main), and pushing the worktree back would be refused every tick: the
  // next attempt starts from its commits. A rebase drops what the worker already has; one that stops is undone
  const pull = Bun.spawnSync([
    'git',
    '-C',
    run.worktree,
    'pull',
    '--rebase',
    '--autostash',
    'origin',
    run.branch,
  ])
  if (pull.exitCode !== 0) Bun.spawnSync(['git', '-C', run.worktree, 'rebase', '--abort'])
  // what of the stash would not go back on (bd's export, which both sides rewrote) takes the worker's version;
  // the stash stays in git stash list
  const unmerged = Bun.spawnSync(['git', '-C', run.worktree, 'diff', '--name-only', '--diff-filter=U'])
    .stdout.toString()
    .trim()
  if (unmerged) Bun.spawnSync(['git', '-C', run.worktree, 'checkout', 'HEAD', '--', ...unmerged.split('\n')])
  git(run.worktree, 'push', 'origin', `HEAD:refs/heads/${run.branch}`)
  const env = process.env.FACTORY_AX_ENV ? readJson<Record<string, string>>(process.env.FACTORY_AX_ENV) : {}
  const name = ax.taskName(run.id, c.seq)
  const origin = originRef(run.repo)
  const gitlabHost = origin?.forge === 'gitlab' ? origin.host : undefined
  const brief = [
    text().replaceAll(CLI, 'factory').replaceAll(run.worktree, ax.REPO),
    `- You run in a VM: push your commits to origin ${run.branch} before you report, or the factory never sees them.`,
    `- Run tests the way the repo does (its make or devenv targets, not a bare go test): those set up what tests need, such as envtest's KUBEBUILDER_ASSETS.`,
    ...(rig?.env?.FACTORY_NIX_CACHE && existsSync(join(run.worktree, 'devenv.nix'))
      ? [
          `- The repo's devenv.nix environment is loaded for you when its cache holds it (then DEVENV_ROOT is set): its tools are on PATH and its variables set, so use them directly. Do not run devenv shell or devenv test, whose enterShell runs the repo's git hooks for minutes; without DEVENV_ROOT, use nix shell as below.`,
        ]
      : []),
    ...(rig?.env?.FACTORY_KUBE_SERVER
      ? [
          `- kubectl reaches the live cluster read-only (its kubeconfig is set up, its token added on the way out): get, describe and logs work; secrets, exec and any change are refused, so a cluster change goes through the repo.`,
        ]
      : []),
    `- A tool you lack (go, make, kubectl, gcc...): nix shell nixpkgs#<pkg> ... -c <command>, or the repo's own nix develop. The VM reaches only the hosts it needs (the model's API, GitHub, the Nix cache and what the rig adds): a download elsewhere fails, so ask the manager instead of working around it.`,
    ...(run.bead
      ? [
          `- bd here is the repo's issue store, cloned when you started from where the factory shares it. \`factory report\` pushes your bd changes back before it reports; to share them sooner (or to see others' since), bd dolt pull && bd dolt push.`,
        ]
      : []),
  ].join('\n')
  const hasRunBeads = !!run.bead && hasBeads(run.repo)
  // Substrate takes no env value past 32 KiB, and a brief with its bead's spec can pass that: it goes over
  // ssh once the task runs (see taskInfo). The VM clones the rig's beads itself (FACTORY_BEADS), from its
  // beadsRemote or else the repo's GitHub origin
  writeFileSync(join(runDir(run.id), `${name}.brief.md`), brief)
  // what the laptop wrote since its last push (this run's plan, say) must be shared before the VM clones
  // the fleet may hold other VMs' writes since: take them first, or the push is refused
  if (hasRunBeads) (syncRigBeads(run, 'pull'), syncRigBeads(run, 'push'))
  const address = ax.launch({
    name,
    repo: httpsRemote(git(run.worktree, 'remote', 'get-url', 'origin')),
    branch: run.branch,
    image,
    model: ax.modelOf(agent),
    harness: harness!,
    provider: ax.providerOf(agent),
    claudeFlags: harness === 'claude' ? vmClaudeFlags(def) : undefined,
    gitlabHost,
    env: {
      ...env,
      ...rig?.env,
      FACTORY_FROM: node,
      BEADS_ACTOR: `${actorOf(run.id)}/${node}`,
      FACTORY_HOME: `${ax.OWN}/home`,
      // each agent's config and sessions on the workspace volume, so a session survives a suspend
      CLAUDE_CONFIG_DIR: `${ax.OWN}/claude`,
      CODEX_HOME: `${ax.OWN}/codex`,
      PI_CODING_AGENT_DIR: `${ax.OWN}/pi-agent`,
      ...(hasRunBeads && { FACTORY_BEADS: '1' }),
      ...(hasRunBeads &&
        rig?.beadsRemote && {
          FACTORY_BEADS_REMOTE: rig.beadsRemote.url,
          DOLT_REMOTE_USER: rig.beadsRemote.user,
        }),
    },
  })
  const side: TaskSide = {
    node,
    seq: c.seq,
    egress: rig?.egress,
    ...(gitlabHost && { gitlabHost }),
    policy: ax.createPolicy(name, rig?.egress, gitlabHost),
    put: ['brief.md'],
    ...(hasRunBeads && rig?.beadsRemote && { beadsRemote: rig.beadsRemote }),
  }
  writeJson(sideFile(run, name), side)
  return address
}

/**
 * the part of `workerFlags` that holds in a VM: worker system prompt, no auto memory, a compaction backstop.
 * It also keeps the same tools; it skips the laptop's own settings and project-level mods.
 * Left out, as they are the laptop's: the user's hooks and env, its plugin dirs, its global `CLAUDE.md`.
 * So a VM worker gets no `asd-ste100` plugin and no STE env either; `claude-factory-fxu` tracks that gap.
 * `disableBundledSkills` keeps `Skill`'s bundled-skill listing off, since the VM has no skill worth it yet.
 */
export function vmClaudeFlags(def: Pick<Factory, 'maxContextK'>) {
  if (process.env.FACTORY_LEAN === '0') return []
  const settings = {
    autoMemoryEnabled: false,
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    skipDangerousModePermissionPrompt: true,
    autoCompactWindow: Math.max(100, 2 * (def.maxContextK ?? 200)) * 1000,
    disableBundledSkills: true,
  }
  return [
    ...['--tools', WORKER_TOOLS, '--setting-sources', 'project,local'],
    ...['--settings', JSON.stringify(settings)],
    ...['--system-prompt-file', `${ax.FACTORY_DIR}/src/worker-system.md`],
  ]
}

/** the note a resumed worker is sent, written where its launch reads it */
function resumeFile(run: Run, node: string, c: Ctx) {
  const file = promptOf(run, node, c).replace(/\.md$/, '-resume.md')
  writeFileSync(file, resumeNote(run, node, c))
  return file
}
/** a factory's params: its defaults, under FACTORY_<NAME>, under the rig's own --param */
export const paramsOf = (def: Pick<Factory, 'params'>, rig?: Pick<Rig, 'params'>, env = process.env) =>
  Object.fromEntries(
    Object.entries(def.params ?? {}).map(([k, v]) => [
      k,
      rig?.params?.[k] ?? (env[`FACTORY_${k.toUpperCase()}`]?.trim() || v),
    ]),
  )
/** the worker command: the rig's own (one harness for all its stations) over the station's and the factory's */
const agentOfNode = (run: Run, def: Factory, node: string) => {
  const rig = rigOf(run.repo)
  return fill(rig?.agent ?? def.nodes[node]!.agent ?? def.agent ?? AGENT, paramsOf(def, rig))
}
const promptOf = (run: Run, node: string, c: Ctx) => join(runDir(run.id), 'prompts', `${c.seq}-${node}.md`)
/** the context of the last turn in a Claude transcript's tail, in tokens; 0 when it has none */
export function lastContext(tail: string) {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"usage"')) continue
    try {
      const u = JSON.parse(line)?.message?.usage
      if (u)
        return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    } catch {
      // the first line of the tail is cut
    }
  }
  return 0
}
/** the end of a Claude worker's session transcript; empty when there is none */
function tailOf(worktree: string, session: string) {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const file = join(dir, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  try {
    const size = statSync(file).size
    const buf = Buffer.alloc(Math.min(size, 512 * 1024))
    const fd = openSync(file, 'r')
    readSync(fd, buf, 0, buf.length, size - buf.length)
    closeSync(fd)
    return buf.toString()
  } catch {
    return ''
  }
}

/** the usage limit that refused a Claude transcript's last turn: when, which (seven_day, five_hour) and when it resets, in ms */
export function limitHit(tail: string) {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'assistant') continue
      if (e.error !== 'rate_limit' || e.quotaLimits?.status !== 'rejected') return null
      const kind: string = e.quotaLimits.rateLimitType ?? 'usage'
      return { at: Date.parse(e.timestamp), kind, resetsAt: (e.quotaLimits.resetsAt ?? 0) * 1000 }
    } catch {
      // the first line of the tail is cut
    }
  }
  return null
}

/** when a Claude transcript's last turn was answered, not refused for a usage limit; 0 when it was not */
export function servedAt(tail: string) {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'assistant') return e.error ? 0 : Date.parse(e.timestamp)
    } catch {
      // the first line of the tail is cut
    }
  }
  return 0
}

/** the account to move to: the next in ccswitch's sequence after the active one (itself last) whose limit has reset */
export function nextAccount(sequence: string[], active: string, limits: Record<string, number>, now: number) {
  const i = sequence.indexOf(active)
  return (
    [...sequence.slice(i + 1), ...sequence.slice(0, Math.max(0, i)), active].find(
      a => (limits[a] ?? 0) <= now,
    ) ?? null
  )
}

/**
 * Workers run on the user's active Claude account. When one hits that account's usage limit, ccswitch
 * moves every Claude on this machine to the next account whose limit has reset, and the worker restarts
 * on it; a hit from before the last move only restarts. With every account at its limit, workers wait
 * for the first reset. Returns that wait's end, or 0 to restart now
 */
// shared by every factory on the machine, as the account is: one factory's swap is not another's to redo
const LIMITS = join(homedir(), '.claude-switch-backup', 'factory-limits.json')
type Limits = { at: number; limits: Record<string, number>; hitAt?: Record<string, number> }

/**
 * A turn the active account answered after its limit was recorded means the limit is gone (reset early, or
 * a plan change): forget it, or a stale limit would hold every worker when the other accounts are limited too
 */
export function clearLimit(at: number) {
  if (!at || !existsSync(LIMITS)) return
  const s = readJson<Limits>(LIMITS)
  let active: string
  try {
    active = readJson<{ activeAccountId: string }>(
      join(homedir(), '.claude-switch-backup', 'sequence.json'),
    ).activeAccountId
  } catch {
    return
  }
  if (!(active in s.limits) || at <= (s.hitAt?.[active] ?? s.at)) return
  delete s.limits[active]
  delete s.hitAt?.[active]
  writeJson(LIMITS, s)
}

function swapAccount(hit: { at: number; resetsAt: number }, now: number): number {
  const file = LIMITS
  const s: Limits = existsSync(file) ? readJson<Limits>(file) : { at: 0, limits: {} }
  if (hit.at < s.at) return 0
  let seq: { activeAccountId: string; sequence: string[] }
  try {
    seq = readJson(join(homedir(), '.claude-switch-backup', 'sequence.json'))
  } catch {
    return hit.resetsAt // no ccswitch: wait out the limit
  }
  s.limits[seq.activeAccountId] = Math.max(
    s.limits[seq.activeAccountId] ?? 0,
    hit.resetsAt || now + 3_600_000,
  )
  s.hitAt = { ...s.hitAt, [seq.activeAccountId]: hit.at }
  const next = nextAccount(seq.sequence, seq.activeAccountId, s.limits, now)
  const ok =
    next === seq.activeAccountId ||
    (next !== null && Bun.spawnSync(['ccswitch', 'switch-to', next], { timeout: 30_000 }).exitCode === 0)
  if (next && !ok) s.limits[next] = now + 3_600_000 // it would not switch (a lapsed login): try the others
  if (ok) s.at = now
  writeJson(file, s)
  return ok ? 0 : Math.min(...seq.sequence.map(a => s.limits[a] ?? now))
}

/**
 * This function checks if a hit is new. A hit is new when no state exists yet. A hit is
 * also new when the hit time is after the state time.
 */
export function needsSwap(hit: { at: number }, state: { at: number } | undefined) {
  return !state || hit.at > state.at
}

/**
 * This function gives the wait after a swap try. On success, it gives the vault's refresh
 * window. On failure, it gives the reset wait.
 */
export function swapUntil(
  hit: { at: number; resetsAt: number },
  now: number,
  ok: boolean,
  refreshMs: number,
) {
  return ok ? now + refreshMs : hit.resetsAt || hit.at + 3_600_000
}

const TOKEN_SWAP_WAIT_MS = 5 * 60_000 // agent-vault reads the vault again at most this often
type TokenSwapState = { at: number; until: number }

/**
 * This function runs a command. A rig sets the command in FACTORY_AX_TOKEN_SWAP. The function
 * runs the command one time for each refusal. It then sends mail to the manager. The mail
 * names the live slot.
 *
 * Workers of one runner use the same vault token. One file per runner stops a second run for
 * the same refusal. If there is no command, the function waits for the reset. The function
 * also waits for the reset if the command fails.
 */
function runTokenSwap(
  hit: { at: number; resetsAt: number },
  now: number,
  runnerName: string,
  send: (e: Input) => void,
  node: string,
): number {
  const cmd = process.env.FACTORY_AX_TOKEN_SWAP
  if (!cmd) return hit.resetsAt || hit.at + 3_600_000
  const file = join(HOME, `token-swap-${runnerName}.json`)
  const state = existsSync(file) ? readJson<TokenSwapState>(file) : undefined
  if (!needsSwap(hit, state)) return state!.until
  const p = Bun.spawnSync(cmd.split(' '), { cwd: ROOT, timeout: 30_000 })
  const ok = p.exitCode === 0
  if (ok) {
    const slot = /slot (\S+) is live/.exec(p.stdout.toString())?.[1] ?? '?'
    send({
      type: 'MAIL',
      from: node,
      to: 'manager',
      text: `Swapped the Claude token for ${runnerName} workers: slot ${slot} is live; they go on once the vault refreshes.`,
    })
  }
  const until = swapUntil(hit, now, ok, TOKEN_SWAP_WAIT_MS)
  writeJson(file, { at: hit.at, until } satisfies TokenSwapState)
  return until
}

/**
 * a worker's own Claude settings, in full: none of the user's plugins, agents, skills, global `CLAUDE.md` or auto memory.
 * Those cost a worker tens of thousands of tokens a turn it never uses, so this wins instead.
 * It keeps the user's hooks (secret guards, herdr's session hook) and env, and skips every permission prompt.
 * It compacts well past the handoff limit too, only as a backstop.
 * A worktree's path excludes the global `CLAUDE.md` too, since Claude Code would read it as an ancestor's project file.
 * One plugin stays in: `asd-ste100`, so the worker still writes in ASD-STE100; `disableBundledSkills` keeps its skill alone.
 */
export const workerSettings = (
  user: { env?: Record<string, string>; hooks?: unknown; enabledPlugins?: Record<string, boolean> },
  maxContextK: number,
  globalClaudeMd = join(homedir(), '.claude', 'CLAUDE.md'),
) => {
  const ste = Object.entries(user.enabledPlugins ?? {}).filter(([k, v]) => v && k.startsWith('asd-ste100@'))
  return {
    claudeMdExcludes: [globalClaudeMd],
    autoMemoryEnabled: false, // workers share the factory's memory, not the user's per-repo notes
    env: {
      ...user.env,
      ...withoutFleet(user.env?.CLAUDE_CODE_PLUGIN_DIRS ?? process.env.CLAUDE_CODE_PLUGIN_DIRS).env,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
    ...(user.hooks ? { hooks: user.hooks } : {}),
    ...(ste.length ? { enabledPlugins: Object.fromEntries(ste) } : {}),
    disableBundledSkills: true,
    skipDangerousModePermissionPrompt: true,
    autoCompactWindow: Math.max(100, 2 * maxContextK) * 1000,
  }
}
// what workers use; the rest of Claude Code's built-ins only add tool definitions to every turn.
// ToolSearch keeps MCP tools deferred: without it every MCP server's tools load into every turn (~60k)
// Skill lets a worker run the asd-ste100 skill (workerSettings carries that one plugin over)
export const WORKER_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob,Agent,WebFetch,WebSearch,ToolSearch,Skill'

/** the flags that give a Claude worker its own settings, system prompt and tools; FACTORY_LEAN=0 turns them off */
function workerFlags(def: Factory) {
  if (process.env.FACTORY_LEAN === '0') return ` --settings '${JSON.stringify(withoutFleet())}'`
  let user = {}
  try {
    user = readJson(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'))
  } catch {
    // no user settings: nothing to carry over
  }
  const file = join(HOME, 'worker-settings.json')
  writeJson(file, workerSettings(user, def.maxContextK ?? 200))
  const prompt = join(ROOT, 'src', 'worker-system.md')
  // --tools first: it takes every word up to the next flag, so last it would swallow the prompt
  return ` --tools ${WORKER_TOOLS} --setting-sources project,local --settings ${sq(file)} --system-prompt-file ${sq(prompt)}`
}

function launch(run: Run, def: Factory, node: string, prompt: string, session?: string) {
  const rig = rigOf(run.repo)
  const extra = workerFlags(def)
  return command(agentOfNode(run, def, node), prompt, {
    session,
    extra,
    mcp: rig?.mcp ? readMcp(rig.mcp) : undefined,
  })
}

/**
 * the factory's own Claudes run without the herdr-fleet mod: its agent-status band, pane naming and
 * /fanout workers would compete with the runner, which owns its workers' panes. The mods come from
 * CLAUDE_CODE_PLUGIN_DIRS in the user's settings env, which the shell cannot override: --settings can.
 */
/**
 * The manager drives the factory through Bash and the factory CLI, and every call it makes re-reads its
 * whole tool list: a session with the user's MCP servers, connectors, Chrome and every built-in carried
 * ~130k tokens of tool definitions into each patrol. So it starts with only what it uses.
 */
const MANAGER_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob,AskUserQuestion,Skill'
export const managerCommand = (extra: string[] = []) => [
  'claude',
  '--model',
  'opus', // not [1m]: Claude Code compacts it near 200k, and every call re-reads the whole context
  // the person's own default mode (auto) refuses the production reads a patrol needs
  ...['--permission-mode', 'bypassPermissions'],
  '--strict-mcp-config', // and no --mcp-config: no MCP servers
  '--no-chrome',
  '--tools',
  MANAGER_TOOLS,
  '--plugin-dir',
  join(ROOT, 'mod'),
  '--settings',
  JSON.stringify({ env: { ...withoutFleet().env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } }),
  ...extra,
]

/**
 * runs the manager's Claude until it exits. Its ticks run inside it, so it cannot restart itself: this does.
 * When its account's usage limit refuses it, the account swaps as for a worker and it resumes its session
 */
async function superviseManager(args: string[]) {
  const i = args.findIndex(a => a === '--resume' || a === '-r')
  const session = i >= 0 && args[i + 1] ? args[i + 1]! : crypto.randomUUID()
  // its skills: an --add-dir's .claude/skills, which Claude Code watches, so one it installs applies at once
  mkdirSync(memory.skillsDir(MEMORY), { recursive: true })
  const rest = [
    ...(i >= 0 ? args.filter((_, j) => j !== i && j !== i + 1) : args),
    '--add-dir',
    memory.managerDir(MEMORY),
  ]
  // the dream learns from the manager's sessions
  const file = join(HOME, 'manager-sessions.json')
  const known = existsSync(file) ? readJson<{ session: string; cwd: string }[]>(file) : []
  if (!known.some(k => k.session === session)) writeJson(file, [...known, { session, cwd: process.cwd() }])
  for (let flag = i >= 0 ? '--resume' : '--session-id'; ; flag = '--resume') {
    const startedAt = Date.now()
    const child = Bun.spawn(managerCommand([...rest, flag, session]), {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, CLAUDE_CODE_NO_FLICKER: '1' },
    })
    let isSwapped = false
    const watch = setInterval(() => {
      const tail = tailOf(process.cwd(), session)
      const hit = limitHit(tail)
      if (!hit) clearLimit(servedAt(tail))
      if (hit && hit.at > startedAt && swapAccount(hit, Date.now()) === 0) {
        isSwapped = true
        child.kill()
      }
    }, 60_000)
    const code = await child.exited
    clearInterval(watch)
    if (!isSwapped) return code
  }
}

export const withoutFleet = (dirs = process.env['CLAUDE_CODE_PLUGIN_DIRS'] ?? '') => ({
  env: {
    CLAUDE_CODE_PLUGIN_DIRS: dirs
      .split(':')
      .filter(d => d && basename(d) !== 'herdr-fleet')
      .join(':'),
  },
})

/**
 * what to do about a launch that has not shown its Claude yet: wait, press Enter (the command sat
 * unsent on the line), type it again, then give up. Each step counts as a nudge.
 */
export function relaunch(sinceMs: number, nudges: number) {
  if (sinceMs <= LAUNCH_MS) return null
  return nudges === 0 ? 'enter' : nudges < 2 ? 'retype' : 'fail'
}

/**
 * what a station's time limit calls for: a worker still at it when its time is up is warned once and
 * gets half the limit again to commit and report (under load a fabriek implement and verify were each
 * killed mid-work at the limit and redone from scratch); one that is not, or still silent after that, fails
 */
export function deadline(elapsedMs: number, timeoutMin: number, isWorking: boolean, isWarned: boolean) {
  if (elapsedMs <= timeoutMin * 60_000) return null
  if (!isWorking || elapsedMs > timeoutMin * 90_000) return 'fail'
  return isWarned ? null : 'warn'
}

/** what a working worker's progress was when last seen: the fingerprint of its tail and branch head, since when, and whether it was nudged for standing still */
export type Progress = { seq: number; sig: string; at: number; nudged: boolean }

/**
 * the stall guard's fingerprint: the tail's end, the branch head and, for a non-local (AX) worker, the live
 * stream's byte count, which moves while a long turn runs even when its tail and the VM's HEAD do not (claude-
 * factory-xq3). '' when there is no signal at all -- a worker that has reported nothing yet is not yet "quiet",
 * so `seen.sig &&` at the call site must stay false for it, not a stand-in fingerprint of its own. head alone
 * never makes it non-empty: a local worker's head is always set (`git rev-parse HEAD`, cli.ts L1553) even
 * before its tail or any transcript exists, so head-only would make every local codex/pi/script worker, and a
 * local claude worker before its session is known, newly stall-failable (claude-factory-xq3.4, PR #19 review).
 */
export function progressSig(tail: string, head: string, bytes?: number) {
  return tail || bytes ? `${tail.length}${tail.slice(-300)}${head}${bytes ?? ''}` : ''
}

/** the worker's progress now: the last one while nothing changed, else a fresh one (a new worker or any output) */
export const progressNow = (prev: Progress | undefined, seq: number, sig: string, now: number): Progress =>
  prev && prev.seq === seq && prev.sig === sig ? prev : { seq, sig, at: now, nudged: false }

/**
 * what a worker that shows no progress calls for. `deadline` alone leaves a hung turn "working" for 1.5x the
 * station's limit: nudge once after STALL_MS, fail after as long again
 */
export function stalled(unchangedMs: number, isNudged: boolean) {
  if (unchangedMs < STALL_MS) return null
  if (!isNudged) return 'nudge'
  return unchangedMs >= 2 * STALL_MS ? 'fail' : null
}

/** the facts a patrol needs about a working run: how long, how quiet, and whether its runner waits on a usage limit */
function facts(run: Run, c: Ctx, now: number): Pick<Row, 'inMin' | 'quietMin' | 'limitUntil'> {
  if (!c.pane || !c.startedAt) return {}
  const p = progressOf(run)
  const runner = runnerOf(c.pane)
  const paged = join(HOME, runner.local ? 'limit-paged.json' : `limit-paged-${runner.name}.json`)
  const until = existsSync(paged) ? readJson<number>(paged) : 0
  return {
    inMin: Math.floor((now - c.startedAt) / 60_000),
    ...(p?.seq === c.seq && { quietMin: Math.floor((now - p.at) / 60_000) }),
    ...(until > now && { limitUntil: until }),
  }
}

const progressFile = (run: Run) => join(runDir(run.id), 'progress.json')
const progressOf = (run: Run) =>
  existsSync(progressFile(run)) ? readJson<Progress>(progressFile(run)) : undefined

/**
 * whether Claude trusts a repo: its trust dialog was accepted for it or a folder above it. A worktree's
 * trust is its main repo's. Unreadable config counts as trusted, so the check never stops a factory itself.
 */
export function isTrusted(repo: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? homedir()) {
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>
  try {
    projects = readJson<{ projects?: typeof projects }>(join(configDir, '.claude.json')).projects ?? {}
  } catch {
    return true
  }
  for (let dir = resolve(repo); ; dir = dirname(dir)) {
    if (projects[dir]?.hasTrustDialogAccepted) return true
    if (dir === dirname(dir)) return false
  }
}

/** level-triggered: make the world match the current state, report what happened as events */
function reconcile(run: Run, def: Factory, c: Ctx, node: string, send: (e: Input) => void, now: number) {
  const n = def.nodes[node]!
  if (n.gate) {
    if (c.nudges === 0) {
      // ask once per visit; NUDGED records that it was asked
      const text = [
        `gate "${node}" awaits the person's decision: ${n.prompt.trim()}`,
        ...(c.mail[node] ?? []).map(m => `  from ${m.from}: ${m.text}`),
        `decide with: ${CLI} decide ${run.id} <${Object.keys(n.next).join('|')}> "<note for the next station>"`,
      ].join('\n')
      send({ type: 'MAIL', from: node, to: 'manager', text })
      send({ type: 'NUDGED', seq: c.seq })
    }
    return 'awaiting decision'
  }
  // only a harness herdr knows (claude, codex, pi) shows it an agent; a script or a fake worker never would
  const isClaude = harnessOf(agentOfNode(run, def, node)) !== null
  if (!c.pane) {
    // a Claude in an untrusted repo sits at its trust dialog until the station times out, every attempt
    if (isClaude && runnerOfStation(run, def, node).local && !isTrusted(run.repo)) {
      const paged = join(HOME, 'untrusted.json')
      const repos = existsSync(paged) ? readJson<string[]>(paged) : []
      if (!repos.includes(run.repo)) {
        const text = `${run.repo} is not trusted by Claude, so no worker starts there: its trust dialog would stall it. Trust it once (run claude in ${run.repo} and accept), and the waiting runs start on the next tick.`
        send({ type: 'MAIL', from: node, to: 'manager', text })
        writeJson(paged, [...repos, run.repo])
      }
      return 'awaiting trust'
    }
    const pane = spawn(run, def, node, c)
    send({ type: 'SPAWNED', seq: c.seq, pane })
    const box = c.mail[node] ?? [] // the brief carried the whole box
    if (box.length) send({ type: 'READ', box: node, seen: box.length })
    return 'starting'
  }
  const runner = runnerOf(c.pane)
  const info = runner.info(run, c.pane)
  // the runner gave up retrying something itself (a put stuck over ax ssh): fail now, with its reason, instead
  // of the generic "was closed" or a silent retry forever
  if (info?.failed) {
    send({ type: 'FAIL', seq: c.seq, reason: info.failed })
    return info.status
  }
  if (info?.session && info.session !== c.session)
    send({ type: 'SESSION', seq: c.seq, session: info.session })
  // a remote worker keeps its session where it ran: once gone, there is nothing to resume it from
  if (info === null && c.session && c.resumes < 1 && runner.local) {
    send({ type: 'SPAWNED', seq: c.seq, pane: spawn(run, def, node, c, c.session), isResume: true })
    return 'resuming'
  }
  const status = info?.status ?? null
  // its Claude exited and left the shell (a herdr restart keeps the panes, not their processes):
  // resume the conversation in the same pane, once, as for a pane that closed
  // a just-resumed Claude takes seconds to show: give it the launch grace before calling it gone again
  if (runner.local && info && !info.agent && c.session && isClaude && now - c.startedAt > LAUNCH_MS) {
    if (c.resumes >= 1) {
      send({ type: 'FAIL', seq: c.seq, reason: `the worker's Claude exited in pane ${c.pane}` })
      return status
    }
    herdr('pane', 'send-keys', c.pane, 'ctrl+u')
    typeLaunch(c.pane, launch(run, def, node, resumeFile(run, node, c), c.session))
    send({ type: 'SPAWNED', seq: c.seq, pane: c.pane, isResume: true })
    return 'resuming'
  }
  if (runner.local && info && !info.agent && !c.session && isClaude) {
    const step = relaunch(now - Math.max(c.startedAt, c.nudgedAt), c.nudges)
    if (step === 'fail') {
      send({
        type: 'FAIL',
        seq: c.seq,
        reason: `the worker never started in pane ${c.pane} (no Claude after ${NUDGES} relaunches)`,
      })
      return status
    }
    if (step === 'enter') herdr('pane', 'send-keys', c.pane, 'Enter')
    if (step === 'retype') {
      herdr('pane', 'send-keys', c.pane, 'ctrl+u') // whatever is left on the line
      typeLaunch(c.pane, launch(run, def, node, promptOf(run, node, c)))
    }
    if (step) send({ type: 'NUDGED', seq: c.seq })
    return step ? 'relaunching' : 'starting'
  }
  const timeoutMin = n.timeoutMin ?? 60
  const inbox = unread(c, node)
  // a worker waiting on the manager's answer is idle by design: no nudges until the answer arrives
  const asked = (c.mail.manager ?? []).findLast(m => m.from === node && m.at >= c.startedAt)
  const isAsking =
    asked !== undefined && !(c.mail[node] ?? []).some(m => m.from === 'manager' && m.at > asked.at)
  // a remote worker's transcript is in its VM: its runner hands over the end of it, available from the moment
  // it has one (own()/claude.jsonl's fallback -- see worker.ts lastTurn), not gated on this tick having already
  // learned c.session, which lags the runner's own info.session by at least one tick (the SESSION send above)
  // -- gating it left an AX worker's tail empty for its whole first turn too (claude-factory-xq3)
  const tail = !isClaude ? '' : runner.local ? (c.session ? tailOf(run.worktree, c.session) : '') : (info?.tail ?? '')
  const hit = limitHit(tail)
  if (!hit && runner.local) clearLimit(servedAt(tail))
  if (hit && hit.at > c.startedAt) {
    // A VM's Claude uses the vault's token. ccswitch does not rotate this token. With a swap command,
    // runTokenSwap moves to a new slot, and the worker goes on when the vault refreshes. With no swap
    // command, the worker waits for the reset, and the nudge below then gives it its next turn.
    const until = runner.local ? swapAccount(hit, now) : runTokenSwap(hit, now, runner.name, send, node)
    if (until > now) {
      const paged = join(HOME, runner.local ? 'limit-paged.json' : `limit-paged-${runner.name}.json`)
      if (!existsSync(paged) || readJson<number>(paged) < until) {
        const text = runner.local
          ? `Every Claude account is at its usage limit (${hit.kind}); workers wait until ${new Date(until).toLocaleString()} and restart then. Log in another account with ccswitch to go on sooner.`
          : `The Claude token ${runner.name} workers run on is at its usage limit (${hit.kind}); they wait until ${new Date(until).toLocaleString()} and go on then.`
        send({ type: 'MAIL', from: node, to: 'manager', text })
        writeJson(paged, until)
      }
      return 'usage limit'
    }
    if (runner.local) {
      runner.close(c.pane) // its Claude sits at the limit message
      send({ type: 'SPAWNED', seq: c.seq, pane: spawn(run, def, node, c, c.session!) })
      return 'account swapped'
    }
  }
  // the egress gateway refusing api.anthropic.com (see docs/remote-runner.md): serve is retrying the turn
  // itself, so tell the manager once per outage and, once serve gives up (idle with the outage still set),
  // fail with the cause instead of spending nudges on a worker that was never going to report
  const egress = info?.egress
  const retries = (n: number) => `${n} ${n === 1 ? 'retry' : 'retries'}`
  if (egress) {
    // keyed per run+node, not per runner: the gateway is shared, so a single outage hits every concurrent
    // AX worker at once, and a file keyed only by the runner's name would have them overwrite each other's
    // `since` and each mail the manager on every tick
    const paged = join(runDir(run.id), `egress-paged-${node}.json`)
    if (!existsSync(paged) || readJson<number>(paged) !== egress.since) {
      const since = new Date(egress.since).toLocaleString()
      // from 'factory', not node: a notice, not a question, so it never reads as the station asking the
      // manager something and awaiting a reply (isAsking keys off mail with from === node)
      send({
        type: 'MAIL',
        from: 'factory',
        to: 'manager',
        text: `${node} of ${run.id}: the egress gateway is refusing new connections to the model API (since ${since}, ${retries(egress.tries)} so far). The worker is retrying itself; see docs/remote-runner.md if it does not clear on its own.`,
      })
      writeJson(paged, egress.since)
    }
  }
  const egressReason =
    egress &&
    `egress gateway: model API unreachable since ${new Date(egress.since).toISOString()} (${retries(egress.tries)}): ${clip(egress.last, 200)}`
  if (status === 'working') send({ type: 'WORKING', seq: c.seq })
  // every turn re-reads the whole context: past the limit the worker hands off to a fresh one
  const maxK = def.maxContextK ?? 200
  const k = Math.round(lastContext(tail) / 1000)
  const isHandoffAsked = (c.mail[node] ?? []).some(
    m => m.from === 'factory' && m.at >= c.startedAt && m.text.includes(HANDOFF_ASK),
  )
  if (k > maxK * 1.25 && isHandoffAsked) {
    const summary = `The factory cut the previous worker off at ${k}k tokens of context (limit ${maxK}k): it was asked to hand off and did not. What it did not commit is still in the worktree; read the journal and git status before redoing anything.`
    send({ type: 'HANDOFF', seq: c.seq, summary })
    return 'handed off'
  }
  if (k > maxK && !isHandoffAsked) {
    const cmd = `${CLI} report ${run.id} ${c.seq} handoff "<what is done, what is left and how, what you learned that the code does not show>"`
    const text = `[factory] This session's context is ${k}k tokens, ${HANDOFF_ASK} of ${maxK}k: every turn re-reads all of it. At the next safe point, commit your work in progress (a WIP commit is fine) and hand off to a fresh worker, then stop: ${cmd}`
    send({ type: 'MAIL', from: 'factory', to: node, text })
  }
  // ponytail: a fingerprint of the tail's end, the branch head and (a non-local worker) its live stream's byte
  // count; a worker that only thinks is nudged, not failed. An AX worker's head and bytes come from its own
  // poll (taskInfo/worker.ts poll), since there is no local worktree to `git rev-parse` on
  const prev = progressOf(run)
  const head = runner.local
    ? Bun.spawnSync(['git', '-C', run.worktree, 'rev-parse', 'HEAD']).stdout.toString()
    : (info?.head ?? '')
  const seen = progressNow(prev, c.seq, progressSig(tail, head, runner.local ? undefined : info?.bytes), now)
  // a retry in progress looks like no output for a while on purpose: never call that a stall
  const stall =
    status === 'working' && !isAsking && seen.sig && !egress ? stalled(now - seen.at, seen.nudged) : null
  if (stall === 'nudge') seen.nudged = true
  if (seen !== prev || stall === 'nudge') writeJson(progressFile(run), seen)
  const due = deadline(
    now - c.startedAt,
    timeoutMin,
    status === 'working' || isAsking, // waiting on the manager's answer is work: warned, not failed
    (c.mail[node] ?? []).some(m => m.from === 'factory' && m.at >= c.startedAt && m.text.includes(TIME_UP)),
  )
  if (status === null) send({ type: 'FAIL', seq: c.seq, reason: `worker pane ${c.pane} was closed` })
  // serve already spent its own budget retrying: fail now, named, instead of nudging a known cause
  else if (egressReason && !isAsking && (status === 'idle' || status === 'done'))
    send({ type: 'FAIL', seq: c.seq, reason: egressReason })
  else if (due === 'fail') send({ type: 'FAIL', seq: c.seq, reason: egressReason ?? `no report within ${timeoutMin} min` })
  else if (stall === 'fail') {
    const min = Math.round((now - seen.at) / 60_000)
    const last = tail.trimEnd().split('\n').at(-1) ?? ''
    send({ type: 'FAIL', seq: c.seq, reason: `stalled: no output for ${min} min` })
    const text = `${node} of ${run.id} stalled: no output for ${min} min, attempt failed. Last line: ${clip(last, 200)}`
    send({ type: 'MAIL', from: node, to: 'manager', text })
  } else if (stall === 'nudge') {
    const min = Math.round((now - seen.at) / 60_000)
    const cmd = `${CLI} report ${run.id} ${c.seq} blocked "<why>"`
    runner.deliver(
      c.pane,
      `[factory] Nothing in your session or branch has changed for ${min} min. If you are stuck, report what blocks you: ${cmd}. Otherwise carry on.`,
    )
  } else if (due === 'warn') {
    const cmd = `${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`
    const text = `[factory] This station's ${timeoutMin} ${TIME_UP}. Commit what works now and report within ${Math.round(timeoutMin / 2)} minutes, saying what is left for the next attempt: ${cmd}`
    send({ type: 'MAIL', from: 'factory', to: node, text }) // delivered on the next tick, like any mail
  } else if (inbox.length && status !== 'blocked') {
    if (runner.deliver(c.pane, inbox.map(m => `[factory mail from ${m.from}] ${m.text}`).join('\n\n')))
      send({ type: 'READ', box: node, seen: c.mail[node]!.length })
  } else if (isAsking && status === 'idle' && runner.suspend) {
    runner.suspend(c.pane)
  } else if (
    !isAsking &&
    (status === 'idle' || status === 'done') &&
    // a worker waiting on its own build answers a nudge and goes idle again: give it longer each time
    now - Math.max(c.startedAt, c.nudgedAt) > GRACE_MS * 2 ** c.nudges
  ) {
    if (c.nudges >= NUDGES)
      send({ type: 'FAIL', seq: c.seq, reason: egressReason ?? 'worker stopped without reporting' })
    else {
      const cmd = `${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`
      runner.deliver(
        c.pane,
        `[factory] You have not reported. If you are finished run: ${cmd}. If you are still working or waiting on something, say in one line what, and carry on.`,
      )
      send({ type: 'NUDGED', seq: c.seq })
    }
  }
  return status
}

/** what holds the run now, for a run whose worker is not being reconciled */
function agentOf(def: Factory, value: unknown, c: Ctx) {
  const [node, sub] = where(value)
  if (sub === 'waiting') return `waits until ${clock(c.wakeAt)}`
  if (sub === 'working' && def.nodes[node]?.gate) return 'awaiting decision'
  if (!c.pane) return undefined
  try {
    return runnerOf(c.pane).phase?.(c.pane) ?? null
  } catch (err) {
    // a runner it cannot reach (an AX server whose port-forward died) is this run's trouble, not the listing's
    return `unreachable: ${clip((err as Error).message, 160)}`
  }
}

function row(run: Run, def: Factory, value: unknown, c: Ctx, agent?: string | null, error?: string): Row {
  const [node, sub] = where(value)
  const n = def.nodes[node]
  const retries = n?.retries ?? 2
  return {
    id: run.id,
    factory: def.name,
    // a bead's goal carries its whole description (a fabriek spec is 20 KB): the board's row gets the
    // title line, every 5 s; show, the brief and bd show have the rest
    goal: clip(run.goal.split('\n')[0]!, 300),
    node,
    sub,
    attempt: c.attempt,
    attempts: 1 + retries,
    pane: c.pane,
    agent,
    ws: run.ws,
    error: error ?? c.error,
    ...(c.log.length && { last: { ...c.log.at(-1)!, summary: clip(c.log.at(-1)!.summary, 400) } }),
    bead: run.bead,
    rig: rigOf(run.repo)?.name,
    trail: c.log.slice(-40).map(e => e.node),
    ...(c.startedAt && { since: c.startedAt }),
    ...(c.wakeAt && { wakeAt: c.wakeAt }),
    ...(c.mail[node]?.length && { mailedAt: Math.max(...c.mail[node]!.map(m => m.at ?? 0)) }),
    ...(n?.gate &&
      sub === 'working' && { gate: { question: n.prompt.trim(), outcomes: Object.keys(n.next) } }),
  }
}

/** a stop's or a resume's part in one working run; null when neither applies and the run reconciles as usual */
function haltRun(
  run: Run,
  def: Factory,
  node: string,
  c: Ctx,
  send: (e: Input) => void,
  halt: Halt | null,
  now: number,
) {
  if (def.nodes[node]!.gate) return null // a gate holds no worker: it still asks and can be decided
  const back = existsSync(resumeFile_()) ? readJson<Record<string, number>>(resumeFile_()) : {}
  if (!halt && back[run.id] === c.seq) {
    const pane = spawn(run, def, node, c, c.session ?? undefined)
    send({ type: 'RESUMED', seq: c.seq, pane })
    const { [run.id]: _, ...rest } = back
    writeJson(resumeFile_(), rest)
    return 'resumed'
  }
  if (!halt) return null
  if (halt.state === 'paused' || halt.closed[run.id] === c.seq) return 'paused'
  const info = c.pane ? runnerOf(c.pane).info(run, c.pane) : null
  // a pane with no agent in it (a script worker, a Claude already gone) has nobody to tell
  const isTold = halt.told[run.id] === c.seq || !info?.agent
  const step = haltStep(!!info, isTold, info?.status === 'working', now - halt.at)
  if (step === 'tell') {
    runnerOf(c.pane!).deliver(c.pane!, STOP_NOTE)
    halt.told[run.id] = c.seq
  } else if (step === 'close' || step === 'gone') {
    if (step === 'close') runnerOf(c.pane!).close(c.pane!)
    halt.closed[run.id] = c.seq
  }
  writeJson(haltFile(), halt)
  return step === 'wait' || step === 'tell' ? 'stopping' : 'paused'
}

async function tickRun(run: Run, now: number, halt: Halt | null = null) {
  const def = await loadFactory(run.factory)
  const file = join(runDir(run.id), 'state.json')
  const saved = readJson<Saved>(file)
  const actor = createActor(compile(def), { snapshot: saved.snapshot }).start()
  const lines = inboxLines(run.id)
  const ctx = () => actor.getSnapshot().context
  const save = () =>
    writeJson(file, {
      cursor: lines.length,
      snapshot: actor.getPersistedSnapshot(),
      ...(saved.track && { track: saved.track }),
    })
  const send = (e: Input, at = now) => {
    const pane = ctx().pane
    actor.send({ ...e, at } as Ev)
    if (pane && pane !== ctx().pane) runnerOf(pane).close(pane)
  }

  for (const line of lines.slice(saved.cursor)) {
    const e = JSON.parse(line) as Ev
    send(e, e.at)
  }
  send({ type: 'TICK' })

  let agent: string | null | undefined
  let error: string | undefined
  const [node, sub] = where(actor.getSnapshot().value)
  try {
    if (sub === 'working')
      agent = haltRun(run, def, node, ctx(), send, halt, now) ?? reconcile(run, def, ctx(), node, send, now)
    else agent = agentOf(def, actor.getSnapshot().value, ctx())
  } catch (err) {
    error = (err as Error).message
  }

  error ??= run.bead ? trackOf(run.id, saved).error : undefined

  const manager = unread(ctx(), 'manager')
  if (manager.length) send({ type: 'READ', box: 'manager', seen: ctx().mail.manager!.length })
  save()
  return {
    row: {
      ...row(run, def, actor.getSnapshot().value, ctx(), agent, error),
      ...(sub === 'working' && !def.nodes[node]?.gate && facts(run, ctx(), now)),
    },
    manager: manager.map(m => ({ run: run.id, ...m })),
  }
}

/** mirrors a run into its bead, advancing `t` as each write lands so a failure retries next tick */
function track(run: Run, def: Factory, value: unknown, c: Ctx, t: Track, now: number) {
  const b = beads(run.repo, actorOf(run.id))
  const id = run.bead!
  for (const e of c.log.slice(t.mirrored)) {
    const edge = def.nodes[e.node]?.next[e.outcome]
    // a sweep's routine pass stays in the journal only: a comment every 30 minutes is noise
    const isPass = typeof edge === 'object' && edge.to === e.node && edge.delayMin !== undefined
    if (!isPass) b.comment(id, `${e.node}#${e.attempt} ${e.outcome}: ${e.summary}`)
    t.mirrored++
  }
  const [node] = where(value)
  const isOver = node === 'done' || node === 'aborted'
  if (isOver && !t.isSettled) {
    const last = c.log.at(-1)
    const edge = last && def.nodes[last.node]?.next[last.outcome]
    const reason = clip(last ? `${last.node} ${last.outcome}: ${last.summary}` : node, 500)
    // open children, however the run ended: what is left is theirs to start, so the bead stays open
    // rather than deferred out of sight (dispatch skips it, so it does not come straight back)
    if (openChildren(b, id).length) {
      b.release(id)
      b.comment(id, `run ${run.id} ended with open child beads, so this stays open for them: ${reason}`)
    }
    // deferred work is out of bd ready until a person undefers it, which hands it back to the factory
    else if (node === 'aborted') b.defer(id, `run ${run.id} was aborted`)
    else if (typeof edge === 'object' && edge.defer) b.defer(id, reason)
    // not the factory's to do: left open for a person, who queues it again or closes it
    else if (typeof edge === 'object' && edge.reject) b.reject(id, `${run.id}/${last!.node}`, reason)
    else if (!b.close(id, reason)) b.defer(id, `run ${run.id} could not close it: ${reason}`)
    t.isSettled = true
  } else if (!isOver && t.isSettled) {
    t.isSettled = !b.reopen(id) // a run revived with goto
  } else if (!isOver) beat(run, t, now)
}

/** keeps a live run's claim: bd's lease is 5 minutes */
function beat(run: Run, t: Track, now: number) {
  if (now - t.beatAt <= HEARTBEAT_MS) return
  if (!beads(run.repo, actorOf(run.id)).heartbeat(run.bead!))
    throw new Error(`lost the claim on ${run.bead} to another worker`)
  t.beatAt = now
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

/** a lock held while its process lives, however long it takes: a pass over slow bd can take minutes */
function hold(name: string): (() => void) | null {
  const dir = join(HOME, name)
  mkdirSync(HOME, { recursive: true })
  try {
    mkdirSync(dir)
  } catch {
    try {
      const pid = existsSync(join(dir, 'pid')) ? Number(readFileSync(join(dir, 'pid'), 'utf8')) : 0
      // no pid yet: just taken, or an older runner's lock, which went stale after two minutes
      if (pid ? isAlive(pid) : Date.now() - statSync(dir).mtimeMs < 120_000) return null
      // ponytail: two takers of a dead holder's lock can race, and a reused pid looks alive; holders
      // rarely die, flock if either bites
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir)
    } catch {
      return null // the holder let go meanwhile, or another taker won: the next try gets it
    }
  }
  writeFileSync(join(dir, 'pid'), String(process.pid))
  return () => rmSync(dir, { recursive: true, force: true })
}

const trackOf = (id: string, saved?: Saved): Track => {
  const file = join(runDir(id), 'track.json')
  return existsSync(file)
    ? readJson(file)
    : {
        mirrored: 0,
        beatAt: 0,
        isSettled: false,
        ...(saved ?? readJson<Saved>(join(runDir(id), 'state.json'))).track,
      }
}

/**
 * every run's beads, out of the tick: under load one bd call can take a minute, and launching, nudging and
 * failing workers must not wait on it. Mirrors reports, heartbeats claims, settles finished runs, then
 * dispatches the rigs' ready beads. One pass at a time; each tick starts one when none is running.
 */
async function beadsPass() {
  const release = hold('beads.lock')
  if (!release) return
  try {
    // every live claim first: a pass over slow bd takes minutes, longer than the lease, if the claims
    // wait behind every run's comments
    for (const id of runIds()) {
      try {
        const { run, value } = current(id)
        if (!run.bead || ['done', 'aborted'].includes(where(value)[0])) continue
        const t = trackOf(id)
        if (t.isSettled) continue // a revived run: track reopens it below
        try {
          beat(run, t, Date.now())
        } catch (err) {
          t.error = `beads: ${(err as Error).message}`
        }
        writeJson(join(runDir(id), 'track.json'), t)
      } catch {
        // removed mid-pass
      }
    }
    for (const id of runIds()) {
      try {
        const run = loadRun(id)
        if (!run.bead) continue
        const saved = readJson<Saved>(join(runDir(id), 'state.json'))
        const t = trackOf(id, saved)
        try {
          track(
            run,
            await loadFactory(run.factory),
            saved.snapshot.value,
            saved.snapshot.context,
            t,
            Date.now(),
          )
          delete t.error
        } catch (err) {
          t.error = `beads: ${(err as Error).message}`
        }
        writeJson(join(runDir(id), 'track.json'), t)
      } catch {
        // removed mid-pass
      }
    }
    await dispatch()
    await labelPass()
    await watchPass()
  } finally {
    release()
  }
}
const isHeld = (name: string) => {
  try {
    return isAlive(Number(readFileSync(join(HOME, name, 'pid'), 'utf8')))
  } catch {
    return false
  }
}
/** starts a beads pass unless one is running: checked here, so a busy pass costs no process every tick */
const kickBeads = () =>
  isHeld('beads.lock') ||
  spawnChild(CLI, ['beads'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()

/** the journal entries the dream has not read yet, newest kept when there are too many */
const journalSince = (since: number) =>
  runIds()
    .flatMap(id => {
      try {
        const run = loadRun(id)
        const { log } = readJson<Saved>(join(runDir(id), 'state.json')).snapshot.context
        const rig = rigOf(run.repo)?.name ?? basename(run.repo)
        return log
          .filter(e => e.at > since)
          .map(e => ({
            at: e.at,
            line: `- ${id} ${rig} ${e.node}#${e.attempt} ${e.outcome}: ${clip(e.summary, 600)}`,
          }))
      } catch {
        return [] // removed mid-read
      }
    })
    .sort((a, b) => a.at - b.at)
    .slice(-300)
    .map(e => e.line)

/** what the manager did since, from its sessions' transcripts, and its skills with their uses */
function managerSince(since: number) {
  const file = join(HOME, 'manager-sessions.json')
  const sessions = existsSync(file) ? readJson<{ session: string; cwd: string }[]>(file) : []
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const lines = sessions.flatMap(({ session, cwd }) => {
    const path = join(dir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  })
  const { activity, used } = memory.managerActivity(lines, since)
  const skills = memory.skills(MEMORY).map(s => {
    const u = used.get(s.name)
    return `- ${s.name}: ${u ? `${u.n}, last ${new Date(u.last).toISOString().slice(0, 10)}` : 'never used'}: ${s.description}`
  })
  return { activity: activity.slice(-400), skills } // ponytail: the newest 400 lines; a day's patrols fit
}

/** the manager hears once of each set of skill proposals waiting on its review: the next patrol takes it */
function skillMail(now: number) {
  const file = join(HOME, 'skills.json')
  const pending = memory.pendingSkills(MEMORY)
  const key = JSON.stringify(pending.map(p => [p.name, p.change]))
  if (key === (existsSync(file) ? readFileSync(file, 'utf8') : '[]')) return []
  writeFileSync(file, key)
  if (!pending.length) return []
  const text = [
    `The dream proposed ${pending.length} manager skill change(s). Read each file, check its commands are right and safe for the factory, then \`${CLI} skills install <name>\` or \`${CLI} skills reject <name> <why>\`:`,
    ...pending.map(p => `- ${p.name} (${p.change}): ${p.description} (${p.file})`),
  ].join('\n')
  return [{ run: 'factory', from: 'dream', text, at: now }]
}

const commitMemory = (message: string) => {
  git(MEMORY, 'add', '-A')
  if (git(MEMORY, 'status', '--porcelain')) git(MEMORY, 'commit', '-q', '-m', message)
}

/** beads the memory names that have closed since: what waited on them is stale */
function closedBeads() {
  const text = memory.corpus(MEMORY)
  return rigs()
    .filter(r => hasBeads(r.repo))
    .flatMap(r => {
      const b = beads(r.repo, 'factory/dream')
      const prefix = b.prefix()
      const ids = prefix ? new Set(text.match(new RegExp(`\\b${prefix}-[a-z0-9]+(?:\\.\\d+)*\\b`, 'g'))) : []
      return [...ids].flatMap(id => {
        const bead = b.show(id) // not a bead after all (a word with the prefix's shape): null
        return bead?.status === 'closed'
          ? [`- ${id} (${r.name}): ${bead.title}. Closed: ${clip(bead.close_reason ?? '', 300)}`]
          : []
      })
    })
}

/**
 * grooms the memory with a headless worker that can only edit inside it: files the inbox under topics,
 * merges and prunes, mines the journals since the last dream, reorders. Committed before and after.
 */
async function dream() {
  const release = hold('dream.lock')
  if (!release) return 'a dream is already running'
  try {
    writeFileSync(join(HOME, 'dream.stamp'), '') // a failed dream waits for the next day too, rather than retrying every tick
    mkdirSync(MEMORY, { recursive: true })
    if (!existsSync(join(MEMORY, '.git'))) {
      git(MEMORY, 'init', '-q')
    }
    writeFileSync(join(MEMORY, '.gitignore'), '.index.json*\n.usage.jsonl*\n') // caches, not memory
    commitMemory('notes since the last dream')
    // the journal since the last dream that finished: a failed one leaves its entries to the next
    const since = Number(git(MEMORY, 'log', '-1', '--grep=^dream:', '--format=%at')) * 1000
    const journal = journalSince(since)
    const manager = managerSince(since)
    if (!journal.length && !memory.inboxCount(MEMORY) && !manager.activity.length)
      return 'nothing new since the last dream'
    const start = Date.now()
    const before = git(MEMORY, 'rev-parse', 'HEAD')
    const prompt = memory.dreamPrompt(MEMORY, journal, memory.usageLines(MEMORY), closedBeads(), manager)
    // edits auto-accepted inside the memory only; -p has nobody to ask, so anything else is refused
    const p = Bun.spawnSync(
      [
        ...claudeCommand().split(/\s+/),
        ...['-p', '--permission-mode', 'acceptEdits'],
        ...['--settings', JSON.stringify(withoutFleet())],
        ...['--allowedTools', 'Bash(mkdir:*)', 'Bash(git mv:*)', 'Bash(git rm:*)'],
      ],
      { cwd: MEMORY, stdin: Buffer.from(prompt), timeout: 45 * 60_000 },
    )
    const said = p.stdout.toString().trim() || `the dream exited ${p.exitCode}: ${p.stderr.toString().trim()}`
    writeFileSync(join(HOME, 'dream.log'), `${new Date(start).toISOString()} exit ${p.exitCode}\n${said}\n`)
    if (p.exitCode !== 0) return said
    git(MEMORY, 'add', '-A')
    // committed even when it changed nothing, and dated when it began: what was journaled meanwhile is the next one's
    git(
      MEMORY,
      'commit',
      '-q',
      '--allow-empty',
      `--date=@${Math.floor(start / 1000)}`,
      '-m',
      `dream: ${said}`,
    )
    // a filed or renamed note keeps its counts
    const renamed = Object.fromEntries(
      git(MEMORY, 'diff', '-M', '--name-status', before, 'HEAD')
        .split('\n')
        .filter(l => l.startsWith('R'))
        .map(l => l.split('\t').slice(1)),
    )
    memory.compact(MEMORY, renamed)
    return said
  } finally {
    release()
  }
}
const devenvConfig = () => join(HOME, 'devenv.json')
const DEVENV_CHECK_MS = 30 * 60_000

/**
 * builds and caches the devenv of each AX rig with a binary cache (FACTORY_NIX_CACHE) whose devenv files or
 * worker image changed since it was last built, or of the named rigs; `force` rebuilds them anyway
 */
function devenvPass(names: string[], force = false) {
  const release = hold('devenv.lock')
  if (!release) return ['a devenv pass is already running']
  try {
    writeFileSync(join(HOME, 'devenv.stamp'), '') // the kick's clock: a pass started, whatever it finds
    if (!existsSync(devenvConfig())) return [`no ${devenvConfig()}: see docs/remote-runner.md`]
    const cfg = readJson<devenv.DevenvConfig>(devenvConfig())
    const image =
      process.env.FACTORY_AX_IMAGE ?? fail('FACTORY_AX_IMAGE is not set: the image the devenv is built in')
    const chosen = rigs().filter(r =>
      names.length ? names.includes(r.name) : r.runner === 'ax' && r.env?.FACTORY_NIX_CACHE,
    )
    return chosen.map(rig => {
      const stampFile = join(HOME, 'devenv', `${rig.name}.json`)
      const { rev, blobs, hasDevenv } = devenv.remoteDevenv(rig.repo)
      if (!hasDevenv) return `${rig.name}: no devenv.nix`
      const key = devenv.cacheKey(blobs, image)
      if (!devenv.isDue(devenv.readStamp(stampFile), key, force)) return `${rig.name}: up to date (${key})`
      const log = join(HOME, 'devenv', `${rig.name}.log`)
      mkdirSync(join(HOME, 'devenv'), { recursive: true })
      const remote = httpsRemote(git(rig.repo, 'remote', 'get-url', 'origin'))
      const r = devenv.build(cfg, { image, remote, rev, key, log, force })
      devenv.writeStamp(stampFile, { key, ok: r.ok, at: Date.now(), rev })
      return r.ok
        ? `${rig.name}: built and cached ${rev.slice(0, 7)} (${key})`
        : `${rig.name}: failed, see ${log}\n${r.why}`
    })
  } finally {
    release()
  }
}
/** a devenv pass at most every half hour, when this factory caches devenvs at all */
const kickDevenv = () => {
  const stamp = join(HOME, 'devenv.stamp')
  const age = existsSync(stamp) ? Date.now() - statSync(stamp).mtimeMs : Infinity
  if (!existsSync(devenvConfig()) || isHeld('devenv.lock') || age < DEVENV_CHECK_MS) return
  spawnChild(CLI, ['devenv'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

/** once a day, or sooner when the inbox fills; the dream itself skips when nothing is new */
const kickDream = () => {
  const stamp = join(HOME, 'dream.stamp')
  const age = existsSync(stamp) ? Date.now() - statSync(stamp).mtimeMs : Infinity
  // fabriek's workers filed 25 notes in the first 7 hours: a day's wait leaves them unfiled and duplicated
  const isFull = age >= DREAM_SOON_MS && memory.inboxCount(MEMORY) >= INBOX_FULL
  if (isHeld('dream.lock') || (age < DREAM_MS && !isFull)) return
  spawnChild(CLI, ['dream'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

const SIDEBAR_TTL_MS = 5 * 60_000
/** the workspace of the pane this runs in, when that pane sits in this factory's directory */
function managerWorkspace(): string | undefined {
  const id = process.env['HERDR_PANE_ID']
  if (!id) return undefined
  const pane = JSON.parse(Bun.spawnSync(['herdr', 'pane', 'get', id]).stdout.toString() || '{}').result?.pane
  const isOurs = pane?.cwd && (factoryAt(pane.cwd) ?? join(ROOT, '.factory-state')) === HOME
  return isOurs ? pane.workspace_id : undefined
}
/**
 * herdr's sidebar renders $factory on each run's workspace and the rollup on the manager's. Only a patrol
 * tick from a pane whose directory is this factory's names the manager: a start or fork run for another
 * factory, or a background session forked from a manager, ticks from someone else's pane.
 * Only changes are reported, refreshed before the TTL, so a stopped factory's lapse.
 */
function showInSidebar(rows: Row[], now: number, isPatrol: boolean) {
  const { byWs, rollup } = tokens(rows)
  const file = join(HOME, 'sidebar.json')
  const was = existsSync(file)
    ? readJson<{ at: number; ws: Record<string, string>; manager?: string }>(file)
    : { at: 0, ws: {} as Record<string, string>, manager: undefined }
  const manager = isPatrol ? (managerWorkspace() ?? was.manager) : was.manager
  const want: Record<string, string> = { ...byWs, ...(manager && { [manager]: rollup }) }
  const isStale = now - was.at > SIDEBAR_TTL_MS / 2
  const report = (ws: string, token: string[]) =>
    // a workspace closed since is fine: nothing to show it on
    Bun.spawnSync(['herdr', 'workspace', 'report-metadata', ws, '--source', 'claude-factory', ...token])
  const changed = Object.entries(want).filter(([ws, text]) => isStale || was.ws[ws] !== text)
  const gone = Object.keys(was.ws).filter(ws => !(ws in want))
  for (const [ws, text] of changed)
    report(ws, ['--token', `factory=${text}`, '--ttl-ms', String(SIDEBAR_TTL_MS)])
  for (const ws of gone) report(ws, ['--clear-token', 'factory'])
  if (changed.length || gone.length || manager !== was.manager)
    writeJson(file, { at: isStale ? now : was.at, ws: want, manager })
}

type HerdrPane = {
  pane_id: string
  workspace_id: string
  cwd?: string
  agent?: string | null
  agent_status?: string
}
const herdrPanes = (): HerdrPane[] =>
  JSON.parse(Bun.spawnSync(['herdr', 'pane', 'list']).stdout.toString() || '{}').result?.panes ?? []
// herdr reuses workspace ids, so a run's workspace is still its own only while a pane there sits in its worktree
const isIn = (p: HerdrPane, r: Pick<Run, 'ws' | 'worktree'>) =>
  p.workspace_id === r.ws && !!p.cwd && (p.cwd === r.worktree || p.cwd.startsWith(`${r.worktree}/`))

/**
 * what herdr still holds that no run needs: a finished run's workspace (its worktree and branch stay for
 * `factory rm`), and a Claude idle in a live run's workspace that is not the run's worker (a duplicate
 * launch, a worker its run moved on from).
 */
export function reapable(
  runs: (Pick<Run, 'ws' | 'worktree'> & { isOver: boolean; pane?: string | null })[],
  panes: HerdrPane[],
) {
  const workspaces = runs.filter(r => r.isOver && panes.some(p => isIn(p, r))).map(r => r.ws)
  // ponytail: idle and done only; a working duplicate is left to finish, as closing it loses its turn
  const strays = runs
    // a remote worker has no pane here: the panes in its workspace are the person's
    .filter(r => !r.isOver && (!r.pane || runnerOf(r.pane).local))
    .flatMap(r =>
      panes.filter(
        p =>
          isIn(p, r) &&
          p.agent &&
          p.pane_id !== r.pane &&
          (p.agent_status === 'idle' || p.agent_status === 'done'),
      ),
    )
    .map(p => p.pane_id)
  return { workspaces: [...new Set(workspaces)], panes: strays }
}

function reap(rows: Row[]) {
  const runs = rows.flatMap(r => {
    if (!r.node || !existsSync(join(runDir(r.id), 'run.json'))) return []
    const run = loadRun(r.id)
    return [{ ...run, isOver: r.node === 'done' || r.node === 'aborted', pane: r.pane }]
  })
  const { workspaces, panes } = reapable(runs, herdrPanes())
  for (const ws of workspaces) Bun.spawnSync(['herdr', 'workspace', 'close', ws])
  for (const pane of panes) Bun.spawnSync(['herdr', 'pane', 'close', pane])
  for (const what of [...workspaces.map(w => `workspace ${w}`), ...panes.map(p => `pane ${p}`)])
    console.error(`${new Date().toISOString()} reaped ${what}`)
}

async function tick(isPatrol = false) {
  const release = hold('tick.lock')
  if (!release) return { busy: true }
  try {
    const now = Date.now()
    const out = {
      runs: [] as Row[],
      manager: [] as (Mail & { run: string })[],
      rigs: rigs(), // the manager's patrol works toward their goals
    }
    const halt = halted()
    for (const id of runIds()) {
      try {
        const { row, manager } = await tickRun(loadRun(id), now, halted())
        out.runs.push(row)
        out.manager.push(...manager)
      } catch (err) {
        out.runs.push({ id, error: (err as Error).message })
      }
    }
    out.manager.push(...skillMail(now))
    out.runs.push(...(existsSync(dispatchFile()) ? readJson<Row[]>(dispatchFile()) : []))
    out.runs.push(
      ...(existsSync(join(HOME, 'labels.json')) ? readJson<Row[]>(join(HOME, 'labels.json')) : []),
    )
    showInSidebar(out.runs, now, isPatrol)
    reap(out.runs)
    // stopped once no worker is still being told to stop: everything that was working has closed
    if (halt?.state === 'stopping' && !out.runs.some(r => r.agent === 'stopping'))
      writeJson(haltFile(), { ...halted()!, state: 'paused' })
    return { ...out, halt: halted()?.state }
  } finally {
    release()
    if (rigs().length || runIds().length) {
      kickBeads() // claims keep their heartbeat while halted; dispatch checks for itself
      if (!halted()) kickDream()
      kickDevenv()
    }
  }
}

// ponytail: lifecycle's sweep stations by name; a node flag if another factory grows its own
const SWEEPS = ['monitor', 'maintain', 'improve']
const sweepGoal = (station: string) => `sweep: ${station}`

export const missingSweeps = (
  def: Factory,
  rig: Pick<Rig, 'repo' | 'sweeps'>,
  runs: { repo: string; goal: string }[],
) =>
  (rig.sweeps ?? SWEEPS).filter(
    s => def.nodes[s] && !runs.some(r => r.repo === rig.repo && r.goal === sweepGoal(s)),
  )

/** each rig keeps one run per sweep it asks for: abort one to stop it, rm it to let it start again */
async function sweep() {
  if (halted()) return
  const runs = runIds().map(id => loadRun(id))
  for (const rig of rigs()) {
    try {
      const preview = await loadFactory(factorySource(rig.factory, rig.repo))
      for (const station of missingSweeps(preview, rig, runs)) {
        const goal = sweepGoal(station)
        await assertRoom(rig.repo)
        const linked = beadFor(rig.repo, goal)
        const { run, def } = await createTracked(rig.factory, preview.name, rig.repo, goal, linked.bead)
        if (station !== def.start) post(run.id, { type: 'GOTO', node: station })
        console.log(`${new Date().toISOString()} sweep ${station} for rig ${rig.name} → ${run.id}`)
      }
    } catch (err) {
      console.error(`${new Date().toISOString()} sweeps for rig ${rig.name}: ${(err as Error).message}`)
    }
  }
}

/** ticks forever, so runs advance, the rigs dispatch and their sweeps stay running with no console open */
async function loop(intervalMs: number) {
  for (;;) {
    await sweep()
    await tick()
    await Bun.sleep(intervalMs)
  }
}

/**
 * a run is a branch + herdr worktree + snapshot + the factory it follows, pinned so that no later edit,
 * its own included, changes the graph under it; a fork starts from another run's branch, snapshot and factory
 */
async function createRun(
  spec: string,
  repo: string,
  goal: string,
  { id, bead, from }: { id: string; bead?: string; from?: { run: Run; saved: Saved } },
) {
  const branch = `factory/${id}`
  const base = from?.run.base ?? freshBase(repo)
  const created = herdr(
    ...['worktree', 'create', '--cwd', repo, '--branch', branch, '--base', from?.run.branch ?? base],
    ...['--label', `${basename(repo)}/${id}`, '--no-focus', '--json'],
  )
  const ws: string = created.workspace.workspace_id
  const worktree: string = created.worktree.path
  const source = from ? from.run.factory : factorySource(spec, worktree)
  // pinned resolved, as data: a base it extends may change after the run starts
  const pinned = join(runDir(id), 'factory.json')
  mkdirSync(join(runDir(id), 'prompts'), { recursive: true })
  let def: Factory
  try {
    def = await loadFactory(source)
    writeJson(pinned, def)
  } catch (err) {
    herdr('worktree', 'remove', '--workspace', ws, '--force') // fresh, nothing in it yet
    rmSync(runDir(id), { recursive: true, force: true })
    throw new Error(
      `${relative(worktree, source)} at ${base.slice(0, 8)} is not a valid factory: ${(err as Error).message}`,
    )
  }
  const factoryFrom = from
    ? (from.run.factoryFrom ?? from.run.factory)
    : source.startsWith(worktree)
      ? `${relative(worktree, source)} at ${base.slice(0, 8)}`
      : source
  const run: Run = {
    id,
    factory: pinned,
    factoryFrom,
    repo,
    goal,
    branch,
    base,
    ws,
    worktree,
    ...(from && { forkedFrom: from.run.id }),
    ...(bead && { bead }),
  }
  // the source's worker stays the source's: the fork launches its own
  const snapshot = from
    ? {
        ...from.saved.snapshot,
        context: { ...from.saved.snapshot.context, pane: null, session: null, resumes: 0 },
      }
    : createActor(compile(def)).getPersistedSnapshot()
  writeJson(join(runDir(id), 'run.json'), run)
  writeJson(join(runDir(id), 'state.json'), { cursor: 0, snapshot })
  return { run, def }
}

/** creates the run with its bead claimed for it, giving the claim back if the run cannot be made */
async function createTracked(
  spec: string,
  name: string,
  repo: string,
  goal: string,
  bead?: string,
  from?: { run: Run; saved: Saved },
) {
  const id = `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`
  const b = beads(repo, actorOf(id))
  if (bead && !b.claim(bead)) fail(`${bead} is already claimed by another worker`)
  try {
    return await createRun(spec, repo, goal, { id, bead, from })
  } catch (err) {
    // deferred, not released: a dispatcher would otherwise retry the same failure every window
    if (bead) b.defer(bead, `could not start a run: ${clip((err as Error).message, 300)}`)
    throw err
  }
}

/** the bead a new run works: the one its goal names, or a new one when the repo tracks beads */
/** a run's tasks are its bead's children, and its release waits on every one: a bead whose children
 * already exist is worked child by child, a run each */
const openChildren = (b: ReturnType<typeof beads>, id: string) =>
  b.children(id).filter(x => x.status !== 'closed')

function beadFor(repo: string, goal: string, { extra = [] as string[], isOwnerOk = false } = {}) {
  if (!hasBeads(repo)) return { goal }
  const b = beads(repo, 'factory')
  const trimmed = goal.trim()
  const looksLikeId = /^[a-z][\w-]*-[\w.]+$/i.test(trimmed)
  let named: Bead | null = null
  if (looksLikeId) {
    try {
      named = b.lookup(trimmed)
    } catch (err) {
      fail(`could not look up bead ${trimmed} in ${repo}: ${(err as Error).message}; nothing was created`)
    }
    // not found: a goal shaped like this rig's own bead ids must never become a new bead titled with the
    // id text itself (claude-factory-5q3) -- a lookup failure above already failed the start; this is a
    // genuine "not found", so only refuse when the id would actually belong to this rig
    if (!named) {
      let prefix = ''
      try {
        prefix = b.prefixStrict()
      } catch (err) {
        fail(`could not look up bead ${trimmed} in ${repo}: ${(err as Error).message}; nothing was created`)
      }
      if (trimmed.toLowerCase().startsWith(`${prefix.toLowerCase()}-`))
        fail(`no bead ${trimmed} in ${repo}; nothing was created`)
    }
  }
  if (named) {
    if (isOwned(named) && !isOwnerOk)
      fail(
        `${named.id} carries its owner's decisions (metadata.owner_decisions): it is theirs to hand out. Start it only when the person names it, with --owned`,
      )
    const open = openChildren(b, named.id)
    if (open.length)
      fail(
        `${named.id} has ${open.length} open child bead(s), which its release would wait on: start those instead (${open
          .slice(0, 6)
          .map(x => `${x.id} ${x.status}`)
          .join(', ')})`,
      )
    return { goal: goalOf(named), bead: named.id }
  }
  return { goal, bead: b.create(clip(goal.split('\n')[0]!, 100), goal, ...extra) }
}

/**
 * a rig is a repo the factory works (Gas Town's rig): its ready `factory` beads start as runs, it keeps its
 * sweeps running, and `maxRuns` caps its own busy runs under the factory's FACTORY_MAX_RUNS. The factory's
 * rigs.json is written by `factory rig add` and can be edited by hand.
 */
export type Rig = {
  name: string
  repo: string
  factory: string
  maxRuns?: number
  sweeps?: string[]
  /** what the manager works toward there while the rig has room */
  goal?: string
  /** where its workers run: a name in the runner registry (src/runner.ts); herdr panes here when absent */
  runner?: string
  /** worker command for every station here, e.g. `codex --dangerously-bypass-approvals-and-sandbox` or `pi` */
  agent?: string
  /** MCP servers every worker here loads, a file in Claude's --mcp-config shape ({ mcpServers }) */
  mcp?: string
  /** extra HTTPS hosts its workers may reach (the ax runner's egress policy), and the vault keys injected for them */
  egress?: Egress[]
  /** env for its VM workers (the ax runner), over FACTORY_AX_ENV's: FACTORY_BAZELRC, say, for a remote cache */
  env?: Record<string, string>
  /**
   * a Dolt server VMs share the rig's beads through, instead of the repo's GitHub origin: `name` is the remote
   * in the laptop's store, `url` the address a VM reaches it at (through the egress gateway, which injects the
   * password for `user`)
   */
  beadsRemote?: { name: string; url: string; user: string }
  /** the factory's params, set for this rig (`--param name=value`) */
  params?: Record<string, string>
}
const rigsFile = () => join(HOME, 'rigs.json')
const rigs = (): Rig[] => (existsSync(rigsFile()) ? readJson(rigsFile()) : [])
const rigOf = (repo: string) => rigs().find(r => r.repo === repo)
const expand = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()))
const toplevel = (path: string) => git(expand(path), 'rev-parse', '--show-toplevel')
/** a rig's name stands for its repo wherever a command takes one; a path says so (`/`, `.` or `~`) */
const repoOf = (arg: string) =>
  rigs().find(r => r.name === arg)?.repo ??
  (/^[.~]|\//.test(arg)
    ? toplevel(arg)
    : fail(
        `no rig "${arg}" in the factory ${HOME} (rigs: ${
          rigs()
            .map(r => r.name)
            .join(', ') || 'none'
        })`,
      ))

/** how many more runs may hold a worker in `rig`, given the rigs of the runs that hold one now */
export const room = (
  rig: Pick<Rig, 'name' | 'maxRuns'> | undefined,
  busy: (string | undefined)[],
  max = MAX_BUSY,
) =>
  Math.min(
    max - busy.length,
    rig?.maxRuns === undefined ? Infinity : rig.maxRuns - busy.filter(b => b === rig.name).length,
  )

/** the rigs' ready `factory` beads become runs while each rig, and the factory, has room */
/** what the last dispatch could not do, per rig: the board shows it as rows */
const dispatchFile = () => join(HOME, 'dispatch.json')
const syncFile = () => join(HOME, 'sync.json')

/** a rig with room that dispatch has nothing to start for and no goal to steer the manager by sits unnoticed unless the board says so */
export const idle = (rig: Pick<Rig, 'goal'>, ready: number) => !rig.goal && ready === 0

async function dispatch() {
  const stamp = join(HOME, 'dispatch.stamp')
  if (halted() || !rigs().length || (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < DISPATCH_MS))
    return
  writeFileSync(stamp, '')
  const errors: Row[] = []
  const busy = await busyRigs()
  // live runs only: a finished run's deferred bead, undeferred by a person, is new work again
  const linked = new Set(
    runIds().flatMap(id => {
      const { run, value } = current(id)
      return run.bead && !['done', 'aborted'].includes(where(value)[0]) ? [run.bead] : []
    }),
  )
  // a sync's error stands until the next sync: dispatch passes every 30 s would clear it
  const synced = existsSync(syncFile())
    ? readJson<Record<string, { at: number; error?: string }>>(syncFile())
    : {}
  for (const rig of rigs()) {
    try {
      const preview = await loadFactory(factorySource(rig.factory, rig.repo))
      const b = beads(rig.repo, 'factory')
      // full or not: our claims and closes reach other machines either way
      if (existsSync(join(rig.repo, '.beads')) && Date.now() - (synced[rig.repo]?.at ?? 0) > SYNC_MS) {
        synced[rig.repo] = { at: Date.now() } // a failing sync retries next interval, not every pass
        try {
          if (rig.beadsRemote) syncAsRemoteUser(rig)
          else b.sync()
        } catch (err) {
          synced[rig.repo]!.error = (err as Error).message
        }
        writeJson(syncFile(), synced)
      }
      const syncError = synced[rig.repo]?.error
      if (syncError) errors.push({ id: `rig:${rig.name}`, error: syncError }) // dispatch goes on: local beads are still true
      if (room(rig, busy) <= 0) continue // full: no more bd calls
      // children are looked up only for the candidates, until the rig is full
      const candidates = dispatchable(b.ready(), linked, Infinity).filter(
        x => !isOwned(x) && !openChildren(b, x.id).length,
      )
      if (idle(rig, candidates.length))
        errors.push({ id: `rig:${rig.name}`, rig: rig.name, idle: 'no goal, no ready beads' })
      for (const bead of candidates) {
        if (room(rig, busy) <= 0) break
        let run, def
        try {
          ;({ run, def } = await createTracked(rig.factory, preview.name, rig.repo, goalOf(bead), bead.id))
        } catch (err) {
          if (/already claimed/.test((err as Error).message)) continue // lost the race to another worker
          throw err
        }
        const at = stationOf(bead)
        if (at && at !== def.start && def.nodes[at]) post(run.id, { type: 'GOTO', node: at })
        busy.push(rig.name)
      }
    } catch (err) {
      errors.push({ id: `rig:${rig.name}`, error: (err as Error).message })
    }
  }
  writeJson(dispatchFile(), errors)
}

/** the rig of every run holding a worker; a wait or a gate costs nothing */
export type LabeledPr = {
  number: number
  url: string
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  labels: { name: string }[]
}
const reworkLabels = (pr: LabeledPr) => REWORK_LABELS.filter(name => pr.labels.some(l => l.name === name))
/** what a person's label on a pull request asks: close it (and its run), or a rework run for its conflicts or changes */
export function labelAction(pr: LabeledPr) {
  if (pr.labels.some(l => l.name === CLOSE_LABEL)) return 'close'
  if (!reworkLabels(pr).length) return undefined
  return pr.isCrossRepository ? 'fork' : 'rework' // a fork's branch is not ours to push
}
const asksOf = (pr: LabeledPr) =>
  `labeled ${reworkLabels(pr).join(' and ')}: ${reworkLabels(pr)
    .map(name =>
      name === CONFLICT_LABEL
        ? 'resolve its merge conflicts'
        : 'make the changes its reviews and checks ask for',
    )
    .join(' and ')}`
export const reworkGoal = (pr: LabeledPr) =>
  `Pull request #${pr.number} (${pr.url}) is stuck, ${asksOf(pr)}. Branch ${pr.headRefName}, base ${pr.baseRefName}.`
/** the live run a pull request belongs to: its branch is the run's, or the run's reports link it */
export const prOwner = (pr: Pick<LabeledPr, 'url' | 'headRefName'>, live: { id: string; log: Entry[] }[]) =>
  live.find(
    r =>
      pr.headRefName === `factory/${r.id}` ||
      r.log.some(e => [...prsIn(e.summary), ...mrsIn(e.summary)].includes(pr.url)),
  )?.id

/**
 * act on the labels pr-merger (or a person) puts on the rigs' pull requests: `close` closes the PR and
 * aborts the live run it belongs to; `conflict` or `rework` mails that run's station (so two workers never
 * push to one branch), or starts a rework run when no run owns it and the rig has room. The labels then
 * come off, so each acts once. Out of the tick, like dispatch.
 */
async function labelPass() {
  const stamp = join(HOME, 'labels.stamp')
  if (halted() || (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < LABELS_MS)) return
  writeFileSync(stamp, '')
  const errors: Row[] = []
  const busy = await busyRigs()
  const fields = 'number,url,headRefName,baseRefName,isCrossRepository,labels'
  const live = runIds()
    .map(id => ({ id, ...current(id) }))
    .filter(r => !['done', 'aborted'].includes(where(r.value)[0]))
    .map(r => ({ id: r.id, node: where(r.value)[0], log: r.c.log }))
  for (const rig of rigs()) {
    const cli = (bin: string, args: string[]) => {
      const p = Bun.spawnSync([bin, ...args], { cwd: rig.repo, timeout: 60_000 })
      if (p.exitCode !== 0)
        throw new Error(`${bin} ${args[0]} ${args[1]}: ${p.stderr.toString().trim().split('\n')[0]}`)
      return p.stdout.toString()
    }
    const gh = (...args: string[]) => cli('gh', args)
    const origin = originRef(rig.repo)
    // the same four calls on either forge
    const forge =
      origin?.forge === 'gitlab'
        ? {
            // GitLab's label filter ANDs, so it lists once a label; REST because `mr list` lacks the project ids
            list: (): LabeledPr[] => {
              const project = encodeURIComponent(`${origin.owner}/${origin.repo}`)
              const found = [CLOSE_LABEL, ...REWORK_LABELS].flatMap(label =>
                parseGitlabLabeled(
                  cli('glab', [
                    'api',
                    '--hostname',
                    origin.host,
                    `projects/${project}/merge_requests?state=opened&per_page=100&labels=${encodeURIComponent(label)}`,
                  ]),
                ),
              )
              return found.filter((pr, i) => found.findIndex(o => o.url === pr.url) === i)
            },
            comment: (pr: LabeledPr, body: string) =>
              cli('glab', ['mr', 'note', String(pr.number), '-m', body]),
            unlabel: (pr: LabeledPr, labels: string[]) =>
              cli('glab', ['mr', 'update', String(pr.number), '--unlabel', labels.join(',')]),
            close: (pr: LabeledPr, body: string) => {
              cli('glab', ['mr', 'note', String(pr.number), '-m', body])
              cli('glab', ['mr', 'close', String(pr.number)])
            },
          }
        : {
            list: (): LabeledPr[] => {
              const search = `label:${[CLOSE_LABEL, ...REWORK_LABELS].join(',')}` // a comma is OR in GitHub search
              return JSON.parse(gh('pr', 'list', '--state', 'open', '--search', search, '--json', fields))
            },
            comment: (pr: LabeledPr, body: string) => gh('pr', 'comment', String(pr.number), '--body', body),
            unlabel: (pr: LabeledPr, labels: string[]) =>
              gh('pr', 'edit', String(pr.number), '--remove-label', labels.join(',')),
            close: (pr: LabeledPr, body: string) => gh('pr', 'close', String(pr.number), '--comment', body),
          }
    try {
      const labeled = forge.list()
      for (const pr of labeled) {
        const action = labelAction(pr)
        const runId = prOwner(pr, live)
        if (action === 'close') {
          forge.close(pr, `Closed by claude-factory: labeled \`${CLOSE_LABEL}\`.`)
          if (runId) post(runId, { type: 'ABORT' })
          console.log(`${new Date().toISOString()} closed ${pr.url}${runId ? ` (run ${runId})` : ''}`)
        } else if (action === 'fork') {
          errors.push({
            id: `rig:${rig.name}`,
            error: `${pr.url} is labeled ${reworkLabels(pr).join(', ')} but comes from a fork: rework it there`,
          })
        } else if (action === 'rework' && runId) {
          const node = live.find(r => r.id === runId)!.node
          const text = `[factory] ${pr.url} was ${asksOf(pr)}. Do it as part of this station's work, or say on the pull request why not.`
          post(runId, { type: 'MAIL', from: 'factory', to: node, text })
          forge.unlabel(pr, reworkLabels(pr))
          forge.comment(pr, `Handed to claude-factory run \`${runId}\` (${node}), which owns this.`)
          console.log(`${new Date().toISOString()} rework ${pr.url} → its run ${runId} at ${node}`)
        } else if (action === 'rework' && room(rig, busy) > 0) {
          const { run } = await createTracked('rework', 'rework', rig.repo, reworkGoal(pr))
          busy.push(rig.name)
          forge.unlabel(pr, reworkLabels(pr))
          forge.comment(pr, `claude-factory run \`${run.id}\` is reworking this.`)
          console.log(`${new Date().toISOString()} rework ${pr.url} → ${run.id}`)
        }
      }
    } catch (err) {
      errors.push({ id: `rig:${rig.name}`, error: `labels: ${(err as Error).message}` })
    }
  }
  writeJson(join(HOME, 'labels.json'), errors)
}

/**
 * why a station parked on pull requests should wake, if it should: one was updated after it parked (a merge
 * or a close updates it too), or none is open, so nothing will change them (a deploy waiting on CI after
 * the merge, say) and it wakes on the timer it would have had without links
 */
export function watchWake(
  prs: { url: string; state: string; updatedAt: string }[],
  parkedAt: number,
  now: number,
  plainMin: number,
) {
  const changed = prs.find(p => Date.parse(p.updatedAt) > parkedAt)
  if (changed)
    return `[factory] ${changed.url} changed since you parked: it is ${changed.state.toLowerCase()}, updated ${changed.updatedAt}. Check where it stands now.`
  if (prs.length && !prs.some(p => p.state === 'OPEN') && now - parkedAt >= plainMin * 60_000)
    return `[factory] None of the pull requests you linked is open, so they will not change: check again whether what you wait on is done.`
}

/**
 * a station parked on pull requests (its blocked report links them) is woken by mail when one is updated
 * after it parked: merged, closed, reviewed, commented on or pushed to. A gh call each instead of a worker each re-check.
 */
async function watchPass() {
  const stamp = join(HOME, 'watch.stamp')
  if (halted() || (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < WATCH_MS)) return
  writeFileSync(stamp, '')
  for (const id of runIds()) {
    try {
      const { run, value, c } = current(id)
      const [node, sub] = where(value)
      if (sub !== 'waiting' || !isParked(c, node)) continue
      const parked = c.log.at(-1)!
      const ghPrs = prsIn(parked.summary).flatMap(url => {
        const p = Bun.spawnSync(['gh', 'pr', 'view', url, '--json', 'state,updatedAt'], {
          cwd: run.repo,
          timeout: 60_000,
        })
        // gh down or the PR gone: the park's own timer still wakes it
        return p.exitCode === 0 ? [{ url, ...JSON.parse(p.stdout.toString()) }] : []
      })
      // a GitLab merge request is viewed the way `factory prs` does; glab down or it gone: same timer
      const mrs = await Promise.all(
        mrsIn(parked.summary).map(async url => {
          const v = await gitlabForge(spawnGlab).view(url, run.repo)
          return 'viewed' in v ? [{ url, state: v.viewed.state, updatedAt: v.viewed.updatedAt }] : []
        }),
      )
      const prs = [...ghPrs, ...mrs.flat()]
      // the plain park this report would have had, had it linked nothing
      const plainMin = parkDelayMin(
        { ...c, log: c.log.slice(0, -1) },
        node,
        (await loadFactory(run.factory)).nodes[node]?.parkMin ?? 60,
      )
      const text = watchWake(prs, parked.at, Date.now(), plainMin)
      if (!text) continue
      post(id, { type: 'MAIL', from: 'factory', to: node, text })
      console.log(`${new Date().toISOString()} ${id}: waking ${node}: ${text}`)
    } catch {
      // removed mid-pass
    }
  }
}

async function busyRigs() {
  const busy: (string | undefined)[] = []
  for (const id of runIds()) {
    const { run, value } = current(id)
    const [node, sub] = where(value)
    const n = (await loadFactory(run.factory)).nodes[node]
    if (n && !n.gate && sub !== 'waiting') busy.push(rigOf(run.repo)?.name)
  }
  return busy
}

async function assertRoom(repo: string) {
  if (halted()) fail(`the factory is ${halted()!.state}: factory resume first`)
  const busy = await busyRigs()
  const rig = rigOf(repo)
  if (busy.length >= MAX_BUSY)
    fail(`${busy.length} runs are busy (FACTORY_MAX_RUNS=${MAX_BUSY}): finish, abort or rm one first`)
  if (room(rig, busy) <= 0)
    fail(`rig ${rig!.name} has ${rig!.maxRuns} busy runs, its maxRuns: finish, abort or rm one first`)
}

/** a rig as `rig add` defines it, checked: its repo tracks beads, its factory loads, its sweeps exist */
async function defineRig(
  name: string,
  path: string,
  factory: string,
  {
    max,
    sweeps,
    goal,
    runner,
    agent,
    mcp,
    params,
    egress,
  }: {
    max?: string
    sweeps?: string
    goal?: string
    runner?: string
    agent?: string
    mcp?: string
    params?: string[]
    egress?: string[]
  },
) {
  if (!/^[a-z0-9][\w-]*$/i.test(name)) fail(`a rig's name is letters, digits, - and _ (not "${name}")`)
  const repo = toplevel(path)
  if (!hasBeads(repo)) fail(`${repo} has no .beads: run bd init there first`)
  // a VM runs the agent headless: there is no trust dialog to wait at
  if ((runners[runner ?? DEFAULT_RUNNER]?.local ?? true) && !isTrusted(repo))
    console.warn(
      `warning: Claude does not trust ${repo} yet, so its runs wait to start: run claude there once and accept its trust dialog`,
    )
  const def = await loadFactory(factorySource(factory, repo))
  const rig: Rig = { name, repo, factory, ...(goal && { goal }), ...(agent && { agent }) }
  if (runner !== undefined) {
    if (!(runner in runners)) fail(`--runner is ${Object.keys(runners).join(', ')} (not "${runner}")`)
    if (runner !== DEFAULT_RUNNER) rig.runner = runner
  }
  const remote = runners[rig.runner ?? DEFAULT_RUNNER]!.local === false
  if (remote && mcp !== undefined)
    fail(`--mcp does not reach a ${rig.runner} worker: its servers' commands would have to exist in the VM`)
  if (remote && agent !== undefined && !harnessOf(agent))
    fail(`--agent for the ${rig.runner} runner is claude, codex or pi (not "${agent}")`)
  if (egress?.length) {
    if (!remote) fail('--egress applies to a runner with an egress policy: add --runner ax')
    let parsed: Egress[] | undefined
    try {
      parsed = egress.map(ax.parseEgress)
    } catch (err) {
      fail((err as Error).message)
    }
    rig.egress = parsed!
    for (const host of parsed!.flatMap(e => e.hosts).filter(h => ax.isRegistryHost(h)))
      console.warn(
        `warning: --egress ${host} is a package registry host; once a pkg-gate is on (FACTORY_AX_PKG_GATE), ` +
          `it is stripped from this rig's policy and never reaches the VM directly`,
      )
  }
  if (agent !== undefined && !agent.trim()) fail('--agent is the worker command, e.g. "codex --full-auto"')
  if (mcp !== undefined) {
    rig.mcp = expand(mcp)
    try {
      readMcp(rig.mcp)
    } catch (err) {
      fail(`--mcp ${mcp}: ${(err as Error).message}`)
    }
  }
  for (const p of params ?? []) {
    const [k, v] = [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]
    if (!p.includes('=') || !(k in (def.params ?? {})))
      fail(
        `--param is name=value, its name one of ${def.name}'s params: ${Object.keys(def.params ?? {}).join(', ') || 'none'} (not "${p}")`,
      )
    rig.params = { ...rig.params, [k]: v }
  }
  if (max !== undefined) {
    if (!/^[1-9]\d*$/.test(max)) fail(`--max is a number of runs, at least 1 (not "${max}")`)
    rig.maxRuns = Number(max)
  }
  if (sweeps !== undefined) {
    rig.sweeps = sweeps === 'none' ? [] : sweeps.split(',')
    const unknown = rig.sweeps.filter(s => !SWEEPS.includes(s) || !def.nodes[s])
    if (unknown.length)
      fail(
        `no sweep ${unknown.join(', ')} in ${def.name}: ${SWEEPS.filter(s => def.nodes[s]).join(', ') || 'none'}`,
      )
  }
  return rig
}

async function start(factory: string | undefined, repo: string | undefined, goal: string, isOwnerOk = false) {
  if (!factory || !repo || !goal) fail('usage: factory start <factory>[@station] <rig|repo> <goal...>')
  const root = repoOf(repo!)
  await assertRoom(root)
  // <factory>@<station> starts past the triage when the caller already knows the kind of work
  const [spec, at] = factory!.split(/@(?=[^@/]+$)/)
  // the checkout's version answers the station question; the run pins the version its own commit holds
  const preview = await loadFactory(factorySource(spec!, root))
  if (at && !preview.nodes[at])
    fail(`no station "${at}" in ${preview.name}: ${Object.keys(preview.nodes).join(', ')}`)
  const linked = beadFor(root, goal, { isOwnerOk })
  const { run, def } = await createTracked(spec!, preview.name, root, linked.goal, linked.bead)
  if (at && at !== def.start && def.nodes[at]) post(run.id, { type: 'GOTO', node: at })
  await tick() // launches the first worker now rather than at the next tick
  console.log(
    `started ${run.id} in ${run.worktree} (herdr workspace ${run.ws}), following ${run.factoryFrom}${run.bead ? `, bead ${run.bead}` : ''}`,
  )
}

async function fork(id: string | undefined, station: string | undefined, note: string) {
  const { run: src, value } = current(id)
  const def = await loadFactory(src.factory)
  if (!def.nodes[station ?? ''])
    fail(`usage: factory fork <run> <station> [note...]; stations: ${Object.keys(def.nodes).join(', ')}`)
  await assertRoom(src.repo)
  const saved = readJson<Saved>(join(runDir(src.id), 'state.json'))
  const bead = src.bead
    ? beads(src.repo, 'factory').create(
        `fork of ${src.bead}${note ? `: ${clip(note, 80)}` : ''}`,
        `${src.goal}\n\nForked from run ${src.id} at ${station}. ${note}`,
        ...['--deps', `related:${src.bead}`],
      )
    : undefined
  const { run } = await createTracked(src.factory, def.name, src.repo, src.goal, bead, { run: src, saved })
  const [node, sub] = where(value)
  if (node !== station || sub !== 'working') post(run.id, { type: 'GOTO', node: station! })
  if (note) post(run.id, { type: 'MAIL', from: 'manager', to: station!, text: note })
  await tick()
  console.log(`forked ${src.id} at ${station} into ${run.id}: branch ${run.branch} from ${src.branch}`)
}

function current(id: string | undefined) {
  const run = loadRun(id)
  const saved = readJson<Saved>(join(runDir(run.id), 'state.json'))
  return { run, value: saved.snapshot.value, c: saved.snapshot.context }
}

/** everything the manager's run view draws, in one read */
async function show(id: string | undefined) {
  const { run, value, c } = current(id)
  const def = await loadFactory(run.factory)
  const [node, sub] = where(value)
  const tasks = run.bead ? beads(run.repo, 'factory').children(run.bead) : null
  return {
    ...row(run, def, value, c, agentOf(def, value, c)),
    seq: c.seq,
    wakeAt: c.wakeAt,
    startedAt: c.startedAt,
    run: { ...run, factory: run.factoryFrom ?? run.factory },
    log: c.log,
    inbox: unread(c, node),
    start: def.start,
    stations: Object.entries(def.nodes).map(([sid, n]) => ({
      id: sid,
      gate: n.gate === true,
      next: Object.entries(n.next).map(([outcome, edge]) =>
        typeof edge === 'string' ? { outcome, to: edge } : { outcome, ...edge },
      ),
    })),
    tasks: tasks?.map(t => ({ id: t.id, title: t.title, status: t.status ?? 'open' })) ?? null,
    isWorking: sub === 'working',
  }
}

/** each rig's work: what the factory will start, and what waits for a person to queue it */
async function backlog() {
  const busy = await busyRigs()
  return rigs().map(rig => {
    const w = { ...rig, busy: busy.filter(b => b === rig.name).length }
    try {
      const b = beads(rig.repo, 'factory')
      // three listings a rig, whatever its size: ready, blocked and every bead (child counts)
      return { ...w, ...backlogOf(b.ready(), b.unqueued(), b.blocked(), b.every()) }
    } catch (err) {
      return { ...w, queued: [], unqueued: [], error: (err as Error).message }
    }
  })
}

/** a repo's origin remote, split into the owner and name: `gh search prs --owner` and the run's own repo
 * for role()'s `sameRepo`. On GitLab the owner is the namespace (group/sub) and the name the project.
 * undefined when there is no origin (neither a GitHub nor a GitLab remote, or none) */
function originRef(
  repoPath: string,
): { owner: string; repo: string; forge: ForgeKind; host: string } | undefined {
  const p = Bun.spawnSync(['git', '-C', repoPath, 'remote', 'get-url', 'origin'])
  if (p.exitCode !== 0) return undefined
  const url = p.stdout.toString().trim()
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url)
  if (m) return { owner: m[1]!, repo: m[2]!, forge: 'github', host: 'github.com' }
  const remote = parseRemote(url)
  if (!remote || forgeOf(remote.host, glabKnows) !== 'gitlab') return undefined
  const parts = remote.path.split('/')
  if (parts.length < 2) return undefined
  return { owner: parts.slice(0, -1).join('/'), repo: parts.at(-1)!, forge: 'gitlab', host: remote.host }
}

/** whether `glab` is signed in to a host: how a self-hosted GitLab without "gitlab" in its name is told */
const glabKnows = (host: string) =>
  Bun.spawnSync(['glab', 'auth', 'status', '--hostname', host]).exitCode === 0

const prsFile = (id: string) => join(runDir(id), 'prs.json')

/**
 * every run's own pull requests (AC1): mentions out of its reports and mail, corroborated by its rig's
 * branch listing or a search for its bead, kept and refreshed in runs/<id>/prs.json so a restart loses
 * nothing (AC6). Draft, merged and closed PRs stay listed; the budget (src/prs.ts DEFAULT_BUDGET) spends
 * at most 10 searches and 30 `gh pr view` calls a call, live runs first.
 */
async function prs() {
  const stations = new Set<string>()
  const metas: { id: string; rig?: string; bead?: string; node: string; ended: boolean; at: number }[] = []
  const runMetas: RunMeta[] = []
  const before = new Map<string, PrsFile>() // wyc.7: only a changed prs.json is written back
  // wyc.7: memoized per repo path, so N runs sharing a rig's repo spawn `git remote get-url` once
  const originCache = new Map<string, ReturnType<typeof originRef>>()
  const cachedOriginRef = (repoPath: string) => {
    if (!originCache.has(repoPath)) originCache.set(repoPath, originRef(repoPath))
    return originCache.get(repoPath)
  }
  for (const id of runIds()) {
    let run: Run
    try {
      run = loadRun(id)
    } catch {
      continue // removed mid-pass
    }
    // wyc.6: a run whose state.json is missing or unreadable, a corrupt inbox line, or anything else
    // unexpected must not fail every other run's PRs along with it
    try {
      const { value, c } = current(id)
      const [node] = where(value)
      const ended = ['done', 'aborted'].includes(node)
      const def = await loadFactory(run.factory).catch(() => undefined)
      if (def) for (const k of Object.keys(def.nodes)) stations.add(k)
      metas.push({ id, rig: rigOf(run.repo)?.name, bead: run.bead, node, ended, at: createdAt(id) })
      const ref = cachedOriginRef(run.repo)
      const mail = inboxLines(id)
        .flatMap(l => {
          try {
            return [JSON.parse(l) as { type: string; from: string; to: string; text: string; at: number }]
          } catch {
            return [] // one corrupt inbox line must not drop the rest
          }
        })
        .filter((e): e is { type: 'MAIL'; from: string; to: string; text: string; at: number } => e.type === 'MAIL')
      let file: PrsFile = { version: 1, prs: [] }
      if (existsSync(prsFile(id))) {
        try {
          // wyc.12: a prs.json that parses but isn't shaped like a PrsFile (e.g. {"version":1} with no
          // `prs` array) is normalized to empty here too, before it can reach buildPrs's foldMentions,
          // which throws a bare TypeError that (unlike a JSON.parse failure) this try/catch alone misses
          file = asPrsFile(readJson(prsFile(id)))
        } catch {
          // wyc.6: a corrupt prs.json is treated as empty rather than failing this run
        }
      }
      before.set(id, file)
      runMetas.push({
        id,
        bead: run.bead,
        startAt: createdAt(id),
        ended,
        endAt: ended ? (c.log.at(-1)?.at ?? createdAt(id)) : Infinity,
        repoDir: run.repo,
        runRepo: ref ? `${ref.owner}/${ref.repo}` : run.repo,
        owner: ref?.owner ?? '',
        forge: ref?.forge,
        host: ref?.host,
        log: c.log,
        mail,
        file,
      })
    } catch {
      continue // this run's own state is unreadable; the rest still get processed
    }
  }
  const { files, rows } = await buildPrs(runMetas, s => stations.has(s), spawnGh, Date.now(), DEFAULT_BUDGET)
  for (const [id, file] of files) {
    if (sameFile(before.get(id) ?? { version: 1, prs: [] }, file)) continue // wyc.7: unchanged, skip the write
    try {
      writeJson(prsFile(id), file)
    } catch {
      // the run was removed mid-pass: nothing to write back to
    }
  }
  const metaById = new Map(metas.map(m => [m.id, m]))
  return rows.flatMap(({ run: id, prs: all, error }) => {
    const m = metaById.get(id)
    return m ? [{ run: id, rig: m.rig, bead: m.bead, node: m.node, ended: m.ended, at: m.at, error, prs: all }] : []
  })
}

type DecisionBead = { id: string; title: string; description?: string; kind: 'bead' | 'owned' }
export type DecisionsRow = { rig: string; factory: string; beads: DecisionBead[]; error?: string }
export type Proposal = { question: string; options: string[]; at: number }

const decisionsFile = () => join(HOME, 'decisions.json')
const proposals = (): Record<string, Proposal> => (existsSync(decisionsFile()) ? readJson(decisionsFile()) : {})

/** each rig's open bd decisions: beads flagged for a person and ready, unassigned beads that are their call,
 * never the factory's; a rig's own bd failure is its error, the rest still listed. Plus any proposed options
 * the manager stored for an item that had none. */
function decisionsList() {
  const rows: DecisionsRow[] = rigs().map(rig => {
    try {
      const b = beads(rig.repo, 'factory')
      const slim = (kind: 'bead' | 'owned') => (x: Bead) => ({
        id: x.id,
        title: x.title,
        description: x.description,
        kind,
      })
      return {
        rig: rig.name,
        factory: rig.factory,
        beads: [...b.human().map(slim('bead')), ...b.owned().map(slim('owned'))],
      }
    } catch (err) {
      return { rig: rig.name, factory: rig.factory, beads: [], error: (err as Error).message }
    }
  })
  return { rigs: rows, proposals: proposals() }
}

/** the person's answer to a bd decision: a human-flagged bead is answered and closed, an owner-only one just
 * gets a comment (queuing or starting it is a separate choice, made in the console or with start --owned) */
function decisionsAnswer(rigName: string, id: string, text: string) {
  if (process.env.FACTORY_FROM) fail("a worker cannot answer the person's decisions: mail the manager instead")
  const b = beads(repoOf(rigName), 'factory/person')
  if (b.human().some(x => x.id === id)) b.respond(id, text)
  else b.comment(id, text)
  console.log(`answered ${id}`)
}

/** the manager proposes 2+ options for an item the person would otherwise have to answer in their own words;
 * never for a gate, which only the person decides, and never for a blocked-on-prompt item, which waits on the
 * person looking at the worker's pane rather than on a choice */
function decisionsPropose(key: string, question: string, optionsLine: string) {
  if (process.env.FACTORY_FROM) fail("a worker cannot propose the person's decisions: mail the manager instead")
  if (/^gate:/.test(key)) fail('a gate is decided by the person, never proposed options')
  if (/^prompt:/.test(key)) fail('a blocked worker is looked at, never proposed options')
  if (!/^(iv|bd|own):/.test(key)) fail(`malformed decision key "${key}"`)
  const options = optionsLine
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
  if (options.length < 2) fail('give at least two options, separated by |')
  const all = proposals()
  all[key] = { question, options, at: Date.now() }
  mkdirSync(HOME, { recursive: true })
  writeJson(decisionsFile(), all)
  console.log(`proposed options for ${key}`)
}

/** the runs metrics count: every live run, and the ones factory rm kept in metrics.jsonl */
/** what each Claude worker session of a run spent, from the transcripts in its worktree's project dir */
function sessionsOf(run: Run): Session[] {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'projects',
    run.worktree.replace(/[^a-zA-Z0-9]/g, '-'),
  )
  if (!existsSync(dir)) return []
  const prompts = join(runDir(run.id), 'prompts')
  const nodes = new Map(
    (existsSync(prompts) ? readdirSync(prompts) : []).flatMap(f => {
      const m = /^(\d+)-(.+)\.md$/.exec(f)
      return m ? [[Number(m[1]), m[2]!.replace(/-resume$/, '')] as const] : []
    }),
  )
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => sessionOf(readFileSync(join(dir, f), 'utf8').split('\n'), run.id, seq => nodes.get(seq) ?? '?'))
    .filter(s => s.turns > 0)
}

function records(): RunRecord[] {
  const file = join(HOME, 'metrics.jsonl')
  const kept: RunRecord[] = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
  const live = runIds().map(id => record(id))
  const liveIds = new Set(live.map(r => r.id))
  return [...kept.filter(r => !liveIds.has(r.id)), ...live]
}
function record(id: string): RunRecord {
  const { run, value, c } = current(id)
  return { id, rig: rigOf(run.repo)?.name, node: where(value)[0], createdAt: createdAt(id), log: c.log }
}

async function status(id: string | undefined) {
  const halt = halted()
  if (halt && !id)
    console.log(
      halt.state === 'paused'
        ? `PAUSED since ${clock(halt.at)}: ${Object.keys(halt.closed).length} worker(s) wait for factory resume`
        : `STOPPING since ${clock(halt.at)}: workers are committing and going quiet`,
    )
  if (!runIds().length) console.log('no runs yet: factory start <factory> <repo> <goal...>')
  for (const runId of id ? [id] : runIds()) {
    const { run, value, c } = current(runId)
    const def = await loadFactory(run.factory)
    const r = row(run, def, value, c, agentOf(def, value, c))
    const at = r.sub ? `${r.node}/${r.sub}` : r.node
    console.log(`${r.id}  ${at}  try ${r.attempt}/${r.attempts}  pane ${r.pane ?? '-'} (${r.agent ?? '-'})`)
    // a bead's goal carries its whole description: bd show <bead> has it
    console.log(`  goal: ${clip(r.goal!.split('\n')[0]!, 200)}`)
    if (id) console.log(`  factory: ${run.factoryFrom ?? run.factory}`)
    if (r.error) console.log(`  error: ${r.error}`)
    if (id && run.bead) {
      const tasks = beads(run.repo, 'factory').children(run.bead)
      const closed = tasks.filter(t => t.status === 'closed').length
      console.log(`  bead: ${run.bead}, tasks ${closed}/${tasks.length} closed (bd children ${run.bead})`)
    } else if (run.bead) console.log(`  bead: ${run.bead}`)
    if (r.gate)
      console.log(
        `  gate: ${r.gate.question}\n  decide: factory decide ${r.id} <${r.gate.outcomes.join('|')}> [note]`,
      )
    const mail = Object.keys(c.mail).filter(box => unread(c, box).length)
    if (mail.length) console.log(`  unread: ${mail.map(box => `${box} ${unread(c, box).length}`).join(', ')}`)
    for (const e of id ? c.log : c.log.slice(-1))
      console.log(`  ${e.node}#${e.attempt} ${e.outcome}: ${e.summary.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
}

const [cmd, ...args] = process.argv.slice(2)
const usage = `factory — herdr software factories on xstate

  start <factory>[@station] <rig|repo> <goal...|bead> [--owned]   new run: herdr worktree off the repo, first worker
                                     launched; --owned starts a bead carrying its owner's decisions, when they ask
  init <dir>                         a new factory: a directory whose rigs and runs commands run in it work
  rig [add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--runner ${Object.keys(runners).join('|')}] [--agent cmd] [--mcp file] [--param name=value]... [--egress host[,host]...[=KEY[:Header:Prefix]]]... [--goal text...] | rm <name>]   the factory's
                                     rigs: repos whose ready beads labeled factory start as runs, each with its
                                     own cap, sweeps, runner (where workers run) and a goal the manager works toward; --agent runs every
                                     station as that command (claude, codex or pi), --mcp gives its workers
                                     the MCP servers in a Claude-shaped mcpServers file; --egress (repeatable, runner ax) lets the VM reach
                                     those hosts, injecting the agent-vault credential KEY for them
  adopt <rig|repo> [template]        copy a factory into <repo>/.factory/ for the repo to own and improve
  queue <rig|repo> <bead> [station]  hand a bead to the factory (labels it factory)
  show <run> | backlog | prs         JSON for the manager's views
  decisions [answer <rig> <bead> <text...> | propose <key> "<question>" "<a | b>"]   JSON of every rig's open
                                     bd decisions (human-flagged and owner-only beads); answer one, as the
                                     person, or let the manager propose options for an item that has none
  metrics [--rig r] [--since 7d] [--json]   how the factory performs: fates, ship rate, time to ship and on
                                     the approve gate, review loops, failures by kind, each station's outcomes
  check <factory file>               validate a factory: graph, outcomes, a way to done from every station
  status [run]                       runs at a glance, or one run's full log
  waiting                            everything that waits on the person, by rig, and how to answer each
  manager [claude args...]           start this factory's manager here, lean: Bash and file tools, no MCP servers
  home                               the factory these commands work: FACTORY_HOME, else found from here
  stop | resume                      graceful shutdown: workers commit and wait, their panes close, nothing
                                     launches or dispatches; resume brings each back in its own conversation
  memory search [--rig r] <query...>  the closest notes in the factory's shared memory (semantic search)
  memory add [--rig r] [--from run/station] [--anyway] <summary> [body...]   save a learning to the memory's
                                     inbox; one an existing note already says counts as that note helping
  memory helped <note path...>       a note helped: the dream ranks notes by this
  dream                              groom the memory now: file the inbox, merge, prune, learn from the journals
  skills [install <n> | reject <n> <why>]  the skills the dream proposed for the manager: list them, install one
                                     once reviewed, or reject it, saying why
                                     (each tick starts one a day)
  beads                              one pass of the runs' bead bookkeeping and the rigs' dispatch (each tick starts one)
  tick | loop [--interval ms]        advance every run once, or forever (default 5s), keeping the rigs' sweeps running
  report <run> <seq> <outcome> <summary...>   worker: finish its station
  worker serve [--model m] | poll <cursor> | prompt <base64>   inside an AX task: the worker's Claude, its
                                     state and outbox, a prompt queued for it (docs/remote-runner.md)
  pkg-gate serve [--port 8080]       an age-gating registry proxy for go/npm/pypi (PKG_GATE_MIN_DAYS,
                                     PKG_GATE_ALLOWLIST_GO/_NPM/_PYPI colon-separated, one per ecosystem);
                                     GET /healthz for its counters
  decide <run> <outcome> [note...]   the person: answer a gate station
  mail <run> <node|manager> <text...>         drop a message in a mailbox
  poke <run> [text...]               nudge the current station's worker: report, or say what blocks it
  retry <run> | goto <run> <node|done> | abort <run>   quarterback a run
  fork <run> <station> [note...]     new run from <run>'s branch and state, restarted at <station>
  rm <run>                           finished run: drop its worktree and state, keep its branch

<factory> is a path, or a name: the repo's own .factory/<name>.ts as of the commit a run starts from,
else the template in ${join(ROOT, 'factories')}. Each run pins its factory. This factory is ${HOME}
(FACTORY_HOME, else the nearest directory up holding a rigs.json). start and fork refuse past FACTORY_MAX_RUNS (${MAX_BUSY}) runs holding a worker,
or past the rig's own --max.
In a repo with .beads, every run works a bead: the one its goal names, or a new one.`

// inside an AX task the run lives on the laptop: what a worker reports, mails or learns waits in the outbox
const outboxCmd =
  import.meta.main &&
  !!process.env.FACTORY_OUTBOX &&
  (cmd === 'report' || cmd === 'mail' || (cmd === 'memory' && args[0] === 'add'))
// `--help`/`-h` and malformed args never reach the outbox: before this, `report --help` queued a fake report
// indistinguishable from a real one (claude-factory-4x1)
const outboxOk = outboxCmd ? worker.outboxUsage(cmd!, args) : null
if (outboxOk === 'help')
  console.log(worker.OUTBOX_USAGE[cmd === 'memory' ? 'memory' : cmd === 'mail' ? 'mail' : 'report'])
else if (outboxOk) {
  console.error(outboxOk)
  process.exit(1)
}
const queued = outboxCmd && outboxOk === null
if (queued) {
  // the station's bd writes go to GitHub before the report, so the laptop has them when it acts on it; a
  // report that went without them would end the VM, and its writes with it
  if (cmd === 'report' && !worker.syncBeads()) {
    console.error(
      'refused: your bd changes were not shared (bd dolt pull && bd dolt push failed); fix that, then report again',
    )
    process.exit(1)
  }
  worker.queue([cmd!, ...args])
  console.log(`queued for the factory: ${cmd}${cmd === 'report' ? '; you are done, stop now' : ''}`)
}

if (import.meta.main && !outboxCmd)
  try {
    switch (cmd) {
      case 'worker': {
        const [sub, arg] = args
        if (sub === 'serve') await worker.serve(arg === '--model' ? args[2] : undefined)
        else if (sub === 'poll') console.log(JSON.stringify(worker.poll(Number(arg ?? 0))))
        else if (sub === 'prompt' && arg) worker.prompt(arg)
        else if (sub === 'put' && args.length === 5)
          worker.put(arg!, Number(args[2]), Number(args[3]), args[4]!)
        else
          fail(
            'usage: factory worker serve [--model m] | poll <cursor> | prompt <base64> | put <name> <part> <parts> <base64>',
          )
        break
      }
      case 'pkg-gate': {
        const [sub] = args
        if (sub !== 'serve') fail('usage: factory pkg-gate serve [--port 8080]')
        const portIdx = args.indexOf('--port')
        const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined
        if (portIdx >= 0 && !Number.isFinite(port)) fail(`--port "${args[portIdx + 1]}" is not a number`)
        const upstream = {
          go: process.env.PKG_GATE_UPSTREAM_GO ?? pkggate.DEFAULT_UPSTREAM.go,
          npm: process.env.PKG_GATE_UPSTREAM_NPM ?? pkggate.DEFAULT_UPSTREAM.npm,
          pypi: process.env.PKG_GATE_UPSTREAM_PYPI ?? pkggate.DEFAULT_UPSTREAM.pypi,
          files: process.env.PKG_GATE_UPSTREAM_FILES ?? pkggate.DEFAULT_UPSTREAM.files,
        }
        const minDays = parsePkgGateMinDays(process.env.PKG_GATE_MIN_DAYS)
        const allowlist = parsePkgGateAllowlist(process.env)
        const server = pkggate.serve({
          upstream,
          ...(port !== undefined && { port }),
          ...(minDays !== undefined && { minDays }),
          ...(allowlist && { allowlist }),
        })
        console.log(`pkg-gate listening on :${server.port}, minDays=${minDays ?? 4}`)
        break
      }
      case 'start': {
        const words = args.slice(2)
        await start(args[0], args[1], words.filter(w => w !== '--owned').join(' '), words.includes('--owned'))
        break
      }
      case 'fork':
        await fork(args[0], args[1], args.slice(2).join(' '))
        break
      case 'tick':
        console.log(JSON.stringify(await tick(true)))
        break
      case 'beads':
        await beadsPass()
        break
      case 'manager':
        // ponytail: blocks until the manager exits; run it where it should live (a herdr pane)
        process.exit(await superviseManager(args))
      case 'home':
        console.log(HOME)
        break
      case 'stop': {
        if (halted()) fail(`already ${halted()!.state}`)
        writeJson(haltFile(), { state: 'stopping', at: Date.now(), told: {}, closed: {} })
        console.log(
          `stopping: each working worker is told to commit and wait; its pane closes once it is quiet, at most ${HALT_GRACE_MS / 60_000} min. Ticks carry it out; factory status shows it. factory resume brings them back.`,
        )
        break
      }
      case 'resume': {
        const halt = halted() ?? fail('the factory is not stopped')
        // the runs whose workers stop closed, at the station they were at: the next tick resumes each
        const back = existsSync(resumeFile_()) ? readJson<Record<string, number>>(resumeFile_()) : {}
        writeJson(resumeFile_(), { ...back, ...halt.closed })
        rmSync(haltFile())
        console.log(
          `resuming ${Object.keys(halt.closed).length} worker(s) in their own conversations at the next tick`,
        )
        break
      }
      case 'memory': {
        const opt = (flag: string) =>
          args.includes(flag) ? args.splice(args.indexOf(flag), 2)[1] : undefined
        const [rig, from] = [opt('--rig'), opt('--from')]
        const [sub, ...words] = args
        if (sub === 'search' && words.length) {
          const found = await memory.search(MEMORY, words.join(' '), { rig })
          memory.use(
            MEMORY,
            found.map(f => f.note.path),
            'shown',
          )
          console.log(
            found
              .map(({ note: n, score }) =>
                [
                  `${score.toFixed(2)}  ${join(MEMORY, n.path)}  [${memory.topicOf(n)}${n.rig ? `, ${n.rig}` : ''}]`,
                  `  ${n.summary}`,
                  ...clip(n.body, 800)
                    .split('\n')
                    .map(l => `    ${l}`),
                ].join('\n'),
              )
              .join('\n\n') || `nothing in ${MEMORY} yet`,
          )
        } else if (sub === 'add' && words[0]) {
          const isAnyway = words.includes('--anyway')
          const [summary, ...body] = words.filter(w => w !== '--anyway')
          const note = { summary: summary!, body: body.join(' '), rig }
          const dup = isAnyway ? null : await memory.same(MEMORY, note)
          if (dup) {
            // a hit, not a new note: the copy would only crowd search results until a dream merged it
            memory.use(MEMORY, [dup.note.path], 'helped')
            console.log(
              `already noted (${dup.score.toFixed(2)}): ${join(MEMORY, dup.note.path)}\n  ${dup.note.summary}\n` +
                `counted as helping instead. If yours adds something it lacks, add it again with --anyway.`,
            )
          } else {
            const at = new Date().toISOString().slice(0, 10)
            console.log(memory.add(MEMORY, { ...note, from, at }))
          }
        } else if (sub === 'helped' && words.length) {
          const paths = words.map(w => relative(MEMORY, resolve(MEMORY, w)))
          const bad = paths.filter(p => p.startsWith('..') || !existsSync(join(MEMORY, p)))
          if (bad.length) fail(`not a note in ${MEMORY}: ${bad.join(', ')}`)
          memory.use(MEMORY, paths, 'helped')
          console.log(`noted: ${paths.join(', ')}`)
        } else
          fail(
            'usage: factory memory search [--rig r] <query...> | add [--rig r] [--from run/station] [--anyway] <summary> [body...] | helped <note path...>',
          )
        break
      }
      case 'dream':
        console.log(await dream())
        break
      case 'devenv':
        console.log(
          devenvPass(
            args.filter(a => a !== '--force'),
            args.includes('--force'),
          ).join('\n'),
        )
        break
      case 'skills': {
        const [verb, name, ...why] = args
        if (!verb) console.log(JSON.stringify(memory.pendingSkills(MEMORY), null, 2))
        else if (verb === 'install') {
          memory.installSkill(MEMORY, name ?? fail('skills install <name>'))
          commitMemory(`the manager installed the skill ${name}`)
          console.log(`installed ${name}: the manager's Claude picks it up now`)
        } else if (verb === 'reject') {
          if (!why.length) fail('skills reject <name> <why>: the dream learns from the reason')
          memory.rejectSkill(MEMORY, name ?? fail('skills reject <name> <why>'), why.join(' '))
          commitMemory(`the manager rejected the skill ${name}`)
          console.log(`rejected ${name}; the dream reads why`)
        } else fail('skills [install <name> | reject <name> <why>]')
        break
      }
      case 'loop': {
        const ms = args[0] === '--interval' ? Number(args[1]) : 5000
        if (!(ms >= 1000)) fail('usage: factory loop [--interval ms], at least 1000')
        await loop(ms)
        break
      }
      case 'show':
        console.log(JSON.stringify(await show(args[0])))
        break
      case 'metrics': {
        const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
        const rig = opt('--rig')
        const since = opt('--since')
        const days = since === undefined ? Infinity : Number(since.replace(/d$/, ''))
        if (!(days > 0)) fail('usage: factory metrics [--rig r] [--since <days>d] [--json] [--tokens]')
        const picked = records().filter(
          r => (!rig || r.rig === rig) && Date.now() - r.createdAt < days * 86_400_000,
        )
        const groups = rig ? [rig] : [...new Set(picked.map(r => r.rig ?? '(no rig)'))]
        const of = (g: string) => metrics(picked.filter(r => (r.rig ?? '(no rig)') === g))
        if (args.includes('--json'))
          console.log(
            JSON.stringify({ all: metrics(picked), rigs: Object.fromEntries(groups.map(g => [g, of(g)])) }),
          )
        else {
          console.log(render(metrics(picked), `${basename(HOME)}${since ? `, last ${days}d` : ''}`))
          if (groups.length > 1) for (const g of groups) console.log('\n' + render(of(g), g))
        }
        if (args.includes('--tokens')) {
          const live = picked.filter(r => runIds().includes(r.id))
          console.log(
            '\n' +
              renderTokens(
                live.flatMap(r => sessionsOf(loadRun(r.id))),
                new Set(live.filter(r => fate(r) === 'shipped').map(r => r.id)),
              ),
          )
        }
        break
      }
      case 'backlog':
        console.log(JSON.stringify(await backlog()))
        break
      case 'prs':
        console.log(JSON.stringify(await prs()))
        break
      case 'decisions': {
        const [sub, ...rest] = args
        if (!sub || sub === 'list') {
          console.log(JSON.stringify(decisionsList()))
          break
        }
        if (sub === 'answer') {
          const [rigName, id, ...text] = rest
          if (!rigName || !id || !text.length) fail('usage: factory decisions answer <rig> <bead> <text...>')
          decisionsAnswer(rigName!, id!, text.join(' '))
          break
        }
        if (sub === 'propose') {
          const [key, question, optionsLine] = rest
          if (!key || !question || !optionsLine)
            fail('usage: factory decisions propose <key> "<question>" "<a | b>"')
          decisionsPropose(key!, question!, optionsLine!)
          break
        }
        fail(`unknown decisions command "${sub}": list, answer or propose`)
        break
      }
      case 'queue': {
        const [repo, id, station] = args
        if (!repo || !id) fail('usage: factory queue <rig|repo> <bead> [station]')
        const root = repoOf(repo!)
        beads(root, 'factory').queue(id!, station)
        console.log(
          `queued ${id}${station ? ` at ${station}` : ''}: ${rigOf(root) ? 'it starts at the next dispatch' : 'make the repo a rig (factory rig add) for it to start'}`,
        )
        break
      }
      case 'status':
        await status(args[0])
        break
      case 'waiting': {
        const rows = await Promise.all(
          runIds().map(async id => {
            const { run, value, c } = current(id)
            const def = await loadFactory(run.factory)
            return row(run, def, value, c, agentOf(def, value, c))
          }),
        )
        console.log(waiting(rows, Date.now()))
        break
      }
      case 'report': {
        const [id, seq, outcome, ...summary] = args
        const { run, value, c } = current(id)
        const [node] = where(value)
        const n = (await loadFactory(run.factory)).nodes[node]
        if (n?.gate) fail(`${node} is a gate: the person decides it, with factory decide`)
        const outcomes = Object.keys(n?.next ?? {}).concat(WORKER_OUTCOMES)
        if (Number(seq) !== c.seq)
          fail(`stale report: seq ${seq} is no longer the active worker (now ${c.seq}); stop here`)
        if (!outcomes.includes(outcome ?? '')) fail(`outcome must be one of: ${outcomes.join(', ')}`)
        const text = summary.join(' ')
        post(
          run.id,
          outcome === 'fail'
            ? { type: 'FAIL', seq: c.seq, reason: text }
            : outcome === 'blocked'
              ? { type: 'BLOCKED', seq: c.seq, reason: text }
              : outcome === 'handoff'
                ? { type: 'HANDOFF', seq: c.seq, summary: text }
                : { type: 'DONE', seq: c.seq, outcome: outcome!, summary: text },
        )
        console.log(`reported ${outcome} for ${node}; you are done, stop now`)
        break
      }
      case 'decide': {
        const [id, outcome, ...note] = args
        // ponytail: an env check, not a lock: it stops a worker deciding by habit, not one set on it
        if (process.env.FACTORY_FROM) fail('a worker cannot decide a gate: mail the manager instead')
        const { run, value, c } = current(id)
        const [node, sub] = where(value)
        const n = (await loadFactory(run.factory)).nodes[node]
        if (!n?.gate || sub !== 'working') fail(`${run.id} is not at a gate (it is at ${node})`)
        const outcomes = Object.keys(n!.next)
        if (!outcomes.includes(outcome ?? '')) fail(`decision must be one of: ${outcomes.join(', ')}`)
        const summary = note.join(' ') || `${outcome}, decided by the person`
        post(run.id, { type: 'DONE', seq: c.seq, outcome: outcome!, summary })
        console.log(`decided ${outcome} at ${node} of ${run.id}`)
        break
      }
      case 'mail': {
        const [id, to, ...text] = args
        const run = loadRun(id)
        const boxes = Object.keys((await loadFactory(run.factory)).nodes).concat('manager')
        if (!boxes.includes(to ?? '')) fail(`mailbox must be one of: ${boxes.join(', ')}`)
        post(run.id, {
          type: 'MAIL',
          from: process.env.FACTORY_FROM ?? 'manager',
          to: to!,
          text: text.join(' '),
        })
        console.log(`mailed ${to}`)
        break
      }
      case 'poke': {
        // the manager's nudge: lands in the current worker's session on the next tick
        const [id, ...text] = args
        const { run, value, c } = current(id)
        const [node, sub] = where(value)
        if (sub !== 'working' || (await loadFactory(run.factory)).nodes[node]?.gate)
          fail(`${run.id} has no worker to poke: it is at ${node}${sub ? `/${sub}` : ''}`)
        const nudge = `[factory] The manager is checking in. When you are finished run: ${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"; if something blocks you, mail the manager what it is.`
        post(run.id, { type: 'MAIL', from: 'manager', to: node, text: text.join(' ') || nudge })
        console.log(`poked ${node} of ${run.id}`)
        break
      }
      case 'retry':
        post(loadRun(args[0]).id, { type: 'RETRY' })
        break
      case 'goto': {
        const run = loadRun(args[0])
        const nodes = Object.keys((await loadFactory(run.factory)).nodes).concat('done')
        if (!nodes.includes(args[1] ?? '')) fail(`node must be one of: ${nodes.join(', ')}`)
        post(run.id, { type: 'GOTO', node: args[1]! })
        break
      }
      case 'abort':
        post(loadRun(args[0]).id, { type: 'ABORT' })
        break
      case 'init': {
        if (!args[0]) fail('usage: factory init <dir>')
        const dir = expand(args[0]!)
        if (existsSync(join(dir, 'rigs.json'))) fail(`${dir} is already a factory: factory rig add, there`)
        mkdirSync(dir, { recursive: true })
        writeJson(join(dir, 'rigs.json'), [])
        console.log(
          [
            `a new factory in ${dir}. Commands run in that directory work it; add its rigs there:`,
            `  cd ${dir} && ${CLI} rig add <name> <repo> [factory] [--max n] [--goal <what to work toward>]`,
            `and run its manager there: ${CLI} manager (fullscreen, so the console docks beside the chat; lean: no MCP servers, without herdr-fleet)`,
          ].join('\n'),
        )
        break
      }
      case 'adopt': {
        const [repo, name = 'lifecycle'] = args
        if (!repo) fail('usage: factory adopt <rig|repo> [template]')
        const root = repoOf(repo!)
        const target = join(root, OWN, `${name}.ts`)
        const template = join(ROOT, 'factories', `${name}.ts`)
        if (existsSync(target)) fail(`${target} exists: it is the repo's own now, edit it there`)
        if (!existsSync(template)) fail(`no template "${name}" in ${dirname(template)}`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, ownCopy(readFileSync(template, 'utf8'), name))
        await loadFactory(target)
        console.log(
          `wrote ${target}. Commit it: runs that start from a commit holding it follow it, and the factory improves it through its own runs.`,
        )
        break
      }
      case 'check': {
        if (!args[0]) fail('usage: factory check <factory file>')
        const def = await loadFactory(resolve(args[0]!))
        compile(def)
        const { unreachable, trapped } = reach(def)
        if (trapped.length) fail(`${def.name}: no way to done from ${trapped.join(', ')}`)
        console.log(`${def.name}: valid, ${Object.keys(def.nodes).length} stations from ${def.start}`)
        if (unreachable.length) console.log(`only reached by @station or goto: ${unreachable.join(', ')}`)
        break
      }
      case 'rig': {
        const opt = (flag: string) =>
          args.includes(flag) ? args.splice(args.indexOf(flag), 2)[1] : undefined
        // the goal is the rest of the line, so `/factory rig add ... --goal finish it` needs no quotes
        const goal = args.includes('--goal')
          ? args.splice(args.indexOf('--goal')).slice(1).join(' ')
          : undefined
        const [max, sweeps, runner, agent, mcp] = [
          opt('--max'),
          opt('--sweeps'),
          opt('--runner'),
          opt('--agent'),
          opt('--mcp'),
        ]
        const params: string[] = []
        while (args.includes('--param')) params.push(opt('--param') ?? '')
        const egress: string[] = []
        while (args.includes('--egress')) egress.push(opt('--egress') ?? '')
        const [sub = 'list', name, repo, factory = 'lifecycle'] = args
        if (sub === 'add') {
          if (!name || !repo)
            fail(
              `usage: factory rig add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--runner ${Object.keys(runners).join('|')}] [--agent cmd] [--mcp file] [--param name=value]... [--egress host[,host]...[=KEY[:Header:Prefix]]]... [--goal text...]`,
            )
          const rig = await defineRig(name!, repo!, factory, {
            max,
            sweeps,
            goal,
            runner,
            agent,
            mcp,
            params,
            egress,
          })
          mkdirSync(HOME, { recursive: true })
          // one rig per repo (runs find their rig by repo): redefining a rig replaces it, but a second
          // name for a rigged repo would silently drop the first
          const taken = rigs().find(r => r.repo === rig.repo && r.name !== rig.name)
          if (taken)
            fail(
              `${rig.repo} is already rig ${taken.name}: redefine it under that name, or rig rm ${taken.name} first`,
            )
          writeJson(rigsFile(), [...rigs().filter(r => r.name !== rig.name && r.repo !== rig.repo), rig])
          console.log(
            `rig ${rig.name}: ${rig.repo} runs ${factory}; its ready beads labeled factory start as runs${rig.maxRuns ? `, at most ${rig.maxRuns} busy` : ''}${rig.runner ? `, workers run by ${rig.runner}` : ''}`,
          )
        } else if (sub === 'rm') {
          if (!rigs().some(r => r.name === name))
            fail(
              `no rig "${name}" (rigs: ${
                rigs()
                  .map(r => r.name)
                  .join(', ') || 'none'
              })`,
            )
          writeJson(
            rigsFile(),
            rigs().filter(r => r.name !== name),
          )
          console.log(`removed rig ${name}: nothing new starts there; its runs carry on`)
        } else if (sub === 'list') {
          const busy = await busyRigs()
          if (!rigs().length) console.log('no rigs: factory rig add <name> <repo> [factory]')
          for (const r of rigs()) {
            const n = busy.filter(b => b === r.name).length
            console.log(
              `${r.name}  ${r.repo}  ${r.factory}  busy ${n}${r.maxRuns ? `/${r.maxRuns}` : ''}  sweeps ${(r.sweeps ?? SWEEPS).join(',') || 'none'}`,
            )
            if (r.goal) console.log(`  goal: ${r.goal}`)
            if (r.agent) console.log(`  agent: ${r.agent}`)
            if (r.mcp) console.log(`  mcp: ${r.mcp}`)
            for (const [k, v] of Object.entries(r.params ?? {})) console.log(`  param ${k}: ${v}`)
          }
        } else fail(`unknown rig command "${sub}": add, rm or list`)
        break
      }
      case 'rm': {
        const { run, value } = current(args[0])
        if (!['done', 'aborted'].includes(where(value)[0])) fail(`${run.id} is still running: abort it first`)
        // bd leaves its lock in every worktree it ran in: not work, and it would make the worktree look dirty
        rmSync(join(run.worktree, '.beads.gate.lock'), { force: true })
        // no --force: herdr and git refuse a worktree with uncommitted work; the branch always stays.
        // A reaped workspace is gone (and its id may be another's now): git removes the worktree then
        if (herdrPanes().some(p => isIn(p, run))) herdr('worktree', 'remove', '--workspace', run.ws)
        else if (existsSync(run.worktree)) git(run.repo, 'worktree', 'remove', run.worktree)
        // its record outlives it: metrics count removed runs too
        appendFileSync(join(HOME, 'metrics.jsonl'), JSON.stringify(record(run.id)) + '\n')
        rmSync(runDir(run.id), { recursive: true })
        console.log(`removed ${run.id}; its work stays on branch ${run.branch}`)
        break
      }
      default:
        console.log(usage)
        if (cmd && cmd !== 'help') process.exitCode = 2
    }
  } catch (err) {
    console.error(`factory: ${(err as Error).message}`)
    process.exitCode = 1
  }
