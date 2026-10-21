import { parentOf } from './beads'

export type FilingBead = {
  id: string
  title?: string
  parent?: string
  status?: string
  created_by?: string
  created_at?: string
}

/** The run and station in a factory worker's `created_by` (`factory/<run>/<station>`). Gives
 * undefined for anything else, such as a person. */
export function filingActor(created_by?: string): { run?: string; station?: string } | undefined {
  if (!created_by || !/^factory(\/|$)/.test(created_by)) return undefined
  const [, run, station] = created_by.split('/')
  return { ...(run && { run }), ...(station && { station }) }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** The cluster a bead belongs to: its parent id, else the title before the first `:` or `(`,
 * else the first two words of the title. */
export function clusterKey(b: FilingBead): string {
  const title = b.title ?? ''
  const parent = parentOf({ ...b, title })
  if (parent) return parent
  const head = /[:(]/.test(title) ? slug(title.split(/[:(]/)[0] ?? '') : ''
  return head || slug(title).split('-').slice(0, 2).join('-') || 'untitled'
}

export type FilingVerdict = {
  id: string
  cluster: string
  station?: string
  kept: boolean
  held?: 'cluster' | 'station'
}

/**
 * The filing flood guard (claude-factory-nwlh.1).
 * Only beads that a factory worker filed (`filingActor`) get a verdict.
 * Inside `windowMs`, a cluster keeps at most `clusterCap` beads. A run/station keeps at most
 * `stationCap`. The oldest beads stay first.
 * A held bead uses no slot. A closed bead gets a verdict and uses a slot.
 * A bead with no `created_at` counts as filed at `now`.
 * ponytail: the station cap has the same window, so a run that lives more than 24h can file 3 more.
 */
export function filingGuard(
  beads: FilingBead[],
  now: number,
  opts: { clusterCap?: number; stationCap?: number; windowMs?: number } = {},
): FilingVerdict[] {
  const { clusterCap = 6, stationCap = 3, windowMs = 24 * 60 * 60 * 1000 } = opts
  const used = new Map<string, number>()
  const take = (k: string) => used.get(k) ?? 0
  return beads
    .flatMap(b => {
      const actor = filingActor(b.created_by)
      if (!actor) return []
      const at = b.created_at ? new Date(b.created_at).getTime() : now
      const station = actor.run && actor.station ? `${actor.run}/${actor.station}` : undefined
      return now - at < windowMs ? [{ b, at, station, cluster: clusterKey(b) }] : []
    })
    .sort((x, y) => x.at - y.at || (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0))
    .map(({ b, station, cluster }) => {
      const ck = `c:${cluster}`
      const sk = `s:${station}`
      const clusterFull = take(ck) >= clusterCap
      const stationFull = station !== undefined && take(sk) >= stationCap
      const kept = !clusterFull && !stationFull
      if (kept) {
        used.set(ck, take(ck) + 1)
        if (station) used.set(sk, take(sk) + 1)
      }
      return {
        id: b.id,
        cluster,
        ...(station && { station }),
        kept,
        ...(!kept && { held: clusterFull ? ('cluster' as const) : ('station' as const) }),
      }
    })
}
