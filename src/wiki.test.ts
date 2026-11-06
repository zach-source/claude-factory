import { expect, test } from 'bun:test'
import {
  format,
  parse,
  renderRigPage,
  scanPages,
  SECTIONS,
  type Merged,
  type Page,
  type RigRow,
} from './wiki'
import type { Bead } from './beads'

const sections = (skip: string[] = []) =>
  SECTIONS.filter(s => !skip.includes(s))
    .map(s => `## ${s}\n\ntext\n`)
    .join('\n')
const fm = (lines: string[]) => `---\n${lines.join('\n')}\n---\n`
const solution = (lines: string[] = [], body = sections()) =>
  fm(['kind: solution', 'title: Fix the thing', 'rigs: [acme]', 'topics: [ci]', 'cause: proven', ...lines]) +
  body
const good = {
  rig: fm(['kind: rig', 'title: Acme', 'rigs: [acme]']) + '\nbody\n',
  solution: solution([
    'status: current',
    'updated: 2026-11-06T10:00:00Z',
    'beads: [acme-1]',
    'prs: [acme/widget#1]',
  ]),
  topic: fm(['kind: topic', 'title: CI']) + '\nbody\n',
  index: fm(['kind: index', 'title: Index']) + '\nbody\n',
  glossary: fm(['kind: glossary', 'title: Glossary']) + '\nbody\n',
}
const reasons = (text: string) => scanPages([{ path: 'p.md', text }])[0]?.reasons

test('AC1 a valid page of each kind parses and scans clean', () => {
  for (const [kind, text] of Object.entries(good)) {
    const r = parse(text)
    expect('page' in r ? r.page.kind : r.reasons).toBe(kind as Page['kind'])
    expect(reasons(text)).toBeUndefined()
  }
})

const field = (name: string, lines: string[], want: string) => [name, fm(lines) + sections(), want] as const
test.each([
  field('no kind', ['title: T'], 'kind: invalid'),
  field('bad kind', ['kind: wiki', 'title: T'], 'kind: invalid'),
  field('no title', ['kind: topic'], 'title: missing'),
  field('empty title', ['kind: topic', 'title: ""'], 'title: missing'),
  field('rig without rigs', ['kind: rig', 'title: T'], 'rigs: missing'),
  field(
    'solution without rigs',
    ['kind: solution', 'title: T', 'topics: [a]', 'cause: proven'],
    'rigs: missing',
  ),
  field(
    'empty topics',
    ['kind: solution', 'title: T', 'rigs: [a]', 'topics: []', 'cause: proven'],
    'topics: missing',
  ),
  field('no topics', ['kind: solution', 'title: T', 'rigs: [a]', 'cause: proven'], 'topics: missing'),
  field('no cause', ['kind: solution', 'title: T', 'rigs: [a]', 'topics: [a]'], 'cause: missing'),
  field(
    'bad cause',
    ['kind: solution', 'title: T', 'rigs: [a]', 'topics: [a]', 'cause: maybe'],
    'cause: missing',
  ),
  field('cause on rig', ['kind: rig', 'title: T', 'rigs: [a]', 'cause: proven'], 'cause: solution only'),
  field('unknown key', ['kind: topic', 'title: T', 'zqextra: 1'], 'unknown field'),
  field('rigs string', ['kind: topic', 'title: T', 'rigs: acme'], 'rigs: not a string list'),
  field('beads number list', ['kind: topic', 'title: T', 'beads: [1]'], 'beads: not a string list'),
  field('bad status', ['kind: topic', 'title: T', 'status: old'], 'status: invalid'),
  field('bad updated', ['kind: topic', 'title: T', 'updated: yesterday'], 'updated: invalid'),
  field('superseded alone', ['kind: topic', 'title: T', 'status: superseded'], 'superseded_by: missing'),
  field(
    'superseded empty',
    ['kind: topic', 'title: T', 'status: superseded', 'superseded_by: ""'],
    'superseded_by: missing',
  ),
  field(
    'superseded_by on current',
    ['kind: topic', 'title: T', 'superseded_by: topics/a.md'],
    'superseded_by: not superseded',
  ),
])('AC2/4/5 %s', (_n, text, want) => {
  const r = reasons(text)!
  expect(r).toContain(want)
  for (const w of ['wiki', 'old', 'maybe', 'zqextra', 'yesterday']) expect(r.join()).not.toContain(w)
})

