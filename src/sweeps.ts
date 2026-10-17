// Pure logic behind the standing sweeps (factories/sweeps.ts).
// cli.ts's `sweep()` does the effects: it starts a run. It runs a rig's `--slo` command.
// It reads and writes bd.
import { createHash } from 'node:crypto'
import type { Factory } from './machine'

/** the goal a sweep pass's run carries. `dueSweeps` uses this to find a live run for a sweep. */
export const sweepGoal = (station: string) => `sweep: ${station}`

/** Node ids a factory marks as sweep stations: those with `everyMin` set. This replaces a hardcoded
 * station list, so a factory other than factories/sweeps.ts can carry its own sweep stations too. */
export const sweepNames = (def: Factory): string[] =>
  Object.keys(def.nodes).filter(id => def.nodes[id]!.everyMin)

/** sweeps.json's shape: for each rig, for each sweep, when it last ran, and (monitor only) its last read. */
export type SweepState = Record<string, Record<string, { lastAt: number; sig?: string; lines?: number }>>

export type LiveRun = { repo: string; goal: string }

/**
 * The sweeps due now for `rig`. A sweep is due when all of these hold:
 * - it is in `rig.sweeps` (unset means every sweep station `def` has)
 * - it is not `monitor` on a rig with no `rig.slo` set (monitor has nothing to read there)
 * - the rig's repo has no live run with its goal (`sweepGoal`), in any factory: a pinned lifecycle
 *   sweep run still blocks a new one, the same as a run of `def` itself
 * - its last pass, from `state`, is at least `everyMin` minutes old
 *
 * `liveRuns` must already exclude done and aborted runs: this function only matches repo and goal.
 */
const SWEEP_FILER = /^factory\/sweeps-[^/]+\/([^/]+)$/

/** Reads the sweep station that filed a bead, from its `created_by` field. A sweep run's actor
 * looks like `factory/sweeps-<run>/maintain` (beads.ts's `actorOf`, plus `/<station>`). This
 * returns undefined for a bead a person created, or for a bead any other kind of run created. */
export const sweepFiler = (b: { created_by?: string }): string | undefined =>
  SWEEP_FILER.exec(b.created_by ?? '')?.[1]

/** A kept, sweep-filed bead carrying one of these labels starts on its own, past the flood guard
 * (claude-factory-8pc.5): an incident, a red main-branch CI run, or a critical security advisory. */
export const SWEEP_QUEUE_LABELS = [
  'sweep-queue:incident',
  'sweep-queue:main-ci-red',
  'sweep-queue:critical-advisory',
]

export type GuardedBead = { id: string; created_by?: string; created_at?: string; labels?: string[] }
export type GuardVerdict = { id: string; station: string; kept: boolean; allowed: boolean }

/**
 * This is the flood guard (claude-factory-8pc.5). At most `cap` (default 5) sweep-filed beads per
 * rig stay inside any rolling `windowMs` (default 24h) window. It keeps the oldest ones first, by
 * `created_at`. `beads` is one rig's full bead list. Only beads a sweep pass filed (`sweepFiler`)
 * appear in the result. The caller must leave every other bead alone: a person's, or another run's.
 *
 * `kept` false means the bead is past the cap: the caller must defer it and strip its `factory`
 * label. `kept` true and `allowed` false means the bead is inside the cap, but carries no allowed
 * `sweep-queue:*` label: the caller must still strip `factory` (it then waits for a person to queue
 * it by hand). `kept` and `allowed` both true means the caller must leave `factory` alone, so
 * dispatch starts the bead as before.
 */
export function sweepGuard(
  beads: GuardedBead[],
  now: number,
  cap = 5,
  windowMs = 24 * 60 * 60 * 1000,
): GuardVerdict[] {
  return beads
    .flatMap(b => {
      const station = sweepFiler(b)
      return station ? [{ b, station }] : []
    })
    .map(x => ({ ...x, at: x.b.created_at ? new Date(x.b.created_at).getTime() : 0 }))
    .filter(x => now - x.at < windowMs)
    .sort((a, c) => a.at - c.at)
    .map((x, i) => ({
      id: x.b.id,
      station: x.station,
      kept: i < cap,
      allowed: i < cap && !!x.b.labels?.some(l => SWEEP_QUEUE_LABELS.includes(l)),
    }))
}

/** A deterministic fingerprint of a monitor pass's command output (claude-factory-8pc.6). `sweep()`
 * compares this against the last pass's `sig` in sweeps.json. When it is unchanged, no run starts,
 * and no model reads the output. Two equal outputs always give the same sig. One byte of difference
 * gives a different sig. */
export const sigOf = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Clips `text` to at most `maxBytes` UTF-8 bytes, so a monitor command's output can carry a run only
 * a small, bounded mail (claude-factory-8pc.6: 4 KiB). It never splits a multi-byte character: a cut
 * mid-codepoint decodes to U+FFFD, which this strips from the end before it appends the clip note. */
export function clipUtf8(text: string, maxBytes = 4096): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return text
  const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/, '')
  return `${cut}\n[clipped: ${maxBytes} of ${bytes.length} bytes]`
}

export function dueSweeps(
  def: Factory,
  rig: { name: string; repo: string; sweeps?: string[]; slo?: string },
  state: SweepState,
  liveRuns: LiveRun[],
  now: number,
): string[] {
  const names = (rig.sweeps ?? sweepNames(def)).filter(s => def.nodes[s]?.everyMin)
  return names.filter(s => {
    if (s === 'monitor' && !rig.slo) return false
    const goal = sweepGoal(s)
    if (liveRuns.some(r => r.repo === rig.repo && r.goal === goal)) return false
    const lastAt = state[rig.name]?.[s]?.lastAt ?? 0
    return now - lastAt >= def.nodes[s]!.everyMin! * 60_000
  })
}
