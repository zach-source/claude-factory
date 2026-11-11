// claude-factory-jho3: `factory mail --text-file` and `factory memory add --body-file` read untrusted text from a
// file, so no quote in the text reaches a shell. A VM expands them before it queues. Fixtures use acme names only.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { replayable } from './cli'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `text-file-flags-${process.pid}`)
const home = join(dir, 'home')
const wt = join(dir, 'wt')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}, cwd?: string) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_NO_KICK: '1',
      ...env,
    },
    cwd,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

function makeRun(id: string) {
  const d = join(home, 'runs', id)
  mkdirSync(wt, { recursive: true })
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: file, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
  return () =>
    readFileSync(join(d, 'inbox.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
}

/** a file in home/text/ */
function txt(name: string, body: string | Buffer) {
  const p = join(home, 'text', name)
  mkdirSync(join(home, 'text'), { recursive: true })
  writeFileSync(p, body)
  return p
}

/** every bad file the two flags must refuse: name -> path */
function badFiles(): Record<string, string> {
  mkdirSync(join(home, 'text', 'adir'), { recursive: true })
  writeFileSync(join(dir, 'outside.txt'), 'secret')
  mkdirSync(join(wt, '.scratch'), { recursive: true })
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  symlinkSync(join(dir, 'outside.txt'), join(wt, '.scratch', 'link.txt'))
  writeFileSync(join(home, 'rigs.json'), '[]')
  return {
    missing: join(home, 'text', 'nope.txt'),
    directory: join(home, 'text', 'adir'),
    empty: txt('empty.txt', ''),
    whitespace: txt('ws.txt', ' \n\t\n'),
    'over cap': txt('big.txt', Buffer.alloc(100 * 1024 + 1, 'a')),
    'outside both roots': join(home, 'rigs.json'),
    'symlink out of .scratch': join(wt, '.scratch', 'link.txt'),
  }
}

const TEXT = 'x\'; id; \' and $(id) and `id` and "q"\n'

test('mail --text-file mails the file text as written; a flag inside a longer word stays text (AC1)', () => {
  const events = makeRun('r1')
  mkdirSync(join(wt, '.scratch'), { recursive: true })
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  const f = join(wt, '.scratch', 'm.md')
  writeFileSync(f, TEXT)
  expect(factory(['mail', 'r1', 'manager', '--text-file', f], {}, wt).code).toBe(0)
  expect(events().at(-1).text).toBe(TEXT.trimEnd())
  const w = factory(['mail', 'r1', 'manager', '--wake', '--text-file', f], {}, wt)
  expect(w.code).toBe(0)
  expect(events().at(-1)).toMatchObject({ text: TEXT.trimEnd(), wake: true })
  expect(factory(['mail', 'r1', 'manager', 'use --text-file <path>']).code).toBe(0)
  expect(events().at(-1).text).toBe('use --text-file <path>')
  expect(existsSync(join(wt, 'pwned'))).toBe(false)
})

test('mail --text-file refuses a file in a .scratch/ that is a symlink to an outside folder (jho3.13)', () => {
  const events = makeRun('r1s')
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  const out = join(dir, 'outdir')
  mkdirSync(out)
  writeFileSync(join(out, 'x.txt'), 'secret')
  symlinkSync(out, join(wt, '.scratch'))
  const r = factory(['mail', 'r1s', 'manager', '--text-file', join(wt, '.scratch', 'x.txt')], {}, wt)
  expect(r.code).toBe(1)
  expect(r.err).toContain('is outside')
  expect(events()).toHaveLength(0)
})

test('mail --text-file refuses a bad form with exit 1 and posts nothing (AC1)', () => {
  const events = makeRun('r2')
  const bad = badFiles()
  const ok = txt('ok.txt', 'ok')
  const forms: Record<string, string[]> = {
    'no path': ['--text-file'],
    'extra word': ['--text-file', ok, 'extra'],
    'extra word after wake': ['--wake', '--text-file', ok, 'extra'],
    'flag after a word': ['hello', '--text-file', 'x'],
    'flag after a word and wake': ['--wake', 'hello', '--text-file', 'x'],
    ...Object.fromEntries(Object.entries(bad).map(([k, p]) => [k, ['--text-file', p]])),
  }
  for (const [name, rest] of Object.entries(forms)) {
    const r = factory(['mail', 'r2', 'manager', ...rest], {}, wt)
    expect([name, r.code]).toEqual([name, 1])
    expect(r.err).toContain('--text-file')
  }
  expect(events().filter(e => e.type === 'MAIL')).toHaveLength(0)
})

const ADD = ['memory', 'add', '--kind', 'fact']
const notes = () =>
  existsSync(join(home, 'memory', 'inbox'))
    ? readdirSync(join(home, 'memory', 'inbox')).map(n =>
        readFileSync(join(home, 'memory', 'inbox', n), 'utf8'),
      )
    : []

test('memory add --body-file stores the file text as the body (AC2)', () => {
  mkdirSync(home, { recursive: true })
  const f = txt('b.md', TEXT)
  const r = factory([...ADD, '--body-file', f, 'a plain summary'])
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(notes().join('')).toContain(TEXT.trimEnd())
  // the flag may come before the other flags
  expect(factory([...ADD.slice(0, 2), '--body-file', f, '--kind', 'rule', 'another summary']).code).toBe(0)
})

test('memory add --body-file refuses a bad form with exit 2 and writes nothing (AC2)', () => {
  mkdirSync(home, { recursive: true })
  const bad = badFiles()
  const ok = txt('ok.txt', 'ok')
  const forms: Record<string, string[]> = {
    'no value': ['s', '--body-file'],
    'flag as value': ['--body-file', '--anyway', 's'],
    repeated: ['--body-file', ok, '--body-file', ok, 's'],
    'with body words': ['--body-file', ok, 's', 'body', 'words'],
    ...Object.fromEntries(Object.entries(bad).map(([k, p]) => [k, ['--body-file', p, 's']])),
  }
  for (const [name, rest] of Object.entries(forms)) {
    const r = factory([...ADD, ...rest], {}, wt)
    expect([name, r.code]).toEqual([name, 2])
  }
  expect(notes()).toEqual([])
})

const side = { node: 'a', seq: 1 }

test('an argv that still holds --text-file in its slot or --body-file is not replayable (AC4)', () => {
  expect(replayable(['mail', 'r1', 'manager', '--text-file', '/x'], side, 'r1')).toBeNull()
  expect(replayable(['mail', 'r1', 'manager', '--wake', '--text-file', '/x'], side, 'r1')).toBeNull()
  const later = ['mail', 'r1', 'manager', 'hello', '--text-file', 'x']
  expect(replayable(later, side, 'r1')).toEqual(later)
  expect(replayable(['memory', 'add', '--body-file', '/x', 's'], side, 'r1')).toBeNull()
  expect(replayable(['memory', 'add', 's', '--body-file', '/x'], side, 'r1')).toBeNull()
})

test('inside a VM, mail --text-file and memory add --body-file queue the text, never the path (AC4)', () => {
  mkdirSync(home, { recursive: true })
  const outbox = join(dir, 'outbox.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  const f = txt('vm.md', TEXT)
  expect(factory(['mail', 'r1', 'manager', '--text-file', f], env).code).toBe(0)
  expect(factory([...ADD, '--body-file', f, 'a plain summary'], env).code).toBe(0)
  const argv = readFileSync(outbox, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l).argv)
  expect(argv).toEqual([
    ['mail', 'r1', 'manager', TEXT.trimEnd()],
    ['memory', 'add', '--kind', 'fact', 'a plain summary', TEXT.trimEnd()],
  ])
})

test('inside a VM, a bad file queues nothing: exit 1 for mail, 2 for memory add (AC4)', () => {
  mkdirSync(home, { recursive: true })
  const outbox = join(dir, 'outbox-bad.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  const bad = badFiles()
  for (const [name, p] of Object.entries(bad)) {
    expect([name, factory(['mail', 'r1', 'manager', '--text-file', p], env, wt).code]).toEqual([name, 1])
    expect([name, factory([...ADD, '--body-file', p, 's'], env, wt).code]).toEqual([name, 2])
  }
  expect(factory(['mail', 'r1', 'manager', '--text-file', txt('ok.txt', 'ok'), 'extra'], env).code).toBe(1)
  expect(existsSync(outbox)).toBe(false)
})

test('9ydy AC2/AC3: mail refuses a word that starts with --text-file=; a longer word stays text', () => {
  const events = makeRun('r9')
  for (const rest of [
    ['--text-file=/x/ok.md'],
    ['--text-file='],
    ['--wake', '--text-file=/x/ok.md'],
    ['--wake', '--text-file='],
    ['hello', '--text-file=/x/ok.md'],
    ['--wake', 'hello', '--text-file='],
  ]) {
    const r = factory(['mail', 'r9', 'manager', ...rest], {}, wt)
    expect([rest, r.code]).toEqual([rest, 1])
    expect(r.err).toContain('usage: factory mail')
  }
  expect(events().filter(e => e.type === 'MAIL')).toHaveLength(0)
  for (const t of ['x--text-file=y', 'use --text-file=y']) {
    expect(factory(['mail', 'r9', 'manager', t]).code).toBe(0)
    expect(events().at(-1).text).toBe(t)
  }
})

test('9ydy AC3: memory add refuses --body-file= with exit 2 and writes nothing', () => {
  mkdirSync(home, { recursive: true })
  const f = txt('eq.md', 'body')
  expect(factory([...ADD, `--body-file=${f}`, 's'], {}, wt).code).toBe(2)
  expect(notes()).toEqual([])
})

test('9ydy AC4: inside a VM, equals-form flags queue nothing', () => {
  mkdirSync(home, { recursive: true })
  const outbox = join(dir, 'outbox-eq.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  const f = txt('eq.md', 'body')
  expect(factory(['mail', 'r1', 'manager', `--text-file=${f}`], env, wt).code).toBe(1)
  expect(factory(['report', 'r1', '1', 'ready', `--summary-file=${f}`], env, wt).code).toBe(1)
  expect(factory([...ADD, `--body-file=${f}`, 's'], env, wt).code).toBe(2)
  expect(existsSync(outbox)).toBe(false)
})
