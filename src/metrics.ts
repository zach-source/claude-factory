import { isNoWorker, isPrWait, type Entry } from './machine'

/** one run, as metrics see it. It is live from its state, or kept in metrics.jsonl after `factory
 * rm`. `requeued` is set when the run ended on a requeue edge (claude-factory-wnm). It copies
 * track.json's own field of that name. An older metrics.jsonl line has no such field. It reads as
 * `undefined`. `fate` then falls back to the node, as it did before this field existed. */
export type RunRecord = {
  id: string
  rig?: string
  node: string
  createdAt: number
  log: Entry[]
  requeued?: boolean
  /** the run's worker sessions' spend. An older metrics.jsonl line has none: it reads as [] */
  sessions?: Usage[]
}

const FAILED = new Set(['fail', 'failed', 'abandon', 'red'])
/** deploy's only outcomes that mean the change shipped; blocked, changes and hold are not a ship */
const SHIPPED_OUTCOMES = new Set(['deployed', 'unsure', 'published'])
const HOUR = 3_600_000

/** the id carries the run's creation time: `${name}-${Date.now().toString(36)}xx` */
export const createdAt = (id: string) => parseInt(id.slice(id.lastIndexOf('-') + 1, -2), 36)

export const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]!
}
export const p90 = (xs: number[]) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.9) - 1]! : null

/** the metrics.jsonl lines as records; a run with two lines (gc prune, then rm) keeps the last */
export const parseRecords = (text: string): RunRecord[] => [
  ...new Map(
    text
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as RunRecord)
      .map(r => [r.id, r] as const),
  ).values(),
]

export const inWindow = (r: RunRecord, rig: string | undefined, days: number, now = Date.now()) =>
  (!rig || r.rig === rig) && now - r.createdAt < days * 86_400_000

/** a run's fate: shipped (deploy succeeded), requeued (claude-factory-wnm, a bead moved on to
 * another factory or station), rejected (triage turned it down), closed, aborted, or where it is */
export function fate(r: RunRecord) {
  if (r.log.some(e => e.node === 'deploy' && SHIPPED_OUTCOMES.has(e.outcome))) return 'shipped'
  if (r.requeued) return 'requeued'
  if (r.log[0]?.node === 'triage' && r.log[0].outcome === 'reject') return 'rejected'
  if (r.node === 'done' && r.log.at(-1)?.outcome === 'approve') return 'handed-off' // a ship edge: the PR waits in the ship queue
  if (r.node === 'done') return 'closed'
  if (r.node === 'aborted') return 'aborted'
  return `running@${r.node}`
}

/** a failure's kind: the machine's own reasons are fixed text, a worker's are free text */
export const failKind = (summary: string) =>
  /^no report within/.test(summary)
    ? 'timeout'
    : /^(the )?worker never started/.test(summary)
      ? 'not started'
      : /stopped without reporting|gone/.test(summary)
        ? 'worker lost'
        : /block|waiting|operator decision|owner/i.test(summary)
          ? 'blocked'
          : 'other'

// claude-factory-6as.4: matches a triage reject summary that says the work already shipped
// (through another PR, another bead, or on its own) before triage saw it. The dispatch
// pre-check (claude-factory-6as) now stops most of these before a run starts. This regex
// measures what is left, against the 2026-10-13..16 baseline: 30 of 319 triage visits (9.4%).
export const ALREADY_DONE =
  /already (fixed|shipped|done|merged)|\bduplicate\b|supersed|nothing left to do|landed in/i

