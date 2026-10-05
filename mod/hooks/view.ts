// Pure layout helpers for the factory console: no `$`, no elements.
import type { FactoryMail, FactoryRun } from '../types'

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

/**
 * The manager's loop: what to wake this session's model with, or null when nothing calls for it.
 * New mail and newly blocked workers wake it at once; `isDue` adds a heartbeat while any worker runs.
 * `keys` are the blocked workers this patrol reports, for the caller to remember in `seen`.
 */
export function patrol(
  runs: readonly FactoryRun[],
  mail: readonly FactoryMail[],
  seen: ReadonlySet<string>,
  isDue: boolean,
) {
  const live = runs.filter(r => r.node && r.node !== 'done' && r.node !== 'aborted')
  const blocked = live.filter(r => r.agent === 'blocked' && !seen.has(blockKey(r)))
  const isWorking = live.some(r => r.sub === 'working' && !r.gate)
  if (!mail.length && !blocked.length && !(isDue && isWorking)) return null
  const news = [
    ...mail.map(m => `- ${m.run} / ${m.from}: ${m.text}`),
    ...blocked.map(r => `- ${r.id} / ${r.node}: its worker (pane ${r.pane}) is waiting on a prompt`),
  ]
  const board = live.map(
    r =>
      `- ${r.id}${r.rig ? ` (rig ${r.rig})` : ''} at ${r.node}/${r.sub}${r.gate ? ', awaiting the person' : ''}: ${line(r.goal ?? '', 100)}`,
  )
  const text = [
    '[factory] patrol',
    news.length
      ? `New:\n${news.join('\n')}`
      : 'Heartbeat: nothing new was reported. Check that every working station is making progress.',
    `Board:\n${board.join('\n')}`,
  ].join('\n')
  return { text, keys: blocked.map(blockKey) }
}
