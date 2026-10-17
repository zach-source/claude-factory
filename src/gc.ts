// `factory gc` removes the old files of a finished run.
// It also removes a dead launch script. A launch script can hold MCP env or headers (claude-factory-503.1).
//
// This module is pure. It takes these plain facts as input: a run's node, its finish time, the size of
// each file, and the live panes. It does not call any filesystem function.
//
// src/cli.ts reads the real HOME. It builds these facts with lstat. It does not follow symlinks.
// It then runs the plan this file returns.

/** This is one top-level entry under a run's directory. The caller sizes each entry before it passes the entry to this module.
 * For a directory, the caller sums its bytes and files into its own recursive total. */
export type FileFact = { name: string; isDir: boolean; bytes: number; files: number }

/** This is one run, as gc sees it. gc removes files from this run only when its node is 'done' or 'aborted'.
 * The finish time is the `at` of the last journal entry. If the journal has no entry, the finish time is the creation time of the run.
 * Do not use the mtime of a file, because tick rewrites state.json each time tick writes it. The entries are the top-level entries of the run's directory. */
export type RunFact = { id: string; node: string; finishedAt: number; entries: FileFact[] }

/** This is one launch script at HOME/launch/<pane>.sh. */
export type LaunchFact = { pane: string; bytes: number; mtimeMs: number }

export type KindTotal = { bytes: number; files: number }

export type RunGc = {
  id: string
  /** These are the top-level names under the run's directory that gc removes. */
  paths: string[]
  kinds: { prompts: KindTotal; briefs: KindTotal; backups: KindTotal }
}

export type GcPlan = {
  runs: RunGc[]
  /** These are the panes whose launch script this plan removes. */
  launch: string[]
  totals: {
    prompts: KindTotal
    briefs: KindTotal
    backups: KindTotal
    launch: KindTotal
    /** These are the runs that have at least one file to prune. */
    runs: number
  }
}

/** A dead pane's launch script survives this long. This wait covers two cases.
 * In the first case, a pane closed recently. In the second case, a new pane's script exists before the pane appears in `herdr pane list`.
 * One pass alone never catches such a pane. */
export const LAUNCH_MIN_AGE_MS = 3_600_000

const isBrief = (name: string) => /^f-.*\.brief\.md$/.test(name)
const isBackup = (name: string) => /\.(before|pre)-/.test(name)
const zero = (): KindTotal => ({ bytes: 0, files: 0 })

/**
 * gc removes these reproducible files from each eligible run: the `prompts/` directory, every `f-*.brief.md` file,
 * and every name that matches `/\.(before|pre)-/`. Such a name is a stray backup, for example `rigs.json.before-123`.
 * gc keeps these names: run.json, state.json, inbox.jsonl, prs.json, track.json, progress.json, factory.json, factory.ts,
 * f-*.json, f-*.seen, and any other name.
 *
 * A run is eligible only when its node is 'done' or 'aborted' and `now - finishedAt >= days`.
 * gc never touches a run that is still active, even when its finishedAt value looks old.
 *
 * `livePanes` is the result of the strict herdr read. It is null when gc cannot trust the result: herdr is missing,
 * its call failed, or it answered with no `result.panes`. When `livePanes` is null, gc removes no launch script at all.
 * gc does this so that it does not treat a failure as "no live panes".
 */
export function gcPlan(
  runs: RunFact[],
  launch: LaunchFact[],
  livePanes: Set<string> | null,
  now: number,
  days: number,
): GcPlan {
  const cutoff = days * 24 * 3_600_000
  const runPlans: RunGc[] = []
  for (const r of runs) {
    if (!['done', 'aborted'].includes(r.node)) continue
    if (now - r.finishedAt < cutoff) continue
    const kinds = { prompts: zero(), briefs: zero(), backups: zero() }
    const paths: string[] = []
    for (const f of r.entries) {
      const kind =
        f.name === 'prompts' ? 'prompts' : isBrief(f.name) ? 'briefs' : isBackup(f.name) ? 'backups' : null
      if (!kind) continue
      kinds[kind].bytes += f.bytes
      kinds[kind].files += f.files
      paths.push(f.name)
    }
    if (paths.length) runPlans.push({ id: r.id, paths, kinds })
  }
  const launchPlan =
    livePanes === null
      ? []
      : launch.filter(l => !livePanes.has(l.pane) && now - l.mtimeMs >= LAUNCH_MIN_AGE_MS)
  const sum = (pick: (r: RunGc) => KindTotal) =>
    runPlans.reduce((a, r) => ({ bytes: a.bytes + pick(r).bytes, files: a.files + pick(r).files }), zero())
  return {
    runs: runPlans,
    launch: launchPlan.map(l => l.pane),
    totals: {
      prompts: sum(r => r.kinds.prompts),
      briefs: sum(r => r.kinds.briefs),
      backups: sum(r => r.kinds.backups),
      launch: { bytes: launchPlan.reduce((a, l) => a + l.bytes, 0), files: launchPlan.length },
      runs: runPlans.length,
    },
  }
}

