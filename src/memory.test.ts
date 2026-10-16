import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  add,
  applyTiers,
  close,
  compact,
  CORE_BUDGET,
  coreFor,
  coreNotes,
  decide,
  dreamPrompt,
  type EvalCase,
  evalScore,
  evaluate,
  format,
  formatLong,
  inboxCount,
  installSkill,
  type LongEntry,
  longAliasRenames,
  longSimPairs,
  managerActivity,
  mdFileCount,
  noteExists,
  outline,
  parse,
  parseLong,
  patrolActivity,
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
  tierCandidates,
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
    {
      id: 'bd-lock',
      summary: 'bd init locks every repo',
      rig: 'fabriek',
      from: 'r1/verify',
      at: '2026-10-06',
      body: 'why\nhow',
    },
    { id: 'no-meta', summary: 'a plain entry with no rig, from or at', body: 'just a body' },
  ]
  expect(parseLong(formatLong(entries))).toEqual(entries)
  expect(formatLong(entries)).toContain('tier: long')
})

test('a LONG.md entry round-trips a from: with real-shaped commas and spaces, and a merge alias', () => {
  const entries: LongEntry[] = [
    {
      id: 'bd-lock',
      summary: 'bd init locks every repo',
      rig: 'fabriek',
      from: 'r1/verify, r2/implement',
      at: '2026-10-06',
      aliases: ['bd-lock-old'],
      body: 'why\nhow',
    },
  ]
  expect(parseLong(formatLong(entries))).toEqual(entries)
})

test('parseLong never starts an entry at a "## " line inside a body, only at one followed by an id comment', () => {
  const entries: LongEntry[] = [
    {
      id: 'repo-ignores-columns',
      summary: 'a note whose body has its own markdown headings',
      body: 'intro\n\n## not a new entry\n\nmore text\n\n## also not one',
    },
    { id: 'second', summary: 'a second real entry', body: 'its own body' },
  ]
  const round = parseLong(formatLong(entries))
  expect(round).toEqual(entries)
  expect(round).toHaveLength(2)
})

test('rank() breaks a near-tie for a higher tier, but a clearly worse match still loses', () => {
  const note = (path: string, tier: Note['tier']): Note => ({ path, summary: path, body: '', tier })
  const vecs: Record<string, number[]> = {
    'beads/short.md': [1, 0], // own score 1 exactly (normalized query [1,0])
    'beads/long-close.md': [0.995, Math.sqrt(1 - 0.995 ** 2)], // 0.005 below short, within the 0.01 bonus
    'beads/long-far.md': [0.97, Math.sqrt(1 - 0.97 ** 2)], // 0.02-ish below short, past the 0.01 bonus
  }
  const found = rank(
    [note('beads/short.md', 'short'), note('beads/long-close.md', 'long')],
    n => vecs[n.path]!,
    () => undefined,
    [1, 0],
  )
  expect(found.map(f => f.note.path)).toEqual(['beads/long-close.md', 'beads/short.md'])

  const stillLoses = rank(
    [note('beads/short.md', 'short'), note('beads/long-far.md', 'long')],
    n => vecs[n.path]!,
    () => undefined,
    [1, 0],
  )
  expect(stillLoses.map(f => f.note.path)).toEqual(['beads/short.md', 'beads/long-far.md'])
})

test('rank() tells TIER_BONUS.long (0.01) from TIER_BONUS.fact (0.02) at the same raw gap (claude-factory-59r.14)', () => {
  const note = (path: string, tier: Note['tier']): Note => ({ path, summary: path, body: '', tier })
  // both tied notes score 0.015 below short in their own match: past the 0.01 long bonus, so long must
  // still lose to short, but within the 0.02 fact bonus, so fact must still beat short
  const vecs: Record<string, number[]> = { 'beads/short.md': [1, 0], 'beads/other.md': [0.985, 0] }
  const withLong = rank(
    [note('beads/short.md', 'short'), note('beads/other.md', 'long')],
    n => vecs[n.path]!,
    () => undefined,
    [1, 0],
  )
  expect(withLong.map(f => f.note.path)).toEqual(['beads/short.md', 'beads/other.md'])

  const withFact = rank(
    [note('beads/short.md', 'short'), note('beads/other.md', 'fact')],
    n => vecs[n.path]!,
    () => undefined,
    [1, 0],
  )
  expect(withFact.map(f => f.note.path)).toEqual(['beads/other.md', 'beads/short.md'])
})

