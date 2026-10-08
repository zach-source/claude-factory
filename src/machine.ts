// A factory definition compiled to an xstate machine. Pure: no I/O, every
// event carries its own `at`, so a run is a fold over its events and the
// persisted snapshot is the whole truth. The runner (cli.ts) does the effects.
import { assign, setup } from 'xstate'

/**
 * where an outcome goes: a node id or 'done'; or an object whose `delayMin` parks the run, with no worker,
 * that long first, and whose `defer` (into 'done' only) ends the run but leaves its tracked work open for a person
 */
export type Edge = string | { to: string; delayMin?: number; defer?: true }
export const edgeTo = (e: Edge) => (typeof e === 'string' ? e : e.to)
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
  /** worker command for this node, overrides the factory's */
  agent?: string
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
export type Entry = { node: string; attempt: number; outcome: string; summary: string; at: number }

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
    /** the worker waits on something outside the run (a person, another run, a review): park, spend no attempt */
    | { type: 'BLOCKED'; seq: number; reason: string }
    | { type: 'MAIL'; from: string; to: string; text: string }
    | { type: 'READ'; box: string; seen: number }
    | { type: 'RETRY' }
    | { type: 'GOTO'; node: string }
    | { type: 'ABORT'; reason?: string }
  )

export const RESERVED = new Set(['done', 'aborted', 'manager', 'fail'])

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
        ...Object.entries(node.next ?? {}).flatMap(([outcome, edge]) => [
          (outcome === 'fail' || outcome === 'blocked') && `${id}: outcome "${outcome}" is reserved`,
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

/** how long a station parks: parkMin, doubled for each blocked report it already made in a row, at most 8h */
export const parkDelayMin = (c: Ctx, node: string, parkMin: number) => {
  let n = 0
  for (let i = c.log.length - 1; i >= 0 && c.log[i]?.node === node && c.log[i]?.outcome === 'blocked'; i--)
    n++
  return Math.min(parkMin * 2 ** n, Math.max(parkMin, 480))
}

export function compile(def: Factory) {
  validate(def)
  const m = setup({ types: { context: {} as Ctx, events: {} as Ev } })
  const isCurrent = ({ context, event }: { context: Ctx; event: Ev }) =>
    'seq' in event && event.seq === context.seq

  const nodeState = (id: string, node: Node) => {
    const attempts = 1 + (node.retries ?? 2)
    const recordFail = assign(({ context, event }: { context: Ctx; event: Ev }) => {
      const summary = (event as Extract<Ev, { type: 'FAIL' }>).reason
      return {
        log: [...context.log, { node: id, attempt: context.attempt, outcome: 'fail', summary, at: event.at }],
      }
    })
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
            DONE: Object.entries(node.next).map(([outcome, edge]) => ({
              guard: ({ context, event }: { context: Ctx; event: Ev }) =>
                isCurrent({ context, event }) && event.type === 'DONE' && event.outcome === outcome,
              target: `#factory.${edgeTo(edge)}`,
              reenter: true, // a self-loop (iterate -> iterate) starts a fresh worker
              actions: assign(({ context, event }: { context: Ctx; event: Ev }) => {
                const { summary, at } = event as Extract<Ev, { type: 'DONE' }>
                const log = [...context.log, { node: id, attempt: context.attempt, outcome, summary, at }]
                const to = edgeTo(edge) === 'done' ? 'manager' : edgeTo(edge)
                const mail = post(context.mail, to, { from: id, text: summary, at })
                const delay = delayOf(edge)
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
              }),
            })),
            BLOCKED: {
              guard: isCurrent,
              target: 'waiting',
              actions: assign(({ context, event }) => {
                const { reason, at } = event as Extract<Ev, { type: 'BLOCKED' }>
                // each report that finds it still blocked doubles the wait, up to 8h: a re-check is a whole worker
                const wakeAt = at + parkDelayMin(context as Ctx, id, node.parkMin ?? 60) * 60_000
                const text = `${id} is parked, waiting on: ${reason}. It checks again at ${new Date(wakeAt).toISOString()}, or sooner when its station is mailed.`
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
                  isCurrent({ context, event }) && context.attempt < attempts,
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
                    return {
                      error: reason,
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
