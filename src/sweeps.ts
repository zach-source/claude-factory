// Pure logic behind the standing sweeps (factories/sweeps.ts).
// cli.ts's `sweep()` does the effects: it starts a run. It runs a rig's `--slo` command.
// It reads and writes bd.
import type { Factory } from './machine'

/** the goal a sweep pass's run carries. `dueSweeps` uses this to find a live run for a sweep. */
export const sweepGoal = (station: string) => `sweep: ${station}`

/** Node ids a factory marks as sweep stations: those with `everyMin` set. This replaces a hardcoded
 * station list, so a factory other than factories/sweeps.ts can carry its own sweep stations too. */
export const sweepNames = (def: Factory): string[] =>
  Object.keys(def.nodes).filter(id => def.nodes[id]!.everyMin)

/** sweeps.json's shape: for each rig, for each sweep, when it last ran, and (monitor only) its last read. */
export type SweepState = Record<string, Record<string, { lastAt: number; sig?: string; lines?: number }>>

export type LiveRun = { repo: string; goal: string }

/**
 * The sweeps due now for `rig`. A sweep is due when all of these hold:
 * - it is in `rig.sweeps` (unset means every sweep station `def` has)
 * - it is not `monitor` on a rig with no `rig.slo` set (monitor has nothing to read there)
 * - the rig's repo has no live run with its goal (`sweepGoal`), in any factory: a pinned lifecycle
 *   sweep run still blocks a new one, the same as a run of `def` itself
 * - its last pass, from `state`, is at least `everyMin` minutes old
 *
 * `liveRuns` must already exclude done and aborted runs: this function only matches repo and goal.
 */
export function dueSweeps(
  def: Factory,
  rig: { name: string; repo: string; sweeps?: string[]; slo?: string },
  state: SweepState,
  liveRuns: LiveRun[],
  now: number,
): string[] {
  const names = (rig.sweeps ?? sweepNames(def)).filter(s => def.nodes[s]?.everyMin)
  return names.filter(s => {
    if (s === 'monitor' && !rig.slo) return false
    const goal = sweepGoal(s)
    if (liveRuns.some(r => r.repo === rig.repo && r.goal === goal)) return false
    const lastAt = state[rig.name]?.[s]?.lastAt ?? 0
    return now - lastAt >= def.nodes[s]!.everyMin! * 60_000
  })
}
