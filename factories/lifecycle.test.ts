import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { createActor } from 'xstate'
import { compile, validate, where, type Factory } from '../src/machine'
import lifecycle from './lifecycle'

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

test('build: inner loops, a security review, the approval gate, a soak', () => {
  const { visited, snapshot } = walk(lifecycle, [
    ...['build', 'ready', 'ready', 'red', 'ready', 'green', 'security', 'changes', 'ready', 'green'],
    ...['approve', 'ready', 'ship', 'deployed', 'healthy'],
  ])
  expect(visited).toEqual([
    ...['triage', 'plan', 'implement', 'verify', 'implement', 'verify', 'review', 'security', 'implement'],
    'verify',
    ...['review', 'release', 'approve', 'deploy', 'soak', 'done'],
  ])
  expect(snapshot.context.error).toBeNull()
})

test('a soak that regresses rolls back, fixes forward, and ends in a postmortem', () => {
  const { visited } = walk(lifecycle, [
    ...['build', 'ready', 'ready', 'green', 'approve', 'ready', 'ship', 'deployed', 'regressed'],
    ...['recovered', 'ready', 'ready', 'green', 'approve', 'ready', 'ship', 'deployed', 'unsure', 'resolved'],
    'filed',
  ])
  expect(visited.slice(9)).toEqual([
    ...['rollback', 'plan', 'implement', 'verify', 'review', 'release', 'approve', 'deploy', 'soak', 'soak'],
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

test('sweeps loop on their timers past any step budget', () => {
  for (const sweep of ['monitor', 'maintain', 'improve']) {
    const again = sweep === 'monitor' ? 'watching' : 'again'
    const { visited, snapshot } = walk(lifecycle, Array(lifecycle.maxSteps + 5).fill(again), sweep)
    expect(new Set(visited)).toEqual(new Set([sweep]))
    expect(where(snapshot.value)).toEqual([sweep, 'working'])
  }
})
