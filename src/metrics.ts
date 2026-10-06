import type { Entry } from './machine'

/** one run as metrics see it: live from its state, or kept in metrics.jsonl after factory rm */
export type RunRecord = { id: string; rig?: string; node: string; createdAt: number; log: Entry[] }

const FAILED = new Set(['fail', 'failed', 'abandon', 'red'])
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

/** a run's fate: shipped (deploy succeeded), rejected (triage turned it down), closed, aborted, or where it is */
export function fate(r: RunRecord) {
  if (r.log.some(e => e.node === 'deploy' && !FAILED.has(e.outcome))) return 'shipped'
  if (r.log[0]?.node === 'triage' && r.log[0].outcome === 'reject') return 'rejected'
  if (r.node === 'done') return 'closed'
  if (r.node === 'aborted') return 'aborted'
  return `running@${r.node}`
}

/** a failure's kind: the machine's own reasons are fixed text, a worker's are free text */
export const failKind = (summary: string) =>
  /^no report within/.test(summary)
    ? 'timeout'
    : /stopped without reporting|gone/.test(summary)
      ? 'worker lost'
      : /block|waiting|operator decision|owner/i.test(summary)
        ? 'blocked'
        : 'other'

export function metrics(records: RunRecord[]) {
  const fates: { [k: string]: number } = {}
  const stations: {
    [k: string]: { visits: number; failed: number; outcomes: { [k: string]: number }; hours: number[] }
  } = {}
  const fails: { [k: string]: number } = {}
  const cycle: number[] = []
  const gateWait: number[] = []
  let reviewLoops = 0
  for (const r of records) {
    const f = fate(r)
    fates[f] = (fates[f] ?? 0) + 1
    let prev = r.createdAt
    for (const e of r.log) {
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
      if (e.node === 'review' && e.outcome === 'changes') reviewLoops++
      prev = e.at
    }
    const shipped = r.log.find(e => e.node === 'deploy' && !FAILED.has(e.outcome))
    if (shipped) cycle.push((shipped.at - r.createdAt) / HOUR)
  }
  const ended = (fates.shipped ?? 0) + (fates.rejected ?? 0) + (fates.closed ?? 0) + (fates.aborted ?? 0)
  return {
    runs: records.length,
    fates,
    shipRate: ended ? (fates.shipped ?? 0) / ended : null,
    hoursToShip: { median: median(cycle), p90: p90(cycle) },
    approveWaitHours: { median: median(gateWait), p90: p90(gateWait) },
    reviewLoops,
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

export function render(m: ReturnType<typeof metrics>, title: string) {
  const lines = [
    `${title}: ${m.runs} runs, ${Object.entries(m.fates)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    `  ship rate ${m.shipRate === null ? '-' : `${Math.round(m.shipRate * 100)}%`} of ended runs` +
      `, to ship ${h(m.hoursToShip.median)} median / ${h(m.hoursToShip.p90)} p90` +
      `, waiting on approve ${h(m.approveWaitHours.median)} median / ${h(m.approveWaitHours.p90)} p90`,
    `  review sent work back ${m.reviewLoops}x; failures: ${
      Object.entries(m.fails)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
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
