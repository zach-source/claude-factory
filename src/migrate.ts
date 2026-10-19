import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpsRemote } from './axrepos'
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

export type Plan = {
  top: string[]
  skipped: string[]
  runs: string[]
  left: number
  bytes: number
  refusal?: string
  rigsError?: string
  rigs: (RigRow & { remote?: string })[]
}

const sizeOf = (path: string): number => {
  const s = statSync(path)
  return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + sizeOf(join(path, f)), 0) : s.size
}

/** read the home and decide what moves. Writes nothing */
export function plan(home: string, keep: number, originOf: (repo: string) => string | undefined): Plan {
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
  const bytes =
    take.reduce((n, f) => n + sizeOf(join(home, f)), 0) +
    move.reduce((n, id) => n + sizeOf(join(runsDir, id)), 0) +
    statSync(rigsFile).size
  return {
    top: take,
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
    ...(p.skipped.length ? [`left behind (big or laptop-only): ${p.skipped.join(', ')}`] : []),
    `size before compression: ${mb(p.bytes)}`,
  ].join('\n')

/**
 * pack the plan into `out` (a tar.gz): the files by name, the live runs' dirs, and the migrated rigs.json from a
 * temp dir. `tar -C` before each group keeps every name relative to the factory home
 */
export function pack(home: string, p: Plan, out: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-migrate-'))
  writeFileSync(join(tmp, 'rigs.json'), JSON.stringify(p.rigs, null, 2) + '\n')
  // ponytail: names go on the command line (a few hundred at most), not -T: bsdtar reads a -T list after the last -C
  const names = [...p.top, ...p.runs.map(id => `runs/${id}`)].map(n => `./${n}`)
  const r = Bun.spawnSync(['tar', '-czf', out, '-C', home, ...names, '-C', tmp, 'rigs.json'], {
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr.toString().trim().split('\n').at(-1)}`)
  return statSync(out).size
}
