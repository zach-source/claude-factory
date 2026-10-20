import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MANAGER_CWD } from './ax'
import { httpsRemote } from './axrepos'
import { rmSafe } from './home-guard'
import { where } from './machine'

/**
 * `factory migrate-to-ax` (claude-factory-192.5): copy the laptop's factory home to the manager task. This file
 * decides what moves and what blocks the move; cli.ts does the git, tar and ssh.
 */

export type RunFacts = { id: string; live: boolean; pane: string | null; finishedAt: number }

/** one run dir's facts from its state.json: live unless done or aborted; the pane is its worker's address */
export function runFacts(id: string, stateJson: string, mtimeMs: number): RunFacts {
  const snap = JSON.parse(stateJson).snapshot
  const [node] = where(snap.value)
  return {
    id,
    live: !['done', 'aborted'].includes(node),
    pane: snap.context?.pane ?? null,
    finishedAt: snap.context?.log?.at(-1)?.at ?? mtimeMs,
  }
}

/** live runs whose worker is a herdr pane on the laptop: an ax:// worker moves, a pane does not */
export const localLiveRuns = (runs: RunFacts[]) =>
  runs.filter(r => r.live && r.pane && !r.pane.startsWith('ax://'))

export const localRunsRefusal = (runs: RunFacts[]) =>
  `these runs have a worker in a herdr pane on this machine, and a pane cannot move: ${runs
    .map(r => `${r.id} (${r.pane})`)
    .join(
      ', ',
    )}. Finish or abort them, or let them reach a station boundary (a gate or a wait), then run this again.`

/** the finished runs to leave behind: all but the newest `keep` (their metrics.jsonl records are already appended) */
export function runsToMove(runs: RunFacts[], keep: number) {
  const finished = runs.filter(r => !r.live).sort((a, b) => b.finishedAt - a.finishedAt)
  const kept = new Set(finished.slice(0, keep).map(r => r.id))
  return runs.filter(r => r.live || kept.has(r.id)).map(r => r.id)
}

/** git facts of one live run, read by cli.ts before the upload */
export type RunGit = {
  id: string
  branch: string
  /** the run's head is in origin/<branch> */
  onOrigin: boolean
  /** the run's head is in origin/<default branch> */
  merged: boolean
  /** the laptop worktree has uncommitted changes */
  dirty: boolean
  /** the run's base commit is on some origin ref */
  baseOnOrigin: boolean
}

const named = (runs: RunGit[]) => runs.map(r => `${r.id} (${r.branch})`).join(', ')

/** a live run whose work exists only on the laptop: commits on no origin ref, or uncommitted changes */
export function gitRefusal(runs: RunGit[]) {
  const unpushed = runs.filter(r => !r.onOrigin && !r.merged)
  const dirty = runs.filter(r => r.dirty)
  const out = [
    ...(unpushed.length
      ? [
          `these live runs have commits that are not on origin: ${named(unpushed)}. Push them, then run this again.`,
        ]
      : []),
    ...(dirty.length
      ? [
          `these live runs have uncommitted changes in their worktree: ${named(dirty)}. Commit or discard them, then run this again.`,
        ]
      : []),
  ]
  return out.length ? out.join(' ') : undefined
}

/** the marker file migrate writes in runs/<id>/ for a run whose head is merged and whose branch origin lacks */
export const MERGED_MARKER = 'merged-before-move'
export const mergedIds = (runs: RunGit[]) => runs.filter(r => !r.onOrigin && r.merged).map(r => r.id)

/** what the task does to the runs that move: recreate a merged run's gone branch, reset a base that origin lacks */
export const gitNotes = (runs: RunGit[]) => [
  ...runs
    .filter(r => !r.onOrigin && r.merged)
    .map(
      r => `run ${r.id}: branch ${r.branch} is gone from origin: recreated from origin/<default> in the task`,
    ),
  ...runs
    .filter(r => !r.baseOnOrigin)
    .map(
      r =>
        `run ${r.id}: its base commit is on no origin ref: base reset in the task (merge-base with origin/<default>)`,
    ),
]

