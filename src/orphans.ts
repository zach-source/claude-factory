// The orphan-PR review sweep's decisions (claude-factory-pff5). A run that blocks and is then aborted leaves
// a green draft PR that nothing reviews. `orphanPass` in cli.ts lists a rig's open pull requests and
// `orphanSweep` here decides which ones get a review fork. It reads plain data and calls injected io, so
// tests need no gh. Any unknown value (a failed call, a bad row) means skip: the sweep starts runs with no person.
import type { Checks } from './prs'

/** the most review forks one rig gets in one pass */
export const ORPHAN_CAP = 2
/** the most CI lookups one rig gets in one pass: a skip after the lookup still costs a call */
export const ORPHAN_CHECKS_MAX = ORPHAN_CAP * 3

export type OrphanPr = {
  number: number
  url: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
  isCrossRepository: boolean
}

/** a fork the sweep made: keyed by PR URL, valid for that head SHA only, so a new push can be reviewed again */
export type OrphanRecord = { sha: string; run: string; from: string; at: string }

export type OrphanCtx = {
  /** the run ids that have a run dir, each with its bead (if any) */
  runs: Map<string, { bead?: string }>
  /** the bead of every live run */
  liveBeads: Set<string>
  /** a live run owns the PR (its branch, or its reports link it): the id */
  owner: (pr: OrphanPr) => string | undefined
  /** the ship queue holds the PR */
  queued: (pr: OrphanPr) => boolean
  records: Record<string, OrphanRecord>
}

export type OrphanIo = {
  /** a bead's status, or null when bd cannot say */
  beadStatus: (id: string) => Promise<string | null>
  /** the PR head's CI, or null when the call failed */
  checks: (pr: OrphanPr) => Promise<Checks | null>
  /** starts the review run from the source run: the new run's id */
  fork: (pr: OrphanPr, src: string, note: string) => Promise<string>
  record: (pr: OrphanPr, src: string, run: string) => void
}

export const orphanNote = (pr: Pick<OrphanPr, 'url' | 'headRefOid'>) =>
  `[factory] Orphan sweep: ${pr.url} is a draft at head ${pr.headRefOid} with green CI and no live run. Review this PR at this head.`

/** the run id a factory branch names, or undefined for any other branch */
const runOf = (pr: OrphanPr) => /^factory\/([a-z0-9-]+)$/.exec(pr.headRefName)?.[1]

/** why a PR is no orphan, from data alone (no io); undefined when it passes every such check */
export function orphanSkip(pr: OrphanPr, ctx: OrphanCtx): string | undefined {
  const src = runOf(pr)
  if (!pr.isDraft) return 'not a draft'
  if (pr.isCrossRepository) return 'from a fork'
  if (!src) return 'not a factory branch'
  if (!ctx.runs.has(src)) return 'no run dir'
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid)) return 'no head SHA'
  if (ctx.records[pr.url]?.sha === pr.headRefOid) return 'already forked at this head'
  if (ctx.owner(pr)) return 'a live run owns it'
  const bead = ctx.runs.get(src)!.bead
  if (bead && ctx.liveBeads.has(bead)) return 'a live run holds the bead'
  if (ctx.queued(pr)) return 'in the ship queue'
  return undefined
}

/** red, pending or unknown CI is no reason to review; zero checks count as green */
export const ciVerdict = (c: Checks | null) =>
  !c ? 'unknown' : c.fail > 0 ? 'red' : c.pending > 0 ? 'pending' : 'green'

/** forks a review run for each orphan, at most `cap` (and `ORPHAN_CHECKS_MAX` CI lookups); who it skipped and why */
export async function orphanSweep(prs: OrphanPr[], ctx: OrphanCtx, io: OrphanIo, cap: number) {
  const forked: { url: string; run: string }[] = []
  const skipped: { url: string; why: string }[] = []
  let lookups = 0
  for (const pr of prs) {
    if (forked.length >= cap) break
    const why = orphanSkip(pr, ctx)
    if (why) {
      skipped.push({ url: pr.url, why })
      continue
    }
    const src = runOf(pr)!
    const bead = ctx.runs.get(src)!.bead
    if (lookups >= ORPHAN_CHECKS_MAX) break
    if (bead) {
      const status = await io.beadStatus(bead)
      if (status === null || status === 'closed') {
        skipped.push({ url: pr.url, why: status === null ? 'bead unreadable' : 'bead closed' })
        continue
      }
    }
    lookups++
    const verdict = ciVerdict(await io.checks(pr))
    if (verdict !== 'green') {
      skipped.push({ url: pr.url, why: `CI ${verdict}` })
      continue
    }
    const run = await io.fork(pr, src, orphanNote(pr))
    io.record(pr, src, run)
    forked.push({ url: pr.url, run })
  }
  return { forked, skipped }
}
