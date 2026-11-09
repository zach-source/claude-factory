import { refuseWorker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory stop` and `factory resume` */
export async function halt(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(print => {
    const mode = i.mode
    if (mode !== 'stop' && mode !== 'resume') throw new Error('usage: factory stop | factory resume')
    refuseWorker(ctx.env, mode, true)
    ctx.port.halt(mode, print)
  })
}
