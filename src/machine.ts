// A factory definition compiled to an xstate machine. Pure: no I/O, every
// event carries its own `at`, so a run is a fold over its events and the
// persisted snapshot is the whole truth. The runner (cli.ts) does the effects.
import { assign, setup } from 'xstate'
import { NAME } from './beads'

/**
 * The outcome goes to a node id, or to 'done'. An edge can also be an object. Its `to` field holds
 * the node id or 'done'.
 *
 * The `delayMin` field parks the run for that many minutes. No worker runs in this interval. Then
 * the run moves on.
 *
 * The `defer` field (`to: 'done'` only) ends the run. The work stays open for a person to pick up.
 * `defer: { station }` also moves the bead's `station:*` label, so the run after an undefer starts
 * at that station. The station must be a node of the same factory.
 *
 * The `reject` field (`to: 'done'` only) also ends the run. The work stays open and ready. It stays
 * out of the factory's queue until a person queues it again.
 *
 * The `requeue` field (`to: 'done'` only) also ends the run. It keeps the bead ready and
 * factory-labeled, not closed or deferred. The next dispatch starts a new run for the bead.
 *
 * The `ship` field (`to: 'done'` only) also ends the run. The runner hands the bead to the rig's ship
 * run: it keeps the bead open, drops its factory label, and labels it `ship`. Do not name it
 * `handoff`: that is a worker outcome (a context handoff). Use only one of defer, reject, requeue, ship.
 *
 * With `requeue: true`, the bead keeps its own `factory:<name>` and `station:<name>` labels, as the
 * worker set them. The `requeue` object names the factory, the station, or the two, to continue at.
 * It replaces each label that its fields name.
 */
export type Edge =
  | string
  | {
      to: string
      delayMin?: number
      defer?: true | { station: string }
      reject?: true
      requeue?: true | { factory?: string; station?: string }
      ship?: true
    }
export const edgeTo = (e: Edge) => (typeof e === 'string' ? e : e.to)
/** the factory has an edge that hands its bead to the ship queue */
export const hasShipEdge = (def: { nodes: Record<string, { next?: Record<string, Edge> }> }) =>
  Object.values(def.nodes).some(n => Object.values(n.next ?? {}).some(e => typeof e === 'object' && !!e.ship))
const delayOf = (e: Edge) => (typeof e === 'string' ? 0 : (e.delayMin ?? 0))

export type Node = {
  /** the worker's task; for a gate, the question put to the person */
  prompt: string
  /** outcome reported by the worker (or decided at a gate) -> where the run goes */
  next: Record<string, Edge>
  /** no worker: the person decides the outcome through the manager (`factory decide`) */
  gate?: true
  /** extra attempts after the first failure before the node is stuck (default 2) */
  retries?: number
  /** minutes a worker that reported blocked is parked before a fresh one checks again (default 60) */
  parkMin?: number
  /** minutes before a silent worker counts as failed (default 60) */
  timeoutMin?: number
  /**
   * The station can report one outcome this many times in a run. Review's `changes` is one example.
   * Only an outcome that loops back counts: its edge goes to this node, to a node on
   * this node's shortest path from `start`, or to a node that cannot end the run. An outcome that goes to
   * `done`, or to an off-path node that can end the run (review's `security`), never counts.
   * When `onRounds` is set, the next such report re-plans the run.
   * With no `onRounds`, the next report holds for the manager instead.
   * A loop that does not converge by then needs a new design, or a person.
   */
  rounds?: number
  /**
   * A capped round re-plans to this node (lifecycle's review re-plans to 'plan').
   * This node gets one mail, which holds every round's summary.
   * A loop that misses `rounds` needs a new design, not another hand goto.
   * A second cap in the same run still holds for the manager, as it does today with no `onRounds`.
   * `validate` refuses an `onRounds` with no `rounds`, or one that names an unknown node, `'done'`, or the node itself.
   */
  onRounds?: string
  /**
   * Set this field to an outcome. The outcome must be a key of `next`.
   * The factory mails the manager when the station reports this outcome two times in a row.
   *
   * Both reports must share a failing acceptance-criterion id.
   * The `failingAcIds` function reads only the `Failing: AC2, AC6` line in each report (machine.ts:302).
   * A passing AC named elsewhere in the report text does not count.
   *
   * A `fail`, `blocked` or `handoff` report between the two reports does not change the count.
   * A re-plan starts the count again in two cases.
   *
   * In the first case, the node at its `rounds` limit moves the run to its `onRounds` target.
   * The log entry for this move carries `replan: true`.
   * The second case is a manager `goto` to a re-plan target.
   * A re-plan target is a node that another node names in its `onRounds` field.
   * This target then reports in between.
   *
   * Each case changes the numbers of the acceptance criteria.
   * A shared id across a re-plan is a coincidence, not a real repeat.
   *
   * The run still follows the normal edge of the outcome.
   * For example, verify reports `red`.
   * A repeat on one criterion needs direction from a person.
   * It does not get an automatic second attempt.
   * `validate` refuses a `repeatMail` value that is not a key of `next`.
   */
  repeatMail?: string
  /** worker command for this node, overrides the factory's */
  agent?: string
  /**
   * where this station's workers run whatever the rig's runner (`herdr`, `ax`): a station that needs the
   * laptop (its kubectl, its network, production) stays on herdr when the rig sends its workers to VMs
   */
  runner?: string
  /**
   * No worker starts here while the arriving report names a pull or merge request. The run parks
   * instead, the same way a worker's own blocked report does. The watch wakes it on a merge, a close, or
   * any later activity. `validate` refuses this field on a gate: a gate has no worker to hold back.
   */
  awaitsPr?: true
  /**
   * Marks this node a sweep station. `sweep()` runs it at most once per `everyMin` minutes, for each
   * rig. No person or other station sends work to it. `validate` requires a value greater than 0.
   * `src/sweeps.ts`'s `sweepNames` function reads every node that carries this field.
   */
  everyMin?: number
  /**
   * The attempt right after a timeout. This attempt gets a longer limit and an extra brief section,
   * not the plain retry every other failure gets. `timeoutMin` must exceed the node's own (default 60).
   * The brief adds `prompt`, so the retried worker can start from a summary, not read everything again.
   * `validate` refuses this field on a gate: a gate has no worker to time out.
   */
  onTimeout?: { timeoutMin: number; prompt?: string }
}

