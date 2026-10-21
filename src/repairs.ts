// Repairs in code, not in prompts: a bead whose work is plainly done or dead gets closed or
// deferred by the factory. `repairs` is pure: it decides. cli.ts's `repairPass` does the effects.
import { findings } from './plan'
import { SHIP, REJECTED, type Bead } from './beads'

export type PrFact = {
  number: number
  url: string
  state: string
  isDraft?: boolean
  body?: string
  headRefName?: string
}
export type Repair = { kind: 'close' | 'unship' | 'release'; id: string; reason: string }

/** most repairs one pass makes in one rig */
export const REPAIR_CAP = 20

const merged = (prs: PrFact[]) => prs.filter(p => p.state === 'MERGED')
const meta = (b: Bead, key: string) => String(b.metadata?.[key] ?? '')
const prOf = (prs: PrFact[], ref: string) =>
  ref ? prs.find(p => p.url === ref || p.url.endsWith(`/${ref.replace(/^#/, '')}`)) : undefined
const DONE = /already (fixed|shipped|done)|duplicate/i
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/

/** the evidence that this open bead needs no more work, or undefined */
function closeReason(b: Bead, prs: PrFact[]): string | undefined {
  const done = merged(prs)
  const shipped = prOf(done, meta(b, 'ship_pr'))
  if (shipped) return `shipped: ${shipped.url} is merged`
  // ponytail: only the bead's own ship metadata links it to a PR. A PR body can name other beads
  // (a follow-up, a related bead), so text in the body is not evidence.
  const branch = meta(b, 'ship_branch')
  const onBranch = branch ? done.find(p => p.headRefName === branch) : undefined
  if (onBranch) return `shipped: ${onBranch.url} from ${branch} is merged`
  if (!b.labels?.includes(REJECTED)) return undefined
  const why = meta(b, 'reject_reason')
  if (!DONE.test(why)) return undefined
  const pr = [...why.matchAll(/#(\d+)\b/g)].map(m => done.find(p => p.number === Number(m[1]))).find(Boolean)
  if (pr) return `rejected as already done, and ${pr.url} is merged`
  const sha = SHA.exec(why)
  return sha ? `rejected as already done, and commit ${sha[0]} is cited` : undefined
}

/** a claim that no run will release: a factory run that is not live holds it, and its lease expired.
 * A run that ends on another manager (the AX cutover) or crashes leaves one (claude-factory-wpuy). */
function staleClaim(b: Bead, now: number): string | undefined {
  const lease = b.lease_expires_at
  if (!b.assignee?.startsWith('factory/') || !lease || Date.parse(lease) >= now) return undefined
  return `${b.assignee} is not live and its lease expired at ${lease}`
}

/**
 * What to fix in one rig. `every` is the rig's whole bead list (closed too), `prs` its pull requests
 * of any state, `live` the bead ids a live run owns. A bead with a live run is never touched.
 * One action for each bead, in this order: a stale claim, merged evidence, a done epic, a ship PR
 * closed unmerged. A stale claim goes first because bd refuses to close a bead another actor holds:
 * the next pass closes it.
 */
export function repairs(rig: string, every: Bead[], prs: PrFact[], live: Set<string>, now: number): Repair[] {
  const doneEpics = new Set(
    findings(rig, undefined, every, live, now)
      .filter(f => f.kind === 'epic-done-open')
      .map(f => f.bead),
  )
  const out: Repair[] = []
  for (const b of every) {
    if (b.status === 'closed' || b.status === 'deferred' || live.has(b.id)) continue
    const stale = staleClaim(b, now)
    if (stale) {
      out.push({ kind: 'release', id: b.id, reason: stale })
      continue
    }
    const reason = closeReason(b, prs) ?? (doneEpics.has(b.id) ? 'every child is closed' : undefined)
    if (reason) {
      out.push({ kind: 'close', id: b.id, reason })
      continue
    }
    const pr = b.labels?.includes(SHIP) ? prOf(prs, meta(b, 'ship_pr')) : undefined
    if (pr?.state === 'CLOSED')
      out.push({ kind: 'unship', id: b.id, reason: `${pr.url} was closed unmerged` })
  }
  return out
}
