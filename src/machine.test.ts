import { expect, test } from 'bun:test'
import { createActor, type Snapshot } from 'xstate'
import {
  afterTimeout,
  compile,
  failClass,
  isPrWait,
  mrsIn,
  parkDelayMin,
  prsIn,
  reach,
  timeoutOf,
  unread,
  validate,
  where,
  WATCHED_PARK_MIN,
  type Ctx,
  type Ev,
  type Factory,
} from './machine'

const def: Factory = {
  name: 'review-loop',
  start: 'implement',
  backoffSec: 10,
  nodes: {
    implement: { prompt: 'build it', next: { ready: 'review' }, retries: 1 },
    review: { prompt: 'review it', next: { changes: 'implement', approve: 'done' } },
    iterate: { prompt: 'again', next: { again: 'iterate', ok: 'done' } },
  },
}

// every event goes through a JSON round trip of the persisted snapshot, as the runner does
function run(d = def) {
  const machine = compile(d)
  let snap: Snapshot<unknown> = createActor(machine).start().getPersistedSnapshot()
  const send = (e: Ev) => {
    const actor = createActor(machine, { snapshot: JSON.parse(JSON.stringify(snap)) }).start()
    actor.send(e)
    snap = actor.getPersistedSnapshot()
    return actor.getSnapshot()
  }
  const now = () => createActor(machine, { snapshot: snap }).start().getSnapshot()
  return { send, now }
}

test('loop graph routes outcomes and carries summaries as mail', () => {
  const { send, now } = run()
  expect(where(now().value)).toEqual(['implement', 'working'])
  expect(now().context.seq).toBe(1)

  send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 1 })
  send({ type: 'SESSION', seq: 1, session: 'abc', at: 1 })
  let s = send({ type: 'SPAWNED', seq: 1, pane: 'w1:p2', isResume: true, at: 1 })
  expect(s.context).toMatchObject({ pane: 'w1:p2', session: 'abc', resumes: 1, seq: 1 })
  s = send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'built', at: 2 })
  expect(where(s.value)).toEqual(['review', 'working'])
  expect(s.context.mail.review).toEqual([{ from: 'implement', text: 'built', at: 2 }])
  expect(s.context).toMatchObject({ pane: null, session: null, resumes: 0 })

  s = send({ type: 'DONE', seq: 2, outcome: 'changes', summary: 'fix the tests', at: 3 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context.mail.implement?.[0]?.text).toBe('fix the tests')
  expect(s.context.seq).toBe(3)

  // a stale report from an earlier worker is dropped
  s = send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'late', at: 4 })
  expect(s.context.seq).toBe(3)

  send({ type: 'DONE', seq: 3, outcome: 'ready', summary: 'fixed', at: 5 })
  s = send({ type: 'DONE', seq: 4, outcome: 'approve', summary: 'lgtm', at: 6 })
  expect(s.value).toBe('done')
  expect(s.context.mail.manager?.[0]?.text).toBe('lgtm')
  expect(s.context.log.map(e => `${e.node}:${e.outcome}`)).toEqual([
    'implement:ready',
    'review:changes',
    'implement:ready',
    'review:approve',
  ])
})

