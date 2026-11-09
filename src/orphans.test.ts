import { expect, test } from 'bun:test'
import {
  ciVerdict,
  ORPHAN_CAP,
  ORPHAN_CHECKS_MAX,
  orphanNote,
  orphanSkip,
  orphanSweep,
  type OrphanCtx,
  type OrphanIo,
  type OrphanPr,
} from './orphans'

const SHA = 'a'.repeat(40)
const green = { pass: 3, fail: 0, pending: 0 }
const pr = (n = 1, over: Partial<OrphanPr> = {}): OrphanPr => ({
  number: n,
  url: `https://github.com/acme/widget/pull/${n}`,
  headRefName: `factory/run-${n}`,
  headRefOid: SHA,
  isDraft: true,
  isCrossRepository: false,
  ...over,
})
const ctx = (over: Partial<OrphanCtx> = {}, ids = [1, 2, 3, 4, 5, 6, 7, 8]): OrphanCtx => ({
  runs: new Map(ids.map(n => [`run-${n}`, { bead: `bd-${n}` }])),
  liveBeads: new Set(),
  owner: () => undefined,
  queued: () => false,
  records: {},
  ...over,
})
const io = (over: Partial<OrphanIo> = {}) => {
  const calls = {
    checks: 0,
    fork: [] as [string, string, string][],
    record: [] as string[],
    close: [] as [string, string][],
    label: [] as [string, string[]][],
  }
  const o: OrphanIo = {
    bead: async () => ({ status: 'open' }),
    checks: async () => (calls.checks++, green),
    fork: async (p, src, note) => (calls.fork.push([p.url, src, note]), `fork-${p.number}`),
    record: p => void calls.record.push(p.url),
    view: async () => ({ mergeable: 'MERGEABLE', changes: false, approved: false }),
    label: async (p, labels) => void calls.label.push([p.url, labels]),
    close: async (p, body) => void calls.close.push([p.url, body]),
    ...over,
  }
  return { o, calls }
}

test('AC1: a green orphan draft gets one fork from its source run, with a note naming the URL and the SHA', async () => {
  const { o, calls } = io()
  const res = await orphanSweep([pr()], ctx(), o, ORPHAN_CAP)
  expect(res.forked).toEqual([{ url: pr().url, run: 'fork-1' }])
  expect(calls.fork).toEqual([[pr().url, 'run-1', orphanNote(pr())]])
  expect(orphanNote(pr())).toContain(pr().url)
  expect(orphanNote(pr())).toContain(SHA)
  expect(calls.record).toEqual([pr().url, pr().url]) // the attempt, then the run id
})

const rows: [string, OrphanPr, Partial<OrphanCtx>, Partial<OrphanIo>][] = [
  ['live owner by branch or report link', pr(), { owner: () => 'run-9' }, {}],
  ['a live run on the same bead', pr(), { liveBeads: new Set(['bd-1']) }, {}],
  ['ship-queued', pr(), { queued: () => true }, {}],
  [
    'source run ended at a decision',
    pr(),
    { runs: new Map([['run-1', { bead: 'bd-1', decided: true }]]) },
    {},
  ],
  ['bd show null', pr(), {}, { bead: async () => null }],
  ['CI pending', pr(), {}, { checks: async () => ({ pass: 1, fail: 0, pending: 1 }) }],
  ['checks call null', pr(), {}, { checks: async () => null }],
  ['not a draft', pr(1, { isDraft: false }), {}, {}],
  ['cross-repository', pr(1, { isCrossRepository: true }), {}, {}],
  ['branch not factory/*', pr(1, { headRefName: 'feature/run-1' }), {}, {}],
  ['branch with a slash tail', pr(1, { headRefName: 'factory/run-1/x' }), {}, {}],
  ['no run dir', pr(1, { headRefName: 'factory/gone' }), {}, {}],
  ['short SHA', pr(1, { headRefOid: 'abc1234' }), {}, {}],
  ['empty SHA', pr(1, { headRefOid: '' }), {}, {}],
  ['upper-case SHA', pr(1, { headRefOid: 'A'.repeat(40) }), {}, {}],
]
for (const [name, p, c, i] of rows)
  test(`AC2: ${name} gives 0 forks`, async () => {
    const { o, calls } = io(i)
    const res = await orphanSweep([p], ctx(c), o, ORPHAN_CAP)
    expect(res.forked).toEqual([])
    expect(calls.fork).toEqual([])
    expect(res.skipped).toHaveLength(1)
  })

