import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory gate-brief facts <run>` */
export async function brief(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print =>
    print(JSON.stringify(await ctx.port.gateBriefFacts(i.id as string | undefined))),
  )
}
