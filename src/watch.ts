// The park watch's decisions (claude-factory-5wav). `watchPass` in cli.ts fetches the pull requests a parked
// station links. This module only decides, from plain data, so tests need no gh. A parked station wakes
// for a real change: a new head commit, a merge, a close, or a review or comment by a person. A bot
// comment, a CI status or a label changes only `updatedAt`, which is not a reason to start a worker.
import { WATCHED_PARK_MIN } from './machine'

/** a review or comment on a pull or merge request, as the watch reads it */
export type Note = {
  /** ms since the epoch */
  at: number
  /** a person (not a bot, and a member of the repository), as `isPerson` says */
  person: boolean
  /** a review that asks for changes (state CHANGES_REQUESTED) */
  changesRequested: boolean
  body: string
}

/** one pull or merge request as `watchPass` last viewed it, or null when gh/glab could not say */
export type WatchedPr = {
  url: string
  state: string
  /** GitHub: the pull request is a draft */
  isDraft?: boolean
  /** GitHub: APPROVED, REVIEW_REQUIRED, CHANGES_REQUESTED or empty */
  reviewDecision?: string
  updatedAt: string
  headRefOid?: string
  /** GitHub's merge check: MERGEABLE, CONFLICTING or UNKNOWN (not computed yet) */
  mergeable?: string
  headRefName?: string
  baseRefName?: string
  mergedAt?: string
  closedAt?: string
  notes?: Note[]
  /** GitLab: the merge request asks for changes now (detailed_merge_status requested_changes) */
  changesRequested?: boolean
}

/** what `watchPass` keeps between passes for one park (key: run id and the park's time) */
export type Seen = {
  heads: Record<string, string>
  /** isDraft and reviewDecision at the baseline, by URL */
  drafts?: Record<string, boolean>
  decisions?: Record<string, string>
  /** GitLab: the merge request asked for changes at the baseline */
  changes?: Record<string, boolean>
  routed?: boolean
  reparkedUntil?: number
}

export type Decision =
  | { kind: 'wake'; text: string; url?: string; state?: string }
  | { kind: 'hold'; text: string; url: string }
  | { kind: 'changes'; text: string; url: string; bodies: string[] }
  | { kind: 'repark'; wakeAt: number }

/** how long before its timer a park gets the fallback re-check */
export const REPARK_LEAD_MIN = 10
/** the clip of one comment body in a routed summary or a task title source */
export const BODY_CLIP = 2000

const BOT_LOGIN = /\[bot\]$|^github-actions$|^(?:project|group)_\d+_bot/i
/** REST cannot say REVIEW_REQUIRED (GraphQL did), so a baseline of REVIEW_REQUIRED equals none */
const noRequired = (d: string) => (d === 'REVIEW_REQUIRED' ? '' : d)
const MEMBER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** whether a GitHub author is a person who may steer a run. A bot has a plain login (`github-actions`)
 * and the association NONE, so the login alone cannot say: the repository association is the trust boundary. */
export const isPerson = (login: string | undefined, association: string | undefined, isBot = false) =>
  !!login && !isBot && !BOT_LOGIN.test(login) && MEMBER.has(association ?? '')

/** the notes in a `reviews` and `comments` answer in the GraphQL shape (`restNotes` maps REST onto it); a malformed entry is skipped */
export function ghNotes(json: { reviews?: unknown; comments?: unknown }): Note[] {
  type Raw = {
    author?: { login?: string; is_bot?: boolean }
    authorAssociation?: string
    body?: string
    state?: string
    submittedAt?: string
    createdAt?: string
  }
  const notes: Note[] = []
  for (const [list, kind] of [
    [json.reviews, 'review'],
    [json.comments, 'comment'],
  ] as const) {
    if (!Array.isArray(list)) continue
    for (const r of list as Raw[]) {
      const at = Date.parse((kind === 'review' ? r?.submittedAt : r?.createdAt) ?? '')
      if (!r || Number.isNaN(at)) continue
      notes.push({
        at,
        person: isPerson(r.author?.login, r.authorAssociation, r.author?.is_bot === true),
        changesRequested: kind === 'review' && r.state === 'CHANGES_REQUESTED',
        body: typeof r.body === 'string' ? r.body : '',
      })
    }
  }
  return notes
}

/** a person's note that is a change request: a review that asks for changes, or a body whose first line starts with /changes */
export const isChangeRequest = (n: Note) =>
  n.person && (n.changesRequested || /^\/changes\b/i.test(n.body.trimStart().split('\n', 1)[0] ?? ''))

const ms = (s?: string) => {
  const t = Date.parse(s ?? '')
  return Number.isNaN(t) ? 0 : t
}
/** when a pull request merged: gh gives mergedAt; a view without it falls back to updatedAt */
const mergedAt = (p: WatchedPr) => ms(p.mergedAt) || ms(p.updatedAt)
const closedAt = (p: WatchedPr) => ms(p.closedAt) || ms(p.updatedAt)

export type DecideInput = {
  prs: WatchedPr[]
  /** a gh/glab view of one of the park's pull requests failed this pass: nothing may route or re-park */
  failed: boolean
  parkedAt: number
  now: number
  /** when the park's timer starts a worker */
  wakeAt: number
  plainMin: number
  isPreLaunch: boolean
  seen?: Seen
  /** the station has these outcomes */
  canHold: boolean
  canChange: boolean
  /** mail waits in the station's box (a holdMail station): a repark would hide it, so the timer ends the park */
  held?: boolean
  /** the run's own branch (factory/<run id>): only a pull request on it gets the conflict wake */
  branch?: string
  /** the texts the station's mail box already holds from the factory */
  mailed?: string[]
}

