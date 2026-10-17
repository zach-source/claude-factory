import { expect, test } from 'bun:test'
import {
  clipUtf8,
  dueSweeps,
  sigOf,
  sweepFiler,
  sweepGoal,
  sweepGuard,
  sweepNames,
  type SweepState,
} from './sweeps'
import type { Factory } from './machine'

const def: Factory = {
  name: 'sweeps',
  start: 'maintain',
  nodes: {
    monitor: { prompt: 'watch', next: { filed: 'done' }, everyMin: 30 },
    maintain: { prompt: 'tend', next: { filed: 'done' }, everyMin: 1440 },
    improve: { prompt: 'better', next: { filed: 'done' }, everyMin: 1440 },
    other: { prompt: 'not a sweep', next: { ok: 'done' } },
  },
}

test('sweepNames lists only the nodes that carry everyMin', () => {
  expect(sweepNames(def)).toEqual(['monitor', 'maintain', 'improve'])
})

test('a rig with no sweeps.json entry is due at once, for every sweep it has slo for', () => {
  const rig = { name: 'a', repo: '/a' }
  expect(dueSweeps(def, rig, {}, [], Date.now())).toEqual(['maintain', 'improve']) // monitor needs --slo
  expect(dueSweeps(def, { ...rig, slo: 'kubectl get pods' }, {}, [], Date.now())).toEqual([
    'monitor',
    'maintain',
    'improve',
  ])
})

test('rig.sweeps narrows the set; none or "none" (empty array) means no sweep runs', () => {
  const rig = { name: 'a', repo: '/a', slo: 'x', sweeps: ['maintain'] }
  expect(dueSweeps(def, rig, {}, [], Date.now())).toEqual(['maintain'])
  expect(dueSweeps(def, { ...rig, sweeps: [] }, {}, [], Date.now())).toEqual([])
})

test('a sweep whose last pass is still inside its everyMin window is not due', () => {
  const now = Date.now()
  const state: SweepState = { a: { maintain: { lastAt: now - 10 * 60_000 } } } // 10 of 1440 min
  expect(dueSweeps(def, { name: 'a', repo: '/a' }, state, [], now)).toEqual(['improve'])
  const past: SweepState = { a: { maintain: { lastAt: now - 1441 * 60_000 } } }
  expect(dueSweeps(def, { name: 'a', repo: '/a' }, past, [], now)).toEqual(['maintain', 'improve'])
})

test('a live run (any factory) carrying the sweep goal for this repo blocks a new one', () => {
  const rig = { name: 'a', repo: '/a' }
  const liveRuns = [
    { repo: '/a', goal: sweepGoal('maintain') },
    { repo: '/b', goal: sweepGoal('maintain') },
  ]
  expect(dueSweeps(def, rig, {}, liveRuns, Date.now())).toEqual(['improve'])
})

test('monitor needs rig.slo even when rig.sweeps names it explicitly', () => {
  const rig = { name: 'a', repo: '/a', sweeps: ['monitor'] }
  expect(dueSweeps(def, rig, {}, [], Date.now())).toEqual([])
  expect(dueSweeps(def, { ...rig, slo: 'kubectl get pods' }, {}, [], Date.now())).toEqual(['monitor'])
})

test('a rig.sweeps name with no everyMin node in def is dropped, not thrown', () => {
  const rig = { name: 'a', repo: '/a', sweeps: ['other', 'maintain'] }
  expect(dueSweeps(def, rig, {}, [], Date.now())).toEqual(['maintain'])
})

// --- sweepGuard (claude-factory-8pc.5): the flood guard ---

test("sweepFiler reads the station from a sweep run's created_by, and nothing else", () => {
  expect(sweepFiler({ created_by: 'factory/sweeps-abc123/maintain' })).toBe('maintain')
  expect(sweepFiler({ created_by: 'factory/sweeps-abc123/improve' })).toBe('improve')
  expect(sweepFiler({ created_by: 'factory/other-run-1/implement' })).toBeUndefined() // not a sweep run
  expect(sweepFiler({ created_by: 'a person' })).toBeUndefined()
  expect(sweepFiler({})).toBeUndefined()
})

const filed = (id: string, station: string, createdAt: string, labels: string[] = []) => ({
  id,
  created_by: `factory/sweeps-${id}run/${station}`,
  created_at: createdAt,
  labels,
})

test('the first 5 sweep-filed beads in the window stay; a 6th is not kept', () => {
  const now = Date.now()
  const beads = Array.from({ length: 6 }, (_, i) =>
    filed(`b${i}`, 'maintain', new Date(now - (5 - i) * 60_000).toISOString()),
  )
  const verdicts = sweepGuard(beads, now)
  expect(verdicts.map(v => v.kept)).toEqual([true, true, true, true, true, false])
})

test('a sweep-filed bead older than the 24h window is not counted at all: a 6th inside 24h still fills the cap', () => {
  const now = Date.now()
  const old = filed('old', 'maintain', new Date(now - 25 * 3_600_000).toISOString())
  const recent = Array.from({ length: 5 }, (_, i) =>
    filed(`b${i}`, 'maintain', new Date(now - (4 - i) * 60_000).toISOString()),
  )
  const verdicts = sweepGuard([old, ...recent], now)
  expect(verdicts.find(v => v.id === 'old')).toBeUndefined() // outside the window: absent, not just unkept
  expect(verdicts.filter(v => v.kept)).toHaveLength(5)
})

