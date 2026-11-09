import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory decisions [list]` */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => print(JSON.stringify(ctx.port.decisionsList())))
}