test('failures back off, retry, then get stuck and page the manager', () => {
  const { send } = run()
  let s = send({ type: 'FAIL', seq: 1, reason: 'timeout', at: 1000 })
  expect(where(s.value)).toEqual(['implement', 'backoff'])
  expect(s.context.retryAt).toBe(11_000)

  s = send({ type: 'TICK', at: 10_999 })
  expect(where(s.value)).toEqual(['implement', 'backoff'])
  s = send({ type: 'TICK', at: 11_000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context).toMatchObject({ attempt: 2, seq: 2, error: null })

  s = send({ type: 'FAIL', seq: 2, reason: 'went idle', at: 12_000 })
  expect(where(s.value)).toEqual(['implement', 'stuck'])
  expect(s.context.mail.manager?.[0]?.text).toContain('stuck after 2 attempt(s): went idle')
  expect(s.context.log.map(e => e.summary)).toEqual(['timeout', 'went idle'])

  s = send({ type: 'RETRY', at: 13_000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context).toMatchObject({ attempt: 1, seq: 3 })
})

test('only nudges a worker ignores count: seen working, it starts over', () => {
  const { send } = run()
  send({ type: 'NUDGED', seq: 1, at: 100 })
  let s = send({ type: 'NUDGED', seq: 1, at: 200 })
  expect(s.context).toMatchObject({ nudges: 2, nudgedAt: 200 })
  s = send({ type: 'WORKING', seq: 1, at: 300 })
  expect(s.context).toMatchObject({ nudges: 0, nudgedAt: 300 })
  s = send({ type: 'WORKING', seq: 9, at: 400 }) // a stale worker's activity is not this one's
  expect(s.context.nudgedAt).toBe(300)
})

test('a worker resumed after a stop gets a new pane and a fresh clock, nudges and resume', () => {
  const { send } = run()
  send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 100 })
  send({ type: 'SPAWNED', seq: 1, pane: 'w1:p2', isResume: true, at: 200 })
  send({ type: 'NUDGED', seq: 1, at: 300 })
  const s = send({ type: 'RESUMED', seq: 1, pane: 'w1:p3', at: 9_000 })
  expect(s.context).toMatchObject({ pane: 'w1:p3', startedAt: 9_000, nudges: 0, resumes: 0 })
  expect(where(s.value)).toEqual(['implement', 'working'])
})

test('mail, read, goto, self-loop and abort', () => {
  const { send } = run()
  let s = send({ type: 'MAIL', from: 'manager', to: 'implement', text: 'use bun', at: 1 })
  send({ type: 'MAIL', from: 'manager', to: 'implement', text: 'and tests', at: 2 })
  s = send({ type: 'READ', box: 'implement', seen: 1, at: 3 })
  expect(unread(s.context, 'implement').map(m => m.text)).toEqual(['and tests'])

  // a retry gets a fresh worker that has seen nothing of the visit's mail yet
  s = send({ type: 'FAIL', seq: 1, reason: 'crashed', at: 4 })
  s = send({ type: 'TICK', at: 1_000_000 })
  expect(unread(s.context, 'implement')).toHaveLength(2)

  // leaving the node empties its box
  s = send({ type: 'GOTO', node: 'iterate', at: 1_000_001 })
  expect(where(s.value)).toEqual(['iterate', 'working'])
  expect(s.context.mail.implement).toEqual([])
  const seq = s.context.seq
  s = send({ type: 'DONE', seq, outcome: 'again', summary: 'one more', at: 1_000_002 })
  expect(where(s.value)).toEqual(['iterate', 'working'])
  expect(s.context.seq).toBe(seq + 1)
  expect(s.context.mail.iterate?.map(m => m.text)).toEqual(['one more'])

  s = send({ type: 'ABORT', at: 1_000_003 })
  expect(s.value).toBe('aborted')
  s = send({ type: 'GOTO', node: 'review', at: 1_000_004 })
  expect(where(s.value)).toEqual(['review', 'working'])
})

test('a run that keeps looping is held once its step budget is used', () => {
  const { send } = run({ ...def, maxSteps: 3 })
  send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'v1', at: 1 })
  send({ type: 'DONE', seq: 2, outcome: 'changes', summary: 'again', at: 2 })
  let s = send({ type: 'DONE', seq: 3, outcome: 'ready', summary: 'v2', at: 3 })
  expect(where(s.value)).toEqual(['review', 'stuck'])
  expect(s.context.error).toBe('step budget used up')
  expect(s.context.mail.manager?.[0]?.text).toContain('budget of 3')

  s = send({ type: 'RETRY', at: 4 })
  expect(where(s.value)).toEqual(['review', 'working'])
  expect(s.context).toMatchObject({ seq: 5, budget: 7 })
})

