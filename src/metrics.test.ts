import { expect, test } from 'bun:test'
import {
  createdAt,
  failKind,
  fate,
  metrics,
  parsePrecheckLines,
  precheckStats,
  render,
  renderTokens,
  sessionOf,
} from './metrics'

const H = 3_600_000
const e = (node: string, outcome: string, h: number, summary = '') => ({
  node,
  attempt: 1,
  outcome,
  summary,
  at: h * H,
})

test("a run's fate: shipped, rejected, closed, aborted or where it is", () => {
  expect(
    fate({
      id: 'a',
      node: 'soak',
      createdAt: 0,
      log: [e('deploy', 'failed', 1), e('deploy', 'deployed', 2)],
    }),
  ).toBe('shipped')
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1)] })).toBe('rejected')
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('implement', 'abandon', 1)] })).toBe('closed')
  expect(fate({ id: 'a', node: 'aborted', createdAt: 0, log: [] })).toBe('aborted')
  expect(fate({ id: 'a', node: 'verify', createdAt: 0, log: [] })).toBe('running@verify')
})

test('metrics count ship rate, time to ship, the approve wait, review loops and failures by kind', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        e('implement', 'fail', 1, 'no report within 60 min'),
        e('implement', 'ready', 2),
        e('review', 'changes', 3),
        e('review', 'approve', 4),
        e('approve', 'ship', 10),
        e('deploy', 'published', 11),
      ],
    },
    { id: 'r2', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1)] },
    {
      id: 'r3',
      node: 'implement',
      createdAt: 0,
      log: [e('implement', 'fail', 1, 'Blocked on operator decision')],
    },
  ])
  expect(m.fates).toEqual({ shipped: 1, rejected: 1, 'running@implement': 1 })
  expect(m.shipRate).toBe(0.5) // of ended runs: the running one is not counted
  expect(m.hoursToShip.median).toBe(11)
  expect(m.approveWaitHours.median).toBe(6)
  expect(m.reviewLoops).toBe(1)
  expect(m.fails).toEqual({ timeout: 1, blocked: 1 })
  expect(m.stations.implement).toEqual({
    visits: 3,
    failed: 2,
    outcomes: { fail: 2, ready: 1 },
    medianHours: 1,
  })
})

test('fate only counts deploy deployed or published as shipped, never blocked/changes/hold', () => {
  expect(fate({ id: 'a', node: 'deploy', createdAt: 0, log: [e('deploy', 'blocked', 1)] })).toBe(
    'running@deploy',
  )
  expect(fate({ id: 'a', node: 'implement', createdAt: 0, log: [e('deploy', 'changes', 1)] })).toBe(
    'running@implement',
  )
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('deploy', 'hold', 1)] })).toBe('closed')
})

test('deploySessionsPerShippedRun counts deploy sessions (not pre-launch PR parks) over shipped runs', () => {
  const prWait = (h: number) => ({ node: 'deploy', attempt: 0, outcome: 'blocked', summary: 'x', at: h * H })
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [prWait(1), e('deploy', 'blocked', 2), e('deploy', 'deployed', 3)],
    },
    { id: 'r2', node: 'done', createdAt: 0, log: [prWait(1), e('deploy', 'published', 2)] },
  ])
  // r1 has 2 real deploy sessions (blocked + deployed; the pre-launch park is not a session)
  // r2 has 1 real deploy session (published; the pre-launch park is not a session)
  // 3 sessions / 2 shipped runs = 1.5
  expect(m.deploySessionsPerShippedRun).toBe(1.5)
})

test('a pre-launch PR park is not a deploy station visit and does not move the wait clock', () => {
  const prWait = (h: number) => ({ node: 'deploy', attempt: 0, outcome: 'blocked', summary: 'x', at: h * H })
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [e('release', 'ready', 1), prWait(2), e('deploy', 'blocked', 2.5), e('deploy', 'deployed', 5)],
    },
  ])
  // the pre-launch park must not count as a station visit or a blocked outcome
  expect(m.stations.deploy).toEqual({
    visits: 2,
    failed: 0,
    outcomes: { blocked: 1, deployed: 1 },
    // prev stays at the release entry (hour 1) through the skipped park, so the real blocked
    // entry's wait is 2.5 - 1 = 1.5h, not 2.5 - 2 = 0.5h as it would be if the park moved prev
    medianHours: 1.5,
  })
})