test('AC2: zero checks, and a run with no bead, are allowed', async () => {
  const zero = io({ checks: async () => ({ pass: 0, fail: 0, pending: 0 }) })
  const noBead = ctx({ runs: new Map([['run-1', {}]]) })
  const res = await orphanSweep([pr()], noBead, zero.o, ORPHAN_CAP)
  expect(res.forked).toHaveLength(1)
})

test('a run with no bead makes no bd call', async () => {
  const { o } = io({
    bead: async () => {
      throw new Error('bd called')
    },
  })
  const res = await orphanSweep([pr()], ctx({ runs: new Map([['run-1', {}]]) }), o, ORPHAN_CAP)
  expect(res.forked).toHaveLength(1)
})

test('orphanSkip reasons come before any io', () => {
  expect(orphanSkip(pr(), ctx())).toBeUndefined()
  expect(orphanSkip(pr(1, { isDraft: false }), ctx())).toBe('not a draft')
  expect(
    orphanSkip(pr(), ctx({ records: { [pr().url]: { sha: SHA, run: 'x', from: 'run-1', at: '' } } })),
  ).toBe('already forked at this head')
})

test('AC3: a second pass with the records forks 0; a new head SHA forks again', async () => {
  const records: OrphanCtx['records'] = {}
  const first = io({
    record: (p, from, run) => void (records[p.url] = { sha: p.headRefOid, run, from, at: 'now' }),
  })
  expect((await orphanSweep([pr()], ctx({ records }), first.o, ORPHAN_CAP)).forked).toHaveLength(1)
  const second = io()
  expect((await orphanSweep([pr()], ctx({ records }), second.o, ORPHAN_CAP)).forked).toHaveLength(0)
  expect(second.calls.checks).toBe(0)
  const pushed = pr(1, { headRefOid: 'b'.repeat(40) })
  expect((await orphanSweep([pushed], ctx({ records }), second.o, ORPHAN_CAP)).forked).toHaveLength(1)
})

test('a fork that throws is recorded: 1 fork call over 2 passes, and the next PR still forks', async () => {
  const records: OrphanCtx['records'] = {}
  const forks: number[] = []
  const o = io({
    record: (p, from, run) => void (records[p.url] = { sha: p.headRefOid, run, from, at: 'now' }),
    fork: async p => {
      forks.push(p.number)
      if (p.number === 1) throw new Error('boom')
      return `fork-${p.number}`
    },
  }).o
  const first = await orphanSweep([pr(1), pr(2)], ctx({ records }), o, ORPHAN_CAP)
  expect(first.skipped).toEqual([{ url: pr(1).url, why: 'fork failed: boom' }])
  expect(first.forked).toEqual([{ url: pr(2).url, run: 'fork-2' }])
  await orphanSweep([pr(1), pr(2)], ctx({ records }), o, ORPHAN_CAP)
  expect(forks).toEqual([1, 2])
})

test('a record write that fails stops that PR before the fork', async () => {
  const f = io({
    record: () => {
      throw new Error('disk')
    },
  })
  const res = await orphanSweep([pr()], ctx(), f.o, ORPHAN_CAP)
  expect(f.calls.fork).toHaveLength(0)
  expect(res.skipped[0]!.why).toBe('record failed: disk')
})

test('AC4: 5 green orphans give ORPHAN_CAP forks; cap 1 gives 1; cap 0 gives 0 and no checks call', async () => {
  const five = [1, 2, 3, 4, 5].map(n => pr(n))
  const a = io()
  expect((await orphanSweep(five, ctx(), a.o, ORPHAN_CAP)).forked).toHaveLength(2)
  expect(ORPHAN_CAP).toBe(2)
  const b = io()
  expect((await orphanSweep(five, ctx(), b.o, 1)).forked).toHaveLength(1)
  const c = io()
  expect((await orphanSweep(five, ctx(), c.o, 0, 0)).forked).toHaveLength(0)
  expect(c.calls.checks).toBe(0)
})