export function metrics(records: RunRecord[]) {
  const fates: { [k: string]: number } = {}
  const stations: {
    [k: string]: { visits: number; failed: number; outcomes: { [k: string]: number }; hours: number[] }
  } = {}
  const fails: { [k: string]: number } = {}
  const cycle: number[] = []
  const smallCycle: number[] = []
  const gateWait: number[] = []
  let reviewLoops = 0
  let triageAlreadyDone = 0
  let runsWith3PlusReviewRounds = 0
  let capReplans = 0
  let implementPassesShipped = 0
  let smallRuns = 0
  for (const r of records) {
    const f = fate(r)
    fates[f] = (fates[f] ?? 0) + 1
    // claude-factory-wnn.5: a small run is one where triage sent the work to `small`, at any
    // attempt, since a fail retry or a blocked park can log before that entry does.
    const isSmall = r.log.some(e => e.node === 'triage' && e.outcome === 'small')
    // quick can send the work to the full loop at plan: that run's ship time is not a small number.
    const wentFull = r.log.some(e => e.node === 'quick' && e.outcome === 'full')
    if (isSmall) smallRuns++
    let prev = r.createdAt
    let reviewChanges = 0
    for (let i = 0; i < r.log.length; i++) {
      const e = r.log[i]!
      // a no-worker entry (isNoWorker: a pre-launch PR park or a routed outcome) spent no worker: skip it so it is not a station visit,
      // and leave prev at the entry before it so the next real visit's wait time is still correct
      if (isNoWorker(e)) continue
      const s = (stations[e.node] ??= { visits: 0, failed: 0, outcomes: {}, hours: [] })
      s.visits++
      s.outcomes[e.outcome] = (s.outcomes[e.outcome] ?? 0) + 1
      s.hours.push((e.at - prev) / HOUR)
      if (FAILED.has(e.outcome)) {
        s.failed++
        const k = failKind(e.summary)
        fails[k] = (fails[k] ?? 0) + 1
      }
      // ponytail: a gate's wait is its station's time; gates are named approve in every factory so far
      if (e.node === 'approve') gateWait.push((e.at - prev) / HOUR)
      // claude-factory-wnn: `check` is the small route's combined verify+review station. It sends
      // work back the same way `review`'s `changes` outcome does. Count it the same way here, and
      // below in the round-cap metric.
      if ((e.node === 'review' || e.node === 'check') && e.outcome === 'changes') {
        reviewLoops++
        reviewChanges++
      }
      // claude-factory-qgz AC9: count only the machine's own round-cap re-plan (Entry.replan), not
      // a review-then-plan pair a manager goto makes after a stuck hold or a review fail (review
      // round 1 finding .8: those write no log entry of their own, but still sit next to 'plan')
      if (e.replan) capReplans++
      if (e.node === 'triage' && e.outcome === 'reject' && ALREADY_DONE.test(e.summary)) triageAlreadyDone++
      prev = e.at
    }
    if (reviewChanges >= 3) runsWith3PlusReviewRounds++
    const shipped = r.log.find(e => e.node === 'deploy' && SHIPPED_OUTCOMES.has(e.outcome))
    if (shipped) {
      const hours = (shipped.at - r.createdAt) / HOUR
      cycle.push(hours)
      if (isSmall && !wentFull) smallCycle.push(hours)
      implementPassesShipped += r.log.filter(
        e => e.node === 'implement' && e.outcome !== 'handoff' && e.outcome !== 'blocked' && !isPrWait(e),
      ).length
    }
  }
  const ended = (fates.shipped ?? 0) + (fates.rejected ?? 0) + (fates.closed ?? 0) + (fates.aborted ?? 0)
  // a pre-launch PR park (isPrWait) spent no worker, so it is not a deploy session
  const deploySessions = records.reduce(
    (n, r) => n + r.log.filter(e => e.node === 'deploy' && !isNoWorker(e)).length,
    0,
  )
  return {
    runs: records.length,
    fates,
    shipRate: ended ? (fates.shipped ?? 0) / ended : null,
    hoursToShip: { median: median(cycle), p90: p90(cycle) },
    small: { runs: smallRuns, hoursToShip: { median: median(smallCycle), p90: p90(smallCycle) } },
    approveWaitHours: { median: median(gateWait), p90: p90(gateWait) },
    reviewLoops,
    deploySessionsPerShippedRun: fates.shipped ? deploySessions / fates.shipped : null,
    triageAlreadyDone,
    runsWith3PlusReviewRounds,
    implementPassesPerShippedRun: fates.shipped ? implementPassesShipped / fates.shipped : null,
    capReplans,
    fails,
    stations: Object.fromEntries(
      Object.entries(stations).map(([id, s]) => [
        id,
        { visits: s.visits, failed: s.failed, outcomes: s.outcomes, medianHours: median(s.hours) },
      ]),
    ),
  }
}

const h = (x: number | null) => (x === null ? '-' : `${x.toFixed(1)}h`)

