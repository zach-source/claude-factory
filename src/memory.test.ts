import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  add,
  applyTiers,
  citesTracker,
  close,
  compact,
  CORE_BUDGET,
  coreFor,
  coreNotes,
  decide,
  type Decision,
  dreamPrompt,
  envTopicCap,
  type EvalCase,
  evalScore,
  evaluate,
  format,
  formatLong,
  gate,
  inboxCount,
  installSkill,
  isUntil,
  lifecycleMetrics,
  type LongEntry,
  longAliasRenames,
  longSimPairs,
  managerActivity,
  mdFileCount,
  NOTE_KINDS,
  noteExists,
  outline,
  overCapTopics,
  parse,
  parseLong,
  planLines,
  patrolActivity,
  pendingSkills,
  rank,
  rejectSkill,
  resolvePath,
  same,
  selfCases,
  type ShortCandidate,
  skillsDir,
  skillSources,
  search,
  supersede,
  tally,
  tierCandidates,
  TOPIC_CAP,
  type UntilDeps,
  untilStatus,
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

test('a note keeps its kind and until through a write and a read', () => {
  const note = {
    summary: 'bd init locks every repo',
    at: '2026-10-06',
    body: 'why\nhow',
    kind: 'rule' as const,
    until: 'acme-1x2.3',
  }
  expect(parse('beads/x.md', format(note))).toEqual({ path: 'beads/x.md', ...note })
})

test('kind and until frontmatter land between at and superseded', () => {
  const text = format({
    summary: 's',
    at: '2026-10-06',
    superseded: 'beads/new.md',
    body: 'b',
    kind: 'fact',
    until: '2026-12-31',
  })
  const lines = text.split('\n')
  expect(lines.indexOf('at: 2026-10-06')).toBeLessThan(lines.indexOf('kind: fact'))
  expect(lines.indexOf('kind: fact')).toBeLessThan(lines.indexOf('until: 2026-12-31'))
  expect(lines.indexOf('until: 2026-12-31')).toBeLessThan(lines.indexOf('superseded: beads/new.md'))
})

test('parse() of an old note with no kind or until leaves both undefined, no throw', () => {
  const n = parse('beads/x.md', '---\nsummary: s\n---\nbody')
  expect(n.kind).toBeUndefined()
  expect(n.until).toBeUndefined()
})

test('parse() drops an invalid kind value instead of throwing', () => {
  const n = parse('beads/x.md', '---\nsummary: s\nkind: bogus\n---\nbody')
  expect(n.kind).toBeUndefined()
})

