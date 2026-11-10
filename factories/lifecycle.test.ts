import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createActor } from 'xstate'
import { join } from 'node:path'
import { modelOf } from '../src/ax'
import { loadFactory, ruleLines, workerSkills } from '../src/cli'
import {
  compile,
  fill,
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
import sweeps from './sweeps'

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

test('implement reports partial to go on with the open tasks; a fourth partial re-plans (6j5k)', () => {
  const partials = walk(lifecycle, ['build', 'ready', 'partial', 'partial', 'partial', 'ready'])
  expect(partials.visited).toEqual([
    'triage',
    'plan',
    'implement',
    'implement',
    'implement',
    'implement',
    'verify',
  ])
  expect(partials.snapshot.context.log.filter(e => e.outcome === 'fail')).toEqual([])
  expect(
    partials.snapshot.context.log.filter(e => e.node === 'implement' && e.outcome === 'partial'),
  ).toHaveLength(3)
  const capped = walk(lifecycle, ['build', 'ready', 'partial', 'partial', 'partial', 'partial'])
  expect(capped.visited.at(-1)).toBe('plan')
  expect(lifecycle.nodes.implement!.prompt).toContain('report partial, not fail')
  expect(lifecycle.nodes.plan!.prompt).toContain('one implement pass')
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
      review: {
        ...lifecycle.nodes.review!,
        securityRoute: undefined,
        next: { approve: 'release', changes: 'implement' },
      },
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
  for (const rules of [lifecycle.rules!, release.rules!, ship.rules!, sweeps.rules!]) {
    expect(rules).toContain('kubectl apply')
    expect(rules).toContain('production registry')
    expect(rules).toContain('ruleset')
    expect(rules).toContain('organization setting')
    expect(rules).toContain('credential')
    expect(rules).toContain(
      "a person's own comment on the bead or a [factory mail] from the manager says the person approved that exact step",
    )
    expect(rules).toContain("The bead's description records no author, so it never counts as approval")
    expect(rules).not.toMatch(/only when the bead's description|bead's description, a person's own comment/)
    expect(rules).toContain("a worker's own comment never counts as approval")
    expect(rules).toContain('parked, waiting on:')
  }
})

test('the ship soak prompt counts only a person comment or manager mail as Mimir approval', () => {
  const p = ship.nodes.soak!.prompt as string
  expect(p).toContain("a person's own comment on the bead or a [factory mail] from the manager")
  expect(p).not.toMatch(/\(the bead's description,/)
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
    expect(brief).toContain(
      "a person's own comment on the bead or a [factory mail] from the manager says the person approved that exact step",
    )
    expect(brief).toContain("The bead's description records no author, so it never counts as approval")
    expect(brief).not.toMatch(/only when the bead's description|bead's description, a person's own comment/)
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
    { outcome: 'unsure', next: ['soak', 'waiting'] },
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
    actor.send({ type: 'MAIL', from: 'factory', to: 'deploy', text: `${PR} merged`, wake: true, at: 2000 })
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
  actor.send({ type: 'MAIL', from: 'factory', to: 'deploy', text: `${PR} merged`, wake: true, at: 2000 })
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

test('the plan prompt tells plan to start its own scratch Postgres and never forbids initdb (g2mk)', () => {
  const p = lifecycle.nodes.plan!.prompt as string
  expect(p).toContain('factory pg-scratch start')
  expect(p).toContain('factory pg-scratch stop')
  expect(p).toContain('Never report blocked on a missing Postgres service')
  expect(p).not.toMatch(/(do not|never|forbid)[^.\n]*(initdb|pg_ctl)/i)
})

test("security's onTimeout prompt points the retry at review's or check's diff summary, not the whole branch, and both prompts promise one (claude-factory-3t2 AC5, extended by claude-factory-wnn.6 for check)", () => {
  const onTimeout = lifecycle.nodes.security!.onTimeout!
  expect(onTimeout.timeoutMin).toBe(75)
  expect(onTimeout.prompt).toContain('diff summary')
  expect(onTimeout.prompt).toContain('changed-files')
  expect(onTimeout.prompt).toContain("review's or check's report")
  expect(onTimeout.prompt).toMatch(/Do not re-read/)

  expect(lifecycle.nodes.review!.prompt).toContain('git diff --stat origin/{base_branch}...HEAD')
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

test('AC8: review and check take their security route from the runner, not from their own judgment', () => {
  const nodes = lifecycle.nodes as unknown as Factory['nodes']
  const { review, check, plan } = nodes
  for (const n of [review!, check!]) {
    expect(n.prompt).toContain('## Security route')
    expect(n.prompt).toContain('Security-reason: <path>:<line>')
    expect(n.prompt).not.toContain('never report security')
    expect(n.prompt).not.toContain('removes a gate, lets more run unattended')
    expect(n.securityRoute).toBe(true)
  }
  expect(review!.prompt).not.toContain('the plan or the diff is security-sensitive')
  expect(check!.prompt).not.toContain('the diff or the bead is security-sensitive')
  expect(plan!.prompt).toContain('Security-sensitive: yes (<area>)')
  expect(
    Object.entries(nodes)
      .filter(([, n]) => n.securityRoute)
      .map(([id]) => id),
  ).toEqual(['review', 'check'])
})

test('small AC4/AC5/AC6: check marks an approved PR ready and promises a diff summary for security; quick is Sonnet, check is Opus', () => {
  const check = lifecycle.nodes.check!
  for (const needle of [
    'draft',
    'gh pr review <n> --comment --body-file <path>',
    '## Security route',
    'git diff --stat origin/{base_branch}...HEAD',
    '60 files',
    '+N more',
  ])
    expect(check.prompt).toContain(needle)
  // claude-factory-usp5: the approving station marks the pull request ready, not only ship
  expect(check.prompt).toContain('mark the pull request ready: \`gh pr ready <n> -R <owner>/<repo>\`')
  expect(check.prompt).toContain('Do not mark it ready when you report changes or security')
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

// claude-factory-53tf: review's security outcome leaves the loop, so it never counts toward review's cap.
test('review security reports (4-7) with security changes between go to security, never re-plan (53tf)', () => {
  // a long maxSteps: seven loops would use up the default launch budget of 20
  const actor = createActor(compile({ ...lifecycle, maxSteps: 200 })).start()
  let now = 0
  const report = (outcome: string) => {
    const { seq } = actor.getSnapshot().context
    actor.send({ type: 'DONE', seq, outcome, summary: `${outcome} ${now}`, at: ++now })
  }
  for (let i = 1; i <= 7; i++) {
    actor.send({ type: 'GOTO', node: 'review', at: now })
    report('security')
    expect(where(actor.getSnapshot().value)[0]).toBe('security')
    actor.send({ type: 'GOTO', node: 'security', at: now })
    report('changes')
    // security's own cap (x2en): its 4th changes re-plans
    expect(where(actor.getSnapshot().value)[0]).toBe(i === 4 ? 'plan' : 'implement')
  }
  const ctx = actor.getSnapshot().context
  // review never re-plans on its security outcome; only security's own cap (x2en) re-plans, once
  expect(ctx.log.some(e => e.replan && e.node === 'review')).toBe(false)
  expect(ctx.log.filter(e => e.replan).map(e => e.node)).toEqual(['security'])
})

// claude-factory-x2en: security has its own round cap (3), separate from review's.
test("security's round cap re-plans to plan, then holds on a second cap (x2en AC1-AC3, AC5)", () => {
  expect(lifecycle.nodes.security!.rounds).toBe(3)
  expect(lifecycle.nodes.security!.onRounds).toBe('plan')

  const start = () => {
    const actor = createActor(compile({ ...lifecycle, maxSteps: 200 })).start()
    let now = 0
    const send = (node: string, outcome: string, i = now) => {
      actor.send({ type: 'GOTO', node, at: now })
      const { seq } = actor.getSnapshot().context
      actor.send({
        type: 'DONE',
        seq,
        outcome,
        summary: `${node} ${outcome} round ${i} finding AC${i}`,
        at: ++now,
      })
    }
    return { actor, send }
  }
  const top = (a: ReturnType<typeof start>['actor']) => where(a.getSnapshot().value)[0]

  const { actor, send } = start()
  for (let i = 1; i <= 3; i++) {
    send('security', 'changes', i)
    expect(top(actor)).toBe('implement')
  }
  send('security', 'changes', 4)
  expect(top(actor)).toBe('plan')
  const last = actor.getSnapshot().context.log.at(-1)
  expect(last?.node).toBe('security')
  expect(last?.replan).toBe(true)
  const plan = actor.getSnapshot().context.mail.plan?.at(-1)
  expect(plan?.from).toBe('security')
  for (let i = 1; i <= 4; i++) {
    expect(plan?.text).toContain(`### security round ${i}`)
    expect(plan?.text).toContain(`finding AC${i}`)
  }
  expect(actor.getSnapshot().context.mail.manager).toBeUndefined()
  for (let i = 5; i <= 7; i++) {
    send('security', 'changes', i)
    expect(top(actor)).toBe('implement')
  }
  send('security', 'changes', 8)
  const s = actor.getSnapshot()
  expect(where(s.value)).toEqual(['security', 'stuck'])
  expect(s.context.error).toBe('security reported changes more than 3 times')
  expect(s.context.mail.manager?.find(m => m.from === 'security')?.text).toContain(
    'already re-planned once, to plan',
  )

  // AC5 (a, b): approve never counts; three changes then approve ships
  const b = start()
  for (let i = 1; i <= 3; i++) b.send('security', 'changes', i)
  b.send('security', 'approve')
  expect(top(b.actor)).toBe('done')

  // AC5 (c): review's own cap does not count security's changes
  const c = start()
  for (let i = 1; i <= 3; i++) c.send('security', 'changes', i)
  c.send('review', 'changes')
  expect(top(c.actor)).toBe('implement')
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
  expect(lifecycle.nodes.verify!.mergeCheck).toBe('red')

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
  expect(p).not.toContain('the ship release adds them')
  expect(p).toContain('writes the changelog at release time')
  expect(p).toContain("'Self-check:'")
  expect(p).toContain('Close every task of this run')
  expect(p).toContain('factory mutate <file:line> <old> <new> -- <test cmd>')
  expect(p).toContain('Exit 0 means killed')
})

test('implement pushes each finished task and keeps its tests (swrm AC1, AC2)', () => {
  const p = lifecycle.nodes.implement!.prompt
  const first = 'Each attempt must end with a pushed commit'
  expect(p).toContain(first)
  expect(p).toContain('Commit and push each finished task (its test and its fix) before you start the next')
  expect(p).toContain("Never delete a test you wrote to fit a plan's 'one commit' rule")
  expect(p).toContain('commit it as WIP and say so')
  expect(p.indexOf(first)).toBeLessThan(p.indexOf('Before you report ready'))
  expect(lifecycle.nodes.quick!.prompt).not.toContain(first)
})

test('review, security and check share one blocking-scope rule (2ida AC3, AC4)', () => {
  for (const n of ['review', 'security', 'check'] as const) {
    const p = lifecycle.nodes[n]!.prompt
    expect(p).toContain('A finding blocks only when it is one of these')
    expect(p).toContain('makes an existing defect reachable or enabled')
    expect(p).toContain('Not blocking')
    expect(p).toContain('discovered-from:')
    expect(p).toContain("outside this branch's diff never makes the verdict changes")
    expect(p).toContain('bd search')
    expect(p).toContain('P2 or lower')
    expect(p).toContain('sets P0 or P1')
    expect(p).toContain('and that is not kind 2 or 3 does not block')
    expect(p).toContain('give the origin/{base_branch} file and line that holds the same gap')
    expect(p).toContain('git show origin/{base_branch}:<path> | grep -n <symbol>')
    expect(p).toContain('A finding without that line is not a main gap')
  }
  expect(lifecycle.nodes.security!.prompt).not.toContain('P1 or higher')
  expect(lifecycle.nodes.security!.prompt).toContain('for a person to prioritize')
  expect(lifecycle.nodes.security!.prompt).toContain('that is not kind 1, 2 or 3 does not block')
})

test('plan names the proof for each AC, negative rows and a fail-closed class rule (2ida AC5)', () => {
  const p = lifecycle.nodes.plan!.prompt
  expect(p).toContain('the test or command that proves it')
  expect(p).toContain('negative rows')
  expect(p).toContain('one fail-closed rule')
  expect(p).toContain('out of scope')
})

test('triage rejects a second fix for a red main (claude-factory-yhf5)', () => {
  const p = lifecycle.nodes.triage!.prompt
  for (const s of [
    'gh pr list --state open --search',
    'in:title,body',
    'factory status',
    'reject as already tracked and name that PR',
  ])
    expect(p).toContain(s)
})

test('triage bd-searches open beads before it routes (claude-factory-tfdk)', () => {
  const p = lifecycle.nodes.triage!.prompt
  const sentence =
    'bd search the error string, route, service and symptom; link matching open beads (or reject as a duplicate) and name them in the summary.'
  expect(p).toContain(sentence)
  expect(p.split(sentence).length - 1).toBe(1)
  expect(p).toContain("bd search '<words>' --status open")
  expect(p).toContain('bd dep add <this bead> <id> -t related')
  const at = p.indexOf(sentence)
  expect(at).toBeGreaterThan(p.indexOf('- reject: unclear, already tracked'))
  expect(at).toBeLessThan(p.indexOf('Summary:'))
})

test('triage rollout requeues into the release factory; decision defers at plan; elsewhere defers (502 AC4-AC7)', () => {
  const decision = { to: 'done', defer: { station: 'plan' } }
  expect(lifecycle.nodes.triage!.next.rollout).toEqual({ to: 'done', requeue: { factory: 'release' } })
  expect(lifecycle.nodes.triage!.next.elsewhere).toEqual({ to: 'done', defer: true })
  const t = lifecycle.nodes.triage!.prompt
  for (const s of [
    'factory file-elsewhere <rig> --from <this rig>:<this bead',
    'Never run bd create in another rig',
    'discovered_from',
    'File in: <rig>: <title> | <description>',
  ])
    expect(t).toContain(s)
  expect(t).not.toContain('the label `factory`, and this bead')
  for (const n of ['triage', 'plan', 'implement'] as const)
    expect(lifecycle.nodes[n].next.decision).toEqual(decision)
  expect(lifecycle.nodes.implement!.prompt).toContain('open no new pull request')
  expect(lifecycle.nodes.implement!.prompt).toContain('earlier run opened')
  expect(release.start).toBe('recipe')
  expect(walk(lifecycle, ['rollout']).visited).toEqual(['triage', 'done'])
  expect(walk(lifecycle, ['elsewhere']).visited).toEqual(['triage', 'done'])
  expect(walk(lifecycle, ['decision']).visited).toEqual(['triage', 'done'])
  expect(walk(lifecycle, ['decision'], 'plan').visited).toEqual(['plan', 'done'])
  expect(walk(lifecycle, ['decision'], 'implement').visited).toEqual(['implement', 'done'])
  expect(walk(lifecycle, ['build']).visited).toEqual(['triage', 'plan'])
  expect(walk(lifecycle, ['reject']).snapshot.context.log.at(-1)).toMatchObject({ outcome: 'reject' })
})

test('implement, verify, security, plan and review split to codex, and the exec tier never gets the security model', () => {
  const lc = lifecycle as Factory
  const split = Object.entries(lc.nodes)
    .filter(([, n]) => n.split)
    .map(([id, n]) => [id, n.split!.share, n.split!.agent])
  expect(split).toEqual([
    ['plan', 'codex_judge_share', "{codex} -m '{codex_judge_model}'"],
    ['implement', 'codex_share', "{codex} -m '{codex_exec_model}'"],
    ['verify', 'codex_share', "{codex} -m '{codex_exec_model}'"],
    ['review', 'codex_judge_share', "{codex} -m '{codex_judge_model}'"],
    ['security', 'codex_security_share', "{codex} -m '{codex_security_model}'"],
  ])
  for (const id of ['check', 'incident']) expect(lc.nodes[id]!.split).toBeUndefined()
  expect(lc.params!.codex_share).toBe('0.3')
  expect(lc.params!.codex_judge_share).toBe('0') // a rig turns the codex judge tier on itself
  expect(lc.params!.fast_check).toBe('') // a rig sets its own fast check; empty is off
  expect(lc.params!.codex).toContain('codex --dangerously-bypass-approvals-and-sandbox')
  // cursor is off for every station until a rig sets its share
  for (const st of ['plan', 'implement', 'verify', 'review', 'security']) {
    expect(lc.params![`cursor_${st}_share`]).toBe('0')
    expect(lc.params![`cursor_${st}_model`]).toBeTruthy()
  }
  expect(lc.params!.cursor).toContain('cursor-agent')
  // grok is off for every station until a rig sets its share
  for (const st of ['plan', 'implement', 'verify', 'review', 'security']) {
    expect(lc.params![`grok_${st}_share`]).toBe('0')
    expect(lc.params![`grok_${st}_model`]).toBeTruthy()
  }
  expect(lc.params!.grok).toContain('grok --permission-mode')
  validate(lifecycle as Factory)
})

test('every station model id of every factory resolves to a known id', async () => {
  const lc = lifecycle as Factory
  const known = [
    'claude-sonnet-5-5[1m]',
    'claude-opus-5-5[1m]',
    'claude-fable-5-2',
    'gpt-6.1-sol',
    'gpt-6-astra',
  ]
  const rework = await loadFactory(join(import.meta.dir, 'rework.yaml'))
  for (const def of [lifecycle, ship, release, sweeps, rework] as Factory[]) {
    for (const node of Object.values(def.nodes)) {
      for (const cmd of [node.agent ?? def.agent, node.split?.agent]) {
        if (!cmd) continue
        expect(known).toContain(modelOf(fill(cmd, def.params ?? {}))!)
      }
    }
  }
  expect(modelOf(fill(lc.nodes.implement!.split!.agent, lc.params!))).toBe('gpt-6.1-sol')
  expect(modelOf(fill(lc.nodes.security!.split!.agent, lc.params!))).toBe('gpt-6-astra')
  expect(modelOf(fill(lc.nodes.review!.split!.agent, lc.params!))).toBe('gpt-6-astra')
})

test('claude-factory-0gww.4: review, security and check approve or request changes as the reviewer identity on the exact head, with a comment fallback', () => {
  for (const node of ['review', 'security', 'check']) {
    const prompt = (lifecycle as Factory).nodes[node]!.prompt
    for (const needle of [
      'FACTORY_GH_REVIEWER',
      'commit_id',
      'event=APPROVE',
      'event=REQUEST_CHANGES',
      'gh pr view <n> --json author,headRefOid',
      'the author is the reviewer identity',
      'headRefOid is not the commit you reviewed',
      'gh pr review <n> --comment --body-file <path>',
    ])
      expect(prompt).toContain(needle)
  }
  for (const node of ['plan', 'implement', 'quick', 'verify'])
    expect((lifecycle as Factory).nodes[node]!.prompt).not.toContain('event=APPROVE')
})

test('qoub.3: review and check never push; with no pull request they report changes', () => {
  for (const node of ['review', 'check']) {
    const prompt = (lifecycle as Factory).nodes[node]!.prompt
    expect(prompt.replace('"push the branch and open the draft pull request"', '')).not.toMatch(
      /push the branch/i,
    )
    expect(prompt).toContain('do not push')
    expect(prompt).toContain('"push the branch and open the draft pull request"')
  }
  expect((lifecycle as Factory).nodes.quick!.prompt).toContain('gh pr create --draft')
})

test('claude-factory-wbac: a security report posts a COMMENT review, only security approves', () => {
  const lc = lifecycle as Factory
  for (const node of ['review', 'security', 'check']) {
    const prompt = lc.nodes[node]!.prompt
    expect(prompt).toContain('event=COMMENT when you report security')
    expect(prompt).toContain('event=APPROVE only when you report approve')
    expect(prompt).not.toContain('also when you report security')
    expect(prompt).toContain('-f event=<event>')
    expect(prompt).not.toContain('-f event=APPROVE -F body')
    expect(prompt).toContain('Do not mark it ready when you report changes or security')
    expect(prompt).toContain('Reviewed head: <full SHA>')
  }
  expect(Object.keys(lc.nodes.security!.next!).sort()).toEqual(['approve', 'changes'])
  expect(lc.nodes.review!.next!.security).toBe('security')
  expect(lc.nodes.check!.next!.security).toBe('security')
})

test('plan keeps tests and the change they wait on in one PR, or orders the beads (claude-factory-9hzj AC1)', () => {
  const prompt = (lifecycle as Factory).nodes.plan!.prompt ?? ''
  for (const t of [
    'plan both in one pull request',
    'the tests commit first, then the change',
    'make this bead depend on the other bead',
    'red required checks by design',
  ])
    expect(prompt).toContain(t)
})

// claude-factory-pt4r: a bead whose ACs are all live reads goes to decision on a VM, not to plan.
test('triage sends live-read-only beads on a VM to decision (pt4r AC1/AC2)', () => {
  const p = lifecycle.nodes.triage!.prompt
  for (const s of [
    'live read',
    'kubectl get',
    'Mimir query',
    'needs no code',
    'Classify it decision',
    'name the exact reads',
    'laptop runner',
  ])
    expect(p).toContain(s)
  expect(lifecycle.nodes.triage!.next.decision).toEqual({ to: 'done', defer: { station: 'plan' } })
  expect(lifecycle.nodes.triage!.next.build).toBe('plan')
})

test('claude-factory-ocox AC1: a house rule says implement and quick open drafts only and names who marks ready', () => {
  const line = lifecycle.rules!.split('\n').find(l => l.includes('gh pr create --draft'))
  expect(line).toBeDefined()
  for (const needle of [
    'implement and quick',
    'never run `gh pr ready`',
    'review, security and check',
    'ship release',
    'merges a ready',
  ])
    expect(line).toContain(needle)
})

test('claude-factory-ocox AC2/AC3 + ye1v AC5: plain gh pr ready only in review, security and check; the --undo form only in implement and quick', () => {
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const p = node.prompt
    expect(p.replaceAll(/gh pr ready <n> --undo/g, '').includes('gh pr ready'), id).toBe(
      ['review', 'security', 'check'].includes(id),
    )
    expect(p.includes('gh pr ready <n> --undo'), id).toBe(
      // implement and quick undo before a push; review, security and check carry the Made-worse gate
      ['implement', 'quick', 'review', 'security', 'check'].includes(id),
    )
  }
  expect(lifecycle.nodes.implement!.prompt).toContain('gh pr create --draft')
})

test('claude-factory-ye1v AC1/AC2: implement and quick go back to draft before a push and list unreviewed SHAs', () => {
  for (const id of ['implement', 'quick']) {
    const p = (lifecycle.nodes as Record<string, { prompt: string }>)[id]!.prompt
    for (const s of [
      'gh pr view <n> --json isDraft',
      'gh pr ready <n> --undo',
      'before you push',
      'do not push',
      'Unreviewed:',
      'git log --format=%h <reviewed head>..HEAD',
      'Reviewed head:',
      'every report',
      '+N more',
    ])
      expect(p, `${id}: ${s}`).toContain(s)
  }
})

test('claude-factory-ye1v AC3: approvers name the reviewed head and mark ready only at that head', () => {
  for (const id of ['review', 'security', 'check']) {
    const p = (lifecycle.nodes as Record<string, { prompt: string }>)[id]!.prompt
    expect(p, id).toContain('Reviewed head: <full SHA>')
    expect(p, id).toContain('headRefOid equals the SHA you reviewed')
  }
})

test('claude-factory-97yj: approvers re-read headRefOid after gh pr ready and undo on a moved head', () => {
  const nodes = lifecycle.nodes as Record<string, { prompt: string }>
  const reread = 'Right after you mark it, read `gh pr view <n> --json headRefOid` again.'
  for (const id of Object.keys(nodes)) {
    const p = nodes[id]!.prompt
    if (!['review', 'security', 'check'].includes(id)) {
      expect(p, id).not.toContain(reread)
      continue
    }
    const at = p.indexOf(reread)
    expect(at, id).toBeGreaterThan(p.indexOf('gh pr ready <n> -R'))
    const after = p.slice(at)
    for (const s of [
      'If it is not the SHA you reviewed, run `gh pr ready <n> --undo` at once.',
      'Do the same if the read fails.',
      'Then report changes with the new SHAs.',
      'If the undo fails, report blocked with the pull request link.',
    ])
      expect(after, `${id}: ${s}`).toContain(s)
  }
})

test('claude-factory-ye1v AC4: the house rule allows only the --undo form and requires a draft before a push', () => {
  const line = lifecycle.rules!.split('\n').find(l => l.includes('gh pr create --draft'))!
  expect(line).toContain('except `gh pr ready <n> --undo`')
  expect(line).toContain('is not a draft')
})

// claude-factory-qda: asd-ste100 goes to the stations that write text people read, and to no other
test('lifecycle gives asd-ste100 to its text stations only, code-review to review and egm to plan', () => {
  const text = ['plan', 'implement', 'review', 'security', 'quick', 'check', 'rollback', 'incident']
  for (const [id, node] of Object.entries(lifecycle.nodes))
    expect([id, workerSkills(lifecycle, node as { skills?: string[] })]).toEqual([
      id,
      id === 'review'
        ? ['asd-ste100', 'code-review']
        : id === 'plan'
          ? ['asd-ste100', 'egm']
          : text.includes(id)
            ? ['asd-ste100']
            : [],
    ])
})

const promptOf = (def: Factory, node: string) => (def.nodes[node] as { prompt: string }).prompt

test("deploy and rollout must see the change's own live output; not fired yet is unsure (claude-factory-ee7 AC1, AC2)", () => {
  for (const [def, node] of [
    [ship, 'deploy'],
    [release, 'rollout'],
  ] as const) {
    const p = promptOf(def, node)
    expect(p, node).toContain('own output')
    expect(p, node).toContain(
      'the file it writes, the log line it prints, or the process or subagent it starts',
    )
    expect(p, node).toMatch(/not fired yet[^.]*unsure|unsure[^.]*not fired yet/)
    expect((def.nodes as Record<string, { next: unknown }>)[node]!.next).toMatchObject({
      unsure: { to: 'soak', delayMin: 15 },
    })
  }
})

test('ship deploy parks on a stale manager; release rollout does not (claude-factory-ee7 AC3)', () => {
  const p = promptOf(ship, 'deploy')
  for (const word of ['manager.json', 'startedAt', 'argv', 'managerCommand', 'restart the factory manager'])
    expect(p, word).toContain(word)
  expect(promptOf(release, 'rollout')).not.toContain('manager.json')
})

test('soak needs the own output before healthy (claude-factory-ee7 AC4)', () => {
  for (const def of [ship, release]) {
    const p = promptOf(def, 'soak')
    expect(p).toContain('own output')
    expect(p).toContain('not fired yet')
  }
})

test('rollback and soak call an unreproduced cause a hypothesis (claude-factory-ee7 AC5)', () => {
  for (const [def, node] of [
    [ship, 'rollback'],
    [lifecycle, 'rollback'],
    [release, 'rollback'],
    [ship, 'soak'],
    [release, 'soak'],
  ] as const)
    expect(promptOf(def, node), node).toContain('hypothesis unless you reproduced it')
})

const NO_BLOCK = [
  ['implement', 'ready', 'verify'],
  ['verify', 'green', 'review'],
  ['quick', 'ready', 'check'],
] as const

test('claude-factory-9sji AC1: implement, verify and quick carry the no-block rule', () => {
  for (const [id] of NO_BLOCK)
    for (const needle of [
      'ready, merge or hold',
      'For the person:',
      'another open pull request',
      'owner-only',
    ])
      expect(promptOf(lifecycle, id), `${id}: ${needle}`).toContain(needle)
})

test('claude-factory-9sji AC2: the rule names a forward outcome of each station', () => {
  for (const [id, outcome, to] of NO_BLOCK) {
    expect(promptOf(lifecycle, id), id).toContain(`report ${outcome}. Do not report blocked or decision`)
    expect((lifecycle.nodes[id] as { next: Record<string, unknown> }).next[outcome], id).toBe(to)
  }
})

test('claude-factory-9sji AC3: closed tasks and green CI reach review', () => {
  expect(walk(lifecycle, ['build', 'ready', 'ready', 'green']).visited).toEqual([
    'triage',
    'plan',
    'implement',
    'verify',
    'review',
  ])
})

test('claude-factory-9sji AC4: only implement, verify and quick carry the rule; it keeps the owner-only park and names no gh pr ready', () => {
  const carriers: string[] = NO_BLOCK.map(([id]) => id)
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const prompt = (node as { prompt?: unknown }).prompt
    if (typeof prompt !== 'string') continue
    expect(prompt.includes('For the person:'), id).toBe(carriers.includes(id))
  }
  for (const id of carriers) {
    expect(promptOf(lifecycle, id), id).toContain('parked, waiting on')
    expect(promptOf(lifecycle, id), id).toContain('still a failure')
  }
  expect(promptOf(lifecycle, 'verify')).toContain('red with a numbered list')
  expect(promptOf(lifecycle, 'verify')).toContain('Failing:')
})

test('claude-factory-k7ku AC1-AC4: verify cites exact-head CI for a local tool that cannot run', () => {
  const verify = promptOf(lifecycle, 'verify')
  for (const s of [
    'exact head SHA',
    'PKIX',
    'Local gap:',
    'A CI run on another SHA does not count',
    'For the person:',
  ])
    expect(verify).toContain(s)
  expect(verify.split('Local gap:').length - 1).toBe(1)
  expect(verify.indexOf('Local gap:')).toBeLessThan(verify.indexOf('When to block:'))
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const prompt = (node as { prompt?: unknown }).prompt
    if (typeof prompt === 'string' && id !== 'verify') expect(prompt, id).not.toContain('Local gap:')
  }
})

test('claude-factory-aure.3 AC3: implement, quick, verify and check run the brief fast check, once, in place', () => {
  const S = {
    implement:
      'If your brief has a Fast check section, run its command at the worktree root at the final HEAD and fix the code until it exits 0; report ready only then, with the line `Fast check: exit 0` in the Self-check block. If the command cannot start on this worker (the tool is not found, or a network fetch fails), write `Fast check: not run: <error>` instead; any other non-zero exit is a defect to fix.',
    quick:
      'If your brief has a Fast check section, run its command at the worktree root after your last commit and fix the code until it exits 0; report ready only then, with the line `Fast check: exit 0` in the summary. If the command cannot start on this worker, put `Fast check: not run: <error>` in the summary instead.',
    verify:
      'If your brief has a Fast check section, run its command first. If it exits non-zero, run nothing else: report red at once with the command, its exit code and at most 20 lines of its output, record one bug task, and end with the line `Failing: fast check`. A command that cannot start on this worker follows the local tool rule below.',
    check:
      'If your brief has a Fast check section, run its command first. If it exits non-zero, run nothing else and skip the review: post the verdict as below with the command, its exit code and at most 20 lines of its output, record one task, and report changes.',
  }
  const after = {
    implement: 'Merge origin/{base_branch} last',
    quick: '',
    verify: '',
    check: '',
  }
  const before = {
    implement: '2. Make an AC table',
    quick: 'Push the branch and open it as a draft pull request',
    verify: 'Run the full pipeline the repo defines',
    check: "Run the repo's full pipeline",
  }
  for (const [id, s] of Object.entries(S)) {
    const p = promptOf(lifecycle, id)
    expect(p.split(s).length - 1, id).toBe(1)
    const at = p.indexOf(s)
    expect(at, id).toBeGreaterThan(p.indexOf(after[id as keyof typeof after]))
    expect(at, id).toBeLessThan(p.indexOf(before[id as keyof typeof before]))
    expect(s, id).not.toContain('## Fast check')
    expect(s, id).not.toContain('Local gap:')
  }
  expect(promptOf(lifecycle, 'check')).toContain('post the verdict')
  expect(promptOf(lifecycle, 'verify')).toContain('local tool rule')
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    if (id in S) continue
    const n = node as { prompt?: unknown; onTimeout?: { prompt?: string } }
    if (typeof n.prompt === 'string') expect(n.prompt, id).not.toContain('Fast check')
    expect(n.onTimeout?.prompt ?? '', id).not.toContain('Fast check')
  }
})

test('claude-factory-p7fs AC1: the plan prompt asks a guard that parses input for a closed grammar, once, and no other prompt does', () => {
  const S =
    "When the change adds a guard that parses another tool's input (a shell command, a Kustomize tree, a config file), specify a closed grammar: list each field and path form the guard reads, reject every other form before any render or run, and test that a rejection makes zero downstream calls."
  const plan = promptOf(lifecycle, 'plan')
  expect(plan).toContain(S)
  expect(plan.split(S).length - 1).toBe(1)
  expect(plan).toContain(
    'For a guard, validator or parser, define the class as one fail-closed rule, not as a list of forms, and name the forms that are out of scope.',
  )
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const prompt = (node as { prompt?: unknown }).prompt
    if (id !== 'plan' && typeof prompt === 'string') expect(prompt.includes('closed grammar'), id).toBe(false)
  }
})

test('implement and quick tell the worker to grep sibling sites of its fix (smmr AC1)', () => {
  const RULE =
    'Before you report ready, grep every other caller of the code you fixed (the same function, the same unguarded call, the same rule text in a sibling prompt step). Fix each one, or list it in the report with the reason it is safe.'
  for (const id of ['implement', 'quick']) expect(promptOf(lifecycle, id), id).toContain(RULE)
  for (const id of ['plan', 'verify', 'review', 'security', 'check'])
    expect(promptOf(lifecycle, id), id).not.toContain(RULE)
  expect(promptOf(lifecycle, 'implement')).toContain(
    'A finding names an instance: grep for its siblings and fix the class, not the one line.',
  )
})

test('review, security and check list the whole class of a missing guard (pjno AC1, AC2)', () => {
  const RULE =
    "When you find one missing guard, list every sibling of its class before you report: every entry point of the same kind (CLI verb, route, handler, tick pass, spawned child), with each one's guard status. Report the whole class as one finding, with the list, so implement fixes all of it in one round."
  for (const id of ['review', 'security', 'check']) {
    const p = promptOf(lifecycle, id)
    expect(p, id).toContain(RULE)
    expect(p.split(RULE).length - 1, id).toBe(1)
  }
  for (const id of ['plan', 'implement', 'verify', 'quick'])
    expect(promptOf(lifecycle, id), id).not.toContain(RULE)
})

// claude-factory-ey90: a triage parked on a PR holds plain mail; only a wake mail or the timer starts a worker
function parkTriage(reason: string) {
  const actor = createActor(compile(lifecycle)).start()
  const send = (e: Parameters<typeof actor.send>[0]) => (actor.send(e), actor.getSnapshot())
  send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 10 })
  const s = send({ type: 'BLOCKED', seq: 1, reason, at: 20 })
  return { send, s }
}
const mailTo = (to: string) =>
  ({ type: 'MAIL', from: 'manager', to, text: 'Report blocked', at: 30 }) as const

test('ey90 AC1: only the lifecycle triage node holds mail', () => {
  expect(lifecycle.nodes.triage?.holdMail).toBe(true)
  for (const id of ['plan', 'implement', 'verify', 'review'])
    expect((lifecycle as Factory).nodes[id]?.holdMail, id).toBeFalsy()
})

test('ey90 AC2, AC3: plain mail to a PR-parked triage waits; a wake mail starts the worker', () => {
  const { send } = parkTriage('Waiting on: a person merges ' + PR)
  const m = send(mailTo('triage'))
  expect(where(m.value)).toEqual(['triage', 'waiting'])
  expect(m.context.mail.triage?.at(-1)?.text).toBe('Report blocked')
  const w = send({ type: 'MAIL', from: 'factory', to: 'triage', text: 'merged', wake: true, at: 40 })
  expect(where(w.value)).toEqual(['triage', 'working'])
  expect(w.context.mail.triage?.map(x => x.text)).toEqual(['Report blocked', 'merged'])
})

test('ey90 AC4: no PR link, the timer, or another station still start a worker at once', () => {
  expect(where(parkTriage('Waiting on the owner').send(mailTo('triage')).value)).toEqual([
    'triage',
    'working',
  ])
  const t = parkTriage('Waiting on ' + PR)
  expect(where(t.send({ type: 'TICK', at: t.s.context.wakeAt! }).value)).toEqual(['triage', 'working'])
  const actor = createActor(compile(lifecycle)).start()
  actor.send({ type: 'DONE', seq: 1, outcome: 'build', summary: 'x', at: 10 })
  actor.send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 11 })
  actor.send({ type: 'BLOCKED', seq: 1, reason: 'Waiting on ' + PR, at: 20 })
  actor.send(mailTo('plan'))
  expect(where(actor.getSnapshot().value)).toEqual(['plan', 'working'])
})

test('ey90 AC5: a GitLab merge request link holds plain mail too', () => {
  const { send } = parkTriage('Waiting on https://gitlab.example.com/acme/widget/-/merge_requests/7')
  expect(where(send(mailTo('triage')).value)).toEqual(['triage', 'waiting'])
})

const PLAN_RULE =
  "If this run files a bead for a bug that its own change makes worse in production (more often, wider or longer), put one line `Made worse: <id>: <how>` in the summary. Then do one of these and record the choice and the reason in a bd comment on the run's bead: fix the bug in this run as a task (`--parent <run bead>`), or gate the deploy on it. To gate it, file it with `--deps discovered-from:<run bead>` and put the line `Made worse by: <run bead>` in its description. For a bead that is already open, add that line with `bd comment <id>` and link it with `bd dep add <id> <run bead> -t discovered-from`."

const GATE_RULE =
  "Made-worse gate: before you mark ready, merge or deploy a pull request, run `bd dep list <bead> --direction=up -t discovered-from` for its bead. Run `bd show <id>` for each open bead in the list. A bead gates the pull request when its description or a comment contains `Made worse by: <bead>`, or says that this change makes it worse in production. The gate clears only when that bead is closed, or when a person's own comment on it or a [factory mail] from the manager says to ship anyway. If a bead gates the pull request, do not mark it ready, merge it or deploy it. If it is not a draft, run `gh pr ready <n> --undo`. Report blocked with each gating bead id and a `Question:` line that asks the person to ship before the fix or to wait. If a bd command fails, report blocked with the command: never ship on a failed read."

test('plan names a bead that its change makes worse and records fix or gate (claude-factory-j2k AC1)', () => {
  const plan = promptOf(lifecycle, 'plan')
  expect(plan.split(PLAN_RULE).length - 1).toBe(1)
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const prompt = (node as { prompt?: unknown }).prompt
    if (id !== 'plan' && typeof prompt === 'string') expect(prompt.includes('Made worse:'), id).toBe(false)
  }
})

test('ship release, ship deploy and release rollout gate on a made-worse discovered-from bead (claude-factory-j2k AC2-AC4)', () => {
  const sites: [string, string, string[]][] = [
    ['ship release', promptOf(ship, 'release'), ['mark it ready with `gh pr ready`', 'gh pr merge']],
    ['ship deploy', promptOf(ship, 'deploy'), ['Merged: record the production baseline']],
    ['release rollout', promptOf(release, 'rollout'), ['Approved: record']],
  ]
  for (const [name, p, after] of sites) {
    expect(p.split(GATE_RULE).length - 1, name).toBe(1)
    for (const a of after) expect(p.indexOf('Made-worse gate'), name + a).toBeLessThan(p.lastIndexOf(a))
  }
  for (const [def, ids] of [
    [ship, ['queue', 'soak', 'rollback', 'postmortem']],
    [release, ['recipe', 'gather', 'cut', 'soak', 'rollback']],
  ] as const)
    for (const id of ids) {
      const node = (def.nodes as Record<string, { prompt?: string }>)[id]
      if (node?.prompt) expect(node.prompt.includes('Made-worse gate'), id).toBe(false)
    }
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const prompt = (node as { prompt?: unknown }).prompt
    if (typeof prompt !== 'string') continue
    const gated = ['review', 'security', 'check'].includes(id)
    expect(prompt.split(GATE_RULE).length - 1, id).toBe(gated ? 1 : 0)
    if (gated)
      expect(prompt.indexOf('Made-worse gate'), id).toBeLessThan(prompt.indexOf('gh pr ready <n> -R'))
    else expect(prompt.includes('Made-worse gate'), id).toBe(false)
  }
  for (const s of [
    'never ship on a failed read',
    '--undo',
    "a person's own comment",
    '[factory mail]',
    '`Question:`',
  ])
    expect(GATE_RULE).toContain(s)
})

