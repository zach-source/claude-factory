import { describe, expect, test } from 'bun:test'
import { createActor, type Snapshot } from 'xstate'
import {
  acIdsIn,
  afterTimeout,
  capReplanMail,
  compile,
  failClass,
  failingAcIds,
  gotoRefusal,
  isLiveRead,
  isNoWorker,
  isParkedOn,
  OWNER_AFTER_MS,
  isPrWait,
  mrsIn,
  parkDelayMin,
  shouldHandToOwner,
  prevReport,
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
  name: 'implement-review',
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
  return { send, now, saved: () => JSON.parse(JSON.stringify(snap)) as Snapshot<unknown> }
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

test('validate accepts a defer edge that names a station of the factory, and refuses an unknown one', () => {
  const rejects = (edge: object) => () =>
    validate({ name: 'x', start: 'a', nodes: { a: { prompt: '', next: { no: edge as never } } } })
  expect(rejects({ to: 'done', defer: { station: 'a' } })).not.toThrow()
  expect(rejects({ to: 'done', defer: { station: 'nope' } })).toThrow('defer station "nope" is not a node')
  expect(rejects({ to: 'a', defer: { station: 'a' } })).toThrow('only an edge into done defers')
  expect(rejects({ to: 'done', defer: { station: 'a' }, requeue: true })).toThrow(
    'defers, rejects or requeues, only one',
  )
  expect(rejects({ to: 'done', defer: { station: 'a' }, ship: true })).toThrow(
    'defers, rejects, requeues or ships, only one',
  )
})

test('validate refuses a requeue edge that does not go into done, that also defers or rejects, or that names an invalid factory/station', () => {
  const rejects = (edge: object) => () =>
    validate({ name: 'x', start: 'a', nodes: { a: { prompt: '', next: { no: edge as never } } } })
  expect(rejects({ to: 'a', requeue: true })).toThrow('only an edge into done requeues')
  expect(rejects({ to: 'done', requeue: true, defer: true })).toThrow('defers, rejects or requeues, only one')
  expect(rejects({ to: 'done', requeue: true, reject: true })).toThrow(
    'defers, rejects or requeues, only one',
  )
  expect(rejects({ to: 'done', requeue: { factory: '../x' } })).toThrow('requeue name "../x" is invalid')
  expect(rejects({ to: 'done', requeue: { station: 'Not-Lower' } })).toThrow(
    'requeue name "Not-Lower" is invalid',
  )
  expect(rejects({ to: 'done', requeue: true })).not.toThrow()
  expect(rejects({ to: 'done', requeue: { factory: 'release', station: 'implement' } })).not.toThrow()
})

test('validate accepts a ship edge into done only, and refuses it with defer, reject or requeue', () => {
  const rejects = (edge: object) => () =>
    validate({ name: 'x', start: 'a', nodes: { a: { prompt: '', next: { no: edge as never } } } })
  const only = 'defers, rejects, requeues or ships, only one'
  expect(rejects({ to: 'done', ship: true })).not.toThrow()
  expect(rejects({ to: 'a', ship: true })).toThrow('only an edge into done ships')
  expect(rejects({ to: 'done', ship: true, defer: true })).toThrow(only)
  expect(rejects({ to: 'done', ship: true, reject: true })).toThrow(only)
  expect(rejects({ to: 'done', ship: true, requeue: true })).toThrow(only)
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

test('everyMin marks a sweep station, and must be greater than 0', () => {
  expect(() =>
    validate({ ...def, nodes: { ...def.nodes, implement: { ...def.nodes.implement!, everyMin: 30 } } }),
  ).not.toThrow()
  expect(() =>
    validate({ ...def, nodes: { ...def.nodes, implement: { ...def.nodes.implement!, everyMin: 0 } } }),
  ).toThrow('everyMin is greater than 0')
  expect(() =>
    validate({ ...def, nodes: { ...def.nodes, implement: { ...def.nodes.implement!, everyMin: -5 } } }),
  ).toThrow('everyMin is greater than 0')
})

// claude-factory-qgz AC1-AC3: a station with onRounds re-plans at its cap instead of holding, carrying
// every round's findings; a second cap in the same run still holds for the manager.
test('onRounds re-plans a capped station with its findings, then holds for the manager on a second cap', () => {
  const withPlan: Factory = {
    ...def,
    nodes: {
      ...def.nodes,
      plan: { prompt: 'plan it', next: { planned: 'implement' } },
      review: { ...def.nodes.review!, rounds: 2, onRounds: 'plan' },
    },
  }
  const { send } = run(withPlan)
  let seq = 1
  let t = 0
  const toReview = (note: string) => {
    send({ type: 'DONE', seq: seq++, outcome: 'ready', summary: 'built', at: ++t })
    return send({ type: 'DONE', seq: seq++, outcome: 'changes', summary: note, at: ++t })
  }

  expect(where(toReview('round 1: fix the nil check').value)).toEqual(['implement', 'working'])
  expect(where(toReview('round 2: fix the race').value)).toEqual(['implement', 'working'])
  let s = toReview('round 3: still flaky')
  expect(where(s.value)).toEqual(['plan', 'working']) // AC1: the (R+1)th report re-plans, not stuck
  expect(s.context.log.filter(e => e.node === 'review' && e.outcome === 'changes')).toHaveLength(3)
  // claude-factory-qgz finding .8: only the machine's own re-plan carries `replan: true`
  expect(s.context.log.at(-1)).toMatchObject({ node: 'review', outcome: 'changes', replan: true })
  expect(s.context.mail.manager).toBeUndefined() // AC2: no manager mail on this path
  const findings = s.context.mail.plan?.[0]
  expect(findings?.from).toBe('review')
  expect(findings?.text).toContain('round 1')
  expect(findings?.text.indexOf('round 1')).toBeLessThan(findings!.text.indexOf('round 2'))
  expect(findings?.text.indexOf('round 2')).toBeLessThan(findings!.text.indexOf('round 3'))
  expect(findings?.text).toContain('fix the nil check')
  expect(findings?.text).toContain('fix the race')
  expect(findings?.text).toContain('still flaky')

  // AC3: plan reports planned, then reports R+2..2R+1 (the 4th and 5th changes) follow the normal edge
  s = send({ type: 'DONE', seq: seq++, outcome: 'planned', summary: 're-planned', at: ++t })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(where(toReview('round 4: normal').value)).toEqual(['implement', 'working'])
  expect(where(toReview('round 5: normal').value)).toEqual(['implement', 'working'])
  // the 6th (2R+2) holds for the manager, same as with no onRounds, plus "already re-planned once"
  s = toReview('round 6: still broken')
  expect(where(s.value)).toEqual(['review', 'stuck'])
  expect(s.context.error).toBe('review reported changes more than 2 times')
  expect(s.context.mail.manager?.at(-1)?.text).toContain('already re-planned once')
  expect(s.context.mail.manager?.at(-1)?.text).toContain('held instead of going to implement')
})

// claude-factory-53tf: only an outcome that loops back counts toward a node's rounds cap.
// review's `security` leaves the loop for a deeper node, so it never counts.
const secDef = (onRounds?: string): Factory => ({
  ...def,
  nodes: {
    plan: { prompt: 'plan it', next: { planned: 'implement' } },
    implement: { prompt: 'build it', next: { ready: 'review' }, retries: 1 },
    review: {
      prompt: 'review it',
      next: { changes: 'implement', security: 'security', approve: 'done' },
      rounds: 3,
      ...(onRounds ? { onRounds } : {}),
    },
    security: { prompt: 'scan it', next: { changes: 'implement', approve: 'done' } },
  },
  start: 'plan',
})

function secRun(onRounds?: string) {
  const { send } = run(secDef(onRounds))
  let seq = 1
  let t = 0
  const d = (outcome: string) => send({ type: 'DONE', seq: seq++, outcome, summary: outcome, at: ++t })
  d('planned')
  return { d, send }
}

test.each(['plan', undefined])(
  'review security reports never count toward the cap (onRounds %s)',
  onRounds => {
    const { d } = secRun(onRounds)
    for (let i = 0; i < 5; i++) {
      d('ready')
      const s = d('security')
      expect(where(s.value)).toEqual(['security', 'working'])
      expect(s.context.mail.plan ?? []).toHaveLength(0)
      expect(s.context.log.some(e => e.replan)).toBe(false)
      d('changes') // security changes goes back to implement
    }
  },
)

test('back edges still cap, and security reports between them do not move the cap', () => {
  const { d } = secRun('plan')
  for (let i = 0; i < 3; i++) {
    d('ready')
    d('security')
    d('changes')
    d('ready')
    expect(where(d('changes').value)).toEqual(['implement', 'working'])
  }
  d('ready')
  const s = d('changes')
  expect(where(s.value)).toEqual(['plan', 'working'])
  expect(s.context.log.at(-1)).toMatchObject({ node: 'review', replan: true })
  expect(s.context.mail.plan?.at(-1)?.text).toContain('round cap')
})

// claude-factory-qgz AC2: the re-plan mail stays near 24000 chars even when every round's summary is huge.
test('capReplanMail clips each round so the whole mail stays under 24000 chars plus its header', () => {
  const big = 'x'.repeat(50_000)
  const prior = [
    { node: 'review', attempt: 1, outcome: 'changes', summary: big, at: 1 },
    { node: 'review', attempt: 1, outcome: 'changes', summary: big, at: 2 },
  ]
  const text = capReplanMail(prior, 'review', 'changes', big)
  expect(text).toContain('### review round 1')
  expect(text).toContain('### review round 2')
  expect(text).toContain('### review round 3')
  expect(text.length).toBeLessThan(24_000 + 1_000) // 3 rounds clipped to floor(24000/3) each, plus the header
})

test('validate refuses a mergeCheck not in next, or on a gate; accepts one in next', () => {
  const g = (a: object) =>
    ({ name: 'x', start: 'a', nodes: { a, b: { prompt: 'x', next: { ok: 'a' } } } }) as unknown as Factory
  expect(() => validate(g({ prompt: 'x', next: { ok: 'b' }, mergeCheck: 'nope' }))).toThrow(
    'a: mergeCheck "nope" is not an outcome in next',
  )
  expect(() => validate(g({ prompt: 'x', gate: true, next: { ok: 'b' }, mergeCheck: 'ok' }))).toThrow(
    'a: a gate has no worker, so no mergeCheck',
  )
  expect(() => validate(g({ prompt: 'x', next: { ok: 'b' }, mergeCheck: 'ok' }))).not.toThrow()
})

// claude-factory-qgz AC5: validate refuses each broken onRounds and a repeatMail that is not an outcome.
test('validate refuses onRounds with no rounds, to an unknown node, to done, or to itself; and repeatMail not in next', () => {
  const graph = (node: object) => ({ name: 'x', start: 'a', nodes: { a: node } }) as unknown as Factory
  expect(() => validate(graph({ prompt: 'x', next: { ok: 'a' }, onRounds: 'a' }))).toThrow(
    'a: onRounds needs rounds',
  )
  expect(() => validate(graph({ prompt: 'x', next: { ok: 'a' }, rounds: 2, onRounds: 'ghost' }))).toThrow(
    'a: onRounds goes to unknown node "ghost"',
  )
  expect(() => validate(graph({ prompt: 'x', next: { ok: 'a' }, rounds: 2, onRounds: 'done' }))).toThrow(
    'a: onRounds must not be "done"',
  )
  expect(() => validate(graph({ prompt: 'x', next: { ok: 'a' }, rounds: 2, onRounds: 'a' }))).toThrow(
    'a: onRounds must not be the node itself',
  )
  expect(() =>
    validate({
      name: 'x',
      start: 'a',
      nodes: {
        a: { prompt: 'x', next: { ok: 'b' }, repeatMail: 'nope' },
        b: { prompt: 'x', next: { ok: 'a' } },
      },
    }),
  ).toThrow('a: repeatMail "nope" is not an outcome in next')
})

// claude-factory-qgz AC6: repeatMail mails the manager once a station repeats one outcome twice in a
// row, both summaries citing the same AC id on their own "Failing:" line, skipping fail/blocked/
// handoff in between. Review round 1 finding .9: a passing AC named elsewhere in the report must
// not count, since verify's prompt has it name passing ACs too.
test('repeatMail mails the manager once two reports in a row share a failing AC id', () => {
  const verifyLoop: Factory = {
    name: 'verify-loop',
    start: 'verify',
    nodes: {
      verify: {
        prompt: 'verify',
        next: { green: 'verify', red: 'implement' },
        repeatMail: 'red',
        retries: 2,
      },
      implement: { prompt: 'fix', next: { ready: 'verify' } },
    },
  }
  const repeatMails = (s: ReturnType<ReturnType<typeof run>['send']>) =>
    s.context.mail.manager?.filter(m => m.from === 'factory') ?? []

  // red(AC2, AC3), a fail at verify (skipped), then red(AC2): one mail from 'factory' naming AC2
  {
    const { send } = run(verifyLoop)
    send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'checked everything.\nFailing: AC2, AC3', at: 1 })
    send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
    send({ type: 'FAIL', seq: 3, reason: 'flaky', at: 3 })
    send({ type: 'TICK', at: 1_000_000 })
    const s = send({
      type: 'DONE',
      seq: 4,
      outcome: 'red',
      summary: 'still broken.\nFailing: AC2',
      at: 1_000_001,
    })
    expect(where(s.value)).toEqual(['implement', 'working'])
    expect(repeatMails(s)).toHaveLength(1)
    expect(repeatMails(s)[0]).toMatchObject({ from: 'factory' })
    expect(repeatMails(s)[0]!.text).toContain('AC2')
    expect(repeatMails(s)[0]!.text).toContain('verify')
  }

  // red(AC1) then red(AC2): no shared failing id, no mail
  {
    const { send } = run(verifyLoop)
    send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'Failing: AC1', at: 1 })
    send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
    const s = send({ type: 'DONE', seq: 3, outcome: 'red', summary: 'Failing: AC2', at: 3 })
    expect(repeatMails(s)).toHaveLength(0)
  }

  // red(AC2), green(AC2), red(AC2): the intervening green (a key of next) breaks the streak
  {
    const { send } = run(verifyLoop)
    send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'Failing: AC2', at: 1 })
    send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
    send({ type: 'DONE', seq: 3, outcome: 'green', summary: 'AC2 still open', at: 3 })
    const s = send({ type: 'DONE', seq: 4, outcome: 'red', summary: 'Failing: AC2', at: 4 })
    expect(repeatMails(s)).toHaveLength(0)
  }

  // 'AC-2' and 'ac2' both normalize to AC2
  {
    const { send } = run(verifyLoop)
    send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'Failing: AC-2', at: 1 })
    send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
    const s = send({ type: 'DONE', seq: 3, outcome: 'red', summary: 'still fails.\nFailing: ac2', at: 3 })
    expect(repeatMails(s)).toHaveLength(1)
  }

  // no AC id on either side: no mail
  {
    const { send } = run(verifyLoop)
    send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'no id here', at: 1 })
    send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
    const s = send({ type: 'DONE', seq: 3, outcome: 'red', summary: 'still no id', at: 3 })
    expect(repeatMails(s)).toHaveLength(0)
  }

  // finding .9: both reports name AC2 as passing in their prose, but fail only on a different id
  // each time; sharing a passing mention must never look like a repeat
  {
    const { send } = run(verifyLoop)
    send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'AC2 passes.\nFailing: AC3', at: 1 })
    send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
    const s = send({
      type: 'DONE',
      seq: 3,
      outcome: 'red',
      summary: 'AC2 passes again.\nFailing: AC5',
      at: 3,
    })
    expect(repeatMails(s)).toHaveLength(0)
  }
})

