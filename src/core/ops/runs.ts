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

/** `factory start <factory>[@station] <rig> <goal...>`; the server gives no ctx.tick: its own loop launches the first worker */
export async function start(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    refuseWorker(ctx.env, 'start')
    const f = i.factory as string | undefined
    const spec = f && i.station ? `${f}@${i.station}` : f
    const m = {
      spec,
      rig: i.rig as string | undefined,
      goal: (i.goal as string | undefined) ?? '',
      owned: i.owned === true,
    }
    await ctx.port.start(m, { env: ctx.env }, print, ctx.tick)
  })
}

/** `factory queue <rig> <bead> [station]`; a patrol must not queue a bead it may not start (ctx.env, never process.env) */
export async function queue(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(print => {
    refuseWorker(ctx.env, 'queue')
    ctx.port.queue(
      {
        rig: i.rig as string | undefined,
        bead: i.bead as string | undefined,
        station: i.station as string | undefined,
      },
      { env: ctx.env },
      print,
    )
  })
}
