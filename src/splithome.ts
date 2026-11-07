import { localLiveRuns, localRunsRefusal, type RunFacts } from './migrate'

/**
 * `factory home split` (claude-factory-akiq.5): which rigs and runs move from the local home to the server home.
 * Pure: it writes nothing. cli.ts does the files.
 */

type SplitRig = { name: string; repo: string; runner?: string }
export type SplitRun = RunFacts & { repo: string }

/** the rigs a server home must not hold: any rig whose runner is not exactly 'ax' */
export const nonAxRigs = (rigs: { name: string; runner?: string }[]) =>
  rigs.filter(r => r.runner !== 'ax').map(r => r.name)

/** throw when the server home holds a non-AX rig. A missing or empty rigs.json passes. */
export function assertServerRigs(rigs: { name: string; runner?: string }[]) {
  const bad = nonAxRigs(rigs)
  if (bad.length) throw new Error(`server home holds non-AX rigs: ${bad.join(', ')}`)
}

/** the tick for `factory server`: it reads rigs.json again before each tick and never ticks a non-AX rig */
export const guardedTick =
  (tick: () => unknown, readRigs: () => { name: string; runner?: string }[]) => () => {
    assertServerRigs(readRigs())
    return tick()
  }

/** in server mode a station runs on the ax runner only; `name` is the runner name the station resolved to */
export function assertAxRunner(name: string, serverMode: boolean) {
  if (serverMode && name !== 'ax') throw new Error(`server home runs the ax runner only, not "${name}"`)
}

/**
 * `rig add` check against split.json (the text of the file, or undefined when it is absent).
 * A rig that moved to a server home must not come back by name or by repo.
 * Text that is not a JSON array refuses (fail closed).
 */
export function movedRigRefusal(
  splitJson: string | undefined,
  name: string,
  repo: string,
  canon: (path: string) => string = p => p,
) {
  if (splitJson === undefined) return undefined
  let moved: unknown
  try {
    moved = JSON.parse(splitJson)
  } catch {}
  if (!Array.isArray(moved)) return 'split.json is not a JSON array: fix or remove it before rig add'
  const hit = moved.find(
    m => m?.name === name || (typeof m?.repo === 'string' && canon(m.repo) === canon(repo)),
  )
  return hit
    ? `rig ${hit.name} (${hit.repo}) moved to the server home ${hit.to} (split.json): add it there, or remove the split.json entry to take it back`
    : undefined
}

/** a rig moves only when its runner is exactly 'ax'; a live run of a moved rig moves with it unless a herdr pane holds it */
export function splitPlan<R extends SplitRig>(rigs: R[], runs: SplitRun[]) {
  const refuse = (error: string) => ({ move: [] as R[], stay: rigs, runs: [] as string[], error })
  for (const key of ['name', 'repo'] as const) {
    const seen = new Set<string>()
    for (const r of rigs) {
      if (seen.has(r[key])) return refuse(`two rigs have the ${key} ${r[key]}: fix rigs.json first`)
      seen.add(r[key])
    }
  }
  const move = rigs.filter(r => r.runner === 'ax')
  if (!move.length) return refuse('no rig has runner "ax": nothing to move')
  const repos = new Set(move.map(r => r.repo))
  const mine = runs.filter(r => repos.has(r.repo))
  const stuck = localLiveRuns(mine)
  if (stuck.length) return refuse(localRunsRefusal(stuck))
  return {
    move,
    stay: rigs.filter(r => r.runner !== 'ax'),
    runs: mine.filter(r => r.live).map(r => r.id),
    error: undefined as string | undefined,
  }
}
