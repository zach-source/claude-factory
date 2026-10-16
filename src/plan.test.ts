import { expect, test } from 'bun:test'
import type { Bead } from './beads'
import {
  buildPlan,
  findings,
  hashOf,
  isFresh,
  isValidRigPlan,
  orderByPlan,
  PLAN_FRESH_MS,
  proposalKey,
  rankPlan,
  rigPlanOf,
  sanitize,
  type Plan,
  type RigInput,
} from './plan'

const HOUR = 3_600_000
const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({ id, title: `title ${id}`, ...extra })
const iso = (ms: number) => new Date(ms).toISOString()

// ---- isFresh ----

test('isFresh: under 2h is fresh, exactly 2h and over are stale, a future or corrupt at is stale', () => {
  const now = 10_000_000
  expect(isFresh({ at: now - (PLAN_FRESH_MS - 1) }, now)).toBe(true)
  expect(isFresh({ at: now - PLAN_FRESH_MS }, now)).toBe(false) // exactly 2h: stale, not fresh
  expect(isFresh({ at: now - PLAN_FRESH_MS - 1 }, now)).toBe(false)
  expect(isFresh({ at: now + 1 }, now)).toBe(false) // a future at: clock skew or a hand-edited file
  expect(isFresh({ at: Number.NaN }, now)).toBe(false)
  expect(isFresh(undefined, now)).toBe(false)
  expect(isFresh(null, now)).toBe(false)
})

// ---- sanitize (claude-factory-dun.23) ----

test('sanitize strips control characters including ESC, collapses newlines/tabs to a space, and clips to n', () => {
  const dirty = `title\x1b[31m with\nan embedded\r\nnewline and\ta tab${'z'.repeat(200)}`
  const clean = sanitize(dirty)
  expect(clean).not.toContain('\x1b')
  expect(clean).not.toContain('\n')
  expect(clean).not.toContain('\r')
  expect(clean).not.toContain('\t')
  expect(clean.length).toBeLessThanOrEqual(160)
})

test('sanitize leaves a short, clean string unchanged', () => {
  expect(sanitize('a clean title')).toBe('a clean title')
})

// ---- rankPlan ----

test('rankPlan: the pm cannot lift a bead over a higher-priority one; it only orders inside a band', () => {
  const candidates = [bead('a-1', { priority: 1 }), bead('a-2', { priority: 2 })]
  const items = rankPlan([{ id: 'a-2', why: 'ships a customer fix' }], candidates)
  expect(items.map(i => i.id)).toEqual(['a-1', 'a-2']) // a-1 (P1) still comes first
  expect(items[1]!.why).toBe('ships a customer fix')
  expect(items[0]!.why).toBe('(no reason given)') // the pm never mentioned a-1
})

test('rankPlan: drops ids the pm named that are not real candidates, and a repeated id', () => {
  const candidates = [bead('a-1', { priority: 2 }), bead('a-2', { priority: 2 })]
  const items = rankPlan(
    [
      { id: 'a-2', why: 'first' },
      { id: 'ghost', why: 'not a candidate' },
      { id: 'a-2', why: 'second mention, dropped' },
      { id: 'a-1', why: 'next' },
    ],
    candidates,
  )
  expect(items.map(i => i.id)).toEqual(['a-2', 'a-1'])
  expect(items[0]!.why).toBe('first')
})

test('rankPlan: clips why to 120 chars, strips control characters, and caps at 10 items', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => bead(`a-${i}`, { priority: 3 }))
  const why = `x\x00y${'z'.repeat(130)}`
  const items = rankPlan([{ id: 'a-0', why }], candidates)
  expect(items).toHaveLength(10)
  expect(items[0]!.why.length).toBe(120)
  expect(items[0]!.why).not.toContain('\x00')
  expect(items[0]!.why.endsWith('…')).toBe(true)
})

test('rankPlan: a why with an embedded newline reads as one line (claude-factory-dun.23)', () => {
  const candidates = [bead('a-1', { priority: 1 })]
  const items = rankPlan([{ id: 'a-1', why: 'first line\nsecond line' }], candidates)
  expect(items[0]!.why).not.toContain('\n')
})

test('rankPlan: a candidate title with ESC and a newline (an untrusted Linear-synced title) comes out clean (claude-factory-dun.23)', () => {
  const candidates = [bead('a-1', { priority: 1, title: 'a\x1b[31mtitle\nwith a line break' })]
  const items = rankPlan([{ id: 'a-1', why: 'w' }], candidates)
  expect(items[0]!.title).not.toContain('\x1b')
  expect(items[0]!.title).not.toContain('\n')
})

