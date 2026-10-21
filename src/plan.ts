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
export type FindingKind = 'starved-epic' | 'goal-no-beads' | 'epic-done-open' | 'goal-no-plan' | 'file-churn'
export type Finding = {
  kind: FindingKind
  rig: string
  bead?: string
  key: string
  text: string
  file?: string
  count?: number
}
export type Proposal = { rig: string; bead?: string; change: string; why: string; key?: string }

export const CHURN_MIN = 8
export const CHURN_SINCE = '48.hours'
export const CHURN_MAX = 5
export const CHURN_IGNORE = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'Cargo.lock',
  'flake.lock',
  'uv.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'CHANGELOG.md',
]
export type RigPlan = { items: PlanItem[]; findings: Finding[] }
export type Plan = { at: number; rigs: Record<string, RigPlan>; proposals: Proposal[] }

/** The pm's answer for one rig, before `rankPlan` checks it against the real candidates. */
export type AnswerItem = { id: string; why?: string }

/** A plan older than this is stale. dispatch() and the patrol prompt then use today's order. */
export const PLAN_FRESH_MS = 2 * 60 * 60_000

/** A bead with no priority sorts into the lowest band (4, backlog). It never sorts ahead of a prioritized bead. */
const prio = (b: Pick<Bead, 'priority'>) => b.priority ?? 4

// Covers C0 (minus \n \r \t) and DEL, plus C1 controls (incl. U+0085 NEL, U+009B 8-bit CSI --
// a VT500-family parser such as xterm or xterm.js treats U+009B as CSI, the same pane escape
// injection an ESC filter closes), U+2028/U+2029 (line/paragraph separator) and the Unicode
// bidi overrides/isolates U+202A-U+202E/U+2066-U+2069 (a Trojan Source reorder of displayed
// text) (claude-factory-dun.26).
const stripControl = (s: string) =>
  s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Cleans untrusted bead text, such as a Linear-synced title or a pm-proposed `why`.
 * The clean text fits on one line in the pane, the patrol prompt, `factory plan` output, or a
 * filed bead's own text.
 *
 * `stripControl` keeps `\n`, `\r` and `\t`. One of these can still fake an extra line in
 * `planSection`'s or `planShowText`'s one-line-per-item format.
 * `sanitize` strips control characters first.
 * Next, it turns each run of `\n`, `\r` or `\t` into one space.
 * Last, it clips the text to `n` characters (claude-factory-dun.23).
 */
export function sanitize(s: string, n = 160): string {
  return clip(
    stripControl(s)
      .replace(/[\n\r\t]+/g, ' ')
      .trim(),
    n,
  )
}

/** An 8-character stable key for a goal-shaped finding. A goal-shaped finding names no single bead. */
export const hashOf = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

/**
 * `factory plan set`'s dedupe key for one proposal. A proposal that names a bead keys on
 * `rig:bead`: the pm runs cold each hour, with no memory of what it proposed before, so the same
 * change in new words must still match the key of an already-filed bead. Hashing `change`+`why`
 * instead, as the key for a bead-naming proposal once did, let a reworded repeat file a new
 * human-labeled bead every hour, up to 3 per rig per turn (claude-factory-dun.19).
 *
 * A proposal that names no bead (a rig- or goal-wide change) still keys on a hash of `change` and
 * `why`, since there is no bead id to key on instead.
 *
 * Trade-off (claude-factory-dun.22): `hasMetadata` (src/beads.ts) checks this key with `bd list
 * --all`. This command also matches a closed bead. So, once a person answers or closes one
 * proposal filed on bead X, `plan set` drops every later proposal on X, for good, even a
 * different change. This is by design. It stops hourly spam. A later reader must not read it as
 * a bug. */
export function proposalKey(rig: string, p: Pick<Proposal, 'bead' | 'change' | 'why' | 'key'>): string {
  if (p.key) return p.key
  return p.bead ? `proposal:${rig}:${p.bead}` : `proposal:${rig}:${hashOf(`${p.change}\n${p.why}`)}`
}

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
    const why = sanitize(String(a.why ?? ''), 120)
    whyOf.set(a.id, why ? why : '(no reason given)')
  }
  const rank = new Map(order.map((id, i) => [id, i]))
  return candidates
    .map((c, i) => ({ c, i, r: rank.get(c.id) ?? Infinity }))
    .sort((a, b) => prio(a.c) - prio(b.c) || a.r - b.r || a.i - b.i)
    .slice(0, 10)
    .map(({ c }) => ({
      id: c.id,
      title: sanitize(c.title),
      priority: prio(c),
      why: whyOf.get(c.id) ?? '(no reason given)',
    }))
}

/** Checks the shape of one finding. `kind`, `key` and `text` must each be a string.
 *
 * A hand-edited or truncated `plan.json` can leave a finding as `null`, or as some other shape.
 * `isValidRigPlan` once checked only that `findings` is an array, and so passed `findings:
 * [null]`. `planShowText`, `planSection` (mod/hooks/view.ts) and `rigsView` (mod/hooks/views.tsx)
 * then read `f.key` and `f.text` on `null`, and threw (claude-factory-dun.20). */
