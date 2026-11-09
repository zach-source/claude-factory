import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory backlog` */
export async function show(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(async print => print(JSON.stringify(await ctx.port.backlog())))
}
