import { expect, test } from 'bun:test'
import { ciKey, mainCiReds, newCiReds, type GhRun } from './sweeps'

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
