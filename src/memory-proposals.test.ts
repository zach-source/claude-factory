// claude-factory-3u1.3.1 (FR-018, research R8): the dream finds failure classes and re-learned lessons,
// and writes at most 3 proposals one rung up the learning ladder.
import { expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttemptOutcome,
  dreamPrompt,
  failureClasses,
  format,
  installCoreProposal,
  normalizeReason,
  PROPOSAL_CAP,
  proposals,
  proposalsOverCap,
  rejectProposal,
  relearned,
  withCoreLine,
  withFrontmatter,
} from './memory'

test.each([
  ['Tests FAILED in src/foo.test.ts: 3 of 12', 'tests failed in src/foo.test.ts: of'],
  ['bead acme-widget-h7c.2 is blocked on acme-widget-x9z', 'bead is blocked on'],
  ['lint failed.\nlong detail on line two', 'lint failed'],
  ['  Push   rejected (exit 128)  ', 'push rejected (exit'],
])('normalizeReason(%p) is %p', (raw, want) => {
  expect(normalizeReason(raw)).toBe(want)
})

const e = (run: string, node: string, outcome: string, summary: string, at = 1): AttemptOutcome => ({
  run,
  node,
  outcome,
  summary,
  at,
})

test('failureClasses groups a station and a normalized reason across 3+ distinct runs, red outcomes only', () => {
  const journal = [
    e('r1', 'verify', 'fail', 'Lint failed on 3 files.'),
    e('r1', 'verify', 'fail', 'Lint failed on 4 files.'), // same run again: still 1 run
    e('r2', 'verify', 'blocked', 'lint failed on 9 files. other detail'),
    e('r3', 'verify', 'fail', 'LINT FAILED on 1 files'),
    e('r4', 'implement', 'fail', 'lint failed on 2 files'), // another station
    e('r5', 'verify', 'done', 'lint failed on 2 files'), // green: not a failure
    e('r6', 'review', 'fail', 'flaky'),
    e('r7', 'review', 'fail', 'flaky'),
  ]
  expect(failureClasses(journal)).toEqual([
    { station: 'verify', reason: 'lint failed on files', runs: ['r1', 'r2', 'r3'] },
  ])
})

test('failureClasses lists the class with the most runs first', () => {
  const journal = [
    ...['a', 'b', 'c'].map(r => e(r, 'plan', 'fail', 'no plan')),
    ...['d', 'e', 'f', 'g'].map(r => e(r, 'ci', 'red', 'ci red')),
  ]
  expect(failureClasses(journal).map(c => c.station)).toEqual(['ci', 'plan'])
})

test.each<[string, string[], string[], string[]]>([
  ['3 new: none over', ['old'], ['old', 'a', 'b', 'c'], []],
  ['5 new: the last 2 by name are over', [], ['e', 'd', 'c', 'b', 'a'], ['d', 'e']],
  ['old ones never count', ['x', 'y', 'z'], ['x', 'y', 'z', 'a'], []],
])('proposalsOverCap: %s', (_, before, after, want) => {
  expect(proposalsOverCap(before, after)).toEqual(want)
  expect(PROPOSAL_CAP).toBe(3)
})

