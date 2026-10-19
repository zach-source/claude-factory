import { expect, test } from 'bun:test'
import { prsIn } from './machine'
import {
  alreadyDone,
  asPrsFile,
  checksOf,
  citesBead,
  collectMentions,
  DEFAULT_BUDGET,
  due,
  evidenceLine,
  foldFound,
  foldMentions,
  keepSearchHit,
  namesBead,
  needsSearch,
  needsView,
  parseMergedPrs,
  prRef,
  role,
  sameFile,
  viewBackoff,
  type MergedPr,
  type PrRecord,
  type PrsFile,
} from './prs'

test('namesBead matches the bead itself and a dotted descendant, not a longer sibling or a shorter ancestor', () => {
  expect(namesBead('ex-12.3', 'ex-12.3: build.')).toBe(true)
  expect(namesBead('ex-12.3', 'child task ex-12.3.5 closed')).toBe(true)
  expect(namesBead('ex-12.3', 'ex-12.30 is unrelated')).toBe(false)
  expect(namesBead('ex-12.3', 'only ex-12 is named here')).toBe(false)
  expect(namesBead('ex-12.3', 'no bead named')).toBe(false)
})

test('citesBead matches only the exact id, never a dotted descendant, a longer sibling or a shorter ancestor', () => {
  expect(citesBead('ex-12.3', 'ex-12.3: build.')).toBe(true)
  expect(citesBead('ex-12.3', 'fixes ex-12.3')).toBe(true)
  expect(citesBead('ex-12.3', 'child task ex-12.3.5 closed')).toBe(false)
  expect(citesBead('ex-12.3', 'ex-12.30 is unrelated')).toBe(false)
  expect(citesBead('ex-12.3', 'only ex-12 is named here')).toBe(false)
  expect(citesBead('ex-12.3', 'no bead named')).toBe(false)
})

const merged = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 57,
  url: 'https://github.com/acme/widget/pull/57',
  title: 'fix: ex-12.3 lands the thing',
  headRefName: 'factory/run-1',
  mergeCommit: 'deadbeef',
  state: 'MERGED',
  ...over,
})

test('alreadyDone: a merged PR whose title cites the exact id is a hit', () => {
  const hit = alreadyDone('ex-12.3', [merged()], { childIds: [], allChildrenClosed: false, runBranches: [] })
  expect(hit).toEqual({
    kind: 'merged-pr',
    pr: {
      number: 57,
      url: 'https://github.com/acme/widget/pull/57',
      title: merged().title,
      mergeCommit: 'deadbeef',
    },
  })
})

test('alreadyDone: a merged PR on a known run branch for this bead is a hit, with no id in the title', () => {
  const pr = merged({ title: 'unrelated title', headRefName: 'factory/run-9' })
  const hit = alreadyDone('ex-12.3', [pr], {
    childIds: [],
    allChildrenClosed: false,
    runBranches: ['factory/run-9'],
  })
  expect(hit?.kind).toBe('merged-pr')
})

test("alreadyDone: a merged PR on another run's branch, with no id in the title, is not a hit", () => {
  const pr = merged({ title: 'unrelated title', headRefName: 'factory/run-9' })
  const hit = alreadyDone('ex-12.3', [pr], {
    childIds: [],
    allChildrenClosed: false,
    runBranches: ['factory/run-other'],
  })
  expect(hit).toBeNull()
})

test('alreadyDone: a merged PR naming a closed child, with every child closed, is a hit for the parent', () => {
  const pr = merged({ title: 'closes ex-12.3.1' })
  const hit = alreadyDone('ex-12.3', [pr], {
    childIds: ['ex-12.3.1', 'ex-12.3.2'],
    allChildrenClosed: true,
    runBranches: [],
  })
  expect(hit?.kind).toBe('merged-pr')
})

test('alreadyDone: a merged PR naming a child is not a hit while any child stays open', () => {
  const pr = merged({ title: 'closes ex-12.3.1' })
  const hit = alreadyDone('ex-12.3', [pr], {
    childIds: ['ex-12.3.1', 'ex-12.3.2'],
    allChildrenClosed: false,
    runBranches: [],
  })
  expect(hit).toBeNull()
})

test('alreadyDone: a merged PR naming a child is not a hit when the bead has no children', () => {
  const pr = merged({ title: 'closes ex-12.3.1' })
  const hit = alreadyDone('ex-12.3', [pr], { childIds: [], allChildrenClosed: true, runBranches: [] })
  expect(hit).toBeNull()
})

test('alreadyDone: a longer-sibling title (x-1.20 vs x-1.2) is not a hit', () => {
  const pr = merged({ title: 'ex-12.30 lands' })
  const hit = alreadyDone('ex-12.3', [pr], { childIds: [], allChildrenClosed: false, runBranches: [] })
  expect(hit).toBeNull()
})

test('alreadyDone: a shorter-ancestor title (x-1 vs x-1.2) is not a hit', () => {
  const pr = merged({ title: 'ex-12 epic wraps up' })
  const hit = alreadyDone('ex-12.3', [pr], { childIds: [], allChildrenClosed: false, runBranches: [] })
  expect(hit).toBeNull()
})

test('alreadyDone: a body-only mention never hits (only title and headRefName count)', () => {
  // MergedPr carries no body field; a caller cannot express a body mention here. This documents the
  // contract: title is the only text alreadyDone ever reads for a direct cite.
  const pr = merged({ title: 'unrelated title' })
  const hit = alreadyDone('ex-12.3', [pr], { childIds: [], allChildrenClosed: false, runBranches: [] })
  expect(hit).toBeNull()
})

test('alreadyDone: a non-MERGED PR citing the id is never a hit', () => {
  for (const state of ['OPEN', 'CLOSED', 'UNKNOWN'] as const) {
    const pr = merged({ state })
    expect(
      alreadyDone('ex-12.3', [pr], { childIds: [], allChildrenClosed: false, runBranches: [] }),
    ).toBeNull()
  }
})

test('alreadyDone: an empty PR list is never a hit', () => {
  expect(alreadyDone('ex-12.3', [], { childIds: [], allChildrenClosed: false, runBranches: [] })).toBeNull()
})

test('parseMergedPrs: gh pr list --json number,url,title,headRefName,mergeCommit shape, flattening mergeCommit.oid', () => {
  const out = JSON.stringify([
    {
      number: 57,
      url: 'https://github.com/acme/widget/pull/57',
      title: 'fix: ex-12.3',
      headRefName: 'factory/run-1',
      mergeCommit: { oid: 'deadbeef' },
    },
  ])
  expect(parseMergedPrs(out)).toEqual([
    {
      number: 57,
      url: 'https://github.com/acme/widget/pull/57',
      title: 'fix: ex-12.3',
      headRefName: 'factory/run-1',
      mergeCommit: 'deadbeef',
      state: 'MERGED',
    },
  ])
})

test('parseMergedPrs: garbage input is an empty list, never a throw', () => {
  expect(parseMergedPrs('not json')).toEqual([])
  expect(parseMergedPrs('{}')).toEqual([])
})

