import { expect, test } from 'bun:test'
import { decide, type LongCandidate, planLines } from './memory'

const IDLE = -10
const long = (o: Partial<LongCandidate> = {}): LongCandidate => ({
  path: 't/LONG.md#a',
  activation: IDLE,
  runs: 0,
  ageDays: 40,
  chars: 100,
  ...o,
})
const kinds = (l: LongCandidate[], opts = {}) => decide([], l, [], opts).map(d => d.kind)

test('decide() archives an idle long entry 30+ days old', () => {
  const [d] = decide([], [long()], [], { historyDays: 40 })
  expect(d!.kind).toBe('archive')
  expect(d!.kind === 'archive' && d!.reason).toContain('activation')
  expect(d!.kind === 'archive' && d!.reason).toContain('40 days old')
})

test('decide() does not archive a long entry at the age, history and activation edges', () => {
  const o = { historyDays: 40 }
  expect(kinds([long({ ageDays: 29.9 })], o)).toEqual([])
  expect(kinds([long({ ageDays: 30 })], o)).toEqual(['archive'])
  expect(kinds([long()], { historyDays: 29 })).toEqual([])
  expect(kinds([long({ activation: -3.6 })], o)).toEqual([])
  expect(kinds([long({ ageDays: undefined })], o)).toEqual([])
})

test('decide() retires an expired long entry at any age, and flags an unknown until', () => {
  const [r] = decide([], [long({ ageDays: 1, activation: 5, expired: true, expiredReason: 'PR merged' })])
  expect(r).toEqual({ kind: 'retire', path: 't/LONG.md#a', reason: 'PR merged' })
  const ds = decide([], [long({ untilFlag: 'no lookup', chars: 3000 })], [], { historyDays: 40 })
  expect(ds.map(d => d.kind)).toEqual(['flag', 'archive'])
})

test('decide() trims a long entry over 2000 chars, not at exactly 2000', () => {
  expect(kinds([long({ ageDays: 1, chars: 2000 })])).toEqual([])
  expect(kinds([long({ ageDays: 1, chars: 2001 })])).toEqual(['trim'])
})

test('decide() gives an archived or retired long entry no trim', () => {
  expect(kinds([long({ chars: 5000 })], { historyDays: 40 })).toEqual(['archive'])
  expect(kinds([long({ chars: 5000, expired: true })])).toEqual(['retire'])
})

test('decide() trim has its own cap: largest first, the rest held; archives keep theirs', () => {
  const entries = Array.from({ length: 30 }, (_, i) =>
    long({ path: `t/LONG.md#e${i}`, ageDays: 1, chars: 3000 + i }),
  )
  const ds = decide([], entries, [], {})
  expect(ds.filter(d => d.kind === 'trim')).toHaveLength(25)
  expect(ds.filter(d => d.kind === 'held').map(d => (d as { path: string }).path)).toEqual([
    't/LONG.md#e4',
    't/LONG.md#e3',
    't/LONG.md#e2',
    't/LONG.md#e1',
    't/LONG.md#e0',
  ])
  expect(planLines(ds, { archiveCap: 25, historyDays: 1 })[0]).toContain('25 trim, 5 held (cap 25)')
})

test('decide() long archives share the archive cap, oldest first', () => {
  const entries = [10, 50, 30].map((age, i) => long({ path: `t/LONG.md#e${i}`, ageDays: age + 30 }))
  const ds = decide([], entries, [], { historyDays: 100, archiveCap: 2 })
  expect(ds.map(d => `${d.kind} ${(d as { path: string }).path}`)).toEqual([
    'held t/LONG.md#e0',
    'archive t/LONG.md#e1',
    'archive t/LONG.md#e2',
  ])
})
