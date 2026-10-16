import { expect, test } from 'claude-code/testing'
import { patrol } from '../hooks/view'

// claude-factory-dun.4: the pm's plan.json, carried into the patrol prompt's own 'Plan' section.
// These are pure `patrol()` calls: no `$`, no mocks, since the function takes the plan (and `now`)
// as plain arguments. register.tsx's own read of <home>/plan.json (missing, stale or corrupt, all
// read as `undefined`) is covered separately in patrol.test.tsx.

const RIGS = [{ name: 'api', repo: '/r/api', factory: 'lifecycle', goal: 'ship fast' }]

const PLAN = {
  at: 1_000_000,
  rigs: {
    api: {
      items: [
        { id: 'api-1', title: 'fix auth', priority: 1, why: 'blocks release' },
        { id: 'api-2', title: 'add metric', priority: 2, why: 'cheap win' },
        { id: 'api-3', title: 'c', priority: 2, why: 'c' },
        { id: 'api-4', title: 'd', priority: 2, why: 'd' },
        { id: 'api-5', title: 'e', priority: 2, why: 'e' },
        { id: 'api-6', title: 'f', priority: 2, why: 'f' },
      ],
      findings: [
        {
          kind: 'starved-epic' as const,
          rig: 'api',
          bead: 'api-9',
          key: 'starved-epic:api:api-9',
          text: 'api-9 "slow epic" (P1) has had no progress in 30h while lower-priority work shipped',
        },
      ],
    },
    web: { items: [], findings: [] },
  },
  proposals: [],
}

test("a fresh plan adds a 'Plan' section: top 5 items in order, per rig, plus findings; a rig with nothing ranked is left out", () => {
  const now = PLAN.at + 5 * 60_000 // 5 min old: fresh
  const due = patrol([], [], new Set(), true, RIGS, undefined, new Set(), [], PLAN, now)
  expect(due).not.toBeNull()
  expect(due!.text).toContain('Plan (from the pm, 5m old): for a rig with room, start from it in order')
  expect(due!.text).toContain('1. api-1 (P1) blocks release')
  expect(due!.text).toContain('2. api-2 (P2) cheap win')
  expect(due!.text).not.toContain('api-6') // the 6th item: past the top-5 cap
  expect(due!.text).toContain('api-9 "slow epic" (P1) has had no progress in 30h')
  expect(due!.text).not.toContain('web:') // web has no items and no findings: left out entirely
})

test('a stale plan (2h old or more) and a missing plan leave the prompt byte-identical to today\'s text', () => {
  const now = PLAN.at + 2 * 3_600_000
  const base = patrol([], [], new Set(), true, RIGS, undefined, new Set(), [])
  const stale = patrol([], [], new Set(), true, RIGS, undefined, new Set(), [], { ...PLAN, at: now - 2 * 3_600_000 }, now)
  const missing = patrol([], [], new Set(), true, RIGS, undefined, new Set(), [], undefined, now)
  expect(stale!.text).toBe(base!.text)
  expect(missing!.text).toBe(base!.text)
  expect(stale!.text).not.toContain('Plan (from the pm')
})

test('a fresh plan changes only the prompt text, never sig: the heartbeat dedupe stays plan-blind', () => {
  const now = PLAN.at + 5 * 60_000
  const withPlan = patrol([], [], new Set(), true, RIGS, undefined, new Set(), [], PLAN, now)
  const withoutPlan = patrol([], [], new Set(), true, RIGS, undefined, new Set(), [])
  expect(withPlan!.sig).toBe(withoutPlan!.sig)
  expect(withPlan!.text).not.toBe(withoutPlan!.text)
})
