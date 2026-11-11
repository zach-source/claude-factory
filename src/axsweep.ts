// The AX sweep's pure part (claude-factory-sps9): which task and workspace names on the cluster no live run owns.
import { taskName } from './ax'

/** one pass removes this many names at most; the next pass takes the rest */
export const SWEEP_CAP = 10

/** a started run of this home, as the sweep sees it */
export type SweepRun = {
  id: string
  /** the newest worker launch number the run's state records */
  seq: number
  /** the current worker's address, `ax://<task>` when it runs on ax */
  pane: string | null
  /** done or aborted */
  over: boolean
  /** the run's sub-state in state.json (working, waiting, backoff, stuck), or '' for a top-level or unreadable state */
  sub: string
}

// A run in one of these has no launch in progress: a new launch raises seq first (the `working` entry in machine.ts).
const PARKED = new Set(['waiting', 'backoff', 'stuck'])

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * the names in an `ax get tasks|workspaces` table: the first token of each row under a header line that starts
 * with NAME. No header (an error text, empty output): none. A token that is no RFC 1123 label is skipped.
 */
export function parseNames(out: string): string[] {
  const lines = out.split('\n')
  const head = lines.findIndex(l => l.trim())
  if (head < 0 || lines[head]!.trim().split(/\s+/)[0] !== 'NAME') return []
  const names: string[] = []
  for (const l of lines.slice(head + 1)) {
    const name = l.trim().split(/\s+/)[0]
    if (name && LABEL.test(name)) names.push(name)
  }
  return names
}

/**
 * the names to delete, sorted, at most SWEEP_CAP. Fail closed: a name goes only when all hold.
 * (1) it is not the manager's task. (2) it ends in `-<s>` and exactly one run's taskName(id, s) is it.
 * (3) s <= the run's seq (a higher number is a launch the state does not show yet). (4) the run is over,
 * or the run's pane is not ax://<name> and either s < seq (an older attempt) or the run is parked (sub-state
 * waiting, backoff or stuck: no launch is in progress).
 */
export function sweepNames(names: string[], runs: SweepRun[], manager: string): string[] {
  const picked = new Set<string>()
  for (const n of new Set(names)) {
    if (n === manager || n.startsWith('f-manager')) continue
    const m = /-(\d+)$/.exec(n)
    if (!m) continue
    const s = Number(m[1])
    const owners = runs.filter(r => taskName(r.id, s) === n)
    if (owners.length !== 1) continue
    const r = owners[0]!
    if (s > r.seq) continue
    if (r.over || (r.pane !== `ax://${n}` && (s < r.seq || PARKED.has(r.sub)))) picked.add(n)
  }
  return [...picked].sort().slice(0, SWEEP_CAP)
}
