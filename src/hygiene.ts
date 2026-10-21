// claude-factory-8bg: the hygiene sweep's pure matcher. It reads beads and merged PRs and returns
// proposals. It never calls bd or gh, and it never closes anything.
import { citesBead, type MergedPr } from './prs'

export const STALE_LABEL = 'stale?'
export const MAX_FINDINGS = 20
export const MAX_COMMENT_LOOKUPS = 60
const DAY = 86_400_000
const STALE_MS = 14 * DAY
export const RECENT_COMMENT_MS = 7 * DAY
const JACCARD = 0.8

export type HygieneBead = {
  id: string
  title: string
  status?: string
  labels?: string[]
  assignee?: string
  parent?: string
  created_at?: string
  updated_at?: string
  defer_until?: string
  comment_count?: number
  metadata?: Record<string, unknown>
}
export type Kind = 'shipped' | 'duplicate' | 'orphan' | 'deferred' | 'stale'
export type Finding = { id: string; title: string; kind: Kind; evidence: string }

export const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n) : s)
const ms = (s?: string) => (s ? Date.parse(s) || 0 : 0)
const isOpen = (b: HygieneBead) => b.status === 'open' || b.status === 'blocked'
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'and', 'with'])
const tokens = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w && !STOP.has(w)),
  )

/** title token Jaccard of at least 0.8 over 3 or more tokens on each side */
export function similar(a: string, b: string): boolean {
  const x = tokens(a)
  const y = tokens(b)
  if (x.size < 3 || y.size < 3) return false
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both) >= JACCARD
}

/** a bead a run already handles, that is closed, or that this sweep already proposed or digested */
const excluded = (b: HygieneBead) =>
  b.status === 'closed' ||
  b.status === 'in_progress' ||
  !!b.labels?.includes(STALE_LABEL) ||
  !!b.metadata?.hygiene_proposed ||
  !!b.metadata?.hygiene_digest

/** dispatch holds a bead with `stale?` and a proposal of kind shipped or duplicate, until `factory queue` */
export const hygieneHeld = (b: HygieneBead) =>
  !!b.labels?.includes(STALE_LABEL) &&
  /^(shipped|duplicate)@/.test(String(b.metadata?.hygiene_proposed ?? ''))

function classify(b: HygieneBead, all: HygieneBead[], prs: MergedPr[], now: number): Finding | null {
  const kids = all.filter(c => c.parent === b.id)
  const mk = (kind: Kind, evidence: string): Finding => ({
    id: b.id,
    title: clip(b.title),
    kind,
    evidence: clip(evidence),
  })
  const done = kids.length > 0 && kids.every(c => c.status === 'closed')
  const pr = prs.find(p => citesBead(b.id, p.title) || (done && kids.some(c => citesBead(c.id, p.title))))
  if (pr) return mk('shipped', `${pr.url} (#${pr.number}, merged ${pr.mergeCommit}) "${clip(pr.title, 60)}"`)
  if (isOpen(b)) {
    // the newer bead of a pair is the finding: the older one is its twin
    const twin = all.find(
      o =>
        o.id !== b.id &&
        isOpen(o) &&
        o.parent !== b.id &&
        b.parent !== o.id &&
        (!b.parent || b.parent !== o.parent) &&
        (ms(o.created_at) < ms(b.created_at) || (ms(o.created_at) === ms(b.created_at) && o.id < b.id)) &&
        similar(o.title, b.title),
    )
    if (twin) return mk('duplicate', `same work as ${twin.id} "${clip(twin.title, 60)}"`)
  }
  if (b.parent) {
    const p = all.find(o => o.id === b.parent)
    if (!p || p.status === 'closed') return mk('orphan', `parent ${b.parent} is ${p ? 'closed' : 'missing'}`)
  }
  const idle = now - ms(b.updated_at)
  if (idle <= STALE_MS) return null
  const days = Math.floor(idle / DAY)
  if (b.status === 'deferred') {
    const until = ms(b.defer_until)
    if (b.assignee || (until && until > now)) return null
    return mk('deferred', `deferred with no owner, untouched ${days}d`)
  }
  if (isOpen(b) && !kids.some(c => c.status !== 'closed')) return mk('stale', `untouched ${days}d`)
  return null
}

const ORDER: Kind[] = ['shipped', 'duplicate', 'orphan', 'deferred', 'stale']

/**
 * Up to `cap` proposals, in kind priority order, one per bead. `commentedRecently(id)` is read only
 * for a bead with comments, at most MAX_COMMENT_LOOKUPS times; a bead it names is skipped.
 */
export function findHygiene(
  beads: HygieneBead[],
  prs: MergedPr[],
  now: number,
  commentedRecently: (id: string) => boolean = () => false,
  cap = MAX_FINDINGS,
): Finding[] {
  const found = beads
    .filter(b => !excluded(b))
    .flatMap(b => classify(b, beads, prs, now) ?? [])
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  const count = new Map(beads.map(b => [b.id, b.comment_count ?? 0]))
  const out: Finding[] = []
  let lookups = 0
  for (const f of found) {
    if (out.length >= cap) break
    if ((count.get(f.id) ?? 0) > 0) {
      if (lookups++ >= MAX_COMMENT_LOOKUPS) break
      if (commentedRecently(f.id)) continue
    }
    out.push(f)
  }
  return out
}

/** the one-line bd comment for a proposal */
export const proposalComment = (f: Finding) =>
  `proposed close: ${f.kind}: ${f.evidence}. Keep it: bd label remove ${f.id} ${STALE_LABEL}`

export const digestLines = (fs: Finding[]) => fs.map(f => `${f.id} ${f.kind}: ${f.evidence}`).join('\n')