test('runner-loss scenario matrix: every ADR phrase is in the house rules (s2hn)', () => {
  const adr = readFileSync(
    join(import.meta.dir, '..', 'docs/architecture/adr-factory-runner-loss-escalation.md'),
    'utf8',
  )
  const rows = [...adr.matchAll(/^\| S(\d+) \|.*\| `(.+)` \|$/gm)].map(m => ({
    n: Number(m[1]),
    phrase: m[2]!.replace(/\\`/g, '`'),
  }))
  expect(rows.length).toBeGreaterThanOrEqual(8)
  expect(rows.map(r => r.n)).toEqual(rows.map((_, i) => i + 1))
  for (const r of rows) expect(lifecycle.rules!).toContain(r.phrase)
  const search = lifecycle.rules!.match(/bd search '([^']+)' --status/)![1]
  expect(lifecycle.rules!).toContain("bd create '" + search + "'")
  for (const n of ['implement', 'verify', 'quick'] as const)
    expect(lifecycle.nodes[n]!.prompt).toContain(
      'a second runner loss at the same step, after the host bug exists',
    )
})

// claude-factory-dgok: untrusted text must not sit in shell double quotes ($(...), backticks and $VAR expand there).
test('triage: every non-ID placeholder in a factory command span is single-quoted (claude-factory-dgok)', () => {
  const ids = new Set(['rig', 'this rig', "this bead's id", 'path'])
  const bad = (t: string) =>
    (t.match(/`factory [^`]*`/g) ?? []).flatMap(s =>
      (s.replace(/'<[^>]*>'/g, '').match(/<[^>]*>/g) ?? []).filter(p => !ids.has(p.slice(1, -1))),
    )
  expect(bad(lifecycle.nodes.triage!.prompt)).toEqual([])
  expect(bad('`factory file-elsewhere <rig> --title <title>`')).toEqual(['<title>'])
  expect(bad("`factory file-elsewhere <rig> --title '<title>'`")).toEqual([])
})

test('triage passes file-elsewhere text by file (claude-factory-dgok, claude-factory-jho3)', () => {
  const t = lifecycle.nodes.triage!.prompt
  const spans = (t.match(/`[^`]*`/g) ?? []).filter(s => s.includes('file-elsewhere'))
  expect(spans.length).toBeGreaterThan(0)
  for (const s of spans) expect(s).not.toContain('"<')
  for (const p of ['title', 'description']) expect(spans.join('\n')).toContain(`--${p}-file <path>`)
})

test('v5eq AC4 plan forbids must-see-live deadline', () => {
  for (const [id, node] of Object.entries(lifecycle.nodes)) {
    const p = (node as { prompt?: string }).prompt ?? ''
    if (id === 'plan') {
      expect(p).toContain('must-see-live')
      expect(p.slice(p.indexOf('6. Observability'), p.indexOf('7. Tasks'))).toContain('must-see-live')
      expect(p.slice(p.indexOf('6. Observability'), p.indexOf('7. Tasks'))).toContain(
        'Mark an AC must-see-live when the soak must see its own output before it reports healthy; the soak then never uses its deadline.',
      )
    } else expect(p, id).not.toContain('must-see-live')
  }
})
