import { expect, test } from 'bun:test'
import { prsIn } from './machine'
import {
  checksOf,
  collectMentions,
  DEFAULT_BUDGET,
  due,
  foldFound,
  foldMentions,
  keepSearchHit,
  namesBead,
  needsSearch,
  needsView,
  prRef,
  role,
  type PrRecord,
} from './prs'

test('namesBead matches the bead itself and a dotted descendant, not a longer sibling or a shorter ancestor', () => {
  expect(namesBead('ex-12.3', 'ex-12.3: build.')).toBe(true)
  expect(namesBead('ex-12.3', 'child task ex-12.3.5 closed')).toBe(true)
  expect(namesBead('ex-12.3', 'ex-12.30 is unrelated')).toBe(false)
  expect(namesBead('ex-12.3', 'only ex-12 is named here')).toBe(false)
  expect(namesBead('ex-12.3', 'no bead named')).toBe(false)
})

test('prRef parses a github pull request URL and rejects anything else', () => {
  expect(prRef('https://github.com/acme/widget/pull/551')).toEqual({ repo: 'acme/widget', number: 551 })
  expect(prRef('https://github.com/acme/widget/issues/551')).toBeNull()
  expect(prRef('not a url')).toBeNull()
})

test('checksOf tallies a statusCheckRollup by conclusion, unresolved checks counting as pending', () => {
  expect(
    checksOf([{ conclusion: 'SUCCESS' }, { conclusion: 'failure' }, { conclusion: null }, { conclusion: 'NEUTRAL' }]),
  ).toEqual({ pass: 2, fail: 1, pending: 1 })
  expect(checksOf()).toEqual({ pass: 0, fail: 0, pending: 0 })
})

// shapes modeled on a real run: a dependency named only in prose (never linked), a PR linked once in a
// report and again in mail about the same URL, and a companion PR only ever named in a final report
const RUN_ID = 'lifecycle-abc123'
// #63 and #67 are never linked, only named ("PR #63", "PR #67"): a search is the only way those two are
// ever found (covered by the foldFound tests below)
const LOG = [
  {
    node: 'triage',
    attempt: 2,
    outcome: 'blocked',
    at: 1791794969799,
    summary:
      'ex-12.3 still blocked on its bd DEPENDS-ON edge ex-12.2, still IN_PROGRESS under sibling run lifecycle-def456. acme/widget-deploy PR #63 (release/widget-release-2026-10-12) is already owner-merged. Only the widget-side bookkeeping PR remains open: https://github.com/acme/widget/pull/550 (branch factory/lifecycle-def456).',
  },
  {
    node: 'review',
    attempt: 1,
    outcome: 'changes',
    at: 1791814041138,
    summary: 'PR https://github.com/acme/widget/pull/551 (draft, opened by review; head c0ffee1).',
  },
  {
    node: 'deploy',
    attempt: 1,
    outcome: 'deployed',
    at: 1791819735929,
    summary:
      'ex-12.3 fully deployed. Shipped via 3 owner-merged PRs: (1) acme/widget PR #551 (c0ffee2, merged). ' +
      '(2) acme/widget-deploy PR #65 (c0ffee3, merged) carrying ex-12.3. ' +
      '(3) acme/widget-deploy PR #67 (c0ffee4, merged), ex-12.3 workloads half.',
  },
]
const MAIL = [
  {
    from: 'factory',
    to: 'triage',
    at: 1791795088862,
    text: 'https://github.com/acme/widget/pull/550 changed since you parked: it is merged.',
  },
  {
    from: 'factory',
    to: 'deploy',
    at: 1791816985476,
    text: 'https://github.com/acme/widget/pull/551 changed since you parked: it is merged.',
  },
  {
    from: 'factory',
    to: 'deploy',
    at: 1791818289210,
    text: 'https://github.com/acme/widget-deploy/pull/65 changed since you parked: it is merged.',
  },
]
const IS_STATION = (id: string) => ['triage', 'plan', 'implement', 'verify', 'review', 'release', 'deploy', 'soak'].includes(id)

