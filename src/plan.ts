// The pm's plan: pure logic only, no IO.
// The `factory plan facts|set|show` command (src/cli.ts) calls this to rank each rig's ready work.
// This module also flags starvation and plan gaps.
// dispatch() and the patrol prompt (mod/hooks/view.ts) read its output.
//
// The pm subagent has no Bash tool.
// It picks an order and a one-line why for each id that the CLI already offers.
// It proposes a change that it cannot make itself (claude-factory-dun).
import { createHash } from 'node:crypto'
import { parentOf, type Bead } from './beads'

export type PlanItem = { id: string; title: string; priority: number; why: string }
export type FindingKind = 'starved-epic' | 'goal-no-beads' | 'epic-done-open' | 'goal-no-plan'
export type Finding = { kind: FindingKind; rig: string; bead?: string; key: string; text: string }
export type Proposal = { rig: string; bead?: string; change: string; why: string }
export type RigPlan = { items: PlanItem[]; findings: Finding[] }
export type Plan = { at: number; rigs: Record<string, RigPlan>; proposals: Proposal[] }

/** The pm's answer for one rig, before `rankPlan` checks it against the real candidates. */
export type AnswerItem = { id: string; why?: string }

/** A plan older than this is stale. dispatch() and the patrol prompt then use today's order. */
export const PLAN_FRESH_MS = 2 * 60 * 60_000

/** A bead with no priority sorts into the lowest band (4, backlog). It never sorts ahead of a prioritized bead. */
const prio = (b: Pick<Bead, 'priority'>) => b.priority ?? 4

const stripControl = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** An 8-character stable key for a goal-shaped finding. A goal-shaped finding names no single bead. */
export const hashOf = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

/**
 * This function returns true when `plan.at` is a real past or present time.
 * The time must be within `PLAN_FRESH_MS`.
 * A plan that is exactly `PLAN_FRESH_MS` old is stale. The check uses `<`, not `<=`.
 *
 * A future `at` is stale. Clock skew or a hand-edited file can cause this.
 * A non-finite `at` is stale. A corrupt or missing plan can cause this.
 * The function never returns true for these cases.
 */
export function isFresh(plan: { at: number } | undefined | null, now: number): boolean {
  if (!plan || typeof plan.at !== 'number' || !Number.isFinite(plan.at)) return false
  if (plan.at > now) return false
  return now - plan.at < PLAN_FRESH_MS
}

/**
 * `rankPlan` checks the pm's answer against the real candidates. It turns the answer into the
 * ranked list for one rig. It drops an id that is not a real candidate. It also drops a repeat of
 * an id that is already placed.
 *
 * The sort key is `(priority, the pm's order inside that priority, the candidate's own order)`.
 * A candidate that the pm never mentions stays at the end of its priority band, in its own order.
 * The pm's ranking never moves a bead out of its own priority band.
 * `orderByPlan` uses this same key. So a planned P2 never passes a P1.
 *
 * The list holds at most 10 items. `rankPlan` clips each `why` to 120 characters.
 *
 * `rankPlan` also strips control characters. A missing or blank `why` reads "(no reason given)".
 * This text prevents an empty line in the pane.
 */
export function rankPlan(answer: AnswerItem[], candidates: Bead[]): PlanItem[] {
  const byId = new Map(candidates.map(c => [c.id, c]))
  const seen = new Set<string>()
  const order: string[] = []
  const whyOf = new Map<string, string>()
  for (const a of answer) {
    if (!a || typeof a.id !== 'string' || seen.has(a.id) || !byId.has(a.id)) continue
    seen.add(a.id)
    order.push(a.id)
    const why = stripControl(String(a.why ?? '')).trim()
    whyOf.set(a.id, why ? clip(why, 120) : '(no reason given)')
  }
  const rank = new Map(order.map((id, i) => [id, i]))
  return candidates
    .map((c, i) => ({ c, i, r: rank.get(c.id) ?? Infinity }))
    .sort((a, b) => prio(a.c) - prio(b.c) || a.r - b.r || a.i - b.i)
    .slice(0, 10)
    .map(({ c }) => ({
      id: c.id,
      title: c.title,
      priority: prio(c),
      why: whyOf.get(c.id) ?? '(no reason given)',
    }))
}

/**
 * This function sets the candidate order for `dispatch()`.
 * It returns the candidates unchanged when `rigPlan` is absent.
 * A plan is absent when there is no plan, or when it is stale.
 * The caller uses `isFresh` to decide that before it calls this function.
 *
 * Otherwise, the function uses the same sort key as `rankPlan`.
 * It sorts the live candidate list, not the plan's own top 10.
 * A candidate that the plan ranked goes first inside its own priority band, in the plan's order.
 *
 * Every other candidate keeps its own (bd) order after them.
 * A planned P2 never passes a real P1, because priority always sorts first.
 */
export function orderByPlan(candidates: Bead[], rigPlan: { items: PlanItem[] } | undefined): Bead[] {
  if (!rigPlan) return candidates
  const rank = new Map(rigPlan.items.map((it, i) => [it.id, i]))
  return candidates
    .map((c, i) => ({ c, i, r: rank.get(c.id) ?? Infinity }))
    .sort((a, b) => prio(a.c) - prio(b.c) || a.r - b.r || a.i - b.i)
    .map(({ c }) => c)
}

const isClosed = (b: Pick<Bead, 'status'>) => b.status === 'closed'
const tsOf = (iso?: string) => {
  if (!iso) return undefined
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : undefined
}
const childrenOf = (every: Bead[], id: string) => every.filter(b => parentOf(b) === id)

const goalKey = (kind: FindingKind, rig: string, goal: string) => `${kind}:${rig}:${hashOf(goal)}`

