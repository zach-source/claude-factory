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
import * as ax from './ax'

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

const factory = (args: string[], extra: Record<string, string> = {}, stdin?: string) => {
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
    ...(stdin !== undefined && { stdin: new TextEncoder().encode(stdin) }),
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

test('rig refuses a bare value flag but reads a --goal that ends in one (claude-factory-svah)', () => {
  const a = repo('a')
  const bad = factory(['rig', 'add', 'x', a, '--max', '--sweeps', 'none'])
  expect(bad.code).not.toBe(0)
  expect(bad.err).toContain('--max needs a value')
  expect(existsSync(file())).toBe(false)
  expect(factory(['rig', 'add', 'x', a, '--goal', 'ship', '--max']).code).toBe(0)
  expect(JSON.parse(text())[0].goal).toBe('ship --max')
  expect(factory(['rig', 'add', 'x', a, '--max', '2']).code).toBe(0)
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
    [['--cluster-runs', '3'], { clusterRuns: 3 }, []],
    [['--cluster-runs', '9'.repeat(308)], { clusterRuns: Number('9'.repeat(308)) }, []],
    [['--auto-queue', '2,3'], { autoQueue: { minPriority: 2, perHour: 3 } }, []],
    [
      ['--auto-queue', `2,${'9'.repeat(308)}`],
      { autoQueue: { minPriority: 2, perHour: Number('9'.repeat(308)) } },
      [],
    ],
    [
      ['--push-rule', 'run bun test', '--push-rule', 'no force'],
      { pushRules: ['run bun test', 'no force'] },
      [],
    ],
    [
      ['--sensitive-path', 'src/cli.ts', '--sensitive-path', 'mod/'],
      { sensitivePaths: ['src/cli.ts', 'mod/'] },
      [],
    ],
    [['--skills', 'asd-ste100,egm'], { skills: ['asd-ste100', 'egm'] }, []],
    [['--otel-content', 'off'], { otelContent: false }, []],
    [['--sandbox-class', 'microvm'], { sandboxClass: 'microvm' }, []],
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
  const okMcp = join(dir, 'ok-mcp.json')
  writeFileSync(okMcp, '{"mcpServers":{}}')
  const rows: string[][] = [
    ['x', '--push-rule', 'ok', '--push-rule', ''],
    ['x', '--push-rule', 'none', '--push-rule', 'x'],
    ['x', '--push-rule', 'none', '--push-rule', 'none'],
    ['y', '--sandbox-class', 'microvm'],
    ['x', '--path-prefix', '/a/', '--max', '2'],
    ['x', '--port', '1', '--max', '2'],
    ['--cluster-runs', '3', 'x'],
    ['x', '--max', '0'],
    ['x', '--max', 'abc'],
    ['x', '--runner', 'nope'],
    ['x', '--sweeps', 'nope'],
    ['x', '--param', 'nope=1'],
    ['x', '--param', 'base_branch=a b'],
    ['y', '--agent', ' '],
    ['x', '--mcp', okMcp, '--max', '2'],
    ['x', '--mcp', missing],
    ['x', '--mcp', missing, '--max', '2'],
    ['x', '--runner', 'herdr'],
    ['x', '--sweeps', 'monitor'],
    ['nope', '--max', '2'],
    [nonRig, '--max', '2'],
    ['x'],
    ['x', '--slo', 'echo', '--max', '2'],
    ['x', '--drift', 'echo', '--max', '2'],
    ['x', '--egress', 'h.example.com', '--max', '2'],
    ['x', '--person-only-context', 'c', '--max', '2'],
    ['x', '--protected-branch', 'main', '--max', '2'],
    ['x', '--merge-authority', '--max', '2'],
    ['x', '--linear', 'T', '--max', '2'],
    ['x', '--linear-projects', 'p', '--max', '2'],
    ['x', '--linear-labels', 'l', '--max', '2'],
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
  for (const flag of [
    '--cluster-runs',
    '--auto-queue',
    '--push-rule',
    '--sensitive-path',
    '--skills',
    '--otel-content',
    '--sandbox-class',
  ])
    expect(factory(['rig', 'set', 'x']).err).toContain(flag)
})

test.each(
  Object.entries({
    '--cluster-runs': ['0', '1.5', '-1', 'abc', '', '9'.repeat(309)],
    '--auto-queue': ['5,3', '2,0', '2', '2,3,4', 'on', '', `2,${'9'.repeat(309)}`],
    '--push-rule': [' ', ''],
    '--sensitive-path': ['*.ts', '../x', '/abs', '', 'a b', 'a\nb'],
    '--skills': ['nope', 'asd-ste100,', '', 'none,egm'],
    '--otel-content': ['false', 'no', 'OFF', ''],
    '--sandbox-class': ['kata', 'MICROVM', ''],
  }),
)('rig set refuses bad values for %s', (flag, values) => {
  seed()
  refused([
    ...values.map(value => ['set', 'x', flag, value]),
    ['set', 'x', flag],
    ...(flag === '--push-rule' ? [] : [['set', 'x', flag, values[0]!, flag, values[0]!]]),
    ...(flag === '--sensitive-path'
      ? [
          ['set', 'x', flag, 'none', flag, 'x'],
          ['set', 'x', flag, 'none', flag, 'none'],
        ]
      : []),
  ])
  if (flag === '--push-rule')
    expect(factory(['rig', 'set', 'x', flag, ' ']).err).toContain('--push-rule is a non-empty rule text')
  if (flag === '--sensitive-path') {
    const err = factory(['rig', 'set', 'x', flag, '*.ts']).err
    expect(err).toContain('--sensitive-path is a repo path or directory')
    expect(err).toContain('(not "*.ts")')
  }
})

test('rig set clears autoQueue, pushRules, sensitivePaths, skills, otelContent and sandboxClass', () => {
  const fields = {
    autoQueue: { minPriority: 2, perHour: 3 },
    pushRules: ['test'],
    sensitivePaths: ['mod/'],
    skills: ['egm'],
    otelContent: false,
    sandboxClass: 'microvm',
  }
  for (const [flag, value, key] of [
    ['--auto-queue', 'off', 'autoQueue'],
    ['--push-rule', 'none', 'pushRules'],
    ['--sensitive-path', 'none', 'sensitivePaths'],
    ['--skills', 'none', 'skills'],
    ['--otel-content', 'on', 'otelContent'],
    ['--sandbox-class', 'gvisor', 'sandboxClass'],
  ]) {
    const { x, y } = seed(fields)
    const next: Record<string, unknown> = { ...x }
    delete next[key!]
    const r = factory(['rig', 'set', 'x', flag!, value!])
    expect(r).toEqual({ code: 0, err: '', out: `rig x: set ${key}\n` })
    expect(text()).toBe(JSON.stringify([next, y], null, 2))
  }
  seed()
  const before = text()
  expect(factory(['rig', 'set', 'x', '--auto-queue', 'off']).code).toBe(0)
  expect(text()).toBe(before)
  seed({ sandboxClass: 'microvm' }, false)
  refused([['set', 'x', '--runner', 'herdr']])
  expect(factory(['rig', 'set', 'x', '--runner', 'herdr']).err).toContain(
    '--sandbox-class needs the ax runner',
  )
  expect(factory(['rig', 'set', 'y', '--sandbox-class', 'microvm']).err).toContain(
    '--sandbox-class needs the ax runner',
  )
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

test('3wjn AC4 rig show prints every stored key as JSON and hides secrets', () => {
  const { x, rx } = seed({
    goal: `deploy with ${TOK}`,
    env: { MY_TOKEN: 'plain', A: 'b', NOTE: TOK, GITLAB_PAT: 'pat-plain-zq' },
    egress: [{ hosts: ['example.com'], key: 'VAULT_KEY' }],
    params: { base_branch: 'main', API_KEY: 'plain2', note: TOK },
    beadsRemote: { name: 'o', user: 'u', url: 'https://u:pw@example.com/x' },
  })
  const before = text()
  const h = histCount()
  for (const arg of ['x', rx]) {
    const r = factory(['rig', 'show', arg])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(text()).toBe(before)
    expect(histCount()).toBe(h)
    const out = JSON.parse(r.out)
    expect(Object.keys(out)).toEqual(Object.keys(x))
    expect(out.goal).toBe('<hidden>')
    expect(out.env).toEqual({ MY_TOKEN: '<hidden>', A: 'b', NOTE: '<hidden>', GITLAB_PAT: '<hidden>' })
    expect(out.params).toEqual({ base_branch: 'main', API_KEY: '<hidden>', note: '<hidden>' })
    expect(out.beadsRemote.url).toBe('<hidden>')
    expect(out.egress).toEqual((x as { egress: unknown }).egress)
    expect(r.out).toBe(JSON.stringify(out, null, 2) + '\n')
    for (const s of [TOK, 'plain', 'plain2', ':pw@', 'pat-plain-zq']) expect(r.out + r.err).not.toContain(s)
  }
  expect(factory(['rig', 'show', 'nope']).code).toBe(1)
})

const hist = () => join(home, 'rigs-history')
const snaps = () => (existsSync(hist()) ? readdirSync(hist()).sort() : [])
function twoEdits() {
  const a = repo('a')
  factory(['rig', 'add', 'x', a])
  const A = text()
  factory(['rig', 'add', 'x', a, '--max', '2'])
  return { a, A, B: text() }
}

test('rig undo restores the earlier file; a second undo reverses it', () => {
  const { A, B } = twoEdits()
  expect(factory(['rig', 'undo']).code).toBe(0)
  expect(text()).toBe(A)
  expect(factory(['rig', 'undo']).code).toBe(0)
  expect(text()).toBe(B)
})

test('rig undo n restores the nth newest snapshot', () => {
  const { a, A } = twoEdits()
  factory(['rig', 'add', 'x', a, '--max', '3'])
  expect(snaps()).toHaveLength(2)
  expect(factory(['rig', 'undo', '2']).code).toBe(0)
  expect(text()).toBe(A)
})

test('rig history lists the newest 20, newest first', () => {
  const a = repo('a')
  for (let i = 0; i < 22; i++) factory(['rig', 'add', 'x', a, '--max', String(i + 1)])
  const r = factory(['rig', 'history'])
  expect(r.code).toBe(0)
  const lines = r.out.trim().split('\n')
  expect(lines).toHaveLength(20)
  const newest = snaps()
    .at(-1)!
    .replace(/\.json$/, '')
  expect(lines[0]).toBe(`1  ${newest}  1 rigs: x`)
  expect(lines[19]!.startsWith('20  ')).toBe(true)
})

test('rig history caps the list at 20 even when the directory holds more', () => {
  mkdirSync(hist(), { recursive: true })
  for (let i = 0; i < 25; i++) writeFileSync(join(hist(), `2026010${i < 10 ? '0' : ''}${i}.json`), '[]')
  expect(factory(['rig', 'history']).out.trim().split('\n')).toHaveLength(20)
})

test('rig history shows an unparsable snapshot and says so when there is none', () => {
  expect(factory(['rig', 'history'])).toMatchObject({ code: 0, out: 'no rig history\n' })
  mkdirSync(hist(), { recursive: true })
  writeFileSync(join(hist(), '20260101T000000000Z.json'), '[{')
  expect(factory(['rig', 'history']).out).toBe('1  20260101T000000000Z  not valid JSON\n')
})

test('rig undo refuses a bad n or a bad snapshot and changes nothing', () => {
  twoEdits()
  const before = text()
  const n = snaps().length
  for (const x of ['0', '-1', 'abc', '1.5', '21', '3', '1e0', '0x1', '01'])
    expect(factory(['rig', 'undo', x]).code).not.toBe(0)
  const two = '{"name":"x","repo":"/a","factory":"lifecycle"}'
  for (const body of ['[{', '{}', `[${two},${two}]`]) {
    const bad = join(hist(), '99990101T000000000Z.json')
    writeFileSync(bad, body)
    expect(factory(['rig', 'undo']).code).not.toBe(0)
    rmSync(bad)
  }
  expect(text()).toBe(before)
  expect(snaps()).toHaveLength(n)
  expect(existsSync(`${file()}.lock`)).toBe(false)
})

test('rig undo without history is refused', () => {
  const r = factory(['rig', 'undo'])
  expect(r.code).not.toBe(0)
  expect(existsSync(file())).toBe(false)
})

test('a worker cannot run rig undo or rig history', () => {
  const { B } = twoEdits()
  for (const sub of ['undo', 'history']) {
    const p = Bun.spawnSync([CLI, 'rig', sub], {
      env: {
        ...process.env,
        FACTORY_HOME: home,
        FACTORY_RUN: 'r1',
        FACTORY_SELF_UPDATE: '0',
        FACTORY_NO_KICK: '1',
      },
    })
    expect(p.exitCode).not.toBe(0)
  }
  expect(text()).toBe(B)
})

/** run each row and expect exit 1, a message, and rigs.json and its history unchanged */
function refused(rows: string[][], extra: Record<string, string> = {}, stdin?: string) {
  const before = text()
  const h = histCount()
  for (const row of rows) {
    const r = factory(['rig', ...row], extra, stdin)
    expect(r.code, row.join(' ')).toBe(1)
    expect(r.err, row.join(' ')).not.toBe('')
    expect(r.out + r.err, row.join(' ')).not.toContain('zqsecret')
    expect(text(), row.join(' ')).toBe(before)
    expect(histCount(), row.join(' ')).toBe(h)
  }
}

test('rig env set then unset round-trips', () => {
  const { x, y, rx } = seed()
  const before = text()
  for (const arg of ['x', rx]) {
    const r = factory(['rig', 'env', 'set', arg, 'NEW=v=zqsecret'])
    expect(r.code).toBe(0)
    expect(r.out).toBe('rig x: set env NEW\n')
    expect(r.out + r.err).not.toContain('zqsecret')
    expect(text()).toBe(JSON.stringify([{ ...x, env: { A: 'b', NEW: 'v=zqsecret' } }, y], null, 2))
    expect(factory(['rig', 'env', 'unset', arg, 'NEW']).out).toBe('rig x: unset env NEW\n')
    expect(text()).toBe(before)
  }
  factory(['rig', 'env', 'set', 'x', 'A=c'])
  expect(list()[0].env).toEqual({ A: 'c' })
  factory(['rig', 'env', 'set', 'x', 'E='])
  expect(list()[0].env).toEqual({ A: 'c', E: '' })
  factory(['rig', 'env', 'set', 'y', 'K=v'])
  expect(list()[1].env).toEqual({ K: 'v' })
  factory(['rig', 'env', 'unset', 'y', 'K'])
  expect(list()[1]).toEqual(y)
  expect('env' in list()[1]).toBe(false)
})

test('rig env set KEY=- reads the value from stdin; other dash values stay literal', () => {
  const { x, y, rx } = seed()
  for (const arg of ['x', rx]) {
    const r = factory(['rig', 'env', 'set', arg, 'K=-'], {}, 'v=zqsecret\n')
    expect(r.code).toBe(0)
    expect(r.out).toBe('rig x: set env K\n')
    expect(r.out + r.err).not.toContain('zqsecret')
    expect(text()).toBe(JSON.stringify([{ ...x, env: { A: 'b', K: 'v=zqsecret' } }, y], null, 2))
  }
  for (const [stdin, want] of [
    ['a\r\n', 'a'],
    ['a\n\n', 'a\n'],
    ['a', 'a'],
    ['l1\nl2\n', 'l1\nl2'],
  ] as const) {
    factory(['rig', 'env', 'set', 'x', 'K=-'], {}, stdin)
    expect(list()[0].env.K).toBe(want)
  }
  for (const v of ['--', '-x', 'x-']) {
    factory(['rig', 'env', 'set', 'x', `K=${v}`])
    expect(list()[0].env.K).toBe(v)
  }
  factory(['rig', 'env', 'set', 'x', 'K='])
  expect(list()[0].env.K).toBe('')
})

test('rig env set KEY=- refuses empty stdin and a bad command before it reads', () => {
  seed()
  refused([['env', 'set', 'x', 'K=-']], {}, '')
  refused([['env', 'set', 'x', 'K=-']], {}, '\n')
  refused(
    [
      ['env', 'set', 'nope', 'K=-'],
      ['env', 'set', 'x', '1A=-'],
      ['env', 'set', 'x', 'K=-', 'extra'],
    ],
    {},
    'zqsecret',
  )
})

test('rig add and set --param name=- read the value from stdin', () => {
  seed()
  const r = factory(['rig', 'set', 'x', '--param', 'fast_check=-'], {}, 'bunx prettier --check .\n')
  expect(r.code).toBe(0)
  expect(r.out).toBe('rig x: set params\n')
  expect(list()[0].params).toEqual({ base_branch: 'dev', fast_check: 'bunx prettier --check .' })
  const a = factory(['rig', 'add', 'z', repo('z'), '--param', 'fast_check=-'], {}, 'zqsecret\n')
  expect(a.code).toBe(0)
  expect(a.out + a.err).not.toContain('zqsecret')
  expect(list().find((r: { name: string }) => r.name === 'z').params.fast_check).toBe('zqsecret')
})

test('rig --param name=- refuses a second dash, a bad pair, empty stdin; no stdin value in a message', () => {
  seed()
  const two = factory(
    ['rig', 'set', 'x', '--param', 'fast_check=-', '--param', 'base_branch=-'],
    {},
    'zqsecret',
  )
  expect(two.code).toBe(1)
  expect(two.err).toContain('only one value can come from stdin')
  expect(two.err).not.toContain('read no value from stdin')
  const bad = factory(['rig', 'set', 'x', '--param', '-'], {}, 'zqsecret')
  expect(bad.err).toContain('name=value')
  expect(bad.err).not.toContain('only one')
  const bb = factory(['rig', 'set', 'x', '--param', 'base_branch=-'], {}, 'a b zqsecret\n')
  expect(bb.code).toBe(1)
  expect(bb.err).toContain('the stdin value')
  refused(
    [
      ['set', 'x', '--param', 'fast_check=-', '--param', 'base_branch=-'],
      ['set', 'x', '--param', 'fast_check=-', '--param', 'nope=1'],
      ['add', 'z', repo('z'), '--param', 'fast_check=-', '--protected-branch', 'a b'],
      ['set', 'x', '--param', '-'],
      ['set', 'x', '--param', 'nope=-'],
      ['set', 'x', '--param', 'base_branch=-'],
    ],
    {},
    'a b zqsecret\n',
  )
  refused([['set', 'x', '--param', 'fast_check=-']], {}, '')
})

test('rig env refuses a bad pair or key, an unset key and an unknown rig; the file stays', () => {
  seed()
  refused([
    ['env', 'set', 'x', 'NOEQ'],
    ['env', 'set', 'x', '1A=b'],
    ['env', 'set', 'x', 'A-B=zqsecret'],
    ['env', 'set', 'x', '=zqsecret'],
    ['env', 'set', 'x', ' A=zqsecret'],
    ['env', 'set', 'x'],
    ['env', 'set', 'nope', 'A=b'],
    ['env', 'unset', 'x', 'MISSING'],
    ['env', 'unset', 'y', 'A'],
    ['env', 'unset', 'x'],
  ])
})

test('rig egress add then rm returns the list', () => {
  const { x, y } = seed()
  const before = text()
  const spec = 'a.example.com,b.example.com=OPENAI:Authorization:Bearer '
  const r = factory(['rig', 'egress', 'add', 'x', spec, '--port', '8443'])
  expect(r.code).toBe(0)
  const rules = list()[0].egress
  expect(rules).toHaveLength(2)
  expect(rules[1]).toEqual({ ...ax.parseEgress(spec), port: 8443 })
  expect(factory(['rig', 'egress', 'rm', 'x', 'b.example.com,a.example.com']).code).toBe(0)
  expect(text()).toBe(before)
  const three = [
    { hosts: ['a.example.com'] },
    { hosts: ['b.example.com'], port: 1 },
    { hosts: ['c.example.com'] },
  ]
  writeFileSync(file(), JSON.stringify([{ ...x, egress: three }, y], null, 2))
  factory(['rig', 'egress', 'add', 'x', 'd.example.com'])
  expect(factory(['rig', 'egress', 'rm', 'x', 'B.example.com']).code).toBe(0)
  expect(list()[0].egress).toEqual([three[0], three[2], { hosts: ['d.example.com'] }])
  // a rig with no egress: add then rm leaves no key
  const { egress: _, ...bare } = x
  writeFileSync(file(), JSON.stringify([bare, y], null, 2))
  const b = text()
  factory(['rig', 'egress', 'add', 'x', 'h.example.com'])
  expect(list()[0].egress).toHaveLength(1)
  factory(['rig', 'egress', 'rm', 'x', 'h.example.com'])
  expect(text()).toBe(b)
})

test('rig egress add --path-prefix stores the prefixes; rm returns the list', () => {
  seed()
  const before = text()
  const prefixes = ['/v1/aws/acme/', '/v1/aws/acme-b/']
  const r = factory([
    'rig',
    'egress',
    'add',
    'x',
    'broker.example.com=AWS_BROKER:Authorization:',
    '--port',
    '8443',
    ...prefixes.flatMap(p => ['--path-prefix', p]),
  ])
  expect(r).toMatchObject({ code: 0, err: '' })
  expect(list()[0].egress[1]).toEqual({
    hosts: ['broker.example.com'],
    key: 'AWS_BROKER',
    header: 'Authorization',
    prefix: '',
    port: 8443,
    pathPrefixes: prefixes,
  })
  expect(factory(['rig', 'egress', 'rm', 'x', 'broker.example.com']).code).toBe(0)
  expect(text()).toBe(before)
  expect(
    factory([
      'rig',
      'egress',
      'add',
      'x',
      'results-receiver.actions.githubusercontent.com',
      '--path-prefix',
      '/actions-results/',
    ]).code,
  ).toBe(0)
  expect(list()[0].egress[1]).toEqual({
    hosts: ['results-receiver.actions.githubusercontent.com'],
    pathPrefixes: ['/actions-results/'],
  })
})

test('rig egress refuses unsafe path prefixes and flags outside their scope', () => {
  seed()
  refused([
    ...[
      'a/',
      '/',
      '',
      '/v1/aws/acme',
      '/a//b/',
      '/a/../b/',
      '/.git/',
      '/a b/',
      '/a?x',
      '/a%2F',
      '/a*',
      '/ax_auth/',
      '/github-reviewer/',
      '/GitHub_Reviewer/',
    ].map(p => ['egress', 'add', 'x', 'h.example.com', '--path-prefix', p]),
    ...['api.github.com', 'GitHub.com'].map(h => ['egress', 'add', 'x', h, '--path-prefix', '/a/']),
    ['egress', 'add', 'x', 'h.example.com', '--path-prefix', '/a/', '--path-prefix', '/a/'],
    ['egress', 'add', 'x', 'h.example.com', '--path-prefix'],
    ['egress', 'rm', 'x', 'example.com', '--path-prefix', '/a/'],
    ['env', 'set', 'x', 'A=b', '--path-prefix', '/a/'],
    ['beads-remote', 'clear', 'x', '--path-prefix', '/a/'],
    ['env', 'set', 'x', 'A=b', '--cluster-runs', '3'],
    ['egress', 'add', 'x', 'h.example.com', '--skills', 'egm'],
  ])
  expect(factory(['rig', 'egress', 'add', 'x']).err).toContain('--path-prefix')
})

test('rig egress add on a local runner is refused', () => {
  seed()
  const before = text()
  const r = factory(['rig', 'egress', 'add', 'y', 'h.example.com'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('runner with an egress policy')
  expect(text()).toBe(before)
})

test('rig egress refuses a bad host, key, port, duplicate, no match or a two-rule match', () => {
  const { x, y } = seed()
  refused([
    ['egress', 'add', 'x', 'bad_host'],
    ['egress', 'add', 'x', 'h.example.com=lower'],
    ['egress', 'add', 'x', 'h.example.com=K:bad header'],
    ['egress', 'add', 'x', 'h.example.com', '--port', '0'],
    ['egress', 'add', 'x', 'h.example.com', '--port', '65536'],
    ['egress', 'add', 'x', 'h.example.com', '--port', 'x'],
    ['egress', 'add', 'x', 'example.com'],
    ['egress', 'add', 'x', 'EXAMPLE.com=K'],
    ['egress', 'add', 'x'],
    ['egress', 'rm', 'x', 'nothere.example.com'],
    ['egress', 'rm', 'x', 'example.com=K'],
    ['egress', 'rm', 'x'],
    ['egress', 'rm', 'y', 'example.com'],
  ])
  expect(factory(['rig', 'egress', 'add', 'x', 'example.com,c.example.com']).code).toBe(0)
  const twice = [{ hosts: ['a.example.com'] }, { hosts: ['a.example.com'], port: 9 }]
  writeFileSync(file(), JSON.stringify([{ ...x, egress: twice }, y], null, 2))
  refused([['egress', 'rm', 'x', 'a.example.com']])
  expect(factory(['rig', 'egress', 'rm', 'x', 'a.example.com']).err).toContain('2 egress rules')
})

test('rig beads-remote set and clear', () => {
  const { x, y } = seed()
  const before = text()
  const set = ['--name', 'origin2', '--url', 'https://dolt.example.com/db/zqsecret', '--user', 'bot']
  const r = factory(['rig', 'beads-remote', 'set', 'y', ...set])
  expect(r.code).toBe(0)
  expect(r.out).toBe('rig y: set beadsRemote origin2\n')
  expect(r.out + r.err).not.toContain('zqsecret')
  expect(Object.keys(list()[1].beadsRemote)).toEqual(['name', 'url', 'user'])
  expect(factory(['rig', 'beads-remote', 'clear', 'y']).code).toBe(0)
  expect(text()).toBe(before)
  expect(factory(['rig', 'beads-remote', 'set', 'x', ...set]).code).toBe(0)
  const next = { ...x, beadsRemote: { name: 'origin2', url: set[3], user: 'bot' } }
  expect(text()).toBe(JSON.stringify([next, y], null, 2))
})

test('rig beads-remote refuses a bad name, user or url, a missing flag and a clear of nothing', () => {
  seed()
  const ok = ['--name', 'o', '--url', 'https://e.example.com', '--user', 'u']
  const with_ = (flag: string, v: string) => ok.map((a, i) => (ok[i - 1] === flag ? v : a))
  refused([
    ['beads-remote', 'set', 'y', ...with_('--name', 'a b')],
    ['beads-remote', 'set', 'y', ...with_('--name', "a'b")],
    ['beads-remote', 'set', 'y', ...with_('--user', 'u;x')],
    ['beads-remote', 'set', 'y', ...with_('--user', '')],
    ['beads-remote', 'set', 'y', ...with_('--url', 'not a url zqsecret')],
    ['beads-remote', 'set', 'y', ...ok.slice(2)],
    ['beads-remote', 'set', 'y', ...ok.slice(0, 2), ...ok.slice(4)],
    ['beads-remote', 'set', 'y', ...ok.slice(0, 4)],
    ['beads-remote', 'clear', 'y'],
    ['beads-remote', 'set', 'nope', ...ok],
  ])
})

test('a worker or a patrol cannot run rig env, egress or beads-remote', () => {
  seed()
  const cmds = [
    ['env', 'set', 'x', 'A=c'],
    ['env', 'unset', 'x', 'A'],
    ['egress', 'add', 'x', 'h.example.com'],
    ['egress', 'rm', 'x', 'example.com'],
    ['beads-remote', 'set', 'x', '--name', 'o', '--url', 'https://e.example.com', '--user', 'u'],
    ['beads-remote', 'clear', 'x'],
  ]
  const whos: Record<string, string>[] = [
    { FACTORY_RUN: 'r1', FACTORY_FROM: 'r1/implement' },
    { FACTORY_PATROL: '1' },
  ]
  for (const who of whos) {
    refused(cmds, who)
    for (const c of cmds) expect(factory(['rig', ...c], who).err).toContain(`cannot run factory rig ${c[0]}`)
  }
})

test('rig env, egress and beads-remote take only their own words and flags', () => {
  seed()
  const ok = ['--name', 'o', '--url', 'https://e.example.com', '--user', 'u']
  refused([
    ['env', 'put', 'x', 'A=b'],
    ['env', 'set', 'x', 'A=b', 'extra'],
    ['env', 'set', 'x', 'A=b', '--max', '2'],
    ['env', 'set', 'x', 'A=b', '--goal', 'g'],
    ['env', 'set', 'x', 'A=b', '--egress', 'h.example.com'],
    ['env', 'set', 'x', 'A=b', '--runner', 'herdr'],
    ['env', 'set', 'x', 'A=b', '--port', '1'],
    ['env', 'set', 'x', 'A=b', '--name', 'o'],
    ['env', 'unset', 'x', 'A', '--merge-authority'],
    ['egress', 'push', 'x', 'h.example.com'],
    ['egress', 'add', 'x', 'h.example.com', 'extra'],
    ['egress', 'add', 'x', 'h.example.com', '--param', 'a=b'],
    ['egress', 'rm', 'x', 'example.com', '--port', '1'],
    ['egress', 'add', 'x', 'h.example.com', '--user', 'u'],
    ['beads-remote', 'push', 'x', ...ok],
    ['beads-remote', 'set', 'x', ...ok, 'extra'],
    ['beads-remote', 'set', 'x', ...ok, '--max', '2'],
    ['beads-remote', 'set', 'x', ...ok, '--port', '1'],
    ['beads-remote', 'clear', 'x', 'extra'],
    ['beads-remote', 'clear', 'x', '--name', 'o'],
    ['beads-remote'],
  ])
  expect(factory(['rig', 'env', 'set', 'x']).err).toContain('usage: factory rig env set')
  expect(factory(['rig', 'bogus']).err).toContain('env, egress, beads-remote')
})
