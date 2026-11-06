import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `rigs-edit-cli-${process.pid}`)
const home = join(dir, 'home')
const herdr = join(dir, 'herdr')
const file = () => join(home, 'rigs.json')
const text = () => readFileSync(file(), 'utf8')
const jsonError = (s: string) => {
  try {
    JSON.parse(s)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('text parses')
}
const names = () => JSON.parse(text()).map((r: { name: string }) => r.name)

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(herdr, '#!/bin/sh\nexit 1\n')
  chmodSync(herdr, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], extra: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...rest } = process.env
  const laptop = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('HERDR_')))
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_NO_KICK: '1',
      FACTORY_SELF_UPDATE: '0',
      FACTORY_HERDR: herdr,
      ...extra,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
function repo(name: string) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  return r
}

test('rig add writes the list, replaces a rig by name and refuses a second name for one repo', () => {
  const a = repo('a')
  expect(factory(['rig', 'add', 'x', a]).code).toBe(0)
  expect(text()).toBe(JSON.stringify(JSON.parse(text()), null, 2))
  expect(names()).toEqual(['x'])
  expect(factory(['rig', 'add', 'x', a, '--max', '2']).code).toBe(0)
  expect(names()).toEqual(['x'])
  expect(JSON.parse(text())[0].maxRuns).toBe(2)
  const before = text()
  const dup = factory(['rig', 'add', 'y', a])
  expect(dup.code).not.toBe(0)
  expect(dup.err).toContain('is already rig x')
  expect(text()).toBe(before)
  expect(factory(['rig', 'add', 'z', repo('b')]).code).toBe(0)
  expect(names()).toEqual(['x', 'z'])
})

test('rig rm removes a rig and refuses an unknown name', () => {
  factory(['rig', 'add', 'x', repo('a')])
  factory(['rig', 'add', 'y', repo('b')])
  const rm = factory(['rig', 'rm', 'x'])
  expect(rm.code).toBe(0)
  expect(rm.out).toContain('removed rig x')
  const before = text()
  const bad = factory(['rig', 'rm', 'nope'])
  expect(bad.code).not.toBe(0)
  expect(bad.err).toContain('no rig "nope" (rigs: y)')
  expect(text()).toBe(before)
})

test('an invalid rig file refuses rig add and rig rm, naming the file; the history keeps the old text', () => {
  const a = repo('a')
  factory(['rig', 'add', 'x', a])
  const first = text()
  factory(['rig', 'add', 'x', a, '--max', '3'])
  const hist = join(home, 'rigs-history')
  expect(readdirSync(hist)).toHaveLength(1)
  expect(readFileSync(join(hist, readdirSync(hist)[0]!), 'utf8')).toBe(first)
  writeFileSync(file(), '[{')
  for (const args of [
    ['rig', 'add', 'q', repo('c')],
    ['rig', 'rm', 'x'],
  ]) {
    const r = factory(args)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(file())
    expect(r.err).toContain(`not valid JSON (${jsonError('[{')})`)
  }
  expect(text()).toBe('[{')
  expect(existsSync(`${file()}.lock`)).toBe(false)
})

const TOK = 'ghp_' + 'z'.repeat(36)
const list = () => JSON.parse(text())
const histCount = () =>
  existsSync(join(home, 'rigs-history')) ? readdirSync(join(home, 'rigs-history')).length : 0
/** rig x (ax, with every kind of field and an unknown key) and rig y; returns both and x's repo path */
function seed(over: Record<string, unknown> = {}, egress = true) {
  const rx = realpathSync(repo('x'))
  const x = {
    name: 'x',
    repo: rx,
    factory: 'lifecycle',
    goal: 'old goal',
    maxRuns: 2,
    sweeps: ['drift'],
    drift: 'echo d',
    runner: 'ax',
    ...(egress && { egress: [{ hosts: ['example.com'] }] }),
    env: { A: 'b' },
    beadsRemote: { name: 'o', user: 'u', url: 'https://example.com/x' },
    personOnlyContexts: ['ctx'],
    mergeAuthority: true,
    params: { base_branch: 'dev' },
    unknownKey: { keep: 1 },
    ...over,
  }
  const y = { name: 'y', repo: realpathSync(repo('y')), factory: 'lifecycle' }
  writeFileSync(file(), JSON.stringify([x, y], null, 2))
  return { x, y, rx }
}

