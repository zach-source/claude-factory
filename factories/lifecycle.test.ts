import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { createActor } from 'xstate'
import { ruleLines } from '../src/cli'
import { compile, validate, where, type Factory } from '../src/machine'
import lifecycle from './lifecycle'
import release from './release'

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

test('sweeps loop on their timers past any step budget', () => {
  for (const sweep of ['monitor', 'maintain', 'improve']) {
    const again = sweep === 'monitor' ? 'watching' : 'again'
    const { visited, snapshot } = walk(lifecycle, Array(lifecycle.maxSteps + 5).fill(again), sweep)
    expect(new Set(visited)).toEqual(new Set([sweep]))
    expect(where(snapshot.value)).toEqual([sweep, 'working'])
  }
})
