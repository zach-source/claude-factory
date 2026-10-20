import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beads, shipQueueText, type Bead } from './beads'

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({ id, title: `title ${id}`, ...extra })

const fakeBd = (name: string) => {
  const bin = join(tmpdir(), `${name}-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const [log, show, list] = ['calls', 'show.json', 'list.json'].map(f => join(bin, f)) as [
    string,
    string,
    string,
  ]
  const script = [
    '#!/bin/sh',
    `echo "$*" >> ${log}`,
    'case "$1" in',
    `  show) cat ${show};;`,
    `  list) cat ${list};;`,
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  return { bin, log, show, list }
}

test('ship hands a bead to the queue: unclaims, relabels, keeps the first branch and PR, once per run', () => {
  const f = fakeBd('fake-bd-ship')
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory/run-1')
    writeFileSync(
      f.show,
      JSON.stringify([
        { id: 'fx-1', title: 't', labels: ['factory', 'factory:lifecycle', 'station:review'] },
      ]),
    )
    writeFileSync(f.log, '')
    b.ship('fx-1', 'run-1', { pr: 'https://x/pull/1', branch: 'factory/run-1' })
    const calls = readFileSync(f.log, 'utf8').trim().split('\n')
    expect(calls[0]).toBe('unclaim fx-1 --actor factory/run-1')
    expect(calls[2]).toContain(
      '--remove-label factory --remove-label factory:lifecycle --remove-label station:review',
    )
    expect(calls[2]).toContain('--add-label ship')
    expect(calls[2]).toContain('--set-metadata ship_run=run-1')
    expect(calls[2]).toContain('--set-metadata ship_branch=factory/run-1')
    expect(calls[2]).toContain('--set-metadata ship_pr=https://x/pull/1')
    expect(calls[2]).toMatch(/--set-metadata ship_at=\S+/)
    expect(calls[3]).toContain('comment fx-1 handed off to ship')

    // a retried tick: this run already handed it off
    writeFileSync(
      f.show,
      JSON.stringify([{ id: 'fx-1', title: 't', labels: ['ship'], metadata: { ship_run: 'run-1' } }]),
    )
    writeFileSync(f.log, '')
    b.ship('fx-1', 'run-1', { pr: 'https://x/pull/1', branch: 'factory/run-1' })
    expect(readFileSync(f.log, 'utf8')).not.toContain('--add-label')
    expect(readFileSync(f.log, 'utf8')).not.toContain('comment')

    // a re-handoff by a rework run keeps the original branch and PR
    writeFileSync(
      f.show,
      JSON.stringify([
        {
          id: 'fx-1',
          title: 't',
          labels: ['factory'],
          metadata: { ship_run: 'run-1', ship_branch: 'factory/run-1', ship_pr: 'https://x/pull/1' },
        },
      ]),
    )
    writeFileSync(f.log, '')
    b.ship('fx-1', 'run-2', { pr: 'https://x/pull/9', branch: 'factory/run-2' })
    const again = readFileSync(f.log, 'utf8')
    expect(again).toContain('--set-metadata ship_run=run-2')
    expect(again).not.toContain('ship_branch')
    expect(again).not.toContain('ship_pr')
  } finally {
    process.env.PATH = path
  }
})

test('shipQueue lists open ship beads oldest ship_at first and marks the first next', () => {
  const f = fakeBd('fake-bd-shipq')
  const path = process.env.PATH
  process.env.PATH = `${f.bin}:${path}`
  try {
    writeFileSync(
      f.list,
      JSON.stringify([
        bead('fx-2', {
          labels: ['ship'],
          metadata: { ship_at: '2026-10-20T02:00:00Z', ship_pr: 'p2', ship_run: 'r2' },
        }),
        bead('fx-1', {
          labels: ['ship'],
          metadata: { ship_at: '2026-10-20T01:00:00Z', ship_pr: 'p1', ship_run: 'r1' },
        }),
      ]),
    )
    const q = beads(tmpdir(), 'a').shipQueue()
    expect(q.map(b => b.id)).toEqual(['fx-1', 'fx-2'])
    expect(readFileSync(f.log, 'utf8')).toContain('list -l ship --status open --json')
    const lines = shipQueueText(q, Date.parse('2026-10-20T03:00:00Z')).split('\n')
    expect(lines[0]).toMatch(/^next +fx-1 +p1 +r1 +2h/)
    expect(lines[1]).toMatch(/^ {5}fx-2 +p2 +r2 +1h/)
    expect(shipQueueText([], 0)).toBe('ship queue empty')
  } finally {
    process.env.PATH = path
  }
})
