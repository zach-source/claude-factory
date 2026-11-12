import { workerMarker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory decisions [list]` */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(async print => print(JSON.stringify(await ctx.port.decisionsList())))
}

/** `factory decisions answer <rig> <bead> <text...>` */
export async function answer(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(print => {
    if (workerMarker(false, ctx.env))
      throw new Error("a worker cannot answer the person's decisions: mail the manager instead")
    // claude-factory-72v.19: same second CLI-side layer as beadFor's isOwned check,
    // behind the mod's own regex deny for this command.
    if (ctx.env.FACTORY_PATROL)
      throw new Error("a patrol cannot answer the person's decisions: leave it for them")
    ctx.port.decisionsAnswer(i.rig as string, i.bead as string, i.text as string, print)
  })
}
