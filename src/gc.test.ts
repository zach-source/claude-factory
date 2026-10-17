// gcPlan() is pure (claude-factory-503.1.1): no filesystem, no herdr, every input a plain fact. These
// tests drive it straight, proving the keep-set vs delete-set rules the acceptance criteria name
// (AC2-AC5), with no CLI or real run directory involved.
import { expect, test } from 'bun:test'
import {
  gcPlan,
  LAUNCH_MIN_AGE_MS,
  parsePrPages,
  scrubUrlUserinfo,
  worktreePlan,
  WORKTREE_MIN_AGE_MS,
  type BranchFact,
  type FileFact,
  type LaunchFact,
  type PrFact,
  type RigWorktreeFacts,
  type RunFact,
  type RunRef,
  type WorktreeFact,
} from './gc'

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

// ---- worktreePlan() (claude-factory-l38): the pure half of `factory gc --worktrees` ----

const OLD = NOW - 2 * WORKTREE_MIN_AGE_MS
const ref = (id: string, node: string, worktree = `/wt/${id}`, extra: Partial<RunRef> = {}): RunRef => ({
  id,
  node,
  finishedAt: OLD,
  worktree,
  ...extra,
})
const wt = (path: string, branch: string | null, extra: Partial<WorktreeFact> = {}): WorktreeFact => ({
  path,
  branch,
  locked: false,
  dirty: 'clean',
  bytes: 1_000,
  ...extra,
})
const branch = (name: string, extra: Partial<BranchFact> = {}): BranchFact => ({
  name,
  local: 'aaa',
  remote: 'aaa',
  localMerged: false,
  remoteMerged: false,
  ...extra,
})
const rigFacts = (extra: Partial<RigWorktreeFacts> = {}): RigWorktreeFacts => ({
  name: 'r',
  worktrees: [],
  branches: [],
  prs: [],
  beadClosed: {},
  ...extra,
})
const planOf = (rig: RigWorktreeFacts, runs: RunRef[], panes: { cwd: string }[] | null = []) =>
  worktreePlan([rig], runs, panes, NOW)[0]!

test('1: a live run with a merged branch plans nothing', () => {
  const runs = [ref('r1', 'implement.working')]
  const rig = rigFacts({
    worktrees: [wt('/wt/r1', 'factory/r1')],
    branches: [branch('factory/r1', { localMerged: true, remoteMerged: true })],
  })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([])
  expect(p.removeBranches).toEqual([])
})

test('2: a finished clean run with a merged branch removes the worktree and deletes both tips', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({
    worktrees: [wt('/wt/r1', 'factory/r1')],
    branches: [branch('factory/r1', { local: 'aaa', remote: 'bbb', localMerged: true, remoteMerged: true })],
  })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([{ runId: 'r1', path: '/wt/r1', bytes: 1_000, snapshot: false }])
  expect(p.removeBranches).toEqual([{ runId: 'r1', name: 'factory/r1', local: 'aaa', remote: 'bbb' }])
})

test('3: unmerged with no PR keeps the branch, but still removes the worktree', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({
    worktrees: [wt('/wt/r1', 'factory/r1')],
    branches: [branch('factory/r1')],
  })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toHaveLength(1)
  expect(p.removeBranches).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r1', name: 'factory/r1', reason: 'unmerged' })
})

