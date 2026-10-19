import { expect, test } from 'bun:test'
import { nextSyncEntry, syncDue, SYNC_BASE_MS, SYNC_MAX_MS } from './sync'

const MIN = 60_000

test('a rig never synced is due; a fresh success waits the base interval', () => {
  expect(syncDue(undefined, 1000)).toBe(true)
  const e = nextSyncEntry(undefined, { ms: 40 }, 1000)
  expect(e).toEqual({ at: 1000, failures: 0, ms: 40 })
  expect(syncDue(e, 1000 + SYNC_BASE_MS - 1)).toBe(false)
  expect(syncDue(e, 1000 + SYNC_BASE_MS)).toBe(true)
})

test('the same error doubles the wait up to the cap: 5, 10, 20, 40, 60, 60 min', () => {
  let e = nextSyncEntry(undefined, { error: 'x', ms: 1 }, 0)
  const waits = [e.nextAt! - e.at]
  for (let i = 0; i < 5; i++) {
    e = nextSyncEntry(e, { error: 'x', ms: 1 }, e.nextAt!)
    waits.push(e.nextAt! - e.at)
  }
  expect(waits).toEqual([5, 10, 20, 40, 60, 60].map(m => m * MIN))
  expect(e.failures).toBe(6)
  expect(waits.at(-1)).toBe(SYNC_MAX_MS)
})

test('a different error resets the wait to the base; a success resets the count', () => {
  const a = nextSyncEntry(undefined, { error: 'x' }, 0)
  const b = nextSyncEntry(a, { error: 'x' }, 10)
  expect(b.failures).toBe(2)
  const c = nextSyncEntry(b, { error: 'y' }, 20)
  expect(c.failures).toBe(1)
  expect(c.nextAt).toBe(20 + SYNC_BASE_MS)
  const d = nextSyncEntry(c, { ms: 5 }, 30)
  expect(d.failures).toBe(0)
  expect(d.error).toBeUndefined()
  expect(d.nextAt).toBeUndefined()
})

test('an old {at, error} entry is due at + 5 min, and counts as one failure', () => {
  const old = { at: 1000, error: 'x' }
  expect(syncDue(old, 1000 + SYNC_BASE_MS - 1)).toBe(false)
  expect(syncDue(old, 1000 + SYNC_BASE_MS)).toBe(true)
  expect(nextSyncEntry(old, { error: 'x' }, 5000).failures).toBe(2)
})

test('nextAt wins over at when set', () => {
  expect(syncDue({ at: 0, error: 'x', failures: 3, nextAt: 20 * MIN }, 19 * MIN)).toBe(false)
  expect(syncDue({ at: 0, error: 'x', failures: 3, nextAt: 20 * MIN }, 20 * MIN)).toBe(true)
})
