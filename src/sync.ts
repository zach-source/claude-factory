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

/** the kill cap of one sync call; FACTORY_SYNC_TIMEOUT_MS sets it */
export const syncTimeoutMs = () => Number(process.env.FACTORY_SYNC_TIMEOUT_MS) || 120_000

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
    const out = new Response(proc.stdout).text()
    const err = new Response(proc.stderr).text()
    const code = await proc.exited
    if (timedOut) return { code, out: '', err: '', timedOut }
    return { code, out: await out, err: await err, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** the error text of a call that hit the kill cap */
export const timedOutText = (what: string, timeoutMs: number) =>
  `${what}: timed out after ${Math.round(timeoutMs / 1000)} s`