test('timed edges park the run without a worker; goto skips the wait', () => {
  const watch: Factory = {
    name: 'watch',
    start: 'look',
    maxSteps: 2,
    nodes: { look: { prompt: 'look', next: { quiet: { to: 'look', delayMin: 30 }, stop: 'done' } } },
  }
  const { send } = run(watch)
  const wake = 1000 + 30 * 60_000
  let s = send({ type: 'DONE', seq: 1, outcome: 'quiet', summary: 'all good', at: 1000 })
  expect(where(s.value)).toEqual(['look', 'waiting'])
  expect(s.context).toMatchObject({ wakeAt: wake, seq: 1, pane: null })
  expect(s.context.mail.look?.map(m => m.text)).toEqual(['all good'])

  s = send({ type: 'TICK', at: wake - 1 })
  expect(where(s.value)).toEqual(['look', 'waiting'])
  s = send({ type: 'TICK', at: wake })
  expect(where(s.value)).toEqual(['look', 'working'])
  expect(s.context).toMatchObject({ seq: 2, wakeAt: 0 })

  // a budget of 2 would hold the third launch, but every timed edge refills it
  send({ type: 'DONE', seq: 2, outcome: 'quiet', summary: 'still good', at: wake })
  s = send({ type: 'TICK', at: 2 * wake })
  expect(where(s.value)).toEqual(['look', 'working'])
  expect(s.context.seq).toBe(3)

  send({ type: 'DONE', seq: 3, outcome: 'quiet', summary: 'fine', at: 2 * wake })
  s = send({ type: 'GOTO', node: 'look', at: 2 * wake + 1 })
  expect(where(s.value)).toEqual(['look', 'working'])
  expect(s.context.seq).toBe(4)
})

test('reach finds stations the start never leads to and stations with no way to done', () => {
  expect(reach(def)).toEqual({ unreachable: ['iterate'], trapped: [] })
  const loop: Factory = {
    name: 'loop',
    start: 'a',
    nodes: { a: { prompt: 'a', next: { x: 'b' } }, b: { prompt: 'b', next: { y: 'a' } } },
  }
  expect(reach(loop)).toEqual({ unreachable: [], trapped: ['a', 'b'] })
})

test('validate rejects broken graphs', () => {
  expect(() =>
    validate({ ...def, start: 'nope', nodes: { done: { prompt: '', next: { x: 'ghost', fail: 'done' } } } }),
  ).toThrow(/start "nope"[\s\S]*"done" is reserved[\s\S]*unknown node "ghost"[\s\S]*"fail" is reserved/)
  expect(() =>
    validate({
      name: 'x',
      start: 'a',
      nodes: {
        a: { prompt: '', next: { later: { to: 'a', delayMin: 0 }, park: { to: 'a', defer: true } } },
        g: { prompt: '?', gate: true, agent: 'claude', next: {} },
      },
    }),
  ).toThrow(
    /"later" needs delayMin > 0[\s\S]*only an edge into done defers[\s\S]*g: has no outcomes[\s\S]*a gate has no worker/,
  )
  const rejects = (edge: object) => () =>
    validate({ name: 'x', start: 'a', nodes: { a: { prompt: '', next: { no: edge as never } } } })
  expect(rejects({ to: 'a', reject: true })).toThrow('only an edge into done rejects')
  expect(rejects({ to: 'done', reject: true, defer: true })).toThrow('defers or rejects, not both')
  expect(rejects({ to: 'done', reject: true })).not.toThrow()
  expect(validate(def)).toBe(def)
})

