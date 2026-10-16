// pkg-gate: an age-gating registry proxy, so no toolchain on a VM runner -- not even one a worker's own
// `nix shell nixpkgs#go -c ...` brings in, which never passes through a PATH wrapper like pkg-guard -- can
// fetch a package or module version younger than the minimum age. It is the only registry host in a gated
// task's egress (see ax.ts), so enforcement is the egress strip, not this proxy's correctness alone; still,
// every decision here fails closed: an upstream error, a timeout, or a missing or unparseable publish time
// is a refusal, never a pass-through. See claude-factory-ei0 and docs/remote-runner.md's package age gate.

export type Upstream = {
  go: string
  npm: string
  pypi: string
  files: string
  sumdb: string
  goIndex: string
}

/**
 * one list per ecosystem, never one shared list: a shared list let an entry meant for one ecosystem (say,
 * an npm package) unlock the same spelling in another (a PyPI project of the same name), a typosquat
 * surface (ei0.22).
 */
export type Allowlist = { go?: string[]; npm?: string[]; pypi?: string[] }

export type GateConfig = {
  upstream: Upstream
  /** the minimum age, in days, a version/file must have to be served (default 4, as pkg-guard used) */
  minDays?: number
  /** module/package names let through regardless of age -- the person's lever, never settable from a request */
  allowlist?: Allowlist
  now?: () => number
  fetch?: typeof fetch
  /** every upstream fetch aborts after this long, a timeout counted as an error, never a pass-through (default 10s) */
  fetchTimeoutMs?: number
  /** caps on the npm/PyPI packument/index cache and the Go .info cache, so neither grows without bound (ei0.13) */
  registryCacheMaxEntries?: number
  goInfoCacheMaxEntries?: number
}

export type Stats = { allow: number; refuse: number; error: number }
export type Gate = ((req: Request) => Promise<Response>) & { stats: () => Stats; minDays: number }

type Resolved = {
  upstream: Upstream
  minDays: number
  allowlist: { go: string[]; npm: string[]; pypi: string[] }
  now: () => number
  fetch: typeof fetch
  fetchTimeoutMs: number
  registryCacheMaxEntries: number
  goInfoCacheMaxEntries: number
  stats: Stats
  /** the npm packument / PyPI index a tarball or file request reads its entry's time from, short TTL */
  npmCache: Map<string, { parsed: NpmPackument; expiresAt: number }>
  pypiCache: Map<string, { parsed: PypiIndex; expiresAt: number }>
  /** a module version's `.info` never changes once published, so the gate caches a successful fetch
   * forever (ei0.12). `record` holds that version's sum.golang.org first-logged id, once a lookup
   * succeeds (claude-factory-8ub). */
  goInfoCache: Map<string, { info: string; version?: string; time?: string; record?: number }>
  /** goFloor holds a floor on the sum.golang.org record id. A version is old enough only when its
   * own record id is at or below this floor.
   *
   * The floor is an estimate of the sum.golang.org tree size at now-minDays. The floor is `null` until
   * the first successful refresh. A refresh can increase or decrease the floor.
   * A lower floor makes more versions too new. That is the safe side (claude-factory-56j).
   *
   * `latest` is the sum.golang.org tree size. This refresh reads it before its lookups. The next refresh
   * uses this value to measure real traffic for its increase cap. See GO_FLOOR_RISE_MARGIN and refreshGoFloor.
   *
   * An attacker can own every sampled index entry. The attacker can log each one in sum.golang.org right
   * before a refresh. The margin limits the rise of one refresh only.
   *
   * The margin does not stop a sustained attack across many refreshes. An attacker who owns the samples
   * at every refresh in a row gains about 2x real traffic per refresh above the truth. The attacker's own
   * sumdb records count as traffic for the next refresh's cap too. After about minDays / 2 refreshes, the
   * floor can get near `now`. See claude-factory-ldb for this gap.
   *
   * The first refresh after a pod start has no earlier `latest` value. This refresh has no cap on its
   * rise. See claude-factory-b9f for this gap. */
  goFloor: { record: number; at: number; latest: number } | null
  /** goFloorRefreshing holds the one in-flight floor refresh. Every decision that needs a refresh shares
   * this promise, so concurrent decisions trigger at most one index.golang.org request
   * (claude-factory-8ub). */
  goFloorRefreshing: Promise<void> | null
  /** the backoff in force after the most recent failed floor refresh, 0 when the last attempt (or there
   * has been none yet) succeeded; doubles on each further failure, up to GO_FLOOR_BACKOFF_MAX_MS
   * (claude-factory-8ub.7) */
  goFloorBackoffMs: number
  /** no new floor refresh starts before this time. A stale-but-present floor is at or below a fresh floor
   * built from the same samples, so a decision never waits on a refresh -- the backoff only throttles the
   * refresh attempt itself (claude-factory-8ub.7) */
  goFloorNextRetryAt: number
}

const REGISTRY_CACHE_MS = 60_000
const DEFAULT_FETCH_TIMEOUT_MS = 10_000
/** how many versions' .info the Go list/@latest fallback paths fetch in parallel (ei0.12) */
const GO_LIST_CONCURRENCY = 8
/** packuments/indexes are multi-MB; .info entries are tiny but there can be many more of them (ei0.13) */
const DEFAULT_REGISTRY_CACHE_MAX_ENTRIES = 200
const DEFAULT_GO_INFO_CACHE_MAX_ENTRIES = 20_000
/** the floor sample window sits inside now-minDays. index.golang.org's refresh lag (about 5 min) and its
 * several stale backends still leave enough entries in this window to sample (claude-factory-8ub) */
const GO_FLOOR_WINDOW_MS = 30 * 60_000
/** the floor estimate looks up at most this many index entries, spaced evenly across the `limit` (below)
 * returns. index.golang.org fills that `limit` within the first few minutes of the 30-minute window. So the
 * sample in practice comes from those few minutes, not the whole window (claude-factory-8ub.11). */
const GO_FLOOR_SAMPLE_LIMIT = 9

/** fewer successful, in-range lookups than this and the sample is too thin to trust: no floor from this
 * refresh (claude-factory-8ub, claude-factory-8ub.6) */
const GO_FLOOR_MIN_SAMPLES = 5

/**
 * Sets a limit on how much one refresh can increase the floor.
 *
 * The cap is a multiple of the real sum.golang.org traffic since the prior refresh (`latest -
 * prev.latest`). The assumption: the sumdb record rate now is at least 1/3 of the rate minDays ago
 * (claude-factory-8ub). So this traffic count is a fair lower bound on how far the true floor can
 * increase across the same span. A `capped: true` line in a refresh's log can also come from an honest
 * rate drop of more than 3x; that only makes the floor lag low, an availability cost, not a safety gap.
 *
 * A margin of 3 allows normal variance. Examples are bursty publishing and a refresh that runs late. It
 * limits one refresh only: an attacker who controls every sampled entry gains at most this margin over
 * real traffic in that one refresh. It does not stop a sustained attacker who owns the samples at every
 * refresh in a row -- see claude-factory-ldb (claude-factory-56j).
 *
 * The cap has no time term. A long idle or backoff gap still shows up as a large `latest` delta. So the
 * floor can still catch up to it in one refresh.
 */
const GO_FLOOR_RISE_MARGIN = 3

/** the shortest backoff after a failed floor refresh. It doubles on each further failure, up to
 * GO_FLOOR_BACKOFF_MAX_MS. During this backoff, ensureGoFloor skips a new refresh attempt. It still decides
 * every request, from a stale-but-present floor (claude-factory-8ub.7). */
