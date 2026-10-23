import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activation,
  ACTIVATION_MAX,
  activationBonus,
  compact,
  decide,
  type Decision,
  envTheta,
  eventWeight,
  format,
  type LongCandidate,
  type Note,
  rank,
  type ShortCandidate,
  THETA,
  usage,
  usageEvents,
  use,
  type UsageEvent,
} from './memory'

// claude-factory-3u1.2.1: an ACT-R base-level activation over the last 90 days of usage events (research R1)
const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-20T12:00:00Z')
const ev = (kind: UsageEvent['kind'], daysAgo: number, ok?: boolean): UsageEvent => ({
  at: now - daysAgo * DAY,
  kind,
  w: eventWeight(kind, ok),
})

test.each([
  ['helped', undefined, 1],
  ['helped', true, 1],
  ['helped', false, 0.3],
  ['confirmed', undefined, 1],
  ['shown', undefined, 0.15],
  ['contradicted', undefined, -1],
] as const)('eventWeight(%s, ok=%p) is %p', (kind, ok, w) => {
  expect(eventWeight(kind, ok)).toBe(w)
})

test.each<[string, UsageEvent[], number]>([
  ['no events', [], -Infinity],
  ['one help a day ago', [ev('helped', 1)], Math.log(1)],
  ['one help 4 days ago', [ev('helped', 4)], Math.log(0.5)],
  ['a failed help 4 days ago', [ev('helped', 4, false)], Math.log(0.15)],
  ['one show a day ago', [ev('shown', 1)], Math.log(0.15)],
  ['two helps, 1 and 4 days ago', [ev('helped', 1), ev('helped', 4)], Math.log(1.5)],
  ['a help 91 days ago is out of the window', [ev('helped', 91)], -Infinity],
])('activation: %s', (_, events, want) => {
  expect(activation(events, now)).toBeCloseTo(want, 9)
})

test('activation: a contradiction subtracts, and a sum at or below 0 floors at a finite low value', () => {
  const floored = activation([ev('helped', 1), ev('contradicted', 1)], now)
  expect(Number.isFinite(floored)).toBe(true)
  expect(floored).toBeLessThan(activation([ev('shown', 89)], now))
  expect(activation([ev('helped', 1), ev('contradicted', 4)], now)).toBeCloseTo(Math.log(0.5), 9)
})

test('activation: an event logged this instant does not divide by zero', () => {
  expect(Number.isFinite(activation([ev('helped', 0)], now))).toBe(true)
})

test('activation: more recent use scores higher, and more use scores higher', () => {
  expect(activation([ev('helped', 1)], now)).toBeGreaterThan(activation([ev('helped', 10)], now))
  expect(activation([ev('helped', 5), ev('helped', 6)], now)).toBeGreaterThan(
    activation([ev('helped', 5)], now),
  )
})