test('a blocked worker parks its station without spending an attempt, and mail or the clock wakes it', () => {
  const { send } = run()
  send({ type: 'FAIL', seq: 1, reason: 'flaky', at: 1 })
  let s = send({ type: 'TICK', at: 20_000 })
  expect(s.context.attempt).toBe(2) // implement allows 2: one more fail would be stuck
  s = send({ type: 'BLOCKED', seq: 2, reason: 'PR #7 needs a human approval', at: 30_000 })
  expect(where(s.value)).toEqual(['implement', 'waiting'])
  expect(s.context).toMatchObject({ attempt: 2, pane: null, wakeAt: 30_000 + 60 * 60_000 })
  expect(s.context.mail.manager?.at(-1)?.text).toStartWith('implement is parked, waiting on: PR #7')

  // mail for another station, or the manager, leaves it parked; mail to it wakes a fresh worker at once
  s = send({ type: 'MAIL', from: 'manager', to: 'review', text: 'fyi', at: 40_000 })
  expect(where(s.value)).toEqual(['implement', 'waiting'])
  s = send({ type: 'MAIL', from: 'manager', to: 'implement', text: 'merged it', at: 50_000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context).toMatchObject({ attempt: 2, seq: 3, wakeAt: 0 })
  expect(s.context.mail.implement?.at(-1)?.text).toBe('merged it')

  // blocked again: it waits twice as long, then the clock wakes it; the manager already knows it parked
  const told = s.context.mail.manager?.length
  s = send({ type: 'BLOCKED', seq: 3, reason: 'still waiting', at: 60_000 })
  expect(s.context.mail.manager?.length).toBe(told)
  s = send({ type: 'TICK', at: 60_000 + 60 * 60_000 })
  expect(where(s.value)).toEqual(['implement', 'waiting'])
  s = send({ type: 'TICK', at: 60_000 + 120 * 60_000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context.attempt).toBe(2)
  expect(s.context.log.map(e => e.outcome)).toEqual(['fail', 'blocked', 'blocked'])
})

test('each blocked report in a row doubles the park, up to 8h', () => {
  const ctx = (n: number) =>
    ({
      log: [{ node: 'plan', outcome: 'ready' }, ...Array(n).fill({ node: 'deploy', outcome: 'blocked' })],
    }) as never
  expect([0, 1, 2, 3, 4, 9].map(n => parkDelayMin(ctx(n), 'deploy', 60))).toEqual([
    60, 120, 240, 480, 480, 480,
  ])
  expect(parkDelayMin(ctx(3), 'deploy', 600)).toBe(600)
})

test('a timed edge is not cut short by mail', () => {
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, implement: { prompt: 'x', next: { ready: { to: 'review', delayMin: 15 } } } },
  })
  const s = send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'built', at: 1 })
  expect(where(s.value)).toEqual(['review', 'waiting'])
  expect(where(send({ type: 'MAIL', from: 'manager', to: 'review', text: 'hi', at: 2 }).value)).toEqual([
    'review',
    'waiting',
  ])
})

test('a station blocked on pull requests parks long: the runner watches them and mails it awake', () => {
  const pr = 'https://github.com/o/r/pull/7'
  expect(prsIn(`${pr} needs an approving review; ${pr} again, and o/r#8 is not a link`)).toEqual([pr])
  const { send } = run()
  const s = send({ type: 'BLOCKED', seq: 1, reason: `${pr} needs an approving review`, at: 1 })
  expect(s.context.wakeAt).toBe(1 + WATCHED_PARK_MIN * 60_000)
  expect(s.context.mail.manager?.at(-1)?.text).toContain('when one of its pull requests changes')
})

test('a station that reports one outcome more than its rounds is held for the manager', () => {
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, review: { ...def.nodes.review!, rounds: 2 } },
  })
  let seq = 1
  const round = () => {
    send({ type: 'DONE', seq: seq++, outcome: 'ready', summary: 'built', at: seq })
    return send({ type: 'DONE', seq: seq++, outcome: 'changes', summary: 'fix the nil check', at: seq })
  }
  expect(where(round().value)).toEqual(['implement', 'working'])
  expect(where(round().value)).toEqual(['implement', 'working'])
  const s = round()
  expect(where(s.value)).toEqual(['review', 'stuck'])
  expect(s.context.error).toBe('review reported changes more than 2 times')
  expect(s.context.mail.manager?.at(-1)?.text).toContain('held instead of going to implement')
  expect(s.context.mail.manager?.at(-1)?.text).toContain('fix the nil check')
  expect(s.context.log.filter(e => e.outcome === 'changes')).toHaveLength(3)
  // only the outcome that looped counts: a fresh review that approves goes on
  expect(where(send({ type: 'RETRY', at: 99 }).value)).toEqual(['review', 'working'])
  expect(where(send({ type: 'DONE', seq: 7, outcome: 'approve', summary: 'ok', at: 100 }).value)).toEqual([
    'done',
    '',
  ])
  expect(() =>
    validate({ ...def, nodes: { ...def.nodes, review: { ...def.nodes.review!, rounds: 0 } } }),
  ).toThrow('rounds is at least 1')
})

