import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format, formatLong, parse, search, snapshot, walk, coreNotes } from './memory'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `memsnap-${p}-`))
const note = (summary: string, rig?: string) =>
  format({ summary, body: `${summary} body`, rig, from: 'r1/x, r2/y' })
const tar = (...a: string[]) => Bun.spawnSync(['tar', ...a], { stderr: 'pipe' }).stdout.toString()
const listing = (tgz: string) => tar('-tzf', tgz).split('\n').filter(Boolean)

/** a store with real shapes: CORE.md rig sections, a LONG.md, junk dirs, a symlink, a nested dir */
function fixture() {
  const dir = tmp('store')
  const w = (p: string, t: string) => {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  w(
    'CORE.md',
    [
      '- agents never approve a pull request',
      '## rig: acme',
      '- acme builds with the widget tool',
      '## rig: other',
      '- other secret deploy lesson',
      '## rig: acme',
      '- acme second lesson',
    ].join('\n'),
  )
  w('ci/README.md', format({ summary: 'ci topic', body: '' }))
  w('ci/mine.md', note('acme tests need a fresh database', 'acme'))
  w('ci/free.md', note('every rig must wait for green checks'))
  w('ci/theirs.md', note('other rig runner pool lesson', 'other'))
  w(
    'ci/LONG.md',
    formatLong([
      { id: 'a', summary: 'acme long lesson', rig: 'acme', body: 'one\n## a heading in a body\ntwo' },
      { id: 'b', summary: 'shared long lesson', body: 'three' },
      { id: 'c', summary: 'other long lesson', rig: 'other', body: 'four' },
    ]),
  )
  w('inbox/new.md', note('a new inbox note about widget caches'))
  w('ci/sub/nested.md', note('nested note'))
  w('ci/x.txt', 'not a note')
  w('.archive/old.md', note('archived note'))
  w('.proposals/p.md', note('proposal'))
  w('.manager/m.md', note('manager note'))
  w('.git/HEAD', 'ref')
  w('.renames.jsonl', '{}\n')
  w('.index.json.summaries', '{}')
  w('.claude-uuid-session', 'x')
  const outside = join(tmp('outside'), 'secret.md')
  writeFileSync(outside, note('outside the store'))
  symlinkSync(outside, join(dir, 'ci', 'link.md'))
  return dir
}

test("snapshot keeps only the rig's notes", () => {
  const dir = fixture()
  const out = join(tmp('out'), 'm.tgz')
  expect(snapshot(dir, 'acme', out)!.bytes).toBe(statSync(out).size)
  const names = listing(out).map(n => n.replace(/^\.\//, ''))
  for (const bad of [
    '.git',
    '.archive',
    '.proposals',
    '.manager',
    '.renames.jsonl',
    '.index.json.summaries',
    '.claude-uuid-session',
    'ci/theirs.md',
    'ci/link.md',
    'ci/sub',
    'ci/x.txt',
  ])
    expect(names.filter(n => n === bad || n.startsWith(`${bad}/`))).toEqual([])
  const x = tmp('x')
  tar('-xzf', out, '-C', x)
  for (const f of ['ci/mine.md', 'ci/free.md', 'ci/README.md', 'inbox/new.md'])
    expect(readFileSync(join(x, f), 'utf8')).toBe(readFileSync(join(dir, f), 'utf8'))
  const core = readFileSync(join(x, 'CORE.md'), 'utf8')
  expect(core).toContain('acme builds')
  expect(core).toContain('acme second lesson')
  expect(core).toContain('agents never approve')
  expect(core).not.toContain('other secret')
  const long = readFileSync(join(x, 'ci/LONG.md'), 'utf8')
  expect(long).toContain('acme long lesson')
  expect(long).toContain('a heading in a body')
  expect(long).not.toContain('other long lesson')
  // no rig: only rig-less notes
  const none = join(tmp('out'), 'n.tgz')
  snapshot(dir, undefined, none)
  const y = tmp('y')
  tar('-xzf', none, '-C', y)
  expect(existsSync(join(y, 'ci/mine.md'))).toBe(false)
  expect(existsSync(join(y, 'ci/free.md'))).toBe(true)
  expect(readFileSync(join(y, 'CORE.md'), 'utf8')).not.toContain('acme builds')
  // a LONG.md that drops nothing is copied byte for byte
  const all = join(tmp('out'), 'a.tgz')
  mkdirSync(join(dir, 'solo'))
  writeFileSync(join(dir, 'solo', 'LONG.md'), formatLong([{ id: 's', summary: 'solo', body: 'b' }]))
  snapshot(dir, 'acme', all)
  const z = tmp('z')
  tar('-xzf', all, '-C', z)
  expect(readFileSync(join(z, 'solo/LONG.md'), 'utf8')).toBe(readFileSync(join(dir, 'solo/LONG.md'), 'utf8'))
  // text that parseLong puts in no entry never travels
  mkdirSync(join(dir, 'old'))
  writeFileSync(join(dir, 'old', 'LONG.md'), '## stray\n<!-- not json -->\nOLDMARKER\n')
  mkdirSync(join(dir, 'pre'))
  writeFileSync(
    join(dir, 'pre', 'LONG.md'),
    'PREAMBLEMARKER\n\n' + formatLong([{ id: 'p', summary: 'pre', rig: 'acme', body: 'b' }]),
  )
  const strays = join(tmp('out'), 's.tgz')
  snapshot(dir, 'acme', strays)
  const w = tmp('w')
  tar('-xzf', strays, '-C', w)
  expect(existsSync(join(w, 'old/LONG.md'))).toBe(false)
  expect(readFileSync(join(w, 'pre/LONG.md'), 'utf8')).not.toContain('PREAMBLEMARKER')
  expect(readFileSync(join(w, 'pre/LONG.md'), 'utf8')).toContain('pre')
  // empty or missing store: null, no file
  const o2 = join(tmp('out'), 'e.tgz')
  expect(snapshot(join(tmp('empty')), 'acme', o2)).toBeNull()
  expect(snapshot(join(tmp('empty'), 'nope'), 'acme', o2)).toBeNull()
  expect(existsSync(o2)).toBe(false)
})

test('snapshot index and usage hold only kept paths', async () => {
  const dir = fixture()
  await search(dir, 'warm the index', { rig: 'acme' })
  const all = JSON.parse(readFileSync(join(dir, '.index.json'), 'utf8'))
  expect(Object.keys(all.vecs).some(p => p.includes('theirs'))).toBe(true)
  writeFileSync(
    join(dir, '.usage.jsonl'),
    [
      JSON.stringify({ path: 'ci/mine.md', at: 1, shown: 1 }),
      JSON.stringify({ path: 'ci/theirs.md', at: 1, shown: 1 }),
    ].join('\n') + '\n',
  )
  const out = join(tmp('out'), 'm.tgz')
  snapshot(dir, 'acme', out)
  const x = tmp('x')
  tar('-xzf', out, '-C', x)
  const idx = JSON.parse(readFileSync(join(x, '.index.json'), 'utf8'))
  const { notes, topics } = walk(x)
  const want = [...notes, ...topics.values(), ...coreNotes(x)].map(n => n.path).sort()
  expect(Object.keys(idx.vecs).sort()).toEqual(want)
  expect(idx.model).toBe(all.model)
  const usage = readFileSync(join(x, '.usage.jsonl'), 'utf8').trim().split('\n')
  expect(usage.map(l => JSON.parse(l).path)).toEqual(['ci/mine.md'])
}, 120_000)

test("snapshot search gives the laptop's top 5", async () => {
  const dir = fixture()
  await search(dir, 'warm the index', { rig: 'acme' })
  const out = join(tmp('out'), 'm.tgz')
  snapshot(dir, 'acme', out)
  const x = tmp('x')
  tar('-xzf', out, '-C', x)
  const before = statSync(join(x, '.index.json')).mtimeMs
  for (const q of ['database for tests', 'wait for green checks', 'long lesson']) {
    const a = await search(dir, q, { rig: 'acme' })
    const b = await search(x, q, { rig: 'acme' })
    expect(b.map(f => f.note.path)).toEqual(a.map(f => f.note.path))
    b.forEach((f, i) => expect(Math.abs(f.score - a[i]!.score)).toBeLessThan(1e-9))
  }
  expect(statSync(join(x, '.index.json')).mtimeMs).toBe(before)
}, 120_000)

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
/** `factory memory search` as a VM worker runs it: a worker dir with memory.tgz, a fresh home, no outbox */
function vmSearch(worker: string, home: string, q: string) {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...rest } = process.env
  const p = Bun.spawnSync([CLI, 'memory', 'search', '--rig', 'acme', q], {
    env: { ...rest, FACTORY_WORKER_DIR: worker, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString() }
}
/** the printed hits as `<score to 2 decimals> <path after the memory dir>` */
const hits = (out: string) =>
  out
    .split('\n')
    .filter(l => /^\d\.\d\d {2}/.test(l))
    .map(l => l.replace(/^(\d\.\d\d) {2}\S*\/memory\/(\S+).*$/, '$1 $2'))

test('VM search unpacks memory.tgz', async () => {
  const dir = fixture()
  await search(dir, 'warm the index', { rig: 'acme' })
  const w = tmp('worker')
  snapshot(dir, 'acme', join(w, 'memory.tgz'))
  for (const q of ['database for tests', 'wait for green checks']) {
    const home = tmp('home')
    const vm = vmSearch(w, home, q)
    expect(vm.code).toBe(0)
    const want = (await search(dir, q, { rig: 'acme' })).map(f => `${f.score.toFixed(2)} ${f.note.path}`)
    expect(want.length).toBeGreaterThan(0)
    expect(hits(vm.out)).toEqual(want)
    expect(existsSync(join(home, 'memory', 'ci', 'mine.md'))).toBe(true)
  }
}, 120_000)

test('VM search keeps an existing memory dir', () => {
  const dir = fixture()
  const w = tmp('worker')
  snapshot(dir, 'acme', join(w, 'memory.tgz'))
  const home = tmp('home')
  mkdirSync(join(home, 'memory'))
  writeFileSync(join(home, 'memory', 'marker.txt'), 'mine')
  vmSearch(w, home, 'database')
  expect(readFileSync(join(home, 'memory', 'marker.txt'), 'utf8')).toBe('mine')
  expect(existsSync(join(home, 'memory', 'ci'))).toBe(false)
  // an empty memory dir (a rename onto it would succeed) stays empty too
  const empty = tmp('home')
  mkdirSync(join(empty, 'memory'))
  vmSearch(w, empty, 'database')
  expect(readdirSync(join(empty, 'memory'))).toEqual([])
}, 60_000)

test('a broken memory.tgz leaves no dir', () => {
  const w = tmp('worker')
  writeFileSync(join(w, 'memory.tgz'), 'not gzip at all')
  const home = tmp('home')
  const r = vmSearch(w, home, 'database')
  expect(r.code).toBe(0)
  expect(r.out).toContain('nothing in')
  expect(readdirSync(home).filter(n => n.startsWith('memory'))).toEqual([])
  // no memory.tgz: today's output
  expect(vmSearch(tmp('worker'), tmp('home'), 'database').out).toContain('nothing in')
}, 60_000)

test('u509 snapshot scope matrix', () => {
  const bom = '﻿'
  const bad: Record<string, string> = {
    indented: '---\nsummary: s\n rig: acme\n---\nbody MARK',
    capital: '---\nsummary: s\nRig: acme\n---\nbody MARK',
    noHeader: 'plain\nrig: acme\nMARK\n',
    duplicate: '---\nsummary: s\nrig: acme\nrig: acme\n---\nbody MARK',
    reverse: '---\nsummary: s\nrig: acme\nrig: other\n---\nbody MARK',
    empty: '---\nsummary: s\nrig:\n---\nbody MARK',
    noClose: '---\nsummary: s\nrig: acme\nbody MARK',
    other: '---\r\nsummary: s\r\nrig: other\r\n---\r\nbody MARK',
    otherBom: `${bom}---\nsummary: s\nrig: other\n---\nbody MARK`,
    tab: '---\nsummary: s\n\trig: acme\n---\nbody MARK',
    allCaps: '---\nsummary: s\nRIG: acme\n---\nbody MARK',
    spaceColon: '---\nsummary: s\nrig : acme\n---\nbody MARK',
    mixedDup: '---\nsummary: s\nrig: acme\nRig: acme\n---\nbody MARK',
    blankValue: '---\nsummary: s\nrig:   \n---\nbody MARK',
    prefix100: `${'x\n'.repeat(100)}rig: acme\nMARK\n`,
    otherAcme: '---\nsummary: s\nrig: other\nrig: acme\n---\nbody MARK',
    bomCrlfOther: `${bom}---\r\nsummary: s\r\nrig: other\r\n---\r\nbody MARK`,
    mixedOther: '---\nsummary: s\r\nrig: other\n---\r\nbody MARK',
    eofOther: '---\nsummary: s\nrig: other\n---',
  }
  const good: Record<string, string> = {
    'crlf.md': '---\r\nsummary: s\r\nrig: acme\r\n---\r\nbody\r\n',
    'bom.md': `${bom}---\nsummary: s\nrig: acme\n---\nbody\n`,
    'shared.md': '---\nsummary: s\n---\nshared\n',
    'legacy.md': 'legacy shared note\n',
    'emptyHeader.md': '---\n---\nrig: other\n',
    'emptyCapital.md': '---\n---\nRig: other\n',
    'emptyIndented.md': '---\r\n---\r\n rig: other\r\n',
    'emptyDup.md': `${bom}---\n---\nrig: other\nrig: acme\n`,
    'bodyRig.md': '---\nsummary: s\nrig: acme\n---\nrig: other\nRig: x\n',
  }
  const sentinel = parse('x.md', bad.indented ?? '').rig
  for (const rig of ['acme', undefined, sentinel]) {
    const dir = tmp('u509')
    mkdirSync(join(dir, 'ci'))
    writeFileSync(join(dir, 'README.md'), 'top\n')
    mkdirSync(join(dir, 'ops'))
    const all = { ...Object.fromEntries(Object.entries(bad).map(([k, v]) => [`${k}.md`, v])), ...good }
    for (const [f, t] of Object.entries(all)) writeFileSync(join(dir, 'ci', f), t)
    for (const [k, t] of Object.entries(bad))
      writeFileSync(join(dir, 'ops', k === 'indented' ? 'README.md' : `${k}.md`), t)
    const paths = [
      ...Object.keys(all).map(f => `ci/${f}`),
      ...Object.keys(bad).map(k => `ops/${k === 'indented' ? 'README' : k}.md`),
    ]
    writeFileSync(
      join(dir, '.index.json'),
      JSON.stringify({ model: 'm', vecs: Object.fromEntries(paths.map(p => [p, [1, 0]])) }),
    )
    writeFileSync(
      join(dir, '.usage.jsonl'),
      paths.map(path => JSON.stringify({ path, at: 1, shown: 1 })).join('\n') + '\n',
    )
    const out = join(tmp('out'), 'm.tgz')
    expect(snapshot(dir, rig, out)).not.toBeNull()
    const x = tmp('x')
    tar('-xzf', out, '-C', x)
    const names = listing(out).map(n => n.replace(/^\.\//, ''))
    const kept = (rig === 'acme' ? ['ci/crlf.md', 'ci/bom.md', 'ci/bodyRig.md'] : []).concat([
      'ci/shared.md',
      'ci/legacy.md',
      'ci/emptyHeader.md',
      'ci/emptyCapital.md',
      'ci/emptyIndented.md',
      'ci/emptyDup.md',
    ])
    for (const f of readdirSync(join(x, 'ci')).map(f => `ci/${f}`)) expect(kept, `${rig} ${f}`).toContain(f)
    for (const f of kept) expect(readFileSync(join(x, f))).toEqual(readFileSync(join(dir, f)))
    expect(names.some(n => n.startsWith('ops/') && n !== 'ops/')).toBe(false)
    const payload = readdirSync(join(x, 'ci'))
      .map(f => readFileSync(join(x, 'ci', f), 'utf8'))
      .join('\n')
    expect(payload).not.toContain('MARK')
    for (const f of ['.index.json', '.usage.jsonl']) {
      const t = readFileSync(join(x, f), 'utf8')
      for (const k of Object.keys(bad)) expect(t).not.toContain(`${k}.md`)
      expect(t).not.toContain('ops/')
      for (const f2 of kept) expect(t).toContain(f2)
    }
  }
})