test('usageEvents reads raw lines with ok, and compact() keeps events within 90 days in its folded line', () => {
  const dir = join(tmpdir(), `memory-activation-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'a.md'), format({ summary: 'a short note', body: 'body' }))
  use(dir, ['beads/a.md'], 'shown', now - 100 * DAY)
  use(dir, ['beads/a.md'], 'shown', now - 2 * DAY)
  use(dir, ['beads/a.md'], 'helped', now - DAY, 'r1/implement')
  writeFileSync(
    join(dir, '.usage.jsonl'),
    readFileSync(join(dir, '.usage.jsonl'), 'utf8') +
      JSON.stringify({ path: 'beads/a.md', helped: 1, at: now - DAY, by: 'r2/verify', ok: false }) +
      '\n',
  )
  const before = usageEvents(dir).get('beads/a.md')!
  expect(before).toEqual([
    { at: now - 100 * DAY, kind: 'shown', w: 0.15 },
    { at: now - 2 * DAY, kind: 'shown', w: 0.15 },
    { at: now - DAY, kind: 'helped', w: 1 },
    { at: now - DAY, kind: 'helped', w: 0.3 },
  ])
  const counts = usage(dir).get('beads/a.md')
  compact(dir, {}, now)
  expect(usageEvents(dir).get('beads/a.md')).toEqual(before.slice(1))
  expect(usage(dir).get('beads/a.md')).toEqual(counts!) // counts still keep the old show
  expect(activation(usageEvents(dir).get('beads/a.md')!, now)).toBeCloseTo(activation(before, now), 9)

  // a line logged after the fold adds its event to the folded ones
  use(dir, ['beads/a.md'], 'confirmed', now)
  expect(usageEvents(dir).get('beads/a.md')).toHaveLength(4)
  rmSync(dir, { recursive: true, force: true })
})

// claude-factory-3u1.2.2: decide() reads activation against θ thresholds in place of the 7/30-day limits (research R2)
const cand = (over: Partial<ShortCandidate>): ShortCandidate => ({
  path: 'beads/x.md',
  topic: 'beads',
  ageDays: 20,
  shown: 1,
  helped: 0,
  activation: -Infinity,
  ...over,
})
const A = (events: UsageEvent[]) => activation(events, now)
const kindOf = (d: Decision[]) => d.map(x => x.kind).join(',')

test.each<[string, Partial<ShortCandidate>, string]>([
  ['shown yesterday, 20 days old: merge', { activation: A([ev('shown', 1)]) }, 'merge'],
  [
    'shown yesterday, 6.9 days old: too young to merge',
    { ageDays: 6.9, activation: A([ev('shown', 1)]) },
    '',
  ],
  ['shown yesterday, 7 days old: merge', { ageDays: 7, activation: A([ev('shown', 1)]) }, 'merge'],
  ['shown once 29 days ago: still merges', { ageDays: 40, activation: A([ev('shown', 29)]) }, 'merge'],
  ['shown once 31 days ago: archive', { ageDays: 40, activation: A([ev('shown', 31)]) }, 'archive'],
  [
    'helped once 60 days ago: merge, not archive',
    { ageDays: 70, activation: A([ev('helped', 60)]) },
    'merge',
  ],
  ['helped once 91 days ago: out of the window, archive', { ageDays: 100, helped: 1 }, 'archive'],
  ['activation below θa at 13.9 days old: wait', { ageDays: 13.9, activation: THETA.archive - 1 }, ''],
  ['activation below θa at 14 days old: archive', { ageDays: 14, activation: THETA.archive - 1 }, 'archive'],
  ['never shown, 13.9 days old: wait', { ageDays: 13.9, shown: 0 }, ''],
  ['never shown, 14 days old: archive (FR-015)', { ageDays: 14, shown: 0 }, 'archive'],
])('decide(): %s', (_, over, want) => {
  expect(kindOf(decide([cand(over)], [], [], { historyDays: 100 }))).toBe(want)
})

test('decide() names the activation in its merge and archive reasons', () => {
  expect(decide([cand({ ageDays: 8, activation: -1 })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'activation -1.00, 8 days old' },
  ])
  expect(decide([cand({ ageDays: 31, activation: -4 })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: `activation -4.00 below ${THETA.archive}, 31 days old` },
  ])
  expect(decide([cand({ ageDays: 31, shown: 0 })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'never shown, 31 days old' },
  ])
})

test.each<[string, LongCandidate, string]>([
  [
    '3 helps yesterday across 3 runs: promote',
    { path: 'l#a', activation: A([1, 1, 1].map(d => ev('helped', d))), runs: 3 },
    'promote',
  ],
  [
    '3 helps yesterday across 2 runs: no',
    { path: 'l#a', activation: A([1, 1, 1].map(d => ev('helped', d))), runs: 2 },
    '',
  ],
  [
    '3 helps 30 days ago across 3 runs: faded, no',
    { path: 'l#a', activation: A([30, 30, 30].map(d => ev('helped', d))), runs: 3 },
    '',
  ],
  ['activation at θc exactly: no', { path: 'l#a', activation: THETA.promote, runs: 5 }, ''],
])('decide() promote: %s', (_, long, want) => {
  expect(kindOf(decide([], [long]))).toBe(want)
})

test('decide() takes θ overrides through opts.theta', () => {
  const c = cand({ ageDays: 31, activation: -2 })
  expect(kindOf(decide([c], []))).toBe('merge')
  expect(kindOf(decide([c], [], [], { theta: { merge: -1, archive: -1.5, promote: 0 } }))).toBe('archive')
})

test.each<[string | undefined, number]>([
  [undefined, THETA.merge],
  ['-2.5', -2.5],
  ['not a number', THETA.merge],
  ['', THETA.merge],
])('envTheta reads FACTORY_MEMORY_THETA_MERGE=%p as %p', (raw, want) => {
  const env = raw === undefined ? {} : { FACTORY_MEMORY_THETA_MERGE: raw }
  expect(envTheta(env).merge).toBe(want)
})

// claude-factory-3u1.2.3 (FR-013, research R3): rank() adds clamp(A, 0, ACTIVATION_MAX) / ACTIVATION_MAX · 0.02
test.each<[string, number, number]>([
  ['no events', -Infinity, 0],
  ['below 0', -2, 0],
  ['half of the max', ACTIVATION_MAX / 2, 0.01],
  ['at the max', ACTIVATION_MAX, 0.02],
  ['past the max', ACTIVATION_MAX * 3, 0.02],
])('activationBonus: %s', (_, a, want) => {
  expect(activationBonus(a)).toBeCloseTo(want, 12)
})

test('rank() breaks a near-tie for the more used note, but a clearly more relevant note still wins', () => {
  const note = (path: string): Note => ({ path, summary: path, body: '', tier: 'short' })
  const vecs: Record<string, number[]> = {
    'a/plain.md': [1, 0],
    'a/used-close.md': [0.99, 0], // 0.01 below: inside the 0.02 bonus
    'a/used-far.md': [0.95, 0], // 0.05 below: past it
  }
  const used = (n: Note) => (n.path.startsWith('a/used') ? ACTIVATION_MAX : -Infinity)
  const order = (paths: string[], act?: (n: Note) => number) =>
    rank(
      paths.map(note),
      n => vecs[n.path]!,
      () => undefined,
      [1, 0],
      undefined,
      act,
    ).map(f => f.note.path)
  expect(order(['a/plain.md', 'a/used-close.md'])).toEqual(['a/plain.md', 'a/used-close.md'])
  expect(order(['a/plain.md', 'a/used-close.md'], used)).toEqual(['a/used-close.md', 'a/plain.md'])
  expect(order(['a/plain.md', 'a/used-far.md'], used)).toEqual(['a/plain.md', 'a/used-far.md'])
})
