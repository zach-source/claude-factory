import { expect, test } from 'bun:test'
import { dueSweeps, sweepGoal, sweepNames, type SweepState } from './sweeps'
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