export type Factory = {
  name: string
  start: string
  /** worker command; the prompt is appended as one argument */
  agent?: string
  /**
   * what worker commands name as {name} (the launcher, the models), with their defaults; a rig's
   * `--param name=value` and the environment's FACTORY_<NAME> override them
   */
  params?: Record<string, string>
  /** first retry delay, doubled per attempt (default 30) */
  backoffSec?: number
  /** worker launches a run may make before it pages the manager (default 20); RETRY and every timed edge grant as many again */
  maxSteps?: number
  /**
   * thousands of tokens a Claude worker's context may reach before it is asked to commit and hand off to a
   * fresh worker (default 200): every turn re-reads the whole context, so a long session costs quadratically
   */
  maxContextK?: number
  /** house rules every worker's brief carries */
  rules?: string
  nodes: Record<string, Node>
}

/**
 * a factory file that extends another (`extends`: a factory name or path): its nodes add stations to
 * the base's or change the fields they name, `next` outcome by outcome, so wiring a new station in is
 * one outcome on the station before it; params merge, rules append, anything else replaces the base's
 */
export type Extension = Partial<Omit<Factory, 'nodes'>> & {
  extends: string
  nodes?: Record<string, Partial<Node>>
}

export function extend(base: Factory, ext: Omit<Extension, 'extends'>): Factory {
  const { nodes = {}, params, rules, ...rest } = ext
  const merged = Object.entries(nodes).map(([id, n]) => {
    const was = base.nodes[id]
    return [id, was ? { ...was, ...n, next: { ...was.next, ...n.next } } : n] as const
  })
  return {
    ...base,
    ...rest,
    ...((base.params || params) && { params: { ...base.params, ...params } }),
    ...((base.rules || rules) && { rules: [base.rules, rules].filter(Boolean).join('\n') }),
    nodes: { ...base.nodes, ...(Object.fromEntries(merged) as Record<string, Node>) },
  }
}

export type Mail = { from: string; text: string; at: number }
export type Entry = {
  node: string
  attempt: number
  outcome: string
  summary: string
  at: number
  /** set only on the log entry a round cap's own re-plan writes (the `onRounds` DONE guard), never
   * on a manager `goto plan` after a stuck hold: metrics' `capReplans` counts this field, not every
   * review-then-plan pair, and `repeatMail` reads it to stop comparing acceptance-criterion ids
   * across a re-plan (claude-factory-qgz, review round 1 findings .8 and .9) */
  replan?: true
}

export type Ctx = {
  /** bumps on every worker launch; reports must quote it, so stale ones drop */
  seq: number
  attempt: number
  pane: string | null
  /** the worker's own Claude session, so a lost pane resumes the conversation instead of restarting it */
  session: string | null
  resumes: number
  startedAt: number
  /** when the worker was last nudged or seen working: its idle time counts from here */
  nudgedAt: number
  /** nudges since the worker was last seen working */
  nudges: number
  retryAt: number
  /** launches allowed before the run is held as stuck */
  budget: number
  /** 0, or when a timed edge lets the node's worker start */
  wakeAt: number
  error: string | null
  /** a node's box holds its whole visit: emptied when the node is left, so retries see it all */
  mail: Record<string, Mail[]>
  /** how much of each box its reader (the current worker, the manager) has seen */
  seen: Record<string, number>
  log: Entry[]
}

type At = { at: number }
export type Ev = At &
  (
    | { type: 'TICK' }
    | { type: 'SPAWNED'; seq: number; pane: string; isResume?: boolean }
    | { type: 'SESSION'; seq: number; session: string }
    | { type: 'NUDGED'; seq: number }
    | { type: 'WORKING'; seq: number }
    /** a worker brought back after the factory was stopped: its clock and its nudges start over */
    | { type: 'RESUMED'; seq: number; pane: string }
    | { type: 'DONE'; seq: number; outcome: string; summary: string }
    | { type: 'FAIL'; seq: number; reason: string }
    /** the worker's context grew too long: a fresh worker carries on from its notes, spending no attempt */
    | { type: 'HANDOFF'; seq: number; summary: string }
    /** the worker waits on something outside the run (a person, another run, a review): park, spend no attempt */
    | { type: 'BLOCKED'; seq: number; reason: string }
    | { type: 'MAIL'; from: string; to: string; text: string }
    | { type: 'READ'; box: string; seen: number }
    /** the runner's watch took a parked station's outcome from its pull request, with no worker (claude-factory-5wav) */
    | { type: 'ROUTE'; node: string; outcome: string; summary: string }
    /** the runner's watch found a parked station's pull requests unchanged: park again until a later wakeAt */
    | { type: 'REPARK'; node: string; wakeAt: number }
    | { type: 'RETRY' }
    | { type: 'GOTO'; node: string }
    | { type: 'ABORT'; reason?: string }
  )