test('AC4: skipped rows use no cap slot', async () => {
  const rows = [pr(1, { isDraft: false }), pr(2, { isCrossRepository: true }), pr(3), pr(4)]
  const { o } = io()
  const res = await orphanSweep(rows, ctx(), o, ORPHAN_CAP)
  expect(res.forked.map(f => f.run)).toEqual(['fork-3', 'fork-4'])
})

test('AC5: at most ORPHAN_CHECKS_MAX checks calls per pass; no-io skips come first', async () => {
  const red = io({ checks: async () => ({ pass: 0, fail: 1, pending: 0 }) })
  const many = [1, 2, 3, 4, 5, 6, 7, 8].map(n => pr(n))
  let calls = 0
  const counted: OrphanIo = {
    ...red.o,
    checks: async p => (calls++, red.o.checks(p)),
  }
  await orphanSweep(many, ctx(), counted, ORPHAN_CAP)
  expect(calls).toBe(ORPHAN_CHECKS_MAX)
  expect(ORPHAN_CHECKS_MAX).toBe(6)
  // draft rows that need no io never reach the lookup
  calls = 0
  await orphanSweep([...many.map(p => ({ ...p, isDraft: false })), pr(1)], ctx(), counted, ORPHAN_CAP)
  expect(calls).toBe(1)
})

test('a second record write that fails after a good fork is reported as record failed, with the fork', async () => {
  let n = 0
  const f = io({
    record: () => {
      if (++n === 2) throw new Error('disk')
    },
  })
  const res = await orphanSweep([pr()], ctx(), f.o, ORPHAN_CAP)
  expect(res.forked).toHaveLength(1)
  expect(res.skipped[0]!.why).toMatch(/^record failed after fork .*: disk$/)
})

test('ciVerdict: null is unknown, fail wins over pending, zero checks are green', () => {
  expect(ciVerdict(null)).toBe('unknown')
  expect(ciVerdict({ pass: 0, fail: 1, pending: 1 })).toBe('red')
  expect(ciVerdict({ pass: 1, fail: 0, pending: 1 })).toBe('pending')
  expect(ciVerdict({ pass: 0, fail: 0, pending: 0 })).toBe('green')
})

// claude-factory-e2xe: the bead decides what happens to an orphan draft
const sweep = (
  prs: OrphanPr[],
  c: Partial<OrphanCtx>,
  i: Partial<OrphanIo>,
  cap = ORPHAN_CAP,
  acts = ORPHAN_CAP,
) => {
  const x = io(i)
  return orphanSweep(prs, ctx(c), x.o, cap, acts).then(res => ({ res, calls: x.calls }))
}
const red = async () => ({ pass: 1, fail: 1, pending: 0 })

for (const status of ['closed', 'deferred'])
  test(`e2xe: a ${status} bead closes the PR with a comment that names the run and the bead state`, async () => {
    const { res, calls } = await sweep([pr()], {}, { bead: async () => ({ status }) })
    expect(res.closed).toEqual([pr().url])
    expect(calls.close).toHaveLength(1)
    expect(calls.close[0]![1]).toContain('run-1')
    expect(calls.close[0]![1]).toContain(status)
    expect(calls.fork).toEqual([])
    expect(calls.checks).toBe(0)
  })

test('e2xe: a closed bead closes a PR that was forked at this head before', async () => {
  const records = { [pr().url]: { sha: SHA, run: 'fork-1', from: 'run-1', at: '' } }
  const { res } = await sweep([pr()], { records }, { bead: async () => ({ status: 'closed' }) })
  expect(res.closed).toEqual([pr().url])
})

test('e2xe: an open bead and a conflicting PR get the conflict label', async () => {
  const { res, calls } = await sweep(
    [pr()],
    {},
    { view: async () => ({ mergeable: 'CONFLICTING', changes: false, approved: false }) },
  )
  expect(res.labeled).toEqual([{ url: pr().url, labels: ['conflict'] }])
  expect(calls.label).toEqual([[pr().url, ['conflict']]])
  expect(calls.fork).toEqual([])
})

