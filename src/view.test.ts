// the mod's pure helpers, tested here because the mod's own tests run under `claude plugin test`
import { expect, test } from 'bun:test'
import {
  bar,
  dur,
  line,
  mailKey,
  mailTabs,
  prNeed,
  patrol,
  quickAnswer,
  rigStats,
  sparkline,
  track,
} from '../mod/hooks/view'

test('track folds loops and marks where the run is', () => {
  expect(track(['triage', 'plan', 'implement', 'verify', 'implement'], 'verify')).toEqual([
    { id: 'triage', runs: 1, isCurrent: false },
    { id: 'plan', runs: 1, isCurrent: false },
    { id: 'implement', runs: 2, isCurrent: false },
    { id: 'verify', runs: 1, isCurrent: true },
  ])
  expect(track([], 'triage')).toEqual([{ id: 'triage', runs: 0, isCurrent: true }])
  expect(track(['soak'], 'done').map(s => s.isCurrent)).toEqual([false])
})

test('sparkline, durations, bars and lines', () => {
  expect(sparkline([0, 1, 2, 4], 4)).toBe('▁▃▅█')
  expect(sparkline([3], 3)).toBe('  █')
  expect(sparkline([], 2)).toBe('  ')
  expect(sparkline([2, 2], 2, 8)).toBe('▃▃')
  expect([45_000, 240_000, 4_320_000, 3_600_000, 183_600_000].map(dur)).toEqual([
    '45s',
    '4m',
    '1h12m',
    '1h',
    '2d3h',
  ])
  expect(bar(4, 6, 6)).toBe('████░░')
  expect(bar(0, 0, 3)).toBe('░░░')
  expect(line('a  b\nc', 10)).toBe('a b c')
  expect(line('abcdefgh', 5)).toBe('abcd…')
})

test('patrol wakes the manager for mail, a newly blocked worker, or a heartbeat while workers run', () => {
  const working = {
    id: 'r1',
    node: 'implement',
    sub: 'working',
    agent: 'working',
    goal: 'Add /health',
    since: 1,
  }
  const gate = {
    id: 'r2',
    node: 'approve',
    sub: 'working',
    gate: { question: 'Ship it?', outcomes: ['ship'] },
  }
  const done = { id: 'r3', node: 'done' }
  expect(patrol([working, gate, done], [], new Set(), false)).toBeNull()
  expect(patrol([gate], [], new Set(), true)).toBeNull() // a gate holds no worker to check on

  const beat = patrol([working, gate, done], [], new Set(), true)!
  expect(beat.text).toContain('Heartbeat')
  expect(beat.text).toContain('- r1 at implement/working: Add /health')
  expect(beat.text).toContain('- r2 at approve/working, awaiting the person')
  expect(beat.text).not.toContain('r3')

  const mail = patrol(
    [working],
    [{ run: 'r1', from: 'implement', text: 'Redis OK?', at: 2 }],
    new Set(),
    false,
  )!
  expect(mail.text).toContain('- r1 / implement: Redis OK?')

  const blocked = { ...working, agent: 'blocked', pane: 'w1:p2' }
  const first = patrol([blocked], [], new Set(), false)!
  expect(first.text).toContain('its worker (pane w1:p2) is waiting on a prompt')
  expect(patrol([blocked], [], new Set(first.keys), false)).toBeNull() // reported once per worker
})

test('patrol sends the board only when it changed, and caps each message', () => {
  const working = { id: 'r1', node: 'implement', sub: 'working', goal: 'Add /health', since: 1 }
  const beat = patrol([working], [], new Set(), true)!
  expect(beat.board).toContain('- r1 at implement/working')
  const again = patrol([working], [], new Set(), true, [], beat.board)!
  expect(again.text).toContain('Board and rig goals: unchanged')
  expect(again.text).not.toContain('Add /health')
  expect(patrol([{ ...working, node: 'verify' }], [], new Set(), true, [], beat.board)!.text).toContain(
    'r1 at verify',
  )
  const long = patrol(
    [working],
    [{ run: 'r1', from: 'plan', text: 'x'.repeat(5000), at: 2 }],
    new Set(),
    false,
  )!
  expect(long.text.length).toBeLessThan(600)
})

