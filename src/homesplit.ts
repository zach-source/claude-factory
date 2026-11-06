import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { rmSafe } from './home-guard'
import { localLiveRuns, localRunsRefusal, migratedRigs, runFacts, selectTop, type RunFacts } from './migrate'

/**
 * `factory home split|join` (claude-factory-akiq.5, spec 004-factory-server step S2).
 * Each rig belongs to one home. `split` moves the AX rigs and their runs to a server home dir.
 * `join` brings them back. The tombstone `home-split.json` stays in the local home while the rigs live elsewhere.
 */

type RigRow = { name: string; repo: string; factory: string; runner?: string; remote?: string }
export type Tombstone = { to: string; at: string; rigs: RigRow[]; runs: string[] }
export type EditRigs = (fn: (list: RigRow[]) => RigRow[]) => void
export type SplitPlan = { moveRigs: RigRow[]; keepRigs: RigRow[]; moveRuns: string[]; refusal?: string }

export const tombstoneFile = (home: string) => join(home, 'home-split.json')

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const rowsOf = (home: string): RigRow[] =>
  existsSync(join(home, 'rigs.json')) ? readJson(join(home, 'rigs.json')) : []
const runDirs = (home: string) => {
  const d = join(home, 'runs')
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()) : []
}
/** the repo a run dir names in run.json; undefined when the file is missing or unreadable */
function runRepo(dir: string): string | undefined {
  try {
    const r = readJson(join(dir, 'run.json')).repo
    return typeof r === 'string' ? r : undefined
  } catch {
    return undefined
  }
}

/** Read the tombstone. None when the file is absent. Throw when it is unreadable or has a bad shape (fail closed). */
export function tombstone(home: string): Tombstone | undefined {
  const f = tombstoneFile(home)
  if (!existsSync(f)) return undefined
  let t: any
  try {
    t = readJson(f)
  } catch (e) {
    throw new Error(`${f} is unreadable: ${(e as Error).message}`)
  }
  const ok =
    typeof t?.to === 'string' &&
    typeof t.at === 'string' &&
    Array.isArray(t.rigs) &&
    t.rigs.every((r: any) => typeof r?.name === 'string' && typeof r.repo === 'string') &&
    Array.isArray(t.runs) &&
    t.runs.every((r: any) => typeof r === 'string')
  if (!ok) throw new Error(`${f} has a bad shape: expected {to, at, rigs:[{name, repo}], runs:[id]}`)
  return t
}

const inside = (a: string, b: string) => {
  const [x, y] = [resolve(a), resolve(b)]
  return x === y || x.startsWith(y + sep)
}

/** Decide what moves to `to`. Writes nothing. */
export function splitPlan(
  home: string,
  to: string,
  originOf: (repo: string) => string | undefined,
): SplitPlan {
  const all = rowsOf(home)
  const moveRigs = all.filter(r => r.runner === 'ax')
  const keepRigs = all.filter(r => r.runner !== 'ax')
  const repos = new Set(moveRigs.map(r => r.repo))
  const runsDir = join(home, 'runs')
  const moveRuns = runDirs(home)
    .filter(d => {
      const repo = runRepo(join(runsDir, d.name))
      return repo !== undefined && repos.has(repo)
    })
    .map(d => d.name)
  const plan: SplitPlan = { moveRigs, keepRigs, moveRuns }
  const refuse = (m: string) => ({ ...plan, refusal: m })
  if (!moveRigs.length) return refuse('no rig has runner "ax": nothing to move to a server home')
  if (existsSync(tombstoneFile(home)))
    return refuse(`${tombstoneFile(home)} exists: this home is already split. Run factory home join first`)
  if (inside(to, home) || inside(home, to))
    return refuse(`${to} and the home ${home} must not hold each other`)
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length))
    return refuse(`${to} exists and is not an empty directory`)
  const m = migratedRigs(moveRigs as (RigRow & { remote?: string })[], originOf)
  if (m.error) return refuse(m.error)
  const facts: RunFacts[] = []
  for (const id of moveRuns) {
    const f = join(runsDir, id, 'state.json')
    if (!existsSync(f)) continue
    try {
      facts.push(runFacts(id, readFileSync(f, 'utf8'), statSync(f).mtimeMs))
    } catch {
      return refuse(`run ${id} has an unreadable state.json: fix or abort it, then run this again`)
    }
  }
  const local = localLiveRuns(facts)
  if (local.length) return refuse(localRunsRefusal(local))
  return plan
}

