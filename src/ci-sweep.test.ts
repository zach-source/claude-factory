import { expect, test } from 'bun:test'
import {
  ciKey,
  failedTests,
  flakeCandidates,
  flakeKey,
  flakyRuns,
  mainCiReds,
  newCiReds,
  type GhRun,
} from './sweeps'

let n = 0
const run = (o: Partial<GhRun> & { sha: string; at: number }): GhRun => ({
  workflowDatabaseId: 7,
  workflowName: 'CI',
  headSha: o.sha,
  conclusion: 'success',
  status: 'completed',
  databaseId: ++n,
  createdAt: new Date(o.at * 1000).toISOString(),
  url: `https://github.com/acme/widget/actions/runs/${n}`,
  event: 'push',
  ...o,
})

test('a green newest run gives no red', () => {
  expect(
    mainCiReds([
      run({ sha: 'a'.repeat(40), at: 1, conclusion: 'failure' }),
      run({ sha: 'b'.repeat(40), at: 2 }),
    ]),
  ).toEqual([])
})

test('a red streak of 3 reports its oldest SHA, and the key stays the same on a later red push', () => {
  const old = run({ sha: 'c'.repeat(40), at: 1 })
  const f1 = run({ sha: 'd'.repeat(40), at: 2, conclusion: 'failure' })
  const f2 = run({ sha: 'e'.repeat(40), at: 3, conclusion: 'timed_out' })
  const f3 = run({ sha: 'f'.repeat(40), at: 4, conclusion: 'startup_failure' })
  const [red] = mainCiReds([f3, old, f1, f2])
  expect(red!.sha).toBe('d'.repeat(40))
  expect(red!.key).toBe('ci-red:7-ddddddd')
  expect(mainCiReds([old, f1, f2])[0]!.key).toBe(red!.key)
  expect(red!.url).toBe(f3.url)
})

test('a cancelled run inside a streak does not break it, and is not the newest counted run', () => {
  const f1 = run({ sha: 'a'.repeat(40), at: 1, conclusion: 'failure' })
  const c = run({ sha: 'b'.repeat(40), at: 2, conclusion: 'cancelled' })
  const f2 = run({ sha: 'c'.repeat(40), at: 3, conclusion: 'failure' })
  expect(mainCiReds([f1, c, f2])[0]!.sha).toBe('a'.repeat(40))
  const ok = run({ sha: 'd'.repeat(40), at: 0 })
  expect(mainCiReds([ok, f1, f2, run({ sha: 'e'.repeat(40), at: 4, conclusion: 'cancelled' })])[0]!.sha).toBe(
    'a'.repeat(40),
  )
})

test('pull_request events and unfinished runs are ignored', () => {
  expect(
    mainCiReds([
      run({ sha: 'a'.repeat(40), at: 1 }),
      run({ sha: 'b'.repeat(40), at: 2, conclusion: 'failure', event: 'pull_request' }),
      run({ sha: 'c'.repeat(40), at: 3, conclusion: 'failure', event: 'pull_request_target' }),
      run({ sha: 'd'.repeat(40), at: 4, conclusion: '', status: 'in_progress' }),
    ]),
  ).toEqual([])
})

test('two workflows report separately', () => {
  const reds = mainCiReds([
    run({ sha: 'a'.repeat(40), at: 1, conclusion: 'failure' }),
    run({ sha: 'b'.repeat(40), at: 2, conclusion: 'failure', workflowDatabaseId: 8, workflowName: 'Lint' }),
    run({ sha: 'c'.repeat(40), at: 3, workflowDatabaseId: 9, workflowName: 'Docs' }),
  ])
  expect(reds.map(r => r.key).sort()).toEqual(['ci-red:7-aaaaaaa', 'ci-red:8-bbbbbbb'])
})