test('rig set changes one field and leaves every other byte equal (by name and by path)', () => {
  const rows: [string[], Record<string, unknown>, string[]][] = [
    [['--goal', 'new', 'words'], { goal: 'new words' }, []],
    [['--max', '3'], { maxRuns: 3 }, []],
    [['--sweeps', 'none'], { sweeps: [] }, []],
    [['--agent', 'claude'], { agent: 'claude' }, []],
    [['--param', 'base_branch=main'], { params: { base_branch: 'main' } }, []],
    [['--runner', 'herdr'], {}, ['runner']],
  ]
  for (const [flags, set, unset] of rows) {
    for (const byPath of [false, true]) {
      const { x, y, rx } = seed({}, flags[0] !== '--runner')
      const r = factory(['rig', 'set', byPath ? rx : 'x', ...flags])
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      const next: Record<string, unknown> = { ...x, ...set }
      for (const k of unset) delete next[k]
      expect(text()).toBe(JSON.stringify([next, y], null, 2))
      expect(r.out).toBe(`rig x: set ${[...Object.keys(set), ...unset].join(',')}\n`)
    }
  }
})

test('rig set refuses a bad value, an unknown rig and a foreign flag; the file and history stay', () => {
  seed()
  const nonRig = realpathSync(repo('z'))
  const missing = join(dir, 'missing.json')
  const rows: string[][] = [
    ['x', '--max', '0'],
    ['x', '--max', 'abc'],
    ['x', '--runner', 'nope'],
    ['x', '--sweeps', 'nope'],
    ['x', '--param', 'nope=1'],
    ['x', '--param', 'base_branch=a b'],
    ['x', '--agent', ' '],
    ['x', '--mcp', missing],
    ['x', '--mcp', missing, '--max', '2'],
    ['x', '--runner', 'herdr'],
    ['x', '--sweeps', 'monitor'],
    ['nope', '--max', '2'],
    [nonRig, '--max', '2'],
    ['x'],
    ['x', '--slo', 'echo'],
    ['x', '--drift', 'echo'],
    ['x', '--egress', 'h.example.com'],
    ['x', '--person-only-context', 'c'],
    ['x', '--protected-branch', 'main'],
    ['x', '--merge-authority'],
    ['x', '--linear', 'T'],
    ['x', '--linear-projects', 'p'],
    ['x', '--linear-labels', 'l'],
    ['x', 'extra', '--max', '2'],
  ]
  const before = text()
  for (const row of rows) {
    const r = factory(['rig', 'set', ...row])
    expect(r.code, row.join(' ')).toBe(1)
    expect(r.err, row.join(' ')).not.toBe('')
    expect(text(), row.join(' ')).toBe(before)
    expect(histCount(), row.join(' ')).toBe(0)
  }
  expect(factory(['rig', 'set', 'x']).err).toContain('usage: factory rig set')
})

test('a worker or a patrol cannot run rig set, but can run rig show', () => {
  seed()
  const worker = { FACTORY_RUN: 'r1', FACTORY_FROM: 'r1/implement' }
  const set = factory(['rig', 'set', 'x', '--max', '3'], worker)
  expect(set.code).toBe(1)
  expect(set.err).toContain('a worker cannot run factory rig set')
  const patrol = factory(['rig', 'set', 'x', '--max', '3'], { FACTORY_PATROL: '1' })
  expect(patrol.code).toBe(1)
  expect(patrol.err).toContain('a patrol cannot run factory rig set')
  expect(list()[0].maxRuns).toBe(2)
  for (const env of [worker, { FACTORY_PATROL: '1' }]) {
    const show = factory(['rig', 'show', 'x'], env)
    expect(show.err).toBe('')
    expect(show.code).toBe(0)
  }
  for (const sub of ['rm', 'add'])
    expect(factory(['rig', sub, 'x', repo('q')], worker).err).toContain(
      `a worker cannot run factory rig ${sub}`,
    )
})

test('rig show prints every stored key as JSON and hides secrets', () => {
  const { x, rx } = seed({
    goal: `deploy with ${TOK}`,
    env: { MY_TOKEN: 'plain', A: 'b' },
    params: { base_branch: 'main', API_KEY: 'plain2' },
    beadsRemote: { name: 'o', user: 'u', url: 'https://u:pw@example.com/x' },
  })
  for (const arg of ['x', rx]) {
    const r = factory(['rig', 'show', arg])
    expect(r.code).toBe(0)
    const out = JSON.parse(r.out)
    expect(Object.keys(out)).toEqual(Object.keys(x))
    expect(out.goal).toBe('<hidden>')
    expect(out.env).toEqual({ MY_TOKEN: '<hidden>', A: 'b' })
    expect(out.params).toEqual({ base_branch: 'main', API_KEY: '<hidden>' })
    expect(out.beadsRemote.url).toBe('<hidden>')
    expect(out.egress).toEqual((x as { egress: unknown }).egress)
    expect(r.out).toBe(JSON.stringify(out, null, 2) + '\n')
    for (const s of [TOK, 'plain', 'plain2', ':pw@']) expect(r.out + r.err).not.toContain(s)
  }
  expect(factory(['rig', 'show', 'nope']).code).toBe(1)
})