test('a handoff starts a fresh worker at the same station without spending an attempt', () => {
  const { send } = run()
  let s = send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 1 })
  s = send({ type: 'HANDOFF', seq: 1, summary: 'tasks 1-3 done, 4 left', at: 2 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context).toMatchObject({ seq: 2, attempt: 1, pane: null })
  expect(s.context.log.at(-1)).toMatchObject({
    node: 'implement',
    outcome: 'handoff',
    summary: 'tasks 1-3 done, 4 left',
  })
  expect(where(send({ type: 'HANDOFF', seq: 1, summary: 'stale', at: 3 }).value)).toEqual([
    'implement',
    'working',
  ])
  expect(() =>
    validate({ ...def, nodes: { ...def.nodes, review: { prompt: 'x', next: { handoff: 'done' } } } }),
  ).toThrow('outcome "handoff" is reserved')
})

test('a repeated silent failure parks the run with a question instead of spending the next attempt', () => {
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, implement: { ...def.nodes.implement!, retries: 2 } },
  })
  send({ type: 'FAIL', seq: 1, reason: 'stalled: no output for 40 min', at: 1000 })
  send({ type: 'TICK', at: 11_000 })
  const s = send({ type: 'FAIL', seq: 2, reason: 'stalled: no output for 41 min', at: 12_000 })
  expect(where(s.value)).toEqual(['implement', 'stuck']) // attempt 2 of 3: not retried
  expect(s.context.error).toContain('Question: implement failed twice the same way')
  expect(s.context.error).toContain(
    'Options: retry: run implement again with your answer | abort: end the run',
  )
  expect(s.context.mail.manager?.[0]?.text).toContain('stuck after 2 attempt(s)')
})

test('failures of different kinds still retry', () => {
  expect(failClass('no report within 60 min')).toBe('timeout')
  expect(failClass('worker pane w1:p1 was closed')).toBeNull()
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, implement: { ...def.nodes.implement!, retries: 2 } },
  })
  send({ type: 'FAIL', seq: 1, reason: 'no report within 60 min', at: 1000 })
  send({ type: 'TICK', at: 11_000 })
  const s = send({ type: 'FAIL', seq: 2, reason: 'stalled: no output for 40 min', at: 12_000 })
  expect(where(s.value)).toEqual(['implement', 'backoff'])
})

// claude-factory-3t2: a timeout retry gets a longer limit and an extra brief section.
test('afterTimeout is true right after a timeout fail, stays true through another fail kind in the same tail, and is false with no timeout fail in it', () => {
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, implement: { ...def.nodes.implement!, retries: 2 } },
  })
  // attempt 1 fails some other way: no timeout fail in the tail yet (AC2)
  let s = send({ type: 'FAIL', seq: 1, reason: 'worker pane w1:p1 was closed', at: 500 })
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(false)
  s = send({ type: 'TICK', at: 1_000_000 })

  s = send({ type: 'FAIL', seq: s.context.seq, reason: 'no report within 45 min', at: 1_000_100 })
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(true)
  s = send({ type: 'TICK', at: 2_000_000 })
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(true)

  // a later fail of another kind in the same tail does not drop the escalation: the timeout
  // entry is still in the node's run of log entries, which only a new visit (a different node) ends
  s = send({ type: 'FAIL', seq: s.context.seq, reason: 'worker pane w1:p1 was closed', at: 2_000_100 })
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(true)

  // a node that never failed has no timeout tail
  expect(afterTimeout(s.context as Ctx, 'review')).toBe(false)
})