export type Entry = { name: string; dir: boolean; bytes: number }

/** a small top-level file over this size stays behind, and the plan names it */
export const BIG_FILE = 5 * 1024 * 1024
/** the files and directories that always move, whatever their size */
const REQUIRED = new Set([
  'decisions.json',
  'dispatch.json',
  'metrics.jsonl',
  'manager-sessions.json',
  'memory',
  'launch',
])
/** what never moves: the laptop's lock, its checkout link, caches, logs and the backups of rigs.json */
const NEVER = (name: string) =>
  name === 'rigs.json' ||
  name === 'runs' ||
  name === 'bin' ||
  name === 'devenv' ||
  name === 'tick.lock' ||
  name === 'herdr.log' ||
  /^rigs\.json\./.test(name) ||
  /\.lock$/.test(name)

/** the top-level names to pack (rigs.json and runs/ aside) and the big files left out */
export function selectTop(entries: Entry[]) {
  const take: string[] = []
  const skipped: string[] = []
  for (const e of entries.filter(e => !NEVER(e.name))) {
    if (REQUIRED.has(e.name)) take.push(e.name)
    else if (!e.dir && e.bytes <= BIG_FILE) take.push(e.name)
    else skipped.push(e.name)
  }
  return { take, skipped }
}

type RigRow = { name: string; repo: string; remote?: string }

/**
 * rigs.json for the task: each rig gains `remote`, its origin as https, and keeps `repo` (the task maps it).
 * A rig whose origin `originOf` cannot name stops the move
 */
export function migratedRigs<R extends RigRow>(rigs: R[], originOf: (repo: string) => string | undefined) {
  const bad: string[] = []
  const out = rigs.map(r => {
    if (r.remote) return { ...r, remote: httpsRemote(r.remote) }
    const url = originOf(r.repo)
    if (!url) bad.push(`${r.name} (${r.repo})`)
    return { ...r, ...(url && { remote: httpsRemote(url) }) }
  })
  return {
    rigs: out,
    error: bad.length ? `no origin remote for rig ${bad.join(', ')}: add one or set "remote"` : undefined,
  }
}

/** Claude Code's project dir name for a cwd: each character that is not a letter or a digit becomes `-` */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
/** the archive dir whose contents the unpack moves to the manager's Claude project dir (ax.unpackMigration) */
export const CLAUDE_STAGE = 'claude-project'

type Session = { session: string; cwd: string }

/**
 * what the manager's Claude keeps outside the factory home: its auto-memory and the transcripts of the sessions in
 * manager-sessions.json, under `<config>/projects/<slug of the session's cwd>`. Without the transcript, the host's
 * `--resume` of the last session fails in the task, and without the memory the manager forgets what it learned
 */
export function claudeFiles(sessions: Session[], config: string) {
  const projects = [...new Set(sessions.map(s => join(config, 'projects', projectSlug(s.cwd))))]
  return [
    ...projects.map(p => join(p, 'memory')),
    ...sessions.map(s => join(config, 'projects', projectSlug(s.cwd), `${s.session}.jsonl`)),
  ].filter(f => existsSync(f))
}

const readSessions = (home: string): Session[] => {
  const f = join(home, 'manager-sessions.json')
  const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
  return Array.isArray(v) ? v : []
}

export type Plan = {
  top: string[]
  /** the manager's Claude memory and session transcripts (claudeFiles) */
  claude: string[]
  skipped: string[]
  runs: string[]
  left: number
  bytes: number
  refusal?: string
  /** set by cli.ts from gitRefusal and gitNotes, which need git */
  gitRefusal?: string
  gitNotes?: string[]
  rigsError?: string
  rigs: (RigRow & { remote?: string })[]
}

const sizeOf = (path: string): number => {
  const s = statSync(path)
  return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + sizeOf(join(path, f)), 0) : s.size
}