const GO_FLOOR_BACKOFF_MIN_MS = 30_000
const GO_FLOOR_BACKOFF_MAX_MS = 10 * 60_000

function resolve(cfg: GateConfig): Resolved {
  const minDays = cfg.minDays ?? 4
  // a non-finite or negative minDays (e.g. Number('four') === NaN) makes every `ageH < minDays * 24` comparison
  // false, which allows every version through -- fail closed instead of silently disarming the gate (ei0.10)
  if (!Number.isFinite(minDays) || minDays < 0)
    throw new Error(`pkg-gate: minDays must be a finite, non-negative number, got ${cfg.minDays}`)
  return {
    upstream: cfg.upstream,
    minDays,
    allowlist: {
      go: cfg.allowlist?.go ?? [],
      npm: cfg.allowlist?.npm ?? [],
      pypi: cfg.allowlist?.pypi ?? [],
    },
    now: cfg.now ?? (() => Date.now()),
    fetch: cfg.fetch ?? fetch,
    fetchTimeoutMs: cfg.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    registryCacheMaxEntries: cfg.registryCacheMaxEntries ?? DEFAULT_REGISTRY_CACHE_MAX_ENTRIES,
    goInfoCacheMaxEntries: cfg.goInfoCacheMaxEntries ?? DEFAULT_GO_INFO_CACHE_MAX_ENTRIES,
    stats: { allow: 0, refuse: 0, error: 0 },
    npmCache: new Map(),
    pypiCache: new Map(),
    goInfoCache: new Map(),
    goFloor: null,
    goFloorRefreshing: null,
    goFloorBackoffMs: 0,
    goFloorNextRetryAt: 0,
  }
}

/** runs `fn` over `items` with at most `limit` in flight at once, preserving `items`' order in the result */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * evicts the oldest entries (`Map` iterates in insertion order) once a cache passes `maxEntries`, so a
 * long-running process's memory does not grow without bound against the Deployment's 512Mi limit (ei0.13)
 */
function evictOverCap<K, V>(map: Map<K, V>, maxEntries: number) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** `code` marks a refusal/error whose body text the caller must word differently from the plain age-based
 * one `decide` returns below; a Go sum.golang.org first-logged refusal is the only user today
 * (claude-factory-8ub.10) */
type Decision = {
  decision: 'allow' | 'refuse' | 'error'
  reason: string
  ageH: number | null
  code?: 'go-sumdb-too-new'
}

/** allowlisted, or old enough; a missing or unparseable time is a refusal, same as one still too young */
function decide(
  name: string,
  publishedMs: number | null,
  now: number,
  minDays: number,
  allowlist: string[],
): Decision {
  const ageH = publishedMs == null ? null : (now - publishedMs) / 3_600_000
  if (allowlist.includes(name)) return { decision: 'allow', reason: 'allowlisted', ageH }
  if (ageH == null) return { decision: 'refuse', reason: 'missing or unparseable publish time', ageH: null }
  if (ageH < minDays * 24)
    return { decision: 'refuse', reason: `published ${Math.floor(ageH)}h ago, minimum ${minDays}d`, ageH }
  return { decision: 'allow', reason: 'old enough', ageH }
}

/**
 * one JSON line per decision on stdout: no auth headers or query strings, ever. `quiet` still counts an
 * `allow` toward `cfg.stats` but does not print it -- a list/index request calls this once per version or
 * file, and printing every allow alongside a bulk summary line would be thousands of lines for one request
 * (ei0.13); a refusal or error always prints, since that is the one line audit needs.
 */
function logDecision(
  eco: string,
  name: string,
  version: string | undefined,
  published: string | null,
  d: Decision,
  cfg: Resolved,
  quiet = false,
) {
  cfg.stats[d.decision]++
  if (quiet && d.decision === 'allow') return
  console.log(
    JSON.stringify({
      eco,
      name,
      version: version ?? null,
      published,
      ageH: d.ageH == null ? null : Math.round(d.ageH * 10) / 10,
      decision: d.decision,
      reason: d.reason,
    }),
  )
}

/** one line per bulk request (a Go @v/list, @latest fallback, npm packument or PyPI simple index), counting
 * every version/file decided -- in place of the per-allow lines `logDecision(..., quiet)` suppressed */
function logSummary(eco: string, name: string, counts: { allow: number; refuse: number; error: number }) {
  console.log(JSON.stringify({ eco, name, summary: true, ...counts }))
}

/** a whole-request failure that never got as far as a per-version/file decision (an unparseable upstream
 * packument/index, say): counted and logged the same way a decision is, so it leaves the same audit trail
 * `stats.error`/the log readers of `logDecision` already expect (ei0.20) */
function logUpstreamError(eco: string, name: string, reason: string, cfg: Resolved) {
  cfg.stats.error++
  console.log(
    JSON.stringify({ eco, name, version: null, published: null, ageH: null, decision: 'error', reason }),
  )
}

// a minimal semver reader, just enough to tell a release from a prerelease/pseudo-version and to rank
// releases against each other -- used so a nightly, prerelease, or pseudo-version never outranks a real
// release merely for being newer by publish time (ei0.11)
type SemVer = { major: number; minor: number; patch: number; pre: string | null }

function parseSemver(v: string): SemVer | null {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}

/** the highest non-prerelease version among `versions`, by semver order; `undefined` if every one is a prerelease or unparseable */
function highestRelease(versions: string[]): string | undefined {
  const releases = versions.flatMap(v => {
    const s = parseSemver(v)
    return s && s.pre == null ? [{ v, s }] : []
  })
  releases.sort((a, b) => b.s.major - a.s.major || b.s.minor - a.s.minor || b.s.patch - a.s.patch)
  return releases[0]?.v
}

function refuse(status: number, text: string) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } })
}

async function fetchText(
  cfg: Resolved,
  url: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  try {
    const r = await cfg.fetch(url, { signal: AbortSignal.timeout(cfg.fetchTimeoutMs) })
    const text = await r.text()
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, text }
  } catch {
    // a timeout (AbortSignal) lands here too, same as a network error: no status, refused the same as a 5xx
    return { ok: false, status: 0 }
  }
}

async function fetchBytes(
  cfg: Resolved,
  url: string,
): Promise<{ ok: true; buf: ArrayBuffer } | { ok: false; status: number }> {
  try {
    const r = await cfg.fetch(url, { signal: AbortSignal.timeout(cfg.fetchTimeoutMs) })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, buf: await r.arrayBuffer() }
  } catch {
    return { ok: false, status: 0 }
  }
}

/** parses `raw` as a URL, returning `null` instead of throwing -- used only to validate a fetch target
 * before fetching it, never to recover a URL that was going to be used regardless */
function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * true only when `url` is http(s) and its origin (scheme+host+port) matches one of `bases` exactly. An
 * upstream-named fetch target (an npm `dist.tarball`, a PyPI file `url`) must never be trusted past this
 * check: `fetch` on this runtime also follows a `file://` URL onto the gate pod's own filesystem, and an
 * arbitrary http(s) host would make the gate fetch (and serve back) whatever a malicious or compromised
 * upstream points it at -- an SSRF / local-file-read pivot through the one thing every gated task can reach
 * (ei0.23). A relative PEP 691 `url` (ei0.21) already resolved against the index is always same-origin with
 * it, so this never rejects that case.
 */
function isConfiguredUpstream(url: URL, bases: string[]): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return bases.some(base => {
    const b = tryParseUrl(base)
    return b != null && url.protocol === b.protocol && url.host === b.host
  })
}

