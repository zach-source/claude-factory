import { expect, test } from 'bun:test'
import { createdAt, failKind, fate, metrics, renderTokens, sessionOf } from './metrics'

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

test("a session's tokens count each turn once, and its station comes from the brief's report line", () => {
  const turn = (id: string, read: number, out: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, usage: { input_tokens: 1, cache_read_input_tokens: read, output_tokens: out } },
    })
  const brief = JSON.stringify({ type: 'user', message: { content: 'report run-1 3 <outcome> "<summary>"' } })
  const s = sessionOf(
    [brief, turn('a', 100, 5), turn('a', 100, 5), turn('b', 300, 7), 'not json', ''],
    'run-1',
    seq => (seq === 3 ? 'implement' : '?'),
  )
  expect(s).toEqual({
    run: 'run-1',
    node: 'implement',
    turns: 2,
    tokens: 101 + 5 + 301 + 7,
    out: 12,
    peak: 301,
  })
  const table = renderTokens([s, { ...s, run: 'run-2', tokens: 1e6 }], new Set(['run-2']))
  expect(table).toContain('2 worker sessions in 2 runs')
  expect(table).toMatch(/implement\s+2/)
})
