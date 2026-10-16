import { expect, test } from 'claude-code/testing'
import { pmDue } from '../hooks/view'

// claude-factory-dun.5: pmDue is the pm subagent's pure cadence check. These are plain function
// calls, no `$`, no mocks. mod/tests/pm.test.tsx covers the `$` integration (spawn, turn.complete,
// pm-log.jsonl).

const HOUR = 3_600_000
const MIN = 60_000

test('no plan yet: due at once, even with pmAt 0 (a fresh session, same as every mod test clock)', () => {
  expect(pmDue(0, 0, undefined, false, false)).toEqual({ due: true, wanted: false })
})

test('a fresh plan under 60 min old, no drop: not due', () => {
  expect(pmDue(59 * MIN, 0, 0, false, false)).toEqual({ due: false, wanted: false })
})

test('exactly 60 min old is due (>=, not >)', () => {
  expect(pmDue(60 * MIN, 0, 0, false, false)).toEqual({ due: true, wanted: false })
})

test('a run dropping live wakes the pm again, after the 5 min debounce, even with a fresh plan', () => {
  const pmAt = 10 * MIN
  expect(pmDue(pmAt + 4 * MIN, pmAt, pmAt, true, false)).toEqual({ due: false, wanted: true })
  expect(pmDue(pmAt + 5 * MIN, pmAt, pmAt, true, false)).toEqual({ due: true, wanted: false })
})

test('a drop inside the debounce window is not lost: wanted carries forward until the window elapses', () => {
  const pmAt = 10 * MIN
  const first = pmDue(pmAt + 1 * MIN, pmAt, pmAt, true, false)
  expect(first).toEqual({ due: false, wanted: true })
  // no new drop this check, but the earlier one is still pending
  const second = pmDue(pmAt + 2 * MIN, pmAt, pmAt, false, first.wanted)
  expect(second).toEqual({ due: false, wanted: true })
  const third = pmDue(pmAt + 5 * MIN, pmAt, pmAt, false, second.wanted)
  expect(third).toEqual({ due: true, wanted: false })
})

test('no drop, no staleness: never due, wanted stays false', () => {
  expect(pmDue(30 * MIN, 0, 0, false, false)).toEqual({ due: false, wanted: false })
})

test('the 60 min interval wins over the debounce: a stale plan is due even inside the 5 min window', () => {
  const pmAt = 0
  expect(pmDue(HOUR, pmAt, pmAt, true, false)).toEqual({ due: true, wanted: false })
})

// ---- claude-factory-dun.15: a reload resets pmAt, but the plan's own age still counts ----

test('a hot reload resets pmAt to 0; a plan written 5 min ago is still not due', () => {
  const now = 1000 * HOUR // a real epoch-like time, far past 0: the bug this guards against only
  // shows once `now` is nothing like `pmAt`, since the old check compared `now - pmAt` alone
  const planAt = now - 5 * MIN
  expect(pmDue(now, 0, planAt, false, false)).toEqual({ due: false, wanted: false })
})

test('a hot reload resets pmAt to 0; a plan written 61 min ago is due', () => {
  const now = 1000 * HOUR
  const planAt = now - 61 * MIN
  expect(pmDue(now, 0, planAt, false, false)).toEqual({ due: true, wanted: false })
})

test('a plan whose at is in the future (clock skew) does not count: read as stale', () => {
  const now = 1000 * HOUR
  expect(pmDue(now, 0, now + HOUR, false, false)).toEqual({ due: true, wanted: false })
})
