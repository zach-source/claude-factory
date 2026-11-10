// The factory runner: owns .factory/, drives herdr, feeds the xstate machines.
// Only `tick` writes run state (under a lock); every other command appends to
// the run's inbox.jsonl, which the next tick drains in order.
import './vm-env' // first: it may re-run the process with the packed AX env
import { codexAuth as managerCodexAuthState, codexAuthMail } from './codex-auth'
import {
  devenvRows,
  isDevenvKey,
  loadIntoEnv,
  readDevenv,
  readSettings,
  setDevenv,
  setSetting,
  SETTING_KEYS,
  settingsRows,
  unsetDevenv,
  unsetSetting,
} from './settings'
import { tokenCommand } from './claude-token'
import { buildImage, IMAGE_KEY, type Target } from './image'
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
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  isLiveRead,
  isPrWait,
  WORKER_OUTCOMES,
  parkDelayMin,
  prevReport,
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
import { otelOf, type Otel } from './otel'
import { watchDecide, WATCH_FAIL_PASSES, type Seen, type WatchedPr } from './watch'
import { sweepNames as axSweepNames, type SweepRun } from './axsweep'
import { ORPHAN_CAP, orphanSweep, type OrphanCtx, type OrphanPr } from './orphans'
import {
  actorOf,
  backlogOf,
  beads,
  dispatchable,
  factoryOf,
  goalOf,
  shipBranchOf,
  isHandedOff,
  isOwned,
  OWNER,
  REJECTED,
  isHoldLabel,
  LABEL,
  NAME,
  linearSourced,
  byId,
  parentOf,
  shipQueueText,
  stationOf,
  type Bead,
} from './beads'
import { clusterKey } from './filing-guard'
import {
  rigPaths,
  routeLine,
  SECURITY_REASON,
  securityRoute,
  SENSITIVE_ENTRY,
  type SecurityRoute,
} from './security-route'
import { applyRigChange, editRigs, redactRig, snapshots } from './rigs-edit'
import { hideParseText, hideSecret } from './secrets'
import * as plan from './plan'
import { parseAdvisoryInput, planAdvisories } from './advisories'
import { filingActor, filingGuard } from './filing-guard'
import {
  clipUtf8,
  driftDuplicates,
  dueSweeps,
  failedTests,
  flakeCandidates,
  flakyRuns,
  mainCiReds,
  newCiReds,
  type GhRun,
  guardHandled,
  markGuardHandled,
  MONITOR_RECHECK_MIN,
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
  CURSOR_FLAGS,
  type Harness,
  GROK_FLAGS,
  claudeCommand,
  codexFeaturesBad,
  beadsOnlyCodexDir,
  codexSkills,
  command,
  SandboxPathError,
  seatbelt,
  cutOffCall,
  cutOffNote,
  harnessOf,
  skillsFor,
  piFlags,
  readMcp,
  sq,
  VM_PLUGINS,
  writeLaunch,
} from './harness'
import { hold as holdOf, shipLines, tokens, waiting, waitingItems } from './sidebar'
import {
  CODEX_MODEL,
  briefOnce,
  keepTick,
  patrolOnce,
  pmOnce,
  reviewOnce,
  runModelAsync,
  type TickOut,
  type Io,
} from './once'
import { guardHook } from './core/chat'
import { check } from './core/guards'
import { REPAIR_CAP, closableParents, conflictProbes, heldBeads, repairs, type PrFact } from './repairs'
import { digestText, type DigestRig, type RepairLog } from './state'
import * as devenv from './devenv'
import { GAPS_FILE, parity } from './parity'
import { pgScratch } from './pg-scratch'
import * as gc from './gc'
import * as selfupdate from './selfupdate'
import { defaultHome, inStore, needsInstall, platformHome, upCheck, upDir } from './up'
import { kickEnv } from './kick-env'
import * as memory from './memory'
import {
  flagLine,
  groomCap,
  groomPlan,
  groomPrompt,
  humanLines,
  outsidePlan,
  pageMatches,
  parse as parseWikiPage,
  renderRigPage,
  rigList,
  scanPages,
  tombstones,
  WIKI_PAGE_PATH,
  type Merged,
  type RigRow,
} from './wiki'
import type { Page } from './wiki'
import * as ax from './ax'
import { codexChatLaunch } from './manager-codex'
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
import { realPath } from './token-guard'
import { REASON, boundedRun } from './screen'
import * as client from './client'
import { backupAge, backupError, backupWanted } from './homebackup'
import * as managerhost from './managerhost'
import * as leases from './lease'
import * as herdrApp from './herdr-install'
import * as migrate from './migrate'
import {
  bdEnv,
  bdExports,
  hasRigBeads,
  httpsRemote,
  inAx,
  isLaptopPane,
  mapRigs,
  mapRunRepo,
  mapRunWorktree,
  stationRunnerName,
  syncRepos,
} from './axrepos'
import * as broker from './broker'
import * as server from './server'
import { personCerts } from './server-api'
import { AUTO_LABEL, autoPick, autoQueueOf, recentPicks, type AutoQueue } from './autoqueue'
import * as pkggate from './pkggate'
import { startUi, withBeads } from './ui'
import { DEFAULT_RUNNER, runnerOf, runners, type Job, type Runner, type WorkerInfo } from './runner'
import { signingProbe } from './signing'
import {
  attachMerges,
  createdAt,
  fate,
  denialStats,
  launchStats,
  metrics,
  parseDenialLines,
  parseLaunchLines,
  inWindow,
  parsePrecheckLines,
  parseRecords,
  precheckStats,
  render,
  renderDenials,
  renderLaunches,
  renderTokens,
  sessionOf,
  type RunRecord,
  type ManagerUsage,
  tokensReport,
  type StoredUsage,
  validStart,
  parseStartLines,
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
  githubLabelArgv,
  githubCommentArgv,
  githubMergedJson,
  gitlabMergedJson,
  githubUnlabelArgv,
  githubPullPath,
  githubChecks,
  gitlabChecks,
  githubPulls,
  githubRows,
  githubSlugOf,
  githubWatchView,
  parseGithubView,
  parseGitlabView,
  prRef,
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
import { rmQuiet, rmSafe } from './home-guard'
import { ciReport, failedChecks } from './ci'
import { cut } from './cut'
import {
  mainChatKind,
  mainChatRefusal,
  managerSender as managerSenderIn,
  refuseWorker as refuseWorkerIn,
  workerMarker,
} from './core/caller'
import type { Ctx as OpCtx, Env, Input as OpInput, Port, Print, RunResult as OpResult } from './core/catalog'
import { slimBoard, snapshot as snapshotRun } from './core/catalog'
import * as backlogOp from './core/ops/backlog'
import * as decisionsOp from './core/ops/decisions'
import * as gatesOp from './core/ops/gates'
import * as gcOp from './core/ops/gc'
import * as leaseOp from './core/ops/lease'
import { flowMermaid, flowTable, type FlowGraph, type FlowRun } from './flows'
import * as flowsOp from './core/ops/flows'
import * as metricsOp from './core/ops/metrics'
import * as planOp from './core/ops/plan'
import * as prsOp from './core/ops/prs'
import * as rigsOp from './core/ops/rigs'
import * as runsOp from './core/ops/runs'
import { cursorCap, cursorLine, cursorMeter, cursorVerdict, refreshCursorMeter } from './cursor-meter'
import { grokBudget, grokLine, grokSpent, grokVerdict, logGrokSpend } from './grok-meter'
import { maskAssignments } from './worker-hook'

const ROOT = resolve(import.meta.dir, '..')
// the platform data dir, unless only an old default (the checkout's .factory-state, or ~/factory) holds a factory
const DEFAULT = defaultHome(
  platformHome(process.env, process.platform, homedir()),
  [join(ROOT, '.factory-state'), join(homedir(), 'factory')],
  d => existsSync(join(d, 'rigs.json')),
)
const DEFAULT_HOME = DEFAULT.dir
let noted = false
/** DEFAULT_HOME, and the one-line note on stderr (once) when it is an old default */
function usedDefault(): string {
  if (DEFAULT.note && !noted) console.error(DEFAULT.note)
  noted = true
  return DEFAULT_HOME
}
/** a factory is a directory holding its rigs.json (Gas Town's town); its runs live there too */
const factoryAt = (dir: string): string | undefined =>
  existsSync(join(dir, 'rigs.json')) ? dir : dirname(dir) === dir ? undefined : factoryAt(dirname(dir))
// a session or `loop` started inside a factory's directory works that factory
// absolute, so a relative FACTORY_HOME (`FACTORY_HOME=.`) still matches pane cwds and survives a cd
const HOME = process.env.FACTORY_HOME
  ? resolve(process.env.FACTORY_HOME)
  : (factoryAt(process.cwd()) ?? usedDefault())
/** where a repo keeps its own factories, versioned with its code */
const OWN = '.factory'
const CLI = join(ROOT, 'bin', 'factory')
// yolo: workers run unattended in their own worktree, so permission prompts would only stall them
const AGENT = `${claudeCommand()} --dangerously-skip-permissions`
// claude-factory-6g6ud: take the one-time Allow token out of the env, so no child process gets it
const ALLOW_TOKEN = process.env.FACTORY_ALLOW
delete process.env.FACTORY_ALLOW
/** the env before the stored settings fill it: `factory up` gives it to a manager of another dir */
const BOOT_ENV = { ...process.env }
loadIntoEnv(join(HOME, 'settings.json')) // stored settings fill unset env vars; the environment wins
const MAX_BUSY = Number(process.env.FACTORY_MAX_RUNS ?? 16)
const DISPATCH_MS = 30_000 // how often the rigs' ready beads are looked at
const LABELS_MS = 2 * 60_000 // how often the rigs' pull requests are checked for the labels below
const AX_SWEEP_MS = 10 * 60_000 // how often leaked AX tasks and workspaces are deleted (axSweep)
const ORPHANS_MS = 10 * 60_000 // how often the rigs' open factory drafts are swept for orphans (orphanPass)
// ponytail: pr-merger's default label names; make them a rig setting when a repo uses others
const CLOSE_LABEL = 'close'
const CONFLICT_LABEL = 'conflict'
const REWORK_LABEL = 'rework'
const FIX_TESTS_LABEL = 'fix-tests'
const REWORK_LABELS = [CONFLICT_LABEL, REWORK_LABEL, FIX_TESTS_LABEL]
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
export const REQUEUE_MAX = 5
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
  /** the ship branch a rework run started from: set once, so a later bead edit cannot move the security diff */
  shipBranch?: string
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
/**
 * the error of the run's last tick, in runs/<id>/tick-error.txt. The tick output goes away, so
 * `factory status` reads it from there. A tick with no error removes the file
 */
const tickErrorFile = (id: string) => join(runDir(id), 'tick-error.txt')
function keepTickError(id: string, error: string | undefined) {
  try {
    if (error) writeFileSync(tickErrorFile(id), `${new Date().toISOString()} ${error}\n`)
    else rmSync(tickErrorFile(id), { force: true })
  } catch {
    // best effort: the tick row still has the error
  }
}
const tickError = (id: string) =>
  existsSync(tickErrorFile(id)) ? readFileSync(tickErrorFile(id), 'utf8').trim() : undefined
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
  // an old Workspace keeps an old home and its .migrated: refuse it, unless a resume asks to keep it
  const reuse = args.includes('--reuse-workspace')
  if (!reuse && ax.workspaceExists(ax.managerTask())) fail(ax.staleWorkspaceRefusal(ax.managerTask()))
  const { name, policy } = await ax.launchManager(
    image!,
    args.filter(a => a !== '--reuse-workspace'),
    rawRigs(),
    { launch: reuse ? undefined : crypto.randomUUID() },
  )
  console.log(
    `the manager runs in AX task ${name}${policy ? '' : ' (its egress policy is NOT created: the task has no egress; check the AX controller)'}`,
  )
  console.log("attach with `factory attach`, steer with `factory say '<text>'`")
}
/** refuse to run a manager or a tick here while the AX manager task lives (claude-factory-192.6) */
const lease = () => {
  const m = ax.remoteManager()
  if (m) fail(m)
}
/**
 * takes or renews the local manager lease (claude-factory-s01d.2). It returns the lease of the
 * other holder when that holder keeps it. A busy lock refuses, unless this holder has a live lease.
 */
function localLease(want = leases.asker(process.env, process.ppid)): leases.Lease | undefined {
  const release = hold('lease.lock')
  if (!release) {
    // a take of the same holder (a tick beside a patrol) holds the lock: a live lease of this holder is still ours
    const cur = leases.readLease(HOME)
    if (cur && cur.holder === want.holder && !leases.isStale(cur, Date.now())) return undefined
    return cur ?? { holder: 'unknown', kind: 'cli', at: Date.now() }
  }
  try {
    const d = leases.take(HOME, want)
    return d.ok ? undefined : d.lease
  } finally {
    release()
  }
}
/** the board with no tick: what a manager without the lease shows. It changes no run. */
async function readOnlyBoard(holder: leases.Lease) {
  const runs: Row[] = []
  for (const id of startedRunIds()) {
    try {
      const { run, value, c } = current(id)
      const def = await loadPinned(run.factory)
      runs.push(row(run, def, value, c, agentOf(def, value, c)))
    } catch (err) {
      runs.push({ id, error: (err as Error).message })
    }
  }
  return {
    readOnly: leases.leaseLine(holder, Date.now()),
    lease: holder,
    runs,
    manager: [],
    managerLimited: managerLimited() ?? null,
    managerCodexAuth: managerCodexAuthState(HOME),
    rigs: rigs(),
  }
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
  /** the rig origin's GitHub repo, for the reviewer's API rule */
  githubRepo?: string
  policy: boolean
  put?: string[]
  /** when a put has been failing over ax ssh since, and its ax stderr; a success clears both */
  putFailedAt?: number
  putError?: string
  /** the part of the first file in `put` that the next tick sends (a put sends at most PUT_TICK_PARTS parts a tick) */
  putPart?: number
  /** the memory snapshot the VM got (claude-factory-vffe.4), or why it got none */
  memory?: { bytes: number; parts: number; sentAt: number }
  memorySkipped?: string
  /** where the VM shares the rig's beads, as at its launch: absent, the repo's GitHub origin */
  beadsRemote?: Rig['beadsRemote']
}
/**
 * Write the memory snapshot file for a launch. `put` is true when the file must go to the VM.
 * `skipped` says why not: the snapshot is over `max` bytes, or `memory.snapshot` threw.
 * A failure here never blocks the launch.
 */
export function memorySnapshotPut(
  mem: string,
  rig: string | undefined,
  out: string,
  max = memory.MEMORY_SNAPSHOT_MAX,
): { put: boolean; skipped?: string } {
  try {
    const snap = memory.snapshot(mem, rig, out)
    if (!snap) return { put: false }
    if (snap.bytes <= max) return { put: true }
    rmSync(out, { force: true })
    return { put: false, skipped: `${snap.bytes} bytes, over the ${max} byte cap` }
  } catch (e) {
    rmSync(out, { force: true })
    return { put: false, skipped: cleanText(String(e), 300) }
  }
}
const sideFile = (run: Run, task: string) => join(runDir(run.id), `${task}.json`)
/** how long a failing put is retried before the attempt fails: a VM still waking fails ssh for a tick or two */
const PUT_GRACE_MS = 5 * 60_000
/** ax ssh calls that a put sends in one tick: each can wait up to 30 s, and the tick waits on it */
const PUT_TICK_PARTS = 8

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
  // a VM expands --summary-file, --text-file and --body-file before it queues; a line that still has it would read a laptop file
  if (cmd === 'report' && id === run && seq === String(side.seq))
    return argv[4] === '--summary-file' ? null : argv
  if (cmd === 'mail' && id === run)
    return argv[3] === '--text-file' || (argv[3] === '--wake' && argv[4] === '--text-file') ? null : argv
  if (cmd === 'memory' && (id === 'add' || id === 'helped')) {
    if (argv.includes('--body-file')) return null
    const rest = argv.slice(2).filter((w, i, a) => w !== '--from' && a[i - 1] !== '--from')
    // the forced --from goes first: a bare trailing flag (--rig) cannot take it as its value (claude-factory-zw2n)
    return ['memory', id, '--from', `${run}/${side.node}`, ...rest]
  }
  return null
}

/**
 * `report <run> <seq> <outcome> --summary-file <path>` -> [run, seq, outcome, <file text>]; any other args pass
 * unchanged. The flag counts only right after the outcome, with exactly one path and a non-blank file. A bad form
 * throws. A whole word `--summary-file` in a later slot also throws: it would post the flag as text and lose the
 * report. A VM expands it before it queues, so the laptop never reads a path a VM chose (see `replayable`)
 */
export function summaryArgs(args: string[]): string[] {
  if (args[3] !== '--summary-file') {
    if (args.slice(3).includes('--summary-file'))
      return fail(
        'usage: factory report <run> <seq> <outcome> --summary-file <path> (the flag must follow the outcome)',
      )
    return args
  }
  const path = args[4]
  if (!path || args.length !== 5)
    return fail(
      'usage: factory report <run> <seq> <outcome> --summary-file <path> (one path, nothing after it)',
    )
  const text = readTextFile('--summary-file', path)
  return [...args.slice(0, 3), text]
}

/** the flags of `memory add` that take a value */
const MEMORY_ADD_VALUE_FLAGS = ['--rig', '--from', '--kind', '--until', '--supersedes']

/**
 * claude-factory-jho3: expand a file flag to the inline form. Three forms exist:
 * report --summary-file (see summaryArgs);
 * mail <run> <box> [--wake] --text-file <path>, which counts only in that slot (a later whole word throws);
 * memory add --body-file <path>, which replaces the body words.
 * The path goes through textFileArg. Other args pass unchanged. A bad form throws.
 * A VM expands before it queues, so the laptop never reads a path that a VM chose.
 * ponytail: a body file whose text starts with "--" fails the unknown-flag check of memory add. Upgrade: skip that check for the body-file value.
 */
export function fileArgs(cmd: string, args: string[]): string[] {
  if (cmd === 'report') return summaryArgs(args)
  if (cmd === 'mail') {
    const at = args[2] === '--wake' ? 3 : 2
    if (args[at] !== '--text-file') {
      if (args.slice(at).includes('--text-file'))
        return fail('usage: factory mail <run> <box> [--wake] --text-file <path> (the flag must come first)')
      return args
    }
    if (!args[at + 1] || args.length !== at + 2)
      return fail('usage: factory mail <run> <box> [--wake] --text-file <path> (one path, nothing after it)')
    return [...args.slice(0, at), textFileArg('--text-file', args[at + 1]!)]
  }
  if (cmd !== 'memory' || args[0] !== 'add' || !args.includes('--body-file')) return args
  const i = args.indexOf('--body-file')
  const path = args[i + 1]
  // a second --body-file, or a flag as the value, stays in the positional words or fails to read: both refuse
  if (!path) return fail('--body-file needs a path')
  const rest = args.filter((_, j) => j !== i && j !== i + 1)
  const words = rest
    .slice(1)
    .filter(
      (w, j, a) =>
        w !== '--anyway' &&
        !MEMORY_ADD_VALUE_FLAGS.includes(a[j - 1]!) &&
        !MEMORY_ADD_VALUE_FLAGS.includes(w),
    )
  if (words.length > 1) return fail('--body-file replaces the body words: give the summary and the file only')
  return [...rest, textFileArg('--body-file', path)]
}

/** the stat/size/read core of --summary-file and the text-file flags; a bad file fails with the flag and path named */
function readTextFile(flag: string, path: string): string {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return fail(`${flag} ${path} is not a readable file`)
    size = st.size
  } catch {
    return fail(`${flag} ${path} is not a readable file`)
  }
  // outside the try: fail() throws, and the catch would call this a missing file
  if (size > worker.OUTBOX_MAX_BYTES)
    return fail(
      `${flag} ${path} is ${size} bytes; the cap is ${worker.OUTBOX_MAX_BYTES} bytes (100 KiB): shorten it`,
    )
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return fail(`${flag} ${path} is not a readable file`)
  }
  if (!text.trim()) return fail(`${flag} ${path} is empty`)
  return text
}

/**
 * claude-factory-2z48: untrusted text (a bead, a Linear issue) reaches a verb by file, never in a shell argument.
 * The file must sit inside <FACTORY_HOME>/text/, or inside the real .scratch/ folder (not a symlink) of the git toplevel, and only when the cwd
 * is inside that toplevel, so injected text cannot steer a flag to a secret such as a token file. Returns the text without trailing whitespace.
 * ponytail: the verb does not delete the file, so text/ grows by one small file per filing. Upgrade: unlink after
 * success, or a gc pass.
 */
function textFileArg(flag: string, path: string): string {
  const dir = join(HOME, 'text')
  mkdirSync(dir, { recursive: true })
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return fail(`${flag} ${path} is not a readable file`)
  }
  const roots = [realpathSync(dir)]
  // jho3: a Codex worker in workspace-write mode can write only in its cwd, so <git toplevel>/.scratch/ counts too
  const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stderr: 'ignore' })
  if (top.exitCode === 0)
    try {
      // jho3.12: .scratch/ must be a real folder, not a symlink. The cwd must be inside the toplevel.
      const t = realpathSync(top.stdout.toString().trim())
      const s = realpathSync(join(t, '.scratch'))
      const cwd = realpathSync(process.cwd())
      if (s === join(t, '.scratch') && (cwd === t || cwd.startsWith(t + sep))) roots.push(s)
    } catch {} // no .scratch/: only text/ counts
  if (!roots.some(r => real.startsWith(r + sep)))
    return fail(
      `${flag} ${path} is outside ${dir} and the .scratch/ of the git worktree: write the text there first`,
    )
  return readTextFile(flag, real).trimEnd()
}

/** claude-factory-p1j6: fail on a Unicode Cc character (C0, DEL, C1) in untrusted text. A multiline field (a description) may keep newline and tab. The error names the code point, never the raw character. */
function refuseControlChar(field: string, text: string, multiline = false) {
  const m = (multiline ? /[^\P{Cc}\n\t]/u : /\p{Cc}/u).exec(text)
  if (m)
    fail(
      `${field} has the control character U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} at index ${m.index}: remove it`,
    )
}

const RUN_SCOPED = ['report', 'decide', 'mail', 'poke', 'retry', 'goto', 'abort', 'fork', 'rm']

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
  else if (cmd === 'memory') {
    // the memory case splices the first of each flag and its value out before it reads the subcommand: do the same
    const rest = [...args]
    for (const f of ['--rig', '--from', '--kind', '--until', '--supersedes'])
      if (rest.includes(f)) rest.splice(rest.indexOf(f), 2)
    if (rest[0] === 'add' || rest[0] === 'helped')
      args.forEach((a, i) => {
        if (a === '--from') named.push((args[i + 1] ?? '').split('/')[0])
      })
  }
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

/** True for an outbox line with a `deny` key and no `argv` key. It records a denial. It is not a command (claude-factory-dsfg). */
export function isDenyLine(line: string): boolean {
  try {
    const o = JSON.parse(line)
    return !!o && typeof o === 'object' && 'deny' in o && !('argv' in o)
  } catch {
    return false
  }
}

/**
 * The denial in an outbox deny line, or null. The VM worker writes the line, so the laptop does not trust it.
 * The grammar is closed. The deny object has exactly these keys: at (a finite number), harness, reason
 * (an upper-case constant name) and command (a string of 200 chars or fewer). The laptop adds run and station.
 * The laptop masks NAME=value in command again (claude-factory-ktrl): it does not trust the mask of the VM image.
 */
export function outboxDenial(
  line: string,
): { at: number; harness: string; reason: string; command: string } | null {
  if (!isDenyLine(line)) return null
  const d = JSON.parse(line).deny
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (Object.keys(d).sort().join() !== 'at,command,harness,reason') return null
  const ok =
    typeof d.at === 'number' &&
    Number.isFinite(d.at) &&
    ['claude', 'codex', 'pi', 'cursor', 'grok', 'unknown'].includes(d.harness) &&
    typeof d.reason === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(d.reason) &&
    typeof d.command === 'string' &&
    d.command.length <= 200
  return ok
    ? { at: d.at, harness: d.harness, reason: d.reason, command: cut(maskAssignments(d.command), 200) }
    : null
}

/** where bd keeps a repo's store: its Dolt server and database (`bd dolt show --json`) */
type DoltConn = { host: string; port: number; database: string; user: string; tls: boolean }

/** a beadsRemote name or user goes into SQL: the launch and `rig beads-remote set` check it with this one regex */
export const BEADS_WORD = /^[\w.-]+$/
const BEADS_WORD_MSG = 'beadsRemote name and user are [A-Za-z0-9_.-]'
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
  if (![r.name, r.user].every(s => BEADS_WORD.test(s))) fail(BEADS_WORD_MSG)
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
      .map(k => `${k}=${cut(String(row[`our_${k}`]), 200)}`)
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
  const show =
    r && !inAx()
      ? Bun.spawnSync(['bd', 'dolt', 'show', '--json'], { cwd: run.worktree, timeout: syncTimeoutMs() })
      : null
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

const NO_SUSPEND_MS = 24 * 3_600_000
const noSuspendFile = (run: Run) =>
  join(HOME, `ax-no-suspend-${(rigOf(run.repo)?.name ?? basename(run.repo)).replace(/[^\w.-]/g, '_')}.json`)
/**
 * True when AX failed to restore a worker of this run's rig less than 24 h ago. A suspended worker of
 * that rig can fail to restore. So the reconciler keeps it running (claude-factory-x500).
 * ponytail: a fixed 24 h window. Upgrade: clear the marker after one restore of that rig succeeds.
 */
function noSuspend(run: Run) {
  const m = existsSync(noSuspendFile(run)) ? readJson<{ at?: number }>(noSuspendFile(run)) : null
  return typeof m?.at === 'number' && Date.now() - m.at < NO_SUSPEND_MS
}
/** write the marker; the text of the one mail that tells the manager */
function markNoSuspend(run: Run, why: string) {
  const rig = rigOf(run.repo)?.name ?? basename(run.repo)
  writeJson(noSuspendFile(run), { at: Date.now(), why: cleanText(why, 500) })
  return `AX could not restore a ${rig} worker (${cleanText(why, 300)}). For 24 h the factory does not suspend ${rig} workers that wait on the manager, so no more of them fail the same way.`
}

const SKEW_PROBE_MS = 60 * 60_000
const SKEW_HOLD_MAX_MS = 3 * SKEW_PROBE_MS
const bdSkewFile = (run: Run) =>
  join(HOME, `bd-skew-${(rigOf(run.repo)?.name ?? basename(run.repo)).replace(/[^\w.-]/g, '_')}.json`)
/**
 * The bd error of an outbox line whose VM could not sync beads (schema skew), else undefined. The VM agent
 * writes the line, so a field of the wrong type, over 300 chars or without the skew text counts as absent.
 */
function bdSkewOf(line: string) {
  try {
    const { bdSkew } = JSON.parse(line)
    return typeof bdSkew === 'string' &&
      bdSkew.length <= 300 &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(bdSkew) &&
      worker.SKEW_RE.test(bdSkew)
      ? bdSkew
      : undefined
  } catch {
    return undefined
  }
}
/**
 * True while this run's rig has a fresh bd skew marker for this runner: no VM of the rig starts. After
 * SKEW_PROBE_MS one start goes through as the probe, and the marker's clock restarts for the others.
 * The hold ends SKEW_HOLD_MAX_MS after `since`, the first skew report; no report or probe moves `since`.
 * ponytail: a rig hold ends 3 h after the first skew report even if bd is still broken (then each station
 * gets only its own outage holds). Upgrade: probe bd on the image at serve setup.
 */
function bdSkewHeld(run: Run, runner: string, now: number) {
  const file = bdSkewFile(run)
  const m = existsSync(file) ? readJson<{ at?: number; since?: number; runner?: string }>(file) : null
  if (!m || m.runner !== runner || typeof m.at !== 'number') return false
  const since = typeof m.since === 'number' ? m.since : m.at
  if (now - since >= SKEW_HOLD_MAX_MS) return false
  if (now - m.at < SKEW_PROBE_MS) return true
  writeJson(file, { ...m, since, at: now })
  return false
}

/**
 * an AX worker's status, after replaying here the commands its outbox holds since the last look; a pending
 * or suspended task is not polled, and a failed or deleted one is gone, like a closed pane
 */
function taskInfo(run: Run, pane: string): WorkerInfo | null {
  const task = ax.taskOf(pane)
  const { phase, failure, queued } = ax.read(task)
  // `agent` set: the VM's agent is always there, so the reconciler never relaunches or restarts it as a pane's
  if (phase === 'Pending')
    return queued
      ? { status: 'pending', agent: 'ax', pending: 'waiting for a free AX worker', queued }
      : { status: 'pending', agent: 'ax', pending: 'task phase Pending' }
  if (phase === 'Suspended') return { status: 'suspended', agent: 'ax' }
  // gone, and why, kept next to the task's other files; `failed` carries it into the attempt's FAIL reason
  // (task .2's reconciler check) instead of the generic "worker pane ... was closed"
  const gone = (why: string): WorkerInfo => (
    writeFileSync(join(runDir(run.id), `${task}.gone`), `${new Date().toISOString()} ${why}\n`),
    { status: 'gone', failed: cleanText(why, 500) }
  )
  if (phase !== 'Running') {
    const info = gone(`phase ${phase ?? 'not found'}${phase === 'Failed' && failure ? `: ${failure}` : ''}`)
    if (phase === 'Failed' && failure?.startsWith('ActorResumeFailed') && !noSuspend(run))
      info.resumeFailed = failure
    return info
  }
  // a task this laptop did not launch (or launched before this file) has no station to act as: nothing replays
  const side: TaskSide | null = existsSync(sideFile(run, task)) ? readJson(sideFile(run, task)) : null
  if (side && !side.policy) {
    // an old reviewer task has no repo in its side file. It has no safe policy, so it gets no GitHub key.
    if (side.reviewer && !side.githubRepo) return gone('reviewer task has no githubRepo in its side file')
    // until it is in, the VM reaches nothing; the station's deadline fails a task whose actor never shows
    if (
      !ax.createPolicy(
        task,
        side.egress,
        side.gitlabHost,
        side.githubOwner,
        undefined,
        side.reviewer,
        false,
        side.githubRepo,
      )
    )
      return { status: 'pending', agent: 'ax', pending: 'egress policy not created' }
    writeJson(sideFile(run, task), { ...side, policy: true })
  }
  // what is too big for the task's env goes over ssh, in parts, and serve waits for it
  // At most PUT_TICK_PARTS parts a tick (each is an ssh call): putPart is where the next tick goes on
  let sent = 0
  put: for (const name of side?.put ?? []) {
    const file = join(runDir(run.id), `${task}.${name}`)
    const b64 = readFileSync(file).toString('base64')
    const parts = Math.max(1, Math.ceil(b64.length / ax.PUT_PART))
    for (let i = side!.putPart ?? 0; i < parts; i++) {
      if (sent++ >= PUT_TICK_PARTS) {
        writeJson(sideFile(run, task), { ...side, putPart: i })
        break put
      }
      const r = ax.put(task, name, i, parts, b64.slice(i * ax.PUT_PART, (i + 1) * ax.PUT_PART))
      if (r.ok) {
        side!.putFailedAt = undefined // a part landed: the 5 min grace restarts at the next failure
        side!.putError = undefined
        continue
      }
      // a VM still waking fails ssh too: this stays pending until the failure is PUT_GRACE_MS old
      const failedAt = side!.putFailedAt ?? Date.now()
      const err = cleanText(r.err.replace(/\s+/g, ' ').trim(), 300)
      writeJson(sideFile(run, task), { ...side, putPart: i, putFailedAt: failedAt, putError: err })
      if (Date.now() - failedAt < PUT_GRACE_MS)
        return { status: 'pending', agent: 'ax', pending: `${name} not yet copied to the VM` }
      return {
        status: 'failed',
        agent: 'ax',
        failed: `factory worker put ${name} failed for 5 min over ax ssh: ${err}`,
      }
    }
    side!.put = side!.put!.filter(n => n !== name)
    side!.putPart = undefined
    side!.putFailedAt = undefined
    side!.putError = undefined
    if (name === 'memory.tgz') {
      side!.memory = { bytes: statSync(file).size, parts, sentAt: Date.now() }
    }
    writeJson(sideFile(run, task), side)
    // remove the file after the save: a stop between the two would leave side.put naming a missing file
    if (name === 'memory.tgz') rmSync(file, { force: true }) // the VM has it; brief.md stays, as it always did
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
    if (isDenyLine(line)) {
      // a worker's denial: data, never a command, so no prompt and no spawn. A bad line is marked seen and dropped
      const d = outboxDenial(line)
      if (d) {
        try {
          appendFileSync(
            join(runDir(run.id), 'denials.jsonl'),
            JSON.stringify({ run: run.id, station: side?.node, ...d }) + '\n',
            { mode: 0o600 },
          )
        } catch {} // a log failure never blocks the replay of the lines after it
      }
      seen.seen[h] = (seen.seen[h] ?? 0) + 1
      writeJson(seenFile(run, task), seen)
      continue
    }
    const argv = outboxArgv(line)
    const big = argv && worker.outboxTooBig(argv)
    if (big && argv) {
      // Bun.spawnSync throws E2BIG on a huge argv, which would wedge this run on every tick: never spawn it
      try {
        appendFileSync(
          join(runDir(run.id), `${task}.outbox-too-big`),
          `${new Date().toISOString()} ${big} ${JSON.stringify(argv.slice(0, 3).map(w => cut(w, 80)))}\n`,
          { mode: 0o600 },
        )
      } catch {} // a log failure never blocks the replay of the lines after it
      seen.seen[h] = (seen.seen[h] ?? 0) + 1
      writeJson(seenFile(run, task), seen)
      ax.prompt(
        task,
        `[factory] your outbox line \`${cut(argv.slice(0, 3).join(' '), 200)} ...\` is ${big} bytes, over the ${worker.OUTBOX_MAX_BYTES}-byte cap (100 KiB): it was not run. Shorten the text and run the command again (for a report: a shorter --summary-file)`,
      )
      continue
    }
    const cmd = side && argv && replayable(argv, side, run.id)
    // FACTORY_OUTBOX off: here the command must act, not queue itself again; the sender is the station
    const env = {
      ...process.env,
      FACTORY_HOME: HOME,
      FACTORY_OUTBOX: '',
      FACTORY_FROM: side?.node,
      FACTORY_RUN: run.id,
    }
    // a report that went out without its bd sync is not replayed: its text goes to the journal in a hold
    const skew = cmd && argv![0] === 'report' ? bdSkewOf(line) : undefined
    const p = cmd && !skew ? Bun.spawnSync([CLI, ...cmd], { env }) : null
    if (!p && !skew)
      ax.prompt(
        task,
        `[factory] \`${argv?.join(' ') ?? cut(line, 200)}\` is not yours to run: a worker reports on its own attempt, mails, adds memory and says which memory helped`,
      )
    else if (p && p.exitCode !== 0)
      ax.prompt(task, `[factory] \`${argv!.join(' ')}\` was refused: ${p.stderr.toString().trim()}`)
    // the worker pushed before reporting, and the local worktree is what the next launch pushes back:
    // best effort, the report stands either way
    // the same for its bd writes, which it pushed where the rig's VMs share its beads
    else if (argv![0] === 'report') {
      try {
        const rows = validUsage(JSON.parse(line).usage, side!.node, side!.seq)
        // first report wins per node+seq: a replayed line must not add rows again (halt rows do not count)
        if (
          rows.length &&
          !storedUsage(run.id).some(r => r.node === side!.node && r.seq === side!.seq && !r.halt)
        )
          appendUsage(run.id, rows)
      } catch {} // a bad usage never changes the report
      try {
        // claude-factory-ad6r: the VM's start record. rig, sandbox, node and seq are the laptop's, never the VM's
        const start = validStart(JSON.parse(line).start)
        const file = join(HOME, 'starts.jsonl')
        const have = existsSync(file) ? parseStartLines(readFileSync(file, 'utf8')) : []
        if (start && !have.some(l => l.run === run.id && l.node === side!.node && l.seq === side!.seq)) {
          const rig = rigOf(run.repo)
          const row = {
            at: Date.now(),
            run: run.id,
            rig: rig?.name ?? '(no rig)',
            sandbox: rig?.sandboxClass ?? 'gvisor',
            node: side!.node,
            seq: side!.seq,
            ...start,
          }
          appendFileSync(file, JSON.stringify(row) + '\n')
        }
      } catch {} // a bad start never changes the report
      Bun.spawnSync(['git', '-C', run.worktree, 'pull', '--ff-only', 'origin', run.branch])
      if (!skew) {
        // from where this VM was told to push, which a rig changed since does not move
        if (vmBeads(run)) syncRigBeads(run, 'pull', side?.beadsRemote)
        rmSync(bdSkewFile(run), { force: true }) // a report with a good pull: bd on the VM works again
      }
    }
    seen.seen[h] = (seen.seen[h] ?? 0) + 1
    writeJson(seenFile(run, task), seen)
    if (skew)
      return {
        status: 'gone',
        agent: 'ax',
        bdSkew: skew,
        failed: `needs the person: bd version skew on ax (\`${skew}\`). The worker wrote, unverified: ${cleanText(argv![3] ?? '', 40)}: ${clipReport(cleanText(argv!.slice(4).join(' '), Infinity))}`,
      }
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
  // the one-line "serve died:" message first: gone() clips from the front, and a long stack would cut git's fatal line
  const died = polled.log?.split('\n').findLast(l => l.includes('serve died: '))
  return polled.status === 'exited'
    ? gone(
        died
          ? `serve exited: ${died.slice(died.indexOf('serve died: '))}`
          : `serve exited; its log: ${polled.log || '(empty)'}`,
      )
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
  close(address) {
    const task = ax.taskOf(address)
    const failed = ax.remove(task)
    // the axSweep pass retries a delete that failed here
    if (failed)
      appendFileSync(join(HOME, 'ax.log'), `${new Date().toISOString()} remove ${task} failed: ${failed}\n`)
  },
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
  // commits name a bead by its short id too, with or without a prefix: acme-blocks-4t9a, ab-4t9a, (4t9a)
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
/** the rig repo's info/private-patterns text for the VM (the guard hooks read it there), or undefined when the repo has none */
export function privatePatterns(repo: string) {
  const p = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const file = join(p.stdout.toString().trim(), 'info', 'private-patterns')
  return p.exitCode === 0 && existsSync(file) ? readFileSync(file, 'utf8') || undefined : undefined
}

function git(cwd: string, ...args: string[]) {
  if (memory.gitFenced(cwd)) fail(`git: ${cwd} is fenced, check ${cwd}/.git and remove ${cwd}.fenced`)
  const probe = Bun.spawnSync(['git', '-C', cwd, 'var', 'GIT_AUTHOR_IDENT'], { env: process.env })
  const env = probe.exitCode === 0 ? process.env : { ...process.env, ...MEMORY_GIT_IDENTITY_FALLBACK }
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { env })
  let i = 0
  while (args[i] === '-c') i += 2
  return p.exitCode === 0 ? p.stdout.toString().trim() : fail(`git ${args[i]}: ${p.stderr.toString().trim()}`)
}

/** every git call that can reach a remote (fetch, ls-remote, push) gets this: a credential prompt
 * never blocks (it fails instead), and a timeout caps how long a hung connection can hold
 * gc-worktrees.lock (claude-factory-l38.12). It never skips hooks. */
/** at call time: in the AX manager host, worker.trustCA sets GIT_SSL_CAINFO after this module loads */
export const gitNetworkEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })
const GIT_NETWORK_TIMEOUT_MS = 30_000

/**
 * the factory a new run follows: a path as given; else the repo's own `.factory/<name>.ts` in `checkout`
 * (the run's worktree, or the default branch's `.factory/` for a run on a PR branch); else the template of that name
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
/** claude-factory-1d9l: `.factory/` as `commit` holds it, in a new temp dir; a run on a PR branch never loads the branch's own */
function factoryDirAt(repo: string, commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-base-'))
  try {
    const has = Bun.spawnSync(['git', '-C', repo, 'ls-tree', '--name-only', commit, '--', OWN], {
      stderr: 'pipe',
    })
    if (has.exitCode !== 0) throw new Error(has.stderr.toString().trim())
    if (!has.stdout.toString().trim()) return dir // base has no .factory/: templates only
    const tar = Bun.spawnSync(['git', '-C', repo, 'archive', '--format=tar', commit, '--', OWN], {
      stderr: 'pipe',
    })
    const x =
      tar.exitCode === 0
        ? Bun.spawnSync(['tar', '-x', '--no-same-owner', '-C', dir], { stdin: tar.stdout, stderr: 'pipe' })
        : tar
    if (x.exitCode !== 0) throw new Error(x.stderr.toString().trim())
    return dir
  } catch (err) {
    rmQuiet(dir, { recursive: true, force: true })
    return fail(`${OWN} at ${commit.slice(0, 8)}: could not read it: ${clip((err as Error).message, 300)}`)
  }
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
    `// A run follows the version on the default branch when it starts, so change it like code: in a run or a\n` +
    `// commit, checked with \`factory check ${OWN}/${name}.ts\`. The improve sweep proposes changes to it.\n\n` +
    body
  )
}

/** the queued PR's branch on origin, fetched, so a rework run starts on the PR's own commits; undefined when it is gone */
export function reworkBase(repo: string, branch: string) {
  if (!/^\w[\w./-]*$/.test(branch) || branch.includes('..')) return undefined // any PR branch (8yhq), not a ref option
  Bun.spawnSync(['git', '-C', repo, 'fetch', '--quiet', 'origin', '--', branch], { timeout: 30_000 })
  const ref = `origin/${branch}`
  return Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref]).exitCode === 0
    ? ref
    : undefined
}

/**
 * what a new run branches from: the tip of origin/<base_branch> when the rig sets a valid base_branch that origin has
 * (fetched first); else the remote's default branch (fetched, so merged work reaches new runs and an unpushed local
 * commit does not); else local HEAD when there is no remote
 */
/** a VM worker's serve died in setup on `bd bootstrap -y`: a transient outage, not a fault of the work */
export const isBootstrapFail = (r: string) =>
  /^serve exited: serve died: beads in the VM: \S+ bootstrap -y: /.test(r)

export function freshBase(repo: string, rig: Pick<Rig, 'params'> | undefined = rigOf(repo)) {
  const b = paramsOf({ params: { base_branch: '' } }, rig).base_branch!.trim()
  if (b && branchOk(b)) {
    const ref = `refs/remotes/origin/${b}`
    Bun.spawnSync(['git', '-C', repo, 'fetch', '--quiet', 'origin', '--', `+refs/heads/${b}:${ref}`], {
      timeout: 30_000,
    }) // offline: what we have
    const tip = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (tip.exitCode === 0) return tip.stdout.toString().trim()
  }
  const head = git(repo, 'rev-parse', 'HEAD')
  const remote = Bun.spawnSync(['git', '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (remote.exitCode !== 0) return head
  const ref = remote.stdout.toString().trim()
  Bun.spawnSync(['git', '-C', repo, 'fetch', '--quiet', 'origin'], { timeout: 30_000 }) // offline: what we have
  return git(repo, 'rev-parse', ref)
}
/** the message for a skill the worker image does not have, or none */
const unknownSkill = (skill: string, where: string) =>
  Object.hasOwn(VM_PLUGINS, skill)
    ? []
    : [`${where}: skill "${skill}" is not ${Object.keys(VM_PLUGINS).join(' or ')}`]

/** a skills value must be an array of strings: say so with the layer name, before a flatMap fails with no hint */
const skillsShape = (v: unknown, where: string) =>
  v === undefined || (Array.isArray(v) && v.every(s => typeof s === 'string'))
    ? []
    : [`${where}: skills must be an array of strings`]

/**
 * The skills of a station's worker, on every backend: the sorted union of the factory's, the rig's and the station's.
 * A factory with no `skills` gives `asd-ste100`, so an older factory keeps its behavior.
 * An older rigs.json can hold a name that no command checked. Refuse that name here.
 * `loadFactory` checks the other two layers (claude-factory-qda).
 */
export function workerSkills(
  def: { skills?: string[] },
  node: { skills?: string[] },
  rig?: { skills?: string[] },
) {
  const shape = skillsShape(rig?.skills, 'rig')
  const bad = shape.length ? shape : (rig?.skills ?? []).flatMap(s => unknownSkill(s, 'rig'))
  if (bad.length) fail(bad.join('; '))
  return [
    ...new Set([...(def.skills ?? ['asd-ste100']), ...(rig?.skills ?? []), ...(node.skills ?? [])]),
  ].sort()
}
// a factory file's name is its file name: a repo's .factory/lifecycle.ts cannot declare 'ship' (merge authority keys on the name)
// loadPinned is only for a run's own pinned copy (run.factory, named factory.json), which keeps the name it was started with
const load = async (file: string, pinned: boolean): Promise<Factory> => {
  const def = validate(await readFactory(file))
  const badSkills = [
    ...skillsShape(def.skills, `factory ${def.name}`),
    ...Object.entries(def.nodes).flatMap(([id, n]) => skillsShape(n.skills, id)),
  ]
  if (!badSkills.length)
    badSkills.push(
      ...(def.skills ?? []).flatMap(s => unknownSkill(s, `factory ${def.name}`)),
      ...Object.entries(def.nodes).flatMap(([id, n]) => (n.skills ?? []).flatMap(s => unknownSkill(s, id))),
    )
  if (badSkills.length) throw new Error(`factory ${def.name}:\n  ${badSkills.join('\n  ')}`)
  const unknown = Object.entries(def.nodes).filter(([, n]) => n.runner && !(n.runner in runners))
  if (unknown.length)
    throw new Error(
      `factory ${def.name}:\n  ${unknown.map(([id, n]) => `${id}: runner "${n.runner}" is not ${Object.keys(runners).join(' or ')}`).join('\n  ')}`,
    )
  const base = basename(file, extname(file))
  if (!pinned && def.name !== base)
    throw new Error(
      `factory ${JSON.stringify(def.name)}:\n  name ${JSON.stringify(def.name)} must be the file name "${base}"`,
    )
  return def
}
export const loadFactory = (file: string) => load(file, false)
export const loadPinned = (file: string) => load(file, true)
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
  // a run the laptop made names the laptop's repo and worktree paths. In the AX task they are the rig's clone
  // and a worktree under the factory home (launchTask revives it)
  return inAx()
    ? { ...run, repo: mapRunRepo(rawRigs(), run.repo), worktree: mapRunWorktree(rawRigs(), run) }
    : run
}
/** complete lines only: a writer may be mid-append */
const inboxLines = (id: string) => {
  const file = join(runDir(id), 'inbox.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1) : []
}
const post = (id: string, e: Input) =>
  durable(join(runDir(id), 'inbox.jsonl'), JSON.stringify({ ...e, at: Date.now() }) + '\n', 'a')

const edgeText = (e: Edge) => (typeof e === 'string' ? e : `${e.to} after ${e.delayMin} min`)
export const clip = (text: string, max: number) => {
  if (text.length <= max) return text
  return `${cut(text, max)}…`
}
/** VM free text for a FAIL reason or a mail: control, format and line-separator characters become spaces, then clip */
export const cleanText = (text: string, max: number) =>
  clip(text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '), max)
/** report text: like cleanText but LF and TAB stay, and no clip */
export const cleanReport = (text: string) => text.replace(/[^\P{Cc}\t\n]|[\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')

/** the least gap, on the laptop's clock, between two egress mails for one run and node */
const EGRESS_REPAGE_MS = 30 * 60_000

/**
 * The VM's egress record from a poll, or undefined when any field is off. The laptop does not trust the VM:
 * a bad `since` would throw in toISOString or mail the manager each tick, and `last` is free text that goes
 * in the FAIL reason. So control and format characters in `last` become spaces, and `last` is cut to 200.
 */
export function trustedEgress(
  egress: unknown,
  now: number,
): { since: number; tries: number; last: string } | undefined {
  if (!egress || typeof egress !== 'object') return undefined
  const { since, tries, last } = egress as Record<string, unknown>
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0 || since > now + LIMIT_SKEW_MS)
    return undefined
  if (typeof tries !== 'number' || !Number.isSafeInteger(tries) || tries < 0) return undefined
  if (typeof last !== 'string') return undefined
  return { since, tries, last: cleanText(last, 200) }
}
/**
 * the cap on one prior report or mail placed whole into a station's brief or a delivered mid-run mail. A
 * report that pastes a diff or a log can run past 128 KiB. That broke two things: a station's own argv
 * (`claude -p <prompt>`) and a VM's base64'd `factory worker prompt` argv. Both sit under an OS or kernel
 * limit, Linux's MAX_ARG_STRLEN (131072 bytes) (claude-factory-kcg). A 1500-char journal line already fits
 * under this cap. This const guards the few spots that pasted a report's `.summary` or a mail's `.text` whole.
 */
export const REPORT_MAX = 32_000
export const clipReport = (text: string) =>
  text.length <= REPORT_MAX
    ? text
    : `${cut(text, REPORT_MAX)}\n[clipped: ${REPORT_MAX} of ${text.length} chars]`
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
  'code-review':
    'Load the code-review skill and run its two axes before you write the review. Do not ask a person: the fixed point is the base branch that your task diffs against, the spec is the plan and the acceptance criteria of the bead, and the standards are the files the skill finds. Put its Standards and Spec findings into your review. A baseline smell is a judgement call: it never blocks alone, so list it as a suggestion unless a documented repo standard makes it a violation.',
  egm: 'Before you report, get a goldfish review of your spec: fresh reviewers that see only the spec and the source it names. Write the spec to .scratch/plan.md in the worktree. Do not use the Skill tool for EGM skills (it refuses them), and do not ask a person. In one message, make two Agent calls with run_in_background false: subagent_type egm:egm-implementation-readiness and subagent_type egm:egm-codebase-details. Give each only this prompt: Mode: REVIEW. TargetFile: <absolute path of .scratch/plan.md>, full file. Standard: implementation-readiness-standard. GoldfishContext: <absolute paths of the files the spec names>. Wait for both results. Fix each Blocker and Major finding in the spec, or write in one line why it is wrong. Run a second round only if round 1 found a Blocker, and stop after round 2. Put this line in your summary: Goldfish review: <rounds> round(s), <n> Blocker, <n> Major, <n> fixed, <n> contested, then each open finding on one line. If an egm agent type does not exist, or a reviewer fails two times, report without the review and write Goldfish review: not run: <reason>. Never fail or block the run for it.',
}
const skillLines = (skills: string[]) =>
  skills.length
    ? ['', '## Skills', ...skills.map(s => `- ${s}: ${SKILL_USE[s] ?? 'load it when it applies'}`)]
    : []

export function brief(
  run: Run,
  def: Factory,
  node: string,
  c: Ctx,
  inbox: Mail[],
  notes = '',
  route?: SecurityRoute,
) {
  const n = def.nodes[node]!
  const lastFail = c.attempt > 1 ? c.log.findLast(e => e.node === node && e.outcome === 'fail') : undefined
  const parked = isParked(c, node) ? c.log.at(-1) : undefined
  const handedOff =
    c.log.at(-1)?.node === node && c.log.at(-1)?.outcome === 'handoff' ? c.log.at(-1) : undefined
  // a fresh worker is told what earlier ones already committed, so it builds on it rather than redoing it
  const committed = run.base ? git(run.worktree, 'log', '--oneline', '-n', '30', `${run.base}..HEAD`) : ''
  const prior = node === def.start ? priorWork(run) : ''
  const origin = originRef(run.repo)
  const rig = rigOf(run.repo)
  // only base_branch fills prompts: other {names} in a prompt stay as written
  const prm: Record<string, string> =
    def.params?.base_branch === undefined ? {} : { base_branch: baseBranchOf(def, rig, run.repo) }
  const fastCheck = paramsOf(def, rig).fast_check?.trim()
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
    ...skillLines(skillsFor(harnessOf(agentOfNode(run, def, node)), workerSkills(def, n, rigOf(run.repo)))),
    '',
    ...remembered(run, node, notes),
    ...forgeNote(origin?.forge === 'gitlab' ? origin.host : undefined),
    '',
    '## Goal',
    run.goal,
    '',
    '## Your task',
    fill(n.prompt.trim(), prm),
    ...(route ? ['', '## Security route', routeLine(route)] : []),
    ...(fastCheck
      ? [
          '',
          '## Fast check',
          "The rig's fast check (format, lint, build-file lists). Run it at the worktree root. Exit 0 is green.",
          '~~~sh',
          fastCheck,
          '~~~',
        ]
      : []),
    ...(rig?.pushRules?.length
      ? [
          '',
          '## Before each push',
          ...rig.pushRules.map((r, i) =>
            fill(`${i + 1}. ${r}`, { base_branch: baseBranchOf(def, rig, run.repo) }),
          ),
        ]
      : []),
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
          ...(n.onTimeout.prompt ? [fill(n.onTimeout.prompt, prm)] : []),
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
    `    ${reportCmd(run, c)}`,
    'Outcomes:',
    ...Object.entries(n.next).map(([outcome, edge]) => `- ${outcome}: goes to ${edgeText(edge)}`),
    '- fail: you cannot do it; a fresh worker retries',
    `- blocked: you are waiting on something outside this run (a person's decision, a human review or merge, another run): say exactly what, with the link of each pull request it waits on. The run parks without using an attempt, and a fresh worker checks again in ${n.parkMin ?? 60} min or as soon as this station is mailed; one named pull request changing (merged, closed, reviewed, commented on, pushed to) mails it.${runnerOfStation(run, def, node).local ? '' : ' A blocked report that names a live read (kubectl, Mimir, Loki, Alertmanager, a live DB or pod) waits for mail or the person, with no timer re-check.'} When it waits on a person's decision or direction, end the summary with a line \`Question: <the decision, in plain words, 160 characters or fewer>\`, an optional \`Context: <one sentence of what is true now, 200 characters or fewer>\` line, and, when there are a few clear choices, a line \`Options: <label>: <effect> | <label>: <effect>\` (each label 40 characters or fewer, each effect 100 characters or fewer; add "(recommended)" after the effect of at most one option): the person answers it in the console's Interview tab, and the answer arrives in this station's inbox.`,
    // workers idled on a background bazel or CI watch, ended their turn, and were failed as lost
    "Do not end your turn to wait on a background build, test or CI watch: wait for it in the foreground. If a wait will outlast this station's time, commit and report (blocked when it waits on CI or a merge) instead.",
    `Free text goes by file, never in a shell argument: a quote in text from outside (a bead, a pull request, a CI job) closes the argument. Write each text (a report summary, a mail, a comment, a bead body, a close reason, a note body, a pull request body, a review body) with the Write tool to ${run.worktree}/.scratch/<new name>.md, one new name for each text, and pass that path in the file flag.`,
    `Put each title and search word of a shell command in single quotes and write each ' in it as '\\'': bash expands $VAR, $(...) and backticks in double quotes. Use only plain words there.`,
    `To ask the manager, run \`${CLI} mail ${run.id} manager --text-file <path>\` and wait: replies arrive as [factory mail] messages, and you are not nudged while a question is open.`,
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
    `- Before you start, search it for what you are about to do: ${CLI} memory search${rig ? ` --rig ${rig}` : ''} '<query>'. It prints the closest notes in full.`,
    ...(notes ? [`- The factory already searched for your goal and station. The closest notes:`, notes] : []),
    `- When you learn what a later worker would otherwise relearn the hard way (a command that works, a trap, an unwritten convention, why something failed), save it: ${CLI} memory add --from ${run.id}/${node} --kind fact|rule|recipe${rig ? ` [--rig ${rig}]` : ''} '<one-line summary>' --body-file <path>${rig ? ` (--rig when it holds only in ${rig})` : ''}. Only what is verified, reusable and not obvious, at most three per station. When a note proved wrong, add the correct one with --supersedes <old note path>: that marks the old note stale. A note that names a bead id or a PR needs --until <bead|owner/repo#N|YYYY-MM-DD> too, unless --kind recipe: that bead or PR's status belongs in its own tracker (bd comments, the PR), not here. What one bead's status is (already fixed, a duplicate) goes in its bd comments, not here.`,
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
      `- Separate work that starts on its own: check \`${CLI} status\` for a duplicate, then mail it to the manager.`,
      `- Separate work for a person to prioritize: mail it to the manager.`,
    ]
  return [
    '## Tracking (beads)',
    `This run is bead ${b} (bd show ${b}); its tasks are the bead's children. Your bd writes are recorded as ${actorOf(run.id)}/${node}.`,
    // claude-factory-wnm: a requeue edge can hand this same bead to a later run, in another
    // factory or station. Its comments are those earlier runs' reports: read them first.
    `- Read ${b}'s comments first (bd show ${b}): they are earlier runs' reports on this bead.`,
    `- The plan's tasks: bd children ${b}; the unblocked ones: bd ready --parent ${b}`,
    `- Add a task: bd create '<title>' --parent ${b} -t task|bug -p <0-4> --body-file <path> (the file holds what to do and how to verify it); order two with bd dep <first> --blocks <second>`,
    `- Work a task: bd update <id> -s in_progress, then bd close <id> --reason-file <path> (the file holds what changed and the commit)`,
    `- Separate work outside this run: look for it first (bd search '<words>'), then bd create '<title>' -t bug|task|feature -p <0-4> --body-file <path> --deps discovered-from:${b}`,
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

/** the report command that a nudge shows: the summary goes by file, never in a shell argument (claude-factory-jho3) */
export const reportCmd = (run: Run, c: Ctx, outcome = '<outcome>') =>
  `${CLI} report ${run.id} ${c.seq} ${outcome} --summary-file <path>`

export const resumeNote = (run: Run, node: string, c: Ctx) =>
  `[factory] Your pane closed and this session was resumed.` +
  cutOffNote(c.session ? cutOffCall(tailOf(run.worktree, c.session)) : undefined) +
  ` Carry on as the "${node}" station where you left off: ` +
  `check git status and git log first. When finished, report exactly once: ${reportCmd(run, c)}`

/** where a station's workers run: the station's own runner, else the rig's. In the AX manager, never a local one */
const runnerOfStation = (run: Run, def: Factory, node: string) =>
  runners[
    stationRunnerName(
      inAx(),
      def.nodes[node]?.runner,
      rigOf(run.repo)?.runner,
      DEFAULT_RUNNER,
      name => runners[name]?.local ?? true,
    )
  ] ?? runners[DEFAULT_RUNNER]!

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
      env: gitNetworkEnv(),
      timeout: GIT_NETWORK_TIMEOUT_MS,
    }).exitCode === 0
  if (!reachable)
    fail(
      `Could not recreate ${run.worktree}: a fetch of origin failed, so this could not check whether ` +
        `${run.branch} still exists there. Check network access, then retry.`,
    )
  Bun.spawnSync(['git', '-C', run.repo, 'fetch', '--quiet', 'origin', run.branch], {
    env: gitNetworkEnv(),
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
 * the search fails or times out (logged in launches.log): the launch goes on without notes.
 * ponytail: spawnSync blocks the tick up to 60 s per new brief; make it async if that shows in practice
 */
export function launchNotes(run: Run, node: string) {
  const rig = rigOf(run.repo)?.name
  try {
    const p = Bun.spawnSync(
      [
        CLI,
        'memory',
        'search',
        '--no-core',
        ...(rig ? ['--rig', rig] : []),
        '--from',
        `${run.id}/${node}`,
      ].concat(`${node}: ${clip(run.goal, 2000)}`),
      { env: { ...process.env, FACTORY_HOME: HOME, FACTORY_OUTBOX: '' }, timeout: 60_000 },
    )
    if (p.exitCode !== 0) {
      launchNotesFailed(run, node, p.exitCode === null ? 'timeout' : `exit ${p.exitCode}`)
      return ''
    }
    const out = p.stdout.toString().trim()
    return out.startsWith('nothing in ') ? '' : clip(out, 6000)
  } catch (e) {
    launchNotesFailed(run, node, String(e))
    return ''
  }
}

/** one line in HOME/launches.log; a write error never blocks the launch */
function launchNotesFailed(run: Run, node: string, why: string) {
  try {
    appendFileSync(
      join(HOME, 'launches.log'),
      `${new Date().toISOString()} ${run.id}/${node} launch memory search failed: ${why}\n`,
    )
  } catch {
    // best effort
  }
}

/** a worker for a station, wherever the rig runs them; given a session, it resumes that conversation */
function spawn(run: Run, def: Factory, node: string, c: Ctx, session?: string) {
  // a revived run (goto or retry after `factory gc --worktrees`) lost its worktree: recreate it first
  if (!existsSync(run.worktree)) reviveWorktree(run)
  const file = session ? resumeFile(run, node, c) : promptOf(run, node, c)
  // a resumed session keeps the notes it was launched with; a new brief searches once, however often it is read
  const notes = session ? '' : launchNotes(run, node)
  const route = def.nodes[node]?.securityRoute
    ? session
      ? savedRoute(run, c)
      : securityRouteOf(run, def, c)
    : undefined
  if (route && !session) writeJson(routeFile(run), { seq: c.seq, route })
  const full = () => brief(run, def, node, c, c.mail[node] ?? [], notes, route)
  // a revived run (goto after gc) lost prompts/: recreate it before writing (claude-factory-503.1.5)
  if (!session) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, full())
  }
  const address = runnerOfStation(run, def, node).launch({ run, def, node, c, session, file, brief: full })
  // after the launch: a launch that throws is not a launch
  logLaunch(run, node, c.seq, agentOfNode(run, def, node), !!session)
  return address
}

/** launch() refused. The factory opens no tab, and a retry in the next tick would refuse again */
class LaunchRefused extends Error {}
/** the FAIL for a refused launch, which would refuse again in the next tick; null for any other error */
export function launchRefusal(err: unknown, seq: number) {
  return err instanceof LaunchRefused
    ? ({ type: 'FAIL', seq, reason: `launch refused: ${err.message}` } as const)
    : null
}
const refuse = (msg: string): never => {
  throw new LaunchRefused(msg)
}

/** a worker in a new tab of the run's workspace; given a session, it resumes that conversation */
export function launchPane({ run, def, node, c, session, file }: Job) {
  // build the command first: a refused launch (a worker the person key must not reach) opens no tab
  const cmd = launch(run, def, node, c, file, session)
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
  typeLaunch(pane, cmd)
  return pane
}

/** an https remote a VM can clone: the egress gateway puts GitHub's credential in, and the VM has no ssh key */
export { httpsRemote }

/**
 * a worker in an AX task on the cluster: the run's branch, pushed, is its workspace. Its brief names the CLI
 * and the worktree as the VM sees them, and FACTORY_AX_ENV (a JSON file or JSON) adds to its env.
 */
/**
 * Only an image with the VM codex guard (claude-factory-72dq) may run codex. An older worker ignores the guard files,
 * and its codex would run with no deny hook. So the person sets FACTORY_AX_CODEX=1 with FACTORY_AX_IMAGE.
 */
export const axCodex = (env = process.env) => env.FACTORY_AX_CODEX === '1'
export function axCodexRefused(agent: string, env = process.env) {
  if (harnessOf(agent) === 'codex' && !axCodex(env))
    fail(
      'the ax runner runs codex only with FACTORY_AX_CODEX=1: set it with an image that has the codex guard',
    )
}
/** the cursor guard needs the image's hooks and pinned CLI (Dockerfile.worker): an older image has neither */
export const axCursor = (env = process.env) => env.FACTORY_AX_CURSOR === '1'
export function axCursorRefused(agent: string, env = process.env) {
  if (harnessOf(agent) === 'cursor' && !axCursor(env))
    fail(
      'the ax runner runs cursor only with FACTORY_AX_CURSOR=1: set it with an image that has cursor-agent',
    )
}
/** the grok guard needs the image's hooks and pinned CLI (Dockerfile.worker): an older image has neither */
export const axGrok = (env = process.env) => env.FACTORY_AX_GROK === '1'
export function axGrokRefused(agent: string, env = process.env) {
  if (harnessOf(agent) === 'grok' && !axGrok(env))
    fail('the ax runner runs grok only with FACTORY_AX_GROK=1: set it with an image that has grok')
}
/**
 * a grok worker in a VM: the CLI sends XAI_API_KEY as a bearer token to api.x.ai, the only host it needs (the feedback and
 * trace host stays shut). The VM holds a placeholder key; the gateway injects the vault key XAI_API_KEY on every path, as the API is plain bearer.
 */
export const grokEgress = (egress: Egress[] = []) =>
  egress.some(e => e.hosts.includes('api.x.ai'))
    ? egress
    : [...egress, { hosts: ['api.x.ai'], key: 'XAI_API_KEY', header: 'Authorization', prefix: 'Bearer ' }]
/**
 * a cursor worker in a VM: cursor-agent posts its API key to api2.cursor.sh/auth/ and uses the access token it gets back.
 * The VM holds a placeholder key; the gateway injects the vault key CURSOR_API_KEY on that path only. The other hosts pass as they are.
 * Substrate accepts only path prefixes that start and end with /, so /auth/ stands for /auth/exchange_user_api_key.
 */
export const cursorEgress = (egress: Egress[] = []) =>
  egress.some(e => e.hosts.includes('api2.cursor.sh'))
    ? egress
    : [
        ...egress,
        {
          hosts: ['api2.cursor.sh'],
          pathPrefixes: ['/auth/'],
          key: 'CURSOR_API_KEY',
          header: 'Authorization',
          prefix: 'Bearer ',
        },
        { hosts: ['api2.cursor.sh', 'api3.cursor.sh', 'repo42.cursor.sh', '*.api5.cursor.sh'] },
      ]
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
    : [...egress, ax.CODEX_CHATGPT_RULE]

/** FACTORY_GH_REVIEWER comes only from launchTask's reviewer flag, never from FACTORY_AX_ENV or a rig's env */
const noReviewerFlag = (e: Record<string, string> = {}) => {
  const { FACTORY_GH_REVIEWER: _, ...rest } = e
  return rest
}

function launchTask({ run, def, node, c, brief: text }: Job) {
  const unavailable = ax.unavailable()
  if (unavailable) fail(unavailable)
  // a laptop run's worktree is not in the task yet: make it from the branch, as for a worktree that gc removed
  if (inAx() && !existsSync(run.worktree)) reviveWorktree(run)
  const image =
    process.env.FACTORY_AX_IMAGE ?? fail('FACTORY_AX_IMAGE is not set: the worker image for AX tasks')
  const rig = rigOf(run.repo)
  const agent = agentOfNode(run, def, node)
  const harness = harnessOf(agent)
  const skills = workerSkills(def, def.nodes[node]!, rig)
  if (!harness)
    fail(`the ax runner runs claude, codex, cursor, grok or pi workers, not "${hideSecret(agent)}"`)
  axCodexRefused(agent)
  axCursorRefused(agent)
  axGrokRefused(agent)
  const hasRunBeads = vmBeads(run) && hasBeads(run.repo)
  // the VM clones its beads from the rig's beadsRemote: its egress needs that Dolt rule
  const doltEgress = ax.withDoltEgress(
    harness === 'codex'
      ? codexEgress(rig?.egress)
      : harness === 'cursor'
        ? cursorEgress(rig?.egress)
        : harness === 'grok'
          ? grokEgress(rig?.egress)
          : rig?.egress,
    hasRunBeads ? rig : undefined,
  )
  // a VM reaches the collector at its in-cluster address, the laptop at a NodePort: FACTORY_AX_OTLP_ENDPOINT wins
  const otel =
    harness === 'pi' || harness === 'cursor' || harness === 'grok'
      ? undefined // none has OTel support
      : otelFor(
          run,
          node,
          c,
          agent,
          process.env.FACTORY_AX_OTLP_ENDPOINT ?? process.env.FACTORY_OTLP_ENDPOINT,
        )
  const same = (e: ax.Egress) =>
    otel && e.hosts.includes(otel.egress.hosts[0]!) && (e.port ?? 443) === otel.egress.port
  const egress = otel && !doltEgress?.some(same) ? [...(doltEgress ?? []), otel.egress] : doltEgress
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
  const env = process.env.FACTORY_AX_ENV ? ax.readAxEnv(process.env.FACTORY_AX_ENV) : {}
  const name = ax.taskName(run.id, c.seq)
  const origin = originRef(run.repo)
  const gitlabHost = origin?.forge === 'gitlab' ? origin.host : undefined
  const githubOwner = origin?.forge === 'github' ? origin.owner : undefined
  const githubRepo = origin?.forge === 'github' ? origin.repo : undefined
  const reviewer = ax.reviewerTask(
    node,
    githubOwner,
    process.env,
    hasRunBeads && !rig?.beadsRemote,
    githubRepo,
  )
  const brief = [
    text().replaceAll(CLI, 'factory').replaceAll(run.worktree, ax.REPO),
    reviewer
      ? `- You run in a VM: github.com is read-only for this task. Do not push. Report changes instead.`
      : `- You run in a VM: push your commits to origin ${run.branch} before you report, or the factory never sees them.`,
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
    ...(rig?.env?.AWS_CONTAINER_CREDENTIALS_FULL_URI
      ? [
          `- AWS reads work: the AWS CLI and SDKs get a read-only role's credentials from AWS_CONTAINER_CREDENTIALS_FULL_URI by themselves (nix shell nixpkgs#awscli2 -c aws ...). Every write, and every secret read (secretsmanager:GetSecretValue, SSM decryption, kms:Decrypt, state bucket objects), is refused: an AWS change goes through the repo. Only the AWS endpoints the rig lists are reachable. For S3 objects, first run aws configure set default.s3.addressing_style path, as bucket hostnames are not reachable.`,
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
  // the VM cannot reach the laptop's memory: it gets a snapshot of the notes its rig can see (vffe.4)
  const snap = memorySnapshotPut(MEMORY, rig?.name, join(runDir(run.id), `${name}.memory.tgz`))
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
            otel?.toml,
          )
        : undefined,
    codexAuth: harness === 'codex' ? codexAuth(rig?.egress) : undefined,
    cursorHooks:
      harness === 'cursor'
        ? vmCursorHooks(personOnlyContexts(rig), protectedBranches(rig), mergeAuthority(rig))
        : undefined,
    grokHooks:
      harness === 'grok'
        ? vmGrokHooks(personOnlyContexts(rig), protectedBranches(rig), mergeAuthority(rig))
        : undefined,
    privatePatterns: rig && privatePatterns(rig.repo),
    gitlabHost,
    sandboxClass: rig?.sandboxClass,
    env: {
      ...noReviewerFlag(env),
      ...noReviewerFlag(rig?.env),
      ...(harness === 'codex' ? otel?.codexEnv : otel?.env),
      FACTORY_FROM: node,
      FACTORY_RUN: run.id,
      FACTORY_DENY_LOG: '1',
      FACTORY_DEF_NAME: def.name,
      FACTORY_SKILLS: skillsFor(harness, skills).join(','),
      ...(reviewer && { FACTORY_GH_REVIEWER: '1' }),
      ...(harness === 'claude' && { FACTORY_DEADLINE: deadlineOf(def, node, c) }),
      BEADS_ACTOR: `${actorOf(run.id)}/${node}`,
      FACTORY_HOME: `${ax.OWN}/home`,
      // each agent's config and sessions on the workspace volume, so a session survives a suspend
      CLAUDE_CONFIG_DIR: `${ax.OWN}/claude`,
      CODEX_HOME: `${ax.OWN}/codex`,
      CURSOR_CONFIG_DIR: `${ax.OWN}/cursor`,
      GROK_HOME: `${ax.OWN}/grok`,
      PI_CODING_AGENT_DIR: `${ax.OWN}/pi-agent`,
      // the deny hook finds the worktree root here; Claude sets it for itself, codex does not
      ...((harness === 'codex' || harness === 'cursor' || harness === 'grok') && {
        CLAUDE_PROJECT_DIR: ax.REPO,
      }),
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
    ...(reviewer && { githubRepo }),
    policy: ax.createPolicy(name, egress, gitlabHost, githubOwner, undefined, reviewer, false, githubRepo),
    put: ['brief.md', ...(snap.put ? ['memory.tgz'] : [])],
    ...(snap.skipped && { memorySkipped: snap.skipped }),
    ...(hasRunBeads && rig?.beadsRemote && { beadsRemote: rig.beadsRemote }),
  }
  writeJson(sideFile(run, name), side)
  return address
}

/**
 * Three PreToolUse entries that run `bun` on `file`: Bash, the file-write tools (claude-factory-g4du), and Read and Grep (claude-factory-qn8a.19). It denies rm -r/-rf, a cd+rm chain, an rm with a
 * $variable or glob target, and an rm outside the worktree root. It gives a reason.
 * `contexts` names kube contexts the rig reserves for a person alone (claude-factory-25z).
 * When the list is not empty, the hook's own argv carries it: `--person-only-contexts a,b`.
 * `branches` names branches, over main and master, the rig reserves for a person's push
 * (claude-factory-zl5). Its own argv is `--protected-branches a,b`.
 * `merge` is the rig's owner/repo (claude-factory-l3tl). It adds `--merge-authority owner/repo`: the hook then lets the ship
 * release station run one strict `gh pr merge` form, for that repo only (-R required).
 * `harness` adds `--harness claude|codex|cursor|grok`: the hook logs it with each denial (claude-factory-dsfg).
 * An older VM image's hook copy ignores argv it does not know.
 * The claude entry has `onFailure: 'block'` (claude-factory-qn8a.36).
 * Claude Code 2.1.295 or later then blocks the call if the hook times out, crashes or gives bad output.
 * Codex has no such key (claude-factory-qn8a.75), and the VM image needs a newer Claude Code (claude-factory-6kzz).
 */
const denyHook = (
  bun: string,
  file: string,
  harness: 'claude' | 'codex' | 'cursor' | 'grok',
  contexts?: string[],
  branches?: string[],
  merge?: string,
) => {
  const hooks = [
    {
      type: 'command',
      command: [
        sq(bun),
        // claude-factory-qn8a.21: bun reads bunfig.toml and the env file from the worktree; a preload there turns the hook off.
        '--no-env-file',
        '--config=/dev/null',
        sq(file),
        '--harness',
        harness,
        ...(contexts?.length ? ['--person-only-contexts', sq(contexts.join(','))] : []),
        ...(branches?.length ? ['--protected-branches', sq(branches.join(','))] : []),
        ...(merge ? ['--merge-authority', sq(merge)] : []),
      ].join(' '),
      timeout: 10,
      ...(harness === 'claude' ? { onFailure: 'block' } : {}),
    },
  ]
  return [
    { matcher: 'Bash', hooks },
    { matcher: 'Write|Edit|MultiEdit|NotebookEdit|apply_patch', hooks },
    // claude-factory-qn8a.19: Read and Grep must not reach the harness token files
    { matcher: 'Read|Grep', hooks },
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
        ...denyHook(
          '/usr/local/bin/bun',
          `${ax.FACTORY_DIR}/src/worker-hook.ts`,
          'claude',
          contexts,
          branches,
          merge,
        ),
      ],
    },
  }
  return [
    ...['--tools', WORKER_TOOLS, '--setting-sources', 'project,local'],
    ...['--settings', JSON.stringify(settings)],
    ...['--system-prompt-file', `${ax.FACTORY_DIR}/src/worker-system.md`],
    // inline, not a file: an older VM image has no worker-vm.md (claude-factory-66ib)
    ...['--append-system-prompt', readFileSync(join(ROOT, 'src', 'worker-vm.md'), 'utf8')],
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
  otelToml = '',
) {
  const hook = denyHook(
    '/usr/local/bin/bun',
    `${ax.FACTORY_DIR}/src/worker-hook.ts`,
    'codex',
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
      (chatgpt
        ? // The gateway denies the plugin and git-attribution GETs (wham/settings/user) under chatgpt.com, and opening them
          // would put the real token on more endpoints. plugins=false stops the plugin calls. git-attribution has no
          // flag, so a dead local port makes its call fail in the VM and attribution reads as off. Model turns use a
          // constant URL, not chatgpt_base_url.
          // ponytail: drop the override when codex gets a flag, or when Substrate gets an exact-path rule (claude-factory-1817).
          'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\nchatgpt_base_url = "http://127.0.0.1:9/backend-api"\n'
        : '') +
      (chatgpt ? '\n[features]\nplugins = false\n' : '') +
      `\n[projects.${JSON.stringify(ax.REPO)}]\ntrust_level = "trusted"\n` +
      otelToml,
    ...(chatgpt && { 'auth.json': placeholderAuth() }),
  } as { 'hooks.json': string; 'config.toml': string; 'auth.json'?: string }
}

/**
 * Cursor's hooks.json: the deny hook as a preToolUse command. The adapter in worker-hook.ts (`--harness cursor`) reads Cursor's
 * tool names and answers in Cursor's shape. failClosed blocks the call when the hook crashes or times out.
 */
const cursorHooks = (bun: string, file: string, contexts?: string[], branches?: string[], merge?: string) =>
  JSON.stringify({
    version: 1,
    hooks: {
      preToolUse: [
        {
          command: denyHook(bun, file, 'cursor', contexts, branches, merge)[0]!.hooks[0]!.command,
          timeout: 10,
          failClosed: true,
        },
      ],
    },
  })
/** a cursor worker's hooks.json in the VM: `serve` writes it to ~/.cursor/hooks.json before each turn */
export const vmCursorHooks = (contexts?: string[], branches?: string[], merge?: string) =>
  cursorHooks('/usr/local/bin/bun', `${ax.FACTORY_DIR}/src/worker-hook.ts`, contexts, branches, merge)

/**
 * Grok runs the Claude settings shape of hooks from .grok/hooks/*.json. The adapter in worker-hook.ts (`--harness grok`)
 * maps Grok's tool names to the guards. Grok reads Claude's deny reply as it is. A hook that cannot start fails open in Grok.
 */
const grokHooks = (bun: string, file: string, contexts?: string[], branches?: string[], merge?: string) =>
  JSON.stringify({ hooks: { PreToolUse: denyHook(bun, file, 'grok', contexts, branches, merge) } })
/** a grok worker's hook file in the VM: `serve` writes it to $GROK_HOME/hooks/factory.json before each turn */
export const vmGrokHooks = (contexts?: string[], branches?: string[], merge?: string) =>
  grokHooks('/usr/local/bin/bun', `${ax.FACTORY_DIR}/src/worker-hook.ts`, contexts, branches, merge)

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
const GATE_KEEP_MS = 6 * 3_600_000
/**
 * the first answer of `verdict` for this station, kept in <run>/<name>-gate.json for 6 hours, so a worker in flight keeps
 * its agent when a meter or a limit moves. A `why` logs one line. With `inRun`, nothing is saved unless the run dir exists.
 */
function sticky<T>(
  name: string,
  runId: string,
  node: string,
  now: number,
  home: string,
  verdict: () => { use: T; why?: string },
  inRun = false,
): T {
  const file = join(home, 'runs', runId, `${name}-gate.json`)
  let memo: Record<string, { at: number; use: T }> = {}
  try {
    memo = readJson(file)
  } catch {} // none yet
  const kept = memo[node]
  if (kept && now - kept.at < GATE_KEEP_MS) return kept.use
  const v = verdict()
  try {
    if (!inRun) mkdirSync(dirname(file), { recursive: true })
    if (existsSync(dirname(file))) writeJson(file, { ...memo, [node]: { at: now, use: v.use } })
  } catch {} // an unsaved answer is asked again
  if (v.why) console.error(`${name} gate: ${runId} ${node} ${v.why}`)
  return v.use
}
/** May this station start `name` (cursor or grok)? A "no" logs one line. */
const stickyGate = (
  name: string,
  runId: string,
  node: string,
  now: number,
  home: string,
  verdict: () => { use: boolean; why: string },
) =>
  sticky(name, runId, node, now, home, () => {
    const v = verdict()
    return { use: v.use, ...(!v.use && { why: `uses its other agent: ${v.why}` }) }
  })
/** forgets a station's harness pick, so its next launch asks the order again (after its usage limit hit) */
function forgetPick(runId: string, node: string, home = HOME) {
  const file = join(home, 'runs', runId, 'order-gate.json')
  try {
    const { [node]: _, ...rest } = readJson<Record<string, unknown>>(file)
    writeJson(file, rest)
  } catch {} // no pick saved
}
/** cursor starts only with a known weekly pool reading under the cap (setting cursor.cap) */
export const cursorAllowed = (
  runId: string,
  node: string,
  env = process.env,
  now = Date.now(),
  home = HOME,
) => stickyGate('cursor', runId, node, now, home, () => cursorVerdict(cursorMeter(home, now), cursorCap(env)))
/** grok starts while the week's spend is under the budget (setting grok.weeklyBudgetUsd); with no budget it always does */
export const grokAllowed = (runId: string, node: string, env = process.env, now = Date.now(), home = HOME) =>
  grokBudget(env) === undefined ||
  stickyGate('grok', runId, node, now, home, () => grokVerdict(grokSpent(home, now), grokBudget(env)))

/** the harnesses a station moves through, from setting agents.order (FACTORY_AGENTS_ORDER) */
export const agentsOrder = (env = process.env) =>
  (env.FACTORY_AGENTS_ORDER?.trim() || 'claude,codex,grok,pi') // the default of settings.ts agents.order
    .split(',')
    .map(s => s.trim())
    .filter((h): h is Harness => ['claude', 'codex', 'grok', 'pi', 'cursor'].includes(h))
// a harness's launcher when the station names no command of its own for it; a factory param of the same name wins
const LAUNCHERS: Record<Harness, string> = {
  claude: `${claudeCommand()} --dangerously-skip-permissions`,
  codex: 'codex --dangerously-bypass-approvals-and-sandbox',
  grok: 'grok --permission-mode bypassPermissions --trust',
  pi: 'pi',
  cursor: 'cursor-agent --force --trust',
}
/** <home>/harness-limit-<runner>.json: for each harness, when its usage limit on that runner lifts, in ms */
const harnessLimitFile = (runner: string, home = HOME) => join(home, `harness-limit-${runner}.json`)
/** is this harness at its usage limit on this runner? */
export function harnessLimited(runner: string, h: Harness, now = Date.now(), home = HOME) {
  try {
    const until = readJson<Record<string, unknown>>(harnessLimitFile(runner, home))[h]
    return typeof until === 'number' && until > now && until <= now + LIMIT_RESET_MAX_MS
  } catch {
    return false
  }
}
export function recordHarnessLimit(runner: string, h: Harness, until: number, home = HOME) {
  const file = harnessLimitFile(runner, home)
  let m: Record<string, number> = {}
  try {
    m = readJson(file)
  } catch {} // none yet
  writeJson(file, { ...m, [h]: until })
}
/** drop one harness entry of harness-limit-<runner>.json, as unhold does after a token swap */
export function clearHarnessLimit(runner: string, h: Harness, home = HOME) {
  const file = harnessLimitFile(runner, home)
  let m: Record<string, number>
  try {
    m = readJson(file)
  } catch {
    return // none yet
  }
  delete m[h]
  writeJson(file, m)
}

/**
 * the worker command: the rig's own (one harness for all its stations) over the split's, the station's and the
 * factory's. The split applies on the ax runner only with FACTORY_AX_CODEX=1 (axCodex), and elsewhere only when
 * the `pin` file exists (claude-factory-fzm3). A rig's agent pins its harness: a cursor or grok pick that `allowed`
 * or `grokOk` refuses becomes the station's own agent. Else a pick that its gate refuses, or that is at its usage
 * limit, moves to the first harness of agents.order that its gate allows and that is not at its limit
 * (claude-factory-gf16e). The move is kept in <run>/order-gate.json and logs one line.
 */
export const pickAgent = (
  runId: string,
  def: Factory,
  node: string,
  rig: Pick<Rig, 'agent' | 'params' | 'mcp'> | undefined,
  runner: string,
  env = process.env,
  pin = CODEX_PIN,
  allowed = cursorAllowed,
  grokOk = grokAllowed,
  limited = (h: Harness) => harnessLimited(runner, h),
  now = Date.now(),
  home = HOME,
) => {
  const params = paramsOf(def, rig, env)
  const split = def.nodes[node]!.split
  // a host without the unified_exec pin cannot launch codex (the probe refuses), so the split keeps Claude there
  const codexOk = runner === 'ax' ? axCodex(env) : existsSync(pin)
  const picked = split && codexOk && splitPick(runId, split.share, params[split.share])
  const own = fill(def.nodes[node]!.agent ?? def.agent ?? AGENT, params)
  const agent = fill(rig?.agent ?? (picked ? split.agent : own), params)
  const h0 = harnessOf(agent)
  if (rig?.agent || !h0)
    return (h0 === 'cursor' && !allowed(runId, node, env)) || (h0 === 'grok' && !grokOk(runId, node, env))
      ? own
      : agent
  // a move target needs more than a pick: the codex pin on a host, and a deny hook (pi has none yet: claude-factory-gf16e.5)
  const gateOk = (h: Harness, target = false) =>
    h === 'cursor'
      ? (runner !== 'ax' || axCursor(env)) && allowed(runId, node, env)
      : h === 'grok'
        ? (runner !== 'ax' || axGrok(env)) && grokOk(runId, node, env)
        : h === 'codex'
          ? target
            ? codexOk
            : runner !== 'ax' || axCodex(env)
          : h !== 'pi' || !target
  // pi, cursor and grok refuse a rig's MCP servers (harness.ts command)
  const usable = (h: Harness, ok: boolean) =>
    ok && (!rig?.mcp || h === 'claude' || h === 'codex') && !limited(h)
  const h = sticky(
    'order',
    runId,
    node,
    now,
    home,
    () => {
      const ok0 = gateOk(h0)
      if (usable(h0, ok0)) return { use: h0 }
      const next = agentsOrder(env).find(x => x !== h0 && usable(x, gateOk(x, true)))
      // none left: the station's own agent, which waits out its limit as before
      if (!next) return { use: ok0 ? h0 : (harnessOf(own) ?? h0) }
      return { use: next, why: `moves from ${h0} to ${next}: ${ok0 ? 'usage limit' : 'gate refused'}` }
    },
    true,
  )
  const split2 = split && fill(split.agent, params)
  return h === h0
    ? agent
    : harnessOf(own) === h
      ? own
      : split2 && harnessOf(split2) === h
        ? split2
        : fill(params[h] ?? LAUNCHERS[h], params)
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

const LIMIT_SKEW_MS = 5 * 60_000 // a VM clock may run this far ahead of the laptop's
const LIMIT_RESET_MAX_MS = 8 * 24 * 3_600_000 // a weekly reset is at most 7 days out
const LIMIT_KINDS = new Set(['seven_day', 'five_hour', 'usage', 'auth'])

/**
 * claude-factory-5nca: a VM supplies its limit hit, so the laptop does not trust it. This returns null when the
 * hit has no finite time, or a time more than 5 minutes ahead of now. Otherwise it returns only at, a kind from
 * a fixed set (else 'usage') and a reset time within 8 days (else 0: the callers use at + 1 h).
 */
export function trustedHit(hit: unknown, now: number) {
  if (typeof hit !== 'object' || hit === null) return null
  const h = hit as { at?: unknown; kind?: unknown; resetsAt?: unknown }
  if (typeof h.at !== 'number' || !Number.isFinite(h.at) || h.at > now + LIMIT_SKEW_MS) return null
  const r = h.resetsAt
  return {
    at: h.at,
    kind: typeof h.kind === 'string' && LIMIT_KINDS.has(h.kind) ? h.kind : 'usage',
    resetsAt: typeof r === 'number' && Number.isFinite(r) && r > 0 && r <= now + LIMIT_RESET_MAX_MS ? r : 0,
  }
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

/** <home>/manager-limit.json: the manager's Claude is refused and no account is free (claude-factory-y3f8w.3) */
const managerLimitFile = (home = HOME) => join(home, 'manager-limit.json')
const MANAGER_LIMIT_UNKNOWN_MS = 30 * 60_000 // a limit with no known reset counts for this long
export function recordManagerLimit(hit: { at: number; kind: string; resetsAt: number }, home = HOME) {
  writeJson(managerLimitFile(home), hit)
}
export function clearManagerLimit(home = HOME) {
  rmSync(managerLimitFile(home), { force: true })
}
/** the manager's limit while it holds: its kind and when it lifts (ms), else null */
export function managerLimited(now = Date.now(), home = HOME) {
  try {
    const h = readJson<{ at: number; kind: string; resetsAt: number }>(managerLimitFile(home))
    const until = h.resetsAt > 0 ? h.resetsAt : h.at + MANAGER_LIMIT_UNKNOWN_MS
    return until > now && until <= now + LIMIT_RESET_MAX_MS ? { kind: h.kind, until } : null
  } catch {
    return null
  }
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

const TOKEN_SWAP_WAIT_MS = 5 * 60_000 // agent-vault reads the vault again at most this often
const CODEX_SWAP_GAP_MS = 3_600_000 // a Codex swap recopies a ChatGPT token: never more than once an hour

/**
 * This function checks if a swap must run. A hit is new when no state exists yet. A hit is
 * also new when the hit time is after the state time. A new hit swaps only when the last run
 * (state.ran, laptop time) is at least TOKEN_SWAP_WAIT_MS old.
 */
export function needsSwap(
  hit: { at: number },
  state: { at: number; ran?: number } | undefined,
  now: number,
  gap = TOKEN_SWAP_WAIT_MS,
) {
  return (!state || hit.at > state.at) && (state?.ran === undefined || now >= state.ran + gap)
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

type TokenSwapState = { at: number; until: number; ran?: number }

/**
 * This function reads a token-swap state file. A state that is not a well-formed object, or that has an
 * at or ran more than LIMIT_SKEW_MS ahead, or an until more than LIMIT_RESET_MAX_MS ahead, counts as no state.
 * A hostile VM can have written such a file before the bound existed.
 */
export function trustedSwapState(file: string, now: number): TokenSwapState | undefined {
  if (!existsSync(file)) return undefined
  let s: Record<string, unknown>
  try {
    s = readJson<Record<string, unknown>>(file)
  } catch {
    return undefined
  }
  if (typeof s !== 'object' || s === null) return undefined
  const { at, until, ran } = s
  const num = (v: unknown): v is number => Number.isFinite(v)
  if (!num(at) || !num(until) || at > now + LIMIT_SKEW_MS || until > now + LIMIT_RESET_MAX_MS)
    return undefined
  if (ran !== undefined && (!num(ran) || ran > now + LIMIT_SKEW_MS)) return undefined
  return ran === undefined ? { at, until } : { at, until, ran }
}

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
  const state = trustedSwapState(file, now)
  const gap = codex ? CODEX_SWAP_GAP_MS : TOKEN_SWAP_WAIT_MS
  if (!needsSwap(hit, state, now, gap)) {
    const waiting = state!.ran !== undefined && hit.at > state!.at // a newer hit held back by the swap window
    return waiting ? Math.max(state!.until, state!.ran! + gap) : state!.until
  }
  const p = Bun.spawnSync(cmd.split(' '), {
    cwd: ROOT,
    timeout: 30_000,
    env: { ...process.env, FACTORY_HOME: home },
  })
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
  writeJson(file, { at: hit.at, until, ran: now } satisfies TokenSwapState)
  if (ok) writeUnhold(runnerName, codex, now, now + TOKEN_SWAP_WAIT_MS, home)
  return until
}

const CODEX_TOKEN_FRESH = 3 // exit code of `codex-token refresh` when it changes nothing
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
  const state = trustedSwapState(file, now)
  if (state && now - state.at < CODEX_REFRESH_MS) return
  const code = Bun.spawnSync(cmd.split(' '), {
    cwd: ROOT,
    timeout: 30_000,
    env: { ...process.env, FACTORY_HOME: home },
  }).exitCode
  const ok = code === 0 || code === CODEX_TOKEN_FRESH // exit 3: the token is still fresh, nothing was copied
  writeJson(file, {
    at: ok ? now : now - CODEX_REFRESH_MS + 3_600_000,
    until: ok ? now + TOKEN_SWAP_WAIT_MS : now,
    ran: now,
  } satisfies TokenSwapState)
}

type UnholdMark = { before: number; from: number; woke: number }
const unholdFile = (runner: string, codex: boolean, home = HOME) =>
  join(home, `unhold-${runner}${codex ? '-codex' : ''}.json`)

/**
 * This function reads an unhold mark: `before` is the time of the swap (only older holds wake), `from` is the
 * first time a wake may happen, `woke` is the count woken so far. A mark that is not a well-formed object, or
 * that has a before or from too far ahead, is deleted and counts as no mark.
 */
export function trustedUnhold(file: string, now: number): UnholdMark | undefined {
  if (!existsSync(file)) return undefined
  let m: unknown
  try {
    m = readJson<unknown>(file)
  } catch {
    m = undefined
  }
  const { before, from, woke } = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
  const num = (v: unknown): v is number => Number.isFinite(v)
  if (
    num(before) &&
    num(from) &&
    num(woke) &&
    before <= now + LIMIT_SKEW_MS &&
    from <= now + LIMIT_RESET_MAX_MS
  )
    return { before, from, woke }
  rmSync(file, { force: true })
  return undefined
}

/** This function writes the mark of a runner and harness. A rewrite keeps the old woke count. */
export function writeUnhold(runner: string, codex: boolean, before: number, from: number, home = HOME) {
  const woke = trustedUnhold(unholdFile(runner, codex, home), before)?.woke ?? 0
  writeJson(unholdFile(runner, codex, home), { before, from, woke } satisfies UnholdMark)
}

/**
 * This function picks the held stations to wake, the oldest hold first. Each pick takes one slot:
 * room() applies the town cap `max` and the rig's maxRuns. It adds each pick to `busy`, so a caller can share
 * one list over many calls.
 */
export function pickUnholds<T extends { rig: Pick<Rig, 'name' | 'maxRuns'> | undefined; at: number }>(
  cands: T[],
  busy: (string | undefined)[],
  held: (string | undefined)[],
  max = MAX_BUSY,
): T[] {
  const used = busy
  const out: T[] = []
  for (const c of [...cands].sort((a, b) => a.at - b.at)) {
    if (room(c.rig, used, max, held) <= 0) continue
    used.push(c.rig?.name)
    out.push(c)
  }
  return out
}

/**
 * This function runs once in each tick. For each unhold mark it wakes the stations held by a usage limit of the
 * mark's runner and harness, as far as the free slots allow. It ends the mark when no such station is left, and then
 * returns one manager mail. A station wakes only when it waits after an 'outage' hold with a limit or login reason
 * of the right harness, that hold is older than the swap, and its runner is the mark's runner.
 */
export async function unholdPass(now: number): Promise<(Mail & { run: string })[]> {
  const mails: (Mail & { run: string })[] = []
  if (halted()) return mails
  let slots: Awaited<ReturnType<typeof busyRigs>> | undefined
  for (const runner of Object.values(runners).filter(r => !r.local)) {
    for (const codex of [false, true]) {
      const file = unholdFile(runner.name, codex)
      const m = trustedUnhold(file, now)
      if (!m || now < m.from) continue
      const reason = codex
        ? /^Codex (usage limit|login refused) \(/
        : /^Claude (usage limit|login refused) \(/
      const cands: { id: string; node: string; rig: Rig | undefined; at: number }[] = []
      for (const id of runIds()) {
        try {
          const { run, value, c } = current(id)
          const [node, sub] = where(value)
          const last = c.log.at(-1)
          if (sub !== 'waiting' || last?.node !== node || last.outcome !== 'outage') continue
          if (last.at > m.before || !reason.test(last.summary)) continue
          if (runnerOfStation(run, await loadPinned(run.factory), node).name !== runner.name) continue
          cands.push({ id, node, rig: rigOf(run.repo), at: last.at })
        } catch {
          continue // a run dir before its state.json, or a def that does not load
        }
      }
      slots ??= await busyRigs()
      const picked = pickUnholds(cands, slots.busy, slots.held)
      for (const p of picked)
        post(p.id, {
          type: 'MAIL',
          from: 'factory',
          to: p.node,
          wake: true,
          text: `[factory] The ${runner.name} ${codex ? 'Codex' : 'Claude'} token was swapped: the usage-limit hold ends.`,
        })
      const woke = m.woke + picked.length
      if (picked.length < cands.length) writeJson(file, { ...m, woke } satisfies UnholdMark)
      else {
        rmSync(file, { force: true })
        if (woke)
          mails.push({
            run: 'factory',
            from: 'factory',
            text: `Woke ${woke} stations held by the ${codex ? 'Codex' : 'Claude'} usage limit on ${runner.name} after the token swap.`,
            at: now,
          })
      }
    }
  }
  return mails
}

/** the model behind the `haiku` alias for workers and the manager. Claude Code 2.1.291 maps it to Haiku 4.5 */
export const HAIKU = 'claude-haiku-5-5'

/**
 * claude-factory-5us3: a closed rule for the one user hook a worker keeps, herdr's session hook.
 * A SessionStart entry passes only when every hook in it is `bash '/<abs path>/hooks/herdr-agent-state.sh' session`
 * (Claude) or `bash '/<abs path>/herdr-agent-state.sh' session` (Codex, claude-factory-px98).
 */
const isHerdrSessionHook = (e: unknown) => {
  const hs = (e as { hooks?: unknown } | null)?.hooks
  return (
    Array.isArray(hs) &&
    hs.length > 0 &&
    hs.every(
      (h: { type?: unknown; command?: unknown } | null) =>
        h?.type === 'command' &&
        typeof h.command === 'string' &&
        /^bash '\/[^'\n]*\/(?:hooks\/)?herdr-agent-state\.sh' session$/.test(h.command),
    )
  )
}

/**
 * claude-factory-5us3: a closed rule for the user's ctxguard hook, the only credential-read block and output redaction a worker has.
 * An entry passes only when every hook in it is type command with a command that is one plain path ending in `/bin/ctxguard`.
 */
const isCtxguardHook = (e: unknown) => {
  const hs = (e as { hooks?: unknown } | null)?.hooks
  return (
    Array.isArray(hs) &&
    hs.length > 0 &&
    hs.every(
      (h: { type?: unknown; command?: unknown } | null) =>
        h?.type === 'command' &&
        typeof h.command === 'string' &&
        /^\/[\w./+-]*\/bin\/ctxguard$/.test(h.command),
    )
  )
}

/**
 * a worker's own Claude settings, in full: none of the user's plugins, agents, skills, global `CLAUDE.md` or auto memory.
 * Those cost a worker tens of thousands of tokens a turn it never uses, so this wins instead.
 * It keeps the user's env and skips every permission prompt.
 * Its only hooks are the factory's deny hook, herdr's session hook and the user's ctxguard (claude-factory-5us3).
 * Every other user hook, such as shunt-guard and `bd prime`, stays out.
 * `CTXGUARD_ALLOW` exempts the `factory memory search` text from ctxguard.
 * It compacts well past the handoff limit too, only as a backstop.
 * A worktree's path excludes the global `CLAUDE.md` too, since Claude Code would read it as an ancestor's project file.
 * Only the plugins in `names` stay in (the enabledPlugins key before `@`): the station's skills, and the person's FACTORY_WORKER_PLUGINS.
 * `disableBundledSkills` keeps their skills alone.
 * `hooks.PreToolUse` holds the deny-rm hook alone (claude-factory-cr6, claude-factory-99d).
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
  const herdr = (user.hooks?.SessionStart ?? []).filter(isHerdrSessionHook)
  const guard = (ev: string) => (user.hooks?.[ev] ?? []).filter(isCtxguardHook)
  const hooks: Record<string, unknown[]> = {
    PreToolUse: [
      ...guard('PreToolUse'),
      ...denyHook(
        process.execPath,
        join(ROOT, 'src', 'worker-hook.ts'),
        'claude',
        personOnly,
        branches,
        merge,
      ),
    ],
    ...(guard('PostToolUse').length ? { PostToolUse: guard('PostToolUse') } : {}),
    ...(herdr.length ? { SessionStart: herdr } : {}),
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
      // claude-factory-5us3: ctxguard matches command text, so it blocks 'factory memory search' words
      CTXGUARD_ALLOW: [user.env?.CTXGUARD_ALLOW ?? process.env.CTXGUARD_ALLOW, 'factory memory search']
        .filter(Boolean)
        .join(','),
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

/** warn for each listed skill that is not on in the person's Claude settings: the worker starts without it */
export function warnSkillsOff(skills: string[], station: string, on?: Record<string, boolean> | null) {
  for (const k of skills)
    if (!Object.entries(on ?? {}).some(([key, v]) => v && key.split('@')[0] === k))
      console.warn(
        `skill ${k} is not on in your Claude settings: the ${station || 'station'} worker starts without it`,
      )
}

/** codex and pi workers get plugin dirs, not settings: warn here for a listed skill that is off */
export function warnSkillsForHarness(h: string | null, skills: string[], station: string, claudeDir: string) {
  if (h !== 'codex' && h !== 'pi') return
  let on: Record<string, boolean> | undefined
  try {
    on = readJson<{ enabledPlugins?: Record<string, boolean> }>(
      join(claudeDir, 'settings.json'),
    ).enabledPlugins
  } catch {
    // no user settings: every skill warns
  }
  warnSkillsOff(skills, station, on)
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
  warnSkillsOff(skills, station, (user as { enabledPlugins?: Record<string, boolean> }).enabledPlugins)
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
export function piWorker(
  home = HOME,
  plugins = userPluginDirs(),
  key = join(homedir(), '.config', 'factory', 'person.key'),
) {
  // ponytail: pi has no deny hook, so it could read the person key. When claude-factory-qn8a.84 lands, drop this refusal.
  if (existsSync(key))
    refuse(
      `a pi worker has no deny hook (claude-factory-qn8a.84), so it could read the person key ${key}: use a claude or codex worker`,
    )
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
 * config.toml (context limit), hooks.json (herdr's session hook and the deny hook only, claude-factory-px98), AGENTS.md (the worker
 * rules) and an auth.json link. Codex has the PreToolUse hook, so worker-hook.ts runs as it is. Fail closed:
 * no hook file, or an agent command that turns the guard off, refuses the launch (claude-factory-x0b9).
 */
export function codexWorker(
  run: Pick<Run, 'id' | 'worktree'>,
  def: Pick<Factory, 'maxContextK'>,
  node: string,
  agent: string,
  rig?: Pick<Rig, 'personOnlyContexts' | 'protectedBranches' | 'mergeAuthority'> & { repo?: string },
  o: {
    hookFile?: string
    userHome?: string
    dir?: string
    timeoutMs?: number
    plugins?: string[]
    otel?: Pick<Otel, 'toml' | 'codexEnv'>
  } = {},
): { env: Record<string, string>; extra: string } {
  const hookFile = o.hookFile ?? join(ROOT, 'src', 'worker-hook.ts')
  if (!existsSync(hookFile)) refuse(`a codex worker needs the deny hook, and ${hookFile} is missing`)
  const off = codexGuardOff(agent)
  if (off) refuse(`a codex worker keeps the deny hook on: "${off}" in the agent command turns it off`)
  // the home trusts the worktree so codex shows no folder prompt; a .codex entry there would load unguarded config,
  // unless it is the one `bd init` writes (claude-factory-8cu6)
  for (let d = resolve(run.worktree); ; d = dirname(d)) {
    if (existsSync(join(d, '.codex')) && !beadsOnlyCodexDir(join(d, '.codex')))
      refuse(`a codex worker keeps the deny hook on: ${join(d, '.codex')} would add project config`)
    if (existsSync(join(d, '.git')) || dirname(d) === d) break
  }
  const user = o.userHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const dir = o.dir ?? join(runDir(run.id), 'codex', node)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  let herdr: unknown[] = []
  try {
    const ss = readJson<{ hooks?: { SessionStart?: unknown[] } }>(join(user, 'hooks.json')).hooks
      ?.SessionStart
    herdr = (ss ?? []).filter(isHerdrSessionHook)
  } catch {
    // no user hooks, not JSON, or SessionStart not an array (filter throws): the deny hook is the only one
  }
  const hook = denyHook(
    process.execPath,
    hookFile,
    'codex',
    personOnlyContexts(rig),
    protectedBranches(rig),
    mergeAuthority(rig),
  )
  writeJson(join(dir, 'hooks.json'), {
    hooks: { PreToolUse: hook, ...(herdr.length ? { SessionStart: herdr } : {}) },
  })
  writeFileSync(
    join(dir, 'config.toml'),
    `model_auto_compact_token_limit = ${Math.max(100, 2 * (def.maxContextK ?? 200)) * 1000}\n\n` +
      `[projects.${JSON.stringify(run.worktree)}]\ntrust_level = "trusted"\n` +
      (o.otel?.toml ?? ''),
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
  if (bad) refuse(`a codex worker keeps the deny hook on: the feature check failed (${bad})`)
  return {
    env: {
      CODEX_HOME: dir,
      CLAUDE_PROJECT_DIR: run.worktree,
      ...(id.env as Record<string, string>),
      ...o.otel?.codexEnv,
    },
    extra,
  }
}

/**
 * A cursor worker in a pane. Cursor loads <worktree>/.cursor/hooks.json, so the deny hook goes there, hidden from git by
 * info/exclude; the person's ~/.cursor stays as it is. The worker rules lead the first prompt (command's `rules`).
 * Fail closed: a hooks.json the factory did not write refuses the launch, as codexWorker does for a .codex dir.
 */
export function cursorWorker(
  run: Pick<Run, 'worktree'>,
  rig?: Pick<Rig, 'personOnlyContexts' | 'protectedBranches' | 'mergeAuthority'>,
  home = HOME,
  hookFile = join(ROOT, 'src', 'worker-hook.ts'),
) {
  if (!existsSync(hookFile)) refuse(`a cursor worker needs the deny hook, and ${hookFile} is missing`)
  const file = join(run.worktree, '.cursor', 'hooks.json')
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(hookFile))
    refuse(`a cursor worker keeps the deny hook on: ${file} is not the factory's and would add hooks`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    cursorHooks(
      process.execPath,
      hookFile,
      personOnlyContexts(rig),
      protectedBranches(rig),
      mergeAuthority(rig),
    ),
  )
  const exclude = resolve(run.worktree, git(run.worktree, 'rev-parse', '--git-path', 'info/exclude'))
  mkdirSync(dirname(exclude), { recursive: true })
  const hidden = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!hidden.split('\n').includes('/.cursor/hooks.json'))
    appendFileSync(exclude, `${hidden && !hidden.endsWith('\n') ? '\n' : ''}/.cursor/hooks.json\n`)
  const id = commitIdentity(home)
  const rules = join(home, 'worker-cursor.md')
  writeFileSync(
    rules,
    readFileSync(join(ROOT, 'src', 'worker-system.md'), 'utf8') +
      readFileSync(join(ROOT, 'src', 'worker-cursor.md'), 'utf8') +
      id.rule,
  )
  return {
    env: { CLAUDE_PROJECT_DIR: run.worktree, ...(id.env as Record<string, string>) },
    extra: ` ${CURSOR_FLAGS.join(' ')}`,
    rules,
  }
}

/**
 * A grok worker in a pane. Grok loads <worktree>/.grok/hooks/*.json (with --trust, which the launch passes), so the deny hook goes
 * there, hidden from git by info/exclude; the person's ~/.grok stays as it is. The worker rules go on `--rules` (command's `rules`).
 * Fail closed: a hooks dir the factory did not write refuses the launch, as cursorWorker does for a hooks.json.
 */
export function grokWorker(
  run: Pick<Run, 'worktree'>,
  rig?: Pick<Rig, 'personOnlyContexts' | 'protectedBranches' | 'mergeAuthority'>,
  home = HOME,
  hookFile = join(ROOT, 'src', 'worker-hook.ts'),
) {
  if (!existsSync(hookFile)) refuse(`a grok worker needs the deny hook, and ${hookFile} is missing`)
  const dir = join(run.worktree, '.grok', 'hooks')
  if (existsSync(dir) && readdirSync(dir).some(f => f !== 'factory.json'))
    refuse(`a grok worker keeps the deny hook on: ${dir} holds hooks the factory did not write`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'factory.json'),
    grokHooks(
      process.execPath,
      hookFile,
      personOnlyContexts(rig),
      protectedBranches(rig),
      mergeAuthority(rig),
    ),
  )
  const exclude = resolve(run.worktree, git(run.worktree, 'rev-parse', '--git-path', 'info/exclude'))
  mkdirSync(dirname(exclude), { recursive: true })
  const hidden = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!hidden.split('\n').includes('/.grok/hooks/factory.json'))
    appendFileSync(exclude, `${hidden && !hidden.endsWith('\n') ? '\n' : ''}/.grok/hooks/factory.json\n`)
  const id = commitIdentity(home)
  const rules = join(home, 'worker-grok.md')
  writeFileSync(
    rules,
    readFileSync(join(ROOT, 'src', 'worker-system.md'), 'utf8') +
      readFileSync(join(ROOT, 'src', 'worker-grok.md'), 'utf8') +
      id.rule,
  )
  return {
    env: { CLAUDE_PROJECT_DIR: run.worktree, ...(id.env as Record<string, string>) },
    extra: ` ${GROK_FLAGS.join(' ')}`,
    rules,
  }
}

/**
 * when the station fails a worker that is still working (`deadline`: 1.5x its minutes from launch), in ms. The deny
 * hook clamps a Bash call's timeout to it, so a command ends before the run fails (claude-factory-p0yt)
 */
const deadlineOf = (def: Factory, node: string, c: Ctx) =>
  String(Date.now() + timeoutOf(def.nodes[node]!, c, node) * 90_000)

/**
 * The OTel settings for a worker launch (claude-factory-ozso), or undefined when the endpoint is unset.
 * The tags are the ones of logLaunch.
 */
export function otelFor(run: Run, node: string, c: Ctx, agent: string, endpoint: string | undefined) {
  const rig = rigOf(run.repo)
  return otelOf(
    endpoint,
    {
      run: run.id,
      station: node,
      rig: rig?.name ?? 'none',
      attempt: String(c.attempt),
      harness: harnessOf(agent) ?? 'other',
      model: ax.modelOf(agent) ?? 'default',
    },
    rig?.otelContent !== false,
  )
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/**
 * the command prefix that runs a laptop herdr worker in a macOS Seatbelt sandbox (claude-factory-o7h6h),
 * or a refusal. Off macOS it refuses while a person key exists. ponytail: a Linux laptop gets no OS
 * sandbox; the upgrade path is bwrap.
 */
export function laptopSandbox(
  h: Harness | null,
  worktree: string,
  o: {
    platform?: string
    exists?: (p: string) => boolean
    home?: string
    factoryHome?: string
    env?: Record<string, string | undefined>
  } = {},
): string {
  const { platform = process.platform, exists = existsSync, home = homedir(), env = process.env } = o
  if (platform !== 'darwin') {
    const key = join(home, '.config', 'factory', 'person.key')
    if (!exists(key)) return ''
    return refuse(
      `this host (${platform}) has no worker sandbox, and the person key ${key} exists: the factory refuses the launch (claude-factory-o7h6h)`,
    )
  }
  if (!exists(SANDBOX_EXEC))
    refuse(`a laptop worker runs in the macOS sandbox, and ${SANDBOX_EXEC} is missing (claude-factory-o7h6h)`)
  const factoryHome = o.factoryHome ?? HOME
  let sb: ReturnType<typeof seatbelt>
  try {
    sb = seatbelt(h, {
      home,
      factoryHome,
      claudeDir: env.CLAUDE_CONFIG_DIR,
      codexHome: env.CODEX_HOME,
      cursorDir: env.CURSOR_CONFIG_DIR,
      grokHome: env.GROK_HOME,
    })
  } catch (e) {
    if (e instanceof SandboxPathError) return refuse(`${e.message} (claude-factory-o7h6h)`)
    throw e
  }
  const inside = (what: string, path: string) => {
    const real = realPath(resolve(path))
    if (real === undefined)
      refuse(
        `the factory cannot find the real path of ${path}, so it cannot check the worker sandbox (claude-factory-o7h6h)`,
      )
    for (const p of [resolve(path), real!])
      for (const d of sb.denied)
        if (p === d || p.startsWith(d + sep))
          refuse(`the ${what} ${path} is inside the sandbox deny path ${d} (claude-factory-o7h6h)`)
  }
  inside('worktree', worktree)
  inside('factory home', factoryHome)
  return `${SANDBOX_EXEC} -p ${sq(sb.profile)} `
}

export function launch(
  run: Run,
  def: Factory,
  node: string,
  c: Ctx,
  prompt: string,
  session?: string,
  sb = laptopSandbox,
) {
  const rig = rigOf(run.repo)
  const agent = agentOfNode(run, def, node)
  // the clamp is Claude's: its Bash tool takes a timeout, codex's shell does not
  const h = harnessOf(agent)
  const wrap = sb(h, run.worktree)
  const skills = skillsFor(h, workerSkills(def, def.nodes[node]!, rig))
  const otel = otelFor(run, node, c, agent, process.env.FACTORY_OTLP_ENDPOINT)
  warnSkillsForHarness(h, skills, node, process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  const setup =
    h === 'codex'
      ? codexWorker(run, def, node, agent, rig, { plugins: userPluginDirs(workerPluginNames(skills)), otel })
      : h === 'pi'
        ? piWorker(HOME, userPluginDirs(workerPluginNames(skills)))
        : h === 'cursor'
          ? cursorWorker(run, rig)
          : h === 'grok'
            ? grokWorker(run, rig)
            : {
                extra: workerFlags(def, rig, HOME, skills, node),
                env: { FACTORY_DEADLINE: deadlineOf(def, node, c), ...otel?.env },
              }
  return command(agent, prompt, {
    session,
    ...setup,
    mcp: rig?.mcp ? readMcp(rig.mcp) : undefined,
    wrap,
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
      if (!hit) {
        clearLimit(servedAt(tail))
        if (servedAt(tail)) clearManagerLimit()
      }
      if (hit && hit.at > startedAt) {
        const wait = swapAccount(hit, Date.now())
        if (wait === 0) {
          isSwapped = true
          child.kill()
        } else recordManagerLimit({ ...hit, resetsAt: wait || hit.resetsAt })
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

/** withoutFleet() plus a deny rule: the file-edit tools of an agent pass cannot write the pass's own .git. Only `Edit(path)` rules match, and `./` is the cwd. */
export const passSettings = (dirs = process.env['CLAUDE_CODE_PLUGIN_DIRS'] ?? '') => ({
  ...withoutFleet(dirs),
  permissions: { deny: ['Edit(./.git/**)'] },
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
export const limitPagedFile = (
  runner: { local?: boolean; name: string },
  codex: boolean,
  cursor = false,
  grok = false,
) =>
  join(
    HOME,
    runner.local
      ? 'limit-paged.json'
      : `limit-paged-${runner.name}${codex ? '-codex' : cursor ? '-cursor' : grok ? '-grok' : ''}.json`,
  )

/**
 * This function reads a limit-paged file. The file can hold data from before the bound. A value that is not a
 * finite number, or that is more than LIMIT_RESET_MAX_MS ahead, counts as no file (0), so it cannot mute mail or hold a run.
 */
export function trustedPaged(file: string, now: number): number {
  let v: unknown
  try {
    v = existsSync(file) ? readJson<unknown>(file) : 0
  } catch {
    return 0
  }
  return typeof v === 'number' && Number.isFinite(v) && v <= now + LIMIT_RESET_MAX_MS ? v : 0
}

/**
 * This function reads an egress-paged file: a bare number (old form) or {since, at}. A value that is not a finite
 * number, or that is more than LIMIT_SKEW_MS ahead, counts as no file (undefined), so it cannot mute the notice mail.
 */
export function trustedEgressPaged(file: string, now: number): { since: number; at: number } | undefined {
  let v: unknown
  try {
    v = existsSync(file) ? readJson<unknown>(file) : undefined
  } catch {
    return undefined
  }
  const ok = (n: unknown): n is number => Number.isFinite(n) && (n as number) <= now + LIMIT_SKEW_MS
  if (ok(v)) return { since: v, at: 0 }
  const o = v as { since?: unknown; at?: unknown } | null
  return o && typeof o === 'object' && ok(o.since) && ok(o.at) ? { since: o.since, at: o.at } : undefined
}

/** the facts a patrol needs about a working run: how long, how quiet, and whether its runner waits on a usage limit */
function facts(
  run: Run,
  c: Ctx,
  now: number,
  h?: string | null,
): Pick<Row, 'inMin' | 'quietMin' | 'limitUntil'> {
  if (!c.pane || !c.startedAt) return {}
  const p = progressOf(run)
  const runner = runnerOf(c.pane)
  const paged = limitPagedFile(runner, h === 'codex', h === 'cursor', h === 'grok')
  const until = trustedPaged(paged, now)
  return {
    inMin: Math.floor((now - c.startedAt) / 60_000),
    ...(p?.seq === c.seq && { quietMin: Math.floor((now - p.at) / 60_000) }),
    ...(until > now && { limitUntil: until }),
  }
}

const progressFile = (run: Run) => join(runDir(run.id), 'progress.json')
/** when an attempt's AX task was last seen waiting for capacity: {seq, at} */
const queuedFile = (run: Run) => join(runDir(run.id), 'queued.json')
const queuedOf = (run: Run) =>
  existsSync(queuedFile(run)) ? readJson<{ seq: number; at: number }>(queuedFile(run)) : undefined
/** an attempt's clock starts when it stops waiting for AX capacity: a full pool never spends the station's time */
export const attemptStart = (startedAt: number, seq: number, q?: { seq: number; at: number }) =>
  q?.seq === seq ? Math.max(startedAt, q.at) : startedAt
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
        ...(c.mail[node] ?? []).map(m => `  from ${m.from}: ${indentRest(m.text)}`),
        `decide with: ${CLI} decide ${run.id} <${Object.keys(n.next).join('|')}> '<note for the next station>'`,
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
    const starter = runnerOfStation(run, def, node)
    if (!starter.local && bdSkewHeld(run, starter.name, now))
      return `needs the person: bd version skew on ${starter.name}`
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
      const base = baseBranchOf(def, rigOf(run.repo), run.repo)
      const files = conflictsOf(run.repo, base, run.branch)
      if (files.length) {
        // the head names the pushed commit, so a new push with the same files is a new conflict (claude-factory-gclk)
        const head = Bun.spawnSync(['git', '-C', run.repo, 'rev-parse', '--short', `origin/${run.branch}`])
          .stdout.toString()
          .trim()
        const summary = `no worker: merge origin/${base} into ${run.branch} at ${head}; conflicts in: ${files.join(', ')}; keep both sides of CHANGELOG.md [Unreleased]`
        // the same conflict at the same head again: implement pushed nothing that resolves it
        // (claude-factory-cjqo: 16 loops on a wrong base)
        if (prevReport(c.log, node, n.next)?.summary === summary)
          send({
            type: 'BLOCKED',
            seq: c.seq,
            reason: `the same merge conflict again after implement: ${summary}`,
          })
        else send({ type: 'DONE', seq: c.seq, outcome: n.mergeCheck, summary })
        return 'merge conflict'
      }
    }
    const pane = spawn(run, def, node, c)
    send({ type: 'SPAWNED', seq: c.seq, pane })
    const box = c.mail[node] ?? [] // the brief carried the whole box
    if (box.length) send({ type: 'READ', box: node, seen: box.length })
    return 'starting'
  }
  // a herdr pane in the AX manager came from the laptop, and its session is not here. Start a fresh worker on
  // AX. HANDOFF spends no attempt and clears the pane
  if (isLaptopPane(inAx(), c.pane)) {
    send({ type: 'HANDOFF', seq: c.seq, summary: 'worker moved to AX: relaunched fresh' })
    return 'moved to AX'
  }
  const runner = runnerOf(c.pane)
  const info = runner.info(run, c.pane)
  if (runner.name === 'ax' && info?.status === 'pending' && holdUnavailableAx(c, send))
    return 'AX executor unavailable'
  if (info?.queued) {
    writeJson(queuedFile(run), { seq: c.seq, at: now })
    return 'queued for AX capacity'
  }
  // the runner gave up retrying something itself (a put stuck over ax ssh): fail now, with its reason, instead
  // of the generic "was closed" or a silent retry forever
  if (info?.failed) {
    if (info.bdSkew) {
      // one Question for each rig: the marker says it was asked. The hold lasts one probe window.
      const file = bdSkewFile(run)
      const old = existsSync(file) ? readJson<{ at?: number; since?: number }>(file) : null
      const asked = old !== null
      const rig = rigOf(run.repo)?.name ?? basename(run.repo)
      const since = typeof old?.since === 'number' ? old.since : typeof old?.at === 'number' ? old.at : now
      writeJson(file, { since, at: now, runner: runner.name, error: info.bdSkew })
      if (!asked)
        send({
          type: 'MAIL',
          from: 'factory',
          to: 'manager',
          text: `Question: bd on the ${runner.name} image cannot read ${rig}'s beads (\`${info.bdSkew}\`). How should the factory go on?\nOptions: update bd: update bd on the ${runner.name} image; the next probe start clears the hold | pause the rig: pause ${rig} until bd is fixed`,
        })
      send({ type: 'FAIL', seq: c.seq, reason: info.failed, hold: now + SKEW_PROBE_MS })
      return info.status
    }
    if (info.resumeFailed && !noSuspend(run))
      send({ type: 'MAIL', from: 'factory', to: 'manager', text: markNoSuspend(run, info.resumeFailed) })
    if (isBootstrapFail(info.failed)) {
      // a bd bootstrap outage spends no attempt: 2 min for the first hit, the streak floor and one mail for the next
      const prev = c.log.at(-1)
      const again = prev?.node === node && prev.outcome === 'outage' && isBootstrapFail(prev.summary)
      const text = `bd bootstrap fails on ${rigOf(run.repo)?.name ?? basename(run.repo)} VMs`
      if (again && !(c.mail.manager ?? []).some(m => m.from === 'factory' && m.text === text))
        send({ type: 'MAIL', from: 'factory', to: 'manager', text })
      send({
        type: 'FAIL',
        seq: c.seq,
        reason: info.failed,
        hold: again ? 0 : now + 120_000,
        ...(again ? {} : { holdMin: 2 }),
      })
      return info.status
    }
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
  const agentHarness = harnessOf(agentOfNode(run, def, node))
  const isCodex = agentHarness === 'codex'
  const isCursor = agentHarness === 'cursor'
  const isGrok = agentHarness === 'grok'
  const pool = isCursor ? 'Cursor' : isGrok ? 'Grok' : isCodex ? 'Codex' : 'Claude'
  if (isCodex && !runner.local) refreshCodexToken(now, runner.name)
  const hit = trustedHit((isCodex || isCursor || isGrok) && !runner.local ? info?.limit : limitHit(tail), now)
  if (!hit && runner.local) clearLimit(servedAt(tail))
  if (hit && hit.at > c.startedAt) {
    // A VM's Claude uses the vault's token. ccswitch does not rotate this token. With a swap command,
    // runTokenSwap moves to a new slot, and the worker goes on when the vault refreshes. With no swap
    // command, the worker waits for the reset, and the nudge below then gives it its next turn.
    const refused = hit.kind === 'auth'
    // a Cursor or Grok limit has no swap command: the worker waits for the reset
    const until = runner.local
      ? swapAccount(hit, now)
      : isCursor || isGrok
        ? hit.resetsAt || hit.at + 3_600_000
        : runTokenSwap(hit, now, runner.name, send, node, isCodex ? 'codex' : 'claude')
    if (until > now) {
      // a long wait: the next harness of agents.order takes the station now, if one is free (claude-factory-gf16e)
      if (agentHarness && !refused && (runner.local || until - now > TOKEN_SWAP_WAIT_MS)) {
        recordHarnessLimit(runner.name, agentHarness, until)
        forgetPick(run.id, node)
        const next = harnessOf(agentOfNode(run, def, node))
        if (next && next !== agentHarness) {
          if (runner.local) runner.close(c.pane)
          const reason = `${pool} usage limit (${hit.kind}) until ${new Date(until).toISOString()}: ${node} moves to ${next} (agents.order)`
          send({ type: 'FAIL', seq: c.seq, reason, hold: now, holdMin: 0 })
          return 'usage limit'
        }
      }
      // a wait past the vault refresh would freeze this run for days: park the station until the reset (dhof hold)
      if (!runner.local && until - now > TOKEN_SWAP_WAIT_MS) {
        const reason = `${pool} ${refused ? 'login refused' : 'usage limit'} (${hit.kind}) until ${new Date(until).toISOString()}`
        send({ type: 'FAIL', seq: c.seq, reason, hold: until })
        return 'usage limit'
      }
      const paged = limitPagedFile(runner, isCodex, isCursor, isGrok)
      if (trustedPaged(paged, now) < until) {
        const text = runner.local
          ? `Every Claude account is ${refused ? 'login refused' : 'at its usage limit'} (${hit.kind}); workers wait until ${new Date(until).toLocaleString()} and restart then. Log in another account with ccswitch to go on sooner.`
          : `The ${pool} token ${runner.name} workers run on is ${refused ? `login refused (${hit.kind})` : `at its usage limit (${hit.kind})`}; they wait until ${new Date(until).toLocaleString()} and go on then.`
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
  // the laptop does not trust the VM's egress record (claude-factory-vl5j)
  const egress = trustedEgress(info?.egress, now)
  const retries = (n: number) => `${n} ${n === 1 ? 'retry' : 'retries'}`
  if (egress) {
    // keyed per run+node, not per runner: the gateway is shared, so a single outage hits every concurrent
    // AX worker at once, and a file keyed only by the runner's name would have them overwrite each other's
    // `since` and each mail the manager on every tick
    const paged = join(runDir(run.id), `egress-paged-${node}.json`)
    // keyed on the laptop's clock: `since` comes from the VM, so only `at` limits how often it can page
    const was = trustedEgressPaged(paged, now)
    if (!was || (egress.since > was.since && now >= was.at + EGRESS_REPAGE_MS)) {
      const since = new Date(egress.since).toLocaleString()
      // from 'factory', not node: a notice, not a question, so it never reads as the station asking the
      // manager something and awaiting a reply (isAsking keys off mail with from === node)
      send({
        type: 'MAIL',
        from: 'factory',
        to: 'manager',
        text: `${node} of ${run.id}: the egress gateway is refusing new connections to the model API (since ${since}, ${retries(egress.tries)} so far). The worker is retrying itself; see docs/remote-runner.md if it does not clear on its own.`,
      })
      writeJson(paged, { since: egress.since, at: now })
    }
  }
  const egressReason =
    egress &&
    `egress gateway: model API unreachable since ${new Date(egress.since).toISOString()} (${retries(egress.tries)}): ${egress.last}`
  const limitPage = limitPagedFile(runner, isCodex, isCursor, isGrok)
  const pagedUntil = trustedPaged(limitPage, now)
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
    const cmd = reportCmd(run, c, 'handoff')
    const text = `[factory] This session's context is ${k}k tokens, ${HANDOFF_ASK} of ${maxK}k: every turn re-reads all of it. At the next safe point, commit your work in progress (a WIP commit is fine) and hand off to a fresh worker, then stop. The summary file holds what is done, what is left and how, and what you learned that the code does not show: ${cmd}`
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
    now - attemptStart(c.startedAt, c.seq, queuedOf(run)),
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
    const text = `${node} of ${run.id} stalled: no output for ${min} min, attempt failed. Last line: ${cleanText(last, 200)}`
    send({ type: 'MAIL', from: node, to: 'manager', text })
  } else if (stall === 'nudge') {
    const min = Math.round((now - seen.at) / 60_000)
    const cmd = reportCmd(run, c, 'blocked')
    runner.deliver(
      c.pane,
      `[factory] Nothing in your session or branch has changed for ${min} min. If you are stuck, report what blocks you (the summary file says why): ${cmd}. Otherwise carry on.`,
    )
  } else if (due === 'warn') {
    const cmd = reportCmd(run, c)
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
  } else if (isAsking && status === 'idle' && runner.suspend && !noSuspend(run)) {
    runner.suspend(c.pane)
  } else if (
    !isAsking &&
    (status === 'idle' || status === 'done') &&
    // a worker waiting on its own build answers a nudge and goes idle again: give it longer each time
    now - Math.max(c.startedAt, c.nudgedAt) > GRACE_MS * 2 ** c.nudges
  ) {
    if (c.nudges >= NUDGES) failOutage(egressReason ?? 'worker stopped without reporting')
    else {
      const cmd = reportCmd(run, c)
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
/** drop the verdicts of items that are no longer pending (installed, rejected or changed text), so reviews.json stays small */
const pruneReviews = () => {
  try {
    const store = readReviews()
    const live = new Set(memory.reviewItems(MEMORY).map(i => i.key))
    const keys = Object.keys(store)
    const kept = keys.filter(k => live.has(k))
    if (kept.length < keys.length) writeJson(reviewsFile(), Object.fromEntries(kept.map(k => [k, store[k]!])))
  } catch {
    // housekeeping only: a failed prune must not break the tick
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
    if (step === 'close') {
      // ponytail: a Suspended or serve-exited task's usage is still lost here; resume it before the read to keep it
      if (info!.status === 'working' || info!.status === 'idle') storeAxUsage(run, c.pane!, node, c.seq, true)
      runnerOf(c.pane!).close(c.pane!)
    }
    halt.closed[run.id] = c.seq
  }
  writeJson(haltFile(), halt)
  return step === 'wait' || step === 'tell' ? 'stopping' : 'paused'
}

/** a herdr worker's station ended: keep what its transcripts show. A failure here must never fail the tick */
function storeUsage(run: Run, pane: string, node: string, seq: number, startedAt: number) {
  try {
    if (runnerOf(pane).name !== 'herdr' || !startedAt) return
    // a transcript that the previous station still wrote belongs to the first station that stored its session
    const owner = new Map<string, Usage>()
    for (const r of storedUsage(run.id)) if (!owner.has(r.session)) owner.set(r.session, r)
    const rows = usageOf(run, startedAt)
    // a codex pane keeps its rollouts in its own CODEX_HOME (codexWorker): store them as the AX path does
    try {
      rows.push(...worker.codexHomeUsage(join(runDir(run.id), 'codex', node), startedAt, node, seq))
    } catch {} // a bad codex file must not drop the Claude rows
    rows.forEach((u, i) => {
      const o = owner.get(u.session)
      rows[i] = { ...u, node: o?.node ?? node, seq: o?.seq ?? seq }
    })
    if (rows.length) appendUsage(run.id, rows)
  } catch {}
}
/**
 * An AX station closed. If no report stored usage for this node and seq (a timeout, a lost worker, a refused
 * usage), ask the VM for its rows with `factory worker usage`. The VM is untrusted: ax.usage caps the
 * output, and validUsage checks every row and sets node and seq. A factory stop's close also calls it with
 * `halt`: those rows get `halt: true`, and halt rows do not stop a later read, because a resume keeps the
 * seq and starts a new VM. Never throw.
 */
function storeAxUsage(run: Run, pane: string, node: string, seq: number, halt = false) {
  try {
    if (runnerOf(pane).name !== 'ax') return
    if (storedUsage(run.id).some(r => r.node === node && r.seq === seq && !r.halt)) return
    const rows = validUsage(ax.usage(ax.taskOf(pane)), node, seq)
    if (rows.length) appendUsage(run.id, halt ? rows.map(r => ({ ...r, halt: true as const })) : rows)
  } catch {}
}
const usageFile = (id: string) => join(runDir(id), 'usage.jsonl')
const appendUsage = (id: string, rows: Usage[]) => {
  appendFileSync(usageFile(id), rows.map(r => JSON.stringify(r) + '\n').join(''))
  logGrokSpend(HOME, id, rows)
}
/** a run's stored rows; a node, seq, session and model that was stored twice (a resumed worker) keeps its last row */
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
  return [...new Map(rows.map(r => [`${r.node}\0${r.seq}\0${r.session}\0${r.model}`, r])).values()]
}

async function tickRun(run: Run, now: number, halt: Halt | null = null) {
  const def = await loadPinned(run.factory)
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
      storeAxUsage(run, pane, node, seq)
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
    // a migrated run's worktree is not in the task: make it from origin before any git call in it
    if (sub === 'working' && inAx() && !existsSync(run.worktree)) reviveWorktree(run)
    if (sub === 'working')
      agent = haltRun(run, def, node, ctx(), send, halt, now) ?? reconcile(run, def, ctx(), node, send, now)
    else agent = agentOf(def, actor.getSnapshot().value, ctx())
  } catch (err) {
    error = (err as Error).message
    // a refused launch would refuse again in the next tick: end the attempt (fresh, resume, swap and halt spawns)
    const refusal = launchRefusal(err, ctx().seq)
    if (refusal) send(refusal)
  }
  keepTickError(run.id, error)

  error ??= run.bead ? trackOf(run.id, saved).error : undefined

  const manager = unread(ctx(), 'manager')
  if (manager.length) send({ type: 'READ', box: 'manager', seen: ctx().mail.manager!.length })
  save()
  return {
    row: {
      ...row(run, def, actor.getSnapshot().value, ctx(), agent, error),
      ...(sub === 'working' &&
        !def.nodes[node]?.gate &&
        facts(run, ctx(), now, harnessOf(agentOfNode(run, def, node)))),
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

/** the NAME a factory:<name> label takes: the base name of the run's factory file, else the def's name */
export const factoryLabelName = (run: Run, def: Factory) => {
  if (!run.factoryFrom) return def.name // run.factory is the pinned factory.json, not a name
  const src = run.factoryFrom.replace(/ at [0-9a-f]{7,40}$/, '')
  const base = basename(src, extname(src))
  return NAME.test(base) ? base : def.name
}

/** mirrors a run into its bead, advancing `t` as each write lands so a failure retries next tick */
export function track(
  run: Run,
  def: Factory,
  value: unknown,
  c: Ctx,
  t: Track,
  now: number,
  // ponytail: with no PR list here, any run of a parent holds it; the repair pass closes it later
  runBeads: () => Set<string> = () => new Set(runBeadsOf(run.repo).values()),
) {
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
      b.defer(id, reason, current && linearSourced(current) ? undefined : station, factoryLabelName(run, def))
    }
    // not the factory's to do: left open for a person, who queues it again or closes it
    else if (typeof edge === 'object' && edge.reject) b.reject(id, `${run.id}/${last!.node}`, reason)
    else if (!b.close(id, reason)) b.defer(id, `run ${run.id} could not close it: ${reason}`)
    else closeParents(b, run.repo, id, `run ${run.id}`, undefined, runBeads())
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

/**
 * `factory server backup`: one backup of the server home in its own process, so a long git call cannot stop the server's lease renewal.
 * backup.lock keeps one backup per home. While it holds that lock, it removes the git lock files that a killed backup left.
 */
async function serverBackup() {
  const b = server.serverBackupCfg(process.env, HOME)
  if (!b) return console.log('backup off: no remote')
  if ('off' in b) return console.log(b.off)
  const own = hold('backup.lock')
  if (!own) return console.log('backup skipped: another backup runs')
  try {
    const gitDir = join(b.cfg.ws, 'backup.git')
    if (existsSync(gitDir))
      for (const f of readdirSync(gitDir, { recursive: true, encoding: 'utf8' }))
        if (f.endsWith('.lock') && (!f.includes('/') || f.startsWith('refs/')))
          rmSync(join(gitDir, f), { force: true })
    await managerhost.backupStep(
      b.cfg,
      existsSync(join(HOME, 'rigs.json')),
      () => hold('tick.lock'),
      console.log,
    )
  } finally {
    own()
  }
}

/** a lock held while its process lives, however long it takes: a pass over slow bd can take minutes */
export function hold(name: string, rm?: Parameters<typeof rmSafe>[2], home = HOME): (() => void) | null {
  const dir = join(home, name)
  mkdirSync(home, { recursive: true })
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
  return () => {
    try {
      rmSafe(dir, { recursive: true, force: true }, rm)
    } catch {
      // release runs in finally: do not throw. Drop the live pid and age the dir, so the next hold() takes over.
      try {
        rmSync(join(dir, 'pid'), { force: true })
        utimesSync(dir, 0, 0)
      } catch {}
    }
  }
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

/** the live ship runs */
const liveShipRuns = () =>
  runIds().flatMap(id => {
    try {
      const run = loadRun(id)
      if (!run.ship) return []
      const saved = readJson<Saved>(join(runDir(id), 'state.json'))
      const { value, context: c } = saved.snapshot
      const ended = ['done', 'aborted'].includes(where(value)[0])
      const revival = ended
        ? inboxLines(id)
            .slice(saved.cursor)
            .map(line => JSON.parse(line) as Ev)
            .find(e => e.type === 'GOTO' && e.node !== 'done')
        : undefined
      return !ended || revival
        ? [{ run, node: revival?.type === 'GOTO' ? revival.node : where(value)[0], c }]
        : []
    } catch {
      return [] // removed mid-pass
    }
  })

/** A live ship run on the rig of `run`, other than `run`. Only when `run` counts as a ship run (claude-factory-9wch). */
const otherLiveShip = (run: Run) =>
  run.ship ? liveShipRuns().find(s => s.run.id !== run.id && s.run.repo === run.repo) : undefined

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
            await loadPinned(run.factory),
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
    await orphanPass()
    axSweep()
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

/** A line break in worker text (the str.splitlines set) gets 4 spaces after it. The text cannot forge a dream prompt line. */
const indentRest = (s: string) => s.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/).join('\n    ')

/** one dream journal entry */
export const journalLine = (
  id: string,
  rig: string,
  e: Pick<Entry, 'node' | 'attempt' | 'outcome' | 'summary'>,
) => `- ${id} ${rig} ${e.node}#${e.attempt} ${e.outcome}: ${indentRest(clip(e.summary, 600))}`

/** one closed-bead line of the dream prompt: the title and the close reason come from workers */
export const closedLine = (id: string, rig: string, bead: { title: string; close_reason?: string | null }) =>
  indentRest(`- ${id} (${rig}): ${bead.title}. Closed: ${clip(bead.close_reason ?? '', 300)}`)

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
            line: journalLine(id, rig, e),
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

const memGit = (...args: string[]) => git(MEMORY, ...NO_HOOKS, ...args)
const MEMORY_REFUSED = 'memory: repo config not allowed, nothing committed'
const memoryRefused = () => (
  appendFileSync(join(HOME, 'dream.log'), `${new Date().toISOString()} ${MEMORY_REFUSED}\n`),
  false
)

/** commit the memory notes with no hook; false (and a dream.log line) when the repo config is not allowed */
export function commitMemory(message: string): boolean {
  if (!repoConfigOk(MEMORY)) return memoryRefused()
  memGit('add', '-A')
  if (memGit('status', '--porcelain')) memGit('commit', '-q', '-m', message)
  return true
}

const WIKI_PAGE_MAX = 65_536
const WIKI_EMAIL = `factory@${hostname()}`
const WIKI_VISIBLE = ['PUBLIC', 'PRIVATE', 'INTERNAL']
const WIKI_CACHE_MS = 24 * 3600_000
const WIKI_SEEDS: Record<string, string> = {
  'index.md': `---\nkind: "index"\ntitle: "Factory wiki"\n---\nThe factory writes this wiki. Start from the pages below.\n`,
  'glossary.md': `---\nkind: "glossary"\ntitle: "Glossary"\n---\n## station\n\none step of a factory run, such as plan or implement.\n\n## soak\n\nthe time a deployed change runs under watch before a run ends.\n\n## rig\n\na repository the factory works on.\n\n## ship lane\n\nthe path of a pull request from ready to merged.\n\n## bead\n\none tracked task in bd.\n\n## run\n\none trip of a goal through the stations of a factory.\n`,
}

/**
 * The only remotes the wiki accepts: git@host:owner/repo, ssh://git@host/owner/repo and
 * https://host/owner/repo, each with an optional .git. Anything else gives null: userinfo, ports,
 * local paths, transport helpers, a leading dash or a control character.
 */
export function wikiRemote(url: string) {
  if (url.length > 300 || /[\s\p{Cc}]/u.test(url)) return null
  const m = /^(?:git@([^:/]+):|ssh:\/\/git@([^/]+)\/|https:\/\/([^/]+)\/)([^/]+)\/([^/]+)$/.exec(url)
  if (!m) return null
  const host = m[1] ?? m[2] ?? m[3]!
  const [owner, repo] = [m[4]!, m[5]!.replace(/\.git$/, '')]
  const word = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || !host.includes('.')) return null
  return word.test(owner) && word.test(repo) ? { host, owner, repo } : null
}

/** one line in $HOME/wiki.log and on stderr; a caller passes fixed text and validated paths only */
function wikiLog(line: string) {
  mkdirSync(HOME, { recursive: true })
  appendFileSync(join(HOME, 'wiki.log'), `${new Date().toISOString()} ${line}\n`)
  console.error(line)
}

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/**
 * The key names that the repo config of wiki/.git and memory/.git may hold. Each key runs no program and
 * rewrites no URL. POSIX ERE only, so `grep -E` in CONFIG_SYNC uses the same source text.
 */
export const REPO_CONFIG_KEY =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|extensions\.(objectformat|refstorage)|user\.(name|email)|remote\.origin\.(url|fetch|pushurl)|branch\.[A-Za-z0-9_./-]+\.(remote|merge))$/

/** true only when each key name of the repo's own config is in REPO_CONFIG_KEY; a failed read or no key refuses */
function repoConfigOk(dir: string) {
  const p = wikiGit(dir, ['config', '--local', '--name-only', '--null', '--list'])
  const keys = p.out.toString().split('\0').slice(0, -1)
  return p.code === 0 && keys.length > 0 && keys.every(k => REPO_CONFIG_KEY.test(k))
}

/** git in the wiki: no identity, repo or index from the caller's environment, and literal pathspecs */
function wikiGit(dir: string, args: string[], network = false, extraEnv: Record<string, string> = {}) {
  if (memory.gitFenced(dir)) return { code: 1, out: Buffer.alloc(0) }
  const env: Record<string, string | undefined> = {
    ...(network ? gitNetworkEnv() : process.env),
    GIT_LITERAL_PATHSPECS: '1',
    GIT_CEILING_DIRECTORIES: dirname(dir),
  }
  for (const k of Object.keys(env))
    if (/^GIT_(AUTHOR|COMMITTER)_/.test(k) || /^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k]
  Object.assign(env, extraEnv)
  const p = Bun.spawnSync(['git', '-C', dir, ...NO_HOOKS, ...args], {
    env,
    stderr: 'pipe',
    timeout: network ? GIT_NETWORK_TIMEOUT_MS : undefined,
  })
  return { code: p.exitCode, out: p.stdout }
}

function readWikiState(): Record<string, unknown> {
  try {
    const s = JSON.parse(readFileSync(join(HOME, 'wiki-state.json'), 'utf8'))
    if (s !== null && typeof s === 'object' && !Array.isArray(s)) return s
  } catch {}
  return {}
}

function writeWikiState(state: Record<string, unknown>) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'wiki-state.json'), JSON.stringify(state))
}

/** Pages a person deleted and nobody added back, kept in wiki-state.json. A failed git log uses the stored list. */
function wikiTombstones(dir: string) {
  const stored = readWikiState().tombstones
  const old = (Array.isArray(stored) ? stored : []).filter(
    (t): t is { path: string; at: string } =>
      t !== null && typeof t === 'object' && typeof t.path === 'string' && typeof t.at === 'string',
  )
  if (wikiGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']).code !== 0) return old
  const log = wikiGit(dir, [
    'log',
    '--diff-filter=D',
    '--no-renames',
    '--name-only',
    '--format=%x01%ae%x01%aI',
    'HEAD',
  ])
  const tracked = wikiGit(dir, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
  if (log.code !== 0 || tracked.code !== 0)
    return (wikiLog('wiki: tombstone read failed, stored list used'), old)
  const here = new Set(tracked.out.toString().split('\0'))
  const list = tombstones(log.out.toString(), WIKI_EMAIL).filter(t => !here.has(t.path))
  if (JSON.stringify(list) !== JSON.stringify(old)) writeWikiState({ ...readWikiState(), tombstones: list })
  return list
}

type HeadPair = { ref: string; sha: string }
type GitRun = (args: string[]) => { code: number; out: string }

/** the branch ref and commit sha that HEAD names now; undefined with no commit or a detached HEAD */
function headPair(run: GitRun): HeadPair | undefined {
  const ref = run(['symbolic-ref', '-q', 'HEAD'])
  const sha = run(['rev-parse', '--verify', '-q', 'HEAD'])
  return ref.code === 0 && sha.code === 0 && ref.out && sha.out ? { ref: ref.out, sha: sha.out } : undefined
}

/**
 * After an agent pass: 'same' when HEAD is as recorded, and 'moved' when HEAD went forward (a commit made during
 * the pass stays) or was put back. Any other move is undone with symbolic-ref and update-ref; 'restore failed' when
 * that fails. A pass that gets no tool that makes a commit or an object cannot make a forward move.
 */
function headKept(run: GitRun, pair: HeadPair): 'same' | 'moved' | 'restore failed' {
  const now = headPair(run)
  if (now && now.ref === pair.ref) {
    if (now.sha === pair.sha) return 'same'
    if (run(['merge-base', '--is-ancestor', pair.sha, now.sha]).code === 0) return 'moved'
  }
  const ok =
    run(['symbolic-ref', 'HEAD', pair.ref]).code === 0 && run(['update-ref', pair.ref, pair.sha]).code === 0
  return ok ? 'moved' : 'restore failed'
}

/**
 * Git reads config, hooks and gitdir pointers from a repo, so an agent pass that writes them makes the next factory
 * git call run a command as the factory user. gitDirSnapshot() records the control area of `root/.git`; gitDirKept()
 * after the pass puts it back and removes any nested .git (claude-factory-f1zc). The data set is what git never reads
 * as config, hooks or a pointer: objects, refs, logs, index, HEAD and the like, and regular *.lock files.
 * Key = path under .git (`.` is .git); value d:<mode> | l:<target> | f:<mode>:<nlink>:<base64> | x (other type).
 */
export type GitDirSnapshot = Record<string, string>
const GIT_DATA_TOP = new Set(
  'objects refs logs fsmonitor--daemon index HEAD ORIG_HEAD FETCH_HEAD packed-refs COMMIT_EDITMSG gc.pid gc.log fsmonitor--daemon.ipc'.split(
    ' ',
  ),
)
const ownerRwx = (p: string) => {
  try {
    if (lstatSync(p).isDirectory()) chmodSync(p, lstatSync(p).mode | 0o700)
  } catch {}
}
function readDirOwner(dir: string) {
  try {
    return readdirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') throw e
    ownerRwx(dir)
    return readdirSync(dir)
  }
}
const modeOf = (mode: number) => (mode & 0o7777).toString(8)

export function gitDirSnapshot(root: string): GitDirSnapshot {
  const top = join(root, '.git')
  const st = lstatSync(top)
  if (!st.isDirectory()) throw new Error(`${top} is not a directory`)
  const snap: GitDirSnapshot = { '.': `d:${modeOf(st.mode)}` }
  const walk = (rel: string) => {
    for (const name of readDirOwner(join(top, rel))) {
      if (!rel && (GIT_DATA_TOP.has(name) || name.startsWith('sharedindex.'))) continue
      const key = rel ? `${rel}/${name}` : name
      const p = join(top, key)
      const s = lstatSync(p)
      if (s.isDirectory()) {
        snap[key] = `d:${modeOf(s.mode)}`
        walk(key)
      } else if (s.isSymbolicLink()) snap[key] = `l:${readlinkSync(p)}`
      else if (s.isFile()) {
        if (!name.endsWith('.lock'))
          snap[key] = `f:${modeOf(s.mode)}:${s.nlink}:${readFileSync(p).toString('base64')}`
      } else snap[key] = 'x'
    }
  }
  walk('')
  return snap
}

/** count of entries named .git (ASCII case fold) under `root`, outside root/.git; `remove` deletes them (a symlink, not its target) */
function sweepNested(root: string, remove: boolean): number {
  let n = 0
  const walk = (dir: string) => {
    for (const name of readDirOwner(dir)) {
      const p = join(dir, name)
      if (p === join(root, '.git')) continue
      if (name.toLowerCase() === '.git') {
        n++
        if (remove) {
          ownerRwx(dir)
          ownerRwx(p)
          rmSync(p, { recursive: true, force: true })
        }
      } else if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(root)
  return n
}

/** The snapshot to take before a pass, or why the pass must not run. `nested` is checked first. */
export function gitDirPre(root: string): { snap: GitDirSnapshot } | { why: 'nested' | 'special' | 'notdir' } {
  try {
    if (sweepNested(root, false)) return { why: 'nested' }
    const snap = gitDirSnapshot(root)
    const special = Object.values(snap).some(
      v => v === 'x' || (v.startsWith('f:') && v.split(':')[2] !== '1'),
    )
    return special ? { why: 'special' } : { snap }
  } catch {
    return { why: 'notdir' }
  }
}
export const gitPreLine = (who: 'dream' | 'wiki', why: 'nested' | 'special' | 'notdir') =>
  ({
    dream: {
      nested: 'dream: a nested .git is in the memory, dream refused',
      special: 'dream: .git holds a special file, dream refused',
      notdir: 'dream: .git is not a directory, dream refused',
    },
    wiki: {
      nested: 'wiki: a nested .git is in the wiki, pass refused',
      special: 'wiki: .git holds a special file, pass refused',
      notdir: 'wiki: blame failed, pass refused',
    },
  })[who][why]

/** Write `<root>.fenced`: every factory git spawn in root then refuses, in later processes too. */
export function fenceGit(root: string) {
  try {
    writeFileSync(
      resolve(root) + '.fenced',
      `${new Date().toISOString()} git in ${root} refused: an agent pass changed ${root}/.git and the restore failed. Check it, then remove this file.\n`,
    )
  } catch {}
}

/**
 * After an agent pass: remove nested .git entries, compare `root/.git` with `before` and put it back.
 * 'same' when nothing differed; 'changed' when something did and it is restored; 'restore failed' (root fenced) on any error.
 * No git call runs here.
 */
export function gitDirKept(root: string, before: GitDirSnapshot): 'same' | 'changed' | 'restore failed' {
  try {
    const swept = sweepNested(root, true)
    const after = gitDirSnapshot(root)
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    const diff = [...keys].filter(k => before[k] !== after[k])
    if (!diff.length && !swept) return 'same'
    const top = join(root, '.git')
    const depth = (k: string) => k.split('/').length
    const bothDirs = (k: string) => before[k]?.startsWith('d:') && after[k]?.startsWith('d:')
    for (const k of diff
      .filter(k => k !== '.' && k in after && !bothDirs(k))
      .sort((a, b) => depth(b) - depth(a))) {
      ownerRwx(dirname(join(top, k)))
      rmSync(join(top, k), { recursive: true, force: true })
    }
    const kinds = Object.keys(before).filter(k => k !== '.')
    for (const k of kinds.sort((a, b) => depth(a) - depth(b))) {
      const p = join(top, k)
      try {
        lstatSync(p)
        continue
      } catch {}
      ownerRwx(dirname(p))
      const v = before[k]!
      if (v.startsWith('d:')) mkdirSync(p, { mode: 0o700 })
      else if (v.startsWith('l:')) symlinkSync(v.slice(2), p)
      else if (v.startsWith('f:')) {
        const [, mode, , data] = v.split(':')
        writeFileSync(p, Buffer.from(data!, 'base64'))
        chmodSync(p, parseInt(mode!, 8))
      } else throw new Error(`cannot restore ${k}`)
    }
    for (const k of Object.keys(before).sort((a, b) => depth(b) - depth(a)))
      if (before[k]!.startsWith('d:')) {
        if (k !== '.') ownerRwx(dirname(join(top, k)))
        chmodSync(k === '.' ? top : join(top, k), parseInt(before[k]!.slice(2), 8))
      }
    return 'changed'
  } catch {
    fenceGit(root)
    return 'restore failed'
  }
}

/** The journal line(s) for a pass that changed .git; `run` and `pair` are the HEAD guard that still runs after a restore. Returns the first line. */
function gitChangedAct(
  prefix: string,
  gk: 'changed' | 'restore failed',
  run: GitRun,
  pair: HeadPair,
  log: (line: string) => void,
) {
  const line = `${prefix}: .git changed in the pass, ${gk === 'changed' ? '' : 'restore failed, git fenced, '}nothing committed`
  log(line)
  if (gk === 'changed') {
    const k = headKept(run, pair)
    if (k !== 'same')
      log(`${prefix}: HEAD moved in the pass, ${k === 'moved' ? '' : 'restore failed, '}nothing committed`)
  }
  return line
}

const wikiRun =
  (dir: string): GitRun =>
  args => {
    const r = wikiGit(dir, args)
    return { code: r.code, out: r.out.toString().trim() }
  }

/** Make `file` with `text` when no entry is there ('made'). 'kept' when a regular file with one link is there.
 * 'bad' in every other case: a symlink, a hard link, another type, an lstat error that is not ENOENT, or a failed write.
 * Flag 'wx' fails on any entry, a dangling symlink too, so this never writes through a link. No journal line: the caller logs. */
export function wikiNewFile(file: string, text: string): 'made' | 'kept' | 'bad' {
  try {
    const st = lstatSync(file)
    return st.isFile() && st.nlink === 1 ? 'kept' : 'bad'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'bad'
  }
  try {
    writeFileSync(file, text, { flag: 'wx' })
    return 'made'
  } catch {
    return 'bad'
  }
}

/**
 * The branch ref and sha of HEAD, and `git blame --line-porcelain <sha>` of each tracked page outside rigs/,
 * for keepPersonLines() after an agent pass. Undefined (and a journal line) when there is no branch head
 * (no commit, or a detached HEAD) or a blame fails: the pass must not run.
 */
export function wikiBlame(dir = join(HOME, 'wiki')) {
  const pair = headPair(wikiRun(dir))
  if (!pair) return (wikiLog('wiki: no branch head, pass refused'), undefined)
  const blames = new Map<string, string>()
  const tracked = wikiGit(dir, ['ls-tree', '-r', '-z', '--name-only', pair.sha])
  if (tracked.code !== 0) return (wikiLog('wiki: blame failed, pass refused'), undefined)
  for (const path of tracked.out.toString().split('\0')) {
    if (!WIKI_PAGE_PATH.test(path) || path.split('/').includes('..') || path.startsWith('rigs/')) continue
    const b = wikiGit(dir, ['blame', '--line-porcelain', pair.sha, '--', path])
    if (b.code !== 0) return (wikiLog('wiki: blame failed, pass refused'), undefined)
    blames.set(path, b.out.toString())
  }
  const pre = gitDirPre(dir)
  if ('why' in pre) return (wikiLog(gitPreLine('wiki', pre.why)), undefined)
  return { ...pair, blames, git: pre.snap }
}

/**
 * After an agent pass: first check that HEAD is where wikiBlame() saw it (false, with a journal line, when
 * it moved). Then put back each page where the pass changed or removed a person's line, and add a flag
 * with the page, the line and `reason` to needs-person.md. The rest of the pass stays. False when a restore fails.
 * A page over WIKI_PAGE_MAX bytes counts as empty.
 */
export function keepPersonLines(
  before: NonNullable<ReturnType<typeof wikiBlame>>,
  reason: string,
  dir = join(HOME, 'wiki'),
) {
  const gk = gitDirKept(dir, before.git)
  if (gk !== 'same') return (gitChangedAct('wiki', gk, wikiRun(dir), before, wikiLog), false)
  const kept = headKept(wikiRun(dir), before)
  if (kept !== 'same')
    return (
      wikiLog(
        kept === 'moved'
          ? 'wiki: HEAD moved in the pass, nothing committed'
          : 'wiki: HEAD moved in the pass, restore failed, nothing committed',
      ),
      false
    )
  const flags: string[] = []
  for (const [path, blame] of before.blames) {
    const file = join(dir, path)
    let text = ''
    try {
      const st = lstatSync(file)
      if (st.isFile() && st.size <= WIKI_PAGE_MAX) text = readFileSync(file, 'utf8')
    } catch {}
    const hits = humanLines(blame, text, WIKI_EMAIL)
    if (!hits.length) continue
    if (wikiGit(dir, ['restore', '--staged', '--worktree', `--source=${before.sha}`, '--', path]).code !== 0)
      return (wikiLog('wiki: restore failed, nothing committed'), false)
    for (const h of hits) flags.push(flagLine(path, h.line, reason))
    wikiLog(`wiki: person's line in ${path}, page kept, flagged`)
  }
  if (flags.length) {
    const file = join(dir, 'needs-person.md')
    if (wikiNewFile(file, '---\nkind: "index"\ntitle: "Needs a person"\n---\n') === 'bad')
      return (wikiLog('wiki: needs-person.md is not a regular file, nothing committed'), false)
    appendFileSync(file, `${flags.join('\n')}\n`)
  }
  return true
}

/**
 * Stage the wiki, put every staged page that fails a check back at its last version, and commit the rest
 * as the factory identity. A page passes when its path, size (65,536 bytes) and scanPages() are clean.
 * A journal line names the path and a fixed reason, never page text. `paths` limits the staging to those pages
 * (none: the whole tree). True when it made a commit, null when nothing was staged, false on a failure.
 */
export function commitWiki(pass: string, summary: string, dir = join(HOME, 'wiki'), paths?: string[]) {
  const clean = (s: string) =>
    s
      .split('\n')[0]!
      .replace(/\p{Cc}/gu, ' ')
      .slice(0, 200)
  if (!repoConfigOk(dir)) return (wikiLog('wiki: repo config not allowed, nothing committed'), false)
  if (wikiGit(dir, ['add', '-A', '--', ...(paths ?? [])]).code !== 0)
    return (wikiLog('wiki: stage failed, nothing committed'), false)
  const list = wikiGit(dir, ['diff', '--cached', '--raw', '--no-renames', '-z', '--diff-filter=d'])
  if (list.code !== 0) return (wikiLog('wiki: staged list failed, nothing committed'), false)
  // raw -z: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0"
  const fields = list.out.toString().split('\0')
  const refused: string[] = []
  const tombs = new Set(wikiTombstones(dir).map(t => t.path))
  // a refused rename target puts its source back too, or the commit would delete the old page
  // ponytail: git pairs a rename only above 50% similarity; a rewrite below that still commits the old path's delete
  const moved = new Map<string, string>()
  const ren = wikiGit(dir, ['diff', '--cached', '--raw', '-M', '-z', '--diff-filter=R'])
  if (ren.code === 0) {
    const f = ren.out.toString().split('\0')
    for (let k = 0; k + 2 < f.length; k += 3) moved.set(f[k + 2]!, f[k + 1]!)
  }
  for (let k = 0; k + 1 < fields.length; k += 2) {
    const [, mode, , , status] = fields[k]!.split(' ')
    const path = fields[k + 1]!
    let why: string | undefined
    if (!WIKI_PAGE_PATH.test(path) || path.split('/').includes('..'))
      why = 'wiki: bad page path, page kept at last version'
    else if (status === 'A' && tombs.has(path)) why = `wiki: tombstoned path ${path}, page not made again`
    else if (mode !== '100644' && mode !== '100755')
      why = `wiki: bad file mode in ${path}, page kept at last version`
    else {
      const blob = wikiGit(dir, ['show', `:${path}`]).out
      const reasons =
        blob.length > WIKI_PAGE_MAX
          ? ['page too large']
          : (scanPages([{ path, text: blob.toString() }])[0]?.reasons ?? [])
      if (reasons.includes('secret shape')) why = `wiki: secret shape in ${path}, page kept at last version`
      else if (reasons.length) why = `wiki: ${reasons.join('; ')} in ${path}, page kept at last version`
    }
    if (!why) continue
    wikiLog(why)
    refused.push(path)
    if (wikiGit(dir, ['cat-file', '-e', `HEAD:${path}`]).code === 0)
      wikiGit(dir, ['restore', '--staged', '--worktree', '--source=HEAD', '--', path])
    else wikiGit(dir, ['rm', '--cached', '-f', '-q', '--', path])
    const old = moved.get(path)
    if (old !== undefined) {
      refused.push(old)
      wikiGit(dir, ['restore', '--staged', '--worktree', '--source=HEAD', '--', old])
    }
  }
  // a refused path that is still staged (an unstage that failed) must never reach a commit
  if (refused.length && wikiGit(dir, ['diff', '--cached', '--quiet', '--', ...refused]).code !== 0)
    return (wikiLog('wiki: unstage failed, nothing committed'), false)
  if (wikiGit(dir, ['diff', '--cached', '--quiet']).code !== 1) return null
  const c = wikiGit(
    dir,
    [
      '-c',
      'user.name=factory',
      '-c',
      `user.email=${WIKI_EMAIL}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      `wiki ${clean(pass)}: ${clean(summary)}`,
    ],
    false,
    {
      GIT_AUTHOR_NAME: 'factory',
      GIT_AUTHOR_EMAIL: WIKI_EMAIL,
      GIT_COMMITTER_NAME: 'factory',
      GIT_COMMITTER_EMAIL: WIKI_EMAIL,
    },
  )
  if (c.code !== 0) wikiLog(`wiki: commit failed (exit ${c.code})`)
  return c.code === 0
}

/** PUBLIC, PRIVATE or INTERNAL from `gh repo view`; read at most once in 24 h per remote unless `fresh`. Else undefined. */
function wikiVisibility(r: { host: string; owner: string; repo: string }, fresh = false) {
  const remote = `${r.host}/${r.owner}/${r.repo}`
  const state = readWikiState()
  const c = state.visibility as { value?: string; checkedAt?: string; remote?: string } | undefined
  if (
    !fresh &&
    c?.remote === remote &&
    WIKI_VISIBLE.includes(c.value ?? '') &&
    Date.now() - Date.parse(c.checkedAt ?? '') >= 0 &&
    Date.now() - Date.parse(c.checkedAt ?? '') < WIKI_CACHE_MS
  )
    return c.value
  const p = Bun.spawnSync(['gh', 'repo', 'view', remote, '--json', 'visibility', '--jq', '.visibility'], {
    env: gitNetworkEnv(),
    stderr: 'pipe',
    timeout: 30_000,
  })
  const value = p.exitCode === 0 ? p.stdout.toString().trim() : ''
  if (!WIKI_VISIBLE.includes(value)) return undefined
  writeWikiState({ ...state, visibility: { value, checkedAt: new Date().toISOString(), remote } })
  return value
}

/** True only when the remote is PRIVATE or INTERNAL; every other answer logs one fixed line and refuses. */
function wikiAllowed(r: { host: string; owner: string; repo: string }, fresh = false) {
  const vis = wikiVisibility(r, fresh)
  if (vis === 'PRIVATE' || vis === 'INTERNAL') return true
  wikiLog(
    vis === 'PUBLIC'
      ? 'wiki: remote is public, push refused'
      : 'wiki: remote visibility unknown, push refused',
  )
  return false
}

/**
 * Push HEAD to `branch` (default main) of origin only when the checkout is on that branch and origin passes wikiRemote() and its visibility is PRIVATE or INTERNAL.
 * It pushes to the checked URL, never to the name `origin`, so a pushurl set by hand is not used. No origin:
 * nothing to do. True when the push worked.
 */
export function pushWiki(dir = join(HOME, 'wiki'), branch = 'main') {
  if (!repoConfigOk(dir)) return (wikiLog('wiki: repo config not allowed, push refused'), false)
  if (wikiGit(dir, ['symbolic-ref', '-q', 'HEAD']).out.toString().trim() !== `refs/heads/${branch}`)
    return (wikiLog(`wiki: checkout not on ${branch}, push refused`), false)
  const url = wikiGit(dir, ['config', '--get', 'remote.origin.url']).out.toString().trim()
  if (!url) return false
  const r = wikiRemote(url)
  if (!r) return (wikiLog('wiki: remote not allowed, push refused'), false)
  if (!wikiAllowed(r)) return false
  const p = wikiGit(dir, ['push', url, `HEAD:refs/heads/${branch}`], true)
  if (p.code !== 0) wikiLog(`wiki: push failed (exit ${p.code})`)
  return p.code === 0
}

/**
 * Pull main of origin into the checkout (rebase, so each commit keeps its author for the blame guard). A failed
 * pull gets a rebase abort and a journal line; the caller goes on. No origin: nothing to do.
 */
function pullWiki(dir: string) {
  if (!repoConfigOk(dir)) return wikiLog('wiki: repo config not allowed, pull skipped')
  const url = wikiGit(dir, ['config', '--get', 'remote.origin.url']).out.toString().trim()
  if (!url) return
  if (!wikiRemote(url)) return wikiLog('wiki: remote not allowed, pull skipped')
  const args = ['-c', 'user.name=factory', '-c', `user.email=${WIKI_EMAIL}`, '-c', 'commit.gpgsign=false']
  const p = wikiGit(
    dir,
    [...args, '-c', 'rebase.autoStash=false', 'pull', '--rebase', '--no-autostash', '-q', url, 'main'],
    true,
    { GIT_COMMITTER_NAME: 'factory', GIT_COMMITTER_EMAIL: WIKI_EMAIL },
  )
  if (p.code === 0) return
  wikiGit(dir, ['rebase', '--abort'])
  wikiLog(`wiki: pull failed (exit ${p.code ?? 'timeout'}), refresh goes on`)
}

const GROOM_PLAN_ONLY = '\n\nDo only step 1 now. Print the plan and change no file.\n'
const GROOM_APPLY =
  '\n\nStep 1 is done. The rig repos are not open to you now. Do only step 2, for these lines and no other:\n\n'

/** one groom agent call: `-p`, no MCP, no project settings; stdout and stderr are piped so raw output stays private */
function groomAgent(dir: string, stdin: string, mode: string, tools: string, addDirs: string[]) {
  const settings = passSettings()
  const p = Bun.spawnSync(
    [
      ...claudeCommand().split(/\s+/),
      ...['-p', '--strict-mcp-config', '--setting-sources', 'user'],
      ...['--permission-mode', mode, '--tools', tools],
      ...addDirs.flatMap(d => ['--add-dir', d]),
      ...[
        '--settings',
        JSON.stringify({ ...settings, env: { ...settings.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } }),
      ],
    ],
    { cwd: dir, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', timeout: 45 * 60_000 },
  )
  return { code: p.exitCode, out: p.stdout.toString() }
}

/**
 * `factory wiki groom`: ask an agent for a plan, apply it on branch groom/<date> from origin/main, revert every
 * path outside the plan, and open a pull request with the plan as its body. It never merges and never pushes
 * main. With `dryRun` it only prints the plan. Each stop journals one fixed line and the pass exits 0.
 */
function wikiGroom(dryRun: boolean) {
  const dir = join(HOME, 'wiki')
  const g = (...args: string[]) => wikiGit(dir, args)
  const text = (r: { out: Buffer }) => r.out.toString().trim()
  const list = (...args: string[]) =>
    g('ls-files', '-z', ...args)
      .out.toString()
      .split('\0')
      .filter(Boolean)
  const exit = (r: { code: number | null }) => r.code ?? 'timeout'
  const plan = () => {
    const repos = rigs()
      .map(r => r.repo)
      .filter(d => existsSync(d))
    const prompt = groomPrompt(wikiPages(dir), wikiTombstones(dir), groomCap())
    const r = groomAgent(dir, prompt + GROOM_PLAN_ONLY, 'default', 'Read,Glob,Grep', repos)
    if (r.code !== 0) return wikiLog(`wiki groom: plan call failed (exit ${exit(r)})`)
    const actions = groomPlan(r.out)
    if (!actions.length) return wikiLog('wiki groom: no actions')
    return {
      prompt,
      actions,
      planText: actions.map(a => `${a.op} ${a.paths.join(' ')} — ${a.reason}`).join('\n'),
    }
  }
  if (dryRun) {
    const p = plan()
    if (p) console.log(p.planText)
    return
  }

  if (!repoConfigOk(dir)) return wikiLog('wiki groom: repo config not allowed, skipped')
  const head = text(g('symbolic-ref', '-q', 'HEAD'))
  if (head.startsWith('refs/heads/groom/')) {
    if (g('status', '--porcelain', '-z', '--untracked-files=all').out.length)
      return wikiLog('wiki groom: left-over groom checkout not clean, skipped')
    if (g('checkout', '-q', 'main').code !== 0) return wikiLog('wiki groom: checkout of main failed')
    g('branch', '-q', '-D', head.slice('refs/heads/'.length))
    wikiLog('wiki groom: left-over groom checkout, back on main')
  }
  const url = text(g('config', '--get', 'remote.origin.url'))
  if (!url) return wikiLog('wiki groom: no remote, skipped')
  const r = wikiRemote(url)
  if (!r) return wikiLog('wiki: remote not allowed, push refused')
  if (!wikiAllowed(r)) return
  const slug = `${r.host}/${r.owner}/${r.repo}`
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const PR_RE = new RegExp(`^https://${esc(r.host)}/${esc(r.owner)}/${esc(r.repo)}/pull/[1-9][0-9]*$`, 'i')
  const gh = (args: string[]) =>
    Bun.spawnSync(['gh', ...args], { env: gitNetworkEnv(), stderr: 'pipe', timeout: 30_000 })

  const stored = readWikiState().groomPr as { url?: unknown } | undefined | null
  if (stored !== undefined) {
    const u = stored !== null && typeof stored === 'object' ? stored.url : undefined
    if (typeof u !== 'string' || !PR_RE.test(u)) return wikiLog('wiki groom: stored PR is not valid, skipped')
    // REST with the owner in the path (src/prs.test.ts rule): the AX gateway needs it
    const v = gh([
      'api',
      '--hostname',
      r.host,
      `repos/${r.owner}/${r.repo}/pulls/${u.split('/').pop()}`,
      '--jq',
      '.state',
    ])
    const state = v.exitCode === 0 ? v.stdout.toString().trim() : ''
    if (state === 'open') return wikiLog(`wiki groom: skipped, PR ${u} open`)
    if (state !== 'closed') return wikiLog(`wiki groom: PR ${u} state unknown, skipped`)
    const { groomPr: _gone, ...rest } = readWikiState()
    writeWikiState(rest)
  }

  if (
    text(g('symbolic-ref', '-q', 'HEAD')) !== 'refs/heads/main' ||
    g('status', '--porcelain', '-z', '--untracked-files=all').out.length
  )
    return wikiLog('wiki groom: wiki checkout not clean or not on main, skipped')
  writeFileSync(join(HOME, 'wiki-groom.stamp'), '')
  const fetch = g('fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main')
  if (fetch.code !== 0) return wikiLog(`wiki groom: fetch failed (exit ${exit(fetch)})`)
  const branch = `groom/${new Date().toISOString().slice(0, 10)}`
  if (g('checkout', '-q', '-B', branch, 'refs/remotes/origin/main').code !== 0)
    return wikiLog('wiki groom: checkout failed')
  let ignoredBefore = new Set<string>()
  let keepFiles = false
  let configBad = false
  try {
    if (list('-o', '--exclude-standard').length) {
      keepFiles = true
      return wikiLog('wiki groom: untracked files on the groom branch, skipped')
    }
    ignoredBefore = new Set(list('-o', '-i', '--exclude-standard'))
    const p = plan()
    if (!p) return
    for (const a of p.actions) wikiLog(`wiki groom: plan ${a.op} ${a.paths.join(' ')}`)
    const before = wikiBlame(dir)
    if (!before) return
    const ap = groomAgent(
      dir,
      `${p.prompt}${GROOM_APPLY}${p.planText}\n`,
      'acceptEdits',
      'Read,Glob,Grep,Edit,Write',
      [],
    )
    const gk = gitDirKept(dir, before.git)
    if (gk !== 'same') return void gitChangedAct('wiki groom', gk, wikiRun(dir), before, wikiLog)
    if (!repoConfigOk(dir)) {
      configBad = true
      return wikiLog('wiki groom: repo config not allowed, nothing committed')
    }
    if (ap.code !== 0) return wikiLog(`wiki groom: apply call failed (exit ${exit(ap)}), nothing committed`)
    const kept = headKept(wikiRun(dir), before)
    if (kept !== 'same')
      return wikiLog(
        kept === 'moved'
          ? 'wiki groom: HEAD moved in the pass, nothing committed'
          : 'wiki groom: HEAD moved in the pass, restore failed, nothing committed',
      )

    const changedPaths = () => {
      if (g('add', '-A').code !== 0) return undefined
      const d = g('diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD')
      if (d.code !== 0) return undefined
      const files = d.out.toString().split('\0').filter(Boolean)
      for (const f of list('-o', '-i', '--exclude-standard')) if (!ignoredBefore.has(f)) files.push(f)
      return files
    }
    const changed = changedPaths()
    if (!changed) return wikiLog('wiki groom: git failed, nothing committed')
    for (const path of outsidePlan(changed, p.actions)) {
      if (g('cat-file', '-e', `HEAD:${path}`).code === 0)
        g('restore', '--staged', '--worktree', '--source=HEAD', '--', path)
      else {
        g('rm', '--cached', '-f', '-q', '--ignore-unmatch', '--', path)
        g('clean', '-f', '-f', '-x', '-q', '--', path)
      }
      wikiLog(
        WIKI_PAGE_PATH.test(path) && !path.split('/').includes('..') && !/\p{Cc}/u.test(path)
          ? `wiki groom: ${path} is not in the plan, reverted`
          : 'wiki groom: a path not in the plan, reverted',
      )
    }
    const after = changedPaths()
    if (!after) return wikiLog('wiki groom: git failed, nothing committed')
    if (outsidePlan(after, p.actions).length) return wikiLog('wiki groom: revert failed, nothing committed')

    if (!keepPersonLines(before, 'groom', dir)) return
    const c = commitWiki('groom', `${p.actions.length} actions`, dir)
    if (c === false) return
    if (c === null) return wikiLog('wiki groom: no change, no PR')
    if (!pushWiki(dir, branch)) return
    const body = p.planText
      .split('\n')
      .map(l => `    ${l}`)
      .join('\n')
    const make = gh([
      ...['pr', 'create', '--repo', slug, '--base', 'main', '--head', branch],
      ...['--title', `wiki groom: ${p.actions.length} actions`, '--body', body],
    ])
    let pr = make.exitCode === 0 ? make.stdout.toString().trim().split('\n').pop()! : ''
    if (!PR_RE.test(pr)) {
      const l = gh([
        'api',
        '--hostname',
        r.host,
        `repos/${r.owner}/${r.repo}/pulls?head=${r.owner}:${branch}&state=open`,
        '--jq',
        '.[0].html_url',
      ])
      pr = l.exitCode === 0 ? l.stdout.toString().trim() : ''
      if (!PR_RE.test(pr)) return wikiLog(`wiki groom: PR create failed (exit ${make.exitCode ?? 'timeout'})`)
    }
    writeWikiState({ ...readWikiState(), groomPr: { url: pr, branch, openedAt: new Date().toISOString() } })
    const done = `wiki groom: PR ${pr} with ${p.actions.length} actions`
    wikiLog(done)
    console.log(done)
  } finally {
    if (configBad) return
    let ok = true
    if (!keepFiles) {
      ok = g('reset', '-q', '--hard').code === 0
      for (const f of list('-o', '--exclude-standard', '--directory'))
        ok = g('clean', '-f', '-f', '-d', '-q', '--', f).code === 0 && ok
      for (const f of list('-o', '-i', '--exclude-standard'))
        if (!ignoredBefore.has(f)) ok = g('clean', '-f', '-f', '-d', '-x', '-q', '--', f).code === 0 && ok
    }
    ok = g('checkout', '-q', 'main').code === 0 && ok
    ok = g('branch', '-q', '-D', branch).code === 0 && ok
    if (!ok) wikiLog(`wiki groom: cleanup failed, checkout left on ${branch}`)
  }
}

/**
 * The pages that `wiki find` and `wiki status` can read, sorted by path. A page must meet all of these rules:
 * HEAD has it with mode 100644 or 100755, its path passes the path rule, it is a regular file with one link and
 * at most 65,536 bytes, and parse() accepts it. An agent pass controls the worktree.
 * A symlink or a hard link must not send an outside file to stdout.
 */
function wikiPages(dir: string) {
  const ls = wikiGit(dir, ['ls-tree', '-r', '-z', 'HEAD'])
  if (ls.code !== 0) return []
  const out: { path: string; page: Page }[] = []
  for (const e of ls.out.toString().split('\0')) {
    const tab = e.indexOf('\t')
    const path = e.slice(tab + 1)
    const mode = e.slice(0, e.indexOf(' '))
    if (tab < 0 || (mode !== '100644' && mode !== '100755')) continue
    if (!WIKI_PAGE_PATH.test(path) || path.split('/').includes('..')) continue
    try {
      const st = lstatSync(join(dir, path))
      if (!st.isFile() || st.nlink !== 1 || st.size > WIKI_PAGE_MAX) continue
      const p = parseWikiPage(readFileSync(join(dir, path), 'utf8'))
      if ('page' in p) out.push({ path, page: p.page })
    } catch {}
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** prints `path<TAB>title<TAB>host URL` for each matching page; the exit code is 1 when none match */
function wikiFind(q: string) {
  const dir = join(HOME, 'wiki')
  if (!existsSync(join(dir, '.git'))) {
    console.error('wiki: not set up: run factory wiki init')
    return 1
  }
  const url = wikiGit(dir, ['config', '--get', 'remote.origin.url']).out.toString().trim()
  const r = url ? wikiRemote(url) : null
  const hits = wikiPages(dir).filter(({ page }) => pageMatches(page, q))
  for (const { path, page } of hits)
    console.log(
      [
        path,
        page.title.replace(/\p{Cc}/gu, ' '),
        r ? `https://${r.host}/${r.owner}/${r.repo}/blob/main/${path}` : '',
      ].join('\t'),
    )
  return hits.length ? 0 : 1
}

/**
 * The JSON for `factory wiki status`. It only reads: no gh, no lock, no write. A missing or bad file gives null
 * or an empty list. `pending` lists the beads closed in the last 7 days that no page and no `written` key names.
 */
function wikiStatus() {
  const dir = join(HOME, 'wiki')
  const mtime = (name: string) => {
    try {
      return statSync(join(HOME, name)).mtime.toISOString()
    } catch {
      return null
    }
  }
  let state: Record<string, any> = {}
  try {
    state = JSON.parse(readFileSync(join(HOME, 'wiki-state.json'), 'utf8'))
  } catch {}
  if (state === null || typeof state !== 'object' || Array.isArray(state)) state = {}
  const done = new Set<string>()
  if (state.written && typeof state.written === 'object')
    for (const k of Object.keys(state.written)) done.add(k)
  for (const { page } of wikiPages(dir)) for (const b of page.beads ?? []) done.add(b)
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const pending: { rig: string; id: string }[] = []
  for (const r of rigs().filter(r => hasBeads(r.repo))) {
    try {
      for (const b of beads(r.repo, 'factory/wiki').closedSince(since))
        if (!done.has(b.id)) pending.push({ rig: r.name, id: b.id })
    } catch {
      console.error(`wiki status: rig ${r.name} bead list failed`)
    }
  }
  pending.sort((a, b) => (a.rig + a.id < b.rig + b.id ? -1 : 1))
  let flags: string[] = []
  try {
    const f = join(dir, 'needs-person.md')
    const st = lstatSync(f)
    if (st.isFile() && st.nlink === 1 && st.size <= WIKI_PAGE_MAX)
      flags = readFileSync(f, 'utf8')
        .split('\n')
        .filter(l => l.startsWith('- '))
        .map(l => l.replace(/\p{Cc}/gu, ' '))
  } catch {}
  const v = state.visibility?.value
  return {
    lastRefresh: mtime('wiki-refresh.stamp'),
    lastWrite: mtime('wiki-write.stamp'),
    lastGroom: mtime('wiki-groom.stamp'),
    groomPr: typeof state.groomPr?.url === 'string' ? state.groomPr : null,
    pending,
    flags,
    visibility: WIKI_VISIBLE.includes(v) ? v : null,
  }
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
        return bead?.status === 'closed' ? [closedLine(id, r.name, bead)] : []
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
/**
 * Make a private CODEX_HOME for the codex dream. It holds a trust line for the memory and a link to the
 * person's auth.json (one token store, as codexWorker does). The dream copies nothing else.
 */
function dreamCodexHome() {
  const dir = join(HOME, 'codex-dream')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  writeFileSync(join(dir, 'config.toml'), `[projects.${JSON.stringify(MEMORY)}]\ntrust_level = "trusted"\n`)
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  const link = join(dir, 'auth.json')
  rmSync(link, { force: true })
  if (existsSync(auth)) symlinkSync(auth, link)
  return dir
}

const DREAM_CODEX_NOTE =
  '\n\nYour sandbox keeps .git read-only, so git mv and git rm fail. Use mkdir, mv, rm and rm -r (not rm -f). The factory stages your changes with git add -A.'

/** the dream's own sessions (hr94): one name=dream row for each model in manager-usage.jsonl. Never throws */
function storeDreamUsage(start: number, codexHome?: string) {
  try {
    const rows = codexHome
      ? worker.codexHomeUsage(codexHome, start, 'dream', 0)
      : usageIn(MEMORY, '', () => '?', start)
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

const removedLine = (r: { path: string; target: string; skipped?: true }[]) =>
  `removed symlinks: ${r.map(l => (l.skipped ? l.path + ' (directory changed during the scan, not entered)' : l.path + ' -> ' + l.target)).join(', ')}\n`

async function dream() {
  const release = hold('dream.lock')
  if (!release) return 'a dream is already running'
  try {
    writeFileSync(join(HOME, 'dream.stamp'), '') // a failed dream waits for the next day too, rather than retrying every tick
    mkdirSync(MEMORY, { recursive: true })
    if (!existsSync(join(MEMORY, '.git'))) {
      memGit('init', '-q')
    }
    const start = Date.now()
    // kickDream runs with stdio ignored and the stamp is new, so a refusal must reach dream.log
    const refuse = (why: string) => {
      appendFileSync(join(HOME, 'dream.log'), `${new Date(start).toISOString()} refused\n${why}\n`)
      return why
    }
    // a nested .git (from a pass before this check shipped) would run its config at the next git call
    if (sweepNested(MEMORY, false)) return refuse(gitPreLine('dream', 'nested'))
    // git tracks .usage.jsonl itself, so counts survive a clone or a lost file (claude-factory-503.3).
    // Only its crash-safe temp file (memory.ts:584-601) and the search index cache stay ignored.
    const pre = memory.dropLinks(MEMORY)
    memory.writeStore(join(MEMORY, '.gitignore'), '.index.json*\n.usage.jsonl.tmp\n')
    const codexLinked = pre.some(l => l.path === '.codex') // a removed .codex link still refuses this dream
    if (pre.length) appendFileSync(join(HOME, 'dream.log'), removedLine(pre))
    if (!commitMemory('notes since the last dream')) return MEMORY_REFUSED
    // the journal since the last dream that finished: a failed one leaves its entries to the next
    const since = Number(memGit('log', '-1', '--grep=^dream:', '--format=%at')) * 1000
    const journal = journalSince(since)
    const manager = managerSince(since)
    if (!journal.length && !memory.inboxCount(MEMORY) && !manager.activity.length)
      return 'nothing new since the last dream'
    const memRun = wikiRun(MEMORY)
    const pair = headPair(memRun)
    if (!pair) return refuse('dream: no branch head, dream refused')
    const before = pair.sha
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
    // FACTORY_DREAM_CODEX=<model> runs the dream on codex in its workspace-write sandbox (y3zo)
    const model = process.env.FACTORY_DREAM_CODEX
    let codexHome: string | undefined
    if (model) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model))
        return refuse('FACTORY_DREAM_CODEX is not a model name')
      // the memory is trusted, so a .codex/config.toml in it can widen the sandbox at the next dream
      let hasCodexDir = true
      try {
        lstatSync(join(MEMORY, '.codex'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        hasCodexDir = false
      }
      if (hasCodexDir || codexLinked)
        return refuse('the memory holds .codex, which would add codex project config')
      codexHome = dreamCodexHome()
    }
    const gitPre = gitDirPre(MEMORY)
    if ('why' in gitPre) return refuse(gitPreLine('dream', gitPre.why))
    // claude: edits auto-accepted inside the memory only; -p has nobody to ask, so anything else is refused
    const p = codexHome
      ? Bun.spawnSync(
          [
            process.env.FACTORY_CODEX ?? 'codex',
            ...['exec', '-s', 'workspace-write', '-c', 'approval_policy="never"'],
            ...['-c', 'sandbox_workspace_write.network_access=false'],
            ...['-c', 'sandbox_workspace_write.exclude_slash_tmp=true'],
            ...['-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'],
            ...['-C', MEMORY, '-m', model!, '-'],
          ],
          {
            cwd: MEMORY,
            // 6w0m: the codex sandbox can run printenv, so pass an allowlist, not the tick env.
            // Add a key only when the live dream fails without it.
            env: {
              ...Object.fromEntries(
                ['PATH', 'HOME', 'TERM', 'LANG'].flatMap(k =>
                  process.env[k] === undefined ? [] : [[k, process.env[k]!]],
                ),
              ),
              CODEX_HOME: codexHome,
            },
            stdin: Buffer.from(prompt + DREAM_CODEX_NOTE),
            timeout: 45 * 60_000,
          },
        )
      : Bun.spawnSync(
          [
            ...claudeCommand().split(/\s+/),
            ...['-p', '--permission-mode', 'acceptEdits'],
            ...['--settings', JSON.stringify(passSettings())],
            ...['--allowedTools', 'Bash(mkdir:*)', 'Bash(git mv:*)', 'Bash(git rm:*)'],
          ],
          { cwd: MEMORY, stdin: Buffer.from(prompt), timeout: 45 * 60_000 },
        )
    const gk = gitDirKept(MEMORY, gitPre.snap) // before dropLinks: it removes a symlinked sub/.git
    const removed = memory.dropLinks(MEMORY)
    const said = p.stdout.toString().trim() || `the dream exited ${p.exitCode}: ${p.stderr.toString().trim()}`
    // dream.log keeps history: a log past 256 KB moves to dream.log.1 (one old file, replaced each time)
    const dreamLog = join(HOME, 'dream.log')
    if (existsSync(dreamLog) && statSync(dreamLog).size > 256 * 1024) renameSync(dreamLog, `${dreamLog}.1`)
    appendFileSync(dreamLog, `${new Date(start).toISOString()} exit ${p.exitCode}\n${said}\n`)
    if (removed.length) appendFileSync(dreamLog, removedLine(removed))
    storeDreamUsage(start, codexHome)
    // FR-018: at most PROPOSAL_CAP (3) new proposals per dream, whatever the dream wrote
    const overProposals = memory.proposalsOverCap(
      proposalsBefore.map(p => p.name),
      memory.proposals(MEMORY).map(p => p.name),
    )
    for (const name of overProposals) rmSync(join(memory.proposalsDir(MEMORY), `${name}.md`))
    if (overProposals.length)
      appendFileSync(join(HOME, 'dream.log'), `dropped proposals over the cap: ${overProposals.join(', ')}\n`)
    // a pass that moved HEAD commits nothing: its edits stay in the worktree for the next dream's notes commit
    if (gk !== 'same')
      return gitChangedAct('dream', gk, memRun, pair, l => appendFileSync(dreamLog, `${l}\n`))
    const kept = headKept(memRun, pair)
    if (kept !== 'same') {
      const line =
        kept === 'moved'
          ? 'dream: HEAD moved in the pass, nothing committed'
          : 'dream: HEAD moved in the pass, restore failed, nothing committed'
      appendFileSync(dreamLog, `${line}\n`)
      return line
    }
    if (!repoConfigOk(MEMORY)) return (memoryRefused(), MEMORY_REFUSED)
    if (p.exitCode !== 0) return said
    memGit('add', '-A')
    // a filed or renamed note keeps its counts. An entry a dream merged by hand keeps its usage too,
    // through the alias it left on the entry that absorbed it (claude-factory-59r.11).
    // Read from the staged index (--cached), not HEAD. compact() runs below, before the commit.
    // git add -A then restages its writes, so they land inside the commit and the repo stays clean
    // right after it (claude-factory-503.3).
    const renamed: Record<string, string> = {
      ...Object.fromEntries(
        memGit('diff', '-M', '--name-status', '--cached', before)
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
    memGit('add', '-A')
    // committed even when it changed nothing, and dated when it began: what was journaled meanwhile is the next one's
    memGit('commit', '-q', '--allow-empty', `--date=@${Math.floor(start / 1000)}`, '-m', `dream: ${said}`)
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
      memGit('add', '-A')
      // its own commit, dated with the dream it followed, even when it merged and archived nothing
      memGit(
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
    let cfg: devenv.DevenvConfig
    try {
      cfg = readJson<devenv.DevenvConfig>(devenvConfig())
    } catch (e) {
      throw new Error(`${devenvConfig()}: not valid JSON (${hideParseText((e as Error).message)})`)
    }
    const miss = devenv.configMissing(cfg)
    if (miss.length)
      return [`${devenvConfig()} lacks ${miss.join(', ')}: run factory settings set devenv.<field> <value>`]
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
  if (process.env.FACTORY_SELF_UPDATE === '0' || inStore(ROOT)) return // a store install updates with its flake
  const stamp = join(HOME, 'self-update.stamp')
  const lastAt = existsSync(stamp) ? statSync(stamp).mtimeMs : undefined
  if (isHeld('tick.lock') || !selfupdate.isDue(lastAt, Date.now(), SELF_UPDATE_MS)) return
  writeFileSync(stamp, '')
  spawnChild(CLI, ['self-update'], {
    detached: true,
    stdio: 'ignore',
    env: kickEnv(process.env, HOME),
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
  return tokenTable(withMerges(records().filter(r => r.createdAt >= since)), false, since)
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
[ -d memory/.git ] || exit 0
keys=$(GIT_CEILING_DIRECTORIES="$PWD" git -C memory config --local --name-only --list) && ! printf '%s\\n' "$keys" | LC_ALL=C grep -Evq '${REPO_CONFIG_KEY.source}' || { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) memory: repo config not allowed, push refused" >> dream.log; exit 0; }
GIT_CEILING_DIRECTORIES="$PWD" timeout 120 git -C memory -c core.hooksPath=/dev/null -c core.fsmonitor=false push -q "$(git remote get-url origin)" HEAD:refs/heads/memory`

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
  const isOurs = pane?.cwd && (factoryAt(pane.cwd) ?? DEFAULT_HOME) === HOME
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
  const { run, value, c } = current(id)
  if (run.id !== id) throw new Error('run.json names run "' + run.id + '", not "' + id + '"')
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
 * Removes one done or aborted run, for `factory rm` and for the gc reap pass. It removes the worktree first.
 * It then appends the run's record to metrics.jsonl and deletes the run directory last. The branch stays.
 * A step that throws stops the next one, so the run directory stays. It throws when the run is not finished,
 * or when git refuses the worktree because it holds work.
 */
function removeRun(id: string): Run {
  const { run, value } = current(id)
  if (run.id !== id) fail(id + ': run.json names run "' + run.id + '": removed nothing')
  if (!['done', 'aborted'].includes(where(value)[0])) fail(`${run.id} is still running: abort it first`)
  for (const k of ['id', 'worktree', 'repo'] as const) {
    const v: unknown = run[k]
    if (typeof v !== 'string' || v === '') fail(`${id}: run.json has no ${k}: removed nothing`)
  }
  // no --force except for a clean submodule worktree: herdr and git refuse uncommitted work; the branch always stays.
  // A reaped workspace is gone (and its id may be another's now): git removes the worktree then
  const lock = () => rmSync(join(run.worktree, '.beads.gate.lock'), { force: true })
  if (herdrPanes().some(p => isIn(p, run))) {
    makeWritable(run.worktree)
    lock() // bd leaves its lock in every worktree it ran in: not work, and it would make the worktree look dirty
    herdr('worktree', 'remove', '--workspace', run.ws)
  } else if (existsSync(run.worktree)) {
    const reg = registeredWorktrees(run.repo)
    if (reg && isRegistered(reg, run.worktree)) {
      makeWritable(run.worktree)
      lock()
      // git refuses a worktree with a submodule: force only when it and each submodule hold nothing to lose
      const force =
        submoduleState(run.worktree) === 'clean' &&
        git(run.worktree, 'status', '--porcelain', '--ignore-submodules=none') === ''
      git(run.repo, 'worktree', 'remove', ...(force ? ['--force'] : []), run.worktree)
    } else rmUnregisteredWorktree(run.worktree, run.id, run.repo) // git unregistered it, a read-only dir kept the rest
  }
  // its record outlives it: metrics count removed runs too
  appendFileSync(join(HOME, 'metrics.jsonl'), JSON.stringify(record(run.id)) + '\n')
  rmSafe(runDir(run.id), { recursive: true })
  return run
}
/**
 * Reaps every done or aborted run older than `days` with removeRun(). It also removes a dead launch script.
 * It follows the rules in gc.gcPlan(). If removeRun() throws, the run directory stays. Earlier steps can remove
 * the worktree. gc.log and the caller output name the refusal. The pass continues with the next run.
 *
 * `--dry-run` prints the runs it would reap. It deletes nothing (claude-factory-503.1, claude-factory-lt4u).
 */
function gcPass(days: number, dryRun: boolean, print: Print, error: Print) {
  const now = Date.now()
  // a run dir removed mid-pass, or one with no run.json/state.json, must not fail the whole pass
  // (claude-factory-503.1.6)
  const skipped: string[] = []
  const runs = runIds().flatMap(id => {
    try {
      return [runFact(id)]
    } catch (err) {
      error(`gc: skipping ${id}: ${(err as Error).message}`)
      skipped.push(`skipped ${id}: ${gc.scrubUrlUserinfo((err as Error).message)}`)
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
  print(
    [
      `prompts: ${plan.totals.prompts.files} files, ${fmtBytes(plan.totals.prompts.bytes)}`,
      `briefs: ${plan.totals.briefs.files} files, ${fmtBytes(plan.totals.briefs.bytes)}`,
      `backups: ${plan.totals.backups.files} files, ${fmtBytes(plan.totals.backups.bytes)}`,
      `launch: ${plan.totals.launch.files} files, ${fmtBytes(plan.totals.launch.bytes)}`,
      `total: ${totalFiles} files, ${fmtBytes(totalBytes)} across ${plan.totals.runs} run(s)`,
      ...(livePanes === null ? ['herdr pane list did not answer: removed no launch script'] : []),
    ].join('\n'),
  )
  if (dryRun) {
    for (const id of plan.reap) print(`would reap ${id}`)
    return
  }
  // ponytail: gc.log grows by one line per reaped run and is never rotated; rotate it when it matters
  // a gc.log write error must not change a removal result or stop the pass
  const say = (line: string) => {
    print(line)
    try {
      appendFileSync(join(HOME, 'gc.log'), `${new Date(now).toISOString()} ${line}\n`)
    } catch (err) {
      error(`gc: cannot write gc.log: ${(err as Error).message}`)
    }
  }
  for (const line of skipped) say(line)
  for (const id of plan.reap) {
    let line: string
    try {
      removeRun(id)
      line = `reaped ${id}`
    } catch (err) {
      line = `refused ${id}: ${gc.scrubUrlUserinfo((err as Error).message)}`
    }
    say(line)
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
    env: kickEnv(process.env, HOME),
  }).unref()
}

/**
 * `factory wiki <pass>` at most every FACTORY_WIKI_<PASS>_MIN minutes (a positive number, else `defMin`).
 * It does nothing while $HOME/wiki/.git is missing or wiki.lock is held. It writes the stamp before the spawn,
 * so a slow pass gets no second one. True only when it spawned.
 */
const kickWiki = (pass: 'refresh' | 'groom', defMin: number) => {
  if (!existsSync(join(HOME, 'wiki', '.git')) || isHeld('wiki.lock')) return false
  const min = Number(process.env[`FACTORY_WIKI_${pass.toUpperCase()}_MIN`])
  const stamp = join(HOME, `wiki-${pass}.stamp`)
  const age = existsSync(stamp) ? Date.now() - statSync(stamp).mtimeMs : Infinity
  if (age < (min > 0 ? min : defMin) * 60_000) return false
  writeFileSync(stamp, '')
  spawnChild(CLI, ['wiki', pass], {
    detached: true,
    stdio: 'ignore',
    env: kickEnv(process.env, HOME),
  }).unref()
  return true
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
  return worktreeList(repo) ?? []
}
/** the entries of `worktreeEntries`, or null when `git worktree list` fails */
function worktreeList(repo: string): WtEntry[] | null {
  const p = Bun.spawnSync(['git', '-C', repo, 'worktree', 'list', '--porcelain'])
  if (p.exitCode !== 0) return null
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
/** `chmod -R u+w` on a worktree dir, so that a later delete does not stop on a read-only dir (envtest
 * binaries, the Go module cache). argv only, no shell. It ignores a symlink or a missing path, and
 * `chmod -R` does not follow symlinks inside the tree. The exit code is moot: the delete shows the real error. */
function makeWritable(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return
  Bun.spawnSync(['chmod', '-R', 'u+w', '--', path])
}

/** the registered worktree paths of a repo (raw and real), or null when `git worktree list` fails.
 * Not `worktreeEntries`: its [] on failure would make every dir look unregistered. */
function registeredWorktrees(repo: string): Set<string> | null {
  const list = worktreeList(repo)
  if (!list) return null
  const set = new Set<string>()
  for (const e of list) {
    set.add(e.path)
    try {
      set.add(realpathSync(e.path))
    } catch {
      // gone already: the raw path is enough
    }
  }
  return set
}
function isRegistered(reg: Set<string>, path: string): boolean {
  if (reg.has(path)) return true
  try {
    return reg.has(realpathSync(path))
  } catch {
    return false
  }
}

/** the dirs where the factory makes worktrees: herdr's layout (laptop) and the AX task layout */
const WORKTREE_ROOTS = () => [join(homedir(), '.herdr', 'worktrees'), join(HOME, 'worktrees')]
const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)

/**
 * Why `rmUnregisteredWorktree` must not delete `path` (a string), or the checked real path when it may. One fail-closed rule: the
 * path is a real dir (no symlink) below a factory worktree root, named after the run, not the repo,
 * not listed by git, and with no live git dir behind its `.git` file.
 */
function unregisteredRefusal(path: string, runId: string, repo: string): string | { real: string } {
  const st = lstatSync(path, { throwIfNoEntry: false })
  if (!st) return 'missing'
  if (st.isSymbolicLink()) return 'symlink'
  if (!st.isDirectory()) return 'not a directory'
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return 'outside the worktree roots'
  }
  const inRoot = WORKTREE_ROOTS().some(root => {
    try {
      const rel = relative(realpathSync(root), real)
      return rel !== '' && !escapes(rel)
    } catch {
      return false
    }
  })
  if (!inRoot) return 'outside the worktree roots'
  if (basename(real) !== runId && basename(real) !== `factory-${runId}`) return 'name does not match the run'
  try {
    if (!escapes(relative(real, realpathSync(repo)))) return 'the repo itself'
  } catch {
    // repo unreadable: it cannot be the dir
  }
  const reg = registeredWorktrees(repo)
  if (!reg) return 'git worktree list failed'
  if (isRegistered(reg, path) || reg.has(real)) return 'git still lists it'
  const dotGit = join(real, '.git')
  const gst = lstatSync(dotGit, { throwIfNoEntry: false })
  if (gst) {
    let dead = false
    try {
      const first = gst.isFile() ? readFileSync(dotGit, 'utf8').split('\n')[0]! : ''
      dead = first.startsWith('gitdir: ') && !existsSync(resolve(real, first.slice('gitdir: '.length)))
    } catch {
      // unreadable: not a dead link
    }
    if (!dead) return 'its git dir still exists'
  }
  return { real }
}
/** deletes a dir that git no longer lists (a `git worktree remove` that stopped halfway) */
function rmUnregisteredWorktree(path: string, runId: string, repo: string): void {
  const why = unregisteredRefusal(path, runId, repo)
  if (typeof why === 'string') throw new Error(`refusing to delete ${path}: ${why}`)
  const { real } = why
  makeWritable(real)
  rmSafe(real, { recursive: true, force: true })
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
    return [{ path: e.path, branch: e.branch, locked: e.locked, dirty, bytes: duBytes(e.path) }]
  })
}
function duBytes(path: string): number {
  const du = Bun.spawnSync(['du', '-sk', path])
  const kb = du.exitCode === 0 ? Number(du.stdout.toString().split('\t')[0]) : 0
  return Number.isFinite(kb) ? kb * 1024 : 0
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
      env: gitNetworkEnv(),
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
    { env: gitNetworkEnv(), timeout: GIT_NETWORK_TIMEOUT_MS },
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
/** `gh api repos/<owner>/<repo>/pulls`, one call per page, once per rig, not once per branch. The plan for
 * claude-factory-l38 rejected the per-branch call: it would run about 700 calls on the first
 * pass. This function returns null on a non-GitHub forge, or on any `gh` failure (AC5).
 *
 * `gh pr list --limit 1000` (claude-factory-l38.13) capped a rig's pull requests at 1000. A rig
 * with more PRs than that always read as incomplete (claude-factory-ph8: a rig with over 3000
 * pull requests is a real case). The page loop has no cap, and a failed page gives null.
 * GraphQL gave no owner in the path, so the AX gateway sent the default key (claude-factory-oz6s).
 * `--jq tojson` prints one JSON line per call. `gc.parsePrPages()` returns null, never a partial list,
 * on any unknown form. Ascending creation order means a PR opened during the read only adds at the end. */
function prFacts(repo: string): gc.PrFact[] | null {
  const url = originConfigUrl(repo)
  const slug = url ? githubSlug(url) : null
  if (!slug) return null
  // One call per page, not `--paginate`: gh follows the Link URL /repositories/<id>/pulls, which has no
  // owner in the path, so the AX gateway sends the default key for pages 2 and later (claude-factory-oz6s).
  const pages: string[] = []
  for (let page = 1; ; page++) {
    const p = Bun.spawnSync(
      [
        'gh',
        'api',
        `repos/${slug}/pulls?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
        '--jq',
        'tojson',
      ],
      { cwd: repo, timeout: 300_000 },
    )
    if (p.exitCode !== 0) return null
    const text = p.stdout.toString().trim()
    pages.push(text)
    // a short page is the last one; each call prints one JSON array on one line
    let n: unknown
    try {
      n = JSON.parse(text)
    } catch {
      return null
    }
    if (!Array.isArray(n)) return null
    if (n.length < 100) break
  }
  return gc.parsePrPages(pages.join('\n'))
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
      if (run.id !== id) throw new Error('run.json id differs from its directory')
      const finishedAt = c.log.at(-1)?.at ?? createdAt(id)
      return { id, node: where(value)[0], finishedAt, worktree: run.worktree, bead: run.bead, repo: run.repo }
    } catch {
      // an unloadable run (a corrupt run.json or state.json) must count as live (claude-factory-l38.10):
      // dropping it let ownerByBranch() give its longer-id fork's branch to a shorter, finished parent
      return { id, node: 'unknown', finishedAt: 0, worktree: '', bead: undefined, repo: '' }
    }
  })
}

/** What a forced `git worktree remove` would lose in submodules (claude-factory-m9f9). `none`: no
 * submodule gitdir under the worktree's admin dir. `clean`: every submodule has no uncommitted work
 * and no commit that a remote-tracking ref misses. `dirty`: otherwise, and on any read error. */
function submoduleState(wt: string): 'none' | 'clean' | 'dirty' {
  const run = (...a: string[]) => Bun.spawnSync(['git', ...a], { env: process.env })
  const unpushed = ['rev-list', '-n', '1', '--all', '--not', '--remotes']
  try {
    const each = run(
      '-C',
      wt,
      'submodule',
      'foreach',
      '--recursive',
      '--quiet',
      'git status --porcelain --ignore-submodules=none && git rev-list -n 1 --all --not --remotes',
    )
    if (each.exitCode !== 0 || each.stdout.toString().trim() !== '') return 'dirty'
    const m = run('-C', wt, 'rev-parse', '--path-format=absolute', '--git-path', 'modules')
    if (m.exitCode !== 0) return 'dirty'
    const modules = m.stdout.toString().trim()
    if (!existsSync(modules)) return 'none'
    let found = false
    // a gitdir has HEAD and objects: look only into its modules/ child. Look into each child dir of any other dir.
    const walk = (d: string): boolean => {
      if (!lstatSync(d).isDirectory()) return false
      if (existsSync(join(d, 'HEAD')) && existsSync(join(d, 'objects'))) {
        found = true
        const r = run(`--git-dir=${d}`, ...unpushed)
        if (r.exitCode !== 0 || r.stdout.toString().trim() !== '') return false
        const nested = join(d, 'modules')
        return !existsSync(nested) || walk(nested)
      }
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isSymbolicLink()) return false
        if (e.isDirectory() && !walk(join(d, e.name))) return false
      }
      return true
    }
    return walk(modules) ? (found ? 'clean' : 'none') : 'dirty'
  } catch {
    return 'dirty'
  }
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
    rmQuiet(indexDir, { recursive: true, force: true })
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
      { env: gitNetworkEnv(), timeout: GIT_NETWORK_TIMEOUT_MS },
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
function gcWorktreesPass(dryRun: boolean, rigName: string | undefined, print: Print) {
  const now = Date.now()
  const allRigs = rigs()
  const targetRigs = allRigs.filter(r => !rigName || r.name === rigName)
  const runs = allRunRefs()
  const panes = strictPaneCwds()
  const facts: gc.RigWorktreeFacts[] = targetRigs.map(rig => {
    const worktrees = worktreeFacts(rig.repo)
    // a dir a run owns that git no longer lists: a failed list gives no such fact (fail closed)
    const reg = registeredWorktrees(rig.repo)
    for (const r of reg ? runs.filter(r => r.repo === rig.repo && r.worktree !== '') : []) {
      if (!existsSync(r.worktree) || isRegistered(reg!, r.worktree)) continue
      const why = unregisteredRefusal(r.worktree, r.id, rig.repo)
      if (typeof why === 'string')
        print(`keep worktree ${r.worktree} (run ${r.id}, reason: unregistered, ${why})`)
      else
        worktrees.push({
          path: r.worktree,
          branch: null,
          locked: false,
          dirty: 'clean',
          bytes: duBytes(r.worktree),
          unregistered: true,
        })
    }
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
      print(
        `remove worktree ${w.path} (run ${w.runId}${w.unregistered ? ', unregistered' : ''}${w.snapshot ? ', dirty: snapshot first' : ''}, ${fmtBytes(w.bytes)})`,
      )
    for (const b of p.removeBranches)
      print(
        `remove branch ${b.name} (run ${b.runId}, local ${b.local?.slice(0, 8) ?? '-'}, remote ${b.remote?.slice(0, 8) ?? '-'})`,
      )
    for (const k of p.keep)
      print(`keep ${k.kind} ${k.name} (run ${k.runId ?? 'unowned'}, reason: ${k.reason})`)
    print(`${p.rig}: owned ${p.owned}, live ${p.live}, unowned ${p.unowned}`)
    if (dryRun) continue
    const repo = byRigRepo.get(p.rig)!
    // a worktree whose `git worktree remove` fails keeps its branch too (claude-factory-l38.6):
    // `update-ref -d` does not check whether a worktree still has the branch checked out
    const failedWorktrees = new Set<string>()
    for (const w of p.removeWorktrees) {
      try {
        let snapshot: string | undefined
        if (w.unregistered) rmUnregisteredWorktree(w.path, w.runId, repo)
        else {
          rmSync(join(w.path, '.beads.gate.lock'), { force: true })
          // --force deletes submodule gitdirs: only when no submodule holds uncommitted or unpushed work
          const subs = submoduleState(w.path)
          if (subs === 'dirty')
            throw new Error('a submodule has uncommitted work or commits on no remote: kept')
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
          makeWritable(w.path)
          const rm = Bun.spawnSync([
            'git',
            '-C',
            repo,
            'worktree',
            'remove',
            ...(w.snapshot || subs === 'clean' ? ['--force'] : []),
            w.path,
          ])
          if (rm.exitCode !== 0) throw new Error(`git worktree remove: ${rm.stderr.toString().trim()}`)
        }
        gcLog({
          type: 'worktree',
          rig: p.rig,
          run: w.runId,
          path: w.path,
          bytes: w.bytes,
          ...(w.unregistered && { unregistered: true }),
        })
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
  print(
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
    env: kickEnv(process.env, HOME),
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
    env: kickEnv(process.env, HOME),
  }).unref()
}

async function tick(isPatrol = false) {
  // d289.21: the AX manager host waits to back up the home; it takes the lock next, then removes backup.want
  if (backupWanted(HOME)) return { busy: true }
  const release = hold('tick.lock')
  if (!release) return { busy: true }
  try {
    const now = Date.now()
    await refreshCursorMeter(HOME, process.env, now)
    const linearState = existsSync(linearSyncFile())
      ? readJson<Record<string, LinearSyncState>>(linearSyncFile())
      : {}
    pruneReviews()
    const out = {
      runs: [] as Row[],
      manager: [] as (Mail & { run: string })[],
      // set while the manager's Claude is refused and every account is drained (claude-factory-y3f8w.3)
      managerLimited: managerLimited() ?? null,
      // set while a codex step of the manager gets an auth error (claude-factory-y3f8w.10)
      managerCodexAuth: managerCodexAuthState(HOME),
      // the manager's patrol works toward their goals; each opted-in rig carries its last Linear pull
      rigs: rigs().map(r => (linearState[r.name] ? { ...r, linearSync: linearState[r.name] } : r)),
      // each pending skill and proposal with no verdict yet, for the mod's reviewer (claude-factory-ag2)
      reviews: memory.pendingReviews(MEMORY, readReviews()).map(({ text: _text, ...r }) => r),
      // the pending ones that have one: the patrol shows each verdict until the manager acts
      reviewed: reviewedItems(),
    }
    const halt = halted()
    try {
      out.manager.push(...(await unholdPass(now)))
    } catch (e) {
      // the marks stay, so the next tick tries again; the run loop must go on
      console.error(`unhold: ${e instanceof Error ? e.message : String(e)}`)
    }
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
    out.manager.push(...codexAuthMail(now, HOME))
    out.manager.push(...tokenDigestMail(now))
    // skip rows are for people reading dispatch.json; the board, sidebar and reap() see only the rest
    out.runs.push(...(existsSync(dispatchFile()) ? readJson<Row[]>(dispatchFile()).filter(r => !r.skip) : []))
    out.runs.push(
      ...(existsSync(join(HOME, 'labels.json')) ? readJson<Row[]>(join(HOME, 'labels.json')) : []),
    )
    out.runs.push(
      ...(existsSync(join(HOME, 'orphans.json')) ? readJson<Row[]>(join(HOME, 'orphans.json')) : []),
    )
    out.runs.push(
      ...(existsSync(join(HOME, 'ax-sweep.json')) ? readJson<Row[]>(join(HOME, 'ax-sweep.json')) : []),
    )
    showInSidebar(out.runs, now, isPatrol)
    reap(out.runs)
    // stopped once no worker is still being told to stop: everything that was working has closed
    if (halt?.state === 'stopping' && !out.runs.some(r => r.agent === 'stopping'))
      writeJson(haltFile(), { ...halted()!, state: 'paused' })
    return { ...out, halt: halted()?.state }
  } finally {
    release()
    // FACTORY_NO_KICK=1 (tests): a detached pass would recreate a removed home
    if (process.env.FACTORY_NO_KICK !== '1' && (rigs().length || runIds().length)) {
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
      // one wiki pass in each tick, so refresh and groom never race for wiki.lock; a halt gets refresh only
      if (!kickWiki('refresh', 30) && !halted()) kickWiki('groom', 24 * 60)
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
  recheck?: boolean
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
function readSlo(rig: Rig, cmd = rig.slo!): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd: rig.repo, timeout: 30_000 })
  return (p.stdout.toString() + p.stderr.toString()).trim()
}

const BRANCH_OK = /^[\w][\w./-]*$/
/** a plain branch name: it is safe in a prompt and in git argv */
export const branchOk = (b: string) => BRANCH_OK.test(b) && !b.includes('..')

/** the branch a run merges against: the rig's base_branch param when it is a plain name, else the default branch */
export function baseBranchOf(
  def: Pick<Factory, 'params'>,
  rig: Pick<Rig, 'params'> | undefined,
  repo: string,
) {
  const b = paramsOf(def, rig).base_branch?.trim() ?? ''
  return b && branchOk(b) ? b : defaultBranch(repo)
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
    env: gitNetworkEnv(),
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

/**
 * The paths the branch changes against `base`, from origin. It gives null when the fetch or the diff fails,
 * so the security route fails closed. `-z` and core.quotePath=false keep a non-ASCII path whole, and
 * --no-renames lists both names of a rename.
 */
export function changedPaths(repo: string, base: string, branch: string): string[] | null {
  const ref = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`
  const fetch = Bun.spawnSync(['git', '-C', repo, 'fetch', '-q', 'origin', ref(base), ref(branch)], {
    env: gitNetworkEnv(),
    timeout: GIT_NETWORK_TIMEOUT_MS,
  })
  if (fetch.exitCode !== 0) return null
  const p = Bun.spawnSync([
    'git',
    '-c',
    'core.quotePath=false',
    '-C',
    repo,
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    `origin/${base}...origin/${branch}`,
  ])
  if (p.exitCode !== 0) return null
  return p.stdout
    .toString()
    .split('\0')
    .filter(x => x)
}

const routeFile = (run: Run) => join(runDir(run.id), 'security-route.json')

/** The runner's security route for this run: changed paths, the rig's sensitivePaths, the plan's line and the bead's labels. */
function securityRouteOf(run: Run, def: Factory, c: Ctx): SecurityRoute {
  let labels: string[] | null = []
  const ref = run.shipBranch ?? run.branch
  if (run.bead) {
    try {
      const bead = beads(run.repo, actorOf(run.id)).lookup(run.bead)
      if (bead) {
        labels = bead.labels ?? []
      } else labels = null
    } catch {
      labels = null
    }
  }
  const plan = c.log.findLast(e => e.node === 'plan' && e.outcome === 'ready')?.summary
  const rig = rigOf(run.repo)
  return securityRoute({
    paths: changedPaths(run.repo, baseBranchOf(def, rig, run.repo), ref),
    plan,
    labels,
    rigPaths: rigPaths(rig?.sensitivePaths),
  })
}

/** The route file of this attempt, or the fail-closed route when it is missing, malformed or old. */
function savedRoute(run: Run, c: Ctx): SecurityRoute {
  const closed = { required: true, why: ['route not recorded'] }
  try {
    const j = JSON.parse(readFileSync(routeFile(run), 'utf8'))
    const r = j?.route
    return j?.seq === c.seq &&
      typeof r?.required === 'boolean' &&
      Array.isArray(r.why) &&
      r.why.every((w: unknown) => typeof w === 'string')
      ? { required: r.required, why: r.why }
      : closed
  } catch {
    return closed
  }
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

/** the labels of the open and the closed beads in `repo`, for the ci-red and flake dedupe; a bd failure throws */
const beadLabels = (repo: string): { open: Set<string>; closed: Set<string> } => {
  const all = beads(repo, 'factory').every()
  const of = (closed: boolean) =>
    new Set(all.filter(b => (b.status === 'closed') === closed).flatMap(b => b.labels ?? []))
  return { open: of(false), closed: of(true) }
}

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
    const { open, closed } = beadLabels(rig.repo)
    const fresh = newCiReds(reds, open, closed)
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
  const labels = beadLabels(rig.repo).open
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
    // (a worker cannot run `factory start` since claude-factory-5y7b, so only the manager or a person starts
    // work with no bead, and no guard). Today every rig in rigs.json has .beads, so this is latent, not live. Skip it, one
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
      let read: { sig?: string; lines?: number; read?: string } | undefined
      // drift reads on every due pass, with no unchanged skip: a resource that stays broken must be
      // checked again each hour. The mail holds this read and the last one, so the model can tell a
      // stuck resource (in both) from a new one.
      if (station === 'drift') {
        let output: string
        try {
          output = readSlo(rig, rig.drift!)
        } catch (err) {
          logSweep({ at, rig: rig.name, sweep: station, action: 'error' })
          console.error(
            `${new Date().toISOString()} sweep drift for rig ${rig.name}: ${(err as Error).message}`,
          )
          continue
        }
        const before = state[rig.name]?.[station]
        const now = clipUtf8(output)
        read = { read: now }
        mail =
          `current read:\n${now}\n\nprevious read` +
          (before?.read !== undefined
            ? ` (${new Date(before.lastAt).toISOString()}):\n${clipUtf8(before.read)}`
            : ': none, this is the first pass')
      }
      let recheck = false
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
        const prev = state[rig.name]?.[station]
        // ranAt is the time of the last run start. Old state has none, so lastAt stands in once.
        const ranAt = prev?.ranAt ?? prev?.lastAt
        if (read.sig === prev?.sig) {
          if (ranAt !== undefined && at - ranAt < MONITOR_RECHECK_MIN * 60_000) {
            state = {
              ...state,
              [rig.name]: { ...state[rig.name], [station]: { lastAt: at, ...read, ranAt } },
            }
            writeJson(sweepStateFile(), state)
            logSweep({ at, rig: rig.name, sweep: station, action: 'unchanged' })
            continue
          }
          recheck = true
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
        state = {
          ...state,
          [rig.name]: {
            ...state[rig.name],
            [station]: { lastAt: at, ...read, ...(station === 'monitor' ? { ranAt: at } : {}) },
          },
        }
        writeJson(sweepStateFile(), state)
        logSweep({
          at,
          rig: rig.name,
          sweep: station,
          action: 'started',
          run: run.id,
          ...(recheck ? { recheck: true } : {}),
        })
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
  let said = ''
  for (;;) {
    const other = localLease({
      holder: `loop:${process.pid}`,
      kind: 'loop',
      pid: process.pid,
      at: Date.now(),
    })
    const line = other ? leases.leaseLine(other, Date.now()) : ''
    // a loop without the lease waits and says so once, until the holder changes
    if (line && line.split(' ')[0] !== said) console.error(`factory loop: no tick: ${line}`)
    said = line.split(' ')[0] ?? ''
    if (!other) await tick()
    await Bun.sleep(intervalMs)
  }
}

/**
 * a run is a branch + worktree (herdr's, or plain git for an AX rig) + snapshot + the factory it follows, pinned so that no later edit,
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
    shipBranch,
  }: {
    id: string
    bead?: string
    from?: { run: Run; saved: Saved }
    ship?: true
    onto?: string
    shipBranch?: string
  },
) {
  const branch = `factory/${id}`
  const base = from?.run.base ?? freshBase(repo)
  const startPoint = from?.run.branch ?? onto ?? base
  // an AX rig needs no herdr: a plain git worktree at herdr's own layout, so `herdr worktree open` finds it later
  const isAx = rigOf(repo)?.runner === 'ax'
  // claude-factory-1d9l: a run on a PR branch loads the factory the default branch holds, never the branch's own
  const checkout = onto && !from ? factoryDirAt(repo, base) : undefined
  let ws = ''
  let worktree = join(homedir(), '.herdr', 'worktrees', basename(repo), `factory-${id}`)
  let source = ''
  let def: Factory
  // pinned resolved, as data: a base it extends may change after the run starts
  const pinned = join(runDir(id), 'factory.json')
  try {
    if (isAx) git(repo, 'worktree', 'add', '-b', branch, worktree, startPoint)
    else {
      const created = herdr(
        ...['worktree', 'create', '--cwd', repo, '--branch', branch, '--base', startPoint],
        ...['--label', `${basename(repo)}/${id}`, '--no-focus', '--json'],
      )
      ws = created.workspace.workspace_id
      worktree = created.worktree.path
    }
    worker.excludeScratch(worktree) // claude-factory-9wu: .scratch/ stays untracked, with no commit, in this repo
    source = from ? from.run.factory : factorySource(spec, checkout ?? worktree)
    mkdirSync(join(runDir(id), 'prompts'), { recursive: true })
    try {
      def = await (from ? loadPinned : loadFactory)(source)
      // a ship edge queues the bead in bd: a repo with no beads has nowhere to queue it
      if (hasShipEdge(def) && !hasBeads(repo))
        throw new Error('it hands its beads to ship, which needs a repo with .beads')
      writeJson(pinned, def)
    } catch (err) {
      // fresh, nothing in it yet
      // a failed cleanup must not hide the factory error
      try {
        if (isAx) git(repo, 'worktree', 'remove', '--force', worktree)
        else herdr('worktree', 'remove', '--workspace', ws, '--force')
      } catch {}
      rmQuiet(runDir(id), { recursive: true, force: true })
      throw new Error(
        `${relative(checkout ?? worktree, source)} at ${base.slice(0, 8)} is not a valid factory: ${(err as Error).message}`,
      )
    }
  } finally {
    if (checkout) rmQuiet(checkout, { recursive: true, force: true })
  }
  const factoryFrom = from
    ? (from.run.factoryFrom ?? from.run.factory)
    : source.startsWith(checkout ?? worktree)
      ? `${relative(checkout ?? worktree, source)} at ${base.slice(0, 8)}`
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
    ...(shipBranch && { shipBranch }),
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
    const onto = shipBranch ? reworkBase(repo, shipBranch) : undefined
    // the goal says the worktree starts from this branch: do not fall back to the default branch
    if (shipBranch && !onto)
      throw new Error(`origin has no branch ${shipBranch}: a rework run must start from it`)
    return await createRun(spec, repo, goal, { id, bead, from, ship, onto, shipBranch })
  } catch (err) {
    // deferred, not released: a dispatcher would otherwise retry the same failure every window
    try {
      if (bead) b.defer(bead, `could not start a run: ${clip((err as Error).message, 300)}`)
    } catch (deferErr) {
      throw new Error(`${(err as Error).message}; could not defer ${bead}: ${(deferErr as Error).message}`)
    }
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

/** claude-factory-7a7e: the CLI layer behind PATROL step 4 (register.tsx). A patrol cannot start or queue a
 * bead filed from another rig (metadata.discovered_from), or a child of one, until a person adds the
 * `factory` label. Fail closed: an unreadable parent or a chain longer than 8 refuses too. */
function refusePatrolDiscovered(b: ReturnType<typeof beads>, x: Bead) {
  if (!process.env.FACTORY_PATROL) return
  const no = (why: string): never => fail(`${x.id} ${why}: a patrol cannot start it: a person queues it`)
  const hold = x.labels?.find(isHoldLabel)
  if (hold) no(`carries the hold ${hold}`)
  const seen = new Set<string>()
  let cur: Bead = x
  for (;;) {
    if (seen.has(cur.id) || seen.size >= 8) no('has a parent chain the patrol cannot read')
    seen.add(cur.id)
    if (cur.metadata?.discovered_from != null && !cur.labels?.includes(LABEL))
      no(`came from another rig (metadata.discovered_from on ${cur.id})`)
    const p = parentOf(cur)
    if (!p) return
    let next: Bead | null = null
    try {
      next = b.lookup(p)
    } catch {
      // next stays null: refused below
    }
    if (!next) return no(`has a parent ${p} the patrol cannot read`)
    cur = next
  }
}

function beadFor(repo: string, goal: string, { extra = [] as string[], isOwnerOk = false } = {}) {
  if (!hasBeads(repo)) return { goal, handedOff: false }
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
    refusePatrolDiscovered(b, named)
    const open = openChildren(b, named.id)
    if (open.length)
      fail(
        `${named.id} has ${open.length} open child bead(s), which its release would wait on: start those instead (${open
          .slice(0, 6)
          .map(x => `${x.id} ${x.status}`)
          .join(', ')})`,
      )
    const handedOff =
      !!named.labels?.includes(OWNER) ||
      named.metadata?.owner_question !== undefined ||
      named.metadata?.owner_since !== undefined
    return { goal: goalOf(named), bead: named.id, handedOff, shipBranch: shipBranchOf(named) }
  }
  return { goal, bead: b.create(clip(goal.split('\n')[0]!, 100), goal, ...extra), handedOff: false }
}

/**
 * a rig is a repo the factory works (Gas Town's rig): its ready `factory` beads start as runs, its
 * due sweeps start one pass each under `factory sweep` (claude-factory-8pc.16), and `maxRuns` caps
 * its own busy runs under the factory's FACTORY_MAX_RUNS. The factory's rigs.json is written by
 * `factory rig add`, `rig rm`, `rig set`, `rig env`, `rig egress`, `rig beads-remote` and `rig undo`.
 */
export type Rig = {
  name: string
  repo: string
  /** https clone URL; in the AX task `factory repos sync` clones it to the rig's repo there (src/axrepos.ts) */
  remote?: string
  factory: string
  maxRuns?: number
  /** The most live runs per cluster (clusterKey in src/filing-guard.ts). Default 2. Set with `factory rig set --cluster-runs n`. */
  clusterRuns?: number
  /** When the rig has room and no labeled bead, queue the best unlabeled ready leaf beads (src/autoqueue.ts). Off when absent. Use `factory rig set --auto-queue p,n|off`. */
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
  /**
   * A read-only command for the drift sweep: it lists the rig's Flux Kustomizations and HelmReleases,
   * e.g. `flux get kustomizations -A; flux get helmreleases -A`. `factory sweep` runs it on the laptop
   * (`sh -c`, like `slo`). A rig with this set is a GitOps rig. Drift is due only when this is set.
   * `rig add` refuses an explicit `--sweeps` that names `drift` with no `--drift`.
   */
  drift?: string
  /** what the manager works toward there while the rig has room */
  goal?: string
  /** where its workers run: a name in the runner registry (src/runner.ts); herdr panes here when absent */
  runner?: string
  /** Rules before each push, one paragraph each; `{base_branch}` expands. Set with `factory rig set --push-rule text|none` (repeatable). */
  pushRules?: string[]
  /** Extra repo paths the security route treats as sensitive (claude-factory-rtk0w); set with `factory rig set --sensitive-path`. */
  sensitivePaths?: string[]
  /** Skills for all workers in this rig, on top of the factory and station lists. Names come from harness.ts VM_PLUGINS. Use `factory rig set --skills a,b|none`. */
  skills?: string[]
  /** The literal false turns off tool details in the OTel export (src/otel.ts). Use `factory rig set --otel-content on|off`. */
  otelContent?: boolean
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
   * needs a microvm WorkerPool. Use `factory rig set --sandbox-class gvisor|microvm`.
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
  return [...syncRepos(rawRigs(), HOME), ...reviveLiveWorktrees()]
}

/** each live run's missing worktree, made from its branch on origin (a migrated run has none in the task) */
function reviveLiveWorktrees(): string[] {
  const problems: string[] = []
  for (const id of startedRunIds()) {
    try {
      const { run, value } = current(id)
      if (where(value)[1] !== 'working' || existsSync(run.worktree)) continue
      reviveWorktree(run)
    } catch (e) {
      problems.push(`worktree of ${id}: ${(e as Error).message}`)
    }
  }
  return problems
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
  const size = migrate.pack(HOME, p, out)
  const sha = migrate.sha256File(out)
  console.log(`packed ${migrate.mb(size)} (sha256 ${sha}); sending to ${task}`)
  if (ax.hasStdio()) {
    // one stream; the task keeps the file only when its sha256 is the same
    const t0 = Date.now()
    const r = await ax.sendStdio(task, 'migrate.tgz', out, sha)
    if (!r.ok) fail(`the archive did not arrive over ax stdio: ${r.err}`)
    console.log(`sent over ax stdio in ${Math.round((Date.now() - t0) / 1000)} s; sha256 matches`)
  } else await sendParts(task, out, sha)
  // the marker holds the task's launch id: the host trusts only a marker of its own launch
  ax.unpackMigration('migrate.tgz', HOME, ax.launchId(task))
  rmSafe(dir, { recursive: true, force: true })
  console.log(`moved the factory home to ${task}: its manager starts now. factory attach`)
}

/** the old way, for an ax CLI with no `ax stdio`: base64 parts of PUT_PART over ax ssh, then a sha256 check */
async function sendParts(task: string, out: string, sha: string) {
  console.log('this ax CLI has no `ax stdio`: sending put parts over ax ssh (slow)')
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
  const got = ax.remoteSha(task, 'migrate.tgz')
  if (got !== sha) fail(`the archive in ${task} has sha256 ${got}, not ${sha}: run the migrate again`)
}

/** rigs.json as written: on the laptop, the repo paths are the laptop's */
const rawRigs = (): Rig[] => {
  if (!existsSync(rigsFile())) return []
  const text = readFileSync(rigsFile(), 'utf8')
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${rigsFile()}: not valid JSON (${hideParseText((e as Error).message)})`)
  }
}
/** the rigs as this process works them: in the AX task, each `repo` is the rig's clone (src/axrepos.ts) */
const rigs = (): Rig[] => mapRigs(rawRigs())
/** change the rig file under editRigs' lock; a refusal (bad file, bad edit) ends the command */
function edit(fn: (list: Rig[]) => Rig[]) {
  try {
    editRigs(rigsFile(), fn)
  } catch (e) {
    fail((e as Error).message)
  }
}
const rigOf = (repo: string) => rigs().find(r => r.repo === repo)
/** in the AX task a rig with a beadsRemote has beads, with no .beads in git */
const hasBeads = (repo: string) => hasRigBeads(repo, rigs())
/** `rig.personOnlyContexts`, or undefined when it is absent or not an array of strings (a rigs.json written outside the CLI) */
const personOnlyContexts = (rig?: Pick<Rig, 'personOnlyContexts'>): string[] | undefined =>
  Array.isArray(rig?.personOnlyContexts) && rig.personOnlyContexts.every(c => typeof c === 'string')
    ? rig.personOnlyContexts
    : undefined
/** `rig.protectedBranches`, or undefined when it is absent or not an array of strings (a rigs.json written outside the CLI) */
const protectedBranches = (rig?: Pick<Rig, 'protectedBranches'>): string[] | undefined =>
  Array.isArray(rig?.protectedBranches) && rig.protectedBranches.every(b => typeof b === 'string')
    ? rig.protectedBranches
    : undefined
/**
 * the rig's owner/repo (from its origin remote) when `rig.mergeAuthority` is the literal true
 * (a rigs.json written outside the CLI cannot loosen it), else undefined. No readable origin gives undefined: no merge.
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

/** the pm's plan, read once per `dispatch()` pass: missing, corrupt, malshaped or stale
 * (`!plan.isFresh`) all read as no plan, so dispatch falls back to today's order
 * (claude-factory-dun.3, .17d). */
function freshPlanOrUndefined(): plan.Plan | undefined {
  if (!existsSync(planFile())) return undefined
  try {
    const p: unknown = JSON.parse(readFileSync(planFile(), 'utf8'))
    if (!plan.isValidPlanShape(p)) return undefined
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

/** the pre-check's merged-PR lookups for a rig on GitHub (one REST list of the newest 300 closed PRs, then a REST `head=` call
 * per branch) or GitLab (`glab api` merged MR searches: a title search for the id, a second one for a dotted child's short id),
 * plus a lookup for up to 3 local run branches of this bead (a PR that closed the bead's own run but never named it in its
 * title). It throws when the first list or search fails. A failed short-id or branch call keeps the hits already found. */
async function mergedPrsFor(
  repo: string,
  origin: NonNullable<ReturnType<typeof originRef>>,
  id: string,
  branches: string[],
  cli: { gh: Gh; glab: Gh },
): Promise<MergedPr[]> {
  const gl = origin.forge === 'gitlab'
  const glabPath = `${origin.owner}/${origin.repo}`
  let firstErr = ''
  const ref = gl ? null : rigRef(repo) // GitLab does not use it: spare the extra git remote get-url
  // GitHub: one REST list of the newest closed PRs. `alreadyDone` matches the id, the short id and the run
  // branches in it. `gh pr list --search` is GraphQL, which the AX gateway cannot key by owner (oz6s).
  const list = gl
    ? await gitlabMergedJson(
        cli.glab,
        origin.host,
        glabPath,
        repo,
        { search: id, timeoutMs: PRECHECK_TIMEOUT_MS },
        e => (firstErr = e),
      )
    : ref
      ? // ponytail: 3 pages = the newest 300 closed PRs; an older merge is missed by the pre-check
        await githubMergedJson(
          cli.gh,
          ref.slug,
          repo,
          { pages: 3, timeoutMs: PRECHECK_TIMEOUT_MS },
          e => (firstErr = e),
        )
      : null
  if (list === null)
    throw new Error(clip(firstErr.trim().split('\n')[0] || `${gl ? 'glab api' : 'gh api pulls'} failed`, 200))
  const found = parseMergedPrs(list)
  // claude-factory-jxl.1: a GitLab title may cite only the short child id ("192.6"); the full-id search misses it
  const short = gl ? shortBeadId(id) : null
  if (short) {
    const byShort = await gitlabMergedJson(cli.glab, origin.host, glabPath, repo, {
      search: short,
      timeoutMs: PRECHECK_TIMEOUT_MS,
    })
    if (byShort !== null) found.push(...parseMergedPrs(byShort))
  }
  // claude-factory-6as.9: a failed branch call must not discard a hit the search already found.
  // Each branch is a supplementary lookup, so this keeps every row a call did return and skips only
  // the one call that failed.
  for (const branch of branches.slice(0, 3)) {
    const byHead = gl
      ? await gitlabMergedJson(cli.glab, origin.host, glabPath, repo, {
          sourceBranch: branch,
          timeoutMs: PRECHECK_TIMEOUT_MS,
        })
      : ref
        ? await githubMergedJson(cli.gh, ref.slug, repo, {
            pages: 1,
            head: `${ref.owner}:${branch}`,
            timeoutMs: PRECHECK_TIMEOUT_MS,
          })
        : null
    if (byHead !== null) found.push(...parseMergedPrs(byHead))
  }
  return found
}

/**
 * claude-factory-6as: check if a merged PR already proves `bead`'s work is done.
 * If it does, dispatch must reject the bead instead of starting a run for it.
 *
 * This makes no gh or glab call at all in five cases:
 * - `FACTORY_PRECHECK=0`
 * - a person already overrode a prior reject (`rejected_by` metadata still names dispatch after a
 *   requeue)
 * - the id does not look like a bead id
 * - the rig's repo is neither on GitHub nor on GitLab
 * - this pass already saw a gh or glab failure on the same forge (the `forgeFailed` latch, per forge)
 *
 * A gh or glab failure or timeout fails open: the run starts, and the caller gets one dispatch.json row that
 * shows it.
 */
async function precheckSkip(
  rig: Pick<Rig, 'name' | 'repo'>,
  bead: Bead,
  b: ReturnType<typeof beads>,
  runBranches: string[],
  cli: { gh: Gh; glab: Gh },
  forgeFailed: Set<ForgeKind>,
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
  const origin = originRef(rig.repo)
  if (!origin) return { skip: false }
  // claude-factory-6as.9: one failed call already proved this forge broken for the pass; fail every later candidate open
  if (forgeFailed.has(origin.forge)) return { skip: false }
  let merged: MergedPr[]
  try {
    merged = await mergedPrsFor(rig.repo, origin, bead.id, runBranches, cli)
  } catch (err) {
    const error = `pre-check skipped: ${(err as Error).message}`
    logPrecheck(rig.name, bead.id, 'skip', error)
    forgeFailed.add(origin.forge)
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
  // 15s each). The other candidates on that forge, in this rig or the next, must fail open with no
  // further calls, not wait out the same timeout again. The latch is per forge: a broken glab
  // must not turn off the GitHub pre-check.
  const forgeFailed = new Set<ForgeKind>()
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
      // claude-factory-d20: the drift prompt keeps one open bead for each resource, but a model can
      // file a second one. Comment on the oldest, then close the duplicate. A failed call keeps the
      // duplicate from starting this pass (fail closed). The duplicate still counts for the 5/24h cap.
      const duplicates = new Set<string>()
      for (const { dup, original } of driftDuplicates(all)) {
        excluded.add(dup)
        duplicates.add(dup)
        try {
          if (!b.close(dup, `duplicate of ${original}`)) throw new Error(`bd close ${dup} failed`)
          b.comment(original, `drift: ${dup} was a duplicate of this bead; closed it`)
        } catch (err) {
          errors.push({ id: dup, error: (err as Error).message })
        }
      }
      for (const v of sweepGuard(all, Date.now())) {
        scored.add(v.id)
        if (duplicates.has(v.id)) continue // closed above, or kept out: no flood-guard write on it
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
        const hold = x.labels?.find(isHoldLabel)
        const open = isOwned(x) || x.labels?.includes(OWNER) || hold ? [] : openChildren(b, x.id)
        const why =
          isOwned(x) || x.labels?.includes(OWNER) || (open.length && open.every(isWaitingOnPerson))
            ? 'owner decisions pending'
            : hold
              ? `held: ${hold} (factory queue releases it)`
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
              error:
                signing.kind === 'identity'
                  ? `git identity missing in the rig repo (${signing.error}). Set user.name and user.email there; local runs wait. No unsigned fallback.`
                  : `commit signing failed: ${signing.error}. Unlock the signing agent (or fix it); local runs wait. No unsigned fallback.`,
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
        // only shipPass starts a ship run: a ship-named factory here would get merge authority with no run.ship
        if (name === 'ship') {
          deferCandidate('factory ship is reserved for the ship queue: only the runner starts a ship run')
          continue
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
        // claude-factory-6as.9: precheckSkip makes no call for a forge that already failed in this pass;
        // the first candidate's row in precheck.jsonl covers the fail-open for the rest.
        const { skip, error } = await precheckSkip(
          rig,
          bead,
          b,
          runBranches,
          { gh: spawnGh, glab: spawnGlab },
          forgeFailed,
        )
        if (error) errors.push({ id: bead.id, error })
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
  /** ready beads nobody queued yet; absent in an old plan-facts.json (reads as 0) */
  readyUnqueued?: number
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
  readyUnqueued: 0,
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
  readyUnqueued: number,
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
    readyUnqueued,
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
        b.unqueued().length,
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

async function planFactsText() {
  const facts = await gatherPlanFacts()
  writeJson(planFactsFile(), facts)
  return clipFactsJson(facts)
}

async function planFactsCmd() {
  console.log(await planFactsText())
}

/** the Codex model of the manager's fallback steps: FACTORY_MANAGER_CODEX, else gpt-5-codex */
export const fallbackCodexModel = (env = process.env) => env.FACTORY_MANAGER_CODEX || 'gpt-5-codex'

/** `factory patrol|pm|brief|review --once`: one step of the manager, headless (src/once.ts) */
async function onceCmd(verb: 'patrol' | 'pm' | 'brief' | 'review', args: string[]) {
  const codexAt = args.indexOf('--codex')
  // --fallback: the manager's Claude is limited, so the step runs on Codex with the factory's own model name
  const isFallback = args.includes('--fallback')
  const codex = codexAt >= 0 ? args[codexAt + 1] : isFallback ? fallbackCodexModel() : undefined
  if (codexAt >= 0 && !(codex && CODEX_MODEL.test(codex))) fail('--codex needs a model name')
  if (isFallback && !(codex && CODEX_MODEL.test(codex))) fail('FACTORY_MANAGER_CODEX is not a model name')
  if (verb === 'patrol' && (codexAt >= 0 || isFallback))
    fail('the patrol cannot run on codex: codex has no PreToolUse hook, so the Bash guard cannot apply')
  const release = hold(`${verb}.lock`)
  if (!release) return `a ${verb} is already running`
  try {
    const io: Io = {
      home: HOME,
      cli: CLI,
      factories: join(ROOT, 'factories') + '/',
      settings: withoutFleet(),
      planFacts: planFactsText,
      gateFacts: async run => JSON.stringify(await gateBriefFacts(run)),
      reviewFacts: key => JSON.stringify(reviewFacts(key)),
    }
    if (verb === 'patrol') return await patrolOnce(io)
    return verb === 'pm'
      ? await pmOnce(io, codex)
      : verb === 'brief'
        ? await briefOnce(io, codex)
        : await reviewOnce(io, codex)
  } finally {
    release()
  }
}

/** `factory patrol-guard`: the patrol's Claude Code PreToolUse hook for Bash. It reads the hook JSON on stdin. */
async function patrolGuard() {
  let command: unknown
  try {
    command = JSON.parse(await Bun.stdin.text())?.tool_input?.command
  } catch {}
  const deny = (why: string) => {
    console.error(why)
    process.exitCode = 2 // Claude Code reads exit 2 as a deny and shows stderr to the model
  }
  if (typeof command !== 'string') return deny('the hook input has no Bash command')
  const verdict = check(command, 'subagent')
  if (verdict.decision === 'deny') return deny(verdict.reason)
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
 * - a worker calls it (`workerMarker()` finds a worker marker)
 * - `plan-facts.json` is missing, too old (`>= plan.PLAN_FRESH_MS`), or not valid JSON
 * - `<file>` is missing or not valid JSON
 *
 * The pm never runs `bd`. This function turns the pm's answer into bd writes.
 * For each proposal, it checks `hasMetadata('pm_finding', key)` first.
 * A key already filed is never filed again, even under a bead that later closed.
 * It files at most 3 new beads for each rig.
 */
function planSetCmd(answerPath?: string) {
  if (workerMarker()) fail('a worker cannot set the plan: only the pm, through its own turn, may')
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
    if (rf.goal && items.length === 0 && (rf.readyUnqueued ?? 0) === 0)
      found.push(plan.goalNoPlanFinding(name, rf.goal))
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
  if (!plan.isValidPlanShape(raw)) return 'plan.json: missing or malformed rigs/proposals'
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
  headRefOid?: string
  /** the failed check runs at headRefOid; undefined when the pass did not read them */
  failed?: { name: string; url: string }[]
}
const reworkLabels = (pr: LabeledPr) => REWORK_LABELS.filter(name => pr.labels.some(l => l.name === name))
/** what a person's label on a pull request asks: close it (and its run), or a rework run for its conflicts or changes */
export function labelAction(pr: LabeledPr) {
  if (pr.labels.some(l => l.name === CLOSE_LABEL)) return 'close'
  if (!reworkLabels(pr).length) return undefined
  return pr.isCrossRepository ? 'fork' : 'rework' // a fork's branch is not ours to push
}
export const FIX_TESTS_ASK =
  'make its failing build jobs and tests pass; change no behavior that the tests do not check, and do not disable, skip or weaken a test'
const SHOWN = 10 // failed checks named in a goal or a board row
/** the failed checks of a fix-tests PR, as the parenthesis after FIX_TESTS_ASK */
function failedText(pr: LabeledPr) {
  const sha = pr.headRefOid?.slice(0, 7)
  if (!pr.failed)
    return `(the factory did not read its checks: read the failed jobs of its head commit; on GitHub, factory ci ${pr.number} shows the logs)`
  if (!pr.failed.length)
    return `(no check run had failed at ${sha} when the label was read; the factory does not read commit statuses: run gh pr checks ${pr.number})`
  const shown = pr.failed.slice(0, SHOWN).map(c => (c.url ? `${c.name} ${c.url}` : c.name))
  const more = pr.failed.length > SHOWN ? [`+${pr.failed.length - SHOWN} more`] : []
  return `(failed checks at ${sha}: ${[...shown, ...more, `run factory ci ${pr.number} for the logs`].join('; ')})`
}
const asksOf = (pr: LabeledPr) =>
  `labeled ${reworkLabels(pr).join(' and ')}: ${reworkLabels(pr)
    .map(name =>
      name === CONFLICT_LABEL
        ? 'resolve its merge conflicts'
        : name === FIX_TESTS_LABEL
          ? `${FIX_TESTS_ASK} ${failedText(pr)}`
          : 'make the changes its reviews and checks ask for',
    )
    .join(' and ')}`
export const reworkGoal = (pr: LabeledPr) =>
  `Pull request #${pr.number} (${pr.url}) is stuck, ${asksOf(pr)}. Branch ${pr.headRefName}, base ${pr.baseRefName}.`
/** the PR URL at the head of a rework goal (reworkGoal), or undefined for any other goal */
export const reworkPr = (goal: string) => /^Pull request #\d+ \(([^\s()]+)\) is stuck,/.exec(goal)?.[1]
/** how many earlier runs, live or over, were started for this PR with the fix-tests ask */
export const fixTestsTries = (url: string, goals: string[]) =>
  goals.filter(g => reworkPr(g) === url && g.includes(FIX_TESTS_ASK)).length
/** the board row for a fix-tests PR that has used up REQUEUE_MAX runs */
export function cappedRow(pr: LabeledPr, tries: number) {
  const names = pr.failed?.slice(0, SHOWN).map(c => c.name) ?? []
  if (pr.failed && pr.failed.length > SHOWN) names.push(`+${pr.failed.length - SHOWN} more`)
  const what = !pr.failed
    ? 'failed checks not read'
    : !pr.failed.length
      ? `no failed check run at ${pr.headRefOid?.slice(0, 7)}`
      : `failed: ${names.join(', ')}`
  return `${pr.url} is labeled fix-tests, but ${tries} runs did not make its checks pass (${what}): fix it by hand, then remove the label`
}
/**
 * where a labeled PR goes, in order: close, fork error, the ship run of a queued PR, the live run that owns it,
 * the board row of a fix-tests PR with REQUEUE_MAX earlier runs, a new run when the rig has room, else wait.
 * Only fix-tests is capped: its label comes back after each run, so a new run per label could loop.
 */
export function labelRoute(
  pr: LabeledPr,
  ctx: { queued: boolean; owner: boolean; room: number; tries: number },
) {
  const action = labelAction(pr)
  if (action === undefined) return undefined
  if (action === 'close') return 'close' as const
  if (action === 'fork') return 'fork' as const
  if (ctx.queued) return 'ship' as const
  if (ctx.owner) return 'owner' as const
  if (pr.labels.some(l => l.name === FIX_TESTS_LABEL) && ctx.tries >= REQUEUE_MAX) return 'capped' as const
  return ctx.room > 0 ? ('start' as const) : ('wait' as const)
}
/**
 * the live run that owns a pull request. The PR is on the run's branch, or a report of the run links it,
 * or the run is a rework run for it. A rework run uses the PR's own branch, so only its goal names the PR.
 */
export const prOwner = (
  pr: Pick<LabeledPr, 'url' | 'headRefName'>,
  live: { id: string; log: Entry[]; goal: string }[],
) =>
  live.find(
    r =>
      pr.headRefName === `factory/${r.id}` ||
      reworkPr(r.goal) === pr.url ||
      r.log.some(e => [...prsIn(e.summary), ...mrsIn(e.summary)].includes(pr.url)),
  )?.id

/**
 * the rework runs whose PR is merged or closed. `stateOf` reads a PR only for a run with a rework goal.
 * A state that is not MERGED or CLOSED, or a failed read (undefined), ends no run.
 */
export function reworkEnded(
  live: { id: string; goal: string }[],
  stateOf: (url: string) => string | undefined,
) {
  return live.flatMap(r => {
    const url = reworkPr(r.goal)
    const state = url ? stateOf(url) : undefined
    return url && (state === 'MERGED' || state === 'CLOSED') ? [{ id: r.id, url, state }] : []
  })
}

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

/** a `rework` label asks for changes, so the work goes through implement; a bare `conflict` label only needs a rebase */
const wantsChanges = (pr: LabeledPr) =>
  reworkLabels(pr).includes(REWORK_LABEL) || reworkLabels(pr).includes(FIX_TESTS_LABEL)

/** the run to start for a rework-labeled PR no run owns: implement on the PR's own branch, or the one-station rework.yaml */
export function reworkStart(pr: LabeledPr, factory: string) {
  if (!wantsChanges(pr)) return { spec: 'rework', goal: reworkGoal(pr), branch: undefined, at: undefined }
  const goal = `${reworkGoal(pr)} Your worktree starts from origin/${pr.headRefName}. Push your commits to that branch (git push origin HEAD:${pr.headRefName}). Open no new PR.`
  return { spec: factory, goal, branch: pr.headRefName, at: 'implement' as const }
}

/**
 * a live run owns the PR that got a label: remove the label, mail the station, comment on the PR.
 * A `rework` label on a run with an implement station also moves the run there (claude-factory-8yhq).
 */
export function reworkOwned(
  pr: LabeledPr,
  owner: { id: string; node: string; c: Parameters<typeof isParkedOn>[0]; implement?: boolean },
  io: {
    unlabel: (pr: LabeledPr, labels: string[]) => unknown
    comment: (pr: LabeledPr, body: string) => unknown
    post: (runId: string, ev: ReturnType<typeof labelMail> | { type: 'GOTO'; node: string }) => unknown
  },
) {
  const toImplement = wantsChanges(pr) && !!owner.implement && owner.node !== 'implement' // already there: mail only, a goto would restart its work
  const node = toImplement ? 'implement' : owner.node
  const text = toImplement
    ? `[factory] ${pr.url} was ${asksOf(pr)}. Do it at this station, then go on to verify and review.`
    : `[factory] ${pr.url} was ${asksOf(pr)}. Do it as part of this station's work, or say on the pull request why not.`
  // the label first: if it cannot come off, the next pass would mail (or start a run) again, every pass
  io.unlabel(pr, reworkLabels(pr))
  io.post(owner.id, labelMail({ c: owner.c, node }, pr.url, text))
  if (toImplement) io.post(owner.id, { type: 'GOTO', node })
  io.comment(pr, `Handed to claude-factory run \`${owner.id}\` (${node}), which owns this.`)
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
    try {
      const r = row(run, await loadPinned(run.factory), value, c)
      out.set(run.bead, {
        blocked: !!holdOf(r),
        why: r.gate?.question ?? r.last?.summary,
        since: r.last?.at ?? r.since,
      })
    } catch (err) {
      out.set(run.bead, {
        blocked: true,
        why: `pinned factory does not load: ${(err as Error).message.replace(/\s+/g, ' ')}`,
        since: c.startedAt,
      })
    }
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
  held = new Set<string>(),
) {
  try {
    for (const p of closableParents(b.every(), closed, id, held)) {
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
      const every = b.every()
      const prs = await rigPrs(rig.repo)
      // queue and release own conflicts while they run; otherwise read mergeable for each queued OPEN PR
      const owned = liveShipRuns().some(
        s => s.run.repo === rig.repo && (s.node === 'queue' || s.node === 'release'),
      )
      // the probe writes p.mergeable onto the objects in prs; repairs() below reads it
      if (!owned)
        for (const p of conflictProbes(every, prs, live)) {
          const path = githubPullPath(p.url)
          const res = path ? await spawnGh(['api', path], { cwd: rig.repo, timeout: 30_000 }) : null
          p.mergeable = res?.code === 0 ? parseGithubView(res.out)?.mergeable : undefined
        }
      // ponytail: rigPrs reads the newest 200 PRs, so an older open PR holds nothing. Upgrade: a separate open-only list.
      const held = heldBeads(prs, runBeadsOf(rig.repo))
      const todo = repairs(rig.name, every, prs, live, Date.now(), held).slice(0, REPAIR_CAP)
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
                  : r.kind === 'conflict'
                    ? b.rework(r.id, r.reason)
                    : false
        if (!done) continue
        const at = new Date().toISOString()
        appendFileSync(repairsFile(), JSON.stringify({ at, rig: rig.name, ...r }) + '\n')
        console.log(`${at} repair ${rig.name} ${r.kind} ${r.id}: ${r.reason}`)
        if (r.kind === 'close') {
          closed.add(r.id)
          closeParents(b, rig.repo, r.id, 'the repair pass', closed, held)
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
  const all = startedRunIds().map(id => ({ id, ...current(id) }))
  const goals = all.map(r => r.run.goal)
  const live = all
    .filter(r => !['done', 'aborted'].includes(where(r.value)[0]))
    .map(r => ({
      id: r.id,
      node: where(r.value)[0],
      log: r.c.log,
      c: r.c,
      goal: r.run.goal,
      repo: r.run.repo,
    }))
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
            // ponytail: GitLab job names are not read; the goal tells the worker to read them.
            // Upgrade path: read projects/:id/pipelines/:pipeline_id/jobs?scope[]=failed from the MR head_pipeline.
            failed: (): undefined => undefined,
            state: (url: string) => {
              const iid = prRef(url)?.number
              if (!iid) return undefined
              const project = encodeURIComponent(`${origin.owner}/${origin.repo}`)
              const out = cli('glab', [
                'api',
                '--hostname',
                origin.host,
                `projects/${project}/merge_requests/${iid}`,
              ])
              return parseGitlabView(out)?.state
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
              failed: (pr: LabeledPr) => {
                if (!/^[0-9a-f]{40}$/.test(pr.headRefOid ?? '')) return undefined
                try {
                  return failedChecks(
                    gh('api', `repos/${slug()}/commits/${pr.headRefOid}/check-runs?per_page=100`),
                  )
                } catch (err) {
                  const why = (err as Error).message.split('\n')[0]
                  console.log(
                    `${new Date().toISOString()} fix-tests ${pr.url}: check-runs read failed: ${why}`,
                  )
                  return undefined
                }
              },
              state: (url: string) => {
                const path = githubPullPath(url)
                return path ? parseGithubView(gh('api', path))?.state : undefined
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
      // a rework run for a merged or closed PR has no work left. End it. The list below shows open PRs only.
      const ended = reworkEnded(
        live.filter(r => r.repo === rig.repo),
        url => {
          try {
            return forge.state(url)
          } catch {
            return undefined // a failed read must not end a run
          }
        },
      )
      for (const e of ended) {
        post(e.id, { type: 'ABORT' })
        console.log(`${new Date().toISOString()} rework ${e.url} was ${e.state}: abort run ${e.id}`)
      }
      const labeled = await forge.list()
      const shipped = labeled.some(pr => ['rework', 'close'].includes(labelAction(pr)!))
        ? beads(rig.repo, 'factory').shipQueue()
        : []
      for (const listed of labeled) {
        // the checks are read only for a PR that goes to a run: a fork or a close PR makes no call
        const pr =
          listed.labels.some(l => l.name === FIX_TESTS_LABEL) && labelAction(listed) === 'rework'
            ? { ...listed, failed: forge.failed(listed) }
            : listed
        const action = labelAction(pr)
        const queuedBead = action === 'rework' ? queuedOwner(pr, shipped) : undefined
        // a queued PR closed unmerged leaves the queue: the ship run would loop on it as the next PR
        if (action === 'close') {
          const closed = queuedOwner(pr, shipped)
          if (closed) beads(rig.repo, 'factory').unship(closed.id, `${pr.url} was closed unmerged`)
        }
        const runId = prOwner(pr, live)
        const tries = fixTestsTries(pr.url, goals)
        const route = labelRoute(pr, {
          queued: !!queuedBead,
          owner: !!runId,
          room: room(rig, busy, undefined, held),
          tries,
        })
        if (route === 'ship' && queuedBead) {
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
        if (route === 'close') {
          forge.close(pr, `Closed by claude-factory: labeled \`${CLOSE_LABEL}\`.`)
          if (runId) post(runId, { type: 'ABORT' })
          console.log(`${new Date().toISOString()} closed ${pr.url}${runId ? ` (run ${runId})` : ''}`)
        } else if (route === 'fork') {
          errors.push({
            id: `rig:${rig.name}`,
            error: `${pr.url} is labeled ${reworkLabels(pr).join(', ')} but comes from a fork: rework it there`,
          })
        } else if (route === 'capped') {
          errors.push({ id: `rig:${rig.name}`, error: cappedRow(pr, tries) })
          console.log(`${new Date().toISOString()} fix-tests ${pr.url}: capped after ${tries} runs`)
        } else if (route === 'owner' && runId) {
          const owner = live.find(r => r.id === runId)!
          const implement = Object.hasOwn((await loadPinned(loadRun(runId).factory)).nodes, 'implement')
          reworkOwned(pr, { ...owner, implement }, { ...forge, post })
          console.log(
            `${new Date().toISOString()} rework ${pr.url} → its run ${runId} (was at ${owner.node})`,
          )
        } else if (route === 'start') {
          forge.unlabel(pr, reworkLabels(pr))
          const start = reworkStart(pr, rig.factory)
          const { run, def } = await createTracked(
            start.spec,
            'rework',
            rig.repo,
            start.goal,
            undefined,
            undefined,
            undefined,
            start.branch,
          )
          if (start.at && Object.hasOwn(def.nodes, start.at)) post(run.id, { type: 'GOTO', node: start.at })
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
 * Delete the AX tasks and workspaces that no live run owns (claude-factory-sps9): a failed delete in the close
 * path, or a run that ended with its worker up, leaks them. sweepNames picks the names; it keeps everything this
 * home does not own. Every AX_SWEEP_MS, only with an ax rig and no halt. If a list call fails, nothing is deleted.
 * It writes ax.log (one summary line for each pass) and ax-sweep.json (the board rows).
 * ponytail: a name that never deletes holds one of the SWEEP_CAP slots for ever; the ax.log line names it.
 */
function axSweep() {
  const stamp = join(HOME, 'ax-sweep.stamp')
  if (halted() || !rigs().some(r => r.runner === 'ax') || isFresh(stamp, AX_SWEEP_MS)) return
  writeFileSync(stamp, '')
  const log = (line: string) => appendFileSync(join(HOME, 'ax.log'), `${new Date().toISOString()} ${line}\n`)
  const errors: Row[] = []
  const fail = (error: string) => errors.push({ id: 'ax-sweep', error: `ax-sweep: ${error}` })
  try {
    const workspaces = ax.names('workspaces')
    const tasks = ax.names('tasks')
    if (!workspaces || !tasks) {
      fail(`ax get ${tasks ? 'workspaces' : 'tasks'} failed; nothing deleted`)
    } else {
      // the run states last, so they are as new as the lists allow
      const runs: SweepRun[] = []
      for (const id of startedRunIds())
        try {
          const { run, value, c } = current(id)
          runs.push({
            id: run.id,
            seq: c.seq,
            pane: c.pane,
            over: ['done', 'aborted'].includes(where(value)[0]),
          })
        } catch {
          // no readable state: keep an owner that never gets a delete (seq -1)
          runs.push({ id, seq: -1, pane: null, over: false })
        }
      const picked = axSweepNames([...tasks, ...workspaces], runs, ax.managerTask())
      let removed = 0
      for (const name of picked) {
        const failed = ax.remove(name)
        if (failed) {
          fail(`remove ${name} failed: ${failed}`)
        } else {
          removed++
          log(
            `swept ${name} run ${runs.find(r => ax.taskName(r.id, Number(/\d+$/.exec(name)![0])) === name)?.id}`,
          )
        }
      }
      log(
        `ax-sweep: tasks ${tasks.length} workspaces ${workspaces.length} removed ${removed} failed ${picked.length - removed}`,
      )
    }
  } catch (e) {
    // a missing ax binary throws: the pass ends, the stamp stays, the next try is one AX_SWEEP_MS away
    fail((e as Error).message.slice(0, 200))
  }
  writeJson(join(HOME, 'ax-sweep.json'), errors)
  if (errors.length) log(errors.map(e => e.error).join('; '))
}

/**
 * Run id -> bead for the runs of `repo` that have a bead. A run with no readable state is left out.
 * ponytail: it reads every started run's state on each call. Upgrade: one read for each tick.
 */
export function runBeadsOf(repo: string, ids = startedRunIds(), read: typeof current = current) {
  const out = new Map<string, string>()
  for (const id of ids)
    try {
      const { run } = read(id)
      if (run.repo === repo && run.bead) out.set(id, run.bead)
    } catch {
      // no readable state
    }
  return out
}

/** the run view orphanPass builds OrphanCtx from; `read` is injectable for tests */
export function orphanRuns(ids: string[], read: typeof current = current) {
  const runs = new Map<string, Run>()
  const live: { id: string; log: Entry[]; goal: string; bead?: string }[] = []
  const decided = new Set<string>()
  for (const id of ids) {
    try {
      const { run, value, c } = read(id)
      const [node] = where(value)
      runs.set(id, run)
      if (c.log.at(-1)?.outcome === 'decision') decided.add(id)
      if (!['done', 'aborted'].includes(node)) live.push({ id, log: c.log, goal: run.goal, bead: run.bead })
    } catch {
      // the run has no readable state yet
    }
  }
  return { runs, live, decided }
}

/**
 * Start a review run for each green draft pull request that no run owns (claude-factory-pff5).
 * An aborted run that blocked leaves such a PR. In each GitHub or GitLab rig, `orphanSweep` forks the source run
 * at `review`. It forks ORPHAN_CAP runs at most in one pass, and only where the rig has room.
 * Each fork goes in orphan-forks.json, keyed by PR URL and head SHA: one review for each head.
 * If that file is unreadable, the rig is skipped: with no record, a PR can get two forks.
 * The mail to the station is from `factory`. Mail from `manager` counts as owner approval.
 * The new run starts at the next tick.
 */
async function orphanPass() {
  const stamp = join(HOME, 'orphans.stamp')
  if (halted() || isFresh(stamp, ORPHANS_MS)) return
  writeFileSync(stamp, '')
  const errors: Row[] = []
  const file = join(HOME, 'orphan-forks.json')
  let records: OrphanCtx['records'] | undefined
  try {
    const read = existsSync(file) ? readJson<unknown>(file) : {}
    if (read && typeof read === 'object' && !Array.isArray(read)) records = read as OrphanCtx['records']
  } catch {
    // left undefined
  }
  const { busy, held } = await busyRigs()
  const { runs, live, decided } = orphanRuns(startedRunIds())
  for (const rig of rigs()) {
    try {
      const ref = rigRef(rig.repo)
      const gl = originRef(rig.repo)
      if (!ref && gl?.forge !== 'gitlab') continue
      if (!records) throw new Error('orphan-forks.json is unreadable')
      const cap = Math.min(ORPHAN_CAP, room(rig, busy, undefined, held))
      // a full rig forks nothing (cap 0), but its failed-fork rows stay
      const project = gl ? `${gl.owner}/${gl.repo}` : ''
      let all: OrphanPr[]
      if (ref) {
        const rows = await githubPulls(spawnGh, ref.slug, rig.repo, { state: 'open', pages: 2 })
        if (!rows) throw new Error('gh api pulls failed')
        all = githubRows(rows) as OrphanPr[]
      } else {
        // ponytail: one page of 100 MRs; a project with more open MRs misses the older ones. Upgrade: page=2, as githubPulls does.
        const r = await spawnGlab(
          [
            'api',
            '--hostname',
            gl!.host,
            `projects/${encodeURIComponent(project)}/merge_requests?state=opened&per_page=100`,
          ],
          { cwd: rig.repo, timeout: 60_000 },
        )
        if (r.code !== 0) throw new Error('glab api merge_requests failed')
        all = parseGitlabLabeled(r.out)
      }
      const prs = all.filter(pr => pr.headRefName.startsWith('factory/'))
      if (!prs.length) continue
      const shipQueue = beads(rig.repo, 'factory').shipQueue()
      const mine = new Map<string, { bead?: string; decided?: boolean }>()
      for (const [id, run] of runs)
        if (run.repo === rig.repo) mine.set(id, { bead: run.bead, decided: decided.has(id) })
      const ctx: OrphanCtx = {
        runs: mine,
        liveBeads: new Set(live.flatMap(r => (r.bead ? [r.bead] : []))),
        owner: pr => prOwner(pr, live),
        queued: pr => !!queuedOwner(pr, shipQueue),
        records: records,
        forkAborted: id => {
          try {
            return where(current(id).value)[0] === 'aborted'
          } catch {
            return false // no such run: the fork did not abort
          }
        },
      }
      const { skipped } = await orphanSweep(
        prs,
        ctx,
        {
          bead: async id => {
            try {
              const b = beads(rig.repo, 'factory').show(id)
              return b?.status ? { status: b.status, reason: b.close_reason } : null
            } catch {
              return null
            }
          },
          checks: pr =>
            ref
              ? githubChecks(spawnGh, ref.slug, pr.headRefOid, rig.repo)
              : gitlabChecks(spawnGlab, gl!.host, project, pr.number, pr.headRefOid, rig.repo),
          view: async pr => {
            if (ref) {
              const v = await githubWatchView(spawnGh, pr.url, rig.repo)
              return (
                v && {
                  mergeable: v.mergeable ?? 'UNKNOWN',
                  changes: v.reviewDecision === 'CHANGES_REQUESTED',
                  approved: v.reviewDecision === 'APPROVED',
                }
              )
            }
            const r = await spawnGlab(
              [
                'api',
                '--hostname',
                gl!.host,
                `projects/${encodeURIComponent(project)}/merge_requests/${pr.number}`,
              ],
              { cwd: rig.repo, timeout: 60_000 },
            )
            const mr = r.code === 0 ? (JSON.parse(r.out || 'null') as Record<string, unknown> | null) : null
            if (!mr) return null
            // a draft MR reports detailed_merge_status "draft_status", so read has_conflicts and the review ask directly
            const status = String(mr.detailed_merge_status ?? '')
            return {
              mergeable:
                mr.has_conflicts === true || status === 'conflict'
                  ? 'CONFLICTING'
                  : mr.has_conflicts === false && ['mergeable', 'draft_status'].includes(status)
                    ? 'MERGEABLE'
                    : 'UNKNOWN',
              changes: status === 'requested_changes',
              // ponytail: the MR endpoint has no approval field, so a GitLab MR never counts as approved. Upgrade: the MR /approvals endpoint (as src/prs.ts reads approvals.approved).
              approved: false,
            }
          },
          label: async (pr, labels) => {
            const r = ref
              ? await spawnGh(githubLabelArgv(ref.slug, pr.number, labels), {
                  cwd: rig.repo,
                  timeout: 60_000,
                })
              : await spawnGlab(['mr', 'update', String(pr.number), '--label', labels.join(',')], {
                  cwd: rig.repo,
                  timeout: 60_000,
                })
            if (r.code !== 0) throw new Error(r.err.trim().split('\n')[0] || 'label call failed')
          },
          close: async (pr, body) => {
            const calls = ref
              ? [githubCommentArgv(ref.slug, pr.number, body), githubCloseArgv(ref.slug, pr.number)]
              : [
                  ['mr', 'note', String(pr.number), '-m', body],
                  ['mr', 'close', String(pr.number)],
                ]
            for (const argv of calls) {
              const r = await (ref ? spawnGh : spawnGlab)(argv, { cwd: rig.repo, timeout: 60_000 })
              if (r.code !== 0) throw new Error(r.err.trim().split('\n')[0] || 'close call failed')
            }
          },
          fork: async (pr, srcId, note) => {
            const { value } = current(srcId)
            const src = runs.get(srcId)!
            const def = await loadPinned(src.factory)
            if (!Object.hasOwn(def.nodes, 'review'))
              throw new Error(`${srcId}: its factory has no review station`)
            const run = await forkRun(src, value, def.name, 'review', note, 'factory')
            busy.push(rig.name)
            return run.id
          },
          record: (pr, from, run) => {
            records![pr.url] = { sha: pr.headRefOid, run, from, at: new Date().toISOString() }
            writeJson(file, records)
            if (run)
              console.log(
                `${new Date().toISOString()} orphan ${pr.url}@${pr.headRefOid.slice(0, 7)} -> fork ${from} into ${run}`,
              )
          },
        },
        Math.max(cap, 0),
      )
      const shown = new Set<string>()
      for (const s of skipped)
        if (/^((fork|record) failed|held for the person: )/.test(s.why)) {
          shown.add(s.url)
          errors.push({ id: `rig:${rig.name}`, error: `orphans: ${s.url}: ${s.why}` })
        }
      // a failed fork keeps its record, so later passes skip the PR: show the row every pass until a person removes the entry
      for (const pr of prs)
        if (records![pr.url]?.sha === pr.headRefOid && records![pr.url]?.run === '' && !shown.has(pr.url))
          errors.push({
            id: `rig:${rig.name}`,
            error: `orphans: ${pr.url}: fork failed or not recorded at ${pr.headRefOid.slice(0, 7)}; check for a review run, then remove its orphan-forks.json entry to retry`,
          })
    } catch (err) {
      errors.push({ id: `rig:${rig.name}`, error: `orphans: ${(err as Error).message}` })
    }
  }
  writeJson(join(HOME, 'orphans.json'), errors)
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
        const def = await loadPinned(run.factory)
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
        const fs = store[key]!
        fs.failedPasses = failed ? (fs.failedPasses ?? 0) + 1 : 0
        if (fs.failedPasses >= WATCH_FAIL_PASSES && !fs.failMailed) {
          fs.failMailed = true
          const bad = [...urls, ...mrUrls].filter((_, n) => views[n] === null)
          post(id, {
            type: 'MAIL',
            from: 'factory',
            to: 'manager',
            text: `[factory] watch: gh/glab could not view ${bad.join(', ')} on ${WATCH_FAIL_PASSES} passes in a row. Run ${id} stays parked at ${node} with no worker until ${new Date(c.wakeAt).toISOString()}. Check gh/glab auth, rate limit and repo access.`,
          })
          console.log(`${new Date().toISOString()} ${id}: mailed the manager: ${bad.length} failed view(s)`)
        }
        const now = Date.now()
        const d = watchDecide({
          prs,
          failed,
          parkedAt: parked.at,
          now,
          wakeAt: c.wakeAt,
          plainMin,
          mailOnly: !!parked.mailOnly,
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
                const first = cut(body.split('\n', 1)[0]!, 80)
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
    if (run.ship) continue // a rig's ship run counts against no cap (claude-factory-rtuw); only shipPass sets this, and a fork copies it from its source
    const [node, sub] = where(value)
    let s
    try {
      s = slot((await loadPinned(run.factory)).nodes[node], sub)
    } catch {
      s = 'busy' // a def that does not load: count the run busy on its rig, safe on the cap
    }
    if (s === 'busy') busy.push(rigOf(run.repo)?.name)
    else if (s === 'rig') held.push(rigOf(run.repo)?.name)
  }
  return { busy, held }
}

/** the lines of `factory rig list`: each rig, its busy count and its settings, then the town's count */
async function rigListLines(print: Print) {
  const { busy, held } = await busyRigs()
  if (!rigs().length) print('no rigs: factory rig add <name> <repo> [factory]')
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
    print(
      `${r.name}  ${r.repo}  ${r.factory}  busy ${n}${r.maxRuns ? `/${r.maxRuns}` : ''}  sweeps ${sweepsLine.join(',') || 'none'}`,
    )
    const safe = redactRig(r)
    if (r.goal) print(`  goal: ${safe.goal}`)
    if (r.slo) print(`  slo: ${safe.slo}`)
    if (r.drift) print(`  drift: ${safe.drift}`)
    if (r.agent) print(`  agent: ${safe.agent}`)
    if (personOnlyContexts(r)?.length) print(`  person-only contexts: ${personOnlyContexts(r)!.join(', ')}`)
    if (protectedBranches(r)?.length) print(`  protected branches: ${protectedBranches(r)!.join(', ')}`)
    if (r.mergeAuthority === true)
      print(`  merge authority: ship release station, ${mergeAuthority(r) ?? 'no origin: off'}`)
    if (r.mcp) print(`  mcp: ${safe.mcp}`)
    for (const k of Object.keys(safe.params ?? {})) print(`  param ${k}: <hidden>`)
    if (safe.linear) {
      const extra = [
        safe.linear.projects?.length ? `projects ${safe.linear.projects.join('|')}` : '',
        safe.linear.labels?.length ? `labels ${safe.linear.labels.join('|')}` : '',
      ].filter(Boolean)
      print(
        `  linear: team ${safe.linear.team.join(',')}${extra.length ? `, ${extra.join(', ')}` : ''}${linearSyncLine(r.name)}`,
      )
    }
  }
  print(`town: busy ${busy.length}/${MAX_BUSY}, stuck ${held.length}`)
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
const runnerMsg = (runner: string) => `--runner is ${Object.keys(runners).join(', ')} (not "${runner}")`

/** Check a built Rig. It does no I/O. It fails on the first bad field and returns warning lines. */
export function validateRig(rig: Rig, env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = []
  const { runner, agent, mcp, egress } = rig
  if (runner !== undefined && !Object.hasOwn(runners, runner)) fail(runnerMsg(runner))
  const remote = runners[runner ?? DEFAULT_RUNNER]!.local === false
  if (remote && mcp !== undefined)
    fail(`--mcp does not reach a ${runner} worker: its servers' commands would have to exist in the VM`)
  if (mcp !== undefined && agent !== undefined && harnessOf(agent) === 'pi')
    fail('--mcp does not reach a pi worker: pi has no MCP client (constitution I)')
  if (mcp !== undefined && agent !== undefined && harnessOf(agent) === 'cursor')
    fail(
      '--mcp does not reach a cursor worker: its servers would load from an mcp.json the deny hook does not cover',
    )
  if (mcp !== undefined && agent !== undefined && harnessOf(agent) === 'grok')
    fail('--mcp does not reach a grok worker: its servers are not behind the deny hook')
  if (remote && agent !== undefined && !harnessOf(agent))
    fail(`--agent for the ${runner} runner is claude, codex, cursor, grok or pi (not "${hideSecret(agent)}")`)
  if (remote && agent !== undefined) axCodexRefused(agent, env)
  if (remote && agent !== undefined) axCursorRefused(agent, env)
  if (remote && agent !== undefined) axGrokRefused(agent, env)
  if (egress?.length) {
    if (!remote) fail('--egress applies to a runner with an egress policy: add --runner ax')
    for (const host of egress.flatMap(e => e.hosts).filter(h => ax.isRegistryHost(h)))
      warnings.push(
        `warning: --egress ${host} is a package registry host; once a pkg-gate is on (FACTORY_AX_PKG_GATE), ` +
          `it is stripped from this rig's policy and never reaches the VM directly`,
      )
  }
  if (agent !== undefined && !agent.trim()) fail('--agent is the worker command, e.g. "codex --full-auto"')
  if (rig.sandboxClass !== undefined && !remote)
    fail('--sandbox-class needs the ax runner: add --runner ax, or run rig set --sandbox-class gvisor first')
  if (rig.maxRuns !== undefined && !(Number.isInteger(rig.maxRuns) && rig.maxRuns >= 1))
    fail(`--max is a number of runs, at least 1 (not "${rig.maxRuns}")`)
  if (rig.slo !== undefined && !rig.slo.trim())
    fail('--slo is a read-only command, e.g. --slo "kubectl get pods -A | grep -v Running"')
  if (rig.drift !== undefined && !rig.drift.trim())
    fail(
      '--drift is a read-only command, e.g. --drift "flux get kustomizations -A; flux get helmreleases -A"',
    )
  // monitor reads rig.slo; an explicit opt-in with no command set would never fire (src/sweeps.ts's
  // dueSweeps already gates it), which is a silent no-op a person is better off told about now
  if (rig.sweeps?.includes('monitor') && !rig.slo)
    fail('monitor needs --slo "<read-only command>": add it, or drop monitor from --sweeps')
  if (rig.sweeps?.includes('drift') && !rig.drift)
    fail('drift needs --drift "<read-only command>": add it, or drop drift from --sweeps')
  if (
    rig.pushRules !== undefined &&
    !(Array.isArray(rig.pushRules) && rig.pushRules.every(r => typeof r === 'string' && r.trim()))
  )
    fail('pushRules is a list of non-empty strings')
  const b = rig.beadsRemote
  if (b) {
    if (![b.name, b.user].every(s => BEADS_WORD.test(s))) fail(BEADS_WORD_MSG)
    if (!URL.canParse(b.url)) fail('beadsRemote url is not a URL')
  }
  return warnings
}

/** Check `--param name=value` pairs against the factory's params. Return them merged over `base`, or `base`. */
function checkParams(
  def: Awaited<ReturnType<typeof loadFactory>>,
  pairs: string[],
  base?: Record<string, string>,
) {
  let out = base
  for (const p of pairs) {
    const [k, v] = [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]
    if (!p.includes('=') || !(k in (def.params ?? {})))
      fail(
        `--param is name=value, its name one of ${def.name}'s params: ${Object.keys(def.params ?? {}).join(', ') || 'none'} (not "${p}")`,
      )
    if (k === 'base_branch' && v && !branchOk(v))
      fail(`--param base_branch is a plain branch name such as main or acme/deploy (not "${v}")`)
    out = { ...out, [k]: v }
  }
  return out
}

/** Fail when a sweep name is not one of the sweeps factory's sweeps. */
async function checkSweeps(wanted: string[], sweepsFactory: string | undefined, repo: string) {
  const sweepsDef = await loadFactory(factorySource(sweepsFactory ?? 'sweeps', repo))
  const names = sweepNames(sweepsDef)
  const unknown = wanted.filter(s => !names.includes(s))
  if (unknown.length)
    fail(`no sweep ${unknown.join(', ')} in ${sweepsDef.name}: ${names.join(', ') || 'none'}`)
}

async function defineRig(
  name: string,
  path: string,
  factory: string,
  {
    max,
    sweeps,
    slo,
    drift,
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
    drift?: string
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
  const rig: Rig = { name, repo, factory, ...(goal && { goal }), ...(agent !== undefined && { agent }) }
  if (runner !== undefined && runner !== DEFAULT_RUNNER) rig.runner = runner
  if (slo !== undefined) rig.slo = slo
  if (drift !== undefined) rig.drift = drift
  if (egress?.length) {
    try {
      rig.egress = egress.map(ax.parseEgress)
    } catch (err) {
      fail((err as Error).message)
    }
  }
  if (max !== undefined) {
    if (!/^[1-9]\d*$/.test(max)) fail(`--max is a number of runs, at least 1 (not "${max}")`)
    rig.maxRuns = Number(max)
  }
  if (sweeps !== undefined) rig.sweeps = sweeps === 'none' ? [] : sweeps.split(',')
  if (mcp !== undefined) rig.mcp = mcp
  for (const w of validateRig(rig)) console.warn(w)
  if (mcp !== undefined) {
    rig.mcp = expand(mcp)
    try {
      readMcp(rig.mcp)
    } catch (err) {
      fail(`--mcp ${mcp}: ${(err as Error).message}`)
    }
  }
  const merged = checkParams(def, params ?? [], rig.params)
  if (merged) rig.params = merged
  if (sweeps !== undefined) await checkSweeps(rig.sweeps ?? [], rig.sweepsFactory, repo)
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
  if (!factory || !repo || !goal) fail("usage: factory start <factory>[@station] <rig|repo> '<goal...>'")
  const root = repoOf(repo!)
  await assertRoom(root)
  // <factory>@<station> starts past the triage when the caller already knows the kind of work
  const [spec, at] = factory!.split(/@(?=[^@/]+$)/)
  // the checkout's version answers the station question; the run pins the version its base commit holds
  const preview = await loadFactory(factorySource(spec!, root))
  if (at && !Object.hasOwn(preview.nodes, at))
    fail(`no station "${at}" in ${preview.name}: ${Object.keys(preview.nodes).join(', ')}`)
  if (preview.name === 'ship')
    fail(
      `only the runner starts a ship run, once for each rig with a queue: see factory ship ${rigOf(root)?.name ?? root}`,
    )
  const linked = beadFor(root, goal, { isOwnerOk })
  const { run, def } = await createTracked(
    spec!,
    preview.name,
    root,
    linked.goal,
    linked.bead,
    undefined,
    undefined,
    linked.shipBranch,
  )
  // the run exists and holds the claim: end the hand-off now. A failure only warns, the run is live (claude-factory-h1wj)
  if (linked.handedOff && !beads(root, actorOf(run.id)).clearOwner(linked.bead!))
    console.error(
      `warning: could not clear the owner label of ${linked.bead}: it stays handed off. Run: factory queue to clear it by hand`,
    )
  if (at && at !== def.start && Object.hasOwn(def.nodes, at)) post(run.id, { type: 'GOTO', node: at })
  await tick() // launches the first worker now rather than at the next tick
  console.log(
    `started ${run.id} in ${run.worktree}${run.ws ? ` (herdr workspace ${run.ws})` : ''}, following ${run.factoryFrom}${run.bead ? `, bead ${run.bead}` : ''}`,
  )
}

/** the cwd of this process, or '' when its folder is gone: then no worktree matches, as before */
function here(): string {
  try {
    return process.cwd()
  } catch {
    return ''
  }
}

/** claude-factory-ab8n: the sender for mail the manager posts (mail, poke and fork); see src/core/caller.ts */
function managerSender(run: Run, env: Env = process.env, cwd = here()): 'manager' {
  return managerSenderIn(env, cwd, run)
}

/** claude-factory-e10f: the verbs a worker can run. The CLI refuses all other verbs, also a new verb. */
const WORKER_VERBS = [
  'report',
  'mail',
  'memory',
  'status',
  'show',
  'check',
  'home',
  'ship',
  'advisories',
  'pg-scratch',
  'mutate',
  'ci',
  'worker',
  'file-elsewhere',
  'parity',
]

/** why a worker may not run this verb, else undefined (no marker, a listed verb, `rig list`, `rig show`, or usage) */
export function workerVerbRefusal(
  cmd: string | undefined,
  args: string[],
  env: Record<string, string | undefined>,
): string | undefined {
  const marker = workerMarker(false, env)
  if (!marker || !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || WORKER_VERBS.includes(cmd))
    return undefined
  if (cmd === 'rig' && ['list', 'show'].includes(args[0] ?? 'list')) return undefined
  return `a worker cannot run factory ${cmd === 'rig' ? `rig ${args[0]}` : cmd} (${marker}): mail the manager instead`
}

/**
 * claude-factory-mrfa: `factory file-elsewhere <target rig> --from <source rig>:<source id> (--title <t> | --title-file <path>) (--description <d> | --description-file <path>)`.
 * A -file flag (claude-factory-2z48) reads untrusted text from <FACTORY_HOME>/text/ or the real .scratch/ of the git worktree (see textFileArg).
 * The label `factory` goes on only when the source bead reads back with its own id and no Linear
 * `external_ref`. Any other read refuses the filing. A worker may file only from its own run's bead.
 */
function fileElsewhere(args: string[]) {
  const usage =
    'usage: factory file-elsewhere <target rig> --from <source rig>:<source id> (--title <t> | --title-file <path>) (--description <d> | --description-file <path>)'
  const [target, ...rest] = args
  const flags = new Map<string, string>()
  if (!target || target.startsWith('--') || rest.length !== 6) fail(usage)
  const pairs = new Set<string>()
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!
    const v = rest[i + 1]
    if (!['--from', '--title', '--title-file', '--description', '--description-file'].includes(k) || !v)
      fail(usage)
    // --title and --title-file are one pair: the same pair twice (or both forms) fails
    const pair = k.replace(/-file$/, '')
    if (pairs.has(pair)) fail(usage)
    pairs.add(pair)
    flags.set(k, v!)
  }
  for (const k of ['--title', '--description']) {
    const file = flags.get(`${k}-file`)
    if (file === undefined) continue
    const text = textFileArg(`${k}-file`, file)
    flags.set(k, text)
  }
  refuseControlChar('title', flags.get('--title')!)
  refuseControlChar('description', flags.get('--description')!, true)
  const [srcName, srcId, ...extra] = flags.get('--from')!.split(':')
  if (!srcName || !srcId || extra.length || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(srcId)) fail(usage)
  const rigNamed = (n: string) =>
    rigs().find(r => r.name === n)?.repo ?? fail(`no rig "${n}" in the factory ${HOME}`)
  const targetRepo = rigNamed(target!)
  const sourceRepo = rigNamed(srcName!)
  if (targetRepo === sourceRepo) fail(`${target} is the source rig: this files elsewhere only`)
  const marker = workerMarker()
  if (marker) {
    const own = process.env.FACTORY_RUN ? loadRun(process.env.FACTORY_RUN) : undefined
    if (!own || own.bead !== srcId || own.repo !== sourceRepo)
      fail(`a worker files only from its own run's bead (${marker}): use the File in line`)
  }
  const actor = process.env.BEADS_ACTOR || 'factory'
  const from = `${srcName}:${srcId}`
  let source: Bead | null
  try {
    source = beads(sourceRepo, actor).lookup(srcId!)
  } catch (e) {
    return fail(`cannot read ${from}, so nothing was filed: ${(e as Error).message}`)
  }
  if (source?.id !== srcId) fail(`${from} did not read back, so nothing was filed`)
  let id: string
  try {
    id = beads(targetRepo, actor).createFrom(
      !linearSourced(source!),
      flags.get('--title')!,
      `${flags.get('--description')!}\n\nFiled from ${from}.`,
      { discovered_from: srcId! },
    )
  } catch (e) {
    return fail(`nothing was filed: ${(e as Error).message}`)
  }
  try {
    beads(sourceRepo, actor).comment(srcId!, `filed ${id} in ${target}`)
  } catch (e) {
    return fail(
      `filed ${id} in ${target}, but the comment on ${from} failed (${(e as Error).message}): do not file it again`,
    )
  }
  console.log(id)
}

/** make dir a new factory (an empty rigs.json) and print how to work it; fails when it is one already */
function makeFactory(dir: string) {
  if (existsSync(join(dir, 'rigs.json'))) fail(`${dir} is already a factory: factory rig add, there`)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'rigs.json'), [])
  console.log(
    [
      `a new factory in ${dir}. Commands run in that directory work it; add its rigs there:`,
      `  cd ${sq(dir)} && ${sq(CLI)} rig add <name> <repo> [factory] [--max n] [--goal <what to work toward>]`,
      `and run its manager there: ${CLI} manager (fullscreen, so the console docks beside the chat; lean: no MCP servers, without herdr-fleet)`,
    ].join('\n'),
  )
}

/** the person and the manager run these verbs; a worker mails the manager instead. With patrol, a patrol (FACTORY_PATROL) must not run it either */
function refuseWorker(verb: string, patrol = false) {
  try {
    refuseWorkerIn(process.env, verb, patrol)
  } catch (e) {
    fail((e as Error).message)
  }
}

async function fork(id: string | undefined, station: string | undefined, note: string) {
  const { run: src, value } = current(id)
  const def = await loadPinned(src.factory)
  if (!Object.hasOwn(def.nodes, station ?? ''))
    fail(`usage: factory fork <run> <station> '[note...]'; stations: ${Object.keys(def.nodes).join(', ')}`)
  const sender = note ? managerSender(src) : undefined
  refuseWorker('fork') // managerSender lets FACTORY_FROM and FACTORY_RUN through for mail
  await assertRoom(src.repo)
  const run = await forkRun(src, value, def.name, station!, note, sender)
  await tick()
  console.log(`forked ${src.id} at ${station} into ${run.id}: branch ${run.branch} from ${src.branch}`)
}

/** why a fork of a run now at `node` would put a second run on its branch, or undefined when it is safe.
 * Safe: the source is done or aborted, or the last ABORT, GOTO or RETRY still queued in `pending` is an ABORT. */
export function forkRefusal(node: string, pending: Ev[], id = '<run>'): string | undefined {
  const last = pending.findLast(e => e.type === 'ABORT' || e.type === 'GOTO' || e.type === 'RETRY')
  if (last?.type === 'ABORT') return undefined
  if (last?.type !== 'GOTO' && (node === 'done' || node === 'aborted')) return undefined
  return `${id} is live at ${node}: a fork would put a second run on its branch. Run factory abort ${id}, then fork it again.`
}

/** a run of `src`'s factory that starts at `station` from `src`'s saved state, its bead a child of the source bead.
 * The note goes to the station as mail from `from` (none: no mail). It checks no worker, room or tick: the caller does. */
export async function forkRun(
  src: Run,
  value: Parameters<typeof where>[0],
  factoryName: string,
  station: string,
  note: string,
  from: 'manager' | 'factory' | undefined,
) {
  const saved = readJson<Saved>(join(runDir(src.id), 'state.json'))
  const pending = inboxLines(src.id)
    .slice(saved.cursor)
    .map(l => JSON.parse(l) as Ev)
  const why = forkRefusal(where(value)[0], pending, src.id)
  if (why) throw new Error(why)
  // a ship fork beside another live ship run would give the rig two ship runs (claude-factory-9wch)
  const other = otherLiveShip(src)
  if (other)
    throw new Error(
      `${other.run.id} is a live ship run on ${src.repo}: a fork of ${src.id} would put a second ship run on the rig. Run factory abort ${other.run.id}, then fork it again.`,
    )
  const bead = src.bead
    ? beads(src.repo, 'factory').create(
        `fork of ${src.bead}${note ? `: ${clip(note, 80)}` : ''}`,
        `${src.goal}\n\nForked from run ${src.id} at ${station}. ${note}`,
        ...['--deps', `related:${src.bead}`],
      )
    : undefined
  const { run } = await createTracked(
    src.factory,
    factoryName,
    src.repo,
    src.goal,
    bead,
    { run: src, saved },
    src.ship,
  )
  const [node, sub] = where(value)
  if (node !== station || sub !== 'working') post(run.id, { type: 'GOTO', node: station })
  if (from) post(run.id, { type: 'MAIL', from, to: station, text: note })
  return run
}

function current(id: string | undefined) {
  const run = loadRun(id)
  const saved = readJson<Saved>(join(runDir(run.id), 'state.json'))
  return { run, value: saved.snapshot.value, c: saved.snapshot.context }
}

const HERDR_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const AX_ADDRESS = /^ax:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * the last screen of the worker of a run (runs.screen): `herdr pane read` for a pane, one `ax ssh` for an ax://
 * task. It reads the saved worker address only, then checks it before any process starts. Throws a reason.
 */
async function screenRun(id: string | undefined) {
  const pane = current(id).c.pane as unknown
  if (pane === undefined || pane === null || pane === '') throw new Error(REASON.noWorker)
  if (typeof pane !== 'string') throw new Error(REASON.badAddress)
  if (AX_ADDRESS.test(pane)) return ax.screen(ax.taskOf(pane))
  if (!HERDR_ADDRESS.test(pane)) throw new Error(REASON.badAddress)
  const r = boundedRun([HERDR(), 'pane', 'read', pane, '--lines', '60'])
  if ('reason' in r) throw new Error(r.reason)
  return r.text
}

/** everything the manager's run view draws, in one read */
async function show(id: string | undefined) {
  const { run, value, c } = current(id)
  const def = await loadPinned(run.factory)
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

/** whether `glab` is signed in to a host (false when glab is not installed): how a self-hosted GitLab without "gitlab" in its name is told */
const glabKnows = (host: string) => {
  try {
    return Bun.spawnSync(['glab', 'auth', 'status', '--hostname', host]).exitCode === 0
  } catch {
    return false
  }
}

const prsFile = (id: string) => join(runDir(id), 'prs.json')

/** Check whether `id` is at a gate node now, working, with this exact gate visit's `startedAt`.
 * `gate-brief set` uses this check to refuse a stale key.
 * It also uses this check to prune old keys from `gate-briefs.json` (claude-factory-2u2). */
async function isLiveGateVisit(id: string, startedAt: number): Promise<boolean> {
  try {
    const { run, value, c } = current(id)
    const [node, sub] = where(value)
    if (sub !== 'working' || c.startedAt !== startedAt) return false
    return (await loadPinned(run.factory)).nodes[node]?.gate === true
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
  const def = await loadPinned(run.factory)
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
  if (workerMarker()) fail('a worker cannot set a gate brief: only the briefer may')
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
      ? clip(memory.tryRead(installedFile) ?? '', 16384)
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
  if (workerMarker()) fail('a worker cannot set a review: only the reviewer may')
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
      const def = await loadPinned(run.factory).catch(() => undefined)
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
        description: kind === 'owned' && isHandedOff(x) ? String(x.metadata?.owner_question) : x.description,
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
  const all = proposals()
  const stale = Object.keys(all).filter(k => staleProposal(k, rows))
  if (!stale.length) return { rigs: rows, proposals: all }
  // read again: a propose may have landed while the bd calls ran
  const fresh = proposals()
  for (const k of stale) delete fresh[k]
  writeJson(decisionsFile(), fresh)
  for (const k of stale) delete all[k]
  return { rigs: rows, proposals: all }
}

/** a stored proposal whose item is gone: its run is done, aborted or missing, or its bead is not open in its
 * rig. Unsure (bd failed for the rig, unreadable run state, an unknown key prefix) is not stale. */
function staleProposal(key: string, rows: DecisionsRow[]): boolean {
  const iv = /^iv:(.+)@[^@]*$/.exec(key)
  if (iv) {
    if (!runIds().includes(iv[1]!)) return true
    try {
      return ['done', 'aborted'].includes(where(current(iv[1]).value)[0])
    } catch {
      return false
    }
  }
  const m = /^(bd|own):([^:]+):(.+)$/.exec(key)
  if (!m) return false
  const row = rows.find(r => r.rig === m[2])
  if (!row) return true
  if (row.error) return false
  const kind = m[1] === 'bd' ? 'bead' : 'owned'
  return !row.beads.some(x => x.id === m[3] && x.kind === kind)
}

/** the person's answer to a bd decision: a human-flagged bead is answered and closed, an owner-only one just
 * gets a comment (queuing or starting it is a separate choice, made in the console or with start --owned) */
function decisionsAnswer(rigName: string, id: string, text: string, print: Print) {
  const b = beads(repoOf(rigName), 'factory/person')
  if (b.human().some(x => x.id === id)) b.respond(id, text)
  else b.comment(id, text)
  const all = proposals()
  const keys = [`bd:${rigName}:${id}`, `own:${rigName}:${id}`].filter(k => k in all)
  if (keys.length) {
    for (const k of keys) delete all[k]
    writeJson(decisionsFile(), all)
  }
  print(`answered ${id}`)
}

async function mailRun(
  m: { id: string | undefined; to: string | undefined; text: string; wake: boolean },
  who: { env: Env; cwd: string },
  print: Print,
) {
  const run = loadRun(m.id)
  const def = await loadPinned(run.factory)
  const workerFrom =
    who.env.FACTORY_FROM && who.env.FACTORY_FROM !== 'manager' ? who.env.FACTORY_FROM : undefined
  if (workerFrom !== undefined && !Object.hasOwn(def.nodes, workerFrom))
    fail('FACTORY_FROM must name a station of this factory')
  const boxes = Object.keys(def.nodes).concat('manager')
  if (!boxes.includes(m.to ?? '')) fail(`mailbox must be one of: ${boxes.join(', ')}`)
  post(run.id, {
    type: 'MAIL',
    from: workerFrom ?? managerSender(run, who.env, who.cwd),
    to: m.to!,
    text: cleanReport(m.text),
    ...(m.wake && { wake: true as const }),
  })
  print(`mailed ${m.to}`)
  const { c } = current(run.id)
  if (!m.wake && isMailHeld(c, m.to!, def.nodes[m.to!]?.holdMail)) {
    const last = c.log.at(-1)!
    const urls = [...prsIn(last.summary), ...mrsIn(last.summary)]
    const on = urls.length
      ? `parked on ${urls.join(', ')}; it starts a worker when one changes or`
      : `blocked twice in a row on the same wait; it starts a worker`
    print(
      `held for ${m.to}: ${on} at ${new Date(c.wakeAt).toISOString()}; add --wake only for an answer that changes the wait`,
    )
  }
}

async function gotoRun(id: string | undefined, node: string | undefined, print: Print) {
  const run = loadRun(id)
  const nodes = Object.keys((await loadPinned(run.factory)).nodes).concat('done')
  if (!nodes.includes(node ?? '')) fail(`node must be one of: ${nodes.join(', ')}`)
  const target = node!
  const saved = readJson<Saved>(join(runDir(run.id), 'state.json'))
  const pending = inboxLines(run.id)
    .slice(saved.cursor)
    .map(l => JSON.parse(l) as Ev)
  const queued = pending.find(e => e.type === 'GOTO')
  if (queued?.type === 'GOTO')
    fail(
      `a goto to ${queued.node} is queued since ${new Date(queued.at).toISOString()} and not applied yet: the next tick applies it. Do not repeat it; mail sent now reaches ${queued.node}`,
    )
  const why = gotoRefusal(await loadPinned(run.factory), saved.snapshot, pending, target, Date.now())
  if (why) fail(`goto ${target} would not move ${run.id}: ${why}`)
  // goto revives an ended ship run: refuse it beside another live ship run (claude-factory-9wch)
  const other =
    ['done', 'aborted'].includes(where(current(run.id).value)[0]) && target !== 'done'
      ? otherLiveShip(run)
      : undefined
  if (other)
    fail(
      `${other.run.id} is a live ship run on ${run.repo}: goto ${target} would revive ${run.id} as a second ship run on the rig. Run factory abort ${other.run.id}, then goto again.`,
    )
  post(run.id, { type: 'GOTO', node: target })
  print(`queued goto ${target} for ${run.id}: the next tick applies it`)
}

function abortRun(id: string | undefined) {
  post(loadRun(id).id, { type: 'ABORT' })
}

async function decideGate(id: string | undefined, outcome: string | undefined, note: string, print: Print) {
  const { run, value, c } = current(id)
  const [node, sub] = where(value)
  const n = (await loadPinned(run.factory)).nodes[node]
  if (!n?.gate || sub !== 'working') fail(`${run.id} is not at a gate (it is at ${node})`)
  const outcomes = Object.keys(n!.next)
  if (!outcomes.includes(outcome ?? '')) fail(`decision must be one of: ${outcomes.join(', ')}`)
  const summary = note || `${outcome}, decided by the person`
  post(run.id, { type: 'DONE', seq: c.seq, outcome: outcome!, summary })
  print(`decided ${outcome} at ${node} of ${run.id}`)
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
  if (workerMarker()) fail("a worker cannot propose the person's decisions: mail the manager instead")
  // claude-factory-72v.19: same second CLI-side layer as beadFor's isOwned check above. Only the
  // manager's own interview round proposes decisions; a patrol never does.
  if (process.env.FACTORY_PATROL) fail("a patrol cannot propose the person's decisions: leave it for them")
  if (/^gate:/.test(key)) fail('a gate is decided by the person, never proposed options')
  if (/^prompt:/.test(key)) fail('a blocked worker is looked at, never proposed options')
  if (!/^(iv|bd|own):/.test(key)) fail(`malformed decision key "${key}"`)
  if (/\n/.test(question)) fail('question has a newline: it must be one line')
  refuseControlChar('question', question)
  if (!question.trim()) fail('question is empty, or only whitespace')
  if (question.length > 160) fail(`question is ${question.length} characters, over the 160 limit`)
  if (context !== undefined && /\n/.test(context)) fail('context has a newline: it must be one sentence')
  if (context !== undefined) refuseControlChar('context', context)
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
  refuseControlChar('options', optionsLine)
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
  const kept = existsSync(file) ? parseRecords(readFileSync(file, 'utf8')) : []
  const live = startedRunIds().map(id => record(id))
  const liveIds = new Set(live.map(r => r.id))
  return [...kept.filter(r => !liveIds.has(r.id)), ...live]
}
/** claude-factory-7pxk: HOME/merged-prs.json caches the merged pull requests `factory metrics` matches to
 * handed-off runs. A merge is final, so `prs` only grows. `rigs[name]` says when gh was last asked and
 * from when merges are covered. The file rebuilds when deleted. */
type MergedCache = {
  rigs: { [rig: string]: { checkedAt: number; from: number } }
  prs: { [url: string]: { head: string; mergedAt: number } }
}
const mergedFile = () => join(HOME, 'merged-prs.json')
const MERGED_TTL_MS = 600_000
function readMerged(): MergedCache {
  const empty: MergedCache = { rigs: {}, prs: {} }
  try {
    const j = JSON.parse(readFileSync(mergedFile(), 'utf8'))
    return j && typeof j.rigs === 'object' && typeof j.prs === 'object' ? { rigs: j.rigs, prs: j.prs } : empty
  } catch {
    return empty
  }
}
const cachedMerges = (c: MergedCache) =>
  Object.entries(c.prs).flatMap(([url, p]) =>
    typeof p?.head === 'string' && Number.isFinite(p.mergedAt) ? [{ url, ...p }] : [],
  )

/** records with mergedAt set from the cache alone; no gh call */
const withMerges = (recs: RunRecord[]) => attachMerges(recs, cachedMerges(readMerged()))

/** `withMerges`, after one REST `pulls?state=closed&sort=updated` read for each GitHub rig that has a handed-off run the
 * cache does not match, at most once in 10 min. A gh failure prints one line and leaves the run handed-off.
 * GraphQL (`gh pr list --search`) has no owner in the path, so the AX gateway gave it the wrong key (claude-factory-oz6s).
 * A PR merged at or after `from` was updated at or after `from`, so the read stops after a page that ends before it.
 * ponytail: 10 pages (1000 PRs) cap one lookup; a capped read moves `from` to its last update time, so older merges stay unmatched. */
async function refreshMerges(recs: RunRecord[]): Promise<RunRecord[]> {
  const cache = readMerged()
  const open = withMerges(recs).filter(r => fate(r) === 'handed-off' && r.rig)
  const now = Date.now()
  let dirty = false
  for (const name of new Set(open.map(r => r.rig!))) {
    const rig = rigs().find(r => r.name === name)
    const seen = cache.rigs[name]
    if (!rig || originRef(rig.repo)?.forge !== 'github') continue
    if (seen && now - seen.checkedAt < MERGED_TTL_MS) continue
    const oldest = Math.min(...open.filter(r => r.rig === name).map(r => r.createdAt))
    const covered = !!seen && seen.from <= oldest
    const from = covered ? seen.checkedAt - 86_400_000 : oldest
    const ref = rigRef(rig.repo)
    let pullErr = ''
    const rows = ref
      ? await githubPulls(
          spawnGh,
          ref.slug,
          rig.repo,
          { state: 'closed', pages: 10, sort: 'updated', since: from },
          e => (pullErr = e),
        )
      : null
    if (!rows) {
      console.error(`merged-prs: gh api pulls failed for ${name}: ${pullErr.trim().split('\n')[0]}`)
      continue
    }
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    for (const x of rows) {
      const at = Date.parse(text(x.merged_at))
      const head = text((x.head as { ref?: unknown } | undefined)?.ref)
      if (at >= from && head && text(x.html_url)) cache.prs[text(x.html_url)] = { head, mergedAt: at }
    }
    const lastUpdated = Date.parse(text(rows.at(-1)?.updated_at))
    const reached = rows.length >= 1000 && lastUpdated >= from ? lastUpdated : from
    cache.rigs[name] = { checkedAt: now, from: covered ? Math.min(seen.from, reached) : reached }
    dirty = true
  }
  if (dirty) writeFileSync(mergedFile(), JSON.stringify({ version: 1, ...cache }))
  return withMerges(recs)
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

/** flows.show: the factory template of that name and its runs (the live runs that follow it, and kept records that fit its stations) */
async function flowData(name: string | undefined): Promise<{ def: Factory; runs: FlowRun[] }> {
  const spec = name ?? 'lifecycle'
  // ponytail: the template in ROOT/factories only. Upgrade path: a rig's own .factory/<name>.ts, once a rig is an input
  const file = findIn(join(ROOT, 'factories'), spec) ?? fail(`no factory "${spec}"`)
  const def = await loadFactory(file)
  const live: FlowRun[] = []
  for (const id of startedRunIds()) {
    const { run, value, c } = current(id)
    try {
      if (factoryLabelName(run, await loadPinned(run.factory)) !== spec) continue
      const [node, sub] = where(value)
      live.push({ id, node, sub, createdAt: createdAt(id), log: c.log })
    } catch {}
  }
  const ids = new Set(live.map(r => r.id))
  const kept: FlowRun[] = records()
    .filter(r => !ids.has(r.id) && r.log.length && r.log.every(e => e.node in def.nodes))
    .map(r => ({ id: r.id, node: r.node, sub: '', createdAt: r.createdAt, log: r.log, ended: true as const }))
  return { def, runs: [...live, ...kept] }
}

async function status(id: string | undefined, print: Print = l => console.log(l)) {
  const halt = halted()
  if (halt && !id)
    print(
      halt.state === 'paused'
        ? `PAUSED since ${clock(halt.at)}: ${Object.keys(halt.closed).length} worker(s) wait for factory resume`
        : `STOPPING since ${clock(halt.at)}: workers are committing and going quiet`,
    )
  const stale = !id && managerStale(HOME, managerCommand([], ''))
  if (stale) print(stale)
  if (!id && process.env.FACTORY_IN_AX === '1' && process.env.FACTORY_AX_BACKUP_REMOTE) {
    const age = backupAge(HOME, Date.now())
    const err = backupError(HOME)
    print(
      (age === undefined ? 'home backup: none yet' : `home backup: ${Math.round(age / 60_000)} min ago`) +
        (err ? `; last run failed: ${err}` : ''),
    )
  }
  if (!id && process.env.CURSOR_API_KEY) {
    await refreshCursorMeter(HOME)
    print(cursorLine(cursorMeter(HOME), cursorCap()))
  }
  if (!id && (grokSpent(HOME) > 0 || grokBudget() !== undefined))
    print(grokLine(grokSpent(HOME), grokBudget()))
  if (!runIds().length) print("no runs yet: factory start <factory> <repo> '<goal...>'")
  for (const runId of id ? [id] : startedRunIds()) {
    const { run, value, c } = current(runId)
    let r: Row
    try {
      const def = await loadPinned(run.factory)
      r = row(run, def, value, c, agentOf(def, value, c), tickError(runId))
    } catch (err) {
      print(`${runId}  error: pinned factory does not load: ${(err as Error).message.replace(/\s+/g, ' ')}`)
      continue
    }
    const at = r.sub ? `${r.node}/${r.sub}` : r.node
    print(`${r.id}  ${at}  try ${r.attempt}/${r.attempts}  pane ${r.pane ?? '-'} (${r.agent ?? '-'})`)
    // a bead's goal carries its whole description: bd show <bead> has it
    print(`  goal: ${clip(r.goal!.split('\n')[0]!, 200)}`)
    if (id) print(`  factory: ${run.factoryFrom ?? run.factory}`)
    if (r.error) print(`  error: ${r.error}`)
    if (id && run.bead) {
      const tasks = beads(run.repo, 'factory').children(run.bead)
      const closed = tasks.filter(t => t.status === 'closed').length
      print(`  bead: ${run.bead}, tasks ${closed}/${tasks.length} closed (bd children ${run.bead})`)
    } else if (run.bead) print(`  bead: ${run.bead}`)
    if (r.gate)
      print(
        `  gate: ${r.gate.question}\n  decide: factory decide ${r.id} <${r.gate.outcomes.join('|')}> '[note]'`,
      )
    const mail = Object.keys(c.mail).filter(box => unread(c, box).length)
    if (mail.length) print(`  unread: ${mail.map(box => `${box} ${unread(c, box).length}`).join(', ')}`)
    for (const e of id ? c.log : c.log.slice(-1))
      print(`  ${e.node}#${e.attempt} ${e.outcome}: ${cut(e.summary.replace(/\s+/g, ' '), 160)}`)
  }
  if (!id) {
    const ships = liveShipRuns()
    for (const [rig, queue] of Object.entries(shipQueues())) {
      const repo = rigs().find(r => r.name === rig)!.repo
      const live = ships.find(s => s.run.repo === repo)
      const lines = shipLines(queue, live && { id: live.run.id, node: live.node })
      if (lines.length) print(`rig ${rig}\n${lines.join('\n')}`)
    }
  }
}

/** each rig's ship queue, the next PR first; a rig whose bd cannot be read is left out */
/** the row of each started run, as `factory waiting` and `factory ui` read them */
const runRows = () =>
  Promise.all(
    startedRunIds().map(async id => {
      const { run, value, c } = current(id)
      try {
        const def = await loadPinned(run.factory)
        return row(run, def, value, c, agentOf(def, value, c))
      } catch (err) {
        return { id, error: `pinned factory does not load: ${(err as Error).message.replace(/\s+/g, ' ')}` }
      }
    }),
  )

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

const WIKI_RIG_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/**
 * One `factory wiki refresh` pass: write rigs/<rig>.md for each rig with a valid name and the rig list in
 * index.md, from the run rows, the ship queues and the merged-PR cache (no gh call). A run that cannot be
 * read is left out. With `dryRun` it only returns the changed paths. Else it first needs the checkout on main
 * (a left-over groom branch skips the pass) and pulls main of origin, then commits, pushes and journals.
 */
async function wikiRefresh(dryRun: boolean): Promise<string[]> {
  const dir = join(HOME, 'wiki')
  if (!dryRun) {
    // a groom pass that died leaves the checkout on its branch: refresh must not commit or push there
    if (wikiGit(dir, ['symbolic-ref', '-q', 'HEAD']).out.toString().trim() !== 'refs/heads/main')
      return (wikiLog('wiki: checkout not on main, refresh skipped'), [])
    pullWiki(dir)
  }
  const rows: RigRow[] = []
  for (const id of startedRunIds()) {
    try {
      const { run, value, c } = current(id)
      const def = await loadPinned(run.factory)
      rows.push({ ...row(run, def, value, c, agentOf(def, value, c)), createdAt: createdAt(id) })
    } catch (err) {
      console.error(`wiki refresh: run ${id} left out: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  const waitingIds = new Set(rows.filter(r => holdOf(r)).map(r => r.id))
  const queues = shipQueues()
  const merged = cachedMerges(readMerged())
  const now = Date.now()
  const files = new Map<string, string>()
  const names: string[] = []
  for (const rig of rigs()) {
    if (!WIKI_RIG_NAME.test(rig.name) || names.includes(rig.name)) {
      wikiLog('wiki: bad rig name, page skipped')
      continue
    }
    names.push(rig.name)
    const slug = rigRef(rig.repo)?.slug
    const mine = rows.filter(r => r.rig === rig.name)
    const shipped: Merged[] = merged
      .filter(m => slug && githubSlugOf(m.url) === slug)
      .map(m => ({
        url: m.url,
        mergedAt: m.mergedAt,
        title: (rows.find(r => `factory/${r.id}` === m.head)?.goal ?? m.head).replace(/^[\w.-]+: /, ''),
      }))
    files.set(
      `rigs/${rig.name}.md`,
      renderRigPage(rig.name, mine, waitingIds, queues[rig.name] ?? [], shipped, now),
    )
  }
  // an agent pass owns this worktree: a link or a non-regular file at a target would take a write outside it
  const kind = (p: string) => {
    try {
      const st = lstatSync(join(dir, p))
      return st.isFile() && st.nlink === 1 ? 'file' : st.isDirectory() ? 'dir' : 'bad'
    } catch {
      return 'none'
    }
  }
  const read = (p: string) => (kind(p) === 'file' ? readFileSync(join(dir, p), 'utf8') : '')
  files.set('index.md', rigList(read('index.md'), names))
  const rigsKind = kind('rigs')
  for (const p of [...files.keys()]) {
    const okDir = p.startsWith('rigs/') ? ['none', 'dir'].includes(rigsKind) : true
    if (!okDir || !['none', 'file'].includes(kind(p))) {
      files.delete(p)
      wikiLog('wiki: refused a link or a file that is not regular, page skipped')
    }
  }
  const changed = [...files.keys()].filter(p => files.get(p) !== read(p)).sort()
  if (dryRun) return changed
  for (const p of changed) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), files.get(p)!)
  }
  // stage only the pages written here: an empty list would stage the whole tree, and a person's edit with it
  if (changed.length)
    commitWiki('refresh', `${names.length} rig pages, ${changed.length} changed`, dir, changed)
  pushWiki(dir) // also retries an earlier failed push
  wikiLog(`wiki refresh: ${names.length} rig pages, ${changed.length} changed`)
  return changed
}

// shared between the help text below, the memory-case fallback usage error, and gate()'s own refusal
// message, so the three never drift apart (claude-factory-3u1.1.1)
const MEMORY_ADD_USAGE = `[--rig r] [--from run/station] --kind ${memory.NOTE_KINDS.join('|')} [--until <bead|owner/repo#N|YYYY-MM-DD>] [--anyway] [--supersedes <note path>] '<summary>' ('[body...]' | --body-file <path>)`

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

  start <factory>[@station] <rig|repo> '<goal...>'|bead [--owned]   new run: herdr worktree off the repo, first worker
                                     launched; --owned starts a bead carrying its owner's decisions, when they ask
  settings [list] | set <key> <value> | unset <key>   stored settings (HOME/settings.json): key, value, source; the environment wins; devenv.builder, devenv.token and devenv.push go to HOME/devenv.json
  image build [--target worker|manager]   build and push the AX worker (or manager) image; store it as ax.image (or ax.manager-image)
  token [list] | use <n> | best        Claude token slots: the live slot and each slot's 7d and 5h use; make slot n live, or the slot with the lowest 7d use
  init <dir>                         a new factory: a directory whose rigs and runs commands run in it work
  up [factory-dir] [manager args...] start a factory's manager in one step: install deps (not from a Nix store
                                     install), init a new dir, run the manager there (dir: the first arg, else
                                     FACTORY_HOME, else the platform data dir: XDG_DATA_HOME/claude-factory,
                                     else ~/Library/Application Support/claude-factory on macOS, else
                                     ~/.local/share/claude-factory)
  rig [add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--runner ${Object.keys(runners).join('|')}] [--agent cmd] [--mcp file] [--param name=value]... [--egress host[,host]...[=KEY[:Header:Prefix]]]... [--linear team_id[,team_id] [--linear-projects name[,name]] [--linear-labels name[,name]]] [--goal '<text...>'] | set <name|repo> [--goal '<text...>'] [--max n] [--sweeps a,b|none] [--runner r] [--agent cmd] [--mcp file] [--param name=value]... [--cluster-runs n] [--auto-queue p,n|off] [--push-rule text|none]... [--sensitive-path path|none]... [--skills a,b|none] [--otel-content on|off] [--sandbox-class gvisor|microvm] | env set|unset <name|repo> KEY[=VALUE] | egress add|rm <name|repo> host[,host]...[=KEY[:Header:Prefix]] [--port n] [--path-prefix /path/]... | beads-remote set <name|repo> --name n --url u --user user|clear <name|repo> | show <name|repo> | rm <name> | history | undo [n]]   the factory's
                                     rigs: repos whose ready beads labeled factory start as runs, each with its
                                     own cap, sweeps, runner (where workers run) and a goal the manager works toward; --agent runs every
                                     station as that command (claude, codex, cursor, grok or pi), --mcp gives its workers
                                     the MCP servers in a Claude-shaped mcpServers file; --egress (repeatable, runner ax) lets the VM reach
                                     those hosts, injecting the agent-vault credential KEY for them; --linear opts the rig into the
                                     Linear pull loop, for these Linear team ids; --linear-projects and --linear-labels route an issue of
                                     a matching project or label name to this rig (needs --linear too)
  linear [rig...] [--force]         pulls each opted-in rig's Linear issues into its beads now, instead of waiting for
                                     the next 20-minute window
  adopt <rig|repo> [template]        copy a factory into <repo>/.factory/ for the repo to own and improve
  queue <rig|repo> <bead> [station]  hand a bead to the factory (labels it factory)
  file-elsewhere <rig> --from <rig>:<bead> (--title <t> | --title-file <path>) (--description <d> | --description-file <path>)  file a bead in another rig; labels it factory unless the source is Linear
  ship <rig|repo>                    the rig's ship queue: the next PR to merge first, then the others
  show <run> | backlog | prs        JSON for the manager's views
  decisions [answer <rig> <bead> '<text...>' | propose <key> '<question>' '<a | b>' | propose <key> --question-file <p> --options-file <p> [--context-file <p>]]   JSON of every rig's open
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
  ci <pr>                            the PR's checks on its head SHA; each failed job's step and log tail
                                     (exit 0 green, 1 failed, 2 pending, 3 error)
  parity                             each gap bead in parity-gaps.json is still open (the pre-push hook runs it)
  check <factory file>               validate a factory: graph, outcomes, a way to done from every station
  mutate [--timeout s] <file[:line]> <old> <new> -- <test argv...>   apply one literal edit, run the test, restore the file;
                                     exit 0 killed, 1 survived, 2 refused, 3 timeout, 4 restore failed
  status [run]                       runs at a glance, or one run's full log
  waiting                            everything that waits on the person, by rig, and how to answer each
  digest                             per rig: beads by state, the owner queue, recent repairs, PRs to merge in order
  manager chat --codex               a Codex chat here, for when the manager's Claude is limited
  manager [claude args...]           start this factory's manager here, lean: Bash and file tools, no MCP servers
  attach [--follow]                  the AX manager's pane, read over ax ssh; --follow redraws every 3 s
                                     (no keyboard: ax ssh has no stdin or TTY; docs/remote-runner.md)
  attach --ssh-config                print the ssh config Host block for herdr --remote <AX manager task>
  say '<text...>'                    type text and Enter into the AX manager's pane
  home                               the factory these commands work: FACTORY_HOME, else found from here
  stop | resume                      graceful shutdown: workers commit and wait, their panes close, nothing
                                     launches or dispatches; resume brings each back in its own conversation
  memory search [--rig r] '<query...>'  the closest notes in the factory's shared memory (semantic search)
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
  cert person <dir> <server-name>     make the person CA, person and server certificates for the client API (new folder, 0700)
  tick | loop [--interval ms]        advance every run once, or forever (default 5s), keeping the rigs' sweeps running
                                     (tick --keep-mail saves the tick and the manager's mail for patrol --once)
  herdr install [--app-home <dir>]   copy the Herdr app manager mod and its layout into the app folder
  lease [status|release]             who holds the local manager lease (only its holder ticks); release it
  patrol --once                      one headless manager patrol: answers the kept mail and works the board
  pm --once | brief --once | review --once [--codex <model> | --fallback]   one headless pm, gate-brief or skill/proposal review
  report <run> <seq> <outcome> '<summary...>'|--summary-file path   worker: finish its station
  worker serve [--model m] | poll <cursor> | prompt <base64>   inside an AX task: the worker's Claude, its
                                     state and outbox, a prompt queued for it (docs/remote-runner.md)
  ui [--port 4792] [--no-sync]       a local web page (127.0.0.1) of every rig's beads and epic progress (docs/ui.md)
  pkg-gate serve [--port 8080]       an age-gating registry proxy for go/npm/pypi (PKG_GATE_MIN_DAYS,
                                     PKG_GATE_ALLOWLIST_GO/_NPM/_PYPI colon-separated, one per ecosystem);
                                     GET /healthz for its counters
  decide <run> <outcome> '[note...]' the person: answer a gate station
  mail <run> <node|manager> [--wake] '<text...>'|--text-file path  drop a message in a mailbox; --wake starts a worker at a held PR park or an outage hold
  poke <run> '[text...]'             nudge the current station's worker: report, or say what blocks it
  retry <run> | goto <run> <node|done> | abort <run>   quarterback a run
  unhold <runner> [--codex]          after a token swap by hand: wake the stations that runner's usage limit holds, as far as slots are free
  fork <run> <station> '[note...]'   new run from <run>'s branch and state, restarted at <station>
  rm <run>                           finished run: drop its worktree and state, keep its branch
  gc [--days N] [--dry-run]          done or aborted runs older than N days (default 7, FACTORY_GC_DAYS):
                                     remove the whole run as rm does (worktree, state; the branch stays,
                                     its record goes to metrics.jsonl; refusals go to gc.log) and a dead
                                     launch script; --dry-run prints eligible runs without removal and can write gc.stamp (each tick
                                     starts one, at most hourly, FACTORY_GC_MS; FACTORY_GC=0 turns it off)
  gc --worktrees [--dry-run] [--rig NAME]   finished runs: drop a worktree, and its factory/* branch
                                     once it is merged, or its PR is closed and its bead is closed;
                                     never a live run or a branch that fails these rules; --dry-run only prints
                                     what it would remove, without a stamp or journal (each tick starts one, at most daily,
                                     FACTORY_GC_WORKTREES_MS; FACTORY_GC_WORKTREES=0 turns it off)
                                     Both gc forms use gc.run locally or POST /v1/gc in server mode.
                                     Use each flag once. Do not mix --days with --worktrees or --rig with plain gc.
  sweep                              one run per due (rig, sweep) pass, under factory "sweeps"
                                     (factories/sweeps.ts), parked at that station; writes
                                     sweeps.json and sweeps.jsonl (each tick starts one, at most
                                     every FACTORY_SWEEP_MS (default 300000); FACTORY_SWEEPS=0 turns
                                     it off)

<factory> is a path, or a name: the repo's own .factory/<name>.ts as of the base commit of the run (never a PR branch's),
else the template in ${join(ROOT, 'factories')}. Each run pins its factory. This factory is ${HOME}
(FACTORY_HOME, else the nearest directory up holding a rigs.json, else the default home in up). start and fork refuse past FACTORY_MAX_RUNS (${MAX_BUSY}) runs holding a worker,
or past the rig's own --max.
In a repo with .beads, every run works a bead: the one its goal names, or a new one.`

// claude-factory-6g6ud: a gated kind from the main chat needs the person's one-time Allow token
function mainChatGateRefusal(): string | undefined {
  if (cmd === 'server' && process.env.FACTORY_MAIN_CHAT)
    return 'refused: FACTORY_MAIN_CHAT is set; start the server from your own shell'
  const kind = mainChatKind(cmd, args)
  return kind && mainChatRefusal({ ...process.env, FACTORY_ALLOW: ALLOW_TOKEN }, HOME, kind)
}
{
  const why = import.meta.main
    ? (otherRunRefusal(cmd, args, process.env) ??
      workerVerbRefusal(cmd, args, process.env) ??
      mainChatGateRefusal())
    : undefined
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
let queuedArgs = args
if (outboxCmd)
  try {
    queuedArgs = fileArgs(cmd!, args)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(cmd === 'memory' ? 2 : 1)
  }
const outboxOk = outboxCmd ? worker.outboxUsage(cmd!, queuedArgs) : null
if (outboxOk === 'help')
  console.log(
    worker.OUTBOX_USAGE[
      cmd === 'memory' ? (args[0] === 'helped' ? 'helped' : 'memory') : cmd === 'mail' ? 'mail' : 'report'
    ],
  )
else if (outboxOk) {
  console.error(outboxOk)
  process.exit(cmd === 'memory' && args[0] === 'add' ? 2 : 1)
}
const queued = outboxCmd && outboxOk === null
const tooBig = queued ? worker.outboxTooBig([cmd!, ...queuedArgs]) : undefined
if (tooBig) {
  console.error(
    `refused: this ${cmd} is ${tooBig} bytes; the factory takes at most ${worker.OUTBOX_MAX_BYTES} bytes (100 KiB) in one command: shorten the text and run it again`,
  )
  process.exit(1)
}
if (queued) {
  // the station's bd writes go to GitHub before the report, so the laptop has them when it acts on it; a
  // report that went without them would end the VM, and its writes with it
  if (cmd === 'report') {
    const sync = worker.syncBeads()
    if (!sync.ok && worker.isSchemaSkew(sync)) {
      // no retry fixes a VM whose bd is too old for the store: the report goes out, and the laptop holds the station
      worker.queue([cmd!, ...queuedArgs], worker.usageOfSession(args[0]!), sync.error, worker.startRecord())
      console.log(
        `queued for the factory: report; bd could not sync (schema skew: ${sync.error}), so the factory holds this station for the person; you are done, stop now`,
      )
      process.exit(0)
    }
    if (!sync.ok) {
      console.error(
        `refused: your bd changes were not shared (bd dolt ${sync.step} failed: ${sync.error}); run bd ` +
          `dolt pull && bd dolt push to see the full error; if it fails again, factory mail ${args[0]} ` +
          `manager with that error and do not report until the manager answers`,
      )
      process.exit(1)
    }
  }
  worker.queue(
    [cmd!, ...queuedArgs],
    cmd === 'report' ? worker.usageOfSession(args[0]!) : undefined,
    undefined,
    cmd === 'report' ? worker.startRecord() : undefined,
  )
  console.log(`queued for the factory: ${cmd}${cmd === 'report' ? '; you are done, stop now' : ''}`)
}

// claude-factory-akiq.6: with FACTORY_SERVER set, a manager's CLI call goes to the server (src/client.ts); a worker keeps the local path
if (import.meta.main && !outboxCmd && client.serverMode(process.env)) {
  let sent: number | null
  try {
    const remoteArgs = cmd === 'mail' ? fileArgs('mail', args) : args
    if (cmd === 'mail' && args[2] === '--text-file') remoteArgs.splice(2, 0, '--')
    sent = await client.main(cmd, remoteArgs, process.env)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
  if (sent !== null) process.exit(sent)
}

/** the helpers of this file that the catalog operations call (src/core/ops) */
export const corePort: Port = {
  gcPass,
  gcWorktreesPass,
  gcRigs: () => rigs().map(r => r.name),
  gcHold: hold,
  gcStamp: name => writeFileSync(join(HOME, name), ''),
  show,
  status,
  backlog,
  prs,
  decisionsList,
  planShowText,
  gateBriefFacts,
  records,
  flowData,
  refreshMerges,
  managerUsage,
  rigList: rigListLines,
  decide: decideGate,
  decisionsAnswer,
  goto: gotoRun,
  abort: abortRun,
  screen: screenRun,
  mail: mailRun,
  chatModel: runModelAsync,
}
const cliCtx = (): OpCtx => ({
  home: HOME,
  env: process.env,
  port: corePort,
  board: () => null,
  cli: () => fail('no CLI runner in the CLI'),
})
/** the input of an op from CLI words: a missing word leaves its key out */
const defined = (o: Record<string, string | boolean | undefined>): OpInput =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as OpInput
const emit = (r: OpResult) => {
  process.stdout.write(r.out)
  process.stderr.write(r.err)
  process.exitCode = r.code
}

if (import.meta.main && !outboxCmd)
  try {
    switch (cmd) {
      case 'worker': {
        const [sub, arg] = args
        if (sub === 'serve') await worker.serve(arg === '--model' ? args[2] : undefined)
        else if (sub === 'poll') console.log(JSON.stringify(worker.poll(Number(arg ?? 0))))
        else if (sub === 'screen' && args.length === 1) process.stdout.write(worker.screen())
        else if (sub === 'usage' && args.length === 1) console.log(JSON.stringify(worker.usageOfSession('')))
        else if (sub === 'prompt' && arg) worker.prompt(arg)
        else if (sub === 'put' && args.length === 5)
          worker.put(arg!, Number(args[2]), Number(args[3]), args[4]!)
        else
          fail(
            'usage: factory worker serve [--model m] | poll <cursor> | usage | screen | prompt <base64> | put <name> <part> <parts> <base64>',
          )
        break
      }
      case 'ui': {
        const portIdx = args.indexOf('--port')
        const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4792
        if (!Number.isInteger(port) || port < 0) fail(`--port "${args[portIdx + 1]}" is not a number`)
        const found = withBeads(rigs())
        if (!found.length) fail(`no rig with a .beads directory in ${rigsFile()}`)
        const ui = startUi({
          rigs: found,
          port,
          sync: !args.includes('--no-sync'),
          cacheDir: join(HOME, 'ui-cache'),
          runNeeds: async () => waitingItems(await runRows(), shipQueues()),
        })
        console.log(`factory ui on http://127.0.0.1:${ui.server.port} for ${found.length} rigs`)
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
        refuseWorker('start')
        const words = args.slice(2)
        await start(args[0], args[1], words.filter(w => w !== '--owned').join(' '), words.includes('--owned'))
        break
      }
      case 'fork':
        if (args.length < 3) refuseWorker('fork') // a fork with a note is refused by managerSender
        await fork(args[0], args[1], args.slice(2).join(' '))
        break
      case 'tick': {
        refuseWorker('tick', true)
        // --board (claude-factory-hpmc.14): the board with no tick and no lease, for a remote view
        if (args[0] === '--board') {
          const full = await readOnlyBoard(
            leases.readLease(HOME) ?? { holder: 'none', kind: 'none', at: Date.now() },
          )
          console.log(JSON.stringify(args.includes('--slim') ? slimBoard(full) : full))
          break
        }
        lease()
        const other = localLease()
        if (other) {
          console.log(JSON.stringify(await readOnlyBoard(other)))
          break
        }
        const out = await tick(true)
        if (args.includes('--keep-mail')) keepTick(HOME, out) // for patrol --once
        console.log(JSON.stringify(out))
        break
      }
      case 'patrol':
      case 'pm':
      case 'brief': {
        refuseWorker(cmd, true)
        if (!args.includes('--once'))
          fail(`usage: factory ${cmd} --once${cmd === 'patrol' ? '' : ' [--codex <model> | --fallback]'}`)
        lease()
        // only the lease holder patrols (claude-factory-s01d.2)
        const other = localLease()
        if (other) fail(`no ${cmd}: ${leases.leaseLine(other, Date.now())}`)
        console.log(await onceCmd(cmd, args))
        break
      }
      case 'chat-guard': {
        const r = guardHook(await Bun.stdin.text())
        if (r.err) process.stderr.write(r.err)
        process.exitCode = r.code
        break
      }
      case 'patrol-guard':
        await patrolGuard()
        break
      case 'lease': {
        refuseWorker('lease', true)
        if (args[0] === 'release' && args.length === 1) {
          leases.release(HOME)
          console.log('released the manager lease')
        } else if (!args.length || (args[0] === 'status' && args.length === 1))
          emit(await leaseOp.show(cliCtx(), {}))
        else fail('usage: factory lease [status|release]')
        break
      }
      case 'beads':
        refuseWorker('beads')
        await beadsPass()
        break
      case 'watch':
        refuseWorker('watch')
        await watchPass()
        break
      case 'sync':
        refuseWorker('sync')
        await syncPass()
        break
      case 'broker':
        broker.main(args)
        break
      case 'server':
        refuseWorker('server', true)
        if (args[0] === 'backup') {
          if (args.length > 1) fail('usage: factory server backup')
          await serverBackup()
          break
        }
        lease()
        const backup = () => {
          const p = Bun.spawn([CLI, 'server', 'backup'], {
            stdout: 'inherit',
            stderr: 'inherit',
            env: kickEnv(process.env, HOME),
          })
          return p.exited.then(c => {
            if (c !== 0) throw new Error(`exit ${c}`)
          })
        }
        server.main(args, HOME, () => tick(), corePort, backup)
        break
      case 'cert': {
        refuseWorker('cert', true)
        const [what, dir, name, ...more] = args
        if (what !== 'person' || !dir || !name || more.length)
          fail('usage: factory cert person <dir> <server-name>')
        try {
          const out = personCerts(resolve(dir!), name!)
          console.log(out)
        } catch (e) {
          fail((e as Error).message)
        }
        break
      }
      case 'manager':
        refuseWorker('manager', true)
        if (args[0] === 'host') {
          await managerhost.host(args.slice(1), { prepare: reposSync, lock: () => hold('tick.lock') })
          break
        }
        if (args[0] === '--ax') {
          await launchAxManager(args.slice(1))
          break
        }
        if (args[0] === 'chat') {
          // the manager's chat on Codex, for when every Claude slot is at its limit (claude-factory-y3f8w.4)
          if (args.length !== 2 || args[1] !== '--codex') fail('usage: factory manager chat --codex')
          const l = codexChatLaunch({ cli: CLI, home: HOME, env: process.env })
          process.exit(
            await Bun.spawn(l.argv, { cwd: l.cwd, env: l.env, stdio: ['inherit', 'inherit', 'inherit'] })
              .exited,
          )
        }
        lease()
        // ponytail: blocks until the manager exits; run it where it should live (a herdr pane)
        process.exit(await superviseManager(args))
      case 'herdr': {
        refuseWorker('herdr', true)
        const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
        const flags = ['--app-home', '--machine', '--home']
        const bad =
          args[0] !== 'install' ||
          args.length !== 1 + 2 * flags.filter(k => args.includes(k)).length ||
          flags.some(k => args.includes(k) && !opt(k)) ||
          (!!opt('--machine') && !/^[A-Za-z0-9._-]+$/.test(opt('--machine')!))
        if (bad) fail('usage: factory herdr install [--app-home <dir>] [--machine <name> [--home <path>]]')
        const repo = resolve(import.meta.dir, '..')
        const app = opt('--app-home') ? resolve(opt('--app-home')!) : herdrApp.appHomeOf(process.env)
        const machine = opt('--machine')
        // a remote home is a path on the machine: do not resolve it here
        const home = machine
          ? (opt('--home') ?? herdrApp.REMOTE_HOME)
          : opt('--home')
            ? resolve(opt('--home')!)
            : HOME
        if (machine && !home.startsWith('/')) fail('--home must be an absolute path on the machine')
        if (!machine) {
          const why = herdrApp.localRefusal(home, ax.remoteManager(), leases.readLease(home), Date.now())
          if (why) fail(why)
        }
        const out = herdrApp.install(
          repo,
          app,
          machine ? { cli: herdrApp.REMOTE_CLI, home, machine } : { cli: join(repo, 'bin', 'factory'), home },
        )
        console.log(
          `installed the factory mod in ${out.mod} and the layout in ${out.layout}, for the home ${home}${machine ? ` on ${machine} (view and control only: no tick, no lease)` : ''}`,
        )
        console.log("in the Herdr app, run layout.switch {name: 'factory'} to show it")
        break
      }
      case 'home':
        console.log(HOME)
        break
      case 'repos': {
        if (args[0] === 'bd-env') {
          // claude-factory-d289.26: the manager model's shell evals this before its bd, in the cwd it has then
          const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stderr: 'ignore' })
          for (const [k, v] of Object.entries(
            bdExports(top.success ? top.stdout.toString().trim() : undefined),
          ))
            console.log(`export ${k}=${sq(v)}`)
          break
        }
        if (args[0] !== 'sync') fail('usage: factory repos sync | factory repos bd-env')
        const problems = reposSync()
        if (problems.length) fail(problems.join('\n'))
        console.log(`repos in place under ${process.env.FACTORY_REPOS ?? '/workspace/w/repos'}`)
        break
      }
      case 'migrate-to-ax':
        refuseWorker('migrate-to-ax', true)
        await migrateToAx(args)
        break
      case 'attach': {
        refuseWorker('attach', true)
        if (args[0] === '--ssh-config' && args.length === 1) {
          // the Host block for ~/.ssh/config, then `herdr --remote <task>` (docs/remote-runner.md)
          console.log(ax.sshConfigBlock())
          break
        }
        const follow = args[0] === '--follow'
        if (args.length > (follow ? 1 : 0)) fail('usage: factory attach [--follow | --ssh-config]')
        for (;;) {
          const pane = ax.attachRead()
          console.log(follow ? `\x1b[2J\x1b[H${pane}` : pane)
          if (!follow) break
          await new Promise(r => setTimeout(r, 3000))
        }
        break
      }
      case 'say':
        refuseWorker('say', true)
        if (!args.length) fail("usage: factory say '<text...>'")
        ax.say(args.join(' '))
        break
      case 'stop': {
        refuseWorker('stop', true)
        if (halted()) fail(`already ${halted()!.state}`)
        writeJson(haltFile(), { state: 'stopping', at: Date.now(), told: {}, closed: {} })
        console.log(
          `stopping: each working worker is told to commit and wait; its pane closes once it is quiet, at most ${HALT_GRACE_MS / 60_000} min. Ticks carry it out; factory status shows it. factory resume brings them back.`,
        )
        break
      }
      case 'resume': {
        refuseWorker('resume', true)
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
        if (args[0] === 'add')
          try {
            args.splice(0, args.length, ...fileArgs('memory', args))
          } catch (e) {
            console.error(`factory memory add: ${(e as Error).message}`)
            console.error(`usage: factory memory add ${MEMORY_ADD_USAGE}`)
            process.exitCode = 2
            break
          }
        const opt = (flag: string) =>
          args.includes(flag) ? args.splice(args.indexOf(flag), 2)[1] : undefined
        // Capture this before opt('--supersedes') below runs. Otherwise a bare trailing flag (no
        // value) looks the same as a caller who never passed --supersedes at all.
        const hasSupersedes = args.includes('--supersedes')
        // `search --no-core`: the launch brief already prints CORE.md in full
        const noCore = args.includes('--no-core')
        if (noCore) args.splice(args.indexOf('--no-core'), 1)
        const [rig, from, kind, until, supersedesArg] = [
          opt('--rig'),
          // claude-factory-67bw: --from lands in frontmatter, so an LF would add a line
          opt('--from')?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '),
          opt('--kind'),
          opt('--until'),
          opt('--supersedes'),
        ]
        const [sub, ...words] = args
        if (sub === 'search' && words.length) {
          // a VM has no store: the laptop put a snapshot (memory.tgz) in the worker dir at launch (vffe.4)
          const snap = join(worker.own(), 'memory.tgz')
          if (!existsSync(MEMORY) && existsSync(snap)) {
            const tmp = `${MEMORY}.tmp-${process.pid}`
            mkdirSync(tmp, { recursive: true })
            const r = Bun.spawnSync(['tar', '-xzf', snap, '--no-same-owner', '-C', tmp], { stderr: 'pipe' })
            try {
              if (r.exitCode !== 0) throw new Error('tar failed')
              renameSync(tmp, MEMORY)
            } catch {
              rmSafe(tmp, { recursive: true, force: true }) // a cut file, or another search won the rename
            }
          }
          const found = await memory.search(MEMORY, words.join(' '), { rig, core: !noCore })
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
          // a --word left after the opt() splices (typo, repeat, flag an older bin lacks) would become the
          // summary and false-dedupe against the next such add (claude-factory-4ie)
          const stray = words.find(w => w.startsWith('--') && w !== '--anyway')
          if (stray) {
            console.error(`factory memory add: unknown flag ${stray}`)
            console.error(`usage: factory memory add ${MEMORY_ADD_USAGE}`)
            process.exitCode = 2
            break
          }
          const isAnyway = words.includes('--anyway')
          const [summary, ...body] = words.filter(w => w !== '--anyway')
          // claude-factory-67bw: a replayed worker add reaches the store, so strip as report does.
          // A rig with LF would add a frontmatter line, so it loses LF and TAB too.
          const note = {
            summary: cleanReport(summary!),
            body: cleanReport(body.join(' ')),
            rig: rig && cleanReport(rig).replace(/[\n\t]/g, ' '),
            kind,
            until,
          }
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
          // a VM search prints its own memory dir; the outbox replays that path here (vffe.4)
          const vmDir = `${ax.OWN}/home/memory/`
          const paths = words.map(w =>
            memory.resolvePath(
              MEMORY,
              relative(MEMORY, resolve(MEMORY, w.startsWith(vmDir) ? w.slice(vmDir.length) : w)),
            ),
          )
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
                memory.planLines(decisions, { archiveCap, historyDays }).join('\n'),
                ...(decisions.length ? [] : ['nothing to merge or archive']),
                ...skipped.map(s => `skip  ${s.topic}: ${s.reason}`),
                ...overCap.map(o => `over  ${o.topic}: ${o.count} short notes, cap ${topicCap}`),
              ].join('\n'),
            )
          } else {
            refuseWorker('memory compact')
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
              if (!existsSync(join(MEMORY, '.git'))) memGit('init', '-q')
              if (!repoConfigOk(MEMORY)) {
                memoryRefused()
                process.exitCode = 1
                break
              }
              const filesBefore = memory.mdFileCount(MEMORY)
              // the plan reaches dream.log before applyTiers writes or removes anything (claude-factory-503.2)
              const tiers = memory.applyTiers(MEMORY, {
                untilDeps: untilDeps(),
                onPlan: lines => appendFileSync(join(HOME, 'dream.log'), lines.join('\n') + '\n'),
              })
              // runs before the commit, so its .usage.jsonl/.renames.jsonl writes land inside it and
              // the repo stays clean right after (claude-factory-503.3)
              memory.compact(MEMORY, tiers.renamed)
              memGit('add', '-A')
              const message = compactMessage(tiers, filesBefore, memory.mdFileCount(MEMORY))
              memGit('commit', '-q', '--allow-empty', '-m', message)
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
            `usage: factory memory search [--rig r] '<query...>' | add ${MEMORY_ADD_USAGE} | helped [--from run/station] <note path...> | compact [--dry-run] | eval [--self [n] [--seed s]]`,
          )
        break
      }
      case 'wiki': {
        refuseWorker('wiki', true)
        if (args[0] === 'find') {
          if (args.length !== 2) {
            console.error('usage: factory wiki find <bead|pr|word>')
            process.exitCode = 2
          } else {
            const release = hold('wiki.lock')
            if (!release) {
              console.error('wiki: busy')
              process.exitCode = 1
              break
            }
            try {
              process.exitCode = wikiFind(args[1]!)
            } finally {
              release()
            }
          }
          break
        }
        if (args[0] === 'status') {
          if (args.length !== 1) {
            console.error('usage: factory wiki status')
            process.exitCode = 2
          } else {
            const release = hold('wiki.lock')
            if (!release) {
              console.error('wiki: busy')
              process.exitCode = 1
              break
            }
            try {
              console.log(JSON.stringify(wikiStatus()))
            } finally {
              release()
            }
          }
          break
        }
        if (args[0] === 'refresh') {
          const dry = args[1] === '--dry-run'
          if (args.length > (dry ? 2 : 1)) {
            console.error('usage: factory wiki refresh [--dry-run]')
            process.exitCode = 2
            break
          }
          const release = hold('wiki.lock')
          if (!release) {
            console.log('wiki: busy')
            break
          }
          try {
            if (!existsSync(join(HOME, 'wiki', '.git')))
              console.log('wiki: not set up: run factory wiki init')
            else {
              const paths = await wikiRefresh(dry)
              if (dry) console.log(paths.join('\n'))
            }
          } finally {
            release()
          }
          break
        }
        if (args[0] === 'groom') {
          const dry = args[1] === '--dry-run'
          if (args.length > (dry ? 2 : 1)) {
            console.error('usage: factory wiki groom [--dry-run]')
            process.exitCode = 2
            break
          }
          const release = hold('wiki.lock')
          if (!release) {
            console.log('wiki: busy')
            break
          }
          try {
            if (!existsSync(join(HOME, 'wiki', '.git')))
              console.log('wiki: not set up: run factory wiki init')
            else wikiGroom(dry)
          } finally {
            release()
          }
          break
        }
        const i = args.indexOf('--remote')
        const remoteArg = i < 0 ? undefined : args[i + 1]
        const rest = i < 0 ? args : args.filter((_, j) => j !== i && j !== i + 1)
        const url = remoteArg ?? process.env.FACTORY_WIKI_REMOTE
        const remote = url ? wikiRemote(url) : undefined
        if (rest.length !== 1 || rest[0] !== 'init' || (i >= 0 && !remoteArg) || remote === null) {
          console.error('usage: factory wiki init [--remote <url>]')
          process.exitCode = 2
          break
        }
        const release = hold('wiki.lock')
        if (!release) {
          console.log('wiki: busy')
          break
        }
        try {
          const dir = join(HOME, 'wiki')
          mkdirSync(dir, { recursive: true })
          // the ceiling in wikiGit stops the search at the wiki dir, so a repo in a parent is never used
          const isRepo = () => wikiGit(dir, ['rev-parse', '--git-dir']).code === 0
          if (!isRepo()) {
            wikiGit(dir, ['init', '-q'])
            wikiGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
          }
          if (!isRepo()) {
            wikiLog('wiki: git init failed')
            process.exitCode = 1
            break
          }
          const seeds = Object.entries(WIKI_SEEDS).filter(([name, text]) => {
            if (wikiNewFile(join(dir, name), text) !== 'bad') return true
            wikiLog(`wiki: ${name} is not a regular file, seed not written`)
            process.exitCode = 1
            return false
          })
          if (
            seeds.length &&
            commitWiki(
              'init',
              'seed index and glossary',
              dir,
              seeds.map(([n]) => n),
            ) === false
          ) {
            process.exitCode = 1
            break
          }
          if (remote && url) {
            if (!wikiAllowed(remote, true)) {
              process.exitCode = 1
              break
            }
            const has = wikiGit(dir, ['config', '--get', 'remote.origin.url']).code === 0
            wikiGit(dir, ['remote', has ? 'set-url' : 'add', 'origin', url])
            if (!pushWiki(dir)) process.exitCode = 1
          }
        } finally {
          release()
        }
        break
      }
      case 'dream':
        refuseWorker('dream')
        console.log(await dream())
        break
      case 'parity': {
        if (args.length) {
          console.error('usage: factory parity')
          process.exit(2)
        }
        const show = (id: string) => {
          try {
            const p = Bun.spawnSync(['bd', 'show', id, '--json'], { cwd: ROOT, timeout: 30_000 })
            const err = p.exitCode === null ? 'timed out after 30 s' : p.stderr.toString()
            return { code: p.exitCode ?? 1, out: p.stdout.toString(), err }
          } catch (e) {
            return { code: 1, out: '', err: (e as Error).message }
          }
        }
        process.exit(parity({ file: GAPS_FILE, show, print: l => console.log(l) }))
      }
      case 'pg-scratch':
        process.exit(pgScratch(args, { cwd: process.cwd(), env: process.env }))
        break
      case 'devenv':
        refuseWorker('devenv')
        if (args.includes('--missing')) {
          if (args.length !== 1) fail('usage: factory devenv [rig...] [--force] | factory devenv --missing')
          const lines = devenv.cacheProposal(rigs(), r => devenv.remoteDevenv(r.repo).hasDevenv)
          if (lines.length) console.log(lines.join('\n'))
          break
        }
        console.log(
          devenvPass(
            args.filter(a => a !== '--force'),
            args.includes('--force'),
          ).join('\n'),
        )
        break
      case 'linear': {
        refuseWorker('linear')
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
        refuseWorker('self-update', true)
        const state = runSelfUpdate()
        console.log(state ? JSON.stringify(state) : 'a tick, or another self-update, is already running')
        break
      }
      case 'skills': {
        const [verb, name, ...why] = args
        // a patrol subagent has a Bash tool: the manager or the person decides, never a subagent
        if ((verb === 'install' || verb === 'reject') && process.env.FACTORY_PATROL)
          fail(`a patrol cannot ${verb} a skill: leave it for the manager`)
        if ((verb === 'install' || verb === 'reject') && workerMarker())
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
          if (!name) fail('skills install <name>')
          const release = hold('dream.lock')
          if (!release) {
            console.error('memory: busy')
            process.exitCode = 1
            break
          }
          try {
            memory.installSkill(MEMORY, name!)
            commitMemory(`the manager installed the skill ${name}`)
            console.log(`installed ${name}: the manager's Claude picks it up now`)
          } finally {
            release()
          }
        } else if (verb === 'reject') {
          if (!name) fail('skills reject <name> <why>')
          if (!why.length) fail('skills reject <name> <why>: the dream learns from the reason')
          const release = hold('dream.lock')
          if (!release) {
            console.error('memory: busy')
            process.exitCode = 1
            break
          }
          try {
            memory.rejectSkill(MEMORY, name!, why.join(' '))
            commitMemory(`the manager rejected the skill ${name}`)
            console.log(`rejected ${name}; the dream reads why`)
          } finally {
            release()
          }
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
        } else if ((verb === 'install' || verb === 'reject') && workerMarker()) {
          fail(`a worker cannot ${verb} a proposal: mail the manager instead`)
        } else if (verb === 'install' && name) {
          const release = hold('dream.lock')
          if (!release) {
            console.error('memory: busy')
            process.exitCode = 1
            break
          }
          try {
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
                cut(`memory proposal ${x.name}: ${x.change}`, 200),
                readFileSync(x.file, 'utf8'),
                { memory_proposal: x.name },
                '-l',
                'human',
              ),
            )
            commitMemory(`filed the proposal ${name} as ${bead}`)
            console.log(`filed ${name} (rung ${p?.rung}) as ${bead} in ${rig!.name}, for a person`)
          } finally {
            release()
          }
        } else if (verb === 'reject' && name) {
          if (!why.length) fail(`${usage}: the dream learns from the reason`)
          const release = hold('dream.lock')
          if (!release) {
            console.error('memory: busy')
            process.exitCode = 1
            break
          }
          try {
            memory.rejectProposal(MEMORY, name, why.join(' '))
            commitMemory(`rejected the proposal ${name}`)
            console.log(`rejected ${name}; the dream reads why`)
          } finally {
            release()
          }
        } else fail(usage)
        break
      }
      case 'loop': {
        refuseWorker('loop', true)
        lease()
        const ms = args[0] === '--interval' ? Number(args[1]) : 5000
        if (!(ms >= 1000)) fail('usage: factory loop [--interval ms], at least 1000')
        await loop(ms)
        break
      }
      case 'show':
        emit(await runsOp.show(cliCtx(), defined({ id: args[0] })))
        break
      case 'metrics': {
        const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
        emit(
          await metricsOp.show(
            cliCtx(),
            defined({
              rig: opt('--rig'),
              since: opt('--since'),
              json: args.includes('--json') || undefined,
              tokens: args.includes('--tokens') || undefined,
            }),
          ),
        )
        break
      }
      case 'snapshot': {
        // claude-factory-hpmc.23: several read views in one call; the board view is the slim board
        if (args[0] !== '--views' || !args[1] || args.length !== 2)
          fail('usage: factory snapshot --views a,b')
        const board = args[1]!.split(',').includes('board')
          ? await readOnlyBoard(leases.readLease(HOME) ?? { holder: 'none', kind: 'none', at: Date.now() })
          : null
        emit(await snapshotRun({ ...cliCtx(), board: () => board }, { views: args[1]! }))
        break
      }
      case 'flows': {
        const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
        const r = await flowsOp.show(cliCtx(), defined({ factory: opt('--factory'), since: opt('--since') }))
        if (r.code || args.includes('--json')) emit(r)
        else {
          const g = JSON.parse(r.out) as FlowGraph
          emit({ ...r, out: (args.includes('--mermaid') ? flowMermaid(g) : flowTable(g)) + '\n' })
        }
        break
      }
      case 'backlog':
        emit(await backlogOp.show(cliCtx(), {}))
        break
      case 'prs':
        emit(await prsOp.show(cliCtx(), {}))
        break
      case 'decisions': {
        const [sub, ...rest] = args
        if (!sub || sub === 'list') {
          emit(await decisionsOp.list(cliCtx(), {}))
          break
        }
        if (sub === 'answer') {
          const [rigName, id, ...text] = rest
          if (!rigName || !id || !text.length)
            fail("usage: factory decisions answer <rig> <bead> '<text...>'")
          emit(await decisionsOp.answer(cliCtx(), { rig: rigName!, bead: id!, text: text.join(' ') }))
          break
        }
        if (sub === 'propose' && rest[1]?.startsWith('--')) {
          // claude-factory-2z48: the file form takes untrusted text from <FACTORY_HOME>/text/ or the real .scratch/ of the git worktree, never from the command
          const usage =
            'usage: factory decisions propose <key> --question-file <path> --options-file <path> [--context-file <path>]'
          const [key, ...pairs] = rest
          const files = new Map<string, string>()
          for (let i = 0; i < pairs.length; i += 2) {
            const k = pairs[i]!
            const v = pairs[i + 1]
            if (!['--question-file', '--options-file', '--context-file'].includes(k) || !v || files.has(k))
              fail(usage)
            files.set(k, v!)
          }
          const isOwn = /^own:/.test(key!)
          if (!files.has('--question-file') || (!isOwn && !files.has('--options-file'))) fail(usage)
          const read = (k: string) => (files.has(k) ? textFileArg(k, files.get(k)!) : undefined)
          // an own: key ignores --options-file, as the positional form does: do not read it
          decisionsPropose(
            key!,
            read('--question-file')!,
            isOwn ? '' : read('--options-file')!,
            read('--context-file'),
          )
          break
        }
        if (sub === 'propose') {
          const [key, question, optionsLine, ...extra] = rest
          if (!key || !question || !optionsLine)
            fail(
              "usage: factory decisions propose <key> '<question>' '<label: effect | label: effect>' [--context '<sentence>']",
            )
          const ci = extra.indexOf('--context')
          const context = ci === -1 ? undefined : extra[ci + 1]
          if (ci !== -1 && !context) fail("usage: ... --context '<sentence>' needs a value")
          const leftover = ci === -1 ? extra : extra.filter((_, i) => i !== ci && i !== ci + 1)
          if (leftover.length)
            fail(
              `unknown argument${leftover.length > 1 ? 's' : ''} "${leftover.join(' ')}": only --context '<sentence>' is allowed`,
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
          emit(await planOp.show(cliCtx(), {}))
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
        if (args.includes('--once')) {
          refuseWorker('review', true)
          lease()
          const other = localLease()
          if (other) fail(`no review: ${leases.leaseLine(other, Date.now())}`)
          console.log(await onceCmd('review', args))
        } else if (sub === 'facts') console.log(JSON.stringify(reviewFacts(a1)))
        else if (sub === 'set') reviewSet(a1, a2)
        else fail('review facts <key> | set <key> <file>')
        break
      }
      case 'gate-brief': {
        const [sub, a1, a2] = args
        if (sub === 'facts') {
          emit(await gatesOp.brief(cliCtx(), defined({ id: a1 })))
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
        refuseWorker('queue')
        const [repo, id, station] = args
        if (!repo || !id) fail('usage: factory queue <rig|repo> <bead> [station]')
        const root = repoOf(repo!)
        const b = beads(root, 'factory')
        if (process.env.FACTORY_PATROL) {
          let cur: Bead | null = null
          try {
            cur = b.lookup(id!)
          } catch {
            // refused below
          }
          if (!cur) fail(`${id} cannot be read: a patrol cannot start it: a person queues it`)
          refusePatrolDiscovered(b, cur!)
        }
        b.queue(id!, station)
        console.log(
          `queued ${id}${station ? ` at ${station}` : ''}: ${rigOf(root) ? 'it starts at the next dispatch' : 'make the repo a rig (factory rig add) for it to start'}`,
        )
        break
      }
      case 'file-elsewhere':
        fileElsewhere(args)
        break
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
        emit(await runsOp.status(cliCtx(), defined({ run: args[0] })))
        break
      case 'digest':
        await digest()
        break
      case 'waiting': {
        console.log(waiting(await runRows(), Date.now(), shipQueues()))
        break
      }
      case 'report': {
        const [id, seq, outcome] = args
        const { run, value, c } = current(id)
        const [node] = where(value)
        const n = (await loadPinned(run.factory)).nodes[node]
        if (n?.gate) fail(`${node} is a gate: the person decides it, with factory decide`)
        const outcomes = Object.keys(n?.next ?? {}).concat(WORKER_OUTCOMES)
        if (Number(seq) !== c.seq)
          fail(`stale report: seq ${seq} is no longer the active worker (now ${c.seq}); stop here`)
        if (!outcomes.includes(outcome ?? '')) fail(`outcome must be one of: ${outcomes.join(', ')}`)
        const text = cleanReport(summaryArgs(args).slice(3).join(' '))
        if (n?.securityRoute && (outcome === 'security' || outcome === 'approve')) {
          const route = savedRoute(run, c)
          const line = routeLine(route)
          if (outcome === 'security' && !route.required && !SECURITY_REASON.test(text))
            fail(
              `the security route for this diff is not required (${line}). Post your verdict as the approve rules say: the APPROVE review when FACTORY_GH_REVIEWER is 1, then mark the pull request ready if those rules allow it. Then report approve. Or, for a concrete security finding that the path rule missed, add one summary line Security-reason: <path>:<line> <what is sensitive> and report security again.`,
            )
          if (outcome === 'approve' && route.required)
            fail(
              `this diff needs the security station (${line}). If you marked the pull request ready, run gh pr ready <n> --undo. If you posted an APPROVE review, dismiss it: gh api -X PUT repos/<owner>/<repo>/pulls/<n>/reviews/<review id>/dismissals -f message='security review follows' -f event=DISMISS. If the dismissal fails, name the review id in your summary. Post the verdict as a COMMENT, then report security.`,
            )
        }
        post(
          run.id,
          outcome === 'fail'
            ? { type: 'FAIL', seq: c.seq, reason: text }
            : outcome === 'blocked'
              ? {
                  type: 'BLOCKED',
                  seq: c.seq,
                  reason: text,
                  // a VM worker cannot do a live read: a timer re-check finds nothing new, so only mail wakes it
                  ...(c.pane && !runnerOf(c.pane).local && isLiveRead(text)
                    ? { mailOnly: true as const }
                    : {}),
                }
              : outcome === 'handoff'
                ? { type: 'HANDOFF', seq: c.seq, summary: text }
                : { type: 'DONE', seq: c.seq, outcome: outcome!, summary: text },
        )
        console.log(`reported ${outcome} for ${node}; you are done, stop now`)
        break
      }
      case 'decide': {
        const [id, outcome, ...note] = args
        emit(await gatesOp.decide(cliCtx(), defined({ id, outcome, note: note.join(' ') })))
        break
      }
      case 'mail': {
        // --wake comes right after the box; in a later word it stays text
        const wake = args[2] === '--wake'
        const [id, to, ...rest] = fileArgs('mail', args)
        const text = wake ? rest.slice(1) : rest
        emit(
          await runsOp.mail(
            cliCtx(),
            defined({ id, to, text: text.join(' '), wake: wake || undefined, cwd: here() }),
          ),
        )
        break
      }
      case 'poke': {
        refuseWorker('poke')
        // the manager's nudge: lands in the current worker's session on the next tick
        const [id, ...text] = args
        const { run, value, c } = current(id)
        const [node, sub] = where(value)
        if (sub !== 'working' || (await loadPinned(run.factory)).nodes[node]?.gate)
          fail(`${run.id} has no worker to poke: it is at ${node}${sub ? `/${sub}` : ''}`)
        const nudge = `[factory] The manager is checking in. When you are finished run: ${reportCmd(run, c)}; if something blocks you, mail the manager what it is.`
        post(run.id, { type: 'MAIL', from: managerSender(run), to: node, text: text.join(' ') || nudge })
        console.log(`poked ${node} of ${run.id}`)
        break
      }
      case 'retry': {
        refuseWorker('retry')
        const { run, value, c } = current(args[0])
        const [node, sub] = where(value)
        if (sub !== 'stuck')
          fail(
            `${run.id} is at ${node}${sub ? `/${sub}` : ''}, not stuck: RETRY only applies to a stuck station; run ${CLI} goto ${run.id} ${node} to restart it`,
          )
        const runner = c.pane ? runnerOf(c.pane) : runnerOfStation(run, await loadPinned(run.factory), node)
        const unavailable = runner.name === 'ax' ? ax.unavailable() : undefined
        if (unavailable) fail(unavailable)
        post(run.id, { type: 'RETRY' })
        break
      }
      case 'unhold': {
        refuseWorker('unhold', true)
        const codex = args[1] === '--codex'
        const r = args[0] ? runners[args[0]] : undefined
        if (!r || r.local !== false || args.length > (codex ? 2 : 1))
          fail('usage: factory unhold <runner> [--codex]; the runner is a remote one, such as ax')
        writeUnhold(r!.name, codex, Date.now(), Date.now())
        clearHarnessLimit(r!.name, codex ? 'codex' : 'claude')
        console.log(
          `marked: the next tick wakes the ${r!.name} stations held by a ${codex ? 'Codex' : 'Claude'} limit, as far as slots are free`,
        )
        break
      }
      case 'goto':
        emit(await runsOp.goto(cliCtx(), defined({ id: args[0], node: args[1] })))
        break
      case 'abort':
        emit(await runsOp.abort(cliCtx(), defined({ id: args[0] })))
        break
      case 'init': {
        if (!args[0]) fail('usage: factory init <dir>')
        makeFactory(expand(args[0]!))
        break
      }
      case 'up': {
        refuseWorker('up', true)
        const { dir, rest } = upDir(args, BOOT_ENV, homedir(), DEFAULT_HOME)
        if (dir === DEFAULT_HOME) usedDefault()
        const { errors, warnings } = upCheck(t => !!Bun.which(t), BOOT_ENV)
        if (errors.length) fail(errors.join('\n'))
        const modules = join(ROOT, 'node_modules')
        if (
          !inStore(ROOT) &&
          needsInstall(
            existsSync(modules) ? statSync(modules).mtimeMs : undefined,
            statSync(join(ROOT, 'bun.lock')).mtimeMs,
          )
        ) {
          const code = await Bun.spawn(['bun', 'install', '--frozen-lockfile'], {
            cwd: ROOT,
            stdio: ['inherit', 'inherit', 'inherit'],
          }).exited
          if (code) fail(`bun install failed (exit ${code})`)
          const now = new Date()
          utimesSync(modules, now, now)
        }
        if (!existsSync(join(dir, 'rigs.json'))) makeFactory(dir)
        for (const w of warnings) console.error(w)
        // a child, not this process: HOME and the loaded settings are fixed at import from the caller's env and cwd
        const child = Bun.spawn([CLI, 'manager', ...rest], {
          cwd: dir,
          env: { ...BOOT_ENV, FACTORY_HOME: dir },
          stdio: ['inherit', 'inherit', 'inherit'],
        })
        process.exit(await child.exited)
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
      case 'mutate':
        process.exit(await (await import('./mutate')).mutate(args))
      case 'ci': {
        const r = ciReport(args, a => {
          const p = Bun.spawnSync(['gh', ...a], { timeout: 60_000, maxBuffer: 64_000_000 })
          return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() }
        })
        if (r.exit === 3) console.error(r.text)
        else console.log(r.text)
        process.exit(r.exit)
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
      case 'settings': {
        const file = join(HOME, 'settings.json')
        const dfile = devenvConfig()
        const [sub = 'list', key, value] = args
        const usage = 'usage: factory settings [list] | set <key> <value> | unset <key>'
        if (sub === 'list' && args.length <= 1) {
          // BOOT_ENV: process.env already holds the stored values that loadIntoEnv filled in
          console.log(
            [...settingsRows(readSettings(file), BOOT_ENV), ...devenvRows(readDevenv(dfile))].join('\n'),
          )
        } else if (sub === 'set' && args.length === 3) {
          refuseWorker('settings set', true)
          if (isDevenvKey(key!)) setDevenv(dfile, key!, value!)
          else setSetting(file, key!, value!)
          console.log(`set ${key}`)
        } else if (sub === 'unset' && args.length === 2) {
          refuseWorker('settings unset', true)
          if (isDevenvKey(key!)) unsetDevenv(dfile, key!)
          else unsetSetting(file, key!)
          console.log(`unset ${key}`)
        } else fail(usage)
        break
      }
      case 'token': {
        refuseWorker('token', true)
        console.log(await tokenCommand(args, readSettings(join(HOME, 'settings.json'))))
        break
      }
      case 'image': {
        refuseWorker('image build', true)
        const usage = 'usage: factory image build [--target worker|manager]'
        const t = args[2]
        const ok =
          args[0] === 'build' &&
          (args.length === 1 ||
            (args.length === 3 && args[1] === '--target' && (t === 'worker' || t === 'manager')))
        if (!ok) fail(usage)
        const target: Target = args.length === 3 ? (t as Target) : 'worker'
        const head = Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'])
        if (head.exitCode !== 0) fail(`cannot read the HEAD of ${ROOT}`)
        let ref: string
        try {
          ref = await buildImage({
            target,
            settingsFile: join(HOME, 'settings.json'),
            root: ROOT,
            sha: head.stdout.toString().trim(),
            env: BOOT_ENV,
            // fd 2: the docker stdout goes to the stderr of this command, so stdout holds only the ref
            run: argv => Bun.spawn(['docker', ...argv], { stdio: ['inherit', 2, 'inherit'] }).exited,
          })
        } catch (e) {
          fail((e as Error).message)
        }
        const key = IMAGE_KEY[target]
        const name = SETTING_KEYS.find(k => k.key === key)?.env
        if (name && BOOT_ENV[name] !== undefined)
          console.error(
            `factory: ${name} is set in the environment and overrides the stored ${key}; unset it to use the new image`,
          )
        console.log(ref!)
        break
      }
      case 'rig': {
        const opt = (flag: string) =>
          args.includes(flag) ? args.splice(args.indexOf(flag), 2)[1] : undefined
        // the goal is the rest of the line, so `/factory rig add ... --goal finish it` needs no quotes
        const goal = args.includes('--goal')
          ? args.splice(args.indexOf('--goal')).slice(1).join(' ')
          : undefined
        const [max, sweeps, slo, drift, runner, agent, mcp, linear, linearProjects, linearLabels] = [
          opt('--max'),
          opt('--sweeps'),
          opt('--slo'),
          opt('--drift'),
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
        if (sub !== 'list' && sub !== 'show') refuseWorker(`rig ${sub}`, true) // triage reads the rig list; only the person changes rigs
        if (sub === 'add') {
          if (!name || !repo)
            fail(
              `usage: factory rig add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--slo cmd] [--runner ${Object.keys(runners).join('|')}] [--agent cmd] [--mcp file] [--param name=value]... [--egress host[,host]...[=KEY[:Header:Prefix]]]... [--person-only-context ctx]... [--protected-branch b]... [--merge-authority] [--linear team_id[,team_id] [--linear-projects name[,name]] [--linear-labels name[,name]]] [--goal '<text...>']`,
            )
          const rig = await defineRig(name!, repo!, factory, {
            max,
            sweeps,
            slo,
            drift,
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
          edit(list => {
            const taken = mapRigs(list).find(r => r.repo === rig.repo && r.name !== rig.name)
            if (taken)
              throw new Error(
                `${rig.repo} is already rig ${taken.name}: redefine it under that name, or rig rm ${taken.name} first`,
              )
            return [...list.filter(r => r.name !== rig.name && r.repo !== rig.repo), rig]
          })
          console.log(
            `rig ${rig.name}: ${rig.repo} runs ${factory}; its ready beads labeled factory start as runs${rig.maxRuns ? `, at most ${rig.maxRuns} busy` : ''}${rig.runner ? `, workers run by ${rig.runner}` : ''}`,
          )
        } else if (sub === 'rm') {
          edit(list => {
            if (!list.some(r => r.name === name))
              throw new Error(`no rig "${name}" (rigs: ${list.map(r => r.name).join(', ') || 'none'})`)
            return list.filter(r => r.name !== name)
          })
          console.log(`removed rig ${name}: nothing new starts there; its runs carry on`)
        } else if (sub === 'show') {
          if (!name) fail('usage: factory rig show <rig|repo>')
          const at = repoOf(name!)
          const found = rawRigs().find(r => mapRigs([r])[0]!.repo === at)
          if (!found) fail(`${at} is not a rig`)
          console.log(JSON.stringify(redactRig(found!), null, 2))
        } else if (sub === 'set') {
          const usage =
            "usage: factory rig set <rig|repo> [--goal '<text...>'] [--max n] [--sweeps a,b|none] [--runner name] [--agent cmd] [--mcp file] [--param name=value]... [--cluster-runs n] [--auto-queue p,n|off] [--push-rule text|none]... [--sensitive-path path|none]... [--skills a,b|none] [--otel-content on|off] [--sandbox-class gvisor|microvm]"
          const val = (f: string) => (args.includes(f) ? (opt(f) ?? '') : undefined)
          const clusterRuns = val('--cluster-runs')
          const autoQueue = val('--auto-queue')
          const pushRules: string[] = []
          while (args.includes('--push-rule')) pushRules.push(opt('--push-rule') ?? '')
          const sensitivePaths: string[] = []
          while (args.includes('--sensitive-path')) sensitivePaths.push(opt('--sensitive-path') ?? '')
          const skills = val('--skills')
          const otelContent = val('--otel-content')
          const sandboxClass = val('--sandbox-class')
          const foreign = [
            [slo, '--slo'],
            [drift, '--drift'],
            [linear, '--linear'],
            [linearProjects, '--linear-projects'],
            [linearLabels, '--linear-labels'],
            [egress.length, '--egress'],
            [personOnlyContext.length, '--person-only-context'],
            [protectedBranch.length, '--protected-branch'],
            [mergeAuth, '--merge-authority'],
          ].find(([v]) => v !== undefined && v !== 0 && v !== false)
          if (foreign) fail(`rig set does not change ${foreign[1]}: ${usage}`)
          if (!name || args.length > 2) fail(usage)
          const target = rigs().find(r => r.repo === repoOf(name!))
          if (!target) fail(`${repoOf(name!)} is not a rig`)
          const set: Record<string, unknown> = {}
          const unset: string[] = []
          if (clusterRuns !== undefined) {
            if (!/^[1-9]\d*$/.test(clusterRuns) || !Number.isFinite(Number(clusterRuns)))
              fail(`--cluster-runs is a number of runs, at least 1 (not "${clusterRuns}")`)
            set.clusterRuns = Number(clusterRuns)
          }
          if (autoQueue !== undefined) {
            if (autoQueue === 'off') unset.push('autoQueue')
            else {
              const m = /^([0-4]),([1-9]\d*)$/.exec(autoQueue)
              if (!m || !Number.isFinite(Number(m[2])))
                fail(
                  `--auto-queue is <minPriority 0-4>,<perHour 1 or more>, e.g. 2,3, or off (not "${autoQueue}")`,
                )
              set.autoQueue = { minPriority: Number(m![1]), perHour: Number(m![2]) }
            }
          }
          if (pushRules.length) {
            if (pushRules.some(r => !r.trim()) || (pushRules.includes('none') && pushRules.length !== 1))
              fail('--push-rule is a non-empty rule text, or one --push-rule none alone')
            if (pushRules[0] === 'none') unset.push('pushRules')
            else set.pushRules = pushRules
          }
          if (sensitivePaths.length) {
            const none = sensitivePaths.includes('none') && sensitivePaths.length !== 1
            const bad = none ? 'none' : sensitivePaths.find(v => v !== 'none' && !SENSITIVE_ENTRY.test(v))
            if (bad !== undefined)
              fail(
                `--sensitive-path is a repo path or directory (segments of letters, digits, . _ - joined by /; no . or .. segment; no glob), or one --sensitive-path none alone (not ${JSON.stringify(bad)})`,
              )
            if (sensitivePaths[0] === 'none') unset.push('sensitivePaths')
            else set.sensitivePaths = sensitivePaths
          }
          if (skills !== undefined) {
            if (skills === 'none') unset.push('skills')
            else {
              const names = skills.split(',')
              const bad = names.flatMap(n => unknownSkill(n, '--skills'))
              if (bad.length) fail(bad.join('; '))
              set.skills = names
            }
          }
          if (otelContent !== undefined) {
            if (otelContent !== 'on' && otelContent !== 'off')
              fail(`--otel-content is on or off (not "${otelContent}")`)
            if (otelContent === 'on') unset.push('otelContent')
            else set.otelContent = false
          }
          if (sandboxClass !== undefined) {
            if (sandboxClass !== 'gvisor' && sandboxClass !== 'microvm')
              fail(`--sandbox-class is gvisor or microvm (not "${sandboxClass}")`)
            if (sandboxClass === 'gvisor') unset.push('sandboxClass')
            else set.sandboxClass = sandboxClass
          }
          if (goal !== undefined) {
            if (!goal.trim()) fail('--goal needs text')
            set.goal = goal
          }
          if (max !== undefined) {
            if (!/^[1-9]\d*$/.test(max)) fail(`--max is a number of runs, at least 1 (not "${max}")`)
            set.maxRuns = Number(max)
          }
          if (sweeps !== undefined) {
            set.sweeps = sweeps === 'none' ? [] : sweeps.split(',')
            await checkSweeps(set.sweeps as string[], target!.sweepsFactory, target!.repo)
          }
          if (runner !== undefined) {
            if (runner === DEFAULT_RUNNER) unset.push('runner')
            else set.runner = runner
          }
          if (agent !== undefined) set.agent = agent
          if (mcp !== undefined) {
            set.mcp = expand(mcp)
            try {
              readMcp(set.mcp as string)
            } catch (err) {
              fail(`--mcp ${mcp}: ${(err as Error).message}`)
            }
          }
          if (params.length) {
            const def = await loadFactory(factorySource(target!.factory, target!.repo))
            set.params = checkParams(def, params, target!.params)
          }
          if (!Object.keys(set).length && !unset.length) fail(usage)
          edit(list =>
            list.map(r => {
              if (r.name !== target!.name) return r
              const next = applyRigChange(r, set, unset) as Rig
              for (const w of validateRig(next)) console.warn(w)
              return next
            }),
          )
          console.log(`rig ${target!.name}: set ${[...Object.keys(set), ...unset].join(',')}`)
        } else if (sub === 'env' || sub === 'egress' || sub === 'beads-remote') {
          const usages: Record<string, string> = {
            'env set': 'factory rig env set <rig|repo> KEY=VALUE',
            'env unset': 'factory rig env unset <rig|repo> KEY',
            'egress add':
              'factory rig egress add <rig|repo> host[,host]...[=KEY[:Header:Prefix]] [--port n] [--path-prefix /path/]...',
            'egress rm': 'factory rig egress rm <rig|repo> host[,host]...',
            'beads-remote set': 'factory rig beads-remote set <rig|repo> --name n --url u --user user',
            'beads-remote clear': 'factory rig beads-remote clear <rig|repo>',
          }
          const [port, bName, bUrl, bUser] = [opt('--port'), opt('--name'), opt('--url'), opt('--user')]
          const pathPrefix: string[] = []
          while (args.includes('--path-prefix')) pathPrefix.push(opt('--path-prefix') ?? '')
          const [verb, at, arg, ...extra] = args.slice(1)
          const key = `${sub} ${verb}`
          const usage =
            usages[key] ??
            Object.keys(usages)
              .filter(k => k.startsWith(`${sub} `))
              .map(k => usages[k])
              .join(' | ')
          const old = [
            max,
            sweeps,
            slo,
            drift,
            runner,
            agent,
            mcp,
            linear,
            linearProjects,
            linearLabels,
            goal,
          ]
          const stray =
            old.some(v => v !== undefined) ||
            [params, egress, personOnlyContext, protectedBranch].some(l => l.length) ||
            mergeAuth ||
            (port !== undefined && key !== 'egress add') ||
            (pathPrefix.length > 0 && key !== 'egress add') ||
            ([bName, bUrl, bUser].some(v => v !== undefined) && key !== 'beads-remote set')
          const noArg = sub === 'beads-remote'
          if (!usages[key] || stray || !at || extra.length || (noArg ? arg !== undefined : !arg))
            fail(`usage: ${usage}`)
          const target = rigs().find(r => r.repo === repoOf(at!))
          if (!target) fail(`${repoOf(at!)} is not a rig`)
          const change = (fn: (r: Rig) => Partial<Rig>, said: string) => {
            edit(list =>
              list.map(r => {
                if (r.name !== target!.name) return r
                const next = fn(r) as Rig
                for (const w of validateRig(next)) console.warn(w)
                return next
              }),
            )
            console.log(`rig ${target!.name}: ${said}`)
          }
          // an emptied env or egress goes away, so a set then an unset leaves the file as it was
          const without = (r: Rig, k: 'env' | 'egress' | 'beadsRemote', v: unknown) =>
            applyRigChange(r, v ? { [k]: v } : {}, v ? [] : [k]) as Rig
          const hostSet = (hosts: string[]) =>
            hosts
              .map(h => h.toLowerCase())
              .sort()
              .join(',')
          if (key === 'env set') {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(arg!)
            if (!m) fail(`env KEY is [A-Za-z_][A-Za-z0-9_]* and the pair is KEY=VALUE: usage: ${usage}`)
            change(r => without(r, 'env', { ...r.env, [m![1]!]: m![2]! }), `set env ${m![1]}`)
          } else if (key === 'env unset') {
            change(r => {
              if (!Object.hasOwn(r.env ?? {}, arg!)) throw new Error(`env ${arg} is not set`)
              const { [arg!]: _, ...rest } = r.env!
              return without(r, 'env', Object.keys(rest).length ? rest : undefined)
            }, `unset env ${arg}`)
          } else if (key === 'egress add') {
            let rule: Egress
            try {
              rule = ax.parseEgress(arg!)
            } catch (e) {
              fail((e as Error).message)
            }
            if (port !== undefined) {
              if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)
                fail(`--port is a number from 1 to 65535 (not "${port}")`)
              rule!.port = Number(port)
            }
            for (const p of pathPrefix) {
              if (!/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/$/.test(p))
                fail(
                  `--path-prefix is a URL path that ends in /, such as /v1/aws/acme/: segments of letters, digits and -._~ that do not start with . (not "${p}")`,
                )
              if (pathPrefix.indexOf(p) !== pathPrefix.lastIndexOf(p))
                fail(`--path-prefix "${p}" is given two times`)
            }
            if (pathPrefix.length) {
              const why = broker.workerPolicyRefusal({
                rules: [{ https: { hostnames: rule!.hosts, pathPrefixes: pathPrefix } }],
              })
              if (why) fail(`--path-prefix: the broker refuses this worker rule: it ${why}`)
              rule!.pathPrefixes = pathPrefix
            }
            change(
              r => {
                if (r.egress?.some(e => hostSet(e.hosts) === hostSet(rule.hosts)))
                  throw new Error(`egress for ${rule.hosts.join(',')} is set: rig egress rm it first`)
                return without(r, 'egress', [...(r.egress ?? []), rule])
              },
              `added egress ${rule!.hosts.join(',')}`,
            )
          } else if (key === 'egress rm') {
            const want = hostSet(arg!.split(','))
            change(r => {
              const hit = (r.egress ?? []).filter(e => hostSet(e.hosts) === want)
              if (hit.length !== 1)
                throw new Error(`${hit.length} egress rules for those hosts: rm needs exactly 1`)
              const rest = r.egress!.filter(e => e !== hit[0])
              return without(r, 'egress', rest.length ? rest : undefined)
            }, `removed egress ${arg}`)
          } else if (key === 'beads-remote set') {
            if (bName === undefined || bUrl === undefined || bUser === undefined) fail(`usage: ${usage}`)
            if (!BEADS_WORD.test(bName!) || !BEADS_WORD.test(bUser!)) fail(BEADS_WORD_MSG)
            if (!URL.canParse(bUrl!)) fail('--url is not a URL')
            change(
              r => without(r, 'beadsRemote', { name: bName, url: bUrl, user: bUser }),
              `set beadsRemote ${bName}`,
            )
          } else {
            change(r => {
              if (!r.beadsRemote) throw new Error('no beadsRemote is set')
              return without(r, 'beadsRemote', undefined)
            }, 'cleared beadsRemote')
          }
        } else if (sub === 'list') {
          emit(await rigsOp.list(cliCtx(), {}))
        } else if (sub === 'history') {
          const snaps = snapshots(rigsFile())
          if (!snaps.length) console.log('no rig history')
          snaps.forEach((f, i) => {
            const stem = basename(f, '.json')
            let line = 'not valid JSON'
            try {
              const list = JSON.parse(readFileSync(f, 'utf8'))
              if (!Array.isArray(list)) throw new Error('not an array')
              line = `${list.length} rigs: ${list.map((r: { name?: string }) => r?.name).join(', ')}`
            } catch {}
            console.log(`${i + 1}  ${stem}  ${line}`)
          })
        } else if (sub === 'undo') {
          const snaps = snapshots(rigsFile())
          if (name !== undefined && !/^[1-9][0-9]*$/.test(name))
            fail(`rig undo: "${name}" is not a snapshot number`)
          const n = Number(name ?? 1)
          const from = snaps[n - 1]!
          if (!snaps[n - 1]) fail(`rig undo: no snapshot ${n} (${snaps.length} in rig history)`)
          edit(() => {
            try {
              return JSON.parse(readFileSync(from, 'utf8')) as Rig[] // editRigs checks it is a valid list
            } catch (e) {
              throw new Error(`${from}: not valid JSON (${hideParseText((e as Error).message)})`)
            }
          })
          console.log(`restored rigs.json from ${basename(from, '.json')}; rig undo again reverses it`)
        } else
          fail(
            `unknown rig command "${sub}": add, set, env, egress, beads-remote, show, rm, list, history or undo`,
          )
        break
      }
      case 'rm': {
        refuseWorker('rm')
        const run = removeRun(args[0]!)
        console.log(`removed ${run.id}; its work stays on branch ${run.branch}`)
        break
      }
      case 'gc': {
        emit(await gcOp.run(cliCtx(), gcOp.argsInput(args)))
        break
      }
      case 'sweep': {
        refuseWorker('sweep', true)
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
        if (cmd && !['help', '--help', '-h'].includes(cmd)) process.exitCode = 2
    }
  } catch (err) {
    console.error(`factory: ${(err as Error).message}`)
    process.exitCode = 1
  }
