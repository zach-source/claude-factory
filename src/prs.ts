// Per-run pull request records: every PR a run touches, not just open ones on its own branch in its own
// repo. Pure matching/merge/role/budget logic lives here, read-only against a run's log and inbox; the IO
// half (`buildPrs`) calls `gh` through an injected function, so tests never shell out for real.
import { prsIn, type Entry } from './machine'

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

// ---- IO: everything below shells out to `gh`, through an injected function so tests never really do ----

export type GhResult = { code: number; out: string; err: string }
/** `gh <argv>` run in `cwd`, killed after `timeout` ms: real calls go through `spawnGh`, tests inject a fake */
export type Gh = (argv: string[], opts: { cwd: string; timeout: number }) => Promise<GhResult>

/** the real `gh`, argv only (never a shell), stdout/stderr fully drained even past a kill */
export async function spawnGh(argv: string[], opts: { cwd: string; timeout: number }): Promise<GhResult> {
  const proc = Bun.spawn(['gh', ...argv], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }, opts.timeout)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  } finally {
    clearTimeout(timer)
  }
}

/** one line of `gh`'s stderr, cut short: never let a raw error carry a password or a full stack into the record */
const ghError = (err: string) => clip(err.trim().split('\n')[0] ?? 'gh failed', 200)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** AC2c parsed: `gh search prs ... --json url,createdAt` filtered by `keepSearchHit`, so a resembling PR
 * created before the run started is dropped before it ever becomes a Found */
export function parseSearch(out: string, runStartAt: number, now: number): Found[] {
  let hits: { url: string; createdAt: string }[]
  try {
    hits = JSON.parse(out)
  } catch {
    return []
  }
  return hits.filter(h => keepSearchHit(h.createdAt, runStartAt)).map(h => ({ url: h.url, at: now, source: 'search' as const }))
}

/** AC2d parsed: one `gh pr list --state all` per rig repo, independent of any run's budget */
export function parseBranchList(out: string): { url: string; headRefName: string }[] {
  try {
    return JSON.parse(out)
  } catch {
    return []
  }
}
/** which of a rig's listed PRs are a given run's own branch, as Found (corroborating, AC2d) */
export function branchFound(list: { url: string; headRefName: string }[], runId: string, now: number): Found[] {
  return list.filter(p => p.headRefName === `factory/${runId}`).map(p => ({ url: p.url, at: now, source: 'branch' as const }))
}

/** `gh pr view <url> --json ...` parsed: headRefName and body are used only to feed `role` right here, in
 * the same call, and are never carried into the stored PrRecord (RoleInput says so) */
export type Viewed = Pick<PrRecord, 'title' | 'state' | 'isDraft' | 'reviewDecision' | 'mergeStateStatus' | 'checks' | 'updatedAt'> & {
  headRefName: string
  body: string
}
export function parseView(out: string): Viewed | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(out)
  } catch {
    return null
  }
  return {
    title: typeof v.title === 'string' ? v.title : '',
    state: (typeof v.state === 'string' ? v.state.toUpperCase() : 'UNKNOWN') as PrState,
    isDraft: !!v.isDraft,
    reviewDecision: typeof v.reviewDecision === 'string' ? v.reviewDecision : '',
    mergeStateStatus: typeof v.mergeStateStatus === 'string' ? v.mergeStateStatus : '',
    checks: checksOf(Array.isArray(v.statusCheckRollup) ? (v.statusCheckRollup as { conclusion?: string | null }[]) : []),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    headRefName: typeof v.headRefName === 'string' ? v.headRefName : '',
    body: typeof v.body === 'string' ? v.body : '',
  }
}

/** a viewed PR folded into its record: every gh-sourced field refreshed, role recomputed with the fresh
 * headRefName/body this one call has (AC2/AC3), checkedAt bumped so its TTL restarts */
export function applyView(pr: PrRecord, viewed: Viewed, ctx: RoleCtx, now: number): PrRecord {
  const next: PrRecord = {
    ...pr,
    title: viewed.title,
    state: viewed.state,
    isDraft: viewed.isDraft,
    reviewDecision: viewed.reviewDecision,
    mergeStateStatus: viewed.mergeStateStatus,
    checks: viewed.checks,
    updatedAt: viewed.updatedAt,
    checkedAt: now,
    error: undefined,
  }
  return { ...next, role: role({ ...next, headRefName: viewed.headRefName, body: viewed.body }, ctx) }
}

/** a failed `gh pr view`: the record keeps its last-known fields (AC6), only `error` changes; `checkedAt`
 * is left alone so the next call's budget finds it due again right away rather than waiting out its TTL */
export const applyViewError = (pr: PrRecord, err: string): PrRecord => ({ ...pr, error: ghError(err) })

/** up to `limit` of `items` run through `fn` at once; order of starts is `items`' own */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export type RunMeta = {
  id: string
  bead?: string
  /** when the run started (the id's own base36 timestamp) */
  startAt: number
  ended: boolean
  /** cwd for every `gh` call about this run's own rig */
  repoDir: string
  /** owner/name of the run's own rig repo */
  runRepo: string
  /** the rig repo's GitHub owner, for `gh search prs --owner` */
  owner: string
  log: Entry[]
  mail: { from: string; to: string; text: string; at: number }[]
  /** runs/<id>/prs.json as last written, or `{ version: 1, prs: [] }` for a run that never had one */
  file: PrsFile
}

