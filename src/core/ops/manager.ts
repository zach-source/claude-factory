import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

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