export const RESERVED = new Set(['done', 'aborted', 'manager', 'fail'])
/** outcomes every worker can report, which no station may define */
export const WORKER_OUTCOMES = ['fail', 'blocked', 'handoff']

const PARAM = /\{([a-z][a-z0-9_]*)\}/g
/** a worker command with its {name}s filled in; a name `params` lacks stays as it is */
export const fill = (cmd: string, params: Record<string, string>) =>
  cmd.replace(PARAM, (all, name: string) => params[name] ?? all)

export function validate(def: Factory): Factory {
  const ids = Object.keys(def.nodes ?? {})
  const commands = [def.agent, ...ids.map(id => def.nodes[id]!.agent)].filter(Boolean) as string[]
  const unknown = [...new Set(commands.flatMap(c => [...c.matchAll(PARAM)].map(m => m[1]!)))].filter(
    name => !(name in (def.params ?? {})),
  )
  const problems = [
    !def.name && 'name is required',
    unknown.length && `agent names {${unknown.join('}, {')}}, which params does not give`,
    !ids.includes(def.start) && `start "${def.start}" is not a node`,
    ...ids.filter(id => RESERVED.has(id)).map(id => `node id "${id}" is reserved`),
    ...ids.flatMap(id => {
      const node = def.nodes[id]!
      return [
        typeof node.prompt !== 'string' && `${id}: has no prompt`,
        !Object.keys(node.next ?? {}).length && `${id}: has no outcomes`,
        node.gate && node.agent && `${id}: a gate has no worker, so no agent`,
        node.gate && node.runner && `${id}: a gate has no worker, so no runner`,
        node.gate && node.awaitsPr && `${id}: a gate has no worker, so nothing to hold back`,
        node.gate && node.onTimeout && `${id}: a gate has no worker, so no onTimeout`,
        node.onTimeout &&
          !(node.onTimeout.timeoutMin > (node.timeoutMin ?? 60)) &&
          `${id}: onTimeout.timeoutMin must be greater than timeoutMin (${node.timeoutMin ?? 60})`,
        node.rounds !== undefined && !(node.rounds >= 1) && `${id}: rounds is at least 1`,
        node.everyMin !== undefined && !(node.everyMin > 0) && `${id}: everyMin is greater than 0`,
        node.onRounds !== undefined && node.rounds === undefined && `${id}: onRounds needs rounds`,
        node.onRounds === id && `${id}: onRounds must not be the node itself`,
        node.onRounds === 'done' && `${id}: onRounds must not be "done"`,
        node.onRounds !== undefined &&
          node.onRounds !== id &&
          node.onRounds !== 'done' &&
          !ids.includes(node.onRounds) &&
          `${id}: onRounds goes to unknown node "${node.onRounds}"`,
        node.repeatMail !== undefined &&
          !Object.keys(node.next ?? {}).includes(node.repeatMail) &&
          `${id}: repeatMail "${node.repeatMail}" is not an outcome in next`,
        ...Object.entries(node.next ?? {}).flatMap(([outcome, edge]) => [
          WORKER_OUTCOMES.includes(outcome) && `${id}: outcome "${outcome}" is reserved`,
          edgeTo(edge) !== 'done' &&
            !ids.includes(edgeTo(edge)) &&
            `${id}: outcome "${outcome}" goes to unknown node "${edgeTo(edge)}"`,
          typeof edge !== 'string' &&
            edge.delayMin !== undefined &&
            !(edge.delayMin > 0) &&
            `${id}: outcome "${outcome}" needs delayMin > 0`,
          typeof edge !== 'string' &&
            edge.defer &&
            edge.to !== 'done' &&
            `${id}: only an edge into done defers`,
          typeof edge !== 'string' &&
            edge.reject &&
            edge.to !== 'done' &&
            `${id}: only an edge into done rejects`,
          typeof edge !== 'string' &&
            typeof edge.defer === 'object' &&
            !ids.includes(edge.defer.station) &&
            `${id}: outcome "${outcome}" defer station "${edge.defer.station}" is not a node`,
          typeof edge !== 'string' &&
            edge.defer &&
            edge.reject &&
            `${id}: an edge defers or rejects, not both`,
          typeof edge !== 'string' &&
            edge.requeue &&
            edge.to !== 'done' &&
            `${id}: only an edge into done requeues`,
          typeof edge !== 'string' &&
            edge.requeue &&
            (edge.defer || edge.reject) &&
            `${id}: an edge defers, rejects or requeues, only one`,
          typeof edge !== 'string' &&
            edge.ship &&
            edge.to !== 'done' &&
            `${id}: only an edge into done ships`,
          typeof edge !== 'string' &&
            edge.ship &&
            (edge.defer || edge.reject || edge.requeue) &&
            `${id}: an edge defers, rejects, requeues or ships, only one`,
          ...(typeof edge !== 'string' && typeof edge.requeue === 'object'
            ? (['factory', 'station'] as const)
                .map(k => edge.requeue && typeof edge.requeue === 'object' && edge.requeue[k])
                .filter((name): name is string => !!name && !NAME.test(name))
                .map(name => `${id}: outcome "${outcome}" requeue name "${name}" is invalid`)
            : []),
        ]),
      ]
    }),
  ].filter(Boolean)
  if (problems.length) throw new Error(`factory ${def.name ?? '?'}:\n  ${problems.join('\n  ')}`)
  return def
}