// ---- orderByPlan ----

test('orderByPlan: no plan is the identity; a planned id never passes a higher-priority one', () => {
  const candidates = [bead('a-1', { priority: 2 }), bead('a-2', { priority: 1 })]
  expect(orderByPlan(candidates, undefined)).toEqual(candidates)
  const plan = { items: [{ id: 'a-1', title: 't', priority: 2, why: 'w' }] }
  // a-1 is planned first, but a-2 is P1 (a lower number = higher priority): a-2 still comes first
  expect(orderByPlan(candidates, plan).map(c => c.id)).toEqual(['a-2', 'a-1'])
})

test('orderByPlan: inside one priority band, the plan reorders; a candidate the plan never named keeps its bd order after the named ones', () => {
  const candidates = [
    bead('a-1', { priority: 2 }),
    bead('a-2', { priority: 2 }),
    bead('a-3', { priority: 2 }),
  ]
  const plan = { items: [{ id: 'a-2', title: 't', priority: 2, why: 'w' }] }
  expect(orderByPlan(candidates, plan).map(c => c.id)).toEqual(['a-2', 'a-1', 'a-3'])
})

// ---- isValidRigPlan ----

test('isValidRigPlan: a well-shaped rig plan passes; an item missing a field or a non-array items/findings fails', () => {
  expect(isValidRigPlan({ items: [], findings: [] })).toBe(true)
  expect(isValidRigPlan({ items: [{ id: 'a-1', title: 't', priority: 1, why: 'w' }], findings: [] })).toBe(
    true,
  )
  expect(
    isValidRigPlan({
      items: [],
      findings: [{ kind: 'starved-epic', rig: 'acme', key: 'k', text: 't' }],
    }),
  ).toBe(true)
  expect(isValidRigPlan({})).toBe(false) // no items/findings at all (claude-factory-dun.18)
  expect(isValidRigPlan({ items: [], findings: undefined })).toBe(false)
  expect(isValidRigPlan({ items: 'nope', findings: [] })).toBe(false)
  expect(isValidRigPlan({ items: [{ id: 'a-1', title: 't', why: 'w' }], findings: [] })).toBe(false) // priority missing
  expect(isValidRigPlan({ items: [], findings: [null] })).toBe(false) // claude-factory-dun.20
  expect(isValidRigPlan({ items: [], findings: [{ kind: 'starved-epic', key: 'k' }] })).toBe(false) // text missing
  expect(isValidRigPlan(null)).toBe(false)
  expect(isValidRigPlan([])).toBe(false)
})

// ---- rigPlanOf ----

test('rigPlanOf: returns the named rig, undefined for an absent plan or an unmentioned rig name', () => {
  const rp = { items: [{ id: 'a-1', title: 't', priority: 1, why: 'w' }], findings: [] }
  const p: Plan = { at: 0, rigs: { acme: rp }, proposals: [] }
  expect(rigPlanOf(p, 'acme')).toBe(rp)
  expect(rigPlanOf(p, 'widget')).toBeUndefined()
  expect(rigPlanOf(undefined, 'acme')).toBeUndefined()
})

test('rigPlanOf: a rig named after an Object.prototype member the plan never mentions reads as absent, not the inherited value', () => {
  const p: Plan = { at: 0, rigs: {}, proposals: [] }
  expect(rigPlanOf(p, 'constructor')).toBeUndefined()
  expect(rigPlanOf(p, 'toString')).toBeUndefined()
  expect(rigPlanOf(p, 'hasOwnProperty')).toBeUndefined()
})

// ---- proposalKey ----

test('proposalKey: a bead-naming proposal keys on rig+bead, stable across a reworded change/why', () => {
  const k1 = proposalKey('a', { bead: 'fx-1', change: 'bump fx-1 to P0', why: 'blocked' })
  const k2 = proposalKey('a', { bead: 'fx-1', change: 'raise fx-1 priority', why: 'a release' })
  expect(k1).toBe(k2)
  expect(k1).toBe('proposal:a:fx-1')
})

test('proposalKey: a proposal naming no bead keys on a hash of change+why, so a different proposal gets a different key', () => {
  const k1 = proposalKey('a', { change: 'add a rig', why: 'the owner asked' })
  const k2 = proposalKey('a', { change: 'add a different rig', why: 'the owner asked' })
  expect(k1).not.toBe(k2)
  expect(k1).toMatch(/^proposal:a:[0-9a-f]{8}$/)
})