test('4: a MERGED PR whose headRefOid equals the tip deletes; a tip past the merge is kept', () => {
  const runs = [ref('r1', 'done'), ref('r2', 'done')]
  const prs: PrFact[] = [
    { state: 'MERGED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: false },
  ]
  const r1 = rigFacts({
    worktrees: [],
    branches: [branch('factory/r1', { local: 'aaa', remote: 'aaa' })],
    prs,
  })
  expect(planOf(r1, runs).removeBranches).toEqual([
    { runId: 'r1', name: 'factory/r1', local: 'aaa', remote: 'aaa' },
  ])
  const prs2: PrFact[] = [
    { state: 'MERGED', headRefName: 'factory/r2', headRefOid: 'aaa', isCrossRepository: false },
  ]
  const r2 = rigFacts({
    worktrees: [],
    branches: [branch('factory/r2', { local: 'ccc', remote: 'aaa' })],
    prs: prs2,
  })
  expect(planOf(r2, runs).removeBranches).toEqual([])
})

test('5: a CLOSED PR with the bead closed deletes; open or unknown bead keeps', () => {
  const runs = [ref('r1', 'done', '/wt/r1', { bead: 'b-1' }), ref('r2', 'done', '/wt/r2', { bead: 'b-2' })]
  const prs: PrFact[] = [
    { state: 'CLOSED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: false },
    { state: 'CLOSED', headRefName: 'factory/r2', headRefOid: 'aaa', isCrossRepository: false },
  ]
  const rig = rigFacts({
    worktrees: [],
    branches: [branch('factory/r1'), branch('factory/r2')],
    prs,
    beadClosed: { 'b-1': true },
  })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([{ runId: 'r1', name: 'factory/r1', local: 'aaa', remote: 'aaa' }])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r2', name: 'factory/r2', reason: 'bead-open' })
})

test('5a: a cross-repo CLOSED PR with a closed bead never covers a tip (claude-factory-ulv)', () => {
  const runs = [ref('r1', 'done', '/wt/r1', { bead: 'b-1' })]
  const prs: PrFact[] = [
    { state: 'CLOSED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: true },
  ]
  const rig = rigFacts({
    worktrees: [],
    branches: [branch('factory/r1')],
    prs,
    beadClosed: { 'b-1': true },
  })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r1', name: 'factory/r1', reason: 'unmerged' })
})

test('5b: a cross-repo MERGED PR never covers a tip (claude-factory-ulv)', () => {
  const runs = [ref('r1', 'done')]
  const prs: PrFact[] = [
    { state: 'MERGED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: true },
  ]
  const rig = rigFacts({ worktrees: [], branches: [branch('factory/r1')], prs })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r1', name: 'factory/r1', reason: 'unmerged' })
})

test('5c: a same-repo MERGED PR still covers (control for 5a/5b)', () => {
  const runs = [ref('r1', 'done')]
  const prs: PrFact[] = [
    { state: 'MERGED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: false },
  ]
  const rig = rigFacts({ worktrees: [], branches: [branch('factory/r1')], prs })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([{ runId: 'r1', name: 'factory/r1', local: 'aaa', remote: 'aaa' }])
})

test('6: an OPEN PR with an ancestor tip keeps', () => {
  const runs = [ref('r1', 'done')]
  const prs: PrFact[] = [
    { state: 'OPEN', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: false },
  ]
  const rig = rigFacts({
    worktrees: [],
    branches: [branch('factory/r1', { localMerged: true, remoteMerged: true })],
    prs,
  })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r1', name: 'factory/r1', reason: 'open-pr' })
})

test('7: a diverged, uncovered remote tip keeps both', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({
    worktrees: [],
    branches: [branch('factory/r1', { local: 'aaa', remote: 'bbb', localMerged: true, remoteMerged: false })],
  })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r1', name: 'factory/r1', reason: 'diverged' })
})

test('8: null branch or PR facts delete no branch in that rig', () => {
  const runs = [ref('r1', 'done')]
  const noBranches = planOf(rigFacts({ branches: null }), runs)
  expect(noBranches.removeBranches).toEqual([])
  const noPrs = planOf(
    rigFacts({ branches: [branch('factory/r1', { localMerged: true, remoteMerged: true })], prs: null }),
    runs,
  )
  expect(noPrs.removeBranches).toEqual([])
  expect(noPrs.keep).toContainEqual({
    kind: 'branch',
    runId: 'r1',
    name: 'factory/r1',
    reason: 'facts-unavailable',
  })
})

test('9: panes null removes no worktree; a pane cwd in a subdirectory keeps it', () => {
  const runs = [ref('r1', 'done'), ref('r2', 'done', '/wt/r2')]
  const rig = rigFacts({ worktrees: [wt('/wt/r1', 'factory/r1'), wt('/wt/r2', 'factory/r2')] })
  const nullPanes = planOf(rig, runs, null)
  expect(nullPanes.removeWorktrees).toEqual([])
  const sub = planOf(rig, runs, [{ cwd: '/wt/r2/sub/dir' }])
  expect(sub.removeWorktrees.map(r => r.runId)).toEqual(['r1'])
  expect(sub.keep).toContainEqual({ kind: 'worktree', runId: 'r2', name: '/wt/r2', reason: 'pane-open' })
})

test('10: a small dirty worktree is removed with a snapshot; a large one is kept', () => {
  const runs = [ref('r1', 'done'), ref('r2', 'done', '/wt/r2')]
  const rig = rigFacts({
    worktrees: [
      wt('/wt/r1', 'factory/r1', { dirty: 'small' }),
      wt('/wt/r2', 'factory/r2', { dirty: 'large' }),
    ],
  })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([{ runId: 'r1', path: '/wt/r1', bytes: 1_000, snapshot: true }])
  expect(p.keep).toContainEqual({ kind: 'worktree', runId: 'r2', name: '/wt/r2', reason: 'dirty-large' })
})

test('11: a locked worktree is kept', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({ worktrees: [wt('/wt/r1', 'factory/r1', { locked: true })] })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'worktree', runId: 'r1', name: '/wt/r1', reason: 'locked' })
})

test('12: a codex/* worktree and an unowned factory/x branch are never planned, counted unowned', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({
    worktrees: [wt('/wt/codex', 'codex/abc')],
    branches: [branch('factory/x', { localMerged: true, remoteMerged: true })],
  })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([])
  expect(p.removeBranches).toEqual([])
  expect(p.unowned).toBe(2)
})

