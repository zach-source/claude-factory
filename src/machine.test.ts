import { expect, test } from 'bun:test'
import { createActor, type Snapshot } from 'xstate'
import { compile, reach, unread, validate, where, type Ev, type Factory } from './machine'

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
  expect(validate(def)).toBe(def)
})
