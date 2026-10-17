import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { createActor } from 'xstate'
import { ruleLines } from '../src/cli'
import {
  compile,
  isPrWait,
  repeatQuestion,
  timeoutOf,
  validate,
  where,
  WATCHED_PARK_MIN,
  type Factory,
} from '../src/machine'
import lifecycle from './lifecycle'
import release from './release'

const PR = 'https://github.com/acme/widget/pull/42'

// shaped like the real ax and claude-factory rig goals behind the incidents this bead fixes, with the
// private repo paths swapped for the acme/widget fixture (the guard-private commit hook refuses the real ones)
const AX_GOAL =
  'Make ax a reliable remote runner for the factory at about 20 concurrent tasks. First: size the ax ' +
  'WorkerPool (deploy/acme/workerpool.yaml: replicas 2, 8Gi per worker today) so about 20 tasks fit ' +
  'without OOM; then make task placement memory-aware, let task routing survive a worker restart (ax ssh ' +
  'answered 421 for every task of a restarted worker on 2026-10-15), and clear tasks stuck in Terminating. ' +
  'Branch from and open PRs against acme/widget (the deploy branch; main tracks upstream). Skip owner-' +
  'only live applies, credential and branch-protection steps and surface them instead.'
const CLAUDE_FACTORY_GOAL =
  'Work the ready backlog in priority order, highest priority and least blocked first; skip owner-only ' +
  'credential, branch-protection and live-switch steps and surface them instead'

/** drives a run by outcomes (waking it from any timed wait) and returns the stations it visited */
function walk(def: Factory, outcomes: string[], at = 'triage') {
  const actor = createActor(compile(def)).start()
  let now = 0
  if (at !== def.start) actor.send({ type: 'GOTO', node: at, at: now })
  const visited = [where(actor.getSnapshot().value)[0]]
  for (const outcome of outcomes) {
    const { seq } = actor.getSnapshot().context
    actor.send({ type: 'DONE', seq, outcome, summary: outcome, at: ++now })
    if (where(actor.getSnapshot().value)[1] === 'waiting') {
      now = actor.getSnapshot().context.wakeAt
      actor.send({ type: 'TICK', at: now })
    }
    visited.push(where(actor.getSnapshot().value)[0])
  }
  return { visited, snapshot: actor.getSnapshot() }
}

