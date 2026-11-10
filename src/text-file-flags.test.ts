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

test('0s5e legacy inline mail retains separators locally and after worker replay', () => {
  const events = makeRun('r1')
  for (const wake of [[], ['--wake']]) {
    const argv = ['mail', 'r1', 'manager', ...wake, '--', 'literal']
    expect(factory(argv).code).toBe(0)
    expect(events().at(-1).text).toBe('-- literal')
    const outbox = join(dir, `outbox-${wake.length}.jsonl`)
    expect(factory(argv, { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'implement' }).code).toBe(0)
    const record = JSON.parse(readFileSync(outbox, 'utf8'))
    expect(record).not.toHaveProperty('mailFile')
    const queued = record.argv
    expect(replayable(queued, side, 'r1')).toEqual(argv)
    expect(factory(queued).code).toBe(0)
    expect(events().at(-1).text).toBe('-- literal')
  }
})

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
  const r = factory([...ADD, '--anyway', '--body-file', f, 'a plain summary'])
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(notes().join('')).toContain(TEXT.trimEnd())
  // the flag may come before the other flags
  expect(
    factory([...ADD.slice(0, 2), '--anyway', '--body-file', f, '--kind', 'rule', 'another summary']).code,
  ).toBe(0)
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

test('0s5e file fields preserve text: poke and mail do not parse payload options', () => {
  const events = makeRun('literal')
  for (const text of [TEXT, '--', '--wake', '--text-file', '--owned']) {
    const path = txt('literal.md', text)
    for (const command of [
      ['poke', 'literal'],
      ['mail', 'literal', 'manager'],
    ]) {
      const before = events().length
      const r = factory([...command, '--text-file', path], {}, dir)
      expect(r.code, r.err).toBe(0)
      expect(events()).toHaveLength(before + 1)
      expect(events().at(-1).text).toBe(text.trimEnd())
      expect(events().at(-1).wake).not.toBe(true)
    }
  }
})

test('0s5e file fields preserve text: memory files expand before the worker queue', () => {
  const summary = txt('summary.md', "A literal summary with an apostrophe: it's safe")
  const body = txt('body.md', TEXT)
  const outbox = join(dir, 'outbox.jsonl')
  const r = factory([...ADD, '--summary-file', summary, '--body-file', body], {
    FACTORY_OUTBOX: outbox,
    FACTORY_FROM: 'implement',
  })
  expect(r.code, r.err).toBe(0)
  expect(JSON.parse(readFileSync(outbox, 'utf8')).argv).toEqual([
    ...ADD,
    readFileSync(summary, 'utf8'),
    TEXT.trimEnd(),
  ])
})

test('0s5e remote text is data: unresolved summary files and manager verbs cannot replay', () => {
  expect(replayable(['memory', 'add', '--summary-file', '/x'], side, 'r1')).toBeNull()
  for (const cmd of ['poke', 'fork', 'start', 'rig', 'skills'])
    expect(replayable([cmd, 'r1', '--text-file', '/x'], side, 'r1')).toBeNull()
})

const consumers = (path: string) => [
  ['poke', 'r1', '--text-file', path],
  ['fork', 'r1', 'implement', '--note-file', path],
  ['start', 'lifecycle', wt, '--goal-file', path],
  [...ADD, '--summary-file', path],
  [...ADD, 'summary', '--body-file', path],
  ['memory', 'search', '--query-file', path],
  ['skills', 'reject', 'acme', '--reason-file', path],
  ['rig', 'add', 'acme', wt, '--goal-file', path],
  ['rig', 'set', 'acme', '--goal-file', path],
]