// ---- findings: starved-epic ----

test('findings: a P1 epic at 0/5 for 25h while a P2 bead ships elsewhere is starved', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 25 * HOUR
  const every: Bead[] = [
    bead('r-1', { status: 'open', priority: 1, issue_type: 'epic', created_at: iso(createdAt) }),
    ...Array.from({ length: 5 }, (_, i) => bead(`r-1.${i}`, { status: 'open', parent: 'r-1' })),
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(now - 1 * HOUR) }),
  ]
  const found = findings('acme', undefined, every, [], now)
  expect(found).toEqual([
    {
      kind: 'starved-epic',
      rig: 'acme',
      bead: 'r-1',
      key: 'starved-epic:acme:r-1',
      text: 'r-1 "title r-1" (P1) has had no progress in 25h while lower-priority work shipped',
    },
  ])
})

test('findings: the same epic at 23h is not starved yet (under the 24h threshold)', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 23 * HOUR
  const every: Bead[] = [
    bead('r-1', { status: 'open', priority: 1, created_at: iso(createdAt) }),
    ...Array.from({ length: 5 }, (_, i) => bead(`r-1.${i}`, { status: 'open', parent: 'r-1' })),
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(now - 1 * HOUR) }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

test('findings: past 24h with nothing lower-value shipped since is not starved', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 48 * HOUR
  const every: Bead[] = [
    bead('r-1', { status: 'open', priority: 1, created_at: iso(createdAt) }),
    ...Array.from({ length: 5 }, (_, i) => bead(`r-1.${i}`, { status: 'open', parent: 'r-1' })),
    // closed before the epic's own last progress point: does not count
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(createdAt - 1 * HOUR) }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

test('findings: a bead at the same or higher priority shipping does not starve the epic', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 25 * HOUR
  const every: Bead[] = [
    bead('r-1', { status: 'open', priority: 1, created_at: iso(createdAt) }),
    bead('r-1.0', { status: 'open', parent: 'r-1' }),
    // P0 and P1 are not numerically higher than the epic's own P1: no starvation
    bead('r-8', { status: 'closed', priority: 0, closed_at: iso(now - 1 * HOUR) }),
    bead('r-9', { status: 'closed', priority: 1, closed_at: iso(now - 1 * HOUR) }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

test('findings: the epic uses its own latest child progress, not just created_at, as the last-progress point', () => {
  const now = 1_000 * HOUR
  const every: Bead[] = [
    bead('r-1', { status: 'open', priority: 1, created_at: iso(now - 100 * HOUR) }),
    bead('r-1.0', { status: 'closed', parent: 'r-1', closed_at: iso(now - 23 * HOUR) }),
    bead('r-1.1', { status: 'open', parent: 'r-1' }),
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(now - 1 * HOUR) }),
  ]
  // last progress was 23h ago (a child closed then), under the 24h threshold: not starved
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

// ---- findings: epic-done-open ----

test('findings: an open epic whose children are all closed is a plan gap, unless a live run owns it', () => {
  const now = 1_000 * HOUR
  const every: Bead[] = [
    bead('r-2', { status: 'open', priority: 2, title: 'spec' }),
    bead('r-2.0', { status: 'closed', parent: 'r-2' }),
    bead('r-2.1', { status: 'closed', parent: 'r-2' }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([
    {
      kind: 'epic-done-open',
      rig: 'acme',
      bead: 'r-2',
      key: 'epic-done-open:acme:r-2',
      text: 'r-2 "spec": every child is closed, but the epic is still open',
    },
  ])
  expect(findings('acme', undefined, every, ['r-2'], now)).toEqual([]) // a live run's own epic: not a gap yet
})

test('findings: an epic title with ESC and a newline (an untrusted Linear-synced title) comes out clean in the epic-done-open text (claude-factory-dun.23)', () => {
  const now = 1_000 * HOUR
  const every: Bead[] = [
    bead('r-2', { status: 'open', priority: 2, title: 'a\x1b[31mtitle\nwith a break' }),
    bead('r-2.0', { status: 'closed', parent: 'r-2' }),
  ]
  const [found] = findings('acme', undefined, every, [], now)
  expect(found!.text).not.toContain('\x1b')
  expect(found!.text).not.toContain('\n')
})

test('findings: a starved epic title with ESC and a newline comes out clean in the starved-epic text (claude-factory-dun.23)', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 25 * HOUR
  const every: Bead[] = [
    bead('r-1', {
      status: 'open',
      priority: 1,
      title: 'a\x1b[31mtitle\nwith a break',
      created_at: iso(createdAt),
    }),
    bead('r-1.0', { status: 'open', parent: 'r-1' }),
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(now - 1 * HOUR) }),
  ]
  const [found] = findings('acme', undefined, every, [], now)
  expect(found!.text).not.toContain('\x1b')
  expect(found!.text).not.toContain('\n')
})

test('findings: a closed epic never fires either finding', () => {
  const now = 1_000 * HOUR
  const every: Bead[] = [
    bead('r-3', { status: 'closed', priority: 1, created_at: iso(now - 100 * HOUR) }),
    bead('r-3.0', { status: 'open', parent: 'r-3' }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

// ---- findings: a person's own defer decision is not a finding (claude-factory-dun.14) ----

test('findings: a deferred epic at 0/5 for 25h never fires, even with lower-priority work shipped', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 25 * HOUR
  const every: Bead[] = [
    bead('r-6', { status: 'deferred', priority: 1, created_at: iso(createdAt) }),
    ...Array.from({ length: 5 }, (_, i) => bead(`r-6.${i}`, { status: 'open', parent: 'r-6' })),
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(now - 1 * HOUR) }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

test('findings: an epic at 25h whose only open children are deferred is not starved', () => {
  const now = 1_000 * HOUR
  const createdAt = now - 25 * HOUR
  const every: Bead[] = [
    bead('r-7', { status: 'open', priority: 1, created_at: iso(createdAt) }),
    bead('r-7.0', { status: 'deferred', parent: 'r-7' }),
    bead('r-7.1', { status: 'deferred', parent: 'r-7' }),
    bead('r-9', { status: 'closed', priority: 2, closed_at: iso(now - 1 * HOUR) }),
  ]
  expect(findings('acme', undefined, every, [], now)).toEqual([])
})

// ---- findings: goal-no-beads ----

test('findings: a goal with no open leaf bead at all is flagged, even with an open epic shell', () => {
  const now = 1_000 * HOUR
  const every: Bead[] = [bead('r-4', { status: 'open', priority: 1 })] // no children: this is a leaf
  expect(findings('acme', 'ship the thing', every, [], now)).toEqual([]) // a leaf is open: no finding
  const noLeaf: Bead[] = [
    bead('r-5', { status: 'open', priority: 1 }),
    bead('r-5.0', { status: 'closed', parent: 'r-5' }),
  ]
  const found = findings('acme', 'ship the thing', noLeaf, ['r-5'], now) // live, so no epic-done-open either
  expect(found).toEqual([
    {
      kind: 'goal-no-beads',
      rig: 'acme',
      key: `goal-no-beads:acme:${hashOf('ship the thing')}`,
      text: 'acme\'s goal has no open bead driving it: "ship the thing"',
    },
  ])
})

// ---- buildPlan ----

test('buildPlan: adds goal-no-plan only once ranking comes up empty for a goal rig', () => {
  const now = 1_000 * HOUR
  // an open leaf bead exists (so goal-no-beads does not also fire), but it is blocked or
  // unlabeled and so never reaches the candidate list dispatch() would start from
  const leafOnly = [bead('acme-1', { status: 'open', priority: 2 })]
  const withGoal: RigInput = {
    name: 'acme',
    goal: 'ship it',
    candidates: [],
    every: leafOnly,
    liveBeadIds: [],
    answer: [],
  }
  const plan = buildPlan(now, [withGoal], [])
  expect(plan.at).toBe(now)
  expect(plan.rigs.acme!.items).toEqual([])
  expect(plan.rigs.acme!.findings.map(f => f.kind)).toEqual(['goal-no-plan'])

  const w1 = bead('w-1', { status: 'open', priority: 2 })
  const withWork: RigInput = {
    name: 'widget',
    goal: 'ship it',
    candidates: [w1],
    every: [w1], // a candidate is also part of the rig's full bead listing
    liveBeadIds: [],
    answer: [{ id: 'w-1', why: 'only ready work' }],
  }
  const plan2 = buildPlan(now, [withWork], [])
  expect(plan2.rigs.widget!.items).toHaveLength(1)
  expect(plan2.rigs.widget!.findings).toEqual([])
})
