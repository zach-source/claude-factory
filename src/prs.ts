// Per-run pull request records: every PR a run touches, not just open ones on its own branch in its own
// repo. Pure matching/merge/role/budget logic lives here, read-only against a run's log and inbox; the IO
// half (`refresh`) calls `gh` through an injected function, so tests never shell out for real.
import type { Entry } from './machine'

export type PrSource = 'report' | 'mail' | 'search' | 'branch'
export type PrRole = 'code' | 'companion' | 'deploy' | 'mentioned'
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'

export type Checks = { pass: number; fail: number; pending: number }

export type PrRecord = {
  url: string
  /** owner/name */
  repo: string
  number: number
  title: string
  role: PrRole
  /** the station that first named it, or '' when it was only found by search or branch */
  station: string
  firstSeenAt: number
  source: PrSource
  /** also turned up by a search or the rig's branch listing, not only a report or mail mention */
  corroborated: boolean
  state: PrState
  isDraft: boolean
  reviewDecision: string
  mergeStateStatus: string
  checks: Checks
  updatedAt: string
  /** when gh last answered for this PR, 0 until the first refresh */
  checkedAt: number
  error?: string
}

export type PrsFile = {
  version: 1
  /** when this run's bead was last searched for, so a live run is re-searched every 10 min */
  searchedAt?: number
  /** an ended run gets one search after it ends, then never again */
  searchedFinal?: boolean
  prs: PrRecord[]
}

