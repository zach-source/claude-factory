// claude-factory-mrfa: `factory file-elsewhere` decides the factory label in code and fails closed.
// A fake bd on PATH logs every call. Fixtures use acme names only.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `file-elsewhere-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'calls.log')
const showFile = join(dir, 'show.out')
const showErr = join(dir, 'show.err')
const failShow = join(dir, 'fail-show')
const failCreate = join(dir, 'fail-create')
const failComment = join(dir, 'fail-comment')
const repoA = join(dir, 'acme-a')
const repoB = join(dir, 'acme-b')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}, cwd?: string) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
    cwd,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** `show` answers with `source` JSON, or fails with `fail` as its stderr when given */
function setup(source: unknown = [{ id: 'acme-1' }], fail?: string) {
  rmSync(dir, { recursive: true, force: true })
  for (const d of [home, bin, join(repoA, '.beads'), join(repoB, '.beads')]) mkdirSync(d, { recursive: true })
  writeFileSync(showFile, JSON.stringify(source))
  if (fail !== undefined) {
    writeFileSync(failShow, '')
    writeFileSync(showErr, fail)
  }
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$PWD" "$BEADS_ACTOR" "$(printf '%s' "$*" | tr '\\n' ' ')" >> '${calls}'`,
      'case "$1" in',
      `  show) if [ -e '${failShow}' ]; then printf '%s' '{"error":"not found"}'; cat '${showErr}' >&2; exit 1; fi; cat '${showFile}';;`,
      `  create) if [ -e '${failCreate}' ]; then echo 'create boom' >&2; exit 1; fi; printf '%s' 'acme-b-9';;`,
      `  comment) if [ -e '${failComment}' ]; then echo 'comment boom' >&2; exit 1; fi;;`,
      "  list) printf '%s' '[]';;",
      '  *) exit 0;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([
      { name: 'acme-a', repo: repoA, factory: 'lifecycle' },
      { name: 'acme-b', repo: repoB, factory: 'lifecycle' },
    ]),
  )
}

const lines = () =>
  existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .filter(l => l.split('|').length >= 3)
    : []
const verb = (l: string) => l.split('|')[2]!.split(' ')[0]
const creates = () => lines().filter(l => verb(l) === 'create')
const ARGS = [
  'file-elsewhere',
  'acme-b',
  '--from',
  'acme-a:acme-1',
  '--title',
  'Fix widget',
  '--description',
  'It breaks',
]
const meta = (l: string) => JSON.parse(l.match(/--metadata (\{.*?\})(?= |$)/)![1]!)

test('a plain source files with the factory label and discovered_from, then comments on the source (AC1, AC7)', () => {
  setup()
  const r = factory(ARGS)
  expect(r.code).toBe(0)
  expect(r.out).toContain('acme-b-9')
  expect(creates()).toHaveLength(1)
  const c = creates()[0]!
  expect(c.split('|')[0]!.endsWith('/acme-b')).toBe(true)
  expect(c).toContain('--actor factory')
  expect(c).toContain('-l factory')
  expect(meta(c).discovered_from).toBe('acme-1')
  expect(c).toContain('acme-a:acme-1')
  const cm = lines().filter(l => verb(l) === 'comment')
  expect(cm).toHaveLength(1)
  expect(cm[0]!.split('|')[0]!.endsWith('/acme-a')).toBe(true)
  expect(cm[0]).toContain('comment acme-1')
  expect(cm[0]).toContain('acme-b-9')
})

test('BEADS_ACTOR from the env is the bd actor (AC7)', () => {
  setup()
  expect(factory(ARGS, { BEADS_ACTOR: 'alice' }).code).toBe(0)
  expect(creates()[0]).toContain('--actor alice')
})

test.each(['https://linear.app/acme/issue/W-1', 'https://LINEAR.APP/acme/issue/W-1'])(
  'a Linear source files without the label (AC2) %s',
  ref => {
    setup([{ id: 'acme-1', external_ref: ref }])
    expect(factory(ARGS).code).toBe(0)
    expect(creates()).toHaveLength(1)
    expect(creates()[0]).not.toContain('-l factory')
    expect(meta(creates()[0]!).discovered_from).toBe('acme-1')
  },
)

