// What herdr's sidebar shows for the factory: a $factory token on each run's workspace (its station and
// what holds it) and one on the manager's (the rollup). Pure: the runner reports what this returns.
import type { Bead } from './beads'
import type { Row } from './cli'
import { ownerStep } from '../mod/hooks/view'

/** why a run waits on someone, or null while it moves on its own */
export function hold(r: Row): 'needs you' | 'stuck' | 'parked' | null {
  if (r.gate) return 'needs you'
  if (r.agent === 'blocked') return 'needs you' // a worker stopped at a prompt
  if (r.sub === 'stuck') return 'stuck'
  if (r.sub === 'waiting' && r.last?.node === r.node && r.last?.outcome === 'blocked') return 'parked'
  return null
}

const isLive = (r: Row) => r.node && r.node !== 'done' && r.node !== 'aborted'

/** one run's line, e.g. "deploy · parked" or "implement · working" */
export function runText(r: Row) {
  const state =
    hold(r) ??
    (r.sub === 'waiting' && r.wakeAt ? `waits ${new Date(r.wakeAt).toTimeString().slice(0, 5)}` : 'working')
  return `${r.node} · ${state}`
}

/** the $factory token for each run's workspace, and the manager's rollup */
export function tokens(rows: Row[]) {
  const live = rows.filter(isLive)
  const byWs: Record<string, string> = {}
  for (const r of live) if (r.ws) byWs[r.ws] = runText(r)
  const count = (h: string) => live.filter(r => hold(r) === h).length
  const rollup = [
    `${live.filter(r => !hold(r) && r.sub === 'working').length} running`,
    count('needs you') && `${count('needs you')} need you`,
    count('stuck') && `${count('stuck')} stuck`,
    count('parked') && `${count('parked')} parked`,
  ]
    .filter(Boolean)
    .join(' · ')
  return { byWs, rollup }
}

const ORDER = ['needs you', 'stuck', 'parked'] as const
const ago = (ms: number) =>
  ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`

const stepOf = (r: Row) => ownerStep(r.gate?.question ?? r.error ?? r.last?.summary ?? '')

/** the ship queue as status shows it: the ship run and station, then the queue, next PR first */
export function shipLines(queue: Bead[], run?: { id: string; node: string }) {
  if (!queue.length && !run) return []
  const next = queue[0]
  return [
    `  ship: ${run ? `${run.id} at ${run.node}` : 'no ship run live'}, ${queue.length} queued${next ? `, next ${next.metadata?.ship_pr ?? '-'} (${next.id})` : ''}`,
    ...queue.slice(1).map(b => `    then ${b.metadata?.ship_pr ?? '-'} (${b.id})`),
  ]
}

/**
 * every run that waits on someone, by rig, with what it waits on and how to answer: one pass for the person.
 * Each rig with a ship queue names its next PR to merge. Every owner-only step ("parked, waiting on:") from
 * every rig is listed once, together, at the end.
 */
export function waiting(rows: Row[], now: number, queues: Record<string, Bead[]> = {}) {
  const held = rows
    .filter(isLive)
    .filter(r => hold(r))
    .sort((a, b) => ORDER.indexOf(hold(a)!) - ORDER.indexOf(hold(b)!))
  const steps = held.filter(r => stepOf(r))
  const others = held.filter(r => !stepOf(r))
  const whyOf = (r: Row) => {
    const h = hold(r)!
    const why =
      r.gate?.question ??
      (h === 'needs you'
        ? `its worker waits on a prompt in pane ${r.pane}`
        : (r.error ?? r.last?.summary ?? ''))
    return why.replace(/\s+/g, ' ').trim()
  }
  const answerOf = (r: Row) =>
    r.gate
      ? `factory decide ${r.id} <${r.gate.outcomes.join('|')}> [note]`
      : hold(r) === 'parked'
        ? `factory mail ${r.id} ${r.node} "<what changed>"`
        : hold(r) === 'stuck'
          ? `factory retry ${r.id}`
          : `herdr pane read ${r.pane}`
  const prsOf = (flat: string) => [...new Set(flat.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/g) ?? [])]
  const queued = Object.entries(queues).filter(([, q]) => q.length)
  if (!held.length && !queued.length) return 'nothing waits on you'
  const rigs = [...new Set([...others.map(r => r.rig ?? '(no rig)'), ...queued.map(([rig]) => rig)])]
  const blocks = rigs.map(rig =>
    [
      rig,
      ...(queues[rig]?.length
        ? [
            `  next to merge: ${queues[rig]![0]!.metadata?.ship_pr ?? '-'} (${queues[rig]![0]!.id}), ${queues[rig]!.length} queued`,
          ]
        : []),
      ...others
        .filter(r => (r.rig ?? '(no rig)') === rig)
        .map(r => {
          const h = hold(r)!
          const flat = whyOf(r)
          const prs = prsOf(flat)
          const answer = answerOf(r)
          const t = h === 'parked' ? r.last?.at : r.since
          return [
            `  ${r.id} ${r.node} · ${h}${t ? ` ${ago(now - t)}` : ''}${r.bead ? ` · ${r.bead}` : ''}`,
            `    ${flat.length > 400 ? `${flat.slice(0, 399)}…` : flat}`,
            ...prs.map(p => `    ${p}`),
            `    → ${answer}`,
          ].join('\n')
        }),
    ].join('\n'),
  )
  if (steps.length)
    blocks.push(
      [
        `Owner steps (${steps.length}):`,
        ...steps.map((r, i) =>
          [
            `  ${i + 1}. ${stepOf(r)}`,
            `     run ${r.id} · rig ${r.rig ?? '(no rig)'} · ${ago(now - (r.last?.at ?? r.since ?? now))}`,
            ...prsOf(whyOf(r)).map(p => `     ${p}`),
            `     → ${answerOf(r)}`,
          ].join('\n'),
        ),
      ].join('\n'),
    )
  return blocks.join('\n\n')
}