test('collectMentions reads every linked PR out of a log of reports and a run of mail, crediting mail to whichever of from/to is a station; #63 and #67 are only ever named, never linked, so neither turns up', () => {
  const hits = collectMentions(LOG as never, MAIL, IS_STATION, prsIn)
  expect(hits).toEqual([
    { url: 'https://github.com/acme/widget/pull/550', station: 'triage', at: 1791794969799, source: 'report' },
    { url: 'https://github.com/acme/widget/pull/551', station: 'review', at: 1791814041138, source: 'report' },
    { url: 'https://github.com/acme/widget/pull/550', station: 'triage', at: 1791795088862, source: 'mail' },
    { url: 'https://github.com/acme/widget/pull/551', station: 'deploy', at: 1791816985476, source: 'mail' },
    { url: 'https://github.com/acme/widget-deploy/pull/65', station: 'deploy', at: 1791818289210, source: 'mail' },
  ])
})

test('foldMentions keeps the first-seen station, source and time for a URL seen more than once', () => {
  const hits = collectMentions(LOG as never, MAIL, IS_STATION, prsIn)
  const folded = foldMentions([], hits)
  expect(folded).toHaveLength(3) // 550, 551, 65
  const pr551 = folded.find(r => r.number === 551)!
  // triage's report named 550 before the mail about it did; review's report named 551 before the mail about it did
  expect(pr551.station).toBe('review')
  expect(pr551.source).toBe('report')
  expect(pr551.firstSeenAt).toBe(1791814041138)
  const pr65 = folded.find(r => r.number === 65)!
  // 65 was only ever named via mail
  expect(pr65.station).toBe('deploy')
  expect(pr65.source).toBe('mail')
})

test('foldFound marks a URL corroborated whether it already exists or is new, and drops anything that is not a PR URL', () => {
  const base = foldMentions([], [{ url: 'https://github.com/acme/widget/pull/550', station: 'triage', at: 1, source: 'report' }])
  const found = foldFound(base, [
    { url: 'https://github.com/acme/widget/pull/550', at: 2, source: 'search' },
    { url: 'https://github.com/acme/widget/pull/551', at: 3, source: 'branch' },
  ])
  expect(found.find(r => r.number === 550)!.corroborated).toBe(true)
  expect(found.find(r => r.number === 550)!.station).toBe('triage') // unchanged: it was already known
  expect(found.find(r => r.number === 551)!.corroborated).toBe(true)
  expect(found.find(r => r.number === 551)!.source).toBe('branch') // new: credited to the finder
})

test('keepSearchHit drops a PR created before the run started minus the 10 min grace', () => {
  const runStart = 1791791066107 // the run's own start
  expect(keepSearchHit('2026-10-12T07:40:00Z', runStart)).toBe(true) // inside the 10 min grace
  expect(keepSearchHit('2026-10-11T00:00:00Z', runStart)).toBe(false) // a day earlier: a pre-existing PR
  expect(keepSearchHit('2026-10-12T08:49:00Z', runStart)).toBe(true) // after the run started
})

const CTX = { runId: RUN_ID, runRepo: 'acme/widget' }

test('role classes the run"s own PR in its own repo as code', () => {
  expect(
    role(
      { repo: 'acme/widget', title: 'ex-12.3 trusted test policy', station: 'review', corroborated: true, headRefName: `factory/${RUN_ID}` },
      { ...CTX, bead: 'ex-12.3' },
    ),
  ).toBe('code')
})

test('role classes a cross-repo PR that names the bead as companion, even first seen at the deploy station', () => {
  expect(
    role(
      {
        repo: 'acme/widget-deploy',
        title: 'migrate-stage tester-trusted-root',
        body: 'Carries ex-12.3\'s re-pin into the migrate stage.',
        station: 'deploy',
        corroborated: true,
      },
      { ...CTX, bead: 'ex-12.3' },
    ),
  ).toBe('companion')
})

test('role classes a same-repo PR on another run\'s branch, naming neither bead nor corroborated, as mentioned', () => {
  expect(
    role(
      {
        repo: 'acme/widget',
        title: 'gear 1: the admission probe',
        body: 'ex-12.2: the widget half of release widget-release-2026-10-12.',
        station: 'triage',
        corroborated: false,
        headRefName: 'factory/lifecycle-def456',
      },
      { ...CTX, bead: 'ex-12.3' },
    ),
  ).toBe('mentioned')
})

