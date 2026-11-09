import { OpError, type Ctx, type Input, type RunResult } from '../catalog'

/**
 * The manager mail that the last tick shows.
 * ponytail: the server keeps only the last tick, so a client that reads slower than one tick misses mail.
 * Upgrade path: a server ring of the last 50 mails, as the mod keeps (claude-factory-8llm).
 */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  const b = ctx.board() as { manager?: unknown } | null | undefined
  if (b === null || b === undefined) throw new OpError(503, 'no tick yet')
  return { code: 0, out: JSON.stringify(Array.isArray(b.manager) ? b.manager : []) + '\n', err: '' }
}
