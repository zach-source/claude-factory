import { expect, test } from 'bun:test'
import { autoPick, autoQueueOf } from './autoqueue'
import type { Bead } from './beads'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const bead = (id: string, o: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  priority: 2,
  created_at: '2026-01-01T00:00:00Z',
  ...o,
})
const cfg = { minPriority: 2, perHour: 3 }
const ids = (bs: Bead[]) => bs.map(b => b.id)

test('picks the top leaves: priority, then oldest', () => {
  const ready = [
    bead('a', { priority: 2, created_at: '2026-01-01T02:00:00Z' }),
    bead('b', { priority: 1 }),
    bead('c', { priority: 2, created_at: '2026-01-01T01:00:00Z' }),
    bead('d', { priority: 3 }),
  ]
  expect(ids(autoPick(ready, NOW, [], cfg, 10))).toEqual(['b', 'c', 'a'])
})

test('room limits the pick', () => {
  const ready = [bead('a'), bead('b')]
  expect(ids(autoPick(ready, NOW, [], cfg, 1))).toEqual(['a'])
  expect(autoPick(ready, NOW, [], cfg, 0)).toEqual([])
})

test('the perHour cap holds across calls, and frees after an hour', () => {
  const ready = [bead('a'), bead('b'), bead('c')]
  const two = { minPriority: 2, perHour: 2 }
  const first = autoPick(ready, NOW, [], two, 10)
  expect(first).toHaveLength(2)
  const history = first.map(() => NOW)
  expect(autoPick(ready, NOW + 60_000, history, two, 10)).toEqual([])
  expect(autoPick(ready, NOW + 3_600_001, history, two, 10)).toHaveLength(2)
})

test('never picks a parent, epic, child, held, assigned or station-filed bead', () => {
  const ready = [
    bead('parent'),
    bead('epic', { issue_type: 'epic' }),
    bead('child', { parent: 'parent' }),
    bead('rej', { labels: ['rejected'] }),
    bead('own', { labels: ['owner'] }),
    bead('owned', { metadata: { owner_decisions: 'x' } }),
    bead('hum', { labels: ['human'] }),
    bead('ship', { labels: ['ship'] }),
    bead('queued', { labels: ['factory'] }),
    bead('mine', { assignee: 'someone' }),
    bead('swept', { created_by: 'factory/sweeps-r1/monitor' }),
    bead('guard'),
    bead('low', { priority: 4 }),
    bead('ok'),
  ]
  const got = autoPick(ready, NOW, [], cfg, 20, new Set(['parent']), new Set(['guard']))
  expect(ids(got)).toEqual(['ok'])
})

test('off when config is absent or malformed', () => {
  expect(autoPick([bead('a')], NOW, [], undefined, 5)).toEqual([])
  expect(autoQueueOf({})).toBeUndefined()
  expect(autoQueueOf({ autoQueue: { minPriority: 2 } })).toBeUndefined()
  expect(autoQueueOf({ autoQueue: { minPriority: 2, perHour: 0 } })).toBeUndefined()
  expect(autoQueueOf({ autoQueue: cfg })).toEqual(cfg)
})