test('evidenceLine: PR url, number, merge SHA and a clipped title, with the requeue command', () => {
  const line = evidenceLine(
    { number: 57, url: 'https://github.com/acme/widget/pull/57', title: 'fix it', mergeCommit: 'deadbeef' },
    'acme',
    'ex-12.3',
  )
  expect(line).toContain('https://github.com/acme/widget/pull/57')
  expect(line).toContain('#57')
  expect(line).toContain('deadbeef')
  expect(line).toContain('fix it')
  expect(line).toContain('factory queue acme ex-12.3')
})

test('evidenceLine: a title past 120 chars is clipped', () => {
  const longTitle = 'x'.repeat(200)
  const line = evidenceLine(
    { number: 1, url: 'https://github.com/acme/widget/pull/1', title: longTitle, mergeCommit: 'abc' },
    'acme',
    'ex-1',
  )
  expect(line).not.toContain(longTitle)
  expect(line).toContain('x'.repeat(120))
})

test('prRef parses a github pull request URL and rejects anything else', () => {
  expect(prRef('https://github.com/acme/widget/pull/551')).toEqual({ repo: 'acme/widget', number: 551 })
  expect(prRef('https://github.com/acme/widget/issues/551')).toBeNull()
  expect(prRef('not a url')).toBeNull()
})

test('checksOf tallies a statusCheckRollup by conclusion, unresolved checks counting as pending', () => {
  expect(
    checksOf([
      { conclusion: 'SUCCESS' },
      { conclusion: 'failure' },
      { conclusion: null },
      { conclusion: 'NEUTRAL' },
    ]),
  ).toEqual({ pass: 2, fail: 1, pending: 1 })
  expect(checksOf()).toEqual({ pass: 0, fail: 0, pending: 0 })
})

test('sameFile tells cli.ts whether a prs.json actually changed, order of the prs array included (wyc.7)', () => {
  const a: PrsFile = { version: 1, searchedAt: 1, prs: [] }
  expect(sameFile(a, { ...a })).toBe(true)
  expect(sameFile(a, { ...a, searchedAt: 2 })).toBe(false)
  const withPr = (checkedAt: number): PrsFile => ({
    version: 1,
    prs: [
      {
        url: 'https://github.com/acme/widget/pull/1',
        repo: 'acme/widget',
        number: 1,
        title: 't',
        role: 'code',
        station: 's',
        firstSeenAt: 1,
        source: 'report',
        corroborated: true,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: '',
        mergeStateStatus: '',
        checks: { pass: 0, fail: 0, pending: 0 },
        updatedAt: '',
        checkedAt,
        ownHead: true,
        namesIt: false,
        errorStreak: 0,
        erroredAt: 0,
      },
    ],
  })
  expect(sameFile(withPr(1), withPr(1))).toBe(true) // equal content, different object identity
  expect(sameFile(withPr(1), withPr(2))).toBe(false)
})

