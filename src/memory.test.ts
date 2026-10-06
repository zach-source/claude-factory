import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  add,
  close,
  compact,
  coreFor,
  format,
  inboxCount,
  outline,
  parse,
  rank,
  same,
  search,
  usage,
  usageLines,
  use,
  type Note,
} from './memory'

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

test('usage follows a note the dream files, and is dropped with a note it removes', () => {
  const dir = join(tmpdir(), `memory-usage-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const day = Date.parse('2026-10-06T12:00:00Z')
  use(dir, ['inbox/lock.md', 'inbox/gone.md'], 'shown', day)
  use(dir, ['inbox/lock.md'], 'shown', day + 1)
  use(dir, ['inbox/lock.md'], 'helped', day + 2)
  expect(usage(dir).get('inbox/lock.md')).toEqual({ path: 'inbox/lock.md', shown: 2, helped: 1, at: day + 2 })

  // the dream moved lock.md under beads/ and removed gone.md
  writeFileSync(join(dir, 'beads', 'lock.md'), format({ summary: 'bd init locks every repo', body: '' }))
  writeFileSync(join(dir, 'beads', 'unused.md'), format({ summary: 'never searched for', body: '' }))
  compact(dir, { 'inbox/lock.md': 'beads/lock.md' })
  expect([...usage(dir).keys()]).toEqual(['beads/lock.md'])
  expect(usageLines(dir)).toEqual([
    '- beads/lock.md: helped 1, shown 2, last used 2026-10-06',
    '- beads/unused.md: never shown',
  ])
})

test('a search keeps the matches and drops the filler after them', () => {
  const r = (score: number) => ({ score })
  expect(close([r(0.88), r(0.87), r(0.7), r(0.65)], 5)).toEqual([r(0.88), r(0.87)])
  expect(close([r(0.65), r(0.62), r(0.58)], 5)).toEqual([r(0.65), r(0.62)]) // weak, but above the floor
  expect(close([r(0.5)], 5)).toEqual([])
})

test("each rig's workers read the core for every rig and their own rig's section only", () => {
  const core = [
    '- verify before you report',
    '## rig: web',
    '- npm, not yarn',
    '## rig: api',
    '- uv run --frozen',
    '## Why',
    '- notes',
  ].join('\n')
  expect(coreFor(core, 'web')).toBe(
    ['- verify before you report', '## rig: web', '- npm, not yarn', '## Why', '- notes'].join('\n'),
  )
  expect(coreFor(core)).toBe(['- verify before you report', '## Why', '- notes'].join('\n'))
})

test('adding what a note already says finds that note', async () => {
  const dir = join(tmpdir(), `memory-same-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  add(dir, {
    summary: 'fabriek has no CHANGELOG file or per-PR version bump convention',
    body: 'checked the whole history',
    rig: 'fabriek',
  })
  add(dir, { summary: 'kubectl rollout status confirms a deploy finished', body: '' })
  const dup = await same(dir, {
    summary: 'no changelog or version bump convention exists in fabriek',
    rig: 'fabriek',
  })
  expect(dup?.note.summary).toContain('CHANGELOG')
  expect(await same(dir, { summary: 'the dashboard CSP is default-src self', rig: 'fabriek' })).toBeNull()
  // another rig's note is not this rig's lesson
  expect(
    await same(dir, {
      summary: 'no changelog or version bump convention exists in fabriek',
      rig: 'api',
    }),
  ).toBeNull()
}, 60_000)