test('AC2 AC4 allowed forms stay valid', () => {
  expect(reasons(fm(['kind: topic', 'title: T', 'status: stale']))).toBeUndefined()
  expect(
    reasons(fm(['kind: topic', 'title: T', 'status: superseded', 'superseded_by: topics/a.md'])),
  ).toBeUndefined()
})

test.each(SECTIONS)('AC3 missing section %s', s => {
  expect(reasons(solution([], sections([s])))).toEqual([`missing section: ${s}`])
})

test('AC3 section order, extras and fences', () => {
  const swapped = SECTIONS.map((s, i) => (i === 1 ? SECTIONS[2] : i === 2 ? SECTIONS[1] : s))
    .map(s => `## ${s}\n`)
    .join('\n')
  expect(reasons(solution([], swapped))).toEqual(['sections: order or extra'])
  expect(reasons(solution([], sections() + '\n## Notes\n'))).toEqual(['sections: order or extra'])
  expect(reasons(solution([], sections() + '\n### Sub\n'))).toBeUndefined()
  expect(reasons(solution([], sections() + '\n```\n## x\n```\n'))).toBeUndefined()
  const fenced = sections(['Cause']) + '\n```\n## Cause\n```\n'
  expect(reasons(solution([], fenced))).toEqual(['missing section: Cause'])
})

test.each([
  ['plain text', 'hello\n'],
  ['no closing fence', '---\nkind: topic\ntitle: T\n'],
  ['yaml syntax error', '---\nkind: topic\ntitle: T\nrigs: [\n---\nx'],
  ['list root', '---\n- a\n- b\n---\nx'],
  ['empty block', '---\n---\nx'],
  ['crlf', '---\r\nkind: topic\r\ntitle: T\r\n---\r\nx'],
  ['bom', '﻿' + good.topic],
])('AC6 no frontmatter: %s', (_n, text) => {
  expect(reasons(text)).toEqual(['no frontmatter'])
})

const tokens = ['ghp_' + 'a'.repeat(36), 'sk-ant-' + 'a'.repeat(30), '-----BEGIN ' + 'RSA PRIVATE KEY-----']
test.each(tokens)('AC7 secret shape %#', tok => {
  const pages = [
    solution([], sections() + `\n${tok}\n`),
    good.topic.replace('title: CI', `title: "${tok}"`),
    `no frontmatter ${tok}`,
  ]
  for (const text of pages) {
    const out = scanPages([{ path: 'p.md', text }])
    expect(out[0]!.reasons).toContain('secret shape')
    expect(JSON.stringify(out)).not.toContain(tok)
  }
})

const ghp = 'ghp_' + 'a'.repeat(36)
const A = 'a'.repeat(36)
const escaped: [string, string, string][] = [
  ['hex escape in title', 'title: "\\x67hp_' + A + '"\ntopics: [ci]', ghp],
  ['unicode escape in title', 'title: "\\u0067hp_' + A + '"\ntopics: [ci]', ghp],
  ['escaped line break in title', 'title: "ghp_aaaa\\\n  ' + 'a'.repeat(32) + '"\ntopics: [ci]', ghp],
  [
    'tab in title',
    'title: "Authorization:\\tBearer ' + 'b'.repeat(24) + '"\ntopics: [ci]',
    'Bearer ' + 'b'.repeat(24),
  ],
  ['list field', 'title: T\ntopics: ["\\x67hp_' + A + '"]', ghp],
  ['superseded_by', 'title: T\ntopics: [ci]\nstatus: superseded\nsuperseded_by: "\\x67hp_' + A + '"', ghp],
]
test.each(escaped)('AC7 decoded %s', (_n, lines, tok) => {
  const out = scanPages([{ path: 'p.md', text: '---\nkind: topic\n' + lines + '\n---\nbody\n' }])
  expect(out.flatMap(o => o.reasons).filter(r => r === 'secret shape')).toHaveLength(1)
  expect(JSON.stringify(out)).not.toContain(tok)
})

test('AC7 scanPages returns only failing pages in order', () => {
  const out = scanPages([
    { path: 'a', text: good.topic },
    { path: 'b', text: 'ghp_' + 'a'.repeat(36) },
    { path: 'c', text: 'nope' },
  ])
  expect(out.map(o => o.path)).toEqual(['b', 'c'])
})