// ---------------------------------------------------------------------------------------------------------
// Go module proxy protocol (https://go.dev/ref/mod#goproxy-protocol): list, .info, .mod, .zip, @latest, sumdb.
// A module path keeps whatever case-encoding (`!x`) it arrived with; it is only ever matched and forwarded,
// never decoded, so it reaches upstream exactly as Go sent it.

/**
 * reverses Go's module-path case encoding (a `!` followed by a lowercase letter is that letter's uppercase):
 * `decide`'s allowlist match runs against this, so an entry written in a module's real casing
 * (`github.com/Azure/azure-sdk-for-go`) matches the encoded path Go actually sends
 * (`github.com/!azure/azure-sdk-for-go`) -- the gate still never decodes what it forwards upstream (ei0.18)
 */
function goModuleUnescape(path: string): string {
  return path.replace(/!([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Go's module-path case encoding, the reverse of `goModuleUnescape`: an uppercase letter becomes `!`
 * followed by its lowercase. index.golang.org's `Path` and `Version` fields arrive un-encoded; a
 * sum.golang.org lookup needs them encoded the way the go command itself would send them (claude-factory-8ub)
 */
function goModuleEscape(s: string): string {
  return s.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`)
}

function parseGoInfo(text: string): { version: string; time: string } | null {
  try {
    const j = JSON.parse(text)
    return typeof j.Version === 'string' && typeof j.Time === 'string'
      ? { version: j.Version, time: j.Time }
      : null
  } catch {
    return null
  }
}

/**
 * looks up `<mod>@<version>` on sum.golang.org.
 * sum.golang.org sets a module's record id once, the first time any client asks for that content hash.
 * The module author cannot move this id (claude-factory-8ub).
 * The caller sends `mod` and `version` exactly as given: already Go-case-escaped by the caller itself.
 * This function returns `ok:false` on a non-2xx status, a timeout, or a body whose first line is not a
 * plain non-negative integer. It never caches that result, and never treats it as an allow.
 */
async function goSumdbRecord(
  cfg: Resolved,
  mod: string,
  version: string,
): Promise<{ ok: true; record: number } | { ok: false }> {
  const r = await fetchText(cfg, `${cfg.upstream.sumdb}/lookup/${mod}@${version}`)
  if (!r.ok) return { ok: false }
  const line1 = (r.text.split('\n')[0] ?? '').trim()
  if (!/^\d+$/.test(line1)) return { ok: false }
  const record = Number(line1)
  return Number.isSafeInteger(record) ? { ok: true, record } : { ok: false }
}

/**
 * reads the tree size sum.golang.org's signed note (https://pkg.go.dev/golang.org/x/mod/sumdb/note)
 * names at `GET /latest`. The note's first line is the fixed string `go.sum database tree`; its second line
 * is the size, the count of records logged so far. No record id can reach or pass this size.
 *
 * A floor refresh reads this size before its own per-version lookups and drops any sample whose own record
 * sits at or past it (claude-factory-8ub.6): such a sample was logged no earlier than the refresh's own
 * lookup traffic (an attacker's flood, or a `GOSUMDB=off` fetch this very gate just made), so trusting it
 * as evidence of what sum.golang.org had already logged long before now would let a backdated version raise
 * the floor to about now and pass as old.
 */
function parseSumdbLatestSize(text: string): number | null {
  const lines = text.split('\n')
  if (lines[0] !== 'go.sum database tree') return null
  const size = Number((lines[1] ?? '').trim())
  return Number.isSafeInteger(size) && size >= 0 ? size : null
}

async function goSumdbLatestSize(cfg: Resolved): Promise<{ ok: true; size: number } | { ok: false }> {
  const r = await fetchText(cfg, `${cfg.upstream.sumdb}/latest`)
  if (!r.ok) return { ok: false }
  const size = parseSumdbLatestSize(r.text)
  return size === null ? { ok: false } : { ok: true, size }
}

/** up to `n` evenly spaced items from `items`, in their original order; `items` itself when it already has
 * `n` or fewer entries */
function pickEvenlySpaced<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  const step = items.length / n
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!)
}

type GoIndexLine = { Path: string; Version: string; Timestamp: string }

function parseGoIndexLine(line: string): GoIndexLine | null {
  try {
    const j = JSON.parse(line)
    return typeof j?.Path === 'string' && typeof j?.Version === 'string' && typeof j?.Timestamp === 'string'
      ? { Path: j.Path, Version: j.Version, Timestamp: j.Timestamp }
      : null
  } catch {
    return null
  }
}

/**
 * records a failed floor refresh: one JSON line to stdout, never naming a URL (same rule as `logDecision`),
 * and a backoff so a down index.golang.org or sum.golang.org is not retried on every single decision
 * (claude-factory-8ub.7). The backoff doubles on each further failure, up to GO_FLOOR_BACKOFF_MAX_MS, and
 * resets to 0 on the next success.
 */
function noteGoFloorFailure(cfg: Resolved, reason: string) {
  cfg.goFloorBackoffMs = cfg.goFloorBackoffMs
    ? Math.min(cfg.goFloorBackoffMs * 2, GO_FLOOR_BACKOFF_MAX_MS)
    : GO_FLOOR_BACKOFF_MIN_MS
  cfg.goFloorNextRetryAt = cfg.now() + cfg.goFloorBackoffMs
  console.log(JSON.stringify({ eco: 'go', decision: 'error', reason: `sumdb floor refresh: ${reason}` }))
}

/**
 * refreshes `cfg.goFloor` from index.golang.org.
 *
 * It samples up to `GO_FLOOR_SAMPLE_LIMIT` entries first seen in the window ending at `now - minDays`.
 * It reads the current sum.golang.org tree size. Then it looks up each sampled entry there.
 *
 * It drops any sample whose own record is at or past that size, because sum.golang.org recorded that
 * record no earlier than this refresh's own lookups. So it is no evidence of a record recorded well
 * before now (claude-factory-8ub.6). The minimum of the remaining ids, `sampled`, is the raw estimate of
 * this refresh. Each of those ids is a record that sum.golang.org already held before this refresh began.
 *
 * `sampled` alone is not the new floor. An attacker can control every sampled index entry. The attacker
 * can record each one in sum.golang.org right before the refresh. Then `sampled` can move close to `now`.
 * So the new floor is `Math.min(sampled, bound)`.
 *
 * Here `bound` sets a limit on this one refresh's increase. Its value is GO_FLOOR_RISE_MARGIN times the
 * real sum.golang.org traffic in that span (`latest - prev.latest`). See `goFloor`'s own doc comment and
 * claude-factory-56j. This bound does not stop a sustained attacker who owns the samples at every refresh
 * in a row -- see claude-factory-ldb. A cold start (no prior floor) has no bound. The new floor can come
 * out below the old one, and a low `bound` makes more versions too new, which is the safe side.
 *
 * A failed fetch, or fewer than `GO_FLOOR_MIN_SAMPLES` answers left after the drop, leaves the existing
 * floor in place. So a down upstream never blocks every decision behind a refresh.
 * Either way, exactly one JSON line goes to stdout.
 * On success, the line is `{eco:'go', floor, at, samples, sampled, capped}`.
 * On failure, the line is `{eco:'go', decision:'error', reason}`.
 * The `goFloor` field of `/healthz` summarizes the same audit trail as current state (claude-factory-8ub).
 */
async function refreshGoFloor(cfg: Resolved): Promise<void> {
  const t0 = cfg.now() - cfg.minDays * 24 * 3_600_000
  const sinceMs = t0 - GO_FLOOR_WINDOW_MS
  const r = await fetchText(
    cfg,
    `${cfg.upstream.goIndex}/index?since=${encodeURIComponent(new Date(sinceMs).toISOString())}&limit=2000`,
  )
  if (!r.ok) return noteGoFloorFailure(cfg, `index.golang.org ${r.status || 'timeout'}`)
  const entries = r.text
    .split('\n')
    .map(parseGoIndexLine)
    .filter((e): e is GoIndexLine => {
      if (!e) return false
      const ts = Date.parse(e.Timestamp)
      return !Number.isNaN(ts) && ts >= sinceMs && ts <= t0
    })
  const sample = pickEvenlySpaced(entries, GO_FLOOR_SAMPLE_LIMIT)
  const latestSize = await goSumdbLatestSize(cfg)
  if (!latestSize.ok) return noteGoFloorFailure(cfg, 'sum.golang.org /latest unavailable')
  const ids: number[] = []
  await mapLimit(sample, GO_LIST_CONCURRENCY, async e => {
    const looked = await goSumdbRecord(cfg, goModuleEscape(e.Path), goModuleEscape(e.Version))
    if (looked.ok && looked.record < latestSize.size) ids.push(looked.record)
  })
  if (ids.length < GO_FLOOR_MIN_SAMPLES)
    return noteGoFloorFailure(
      cfg,
      `only ${ids.length} of ${sample.length} sampled versions answered within the tree size read before lookups, need ${GO_FLOOR_MIN_SAMPLES}`,
    )
  const sampled = Math.min(...ids)
  const prev = cfg.goFloor
  const bound = prev
    ? prev.record + GO_FLOOR_RISE_MARGIN * Math.max(0, latestSize.size - prev.latest)
    : Infinity
  const record = Math.min(sampled, bound)
  const capped = record < sampled
  cfg.goFloor = { record, at: t0, latest: latestSize.size }
  cfg.goFloorBackoffMs = 0
  cfg.goFloorNextRetryAt = 0
  console.log(
    JSON.stringify({
      eco: 'go',
      floor: cfg.goFloor.record,
      at: new Date(cfg.goFloor.at).toISOString(),
      samples: ids.length,
      sampled,
      capped,
    }),
  )
}

/**
 * makes sure `cfg.goFloor` is fresh enough to decide with -- or, when one is already in force, starts a
 * background refresh and returns that one right away.
 *
 * A `null` floor (a cold start) is not safe to decide with. The one caller that finds it `null` waits
 * for the in-flight refresh, if a stale check started one.
 *
 * A stale floor that is still present decides at once. Every other caller never waits on the refresh that
 * its own staleness check starts (claude-factory-8ub.7). A refresh can decrease the floor (claude-factory-56j).
 * So a decision made in this gap can use a floor that the next refresh will decrease. The lag is one refresh
 * period, and it is on the safe side only when the floor is about to increase. The gate already accepts the
 * same lag while a refresh is in flight.
 *
 * Every caller that needs a refresh shares the one in-flight promise, so a burst of decisions (a `@v/list`
 * of 20 versions, say) causes at most one index.golang.org request (claude-factory-8ub).
 * A refresh that fails backs off (see `noteGoFloorFailure`): while backed off, this function starts no new
 * one, so a down index.golang.org or sum.golang.org is not retried on every decision (claude-factory-8ub.7).
 */
async function ensureGoFloor(cfg: Resolved): Promise<Resolved['goFloor']> {
  const t0 = cfg.now() - cfg.minDays * 24 * 3_600_000
  const stale = !cfg.goFloor || cfg.goFloor.at < t0 - GO_FLOOR_WINDOW_MS
  const backedOff = cfg.now() < cfg.goFloorNextRetryAt
  if (stale && !backedOff && !cfg.goFloorRefreshing)
    cfg.goFloorRefreshing = refreshGoFloor(cfg).finally(() => (cfg.goFloorRefreshing = null))
  if (!cfg.goFloor && cfg.goFloorRefreshing) await cfg.goFloorRefreshing
  return cfg.goFloor
}

/**
 * the second half of a Go version's decision.
 * The caller must run this only once `infoDecision` is an `allow` that is not merely `allowlisted`: a
 * version too young, missing its publish time, or itself allowlisted never reaches sum.golang.org at all.
 * This function refuses when the floor is unavailable, the lookup fails, or the version's own record
 * outranks the floor (so the gate cannot yet trust it as first logged long enough ago).
 * Otherwise it returns `infoDecision` unchanged.
 * `cacheEntry`, when given, carries the looked-up record forward, so the gate never looks up the same
 * version twice (claude-factory-8ub).
 */
async function goSumdbGate(
  cfg: Resolved,
  mod: string,
  version: string,
  cacheEntry: { record?: number } | undefined,
  infoDecision: Decision,
): Promise<Decision> {
  const floor = await ensureGoFloor(cfg)
  if (!floor)
    return { decision: 'error', reason: 'sum.golang.org floor unavailable', ageH: infoDecision.ageH }
  let record = cacheEntry?.record
  if (record === undefined) {
    const looked = await goSumdbRecord(cfg, mod, version)
    if (!looked.ok)
      return { decision: 'error', reason: 'sum.golang.org lookup failed', ageH: infoDecision.ageH }
    record = looked.record
    if (cacheEntry) cacheEntry.record = record
  }
  if (record > floor.record)
    return {
      decision: 'refuse',
      reason: `first logged in sum.golang.org after ${new Date(floor.at).toISOString()} (record ${record} > floor ${floor.record}), minimum ${cfg.minDays}d`,
      ageH: infoDecision.ageH,
      code: 'go-sumdb-too-new',
    }
  return infoDecision
}

/**
 * fetches `<mod>/@v/<version>.info` and decides: `ok:false` is an upstream fetch error (non-2xx, timeout),
 * always refused with no decision possible; JSON that is missing or unparseable is a decision of its own
 * (`decide` with no publish time), refused the same as a version that is simply too young
 */
async function goDecideVersion(cfg: Resolved, mod: string, version: string, quiet = false) {
  // `.info` never changes once a version is published, so a successful fetch is cached forever: goList and
  // goLatest's fallback no longer refetch the same mod@version on every request (ei0.12). The cache itself is
  // bounded (ei0.13): over cap, the oldest entry is evicted to make room.
  const key = `${mod}@${version}`
  let cached = cfg.goInfoCache.get(key)
  if (!cached) {
    const r = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@v/${version}.info`)
    if (!r.ok) {
      logDecision(
        'go',
        mod,
        version,
        null,
        { decision: 'error', reason: `upstream .info: ${r.status || 'timeout'}`, ageH: null },
        cfg,
        quiet,
      )
      return { ok: false as const }
    }
    const parsed = parseGoInfo(r.text)
    const entry = { info: r.text, version: parsed?.version, time: parsed?.time }
    // Cache only a canonical, immutable answer: the query must resolve to itself. An exact version's own
    // .info never changes. A branch/tag query (@v/master.info) can resolve to a different, moving version
    // upstream. An unparseable 200 is no decision at all. Caching either forever under the query's own key
    // would pin a stale or broken answer in place (ei0.14).
    // `version` is the escaped path segment (v1.0.0-!r!c1). `parsed.version` is the .info body's raw,
    // un-escaped Version field (v1.0.0-RC1). The comparison must escape it first. Otherwise an uppercase
    // prerelease never matches, and the gate never caches it (claude-factory-8ub.13).
    if (parsed && goModuleEscape(parsed.version) === version) {
      cfg.goInfoCache.set(key, entry)
      evictOverCap(cfg.goInfoCache, cfg.goInfoCacheMaxEntries)
    }
    cached = entry
  }
  const publishedMs = cached.time ? Date.parse(cached.time) : NaN
  let d = decide(
    goModuleUnescape(mod),
    Number.isNaN(publishedMs) ? null : publishedMs,
    cfg.now(),
    cfg.minDays,
    cfg.allowlist.go,
  )
  // old enough by .info Time and not merely allowlisted: the time alone is not trustworthy (a module author
  // controls the tagged commit's VCS time), so also check sum.golang.org's first-logged record (claude-factory-8ub).
  // goModuleEscape: `cached.version` is the .info body's raw Version field, not Go-case-escaped the way a
  // sum.golang.org lookup key must be (claude-factory-8ub.8)
  if (d.decision === 'allow' && d.reason !== 'allowlisted')
    d = await goSumdbGate(cfg, mod, goModuleEscape(cached.version ?? version), cached, d)
  logDecision('go', mod, cached.version ?? version, cached.time ?? null, d, cfg, quiet)
  return { ok: true as const, info: cached.info, time: cached.time, decision: d }
}

function ageText(d: Decision) {
  return d.ageH == null ? 'unknown publish time' : `published ${Math.floor(d.ageH)}h ago`
}

async function goVersion(cfg: Resolved, mod: string, version: string, ext: 'info' | 'mod' | 'zip') {
  const r = await goDecideVersion(cfg, mod, version)
  if (!r.ok) return refuse(502, `pkg-gate: ${mod}@${version}: upstream error`)
  if (r.decision.decision === 'refuse') {
    // a sum.golang.org refusal (first logged too recently) carries its own wording; everything else keeps
    // the age-based one. `code`, not a `reason` prefix, tells the two apart (claude-factory-8ub.10)
    const text =
      r.decision.code === 'go-sumdb-too-new'
        ? `pkg-gate: ${mod}@${version} first logged in sum.golang.org less than ${cfg.minDays}d ago, minimum ${cfg.minDays}d`
        : `pkg-gate: ${mod}@${version} ${ageText(r.decision)}, minimum ${cfg.minDays}d`
    return refuse(404, text)
  }
  // the floor was unavailable, or the sum.golang.org lookup itself failed: an upstream error, same as a
  // failed .info/.mod/.zip fetch, never a pass-through (claude-factory-8ub)
  if (r.decision.decision === 'error') return refuse(502, `pkg-gate: ${mod}@${version}: upstream error`)
  if (ext === 'info') return new Response(r.info, { headers: { 'content-type': 'application/json' } })
  const b = await fetchBytes(cfg, `${cfg.upstream.go}/${mod}/@v/${version}.${ext}`)
  if (!b.ok) return refuse(502, `pkg-gate: ${mod}@${version}.${ext}: upstream error`)
  return new Response(b.buf, {
    headers: { 'content-type': ext === 'zip' ? 'application/zip' : 'text/plain; charset=utf-8' },
  })
}

/** tallies a batch of goDecideVersion results for one summary line (ei0.13); an upstream fetch failure counts as `error` */
function tallyGo(decisions: Awaited<ReturnType<typeof goDecideVersion>>[]) {
  const counts = { allow: 0, refuse: 0, error: 0 }
  for (const d of decisions) counts[d.ok ? d.decision.decision : 'error']++
  return counts
}

async function goList(cfg: Resolved, mod: string) {
  const r = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@v/list`)
  if (!r.ok) return refuse(502, `pkg-gate: ${mod}: upstream error`)
  const versions = r.text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  // one `.info` per version, up to GO_LIST_CONCURRENCY in flight at once, instead of serially: a module with
  // hundreds of versions no longer takes minutes to list (ei0.12). `quiet`: a refusal/error still logs its own
  // line, but an allow is counted, not printed -- one summary line covers the whole list instead (ei0.13)
  const decisions = await mapLimit(versions, GO_LIST_CONCURRENCY, v => goDecideVersion(cfg, mod, v, true))
  const kept = versions.filter((_, i) => decisions[i]!.ok && decisions[i]!.decision.decision === 'allow')
  logSummary('go', mod, tallyGo(decisions))
  return new Response(kept.length ? kept.join('\n') + '\n' : '', {
    headers: { 'content-type': 'text/plain' },
  })
}

async function goLatest(cfg: Resolved, mod: string) {
  const latest = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@latest`)
  if (latest.ok) {
    const parsed = parseGoInfo(latest.text)
    if (parsed) {
      const publishedMs = Date.parse(parsed.time)
      let d = decide(
        goModuleUnescape(mod),
        Number.isNaN(publishedMs) ? null : publishedMs,
        cfg.now(),
        cfg.minDays,
        cfg.allowlist.go,
      )
      if (d.decision === 'allow' && d.reason !== 'allowlisted') {
        // goModuleEscape: `parsed.version` is @latest's own raw Version field (claude-factory-8ub.8).
        // keyed by that same escaped form, so this entry is reachable the same way goDecideVersion's cache
        // is: a later request for this exact version hits it instead of repeating the sum.golang.org
        // lookup (claude-factory-8ub.9)
        const key = `${mod}@${goModuleEscape(parsed.version)}`
        let cacheEntry = cfg.goInfoCache.get(key)
        if (!cacheEntry) {
          cacheEntry = { info: latest.text, version: parsed.version, time: parsed.time }
          cfg.goInfoCache.set(key, cacheEntry)
          evictOverCap(cfg.goInfoCache, cfg.goInfoCacheMaxEntries)
        }
        d = await goSumdbGate(cfg, mod, goModuleEscape(parsed.version), cacheEntry, d)
      }
      logDecision('go', mod, parsed.version, parsed.time, d, cfg)
      if (d.decision === 'allow')
        return new Response(latest.text, { headers: { 'content-type': 'application/json' } })
    } else {
      logDecision(
        'go',
        mod,
        undefined,
        null,
        { decision: 'error', reason: 'unparseable @latest', ageH: null },
        cfg,
      )
    }
  }
  // the real latest is too young, not yet trusted by sum.golang.org, or unreadable: fall back to the newest
  // version old enough (claude-factory-8ub)
  const list = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@v/list`)
  if (!list.ok) return refuse(502, `pkg-gate: ${mod}: upstream error`)
  const versions = list.text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  const decisions = await mapLimit(versions, GO_LIST_CONCURRENCY, v => goDecideVersion(cfg, mod, v, true))
  logSummary('go', mod, tallyGo(decisions))
  const candidates: { version: string; time: string }[] = []
  versions.forEach((v, i) => {
    const d = decisions[i]!
    if (d.ok && d.decision.decision === 'allow' && d.time) candidates.push({ version: v, time: d.time })
  })
  // prefer the highest release semver over the newest by time, so a pseudo-version or prerelease commit
  // never wins over a real release just for being more recently published (ei0.11); only fall back to
  // newest-by-time when every old-enough candidate is itself a prerelease/pseudo-version
  candidates.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
  const releaseVersion = highestRelease(candidates.map(c => c.version))
  const top = releaseVersion ? candidates.find(c => c.version === releaseVersion) : candidates[0]
  if (!top) return refuse(404, `pkg-gate: ${mod}: no version old enough (minimum ${cfg.minDays}d)`)
  return new Response(JSON.stringify({ Version: top.version, Time: top.time }), {
    headers: { 'content-type': 'application/json' },
  })
}

async function handleGo(cfg: Resolved, path: string): Promise<Response> {
  if (path.startsWith('sumdb/')) {
    // proxy.golang.org answers 404 on every /sumdb/sum.golang.org/* path (claude-factory-1hc).
    //
    // So this passthrough fetches from cfg.upstream.sumdb (sum.golang.org directly), never cfg.upstream.go.
    // This gate fronts only one db, 'sum.golang.org'. It refuses any other path with zero upstream fetch.

    const dbPrefix = 'sumdb/sum.golang.org/'
    if (!path.startsWith(dbPrefix)) return refuse(404, 'pkg-gate: not found')
    const sub = path.slice(dbPrefix.length)

    // sum.golang.org itself has no /supported path; it answers 404 there.
    //
    // The go command reads /supported to pick the proxy path over a direct sumdb fetch. A gated rig's
    // egress strips sum.golang.org. So this gate must answer /supported itself, with no upstream fetch
    // (claude-factory-1hc).

    if (sub === 'supported') return new Response('', { status: 200 })
    if (!/^(latest|lookup\/.+|tile\/.+)$/.test(sub)) return refuse(404, 'pkg-gate: not found')
    // bytes, never text: /tile/ bodies are raw transparency-log hash data, and go's default GOSUMDB (via
    // the proxy's /sumdb/ passthrough) fetches them -- decoding as UTF-8 and re-encoding (the old fetchText
    // + `new Response(text)`) corrupts any byte above 0x7f, which fails checksum verification (ei0.8)
    let upstream: Response
    try {
      // redirect: 'manual' blocks a sumdb redirect to an attacker-chosen host. A 3xx reply fails `.ok` and
      // gets the same refusal as any other non-2xx reply, below.
      upstream = await cfg.fetch(`${cfg.upstream.sumdb}/${sub}`, {
        signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
        redirect: 'manual',
      })
    } catch {
      return refuse(502, 'pkg-gate: sumdb upstream error')
    }
    if (!upstream.ok) return refuse(502, 'pkg-gate: sumdb upstream error')
    const buf = await upstream.arrayBuffer()
    return new Response(buf, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' },
    })
  }
  if (path.endsWith('/@latest')) return goLatest(cfg, path.slice(0, -'/@latest'.length))
  const marker = '/@v/'
  const i = path.indexOf(marker)
  if (i < 0) return refuse(404, 'pkg-gate: not found')
  const mod = path.slice(0, i)
  const rest = path.slice(i + marker.length)
  if (rest === 'list') return goList(cfg, mod)
  const m = rest.match(/^(.+)\.(info|mod|zip)$/)
  if (!m) return refuse(404, 'pkg-gate: not found')
  return goVersion(cfg, mod, m[1]!, m[2] as 'info' | 'mod' | 'zip')
}

// ---------------------------------------------------------------------------------------------------------
// npm: the full packument (never the abbreviated install-v1 doc, which has no publish time), with every
// young version stripped from `versions` and `time`, `dist-tags` re-pointed off removed versions, and each
// `dist.tarball` rewritten to the gate's own host so a later tarball request has somewhere to be checked.

type NpmVersion = { dist?: { tarball?: string; [k: string]: unknown }; [k: string]: unknown }
type NpmPackument = {
  name?: string
  'dist-tags'?: Record<string, string>
  versions: Record<string, NpmVersion>
  time: Record<string, string>
  [k: string]: unknown
}

/** registry.npmjs.org's own convention: `@` stays literal, only the scope's `/` is percent-encoded */
const npmUpstreamName = (pkg: string) => pkg.replace('/', '%2f')
const decodeScopedName = (raw: string) => (/%2f/i.test(raw) ? decodeURIComponent(raw) : raw)

function parseNpmPath(
  path: string,
): { kind: 'packument'; pkg: string } | { kind: 'tarball'; pkg: string; file: string } | null {
  const segments = path.split('/').filter(Boolean)
  if (!segments.length) return null
  const dashIdx = segments.indexOf('-')
  if (dashIdx < 0) return { kind: 'packument', pkg: decodeScopedName(segments.join('/')) }
  const file = segments.slice(dashIdx + 1).join('/')
  const pkg = decodeScopedName(segments.slice(0, dashIdx).join('/'))
  return pkg && file ? { kind: 'tarball', pkg, file } : null
}

/**
 * every `versions[v]` must itself be a (non-null) object: a bad upstream shape (e.g. `{"1.0.0": null}`) is
 * refused as an upstream error right here, rather than later throwing deep inside `filterPackument` (reading
 * a null's `.dist`) and surfacing raw exception text through the handler's catch-all (ei0.20)
 */
function parsePackument(text: string): NpmPackument | null {
  try {
    const j = JSON.parse(text)
    if (
      !j ||
      typeof j !== 'object' ||
      !j.versions ||
      typeof j.versions !== 'object' ||
      !j.time ||
      typeof j.time !== 'object'
    )
      return null
    for (const v of Object.values(j.versions)) if (!v || typeof v !== 'object') return null
    return j
  } catch {
    return null
  }
}

/** the upstream packument, cached a short while so a tarball request need not refetch it per file */
async function fetchPackument(cfg: Resolved, pkg: string) {
  const cached = cfg.npmCache.get(pkg)
  if (cached) {
    if (cached.expiresAt > Date.now()) return { ok: true as const, parsed: cached.parsed }
    cfg.npmCache.delete(pkg) // expired: evict rather than leave it to grow the map forever (ei0.13)
  }
  try {
    const r = await cfg.fetch(`${cfg.upstream.npm}/${npmUpstreamName(pkg)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
    })
    if (!r.ok) return { ok: false as const, status: r.status }
    const parsed = parsePackument(await r.text())
    if (!parsed) {
      logUpstreamError('npm', pkg, 'unparseable or malformed upstream packument', cfg)
      return { ok: false as const, status: 0 }
    }
    cfg.npmCache.set(pkg, { parsed, expiresAt: Date.now() + REGISTRY_CACHE_MS })
    evictOverCap(cfg.npmCache, cfg.registryCacheMaxEntries)
    return { ok: true as const, parsed }
  } catch {
    return { ok: false as const, status: 0 }
  }
}