test('13: longest id prefix gives a side worktree to the live fork, not the finished parent', () => {
  const runs = [ref('r1', 'done'), ref('r1-2', 'implement.working', '/wt/r1-2')]
  const rig = rigFacts({ worktrees: [wt('/wt/side', 'factory/r1-2-sidework')] })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'worktree', runId: 'r1-2', name: '/wt/side', reason: 'live' })
})

test('14: a run finished under an hour ago keeps its worktree', () => {
  const runs = [ref('r1', 'done', '/wt/r1', { finishedAt: NOW - 10 * 60_000 })]
  const rig = rigFacts({ worktrees: [wt('/wt/r1', 'factory/r1')] })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'worktree', runId: 'r1', name: '/wt/r1', reason: 'recent' })
})

test('15: a branch checked out in a kept worktree is not deleted', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({
    worktrees: [wt('/wt/r1', 'factory/r1', { locked: true })],
    branches: [branch('factory/r1', { localMerged: true, remoteMerged: true })],
  })
  const p = planOf(rig, runs)
  expect(p.removeBranches).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'branch', runId: 'r1', name: 'factory/r1', reason: 'checked-out' })
})

test("17: a worktree whose dirty state is 'unknown' (a failed status or ls-files read) is kept, never snapshotted (claude-factory-l38.7)", () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({ worktrees: [wt('/wt/r1', 'factory/r1', { dirty: 'unknown' })] })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([])
  expect(p.keep).toContainEqual({ kind: 'worktree', runId: 'r1', name: '/wt/r1', reason: 'dirty-unknown' })
})

test('16: a non-factory branch on a run worktree path removes the worktree, never the branch', () => {
  const runs = [ref('r1', 'done')]
  const rig = rigFacts({ worktrees: [wt('/wt/r1', 'main')] })
  const p = planOf(rig, runs)
  expect(p.removeWorktrees).toEqual([{ runId: 'r1', path: '/wt/r1', bytes: 1_000, snapshot: false }])
  expect(p.removeBranches).toEqual([])
})