test('relearned names an inbox note that says what a CORE.md line already says', async () => {
  const dir = join(tmpdir(), `memory-relearned-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  writeFileSync(
    join(dir, 'CORE.md'),
    '- bd init on the shared Dolt server locks every repo\n- run prettier before a PR\n',
  )
  writeFileSync(
    join(dir, 'inbox', 'a.md'),
    format({ summary: 'bd init on the shared dolt server locks every repo', body: '' }),
  )
  writeFileSync(join(dir, 'inbox', 'b.md'), format({ summary: 'the deploy needs a VPN', body: '' }))
  expect(await relearned(dir)).toEqual([
    '- inbox/a.md re-learns CORE.md: bd init on the shared Dolt server locks every repo',
  ])
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

test('dreamPrompt lists failure classes, re-learned lessons and proposals, and caps proposals at 3', () => {
  const p = dreamPrompt('/m', [], [], [], undefined, [], [], [], [], 15, {
    failures: [{ station: 'verify', reason: 'lint failed', runs: ['r1', 'r2', 'r3'] }],
    relearned: ['- inbox/a.md re-learns CORE.md: x'],
    proposals: ['- lint-first (pending, rung instruction)'],
  })
  expect(p).toContain('- verify: lint failed (3 runs: r1, r2, r3)')
  expect(p).toContain('- inbox/a.md re-learns CORE.md: x')
  expect(p).toContain('- lint-first (pending, rung instruction)')
  expect(p).toContain('/m/.proposals/<name>.md')
  expect(p).toContain('at most 3')
})

test('proposals() reads each .proposals/<name>.md frontmatter and its first body line', () => {
  const dir = join(tmpdir(), `memory-proposals-list-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.proposals'), { recursive: true })
  writeFileSync(
    join(dir, '.proposals', 'lint-first.md'),
    '---\nrung: instruction\ntarget: station:verify\nstatus: pending\nevidence: ["r1","r2","r3"]\ncreated: 2026-10-23\n---\nRun the linter before the tests.\nWhy: three runs.\n',
  )
  writeFileSync(join(dir, '.proposals', 'notes.txt'), 'not a proposal')
  expect(proposals(dir)).toEqual([
    {
      name: 'lint-first',
      rung: 'instruction',
      target: 'station:verify',
      status: 'pending',
      change: 'Run the linter before the tests.',
      file: join(dir, '.proposals', 'lint-first.md'),
    },
  ])
  expect(proposals(join(dir, 'none'))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})

// claude-factory-3u1.3.2 (FR-019..021): install and reject
test.each([
  ['an empty CORE.md', '', '- new line\n'],
  ['a top with no rig sections', '- a\n- b\n', '- a\n- b\n- new line\n'],
  ['a top before a rig section', '- a\n\n## rig: x\n- x1\n', '- a\n- new line\n\n## rig: x\n- x1\n'],
  ['only a rig section', '## rig: x\n- x1\n', '- new line\n\n## rig: x\n- x1\n'],
])('withCoreLine: %s', (_, core, want) => {
  expect(withCoreLine(core, 'new line')).toBe(want)
})

test.each([
  [
    'replaces a key',
    '---\nstatus: pending\nrung: core\n---\nbody\n',
    'status',
    'installed',
    '---\nstatus: installed\nrung: core\n---\nbody\n',
  ],
  [
    'adds a key',
    '---\nstatus: pending\n---\nbody\n',
    'bead',
    'x-1',
    '---\nstatus: pending\nbead: x-1\n---\nbody\n',
  ],
  [
    'leaves the body alone',
    '---\nstatus: pending\n---\nstatus: in the body\n',
    'status',
    'rejected',
    '---\nstatus: rejected\n---\nstatus: in the body\n',
  ],
])('withFrontmatter: %s', (_, text, key, value, want) => {
  expect(withFrontmatter(text, key, value)).toBe(want)
})

test('installCoreProposal adds the line to CORE.md and marks it installed; rejectProposal writes the reason to the inbox', () => {
  const dir = join(tmpdir(), `memory-proposals-install-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.proposals'), { recursive: true })
  writeFileSync(join(dir, 'CORE.md'), '- old line\n')
  const p = (rung: string, change: string) =>
    `---\nrung: ${rung}\ntarget: CORE.md\nstatus: pending\n---\n${change}\n`
  writeFileSync(join(dir, '.proposals', 'a.md'), p('core', 'Run prettier before a PR.'))
  writeFileSync(join(dir, '.proposals', 'b.md'), p('instruction', 'Lint first.'))
  installCoreProposal(dir, 'a')
  expect(readFileSync(join(dir, 'CORE.md'), 'utf8')).toBe('- old line\n- Run prettier before a PR.\n')
  expect(proposals(dir).find(x => x.name === 'a')?.status).toBe('installed')
  expect(() => installCoreProposal(dir, 'a')).toThrow('no pending proposal a')
  expect(() => installCoreProposal(dir, 'b')).toThrow('rung instruction')

  rejectProposal(dir, 'b', 'the linter already runs first')
  expect(proposals(dir).find(x => x.name === 'b')?.status).toBe('rejected')
  const inbox = readdirSync(join(dir, 'inbox')).map(f => readFileSync(join(dir, 'inbox', f), 'utf8'))
  expect(inbox.join('\n')).toContain('rejected the proposal b: the linter already runs first')
  expect(() => rejectProposal(dir, '../x', 'why')).toThrow('no pending proposal ../x')
  rmSync(dir, { recursive: true, force: true })
})
