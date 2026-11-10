// claude-factory-hpmc.25: the pure flow graph of flows.show (spec 008, FR-025).
import { expect, test } from 'bun:test'
import { flowGraph, flowMermaid, flowTable, parseSince, type FlowRun } from './flows'
import type { Factory } from './machine'

const def: Factory = {
  name: 'f',
  start: 'plan',
  nodes: {
    plan: { prompt: 'p', next: { done: 'build' } },
    build: { prompt: 'b', next: { done: 'review', fail: 'plan' } },
    review: {
      prompt: 'r',
      gate: true,
      next: {
        ok: { to: 'done', ship: true },
        again: { to: 'build', delayMin: 5 },
        other: { to: 'done', requeue: { factory: 'g' } },
      },
    },
  },
}
const T = 1_000_000
const run = (
  id: string,
  node: string,
  sub: string,
  log: [string, string, number][],
  createdAt = T,
): FlowRun => ({
  id,
  node,
  sub,
  createdAt,
  log: log.map(([n, outcome, at]) => ({ node: n, attempt: 1, outcome, summary: '', at })),
})
const g = (runs: FlowRun[], since = 0, now = T + 10_000) => flowGraph({ def, runs, since, now })
const node = (x: ReturnType<typeof g>, id: string) => x.nodes.find(n => n.id === id)!
const edge = (x: ReturnType<typeof g>, from: string, outcome: string) =>
  x.edges.find(e => e.from === from && e.outcome === outcome)!

test('rank is the depth from start; order is the definition order', () => {
  const x = g([])
  expect(x.nodes.map(n => [n.id, n.rank, n.order])).toEqual([
    ['plan', 0, 0],
    ['build', 1, 1],
    ['review', 2, 2],
  ])
  expect(node(x, 'review').gate).toBe(true)
})

test('a back edge goes to a rank that is equal or lower; a timed edge has delayMin', () => {
  const x = g([])
  expect(edge(x, 'build', 'fail')).toMatchObject({ to: 'plan', back: true, timed: false })
  expect(edge(x, 'review', 'again')).toMatchObject({ to: 'build', back: true, timed: true })
  expect(edge(x, 'plan', 'done')).toMatchObject({ to: 'build', back: false })
})

test('exits: ship, another factory and done are not nodes', () => {
  const x = g([])
  expect(x.exits).toEqual([
    { from: 'review', outcome: 'ok', to: 'ship' },
    { from: 'review', outcome: 'other', to: 'g' },
  ])
  expect(x.edges.some(e => e.to === 'ship' || e.to === 'g')).toBe(false)
})

test('counts by sub and run ids; no runs gives empty counts', () => {
  const x = g([
    run('a', 'build', 'working', []),
    run('b', 'build', 'working', []),
    run('c', 'build', 'stuck', []),
  ])
  expect(node(x, 'build').counts).toEqual({ working: 2, stuck: 1 })
  expect(node(x, 'build').runs).toEqual(['a', 'b', 'c'])
  expect(node(x, 'plan').counts).toEqual({})
})

test('traversals and moves come from log entries inside the window, oldest first', () => {
  const a = run('a', 'review', 'working', [
    ['plan', 'done', T + 1000],
    ['build', 'done', T + 3000],
  ])
  const b = run('b', 'build', 'working', [['plan', 'done', T + 2000]])
  const x = g([a, b], T + 1500)
  expect(edge(x, 'plan', 'done').traversals).toBe(1)
  expect(edge(x, 'build', 'done').traversals).toBe(1)
  expect(x.moves).toEqual([
    { run: 'b', from: 'plan', outcome: 'done', to: 'build', at: T + 2000 },
    { run: 'a', from: 'build', outcome: 'done', to: 'review', at: T + 3000 },
  ])
})

test('dwell is the time between log entries; the first entry counts from createdAt', () => {
  const a = run('a', 'review', 'working', [
    ['plan', 'done', T + 1000],
    ['build', 'done', T + 4000],
  ])
  const x = g([a])
  expect(node(x, 'plan').dwell).toEqual({ p50: 1000, p90: 1000 })
  expect(node(x, 'build').dwell).toEqual({ p50: 3000, p90: 3000 })
  expect(node(x, 'review').dwell).toBeNull()
})

test('a log node that the factory lacks is a legacy node', () => {
  const a = run('a', 'old', 'working', [['old', 'done', T + 1000]])
  const x = g([a])
  expect(node(x, 'old')).toMatchObject({ legacy: true, runs: ['a'], gate: false })
  expect(node(x, 'plan').legacy).toBe(false)
})

test('parseSince: a window, a cursor or nothing', () => {
  expect(parseSince(undefined, 100_000_000)).toBe(100_000_000 - 86_400_000)
  expect(parseSince('1h', 10_000_000)).toBe(10_000_000 - 3_600_000)
  expect(parseSince('7d', 10_000_000_000)).toBe(10_000_000_000 - 7 * 86_400_000)
  expect(parseSince('1700000000000', 1)).toBe(1700000000000)
  expect(() => parseSince('soon', 1)).toThrow('since')
})

test('an ended run counts for traversals but sits at no station', () => {
  const a = { ...run('a', 'review', 'done', [['plan', 'done', T + 1000]]), ended: true as const }
  const x = g([a])
  expect(edge(x, 'plan', 'done').traversals).toBe(1)
  expect(node(x, 'review').runs).toEqual([])
})

test('flowMermaid draws stations, a gate as a diamond, a back edge dashed', () => {
  const m = flowMermaid(g([run('a', 'build', 'working', [['plan', 'done', T + 1000]])]))
  expect(m).toContain('flowchart LR')
  expect(m).toContain('review{review}')
  expect(m).toContain('plan -->|done 1| build')
  expect(m).toContain('build -.->|fail 0| plan')
})

test('flowTable lists each station with its rank, counts and p90, then the edges', () => {
  const t = flowTable(g([run('a', 'build', 'working', [['plan', 'done', T + 1000]])]))
  expect(t).toContain('build')
  expect(t).toMatch(/plan\s+0\s+-\s+1s/)
  expect(t).toMatch(/build\s+1\s+working=1/)
  expect(t).toContain('plan --done--> build  1')
})