test.each(['Error fetching acme-1: dolt stall', 'Issue acme-1 not found', 'something unknown'])(
  'a failed read files nothing (AC3) %s',
  stderr => {
    setup(undefined, stderr)
    expect(factory(ARGS).code).toBe(1)
    expect(creates()).toHaveLength(0)
  },
)

test.each([[[]], [[{ id: 'acme-2' }]]])('an empty or foreign read files nothing (AC3) %j', source => {
  setup(source)
  expect(factory(ARGS).code).toBe(1)
  expect(creates()).toHaveLength(0)
})

const F = ['--from', 'acme-a:acme-1']
const TD = ['--title', 't', '--description', 'd']
const bad: [string, string[]][] = [
  ['no args', ['file-elsewhere']],
  ['missing --title', ['file-elsewhere', 'acme-b', ...F, '--description', 'd']],
  ['empty description', ['file-elsewhere', 'acme-b', ...F, '--title', 't', '--description', '']],
  ['repeated --from', [...ARGS, ...F]],
  ['extra word', [...ARGS, 'extra']],
  ['no colon', ['file-elsewhere', 'acme-b', '--from', 'acme-1', ...TD]],
  ['unknown target', ['file-elsewhere', 'nope', ...F, ...TD]],
  ['unknown source', ['file-elsewhere', 'acme-b', '--from', 'nope:acme-1', ...TD]],
  ['path target', ['file-elsewhere', './x', ...F, ...TD]],
  ['same rig', ['file-elsewhere', 'acme-a', ...F, ...TD]],
  ['bad id', ['file-elsewhere', 'acme-b', '--from', 'acme-a:acme-1;x', ...TD]],
]
test.each(bad)('grammar: %s exits 1 with no bd call (AC4)', (_n, args) => {
  setup()
  expect(factory(args).code).toBe(1)
  expect(lines()).toHaveLength(0)
})

/** a run whose bead is `bead` in `repo` */
function run(bead: string, repo: string) {
  const d = join(home, 'runs', 'r1')
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id: 'r1', factory: 'x', repo, goal: 'g', ws: 'w', worktree: repo, branch: 'b', bead }),
  )
}

test('a worker files only from its own run bead (AC5)', () => {
  setup()
  run('acme-1', repoA)
  expect(factory(ARGS, { FACTORY_RUN: 'r1' }).code).toBe(0)
  expect(creates()).toHaveLength(1)
})

test('a worker is refused for another bead, another rig or no run (AC5)', () => {
  setup()
  run('acme-1', repoA)
  const other = ARGS.map(a => (a === 'acme-a:acme-1' ? 'acme-a:acme-9' : a))
  expect(factory(other, { FACTORY_RUN: 'r1' }).code).toBe(1)
  run('acme-1', repoB)
  expect(factory(ARGS, { FACTORY_RUN: 'r1' }).code).toBe(1)
  expect(factory(ARGS, { FACTORY_FROM: 'triage' }).code).toBe(1)
  expect(factory(ARGS, { BEADS_ACTOR: 'factory/r1/triage' }).code).toBe(1)
  expect(lines()).toHaveLength(0)
})

test('a title that starts with a dash is a title, never a bd flag', () => {
  setup()
  const a = [...ARGS]
  a[a.indexOf('Fix widget')] = '--labels=factory'
  expect(factory(a).code).toBe(0)
  expect(creates()).toHaveLength(1)
  expect(creates()[0]).toContain('create --title --labels=factory -d')
})

test('a create failure exits 1 and checks the token before any retry (AC6)', () => {
  setup()
  writeFileSync(failCreate, '')
  expect(factory(ARGS).code).toBe(1)
  expect(lines().some(l => verb(l) === 'list' && l.includes('factory_create='))).toBe(true)
  expect(lines().some(l => verb(l) === 'comment')).toBe(false)
})

