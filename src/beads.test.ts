import { expect, test } from 'bun:test'
import { dispatchable, goalOf, stationOf, type Bead } from './beads'

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({ id, title: `title ${id}`, ...extra })

test('only top-level beads no run holds are dispatched, up to the room left', () => {
  const ready = [
    ...[bead('fx-1'), bead('fx-1.1', { parent: 'fx-1' }), bead('fx-2'), bead('fx-5', { assignee: 'zach' })],
    ...[bead('fx-3'), bead('fx-4')],
  ]
  expect(dispatchable(ready, new Set(['fx-2']), 2).map(b => b.id)).toEqual(['fx-1', 'fx-3'])
  expect(dispatchable(ready, new Set(), 0)).toEqual([])
  expect(dispatchable(ready, new Set(), -3)).toEqual([])
})

test('a bead becomes a goal and may name its station', () => {
  const b = bead('fx-9', {
    description: 'GET /health',
    acceptance_criteria: 'returns 200',
    labels: ['factory', 'station:incident'],
  })
  expect(goalOf(b)).toBe('fx-9: title fx-9\n\nGET /health\n\nAcceptance: returns 200')
  expect(stationOf(b)).toBe('incident')
  expect(stationOf(bead('fx-8', { labels: ['factory'] }))).toBeUndefined()
  expect(goalOf(bead('fx-7'))).toBe('fx-7: title fx-7')
})
