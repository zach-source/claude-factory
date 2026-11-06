import { describe, expect, test } from 'bun:test'
import { cacheFile, nextSnapshot, type Snapshot } from './ui'
import type { Issue } from './ui-data'

const issues: Issue[] = [{ id: 'a', title: 'a', status: 'open', issue_type: 'task' }]
const prev = (o: Partial<Snapshot> = {}): Snapshot => ({
  hash: 'h1',
  asOf: 100,
  issues,
  view: {
    totals: { closed: 0, in_progress: 0, blocked: 0, deferred: 0, open: 1, total: 1 },
    overall: { closed: 0, in_progress: 0, blocked: 0, deferred: 0, open: 0, total: 0 },
    epics: [],
    epicRows: [],
    oneOffs: 1,
    needs: [],
  },
  sync: { state: 'ok', at: 100 },
  ...o,
})
const run = (
  p: Snapshot,
  hash: string | null,
  sync: Snapshot['sync'],
  r: Awaited<ReturnType<typeof deps0>> = { issues: [] },
) => {
  const calls = { list: 0 }
  return nextSnapshot(p, sync, {
    hash: async () => hash,
    list: async () => (calls.list++, r),
    now: () => 500,
  }).then(s => ({ s, calls }))
}
const deps0 = async (): Promise<{ issues: Issue[] } | { error: string }> => ({ issues: [] })
const ok = { state: 'ok', at: 500 } as const

describe('nextSnapshot (skip work that did not change)', () => {
  test('same hash: no bd list, as-of moves to now', async () => {
    const { s, calls } = await run(prev(), 'h1', ok)
    expect(calls.list).toBe(0)
    expect(s.asOf).toBe(500)
    expect(s.issues).toBe(issues)
  })
  test('new hash: bd list runs and the rows change', async () => {
    const { s, calls } = await run(prev(), 'h2', ok, { issues: [...issues, { id: 'b', title: 'b' }] })
    expect(calls.list).toBe(1)
    expect(s.hash).toBe('h2')
    expect(s.view.totals.total).toBe(2)
  })
  test('no hash from bd: it reads every time', async () => {
    const { calls } = await run(prev(), null, ok)
    expect(calls.list).toBe(1)
  })
  test('an empty cache (no hash) reads', async () => {
    const { calls } = await run(prev({ hash: null }), 'h1', ok)
    expect(calls.list).toBe(1)
  })
  test('same hash after a read error: it reads again', async () => {
    const { calls } = await run(prev({ error: 'boom' }), 'h1', ok)
    expect(calls.list).toBe(1)
  })
  test('failed sync: as-of stays, so the card turns stale', async () => {
    const { s } = await run(prev(), 'h1', { state: 'failed', at: 500, message: 'x' })
    expect(s.asOf).toBe(100)
    expect(s.sync.state).toBe('failed')
  })
  test('failed read: old rows stay and the error shows', async () => {
    const { s } = await run(prev(), 'h2', ok, { error: 'bd list failed' })
    expect(s.issues).toBe(issues)
    expect(s.error).toBe('bd list failed')
    expect(s.hash).toBe('h1')
  })
})

describe('cacheFile', () => {
  test('keeps a safe name', () => expect(cacheFile('/c', 'claude-factory')).toBe('/c/claude-factory.json'))
  test('a path in a rig name cannot leave the folder', () =>
    expect(cacheFile('/c', '../x/y')).toBe('/c/.._x_y.json'))
})
