import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendLog, readLog } from '../../once'
import { BRIEFER_LOG_CAP, PATROL_LOG_CAP, PM_LOG_CAP, REVIEWER_LOG_CAP } from '../../../mod/hooks/view'
import { inProc, OpError, type Ctx, type Input, type RunResult } from '../catalog'

/** the window of a model that the transcript does not tell; a larger use means the 1M window */
export const DEFAULT_WINDOW = 200_000
export const LARGE_WINDOW = 1_000_000
const TAIL = 262_144

export type ManagerContext = { model: string; tokens: number; window: number; percent: number }

/**
 * The model and the context use after the last assistant turn of a Claude transcript (JSONL text).
 * Tokens are the input, the cache reads and writes, and the output of that turn: the next turn carries them all.
 */
export function contextOf(text: string, window = DEFAULT_WINDOW): ManagerContext | undefined {
  for (const l of text.split('\n').reverse()) {
    let m: { type?: string; message?: { model?: string; usage?: Record<string, unknown> } }
    try {
      m = JSON.parse(l)
    } catch {
      continue
    }
    const u = m.message?.usage
    const model = m.message?.model
    if (m.type !== 'assistant' || !u || !model || model.startsWith('<')) continue
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
    const tokens =
      n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens')
    const w = tokens > window ? Math.max(window, LARGE_WINDOW) : window
    return { model, tokens, window: w, percent: Math.round((tokens * 1000) / w) / 10 }
  }
  return undefined
}

/** the name of the Claude projects directory of a working directory */
export const projectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** the last bytes of a file, as text */
function tail(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const buf = Buffer.alloc(Math.min(size, TAIL))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * `manager.context`: the model and the context use of the manager's Claude session (claude-factory-62v95).
 * It reads the newest transcript in the Claude project of the manager's directory.
 * ponytail: the directory is the parent of the factory home (FACTORY_MANAGER_CWD sets it) and the window is
 * FACTORY_MANAGER_WINDOW or 200k. Upgrade path: the session reports its own window.
 */
export async function context(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => {
    const env = ctx.env
    const config = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? '', '.claude')
    const dir = join(config, 'projects', projectDir(env.FACTORY_MANAGER_CWD ?? dirname(ctx.home)))
    let files: { f: string; at: number }[] = []
    try {
      files = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    } catch {}
    const newest = files.sort((a, b) => b.at - a.at)[0]
    const w = Number(env.FACTORY_MANAGER_WINDOW)
    const c = newest && contextOf(tail(newest.f), w > 0 ? w : DEFAULT_WINDOW)
    // no session is a normal state (a local manager has none here): null, not an error
    print(JSON.stringify(newest && c ? { ...c, at: newest.at } : null))
  })
}

/** the log of each kind that the manager task reports: its file and its cap */
const LOGS: Record<string, [file: string, cap: number]> = {
  patrol: ['patrol-log.jsonl', PATROL_LOG_CAP],
  pm: ['pm-log.jsonl', PM_LOG_CAP],
  brief: ['brief-log.jsonl', BRIEFER_LOG_CAP],
  review: ['review-log.jsonl', REVIEWER_LOG_CAP],
  // ponytail: fixed caps for usage and health; make them settings when a reader needs more rows
  usage: ['manager-usage.jsonl', 5000],
  health: ['manager-health.jsonl', 200],
}

/** `manager.log`: the manager task adds one row to a log of the factory home. `entry` is one JSON object. */
export async function log(ctx: Ctx, i: Input): Promise<RunResult> {
  const [file, cap] = Object.hasOwn(LOGS, i.kind as string) ? LOGS[i.kind as string]! : []
  if (!file || !cap) throw new OpError(422, 'unknown log kind')
  let row: unknown
  try {
    row = JSON.parse(i.entry as string)
  } catch {}
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new OpError(422, 'entry must be a JSON object')
  appendLog(ctx.home, file, cap, row)
  return { code: 0, out: 'logged\n', err: '' }
}

/** `manager.show`: the last health row of the manager task, or null when it never reported */
export async function show(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => print(JSON.stringify({ health: readLog(ctx.home, LOGS.health![0]).at(-1) ?? null })))
}

/** `manager.brief`: what a new manager session reads first (the contract says: replaces the transcript resume) */
export async function brief(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(async print => {
    const board = ctx.board() as { manager?: unknown } | null | undefined
    print(
      JSON.stringify({
        decisions: await ctx.port.decisionsList(),
        mail: Array.isArray(board?.manager) ? board.manager : [],
        plan: await ctx.port.planShowText(),
        patrol: readLog(ctx.home, LOGS.patrol![0]).slice(-20),
      }),
    )
  })
}

/** `manager.say`: type text into the manager pane. The person only (the catalog marks it owner). */
export async function say(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    await ctx.port.say(i.text as string)
    print('sent')
  })
}