export function render(
  m: ReturnType<typeof metrics>,
  title: string,
  precheck: { mergedPr: number; liveRun: number; failOpen?: number } = { mergedPr: 0, liveRun: 0 },
) {
  const triageRejects = m.stations.triage?.outcomes.reject ?? 0
  const triageVisits = m.stations.triage?.visits ?? 0
  const lines = [
    `${title}: ${m.runs} runs, ${Object.entries(m.fates)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    `  ship rate ${m.shipRate === null ? '-' : `${Math.round(m.shipRate * 100)}%`} of ended runs` +
      `, to ship ${h(m.hoursToShip.median)} median / ${h(m.hoursToShip.p90)} p90` +
      `, waiting on approve ${h(m.approveWaitHours.median)} median / ${h(m.approveWaitHours.p90)} p90`,
    `  deploy sessions per shipped run ${m.deploySessionsPerShippedRun === null ? '-' : m.deploySessionsPerShippedRun.toFixed(2)}`,
    `  small runs ${m.small.runs}, to ship ${h(m.small.hoursToShip.median)} median / ${h(m.small.hoursToShip.p90)} p90`,
    `  review sent work back ${m.reviewLoops}x; failures: ${
      Object.entries(m.fails)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
    `  3+ review rounds ${m.runsWith3PlusReviewRounds} runs; cap re-plans ${m.capReplans}; ` +
      `implement passes per shipped run ${m.implementPassesPerShippedRun === null ? '-' : m.implementPassesPerShippedRun.toFixed(2)}`,
    `  triage rejects ${triageRejects} of ${triageVisits} (${m.triageAlreadyDone} already done); ` +
      `dispatch skipped ${precheck.mergedPr + precheck.liveRun} (merged-pr ${precheck.mergedPr}, live-run ${precheck.liveRun}), ` +
      `gh fail-open ${precheck.failOpen ?? 0}`,
    '  station      visits  failed  median  outcomes',
  ]
  for (const [id, s] of Object.entries(m.stations))
    lines.push(
      `  ${id.padEnd(12)} ${String(s.visits).padStart(6)}  ${String(s.failed).padStart(6)}  ${h(s.medianHours).padStart(6)}  ${Object.entries(
        s.outcomes,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    )
  return lines.join('\n')
}

/** one line of HOME/precheck.jsonl: a dispatch pre-check hit, or a fail-open skip (kind: 'skip') */
export type PrecheckLine = { at: number; rig: string; bead: string; kind: string; evidence: string }

/** reads HOME/precheck.jsonl: one JSON object a line. This drops a malformed line, not an error. */
export function parsePrecheckLines(text: string): PrecheckLine[] {
  const out: PrecheckLine[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      continue // a partial write mid-append; the next pass's line still parses
    }
  }
  return out
}

/** counts dispatch pre-check skips by kind. A fail-open row (kind 'skip') is not a skip: the run
 * still started. claude-factory-6as.8: `failOpen` counts those rows on their own. `factory
 * metrics` can then show how often `gh` failed or timed out, apart from how often the check caught
 * a hit. */
export function precheckStats(lines: Pick<PrecheckLine, 'kind'>[]) {
  let mergedPr = 0
  let liveRun = 0
  let failOpen = 0
  for (const l of lines) {
    if (l.kind === 'merged-pr') mergedPr++
    else if (l.kind === 'live-run') liveRun++
    else if (l.kind === 'skip') failOpen++
  }
  return { skipped: mergedPr + liveRun, mergedPr, liveRun, failOpen }
}

/** one line of HOME/launches.jsonl: a worker launch, with the harness and model it ran */
export type LaunchLine = {
  at: number
  run: string
  rig: string
  node: string
  seq: number
  harness: string
  model: string
  resume: boolean
}

/** reads HOME/launches.jsonl: this drops a malformed line and a line with no station or harness */
export const parseLaunchLines = (text: string) =>
  (parsePrecheckLines(text) as unknown as LaunchLine[]).filter(
    l => typeof l?.node === 'string' && typeof l.harness === 'string',
  )

/** launches per station, by "harness model" */
export function launchStats(lines: Pick<LaunchLine, 'node' | 'harness' | 'model'>[]) {
  const out: Record<string, Record<string, number>> = {}
  for (const l of lines) {
    const key = `${l.harness} ${l.model ?? '?'}`
    const station = (out[l.node] ??= {})
    station[key] = (station[key] ?? 0) + 1
  }
  return out
}

/** one line a station: its launches by harness and model; empty when there are none */
export const renderLaunches = (stats: ReturnType<typeof launchStats>) =>
  Object.entries(stats)
    .map(
      ([node, by]) =>
        `${node}: ${Object.keys(by)
          .sort()
          .map(k => `${k} ${by[k]}`)
          .join(', ')}`,
    )
    .join('\n')

/** one Claude worker session's spend with one model, from its transcript. `input` is the fresh
 * input, `cacheWrite` the cache creation and `cacheRead` the cache hits: their prices differ.
 * `peak` is the biggest context one turn re-sent. */
export type Usage = {
  node: string
  seq: number
  session: string
  model: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  turns: number
  peak: number
}

/**
 * a transcript's spend, one row for each model. Claude Code writes a turn once per content block,
 * under one message id, so each id counts once. The session's subagent transcripts (`subs`) add their
 * tokens under their own model; they leave `turns` and `peak` alone.
 */
export function sessionOf(
  lines: string[],
  run: string,
  nodeOfSeq: (seq: number) => string,
  session = '',
  subs: string[][] = [],
): Usage[] {
  const rows = new Map<string, Usage>()
  let node = '?'
  let seq = 0
  const add = (ls: string[], main: boolean) => {
    const seen = new Set<string>()
    for (const line of ls) {
      if (!line) continue
      let e: {
        type?: string
        message?: { id?: string; model?: string; content?: unknown; usage?: Record<string, number> }
      }
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (main && node === '?' && e.type === 'user') {
        const text =
          typeof e.message?.content === 'string' ? e.message.content : JSON.stringify(e.message?.content)
        const m = new RegExp(`${run} (\\d+) <outcome>`).exec(text ?? '') // the brief's report line names its seq
        if (m) {
          seq = Number(m[1])
          node = nodeOfSeq(seq)
        }
      }
      const u = e.message?.usage
      if (e.type !== 'assistant' || !u || seen.has(e.message!.id ?? '')) continue
      seen.add(e.message!.id ?? '')
      const model = e.message?.model ?? '?'
      const r = rows.get(model) ?? {
        node,
        seq,
        session,
        model,
        input: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        turns: 0,
        peak: 0,
      }
      rows.set(model, r)
      r.input += u.input_tokens ?? 0
      r.cacheWrite += u.cache_creation_input_tokens ?? 0
      r.cacheRead += u.cache_read_input_tokens ?? 0
      r.output += u.output_tokens ?? 0
      if (main) {
        r.turns++
        r.peak = Math.max(
          r.peak,
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        )
      }
    }
  }
  add(lines, true)
  for (const sub of subs) add(sub, false)
  return [...rows.values()].map(r => ({ ...r, node, seq })) // the brief line can come after the first turn
}

const NUMS = ['input', 'cacheWrite', 'cacheRead', 'output', 'turns', 'peak'] as const

/**
 * the usage rows an AX worker sent with its report. The laptop does not trust the VM: its agent can
 * write its own outbox. Keep at most 20 rows. Keep only well-formed rows. Take node and seq from the
 * laptop's own record of the task. A bad or missing value gives fewer rows, never an error.
 */
export function validUsage(raw: unknown, node: string, seq: number): Usage[] {
  if (!Array.isArray(raw) || raw.length > 20) return []
  return raw.flatMap((r: Record<string, unknown> | null) => {
    if (!r || typeof r !== 'object') return []
    const { model, session } = r
    if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(model)) return []
    if (typeof session !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(session)) return []
    const n = NUMS.map(k => r[k])
    if (!n.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e12)) return []
    return [{ node, seq, session, model, ...Object.fromEntries(NUMS.map((k, i) => [k, n[i]])) } as Usage]
  })
}

/**
 * one codex station's spend from the lines of its rollout file. The last `token_count` event holds
 * the running totals, so take that one and never sum. `input_tokens` includes the cached ones;
 * `output_tokens` includes the reasoning ones. The function skips bad lines. No usable event gives null.
 */
export function codexUsageOf(lines: string[], file: string): Omit<Usage, 'node' | 'seq'> | null {
  let session: string | null = null
  let model = 'codex'
  let total: Record<string, unknown> | null = null
  let turns = 0
  let peak = 0
  let prev = -1
  for (const line of lines) {
    let e: { type?: string; payload?: Record<string, any> }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const p = e?.payload
    if (!p || typeof p !== 'object') continue
    if (e.type === 'session_meta' && !session && typeof p.id === 'string') session = p.id
    else if (e.type === 'turn_context' && typeof p.model === 'string') model = p.model
    else if (e.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      total = p.info.total_token_usage
      const t = Number(total!.total_tokens)
      if (t > prev) turns++
      prev = Math.max(prev, t)
      peak = Math.max(peak, Number(p.info.last_token_usage?.input_tokens) || 0)
    }
  }
  if (!total) return null
  session ??= /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? null
  if (!session) return null
  const n = (k: string) => (total![k] as number) ?? 0
  const cached = n('cached_input_tokens')
  return {
    session,
    model,
    input: Math.max(0, n('input_tokens') - cached),
    cacheWrite: n('cache_write_input_tokens'),
    cacheRead: cached,
    output: n('output_tokens'),
    turns,
    peak,
  }
}

/** a Usage row's tokens, all types */
export const tokensOf = (u: Usage) => u.input + u.cacheWrite + u.cacheRead + u.output

const mtok = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`

export type StoredUsage = Usage & { run: string }
/** one manager subagent turn (or one dream), from manager-usage.jsonl */
export type ManagerUsage = {
  name: string
  at: number
  model: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  turns?: number
  peak?: number
}

/** USD per million tokens, by model family. A cache write costs 1.25x the input price, a cache read 0.1x */
export const PRICES: Record<string, { in: number; out: number }> = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
}

type Tok = { input: number; cacheWrite: number; cacheRead: number; output: number }

/** the estimate in USD; null for a model that is in no family of PRICES */
export function costOf(t: Tok, model: string) {
  const family = Object.keys(PRICES).find(k => model.toLowerCase().includes(k))
  if (!family) return null
  const p = PRICES[family]!
  return (t.input * p.in + t.cacheWrite * p.in * 1.25 + t.cacheRead * p.in * 0.1 + t.output * p.out) / 1e6
}

/** the share of the context a turn re-sent that came from the cache; null when there was no context */
export const hitRate = (t: Tok) => {
  const context = t.input + t.cacheWrite + t.cacheRead
  return context ? t.cacheRead / context : null
}

type Sum = Tok & { sessions: number; turns: number; peak: number; cost: number; unpriced: number }

/** the totals of some rows. `cost` adds only the models that have a price; `unpriced` counts the rest */
function sumOf(
  rows: (Tok & { model: string; turns?: number; peak?: number })[],
  sessions = rows.length,
): Sum {
  const s: Sum = {
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    sessions,
    turns: 0,
    peak: 0,
    cost: 0,
    unpriced: 0,
  }
  for (const r of rows) {
    s.input += r.input
    s.cacheWrite += r.cacheWrite
    s.cacheRead += r.cacheRead
    s.output += r.output
    s.turns += r.turns ?? 0
    s.peak = Math.max(s.peak, r.peak ?? 0)
    const c = costOf(r, r.model)
    if (c === null) s.unpriced++
    else s.cost += c
  }
  return s
}
const allOf = (t: Tok) => t.input + t.cacheWrite + t.cacheRead + t.output
const sessionsIn = (rows: StoredUsage[]) => new Set(rows.map(u => `${u.run}\0${u.session}`)).size

/**
 * everything `factory metrics --tokens` shows, from the stored rows only: totals, each station and model
 * (with the tokens of a shipped run), and each manager name
 */
export function tokensReport(rows: StoredUsage[], shipped: Set<string>, manager: ManagerUsage[] = []) {
  const runs = new Set(rows.map(u => u.run))
  const total = sumOf(rows, sessionsIn(rows))
  const inShipped = rows.filter(u => shipped.has(u.run))
  const group = <T extends Tok & { model: string; turns?: number; peak?: number }>(
    xs: T[],
    key: (x: T) => string,
  ) => [...Map.groupBy(xs, key)].map(([k, v]) => ({ key: k, rows: v }))
  return {
    runs: runs.size,
    shippedRuns: shipped.size,
    total: { ...total, tokens: allOf(total), hitRate: hitRate(total) },
    tokensPerRun: allOf(total) / Math.max(1, runs.size),
    tokensPerShippedRun: shipped.size ? allOf(sumOf(inShipped)) / shipped.size : null,
    stations: group(rows, u => `${u.node}\0${u.model}`)
      .map(g => {
        const [node, model] = g.key.split('\0') as [string, string]
        const sum = sumOf(g.rows, sessionsIn(g.rows))
        const ship = sumOf(g.rows.filter(u => shipped.has(u.run)))
        return {
          node,
          model,
          ...sum,
          tokens: allOf(sum),
          hitRate: hitRate(sum),
          cost: costOf(sum, model),
          perShippedRun: shipped.size ? allOf(ship) / shipped.size : null,
        }
      })
      .sort((a, b) => b.tokens - a.tokens),
    manager: group(manager, m => `${m.name}\0${m.model}`)
      .map(g => {
        const [name, model] = g.key.split('\0') as [string, string]
        const sum = sumOf(g.rows)
        return { name, model, ...sum, tokens: allOf(sum), hitRate: hitRate(sum), cost: costOf(sum, model) }
      })
      .sort((a, b) => b.tokens - a.tokens),
  }
}

const pct = (r: number | null) => (r === null ? '-' : `${Math.round(r * 100)}%`)
const usd = (c: number | null) => (c === null ? '-' : `$${c.toFixed(2)}`)

/** the text of `tokensReport`: totals with cache hit rate and cost, a table by station and model, the manager's names */
export function renderTokens(rows: StoredUsage[], shipped: Set<string>, manager: ManagerUsage[] = []) {
  const r = tokensReport(rows, shipped, manager)
  const t = r.total
  const lines = [
    `tokens: ${mtok(t.tokens)} over ${t.sessions} worker sessions in ${r.runs} runs; ${mtok(r.tokensPerRun)} a run, ${r.tokensPerShippedRun === null ? '-' : mtok(r.tokensPerShippedRun)} a shipped run`,
    `  input ${mtok(t.input)}  cache write ${mtok(t.cacheWrite)}  cache read ${mtok(t.cacheRead)}  output ${mtok(t.output)}; cache hit rate ${pct(t.hitRate)}; cost ~${usd(t.cost)}${t.unpriced ? ` (${t.unpriced} rows of an unknown model not priced)` : ''}`,
    '  station      model                  sessions   tokens  input  c.write  c.read  output  hit    cost  /shipped run  turns/session  peak context',
  ]
  for (const s of r.stations)
    lines.push(
      `  ${s.node.padEnd(12)} ${s.model.padEnd(22)} ${String(s.sessions).padStart(7)}  ${mtok(s.tokens).padStart(7)}  ${mtok(s.input).padStart(5)}  ${mtok(s.cacheWrite).padStart(7)}  ${mtok(s.cacheRead).padStart(6)}  ${mtok(s.output).padStart(6)}  ${pct(s.hitRate).padStart(3)}  ${usd(s.cost).padStart(7)}  ${(s.perShippedRun === null ? '-' : mtok(s.perShippedRun)).padStart(12)}  ${String(Math.round(s.turns / Math.max(1, s.sessions))).padStart(13)}  ${`${Math.round(s.peak / 1000)}k`.padStart(12)}`,
    )
  if (r.manager.length) {
    lines.push(
      '',
      'manager sessions:',
      '  name       model                  rows    tokens  input  c.write  c.read  output  hit    cost',
    )
    for (const m of r.manager)
      lines.push(
        `  ${m.name.padEnd(10)} ${m.model.padEnd(22)} ${String(m.sessions).padStart(5)}  ${mtok(m.tokens).padStart(7)}  ${mtok(m.input).padStart(5)}  ${mtok(m.cacheWrite).padStart(7)}  ${mtok(m.cacheRead).padStart(6)}  ${mtok(m.output).padStart(6)}  ${pct(m.hitRate).padStart(3)}  ${usd(m.cost).padStart(7)}`,
      )
  }
  return lines.join('\n')
}
