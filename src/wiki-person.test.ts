// humanLines, tombstones and flagLine (claude-factory-tx6c.3): pure table tests.
import { expect, test } from 'bun:test'
import { flagLine, humanLines, tombstones } from './wiki'

/** blame --line-porcelain text: one record per line; `by` is the author mail, or undefined for none */
const blame = (rows: [string, string | undefined][]) =>
  rows
    .map(
      ([text, by], i) =>
        `${'a'.repeat(40)} ${i + 1} ${i + 1}${i ? '' : ` ${rows.length}`}\nauthor x\n${by === undefined ? '' : `author-mail <${by}>\n`}summary s\n\t${text}\n`,
    )
    .join('')
const F = 'factory@host.acme'
const P = 'person@acme.example'

test('humanLines lists each person line that the new text changed or removed', () => {
  const b = blame([
    ['a', P],
    ['b', F],
    ['c', P],
  ])
  const got = (before: string, after: string) => humanLines(before, after, F).map(h => h.line)
  expect(got(b, 'a\nb\nc\n')).toEqual([])
  expect(got(b, 'a\nb\nX\n')).toEqual([3])
  expect(got(b, 'a\nb\n')).toEqual([3])
  expect(got(b, '')).toEqual([1, 3])
  expect(got(b, 'a\nX\nc\n')).toEqual([])
  expect(got(b, 'a\nb\nc\nnew\n')).toEqual([])
  expect(got(b, 'new\na\nb\nc\n')).toEqual([])
  expect(
    got(
      blame([
        ['a', P],
        ['b', P],
      ]),
      'b\na\n',
    ),
  ).toHaveLength(1)
  expect(humanLines(b, 'a\nb\nX\n', F)[0]).toEqual({ line: 3, text: 'c' })
})

test('humanLines treats an unknown author as a person and fails closed', () => {
  for (const by of [undefined, 'not.committed.yet', 'Factory@host.acme', 'factory@host.acme.evil', ''])
    expect(humanLines(blame([['a', by]]), 'X\n', F).length).toBe(1)
  expect(humanLines('junk', 'X\n', F)).toEqual([])
  const big = blame(Array.from({ length: 2100 }, (_, i) => [`l${i}`, P] as [string, string]))
  const after = `${Array.from({ length: 2100 }, (_, i) => `m${i}`).join('\n')}\n`
  expect(humanLines(big, after, F).length).toBe(2100)
})

const H = (e: string, d: string, sha?: string) => `\x01${e}\x01${d}${sha === undefined ? '' : `\x01${sha}`}`
test('tombstones keeps the page paths that a person deleted, with the newest date', () => {
  const log = [
    H(P, '2026-11-02T10:00:00+00:00'),
    'D\tsolutions/a.md',
    'D\tb.md',
    H(P, '2026-11-01T10:00:00+00:00'),
    'D\tsolutions/a.md',
    '',
    H(F, '2026-11-03T10:00:00+00:00'),
    'D\tfactory-gone.md',
    H(P, '2026-11-01T10:00:00+00:00'),
    'D\trigs/acme.md',
    'D\t"q\\303.md"',
    'D\t../x.md',
    'D\ta/../x.md',
    'D\tnotes.txt',
  ].join('\n')
  expect(tombstones(log, F, () => true)).toEqual([
    { path: 'solutions/a.md', at: '2026-11-02T10:00:00+00:00' },
    { path: 'b.md', at: '2026-11-02T10:00:00+00:00' },
  ])
  expect(tombstones('', F, () => true)).toEqual([])
  expect(
    tombstones(
      `${H(P, 'junk')}\nD\tb.md\n${H(P, '2026-11-01T10:00:00Z')}\x01x\x01y\nD\tc.md\n`,
      F,
      () => true,
    ),
  ).toEqual([])
  expect(tombstones('D\tb.md\n', F, () => true)).toEqual([])
})

const D1 = '2026-11-01T10:00:00+00:00'
const A1 = '2026-11-02T10:00:00+00:00'
const D2 = '2026-11-03T10:00:00+00:00'
const ev = (...x: [string, string, string][]) =>
  [...x]
    .reverse()
    .map(([e, d, l], i) => `${H(e, d, `s${i}`)}\n${l}`)
    .join('\n')
