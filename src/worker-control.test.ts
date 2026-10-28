// claude-factory-5y7b: a worker cannot run factory say, stop, resume, start or fork.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `worker-control-${process.pid}`)
const home = join(dir, 'home')
const axLog = join(dir, 'ax.log')
const halt = join(home, 'halt.json')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** a fresh home and a fake ax that logs its argv; runs the CLI once with the given extra env */
function run(args: string[], env: Record<string, string>, seedHalt = false, seed?: () => void) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'runs'), { recursive: true })
  seed?.()
  const ax = join(dir, 'fake-ax')
  writeFileSync(ax, `#!/bin/sh\necho "$@" >> ${axLog}\n`, { mode: 0o755 })
  if (seedHalt) writeFileSync(halt, JSON.stringify({ state: 'stopping', at: 1, told: {}, closed: {} }))
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DEF_NAME, BEADS_ACTOR, ...rest } = process.env
  void [FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DEF_NAME, BEADS_ACTOR]
  return Bun.spawnSync([CLI, ...args], {
    env: { ...rest, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_GC: '0', FACTORY_AX: ax, ...env },
  })
}
const runs = () => readdirSync(join(home, 'runs')).length

const markers: Record<string, Record<string, string>> = {
  FACTORY_FROM: { FACTORY_FROM: 'implement' },
  'FACTORY_FROM manager': { FACTORY_FROM: 'manager' },
  FACTORY_RUN: { FACTORY_RUN: 'lifecycle-x' },
  FACTORY_DEF_NAME: { FACTORY_DEF_NAME: 'lifecycle' },
  BEADS_ACTOR: { BEADS_ACTOR: 'factory/lifecycle-x/implement' },
}
const refused = /a worker cannot run factory (say|stop|resume|start|fork)|cannot run fork for another run/

for (const [name, env] of Object.entries(markers)) {
  test(`${name}: say is refused and runs no ax`, () => {
    const p = run(['say', 'hello'], env)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(refused)
    expect(existsSync(axLog)).toBe(false)
  })
  test(`${name}: stop is refused and writes no halt.json`, () => {
    const p = run(['stop'], env)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(refused)
    expect(existsSync(halt)).toBe(false)
  })
  test(`${name}: resume is refused and keeps halt.json`, () => {
    const p = run(['resume'], env, true)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(refused)
    expect(existsSync(halt)).toBe(true)
  })
  for (const args of [
    ['start', 'lifecycle', dir, 'g'],
    ['fork', 'r1', 'implement'],
  ]) {
    test(`${name}: ${args.slice(0, 3).join(' ')} is refused and makes no run`, () => {
      const p = run(args, env)
      expect(p.exitCode).toBe(1)
      expect(p.stderr.toString()).toMatch(refused)
      expect(runs()).toBe(0)
    })
  }
}

test('no marker: say runs ax', () => {
  expect(run(['say', 'hello'], {}).exitCode).toBe(0)
  expect(existsSync(axLog)).toBe(true)
})
test('no marker: stop writes halt.json', () => {
  expect(run(['stop'], {}).exitCode).toBe(0)
  expect(existsSync(halt)).toBe(true)
})
test('no marker: resume removes halt.json', () => {
  expect(run(['resume'], {}, true).exitCode).toBe(0)
  expect(existsSync(halt)).toBe(false)
})

// a fork with a note goes through managerSender, which skips FACTORY_FROM and FACTORY_RUN for mail
const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}
function seedRun() {
  const d = join(home, 'runs', 'r1')
  mkdirSync(join(dir, 'wt'), { recursive: true })
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id: 'r1',
      factory: file,
      repo: join(dir, 'repo'),
      goal: 'g',
      ws: 'w1',
      worktree: join(dir, 'wt'),
      branch: 'b',
    }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
}
for (const [name, env] of [
  ['FACTORY_FROM', { FACTORY_FROM: 'implement' }],
  ['FACTORY_FROM manager', { FACTORY_FROM: 'manager' }],
  ['FACTORY_RUN own run', { FACTORY_RUN: 'r1' }],
] as const) {
  test(`${name}: fork with a note is refused and makes no run`, () => {
    const p = run(['fork', 'r1', 'implement', 'a', 'note'], env, false, seedRun)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(/a worker cannot run factory fork/)
    expect(runs()).toBe(1)
  })
}

// claude-factory-s6ra: the older manager-only write verbs refuse every worker marker, not FACTORY_FROM alone.
const managerOnly: string[][] = [
  ['skills', 'install', 'sk'],
  ['skills', 'reject', 'sk', 'no'],
  ['proposals', 'install', 'p'],
  ['proposals', 'reject', 'p', 'no'],
  ['decisions', 'answer', 'widget', 'acme-1', 'yes'],
  ['decisions', 'propose', 'k1', 'q?', 'a: b | c: d'],
  ['decide', 'lifecycle-x', 'ready'],
  ['plan', 'set', 'answer.json'],
  ['review', 'set', 'k', 'f.json'],
  ['gate-brief', 'set', 'gate:x@1', 'f.json'],
]
for (const [name, env] of Object.entries(markers)) {
  for (const args of managerOnly) {
    test(`${name}: ${args.slice(0, 2).join(' ')} is refused as a worker`, () => {
      const p = run(args, env)
      expect(p.exitCode).toBe(1)
      expect(p.stderr.toString()).toMatch(/a worker cannot/)
    })
  }
}
for (const [name, env] of Object.entries({ 'no marker': {}, 'BEADS_ACTOR person': { BEADS_ACTOR: 'person' } })) {
  for (const args of managerOnly) {
    test(`${name}: ${args.slice(0, 2).join(' ')} is not refused as a worker`, () => {
      expect(run(args, env).stderr.toString()).not.toMatch(/a worker cannot/)
    })
  }
}
for (const verb of ['skills', 'proposals']) {
  test(`FACTORY_RUN: ${verb} list still works`, () => {
    expect(run([verb], { FACTORY_RUN: 'lifecycle-x' }).exitCode).toBe(0)
  })
}
