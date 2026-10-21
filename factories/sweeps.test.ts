import { expect, test } from 'bun:test'
import { createActor } from 'xstate'
import { compile, validate, where } from '../src/machine'
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
  expect(sweeps.params).toEqual(lifecycle.params)
})

test('each prompt names its own sweep label, the daily cap and the auto-queue allowlist', () => {
  for (const [id, node] of Object.entries(sweeps.nodes)) {
    expect(node.prompt).toContain(`sweep:${id}`)
    expect(node.prompt).toMatch(/\b5\b.*24 hour/)
    expect(node.prompt).toContain('sweep-queue:incident')
    expect(node.prompt).toContain('sweep-queue:main-ci-red')
    expect(node.prompt).toContain('sweep-queue:critical-advisory')
  }
})

test('drift runs hourly on the laptop, with a read-only prompt that keeps one bead per resource', () => {
  const n = sweeps.nodes.drift
  expect(n.everyMin).toBe(60)
  expect(n.runner).toBe('herdr')
  expect(n.timeoutMin).toBe(30)
  expect(Object.entries(n.next)).toEqual([['filed', 'done']])
  const p = n.prompt
  expect(p).toMatch(/Never apply, patch, reconcile, suspend or resume/)
  expect(p).toContain('previous read')
  expect(p).toContain('60 minutes')
  expect(p).toContain('station:incident')
  expect(p).toContain('sweep-queue:incident')
  expect(p).toContain('drift:<key>')
  expect(p).toContain('comment on it')
  expect(p).toContain('<latest tag>')
  expect(p).toContain('a closed bead counts too')
  expect(p).toContain('bump bead')
  expect(p).toContain('no `factory` label')
})