/** owner/name and number out of a github.com pull request URL, or null for anything else */
export function prRef(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

/**
 * whether text names this bead or a dotted descendant of it (proj-1.2 matches "proj-1.2:" and
 * "proj-1.2.5") but not a longer sibling id sharing its prefix (proj-1.20) or a shorter ancestor
 * (proj-1 alone never matches "proj-1.2")
 */
export function namesBead(bead: string, text: string): boolean {
  const esc = bead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.-])${esc}(?:\\.\\d+)*(?![\\w-]|\\.\\w)`).test(text)
}

/** a PR mention pulled from a report summary or a mail line: where and when it was first named */
export type Mention = { url: string; station: string; at: number; source: 'report' | 'mail' }

/** every PR mention in a run's reports (AC2a) and inbox mail (AC2b); `isStation` tells a mail `from` a
 * station from the manager or a person, so the station credited is whichever of from/to is one */
export function collectMentions(
  log: Entry[],
  mail: { from: string; to: string; text: string; at: number }[],
  isStation: (id: string) => boolean,
  prsIn: (text: string) => string[],
): Mention[] {
  const hits: Mention[] = []
  for (const e of log)
    for (const url of prsIn(e.summary)) hits.push({ url, station: e.node, at: e.at, source: 'report' })
  for (const m of mail)
    for (const url of prsIn(m.text))
      hits.push({ url, station: isStation(m.from) ? m.from : m.to, at: m.at, source: 'mail' })
  return hits
}

const blank = (url: string, number: number, repo: string, station: string, at: number, source: PrSource): PrRecord => ({
  url,
  repo,
  number,
  title: '',
  role: 'mentioned',
  station,
  firstSeenAt: at,
  source,
  corroborated: false,
  state: 'UNKNOWN',
  isDraft: false,
  reviewDecision: '',
  mergeStateStatus: '',
  checks: { pass: 0, fail: 0, pending: 0 },
  updatedAt: '',
  checkedAt: 0,
})

/** folds mentions into an existing record list: a new URL gets a blank row at its first sighting; an
 * already-known URL keeps its first-seen station, source and time (AC2's "first-seen ... kept") */
export function foldMentions(existing: PrRecord[], hits: Mention[]): PrRecord[] {
  const byUrl = new Map(existing.map(r => [r.url, r]))
  for (const h of [...hits].sort((a, b) => a.at - b.at)) {
    if (byUrl.has(h.url)) continue
    const ref = prRef(h.url)
    if (!ref) continue
    byUrl.set(h.url, blank(h.url, ref.number, ref.repo, h.station, h.at, h.source))
  }
  return [...byUrl.values()]
}

/** a PR turned up independently by `gh search prs` or the rig's branch listing: corroborating evidence it
 * is really the run's, kept even when the record already exists from a mention alone */
export type Found = { url: string; at: number; source: 'search' | 'branch' }

/** AC2c: a search hit counts only when created at or after the run's start minus 10 min, so a pre-existing
 * PR the text search merely resembles (an earlier sibling's release PR) is dropped before it is ever added */
export function keepSearchHit(createdAt: string, runStartAt: number): boolean {
  return Date.parse(createdAt) >= runStartAt - 10 * 60_000
}

/** folds search/branch findings into an existing record list, marking every one (new or already known)
 * `corroborated`, since AC3's 'mentioned' role only ever applies to a PR that came from a mention alone */
export function foldFound(existing: PrRecord[], found: Found[]): PrRecord[] {
  const byUrl = new Map(existing.map(r => [r.url, r]))
  for (const f of [...found].sort((a, b) => a.at - b.at)) {
    const prior = byUrl.get(f.url)
    if (prior) {
      byUrl.set(f.url, { ...prior, corroborated: true })
      continue
    }
    const ref = prRef(f.url)
    if (!ref) continue
    byUrl.set(f.url, { ...blank(f.url, ref.number, ref.repo, '', f.at, f.source), corroborated: true })
  }
  return [...byUrl.values()]
}

/** pass/fail/pending tally of a PR's statusCheckRollup, however `gh` names each check's conclusion */
export function checksOf(rollup: { conclusion?: string | null; status?: string }[] = []): Checks {
  const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
  const FAIL = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
  let pass = 0,
    fail = 0,
    pending = 0
  for (const c of rollup) {
    const conclusion = (c.conclusion ?? '').toUpperCase()
    if (PASS.has(conclusion)) pass++
    else if (FAIL.has(conclusion)) fail++
    else pending++
  }
  return { pass, fail, pending }
}

/** what role() needs about a PR beyond what the stored record gives: headRefName and body are never
 * stored (a body is only ever used transiently, to test namesBead, never persisted or printed) */
export type RoleInput = Pick<PrRecord, 'repo' | 'title' | 'station' | 'corroborated'> & {
  headRefName?: string
  body?: string
}
export type RoleCtx = {
  runId: string
  /** owner/name of the run's own rig repo */
  runRepo: string
  bead?: string
}

/**
 * AC3: a PR is the run's own when its head is this run's branch, when its title or body names the run's
 * bead (or a dotted descendant), or when a search or the branch listing corroborates it independently of
 * any report/mail mention. Anything else that was only ever mentioned in a report or mail is 'mentioned'.
 * Of the run's own PRs: 'code' in the run's own repo; else 'companion' when it names the bead (a
 * cross-repo PR authored for this bead's own work); else 'deploy' when first seen at the deploy or
 * rollback station (a routine release artifact that never names the bead); else 'companion'.
 */
export function role(pr: RoleInput, ctx: RoleCtx): PrRole {
  const ownHead = (pr.headRefName ?? '') === `factory/${ctx.runId}`
  const sameRepo = pr.repo === ctx.runRepo
  const namesIt = ctx.bead ? namesBead(ctx.bead, `${pr.title}\n${pr.body ?? ''}`) : false
  const isOurs = ownHead || namesIt || pr.corroborated
  if (!isOurs) return 'mentioned'
  if (sameRepo) return 'code'
  if (namesIt) return 'companion'
  if (pr.station === 'deploy' || pr.station === 'rollback') return 'deploy'
  return 'companion'
}

const TTL_MS: Record<PrState, number> = { OPEN: 2 * 60_000, CLOSED: 30 * 60_000, MERGED: Infinity, UNKNOWN: 0 }

/** whether a record is stale enough to spend a `gh pr view` on: a MERGED PR never needs one again */
export function needsView(pr: Pick<PrRecord, 'state' | 'checkedAt'>, now: number): boolean {
  if (pr.state === 'MERGED') return false
  return now - pr.checkedAt >= TTL_MS[pr.state]
}

export type RunInfo = { run: string; ended: boolean; bead?: string; at: number }
export type SearchState = { searchedAt?: number; searchedFinal?: boolean }
const LIVE_SEARCH_MS = 10 * 60_000

/** whether a run's bead is due another `gh search prs`: never without a bead; once more after a run ends,
 * then never; a live run, every 10 min */
export function needsSearch(run: Pick<RunInfo, 'ended' | 'bead'>, file: SearchState, now: number): boolean {
  if (!run.bead) return false
  if (run.ended) return !file.searchedFinal
  return file.searchedAt === undefined || now - file.searchedAt >= LIVE_SEARCH_MS
}

export type Budget = { searches: number; views: number }
export const DEFAULT_BUDGET: Budget = { searches: 10, views: 30 }

/** which runs are due a search, and which (run, PR url) pairs are due a view, under the call's budget:
 * live runs first, then ended runs newest first; whatever the budget leaves is deferred to a later call */
export function due(
  runs: RunInfo[],
  prsByRun: Map<string, Pick<PrRecord, 'url' | 'state' | 'checkedAt'>[]>,
  files: Map<string, SearchState>,
  now: number,
  budget: Budget = DEFAULT_BUDGET,
): { searches: string[]; views: { run: string; url: string }[] } {
  const ordered = [...runs].sort((a, b) => (a.ended === b.ended ? b.at - a.at : a.ended ? 1 : -1))
  const searches: string[] = []
  for (const r of ordered) {
    if (searches.length >= budget.searches) break
    if (needsSearch(r, files.get(r.run) ?? {}, now)) searches.push(r.run)
  }
  const views: { run: string; url: string }[] = []
  outer: for (const r of ordered) {
    for (const pr of prsByRun.get(r.run) ?? []) {
      if (views.length >= budget.views) break outer
      if (needsView(pr, now)) views.push({ run: r.run, url: pr.url })
    }
  }
  return { searches, views }
}