test('0s5e file fields preserve text: rig goals and skill reasons are literal', () => {
  mkdirSync(join(wt, '.beads'), { recursive: true })
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  const path = txt('goal.md', TEXT)
  const rigs = join(home, 'rigs.json')
  for (const verb of ['add', 'set']) {
    const argv = verb === 'add' ? ['rig', verb, 'acme', wt] : ['rig', verb, 'acme']
    const r = factory([...argv, '--goal-file', path])
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(readFileSync(rigs, 'utf8'))[0].goal).toBe(TEXT.trimEnd())
  }
  const repeated = factory([
    'rig',
    'add',
    'acme',
    wt,
    '--goal-file',
    path,
    '--runner',
    'ax',
    '--max',
    '2',
    '--egress',
    'one.example',
    '--egress',
    'two.example',
  ])
  expect(repeated.code, repeated.err).toBe(0)
  expect(JSON.parse(readFileSync(rigs, 'utf8'))[0]).toMatchObject({
    goal: TEXT.trimEnd(),
    runner: 'ax',
    maxRuns: 2,
    egress: [{ hosts: ['one.example'] }, { hosts: ['two.example'] }],
  })
  const proposal = join(home, 'memory', '.manager', 'skills', 'acme')
  mkdirSync(proposal, { recursive: true })
  writeFileSync(join(proposal, 'SKILL.md'), '# Acme\n')
  const r = factory(['skills', 'reject', 'acme', '--reason-file', path])
  expect(r.code, r.err).toBe(0)
  expect(notes().join('')).toContain(TEXT.trimEnd())
  expect(existsSync(proposal)).toBe(false)
})

test('0s5e file fields preserve text: memory summary and body select their sources independently', () => {
  const summary = 'A literal summary'
  const s = txt('s.md', summary)
  const b = txt('b.md', TEXT)
  for (const fields of [
    ['--summary-file', s],
    ['--summary-file', s, TEXT],
    ['--summary-file', s, '--body-file', b],
    [summary, '--body-file', b],
  ]) {
    const r = factory([...ADD, '--anyway', ...fields])
    expect(r.code, r.err).toBe(0)
  }
  expect(notes()).toHaveLength(4)
  expect(notes().filter(n => n.includes(TEXT.trimEnd()))).toHaveLength(3)
})

test('0s5e file fields preserve text: memory query cannot supply options or another file', () => {
  const query = txt('query.md', TEXT)
  const calls = join(home, 'queries.jsonl')
  const preload = join(home, 'query-spy.ts')
  const module = join(import.meta.dir, 'memory.ts')
  writeFileSync(
    preload,
    `import { mock } from 'bun:test'
import { appendFileSync } from 'node:fs'
const real = await import(${JSON.stringify(module)})
mock.module(${JSON.stringify(module)}, () => ({ ...real, search: async (...args) => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n'); return []
}}))
`,
  )
  for (const text of [TEXT, '--rig', '--query-file']) {
    writeFileSync(query, text)
    const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...base } = process.env
    const p = Bun.spawnSync(
      [
        process.execPath,
        '--preload',
        preload,
        join(import.meta.dir, 'cli.ts'),
        'memory',
        'search',
        '--rig',
        'acme',
        '--query-file',
        query,
      ],
      {
        env: { ...base, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
      },
    )
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    const rows = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(rows.at(-1)).toEqual([join(home, 'memory'), text.trimEnd(), { rig: 'acme', core: true }])
  }
})

test('0s5e remote text is data: server mail reads only the caller file', async () => {
  const bodies: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      bodies.push(await req.json())
      return Response.json({ code: 0, out: '', err: '' })
    },
  })
  try {
    for (const text of [TEXT, '--', '--wake', '--text-file', '--owned']) {
      const path = txt('remote.md', text)
      const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...base } =
        process.env
      for (const wake of [[], ['--wake']]) {
        const p = Bun.spawn([CLI, 'mail', 'r1', 'manager', ...wake, '--text-file', path], {
          env: { ...base, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_SERVER: server.url.origin },
        })
        expect(await p.exited).toBe(0)
        expect(bodies.at(-1)).toMatchObject({ text: text.trimEnd(), to: 'manager' })
        expect((bodies.at(-1) as Record<string, unknown>).wake).toBe(wake.length ? true : undefined)
      }
    }
    for (const wake of [[], ['--wake']]) {
      const p = Bun.spawn([CLI, 'mail', 'r1', 'manager', ...wake, '--', 'literal'], {
        env: {
          PATH: process.env.PATH,
          FACTORY_HOME: home,
          FACTORY_SELF_UPDATE: '0',
          FACTORY_SERVER: server.url.origin,
        },
      })
      expect(await p.exited).toBe(0)
      expect(bodies.at(-1)).toMatchObject({ text: wake.length ? '-- literal' : 'literal' })
    }
    const before = bodies.length
    const p = Bun.spawn([CLI, 'mail', 'r1', 'manager', '--text-file', txt('blank.md', ' ')], {
      env: {
        PATH: process.env.PATH,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_SERVER: server.url.origin,
      },
    })
    expect(await p.exited).not.toBe(0)
    expect(bodies).toHaveLength(before)
  } finally {
    server.stop(true)
  }
})

