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
