// Per-run pull request records: every PR a run touches, not just open ones on its own branch in its own
// repo. Pure matching/merge/role/budget logic lives here, read-only against a run's log and inbox; the IO
// half (`buildPrs`) calls `gh` (or `glab`, for a GitLab rig's merge requests) through injected functions, so
// tests never shell out for real.
import { mrsIn, prsIn, type Entry } from './machine'
import { ghNotes, isPerson, type Note, type WatchedPr } from './watch'
export { mrsIn }

export type PrSource = 'report' | 'mail' | 'search' | 'branch'
export type PrRole = 'code' | 'companion' | 'deploy' | 'mentioned'
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'

/** which forge a rig's repo lives on, told apart by its origin remote's host */
export type ForgeKind = 'github' | 'gitlab'

export type Checks = { pass: number; fail: number; pending: number }

export type PrRecord = {
  url: string
  /** owner/name */
  repo: string
  number: number
  title: string
  /** 'gitlab' on a merge request; absent on a GitHub PR, so every older record reads as GitHub */
  forge?: 'gitlab'
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
  /** whether the last `gh pr view` saw this PR's head as the run's own branch (wyc.4: a fact `role`
   * needs on every recompute, not only the call that just viewed it) */
  ownHead: boolean
  /** whether the last `gh pr view`'s title or body named the run's bead; stored for the same reason */
  namesIt: boolean
  /** consecutive failed `gh pr view` calls, backing off `needsView` (wyc.10) so one broken PR cannot
   * keep starving the view budget every call ahead of PRs that would otherwise be due */
  errorStreak: number
  /** when the current error streak started, 0 while errorStreak is 0 */
  erroredAt: number
  error?: string
}

export type PrsFile = {
  version: 1
  /** when this run's bead was last searched for, so a live run is re-searched every 10 min */
  searchedAt?: number
  /** an ended run gets one search after it ends, then never again; only a *successful* search (or the
   * no-GitHub-owner case) may set this (wyc.11) — a failed search must not spend the run's one shot */
  searchedFinal?: boolean
  /** consecutive failed `gh search prs` calls, backing off `needsSearch` the same way `errorStreak` backs
   * off `needsView` (wyc.11), so a rate limit or blip doesn't retry every call ahead of the budget */
  searchErrorStreak?: number
  /** when the current search error streak started, 0/unset while searchErrorStreak is 0 */
  searchErroredAt?: number
  prs: PrRecord[]
}

/** whether two runs/<id>/prs.json contents are the same, so cli.ts only writes (and fsyncs) a file that
 * actually changed (wyc.7): `buildPrs` always builds a fresh object/array for every run on every call,
 * even when nothing about it changed, so a reference check would never skip a write */
export function sameFile(a: PrsFile, b: PrsFile): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `runs/<id>/prs.json` parsed as JSON may still not be a `PrsFile` (an old shape, `{"version":1}` with no
 * `prs` array, or any other garbage that happens to parse): `foldMentions` and friends assume `prs` is an
 * array and throw a bare TypeError otherwise, which (unlike a JSON.parse failure) is not caught by cli.ts's
 * own per-run try/catch, so it would fail every run's PRs, not just this one's (wyc.12). Normalize here,
 * at the one place a file is read, to an empty file instead. */
export function asPrsFile(parsed: unknown): PrsFile {
  const p = parsed as Partial<PrsFile> | null | undefined
  return p && typeof p === 'object' && Array.isArray(p.prs) ? (p as PrsFile) : { version: 1, prs: [] }
}

/** owner/name and number out of a github.com pull request URL, or out of a GitLab merge request URL
 * (`https://<host>/<group>/<sub>/<project>/-/merge_requests/<n>`: repo keeps the full project path, and
 * forge says so); null for anything else */
export function prRef(url: string): { repo: string; number: number; forge?: 'gitlab' } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url)
  if (m) return { repo: m[1]!, number: Number(m[2]) }
  const g =
    /^https:\/\/(?!github\.com\/)[\w.-]+(?::\d+)?\/((?:[\w.-]+\/)+[\w.-]+)\/-\/merge_requests\/(\d+)$/.exec(
      url,
    )
  return g ? { repo: g[1]!, number: Number(g[2]), forge: 'gitlab' } : null
}

/** host and project path out of a remote URL (https, ssh:// or scp-style), or null */
export function parseRemote(url: string): { host: string; path: string } | null {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/]+@)?([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url)
  return m ? { host: m[1]!.toLowerCase(), path: m[2]! } : null
}

/** the forge behind a remote host: github.com is GitHub; a host named "gitlab", or one `glab` knows (a
 * self-hosted GitLab under another name), is GitLab; anything else is neither */
export function forgeOf(host: string, glabKnows: (host: string) => boolean = () => false): ForgeKind | null {
  if (host === 'github.com') return 'github'
  return host.includes('gitlab') || glabKnows(host) ? 'gitlab' : null
}

/** Escape an id's regex-special characters. `namesBead` and `citesBead` share this. */
const escapeBead = (bead: string) => bead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Check if text names this bead or a dotted descendant of it.
 * "proj-1.2" matches "proj-1.2:" and "proj-1.2.5".
 * It does not match a longer sibling id with the same prefix ("proj-1.20").
 * It does not match a shorter ancestor ("proj-1" alone never matches "proj-1.2").
 */
export function namesBead(bead: string, text: string): boolean {
  const esc = escapeBead(bead)
  return new RegExp(`(?<![\\w.-])${esc}(?:\\.\\d+)*(?![\\w-]|\\.\\w)`).test(text)
}

/**
 * Check if text names exactly this id.
 * "proj-1.2" does not match:
 * - "proj-1.2.5", a dotted descendant
 * - "proj-1.20", a longer sibling with the same prefix
 * - "proj-1" alone, a shorter ancestor
 * `alreadyDone` uses this check. A merged PR must never count for a bead when its title names only
 * that bead's ancestor or descendant.
 */
