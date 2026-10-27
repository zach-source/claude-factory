import { expect, test } from 'bun:test'
import {
  createdAt,
  failKind,
  fate,
  launchStats,
  parseLaunchLines,
  renderLaunches,
  metrics,
  parsePrecheckLines,
  precheckStats,
  render,
  costOf,
  hitRate,
  renderTokens,
  tokensReport,
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
/** a round-cap's own re-plan entry (machine.ts's `onRounds` DONE guard): the only kind `capReplans` counts */
const replan = (node: string, outcome: string, h: number, summary = '') => ({
  ...e(node, outcome, h, summary),
  replan: true as const,
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

// claude-factory-wnm (A9): a run that ended on a requeue edge carries `requeued: true` (copied
// from its track.json). `fate` reports it as 'requeued', ahead of 'rejected'/'closed', and behind
// 'shipped'. An older record with no `requeued` field still reads as 'closed' (or 'rejected'), as
// it always did: this field is new, and optional.
test("a run that ends on an approve is 'handed-off'; a ship run's deploy counts as shipped", () => {
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('review', 'approve', 1)] })).toBe('handed-off')
  expect(
    fate({
      id: 'ship-1',
      node: 'done',
      createdAt: 0,
      log: [e('queue', 'ready', 1), e('deploy', 'published', 2)],
    }),
  ).toBe('shipped')
})

test("a requeued run's fate is 'requeued', ahead of rejected/closed, behind shipped", () => {
  expect(
    fate({ id: 'a', node: 'done', createdAt: 0, log: [e('implement', 'ship', 1)], requeued: true }),
  ).toBe('requeued')
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('triage', 'reject', 1)], requeued: true })).toBe(
    'requeued',
  )
  expect(
    fate({
      id: 'a',
      node: 'soak',
      createdAt: 0,
      log: [e('deploy', 'deployed', 1)],
      requeued: true,
    }),
  ).toBe('shipped') // shipped wins over requeued
  expect(fate({ id: 'a', node: 'done', createdAt: 0, log: [e('implement', 'ship', 1)] })).toBe('closed')
})

test('metrics counts a requeued ending in fates.requeued, out of the shipRate ended sum', () => {
  const m = metrics([
    { id: 'r1', node: 'done', createdAt: 0, log: [e('implement', 'ship', 1)], requeued: true },
    { id: 'r2', node: 'done', createdAt: 0, log: [e('implement', 'ready', 1)] },
  ])
  expect(m.fates).toEqual({ requeued: 1, closed: 1 })
  expect(m.shipRate).toBe(0) // requeued is not an ended run: only r2 (closed) counts
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
  expect(failKind('worker never started on AX after 60 min: task phase Pending')).toBe('not started')
  expect(failKind('the worker never started in pane w1:p1 (no Claude after 3 relaunches)')).toBe(
    'not started',
  )
})

test("a session's tokens count each turn once, and its station comes from the brief's report line", () => {
  const turn = (id: string, read: number, out: number, model = 'claude-opus-4-7', write = 0) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id,
        model,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: write,
          cache_read_input_tokens: read,
          output_tokens: out,
        },
      },
    })
  const brief = JSON.stringify({ type: 'user', message: { content: 'report run-1 3 <outcome> "<summary>"' } })
  const rows = sessionOf(
    [brief, turn('a', 100, 5, undefined, 10), turn('a', 100, 5), turn('b', 300, 7), 'not json', ''],
    'run-1',
    seq => (seq === 3 ? 'implement' : '?'),
    'sess-1',
  )
  expect(rows).toEqual([
    {
      node: 'implement',
      seq: 3,
      session: 'sess-1',
      model: 'claude-opus-4-7',
      input: 2,
      cacheWrite: 10,
      cacheRead: 400,
      output: 12,
      turns: 2,
      peak: 301,
    },
  ])
})

