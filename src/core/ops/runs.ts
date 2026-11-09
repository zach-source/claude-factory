// The run reads. The cli.ts helpers come through ctx.port.
import { refuseWorker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory show [run]` */
export async function show(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => print(JSON.stringify(await ctx.port.show(i.id as string | undefined))))
}

/** `factory status [run]` */
export async function status(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(print => ctx.port.status(i.run as string | undefined, print))
}

/** `factory goto <run> <station>` */
export async function goto(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    refuseWorker(ctx.env, 'goto')
    await ctx.port.goto(i.id as string | undefined, i.node as string | undefined, print)
  })
}

/** `factory abort <run>` */
export async function abort(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(() => {
    refuseWorker(ctx.env, 'abort')
    ctx.port.abort(i.id as string | undefined)
  })
}