const post = (mail: Ctx['mail'], to: string, m: Mail) => ({ ...mail, [to]: [...(mail[to] ?? []), m] })
const withMail = ({ context, event }: { context: Ctx; event: Ev }) => {
  const { from, to, text, at } = event as Extract<Ev, { type: 'MAIL' }>
  return { mail: post(context.mail, to, { from, text, at }) }
}
/** parked by its own worker's blocked report, as opposed to waiting out a timed edge */
export const isParked = (c: Ctx, node: string) => {
  const last = c.log.at(-1)
  return last?.node === node && last.outcome === 'blocked'
}

/** the kind of failure a reason names when retrying it unchanged is unlikely to help: the worker went silent */
export const failClass = (reason: string) =>
  /^no report within/.test(reason)
    ? 'timeout'
    : /^stalled/.test(reason)
      ? 'stalled'
      : /^(the )?worker never started/.test(reason)
        ? 'unstarted'
        : null

/** whether a failure repeats the station's previous attempt's: the same silent kind, so another attempt would spend itself the same way */
export const isRepeatFail = (c: Ctx, node: string, reason: string) => {
  const last = c.log.at(-1)
  const kind = failClass(reason)
  return (
    c.attempt > 1 &&
    !!kind &&
    last?.node === node &&
    last.outcome === 'fail' &&
    failClass(last.summary) === kind
  )
}

/** the question a repeated failure puts to the person in the console's Interview tab */
export const repeatQuestion = (node: string, reason: string) =>
  `${reason}\nQuestion: ${node} failed twice the same way (${reason}). What should it do?\nOptions: retry: run ${node} again with your answer | abort: end the run`

/** every acceptance-criterion id a text cites (`AC3`, `AC-3`, case-insensitive), normalized to `AC<n>` */
export const acIdsIn = (text: string): string[] => [
  ...new Set([...text.matchAll(/\bAC-?(\d+)\b/gi)].map(m => `AC${m[1]}`)),
]

/** Get the failing ids from one `Failing: AC2, AC6` line (lifecycle's verify prompt needs this
 * line). Skip any AC id the report calls passing in its other text. Two red reports that each
 * name one passing AC must not look like a repeat on that AC (claude-factory-qgz, review round 1
 * finding .9: `acIdsIn` read the whole report and did that). */
export const failingAcIds = (text: string): string[] => {
  const line = text.match(/^\s*Failing:\s*(.+)$/im)
  return line ? acIdsIn(line[1]!) : []
}

/** a node's previous report whose outcome is one `next` names: `repeatMail` compares the arriving
 * report against this one, not any log entry, so a `fail`, `blocked` or `handoff` in between does
 * not break the streak (those outcomes are never a key of `next`) */
export const prevReport = (log: Entry[], node: string, next: Record<string, unknown>): Entry | undefined => {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!
    if (e.node === node && Object.hasOwn(next, e.outcome)) return e
  }
  return undefined
}

/** every node some other node's `onRounds` names: a manager `goto` to one of these, that then
 * reports, is a re-plan too, even with no `replan: true` entry (claude-factory-qgz, review round 2
 * finding .11: a manager `goto plan` writes no log entry itself, only `plan`'s own later report) */
export const replanTargets = (def: Factory): Set<string> =>
  new Set(
    Object.values(def.nodes)
      .map(n => n.onRounds)
      .filter((x): x is string => !!x),
  )

/** the manager mail a repeated outcome on the same acceptance-criterion id sends (claude-factory-qgz AC6) */
export const repeatMailText = (node: string, outcome: string, ids: string[], prevAt: number, at: number) =>
  `${node} reported ${outcome} again on ${ids.join(', ')}: first at ${new Date(prevAt).toISOString()}, ` +
  `again at ${new Date(at).toISOString()}. Read both reports and either mail implement a concrete steer ` +
  `or goto plan; never goto implement with no new direction.`

/** the mail a capped round's re-plan sends: every round's own-outcome summary so far, oldest first,
 * each clipped so the whole message stays near 24000 chars (claude-factory-qgz AC2) */
export function capReplanMail(prior: Entry[], node: string, outcome: string, latest: string): string {
  const summaries = [
    ...prior.filter(e => e.node === node && e.outcome === outcome).map(e => e.summary),
    latest,
  ]
  const cap = Math.floor(24_000 / summaries.length)
  const clip = (s: string) => (s.length > cap ? `${s.slice(0, cap)} [clipped]` : s)
  const rounds = summaries.map((s, i) => `### ${node} round ${i + 1}\n${clip(s)}`).join('\n\n')
  return (
    `${node} hit its round cap reporting ${outcome} again. Find the cause the rounds missed, then ` +
    `change the design, narrow the scope or split the work.\n\n${rounds}`
  )
}

/**
 * whether the node's own run of log entries, read back from the end, holds a timeout fail. A fresh
 * arrival from elsewhere ends that run at once: its last entry belongs to another station. A backoff
 * retry, a handoff, or the manager's RETRY all keep the timeout entry in the log, so each still sees
 * it as true. A later fail of another kind at the same node does not end the run either: the timeout
 * entry is still in it, so this stays true until the node is left for a different one.
 */