function npmTarballFile(tarball: string) {
  return tarball.slice(tarball.lastIndexOf('/') + 1)
}

function filterPackument(cfg: Resolved, pkg: string, p: NpmPackument, origin: string): NpmPackument {
  const kept = new Set<string>()
  // quiet: a refusal still logs its own line, but an allow is only counted -- one summary line covers the
  // whole packument instead of one line per version (ei0.13)
  const counts = { allow: 0, refuse: 0, error: 0 }
  for (const v of Object.keys(p.versions)) {
    const timeStr = p.time[v]
    const publishedMs = timeStr ? Date.parse(timeStr) : NaN
    const d = decide(
      pkg,
      Number.isNaN(publishedMs) ? null : publishedMs,
      cfg.now(),
      cfg.minDays,
      cfg.allowlist.npm,
    )
    logDecision('npm', pkg, v, timeStr ?? null, d, cfg, true)
    counts[d.decision]++
    if (d.decision === 'allow') kept.add(v)
  }
  logSummary('npm', pkg, counts)
  const versions: Record<string, NpmVersion> = {}
  const time: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.time))
    if (k === 'created' || k === 'modified' || kept.has(k)) time[k] = v
  for (const v of kept) {
    const vd = p.versions[v]!
    versions[v] = vd.dist?.tarball
      ? { ...vd, dist: { ...vd.dist, tarball: `${origin}/npm/${pkg}/-/${npmTarballFile(vd.dist.tarball)}` } }
      : vd
  }
  const distTags: Record<string, string> = {}
  for (const [tag, v] of Object.entries(p['dist-tags'] ?? {})) if (kept.has(v)) distTags[tag] = v
  // upstream's own `latest` survives the loop above when its version is kept; only re-point it when it was
  // dropped (too young/refused), and prefer the highest release semver over newest-by-time, so a nightly,
  // prerelease or old major published more recently never wins over a real release (ei0.11)
  if (!distTags.latest) {
    const fallback =
      highestRelease([...kept]) ?? [...kept].sort((a, b) => Date.parse(time[b]!) - Date.parse(time[a]!))[0]
    if (fallback) distTags.latest = fallback
  }
  return { ...p, versions, time, 'dist-tags': distTags }
}

