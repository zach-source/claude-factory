import { expect, test } from 'bun:test'
import { createActor } from 'xstate'
import { compile, validate, where, type Factory } from '../src/machine'
import lifecycle from './lifecycle'
import ship from './ship'

/** drives a run by outcomes (waking it from any timed wait) and returns the stations it visited */
function walk(def: Factory, outcomes: string[], at = def.start) {
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

test('ship validates, compiles and starts at queue', () => {
  expect(() => compile(validate(ship))).not.toThrow()
  expect(ship.name).toBe('ship')
  expect(ship.start).toBe('queue')
})

test('queue -> deploy -> soak -> queue -> done', () => {
  const { visited, snapshot } = walk(ship, ['ready', 'ready', 'deployed', 'healthy', 'empty'])
  expect(visited).toEqual(['queue', 'release', 'deploy', 'soak', 'queue', 'done'])
  expect(snapshot.context.error).toBeNull()
})

test('a failed deploy rolls back, gets a postmortem, and returns to the queue', () => {
  const { visited } = walk(ship, ['ready', 'ready', 'failed', 'recovered', 'filed', 'empty'])
  expect(visited).toEqual(['queue', 'release', 'deploy', 'rollback', 'postmortem', 'queue', 'done'])
})

test('deploy changes, hold, refresh and published return to the queue', () => {
  for (const outcome of ['changes', 'hold', 'refresh', 'published'])
    expect(walk(ship, ['ready', 'ready', outcome]).visited, outcome).toEqual([
      'queue',
      'release',
      'deploy',
      'queue',
    ])
})

test('a soak that resolves goes to the postmortem; a soak that regresses rolls back', () => {
  expect(walk(ship, ['ready', 'ready', 'deployed', 'resolved', 'filed']).visited.slice(3)).toEqual([
    'soak',
    'postmortem',
    'queue',
  ])
  expect(walk(ship, ['ready', 'ready', 'deployed', 'regressed', 'recovered']).visited.slice(3)).toEqual([
    'soak',
    'rollback',
    'postmortem',
  ])
  expect(walk(ship, ['ready', 'ready', 'deployed', 'unsure']).visited.slice(3)).toEqual(['soak', 'soak'])
})

test('only the release station marks a PR ready: the worker hook allows gh pr ready nowhere else', () => {
  for (const [id, node] of Object.entries(ship.nodes))
    expect(node.prompt.includes('gh pr ready'), id).toBe(id === 'release')
})

test('queue can ask for another pass', () => {
  expect(walk(ship, ['again', 'again', 'empty']).visited).toEqual(['queue', 'queue', 'queue', 'done'])
})

test('gates stay: deploy never merges, waits on the PR and parks on owner-only steps; nothing merges', () => {
  expect(ship.nodes.deploy.awaitsPr).toBe(true)
  expect(ship.nodes.deploy.prompt).toContain('never merge')
  expect(ship.nodes.deploy.prompt).toContain('parked, waiting on: <the owner step and the exact command>')
  expect(ship.nodes.deploy.prompt).toContain('owner-only step')
  expect(ship.rules).toBe(lifecycle.rules)
  expect(ship.rules).toContain('Only a person merges a pull request')
  expect(ship.rules).toContain("a worker's own comment never counts as approval")
  for (const [id, node] of Object.entries(ship.nodes)) {
    expect(node.prompt, id).not.toMatch(/--admin|git push --force|--force-with-lease/)
    // only release names `gh pr merge`, as a line for the owner to run; no station runs it
    if (id !== 'release') expect(node.prompt, id).not.toContain('gh pr merge')
    expect((node as { gate?: unknown }).gate, id).toBeUndefined()
  }
})

test('queue keeps PRs current with a merge commit, never a rebase or a force-push', () => {
  const p = ship.nodes.queue.prompt
  expect(p).toContain('merge origin/main into it (a merge commit')
  expect(p).toContain('Never rebase and never force-push')
  expect(p).not.toMatch(/\brebase onto\b/)
})

test('queue sends a PR that needs changes back to implement through the existing station label', () => {
  expect(ship.nodes.queue.prompt).toContain(
    'bd update <bead> --remove-label ship --add-label factory --add-label station:implement',
  )
})

test('a run ships 30 PRs in a row without a stuck step budget', () => {
  const round = ['ready', 'ready', 'published']
  const outcomes = [...Array(30).keys()].flatMap(() => round)
  const { visited, snapshot } = walk(ship, [...outcomes, 'empty'])
  expect(snapshot.context.error).toBeNull()
  expect(visited.at(-1)).toBe('done')
})

test('a queue that always reports again reaches stuck: again does not refill the budget', () => {
  const { snapshot } = walk(ship, Array(30).fill('again'))
  expect(where(snapshot.value)[1]).toBe('stuck')
})

test('queue tells the worker to unship a PR a person closed unmerged', () => {
  expect(ship.nodes.queue.prompt).toContain('closed unmerged leaves the queue')
})

test('a PR closed unmerged leaves the queue before the hold, and soak reads the bead for earlier rollbacks', () => {
  expect(ship.nodes.deploy.prompt).toContain('--remove-label ship')
  expect(ship.nodes.deploy.prompt).toContain('bd defer <bead>')
  expect(ship.nodes.soak.prompt).toContain("the bead's comments")
})

test('release needs every child task closed first', () => {
  expect(ship.nodes.release.prompt).toContain(
    'Every child task of the bead must be closed (bd children <bead>)',
  )
})

test('a release that reports changes does not refill the budget: 12 x (ready, changes) reaches stuck', () => {
  const { snapshot } = walk(ship, Array(12).fill(['ready', 'changes']).flat())
  expect(where(snapshot.value)[1]).toBe('stuck')
})

test('queue and release cover every clean queued PR, not only the next', () => {
  const q = ship.nodes.queue.prompt
  const r = ship.nodes.release.prompt
  expect(q).toContain('every queued pull request in merge order')
  expect(q).toContain('conflict or a red check on their own, each with its reason')
  expect(q).not.toContain('NEXT')
  expect(r).toContain('every queued pull request that the queue reported')
  expect(r).toContain('gh pr merge <n> -R <repo> --merge')
  expect(r).toContain('You never run them')
  expect(r).not.toContain('NEXT')
})

test('queue names the next PR first and lists every owner-only step in one list', () => {
  expect(ship.nodes.queue.prompt).toContain('name the first one first')
  expect(ship.nodes.queue.prompt).toContain('every owner-only step the queue needs in one list')
})