/** `epic-done-open` and `goal-no-plan`: a plan gap the factory itself can act on (start the children,
 * or notice nothing is ranked). Filed as an unlabeled bead: a person triages it like any other. */
export function goalNoPlanFinding(rig: string, goal: string): Finding {
  return {
    kind: 'goal-no-plan',
    rig,
    key: goalKey('goal-no-plan', rig, goal),
    text: `${rig}'s goal has no ranked work to act on: "${clip(goal, 100)}"`,
  }
}

/**
 * Starvation and plan-gap findings for one rig, from its full bead list (`bd list --all --brief
 * --json`, closed beads included) and the bead ids any live run there owns right now. An "epic" is
 * any bead with at least one child; both findings below already require at least one child, so a
 * bead's `issue_type` need not be checked separately.
 *
 * `starved-epic`: an open epic with at least one open child, whose last progress (the latest
 * `started_at`/`closed_at` among all its children, or its own `created_at` with none) is at least
 * `starveHours` old, while some other bead (not its own child) at a numerically higher (so lower-
 * value) priority closed after that point. The owner's example: a P1 epic sits at 0/5 for 25 hours
 * while a P2 bead ships elsewhere.
 *
 * `epic-done-open`: an open epic whose children (at least one) are all closed, unless a live run
 * owns that epic right now (its release is mid-flight, not stuck).
 *
 * `goal-no-beads`: the rig has a goal and no open bead without children (no leaf work driving it
 * at all, even one blocked or unlabeled). `goal-no-plan` (above) is different: it fires when the
 * plan's own ranked list came up empty, which can happen even with open leaf beads (all claimed,
 * blocked, or missing the `factory` label); `buildPlan` adds it once ranking is known, not here.
 */
export function findings(
  rig: string,
  goal: string | undefined,
  every: Bead[],
  liveBeadIds: string[] | Set<string>,
  now: number,
  starveHours = 24,
): Finding[] {
  const live = liveBeadIds instanceof Set ? liveBeadIds : new Set(liveBeadIds)
  const starveMs = starveHours * 3_600_000
  const out: Finding[] = []

  for (const epic of every) {
    if (isClosed(epic)) continue // the epic itself must still be open for either finding
    const kids = childrenOf(every, epic.id)
    if (!kids.length) continue
    const openKids = kids.filter(k => !isClosed(k))
    if (!openKids.length) {
      if (!live.has(epic.id))
        out.push({
          kind: 'epic-done-open',
          rig,
          bead: epic.id,
          key: `epic-done-open:${rig}:${epic.id}`,
          text: `${epic.id} "${epic.title}": every child is closed, but the epic is still open`,
        })
      continue
    }
    const progress = kids.flatMap(k =>
      [tsOf(k.closed_at), tsOf(k.started_at)].filter((t): t is number => t !== undefined),
    )
    const lastProgress = progress.length ? Math.max(...progress) : (tsOf(epic.created_at) ?? now)
    if (now - lastProgress < starveMs) continue
    const epicPriority = prio(epic)
    const kidIds = new Set(kids.map(k => k.id))
    const lowerShippedSince = every.some(
      b =>
        b.id !== epic.id &&
        !kidIds.has(b.id) &&
        isClosed(b) &&
        prio(b) > epicPriority &&
        (tsOf(b.closed_at) ?? -Infinity) > lastProgress,
    )
    if (lowerShippedSince)
      out.push({
        kind: 'starved-epic',
        rig,
        bead: epic.id,
        key: `starved-epic:${rig}:${epic.id}`,
        text: `${epic.id} "${epic.title}" (P${epicPriority}) has had no progress in ${Math.round((now - lastProgress) / 3_600_000)}h while lower-priority work shipped`,
      })
  }

  if (goal) {
    const hasOpenLeaf = every.some(b => !isClosed(b) && !childrenOf(every, b.id).length)
    if (!hasOpenLeaf)
      out.push({
        kind: 'goal-no-beads',
        rig,
        key: goalKey('goal-no-beads', rig, goal),
        text: `${rig}'s goal has no open bead driving it: "${clip(goal, 100)}"`,
      })
  }
  return out
}

/** `starved-epic` and `goal-no-beads` ask a person for more scope or attention: filed labeled
 * `human`, an Interview-tab decision item. `epic-done-open` and `goal-no-plan` are gaps the factory
 * can act on by itself (start the children, notice nothing is ranked): filed unlabeled instead. */
export const HUMAN_FINDING_KINDS: ReadonlySet<FindingKind> = new Set(['starved-epic', 'goal-no-beads'])

/** one rig's input for `buildPlan`: its candidates (dispatch's own ready list), its full bead
 * list (for findings) and the ids any live run there owns, plus the pm's raw answer for it */
export type RigInput = {
  name: string
  goal?: string
  candidates: Bead[]
  every: Bead[]
  liveBeadIds: string[]
  answer: AnswerItem[]
}

/** `factory plan set`'s one call: ranks every rig, runs its findings, and adds `goal-no-plan` for
 * a rig whose goal ended up with nothing ranked (which `findings` alone cannot tell, since it runs
 * before ranking). The caller supplies `proposals` as-is: `rankPlan`'s own validation does not
 * apply to them, since `factory plan set` checks and files each one by hand (claude-factory-dun.2). */
export function buildPlan(now: number, rigsIn: RigInput[], proposals: Proposal[], starveHours = 24): Plan {
  const rigs: Record<string, RigPlan> = {}
  for (const r of rigsIn) {
    const items = rankPlan(r.answer, r.candidates)
    const found = findings(r.name, r.goal, r.every, r.liveBeadIds, now, starveHours)
    if (r.goal && items.length === 0) found.push(goalNoPlanFinding(r.name, r.goal))
    rigs[r.name] = { items, findings: found }
  }
  return { at: now, rigs, proposals }
}