async function npmPackument(cfg: Resolved, pkg: string, origin: string) {
  const pack = await fetchPackument(cfg, pkg)
  if (!pack.ok) return refuse(pack.status === 404 ? 404 : 502, `pkg-gate: ${pkg}: upstream error`)
  return new Response(JSON.stringify(filterPackument(cfg, pkg, pack.parsed, origin)), {
    headers: { 'content-type': 'application/json' },
  })
}

async function npmTarball(cfg: Resolved, pkg: string, file: string) {
  const pack = await fetchPackument(cfg, pkg)
  if (!pack.ok) return refuse(pack.status === 404 ? 404 : 502, `pkg-gate: ${pkg}: upstream error`)
  const version = Object.keys(pack.parsed.versions).find(
    v =>
      pack.parsed.versions[v]!.dist?.tarball &&
      npmTarballFile(pack.parsed.versions[v]!.dist!.tarball!) === file,
  )
  if (!version) return refuse(404, `pkg-gate: ${pkg}/-/${file} not found`)
  const timeStr = pack.parsed.time[version]
  const publishedMs = timeStr ? Date.parse(timeStr) : NaN
  const d = decide(
    pkg,
    Number.isNaN(publishedMs) ? null : publishedMs,
    cfg.now(),
    cfg.minDays,
    cfg.allowlist.npm,
  )
  logDecision('npm', pkg, version, timeStr ?? null, d, cfg)
  if (d.decision !== 'allow')
    return refuse(404, `pkg-gate: ${pkg}@${version} ${ageText(d)}, minimum ${cfg.minDays}d`)
  const upstreamUrl = pack.parsed.versions[version]!.dist!.tarball!
  // never fetch a tarball URL upstream merely named: it must be http(s) and actually on this ecosystem's
  // configured upstream, or the packument itself could point the gate at file:// or an arbitrary host (ei0.23)
  const target = tryParseUrl(upstreamUrl)
  if (!target || !isConfiguredUpstream(target, [cfg.upstream.npm])) {
    logUpstreamError('npm', pkg, 'tarball url is not http(s) on a configured upstream', cfg)
    return refuse(502, `pkg-gate: ${pkg}/-/${file}: upstream error`)
  }
  const b = await fetchBytes(cfg, target.toString())
  if (!b.ok) return refuse(502, `pkg-gate: ${pkg}/-/${file}: upstream error`)
  return new Response(b.buf, { headers: { 'content-type': 'application/octet-stream' } })
}