export function citesBead(id: string, text: string): boolean {
  const esc = escapeBead(id)
  return new RegExp(`(?<![\\w.-])${esc}(?![\\w-]|\\.\\w)`).test(text)
}

/**
 * claude-factory-jxl.1: PR titles often cite a child bead without its rig prefix ("192.6", "81tz.2").
 * Return that short form for a dotted child id, or null. A bare id such as "acme-wmsr" or a tiny one
 * such as "acme-1.2" gives null, as those words and numbers occur in unrelated titles.
 */
export function shortBeadId(id: string): string | null {
  const short = id.slice(id.lastIndexOf('-') + 1)
  return id.includes('-') && /^[a-z0-9]{3,}(\.\d+)+$/i.test(short) ? short : null
}

/** a merged PR, as `parseMergedPrs` reads it off `gh pr list --json number,url,title,headRefName,mergeCommit` */
export type MergedPr = {
  number: number
  url: string
  title: string
  headRefName: string
  /** `mergeCommit.oid`, flattened to a bare sha */
  mergeCommit: string
  state: PrState
}

/** claude-factory-6as: evidence a bead's work already shipped, for dispatch's pre-check */
export type AlreadyDoneHit = {
  kind: 'merged-pr'
  pr: { number: number; url: string; title: string; mergeCommit: string }
}

/**
 * claude-factory-6as: a merged PR can show that `id` is done. If it does, dispatch must not start
 * a run for `id`.
 *
 * A match needs a MERGED PR and one of these:
 * - Its title cites `id` exactly, not a dotted descendant, a longer sibling, or a shorter ancestor
 *   (see `citesBead`).
 * - Its head branch is one of `runBranches`, so a local run claimed this bead under `factory/<runId>`.
 * - Its title cites one of `childIds`, and `allChildrenClosed` is true, so a child's PR closed the
 *   last task of the parent.
 *
 * Body text never counts. The title holds only the author's own words.
 * A person writes it by hand, or a worker writes it after it reads the bead.
 *
 * A PR body often names a sibling bead that stays open. The body of PR #57 names claude-factory-5nb.
 * If body text counted, every bead that a PR body mentions would match by mistake.
 */
export function alreadyDone(
  id: string,
  prs: MergedPr[],
  ctx: { childIds: string[]; allChildrenClosed: boolean; runBranches: string[] },
): AlreadyDoneHit | null {
  const short = shortBeadId(id)
  for (const pr of prs) {
    if (pr.state !== 'MERGED') continue
    const citesChild =
      ctx.childIds.length > 0 && ctx.allChildrenClosed && ctx.childIds.some(c => citesBead(c, pr.title))
    if (
      citesBead(id, pr.title) ||
      (short !== null && citesBead(short, pr.title)) ||
      ctx.runBranches.includes(pr.headRefName) ||
      citesChild
    )
      return {
        kind: 'merged-pr',
        pr: { number: pr.number, url: pr.url, title: pr.title, mergeCommit: pr.mergeCommit },
      }
  }
  return null
}

/** `gh pr list --json number,url,title,headRefName,mergeCommit` parsed, flattening `mergeCommit.oid` to a
 * bare sha; every row already satisfies `--state merged`, but a row here is still tagged MERGED so
 * `alreadyDone` need not trust its caller. Garbage input is an empty list, never a throw. */
