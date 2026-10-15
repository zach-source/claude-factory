import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  add,
  close,
  compact,
  CORE_BUDGET,
  coreFor,
  decide,
  format,
  formatLong,
  inboxCount,
  installSkill,
  type LongEntry,
  managerActivity,
  noteExists,
  outline,
  parse,
  parseLong,
  pendingSkills,
  rank,
  rejectSkill,
  resolvePath,
  same,
  type ShortCandidate,
  skillsDir,
  skillSources,
  search,
  tally,
  usage,
  usageLines,
  use,
  walk,
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

test('a LONG.md entry keeps its id, rig, from, at and body through a write and a read', () => {
  const entries: LongEntry[] = [
    { id: 'bd-lock', summary: 'bd init locks every repo', rig: 'fabriek', from: 'r1/verify', at: '2026-10-06', body: 'why\nhow' },
    { id: 'no-meta', summary: 'a plain entry with no rig, from or at', body: 'just a body' },
  ]
  expect(parseLong(formatLong(entries))).toEqual(entries)
  expect(formatLong(entries)).toContain('tier: long')
})

test('walk() turns each LONG.md entry into one note, skips .archive, and outline counts entries', () => {
  const dir = join(tmpdir(), `memory-long-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  mkdirSync(join(dir, '.archive'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'README.md'), format({ summary: 'bd topic', body: '' }))
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([
      { id: 'lock', summary: 'bd init locks every repo', body: 'merged lesson one' },
      { id: 'dolt', summary: 'the dolt server is shared', rig: 'fabriek', body: 'merged lesson two' },
    ]),
  )
  writeFileSync(join(dir, 'beads', 'fresh.md'), format({ summary: 'a fresh short note', body: '' }))
  writeFileSync(join(dir, '.archive', 'beads.md'), 'archived text nobody should ever walk')
  const { notes } = walk(dir)
  expect(notes.map(n => n.path).sort()).toEqual([
    'beads/LONG.md#dolt',
    'beads/LONG.md#lock',
    'beads/fresh.md',
  ])
  const long = notes.find(n => n.path === 'beads/LONG.md#lock')!
  expect(long.tier).toBe('long')
  expect(long.summary).toBe('bd init locks every repo')
  expect(long.body).toBe('merged lesson one')
  const short = notes.find(n => n.path === 'beads/fresh.md')!
  expect(short.tier).toBe('short')
  expect(outline(dir).topics).toEqual(['- beads (3): bd topic'])
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
  expect(usage(dir).get('inbox/lock.md')).toEqual({
    path: 'inbox/lock.md',
    shown: 2,
    helped: 1,
    at: day + 2,
    runs: 1, // all three lines fall on the same UTC day
  })

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

test('tally counts runs by distinct `by`, or by distinct UTC day for an older line with none', () => {
  const at = Date.parse('2026-10-06T12:00:00Z')
  const withBy = [
    JSON.stringify({ path: 'a.md', helped: 1, at, by: 'run1/verify' }),
    JSON.stringify({ path: 'a.md', helped: 1, at: at + 1000, by: 'run1/verify' }), // same run again: still 1
    JSON.stringify({ path: 'a.md', helped: 1, at: at + 2000, by: 'run2/implement' }),
  ]
  expect(tally(withBy).get('a.md')).toEqual({ path: 'a.md', shown: 0, helped: 3, at: at + 2000, runs: 2 })

  const legacy = [
    JSON.stringify({ path: 'b.md', helped: 1, at }),
    JSON.stringify({ path: 'b.md', helped: 1, at: at + 24 * 60 * 60 * 1000 }), // next UTC day
  ]
  expect(tally(legacy).get('b.md')?.runs).toBe(2)

  // an aggregate compact() already wrote (its own `runs`) adds to the total instead of becoming 1 key
  const folded = [
    JSON.stringify({ path: 'c.md', shown: 5, helped: 2, at, runs: 2 }),
    JSON.stringify({ path: 'c.md', helped: 1, at: at + 2000, by: 'run3/verify' }),
  ]
  expect(tally(folded).get('c.md')).toEqual({ path: 'c.md', shown: 5, helped: 3, at: at + 2000, runs: 3 })
})

test('compact() keeps a LONG.md entry\'s usage under its #id, and drops it only when the id is gone', () => {
  const dir = join(tmpdir(), `memory-long-usage-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([{ id: 'lock', summary: 'bd init locks every repo', body: 'merged' }]),
  )
  use(dir, ['beads/LONG.md#lock'], 'helped')
  expect(noteExists(dir, 'beads/LONG.md#lock')).toBe(true)
  expect(noteExists(dir, 'beads/LONG.md#gone')).toBe(false)
  compact(dir, {})
  expect(usage(dir).get('beads/LONG.md#lock')?.helped).toBe(1)
})