test("a run's id carries its creation time", () => {
  const t = 1791286012157
  expect(createdAt(`lifecycle-${t.toString(36)}x9`)).toBe(t)
  expect(failKind('worker stopped without reporting')).toBe('worker lost')
})

test("a session's tokens count each turn once, and its station comes from the brief's report line", () => {
  const turn = (id: string, read: number, out: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, usage: { input_tokens: 1, cache_read_input_tokens: read, output_tokens: out } },
    })
  const brief = JSON.stringify({ type: 'user', message: { content: 'report run-1 3 <outcome> "<summary>"' } })
  const s = sessionOf(
    [brief, turn('a', 100, 5), turn('a', 100, 5), turn('b', 300, 7), 'not json', ''],
    'run-1',
    seq => (seq === 3 ? 'implement' : '?'),
  )
  expect(s).toEqual({
    run: 'run-1',
    node: 'implement',
    turns: 2,
    tokens: 101 + 5 + 301 + 7,
    out: 12,
    peak: 301,
  })
  const table = renderTokens([s, { ...s, run: 'run-2', tokens: 1e6 }], new Set(['run-2']))
  expect(table).toContain('2 worker sessions in 2 runs')
  expect(table).toMatch(/implement\s+2/)
})

// claude-factory-6as.4: triage reject rate, and how many of those rejects were ALREADY_DONE
// (the bead's work shipped before triage ever saw it) vs a real triage decision.
test('metrics counts triage visits, rejects, and already-done rejects by summary text', () => {
  const m = metrics([
    { id: 'r1', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1, 'already merged in #57')] },
    { id: 'r2', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1, 'duplicate of ama-9cs.3')] },
    { id: 'r3', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1, 'out of scope for this rig')] },
    { id: 'r4', node: 'implement', createdAt: 0, log: [e('triage', 'ready', 1), e('implement', 'ready', 2)] },
  ])
  expect(m.stations.triage).toEqual({
    visits: 4,
    failed: 0,
    outcomes: { reject: 3, ready: 1 },
    medianHours: 1,
  })
  expect(m.triageAlreadyDone).toBe(2)
})

test('ALREADY_DONE matches the baseline phrases, case-insensitively, and not an unrelated reject', () => {
  const r = (summary: string) =>
    metrics([{ id: 'r', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1, summary)] }])
      .triageAlreadyDone
  expect(r('Already fixed by claude-factory-960.8')).toBe(1)
  expect(r('ALREADY SHIPPED in main')).toBe(1)
  expect(r('is closed as a duplicate')).toBe(1)
  expect(r('superseded by claude-factory-1uj')).toBe(1)
  expect(r('nothing left to do here')).toBe(1)
  expect(r('landed in #42')).toBe(1)
  expect(r('out of scope for this rig')).toBe(0)
  expect(r('waiting on operator decision')).toBe(0)
})

test('parsePrecheckLines reads one JSON object per line and drops a malformed line', () => {
  const text = [
    JSON.stringify({ at: 1000, rig: 'claude-factory', bead: 'a-1', kind: 'merged-pr', evidence: 'x' }),
    'not json',
    JSON.stringify({ at: 2000, rig: 'claude-factory', bead: 'a-2', kind: 'live-run', evidence: 'y' }),
    '',
  ].join('\n')
  expect(parsePrecheckLines(text)).toEqual([
    { at: 1000, rig: 'claude-factory', bead: 'a-1', kind: 'merged-pr', evidence: 'x' },
    { at: 2000, rig: 'claude-factory', bead: 'a-2', kind: 'live-run', evidence: 'y' },
  ])
})