// ---- `factory gc --worktrees` (claude-factory-l38). This removes a finished run's worktree. It
// also removes the run's factory/* branch (local and remote) once a tick has merged every tip.
// This half is pure too. src/cli.ts alone shells out to git, gh, bd and herdr. It then feeds the
// plan below their answers, as plain facts.

/** a finished run's worktree survives this long, so a run that just ended keeps its worktree a while
 * (a person opening it right after "done", a retry close behind it). */
export const WORKTREE_MIN_AGE_MS = 3_600_000
/** a dirty worktree whose untracked files exceed this is kept whole, never snapshotted (claude-factory-l38 AC6) */
export const UNTRACKED_MAX_BYTES = 50 * 1024 * 1024

/** one `git worktree list --porcelain` entry, as the caller reads it (no symlink resolved) */
export type WorktreeFact = {
  path: string
  /** the branch it has checked out, or null when detached */
  branch: string | null
  locked: boolean
  /** clean: no uncommitted or untracked change; small: under UNTRACKED_MAX_BYTES, snapshot first; large: kept whole */
  dirty: 'clean' | 'small' | 'large'
  bytes: number
}

/** one factory/* branch's local and/or remote tip, and whether each is an ancestor of origin/<default> */
export type BranchFact = {
  name: string
  local: string | null
  remote: string | null
  localMerged: boolean
  remoteMerged: boolean
}

export type PrFact = { state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; headRefOid: string }

/** a run, as worktreePlan() needs it: enough to decide ownership, liveness and bead state */
export type RunRef = { id: string; node: string; finishedAt: number; worktree: string; bead?: string }

/** one rig's facts for one pass. `branches` and `prs` are null on any read failure for this rig
 * (git fetch/ls-remote, or gh/non-GitHub): worktreePlan() then deletes no branch in it (AC5). */
export type RigWorktreeFacts = {
  name: string
  worktrees: WorktreeFact[]
  branches: BranchFact[] | null
  prs: PrFact[] | null
  /** keyed by bead id; a bead missing here counts as open (AC5: a failed bd read counts as open) */
  beadClosed: Record<string, boolean>
}

export type WorktreeRemoval = { runId: string; path: string; bytes: number; snapshot: boolean }
export type BranchRemoval = { runId: string; name: string; local: string | null; remote: string | null }
export type Kept = { kind: 'worktree' | 'branch'; runId: string | null; name: string; reason: string }
export type RigWorktreePlan = {
  rig: string
  removeWorktrees: WorktreeRemoval[]
  removeBranches: BranchRemoval[]
  keep: Kept[]
  /** a worktree or branch whose owner run this pass could name */
  owned: number
  /** of those, how many belong to a run that is not done/aborted */
  live: number
  /** a worktree on a non-factory branch no run's path matches, or a factory/* branch no run's id matches */
  unowned: number
}

const isLive = (r: RunRef) => !['done', 'aborted'].includes(r.node)

/** the run whose id is the longest match of `factory/<id>` or `factory/<id>-*`: a live fork's longer id
 * always wins over the finished run it forked from (claude-factory-l38 test 13) */
function ownerByBranch(name: string | null, runs: RunRef[]): RunRef | null {
  if (!name?.startsWith('factory/')) return null
  const id = name.slice('factory/'.length)
  const matches = runs.filter(r => id === r.id || id.startsWith(`${r.id}-`))
  return matches.length ? matches.reduce((a, b) => (b.id.length > a.id.length ? b : a)) : null
}
const ownerOfPath = (path: string, branch: string | null, runs: RunRef[]): RunRef | null =>
  runs.find(r => r.worktree === path) ?? ownerByBranch(branch, runs)

/** whether one existing tip (a sha that is really there, local or remote) is covered: an ancestor of
 * the default branch, the headRefOid of a MERGED PR, or of a CLOSED one whose run's bead is closed */