test('0s5e remote text is data: flag-like mail survives worker replay without a file read', () => {
  const events = makeRun('r1')
  const outbox = join(dir, 'outbox.jsonl')
  for (const text of ['--', '--wake', '--text-file', '--owned']) {
    const path = txt('flag-mail.md', text)
    const r = factory(['mail', 'r1', 'manager', '--text-file', path], {
      FACTORY_OUTBOX: outbox,
      FACTORY_FROM: 'implement',
    })
    expect(r.code, r.err).toBe(0)
    const { argv, mailFile } = JSON.parse(readFileSync(outbox, 'utf8').trim().split('\n').at(-1)!)
    expect(replayable(argv, side, 'r1')).toEqual(argv)
    expect(argv).not.toContain(path)
    expect(mailFile).toBe(true)
    expect(factory(argv, { FACTORY_MAIL_FILE: mailFile ? '1' : '' }, dir).code).toBe(0)
    expect(events().at(-1).text).toBe(text)
  }
})

test('0s5e remote text is data: start parses owned before file content', async () => {
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      bodies.push((await req.json()) as Record<string, unknown>)
      return Response.json({ code: 0, out: '', err: '' })
    },
  })
  const path = txt('start.md', '--owned')
  try {
    for (const rest of [
      ['check', '--', 'help'],
      ['--owned', 'check', '--', 'help'],
      ['check', '--', 'help', '--owned'],
    ]) {
      const p = Bun.spawn([CLI, 'start', 'lifecycle', 'acme', ...rest], {
        env: {
          PATH: process.env.PATH,
          FACTORY_HOME: home,
          FACTORY_SELF_UPDATE: '0',
          FACTORY_SERVER: server.url.origin,
        },
      })
      expect(await p.exited).toBe(0)
      expect(bodies.at(-1)).toMatchObject({ goal: 'check -- help' })
      expect(bodies.at(-1)?.owned).toBe(rest.includes('--owned') ? true : undefined)
    }
    for (const owned of [false, true]) {
      const p = Bun.spawn(
        [CLI, 'start', 'lifecycle', 'acme', '--goal-file', path, ...(owned ? ['--owned'] : [])],
        {
          env: {
            PATH: process.env.PATH,
            FACTORY_HOME: home,
            FACTORY_SELF_UPDATE: '0',
            FACTORY_SERVER: server.url.origin,
          },
        },
      )
      expect(await p.exited).toBe(0)
      expect(bodies.at(-1)).toMatchObject({ factory: 'lifecycle', rig: 'acme', goal: '--owned' })
      expect(bodies.at(-1)?.owned).toBe(owned ? true : undefined)
    }
    const p = Bun.spawn([CLI, 'start', 'lifecycle', 'acme', '--goal-file', path, '--unknown', 'value'], {
      env: {
        PATH: process.env.PATH,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_SERVER: server.url.origin,
      },
    })
    expect(await p.exited).not.toBe(0)
    expect(bodies).toHaveLength(5)
  } finally {
    server.stop(true)
  }
})

test('0s5e remote text is data: file caps do not replace the total outbox cap', () => {
  const s = txt('summary-cap.md', 'a'.repeat(60 * 1024))
  const b = txt('body-cap.md', 'b'.repeat(60 * 1024))
  const outbox = join(dir, 'outbox.jsonl')
  const r = factory([...ADD, '--summary-file', s, '--body-file', b], {
    FACTORY_OUTBOX: outbox,
    FACTORY_FROM: 'implement',
  })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('100 KiB')
  expect(existsSync(outbox)).toBe(false)
})

