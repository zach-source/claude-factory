import { expect, test } from 'bun:test'
import { findHygiene, type HygieneBead } from './hygiene'
import type { MergedPr } from './prs'

const NOW = Date.parse('2026-10-20T00:00:00Z')
const bead = (id: string): HygieneBead => ({
  id,
  title: `title of ${id}`,
  status: 'open',
  created_at: new Date(NOW - 30 * 86_400_000).toISOString(),
  updated_at: new Date(NOW - 86_400_000).toISOString(),
})
const pr = (title: string, headRefName = 'x'): MergedPr => ({
  number: 7,
  url: 'https://github.com/acme/widget/pull/7',
  title,
  headRefName,
  mergeCommit: 'abc123',
  state: 'MERGED',
})
const ids = (bs: HygieneBead[], prs: MergedPr[], branches: (id: string) => string[] = () => []) =>
  findHygiene(bs, prs, NOW, () => false, 20, branches).map(f => f.id)

test('shipped: short id as a whole item inside parentheses', () => {
  const bs = [bead('acme-192.4'), bead('acme-192.40'), bead('acme-192.5'), bead('acme-192.6')]
  expect(ids(bs, [pr('Ship it (192.4, 192.5)')])).toEqual(['acme-192.4', 'acme-192.5'])
})

test('shipped: no match for a longer sibling or a bare number', () => {
  expect(ids([bead('acme-192.4')], [pr('Ship it (192.40)')])).toEqual([])
  expect(ids([bead('acme-192.4')], [pr('Ship 192.4 now')])).toEqual([])
})

test('shipped: a merged PR on the run branch of the bead', () => {
  const p = pr('no id here', 'factory/run-1')
  expect(ids([bead('acme-1')], [p], id => (id === 'acme-1' ? ['factory/run-1'] : []))).toEqual(['acme-1'])
  expect(ids([bead('acme-1')], [p])).toEqual([])
})
