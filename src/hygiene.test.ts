import { expect, test } from 'bun:test'
import { digestLines, findHygiene, hygieneHeld, proposalComment, similar, type HygieneBead } from './hygiene'
import type { MergedPr } from './prs'

const NOW = Date.parse('2026-10-20T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const bead = (id: string, o: Partial<HygieneBead> = {}): HygieneBead => ({
  id,
  title: `title of ${id}`,
  status: 'open',
  created_at: daysAgo(30),
  updated_at: daysAgo(1),
  ...o,
})
const pr = (title: string, n = 7): MergedPr => ({
  number: n,
  url: `https://github.com/acme/widget/pull/${n}`,
  title,
  headRefName: 'x',
  mergeCommit: 'abc123',
  state: 'MERGED',
})
const kinds = (bs: HygieneBead[], prs: MergedPr[] = [], recent: (id: string) => boolean = () => false) =>
  findHygiene(bs, prs, NOW, recent).map(f => `${f.id}:${f.kind}`)

test('shipped: a merged PR title citing the exact id, with URL, number and sha', () => {
  const [f] = findHygiene([bead('acme-1')], [pr('Fix acme-1: retry')], NOW)
  expect(f?.kind).toBe('shipped')
  expect(f?.evidence).toContain('https://github.com/acme/widget/pull/7')
  expect(f?.evidence).toContain('#7')
  expect(f?.evidence).toContain('abc123')
  expect(kinds([bead('acme-1')], [pr('Fix acme-1.2'), pr('Fix acme-10')])).toEqual([])
})

test('shipped: a closed child cited by a PR proves the parent when all children are closed', () => {
  const kids = [bead('acme-1.1', { status: 'closed', parent: 'acme-1' })]
  expect(kinds([bead('acme-1'), ...kids], [pr('acme-1.1 done')])).toEqual(['acme-1:shipped'])
  const open = [...kids, bead('acme-1.2', { parent: 'acme-1' })]
  expect(kinds([bead('acme-1'), ...open], [pr('acme-1.1 done')])).not.toContain('acme-1:shipped')
})

test('duplicate: the newer bead is the finding; title noise is ignored', () => {
  const a = bead('acme-1', { title: 'Widget: add retry to fetch loop', created_at: daysAgo(5) })
  const b = bead('acme-2', { title: 'widget add retry to the fetch loop', created_at: daysAgo(3) })
  expect(kinds([a, b])).toEqual(['acme-2:duplicate'])
})

test('duplicate: parent/child, same-parent siblings and short titles never match', () => {
  const t = 'Widget add retry to fetch loop'
  const p = bead('acme-1', { title: t, created_at: daysAgo(5) })
  const c = bead('acme-1.1', { title: t, parent: 'acme-1', created_at: daysAgo(3) })
  expect(kinds([p, c])).toEqual([])
  const s1 = bead('acme-9.1', { title: t, parent: 'acme-9', created_at: daysAgo(5) })
  const s2 = bead('acme-9.2', { title: t, parent: 'acme-9', created_at: daysAgo(3) })
  expect(kinds([bead('acme-9'), s1, s2])).toEqual([])
  expect(similar('Fix bug', 'Fix bug')).toBe(false)
  expect(similar('Widget add retry loop', 'Widget add cache layer')).toBe(false)
})

test('stale and deferred: 15 days is a finding, 13 is not', () => {
  expect(kinds([bead('acme-1', { updated_at: daysAgo(15) })])).toEqual(['acme-1:stale'])
  expect(kinds([bead('acme-1', { updated_at: daysAgo(13) })])).toEqual([])
  const d = (o: Partial<HygieneBead>) => bead('acme-2', { status: 'deferred', updated_at: daysAgo(15), ...o })
  expect(kinds([d({})])).toEqual(['acme-2:deferred'])
  expect(kinds([d({ assignee: 'zach' })])).toEqual([])
  expect(kinds([d({ defer_until: daysAgo(-3) })])).toEqual([])
  expect(kinds([d({ defer_until: daysAgo(3) })])).toEqual(['acme-2:deferred'])
})

test('stale: a bead with an open child is not stale', () => {
  const p = bead('acme-1', { updated_at: daysAgo(40) })
  expect(kinds([p, bead('acme-1.1', { parent: 'acme-1' })])).toEqual([])
})

test('orphan: an open child of a closed or missing parent', () => {
  const p = bead('acme-1', { status: 'closed' })
  expect(kinds([p, bead('acme-1.1', { parent: 'acme-1' })])).toEqual(['acme-1.1:orphan'])
  expect(kinds([bead('acme-5.1', { parent: 'acme-5' })])).toEqual(['acme-5.1:orphan'])
})

test('skips: recent comment, stale? label, stamp, in_progress, closed, digest', () => {
  const old = { updated_at: daysAgo(30) }
  const rows = [
    bead('acme-1', { ...old, comment_count: 1 }),
    bead('acme-2', { ...old, labels: ['stale?'] }),
    bead('acme-3', { ...old, metadata: { hygiene_proposed: 'stale@x' } }),
    bead('acme-4', { ...old, status: 'in_progress' }),
    bead('acme-5', { ...old, status: 'closed' }),
    bead('acme-6', { ...old, metadata: { hygiene_digest: '2026-10-19' } }),
  ]
  expect(kinds(rows, [], id => id === 'acme-1')).toEqual([])
  expect(kinds([rows[0]!], [], () => false)).toEqual(['acme-1:stale'])
})

test('cap: 25 candidates give 20 findings; comment lookups stop at 60', () => {
  const many = Array.from({ length: 25 }, (_, i) => bead(`acme-${i}`, { updated_at: daysAgo(30) }))
  expect(findHygiene(many, [], NOW)).toHaveLength(20)
  let calls = 0
  const talked = Array.from({ length: 80 }, (_, i) =>
    bead(`acme-${i}`, { updated_at: daysAgo(30), comment_count: 1 }),
  )
  expect(findHygiene(talked, [], NOW, () => (calls++, true))).toHaveLength(0)
  expect(calls).toBe(60)
})

test('comment text and digest: proposed close prefix, evidence clipped to 120', () => {
  const long = 'x'.repeat(300)
  const [f] = findHygiene([bead('acme-1', { title: long })], [pr(`acme-1 ${long}`)], NOW)
  expect(f!.title).toHaveLength(120)
  expect(f!.evidence.length).toBeLessThanOrEqual(120)
  expect(proposalComment(f!).startsWith('proposed close: shipped: ')).toBe(true)
  expect(digestLines([f!]).split('\n')).toHaveLength(1)
})

test('hygieneHeld: stale? with shipped or duplicate holds; stale does not', () => {
  const h = (p: string, l = ['factory', 'stale?']) =>
    hygieneHeld(bead('acme-1', { labels: l, metadata: { hygiene_proposed: p } }))
  expect(h('shipped@2026-10-20')).toBe(true)
  expect(h('duplicate@2026-10-20')).toBe(true)
  expect(h('stale@2026-10-20')).toBe(false)
  expect(h('shipped@2026-10-20', ['factory'])).toBe(false)
})
