import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { track, type Track } from './cli'
import { hasShipEdge, type Ctx, type Factory } from './machine'

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

const fakeBd = (name: string, labels: string[]) => {
  const bin = join(tmpdir(), `${name}-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  const show = join(bin, 'show.json')
  writeFileSync(show, JSON.stringify([{ id: 'fx-1', title: 't', labels }]))
  writeFileSync(log, '')
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${log}`,
      'case "$1" in',
      `  show) cat ${show};;`,
      `  children) echo '[]';;`,
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n'), show }
}

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

test('hasShipEdge finds a ship edge and nothing else', () => {
  expect(hasShipEdge(def)).toBe(true)
  expect(hasShipEdge({ nodes: { a: { next: { x: 'done', y: { to: 'done', requeue: true } } } } })).toBe(false)
})
