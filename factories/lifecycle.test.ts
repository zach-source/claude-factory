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
import ship from './ship'

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

const SHIP_NODES = ['release', 'deploy', 'soak', 'postmortem']

test('build: inner loops, a security review, then approve ends the run on a ship edge (rtuw AC2)', () => {
  const { visited, snapshot } = walk(lifecycle, [
    ...['build', 'ready', 'ready', 'red', 'ready', 'green', 'security', 'changes', 'ready', 'green'],
    ...['approve'],
  ])
  expect(visited).toEqual([
    ...['triage', 'plan', 'implement', 'verify', 'implement', 'verify', 'review', 'security', 'implement'],
    ...['verify', 'review', 'done'],
  ])
  expect(snapshot.context.error).toBeNull()
  expect(snapshot.context.log.at(-1)).toMatchObject({ node: 'review', outcome: 'approve' })
  for (const n of SHIP_NODES) expect(visited).not.toContain(n)
})

test('lifecycle has no release, deploy, soak or postmortem node; incident and rollback stay (rtuw AC14)', () => {
  for (const n of SHIP_NODES) expect(lifecycle.nodes).not.toHaveProperty(n)
  expect(lifecycle.nodes).toHaveProperty('incident')
  expect(lifecycle.nodes.rollback!.next).toEqual({ recovered: 'plan' })
})

test('review, security and check approve on a ship edge; no other edge ships', () => {
  const ships = Object.entries(lifecycle.nodes).flatMap(([id, n]) =>
    Object.entries(n.next).flatMap(([outcome, e]) =>
      typeof e === 'object' && e.ship ? [`${id}:${outcome}:${e.to}`] : [],
    ),
  )
  expect(ships.sort()).toEqual(['check:approve:done', 'review:approve:done', 'security:approve:done'])
})

test('a ship rework brief tells the worker to push to the ship branch and open no new PR (rtuw AC8)', () => {
  for (const n of ['implement', 'quick'] as const) {
    expect(lifecycle.nodes[n]!.prompt).toContain('ship_branch')
    expect(lifecycle.nodes[n]!.prompt).toContain('git push origin HEAD:<ship_branch>')
    expect(lifecycle.nodes[n]!.prompt).toContain('open no new pull request')
  }
})

