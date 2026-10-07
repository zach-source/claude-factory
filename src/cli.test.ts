import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, fill, validate } from './machine'
import {
  deadline,
  haltStep,
  missingSweeps,
  ownCopy,
  paramsOf,
  reapable,
  relaunch,
  room,
  withoutFleet,
} from './cli'

test("the factory's Claudes load every mod but herdr-fleet", () => {
  expect(withoutFleet('/m/herdr-fleet').env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
  expect(withoutFleet('/m/herdr-fleet:/m/other').env.CLAUDE_CODE_PLUGIN_DIRS).toBe('/m/other')
  expect(withoutFleet('').env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
})

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

test('a stop tells each worker once, waits while it works, then closes its pane', () => {
  expect(haltStep(false, false, false, 0)).toBe('gone') // its pane is gone already: nothing to stop
  expect(haltStep(true, false, true, 0)).toBe('tell')
  expect(haltStep(true, true, true, 60_000)).toBe('wait') // committing
  expect(haltStep(true, true, false, 60_000)).toBe('close') // quiet: done committing
  expect(haltStep(true, true, true, 6 * 60_000)).toBe('close') // past the grace
})

test("the reaper closes a finished run's workspace and an idle Claude that is not a live run's worker", () => {
  const p = (
    pane_id: string,
    workspace_id: string,
    cwd: string,
    agent_status = 'unknown',
    agent: string | null = null,
  ) => ({
    pane_id,
    workspace_id,
    cwd,
    agent,
    agent_status,
  })
  const runs = [
    { ws: 'w1', worktree: '/wt/a', isOver: true },
    { ws: 'w2', worktree: '/wt/b', isOver: true }, // closed already: w2 is someone else's now
    { ws: 'w3', worktree: '/wt/c', isOver: false, pane: 'w3:p2' },
  ]
  const panes = [
    p('w1:p1', 'w1', '/wt/a'),
    p('w2:p1', 'w2', '/home/other'),
    p('w3:p1', 'w3', '/wt/c'), // the shell the worktree opened with
    p('w3:p2', 'w3', '/wt/c', 'idle', 'claude'), // the run's worker, between turns
    p('w3:p3', 'w3', '/wt/c/src', 'done', 'claude'), // a duplicate
    p('w3:p4', 'w3', '/wt/c', 'working', 'claude'), // left to finish
    p('w3:p5', 'w3', '/wt/cc', 'idle', 'claude'), // another worktree
  ]
  expect(reapable(runs, panes)).toEqual({ workspaces: ['w1'], panes: ['w3:p3'] })
})

test("a worker command's {params} come from the rig, then FACTORY_<NAME>, then the factory", () => {
  const def = { params: { claude: 'claude-smart --new', exec_model: 'sonnet', judge_model: 'opus' } }
  const env = { FACTORY_CLAUDE: 'claude --x', FACTORY_EXEC_MODEL: '  ' }
  const params = paramsOf(def, { params: { judge_model: 'fable' } }, env)
  expect(params).toEqual({ claude: 'claude --x', exec_model: 'sonnet', judge_model: 'fable' })
  expect(fill(`{claude} --model '{judge_model}' --settings '{"a":1}' {other}`, params)).toBe(
    `claude --x --model 'fable' --settings '{"a":1}' {other}`,
  )
  const node = { prompt: 'p', next: { ok: 'done' } }
  expect(() =>
    validate({
      name: 'f',
      start: 'a',
      agent: '{claude} {typo}',
      params: { claude: 'c' },
      nodes: { a: node },
    }),
  ).toThrow('agent names {typo}, which params does not give')
})
