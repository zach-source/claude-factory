import { describe, expect, test } from 'bun:test'
import type { Bead } from './beads'
import type { PrFact } from './repairs'
import { digestText, shipSub, stateOf, type DigestRig, type StateCtx } from './state'

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({
  id,
  title: `title ${id}`,
  status: 'open',
  ...extra,
})
const url = (n: number) => `https://github.com/o/r/pull/${n}`
const pr = (n: number, state: string, isDraft = false): PrFact => ({ number: n, url: url(n), state, isDraft })
const ctx = (extra: Partial<StateCtx> = {}): StateCtx => ({ live: new Map(), prs: [], ...extra })

describe('stateOf', () => {
  test('done and deferred come first', () => {
    expect(stateOf(bead('a', { status: 'closed', labels: ['ship'] }), ctx())).toBe('done')
    expect(stateOf(bead('a', { status: 'deferred', labels: ['factory'] }), ctx())).toBe('deferred')
  })

  test('a live run is running, or waiting on the owner when parked blocked', () => {
    const live = new Map([
      ['a', { blocked: false }],
      ['b', { blocked: true }],
    ])
    expect(stateOf(bead('a', { labels: ['factory'] }), ctx({ live }))).toBe('running')
    expect(stateOf(bead('b', { labels: ['factory'] }), ctx({ live }))).toBe('waiting-on-owner')
  })

  test('the owner label waits on the owner', () => {
    expect(stateOf(bead('a', { labels: ['owner'] }), ctx())).toBe('waiting-on-owner')
  })

  test('a ship bead is in-ship until its PR merges', () => {
    const b = bead('a', { labels: ['ship'], metadata: { ship_pr: url(3) } })
    expect(stateOf(b, ctx({ prs: [pr(3, 'OPEN', true)] }))).toBe('in-ship')
    expect(shipSub(b, ctx({ prs: [pr(3, 'OPEN', true)] }))).toBe('draft')
    expect(shipSub(b, ctx({ prs: [pr(3, 'OPEN')] }))).toBe('ready')
    expect(shipSub(b, ctx())).toBe('unknown')
    expect(stateOf(b, ctx({ prs: [pr(3, 'MERGED')] }))).toBe('shipped-not-closed')
  })

  test('rejected, queued and unowned', () => {
    expect(stateOf(bead('a', { labels: ['rejected'] }), ctx())).toBe('rejected-open')
    expect(stateOf(bead('a', { labels: ['factory'] }), ctx())).toBe('queued')
    expect(stateOf(bead('a', { labels: ['factory:other'] }), ctx())).toBe('queued')
    expect(stateOf(bead('a'), ctx())).toBe('unowned')
  })
})

describe('digestText', () => {
  const now = Date.parse('2026-01-02T00:00:00Z')
  const rig: DigestRig = {
    name: 'demo',
    slug: 'o/r',
    beads: [
      bead('a', { labels: ['factory'] }),
      bead('b', { priority: 1, created_at: '2026-01-01T00:00:00Z', labels: ['owner'] }),
      bead('c', { status: 'closed' }),
      bead('d', { labels: ['ship'], metadata: { ship_pr: url(4) } }),
      bead('e', { labels: ['ship'], metadata: { ship_pr: url(5) } }),
    ],
    ctx: ctx({ prs: [pr(4, 'OPEN'), pr(5, 'OPEN', true)] }),
    queue: [bead('d', { metadata: { ship_pr: url(4) } }), bead('e', { metadata: { ship_pr: url(5) } })],
  }

  test('counts, owner queue, merge lines and recent repairs', () => {
    const text = digestText(
      [rig],
      [
        { at: '2026-01-01T10:00:00Z', rig: 'demo', id: 'x', kind: 'close', reason: 'shipped' },
        { at: '2026-01-01T11:00:00Z', rig: 'demo', id: 'y', kind: 'close', reason: 'every child is closed' },
      ],
      now,
    )
    expect(text).toContain('demo: queued 1, waiting-on-owner 1, in-ship 2')
    expect(text).not.toContain('done')
    expect(text).toContain('  b P1 1d title b')
    expect(text).toContain('  gh pr merge 4 -R o/r --merge  # d')
    expect(text).not.toContain('gh pr merge 5')
    expect(text).toContain(
      'recent repairs:\n  2026-01-01T10:00 demo close x: shipped\n  2026-01-01T11:00 demo close y: every child is closed',
    )
  })
})
