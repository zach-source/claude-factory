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

const H = (e: string, d: string) => `\x01${e}\x01${d}`
test('tombstones keeps the page paths that a person deleted, with the newest date', () => {
  const log = [
    H(P, '2026-11-01T10:00:00+00:00'),
    'solutions/a.md',
    H(P, '2026-11-02T10:00:00+00:00'),
    'solutions/a.md',
    'b.md',
    '',
    H(F, '2026-11-03T10:00:00+00:00'),
    'factory-gone.md',
    H(P, '2026-11-01T10:00:00+00:00'),
    'rigs/acme.md',
    '"q\\303.md"',
    '../x.md',
    'a/../x.md',
    'notes.txt',
  ].join('\n')
  expect(tombstones(log, F)).toEqual([
    { path: 'solutions/a.md', at: '2026-11-02T10:00:00+00:00' },
    { path: 'b.md', at: '2026-11-02T10:00:00+00:00' },
  ])
  expect(tombstones('', F)).toEqual([])
  expect(tombstones(`${H(P, 'junk')}\nb.md\n${H(P, '2026-11-01T10:00:00Z')}\x01x\nc.md\n`, F)).toEqual([])
  expect(tombstones('b.md\n', F)).toEqual([])
})

test('flagLine masks a token and keeps one line of at most 200 characters', () => {
  expect(flagLine('a.md', 3, 'why')).toBe('- `a.md` line 3: why')
  const f = flagLine('a.md', 3, `x\ny ghp_${'zq'.repeat(18)} ${'w'.repeat(300)}`)
  expect(f).not.toContain('\n')
  expect(f).not.toContain('ghp_')
  expect(f.length).toBeLessThanOrEqual('- `a.md` line 3: '.length + 200)
})