export type BuildResult = {
  /** every run's updated record, to write back to its own runs/<id>/prs.json */
  files: Map<string, PrsFile>
  /** AC1's rows: `error` is a run-wide gh failure (its branch listing or search), not any one PR's own */
  rows: { run: string; prs: PrRecord[]; error?: string }[]
}

const VIEW_TIMEOUT_MS = 30_000

/**
 * one `factory prs` invocation's worth of work: folds every run's mentions and its rig's branch listing in
 * (no budget, both are cheap and already-fetched-once-per-rig), then spends the call's search and view
 * budget (AC7) on what `due()` says is most stale, live runs first. `gh` is `spawnGh` in production, a
 * fake in tests.
 */
export async function buildPrs(
  runs: RunMeta[],
  isStation: (id: string) => boolean,
  gh: Gh,
  now: number,
  budget: Budget = DEFAULT_BUDGET,
): Promise<BuildResult> {
  const files = new Map(runs.map(r => [r.id, r.file]))
  const ctxOf = (r: RunMeta): RoleCtx => ({ runId: r.id, runRepo: r.runRepo, bead: r.bead })

  // AC2a/b, always: every run's own mentions, folded in
  for (const r of runs) {
    const hits = collectMentions(r.log, r.mail, isStation, prsIn)
    const folded = foldMentions(files.get(r.id)!.prs, hits)
    files.set(r.id, { ...files.get(r.id)!, prs: folded.map(p => ({ ...p, role: role(p, ctxOf(r)) })) })
  }

  // AC2d, always, one `gh pr list` per distinct repo: every run's own branch PRs, corroborated
  const repos = [...new Map(runs.map(r => [r.repoDir, r])).values()]
  const runErrors = new Map<string, string>()
  for (const rep of repos) {
    const res = await gh(['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'url,headRefName'], {
      cwd: rep.repoDir,
      timeout: VIEW_TIMEOUT_MS,
    })
    const sameRepo = runs.filter(x => x.repoDir === rep.repoDir)
    if (res.code !== 0) {
      for (const r of sameRepo) runErrors.set(r.id, ghError(res.err))
      continue
    }
    const list = parseBranchList(res.out)
    for (const r of sameRepo) {
      const found = branchFound(list, r.id, now)
      if (!found.length) continue
      const folded = foldFound(files.get(r.id)!.prs, found)
      files.set(r.id, { ...files.get(r.id)!, prs: folded.map(p => ({ ...p, role: role(p, ctxOf(r)) })) })
    }
  }

  // AC7's budget: which runs get another search, which (run, url) pairs get another view
  const runInfos: RunInfo[] = runs.map(r => ({ run: r.id, ended: r.ended, bead: r.bead, at: r.startAt }))
  const prsByRun = new Map(runs.map(r => [r.id, files.get(r.id)!.prs]))
  const searchState = new Map(runs.map(r => [r.id, { searchedAt: r.file.searchedAt, searchedFinal: r.file.searchedFinal }]))
  const { searches, views } = due(runInfos, prsByRun, searchState, now, budget)

  for (const runId of searches) {
    const r = runs.find(x => x.id === runId)!
    const res = await gh(['search', 'prs', '--owner', r.owner, '--json', 'url,createdAt', '--', `"${r.bead}"`], {
      cwd: r.repoDir,
      timeout: VIEW_TIMEOUT_MS,
    })
    const cur = files.get(runId)!
    if (res.code !== 0) {
      runErrors.set(runId, ghError(res.err))
      files.set(runId, { ...cur, searchedAt: now, searchedFinal: r.ended || cur.searchedFinal })
      continue
    }
    const found = parseSearch(res.out, r.startAt, now)
    const folded = foldFound(cur.prs, found)
    files.set(runId, {
      ...cur,
      prs: folded.map(p => ({ ...p, role: role(p, ctxOf(r)) })),
      searchedAt: now,
      searchedFinal: r.ended || cur.searchedFinal,
    })
  }

  await pool(views, 6, async ({ run: runId, url }) => {
    const r = runs.find(x => x.id === runId)!
    const res = await gh(['pr', 'view', url, '--json', 'title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt,headRefName,body'], {
      cwd: r.repoDir,
      timeout: VIEW_TIMEOUT_MS,
    })
    const cur = files.get(runId)!
    const viewed = res.code === 0 ? parseView(res.out) : null
    const prs = cur.prs.map(p => {
      if (p.url !== url) return p
      if (viewed) return applyView(p, viewed, ctxOf(r), now)
      return applyViewError(p, res.code === 0 ? 'gh pr view: unparseable JSON' : res.err)
    })
    files.set(runId, { ...cur, prs })
  })

  const rows = runs.map(r => ({ run: r.id, prs: files.get(r.id)!.prs, error: runErrors.get(r.id) }))
  return { files, rows }
}
