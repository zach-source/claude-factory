import { expect, test } from 'bun:test'
import { splitPlan, type SplitRun } from './splithome'

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
