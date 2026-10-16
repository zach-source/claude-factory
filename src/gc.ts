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
