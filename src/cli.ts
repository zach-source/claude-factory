// The factory runner: owns .factory/, drives herdr, feeds the xstate machines.
// Only `tick` writes run state (under a lock); every other command appends to
// the run's inbox.jsonl, which the next tick drains in order.
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { createActor, type Snapshot } from 'xstate'
import {
  afterTimeout,
  compile,
  extend,
  fill,
  hasShipEdge,
  isMailHeld,
  isParked,
  isParkedOn,
  isPrWait,
  WORKER_OUTCOMES,
  parkDelayMin,
  prsIn,
  reach,
  shareOk,
  shouldHandToOwner,
  timeoutOf,
  unread,
  validate,
  gotoRefusal,
  where,
  type Ctx,
  type Edge,
  type Entry,
  type Extension,
  type Ev,
  type Factory,
  type Mail,
} from './machine'
import { watchDecide, type Seen, type WatchedPr } from './watch'
import {
  actorOf,
  backlogOf,
  beads,
  dispatchable,
  factoryOf,
  goalOf,
  shipBranchOf,
  hasBeads,
  isOwned,
  OWNER,
  REJECTED,
  LABEL,
  linearSourced,
  byId,
  parentOf,
  shipQueueText,
  stationOf,
  type Bead,
} from './beads'
import { clusterKey } from './filing-guard'
import * as plan from './plan'
import { parseAdvisoryInput, planAdvisories } from './advisories'
import { filingActor, filingGuard } from './filing-guard'
import {
  clipUtf8,
  dueSweeps,
  failedTests,
  flakeCandidates,
  flakyRuns,
  mainCiReds,
  newCiReds,
  type GhRun,
  guardHandled,
  markGuardHandled,
  pruneGuardState,
  sigOf,
  sweepFiler,
  sweepGoal,
  sweepGuard,
  sweepNames,
  type SweepGuardState,
  type SweepState,
} from './sweeps'
import * as gatebrief from './gatebrief'
import {
  CODEX_GUARD_FLAGS,
  CODEX_PIN,
  CODEX_UNGUARDED,
  claudeCommand,
  codexFeaturesBad,
  beadsOnlyCodexDir,
  codexSkills,
  command,
  cutOffCall,
  cutOffNote,
  harnessOf,
  piFlags,
  readMcp,
  sq,
  VM_PLUGINS,
  writeLaunch,
} from './harness'
import { hold as holdOf, shipLines, tokens, waiting } from './sidebar'
import { REPAIR_CAP, closableParents, repairs, type PrFact } from './repairs'
import { digestText, type DigestRig, type RepairLog } from './state'
import * as devenv from './devenv'
import * as gc from './gc'
import * as selfupdate from './selfupdate'
import * as memory from './memory'
import * as ax from './ax'
import type { Egress } from './ax'
import {
  type ConnectCache,
  type LinearRouting,
  type SyncOutcome,
  fetchLinearIssues,
  parseLinearList,
  parseLinearTeams,
  parseSync,
  pullArgs,
  redact,
  linearAuth,
  routeLinearIssue,
  syncEnv,
} from './linear'
import * as worker from './worker'
import { backupAge, backupError } from './homebackup'
import * as managerhost from './managerhost'
import * as migrate from './migrate'
import { bdEnv, httpsRemote, inAx, mapRigs, mapRunRepo, syncRepos } from './axrepos'
import * as broker from './broker'
import { AUTO_LABEL, autoPick, autoQueueOf, recentPicks, type AutoQueue } from './autoqueue'
import * as pkggate from './pkggate'
import { DEFAULT_RUNNER, runnerOf, runners, type Job, type Runner, type WorkerInfo } from './runner'
import { signingProbe } from './signing'
import {
  createdAt,
  fate,
  launchStats,
  metrics,
  parseLaunchLines,
  parsePrecheckLines,
  precheckStats,
  render,
  renderLaunches,
  renderTokens,
  sessionOf,
  type RunRecord,
  type ManagerUsage,
  tokensReport,
  type StoredUsage,
  validUsage,
  type Usage,
} from './metrics'
import {
  alreadyDone,
  asPrsFile,
  buildPrs,
  DEFAULT_BUDGET,
  evidenceLine,
  forgeNote,
  forgeOf,
  gitlabForge,
  githubCloseArgv,
  githubCommentArgv,
  githubMergedJson,
  githubUnlabelArgv,
  githubPullPath,
  githubPulls,
  githubRows,
  githubSlugOf,
  githubWatchView,
  parseGithubView,
  gitlabWatchNotes,
  mrsIn,
  onHost,
  parseGitlabLabeled,
  parseMergedPrs,
  shortBeadId,
  parseRemote,
  sameFile,
  spawnGh,
  spawnGlab,
  type ForgeKind,
  type Gh,
  type MergedPr,
  type PrsFile,
  type PrState,
  type RunMeta,
} from './prs'
import {
  digestLines,
  findHygiene,
  hygieneHeld,
  proposalComment,
  RECENT_COMMENT_MS,
  STALE_LABEL,
} from './hygiene'
import {
  nextSyncEntry,
  runBounded,
  syncDue,
  syncText,
  syncTimeoutMs,
  timedOutText,
  type SyncEntry,
} from './sync'
import { rmSafe } from './home-guard'

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
const MAX_BUSY = Number(process.env.FACTORY_MAX_RUNS ?? 16)
const DISPATCH_MS = 30_000 // how often the rigs' ready beads are looked at
const LABELS_MS = 2 * 60_000 // how often the rigs' pull requests are checked for the labels below
// ponytail: pr-merger's default label names; make them a rig setting when a repo uses others
const CLOSE_LABEL = 'close'
const CONFLICT_LABEL = 'conflict'
const REWORK_LABEL = 'rework'
const REWORK_LABELS = [CONFLICT_LABEL, REWORK_LABEL]
const WATCH_MS = 60_000 // how often the pull requests parked stations wait on are looked at
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
/** a bead requeued this many times gets deferred instead: a factory that always requeues never loops forever */
const REQUEUE_MAX = 5
const GRACE_MS = 90_000 // a worker idle this long without reporting gets nudged...
const STALL_MS = 20 * 60_000 // a working worker whose tail and branch head stand still this long is nudged, then failed
const NUDGES = 4 // ...this many times, each wait twice the last (90s to 24 min), then fails
// a worker whose Claude has not appeared this long after launch never started: the shell was still
// starting (direnv, under load) when herdr typed the command, and swallowed the Enter
const LAUNCH_MS = 90_000
/**
 * whether a run's AX task gets the rig's beads: a run with a bead, and a rig's ship run, whose stations read the
 * ship queue from bd and write its labels (claude-factory-pfc8)
 */
export const vmBeads = (run: Pick<Run, 'bead' | 'ship'>) => !!run.bead || !!run.ship

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
  /** a rig's ship run: only the runner writes this, and it counts against no run limit (claude-factory-rtuw) */
  ship?: true
}
type Saved = {
  cursor: number
  snapshot: Snapshot<unknown> & { value: unknown; context: Ctx }
  /** where bead bookkeeping was kept before it moved to track.json */
  track?: Track
}
/** bead bookkeeping, the beads pass's own file: journal entries mirrored, last heartbeat, whether track()
 * recorded the run's end, whether that ending was a requeue, and what last went wrong */
export type Track = {
  mirrored: number
  beatAt: number
  isSettled: boolean
  requeued?: boolean
  error?: string
}
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
  /** the model its station's worker runs (the agent command's --model or -m); absent at a gate or with no model flag */
  model?: string
  ws?: string
  error?: string | null
  last?: Entry
  gate?: { question: string; outcomes: string[]; brief?: string }
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
  /** dispatch.json only: why dispatch did not start this ready bead (or a full rig); tick drops these rows */
  skip?: string
  /** minutes its current worker has run */
  inMin?: number
  /** minutes since its worker's tail or branch head last changed */
  quietMin?: number
  /** when its runner's usage limit lifts, while the runner waits on it */
  limitUntil?: number
}

const runDir = (id: string) => join(HOME, 'runs', id)
// gc writes this before it removes prompts/ (claude-factory-503.1.2): the file names that were in
// it. Nothing reads it now: the usage rows keep their own station name (storeUsage).
const promptsListFile = (id: string) => join(runDir(id), 'prompts.list')
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
/** `factory manager --ax [args]`: run the manager as the long-lived AX task (claude-factory-192.2) */
async function launchAxManager(args: string[]) {
  const image = process.env.FACTORY_AX_MANAGER_IMAGE
  if (!image)
    fail('FACTORY_AX_MANAGER_IMAGE is not set: name the manager image (Dockerfile.worker, target manager)')
  const m = ax.remoteManager()
  if (m) fail(m)
  const { name, policy } = await ax.launchManager(image!, args, rawRigs())
  console.log(
    `the manager runs in AX task ${name}${policy ? '' : ' (its egress policy is NOT created: the task has no egress; check the AX controller)'}`,
  )
  console.log('attach with `factory attach`, steer with `factory say <text>`')
}
/** refuse to run a manager or a tick here while the AX manager task lives (claude-factory-192.6) */
const lease = () => {
  const m = ax.remoteManager()
  if (m) fail(m)
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
export function parsePkgGateAllowlist(
  env: Record<string, string | undefined>,
): pkggate.Allowlist | undefined {
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

const HERDR = () => process.env.FACTORY_HERDR ?? 'herdr'
/** herdr is optional. An AX-only rig, or a box with no local panes (a CI runner, say), may have none installed */
const herdrInstalled = () => Bun.which(HERDR()) !== null

function herdr(...args: string[]) {
  // a leading space keeps the typed launch out of the person's shell history (zsh HIST_IGNORE_SPACE, atuin)
  if (args[0] === 'pane' && args[1] === 'run') args = [...args.slice(0, 3), ` ${args[3]}`, ...args.slice(4)]
  const p = Bun.spawnSync([HERDR(), ...args])
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
  const p = Bun.spawnSync([HERDR(), 'pane', 'get', pane])
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
  /** the rig origin's GitHub owner, for the egress policy's per-owner key */
  githubOwner?: string
  /** the task runs as the reviewer identity: its egress policy holds the reviewer key (claude-factory-0gww.2) */
  reviewer?: boolean
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
function loadSeen(
  run: Run,
  task: string,
  lines: string[],
): { seen: Record<string, number>; missing: number } {
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
 * mail on its own run, memory add and helped. null for anything else (decide, goto, start...): the VM's agent writes the
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
  if (cmd === 'memory' && (id === 'add' || id === 'helped')) {
    const rest = argv.slice(2).filter((w, i, a) => w !== '--from' && a[i - 1] !== '--from')
    return ['memory', id, ...rest, '--from', `${run}/${side.node}`]
  }
  return null
}

const RUN_SCOPED = ['report', 'decide', 'mail', 'poke', 'retry', 'goto', 'abort']

/**
 * why a worker may not run this command: with FACTORY_RUN set, a run-scoped command must name exactly that run
 * (memory add|helped: the text before the first '/' of every --from). undefined when allowed or FACTORY_RUN is unset.
 * ponytail: an env check, not a lock; a worker can still write another run's inbox in a shared FACTORY_HOME
 */
export function otherRunRefusal(
  cmd: string | undefined,
  args: string[],
  env: Record<string, string | undefined>,
): string | undefined {
  const own = env.FACTORY_RUN
  if (!own) return undefined
  const named: (string | undefined)[] = []
  if (cmd && RUN_SCOPED.includes(cmd)) named.push(args[0])
  else if (cmd === 'memory' && (args[0] === 'add' || args[0] === 'helped'))
    args.forEach((a, i) => {
      if (a === '--from') named.push((args[i + 1] ?? '').split('/')[0])
    })
  return named.every(id => id === own)
    ? undefined
    : `refused: this worker belongs to run ${own} and cannot run ${cmd} for another run`
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
  // ponytail: in the AX task bd holds an embedded store and no Dolt server, so there is no SQL path to the remote's user:
  // plain `bd dolt push|pull` runs with DOLT_REMOTE_USER from env.json (axrepos). A pull conflict stops with bd's own
  // error, where the laptop's pullResolving keeps the VM's row; the manager reports it and a person resolves it
  if (!r || inAx()) return ['bd', 'dolt', way]
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
  const show = r && !inAx() ? Bun.spawnSync(['bd', 'dolt', 'show', '--json'], { cwd: run.worktree }) : null
  const conn = show?.exitCode === 0 ? (JSON.parse(show.stdout.toString()) as DoltConn) : undefined
  // the server's own user; its password, if it has one, as bd takes it
  const env = { ...process.env, DOLT_CLI_PASSWORD: process.env.BEADS_DOLT_PASSWORD ?? '' }
  const p = Bun.spawnSync(rigBeadsSync(r, way, conn), { cwd: run.worktree, env: bdEnv(run.repo, env) })
  // ponytail: only the issues table's conflicts are said on the issue; labels and the rest just take the VM's
  if (r && way === 'pull' && p.exitCode === 0)
    for (const { id, text } of overwritten(p.stdout.toString()))
      try {
        beads(run.repo, 'factory').comment(id, text)
      } catch {} // the issue the VM deleted: nothing to comment on
  return p
}

/** `syncRigBeads`, async, every call killed after the sync cap (FACTORY_SYNC_TIMEOUT_MS) */
async function syncRigBeadsBounded(
  run: Pick<Run, 'repo' | 'worktree'>,
  way: 'push' | 'pull',
  r: Rig['beadsRemote'],
) {
  const timeoutMs = syncTimeoutMs()
  const show =
    r && !inAx() ? await runBounded(['bd', 'dolt', 'show', '--json'], { cwd: run.worktree, timeoutMs }) : null
  if (show?.timedOut)
    return { code: null, out: '', err: timedOutText(`beads ${way}`, timeoutMs), timedOut: true }
  const conn = show?.code === 0 ? (JSON.parse(show.out) as DoltConn) : undefined
  const env = { ...process.env, DOLT_CLI_PASSWORD: process.env.BEADS_DOLT_PASSWORD ?? '' }
  const p = await runBounded(rigBeadsSync(r, way, conn), {
    cwd: run.worktree,
    env: bdEnv(run.repo, env),
    timeoutMs,
  })
  if (p.timedOut) return { ...p, err: timedOutText(`beads ${way}`, timeoutMs) }
  if (r && way === 'pull' && p.code === 0)
    for (const { id, text } of overwritten(p.out))
      try {
        beads(run.repo, 'factory').comment(id, text)
      } catch {} // the issue the VM deleted: nothing to comment on
  return p
}

/** the sync for a rig whose remote needs its user: `bd sync` would pull and push as the server's own */
async function syncAsRemoteUser(rig: Rig) {
  for (const way of ['pull', 'push'] as const) {
    const p = await syncRigBeadsBounded({ repo: rig.repo, worktree: rig.repo }, way, rig.beadsRemote)
    if (p.timedOut) throw new Error(p.err)
    if (p.code !== 0) throw new Error(`beads ${way}: ${p.err.trim().split('\n').at(-1) || 'failed'}`)
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
  if (phase === 'Pending') return { status: 'pending', agent: 'ax', pending: 'task phase Pending' }
  if (phase === 'Suspended') return { status: 'suspended', agent: 'ax' }
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
    if (!ax.createPolicy(task, side.egress, side.gitlabHost, side.githubOwner, undefined, side.reviewer))
      return { status: 'pending', agent: 'ax', pending: 'egress policy not created' }
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
      if (Date.now() - failedAt < PUT_GRACE_MS)
        return { status: 'pending', agent: 'ax', pending: `${name} not yet copied to the VM` }
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
    const env = {
      ...process.env,
      FACTORY_HOME: HOME,
      FACTORY_OUTBOX: '',
      FACTORY_FROM: side?.node,
      FACTORY_RUN: run.id,
    }
    const p = cmd ? Bun.spawnSync([CLI, ...cmd], { env }) : null
    if (!p)
      ax.prompt(
        task,
        `[factory] \`${argv?.join(' ') ?? line.slice(0, 200)}\` is not yours to run: a worker reports on its own attempt, mails, adds memory and says which memory helped`,
      )
    else if (p.exitCode !== 0)
      ax.prompt(task, `[factory] \`${argv!.join(' ')}\` was refused: ${p.stderr.toString().trim()}`)
    // the worker pushed before reporting, and the local worktree is what the next launch pushes back:
    // best effort, the report stands either way
    // the same for its bd writes, which it pushed where the rig's VMs share its beads
    else if (argv![0] === 'report') {
      try {
        const rows = validUsage(JSON.parse(line).usage, side!.node, side!.seq)
        if (rows.length) appendUsage(run.id, rows)
      } catch {} // a bad usage never changes the report
      Bun.spawnSync(['git', '-C', run.worktree, 'pull', '--ff-only', 'origin', run.branch])
      // from where this VM was told to push, which a rig changed since does not move
      if (vmBeads(run)) syncRigBeads(run, 'pull', side?.beadsRemote)
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
        limit: polled.limit,
      }
}

const herdrRunner: Runner = {
  name: 'herdr',
  local: true,
  launch: launchPane,
  info: (_run, pane) => paneInfo(pane),
  deliver: (pane, text) => (herdr('agent', 'prompt', pane, text), true),
  close: pane => void Bun.spawnSync([HERDR(), 'pane', 'close', pane]), // gone already is fine
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

// Every call here commits to the memory store, not a rig.
// `factory memory compact` and `dream` must still work on a box with no git identity set, for
// example a fresh CI runner or a fresh VM.
// Each call first checks with `git var GIT_AUTHOR_IDENT`.
// An env var, a repo, a global config or a system config that already names an identity wins.
// The fallback applies only when none of them name one.
const MEMORY_GIT_IDENTITY_FALLBACK = {
  GIT_AUTHOR_NAME: 'factory',
  GIT_AUTHOR_EMAIL: 'factory@localhost',
  GIT_COMMITTER_NAME: 'factory',
  GIT_COMMITTER_EMAIL: 'factory@localhost',
}
function git(cwd: string, ...args: string[]) {
  const probe = Bun.spawnSync(['git', '-C', cwd, 'var', 'GIT_AUTHOR_IDENT'], { env: process.env })
  const env = probe.exitCode === 0 ? process.env : { ...process.env, ...MEMORY_GIT_IDENTITY_FALLBACK }
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { env })
  return p.exitCode === 0 ? p.stdout.toString().trim() : fail(`git ${args[0]}: ${p.stderr.toString().trim()}`)
}

/** every git call that can reach a remote (fetch, ls-remote, push) gets this: a credential prompt
 * never blocks (it fails instead), and a timeout caps how long a hung connection can hold
 * gc-worktrees.lock (claude-factory-l38.12). It never skips hooks. */
const GIT_NETWORK_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const GIT_NETWORK_TIMEOUT_MS = 30_000

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
/**
 * The factory that a bead's `factory:<name>` label names (claude-factory-wnm), by name only. It
 * checks `repo`'s own `.factory/<name>.ts`, then this project's own `factories/<name>.ts`. It
 * returns undefined when neither holds the name.
 *
 * Unlike `factorySource`, it never takes a literal path. `factoryOf` already limits a label's name
 * to `NAME` (no path). This function stays name-only too, so a label can never pick an arbitrary
 * file on disk.
 */
const namedFactorySource = (name: string, repo: string) =>
  findIn(join(repo, OWN), name) ?? findIn(join(ROOT, 'factories'), name)
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

/** the queued PR's branch on origin, fetched, so a rework run starts on the PR's own commits; undefined when it is gone */
export function reworkBase(repo: string, branch: string) {
  if (!/^factory\/[\w.-]+$/.test(branch) || branch.includes('..')) return undefined
  Bun.spawnSync(['git', '-C', repo, 'fetch', '--quiet', 'origin', '--', branch], { timeout: 30_000 })
  const ref = `origin/${branch}`
  return Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref]).exitCode === 0
    ? ref
    : undefined
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
/** the message for a skill the worker image does not have, or none */
const unknownSkill = (skill: string, where: string) =>
  Object.hasOwn(VM_PLUGINS, skill)
    ? []
    : [`${where}: skill "${skill}" is not ${Object.keys(VM_PLUGINS).join(' or ')}`]

/**
 * The skills of a station's worker, on every backend: the sorted union of the factory's, the rig's and the station's.
 * A factory with no `skills` gives `asd-ste100`, so an older factory keeps its behavior.
 * A rig name outside the worker image refuses here, because a person edits rigs.json by hand.
 * `loadFactory` checks the other two layers (claude-factory-qda).
 */
export function workerSkills(
  def: { skills?: string[] },
  node: { skills?: string[] },
  rig?: { skills?: string[] },
) {
  const bad = (rig?.skills ?? []).flatMap(s => unknownSkill(s, 'rig'))
  if (bad.length) fail(bad.join('; '))
  return [
    ...new Set([...(def.skills ?? ['asd-ste100']), ...(rig?.skills ?? []), ...(node.skills ?? [])]),
  ].sort()
}
export const loadFactory = async (file: string): Promise<Factory> => {
  const def = validate(await readFactory(file))
  const badSkills = [
    ...(def.skills ?? []).flatMap(s => unknownSkill(s, `factory ${def.name}`)),
    ...Object.entries(def.nodes).flatMap(([id, n]) => (n.skills ?? []).flatMap(s => unknownSkill(s, id))),
  ]
  if (badSkills.length) throw new Error(`factory ${def.name}:\n  ${badSkills.join('\n  ')}`)
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
// runIds() without a run dir that has no state.json yet (createRun writes run.json, then state.json last)
const startedRunIds = () => runIds().filter(id => existsSync(join(runDir(id), 'state.json')))
function loadRun(id: string | undefined): Run {
  const file = join(runDir(id ?? ''), 'run.json')
  if (!existsSync(file)) fail(`no run "${id}" (runs: ${runIds().join(', ') || 'none'})`)
  const run: Run = readJson(file)
  // a run the laptop made names the laptop's repo path: in the AX task it is the rig's clone
  return inAx() ? { ...run, repo: mapRunRepo(rawRigs(), run.repo) } : run
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
/**
 * the cap on one prior report or mail placed whole into a station's brief or a delivered mid-run mail. A
 * report that pastes a diff or a log can run past 128 KiB. That broke two things: a station's own argv
 * (`claude -p <prompt>`) and a VM's base64'd `factory worker prompt` argv. Both sit under an OS or kernel
 * limit, Linux's MAX_ARG_STRLEN (131072 bytes) (claude-factory-kcg). A 1500-char journal line already fits
 * under this cap. This const guards the few spots that pasted a report's `.summary` or a mail's `.text` whole.
 */
export const REPORT_MAX = 32_000
// text.slice(0, max) can stop between the two UTF-16 code units of a surrogate pair (an emoji, say),
// leaving a lone lead surrogate. Back off by one unit in that case, so the cut never splits a pair.
const sliceWhole = (text: string, max: number) => {
  const lead = text.charCodeAt(max - 1)
  return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? max - 1 : max)
}
export const clipReport = (text: string) =>
  text.length <= REPORT_MAX
    ? text
    : `${sliceWhole(text, REPORT_MAX)}\n[clipped: ${REPORT_MAX} of ${text.length} chars]`
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * the House rules every worker's brief carries, plus the rig goal when the run's rig has one: the goal
 * verbatim, under its own section, so a step it reserves for the person (a skip list, say) binds every
 * station, not only the manager patrol that reads rigs.json directly. No rules and no goal: no output.
 */
export function ruleLines(
  def: Pick<Factory, 'rules'> & { name?: string },
  rigGoal?: string,
  personOnly?: string[],
  merge?: boolean,
): string[] {
  return [
    ...(def.rules ? ['', '## House rules', def.rules.trim()] : []),
    // claude-factory-l3tl: a person gave this rig merge authority; only the ship factory's release station uses it
    ...(merge && def.name === 'ship'
      ? [
          '',
          '## Merge authority',
          'A person gave this rig merge authority. The ship release station (and no other station) merges each queued pull request that is ready, has green CI and has passed reviews, with exactly: gh pr merge <number> --merge --match-head-commit <head SHA> -R <owner/repo of this rig> (-R is required). Never use --admin, --squash, --rebase or --auto. This overrides the House rule that only a person merges, for that one command.',
        ]
      : []),
    ...(rigGoal
      ? [
          '',
          '## Rig goal',
          rigGoal.trim(),
          'Each step this goal says to skip, or reserves for the person, is owner-only: a hard rule at every station.',
          ...(personOnly?.length
            ? [
                `In this rig only a person changes the live kube contexts ${personOnly.join(', ')}: the factory hook refuses kubectl, ko and helm changes there. Report blocked with: parked, waiting on: <the exact command>.`,
              ]
            : []),
        ]
      : []),
  ]
}

/** what a station's skills are for, by name (a name needs a line here; workerSkills accepts only image plugins) */
const SKILL_USE: Record<string, string> = {
  'asd-ste100':
    'Write every text a person reads in ASD-STE100: PR titles and bodies, commit messages, bead comments, reports, docs, code comments. Use short sentences, active voice and approved words. Before you write a PR body, a doc or a long report, load the asd-ste100 skill.',
}
const skillLines = (skills: string[]) =>
  skills.length
    ? ['', '## Skills', ...skills.map(s => `- ${s}: ${SKILL_USE[s] ?? 'load it when it applies'}`)]
    : []

export function brief(run: Run, def: Factory, node: string, c: Ctx, inbox: Mail[], notes = '') {
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
    ...ruleLines(
      def,
      rigOf(run.repo)?.goal,
      personOnlyContexts(rigOf(run.repo)),
      !!mergeAuthority(rigOf(run.repo)),
    ),
    ...skillLines(workerSkills(def, n, rigOf(run.repo))),
    '',
    ...remembered(run, node, notes),
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
    ...(lastFail ? ['', '## The previous attempt failed', clipReport(lastFail.summary)] : []),
    ...(n.onTimeout && afterTimeout(c, node)
      ? [
          '',
          '## The previous attempt timed out',
          `This attempt has ${n.onTimeout.timeoutMin} min.`,
          ...(n.onTimeout.prompt ? [n.onTimeout.prompt] : []),
        ]
      : []),
    ...(handedOff
      ? [
          '',
          '## You take over from a worker that handed off',
          'Its context grew too long, so it stopped and left you these notes. Its commits are on the branch; check git status for anything it left uncommitted, and carry on from where it stopped.',
          clipReport(handedOff.summary),
        ]
      : []),
    ...(parked
      ? isPrWait(parked)
        ? [
            '',
            '## The factory waited for the pull or merge request',
            clipReport(parked.summary),
            'No worker ran yet: the factory held this station until the request merged, closed, or changed. Check whether it is really ready before anything else; if it is not, report blocked.',
          ]
        : [
            '',
            '## The previous worker was blocked',
            clipReport(parked.summary),
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
    // Sweep mail transports raw --slo command output (claude-factory-8pc.23), and that output
    // can have more than one line. Add 4 spaces before every line after the first line. Do this
    // so a line such as "- from X:" cannot start a new, more trusted "- from <sender>:" bullet.
    //
    // Divide the text at each line break. LF and CRLF are not the only line breaks: a single CR,
    // NEL (U+0085), LS (U+2028) or PS (U+2029) can also start a fake "- from <sender>:" bullet
    // (claude-factory-8pc.26).
    ...(inbox.length
      ? [
          '',
          '## Inbox',
          ...inbox.map(m => {
            const [first, ...rest] = clipReport(m.text).split(/\r\n|[\n\r\u0085\u2028\u2029]/)
            return [`- from ${m.from}: ${first}`, ...rest.map(l => `    ${l}`)].join('\n')
          }),
        ]
      : []),
    '',
    '## Reporting (required)',
    'When you are finished, report exactly once and then stop:',
    `    ${CLI} report ${run.id} ${c.seq} <outcome> "<summary for the next station>"`,
    'Outcomes:',
    ...Object.entries(n.next).map(([outcome, edge]) => `- ${outcome}: goes to ${edgeText(edge)}`),
    '- fail: you cannot do it; a fresh worker retries',
    `- blocked: you are waiting on something outside this run (a person's decision, a human review or merge, another run): say exactly what, with the link of each pull request it waits on. The run parks without using an attempt, and a fresh worker checks again in ${n.parkMin ?? 60} min or as soon as this station is mailed; one named pull request changing (merged, closed, reviewed, commented on, pushed to) mails it. When it waits on a person's decision or direction, end the summary with a line \`Question: <the decision, in plain words, 160 characters or fewer>\`, an optional \`Context: <one sentence of what is true now, 200 characters or fewer>\` line, and, when there are a few clear choices, a line \`Options: <label>: <effect> | <label>: <effect>\` (each label 40 characters or fewer, each effect 100 characters or fewer; add "(recommended)" after the effect of at most one option): the person answers it in the console's Interview tab, and the answer arrives in this station's inbox.`,
    // workers idled on a background bazel or CI watch, ended their turn, and were failed as lost
    "Do not end your turn to wait on a background build, test or CI watch: wait for it in the foreground. If a wait will outlast this station's time, commit and report (blocked when it waits on CI or a merge) instead.",
    `To ask the manager, run \`${CLI} mail ${run.id} manager "<question>"\` and wait: replies arrive as [factory mail] messages, and you are not nudged while a question is open.`,
    '',
    ...tracking(run, node),
  ].join('\n')
}

// a `memory helped` with no `--from` leaves usage()'s `runs` counting UTC days, not runs, so a long
// entry it truly helped 3 times across 3 runs can look like it helped on only 1 or 2 days
// (claude-factory-59r.16). Each brief must tell its worker the run and station to pass.
export const helpedHint = (run: Run, node: string) =>
  `- When a note saved you time or a mistake, say so: ${CLI} memory helped --from ${run.id}/${node} <note path>. That is how the most useful notes rise to the top of what later workers read.`

/** the memory's top two levels, and how to reach the third: search before, add what was learned */
function remembered(run: Run, node: string, notes = '') {
  const rig = rigOf(run.repo)?.name
  const { core, topics } = memory.outline(MEMORY, rig)
  return [
    '## Factory memory',
    `What this factory's workers learned before you, in ${MEMORY}.`,
    ...(core ? [core] : []),
    ...(topics.length ? ['Topics (search finds their notes):', ...topics] : []),
    `- Before you start, search it for what you are about to do: ${CLI} memory search${rig ? ` --rig ${rig}` : ''} "<query>". It prints the closest notes in full.`,
    ...(notes ? [`- The factory already searched for your goal and station. The closest notes:`, notes] : []),
    `- When you learn what a later worker would otherwise relearn the hard way (a command that works, a trap, an unwritten convention, why something failed), save it: ${CLI} memory add --from ${run.id}/${node} --kind fact|rule|recipe${rig ? ` [--rig ${rig}]` : ''} "<one-line summary>" "<what, why, how you know>"${rig ? ` (--rig when it holds only in ${rig})` : ''}. Only what is verified, reusable and not obvious, at most three per station. When a note proved wrong, add the correct one with --supersedes <old note path>: that marks the old note stale. A note that names a bead id or a PR needs --until <bead|owner/repo#N|YYYY-MM-DD> too, unless --kind recipe: that bead or PR's status belongs in its own tracker (bd comments, the PR), not here. What one bead's status is (already fixed, a duplicate) goes in its bd comments, not here.`,
    helpedHint(run, node),
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
    // claude-factory-wnm: a requeue edge can hand this same bead to a later run, in another
    // factory or station. Its comments are those earlier runs' reports: read them first.
    `- Read ${b}'s comments first (bd show ${b}): they are earlier runs' reports on this bead.`,
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
  `[factory] Your pane closed and this session was resumed.` +
  cutOffNote(c.session ? cutOffCall(tailOf(run.worktree, c.session)) : undefined) +
  ` Carry on as the "${node}" station where you left off: ` +
  `check git status and git log first. When finished, report exactly once: ${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`

/** where a station's workers run: the station's own runner, else the rig's */
const runnerOfStation = (run: Run, def: Factory, node: string) =>
  runners[def.nodes[node]?.runner ?? rigOf(run.repo)?.runner ?? DEFAULT_RUNNER] ?? runners[DEFAULT_RUNNER]!

/**
 * `factory gc --worktrees` can remove a finished run's worktree. A person can revive the run with
 * `goto` or `retry`. Recreate the worktree at the same path first. Use the local branch if it
 * exists. If not, fetch origin and use origin/<branch>.
 *
 * gc can also delete the branch. It does this after a merge, or after a closed PR with a closed
 * bead. If the branch is gone too, fail.
 *
 * Name gc, the branch and refs/factory-gc/<runId> in the message, but only when
 * `runs/<id>/gc.json` shows that gc removed this run's worktree (claude-factory-l38.18). A failed
 * fetch gets its own message. Any other missing branch gets a third message. This way the
 * function never blames gc for another cause. Start no worker.
 */
function reviveWorktree(run: Run) {
  const verify = (ref: string) =>
    Bun.spawnSync(['git', '-C', run.repo, 'rev-parse', '--verify', '--quiet', ref]).exitCode === 0
  if (verify(`refs/heads/${run.branch}`)) return git(run.repo, 'worktree', 'add', run.worktree, run.branch)
  // `git fetch origin <branch>` fails the same way when the branch is gone upstream and when
  // this cannot reach the remote at all. Check reachability on its own first (claude-factory-l38.18):
  // only a genuine network failure gets its own message, never the blame-gc message below.
  const reachable =
    Bun.spawnSync(['git', '-C', run.repo, 'ls-remote', '--exit-code', 'origin'], {
      env: GIT_NETWORK_ENV,
      timeout: GIT_NETWORK_TIMEOUT_MS,
    }).exitCode === 0
  if (!reachable)
    fail(
      `Could not recreate ${run.worktree}: a fetch of origin failed, so this could not check whether ` +
        `${run.branch} still exists there. Check network access, then retry.`,
    )
  Bun.spawnSync(['git', '-C', run.repo, 'fetch', '--quiet', 'origin', run.branch], {
    env: GIT_NETWORK_ENV,
    timeout: GIT_NETWORK_TIMEOUT_MS,
  })
  if (verify(`refs/remotes/origin/${run.branch}`))
    return git(run.repo, 'worktree', 'add', run.worktree, '-b', run.branch, `origin/${run.branch}`)
  const ref = `refs/factory-gc/${run.id}`
  const snapshot = verify(ref)
  const gcRemoved = existsSync(join(runDir(run.id), 'gc.json'))
  fail(
    gcRemoved
      ? `factory gc --worktrees removed ${run.worktree} and deleted its branch ${run.branch}. ` +
          `${snapshot ? `Its last work is at ${ref}.` : `No work is saved at ${ref}.`} ` +
          `No worker started.`
      : `Could not recreate ${run.worktree}: its branch ${run.branch} does not exist locally or ` +
          `on origin, and gc did not record removing it. No worker started.`,
  )
}

/** one line a launch in HOME/launches.jsonl, for `factory metrics`: a write error never blocks the launch */
function logLaunch(run: Run, node: string, seq: number, agent: string, resume: boolean) {
  try {
    const rig = rigOf(run.repo)?.name
    const harness = harnessOf(agent) ?? 'other'
    const model = ax.modelOf(agent) ?? 'default'
    const line = { at: Date.now(), run: run.id, rig, node, seq, harness, model, resume }
    appendFileSync(join(HOME, 'launches.jsonl'), `${JSON.stringify(line)}\n`)
  } catch {
    // best effort: see above
  }
}

/**
 * the top notes of a laptop search for the station's goal, as the search prints them; it logs them shown for
 * run/station. A VM has an empty memory store, so the launch searches for it. '' when nothing is found or
 * the search fails or times out: the launch goes on without notes
 */
function launchNotes(run: Run, node: string) {
  const rig = rigOf(run.repo)?.name
  try {
    const p = Bun.spawnSync(
      [CLI, 'memory', 'search', ...(rig ? ['--rig', rig] : []), '--from', `${run.id}/${node}`].concat(
        `${node}: ${clip(run.goal, 2000)}`,
      ),
      { env: { ...process.env, FACTORY_HOME: HOME, FACTORY_OUTBOX: '' }, timeout: 60_000 },
    )
    const out = p.exitCode === 0 ? p.stdout.toString().trim() : ''
    return out.startsWith('nothing in ') ? '' : clip(out, 6000)
  } catch {
    return ''
  }
}

/** a worker for a station, wherever the rig runs them; given a session, it resumes that conversation */
function spawn(run: Run, def: Factory, node: string, c: Ctx, session?: string) {
  // a revived run (goto or retry after `factory gc --worktrees`) lost its worktree: recreate it first
  if (runnerOfStation(run, def, node).local && !existsSync(run.worktree)) reviveWorktree(run)
  const file = session ? resumeFile(run, node, c) : promptOf(run, node, c)
  // a resumed session keeps the notes it was launched with; a new brief searches once, however often it is read
  const notes = session ? '' : launchNotes(run, node)
  const full = () => brief(run, def, node, c, c.mail[node] ?? [], notes)
  // a revived run (goto after gc) lost prompts/: recreate it before writing (claude-factory-503.1.5)
  if (!session) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, full())
  }
  logLaunch(run, node, c.seq, agentOfNode(run, def, node), !!session)
  return runnerOfStation(run, def, node).launch({ run, def, node, c, session, file, brief: full })
}

/** a worker in a new tab of the run's workspace; given a session, it resumes that conversation */
function launchPane({ run, def, node, c, session, file }: Job) {
  const tab = () =>
    herdr(
      ...['tab', 'create', '--workspace', run.ws, '--cwd', run.worktree],
      ...['--label', `${node}#${c.attempt}`, '--no-focus'],
      ...['--env', `FACTORY_FROM=${node}`, '--env', `FACTORY_HOME=${HOME}`],
      ...['--env', `FACTORY_DEF_NAME=${def.name}`, '--env', `FACTORY_RUN=${run.id}`],
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
  typeLaunch(pane, launch(run, def, node, c, file, session))
  return pane
}

/** an https remote a VM can clone: the egress gateway puts GitHub's credential in, and the VM has no ssh key */
export { httpsRemote }

/**
 * a worker in an AX task on the cluster: the run's branch, pushed, is its workspace. Its brief names the CLI
 * and the worktree as the VM sees them, and FACTORY_AX_ENV (a JSON file) adds to its env.
 */
/**
 * Only an image with the VM codex guard (claude-factory-72dq) may run codex. An older worker ignores the guard files,
 * and its codex would run with no deny hook. So the person sets FACTORY_AX_CODEX=1 with FACTORY_AX_IMAGE.
 */
export const axCodex = (env = process.env) => env.FACTORY_AX_CODEX === '1'
export function axCodexRefused(agent: string) {
  if (harnessOf(agent) === 'codex' && !axCodex())
    fail(
      'the ax runner runs codex only with FACTORY_AX_CODEX=1: set it with an image that has the codex guard',
    )
}
/** a VM codex worker uses the API key only when its rig names api.openai.com; else it logs in with ChatGPT */
export const codexAuth = (egress: Egress[] = []): 'apikey' | 'chatgpt' =>
  egress.some(e => e.hosts.includes('api.openai.com')) ? 'apikey' : 'chatgpt'
/**
 * a codex worker in a VM: in API-key mode the rig's own rule for api.openai.com stands. In ChatGPT mode its policy
 * opens only chatgpt.com's /backend-api/codex/ paths (not /backend-api in general: that holds the person's chats;
 * Substrate accepts only path prefixes that start and end with /),
 * and the gateway injects the access token and account id from the vault keys CODEX_CHATGPT and CODEX_CHATGPT_ACCOUNT
 */
export const codexEgress = (egress: Egress[] = []) =>
  codexAuth(egress) === 'apikey' || egress.some(e => e.hosts.includes('chatgpt.com'))
    ? egress
    : [
        ...egress,
        {
          hosts: ['chatgpt.com'],
          pathPrefixes: ['/backend-api/codex/'],
          headers: [
            { header: 'Authorization', prefix: 'Bearer ', key: 'CODEX_CHATGPT' },
            { header: 'ChatGPT-Account-ID', prefix: '', key: 'CODEX_CHATGPT_ACCOUNT' },
          ],
        },
      ]

function launchTask({ run, def, node, c, brief: text }: Job) {
  const unavailable = ax.unavailable()
  if (unavailable) fail(unavailable)
  const image =
    process.env.FACTORY_AX_IMAGE ?? fail('FACTORY_AX_IMAGE is not set: the worker image for AX tasks')
  const rig = rigOf(run.repo)
  const agent = agentOfNode(run, def, node)
  const harness = harnessOf(agent)
  const skills = workerSkills(def, def.nodes[node]!, rig)
  if (!harness) fail(`the ax runner runs claude, codex or pi workers, not "${agent}"`)
  axCodexRefused(agent)
  const hasRunBeads = vmBeads(run) && hasBeads(run.repo)
  // the VM clones its beads from the rig's beadsRemote: its egress needs that Dolt rule
  const egress = ax.withDoltEgress(
    harness === 'codex' ? codexEgress(rig?.egress) : rig?.egress,
    hasRunBeads ? rig : undefined,
  )
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
  const githubOwner = origin?.forge === 'github' ? origin.owner : undefined
  const reviewer = ax.reviewerTask(node, githubOwner)
  const brief = [
    text().replaceAll(CLI, 'factory').replaceAll(run.worktree, ax.REPO),
    `- You run in a VM: push your commits to origin ${run.branch} before you report, or the factory never sees them.`,
    ...(reviewer
      ? [
          `- You review as the reviewer identity (FACTORY_GH_REVIEWER=1): your gh token is not the author's, so you may approve or request changes on the exact head, as your prompt says.`,
        ]
      : []),
    `- Run tests the way the repo does (its make or devenv targets, not a bare go test): those set up what tests need, such as envtest's KUBEBUILDER_ASSETS.`,
    ...(rig?.env?.FACTORY_NIX_CACHE && existsSync(join(run.worktree, 'devenv.nix'))
      ? [
          `- The repo's devenv.nix environment is loaded for you when its cache holds it (then DEVENV_ROOT is set): its tools are on PATH and its variables set, so use them directly. Do not run devenv shell or devenv test, whose enterShell runs the repo's git hooks for minutes; without DEVENV_ROOT, use nix shell as below.`,
          `- If the devenv declares a process or a service (such as services.postgres), it already started before your first turn; DATABASE_URL is set when one applies. See this brief's own [factory] services: line for what ran. Do not run devenv up, initdb or pg_ctl yourself. Logs are at .factory-worker/services/<name>.log.`,
        ]
      : []),
    ...(rig?.env?.FACTORY_KUBE_SERVER
      ? [
          `- kubectl reaches the live cluster read-only (its kubeconfig is set up, its token added on the way out): get, describe and logs work; secrets, exec and any change are refused, so a cluster change goes through the repo.`,
        ]
      : []),
    `- A tool you lack (go, make, kubectl, gcc...): nix shell nixpkgs#<pkg> ... -c <command>, or the repo's own nix develop. The VM reaches only the hosts it needs (the model's API, GitHub, the Nix cache and what the rig adds): a download elsewhere fails, so ask the manager instead of working around it.`,
    ...(run.ship
      ? [
          `- This VM's factory has no rigs: where a station says \`factory ship <rig>\`, run \`factory ship .\` in the repo. It reads the same queue from bd.`,
        ]
      : []),
    ...(vmBeads(run)
      ? [
          `- bd here is the repo's issue store, cloned when you started from where the factory shares it. \`factory report\` pushes your bd changes back before it reports; to share them sooner (or to see others' since), bd dolt pull && bd dolt push.`,
        ]
      : []),
  ].join('\n')
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
    claudeFlags:
      harness === 'claude'
        ? vmClaudeFlags(def, personOnlyContexts(rig), protectedBranches(rig), mergeAuthority(rig), skills)
        : undefined,
    codexHome:
      harness === 'codex'
        ? vmCodexHome(
            def,
            personOnlyContexts(rig),
            protectedBranches(rig),
            mergeAuthority(rig),
            codexAuth(rig?.egress),
          )
        : undefined,
    codexAuth: harness === 'codex' ? codexAuth(rig?.egress) : undefined,
    gitlabHost,
    sandboxClass: rig?.sandboxClass,
    env: {
      ...env,
      ...rig?.env,
      FACTORY_FROM: node,
      FACTORY_RUN: run.id,
      FACTORY_DEF_NAME: def.name,
      FACTORY_SKILLS: skills.join(','),
      ...(reviewer && { FACTORY_GH_REVIEWER: '1' }),
      ...(harness === 'claude' && { FACTORY_DEADLINE: deadlineOf(def, node, c) }),
      BEADS_ACTOR: `${actorOf(run.id)}/${node}`,
      FACTORY_HOME: `${ax.OWN}/home`,
      // each agent's config and sessions on the workspace volume, so a session survives a suspend
      CLAUDE_CONFIG_DIR: `${ax.OWN}/claude`,
      CODEX_HOME: `${ax.OWN}/codex`,
      PI_CODING_AGENT_DIR: `${ax.OWN}/pi-agent`,
      // the deny hook finds the worktree root here; Claude sets it for itself, codex does not
      ...(harness === 'codex' && { CLAUDE_PROJECT_DIR: ax.REPO }),
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
    egress,
    ...(gitlabHost && { gitlabHost }),
    ...(githubOwner && { githubOwner }),
    ...(reviewer && { reviewer }),
    policy: ax.createPolicy(name, egress, gitlabHost, githubOwner, undefined, reviewer),
    put: ['brief.md'],
    ...(hasRunBeads && rig?.beadsRemote && { beadsRemote: rig.beadsRemote }),
  }
  writeJson(sideFile(run, name), side)
  return address
}

/**
 * Two PreToolUse entries that run `bun` on `file`: one for Bash, one for the file tools (claude-factory-g4du). It denies rm -r/-rf, a cd+rm chain, an rm with a
 * $variable or glob target, and an rm outside the worktree root. It gives a reason.
 * `contexts` names kube contexts the rig reserves for a person alone (claude-factory-25z).
 * When the list is not empty, the hook's own argv carries it: `--person-only-contexts a,b`.
 * `branches` names branches, over main and master, the rig reserves for a person's push
 * (claude-factory-zl5). Its own argv is `--protected-branches a,b`.
 * `merge` is the rig's owner/repo (claude-factory-l3tl). It adds `--merge-authority owner/repo`: the hook then lets the ship
 * release station run one strict `gh pr merge` form, for that repo only (-R required).
 * An older VM image's hook copy ignores argv it does not know.
 */
const denyHook = (bun: string, file: string, contexts?: string[], branches?: string[], merge?: string) => {
  const hooks = [
    {
      type: 'command',
      command: [
        sq(bun),
        sq(file),
        ...(contexts?.length ? ['--person-only-contexts', sq(contexts.join(','))] : []),
        ...(branches?.length ? ['--protected-branches', sq(branches.join(','))] : []),
        ...(merge ? ['--merge-authority', sq(merge)] : []),
      ].join(' '),
      timeout: 10,
    },
  ]
  return [
    { matcher: 'Bash', hooks },
    { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks },
  ]
}

/**
 * The part of `workerFlags` that applies in a VM sets the worker system prompt. It turns off auto memory. It sets a compaction backstop.
 * It keeps the same tools. It does not use the laptop's own settings or project-level mods.
 *
 * It leaves out the laptop's own items: the user's hooks, the user's env, the plugin dirs, the global `CLAUDE.md`.
 * It gets the station's skills from the image's plugins by `--plugin-dir` instead of the person's (claude-factory-fxu, claude-factory-qda).
 * `disableBundledSkills` turns off the bundled-skill list of `Skill`. No skill in the VM earns that cost yet.
 *
 * It gets one hook. The hook is the same deny-rm PreToolUse hook that a laptop worker gets (claude-factory-cr6, claude-factory-99d).
 * The VM image runs its own copy of `worker-hook.ts`, at `${ax.FACTORY_DIR}/src/worker-hook.ts`.
 */
export function vmClaudeFlags(
  def: Pick<Factory, 'maxContextK'>,
  contexts?: string[],
  branches?: string[],
  merge?: string,
  skills: string[] = Object.keys(VM_PLUGINS),
) {
  if (process.env.FACTORY_LEAN === '0') return []
  const settings = {
    autoMemoryEnabled: false,
    env: {
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_ENV_FILE: `${ax.FACTORY_DIR}/src/worker-shell-env.sh`,
    },
    skipDangerousModePermissionPrompt: true,
    autoCompactWindow: Math.max(100, 2 * (def.maxContextK ?? 200)) * 1000,
    disableBundledSkills: true,
    hooks: {
      PreToolUse: [
        ...denyHook('/usr/local/bin/bun', `${ax.FACTORY_DIR}/src/worker-hook.ts`, contexts, branches, merge),
      ],
    },
  }
  return [
    ...['--tools', WORKER_TOOLS, '--setting-sources', 'project,local'],
    ...['--settings', JSON.stringify(settings)],
    ...['--system-prompt-file', `${ax.FACTORY_DIR}/src/worker-system.md`],
    // the image's plugins, as a laptop worker gets the person's (constitution I, claude-factory-fxu)
    ...skills.flatMap(k => ['--plugin-dir', VM_PLUGINS[k]!]),
  ]
}

/**
 * A codex worker's CODEX_HOME files in the VM, the ones a pane gets from codexWorker. hooks.json runs the deny hook
 * from the image's own worker-hook.ts. config.toml sets the compaction limit and trusts the repo. `serve` writes
 * them, adds AGENTS.md from the image's worker rules and checks the guard before the first turn (claude-factory-72dq).
 */
export function vmCodexHome(
  def: Pick<Factory, 'maxContextK'>,
  contexts?: string[],
  branches?: string[],
  merge?: string,
  auth: 'apikey' | 'chatgpt' = 'apikey',
) {
  const hook = denyHook(
    '/usr/local/bin/bun',
    `${ax.FACTORY_DIR}/src/worker-hook.ts`,
    contexts,
    branches,
    merge,
  )
  const chatgpt = auth === 'chatgpt'
  return {
    'hooks.json': JSON.stringify({ hooks: { PreToolUse: hook } }),
    // allow_login_shell = false: a login shell (bash -lc) reads /etc/profile again and drops the PATH and the CA
    // env that serve set (devenv, nix, egress CA), so tools go missing and TLS fails (claude-factory-wpnx)
    'config.toml':
      `model_auto_compact_token_limit = ${Math.max(100, 2 * (def.maxContextK ?? 200)) * 1000}\n` +
      'allow_login_shell = false\n' +
      (chatgpt ? 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n' : '') +
      `\n[projects.${JSON.stringify(ax.REPO)}]\ntrust_level = "trusted"\n`,
    ...(chatgpt && { 'auth.json': placeholderAuth() }),
  } as { 'hooks.json': string; 'config.toml': string; 'auth.json'?: string }
}

/**
 * The auth.json of a ChatGPT-mode VM codex. Every token in it is a placeholder: codex reads the claims without a
 * signature check and does not refresh before exp, and the gateway swaps the real access token and account id into
 * the request headers. The JWTs are built here so that no token-like string sits in the source.
 * There is no tokens.account_id on purpose. With it, codex 0.160.1 calls chatgpt.com wham/accounts/check before each
 * turn and needs an entry with the same id, so a placeholder id fails. Without it, codex skips that call.
 */
function placeholderAuth() {
  const jwt = (claims: object) =>
    [{ alg: 'none', typ: 'JWT' }, claims]
      .map(p => Buffer.from(JSON.stringify(p)).toString('base64url'))
      .concat('placeholder')
      .join('.')
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: 'codex@factory.invalid',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'pro',
          chatgpt_user_id: 'placeholder',
          chatgpt_account_id: 'placeholder',
        },
      }),
      access_token: jwt({ exp: 4102444800 }),
      refresh_token: 'placeholder',
    },
    last_refresh: new Date().toISOString(),
  })
}

/** the note a resumed worker is sent, written where its launch reads it */
function resumeFile(run: Run, node: string, c: Ctx) {
  const file = promptOf(run, node, c).replace(/\.md$/, '-resume.md')
  // a revived run (goto after gc) lost prompts/: recreate it before writing (claude-factory-503.1.5)
  mkdirSync(dirname(file), { recursive: true })
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
/**
 * Does this run take the split agent? The pick hashes the run id and the share's name, so one run picks the
 * same way every time, and two share params pick on their own. A bad share value (not a number from 0 to 1) is 0.
 */
export function splitPick(runId: string, shareName: string, share: string | undefined) {
  if (share === undefined || !shareOk(share)) return false
  const h = createHash('sha256').update(`${runId}:${shareName}`).digest().readUInt32BE(0)
  return h / 2 ** 32 < Number(share)
}
/**
 * the worker command: the rig's own (one harness for all its stations) over the split's, the station's and the
 * factory's. The split applies on the ax runner only with FACTORY_AX_CODEX=1 (axCodex), and elsewhere only when
 * the `pin` file exists (claude-factory-fzm3).
 */
export const pickAgent = (
  runId: string,
  def: Factory,
  node: string,
  rig: Pick<Rig, 'agent' | 'params'> | undefined,
  runner: string,
  env = process.env,
  pin = CODEX_PIN,
) => {
  const params = paramsOf(def, rig, env)
  const split = def.nodes[node]!.split
  // a host without the unified_exec pin cannot launch codex (the probe refuses), so the split keeps Claude there
  const picked =
    split &&
    (runner === 'ax' ? axCodex(env) : existsSync(pin)) &&
    splitPick(runId, split.share, params[split.share])
  return fill(rig?.agent ?? (picked ? split.agent : (def.nodes[node]!.agent ?? def.agent ?? AGENT)), params)
}
const agentOfNode = (run: Run, def: Factory, node: string) =>
  pickAgent(run.id, def, node, rigOf(run.repo), runnerOfStation(run, def, node).name)
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

/** the first UTC time after `after` that a "resets [Mon D, | Mon D at ]h[:mm]am (UTC)" notice names, in ms; 0 for no match or another zone */
export function resetsAtFromText(text: string, after: number) {
  const m =
    /resets (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:, | at ))?(\d{1,2})(?::(\d\d))?\s?([ap]m) \(UTC\)/i.exec(text)
  if (!m) return 0
  const hour = (Number(m[3]) % 12) + (m[5]?.toLowerCase() === 'pm' ? 12 : 0)
  const min = Number(m[4] ?? 0)
  const day = new Date(after)
  const year = day.getUTCFullYear()
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const mon = m[1] ? months.indexOf(m[1].toLowerCase()) : day.getUTCMonth()
  if (mon < 0) return 0
  for (let i = 0; i < 2; i++) {
    const t = m[1]
      ? Date.UTC(year + i, mon, Number(m[2]), hour, min)
      : Date.UTC(year, mon, day.getUTCDate() + i, hour, min)
    if (t > after) return t
  }
  return 0
}

/** the usage limit or login failure that refused a Claude transcript's last turn: when, which (seven_day, five_hour, usage, auth) and when it resets, in ms (0: unknown) */
export function limitHit(tail: string) {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'assistant') continue
      const at = Date.parse(e.timestamp)
      if (e.error === 'authentication_failed' || e.apiErrorStatus === 401)
        return { at, kind: 'auth', resetsAt: 0 }
      if (e.error !== 'rate_limit') return null
      if (e.quotaLimits?.status === 'rejected')
        return {
          at,
          kind: String(e.quotaLimits.rateLimitType ?? 'usage'),
          resetsAt: (e.quotaLimits.resetsAt ?? 0) * 1000,
        }
      const c = e.message?.content
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((p: { text?: string }) => p?.text ?? '').join('\n')
            : ''
      const kind = /weekly/i.test(text)
        ? 'seven_day'
        : /session limit|5-hour|five.hour/i.test(text)
          ? 'five_hour'
          : 'usage'
      return { at, kind, resetsAt: resetsAtFromText(text, at) }
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
 * This function runs a swap command. A rig sets the Claude command in FACTORY_AX_TOKEN_SWAP and the Codex command in
 * FACTORY_AX_CODEX_TOKEN_SWAP. The function runs the command one time for each refusal. It then sends mail to the
 * manager. The mail names the live slot (Claude) or the live label (Codex).
 *
 * Workers of one runner use the same vault token. One file per runner and harness stops a second run for
 * the same refusal. If there is no command, the function waits for the reset. The function
 * also waits for the reset if the command fails.
 */
export function runTokenSwap(
  hit: { at: number; resetsAt: number },
  now: number,
  runnerName: string,
  send: (e: Input) => void,
  node: string,
  harness: 'claude' | 'codex' = 'claude',
  home = HOME,
): number {
  const codex = harness === 'codex'
  const cmd = codex ? process.env.FACTORY_AX_CODEX_TOKEN_SWAP : process.env.FACTORY_AX_TOKEN_SWAP
  if (!cmd) return hit.resetsAt || hit.at + 3_600_000
  const file = join(home, `token-swap-${runnerName}${codex ? '-codex' : ''}.json`)
  const state = existsSync(file) ? readJson<TokenSwapState>(file) : undefined
  if (!needsSwap(hit, state)) return state!.until
  const p = Bun.spawnSync(cmd.split(' '), { cwd: ROOT, timeout: 30_000 })
  const ok = p.exitCode === 0
  if (ok) {
    const live = (codex ? /label (\S+) is live/ : /slot (\S+) is live/).exec(p.stdout.toString())?.[1] ?? '?'
    send({
      type: 'MAIL',
      from: 'factory',
      to: 'manager',
      text: `Swapped the ${codex ? 'Codex' : 'Claude'} token for ${runnerName} workers: ${codex ? 'label' : 'slot'} ${live} is live; they go on once the vault refreshes.`,
    })
  }
  const until = swapUntil(hit, now, ok, TOKEN_SWAP_WAIT_MS)
  writeJson(file, { at: hit.at, until } satisfies TokenSwapState)
  return until
}

const CODEX_REFRESH_MS = 12 * 3_600_000 // an access token lasts about 10 days; ccswitch renews under 24 h left
/**
 * Run FACTORY_AX_CODEX_TOKEN_SWAP when the last run is 12 hours old or older, so the live field is never stale.
 * It shares its state file with runTokenSwap. With no command, it does nothing. After a failed run it tries again
 * in one hour.
 */
export function refreshCodexToken(now: number, runnerName: string, home = HOME) {
  const cmd = process.env.FACTORY_AX_CODEX_TOKEN_SWAP
  if (!cmd) return
  const file = join(home, `token-swap-${runnerName}-codex.json`)
  const state = existsSync(file) ? readJson<TokenSwapState>(file) : undefined
  if (state && now - state.at < CODEX_REFRESH_MS) return
  const ok = Bun.spawnSync(cmd.split(' '), { cwd: ROOT, timeout: 30_000 }).exitCode === 0
  writeJson(file, {
    at: ok ? now : now - CODEX_REFRESH_MS + 3_600_000,
    until: ok ? now + TOKEN_SWAP_WAIT_MS : now,
  } satisfies TokenSwapState)
}

/** the model behind the `haiku` alias for workers and the manager. Claude Code 2.1.291 maps it to Haiku 4.5 */
export const HAIKU = 'claude-haiku-5-5'

/**
 * a worker's own Claude settings, in full: none of the user's plugins, agents, skills, global `CLAUDE.md` or auto memory.
 * Those cost a worker tens of thousands of tokens a turn it never uses, so this wins instead.
 * It keeps the user's hooks (secret guards, herdr's session hook) and env, and skips every permission prompt.
 * It compacts well past the handoff limit too, only as a backstop.
 * A worktree's path excludes the global `CLAUDE.md` too, since Claude Code would read it as an ancestor's project file.
 * Only the plugins in `names` stay in (the enabledPlugins key before `@`): the station's skills, and the person's FACTORY_WORKER_PLUGINS.
 * `disableBundledSkills` keeps their skills alone.
 * `hooks.PreToolUse` keeps the user's own entries first and adds the deny-rm hook last (claude-factory-cr6, claude-factory-99d).
 */
export const workerSettings = (
  user: {
    env?: Record<string, string>
    hooks?: Record<string, unknown[]>
    enabledPlugins?: Record<string, boolean>
  },
  maxContextK: number,
  globalClaudeMd = join(homedir(), '.claude', 'CLAUDE.md'),
  personOnly?: string[],
  branches?: string[],
  names: string[] = [],
  merge?: string,
) => {
  const ste = Object.entries(user.enabledPlugins ?? {}).filter(
    ([k, v]) => v && names.includes(k.split('@')[0]!),
  )
  const hooks: Record<string, unknown[]> = {
    ...user.hooks,
    PreToolUse: [
      ...(user.hooks?.PreToolUse ?? []),
      ...denyHook(process.execPath, join(ROOT, 'src', 'worker-hook.ts'), personOnly, branches, merge),
    ],
  }
  return {
    claudeMdExcludes: [globalClaudeMd],
    autoMemoryEnabled: false, // workers share the factory's memory, not the user's per-repo notes
    env: {
      // the shunt guard's denial names SHUNT_MODEL; the Agent tool takes only an alias, so `haiku`
      // must point at the current Haiku. A user's own value for either wins
      ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU,
      SHUNT_MODEL: 'haiku',
      ...user.env,
      ...withoutFleet(user.env?.CLAUDE_CODE_PLUGIN_DIRS ?? process.env.CLAUDE_CODE_PLUGIN_DIRS).env,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      // claude-factory-1zr5: the script clears the shell-snapshot aliases (gp, gco) that hide git from the deny hook;
      // a user's own env file still runs, first, through FACTORY_USER_ENV_FILE
      ...((user.env?.CLAUDE_ENV_FILE ?? process.env.CLAUDE_ENV_FILE)
        ? { FACTORY_USER_ENV_FILE: (user.env?.CLAUDE_ENV_FILE ?? process.env.CLAUDE_ENV_FILE)! }
        : {}),
      CLAUDE_ENV_FILE: join(ROOT, 'src', 'worker-shell-env.sh'),
    },
    hooks,
    ...(ste.length ? { enabledPlugins: Object.fromEntries(ste) } : {}),
    disableBundledSkills: true,
    skipDangerousModePermissionPrompt: true,
    autoCompactWindow: Math.max(100, 2 * maxContextK) * 1000,
  }
}
/**
 * who workers commit as: the factory home's own git identity (`git -C <home> config user.name`, user.email),
 * not whoever cloned its rigs; `factory.coauthor` ("Name <email>") is credited in a Co-authored-by trailer.
 * Neither set (a home that is not its own git repo): workers commit as the rig's git config says
 */
export const commitIdentity = (home: string) => {
  const get = (key: string) =>
    Bun.spawnSync(['git', '-C', home, 'config', '--local', '--get', key]).stdout.toString().trim()
  const [name, email, coauthor] = ['user.name', 'user.email', 'factory.coauthor'].map(get)
  return {
    env:
      name && email
        ? {
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: name,
            GIT_COMMITTER_EMAIL: email,
          }
        : {},
    rule: coauthor
      ? `\n# Commits\n\nEnd every commit message with this trailer, after a blank line:\n\nCo-authored-by: ${coauthor}\n`
      : '',
  }
}
/** the plugins a worker keeps (enabledPlugins key names before the @): the station's skills and FACTORY_WORKER_PLUGINS */
const workerPluginNames = (skills: string[] = ['asd-ste100']) => [
  ...skills,
  ...(process.env.FACTORY_WORKER_PLUGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
]

/**
 * the dirs of the person's worker plugins that are on, so a codex or pi worker gets the skills a Claude worker
 * gets from enabledPlugins (constitution I). Claude Code keeps a plugin at its installPath, or, from a directory
 * marketplace, in the marketplace's own dir. A plugin that is off or not found adds no dir.
 */
export function userPluginDirs(
  names = workerPluginNames(),
  claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
) {
  const read = <T>(f: string): T | undefined => {
    try {
      return readJson<T>(f)
    } catch {
      return undefined
    }
  }
  type Installed = { plugins?: Record<string, { installPath?: string }[]> }
  type Market = Record<string, { installLocation?: string }>
  const on = read<{ enabledPlugins?: Record<string, boolean> }>(
    join(claudeDir, 'settings.json'),
  )?.enabledPlugins
  const installed = read<Installed>(join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  const markets = read<Market>(join(claudeDir, 'plugins', 'known_marketplaces.json')) ?? {}
  return Object.entries(on ?? {})
    .filter(([key, v]) => v && names.includes(key.split('@')[0]!))
    .flatMap(([key]) => {
      const [name, market] = key.split('@') as [string, string | undefined]
      const path = installed[key]?.[0]?.installPath
      if (path && existsSync(path)) return [path]
      const root = market ? markets[market]?.installLocation : undefined
      if (!root) return []
      const list = read<{ plugins?: { name: string; source?: string }[] }>(
        join(root, '.claude-plugin', 'marketplace.json'),
      )
      const source = list?.plugins?.find(p => p.name === name)?.source
      const dir = typeof source === 'string' ? join(root, source) : undefined
      return dir && existsSync(dir) ? [dir] : []
    })
}

// what workers use; the rest of Claude Code's built-ins only add tool definitions to every turn.
// ToolSearch keeps MCP tools deferred: without it every MCP server's tools load into every turn (~60k)
// Skill lets a worker run the asd-ste100 skill (workerSettings carries that one plugin over)
export const WORKER_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob,Agent,WebFetch,WebSearch,ToolSearch,Skill'

/**
 * These flags give a Claude worker its own settings, system prompt and tools.
 * FACTORY_LEAN=0 turns them off.
 * A rig with `personOnlyContexts`, `protectedBranches` or `mergeAuthority` gets its own file, `worker-settings-<rig.name>.json`
 * (claude-factory-25z, claude-factory-zl5).
 * Without this, every rig would share one `worker-settings.json`.
 * A launch for a different rig writes that shared file with no argv.
 * It would overwrite this rig's hook argv before this rig's worker reads it.
 */
export function workerFlags(
  def: Pick<Factory, 'maxContextK'>,
  rig?: Pick<Rig, 'name' | 'personOnlyContexts' | 'protectedBranches' | 'mergeAuthority'> & { repo?: string },
  home = HOME,
  skills: string[] = [],
  station = '',
) {
  if (process.env.FACTORY_LEAN === '0') return ` --settings '${JSON.stringify(withoutFleet())}'`
  let user = {}
  try {
    user = readJson(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'))
  } catch {
    // no user settings: nothing to carry over
  }
  const contexts = personOnlyContexts(rig)
  const branches = protectedBranches(rig)
  const merge = mergeAuthority(rig)
  // one file for each skill set, so two stations of a rig never write the same file with different plugins
  const set = skills.length ? `--${skills.join('+')}` : ''
  const file = join(
    home,
    contexts?.length || branches?.length || merge
      ? `worker-settings-${rig!.name}${set}.json`
      : `worker-settings${set}.json`,
  )
  const on = (user as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {}
  for (const k of skills)
    if (!Object.entries(on).some(([key, v]) => v && key.split('@')[0] === k))
      console.warn(
        `skill ${k} is not on in your Claude settings: the ${station || 'station'} worker starts without it`,
      )
  const settings = workerSettings(
    user,
    def.maxContextK ?? 200,
    undefined,
    contexts,
    branches,
    workerPluginNames(skills),
    merge,
  )
  const id = commitIdentity(home)
  writeJson(file, { ...settings, env: { ...settings.env, ...id.env } })
  const prompt = join(home, 'worker-system.md')
  writeFileSync(prompt, readFileSync(join(ROOT, 'src', 'worker-system.md'), 'utf8') + id.rule)
  // --tools first: it takes every word up to the next flag, so last it would swallow the prompt
  return ` --tools ${WORKER_TOOLS} --setting-sources project,local --settings ${sq(file)} --system-prompt-file ${sq(prompt)}`
}

// codex_hooks is the legacy alias of hooks: turning it off turns the hooks off
const CODEX_HOOKS = ['hooks', 'codex_hooks']

/** the reason a codex agent command turns a guard part off, or undefined */
function codexGuardOff(agent: string): string | undefined {
  // drop shell quotes and backslashes first: codex sees '--ignore-user-config' as the bare flag
  const text = agent.replace(/['"\\]/g, '')
  const w = text
    .trim()
    .split(/\s+/)
    .flatMap(s => (/^--[\w-]+=/.test(s) ? s.split(/=(.*)/s).slice(0, 2) : [s]))
  for (let i = 0; i < w.length; i++) {
    const next = (w[i + 1] ?? '').replace(/\s/g, '')
    if (w[i] === '--ignore-user-config') return w[i]
    if (w[i] === '--disable' && CODEX_HOOKS.includes(next)) return `--disable ${next}`
    if (w[i] === '--enable' && CODEX_UNGUARDED.includes(next)) return `--enable ${next}`
  }
  // -c/--config values in dotted, joined (-cfeatures.x=y) or table form (features={x=y}); fail closed on any match
  const on = CODEX_UNGUARDED.join('|')
  const re = new RegExp(
    `features\\.(hooks|codex_hooks)=false|features\\.(${on})=true|features=\\{[^}]*((hooks|codex_hooks)=false|(${on})=true)`,
  )
  const m = text.replace(/\s/g, '').match(re)
  if (m) return `-c ${m[0]}`
}

/**
 * A pi worker's rules and skills: the worker rules (as a Claude worker gets them) appended to pi's system prompt,
 * and the person's worker plugins' skills by --skill (constitution I). It commits as the factory home says.
 */
export function piWorker(home = HOME, plugins = userPluginDirs()) {
  const id = commitIdentity(home)
  const rules = join(home, 'worker-system.md')
  writeFileSync(rules, readFileSync(join(ROOT, 'src', 'worker-system.md'), 'utf8') + id.rule)
  return {
    env: id.env as Record<string, string>,
    extra: piFlags(rules, plugins)
      .map(a => ` ${sq(a)}`)
      .join(''),
  }
}

/**
 * A codex worker gets its own CODEX_HOME at <run dir>/codex/<node>, never the person's ~/.codex. It holds
 * config.toml (context limit), hooks.json (the person's hooks, then the deny hook last), AGENTS.md (the worker
 * rules) and an auth.json link. Codex has the PreToolUse hook, so worker-hook.ts runs as it is. Fail closed:
 * no hook file, or an agent command that turns the guard off, refuses the launch (claude-factory-x0b9).
 */
export function codexWorker(
  run: Pick<Run, 'id' | 'worktree'>,
  def: Pick<Factory, 'maxContextK'>,
  node: string,
  agent: string,
  rig?: Pick<Rig, 'personOnlyContexts' | 'protectedBranches' | 'mergeAuthority'> & { repo?: string },
  o: { hookFile?: string; userHome?: string; dir?: string; timeoutMs?: number; plugins?: string[] } = {},
): { env: Record<string, string>; extra: string } {
  const hookFile = o.hookFile ?? join(ROOT, 'src', 'worker-hook.ts')
  if (!existsSync(hookFile)) fail(`a codex worker needs the deny hook, and ${hookFile} is missing`)
  const off = codexGuardOff(agent)
  if (off) fail(`a codex worker keeps the deny hook on: "${off}" in the agent command turns it off`)
  // the home trusts the worktree so codex shows no folder prompt; a .codex entry there would load unguarded config,
  // unless it is the one `bd init` writes (claude-factory-8cu6)
  for (let d = resolve(run.worktree); ; d = dirname(d)) {
    if (existsSync(join(d, '.codex')) && !beadsOnlyCodexDir(join(d, '.codex')))
      fail(`a codex worker keeps the deny hook on: ${join(d, '.codex')} would add project config`)
    if (existsSync(join(d, '.git')) || dirname(d) === d) break
  }
  const user = o.userHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const dir = o.dir ?? join(runDir(run.id), 'codex', node)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  let theirs: Record<string, unknown[]> = {}
  try {
    theirs = readJson<{ hooks?: Record<string, unknown[]> }>(join(user, 'hooks.json')).hooks ?? {}
  } catch {
    // no user hooks, or not JSON: the deny hook is the only one
  }
  const hook = denyHook(
    process.execPath,
    hookFile,
    personOnlyContexts(rig),
    protectedBranches(rig),
    mergeAuthority(rig),
  )
  writeJson(join(dir, 'hooks.json'), {
    hooks: { ...theirs, PreToolUse: [...(theirs.PreToolUse ?? []), ...hook] },
  })
  writeFileSync(
    join(dir, 'config.toml'),
    `model_auto_compact_token_limit = ${Math.max(100, 2 * (def.maxContextK ?? 200)) * 1000}\n\n` +
      `[projects.${JSON.stringify(run.worktree)}]\ntrust_level = "trusted"\n`,
  )
  const id = commitIdentity(HOME)
  writeFileSync(
    join(dir, 'AGENTS.md'),
    readFileSync(join(ROOT, 'src', 'worker-system.md'), 'utf8') +
      readFileSync(join(ROOT, 'src', 'worker-codex.md'), 'utf8') +
      id.rule,
  )
  codexSkills(dir, o.plugins ?? userPluginDirs())
  // one token store: codex rotates a ChatGPT refresh token, and a copy that refreshes would stale the person's own
  const auth = join(user, 'auth.json')
  const link = join(dir, 'auth.json')
  rmSync(link, { force: true })
  if (existsSync(auth)) symlinkSync(auth, link)
  const extra = ` ${CODEX_GUARD_FLAGS.join(' ')}`
  // ask codex what is on with these flags and this home: fail closed on a guard that is not in force
  // the shell splits the agent words as the pane does, so the probe sees the same exe and flags
  const probe = Bun.spawnSync(['sh', '-c', `${agent}${extra} features list`], {
    env: { ...process.env, CODEX_HOME: dir },
    stdin: 'ignore',
    timeout: o.timeoutMs ?? 10_000,
    killSignal: 'SIGKILL',
  })
  const bad = probe.exitedDueToTimeout
    ? 'codex features list timed out'
    : probe.exitCode !== 0
      ? 'codex features list failed'
      : codexFeaturesBad(probe.stdout.toString())
  if (bad) fail(`a codex worker keeps the deny hook on: the feature check failed (${bad})`)
  return {
    env: { CODEX_HOME: dir, CLAUDE_PROJECT_DIR: run.worktree, ...(id.env as Record<string, string>) },
    extra,
  }
}

/**
 * when the station fails a worker that is still working (`deadline`: 1.5x its minutes from launch), in ms. The deny
 * hook clamps a Bash call's timeout to it, so a command ends before the run fails (claude-factory-p0yt)
 */
const deadlineOf = (def: Factory, node: string, c: Ctx) =>
  String(Date.now() + timeoutOf(def.nodes[node]!, c, node) * 90_000)

function launch(run: Run, def: Factory, node: string, c: Ctx, prompt: string, session?: string) {
  const rig = rigOf(run.repo)
  const agent = agentOfNode(run, def, node)
  // the clamp is Claude's: its Bash tool takes a timeout, codex's shell does not
  const h = harnessOf(agent)
  const skills = workerSkills(def, def.nodes[node]!, rig)
  const setup =
    h === 'codex'
      ? codexWorker(run, def, node, agent, rig, { plugins: userPluginDirs(workerPluginNames(skills)) })
      : h === 'pi'
        ? piWorker(HOME, userPluginDirs(workerPluginNames(skills)))
        : {
            extra: workerFlags(def, rig, HOME, skills, node),
            env: { FACTORY_DEADLINE: deadlineOf(def, node, c) },
          }
  return command(agent, prompt, {
    session,
    ...setup,
    mcp: rig?.mcp ? readMcp(rig.mcp) : undefined,
  })
}

/**
 * the factory's own Claudes run without the herdr-fleet mod: its agent-status band, pane naming and
 * /fanout workers would compete with the runner, which owns its workers' panes. The mods come from
 * CLAUDE_CODE_PLUGIN_DIRS in the user's settings env, which the shell cannot override: --settings can.
 */
/**
 * The manager drives the factory. It uses Bash and the factory CLI. Every call re-reads the whole
 * tool list. The user's MCP servers, connectors, Chrome and every built-in tool would add about 130k
 * tokens of tool definitions to each call. The manager starts with only the tools it uses.
 *
 * A patrol runs in its own hidden subagent (claude-factory-72v). This subagent has a smaller tool
 * list: Bash, Read, Grep and Glob. The manager's own short list still bounds the cost of a person's turn.
 */
// Agent: the mod spawns a patrol subagent through $.agent.spawn; without it, the spawn rejects
const MANAGER_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob,AskUserQuestion,Skill,Agent'
export const managerCommand = (extra: string[] = [], dirs = process.env['CLAUDE_CODE_PLUGIN_DIRS'] ?? '') => [
  'claude',
  '--model',
  'claude-opus-5-5', // not [1m]: Claude Code compacts it near 200k, and every call re-reads the whole context
  // the person's own default mode (auto) refuses the production reads a patrol needs
  ...['--permission-mode', 'bypassPermissions'],
  '--strict-mcp-config', // and no --mcp-config: no MCP servers
  '--no-chrome',
  '--tools',
  MANAGER_TOOLS,
  '--plugin-dir',
  join(ROOT, 'mod'),
  '--settings',
  JSON.stringify({
    env: {
      ...withoutFleet(dirs).env,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU,
    },
  }),
  ...extra,
]

/**
 * Records the manager's launch in <home>/manager.json. Store the base argv only (managerCommand([], '')):
 * it holds no per-launch extras and no secret. managerStale compares it with the code on disk.
 */
export function writeManagerLaunch(home: string, pid: number, startedAt: number, argv: string[]) {
  writeJson(join(home, 'manager.json'), { pid, startedAt, argv })
  chmodSync(join(home, 'manager.json'), 0o600)
}

const toolsOf = (argv: string[]) => (argv[argv.indexOf('--tools') + 1] ?? '').split(',')

/**
 * The text that tells a person to restart the manager, or null. It is null when no manager.json
 * exists or it is unreadable, when its pid is dead, or when its argv equals `current`.
 * A self-update that changes the launch command does not reach a running manager (claude-factory-772).
 */
export function managerStale(home: string, current: string[], alive = isAlive): string | null {
  const file = join(home, 'manager.json')
  if (!existsSync(file)) return null
  let rec: { pid?: number; startedAt?: number; argv?: unknown }
  try {
    rec = readJson(file)
  } catch {
    return null
  }
  if (!rec || typeof rec.pid !== 'number' || !Array.isArray(rec.argv) || !alive(rec.pid)) return null
  if (JSON.stringify(rec.argv) === JSON.stringify(current)) return null
  const have = toolsOf(rec.argv as string[])
  const missing = toolsOf(current).filter(t => !have.includes(t))
  return (
    `restart factory manager: its launch command (pid ${rec.pid}, started ${clock(rec.startedAt ?? 0)}) is older than the code on disk; ` +
    `the running manager does not have the new flags or tools` +
    (missing.length ? ` (missing tools: ${missing.join(', ')})` : '')
  )
}

/** One mail for each manager launch that is stale. The marker holds the startedAt of the last mail. */
export function managerStaleMail(now: number, home = HOME, alive = isAlive): (Mail & { run: string })[] {
  const text = managerStale(home, managerCommand([], ''), alive)
  if (!text) return []
  const startedAt = readJson<{ startedAt?: number }>(join(home, 'manager.json')).startedAt ?? 0
  const marker = join(home, 'manager-stale-mailed.json')
  if (existsSync(marker) && readJson<number>(marker) === startedAt) return []
  writeJson(marker, startedAt)
  return [{ run: 'factory', from: 'factory', text, at: now }]
}

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
    writeManagerLaunch(HOME, child.pid, startedAt, managerCommand([], ''))
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

/**
 * This function gives the earliest wake time (ms) of an outage hold. It gives null when the work failed.
 * An egress outage gives 0. A worker can stop without a report. If a limit refusal came after the attempt
 * started, or the runner's limit page is active, the function gives the later of the page and the reset time.
 */
export function holdFloor(
  reason: string,
  hit: { at: number; resetsAt: number } | null,
  pagedUntil: number,
  startedAt: number,
  now: number,
): number | null {
  if (reason.startsWith('egress gateway: model API unreachable')) return 0
  if (reason !== 'worker stopped without reporting') return null
  if (hit && hit.at > startedAt) return Math.max(pagedUntil, hit.resetsAt)
  return pagedUntil > now ? pagedUntil : null
}

/** a VM's codex token and Claude token have separate limits: a codex limit must not hide a Claude one */
export const limitPagedFile = (runner: { local?: boolean; name: string }, codex: boolean) =>
  join(HOME, runner.local ? 'limit-paged.json' : `limit-paged-${runner.name}${codex ? '-codex' : ''}.json`)

/** the facts a patrol needs about a working run: how long, how quiet, and whether its runner waits on a usage limit */
function facts(run: Run, c: Ctx, now: number, codex = false): Pick<Row, 'inMin' | 'quietMin' | 'limitUntil'> {
  if (!c.pane || !c.startedAt) return {}
  const p = progressOf(run)
  const runner = runnerOf(c.pane)
  const paged = limitPagedFile(runner, codex)
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

function holdUnavailableAx(c: Ctx, send: (e: Input) => void) {
  const reason = ax.unavailable()
  if (!reason) return false
  if (!(c.mail.manager ?? []).some(m => m.from === 'factory' && m.text === reason))
    send({ type: 'MAIL', from: 'factory', to: 'manager', text: reason })
  return true
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
    if (runnerOfStation(run, def, node).name === 'ax' && holdUnavailableAx(c, send))
      return 'AX executor unavailable'
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
    if (n.mergeCheck) {
      const base = defaultBranch(run.repo)
      const files = conflictsOf(run.repo, base, run.branch)
      if (files.length) {
        const summary = `no worker: merge origin/${base} into ${run.branch}; conflicts in: ${files.join(', ')}; keep both sides of CHANGELOG.md [Unreleased]`
        send({ type: 'DONE', seq: c.seq, outcome: n.mergeCheck, summary })
        return 'merge conflict'
      }
    }
    const pane = spawn(run, def, node, c)
    send({ type: 'SPAWNED', seq: c.seq, pane })
    const box = c.mail[node] ?? [] // the brief carried the whole box
    if (box.length) send({ type: 'READ', box: node, seen: box.length })
    return 'starting'
  }
  const runner = runnerOf(c.pane)
  const info = runner.info(run, c.pane)
  if (runner.name === 'ax' && info?.status === 'pending' && holdUnavailableAx(c, send))
    return 'AX executor unavailable'
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
    typeLaunch(c.pane, launch(run, def, node, c, resumeFile(run, node, c), c.session))
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
      typeLaunch(c.pane, launch(run, def, node, c, promptOf(run, node, c)))
    }
    if (step) send({ type: 'NUDGED', seq: c.seq })
    return step ? 'relaunching' : 'starting'
  }
  const timeoutMin = timeoutOf(n, c, node)
  const inbox = unread(c, node)
  // a worker waiting on the manager's answer is idle by design: no nudges until the answer arrives
  const asked = (c.mail.manager ?? []).findLast(m => m.from === node && m.at >= c.startedAt)
  const isAsking =
    asked !== undefined && !(c.mail[node] ?? []).some(m => m.from === 'manager' && m.at > asked.at)
  // a remote worker's transcript is in its VM: its runner hands over the end of it, available from the moment
  // it has one (own()/claude.jsonl's fallback -- see worker.ts lastTurn), not gated on this tick having already
  // learned c.session, which lags the runner's own info.session by at least one tick (the SESSION send above)
  // -- gating it left an AX worker's tail empty for its whole first turn too (claude-factory-xq3)
  const tail = !isClaude
    ? ''
    : runner.local
      ? c.session
        ? tailOf(run.worktree, c.session)
        : ''
      : (info?.tail ?? '')
  const isCodex = harnessOf(agentOfNode(run, def, node)) === 'codex'
  if (isCodex && !runner.local) refreshCodexToken(now, runner.name)
  const hit = isCodex && !runner.local ? (info?.limit ?? null) : limitHit(tail)
  if (!hit && runner.local) clearLimit(servedAt(tail))
  if (hit && hit.at > c.startedAt) {
    // A VM's Claude uses the vault's token. ccswitch does not rotate this token. With a swap command,
    // runTokenSwap moves to a new slot, and the worker goes on when the vault refreshes. With no swap
    // command, the worker waits for the reset, and the nudge below then gives it its next turn.
    const until = runner.local
      ? swapAccount(hit, now)
      : runTokenSwap(hit, now, runner.name, send, node, isCodex ? 'codex' : 'claude')
    if (until > now) {
      // a wait past the vault refresh would freeze this run for days: park the station until the reset (dhof hold)
      if (!runner.local && until - now > TOKEN_SWAP_WAIT_MS) {
        const reason = `usage limit (${hit.kind}) until ${new Date(until).toISOString()}`
        send({ type: 'FAIL', seq: c.seq, reason, hold: until })
        return 'usage limit'
      }
      const paged = limitPagedFile(runner, isCodex)
      if (!existsSync(paged) || readJson<number>(paged) < until) {
        const text = runner.local
          ? `Every Claude account is at its usage limit (${hit.kind}); workers wait until ${new Date(until).toLocaleString()} and restart then. Log in another account with ccswitch to go on sooner.`
          : `The ${isCodex ? 'Codex' : 'Claude'} token ${runner.name} workers run on is at its usage limit (${hit.kind}); they wait until ${new Date(until).toLocaleString()} and go on then.`
        send({ type: 'MAIL', from: 'factory', to: 'manager', text })
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
  const limitPage = limitPagedFile(runner, isCodex)
  const pagedUntil = existsSync(limitPage) ? readJson<number>(limitPage) : 0
  // an outage is held, not failed: the machine spends no attempt on it (claude-factory-dhof). Only this
  // reconciler sets hold; a worker's own report never does.
  const failOutage = (reason: string) => {
    const hold = holdFloor(reason, hit, pagedUntil, c.startedAt, now)
    send({ type: 'FAIL', seq: c.seq, reason, ...(hold === null ? {} : { hold }) })
  }
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
  else if (egressReason && !isAsking && (status === 'idle' || status === 'done')) failOutage(egressReason)
  else if (due === 'fail')
    failOutage(
      egressReason ??
        (info?.pending
          ? `worker never started on AX after ${timeoutMin} min: ${info.pending}`
          : `no report within ${timeoutMin} min`),
    )
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
    if (
      runner.deliver(
        c.pane,
        inbox.map(m => `[factory mail from ${m.from}] ${clipReport(m.text)}`).join('\n\n'),
      )
    )
      send({ type: 'READ', box: node, seen: c.mail[node]!.length })
  } else if (isAsking && status === 'idle' && runner.suspend) {
    runner.suspend(c.pane)
  } else if (
    !isAsking &&
    (status === 'idle' || status === 'done') &&
    // a worker waiting on its own build answers a nudge and goes idle again: give it longer each time
    now - Math.max(c.startedAt, c.nudgedAt) > GRACE_MS * 2 ** c.nudges
  ) {
    if (c.nudges >= NUDGES) failOutage(egressReason ?? 'worker stopped without reporting')
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

/** `HOME/gate-briefs.json`: the briefer's cleaned text for each live gate visit, keyed by `gatebrief.gateKey`. */
type GateBriefsFile = Record<string, { text: string; at: number }>
const gateBriefsFile = () => join(HOME, 'gate-briefs.json')
const readGateBriefs = (): GateBriefsFile =>
  existsSync(gateBriefsFile()) ? readJson<GateBriefsFile>(gateBriefsFile()) : {}

/** `HOME/reviews.json`: the reviewer's verdict for each skill and proposal text, keyed by `memory.reviewKey` (claude-factory-ag2). */
const reviewsFile = () => join(HOME, 'reviews.json')
const readReviews = (): Record<string, memory.Review> => {
  try {
    return existsSync(reviewsFile()) ? readJson<Record<string, memory.Review>>(reviewsFile()) : {}
  } catch {
    return {} // a corrupt reviews.json must not break the tick
  }
}
/** the verdict for a skill or proposal as it stands now, or undefined */
const verdictOf = (kind: 'skill' | 'proposal', name: string) => {
  const store = readReviews()
  const item = memory.reviewItems(MEMORY).find(i => i.kind === kind && i.name === name)
  return item ? store[item.key] : undefined
}

/** each pending skill and proposal that has a verdict, without its text */
const reviewedItems = () => {
  const store = readReviews()
  return memory.reviewItems(MEMORY).flatMap(({ text: _text, ...i }) => {
    const v = store[i.key]
    return v ? [{ ...i, recommendation: v.recommendation, why: v.why }] : []
  })
}

/** the stored brief for this run's current gate visit, or undefined when the briefer has not written one yet */
const gateBriefOf = (id: string, startedAt: number): string | undefined => {
  try {
    return readGateBriefs()[gatebrief.gateKey(id, startedAt)]?.text
  } catch {
    return undefined // a corrupt gate-briefs.json must not break every run's row
  }
}

function row(run: Run, def: Factory, value: unknown, c: Ctx, agent?: string | null, error?: string): Row {
  const [node, sub] = where(value)
  const n = def.nodes[node]
  const retries = n?.retries ?? 2
  // read gate-briefs.json once per row, not once per field (claude-factory-2u2.8)
  const gateBrief = n?.gate && sub === 'working' ? gateBriefOf(run.id, c.startedAt) : undefined
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
    ...(n && !n.gate && { model: ax.modelOf(agentOfNode(run, def, node)) }),
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
      sub === 'working' && {
        gate: {
          question: n.prompt.trim(),
          outcomes: Object.keys(n.next),
          ...(gateBrief && { brief: gateBrief }),
        },
      }),
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

/** a herdr worker's station ended: keep what its transcripts show. A failure here must never fail the tick */
function storeUsage(run: Run, pane: string, node: string, seq: number, startedAt: number) {
  try {
    if (runnerOf(pane).name !== 'herdr' || !startedAt) return
    const rows = usageOf(run, startedAt).map(u => ({ ...u, node, seq }))
    if (rows.length) appendUsage(run.id, rows)
  } catch {}
}
const usageFile = (id: string) => join(runDir(id), 'usage.jsonl')
const appendUsage = (id: string, rows: Usage[]) =>
  appendFileSync(usageFile(id), rows.map(r => JSON.stringify(r) + '\n').join(''))
/** a run's stored rows; a session and model that was stored twice (a resumed worker) keeps its last row */
function storedUsage(id: string): Usage[] {
  if (!existsSync(usageFile(id))) return []
  const rows = readFileSync(usageFile(id), 'utf8')
    .split('\n')
    .flatMap(l => {
      try {
        return l ? [JSON.parse(l) as Usage] : []
      } catch {
        return []
      }
    })
  return [...new Map(rows.map(r => [`${r.session}\0${r.model}`, r])).values()]
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
    const { seq, startedAt } = ctx()
    const node = where(actor.getSnapshot().value)[0]
    actor.send({ ...e, at } as Ev)
    if (pane && pane !== ctx().pane) {
      storeUsage(run, pane, node, seq, startedAt)
      runnerOf(pane).close(pane)
    }
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
      ...(sub === 'working' &&
        !def.nodes[node]?.gate &&
        facts(run, ctx(), now, harnessOf(agentOfNode(run, def, node)) === 'codex')),
    },
    manager: manager.map(m => ({ run: run.id, ...m })),
  }
}

/** a github.com pull request through REST (`gh api repos/<slug>/pulls/N`), or null when gh fails */
function pullSync(url: string, timeout: number) {
  const path = githubPullPath(url)
  if (!path) return null
  const p = Bun.spawnSync(['gh', 'api', path], { timeout })
  return p.exitCode === 0 ? parseGithubView(p.stdout.toString()) : null
}

/**
 * The run's own PR among the links its reports cite. One link is that PR. With several, a report may cite
 * a sibling PR, so the answer is the link whose head branch is the run's; no match records none, and the
 * ship run finds the PR from ship_branch.
 */
export function shipPrOf(
  links: string[],
  branch: string,
  headOf: (url: string) => string | null = url => pullSync(url, 20_000)?.headRefName || null,
) {
  if (links.length < 2) return links[0] ?? ''
  return links.find(url => headOf(url) === branch) ?? ''
}

/** mirrors a run into its bead, advancing `t` as each write lands so a failure retries next tick */
export function track(run: Run, def: Factory, value: unknown, c: Ctx, t: Track, now: number) {
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
    // A ship edge hands the approved PR to the rig's ship run (claude-factory-rtuw). It runs before
    // the open-children branch: approval is the end, and the ship run needs the bead open and queued.
    if (node === 'done' && typeof edge === 'object' && edge.ship) {
      const links = [...c.log].reverse().flatMap(e => [...prsIn(e.summary), ...mrsIn(e.summary)])
      const url = shipPrOf([...new Set(links)], run.branch)
      b.ship(id, run.id, { pr: url, branch: run.branch })
      // a parked ship run wakes on mail; one that is not live is started by the next shipPass
      for (const s of liveShipRuns().filter(s => s.run.repo === run.repo))
        post(s.run.id, {
          type: 'MAIL',
          from: 'factory',
          to: s.node,
          text: `${id} joined the ship queue: ${url || 'no pull request link'} (run ${run.id}).`,
        })
    }
    // open children, however the run ended: what is left is theirs to start, so the bead stays open
    // rather than deferred out of sight (dispatch skips it, so it does not come straight back)
    else if (openChildren(b, id).length) {
      b.release(id)
      b.comment(id, `run ${run.id} ended with open child beads, so this stays open for them: ${reason}`)
    }
    // a blocked run that waits on a person ends here: the bead goes to its owner, not to the deferred pile
    else if (node === 'aborted' && shouldHandToOwner(c.log, now))
      b.handToOwner(id, clip(c.log.at(-1)!.summary, 500))
    // deferred work is out of bd ready until a person undefers it, which hands it back to the factory
    else if (node === 'aborted') b.defer(id, `run ${run.id} was aborted`)
    // A requeue edge keeps the bead ready and factory-labeled for the next dispatch, in the factory
    // and station the edge names. REQUEUE_MAX stops a loop, because a factory that always requeues
    // must not run forever. `lookup` throws on a real bd failure, but `show` returns null instead.
    // A retried tick can misread that null as zero requeues so far (claude-factory-wnm.10). A retried
    // tick whose requeue already landed skips the cap, because `requeued_from` already names this
    // run. `b.requeue` below is idempotent for that case.
    else if (typeof edge === 'object' && edge.requeue) {
      const current = b.lookup(id)
      // dispatch never reads a factory:/station: label off a Linear-sourced bead (beads.ts
      // linearSourced, claude-factory-b6c.27). A requeue of that bead would restart the whole rig
      // factory at its own start station, not the edge's target, up to REQUEUE_MAX times in a row.
      // Defer it for a person instead (claude-factory-wnm.22).
      if (current && linearSourced(current)) {
        b.defer(
          id,
          `run ${run.id} ended on a requeue edge, but this bead is Linear-sourced: dispatch cannot read a factory:/station: label off it`,
        )
      } else {
        const already = current?.metadata?.requeued_from === run.id
        const requeues = Number(current?.metadata?.requeues ?? 0)
        // The cap defer must reset the counter. Without this reset, a person's undefer sends the bead
        // straight into a new defer on its next requeue. `requeues` would still read 5 or more
        // (claude-factory-wnm.17).
        if (!already && !(requeues >= 0 && requeues < REQUEUE_MAX)) {
          b.defer(id, `requeued ${REQUEUE_MAX} times`)
          b.setMetadata(id, { requeues: '0' })
        } else {
          b.requeue(id, run.id, edge.requeue === true ? undefined : edge.requeue)
          t.requeued = true
        }
      }
    } else if (typeof edge === 'object' && edge.defer) {
      // dispatch never reads a station label off a Linear-sourced bead, so it gets a plain defer
      const station = typeof edge.defer === 'object' ? edge.defer.station : undefined
      const current = station ? b.lookup(id) : undefined
      b.defer(id, reason, current && linearSourced(current) ? undefined : station)
    }
    // not the factory's to do: left open for a person, who queues it again or closes it
    else if (typeof edge === 'object' && edge.reject) b.reject(id, `${run.id}/${last!.node}`, reason)
    else if (!b.close(id, reason)) b.defer(id, `run ${run.id} could not close it: ${reason}`)
    else closeParents(b, run.repo, id, `run ${run.id}`)
    t.isSettled = true
  } else if (!isOver && t.isSettled) {
    t.isSettled = !b.reopen(id) // a run revived with goto
    // the prior ending is moot once revived: a goto past a requeue edge, then a later close, must not
    // count as a requeue (claude-factory-wnm.21)
    if (!t.isSettled) delete t.requeued
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
      rmSafe(dir, { recursive: true, force: true })
      mkdirSync(dir)
    } catch {
      return null // the holder let go meanwhile, or another taker won: the next try gets it
    }
  }
  writeFileSync(join(dir, 'pid'), String(process.pid))
  return () => rmSafe(dir, { recursive: true, force: true })
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

/** the repos that need a new ship run: a non-empty queue and no live ship run (claude-factory-rtuw) */
export const shipStarts = (repos: string[], queued: (repo: string) => number, live: ReadonlySet<string>) =>
  repos.filter(r => !live.has(r) && queued(r) > 0)

/** the live ship runs: the runner's own flag, or the id a ship run gets from its factory name */
const liveShipRuns = () =>
  runIds().flatMap(id => {
    try {
      const { run, value, c } = current(id)
      const ended = ['done', 'aborted'].includes(where(value)[0])
      return !ended && (run.ship || id.startsWith('ship-')) ? [{ run, node: where(value)[0], c }] : []
    } catch {
      return [] // removed mid-pass
    }
  })

/**
 * Starts one ship run for each rig whose ship queue holds a bead and which has no live ship run.
 * A ship run takes no room: it counts against FACTORY_MAX_RUNS and the rig's maxRuns never
 * (claude-factory-rtuw), so this does not call assertRoom. The beads pass calls it.
 */
async function shipPass() {
  if (halted()) return
  const live = new Set(liveShipRuns().map(s => s.run.repo))
  const byRepo = new Map(rigs().map(r => [r.repo, r]))
  const queues = new Map<string, number>()
  const queued = (repo: string) => {
    try {
      if (!hasBeads(repo)) return 0
      if (!queues.has(repo)) queues.set(repo, beads(repo, 'factory').shipQueue().length)
    } catch (err) {
      console.error(`${new Date().toISOString()} ship queue for ${repo}: ${(err as Error).message}`)
    }
    return queues.get(repo) ?? 0
  }
  for (const repo of shipStarts([...byRepo.keys()], queued, live)) {
    const rig = byRepo.get(repo)!
    try {
      const preview = await loadFactory(factorySource('ship', repo))
      if (preview.name !== 'ship') throw new Error(`its ship factory is named '${preview.name}', not 'ship'`)
      const goal = `Ship rig ${rig.name}'s queue: factory ship ${rig.name} lists the pull requests, next to merge first.`
      const { run } = await createTracked('ship', preview.name, repo, goal, undefined, undefined, true)
      console.log(`${new Date().toISOString()} ship for rig ${rig.name} → ${run.id}`)
    } catch (err) {
      console.error(`${new Date().toISOString()} ship for rig ${rig.name}: ${(err as Error).message}`)
    }
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
        // a parked run whose blocker needs a person ends; track() hands its bead to the owner
        const [liveNode, sub] = where(saved.snapshot.value)
        if (sub === 'waiting' && liveNode !== 'done' && liveNode !== 'aborted')
          if (shouldHandToOwner(saved.snapshot.context.log, Date.now())) post(id, { type: 'ABORT' })
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
    await shipPass()
    await linearPass()
    await dispatch()
    // repairs share the label pass's throttle: one labels.stamp gates both
    const labelsDue = !isFresh(join(HOME, 'labels.stamp'), LABELS_MS)
    await labelPass()
    if (labelsDue) await repairPass()
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

/** each run's journal entries since, for memory.helpOk(): a help from a red attempt weighs less */
const outcomesSince = (since: number): memory.AttemptOutcome[] =>
  runIds().flatMap(id => {
    try {
      const { log } = readJson<Saved>(join(runDir(id), 'state.json')).snapshot.context
      return log
        .filter(e => e.at > since)
        .map(e => ({ run: id, node: e.node, at: e.at, outcome: e.outcome, summary: e.summary }))
    } catch {
      return [] // removed mid-read
    }
  })

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
  const patrolFile = join(HOME, 'patrol-log.jsonl')
  const patrolLines = existsSync(patrolFile) ? readFileSync(patrolFile, 'utf8').split('\n') : []
  // merged by sorting the already-formatted lines: both share the `- YYYY-MM-DD HH:mm ` prefix, which
  // sorts the same as the timestamp it carries (claude-factory-72v.6)
  const merged = [...activity, ...memory.patrolActivity(patrolLines, since)].sort()
  const skills = memory.skills(MEMORY).map(s => {
    const u = used.get(s.name)
    return `- ${s.name}: ${u ? `${u.n}, last ${new Date(u.last).toISOString().slice(0, 10)}` : 'never used'}: ${s.description}`
  })
  return { activity: merged.slice(-400), skills } // ponytail: the newest 400 lines; a day's patrols fit
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

/** the manager hears once of each set of pending proposals, like skillMail (claude-factory-3u1.3.2, FR-019) */
function proposalMail(now: number) {
  const file = join(HOME, 'proposals.json')
  const pending = memory.proposals(MEMORY).filter(p => p.status === 'pending')
  const key = JSON.stringify(pending.map(p => p.name))
  if (key === (existsSync(file) ? readFileSync(file, 'utf8') : '[]')) return []
  writeFileSync(file, key)
  if (!pending.length) return []
  return [{ run: 'factory', from: 'dream', text: memory.proposalMailText(pending, CLI), at: now }]
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
 * untilStatus() needs the bd and gh lookups for the `until` marker of a short note (claude-factory-3u1.1.4).
 * dream() and `memory compact` give these lookups to applyTiers(). Each pass checks a bead or PR marker
 * against the real tracker. It does not check only the date.
 *
 * `bead(id)` needs the prefix of every bead-tracking rig. It loads that list on the first call. So
 * a pass with no bead marker at all runs no `bd config get` command.
 *
 * `bead(id)` uses `prefixStrict()`, not the lenient `prefix()`. A rig's own prefix lookup can fail
 * (bd down, a timeout). `prefixStrict()` throws in that case, instead of reading it as "no prefix"
 * by mistake. `bead(id)` sets that rig apart, as a rig it cannot speak for.
 *
 * `bead(id)` then picks the healthy rig whose prefix matches `${prefix}-`. The longest prefix wins.
 * For example, "acme-widget" wins over "acme", because two rigs can share a short prefix.
 *
 * Two cases give no matching healthy rig. First: every prefix lookup worked, and the id belongs to
 * no rig. Then `bead(id)` returns null, the same result bd itself gives for "not found" (AC2).
 * Second: a rig's prefix lookup failed, so `bead(id)` cannot tell whether that rig would have
 * matched. Then `bead(id)` throws, instead of a wrong guess of "not found". untilStatus() reports
 * "lookup failed" for this case, never "ended".
 *
 * When `bead(id)` finds a healthy owner, it calls `beads(repo, 'factory/dream').lookup(id)`. A
 * throw there (bd down or slow, after the prefix call worked) reaches untilStatus() the same way.
 *
 * The `bd()` helper in `beads.ts` sets no timeout. A hung bd process hangs this pass, and the
 * dream.lock that it runs under, instead of throwing. Only a bd process that exits non-zero, or
 * exits 0 with an answer untilStatus() cannot use, throws or returns null here.
 *
 * `pr(url)` runs `gh api repos/<owner>/<repo>/pulls/<n>` with a 30 s timeout. If the exit code is 0,
 * `pr(url)` maps the REST pull to a state (a merge date makes it MERGED). Any other exit code returns null.
 *
 * One pass makes at most 50 gh calls. The worst case is 50 x 30 s = 25 min, when every call hangs
 * to its timeout. A PR after the 50th stays unmatched (null). untilStatus() flags that PR, and
 * does not guess (AC11).
 *
 * Both lookups keep each result by value, for the one pass that calls this function. A marker
 * that two notes share costs one bd or gh call, not two.
 */
function untilDeps(): memory.UntilDeps {
  const beadCache = new Map<string, 'closed' | 'open' | null>()
  const prCache = new Map<string, PrState | null>()
  let ghCalls = 0
  // loaded on the first bead() call, not here: a pass with no bead marker runs no bd command
  let owners: { repo: string; prefix: string }[] | null = null
  let someRigPrefixFailed = false
  const loadOwners = () => {
    if (owners) return
    const healthy: { repo: string; prefix: string }[] = []
    for (const r of rigs().filter(r => hasBeads(r.repo))) {
      try {
        healthy.push({ repo: r.repo, prefix: beads(r.repo, 'factory/dream').prefixStrict() })
      } catch {
        someRigPrefixFailed = true // this rig cannot be ruled out as the owner of an unmatched id
      }
    }
    // longest prefix first, so "acme-widget" wins over "acme" for an id that starts with both
    owners = healthy.sort((a, b) => b.prefix.length - a.prefix.length)
  }
  return {
    bead: (id: string) => {
      if (beadCache.has(id)) return beadCache.get(id)!
      loadOwners()
      const owner = owners!.find(o => id.startsWith(`${o.prefix}-`))
      if (!owner) {
        if (someRigPrefixFailed) throw new Error(`bead ${id}: a rig's prefix lookup failed`)
        beadCache.set(id, null)
        return null
      }
      const bead = beads(owner.repo, 'factory/dream').lookup(id)
      const result: 'closed' | 'open' | null =
        bead === null ? null : bead.status === 'closed' ? 'closed' : 'open'
      beadCache.set(id, result)
      return result
    },
    pr: (url: string) => {
      if (prCache.has(url)) return prCache.get(url)!
      if (ghCalls >= 50) {
        prCache.set(url, null) // past the budget: stays unmatched, so untilStatus() flags it, never retires it
        return null
      }
      ghCalls++
      const state: PrState | null = pullSync(url, 30_000)?.state ?? null
      prCache.set(url, state)
      return state
    },
  }
}

/**
 * One compact commit's message. The dream's compact step and `memory compact` both use it.
 * It reads "N merged, M archived, F1 files -> F2 files". It adds ", H held by the archive cap"
 * right after the archived count, only when the cap held notes back this pass.
 *
 * It adds ", R retired" right after the held clause. It adds this clause only when tiers.retired
 * is over 0 (AC10). A retire is a note whose `until` marker ended. It writes to .archive like an
 * archive, but it keeps its own count, so a compact log line shows the two apart.
 *
 * It adds ", F flagged" right after the retired clause. It adds this clause only when
 * tiers.flagged is over 0 (AC10). A flag never removes a note. It marks only an `until` marker
 * that untilStatus() failed to check.
 *
 * It adds a clause for each topic still over the cap after the pass. The clause reads
 * ", K topic(s) over the cap of N: a (17); b (16)". Each topic reads "name (count)". The worst
 * topic comes first: the same order as tiers.overCap.
 *
 * It keeps the trailing skipped-topics clause unchanged.
 */
function compactMessage(
  tiers: {
    merged: number
    archived: number
    retired: number
    trimmed?: number
    flagged: number
    held: number
    skipped: { topic: string; reason: string }[]
    overCap: { topic: string; count: number }[]
    topicCap: number
  },
  filesBefore: number,
  filesAfter: number,
): string {
  return (
    `compact: ${tiers.merged} merged, ${tiers.archived} archived` +
    (tiers.held ? `, ${tiers.held} held by the archive cap` : '') +
    (tiers.retired ? `, ${tiers.retired} retired` : '') +
    (tiers.trimmed ? `, ${tiers.trimmed} long entries trimmed` : '') +
    (tiers.flagged ? `, ${tiers.flagged} flagged` : '') +
    `, ${filesBefore} files -> ${filesAfter} files` +
    (tiers.overCap.length
      ? `, ${tiers.overCap.length} topic(s) over the cap of ${tiers.topicCap}: ${tiers.overCap.map(o => `${o.topic} (${o.count})`).join('; ')}`
      : '') +
    (tiers.skipped.length
      ? `, ${tiers.skipped.length} topic(s) skipped: ${tiers.skipped.map(s => `${s.topic} (${s.reason})`).join('; ')}`
      : '')
  )
}

/**
 * grooms the memory with a headless worker that can only edit inside it: files the inbox under topics,
 * merges and prunes, mines the journals since the last dream, reorders. Committed before and after.
 */
/** the dream's own sessions (hr94): one name=dream row for each model in manager-usage.jsonl. Never throws */
function storeDreamUsage(start: number) {
  try {
    const rows = usageIn(MEMORY, '', () => '?', start)
    appendFileSync(
      join(HOME, 'manager-usage.jsonl'),
      rows
        .map(u =>
          JSON.stringify({
            name: 'dream',
            at: Date.now(),
            model: u.model,
            input: u.input,
            cacheWrite: u.cacheWrite,
            cacheRead: u.cacheRead,
            output: u.output,
            turns: u.turns,
            peak: u.peak,
          }),
        )
        .map(l => l + '\n')
        .join(''),
    )
  } catch {}
}

async function dream() {
  const release = hold('dream.lock')
  if (!release) return 'a dream is already running'
  try {
    writeFileSync(join(HOME, 'dream.stamp'), '') // a failed dream waits for the next day too, rather than retrying every tick
    mkdirSync(MEMORY, { recursive: true })
    if (!existsSync(join(MEMORY, '.git'))) {
      git(MEMORY, 'init', '-q')
    }
    // git tracks .usage.jsonl itself, so counts survive a clone or a lost file (claude-factory-503.3).
    // Only its crash-safe temp file (memory.ts:584-601) and the search index cache stay ignored.
    writeFileSync(join(MEMORY, '.gitignore'), '.index.json*\n.usage.jsonl.tmp\n')
    commitMemory('notes since the last dream')
    // the journal since the last dream that finished: a failed one leaves its entries to the next
    const since = Number(git(MEMORY, 'log', '-1', '--grep=^dream:', '--format=%at')) * 1000
    const journal = journalSince(since)
    const manager = managerSince(since)
    if (!journal.length && !memory.inboxCount(MEMORY) && !manager.activity.length)
      return 'nothing new since the last dream'
    const start = Date.now()
    const before = git(MEMORY, 'rev-parse', 'HEAD')
    const { promotions, duplicates } = await memory.tierCandidates(MEMORY)
    const proposalsBefore = memory.proposals(MEMORY)
    // listed for the dream to fix by hand (claude-factory-59r.21): applyTiers() finds the same topics
    // again, each time it skips a merge into one of them
    const unsafe = memory.unsafeLongTopics(MEMORY).map(u => `- ${u.reason}`)
    const overCap = memory
      .overCapTopics(MEMORY)
      .map(t => `- ${t.topic}: ${t.count} short notes (cap ${memory.envTopicCap()})`)
    const prompt = memory.dreamPrompt(
      MEMORY,
      journal,
      memory.usageLines(MEMORY),
      closedBeads(),
      manager,
      promotions,
      duplicates,
      unsafe,
      overCap,
      memory.envTopicCap(),
      {
        // every run still in the home, not only since the last dream: a class builds up over days
        failures: memory.failureClasses(outcomesSince(0)),
        relearned: await memory.relearned(MEMORY),
        proposals: proposalsBefore.map(p => `- ${p.name} (${p.status}, rung ${p.rung})`),
      },
    )
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
    // dream.log keeps history: a log past 256 KB moves to dream.log.1 (one old file, replaced each time)
    const dreamLog = join(HOME, 'dream.log')
    if (existsSync(dreamLog) && statSync(dreamLog).size > 256 * 1024) renameSync(dreamLog, `${dreamLog}.1`)
    appendFileSync(dreamLog, `${new Date(start).toISOString()} exit ${p.exitCode}\n${said}\n`)
    storeDreamUsage(start)
    if (p.exitCode !== 0) return said
    // FR-018: at most PROPOSAL_CAP (3) new proposals per dream, whatever the dream wrote
    const overProposals = memory.proposalsOverCap(
      proposalsBefore.map(p => p.name),
      memory.proposals(MEMORY).map(p => p.name),
    )
    for (const name of overProposals) rmSync(join(memory.proposalsDir(MEMORY), `${name}.md`))
    if (overProposals.length)
      appendFileSync(join(HOME, 'dream.log'), `dropped proposals over the cap: ${overProposals.join(', ')}\n`)
    git(MEMORY, 'add', '-A')
    // a filed or renamed note keeps its counts. An entry a dream merged by hand keeps its usage too,
    // through the alias it left on the entry that absorbed it (claude-factory-59r.11).
    // Read from the staged index (--cached), not HEAD. compact() runs below, before the commit.
    // git add -A then restages its writes, so they land inside the commit and the repo stays clean
    // right after it (claude-factory-503.3).
    const renamed: Record<string, string> = {
      ...Object.fromEntries(
        git(MEMORY, 'diff', '-M', '--name-status', '--cached', before)
          .split('\n')
          .filter(l => l.startsWith('R'))
          .map(l => l.split('\t').slice(1)),
      ),
      ...memory.longAliasRenames(MEMORY),
    }
    // logged before applyTiers runs: applyTiers reads usage fresh, so a note the dream renamed must
    // already resolve to its new path, or it looks never used and risks archive (claude-factory-59r.10)
    // each help since the last dream gets its attempt's outcome as it folds (claude-factory-3u1.2.4)
    const outcomes = outcomesSince(since)
    memory.compact(MEMORY, renamed, Date.now(), (by, at) => memory.helpOk(outcomes, by, at))
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
    let pass = { archived: 0, retired: 0 } // the tier pass's archives, for the metrics line below
    if (process.env.FACTORY_MEMORY_TIERS !== '0') {
      const filesBefore = memory.mdFileCount(MEMORY)
      // the plan reaches dream.log before applyTiers writes or removes anything (claude-factory-503.2):
      // appended, since line 2327 above already overwrote it with this dream's own exit text
      const tiers = memory.applyTiers(MEMORY, {
        now: start,
        untilDeps: untilDeps(),
        onPlan: lines => appendFileSync(join(HOME, 'dream.log'), lines.join('\n') + '\n'),
      })
      memory.compact(MEMORY, tiers.renamed)
      git(MEMORY, 'add', '-A')
      // its own commit, dated with the dream it followed, even when it merged and archived nothing
      git(
        MEMORY,
        'commit',
        '-q',
        '--allow-empty',
        `--date=@${Math.floor(start / 1000)}`,
        '-m',
        compactMessage(tiers, filesBefore, memory.mdFileCount(MEMORY)),
      )
      pass = tiers
    }
    // after every write of this dream, so the numbers describe what the next worker searches
    appendFileSync(join(HOME, 'dream.log'), memory.lifecycleMetrics(memory.walk(MEMORY).notes, pass) + '\n')
    return said
  } finally {
    release()
  }
}
const devenvConfig = () => join(HOME, 'devenv.json')
const DEVENV_CHECK_MS = 30 * 60_000
const GC_MS = Number(process.env.FACTORY_GC_MS) || 3_600_000

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

/** a watch pass at most once a minute. Checked here, so a busy or too-recent pass costs no process
 * every tick (claude-factory-960) */
const kickWatch = () => {
  const stamp = join(HOME, 'watch.stamp')
  const age = existsSync(stamp) ? Date.now() - statSync(stamp).mtimeMs : Infinity
  if (isHeld('watch.lock') || age < WATCH_MS) return
  spawnChild(CLI, ['watch'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

/** a sync pass when none runs and the last one is older than a dispatch interval */
const kickSync = () => {
  const stamp = join(HOME, 'sync.stamp')
  const age = existsSync(stamp) ? Date.now() - statSync(stamp).mtimeMs : Infinity
  if (isHeld('sync.lock') || age < DISPATCH_MS) return
  spawnChild(CLI, ['sync'], {
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

const SELF_UPDATE_MS = Number(process.env.FACTORY_SELF_UPDATE_MS) || 5 * 60_000
/**
 * Fast-forwards this checkout to origin/main. It does this at most every FACTORY_SELF_UPDATE_MS.
 * This way, a merge to main goes live here with no manual `git pull` (claude-factory-5h9.8).
 *
 * The update itself runs under 'tick.lock', the same lock tick() takes. A concurrent tick() sees
 * the lock held. That tick() then reports busy, and waits until the update finishes. This way,
 * no tick runs mid-merge against a half-updated checkout.
 */
const kickSelfUpdate = () => {
  // FACTORY_SELF_UPDATE=0 is a full no-op here, not a recorded refusal: it never spawns, so it
  // never writes self-update.json and never mails anyone. (A direct `factory self-update` still
  // checks the same switch itself, and reports the refusal to whoever ran it.)
  if (process.env.FACTORY_SELF_UPDATE === '0') return
  const stamp = join(HOME, 'self-update.stamp')
  const lastAt = existsSync(stamp) ? statSync(stamp).mtimeMs : undefined
  if (isHeld('tick.lock') || !selfupdate.isDue(lastAt, Date.now(), SELF_UPDATE_MS)) return
  writeFileSync(stamp, '')
  spawnChild(CLI, ['self-update'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

const selfUpdateFile = () => join(HOME, 'self-update.json')
/** does the actual fast-forward; see kickSelfUpdate's note on why it takes 'tick.lock' */
function runSelfUpdate(): selfupdate.State | null {
  const release = hold('tick.lock')
  if (!release) return null // a tick, or another self-update, is already running: the next kick tries again
  try {
    const state = selfupdate.selfUpdate(ROOT, { enabled: process.env.FACTORY_SELF_UPDATE !== '0' })
    writeJson(selfUpdateFile(), state)
    return state
  } finally {
    release()
  }
}

/**
 * The manager hears of each real outcome once: an update, or a new refusal reason. A no-op stays
 * quiet. But a no-op also clears the mailed marker (claude-factory-5h9.12, claude-factory-6d9).
 *
 * Without this clear, 2 refusals with one no-op between them mailed only the first. The no-op
 * left the marker untouched. The second refusal's reason matched that old marker, so it looked
 * already mailed.
 *
 * `home` defaults to HOME. A test can pass its own temp dir instead.
 */
export function selfUpdateMail(now: number, home = HOME): (Mail & { run: string })[] {
  const file = join(home, 'self-update.json')
  if (!existsSync(file)) return []
  const state = readJson<selfupdate.State>(file)
  const mailedFile = join(home, 'self-update-mailed.json')
  if (state.ok && state.from === state.to) {
    if (existsSync(mailedFile)) rmSync(mailedFile)
    return [] // already up to date: nothing worth a mail
  }
  const last = existsSync(mailedFile) ? readJson<string>(mailedFile) : ''
  if (state.why === last) return []
  writeJson(mailedFile, state.why)
  const text = state.ok
    ? `factory self-update: ${state.why} (${ROOT})`
    : `factory self-update did not update ${ROOT}: ${state.why}`
  return [{ run: 'factory', from: 'factory', text, at: now }]
}

/** stored token usage table of the runs in recs; '' when nothing was stored and emptyOk is false */
export function tokenTable(recs: ReturnType<typeof records>, emptyOk: boolean, since = 0): string {
  const rows = recs.flatMap(r => (r.sessions ?? []).map(u => ({ ...u, run: r.id })))
  const manager = managerUsage(since)
  if (!rows.length && !manager.length && !emptyOk) return ''
  return renderTokens(rows, new Set(recs.filter(r => fate(r) === 'shipped').map(r => r.id)), manager)
}

/** token usage of the runs from the last days days */
export function tokenReport(days: number): string {
  const since = Date.now() - days * 86_400_000
  return tokenTable(
    records().filter(r => r.createdAt >= since),
    false,
    since,
  )
}

/**
 * Mails the manager the `factory metrics --tokens` table once a week. Set FACTORY_TOKEN_DIGEST_MS to
 * change the period. FACTORY_TOKEN_DIGEST=0 turns the mail off. The function writes the date before it
 * runs the digest, so a failing digest waits a week. An empty digest sends no mail.
 */
export function tokenDigestMail(
  now: number,
  home = HOME,
  digest: () => string = () => tokenReport(7),
): (Mail & { run: string })[] {
  if (process.env.FACTORY_TOKEN_DIGEST === '0') return []
  const file = join(home, 'token-digest.json')
  const period = Number(process.env.FACTORY_TOKEN_DIGEST_MS) || 7 * 86_400_000
  if (existsSync(file) && now - readJson<{ at: number }>(file).at < period) return []
  writeJson(file, { at: now })
  let report = ''
  try {
    report = digest()
  } catch {
    return [] // a failing digest must not break tick; the date is already written
  }
  if (!report) return []
  return [
    { run: 'factory', from: 'factory', text: `factory weekly token digest, last 7d:\n${report}`, at: now },
  ]
}

const CONFIG_SYNC_MS = 10 * 60_000
// what a home's .gitignore lets in (its config: rigs.json) to its branch, and the memory to the memory branch
export const CONFIG_SYNC = `git remote get-url origin >/dev/null 2>&1 || exit 0
git add -A && { git diff --cached --quiet || git commit -qm 'factory: sync config'; }
timeout 120 git push -q origin HEAD
[ -d memory/.git ] && timeout 120 git -C memory push -q "$(git remote get-url origin)" HEAD:refs/heads/memory`

/**
 * every 10 minutes, a factory home that is a git repo with an origin pushes its config, so the factory can
 * be rebuilt from its repo: `git init` the home, a .gitignore that lets in only the config, and an origin
 */
const kickConfigSync = () => {
  const stamp = join(HOME, 'config.stamp')
  if (!existsSync(join(HOME, '.git'))) return
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < CONFIG_SYNC_MS) return
  writeFileSync(stamp, '') // a failed push waits for the next window, rather than retrying every tick
  spawnChild('sh', ['-c', CONFIG_SYNC], { cwd: HOME, detached: true, stdio: 'ignore' }).unref()
}

const SIDEBAR_TTL_MS = 5 * 60_000
/** the workspace of the pane this runs in, when that pane sits in this factory's directory */
function managerWorkspace(): string | undefined {
  const id = process.env['HERDR_PANE_ID']
  if (!id) return undefined
  const pane = JSON.parse(Bun.spawnSync([HERDR(), 'pane', 'get', id]).stdout.toString() || '{}').result?.pane
  const isOurs = pane?.cwd && (factoryAt(pane.cwd) ?? join(ROOT, '.factory-state')) === HOME
  return isOurs ? pane.workspace_id : undefined
}
/**
 * herdr's sidebar renders $factory on each run's workspace and the rollup on the manager's. Only a patrol
 * tick from a pane whose directory is this factory's names the manager: a start or fork run for another
 * factory, or a background session forked from a manager, ticks from someone else's pane.
 * Only changes are reported, refreshed before the TTL, so a stopped factory's lapse.
 * No-op with no herdr installed (an AX-only rig, or a CI box): nothing there can show a sidebar.
 */
function showInSidebar(rows: Row[], now: number, isPatrol: boolean) {
  if (!herdrInstalled()) return
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
    Bun.spawnSync([HERDR(), 'workspace', 'report-metadata', ws, '--source', 'claude-factory', ...token])
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
// no herdr installed: no panes (an AX-only rig, or a CI box, has none to reap)
const herdrPanes = (): HerdrPane[] =>
  herdrInstalled()
    ? (JSON.parse(Bun.spawnSync([HERDR(), 'pane', 'list']).stdout.toString() || '{}').result?.panes ?? [])
    : []
// herdr reuses workspace ids, so a run's workspace is still its own only while a pane there sits in its worktree
const isIn = (p: HerdrPane, r: Pick<Run, 'ws' | 'worktree'>) =>
  p.workspace_id === r.ws && !!p.cwd && (p.cwd === r.worktree || p.cwd.startsWith(`${r.worktree}/`))

/**
 * gc's own herdr read.
 *
 * herdrPanes() fails open to `[]`. An empty answer there only skips a reap pass. That is safe.
 * This function fails closed to `null` instead. It returns `null` in four cases: herdr is missing,
 * the call's exit code is non-zero, the JSON is bad, or the answer has no `result.panes`.
 *
 * When this is `null`, gc removes no launch script. A herdr outage must never look like "no live
 * panes" (claude-factory-503.1.3).
 */
function strictPanes(): Set<string> | null {
  if (!herdrInstalled()) return null
  const p = Bun.spawnSync([HERDR(), 'pane', 'list'])
  if (p.exitCode !== 0) return null
  try {
    const panes = JSON.parse(p.stdout.toString() || '{}').result?.panes
    return Array.isArray(panes) ? new Set(panes.map((x: HerdrPane) => x.pane_id)) : null
  } catch {
    return null
  }
}

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
  for (const ws of workspaces) Bun.spawnSync([HERDR(), 'workspace', 'close', ws])
  for (const pane of panes) Bun.spawnSync([HERDR(), 'pane', 'close', pane])
  for (const what of [...workspaces.map(w => `workspace ${w}`), ...panes.map(p => `pane ${p}`)])
    console.error(`${new Date().toISOString()} reaped ${what}`)
}

const launchDir = () => join(HOME, 'launch')
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
/** a directory's bytes and file count. This walks the directory with lstat. A symlink inside it
 * counts as itself. It never counts what the symlink points at. */
function dirSize(path: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  for (const name of readdirSync(path)) {
    const st = lstatSync(join(path, name))
    if (st.isDirectory()) {
      const s = dirSize(join(path, name))
      bytes += s.bytes
      files += s.files
    } else {
      bytes += st.size
      files += 1
    }
  }
  return { bytes, files }
}
/** the top-level facts of one run's directory, as gc.gcPlan() needs them: no symlink followed */
function runFact(id: string): gc.RunFact {
  const dir = runDir(id)
  const entries: gc.FileFact[] = readdirSync(dir).map(name => {
    const st = lstatSync(join(dir, name))
    const { bytes, files } = st.isDirectory() ? dirSize(join(dir, name)) : { bytes: st.size, files: 1 }
    return { name, isDir: st.isDirectory(), bytes, files }
  })
  const { value, c } = current(id)
  return { id, node: where(value)[0], finishedAt: c.log.at(-1)?.at ?? createdAt(id), entries }
}
function launchFacts(): gc.LaunchFact[] {
  const dir = launchDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.sh'))
    .map(f => {
      const st = lstatSync(join(dir, f))
      return { pane: f.slice(0, -'.sh'.length), bytes: st.size, mtimeMs: st.mtimeMs }
    })
}
/**
 * Removes the reproducible files of a done or aborted run older than `days`. It also removes a
 * dead launch script. It follows the rules in gc.gcPlan().
 *
 * `--dry-run` only prints the bytes per kind. It deletes nothing (claude-factory-503.1).
 */
function gcPass(days: number, dryRun: boolean) {
  const now = Date.now()
  // a run dir removed mid-pass, or one with no run.json/state.json, must not fail the whole pass
  // (claude-factory-503.1.6)
  const runs = runIds().flatMap(id => {
    try {
      return [runFact(id)]
    } catch (err) {
      console.error(`gc: skipping ${id}: ${(err as Error).message}`)
      return []
    }
  })
  const launch = launchFacts()
  const livePanes = strictPanes()
  const plan = gc.gcPlan(runs, launch, livePanes, now, days)
  const totalBytes =
    plan.totals.prompts.bytes +
    plan.totals.briefs.bytes +
    plan.totals.backups.bytes +
    plan.totals.launch.bytes
  const totalFiles =
    plan.totals.prompts.files +
    plan.totals.briefs.files +
    plan.totals.backups.files +
    plan.totals.launch.files
  console.log(
    [
      `prompts: ${plan.totals.prompts.files} files, ${fmtBytes(plan.totals.prompts.bytes)}`,
      `briefs: ${plan.totals.briefs.files} files, ${fmtBytes(plan.totals.briefs.bytes)}`,
      `backups: ${plan.totals.backups.files} files, ${fmtBytes(plan.totals.backups.bytes)}`,
      `launch: ${plan.totals.launch.files} files, ${fmtBytes(plan.totals.launch.bytes)}`,
      `total: ${totalFiles} files, ${fmtBytes(totalBytes)} across ${plan.totals.runs} run(s)`,
      ...(livePanes === null ? ['herdr pane list did not answer: removed no launch script'] : []),
    ].join('\n'),
  )
  if (dryRun) return
  for (const r of plan.runs) {
    if (r.paths.includes('prompts')) {
      const dir = join(runDir(r.id), 'prompts')
      const listFile = promptsListFile(r.id)
      // Union with any names prompts.list already held (claude-factory-503.1.7): a goto revive
      // after an earlier gc can have refilled prompts/ with only its new names, and overwriting
      // the list here would lose the old station names.
      const old = existsSync(listFile) ? readJson<string[]>(listFile) : []
      const current = existsSync(dir) ? readdirSync(dir) : []
      writeJson(listFile, [...new Set([...old, ...current])])
    }
    appendFileSync(join(HOME, 'metrics.jsonl'), JSON.stringify(record(r.id)) + '\n')
    for (const p of r.paths) rmSafe(join(runDir(r.id), p), { recursive: true, force: true })
  }
  for (const pane of plan.launch) rmSync(join(launchDir(), `${pane}.sh`), { force: true })
}
/** a gc pass at most every GC_MS (default hourly). FACTORY_GC=0 turns this off: tick spawns none. */
const kickGc = () => {
  if (process.env.FACTORY_GC === '0') return
  const stamp = join(HOME, 'gc.stamp')
  const age = existsSync(stamp) ? Date.now() - statSync(stamp).mtimeMs : Infinity
  if (isHeld('gc.lock') || age < GC_MS) return
  spawnChild(CLI, ['gc'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

// ---- `factory gc --worktrees` (claude-factory-l38): the impure half. gc.worktreePlan() decides.
// Everything below reads real git, gh, bd and herdr state into facts. It then carries out the plan.

/** the strict herdr read gc.worktreePlan() needs: null on any failure, so it keeps every worktree
 * instead of reading a herdr outage as "no live panes" (the same fail-closed rule as strictPanes) */
function strictPaneCwds(): { cwd: string }[] | null {
  if (!herdrInstalled()) return null
  const p = Bun.spawnSync([HERDR(), 'pane', 'list'])
  if (p.exitCode !== 0) return null
  try {
    const panes = JSON.parse(p.stdout.toString() || '{}').result?.panes
    return Array.isArray(panes)
      ? panes.filter((x: HerdrPane) => x.cwd).map((x: HerdrPane) => ({ cwd: x.cwd! }))
      : null
  } catch {
    return null
  }
}

type WtEntry = { path: string; branch: string | null; locked: boolean; prunable: boolean }
/**
 * `git worktree list --porcelain`, split into entries. This marks the rig's own checkout `locked`
 * (claude-factory-l38.11). gc must never remove it, and must keep any factory/* branch checked out
 * there (an unusual case) in `keptBranches` too.
 *
 * `git worktree list` always prints the real path. This function compares paths after
 * `realpathSync`, so a symlinked repo path still matches and keeps this protection.
 */
function worktreeEntries(repo: string): WtEntry[] {
  const p = Bun.spawnSync(['git', '-C', repo, 'worktree', 'list', '--porcelain'])
  if (p.exitCode !== 0) return []
  let repoReal = repo
  try {
    repoReal = realpathSync(repo)
  } catch {
    // repo itself unreadable: fall through with the raw path, so nothing below throws on it
  }
  const out: WtEntry[] = []
  let cur: WtEntry | null = null
  for (const line of p.stdout.toString().split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { path: line.slice('worktree '.length), branch: null, locked: false, prunable: false }
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice('branch refs/heads/'.length)
    else if (cur && line.startsWith('locked')) cur.locked = true
    else if (cur && line.startsWith('prunable')) cur.prunable = true
  }
  if (cur) out.push(cur)
  return out.map(e => {
    let real = e.path
    try {
      real = realpathSync(e.path)
    } catch {
      // gone already: worktreeFacts()'s own existsSync check drops it next, this mapping is moot
    }
    return real === repoReal ? { ...e, locked: true } : e
  })
}
const UNTRACKED_IGNORE = '.beads.gate.lock'
/** each worktree's dirty state and disk use. `du -sk` runs once per worktree: slow at hundreds of
 * worktrees, but gc runs at most daily and the bytes feed both the plan and the report line. */
function worktreeFacts(repo: string): gc.WorktreeFact[] {
  return worktreeEntries(repo).flatMap(e => {
    if (e.prunable || !existsSync(e.path)) return [] // gone already: nothing for gc to remove here
    const status = Bun.spawnSync(['git', '-C', e.path, 'status', '--porcelain'])
    let dirty: gc.WorktreeFact['dirty'] = 'clean'
    if (status.exitCode !== 0) {
      // a failed read must never read as clean (claude-factory-l38.7): worktreePlan() then keeps it
      dirty = 'unknown'
    } else {
      const lines = status.stdout
        .toString()
        .split('\n')
        .filter(l => l.length > 3 && l.slice(3) !== UNTRACKED_IGNORE)
      if (lines.length) {
        const others = Bun.spawnSync(['git', '-C', e.path, 'ls-files', '--others', '--exclude-standard'])
        if (others.exitCode !== 0) {
          // a failed read must never read as small (claude-factory-l38.7): never force-remove on a guess
          dirty = 'unknown'
        } else {
          const bytes = others.stdout
            .toString()
            .split('\n')
            .filter(Boolean)
            .reduce((a, rel) => {
              try {
                return a + lstatSync(join(e.path, rel)).size
              } catch {
                return a
              }
            }, 0)
          dirty = bytes > gc.UNTRACKED_MAX_BYTES ? 'large' : 'small'
        }
      }
    }
    // a detached HEAD (branch null) can hold commits reachable from no branch, remote or tag: a
    // straight removal would make them unreachable for good (claude-factory-l38.9). A worktree that
    // has a branch checked out never has any (the branch itself covers HEAD), so this is a no-op there.
    if (dirty === 'clean') {
      const revlist = Bun.spawnSync([
        'git',
        '-C',
        e.path,
        'rev-list',
        '-n',
        '1',
        'HEAD',
        '--not',
        '--branches',
        '--remotes',
        '--tags',
      ])
      if (revlist.exitCode !== 0)
        dirty = 'unknown' // a failed read must never read as clean (AC5-style)
      else if (revlist.stdout.toString().trim()) dirty = 'small' // snapshot it before removal, not removed bare
    }
    const du = Bun.spawnSync(['du', '-sk', e.path])
    const kb = du.exitCode === 0 ? Number(du.stdout.toString().split('\t')[0]) : 0
    return [
      { path: e.path, branch: e.branch, locked: e.locked, dirty, bytes: Number.isFinite(kb) ? kb * 1024 : 0 },
    ]
  })
}

/** every factory/* branch's local and remote tip, and whether each is an ancestor of origin's default
 * branch. null on any failure (fetch, ls-remote, or no default ref): gc then deletes no branch here (AC5).
 *
 * `dryRun` skips the `git fetch` (claude-factory-l38.15): AC1 says a dry run changes nothing, and
 * a fetch can move `refs/remotes/origin/*` when the remote has commits this repo has not seen yet.
 * A dry run then reads whatever this repo already knows, which can lag the real remote. */
function branchFacts(repo: string, dryRun: boolean): gc.BranchFact[] | null {
  if (!dryRun) {
    const fetch = Bun.spawnSync(['git', '-C', repo, 'fetch', '--quiet', '--no-tags', 'origin'], {
      env: GIT_NETWORK_ENV,
      timeout: 120_000,
    })
    if (fetch.exitCode !== 0) return null
  }
  const sym = Bun.spawnSync(['git', '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (sym.exitCode !== 0) return null
  const base = Bun.spawnSync(['git', '-C', repo, 'rev-parse', sym.stdout.toString().trim()])
  if (base.exitCode !== 0) return null
  const baseSha = base.stdout.toString().trim()
  const local = Bun.spawnSync([
    'git',
    '-C',
    repo,
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    'refs/heads/factory/',
  ])
  const remote = Bun.spawnSync(
    ['git', '-C', repo, 'ls-remote', '--heads', 'origin', 'refs/heads/factory/*'],
    { env: GIT_NETWORK_ENV, timeout: GIT_NETWORK_TIMEOUT_MS },
  )
  if (local.exitCode !== 0 || remote.exitCode !== 0) return null
  const byName = new Map<string, { local: string | null; remote: string | null }>()
  const get = (name: string) => byName.get(name) ?? { local: null, remote: null }
  for (const line of local.stdout.toString().split('\n').filter(Boolean)) {
    const [name, sha] = line.trim().split(' ')
    if (name && sha) byName.set(name, { ...get(name), local: sha })
  }
  for (const line of remote.stdout.toString().split('\n').filter(Boolean)) {
    const [sha, ref] = line.trim().split('\t')
    if (!sha || !ref) continue
    const name = ref.replace(/^refs\/heads\//, '')
    byName.set(name, { ...get(name), remote: sha })
  }
  const isAncestor = (sha: string | null) =>
    !!sha && Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', sha, baseSha]).exitCode === 0
  return [...byName.entries()].map(([name, t]) => ({
    name,
    local: t.local,
    remote: t.remote,
    localMerged: isAncestor(t.local),
    remoteMerged: isAncestor(t.remote),
  }))
}

/** the origin's configured URL. Unlike `git remote get-url`, a `url.<base>.insteadOf` alias never
 * rewrites this: forge detection reads the rig's own intent, not where traffic ends up. */
function originConfigUrl(repo: string): string | null {
  const p = Bun.spawnSync(['git', '-C', repo, 'config', '--get', 'remote.origin.url'])
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}
/** Get `<owner>/<repo>` from an origin URL. This result controls which repo's PR state
 * `gc --worktrees` reads before it deletes a branch (claude-factory-0u0).
 * - Match the host `github.com` only, never a longer host that merely ends with it.
 * - Accept `https://`, `ssh://`, `git@host:`, and a form with userinfo before the host, the
 *   same forms `parseRemote` (src/prs.ts:99) accepts.
 * - Give null for a path that is not exactly `<owner>/<repo>`. */
export function githubSlug(url: string): string | null {
  const remote = parseRemote(url)
  if (!remote || forgeOf(remote.host) !== 'github') return null
  const parts = remote.path.split('/')
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null
}
/** the GraphQL query `prFacts()` sends. On the first page, `$endCursor` has no value. On every
 * page after, `gh --paginate` sets `$endCursor` from the last page's `pageInfo.endCursor`.
 * `orderBy: CREATED_AT ASC` keeps the page order the same across a run. */
const PR_FACTS_QUERY =
  'query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){' +
  'pullRequests(first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:ASC}){' +
  'totalCount nodes{number state headRefName headRefOid isCrossRepository} pageInfo{hasNextPage endCursor}}}}'

/** `gh api graphql --paginate`, called once per rig, not once per branch. The plan for
 * claude-factory-l38 rejected the per-branch call: it would run about 700 calls on the first
 * pass. This function returns null on a non-GitHub forge, or on any `gh` failure (AC5).
 *
 * `gh pr list --limit 1000` (claude-factory-l38.13) capped a rig's pull requests at 1000. A rig
 * with more PRs than that always read as incomplete (claude-factory-ph8: a rig with over 3000
 * pull requests is a real case). So gc never reclaimed a branch on it. GraphQL's `totalCount`
 * proves a read is complete. `gc.parsePrPages()` checks it against the number of distinct PR
 * numbers read, and returns null, never a partial list, on any mismatch. */
function prFacts(repo: string): gc.PrFact[] | null {
  const url = originConfigUrl(repo)
  const slug = url ? githubSlug(url) : null
  if (!slug) return null
  const [owner, name] = slug.split('/')
  const p = Bun.spawnSync(
    [
      'gh',
      'api',
      'graphql',
      '--paginate',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `query=${PR_FACTS_QUERY}`,
      '--jq',
      '.data.repository.pullRequests | {totalCount, nodes} | tojson',
    ],
    { cwd: repo, timeout: 300_000 },
  )
  if (p.exitCode !== 0) return null
  return gc.parsePrPages(p.stdout.toString())
}

type GcRunRef = gc.RunRef & { repo: string }
/** `bd show` only for a run whose branch has a CLOSED PR (claude-factory-l38's "CLOSED-PR candidates"):
 * a failed or missing read counts as open (AC5), never as closed. */
function beadClosedFacts(repo: string, runs: GcRunRef[], prs: gc.PrFact[] | null): Record<string, boolean> {
  if (!prs) return {}
  // a fork's CLOSED PR is not ours to have merged (claude-factory-ulv): never trust it to close a tip
  const closed = new Set(
    prs.filter(p => p.state === 'CLOSED' && !p.isCrossRepository).map(p => p.headRefName),
  )
  const out: Record<string, boolean> = {}
  for (const r of runs) {
    if (!r.bead || !['done', 'aborted'].includes(r.node)) continue
    const candidate = [...closed].some(
      name => name === `factory/${r.id}` || name.startsWith(`factory/${r.id}-`),
    )
    if (!candidate) continue
    try {
      out[r.bead] = beads(repo, 'factory/gc').show(r.bead)?.status === 'closed'
    } catch {
      out[r.bead] = false
    }
  }
  return out
}

/** every run gc.worktreePlan() can see, across every rig */
function allRunRefs(): GcRunRef[] {
  return runIds().map(id => {
    try {
      const run = loadRun(id)
      const { value, c } = current(id)
      const finishedAt = c.log.at(-1)?.at ?? createdAt(id)
      return { id, node: where(value)[0], finishedAt, worktree: run.worktree, bead: run.bead, repo: run.repo }
    } catch {
      // an unloadable run (a corrupt run.json or state.json) must count as live (claude-factory-l38.10):
      // dropping it let ownerByBranch() give its longer-id fork's branch to a shorter, finished parent
      return { id, node: 'unknown', finishedAt: 0, worktree: '', bead: undefined, repo: '' }
    }
  })
}

/** commits every change in `path` (tracked and untracked, `.gitignore` honored) to a local-only ref
 * at `refs/factory-gc/<runId>`: a dirty-small worktree's work survives its removal (AC6). Returns the sha. */
function snapshotWorktree(path: string, runId: string): string {
  // a private, unpredictably named dir (claude-factory-ulv): `factory-gc-index-<runId>-<pid>` in the
  // shared tmpdir let another user on the same host pre-create the index path, or race the write
  // between `add -A` and `write-tree` below
  const indexDir = mkdtempSync(join(tmpdir(), 'factory-gc-index-'))
  const indexFile = join(indexDir, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  // every step must succeed, or the caller must never force-remove on the strength of this snapshot
  // (claude-factory-l38.8): an ignored failure here silently commits an empty or stale tree instead
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', path, ...args], { env })
    if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr.toString().trim()}`)
    return p.stdout.toString().trim()
  }
  try {
    run('add', '-A')
    const tree = run('write-tree')
    const head = run('rev-parse', 'HEAD')
    const commitP = Bun.spawnSync(
      [
        'git',
        '-C',
        path,
        'commit-tree',
        tree,
        '-p',
        head,
        '-m',
        'factory gc --worktrees: snapshot before removal',
      ],
      { env: { ...env, ...MEMORY_GIT_IDENTITY_FALLBACK } },
    )
    if (commitP.exitCode !== 0) throw new Error(`git commit-tree: ${commitP.stderr.toString().trim()}`)
    const commit = commitP.stdout.toString().trim()
    git(path, 'update-ref', `refs/factory-gc/${runId}`, commit)
    return commit
  } finally {
    rmSafe(indexDir, { recursive: true, force: true })
  }
}

/** `git update-ref -d` locally, `git push --force-with-lease` on the remote: each refuses when the
 * ref moved since the read gc planned from (AC7). Returns what it actually deleted. */
export function deleteBranchCas(repo: string, name: string, local: string | null, remote: string | null) {
  let localOk = false
  let remoteOk = false
  let error: string | undefined
  if (local) {
    const p = Bun.spawnSync(['git', '-C', repo, 'update-ref', '-d', `refs/heads/${name}`, local])
    localOk = p.exitCode === 0
    if (!localOk) error = p.stderr.toString().trim()
  }
  if (remote) {
    const p = Bun.spawnSync(
      [
        'git',
        '-C',
        repo,
        'push',
        `--force-with-lease=refs/heads/${name}:${remote}`,
        'origin',
        `:refs/heads/${name}`,
      ],
      { env: GIT_NETWORK_ENV, timeout: GIT_NETWORK_TIMEOUT_MS },
    )
    remoteOk = p.exitCode === 0
    if (!remoteOk) error = (error ? `${error}; ` : '') + p.stderr.toString().trim()
  }
  return { localOk, remoteOk, error }
}

const gcWorktreesJournal = () => join(HOME, 'gc-worktrees.jsonl')
/** Scrubs URL userinfo from every string value of `value` (claude-factory-0lt, AC2). It walks an
 * array or an object the same way, so a new field or a nested value can never skip the scrub. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return gc.scrubUrlUserinfo(value)
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]))
  return value
}
const gcLog = (entry: Record<string, unknown>) =>
  durable(
    gcWorktreesJournal(),
    JSON.stringify(scrubDeep({ at: new Date().toISOString(), ...entry })) + '\n',
    'a',
  )

/**
 * Removes a finished run's worktree. It also removes the run's factory/* branch, once
 * gc.worktreePlan() finds every tip covered. `--dry-run` only prints what this pass would do: it
 * runs no git, gh or bd write (AC1). `rigName`, when set, limits the pass to one rig.
 */
function gcWorktreesPass(dryRun: boolean, rigName?: string) {
  const now = Date.now()
  const allRigs = rigs()
  // an unknown --rig must fail, not silently run on zero rigs and print "reclaimed: 0" (claude-factory-l38.16)
  if (rigName && !allRigs.some(r => r.name === rigName))
    fail(
      `factory gc --worktrees --rig ${rigName}: no such rig. Known rigs: ${allRigs.map(r => r.name).join(', ') || '(none)'}`,
    )
  const targetRigs = allRigs.filter(r => !rigName || r.name === rigName)
  const runs = allRunRefs()
  const panes = strictPaneCwds()
  const facts: gc.RigWorktreeFacts[] = targetRigs.map(rig => {
    const worktrees = worktreeFacts(rig.repo)
    const branches = branchFacts(rig.repo, dryRun)
    const prs = prFacts(rig.repo)
    const repoRuns = runs.filter(r => r.repo === rig.repo)
    const beadClosed = beadClosedFacts(rig.repo, repoRuns, prs)
    return { name: rig.name, worktrees, branches, prs, beadClosed }
  })
  const plans = gc.worktreePlan(facts, runs, panes, now)
  const byRigRepo = new Map(targetRigs.map(r => [r.name, r.repo]))
  let worktreesN = 0
  let localN = 0
  let remoteN = 0
  let bytesN = 0
  let errors = 0
  for (const p of plans) {
    for (const w of p.removeWorktrees)
      console.log(
        `remove worktree ${w.path} (run ${w.runId}${w.snapshot ? ', dirty: snapshot first' : ''}, ${fmtBytes(w.bytes)})`,
      )
    for (const b of p.removeBranches)
      console.log(
        `remove branch ${b.name} (run ${b.runId}, local ${b.local?.slice(0, 8) ?? '-'}, remote ${b.remote?.slice(0, 8) ?? '-'})`,
      )
    for (const k of p.keep)
      console.log(`keep ${k.kind} ${k.name} (run ${k.runId ?? 'unowned'}, reason: ${k.reason})`)
    console.log(`${p.rig}: owned ${p.owned}, live ${p.live}, unowned ${p.unowned}`)
    if (dryRun) continue
    const repo = byRigRepo.get(p.rig)!
    // a worktree whose `git worktree remove` fails keeps its branch too (claude-factory-l38.6):
    // `update-ref -d` does not check whether a worktree still has the branch checked out
    const failedWorktrees = new Set<string>()
    for (const w of p.removeWorktrees) {
      try {
        rmSync(join(w.path, '.beads.gate.lock'), { force: true })
        let snapshot: string | undefined
        if (w.snapshot) {
          snapshot = snapshotWorktree(w.path, w.runId)
          gcLog({
            type: 'snapshot',
            rig: p.rig,
            run: w.runId,
            ref: `refs/factory-gc/${w.runId}`,
            sha: snapshot,
          })
        }
        const rm = Bun.spawnSync([
          'git',
          '-C',
          repo,
          'worktree',
          'remove',
          ...(w.snapshot ? ['--force'] : []),
          w.path,
        ])
        if (rm.exitCode !== 0) throw new Error(`git worktree remove: ${rm.stderr.toString().trim()}`)
        gcLog({ type: 'worktree', rig: p.rig, run: w.runId, path: w.path, bytes: w.bytes })
        worktreesN++
        bytesN += w.bytes
        const file = join(runDir(w.runId), 'gc.json')
        const prior = existsSync(file) ? readJson<Record<string, unknown>>(file) : {}
        writeJson(file, { ...prior, worktree: { path: w.path, bytes: w.bytes, snapshot }, at: now })
      } catch (err) {
        errors++
        failedWorktrees.add(w.runId)
        gcLog({ type: 'error', rig: p.rig, run: w.runId, path: w.path, reason: (err as Error).message })
      }
    }
    for (const b of p.removeBranches) {
      if (failedWorktrees.has(b.runId)) {
        gcLog({ type: 'skip-branch', rig: p.rig, run: b.runId, ref: `refs/heads/${b.name}` })
        continue
      }
      const { localOk, remoteOk, error } = deleteBranchCas(repo, b.name, b.local, b.remote)
      if (b.local && localOk) {
        gcLog({ type: 'branch', rig: p.rig, run: b.runId, ref: `refs/heads/${b.name}`, sha: b.local })
        localN++
      }
      if (b.remote && remoteOk) {
        gcLog({ type: 'remote', rig: p.rig, run: b.runId, ref: `refs/heads/${b.name}`, sha: b.remote })
        remoteN++
      }
      if (error) {
        errors++
        gcLog({ type: 'error', rig: p.rig, run: b.runId, ref: b.name, reason: error })
      }
    }
  }
  // dry-run writes nothing at all: the worktree list, refs, ls-remote and HOME stay byte-identical (AC1)
  if (!dryRun)
    gcLog({
      type: 'pass',
      errors,
      rigs: plans.map(p => ({ rig: p.rig, owned: p.owned, live: p.live, unowned: p.unowned })),
    })
  // the report line must show the error count too (claude-factory-l38.17): the journal has it, but
  // exit code stays 0 either way, so a reader of only this line must see a failed removal.
  console.log(
    `reclaimed: ${worktreesN} worktrees, ${localN} local + ${remoteN} remote branches, ${fmtBytes(bytesN)}, ${errors} errors`,
  )
}

const GC_WORKTREES_MS = Number(process.env.FACTORY_GC_WORKTREES_MS) || 86_400_000
/**
 * A worktree gc pass runs at most once a day (FACTORY_GC_WORKTREES_MS). Set FACTORY_GC_WORKTREES=0
 * to turn this off: tick then spawns no pass. Its lock is gc-worktrees.lock, separate from gc.lock.
 *
 * The first tick with no gc-worktrees.stamp file only writes the stamp. It starts the daily window.
 * It spawns no pass. This way a fresh FACTORY_HOME never deletes a worktree or a branch on its own
 * first tick.
 */
const kickGcWorktrees = () => {
  if (process.env.FACTORY_GC_WORKTREES === '0') return
  const stamp = join(HOME, 'gc-worktrees.stamp')
  if (!existsSync(stamp)) return void writeFileSync(stamp, '') // seed only: the window starts now
  const age = Date.now() - statSync(stamp).mtimeMs
  if (isHeld('gc-worktrees.lock') || age < GC_WORKTREES_MS) return
  spawnChild(CLI, ['gc', '--worktrees'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

const SWEEP_MS = Number(process.env.FACTORY_SWEEP_MS) || 300_000
/**
 * A sweep pass (`factory sweep`) runs at most every FACTORY_SWEEP_MS (default 5 min). Set
 * FACTORY_SWEEPS=0 to turn this off: tick then spawns no pass. Its lock is sweeps.lock.
 *
 * The first tick with no sweeps.stamp file only writes the stamp. It starts the window and spawns
 * no pass. This way a fresh FACTORY_HOME starts no run on its own first tick. `dueSweeps` (per rig,
 * per sweep) still gates which stations a spawned pass starts.
 */
const kickSweeps = () => {
  if (halted() || process.env.FACTORY_SWEEPS === '0') return
  const stamp = join(HOME, 'sweeps.stamp')
  if (!existsSync(stamp)) return void writeFileSync(stamp, '') // seed only: the window starts now
  const age = Date.now() - statSync(stamp).mtimeMs
  if (isHeld('sweeps.lock') || age < SWEEP_MS) return
  spawnChild(CLI, ['sweep'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FACTORY_HOME: HOME },
  }).unref()
}

async function tick(isPatrol = false) {
  const release = hold('tick.lock')
  if (!release) return { busy: true }
  try {
    const now = Date.now()
    const linearState = existsSync(linearSyncFile())
      ? readJson<Record<string, LinearSyncState>>(linearSyncFile())
      : {}
    const out = {
      runs: [] as Row[],
      manager: [] as (Mail & { run: string })[],
      // the manager's patrol works toward their goals; each opted-in rig carries its last Linear pull
      rigs: rigs().map(r => (linearState[r.name] ? { ...r, linearSync: linearState[r.name] } : r)),
      // each pending skill and proposal with no verdict yet, for the mod's reviewer (claude-factory-ag2)
      reviews: memory.pendingReviews(MEMORY, readReviews()).map(({ text: _text, ...r }) => r),
      // the pending ones that have one: the patrol shows each verdict until the manager acts
      reviewed: reviewedItems(),
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
    out.manager.push(...proposalMail(now))
    out.manager.push(...linearMail(now))
    out.manager.push(...selfUpdateMail(now))
    out.manager.push(...managerStaleMail(now))
    out.manager.push(...tokenDigestMail(now))
    // skip rows are for people reading dispatch.json; the board, sidebar and reap() see only the rest
    out.runs.push(...(existsSync(dispatchFile()) ? readJson<Row[]>(dispatchFile()).filter(r => !r.skip) : []))
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
      if (!halted()) kickWatch()
      if (!halted()) kickSync()
      kickDevenv()
      kickConfigSync()
      kickSelfUpdate()
      kickGc()
      kickGcWorktrees()
      kickSweeps()
    }
  }
}

const sweepStateFile = () => join(HOME, 'sweeps.json')
const sweepLogFile = () => join(HOME, 'sweeps.jsonl')
const sweepState = (): SweepState => (existsSync(sweepStateFile()) ? readJson(sweepStateFile()) : {})
type SweepLogEntry = {
  at: number
  rig: string
  sweep: string
  action:
    | 'started'
    | 'no-room'
    | 'unchanged'
    | 'error'
    | 'no-beads'
    | 'hygiene'
    | 'off'
    | 'green'
    | 'tracked'
    | 'quiet'
  run?: string
  proposed?: number
  kinds?: Record<string, number>
  digest?: string
  ghError?: string
}
const logSweep = (e: SweepLogEntry) => appendFileSync(sweepLogFile(), JSON.stringify(e) + '\n')

/**
 * claude-factory-8bg: one hygiene pass for a rig (src/hygiene.ts). With `write` false it only reads
 * and returns what it would propose. It never closes, defers or reopens a bead. A bead gets the
 * `hygiene_proposed` stamp first, so a crash between writes cannot propose it twice.
 */
async function hygienePass(rig: Pick<Rig, 'name' | 'repo'>, write: boolean, gh: Gh = spawnGh) {
  const b = beads(rig.repo, 'factory/hygiene')
  const now = Date.now()
  let prs: MergedPr[] = []
  let ghError: string | undefined
  if (originRef(rig.repo)?.forge !== 'github') ghError = 'not a GitHub repo: shipped kind skipped'
  else {
    try {
      const ref = rigRef(rig.repo)
      const out = ref ? await githubMergedJson(gh, ref.slug, rig.repo, { pages: 5 }) : null
      if (out === null) throw new Error('gh api pulls failed')
      prs = parseMergedPrs(out)
    } catch {
      ghError = 'gh failed: shipped kind skipped' // never the raw gh text
    }
  }
  const runBranches = (id: string) =>
    runIds()
      .filter(r => {
        try {
          return loadRun(r).bead === id
        } catch {
          return false
        }
      })
      .map(r => `factory/${r}`)
  const findings = findHygiene(
    b.every(),
    prs,
    now,
    id => {
      try {
        return b.comments(id).some(c => now - Date.parse(c.created_at) < RECENT_COMMENT_MS)
      } catch {
        return true // unreadable comments: leave the bead alone this pass
      }
    },
    undefined,
    runBranches,
  )
  const out: { findings: typeof findings; proposed: typeof findings; ghError?: string; digest?: string } = {
    findings,
    proposed: [],
    ghError,
  }
  if (!write) return out
  const day = new Date(now).toISOString().slice(0, 10)
  for (const f of findings) {
    try {
      b.setMetadata(f.id, { hygiene_proposed: `${f.kind}@${new Date(now).toISOString()}` })
      b.relabel(f.id, { add: [STALE_LABEL] })
      b.comment(f.id, proposalComment(f))
      out.proposed.push(f)
    } catch (err) {
      console.error(`${new Date().toISOString()} hygiene ${rig.name} ${f.id}: ${(err as Error).message}`)
    }
  }
  if (out.proposed.length) {
    try {
      const id = b.createUnlabeled(
        `hygiene digest ${day}: ${out.proposed.length} proposed closes`,
        digestLines(out.proposed),
        { hygiene_digest: day },
        '-t',
        'task',
        '-p',
        '3',
      )
      out.digest = id
    } catch (err) {
      console.error(`${new Date().toISOString()} hygiene ${rig.name} digest: ${(err as Error).message}`)
    }
  }
  return out
}

/** Runs a rig's `--slo` command (claude-factory-8pc.6): the monitor sweep's read, on the laptop, not
 * on a worker. It is a shell command (`sh -c`), since a person writes it in rigs.json and it may
 * pipe kubectl, Mimir or Loki calls together. It combines stdout and stderr: a command that starts
 * failing is itself a change worth a pass. A 30s timeout keeps a hung read from jamming `factory
 * sweep`. */
function readSlo(rig: Rig): string {
  const p = Bun.spawnSync(['sh', '-c', rig.slo!], { cwd: rig.repo, timeout: 30_000 })
  return (p.stdout.toString() + p.stderr.toString()).trim()
}

/** the rig's default branch: origin/HEAD without `origin/`, else main */
function defaultBranch(repo: string): string {
  const p = Bun.spawnSync(['git', '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const b =
    p.exitCode === 0
      ? p.stdout
          .toString()
          .trim()
          .replace(/^origin\//, '')
      : ''
  return /^[\w][\w./-]*$/.test(b) ? b : 'main'
}

/**
 * The files that conflict when origin's `branch` merges into origin's `base`, in git order.
 * It gives [] when the merge is clean and on every error (fetch, missing branch, old git).
 * An error must never stop a worker, so the check fails open.
 */
export function conflictsOf(repo: string, base: string, branch: string): string[] {
  const ref = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`
  const fetch = Bun.spawnSync(['git', '-C', repo, 'fetch', '-q', 'origin', ref(base), ref(branch)], {
    env: GIT_NETWORK_ENV,
    timeout: GIT_NETWORK_TIMEOUT_MS,
  })
  if (fetch.exitCode !== 0) return []
  const p = Bun.spawnSync([
    'git',
    '-C',
    repo,
    'merge-tree',
    '--write-tree',
    '--name-only',
    `origin/${base}`,
    `origin/${branch}`,
  ])
  if (p.exitCode !== 1) return []
  const lines = p.stdout.toString().split('\n').slice(1)
  const end = lines.indexOf('')
  return [...new Set(end < 0 ? lines : lines.slice(0, end))]
}

/** one read-only `gh` call on the laptop (claude-factory-q08): a non-zero exit or a timeout throws */
function ghRead(repo: string, args: string[], timeout = 30_000): string {
  const p = Bun.spawnSync(['gh', ...args], { cwd: repo, timeout, maxBuffer: 8_000_000 })
  if (p.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${p.exitCode ?? 'timeout'}`)
  return p.stdout.toString()
}

const GH_RUN_FIELDS =
  'workflowDatabaseId,workflowName,headSha,conclusion,status,databaseId,createdAt,url,event,attempt'
const ghRuns = (repo: string, extra: string[]): GhRun[] => {
  const runs = JSON.parse(ghRead(repo, ['run', 'list', ...extra, '--json', GH_RUN_FIELDS]))
  if (!Array.isArray(runs)) throw new Error('gh run list: not a list')
  return runs
}

/** the labels of every open bead in `repo`, for the ci-red and flake dedupe; a bd failure throws */
const openLabels = (repo: string): Set<string> =>
  new Set(
    beads(repo, 'factory')
      .every()
      .filter(b => b.status !== 'closed')
      .flatMap(b => b.labels ?? []),
  )

/** printable ASCII only, so a workflow name or URL cannot carry a control or bidi character into a mail */
const plain = (s: string, max = 200) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, max)

/**
 * The deterministic read of the `ci` and `flakes` sweeps (claude-factory-q08). No model runs here.
 * `start` means a run is worth its tokens, and `mail` is its inbox text: keys, ids and URLs only,
 * never raw log text. Any gh or bd failure throws, so no run starts (the caller logs `error`).
 */
function ciSweepRead(
  rig: Rig,
  station: 'ci' | 'flakes',
  now: number,
): { action: 'green' | 'tracked' | 'quiet' | 'start'; mail?: string } {
  const branch = defaultBranch(rig.repo)
  if (station === 'ci') {
    const reds = mainCiReds(ghRuns(rig.repo, ['--branch', branch, '--limit', '100']))
    if (!reds.length) return { action: 'green' }
    const fresh = newCiReds(reds, openLabels(rig.repo))
    if (!fresh.length) return { action: 'tracked' }
    return {
      action: 'start',
      mail: clipUtf8(
        fresh
          .map(
            r =>
              `key: ${r.key} | workflow: ${plain(r.workflow, 80)} | first failing sha: ${r.sha.slice(0, 40)} | newest run: ${plain(r.url)}`,
          )
          .join('\n'),
      ),
    }
  }
  const since = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)
  const flaky = flakyRuns(
    ghRuns(rig.repo, ['--branch', branch, '--created', `>=${since}`, '--limit', '1000']),
  ).slice(0, 10)
  if (!flaky.length) return { action: 'quiet' }
  const labels = openLabels(rig.repo)
  const logs = flaky.flatMap(r => {
    try {
      const out = ghRead(rig.repo, [
        'run',
        'view',
        String(r.id),
        '--log-failed',
        ...(r.attempt ? ['--attempt', String(r.attempt)] : []),
      ])
      return [{ url: plain(r.url), tests: failedTests(out) }]
    } catch {
      return [] // a log that expired or timed out only costs this run's evidence
    }
  })
  const found = flakeCandidates(logs, labels)
  if (!found.length) return { action: 'quiet' }
  return {
    action: 'start',
    mail: clipUtf8(
      found
        .map(
          c =>
            `test: ${c.id} | key: ${c.key} | n: ${c.n} | queue: ${c.queue} | runs: ${c.urls.slice(0, 3).join(' ')}`,
        )
        .join('\n'),
    ),
  }
}

/**
 * one run per due (rig, sweep) pass (src/sweeps.ts's `dueSweeps`), under factory "sweeps" (or a
 * rig's own `sweepsFactory`), parked at that station by GOTO when it is not the factory's start.
 * `factory tick`'s `kickSweeps` calls this, detached, under its own cadence; `factory sweep` calls it
 * by hand. Every attempt, started or not, gets one line in sweeps.jsonl.
 */
async function sweep() {
  if (halted()) return
  const live = runIds().flatMap(id => {
    try {
      const { run, value } = current(id)
      return ['done', 'aborted'].includes(where(value)[0]) ? [] : [{ repo: run.repo, goal: run.goal }]
    } catch {
      return [] // the run ended between runIds() and here: treat it as gone, not live
    }
  })
  let state = sweepState()
  for (const rig of rigs()) {
    let preview: Factory
    const spec = rig.sweepsFactory ?? 'sweeps'
    try {
      preview = await loadFactory(factorySource(spec, rig.repo))
    } catch (err) {
      console.error(`${new Date().toISOString()} sweeps for rig ${rig.name}: ${(err as Error).message}`)
      continue
    }
    // claude-factory-8pc.14: a sweep run's id starts with its factory's own `name` field
    // (createTracked), not `spec`. src/sweeps.ts's `sweepFiler` only matches a run id that starts
    // with `sweeps-`: a `rig.sweepsFactory`, or a repo's own `.factory/sweeps.ts`, with a `name`
    // other than 'sweeps' would file beads the flood guard never sees. Refuse it, unguarded.
    if (preview.name !== 'sweeps') {
      console.error(
        `${new Date().toISOString()} sweeps for rig ${rig.name}: ${spec}'s factory name is ` +
          `'${preview.name}', not 'sweeps': the flood guard only matches sweep runs filed under 'sweeps'`,
      )
      continue
    }
    // claude-factory-8pc.19: a rig with no .beads has no bd for the flood guard to read at all
    // (tracking() tells a worker on such a rig to `factory start` work with no bead, and no
    // guard). Today every rig in rigs.json has .beads, so this is latent, not live. Skip it, one
    // log line per due station, instead of starting a sweep run the guard can never see.
    const due = dueSweeps(preview, rig, state, live, Date.now())
    if (due.length && !hasBeads(rig.repo)) {
      for (const station of due)
        logSweep({ at: Date.now(), rig: rig.name, sweep: station, action: 'no-beads' })
      console.error(
        `${new Date().toISOString()} sweeps for rig ${rig.name}: no .beads directory: the flood guard needs bd`,
      )
      continue
    }
    for (const station of due) {
      const at = Date.now()
      // claude-factory-8bg: hygiene is code, not a run. lastAt lands first, so a crash cannot double a pass.
      if (station === 'hygiene') {
        state = { ...state, [rig.name]: { ...state[rig.name], [station]: { lastAt: at } } }
        writeJson(sweepStateFile(), state)
        if (process.env.FACTORY_HYGIENE === '0') {
          logSweep({ at, rig: rig.name, sweep: station, action: 'off' })
          continue
        }
        try {
          const r = await hygienePass(rig, true)
          const kinds: Record<string, number> = {}
          for (const f of r.proposed) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1
          logSweep({
            at,
            rig: rig.name,
            sweep: station,
            action: 'hygiene',
            proposed: r.proposed.length,
            kinds,
            digest: r.digest,
            ghError: r.ghError,
          })
        } catch (err) {
          logSweep({ at, rig: rig.name, sweep: station, action: 'error' })
          console.error(`${new Date().toISOString()} hygiene for rig ${rig.name}: ${(err as Error).message}`)
        }
        continue
      }
      const goal = sweepGoal(station)
      // monitor reads before it ever asks for a slot: unchanged needs no run, so it must cost no
      // room, and a changed read still needs its mail even when no room is free yet (it waits)
      let mail: string | undefined
      let read: { sig: string; lines: number } | undefined
      if (station === 'ci' || station === 'flakes') {
        // Check room first. A full factory writes no lastAt, so a late check repeats the gh reads each tick.
        try {
          await assertRoom(rig.repo)
        } catch {
          logSweep({ at, rig: rig.name, sweep: station, action: 'no-room' })
          continue
        }
        let ci: { action: 'green' | 'tracked' | 'quiet' | 'start'; mail?: string }
        try {
          ci = ciSweepRead(rig, station, at)
        } catch (err) {
          state = { ...state, [rig.name]: { ...state[rig.name], [station]: { lastAt: at } } }
          writeJson(sweepStateFile(), state)
          logSweep({ at, rig: rig.name, sweep: station, action: 'error' })
          console.error(
            `${new Date().toISOString()} sweep ${station} for rig ${rig.name}: ${(err as Error).message}`,
          )
          continue
        }
        if (ci.action !== 'start') {
          state = { ...state, [rig.name]: { ...state[rig.name], [station]: { lastAt: at } } }
          writeJson(sweepStateFile(), state)
          logSweep({ at, rig: rig.name, sweep: station, action: ci.action })
          continue
        }
        mail = ci.mail
      }
      if (station === 'monitor') {
        let output: string
        try {
          output = readSlo(rig)
        } catch (err) {
          logSweep({ at, rig: rig.name, sweep: station, action: 'error' })
          console.error(
            `${new Date().toISOString()} sweep monitor for rig ${rig.name}: ${(err as Error).message}`,
          )
          continue
        }
        read = { sig: sigOf(output), lines: output ? output.split('\n').length : 0 }
        if (read.sig === state[rig.name]?.[station]?.sig) {
          state = { ...state, [rig.name]: { ...state[rig.name], [station]: { lastAt: at, ...read } } }
          writeJson(sweepStateFile(), state)
          logSweep({ at, rig: rig.name, sweep: station, action: 'unchanged' })
          continue
        }
        mail = clipUtf8(output)
      }
      try {
        await assertRoom(rig.repo)
      } catch {
        logSweep({ at, rig: rig.name, sweep: station, action: 'no-room' })
        continue
      }
      try {
        const linked = beadFor(rig.repo, goal)
        const { run, def } = await createTracked(spec, preview.name, rig.repo, goal, linked.bead)
        if (station !== def.start) post(run.id, { type: 'GOTO', node: station })
        if (mail !== undefined) post(run.id, { type: 'MAIL', from: 'sweep', to: station, text: mail })
        state = { ...state, [rig.name]: { ...state[rig.name], [station]: { lastAt: at, ...read } } }
        writeJson(sweepStateFile(), state)
        logSweep({ at, rig: rig.name, sweep: station, action: 'started', run: run.id })
        console.log(`${new Date(at).toISOString()} sweep ${station} for rig ${rig.name} → ${run.id}`)
      } catch (err) {
        logSweep({ at, rig: rig.name, sweep: station, action: 'error' })
        console.error(
          `${new Date().toISOString()} sweep ${station} for rig ${rig.name}: ${(err as Error).message}`,
        )
      }
    }
  }
}

const LINEAR_MS = 20 * 60_000 // how often an opted-in rig's Linear issues are pulled
// how far behind `lastGoodAt` the incremental cutoff looks (claude-factory-b6c.26): this process's
// clock and Linear's own clock can drift; a buffer this wide stops the cutoff from skipping an issue
// Linear marks as updated shortly before the last good pull.
const LINEAR_SKEW_MS = 5 * 60_000
// Caches only the secret broker's vault and item ids, for this process's life. It never caches the
// Linear API key itself.
const linearConnectCache: ConnectCache = {}
/** a rig's Linear pull is due: never tried, forced, or LINEAR_MS since the last attempt (whether it erred) */
const linearDue = (state: LinearSyncState | undefined, force: boolean) =>
  force || !state || Date.now() - state.at >= LINEAR_MS

/** beads with a Linear external ref that carry the factory label right now, in `repo` */
function linearLabeled(repo: string): { id: string }[] {
  const p = Bun.spawnSync(
    [
      'bd',
      'list',
      '--all',
      '--brief',
      '--label',
      'factory',
      '--external-contains',
      'linear.app',
      '--json',
      '-n',
      '0',
    ],
    { cwd: repo, env: bdEnv(repo), timeout: 60_000 },
  )
  if (p.exitCode !== 0) throw new Error(`bd list: ${p.stderr.toString().trim().split('\n')[0] || 'failed'}`)
  const out = p.stdout.toString().trim()
  return out === 'null' || !out ? [] : JSON.parse(out)
}

/**
 * This function calls `linearLabeled` once more when the first call throws.
 * A transient error (a busy Dolt server) must not, by itself, cost a confirmed listing (security#1.13).
 * The second call's error, if any, reaches the caller as is.
 */
function linearLabeledRetrying(repo: string): { id: string }[] {
  try {
    return linearLabeled(repo)
  } catch {
    return linearLabeled(repo)
  }
}

/**
 * This function removes the `factory` label from each id in `ids`, in `repo`.
 * It checks the exit code of each `bd label remove` call.
 * When a call does not exit 0, the function does not count that id as stripped.
 * It puts that id in `unstripped` instead, so the next pass tries it again first (claude-factory-b6c.9).
 */
function stripFactoryLabel(repo: string, ids: string[]): { stripped: number; unstripped: string[] } {
  let stripped = 0
  const unstripped: string[] = []
  for (const id of ids) {
    const p = Bun.spawnSync(['bd', 'label', 'remove', id, 'factory'], {
      cwd: repo,
      env: bdEnv(repo),
      timeout: 30_000,
    })
    if (p.exitCode === 0) stripped++
    else unstripped.push(id)
  }
  return { stripped, unstripped }
}

/**
 * This function makes one rig's Linear pull.
 * First, it lists the rig's team(s) with a read-only Linear API call (`fetchLinearIssues`).
 * Then it routes each issue to at most one opted-in rig (`routeLinearIssue`).
 * Then it asks `bd` to pull only this rig's routed issues (`bd linear pull <ref...>`, never `--push`).
 * `bd` has no project or label filter of its own (claude-factory-b6c.18). This function filters instead,
 * before it calls `bd`.
 * An issue with no matching rig counts toward `unrouted`. The loop never pulls it anywhere.
 * It fetches the key from the secret broker, and passes the key and the rig's team ids to `bd` by
 * env only (claude-factory-b6c.20).
 *
 * Among this rig's routed issues, it sends `bd` only the ones Linear's own `updatedAt` marks as
 * changed. The cutoff is `LINEAR_SKEW_MS` before this rig's last good pull (claude-factory-b6c.24).
 * `force`, or the rig's first pass, skip the cutoff and send every routed issue.
 *
 * `LINEAR_SKEW_MS` covers clock drift between this process and Linear's own clock. Without this
 * buffer, the cutoff can skip an issue for good when Linear marks it as updated shortly before the
 * last good pull (claude-factory-b6c.26).
 *
 * `unrouted` counts every unmatched issue of the full listing. The time cutoff does not affect it.
 *
 * `bd` copies each Linear label to the bead that it maps. A new bead, or an updated bead, can have the
 * `factory` label as soon as the pull writes it. This function removes that label again. A person, not a
 * Linear label, must decide what the factory works on. A bead that already had the label before this pull
 * keeps it.
 *
 * This function removes the label after every pull that reaches `bd`. It also removes the label after
 * a pull that then errors or times out (claude-factory-b6c.8), because the pull can label beads before
 * it fails. When `bd label remove` fails on an id, this function puts that id in `unstripped`. The next
 * pass tries that id again first (claude-factory-b6c.9).
 *
 * The listing call right after the pull can also fail. This function retries that call once
 * (`linearLabeledRetrying`). When the retry also fails, the function cannot tell which ids the pull
 * labeled, so it must not guess. It keeps this pass's pre-pull snapshot as `baseline` in the state,
 * not a fresh one. The next pass's diff still starts from before this pull. So the next pass still
 * catches the ids this pull labeled, once a listing call succeeds (security#1.13).
 *
 * This function also uses a `baseline` from an earlier pass as this pass's pre-pull snapshot. It clears
 * that `baseline` once a listing call succeeds. It skips the listing call entirely when there is
 * nothing to check: no issue routed to this rig, no `unstripped` retry, and no open `baseline`.
 *
 * This function writes `state[rig.name]`. It never throws, so one rig's failure does not stop the others.
 */
async function linearSyncOne(rig: Rig, state: Record<string, LinearSyncState>, force: boolean) {
  const at = Date.now()
  const prior = state[rig.name]
  const retry = prior?.unstripped ?? []
  const baseline = prior?.baseline
  // the time cutoff below only skips re-sending an unchanged issue to `bd`. It never narrows the
  // unrouted count or the label-strip check (claude-factory-b6c.24).
  // `--force`, and a rig's first pass (no prior good pull), skip the cutoff and read every routed
  // issue.
  // `LINEAR_SKEW_MS` moves the cutoff back from `lastGoodAt`. This covers clock drift between this
  // process and Linear's own clock, so the cutoff does not skip an issue for good (claude-factory-b6c.26).
  // A changed routing config (team, projects, labels) also skips the cutoff: issues that now route
  // here may be older than the cutoff (claude-factory-dvg).
  const routing = JSON.stringify([rig.linear!.team, rig.linear!.projects ?? [], rig.linear!.labels ?? []])
  const since =
    force || !prior?.lastGoodAt || prior.routing !== routing ? undefined : prior.lastGoodAt - LINEAR_SKEW_MS
  let secrets: string[] = []
  try {
    const apiKey = await linearAuth(secrets, process.env, linearConnectCache)
    const { issues, truncated } = await fetchLinearIssues(apiKey, rig.linear!.team)
    const allRigs = rigs()
    let unrouted = 0
    const mine: string[] = []
    for (const issue of issues) {
      const dest = routeLinearIssue(issue, allRigs)
      if (dest === rig.name) {
        if (!since || Date.parse(issue.updatedAt) > since) mine.push(issue.ref)
      } else if (dest === undefined) unrouted++
    }
    const env = bdEnv(rig.repo, syncEnv(apiKey, rig.linear!.team))
    const needsCheck = mine.length > 0 || retry.length > 0 || !!baseline
    const beforeIds = baseline ?? (needsCheck ? linearLabeled(rig.repo).map(b => b.id) : [])
    const before = new Set(beforeIds)
    let outcome: SyncOutcome
    if (mine.length) {
      const p = Bun.spawnSync(['bd', ...pullArgs(mine)], { cwd: rig.repo, env, timeout: 120_000 })
      outcome = parseSync(p.stdout.toString(), p.exitCode ?? 1, p.stderr.toString())
    } else {
      outcome = { pulled: 0, created: 0, updated: 0 }
    }

    // a listing failure here must not lose the pull's own outcome below: it is caught on its own, and
    // every id the listing could not confirm stays queued (as `retry`) for the next pass. `nextBaseline`
    // carries the open baseline forward by default (nothing routed here means nothing new to learn).
    let toStrip = retry
    let listErr: string | undefined
    let nextBaseline = baseline
    if (needsCheck) {
      try {
        const newly = linearLabeledRetrying(rig.repo)
          .filter(x => !before.has(x.id))
          .map(x => x.id)
        toStrip = [...new Set([...retry, ...newly])]
        nextBaseline = undefined // the diff resolved: nothing left to carry
      } catch (err) {
        listErr = redact((err as Error).message, secrets)
        nextBaseline = beforeIds // still unresolved: keep this pass's before-set for the next pass
      }
    }
    const strip = toStrip.length ? stripFactoryLabel(rig.repo, toStrip) : { stripped: 0, unstripped: [] }

    if ('error' in outcome) {
      state[rig.name] = {
        at,
        unrouted,
        error: redact(outcome.error, secrets),
        ...(strip.unstripped.length && { unstripped: strip.unstripped }),
        ...(nextBaseline && { baseline: nextBaseline }),
        ...(prior?.lastGoodAt && { lastGoodAt: prior.lastGoodAt }), // a failed pull must not move this
        ...(prior?.routing && { routing: prior.routing }), // keep the old one: the next pass still drops the cutoff
        ...(truncated && { truncated }),
      }
      return
    }
    state[rig.name] = {
      at,
      unrouted,
      pulled: outcome.pulled,
      created: outcome.created,
      updated: outcome.updated,
      stripped: strip.stripped,
      lastGoodAt: at,
      routing,
      ...(strip.unstripped.length && { unstripped: strip.unstripped }),
      ...(nextBaseline && { baseline: nextBaseline }),
      ...(listErr && { error: redact(`label list after the pull: ${listErr}`, secrets) }),
      ...(truncated && { truncated }),
    }
  } catch (err) {
    state[rig.name] = {
      at,
      error: clip(redact((err as Error).message, secrets), 200),
      ...(retry.length && { unstripped: retry }),
      ...(baseline && { baseline }), // nothing resolved this attempt: carry the open baseline forward
      ...(prior?.lastGoodAt && { lastGoodAt: prior.lastGoodAt }), // a failed attempt must not move this
      ...(prior?.routing && { routing: prior.routing }),
    }
  }
}

/** true when a rig has an unconfirmed strip: a named `unstripped` id, or an open `baseline` diff */
const linearRecovering = (state: LinearSyncState | undefined) =>
  !!(state?.unstripped?.length || state?.baseline)

/**
 * This function retries a rig's open Linear recovery (claude-factory-b6c.16): `unstripped` ids a prior
 * strip could not remove, or an open `baseline` diff a prior listing could not resolve. It runs no `bd
 * linear sync` call: dispatch (below) holds back this rig while recovery stays open, so a new pull would
 * not help, and it would reset the normal 20-minute pull timer for no reason.
 *
 * When `baseline` is set: it lists labeled beads once more (`linearLabeledRetrying`), diffs the list
 * against `baseline`, and strips each new id this finds, plus each `unstripped` id. A listing failure
 * keeps `baseline` open for the next pass, the same way `linearSyncOne` does.
 * When only `unstripped` is set: it retries only those ids, with no listing call.
 */
function linearRecoverOne(rig: Rig, state: Record<string, LinearSyncState>) {
  const prior = state[rig.name]!
  const retry = prior.unstripped ?? []
  const baseline = prior.baseline
  let toStrip = retry
  let nextBaseline = baseline
  let listErr: string | undefined
  if (baseline) {
    try {
      const before = new Set(baseline)
      const newly = linearLabeledRetrying(rig.repo)
        .filter(x => !before.has(x.id))
        .map(x => x.id)
      toStrip = [...new Set([...retry, ...newly])]
      nextBaseline = undefined
    } catch (err) {
      listErr = redact((err as Error).message, [])
    }
  }
  const strip = toStrip.length ? stripFactoryLabel(rig.repo, toStrip) : { stripped: 0, unstripped: [] }
  state[rig.name] = {
    ...prior,
    stripped: (prior.stripped ?? 0) + strip.stripped,
    ...(strip.unstripped.length ? { unstripped: strip.unstripped } : { unstripped: undefined }),
    ...(nextBaseline ? { baseline: nextBaseline } : { baseline: undefined }),
    ...(listErr
      ? { error: redact(`label list after the pull: ${listErr}`, []) }
      : nextBaseline || strip.unstripped.length
        ? {}
        : { error: undefined }),
  }
}

/**
 * pulls each opted-in rig's Linear issues into its beads, at most every 20 minutes a rig
 * (`factory linear <rig> --force` sooner). Pull only, from `beadsPass`, after the claim and track loops
 * and before dispatch: a slow pull there is safe, since every run's heartbeat already ran that pass, and
 * nothing else changes labels between the pull and the strip above (claude-factory-b6c design).
 *
 * A rig with an unresolved strip (`linearRecovering`) retries that strip on every call here, not every
 * 20 minutes. Dispatch (below) blocks that rig until the retry resolves it. So the retry must not wait
 * on the pull timer (claude-factory-b6c.16).
 */
async function linearPass(names: string[] = [], force = false) {
  if (halted()) return []
  const chosen = rigs().filter(r => r.linear?.team?.length && (!names.length || names.includes(r.name)))
  if (!chosen.length) return []
  const state = existsSync(linearSyncFile())
    ? readJson<Record<string, LinearSyncState>>(linearSyncFile())
    : {}
  const lines: string[] = []
  for (const rig of chosen) {
    const prior = state[rig.name]
    const due = linearDue(prior, force)
    if (!due && !linearRecovering(prior)) continue
    if (due) await linearSyncOne(rig, state, force)
    else linearRecoverOne(rig, state)
    const s = state[rig.name]!
    const left = s.unstripped?.length ? `, ${s.unstripped.length} still labeled, retried next pass` : ''
    const trunc = s.truncated ? ', list truncated at the 50-page cap' : ''
    lines.push(
      s.error
        ? `${rig.name}: error, ${s.error}${left}`
        : `${rig.name}: pulled ${s.pulled ?? 0}, created ${s.created ?? 0}, updated ${s.updated ?? 0}, stripped ${s.stripped ?? 0} factory label(s), unrouted ${s.unrouted ?? 0}${left}${trunc}`,
    )
  }
  if (lines.length) writeJson(linearSyncFile(), state)
  return lines
}

/** ticks forever, so runs advance and the rigs dispatch with no console open. Each tick's own
 * kickSweeps starts a due sweep pass; this loop no longer calls sweep() itself. */
async function loop(intervalMs: number) {
  for (;;) {
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
  {
    id,
    bead,
    from,
    ship,
    onto,
  }: { id: string; bead?: string; from?: { run: Run; saved: Saved }; ship?: true; onto?: string },
) {
  const branch = `factory/${id}`
  const base = from?.run.base ?? freshBase(repo)
  const created = herdr(
    ...['worktree', 'create', '--cwd', repo, '--branch', branch, '--base', from?.run.branch ?? onto ?? base],
    ...['--label', `${basename(repo)}/${id}`, '--no-focus', '--json'],
  )
  const ws: string = created.workspace.workspace_id
  const worktree: string = created.worktree.path
  worker.excludeScratch(worktree) // claude-factory-9wu: .scratch/ stays untracked, with no commit, in this repo
  const source = from ? from.run.factory : factorySource(spec, worktree)
  // pinned resolved, as data: a base it extends may change after the run starts
  const pinned = join(runDir(id), 'factory.json')
  mkdirSync(join(runDir(id), 'prompts'), { recursive: true })
  let def: Factory
  try {
    def = await loadFactory(source)
    // a ship edge queues the bead in bd: a repo with no beads has nowhere to queue it
    if (hasShipEdge(def) && !hasBeads(repo))
      throw new Error('it hands its beads to ship, which needs a repo with .beads')
    writeJson(pinned, def)
  } catch (err) {
    herdr('worktree', 'remove', '--workspace', ws, '--force') // fresh, nothing in it yet
    rmSafe(runDir(id), { recursive: true, force: true })
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
    ...(ship && { ship }),
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
  ship?: true,
  shipBranch?: string,
) {
  const id = `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`
  const b = beads(repo, actorOf(id))
  if (bead && !b.claim(bead)) fail(`${bead} is already claimed by another worker`)
  try {
    return await createRun(spec, repo, goal, {
      id,
      bead,
      from,
      ship,
      onto: shipBranch && reworkBase(repo, shipBranch),
    })
  } catch (err) {
    // deferred, not released: a dispatcher would otherwise retry the same failure every window
    if (bead) b.defer(bead, `could not start a run: ${clip((err as Error).message, 300)}`)
    throw err
  }
}

/** the bead a new run works: the one its goal names, or a new one when the repo tracks beads */
/** a run's tasks are its bead's children, and its release waits on every one: a bead whose children
 * already exist is worked child by child, a run each */
/** a child bead that waits on a person: handed to its owner, deferred or rejected */
const isWaitingOnPerson = (x: Bead) =>
  x.status === 'deferred' || !!x.labels?.some(l => l === OWNER || l === REJECTED)
const openChildren = (b: ReturnType<typeof beads>, id: string) =>
  b.children(id).filter(x => x.status !== 'closed')

function beadFor(repo: string, goal: string, { extra = [] as string[], isOwnerOk = false } = {}) {
  if (!hasBeads(repo)) return { goal }
  const b = beads(repo, 'factory')
  // a bare id, or the id in front of '<id>: <title>': goalOf writes every run's goal that way, so a goal
  // copied from a run or `factory status` names its bead too (claude-factory-vad1)
  const id = /^([a-z][\w-]*-[\w.]+)(:\s.*)?$/is.exec(goal.trim())?.[1] ?? ''
  const looksLikeId = !!id
  let named: Bead | null = null
  if (looksLikeId) {
    try {
      named = b.lookup(id)
    } catch (err) {
      fail(`could not look up bead ${id} in ${repo}: ${(err as Error).message}; nothing was created`)
    }
    // not found: a goal shaped like this rig's own bead ids must never become a new bead titled with the
    // id text itself (claude-factory-5q3) -- a lookup failure above already failed the start; this is a
    // genuine "not found", so only refuse when the id would actually belong to this rig
    if (!named) {
      let prefix = ''
      try {
        prefix = b.prefixStrict()
      } catch (err) {
        fail(`could not look up bead ${id} in ${repo}: ${(err as Error).message}; nothing was created`)
      }
      if (id.toLowerCase().startsWith(`${prefix.toLowerCase()}-`))
        fail(`no bead ${id} in ${repo}; nothing was created`)
    }
  }
  if (named) {
    if (isOwned(named) && !isOwnerOk)
      fail(
        `${named.id} carries its owner's decisions (metadata.owner_decisions): it is theirs to hand out. Start it only when the person names it, with --owned`,
      )
    // claude-factory-72v.19: a second, CLI-side layer behind the mod's own Bash-hook regex deny
    // (gatedCommand, in mod/hooks/register.tsx), which an obfuscated command (a backslash inside
    // the verb, a quoted argument) can defeat. FACTORY_PATROL is set only on a patrol subagent's
    // own pinned Bash prefix, never on the main chat's: this refuses the patrol even when it got
    // here with --owned on a bead that really is owned, the same as the FACTORY_FROM refusals
    // below for a worker.
    if (isOwned(named) && process.env.FACTORY_PATROL)
      fail(`${named.id} carries its owner's decisions: a patrol cannot start it, even with --owned`)
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
 * a rig is a repo the factory works (Gas Town's rig): its ready `factory` beads start as runs, its
 * due sweeps start one pass each under `factory sweep` (claude-factory-8pc.16), and `maxRuns` caps
 * its own busy runs under the factory's FACTORY_MAX_RUNS. The factory's rigs.json is written by
 * `factory rig add` and can be edited by hand.
 */
export type Rig = {
  name: string
  repo: string
  /** https clone URL; in the AX task `factory repos sync` clones it to the rig's repo there (src/axrepos.ts) */
  remote?: string
  factory: string
  maxRuns?: number
  /** the most live runs one cluster (clusterKey in src/filing-guard.ts) may hold in this rig; default 2; edit rigs.json by hand */
  clusterRuns?: number
  /** when the rig has room and no labeled bead to start, queue the best unlabeled ready leaf beads (src/autoqueue.ts); off when absent */
  autoQueue?: AutoQueue
  sweeps?: string[]
  /** a sweep station's factory, in place of the built-in "sweeps" (factories/sweeps.ts) */
  sweepsFactory?: string
  /**
   * A read-only command for the monitor sweep (claude-factory-8pc.6). It reads this rig's production
   * watch: SLOs, error budgets, alert states. `factory sweep` runs it on the laptop, as a shell
   * command (through `sh -c`). It never runs on a VM worker: it needs the laptop's own kube
   * credentials and network. Monitor is due only when this is set. `rig add` refuses an explicit
   * `--sweeps` that names `monitor` with no `--slo`.
   */
  slo?: string
  /** what the manager works toward there while the rig has room */
  goal?: string
  /** where its workers run: a name in the runner registry (src/runner.ts); herdr panes here when absent */
  runner?: string
  /** skills every worker in this rig gets, on top of the factory's and the station's (names in harness.ts VM_PLUGINS); edit rigs.json by hand */
  skills?: string[]
  /** worker command for every station here, e.g. `codex --dangerously-bypass-approvals-and-sandbox` or `pi` */
  agent?: string
  /** MCP servers every worker here loads, a file in Claude's --mcp-config shape ({ mcpServers }) */
  mcp?: string
  /** extra HTTPS hosts its workers may reach (the ax runner's egress policy), and the vault keys injected for them */
  egress?: Egress[]
  /** env for its VM workers (the ax runner), over FACTORY_AX_ENV's: FACTORY_BAZELRC, say, for a remote cache */
  env?: Record<string, string>
  /**
   * the AX sandbox class its VM workers (the ax runner) run in (ax-3hy). `microvm` for a repo whose
   * workers build with Nix, which fails under gVisor; AX's gvisor default when absent. The cluster
   * needs a microvm WorkerPool. Edit rigs.json by hand
   */
  sandboxClass?: ax.SandboxClass
  /**
   * a Dolt server VMs share the rig's beads through, instead of the repo's GitHub origin: `name` is the remote
   * in the laptop's store, `url` the address a VM reaches it at (through the egress gateway, which injects the
   * password for `user`)
   */
  beadsRemote?: { name: string; url: string; user: string }
  /** the factory's params, set for this rig (`--param name=value`) */
  params?: Record<string, string>
  /**
   * kube contexts a person alone may change here (claude-factory-25z).
   * Set them with `factory rig add --person-only-context <ctx>` (repeatable).
   * A worker's deny hook refuses a kubectl, ko or helm mutation at one of these contexts.
   * It also refuses one that names no context at all (fail closed).
   */
  personOnlyContexts?: string[]
  /**
   * branches, over main and master, that only a person may push here (claude-factory-zl5).
   * Set them with `factory rig add --protected-branch <b>` (repeatable).
   * A worker's deny hook refuses a `git push` to one of these branches, or to the branch
   * `origin/HEAD` names, no matter what this list holds.
   */
  protectedBranches?: string[]
  /**
   * opts this rig into merge authority (claude-factory-l3tl). A person sets it with
   * `factory rig add --merge-authority`. Only the literal true counts.
   * The ship factory's release station may then run one strict `gh pr merge` form.
   */
  mergeAuthority?: boolean
  /** opts this rig into the Linear pull loop (claude-factory-b6c).
   * It names the rig's team(s).
   * It also names the project and label names that route an issue to it (claude-factory-b6c.18). */
  linear?: LinearRouting
  /** `tick()` adds this from `linear-sync.json` for an opted-in rig; `rig add` never writes it */
  linearSync?: LinearSyncState
}
const rigsFile = () => join(HOME, 'rigs.json')
/** `$FACTORY_HOME/linear-sync.json`'s per-rig state, keyed by rig name, after each Linear pull attempt */
export type LinearSyncState = {
  at: number
  pulled?: number
  created?: number
  updated?: number
  stripped?: number
  /** issues this rig's team(s) listed that no opted-in rig claimed (`routeLinearIssue`); never pulled */
  unrouted?: number
  /**
   * ids the strip does not confirm as removed: `bd label remove` failed on them, or the listing call
   * after the pull failed. The next pass retries these ids first.
   */
  unstripped?: string[]
  /**
   * This is the pre-pull snapshot of labeled ids.
   * The function keeps it only while the post-pull listing cannot confirm which ids the pull labeled
   * (security#1.13).
   * The next pass diffs against this stored set, not a fresh snapshot.
   * A fresh snapshot would already include the ids this pull labeled, so the diff would never count
   * them as new.
   * The function clears this field the next time the listing succeeds.
   */
  baseline?: string[]
  /**
   * The time (`Date.now()`) of this rig's last pull that reached `bd` with no error, or that had
   * nothing due to pull. The next pass only sends `bd` a routed issue whose Linear `updatedAt` is
   * newer than this, so a pass does not re-send hundreds of unchanged issues (claude-factory-b6c.24).
   * A failed pass does not move this forward: the next pass must still cover the gap.
   * `--force`, and a rig's first pass, read every routed issue regardless of this field.
   */
  lastGoodAt?: number
  /** fingerprint of the rig's Linear team, projects and labels at the last good pull. A change drops the cutoff. */
  routing?: string
  /** this pass's Linear issue listing stopped at the 50-page cap, so `unrouted` and the
   * `updatedAt` cutoff above may undercount the team's real issues (claude-factory-b6c.24) */
  truncated?: boolean
  error?: string
}
export const linearSyncFile = () => join(HOME, 'linear-sync.json')
/** `factory rig list`'s one line of a rig's last Linear pull: its age, what it pulled, or its error */
function linearSyncLine(name: string): string {
  if (!existsSync(linearSyncFile())) return ''
  const s = readJson<Record<string, LinearSyncState>>(linearSyncFile())[name]
  if (!s) return ''
  const age = `${Math.round((Date.now() - s.at) / 60_000)}m ago`
  const trunc = s.truncated ? ', list truncated at 50 pages' : ''
  return s.error
    ? ` (error ${age}: ${s.error})`
    : ` (pulled ${s.pulled ?? 0}, unrouted ${s.unrouted ?? 0}, ${age}${trunc})`
}
const linearToldFile = () => join(HOME, 'linear-told.json')
/**
 * the manager hears once of each rig's new Linear pull error (claude-factory-b6c.5). A repeat of an
 * error already told stays quiet. A pull that then succeeds clears the told state, so a later new
 * failure tells the manager again, the same way skillMail (above) dedupes a pending skill set.
 */
function linearMail(now: number): (Mail & { run: string })[] {
  if (!existsSync(linearSyncFile())) return []
  const state = readJson<Record<string, LinearSyncState>>(linearSyncFile())
  const told = existsSync(linearToldFile()) ? readJson<Record<string, string>>(linearToldFile()) : {}
  const mail: (Mail & { run: string })[] = []
  let changed = false
  for (const [name, s] of Object.entries(state)) {
    if (s.error) {
      if (told[name] !== s.error) {
        mail.push({
          run: 'factory',
          from: 'linear',
          text: `${name}: Linear pull failed: ${s.error}`,
          at: now,
        })
        told[name] = s.error
        changed = true
      }
    } else if (name in told) {
      delete told[name]
      changed = true
    }
  }
  if (changed) writeJson(linearToldFile(), told)
  return mail
}
/** `factory repos sync`: clone or fetch each rig's repo in the AX task and bootstrap its beads store; the problems, one per line */
const reposSync = (): string[] => {
  if (!inAx()) fail('factory repos sync runs inside the AX manager task (FACTORY_IN_AX=1)')
  return syncRepos(rawRigs(), HOME)
}

const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

/** `factory migrate-to-ax [--dry-run] [--force] [--keep N]`: see docs/remote-runner.md, Move the factory to AX */
async function migrateToAx(args: string[]) {
  if (inAx()) fail('factory migrate-to-ax runs on the laptop')
  const dry = args.includes('--dry-run')
  const force = args.includes('--force')
  const k = args.indexOf('--keep')
  const keep = k >= 0 ? Number(args[k + 1]) : 50
  if (!Number.isInteger(keep) || keep < 0)
    fail('usage: factory migrate-to-ax [--dry-run] [--force] [--keep N]')
  const origin = (repo: string) => {
    const r = Bun.spawnSync(['git', '-C', repo, 'remote', 'get-url', 'origin'], { stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
  }
  const p = migrate.plan(HOME, keep, origin)
  console.log(migrate.describe(p))
  if (p.refusal) fail(p.refusal)
  if (p.rigsError) fail(p.rigsError)
  if (dry) return console.log('dry run: nothing written, nothing sent')
  const task = ax.managerTask()
  const phase = ax.phase(task)
  if (phase !== 'Running')
    fail(`the manager task ${task} is ${phase ?? 'not there'}: run factory manager --ax first`)
  if (!force && ax.managerHomeUsed())
    fail(`the manager's home in ${task} already holds a factory: use --force to write over it`)
  const dir = mkdtempSync(join(tmpdir(), 'factory-migrate-'))
  const out = join(dir, 'migrate.tgz')
  console.log(`packed ${migrate.mb(migrate.pack(HOME, p, out))}; sending to ${task}`)
  const b64 = readFileSync(out).toString('base64')
  const parts = Math.ceil(b64.length / ax.PUT_PART)
  for (let i = 0; i < parts; i++) {
    const chunk = b64.slice(i * ax.PUT_PART, (i + 1) * ax.PUT_PART)
    let r = ax.put(task, 'migrate.tgz', i, parts, chunk)
    for (let t = 0; !r.ok && t < 3; t++) {
      await sleepMs(2000)
      r = ax.put(task, 'migrate.tgz', i, parts, chunk)
    }
    if (!r.ok) fail(`part ${i + 1} of ${parts} did not arrive: ${r.err}`)
    if ((i + 1) % 50 === 0) console.log(`sent ${i + 1} of ${parts}`)
  }
  ax.unpackMigration('migrate.tgz')
  rmSafe(dir, { recursive: true, force: true })
  console.log(`moved the factory home to ${task}: its manager starts now. factory attach`)
}

/** rigs.json as written: on the laptop, the repo paths are the laptop's */
const rawRigs = (): Rig[] => (existsSync(rigsFile()) ? readJson(rigsFile()) : [])
/** the rigs as this process works them: in the AX task, each `repo` is the rig's clone (src/axrepos.ts) */
const rigs = (): Rig[] => mapRigs(rawRigs())
const rigOf = (repo: string) => rigs().find(r => r.repo === repo)
/** `rig.personOnlyContexts`, or undefined when it is absent or not an array of strings (a hand-edited rigs.json) */
const personOnlyContexts = (rig?: Pick<Rig, 'personOnlyContexts'>): string[] | undefined =>
  Array.isArray(rig?.personOnlyContexts) && rig.personOnlyContexts.every(c => typeof c === 'string')
    ? rig.personOnlyContexts
    : undefined
/** `rig.protectedBranches`, or undefined when it is absent or not an array of strings (a hand-edited rigs.json) */
const protectedBranches = (rig?: Pick<Rig, 'protectedBranches'>): string[] | undefined =>
  Array.isArray(rig?.protectedBranches) && rig.protectedBranches.every(b => typeof b === 'string')
    ? rig.protectedBranches
    : undefined
/**
 * the rig's owner/repo (from its origin remote) when `rig.mergeAuthority` is the literal true
 * (a hand-edited rigs.json cannot loosen it), else undefined. No readable origin gives undefined: no merge.
 */
const mergeAuthority = (rig?: Pick<Rig, 'mergeAuthority'> & { repo?: string }): string | undefined => {
  if (rig?.mergeAuthority !== true || !rig.repo) return undefined
  try {
    return git(expand(rig.repo), 'remote', 'get-url', 'origin').match(
      /[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
    )?.[1]
  } catch {
    return undefined
  }
}
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

/** This function marks a run's current station for the caps.
 *
 * 'free': the run holds no worker. Three cases give 'free': the node is empty (the run is done
 * or aborted); the node is a gate (the person answers it); the sub-state is 'waiting'.
 *
 * 'rig': the sub-state is 'stuck'. The worker pane stays up. The manager can inspect it (see
 * machine.ts). On an ax rig, this pane is an AX task. A stuck run still fills its rig's maxRuns.
 * The person holds a stuck run, like a wait or a gate, so it does not fill the town's
 * FACTORY_MAX_RUNS.
 *
 * 'busy': any other sub-state (working or backoff). A busy run fills both caps. */
export const slot = (n: { gate?: true } | undefined, sub: string): 'free' | 'rig' | 'busy' => {
  if (!n || n.gate || sub === 'waiting') return 'free'
  if (sub === 'stuck') return 'rig'
  return 'busy'
}

/** how many more runs may hold a worker in `rig`, given the rigs of the runs that hold one now
 * (`busy`) and the rigs of the runs merely held there, stuck, costing the rig a slot but not the
 * town one (`held`) */
export const room = (
  rig: Pick<Rig, 'name' | 'maxRuns'> | undefined,
  busy: (string | undefined)[],
  max = MAX_BUSY,
  held: (string | undefined)[] = [],
) =>
  Math.min(
    max - busy.length,
    rig?.maxRuns === undefined
      ? Infinity
      : rig.maxRuns - busy.filter(b => b === rig.name).length - held.filter(h => h === rig.name).length,
  )

/** the most live runs one cluster may hold in `rig`: `clusterRuns` when a positive integer, else 2 */
export const clusterCap = (rig: Pick<Rig, 'clusterRuns'>) =>
  Number.isInteger(rig.clusterRuns) && rig.clusterRuns! > 0 ? rig.clusterRuns! : 2

/**
 * the rigs' beads sync with their Dolt remotes, apart from dispatch: a slow or hung remote must not hold
 * a start. The due rigs sync in parallel, each killed at the sync cap; a rig that fails the same way again
 * waits longer (src/sync.ts).
 */
async function syncPass() {
  const release = hold('sync.lock')
  if (!release) return
  try {
    if (halted()) return
    writeFileSync(join(HOME, 'sync.stamp'), '')
    const synced = existsSync(syncFile()) ? readJson<Record<string, SyncEntry>>(syncFile()) : {}
    const due = rigs().filter(r => existsSync(join(r.repo, '.beads')) && syncDue(synced[r.repo], Date.now()))
    await Promise.all(
      due.map(async rig => {
        const t0 = Date.now()
        let error: string | undefined
        try {
          if (rig.beadsRemote) await syncAsRemoteUser(rig)
          else await beads(rig.repo, 'factory').sync()
        } catch (err) {
          error = clip((err as Error).message || 'sync failed', 300)
        }
        synced[rig.repo] = nextSyncEntry(synced[rig.repo], { error, ms: Date.now() - t0 }, Date.now())
        writeJson(syncFile(), synced)
      }),
    )
  } finally {
    release()
  }
}

/** the rigs' ready `factory` beads become runs while each rig, and the factory, has room */
/** what the last dispatch could not do, per rig: the board shows it as rows */
const dispatchFile = () => join(HOME, 'dispatch.json')
const syncFile = () => join(HOME, 'sync.json')
/** the flood guard's own "already handled" marks (claude-factory-8pc.18): a sweep worker's bd
 * labels never reach this file, so they cannot forge the mark the way `sweep:<station>` can. */
const sweepGuardFile = () => join(HOME, 'sweep-guard.json')
const filingGuardFile = () => join(HOME, 'filing-guard.json')
/** per rig, the times (ms) auto-queue took a bead: the rolling hour's cap reads this */
const autoQueueFile = () => join(HOME, 'auto-queue.json')

/** why a rig takes no more runs: the town's cap, or its own */
const fullText = (
  rig: Pick<Rig, 'name' | 'maxRuns'>,
  busy: (string | undefined)[],
  held: (string | undefined)[],
) =>
  MAX_BUSY - busy.length <= 0
    ? `town full ${busy.length}/${MAX_BUSY}`
    : `rig full ${busy.filter(b => b === rig.name).length + held.filter(h => h === rig.name).length}/${rig.maxRuns}`

/** a rig with room that dispatch has nothing to start for and no goal to steer the manager by sits unnoticed unless the board says so */
export const idle = (rig: Pick<Rig, 'goal'>, ready: number) => !rig.goal && ready === 0

/**
 * This reads what dispatch must hold back, from `linear-sync.json` (claude-factory-b6c.16).
 * A person, not a Linear label, must decide what the factory works on (see `linearSyncOne`). Until a
 * pull's label strip confirms itself, dispatch must fail closed, not start a run on the unconfirmed bead.
 *
 * `ids` names each bead an `unstripped` retry still owes a check. `rigs` names each rig with an open
 * `baseline` diff: that rig's other ready beads are not Linear beads, but this function cannot tell
 * which ones are, so it holds back the whole rig until the next listing resolves the diff.
 */
function linearExcluded(): { ids: Set<string>; rigs: Set<string> } {
  const state = existsSync(linearSyncFile())
    ? readJson<Record<string, LinearSyncState>>(linearSyncFile())
    : {}
  const ids = new Set<string>()
  const rigs = new Set<string>()
  for (const [name, s] of Object.entries(state)) {
    for (const id of s.unstripped ?? []) ids.add(id)
    if (s.baseline) rigs.add(name)
  }
  return { ids, rigs }
}

/** the bead ids any live run owns right now (not `done` or `aborted`): a finished run's deferred
 * bead, undeferred by a person, is new work again. `dispatch()` must not start a second run on
 * one of these; `factory plan facts` reports them to the pm as busy context (claude-factory-dun.2). */
const liveBeadIdSet = () =>
  new Set(
    startedRunIds().flatMap(id => {
      const { run, value } = current(id)
      return run.bead && !['done', 'aborted'].includes(where(value)[0]) ? [run.bead] : []
    }),
  )

/** Checks `plan.json`'s shape before any caller reads `rigs` or `proposals`.
 * A hand-edited or truncated file can miss one of these fields.
 * Without this check, `orderByPlan` or `planShowText` would then throw (claude-factory-dun.17d).
 * `plan set` itself always writes the full shape. */
function isValidPlanShape(p: unknown): p is plan.Plan {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return (
    typeof o.at === 'number' &&
    !!o.rigs &&
    typeof o.rigs === 'object' &&
    !Array.isArray(o.rigs) &&
    Object.values(o.rigs as Record<string, unknown>).every(plan.isValidRigPlan) &&
    Array.isArray(o.proposals)
  )
}

/** the pm's plan, read once per `dispatch()` pass: missing, corrupt, malshaped or stale
 * (`!plan.isFresh`) all read as no plan, so dispatch falls back to today's order
 * (claude-factory-dun.3, .17d). */
function freshPlanOrUndefined(): plan.Plan | undefined {
  if (!existsSync(planFile())) return undefined
  try {
    const p: unknown = JSON.parse(readFileSync(planFile(), 'utf8'))
    if (!isValidPlanShape(p)) return undefined
    return plan.isFresh(p, Date.now()) ? p : undefined
  } catch {
    return undefined
  }
}

// claude-factory-6as: dispatch's pre-check.
// A 3-day review found 30 of 319 triage visits (9.4%) already done.
// A merged PR did the work before triage ever saw the bead. Each one cost a run and a worktree.
// This code checks a ready bead against the rig's merged pull requests, right before dispatch starts it.
const PRECHECK_TIMEOUT_MS = 15_000
const precheckFile = () => join(HOME, 'precheck.jsonl')
/** one line per pre-check hit or fail-open, for `factory metrics` and a soak trail independent of bd */
/** claude-factory-6as.10: logPrecheck is best effort. A bad precheck.jsonl file must not block the bd comment after it, or the rest of the pass. */
const logPrecheck = (rig: string, bead: string, kind: string, evidence: string) => {
  try {
    durable(precheckFile(), `${JSON.stringify({ at: Date.now(), rig, bead, kind, evidence })}\n`, 'a')
  } catch {
    // best effort: see above
  }
}

/** `gh pr list --state merged --search <id> ...`, a second `--search <short id>` for a dotted child id, plus a REST `head=<owner>:<branch>` lookup for up to 3 local run
 * branches of this bead (a PR that closed the bead's own run but never named it in its title) */
async function mergedPrsFor(repo: string, id: string, branches: string[], gh: Gh): Promise<MergedPr[]> {
  const fields = 'number,url,title,headRefName,mergeCommit'
  const search = await gh(['pr', 'list', '--state', 'merged', '--search', id, '--json', fields, '-L', '30'], {
    cwd: repo,
    timeout: PRECHECK_TIMEOUT_MS,
  })
  if (search.code !== 0) throw new Error(clip(search.err.trim().split('\n')[0] || 'gh pr list failed', 200))
  const found = parseMergedPrs(search.out)
  // claude-factory-jxl.1: a title may cite only the short child id ("192.6"); the full-id search misses it
  const short = shortBeadId(id)
  if (short) {
    const byShort = await gh(
      ['pr', 'list', '--state', 'merged', '--search', short, '--json', fields, '-L', '30'],
      {
        cwd: repo,
        timeout: PRECHECK_TIMEOUT_MS,
      },
    )
    if (byShort.code === 0) found.push(...parseMergedPrs(byShort.out))
  }
  // claude-factory-6as.9: a failed `--head` call must not discard a hit `--search` already found.
  // Each branch is a supplementary lookup, so this keeps every row a call did return and skips only
  // the one call that failed.
  for (const branch of branches.slice(0, 3)) {
    const ref = rigRef(repo)
    const byHead = ref
      ? await githubMergedJson(gh, ref.slug, repo, { pages: 1, head: `${ref.owner}:${branch}` })
      : null
    if (byHead !== null) found.push(...parseMergedPrs(byHead))
  }
  return found
}

/**
 * claude-factory-6as: check if a merged PR already proves `bead`'s work is done.
 * If it does, dispatch must reject the bead instead of starting a run for it.
 *
 * This makes no gh call at all in four cases:
 * - `FACTORY_PRECHECK=0`
 * - a person already overrode a prior reject (`rejected_by` metadata still names dispatch after a
 *   requeue)
 * - the id does not look like a bead id
 * - the rig's repo is not on GitHub
 *
 * A gh failure or timeout fails open: the run starts, and the caller gets one dispatch.json row that
 * shows it.
 */
async function precheckSkip(
  rig: Pick<Rig, 'name' | 'repo'>,
  bead: Bead,
  b: ReturnType<typeof beads>,
  runBranches: string[],
  gh: Gh,
): Promise<{ skip: boolean; error?: string }> {
  if (process.env.FACTORY_PRECHECK === '0') return { skip: false }
  if (bead.metadata?.rejected_by === 'dispatch') return { skip: false }
  // claude-factory-wnm: a requeue edge already proved an earlier run's PR landed. The pre-check
  // must not reject this bead for that same, already-landed PR. This exemption covers one dispatch
  // pass only. The candidate loop below clears `requeued_from` right after it starts the run this
  // exemption was for (claude-factory-wnm.13). A later, unrelated pickup of this bead then goes
  // through the pre-check like any other.
  if (bead.metadata?.requeued_from) return { skip: false }
  if (!/^[\w.-]+$/.test(bead.id)) return { skip: false }
  if (originRef(rig.repo)?.forge !== 'github') return { skip: false }
  let merged: MergedPr[]
  try {
    merged = await mergedPrsFor(rig.repo, bead.id, runBranches, gh)
  } catch (err) {
    const error = `pre-check skipped: ${(err as Error).message}`
    logPrecheck(rig.name, bead.id, 'skip', error)
    return { skip: false, error }
  }
  const children = b.children(bead.id)
  const hit = alreadyDone(bead.id, merged, {
    childIds: children.map(c => c.id),
    allChildrenClosed: children.length > 0 && children.every(c => c.status === 'closed'),
    runBranches,
  })
  if (!hit) return { skip: false }
  const evidence = evidenceLine(hit.pr, rig.name, bead.id)
  try {
    b.reject(bead.id, 'dispatch', evidence)
  } catch {
    return { skip: true } // not landed: skip only this pass, with no comment; the next pass retries
  }
  logPrecheck(rig.name, bead.id, hit.kind, evidence)
  try {
    b.comment(bead.id, evidence)
  } catch {
    // the reject already landed; a bead with no comment still shows rejected, evidence in its metadata
  }
  return { skip: true }
}

async function dispatch() {
  const stamp = join(HOME, 'dispatch.stamp')
  if (halted() || !rigs().length || (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < DISPATCH_MS))
    return
  writeFileSync(stamp, '')
  const errors: Row[] = []
  const { busy, held } = await busyRigs()
  const { ids: linearIds, rigs: linearRigs } = linearExcluded()
  // claude-factory-6as.9: one hung gh call already proved gh broken for this pass (5 calls, up to
  // 15s each). The other candidates, in this rig or the next, must fail open with no further gh
  // calls, not wait out the same timeout again.
  let ghFailed = false
  // live runs only: a finished run's deferred bead, undeferred by a person, is new work again.
  // claude-factory-6as.3: a Map, not a Set, so dispatch can name the run working a bead that is
  // still `ready` and unassigned (it lost its own claim on the bead), for one comment.
  const linked = new Map(
    startedRunIds().flatMap(id => {
      const { run, value } = current(id)
      return run.bead && !['done', 'aborted'].includes(where(value)[0])
        ? ([[run.bead, id]] as [string, string][])
        : []
    }),
  )
  // the pm's plan, read once per pass: a stale or missing plan changes nothing (claude-factory-dun.3)
  const freshPlan = freshPlanOrUndefined()
  // a sync's error stands until the next sync: dispatch passes every 30 s would clear it
  const synced = existsSync(syncFile()) ? readJson<Record<string, SyncEntry>>(syncFile()) : {}
  // The flood guard's own "already handled" marks (claude-factory-8pc.18). Dispatch reads this
  // once per pass, and writes it back once at the end. A sweep worker's bd labels never reach
  // this file.
  let guardState: SweepGuardState = existsSync(sweepGuardFile())
    ? readJson<SweepGuardState>(sweepGuardFile())
    : {}
  // Each rig's open bead ids, from this pass's own `b.every()` call (claude-factory-8pc.21).
  // `pruneGuardState` below uses this to keep a rig's marks only for beads still open. A rig not read
  // this pass keeps all its marks, so a released bead is not held again.
  const openIds: Record<string, Set<string>> = {}
  // The filing guard's marks (claude-factory-nwlh.2): same shape and rules as the sweep guard's.
  let filingState: SweepGuardState = existsSync(filingGuardFile())
    ? readJson<SweepGuardState>(filingGuardFile())
    : {}
  const autoHistory: Record<string, number[]> = existsSync(autoQueueFile())
    ? readJson<Record<string, number[]>>(autoQueueFile())
    : {}
  let signing: ReturnType<typeof signingProbe> | undefined // claude-factory-8je: one probe a pass
  for (const rig of rigs()) {
    if (!hasBeads(rig.repo)) continue // claude-factory-toml: a rig with no .beads store has no beads steps
    // claude-factory-2rik: why each ready bead did not start, so dispatch.json can name it
    const skips = new Map<string, string>()
    const started = new Set<string>()
    let readyIds: string[] = []
    let roomText = ''
    let rigError = ''
    try {
      const preview = await loadFactory(factorySource(rig.factory, rig.repo))
      const b = beads(rig.repo, 'factory')
      // the sync runs in its own pass (syncPass): dispatch only shows how the last one went
      const syncError = syncText(synced[rig.repo])
      if (syncError) errors.push({ id: `rig:${rig.name}`, error: syncError }) // dispatch goes on: local beads are still true
      if (room(rig, busy, undefined, held) <= 0) {
        errors.push({ id: `rig:${rig.name}`, rig: rig.name, skip: fullText(rig, busy, held) })
        continue // full: no more bd calls
      }
      if (linearRigs.has(rig.name)) {
        // an open Linear baseline: a pull may have labeled a bead here that the listing never confirmed
        // (claude-factory-b6c.16); hold back every ready bead until the retry resolves it
        errors.push({
          id: `rig:${rig.name}`,
          error: 'Linear label strip unresolved: dispatch held back until the retry confirms it',
        })
        continue
      }
      // the flood guard (claude-factory-8pc.5), before b.ready(). A deferred or unlabeled bead must
      // never show up as ready work this same pass. The guard must fail closed.
      //
      // claude-factory-8pc.12 and .18: `guardHandled` reads sweep-guard.json. It never reads the
      // bead's own `sweep:<station>` label. dispatch marks a bead only after its own guard scores
      // it, and the defer-or-relabel call below lands. A sweep worker cannot forge this mark by
      // filing a bead with the label already on it: dispatch still scores that bead the first time
      // it sees it. Once dispatch marks a bead, a person's `factory queue` on a held bead stands.
      // The guard does not undo that re-queue.
      //
      // claude-factory-8pc.13: two failure paths must fail closed. (a) When `b.every()` throws,
      // `continue` skips the rest of this rig: no ready bead starts for it this pass. (b) The code
      // drops from `ready` each bead the guard did not keep and allow. So a failed `defer` or
      // `relabel` call still cannot start that bead.
      let all: Bead[]
      try {
        all = b.every()
      } catch (err) {
        errors.push({ id: `rig:${rig.name}`, error: (err as Error).message })
        continue // the guard read failed: start no ready bead for this rig this pass
      }
      openIds[rig.name] = new Set(all.filter(x => x.status !== 'closed').map(x => x.id))
      const excluded = new Set<string>()
      const scored = new Set<string>()
      for (const v of sweepGuard(all, Date.now())) {
        scored.add(v.id)
        const current = all.find(x => x.id === v.id)
        if (!current) continue
        // claude-factory-8pc.22: sweepGuard above still counts a closed bead for the cap. A
        // closed bead needs no bd write. pruneGuardState (src/sweeps.ts) drops a closed bead's
        // mark each pass: this pass's open-ids set never names it. With no check here, a closed
        // in-window sweep bead would get a fresh bd defer or bd update call every pass, forever.
        if (current.status === 'closed') continue
        if (guardHandled(guardState, rig.name, v.id)) continue // scored before: leave it alone
        if (!v.kept || !v.allowed) excluded.add(v.id) // never start this pass, win or lose the call below
        const hasFactory = !!current.labels?.includes(LABEL)
        try {
          if (!v.kept) {
            b.defer(
              v.id,
              `sweep flood guard: rig ${rig.name} already has 5 sweep-filed beads in the last 24h`,
            )
            b.relabel(v.id, { add: [`sweep:${v.station}`], remove: hasFactory ? [LABEL] : [] })
          } else {
            const remove = v.allowed || !hasFactory ? [] : [LABEL]
            b.relabel(v.id, { add: [`sweep:${v.station}`], remove })
          }
          guardState = markGuardHandled(guardState, rig.name, v.id, Date.now()) // only on success: a failed call retries next pass
        } catch (err) {
          errors.push({ id: v.id, error: (err as Error).message })
        }
      }
      // claude-factory-8pc.21: `sweepGuard` only scores a bead inside its own 24h window. Dispatch
      // can miss a bead for over 24h: the rig can stay full, the factory can halt, or `b.every()`
      // can keep throwing. That bead then ages out of the window with no mark at all. Hold it the
      // same way a past-the-cap bead is held above: strip `factory`, add `sweep:<station>`, and
      // mark it. Only a mark lets a sweep-filed bead start. An unmarked one never starts, however
      // old it is.
      for (const current of all) {
        const station = sweepFiler(current)
        if (!station || scored.has(current.id) || guardHandled(guardState, rig.name, current.id)) continue
        if (current.status === 'closed') continue // claude-factory-8pc.22: no bd write on a closed bead
        excluded.add(current.id)
        const hasFactory = !!current.labels?.includes(LABEL)
        try {
          b.defer(
            current.id,
            `sweep flood guard: rig ${rig.name}'s ${current.id} aged out of the 24h guard window unscored`,
          )
          b.relabel(current.id, { add: [`sweep:${station}`], remove: hasFactory ? [LABEL] : [] })
          guardState = markGuardHandled(guardState, rig.name, current.id, Date.now())
        } catch (err) {
          errors.push({ id: current.id, error: (err as Error).message })
        }
      }
      // claude-factory-nwlh.2: the filing guard. `filingGuard` (src/filing-guard.ts) scores the
      // top-level beads a factory worker filed (a child bead and a sweep-filed bead are not its
      // concern; a closed bead uses a slot but gets no write). The guard scores each bead against the
      // 24h before its own filing time, so a pass with room scores the same as an earlier pass. A bead
      // past a cap loses `factory`, gains `held:cluster:<key>` or
      // `held:station`, and gets one comment. A mark in filing-guard.json is written only after
      // both calls land. `factory queue` removes the `held:*` label; the mark keeps the guard from
      // holding the bead again. Like the sweep guard, a failed call leaves the bead out of `ready`.
      for (const v of filingGuard(
        all.filter(x => !parentOf(x) && !sweepFiler(x)),
        Date.now(),
      )) {
        if (v.kept) continue
        const current = all.find(x => x.id === v.id)
        if (guardHandled(filingState, rig.name, v.id)) {
          // marked: a bead still without `factory` (held or mark-only) must not reach auto-queue; a re-queued one starts
          if (!current?.labels?.includes(LABEL)) excluded.add(v.id)
          continue
        }
        if (current?.status === 'closed') continue // a closed bead uses a slot but needs no hold
        excluded.add(v.id)
        if (!current?.labels?.includes(LABEL)) {
          // not factory-queued (a person's or pm-proposal bead): mark only, no relabel, comment or row
          filingState = markGuardHandled(filingState, rig.name, v.id, Date.now())
          continue
        }
        try {
          const label = v.held === 'cluster' ? `held:cluster:${v.cluster}` : 'held:station'
          b.relabel(v.id, { add: [label], remove: [LABEL] })
          b.comment(
            v.id,
            `filing guard: held (${label}). ${v.held === 'cluster' ? `Cluster ${v.cluster} already has 6 beads` : `Run/station ${v.station} already filed 3 beads`} in the last 24h. Run: factory queue ${rig.name} ${v.id} to release it.`,
          )
          filingState = markGuardHandled(filingState, rig.name, v.id, Date.now()) // only on success
          errors.push({ id: v.id, rig: rig.name, skip: `filing guard: held (${label})` })
        } catch (err) {
          skips.set(v.id, 'filing guard: hold call failed, retries next pass')
          errors.push({ id: v.id, error: (err as Error).message })
        }
      }
      // claude-factory-8pc.17 and .18: a sweep pass can file a new bead. This can happen between
      // the `b.every()` read above and the `b.ready()` read below. Neither loop above scores this
      // bead, so it is not in `excluded`. It still shows up in `ready`, with no cap check and no
      // allowlist check. Drop it here too, the same as any other unmarked sweep-filed bead: a
      // bead this fresh cannot already carry a sweep-guard mark from an earlier pass.
      const everyReady = b.ready()
      readyIds = everyReady.map(x => x.id)
      const ready = everyReady.filter(x => {
        const isKept = (() => {
          if (excluded.has(x.id)) return false
          if (filingActor(x.created_by) && !all.some(y => y.id === x.id)) {
            skips.set(x.id, 'filing guard: filed mid-pass') // the guard never scored it
            return false
          }
          const station = sweepFiler(x)
          if (!station) return true // not a sweep-filed bead: not this guard's concern
          return guardHandled(guardState, rig.name, x.id) // only a mark from an earlier pass lets it start
        })()
        if (!isKept && !skips.has(x.id)) skips.set(x.id, 'sweep flood guard')
        return isKept
      })
      // claude-factory-6as.3: a live run can already hold a ready, unassigned, top-level bead (it
      // lost its own claim on the bead, to a reaper, say). `dispatchable` below drops this bead from
      // `candidates`, so no second run starts for it. This loop still leaves one comment naming the
      // run. A `dispatch_skip` metadata stamp dedupes it, so a stuck bead gets no new comment every
      // 30s pass.
      for (const x of ready) {
        if (x.parent || x.assignee) continue
        const runId = linked.get(x.id)
        if (!runId || x.metadata?.dispatch_skip === runId) continue
        let node = ''
        try {
          node = where(current(runId).value)[0] ?? ''
        } catch {
          // the run ended, or something removed it between building `linked` and here; comment with no node
        }
        try {
          b.setMetadata(x.id, { dispatch_skip: runId })
        } catch (err) {
          errors.push({ id: x.id, error: (err as Error).message })
          continue // not landed: skip the comment too, so a later pass can retry both together
        }
        const evidence = `not started: live run ${runId}${node ? ` at ${node}` : ''} works this bead`
        logPrecheck(rig.name, x.id, 'live-run', evidence) // claude-factory-6as.4: counted by `factory metrics`
        try {
          b.comment(x.id, evidence)
        } catch (err) {
          errors.push({ id: x.id, error: (err as Error).message }) // the metadata stamp already landed
        }
      }
      // children are looked up only for the candidates, until the rig is full
      const startable = dispatchable(ready, new Set(linked.keys()), Infinity, byId(all))
      const startableIds = new Set(startable.map(x => x.id))
      for (const x of ready) {
        if (startableIds.has(x.id)) continue
        const parent = parentOf(x)
        skips.set(
          x.id,
          x.parent
            ? `child of ${x.parent}`
            : x.assignee
              ? `assigned to ${x.assignee}`
              : linked.has(x.id)
                ? `live run ${linked.get(x.id)} works it`
                : parent
                  ? `child of ${parent}`
                  : 'not startable',
        )
      }
      const eligible = startable.filter(x => {
        const open = isOwned(x) || x.labels?.includes(OWNER) ? [] : openChildren(b, x.id)
        const why =
          isOwned(x) || x.labels?.includes(OWNER) || (open.length && open.every(isWaitingOnPerson))
            ? 'owner decisions pending'
            : hygieneHeld(x)
              ? 'hygiene proposed close (factory queue releases it)'
              : open.length
                ? 'open children'
                : linearIds.has(x.id)
                  ? 'Linear id unconfirmed'
                  : ''
        if (why) skips.set(x.id, why)
        return !why
      })
      // a fresh plan's order wins inside each priority band; a stale or missing plan changes
      // nothing (claude-factory-dun.3). `rigPlanOf` looks up the rig safely: a plain
      // `freshPlan.rigs[rig.name]` would resolve a rig named, for example, `constructor` to an
      // inherited `Object.prototype` value instead of `undefined` (claude-factory-dun.18).
      const candidates = plan.orderByPlan(eligible, plan.rigPlanOf(freshPlan, rig.name))
      // claude-factory-8je: a local run must commit. If the commit cannot sign, the run parks. Probe
      // once each pass, in the first local rig that has work. ponytail: the signing agent is shared by
      // the host, so one repo stands for all. Upgrade path: one memo for each repo, if rigs get
      // different signing configs.
      if (runners[rig.runner ?? DEFAULT_RUNNER]?.local && (candidates.length || autoQueueOf(rig))) {
        if (!signing) {
          signing = signingProbe(rig.repo)
          if (!signing.ok)
            errors.push({
              id: 'signing',
              error: `commit signing failed: ${signing.error}. Unlock the signing agent (or fix it); local runs wait. No unsigned fallback.`,
            })
        }
        if (!signing.ok) {
          for (const x of candidates) skips.set(x.id, 'commit signing down')
          continue
        }
      }
      // claude-factory-x9ai.5: no labeled bead to start and room left: take the best unlabeled leaf beads
      const auto = autoQueueOf(rig)
      if (auto && !candidates.length) {
        const now = Date.now()
        const history = Array.isArray(autoHistory[rig.name]) ? autoHistory[rig.name]! : []
        const parents = new Set(all.filter(x => x.status !== 'closed' && x.parent).map(x => x.parent!))
        const picks = autoPick(
          b.unqueued(),
          now,
          history,
          auto,
          room(rig, busy, undefined, held),
          parents,
          excluded,
        ).filter(x => !openChildren(b, x.id).length && !linearIds.has(x.id))
        const taken: number[] = []
        for (const x of picks) {
          try {
            b.relabel(x.id, { add: [LABEL, AUTO_LABEL] })
          } catch (err) {
            errors.push({ id: x.id, error: (err as Error).message })
            continue
          }
          taken.push(now)
          skips.set(x.id, 'auto-queued')
          readyIds.push(x.id)
          candidates.push(x)
        }
        autoHistory[rig.name] = [...recentPicks(history, now), ...taken]
      }
      if (idle(rig, candidates.length))
        errors.push({ id: `rig:${rig.name}`, rig: rig.name, idle: 'no goal, no ready beads' })
      // nwlh.3: live runs per cluster; a linked bead of another rig is not in `all`, so not counted
      const liveByCluster = new Map<string, number>()
      const rigBeads = byId(all)
      for (const id of linked.keys()) {
        const lb = rigBeads.get(id)
        if (lb) liveByCluster.set(clusterKey(lb), (liveByCluster.get(clusterKey(lb)) ?? 0) + 1)
      }
      for (const bead of candidates) {
        if (room(rig, busy, undefined, held) <= 0) {
          roomText = fullText(rig, busy, held)
          break
        }
        const cluster = clusterKey(bead)
        const clusterLive = liveByCluster.get(cluster) ?? 0
        if (clusterLive >= clusterCap(rig)) {
          skips.set(bead.id, `cluster ${cluster}: ${clusterLive} live runs`)
          continue
        }
        // claude-factory-wnm: a `factory:<name>` label on the bead picks a different factory to
        // compile this run from, in place of the rig's own `rig.factory`. A `station:<name>` label
        // picks where in it to start. A bad label must defer only this bead, never throw:
        // - two factory: or two station: labels on the bead (claude-factory-wnm.11)
        // - an unknown factory name, or a factory file that fails to load (claude-factory-wnm.14)
        // - a station the named factory lacks (claude-factory-wnm.15)
        // A throw here hits the rig-level catch below, which skips every later candidate too.
        const deferCandidate = (msg: string) => {
          skips.set(bead.id, `deferred: ${msg}`)
          errors.push({ id: bead.id, error: msg })
          try {
            b.defer(bead.id, msg)
          } catch (err) {
            errors.push({ id: bead.id, error: (err as Error).message })
          }
        }
        let named: string | undefined
        let at: string | undefined
        try {
          named = factoryOf(bead)
          at = stationOf(bead)
        } catch (err) {
          deferCandidate((err as Error).message)
          continue
        }
        let spec = rig.factory
        let name = preview.name
        let nodes = preview.nodes
        if (named) {
          const source = namedFactorySource(named, rig.repo)
          if (!source) {
            deferCandidate(`no factory ${named}`)
            continue
          }
          let loaded: Factory
          try {
            loaded = await loadFactory(source)
          } catch (err) {
            deferCandidate(`factory ${named} failed to load: ${(err as Error).message}`)
            continue
          }
          name = loaded.name
          nodes = loaded.nodes
          spec = source
        }
        // a station the chosen factory lacks would otherwise start the run quietly at its own
        // first station (`def.start`, below), with no sign anywhere that the label was wrong
        if (at && !Object.hasOwn(nodes, at)) {
          deferCandidate(`station ${at} not in factory ${name}`)
          continue
        }
        const runBranches = runIds()
          .filter(id => {
            try {
              return loadRun(id).bead === bead.id
            } catch {
              return false
            }
          })
          .slice(0, 3)
          .map(id => `factory/${id}`)
        // claude-factory-6as.9: skip the gh calls outright once this pass already proved gh broken;
        // the first candidate's row in precheck.jsonl already covers the fail-open for the rest.
        const { skip, error } = ghFailed
          ? { skip: false, error: undefined }
          : await precheckSkip(rig, bead, b, runBranches, spawnGh)
        if (error) {
          errors.push({ id: bead.id, error })
          ghFailed = true
        }
        if (skip) {
          skips.set(bead.id, 'pre-check: already done')
          continue
        }
        let run, def
        try {
          ;({ run, def } = await createTracked(
            spec,
            name,
            rig.repo,
            goalOf(bead),
            bead.id,
            undefined,
            undefined,
            shipBranchOf(bead),
          ))
        } catch (err) {
          if (/already claimed/.test((err as Error).message)) {
            skips.set(bead.id, 'claimed elsewhere')
            continue // lost the race to another worker
          }
          throw err
        }
        // claude-factory-wnm.13: this run is the one the pre-check's `requeued_from` exemption
        // (above) was for. Clear it now, so a later, unrelated pickup of this bead is not exempt.
        if (bead.metadata?.requeued_from) {
          try {
            b.unsetMetadata(bead.id, 'requeued_from', 'requeued_at')
          } catch (err) {
            errors.push({ id: bead.id, error: (err as Error).message })
          }
        }
        if (at && at !== def.start && Object.hasOwn(def.nodes, at)) post(run.id, { type: 'GOTO', node: at })
        busy.push(rig.name)
        liveByCluster.set(cluster, clusterLive + 1)
        started.add(bead.id)
      }
    } catch (err) {
      rigError = (err as Error).message
      errors.push({ id: `rig:${rig.name}`, error: rigError })
    } finally {
      for (const id of readyIds)
        if (!started.has(id))
          errors.push({
            id,
            rig: rig.name,
            skip:
              skips.get(id) ?? (rigError ? `rig error: ${clip(rigError, 200)}` : roomText || 'not started'),
          })
    }
  }
  writeJson(sweepGuardFile(), pruneGuardState(guardState, openIds))
  // Every filing bead keeps its verdict. A rig not read this pass keeps its marks: no age prune.
  writeJson(filingGuardFile(), pruneGuardState(filingState, openIds))
  if (Object.keys(autoHistory).length) writeJson(autoQueueFile(), autoHistory)
  writeJson(dispatchFile(), errors)
}

// --- the pm's plan (claude-factory-dun): `factory plan facts|set|show` ---
// The pm subagent has no Bash. `factory plan facts` gathers what the pm needs: each rig's
// work and its findings. It writes this to `plan-facts.json` and prints it too.
// `plan set` checks this file's age later.
//
// `factory plan set <file>` reads the pm's answer.
// It builds `plan.json` with src/plan.ts's pure functions.
// It files each finding and proposal as a bead.
// The pm itself never calls `bd`.
const planFactsFile = () => join(HOME, 'plan-facts.json')
const planFile = () => join(HOME, 'plan.json')
const pmLogFile = () => join(HOME, 'pm-log.jsonl')

/** Finds the newest `pm-log.jsonl` entry that has an `error` field (claude-factory-dun.31).
 * Returns `undefined` with no file, no entries, or no entry with an error. `pm-log.jsonl` holds
 * one JSON object per line, oldest first (the mod's own `appendPmLog`). So the newest entry is
 * the last line. A bad line must not hide another line's error. This function skips a line it
 * cannot parse, instead of throwing. */
function lastPmError(): { at: number; error: string } | undefined {
  if (!existsSync(pmLogFile())) return undefined
  const lines = readFileSync(pmLogFile(), 'utf8').split('\n').filter(Boolean)
  for (const line of lines.reverse()) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const e = entry as { at?: unknown; error?: unknown }
    if (typeof e.at === 'number' && typeof e.error === 'string') return { at: e.at, error: e.error }
  }
  return undefined
}

/** one rig's facts for the pm: its ready candidates, open epics, recently closed work, the ids
 * a live run there owns now, and the code findings (src/plan.ts's `findings`) already computed
 * once here, so `plan set` never needs the raw bead dump (claude-factory-dun.2). */
export type RigFacts = {
  goal?: string
  maxRuns?: number
  busy: number
  candidates: { id: string; title: string; priority?: number; issue_type?: string }[]
  epics: {
    id: string
    title: string
    priority?: number
    done: number
    total: number
    lastProgressHoursAgo: number
  }[]
  closedRecently: { id: string; title: string; priority?: number }[]
  liveBeadIds: string[]
  findings: plan.Finding[]
  error?: string
}

const emptyRigFacts = (rig: Pick<Rig, 'goal' | 'maxRuns'>, busy: number, error?: string): RigFacts => ({
  goal: rig.goal,
  maxRuns: rig.maxRuns,
  busy,
  candidates: [],
  epics: [],
  closedRecently: [],
  liveBeadIds: [],
  findings: [],
  ...(error && { error }),
})

/** one rig's facts, from its own `bd ready`/`bd list --all` (claude-factory-dun.2) */
function rigFacts(
  rig: Rig,
  every: Bead[],
  ready: Bead[],
  linked: Set<string>,
  busy: number,
  now: number,
  linear: { ids: Set<string>; rigs: Set<string> },
  churn: Record<string, number> = {},
): RigFacts {
  // every open child, read from `every` (already in hand): no `bd children` subprocess call
  // per candidate (claude-factory-dun.12).
  const childrenOf = (id: string) => every.filter(x => parentOf(x) === id)
  const openChildrenOf = (id: string) => childrenOf(id).filter(x => x.status !== 'closed')
  // a rig with an open Linear baseline diff is held back whole, the same as dispatch() (claude-factory-b6c.16).
  // an id still owed an unstripped-label check is held back on its own (claude-factory-dun.13).
  const candidates = linear.rigs.has(rig.name)
    ? []
    : dispatchable(ready, linked, Infinity, byId(every))
        .filter(x => !isOwned(x) && !openChildrenOf(x.id).length && !linear.ids.has(x.id))
        .slice(0, 40)
        .map(c => ({
          id: c.id,
          title: plan.sanitize(c.title),
          priority: c.priority,
          issue_type: c.issue_type,
        }))
  const isClosed = (x: Bead) => x.status === 'closed'
  const tsOf = (iso?: string) => {
    if (!iso) return undefined
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? t : undefined
  }
  // a deferred epic is a person's own decision: the pm must not flag it as a gap (claude-factory-dun.14)
  const epics = every
    .filter(e => !isClosed(e) && e.status !== 'deferred' && childrenOf(e.id).length > 0)
    .map(e => {
      const kids = childrenOf(e.id)
      const progress = kids.flatMap(k =>
        [tsOf(k.closed_at), tsOf(k.started_at)].filter((t): t is number => t !== undefined),
      )
      const lastProgress = progress.length ? Math.max(...progress) : (tsOf(e.created_at) ?? now)
      return {
        id: e.id,
        title: plan.sanitize(e.title),
        priority: e.priority,
        done: kids.filter(isClosed).length,
        total: kids.length,
        lastProgressHoursAgo: Math.round((now - lastProgress) / 3_600_000),
      }
    })
  const dayAgo = now - 24 * 3_600_000
  const closedRecently = every
    .filter(x => isClosed(x) && (tsOf(x.closed_at) ?? -Infinity) >= dayAgo)
    .map(x => ({ id: x.id, title: plan.sanitize(x.title), priority: x.priority }))
  const liveBeadIds = every.filter(x => linked.has(x.id)).map(x => x.id)
  const found = plan.findings(rig.name, rig.goal, every, liveBeadIds, now, 24, churn)
  return {
    goal: rig.goal,
    maxRuns: rig.maxRuns,
    busy,
    candidates,
    epics,
    closedRecently,
    liveBeadIds,
    findings: found,
  }
}

/** Keeps the printed facts under `maxBytes` bytes. This is the pm's prompt budget.
 * This function drops fields in steps, across every rig, until the result fits.
 * First, it drops `closedRecently`.
 * Next, it cuts `epics` to 5 items.
 * Next, it cuts `candidates` to 20 items.
 *
 * These three steps are not a hard guarantee on their own. An oversized title can still blow the
 * budget at 20 candidates. A title can be longer than the `rigFacts` boundary's own clip, or this
 * function can get one directly. Proof: 20 candidates of 8000 characters each gave 160566 bytes
 * against a 65536-byte budget (claude-factory-dun.25).
 *
 * So this function also cuts `findings` to 10 items and `liveBeadIds` to 20 items. Then it
 * shrinks `candidates` and `epics` together, one step at a time, down to zero if nothing else
 * fits. The result is always at most `maxBytes` bytes. The one exception: the empty shape itself
 * (every rig with no candidates, epics, findings or liveBeadIds) does not fit. Only a very large
 * number of rigs, or an oversized `goal` string, can cause that. */
export function clipFactsJson(facts: Record<string, RigFacts>, maxBytes = 64 * 1024): string {
  const clone: Record<string, RigFacts> = JSON.parse(JSON.stringify(facts))
  const fits = () => Buffer.byteLength(JSON.stringify(clone)) <= maxBytes
  if (fits()) return JSON.stringify(clone)
  for (const r of Object.values(clone)) r.closedRecently = []
  if (fits()) return JSON.stringify(clone)
  for (const r of Object.values(clone)) r.epics = r.epics.slice(0, 5)
  if (fits()) return JSON.stringify(clone)
  for (const r of Object.values(clone)) r.candidates = r.candidates.slice(0, 20)
  if (fits()) return JSON.stringify(clone)
  for (const r of Object.values(clone)) {
    r.findings = r.findings.slice(0, 10)
    r.liveBeadIds = r.liveBeadIds.slice(0, 20)
  }
  if (fits()) return JSON.stringify(clone)
  for (let cap = 10; cap >= 0; cap--) {
    for (const r of Object.values(clone)) {
      r.candidates = r.candidates.slice(0, cap)
      r.epics = r.epics.slice(0, cap)
    }
    if (fits()) return JSON.stringify(clone)
  }
  return JSON.stringify(clone)
}

/** Counts the merged PRs for each file in the last 48 hours on origin/main.
 * Any failure gives {}: the rig still reports. */
export function mergedFileChurn(repo: string): Record<string, number> {
  try {
    const p = Bun.spawnSync(
      [
        'git',
        '-C',
        repo,
        'log',
        '--merges',
        '--first-parent',
        `--since=${plan.CHURN_SINCE}`,
        '--diff-merges=first-parent',
        '--name-only',
        '--format=@%H',
        'origin/main',
      ],
      { timeout: 10_000 },
    )
    return p.exitCode === 0 ? plan.churnCounts(p.stdout.toString()) : {}
  } catch {
    return {}
  }
}

/** every rig's facts, gathered once: a rig whose own bd call fails still reports (with `error`), so
 * one rig's trouble never stops the others from reaching the pm. */
async function gatherPlanFacts(): Promise<Record<string, RigFacts>> {
  const now = Date.now()
  const { busy: busyList } = await busyRigs()
  const busyCount = new Map<string, number>()
  for (const name of busyList) if (name) busyCount.set(name, (busyCount.get(name) ?? 0) + 1)
  const linked = liveBeadIdSet()
  const linear = linearExcluded()
  const out: Record<string, RigFacts> = {}
  for (const rig of rigs()) {
    const busy = busyCount.get(rig.name) ?? 0
    if (!hasBeads(rig.repo)) {
      out[rig.name] = emptyRigFacts(rig, busy)
      continue
    }
    try {
      const b = beads(rig.repo, 'factory')
      out[rig.name] = rigFacts(
        rig,
        b.every(),
        b.ready(),
        linked,
        busy,
        now,
        linear,
        mergedFileChurn(rig.repo),
      )
    } catch (err) {
      out[rig.name] = emptyRigFacts(rig, busy, (err as Error).message)
    }
  }
  return out
}

async function planFactsCmd() {
  const facts = await gatherPlanFacts()
  writeJson(planFactsFile(), facts)
  console.log(clipFactsJson(facts))
}

/**
 * `factory advisories file <path>` (claude-factory-yex): the advisories sweep's only way to file beads.
 * It refuses, with no bd call, unless BEADS_ACTOR is an advisories sweep run's actor.
 * Each bead it files is then a sweep-filed bead, so the flood guard (`sweepGuard`) applies.
 * It files critical beads first. A bad input file or a bd failure stops the pass.
 * The command files nothing without a dedupe answer.
 */
function advisoriesFileCmd(path?: string) {
  if (!path) fail('usage: factory advisories file <path>')
  const actor = process.env.BEADS_ACTOR ?? ''
  if (sweepFiler({ created_by: actor }) !== 'advisories')
    fail('factory advisories file runs only in an advisories sweep run (BEADS_ACTOR)')
  if (!existsSync(path!)) fail(`no file ${path}`)
  const b = beads(process.cwd(), actor)
  try {
    const input = parseAdvisoryInput(JSON.parse(readFileSync(path!, 'utf8')))
    const p = planAdvisories(input, (field, value) => b.hasMetadata(field, value))
    for (const f of p.files) {
      b.fileWith(f.title, f.body, {
        labels: f.labels,
        priority: f.priority,
        metadata: Object.fromEntries(f.keys.map(k => [k, '1'])),
      })
      console.log(`${f.queued ? 'queued' : 'held'} ${f.keys[0]}`)
    }
    if (p.ownerStep) {
      b.fileWith(p.ownerStep.title, p.ownerStep.body, {
        labels: ['human'],
        priority: 2,
        metadata: { advisory_owner_step: input.repo },
      })
      console.log(`owner step ${input.repo}`)
    }
    if (p.digestRows.length) {
      const body = `Medium and low advisories for ${input.repo}:\n${p.digestRows.map(r => `- ${r}`).join('\n')}`
      const open = b.findOpenByMetadata('advisory_digest', input.repo)
      if (open) b.setDescription(open.id, body)
      else
        b.fileWith(`Advisories digest: ${input.repo}`, body, {
          labels: [],
          priority: 3,
          metadata: { advisory_digest: input.repo },
        })
      console.log(`digest ${input.repo} ${p.digestRows.length} rows`)
    }
    const queued = p.files.filter(f => f.queued).length
    console.log(
      `filed ${p.files.length} (queued ${queued}, held ${p.files.length - queued}, digest ${p.digestRows.length} rows, owner step ${p.ownerStep ? 'yes' : 'no'})`,
    )
  } catch (err) {
    fail(`advisories file: ${(err as Error).message}`)
  }
}

/** the pm's raw answer, before `plan set` checks each field by hand: `{id, why}` per rig and
 * `{rig, bead?, change, why}` proposals, exactly as claude-factory-dun's inbox spec shapes it. */
type PmAnswer = {
  rigs?: Record<string, { id?: unknown; why?: unknown }[]>
  proposals?: { rig?: unknown; bead?: unknown; change?: unknown; why?: unknown }[]
}

/**
 * `factory plan set <file>` command (claude-factory-dun.2).
 * It reads the pm's answer. It builds `plan.json`. It files each proposal as a bead. It does not file findings: they stay in
 * `plan.json`, and the board and `plan show` list them.
 *
 * It refuses, and writes nothing, in each of these cases:
 * - a worker calls it (`FACTORY_FROM` is set)
 * - `plan-facts.json` is missing, too old (`>= plan.PLAN_FRESH_MS`), or not valid JSON
 * - `<file>` is missing or not valid JSON
 *
 * The pm never runs `bd`. This function turns the pm's answer into bd writes.
 * For each proposal, it checks `hasMetadata('pm_finding', key)` first.
 * A key already filed is never filed again, even under a bead that later closed.
 * It files at most 3 new beads for each rig.
 */
function planSetCmd(answerPath?: string) {
  if (process.env.FACTORY_FROM) fail('a worker cannot set the plan: only the pm, through its own turn, may')
  if (!answerPath) fail('usage: factory plan set <file>')
  if (!existsSync(planFactsFile())) fail('no plan-facts.json yet: run `factory plan facts` first')
  const factsAge = Date.now() - statSync(planFactsFile()).mtimeMs
  if (factsAge >= plan.PLAN_FRESH_MS)
    fail(
      `plan-facts.json is ${Math.round(factsAge / 60_000)}m old (stale at ${plan.PLAN_FRESH_MS / 60_000}m): run \`factory plan facts\` again`,
    )
  let facts: Record<string, RigFacts>
  try {
    facts = JSON.parse(readFileSync(planFactsFile(), 'utf8'))
  } catch (err) {
    fail(`plan-facts.json: ${(err as Error).message}`)
  }
  if (!existsSync(answerPath!)) fail(`no file ${answerPath}`)
  let answer: PmAnswer
  try {
    answer = JSON.parse(readFileSync(answerPath!, 'utf8'))
  } catch (err) {
    fail(`${answerPath}: ${(err as Error).message}`)
  }

  const now = Date.now()
  const rigNames = new Set(Object.keys(facts!))
  const rigsPlan: Record<string, plan.RigPlan> = {}
  for (const [name, rf] of Object.entries(facts!)) {
    const rawAnswer = Array.isArray(answer!.rigs?.[name]) ? answer!.rigs![name]! : []
    const cleanAnswer: plan.AnswerItem[] = rawAnswer
      .filter((a): a is { id: string; why?: unknown } => !!a && typeof a.id === 'string')
      .map(a => ({ id: a.id, why: typeof a.why === 'string' ? a.why : undefined }))
    const candidates: Bead[] = rf.candidates.map(c => ({
      id: c.id,
      title: c.title,
      priority: c.priority,
      issue_type: c.issue_type,
    }))
    const items = plan.rankPlan(cleanAnswer, candidates)
    const found = [...rf.findings]
    if (rf.goal && items.length === 0) found.push(plan.goalNoPlanFinding(name, rf.goal))
    rigsPlan[name] = { items, findings: found }
  }
  const churnProposals = plan.churnProposals(Object.values(facts!).flatMap(rf => rf.findings))
  const cleanProposals: plan.Proposal[] = (Array.isArray(answer!.proposals) ? answer!.proposals : [])
    .filter(
      (p): p is { rig: string; bead?: unknown; change: string; why: string } =>
        !!p &&
        typeof p.rig === 'string' &&
        rigNames.has(p.rig) &&
        typeof p.change === 'string' &&
        typeof p.why === 'string',
    )
    .map(p => ({
      rig: p.rig,
      ...(typeof p.bead === 'string' && p.bead ? { bead: plan.sanitize(p.bead, 40) } : {}),
      change: plan.sanitize(p.change, 300),
      why: plan.sanitize(p.why, 300),
    }))

  // every validation above must pass before anything is written: a refusal never touches plan.json
  const allProposals = [...cleanProposals, ...churnProposals.filter(p => rigNames.has(p.rig))]
  writeJson(planFile(), { at: now, rigs: rigsPlan, proposals: allProposals } satisfies plan.Plan)

  let filedTotal = 0
  for (const name of rigNames) {
    const rig = rigs().find(r => r.name === name)
    if (!rig || !hasBeads(rig.repo)) continue
    const b = beads(rig.repo, 'factory')
    const toFile = allProposals
      .filter(p => p.rig === name)
      .map(p => ({
        title: `pm proposal: ${clip(p.change, 80)}`,
        desc: `${p.why}${p.bead ? ` (${p.bead})` : ''}`,
        key: plan.proposalKey(name, p),
        human: true,
      }))
    let filed = 0
    for (const item of toFile) {
      if (filed >= 3) break
      try {
        if (b.hasMetadata('pm_finding', item.key)) continue
        b.fileFinding(item.title, item.desc, item.key, { human: item.human })
        filed++
      } catch (err) {
        console.error(`factory plan set: ${name}: could not file ${item.key}: ${(err as Error).message}`)
      }
    }
    filedTotal += filed
  }
  const itemsTotal = Object.values(rigsPlan).reduce((n, rp) => n + rp.items.length, 0)
  const findingsTotal = Object.values(rigsPlan).reduce((n, rp) => n + rp.findings.length, 0)
  console.log(
    JSON.stringify({
      rigs: Object.keys(rigsPlan).length,
      items: itemsTotal,
      findings: findingsTotal,
      filed: filedTotal,
    }),
  )
}

/** `factory plan` (or `plan show`): the plan as text, for a person or `/factory plan` */
function planShowText(): string {
  if (!existsSync(planFile())) {
    let text = 'no plan.json yet: `factory plan facts` then `factory plan set <file>`, or wait for the pm'
    const lastError = lastPmError()
    if (lastError)
      text += `\nlast pm attempt ${new Date(lastError.at).toISOString()}: ${plan.sanitize(lastError.error)}`
    return text
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(planFile(), 'utf8'))
  } catch (err) {
    return `plan.json: ${(err as Error).message}`
  }
  if (!isValidPlanShape(raw)) return 'plan.json: missing or malformed rigs/proposals'
  const p: plan.Plan = raw
  const now = Date.now()
  const age = Math.round((now - p.at) / 60_000)
  const lines = [`plan ${age}m ago${plan.isFresh(p, now) ? '' : ' (stale)'}`]
  for (const [name, rp] of Object.entries(p.rigs)) {
    lines.push(`${name}:`)
    for (const it of rp.items.slice(0, 5)) lines.push(`  P${it.priority} ${it.id} ${it.title} -- ${it.why}`)
    for (const f of rp.findings) lines.push(`  ! ${f.text}`)
  }
  if (p.proposals.length) {
    lines.push('proposals:')
    for (const pr of p.proposals) lines.push(`  ${pr.rig}: ${pr.change} -- ${pr.why}`)
  }
  return lines.join('\n')
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

/** the queued bead whose PR this is: ship owns it, so no rework run may start on it (claude-factory-rtuw) */
export const queuedOwner = (pr: Pick<LabeledPr, 'url' | 'headRefName'>, queue: Bead[]) =>
  queue.find(b => b.metadata?.ship_branch === pr.headRefName || (!!pr.url && b.metadata?.ship_pr === pr.url))

/** the label mail to a ship station: only the station parked on this very PR wakes at once; any other holds it */
export const labelMail = (
  s: { c: Parameters<typeof isParkedOn>[0]; node: string },
  url: string,
  text: string,
) => ({
  type: 'MAIL' as const,
  from: 'factory' as const,
  to: s.node,
  text,
  ...(isParkedOn(s.c, s.node, url) && { wake: true as const }),
})

/** a live run owns the PR that got a rework label: remove the label, mail the station, comment on the PR */
export function reworkOwned(
  pr: LabeledPr,
  owner: { id: string; node: string; c: Parameters<typeof isParkedOn>[0] },
  io: {
    unlabel: (pr: LabeledPr, labels: string[]) => unknown
    comment: (pr: LabeledPr, body: string) => unknown
    post: (runId: string, ev: ReturnType<typeof labelMail>) => unknown
  },
) {
  const text = `[factory] ${pr.url} was ${asksOf(pr)}. Do it as part of this station's work, or say on the pull request why not.`
  // the label first: if it cannot come off, the next pass would mail (or start a run) again, every pass
  io.unlabel(pr, reworkLabels(pr))
  io.post(owner.id, labelMail(owner, pr.url, text))
  io.comment(pr, `Handed to claude-factory run \`${owner.id}\` (${owner.node}), which owns this.`)
}

/** a queued PR closed unmerged leaves the queue (label off, bead deferred): the ship run would name it next again */
export function unshipClosed(url: string, queue: Bead[], b: Pick<ReturnType<typeof beads>, 'unship'>) {
  const owner = queuedOwner({ url, headRefName: '' }, queue)
  if (owner) b.unship(owner.id, `${url} was closed unmerged`)
  return owner
}

/** the rig's pull requests of any state, newest 200; none on a forge without `gh` */
async function rigPrs(repo: string): Promise<PrFact[]> {
  const ref = rigRef(repo)
  if (!ref) return []
  const rows = await githubPulls(spawnGh, ref.slug, repo, { state: 'all', pages: 2 })
  if (!rows) throw new Error('gh api pulls failed')
  return githubRows(rows) as PrFact[]
}

type LiveBead = { blocked: boolean; why?: string; since?: number }
/** each live run's bead: whether the run waits on the owner, what it asks, and since when */
async function liveByBead() {
  const out = new Map<string, LiveBead>()
  for (const id of startedRunIds()) {
    const { run, value, c } = current(id)
    if (!run.bead || ['done', 'aborted'].includes(where(value)[0])) continue
    const r = row(run, await loadFactory(run.factory), value, c)
    out.set(run.bead, {
      blocked: !!holdOf(r),
      why: r.gate?.question ?? r.last?.summary,
      since: r.last?.at ?? r.since,
    })
  }
  return out
}

// FACTORY_REPAIRS_LOG lets a test write elsewhere: the import sets HOME once, and bun shares the module cache
const repairsFile = () => process.env.FACTORY_REPAIRS_LOG ?? join(HOME, 'repairs.jsonl')

/**
 * Closes or defers beads whose work is plainly done or dead, and releases claims that no live run
 * holds (`repairs` in src/repairs.ts decides).
 * It makes at most REPAIR_CAP changes in a rig in one pass. Each change goes to repairs.jsonl,
 * which `factory digest` reads. The beads pass calls it.
 */
const isFresh = (stamp: string, ms: number) => existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < ms

/**
 * Close each ancestor of `id` whose children are all closed, nearest first, after the factory
 * closed `id`. It never throws: a throw out of `track` would leave the run unsettled.
 * The reason text must stay "every child is closed", because the reship repair matches on it.
 */
export function closeParents(
  b: ReturnType<typeof beads>,
  repo: string,
  id: string,
  by: string,
  closed = new Set([id]),
) {
  try {
    for (const p of closableParents(b.every(), closed, id)) {
      if (!b.close(p, 'every child is closed')) return
      closed.add(p)
      b.comment(p, `${by} closed ${id}; every child of this bead is closed, so the factory closed it`)
      const at = new Date().toISOString()
      const row = {
        at,
        rig: rigOf(repo)?.name,
        kind: 'close',
        id: p,
        reason: 'every child is closed',
        by,
        child: id,
      }
      appendFileSync(repairsFile(), JSON.stringify(row) + '\n')
      console.log(`${at} close parent ${p} (${by} closed ${id})`)
    }
  } catch (err) {
    console.error(`${new Date().toISOString()} close parents of ${id}: ${(err as Error).message}`)
  }
}

async function repairPass() {
  if (halted()) return
  const live = new Set((await liveByBead()).keys())
  for (const rig of rigs()) {
    try {
      if (!hasBeads(rig.repo)) continue
      const b = beads(rig.repo, 'factory')
      const todo = repairs(rig.name, b.every(), await rigPrs(rig.repo), live, Date.now()).slice(0, REPAIR_CAP)
      const closed = new Set<string>()
      for (const r of todo) {
        const done =
          r.kind === 'close'
            ? b.close(r.id, r.reason)
            : r.kind === 'release'
              ? b.releaseStale(r.id, r.reason)
              : r.kind === 'reship'
                ? b.reship(r.id, r.reason)
                : r.kind === 'unship'
                  ? b.unship(r.id, r.reason)
                  : false
        if (!done) continue
        const at = new Date().toISOString()
        appendFileSync(repairsFile(), JSON.stringify({ at, rig: rig.name, ...r }) + '\n')
        console.log(`${at} repair ${rig.name} ${r.kind} ${r.id}: ${r.reason}`)
        if (r.kind === 'close') {
          closed.add(r.id)
          closeParents(b, rig.repo, r.id, 'the repair pass', closed)
        }
      }
    } catch (err) {
      console.error(`${new Date().toISOString()} repairs for ${rig.name}: ${(err as Error).message}`)
    }
  }
}

/** `factory digest`: per rig, the beads by state, the owner queue and the PRs to merge. It only reads. */
async function digest() {
  const live = await liveByBead()
  const out: DigestRig[] = []
  for (const rig of rigs()) {
    try {
      if (!hasBeads(rig.repo)) continue
      const b = beads(rig.repo, 'factory')
      const o = originRef(rig.repo)
      out.push({
        name: rig.name,
        slug: o?.forge === 'github' ? `${o.owner}/${o.repo}` : undefined,
        beads: b.every(),
        ctx: { live, prs: await rigPrs(rig.repo) },
        queue: b.shipQueue(),
      })
    } catch (err) {
      console.error(`digest for ${rig.name}: ${(err as Error).message}`)
    }
  }
  const lines = existsSync(repairsFile()) ? readFileSync(repairsFile(), 'utf8').trim().split('\n') : []
  const recent = lines.slice(-10).flatMap(l => {
    try {
      return [JSON.parse(l) as RepairLog]
    } catch {
      return [] // a torn line
    }
  })
  console.log(digestText(out, recent, Date.now()))
}

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
  const { busy, held } = await busyRigs()
  const live = startedRunIds()
    .map(id => ({ id, ...current(id) }))
    .filter(r => !['done', 'aborted'].includes(where(r.value)[0]))
    .map(r => ({ id: r.id, node: where(r.value)[0], log: r.c.log, c: r.c }))
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
        : (() => {
            const ref = rigRef(rig.repo)
            const slug = () => {
              if (!ref) throw new Error('not a GitHub repo')
              return ref.slug
            }
            return {
              // REST, not `gh pr list --search`: the path names the owner, so the AX gateway picks the owner's key
              list: async (): Promise<LabeledPr[]> => {
                const rows = await githubPulls(spawnGh, slug(), rig.repo, { state: 'open', pages: 10 })
                if (!rows) throw new Error('gh api pulls failed')
                return (githubRows(rows) as LabeledPr[]).filter(pr => labelAction(pr) !== undefined)
              },
              comment: (pr: LabeledPr, body: string) => gh(...githubCommentArgv(slug(), pr.number, body)),
              unlabel: (pr: LabeledPr, labels: string[]) => {
                for (const label of labels) gh(...githubUnlabelArgv(slug(), pr.number, label))
              },
              close: (pr: LabeledPr, body: string) => {
                gh(...githubCommentArgv(slug(), pr.number, body))
                gh(...githubCloseArgv(slug(), pr.number))
              },
            }
          })()
    try {
      const labeled = await forge.list()
      const shipped = labeled.some(pr => ['rework', 'close'].includes(labelAction(pr)!))
        ? beads(rig.repo, 'factory').shipQueue()
        : []
      for (const pr of labeled) {
        const action = labelAction(pr)
        const queuedBead = action === 'rework' ? queuedOwner(pr, shipped) : undefined
        // a queued PR closed unmerged leaves the queue: the ship run would loop on it as the next PR
        if (action === 'close') {
          const closed = queuedOwner(pr, shipped)
          if (closed) beads(rig.repo, 'factory').unship(closed.id, `${pr.url} was closed unmerged`)
        }
        if (queuedBead) {
          // the rig's ship run owns a queued PR: it hears of the label, and no rework run starts
          const text = `[factory] ${pr.url} (${queuedBead.id}) was ${asksOf(pr)}. Treat it as changes needed: follow your rework steps.`
          forge.unlabel(pr, reworkLabels(pr))
          const ships = liveShipRuns().filter(s => s.run.repo === rig.repo)
          // only a station that waits on this very PR wakes at once; any other holds the mail
          for (const s of ships) post(s.run.id, labelMail(s, pr.url, text))
          // no live ship run to hear it: the bead keeps the ask, and the next ship run reads it
          if (!ships.length) beads(rig.repo, 'factory').comment(queuedBead.id, text)
          console.log(`${new Date().toISOString()} rework ${pr.url} → ship queue (${queuedBead.id})`)
          continue
        }
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
          const owner = live.find(r => r.id === runId)!
          reworkOwned(pr, owner, { ...forge, post })
          console.log(`${new Date().toISOString()} rework ${pr.url} → its run ${runId} at ${owner.node}`)
        } else if (action === 'rework' && room(rig, busy, undefined, held) > 0) {
          forge.unlabel(pr, reworkLabels(pr))
          const { run } = await createTracked('rework', 'rework', rig.repo, reworkGoal(pr))
          busy.push(rig.name)
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
 * a station parked on pull requests (its blocked report, or an awaitsPr arrival, links them) is watched
 * once a minute. It wakes by mail for a real change after it parked: a new head commit, a merge, a close,
 * or a review or comment by a person. Bot comments, CI statuses and labels change only `updatedAt` and
 * wake nothing (claude-factory-5wav). Two cases need no worker: a close with no merge routes the station's
 * `hold` outcome, and a person's change request routes `changes`. Near the park's timer, a park whose pull
 * requests are all open and unchanged parks again (REPARK). Every run parked on the same pull request
 * shares one gh/glab view this pass (claude-factory-960), so a popular pull request costs one call.
 * `watch-seen.json` keeps the head commits at the first view after each park.
 */
async function watchPass() {
  const release = hold('watch.lock')
  if (!release) return
  const stamp = join(HOME, 'watch.stamp')
  writeFileSync(stamp, '')
  const cache = new Map<string, WatchedPr | null>()
  let errors = 0
  const woke: { run: string; node: string; url: string; state: string; at: number }[] = []
  const routed: { run: string; node: string; url: string; outcome: string; at: number }[] = []
  const reparked: { run: string; node: string; wakeAt: number }[] = []
  const seenFile = join(HOME, 'watch-seen.json')
  let store: Record<string, Seen> = {}
  const live = new Set<string>()
  try {
    try {
      if (existsSync(seenFile)) store = readJson(seenFile)
    } catch {
      // an unreadable baseline file starts empty; the pass writes a new one
    }
    // cwd only sets where gh/glab spawns from; the first parked run naming a URL this pass picks it,
    // and every later run that names the same URL reuses the one answer, with no second call
    const viewGh = async (url: string, cwd: string): Promise<WatchedPr | null> => {
      if (cache.has(url)) return cache.get(url)!
      let v: WatchedPr | null = null
      try {
        v = await githubWatchView(spawnGh, url, cwd)
      } catch {
        // a missing binary or unreadable output counts as a failed view
      }
      if (!v) errors++
      cache.set(url, v)
      return v
    }
    const viewMr = async (url: string, cwd: string, host?: string): Promise<WatchedPr | null> => {
      if (cache.has(url)) return cache.get(url)!
      let r: Awaited<ReturnType<ReturnType<typeof gitlabForge>['view']>> | null = null
      let notes: Awaited<ReturnType<typeof gitlabWatchNotes>> = null
      try {
        r = await gitlabForge(spawnGlab).view(url, cwd, host)
        notes = 'viewed' in r ? await gitlabWatchNotes(spawnGlab, url, cwd, host) : null
      } catch {
        // a missing glab binary counts as a failed view
      }
      const v: WatchedPr | null =
        r && 'viewed' in r && notes
          ? {
              url,
              state: r.viewed.state,
              updatedAt: r.viewed.updatedAt,
              headRefOid: r.viewed.headSha,
              mergedAt: r.viewed.mergedAt,
              closedAt: r.viewed.closedAt,
              notes,
              changesRequested: r.viewed.reviewDecision === 'CHANGES_REQUESTED',
            }
          : null
      if (!v) errors++
      cache.set(url, v)
      return v
    }
    for (const id of runIds()) {
      try {
        const { run, value, c } = current(id)
        const [node, sub] = where(value)
        if (sub !== 'waiting' || !isParked(c, node)) continue
        const parked = c.log.at(-1)!
        const urls = prsIn(parked.summary)
        // glab sends GITLAB_TOKEN to the URL's host, so only an MR on the rig's forge host is viewed
        const forgeHost = originRef(run.repo)?.host
        const mrUrls = mrsIn(parked.summary).filter(url => {
          if (onHost(url, forgeHost)) return true
          console.error(`watch: skip merge request on host ${url.split('/')[2]}: not the rig forge host`)
          return false
        })
        if (!urls.length && !mrUrls.length) continue
        const views = await Promise.all([
          ...urls.map(url => viewGh(url, run.repo)),
          ...mrUrls.map(url => viewMr(url, run.repo, forgeHost)),
        ])
        const prs = views.filter(v => v !== null)
        const failed = prs.length < views.length
        const def = await loadFactory(run.factory)
        // the plain park this report would have had, had it linked nothing
        const plainMin = parkDelayMin({ ...c, log: c.log.slice(0, -1) }, node, def.nodes[node]?.parkMin ?? 60)
        const key = `${id}:${parked.at}`
        live.add(key)
        const seen = store[key]
        if (!seen)
          store[key] = {
            heads: Object.fromEntries(prs.flatMap(p => (p.headRefOid ? [[p.url, p.headRefOid]] : []))),
            changes: Object.fromEntries(prs.map(p => [p.url, !!p.changesRequested])),
            drafts: Object.fromEntries(
              prs.flatMap(p => (p.isDraft === undefined ? [] : [[p.url, p.isDraft]])),
            ),
            decisions: Object.fromEntries(
              prs.flatMap(p => (p.reviewDecision === undefined ? [] : [[p.url, p.reviewDecision]])),
            ),
          }
        else
          // a URL whose first view failed gets its baseline at its first good view
          for (const p of prs) {
            if (p.headRefOid && !(p.url in seen.heads)) seen.heads[p.url] = p.headRefOid
            if (seen.drafts && p.isDraft !== undefined && !(p.url in seen.drafts))
              seen.drafts[p.url] = p.isDraft
            if (seen.decisions && p.reviewDecision !== undefined && !(p.url in seen.decisions))
              seen.decisions[p.url] = p.reviewDecision
            if (seen.changes && !(p.url in seen.changes)) seen.changes[p.url] = !!p.changesRequested
          }
        const now = Date.now()
        const d = watchDecide({
          prs,
          failed,
          parkedAt: parked.at,
          now,
          wakeAt: c.wakeAt,
          plainMin,
          isPreLaunch: isPrWait(parked),
          seen,
          canHold: !!def.nodes[node]?.next.hold,
          canChange: !!def.nodes[node]?.next.changes,
          held: !!def.nodes[node]?.holdMail && (c.mail[node] ?? []).some(m => m.at > parked.at),
          branch: `factory/${id}`,
          mailed: [
            ...(c.mail[node] ?? []).filter(m => m.from === 'factory').map(m => m.text),
            // mail this watch posted that the next tick has not drained yet
            ...inboxLines(id)
              .slice(readJson<Saved>(join(runDir(id), 'state.json')).cursor)
              .flatMap(l => {
                try {
                  const e = JSON.parse(l)
                  return e.type === 'MAIL' && e.from === 'factory' && e.to === node ? [String(e.text)] : []
                } catch {
                  return []
                }
              }),
          ],
        })
        if (!d) continue
        const iso = new Date(now).toISOString()
        if (d.kind === 'wake') {
          post(id, { type: 'MAIL', from: 'factory', to: node, text: d.text, wake: true })
          console.log(`${iso} ${id}: waking ${node}: ${d.text}`)
          const trigger = prs.find(p => p.url === d.url) ?? prs[0]
          if (trigger) woke.push({ run: id, node, url: trigger.url, state: trigger.state, at: now })
        } else if (d.kind === 'repark') {
          post(id, { type: 'REPARK', node, wakeAt: d.wakeAt })
          store[key]!.reparkedUntil = d.wakeAt
          console.log(`${iso} ${id}: reparking ${node} until ${new Date(d.wakeAt).toISOString()}`)
          reparked.push({ run: id, node, wakeAt: d.wakeAt })
        } else {
          const outcome = d.kind
          post(id, { type: 'ROUTE', node, outcome, summary: d.text })
          store[key]!.routed = true
          console.log(`${iso} ${id}: routing ${node} -> ${outcome}: ${d.text.split('\n')[0]}`)
          routed.push({ run: id, node, url: d.url, outcome, at: now })
          if (d.kind === 'hold' && run.ship && hasBeads(run.repo)) {
            try {
              const b = beads(run.repo, actorOf(id))
              unshipClosed(d.url, b.shipQueue(), b)
            } catch (err) {
              console.log(`${iso} ${id}: closed PR not taken out of the queue: ${(err as Error).message}`)
            }
          }
          if (d.kind === 'changes' && run.bead && hasBeads(run.repo)) {
            const b = beads(run.repo, actorOf(id))
            for (const body of d.bodies)
              try {
                const first = body.split('\n', 1)[0]!.slice(0, 80)
                b.create(
                  `PR change request: ${first}`,
                  `${d.url}\n\n${body}`,
                  '--parent',
                  run.bead,
                  '-t',
                  'task',
                )
              } catch (err) {
                console.log(`${iso} ${id}: no task filed for a change request: ${(err as Error).message}`)
              }
          }
        }
      } catch {
        // removed mid-pass
      }
    }
  } finally {
    for (const k of Object.keys(store)) if (!live.has(k)) delete store[k]
    writeJson(seenFile, store)
    writeJson(join(HOME, 'watch.json'), {
      at: Date.now(),
      viewed: cache.size,
      errors,
      woke,
      routed,
      reparked,
    })
    release()
  }
}

/** the rig of every run holding a worker (`busy`), and the rig of every run merely held there,
 * stuck (`held`): see `slot()` for what each state means for the two caps */
async function busyRigs(): Promise<{ busy: (string | undefined)[]; held: (string | undefined)[] }> {
  const busy: (string | undefined)[] = []
  const held: (string | undefined)[] = []
  for (const id of runIds()) {
    let cur
    try {
      cur = current(id)
    } catch {
      continue // run dir exists before run.json and state.json (createRun writes state.json last)
    }
    const { run, value } = cur
    if (run.ship) continue // a rig's ship run counts against no cap (claude-factory-rtuw); only shipPass sets this
    const [node, sub] = where(value)
    const n = (await loadFactory(run.factory)).nodes[node]
    const s = slot(n, sub)
    if (s === 'busy') busy.push(rigOf(run.repo)?.name)
    else if (s === 'rig') held.push(rigOf(run.repo)?.name)
  }
  return { busy, held }
}

async function assertRoom(repo: string) {
  if (halted()) fail(`the factory is ${halted()!.state}: factory resume first`)
  const { busy, held } = await busyRigs()
  const rig = rigOf(repo)
  if (busy.length >= MAX_BUSY)
    fail(`${busy.length} runs are busy (FACTORY_MAX_RUNS=${MAX_BUSY}): finish, abort or rm one first`)
  if (room(rig, busy, MAX_BUSY, held) <= 0)
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
    slo,
    goal,
    runner,
    agent,
    mcp,
    params,
    egress,
    personOnlyContext,
    protectedBranch,
    mergeAuthority: merge,
    linear,
    linearProjects,
    linearLabels,
  }: {
    max?: string
    sweeps?: string
    slo?: string
    goal?: string
    runner?: string
    agent?: string
    mcp?: string
    params?: string[]
    egress?: string[]
    personOnlyContext?: string[]
    protectedBranch?: string[]
    mergeAuthority?: boolean
    linear?: string
    linearProjects?: string
    linearLabels?: string
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
  if (mcp !== undefined && agent !== undefined && harnessOf(agent) === 'pi')
    fail('--mcp does not reach a pi worker: pi has no MCP client (constitution I)')
  if (remote && agent !== undefined && !harnessOf(agent))
    fail(`--agent for the ${rig.runner} runner is claude, codex or pi (not "${agent}")`)
  if (remote && agent !== undefined) axCodexRefused(agent)
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
  if (slo !== undefined) {
    if (!slo.trim()) fail('--slo is a read-only command, e.g. --slo "kubectl get pods -A | grep -v Running"')
    rig.slo = slo
  }
  if (sweeps !== undefined) {
    rig.sweeps = sweeps === 'none' ? [] : sweeps.split(',')
    const sweepsDef = await loadFactory(factorySource(rig.sweepsFactory ?? 'sweeps', repo))
    const names = sweepNames(sweepsDef)
    const unknown = rig.sweeps.filter(s => !names.includes(s))
    if (unknown.length)
      fail(`no sweep ${unknown.join(', ')} in ${sweepsDef.name}: ${names.join(', ') || 'none'}`)
    // monitor reads rig.slo; an explicit opt-in with no command set would never fire (src/sweeps.ts's
    // dueSweeps already gates it), which is a silent no-op a person is better off told about now
    if (rig.sweeps.includes('monitor') && !rig.slo)
      fail('monitor needs --slo "<read-only command>": add it, or drop monitor from --sweeps')
  }
  if (personOnlyContext?.length) {
    const bad = personOnlyContext.filter(c => !/^[A-Za-z0-9._@:/-]+$/.test(c))
    if (bad.length)
      fail(`--person-only-context is a kube context name, letters/digits/._@:/- (not "${bad[0]}")`)
    rig.personOnlyContexts = personOnlyContext
  }
  if (protectedBranch?.length) {
    const bad = protectedBranch.filter(b => !/^[A-Za-z0-9._/-]+$/.test(b))
    if (bad.length) fail(`--protected-branch is a branch name, letters/digits/._/- (not "${bad[0]}")`)
    rig.protectedBranches = protectedBranch
  }
  if (merge) rig.mergeAuthority = true
  if (linear !== undefined) {
    try {
      const team = parseLinearTeams(linear)
      const projects = linearProjects !== undefined ? parseLinearList(linearProjects) : undefined
      const labels = linearLabels !== undefined ? parseLinearList(linearLabels) : undefined
      rig.linear = { team, ...(projects && { projects }), ...(labels && { labels }) }
    } catch (err) {
      fail((err as Error).message)
    }
  } else if (linearProjects !== undefined || linearLabels !== undefined) {
    fail('--linear-projects and --linear-labels need --linear <team_id[,team_id]> too')
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
  if (at && !Object.hasOwn(preview.nodes, at))
    fail(`no station "${at}" in ${preview.name}: ${Object.keys(preview.nodes).join(', ')}`)
  if (preview.name === 'ship')
    fail(
      `only the runner starts a ship run, once for each rig with a queue: see factory ship ${rigOf(root)?.name ?? root}`,
    )
  const linked = beadFor(root, goal, { isOwnerOk })
  const { run, def } = await createTracked(spec!, preview.name, root, linked.goal, linked.bead)
  if (at && at !== def.start && Object.hasOwn(def.nodes, at)) post(run.id, { type: 'GOTO', node: at })
  await tick() // launches the first worker now rather than at the next tick
  console.log(
    `started ${run.id} in ${run.worktree} (herdr workspace ${run.ws}), following ${run.factoryFrom}${run.bead ? `, bead ${run.bead}` : ''}`,
  )
}

/**
 * claude-factory-ab8n: the sender for mail the manager posts (mail, poke and fork).
 * A worker has FACTORY_DEF_NAME, a factory/ BEADS_ACTOR, or a cwd inside its run's worktree.
 * It must not mail as the manager, because the owner-only rule trusts mail from the manager.
 * It returns 'manager' when no marker is present. Otherwise it fails and posts nothing.
 */
function managerSender(run: Run): 'manager' {
  const marker = process.env.FACTORY_DEF_NAME
    ? 'FACTORY_DEF_NAME is set'
    : process.env.BEADS_ACTOR?.startsWith('factory/')
      ? 'BEADS_ACTOR names a factory worker'
      : insideWorktree(run)
        ? 'the working directory is inside the run worktree'
        : undefined
  if (marker) fail(`a worker cannot send mail as the manager (${marker}); a worker mails as its own station`)
  return 'manager'
}

function insideWorktree(run: Run): boolean {
  if (!run.worktree || run.worktree === run.repo) return false
  try {
    const wt = realpathSync(run.worktree)
    const cwd = realpathSync(process.cwd())
    return cwd === wt || cwd.startsWith(wt + sep)
  } catch {
    return false
  }
}

async function fork(id: string | undefined, station: string | undefined, note: string) {
  const { run: src, value } = current(id)
  const def = await loadFactory(src.factory)
  if (!Object.hasOwn(def.nodes, station ?? ''))
    fail(`usage: factory fork <run> <station> [note...]; stations: ${Object.keys(def.nodes).join(', ')}`)
  const sender = note ? managerSender(src) : undefined
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
  if (sender) post(run.id, { type: 'MAIL', from: sender, to: station!, text: note })
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
  const { busy, held } = await busyRigs()
  return rigs().map(rig => {
    const w = {
      ...rig,
      // a stuck run still fills this rig's maxRuns, so it counts here too (not the town cap)
      busy: busy.filter(b => b === rig.name).length + held.filter(h => h === rig.name).length,
    }
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

/** owner and owner/repo of a rig repo whose origin is on github.com; null for any other, and for a dot segment */
function rigRef(repoPath: string): { owner: string; slug: string } | null {
  const o = originRef(repoPath)
  if (o?.forge !== 'github') return null
  const slug = githubSlugOf(`https://github.com/${o.owner}/${o.repo}/pull/1`)
  return slug ? { owner: o.owner, slug } : null
}

/** whether `glab` is signed in to a host: how a self-hosted GitLab without "gitlab" in its name is told */
const glabKnows = (host: string) =>
  Bun.spawnSync(['glab', 'auth', 'status', '--hostname', host]).exitCode === 0

const prsFile = (id: string) => join(runDir(id), 'prs.json')

/** Check whether `id` is at a gate node now, working, with this exact gate visit's `startedAt`.
 * `gate-brief set` uses this check to refuse a stale key.
 * It also uses this check to prune old keys from `gate-briefs.json` (claude-factory-2u2). */
async function isLiveGateVisit(id: string, startedAt: number): Promise<boolean> {
  try {
    const { run, value, c } = current(id)
    const [node, sub] = where(value)
    if (sub !== 'working' || c.startedAt !== startedAt) return false
    return (await loadFactory(run.factory)).nodes[node]?.gate === true
  } catch {
    return false // the run is gone, or its state is unreadable: not a live gate either way
  }
}

/** `factory gate-brief facts <run>` gathers the facts a briefer subagent needs to write one gate's brief
 * (claude-factory-2u2). The briefer itself never shells out to `gh` or reads untrusted journal text through
 * a tool that can also run other commands. It fails, exit 1, unless `run` is at a gate, working. */
async function gateBriefFacts(id: string | undefined) {
  const { run, value, c } = current(id)
  const [node, sub] = where(value)
  const def = await loadFactory(run.factory)
  const n = def.nodes[node]
  if (!n?.gate || sub !== 'working') fail(`${run.id} is not at a gate (it is at ${node})`)
  const file = existsSync(prsFile(run.id))
    ? asPrsFile(readJson(prsFile(run.id)))
    : { version: 1 as const, prs: [] }
  const prs = await Promise.all(
    file.prs.map(async pr => {
      let additions: number | null = null
      let deletions: number | null = null
      let changedFiles: number | null = null
      // the diff stat costs one more `gh api` call; only for a code-role PR, and only on GitHub (a GitLab
      // merge request would need `glab`'s own fields, skipped here rather than guessed at)
      if (pr.role === 'code' && pr.forge !== 'gitlab') {
        try {
          const path = githubPullPath(pr.url)
          const res = path ? await spawnGh(['api', path], { cwd: run.repo, timeout: 30_000 }) : null
          const parsed = res?.code === 0 ? parseGithubView(res.out) : null
          additions = parsed?.additions ?? null
          deletions = parsed?.deletions ?? null
          changedFiles = parsed?.changedFiles ?? null
        } catch {
          // fail soft (the design's own rule): additions/deletions/changedFiles stay null
        }
      }
      return {
        title: pr.title,
        url: pr.url,
        role: pr.role,
        state: pr.state,
        isDraft: pr.isDraft,
        checks: pr.checks,
        reviewDecision: pr.reviewDecision,
        mergeStateStatus: pr.mergeStateStatus,
        additions,
        deletions,
        changedFiles,
      }
    }),
  )
  return {
    key: gatebrief.gateKey(run.id, c.startedAt),
    rig: rigOf(run.repo)?.name,
    bead: run.bead,
    goal: clip(run.goal, 2000),
    gate: { question: n!.prompt.trim(), outcomes: Object.keys(n!.next) },
    verify: clip(c.log.findLast(e => e.node === 'verify')?.summary ?? '', 1500),
    review: clip(c.log.findLast(e => e.node === 'review' || e.node === 'security')?.summary ?? '', 1500),
    prs,
  }
}

/** `factory gate-brief set <key> <file>` is the briefer's only write (claude-factory-2u2).
 * It refuses a worker or patrol env, the same two checks `decide` uses (claude-factory-72v's pattern).
 * It refuses a malformed key, and a key whose gate visit ended.
 * A key's gate visit ends when the run moves on, or was never at that gate.
 * The person must never see a brief for the wrong decision.
 * `gatebrief.clipBrief` cleans `<file>`'s text before storage, because the text is the briefer's model
 * output, built from untrusted PR and journal text. */
async function gateBriefSet(key: string | undefined, filePath: string | undefined) {
  if (process.env.FACTORY_FROM) fail('a worker cannot set a gate brief: only the briefer may')
  if (process.env.FACTORY_PATROL) fail('a patrol cannot set a gate brief: leave it for the briefer')
  if (!key || !filePath) fail('usage: factory gate-brief set <key> <file>')
  const m = /^gate:(.+)@(\d+)$/.exec(key!)
  if (!m) fail(`malformed gate-brief key "${key}"`)
  const id = m![1]!
  const startedAt = Number(m![2])
  if (!(await isLiveGateVisit(id, startedAt))) fail(`"${key}" is not a live gate visit`)
  if (!existsSync(filePath!)) fail(`no file ${filePath}`)
  const text = gatebrief.clipBrief(readFileSync(filePath!, 'utf8'))
  if (!text) fail('the brief is empty once cleaned')
  const briefs = readGateBriefs()
  briefs[key!] = { text, at: Date.now() }
  for (const k of Object.keys(briefs)) {
    if (k === key) continue
    const km = /^gate:(.+)@(\d+)$/.exec(k)
    if (!km || !(await isLiveGateVisit(km[1]!, Number(km[2])))) delete briefs[k]
  }
  writeJson(gateBriefsFile(), briefs)
  console.log(`brief set for ${key}`)
}

/** `factory review facts <key>` gathers what the reviewer reads for one pending skill or proposal
 * (claude-factory-ag2). The reviewer has no tool: the mod passes this text to it. It exits 1 for a key
 * that is unknown or stale (the text changed since the key was made). */
function reviewFacts(key: string | undefined) {
  const item = memory.reviewItems(MEMORY).find(i => i.key === key)
  if (!item) fail(`no pending item with key "${key}": it is reviewed, changed or gone`)
  const installedFile = join(memory.skillsDir(MEMORY), item!.name, 'SKILL.md')
  const installed =
    item!.kind === 'skill' && existsSync(installedFile)
      ? clip(readFileSync(installedFile, 'utf8'), 16384)
      : undefined
  const { key: k, kind, name, change, text } = item!
  return {
    key: k,
    kind,
    name,
    change,
    text: clip(text, 16384),
    ...(installed === undefined ? {} : { installed }),
  }
}

/** `factory review set <key> <file>` is the reviewer's only write (claude-factory-ag2).
 * It refuses a worker or patrol env, a stale or unknown key, and a key that has a verdict already.
 * `memory.parseReview` parses the model's answer strictly: it is built from untrusted dream text. */
function reviewSet(key: string | undefined, filePath: string | undefined) {
  if (process.env.FACTORY_FROM) fail('a worker cannot set a review: only the reviewer may')
  if (process.env.FACTORY_PATROL) fail('a patrol cannot set a review: leave it for the reviewer')
  if (!key || !filePath) fail('usage: factory review set <key> <file>')
  if (!memory.reviewItems(MEMORY).some(i => i.key === key)) fail(`no pending item with key "${key}"`)
  const store = readReviews()
  if (store[key!]) fail(`"${key}" has a recommendation already`)
  if (!existsSync(filePath!)) fail(`no file ${filePath}`)
  store[key!] = { ...memory.parseReview(readFileSync(filePath!, 'utf8')), at: new Date().toISOString() }
  writeJson(reviewsFile(), store)
  console.log(`review set for ${key}: ${store[key!]!.recommendation}`)
}

/**
 * every run's own pull requests (AC1): mentions out of its reports and mail, corroborated by its rig's
 * branch listing or a search for its bead, kept and refreshed in runs/<id>/prs.json so a restart loses
 * nothing (AC6). Draft, merged and closed PRs stay listed; the budget (src/prs.ts DEFAULT_BUDGET) spends
 * at most 10 searches and 30 PR views a call, live runs first. A view is up to 4 `gh api` calls.
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
        .filter(
          (e): e is { type: 'MAIL'; from: string; to: string; text: string; at: number } => e.type === 'MAIL',
        )
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
    return m
      ? [{ run: id, rig: m.rig, bead: m.bead, node: m.node, ended: m.ended, at: m.at, error, prs: all }]
      : []
  })
}

type DecisionBead = { id: string; title: string; description?: string; kind: 'bead' | 'owned' }
export type DecisionsRow = { rig: string; factory: string; beads: DecisionBead[]; error?: string }
export type Proposal = { question: string; context?: string; options: string[]; at: number }

const decisionsFile = () => join(HOME, 'decisions.json')
const proposals = (): Record<string, Proposal> =>
  existsSync(decisionsFile()) ? readJson(decisionsFile()) : {}

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
  if (process.env.FACTORY_FROM)
    fail("a worker cannot answer the person's decisions: mail the manager instead")
  // claude-factory-72v.19: same second CLI-side layer as beadFor's isOwned check above, behind
  // the mod's own regex deny for this command.
  if (process.env.FACTORY_PATROL) fail("a patrol cannot answer the person's decisions: leave it for them")
  const b = beads(repoOf(rigName), 'factory/person')
  if (b.human().some(x => x.id === id)) b.respond(id, text)
  else b.comment(id, text)
  console.log(`answered ${id}`)
}

/** one raw `label: effect` option, split the same way the console's own parser splits it: at the first ": "
 * into a label and an effect, with the word "recommended" in a parenthetical read as a flag and stripped out
 * (duplicated from mod/hooks/view.ts's parseChoice: the mod and this CLI ship separately, with no shared
 * module between them, so this length check and the console's render must each parse the stored string the
 * same way on their own) */
function parseOption(raw: string): { label: string; effect?: string; recommended: boolean } {
  let recommended = false
  const stripped = raw.replace(/\(([^()]*)\)/g, (whole, inner: string) => {
    if (!/\brecommended\b/i.test(inner)) return whole
    recommended = true
    const rest = inner
      .split(',')
      .map(s => s.trim())
      .filter(s => s && !/^recommended$/i.test(s))
      .join(', ')
    return rest ? `(${rest})` : ''
  })
  const text = stripped.replace(/\s+/g, ' ').trim()
  const idx = text.indexOf(': ')
  const label = idx === -1 ? text : text.slice(0, idx).trim()
  const effect = idx === -1 ? undefined : text.slice(idx + 2).trim() || undefined
  return { label, effect, recommended }
}

/** the manager proposes a short title, an optional context sentence, and 2-4 options for an item the person
 * would otherwise have to answer in their own words; never for a gate, which only the person decides, and
 * never for a blocked-on-prompt item, which waits on the person looking at the worker's pane rather than on
 * a choice. Refuses each field over its limit, an empty question or option label, and a question of only
 * whitespace (named in the error, with its length and the limit) before it writes anything, so a bad call
 * leaves decisions.json unchanged.
 *
 * An own: key identifies an owner-only bead. It always keeps its two fixed options, start now and not now.
 * This function ignores any options that the caller gives for an own: key, and does not parse or store them.
 * An owner-only bead never takes the manager's own choices. The manager can still give it a shorter question,
 * or an added context sentence. */
function decisionsPropose(key: string, question: string, optionsLine: string, context?: string) {
  if (process.env.FACTORY_FROM)
    fail("a worker cannot propose the person's decisions: mail the manager instead")
  // claude-factory-72v.19: same second CLI-side layer as beadFor's isOwned check above. Only the
  // manager's own interview round proposes decisions; a patrol never does.
  if (process.env.FACTORY_PATROL) fail("a patrol cannot propose the person's decisions: leave it for them")
  if (/^gate:/.test(key)) fail('a gate is decided by the person, never proposed options')
  if (/^prompt:/.test(key)) fail('a blocked worker is looked at, never proposed options')
  if (!/^(iv|bd|own):/.test(key)) fail(`malformed decision key "${key}"`)
  if (/\n/.test(question)) fail('question has a newline: it must be one line')
  if (!question.trim()) fail('question is empty, or only whitespace')
  if (question.length > 160) fail(`question is ${question.length} characters, over the 160 limit`)
  if (context !== undefined && /\n/.test(context)) fail('context has a newline: it must be one sentence')
  if (context !== undefined && context.length > 200)
    fail(`context is ${context.length} characters, over the 200 limit`)
  const all = proposals()
  if (/^own:/.test(key)) {
    all[key] = {
      question,
      options: ['start now', 'not now'],
      at: Date.now(),
      ...(context ? { context } : {}),
    }
    mkdirSync(HOME, { recursive: true })
    writeJson(decisionsFile(), all)
    console.log(`proposed options for ${key} (its two fixed options stay: start now, not now)`)
    return
  }
  if (/\n/.test(optionsLine)) fail('options have a newline: each option must be one line')
  const rawOptions = optionsLine
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
  if (rawOptions.length < 2) fail('give at least two options, separated by |')
  if (rawOptions.length > 4) fail(`${rawOptions.length} options given, over the 4 limit`)
  const parsed = rawOptions.map(parseOption)
  for (const o of parsed) {
    if (!o.label) fail(`option "${o.effect ?? ''}" has no label before its ": "`)
    if (o.label.length > 40)
      fail(`option label "${o.label}" is ${o.label.length} characters, over the 40 limit`)
    if (o.effect && o.effect.length > 100)
      fail(`option effect "${o.effect}" is ${o.effect.length} characters, over the 100 limit`)
  }
  const recommended = parsed.filter(o => o.recommended).length
  if (recommended > 1) fail(`${recommended} options marked recommended, only 1 is allowed`)
  all[key] = { question, options: rawOptions, at: Date.now(), ...(context ? { context } : {}) }
  mkdirSync(HOME, { recursive: true })
  writeJson(decisionsFile(), all)
  console.log(`proposed options for ${key}`)
}

/** what each Claude worker session of a run spent, from the transcripts in its worktree's project dir */
function usageOf(run: Run, since = 0): Usage[] {
  return usageIn(run.worktree, run.id, () => '?', since)
}

/** the usage rows of every Claude session that ran in `cwd` and wrote its transcript at or after `since` */
function usageIn(cwd: string, run: string, nodeOfSeq: (seq: number) => string, since = 0): Usage[] {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'projects',
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
  )
  if (!existsSync(dir)) return []
  const read = (f: string) => readFileSync(f, 'utf8').split('\n')
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && statSync(join(dir, f)).mtimeMs >= since)
    .flatMap(f => {
      const session = f.slice(0, -'.jsonl'.length)
      const subDir = join(dir, session, 'subagents')
      const subs = existsSync(subDir)
        ? readdirSync(subDir)
            .filter(g => g.endsWith('.jsonl'))
            .map(g => read(join(subDir, g)))
        : []
      const rows = sessionOf(read(join(dir, f)), run, nodeOfSeq, session, subs)
      return rows.some(u => u.turns > 0) ? rows : []
    })
}

/** the manager's own sessions (patrol, pm, briefer, dream) since `since`, from manager-usage.jsonl */
function managerUsage(since: number): ManagerUsage[] {
  const file = join(HOME, 'manager-usage.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(l => {
      try {
        return l ? [JSON.parse(l) as ManagerUsage] : []
      } catch {
        return []
      }
    })
    .filter(m => m.at >= since)
}

function records(): RunRecord[] {
  const file = join(HOME, 'metrics.jsonl')
  const lines: RunRecord[] = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
  // a run can get two lines over its life (a gc prune, then later `factory rm`): a Map keeps only
  // the last line for each id, so metrics never counts a pruned-then-removed run twice
  const kept = [...new Map(lines.map(r => [r.id, r])).values()]
  const live = startedRunIds().map(id => record(id))
  const liveIds = new Set(live.map(r => r.id))
  return [...kept.filter(r => !liveIds.has(r.id)), ...live]
}
function record(id: string): RunRecord {
  const { run, value, c } = current(id)
  return {
    id,
    rig: rigOf(run.repo)?.name,
    node: where(value)[0],
    createdAt: createdAt(id),
    log: c.log,
    ...(trackOf(id).requeued && { requeued: true }),
    sessions: storedUsage(id),
  }
}

async function status(id: string | undefined) {
  const halt = halted()
  if (halt && !id)
    console.log(
      halt.state === 'paused'
        ? `PAUSED since ${clock(halt.at)}: ${Object.keys(halt.closed).length} worker(s) wait for factory resume`
        : `STOPPING since ${clock(halt.at)}: workers are committing and going quiet`,
    )
  const stale = !id && managerStale(HOME, managerCommand([], ''))
  if (stale) console.log(stale)
  if (!id && process.env.FACTORY_IN_AX === '1' && process.env.FACTORY_AX_BACKUP_REMOTE) {
    const age = backupAge(HOME, Date.now())
    const err = backupError(HOME)
    console.log(
      (age === undefined ? 'home backup: none yet' : `home backup: ${Math.round(age / 60_000)} min ago`) +
        (err ? `; last run failed: ${err}` : ''),
    )
  }
  if (!runIds().length) console.log('no runs yet: factory start <factory> <repo> <goal...>')
  for (const runId of id ? [id] : startedRunIds()) {
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
  if (!id) {
    const ships = liveShipRuns()
    for (const [rig, queue] of Object.entries(shipQueues())) {
      const repo = rigs().find(r => r.name === rig)!.repo
      const live = ships.find(s => s.run.repo === repo)
      const lines = shipLines(queue, live && { id: live.run.id, node: live.node })
      if (lines.length) console.log(`rig ${rig}\n${lines.join('\n')}`)
    }
  }
}

/** each rig's ship queue, the next PR first; a rig whose bd cannot be read is left out */
function shipQueues() {
  const out: Record<string, Bead[]> = {}
  for (const rig of rigs()) {
    try {
      if (hasBeads(rig.repo)) out[rig.name] = beads(rig.repo, 'factory').shipQueue()
    } catch (err) {
      console.error(`ship queue for ${rig.name}: ${(err as Error).message}`)
    }
  }
  return out
}

// shared between the help text below, the memory-case fallback usage error, and gate()'s own refusal
// message, so the three never drift apart (claude-factory-3u1.1.1)
const MEMORY_ADD_USAGE = `[--rig r] [--from run/station] --kind ${memory.NOTE_KINDS.join('|')} [--until <bead|owner/repo#N|YYYY-MM-DD>] [--anyway] [--supersedes <note path>] <summary> [body...]`

/**
 * Check a `memory add --supersedes <path>` value (claude-factory-3u1.1.2, FR-009).
 *
 * Call this after the path resolves through the rename log. The function returns a reason to
 * refuse the path, or null when the path names a real note. The `add` case calls this after
 * gate() and before same(). A bad path must cost no embedding call and write nothing.
 *
 * `memory helped` already refuses a path with no matching note. This function adds four more
 * checks. Each one catches a path that exists on disk, so noteExists() alone wrongly accepts it:
 * - a path under a dot segment, such as `.archive/x.md` (walk() hides this path)
 * - a topic's whole README.md or LONG.md file, named with no `#id`
 * - CORE.md itself, named with no `#hash`
 * - for a path with no `#` at all, any path that is not a real `.md` file: a directory, or a
 *   file whose name does not end in `.md`
 *
 * claude-factory-3u1.1.2.6: for a path with no `#`, noteExists() was only existsSync(). A topic
 * directory, `inbox`, or `.` (which resolves to `''`) passed that check. supersede() then crashed
 * with EISDIR.
 */
function supersedesRefusal(dir: string, p: string): string | null {
  if (p.startsWith('..')) return `"${p}" is outside ${dir}`
  if (p.split('/').some(seg => seg.startsWith('.'))) return `"${p}" is in a hidden path`
  const base = p.split('/').pop()
  if (base === 'README.md' || base === 'LONG.md' || p === 'CORE.md')
    return `"${p}" names a whole file, not one note`
  if (!memory.noteExists(dir, p)) return `no note at "${p}" in ${dir}`
  if (!p.includes('#') && (!p.endsWith('.md') || !statSync(join(dir, p)).isFile()))
    return `"${p}" is not a note file`
  return null
}

const [cmd, ...args] = process.argv.slice(2)
const usage = `factory — herdr software factories on xstate

  start <factory>[@station] <rig|repo> <goal...|bead> [--owned]   new run: herdr worktree off the repo, first worker
                                     launched; --owned starts a bead carrying its owner's decisions, when they ask
  init <dir>                         a new factory: a directory whose rigs and runs commands run in it work
  rig [add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--runner ${Object.keys(runners).join('|')}] [--agent cmd] [--mcp file] [--param name=value]... [--egress host[,host]...[=KEY[:Header:Prefix]]]... [--linear team_id[,team_id] [--linear-projects name[,name]] [--linear-labels name[,name]]] [--goal text...] | rm <name>]   the factory's
                                     rigs: repos whose ready beads labeled factory start as runs, each with its
                                     own cap, sweeps, runner (where workers run) and a goal the manager works toward; --agent runs every
                                     station as that command (claude, codex or pi), --mcp gives its workers
                                     the MCP servers in a Claude-shaped mcpServers file; --egress (repeatable, runner ax) lets the VM reach
                                     those hosts, injecting the agent-vault credential KEY for them; --linear opts the rig into the
                                     Linear pull loop, for these Linear team ids; --linear-projects and --linear-labels route an issue of
                                     a matching project or label name to this rig (needs --linear too)
  linear [rig...] [--force]         pulls each opted-in rig's Linear issues into its beads now, instead of waiting for
                                     the next 20-minute window
  adopt <rig|repo> [template]        copy a factory into <repo>/.factory/ for the repo to own and improve
  queue <rig|repo> <bead> [station]  hand a bead to the factory (labels it factory)
  ship <rig|repo>                    the rig's ship queue: the next PR to merge first, then the others
  show <run> | backlog | prs        JSON for the manager's views
  decisions [answer <rig> <bead> <text...> | propose <key> "<question>" "<a | b>"]   JSON of every rig's open
                                     bd decisions (human-flagged and owner-only beads); answer one, as the
                                     person, or let the manager propose options for an item that has none
  plan [facts | set <file> | show]   the pm's plan: facts gathers each rig's ready work and findings for the
                                     pm (writes plan-facts.json); set <file> reads the pm's answer, writes
                                     plan.json and files findings/proposals as beads; show (or bare plan)
                                     prints the plan as text
  review facts <key> | set <key> <file>   the reviewer of the dream's skill and .proposals/ items: facts
                                     prints one item's text as JSON; set stores the reviewer's verdict
                                     (install or reject, and why) in reviews.json. A patrol cannot run
                                     skills or proposals install or reject
  gate-brief facts <run> | set <key> <file>   the gate briefer: facts gathers one gate's PR, verify and
                                     review/security facts as JSON; set <key> <file> stores the briefer's
                                     cleaned text in gate-briefs.json, for the gate's Interview item
  metrics [--rig r] [--since 7d] [--json]   how the factory performs: fates, ship rate, time to ship and on
                                     the approve gate, review loops, failures by kind, each station's outcomes
  check <factory file>               validate a factory: graph, outcomes, a way to done from every station
  status [run]                       runs at a glance, or one run's full log
  waiting                            everything that waits on the person, by rig, and how to answer each
  digest                             per rig: beads by state, the owner queue, recent repairs, PRs to merge in order
  manager [claude args...]           start this factory's manager here, lean: Bash and file tools, no MCP servers
  attach [--follow]                  the AX manager's pane, read over ax ssh; --follow redraws every 3 s
                                     (no keyboard: ax ssh has no stdin or TTY; docs/remote-runner.md)
  say <text...>                      type text and Enter into the AX manager's pane
  home                               the factory these commands work: FACTORY_HOME, else found from here
  stop | resume                      graceful shutdown: workers commit and wait, their panes close, nothing
                                     launches or dispatches; resume brings each back in its own conversation
  memory search [--rig r] <query...>  the closest notes in the factory's shared memory (semantic search)
  memory add ${MEMORY_ADD_USAGE}   save a learning to the memory's
                                     inbox; one an existing note already says counts as that note helping;
                                     a note that names a bead or PR needs --until unless --kind recipe
  memory helped --from run/station <note path...>  a note helped: the dream ranks notes by this
  memory compact [--dry-run]        merge 7+ day old short notes above θm into LONG.md; archive a 14+ day
                                     old one never shown, or below θa (FACTORY_MEMORY_THETA_* change θ; both
                                     wait for 14 days of usage history first); FACTORY_MEMORY_ARCHIVE_CAP
                                     caps archives per pass (default 25), oldest first, the rest held;
                                     FACTORY_MEMORY_TOPIC_CAP caps short notes per topic (default 15): a
                                     topic over the cap merges its oldest 7+ day old notes down to it;
                                     --dry-run only prints the plan (a dream runs this itself, after it
                                     files the inbox, unless FACTORY_MEMORY_TIERS=0)
  memory eval [--self [n] [--seed s]]  search quality (recall@5, MRR) over the fixed query set in
                                     <memory>/.eval.jsonl, and which queries missed, one line per
                                     case category (update, temporal, abstain); --self builds n
                                     cases (default 60) from the notes, each note's first body
                                     sentence as the query, the same sample for one seed (default 1)
  dream                              groom the memory now: file the inbox, merge, prune, learn from the journals
  skills [install <n> | reject <n> <why>]  the skills the dream proposed for the manager: list them, install one
                                     once reviewed, or reject it, saying why
                                     (each tick starts one a day)
  proposals [install <n> [--rig r] | reject <n> <why>]  the dream's learning-ladder proposals: rung core
                                     installs a CORE.md line; a higher rung files a bead in the factory's
                                     own rig (or --rig r) for a person
  beads                              one pass of the runs' bead bookkeeping and the rigs' dispatch (each tick starts one)
  watch                              one pass of the pull request watch that wakes a parked station (each
                                     tick starts one, at most once a minute)
  tick | loop [--interval ms]        advance every run once, or forever (default 5s), keeping the rigs' sweeps running
  report <run> <seq> <outcome> <summary...>   worker: finish its station
  worker serve [--model m] | poll <cursor> | prompt <base64>   inside an AX task: the worker's Claude, its
                                     state and outbox, a prompt queued for it (docs/remote-runner.md)
  pkg-gate serve [--port 8080]       an age-gating registry proxy for go/npm/pypi (PKG_GATE_MIN_DAYS,
                                     PKG_GATE_ALLOWLIST_GO/_NPM/_PYPI colon-separated, one per ecosystem);
                                     GET /healthz for its counters
  decide <run> <outcome> [note...]   the person: answer a gate station
  mail <run> <node|manager> [--wake] <text...>  drop a message in a mailbox; --wake starts a worker at a held PR park
  poke <run> [text...]               nudge the current station's worker: report, or say what blocks it
  retry <run> | goto <run> <node|done> | abort <run>   quarterback a run
  fork <run> <station> [note...]     new run from <run>'s branch and state, restarted at <station>
  rm <run>                           finished run: drop its worktree and state, keep its branch
  gc [--days N] [--dry-run]          done or aborted runs older than N days (default 7, FACTORY_GC_DAYS):
                                     drop prompts, briefs and stray backups, and a dead launch script;
                                     --dry-run only prints bytes per kind, deleting nothing (each tick
                                     starts one, at most hourly, FACTORY_GC_MS; FACTORY_GC=0 turns it off)
  gc --worktrees [--dry-run] [--rig NAME]   finished runs: drop a worktree, and its factory/* branch
                                     once it is merged, or its PR is closed and its bead is closed;
                                     never a live run or an unmerged branch; --dry-run only prints
                                     what it would remove (each tick starts one, at most daily,
                                     FACTORY_GC_WORKTREES_MS; FACTORY_GC_WORKTREES=0 turns it off)
  sweep                              one run per due (rig, sweep) pass, under factory "sweeps"
                                     (factories/sweeps.ts), parked at that station; writes
                                     sweeps.json and sweeps.jsonl (each tick starts one, at most
                                     every FACTORY_SWEEP_MS (default 300000); FACTORY_SWEEPS=0 turns
                                     it off)

<factory> is a path, or a name: the repo's own .factory/<name>.ts as of the commit a run starts from,
else the template in ${join(ROOT, 'factories')}. Each run pins its factory. This factory is ${HOME}
(FACTORY_HOME, else the nearest directory up holding a rigs.json). start and fork refuse past FACTORY_MAX_RUNS (${MAX_BUSY}) runs holding a worker,
or past the rig's own --max.
In a repo with .beads, every run works a bead: the one its goal names, or a new one.`

{
  const why = import.meta.main ? otherRunRefusal(cmd, args, process.env) : undefined
  if (why) {
    console.error(why)
    process.exit(1)
  }
}
// inside an AX task the run lives on the laptop: what a worker reports, mails or learns waits in the outbox
const outboxCmd =
  import.meta.main &&
  !!process.env.FACTORY_OUTBOX &&
  (cmd === 'report' || cmd === 'mail' || (cmd === 'memory' && (args[0] === 'add' || args[0] === 'helped')))
// `--help`/`-h` and malformed args never reach the outbox: before this, `report --help` queued a fake report
// indistinguishable from a real one (claude-factory-4x1)
const outboxOk = outboxCmd ? worker.outboxUsage(cmd!, args) : null
if (outboxOk === 'help')
  console.log(
    worker.OUTBOX_USAGE[
      cmd === 'memory' ? (args[0] === 'helped' ? 'helped' : 'memory') : cmd === 'mail' ? 'mail' : 'report'
    ],
  )
else if (outboxOk) {
  console.error(outboxOk)
  process.exit(1)
}
const queued = outboxCmd && outboxOk === null
if (queued) {
  // the station's bd writes go to GitHub before the report, so the laptop has them when it acts on it; a
  // report that went without them would end the VM, and its writes with it
  if (cmd === 'report') {
    const sync = worker.syncBeads()
    if (!sync.ok) {
      console.error(
        `refused: your bd changes were not shared (bd dolt ${sync.step} failed: ${sync.error}); run bd ` +
          `dolt pull && bd dolt push to see the full error; if it fails again, factory mail ${args[0]} ` +
          `manager with that error and do not report until the manager answers`,
      )
      process.exit(1)
    }
  }
  worker.queue([cmd!, ...args], cmd === 'report' ? worker.usageOfSession(args[0]!) : undefined)
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
          sumdb: process.env.PKG_GATE_UPSTREAM_SUMDB ?? pkggate.DEFAULT_UPSTREAM.sumdb,
          goIndex: process.env.PKG_GATE_UPSTREAM_GO_INDEX ?? pkggate.DEFAULT_UPSTREAM.goIndex,
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
        lease()
        console.log(JSON.stringify(await tick(true)))
        break
      case 'beads':
        await beadsPass()
        break
      case 'watch':
        await watchPass()
        break
      case 'sync':
        await syncPass()
        break
      case 'broker':
        broker.main(args)
        break
      case 'manager':
        if (args[0] === 'host') {
          await managerhost.host(args.slice(1), { prepare: reposSync, lock: () => hold('tick.lock') })
          break
        }
        if (args[0] === '--ax') {
          await launchAxManager(args.slice(1))
          break
        }
        lease()
        // ponytail: blocks until the manager exits; run it where it should live (a herdr pane)
        process.exit(await superviseManager(args))
      case 'home':
        console.log(HOME)
        break
      case 'repos': {
        if (args[0] !== 'sync') fail('usage: factory repos sync')
        const problems = reposSync()
        if (problems.length) fail(problems.join('\n'))
        console.log(`repos in place under ${process.env.FACTORY_REPOS ?? '/workspace/w/repos'}`)
        break
      }
      case 'migrate-to-ax':
        await migrateToAx(args)
        break
      case 'attach': {
        const follow = args[0] === '--follow'
        if (args.length > (follow ? 1 : 0)) fail('usage: factory attach [--follow]')
        for (;;) {
          const pane = ax.attachRead()
          console.log(follow ? `\x1b[2J\x1b[H${pane}` : pane)
          if (!follow) break
          await new Promise(r => setTimeout(r, 3000))
        }
        break
      }
      case 'say':
        if (!args.length) fail('usage: factory say <text...>')
        ax.say(args.join(' '))
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
        // Capture this before opt('--supersedes') below runs. Otherwise a bare trailing flag (no
        // value) looks the same as a caller who never passed --supersedes at all.
        const hasSupersedes = args.includes('--supersedes')
        const [rig, from, kind, until, supersedesArg] = [
          opt('--rig'),
          opt('--from'),
          opt('--kind'),
          opt('--until'),
          opt('--supersedes'),
        ]
        const [sub, ...words] = args
        if (sub === 'search' && words.length) {
          const found = await memory.search(MEMORY, words.join(' '), { rig })
          memory.use(
            MEMORY,
            found.map(f => f.note.path),
            'shown',
            Date.now(),
            from,
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
          const note = { summary: summary!, body: body.join(' '), rig, kind, until }
          // gate() first, so a refusal costs no embedding and logs no helped/confirmed event; --anyway
          // skips memory.same()'s dedupe below, never this gate (claude-factory-3u1.1.1)
          const refusal = memory.gate(note)
          if (!refusal.ok) {
            console.error(`factory memory add: ${refusal.reason}`)
            console.error(`usage: factory memory add ${MEMORY_ADD_USAGE}`)
            process.exitCode = 2
            break
          }
          // --supersedes names an older note this one replaces (claude-factory-3u1.1.2, FR-009).
          // Check it after gate() runs, before same() runs. A bad path must cost no embedding.
          // A bad path must write nothing, the same as any other usage error here.
          let supersedesPath: string | undefined
          if (hasSupersedes) {
            if (supersedesArg === undefined || supersedesArg.startsWith('--')) {
              console.error(`factory memory add: --supersedes needs a note path`)
              console.error(`usage: factory memory add ${MEMORY_ADD_USAGE}`)
              process.exitCode = 2
              break
            }
            const resolved = memory.resolvePath(MEMORY, relative(MEMORY, resolve(MEMORY, supersedesArg)))
            const bad = supersedesRefusal(MEMORY, resolved)
            if (bad) {
              console.error(`factory memory add: --supersedes ${bad}`)
              console.error(`usage: factory memory add ${MEMORY_ADD_USAGE}`)
              process.exitCode = 2
              break
            }
            supersedesPath = resolved
          }
          const dup = isAnyway ? null : await memory.same(MEMORY, note)
          if (dup) {
            // a hit, not a new note: the copy would only crowd search results until a dream merged it.
            // It logs 'confirmed', not 'helped' (claude-factory-3u1.1.2, FR-008): 'helped' means a
            // worker found and used the note; a duplicate add only confirms it is still true.
            memory.use(MEMORY, [dup.note.path], 'confirmed', Date.now(), from)
            console.log(
              `already noted (${dup.score.toFixed(2)}): ${join(MEMORY, dup.note.path)}\n  ${dup.note.summary}\n` +
                `counted as a confirmation instead. If yours adds something it lacks, add it again with --anyway.` +
                // A duplicate hit is often the old note itself. Superseding it would make it
                // replace itself. --supersedes applies only to a genuinely new note
                // (claude-factory-3u1.1.2).
                (supersedesPath
                  ? `\n--supersedes was not applied: this was a duplicate, not a new note.`
                  : ''),
            )
          } else {
            const at = new Date().toISOString().slice(0, 10)
            // gate() above already confirmed kind is one of memory.NOTE_KINDS
            const file = memory.add(MEMORY, { ...note, kind: kind as memory.NoteKind, from, at })
            console.log(file)
            if (supersedesPath) {
              const newPath = relative(MEMORY, file)
              const { marked } = memory.supersede(MEMORY, supersedesPath, newPath)
              memory.use(MEMORY, [supersedesPath], 'contradicted', Date.now(), from)
              console.log(
                marked
                  ? `marked superseded: ${join(MEMORY, supersedesPath)}`
                  : `no marker was written on ${supersedesPath} (a LONG.md or CORE.md entry has no ` +
                      `frontmatter of its own); logged contradicted instead`,
              )
            }
          }
        } else if (sub === 'helped' && words.length) {
          const paths = words.map(w => memory.resolvePath(MEMORY, relative(MEMORY, resolve(MEMORY, w))))
          const bad = paths.filter(p => p.startsWith('..') || !memory.noteExists(MEMORY, p))
          if (bad.length) fail(`not a note in ${MEMORY}: ${bad.join(', ')}`)
          const by = memory.helpedBy(from, process.env)
          if (!by) {
            console.error('factory memory helped: name the run it helped: --from run/station')
            console.error('usage: factory memory helped --from run/station <note path...>')
            process.exitCode = 2
            break
          }
          memory.use(MEMORY, paths, 'helped', Date.now(), by)
          console.log(`noted: ${paths.join(', ')}`)
        } else if (sub === 'compact') {
          const dryRun = words.includes('--dry-run')
          if (dryRun) {
            const { decisions, skipped, archiveCap, historyDays, overCap, topicCap } = memory.applyTiers(
              MEMORY,
              { dryRun: true, untilDeps: untilDeps() },
            )
            console.log(
              [
                decisions.length
                  ? memory.planLines(decisions, { archiveCap, historyDays }).join('\n')
                  : 'nothing to merge or archive',
                ...skipped.map(s => `skip  ${s.topic}: ${s.reason}`),
                ...overCap.map(o => `over  ${o.topic}: ${o.count} short notes, cap ${topicCap}`),
              ].join('\n'),
            )
          } else {
            // the same lock dream() holds while it runs: a live dream already writes LONG.md and the
            // usage log, and a concurrent compact racing it can lose a rename or an archive decision
            // (claude-factory-59r.13)
            const release = hold('dream.lock')
            if (!release) {
              console.log('a dream is already running; try again once it finishes')
              break
            }
            try {
              mkdirSync(MEMORY, { recursive: true })
              if (!existsSync(join(MEMORY, '.git'))) git(MEMORY, 'init', '-q')
              const filesBefore = memory.mdFileCount(MEMORY)
              // the plan reaches dream.log before applyTiers writes or removes anything (claude-factory-503.2)
              const tiers = memory.applyTiers(MEMORY, {
                untilDeps: untilDeps(),
                onPlan: lines => appendFileSync(join(HOME, 'dream.log'), lines.join('\n') + '\n'),
              })
              // runs before the commit, so its .usage.jsonl/.renames.jsonl writes land inside it and
              // the repo stays clean right after (claude-factory-503.3)
              memory.compact(MEMORY, tiers.renamed)
              git(MEMORY, 'add', '-A')
              const message = compactMessage(tiers, filesBefore, memory.mdFileCount(MEMORY))
              git(MEMORY, 'commit', '-q', '--allow-empty', '-m', message)
              console.log(message)
            } finally {
              release()
            }
          }
        } else if (sub === 'eval') {
          // --self [n] [--seed s]: cases from the notes themselves, a baseline with no curated set
          const at = (k: string) => (words.includes(k) ? words[words.indexOf(k) + 1] : undefined)
          const self = words.includes('--self')
          const raw = at('--self')
          const n = Number(raw === undefined || raw.startsWith('--') ? 60 : raw)
          const seed = Number(at('--seed') ?? 1)
          if (self && !(Number.isInteger(n) && n > 0))
            fail('usage: factory memory eval --self [n] [--seed s]')
          if (!Number.isInteger(seed)) fail('usage: factory memory eval --self [n] [--seed s]')
          const cases = self
            ? memory.selfCases(memory.walk(MEMORY).notes, n, seed)
            : memory.readEvalCases(MEMORY)
          if (!cases.length)
            fail(
              self
                ? `no notes with a body in ${MEMORY} to build cases from`
                : `no fixed query set at ${memory.evalFile(MEMORY)}: one JSON line each, {"query":"...","expect":"a substring of the note's path or summary","category":"update|temporal|abstain (optional)"}, or run eval --self`,
            )
          const { recall, mrr, misses, categories } = await memory.evaluate(MEMORY, cases)
          const line = (s: memory.EvalScore) =>
            `recall@5 ${s.recall.toFixed(2)}  mrr ${s.mrr.toFixed(2)}  n=${s.n}`
          console.log(
            [
              line({ recall, mrr, n: cases.length }),
              ...Object.entries(categories).map(([k, s]) => `  ${k} ${line(s)}`),
              ...misses.map(
                m => `miss: "${m.query}" expected ${m.expect === undefined ? 'no match' : `"${m.expect}"`}`,
              ),
            ].join('\n'),
          )
        } else
          fail(
            `usage: factory memory search [--rig r] <query...> | add ${MEMORY_ADD_USAGE} | helped [--from run/station] <note path...> | compact [--dry-run] | eval [--self [n] [--seed s]]`,
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
      case 'linear': {
        if (halted()) fail(`the factory is ${halted()!.state}: factory resume first`)
        const names = args.filter(a => a !== '--force')
        for (const name of names) {
          const rig = rigs().find(r => r.name === name) ?? fail(`factory linear: no rig "${name}"`)
          if (!rig.linear?.team?.length)
            fail(
              `factory linear: rig "${name}" is not opted into the Linear pull loop (no --linear team ids)`,
            )
        }
        const release = hold('beads.lock') ?? fail('factory linear: beads.lock is held; try again shortly')
        try {
          console.log((await linearPass(names, args.includes('--force'))).join('\n'))
        } finally {
          release()
        }
        break
      }
      case 'self-update': {
        const state = runSelfUpdate()
        console.log(state ? JSON.stringify(state) : 'a tick, or another self-update, is already running')
        break
      }
      case 'skills': {
        const [verb, name, ...why] = args
        // a patrol subagent has a Bash tool: the manager or the person decides, never a subagent
        if ((verb === 'install' || verb === 'reject') && process.env.FACTORY_PATROL)
          fail(`a patrol cannot ${verb} a skill: leave it for the manager`)
        if ((verb === 'install' || verb === 'reject') && process.env.FACTORY_FROM)
          fail(`a worker cannot ${verb} a skill: mail the manager instead`)
        if (!verb)
          console.log(
            JSON.stringify(
              memory.pendingSkills(MEMORY).map(p => {
                const v = verdictOf('skill', p.name)
                return v ? { ...p, recommendation: v.recommendation, why: v.why } : p
              }),
              null,
              2,
            ),
          )
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
      case 'proposals': {
        const rigName = args.includes('--rig') ? args.splice(args.indexOf('--rig'), 2)[1] : undefined
        const [verb, name, ...why] = args
        const usage = 'proposals [install <name> [--rig r] | reject <name> <why>]'
        if (!verb) {
          const pending = memory.proposals(MEMORY).filter(p => p.status === 'pending')
          console.log(
            pending
              .map(p => {
                const v = verdictOf('proposal', p.name)
                return `${p.name}  ${p.rung}  ${p.target}: ${p.change}${v ? `  (reviewer: ${v.recommendation}, ${v.why})` : ''}`
              })
              .join('\n') || 'no pending proposals',
          )
        } else if ((verb === 'install' || verb === 'reject') && process.env.FACTORY_PATROL) {
          fail(`a patrol cannot ${verb} a proposal: leave it for the manager`)
        } else if ((verb === 'install' || verb === 'reject') && process.env.FACTORY_FROM) {
          fail(`a worker cannot ${verb} a proposal: mail the manager instead`)
        } else if (verb === 'install' && name) {
          const p = memory.proposals(MEMORY).find(x => x.name === name)
          if (p?.rung === 'core') {
            memory.installCoreProposal(MEMORY, name)
            commitMemory(`installed the proposal ${name} as a CORE.md line`)
            console.log(`installed ${name}: CORE.md now says "${p.change}"`)
            break
          }
          // FR-020: a rung above core is a bead for a person, filed in the factory's own rig; no code changes here
          const rig = rigName ? rigs().find(r => r.name === rigName) : rigOf(ROOT)
          if (!rig)
            fail(
              `no rig ${rigName ? `named ${rigName}` : `holds the factory's own repo ${ROOT}`}: pass --rig <name>`,
            )
          const bead = memory.installProposalAsBead(MEMORY, name, x =>
            beads(rig!.repo, 'factory/proposals').createUnlabeled(
              `memory proposal ${x.name}: ${x.change}`.slice(0, 200),
              readFileSync(x.file, 'utf8'),
              { memory_proposal: x.name },
              '-l',
              'human',
            ),
          )
          commitMemory(`filed the proposal ${name} as ${bead}`)
          console.log(`filed ${name} (rung ${p?.rung}) as ${bead} in ${rig!.name}, for a person`)
        } else if (verb === 'reject' && name) {
          if (!why.length) fail(`${usage}: the dream learns from the reason`)
          memory.rejectProposal(MEMORY, name, why.join(' '))
          commitMemory(`rejected the proposal ${name}`)
          console.log(`rejected ${name}; the dream reads why`)
        } else fail(usage)
        break
      }
      case 'loop': {
        lease()
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
        // claude-factory-6as.4: HOME/precheck.jsonl is dispatch's own trail of pre-check hits and
        // fail-opens (logPrecheck), independent of bd; this command is the only reader.
        const since_ = since ? Date.now() - days * 86_400_000 : 0
        const precheckAll = existsSync(precheckFile())
          ? parsePrecheckLines(readFileSync(precheckFile(), 'utf8')).filter(l => l.at >= since_)
          : []
        const launchFile = join(HOME, 'launches.jsonl')
        const launches = existsSync(launchFile)
          ? parseLaunchLines(readFileSync(launchFile, 'utf8')).filter(
              l => l.at >= since_ && (!rig || l.rig === rig),
            )
          : []
        const precheckOf = (g: string) => precheckStats(precheckAll.filter(l => l.rig === g))
        // --tokens reads what runs stored (record().sessions) and manager-usage.jsonl, never a live transcript
        const tokenArgs = args.includes('--tokens')
          ? ([
              picked.flatMap(r => (r.sessions ?? []).map(u => ({ ...u, run: r.id }))),
              new Set(picked.filter(r => fate(r) === 'shipped').map(r => r.id)),
              managerUsage(since_),
            ] as const)
          : null
        if (args.includes('--json'))
          console.log(
            JSON.stringify({
              all: metrics(picked),
              ...(tokenArgs && { tokens: tokensReport(...tokenArgs) }),
              precheck: precheckStats(rig ? precheckAll.filter(l => l.rig === rig) : precheckAll),
              launches,
              rigs: Object.fromEntries(groups.map(g => [g, { ...of(g), precheck: precheckOf(g) }])),
            }),
          )
        else {
          console.log(
            render(
              metrics(picked),
              `${basename(HOME)}${since ? `, last ${days}d` : ''}`,
              precheckStats(rig ? precheckAll.filter(l => l.rig === rig) : precheckAll),
            ),
          )
          if (groups.length > 1) for (const g of groups) console.log('\n' + render(of(g), g, precheckOf(g)))
          if (launches.length)
            console.log('\nlaunches by harness and model:\n' + renderLaunches(launchStats(launches)))
        }
        if (tokenArgs && !args.includes('--json')) console.log('\n' + renderTokens(...tokenArgs))
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
          const [key, question, optionsLine, ...extra] = rest
          if (!key || !question || !optionsLine)
            fail(
              'usage: factory decisions propose <key> "<question>" "<label: effect | label: effect>" [--context "<sentence>"]',
            )
          const ci = extra.indexOf('--context')
          const context = ci === -1 ? undefined : extra[ci + 1]
          if (ci !== -1 && !context) fail('usage: ... --context "<sentence>" needs a value')
          const leftover = ci === -1 ? extra : extra.filter((_, i) => i !== ci && i !== ci + 1)
          if (leftover.length)
            fail(
              `unknown argument${leftover.length > 1 ? 's' : ''} "${leftover.join(' ')}": only --context "<sentence>" is allowed`,
            )
          decisionsPropose(key!, question!, optionsLine!, context)
          break
        }
        fail(`unknown decisions command "${sub}": list, answer or propose`)
        break
      }
      case 'plan': {
        const [sub, arg] = args
        if (!sub || sub === 'show') {
          console.log(planShowText())
          break
        }
        if (sub === 'facts') {
          await planFactsCmd()
          break
        }
        if (sub === 'set') {
          if (!arg) fail('usage: factory plan set <file>')
          planSetCmd(arg)
          break
        }
        fail(`unknown plan command "${sub}": facts, set <file> or show`)
        break
      }
      case 'advisories': {
        if (args[0] !== 'file') fail('unknown advisories command: file <path>')
        advisoriesFileCmd(args[1])
        break
      }
      case 'review': {
        const [sub, a1, a2] = args
        if (sub === 'facts') console.log(JSON.stringify(reviewFacts(a1)))
        else if (sub === 'set') reviewSet(a1, a2)
        else fail('review facts <key> | set <key> <file>')
        break
      }
      case 'gate-brief': {
        const [sub, a1, a2] = args
        if (sub === 'facts') {
          console.log(JSON.stringify(await gateBriefFacts(a1)))
          break
        }
        if (sub === 'set') {
          await gateBriefSet(a1, a2)
          break
        }
        fail(`unknown gate-brief command "${sub}": facts <run> or set <key> <file>`)
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
      case 'hygiene': {
        if (!args[0]) fail('usage: factory hygiene <rig|repo>')
        const repo = repoOf(args[0]!)
        const r = await hygienePass({ name: rigOf(repo)?.name ?? args[0]!, repo }, false)
        console.log(JSON.stringify({ findings: r.findings, ghError: r.ghError }, null, 2))
        break
      }
      case 'ship': {
        if (!args[0]) fail('usage: factory ship <rig|repo>')
        console.log(shipQueueText(beads(repoOf(args[0]!), 'factory').shipQueue()))
        break
      }
      case 'status':
        await status(args[0])
        break
      case 'digest':
        await digest()
        break
      case 'waiting': {
        const rows = await Promise.all(
          startedRunIds().map(async id => {
            const { run, value, c } = current(id)
            const def = await loadFactory(run.factory)
            return row(run, def, value, c, agentOf(def, value, c))
          }),
        )
        console.log(waiting(rows, Date.now(), shipQueues()))
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
        // claude-factory-72v.19: same second CLI-side layer as beadFor's isOwned check above,
        // behind the mod's own regex deny for this command.
        if (process.env.FACTORY_PATROL) fail('a patrol cannot decide a gate: leave it for the person')
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
        // --wake comes right after the box; in a later word it stays text
        const [id, to, ...rest] = args
        const wake = rest[0] === '--wake'
        const text = wake ? rest.slice(1) : rest
        const run = loadRun(id)
        const def = await loadFactory(run.factory)
        const workerFrom =
          process.env.FACTORY_FROM && process.env.FACTORY_FROM !== 'manager'
            ? process.env.FACTORY_FROM
            : undefined
        if (workerFrom !== undefined && !Object.hasOwn(def.nodes, workerFrom))
          fail('FACTORY_FROM must name a station of this factory')
        const boxes = Object.keys(def.nodes).concat('manager')
        if (!boxes.includes(to ?? '')) fail(`mailbox must be one of: ${boxes.join(', ')}`)
        post(run.id, {
          type: 'MAIL',
          from: workerFrom ?? managerSender(run),
          to: to!,
          text: text.join(' '),
          ...(wake && { wake: true as const }),
        })
        console.log(`mailed ${to}`)
        const { c } = current(run.id)
        if (!wake && isMailHeld(c, to!, def.nodes[to!]?.holdMail)) {
          const last = c.log.at(-1)!
          const urls = [...prsIn(last.summary), ...mrsIn(last.summary)]
          console.log(
            `held for ${to}: parked on ${urls.join(', ')}; it starts a worker when one changes or at ${new Date(c.wakeAt).toISOString()}; add --wake to start one now`,
          )
        }
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
        post(run.id, { type: 'MAIL', from: managerSender(run), to: node, text: text.join(' ') || nudge })
        console.log(`poked ${node} of ${run.id}`)
        break
      }
      case 'retry': {
        const { run, value, c } = current(args[0])
        const [node, sub] = where(value)
        if (sub !== 'stuck')
          fail(
            `${run.id} is at ${node}${sub ? `/${sub}` : ''}, not stuck: RETRY only applies to a stuck station; run ${CLI} goto ${run.id} ${node} to restart it`,
          )
        const runner = c.pane ? runnerOf(c.pane) : runnerOfStation(run, await loadFactory(run.factory), node)
        const unavailable = runner.name === 'ax' ? ax.unavailable() : undefined
        if (unavailable) fail(unavailable)
        post(run.id, { type: 'RETRY' })
        break
      }
      case 'goto': {
        const run = loadRun(args[0])
        const nodes = Object.keys((await loadFactory(run.factory)).nodes).concat('done')
        if (!nodes.includes(args[1] ?? '')) fail(`node must be one of: ${nodes.join(', ')}`)
        const target = args[1]!
        const saved = readJson<Saved>(join(runDir(run.id), 'state.json'))
        const pending = inboxLines(run.id)
          .slice(saved.cursor)
          .map(l => JSON.parse(l) as Ev)
        const queued = pending.find(e => e.type === 'GOTO')
        if (queued?.type === 'GOTO')
          fail(
            `a goto to ${queued.node} is queued since ${new Date(queued.at).toISOString()} and not applied yet: the next tick applies it. Do not repeat it; mail sent now reaches ${queued.node}`,
          )
        const why = gotoRefusal(await loadFactory(run.factory), saved.snapshot, pending, target, Date.now())
        if (why)
          fail(
            `goto ${target} would not move ${run.id}: ${why}` +
              (why.includes('step budget')
                ? `; run factory retry ${run.id} to grant more launches first`
                : ''),
          )
        post(run.id, { type: 'GOTO', node: target })
        console.log(`queued goto ${target} for ${run.id}: the next tick applies it`)
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
        const [max, sweeps, slo, runner, agent, mcp, linear, linearProjects, linearLabels] = [
          opt('--max'),
          opt('--sweeps'),
          opt('--slo'),
          opt('--runner'),
          opt('--agent'),
          opt('--mcp'),
          opt('--linear'),
          opt('--linear-projects'),
          opt('--linear-labels'),
        ]
        const params: string[] = []
        while (args.includes('--param')) params.push(opt('--param') ?? '')
        const egress: string[] = []
        while (args.includes('--egress')) egress.push(opt('--egress') ?? '')
        const personOnlyContext: string[] = []
        while (args.includes('--person-only-context'))
          personOnlyContext.push(opt('--person-only-context') ?? '')
        const protectedBranch: string[] = []
        while (args.includes('--protected-branch')) protectedBranch.push(opt('--protected-branch') ?? '')
        const mergeAuth = args.includes('--merge-authority')
        if (mergeAuth) args.splice(args.indexOf('--merge-authority'), 1)
        const [sub = 'list', name, repo, factory = 'lifecycle'] = args
        if (sub === 'add') {
          if (!name || !repo)
            fail(
              `usage: factory rig add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--slo cmd] [--runner ${Object.keys(runners).join('|')}] [--agent cmd] [--mcp file] [--param name=value]... [--egress host[,host]...[=KEY[:Header:Prefix]]]... [--person-only-context ctx]... [--protected-branch b]... [--merge-authority] [--linear team_id[,team_id] [--linear-projects name[,name]] [--linear-labels name[,name]]] [--goal text...]`,
            )
          const rig = await defineRig(name!, repo!, factory, {
            max,
            sweeps,
            slo,
            goal,
            runner,
            agent,
            mcp,
            params,
            egress,
            personOnlyContext,
            protectedBranch,
            mergeAuthority: mergeAuth,
            linear,
            linearProjects,
            linearLabels,
          })
          mkdirSync(HOME, { recursive: true })
          // one rig per repo (runs find their rig by repo): redefining a rig replaces it, but a second
          // name for a rigged repo would silently drop the first
          const taken = rigs().find(r => r.repo === rig.repo && r.name !== rig.name)
          if (taken)
            fail(
              `${rig.repo} is already rig ${taken.name}: redefine it under that name, or rig rm ${taken.name} first`,
            )
          writeJson(rigsFile(), [...rawRigs().filter(r => r.name !== rig.name && r.repo !== rig.repo), rig])
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
            rawRigs().filter(r => r.name !== name),
          )
          console.log(`removed rig ${name}: nothing new starts there; its runs carry on`)
        } else if (sub === 'list') {
          const { busy, held } = await busyRigs()
          if (!rigs().length) console.log('no rigs: factory rig add <name> <repo> [factory]')
          for (const r of rigs()) {
            // a stuck run holds this rig's own slot, so it counts here too (not the town's)
            const n = busy.filter(b => b === r.name).length + held.filter(h => h === r.name).length
            let sweepsLine = r.sweeps
            if (sweepsLine === undefined) {
              try {
                sweepsLine = sweepNames(await loadFactory(factorySource(r.sweepsFactory ?? 'sweeps', r.repo)))
              } catch {
                sweepsLine = []
              }
            }
            console.log(
              `${r.name}  ${r.repo}  ${r.factory}  busy ${n}${r.maxRuns ? `/${r.maxRuns}` : ''}  sweeps ${sweepsLine.join(',') || 'none'}`,
            )
            if (r.goal) console.log(`  goal: ${r.goal}`)
            if (r.slo) console.log(`  slo: ${r.slo}`)
            if (r.agent) console.log(`  agent: ${r.agent}`)
            if (personOnlyContexts(r)?.length)
              console.log(`  person-only contexts: ${personOnlyContexts(r)!.join(', ')}`)
            if (protectedBranches(r)?.length)
              console.log(`  protected branches: ${protectedBranches(r)!.join(', ')}`)
            if (r.mergeAuthority === true)
              console.log(`  merge authority: ship release station, ${mergeAuthority(r) ?? 'no origin: off'}`)
            if (r.mcp) console.log(`  mcp: ${r.mcp}`)
            for (const [k, v] of Object.entries(r.params ?? {})) console.log(`  param ${k}: ${v}`)
            if (r.linear) {
              const extra = [
                r.linear.projects?.length ? `projects ${r.linear.projects.join('|')}` : '',
                r.linear.labels?.length ? `labels ${r.linear.labels.join('|')}` : '',
              ].filter(Boolean)
              console.log(
                `  linear: team ${r.linear.team.join(',')}${extra.length ? `, ${extra.join(', ')}` : ''}${linearSyncLine(r.name)}`,
              )
            }
          }
          console.log(`town: busy ${busy.length}/${MAX_BUSY}, stuck ${held.length}`)
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
        rmSafe(runDir(run.id), { recursive: true })
        console.log(`removed ${run.id}; its work stays on branch ${run.branch}`)
        break
      }
      case 'gc': {
        const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
        const dryRun = args.includes('--dry-run')
        if (args.includes('--worktrees')) {
          const rigName = opt('--rig')
          const release = hold('gc-worktrees.lock')
          if (!release) {
            console.log('a gc --worktrees pass is already running: skipped this one')
            break
          }
          try {
            // a failed pass waits for the next window too, not every tick (same rule as gc.stamp);
            // --dry-run never stamps, so it never changes HOME at all (AC1)
            if (!dryRun) writeFileSync(join(HOME, 'gc-worktrees.stamp'), '')
            gcWorktreesPass(dryRun, rigName)
          } finally {
            release()
          }
          break
        }
        const daysArg = opt('--days') ?? process.env.FACTORY_GC_DAYS
        const days = daysArg === undefined ? 7 : Number(daysArg)
        if (!(days > 0)) fail('usage: factory gc [--days N] [--dry-run]: --days must be a positive number')
        const release = hold('gc.lock')
        if (!release) {
          console.log('a gc pass is already running: skipped this one')
          break
        }
        try {
          writeFileSync(join(HOME, 'gc.stamp'), '') // a failed pass waits for the next window too, not every tick
          gcPass(days, dryRun)
        } finally {
          release()
        }
        break
      }
      case 'sweep': {
        const release = hold('sweeps.lock')
        if (!release) {
          console.log('a sweep pass is already running: skipped this one')
          break
        }
        try {
          // a failed pass waits for the next window too, not every tick (the same rule as gc.stamp
          // and gc-worktrees.stamp): write this before the pass, not after
          writeFileSync(join(HOME, 'sweeps.stamp'), '')
          await sweep()
        } finally {
          release()
        }
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