test('e2xe: an open bead and red checks get the rework label', async () => {
  const { res, calls } = await sweep([pr()], {}, { checks: red })
  expect(res.labeled).toEqual([{ url: pr().url, labels: ['rework'] }])
  expect(calls.fork).toEqual([])
})

test('e2xe: changes asked by a review get the rework label, and red checks plus a conflict get both', async () => {
  const asked = await sweep(
    [pr()],
    {},
    { view: async () => ({ mergeable: 'MERGEABLE', changes: true, approved: false }) },
  )
  expect(asked.res.labeled[0]!.labels).toEqual(['rework'])
  const both = await sweep(
    [pr()],
    {},
    { checks: red, view: async () => ({ mergeable: 'CONFLICTING', changes: false, approved: false }) },
  )
  expect(both.res.labeled[0]!.labels).toEqual(['conflict', 'rework'])
})

test('e2xe: a label the PR has already is not set again', async () => {
  const labeled = pr(1, { labels: [{ name: 'rework' }] })
  const { res, calls } = await sweep([labeled], {}, { checks: red })
  expect(calls.label).toEqual([])
  expect(res.skipped).toHaveLength(1)
})

test('e2xe: a green mergeable draft keeps the review fork', async () => {
  const { res, calls } = await sweep([pr()], {}, {})
  expect(res.forked).toEqual([{ url: pr().url, run: 'fork-1' }])
  expect(calls.label).toEqual([])
  expect(calls.close).toEqual([])
})

test('e2xe: a PR whose review fork aborted counts as an orphan again; a live or ended fork does not', async () => {
  const records = { [pr().url]: { sha: SHA, run: 'fork-1', from: 'run-1', at: '' } }
  const again = await sweep([pr()], { records, forkAborted: r => r === 'fork-1' }, { checks: red })
  expect(again.res.labeled).toHaveLength(1)
  const live = await sweep([pr()], { records, forkAborted: () => false }, { checks: red })
  expect(live.res.labeled).toEqual([])
  // a green mergeable PR whose fork aborted gets no second fork: it would abort the same way
  const green = await sweep([pr()], { records, forkAborted: r => r === 'fork-1' }, {})
  expect(green.res.forked).toEqual([])
})

test('e2xe: a label is recorded at the head, so the next pass leaves the PR alone', async () => {
  const records: OrphanCtx['records'] = {}
  const o = io({
    record: (p, from, run) => void (records[p.url] = { sha: p.headRefOid, run, from, at: 'now' }),
    checks: red,
  }).o
  await orphanSweep([pr()], ctx({ records }), o, ORPHAN_CAP, ORPHAN_CAP)
  expect(records[pr().url]!.run).toBe('labeled')
  const next = io({ checks: red })
  const res = await orphanSweep([pr()], ctx({ records }), next.o, ORPHAN_CAP, ORPHAN_CAP)
  expect(next.calls.label).toEqual([])
  expect(res.skipped).toHaveLength(1)
})

test('e2xe: a PR on a non-factory branch or from a fork is not closed or labeled', async () => {
  const closed = { bead: async () => ({ status: 'closed' }) }
  for (const p of [pr(1, { headRefName: 'feature/x' }), pr(1, { isCrossRepository: true })]) {
    const { res, calls } = await sweep([p], {}, closed)
    expect(res.closed).toEqual([])
    expect(calls.close).toEqual([])
    const labeled = await sweep([p], {}, { checks: red })
    expect(labeled.calls.label).toEqual([])
  }
})

test('e2xe: close and label actions share one cap; forks keep their own', async () => {
  const prs = [1, 2, 3, 4].map(n => pr(n))
  const { res, calls } = await sweep(prs, {}, { bead: async () => ({ status: 'closed' }) }, ORPHAN_CAP, 3)
  expect(res.closed).toHaveLength(3)
  expect(calls.close).toHaveLength(3)
  const mix = await sweep(prs, {}, { checks: red }, ORPHAN_CAP, 1)
  expect(mix.res.labeled).toHaveLength(1)
  const forks = await sweep(prs, {}, {}, 1, 0)
  expect(forks.res.forked).toHaveLength(1)
})