// parsePrPages() parses the stdout of `gh api graphql --paginate` (claude-factory-ph8): one JSON
// line per page, each `{totalCount, nodes}`. These tests prove it never returns a partial list.
const node = (
  number: number,
  state: 'OPEN' | 'MERGED' | 'CLOSED',
  headRefName: string,
  headRefOid: string,
  isCrossRepository = false,
) => ({
  number,
  state,
  headRefName,
  headRefOid,
  isCrossRepository,
})
const pageLine = (totalCount: number, nodes: unknown[]) => JSON.stringify({ totalCount, nodes })

test('parsePrPages: a single page returns every PR as a PrFact', () => {
  const stdout = pageLine(2, [node(1, 'MERGED', 'factory/r1', 'aaa'), node(2, 'OPEN', 'factory/r2', 'bbb')])
  expect(parsePrPages(stdout)).toEqual([
    { state: 'MERGED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: false },
    { state: 'OPEN', headRefName: 'factory/r2', headRefOid: 'bbb', isCrossRepository: false },
  ])
})

test('parsePrPages: an 11-page, 1050-PR stdout returns every PR, none dropped', () => {
  const pages: string[] = []
  for (let page = 0; page < 11; page++) {
    const size = page < 10 ? 100 : 50
    const nodes = Array.from({ length: size }, (_, i) => {
      const n = page * 100 + i
      return node(n, 'OPEN', `factory/r${n}`, `sha${n}`)
    })
    pages.push(pageLine(1050, nodes))
  }
  const out = parsePrPages(pages.join('\n'))
  expect(out).not.toBeNull()
  expect(out!.length).toBe(1050)
  expect(out).toContainEqual({
    state: 'OPEN',
    headRefName: 'factory/r1049',
    headRefOid: 'sha1049',
    isCrossRepository: false,
  })
})

test('parsePrPages: empty stdout (no line) returns null', () => {
  expect(parsePrPages('')).toBeNull()
  expect(parsePrPages('\n\n')).toBeNull()
})

test('parsePrPages: a line that fails to parse returns null', () => {
  expect(parsePrPages('not json')).toBeNull()
})

test('parsePrPages: a null page (a null `repository`) returns null', () => {
  expect(parsePrPages('null')).toBeNull()
})

test('parsePrPages: totalCount not a number returns null', () => {
  expect(
    parsePrPages(JSON.stringify({ totalCount: '2', nodes: [node(1, 'OPEN', 'factory/r1', 'aaa')] })),
  ).toBeNull()
})

test('parsePrPages: nodes not an array returns null', () => {
  expect(parsePrPages(JSON.stringify({ totalCount: 1, nodes: 'nope' }))).toBeNull()
})

test('parsePrPages: a node with a state outside OPEN/MERGED/CLOSED returns null', () => {
  expect(parsePrPages(pageLine(1, [node(1, 'DRAFT' as never, 'factory/r1', 'aaa')]))).toBeNull()
})

test('parsePrPages: a node with a non-number `number` returns null', () => {
  const bad = {
    number: '1',
    state: 'OPEN',
    headRefName: 'factory/r1',
    headRefOid: 'aaa',
    isCrossRepository: false,
  }
  expect(parsePrPages(pageLine(1, [bad]))).toBeNull()
})

test('parsePrPages: a node with a non-string headRefName returns null', () => {
  const bad = { number: 1, state: 'OPEN', headRefName: 7, headRefOid: 'aaa', isCrossRepository: false }
  expect(parsePrPages(pageLine(1, [bad]))).toBeNull()
})

test('parsePrPages: a node with a non-string headRefOid returns null', () => {
  const bad = { number: 1, state: 'OPEN', headRefName: 'factory/r1', headRefOid: 7, isCrossRepository: false }
  expect(parsePrPages(pageLine(1, [bad]))).toBeNull()
})

test('parsePrPages: a node with a missing isCrossRepository returns null (claude-factory-ph8.4)', () => {
  const bad = { number: 1, state: 'OPEN', headRefName: 'factory/r1', headRefOid: 'aaa' }
  expect(parsePrPages(pageLine(1, [bad]))).toBeNull()
})

test('parsePrPages: a node with a non-boolean isCrossRepository returns null (claude-factory-ph8.4)', () => {
  const bad = {
    number: 1,
    state: 'OPEN',
    headRefName: 'factory/r1',
    headRefOid: 'aaa',
    isCrossRepository: 'false',
  }
  expect(parsePrPages(pageLine(1, [bad]))).toBeNull()
})

test('parsePrPages: fewer distinct PR numbers than the first page totalCount returns null (a lost page)', () => {
  const stdout = pageLine(2, [node(1, 'OPEN', 'factory/r1', 'aaa')])
  expect(parsePrPages(stdout)).toBeNull()
})

test('parsePrPages: a repeated PR number across pages is deduped, not double-counted', () => {
  const p1 = pageLine(2, [node(1, 'OPEN', 'factory/r1', 'aaa')])
  const p2 = pageLine(2, [node(1, 'MERGED', 'factory/r1', 'bbb'), node(2, 'OPEN', 'factory/r2', 'ccc')])
  const out = parsePrPages([p1, p2].join('\n'))
  expect(out).toEqual([
    { state: 'MERGED', headRefName: 'factory/r1', headRefOid: 'bbb', isCrossRepository: false },
    { state: 'OPEN', headRefName: 'factory/r2', headRefOid: 'ccc', isCrossRepository: false },
  ])
})

test('parsePrPages: a cross-repository PR keeps isCrossRepository: true', () => {
  const stdout = pageLine(1, [node(1, 'CLOSED', 'factory/r1', 'aaa', true)])
  expect(parsePrPages(stdout)).toEqual([
    { state: 'CLOSED', headRefName: 'factory/r1', headRefOid: 'aaa', isCrossRepository: true },
  ])
})

// scrubUrlUserinfo() (claude-factory-0lt, AC1): removes "user:pass@" or "token@" from each URL in a
// string, so a secret in a git remote's userinfo never lands in the gc-worktrees.jsonl journal.
test('scrubUrlUserinfo: a user:pass@ userinfo is removed from an https URL', () => {
  expect(scrubUrlUserinfo('https://e2e-user:e2e-tok3n@github.com/acme/widget.git')).toBe(
    'https://github.com/acme/widget.git',
  )
})

test('scrubUrlUserinfo: a token-only userinfo (no colon) is removed too', () => {
  expect(scrubUrlUserinfo('https://e2e-tok3n@h/x')).toBe('https://h/x')
})

test('scrubUrlUserinfo: an ssh URL loses its git@ userinfo', () => {
  expect(scrubUrlUserinfo('ssh://git@h/x')).toBe('ssh://h/x')
})

test('scrubUrlUserinfo: every URL in a string with 2 URLs is scrubbed', () => {
  const text =
    "fatal: unable to access 'https://e2e-user:e2e-tok3n@github.com/acme/widget.git/': " +
    'also see ssh://git@h/x for details'
  const scrubbed = scrubUrlUserinfo(text)
  expect(scrubbed).toBe(
    "fatal: unable to access 'https://github.com/acme/widget.git/': also see ssh://h/x for details",
  )
  expect(scrubbed).not.toContain('e2e-tok3n')
  expect(scrubbed).not.toContain('e2e-user')
})

test('scrubUrlUserinfo: an scp-style remote (no scheme) is left alone', () => {
  expect(scrubUrlUserinfo('git@github.com:acme/widget.git')).toBe('git@github.com:acme/widget.git')
})

test('scrubUrlUserinfo: plain text with no URL is unchanged', () => {
  expect(scrubUrlUserinfo('fatal: not a git repository')).toBe('fatal: not a git repository')
})
