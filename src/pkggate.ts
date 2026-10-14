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
}

function resolve(cfg: GateConfig): Resolved {
  return {
    upstream: cfg.upstream,
    minDays: cfg.minDays ?? 4,
    allowlist: cfg.allowlist ?? [],
    now: cfg.now ?? (() => Date.now()),
    fetch: cfg.fetch ?? fetch,
    stats: { allow: 0, refuse: 0, error: 0 },
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
    const r = await fetchText(cfg, `${cfg.upstream.go}/${path}`)
    if (!r.ok) return refuse(502, 'pkg-gate: sumdb upstream error')
    return new Response(r.text)
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

/**
 * the gate's handler: a Go module proxy under `/go`, an npm registry under `/npm`, a PyPI simple index and
 * file host under `/pypi/simple` and `/pypi/files`. Serve it with Bun.serve or `factory pkg-gate serve`.
 */
export function makeGate(cfg: GateConfig): Gate {
  const resolved = resolve(cfg)
  const handler = (async (req: Request) => {
    const path = new URL(req.url).pathname.replace(/^\/+/, '')
    if (path.startsWith('go/')) return handleGo(resolved, path.slice('go/'.length))
    return refuse(404, 'pkg-gate: not found')
  }) as Gate
  handler.stats = () => ({ ...resolved.stats })
  handler.minDays = resolved.minDays
  return handler
}