test('compact() logs a rename so a later `helped <old path>` still resolves, even through a chain', () => {
  const dir = join(tmpdir(), `memory-renames-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  use(dir, ['inbox/lock.md'], 'helped')
  writeFileSync(join(dir, 'beads', 'lock.md'), format({ summary: 'bd init locks every repo', body: '' }))
  compact(dir, { 'inbox/lock.md': 'beads/lock.md' }) // dream #1: filed
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([{ id: 'lock', summary: 'bd init locks every repo', body: 'merged' }]),
  )
  rmSync(join(dir, 'beads', 'lock.md'))
  compact(dir, { 'beads/lock.md': 'beads/LONG.md#lock' }) // dream #2: merged into the long tier
  expect(resolvePath(dir, 'inbox/lock.md')).toBe('beads/LONG.md#lock')
  expect(usage(dir).get('beads/LONG.md#lock')?.helped).toBe(1)
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
  // the summaries' vectors are cached, so the next add embeds only its own
  expect(existsSync(join(dir, '.index.json.summaries'))).toBe(true)
  expect(await same(dir, { summary: 'the dashboard CSP is default-src self', rig: 'fabriek' })).toBeNull()
  // another rig's note is not this rig's lesson
  expect(
    await same(dir, {
      summary: 'no changelog or version bump convention exists in fabriek',
      rig: 'api',
    }),
  ).toBeNull()
}, 60_000)

test('each part of CORE.md is cut at its budget, so it cannot grow every brief', () => {
  const long = (tag: string) =>
    Array.from({ length: 40 }, (_, i) => `- ${tag} lesson ${i} ${'x'.repeat(100)}`)
  const core = [...long('top'), '## rig: web', ...long('web'), '## rig: api', ...long('api')].join('\n')
  const brief = coreFor(core, 'web')
  expect(brief).toContain('top lesson 0')
  expect(brief).toContain('web lesson 0')
  expect(brief).not.toContain('api lesson')
  expect(brief).not.toContain('top lesson 39')
  expect(brief.match(/cut: over the budget/g)).toHaveLength(2)
  expect(brief.length).toBeLessThan(2 * CORE_BUDGET + 200)
})

test("the manager's activity: what it was asked and ran since, and every skill's uses", () => {
  const at = (m: number) => `2026-10-11T12:${String(m).padStart(2, '0')}:00.000Z`
  const ran = (m: number, name: string, input: object) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at(m),
      message: { content: [{ type: 'tool_use', name, input }] },
    })
  const lines = [
    JSON.stringify({ type: 'user', timestamp: at(1), message: { content: 'old ask' } }),
    ran(2, 'Skill', { skill: 'triage-stuck' }),
    JSON.stringify({ type: 'user', timestamp: at(5), message: { content: '[factory] patrol\nmail: 2' } }),
    JSON.stringify({ type: 'user', timestamp: at(5), isMeta: true, message: { content: 'meta' } }),
    JSON.stringify({
      type: 'user',
      timestamp: at(6),
      message: { content: [{ type: 'tool_result', content: 'x' }] },
    }),
    ran(7, 'Bash', { command: 'factory status r-1' }),
    ran(8, 'Skill', { skill: 'triage-stuck' }),
    'not json',
  ]
  const { activity, used } = managerActivity(lines, Date.parse(at(3)))
  expect(activity).toEqual([
    '- 2026-10-11 12:05 asked: [factory] patrol mail: 2',
    '- 2026-10-11 12:07 Bash: factory status r-1',
    '- 2026-10-11 12:08 Skill: triage-stuck',
  ])
  expect(used.get('triage-stuck')).toEqual({ n: 2, last: Date.parse(at(8)) })
})

test('a skill the dream proposes waits for the manager, who installs or rejects it', () => {
  const dir = join(tmpdir(), `skills-${process.pid}`)
  const write = (root: string, name: string, text: string) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${text}\n---\nsteps`)
  }
  write(skillSources(dir), 'triage-stuck', 'when a station is stuck')
  write(skillSources(dir), 'check-rig', 'when a rig looks idle')
  expect(pendingSkills(dir).map(p => [p.name, p.change])).toEqual([
    ['check-rig', 'new'],
    ['triage-stuck', 'new'],
  ])

  installSkill(dir, 'triage-stuck')
  expect(pendingSkills(dir).map(p => p.name)).toEqual(['check-rig'])
  expect(existsSync(join(skillsDir(dir), 'triage-stuck', 'SKILL.md'))).toBe(true)

  // rejected: nothing installs, the proposal goes, and the dream reads why
  rejectSkill(dir, 'check-rig', 'it restarts the shared Dolt server')
  expect(pendingSkills(dir)).toEqual([])
  expect(existsSync(join(skillsDir(dir), 'check-rig'))).toBe(false)
  expect(inboxCount(dir)).toBe(1)

  // a change to an installed skill waits again, and the installed one stands until it is accepted
  write(skillSources(dir), 'triage-stuck', 'when a station is stuck or failed')
  expect(pendingSkills(dir).map(p => [p.name, p.change])).toEqual([['triage-stuck', 'changed']])
  rejectSkill(dir, 'triage-stuck', 'too broad')
  expect(readFileSync(join(skillSources(dir), 'triage-stuck', 'SKILL.md'), 'utf8')).toContain(
    'description: when a station is stuck\n',
  )
  expect(() => installSkill(dir, '../x')).toThrow('no proposed skill')
  rmSync(dir, { recursive: true })
})

