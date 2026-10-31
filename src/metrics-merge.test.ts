import { expect, test } from 'bun:test'
import { attachMerges, fate, metrics } from './metrics'

// claude-factory-7pxk: a handed-off run whose pull request merged counts as shipped
const H = 3_600_000
const e = (node: string, outcome: string, h: number, summary = '') => ({
  node,
  attempt: 1,
  outcome,
  summary,
  at: h * H,
})
const PR = 'https://github.com/acme/widget/pull/'
const handed = (id: string, extra = {}) => ({
  id,
  node: 'done',
  createdAt: 0,
  log: [e('review', 'approve', 1)],
  ...extra,
})

test('fate: a handed-off run is shipped only when mergedAt is set; other fates keep theirs', () => {
  expect(fate(handed('a', { mergedAt: 5 * H }))).toBe('shipped')
  expect(fate(handed('a'))).toBe('handed-off')
  expect(
    fate({ id: 'a', node: 'done', createdAt: 0, log: [e('implement', 'abandon', 1)], mergedAt: 1 }),
  ).toBe('closed')
  expect(fate({ id: 'a', node: 'aborted', createdAt: 0, log: [], mergedAt: 1 })).toBe('aborted')
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1)], mergedAt: 1 })).toBe(
    'rejected',
  )
  expect(fate(handed('a', { requeued: true, mergedAt: 1 }))).toBe('requeued')
})

test('attachMerges matches by head factory/<id> or by exactly one PR link in the log', () => {
  const prs = [
    { url: PR + '1', head: 'factory/a', mergedAt: 7 },
    { url: PR + '2', head: 'other', mergedAt: 8 },
    { url: PR + '3', head: 'x', mergedAt: 9 },
    { url: PR + '4', head: 'y', mergedAt: 10 },
  ]
  const runs = [
    handed('a'),
    handed('b', { log: [e('review', 'approve', 1, PR + '2 and again ' + PR + '2')] }),
    handed('c', { log: [e('review', 'approve', 1, PR + '3 ' + PR + '4')] }),
    handed('d', { log: [e('review', 'approve', 1, PR + '99')] }),
    { id: 'e', node: 'verify', createdAt: 0, log: [e('x', 'y', 1, PR + '2')] },
  ]
  expect(attachMerges(runs, prs).map(r => r.mergedAt)).toEqual([7, 8, undefined, undefined, undefined])
  expect(runs[0]!).not.toHaveProperty('mergedAt')
})

test('hoursToShip: a merge-shipped run ends at mergedAt; a deploy-shipped run keeps its deploy time', () => {
  const m = metrics([
    handed('a', { mergedAt: 4 * H, log: [e('triage', 'small', 1), e('review', 'approve', 2)] }),
    { id: 's', node: 'done', createdAt: 0, log: [e('deploy', 'published', 10)] },
  ])
  expect(m.fates).toEqual({ shipped: 2 })
  expect(m.hoursToShip.median).toBe(4)
  expect(m.hoursToShip.p90).toBe(10)
  expect(m.small.hoursToShip.median).toBe(4)
})

test('implementPassesPerShippedRun counts a merge-shipped run', () => {
  const m = metrics([
    handed('a', { mergedAt: H, log: [e('implement', 'ready', 1), e('review', 'approve', 2)] }),
  ])
  expect(m.implementPassesPerShippedRun).toBe(1)
})
