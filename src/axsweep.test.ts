import { expect, test } from 'bun:test'
import { taskName } from './ax'
import { parseNames, SWEEP_CAP, sweepNames, type SweepRun } from './axsweep'

const live: SweepRun = {
  id: 'lifecycle-acme1',
  seq: 5,
  pane: `ax://${taskName('lifecycle-acme1', 5)}`,
  over: false,
}
const done: SweepRun = { id: 'lifecycle-acme2', seq: 15, pane: null, over: true }
const t = (r: SweepRun, s: number) => taskName(r.id, s)
const sweep = (names: string[], runs = [live, done], manager = 'f-manager') =>
  sweepNames(names, runs, manager)

test('sweepNames picks the leaks', () => {
  expect(sweep([t(done, 10)])).toEqual([t(done, 10)]) // a done run's task
  expect(sweep([t(done, 15)])).toEqual([t(done, 15)]) // even its newest
  expect(sweep([t(live, 3)])).toEqual([t(live, 3)]) // a live run's older attempt
})

test('sweepNames keeps what a live run or another home owns', () => {
  const keep = [
    t(live, 5), // the current pane
    t(done, 16), // seq above the state: a revive race
    t(live, 6), // a launch the state does not show yet
    'f-manager',
    'foo',
    'f-x-',
    'f-unknown-3',
    t(done, 10).toUpperCase(),
  ]
  expect(sweep(keep)).toEqual([])
  // the live run's seq with no pane: the launch is in progress
  expect(sweep([t(live, 5)], [{ ...live, pane: null }])).toEqual([])
})

test('sweepNames keeps the manager task whatever its name', () => {
  expect(sweep([t(done, 10)], [live, done], t(done, 10))).toEqual([])
})

test('sweepNames keeps f-manager-<n> even when the manager env names another task', () => {
  const m: SweepRun = { id: 'manager', seq: 4, pane: null, over: true }
  expect(taskName('manager', 3)).toBe('f-manager-3')
  expect(sweep(['f-manager-3'], [m], 'other')).toEqual([])
})

test('sweepNames keeps a name two runs can own', () => {
  const long = 'x'.repeat(70)
  const a = { ...done, id: `${long}a` }
  const b = { ...done, id: `${long}b` }
  expect(taskName(a.id, 10)).toBe(taskName(b.id, 10))
  expect(sweep([taskName(a.id, 10)], [a, b])).toEqual([])
  expect(sweep([taskName(a.id, 10)], [a])).toEqual([taskName(a.id, 10)])
})

test('sweepNames caps, sorts and de-duplicates', () => {
  const many = Array.from({ length: 12 }, (_, i) => t(done, i + 1))
  const got = sweep([...many, ...many])
  expect(got).toHaveLength(SWEEP_CAP)
  expect(got).toEqual([...got].sort())
})

test('parseNames reads the first token under a NAME header', () => {
  const out = 'NAME ATESPACE PHASE\nf-manager factory Suspended\nf-a-1   factory Running  x\n'
  expect(parseNames(out)).toEqual(['f-manager', 'f-a-1'])
  expect(parseNames('NAME ATESPACE GIT-REPOS\nf-a-1  factory\nBad_Name x\n')).toEqual(['f-a-1'])
  expect(parseNames('')).toEqual([])
  expect(parseNames('Error: f-a-1 unreachable\nf-b-2 x')).toEqual([])
  expect(parseNames('NAME\n')).toEqual([])
})

test('sweepNames keeps the previous attempt when the run pane is that task', () => {
  const r = { ...live, pane: `ax://${t(live, 4)}` }
  expect(sweep([t(live, 4)], [r])).toEqual([])
})

test('sweepNames keeps every name of a run whose state is not readable, alone and with a colliding id', () => {
  const long = 'x'.repeat(70)
  const a = { ...done, id: `${long}a` }
  const unreadable: SweepRun = { id: `${long}b`, seq: -1, pane: null, over: false }
  expect(sweep([taskName(a.id, 10)], [a, unreadable])).toEqual([])
  expect(sweep([t(done, 10)], [unreadable])).toEqual([])
})
