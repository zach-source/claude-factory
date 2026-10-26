// One state for each bead, and the text of `factory digest`. These functions do no I/O.
import { LABEL, REJECTED, SHIP, type Bead } from './beads'
import type { PrFact } from './repairs'

export type BeadState =
  | 'unowned'
  | 'queued'
  | 'running'
  | 'waiting-on-owner'
  | 'in-ship'
  | 'shipped-not-closed'
  | 'rejected-open'
  | 'deferred'
  | 'done'

export type StateCtx = {
  /** bead id to its live run: `blocked` when the run waits on the owner, `why` is what it asks */
  live: Map<string, { blocked: boolean; why?: string; since?: number }>
  /** the rig's pull requests, any state */
  prs: PrFact[]
}

const prOf = (b: Bead, ctx: StateCtx) => ctx.prs.find(p => p.url === String(b.metadata?.ship_pr ?? ''))
const has = (b: Bead, label: string) => !!b.labels?.includes(label)

/** where a bead stands. The first rule that fits wins. */
export function stateOf(b: Bead, ctx: StateCtx): BeadState {
  if (b.status === 'closed') return 'done'
  if (b.status === 'deferred') return 'deferred'
  const run = ctx.live.get(b.id)
  if (run) return run.blocked ? 'waiting-on-owner' : 'running'
  if (has(b, SHIP)) return prOf(b, ctx)?.state === 'MERGED' ? 'shipped-not-closed' : 'in-ship'
  if (has(b, REJECTED)) return 'rejected-open'
  if (has(b, 'owner')) return 'waiting-on-owner'
  return has(b, LABEL) || b.labels?.some(l => l.startsWith('factory:')) ? 'queued' : 'unowned'
}

/** the stage of a queued PR: `unknown` when the PR is not in the list */
export function shipSub(b: Bead, ctx: StateCtx): 'draft' | 'ready' | 'unknown' {
  const pr = prOf(b, ctx)
  return !pr ? 'unknown' : pr.isDraft ? 'draft' : 'ready'
}

export const countsOf = (bs: Bead[], ctx: StateCtx) => {
  const out: Partial<Record<BeadState, number>> = {}
  for (const b of bs) {
    const s = stateOf(b, ctx)
    out[s] = (out[s] ?? 0) + 1
  }
  return out
}

export type DigestRig = {
  name: string
  /** `owner/name`, or undefined when the forge has no `gh pr merge` */
  slug?: string
  beads: Bead[]
  ctx: StateCtx
  /** the rig's ship queue, next PR first */
  queue: Bead[]
}
export type RepairLog = { at: string; rig: string; id: string; kind: string; reason: string }

const age = (ms: number) => {
  const h = Math.floor(ms / 3_600_000)
  return h >= 24 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(0, Math.floor(ms / 60_000))}m`
}
const flat = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160)

/** what waits on the owner in one rig: the bead, its priority, its age and what it asks */
export function ownerQueue(r: DigestRig, now: number) {
  return r.beads
    .filter(b => stateOf(b, r.ctx) === 'waiting-on-owner')
    .map(b => {
      const run = r.ctx.live.get(b.id)
      const since = run?.since ?? Date.parse(b.created_at ?? '')
      return `  ${b.id} P${b.priority ?? '-'} ${Number.isFinite(since) ? age(now - since) : '-'} ${flat(run?.why || b.title)}`
    })
}

/** the merge lines of one rig: open PRs that are not drafts, in ship order */
export const mergeLines = (r: DigestRig) =>
  r.queue.flatMap(b => {
    const pr = r.ctx.prs.find(p => p.url === String(b.metadata?.ship_pr ?? ''))
    return pr?.state === 'OPEN' && !pr.isDraft && r.slug
      ? [`  gh pr merge ${pr.number} -R ${r.slug} --merge  # ${b.id}`]
      : []
  })

/** the whole text of `factory digest` */
export function digestText(rigs: DigestRig[], recent: RepairLog[], now: number): string {
  const blocks = rigs.map(r => {
    const counts = Object.entries(countsOf(r.beads, r.ctx))
      .filter(([s]) => s !== 'done')
      .map(([s, n]) => `${s} ${n}`)
    const owner = ownerQueue(r, now)
    const merge = mergeLines(r)
    return [
      `${r.name}: ${counts.join(', ') || 'no open beads'}`,
      ...(owner.length ? ['owner queue:', ...owner] : []),
      ...(merge.length ? ['ready to merge, in order:', ...merge] : []),
    ].join('\n')
  })
  const fixes = recent.map(l => `  ${l.at.slice(0, 16)} ${l.rig} ${l.kind} ${l.id}: ${l.reason}`)
  return [...blocks, ...(fixes.length ? [['recent repairs:', ...fixes].join('\n')] : [])].join('\n\n')
}
