// A factory definition compiled to an xstate machine. Pure: no I/O, every
// event carries its own `at`, so a run is a fold over its events and the
// persisted snapshot is the whole truth. The runner (cli.ts) does the effects.
import { assign, setup } from 'xstate'

/** where an outcome goes: a node id or 'done', or a timed edge that parks the run, with no worker, for delayMin */
export type Edge = string | { to: string; delayMin: number }
export const edgeTo = (e: Edge) => (typeof e === 'string' ? e : e.to)
const delayOf = (e: Edge) => (typeof e === 'string' ? 0 : e.delayMin)

export type Node = {
  /** the worker's task; for a gate, the question put to the person */
  prompt: string
  /** outcome reported by the worker (or decided at a gate) -> where the run goes */
  next: Record<string, Edge>
  /** no worker: the person decides the outcome through the manager (`factory decide`) */
  gate?: true
  /** extra attempts after the first failure before the node is stuck (default 2) */
  retries?: number
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
  /** first retry delay, doubled per attempt (default 30) */
  backoffSec?: number
  /** worker launches a run may make before it pages the manager (default 20); RETRY and every timed edge grant as many again */
  maxSteps?: number
  /** house rules every worker's brief carries */
  rules?: string
  nodes: Record<string, Node>
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
  nudgedAt: number
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
    | { type: 'DONE'; seq: number; outcome: string; summary: string }
    | { type: 'FAIL'; seq: number; reason: string }
    | { type: 'MAIL'; from: string; to: string; text: string }
    | { type: 'READ'; box: string; seen: number }
    | { type: 'RETRY' }
    | { type: 'GOTO'; node: string }
    | { type: 'ABORT'; reason?: string }
  )

export const RESERVED = new Set(['done', 'aborted', 'manager', 'fail'])

export function validate(def: Factory): Factory {
  const ids = Object.keys(def.nodes ?? {})
  const problems = [
    !def.name && 'name is required',
    !ids.includes(def.start) && `start "${def.start}" is not a node`,
    ...ids.filter(id => RESERVED.has(id)).map(id => `node id "${id}" is reserved`),
    ...ids.flatMap(id => {
      const node = def.nodes[id]!
      return [
        !Object.keys(node.next).length && `${id}: has no outcomes`,
        node.gate && node.agent && `${id}: a gate has no worker, so no agent`,
        ...Object.entries(node.next).flatMap(([outcome, edge]) => [
          outcome === 'fail' && `${id}: outcome "fail" is reserved for retries`,
          edgeTo(edge) !== 'done' &&
            !ids.includes(edgeTo(edge)) &&
            `${id}: outcome "${outcome}" goes to unknown node "${edgeTo(edge)}"`,
          typeof edge !== 'string' &&
            !(edge.delayMin > 0) &&
            `${id}: outcome "${outcome}" needs delayMin > 0`,
        ]),
      ]
    }),
  ].filter(Boolean)
  if (problems.length) throw new Error(`factory ${def.name ?? '?'}:\n  ${problems.join('\n  ')}`)
  return def
}

const post = (mail: Ctx['mail'], to: string, m: Mail) => ({ ...mail, [to]: [...(mail[to] ?? []), m] })

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
        waiting: {
          always: { guard: ({ context }: { context: Ctx }) => context.wakeAt === 0, target: 'working' },
          on: {
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
            NUDGED: {
              guard: isCurrent,
              actions: assign(({ context, event }) => ({ nudges: context.nudges + 1, nudgedAt: event.at })),
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
                return delay
                  ? { log, mail, wakeAt: at + delay * 60_000, budget: context.seq + (def.maxSteps ?? 20) }
                  : { log, mail }
              }),
            })),
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
      MAIL: {
        actions: assign(({ context, event }) => ({
          mail: post(context.mail, event.to, { from: event.from, text: event.text, at: event.at }),
        })),
      },
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

export const unread = (c: Ctx, box: string) => (c.mail[box] ?? []).slice(c.seen[box] ?? 0)

/** 'implement.working' -> ['implement', 'working']; 'done' -> ['done', ''] */
export function where(value: unknown): [string, string] {
  if (typeof value === 'string') return [value, '']
  const [node, sub] = Object.entries(value as Record<string, string>)[0]!
  return [node, sub]
}
