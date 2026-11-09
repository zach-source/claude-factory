import { refuseWorker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory rig list`: a worker can read it too */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => ctx.port.rigList(print))
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** `factory rig set <rig> ...`: only the person changes a rig, so a worker and a patrol are refused */
export async function set(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    refuseWorker(ctx.env, 'rig set', true)
    await ctx.port.rigSet(
      str(i.name),
      {
        goal: str(i.goal),
        max: str(i.max),
        sweeps: str(i.sweeps),
        runner: str(i.runner),
        agent: str(i.agent),
        mcp: str(i.mcp),
        params: typeof i.params === 'string' ? i.params.split('\n') : [],
      },
      print,
    )
  })
}