test('renderTokens shows the hit rate, a cost from PRICES, the shipped run tokens by station and model, and the manager names', () => {
  const u = (run: string, node: string, model: string) => ({
    run,
    node,
    seq: 1,
    session: `${node}-${model}`,
    model,
    input: 1_000_000,
    cacheWrite: 1_000_000,
    cacheRead: 8_000_000,
    output: 1_000_000,
    turns: 4,
    peak: 90_000,
  })
  const rows = [
    u('run-1', 'implement', 'claude-opus-4-7'),
    u('run-2', 'implement', 'claude-opus-4-7'),
    u('run-2', 'verify', 'claude-sonnet-4-6'),
    u('run-2', 'verify', 'mystery-9'),
  ]
  const text = renderTokens(rows, new Set(['run-2']), [
    {
      name: 'patrol',
      at: 1,
      model: 'claude-haiku-5-5',
      input: 1e6,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1e6,
    },
  ])
  expect(text).toContain('over 4 worker sessions in 2 runs')
  expect(text).toContain('cache hit rate 80%') // 8 / (1 + 1 + 8)
  // opus: 1*5 + 1*5*1.25 + 8*5*0.1 + 1*25 = 40.25 for one row; sonnet 3 + 3.75 + 2.4 + 15 = 24.15
  expect(costOf(rows[0]!, rows[0]!.model)).toBeCloseTo(40.25)
  expect(costOf(rows[2]!, rows[2]!.model)).toBeCloseTo(24.15)
  expect(costOf(rows[3]!, rows[3]!.model)).toBeNull()
  expect(text).toContain('cost ~$104.65') // 2 opus rows + 1 sonnet row
  expect(text).toContain('1 rows of an unknown model not priced')
  expect(text).toMatch(/implement\s+claude-opus-4-7\s+2/)
  expect(text).toMatch(/verify\s+mystery-9\s+1.*\s-\s/) // an unpriced model: "-" for cost, tokens still counted
  const r = tokensReport(rows, new Set(['run-2']))
  expect(r.stations.find(s => s.node === 'implement')!.perShippedRun).toBe(11_000_000) // run-2's one implement row
  expect(r.tokensPerShippedRun).toBe(33_000_000) // run-2: 3 rows of 11M
  expect(text).toMatch(/patrol\s+claude-haiku-5-5/)
  expect(text).toMatch(/name\s+model\s+rows\s+tokens/)
  expect(text).toContain('$6.00') // haiku: 1*1 + 1*5
  expect(hitRate({ input: 0, cacheWrite: 0, cacheRead: 0, output: 5 })).toBeNull()
})

test('sessionOf gives a row for each model, and a subagent adds tokens but not turns or peak', () => {
  const turn = (id: string, model: string, read: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: read, output_tokens: 2 } },
    })
  const rows = sessionOf([turn('a', 'opus', 50), turn('b', 'sonnet', 70)], 'run-1', () => 'verify', 's', [
    [turn('a', 'haiku', 9000), turn('c', 'opus', 8000)],
  ])
  const by = Object.fromEntries(rows.map(r => [r.model, r]))
  expect(Object.keys(by).sort()).toEqual(['haiku', 'opus', 'sonnet'])
  expect(by.opus).toMatchObject({ cacheRead: 8050, input: 2, turns: 1, peak: 51 }) // 'a' in the subagent counts again: its own file
  expect(by.haiku).toMatchObject({ cacheRead: 9000, turns: 0, peak: 0 })
  expect(by.sonnet).toMatchObject({ turns: 1, peak: 71 })
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

// claude-factory-qgz AC9, review round 1 finding .8: capReplans must count only the machine's own
// round-cap re-plan (Entry.replan). A manager goto plan, after a stuck hold or a review fail, also
// puts plan right next to review in the log. It writes no replan entry. It must not count.
test("capReplans counts only the machine's own re-plan entry, not any review -> plan log pair", () => {
  const m = metrics([
    // the real thing: review's onRounds DONE guard marks its own log entry
    { id: 'r1', node: 'plan', createdAt: 0, log: [replan('review', 'changes', 1), e('plan', 'ready', 2)] },
    // ordinary review -> implement: no plan involved at all
    { id: 'r2', node: 'implement', createdAt: 0, log: [e('review', 'changes', 1)] },
    // a manager goto plan right after review's stuck hold (no onRounds): adjacent in the log, no replan flag
    { id: 'r3', node: 'plan', createdAt: 0, log: [e('review', 'changes', 1), e('plan', 'ready', 2)] },
    // a manager goto plan after review's own fail: also adjacent, also no replan flag
    { id: 'r4', node: 'plan', createdAt: 0, log: [e('review', 'fail', 1), e('plan', 'ready', 2)] },
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
        replan('review', 'changes', 3),
        e('plan', 'ready', 4),
        e('deploy', 'deployed', 5),
      ],
    },
  ])
  const out = render(m, 'title')
  expect(out).toContain('3+ review rounds 1 runs; cap re-plans 1; implement passes per shipped run 0.00')
})

