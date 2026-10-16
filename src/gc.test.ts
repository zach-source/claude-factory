// gcPlan() is pure (claude-factory-503.1.1): no filesystem, no herdr, every input a plain fact. These
// tests drive it straight, proving the keep-set vs delete-set rules the acceptance criteria name
// (AC2-AC5), with no CLI or real run directory involved.
import { expect, test } from 'bun:test'
import { gcPlan, LAUNCH_MIN_AGE_MS, type FileFact, type LaunchFact, type RunFact } from './gc'

const DAY = 24 * 3_600_000
const NOW = 1_700_000_000_000

const file = (name: string, bytes = 100, isDir = false, files = 1): FileFact => ({
  name,
  isDir,
  bytes,
  files,
})

const run = (id: string, node: string, finishedAt: number, entries: FileFact[]): RunFact => ({
  id,
  node,
  finishedAt,
  entries,
})

test('a done run past the age cutoff loses its prompts/, briefs and backups; every kept name stays (AC2)', () => {
  const entries = [
    file('prompts', 5_000, true, 12),
    file('f-implement.brief.md', 300),
    file('f-release.brief.md', 300),
    file('rigs.json.before-123', 50),
    file('rigs.json.pre-456', 50),
    // the keep set: every one of these must survive untouched
    file('run.json', 10),
    file('state.json', 10),
    file('inbox.jsonl', 10),
    file('prs.json', 10),
    file('track.json', 10),
    file('progress.json', 10),
    file('factory.json', 10),
    file('factory.ts', 10),
    file('f-implement.json', 10),
    file('f-implement.seen', 10),
  ]
  const plan = gcPlan([run('r1', 'done', NOW - 8 * DAY, entries)], [], new Set(), NOW, 7)
  expect(plan.runs).toHaveLength(1)
  const r = plan.runs[0]!
  expect(r.id).toBe('r1')
  expect(new Set(r.paths)).toEqual(
    new Set([
      'prompts',
      'f-implement.brief.md',
      'f-release.brief.md',
      'rigs.json.before-123',
      'rigs.json.pre-456',
    ]),
  )
  expect(r.kinds.prompts).toEqual({ bytes: 5_000, files: 12 })
  expect(r.kinds.briefs).toEqual({ bytes: 600, files: 2 })
  expect(r.kinds.backups).toEqual({ bytes: 100, files: 2 })
  expect(plan.totals).toEqual({
    prompts: { bytes: 5_000, files: 12 },
    briefs: { bytes: 600, files: 2 },
    backups: { bytes: 100, files: 2 },
    launch: { bytes: 0, files: 0 },
    runs: 1,
  })
})

test('a run still running is untouched even 30 days old (AC3)', () => {
  const entries = [file('prompts', 5_000, true, 12), file('f-implement.brief.md', 300)]
  const plan = gcPlan([run('r1', 'implement.working', NOW - 30 * DAY, entries)], [], new Set(), NOW, 7)
  expect(plan.runs).toEqual([])
  expect(plan.totals.runs).toBe(0)
})

test('a done run younger than the cutoff is untouched (AC4)', () => {
  const entries = [file('prompts', 5_000, true, 12)]
  const plan = gcPlan([run('r1', 'done', NOW - 6 * DAY, entries)], [], new Set(), NOW, 7)
  expect(plan.runs).toEqual([])
})

test('an aborted run exactly at the cutoff is eligible', () => {
  const entries = [file('prompts', 5_000, true, 12)]
  const plan = gcPlan([run('r1', 'aborted', NOW - 7 * DAY, entries)], [], new Set(), NOW, 7)
  expect(plan.runs).toHaveLength(1)
})

test('a done run with nothing to prune contributes no run to the plan', () => {
  const entries = [file('run.json', 10), file('state.json', 10)]
  const plan = gcPlan([run('r1', 'done', NOW - 8 * DAY, entries)], [], new Set(), NOW, 7)
  expect(plan.runs).toEqual([])
  expect(plan.totals.runs).toBe(0)
})

test('livePanes null removes no launch script, however old or dead (AC5)', () => {
  const launch: LaunchFact[] = [{ pane: 'dead', bytes: 10, mtimeMs: NOW - 2 * 3_600_000 }]
  const plan = gcPlan([], launch, null, NOW, 7)
  expect(plan.launch).toEqual([])
  expect(plan.totals.launch).toEqual({ bytes: 0, files: 0 })
})

test('a dead pane script under the 1h grace window is kept (AC5)', () => {
  const launch: LaunchFact[] = [{ pane: 'dead', bytes: 10, mtimeMs: NOW - 10 * 60_000 }]
  const plan = gcPlan([], launch, new Set(), NOW, 7)
  expect(plan.launch).toEqual([])
})

test('a dead pane script past the 1h grace window is removed (AC5)', () => {
  const launch: LaunchFact[] = [{ pane: 'dead', bytes: 10, mtimeMs: NOW - LAUNCH_MIN_AGE_MS - 1 }]
  const plan = gcPlan([], launch, new Set(), NOW, 7)
  expect(plan.launch).toEqual(['dead'])
  expect(plan.totals.launch).toEqual({ bytes: 10, files: 1 })
})

test('a live pane keeps its script however old (AC5)', () => {
  const launch: LaunchFact[] = [{ pane: 'live', bytes: 10, mtimeMs: NOW - 30 * DAY }]
  const plan = gcPlan([], launch, new Set(['live']), NOW, 7)
  expect(plan.launch).toEqual([])
})
