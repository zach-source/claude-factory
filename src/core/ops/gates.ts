import { workerMarker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory gate-brief facts <run>` */
export async function brief(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print =>
    print(JSON.stringify(await ctx.port.gateBriefFacts(i.id as string | undefined))),
  )
}

/** `factory decide <run> <outcome> [note...]` */
export async function decide(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    // ponytail: an env check, not a lock: it stops a worker deciding by habit, not one set on it
    if (workerMarker(false, ctx.env))
      throw new Error('a worker cannot decide a gate: mail the manager instead')
    // claude-factory-72v.19: same second CLI-side layer as beadFor's isOwned check,
    // behind the mod's own regex deny for this command.
    if (ctx.env.FACTORY_PATROL) throw new Error('a patrol cannot decide a gate: leave it for the person')
    await ctx.port.decide(
      i.id as string | undefined,
      i.outcome as string | undefined,
      (i.note as string | undefined) ?? '',
      print,
    )
  })
}
