import { describe, expect, test } from 'bun:test'
import type { Bead } from './beads'
import { repairs, type PrFact } from './repairs'

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({ id, title: id, status: 'open', ...extra })
const pr = (number: number, state: string, extra: Partial<PrFact> = {}): PrFact => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  ...extra,
})
const run = (every: Bead[], prs: PrFact[] = [], live: string[] = []) =>
  repairs('rig', every, prs, new Set(live), Date.now())

describe('repairs', () => {
  test('closes a bead whose ship_pr is merged', () => {
    const b = bead('a-1', { labels: ['ship'], metadata: { ship_pr: pr(5, 'MERGED').url } })
    expect(run([b], [pr(5, 'MERGED')])).toEqual([
      { kind: 'close', id: 'a-1', reason: 'shipped: https://github.com/o/r/pull/5 is merged' },
    ])
  })

  test('closes a bead whose ship_branch is a merged head branch', () => {
    const b = bead('a-2', { labels: ['ship'], metadata: { ship_branch: 'factory/lifecycle-x' } })
    expect(run([b], [pr(7, 'MERGED', { headRefName: 'factory/lifecycle-x' })]).map(r => r.id)).toEqual([
      'a-2',
    ])
    expect(run([b], [pr(7, 'OPEN', { headRefName: 'factory/lifecycle-x' })])).toEqual([])
  })

  test('a merged PR that only names a bead in its body or branch closes nothing', () => {
    expect(run([bead('a-1')], [pr(6, 'MERGED', { body: 'Fixes a-1. Follow-up: a-6.' })])).toEqual([])
    expect(run([bead('a-2')], [pr(7, 'MERGED', { headRefName: 'factory/a-2' })])).toEqual([])
  })

  test('closes an epic whose children are all closed, unless a run is live', () => {
    const all = [bead('e-1'), bead('e-1.1', { parent: 'e-1', status: 'closed' })]
    expect(run(all)).toEqual([{ kind: 'close', id: 'e-1', reason: 'every child is closed' }])
    expect(run(all, [], ['e-1'])).toEqual([])
    expect(run([bead('e-1'), bead('e-1.1', { parent: 'e-1' })])).toEqual([])
  })

  test('a ship-queued epic with closed children is not closed as "every child is closed"', () => {
    const kid = bead('e-2.1', { parent: 'e-2', status: 'closed' })
    const queued = (n: number, state: string) =>
      bead('e-2', { labels: ['ship'], metadata: { ship_pr: pr(n, state).url } })
    expect(run([queued(9, 'OPEN'), kid], [pr(9, 'OPEN', { isDraft: true })])).toEqual([])
    expect(run([queued(9, 'MERGED'), kid], [pr(9, 'MERGED')])).toEqual([
      { kind: 'close', id: 'e-2', reason: 'shipped: https://github.com/o/r/pull/9 is merged' },
    ])
  })

  test('closes a rejected bead that says done and cites a merged PR or a commit', () => {
    const rej = (reason: string) => bead('r-1', { labels: ['rejected'], metadata: { reject_reason: reason } })
    expect(run([rej('already fixed in #9')], [pr(9, 'MERGED')])[0]?.reason).toContain('pull/9')
    expect(run([rej('duplicate: done in commit 3fa9c21')])[0]?.reason).toContain('3fa9c21')
    expect(run([rej('already fixed in #9')], [pr(9, 'OPEN')])).toEqual([])
    expect(run([rej('already fixed, trust me')])).toEqual([])
    expect(run([rej('not our job, see deadbeef')])).toEqual([])
    expect(run([bead('r-2', { metadata: { reject_reason: 'already done in 3fa9c21' } })])).toEqual([])
  })

  test('strips ship and defers a bead whose PR closed unmerged', () => {
    const b = bead('s-1', { labels: ['ship'], metadata: { ship_pr: pr(8, 'CLOSED').url } })
    expect(run([b], [pr(8, 'CLOSED')])).toEqual([
      { kind: 'unship', id: 's-1', reason: 'https://github.com/o/r/pull/8 was closed unmerged' },
    ])
    expect(run([b], [pr(8, 'OPEN')])).toEqual([])
  })

  test('releases a claim held by a factory run that is not live and whose lease expired', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    const held = (id: string, assignee: string, lease: string, extra: Partial<Bead> = {}) =>
      bead(id, { status: 'in_progress', assignee, lease_expires_at: lease, ...extra })
    const every = [
      held('c-1', 'factory/lifecycle-dead', past),
      held('c-2', 'factory/lifecycle-dead', future), // the lease still runs
      held('c-3', 'Zach Taylor', past), // a person's claim
      held('c-4', 'factory/lifecycle-live', past), // a live run owns it
      // released first: bd refuses to close a bead that another actor holds
      held('c-5', 'factory/lifecycle-dead', past, { metadata: { ship_pr: pr(5, 'MERGED').url } }),
    ]
    expect(run(every, [pr(5, 'MERGED')], ['c-4'])).toEqual([
      {
        kind: 'release',
        id: 'c-1',
        reason: `factory/lifecycle-dead is not live and its lease expired at ${past}`,
      },
      {
        kind: 'release',
        id: 'c-5',
        reason: `factory/lifecycle-dead is not live and its lease expired at ${past}`,
      },
    ])
  })

  test('skips closed, deferred and live beads, and gives one action to a bead', () => {
    const merged = pr(5, 'MERGED')
    const shipped = { metadata: { ship_pr: merged.url } }
    const every = [
      bead('a-1', { status: 'closed', ...shipped }),
      bead('a-2', { status: 'deferred', ...shipped }),
      bead('a-3', shipped),
      bead('a-4', shipped),
    ]
    expect(run(every, [merged], ['a-3']).map(r => r.id)).toEqual(['a-4'])
  })
})