test('AC8 round trip', () => {
  for (const text of Object.values(good)) {
    const r = parse(text)
    if (!('page' in r)) throw new Error('parse failed')
    expect(parse(format(r.page, r.body))).toEqual(r)
  }
  const page: Page = { kind: 'rig', title: 'a: b # c\n---\nkind: rig', rigs: ['acme'] }
  const out = format(page, 'body\n')
  expect(out.split('\n').filter(l => l === '---')).toHaveLength(2)
  expect(parse(out)).toEqual({ page, body: 'body\n' })
})

test('S2 alias: repeated list entry is refused', () => {
  const r = parse('---\nkind: topic\ntitle: &s T\nrigs: [*s, *s]\n---\nb\n')
  expect(r).toEqual({ reasons: ['rigs: repeated entry'] })
})

test('S2 frontmatter length limit', () => {
  const head = 'kind: topic\ntitle: '
  const at = (n: number) => `---\n${head}${'a'.repeat(n - head.length)}\n---\nb\n`
  expect('page' in parse(at(4096))).toBe(true)
  expect(parse(at(4097))).toEqual({ reasons: ['frontmatter: too long'] })
})

test('S2 eyJ alias page returns fast from scanPages', () => {
  const k = 'eyJ' + 'a'.repeat(5997)
  const refs = Array(2000).fill('*s').join(',')
  const text = `---\nkind: topic\ntitle: &s ${k}\nrigs: [${refs}]\n---\nb\n`
  const out = scanPages([{ path: 'p.md', text }])
  expect(out[0]?.reasons).toContain('frontmatter: too long')
})

const NOW = Date.parse('2026-11-05T21:00:00Z')
const H = 3600_000
const D = 24 * H
const ago = (ms: number) => NOW - ms
const run = (id: string, o: Partial<RigRow> = {}): RigRow => ({
  id,
  node: 'review',
  goal: `acme-${id}: Goal ${id}`,
  bead: `acme-${id}`,
  createdAt: ago(5 * H),
  last: { node: 'triage', attempt: 1, outcome: 'build', summary: 'Did the work. More.', at: ago(H) },
  ...o,
})
const bead = (id: string, o: Partial<Bead> = {}): Bead => ({ id, title: `Bead ${id}`, ...o })
const merged = (n: number, o: Partial<Merged> = {}): Merged => ({
  url: `https://github.com/acme/widget/pull/${n}`,
  title: `Merged ${n}`,
  mergedAt: ago(D),
  ...o,
})
const page = (rows: RigRow[], waiting: string[] = [], q: Bead[] = [], m: Merged[] = []) =>
  renderRigPage('acme', rows, new Set(waiting), q, m, NOW)
