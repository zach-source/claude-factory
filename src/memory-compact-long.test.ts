// applyTiers() on LONG.md entries: archive (old and idle), retire (until ended), trim (over 2000 chars).
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTiers, compact, formatLong, type LongEntry, LONG_ENTRY_CAP, parseLong } from './memory'

const root = join(tmpdir(), `memory-compact-long-${process.pid}`)
const dir = join(root, 'memory')
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-27T00:00:00Z')
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString().slice(0, 10)
const longFile = join(dir, 'beads', 'LONG.md')
const archiveFile = join(dir, '.archive', 'beads.md')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = (id: string, o: Partial<LongEntry> = {}): LongEntry => ({
  id,
  summary: `summary of ${id}`,
  from: 'r1/x, r2/y',
  at: at(1),
  body: `body of ${id}`,
  ...o,
})
const seed = (entries: LongEntry[], readme = '') => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(longFile, formatLong(entries))
  if (readme) writeFileSync(join(dir, 'beads', 'README.md'), readme)
  // 40 days of usage history, so the 30-day age rule can fire
  writeFileSync(
    join(dir, '.usage.jsonl'),
    `${JSON.stringify({ path: 'beads/other.md', kind: 'shown', at: NOW - 40 * DAY_MS })}\n`,
  )
}
const bigBody = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `## line ${i} ${'x'.repeat(80)}`).join('\n')

test('an old idle entry archives: the others stay byte-equal, the archive holds it, the README links it', () => {
  const keep = entry('keep', { body: 'kept\n## a heading in the body\nmore' })
  const old = entry('old', { at: at(60), until: undefined })
  seed([keep, old], 'index: [old](LONG.md#old)\n')
  const r = applyTiers(dir, { now: NOW })
  expect(r.archived).toBe(1)
  expect(parseLong(readFileSync(longFile, 'utf8'))).toEqual([keep])
  const arch = readFileSync(archiveFile, 'utf8')
  expect(arch).toContain('summary: summary of old')
  expect(arch).toContain('from: r1/x, r2/y')
  expect(arch).toContain('body of old')
  expect(readFileSync(join(dir, 'beads', 'README.md'), 'utf8')).toBe('index: [old](../.archive/beads.md)\n')
})

test('an entry whose until date ended retires at any age', () => {
  seed([entry('gone', { until: '2026-01-01' }), entry('stay')])
  const r = applyTiers(dir, { now: NOW })
  expect(r.retired).toBe(1)
  expect(parseLong(readFileSync(longFile, 'utf8')).map(e => e.id)).toEqual(['stay'])
  expect(readFileSync(archiveFile, 'utf8')).toContain('until: 2026-01-01')
})

test('a long entry is trimmed at a line end, keeps its metadata, and a second pass trims nothing', () => {
  const big = entry('big', { rig: 'acme/widget', aliases: ['old-id'], body: bigBody(60) })
  seed([big])
  const r = applyTiers(dir, { now: NOW })
  expect(r.trimmed).toBe(1)
  const [e] = parseLong(readFileSync(longFile, 'utf8'))
  expect(e!.summary.length + 1 + e!.body.length).toBeLessThanOrEqual(LONG_ENTRY_CAP)
  expect(e!.body.endsWith('(cut to 2000 chars; full text in .archive/beads.md)')).toBe(true)
  expect({ ...e, body: '' }).toEqual({ ...big, body: '' })
  expect(e!.body.split('\n').every(l => l.startsWith('## line ') || l === '' || l.startsWith('(cut'))).toBe(
    true,
  )
  expect(readFileSync(archiveFile, 'utf8')).toContain(big.body)
  const again = applyTiers(dir, { now: NOW })
  expect(again.trimmed).toBe(0)
  expect(readFileSync(archiveFile, 'utf8').split('summary: summary of big').length).toBe(2)
})

test('a topic with text before its first entry is skipped, not rewritten', () => {
  seed([entry('big', { body: bigBody(60) })])
  const text = `${readFileSync(longFile, 'utf8').replace('---\n\n', '---\nstray prose\n\n')}`
  writeFileSync(longFile, text)
  const r = applyTiers(dir, { now: NOW })
  expect(r.trimmed).toBe(0)
  expect(r.skipped.map(s => s.topic)).toEqual(['beads'])
  expect(readFileSync(longFile, 'utf8')).toBe(text)
  expect(existsSync(archiveFile)).toBe(false)
})

test('compact() keeps usage of a trimmed entry and drops it for an archived one', () => {
  seed([entry('big', { body: bigBody(60) }), entry('old', { at: at(60) })])
  const usage = ['big', 'old']
    .map(id => JSON.stringify({ path: `beads/LONG.md#${id}`, kind: 'shown', at: NOW - 40 * DAY_MS }))
    .join('\n')
  writeFileSync(join(dir, '.usage.jsonl'), `${usage}\n`)
  applyTiers(dir, { now: NOW })
  compact(dir, {}, NOW)
  const paths = readFileSync(join(dir, '.usage.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l).path)
  expect(paths).toContain('beads/LONG.md#big')
  expect(paths).not.toContain('beads/LONG.md#old')
})

test('an entry whose summary alone passes the cap is not trimmed again on a second pass', () => {
  seed([entry('wide', { summary: 'w'.repeat(LONG_ENTRY_CAP + 100), body: bigBody(10) })])
  const first = applyTiers(dir, { now: NOW })
  const archive1 = existsSync(archiveFile) ? readFileSync(archiveFile, 'utf8') : ''
  const second = applyTiers(dir, { now: NOW })
  expect(first.trimmed).toBe(0)
  expect(second.trimmed).toBe(0)
  expect(existsSync(archiveFile) ? readFileSync(archiveFile, 'utf8') : '').toBe(archive1)
})
