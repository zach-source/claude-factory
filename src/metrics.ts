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
}

const FAILED = new Set(['fail', 'failed', 'abandon', 'red'])
/** deploy's only outcomes that mean the change shipped; blocked, changes and hold are not a ship */
const SHIPPED_OUTCOMES = new Set(['deployed', 'published'])
const HOUR = 3_600_000

/** the id carries the run's creation time: `${name}-${Date.now().toString(36)}xx` */
export const createdAt = (id: string) => parseInt(id.slice(id.lastIndexOf('-') + 1, -2), 36)

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]!
}
const p90 = (xs: number[]) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.9) - 1]! : null

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

/** one Claude worker session's spend, from its transcript */
export type Session = { run: string; node: string; turns: number; tokens: number; out: number; peak: number }

/**
 * a transcript's spend: every turn re-sends its context (input, cache writes and reads) and adds its output.
 * Claude Code writes a turn once per content block, under one message id, so each id counts once
 */
export function sessionOf(lines: string[], run: string, nodeOfSeq: (seq: number) => string): Session {
  const seen = new Set<string>()
  const s: Session = { run, node: '?', turns: 0, tokens: 0, out: 0, peak: 0 }
  for (const line of lines) {
    if (!line) continue
    let e: { type?: string; message?: { id?: string; content?: unknown; usage?: Record<string, number> } }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (s.node === '?' && e.type === 'user') {
      const text =
        typeof e.message?.content === 'string' ? e.message.content : JSON.stringify(e.message?.content)
      const m = new RegExp(`${run} (\\d+) <outcome>`).exec(text ?? '') // the brief's report line names its seq
      if (m) s.node = nodeOfSeq(Number(m[1]))
    }
    const u = e.message?.usage
    if (e.type !== 'assistant' || !u || seen.has(e.message!.id ?? '')) continue
    seen.add(e.message!.id ?? '')
    const context =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    s.turns++
    s.tokens += context + (u.output_tokens ?? 0)
    s.out += u.output_tokens ?? 0
    s.peak = Math.max(s.peak, context)
  }
  return s
}

const mtok = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`

/** tokens by station, and per run and per shipped run */
export function renderTokens(sessions: Session[], shipped: Set<string>) {
  const total = sessions.reduce((a, s) => a + s.tokens, 0)
  const runs = new Set(sessions.map(s => s.run))
  const ofShipped = sessions.filter(s => shipped.has(s.run)).reduce((a, s) => a + s.tokens, 0)
  const lines = [
    `tokens: ${mtok(total)} over ${sessions.length} worker sessions in ${runs.size} runs; ${mtok(total / Math.max(1, runs.size))} a run, ${shipped.size ? mtok(ofShipped / shipped.size) : '-'} a shipped run`,
    '  station      sessions   tokens  median/session  turns/session  peak context',
  ]
  const by = Map.groupBy(sessions, s => s.node)
  for (const [node, ss] of [...by].sort(
    (a, b) => b[1].reduce((x, s) => x + s.tokens, 0) - a[1].reduce((x, s) => x + s.tokens, 0),
  ))
    lines.push(
      `  ${node.padEnd(12)} ${String(ss.length).padStart(8)}  ${mtok(ss.reduce((a, s) => a + s.tokens, 0)).padStart(7)}  ${mtok(median(ss.map(s => s.tokens))!).padStart(14)}  ${String(Math.round(ss.reduce((a, s) => a + s.turns, 0) / ss.length)).padStart(13)}  ${`${Math.round(Math.max(...ss.map(s => s.peak)) / 1000)}k`.padStart(12)}`,
    )
  return lines.join('\n')
}