export const afterTimeout = (c: Ctx, node: string) => {
  for (let i = c.log.length - 1; i >= 0 && c.log[i]?.node === node; i--) {
    if (c.log[i]?.outcome === 'fail' && failClass(c.log[i]!.summary) === 'timeout') return true
  }
  return false
}

/** the timeout minutes a node's next launch gets: its `onTimeout` limit once its tail shows a timeout fail, else its own */
export const timeoutOf = (node: Node, c: Ctx, id: string) =>
  node.onTimeout && afterTimeout(c, id) ? node.onTimeout.timeoutMin : (node.timeoutMin ?? 60)

/** the pull requests a blocked report names: the runner watches them and mails the station when one changes */
export const prsIn = (text: string) => [
  ...new Set(text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []),
]
/** every GitLab merge request URL in a text; `prsIn` stays GitHub-only because the park watch behind it
 * runs `gh pr view` (prs.ts re-exports this, since its glab-shaped IO lives there) */
export const mrsIn = (text: string) => [
  ...new Set(
    text.match(
      /https:\/\/(?!github\.com\/)[\w.-]+(?::\d+)?\/(?:[\w.-]+\/)+[\w.-]+\/-\/merge_requests\/\d+/g,
    ) ?? [],
  ),
]
/** how long a station that waits on pull requests parks: the watch wakes it sooner, so this only backstops it */
export const WATCHED_PARK_MIN = 480

/** a pre-launch park: an `awaitsPr` station's arrival named a pull or merge request before any worker of
 * this visit ran, so it holds its own attempt-0 slot in the log instead of a real worker's blocked report */
export const isPrWait = (e?: Entry) => e?.outcome === 'blocked' && e?.attempt === 0

/** an entry no worker made: a pre-launch park, or an outcome the watch routed from a pull request (ROUTE) */
export const isNoWorker = (e?: Entry) => e?.attempt === 0

/** the log entry an awaitsPr park's arrival gets, instead of a worker ever starting */
export const prWaitSummary = (urls: string[]) =>
  `no worker yet: waiting for ${urls.join(', ')} to merge, close or change`

/** how long a station parks: parkMin, doubled for each blocked report it already made in a row, at most 8h.
 * A pre-launch park (`isPrWait`) spent no worker, so this skips it rather than counting it. */
export const parkDelayMin = (c: Ctx, node: string, parkMin: number) => {
  let n = 0
  for (let i = c.log.length - 1; i >= 0 && c.log[i]?.node === node; i--) {
    if (c.log[i]?.outcome !== 'blocked') break
    if (!isPrWait(c.log[i])) n++
  }
  return Math.min(parkMin * 2 ** n, Math.max(parkMin, 480))
}

/** how many blocked reports in a row, at one station, hand the bead to its owner */
export const OWNER_BLOCKED_PASSES = 3
/** how long the first park of a blocked streak may last before the bead goes to its owner */
export const OWNER_AFTER_MS = 24 * 3_600_000
/** a blocked report that names a step only the owner can do */
export const isOwnerStep = (text: string) =>
  /\bowner[- ]?(?:only|step|action|decision|input|call)\b|\b(?:waiting|waits?) (?:on|for) (?:the |its )?owner\b/i.test(
    text,
  )

/**
 * Decides if a blocked run ends and its bead goes to the owner. It reads the trailing blocked reports
 * at the last station. A pre-launch PR park (`isPrWait`) spent no worker and counts for nothing. Any
 * other outcome ends the streak. True when the last report names an owner step, when the streak has
 * `OWNER_BLOCKED_PASSES` reports, or when its first report is older than `OWNER_AFTER_MS`.
 */
export const shouldHandToOwner = (log: Entry[], now: number) => {
  const node = log.at(-1)?.node
  const streak: Entry[] = []
  for (let i = log.length - 1; i >= 0 && log[i]?.node === node && log[i]?.outcome === 'blocked'; i--)
    if (!isPrWait(log[i])) streak.push(log[i]!)
  if (!streak.length) return false
  return (
    isOwnerStep(streak[0]!.summary) ||
    streak.length >= OWNER_BLOCKED_PASSES ||
    now - streak.at(-1)!.at > OWNER_AFTER_MS
  )
}