test('precheckStats counts dispatch skips by kind, and counts a fail-open skip row on its own (claude-factory-6as.8)', () => {
  const line = (kind: string) => ({ at: 0, rig: 'r', bead: 'b', kind, evidence: '' })
  expect(
    precheckStats([line('merged-pr'), line('merged-pr'), line('live-run'), line('skip'), line('skip')]),
  ).toEqual({
    skipped: 3,
    mergedPr: 2,
    liveRun: 1,
    failOpen: 2,
  })
  expect(precheckStats([])).toEqual({ skipped: 0, mergedPr: 0, liveRun: 0, failOpen: 0 })
})

test('render prints the triage reject rate and dispatch pre-check skip line', () => {
  const m = metrics([
    { id: 'r1', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1, 'already merged in #57')] },
    { id: 'r2', node: 'implement', createdAt: 0, log: [e('triage', 'ready', 1)] },
  ])
  const out = render(m, 'title', { mergedPr: 2, liveRun: 1, failOpen: 4 })
  expect(out).toContain(
    'triage rejects 1 of 2 (1 already done); dispatch skipped 3 (merged-pr 2, live-run 1), gh fail-open 4',
  )
})

test('render defaults the dispatch pre-check counts, including fail-open, to 0 when no precheck data is given', () => {
  const m = metrics([{ id: 'r1', node: 'implement', createdAt: 0, log: [] }])
  const out = render(m, 'title')
  expect(out).toContain(
    'triage rejects 0 of 0 (0 already done); dispatch skipped 0 (merged-pr 0, live-run 0), gh fail-open 0',
  )
})

// claude-factory-qgz AC9: a run with 3 or more review 'changes' reports counts once, however many
// stations it visits; a run with only 2 does not.
test('runsWith3PlusReviewRounds counts a run once at 3+ review changes, not at 2', () => {
  const capped = [e('review', 'changes', 1), e('review', 'changes', 2), e('review', 'changes', 3)]
  const notCapped = [e('review', 'changes', 1), e('review', 'changes', 2)]
  const m = metrics([
    { id: 'r1', node: 'done', createdAt: 0, log: capped },
    { id: 'r2', node: 'done', createdAt: 0, log: notCapped },
  ])
  expect(m.runsWith3PlusReviewRounds).toBe(1)
  expect(m.reviewLoops).toBe(5) // every review changes, capped or not
})

// claude-factory-qgz AC9: implement passes per shipped run skips handoff, blocked and a pre-launch
// PR park, and counts only shipped runs; a run that never ships does not divide in at all.
test('implementPassesPerShippedRun skips handoff, blocked and isPrWait, and is null with no shipped run', () => {
  const prWait = { node: 'implement', attempt: 0, outcome: 'blocked', summary: 'x', at: 0 }
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        prWait,
        e('implement', 'ready', 1),
        e('implement', 'handoff', 2),
        e('implement', 'blocked', 3),
        e('implement', 'ready', 4),
        e('deploy', 'deployed', 5),
      ],
    },
    { id: 'r2', node: 'implement', createdAt: 0, log: [e('implement', 'ready', 1)] }, // never ships
  ])
  // r1: 2 real implement passes ('ready' x2); handoff, blocked and the pre-launch park do not count
  expect(m.implementPassesPerShippedRun).toBe(2)
  expect(metrics([{ id: 'r', node: 'done', createdAt: 0, log: [] }]).implementPassesPerShippedRun).toBeNull()
})

// claude-factory-qgz AC9: a capped round's re-plan puts plan right after review's own log entry,
// with no station in between; this counts it, and an ordinary review -> implement does not.
test('capReplans counts an adjacent review -> plan log pair, not review -> implement', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'plan',
      createdAt: 0,
      log: [e('review', 'changes', 1), e('plan', 'ready', 2), e('review', 'changes', 3)],
    },
    { id: 'r2', node: 'implement', createdAt: 0, log: [e('review', 'changes', 1)] },
  ])
  expect(m.capReplans).toBe(1)
})

test('render prints the round-cap and implement-passes line', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        e('review', 'changes', 1),
        e('review', 'changes', 2),
        e('review', 'changes', 3),
        e('plan', 'ready', 4),
        e('deploy', 'deployed', 5),
      ],
    },
  ])
  const out = render(m, 'title')
  expect(out).toContain('3+ review rounds 1 runs; cap re-plans 1; implement passes per shipped run 0.00')
})