/** read the home and decide what moves. Writes nothing */
export function plan(
  home: string,
  keep: number,
  originOf: (repo: string) => string | undefined,
  config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
): Plan {
  const entries = readdirSync(home, { withFileTypes: true }).map(d => ({
    name: d.name,
    dir: d.isDirectory(),
    bytes: d.isDirectory() ? 0 : statSync(join(home, d.name)).size,
  }))
  const { take, skipped } = selectTop(entries)
  const runsDir = join(home, 'runs')
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && existsSync(join(runsDir, d.name, 'state.json')))
        .map(d => {
          const f = join(runsDir, d.name, 'state.json')
          return runFacts(d.name, readFileSync(f, 'utf8'), statSync(f).mtimeMs)
        })
    : []
  const local = localLiveRuns(runs)
  const move = runsToMove(runs, keep)
  const rigsFile = join(home, 'rigs.json')
  const m = migratedRigs(existsSync(rigsFile) ? JSON.parse(readFileSync(rigsFile, 'utf8')) : [], originOf)
  const claude = claudeFiles(readSessions(home), config)
  const bytes =
    take.reduce((n, f) => n + sizeOf(join(home, f)), 0) +
    claude.reduce((n, f) => n + sizeOf(f), 0) +
    move.reduce((n, id) => n + sizeOf(join(runsDir, id)), 0) +
    statSync(rigsFile).size
  return {
    top: take,
    claude,
    skipped,
    runs: move,
    left: runs.length - move.length,
    bytes,
    refusal: local.length ? localRunsRefusal(local) : undefined,
    rigsError: m.error,
    rigs: m.rigs,
  }
}

export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** the plan in words, for --dry-run and before an upload */
export const describe = (p: Plan) =>
  [
    `moves: ${p.top.join(', ')}, and ${p.runs.length} run dirs (${p.left} finished runs stay behind)`,
    `the manager's Claude: ${p.claude.length ? p.claude.map(f => basename(f)).join(', ') : 'nothing found (no memory or transcript)'}`,
    ...(p.skipped.length ? [`left behind (big or laptop-only): ${p.skipped.join(', ')}`] : []),
    ...(p.gitNotes ?? []),
    `size before compression: ${mb(p.bytes)}`,
  ].join('\n')

/**
 * pack the plan into `out` (a tar.gz): the files by name, the live runs' dirs, and from a temp dir the migrated
 * rigs.json, manager-sessions.json with each cwd set to the task's, and the manager's Claude files under
 * CLAUDE_STAGE. `tar -C` before each group keeps every name relative to the factory home
 */
export function pack(home: string, p: Plan, out: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-migrate-'))
  try {
    writeFileSync(join(tmp, 'rigs.json'), JSON.stringify(p.rigs, null, 2) + '\n')
    const sessions = readSessions(home).map(s => ({ ...s, cwd: MANAGER_CWD }))
    writeFileSync(join(tmp, 'manager-sessions.json'), JSON.stringify(sessions, null, 2) + '\n')
    // ponytail: memory dirs of several cwds merge into one; the manager has had one cwd so far
    for (const f of p.claude) cpSync(f, join(tmp, CLAUDE_STAGE, basename(f)), { recursive: true })
    // ponytail: names go on the command line (a few hundred at most), not -T: bsdtar reads a -T list after the last -C
    const names = [
      ...p.top.filter(n => n !== 'manager-sessions.json'),
      ...p.runs.map(id => `runs/${id}`),
    ].map(n => `./${n}`)
    const fromTmp = ['rigs.json', 'manager-sessions.json', ...(p.claude.length ? [CLAUDE_STAGE] : [])]
    // COPYFILE_DISABLE: macOS tar adds an AppleDouble ._ file for each file with extended attributes
    const r = Bun.spawnSync(['tar', '-czf', out, '-C', home, ...names, '-C', tmp, ...fromTmp], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr.toString().trim().split('\n').at(-1)}`)
    return statSync(out).size
  } finally {
    rmSafe(tmp, { recursive: true, force: true })
  }
}
