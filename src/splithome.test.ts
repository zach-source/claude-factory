import { expect, test } from 'bun:test'
import {
  assertAxRunner,
  assertServerRigs,
  guardedTick,
  movedRigRefusal,
  splitPlan,
  type SplitRun,
} from './splithome'

const rig = (name: string, runner?: string) => ({ name, repo: `/r/${name}`, runner })
const run = (id: string, repo: string, live: boolean, pane: string | null): SplitRun => ({
  id,
  repo,
  live,
  pane,
  finishedAt: 0,
})

test('only the exact runner "ax" moves', () => {
  const rigs = [rig('a', 'ax'), rig('h'), rig('b', 'herdr'), rig('c', 'AX'), rig('d', 'ax '), rig('e', '')]
  const p = splitPlan(rigs, [])
  expect(p.error).toBeUndefined()
  expect(p.move.map(r => r.name)).toEqual(['a'])
  expect(p.stay.map(r => r.name)).toEqual(['h', 'b', 'c', 'd', 'e'])
})

test('live runs of a moved rig move; finished runs and herdr-rig runs stay', () => {
  const p = splitPlan(
    [rig('a', 'ax'), rig('h')],
    [
      run('live', '/r/a', true, 'ax://t1'),
      run('nopane', '/r/a', true, null),
      run('done', '/r/a', false, 'ax://t1'),
      run('herdr', '/r/h', true, 'w1-2'),
    ],
  )
  expect(p.error).toBeUndefined()
  expect(p.runs).toEqual(['live', 'nopane'])
})

test('a live run of a moved rig in a herdr pane refuses the whole split and names the run', () => {
  const p = splitPlan([rig('a', 'ax')], [run('r1', '/r/a', true, 'w1-2')])
  expect(p.error).toContain('r1')
  expect(p.move).toEqual([])
  expect(p.runs).toEqual([])
})

test('no AX rig refuses', () => {
  expect(splitPlan([rig('h')], []).error).toContain('nothing to move')
})

test('two rows with one name or one repo refuse', () => {
  expect(splitPlan([rig('a', 'ax'), rig('a')], []).error).toContain('name a')
  expect(splitPlan([rig('a', 'ax'), { ...rig('b'), repo: '/r/a' }], []).error).toContain('repo /r/a')
})

test('a server home refuses a non-AX rig at once and before each tick', () => {
  expect(() => assertServerRigs([rig('a', 'ax')])).not.toThrow()
  expect(() => assertServerRigs([])).not.toThrow()
  expect(() => assertServerRigs([rig('a', 'ax'), rig('h'), rig('b', 'herdr')])).toThrow(
    'server home holds non-AX rigs: h, b',
  )
  let ticks = 0
  let rigs = [rig('a', 'ax')]
  const tick = guardedTick(
    () => ticks++,
    () => rigs,
  )
  tick()
  expect(ticks).toBe(1)
  rigs = [rig('a', 'ax'), rig('h')]
  expect(tick).toThrow('server home holds non-AX rigs: h')
  expect(ticks).toBe(1)
})

test('server mode runs the ax runner only', () => {
  expect(() => assertAxRunner('ax', true)).not.toThrow()
  expect(() => assertAxRunner('herdr', true)).toThrow('ax runner only')
  expect(() => assertAxRunner('herdr', false)).not.toThrow()
})

test('rig add refuses a moved name or repo, and a split.json it cannot read', () => {
  const split = JSON.stringify([{ name: 'a', repo: '/r/a', at: 1, to: '/srv' }])
  expect(movedRigRefusal(split, 'a', '/r/other')).toContain('moved')
  expect(movedRigRefusal(split, 'other', '/r/a')).toContain('moved')
  expect(movedRigRefusal(split, 'other', '/r/other')).toBeUndefined()
  expect(movedRigRefusal(undefined, 'a', '/r/a')).toBeUndefined()
  expect(movedRigRefusal('{nope', 'x', '/r/x')).toContain('not a JSON array')
  expect(movedRigRefusal('{}', 'x', '/r/x')).toContain('not a JSON array')
})