test('e2xe: a failed close, label or view call skips the PR and the sweep goes on', async () => {
  const boom = async () => {
    throw new Error('boom')
  }
  const c = await sweep([pr(1), pr(2)], {}, { bead: async () => ({ status: 'closed' }), close: boom })
  expect(c.res.closed).toEqual([])
  expect(c.res.skipped.map(s => s.why)).toEqual(['close failed: boom', 'close failed: boom'])
  const l = await sweep([pr()], {}, { checks: red, label: boom })
  expect(l.res.skipped[0]!.why).toContain('label failed: boom')
  const v = await sweep([pr()], {}, { view: async () => null })
  expect(v.res.skipped[0]!.why).toBe('view unreadable')
})

test('e2xe: a live owner or live bead stops the close, even when the PR has a record at this head', async () => {
  const records = { [pr().url]: { sha: SHA, run: 'labeled', from: 'run-1', at: '' } }
  const closed = { bead: async () => ({ status: 'closed' }) }
  const owned = await sweep([pr()], { records, owner: () => 'run-9' }, closed)
  expect(owned.res.closed).toEqual([])
  const held = await sweep([pr()], { records, liveBeads: new Set(['bd-1']) }, closed)
  expect(held.res.closed).toEqual([])
})

const gone = { status: 'closed', reason: 'every child is closed' }
const approvedView = async () => ({ mergeable: 'MERGEABLE', changes: false, approved: true })

test('i1qiv: a bead the repair pass closed keeps its PR open and gets the owner label', async () => {
  const { res, calls } = await sweep([pr()], {}, { bead: async () => gone })
  expect(calls.close).toEqual([])
  expect(calls.label).toEqual([[pr().url, ['owner']]])
  expect(res.closed).toEqual([])
  expect(res.skipped).toEqual([{ url: pr().url, why: 'held for the person: every child is closed' }])
})

test('i1qiv: a PR that already has the owner label gets no second label call', async () => {
  const p = pr(1, { labels: [{ name: 'owner' }] })
  const { res, calls } = await sweep([p], {}, { bead: async () => gone })
  expect(calls.close).toEqual([])
  expect(calls.label).toEqual([])
  expect(res.skipped).toEqual([{ url: p.url, why: 'held for the person: every child is closed' }])
})

for (const status of ['closed', 'deferred'])
  test(`i1qiv: a ${status} bead with an approved PR keeps it open and labels it owner`, async () => {
    const { res, calls } = await sweep([pr()], {}, { bead: async () => ({ status }), view: approvedView })
    expect(calls.close).toEqual([])
    expect(calls.label).toEqual([[pr().url, ['owner']]])
    expect(res.skipped).toEqual([{ url: pr().url, why: 'held for the person: approved' }])
  })

test('i1qiv: a null or throwing view keeps the PR open', async () => {
  for (const view of [
    async () => null,
    async () => {
      throw new Error('boom')
    },
  ]) {
    const { res, calls } = await sweep([pr()], {}, { bead: async () => ({ status: 'closed' }), view })
    expect(calls.close).toEqual([])
    expect(calls.label).toEqual([])
    expect(res.skipped).toEqual([{ url: pr().url, why: 'view unreadable' }])
  }
})

test('i1qiv: the view read counts toward the lookup cap, and the PR past it stays open', async () => {
  const prs = Array.from({ length: ORPHAN_CHECKS_MAX + 1 }, (_, n) => pr(n + 1))
  const ids = prs.map((_, n) => n + 1)
  const x = io({ bead: async () => ({ status: 'closed' }) })
  const res = await orphanSweep(prs, ctx({}, ids), x.o, ORPHAN_CAP, 1000)
  expect(res.closed).toHaveLength(ORPHAN_CHECKS_MAX)
  expect(res.skipped).toEqual([{ url: prs.at(-1)!.url, why: 'lookup cap' }])
})

test('i1qiv: a merged-evidence reason and an empty reason still close the PR', async () => {
  for (const reason of ['shipped: https://github.com/acme/widget/pull/9 is merged', undefined]) {
    const { calls } = await sweep([pr()], {}, { bead: async () => ({ status: 'closed', reason }) })
    expect(calls.close).toHaveLength(1)
  }
})