function isValidFinding(x: unknown): x is Finding {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.kind === 'string' && typeof o.key === 'string' && typeof o.text === 'string'
}

/** Checks the shape of one rig's plan. `items` and `findings` must both be arrays. Each item must
 * have a string `id`, a string `title`, a string `why` and a finite `priority`. Each finding must
 * pass `isValidFinding`.
 *
 * A hand-edited or truncated `plan.json` can leave a rig entry as `{}` or some other shape.
 * Without this check, `orderByPlan` and `planShowText` (`factory plan`) throw on
 * `.items.map`/`.items.slice` (claude-factory-dun.18).
 *
 * The caller (`isValidPlanShape`, src/cli.ts) treats a plan with any malformed rig entry as no
 * plan at all, the same as a missing or corrupt file. */
export function isValidRigPlan(x: unknown): x is RigPlan {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const o = x as Record<string, unknown>
  return (
    Array.isArray(o.items) &&
    o.items.every(
      it =>
        !!it &&
        typeof it === 'object' &&
        typeof (it as Partial<PlanItem>).id === 'string' &&
        typeof (it as Partial<PlanItem>).title === 'string' &&
        typeof (it as Partial<PlanItem>).why === 'string' &&
        Number.isFinite((it as Partial<PlanItem>).priority),
    ) &&
    Array.isArray(o.findings) &&
    o.findings.every(isValidFinding)
  )
}

/** Looks up one rig's plan by name, the way `dispatch()` and the console do.
 *
 * Returns `undefined` when `plan` is absent, or when the plan never mentions this rig.
 *
 * A plain `plan.rigs[name]` lookup is not safe here. `rigs` is a JSON-parsed plain object. Give
 * it a name like `constructor` or `toString` (an `Object.prototype` member) that the plan never
 * mentions, and the lookup still finds that inherited function, not `undefined`. `orderByPlan`
 * then throws on `.items.map` of a function (claude-factory-dun.18). `Object.hasOwn` checks the
 * plan's own key first, so it does not make this mistake. */
export function rigPlanOf(p: Plan | undefined, name: string): RigPlan | undefined {
  if (!p || !Object.hasOwn(p.rigs, name)) return undefined
  return p.rigs[name]
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
const isDeferred = (b: Pick<Bead, 'status'>) => b.status === 'deferred'
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
  churn: Record<string, number> = {},
): Finding[] {
  const live = liveBeadIds instanceof Set ? liveBeadIds : new Set(liveBeadIds)
  const starveMs = starveHours * 3_600_000
  const out: Finding[] = []

  for (const epic of every) {
    if (isClosed(epic)) continue // the epic itself must still be open for either finding
    if (isDeferred(epic)) continue // a person already set this epic aside: not a finding (claude-factory-dun.14)
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
          text: `${epic.id} "${sanitize(epic.title)}": every child is closed, but the epic is still open`,
        })
      continue
    }
    // open but deferred children are also a person's own decision, not neglect: an epic whose
    // open children are all deferred is not starved (claude-factory-dun.14)
    const activeKids = openKids.filter(k => !isDeferred(k))
    if (!activeKids.length) continue
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
        text: `${epic.id} "${sanitize(epic.title)}" (P${epicPriority}) has had no progress in ${Math.round((now - lastProgress) / 3_600_000)}h while lower-priority work shipped`,
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
  const hot = Object.entries(churn)
    .filter(([f, n]) => n >= CHURN_MIN && !CHURN_IGNORE.includes(f.split('/').pop()!))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, CHURN_MAX)
  for (const [file, count] of hot)
    out.push({
      kind: 'file-churn',
      rig,
      key: `file-churn:${rig}:${hashOf(file)}`,
      text: `${sanitize(file, 200)} changed in ${count} merged PRs in 48 hours`,
      file: sanitize(file, 200),
      count,
    })
  return out
}

/** `churnProposals` turns each file-churn finding into a proposal that asks the person a design
 * question. The fixed `key` hides the count, so a new count never files a second bead. */
export function churnProposals(found: Finding[]): Proposal[] {
  return found
    .filter(f => f.kind === 'file-churn' && f.file && f.count !== undefined)
    .map(f => ({
      rig: f.rig,
      change: `design question: ${f.file} changed in ${f.count} merged PRs in 48 hours; split it, change its ownership, or accept the churn?`,
      why: `${f.file} was in ${f.count} merged PRs in the last 48 hours. Many PRs on one file often show a missing seam.`,
      key: `proposal:${f.rig}:file-churn:${hashOf(f.file!)}`,
    }))
}

/** `churnCounts` reads `git log --merges --name-only --format=@%H` output.
 * It counts each path once for each commit. */
export function churnCounts(out: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const block of out.split(/^@.*$/m))
    for (const f of new Set(block.split('\n').filter(Boolean))) counts[f] = (counts[f] ?? 0) + 1
  return counts
}

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
