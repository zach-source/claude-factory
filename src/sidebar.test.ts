import { expect, test } from 'bun:test'
import type { Row } from './cli'
import { hold, shipLines, tokens, waiting } from './sidebar'

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

test("waiting names each rig's next PR and lists every owner-only step once, in one group", () => {
  const now = 10 * 3_600_000
  const park = (id: string, rig: string, cmd: string) =>
    ({
      id,
      rig,
      node: 'deploy',
      sub: 'waiting',
      last: {
        node: 'deploy',
        attempt: 1,
        outcome: 'blocked',
        summary: `parked, waiting on: ${cmd}`,
        at: now - 3_600_000,
      },
    }) as Row
  const rows = [
    park('s1', 'web', 'kubectl rollout restart deploy/w -n a'),
    park('s2', 'web', 'helm upgrade w ./chart'),
    park('s3', 'api', 'terraform apply'),
  ]
  const queue = (pr: string, bead: string) => [{ id: bead, title: 't', metadata: { ship_pr: pr } }]
  const text = waiting(rows, now, { web: queue('https://x/pull/7', 'w-1'), api: [] })
  expect(text).toContain('next to merge: https://x/pull/7 (w-1)')
  expect(text).toContain('Owner steps (3):')
  expect(text.match(/Owner steps/g)).toHaveLength(1)
  expect(text).toContain('1. kubectl rollout restart deploy/w -n a\n     run s1 · rig web · 1.0h')
  expect(text).toContain('3. terraform apply')
  expect(text).toContain('→ factory mail s1 deploy')
  expect(text.match(/factory mail s1/g)).toHaveLength(1) // an owner step is not also a per-run block
  expect(text.match(/factory mail s2 /g)).toHaveLength(1) // each answer names only its own run
  expect(text.match(/factory mail s3 /g)).toHaveLength(1)
  expect(waiting([], now, { web: queue('https://x/pull/7', 'w-1') })).toContain('next to merge')
})

test('shipLines shows the ship run, the count and the next PR first', () => {
  const q = [
    { id: 'a-1', title: 't', metadata: { ship_pr: 'https://x/pull/1' } },
    { id: 'a-2', title: 't', metadata: { ship_pr: 'https://x/pull/2' } },
  ]
  expect(shipLines(q, { id: 'ship-1', node: 'deploy' })).toEqual([
    '  ship: ship-1 at deploy, 2 queued, next https://x/pull/1 (a-1)',
    '    then https://x/pull/2 (a-2)',
  ])
  expect(shipLines([])).toEqual([])
})
