// What herdr's sidebar shows for the factory: a $factory token on each run's workspace (its station and
// what holds it) and one on the manager's (the rollup). Pure: the runner reports what this returns.
import type { Row } from './cli'

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

/** every run that waits on someone, by rig, with what it waits on and how to answer: one pass for the person */
export function waiting(rows: Row[], now: number) {
  const held = rows
    .filter(isLive)
    .filter(r => hold(r))
    .sort((a, b) => ORDER.indexOf(hold(a)!) - ORDER.indexOf(hold(b)!))
  if (!held.length) return 'nothing waits on you'
  const rigs = [...new Set(held.map(r => r.rig ?? '(no rig)'))]
  return rigs
    .map(rig =>
      [
        rig,
        ...held
          .filter(r => (r.rig ?? '(no rig)') === rig)
          .map(r => {
            const h = hold(r)!
            const why =
              r.gate?.question ??
              (h === 'needs you'
                ? `its worker waits on a prompt in pane ${r.pane}`
                : (r.error ?? r.last?.summary ?? ''))
            const flat = why.replace(/\s+/g, ' ').trim()
            const prs = [...new Set(flat.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/g) ?? [])]
            const answer = r.gate
              ? `factory decide ${r.id} <${r.gate.outcomes.join('|')}> [note]`
              : h === 'parked'
                ? `factory mail ${r.id} ${r.node} "<what changed>"`
                : h === 'stuck'
                  ? `factory retry ${r.id}`
                  : `herdr pane read ${r.pane}`
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
    .join('\n\n')
}