test('a comment failure after the create names the new id (AC6)', () => {
  setup()
  writeFileSync(failComment, '')
  const r = factory(ARGS)
  expect(r.code).toBe(1)
  expect(r.err).toContain('acme-b-9')
  expect(creates()).toHaveLength(1)
})

// claude-factory-2z48: untrusted text reaches the CLI by file, read only inside <FACTORY_HOME>/text/
const FROM = ['file-elsewhere', 'acme-b', '--from', 'acme-a:acme-1']
const txt = (name: string, body: string | Buffer) => {
  const p = join(home, 'text', name)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
  return p
}

test('--title-file and --description-file file the text as written, and nothing runs', () => {
  setup()
  const t = txt('t.txt', "x'; id; '\n")
  const d = txt('sub/d.txt', "a $(id) and a ' here\n")
  const r = factory([...FROM, '--title-file', t, '--description-file', d])
  expect(r.code).toBe(0)
  const c = creates()[0]!
  expect(c).toContain("x'; id; '")
  expect(c).toContain("a $(id) and a ' here  Filed from acme-a:acme-1.")
})

test('a -file flag refuses a bad path with exit 1 and zero bd calls (AC1)', () => {
  setup()
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'secret')
  mkdirSync(join(home, 'text'), { recursive: true })
  symlinkSync(outside, join(home, 'text', 'link.txt'))
  mkdirSync(join(home, 'text', 'adir'))
  const good = txt('ok.txt', 'ok')
  const bad: Record<string, string> = {
    'outside text/': join(home, 'rigs.json'),
    dotdot: join(home, 'text', '..', 'rigs.json'),
    'symlink out': join(home, 'text', 'link.txt'),
    directory: join(home, 'text', 'adir'),
    missing: join(home, 'text', 'nope.txt'),
    empty: txt('empty.txt', ''),
    whitespace: txt('ws.txt', ' \n\t\n'),
    'over cap': txt('big.txt', Buffer.alloc(100 * 1024 + 1, 'a')),
  }
  for (const [name, p] of Object.entries(bad)) {
    const r = factory([...FROM, '--title-file', p, '--description-file', good])
    expect([name, r.code]).toEqual([name, 1])
    expect(r.err).toContain('--title-file')
    expect(lines()).toHaveLength(0)
  }
  const max = txt('max.txt', Buffer.alloc(100 * 1024, 'a'))
  expect(factory([...FROM, '--title-file', good, '--description-file', max]).code).toBe(0)
})

test('a -file flag also reads a file in .scratch/ of the git toplevel of the cwd (jho3 AC3)', () => {
  setup()
  const wt = join(dir, 'wt')
  mkdirSync(join(wt, '.scratch'), { recursive: true })
  mkdirSync(join(wt, 'sub'))
  expect(Bun.spawnSync(['git', 'init', '-q', wt]).exitCode).toBe(0)
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'secret')
  symlinkSync(outside, join(wt, '.scratch', 'link.txt'))
  writeFileSync(join(wt, '.scratch', 'ok.md'), "x'; id; ' and $(id)\n")
  writeFileSync(join(wt, 'notes.md'), 'notes')
  const good = txt('ok.txt', 'ok')
  const run = (p: string, cwd = wt) =>
    factory([...FROM, '--title-file', p, '--description-file', good], {}, cwd)
  const r = run(join(wt, '.scratch', 'ok.md'), join(wt, 'sub'))
  expect(r.code).toBe(0)
  expect(creates()[0]).toContain("x'; id; ' and $(id)")
  mkdirSync(join(wt, '.scratch-x'))
  writeFileSync(join(wt, '.scratch-x', 'a.md'), 'a')
  const bad: Record<string, string> = {
    'sibling folder': join(wt, '.scratch-x', 'a.md'),
    dotdot: join(wt, '.scratch', '..', 'notes.md'),
    'symlink out': join(wt, '.scratch', 'link.txt'),
    'outside .scratch': join(wt, 'notes.md'),
  }
  for (const [name, p] of Object.entries(bad)) expect([name, run(p).code]).toEqual([name, 1])
  // not a git worktree: only text/ counts
  mkdirSync(join(dir, 'plain', '.scratch'), { recursive: true })
  writeFileSync(join(dir, 'plain', '.scratch', 'a.md'), 'a')
  expect(run(join(dir, 'plain', '.scratch', 'a.md'), join(dir, 'plain')).code).toBe(1)
}, 30000)

