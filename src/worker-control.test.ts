// claude-factory-5y7b: a worker cannot run factory say, stop, resume, start or fork.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { workerVerbRefusal } from './cli'

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
    timeout: 15000,
    env: {
      ...rest,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_NO_KICK: '1',
      FACTORY_AX: ax,
      ...env,
    },
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
  { args: ['memory', 'compact'], verb: 'memory compact', patrol: false },
  { args: ['devenv'], verb: 'devenv', patrol: false },
  { args: ['linear', '--force'], verb: 'linear', patrol: false },
  { args: ['queue', 'acme', 'b1'], verb: 'queue', patrol: false },
  { args: ['poke', 'r1'], verb: 'poke', patrol: false },
  { args: ['attach'], verb: 'attach', patrol: true },
  { args: ['server'], verb: 'server', patrol: true },
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
// claude-factory-6rmg: compact --dry-run only reads, so a worker keeps it
for (const [name, env] of Object.entries(workerMarkers)) {
  test(`${name}: memory compact --dry-run is allowed`, () => {
    const p = run(['memory', 'compact', '--dry-run'], env, false, seedAll)
    expect(p.stderr.toString()).not.toContain('a worker cannot')
    expect(p.exitCode).toBe(0)
  })
}
test('no marker: memory compact is not refused', () => {
  const p = run(['memory', 'compact'], {}, false, seedAll)
  expect(p.stderr.toString()).not.toContain('a worker cannot')
})
test('no marker: abort keeps working', () => {
  expect(run(['abort', 'r1'], {}, false, seedAll).exitCode).toBe(0)
  expect(readFileSync(inbox(), 'utf8')).toContain('"ABORT"')
})
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
const plain: Record<string, Record<string, string>> = {
  'no marker': {},
  'BEADS_ACTOR person': { BEADS_ACTOR: 'person' },
}
for (const [name, env] of Object.entries(plain)) {
  for (const args of managerOnly) {
    test(`${name}: ${args.slice(0, 2).join(' ')} is not refused as a worker`, () => {
      expect(run(args, env).stderr.toString()).not.toMatch(/a worker cannot/)
    })
  }
}
for (const verb of ['skills', 'proposals']) {
  test(`FACTORY_RUN: ${verb} list is refused (e10f: not on the worker allowlist)`, () => {
    expect(run([verb], { FACTORY_RUN: 'lifecycle-x' }).exitCode).toBe(1)
  })
}

// claude-factory-e10f: a worker runs only the verbs on an allowlist; a new verb is refused until someone lists it.
const ALLOWED = [
  'report',
  'mail',
  'memory',
  'status',
  'show',
  'check',
  'home',
  'ship',
  'advisories',
  'pg-scratch',
  'mutate',
  'ci',
  'worker',
  'file-elsewhere',
  'rig',
]
const DENIED = [
  'pkg-gate',
  'ui',
  'start',
  'fork',
  'tick',
  'beads',
  'watch',
  'sync',
  'broker',
  'server',
  'manager',
  'repos',
  'migrate-to-ax',
  'attach',
  'say',
  'stop',
  'resume',
  'dream',
  'devenv',
  'linear',
  'self-update',
  'skills',
  'proposals',
  'loop',
  'metrics',
  'backlog',
  'prs',
  'decisions',
  'plan',
  'review',
  'gate-brief',
  'queue',
  'hygiene',
  'digest',
  'waiting',
  'decide',
  'poke',
  'retry',
  'goto',
  'abort',
  'init',
  'up',
  'adopt',
  'rm',
  'gc',
  'sweep',
  'wiki',
]
const switchCases = () => {
  const src = readFileSync(join(import.meta.dir, 'cli.ts'), 'utf8')
  const from = src.indexOf('    switch (cmd) {')
  const body = src.slice(from, src.indexOf('\n      default:', from))
  return [...body.matchAll(/^ {6}case '([^']+)':/gm)].map(m => m[1]!)
}
test('e10f: every dispatch case is allowed or denied for a worker', () => {
  expect(switchCases().sort()).toEqual([...ALLOWED, ...DENIED].sort())
})

for (const [name, env] of Object.entries(markers)) {
  const call = (c: string | undefined, a: string[] = []) => workerVerbRefusal(c, a, env)
  test(`e10f unit ${name}`, () => {
    for (const v of ALLOWED) expect(call(v)).toBeUndefined()
    for (const v of DENIED) expect(call(v)).toContain(`a worker cannot run factory ${v} (`)
    expect(call('rig', ['list'])).toBeUndefined()
    for (const a of [['add'], ['rm', 'w'], ['--max', '3', 'add']]) expect(call('rig', a)).toBeDefined()
    expect(call('zz-new-verb')).toBeDefined()
    for (const v of [undefined, 'help', '--help', '-h']) expect(call(v)).toBeUndefined()
  })
}
test('e10f unit: no marker and patrol alone are not refused', () => {
  for (const env of [{}, { FACTORY_PATROL: '1' }])
    for (const v of [...ALLOWED, ...DENIED, 'zz-new-verb'])
      expect(workerVerbRefusal(v, [], env)).toBeUndefined()
})

const spawned: [string[], string][] = [
  [['zz-new-verb'], 'zz-new-verb'],
  [['review', 'set', 'k', 'f'], 'review'],
  [['gate-brief', 'set', 'k', 'f'], 'gate-brief'],
  [['plan', 'set', 'f'], 'plan'],
  [['decisions', 'answer', 'acme', 'b1', 't'], 'decisions'],
  [['skills'], 'skills'],
  [['proposals'], 'proposals'],
  [['init'], 'init'],
  [['up', join(dir, 'up-new')], 'up'],
  [['adopt', join(dir, 'adopted')], 'adopt'],
  [['repos', 'sync'], 'repos'],
  [['broker', 'serve', '--port', '0'], 'broker'],
  [['pkg-gate', 'serve', '--port', '0'], 'pkg-gate'],
  [['metrics'], 'metrics'],
  [['hygiene', 'acme'], 'hygiene'],
]
for (const [name, env] of Object.entries(markers)) {
  for (const [args, verb] of spawned) {
    test(`e10f ${name}: ${args.slice(0, 3).join(' ')} is refused and changes nothing`, () => {
      const p = run(args, env, false, seedAll)
      expect(p.exitCode).toBe(1)
      expect(p.stderr.toString()).toContain(`a worker cannot run factory ${verb} (`)
      untouched()
      expect(existsSync(join(dir, 'adopted', '.factory'))).toBe(false)
      expect(existsSync(join(dir, 'up-new'))).toBe(false)
    })
  }
}
test('e10f: allowed verbs still run under FACTORY_FROM', () => {
  const env = { FACTORY_FROM: 'implement' }
  const p = run(['home'], env)
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString().trim()).toBe(home)
  expect(run(['check', join(import.meta.dir, '..', 'factories', 'lifecycle.ts')], env).exitCode).toBe(0)
  expect(run(['rig', 'list'], env).exitCode).toBe(0)
  expect(run(['help'], env).exitCode).toBe(0)
})