async function handleNpm(cfg: Resolved, path: string, origin: string): Promise<Response> {
  const parsed = parseNpmPath(path)
  if (!parsed) return refuse(404, 'pkg-gate: not found')
  return parsed.kind === 'tarball'
    ? npmTarball(cfg, parsed.pkg, parsed.file)
    : npmPackument(cfg, parsed.pkg, origin)
}

// ---------------------------------------------------------------------------------------------------------
// PyPI: the PEP 691 simple index (JSON), with every file whose PEP 700 upload-time is younger than the
// minimum, or missing entirely, dropped; project names normalized per PEP 503. Files are served from a
// separate `/pypi/files` host (files.pythonhosted.org in reality), named by the index's own rewritten URLs.

type PypiFile = { filename: string; url: string; 'upload-time'?: string | null; [k: string]: unknown }
type PypiIndex = { files: PypiFile[]; [k: string]: unknown }

/** PEP 503: lowercase, runs of -_. collapsed to a single - */
const pepNormalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

/** every `files[i]` must carry a string `filename` and `url`: a bad shape is refused as an upstream error
 * right here, rather than later throwing inside `pypiSimple`/`pypiFile` (`new URL(f.url)` on a non-string) (ei0.20) */
function parsePypiIndex(text: string): PypiIndex | null {
  try {
    const j = JSON.parse(text)
    if (!j || typeof j !== 'object' || !Array.isArray(j.files)) return null
    for (const f of j.files)
      if (!f || typeof f !== 'object' || typeof f.filename !== 'string' || typeof f.url !== 'string')
        return null
    return j
  } catch {
    return null
  }
}

