/** a rig's beads sync state, kept in sync.json under the rig's repo path */
export type SyncEntry = { at: number; error?: string; failures?: number; nextAt?: number; ms?: number }

export const SYNC_BASE_MS = 5 * 60_000 // how often each rig's beads sync with its Dolt remote
export const SYNC_MAX_MS = 60 * 60_000 // the longest wait after a sync fails the same way again and again

/** true when the rig's next sync is due: an old entry with no `nextAt` waits the base interval */
export const syncDue = (entry: SyncEntry | undefined, now: number) =>
  !entry || now >= (entry.nextAt ?? entry.at + SYNC_BASE_MS)

/**
 * the entry after a sync ends. The same error text again doubles the wait (5, 10, 20, 40, 60 min); a
 * different error starts at the base; a success clears the count.
 */
export function nextSyncEntry(
  prev: SyncEntry | undefined,
  result: { error?: string; ms?: number },
  now: number,
): SyncEntry {
  const ms = result.ms
  if (!result.error) return { at: now, failures: 0, ...(ms !== undefined && { ms }) }
  const same = prev?.error === result.error
  const failures = same ? (prev.failures ?? 1) + 1 : 1
  const wait = Math.min(SYNC_BASE_MS * 2 ** (failures - 1), SYNC_MAX_MS)
  return { at: now, error: result.error, failures, nextAt: now + wait, ...(ms !== undefined && { ms }) }
}

/** what the board's rig row says of a failed sync: the error, how often it failed, when the next try is */
export function syncText(entry: SyncEntry | undefined): string | undefined {
  if (!entry?.error) return undefined
  const next = new Date(entry.nextAt ?? entry.at + SYNC_BASE_MS)
  const hhmm = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  return `${entry.error} (sync failed ${entry.failures ?? 1}x, next try ${hhmm})`
}

/** the kill cap of one sync call; FACTORY_SYNC_TIMEOUT_MS sets it */
export const syncTimeoutMs = () => Number(process.env.FACTORY_SYNC_TIMEOUT_MS) || 120_000

const PIPE_GRACE_MS = 1000

/** reads a stream into memory; `text()` gives what has come so far */
function drain(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder()
  let s = ''
  const done = (async () => {
    try {
      for await (const chunk of stream) s += dec.decode(chunk, { stream: true })
    } catch {
      // the stream broke: keep what came
    }
  })()
  return { done, text: () => s }
}

export type Ran = { code: number | null; out: string; err: string; timedOut: boolean }

/**
 * `argv` run in `cwd`, killed after `timeoutMs`. It waits for the process to exit, not for the pipes to
 * close: a child of a killed process can hold them open. A killed call reads no output.
 */
export async function runBounded(
  argv: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number },
): Promise<Ran> {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill(9)
    } catch {
      // already gone
    }
  }, opts.timeoutMs)
  try {
    const out = drain(proc.stdout)
    const err = drain(proc.stderr)
    const code = await proc.exited
    if (timedOut) return { code, out: '', err: '', timedOut }
    // a child that outlives the process can hold a pipe open: wait for the end of the output only a moment
    await Promise.race([Promise.all([out.done, err.done]), new Promise(r => setTimeout(r, PIPE_GRACE_MS))])
    return { code, out: out.text(), err: err.text(), timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** the error text of a call that hit the kill cap */
export const timedOutText = (what: string, timeoutMs: number) =>
  `${what}: timed out after ${Math.round(timeoutMs / 1000)} s`
