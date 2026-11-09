import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory plan [show]` */
export async function show(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => print(ctx.port.planShowText()))
}
