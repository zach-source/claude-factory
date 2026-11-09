// The run reads. The cli.ts helpers come through ctx.port.
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory show [run]` */
export async function show(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => print(JSON.stringify(await ctx.port.show(i.id as string | undefined))))
}

/** `factory status [run]` */
export async function status(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(print => ctx.port.status(i.run as string | undefined, print))
}
