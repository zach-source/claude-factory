// claude-factory-3u1.2.4 (research R1): a help from an attempt that ended red weighs 0.3, not 1.0.
// The dream joins each helped event (by run/station) to the journal entry that ended its attempt.
import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AttemptOutcome, compact, format, helpOk, usageEvents, use } from './memory'

const journal: AttemptOutcome[] = [
  { run: 'r1', node: 'implement', at: 100, outcome: 'fail' },
  { run: 'r1', node: 'implement', at: 200, outcome: 'done' },
  { run: 'r1', node: 'verify', at: 300, outcome: 'blocked' },
  { run: 'r2', node: 'review', at: 150, outcome: 'changes' },
]

test.each<[string, string | undefined, number, boolean | undefined]>([
  ['a help in the first, failed attempt', 'r1/implement', 50, false],
  ['a help in the second, green attempt', 'r1/implement', 150, true],
  ['a help logged the same instant its attempt ended', 'r1/implement', 200, true],
  ['a blocked attempt is not green', 'r1/verify', 250, false],
  ['a review that asked for changes did its job', 'r2/review', 100, true],
  ['an attempt with no entry yet: unknown', 'r1/implement', 250, undefined],
  ['a station the journal never saw: unknown', 'r1/plan', 50, undefined],
  ['a help with no run: unknown', undefined, 50, undefined],
])('helpOk: %s', (_, by, at, want) => {
  expect(helpOk(journal, by, at)).toBe(want)
})

test('compact() weighs a help by its attempt outcome; a line that already has ok keeps it', () => {
  const dir = join(tmpdir(), `memory-help-outcome-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'a.md'), format({ summary: 'a short note', body: 'body' }))
  use(dir, ['beads/a.md'], 'helped', 50, 'r1/implement') // failed attempt
  use(dir, ['beads/a.md'], 'helped', 150, 'r1/implement') // green attempt
  use(dir, ['beads/a.md'], 'helped', 250, 'r1/implement') // still running
  use(dir, ['beads/a.md'], 'shown', 50) // not a help: outcome never applies
  compact(dir, {}, 1000, (by, at) => helpOk(journal, by, at))
  expect(
    usageEvents(dir)
      .get('beads/a.md')!
      .map(e => e.w),
  ).toEqual([0.3, 1, 1, 0.15])

  // a later compact with no journal keeps the folded weights
  compact(dir, {}, 1000)
  expect(
    usageEvents(dir)
      .get('beads/a.md')!
      .map(e => e.w),
  ).toEqual([0.3, 1, 1, 0.15])
  rmSync(dir, { recursive: true, force: true })
})
