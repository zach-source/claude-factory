// pkg-gate: an age-gating registry proxy, so no toolchain on a VM runner -- not even one a worker's own
// `nix shell nixpkgs#go -c ...` brings in, which never passes through a PATH wrapper like pkg-guard -- can
// fetch a package or module version younger than the minimum age. It is the only registry host in a gated
// task's egress (see ax.ts), so enforcement is the egress strip, not this proxy's correctness alone; still,
// every decision here fails closed: an upstream error, a timeout, or a missing or unparseable publish time
// is a refusal, never a pass-through. See claude-factory-ei0 and docs/remote-runner.md's package age gate.

export type Upstream = { go: string; npm: string; pypi: string; files: string }

export type GateConfig = {
  upstream: Upstream
  /** the minimum age, in days, a version/file must have to be served (default 4, as pkg-guard used) */
  minDays?: number
  /** module/package names let through regardless of age -- the person's lever, never settable from a request */
  allowlist?: string[]
  now?: () => number
  fetch?: typeof fetch
}

export type Stats = { allow: number; refuse: number; error: number }
export type Gate = ((req: Request) => Promise<Response>) & { stats: () => Stats; minDays: number }

type Resolved = {
  upstream: Upstream
  minDays: number
  allowlist: string[]
  now: () => number
  fetch: typeof fetch
  stats: Stats
  /** the npm packument / PyPI index a tarball or file request reads its entry's time from, short TTL */
  npmCache: Map<string, { parsed: NpmPackument; expiresAt: number }>
  pypiCache: Map<string, { parsed: PypiIndex; expiresAt: number }>
}

const REGISTRY_CACHE_MS = 60_000

function resolve(cfg: GateConfig): Resolved {
  const minDays = cfg.minDays ?? 4
  // a non-finite or negative minDays (e.g. Number('four') === NaN) makes every `ageH < minDays * 24` comparison
  // false, which allows every version through -- fail closed instead of silently disarming the gate (ei0.10)
  if (!Number.isFinite(minDays) || minDays < 0)
    throw new Error(`pkg-gate: minDays must be a finite, non-negative number, got ${cfg.minDays}`)
  return {
    upstream: cfg.upstream,
    minDays,
    allowlist: cfg.allowlist ?? [],
    now: cfg.now ?? (() => Date.now()),
    fetch: cfg.fetch ?? fetch,
    stats: { allow: 0, refuse: 0, error: 0 },
    npmCache: new Map(),
    pypiCache: new Map(),
  }
}

type Decision = { decision: 'allow' | 'refuse' | 'error'; reason: string; ageH: number | null }

/** allowlisted, or old enough; a missing or unparseable time is a refusal, same as one still too young */
function decide(name: string, publishedMs: number | null, now: number, minDays: number, allowlist: string[]): Decision {
  const ageH = publishedMs == null ? null : (now - publishedMs) / 3_600_000
  if (allowlist.includes(name)) return { decision: 'allow', reason: 'allowlisted', ageH }
  if (ageH == null) return { decision: 'refuse', reason: 'missing or unparseable publish time', ageH: null }
  if (ageH < minDays * 24) return { decision: 'refuse', reason: `published ${Math.floor(ageH)}h ago, minimum ${minDays}d`, ageH }
  return { decision: 'allow', reason: 'old enough', ageH }
}

/** one JSON line per decision on stdout: no auth headers or query strings, ever */
function logDecision(eco: string, name: string, version: string | undefined, published: string | null, d: Decision, cfg: Resolved) {
  cfg.stats[d.decision]++
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

function refuse(status: number, text: string) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } })
}

async function fetchText(cfg: Resolved, url: string): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  try {
    const r = await cfg.fetch(url)
    const text = await r.text()
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, text }
  } catch {
    return { ok: false, status: 0 }
  }
}

