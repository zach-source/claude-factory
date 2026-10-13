import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beads, dispatchable, goalOf, isOwned, stationOf, type Bead } from './beads'

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

test("a bead carrying its owner's decisions is theirs, not the factory's", () => {
  expect(isOwned(bead('fx-1', { metadata: { owner_decisions: { pilot: {} } } }))).toBe(true)
  expect(isOwned(bead('fx-2', { metadata: { speckit: {} } }))).toBe(false)
  expect(isOwned(bead('fx-3'))).toBe(false)
})

test('a heartbeat bd cannot make keeps the claim: lost only to a named other assignee', () => {
  const bin = join(tmpdir(), `fake-bd-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  // heartbeat and claim always fail; show answers with $SHOW, or fails when it is unset
  const script =
    '#!/bin/sh\ncase "$1" in show) [ -n "$SHOW" ] && echo "$SHOW" && exit 0;; esac\necho locked >&2; exit 1\n'
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory/run-1')
    delete process.env.SHOW
    expect(() => b.heartbeat('fx-1')).toThrow('bd unavailable')
    process.env.SHOW = '[{"id":"fx-1","assignee":"factory/run-1"}]'
    expect(b.heartbeat('fx-1')).toBe(true)
    process.env.SHOW = '[{"id":"fx-1","assignee":"someone-else"}]'
    expect(b.heartbeat('fx-1')).toBe(false)
  } finally {
    process.env.PATH = path
    delete process.env.SHOW
  }
})

test('a rejected bead stays open, out of the queue, saying who rejected it, when and why; queuing takes it back', () => {
  const bin = join(tmpdir(), `fake-bd-reject-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  writeFileSync(join(bin, 'bd'), `#!/bin/sh\necho "$*" >> ${log}\n`)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory/run-1')
    b.reject('fx-1', 'run-1/triage', 'already tracked by fx-2')
    b.queue('fx-1')
    const [unclaim, update, queue] = readFileSync(log, 'utf8').trim().split('\n')
    expect(unclaim).toBe('unclaim fx-1 --actor factory/run-1')
    expect(update).toStartWith(
      'update fx-1 --remove-label factory --add-label rejected --set-metadata rejected_by=run-1/triage',
    )
    expect(update).toMatch(
      /--set-metadata rejected_at=\d{4}-\d\d-\d\dT[^ ]+ --set-metadata reject_reason=already tracked by fx-2 /,
    )
    // nothing closes it: still open and ready for a person
    expect(readFileSync(log, 'utf8')).not.toContain('close')
    expect(queue).toBe('update fx-1 --add-label factory --remove-label rejected --actor factory/run-1')
  } finally {
    process.env.PATH = path
  }
})
