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

/** sweeps.json's shape: for each rig, for each sweep, when it last ran, and (monitor, drift) its last read. drift keeps the clipped read itself. */
export type SweepState = Record<
  string,
  Record<string, { lastAt: number; sig?: string; lines?: number; read?: string }>
>

export type LiveRun = { repo: string; goal: string }

const SWEEP_FILER = /^factory\/sweeps-[^/]+\/([^/]+)$/

/** Reads the sweep station that filed a bead, from its `created_by` field. A sweep run's actor
 * looks like `factory/sweeps-<run>/maintain` (beads.ts's `actorOf`, plus `/<station>`). This
 * returns undefined for a bead a person created, or for a bead any other kind of run created.
 *
 * claude-factory-8pc.24: `created_by` comes from `BEADS_ACTOR`.
 * This is an env var in the worker's own session (src/cli.ts:1089,1198).
 * A worker can set, clear or re-export `BEADS_ACTOR` itself, for example
 * `BEADS_ACTOR=person bd create ... -l factory`.
 * That files a bead this function never matches.
 * No cap applies then. No sweep-queue allowlist applies then.
 *
 * The worker hook denies that exact command text (src/worker-hook.ts's `BEADS_ACTOR_REASON`).
 * This denial is defense in depth. The guard is client-side.
 * A worker can still write around a denied command in other ways.
 * This gap stays open until the flood guard reads a field no filer can set itself. */
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

/** sweep-guard state (claude-factory-8pc.18): for each rig, the sweep-filed bead ids the flood
 * guard scored, and when. A sweep worker can file a bead with the label sweep colon station on it
 * already (guardNote names that label). A person can add the label by hand too. So dispatch must
 * not trust that label as an already-handled mark: the filer, or any other bd caller, can set it.
 * This state lives under FACTORY_HOME, where a sweep worker's bd calls never reach. Only dispatch's
 * own guard writes it. */
export type SweepGuardState = Record<string, Record<string, number>>

/** True once dispatch()'s guard has scored `id` for `rig` before: a defer-and-relabel, a kept-and-
 * allowed no-op, or a kept-but-unclassed relabel. The caller must then leave the bead alone, the same
 * as `claude-factory-8pc.12`'s rule for a person's re-queue. */
export const guardHandled = (state: SweepGuardState, rig: string, id: string): boolean =>
  state[rig]?.[id] !== undefined

export function markGuardHandled(
  state: SweepGuardState,
  rig: string,
  id: string,
  now: number,
): SweepGuardState {
  return { ...state, [rig]: { ...(state[rig] ?? {}), [id]: now } }
}

/**
 * Drops a rig's stale marks. `openIds[rig]`, when the caller has it, is that rig's current open
 * bead ids. Closed and absent beads are not in it. This function drops a mark whose id is missing
 * from that set: its bead closed, or no longer exists. It keeps a mark whose id is still in that
 * set, however old (claude-factory-8pc.21). A held bead can stay open well past 48h. It must keep
 * its mark, or dispatch holds it again on the next pass.
 *
 * A rig dispatch did not read this pass (it stayed full, say) has no entry in `openIds`. For that
 * rig only, this function falls back to `maxAgeMs` (default 48h, twice the flood guard's 24h cap
 * window). A bead past `sweepGuard`'s own 24h window is never scored again regardless. So, past
 * that age, a mark dispatch cannot check against a fresh bead list is dead weight. This keeps
 * sweep-guard.json from growing forever, even once a rig drops out of `rigs.json`.
 */
export function pruneGuardState(
  state: SweepGuardState,
  now: number,
  openIds: Record<string, Set<string>> = {},
  maxAgeMs = 48 * 60 * 60 * 1000,
): SweepGuardState {
  const out: SweepGuardState = {}
  for (const [rig, ids] of Object.entries(state)) {
    const open = openIds[rig]
    const kept = Object.fromEntries(
      Object.entries(ids).filter(([id, at]) => (open ? open.has(id) : now - at < maxAgeMs)),
    )
    if (Object.keys(kept).length) out[rig] = kept
  }
  return out
}

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
  return (
    beads
      .flatMap(b => {
        const station = sweepFiler(b)
        return station ? [{ b, station }] : []
      })
      // claude-factory-8pc.13(c): a bead with no `created_at` must stay inside the window (as if
      // filed now), not fall out of it at epoch 0 and so escape the cap and the defer below.
      .map(x => ({ ...x, at: x.b.created_at ? new Date(x.b.created_at).getTime() : now }))
      .filter(x => now - x.at < windowMs)
      .sort((a, c) => a.at - c.at)
      .map((x, i) => ({
        id: x.b.id,
        station: x.station,
        kept: i < cap,
        allowed: i < cap && !!x.b.labels?.some(l => SWEEP_QUEUE_LABELS.includes(l)),
      }))
  )
}

/**
 * The duplicate drift beads (claude-factory-d20): the drift prompt files one bead for each resource,
 * labeled `drift:<key>`, and a model can still file a second one. Of the not-closed beads that share a
 * key, the oldest is the original. Each newer bead that a drift sweep filed (`sweepFiler`) is a
 * duplicate of it. A bead a person filed is never a duplicate. A closed bead is never either side.
 */
export function driftDuplicates(
  beads: (GuardedBead & { status?: string })[],
): { dup: string; original: string }[] {
  const byKey = new Map<string, (GuardedBead & { status?: string })[]>()
  for (const b of beads) {
    if (b.status === 'closed') continue
    for (const l of b.labels ?? []) if (l.startsWith('drift:')) byKey.set(l, [...(byKey.get(l) ?? []), b])
  }
  const at = (b: GuardedBead) => (b.created_at ? new Date(b.created_at).getTime() : Infinity)
  return [...byKey.values()].flatMap(group => {
    const [original, ...rest] = [...group].sort((a, b) => at(a) - at(b))
    return rest.filter(b => sweepFiler(b) === 'drift').map(b => ({ dup: b.id, original: original!.id }))
  })
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
export function dueSweeps(
  def: Factory,
  rig: { name: string; repo: string; sweeps?: string[]; slo?: string; drift?: string },
  state: SweepState,
  liveRuns: LiveRun[],
  now: number,
): string[] {
  const names = (rig.sweeps ?? sweepNames(def)).filter(s => def.nodes[s]?.everyMin)
  return names.filter(s => {
    if (s === 'monitor' && !rig.slo) return false
    if (s === 'drift' && !rig.drift) return false
    const goal = sweepGoal(s)
    if (liveRuns.some(r => r.repo === rig.repo && r.goal === goal)) return false
    const lastAt = state[rig.name]?.[s]?.lastAt ?? 0
    return now - lastAt >= def.nodes[s]!.everyMin! * 60_000
  })
}
