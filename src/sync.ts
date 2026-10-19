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