/** the exact upstream index URL a project's files' PEP 691 `url` resolves against when relative (ei0.21) */
function pypiIndexUrl(cfg: Resolved, project: string): string {
  return `${cfg.upstream.pypi}/simple/${project}/`
}

/**
 * a file's absolute URL, resolved against the index it came from: PEP 691 allows `url` relative to the
 * index URL, which pypi.org never sends but a mirror (devpi, Artifactory, Nexus; `PKG_GATE_UPSTREAM_PYPI`)
 * commonly does. `new URL(f.url)` with no base throws on one of those instead of resolving it, which 404ed
 * (pre ei0.20 hardening, 400ed) every index request for the project (ei0.21). The resolved URL can land on
 * the index host itself, not necessarily the separate `files` upstream -- so this, not `cfg.upstream.files`,
 * is what a file is actually fetched from.
 */
function pypiResolvedFileUrl(cfg: Resolved, project: string, file: PypiFile, metadataSuffix = false): URL {
  const u = new URL(file.url, pypiIndexUrl(cfg, project))
  if (metadataSuffix) u.pathname += METADATA_SUFFIX
  return u
}

/** the upstream simple index for a (PEP 503 normalized) project, cached a short while */
async function fetchPypiIndex(cfg: Resolved, project: string) {
  const cached = cfg.pypiCache.get(project)
  if (cached) {
    if (cached.expiresAt > Date.now()) return { ok: true as const, parsed: cached.parsed }
    cfg.pypiCache.delete(project) // expired: evict rather than leave it to grow the map forever (ei0.13)
  }
  try {
    const r = await cfg.fetch(pypiIndexUrl(cfg, project), {
      headers: { accept: 'application/vnd.pypi.simple.v1+json' },
      signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
    })
    if (!r.ok) return { ok: false as const, status: r.status }
    const parsed = parsePypiIndex(await r.text())
    if (!parsed) {
      logUpstreamError('pypi', project, 'unparseable or malformed upstream index', cfg)
      return { ok: false as const, status: 0 }
    }
    cfg.pypiCache.set(project, { parsed, expiresAt: Date.now() + REGISTRY_CACHE_MS })
    evictOverCap(cfg.pypiCache, cfg.registryCacheMaxEntries)
    return { ok: true as const, parsed }
  } catch {
    return { ok: false as const, status: 0 }
  }
}

function fileDecision(cfg: Resolved, project: string, f: PypiFile, quiet = false) {
  const t = f['upload-time']
  const publishedMs = t ? Date.parse(t) : NaN
  // `project` already went through pepNormalize (PEP 503: lowercase, -_. runs collapsed); normalize the
  // allowlist entries the same way, so one written in a project's real distribution name (`PyYAML`) still
  // matches (ei0.18)
  const d = decide(
    project,
    Number.isNaN(publishedMs) ? null : publishedMs,
    cfg.now(),
    cfg.minDays,
    cfg.allowlist.pypi.map(pepNormalize),
  )
  logDecision('pypi', project, f.filename, t ?? null, d, cfg, quiet)
  return d
}

