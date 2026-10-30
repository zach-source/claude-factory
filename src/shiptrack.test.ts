import { beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beads } from './beads'
import { closeParents, shipPrOf, track, type Track } from './cli'
import { hasShipEdge, type Ctx, type Factory } from './machine'

const repairsLog = join(mkdtempSync(join(tmpdir(), 'repairs-')), 'repairs.jsonl')
beforeAll(() => {
  process.env.FACTORY_REPAIRS_LOG = repairsLog
})

const PR = 'https://github.com/acme/widget/pull/42'
const def = {
  name: 'f',
  start: 'review',
  nodes: {
    review: { prompt: '', next: { approve: { to: 'done', ship: true }, changes: 'review' } },
    quick: { prompt: '', next: { done: 'done' } },
  },
} satisfies Factory
const run = {
  id: 'run-1',
  factory: 'f',
  repo: tmpdir(),
  goal: 'g',
  ws: 'w',
  worktree: 'wt',
  branch: 'factory/run-1',
  bead: 'fx-1',
}
const ctx = (summary: string, outcome = 'approve') =>
  ({ log: [{ node: 'review', attempt: 1, outcome, summary, at: 1 }] }) as unknown as Ctx

const fakeBd = (name: string, labels: string[], list = '') => {
  const bin = join(tmpdir(), `${name}-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  const show = join(bin, 'show.json')
  const listOut = join(bin, 'list.json')
  writeFileSync(show, JSON.stringify([{ id: 'fx-1', title: 't', labels }]))
  writeFileSync(listOut, list)
  writeFileSync(log, '')
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${log}`,
      'case "$1" in',
      `  show) cat ${show};;`,
      `  children) echo '[]';;`,
      `  list) cat ${listOut};;`,
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n'), show }
}

test('shipPrOf: one link is the PR; with several it is the one whose head is the run branch', () => {
  const [a, b] = [`${PR}1`, `${PR}2`]
  expect(shipPrOf([a], 'factory/run-1')).toBe(a)
  expect(shipPrOf([], 'factory/run-1')).toBe('')
  const headOf = (url: string) => (url === b ? 'factory/run-1' : 'factory/other')
  expect(shipPrOf([a, b], 'factory/run-1', headOf)).toBe(b)
  expect(shipPrOf([a, b], 'factory/none', headOf)).toBe('')
})

test('a run that ends on a ship edge hands its bead to ship: open, relabeled, never closed or deferred', () => {
  const f = fakeBd('fake-bd-track-ship', ['factory', 'station:review'])
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    const t: Track = { mirrored: 1, beatAt: 0, isSettled: false }
    track(run, def, { done: '' }, ctx(`approve ${PR}`), t, Date.now())
    const calls = f.calls()
    expect(calls.some(c => c.startsWith('close '))).toBe(false)
    expect(calls.some(c => c.startsWith('defer '))).toBe(false)
    const update = calls.find(c => c.startsWith('update fx-1'))!
    expect(update).toContain('--remove-label factory --remove-label station:review')
    expect(update).toContain('--add-label ship')
    expect(update).toContain(`--set-metadata ship_pr=${PR}`)
    expect(update).toContain('--set-metadata ship_branch=factory/run-1')
    expect(update).toContain('--set-metadata ship_run=run-1')
    expect(calls.filter(c => c.startsWith('comment fx-1 handed off to ship')).length).toBe(1)
    expect(t.isSettled).toBe(true)
  } finally {
    process.env.PATH = path
  }
})

test('a run that ends on a plain edge still closes its bead', () => {
  const f = fakeBd('fake-bd-track-plain', ['factory'])
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    const plain = { ...def, nodes: { review: { prompt: '', next: { approve: 'done' } } } } satisfies Factory
    track(
      run,
      plain,
      { done: '' },
      ctx(`approve ${PR}`),
      { mirrored: 1, beatAt: 0, isSettled: false },
      Date.now(),
    )
    expect(f.calls().some(c => c.startsWith('close fx-1'))).toBe(true)
    expect(f.calls().some(c => c.includes('--add-label ship'))).toBe(false)
  } finally {
    process.env.PATH = path
  }
})

