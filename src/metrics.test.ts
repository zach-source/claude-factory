import { expect, test } from 'bun:test'
import { createdAt, failKind, fate, metrics } from './metrics'

const H = 3_600_000
const e = (node: string, outcome: string, h: number, summary = '') => ({
  node,
  attempt: 1,
  outcome,
  summary,
  at: h * H,
})

test("a run's fate: shipped, rejected, closed, aborted or where it is", () => {
  expect(
    fate({
      id: 'a',
      node: 'soak',
      createdAt: 0,
      log: [e('deploy', 'failed', 1), e('deploy', 'deployed', 2)],
    }),
  ).toBe('shipped')
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1)] })).toBe('rejected')
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('implement', 'abandon', 1)] })).toBe('closed')
  expect(fate({ id: 'a', node: 'aborted', createdAt: 0, log: [] })).toBe('aborted')
  expect(fate({ id: 'a', node: 'verify', createdAt: 0, log: [] })).toBe('running@verify')
})

test('metrics count ship rate, time to ship, the approve wait, review loops and failures by kind', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        e('implement', 'fail', 1, 'no report within 60 min'),
        e('implement', 'ready', 2),
        e('review', 'changes', 3),
        e('review', 'approve', 4),
        e('approve', 'ship', 10),
        e('deploy', 'published', 11),
      ],
    },
    { id: 'r2', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1)] },
    {
      id: 'r3',
      node: 'implement',
      createdAt: 0,
      log: [e('implement', 'fail', 1, 'Blocked on operator decision')],
    },
  ])
  expect(m.fates).toEqual({ shipped: 1, rejected: 1, 'running@implement': 1 })
  expect(m.shipRate).toBe(0.5) // of ended runs: the running one is not counted
  expect(m.hoursToShip.median).toBe(11)
  expect(m.approveWaitHours.median).toBe(6)
  expect(m.reviewLoops).toBe(1)
  expect(m.fails).toEqual({ timeout: 1, blocked: 1 })
  expect(m.stations.implement).toEqual({
    visits: 3,
    failed: 2,
    outcomes: { fail: 2, ready: 1 },
    medianHours: 1,
  })
})

test("a run's id carries its creation time", () => {
  const t = 1791286012157
  expect(createdAt(`lifecycle-${t.toString(36)}x9`)).toBe(t)
  expect(failKind('worker stopped without reporting')).toBe('worker lost')
})