// claude-factory-qgz finding .9: a re-plan between two same-outcome reports renumbers acceptance
// criteria, so a shared id across it is coincidence, not a real repeat on the same criterion.
test('repeatMail does not fire across a re-plan, even when the failing id is the same by coincidence', () => {
  const graph: Factory = {
    name: 'replan-then-repeat',
    start: 'verify',
    nodes: {
      verify: { prompt: 'verify', next: { red: 'review', green: 'done' }, repeatMail: 'red' },
      review: {
        prompt: 'review',
        next: { changes: 'implement', approve: 'verify' },
        rounds: 1,
        onRounds: 'plan',
      },
      implement: { prompt: 'implement', next: { ready: 'review' } },
      plan: { prompt: 'plan', next: { planned: 'verify' } },
    },
  }
  const { send } = run(graph)
  let s = send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'Failing: AC2', at: 1 })
  expect(where(s.value)).toEqual(['review', 'working'])
  s = send({ type: 'DONE', seq: 2, outcome: 'changes', summary: 'round 1', at: 2 })
  expect(where(s.value)).toEqual(['implement', 'working']) // review's 1st round: the normal edge, no cap yet
  s = send({ type: 'DONE', seq: 3, outcome: 'ready', summary: 'fixed', at: 3 })
  expect(where(s.value)).toEqual(['review', 'working'])
  s = send({ type: 'DONE', seq: 4, outcome: 'changes', summary: 'round 2, not converging', at: 4 })
  expect(where(s.value)).toEqual(['plan', 'working']) // the 2nd round hits review's cap: re-plan
  expect(s.context.log.at(-1)).toMatchObject({ node: 'review', replan: true })
  s = send({ type: 'DONE', seq: 5, outcome: 'planned', summary: 're-planned', at: 5 })
  expect(where(s.value)).toEqual(['verify', 'working'])
  s = send({ type: 'DONE', seq: 6, outcome: 'red', summary: 'Failing: AC2', at: 6 })
  expect(s.context.mail.manager?.filter(m => m.from === 'factory') ?? []).toHaveLength(0)
})

