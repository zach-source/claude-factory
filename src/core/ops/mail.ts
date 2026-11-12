import { OpError, type Ctx, type Input, type RunResult } from '../catalog'

/**
 * The manager mail: the last 50 mails of the server when ctx.mail is set, else the mail of the last tick.
 */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  const b = ctx.board() as { manager?: unknown } | null | undefined
  if (b === null || b === undefined) throw new OpError(503, 'no tick yet')
  const m = ctx.mail ? ctx.mail() : b.manager
  return { code: 0, out: JSON.stringify(Array.isArray(m) ? m : []) + '\n', err: '' }
}
