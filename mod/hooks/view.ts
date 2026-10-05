// Pure layout helpers for the factory console: no `$`, no elements.

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