test('0s5e file mode fails closed before operations for every consumer', () => {
  const events = makeRun('r1')
  const bad = badFiles()
  mkdirSync(join(home, 'text-other'), { recursive: true })
  const sibling = join(home, 'text-other', 'x.md')
  writeFileSync(sibling, 'outside')
  bad['prefix sibling'] = sibling
  const before = readFileSync(join(home, 'rigs.json'), 'utf8')
  for (const [name, path] of Object.entries(bad)) {
    for (const argv of consumers(path)) {
      const r = factory(argv, {}, wt)
      expect(r.code, `${name}: ${argv.slice(0, 2)}`).not.toBe(0)
      expect(r.err, `${name}: ${argv.slice(0, 2)}`).toMatch(/file|empty|outside|cap/)
    }
  }
  expect(events()).toEqual([])
  expect(notes()).toEqual([])
  expect(readFileSync(join(home, 'rigs.json'), 'utf8')).toBe(before)
  expect(readdirSync(join(home, 'runs'))).toEqual(['r1'])
})

test('0s5e file mode fails closed on malformed argv and memory option payloads', () => {
  const events = makeRun('r1')
  const path = txt('ok.md', 'literal')
  for (const argv of consumers(path)) {
    const flag = argv.findIndex(w => /--(?:text|note|goal|summary|body|query|reason)-file/.test(w))
    for (const bad of [
      argv.slice(0, -1),
      [...argv, argv[flag]!, path],
      [...argv, '--unknown'],
      [...argv, '--unknown', 'value'],
      [...argv, 'extra', 'words'],
      ...(argv[flag] === '--summary-file' || (argv[0] === 'rig' && argv[1] === 'add')
        ? []
        : [[...argv.slice(0, flag), 'inline', ...argv.slice(flag)]]),
    ]) {
      const r = factory(bad, {}, dir)
      expect(r.code, bad.join(' ')).not.toBe(0)
      expect(r.err).toMatch(/file|usage|unknown|replaces/)
    }
  }
  for (const payload of ['--anyway', '--rig', '--summary-file']) {
    const outbox = join(dir, 'outbox.jsonl')
    expect(
      factory([...ADD, '--summary-file', txt('flag.md', payload), 'A body that cannot become the summary'], {
        FACTORY_OUTBOX: outbox,
        FACTORY_FROM: 'implement',
      }).code,
    ).toBe(2)
    expect(existsSync(outbox)).toBe(false)
  }
  const missingSummary = factory([...ADD, '--body-file', path])
  expect(missingSummary.code).toBe(2)
  expect(events()).toEqual([])
  expect(notes()).toEqual([])
})

test('0s5e file mode requires IDs first and refuses a flag as a path', () => {
  makeRun('r1')
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  const scratch = join(wt, '.scratch')
  mkdirSync(scratch)
  writeFileSync(join(scratch, '--unknown'), 'literal')
  const ok = txt('ok.md', 'literal')
  for (const argv of consumers(ok)) {
    const at = argv.findIndex(w => w.endsWith('-file'))
    const flag = argv[at]!
    const reordered = [argv[0]!, flag, ok, ...argv.slice(1, at), ...argv.slice(at + 2)]
    const badId = factory(reordered, {}, scratch)
    expect(badId.code).not.toBe(0)
    if (argv[0] === 'poke') expect(badId.err).toContain('the IDs must come first')
    const badPath = factory([...argv.slice(0, at + 1), '--unknown'], {}, scratch)
    expect(badPath.code).not.toBe(0)
  }
})

test('0s5e file mode accepts confined paths and exactly 100 KiB', () => {
  const events = makeRun('r1')
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  mkdirSync(join(wt, '.scratch', 'nested'), { recursive: true })
  mkdirSync(join(home, 'text', 'nested'), { recursive: true })
  for (const root of [join(wt, '.scratch'), join(home, 'text')]) {
    const path = join(root, 'nested', 'payload.md')
    writeFileSync(path, 'a'.repeat(100 * 1024))
    symlinkSync(path, join(root, 'link.md'))
    for (const name of [path, join(root, 'link.md')]) {
      const r = factory(['poke', 'r1', '--text-file', name], {}, wt)
      expect(r.code, r.err).toBe(0)
      expect(events().at(-1).text).toHaveLength(100 * 1024)
    }
  }
  expect(factory(['poke', 'r1', '--text-file', '.scratch/link.md'], {}, wt).code).toBe(0)
})