export function compile(def: Factory) {
  validate(def)
  const m = setup({ types: { context: {} as Ctx, events: {} as Ev } })
  const isCurrent = ({ context, event }: { context: Ctx; event: Ev }) =>
    'seq' in event && event.seq === context.seq

  // An outcome counts toward a node's `rounds` only when its edge loops back: the target is the node
  // itself, sits on the node's shortest path from start (BFS parents), or cannot end the run (no edge to
  // done). An edge to done, or to an off-path station that can end the run (review's security), never counts.
  const parent: Record<string, string> = {}
  const seen = new Set([def.start])
  for (const queue = [def.start]; queue.length;) {
    const q = queue.shift()!
    for (const e of Object.values(def.nodes[q]?.next ?? {})) {
      const t = edgeTo(e)
      if (t !== 'done' && !seen.has(t)) {
        seen.add(t)
        parent[t] = q
        queue.push(t)
      }
    }
  }
  const counts = (id: string, node: Node, outcome: string) => {
    const e = node.next[outcome]
    if (!e) return false
    const t = edgeTo(e)
    if (t === 'done') return false
    for (let x: string | undefined = id; x; x = parent[x]) if (x === t) return true
    return !Object.values(def.nodes[t]?.next ?? {}).some(x => edgeTo(x) === 'done')
  }

  const nodeState = (id: string, node: Node) => {
    const attempts = 1 + (node.retries ?? 2)
    const recordFail = assign(({ context, event }: { context: Ctx; event: Ev }) => {
      const summary = (event as Extract<Ev, { type: 'FAIL' }>).reason
      return {
        log: [...context.log, { node: id, attempt: context.attempt, outcome: 'fail', summary, at: event.at }],
      }
    })
    // the edge a node's outcome takes: its log entry, mail, repeat check and the arrival's park or delay.
    // `attempt` is the worker's attempt, or 0 for a route made with no worker (ROUTE).
    const takeEdge = (
      context: Ctx,
      outcome: string,
      edge: Edge,
      summary: string,
      at: number,
      attempt: number,
    ) => {
      const log = [...context.log, { node: id, attempt, outcome, summary, at }]
      const toId = edgeTo(edge)
      const to = toId === 'done' ? 'manager' : toId
      let mail = post(context.mail, to, { from: id, text: summary, at })
      // a repeated miss on the same acceptance criterion (claude-factory-qgz AC6): mail the
      // manager from 'factory', never from `id` (cli.ts's isAsking keys on from === node)
      if (node.repeatMail === outcome) {
        const prev = prevReport(context.log, id, node.next)
        // a re-plan between the two reports renumbers acceptance criteria, so a shared
        // id across it is coincidence, not a real repeat (claude-factory-qgz finding .9).
        // a manager `goto` to a re-plan target writes no entry itself, only that
        // target's later report, so check both the `replan` flag and the target's own
        // node id (claude-factory-qgz, review round 2 finding .11)
        const targets = replanTargets(def)
        const replanned = !!prev && context.log.some(e => e.at > prev.at && (e.replan || targets.has(e.node)))
        if (prev?.outcome === outcome && !replanned) {
          const shared = failingAcIds(summary).filter(x => failingAcIds(prev.summary).includes(x))
          if (shared.length)
            mail = post(mail, 'manager', {
              from: 'factory',
              text: repeatMailText(id, outcome, shared, prev.at, at),
              at,
            })
        }
      }
      const delay = delayOf(edge)
      // an awaitsPr station holds its worker back when the report names a pull or merge
      // request. It parks like a worker's own blocked report. It spends no attempt.
      const urls = !delay && def.nodes[toId]?.awaitsPr ? [...prsIn(summary), ...mrsIn(summary)] : []
      if (urls.length) {
        const reason = prWaitSummary(urls)
        const wakeAt = at + WATCHED_PARK_MIN * 60_000
        const text = `${toId} is parked, waiting on: ${reason}. It checks again when one of its pull requests changes, at the latest ${new Date(wakeAt).toISOString()}, or sooner when its station is mailed.`
        return {
          log: [...log, { node: toId, attempt: 0, outcome: 'blocked', summary: reason, at }],
          mail: post(mail, 'manager', { from: toId, text, at }),
          pane: null,
          wakeAt,
        }
      }
      // the wait already bounds the rate, so a cadence loop refills its budget instead of being held
      // the worker has reported: its pane goes now, not when a timed wait ends
      return delay
        ? {
            log,
            mail,
            pane: null,
            wakeAt: at + delay * 60_000,
            budget: context.seq + (def.maxSteps ?? 20),
          }
        : { log, mail, pane: null }
    }
    return {
      initial: 'waiting',
      entry: assign({ attempt: 1 }),
      exit: assign(({ context }) => ({
        mail: { ...context.mail, [id]: [] },
        seen: { ...context.seen, [id]: 0 },
      })),
      states: {
        // a timed edge parks the run here, with no worker, until wakeAt; any other arrival passes straight through
        // a blocked worker parks here too, and mail to the station wakes it early
        waiting: {
          always: { guard: ({ context }: { context: Ctx }) => context.wakeAt === 0, target: 'working' },
          on: {
            MAIL: [
              {
                guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                  event.type === 'MAIL' && event.to === id && isParked(context, id),
                target: 'working',
                actions: assign(withMail),
              },
              { actions: assign(withMail) },
            ],
            // the watch decided a parked station's outcome from its pull request: no worker runs. A fail,
            // blocked or handoff outcome, or one the station lacks, is refused.
            ROUTE: Object.entries(node.next)
              .filter(([outcome]) => !WORKER_OUTCOMES.includes(outcome))
              .map(([outcome, edge]) => ({
                guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                  event.type === 'ROUTE' &&
                  event.node === id &&
                  event.outcome === outcome &&
                  isParked(context, id),
                target: `#factory.${edgeTo(edge)}`,
                reenter: true,
                actions: assign(({ context, event }: { context: Ctx; event: Ev }) => {
                  const { summary, at } = event as Extract<Ev, { type: 'ROUTE' }>
                  return { wakeAt: 0, ...takeEdge(context, outcome, edge, summary, at, 0) }
                }),
              })),
            // a later wakeAt only: a re-park never makes the station wake sooner
            REPARK: {
              guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                event.type === 'REPARK' &&
                event.node === id &&
                isParked(context, id) &&
                event.wakeAt > context.wakeAt,
              actions: assign(({ event }) => ({ wakeAt: (event as Extract<Ev, { type: 'REPARK' }>).wakeAt })),
            },
            TICK: {
              guard: ({ context, event }: { context: Ctx; event: Ev }) => event.at >= context.wakeAt,
              target: 'working',
            },
          },
        },
        working: {
          // a loop that keeps cycling is held for the manager instead of burning tokens
          always: {
            guard: ({ context }: { context: Ctx }) => context.seq > context.budget,
            target: 'stuck',
            actions: assign(({ context, event }) => {
              const text = `${id} held: the run used its budget of ${context.budget} worker launches; retry grants more`
              return {
                error: 'step budget used up',
                mail: post(context.mail, 'manager', { from: id, text, at: event.at }),
              }
            }),
          },
          entry: assign(({ context }) => ({
            seq: context.seq + 1,
            pane: null,
            session: null,
            resumes: 0,
            startedAt: 0,
            nudgedAt: 0,
            nudges: 0,
            error: null,
            wakeAt: 0,
            seen: { ...context.seen, [id]: 0 },
          })),
          on: {
            SPAWNED: {
              guard: isCurrent,
              actions: assign(({ context, event }) => ({
                pane: event.pane,
                startedAt: event.at,
                resumes: context.resumes + (event.isResume ? 1 : 0),
              })),
            },
            SESSION: { guard: isCurrent, actions: assign(({ event }) => ({ session: event.session })) },
            RESUMED: {
              guard: isCurrent,
              actions: assign(({ event }) => ({
                pane: event.pane,
                startedAt: event.at,
                nudges: 0,
                nudgedAt: event.at,
                resumes: 0,
              })),
            },
            NUDGED: {
              guard: isCurrent,
              actions: assign(({ context, event }) => ({ nudges: context.nudges + 1, nudgedAt: event.at })),
            },
            // a worker that answers a nudge by working is alive (waiting on a background task, say):
            // only nudges it ignores count toward failing it, and the station's timeout bounds the rest
            WORKING: {
              guard: isCurrent,
              actions: assign(({ event }) => ({ nudges: 0, nudgedAt: event.at })),
            },
            // a round is one report of the same outcome. `n` below counts rounds already in the
            // log, before the one arriving now.
            DONE: [
              ...(node.rounds
                ? [
                    // onRounds only: the (R+1)th same-outcome report re-plans instead of holding
                    ...(node.onRounds
                      ? [
                          {
                            guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                              isCurrent({ context, event }) &&
                              event.type === 'DONE' &&
                              counts(id, node, event.outcome) &&
                              context.log.filter(e => e.node === id && e.outcome === event.outcome).length ===
                                node.rounds!,
                            target: `#factory.${node.onRounds}`,
                            reenter: true,
                            actions: assign(({ context, event }: { context: Ctx; event: Ev }) => {
                              const { outcome, summary, at } = event as Extract<Ev, { type: 'DONE' }>
                              const log = [
                                ...context.log,
                                {
                                  node: id,
                                  attempt: context.attempt,
                                  outcome,
                                  summary,
                                  at,
                                  replan: true as const,
                                },
                              ]
                              const text = capReplanMail(context.log, id, outcome, summary)
                              return {
                                log,
                                mail: post(context.mail, node.onRounds!, { from: id, text, at }),
                                pane: null,
                              }
                            }),
                          },
                        ]
                      : []),
                    // held for the manager: past `rounds` with no onRounds, or past `2*rounds + 1`
                    // once onRounds already sent this run through one re-plan
                    {
                      guard: ({ context, event }: { context: Ctx; event: Ev }) => {
                        if (!isCurrent({ context, event }) || event.type !== 'DONE') return false
                        if (!counts(id, node, event.outcome)) return false
                        const n = context.log.filter(e => e.node === id && e.outcome === event.outcome).length
                        return node.onRounds ? n > 2 * node.rounds! : n >= node.rounds!
                      },
                      target: 'stuck',
                      actions: assign(({ context, event }: { context: Ctx; event: Ev }) => {
                        const { outcome, summary, at } = event as Extract<Ev, { type: 'DONE' }>
                        const reason = `${id} reported ${outcome} more than ${node.rounds} times`
                        const already = node.onRounds
                          ? ` ${id} already re-planned once, to ${node.onRounds}.`
                          : ''
                        const text = `${reason}:${already} held instead of going to ${edgeTo(node.next[outcome]!)}. goto a station to go on, retry for a fresh ${id}, or abort. Its report: ${summary}`
                        return {
                          log: [...context.log, { node: id, attempt: context.attempt, outcome, summary, at }],
                          mail: post(context.mail, 'manager', { from: id, text, at }),
                          pane: null,
                          error: reason,
                        }
                      }),
                    },
                  ]
                : []),
              ...Object.entries(node.next).map(([outcome, edge]) => ({
                guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                  isCurrent({ context, event }) && event.type === 'DONE' && event.outcome === outcome,
                target: `#factory.${edgeTo(edge)}`,
                reenter: true, // a self-loop (iterate -> iterate) starts a fresh worker
                actions: assign(({ context, event }: { context: Ctx; event: Ev }) => {
                  const { summary, at } = event as Extract<Ev, { type: 'DONE' }>
                  return takeEdge(context, outcome, edge, summary, at, context.attempt)
                }),
              })),
            ],
            HANDOFF: {
              guard: isCurrent,
              target: 'working',
              reenter: true, // a fresh worker: entry bumps seq and clears the pane
              actions: assign(({ context, event }) => {
                const { summary, at } = event as Extract<Ev, { type: 'HANDOFF' }>
                return {
                  log: [
                    ...context.log,
                    { node: id, attempt: context.attempt, outcome: 'handoff', summary, at },
                  ],
                }
              }),
            },
            BLOCKED: {
              guard: isCurrent,
              target: 'waiting',
              actions: assign(({ context, event }) => {
                const { reason, at } = event as Extract<Ev, { type: 'BLOCKED' }>
                // each report that finds it still blocked doubles the wait, up to 8h: a re-check is a whole worker
                const isWatched = prsIn(reason).length > 0
                const wakeAt =
                  at +
                  (isWatched ? WATCHED_PARK_MIN : parkDelayMin(context as Ctx, id, node.parkMin ?? 60)) *
                    60_000
                const text = `${id} is parked, waiting on: ${reason}. It checks again ${isWatched ? 'when one of its pull requests changes, at the latest' : 'at'} ${new Date(wakeAt).toISOString()}, or sooner when its station is mailed.`
                // the manager hears when a station parks, not each re-check that finds nothing changed
                const last = context.log.at(-1)
                const isRepeat = last?.node === id && last.outcome === 'blocked'
                return {
                  log: [
                    ...context.log,
                    { node: id, attempt: context.attempt, outcome: 'blocked', summary: reason, at },
                  ],
                  mail: isRepeat ? context.mail : post(context.mail, 'manager', { from: id, text, at }),
                  pane: null,
                  wakeAt,
                }
              }),
            },
            FAIL: [
              {
                guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                  isCurrent({ context, event }) &&
                  context.attempt < attempts &&
                  !isRepeatFail(context, id, (event as Extract<Ev, { type: 'FAIL' }>).reason),
                target: 'backoff',
                actions: [
                  recordFail,
                  assign(({ context, event }) => ({
                    error: (event as Extract<Ev, { type: 'FAIL' }>).reason,
                    retryAt: event.at + (def.backoffSec ?? 30) * 1000 * 2 ** (context.attempt - 1),
                  })),
                ],
              },
              {
                guard: isCurrent,
                target: 'stuck',
                actions: [
                  recordFail,
                  assign(({ context, event }) => {
                    const reason = (event as Extract<Ev, { type: 'FAIL' }>).reason
                    const text = `${id} is stuck after ${context.attempt} attempt(s): ${reason}`
                    // a repeat of the last attempt's silent failure: ask the person instead of a third try
                    const isRepeat = isRepeatFail(
                      { ...(context as Ctx), log: context.log.slice(0, -1) },
                      id,
                      reason,
                    )
                    return {
                      error: isRepeat ? repeatQuestion(id, reason) : reason,
                      mail: post(context.mail, 'manager', { from: id, text, at: event.at }),
                    }
                  }),
                ],
              },
            ],
          },
        },
        backoff: {
          on: {
            TICK: {
              guard: ({ context, event }: { context: Ctx; event: Ev }) => event.at >= context.retryAt,
              target: 'working',
              actions: assign(({ context }) => ({ attempt: context.attempt + 1 })),
            },
          },
        },
        // the worker pane stays up here so the manager can inspect it
        stuck: {
          on: {
            RETRY: {
              target: 'working',
              actions: assign(({ context }) => ({ attempt: 1, budget: context.seq + (def.maxSteps ?? 20) })),
            },
          },
        },
      },
    }
  }

  return m.createMachine({
    id: 'factory',
    initial: def.start,
    context: {
      seq: 0,
      attempt: 1,
      pane: null,
      session: null,
      resumes: 0,
      startedAt: 0,
      nudgedAt: 0,
      nudges: 0,
      retryAt: 0,
      budget: def.maxSteps ?? 20,
      wakeAt: 0,
      error: null,
      mail: {},
      seen: {},
      log: [],
    },
    on: {
      MAIL: { actions: assign(withMail) },
      READ: {
        actions: assign(({ context, event }) => ({
          seen: { ...context.seen, [event.box]: event.seen },
        })),
      },
      GOTO: Object.keys(def.nodes)
        .concat('done')
        .map(id => ({
          guard: ({ event }: { event: Ev }) => event.type === 'GOTO' && event.node === id,
          target: `.${id}`,
          reenter: true,
          actions: assign({ wakeAt: 0 }), // goto skips any wait: "run it now"
        })),
      ABORT: '.aborted',
    },
    states: {
      ...Object.fromEntries(Object.entries(def.nodes).map(([id, node]) => [id, nodeState(id, node)])),
      // not final: they still take MAIL/READ, and GOTO revives a run
      done: { entry: assign({ pane: null }) },
      aborted: { entry: assign({ pane: null }) },
    },
  })
}

/** stations the start never leads to (reached only by @station or goto), and stations with no way to done */
export function reach(def: Factory) {
  const next = (id: string) => Object.values(def.nodes[id]?.next ?? {}).map(edgeTo)
  const from = (id: string) => {
    const seen = new Set([id])
    for (const at of seen) for (const to of next(at)) seen.add(to)
    return seen
  }
  const ids = Object.keys(def.nodes)
  const reachable = from(def.start)
  return {
    unreachable: ids.filter(id => !reachable.has(id)),
    trapped: ids.filter(id => !from(id).has('done')),
  }
}

export const unread = (c: Ctx, box: string) => (c.mail[box] ?? []).slice(c.seen[box] ?? 0)

/** 'implement.working' -> ['implement', 'working']; 'done' -> ['done', ''] */
export function where(value: unknown): [string, string] {
  if (typeof value === 'string') return [value, '']
  const [node, sub] = Object.entries(value as Record<string, string>)[0]!
  return [node, sub]
}