test('afterTimeout stays true across a stuck state and the manager\'s RETRY (the log tail still holds it)', () => {
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, implement: { ...def.nodes.implement!, retries: 1 } },
  })
  send({ type: 'FAIL', seq: 1, reason: 'no report within 45 min', at: 1000 })
  const retried = send({ type: 'TICK', at: 11_000 })
  let s = send({ type: 'FAIL', seq: retried.context.seq, reason: 'no report within 45 min', at: 12_000 })
  expect(where(s.value)).toEqual(['implement', 'stuck'])
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(true)

  s = send({ type: 'RETRY', at: 13_000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(true)
})

test('timeoutOf gives the plain timeoutMin with no onTimeout, and the escalated one only after a timeout fail', () => {
  const plain = def.nodes.implement!
  const escalated = { ...plain, timeoutMin: 45, onTimeout: { timeoutMin: 75 } }
  const { send, now } = run({ ...def, nodes: { ...def.nodes, implement: escalated } })
  const fresh = now()
  expect(timeoutOf(plain, fresh.context as Ctx, 'implement')).toBe(60) // no timeoutMin set: falls back to 60
  expect(timeoutOf(escalated, fresh.context as Ctx, 'implement')).toBe(45) // no timeout fail yet

  const s = send({ type: 'FAIL', seq: 1, reason: 'no report within 45 min', at: 1000 })
  expect(timeoutOf(escalated, s.context as Ctx, 'implement')).toBe(75)
  expect(timeoutOf(plain, s.context as Ctx, 'implement')).toBe(60) // no onTimeout: unaffected
})

test('validate refuses onTimeout on a gate, and onTimeout.timeoutMin at or under timeoutMin, each alone', () => {
  const graph = (node: object) => ({ name: 'x', start: 'a', nodes: { a: node } }) as unknown as Factory
  expect(() =>
    validate(
      graph({ prompt: '?', gate: true, agent: undefined, next: { ok: 'done' }, onTimeout: { timeoutMin: 75 } }),
    ),
  ).toThrow('a: a gate has no worker, so no onTimeout')
  expect(() =>
    validate(graph({ prompt: 'x', next: { ok: 'done' }, timeoutMin: 45, onTimeout: { timeoutMin: 45 } })),
  ).toThrow('a: onTimeout.timeoutMin must be greater than timeoutMin (45)')
  expect(() =>
    validate(graph({ prompt: 'x', next: { ok: 'done' }, timeoutMin: 45, onTimeout: { timeoutMin: 30 } })),
  ).toThrow('a: onTimeout.timeoutMin must be greater than timeoutMin (45)')
  expect(validate(graph({ prompt: 'x', next: { ok: 'done' }, timeoutMin: 45, onTimeout: { timeoutMin: 75 } })))
    .toBeTruthy()
  // no timeoutMin set: the default of 60 is the floor onTimeout must clear
  expect(() =>
    validate(graph({ prompt: 'x', next: { ok: 'done' }, onTimeout: { timeoutMin: 60 } })),
  ).toThrow('a: onTimeout.timeoutMin must be greater than timeoutMin (60)')
})

// claude-factory-960.1: an awaitsPr station (deploy, for example) parks before its first worker starts.
// This happens when the arriving report names a pull request. A merge, a close, or any later activity on
// that pull request wakes the park. The same watch and mail path already wakes a worker's own blocked report.
const prGraph: Factory = {
  name: 'ship',
  start: 'release',
  nodes: {
    release: { prompt: 'ship it', next: { ready: 'deploy' } },
    deploy: { prompt: 'deploy it', awaitsPr: true, next: { deployed: 'done' } },
  },
}
const PR = 'https://github.com/acme/widget/pull/7'

test('an arrival naming a pull request at an awaitsPr station parks it with no worker, spending no attempt (claude-factory-960)', () => {
  const { send } = run(prGraph)
  const s = send({
    type: 'DONE',
    seq: 1,
    outcome: 'ready',
    summary: `ready to ship ${PR}`,
    at: 1000,
  })
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  expect(s.context).toMatchObject({ seq: 1, pane: null }) // no worker launch: seq never bumped past release's
  const last = s.context.log.at(-1)!
  expect(last).toMatchObject({ node: 'deploy', attempt: 0, outcome: 'blocked' })
  expect(last.summary).toContain(PR)
  expect(isPrWait(last)).toBe(true)
  expect(s.context.wakeAt).toBe(1000 + WATCHED_PARK_MIN * 60_000)
  expect(s.context.mail.manager?.at(-1)?.text).toContain('deploy is parked, waiting on:')
  expect(s.context.mail.manager?.at(-1)?.text).toContain(PR)
  // the report's own box still carries the whole report, for whenever a worker does start
  expect(s.context.mail.deploy?.at(-1)?.text).toContain(PR)
})