const short = (over: Partial<ShortCandidate> = {}): ShortCandidate => ({
  path: 'beads/x.md',
  topic: 'beads',
  ageDays: 1,
  staleDays: 1,
  shown: 0,
  helped: 0,
  ...over,
})

test('decide() archives a never-helped note stale past 30 days, not at 29', () => {
  expect(decide([short({ staleDays: 29, helped: 0 })], [])).toEqual([])
  expect(decide([short({ staleDays: 31, helped: 0 })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'never helped, unused for 31 days' },
  ])
})

test('decide() never archives a note that ever helped, however stale', () => {
  expect(decide([short({ staleDays: 400, helped: 1 })], [])).toEqual([])
})

test('decide() merges a shown-or-helped note once it is 7 days old, not at 6', () => {
  expect(decide([short({ ageDays: 6, shown: 1 })], [])).toEqual([])
  expect(decide([short({ ageDays: 8, shown: 1 })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'shown or helped, 8 days old' },
  ])
  // helped alone (never shown by a search) also qualifies
  expect(decide([short({ ageDays: 8, shown: 0, helped: 1 })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'shown or helped, 8 days old' },
  ])
  // never shown and never helped: stays short, however old
  expect(decide([short({ ageDays: 400, shown: 0, helped: 0, staleDays: 10 })], [])).toEqual([])
})

test('decide() archives a superseded note outright, even if young and helped', () => {
  expect(
    decide([short({ ageDays: 1, staleDays: 1, helped: 5, superseded: 'beads/y.md' })], []),
  ).toEqual([{ kind: 'archive', path: 'beads/x.md', reason: 'superseded by beads/y.md' }])
})

test('decide() never touches an inbox note: the dream files it first', () => {
  expect(decide([short({ topic: 'inbox', staleDays: 400, ageDays: 400 })], [])).toEqual([])
})

test('decide() flags a long entry as a promotion candidate at 3 helps across 3 runs, not at 2 runs', () => {
  expect(decide([], [{ path: 'beads/LONG.md#lock', helped: 3, runs: 2 }])).toEqual([])
  expect(decide([], [{ path: 'beads/LONG.md#lock', helped: 3, runs: 3 }])).toEqual([
    { kind: 'promote', path: 'beads/LONG.md#lock', reason: 'helped 3 times across 3 runs' },
  ])
})

test('decide() turns a scored pair at or above SAME (0.88) into a dedupe decision', () => {
  const sims = [
    { a: 'beads/LONG.md#a', b: 'beads/LONG.md#b', score: 0.87 },
    { a: 'beads/LONG.md#c', b: 'beads/LONG.md#d', score: 0.9 },
  ]
  expect(decide([], [], sims)).toEqual([
    { kind: 'dedupe', a: 'beads/LONG.md#c', b: 'beads/LONG.md#d', reason: 'similarity 0.90' },
  ])
})