test('file-elsewhere refuses a bad grammar with usage and zero bd calls (AC2)', () => {
  setup()
  const f = txt('f.txt', 'one')
  const nl = txt('nl.txt', 'one\ntwo')
  const rows: Record<string, string[]> = {
    'unknown flag': [...FROM, '--title', 't', '--description', 'd', '--x', 'y'],
    'both title': [...FROM, '--title', 't', '--title-file', f],
    'both description': [...FROM, '--description', 'd', '--description-file', f],
    'repeated file': [...FROM, '--title-file', f, '--title-file', f],
    repeated: [...FROM, '--title', 't', '--title', 'u', '--description', 'd'],
    'no value': [...FROM, '--title', 't', '--description'],
    'extra word': [...FROM, '--title', 't', '--description', 'd', 'extra'],
    'newline title': [...FROM, '--title-file', nl, '--description', 'd'],
  }
  for (const [name, a] of Object.entries(rows)) {
    const r = factory(a)
    expect([name, r.code]).toEqual([name, 1])
    expect(lines()).toHaveLength(0)
  }
})

test('file-elsewhere refuses a control character in a title or a description with zero bd calls (claude-factory-p1j6)', () => {
  setup()
  const bad: Record<string, string> = {
    ESC: 'a\x1b[2Jb',
    CR: 'a\rb',
    DEL: 'a\x7fb',
    C1: 'a\u009bb',
  }
  const check = (name: string, a: string[], code: string) => {
    const r = factory(a)
    expect([name, r.code]).toEqual([name, 1])
    expect([name, lines().length]).toEqual([name, 0])
    if (code) expect(r.err).toContain(code)
    expect(/[^\P{Cc}\n]/u.test(r.err.trimEnd())).toBe(false)
  }
  const codes: Record<string, string> = { ESC: 'U+001B', CR: 'U+000D', DEL: 'U+007F', C1: 'U+009B' }
  let n = 0
  for (const [name, v] of Object.entries(bad)) {
    check(`title ${name}`, [...FROM, '--title', v, '--description', 'd'], codes[name]!)
    check(
      `title-file ${name}`,
      [...FROM, '--title-file', txt(`t${n++}`, v), '--description', 'd'],
      codes[name]!,
    )
    check(`description ${name}`, [...FROM, '--title', 't', '--description', v], codes[name]!)
    check(
      `description-file ${name}`,
      [...FROM, '--title', 't', '--description-file', txt(`d${n++}`, v)],
      codes[name]!,
    )
  }
  check('title tab', [...FROM, '--title', 'a\tb', '--description', 'd'], 'U+0009')
  check('title newline', [...FROM, '--title', 'a\nb', '--description', 'd'], '')
  check('title-file NUL', [...FROM, '--title-file', txt('tn', 'a\x00b'), '--description', 'd'], 'U+0000')
  check(
    'description-file NUL',
    [...FROM, '--title', 't', '--description-file', txt('dn', 'a\x00b')],
    'U+0000',
  )

  const text = 'line one\nline two\tend'
  expect(factory([...FROM, '--title', 'Café widget ✓', '--description', text]).code).toBe(0)
  expect(creates()).toHaveLength(1)
  expect(creates()[0]).toContain('Café widget ✓')
  expect(creates()[0]).toContain('line two\tend')
  expect(factory([...FROM, '--title', 't', '--description-file', txt('ok', text)]).code).toBe(0)
  expect(creates()).toHaveLength(2)
})
