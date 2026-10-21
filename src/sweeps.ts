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
  'sweep-queue:flaky-test',
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
      .map(x => {
        const t = x.b.created_at ? new Date(x.b.created_at).getTime() : now
        return { ...x, at: Number.isFinite(t) ? t : now }
      })
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

/** one row of `gh run list --json workflowDatabaseId,workflowName,headSha,conclusion,status,databaseId,createdAt,url,event` */
export type GhRun = {
  workflowDatabaseId: number
  workflowName: string
  headSha: string
  conclusion: string
  status: string
  databaseId: number
  createdAt: string
  url: string
  event: string
  attempt?: number
}

export type CiRed = { key: string; workflowId: number; workflow: string; sha: string; url: string }

/** the dedupe key of a red main streak: the workflow id and the first failing SHA */
export const ciKey = (workflowId: number, sha: string): string => `ci-red:${workflowId}-${sha.slice(0, 7)}`

const RED = ['failure', 'timed_out', 'startup_failure']
const counted = (r: GhRun): boolean =>
  r.status === 'completed' &&
  !r.event.startsWith('pull_request') &&
  (r.conclusion === 'success' || RED.includes(r.conclusion))

/** Per workflow, reports the red newest counted run of main. A pull_request event, an unfinished run
 * and a cancelled, skipped, neutral or action_required run are not counted. The SHA is the oldest run
 * of the newest unbroken red streak, so a later red push keeps the same key. */
export function mainCiReds(runs: GhRun[]): CiRed[] {
  const by = new Map<number, GhRun[]>()
  for (const r of runs.filter(counted))
    by.set(r.workflowDatabaseId, [...(by.get(r.workflowDatabaseId) ?? []), r])
  const out: CiRed[] = []
  for (const [id, rs] of by) {
    rs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    if (!RED.includes(rs[0]!.conclusion)) continue
    let first = rs[0]!
    for (const r of rs) {
      if (!RED.includes(r.conclusion)) break
      first = r
    }
    out.push({
      key: ciKey(id, first.headSha),
      workflowId: id,
      workflow: rs[0]!.workflowName,
      sha: first.headSha,
      url: rs[0]!.url,
    })
  }
  return out
}

/** The reds with no open bead. A label with the prefix `ci-red:<workflow id>-` also tracks the red:
 * a streak longer than the run window moves its first failing SHA, and must not file a second bead. */
export const newCiReds = (reds: CiRed[], openLabels: Set<string>): CiRed[] =>
  reds.filter(r => ![...openLabels].some(l => l.startsWith(`ci-red:${r.workflowId}-`)))

/** a run whose failed log holds a flaky test; `attempt` picks the failed attempt of a re-run */
export type FlakyRun = { id: number; url: string; attempt?: number }

/** The runs to read failed logs from. A SHA is flaky when one workflow ran it red and green: each
 * red run is a flaky run. A green run on attempt 2 or later is flaky too: its last failed attempt is. */
export function flakyRuns(runs: GhRun[]): FlakyRun[] {
  const cs = runs.filter(counted)
  const green = new Set(
    cs.filter(r => r.conclusion === 'success').map(r => `${r.workflowDatabaseId}/${r.headSha}`),
  )
  return cs.flatMap(r => {
    if (RED.includes(r.conclusion))
      return green.has(`${r.workflowDatabaseId}/${r.headSha}`) ? [{ id: r.databaseId, url: r.url }] : []
    return (r.attempt ?? 1) > 1 ? [{ id: r.databaseId, url: r.url, attempt: r.attempt! - 1 }] : []
  })
}

const HOSTILE = new RegExp(
  '[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]',
)
const TEST_ID = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/
const FAIL_LINE = [
  /\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/, // bun
  /--- FAIL: (\S+)/, // go
  /FAILED (\S+::\S+)/, // pytest
]

/** The distinct failed test ids in a CI log (bun, go and pytest formats). A CI log can come from a
 * fork branch, so it is hostile: a line with a control, bidi or line-break character is dropped, and
 * an id must be 1 to 200 printable ASCII characters that do not look like a mail header. */
export function failedTests(log: string): string[] {
  const out = new Set<string>()
  for (const line of log.split('\n')) {
    if (HOSTILE.test(line)) continue
    for (const re of FAIL_LINE) {
      const id = re.exec(line)?.[1]
      if (id && TEST_ID.test(id) && !/(^|\s)-?\s*from \S+:/i.test(id)) out.add(id)
    }
  }
  return [...out]
}

/** the dedupe key of a flaky test: a hash of its id, so the label stays short and safe */
export const flakeKey = (id: string): string =>
  `flake:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`

export type FlakeCandidate = { id: string; key: string; n: number; queue: boolean; urls: string[] }

/** Flaky tests to file: a test that failed in 2 or more flaky runs (a run counts once). It starts on
 * its own (`queue`) at 3 or more. A key on an open bead is dropped. Most runs first, then id; at most `cap`. */
export function flakeCandidates(
  runs: { url: string; tests: string[] }[],
  openLabels: Set<string>,
  cap = 3,
): FlakeCandidate[] {
  const by = new Map<string, string[]>()
  for (const r of runs) for (const t of new Set(r.tests)) by.set(t, [...(by.get(t) ?? []), r.url])
  return [...by]
    .map(([id, urls]) => ({ id, key: flakeKey(id), n: urls.length, queue: urls.length >= 3, urls }))
    .filter(c => c.n >= 2 && !openLabels.has(c.key))
    .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))
    .slice(0, cap)
}
