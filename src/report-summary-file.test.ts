// claude-factory-qzn: `factory report ... --summary-file <path>` posts the file text as the summary.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `report-summary-file-${process.pid}`)
const home = join(dir, 'home')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_GC: '0' },
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
  const f = join(dir, 's.md')
  writeFileSync(f, TEXT)
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
  const empty = join(dir, 'empty')
  const blank = join(dir, 'blank')
  const ok = join(dir, 'ok')
  writeFileSync(empty, '')
  writeFileSync(blank, ' \n\t\n')
  writeFileSync(ok, 'text')
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

test('--summary-file after summary words stays plain text', () => {
  const r = makeRun('r3')
  const f = join(dir, 'f')
  writeFileSync(f, 'secret')
  expect(factory(['report', 'r3', String(r.seq), 'ready', 'see', '--summary-file', f]).code).toBe(0)
  expect(r.lines().at(-1).summary).toBe(`see --summary-file ${f}`)
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
    const f = join(dir, `f-${outcome}`)
    writeFileSync(f, dirty)
    const r2 = makeRun(`d-${outcome}`)
    expect(factory(['report', `d-${outcome}`, String(r2.seq), outcome, '--summary-file', f]).code).toBe(0)
    expect(r2.lines().at(-1)[key]).toBe(clean)
  }
})

test('mail text loses control, format and line-separator chars, keeps LF and TAB (claude-factory-67bw)', () => {
  const r = makeRun('m1')
  const dirty = 'a\u001b[2Jb\u009bc‮d e \ng\th'
  expect(factory(['mail', 'm1', 'manager', dirty]).code).toBe(0)
  const mail = r.lines().find(l => l.type === 'MAIL')
  expect(mail.text).toBe('a [2Jb c d e \ng\th')
})

test('--summary-file over 100 KiB exits 1, names the flag and posts nothing (claude-factory-amzl)', () => {
  const r = makeRun('r4')
  const f = join(dir, 'big')
  writeFileSync(f, 'x'.repeat(1_200_000))
  const p = factory(['report', 'r4', String(r.seq), 'ready', '--summary-file', f])
  expect(p.code).toBe(1)
  expect(p.err).toContain('--summary-file')
  expect(p.err).toContain('102400')
  expect(r.lines()).toEqual([])
})
