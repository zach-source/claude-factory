// The orphan-PR review sweep's decisions (claude-factory-pff5). A run that blocks and is then aborted leaves
// a green draft PR that nothing reviews. `orphanPass` in cli.ts lists a rig's open pull requests and
// `orphanSweep` here decides which ones get a review fork. It reads plain data and calls injected io, so
// tests need no gh. Any unknown value (a failed call, a bad row) means skip: the sweep starts runs with no person.
// The bead decides (claude-factory-e2xe): a closed or deferred bead closes the PR. An open bead gets the `conflict`
// or `rework` label, which the label pass picks up. Only a green mergeable draft gets a review fork.
import type { Checks } from './prs'

/** the most review forks one rig gets in one pass */
export const ORPHAN_CAP = 2
/** the most closes and labels one rig gets in one pass */
export const ORPHAN_ACTS = ORPHAN_CAP
/** the most CI lookups one rig gets in one pass: a skip after the lookup still costs a call */
export const ORPHAN_CHECKS_MAX = ORPHAN_CAP * 3

export type OrphanPr = {
  number: number
  url: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
  isCrossRepository: boolean
  labels?: { name: string }[]
}

/** a fork the sweep made: keyed by PR URL, valid for that head SHA only, so a new push can be reviewed again */
export type OrphanRecord = { sha: string; run: string; from: string; at: string }

export type OrphanCtx = {
  /** the run ids that have a run dir, each with its bead (if any) */
  runs: Map<string, { bead?: string; decided?: boolean }>
  /** the bead of every live run */
  liveBeads: Set<string>
  /** a live run owns the PR (its branch, or its reports link it): the id */
  owner: (pr: OrphanPr) => string | undefined
  /** the ship queue holds the PR */
  queued: (pr: OrphanPr) => boolean
  records: Record<string, OrphanRecord>
  /** the review fork run ended aborted: its PR counts as an orphan again */
  forkAborted?: (run: string) => boolean
}

export type OrphanIo = {
  /** a bead's status and close reason, or null when bd cannot say */
  bead: (id: string) => Promise<{ status: string; reason?: string } | null>
  /** the PR head's CI, or null when the call failed */
  checks: (pr: OrphanPr) => Promise<Checks | null>
  /** the PR's mergeable state ('MERGEABLE', 'CONFLICTING' or other), whether a review asks for changes and whether a person's APPROVED review decision stands; null when unreadable */
  view: (pr: OrphanPr) => Promise<{ mergeable: string; changes: boolean; approved: boolean } | null>
  /** adds labels to the PR */
  label: (pr: OrphanPr, labels: string[]) => Promise<void> | void
  /** closes the PR with a comment */
  close: (pr: OrphanPr, body: string) => Promise<void> | void
  /** starts the review run from the source run: the new run's id */
  fork: (pr: OrphanPr, src: string, note: string) => Promise<string>
  /** run is '' for the attempt, written before the fork, then the new run's id */
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
  if (ctx.owner(pr)) return 'a live run owns it'
  const bead = ctx.runs.get(src)!.bead
  if (bead && ctx.liveBeads.has(bead)) return 'a live run holds the bead'
  if (ctx.queued(pr)) return 'in the ship queue'
  if (ctx.runs.get(src)!.decided) return 'source run ended at a decision'
  const rec = ctx.records[pr.url]
  if (rec?.sha === pr.headRefOid && !(rec.run && ctx.forkAborted?.(rec.run)))
    return 'already forked at this head'
  return undefined
}

/** red, pending or unknown CI is no reason to review; zero checks count as green */
export const ciVerdict = (c: Checks | null) =>
  !c ? 'unknown' : c.fail > 0 ? 'red' : c.pending > 0 ? 'pending' : 'green'

const hasLabel = (pr: OrphanPr, name: string) => !!pr.labels?.some(l => l.name === name)
const FORKED = 'already forked at this head'

/** the labels an open bead's PR needs: conflict for a merge conflict, rework for red checks or asked changes */
export const labelsFor = (mergeable: string, changes: boolean, ci: string) => [
  ...(mergeable === 'CONFLICTING' ? ['conflict'] : []),
  ...(ci === 'red' || changes ? ['rework'] : []),
]

/**
 * Decides each orphan by its bead. It closes the PR of a closed or deferred bead, labels the PR of an open bead
 * that conflicts or fails, and forks a review run for a green mergeable one. Closes and labels share `acts`;
 * forks have their own `cap`. It reports who it skipped and why.
 */
