// The run reads. The cli.ts helpers come through ctx.port.
import { refuseWorker } from '../caller'
import { inProc, OpError, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory show [run]` */
export async function show(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => print(JSON.stringify(await ctx.port.show(i.id as string | undefined))))
}

/** the last screen of the run's worker: the exact text, no added newline; a reason on err when there is none */
export async function screen(ctx: Ctx, i: Input): Promise<RunResult> {
  try {
    return { code: 0, out: await ctx.port.screen(i.id as string), err: '' }
  } catch (e) {
    if (e instanceof OpError || !(e instanceof Error)) throw e
    return { code: 1, out: '', err: `factory: ${e.message}\n` }
  }
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

/** `factory mail <run> <station> <text...>` as the manager; the sender rule reads i.cwd, never the cwd of this process */
export async function mail(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    const cwd = i.cwd
    if (typeof cwd !== 'string') throw new Error('mail needs the working directory of the sender')
    await ctx.port.mail(
      {
        id: i.id as string | undefined,
        to: i.to as string | undefined,
        text: i.text as string,
        wake: i.wake === true,
      },
      { env: ctx.env, cwd },
      print,
    )
  })
}