test("patrol keeps the manager working toward a rig's goal while the rig has room", () => {
  const fab = { name: 'fab', repo: '/r/fab', factory: 'lifecycle', maxRuns: 2, goal: 'finish the features' }
  const run = (id: string, sub: string) => ({ id, rig: 'fab', node: 'implement', sub, goal: id, since: 1 })
  const idle = patrol([], [], new Set(), true, [fab])!
  expect(idle.text).toContain('Board: no runs.')
  expect(idle.text).toContain('- fab, busy 0/2: finish the features')
  expect(patrol([], [], new Set(), false, [fab])).toBeNull() // only on the heartbeat
  expect(patrol([], [], new Set(), true, [{ ...fab, goal: undefined }])).toBeNull() // no goal, nothing to do
  const full = [run('a', 'working'), run('b', 'backoff')]
  expect(patrol(full, [], new Set(), true, [fab])!.text).toContain('busy 2/2')
  expect(patrol([run('a', 'waiting'), run('b', 'waiting')], [], new Set(), true, [fab])).not.toBeNull()
  // at its cap with no worker running, a rig has nothing for the manager to add
  expect(patrol([run('a', 'backoff'), run('b', 'backoff')], [], new Set(), true, [fab])).toBeNull()
})

test("a rig's stats count its own runs only, by station, with what needs the person", () => {
  const runs = [
    { id: 'a', rig: 'web', node: 'implement', sub: 'working' },
    { id: 'b', rig: 'web', node: 'implement', sub: 'stuck' },
    { id: 'c', rig: 'web', node: 'approve', sub: 'working', gate: { question: 'ship?', outcomes: ['ship'] } },
    { id: 'd', rig: 'web', node: 'soak', sub: 'waiting' },
    { id: 'e', rig: 'web', node: 'done' },
    { id: 'f', rig: 'api', node: 'plan', sub: 'working' },
  ]
  expect(rigStats({ name: 'web', maxRuns: 3 }, runs)).toEqual({
    busy: 2, // a and b hold workers; the gate and the timer do not
    room: 1,
    stations: [
      { node: 'implement', n: 2 },
      { node: 'approve', n: 1 },
      { node: 'soak', n: 1 },
    ],
    gates: ['c'],
    stuck: ['b'],
    done: 1,
    aborted: 0,
  })
  expect(rigStats({ name: 'api' }, runs).room).toBeNull() // no cap of its own
})

test('a quick answer goes to the asking station, or tells the station the run moved on to what it answers', () => {
  const m = { run: 'r1', from: 'implement', text: 'May I drop the legacy endpoint?', at: 5 }
  expect(mailKey(m)).toBe('r1@5')
  expect(quickAnswer(m, { node: 'implement' }, 'approve', '')).toEqual({
    to: 'implement',
    text: 'The person approves: go ahead.',
  })
  expect(quickAnswer(m, { node: 'implement' }, 'reject', 'keep it a release longer')!.text).toBe(
    'The person rejects it: do not go ahead. keep it a release longer',
  )
  const moved = quickAnswer(m, { node: 'verify' }, 'reply', 'yes, behind a flag')!
  expect(moved.to).toBe('verify')
  expect(moved.text).toBe(
    'About the implement station\'s message "May I drop the legacy endpoint?": The person answers: yes, behind a flag',
  )
  expect(quickAnswer(m, { node: 'done' }, 'approve', '')).toBeNull() // nobody would read it
})

test('mail answered in the console, or from an ended run, leaves the not-answered tab', () => {
  const m = (run: string, at: number) => ({ run, from: 'implement', at, text: '?' })
  const runs = [
    { id: 'a', node: 'implement' },
    { id: 'b', node: 'done' },
  ] as Parameters<typeof mailTabs>[1]
  const mail = [m('a', 1), m('a', 2), m('b', 3)]
  const { open, answered } = mailTabs(mail, runs, { [mailKey(m('a', 1))]: 'approve' })
  expect(open).toEqual([m('a', 2)])
  expect(answered).toEqual([m('a', 1), m('b', 3)])
})

test('a pull request names what it waits on, worst first', () => {
  const need = (reviewDecision: string, mergeStateStatus: string) =>
    prNeed({ reviewDecision, mergeStateStatus }).word
  expect(need('REVIEW_REQUIRED', 'DIRTY')).toBe('conflicts')
  expect(need('REVIEW_REQUIRED', 'BLOCKED')).toBe('needs approval')
  expect(need('APPROVED', 'CLEAN')).toBe('ready to merge')
  expect(need('', 'BLOCKED')).toBe('blocked by a rule')
})
