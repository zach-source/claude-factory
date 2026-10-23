import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activation, compact, eventWeight, format, usage, usageEvents, use, type UsageEvent } from './memory'

// claude-factory-3u1.2.1: an ACT-R base-level activation over the last 90 days of usage events (research R1)
const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-20T12:00:00Z')
const ev = (kind: UsageEvent['kind'], daysAgo: number, ok?: boolean): UsageEvent => ({
  at: now - daysAgo * DAY,
  kind,
  w: eventWeight(kind, ok),
})

test.each([
  ['helped', undefined, 1],
  ['helped', true, 1],
  ['helped', false, 0.3],
  ['confirmed', undefined, 1],
  ['shown', undefined, 0.15],
  ['contradicted', undefined, -1],
] as const)('eventWeight(%s, ok=%p) is %p', (kind, ok, w) => {
  expect(eventWeight(kind, ok)).toBe(w)
})

test.each<[string, UsageEvent[], number]>([
  ['no events', [], -Infinity],
  ['one help a day ago', [ev('helped', 1)], Math.log(1)],
  ['one help 4 days ago', [ev('helped', 4)], Math.log(0.5)],
  ['a failed help 4 days ago', [ev('helped', 4, false)], Math.log(0.15)],
  ['one show a day ago', [ev('shown', 1)], Math.log(0.15)],
  ['two helps, 1 and 4 days ago', [ev('helped', 1), ev('helped', 4)], Math.log(1.5)],
  ['a help 91 days ago is out of the window', [ev('helped', 91)], -Infinity],
])('activation: %s', (_, events, want) => {
  expect(activation(events, now)).toBeCloseTo(want, 9)
})

test('activation: a contradiction subtracts, and a sum at or below 0 floors at a finite low value', () => {
  const floored = activation([ev('helped', 1), ev('contradicted', 1)], now)
  expect(Number.isFinite(floored)).toBe(true)
  expect(floored).toBeLessThan(activation([ev('shown', 89)], now))
  expect(activation([ev('helped', 1), ev('contradicted', 4)], now)).toBeCloseTo(Math.log(0.5), 9)
})

test('activation: an event logged this instant does not divide by zero', () => {
  expect(Number.isFinite(activation([ev('helped', 0)], now))).toBe(true)
})

test('activation: more recent use scores higher, and more use scores higher', () => {
  expect(activation([ev('helped', 1)], now)).toBeGreaterThan(activation([ev('helped', 10)], now))
  expect(activation([ev('helped', 5), ev('helped', 6)], now)).toBeGreaterThan(
    activation([ev('helped', 5)], now),
  )
})

test('usageEvents reads raw lines with ok, and compact() keeps events within 90 days in its folded line', () => {
  const dir = join(tmpdir(), `memory-activation-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'a.md'), format({ summary: 'a short note', body: 'body' }))
  use(dir, ['beads/a.md'], 'shown', now - 100 * DAY)
  use(dir, ['beads/a.md'], 'shown', now - 2 * DAY)
  use(dir, ['beads/a.md'], 'helped', now - DAY, 'r1/implement')
  writeFileSync(
    join(dir, '.usage.jsonl'),
    readFileSync(join(dir, '.usage.jsonl'), 'utf8') +
      JSON.stringify({ path: 'beads/a.md', helped: 1, at: now - DAY, by: 'r2/verify', ok: false }) +
      '\n',
  )
  const before = usageEvents(dir).get('beads/a.md')!
  expect(before).toEqual([
    { at: now - 100 * DAY, kind: 'shown', w: 0.15 },
    { at: now - 2 * DAY, kind: 'shown', w: 0.15 },
    { at: now - DAY, kind: 'helped', w: 1 },
    { at: now - DAY, kind: 'helped', w: 0.3 },
  ])
  const counts = usage(dir).get('beads/a.md')
  compact(dir, {}, now)
  expect(usageEvents(dir).get('beads/a.md')).toEqual(before.slice(1))
  expect(usage(dir).get('beads/a.md')).toEqual(counts!) // counts still keep the old show
  expect(activation(usageEvents(dir).get('beads/a.md')!, now)).toBeCloseTo(activation(before, now), 9)

  // a line logged after the fold adds its event to the folded ones
  use(dir, ['beads/a.md'], 'confirmed', now)
  expect(usageEvents(dir).get('beads/a.md')).toHaveLength(4)
  rmSync(dir, { recursive: true, force: true })
})
