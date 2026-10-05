// the mod's pure helpers, tested here because the mod's own tests run under `claude plugin test`
import { expect, test } from 'bun:test'
import { bar, dur, line, patrol, sparkline, track } from '../mod/hooks/view'

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
