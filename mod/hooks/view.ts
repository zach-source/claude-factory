// Pure layout helpers for the factory console: no `$`, no elements.
import type { FactoryMail, FactoryRig, FactoryRun } from '../types'

/** one station on a run's path: how often it ran, and whether the run is there now */
export type Stop = { id: string; runs: number; isCurrent: boolean }

/** a run's path through its graph in first-visit order, loops folded into run counts */
export function track(trail: readonly string[], current: string): Stop[] {
  const stops = new Map<string, Stop>()
  for (const id of trail) {
    const stop = stops.get(id) ?? { id, runs: 0, isCurrent: false }
    stops.set(id, { ...stop, runs: stop.runs + 1 })
  }
  if (current && current !== 'done' && current !== 'aborted')
    stops.set(current, { ...(stops.get(current) ?? { id: current, runs: 0 }), isCurrent: true })
  return [...stops.values()]
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** the last `width` samples as block characters, scaled to their peak or to `floor`, whichever is higher */
export function sparkline(values: readonly number[], width: number, floor = 1) {
  const recent = values.slice(-width)
  const peak = Math.max(floor, ...recent)
  return recent
    .map(v => BLOCKS[Math.round((v / peak) * (BLOCKS.length - 1))])
    .join('')
    .padStart(width, ' ')
}

/** a duration the way a glance wants it: 45s, 4m, 1h12m, 2d3h */
export function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`
}

/** a progress bar `width` cells wide */
export function bar(done: number, total: number, width: number) {
  const filled = total ? Math.round((done / total) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** one line of at most `max` characters */
export const line = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

export const clockOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const blockKey = (r: FactoryRun) => `${r.id}:${r.node}:${r.since}`

/** one manager message, across ticks: a run's mail is told apart by when it was sent */
export const mailKey = (m: Pick<FactoryMail, 'run' | 'at'>) => `${m.run}@${m.at}`

/** mail the person still owes an answer, and mail done with: answered in the console, or its run has ended */
export function mailTabs(
  mail: readonly FactoryMail[],
  runs: readonly FactoryRun[],
  answered: Record<string, string> = {},
) {
  const live = new Set(runs.filter(r => r.node && r.node !== 'done' && r.node !== 'aborted').map(r => r.id))
  const isDone = (m: FactoryMail) => !!answered[mailKey(m)] || !live.has(m.run)
  return { open: mail.filter(m => !isDone(m)), answered: mail.filter(isDone) }
}

/**
 * the person's quick answer to a worker's mail, and the mailbox it goes to: the asking station's, or the
 * station the run has moved on to, told what it answers. null when the run is over and nobody would read it.
 */
export function quickAnswer(
  m: FactoryMail,
  run: Pick<FactoryRun, 'node'> | undefined,
  kind: 'approve' | 'reject' | 'reply',
  note: string,
) {
  if (!run || !isRunLive(run)) return null
  const said = note.trim()
  const text =
    kind === 'approve'
      ? `The person approves: go ahead.${said ? ` ${said}` : ''}`
      : kind === 'reject'
        ? `The person rejects it: do not go ahead.${said ? ` ${said}` : ''}`
        : `The person answers: ${said}`
  const to = run.node === m.from ? m.from : run.node!
  return {
    to,
    text: to === m.from ? text : `About the ${m.from} station's message "${line(m.text, 120)}": ${text}`,
  }
}

const isRunLive = (r: Pick<FactoryRun, 'node'>) => !!r.node && r.node !== 'done' && r.node !== 'aborted'
/** a run holding a worker: neither waiting on a timer nor at a gate */
const isBusy = (r: FactoryRun) => isRunLive(r) && r.sub !== 'waiting' && !r.gate

/** one rig at a glance: its live runs by station, what needs the person, what has ended */
export function rigStats(rig: Pick<FactoryRig, 'name' | 'maxRuns'>, runs: readonly FactoryRun[]) {
  const mine = runs.filter(r => r.rig === rig.name)
  const live = mine.filter(isRunLive)
  const stations = new Map<string, number>()
  for (const r of live) stations.set(r.node!, (stations.get(r.node!) ?? 0) + 1)
  const busy = live.filter(isBusy).length
  return {
    busy,
    room: rig.maxRuns === undefined ? null : Math.max(0, rig.maxRuns - busy),
    stations: [...stations].map(([node, n]) => ({ node, n })),
    gates: live.filter(r => r.gate).map(r => r.id),
    stuck: live.filter(r => r.sub === 'stuck' || r.agent === 'blocked').map(r => r.id),
    done: mine.filter(r => r.node === 'done').length,
    aborted: mine.filter(r => r.node === 'aborted').length,
  }
}

/**
 * The manager's loop: what to wake this session's model with, or null when nothing calls for it.
 * New mail and newly blocked workers wake it at once; `isDue` adds a heartbeat while any worker runs
 * or a rig with a goal has room for more runs. `keys` are the blocked workers this patrol reports,
 * for the caller to remember in `seen`. The board and rig goals are sent only when they differ from
 * `lastBoard`, the `board` an earlier patrol returned: every patrol stays in the manager's context.
 */
export function patrol(
  runs: readonly FactoryRun[],
  mail: readonly FactoryMail[],
  seen: ReadonlySet<string>,
  isDue: boolean,
  rigs: readonly FactoryRig[] = [],
  lastBoard?: string,
) {
  const live = runs.filter(isRunLive)
  const blocked = live.filter(r => r.agent === 'blocked' && !seen.has(blockKey(r)))
  const isWorking = live.some(r => r.sub === 'working' && !r.gate)
  const busy = (g: FactoryRig) => rigStats(g, runs).busy
  const goals = rigs.filter(g => g.goal)
  const hasRoom = goals.some(g => busy(g) < (g.maxRuns ?? Infinity))
  if (!mail.length && !blocked.length && !(isDue && (isWorking || hasRoom))) return null
  const news = [
    // the whole report is a `factory show` away; a parked station's can run to pages
    ...mail.map(m => `- ${m.run} / ${m.from}: ${line(m.text, 300)}`),
    ...blocked.map(r => `- ${r.id} / ${r.node}: its worker (pane ${r.pane}) is waiting on a prompt`),
  ]
  const board = live.map(
    r =>
      `- ${r.id}${r.rig ? ` (rig ${r.rig})` : ''} at ${r.node}/${r.sub}${r.gate ? ', awaiting the person' : ''}: ${line(r.goal ?? '', 100)}`,
  )
  const state = [
    board.length ? `Board:\n${board.join('\n')}` : 'Board: no runs.',
    ...(goals.length
      ? [
          `Rig goals: with room, give each rig the next work toward its goal.\n${goals
            .map(g => `- ${g.name}, busy ${busy(g)}${g.maxRuns ? `/${g.maxRuns}` : ''}: ${g.goal}`)
            .join('\n')}`,
        ]
      : []),
  ].join('\n')
  const text = [
    '[factory] patrol',
    news.length
      ? `New:\n${news.join('\n')}`
      : 'Heartbeat: nothing new was reported. Check that every working station is making progress.',
    state === lastBoard ? 'Board and rig goals: unchanged since the last patrol.' : state,
  ].join('\n')
  return { text, keys: blocked.map(blockKey), board: state }
}
