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
  const calls = { checks: 0, fork: [] as [string, string, string][], record: [] as string[] }
  const o: OrphanIo = {
    beadStatus: async () => 'open',
    checks: async () => (calls.checks++, green),
    fork: async (p, src, note) => (calls.fork.push([p.url, src, note]), `fork-${p.number}`),
    record: p => void calls.record.push(p.url),
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
  ['bead closed', pr(), {}, { beadStatus: async () => 'closed' }],
  ['bd show null', pr(), {}, { beadStatus: async () => null }],
  ['CI failed', pr(), {}, { checks: async () => ({ pass: 1, fail: 1, pending: 0 }) }],
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
    beadStatus: async () => {
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
  expect((await orphanSweep(five, ctx(), c.o, 0)).forked).toHaveLength(0)
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

test('ciVerdict: null is unknown, fail wins over pending, zero checks are green', () => {
  expect(ciVerdict(null)).toBe('unknown')
  expect(ciVerdict({ pass: 0, fail: 1, pending: 1 })).toBe('red')
  expect(ciVerdict({ pass: 1, fail: 0, pending: 1 })).toBe('pending')
  expect(ciVerdict({ pass: 0, fail: 0, pending: 0 })).toBe('green')
})