export function parseMergedPrs(out: string): MergedPr[] {
  let v: unknown
  try {
    v = JSON.parse(out)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  return (v as Record<string, unknown>[])
    .map(p => ({
      number: typeof p.number === 'number' ? p.number : 0,
      url: typeof p.url === 'string' ? p.url : '',
      title: typeof p.title === 'string' ? p.title : '',
      headRefName: typeof p.headRefName === 'string' ? p.headRefName : '',
      mergeCommit:
        typeof (p.mergeCommit as Record<string, unknown> | undefined)?.oid === 'string'
          ? ((p.mergeCommit as Record<string, unknown>).oid as string)
          : '',
      state: 'MERGED' as PrState,
    }))
    .filter(p => p.url)
}

/** the one-line bd comment an `alreadyDone` hit leaves on a bead: the PR, its merge sha, its title
 * clipped to 120 chars, and how a person undoes the skip. Never a shell quote: bd takes this as one
 * plain argv string. */
export function evidenceLine(
  pr: { number: number; url: string; title: string; mergeCommit: string },
  rig: string,
  id: string,
): string {
  const title = pr.title.length > 120 ? pr.title.slice(0, 120) : pr.title
  return `already done: ${pr.url} (#${pr.number}, merged ${pr.mergeCommit}) "${title}". Requeue: factory queue ${rig} ${id}`
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

const blank = (
  url: string,
  number: number,
  repo: string,
  station: string,
  at: number,
  source: PrSource,
  forge?: 'gitlab',
): PrRecord => ({
  url,
  repo,
  number,
  title: '',
  ...(forge ? { forge } : {}),
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
  ownHead: false,
  namesIt: false,
  errorStreak: 0,
  erroredAt: 0,
})

/** folds mentions into an existing record list: a new URL gets a blank row at its first sighting; an
 * already-known URL keeps its first-seen station, source and time (AC2's "first-seen ... kept") */
export function foldMentions(existing: PrRecord[], hits: Mention[]): PrRecord[] {
  const byUrl = new Map(existing.map(r => [r.url, r]))
  for (const h of [...hits].sort((a, b) => a.at - b.at)) {
    if (byUrl.has(h.url)) continue
    const ref = prRef(h.url)
    if (!ref) continue
    byUrl.set(h.url, blank(h.url, ref.number, ref.repo, h.station, h.at, h.source, ref.forge))
  }
  return [...byUrl.values()]
}

/** a PR turned up independently by `gh search prs` or the rig's branch listing: corroborating evidence it
 * is really the run's, kept even when the record already exists from a mention alone */
export type Found = { url: string; at: number; source: 'search' | 'branch' }

/** AC2c, both bounds: a search hit counts only when created at or after the run's start minus 10 min and
 * at or before it ended (a live run's `runEndAt` is Infinity) plus 10 min. The lower bound drops a
 * pre-existing PR the text search merely resembles (an earlier sibling's release PR); the upper bound
 * drops a later run's own PR for the same bead (wyc.5: without it, an ended run's final search claims
 * every later run's PR as its own, since that search never runs again to notice the run has moved on) */
export function keepSearchHit(createdAt: string, runStartAt: number, runEndAt: number): boolean {
  const t = Date.parse(createdAt)
  return t >= runStartAt - 10 * 60_000 && t <= runEndAt + 10 * 60_000
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
    byUrl.set(f.url, {
      ...blank(f.url, ref.number, ref.repo, '', f.at, f.source, ref.forge),
      corroborated: true,
    })
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

/** what role() needs about a PR beyond what the stored record gives: when `headRefName`/`body` are given
 * (only right after a fresh `gh pr view`), ownHead/namesIt are computed from them; otherwise (every other
 * recompute: AC2a's mention fold, AC2d's branch fold, AC2c's search fold, all of which run on every call
 * whether or not they found anything new) the stored `ownHead`/`namesIt` facts are used instead, so a PR
 * whose bead-naming body or own-branch head was only ever seen on one `gh pr view` keeps its role on every
 * later call (wyc.4) rather than losing it the moment nothing fresh is in hand */
export type RoleInput = Pick<PrRecord, 'repo' | 'title' | 'station' | 'corroborated'> & {
  headRefName?: string
  body?: string
  ownHead?: boolean
  namesIt?: boolean
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
  const ownHead = pr.headRefName !== undefined ? pr.headRefName === `factory/${ctx.runId}` : !!pr.ownHead
  const sameRepo = pr.repo === ctx.runRepo
  const namesIt =
    pr.body !== undefined ? (ctx.bead ? namesBead(ctx.bead, `${pr.title}\n${pr.body}`) : false) : !!pr.namesIt
  const isOurs = ownHead || namesIt || pr.corroborated
  if (!isOurs) return 'mentioned'
  if (sameRepo) return 'code'
  if (namesIt) return 'companion'
  if (pr.station === 'deploy' || pr.station === 'rollback') return 'deploy'
  return 'companion'
}

const TTL_MS: Record<PrState, number> = {
  OPEN: 2 * 60_000,
  CLOSED: 30 * 60_000,
  MERGED: Infinity,
  UNKNOWN: 0,
}

const MAX_BACKOFF_MS = 30 * 60_000

/** how long a PR with `streak` consecutive failed views must wait past its last error before another is
 * due: 1 min, 2, 4, 8... capped at 30 min, so one broken PR cannot keep retrying ahead of others every
 * single call and starve the view budget (wyc.10) */
export function viewBackoff(streak: number): number {
  return streak <= 0 ? 0 : Math.min(2 ** (streak - 1) * 60_000, MAX_BACKOFF_MS)
}

/** whether a record is stale enough to spend a `gh pr view` on: a MERGED PR never needs one again; a PR
 * on an error streak additionally waits out its backoff, on top of its state's own TTL */
export function needsView(
  pr: Pick<PrRecord, 'state' | 'checkedAt'> & Partial<Pick<PrRecord, 'errorStreak' | 'erroredAt'>>,
  now: number,
): boolean {
  if (pr.state === 'MERGED') return false
  if (now - pr.checkedAt < TTL_MS[pr.state]) return false
  const streak = pr.errorStreak ?? 0
  if (streak > 0) return now - (pr.erroredAt ?? 0) >= viewBackoff(streak)
  return true
}

export type RunInfo = { run: string; ended: boolean; bead?: string; at: number }
export type SearchState = {
  searchedAt?: number
  searchedFinal?: boolean
  searchErrorStreak?: number
  searchErroredAt?: number
}
const LIVE_SEARCH_MS = 10 * 60_000

/** whether a run's bead is due another `gh search prs`: never without a bead; once more after a run ends
 * (unless that search is still backing off a prior failure, wyc.11), then never; a live run, every 10 min
 * (a live run's own 10-min gate already paces retries after a failure, so it gets no separate backoff) */
export function needsSearch(run: Pick<RunInfo, 'ended' | 'bead'>, file: SearchState, now: number): boolean {
  if (!run.bead) return false
  if (run.ended) {
    if (file.searchedFinal) return false
    const streak = file.searchErrorStreak ?? 0
    if (streak > 0) return now - (file.searchErroredAt ?? 0) >= viewBackoff(streak)
    return true
  }
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
export const spawnGh: Gh = (argv, opts) => spawnCli('gh', argv, opts)
/** the real `glab`; it answers in the same shape, so it is typed `Gh` too */
export const spawnGlab: Gh = (argv, opts) => spawnCli('glab', argv, opts)

async function spawnCli(
  bin: string,
  argv: string[],
  opts: { cwd: string; timeout: number },
): Promise<GhResult> {
  const proc = Bun.spawn([bin, ...argv], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
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
export function parseSearch(out: string, runStartAt: number, runEndAt: number, now: number): Found[] {
  let hits: { url: string; createdAt: string }[]
  try {
    hits = JSON.parse(out)
  } catch {
    return []
  }
  return searchFound(hits, runStartAt, runEndAt, now)
}
const searchFound = (
  hits: { url: string; createdAt: string }[],
  runStartAt: number,
  runEndAt: number,
  now: number,
): Found[] =>
  hits
    .filter(h => keepSearchHit(h.createdAt, runStartAt, runEndAt))
    .map(h => ({ url: h.url, at: now, source: 'search' as const }))

/** AC2d parsed: one `gh pr list --state all` per rig repo, independent of any run's budget */
export function parseBranchList(out: string): { url: string; headRefName: string }[] {
  try {
    return JSON.parse(out)
  } catch {
    return []
  }
}
/** which of a rig's listed PRs are a given run's own branch, as Found (corroborating, AC2d) */
export function branchFound(
  list: { url: string; headRefName: string }[],
  runId: string,
  now: number,
): Found[] {
  return list
    .filter(p => p.headRefName === `factory/${runId}`)
    .map(p => ({ url: p.url, at: now, source: 'branch' as const }))
}

/** `gh pr view <url> --json ...` parsed: headRefName and body are used only to feed `role` right here, in
 * the same call, and are never carried into the stored PrRecord (RoleInput says so) */
export type Viewed = Pick<
  PrRecord,
  'title' | 'state' | 'isDraft' | 'reviewDecision' | 'mergeStateStatus' | 'checks' | 'updatedAt'
> & {
  headRefName: string
  body: string
  /** GitLab only (claude-factory-5wav): what the park watch reads beyond the fields above */
  headSha?: string
  mergedAt?: string
  closedAt?: string
  /** GitHub REST only: what the gate and the park watch read beyond the fields above */
  baseRefName?: string
  mergeable?: string
  additions?: number
  deletions?: number
  changedFiles?: number
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
    checks: checksOf(
      Array.isArray(v.statusCheckRollup) ? (v.statusCheckRollup as { conclusion?: string | null }[]) : [],
    ),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    headRefName: typeof v.headRefName === 'string' ? v.headRefName : '',
    body: typeof v.body === 'string' ? v.body : '',
  }
}

// ---- GitLab: `glab api` answers with GitLab's REST objects; these map them onto the records above ----

type Json = Record<string, unknown>
const asJson = (out: string): unknown => {
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** the merge requests of a project listing, in `parseBranchList`'s shape */
export function parseGitlabList(out: string): { url: string; headRefName: string }[] {
  const mrs = asJson(out)
  if (!Array.isArray(mrs)) return []
  return (mrs as Json[])
    .map(m => ({ url: str(m.web_url), headRefName: str(m.source_branch) }))
    .filter(m => m.url)
}

/** a project search of a bead's merge requests, in `parseSearch`'s shape and with the same time bounds */
export function parseGitlabSearch(out: string, runStartAt: number, runEndAt: number, now: number): Found[] {
  const mrs = asJson(out)
  if (!Array.isArray(mrs)) return []
  const hits = (mrs as Json[])
    .map(m => ({ url: str(m.web_url), createdAt: str(m.created_at) }))
    .filter(m => m.url)
  return searchFound(hits, runStartAt, runEndAt, now)
}

const GITLAB_STATE: Record<string, PrState> = {
  opened: 'OPEN',
  merged: 'MERGED',
  closed: 'CLOSED',
  locked: 'CLOSED',
}
const PIPELINE: Record<string, string> = {
  success: 'SUCCESS',
  skipped: 'SKIPPED',
  failed: 'FAILURE',
  canceled: 'CANCELLED',
}

/** GitLab's detailed merge status in GitHub's vocabulary, which the console's `prNeed` reads: a failed
 * pipeline that blocks the merge is UNSTABLE, any other open rule BLOCKED */
function mergeStatusOf(mr: Json, failing: boolean): string {
  const s =
    str(mr.detailed_merge_status) ||
    (mr.merge_status === 'cannot_be_merged'
      ? 'conflict'
      : mr.merge_status === 'can_be_merged'
        ? 'mergeable'
        : '')
  if (s === 'mergeable') return 'CLEAN'
  if (s === 'conflict') return 'DIRTY'
  if (s === 'need_rebase') return 'BEHIND'
  if (s === 'ci_must_pass' && failing) return 'UNSTABLE'
  if (['', 'checking', 'unchecked', 'preparing', 'not_open'].includes(s)) return 'UNKNOWN'
  return 'BLOCKED'
}

/** a label-filtered MR listing (`GET projects/:id/merge_requests?labels=`) in the shape `gh pr list --json
 * number,url,headRefName,baseRefName,isCrossRepository,labels` gives labelPass */
export function parseGitlabLabeled(out: string) {
  const mrs = asJson(out)
  if (!Array.isArray(mrs)) return []
  return (mrs as Json[])
    .filter(m => typeof m.iid === 'number' && str(m.web_url))
    .map(m => ({
      number: m.iid as number,
      url: str(m.web_url),
      headRefName: str(m.source_branch),
      baseRefName: str(m.target_branch),
      isCrossRepository: m.source_project_id !== m.target_project_id,
      labels: (Array.isArray(m.labels) ? (m.labels as unknown[]).map(str) : []).map(name => ({ name })),
    }))
}

/** the brief lines for a worker on a GitLab rig, whose station prompts say `gh pr`; none for any other forge */
export const forgeNote = (gitlabHost?: string): string[] =>
  gitlabHost
    ? [
        '',
        '## Forge',
        `This repo's forge is GitLab at ${gitlabHost}. Where your instructions say \`gh pr <x>\` or "pull request", use \`glab\` on merge requests (\`gh\` does not work here):`,
        '- gh pr create -> glab mr create',
        '- gh pr view <n> --comments -> glab mr view <n> --comments',
        '- gh pr comment -> glab mr note <n> -m "<text>"',
        '- gh pr review --comment -> glab mr note <n> -m "<text>"; --approve -> glab mr approve <n>',
        '- gh pr checks -> glab ci status',
        '- gh api repos/... -> glab api projects/:id/...',
      ]
    : []

/** an MR (`GET projects/:id/merge_requests/:iid`) and its approvals (`.../approvals`, optional: a failed
 * or missing answer leaves the review decision blank rather than failing the view) mapped onto `Viewed` */
export function parseGitlabView(mrOut: string, approvalsOut = ''): Viewed | null {
  const mr = asJson(mrOut) as Json | null
  if (!mr || typeof mr !== 'object' || Array.isArray(mr)) return null
  const pipeline = (mr.head_pipeline ?? mr.pipeline) as Json | null | undefined
  const status = str(pipeline?.status)
  const checks = pipeline
    ? checksOf([{ conclusion: PIPELINE[status] ?? null }])
    : { pass: 0, fail: 0, pending: 0 }
  const approvals = asJson(approvalsOut) as Json | null
  let reviewDecision = ''
  if (mr.detailed_merge_status === 'requested_changes') reviewDecision = 'CHANGES_REQUESTED'
  else if (approvals?.approved === true) reviewDecision = 'APPROVED'
  else if (typeof approvals?.approvals_left === 'number' && approvals.approvals_left > 0)
    reviewDecision = 'REVIEW_REQUIRED'
  return {
    title: str(mr.title),
    state: GITLAB_STATE[str(mr.state)] ?? 'UNKNOWN',
    isDraft: !!(mr.draft ?? mr.work_in_progress),
    reviewDecision,
    mergeStateStatus: mergeStatusOf(mr, checks.fail > 0),
    checks,
    updatedAt: str(mr.updated_at),
    headRefName: str(mr.source_branch),
    body: str(mr.description),
    headSha: str(mr.sha) || undefined,
    mergedAt: str(mr.merged_at) || undefined,
    closedAt: str(mr.closed_at) || undefined,
  }
}

/** the human notes of an MR (`.../notes`): a system note (a push, a label) and a bot's note are not a person's,
 * and neither is a note by a user who is not a member of the project: on a public project anyone can comment.
 * `members` holds the ids of the users with project access of Developer or above (`gitlabWatchNotes`). */
export function gitlabNotes(out: string, members: Set<number> = new Set()): Note[] {
  const list = asJson(out)
  if (!Array.isArray(list)) return []
  const notes: Note[] = []
  for (const n of list as Json[]) {
    const at = Date.parse(str(n?.created_at))
    if (!n || Number.isNaN(at)) continue
    const author = n.author as Json | undefined
    const id = typeof author?.id === 'number' ? author.id : -1
    notes.push({
      at,
      person:
        n.system !== true &&
        isPerson(str(author?.username), members.has(id) ? 'MEMBER' : 'NONE', author?.bot === true),
      changesRequested: false,
      body: str(n.body),
    })
  }
  return notes
}

/** true when the URL is on the rig's forge host. A `glab api --hostname` call sends GITLAB_TOKEN to that host, so
 * the sinks refuse any other host. Only the hostname counts: a port is dropped on both sides. */
export const onHost = (url: string, host?: string): boolean => {
  try {
    return !!host && new URL(url).hostname.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** the person notes of a merge request for the park watch, or null when glab could not say. The author of each
 * human note is checked against the project members (`members/all/:id`, access level 30 or above). A 404 means
 * not a member. Any other failure fails the whole call, so the watch never trusts a note it could not check. */
export async function gitlabWatchNotes(
  glab: Gh,
  url: string,
  cwd: string,
  host?: string,
): Promise<Note[] | null> {
  const ref = prRef(url)
  if (!ref || !host || !onHost(url, host)) return null
  const base = `projects/${encodeURIComponent(ref.repo)}`
  const api = (path: string) => glab(['api', '--hostname', host, path], timed(cwd))
  const res = await api(`${base}/merge_requests/${ref.number}/notes?sort=desc&per_page=50`)
  if (res.code !== 0) return null
  const list = asJson(res.out)
  if (!Array.isArray(list)) return null
  const ids = new Set<number>()
  for (const n of list as Json[]) {
    const a = n?.author as Json | undefined
    if (n?.system !== true && a?.bot !== true && typeof a?.id === 'number') ids.add(a.id)
  }
  const members = new Set<number>()
  for (const id of ids) {
    const m = await api(`${base}/members/all/${id}`)
    if (m.code === 0) {
      const level = (asJson(m.out) as Json | null)?.access_level
      if (typeof level === 'number' && level >= 30) members.add(id)
    } else if (!/404/.test(m.err)) return null
  }
  return gitlabNotes(res.out, members)
}

// ---- GitHub: `gh api repos/<owner>/<repo>/...` answers with REST objects ----
// The AX gateway picks the key from the owner in the path. `gh pr` sends POST /graphql, which has no owner.
// So the factory reads and writes PRs through REST only.

/** owner/repo of a github.com pull request URL. Null for any other URL.
 * Null also for a `.` or `..` segment: it can move an API path out of `repos/<owner>/`. */
export function githubSlugOf(url: string): string | null {
  const ref = prRef(url)
  if (!ref || ref.forge) return null
  return ref.repo.split('/').some(s => s === '.' || s === '..') ? null : ref.repo
}

/** the review decision REST can show: only reviews of a member-class author count, the latest review of each
 * user wins, and REVIEW_REQUIRED does not exist here (it comes from branch protection) */
export function reviewDecisionOf(reviews: unknown): string {
  if (!Array.isArray(reviews)) return ''
  const latest = new Map<string, string>()
  for (const r of reviews as Json[]) {
    const user = str((r?.user as Json | undefined)?.login)
    const state = str(r?.state)
    if (!user || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(str(r?.author_association))) continue
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) latest.set(user, state)
  }
  const states = [...latest.values()]
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  return states.includes('APPROVED') ? 'APPROVED' : ''
}

const MERGEABLE: Record<string, string> = { true: 'MERGEABLE', false: 'CONFLICTING' }
const STATUS_CONCLUSION: Record<string, string> = { success: 'SUCCESS', failure: 'FAILURE', error: 'FAILURE' }

/** a pull (`pulls/N`), its reviews, its head's check runs and its combined status mapped onto `Viewed`.
 * A missing reviews, checks or status answer leaves that field blank. */
export function parseGithubView(
  pullOut: string,
  reviewsOut = '',
  checkRunsOut = '',
  statusOut = '',
): Viewed | null {
  const p = asJson(pullOut) as Json | null
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const runs = (asJson(checkRunsOut) as Json | null)?.check_runs
  const statuses = (asJson(statusOut) as Json | null)?.statuses
  const rollup = [
    ...(Array.isArray(runs) ? (runs as Json[]) : []).map(c => ({
      conclusion: str(c?.status) === 'completed' ? str(c?.conclusion) : null,
    })),
    ...(Array.isArray(statuses) ? (statuses as Json[]) : []).map(s => ({
      conclusion: STATUS_CONCLUSION[str(s?.state)] ?? null,
    })),
  ]
  const head = p.head as Json | undefined
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  return {
    title: str(p.title),
    state: (str(p.merged_at) ? 'MERGED' : str(p.state).toUpperCase() || 'UNKNOWN') as PrState,
    isDraft: p.draft === true,
    reviewDecision: reviewDecisionOf(asJson(reviewsOut)),
    mergeStateStatus: str(p.mergeable_state).toUpperCase() || 'UNKNOWN',
    checks: checksOf(rollup),
    updatedAt: str(p.updated_at),
    headRefName: str(head?.ref),
    body: str(p.body),
    headSha: str(head?.sha) || undefined,
    mergedAt: str(p.merged_at) || undefined,
    closedAt: str(p.closed_at) || undefined,
    baseRefName: str((p.base as Json | undefined)?.ref) || undefined,
    mergeable: MERGEABLE[String(p.mergeable)] ?? 'UNKNOWN',
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changed_files),
  }
}

/** the notes of REST reviews and issue comments, through the same reader as `gh pr view` notes (`ghNotes`) */
export function restNotes(reviews: unknown, comments: unknown): Note[] {
  const raw = (list: unknown, at: 'submittedAt' | 'createdAt') =>
    (Array.isArray(list) ? (list as Json[]) : []).map(r => {
      const u = r?.user as Json | undefined
      return {
        author: { login: str(u?.login), is_bot: u?.type === 'Bot' },
        authorAssociation: str(r?.author_association),
        [at]: str(r?.[at === 'submittedAt' ? 'submitted_at' : 'created_at']),
        state: str(r?.state),
        body: str(r?.body),
      }
    })
  return ghNotes({ reviews: raw(reviews, 'submittedAt'), comments: raw(comments, 'createdAt') })
}

/** `pulls` rows mapped onto `gh pr list --json` fields */
export function githubRows(pulls: unknown): Json[] {
  if (!Array.isArray(pulls)) return []
  return (pulls as Json[]).map(p => {
    const head = p.head as Json | undefined
    const base = p.base as Json | undefined
    const mergedAt = str(p.merged_at)
    const headRepo = head?.repo as Json | null | undefined
    return {
      number: p.number,
      url: str(p.html_url),
      title: str(p.title),
      body: str(p.body),
      state: mergedAt ? 'MERGED' : str(p.state).toUpperCase(),
      isDraft: p.draft === true,
      headRefName: str(head?.ref),
      baseRefName: str(base?.ref),
      isCrossRepository:
        !headRepo || str(headRepo.full_name) !== str((base?.repo as Json | undefined)?.full_name),
      ...(mergedAt ? { mergeCommit: { oid: str(p.merge_commit_sha) } } : {}),
      labels: (Array.isArray(p.labels) ? (p.labels as Json[]) : []).map(l => ({ name: str(l?.name) })),
    }
  })
}

/** `GET repos/<slug>/pulls` pages, newest first, until a short page; null when a call fails */
export async function githubPulls(
  gh: Gh,
  slug: string,
  cwd: string,
  o: { state: 'open' | 'closed' | 'all'; pages: number; head?: string },
): Promise<Json[] | null> {
  const rows: Json[] = []
  for (let page = 1; page <= o.pages; page++) {
    const q = `state=${o.state}&sort=created&direction=desc&per_page=100&page=${page}`
    const res = await gh(
      ['api', `repos/${slug}/pulls?${q}${o.head ? `&head=${encodeURIComponent(o.head)}` : ''}`],
      timed(cwd),
    )
    const list = res.code === 0 ? asJson(res.out) : null
    if (!Array.isArray(list)) return null
    rows.push(...(list as Json[]))
    if (list.length < 100) break
  }
  return rows
}

/** the PR for the park watch: the pull, then its reviews and issue comments, all pages.
 * Null when any call fails, so the watch never routes on a half view. */
export async function githubWatchView(gh: Gh, url: string, cwd: string): Promise<WatchedPr | null> {
  const slug = githubSlugOf(url)
  if (!slug) return null
  const path = `repos/${slug}/pulls/${prRef(url)!.number}`
  const pages = async (p: string): Promise<unknown[] | null> => {
    const res = await gh(['api', '--paginate', '--slurp', p], { cwd, timeout: 60_000 })
    const list = res.code === 0 ? asJson(res.out) : null
    return Array.isArray(list) ? list.flat() : null
  }
  const [pull, reviews, comments] = await Promise.all([
    gh(['api', path], { cwd, timeout: 60_000 }),
    pages(`${path}/reviews?per_page=100`),
    pages(`repos/${slug}/issues/${prRef(url)!.number}/comments?per_page=100`),
  ])
  const v = pull.code === 0 && reviews && comments ? parseGithubView(pull.out) : null
  if (!v) return null
  return {
    url,
    state: v.state,
    isDraft: v.isDraft,
    reviewDecision: reviewDecisionOf(reviews),
    updatedAt: v.updatedAt,
    headRefOid: v.headSha,
    mergedAt: v.mergedAt,
    closedAt: v.closedAt,
    notes: restNotes(reviews, comments),
    mergeable: v.mergeable,
    headRefName: v.headRefName || undefined,
    baseRefName: v.baseRefName,
  }
}

/** a viewed PR folded into its record: every gh-sourced field refreshed, role recomputed with the fresh
 * headRefName/body this one call has (AC2/AC3) and its ownHead/namesIt facts stored for every later
 * recompute (wyc.4), checkedAt bumped so its TTL restarts, and the error streak cleared on success */
export function applyView(pr: PrRecord, viewed: Viewed, ctx: RoleCtx, now: number): PrRecord {
  const ownHead = viewed.headRefName === `factory/${ctx.runId}`
  const namesIt = ctx.bead ? namesBead(ctx.bead, `${viewed.title}\n${viewed.body}`) : false
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
    ownHead,
    namesIt,
    errorStreak: 0,
    erroredAt: 0,
    error: undefined,
  }
  return { ...next, role: role(next, ctx) }
}

/** a failed `gh pr view`: the record keeps its last-known fields (AC6), only `error` and the backoff
 * streak change; `checkedAt` is left alone (the state's own TTL does not apply to a failed view), but a
 * repeat failure now waits out `viewBackoff` before it is due again, so it stops starving the budget
 * (wyc.10) */
export const applyViewError = (pr: PrRecord, err: string, now: number): PrRecord => ({
  ...pr,
  error: ghError(err),
  errorStreak: pr.errorStreak + 1,
  erroredAt: now,
})

/** up to `limit` of `items` run through `fn` at once, in `items`' own start order; `stop()` is checked
 * before every new start so a caller can cut the pool short (wyc.7's overall deadline) without aborting
 * whatever is already in flight */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  stop: () => boolean = () => false,
): Promise<void> {
  let next = 0
  async function worker() {
    for (;;) {
      if (stop()) return
      const i = next++
      if (i >= items.length) return
      await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export type RunMeta = {
  id: string
  bead?: string
  /** when the run started (the id's own base36 timestamp) */
  startAt: number
  ended: boolean
  /** when the run ended (its last log entry), Infinity for a live run (wyc.5's upper search bound) */
  endAt: number
  /** cwd for every `gh` call about this run's own rig */
  repoDir: string
  /** owner/name of the run's own rig repo */
  runRepo: string
  /** the rig repo's GitHub owner, for `gh search prs --owner`; '' when the repo has no GitHub origin
   * (on GitLab, its namespace: only a gate here, the search is scoped to the project) */
  owner: string
  /** the forge the rig's origin is on, github when unset */
  forge?: ForgeKind
  /** the origin's host, for `glab api --hostname` */
  host?: string
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

/** what `buildPrs` needs from a forge: the calls that list, search and view, and how to read each answer */
export type Forge = {
  list(r: RunMeta): Promise<GhResult>
  parseList(out: string): { url: string; headRefName: string }[]
  search(r: RunMeta): Promise<GhResult>
  parseSearch(out: string, startAt: number, endAt: number, now: number): Found[]
  view(url: string, cwd: string, host?: string): Promise<{ viewed: Viewed } | { err: string }>
}

const timed = (cwd: string) => ({ cwd, timeout: VIEW_TIMEOUT_MS })

const githubForge = (gh: Gh): Forge => ({
  async list(r) {
    const rows = await githubPulls(gh, r.runRepo, r.repoDir, { state: 'all', pages: 1 })
    return rows
      ? { code: 0, out: JSON.stringify(githubRows(rows)), err: '' }
      : { code: 1, out: '', err: 'gh api: pull list failed' }
  },
  parseList: parseBranchList,
  search: r =>
    gh(
      ['search', 'prs', '--owner', r.owner, '--json', 'url,createdAt', '--', `"${r.bead}"`],
      timed(r.repoDir),
    ),
  parseSearch,
  async view(url, cwd) {
    const slug = githubSlugOf(url)
    if (!slug) return { err: 'not a github.com pull request URL' }
    const pullPath = `repos/${slug}/pulls/${prRef(url)!.number}`
    const api = (path: string) => gh(['api', path], timed(cwd))
    const pull = await api(pullPath)
    const sha = pull.code === 0 ? str(((asJson(pull.out) as Json | null)?.head as Json | undefined)?.sha) : ''
    const hex = /^[0-9a-f]{7,64}$/i.test(sha)
    const ok = (res?: GhResult) => (res?.code === 0 ? res.out : '')
    const [reviews, runs, status] = await Promise.all([
      api(`${pullPath}/reviews?per_page=100`),
      hex ? api(`repos/${slug}/commits/${sha}/check-runs?per_page=100`) : undefined,
      hex ? api(`repos/${slug}/commits/${sha}/status`) : undefined,
    ])
    const viewed = pull.code === 0 ? parseGithubView(pull.out, ok(reviews), ok(runs), ok(status)) : null
    return viewed ? { viewed } : { err: pull.code === 0 ? 'gh api: unparseable JSON' : pull.err }
  },
})

/** `glab api` rather than `glab mr`: one REST shape for every host, and the approvals only the API has */
export const gitlabForge = (glab: Gh): Forge => {
  const api = (host: string | undefined, path: string, cwd: string) =>
    glab(['api', ...(host ? ['--hostname', host] : []), path], timed(cwd))
  const project = (path: string) => `projects/${encodeURIComponent(path)}/merge_requests`
  return {
    list: r => api(r.host, `${project(r.runRepo)}?state=all&order_by=updated_at&per_page=100`, r.repoDir),
    parseList: parseGitlabList,
    search: r =>
      api(
        r.host,
        `${project(r.runRepo)}?state=all&in=title,description&per_page=100&search=${encodeURIComponent(r.bead!)}`,
        r.repoDir,
      ),
    parseSearch: parseGitlabSearch,
    async view(url, cwd, host) {
      if (!onHost(url, host)) return { err: 'merge request is not on the rig forge host' }
      const ref = prRef(url)!
      const path = `${project(ref.repo)}/${ref.number}`
      const [mr, approvals] = await Promise.all([api(host, path, cwd), api(host, `${path}/approvals`, cwd)])
      const viewed = mr.code === 0 ? parseGitlabView(mr.out, approvals.code === 0 ? approvals.out : '') : null
      return viewed ? { viewed } : { err: mr.code === 0 ? 'glab api: unparseable JSON' : mr.err }
    },
  }
}

const DEADLINE_MS = 60_000

/**
 * one `factory prs` invocation's worth of work: folds every run's mentions and its rig's branch listing in
 * (no budget, both are cheap and already-fetched-once-per-rig), then spends the call's search and view
 * budget (AC7) on what `due()` says is most stale, live runs first. `gh` is `spawnGh` in production, a
 * fake in tests. `clock` (real time, separate from `now`'s recorded timestamps so tests stay deterministic)
 * is checked against an overall deadline (wyc.7, default 60s, well under the mod's 120s kill) before every
 * new `gh` call starts; whatever is left over is deferred to a later call, same as the search/view budget.
 */
export async function buildPrs(
  runs: RunMeta[],
  isStation: (id: string) => boolean,
  gh: Gh,
  now: number,
  budget: Budget = DEFAULT_BUDGET,
  clock: () => number = Date.now,
  deadlineMs: number = DEADLINE_MS,
  glab: Gh = spawnGlab,
): Promise<BuildResult> {
  const forges = { github: githubForge(gh), gitlab: gitlabForge(glab) }
  const forgeOfRun = (r: RunMeta) => forges[r.forge ?? 'github']
  const deadlineAt = clock() + deadlineMs
  const overDeadline = () => clock() >= deadlineAt
  const files = new Map(runs.map(r => [r.id, r.file]))
  const ctxOf = (r: RunMeta): RoleCtx => ({ runId: r.id, runRepo: r.runRepo, bead: r.bead })

  // AC2a/b, always: every run's own mentions, folded in
  for (const r of runs) {
    const hits = collectMentions(r.log, r.mail, isStation, text => [...prsIn(text), ...mrsIn(text)])
    const folded = foldMentions(files.get(r.id)!.prs, hits)
    files.set(r.id, { ...files.get(r.id)!, prs: folded.map(p => ({ ...p, role: role(p, ctxOf(r)) })) })
  }

  // AC2d, always, one `gh pr list` per distinct repo: every run's own branch PRs, corroborated
  const repos = [...new Map(runs.map(r => [r.repoDir, r])).values()]
  const runErrors = new Map<string, string>()
  for (const rep of repos) {
    if (overDeadline()) break
    const forge = forgeOfRun(rep)
    const res = await forge.list(rep)
    const sameRepo = runs.filter(x => x.repoDir === rep.repoDir)
    if (res.code !== 0) {
      for (const r of sameRepo) runErrors.set(r.id, ghError(res.err))
      continue
    }
    const list = forge.parseList(res.out)
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
  const searchState = new Map(
    runs.map(r => [
      r.id,
      {
        searchedAt: r.file.searchedAt,
        searchedFinal: r.file.searchedFinal,
        searchErrorStreak: r.file.searchErrorStreak,
        searchErroredAt: r.file.searchErroredAt,
      },
    ]),
  )
  const { searches, views } = due(runInfos, prsByRun, searchState, now, budget)

  for (const runId of searches) {
    if (overDeadline()) break
    const r = runs.find(x => x.id === runId)!
    const cur = files.get(runId)!
    if (!r.owner) {
      // wyc.8: no GitHub origin to search against; mark it searched (nothing found) rather than retry
      // `gh search prs --owner ''` every call
      files.set(runId, {
        ...cur,
        searchedAt: now,
        searchedFinal: r.ended || cur.searchedFinal,
        searchErrorStreak: 0,
        searchErroredAt: 0,
      })
      continue
    }
    const forge = forgeOfRun(r)
    const res = await forge.search(r)
    if (res.code !== 0) {
      // wyc.11: a failed search must not spend the run's one final-search shot (searchedFinal stays as
      // it was); it only bumps an error streak so `needsSearch` backs off instead of retrying every call
      runErrors.set(runId, ghError(res.err))
      files.set(runId, {
        ...cur,
        searchedAt: now,
        searchErrorStreak: (cur.searchErrorStreak ?? 0) + 1,
        searchErroredAt: now,
      })
      continue
    }
    const found = forge.parseSearch(res.out, r.startAt, r.endAt, now)
    const folded = foldFound(cur.prs, found)
    files.set(runId, {
      ...cur,
      prs: folded.map(p => ({ ...p, role: role(p, ctxOf(r)) })),
      searchedAt: now,
      searchedFinal: r.ended || cur.searchedFinal,
      searchErrorStreak: 0,
      searchErroredAt: 0,
    })
  }

  await pool(
    views,
    6,
    async ({ run: runId, url }) => {
      const r = runs.find(x => x.id === runId)!
      // the PR's own URL says which forge answers for it: a run can name a PR on a forge its rig is not on
      const forge = prRef(url)?.forge ? forges.gitlab : forges.github
      const res = await forge.view(url, r.repoDir, r.host)
      const cur = files.get(runId)!
      const prs = cur.prs.map(p => {
        if (p.url !== url) return p
        return 'viewed' in res ? applyView(p, res.viewed, ctxOf(r), now) : applyViewError(p, res.err, now)
      })
      files.set(runId, { ...cur, prs })
    },
    overDeadline,
  )

  const rows = runs.map(r => ({ run: r.id, prs: files.get(r.id)!.prs, error: runErrors.get(r.id) }))
  return { files, rows }
}