async function fetchBytes(cfg: Resolved, url: string): Promise<{ ok: true; buf: ArrayBuffer } | { ok: false; status: number }> {
  try {
    const r = await cfg.fetch(url)
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, buf: await r.arrayBuffer() }
  } catch {
    return { ok: false, status: 0 }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Go module proxy protocol (https://go.dev/ref/mod#goproxy-protocol): list, .info, .mod, .zip, @latest, sumdb.
// A module path keeps whatever case-encoding (`!x`) it arrived with; it is only ever matched and forwarded,
// never decoded, so it reaches upstream exactly as Go sent it.

function parseGoInfo(text: string): { version: string; time: string } | null {
  try {
    const j = JSON.parse(text)
    return typeof j.Version === 'string' && typeof j.Time === 'string' ? { version: j.Version, time: j.Time } : null
  } catch {
    return null
  }
}

/**
 * fetches `<mod>/@v/<version>.info` and decides: `ok:false` is an upstream fetch error (non-2xx, timeout),
 * always refused with no decision possible; JSON that is missing or unparseable is a decision of its own
 * (`decide` with no publish time), refused the same as a version that is simply too young
 */
async function goDecideVersion(cfg: Resolved, mod: string, version: string) {
  const r = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@v/${version}.info`)
  if (!r.ok) {
    logDecision('go', mod, version, null, { decision: 'error', reason: `upstream .info: ${r.status || 'timeout'}`, ageH: null }, cfg)
    return { ok: false as const }
  }
  const parsed = parseGoInfo(r.text)
  const publishedMs = parsed ? Date.parse(parsed.time) : NaN
  const d = decide(mod, Number.isNaN(publishedMs) ? null : publishedMs, cfg.now(), cfg.minDays, cfg.allowlist)
  logDecision('go', mod, parsed?.version ?? version, parsed?.time ?? null, d, cfg)
  return { ok: true as const, info: r.text, time: parsed?.time, decision: d }
}

function ageText(d: Decision) {
  return d.ageH == null ? 'unknown publish time' : `published ${Math.floor(d.ageH)}h ago`
}

async function goVersion(cfg: Resolved, mod: string, version: string, ext: 'info' | 'mod' | 'zip') {
  const r = await goDecideVersion(cfg, mod, version)
  if (!r.ok) return refuse(502, `pkg-gate: ${mod}@${version}: upstream error`)
  if (r.decision.decision === 'refuse') return refuse(404, `pkg-gate: ${mod}@${version} ${ageText(r.decision)}, minimum ${cfg.minDays}d`)
  if (ext === 'info') return new Response(r.info, { headers: { 'content-type': 'application/json' } })
  const b = await fetchBytes(cfg, `${cfg.upstream.go}/${mod}/@v/${version}.${ext}`)
  if (!b.ok) return refuse(502, `pkg-gate: ${mod}@${version}.${ext}: upstream error`)
  return new Response(b.buf, { headers: { 'content-type': ext === 'zip' ? 'application/zip' : 'text/plain; charset=utf-8' } })
}

async function goList(cfg: Resolved, mod: string) {
  const r = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@v/list`)
  if (!r.ok) return refuse(502, `pkg-gate: ${mod}: upstream error`)
  const versions = r.text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  const kept: string[] = []
  for (const v of versions) {
    const d = await goDecideVersion(cfg, mod, v)
    if (d.ok && d.decision.decision === 'allow') kept.push(v)
  }
  return new Response(kept.length ? kept.join('\n') + '\n' : '', { headers: { 'content-type': 'text/plain' } })
}

async function goLatest(cfg: Resolved, mod: string) {
  const latest = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@latest`)
  if (latest.ok) {
    const parsed = parseGoInfo(latest.text)
    if (parsed) {
      const publishedMs = Date.parse(parsed.time)
      const d = decide(mod, Number.isNaN(publishedMs) ? null : publishedMs, cfg.now(), cfg.minDays, cfg.allowlist)
      logDecision('go', mod, parsed.version, parsed.time, d, cfg)
      if (d.decision === 'allow') return new Response(latest.text, { headers: { 'content-type': 'application/json' } })
    } else {
      logDecision('go', mod, undefined, null, { decision: 'error', reason: 'unparseable @latest', ageH: null }, cfg)
    }
  }
  // the real latest is too young (or unreadable): fall back to the newest version old enough
  const list = await fetchText(cfg, `${cfg.upstream.go}/${mod}/@v/list`)
  if (!list.ok) return refuse(502, `pkg-gate: ${mod}: upstream error`)
  const versions = list.text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  const candidates: { version: string; time: string }[] = []
  for (const v of versions) {
    const d = await goDecideVersion(cfg, mod, v)
    if (d.ok && d.decision.decision === 'allow' && d.time) candidates.push({ version: v, time: d.time })
  }
  candidates.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
  const top = candidates[0]
  if (!top) return refuse(404, `pkg-gate: ${mod}: no version old enough (minimum ${cfg.minDays}d)`)
  return new Response(JSON.stringify({ Version: top.version, Time: top.time }), { headers: { 'content-type': 'application/json' } })
}

async function handleGo(cfg: Resolved, path: string): Promise<Response> {
  if (path.startsWith('sumdb/')) {
    // bytes, never text: /tile/ bodies are raw transparency-log hash data, and go's default GOSUMDB (via
    // the proxy's /sumdb/ passthrough) fetches them -- decoding as UTF-8 and re-encoding (the old fetchText
    // + `new Response(text)`) corrupts any byte above 0x7f, which fails checksum verification (ei0.8)
    let upstream: Response
    try {
      upstream = await cfg.fetch(`${cfg.upstream.go}/${path}`)
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

function parsePackument(text: string): NpmPackument | null {
  try {
    const j = JSON.parse(text)
    return j && typeof j === 'object' && typeof j.versions === 'object' && typeof j.time === 'object' ? j : null
  } catch {
    return null
  }
}

/** the upstream packument, cached a short while so a tarball request need not refetch it per file */
async function fetchPackument(cfg: Resolved, pkg: string) {
  const cached = cfg.npmCache.get(pkg)
  if (cached && cached.expiresAt > Date.now()) return { ok: true as const, parsed: cached.parsed }
  try {
    const r = await cfg.fetch(`${cfg.upstream.npm}/${npmUpstreamName(pkg)}`, { headers: { accept: 'application/json' } })
    if (!r.ok) return { ok: false as const, status: r.status }
    const parsed = parsePackument(await r.text())
    if (!parsed) return { ok: false as const, status: 0 }
    cfg.npmCache.set(pkg, { parsed, expiresAt: Date.now() + REGISTRY_CACHE_MS })
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
  for (const v of Object.keys(p.versions)) {
    const timeStr = p.time[v]
    const publishedMs = timeStr ? Date.parse(timeStr) : NaN
    const d = decide(pkg, Number.isNaN(publishedMs) ? null : publishedMs, cfg.now(), cfg.minDays, cfg.allowlist)
    logDecision('npm', pkg, v, timeStr ?? null, d, cfg)
    if (d.decision === 'allow') kept.add(v)
  }
  const versions: Record<string, NpmVersion> = {}
  const time: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.time)) if (k === 'created' || k === 'modified' || kept.has(k)) time[k] = v
  for (const v of kept) {
    const vd = p.versions[v]!
    versions[v] = vd.dist?.tarball
      ? { ...vd, dist: { ...vd.dist, tarball: `${origin}/npm/${pkg}/-/${npmTarballFile(vd.dist.tarball)}` } }
      : vd
  }
  const distTags: Record<string, string> = {}
  for (const [tag, v] of Object.entries(p['dist-tags'] ?? {})) if (kept.has(v)) distTags[tag] = v
  const newest = [...kept].sort((a, b) => Date.parse(time[b]!) - Date.parse(time[a]!))[0]
  if (newest) distTags.latest = newest
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
    v => pack.parsed.versions[v]!.dist?.tarball && npmTarballFile(pack.parsed.versions[v]!.dist!.tarball!) === file,
  )
  if (!version) return refuse(404, `pkg-gate: ${pkg}/-/${file} not found`)
  const timeStr = pack.parsed.time[version]
  const publishedMs = timeStr ? Date.parse(timeStr) : NaN
  const d = decide(pkg, Number.isNaN(publishedMs) ? null : publishedMs, cfg.now(), cfg.minDays, cfg.allowlist)
  logDecision('npm', pkg, version, timeStr ?? null, d, cfg)
  if (d.decision !== 'allow') return refuse(404, `pkg-gate: ${pkg}@${version} ${ageText(d)}, minimum ${cfg.minDays}d`)
  const upstreamUrl = pack.parsed.versions[version]!.dist!.tarball!
  const b = await fetchBytes(cfg, upstreamUrl)
  if (!b.ok) return refuse(502, `pkg-gate: ${pkg}/-/${file}: upstream error`)
  return new Response(b.buf, { headers: { 'content-type': 'application/octet-stream' } })
}

async function handleNpm(cfg: Resolved, path: string, origin: string): Promise<Response> {
  const parsed = parseNpmPath(path)
  if (!parsed) return refuse(404, 'pkg-gate: not found')
  return parsed.kind === 'tarball' ? npmTarball(cfg, parsed.pkg, parsed.file) : npmPackument(cfg, parsed.pkg, origin)
}

// ---------------------------------------------------------------------------------------------------------
// PyPI: the PEP 691 simple index (JSON), with every file whose PEP 700 upload-time is younger than the
// minimum, or missing entirely, dropped; project names normalized per PEP 503. Files are served from a
// separate `/pypi/files` host (files.pythonhosted.org in reality), named by the index's own rewritten URLs.

type PypiFile = { filename: string; url: string; 'upload-time'?: string | null; [k: string]: unknown }
type PypiIndex = { files: PypiFile[]; [k: string]: unknown }

/** PEP 503: lowercase, runs of -_. collapsed to a single - */
const pepNormalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

function parsePypiIndex(text: string): PypiIndex | null {
  try {
    const j = JSON.parse(text)
    return j && typeof j === 'object' && Array.isArray(j.files) ? j : null
  } catch {
    return null
  }
}

/** the upstream simple index for a (PEP 503 normalized) project, cached a short while */
async function fetchPypiIndex(cfg: Resolved, project: string) {
  const cached = cfg.pypiCache.get(project)
  if (cached && cached.expiresAt > Date.now()) return { ok: true as const, parsed: cached.parsed }
  try {
    const r = await cfg.fetch(`${cfg.upstream.pypi}/simple/${project}/`, {
      headers: { accept: 'application/vnd.pypi.simple.v1+json' },
    })
    if (!r.ok) return { ok: false as const, status: r.status }
    const parsed = parsePypiIndex(await r.text())
    if (!parsed) return { ok: false as const, status: 0 }
    cfg.pypiCache.set(project, { parsed, expiresAt: Date.now() + REGISTRY_CACHE_MS })
    return { ok: true as const, parsed }
  } catch {
    return { ok: false as const, status: 0 }
  }
}

function fileDecision(cfg: Resolved, project: string, f: PypiFile) {
  const t = f['upload-time']
  const publishedMs = t ? Date.parse(t) : NaN
  const d = decide(project, Number.isNaN(publishedMs) ? null : publishedMs, cfg.now(), cfg.minDays, cfg.allowlist)
  logDecision('pypi', project, f.filename, t ?? null, d, cfg)
  return d
}

async function pypiSimple(cfg: Resolved, project: string, origin: string) {
  const idx = await fetchPypiIndex(cfg, project)
  if (!idx.ok) return refuse(idx.status === 404 ? 404 : 502, `pkg-gate: ${project}: upstream error`)
  const files = idx.parsed.files
    .filter(f => fileDecision(cfg, project, f).decision === 'allow')
    .map(f => ({ ...f, url: `${origin}/pypi/files/${project}${new URL(f.url).pathname}` }))
  return new Response(JSON.stringify({ ...idx.parsed, files }), {
    headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' },
  })
}

async function pypiFile(cfg: Resolved, project: string, path: string) {
  const idx = await fetchPypiIndex(cfg, project)
  if (!idx.ok) return refuse(idx.status === 404 ? 404 : 502, `pkg-gate: ${project}: upstream error`)
  const file = idx.parsed.files.find(f => new URL(f.url).pathname === path)
  if (!file) return refuse(404, `pkg-gate: ${project}${path} not found`)
  const d = fileDecision(cfg, project, file)
  if (d.decision !== 'allow') return refuse(404, `pkg-gate: ${project}/${file.filename} ${ageText(d)}, minimum ${cfg.minDays}d`)
  const b = await fetchBytes(cfg, `${cfg.upstream.files}${path}`)
  if (!b.ok) return refuse(502, `pkg-gate: ${project}/${file.filename}: upstream error`)
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
    const url = new URL(req.url)
    if (url.pathname === '/healthz')
      return new Response(JSON.stringify({ ok: true, minDays: resolved.minDays, ...resolved.stats }), {
        headers: { 'content-type': 'application/json' },
      })
    const path = url.pathname.replace(/^\/+/, '')
    if (path.startsWith('go/')) return handleGo(resolved, path.slice('go/'.length))
    if (path.startsWith('npm/')) return handleNpm(resolved, path.slice('npm/'.length), url.origin)
    if (path.startsWith('pypi/')) return handlePypi(resolved, path.slice('pypi/'.length), url.origin)
    return refuse(404, 'pkg-gate: not found')
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
}

/** serves `makeGate`'s handler with Bun.serve; the CLI's `factory pkg-gate serve` is a thin wrapper on this */
export function serve(cfg: GateConfig & { port?: number }) {
  const gate = makeGate(cfg)
  return Bun.serve({ port: cfg.port ?? 8080, fetch: gate })
}
