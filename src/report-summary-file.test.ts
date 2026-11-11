// claude-factory-qzn: `factory report ... --summary-file <path>` posts the file text as the summary.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `report-summary-file-${process.pid}`)
const home = join(dir, 'home')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], cwd?: string) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_GC: '0' },
    cwd,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const textFile = (name: string, body: string) => {
  mkdirSync(join(home, 'text'), { recursive: true })
  const f = join(home, 'text', name)
  writeFileSync(f, body)
  return f
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

function makeRun(id: string) {
  const d = join(home, 'runs', id)
  const wt = join(dir, id)
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
  const seq = (actor.getSnapshot().context as { seq: number }).seq
  return {
    seq,
    lines: () =>
      readFileSync(join(d, 'inbox.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l)),
  }
}

const TEXT = `line one "quoted" $(not run) 'x'\n${'long '.repeat(2000)}\nend\n`

test('--summary-file posts the exact file text for ready, blocked, fail and handoff', () => {
  const r = makeRun('r1')
  const f = textFile('s.md', TEXT)
  expect(TEXT.length).toBeGreaterThan(8192)
  for (const [outcome, key] of [
    ['ready', 'summary'],
    ['blocked', 'reason'],
    ['fail', 'reason'],
    ['handoff', 'summary'],
  ] as const) {
    const p = factory(['report', 'r1', String(r.seq), outcome, '--summary-file', f])
    expect(p.err).toBe('')
    expect(p.code).toBe(0)
    expect(r.lines().at(-1)[key]).toBe(TEXT)
  }
})

test('--summary-file with a bad form exits 1, names the flag and posts nothing', () => {
  const r = makeRun('r2')
  const empty = textFile('empty', '')
  const blank = textFile('blank', ' \n\t\n')
  const ok = textFile('ok', 'text')
  for (const rest of [
    ['--summary-file'],
    ['--summary-file', join(dir, 'missing')],
    ['--summary-file', dir],
    ['--summary-file', empty],
    ['--summary-file', blank],
    ['--summary-file', ok, 'extra'],
  ]) {
    const p = factory(['report', 'r2', String(r.seq), 'ready', ...rest])
    expect(p.code).toBe(1)
    expect(p.err).toContain('--summary-file')
  }
  expect(r.lines()).toEqual([])
})

test('--summary-file after summary words refuses and posts nothing; inside a longer word it stays text', () => {
  const r = makeRun('r3')
  const f = textFile('f', 'secret')
  for (const rest of [
    ['see', '--summary-file', f],
    ['see', '--summary-file'],
  ]) {
    const p = factory(['report', 'r3', String(r.seq), 'ready', ...rest])
    expect(p.code).toBe(1)
    expect(p.err).toContain('--summary-file')
  }
  expect(r.lines()).toEqual([])
  expect(factory(['report', 'r3', String(r.seq), 'ready', 'the --summary-file flag']).code).toBe(0)
  expect(r.lines().at(-1).summary).toBe('the --summary-file flag')
})

test('report text loses control, format and line-separator chars, keeps LF and TAB (claude-factory-67bw)', () => {
  const dirty = 'a\u001b[2Jb\u009bc\u202ed\u2028e\u2029\ng\th'
  const clean = 'a [2Jb c d e \ng\th'
  for (const [outcome, key] of [
    ['ready', 'summary'],
    ['blocked', 'reason'],
    ['fail', 'reason'],
    ['handoff', 'summary'],
  ] as const) {
    const r = makeRun(`c-${outcome}`)
    expect(factory(['report', `c-${outcome}`, String(r.seq), outcome, dirty]).code).toBe(0)
    expect(r.lines().at(-1)[key]).toBe(clean)
    const f = textFile(`f-${outcome}`, dirty)
    const r2 = makeRun(`d-${outcome}`)
    expect(factory(['report', `d-${outcome}`, String(r2.seq), outcome, '--summary-file', f]).code).toBe(0)
    expect(r2.lines().at(-1)[key]).toBe(clean)
  }
})

test('mail text loses control, format and line-separator chars, keeps LF and TAB (claude-factory-67bw)', () => {
  const r = makeRun('m1')
  const dirty = 'a\u001b[2Jb\u009bc\u202Ed\u2028e\u2029\ng\th'
  expect(factory(['mail', 'm1', 'manager', dirty]).code).toBe(0)
  const mail = r.lines().find(l => l.type === 'MAIL')
  expect(mail.text).toBe('a [2Jb c d e \ng\th')
})

test('--summary-file over 100 KiB exits 1, names the flag and posts nothing (claude-factory-amzl)', () => {
  const r = makeRun('r4')
  const f = textFile('big', 'x'.repeat(1_200_000))
  const p = factory(['report', 'r4', String(r.seq), 'ready', '--summary-file', f])
  expect(p.code).toBe(1)
  expect(p.err).toContain('--summary-file')
  expect(p.err).toContain('102400')
  expect(r.lines()).toEqual([])
})

test('9ydy AC1/AC3: report refuses a word that starts with --summary-file=; a longer word stays text', () => {
  const r = makeRun('r9')
  const f = join(dir, 'f9')
  writeFileSync(f, 'secret')
  for (const rest of [
    [`--summary-file=${f}`],
    [`--summary-file=${join(dir, 'missing')}`],
    ['--summary-file='],
    ['see', `--summary-file=${f}`],
    ['see', '--summary-file='],
  ]) {
    const p = factory(['report', 'r9', String(r.seq), 'ready', ...rest])
    expect([rest, p.code]).toEqual([rest, 1])
    expect(p.err).toContain('usage: factory report')
    expect(r.lines()).toEqual([])
  }
  for (const t of ['x--summary-file=y', 'use --summary-file=y']) {
    expect(factory(['report', 'r9', String(r.seq), 'ready', t]).code).toBe(0)
    expect(r.lines().at(-1).summary).toBe(t)
  }
})

test('--summary-file outside the text roots exits 1 and posts nothing (claude-factory-pc2f)', () => {
  const outside = join(dir, 'outside.md')
  mkdirSync(dir, { recursive: true })
  writeFileSync(outside, 'secret')
  const textDir = join(home, 'text')
  mkdirSync(textDir, { recursive: true })
  writeFileSync(join(home, 'outside.md'), 'secret')
  symlinkSync(outside, join(textDir, 'link.md'))
  const repo = join(dir, 'repo')
  Bun.spawnSync(['git', 'init', '-q', repo])
  mkdirSync(join(repo, '.scratch'))
  symlinkSync(outside, join(repo, '.scratch', 'link.md'))
  const repo2 = join(dir, 'repo2')
  Bun.spawnSync(['git', 'init', '-q', repo2])
  const elsewhere = join(dir, 'elsewhere')
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, 's.md'), 'secret')
  symlinkSync(elsewhere, join(repo2, '.scratch'))
  const rows: [string, string, string?][] = [
    ['outside file', outside],
    ['symlink in text', join(textDir, 'link.md')],
    ['dotdot', join(textDir, '..', 'outside.md')],
    ['symlink in .scratch', '.scratch/link.md', repo],
    ['.scratch is a symlink', '.scratch/s.md', repo2],
  ]
  rows.forEach(([name, path, cwd], i) => {
    const r = makeRun(`o${i}`)
    const p = factory(['report', `o${i}`, String(r.seq), 'ready', '--summary-file', path], cwd)
    expect([name, p.code]).toEqual([name, 1])
    expect(p.err).toContain('--summary-file')
    expect(p.err).toContain('is outside')
    expect(r.lines()).toEqual([])
  })
})

test('--summary-file in .scratch/ of the git toplevel or in FACTORY_HOME/text posts the text', () => {
  const repo = join(dir, 'repo')
  mkdirSync(dir, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', repo])
  mkdirSync(join(repo, '.scratch'))
  writeFileSync(join(repo, '.scratch', 's.md'), TEXT)
  const rows: [string, string | undefined][] = [
    ['.scratch/s.md', repo],
    [join(repo, '.scratch', 's.md'), repo],
    [textFile('s.md', TEXT), undefined],
  ]
  rows.forEach(([path, cwd], i) => {
    const r = makeRun(`a${i}`)
    const p = factory(['report', `a${i}`, String(r.seq), 'ready', '--summary-file', path], cwd)
    expect(p.err).toBe('')
    expect(p.code).toBe(0)
    expect(r.lines().at(-1).summary).toBe(TEXT)
  })
})