const plain = { ...def, nodes: { review: { prompt: '', next: { approve: 'done' } } } } satisfies Factory
const trackPlain = (list: string, c = ctx(`approve ${PR}`)) => {
  const f = fakeBd(`fake-bd-parent-${Math.random().toString(36).slice(2)}`, ['factory'], list)
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    const t: Track = { mirrored: 1, beatAt: 0, isSettled: false }
    track({ ...run, bead: 'fx-1.1' }, plain, { done: '' }, c, t, Date.now())
    return { calls: f.calls(), t }
  } finally {
    process.env.PATH = path
  }
}
const bead = (id: string, status = 'open') => ({ id, title: id, status })

test('a run that closes the last child also closes its parent, with a comment that cites the run', () => {
  const { calls } = trackPlain(JSON.stringify([bead('fx-1'), bead('fx-1.1'), bead('fx-1.2', 'closed')]))
  expect(calls.some(c => c.startsWith('close fx-1.1'))).toBe(true)
  expect(calls.filter(c => c.startsWith('close fx-1 --reason every child is closed'))).toHaveLength(1)
  const comment = calls.filter(c => c.startsWith('comment fx-1 '))
  expect(comment).toHaveLength(1)
  expect(comment[0]).toContain('run run-1')
  expect(comment[0]).toContain('fx-1.1')
  const row = JSON.parse(readFileSync(repairsLog, 'utf8').trim().split('\n').pop()!)
  expect(row).toMatchObject({ kind: 'close', id: 'fx-1', child: 'fx-1.1', by: 'run run-1' })
})

test('an open sibling leaves the parent alone', () => {
  const { calls } = trackPlain(JSON.stringify([bead('fx-1'), bead('fx-1.1'), bead('fx-1.2')]))
  expect(calls.some(c => c.startsWith('close fx-1 '))).toBe(false)
  expect(calls.some(c => c.startsWith('comment fx-1 '))).toBe(false)
})

test('a bd list that prints junk does not stop the run settling or defer the bead', () => {
  const { calls, t } = trackPlain('not json')
  expect(t.isSettled).toBe(true)
  expect(calls.some(c => c.startsWith('defer '))).toBe(false)
  expect(calls.some(c => c.startsWith('close fx-1.1'))).toBe(true)
})

test('closeParents shares one closed set: the second close of a pass closes the parent from a stale list', () => {
  const f = fakeBd(
    'fake-bd-closeparents',
    ['factory'],
    JSON.stringify([bead('fx-1'), bead('fx-1.1'), bead('fx-1.2')]),
  )
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')
    const closed = new Set(['fx-1.1'])
    closeParents(b, tmpdir(), 'fx-1.1', 'the repair pass', closed)
    expect(f.calls().some(c => c.startsWith('close fx-1 '))).toBe(false)
    closed.add('fx-1.2')
    closeParents(b, tmpdir(), 'fx-1.2', 'the repair pass', closed)
    expect(f.calls().filter(c => c.startsWith('close fx-1 '))).toHaveLength(1)
  } finally {
    process.env.PATH = path
  }
})

test('closeParents adds each parent it closes to the shared set, so a later close sees it', () => {
  const list = [bead('g'), bead('g.1'), bead('g.1.1'), bead('g.2')]
  const f = fakeBd('fake-bd-closeparents-2', ['factory'], JSON.stringify(list))
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')
    const closed = new Set(['g.1.1'])
    closeParents(b, tmpdir(), 'g.1.1', 'the repair pass', closed)
    expect(closed.has('g.1')).toBe(true)
    closed.add('g.2')
    closeParents(b, tmpdir(), 'g.2', 'the repair pass', closed)
    expect(f.calls().filter(c => c.startsWith('close g '))).toHaveLength(1)
  } finally {
    process.env.PATH = path
  }
})

test('hasShipEdge finds a ship edge and nothing else', () => {
  expect(hasShipEdge(def)).toBe(true)
  expect(hasShipEdge({ nodes: { a: { next: { x: 'done', y: { to: 'done', requeue: true } } } } })).toBe(false)
})
