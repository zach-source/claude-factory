import { flowGraph, parseSince } from '../../flows'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory flows [--factory f] [--since 24h]` and GET /v1/flows: the workflow graph as JSON (spec 008, FR-025) */
export async function show(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    const now = Date.now()
    const since = parseSince(i.since as string | undefined, now)
    const { def, runs } = await ctx.port.flowData(i.factory as string | undefined)
    print(JSON.stringify(flowGraph({ def, runs, since, now })))
  })
}
