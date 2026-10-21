import { LABEL, REJECTED, SHIP, isOwned, type Bead } from './beads'
import { sweepFiler } from './sweeps'

/** the label an auto-queued bead gets, next to `factory` */
export const AUTO_LABEL = 'auto-queued'
const HOUR = 3_600_000
const HELD = [REJECTED, SHIP, 'owner', 'human']

/** a rig's `autoQueue` setting: off when absent. `minPriority` is the lowest urgency taken (0 is P0). */
export type AutoQueue = { minPriority: number; perHour: number }

/** `rig.autoQueue`, or undefined when it is absent or malformed (a hand-edited rigs.json): then it is off */
export const autoQueueOf = (rig: { autoQueue?: unknown }): AutoQueue | undefined => {
  const c = rig.autoQueue as Partial<AutoQueue> | undefined
  return c && Number.isFinite(c.minPriority) && Number.isFinite(c.perHour) && c.perHour! >= 1
    ? (c as AutoQueue)
    : undefined
}

/** the pick times (ms) that still count against the cap: the last rolling hour */
export const recentPicks = (history: number[], now: number) => history.filter(t => now - t < HOUR)

const isLeaf = (b: Bead, parents: Set<string>) =>
  !b.parent && !b.assignee && b.issue_type !== 'epic' && !parents.has(b.id)

const isHeld = (b: Bead, excluded: Set<string>) =>
  excluded.has(b.id) ||
  !!sweepFiler(b) ||
  !!b.labels?.some(l => l === LABEL || HELD.includes(l)) ||
  isOwned(b)

const age = (b: Bead) => Date.parse(b.created_at ?? '') || 0

/**
 * Which unlabeled ready beads a rig takes into its queue. Pure: it reads nothing and writes nothing.
 * It takes a leaf only (no parent, no open child, not an epic), with no assignee, priority at or
 * above `minPriority`, and not held back (rejected, owner, human, ship, sweep-filed, flood-guard held).
 * The best come first: priority, then oldest. At most `min(room, perHour - picks in the last hour)`.
 * `parents` is the set of ids that have an open child; `history` is this rig's earlier pick times.
 */
export function autoPick(
  ready: Bead[],
  now: number,
  history: number[],
  cfg: AutoQueue | undefined,
  room: number,
  parents: Set<string> = new Set(),
  excluded: Set<string> = new Set(),
): Bead[] {
  if (!cfg) return []
  const take = Math.min(room, cfg.perHour - recentPicks(history, now).length)
  if (take <= 0) return []
  return ready
    .filter(b => isLeaf(b, parents) && !isHeld(b, excluded) && (b.priority ?? Infinity) <= cfg.minPriority)
    .sort((a, b) => a.priority! - b.priority! || age(a) - age(b))
    .slice(0, take)
}
