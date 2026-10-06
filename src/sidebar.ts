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