test('format() of a note without kind or until is byte-identical to a note with no such fields today', () => {
  const note = { summary: 's', at: '2026-10-06', body: 'b' }
  expect(format(note)).toBe('---\nsummary: s\nat: 2026-10-06\n---\nb\n')
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

test('a LONG.md entry round-trips its until: marker', () => {
  const entries: LongEntry[] = [{ id: 'x', summary: 'x', until: '2099-01-01', body: 'b' }]
  expect(parseLong(formatLong(entries))).toEqual(entries)
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

test('outline clips a long topic line to 100 characters', () => {
  const dir = join(tmpdir(), `memory-clip-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'ci'), { recursive: true })
  writeFileSync(join(dir, 'ci', 'README.md'), format({ summary: 'x'.repeat(1000), body: '' }))
  const line = outline(dir).topics[0]!
  expect(line.length).toBe(100)
  expect(line.endsWith('…')).toBe(true)
})

test('outline keeps 32 long topics under 3.3 KB', () => {
  const dir = join(tmpdir(), `memory-budget-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  for (let i = 0; i < 32; i++) {
    mkdirSync(join(dir, `topic-${i}`), { recursive: true })
    writeFileSync(join(dir, `topic-${i}`, 'README.md'), format({ summary: 'y'.repeat(900), body: '' }))
  }
  expect(outline(dir).topics.join('\n').length).toBeLessThan(3300)
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

test('a shown-only line adds no run; a helped line from another run does', () => {
  const dir = join(tmpdir(), `memory-shown-runs-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const day = 24 * 3600 * 1000
  use(dir, ['n.md'], 'shown', day, 'r1/a')
  use(dir, ['n.md'], 'shown', 2 * day, 'r2/a')
  use(dir, ['n.md'], 'helped', 3 * day, 'r3/b')
  const u = usage(dir).get('n.md')!
  expect(u.shown).toBe(2)
  expect(u.runs).toBe(1)
})

test('search on a dir with no notes returns nothing', async () => {
  const dir = join(tmpdir(), `memory-search-empty-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  expect(await search(dir, 'anything')).toEqual([])
})

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
    confirmed: 0,
    contradicted: 0,
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
  expect(tally(withBy).get('a.md')).toEqual({
    path: 'a.md',
    shown: 0,
    helped: 3,
    confirmed: 0,
    contradicted: 0,
    at: at + 2000,
    runs: 2,
  })

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
  expect(tally(folded).get('c.md')).toEqual({
    path: 'c.md',
    shown: 5,
    helped: 3,
    confirmed: 0,
    contradicted: 0,
    at: at + 2000,
    runs: 3,
  })
})

test('tally counts each of the 4 kinds (shown, helped, confirmed, contradicted), claude-factory-3u1.1.2', () => {
  const dir = join(tmpdir(), `memory-4kinds-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const at = Date.parse('2026-10-06T12:00:00Z')
  use(dir, ['a.md'], 'shown', at)
  use(dir, ['a.md'], 'helped', at + 1000)
  use(dir, ['a.md'], 'confirmed', at + 2000)
  use(dir, ['a.md'], 'contradicted', at + 3000)
  expect(usage(dir).get('a.md')).toEqual({
    path: 'a.md',
    shown: 1,
    helped: 1,
    confirmed: 1,
    contradicted: 1,
    at: at + 3000,
    runs: 1,
  })
})

test('compact() keeps confirmed and contradicted in its folded line: compact then tally gives the same counts', () => {
  const dir = join(tmpdir(), `memory-compact-4kinds-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'a.md'), format({ summary: 'a short note', body: 'body' }))
  const at = Date.parse('2026-10-06T12:00:00Z')
  use(dir, ['beads/a.md'], 'confirmed', at, 'run1/verify')
  use(dir, ['beads/a.md'], 'contradicted', at + 1000, 'run1/verify')
  const before = usage(dir).get('beads/a.md')
  compact(dir, {})
  expect(usage(dir).get('beads/a.md')).toEqual(before!)
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

// claude-factory-5o7: noteExists()'s no-'#' branch was only existsSync(join(dir,path)), so a
// directory ('beads', '.' -> '') or any non-.md file passed. walk() only ever lists .md files
// (memory.ts's walk()), so a real note path always ends in .md.
test('noteExists refuses a topic directory, ".", and a non-.md file; a real note still passes', () => {
  const dir = join(tmpdir(), `memory-note-exists-dir-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'x.md'), format({ summary: 'a short note', body: 'body' }))
  writeFileSync(join(dir, 'beads', 'notes.txt'), 'plain text, not a note\n')
  expect(noteExists(dir, 'beads')).toBe(false)
  expect(noteExists(dir, '')).toBe(false)
  expect(noteExists(dir, 'beads/notes.txt')).toBe(false)
  expect(noteExists(dir, 'beads/x.md')).toBe(true)
})

test('compact() drops a usage line logged against a directory path, and keeps a real note', () => {
  const dir = join(tmpdir(), `memory-compact-dir-usage-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'x.md'), format({ summary: 'a short note', body: 'body' }))
  // simulate the pre-fix bug's bad usage line: a 'helped' event logged against a bare directory
  use(dir, ['beads'], 'helped')
  use(dir, ['beads/x.md'], 'helped')
  expect(usage(dir).get('beads')?.helped).toBe(1)
  compact(dir, {})
  expect(usage(dir).get('beads')).toBeUndefined()
  expect(usage(dir).get('beads/x.md')?.helped).toBe(1)
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

test('supersede() writes one superseded: line, byte-exact on every other line, keeping an unknown frontmatter key', () => {
  const dir = join(tmpdir(), `memory-supersede-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const before = '---\nsummary: a short note\nunknown: kept as is\n---\nbody text\n'
  writeFileSync(join(dir, 'beads', 'x.md'), before)
  expect(supersede(dir, 'beads/x.md', 'inbox/y.md')).toEqual({ marked: true })
  expect(readFileSync(join(dir, 'beads', 'x.md'), 'utf8')).toBe(
    '---\nsummary: a short note\nunknown: kept as is\nsuperseded: inbox/y.md\n---\nbody text\n',
  )
})

test('supersede() replaces an old superseded: line instead of adding a second one', () => {
  const dir = join(tmpdir(), `memory-supersede-replace-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(
    join(dir, 'beads', 'x.md'),
    '---\nsummary: a short note\nsuperseded: inbox/old.md\n---\nbody text\n',
  )
  supersede(dir, 'beads/x.md', 'inbox/new.md')
  expect(readFileSync(join(dir, 'beads', 'x.md'), 'utf8')).toBe(
    '---\nsummary: a short note\nsuperseded: inbox/new.md\n---\nbody text\n',
  )
})

test('supersede() prepends a frontmatter block to a note with none', () => {
  const dir = join(tmpdir(), `memory-supersede-nofm-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  writeFileSync(join(dir, 'inbox', 'x.md'), 'no frontmatter\nmore body\n')
  supersede(dir, 'inbox/x.md', 'inbox/y.md')
  expect(readFileSync(join(dir, 'inbox', 'x.md'), 'utf8')).toBe(
    '---\nsuperseded: inbox/y.md\n---\nno frontmatter\nmore body\n',
  )
})

test('supersede() changes no file for a LONG.md#id or CORE.md#hash path, and says so', () => {
  const dir = join(tmpdir(), `memory-supersede-hash-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(
    join(dir, 'beads', 'LONG.md'),
    formatLong([{ id: 'lock', summary: 'bd init locks every repo', body: 'merged' }]),
  )
  writeFileSync(join(dir, 'CORE.md'), '- a core lesson\n')
  const longBefore = readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8')
  const coreBefore = readFileSync(join(dir, 'CORE.md'), 'utf8')
  expect(supersede(dir, 'beads/LONG.md#lock', 'inbox/y.md')).toEqual({ marked: false })
  expect(supersede(dir, 'CORE.md#deadbeef', 'inbox/y.md')).toEqual({ marked: false })
  expect(readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8')).toBe(longBefore)
  expect(readFileSync(join(dir, 'CORE.md'), 'utf8')).toBe(coreBefore)
})

test('applyTiers dry run archives a note supersede() just marked', () => {
  const dir = join(tmpdir(), `memory-supersede-applytiers-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  writeFileSync(join(dir, 'beads', 'old.md'), format({ summary: 'an old note', body: 'body' }))
  supersede(dir, 'beads/old.md', 'inbox/new.md')
  const { decisions } = applyTiers(dir, { dryRun: true })
  expect(decisions).toContainEqual({
    kind: 'archive',
    path: 'beads/old.md',
    reason: 'superseded by inbox/new.md',
  })
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
  shown: 0,
  helped: 0,
  activation: -Infinity,
  ...over,
})
const USED = -1 // an activation above THETA.merge
const IDLE = -5 // an activation below THETA.archive

test('decide() archives a shown note whose activation is below θa, once 14 days old', () => {
  expect(decide([short({ ageDays: 13, shown: 1, activation: IDLE })], [])).toEqual([])
  expect(decide([short({ ageDays: 31, shown: 1, activation: IDLE })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'activation -5.00 below -3.6, 31 days old' },
  ])
})

test('decide() never archives a note above θa, however old', () => {
  expect(decide([short({ ageDays: 400, helped: 1, activation: USED })], []).map(d => d.kind)).toEqual([
    'merge',
  ])
})

test('decide() merges a note above θm once it is 7 days old, not at 6', () => {
  expect(decide([short({ ageDays: 6, shown: 1, activation: USED })], [])).toEqual([])
  expect(decide([short({ ageDays: 8, shown: 1, activation: USED })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'activation -1.00, 8 days old' },
  ])
  // helped alone (never shown by a search) also qualifies
  expect(decide([short({ ageDays: 8, shown: 0, helped: 1, activation: USED })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'activation -1.00, 8 days old' },
  ])
  // never shown and never helped: never merges (claude-factory-503.2 now archives it at 14+ days
  // old instead; see the never-shown archive-rule tests below, so this stays under that boundary)
  expect(decide([short({ ageDays: 10, shown: 0, helped: 0 })], [])).toEqual([])
})

test('decide() archives a superseded note outright, even if young and helped', () => {
  expect(decide([short({ ageDays: 1, helped: 5, activation: USED, superseded: 'beads/y.md' })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'superseded by beads/y.md' },
  ])
})

test('decide() never touches an inbox note: the dream files it first', () => {
  expect(decide([short({ topic: 'inbox', ageDays: 400 })], [])).toEqual([])
})

test('decide() flags a long entry as a promotion candidate above θc across 3 runs, not at 2 runs', () => {
  expect(decide([], [{ path: 'beads/LONG.md#lock', activation: 1, runs: 2 }])).toEqual([])
  expect(decide([], [{ path: 'beads/LONG.md#lock', activation: 1, runs: 3 }])).toEqual([
    { kind: 'promote', path: 'beads/LONG.md#lock', reason: 'activation 1.00 across 3 runs' },
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

// AC1: archive a never-shown, never-helped note at 14 days old.
test('decide() archives a never-shown note at 14 days old, not at 13.9', () => {
  expect(decide([short({ ageDays: 13.9, shown: 0, helped: 0 })], [])).toEqual([])
  expect(decide([short({ ageDays: 14, shown: 0, helped: 0 })], [])).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'never shown, 14 days old' },
  ])
})

test('decide() never-shown archive rule skips a note shown or helped even once', () => {
  // shown or helped at ageDays 14 qualifies for the merge rule instead, never the archive rule
  expect(decide([short({ ageDays: 14, shown: 1, helped: 0, activation: USED })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'activation -1.00, 14 days old' },
  ])
  expect(decide([short({ ageDays: 14, shown: 0, helped: 1, activation: USED })], [])).toEqual([
    { kind: 'merge', path: 'beads/x.md', reason: 'activation -1.00, 14 days old' },
  ])
})

// AC2: a usage-history guard holds back both usage-based archive rules under 14 days of history.
test('decide() usage-history guard stops both usage-based archive rules under 14 days, never the superseded rule', () => {
  // The new never-shown rule waits for the guard, then archives.
  expect(decide([short({ ageDays: 14, shown: 0, helped: 0 })], [], [], { historyDays: 13.9 })).toEqual([])
  expect(decide([short({ ageDays: 14, shown: 0, helped: 0 })], [], [], { historyDays: 14 })).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'never shown, 14 days old' },
  ])
  // The activation rule (below θa) waits for the same guard.
  const idle = short({ ageDays: 31, shown: 1, activation: IDLE })
  expect(decide([idle], [], [], { historyDays: 13.9 })).toEqual([])
  expect(decide([idle], [], [], { historyDays: 14 })).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'activation -5.00 below -3.6, 31 days old' },
  ])
  // The superseded rule ignores the guard: it archives with no usage history at all.
  expect(decide([short({ superseded: 'beads/y.md' })], [], [], { historyDays: 0 })).toEqual([
    { kind: 'archive', path: 'beads/x.md', reason: 'superseded by beads/y.md' },
  ])
})

// AC3: the archive cap keeps the oldest notes (by ageDays) first. A tie breaks by path. The cap spans every topic.
test('decide() caps archives per pass at the default of 25, oldest first, the rest held', () => {
  const cands = Array.from({ length: 40 }, (_, i) =>
    short({ path: `beads/n${15 + i}.md`, ageDays: 15 + i, shown: 0, helped: 0 }),
  )
  const decisions = decide(cands, [], [], { historyDays: 100 })
  const archived = decisions.filter(d => d.kind === 'archive').map(d => d.path)
  const held = decisions.filter(d => d.kind === 'held').map(d => d.path)
  expect(archived).toHaveLength(25)
  expect(held).toHaveLength(15)
  // the 25 oldest: ages 54 down to 30
  expect(new Set(archived)).toEqual(new Set(cands.filter(c => c.ageDays >= 30).map(c => c.path)))
  expect(new Set(held)).toEqual(new Set(cands.filter(c => c.ageDays < 30).map(c => c.path)))
  expect(decisions.find(d => d.kind === 'held')?.reason).toBe('over the archive cap of 25 this pass')
})

test('decide() archive cap tie-break: same ageDays, path ascending wins the slot', () => {
  const cands = [
    short({ path: 'beads/b.md', ageDays: 20 }),
    short({ path: 'beads/a.md', ageDays: 20 }),
    short({ path: 'beads/c.md', ageDays: 20 }),
  ]
  const decisions = decide(cands, [], [], { historyDays: 100, archiveCap: 2 })
  // the two lowest paths (a, b) win the 2 slots; the highest (c) is held
  expect(new Set(decisions.filter(d => d.kind === 'archive').map(d => d.path))).toEqual(
    new Set(['beads/a.md', 'beads/b.md']),
  )
  expect(decisions.filter(d => d.kind === 'held').map(d => d.path)).toEqual(['beads/c.md'])
})

test('decide() archive cap is global across topics, not per topic', () => {
  const cands = [
    short({ path: 'beads/a.md', topic: 'beads', ageDays: 20 }),
    short({ path: 'ci/a.md', topic: 'ci', ageDays: 19 }),
    short({ path: 'release/a.md', topic: 'release', ageDays: 18 }),
  ]
  const decisions = decide(cands, [], [], { historyDays: 100, archiveCap: 1 })
  expect(decisions.filter(d => d.kind === 'archive')).toHaveLength(1)
  expect(decisions.filter(d => d.kind === 'held')).toHaveLength(2)
})

test('decide() archive cap of 0 holds every archive', () => {
  const decisions = decide([short({ ageDays: 31, shown: 1, activation: IDLE })], [], [], {
    historyDays: 100,
    archiveCap: 0,
  })
  expect(decisions).toEqual([
    { kind: 'held', path: 'beads/x.md', reason: 'over the archive cap of 0 this pass' },
  ])
})

test('decide() archive cap counts a superseded archive against the same cap', () => {
  const cands = [
    short({ path: 'beads/a.md', ageDays: 50, superseded: 'beads/z.md' }),
    short({ path: 'beads/b.md', ageDays: 20, shown: 0, helped: 0 }),
  ]
  const decisions = decide(cands, [], [], { historyDays: 100, archiveCap: 1 })
  expect(decisions.filter(d => d.kind === 'archive').map(d => d.path)).toEqual(['beads/a.md'])
  expect(decisions.filter(d => d.kind === 'held').map(d => d.path)).toEqual(['beads/b.md'])
})

const plainOld = (path: string, over: Partial<ShortCandidate> = {}): ShortCandidate =>
  short({ path, ageDays: 10, ...over })

test('decide() topic cap: 15 short notes get no cap merge, 16 get exactly 1', () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => plainOld(`beads/n${i}.md`))
  expect(decide(fifteen, [], [], { topicCap: 15 })).toEqual([])

  const sixteen = Array.from({ length: 16 }, (_, i) => plainOld(`beads/n${i}.md`))
  const decisions = decide(sixteen, [], [], { topicCap: 15 })
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toEqual({
    kind: 'merge',
    path: 'beads/n0.md',
    reason: 'topic beads over the short-note cap of 15 (16 short notes)',
  })
})

test('decide() topic cap picks the oldest notes first, by ageDays then path', () => {
  const cands = [
    ...Array.from({ length: 15 }, (_, i) => plainOld(`beads/n${i}.md`, { ageDays: 10 })),
    plainOld('beads/oldest.md', { ageDays: 50 }),
    plainOld('beads/older.md', { ageDays: 30 }),
  ]
  const decisions = decide(cands, [], [], { topicCap: 15 })
  expect(decisions.map(d => ('path' in d ? d.path : ''))).toEqual(['beads/oldest.md', 'beads/older.md'])
})

test('decide() topic cap never picks a note under MERGE_AGE_DAYS (7) old, even when candidates run out first', () => {
  // 20 notes, only 2 old enough to merge: the cap would need 5 removed to reach 15, but decide() must
  // stop at 2 (out of candidates) rather than reach into the 18 young notes to hit the cap exactly
  const cands = [
    ...Array.from({ length: 2 }, (_, i) => plainOld(`beads/old${i}.md`, { ageDays: 10 })),
    ...Array.from({ length: 18 }, (_, i) => plainOld(`beads/young${i}.md`, { ageDays: 6 })),
  ]
  const decisions = decide(cands, [], [], { topicCap: 15 })
  expect(decisions).toEqual([
    {
      kind: 'merge',
      path: 'beads/old0.md',
      reason: 'topic beads over the short-note cap of 15 (20 short notes)',
    },
    {
      kind: 'merge',
      path: 'beads/old1.md',
      reason: 'topic beads over the short-note cap of 15 (20 short notes)',
    },
  ])
})

test('decide() topic cap: 20 notes with 3 merges and 2 archives already planned leaves 15, no cap merge', () => {
  const cands = [
    ...Array.from({ length: 3 }, (_, i) => plainOld(`beads/shown${i}.md`, { shown: 1, activation: USED })), // -> merge
    ...Array.from({ length: 2 }, (_, i) =>
      plainOld(`beads/stale${i}.md`, { ageDays: 31, shown: 1, activation: IDLE }),
    ), // -> archive
    ...Array.from({ length: 15 }, (_, i) => plainOld(`beads/plain${i}.md`)),
  ]
  const decisions = decide(cands, [], [], { historyDays: 100, topicCap: 15 })
  expect(decisions.filter(d => d.kind === 'merge')).toHaveLength(3)
  expect(decisions.filter(d => d.kind === 'archive')).toHaveLength(2)
  expect(decisions.some(d => 'reason' in d && d.reason.includes('over the short-note cap'))).toBe(false)
})

test('decide() topic cap counts a held note (over the archive cap) as still in the topic', () => {
  const cands = [
    plainOld('beads/held-candidate.md', { ageDays: 31, shown: 1, activation: IDLE }), // archive -> held (archiveCap 0)
    ...Array.from({ length: 15 }, (_, i) => plainOld(`beads/plain${i}.md`)),
  ]
  const decisions = decide(cands, [], [], { historyDays: 100, topicCap: 15, archiveCap: 0 })
  expect(decisions.filter(d => d.kind === 'held').map(d => d.path)).toEqual(['beads/held-candidate.md'])
  const capMerges = decisions.filter(d => 'reason' in d && d.reason.includes('over the short-note cap'))
  expect(capMerges).toHaveLength(1)
  expect(capMerges[0]).toMatchObject({ path: 'beads/plain0.md' })
})

test('decide() topic cap counts a superseded note (archived outright) as removed from the topic', () => {
  const cands = [
    plainOld('beads/superseded.md', { superseded: 'beads/kept.md' }),
    ...Array.from({ length: 15 }, (_, i) => plainOld(`beads/plain${i}.md`)),
  ]
  const decisions = decide(cands, [], [], { topicCap: 15 })
  expect(decisions).toEqual([
    { kind: 'archive', path: 'beads/superseded.md', reason: 'superseded by beads/kept.md' },
  ])
})

test('decide() topic cap never touches inbox, however many notes it holds', () => {
  const cands = Array.from({ length: 20 }, (_, i) => plainOld(`inbox/n${i}.md`, { topic: 'inbox' }))
  expect(decide(cands, [], [], { topicCap: 15 })).toEqual([])
})

test('decide() with no topicCap (default Infinity) gives the same output as before the cap existed', () => {
  const cands = Array.from({ length: 100 }, (_, i) => plainOld(`beads/n${i}.md`))
  expect(decide(cands, [])).toEqual([])
  expect(decide(cands, [], [], {})).toEqual([])
})

// AC5: an expired note retires at any age or usage count, even under 7 days old.
test('decide() retires an expired note, at any age or usage count, even under 7 days old', () => {
  expect(
    decide([short({ expired: true, expiredReason: 'date 2026-01-01 passed', helped: 5, ageDays: 1 })], []),
  ).toEqual([{ kind: 'retire', path: 'beads/x.md', reason: 'date 2026-01-01 passed' }])
})

test('decide() never retires an inbox note, however expired', () => {
  expect(
    decide([short({ topic: 'inbox', expired: true, expiredReason: 'date 2026-01-01 passed' })], []),
  ).toEqual([])
})

test('decide() archives, not retires, an expired note that is also superseded: superseded wins', () => {
  expect(
    decide([short({ expired: true, expiredReason: 'date 2026-01-01 passed', superseded: 'beads/y.md' })], []),
  ).toEqual([{ kind: 'archive', path: 'beads/x.md', reason: 'superseded by beads/y.md' }])
})

// AC6: a flag never blocks another rule. Other rules still run and can add their own decision.
test('decide() flags an untilFlag note, and still archives it under the normal archive rule', () => {
  expect(
    decide(
      [short({ untilFlag: 'bead acme-widget-h7c not found', ageDays: 31, shown: 1, activation: IDLE })],
      [],
      [],
      { historyDays: 100 },
    ),
  ).toEqual([
    { kind: 'flag', path: 'beads/x.md', reason: 'bead acme-widget-h7c not found' },
    { kind: 'archive', path: 'beads/x.md', reason: 'activation -5.00 below -3.6, 31 days old' },
  ])
})

test('decide() flags an untilFlag note alone, when no other rule fires', () => {
  expect(decide([short({ untilFlag: 'no lookup' })], [])).toEqual([
    { kind: 'flag', path: 'beads/x.md', reason: 'no lookup' },
  ])
})

// AC7: the archive cap treats a retire the same as an archive: the oldest note keeps its kind.
test('decide() archive cap treats a retire the same as an archive: the older note keeps its kind', () => {
  const decisions = decide(
    [
      short({ path: 'beads/old.md', ageDays: 40, expired: true, expiredReason: 'date passed' }),
      short({ path: 'beads/new.md', ageDays: 20, shown: 0, helped: 0 }),
    ],
    [],
    [],
    { historyDays: 100, archiveCap: 1 },
  )
  expect(decisions).toEqual([
    { kind: 'retire', path: 'beads/old.md', reason: 'date passed' },
    { kind: 'held', path: 'beads/new.md', reason: 'over the archive cap of 1 this pass' },
  ])
})

// AC7: the topic cap counts a retire as removed from the topic, the same as an archive or a merge.
test('decide() topic cap counts a retire as removed from the topic, same as an archive or merge', () => {
  const notes = [
    short({ path: 'beads/a.md', expired: true, expiredReason: 'date passed' }),
    ...Array.from({ length: 14 }, (_, i) => short({ path: `beads/n${i}.md` })),
  ]
  const decisions = decide(notes, [], [], { topicCap: 14 })
  expect(decisions.filter(d => d.kind === 'retire')).toHaveLength(1)
  expect(decisions.filter(d => d.kind === 'merge')).toHaveLength(0)
})

// AC7: a flag is not a decision for the topic cap, like a promote or a dedupe. It never stops the
// cap from picking that same note for a merge.
test('decide() topic cap still merges an untilFlag note: the flag does not block it', () => {
  const notes = [
    short({ path: 'beads/a.md', untilFlag: 'no lookup', ageDays: 10 }),
    ...Array.from({ length: 15 }, (_, i) => short({ path: `beads/n${i}.md` })),
  ]
  const decisions = decide(notes, [], [], { topicCap: 15 })
  expect(decisions).toContainEqual({ kind: 'flag', path: 'beads/a.md', reason: 'no lookup' })
  expect(decisions).toContainEqual({
    kind: 'merge',
    path: 'beads/a.md',
    reason: 'topic beads over the short-note cap of 15 (16 short notes)',
  })
})

// AC9: the header counts retire and flag too, and each line still reads `kind  path: reason`.
test('planLines() header counts retire and flag, and each line reads kind  path: reason', () => {
  const decisions: Decision[] = [
    { kind: 'merge', path: 'a/a.md', reason: 'r1' },
    { kind: 'archive', path: 'a/b.md', reason: 'r2' },
    { kind: 'retire', path: 'a/c.md', reason: 'r3' },
    { kind: 'held', path: 'a/d.md', reason: 'r4' },
    { kind: 'flag', path: 'a/e.md', reason: 'r5' },
  ]
  const lines = planLines(decisions, { archiveCap: 25, historyDays: 10 })
  expect(lines[0]).toBe(
    'tier plan: 1 merge, 1 archive, 1 retire, 0 trim, 1 held (cap 25), 1 flag, usage history 10 days',
  )
  expect(lines).toContain('retire  a/c.md: r3')
  expect(lines).toContain('flag  a/e.md: r5')
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
    { kind: 'merge', path: 'beads/lock.md', reason: 'activation 1.59, 14 days old' },
  ])
  expect(renamed).toEqual({ 'beads/lock.md': 'beads/LONG.md#bd-init-locks-every-repo' })
  expect(existsSync(join(dir, 'beads', 'lock.md'))).toBe(false)
  const entries = parseLong(readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8'))
  expect(entries.map(e => e.summary)).toEqual(['bd init locks every repo'])

  compact(dir, renamed)
  expect(usage(dir).get('beads/LONG.md#bd-init-locks-every-repo')?.helped).toBe(1)
})

test('applyTiers() keeps a merged note until: marker in LONG.md', () => {
  const dir = join(tmpdir(), `memory-apply-until-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'lock.md'),
    format({ summary: 'bd init locks every repo', at: '2026-10-07', until: '2099-01-01', body: 'why' }),
  )
  use(dir, ['beads/lock.md'], 'helped', now - 1000)
  expect(applyTiers(dir, { now }).merged).toBe(1)
  const text = readFileSync(join(dir, 'beads', 'LONG.md'), 'utf8')
  expect(text).toContain('2099-01-01')
  expect(parseLong(text)[0]?.until).toBe('2099-01-01')
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
  // 20 days of usage history: clears the guard that holds back the never-helped archive rule
  use(dir, ['beads/unrelated.md'], 'shown', now - 20 * 24 * 60 * 60 * 1000)
  const { merged, archived, decisions } = applyTiers(dir, { now })
  expect(merged).toBe(0)
  expect(archived).toBe(2)
  expect(decisions.map(d => d.kind)).toEqual(['archive', 'archive'])
  expect(existsSync(join(dir, 'beads', 'stale.md'))).toBe(false)
  expect(existsSync(join(dir, 'beads', 'old.md'))).toBe(false)
  expect(readFileSync(join(dir, '.archive', 'beads.md'), 'utf8')).toContain('a note nobody ever needed')
  expect(readFileSync(join(dir, '.archive', 'beads.md'), 'utf8')).toContain('the old way to do it')
})

// AC4 and AC7: a 30-note, never-shown fixture (ages 20..49 days) with the cap at its default of 25.
function fixtureNeverShown30(dir: string, now: number): string[] {
  const DAY = 24 * 60 * 60 * 1000
  const paths: string[] = []
  for (let age = 20; age <= 49; age++) {
    const path = `beads/n${age}.md`
    paths.push(path)
    const at = new Date(now - age * DAY).toISOString().slice(0, 10)
    writeFileSync(join(dir, 'beads', `n${age}.md`), format({ summary: `note ${age}`, at, body: 'body' }))
  }
  return paths
}

test('applyTiers() caps a mass of never-shown notes at 25, holds the rest, and plans before writing', () => {
  const dir = join(tmpdir(), `memory-apply-cap-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  const DAY = 24 * 60 * 60 * 1000
  const paths = fixtureNeverShown30(dir, now)
  use(dir, ['beads/seed.md'], 'shown', now - 20 * DAY) // 20 days of usage history: clears the guard

  const plans: string[][] = []
  const { archived, held, archiveCap, historyDays } = applyTiers(dir, {
    now,
    onPlan: lines => {
      plans.push(lines)
      // onPlan must run before any write or rmSync: every note is still on disk right now
      for (const p of paths) expect(existsSync(join(dir, p))).toBe(true)
    },
  })
  expect(archived).toBe(25)
  expect(held).toBe(5)
  expect(archiveCap).toBe(25)
  expect(Math.floor(historyDays)).toBe(20)
  expect(plans).toHaveLength(1)
  expect(plans[0]![0]).toBe(
    'tier plan: 0 merge, 25 archive, 0 retire, 0 trim, 5 held (cap 25), 0 flag, usage history 20 days',
  )
  expect(plans[0]!.filter(l => l.startsWith('archive  ')).length).toBe(25)
  expect(plans[0]!.filter(l => l.startsWith('held  ')).length).toBe(5)

  // the 5 youngest (20..24 days old) stay; the 25 oldest (25..49 days old) archive
  for (let age = 20; age <= 24; age++) expect(existsSync(join(dir, 'beads', `n${age}.md`))).toBe(true)
  for (let age = 25; age <= 49; age++) expect(existsSync(join(dir, 'beads', `n${age}.md`))).toBe(false)
})

test('applyTiers() archives nothing under the usage-history guard with no usage file at all', () => {
  const dir = join(tmpdir(), `memory-apply-cap-noguard-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  const paths = fixtureNeverShown30(dir, now)

  // topicCap: Infinity keeps this test about the usage-history guard alone; the 30-note fixture would
  // otherwise trip the unrelated topic cap (default 15) and merge some of these notes away
  const { archived, historyDays } = applyTiers(dir, { now, topicCap: Infinity })
  expect(archived).toBe(0)
  expect(historyDays).toBe(0)
  for (const p of paths) expect(existsSync(join(dir, p))).toBe(true)
})

test('applyTiers() reads the archive cap from FACTORY_MEMORY_ARCHIVE_CAP, and a bad value falls back to 25', () => {
  const dir = join(tmpdir(), `memory-apply-cap-env-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  const DAY = 24 * 60 * 60 * 1000
  fixtureNeverShown30(dir, now)
  use(dir, ['beads/seed.md'], 'shown', now - 20 * DAY)

  const prev = process.env.FACTORY_MEMORY_ARCHIVE_CAP
  try {
    process.env.FACTORY_MEMORY_ARCHIVE_CAP = '3'
    expect(applyTiers(dir, { now, dryRun: true }).archived).toBe(3)
    process.env.FACTORY_MEMORY_ARCHIVE_CAP = 'abc'
    expect(applyTiers(dir, { now, dryRun: true }).archived).toBe(25)
  } finally {
    if (prev === undefined) delete process.env.FACTORY_MEMORY_ARCHIVE_CAP
    else process.env.FACTORY_MEMORY_ARCHIVE_CAP = prev
  }
})

// n short notes in one topic. Note 0 is startAgeDays old, note 1 is startAgeDays+1 old, and so on.
// Each note's ageDays is distinct, so the oldest-first tie-break never has to pick between two of them.
function fixtureOldNotes(dir: string, topic: string, n: number, now: number, startAgeDays = 10): string[] {
  const DAY = 24 * 60 * 60 * 1000
  mkdirSync(join(dir, topic), { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < n; i++) {
    const file = `n${String(i).padStart(2, '0')}.md`
    paths.push(`${topic}/${file}`)
    const at = new Date(now - (startAgeDays + i) * DAY).toISOString().slice(0, 10)
    writeFileSync(join(dir, topic, file), format({ summary: `note ${i}`, at, body: 'body' }))
  }
  return paths
}

test('applyTiers() merges a topic down to the cap: 18 notes become 15 short notes and 3 LONG.md entries, each renamed', () => {
  const dir = join(tmpdir(), `memory-apply-topiccap-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  const paths = fixtureOldNotes(dir, 'beads', 18, now)

  const { merged, archived, renamed, overCap, topicCap } = applyTiers(dir, { now, topicCap: 15 })
  expect(topicCap).toBe(15)
  expect(merged).toBe(3)
  expect(archived).toBe(0)
  expect(Object.keys(renamed)).toHaveLength(3)
  for (const old of Object.keys(renamed)) expect(paths).toContain(old)
  expect(overCap).toEqual([])

  const remaining = readdirSync(join(dir, 'beads')).filter(f => f.endsWith('.md') && f !== 'LONG.md')
  expect(remaining).toHaveLength(15)
  expect(existsSync(join(dir, 'beads', 'LONG.md'))).toBe(true)
  // the 3 oldest (the last 3 created, ages 25, 26, 27) are the ones that merged away
  for (const i of [15, 16, 17])
    expect(existsSync(join(dir, 'beads', `n${String(i).padStart(2, '0')}.md`))).toBe(false)
})

test('applyTiers() topic cap, dry run: counts the same 3 merges, writes nothing, same overCap as the real pass', () => {
  const dir = join(tmpdir(), `memory-apply-topiccap-dry-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  const paths = fixtureOldNotes(dir, 'beads', 18, now)

  const dry = applyTiers(dir, { now, topicCap: 15, dryRun: true })
  expect(dry.merged).toBe(3)
  expect(dry.overCap).toEqual([])
  for (const p of paths) expect(existsSync(join(dir, p))).toBe(true) // nothing written
  expect(existsSync(join(dir, 'beads', 'LONG.md'))).toBe(false)
})

test('applyTiers() topic cap: a skipped merge into an unsafe LONG.md leaves the topic in overCap', () => {
  const dir = join(tmpdir(), `memory-apply-topiccap-unsafe-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  fixtureOldNotes(dir, 'beads', 18, now)
  // stray prose before the first entry: unsafeLongTopics() flags this file, so no merge into it can run
  writeFileSync(join(dir, 'beads', 'LONG.md'), '---\ntier: long\n---\nstray prose with no entry\n')

  const { merged, skipped, overCap } = applyTiers(dir, { now, topicCap: 15 })
  expect(merged).toBe(0)
  expect(skipped).toEqual([
    { topic: 'beads', reason: expect.stringContaining('a merge would lose') as unknown as string },
  ])
  expect(overCap).toEqual([{ topic: 'beads', count: 18 }])
})

test('envTopicCap() reads FACTORY_MEMORY_TOPIC_CAP, and a bad value falls back to 15', () => {
  const prev = process.env.FACTORY_MEMORY_TOPIC_CAP
  try {
    delete process.env.FACTORY_MEMORY_TOPIC_CAP
    expect(envTopicCap()).toBe(15)
    process.env.FACTORY_MEMORY_TOPIC_CAP = '7'
    expect(envTopicCap()).toBe(7)
    for (const bad of ['0', '-1', '1.5', '']) {
      process.env.FACTORY_MEMORY_TOPIC_CAP = bad
      expect(envTopicCap()).toBe(15)
    }
  } finally {
    if (prev === undefined) delete process.env.FACTORY_MEMORY_TOPIC_CAP
    else process.env.FACTORY_MEMORY_TOPIC_CAP = prev
  }
})

test('applyTiers() reads the topic cap from FACTORY_MEMORY_TOPIC_CAP, and a bad value falls back to 15', () => {
  const dir = join(tmpdir(), `memory-apply-topiccap-env-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  fixtureOldNotes(dir, 'beads', 18, now)

  const prev = process.env.FACTORY_MEMORY_TOPIC_CAP
  try {
    process.env.FACTORY_MEMORY_TOPIC_CAP = '3'
    expect(applyTiers(dir, { now, dryRun: true }).merged).toBe(15) // 18 - 3
    process.env.FACTORY_MEMORY_TOPIC_CAP = 'abc'
    expect(applyTiers(dir, { now, dryRun: true }).merged).toBe(3) // 18 - 15
  } finally {
    if (prev === undefined) delete process.env.FACTORY_MEMORY_TOPIC_CAP
    else process.env.FACTORY_MEMORY_TOPIC_CAP = prev
  }
})

test('overCapTopics lists topics over the cap now, from the live store, sorted by count desc then topic asc', () => {
  const dir = join(tmpdir(), `memory-overcap-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  fixtureOldNotes(dir, 'beads', 16, now)
  fixtureOldNotes(dir, 'ci', 20, now)
  fixtureOldNotes(dir, 'release', 10, now) // under the cap: never listed

  expect(overCapTopics(dir, 15)).toEqual([
    { topic: 'ci', count: 20 },
    { topic: 'beads', count: 16 },
  ])
  // exactly at the cap: not over it
  expect(overCapTopics(dir, 16)).toEqual([{ topic: 'ci', count: 20 }])
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
    // 20 days of usage history: clears the guard that holds back the never-helped archive rule
    use(dir, ['beads/unrelated.md'], 'shown', now - 20 * 24 * 60 * 60 * 1000)
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
  const now = Date.parse('2026-10-15T00:00:00Z') // 75 days later: past ARCHIVE_NEW_DAYS (14)
  // 20 days of usage history: clears the guard that holds back the never-helped archive rule
  use(dir, ['beads/unrelated.md'], 'shown', now - 20 * 24 * 60 * 60 * 1000)

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
  const now = Date.parse('2026-10-15T00:00:00Z') // 75 days later: past ARCHIVE_NEW_DAYS (14)
  // 20 days of usage history: clears the guard that holds back the never-helped archive rule
  use(dir, ['beads/unrelated.md'], 'shown', now - 20 * 24 * 60 * 60 * 1000)

  const { decisions, archived } = applyTiers(dir, { now })
  expect(archived).toBe(1)
  expect(decisions).toEqual([
    { kind: 'archive', path: 'beads/old.md', reason: expect.stringContaining('never shown') },
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
  // 20 days of usage history: clears the guard that holds back the never-helped archive rule
  use(dir, ['beads/unrelated.md'], 'shown', now - 20 * 24 * 60 * 60 * 1000)

  const { decisions, archived } = applyTiers(dir, { now })
  expect(archived).toBe(1) // archived only because the age comes from the 2026-08-01 add, not the edit
  expect(decisions).toEqual([
    { kind: 'archive', path: 'beads/old.md', reason: expect.stringContaining('never shown') },
  ])
})

test('applyTiers() retires a note whose date until marker passed, and writes it to .archive like an archive', () => {
  const dir = join(tmpdir(), `memory-apply-retire-date-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'stale-fact.md'),
    format({ summary: 'a fact that holds only until a date', until: '2026-01-01', body: 'body' }),
  )
  const { retired, archived, merged, decisions } = applyTiers(dir, { now })
  expect(retired).toBe(1)
  expect(archived).toBe(0)
  expect(merged).toBe(0)
  expect(decisions).toEqual([
    { kind: 'retire', path: 'beads/stale-fact.md', reason: 'date 2026-01-01 passed' },
  ])
  expect(existsSync(join(dir, 'beads', 'stale-fact.md'))).toBe(false)
  expect(readFileSync(join(dir, '.archive', 'beads.md'), 'utf8')).toContain(
    'a fact that holds only until a date',
  )
})

test('applyTiers() dry run counts a retire but writes nothing', () => {
  const dir = join(tmpdir(), `memory-apply-retire-dry-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'stale-fact.md'),
    format({ summary: 'a fact that holds only until a date', until: '2026-01-01', body: 'body' }),
  )
  const { retired } = applyTiers(dir, { now, dryRun: true })
  expect(retired).toBe(1)
  expect(existsSync(join(dir, 'beads', 'stale-fact.md'))).toBe(true)
  expect(existsSync(join(dir, '.archive', 'beads.md'))).toBe(false)
})

test('applyTiers() flags, and keeps, a bead-until note whose lookup throws', () => {
  const dir = join(tmpdir(), `memory-apply-flag-throw-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'cites-bead.md'),
    format({ summary: 'a fact that cites a bead', until: 'acme-widget-h7c', body: 'body' }),
  )
  const untilDeps: UntilDeps = {
    bead: () => {
      throw new Error('secret-e2e: bd down')
    },
  }
  const { retired, flagged, decisions } = applyTiers(dir, { now, untilDeps })
  expect(retired).toBe(0)
  expect(flagged).toBe(1)
  expect(decisions).toEqual([
    { kind: 'flag', path: 'beads/cites-bead.md', reason: 'bead acme-widget-h7c lookup failed' },
  ])
  expect(existsSync(join(dir, 'beads', 'cites-bead.md'))).toBe(true)
})

test('applyTiers() with no untilDeps at all leaves a bead-until note untouched, with no flag', () => {
  const dir = join(tmpdir(), `memory-apply-no-untildeps-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'beads'), { recursive: true })
  const now = Date.parse('2026-10-15T00:00:00Z')
  writeFileSync(
    join(dir, 'beads', 'cites-bead.md'),
    format({ summary: 'a fact that cites a bead', until: 'acme-widget-h7c', body: 'body' }),
  )
  const { retired, flagged, decisions } = applyTiers(dir, { now })
  expect(retired).toBe(0)
  expect(flagged).toBe(0)
  expect(decisions).toEqual([])
  expect(existsSync(join(dir, 'beads', 'cites-bead.md'))).toBe(true)
})

test('tally keys a run by its id before the slash, so two stations of one run count as one run, not two (claude-factory-59r.16)', () => {
  const at = Date.parse('2026-10-06T12:00:00Z')
  const lines = [
    JSON.stringify({ path: 'a.md', helped: 1, at, by: 'run1/verify' }),
    JSON.stringify({ path: 'a.md', helped: 1, at: at + 1000, by: 'run1/implement' }), // same run, another station
    JSON.stringify({ path: 'a.md', helped: 1, at: at + 2000, by: 'run2/implement' }),
  ]
  expect(tally(lines).get('a.md')).toEqual({
    path: 'a.md',
    shown: 0,
    helped: 3,
    confirmed: 0,
    contradicted: 0,
    at: at + 2000,
    runs: 2,
  })
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
  expect(evalScore([], [])).toEqual({ recall: 1, mrr: 1, misses: [], categories: {} })
})

test('evalScore scores each category; an abstain case hits only when search returns nothing', () => {
  const cases: EvalCase[] = [
    { query: 'where does the cache key come from', expect: 'ci/cache.md', category: 'update' },
    { query: 'is the timing test still flaky', expect: 'ci/timing.md', category: 'temporal' },
    { query: 'what is the capital of France', category: 'abstain' },
    { query: 'what is the office wifi password', category: 'abstain' },
    { query: 'how to deploy', expect: 'deploy/rollout.md' }, // no category: only in the total
  ]
  const results = [
    ['ci/old-cache.md', 'ci/cache.md'], // rank 2
    ['ci/timing.md'], // rank 1
    [], // abstained: a hit
    ['beads/lock.md'], // answered a question memory cannot: a miss
    ['deploy/rollout.md'],
  ]
  const r = evalScore(cases, results)
  expect(r.recall).toBeCloseTo(4 / 5, 5)
  expect(r.categories).toEqual({
    update: { recall: 1, mrr: 0.5, n: 1 },
    temporal: { recall: 1, mrr: 1, n: 1 },
    abstain: { recall: 0.5, mrr: 0.5, n: 2 },
  })
  expect(r.misses).toEqual([cases[3]!])
  // a case with no expect and no abstain category never hits: an empty expect would match every path
  expect(evalScore([{ query: 'q' }], [['a.md']]).recall).toBe(0)
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

test('lifecycleMetrics: notes per topic, archives this pass, and the kind and until shares', () => {
  const short = (path: string, extra: Partial<Note> = {}): Note => ({
    path,
    summary: `s ${path}`,
    body: 'a lesson',
    tier: 'short',
    ...extra,
  })
  const notes: Note[] = [
    short('beads/a.md', { kind: 'fact' }),
    short('beads/b.md', { kind: 'rule', body: 'see example-ab1 for the fix', until: 'example-ab1' }),
    short('ci/c.md', { body: 'PR #12 fixed it' }), // cites a PR with no until, and has no kind
    short('ci/d.md', { kind: 'recipe', body: 'run it as in example-org/example-repo#3' }), // counts too
    { path: 'ci/LONG.md#x', summary: 'merged', body: 'b', tier: 'long' }, // a topic note, not in the shares
  ]
  expect(lifecycleMetrics(notes, { archived: 2, retired: 1 })).toBe(
    'metrics: notes 5 (beads 2, ci 3)  archived 2  retired 1  kind 75%  cites-without-until 50%',
  )
  expect(lifecycleMetrics([], { archived: 0, retired: 0 })).toBe(
    'metrics: notes 0 ()  archived 0  retired 0  kind 0%  cites-without-until 0%',
  )
})

const note = (path: string, body: string): Note => ({ path, summary: `s ${path}`, body })

test('selfCases: one case per sampled note, its first body sentence as the query, its path as the target', () => {
  const notes = [
    note('b/two.md', 'Second note. More text.'),
    note('a/one.md', 'First note here! Then more.'),
    note('c/empty.md', ''), // no body: no query to ask, so never sampled
    note('d/three.md', 'Third note\nwith a second line.'),
  ]
  const all = selfCases(notes, 10, 1)
  expect(all.map(c => c.expect).sort()).toEqual(['a/one.md ', 'b/two.md ', 'd/three.md '])
  expect(all.find(c => c.expect === 'a/one.md ')?.query).toBe('First note here!')
  expect(all.find(c => c.expect === 'd/three.md ')?.query).toBe('Third note')
  expect(selfCases(notes, 2, 1)).toHaveLength(2)
  // the same seed gives the same sample whatever order walk() returned the notes in
  expect(selfCases([...notes].reverse(), 2, 7)).toEqual(selfCases(notes, 2, 7))
  const picks = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(s => selfCases(notes, 1, s)[0]!.expect))
  expect(picks.size).toBeGreaterThan(1) // another seed samples another note
  expect(selfCases([], 5, 1)).toEqual([])
})

test('the memory-lifecycle fixture holds every note kind, a usage history and 3 runs with one failure', () => {
  const root = join(import.meta.dir, 'fixtures', 'memory-lifecycle')
  const { notes } = walk(join(root, 'memory'))
  expect(new Set(notes.map(n => n.kind))).toEqual(new Set(['fact', 'rule', 'recipe', undefined]))
  expect(notes.some(n => n.until)).toBe(true)
  expect(notes.some(n => n.superseded)).toBe(true)
  const events = readFileSync(join(root, 'memory', '.usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
  for (const k of ['shown', 'helped', 'confirmed', 'contradicted'])
    expect(events.some(l => k in JSON.parse(l))).toBe(true)
  const runs = readdirSync(join(root, 'runs')).map(id => {
    const { snapshot } = JSON.parse(readFileSync(join(root, 'runs', id, 'state.json'), 'utf8'))
    return {
      value: snapshot.value,
      log: snapshot.context.log as { node: string; outcome: string; summary: string }[],
    }
  })
  expect(runs.map(r => (typeof r.value === 'string' ? r.value : 'working')).sort()).toEqual([
    'aborted',
    'done',
    'working',
  ])
  const failures = runs.flatMap(r => r.log.filter(e => e.outcome === 'failed'))
  expect(failures).toHaveLength(3)
  expect(new Set(failures.map(e => e.summary.replace(/\(attempt \d+\)/, '')))).toHaveProperty('size', 1)
})

test('dreamPrompt names the long tier and the id rule, and adds the promotion, duplicate, unsafe and over-cap sections', () => {
  const empty = dreamPrompt('/tmp/memory', [], [], [])
  expect(empty).toContain('LONG.md')
  expect(empty).toContain("Never change an entry's `id`")
  expect(empty).toContain('aliases')
  expect(empty).toContain('## Promotion candidates')
  expect(empty).toContain('## Possible duplicates')
  expect(empty).toContain('## Unsafe LONG.md files')
  expect(empty).toContain('## Topics over the short-note cap')
  expect(empty).toContain('(none)')
  expect(empty).toContain(`3 to ${TOPIC_CAP} notes each`) // defaults to TOPIC_CAP when no topicCap is passed
  expect(empty).toContain(`holds ${TOPIC_CAP} or fewer`) // step 9 tells the dream to merge or drop to the cap
  expect(empty).toContain('already over the cap') // step 1: the list below holds only topics over the cap
  expect(empty).toContain('7 days old or more, used or not') // step 9: the cap merge does not require use

  const withCap = dreamPrompt('/tmp/memory', [], [], [], undefined, [], [], [], [], 10)
  expect(withCap).toContain('3 to 10 notes each') // a non-default topicCap is named, not the TOPIC_CAP constant
  expect(withCap).toContain('holds 10 or fewer')
  expect(withCap).not.toContain(`3 to ${TOPIC_CAP} notes each`)

  const filled = dreamPrompt(
    '/tmp/memory',
    [],
    [],
    [],
    { activity: [], skills: [] },
    ['- beads/LONG.md#lock (bd init locks every repo): helped 3 times across 3 runs'],
    ['- beads/LONG.md#a (x) vs beads/LONG.md#b (y): similarity 0.90'],
    ['- beads/LONG.md holds text before its first entry that a merge would lose: stray prose'],
    ['- ci: 23 short notes (cap 15)', '- claude-factory: 29 short notes (cap 15)'],
  )
  expect(filled).toContain('helped 3 times across 3 runs')
  expect(filled).toContain('similarity 0.90')
  expect(filled).toContain('stray prose')
  expect(filled).toContain('## Topics over the short-note cap\n- ci: 23 short notes (cap 15)')
  expect(filled).toContain('claude-factory: 29 short notes (cap 15)')
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

  const { promotions, duplicates } = await tierCandidates(dir, now)
  expect(promotions).toEqual([
    '- beads/LONG.md#lock (bd init on the shared Dolt server locks every repo): activation 2.69 across 3 runs',
  ])
  expect(duplicates).toHaveLength(1)
  expect(duplicates[0]).toContain('beads/LONG.md#x')
  expect(duplicates[0]).toContain('beads/LONG.md#y')
}, 60_000)

// citesTracker() must find a bead id or a PR reference in free text. It drives gate()'s --until
// requirement (claude-factory-3u1.1.1.2). Bead-id matching is case sensitive.
test('citesTracker() finds a bead id or a PR reference', () => {
  for (const s of [
    'claude-factory-3u1.1.1',
    'fab-6otc',
    'infra-blocks-38e0',
    'ax-706',
    'acme-6kw.2',
    'fab-bb1.1.7',
    'ama-pr9',
    'PR #70',
    'pr 70',
    'acme/widget#12',
    'https://github.com/acme/widget/pull/3',
  ])
    expect(citesTracker(s)).not.toBeNull()
})

test('citesTracker() does not fire on ordinary words that merely look like an id', () => {
  for (const s of [
    'dry-run',
    're-run',
    'pre-fix',
    'k0s-workloads-prod',
    'fabriek-m1-reviewer',
    'asd-ste100',
    'runtime-config-sha256',
    'bge-small-en-v1.5',
    'utf-8',
    'step #2',
    'PRs',
  ])
    expect(citesTracker(s)).toBeNull()
})

test('citesTracker() accepts two known false positives rather than add a special case for them', () => {
  // "ui-e2e" and "sha-256" both look like <prefix>-<3-5 alnum chars with a digit>. This is the same
  // shape as a real bead id, for example "fab-6otc". The plan accepts this trade-off. A person who
  // sees a false --until demand can tell these apart at a glance. A narrower regex would also drop
  // real ids such as "ama-pr9".
  expect(citesTracker('ui-e2e')).not.toBeNull()
  expect(citesTracker('sha-256')).not.toBeNull()
})

test('isUntil() accepts a bead id, an owner/repo#N, a GitHub pull URL, and a real calendar date', () => {
  expect(isUntil('claude-factory-3u1.1.1')).toBe(true)
  expect(isUntil('acme/widget#12')).toBe(true)
  expect(isUntil('https://github.com/acme/widget/pull/3')).toBe(true)
  expect(isUntil('2026-12-31')).toBe(true)
})

test('isUntil() refuses a fake date, the wrong date format, and plain words', () => {
  expect(isUntil('2026-02-30')).toBe(false) // February has no 30th
  expect(isUntil('12/31/2026')).toBe(false)
  expect(isUntil('soon')).toBe(false)
  expect(isUntil('#5')).toBe(false)
})

// AC1: a date ends at 00:00Z the day after it. "Today" (UTC) stays live, and so does a later date.
test('untilStatus() date: ends the day after it passes, at 00:00Z, not before', () => {
  const now = Date.parse('2026-10-17T00:00:00Z')
  expect(untilStatus('2026-10-16', now)).toEqual({ state: 'ended', reason: 'date 2026-10-16 passed' })
  expect(untilStatus('2026-10-17', now)).toEqual({ state: 'live' })
  expect(untilStatus('2026-10-18', now)).toEqual({ state: 'live' })
})

// AC2: closed ends it; any other status is live; null (not found) and a throw give different reasons;
// a missing deps.bead gives "no lookup", never a verdict.
test('untilStatus() bead: closed ends it, open is live, not-found and a lookup failure differ', () => {
  const now = Date.parse('2026-10-17T00:00:00Z')
  const id = 'acme-widget-h7c'
  expect(untilStatus(id, now, { bead: () => 'closed' })).toEqual({
    state: 'ended',
    reason: `bead ${id} closed`,
  })
  expect(untilStatus(id, now, { bead: () => 'open' })).toEqual({ state: 'live' })
  expect(untilStatus(id, now, { bead: () => null })).toEqual({
    state: 'unknown',
    reason: `bead ${id} not found`,
  })
  expect(
    untilStatus(id, now, {
      bead: () => {
        throw new Error('secret-e2e')
      },
    }),
  ).toEqual({ state: 'unknown', reason: `bead ${id} lookup failed` })
  expect(untilStatus(id, now, {})).toEqual({ state: 'unknown', reason: 'no lookup' })
})

// AC3: both spellings look up the same URL form; MERGED/CLOSED end it; OPEN is live; UNKNOWN, null and
// a throw all read as a lookup failure; a missing deps.pr gives "no lookup".
test('untilStatus() PR: owner/repo#N and the pull URL resolve to the same lookup, by state', () => {
  const now = Date.parse('2026-10-17T00:00:00Z')
  const url = 'https://github.com/acme/widget/pull/12'
  for (const ref of ['acme/widget#12', url]) {
    const seen: string[] = []
    const pr = (u: string) => {
      seen.push(u)
      return 'MERGED' as const
    }
    expect(untilStatus(ref, now, { pr })).toEqual({ state: 'ended', reason: `PR ${ref} merged` })
    expect(seen).toEqual([url]) // both spellings call deps.pr with the https URL form
  }
  expect(untilStatus(url, now, { pr: () => 'CLOSED' })).toEqual({
    state: 'ended',
    reason: `PR ${url} closed`,
  })
  expect(untilStatus(url, now, { pr: () => 'OPEN' })).toEqual({ state: 'live' })
  expect(untilStatus(url, now, { pr: () => 'UNKNOWN' })).toEqual({
    state: 'unknown',
    reason: `PR ${url} lookup failed`,
  })
  expect(untilStatus(url, now, { pr: () => null })).toEqual({
    state: 'unknown',
    reason: `PR ${url} lookup failed`,
  })
  expect(
    untilStatus(url, now, {
      pr: () => {
        throw new Error('secret-e2e')
      },
    }),
  ).toEqual({ state: 'unknown', reason: `PR ${url} lookup failed` })
  expect(untilStatus(url, now, {})).toEqual({ state: 'unknown', reason: 'no lookup' })
})

// AC4: a value isUntil() refuses is always unknown, no matter what deps the caller gives.
test('untilStatus() refuses a value isUntil() refuses, regardless of deps', () => {
  const now = Date.parse('2026-10-17T00:00:00Z')
  expect(untilStatus('soon', now, { bead: () => 'closed', pr: () => 'MERGED' })).toEqual({
    state: 'unknown',
    reason: 'not a valid until value',
  })
})

// no reason ever carries a thrown error's own message: fixed text only.
test('untilStatus() reasons never leak a thrown error message', () => {
  const now = Date.parse('2026-10-17T00:00:00Z')
  const deps: UntilDeps = {
    bead: () => {
      throw new Error('secret-e2e')
    },
    pr: () => {
      throw new Error('secret-e2e')
    },
  }
  const beadResult = untilStatus('acme-widget-h7c', now, deps)
  const prResult = untilStatus('acme/widget#12', now, deps)
  expect(beadResult.state).toBe('unknown')
  expect(prResult.state).toBe('unknown')
  expect((beadResult as { reason: string }).reason).not.toContain('secret-e2e')
  expect((prResult as { reason: string }).reason).not.toContain('secret-e2e')
})

test('gate() refuses a note with no --kind, naming --kind and all three kinds', () => {
  const r = gate({ summary: 's', body: 'b' })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.flag).toBe('--kind')
    for (const k of NOTE_KINDS) expect(r.reason).toContain(k)
  }
})

test('gate() refuses an invalid --kind value, naming --kind and the bad value', () => {
  const r = gate({ summary: 's', body: 'b', kind: 'Fact' })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.flag).toBe('--kind')
    expect(r.reason).toContain('Fact')
  }
})

test('gate() refuses a fact or rule note that cites a bead with no --until', () => {
  for (const kind of ['fact', 'rule'] as const) {
    const r = gate({ summary: 'claude-factory-3u1.1.1 taught us this', body: 'b', kind })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.flag).toBe('--until')
      expect(r.reason).toContain('claude-factory-3u1.1.1')
      expect(r.reason.toLowerCase()).toContain('tracker')
      expect(r.reason).toContain('--until')
    }
  }
})

test('gate() accepts a recipe that cites a bead with no --until', () => {
  expect(gate({ summary: 'claude-factory-3u1.1.1 taught us this', body: 'b', kind: 'recipe' })).toEqual({
    ok: true,
  })
})

test('gate() accepts a fact or rule note that cites a bead when --until is a valid bead id', () => {
  expect(
    gate({
      summary: 'claude-factory-3u1.1.1 taught us this',
      body: 'b',
      kind: 'fact',
      until: 'claude-factory-3u1.1.1',
    }),
  ).toEqual({ ok: true })
})

test('gate() accepts a note that cites nothing, with no --until', () => {
  expect(gate({ summary: 's', body: 'b', kind: 'fact' })).toEqual({ ok: true })
})

test('gate() refuses an invalid --until value even on a note that cites nothing', () => {
  const r = gate({ summary: 's', body: 'b', kind: 'fact', until: 'soon' })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.flag).toBe('--until')
    expect(r.reason).toContain('soon')
  }
})

test('gate() is pure: the same input always returns the same decision', () => {
  const n = { summary: 'claude-factory-3u1.1.1', body: 'b', kind: 'fact' as const }
  expect(gate(n)).toEqual(gate(n))
})