const NAMES = ['Waits on a person', 'In progress', 'Queued', 'Shipped (last 7 days)', 'Stopped (last 7 days)']
const section = (text: string, name: string) => {
  const from = text.indexOf(`## ${name}\n`)
  if (from < 0) return ''
  const rest = text.slice(from + name.length + 4)
  const end = rest.search(/\n## |\nLast update/)
  return end < 0 ? rest : rest.slice(0, end)
}
const where = (text: string, needle: string) => NAMES.filter(n => section(text, n).includes(needle))
const stopped = (id: string, age: number) =>
  run(id, {
    node: 'aborted',
    last: { node: 'plan', attempt: 1, outcome: 'fail', summary: 'Stop.', at: ago(age) },
  })

test.each([
  ['waiting live row', () => page([run('w')], ['w']), 'Goal w', 'Waits on a person'],
  ['live row', () => page([run('l')]), 'Goal l', 'In progress'],
  ['queued bead', () => page([], [], [bead('acme-q')]), 'Bead acme-q', 'Queued'],
  ['merged PR', () => page([], [], [], [merged(1)]), 'Merged 1', 'Shipped (last 7 days)'],
  ['aborted row', () => page([stopped('a', D)]), 'Goal a', 'Stopped (last 7 days)'],
  ['done row', () => page([run('d', { node: 'done' })]), 'Goal d', undefined],
] as const)('AC1 state: %s', (_n, make, needle, want) => {
  expect(where(make(), needle)).toEqual(want ? [want] : [])
})

test('AC1 negative rows', () => {
  expect(where(page([run('l')], [], [bead('acme-l')]), 'Bead acme-l')).toEqual([])
  expect(where(page([run('l')], [], [bead('acme-l')]), 'Goal l')).toEqual(['In progress'])
  expect(where(page([stopped('a', D)], ['a']), 'Goal a')).toEqual(['Stopped (last 7 days)'])
  expect(where(page([run('l')], ['other']), 'Goal l')).toEqual(['In progress'])
})

test('AC2 prefix strip', () => {
  const t = (summary: string) =>
    page([run('s', { last: { node: 'x', attempt: 1, outcome: 'y', summary, at: NOW } })])
  expect(t('review#2 approve: Looks good. More text.')).toContain('— Looks good. Step:')
  expect(t('review#2 approve: Looks good. More text.')).not.toContain('review#2')
  expect(t('Fix #12 now. Done.')).toContain('— Fix #12 now. Step:')
  expect(page([run('s')])).toContain('**Goal s**')
  expect(page([run('s', { goal: 'acme-s: Add widget' })])).toContain('**Add widget**')
})

test('AC3 waiting question', () => {
  const sum = 'review#1 blocked: Checks done.\nQuestion: Merge PR 7? More.'
  const r = run('w', { last: { node: 'review', attempt: 1, outcome: 'blocked', summary: sum, at: NOW } })
  const w = section(page([r], ['w']), 'Waits on a person')
  expect(w).toContain('— Merge PR 7.')
  expect(w.trimEnd().endsWith(' · answers: owner')).toBe(true)
  const g = run('g', { gate: { question: 'Ship it?', outcomes: [] } })
  expect(section(page([g], ['g']), 'Waits on a person')).toContain('— Ship it.')
})

test('AC4 empty', () => {
  const t = page([])
  const at = NAMES.map(n => t.indexOf(`## ${n}\n\nNone.\n`))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  expect(t.endsWith('\nLast update: 2026-11-05T21:00:00Z\n')).toBe(true)
})

test('AC5 7-day cut-off', () => {
  const on = page([stopped('a', 7 * D)], [], [], [merged(1, { mergedAt: ago(7 * D) })])
  expect(where(on, 'Goal a')).toEqual(['Stopped (last 7 days)'])
  expect(where(on, 'Merged 1')).toEqual(['Shipped (last 7 days)'])
  const off = page([stopped('a', 7 * D + 1)], [], [], [merged(1, { mergedAt: ago(7 * D + 1) })])
  expect(section(off, 'Shipped (last 7 days)')).toContain('None.')
  expect(section(off, 'Stopped (last 7 days)')).toContain('None.')
})

test('AC6 stable', () => {
  const rows = [run('b', { createdAt: ago(2 * H) }), run('a'), stopped('c', D), stopped('d', 2 * D)]
  const m = [merged(1), merged(2, { mergedAt: ago(2 * D) })]
  const q = [bead('acme-q1'), bead('acme-q2')]
  const one = page(rows, ['b'], q, m)
  expect(page(rows, ['b'], q, m)).toBe(one)
  expect(page([...rows].reverse(), ['b'], q, [...m].reverse())).toBe(one)
})

test('AC7 page check', () => {
  const t = page([run('w'), run('l')], ['w'], [bead('acme-q')], [merged(1)])
  expect(scanPages([{ path: 'rigs/acme.md', text: t }])).toEqual([])
  const p = parse(t)
  expect('page' in p && p.page.kind).toBe('rig')
  expect('page' in p && p.page.rigs).toEqual(['acme'])
  expect('page' in p && p.page.updated).toBe('2026-11-05T21:00:00Z')
})

test('AC8 links', () => {
  const summary = 'See https://github.com/acme/widget/pull/123 now.'
  const r = run('l', {
    createdAt: ago(2 * H + 59 * 60_000),
    last: { node: 'x', attempt: 1, outcome: 'y', summary, at: NOW },
  })
  const t = page(
    [r, run('m', { createdAt: ago(30 * 60_000) })],
    [],
    [],
    [merged(5, { solution: 'solutions/2026-11/x.md' })],
  )
  expect(t).toContain('[review](../glossary.md#review)')
  expect(t).toContain('2 h.')
  expect(t).toContain('30 min.')
  expect(page([run('h', { createdAt: ago(90 * 60_000) })])).toContain('1 h.')
  expect(t).toContain('[PR #123](https://github.com/acme/widget/pull/123)')
  expect(t).toContain('[Solution](../solutions/2026-11/x.md)')
})

test('AC6 order: shipped newest first, in progress oldest first', () => {
  const t = page(
    [run('b', { createdAt: ago(2 * H) }), run('a')],
    [],
    [],
    [merged(2, { mergedAt: ago(2 * D) }), merged(1)],
  )
  expect(t.indexOf('Merged 1')).toBeLessThan(t.indexOf('Merged 2'))
  expect(t.indexOf('Goal a')).toBeLessThan(t.indexOf('Goal b'))
})