function coverTip(sha: string, mergedAncestor: boolean, prs: PrFact[], branch: string, beadClosed: boolean) {
  if (mergedAncestor) return 'covered' as const
  const hit = prs.filter(p => p.headRefName === branch && p.headRefOid === sha)
  if (hit.some(p => p.state === 'MERGED')) return 'covered' as const
  if (hit.some(p => p.state === 'CLOSED')) return beadClosed ? ('covered' as const) : ('bead-open' as const)
  return 'uncovered' as const
}

/**
 * For each rig, this picks two things. First, which finished run's worktree to remove (with a
 * snapshot first when it is dirty-small). Second, which factory/* branch to delete, local and
 * remote, once a tick has covered every tip of it.
 *
 * This plan never touches a live run's worktree or branch (AC2). `panes` is the strict herdr
 * read: on any failure it is null, and gc then keeps every worktree (AC5). gc also keeps a locked
 * worktree, and one a pane's cwd sits inside. gc never deletes a branch a kept worktree still has
 * checked out (AC3), one with an OPEN pull request, or one whose rig returned null branch or PR
 * facts (AC5, AC8).
 */
export function worktreePlan(
  rigs: RigWorktreeFacts[],
  runs: RunRef[],
  panes: { cwd: string }[] | null,
  now: number,
): RigWorktreePlan[] {
  return rigs.map(rig => {
    const keep: Kept[] = []
    const removeWorktrees: WorktreeRemoval[] = []
    let owned = 0
    let live = 0
    let unowned = 0
    const keptBranches = new Set<string>()
    for (const w of rig.worktrees) {
      const owner = ownerOfPath(w.path, w.branch, runs)
      if (!owner) {
        unowned++
        keep.push({ kind: 'worktree', runId: null, name: w.path, reason: 'unowned' })
        if (w.branch) keptBranches.add(w.branch)
        continue
      }
      owned++
      if (isLive(owner)) live++
      const paneInside = panes?.some(p => p.cwd === w.path || p.cwd.startsWith(`${w.path}/`)) ?? false
      const reason =
        panes === null
          ? 'herdr-unknown'
          : paneInside
            ? 'pane-open'
            : w.locked
              ? 'locked'
              : isLive(owner)
                ? 'live'
                : now - owner.finishedAt < WORKTREE_MIN_AGE_MS
                  ? 'recent'
                  : w.dirty === 'large'
                    ? 'dirty-large'
                    : null
      if (reason) {
        keep.push({ kind: 'worktree', runId: owner.id, name: w.path, reason })
        if (w.branch) keptBranches.add(w.branch)
        continue
      }
      removeWorktrees.push({ runId: owner.id, path: w.path, bytes: w.bytes, snapshot: w.dirty === 'small' })
    }
    const removeBranches: BranchRemoval[] = []
    const noFacts = rig.branches === null || rig.prs === null
    for (const b of rig.branches ?? []) {
      const owner = ownerByBranch(b.name, runs)
      if (!owner) {
        unowned++
        keep.push({ kind: 'branch', runId: null, name: b.name, reason: 'unowned' })
        continue
      }
      if (isLive(owner)) {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'live' })
        continue
      }
      if (keptBranches.has(b.name)) {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'checked-out' })
        continue
      }
      if (noFacts) {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'facts-unavailable' })
        continue
      }
      const prs = rig.prs!
      if (prs.some(p => p.headRefName === b.name && p.state === 'OPEN')) {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'open-pr' })
        continue
      }
      const beadClosed = owner.bead ? (rig.beadClosed[owner.bead] ?? false) : false
      const tips = [
        b.local && { sha: b.local, merged: b.localMerged },
        b.remote && { sha: b.remote, merged: b.remoteMerged },
      ].filter((t): t is { sha: string; merged: boolean } => !!t)
      const covers = tips.map(t => coverTip(t.sha, t.merged, prs, b.name, beadClosed))
      if (covers.every(c => c === 'covered')) {
        removeBranches.push({ runId: owner.id, name: b.name, local: b.local, remote: b.remote })
      } else if (covers.every(c => c !== 'uncovered') && covers.some(c => c === 'bead-open')) {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'bead-open' })
      } else if (tips.length === 2 && tips[0]!.sha !== tips[1]!.sha) {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'diverged' })
      } else {
        keep.push({ kind: 'branch', runId: owner.id, name: b.name, reason: 'unmerged' })
      }
    }
    return { rig: rig.name, removeWorktrees, removeBranches, keep, owned, live, unowned }
  })
}