test('role classes a cross-repo PR on an unrelated branch that names neither bead, only ever mentioned, as mentioned', () => {
  expect(
    role(
      {
        repo: 'acme/widget-deploy',
        title: 'staging release widget-release-2026-10-12',
        body: 'Source c0ffee5. No bead named.',
        station: 'triage',
        corroborated: false,
        headRefName: 'release/widget-release-2026-10-12',
      },
      { ...CTX, bead: 'ex-12.3' },
    ),
  ).toBe('mentioned')
})

test('role falls to deploy for a cross-repo PR that is the run\'s own (corroborated) but names no bead, first seen at deploy or rollback', () => {
  const pr = { repo: 'acme/platform-flux', title: 'bump the image pin', station: 'deploy', corroborated: true }
  expect(role(pr, { ...CTX, bead: 'ex-12.3' })).toBe('deploy')
  expect(role({ ...pr, station: 'rollback' }, { ...CTX, bead: 'ex-12.3' })).toBe('deploy')
  expect(role({ ...pr, station: 'release' }, { ...CTX, bead: 'ex-12.3' })).toBe('companion')
})

test('role without a bead to match against still classes the run\'s own branch as code and all else as mentioned', () => {
  expect(
    role({ repo: CTX.runRepo, title: 't', station: '', corroborated: false, headRefName: `factory/${RUN_ID}` }, { ...CTX, bead: undefined }),
  ).toBe('code')
  expect(role({ repo: 'o/r', title: 't', station: '', corroborated: false }, { ...CTX, bead: undefined })).toBe('mentioned')
})

test('needsView refreshes OPEN every 2 min and CLOSED every 30 min, never a MERGED PR again', () => {
  const at = (state: PrRecord['state'], checkedAt: number): Pick<PrRecord, 'state' | 'checkedAt'> => ({ state, checkedAt })
  const now = 1_000_000_000
  expect(needsView(at('OPEN', now - 2 * 60_000), now)).toBe(true)
  expect(needsView(at('OPEN', now - 60_000), now)).toBe(false)
  expect(needsView(at('CLOSED', now - 30 * 60_000), now)).toBe(true)
  expect(needsView(at('CLOSED', now - 60_000), now)).toBe(false)
  expect(needsView(at('MERGED', 0), now)).toBe(false)
  expect(needsView(at('UNKNOWN', 0), now)).toBe(true)
})

test('needsSearch: no bead never searches, a live run searches every 10 min, an ended run searches once more then never', () => {
  const now = 1_000_000_000
  expect(needsSearch({ ended: false, bead: undefined }, {}, now)).toBe(false)
  expect(needsSearch({ ended: false, bead: 'x' }, {}, now)).toBe(true)
  expect(needsSearch({ ended: false, bead: 'x' }, { searchedAt: now - 60_000 }, now)).toBe(false)
  expect(needsSearch({ ended: false, bead: 'x' }, { searchedAt: now - 11 * 60_000 }, now)).toBe(true)
  expect(needsSearch({ ended: true, bead: 'x' }, {}, now)).toBe(true)
  expect(needsSearch({ ended: true, bead: 'x' }, { searchedFinal: true }, now)).toBe(false)
})

test('due orders live runs before ended runs (newest first) and stops at the search and view budgets, leaving the rest for later', () => {
  const now = 1_000_000_000
  const runs = [
    { run: 'ended-old', ended: true, bead: 'a', at: 1 },
    { run: 'ended-new', ended: true, bead: 'b', at: 2 },
    { run: 'live-1', ended: false, bead: 'c', at: 3 },
  ]
  const files = new Map()
  const prsByRun = new Map([
    ['live-1', Array.from({ length: 2 }, (_, i) => ({ url: `u${i}`, state: 'OPEN' as const, checkedAt: 0 }))],
    ['ended-new', Array.from({ length: 2 }, (_, i) => ({ url: `v${i}`, state: 'OPEN' as const, checkedAt: 0 }))],
  ])
  const out = due(runs, prsByRun, files, now, { searches: 2, views: 3 })
  expect(out.searches).toEqual(['live-1', 'ended-new']) // live first, then newest ended; ended-old deferred
  expect(out.views.map(v => v.run)).toEqual(['live-1', 'live-1', 'ended-new']) // live's 2 then one of ended-new's
})

test('due leaves a run without a bead out of searches entirely', () => {
  const runs = [{ run: 'x', ended: false, bead: undefined, at: 1 }]
  expect(due(runs, new Map(), new Map(), 0, DEFAULT_BUDGET).searches).toEqual([])
})