test('a bead a person or a non-sweep run created is untouched: absent from the result', () => {
  const now = Date.now()
  const beads = [
    { id: 'p1', created_by: 'a person', created_at: new Date(now).toISOString(), labels: [] },
    {
      id: 'r1',
      created_by: 'factory/some-run-1/implement',
      created_at: new Date(now).toISOString(),
      labels: [],
    },
  ]
  expect(sweepGuard(beads, now)).toEqual([])
})

test('a kept bead with no sweep-queue:* label is not allowed to auto-start', () => {
  const now = Date.now()
  const b = filed('b0', 'maintain', new Date(now).toISOString())
  const verdicts = sweepGuard([b], now)
  expect(verdicts).toEqual([{ id: 'b0', station: 'maintain', kept: true, allowed: false }])
})

test('a kept bead labeled sweep-queue:incident, sweep-queue:main-ci-red or sweep-queue:critical-advisory is allowed', () => {
  const now = Date.now()
  for (const label of ['sweep-queue:incident', 'sweep-queue:main-ci-red', 'sweep-queue:critical-advisory']) {
    const b = filed('b0', 'monitor', new Date(now).toISOString(), [label])
    expect(sweepGuard([b], now)).toEqual([{ id: 'b0', station: 'monitor', kept: true, allowed: true }])
  }
})

test('an unrelated label never allows a kept bead to auto-start', () => {
  const now = Date.now()
  const b = filed('b0', 'maintain', new Date(now).toISOString(), ['factory', 'sweep:maintain'])
  expect(sweepGuard([b], now)).toEqual([{ id: 'b0', station: 'maintain', kept: true, allowed: false }])
})

test('a sweep-filed bead with no created_at stays inside the window, not at epoch 0 (claude-factory-8pc.13)', () => {
  const now = Date.now()
  // 5 old, clearly-dated beads already fill the cap; a 6th with no created_at at all must still be
  // counted (and so dropped, past the cap) -- not fall out of the 24h window at `new Date(0)` and so
  // escape the guard altogether
  const recent = Array.from({ length: 5 }, (_, i) =>
    filed(`b${i}`, 'maintain', new Date(now - (4 - i) * 60_000).toISOString()),
  )
  const noDate = { id: 'nodate', created_by: 'factory/sweeps-nodaterun/maintain', labels: [] }
  const verdicts = sweepGuard([...recent, noDate], now)
  expect(verdicts.find(v => v.id === 'nodate')).toEqual({
    id: 'nodate',
    station: 'maintain',
    kept: false,
    allowed: false,
  })
})

test('sweepGuard is idempotent: the same beads give the same verdicts on a second call', () => {
  const now = Date.now()
  const beads = Array.from({ length: 6 }, (_, i) =>
    filed(
      `b${i}`,
      'maintain',
      new Date(now - (5 - i) * 60_000).toISOString(),
      i === 2 ? ['sweep-queue:incident'] : [],
    ),
  )
  expect(sweepGuard(beads, now)).toEqual(sweepGuard(beads, now))
})

// --- sigOf and clipUtf8 (claude-factory-8pc.6): monitor's deterministic read ---

test('sigOf is the same for the same text, and different for any difference', () => {
  expect(sigOf('all green')).toBe(sigOf('all green'))
  expect(sigOf('all green')).not.toBe(sigOf('all red'))
  expect(sigOf('')).toBe(sigOf(''))
})

test('clipUtf8 leaves short text untouched', () => {
  expect(clipUtf8('all green')).toBe('all green')
  expect(clipUtf8('', 10)).toBe('')
})

test('clipUtf8 cuts at the byte limit and says so, never mid-codepoint', () => {
  const text = 'x'.repeat(5000)
  const clipped = clipUtf8(text, 4096)
  expect(clipped).toContain('[clipped: 4096 of 5000 bytes]')
  expect(clipped.startsWith('x'.repeat(4096))).toBe(true)
  // é is 2 bytes in UTF-8: a cut that lands between its two bytes must never leave a
  // replacement character in the result
  const multibyte = 'é'.repeat(3000)
  const clippedMb = clipUtf8(multibyte, 4096)
  expect(clippedMb.includes('�')).toBe(false)
})

test('mutation check: the cap and the allowlist both matter, not just "keep the first few"', () => {
  const now = Date.now()
  const beads = Array.from({ length: 6 }, (_, i) =>
    filed(`b${i}`, 'maintain', new Date(now - (5 - i) * 60_000).toISOString()),
  )
  expect(sweepGuard(beads, now, 5).filter(v => v.kept)).toHaveLength(5) // cap 5: the real rule
  expect(sweepGuard(beads, now, 6).filter(v => v.kept)).toHaveLength(6) // cap 6: a mutant would still pass with 5
  const allowed = filed('allowed', 'monitor', new Date(now).toISOString(), ['sweep-queue:incident'])
  expect(sweepGuard([allowed], now)[0]!.allowed).toBe(true)
  const notAllowed = filed('not-allowed', 'monitor', new Date(now).toISOString(), ['sweep-queue:bogus'])
  expect(sweepGuard([notAllowed], now)[0]!.allowed).toBe(false) // an unlisted queue label must not pass
})
