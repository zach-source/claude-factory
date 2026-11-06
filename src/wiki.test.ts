import { expect, test } from 'bun:test'
import { format, parse, scanPages, SECTIONS, type Page } from './wiki'

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
    expect('page' in r && r.page.kind).toBe(kind)
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
