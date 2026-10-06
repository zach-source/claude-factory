import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, validate } from './machine'
import { deadline, missingSweeps, ownCopy, relaunch, room } from './cli'

test('a worker still working at its time limit is warned once and given half again', () => {
  const min = 60_000
  expect(deadline(59 * min, 60, true, false)).toBeNull()
  expect(deadline(61 * min, 60, false, false)).toBe('fail') // idle or gone at the limit: no grace
  expect(deadline(61 * min, 60, true, false)).toBe('warn')
  expect(deadline(75 * min, 60, true, true)).toBeNull() // warned, still inside the grace
  expect(deadline(91 * min, 60, true, true)).toBe('fail')
})

test("a repo's own copy loads without this project and says how it is changed", async () => {
  const copy = ownCopy(readFileSync(join(import.meta.dir, '../factories/lifecycle.ts'), 'utf8'), 'lifecycle')
  expect(copy).not.toContain('src/machine')
  expect(copy).not.toContain('satisfies Factory')
  expect(copy).toStartWith(`// This repo's own factory, from claude-factory's "lifecycle" template`)
  expect(copy).toContain('factory check .factory/lifecycle.ts')

  const dir = join(tmpdir(), `own-${process.pid}`, '.factory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'lifecycle.ts'), copy)
  const def = validate((await import(join(dir, 'lifecycle.ts'))).default)
  expect(def.name).toBe('lifecycle')
  compile(def)
})

test('the loop starts only the sweeps a repo has no run for', async () => {
  const def = (await import('../factories/lifecycle.ts')).default
  const runs = [
    { repo: '/a', goal: 'sweep: monitor' },
    { repo: '/b', goal: 'sweep: maintain' },
    { repo: '/a', goal: 'add a feature' },
  ]
  expect(missingSweeps(def, { repo: '/a' }, runs)).toEqual(['maintain', 'improve'])
  expect(missingSweeps(def, { repo: '/a', sweeps: ['maintain'] }, runs)).toEqual(['maintain'])
  expect(missingSweeps(def, { repo: '/a', sweeps: [] }, runs)).toEqual([])
  expect(missingSweeps({ ...def, nodes: { triage: def.nodes.triage } }, { repo: '/a' }, [])).toEqual([])
})

test("a rig has room under its own cap and the town's", () => {
  const busy = ['web', 'web', 'api', undefined]
  expect(room({ name: 'web', maxRuns: 3 }, busy, 8)).toBe(1)
  expect(room({ name: 'web', maxRuns: 2 }, busy, 8)).toBe(0)
  expect(room({ name: 'api' }, busy, 8)).toBe(4) // no cap of its own: the town's
  expect(room({ name: 'api', maxRuns: 5 }, busy, 5)).toBe(1) // the town fills first
  expect(room(undefined, busy, 8)).toBe(4) // a run outside any rig
})

test('a launch the shell swallowed gets Enter, then the command again, then fails', () => {
  expect(relaunch(60_000, 0)).toBeNull() // Claude may still be starting
  expect(relaunch(91_000, 0)).toBe('enter')
  expect(relaunch(91_000, 1)).toBe('retype')
  expect(relaunch(91_000, 2)).toBe('fail')
})
