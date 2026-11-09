import { readLog } from '../../once'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

const LOGS = {
  patrol: 'patrol-log.jsonl',
  pm: 'pm-log.jsonl',
  brief: 'brief-log.jsonl',
  review: 'review-log.jsonl',
}

/** The last report of each manager step: the last entry of its log that parses, else null. */
export async function reports(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print =>
    print(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(LOGS).map(([k, file]) => [k, readLog(ctx.home, file).at(-1) ?? null]),
        ),
      ),
    ),
  )
}
