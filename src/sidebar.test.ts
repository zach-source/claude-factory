import { expect, test } from 'bun:test'
import type { Row } from './cli'
import { hold, tokens, waiting } from './sidebar'

const blocked = { node: 'deploy', attempt: 1, outcome: 'blocked', summary: 'PR #7', at: 1 }
const rows: Row[] = [
  { id: 'a', ws: 'w1', node: 'implement', sub: 'working', agent: 'working' },
  { id: 'b', ws: 'w2', node: 'approve', sub: 'working', gate: { question: 'ship?', outcomes: ['ship'] } },
  { id: 'c', ws: 'w3', node: 'deploy', sub: 'waiting', wakeAt: 2, last: blocked },
  { id: 'd', ws: 'w4', node: 'verify', sub: 'stuck' },
  { id: 'e', ws: 'w5', node: 'review', sub: 'working', agent: 'blocked' },
  { id: 'f', ws: 'w6', node: 'done' },
  { id: 'g', ws: 'w7', node: 'soak', sub: 'waiting', wakeAt: 2, last: { ...blocked, outcome: 'deployed' } },
]

test('the sidebar says which runs move on their own and which wait on someone', () => {
  expect(rows.map(hold)).toEqual([null, 'needs you', 'parked', 'stuck', 'needs you', null, null])
  const { byWs, rollup } = tokens(rows)
  expect(byWs.w1).toBe('implement · working')
  expect(byWs.w2).toBe('approve · needs you')
  expect(byWs.w3).toBe('deploy · parked')
  expect(byWs.w7).toStartWith('soak · waits ')
  expect(byWs.w6).toBeUndefined() // a finished run's workspace is cleared
  expect(rollup).toBe('1 running · 2 need you · 1 stuck · 1 parked')
  expect(tokens([rows[0]!]).rollup).toBe('1 running')
})

test('waiting lists what holds on the person, by rig, with how to answer', () => {
  const now = 10 * 3_600_000
  const rows = [
    { id: 'a', rig: 'web', node: 'implement', sub: 'working' },
    {
      id: 'b',
      rig: 'web',
      node: 'deploy',
      sub: 'waiting',
      bead: 'web-1',
      last: {
        node: 'deploy',
        attempt: 1,
        outcome: 'blocked',
        summary: 'PR https://github.com/o/r/pull/7 needs a merge',
        at: now - 2 * 3_600_000,
      },
    },
    {
      id: 'c',
      rig: 'api',
      node: 'approve',
      sub: 'working',
      gate: { question: 'Ship it?', outcomes: ['ship', 'hold'] },
    },
  ] as Row[]
  const text = waiting(rows, now)
  expect(text).not.toContain('  a ')
  expect(text).toContain('b deploy · parked 2.0h · web-1')
  expect(text).toContain('    https://github.com/o/r/pull/7')
  expect(text).toContain('factory mail b deploy')
  expect(text).toContain('factory decide c <ship|hold> [note]')
  expect(text.indexOf('api')).toBeLessThan(text.indexOf('web')) // what needs you leads: the gate's rig first
  expect(waiting([rows[0]!], now)).toBe('nothing waits on you')
})