test('an awaitsPr park wakes on the clock or on mail, exactly like a worker-reported block', () => {
  const { send } = run(prGraph)
  let s = send({ type: 'DONE', seq: 1, outcome: 'ready', summary: `ready ${PR}`, at: 1000 })
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  const wake = 1000 + WATCHED_PARK_MIN * 60_000

  s = send({ type: 'TICK', at: wake - 1 })
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  s = send({ type: 'TICK', at: wake })
  expect(where(s.value)).toEqual(['deploy', 'working']) // the 8h backstop starts a worker
  expect(s.context.seq).toBe(2)
})

test('mail to an awaitsPr station wakes it at once, with no attempt spent', () => {
  const { send } = run(prGraph)
  send({ type: 'DONE', seq: 1, outcome: 'ready', summary: `ready ${PR}`, at: 1000 })
  const s = send({ type: 'MAIL', from: 'factory', to: 'deploy', text: `${PR} merged`, at: 2000 })
  expect(where(s.value)).toEqual(['deploy', 'working'])
  expect(s.context.seq).toBe(2)
})

test('an arrival with no pull request named starts the worker at once, awaitsPr or not', () => {
  const { send } = run(prGraph)
  const s = send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'ready, nothing to link', at: 1000 })
  expect(where(s.value)).toEqual(['deploy', 'working'])
  expect(s.context.seq).toBe(2)
})

test('a GitLab merge request also gates an awaitsPr arrival', () => {
  const mr = 'https://gitlab.example.com/acme/widget/-/merge_requests/9'
  expect(mrsIn(`see ${mr} for the change`)).toEqual([mr])
  const { send } = run(prGraph)
  const s = send({ type: 'DONE', seq: 1, outcome: 'ready', summary: `ready ${mr}`, at: 1000 })
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  expect(s.context.log.at(-1)).toMatchObject({ node: 'deploy', attempt: 0, outcome: 'blocked' })
})

test('goto into an awaitsPr station skips the park and starts a worker now', () => {
  const { send } = run(prGraph)
  const s = send({ type: 'GOTO', node: 'deploy', at: 1000 })
  expect(where(s.value)).toEqual(['deploy', 'working'])
})

test('validate refuses awaitsPr on a gate: a gate has no worker to hold back', () => {
  expect(() =>
    validate({
      name: 'x',
      start: 'g',
      nodes: { g: { prompt: '?', gate: true, awaitsPr: true, next: { ok: 'done' } } },
    }),
  ).toThrow('a gate has no worker')
})

test('parkDelayMin skips the pre-launch (attempt 0) park entries awaitsPr adds, so they never inflate the backoff', () => {
  const ctx = (entries: { outcome: string; attempt: number }[]) =>
    ({
      log: [{ node: 'plan', outcome: 'ready', attempt: 1 }, ...entries.map(e => ({ node: 'deploy', ...e }))],
    }) as never
  // two real worker blocks, one pre-launch park mixed in: only the 2 real ones double the wait
  expect(
    parkDelayMin(
      ctx([
        { outcome: 'blocked', attempt: 0 },
        { outcome: 'blocked', attempt: 1 },
        { outcome: 'blocked', attempt: 1 },
      ]),
      'deploy',
      60,
    ),
  ).toBe(240)
  // pre-launch parks alone never escalate the wait past the base
  expect(
    parkDelayMin(
      ctx([
        { outcome: 'blocked', attempt: 0 },
        { outcome: 'blocked', attempt: 0 },
      ]),
      'deploy',
      60,
    ),
  ).toBe(60)
})
