// the mod's pure helpers, tested here because the mod's own tests run under `claude plugin test`
import { expect, test } from 'bun:test'
import { bar, dur, line, sparkline, track } from '../mod/hooks/view'

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