// claude-factory-wnn: the small route's own time-to-ship, apart from the full loop's, and `check`
// sending work back to `quick` counts as a review loop the same way `review`'s `changes` does.
test('metrics counts small runs and their time to ship apart from the full loop', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        e('triage', 'small', 1),
        e('quick', 'ready', 1),
        e('check', 'approve', 2),
        e('release', 'ready', 2),
        e('deploy', 'published', 3),
      ],
    },
    {
      id: 'r2',
      node: 'done',
      createdAt: 0,
      log: [
        e('triage', 'small', 1),
        e('quick', 'ready', 1),
        e('check', 'approve', 5),
        e('release', 'ready', 5),
        e('deploy', 'deployed', 9),
      ],
    },
    {
      id: 'r3',
      node: 'done',
      createdAt: 0,
      log: [
        e('triage', 'build', 1),
        e('plan', 'ready', 2),
        e('implement', 'ready', 10),
        e('review', 'approve', 11),
        e('release', 'ready', 11),
        e('deploy', 'published', 20),
      ],
    },
  ])
  expect(m.small.runs).toBe(2)
  expect(m.small.hoursToShip).toEqual({ median: 3, p90: 9 }) // r1 ships at 3h, r2 at 9h
  expect(m.hoursToShip.median).toBe(9) // the overall figure still counts every shipped run
})

// claude-factory-wnn.5: a triage/fail retry can log before the triage/small entry. isSmall must
// find that entry anywhere in the log, not only at r.log[0].
test('metrics finds a small run whose triage/small entry is not the first log entry', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        e('triage', 'fail', 0, 'no report within 20 min'),
        e('triage', 'small', 1),
        e('quick', 'ready', 1),
        e('check', 'approve', 2),
        e('release', 'ready', 2),
        e('deploy', 'published', 3),
      ],
    },
  ])
  expect(m.small.runs).toBe(1)
  expect(m.small.hoursToShip).toEqual({ median: 3, p90: 3 })
})

// claude-factory-wnn.5: a run quick sends to `full` joins the build loop; it is still a small run
// for the count, but its eventual ship time is a full-loop number, not a small-route one.
test('metrics keeps a run quick sent to full out of the small-route time to ship', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [
        e('triage', 'small', 1),
        e('quick', 'full', 1),
        e('plan', 'ready', 2),
        e('implement', 'ready', 10),
        e('review', 'approve', 11),
        e('release', 'ready', 11),
        e('deploy', 'published', 20),
      ],
    },
  ])
  expect(m.small.runs).toBe(1)
  expect(m.small.hoursToShip).toEqual({ median: null, p90: null })
  expect(m.hoursToShip.median).toBe(20)
})

test('check changes counts as a review loop, same as review changes', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'check',
      createdAt: 0,
      log: [e('triage', 'small', 1), e('quick', 'ready', 1), e('check', 'changes', 2)],
    },
  ])
  expect(m.reviewLoops).toBe(1)
})

test('render prints one small-runs line with its time to ship', () => {
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [e('triage', 'small', 1), e('quick', 'ready', 1), e('deploy', 'published', 2)],
    },
  ])
  const out = render(m, 'title')
  expect(out).toContain('small runs 1, to ship 2.0h median / 2.0h p90')
})

test('a routed outcome (attempt 0, no worker) is not a deploy session or station visit', () => {
  const routed = { node: 'deploy', attempt: 0, outcome: 'changes', summary: 'x', at: 2 * H }
  const m = metrics([
    {
      id: 'r1',
      node: 'done',
      createdAt: 0,
      log: [e('deploy', 'blocked', 1), routed, e('deploy', 'deployed', 3)],
    },
  ])
  expect(m.deploySessionsPerShippedRun).toBe(2)
  expect(m.stations.deploy?.visits).toBe(2)
})

test('launchStats counts launches per station by harness and model, and skips bad lines', () => {
  const line = (node: string, harness: string, model: string) =>
    JSON.stringify({ at: 1, run: 'r', rig: 'w', node, seq: 1, harness, model, resume: false })
  const text = [
    line('implement', 'codex', 'gpt-6.1-sol'),
    line('implement', 'claude', 'claude-sonnet-5-5[1m]'),
    line('implement', 'claude', 'claude-sonnet-5-5[1m]'),
    '{"at":1,"run"',
    line('security', 'codex', 'gpt-6-astra'),
    '{"node":3}',
  ].join('\n')
  const stats = launchStats(parseLaunchLines(text))
  expect(stats).toEqual({
    implement: { 'codex gpt-6.1-sol': 1, 'claude claude-sonnet-5-5[1m]': 2 },
    security: { 'codex gpt-6-astra': 1 },
  })
  expect(renderLaunches(stats)).toContain('implement: claude claude-sonnet-5-5[1m] 2, codex gpt-6.1-sol 1')
  expect(renderLaunches({})).toBe('')
})

test('a deploy unsure still counts as shipped, a failed one does not (claude-factory-ee7 AC6)', () => {
  expect(fate({ id: 'a', node: 'soak', createdAt: 0, log: [e('deploy', 'unsure', 1)] })).toBe('shipped')
  expect(fate({ id: 'a', node: 'rollback', createdAt: 0, log: [e('deploy', 'failed', 1)] })).not.toBe(
    'shipped',
  )
})