/** the mail for a pull request that conflicts with its base: GitHub builds no CI ref for it */
export function conflictText(p: WatchedPr) {
  const base = /^[A-Za-z0-9._/-]+$/.test(p.baseRefName ?? '') ? p.baseRefName! : ''
  return (
    `[factory] ${p.url} is CONFLICTING with ${base || 'its base branch'} at head ${(p.headRefOid ?? '').slice(0, 7)}, ` +
    `so GitHub builds no pull merge ref and no CI can start. ` +
    `${base ? `Merge origin/${base}` : 'Merge its base branch'}, resolve, push.`
  )
}

const clip = (s: string) => (s.length > BODY_CLIP ? s.slice(0, BODY_CLIP) : s)

/**
 * what a watched park does now: null (stay parked), wake (start a worker with a mail), hold (closed
 * unmerged: end the run with no worker), changes (a person asked for changes: back to implement with no
 * worker) or repark (nothing changed near the timer: park again). Rule order: hold, changes, wake, repark.
 */
export function watchDecide(i: DecideInput): Decision | null {
  const { prs, parkedAt } = i
  if (!prs.length) return null
  // a route is posted and waits for the tick: post nothing more for this park
  if (i.seen?.routed) return null
  const after = (n: Note) => n.at > parkedAt
  const allClosed = prs.every(p => p.state === 'CLOSED')
  if (!i.failed && allClosed && i.canHold) {
    const closed = prs.filter(p => closedAt(p) > parkedAt)
    if (i.isPreLaunch || closed.length) {
      const p = closed[0] ?? prs[0]!
      const reason = prs
        .flatMap(x => x.notes ?? [])
        .filter(n => n.person && after(n) && n.body.trim())
        .sort((a, b) => b.at - a.at)[0]
      const when = p.closedAt || p.updatedAt
      const text = `${p.url} was closed without a merge (${when}).${reason ? ` Reason from a person: ${clip(reason.body)}` : ''}`
      return { kind: 'hold', text, url: p.url }
    }
  }
  if (!i.failed && i.canChange) {
    const open = prs.filter(p => p.state === 'OPEN')
    for (const p of open) {
      const reqs = (p.notes ?? []).filter(n => after(n) && isChangeRequest(n))
      const bodies = reqs.map(n => clip(n.body.trim() || 'changes requested (a review with no text)'))
      // GitLab has no review list: the merge request asks for changes now and did not at the baseline
      if (!bodies.length && p.changesRequested && i.seen && !i.seen.changes?.[p.url])
        bodies.push('changes requested on the merge request')
      if (bodies.length) {
        const text = `${p.url} has change requests from a person:\n\n${bodies.map((b, n) => `${n + 1}. ${b}`).join('\n\n')}`
        return { kind: 'changes', text, url: p.url, bodies }
      }
    }
  }
  for (const p of prs) {
    if (p.state === 'MERGED' && mergedAt(p) > parkedAt)
      return wake(p, `it is merged, updated ${p.mergedAt || p.updatedAt}`)
    if (p.state === 'CLOSED' && closedAt(p) > parkedAt)
      return wake(p, `it is closed, updated ${p.closedAt || p.updatedAt}`)
    const was = i.seen?.heads[p.url]
    if (p.headRefOid && was && p.headRefOid !== was)
      return wake(p, `it has a new head commit ${p.headRefOid.slice(0, 7)} (was ${was.slice(0, 7)})`)
    const wasDraft = i.seen?.drafts?.[p.url]
    if (p.isDraft !== undefined && wasDraft !== undefined && p.isDraft !== wasDraft)
      return wake(p, p.isDraft ? 'it is a draft again' : 'it is ready for review')
    const wasDecision = i.seen?.decisions?.[p.url]
    if (
      p.reviewDecision !== undefined &&
      wasDecision !== undefined &&
      noRequired(p.reviewDecision) !== noRequired(wasDecision)
    )
      return wake(
        p,
        `its review decision is now ${p.reviewDecision || 'none'} (was ${wasDecision || 'none'})`,
      )
    const note = (p.notes ?? []).find(n => n.person && after(n))
    if (note) return wake(p, `a person reviewed or commented on it at ${new Date(note.at).toISOString()}`)
  }
  // an open pull request on the run's own branch that conflicts: no CI can start, so waiting is pointless
  for (const p of prs) {
    if (p.state !== 'OPEN' || p.mergeable !== 'CONFLICTING' || !p.headRefOid) continue
    if (!i.branch || !p.headRefName) continue
    if (p.headRefName !== i.branch && !p.headRefName.startsWith(`${i.branch}-`)) continue
    const text = conflictText(p)
    if (i.mailed?.includes(text)) continue
    return { kind: 'wake', text, url: p.url, state: p.state }
  }
  if (!prs.some(p => p.state === 'OPEN') && (i.isPreLaunch || i.now - parkedAt >= i.plainMin * 60_000))
    return {
      kind: 'wake',
      text: `[factory] None of the pull requests you linked is open, so they will not change: check again whether what you wait on is done.`,
    }
  // nothing changed and every pull request is open: near the timer, park again instead of a worker
  if (
    !i.failed &&
    !i.held &&
    prs.every(p => p.state === 'OPEN') &&
    i.now >= i.wakeAt - REPARK_LEAD_MIN * 60_000 &&
    !(i.seen?.reparkedUntil && i.now < i.seen.reparkedUntil - REPARK_LEAD_MIN * 60_000)
  )
    return { kind: 'repark', wakeAt: i.now + WATCHED_PARK_MIN * 60_000 }
  return null
}

function wake(p: WatchedPr, what: string): Decision {
  return {
    kind: 'wake',
    text: `[factory] ${p.url} changed since you parked: ${what}. Check where it stands now.`,
    url: p.url,
    state: p.state,
  }
}
