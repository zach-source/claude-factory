import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory rig list`: a worker can read it too */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => ctx.port.rigList(print))
}
