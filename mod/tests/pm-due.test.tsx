import { expect, test } from 'claude-code/testing'
import { pmDue } from '../hooks/view'

// claude-factory-dun.5: pmDue is the pm subagent's pure cadence check. These are plain function
// calls, no `$`, no mocks. mod/tests/pm.test.tsx covers the `$` integration (spawn, turn.complete,
// pm-log.jsonl).

const HOUR = 3_600_000
const MIN = 60_000

test('no plan yet: due at once, even with pmAt 0 (a fresh session, same as every mod test clock)', () => {
  expect(pmDue(0, 0, false, false, false)).toEqual({ due: true, wanted: false })
})

test('a fresh plan under 60 min old, no drop: not due', () => {
  expect(pmDue(59 * MIN, 0, true, false, false)).toEqual({ due: false, wanted: false })
})

test('exactly 60 min old is due (>=, not >)', () => {
  expect(pmDue(60 * MIN, 0, true, false, false)).toEqual({ due: true, wanted: false })
})

test('a run dropping live wakes the pm again, after the 5 min debounce, even with a fresh plan', () => {
  const pmAt = 10 * MIN
  expect(pmDue(pmAt + 4 * MIN, pmAt, true, true, false)).toEqual({ due: false, wanted: true })
  expect(pmDue(pmAt + 5 * MIN, pmAt, true, true, false)).toEqual({ due: true, wanted: false })
})

test('a drop inside the debounce window is not lost: wanted carries forward until the window elapses', () => {
  const pmAt = 10 * MIN
  const first = pmDue(pmAt + 1 * MIN, pmAt, true, true, false)
  expect(first).toEqual({ due: false, wanted: true })
  // no new drop this check, but the earlier one is still pending
  const second = pmDue(pmAt + 2 * MIN, pmAt, true, false, first.wanted)
  expect(second).toEqual({ due: false, wanted: true })
  const third = pmDue(pmAt + 5 * MIN, pmAt, true, false, second.wanted)
  expect(third).toEqual({ due: true, wanted: false })
})

test('no drop, no staleness: never due, wanted stays false', () => {
  expect(pmDue(30 * MIN, 0, true, false, false)).toEqual({ due: false, wanted: false })
})

test('the 60 min interval wins over the debounce: a stale plan is due even inside the 5 min window', () => {
  const pmAt = 0
  expect(pmDue(HOUR, pmAt, true, true, false)).toEqual({ due: true, wanted: false })
})
