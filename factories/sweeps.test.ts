import { expect, test } from 'bun:test'
import { createActor } from 'xstate'
import { compile, fill, validate, where } from '../src/machine'
import lifecycle from './lifecycle'
import sweeps from './sweeps'

test('sweeps validates and compiles', () => {
  expect(() => compile(validate(sweeps))).not.toThrow()
})

test('every node is a sweep station (everyMin set)', () => {
  for (const [id, node] of Object.entries(sweeps.nodes)) expect(node.everyMin, id).toBeGreaterThan(0)
})

test('a goto reaches each node, and its one outcome reaches done', () => {
  for (const [id, node] of Object.entries(sweeps.nodes)) {
    const actor = createActor(compile(sweeps)).start()
    actor.send({ type: 'GOTO', node: id, at: 0 })
    expect(where(actor.getSnapshot().value)).toEqual([id, 'working'])
    const outcomes = Object.keys(node.next)
    expect(outcomes).toHaveLength(1)
    const [outcome] = outcomes
    const { seq } = actor.getSnapshot().context
    actor.send({ type: 'DONE', seq, outcome: outcome!, summary: 'filed 2', at: 1 })
    expect(where(actor.getSnapshot().value)).toEqual(['done', ''])
  }
})

test('sweeps carries the same house rules and params as lifecycle', () => {
  expect(sweeps.rules).toBe(lifecycle.rules)
  // the codex params belong to lifecycle's split stations: sweeps has none
  const claudeOnly = Object.fromEntries(
    Object.entries(lifecycle.params as Record<string, string>).filter(([k]) => !k.startsWith('codex')),
  )
  expect(sweeps.params as object).toEqual(claudeOnly)
})

test('each prompt names its own sweep label, the daily cap and the auto-queue allowlist', () => {
  for (const [id, node] of Object.entries(sweeps.nodes)) {
    if (id === 'hygiene') continue // code-only: no worker reads this prompt
    expect(node.prompt).toContain(`sweep:${id}`)
    expect(node.prompt).toMatch(/\b5\b.*24 hour/)
    expect(node.prompt).toContain('sweep-queue:incident')
    expect(node.prompt).toContain('sweep-queue:main-ci-red')
    expect(node.prompt).toContain('sweep-queue:critical-advisory')
    expect(node.prompt).toContain('sweep-queue:flaky-test')
  }
})

test('hygiene is a daily code-only sweep node', () => {
  expect(sweeps.nodes.hygiene.everyMin).toBe(1440)
})

test('ci runs every 2 h and flakes every week, both on the laptop', () => {
  expect(sweeps.nodes.ci.everyMin).toBe(120)
  expect(sweeps.nodes.flakes.everyMin).toBe(10080)
  expect(sweeps.nodes.ci.runner).toBe('herdr')
  expect(sweeps.nodes.flakes.runner).toBe('herdr')
})

test('the ci prompt files one P1 bead with the queue labels and the keys', () => {
  const p = sweeps.nodes.ci.prompt
  for (const s of ['-p 1', 'ONE bead', 'factory', 'station:plan', 'sweep-queue:main-ci-red', 'ci-red:'])
    expect(p).toContain(s)
})

test('the flakes prompt gives the title, P2 and queues only when queue is true', () => {
  const p = sweeps.nodes.flakes.prompt
  for (const s of [
    'quarantine + fix flaky test: <id>',
    '-p 2',
    'station:plan',
    'sweep-queue:flaky-test',
    'queue true',
  ])
    expect(p).toContain(s)
})

test('maintain no longer files red CI or flaky tests', () => {
  const p = sweeps.nodes.maintain.prompt
  expect(p).not.toContain('labeled sweep-queue:main-ci-red')
  expect(p).not.toMatch(/failing or flaky tests/)
})

test('advisories runs weekly on the laptop and files only through the factory CLI', () => {
  const n = sweeps.nodes.advisories
  expect(n.everyMin).toBe(10080)
  expect(n.runner).toBe('herdr')
  expect(Object.values(n.next)).toEqual(['done'])
  expect(n.prompt).toContain('factory advisories file')
  expect(n.prompt).toContain('Never file an advisory bead by hand')
})

test('maintain leaves advisories to the advisories sweep and keeps end-of-life runtimes', () => {
  const p = sweeps.nodes.maintain.prompt
  expect(p).not.toContain('security advisories on')
  expect(p).toContain('end-of-life runtimes')
})

test('only the monitor prompt carries the Mimir query form, before the guard note', () => {
  const p = (id: string) => (sweeps.nodes as Record<string, { prompt: string }>)[id]!.prompt
  expect(p('monitor')).toContain("--post-data='query=<PromQL>'")
  expect(p('monitor').indexOf('X-Scope-OrgID')).toBeLessThan(
    p('monitor').indexOf('The factory labels what you file'),
  )
  for (const id of Object.keys(sweeps.nodes).filter(i => i !== 'monitor'))
    expect(p(id), id).not.toContain('X-Scope-OrgID')
  expect(fill(p('monitor'), {})).toBe(p('monitor'))
  expect(p('monitor')).not.toMatch(new RegExp(['stig' + 'en', 'spin' + 'dle'].join('|'), 'i'))
})