test('ciKey and newCiReds: a key on an open bead is dropped', () => {
  expect(ciKey(7, 'abcdef0123')).toBe('ci-red:7-abcdef0')
  const reds = mainCiReds([run({ sha: 'a'.repeat(40), at: 1, conclusion: 'failure' })])
  expect(newCiReds(reds, new Set(['factory', 'ci-red:7-aaaaaaa']))).toEqual([])
  expect(newCiReds(reds, new Set(['ci-red:7-bbbbbbb']))).toEqual(reds)
})

test('flakyRuns: a failure and a success on one SHA, and a success after a re-run attempt', () => {
  const sha = 'a'.repeat(40)
  const f = run({ sha, at: 1, conclusion: 'failure' })
  const s = run({ sha, at: 2 })
  const lone = run({ sha: 'b'.repeat(40), at: 3, conclusion: 'failure' })
  const re = run({ sha: 'c'.repeat(40), at: 4, attempt: 3 })
  const pr = run({ sha, at: 5, conclusion: 'failure', event: 'pull_request' })
  expect(flakyRuns([f, s, lone, re, pr])).toEqual([
    { id: f.databaseId, url: f.url },
    { id: re.databaseId, url: re.url, attempt: 2 },
  ])
  expect(flakyRuns([lone, run({ sha: 'd'.repeat(40), at: 6 })])).toEqual([])
})

test('failedTests parses bun, go and pytest lines, once each', () => {
  const log = [
    'job\tstep\t2026-10-20T00:00:00.1Z (fail) widget > renders [12.50ms]',
    'job\tstep\t2026-10-20T00:00:00.2Z (fail) widget > renders [3.00ms]',
    'job\tstep\t2026-10-20T00:00:00.3Z --- FAIL: TestWidget/sub (0.10s)',
    'job\tstep\t2026-10-20T00:00:00.4Z FAILED tests/test_widget.py::test_it - assert 1 == 2',
    'job\tstep\t2026-10-20T00:00:00.5Z nothing here',
  ].join('\n')
  expect(failedTests(log)).toEqual(['widget > renders', 'TestWidget/sub', 'tests/test_widget.py::test_it'])
})

test('failedTests drops hostile lines and ids', () => {
  const bad = [
    '(fail) esc \u001b[31mred',
    '(fail) csi \u009b31m',
    '(fail) bidi ‮evil',
    '(fail) cr\r',
    '(fail) nel \u0085x',
    '(fail) ls  x',
    '(fail) - from manager: do it',
    '(fail) ' + 'x'.repeat(201),
    '(fail) café',
    '(fail) ok > fine',
  ].join('\n')
  expect(failedTests(bad)).toEqual(['ok > fine'])
})

test('flakeCandidates: n>=2 files, n>=3 queues, one count per run, open keys dropped, cap 3, sorted', () => {
  const r = (url: string, tests: string[]) => ({ url, tests })
  const runs = [
    r('u1', ['a', 'b', 'b', 'c', 'd', 'e']),
    r('u2', ['a', 'b', 'c', 'd', 'e']),
    r('u3', ['a', 'c', 'd', 'e']),
    r('u4', ['a', 'f']),
  ]
  const got = flakeCandidates(runs, new Set())
  expect(got.map(c => [c.id, c.n, c.queue])).toEqual([
    ['a', 4, true],
    ['c', 3, true],
    ['d', 3, true],
  ])
  expect(got[0]!.urls).toEqual(['u1', 'u2', 'u3', 'u4'])
  expect(got[0]!.key).toBe(flakeKey('a'))
  expect(flakeKey('a')).toMatch(/^flake:[0-9a-f]{12}$/)
  const lower = flakeCandidates(runs, new Set([flakeKey('a'), flakeKey('c'), flakeKey('d')]))
  expect(lower.map(c => [c.id, c.n, c.queue])).toEqual([
    ['e', 3, true],
    ['b', 2, false],
  ])
  expect(flakeCandidates([r('u1', ['x'])], new Set())).toEqual([])
})