export async function orphanSweep(
  prs: OrphanPr[],
  ctx: OrphanCtx,
  io: OrphanIo,
  cap: number,
  acts = ORPHAN_ACTS,
) {
  const forked: { url: string; run: string }[] = []
  const closed: string[] = []
  const labeled: { url: string; labels: string[] }[] = []
  const skipped: { url: string; why: string }[] = []
  let lookups = 0
  const done = () => closed.length + labeled.length
  const skip = (url: string, why: string) => void skipped.push({ url, why })
  for (const pr of prs) {
    if (forked.length >= cap && done() >= acts) break
    const why = orphanSkip(pr, ctx)
    if (why && why !== FORKED) {
      skip(pr.url, why)
      continue
    }
    const src = runOf(pr)!
    const bead = ctx.runs.get(src)!.bead
    if (bead) {
      const info = await io.bead(bead)
      if (info === null) {
        skip(pr.url, 'bead unreadable')
        continue
      }
      const status = info.status
      if (status === 'closed' || status === 'deferred') {
        // the repair pass (closeParents) closes a parent with this exact reason; it is no merge, so the PR stays (claude-factory-i1qiv)
        let hold = status === 'closed' && info.reason === 'every child is closed' ? info.reason : undefined
        if (!hold) {
          if (done() >= acts) continue
          if (lookups >= ORPHAN_CHECKS_MAX) {
            skip(pr.url, 'lookup cap')
            continue
          }
          lookups++
          const v = await io.view(pr).catch(() => null)
          if (!v) {
            skip(pr.url, 'view unreadable')
            continue
          }
          if (v.approved) hold = 'approved'
        }
        if (hold) {
          if (!hasLabel(pr, 'owner') && done() < acts) await label(pr, src, ['owner'])
          skip(pr.url, `held for the person: ${hold}`)
          continue
        }
        try {
          await io.close(
            pr,
            `Closed by claude-factory: run \`${src}\` is not live and its bead ${bead} is ${status}.`,
          )
          closed.push(pr.url)
        } catch (err) {
          skip(pr.url, `close failed: ${(err as Error).message}`)
        }
        continue
      }
    }
    if (why) {
      skip(pr.url, why)
      continue
    }
    if (lookups >= ORPHAN_CHECKS_MAX) break
    lookups++
    const verdict = ciVerdict(await io.checks(pr))
    const view = await io.view(pr)
    if (!view) {
      skip(pr.url, 'view unreadable')
      continue
    }
    const rec = ctx.records[pr.url]
    const reForked = rec?.sha === pr.headRefOid // an aborted fork came back as an orphan
    const wanted = bead ? labelsFor(view.mergeable, view.changes, verdict).filter(l => !hasLabel(pr, l)) : []
    const needs = bead && labelsFor(view.mergeable, view.changes, verdict).length > 0
    if (needs) {
      if (!wanted.length) skip(pr.url, 'already labeled')
      else if (done() < acts) await label(pr, src, wanted)
      continue
    }
    if (verdict !== 'green') {
      skip(pr.url, `CI ${verdict}`)
      continue
    }
    if (view.mergeable !== 'MERGEABLE') {
      skip(pr.url, 'mergeability unknown')
      continue
    }
    if (reForked) {
      skip(pr.url, 'review fork aborted') // a second fork would end the same way
      continue
    }
    if (forked.length >= cap) continue
    await fork(pr, src)
  }
  return { forked, closed, labeled, skipped }

  // the record comes first: a call that fails, or a record write that fails after it, must not repeat every pass
  async function label(pr: OrphanPr, src: string, labels: string[]) {
    try {
      io.record(pr, src, '')
    } catch (err) {
      return skip(pr.url, `record failed: ${(err as Error).message}`)
    }
    try {
      await io.label(pr, labels)
    } catch (err) {
      return skip(pr.url, `label failed: ${(err as Error).message}`)
    }
    labeled.push({ url: pr.url, labels })
    try {
      io.record(pr, src, 'labeled')
    } catch (err) {
      skip(pr.url, `record failed after label: ${(err as Error).message}`)
    }
  }

  async function fork(pr: OrphanPr, src: string) {
    try {
      io.record(pr, src, '')
    } catch (err) {
      return skip(pr.url, `record failed: ${(err as Error).message}`)
    }
    let run: string
    try {
      run = await io.fork(pr, src, orphanNote(pr))
    } catch (err) {
      return skip(pr.url, `fork failed: ${(err as Error).message}`)
    }
    try {
      io.record(pr, src, run)
    } catch (err) {
      // the first record (run '') still holds this PR at this head: say the fork ran, so the row does not claim it failed
      skip(pr.url, `record failed after fork ${run}: ${(err as Error).message}`)
    }
    forked.push({ url: pr.url, run })
  }
}
