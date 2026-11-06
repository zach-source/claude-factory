import { localLiveRuns, localRunsRefusal, type RunFacts } from './migrate'

/**
 * `factory home split` (claude-factory-akiq.5): which rigs and runs move from the local home to the server home.
 * Pure: it writes nothing. cli.ts does the files.
 */

type SplitRig = { name: string; repo: string; runner?: string }
export type SplitRun = RunFacts & { repo: string }

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