test('asPrsFile treats a parsed prs.json whose `prs` is missing or not an array as empty, instead of letting it reach foldMentions (wyc.12)', () => {
  expect(asPrsFile({ version: 1 })).toEqual({ version: 1, prs: [] })
  expect(asPrsFile({ version: 1, prs: 'not an array' })).toEqual({ version: 1, prs: [] })
  expect(asPrsFile(null)).toEqual({ version: 1, prs: [] })
  expect(asPrsFile(undefined)).toEqual({ version: 1, prs: [] })
  expect(asPrsFile([])).toEqual({ version: 1, prs: [] })
  const good: PrsFile = { version: 1, searchedAt: 5, prs: [] }
  expect(asPrsFile(good)).toEqual(good) // a real file passes through unchanged
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
const IS_STATION = (id: string) =>
  ['triage', 'plan', 'implement', 'verify', 'review', 'release', 'deploy', 'soak'].includes(id)

test('collectMentions reads every linked PR out of a log of reports and a run of mail, crediting mail to whichever of from/to is a station; #63 and #67 are only ever named, never linked, so neither turns up', () => {
  const hits = collectMentions(LOG as never, MAIL, IS_STATION, prsIn)
  expect(hits).toEqual([
    {
      url: 'https://github.com/acme/widget/pull/550',
      station: 'triage',
      at: 1791794969799,
      source: 'report',
    },
    {
      url: 'https://github.com/acme/widget/pull/551',
      station: 'review',
      at: 1791814041138,
      source: 'report',
    },
    { url: 'https://github.com/acme/widget/pull/550', station: 'triage', at: 1791795088862, source: 'mail' },
    { url: 'https://github.com/acme/widget/pull/551', station: 'deploy', at: 1791816985476, source: 'mail' },
    {
      url: 'https://github.com/acme/widget-deploy/pull/65',
      station: 'deploy',
      at: 1791818289210,
      source: 'mail',
    },
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
  const base = foldMentions(
    [],
    [{ url: 'https://github.com/acme/widget/pull/550', station: 'triage', at: 1, source: 'report' }],
  )
  const found = foldFound(base, [
    { url: 'https://github.com/acme/widget/pull/550', at: 2, source: 'search' },
    { url: 'https://github.com/acme/widget/pull/551', at: 3, source: 'branch' },
  ])
  expect(found.find(r => r.number === 550)!.corroborated).toBe(true)
  expect(found.find(r => r.number === 550)!.station).toBe('triage') // unchanged: it was already known
  expect(found.find(r => r.number === 551)!.corroborated).toBe(true)
  expect(found.find(r => r.number === 551)!.source).toBe('branch') // new: credited to the finder
})

test('keepSearchHit drops a PR created before the run started minus the 10 min grace, or after it ended plus the grace (wyc.5)', () => {
  const runStart = 1791791066107 // the run's own start
  const runEnd = 1791819735929 // the run's own last log entry
  expect(keepSearchHit('2026-10-12T07:40:00Z', runStart, runEnd)).toBe(true) // inside the start's 10 min grace
  expect(keepSearchHit('2026-10-11T00:00:00Z', runStart, runEnd)).toBe(false) // a day earlier: a pre-existing PR
  expect(keepSearchHit('2026-10-12T08:49:00Z', runStart, runEnd)).toBe(true) // after the run started, before it ended
  expect(keepSearchHit('2026-10-12T15:50:00Z', runStart, runEnd)).toBe(true) // inside the end's 10 min grace
  expect(keepSearchHit('2026-10-13T00:00:00Z', runStart, runEnd)).toBe(false) // a later run of the same bead
  expect(keepSearchHit('2026-10-13T00:00:00Z', runStart, Infinity)).toBe(true) // a live run has no upper bound yet
})

const CTX = { runId: RUN_ID, runRepo: 'acme/widget' }

test('role classes the run"s own PR in its own repo as code', () => {
  expect(
    role(
      {
        repo: 'acme/widget',
        title: 'ex-12.3 trusted test policy',
        station: 'review',
        corroborated: true,
        headRefName: `factory/${RUN_ID}`,
      },
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
        body: "Carries ex-12.3's re-pin into the migrate stage.",
        station: 'deploy',
        corroborated: true,
      },
      { ...CTX, bead: 'ex-12.3' },
    ),
  ).toBe('companion')
})

test("role classes a same-repo PR on another run's branch, naming neither bead nor corroborated, as mentioned", () => {
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

test("role falls to deploy for a cross-repo PR that is the run's own (corroborated) but names no bead, first seen at deploy or rollback", () => {
  const pr = {
    repo: 'acme/platform-flux',
    title: 'bump the image pin',
    station: 'deploy',
    corroborated: true,
  }
  expect(role(pr, { ...CTX, bead: 'ex-12.3' })).toBe('deploy')
  expect(role({ ...pr, station: 'rollback' }, { ...CTX, bead: 'ex-12.3' })).toBe('deploy')
  expect(role({ ...pr, station: 'release' }, { ...CTX, bead: 'ex-12.3' })).toBe('companion')
})

test("role without a bead to match against still classes the run's own branch as code and all else as mentioned", () => {
  expect(
    role(
      { repo: CTX.runRepo, title: 't', station: '', corroborated: false, headRefName: `factory/${RUN_ID}` },
      { ...CTX, bead: undefined },
    ),
  ).toBe('code')
  expect(
    role({ repo: 'o/r', title: 't', station: '', corroborated: false }, { ...CTX, bead: undefined }),
  ).toBe('mentioned')
})

test('needsView refreshes OPEN every 2 min and CLOSED every 30 min, never a MERGED PR again', () => {
  const at = (state: PrRecord['state'], checkedAt: number): Pick<PrRecord, 'state' | 'checkedAt'> => ({
    state,
    checkedAt,
  })
  const now = 1_000_000_000
  expect(needsView(at('OPEN', now - 2 * 60_000), now)).toBe(true)
  expect(needsView(at('OPEN', now - 60_000), now)).toBe(false)
  expect(needsView(at('CLOSED', now - 30 * 60_000), now)).toBe(true)
  expect(needsView(at('CLOSED', now - 60_000), now)).toBe(false)
  expect(needsView(at('MERGED', 0), now)).toBe(false)
  expect(needsView(at('UNKNOWN', 0), now)).toBe(true)
})

test('viewBackoff grows 1, 2, 4... minutes per consecutive failure, capped at 30 min', () => {
  expect(viewBackoff(0)).toBe(0)
  expect(viewBackoff(1)).toBe(60_000)
  expect(viewBackoff(2)).toBe(2 * 60_000)
  expect(viewBackoff(3)).toBe(4 * 60_000)
  expect(viewBackoff(10)).toBe(30 * 60_000) // capped
})

test("needsView backs off a PR on an error streak past its state's own TTL, even though checkedAt never advances (wyc.10)", () => {
  const now = 1_000_000_000
  const openPastTtl = { state: 'OPEN' as const, checkedAt: now - 2 * 60_000 }
  // no streak yet: due the moment the state's own TTL has passed, same as before
  expect(needsView({ ...openPastTtl, errorStreak: 0, erroredAt: 0 }, now)).toBe(true)
  // one failure a moment ago: still backing off
  expect(needsView({ ...openPastTtl, errorStreak: 1, erroredAt: now - 1000 }, now)).toBe(false)
  // one failure a full minute ago: due again
  expect(needsView({ ...openPastTtl, errorStreak: 1, erroredAt: now - 60_000 }, now)).toBe(true)
  // three failures, only a minute since the last: still backing off (needs 4 min)
  expect(needsView({ ...openPastTtl, errorStreak: 3, erroredAt: now - 60_000 }, now)).toBe(false)
  // an object with no error fields at all behaves like a 0 streak (back-compat with `due`'s Pick type)
  expect(needsView(openPastTtl, now)).toBe(true)
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

test('needsSearch: an ended run whose final search errored backs off like a view error, but is never marked final by an error alone (wyc.11)', () => {
  const now = 1_000_000_000
  // one failed search: not final, but within the first backoff window (1 min)
  expect(
    needsSearch({ ended: true, bead: 'x' }, { searchErrorStreak: 1, searchErroredAt: now - 30_000 }, now),
  ).toBe(false)
  // past the backoff window: due again
  expect(
    needsSearch({ ended: true, bead: 'x' }, { searchErrorStreak: 1, searchErroredAt: now - 61_000 }, now),
  ).toBe(true)
  // searchedFinal is never set by an error, so the run keeps retrying instead of giving up for good
  expect(
    needsSearch(
      { ended: true, bead: 'x' },
      { searchErrorStreak: 1, searchErroredAt: now - 61_000, searchedFinal: false },
      now,
    ),
  ).toBe(true)
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
    [
      'ended-new',
      Array.from({ length: 2 }, (_, i) => ({ url: `v${i}`, state: 'OPEN' as const, checkedAt: 0 })),
    ],
  ])
  const out = due(runs, prsByRun, files, now, { searches: 2, views: 3 })
  expect(out.searches).toEqual(['live-1', 'ended-new']) // live first, then newest ended; ended-old deferred
  expect(out.views.map(v => v.run)).toEqual(['live-1', 'live-1', 'ended-new']) // live's 2 then one of ended-new's
})

test('due leaves a run without a bead out of searches entirely', () => {
  const runs = [{ run: 'x', ended: false, bead: undefined, at: 1 }]
  expect(due(runs, new Map(), new Map(), 0, DEFAULT_BUDGET).searches).toEqual([])
})

// ---- IO ----

import {
  applyView,
  applyViewError,
  branchFound,
  buildPrs,
  parseBranchList,
  parseSearch,
  parseView,
  type Gh,
  type GhResult,
  type RunMeta,
} from './prs'

test('parseSearch keeps a hit at or after the run start minus 10 min and at or before it ended plus 10 min, drops anything outside that window, and ignores unparseable output', () => {
  const runStart = 1791791066107
  const runEnd = 1791819735929
  const now = 2_000_000_000
  const hits = parseSearch(
    JSON.stringify([
      { url: 'https://github.com/acme/widget/pull/551', createdAt: '2026-10-12T08:49:00Z' }, // kept
      { url: 'https://github.com/acme/widget/pull/549', createdAt: '2026-10-11T00:00:00Z' }, // before start: dropped
      { url: 'https://github.com/acme/widget/pull/552', createdAt: '2026-10-13T00:00:00Z' }, // after end: a later run's own PR, dropped
    ]),
    runStart,
    runEnd,
    now,
  )
  expect(hits).toEqual([{ url: 'https://github.com/acme/widget/pull/551', at: now, source: 'search' }])
  expect(parseSearch('not json', runStart, runEnd, now)).toEqual([])
  // a live run (Infinity) keeps a hit no matter how recent
  expect(
    parseSearch(
      JSON.stringify([{ url: 'https://github.com/acme/widget/pull/552', createdAt: '2026-10-13T00:00:00Z' }]),
      runStart,
      Infinity,
      now,
    ),
  ).toEqual([{ url: 'https://github.com/acme/widget/pull/552', at: now, source: 'search' }])
})

test("parseBranchList and branchFound: only the listed PR whose head is this run's own branch counts, bad JSON yields nothing", () => {
  const list = parseBranchList(
    JSON.stringify([
      { url: 'https://github.com/acme/widget/pull/551', headRefName: 'factory/lifecycle-abc123' },
      { url: 'https://github.com/acme/widget/pull/550', headRefName: 'factory/lifecycle-def456' },
    ]),
  )
  expect(branchFound(list, 'lifecycle-abc123', 5)).toEqual([
    { url: 'https://github.com/acme/widget/pull/551', at: 5, source: 'branch' },
  ])
  expect(branchFound(parseBranchList('{'), 'lifecycle-abc123', 5)).toEqual([])
})

test('parseView normalises state to upper case, tallies checks, keeps isDraft, and returns null on bad JSON', () => {
  const v = parseView(
    JSON.stringify({
      title: 'ex-12.3 build',
      state: 'open',
      isDraft: true,
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      updatedAt: '2026-10-12T09:00:00Z',
      headRefName: 'factory/lifecycle-abc123',
      body: 'ex-12.3 carries the fix',
    }),
  )
  expect(v).toEqual({
    title: 'ex-12.3 build',
    state: 'OPEN',
    isDraft: true,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'CLEAN',
    checks: { pass: 1, fail: 1, pending: 0 },
    updatedAt: '2026-10-12T09:00:00Z',
    headRefName: 'factory/lifecycle-abc123',
    body: 'ex-12.3 carries the fix',
  })
  expect(parseView('not json')).toBeNull()
})

test('applyView refreshes gh-sourced fields, recomputes role from the fresh headRefName/body, clears a prior error, and bumps checkedAt', () => {
  const pr = {
    url: 'https://github.com/acme/widget-deploy/pull/65',
    repo: 'acme/widget-deploy',
    number: 65,
    title: '',
    role: 'mentioned' as const,
    station: 'deploy',
    firstSeenAt: 1,
    source: 'mail' as const,
    corroborated: false,
    state: 'UNKNOWN' as const,
    isDraft: false,
    reviewDecision: '',
    mergeStateStatus: '',
    checks: { pass: 0, fail: 0, pending: 0 },
    updatedAt: '',
    checkedAt: 0,
    ownHead: false,
    namesIt: false,
    errorStreak: 1,
    erroredAt: 500,
    error: 'stale: gh timed out',
  }
  const viewed = parseView(
    JSON.stringify({
      title: 'migrate-stage tester-trusted-root',
      state: 'merged',
      isDraft: false,
      reviewDecision: '',
      mergeStateStatus: 'MERGED',
      statusCheckRollup: [],
      updatedAt: '2026-10-12T09:10:00Z',
      headRefName: 'release/widget-release-2026-10-12',
      body: "carries ex-12.3's re-pin",
    }),
  )!
  const next = applyView(
    pr,
    viewed,
    { runId: 'lifecycle-abc123', runRepo: 'acme/widget', bead: 'ex-12.3' },
    999,
  )
  expect(next.state).toBe('MERGED')
  expect(next.title).toBe('migrate-stage tester-trusted-root')
  expect(next.role).toBe('companion') // names the bead, cross-repo
  expect(next.error).toBeUndefined()
  expect(next.checkedAt).toBe(999)
  // wyc.4: the facts behind this role are stored, not just the role itself
  expect(next.ownHead).toBe(false)
  expect(next.namesIt).toBe(true)
  // wyc.10: a success clears any prior error streak
  expect(next.errorStreak).toBe(0)
  expect(next.erroredAt).toBe(0)
})

test('applyViewError keeps every prior field, sets a short scrubbed error, and bumps the backoff streak (wyc.10)', () => {
  const pr = {
    url: 'u',
    repo: 'acme/widget',
    number: 1,
    title: 't',
    role: 'code' as const,
    station: 'review',
    firstSeenAt: 1,
    source: 'report' as const,
    corroborated: true,
    state: 'OPEN' as const,
    isDraft: false,
    reviewDecision: '',
    mergeStateStatus: '',
    checks: { pass: 0, fail: 0, pending: 0 },
    updatedAt: '',
    checkedAt: 123,
    ownHead: false,
    namesIt: false,
    errorStreak: 0,
    erroredAt: 0,
  }
  const next = applyViewError(pr, 'HTTP 502: Bad Gateway\nfull stack trace, line after line'.repeat(10), 999)
  expect(next.state).toBe('OPEN') // unchanged
  expect(next.checkedAt).toBe(123) // unchanged: the state's own TTL does not apply to a failed view
  expect(next.errorStreak).toBe(1) // one failure so far
  expect(next.erroredAt).toBe(999)
  expect(next.error).toBe('HTTP 502: Bad Gateway') // one line, cut short
  expect(next.error!.length).toBeLessThanOrEqual(201)
})

const run = (over: Partial<RunMeta>): RunMeta => ({
  id: RUN_ID,
  bead: 'ex-12.3',
  startAt: 1791791066107,
  ended: false,
  endAt: Infinity,
  repoDir: '/repo/widget',
  runRepo: 'acme/widget',
  owner: 'acme',
  log: [],
  mail: [],
  file: { version: 1, prs: [] },
  ...over,
})

/** a fake `gh` that answers by matching the joined argv against a prefix table; every call is recorded */
function fakeGh(table: { when: string; reply: GhResult }[], calls: string[][] = []): Gh {
  return async (argv, _opts) => {
    calls.push(argv)
    const joined = argv.join(' ')
    const hit = table.find(t => joined.startsWith(t.when))
    return hit ? hit.reply : { code: 1, out: '', err: `unmocked: ${joined}` }
  }
}

test("buildPrs: a search finds a companion PR in another repo and drops one created before the run started; the run's own branch PR is corroborated by the branch listing", async () => {
  const now = 2_000_000_000
  const calls: string[][] = []
  const gh = fakeGh(
    [
      {
        when: 'pr list --state all',
        reply: {
          code: 0,
          out: JSON.stringify([
            { url: 'https://github.com/acme/widget/pull/551', headRefName: `factory/${RUN_ID}` },
          ]),
          err: '',
        },
      },
      {
        when: 'search prs --owner acme',
        reply: {
          code: 0,
          out: JSON.stringify([
            { url: 'https://github.com/acme/widget-deploy/pull/65', createdAt: '2026-10-12T08:49:00Z' },
            { url: 'https://github.com/acme/widget/pull/549', createdAt: '2026-10-11T00:00:00Z' }, // pre-existing: dropped
          ]),
          err: '',
        },
      },
      {
        when: 'pr view https://github.com/acme/widget/pull/551',
        reply: {
          code: 0,
          out: JSON.stringify({
            title: 'ex-12.3 build',
            state: 'merged',
            isDraft: false,
            reviewDecision: '',
            mergeStateStatus: 'MERGED',
            statusCheckRollup: [],
            updatedAt: '2026-10-12T09:00:00Z',
            headRefName: `factory/${RUN_ID}`,
            body: '',
          }),
          err: '',
        },
      },
      {
        when: 'pr view https://github.com/acme/widget-deploy/pull/65',
        reply: {
          code: 0,
          out: JSON.stringify({
            title: 'migrate-stage',
            state: 'open',
            isDraft: true,
            reviewDecision: '',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [],
            updatedAt: '2026-10-12T09:05:00Z',
            headRefName: 'release/widget-release-2026-10-12',
            body: "carries ex-12.3's re-pin",
          }),
          err: '',
        },
      },
    ],
    calls,
  )
  const r = run({})
  const { files, rows } = await buildPrs([r], IS_STATION, gh, now)
  expect(rows).toHaveLength(1)
  const prs = rows[0]!.prs
  expect(prs.find(p => p.number === 551)).toMatchObject({ role: 'code', state: 'MERGED' })
  // #65 is found by this same call's search, but a budget's views are decided before the search runs, so
  // it is only corroborated (and already classed companion from that alone) here; it is viewed next call
  expect(prs.find(p => p.number === 65)).toMatchObject({
    role: 'companion',
    state: 'UNKNOWN',
    corroborated: true,
  })
  expect(prs.find(p => p.number === 549)).toBeUndefined() // dropped by keepSearchHit before it ever became a record
  expect(files.get(RUN_ID)!.searchedAt).toBe(now)
  // the view call for #549 never happens: it was never added, so never due
  expect(calls.some(c => c.join(' ').includes('/pull/549'))).toBe(false)

  // next call (the search's TTL not yet up): #65 is now stale (UNKNOWN), so it gets viewed
  const calls2: string[][] = []
  const gh2 = fakeGh(
    [
      { when: 'pr list --state all', reply: { code: 0, out: '[]', err: '' } },
      {
        when: 'pr view https://github.com/acme/widget-deploy/pull/65',
        reply: {
          code: 0,
          out: JSON.stringify({
            title: 'migrate-stage',
            state: 'open',
            isDraft: true,
            reviewDecision: '',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [],
            updatedAt: '2026-10-12T09:05:00Z',
            headRefName: 'release/widget-release-2026-10-12',
            body: "carries ex-12.3's re-pin",
          }),
          err: '',
        },
      },
    ],
    calls2,
  )
  const r2 = run({ file: files.get(RUN_ID)! })
  const second = await buildPrs([r2], IS_STATION, gh2, now + 1000)
  expect(second.rows[0]!.prs.find(p => p.number === 65)).toMatchObject({
    role: 'companion',
    state: 'OPEN',
    isDraft: true,
  })
})

test('buildPrs: a MERGED PR is never viewed again; a failed view on a second call keeps the record and sets its error', async () => {
  const now1 = 1_000_000_000
  const calls1: string[][] = []
  const openPr = {
    url: 'https://github.com/acme/widget/pull/551',
    repo: 'acme/widget',
    number: 551,
    title: 'old title',
    role: 'code' as const,
    station: 'review',
    firstSeenAt: 1,
    source: 'report' as const,
    corroborated: true,
    state: 'OPEN' as const,
    isDraft: false,
    reviewDecision: '',
    mergeStateStatus: '',
    checks: { pass: 0, fail: 0, pending: 0 },
    updatedAt: '',
    checkedAt: 0,
    ownHead: true,
    namesIt: false,
    errorStreak: 0,
    erroredAt: 0,
  }
  const mergedPr = {
    ...openPr,
    url: 'https://github.com/acme/widget/pull/552',
    number: 552,
    state: 'MERGED' as const,
    checkedAt: now1,
  }
  const noList: GhResult = { code: 0, out: '[]', err: '' }
  const gh1 = fakeGh(
    [
      { when: 'pr list --state all', reply: noList },
      {
        when: 'pr view https://github.com/acme/widget/pull/551',
        reply: {
          code: 0,
          out: JSON.stringify({
            title: 'ex-12.3',
            state: 'open',
            isDraft: false,
            reviewDecision: '',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [],
            updatedAt: '2026-10-12T09:00:00Z',
            headRefName: `factory/${RUN_ID}`,
            body: '',
          }),
          err: '',
        },
      },
    ],
    calls1,
  )
  const r1 = run({ bead: undefined, file: { version: 1, prs: [openPr, mergedPr] } })
  const first = await buildPrs([r1], IS_STATION, gh1, now1)
  const calledUrls1 = calls1.filter(c => c[0] === 'pr' && c[1] === 'view').map(c => c[2])
  expect(calledUrls1).toEqual(['https://github.com/acme/widget/pull/551']) // not the merged one

  const now2 = now1 + 3 * 60_000 // past the OPEN TTL
  const calls2: string[][] = []
  const gh2 = fakeGh(
    [
      { when: 'pr list --state all', reply: noList },
      {
        when: 'pr view https://github.com/acme/widget/pull/551',
        reply: { code: 1, out: '', err: 'HTTP 502' },
      },
    ],
    calls2,
  )
  const r2 = run({ bead: undefined, file: first.files.get(RUN_ID)! })
  const second = await buildPrs([r2], IS_STATION, gh2, now2)
  const pr551 = second.rows[0]!.prs.find(p => p.number === 551)!
  expect(pr551.state).toBe('OPEN') // kept from the first call
  expect(pr551.title).toBe('ex-12.3') // kept
  expect(pr551.error).toBe('HTTP 502')
  const pr552 = second.rows[0]!.prs.find(p => p.number === 552)!
  expect(pr552.error).toBeUndefined() // the merged one was never touched this call either
})

test('buildPrs: a MERGED companion PR named only in its gh-viewed body keeps its role on a later call, even though that call never re-views it (wyc.4)', async () => {
  const now1 = 1_000_000_000
  const seed = {
    url: 'https://github.com/acme/widget-deploy/pull/65',
    repo: 'acme/widget-deploy',
    number: 65,
    title: '',
    role: 'mentioned' as const,
    station: 'deploy',
    firstSeenAt: 1,
    source: 'mail' as const,
    corroborated: false,
    state: 'UNKNOWN' as const,
    isDraft: false,
    reviewDecision: '',
    mergeStateStatus: '',
    checks: { pass: 0, fail: 0, pending: 0 },
    updatedAt: '',
    checkedAt: 0,
    ownHead: false,
    namesIt: false,
    errorStreak: 0,
    erroredAt: 0,
  }
  const noList: GhResult = { code: 0, out: '[]', err: '' }
  const noSearch: GhResult = { code: 0, out: '[]', err: '' }
  const gh1 = fakeGh([
    { when: 'pr list --state all', reply: noList },
    { when: 'search prs --owner', reply: noSearch },
    {
      when: 'pr view https://github.com/acme/widget-deploy/pull/65',
      reply: {
        code: 0,
        out: JSON.stringify({
          title: 'migrate-stage tester-trusted-root',
          state: 'merged',
          isDraft: false,
          reviewDecision: '',
          mergeStateStatus: 'MERGED',
          statusCheckRollup: [],
          updatedAt: '2026-10-12T09:10:00Z',
          headRefName: 'release/widget-release-2026-10-12', // not the run's own branch
          body: "carries ex-12.3's re-pin", // names the bead only here, in the body
        }),
        err: '',
      },
    },
  ])
  const r1 = run({ file: { version: 1, prs: [seed] } })
  const first = await buildPrs([r1], IS_STATION, gh1, now1)
  const pr65after1 = first.rows[0]!.prs.find(p => p.number === 65)!
  expect(pr65after1).toMatchObject({ role: 'companion', state: 'MERGED' })

  // a second call: MERGED is never re-viewed (needsView says so), so nothing refreshes headRefName/body
  // this call; only the always-run mention fold recomputes role from the stored record
  const now2 = now1 + 24 * 60 * 60_000
  const gh2 = fakeGh([
    { when: 'pr list --state all', reply: noList },
    { when: 'search prs --owner', reply: noSearch },
  ])
  const r2 = run({ file: first.files.get(RUN_ID)! })
  const second = await buildPrs([r2], IS_STATION, gh2, now2)
  const pr65after2 = second.rows[0]!.prs.find(p => p.number === 65)!
  expect(pr65after2.role).toBe('companion') // not demoted to 'mentioned' for lack of a fresh view
  expect(pr65after2.state).toBe('MERGED')
})

test("buildPrs: a run whose rig has no GitHub owner never calls `gh search prs --owner ''`, and still marks itself searched so it is not retried every call (wyc.8)", async () => {
  const now = 1_000_000_000
  const calls: string[][] = []
  const gh = fakeGh([{ when: 'pr list --state all', reply: { code: 0, out: '[]', err: '' } }], calls)
  const r = run({ owner: '' })
  const { files } = await buildPrs([r], IS_STATION, gh, now)
  expect(calls.some(c => c[0] === 'search')).toBe(false)
  expect(files.get(RUN_ID)!.searchedAt).toBe(now) // marked done, not left perpetually due
})

test("buildPrs: an ended run's search drops a hit created after it ended, like a later run of the same bead (wyc.5)", async () => {
  const now = 3_000_000_000
  const gh = fakeGh([
    { when: 'pr list --state all', reply: { code: 0, out: '[]', err: '' } },
    {
      when: 'search prs --owner acme',
      reply: {
        code: 0,
        out: JSON.stringify([
          { url: 'https://github.com/acme/widget/pull/700', createdAt: '2026-10-12T15:45:00Z' }, // while this run was active
          { url: 'https://github.com/acme/widget/pull/701', createdAt: '2026-10-13T00:00:00Z' }, // a later run of the same bead
        ]),
        err: '',
      },
    },
  ])
  const r = run({ ended: true, endAt: 1791819735929 }) // the run's own last log entry
  const { rows } = await buildPrs([r], IS_STATION, gh, now)
  const prs = rows[0]!.prs
  expect(prs.find(p => p.number === 700)).toBeDefined()
  expect(prs.find(p => p.number === 701)).toBeUndefined()
})

test('buildPrs: a failed final search is retried (not given up on) once its backoff elapses, and finds the PR search alone could ever surface (wyc.11)', async () => {
  const now1 = 3_000_000_000
  const gh1 = fakeGh([
    { when: 'pr list --state all', reply: { code: 0, out: '[]', err: '' } },
    { when: 'search prs --owner acme', reply: { code: 1, out: '', err: 'rate limit' } },
  ])
  const r1 = run({ ended: true, endAt: 1791819735929 })
  const first = await buildPrs([r1], IS_STATION, gh1, now1)
  const file1 = first.files.get(RUN_ID)!
  expect(file1.searchedFinal).not.toBe(true) // a failed search must not spend the run's one shot
  expect(first.rows[0]!.error).toBeDefined()

  // immediately again: still backing off, gh must not be re-called
  const calls2: string[][] = []
  const gh2 = fakeGh([{ when: 'pr list --state all', reply: { code: 0, out: '[]', err: '' } }], calls2)
  const r2 = run({ ended: true, endAt: 1791819735929, file: file1 })
  await buildPrs([r2], IS_STATION, gh2, now1 + 1_000)
  expect(calls2.some(c => c[0] === 'search')).toBe(false)

  // past the backoff window, with a healthy gh: the PR search alone could find is finally found
  const now2 = now1 + 2 * 60_000
  const gh3 = fakeGh([
    { when: 'pr list --state all', reply: { code: 0, out: '[]', err: '' } },
    {
      when: 'search prs --owner acme',
      reply: {
        code: 0,
        out: JSON.stringify([
          { url: 'https://github.com/acme/widget/pull/700', createdAt: '2026-10-12T15:45:00Z' },
        ]),
        err: '',
      },
    },
  ])
  const r3 = run({ ended: true, endAt: 1791819735929, file: file1 })
  const second = await buildPrs([r3], IS_STATION, gh3, now2)
  expect(second.rows[0]!.prs.find(p => p.number === 700)).toBeDefined()
  expect(second.files.get(RUN_ID)!.searchedFinal).toBe(true) // only a success spends the one shot
})

test('buildPrs spends at most the view budget in one call, 6 at a time, deferring the rest', async () => {
  const now = 1_000_000_000
  const prs = Array.from({ length: 45 }, (_, i) => ({
    url: `https://github.com/acme/widget/pull/${i}`,
    repo: 'acme/widget',
    number: i,
    title: '',
    role: 'code' as const,
    station: 'review',
    firstSeenAt: 1,
    source: 'report' as const,
    corroborated: true,
    state: 'OPEN' as const,
    isDraft: false,
    reviewDecision: '',
    mergeStateStatus: '',
    checks: { pass: 0, fail: 0, pending: 0 },
    updatedAt: '',
    checkedAt: 0,
    ownHead: false,
    namesIt: false,
    errorStreak: 0,
    erroredAt: 0,
  }))
  let inFlight = 0
  let maxInFlight = 0
  const calls: string[][] = []
  const gh: Gh = async argv => {
    calls.push(argv)
    if (argv[0] === 'pr' && argv[1] === 'list') return { code: 0, out: '[]', err: '' }
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(res => setTimeout(res, 1))
    inFlight--
    return {
      code: 0,
      out: JSON.stringify({
        title: '',
        state: 'open',
        isDraft: false,
        reviewDecision: '',
        mergeStateStatus: '',
        statusCheckRollup: [],
        updatedAt: '',
        headRefName: '',
        body: '',
      }),
      err: '',
    }
  }
  const r = run({ bead: undefined, file: { version: 1, prs } })
  const { rows } = await buildPrs([r], IS_STATION, gh, now)
  const viewed = calls.filter(c => c[0] === 'pr' && c[1] === 'view')
  expect(viewed).toHaveLength(30) // DEFAULT_BUDGET.views
  expect(maxInFlight).toBeLessThanOrEqual(6)
  const stillStale = rows[0]!.prs.filter(p => p.checkedAt === 0)
  expect(stillStale).toHaveLength(15) // deferred to a later call
})

test('buildPrs: an exhausted overall deadline stops spending new gh calls past it, leaving the rest for a later call (wyc.7)', async () => {
  const now = 1_000_000_000
  let clockCalls = 0
  // the deadline check (`deadlineAt = clock() + deadlineMs`) uses its own clock, separate from `now`'s
  // recorded timestamps: the first call sets up the 10ms deadline, the one right after still reports
  // being inside it (so the first repo's branch list is fetched), everything after is reported as long
  // past it
  const clock = () => (++clockCalls <= 2 ? 0 : 1_000_000)
  const calls: string[][] = []
  const gh: Gh = async argv => {
    calls.push(argv)
    if (argv[0] === 'pr' && argv[1] === 'list') return { code: 0, out: '[]', err: '' }
    return {
      code: 0,
      out: JSON.stringify({
        title: '',
        state: 'open',
        isDraft: false,
        reviewDecision: '',
        mergeStateStatus: '',
        statusCheckRollup: [],
        updatedAt: '',
        headRefName: '',
        body: '',
      }),
      err: '',
    }
  }
  const r1 = run({ id: 'lifecycle-one', repoDir: '/repo/one' })
  const r2 = run({ id: 'lifecycle-two', repoDir: '/repo/two' })
  await buildPrs([r1, r2], IS_STATION, gh, now, DEFAULT_BUDGET, clock, 10)
  const listCalls = calls.filter(c => c[0] === 'pr' && c[1] === 'list')
  expect(listCalls).toHaveLength(1) // repo "two"'s branch list never ran: the deadline hit first
  expect(calls.some(c => c[0] === 'search')).toBe(false) // the search loop never got a turn either
})

// ---- GitLab merge requests ----

import {
  forgeNote,
  forgeOf,
  gitlabForge,
  gitlabNotes,
  gitlabWatchNotes,
  mrsIn,
  parseGitlabLabeled,
  parseGitlabList,
  parseGitlabSearch,
  parseGitlabView,
  parseRemote,
} from './prs'

const MR_URL = 'https://gitlab.example.com/group/sub/project/-/merge_requests/12'

test('prRef parses a GitLab merge request URL keeping the full project path, and leaves GitHub as it was', () => {
  expect(prRef(MR_URL)).toEqual({ repo: 'group/sub/project', number: 12, forge: 'gitlab' })
  expect(prRef('https://gitlab.com/group/project/-/merge_requests/3')).toEqual({
    repo: 'group/project',
    number: 3,
    forge: 'gitlab',
  })
  expect(prRef('https://gitlab.example.com/group/project/-/issues/3')).toBeNull()
  expect(prRef('https://github.com/acme/widget/-/merge_requests/3')).toBeNull() // github.com is never GitLab
  expect(prRef('https://github.com/acme/widget/pull/551')).toEqual({ repo: 'acme/widget', number: 551 }) // no forge key
})

test('mrsIn finds merge request URLs in a text, once each, and ignores pull requests', () => {
  expect(mrsIn(`see ${MR_URL}, again ${MR_URL}; and https://github.com/acme/widget/pull/5`)).toEqual([MR_URL])
})

test('foldMentions and foldFound give a merge request record its forge, a pull request none', () => {
  const [mr] = foldMentions([], [{ url: MR_URL, station: 'implement', at: 1, source: 'report' }])
  expect(mr).toMatchObject({ repo: 'group/sub/project', number: 12, forge: 'gitlab' })
  const [pr] = foldFound([], [{ url: 'https://github.com/acme/widget/pull/5', at: 1, source: 'branch' }])
  expect('forge' in pr!).toBe(false)
})

test('parseRemote reads https, ssh:// and scp-style remotes, and forgeOf tells the forge from the host', () => {
  expect(parseRemote('https://gitlab.example.com/group/sub/project.git')).toEqual({
    host: 'gitlab.example.com',
    path: 'group/sub/project',
  })
  expect(parseRemote('git@gitlab.example.com:group/project.git')).toEqual({
    host: 'gitlab.example.com',
    path: 'group/project',
  })
  expect(parseRemote('ssh://git@git.example.com:2222/group/project')).toEqual({
    host: 'git.example.com',
    path: 'group/project',
  })
  expect(parseRemote('not a remote')).toBeNull()
  expect(forgeOf('github.com')).toBe('github')
  expect(forgeOf('gitlab.com')).toBe('gitlab')
  expect(forgeOf('gitlab.example.com')).toBe('gitlab')
  expect(forgeOf('git.example.com')).toBeNull() // not named for GitLab, and glab does not know it
  expect(forgeOf('git.example.com', h => h === 'git.example.com')).toBe('gitlab') // glab does
})

const MR = {
  title: 'Add the thing',
  state: 'opened',
  draft: false,
  updated_at: '2026-10-12T09:00:00Z',
  source_branch: `factory/${RUN_ID}`,
  description: 'for ex-12.3',
  detailed_merge_status: 'mergeable',
  head_pipeline: { status: 'success' },
}

test('parseGitlabView maps state, draft, approvals, pipeline and merge status onto the PR fields', () => {
  const v = parseGitlabView(JSON.stringify(MR), JSON.stringify({ approved: true, approvals_left: 0 }))
  expect(v).toEqual({
    title: 'Add the thing',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    checks: { pass: 1, fail: 0, pending: 0 },
    updatedAt: '2026-10-12T09:00:00Z',
    headRefName: `factory/${RUN_ID}`,
    body: 'for ex-12.3',
  })
  const view = (over: object, approvals = '') =>
    parseGitlabView(JSON.stringify({ ...MR, ...over }), approvals)!
  expect(view({ state: 'merged' }).state).toBe('MERGED')
  expect(view({ state: 'closed' }).state).toBe('CLOSED')
  expect(view({ draft: true }).isDraft).toBe(true)
  expect(view({}, JSON.stringify({ approved: false, approvals_left: 2 })).reviewDecision).toBe(
    'REVIEW_REQUIRED',
  )
  expect(view({}, 'not json').reviewDecision).toBe('') // a failed approvals call leaves it blank
  expect(view({ detailed_merge_status: 'requested_changes' }).reviewDecision).toBe('CHANGES_REQUESTED')
  expect(view({ detailed_merge_status: 'conflict' }).mergeStateStatus).toBe('DIRTY')
  expect(view({ detailed_merge_status: 'need_rebase' }).mergeStateStatus).toBe('BEHIND')
  expect(view({ detailed_merge_status: 'not_approved' }).mergeStateStatus).toBe('BLOCKED')
  expect(view({ detailed_merge_status: 'checking' }).mergeStateStatus).toBe('UNKNOWN')
  expect(view({ detailed_merge_status: 'ci_must_pass', head_pipeline: { status: 'failed' } })).toMatchObject({
    mergeStateStatus: 'UNSTABLE',
    checks: { pass: 0, fail: 1, pending: 0 },
  })
  expect(view({ head_pipeline: { status: 'running' } }).checks).toEqual({ pass: 0, fail: 0, pending: 1 })
  expect(view({ head_pipeline: null }).checks).toEqual({ pass: 0, fail: 0, pending: 0 })
  expect(parseGitlabView('nope')).toBeNull()
})

test('parseGitlabList and parseGitlabSearch read a project listing, the search keeping its time window', () => {
  const out = JSON.stringify([
    { web_url: MR_URL, source_branch: 'factory/x', created_at: '2026-10-12T08:49:00Z' },
    { web_url: `${MR_URL}0`, source_branch: 'other', created_at: '2026-10-11T00:00:00Z' },
  ])
  expect(parseGitlabList(out)).toEqual([
    { url: MR_URL, headRefName: 'factory/x' },
    { url: `${MR_URL}0`, headRefName: 'other' },
  ])
  expect(parseGitlabList('nope')).toEqual([])
  expect(parseGitlabSearch(out, 1791791066107, 1791819735929, 5)).toEqual([
    { url: MR_URL, at: 5, source: 'search' },
  ])
})

test('buildPrs: a GitLab rig lists, searches and views merge requests through glab, never gh', async () => {
  const now = 2_000_000_000
  const ghCalls: string[][] = []
  const gh = fakeGh([], ghCalls)
  const glabCalls: string[][] = []
  const other = 'https://gitlab.example.com/group/other/-/merge_requests/4'
  const api = 'api --hostname gitlab.example.com projects/'
  const glab = fakeGh(
    [
      {
        when: `${api}group%2Fsub%2Fproject/merge_requests?state=all&order_by`,
        reply: {
          code: 0,
          out: JSON.stringify([{ web_url: MR_URL, source_branch: `factory/${RUN_ID}` }]),
          err: '',
        },
      },
      {
        when: `${api}group%2Fsub%2Fproject/merge_requests?state=all&in=title`,
        reply: {
          code: 0,
          out: JSON.stringify([{ web_url: other, created_at: '2026-10-12T09:00:00Z' }]),
          err: '',
        },
      },
      {
        when: `${api}group%2Fsub%2Fproject/merge_requests/12/approvals`,
        reply: { code: 0, out: JSON.stringify({ approved: true, approvals_left: 0 }), err: '' },
      },
      {
        when: `${api}group%2Fsub%2Fproject/merge_requests/12`,
        reply: { code: 0, out: JSON.stringify(MR), err: '' },
      },
      { when: `${api}group%2Fother/merge_requests/4`, reply: { code: 1, out: '', err: '404 Not Found' } },
    ],
    glabCalls,
  )
  const r = run({
    runRepo: 'group/sub/project',
    owner: 'group/sub',
    forge: 'gitlab',
    host: 'gitlab.example.com',
  })
  // the first call lists and searches, so both MRs exist; the second views them
  const first = await buildPrs([r], IS_STATION, gh, now, DEFAULT_BUDGET, Date.now, 60_000, glab)
  const again = { ...r, file: first.files.get(RUN_ID)! }
  const second = await buildPrs([again], IS_STATION, gh, now + 1, DEFAULT_BUDGET, Date.now, 60_000, glab)
  expect(ghCalls).toEqual([])
  const prs = second.rows[0]!.prs
  expect(prs.find(p => p.url === MR_URL)).toMatchObject({
    forge: 'gitlab',
    repo: 'group/sub/project',
    state: 'OPEN',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    checks: { pass: 1, fail: 0, pending: 0 },
    ownHead: true,
    role: 'code',
  })
  // a search hit in another project is kept, and its failed view is that MR's own error
  expect(prs.find(p => p.url === other)).toMatchObject({
    forge: 'gitlab',
    repo: 'group/other',
    errorStreak: 1,
    error: '404 Not Found',
  })
})

test('parseGitlabLabeled gives labelPass the fields gh pr list does', () => {
  const mr = {
    iid: 7,
    web_url: MR_URL,
    source_branch: 'feat/x',
    target_branch: 'main',
    source_project_id: 5,
    target_project_id: 5,
    labels: ['rework', 'bug'],
  }
  expect(parseGitlabLabeled(JSON.stringify([mr, { ...mr, iid: 8, source_project_id: 9 }]))).toEqual([
    {
      number: 7,
      url: MR_URL,
      headRefName: 'feat/x',
      baseRefName: 'main',
      isCrossRepository: false,
      labels: [{ name: 'rework' }, { name: 'bug' }],
    },
    expect.objectContaining({ number: 8, isCrossRepository: true }),
  ])
  expect(parseGitlabLabeled(JSON.stringify([{ ...mr, labels: undefined }]))[0]!.labels).toEqual([])
  expect(parseGitlabLabeled('not json')).toEqual([])
  expect(parseGitlabLabeled(JSON.stringify([{ title: 'no iid' }]))).toEqual([])
})

test('forgeNote tells a GitLab worker the glab equivalents, and a GitHub worker nothing', () => {
  const note = forgeNote('gitlab.example.com').join('\n')
  expect(note).toContain('GitLab at gitlab.example.com')
  for (const gl of ['glab mr create', 'glab mr note', 'glab mr approve', 'glab ci status', 'glab api'])
    expect(note).toContain(gl)
  expect(forgeNote()).toEqual([])
})

test('parseGitlabView reads the head sha, merge and close times for the park watch (5wav AC10)', () => {
  const v = parseGitlabView(
    JSON.stringify({
      ...MR,
      sha: 'abc1234',
      merged_at: '2026-10-12T11:00:00Z',
      closed_at: '2026-10-12T12:00:00Z',
    }),
  )!
  expect(v).toMatchObject({
    headSha: 'abc1234',
    mergedAt: '2026-10-12T11:00:00Z',
    closedAt: '2026-10-12T12:00:00Z',
  })
})

const noteList = JSON.stringify([
  {
    created_at: '2026-10-12T10:00:00Z',
    body: '/changes rename it',
    system: false,
    author: { username: 'zach', id: 7 },
  },
  {
    created_at: '2026-10-12T10:01:00Z',
    body: 'pushed 1 commit',
    system: true,
    author: { username: 'zach', id: 7 },
  },
  {
    created_at: '2026-10-12T10:02:00Z',
    body: 'bot',
    system: false,
    author: { username: 'project_9_bot_x', id: 7 },
  },
  {
    created_at: '2026-10-12T10:03:00Z',
    body: 'bot',
    system: false,
    author: { username: 'ci', id: 7, bot: true },
  },
  {
    created_at: '2026-10-12T10:04:00Z',
    body: '/changes me',
    system: false,
    author: { username: 'stranger', id: 9 },
  },
  { created_at: 'garbage', body: 'x', system: false, author: { username: 'zach', id: 7 } },
])

test('gitlabNotes: only a project member who is no bot, with a human note, is a person (5wav.7)', () => {
  const notes = gitlabNotes(noteList, new Set([7]))
  expect(notes.map(n => n.person)).toEqual([true, false, false, false, false])
  expect(notes[0]).toMatchObject({ body: '/changes rename it', changesRequested: false })
  expect(gitlabNotes(noteList).some(n => n.person)).toBe(false)
})

/** a fake glab that answers the notes call and a members call by user id, and logs every path */
function glabFake(members: Record<number, GhResult>) {
  const paths: string[] = []
  const glab: Gh = async argv => {
    const path = argv.at(-1)!
    paths.push(path)
    if (path.includes('/notes?')) return { code: 0, out: noteList, err: '' }
    const id = Number(path.split('/members/all/')[1])
    return members[id] ?? { code: 1, out: '', err: '404 Not Found' }
  }
  return { glab, paths }
}

test('gitlabWatchNotes asks the project for each human author and trusts access level 30 or above (5wav.7)', async () => {
  const { glab, paths } = glabFake({
    7: { code: 0, out: '{"access_level":30}', err: '' },
    9: { code: 0, out: '{"access_level":10}', err: '' },
  })
  const notes = await gitlabWatchNotes(glab, MR_URL, '/tmp')
  expect(notes!.map(n => n.person)).toEqual([true, false, false, false, false])
  expect(paths.filter(p => p.includes('/members/all/')).sort()).toEqual([
    'projects/group%2Fsub%2Fproject/members/all/7',
    'projects/group%2Fsub%2Fproject/members/all/9',
  ])
})

test('gitlabWatchNotes: a 404 is no member, any other failure gives null (5wav.7)', async () => {
  expect((await gitlabWatchNotes(glabFake({}).glab, MR_URL, '/tmp'))!.some(n => n.person)).toBe(false)
  const boom = glabFake({ 7: { code: 1, out: '', err: 'timeout' } })
  expect(await gitlabWatchNotes(boom.glab, MR_URL, '/tmp')).toBeNull()
})

test('gitlabForge.view never fetches notes, so the PR panel pays no extra call (5wav.9)', async () => {
  const paths: string[] = []
  const glab: Gh = async argv => {
    paths.push(argv.at(-1)!)
    return { code: 0, out: JSON.stringify(MR), err: '' }
  }
  const res = await gitlabForge(glab).view(MR_URL, '/tmp')
  expect('viewed' in res).toBe(true)
  expect(paths.some(p => p.includes('/notes'))).toBe(false)
  expect(paths).toHaveLength(2)
})
