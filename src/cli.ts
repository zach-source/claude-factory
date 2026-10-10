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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { createActor, type Snapshot } from 'xstate'
import {
  compile,
  extend,
  fill,
  isParked,
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
import { actorOf, beads, dispatchable, goalOf, hasBeads, isOwned, stationOf, type Bead } from './beads'
import { claudeCommand, command, harnessOf, readMcp } from './harness'
import { tokens, waiting } from './sidebar'
import * as memory from './memory'
import { createdAt, metrics, render, type RunRecord } from './metrics'

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
const NUDGES = 4 // ...this many times, each wait twice the last (90s to 24 min), then fails
// a worker whose Claude has not appeared this long after launch never started: the shell was still
// starting (direnv, under load) when herdr typed the command, and swallowed the Enter
const LAUNCH_MS = 90_000

type Run = {
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

function herdr(...args: string[]) {
  const p = Bun.spawnSync(['herdr', ...args])
  const out = p.stdout.toString().trim()
  if (p.exitCode !== 0) fail(`herdr ${args.slice(0, 2).join(' ')}: ${p.stderr.toString().trim() || out}`)
  return out.startsWith('{') ? JSON.parse(out).result : out
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
export const loadFactory = async (file: string): Promise<Factory> => validate(await readFactory(file))
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
  // a fresh worker is told what earlier ones already committed, so it builds on it rather than redoing it
  const committed = run.base ? git(run.worktree, 'log', '--oneline', '-n', '30', `${run.base}..HEAD`) : ''
  const prior = node === def.start ? priorWork(run) : ''
  return [
    `You are the "${node}" station of the software factory "${def.name}" (run ${run.id}, attempt ${c.attempt} of ${1 + (n.retries ?? 2)}).`,
    `You work in the git worktree ${run.worktree} on branch ${run.branch}. Commit your work there and touch no other checkout.`,
    `This run follows the factory pinned when it started (${run.factoryFrom ?? run.factory}): changes to ${OWN}/ on any branch reach only runs that start after they merge. Check an edited factory file with ${CLI} check <file>.`,
    ...(def.rules ? ['', '## House rules', def.rules.trim()] : []),
    '',
    ...remembered(run, node),
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
    `- blocked: you are waiting on something outside this run (a person's decision, a human review or merge, another run): say exactly what. The run parks without using an attempt, and a fresh worker checks again in ${n.parkMin ?? 60} min or as soon as this station is mailed.`,
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

/** a worker in a new tab of the run's workspace; given a session, it resumes that conversation */
function spawn(run: Run, def: Factory, node: string, c: Ctx, session?: string) {
  const prompt = session ? resumeFile(run, node, c) : promptOf(run, node, c)
  if (!session) writeFileSync(prompt, brief(run, def, node, c, c.mail[node] ?? []))
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
  herdr('pane', 'run', pane, launch(run, def, node, prompt, session))
  return pane
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
function launch(run: Run, def: Factory, node: string, prompt: string, session?: string) {
  const rig = rigOf(run.repo)
  const extra = ` --settings '${JSON.stringify(withoutFleet())}'`
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
const MANAGER_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob,AskUserQuestion'
export const managerCommand = (extra: string[] = []) => [
  'claude',
  '--model',
  'opus', // not [1m]: Claude Code compacts it near 200k, and every call re-reads the whole context
  '--allow-dangerously-skip-permissions',
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
  if (!c.pane) {
    const pane = spawn(run, def, node, c)
    send({ type: 'SPAWNED', seq: c.seq, pane })
    const box = c.mail[node] ?? [] // the brief carried the whole box
    if (box.length) send({ type: 'READ', box: node, seen: box.length })
    return 'starting'
  }
  const info = paneInfo(c.pane)
  if (info?.session && info.session !== c.session)
    send({ type: 'SESSION', seq: c.seq, session: info.session })
  if (info === null && c.session && c.resumes < 1) {
    send({ type: 'SPAWNED', seq: c.seq, pane: spawn(run, def, node, c, c.session), isResume: true })
    return 'resuming'
  }
  const status = info?.status ?? null
  // only a harness herdr knows (claude, codex, pi) shows it an agent; a script or a fake worker never would
  const isClaude = harnessOf(agentOfNode(run, def, node)) !== null
  // its Claude exited and left the shell (a herdr restart keeps the panes, not their processes):
  // resume the conversation in the same pane, once, as for a pane that closed
  // a just-resumed Claude takes seconds to show: give it the launch grace before calling it gone again
  if (info && !info.agent && c.session && isClaude && now - c.startedAt > LAUNCH_MS) {
    if (c.resumes >= 1) {
      send({ type: 'FAIL', seq: c.seq, reason: `the worker's Claude exited in pane ${c.pane}` })
      return status
    }
    herdr('pane', 'send-keys', c.pane, 'ctrl+u')
    herdr('pane', 'run', c.pane, launch(run, def, node, resumeFile(run, node, c), c.session))
    send({ type: 'SPAWNED', seq: c.seq, pane: c.pane, isResume: true })
    return 'resuming'
  }
  if (info && !info.agent && !c.session && isClaude) {
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
      herdr('pane', 'run', c.pane, launch(run, def, node, promptOf(run, node, c)))
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
  if (status === 'working') send({ type: 'WORKING', seq: c.seq })
  const due = deadline(
    now - c.startedAt,
    timeoutMin,
    status === 'working' || isAsking, // waiting on the manager's answer is work: warned, not failed
    (c.mail[node] ?? []).some(m => m.from === 'factory' && m.at >= c.startedAt),
  )
  if (status === null) send({ type: 'FAIL', seq: c.seq, reason: `worker pane ${c.pane} was closed` })
  else if (due === 'fail') send({ type: 'FAIL', seq: c.seq, reason: `no report within ${timeoutMin} min` })
  else if (due === 'warn') {
    const cmd = `${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`
    const text = `[factory] This station's ${timeoutMin} minutes are up. Commit what works now and report within ${Math.round(timeoutMin / 2)} minutes, saying what is left for the next attempt: ${cmd}`
    send({ type: 'MAIL', from: 'factory', to: node, text }) // delivered on the next tick, like any mail
  } else if (inbox.length && status !== 'blocked') {
    herdr('agent', 'prompt', c.pane, inbox.map(m => `[factory mail from ${m.from}] ${m.text}`).join('\n\n'))
    send({ type: 'READ', box: node, seen: c.mail[node]!.length })
  } else if (
    !isAsking &&
    (status === 'idle' || status === 'done') &&
    // a worker waiting on its own build answers a nudge and goes idle again: give it longer each time
    now - Math.max(c.startedAt, c.nudgedAt) > GRACE_MS * 2 ** c.nudges
  ) {
    if (c.nudges >= NUDGES) send({ type: 'FAIL', seq: c.seq, reason: 'worker stopped without reporting' })
    else {
      const cmd = `${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`
      herdr(
        'agent',
        'prompt',
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
  return c.pane ? (paneInfo(c.pane)?.status ?? null) : undefined
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
  const info = c.pane ? paneInfo(c.pane) : null
  // a pane with no agent in it (a script worker, a Claude already gone) has nobody to tell
  const isTold = halt.told[run.id] === c.seq || !info?.agent
  const step = haltStep(!!info, isTold, info?.status === 'working', now - halt.at)
  if (step === 'tell') {
    herdr('agent', 'prompt', c.pane!, STOP_NOTE)
    halt.told[run.id] = c.seq
  } else if (step === 'close' || step === 'gone') {
    if (step === 'close') Bun.spawnSync(['herdr', 'pane', 'close', c.pane!])
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
    if (pane && pane !== ctx().pane) Bun.spawnSync(['herdr', 'pane', 'close', pane]) // gone already is fine
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
    row: row(run, def, actor.getSnapshot().value, ctx(), agent, error),
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
    if (!journal.length && !memory.inboxCount(MEMORY)) return 'nothing new since the last dream'
    const start = Date.now()
    const before = git(MEMORY, 'rev-parse', 'HEAD')
    const prompt = memory.dreamPrompt(MEMORY, journal, memory.usageLines(MEMORY), closedBeads())
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
    .filter(r => !r.isOver)
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
  const named = /^[a-z][\w-]*-[\w.]+$/i.test(goal.trim()) ? b.show(goal.trim()) : null
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
  /** worker command for every station here, e.g. `codex --dangerously-bypass-approvals-and-sandbox` or `pi` */
  agent?: string
  /** MCP servers every worker here loads, a file in Claude's --mcp-config shape ({ mcpServers }) */
  mcp?: string
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
          b.sync()
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
export function reworkGoal(pr: LabeledPr) {
  const asks = reworkLabels(pr).map(name =>
    name === CONFLICT_LABEL
      ? 'resolve its merge conflicts'
      : 'make the changes its reviews and checks ask for',
  )
  return `Pull request #${pr.number} (${pr.url}) is stuck, labeled ${reworkLabels(pr).join(' and ')}: ${asks.join(' and ')}. Branch ${pr.headRefName}, base ${pr.baseRefName}.`
}

/**
 * act on the labels pr-merger (or a person) puts on the rigs' pull requests: `close` closes the PR and
 * aborts the run whose branch it is; `conflict` or `rework` starts a rework run when the rig has room, then
 * takes the labels off so it starts one only. Out of the tick, like dispatch.
 */
async function labelPass() {
  const stamp = join(HOME, 'labels.stamp')
  if (halted() || (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < LABELS_MS)) return
  writeFileSync(stamp, '')
  const errors: Row[] = []
  const busy = await busyRigs()
  const fields = 'number,url,headRefName,baseRefName,isCrossRepository,labels'
  for (const rig of rigs()) {
    const gh = (...args: string[]) => {
      const p = Bun.spawnSync(['gh', ...args], { cwd: rig.repo, timeout: 60_000 })
      if (p.exitCode !== 0)
        throw new Error(`gh ${args[0]} ${args[1]}: ${p.stderr.toString().trim().split('\n')[0]}`)
      return p.stdout.toString()
    }
    try {
      const search = `label:${[CLOSE_LABEL, ...REWORK_LABELS].join(',')}` // a comma is OR in GitHub search
      const labeled: LabeledPr[] = JSON.parse(
        gh('pr', 'list', '--state', 'open', '--search', search, '--json', fields),
      )
      for (const pr of labeled) {
        const action = labelAction(pr)
        const runId = pr.headRefName.startsWith('factory/')
          ? pr.headRefName.slice('factory/'.length)
          : undefined
        if (action === 'close') {
          gh(
            'pr',
            'close',
            String(pr.number),
            '--comment',
            `Closed by claude-factory: labeled \`${CLOSE_LABEL}\`.`,
          )
          if (
            runId &&
            runIds().includes(runId) &&
            !['done', 'aborted'].includes(where(current(runId).value)[0])
          )
            post(runId, { type: 'ABORT' })
          console.log(`${new Date().toISOString()} closed ${pr.url}${runId ? ` (run ${runId})` : ''}`)
        } else if (action === 'fork') {
          errors.push({
            id: `rig:${rig.name}`,
            error: `${pr.url} is labeled ${reworkLabels(pr).join(', ')} but comes from a fork: rework it there`,
          })
        } else if (action === 'rework' && room(rig, busy) > 0) {
          const { run } = await createTracked('rework', 'rework', rig.repo, reworkGoal(pr))
          busy.push(rig.name)
          gh('pr', 'edit', String(pr.number), '--remove-label', reworkLabels(pr).join(','))
          gh(
            'pr',
            'comment',
            String(pr.number),
            '--body',
            `claude-factory run \`${run.id}\` is reworking this.`,
          )
          console.log(`${new Date().toISOString()} rework ${pr.url} → ${run.id}`)
        }
      }
    } catch (err) {
      errors.push({ id: `rig:${rig.name}`, error: `labels: ${(err as Error).message}` })
    }
  }
  writeJson(join(HOME, 'labels.json'), errors)
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
    agent,
    mcp,
    params,
  }: { max?: string; sweeps?: string; goal?: string; agent?: string; mcp?: string; params?: string[] },
) {
  if (!/^[a-z0-9][\w-]*$/i.test(name)) fail(`a rig's name is letters, digits, - and _ (not "${name}")`)
  const repo = toplevel(path)
  if (!hasBeads(repo)) fail(`${repo} has no .beads: run bd init there first`)
  const def = await loadFactory(factorySource(factory, repo))
  const rig: Rig = { name, repo, factory, ...(goal && { goal }), ...(agent && { agent }) }
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
      const slim = (x: Bead) => ({
        id: x.id,
        title: x.title,
        priority: x.priority,
        type: x.issue_type,
        labels: x.labels,
      })
      return {
        ...w,
        queued: dispatchable(b.ready(), new Set(), 50).map(slim),
        unqueued: b.unqueued().map(slim),
      }
    } catch (err) {
      return { ...w, queued: [], unqueued: [], error: (err as Error).message }
    }
  })
}

/** each rig's open pull requests from run branches, drafts left out: what waits on a review or a merge */
function prs() {
  const fields = 'number,title,url,headRefName,isDraft,reviewDecision,mergeStateStatus,updatedAt'
  return rigs().map(rig => {
    const p = Bun.spawnSync(['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', fields], {
      cwd: rig.repo,
    })
    if (p.exitCode) return { rig: rig.name, prs: [], error: p.stderr.toString().trim() }
    const all: { headRefName: string; isDraft: boolean }[] = JSON.parse(p.stdout.toString())
    return {
      rig: rig.name,
      prs: all
        .filter(x => !x.isDraft && x.headRefName.startsWith('factory/'))
        .map(({ headRefName, isDraft: _, ...x }) => ({ ...x, run: headRefName.slice('factory/'.length) })),
    }
  })
}

/** the runs metrics count: every live run, and the ones factory rm kept in metrics.jsonl */
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
  rig [add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--agent cmd] [--mcp file] [--param name=value]... [--goal text...] | rm <name>]   the factory's
                                     rigs: repos whose ready beads labeled factory start as runs, each with its
                                     own cap, sweeps and a goal the manager works toward; --agent runs every
                                     station as that command (claude, codex or pi), --mcp gives its workers
                                     the MCP servers in a Claude-shaped mcpServers file
  adopt <rig|repo> [template]        copy a factory into <repo>/.factory/ for the repo to own and improve
  queue <rig|repo> <bead> [station]  hand a bead to the factory (labels it factory)
  show <run> | backlog | prs         JSON for the manager's views
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
                                     (each tick starts one a day)
  beads                              one pass of the runs' bead bookkeeping and the rigs' dispatch (each tick starts one)
  tick | loop [--interval ms]        advance every run once, or forever (default 5s), keeping the rigs' sweeps running
  report <run> <seq> <outcome> <summary...>   worker: finish its station
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

if (import.meta.main)
  try {
    switch (cmd) {
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
      case 'manager': {
        // ponytail: blocks until the manager exits; run it where it should live (a herdr pane)
        const p = Bun.spawnSync(managerCommand(args), {
          stdio: ['inherit', 'inherit', 'inherit'],
          env: { ...process.env, CLAUDE_CODE_NO_FLICKER: '1' },
        })
        process.exit(p.exitCode ?? 1)
      }
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
        if (!(days > 0)) fail('usage: factory metrics [--rig r] [--since <days>d] [--json]')
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
        break
      }
      case 'backlog':
        console.log(JSON.stringify(await backlog()))
        break
      case 'prs':
        console.log(JSON.stringify(prs()))
        break
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
        const outcomes = Object.keys(n?.next ?? {}).concat('fail', 'blocked')
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
        const [max, sweeps, agent, mcp] = [opt('--max'), opt('--sweeps'), opt('--agent'), opt('--mcp')]
        const params: string[] = []
        while (args.includes('--param')) params.push(opt('--param') ?? '')
        const [sub = 'list', name, repo, factory = 'lifecycle'] = args
        if (sub === 'add') {
          if (!name || !repo)
            fail(
              'usage: factory rig add <name> <repo> [factory] [--max n] [--sweeps a,b|none] [--agent cmd] [--mcp file] [--param name=value]... [--goal text...]',
            )
          const rig = await defineRig(name!, repo!, factory, { max, sweeps, goal, agent, mcp, params })
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
            `rig ${rig.name}: ${rig.repo} runs ${factory}; its ready beads labeled factory start as runs${rig.maxRuns ? `, at most ${rig.maxRuns} busy` : ''}`,
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