test('tombstones lifts an older person delete when a newer person add follows', () => {
  const rows: [string, string, { path: string; at: string }[]][] = [
    ['delete only', ev([P, D1, 'D\tb.md']), [{ path: 'b.md', at: D1 }]],
    ['person add lifts', ev([P, D1, 'D\tb.md'], [P, A1, 'A\tb.md']), []],
    ['person add lifts, factory delete', ev([P, D1, 'D\tb.md'], [P, A1, 'A\tb.md'], [F, D2, 'D\tb.md']), []],
    [
      'person delete, then factory delete',
      ev([P, D1, 'D\tb.md'], [F, D2, 'D\tb.md']),
      [{ path: 'b.md', at: D1 }],
    ],
    ['factory add never lifts', ev([P, D1, 'D\tb.md'], [F, A1, 'A\tb.md']), [{ path: 'b.md', at: D1 }]],
    ['older add changes nothing', ev([P, D1, 'A\tb.md'], [P, A1, 'D\tb.md']), [{ path: 'b.md', at: A1 }]],
    [
      'delete, add, delete',
      ev([P, D1, 'D\tb.md'], [P, A1, 'A\tb.md'], [P, D2, 'D\tb.md']),
      [{ path: 'b.md', at: D2 }],
    ],
    ['same date, log order decides', ev([P, D1, 'D\tb.md'], [P, D1, 'A\tb.md']), []],
    [
      'add dated older than the delete, later in order, lifts',
      ev([P, A1, 'D\tb.md'], [P, D1, 'A\tb.md']),
      [],
    ],
    [
      'delete dated older than the add, later in order, stays',
      ev([P, D2, 'A\tb.md'], [P, D1, 'D\tb.md']),
      [{ path: 'b.md', at: D1 }],
    ],
    ['bad header before an add', ev([P, D1, 'D\tb.md'], [P, 'junk', 'A\tb.md']), [{ path: 'b.md', at: D1 }]],
    [
      '4-field header before an add',
      `${ev([P, D1, 'D\tb.md'])}\n${H(P, A1)}\x01x\x01y\nA\tb.md`,
      [{ path: 'b.md', at: D1 }],
    ],
  ]
  for (const [name, log, want] of rows) expect([name, tombstones(log, F, () => true)]).toEqual([name, want])
})

test('tombstones ignores every line outside the A and D grammar', () => {
  const head = `${H(P, D1, 'd')}\n`
  for (const l of ['b.md', 'M\tb.md', 'R100\ta.md\tb.md', 'D\t"q\\303.md"', 'D b.md', 'd\tb.md'])
    expect([l, tombstones(head + l, F, () => true)]).toEqual([l, []])
  expect(tombstones(`${head}D\tb.md`, F, () => true)).toEqual([{ path: 'b.md', at: D1 }])
  const tail = `\n${head}D\tb.md`
  for (const l of ['M\tb.md', 'a\tb.md', 'A b.md', 'b.md'])
    expect([l, tombstones(`${H(P, A1, 'a')}\n${l}${tail}`, F, () => true)]).toEqual([
      l,
      [{ path: 'b.md', at: D1 }],
    ])
  expect(tombstones(`${H(P, A1, 'a')}\nA\tb.md${tail}`, F, () => true)).toEqual([])
})

test('flagLine masks a token and keeps one line of at most 200 characters', () => {
  expect(flagLine('a.md', 3, 'why')).toBe('- `a.md` line 3: why')
  const f = flagLine('a.md', 3, `x\ny ghp_${'zq'.repeat(18)} ${'w'.repeat(300)}`)
  expect(f).not.toContain('\n')
  expect(f).not.toContain('ghp_')
  expect(f.length).toBeLessThanOrEqual('- `a.md` line 3: '.length + 200)
})

test('tombstones keeps a person delete that is not an ancestor of the newest person add', () => {
  const log = `${H(P, A1)}\x01aaa\nA\tb.md\n${H(P, D1)}\x01ddd\nD\tb.md\n`
  expect(tombstones(log, F, () => true)).toEqual([])
  expect(tombstones(log, F, (d, a) => [d, a].join() !== 'ddd,aaa')).toEqual([{ path: 'b.md', at: D1 }])
})

test('tombstones fails closed when a sha is missing or the delete is not an ancestor', () => {
  const D = (sha?: string) => `${H(P, D1, sha)}\nD\tb.md`
  const A = (sha?: string) => `${H(P, A1, sha)}\nA\tb.md`
  const keep = [{ path: 'b.md', at: D1 }]
  const rows: [string, string, () => boolean, { path: string; at: string }[]][] = [
    ['no sha on the add', `${A()}\n${D('d')}`, () => true, keep],
    ['empty sha on the add', `${A('')}\n${D('d')}`, () => true, keep],
    ['no sha on the delete', `${A('a')}\n${D()}`, () => true, keep],
    ['not an ancestor', `${A('a')}\n${D('d')}`, () => false, keep],
    ['ancestor, both shas', `${A('a')}\n${D('d')}`, () => true, []],
    ['add only, no sha', A(), () => true, []],
  ]
  for (const [name, log, cb, want] of rows) expect([name, tombstones(log, F, cb)]).toEqual([name, want])
})