test('search indexes CORE.md bullets as fact notes, scoped to their rig section', async () => {
  const dir = join(tmpdir(), `memory-core-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'CORE.md'),
    [
      '- always search the memory before you start a station',
      '## rig: fabriek',
      '- use uv run --frozen, never bare pip',
    ].join('\n'),
  )
  const [top] = await search(dir, 'how do I run python commands in this rig?', { rig: 'fabriek' })
  expect(top!.note.path).toMatch(/^CORE\.md#[0-9a-f]{8}$/)
  expect(top!.note.summary).toContain('uv run --frozen')
  expect(top!.note.tier).toBe('fact')
  // another rig never sees fabriek's CORE bullet
  const other = await search(dir, 'how do I run python commands in this rig?', { rig: 'web' })
  expect(other.some(f => f.note.summary.includes('uv run --frozen'))).toBe(false)
}, 60_000)

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

test("compact() keeps a LONG.md entry's usage under its #id, and drops it only when the id is gone", () => {
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

test('noteExists and compact() know a CORE.md#<hash> fact note, and drop it once its bullet is gone (claude-factory-59r.12)', () => {
  const dir = join(tmpdir(), `memory-core-usage-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CORE.md'), '- always search the memory before you start a station\n')
  const [bullet] = coreNotes(dir)
  expect(noteExists(dir, bullet!.path)).toBe(true)
  expect(noteExists(dir, 'CORE.md#deadbeef')).toBe(false)

  use(dir, [bullet!.path], 'helped')
  compact(dir, {})
  expect(usage(dir).get(bullet!.path)?.helped).toBe(1) // kept: the bullet is still there

  writeFileSync(join(dir, 'CORE.md'), '- a different lesson entirely\n')
  compact(dir, {})
  expect(usage(dir).has(bullet!.path)).toBe(false) // dropped: that bullet is gone
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

test("the dream's manager activity includes patrol-log lines, newest since kept, bad JSON skipped", () => {
  const at = (m: number) => Date.parse(`2026-10-11T12:${String(m).padStart(2, '0')}:00.000Z`)
  const lines = [
    JSON.stringify({
      at: at(1),
      reason: 'answer',
      durationMs: 1000,
      actions: ['factory nudge r-1'],
      report: 'old patrol, before since',
    }),
    'not json',
    JSON.stringify({
      at: at(5),
      reason: 'answer',
      durationMs: 2000,
      actions: ['factory nudge r-2', 'factory status r-3'],
      report: 'two runs nudged',
    }),
  ]
  expect(patrolActivity(lines, at(3))).toEqual([
    '- 2026-10-11 12:05 patrol: factory nudge r-2',
    '- 2026-10-11 12:05 patrol: factory status r-3',
    '- 2026-10-11 12:05 patrol report: two runs nudged',
  ])
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
  expect(decide([short({ ageDays: 1, staleDays: 1, helped: 5, superseded: 'beads/y.md' })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'superseded by beads/y.md' },
  ])
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

test('mdFileCount counts CORE.md and every topic README, LONG.md and short note, never .archive', () => {
  const dir = join(tmpdir(), `memory-count-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  mkdirSync(join(dir, '.archive'), { recursive: true })
  writeFileSync(join(dir, 'CORE.md'), '- a lesson\n')
  writeFileSync(join(dir, 'beads', 'README.md'), format({ summary: 't', body: '' }))
  writeFileSync(join(dir, 'beads', 'x.md'), format({ summary: 'x', body: '' }))
  writeFileSync(join(dir, '.archive', 'beads.md'), 'archived')
  expect(mdFileCount(dir)).toBe(3)
})

test('applyTiers() merges an old, used short note into LONG.md and keeps its usage under the new id', () => {
  const dir = join(tmpdir(), `memory-apply-merge-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  const old = '2026-10-01' // 14 days before `now`
  writeFileSync(
    join(dir, 'beads', 'lock.md'),
    format({ summary: 'bd init locks every repo', at: old, body: 'why and how' }),
  )
  writeFileSync(
    join(dir, 'beads', 'fresh.md'),
    format({ summary: 'too young to merge', at: '2026-10-14', body: '' }),
  )
  use(dir, ['beads/lock.md'], 'helped', now - 1000)

  const { decisions, renamed, merged, archived } = applyTiers(dir, { now })
  expect(merged).toBe(1)
  expect(archived).toBe(0)
  expect(decisions).toEqual([
    { kind: 'merge', path: 'beads/lock.md', reason: 'shown or helped, 14 days old' },
  ])
  expect(renamed).toEqual({ 'beads/lock.md': 'beads/LONG.md#bd-init-locks-every-repo' })
  expect(existsSync(join(dir, 'beads', 'lock.md'))).toBe(false)
  const entries = parseLong(readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8'))
  expect(entries.map(e => e.summary)).toEqual(['bd init locks every repo'])

  compact(dir, renamed)
  expect(usage(dir).get('beads/LONG.md#bd-init-locks-every-repo')?.helped).toBe(1)
})

test('applyTiers() archives a never-helped, long-stale short note, and a superseded one outright', () => {
  const dir = join(tmpdir(), `memory-apply-archive-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'stale.md'),
    format({ summary: 'a note nobody ever needed', at: '2026-08-01', body: 'body' }),
  )
  writeFileSync(
    join(dir, 'beads', 'old.md'),
    format({ summary: 'the old way to do it', at: '2026-08-01', superseded: 'beads/new.md', body: 'body' }),
  )
  const { merged, archived, decisions } = applyTiers(dir, { now })
  expect(merged).toBe(0)
  expect(archived).toBe(2)
  expect(decisions.map(d => d.kind)).toEqual(['archive', 'archive'])
  expect(existsSync(join(dir, 'beads', 'stale.md'))).toBe(false)
  expect(existsSync(join(dir, 'beads', 'old.md'))).toBe(false)
  expect(readFileSync(join(dir, '.archive', 'beads.md'), 'utf8')).toContain('a note nobody ever needed')
  expect(readFileSync(join(dir, '.archive', 'beads.md'), 'utf8')).toContain('the old way to do it')
})

test('applyTiers() with dryRun counts decisions but writes nothing, and a second pass is a no-op', () => {
  const dir = join(tmpdir(), `memory-apply-dry-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'lock.md'),
    format({ summary: 'bd init locks every repo', at: '2026-10-01', body: 'why' }),
  )
  use(dir, ['beads/lock.md'], 'shown', now - 1000)

  const dry = applyTiers(dir, { now, dryRun: true })
  expect(dry.merged).toBe(1)
  expect(existsSync(join(dir, 'beads', 'lock.md'))).toBe(true) // nothing written
  expect(existsSync(join(dir, 'beads', 'LONG.md'))).toBe(false)

  const real = applyTiers(dir, { now })
  expect(real.merged).toBe(1)
  const again = applyTiers(dir, { now })
  expect(again.decisions).toEqual([]) // the note is gone, so there is nothing left to merge
})

test("applyTiers must run after the dream's own renames are compacted, or a just-filed helped note looks unused and is wrongly archived", () => {
  const now = Date.parse('2026-10-15T00:00:00Z')
  // wrong order: applyTiers reads usage before anyone logs the dream's own file move (claude-factory-59r.10)
  {
    const dir = join(tmpdir(), `memory-order-wrong-${process.pid}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'beads'), { recursive: true })
    use(dir, ['inbox/x.md'], 'helped', now - 1000) // helped under its pre-dream path
    // the dream filed it under beads/ already, keeping the note's own old at: date
    writeFileSync(
      join(dir, 'beads', 'x.md'),
      format({ summary: 'bd init locks every repo', at: '2026-08-01', body: 'why' }),
    )
    const { archived, merged } = applyTiers(dir, { now })
    expect(archived).toBe(1) // usage is still keyed to inbox/x.md: this note looks never helped
    expect(merged).toBe(0)
  }
  // right order: compact(renamed) first, so usage already resolves to the note's new path
  {
    const dir = join(tmpdir(), `memory-order-right-${process.pid}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'beads'), { recursive: true })
    use(dir, ['inbox/x.md'], 'helped', now - 1000)
    writeFileSync(
      join(dir, 'beads', 'x.md'),
      format({ summary: 'bd init locks every repo', at: '2026-08-01', body: 'why' }),
    )
    compact(dir, { 'inbox/x.md': 'beads/x.md' })
    const { archived, merged } = applyTiers(dir, { now })
    expect(archived).toBe(0)
    expect(merged).toBe(1) // helped, so merged into LONG.md instead of archived
  }
})

test("longAliasRenames turns a LONG.md entry's aliases into renames, so a dream's hand merge keeps the removed id's usage (claude-factory-59r.11)", () => {
  const dir = join(tmpdir(), `memory-aliasrenames-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  mkdirSync(join(dir, 'ci'), { recursive: true })
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([{ id: 'a', summary: 'kept entry', aliases: ['b'], body: 'merged body' }]),
  )
  writeFileSync(
    join(dir, 'ci', 'LONG.md'),
    formatLong([{ id: 'x', summary: 'another topic, no aliases', body: 'body' }]),
  )
  expect(longAliasRenames(dir)).toEqual({ 'beads/LONG.md#b': 'beads/LONG.md#a' })

  use(dir, ['beads/LONG.md#b'], 'helped')
  compact(dir, longAliasRenames(dir))
  expect(usage(dir).get('beads/LONG.md#a')?.helped).toBe(1)
  expect(usage(dir).has('beads/LONG.md#b')).toBe(false)
})

test('applyTiers() skips a topic whose LONG.md parseLong cannot rebuild byte for byte, and keeps the short note (claude-factory-59r.15)', () => {
  const dir = join(tmpdir(), `memory-apply-unsafe-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  // prose before the first "## "+id pair: parseLong drops it, so formatLong(parseLong(text)) !== text
  const unsafe =
    '---\ntier: long\n---\n' +
    'A body that helped, written before any entry heading.\n\n' +
    '## kept entry\n<!-- id: {"id":"kept-entry"} -->\n\nkept body\n'
  writeFileSync(join(dir, 'beads', 'LONG.md'), unsafe)
  writeFileSync(
    join(dir, 'beads', 'new.md'),
    format({ summary: 'bd init locks every repo', at: '2026-10-01', body: 'why' }),
  )
  use(dir, ['beads/new.md'], 'helped', now - 1000)

  const { merged, renamed, skipped } = applyTiers(dir, { now })
  expect(merged).toBe(0)
  expect(renamed).toEqual({})
  expect(skipped).toEqual([{ topic: 'beads', reason: expect.stringContaining('LONG.md') }])
  expect(existsSync(join(dir, 'beads', 'new.md'))).toBe(true) // kept, not merged away
  expect(readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8')).toBe(unsafe) // untouched
})

test('applyTiers() merges into a LONG.md that differs from canonical formatLong output only by a lossless edit (claude-factory-59r.21)', () => {
  const variants: Record<string, string> = {
    'an extra blank line after an entry body':
      '---\ntier: long\n---\n## kept entry\n<!-- id: {"id":"kept-entry"} -->\n\nkept body\n\n\n',
    'no trailing newline':
      '---\ntier: long\n---\n## kept entry\n<!-- id: {"id":"kept-entry"} -->\n\nkept body',
    'spaces inside the id JSON':
      '---\ntier: long\n---\n## kept entry\n<!-- id: { "id": "kept-entry" } -->\n\nkept body\n',
    'aliases before rig in the id JSON':
      '---\ntier: long\n---\n## kept entry\n<!-- id: {"aliases":[],"id":"kept-entry","rig":"fabriek"} -->\n\nkept body\n',
  }
  for (const [why, text] of Object.entries(variants)) {
    const dir = join(tmpdir(), `memory-apply-lossless-${process.pid}-${slugify(why)}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'beads'), { recursive: true })
    const now = Date.parse('2026-10-15T00:00:00Z')
    writeFileSync(join(dir, 'beads', 'LONG.md'), text)
    writeFileSync(
      join(dir, 'beads', 'new.md'),
      format({ summary: 'bd init locks every repo', at: '2026-10-01', body: 'why' }),
    )
    use(dir, ['beads/new.md'], 'helped', now - 1000)

    const { merged, skipped, renamed } = applyTiers(dir, { now })
    expect([why, merged]).toEqual([why, 1])
    expect([why, skipped]).toEqual([why, []])
    expect([why, renamed]).toEqual([why, { 'beads/new.md': 'beads/LONG.md#bd-init-locks-every-repo' }])
    // the entry the file already held survives the rewrite, body and all
    expect(parseLong(readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8')).map(e => e.id)).toContain(
      'kept-entry',
    )
  }
})

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

test('applyTiers() picks a new LONG.md id that is not already an alias or an old id in the rename log (claude-factory-59r.18)', () => {
  const dir = join(tmpdir(), `memory-apply-id-collision-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  // another entry already claims the slug "bd-init-locks-every-repo" as an alias
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([
      { id: 'other', summary: 'another lesson entirely', aliases: ['bd-init-locks-every-repo'], body: 'x' },
    ]),
  )
  writeFileSync(
    join(dir, 'beads', 'new.md'),
    format({ summary: 'bd init locks every repo', at: '2026-10-01', body: 'why' }),
  )
  use(dir, ['beads/new.md'], 'helped', now - 1000)

  const { renamed } = applyTiers(dir, { now })
  expect(renamed).toEqual({ 'beads/new.md': 'beads/LONG.md#bd-init-locks-every-repo-2' })
})

test('applyTiers() picks a new LONG.md id that avoids a renameLog key with no current entry or alias (claude-factory-59r.20)', () => {
  const dir = join(tmpdir(), `memory-apply-id-collision-renamelog-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  // "other" holds no aliases: a later dream deleted the survivor entry that once aliased
  // "bd-init-locks-every-repo" away, but the rename log still remembers that old id forever.
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([{ id: 'other', summary: 'another lesson entirely', body: 'x' }]),
  )
  compact(dir, { 'beads/LONG.md#bd-init-locks-every-repo': 'beads/LONG.md#other' })
  writeFileSync(
    join(dir, 'beads', 'new.md'),
    format({ summary: 'bd init locks every repo', at: '2026-10-01', body: 'why' }),
  )
  use(dir, ['beads/new.md'], 'helped', now - 1000)

  const { renamed } = applyTiers(dir, { now })
  expect(renamed).toEqual({ 'beads/new.md': 'beads/LONG.md#bd-init-locks-every-repo-2' })
})

test("applyTiers() rewrites a short note's markdown link in its topic README to the LONG.md entry it became (claude-factory-59r.19a)", () => {
  const dir = join(tmpdir(), `memory-apply-readme-link-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'new.md'),
    format({ summary: 'bd init locks every repo', at: '2026-10-01', body: 'why' }),
  )
  writeFileSync(
    join(dir, 'beads', 'README.md'),
    format({
      summary: 'topic readme',
      body: '- [bd-init-locks-every-repo](new.md): bd init locks every repo',
    }),
  )
  use(dir, ['beads/new.md'], 'helped', now - 1000)

  applyTiers(dir, { now })
  expect(readFileSync(join(dir, 'beads', 'README.md'), 'utf8')).toContain(
    '[bd-init-locks-every-repo](LONG.md#bd-init-locks-every-repo)',
  )
  expect(readFileSync(join(dir, 'beads', 'README.md'), 'utf8')).not.toContain('(new.md)')
})

test("applyTiers() rewrites an archived note's README link, not just a merged one (claude-factory-59r.22)", () => {
  const dir = join(tmpdir(), `memory-apply-archive-readme-link-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'old.md'), format({ summary: 'a note nobody used', body: 'never helped' }))
  writeFileSync(
    join(dir, 'beads', 'README.md'),
    format({ summary: 'topic readme', body: '- [a note nobody used](old.md): a note nobody used' }),
  )
  Bun.spawnSync(['git', '-C', dir, 'init', '-q'])
  Bun.spawnSync(['git', '-C', dir, 'add', '-A'])
  Bun.spawnSync(
    ['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-08-01T00:00:00',
        GIT_COMMITTER_DATE: '2026-08-01T00:00:00',
      },
    },
  )
  const now = Date.parse('2026-10-15T00:00:00Z') // 75 days later: past ARCHIVE_STALE_DAYS (30)

  const { archived } = applyTiers(dir, { now })
  expect(archived).toBe(1)
  const readme = readFileSync(join(dir, 'beads', 'README.md'), 'utf8')
  expect(readme).not.toContain('(old.md)')
  expect(readme).toContain('(../.archive/beads.md)')
})

test('applyTiers() ages a note with no at: from the commit that added it, not from now (claude-factory-59r.19b)', () => {
  const dir = join(tmpdir(), `memory-apply-no-at-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'old.md'), format({ summary: 'a note with no at', body: 'never helped' }))
  Bun.spawnSync(['git', '-C', dir, 'init', '-q'])
  Bun.spawnSync(['git', '-C', dir, 'add', '-A'])
  Bun.spawnSync(
    ['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-08-01T00:00:00',
        GIT_COMMITTER_DATE: '2026-08-01T00:00:00',
      },
    },
  )
  const now = Date.parse('2026-10-15T00:00:00Z') // 75 days later: past ARCHIVE_STALE_DAYS (30)

  const { decisions, archived } = applyTiers(dir, { now })
  expect(archived).toBe(1)
  expect(decisions).toEqual([
    { kind: 'archive', path: 'beads/old.md', reason: expect.stringContaining('never helped') },
  ])
})

test('applyTiers() ages a note with no at: from the commit that added it, not the commit that last edited it (claude-factory-59r.23)', () => {
  const dir = join(tmpdir(), `memory-apply-no-at-edited-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const commit = (msg: string, date: string) => {
    Bun.spawnSync(['git', '-C', dir, 'add', '-A'])
    Bun.spawnSync(
      ['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg],
      {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    )
  }
  writeFileSync(join(dir, 'beads', 'old.md'), format({ summary: 'a note with no at', body: 'first body' }))
  Bun.spawnSync(['git', '-C', dir, 'init', '-q'])
  commit('init', '2026-08-01T00:00:00') // the add: 75 days before `now`
  // a later edit to the same path must not reset the note's age to this commit's date
  writeFileSync(join(dir, 'beads', 'old.md'), format({ summary: 'a note with no at', body: 'edited body' }))
  commit('edit', '2026-10-14T00:00:00') // 1 day before `now`: too fresh to archive on its own
  const now = Date.parse('2026-10-15T00:00:00Z')

  const { decisions, archived } = applyTiers(dir, { now })
  expect(archived).toBe(1) // archived only because the age comes from the 2026-08-01 add, not the edit
  expect(decisions).toEqual([
    { kind: 'archive', path: 'beads/old.md', reason: expect.stringContaining('never helped') },
  ])
})

test('tally keys a run by its id before the slash, so two stations of one run count as one run, not two (claude-factory-59r.16)', () => {
  const at = Date.parse('2026-10-06T12:00:00Z')
  const lines = [
    JSON.stringify({ path: 'a.md', helped: 1, at, by: 'run1/verify' }),
    JSON.stringify({ path: 'a.md', helped: 1, at: at + 1000, by: 'run1/implement' }), // same run, another station
    JSON.stringify({ path: 'a.md', helped: 1, at: at + 2000, by: 'run2/implement' }),
  ]
  expect(tally(lines).get('a.md')).toEqual({ path: 'a.md', shown: 0, helped: 3, at: at + 2000, runs: 2 })
})

test('compact() keeps the run ids its own fold already counted, so a later line for the same run does not count again (claude-factory-59r.17)', () => {
  const dir = join(tmpdir(), `memory-compact-keys-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'a.md'), format({ summary: 'a short note', body: 'body' }))
  const t0 = Date.parse('2026-10-06T12:00:00Z')
  use(dir, ['beads/a.md'], 'helped', t0, 'run1/verify')
  compact(dir, {}) // folds the usage file to one line; it must keep 'run1', not just runs: 1
  use(dir, ['beads/a.md'], 'helped', t0 + 1000, 'run1/implement') // same run, another station
  expect(usage(dir).get('beads/a.md')?.runs).toBe(1) // still one run, not two
  use(dir, ['beads/a.md'], 'helped', t0 + 2000, 'run2/verify') // a genuinely new run
  expect(usage(dir).get('beads/a.md')?.runs).toBe(2)
})

test('evalScore: recall and MRR over results already searched for, and the misses it names', () => {
  const cases: EvalCase[] = [
    { query: 'why is bd slow', expect: 'beads/lock.md' },
    { query: 'how to deploy', expect: 'deploy/roll.md' },
    { query: 'nothing matches this', expect: 'ci/flaky.md' },
  ]
  const results = [
    ['other/x.md', 'beads/lock.md', 'other/y.md'], // found at rank 2
    ['deploy/roll.md', 'other/z.md'], // found at rank 1
    ['other/a.md', 'other/b.md'], // missed
  ]
  const r = evalScore(cases, results)
  expect(r.recall).toBeCloseTo(2 / 3, 5)
  expect(r.mrr).toBeCloseTo((1 / 2 + 1 / 1 + 0) / 3, 5)
  expect(r.misses).toEqual([{ query: 'nothing matches this', expect: 'ci/flaky.md' }])
})

test('evalScore on an empty case list scores perfectly, by convention, and names no misses', () => {
  expect(evalScore([], [])).toEqual({ recall: 1, mrr: 1, misses: [] })
})

test('evaluate() runs the fixed query set against a real store through search()', async () => {
  const dir = join(tmpdir(), `memory-eval-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  add(dir, { summary: 'bd init on the shared Dolt server takes a lock that stalls every repo', body: '' })
  add(dir, { summary: 'kubectl rollout status confirms a deploy finished', body: '' })
  const r = await evaluate(dir, [
    { query: 'why is the issue tracker frozen for all projects?', expect: 'stalls' },
    { query: 'did the rollout finish?', expect: 'deploy finished' },
  ])
  expect(r.recall).toBe(1)
  expect(r.misses).toEqual([])
}, 60_000)

test('dreamPrompt names the long tier and the id rule, and adds the promotion, duplicate and unsafe sections', () => {
  const empty = dreamPrompt('/tmp/memory', [], [], [])
  expect(empty).toContain('LONG.md')
  expect(empty).toContain("Never change an entry's `id`")
  expect(empty).toContain('aliases')
  expect(empty).toContain('## Promotion candidates')
  expect(empty).toContain('## Possible duplicates')
  expect(empty).toContain('## Unsafe LONG.md files')
  expect(empty).toContain('(none)')

  const filled = dreamPrompt(
    '/tmp/memory',
    [],
    [],
    [],
    { activity: [], skills: [] },
    ['- beads/LONG.md#lock (bd init locks every repo): helped 3 times across 3 runs'],
    ['- beads/LONG.md#a (x) vs beads/LONG.md#b (y): similarity 0.90'],
    ['- beads/LONG.md holds text before its first entry that a merge would lose: stray prose'],
  )
  expect(filled).toContain('helped 3 times across 3 runs')
  expect(filled).toContain('similarity 0.90')
  expect(filled).toContain('stray prose')
})

test('longSimPairs finds a near-duplicate pair of LONG.md entries in the same topic and rig, not across a topic or a rig', async () => {
  const dir = join(tmpdir(), `memory-longsim-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  mkdirSync(join(dir, 'ci'), { recursive: true })
  const entries: LongEntry[] = [
    {
      id: 'a',
      summary: 'bd init on the shared Dolt server locks every repo',
      rig: 'claude-factory',
      body: 'why',
    },
    {
      id: 'b',
      summary: 'bd init takes a lock on the shared Dolt server, blocking every repo',
      rig: 'claude-factory',
      body: 'why, reworded',
    },
    {
      id: 'c',
      summary: 'kubectl rollout status confirms a deploy finished',
      rig: 'claude-factory',
      body: 'unrelated',
    },
    {
      id: 'd',
      summary: 'bd init on the shared Dolt server locks every repo',
      rig: 'sluis',
      body: 'same words, another rig',
    },
  ]
  writeFileSync(join(dir, 'beads', 'LONG.md'), formatLong(entries))
  writeFileSync(
    join(dir, 'ci', 'LONG.md'),
    formatLong([
      {
        id: 'e',
        summary: 'bd init on the shared Dolt server locks every repo',
        rig: 'claude-factory',
        body: 'same words, another topic',
      },
    ]),
  )

  const pairs = await longSimPairs(dir)
  expect(pairs.every(p => p.score >= 0.88)).toBe(true)
  expect(
    pairs.some(
      p =>
        (p.a === 'beads/LONG.md#a' && p.b === 'beads/LONG.md#b') ||
        (p.a === 'beads/LONG.md#b' && p.b === 'beads/LONG.md#a'),
    ),
  ).toBe(true)
  // c (a different lesson) pairs with nothing
  expect(pairs.some(p => p.a.includes('#c') || p.b.includes('#c'))).toBe(false)
  // d (another rig) and e (another topic) never pair with a, even with identical wording
  expect(
    pairs.some(p => p.a.includes('#d') || p.b.includes('#d') || p.a.includes('#e') || p.b.includes('#e')),
  ).toBe(false)
}, 60_000)

test('tierCandidates composes decide(), longSimPairs() and usage() into dream-prompt lines for promotion and dedupe', async () => {
  const dir = join(tmpdir(), `memory-tiercand-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([
      {
        id: 'lock',
        summary: 'bd init on the shared Dolt server locks every repo',
        rig: 'claude-factory',
        body: 'why',
      },
      { id: 'x', summary: 'a note that only helped once', rig: 'claude-factory', body: 'body x' },
      {
        id: 'y',
        summary: 'a note that only helped once, in other words',
        rig: 'claude-factory',
        body: 'body y',
      },
    ]),
  )
  const now = Date.parse('2026-10-15T00:00:00Z')
  use(dir, ['beads/LONG.md#lock'], 'helped', now, 'run-a')
  use(dir, ['beads/LONG.md#lock'], 'helped', now, 'run-b')
  use(dir, ['beads/LONG.md#lock'], 'helped', now, 'run-c')

  const { promotions, duplicates } = await tierCandidates(dir)
  expect(promotions).toEqual([
    '- beads/LONG.md#lock (bd init on the shared Dolt server locks every repo): helped 3 times across 3 runs',
  ])
  expect(duplicates).toHaveLength(1)
  expect(duplicates[0]).toContain('beads/LONG.md#x')
  expect(duplicates[0]).toContain('beads/LONG.md#y')
}, 60_000)