test('0s5e file mode rejects a symlinked scratch root for every consumer', () => {
  const events = makeRun('r1')
  const linked = join(dir, 'linked-worktree')
  const outside = join(dir, 'outside')
  mkdirSync(linked)
  mkdirSync(outside)
  writeFileSync(join(outside, 'payload.md'), TEXT)
  expect(Bun.spawnSync(['git', 'init', '-q', linked]).exitCode).toBe(0)
  symlinkSync(outside, join(linked, '.scratch'))
  for (const argv of consumers(join(linked, '.scratch', 'payload.md'))) {
    const r = factory(argv, {}, linked)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('is outside')
  }
  expect(events()).toEqual([])
  expect(notes()).toEqual([])
})

test('0s5e file fields preserve text through a real shell without a second command', () => {
  const events = makeRun('r1')
  const marker = join(dir, 'shell-marker')
  const text = `owner'; touch ${marker}; printf 'x | \`touch ${marker}\` $(touch ${marker}) $VAR\nnext`
  const path = txt('shell.md', text)
  const script = join(dir, 'mail.sh')
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  writeFileSync(script, `${quote(CLI)} mail r1 manager --text-file ${quote(path)}\n`)
  const p = Bun.spawnSync(['bash', script], {
    env: { PATH: process.env.PATH, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1' },
    cwd: dir,
  })
  expect(p.exitCode, p.stderr.toString()).toBe(0)
  expect(events()).toHaveLength(1)
  expect(events()[0].text).toBe(text)
  expect(existsSync(marker)).toBe(false)
})

test('0s5e decision text remains visible and reaches one target after consent', () => {
  mkdirSync(join(home, 'allow'), { recursive: true })
  const marker = join(dir, 'decision-marker')
  const note = `owner'; touch ${marker}; printf 'x | \`touch ${marker}\` $(touch ${marker}) $VAR\nnext`
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  const calls = join(home, 'decision-calls.jsonl')
  const preload = join(home, 'decision-spy.ts')
  const gates = join(import.meta.dir, 'core', 'ops', 'gates.ts')
  const decisions = join(import.meta.dir, 'core', 'ops', 'decisions.ts')
  writeFileSync(
    preload,
    `import { mock } from 'bun:test'
import { appendFileSync } from 'node:fs'
const gates = await import(${JSON.stringify(gates)})
const decisions = await import(${JSON.stringify(decisions)})
const target = async (_ctx, input) => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(input) + '\\n')
  return { code: 0, out: '', err: '' }
}
mock.module(${JSON.stringify(gates)}, () => ({ ...gates, decide: target }))
mock.module(${JSON.stringify(decisions)}, () => ({ ...decisions, answer: target }))
`,
  )
  const allowId = '123e4567-e89b-12d3-a456-426614174000'
  for (const [verb, args, kind, key] of [
    ['decide', 'r1 ready', 'decide', 'note'],
    ['decisions', 'answer acme acme-1', 'answer', 'text'],
  ]) {
    const script = join(dir, `${verb}.sh`)
    writeFileSync(
      script,
      `${quote(process.execPath)} --preload ${quote(preload)} ${quote(join(import.meta.dir, 'cli.ts'))} ${verb} ${args} ${quote(note)}\n`,
    )
    const env = {
      PATH: process.env.PATH,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_MAIN_CHAT: '1',
    }
    const before = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
    const denied = Bun.spawnSync(['bash', script], { env })
    expect(denied.exitCode).not.toBe(0)
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe(before)
    writeFileSync(
      join(home, 'allow', `${allowId}.json`),
      JSON.stringify({ kinds: [kind], exp: Date.now() + 60_000 }),
    )
    const allowed = Bun.spawnSync(['bash', script], { env: { ...env, FACTORY_ALLOW: allowId } })
    expect(allowed.exitCode, allowed.stderr.toString()).toBe(0)
    const rows = readFileSync(calls, 'utf8')
      .slice(before.length)
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0][key!]).toBe(note)
    expect(existsSync(marker)).toBe(false)
  }
})