test('every factory in factories/ compiles', async () => {
  const files = readdirSync(import.meta.dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  expect(files).toContain('lifecycle.ts')
  for (const file of files) compile(validate((await import(`./${file}`)).default))
})

test("build: inner loops, a security review, a deploy parked on the person's merge, a soak", () => {
  const { visited, snapshot } = walk(lifecycle, [
    ...['build', 'ready', 'ready', 'red', 'ready', 'green', 'security', 'changes', 'ready', 'green'],
    ...['approve', 'ready', 'blocked', 'deployed', 'healthy'],
  ])
  expect(visited).toEqual([
    ...['triage', 'plan', 'implement', 'verify', 'implement', 'verify', 'review', 'security', 'implement'],
    'verify',
    ...['review', 'release', 'deploy', 'deploy', 'soak', 'done'],
  ])
  expect(snapshot.context.error).toBeNull()
})

test('changes asked on the pull request go back to implement; closing it holds the run', () => {
  const pr = ['build', 'ready', 'ready', 'green', 'approve', 'ready']
  expect(walk(lifecycle, [...pr, 'changes', 'ready']).visited.slice(6)).toEqual([
    'deploy',
    'implement',
    'verify',
  ])
  const { visited, snapshot } = walk(lifecycle, [...pr, 'hold'])
  expect(visited.at(-1)).toBe('done')
  expect(snapshot.context.error).toBeNull()
})

test('a soak that regresses rolls back, fixes forward, and ends in a postmortem', () => {
  const { visited } = walk(lifecycle, [
    ...['build', 'ready', 'ready', 'green', 'approve', 'ready', 'deployed', 'regressed'],
    ...['recovered', 'ready', 'ready', 'green', 'approve', 'ready', 'deployed', 'unsure', 'resolved'],
    'filed',
  ])
  expect(visited.slice(8)).toEqual([
    ...['rollback', 'plan', 'implement', 'verify', 'review', 'release', 'deploy', 'soak', 'soak'],
    ...['postmortem', 'done'],
  ])
})

test('incidents, optimizations and refactors take their own entries', () => {
  expect(walk(lifecycle, ['rollback', 'recovered'], 'incident').visited).toEqual([
    'incident',
    'rollback',
    'plan',
  ])
  expect(walk(lifecycle, ['optimize', 'measured', 'ready', 'ready', 'red', 'abandon']).visited).toEqual([
    ...['triage', 'baseline', 'plan', 'implement', 'verify', 'implement', 'done'],
  ])
  expect(walk(lifecycle, ['refactor', 'pinned', 'ready']).visited).toEqual([
    ...['triage', 'characterize', 'plan', 'implement'],
  ])
  expect(walk(lifecycle, ['optimize', 'nothing-to-gain']).visited.at(-1)).toBe('done')
})

test('lifecycle and release house rules each name every owner-only class, the approval clause and the park text', () => {
  for (const rules of [lifecycle.rules!, release.rules!]) {
    expect(rules).toContain('kubectl apply')
    expect(rules).toContain('production registry')
    expect(rules).toContain('ruleset')
    expect(rules).toContain('organization setting')
    expect(rules).toContain('credential')
    expect(rules).toMatch(/bead's description|factory mail.*manager/)
    expect(rules).toContain("a worker's own comment never counts as approval")
    expect(rules).toContain('parked, waiting on:')
  }
})

test('the lifecycle deploy prompt and the release rollout prompt park on an owner-only step instead of doing it', () => {
  expect(lifecycle.nodes.deploy!.prompt).toContain('parked, waiting on:')
  expect(lifecycle.nodes.deploy!.prompt).toContain('owner-only')
  expect(lifecycle.nodes.deploy!.prompt).toContain('Question:')
  expect(release.nodes.rollout!.prompt).toContain('parked, waiting on:')
  expect(release.nodes.rollout!.prompt).toContain('owner-only')
  expect(release.nodes.rollout!.prompt).toContain('Question:')
})

test('a deploy or rollout brief for a rig whose goal names owner-only steps carries the goal, the rule and the park text', () => {
  const cases: { def: Factory; node: string; goal: string }[] = [
    { def: lifecycle, node: 'deploy', goal: AX_GOAL }, // ax-768: the ko build/push + kubectl apply incident
    { def: lifecycle, node: 'deploy', goal: CLAUDE_FACTORY_GOAL }, // claude-factory-5h9: the ruleset incident
    { def: release, node: 'rollout', goal: AX_GOAL },
  ]
  for (const { def, node, goal } of cases) {
    const brief = [...ruleLines(def, goal), def.nodes[node]!.prompt].join('\n')
    expect(brief).toContain(goal)
    for (const needle of [
      'kubectl apply',
      'production registry',
      'ruleset',
      'organization setting',
      'credential',
    ])
      expect(brief).toContain(needle)
    expect(brief).toMatch(/bead's description|factory mail.*manager/)
    expect(brief).toContain('parked, waiting on:')
  }
})

// claude-factory-960: release always names the pull request, so deploy parks before any worker starts
// (AC1), wakes on a merge/close/activity mail or the 8h backstop (AC3/AC4), and still routes every
// outcome exactly as today once a worker does run (AC4); a release with no link starts deploy at once (AC5).
test('release reporting ready with a pull request link parks deploy with no worker (claude-factory-960 AC1)', () => {
  const actor = createActor(compile(lifecycle)).start()
  actor.send({ type: 'GOTO', node: 'release', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: `shipping ${PR}`, at: 1000 })
  const s = actor.getSnapshot()
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  expect(s.context.seq).toBe(seq) // no worker spawned
  const last = s.context.log.at(-1)!
  expect(isPrWait(last)).toBe(true)
  expect(last.summary).toContain(PR)
  expect(s.context.mail.manager?.at(-1)?.text).toContain('deploy is parked, waiting on:')
  expect(s.context.wakeAt).toBe(1000 + WATCHED_PARK_MIN * 60_000)
})

test('a merge or close mail wakes a parked deploy, which then routes every outcome as today (claude-factory-960 AC4)', () => {
  const cases: { outcome: string; next: [string, string] }[] = [
    { outcome: 'deployed', next: ['soak', 'waiting'] },
    { outcome: 'published', next: ['done', ''] },
    { outcome: 'changes', next: ['implement', 'working'] },
    { outcome: 'hold', next: ['done', ''] },
    { outcome: 'failed', next: ['rollback', 'working'] },
  ]
  for (const { outcome, next } of cases) {
    const actor = createActor(compile(lifecycle)).start()
    actor.send({ type: 'GOTO', node: 'release', at: 0 })
    const released = actor.getSnapshot().context.seq
    actor.send({ type: 'DONE', seq: released, outcome: 'ready', summary: `shipping ${PR}`, at: 1000 })
    expect(where(actor.getSnapshot().value)).toEqual(['deploy', 'waiting'])
    actor.send({ type: 'MAIL', from: 'factory', to: 'deploy', text: `${PR} merged`, at: 2000 })
    expect(where(actor.getSnapshot().value)).toEqual(['deploy', 'working'])
    const deploySeq = actor.getSnapshot().context.seq
    actor.send({ type: 'DONE', seq: deploySeq, outcome, summary: outcome, at: 3000 })
    expect(where(actor.getSnapshot().value)).toEqual(next)
  }
})

test("a worker's own blocked report at deploy still parks as today, after the pre-launch park woke it (claude-factory-960 AC4)", () => {
  const actor = createActor(compile(lifecycle)).start()
  actor.send({ type: 'GOTO', node: 'release', at: 0 })
  const released = actor.getSnapshot().context.seq
  actor.send({ type: 'DONE', seq: released, outcome: 'ready', summary: `shipping ${PR}`, at: 1000 })
  actor.send({ type: 'MAIL', from: 'factory', to: 'deploy', text: `${PR} merged`, at: 2000 })
  const deploySeq = actor.getSnapshot().context.seq
  actor.send({ type: 'BLOCKED', seq: deploySeq, reason: `still waiting on review ${PR}`, at: 3000 })
  const s = actor.getSnapshot()
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  expect(s.context.log.at(-1)).toMatchObject({ node: 'deploy', attempt: 1, outcome: 'blocked' })
  expect(isPrWait(s.context.log.at(-1))).toBe(false) // a real worker report, not the pre-launch park
})

test('release reporting ready with no pull request link starts deploy at once (claude-factory-960 AC5)', () => {
  const actor = createActor(compile(lifecycle)).start()
  actor.send({ type: 'GOTO', node: 'release', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 'shipping, nothing to link', at: 1000 })
  const s = actor.getSnapshot()
  expect(where(s.value)).toEqual(['deploy', 'working'])
  expect(s.context.seq).toBe(seq + 1)
})

// claude-factory-3t2: 5/65 security visits timed out ("no report within 45 min"), all on one large
// rig. A first timeout gets a longer limit (75 min) and a diff summary instead of the whole branch; a
// second timeout in a row mails the manager once and stops, instead of burning more launches.
// claude-factory-wnn: `check` is the small route's combined verify+review. It also routes into
// security on the same outcome. The retry rule must hold for either sender.
for (const from of ['review', 'check']) {
  test(`security retries a timeout at a longer limit, then a 2nd timeout in a row mails the manager once (claude-factory-3t2, from ${from})`, () => {
    const actor = createActor(compile(lifecycle)).start()
    actor.send({ type: 'GOTO', node: from, at: 0 })
    const toSecurity = actor.getSnapshot().context.seq
    actor.send({
      type: 'DONE',
      seq: toSecurity,
      outcome: 'security',
      summary: 'approved, security-sensitive: raises a limit. git diff --stat origin/main...HEAD: 3 files',
      at: 1000,
    })
    expect(where(actor.getSnapshot().value)).toEqual(['security', 'working'])
    const reviewReport = actor.getSnapshot().context.mail.security

    // attempt 1 times out at the plain 45 min limit
    const attempt1 = actor.getSnapshot().context.seq
    actor.send({ type: 'FAIL', seq: attempt1, reason: 'no report within 45 min', at: 2000 })
    expect(where(actor.getSnapshot().value)).toEqual(['security', 'backoff'])
    const retryAt = actor.getSnapshot().context.retryAt
    actor.send({ type: 'TICK', at: retryAt })
    expect(where(actor.getSnapshot().value)).toEqual(['security', 'working'])
    expect(actor.getSnapshot().context.attempt).toBe(2)

    // the retry gets the longer limit and still sees the sender's whole report (the box is not cleared mid-visit)
    expect(timeoutOf(lifecycle.nodes.security!, actor.getSnapshot().context, 'security')).toBe(75)
    expect(actor.getSnapshot().context.mail.security).toEqual(reviewReport)

    // attempt 2 times out too, at the longer limit: a 2nd timeout in a row is stuck, not a 3rd attempt
    const attempt2 = actor.getSnapshot().context.seq
    actor.send({ type: 'FAIL', seq: attempt2, reason: 'no report within 75 min', at: 3000 })
    const stuck = actor.getSnapshot()
    expect(where(stuck.value)).toEqual(['security', 'stuck'])
    expect(stuck.context.error).toBe(repeatQuestion('security', 'no report within 75 min'))
    expect(stuck.context.mail.manager?.filter(m => m.from === 'security')).toHaveLength(1)

    // more ticks while stuck mail the manager no further
    for (const at of [4000, 5000, 6000]) actor.send({ type: 'TICK', at })
    expect(actor.getSnapshot().context.mail.manager?.filter(m => m.from === 'security')).toHaveLength(1)
  })
}

test("security's onTimeout prompt points the retry at review's diff summary, not the whole branch, and review's prompt promises one (claude-factory-3t2 AC5)", () => {
  const onTimeout = lifecycle.nodes.security!.onTimeout!
  expect(onTimeout.timeoutMin).toBe(75)
  expect(onTimeout.prompt).toContain('diff summary')
  expect(onTimeout.prompt).toContain('changed-files')
  expect(onTimeout.prompt).toMatch(/Do not re-read/)

  expect(lifecycle.nodes.review!.prompt).toContain('git diff --stat origin/main...HEAD')
  expect(lifecycle.nodes.review!.prompt).toContain('60 files')
  expect(lifecycle.nodes.review!.prompt).toContain('+N more')
})

// claude-factory-wnn: a small run (docs-only, test-only, a tiny fix) skips plan and security, and
// trades verify+review for one combined `check` station, so it ships without paying the full loop.
test('small AC1: triage -> quick -> check -> release -> deploy -> done, no plan/verify/review/security/soak', () => {
  const { visited } = walk(lifecycle, ['small', 'ready', 'approve', 'ready', 'published'])
  expect(visited).toEqual(['triage', 'quick', 'check', 'release', 'deploy', 'done'])
  for (const skipped of ['plan', 'verify', 'review', 'security', 'soak'])
    expect(visited).not.toContain(skipped)
})

test('small AC2: check flags security, the same node security reviews unchanged, then release ships', () => {
  const { visited } = walk(lifecycle, ['small', 'ready', 'security', 'approve', 'ready'])
  expect(visited).toEqual(['triage', 'quick', 'check', 'security', 'release', 'deploy'])
})

test('small AC3: check changes loops back through quick; quick full joins the full loop at plan; quick abandon ends it', () => {
  expect(walk(lifecycle, ['small', 'ready', 'changes', 'ready']).visited).toEqual([
    'triage',
    'quick',
    'check',
    'quick',
    'check',
  ])
  expect(walk(lifecycle, ['small', 'full']).visited).toEqual(['triage', 'quick', 'plan'])
  expect(walk(lifecycle, ['small', 'abandon']).visited).toEqual(['triage', 'quick', 'done'])
  expect(lifecycle.nodes.check!.rounds).toBe(3)
})

test('small AC4/AC5/AC6: check stays a draft and promises a diff summary for security; quick is Sonnet, check is Opus', () => {
  const check = lifecycle.nodes.check!
  for (const needle of [
    'draft',
    'gh pr review --comment',
    'security-sensitive',
    'git diff --stat origin/main...HEAD',
    '60 files',
    '+N more',
  ])
    expect(check.prompt).toContain(needle)
  expect(check.prompt).not.toContain('mark it ready')
  expect(lifecycle.nodes.release!.prompt).toContain('mark it ready')
  expect(check.agent).toContain('{judge_model}')
  expect((lifecycle as Factory).nodes.quick!.agent).toBeUndefined()
})

test('claude-factory-wnn.4: quick closes each task check filed, with its commit, so release never finds one open', () => {
  const quick = lifecycle.nodes.quick!
  expect(quick.prompt).toContain('closing each task check filed')
  expect(quick.prompt).toContain('its commit')
  expect(quick.prompt).toContain('Tracking')
})

test('small AC7/AC8: triage names the small route and its exclusions; deploy counts docs/test-only as published', () => {
  expect(lifecycle.nodes.triage!.prompt).toContain('small:')
  expect(lifecycle.nodes.triage!.prompt).toContain('security-sensitive')
  expect(lifecycle.nodes.triage!.prompt).toContain('factories/')
  expect(lifecycle.nodes.deploy!.prompt).toContain('docs-only')
})

test('sweeps loop on their timers past any step budget', () => {
  for (const sweep of ['monitor', 'maintain', 'improve']) {
    const again = sweep === 'monitor' ? 'watching' : 'again'
    const { visited, snapshot } = walk(lifecycle, Array(lifecycle.maxSteps + 5).fill(again), sweep)
    expect(new Set(visited)).toEqual(new Set([sweep]))
    expect(where(snapshot.value)).toEqual([sweep, 'working'])
  }
})
