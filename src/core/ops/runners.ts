import { byRunner } from '../../../mod/hooks/view'
import type { FactoryRig, FactoryRun } from '../../../mod/types'
import { OpError, type Ctx, type Input, type RunResult } from '../catalog'

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/**
 * The live runs and rigs on each runner: the data of the Runners tab of the mod.
 * The tick holds the full rig objects (env, params). This keeps only the fields that the tab draws.
 */
export async function show(ctx: Ctx, _i: Input): Promise<RunResult> {
  const b = ctx.board() as { rigs?: unknown; runs?: unknown } | null | undefined
  if (b === null || b === undefined) throw new OpError(503, 'no tick yet')
  const groups = byRunner(list<FactoryRig>(b.rigs), list<FactoryRun>(b.runs)).map(g => ({
    name: g.name,
    busy: g.busy,
    rigs: g.rigs.map(r => ({
      name: r.name,
      runner: r.runner,
      sandboxClass: r.sandboxClass,
      maxRuns: r.maxRuns,
    })),
    runs: g.runs.map(r => ({ id: r.id, rig: r.rig, node: r.node, sub: r.sub, model: r.model, pane: r.pane })),
  }))
  return { code: 0, out: JSON.stringify(groups) + '\n', err: '' }
}
