import { leaseLine, readLease, release as dropLease } from '../../lease'
import { refuseWorker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory lease [status]`: a worker or a patrol must not read the lease */
export async function show(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => {
    refuseWorker(ctx.env, 'lease', true)
    print(leaseLine(readLease(ctx.home), Date.now()))
  })
}

/** `factory lease release` */
export async function release(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => {
    refuseWorker(ctx.env, 'lease', true)
    dropLease(ctx.home)
    print('released the manager lease')
  })
}
