import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, format, inboxCount, outline, parse, rank, search, type Note } from './memory'

test('a note keeps its summary, rig and provenance through a write and a read', () => {
  const note = {
    summary: 'bd init locks every repo',
    rig: 'fabriek',
    from: 'r1/verify',
    at: '2026-10-06',
    body: 'why\nhow',
  }
  expect(parse('beads/x.md', format(note))).toEqual({ path: 'beads/x.md', ...note })
  expect(parse('inbox/y.md', 'no frontmatter\nmore').summary).toBe('no frontmatter')
})

test("search ranks by the note and its topic, and never shows another rig's notes", () => {
  const note = (path: string, rig?: string): Note => ({ path, summary: path, body: '', rig })
  const vecs: Record<string, number[]> = {
    'beads/lock.md': [0.6, 0.8],
    'ci/flaky.md': [0.7, 0.71],
    'ci/other-rig.md': [1, 0],
  }
  const topics: Record<string, number[]> = { beads: [1, 0], ci: [0, 1] }
  const found = rank(
    [note('beads/lock.md'), note('ci/flaky.md'), note('ci/other-rig.md', 'web')],
    n => vecs[n.path]!,
    t => topics[t],
    [1, 0],
    'api',
  )
  // ci/flaky matches the query better on its own (0.7 vs 0.6), but its topic does not: beads/lock wins
  expect(found.map(f => f.note.path)).toEqual(['beads/lock.md', 'ci/flaky.md'])
})

test('new notes land in the inbox, and the outline lists topics with their summaries', () => {
  const dir = join(tmpdir(), `memory-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'CORE.md'), '- verify before you report\n')
  writeFileSync(
    join(dir, 'beads', 'README.md'),
    format({ summary: 'bd and the shared Dolt server', body: '' }),
  )
  writeFileSync(join(dir, 'beads', 'lock.md'), format({ summary: 'bd init locks every repo', body: '' }))
  expect(add(dir, { summary: 'Use wait-output!', body: '' })).toEndWith('inbox/use-wait-output.md')
  expect(add(dir, { summary: 'Use wait-output!', body: '' })).toEndWith('inbox/use-wait-output-2.md')
  expect(inboxCount(dir)).toBe(2)
  expect(outline(dir)).toEqual({
    core: '- verify before you report',
    topics: ['- beads (1): bd and the shared Dolt server', '- inbox (2): new notes, not yet filed'],
  })
})

test('semantic search finds the note that means the query, not the one that shares its words', async () => {
  const dir = join(tmpdir(), `memory-search-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  add(dir, { summary: 'bd init on the shared Dolt server takes a lock that stalls every repo', body: '' })
  add(dir, { summary: 'kubectl rollout status confirms a deploy finished', body: '' })
  add(dir, { summary: 'the tracker is not slow because of the network', body: '' })
  const [top] = await search(dir, 'why is the issue tracker frozen for all projects?')
  expect(top!.note.summary).toContain('stalls every repo')
}, 60_000)