// claude-factory-qgz, review round 2 finding .11.
// A manager GOTO writes no log entry of its own.
// A hand `goto plan` after a repeat mail leaves no `replan: true` entry to find.
//
// `plan` is still a re-plan target: it is review's `onRounds` value.
// So `plan`'s own later report must break the streak too.
test('a manager GOTO to a re-plan target breaks the repeatMail streak, with no replan:true entry', () => {
  const graph: Factory = {
    name: 'goto-then-repeat',
    start: 'verify',
    nodes: {
      verify: { prompt: 'verify', next: { red: 'implement', green: 'review' }, repeatMail: 'red' },
      implement: { prompt: 'implement', next: { ready: 'verify' } },
      review: {
        prompt: 'review',
        next: { changes: 'implement', approve: 'done' },
        rounds: 1,
        onRounds: 'plan',
      },
      plan: { prompt: 'plan', next: { planned: 'implement' } },
    },
  }
  const { send } = run(graph)
  let s = send({ type: 'DONE', seq: 1, outcome: 'red', summary: 'Failing: AC2', at: 1 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  s = send({ type: 'DONE', seq: 2, outcome: 'ready', summary: 'fixed', at: 2 })
  expect(where(s.value)).toEqual(['verify', 'working'])
  s = send({ type: 'DONE', seq: 3, outcome: 'red', summary: 'still fails\nFailing: AC2', at: 3 })
  expect(s.context.mail.manager?.filter(m => m.from === 'factory')).toHaveLength(1) // the 1st repeat mail

  // no `replan: true` entry anywhere: this re-plan is a hand GOTO, not review's own onRounds jump
  s = send({ type: 'GOTO', node: 'plan', at: 3 })
  expect(s.context.log.some(e => e.replan)).toBe(false)
  s = send({ type: 'DONE', seq: s.context.seq, outcome: 'planned', summary: 're-planned', at: 4 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  s = send({ type: 'DONE', seq: s.context.seq, outcome: 'ready', summary: 'fixed again', at: 5 })
  expect(where(s.value)).toEqual(['verify', 'working'])
  s = send({ type: 'DONE', seq: s.context.seq, outcome: 'red', summary: 'fails again\nFailing: AC2', at: 6 })
  expect(s.context.mail.manager?.filter(m => m.from === 'factory')).toHaveLength(1) // still just the 1st
})

test('acIdsIn normalizes AC ids, failingAcIds reads only the Failing: line, and prevReport skips outcomes that are not a key of next', () => {
  expect(acIdsIn('fails AC2, AC-3 and ac4')).toEqual(['AC2', 'AC3', 'AC4'])
  expect(acIdsIn('no ids here')).toEqual([])
  expect(failingAcIds('AC2 passes.\nFailing: AC3, AC-5')).toEqual(['AC3', 'AC5'])
  expect(failingAcIds('no Failing line, just AC2')).toEqual([])
  const next = { red: 'implement', green: 'done' }
  const log = [
    { node: 'verify', attempt: 1, outcome: 'red', summary: 'r1', at: 1 },
    { node: 'implement', attempt: 1, outcome: 'ready', summary: 'fix', at: 2 },
    { node: 'verify', attempt: 1, outcome: 'fail', summary: 'flaky', at: 3 },
  ]
  expect(prevReport(log, 'verify', next)).toMatchObject({ outcome: 'red', summary: 'r1' })
  expect(prevReport(log, 'verify', {})).toBeUndefined()
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

test('a worker that never started is its own failure class: it repeats, and it does not lengthen the next deadline', () => {
  const ax = 'worker never started on AX after 60 min: task phase Pending'
  const pane = 'the worker never started in pane w1:p1 (no Claude after 3 relaunches)'
  expect(failClass(ax)).toBe('unstarted')
  expect(failClass(pane)).toBe('unstarted')
  const { send } = run({
    ...def,
    nodes: { ...def.nodes, implement: { ...def.nodes.implement!, retries: 2 } },
  })
  send({ type: 'FAIL', seq: 1, reason: ax, at: 1000 })
  let s = send({ type: 'TICK', at: 11_000 })
  expect(afterTimeout(s.context as Ctx, 'implement')).toBe(false)
  s = send({ type: 'FAIL', seq: 2, reason: pane, at: 12_000 })
  expect(where(s.value)).toEqual(['implement', 'stuck']) // the same kind twice: the person is asked
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

test("afterTimeout stays true across a stuck state and the manager's RETRY (the log tail still holds it)", () => {
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
      graph({
        prompt: '?',
        gate: true,
        agent: undefined,
        next: { ok: 'done' },
        onTimeout: { timeoutMin: 75 },
      }),
    ),
  ).toThrow('a: a gate has no worker, so no onTimeout')
  expect(() =>
    validate(graph({ prompt: 'x', next: { ok: 'done' }, timeoutMin: 45, onTimeout: { timeoutMin: 45 } })),
  ).toThrow('a: onTimeout.timeoutMin must be greater than timeoutMin (45)')
  expect(() =>
    validate(graph({ prompt: 'x', next: { ok: 'done' }, timeoutMin: 45, onTimeout: { timeoutMin: 30 } })),
  ).toThrow('a: onTimeout.timeoutMin must be greater than timeoutMin (45)')
  expect(
    validate(graph({ prompt: 'x', next: { ok: 'done' }, timeoutMin: 45, onTimeout: { timeoutMin: 75 } })),
  ).toBeTruthy()
  // no timeoutMin set: the default of 60 is the floor onTimeout must clear
  expect(() => validate(graph({ prompt: 'x', next: { ok: 'done' }, onTimeout: { timeoutMin: 60 } }))).toThrow(
    'a: onTimeout.timeoutMin must be greater than timeoutMin (60)',
  )
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

// claude-factory-5wav: the watch routes a parked station's outcome from its pull request, with no worker
const routeGraph: Factory = {
  name: 'ship',
  start: 'release',
  nodes: {
    release: { prompt: 'ship it', next: { ready: 'deploy' } },
    implement: { prompt: 'rework it', next: { ready: 'deploy' } },
    deploy: {
      prompt: 'deploy it',
      awaitsPr: true,
      next: { deployed: 'done', hold: 'done', changes: 'implement' },
    },
  },
}

function parkedDeploy() {
  const r = run(routeGraph)
  r.send({ type: 'DONE', seq: 1, outcome: 'ready', summary: `ready ${PR}`, at: 1000 })
  return r
}

test('ROUTE hold from a parked deploy ends the run with an attempt-0 entry and no worker', () => {
  const { send } = parkedDeploy()
  const s = send({ type: 'ROUTE', node: 'deploy', outcome: 'hold', summary: `${PR} closed`, at: 2000 })
  expect(s.value).toBe('done')
  expect(s.context.seq).toBe(1) // no worker launch
  const last = s.context.log.at(-1)!
  expect(last).toMatchObject({ node: 'deploy', attempt: 0, outcome: 'hold', summary: `${PR} closed` })
  expect(isNoWorker(last)).toBe(true)
  expect(s.context.mail.manager?.at(-1)).toMatchObject({ from: 'deploy', text: `${PR} closed` })
})

test('ROUTE changes from a parked deploy goes to implement with the comments as mail from deploy', () => {
  const { send } = parkedDeploy()
  const s = send({ type: 'ROUTE', node: 'deploy', outcome: 'changes', summary: 'fix the typo', at: 2000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context.wakeAt).toBe(0)
  expect(s.context.log.at(-1)).toMatchObject({ node: 'deploy', attempt: 0, outcome: 'changes' })
  expect(s.context.mail.implement?.at(-1)).toMatchObject({ from: 'deploy', text: 'fix the typo' })
})

test('ROUTE is ignored when the station is working, is another node, or has no such outcome', () => {
  const r = run(routeGraph)
  let s = r.send({ type: 'ROUTE', node: 'release', outcome: 'ready', summary: 'x', at: 10 })
  expect(where(s.value)).toEqual(['release', 'working']) // not parked
  r.send({ type: 'DONE', seq: 1, outcome: 'ready', summary: `ready ${PR}`, at: 1000 })
  for (const [node, outcome] of [
    ['release', 'hold'],
    ['deploy', 'unknown'],
    ['deploy', 'blocked'],
    ['deploy', 'fail'],
    ['deploy', 'handoff'],
  ] as const) {
    s = r.send({ type: 'ROUTE', node, outcome, summary: 'x', at: 2000 })
    expect(where(s.value)).toEqual(['deploy', 'waiting'])
    expect(s.context.log.length).toBe(2)
  }
})

test('REPARK moves wakeAt later: the old timer no longer starts a worker', () => {
  const { send } = parkedDeploy()
  const old = 1000 + WATCHED_PARK_MIN * 60_000
  const later = old + 480 * 60_000
  let s = send({ type: 'REPARK', node: 'deploy', wakeAt: later, at: old - 1000 })
  expect(s.context.wakeAt).toBe(later)
  expect(s.context.log.length).toBe(2) // no new entry, no manager mail
  expect(s.context.mail.manager?.length).toBe(1)
  s = send({ type: 'TICK', at: old })
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  s = send({ type: 'TICK', at: later })
  expect(where(s.value)).toEqual(['deploy', 'working'])
})

test('REPARK never moves wakeAt earlier, and ignores another node', () => {
  const { send } = parkedDeploy()
  const old = 1000 + WATCHED_PARK_MIN * 60_000
  let s = send({ type: 'REPARK', node: 'deploy', wakeAt: old - 1, at: 2000 })
  expect(s.context.wakeAt).toBe(old)
  s = send({ type: 'REPARK', node: 'release', wakeAt: old + 5, at: 2000 })
  expect(s.context.wakeAt).toBe(old)
})

describe('shouldHandToOwner', () => {
  const H = 3_600_000
  const blocked = (at: number, summary = 'waiting on a vendor', attempt = 1) => ({
    node: 'deploy',
    attempt,
    outcome: 'blocked',
    summary,
    at,
  })
  test('two blocked passes in the first day stay with the factory', () => {
    expect(shouldHandToOwner([blocked(0), blocked(H)], 2 * H)).toBe(false)
  })
  test('three blocked passes in a row hand the bead over', () => {
    expect(shouldHandToOwner([blocked(0), blocked(H), blocked(2 * H)], 3 * H)).toBe(true)
  })
  test('a streak older than 24h hands the bead over', () => {
    expect(shouldHandToOwner([blocked(0)], 25 * H)).toBe(true)
    expect(shouldHandToOwner([blocked(0)], 23 * H)).toBe(false)
  })
  test('an owner step in the report hands the bead over at once', () => {
    expect(shouldHandToOwner([blocked(0, 'owner step: rotate the key')], H)).toBe(true)
  })
  test('PR waits do not count', () => {
    const pr = (at: number) => blocked(at, 'no worker yet: waiting for a PR', 0)
    expect(shouldHandToOwner([pr(0), pr(H), pr(2 * H), blocked(3 * H)], 10 * H)).toBe(false)
    expect(shouldHandToOwner([blocked(0), pr(H), blocked(2 * H), pr(3 * H)], 4 * H)).toBe(false)
  })
  test('a non-blocked outcome resets the streak', () => {
    const fail = { node: 'deploy', attempt: 1, outcome: 'fail', summary: 'x', at: 2 * H }
    expect(shouldHandToOwner([blocked(0), blocked(H), fail, blocked(3 * H)], 4 * H)).toBe(false)
  })
  test('a streak at another station does not count', () => {
    const other = { ...blocked(H), node: 'plan' }
    expect(shouldHandToOwner([blocked(0), blocked(0), other], 2 * H)).toBe(false)
  })
})

test('validate checks a node split: its agent params, its share param and its default', () => {
  const mk =
    (split: object, params: Record<string, string> = {}, gate = false) =>
    () =>
      validate({
        name: 'x',
        start: 'a',
        params: { codex: 'codex', codex_share: '0.3', ...params },
        nodes: {
          a: { prompt: '', next: { ok: 'done' }, ...(gate ? { gate: true } : {}), split: split as never },
        },
      })
  const ok = { agent: '{codex}', share: 'codex_share' }
  expect(mk(ok)).not.toThrow()
  expect(mk({ ...ok, agent: '{ghost}' })).toThrow('{ghost}')
  expect(mk({ ...ok, share: 'nope' })).toThrow('split share "nope" is not a param')
  for (const bad of ['abc', '', '-1', '2', 'NaN', 'Infinity'])
    expect(mk(ok, { codex_share: bad })).toThrow('between 0 and 1')
  expect(mk(ok, { codex_share: '0' })).not.toThrow()
  expect(mk(ok, { codex_share: '1' })).not.toThrow()
  expect(mk(ok, {}, true)).toThrow('a gate has no worker, so no split')
})

// claude-factory-61pu.1: a holdMail station parked on a pull request keeps plain mail in its box.
// Only a MAIL with wake: true starts a worker.
const holdGraph = (node: object = { holdMail: true }): Factory => ({
  name: 'ship',
  start: 'deploy',
  nodes: { deploy: { prompt: 'deploy it', next: { deployed: 'done' }, ...node } },
})
const blockOn = (g: Factory, reason: string) => {
  const r = run(g)
  r.send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 10 })
  return { ...r, s: r.send({ type: 'BLOCKED', seq: 1, reason, at: 20 }) }
}

test('plain mail to a holdMail station parked on a pull request stays in the box', () => {
  const { send, s } = blockOn(holdGraph(), 'waiting on ' + PR)
  expect(where(s.value)).toEqual(['deploy', 'waiting'])
  const m = send({ type: 'MAIL', from: 'manager', to: 'deploy', text: 'Report blocked', at: 30 })
  expect(where(m.value)).toEqual(['deploy', 'waiting'])
  expect(m.context.mail.deploy?.at(-1)?.text).toBe('Report blocked')
})

test('a MAIL with wake starts the worker of a held station, with the held mail in its box', () => {
  const { send } = blockOn(holdGraph(), 'waiting on ' + PR)
  send({ type: 'MAIL', from: 'manager', to: 'deploy', text: 'nudge', at: 30 })
  const m = send({ type: 'MAIL', from: 'factory', to: 'deploy', text: 'merged', wake: true, at: 40 })
  expect(where(m.value)).toEqual(['deploy', 'working'])
  expect(m.context.mail.deploy?.map(x => x.text)).toEqual(['nudge', 'merged'])
})

test('a pre-launch PR park of a holdMail station holds plain mail too', () => {
  const g: Factory = {
    name: 'ship',
    start: 'release',
    nodes: {
      release: { prompt: 'ship it', next: { ready: 'deploy' } },
      deploy: { prompt: 'deploy it', awaitsPr: true, holdMail: true, next: { deployed: 'done' } },
    },
  }
  const { send } = run(g)
  send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'ready ' + PR, at: 1000 })
  const m = send({ type: 'MAIL', from: 'manager', to: 'deploy', text: 'hi', at: 2000 })
  expect(where(m.value)).toEqual(['deploy', 'waiting'])
})

test('plain mail still starts a worker: no holdMail, no PR link, or a lifecycle station', () => {
  for (const [g, reason] of [
    [holdGraph({}), 'waiting on ' + PR],
    [holdGraph(), 'waiting on the owner'],
  ] as const) {
    const { send } = blockOn(g, reason)
    const m = send({ type: 'MAIL', from: 'manager', to: 'deploy', text: 'hi', at: 30 })
    expect(where(m.value)).toEqual(['deploy', 'working'])
  }
  const { send } = run()
  send({ type: 'BLOCKED', seq: 1, reason: 'waiting on ' + PR, at: 20 })
  const m = send({ type: 'MAIL', from: 'manager', to: 'implement', text: 'hi', at: 30 })
  expect(where(m.value)).toEqual(['implement', 'working'])
})

test('isParkedOn: only the PR the last blocked report links (61pu AC11)', () => {
  const { s } = blockOn(holdGraph(), 'waiting on ' + PR)
  expect(isParkedOn(s.context, 'deploy', PR)).toBe(true)
  expect(isParkedOn(s.context, 'deploy', 'https://github.com/acme/widget/pull/8')).toBe(false)
  expect(isParkedOn(s.context, 'other', PR)).toBe(false)
})

test('validate refuses holdMail on a gate', () => {
  expect(() =>
    validate({
      name: 'x',
      start: 'g',
      nodes: { g: { prompt: '?', gate: true, holdMail: true, next: { ok: 'done' } } },
    }),
  ).toThrow('g: a gate has no worker, so no mail to hold')
})

describe('an outage hold parks the station and spends no attempt', () => {
  const MIN = 60_000
  const hold = (seq: number, at: number, h = 0) =>
    ({ type: 'FAIL', seq, reason: 'egress gateway: model API unreachable', hold: h, at }) as Ev

  test('three holds do not reach stuck, and the attempt stays 1', () => {
    const { send } = run()
    let at = 1000
    let s = send(hold(1, at))
    for (let i = 2; i <= 3; i++) {
      expect(where(s.value)).toEqual(['implement', 'waiting'])
      at = s.context.wakeAt
      s = send({ type: 'TICK', at })
      expect(where(s.value)).toEqual(['implement', 'working'])
      expect(s.context).toMatchObject({ attempt: 1, seq: i })
      s = send(hold(i, at))
    }
    expect(where(s.value)).toEqual(['implement', 'waiting'])
    expect(s.context.attempt).toBe(1)
    expect(s.context.log.map(e => `${e.outcome}:${e.attempt}`)).toEqual(['outage:1', 'outage:1', 'outage:1'])
  })

  test('the wait doubles up to 120 min, and a later hold wins', () => {
    const { send } = run()
    let at = 1000
    const waits: number[] = []
    let s = send(hold(1, at))
    for (let i = 1; i <= 3; i++) {
      waits.push((s.context.wakeAt - at) / MIN)
      at = s.context.wakeAt
      s = send({ type: 'TICK', at })
      s = send(hold(i + 1, at))
    }
    waits.push((s.context.wakeAt - at) / MIN)
    expect(waits).toEqual([15, 30, 60, 120])
    expect(where(send({ type: 'TICK', at: s.context.wakeAt - 1 }).value)).toEqual(['implement', 'waiting'])

    const { send: send2 } = run()
    const later = 10 * 60 * MIN
    expect(send2(hold(1, 1000, later)).context.wakeAt).toBe(later)
  })

  test('holdMin sets the first wait; it does not lift the hold limit or work without hold', () => {
    const { send } = run()
    const s = send({ ...hold(1, 1000, 1000 + 2 * MIN), holdMin: 2 } as Ev)
    expect(where(s.value)).toEqual(['implement', 'waiting'])
    expect(s.context.wakeAt).toBe(1000 + 2 * MIN)
    expect(s.context.attempt).toBe(1)
    expect(s.context.log.map(e => `${e.outcome}:${e.attempt}`)).toEqual(['outage:1'])

    const r = run()
    let at = 1000
    let x = r.send({ ...hold(1, at), holdMin: 2 } as Ev)
    for (let i = 2; i <= 5; i++) {
      at = x.context.wakeAt
      r.send({ type: 'TICK', at })
      x = r.send({ ...hold(i, at), holdMin: 2 } as Ev)
    }
    expect(where(x.value)).toEqual(['implement', 'backoff'])
    expect(x.context.log.at(-1)?.outcome).toBe('fail')

    const n = run()
    const f = n.send({ type: 'FAIL', seq: 1, reason: 'crashed', holdMin: 2, at: 1000 } as Ev)
    expect(where(f.value)).toEqual(['implement', 'backoff'])
  })

  test('the 5th hold in a row spends an attempt; a fail restarts the streak', () => {
    const { send } = run()
    let at = 1000
    let s = send(hold(1, at))
    for (let i = 2; i <= 5; i++) {
      at = s.context.wakeAt
      send({ type: 'TICK', at })
      s = send(hold(i, at))
    }
    expect(where(s.value)).toEqual(['implement', 'backoff'])
    expect(s.context.log.at(-1)?.outcome).toBe('fail')

    const r = run()
    let t = 1000
    let x = r.send(hold(1, t))
    t = x.context.wakeAt
    r.send({ type: 'TICK', at: t })
    x = r.send({ type: 'FAIL', seq: 2, reason: 'crashed', at: t })
    expect(where(x.value)).toEqual(['implement', 'backoff'])
    t = x.context.retryAt
    r.send({ type: 'TICK', at: t })
    x = r.send(hold(3, t))
    expect(x.context.wakeAt - t).toBe(15 * MIN)
  })

  test('only the first hold of a streak mails the manager, from the factory', () => {
    const { send } = run()
    let s = send(hold(1, 1000))
    const mails = () => s.context.mail.manager ?? []
    expect(mails()).toHaveLength(1)
    expect(mails()[0]).toMatchObject({ from: 'factory' })
    expect(mails()[0]?.text).toContain('held, not failed')
    const at = s.context.wakeAt
    send({ type: 'TICK', at })
    s = send(hold(2, at))
    expect(mails()).toHaveLength(1)
  })

  test('a FAIL without hold behaves as before', () => {
    const { send } = run()
    const s = send({ type: 'FAIL', seq: 1, reason: 'egress gateway: model API unreachable', at: 1000 })
    expect(where(s.value)).toEqual(['implement', 'backoff'])
    expect(s.context.log.at(-1)?.outcome).toBe('fail')
  })
})

describe('gotoRefusal (claude-factory-7dd)', () => {
  const refusal = (r: ReturnType<typeof run>, d: Factory, node: string, pending: Ev[] = []) =>
    gotoRefusal(d, r.saved(), pending, node, 99)

  test('a review held by rounds can go to implement', () => {
    const d: Factory = { ...def, nodes: { ...def.nodes, review: { ...def.nodes.review!, rounds: 1 } } }
    const r = run(d)
    r.send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'a', at: 1 })
    r.send({ type: 'DONE', seq: 2, outcome: 'changes', summary: 'b', at: 2 })
    r.send({ type: 'DONE', seq: 3, outcome: 'ready', summary: 'c', at: 3 })
    r.send({ type: 'DONE', seq: 4, outcome: 'changes', summary: 'd', at: 4 })
    expect(where(r.now().value)).toEqual(['review', 'stuck'])
    expect(refusal(r, d, 'implement')).toBeNull()
  })

  test('a budget hold refuses goto; a pending RETRY refills it; goto done is fine', () => {
    const d: Factory = { ...def, maxSteps: 2 }
    const r = run(d)
    r.send({ type: 'DONE', seq: 1, outcome: 'ready', summary: 'a', at: 1 })
    r.send({ type: 'DONE', seq: 2, outcome: 'changes', summary: 'b', at: 2 })
    expect(where(r.now().value)).toEqual(['implement', 'stuck'])
    const before = r.saved()
    expect(refusal(r, d, 'review')).toContain('step budget used up')
    expect(refusal(r, d, 'review', [{ type: 'RETRY', at: 5 }])).toBeNull()
    expect(refusal(r, d, 'done')).toBeNull()
    expect(r.saved()).toEqual(before)
  })
})

test('isLiveRead names a live read of a cluster, metrics or logs, and nothing else', () => {
  for (const t of [
    'kubectl get pods -n x',
    'Mimir query',
    'Alertmanager silences',
    'LOKI logs',
    'port-forward to pg',
    'live DB read',
    'prod pods',
    'production logs',
  ])
    expect(isLiveRead(t)).toBe(true)
  for (const t of [
    'psql on 127.0.0.1',
    'kubectly',
    'unit tests red',
    'waiting on PR https://github.com/acme/widget/pull/7',
    '',
    'livelihood',
    'products',
  ])
    expect(isLiveRead(t)).toBe(false)
})

test('a mailOnly blocked report parks for 2*OWNER_AFTER_MS: only mail wakes it, and the manager hears once', () => {
  const { send } = run()
  let s = send({ type: 'BLOCKED', seq: 1, reason: 'need kubectl get pods', at: 1000, mailOnly: true })
  expect(s.context.wakeAt).toBe(1000 + 2 * OWNER_AFTER_MS)
  expect(s.context.mail.manager?.at(-1)?.text).toContain('waits for mail')
  expect(s.context.mail.manager?.at(-1)?.text).toContain('kubectl')
  for (const m of [61, 121, 481]) {
    s = send({ type: 'TICK', at: 1000 + m * 60_000 })
    expect(where(s.value)).toEqual(['implement', 'waiting'])
    expect(s.context.seq).toBe(1)
  }
  s = send({ type: 'REPARK', node: 'implement', wakeAt: 5000, at: 5000 })
  expect(s.context.wakeAt).toBe(1000 + 2 * OWNER_AFTER_MS)
  s = send({ type: 'MAIL', from: 'manager', to: 'implement', text: 'results', at: 2_000_000 })
  expect(where(s.value)).toEqual(['implement', 'working'])
  expect(s.context.seq).toBe(2)
})

test('a repeat mailOnly blocked report does not mail the manager again; the owner handoff still ends it', () => {
  const { send } = run()
  send({ type: 'BLOCKED', seq: 1, reason: 'need kubectl', at: 1000, mailOnly: true })
  let s = send({ type: 'MAIL', from: 'manager', to: 'implement', text: 'x', at: 2000 })
  const told = s.context.mail.manager?.length
  s = send({ type: 'BLOCKED', seq: 2, reason: 'need kubectl', at: 3000, mailOnly: true })
  expect(s.context.mail.manager?.length).toBe(told)
  const log = [{ node: 'implement', attempt: 1, outcome: 'blocked', summary: 'need kubectl', at: 0 }]
  expect(shouldHandToOwner(log as never, 25 * 3_600_000)).toBe(true)
})