async function pypiSimple(cfg: Resolved, project: string, origin: string) {
  const idx = await fetchPypiIndex(cfg, project)
  if (!idx.ok) return refuse(idx.status === 404 ? 404 : 502, `pkg-gate: ${project}: upstream error`)
  // quiet: a refusal still logs its own line, an allow is only counted -- one summary line per index request (ei0.13)
  const counts = { allow: 0, refuse: 0, error: 0 }
  const files = idx.parsed.files
    .filter(f => {
      const d = fileDecision(cfg, project, f, true)
      counts[d.decision]++
      return d.decision === 'allow'
    })
    .map(f => ({
      ...f,
      url: `${origin}/pypi/files/${project}${pypiResolvedFileUrl(cfg, project, f).pathname}`,
    }))
  logSummary('pypi', project, counts)
  return new Response(JSON.stringify({ ...idx.parsed, files }), {
    headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' },
  })
}

const METADATA_SUFFIX = '.metadata'

/**
 * a wheel's `<url>.metadata` (PEP 658/714 core-metadata/data-dist-info-metadata): pip 25.3 GETs it with no
 * fallback whenever the index entry advertises it, so refusing it 404s a real `pip install` even though the
 * wheel itself was allowed. Gate it on the parent file's own decision, same as the file itself (ei0.9)
 */
async function pypiFile(cfg: Resolved, project: string, path: string) {
  const isMetadata = path.endsWith(METADATA_SUFFIX)
  const filePath = isMetadata ? path.slice(0, -METADATA_SUFFIX.length) : path
  const idx = await fetchPypiIndex(cfg, project)
  if (!idx.ok) return refuse(idx.status === 404 ? 404 : 502, `pkg-gate: ${project}: upstream error`)
  const file = idx.parsed.files.find(f => pypiResolvedFileUrl(cfg, project, f).pathname === filePath)
  if (!file) return refuse(404, `pkg-gate: ${project}${path} not found`)
  const d = fileDecision(cfg, project, file)
  if (d.decision !== 'allow')
    return refuse(
      404,
      `pkg-gate: ${project}/${file.filename}${isMetadata ? METADATA_SUFFIX : ''} ${ageText(d)}, minimum ${cfg.minDays}d`,
    )
  const target = pypiResolvedFileUrl(cfg, project, file, isMetadata)
  // never fetch a file URL upstream merely named (or a relative one resolved against the index, ei0.21):
  // it must be http(s) and land on the index's own upstream or the separate files upstream, or the index
  // itself could point the gate at file:// or an arbitrary host (ei0.23)
  if (!isConfiguredUpstream(target, [cfg.upstream.pypi, cfg.upstream.files])) {
    logUpstreamError('pypi', project, 'file url is not http(s) on a configured upstream', cfg)
    return refuse(
      502,
      `pkg-gate: ${project}/${file.filename}${isMetadata ? METADATA_SUFFIX : ''}: upstream error`,
    )
  }
  const b = await fetchBytes(cfg, target.toString())
  if (!b.ok)
    return refuse(
      b.status === 404 ? 404 : 502,
      `pkg-gate: ${project}/${file.filename}${isMetadata ? METADATA_SUFFIX : ''}: upstream error`,
    )
  return new Response(b.buf)
}

async function handlePypi(cfg: Resolved, path: string, origin: string): Promise<Response> {
  if (path.startsWith('simple/')) {
    const project = pepNormalize(decodeURIComponent(path.slice('simple/'.length).replace(/\/$/, '')))
    if (!project) return refuse(404, 'pkg-gate: not found')
    return pypiSimple(cfg, project, origin)
  }
  if (path.startsWith('files/')) {
    const rest = path.slice('files/'.length)
    const slash = rest.indexOf('/')
    if (slash < 0) return refuse(404, 'pkg-gate: not found')
    const project = pepNormalize(decodeURIComponent(rest.slice(0, slash)))
    return pypiFile(cfg, project, `/${rest.slice(slash + 1)}`)
  }
  return refuse(404, 'pkg-gate: not found')
}

/**
 * the gate's handler: a Go module proxy under `/go`, an npm registry under `/npm`, a PyPI simple index and
 * file host under `/pypi/simple` and `/pypi/files`, and a health check at `/healthz`. Serve it with
 * Bun.serve or `factory pkg-gate serve`.
 */
export function makeGate(cfg: GateConfig): Gate {
  const resolved = resolve(cfg)
  const handler = (async (req: Request) => {
    try {
      const url = new URL(req.url)
      if (url.pathname === '/healthz')
        return new Response(
          JSON.stringify({
            ok: true,
            minDays: resolved.minDays,
            // null until the first successful refresh (claude-factory-8ub); see refreshGoFloor's log line
            // for why a refresh did or did not change this
            goFloor: resolved.goFloor
              ? { record: resolved.goFloor.record, at: new Date(resolved.goFloor.at).toISOString() }
              : null,
            ...resolved.stats,
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      const path = url.pathname.replace(/^\/+/, '')
      if (path.startsWith('go/')) return await handleGo(resolved, path.slice('go/'.length))
      if (path.startsWith('npm/')) return await handleNpm(resolved, path.slice('npm/'.length), url.origin)
      if (path.startsWith('pypi/')) return await handlePypi(resolved, path.slice('pypi/'.length), url.origin)
      return refuse(404, 'pkg-gate: not found')
    } catch (err) {
      // a malformed request (bad percent-encoding in decodeURIComponent, say) is a client error, not a pass
      // or a crash: an uncaught throw here would otherwise surface Bun's dev-mode HTML error page (source and
      // stack included) straight to the caller, uncounted in `resolved.stats` (ei0.15). Never echo the
      // exception's own message in the body: it can carry upstream-supplied content (ei0.20), so the body is
      // always one of two fixed strings, and the one audit line that matters goes to the log instead, by name
      // only (never a URL or query string, same as `logDecision`).
      resolved.stats.error++
      const isMalformedRequest = err instanceof URIError
      console.log(
        JSON.stringify({
          decision: 'error',
          reason: isMalformedRequest ? 'URIError' : ((err as Error)?.name ?? 'Error'),
        }),
      )
      return isMalformedRequest
        ? refuse(400, 'pkg-gate: malformed request')
        : refuse(502, 'pkg-gate: internal error')
    }
  }) as Gate
  handler.stats = () => ({ ...resolved.stats })
  handler.minDays = resolved.minDays
  return handler
}

/** the default, real registries a production gate fronts; `factory pkg-gate serve` overrides these by env */
export const DEFAULT_UPSTREAM: Upstream = {
  go: 'https://proxy.golang.org',
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  files: 'https://files.pythonhosted.org',
  // proxy.golang.org answers 404 on every /sumdb/sum.golang.org/* path (claude-factory-1hc). So the gate
  // calls sum.golang.org and index.golang.org directly, not through the proxy. This upstream serves two
  // jobs: the Go first-logged check (claude-factory-8ub) and the client-facing /go/sumdb/* passthrough
  // (handleGo, claude-factory-1hc).
  sumdb: 'https://sum.golang.org',
  goIndex: 'https://index.golang.org',
}

/** serves `makeGate`'s handler with Bun.serve; the CLI's `factory pkg-gate serve` is a thin wrapper on this */
export function serve(cfg: GateConfig & { port?: number }) {
  const gate = makeGate(cfg)
  return Bun.serve({ port: cfg.port ?? 8080, fetch: gate })
}