test('a run pinned before the ship change still walks release -> deploy -> soak -> done (rtuw AC15)', () => {
  const pinned: Factory = {
    ...lifecycle,
    nodes: {
      ...lifecycle.nodes,
      review: { ...lifecycle.nodes.review!, next: { approve: 'release', changes: 'implement' } },
      release: { prompt: 'release', next: { ready: 'deploy' } },
      deploy: { prompt: 'deploy', awaitsPr: true, next: { deployed: { to: 'soak', delayMin: 15 } } },
      soak: { prompt: 'soak', next: { healthy: 'done' } },
    },
  }
  const { visited, snapshot } = walk(validate(pinned), ['approve', 'ready', 'deployed', 'healthy'], 'review')
  expect(visited).toEqual(['review', 'release', 'deploy', 'soak', 'done'])
  expect(snapshot.context.error).toBeNull()
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
  for (const rules of [lifecycle.rules!, release.rules!, ship.rules!]) {
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

test('the ship deploy prompt and the release rollout prompt park on an owner-only step instead of doing it', () => {
  expect(ship.nodes.deploy!.prompt).toContain('parked, waiting on:')
  expect(ship.nodes.deploy!.prompt).toContain('owner-only')
  expect(ship.nodes.deploy!.prompt).toContain('Question:')
  expect(release.nodes.rollout!.prompt).toContain('parked, waiting on:')
  expect(release.nodes.rollout!.prompt).toContain('owner-only')
  expect(release.nodes.rollout!.prompt).toContain('Question:')
})

test('a deploy or rollout brief for a rig whose goal names owner-only steps carries the goal, the rule and the park text', () => {
  const cases: { def: Factory; node: string; goal: string }[] = [
    { def: ship, node: 'deploy', goal: AX_GOAL }, // ax-768: the ko build/push + kubectl apply incident
    { def: ship, node: 'deploy', goal: CLAUDE_FACTORY_GOAL }, // claude-factory-5h9: the ruleset incident
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
  const actor = createActor(compile(ship)).start()
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
    { outcome: 'published', next: ['queue', 'waiting'] },
    { outcome: 'changes', next: ['queue', 'waiting'] },
    { outcome: 'hold', next: ['queue', 'waiting'] },
    { outcome: 'failed', next: ['rollback', 'working'] },
  ]
  for (const { outcome, next } of cases) {
    const actor = createActor(compile(ship)).start()
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
  const actor = createActor(compile(ship)).start()
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
  const actor = createActor(compile(ship)).start()
  actor.send({ type: 'GOTO', node: 'release', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 'shipping, nothing to link', at: 1000 })
  const s = actor.getSnapshot()
  expect(where(s.value)).toEqual(['deploy', 'working'])
  expect(s.context.seq).toBe(seq + 1)
})

// claude-factory-8pc.7: lifecycle no longer holds the sweep nodes (they moved to factories/sweeps.ts,
// one pass each, started by `factory sweep` on its own cadence, not a self-loop). A run that started
// before this move still carries the old shape in its own pinned factory.json (createRun snapshots
// the factory it started from): it must still load, validate, compile and tick, unaffected by this
// repo's current lifecycle.ts.
test("a run pinned to lifecycle's old shape, with the sweep nodes, still loads and ticks (AC7)", () => {
  const pinned: Factory = {
    ...lifecycle,
    nodes: {
      ...lifecycle.nodes,
      monitor: {
        runner: 'herdr',
        timeoutMin: 20,
        prompt: 'watch',
        next: { watching: { to: 'monitor', delayMin: 30 }, stop: 'done' },
      },
    },
  }
  const def = validate(pinned)
  expect(() => compile(def)).not.toThrow()
  const { visited, snapshot } = walk(def, Array(def.maxSteps! + 5).fill('watching'), 'monitor')
  expect(new Set(visited)).toEqual(new Set(['monitor']))
  expect(where(snapshot.value)).toEqual(['monitor', 'working'])
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

test("security's onTimeout prompt points the retry at review's or check's diff summary, not the whole branch, and both prompts promise one (claude-factory-3t2 AC5, extended by claude-factory-wnn.6 for check)", () => {
  const onTimeout = lifecycle.nodes.security!.onTimeout!
  expect(onTimeout.timeoutMin).toBe(75)
  expect(onTimeout.prompt).toContain('diff summary')
  expect(onTimeout.prompt).toContain('changed-files')
  expect(onTimeout.prompt).toContain("review's or check's report")
  expect(onTimeout.prompt).toMatch(/Do not re-read/)

  expect(lifecycle.nodes.review!.prompt).toContain('git diff --stat origin/main...HEAD')
  expect(lifecycle.nodes.review!.prompt).toContain('60 files')
  expect(lifecycle.nodes.review!.prompt).toContain('+N more')

  // claude-factory-wnn.6: security's main prompt checks the diff against the plan's risk section,
  // but a small run has no plan; it must also name triage's summary.
  expect(lifecycle.nodes.security!.prompt).toContain(
    "plan's risk section, or triage's summary on a small run",
  )
})

// claude-factory-wnn: a small run (docs-only, test-only, a tiny fix) skips plan and security, and
// trades verify+review for one combined `check` station, so it ships without paying the full loop.
test('small AC1: triage -> quick -> check -> done on a ship edge, no plan/verify/review/security/soak', () => {
  const { visited } = walk(lifecycle, ['small', 'ready', 'approve'])
  expect(visited).toEqual(['triage', 'quick', 'check', 'done'])
  for (const skipped of ['plan', 'verify', 'review', 'security', 'soak', 'release', 'deploy'])
    expect(visited).not.toContain(skipped)
})

test('small AC2: check flags security, the same node security reviews unchanged, then approve hands off to ship', () => {
  const { visited } = walk(lifecycle, ['small', 'ready', 'security', 'approve'])
  expect(visited).toEqual(['triage', 'quick', 'check', 'security', 'done'])
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
  expect(check.prompt).toContain('ship marks it ready')
  expect(ship.nodes.release.prompt).toContain('mark it ready')
  expect(check.agent).toContain('{judge_model}')
  expect((lifecycle as Factory).nodes.quick!.agent).toBeUndefined()
})

test('claude-factory-wnn.4: quick closes each task check filed, with its commit, so the handoff never finds one open', () => {
  const quick = lifecycle.nodes.quick!
  expect(quick.prompt).toContain('closing each task check filed')
  expect(quick.prompt).toContain('its commit')
  expect(quick.prompt).toContain('Tracking')
})

test('small AC7/AC8: triage names the small route and its exclusions; the ship deploy counts docs/test-only as published', () => {
  expect(lifecycle.nodes.triage!.prompt).toContain('small:')
  expect(lifecycle.nodes.triage!.prompt).toContain('security-sensitive')
  expect(lifecycle.nodes.triage!.prompt).toContain('factories/')
  expect(ship.nodes.deploy!.prompt).toContain('docs-only')
})

// claude-factory-qgz: review hits its round cap (3) and re-plans once with the round's findings,
// instead of holding for a hand goto; a second cap in the same run still holds for the manager.
test("review's round cap re-plans to plan with the findings, then holds on a second cap (claude-factory-qgz AC1-AC3, AC7)", () => {
  expect(lifecycle.nodes.review!.onRounds).toBe('plan')
  expect(lifecycle.nodes.review!.rounds).toBe(3)

  const actor = createActor(compile(lifecycle)).start()
  let now = 0
  const sendChanges = (i: number) => {
    actor.send({ type: 'GOTO', node: 'review', at: now })
    const { seq } = actor.getSnapshot().context
    actor.send({ type: 'DONE', seq, outcome: 'changes', summary: `round ${i} findings AC${i}`, at: ++now })
  }

  for (let i = 1; i <= 3; i++) {
    sendChanges(i)
    expect(where(actor.getSnapshot().value)[0]).toBe('implement') // changes 1-3: the normal edge
  }

  sendChanges(4) // changes 4 == rounds + 1: re-plan instead of holding
  expect(where(actor.getSnapshot().value)[0]).toBe('plan')
  const plan = actor.getSnapshot().context.mail.plan?.at(-1)
  expect(plan?.from).toBe('review')
  for (let i = 1; i <= 4; i++) {
    expect(plan?.text).toContain(`### review round ${i}`)
    expect(plan?.text).toContain(`round ${i} findings AC${i}`)
  }
  expect(actor.getSnapshot().context.mail.manager).toBeUndefined() // AC2: re-plan mails no manager

  for (let i = 5; i <= 7; i++) {
    sendChanges(i)
    expect(where(actor.getSnapshot().value)[0]).toBe('implement') // changes 5-7: the normal edge again
  }

  sendChanges(8) // changes 8 == 2*rounds + 2: held for the manager, re-plan already spent
  const s = actor.getSnapshot()
  expect(where(s.value)).toEqual(['review', 'stuck'])
  expect(s.context.error).toBe('review reported changes more than 3 times')
  const managerMail = s.context.mail.manager?.find(m => m.from === 'review')
  expect(managerMail?.text).toContain('already re-planned once, to plan')
})

// claude-factory-qgz: verify reporting red twice in a row on the same acceptance-criterion id mails
// the manager (from 'factory', not from verify), while the run still goes on to implement as today.
test("verify's repeated red on the same AC id mails the manager; a different AC id does not (claude-factory-qgz AC6, AC7)", () => {
  expect(lifecycle.nodes.verify!.repeatMail).toBe('red')

  const red = createActor(compile(lifecycle)).start()
  red.send({ type: 'GOTO', node: 'verify', at: 0 })
  let seq = red.getSnapshot().context.seq
  red.send({
    type: 'DONE',
    seq,
    outcome: 'red',
    summary: '1. fails AC2 2. fails AC3\nFailing: AC2, AC3',
    at: 1000,
  })
  expect(where(red.getSnapshot().value)[0]).toBe('implement')

  red.send({ type: 'GOTO', node: 'verify', at: 1000 })
  seq = red.getSnapshot().context.seq
  red.send({ type: 'DONE', seq, outcome: 'red', summary: 'still fails AC2\nFailing: AC2', at: 2000 })
  const s = red.getSnapshot()
  expect(where(s.value)[0]).toBe('implement') // the normal edge still runs
  const mail = s.context.mail.manager?.at(-1)
  expect(mail?.from).toBe('factory') // never from 'verify': cli.ts's isAsking keys on from === node
  expect(mail?.text).toContain('verify reported red again on AC2')

  const noShare = createActor(compile(lifecycle)).start()
  noShare.send({ type: 'GOTO', node: 'verify', at: 0 })
  seq = noShare.getSnapshot().context.seq
  noShare.send({ type: 'DONE', seq, outcome: 'red', summary: 'fails AC1\nFailing: AC1', at: 1000 })
  noShare.send({ type: 'GOTO', node: 'verify', at: 1000 })
  seq = noShare.getSnapshot().context.seq
  noShare.send({ type: 'DONE', seq, outcome: 'red', summary: 'fails AC2\nFailing: AC2', at: 2000 })
  expect(noShare.getSnapshot().context.mail.manager).toBeUndefined()
})

// claude-factory-qgz, review round 2 finding .11.
// Review runs only after verify's green outcome. A review re-plan, with its `replan: true` log entry,
// cannot sit between two verify reds.
//
// A manager `goto plan` after the first repeat mail writes no log entry.
// Only the later report from `plan` writes one.
// `plan` is review's `onRounds` target. The streak must break there too.
//
// A re-plan renumbers the acceptance criteria.
// A shared id after a re-plan is a false repeat.
// With no fix, the renumbered AC2 in the post-replan red looks like the same repeat again.
test('a manager goto plan between two verify reds breaks the repeat streak (claude-factory-qgz finding .11)', () => {
  const actor = createActor(compile(lifecycle)).start()
  actor.send({ type: 'GOTO', node: 'verify', at: 0 })
  let seq = actor.getSnapshot().context.seq
  actor.send({ type: 'DONE', seq, outcome: 'red', summary: 'fails AC2\nFailing: AC2', at: 1000 })
  expect(where(actor.getSnapshot().value)[0]).toBe('implement')

  actor.send({ type: 'GOTO', node: 'verify', at: 1000 })
  seq = actor.getSnapshot().context.seq
  actor.send({ type: 'DONE', seq, outcome: 'red', summary: 'still fails AC2\nFailing: AC2', at: 2000 })
  expect(actor.getSnapshot().context.mail.manager?.filter(m => m.from === 'factory')).toHaveLength(1) // the 1st repeat mail

  // the manager's hand goto plan, with the findings; the run re-plans and goes on as usual
  actor.send({ type: 'GOTO', node: 'plan', at: 2000 })
  seq = actor.getSnapshot().context.seq
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 're-planned', at: 3000 })
  expect(where(actor.getSnapshot().value)[0]).toBe('implement')
  seq = actor.getSnapshot().context.seq
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 'fixed', at: 4000 })
  expect(where(actor.getSnapshot().value)[0]).toBe('verify')

  seq = actor.getSnapshot().context.seq
  actor.send({ type: 'DONE', seq, outcome: 'red', summary: 'fails AC2 again\nFailing: AC2', at: 5000 })
  // the re-plan renumbered AC2, so this is not a real repeat: still only the 1st mail
  expect(actor.getSnapshot().context.mail.manager?.filter(m => m.from === 'factory')).toHaveLength(1)
})

test('implement runs a numbered self-check and reports a Self-check block (2ida AC1, AC2)', () => {
  const p = lifecycle.nodes.implement!.prompt
  for (const n of ['1.', '2.', '3.', '4.', '5.', '6.']) expect(p).toContain(`\n${n} `)
  expect(p).toContain('the whole test suite')
  expect(p).toContain('AC table')
  expect(p).toContain('git diff <reviewed sha>..HEAD')
  expect(p).toContain('Add no changelog entry')
  expect(p).toContain("'Self-check:'")
  expect(p).toContain('Close every task of this run')
})

test('review, security and check share one blocking-scope rule (2ida AC3, AC4)', () => {
  for (const n of ['review', 'security', 'check'] as const) {
    const p = lifecycle.nodes[n]!.prompt
    expect(p).toContain('A finding blocks only when it is one of these')
    expect(p).toContain('Not blocking')
    expect(p).toContain('discovered-from:')
  }
  expect(lifecycle.nodes.security!.prompt).toContain('P1 or higher')
})

test('plan names the proof for each AC, negative rows and a fail-closed class rule (2ida AC5)', () => {
  const p = lifecycle.nodes.plan!.prompt
  expect(p).toContain('the test or command that proves it')
  expect(p).toContain('negative rows')
  expect(p).toContain('one fail-closed rule')
  expect(p).toContain('out of scope')
})