/**
 * Do the split. The write order keeps the local home whole until the tombstone exists.
 * Order: files and runs in `to`, `to`/rigs.json, the tombstone, the rig edit, the local run dirs.
 * If the split stops before the tombstone, the local home is unchanged and nothing uses `to`.
 */
export function split(
  home: string,
  to: string,
  plan: SplitPlan,
  originOf: (repo: string) => string | undefined,
  editRigs: EditRigs,
  now = new Date(),
) {
  if (plan.refusal) throw new Error(plan.refusal)
  mkdirSync(join(to, 'runs'), { recursive: true })
  const entries = readdirSync(home, { withFileTypes: true }).map(d => ({
    name: d.name,
    dir: d.isDirectory(),
    bytes: d.isDirectory() ? 0 : statSync(join(home, d.name)).size,
  }))
  for (const name of selectTop(entries).take)
    if (name !== 'manager-sessions.json') cpSync(join(home, name), join(to, name), { recursive: true })
  for (const id of plan.moveRuns) cpSync(join(home, 'runs', id), join(to, 'runs', id), { recursive: true })
  writeFileSync(
    join(to, 'rigs.json'),
    JSON.stringify(migratedRigs(plan.moveRigs, originOf).rigs, null, 2) + '\n',
  )
  const t: Tombstone = { to: resolve(to), at: now.toISOString(), rigs: plan.moveRigs, runs: plan.moveRuns }
  writeFileSync(tombstoneFile(home), JSON.stringify(t, null, 2) + '\n')
  const gone = new Set(plan.moveRigs.map(r => r.name))
  editRigs(list => list.filter(r => !gone.has(r.name)))
  for (const id of plan.moveRuns) rmSafe(join(home, 'runs', id), { recursive: true, force: true })
}

/** Why `join` cannot run, or undefined. Writes nothing. */
export function joinRefusal(home: string, from: string): string | undefined {
  const t = tombstone(home)
  if (!t) return `${tombstoneFile(home)} is missing: this home is not split`
  if (!existsSync(join(from, 'rigs.json')))
    return `${from}/rigs.json is missing: ${from} is not a server home`
  const have = new Set(rowsOf(home).map(r => r.name))
  const clash = rowsOf(from)
    .filter(r => t.rigs.some(x => x.name === r.name))
    .filter(r => have.has(r.name))
  if (clash.length) return `rig ${clash.map(r => r.name).join(', ')} already exists in ${home}`
  const ids = new Set(runDirs(home).map(d => d.name))
  const dup = joinRuns(t, from).filter(id => ids.has(id))
  if (dup.length) return `run ${dup.join(', ')} already exists in ${home}`
}

/** the run dirs in `from` that belong to a rig named in the tombstone */
const joinRuns = (t: Tombstone, from: string) => {
  const repos = new Set(t.rigs.map(r => r.repo))
  return runDirs(from)
    .filter(d => {
      const repo = runRepo(join(from, 'runs', d.name))
      return repo !== undefined && repos.has(repo)
    })
    .map(d => d.name)
}

/** The inverse of split. The rigs get their laptop repo path back. The tombstone goes last. */
export function join_(home: string, from: string, editRigs: EditRigs) {
  const refusal = joinRefusal(home, from)
  if (refusal) throw new Error(refusal)
  const t = tombstone(home)!
  const runs = joinRuns(t, from)
  mkdirSync(join(home, 'runs'), { recursive: true })
  for (const id of runs) cpSync(join(from, 'runs', id), join(home, 'runs', id), { recursive: true })
  const back = rowsOf(from)
    .filter(r => t.rigs.some(x => x.name === r.name))
    .map(r => {
      const orig = t.rigs.find(x => x.name === r.name)!
      const { remote: _server, ...rest } = r
      return { ...rest, repo: orig.repo, ...(orig.remote && { remote: orig.remote }) }
    })
  editRigs(list => [...list, ...back])
  rmSafe(tombstoneFile(home), { force: true })
}
