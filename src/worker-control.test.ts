// claude-factory-5y7b: a worker cannot run factory say, stop, resume, start or fork.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    FACTORY_RUN,
    FACTORY_DEF_NAME,
    BEADS_ACTOR,
    FACTORY_PATROL,
    ...rest
  } = process.env
  void [FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DEF_NAME, BEADS_ACTOR, FACTORY_PATROL]
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

// claude-factory-3c4w: the other manager-only verbs refuse a worker; some also refuse a patrol
const inbox = () => join(home, 'runs', 'r1', 'inbox.jsonl')
const rigsFile = join(home, 'rigs.json')
const RIGS = '[]'
const seedAll = () => {
  seedRun()
  writeFileSync(rigsFile, RIGS)
}
const workerMarkers: Record<string, Record<string, string>> = {
  FACTORY_FROM: markers.FACTORY_FROM!,
  'FACTORY_FROM manager': markers['FACTORY_FROM manager']!,
  FACTORY_DEF_NAME: markers.FACTORY_DEF_NAME!,
  'FACTORY_RUN own run': { FACTORY_RUN: 'r1' },
  'BEADS_ACTOR r1': { BEADS_ACTOR: 'factory/r1/implement' },
}
const verbRows: { args: string[]; verb: string; patrol: boolean }[] = [
  { args: ['goto', 'r1', 'done'], verb: 'goto', patrol: false },
  { args: ['retry', 'r1'], verb: 'retry', patrol: false },
  { args: ['abort', 'r1'], verb: 'abort', patrol: false },
  { args: ['rm', 'r1'], verb: 'rm', patrol: false },
  { args: ['tick'], verb: 'tick', patrol: true },
  { args: ['loop', '--interval', '1000'], verb: 'loop', patrol: true },
  { args: ['self-update'], verb: 'self-update', patrol: true },
  { args: ['gc', '--dry-run'], verb: 'gc', patrol: true },
  { args: ['sweep'], verb: 'sweep', patrol: true },
  { args: ['beads'], verb: 'beads', patrol: false },
  { args: ['watch'], verb: 'watch', patrol: false },
  { args: ['sync'], verb: 'sync', patrol: false },
  { args: ['dream'], verb: 'dream', patrol: false },
  { args: ['devenv'], verb: 'devenv', patrol: false },
  { args: ['attach'], verb: 'attach', patrol: true },
  { args: ['manager'], verb: 'manager', patrol: true },
  { args: ['manager', 'host'], verb: 'manager', patrol: true },
  { args: ['manager', '--ax'], verb: 'manager', patrol: true },
  { args: ['migrate-to-ax'], verb: 'migrate-to-ax', patrol: true },
  { args: ['rig', 'add', 'w', dir], verb: 'rig add', patrol: true },
  { args: ['rig', 'rm', 'w'], verb: 'rig rm', patrol: true },
]
/** nothing the verb writes exists after a refusal */
function untouched() {
  expect(existsSync(axLog)).toBe(false)
  expect(readdirSync(home).sort()).toEqual(['rigs.json', 'runs'])
  expect(readdirSync(join(home, 'runs'))).toEqual(['r1'])
  expect(readFileSync(rigsFile, 'utf8')).toBe(RIGS)
  expect(readFileSync(inbox(), 'utf8')).toBe('')
}
for (const [name, env] of Object.entries(workerMarkers)) {
  for (const { args, verb } of verbRows) {
    test(`${name}: ${args.slice(0, 3).join(' ')} is refused and changes nothing`, () => {
      const p = run(args, env, false, seedAll)
      expect(p.exitCode).toBe(1)
      expect(p.stderr.toString()).toContain(`a worker cannot run factory ${verb} (`)
      untouched()
    })
  }
}
for (const { args, verb, patrol } of verbRows) {
  if (!patrol) continue
  test(`patrol: ${args.slice(0, 3).join(' ')} is refused and changes nothing`, () => {
    const p = run(args, { FACTORY_PATROL: '1' }, false, seedAll)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toContain(`a patrol cannot run factory ${verb}:`)
    untouched()
  })
}
test('patrol: say is refused and runs no ax', () => {
  const p = run(['say', 'x'], { FACTORY_PATROL: '1' })
  expect(p.exitCode).toBe(1)
  expect(p.stderr.toString()).toContain('a patrol cannot run factory say:')
  expect(existsSync(axLog)).toBe(false)
})
test('patrol: stop is refused and writes no halt.json', () => {
  const p = run(['stop'], { FACTORY_PATROL: '1' })
  expect(p.exitCode).toBe(1)
  expect(p.stderr.toString()).toContain('a patrol cannot run factory stop:')
  expect(existsSync(halt)).toBe(false)
})
test('patrol: resume is refused and keeps halt.json', () => {
  const p = run(['resume'], { FACTORY_PATROL: '1' }, true)
  expect(p.exitCode).toBe(1)
  expect(p.stderr.toString()).toContain('a patrol cannot run factory resume:')
  expect(existsSync(halt)).toBe(true)
})
test('patrol: goto and abort queue their event', () => {
  expect(run(['goto', 'r1', 'done'], { FACTORY_PATROL: '1' }, false, seedAll).exitCode).toBe(0)
  expect(readFileSync(inbox(), 'utf8')).toContain('"GOTO"')
  expect(run(['abort', 'r1'], { FACTORY_PATROL: '1' }, false, seedAll).exitCode).toBe(0)
  expect(readFileSync(inbox(), 'utf8')).toContain('"ABORT"')
})
for (const [name, env] of [...Object.entries(workerMarkers), ['patrol', { FACTORY_PATROL: '1' }]] as const) {
  for (const args of [['rig'], ['rig', 'list']]) {
    test(`${name}: ${args.join(' ')} is allowed`, () => {
      expect(run(args, env, false, seedAll).exitCode).toBe(0)
    })
  }
}
test('no marker: abort keeps working', () => {
  expect(run(['abort', 'r1'], {}, false, seedAll).exitCode).toBe(0)
  expect(readFileSync(inbox(), 'utf8')).toContain('"ABORT"')
})
