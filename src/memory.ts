import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// A factory's shared memory: what its workers learned, tiered so a brief stays short and a search finds
// the rest.
//   CORE.md              fact/behavior tier: the few lessons nearly every run needs, every brief carries it whole
//   <topic>/README.md    what the topic covers, then its notes in order of importance: briefs list topics
//   <topic>/LONG.md      long tier: lessons merged from several short notes, one `## ` heading each
//   <topic>/<note>.md    short tier: one worker's learning, found by `factory memory search`
//   inbox/<note>.md      new notes, until the dream files them under a topic
//   .archive/<topic>.md  notes a tiering pass dropped: stale, never helped, or marked superseded
// The dream (`factory dream`) files the inbox and writes notes daily; `factory memory compact` (which it
// also runs itself, unless FACTORY_MEMORY_TIERS=0) does the merge-to-long and archive pass deterministically.
// The folder is its own git repo, so every pass can be undone.

// A note's tier: short (one worker's note, in <topic>/<slug>.md or inbox/), long (a merged lesson, in
// <topic>/LONG.md, one entry per `## ` heading), fact (a distilled CORE.md bullet). search ranks higher
// tiers above short notes with TIER_BONUS, because they already survived a dream's judgment.
export type Tier = 'short' | 'long' | 'fact'

// A note's kind. gate() requires it on every new add (claude-factory-3u1.1.1): fact is a verified,
// reusable lesson; rule is a convention or requirement; recipe is a working command sequence, kept
// even when it names a bead or PR. This is not Decision['kind'] below. An old note with no kind
// stays valid.
export type NoteKind = 'fact' | 'rule' | 'recipe'
export const NOTE_KINDS: readonly NoteKind[] = ['fact', 'rule', 'recipe']

export type Note = {
  path: string
  summary: string
  rig?: string
  from?: string
  at?: string
  body: string
  tier?: Tier
  kind?: NoteKind
  until?: string // frontmatter `until: <bead id | owner/repo#N | YYYY-MM-DD>`: when a cited bead/PR goes stale
  superseded?: string // frontmatter `superseded: <path>`: this note is stale, replaced by that one
}

const MODEL = 'Xenova/bge-small-en-v1.5'
const QUERY = 'Represent this sentence for searching relevant passages: ' // bge's retrieval instruction
const TOPIC_WEIGHT = 0.25 // a note's own match, lifted by its topic's: the hierarchy disambiguates short notes
// measured on fabriek's first 25 notes, summary against summary: five copies of one lesson scored
// 0.88-0.99 with each other, the closest two distinct notes 0.815 (full texts separate them less: a short
// note against a long one scored 0.89)
const SAME = 0.88
// a search's matches scored 0.80-0.88, the unrelated filler after them 0.58-0.65
// ponytail: fixed cutoffs for bge-small; recalibrate them with a different model
const FLOOR = 0.6
const SPREAD = 0.1

export const parse = (path: string, text: string): Note => {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const meta: Record<string, string> = Object.fromEntries(
    [...(m?.[1] ?? '').matchAll(/^(\w+):[ \t]*(.*)$/gm)].map(([, k, v]) => [k, v]),
  )
  const body = text.slice(m?.[0].length ?? 0).trim()
  return {
    path,
    summary: meta.summary ?? body.split('\n')[0] ?? '',
    rig: meta.rig,
    from: meta.from,
    at: meta.at,
    body,
    kind: NOTE_KINDS.includes(meta.kind as NoteKind) ? (meta.kind as NoteKind) : undefined,
    until: meta.until,
    superseded: meta.superseded,
  }
}

export const format = (n: Omit<Note, 'path'>) =>
  [
    '---',
    `summary: ${n.summary.replace(/\n/g, ' ')}`,
    ...(n.rig ? [`rig: ${n.rig}`] : []),
    ...(n.from ? [`from: ${n.from}`] : []),
    ...(n.at ? [`at: ${n.at}`] : []),
    ...(n.kind ? [`kind: ${n.kind}`] : []),
    ...(n.until ? [`until: ${n.until}`] : []),
    ...(n.superseded ? [`superseded: ${n.superseded}`] : []),
    '---',
    n.body.trim(),
    '',
  ].join('\n')

// A bead id: one or more lowercase alnum segments joined by '-', then a final '-' and a hash.
// The hash is 3-5 [a-z0-9] chars with at least one digit, plus an optional run of dotted child
// numbers. Or the hash is 3-5 letters with a required dotted child number, for example
// "acme-6kw.2". This shares its boundary guards with namesBead/citesBead in src/prs.ts. It is
// generic over any prefix, not tied to one known id. A bead id is always lowercase.
const BEAD_PREFIX = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*'
const BEAD_HASH = '(?:(?=[a-z0-9]*\\d)[a-z0-9]{3,5}(?:\\.\\d+)*|[a-z]{3,5}(?:\\.\\d+)+)'
const BEAD_ID_RE = new RegExp(`(?<![\\w.-])${BEAD_PREFIX}-${BEAD_HASH}(?![\\w-]|\\.\\w)`)
const BEAD_ID_FULL_RE = new RegExp(`^${BEAD_PREFIX}-${BEAD_HASH}$`)

// A PR reference: "PR 70", "PR#70" or "pr #70" (case insensitive on the letters only); "owner/repo#70";
// or a GitHub pull URL's "/pull/70" tail. A bare "#5" never counts: GitHub issue numbers collide with
// step numbers in run prose ("step #2").
const PR_REF_RES = [/\bPR\s?#?\d+\b/i, /[\w.-]+\/[\w.-]+#\d+/, /\/pull\/\d+/]

/**
 * Check whether text names a bead id or a PR reference. Return the first match, or null. gate()
 * uses this to demand --until on a note that names something whose status belongs in the tracker,
 * not here (claude-factory-3u1.1.1.2).
 */
export function citesTracker(text: string): string | null {
  const bead = BEAD_ID_RE.exec(text)
  if (bead) return bead[0]
  for (const re of PR_REF_RES) {
    const m = re.exec(text)
    if (m) return m[0]
  }
  return null
}

/** Is `v` a value gate() accepts for --until: a bead id, "owner/repo#N", a GitHub pull URL, or a real
 * YYYY-MM-DD calendar date (checked by round-tripping through Date, so "2026-02-30" fails)? */
export const isUntil = (v: string): boolean => {
  if (BEAD_ID_FULL_RE.test(v)) return true
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(v)) return true
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(v)) return true
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const d = new Date(`${v}T00:00:00Z`)
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3])
  )
}

export type GateResult = { ok: true } | { ok: false; flag: '--kind' | '--until'; reason: string }

/**
 * This is `factory memory add`'s write gate (claude-factory-3u1.1.1). It is a pure check: no fs,
 * clock or env access. cli.ts can call it before memory.same() spends an embedding. memory.test.ts
 * can test it with no store.
 *
 * It checks, in order: --kind is given and valid; --until, when given, is valid; a fact or rule
 * note that names a bead or PR needs --until. A recipe never needs it: a recipe's value does not
 * end when the bead or PR it names closes. --anyway only skips memory.same()'s dedupe, never this
 * gate. A worker that always adds --anyway must still pass --kind, and --until when it names a
 * bead or PR.
 */
export function gate(n: { summary: string; body: string; kind?: string; until?: string }): GateResult {
  if (!n.kind)
    return {
      ok: false,
      flag: '--kind',
      reason: `a memory note needs --kind ${NOTE_KINDS.join('|')}`,
    }
  if (!NOTE_KINDS.includes(n.kind as NoteKind))
    return {
      ok: false,
      flag: '--kind',
      reason: `--kind "${n.kind}" is not one of ${NOTE_KINDS.join('|')}`,
    }
  if (n.until !== undefined && !isUntil(n.until))
    return {
      ok: false,
      flag: '--until',
      reason: `--until "${n.until}" is not a bead id, owner/repo#N, a GitHub pull URL, or a YYYY-MM-DD date`,
    }
  const cite = n.kind === 'recipe' ? null : citesTracker(`${n.summary}\n${n.body}`)
  if (cite && !n.until)
    return {
      ok: false,
      flag: '--until',
      reason:
        `this note cites ${cite}; a bead or PR's status belongs in the tracker (bd comments, the PR), ` +
        `not here -- add --until <bead|owner/repo#N|YYYY-MM-DD>, or --kind recipe if this is a reusable recipe`,
    }
  return { ok: true }
}

/**
 * One entry inside a topic's LONG.md. A dream merges several short notes into one entry like this.
 * `aliases` lists ids a dream merged into this one by hand (point 7 of the dream prompt). longAliasRenames()
 * turns each alias into a rename, so the merged-away id's usage still counts toward this entry.
 */
export type LongEntry = {
  id: string
  summary: string
  rig?: string
  from?: string
  at?: string
  aliases?: string[]
  body: string
}

const LONG_HEADER = '---\ntier: long\n---\n'
// JSON, not `key: value` pairs split on whitespace: `from:` holds a real run id list like "r1/x, r2/y",
// commas and all, and a bare \S+ field split lost everything after the first space (claude-factory-59r.8)
const LONG_ID = /^<!--\s*id:\s*(\{.*\})\s*-->\s*$/
type LongMeta = { id: string; rig?: string; from?: string; at?: string; aliases?: string[] }
const encodeId = (e: LongEntry): string =>
  JSON.stringify({
    id: e.id,
    ...(e.rig ? { rig: e.rig } : {}),
    ...(e.from ? { from: e.from } : {}),
    ...(e.at ? { at: e.at } : {}),
    ...(e.aliases?.length ? { aliases: e.aliases } : {}),
  })
const decodeId = (line: string): LongMeta | null => {
  const m = LONG_ID.exec(line)
  if (!m) return null
  try {
    const o = JSON.parse(m[1]!)
    return o && typeof o.id === 'string' ? o : null
  } catch {
    return null
  }
}

const longEntryText = (e: LongEntry) =>
  [`## ${e.summary.replace(/\n/g, ' ')}`, `<!-- id: ${encodeId(e)} -->`, '', e.body.trim(), ''].join('\n')

/** a topic's LONG.md, serialized: frontmatter `tier: long`, then one `## summary` + id comment per entry */
export const formatLong = (entries: LongEntry[]) => [LONG_HEADER, ...entries.map(longEntryText)].join('\n')

/**
 * A topic's LONG.md, parsed back into its entries: parseLong(formatLong(x)) equals x.
 * An entry starts only at a `## ` line right before its id comment.
 * A merged note's body can hold its own `## ` markdown heading.
 * That line alone must never start a new entry (claude-factory-59r.9).
 */
export function parseLong(text: string): LongEntry[] {
  const body = text.startsWith(LONG_HEADER)
    ? text.slice(LONG_HEADER.length)
    : text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines = body.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++)
    if (lines[i]!.startsWith('## ') && decodeId(lines[i + 1] ?? '')) starts.push(i)
  return starts.map((start, idx) => {
    const end = starts[idx + 1] ?? lines.length
    const entryLines = lines.slice(start, end)
    const summary = entryLines[0]!.slice(3).trim()
    const meta = decodeId(entryLines[1]!)!
    const rest = entryLines.slice(2).join('\n').replace(/^\n/, '')
    return {
      id: meta.id,
      summary,
      rig: meta.rig,
      from: meta.from,
      at: meta.at,
      aliases: meta.aliases,
      body: rest.trim(),
    }
  })
}

/** every note, with its topic's README beside it: the dot folders (.git, the index, .archive) are not memory */
export function walk(dir: string) {
  const notes: Note[] = []
  const topics = new Map<string, Note>()
  if (!existsSync(dir)) return { notes, topics }
  for (const topic of readdirSync(dir, { withFileTypes: true })) {
    if (!topic.isDirectory() || topic.name.startsWith('.')) continue
    for (const f of readdirSync(join(dir, topic.name))) {
      if (!f.endsWith('.md')) continue
      const text = readFileSync(join(dir, topic.name, f), 'utf8')
      if (f === 'LONG.md') {
        for (const e of parseLong(text))
          notes.push({
            path: `${topic.name}/LONG.md#${e.id}`,
            summary: e.summary,
            rig: e.rig,
            from: e.from,
            at: e.at,
            body: e.body,
            tier: 'long',
          })
        continue
      }
      const n = parse(join(topic.name, f), text)
      if (f === 'README.md') topics.set(topic.name, n)
      else notes.push({ ...n, tier: 'short' })
    }
  }
  return { notes, topics }
}

export const topicOf = (n: Note) => dirname(n.path)
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)
// a higher tier already survived a dream's judgment, so it outranks a short note at a near-equal match;
// a short note still wins a search its tier mate loses outright (see the memory-long-0.005-vs-0.02 test)
export const TIER_BONUS: Record<Tier, number> = { short: 0, long: 0.01, fact: 0.02 }
/** a note of another rig never comes up; a note with no rig holds everywhere */
export const rank = (
  notes: Note[],
  vec: (n: Note) => number[],
  topicVec: (topic: string) => number[] | undefined,
  query: number[],
  rig?: string,
) =>
  notes
    .filter(n => !n.rig || !rig || n.rig === rig)
    .map(n => {
      const own = dot(vec(n), query)
      const t = topicVec(topicOf(n))
      const base = t ? (1 - TOPIC_WEIGHT) * own + TOPIC_WEIGHT * dot(t, query) : own
      return { note: n, score: base + TIER_BONUS[n.tier ?? 'short'] }
    })
    .sort((a, b) => b.score - a.score)

let embedder: ((texts: string[], o: object) => Promise<{ tolist(): number[][] }>) | undefined
async function embed(texts: string[]) {
  if (!texts.length) return []
  // loaded on first use only: every other command, the tick above all, never pays for the model
  const { pipeline } = await import('@huggingface/transformers')
  embedder ??= (await pipeline('feature-extraction', MODEL, { dtype: 'q8' })) as unknown as typeof embedder
  // in batches: one batch of hundreds of 512-token texts took GBs and minutes, 32 at a time ~3 s each
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 32)
    out.push(...(await embedder!(texts.slice(i, i + 32), { pooling: 'cls', normalize: true })).tolist())
  return out
}

type Index = { model: string; vecs: Record<string, { hash: string; vec: number[] }> }
const textOf = (n: Note) => `${n.summary}\n${n.body}`.slice(0, 2000) // bge reads 512 tokens
const hashOf = (text: string) => createHash('sha1').update(text).digest('hex')

/** the notes' vectors, embedding only what changed since the last search */
async function vectors(dir: string, all: Note[], text = textOf, name = '.index.json') {
  const file = join(dir, name)
  const old: Index = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { model: MODEL, vecs: {} }
  const prev = old.model === MODEL ? old.vecs : {}
  const stale = all.filter(n => prev[n.path]?.hash !== hashOf(text(n)))
  const fresh = await embed(stale.map(text))
  const vecs = Object.fromEntries(
    all.map(n => {
      const i = stale.indexOf(n)
      return [n.path, i < 0 ? prev[n.path]! : { hash: hashOf(text(n)), vec: fresh[i]! }]
    }),
  )
  if (stale.length || Object.keys(prev).length !== all.length) {
    writeFileSync(`${file}.tmp`, JSON.stringify({ model: MODEL, vecs }))
    renameSync(`${file}.tmp`, file) // two searches at once: the last one's cache wins, both are right
  }
  return (n: Note) => vecs[n.path]!.vec
}

/** each bullet in CORE.md, as its own fact note: path CORE.md#<8 hex of its sha1>, rig from its `## rig:` section */
export function coreNotes(dir: string): Note[] {
  const file = join(dir, 'CORE.md')
  if (!existsSync(file)) return []
  let rig: string | undefined
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(line => {
      const h = /^##\s+rig:\s*(\S+)/.exec(line)
      if (h) {
        rig = h[1]
        return []
      }
      if (/^##\s/.test(line)) {
        rig = undefined
        return []
      }
      const m = /^-\s+(.*\S)\s*$/.exec(line)
      if (!m || m[1]!.startsWith('(cut:')) return []
      const summary = m[1]!
      const id = createHash('sha1').update(summary).digest('hex').slice(0, 8)
      return [{ path: `CORE.md#${id}`, summary, rig, body: summary, tier: 'fact' as const }]
    })
}

export async function search(
  dir: string,
  query: string,
  { rig, limit = 5 }: { rig?: string; limit?: number } = {},
) {
  const { notes, topics } = walk(dir)
  const all = [...notes, ...coreNotes(dir)]
  const vec = await vectors(dir, [...all, ...topics.values()])
  const [q] = await embed([QUERY + query])
  return close(
    rank(all, vec, t => (topics.has(t) ? vec(topics.get(t)!) : undefined), q!, rig),
    limit,
  )
}

/**
 * one line of a fixed query set. `expect` is a substring of the path or the summary of the note that the
 * search for `query` must surface: summary text survives a merge into LONG.md, where the path does not.
 */
export type EvalCase = { query: string; expect: string; rig?: string }
export type EvalResult = {
  recall: number // the fraction of cases where `expect` was somewhere in the results
  mrr: number // the mean of 1/rank over every case; 0 for a case that missed entirely
  misses: EvalCase[]
}

/** pure: scores a fixed query set against results already searched for, so a test needs no search() call */
export function evalScore(cases: EvalCase[], results: string[][]): EvalResult {
  let hits = 0
  let rrSum = 0
  const misses: EvalCase[] = []
  cases.forEach((c, i) => {
    const rank = (results[i] ?? []).findIndex(path => path.includes(c.expect))
    if (rank < 0) {
      misses.push(c)
      return
    }
    hits++
    rrSum += 1 / (rank + 1)
  })
  return {
    recall: cases.length ? hits / cases.length : 1,
    mrr: cases.length ? rrSum / cases.length : 1,
    misses,
  }
}

/** runs the fixed query set against the real store and scores it: what `factory memory eval` reports */
export async function evaluate(dir: string, cases: EvalCase[], limit = 5): Promise<EvalResult> {
  const results: string[][] = []
  for (const c of cases)
    results.push(
      (await search(dir, c.query, { rig: c.rig, limit })).map(f => `${f.note.path} ${f.note.summary}`),
    )
  return evalScore(cases, results)
}

/** where the fixed query set lives: committed to the memory's own git repo, so it tracks the store it tests */
export const evalFile = (dir: string) => join(dir, '.eval.jsonl')
export const readEvalCases = (dir: string): EvalCase[] =>
  existsSync(evalFile(dir))
    ? readFileSync(evalFile(dir), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []

/** the matches, not the filler: what scores near the best and above the floor */
export const close = <T extends { score: number }>(ranked: T[], limit: number) =>
  ranked.filter(r => r.score >= Math.max(FLOOR, (ranked[0]?.score ?? 0) - SPREAD)).slice(0, limit)

/** the note that already says this, if one does: the same lesson, by a worker who did not search first */
export async function same(dir: string, note: Pick<Note, 'summary' | 'rig'>) {
  const { notes } = walk(dir)
  // cached like the full-text vectors: embedding every summary on each add took minutes past 400 notes,
  // and the tick that replays a VM worker's add was killed before it finished, every tick
  const vec = await vectors(dir, notes, n => n.summary, '.index.json.summaries')
  const [v] = await embed([note.summary])
  const best = notes
    .filter(n => !n.rig || !note.rig || n.rig === note.rig)
    .map(n => ({ note: n, score: dot(vec(n), v!) }))
    .sort((a, b) => b.score - a.score)[0]
  return best && best.score >= SAME ? best : null
}

/**
 * Near-duplicate long entries. Uses the same summary vectors and SAME cutoff as same(). Scores every
 * pair within one topic and rig. No rig on either side counts as the same rig: that entry holds for
 * every rig. The dream prompt lists the results as possible duplicates. This function merges nothing:
 * a merge needs judgment about which id and wording survive.
 */
export async function longSimPairs(dir: string): Promise<SimPair[]> {
  const { notes } = walk(dir)
  const long = notes.filter(n => n.tier === 'long')
  if (long.length < 2) return []
  const vec = await vectors(dir, long, n => n.summary, '.index.json.summaries')
  const groups = new Map<string, Note[]>()
  for (const n of long) {
    const key = `${topicOf(n)}::${n.rig ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), n])
  }
  const pairs: SimPair[] = []
  for (const g of groups.values())
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        const score = dot(vec(g[i]!), vec(g[j]!))
        if (score >= SAME) pairs.push({ a: g[i]!.path, b: g[j]!.path, score })
      }
  return pairs
}

/**
 * decide()'s promote and dedupe candidates among the long tier, worded for the dream prompt. A path
 * alone means little to the dream, so each line also carries its entry's summary.
 */
export async function tierCandidates(dir: string): Promise<{ promotions: string[]; duplicates: string[] }> {
  const { notes } = walk(dir)
  const long = notes.filter(n => n.tier === 'long')
  const uses = usage(dir)
  const summaryOf = (path: string) => long.find(n => n.path === path)?.summary ?? path
  const candidates: LongCandidate[] = long.map(n => {
    const u = uses.get(n.path)
    return { path: n.path, helped: u?.helped ?? 0, runs: u?.runs ?? 0 }
  })
  const decisions = decide([], candidates, await longSimPairs(dir))
  return {
    promotions: decisions
      .filter(d => d.kind === 'promote')
      .map(d => `- ${d.path} (${summaryOf(d.path)}): ${d.reason}`),
    duplicates: decisions
      .filter(d => d.kind === 'dedupe')
      .map(d => `- ${d.a} (${summaryOf(d.a)}) vs ${d.b} (${summaryOf(d.b)}): ${d.reason}`),
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'note'

/** a new note goes to the inbox; the dream files it */
export function add(dir: string, note: Omit<Note, 'path'>) {
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  const base = join(dir, 'inbox', slug(note.summary))
  let file = `${base}.md`
  for (let i = 2; existsSync(file); i++) file = `${base}-${i}.md`
  writeFileSync(file, format(note))
  return file
}

/** bytes each part of CORE.md (its top, a rig's section) may put in a brief: every worker turn re-reads it */
export const CORE_BUDGET = 2500

/**
 * CORE.md for one rig: what holds everywhere, and its own `## rig: <name>` section; other rigs' go. Each
 * part is cut at CORE_BUDGET, most important first being the dream's job, so it can never grow every brief
 */
export function coreFor(text: string, rig?: string) {
  let section: string | null = null
  const used = new Map<string | null, number>()
  const kept = text.split('\n').flatMap(line => {
    const m = /^##\s+rig:\s*(\S+)/.exec(line)
    if (m) section = m[1]!
    else if (/^##\s/.test(line)) section = null
    if (section !== null && section !== rig) return []
    const was = used.get(section) ?? 0
    used.set(section, was + line.length + 1)
    if (was + line.length + 1 <= CORE_BUDGET) return [line]
    return was <= CORE_BUDGET ? ['- (cut: over the budget; memory search finds the rest)'] : []
  })
  return kept.join('\n').trim()
}

/** level 0 and level 1, for a brief: the core in full, then one line per topic */
export function outline(dir: string, rig?: string) {
  const core = existsSync(join(dir, 'CORE.md'))
    ? coreFor(readFileSync(join(dir, 'CORE.md'), 'utf8'), rig)
    : ''
  const { notes, topics } = walk(dir)
  const count = (t: string) => notes.filter(n => topicOf(n) === t).length
  const lines = [...new Set([...topics.keys(), ...notes.map(topicOf)])]
    .filter(t => t !== 'inbox')
    .sort()
    .map(t => `- ${t} (${count(t)}): ${topics.get(t)?.summary ?? ''}`.trimEnd())
  const inbox = count('inbox')
  return { core, topics: inbox ? [...lines, `- inbox (${inbox}): new notes, not yet filed`] : lines }
}

export const inboxCount = (dir: string) => walk(dir).notes.filter(n => topicOf(n) === 'inbox').length
/** all of it as one text, to find the beads it names */
export const corpus = (dir: string) =>
  [
    existsSync(join(dir, 'CORE.md')) ? readFileSync(join(dir, 'CORE.md'), 'utf8') : '',
    ...[...walk(dir).topics.values(), ...walk(dir).notes].map(n => `${n.summary}\n${n.body}`),
  ].join('\n')

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
// a `by` field holds `<run id>/<station>`. Use only the run id as the key. Two stations of one run must
// count as one run (claude-factory-59r.16: "r1/verify" and "r1/implement" used to count as 2 runs).
const runKey = (by: string | undefined, at: number) => (by ? by.split('/')[0]! : day(at))

// How notes get used. A search shows a note. A worker says it helped. The dream orders notes by this.
// `runs` counts the distinct runs that helped a note (its `by`, up to the first `/`). For an older line
// with no `by`, it counts the distinct UTC day instead. decide()'s promote threshold reads `runs`.
export type Use = {
  path: string
  shown: number
  helped: number
  confirmed: number
  contradicted: number
  at: number
  runs: number
}
const usageFile = (dir: string) => join(dir, '.usage.jsonl')
/**
 * appended only while workers search, one short line each, so concurrent writers do not interleave.
 * 'confirmed' is a duplicate `memory add` hit on an existing note (claude-factory-3u1.1.2: FR-008,
 * replacing the old 'helped' log there, which inflated helped on a note nobody read). 'contradicted'
 * is a note a `--supersedes` write marks stale.
 */
export const use = (
  dir: string,
  paths: string[],
  kind: 'shown' | 'helped' | 'confirmed' | 'contradicted',
  at = Date.now(),
  by?: string,
) => {
  if (paths.length)
    appendFileSync(
      usageFile(dir),
      paths.map(path => JSON.stringify({ path, [kind]: 1, at, ...(by ? { by } : {}) })).join('\n') + '\n',
    )
}
type RawTally = {
  path: string
  shown: number
  helped: number
  confirmed: number
  contradicted: number
  at: number
  runsBase: number
  keys: Set<string>
}
/**
 * each note's raw totals, keys kept apart from their count. compact() must persist the keys themselves,
 * not only how many there were (claude-factory-59r.17): a folded line that kept only `runs: 2` cannot
 * tell a later line's run id was one it already counted, so that run got counted again.
 */
function tallyRaw(lines: string[], renamed: Record<string, string> = {}): Map<string, RawTally> {
  const out = new Map<string, RawTally>()
  for (const line of lines.filter(Boolean)) {
    const u: Partial<Use> & { path: string; at: number; by?: string; keys?: string[] } = JSON.parse(line)
    const path = renamed[u.path] ?? u.path
    const t = out.get(path) ?? {
      path,
      shown: 0,
      helped: 0,
      confirmed: 0,
      contradicted: 0,
      at: 0,
      runsBase: 0,
      keys: new Set<string>(),
    }
    t.shown += u.shown ?? 0
    t.helped += u.helped ?? 0
    t.confirmed += u.confirmed ?? 0
    t.contradicted += u.contradicted ?? 0
    t.at = Math.max(t.at, u.at)
    if (Array.isArray(u.keys)) for (const k of u.keys) t.keys.add(k)
    else if (typeof u.runs === 'number')
      t.runsBase += u.runs // a pre-claude-factory-59r.17 folded line: no keys to recover
    else t.keys.add(runKey(u.by, u.at))
    out.set(path, t)
  }
  return out
}
/** each note's totals, under the name the dream gave it. compact() folds old lines into one with `runs` set, already counted; this adds only what is new since. */
export const tally = (lines: string[], renamed: Record<string, string> = {}) => {
  const result = new Map<string, Use>()
  for (const [path, t] of tallyRaw(lines, renamed))
    result.set(path, {
      path,
      shown: t.shown,
      helped: t.helped,
      confirmed: t.confirmed,
      contradicted: t.contradicted,
      at: t.at,
      runs: t.runsBase + t.keys.size,
    })
  return result
}
export const usage = (dir: string, renamed?: Record<string, string>) =>
  tally(existsSync(usageFile(dir)) ? readFileSync(usageFile(dir), 'utf8').split('\n') : [], renamed)

/**
 * A note's path: a short note's file, a LONG.md entry's `#id`, or a CORE.md bullet's `#<hash>`
 * (claude-factory-59r.12: `CORE.md#<hash>` used to fall into the LONG.md branch below, which parsed
 * CORE.md as if it held `## ` entries, found none, and always said no).
 */
export function noteExists(dir: string, path: string): boolean {
  if (path.startsWith('CORE.md#')) return coreNotes(dir).some(n => n.path === path)
  const i = path.indexOf('#')
  if (i < 0) return existsSync(join(dir, path))
  const file = join(dir, path.slice(0, i))
  if (!existsSync(file) || !statSync(file).isFile()) return false
  return parseLong(readFileSync(file, 'utf8')).some(e => e.id === path.slice(i + 1))
}

/**
 * Mark oldPath as replaced by newPath (claude-factory-3u1.1.2, FR-009's `--supersedes`).
 *
 * For a short note (a plain file path with no `#`), this function writes one frontmatter line:
 * `superseded: <newPath>`. The newPath is relative to dir, the same shape that noteExists() and
 * resolvePath() use. The function returns `{ marked: true }`, and decide() archives the note on the
 * next tiering pass with the reason "superseded by <newPath>". See the `n.superseded` branch in
 * this file.
 *
 * A LONG.md path uses `#id`. A CORE.md path uses `#hash`.
 * A CORE.md bullet is one line in CORE.md, not a frontmatter block. A LONG.md entry schema has no
 * superseded field. For either path, this function changes no file and returns `{ marked: false }`.
 *
 * The caller must log a 'contradicted' usage event for that path. claude-factory-3u1.3.3 reads that
 * event to demote a core fact.
 *
 * This function edits the frontmatter block as text. It does not use parse() and format() together.
 * The format() function writes only the fields that the Note type knows. A round trip through
 * parse() and format() drops, without a warning, any frontmatter key that this schema does not yet
 * define.
 */
export function supersede(dir: string, oldPath: string, newPath: string): { marked: boolean } {
  if (oldPath.includes('#')) return { marked: false }
  const file = join(dir, oldPath)
  const text = readFileSync(file, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const line = `superseded: ${newPath}`
  let out: string
  if (m) {
    const metaLines = m[1]!.split('\n')
    const already = metaLines.findIndex(l => /^superseded:/.test(l))
    if (already >= 0) metaLines[already] = line
    else metaLines.push(line)
    out = `---\n${metaLines.join('\n')}\n---\n${text.slice(m[0].length)}`
  } else {
    out = `---\n${line}\n---\n${text}`
  }
  writeFileSync(`${file}.tmp`, out)
  renameSync(`${file}.tmp`, file)
  return { marked: true }
}

const renamesFile = (dir: string) => join(dir, '.renames.jsonl')
/** every rename a dream or a tiering pass has ever made, oldest first: old path -> its newest known path */
function renameLog(dir: string): Record<string, string> {
  const lines = existsSync(renamesFile(dir)) ? readFileSync(renamesFile(dir), 'utf8').split('\n') : []
  const map: Record<string, string> = {}
  for (const line of lines.filter(Boolean)) {
    const r: { old: string; new: string } = JSON.parse(line)
    map[r.old] = r.new
  }
  return map
}
/** where a note lives now, following a rename chain (a -> b -> c) to its last link */
export function resolvePath(dir: string, path: string, extra: Record<string, string> = {}): string {
  const map = { ...renameLog(dir), ...extra }
  let p = path
  for (const seen = new Set<string>(); map[p] && map[p] !== p && !seen.has(p);) {
    seen.add(p)
    p = map[p]!
  }
  return p
}
/**
 * after a dream or a tiering pass. It logs `renamed`, so a later `helped <old path>` still resolves,
 * even over several dreams. Then it keeps one usage line per note left. It follows renames, and a
 * removed note's counts go with it.
 */
export function compact(dir: string, renamed: Record<string, string>) {
  if (Object.keys(renamed).length)
    appendFileSync(
      renamesFile(dir),
      Object.entries(renamed)
        .map(([old, to]) => `${JSON.stringify({ old, new: to })}\n`)
        .join(''),
    )
  const log = renameLog(dir)
  const resolved = Object.fromEntries([...new Set(Object.keys(log))].map(k => [k, resolvePath(dir, k)]))
  const lines = existsSync(usageFile(dir)) ? readFileSync(usageFile(dir), 'utf8').split('\n') : []
  const kept = [...tallyRaw(lines, resolved).values()].filter(t => noteExists(dir, t.path))
  writeFileSync(
    `${usageFile(dir)}.tmp`,
    kept
      .map(
        t =>
          `${JSON.stringify({
            path: t.path,
            shown: t.shown,
            helped: t.helped,
            confirmed: t.confirmed,
            contradicted: t.contradicted,
            at: t.at,
            runs: t.runsBase + t.keys.size,
            ...(t.keys.size ? { keys: [...t.keys] } : {}),
          })}\n`,
      )
      .join(''),
  )
  // ponytail: a search appending between the read and this rename loses its count; a lock if counts must be exact
  renameSync(`${usageFile(dir)}.tmp`, usageFile(dir))
}
/** one line per note for the dream, the unused ones included: they are what it may drop */
export const usageLines = (dir: string) => {
  const used = usage(dir)
  return walk(dir)
    .notes.filter(n => topicOf(n) !== 'inbox')
    .map(n => used.get(n.path) ?? { path: n.path, shown: 0, helped: 0, at: 0 })
    .sort((a, b) => b.helped - a.helped || b.shown - a.shown)
    .map(u =>
      u.at
        ? `- ${u.path}: helped ${u.helped}, shown ${u.shown}, last used ${day(u.at)}`
        : `- ${u.path}: never shown`,
    )
}

// Tiering, after each dream: a pure function picks what to merge, archive, promote or flag as a possible
// duplicate. It reads no file and no clock. The caller gathers every input from the real store
// (applyTiers does that). Because it is pure, a test can hit every boundary with a table and no fixture dir.
const DAY_MS = 24 * 60 * 60 * 1000
const MERGE_AGE_DAYS = 7 // a short note waits this long before it can merge: a fresh note may still be wrong
const ARCHIVE_STALE_DAYS = 30 // never shown or helped in this long, and this old: a candidate to archive
const ARCHIVE_NEW_DAYS = 14 // never shown at all, and this old: a candidate too, once usage history is old enough to trust "never shown"
// at most this many archives in one tiering pass, oldest (by ageDays) first: a long-idle home must not
// dump every stale note into .archive the moment it crosses ARCHIVE_NEW_DAYS or ARCHIVE_STALE_DAYS
// (claude-factory-503: a ~190-note mass archive at day 30 forced a revert of a 139-merge pass).
const ARCHIVE_CAP = 25
const PROMOTE_HELPED = 3 // a long entry helped at least this often...
const PROMOTE_RUNS = 3 // ...across at least this many distinct runs, becomes a promotion candidate
// a topic's short-note cap (FR-010): past this many short notes in one topic, the tier pass merges
// the oldest ones into LONG.md so the topic keeps retrieval dense; the dream drops or merges the rest
// the tier pass cannot (claude-factory-3u1.1.3).
export const TOPIC_CAP = 15

/** a short topic note (never inbox/*), with what decide() needs to judge it */
export type ShortCandidate = {
  path: string
  topic: string
  superseded?: string // frontmatter `superseded: <path>`: archive it outright
  ageDays: number // since the note's own at:, else the commit that added it
  staleDays: number // since it was last shown or helped; ageDays when it never was
  shown: number
  helped: number
}
/** a LONG.md entry, with what decide() needs to judge it */
export type LongCandidate = { path: string; helped: number; runs: number }
/** a pair of notes (short or long) whose summaries a caller already scored as near-duplicates */
export type SimPair = { a: string; b: string; score: number }

export type Decision =
  | { kind: 'merge'; path: string; reason: string }
  | { kind: 'archive'; path: string; reason: string }
  | { kind: 'held'; path: string; reason: string }
  | { kind: 'promote'; path: string; reason: string }
  | { kind: 'dedupe'; a: string; b: string; reason: string }

/**
 * The tier pass creates a plan. The plan uses no file and no clock. A table test covers each
 * boundary: 7, 14 and 30 days; 3 helps or runs; the cap.
 *
 * `opts.historyDays` sets how far back the usage log goes.
 * Below ARCHIVE_NEW_DAYS (14 days), decide() does not use either usage-based archive rule.
 * A new or lost `.usage.jsonl` file cannot show if a note was never shown or shown before the log started.
 * The default is Infinity; a caller that does not pass it keeps the old rules, without this check.
 * This check does not apply to the superseded rule. A note with `superseded:` always gets an `archive` decision.
 *
 * `opts.archiveCap` sets the top limit on notes that one pass can archive.
 * The oldest notes go first, by ageDays. decide() breaks a tie by path, in ascending order.
 * The cap applies to every topic and every archive rule, including superseded notes.
 * A note past the cap gets a `held` decision, not an `archive` decision.
 * So a long-idle home cannot send hundreds of notes to `.archive` on one day, when they all cross the threshold.
 *
 * `opts.topicCap` (FR-010) sets a per-topic cap on short notes.
 * decide() checks it last, after every other rule above.
 * If a topic holds more short notes than the cap, decide() adds `merge` decisions for its oldest notes.
 * The merges stop when the topic reaches the cap. A held note still counts toward the topic.
 *
 * A candidate note has no decision yet. It is not superseded.
 * It is at least MERGE_AGE_DAYS (7) days old.
 *
 * decide() never picks an inbox note. It never touches inbox at all.
 * The oldest candidates go first, by ageDays descending, then path ascending.
 * This is the same tie-break that the archive cap uses.
 *
 * The default is Infinity. A caller that does not pass topicCap keeps the current output.
 * This is true for most direct tests, and for every call before claude-factory-3u1.1.3.
 */
export function decide(
  short: ShortCandidate[],
  long: LongCandidate[],
  sims: SimPair[] = [],
  opts: { historyDays?: number; archiveCap?: number; topicCap?: number } = {},
): Decision[] {
  const { historyDays = Infinity, archiveCap = ARCHIVE_CAP, topicCap = Infinity } = opts
  const decisions: Decision[] = []
  for (const n of short) {
    if (n.topic === 'inbox') continue // the dream files these; decide() never touches them
    if (n.superseded) {
      decisions.push({ kind: 'archive', path: n.path, reason: `superseded by ${n.superseded}` })
      continue
    }
    if (historyDays >= ARCHIVE_NEW_DAYS && n.helped === 0 && n.staleDays >= ARCHIVE_STALE_DAYS) {
      decisions.push({
        kind: 'archive',
        path: n.path,
        reason: `never helped, unused for ${Math.floor(n.staleDays)} days`,
      })
      continue
    }
    if (historyDays >= ARCHIVE_NEW_DAYS && n.shown === 0 && n.helped === 0 && n.ageDays >= ARCHIVE_NEW_DAYS) {
      decisions.push({
        kind: 'archive',
        path: n.path,
        reason: `never shown, ${Math.floor(n.ageDays)} days old`,
      })
      continue
    }
    if ((n.shown > 0 || n.helped > 0) && n.ageDays >= MERGE_AGE_DAYS)
      decisions.push({
        kind: 'merge',
        path: n.path,
        reason: `shown or helped, ${Math.floor(n.ageDays)} days old`,
      })
  }
  for (const e of long)
    if (e.helped >= PROMOTE_HELPED && e.runs >= PROMOTE_RUNS)
      decisions.push({
        kind: 'promote',
        path: e.path,
        reason: `helped ${e.helped} times across ${e.runs} runs`,
      })
  for (const s of sims)
    if (s.score >= SAME)
      decisions.push({ kind: 'dedupe', a: s.a, b: s.b, reason: `similarity ${s.score.toFixed(2)}` })

  // the archive cap: the oldest decisions (by the note's ageDays) keep their `archive` kind; the rest
  // of this pass's archive decisions become `held`, so nothing past the cap is ever written this pass.
  type ArchiveDecision = Extract<Decision, { kind: 'archive' }>
  const ageOf = new Map(short.map(n => [n.path, n.ageDays]))
  const overCap: { d: ArchiveDecision; i: number }[] = []
  decisions.forEach((d, i) => {
    if (d.kind === 'archive') overCap.push({ d, i })
  })
  overCap.sort((x, y) => {
    const diff = (ageOf.get(y.d.path) ?? 0) - (ageOf.get(x.d.path) ?? 0)
    return diff !== 0 ? diff : x.d.path.localeCompare(y.d.path)
  })
  for (const { d, i } of overCap.slice(archiveCap))
    decisions[i] = { kind: 'held', path: d.path, reason: `over the archive cap of ${archiveCap} this pass` }

  // the topic cap (FR-010): runs last, once every other rule above has set its decision. A topic left
  // with more short notes than topicCap, after its merge and archive decisions, gets extra `merge`
  // decisions for its oldest still-undecided notes, until it is at the cap or no candidate is left.
  if (Number.isFinite(topicCap)) {
    const decided = new Set(
      decisions.filter(d => d.kind !== 'promote' && d.kind !== 'dedupe').map(d => d.path),
    )
    const byTopic = new Map<string, ShortCandidate[]>()
    for (const n of short) {
      if (n.topic === 'inbox') continue
      ;(byTopic.get(n.topic) ?? byTopic.set(n.topic, []).get(n.topic)!).push(n)
    }
    for (const [topic, topicNotes] of byTopic) {
      const removed = decisions.filter(
        d => (d.kind === 'merge' || d.kind === 'archive') && topicNotes.some(n => n.path === d.path),
      ).length
      let left = topicNotes.length - removed
      if (left <= topicCap) continue
      const candidates = topicNotes
        .filter(n => !decided.has(n.path) && !n.superseded && n.ageDays >= MERGE_AGE_DAYS)
        .sort((a, b) => b.ageDays - a.ageDays || a.path.localeCompare(b.path))
      for (const n of candidates) {
        if (left <= topicCap) break
        decisions.push({
          kind: 'merge',
          path: n.path,
          reason: `topic ${topic} over the short-note cap of ${topicCap} (${topicNotes.length} short notes)`,
        })
        decided.add(n.path)
        left--
      }
    }
  }

  return decisions
}

/**
 * one line per decision, for a dream's or a compact's log.
 * The first line is a header. Each later line reads `kind  path: reason`.
 * A dedupe decision names two notes, so its line reads `dedupe  a ~ b: reason` instead.
 * applyTiers() passes this to its caller through `opts.onPlan`, before it writes or removes anything.
 * The plan on disk then always matches what ran.
 */
export function planLines(
  decisions: Decision[],
  opts: { archiveCap: number; historyDays: number },
): string[] {
  const count = (kind: Decision['kind']) => decisions.filter(d => d.kind === kind).length
  const describe = (d: Decision) => ('path' in d ? d.path : `${d.a} ~ ${d.b}`)
  const header =
    `tier plan: ${count('merge')} merge, ${count('archive')} archive, ${count('held')} held ` +
    `(cap ${opts.archiveCap}), usage history ${Math.floor(opts.historyDays)} days`
  return [header, ...decisions.map(d => `${d.kind}  ${describe(d)}: ${d.reason}`)]
}

/** FACTORY_MEMORY_ARCHIVE_CAP, when it is a whole number >= 0; else the default ARCHIVE_CAP (25). */
function envArchiveCap(): number {
  const raw = process.env.FACTORY_MEMORY_ARCHIVE_CAP
  if (raw === undefined) return ARCHIVE_CAP
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : ARCHIVE_CAP
}

/** FACTORY_MEMORY_TOPIC_CAP, when it is a whole number >= 1; else the default TOPIC_CAP (15). */
export function envTopicCap(): number {
  const raw = process.env.FACTORY_MEMORY_TOPIC_CAP
  if (raw === undefined) return TOPIC_CAP
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : TOPIC_CAP
}

/** each topic whose count is over cap, sorted by count descending, then topic ascending (FR-010). */
function overCapFrom(counts: Map<string, number>, cap: number): { topic: string; count: number }[] {
  return [...counts]
    .filter(([, count]) => count > cap)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
}

/**
 * every topic over the short-note cap right now (FR-010), read straight from the store.
 * This counts only short notes. It never counts README.md, LONG.md or inbox/.
 * Pass the result to dreamPrompt(). A dream can then name each topic where it must merge or drop
 * notes before applyTiers() runs again.
 */
export function overCapTopics(dir: string, cap = envTopicCap()): { topic: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const n of walk(dir).notes) {
    if (n.tier !== 'short') continue
    const topic = topicOf(n)
    if (topic === 'inbox') continue
    counts.set(topic, (counts.get(topic) ?? 0) + 1)
  }
  return overCapFrom(counts, cap)
}

/** how many days of usage history the store holds: now minus the oldest note's newest recorded `at`.
 * 0 with no usage file, or when no entry ever recorded an `at` (claude-factory-503.2, AC2's guard). */
function usageHistoryDays(dir: string, now: number, uses: Map<string, Use>): number {
  const ats = [...uses.values()].map(u => u.at).filter(at => at > 0)
  return ats.length ? (now - Math.min(...ats)) / DAY_MS : 0
}

/**
 * Every rename a LONG.md entry's `aliases` field implies: an alias id now resolves to its entry's own id.
 * The dream prompt tells a dream to merge two duplicate entries by hand this way: keep the older id, add
 * the removed id to the kept entry's aliases, then delete only the removed entry's heading and body. Pass
 * this map to compact(). That makes the merged-away id's usage count toward the entry that absorbed it
 * (claude-factory-59r.11). This reads straight from the files, unlike a git-detected rename. It still
 * works even when nobody calls compact() right after the merge.
 */
export function longAliasRenames(dir: string): Record<string, string> {
  const renamed: Record<string, string> = {}
  if (!existsSync(dir)) return renamed
  for (const topic of readdirSync(dir, { withFileTypes: true })) {
    if (!topic.isDirectory() || topic.name.startsWith('.')) continue
    const file = join(dir, topic.name, 'LONG.md')
    if (!existsSync(file)) continue
    for (const e of parseLong(readFileSync(file, 'utf8')))
      for (const alias of e.aliases ?? [])
        renamed[`${topic.name}/LONG.md#${alias}`] = `${topic.name}/LONG.md#${e.id}`
  }
  return renamed
}

/** every .md file this store holds. It counts CORE.md and each topic's README, LONG.md and short notes. It skips .archive/. */
export function mdFileCount(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = existsSync(join(dir, 'CORE.md')) ? 1 : 0
  for (const topic of readdirSync(dir, { withFileTypes: true })) {
    if (!topic.isDirectory() || topic.name.startsWith('.')) continue
    n += readdirSync(join(dir, topic.name)).filter(f => f.endsWith('.md')).length
  }
  return n
}

/** when a note has no at:, its age since the commit that added it, so it ages like any other note
 * (claude-factory-59r.19b: treating it as added "now" meant it could never grow stale or merge).
 * `git log -1` gives the newest commit to touch the path. A later edit or a git mv reset the age to
 * "now" each time one ran. `--diff-filter=A` finds only the commit(s) that added the path. git log lists
 * newest first, so the last line is the oldest of those (claude-factory-59r.23). */
function gitAddedMs(dir: string, path: string): number | undefined {
  if (!existsSync(join(dir, '.git'))) return undefined
  const out = Bun.spawnSync([
    'git',
    '-C',
    dir,
    'log',
    '--follow',
    '--diff-filter=A',
    '--format=%ct',
    '--',
    path,
  ])
    .stdout.toString()
    .trim()
  const lines = out.split('\n').filter(Boolean)
  const sec = Number(lines[lines.length - 1])
  return lines.length && Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined
}

/** a merge or an archive drops <topic>/<slug>.md. A dream's own README.md may still link to it by that
 * file name. Point the link at the note's new home instead, so the topic index never dead-links
 * (claude-factory-59r.19a, and .22 for the archive branch, which has no new entry to link to). */
function rewriteReadmeLink(dir: string, topic: string, shortPath: string, target: string) {
  const readmeFile = join(dir, topic, 'README.md')
  if (!existsSync(readmeFile)) return
  const base = shortPath.slice(shortPath.lastIndexOf('/') + 1)
  const text = readFileSync(readmeFile, 'utf8')
  const updated = text.split(`(${base})`).join(`(${target})`)
  if (updated !== text) writeFileSync(readmeFile, updated)
}

/**
 * Find text a merge into this topic's LONG.md would lose.
 * The lost text is non-blank text before the first recognized entry (a `## ` line right before a valid
 * id comment). parseLong never attaches that text to any entry, so a rewrite drops it (claude-factory-59r.15).
 * A lossless difference from canonical formatLong output loses nothing. Examples: an extra blank line, a
 * missing trailing newline, or a different key order or spacing in the id JSON. Such a difference must not
 * block a merge forever (claude-factory-59r.21).
 */
function longPreambleLoss(text: string): string {
  const body = text.startsWith(LONG_HEADER)
    ? text.slice(LONG_HEADER.length)
    : text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines = body.split('\n')
  let start = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ') && decodeId(lines[i + 1] ?? '')) {
      start = i
      break
    }
  }
  return lines.slice(0, start).join('\n').trim()
}

/**
 * Every topic whose LONG.md a merge would damage: see longPreambleLoss(). Call this before the dream
 * runs, so its prompt can list each one for a worker to fix by hand (claude-factory-59r.21). applyTiers()
 * finds the same topics again, each time it tries to merge into one of them.
 */
export function unsafeLongTopics(dir: string): { topic: string; reason: string }[] {
  if (!existsSync(dir)) return []
  const out: { topic: string; reason: string }[] = []
  for (const topic of readdirSync(dir, { withFileTypes: true })) {
    if (!topic.isDirectory() || topic.name.startsWith('.')) continue
    const file = join(dir, topic.name, 'LONG.md')
    if (!existsSync(file)) continue
    const lost = longPreambleLoss(readFileSync(file, 'utf8'))
    if (lost)
      out.push({
        topic: topic.name,
        reason: `${topic.name}/LONG.md holds text before its first entry that a merge would lose: ${clip(lost, 200)}`,
      })
  }
  return out
}

/**
 * the tiering pass that follows a dream.
 * It gathers each short note's age and usage, and how many days of usage history the store holds.
 * It asks decide() what to merge, archive or hold, then does it, unless dryRun is set.
 *
 * A merge appends the note as a LONG.md entry in its topic and removes the short file.
 * An archive appends the note to .archive/<topic>.md and removes it.
 * It returns a rename map (old path -> its LONG.md#id). Pass this to compact() to log it.
 * This keeps a helped note's count.
 * `skipped` names a topic a merge left untouched, and why.
 *
 * `opts.archiveCap` sets the pass's archive cap. It falls back to FACTORY_MEMORY_ARCHIVE_CAP, then 25.
 *
 * `opts.topicCap` sets the pass's per-topic cap on short notes (FR-010).
 * It falls back to FACTORY_MEMORY_TOPIC_CAP, then to TOPIC_CAP (15).
 * The return value's `overCap` field lists each topic still over the cap at the end of the pass.
 * A skipped merge (an unsafe LONG.md) does not lower a topic's count.
 * So that topic can still appear in `overCap`.
 *
 * `opts.onPlan`, when given, runs once with planLines(). It runs right after decide(), before any
 * write or rmSync, and on a dry run too. This way, the plan a caller logs always matches what ran.
 */
export function applyTiers(
  dir: string,
  opts: {
    now?: number
    dryRun?: boolean
    archiveCap?: number
    topicCap?: number
    onPlan?: (lines: string[]) => void
  } = {},
) {
  const now = opts.now ?? Date.now()
  const { notes } = walk(dir)
  const uses = usage(dir)
  const historyDays = usageHistoryDays(dir, now, uses)
  const archiveCap = opts.archiveCap ?? envArchiveCap()
  const topicCap = opts.topicCap ?? envTopicCap()
  const short: ShortCandidate[] = notes
    .filter(n => n.tier === 'short' && topicOf(n) !== 'inbox')
    .map(n => {
      const atMs = n.at ? Date.parse(n.at) : NaN
      const createdMs = Number.isFinite(atMs) ? atMs : (gitAddedMs(dir, n.path) ?? now)
      const u = uses.get(n.path)
      const lastMs = u?.at || createdMs
      return {
        path: n.path,
        topic: topicOf(n),
        superseded: n.superseded,
        ageDays: (now - createdMs) / DAY_MS,
        staleDays: (now - lastMs) / DAY_MS,
        shown: u?.shown ?? 0,
        helped: u?.helped ?? 0,
      }
    })
  const decisions = decide(short, [], [], { historyDays, archiveCap, topicCap })
  opts.onPlan?.(planLines(decisions, { archiveCap, historyDays }))
  // a LONG.md with non-blank text before its first recognized entry (a dream's own prose, or a first
  // entry with broken id JSON) would lose that text on rewrite (claude-factory-59r.15): skip the whole
  // topic this pass, and try again later.
  const unsafe = new Map(unsafeLongTopics(dir).map(u => [u.topic, u.reason]))
  const renamed: Record<string, string> = {}
  const skippedTopics = new Set<string>()
  const skipped: { topic: string; reason: string }[] = []
  let merged = 0
  let archived = 0
  // one topic's remaining short-note count drops by one for every merge this pass writes to disk
  // (not one a skipped, unsafe LONG.md held back) and every archive; overCap below reads this.
  const removedByTopic = new Map<string, number>()
  const removeOne = (topic: string) => removedByTopic.set(topic, (removedByTopic.get(topic) ?? 0) + 1)
  for (const d of decisions) {
    if (d.kind !== 'merge' && d.kind !== 'archive') continue
    const note = notes.find(n => n.path === d.path)
    if (!note) continue
    if (d.kind === 'merge') {
      const topic = topicOf(note)
      const reason = unsafe.get(topic)
      if (reason) {
        if (!skippedTopics.has(topic)) {
          skippedTopics.add(topic)
          skipped.push({ topic, reason })
        }
        continue
      }
      const longFile = join(dir, topic, 'LONG.md')
      const rawText = existsSync(longFile) ? readFileSync(longFile, 'utf8') : null
      merged++
      removeOne(topic)
      if (opts.dryRun) continue
      const existing = rawText !== null ? parseLong(rawText) : []
      // a fresh id must not collide with an id a rename log or another entry's aliases already claim
      // for this topic: either would send its usage to the wrong entry (claude-factory-59r.18)
      const renames = renameLog(dir)
      const takenPrefix = `${topic}/LONG.md#`
      const taken = new Set<string>([
        ...existing.map(e => e.id),
        ...existing.flatMap(e => e.aliases ?? []),
        ...Object.keys(renames)
          .filter(k => k.startsWith(takenPrefix))
          .map(k => k.slice(takenPrefix.length)),
      ])
      const base = slug(note.summary)
      let id = base
      for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
      existing.push({
        id,
        summary: note.summary,
        rig: note.rig,
        from: note.from,
        at: note.at,
        body: note.body,
      })
      writeFileSync(longFile, formatLong(existing))
      rmSync(join(dir, note.path))
      renamed[note.path] = `${topic}/LONG.md#${id}`
      rewriteReadmeLink(dir, topic, note.path, `LONG.md#${id}`)
    } else {
      archived++
      const topic = topicOf(note)
      removeOne(topic)
      if (opts.dryRun) continue
      mkdirSync(join(dir, '.archive'), { recursive: true })
      const archiveFile = join(dir, '.archive', `${topic}.md`)
      const prefix = existsSync(archiveFile) ? readFileSync(archiveFile, 'utf8') : ''
      writeFileSync(
        archiveFile,
        prefix +
          format({ summary: note.summary, rig: note.rig, from: note.from, at: note.at, body: note.body }),
      )
      rmSync(join(dir, note.path))
      rewriteReadmeLink(dir, topic, note.path, `../.archive/${topic}.md`)
      // no rename logged: decide() never archives a helped note, so no helped count is owed here
    }
  }
  const held = decisions.filter(d => d.kind === 'held').length
  const totalByTopic = new Map<string, number>()
  for (const n of short) totalByTopic.set(n.topic, (totalByTopic.get(n.topic) ?? 0) + 1)
  const overCap = overCapFrom(
    new Map([...totalByTopic].map(([t, c]) => [t, c - (removedByTopic.get(t) ?? 0)])),
    topicCap,
  )
  return { decisions, renamed, merged, archived, held, skipped, archiveCap, historyDays, topicCap, overCap }
}

/** where the manager's skills live: in the memory, so the dream grooms them and git keeps every version */
export const managerDir = (dir: string) => join(dir, '.manager')
/** the dream proposes them here (Claude Code refuses an unattended write under any .claude/) */
export const skillSources = (dir: string) => join(managerDir(dir), 'skills')
/** and the manager installs the ones it accepts here, an --add-dir's .claude/skills, which its Claude watches */
export const skillsDir = (dir: string) => join(managerDir(dir), '.claude', 'skills')

const skillText = (root: string, name: string) => {
  const file = join(root, name, 'SKILL.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}
const skillNames = (root: string) =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    : []
const isSkillName = (name: string) => /^[a-z0-9][a-z0-9-]*$/.test(name)

/** what the dream proposed and the manager has not reviewed: a skill new, changed or reaped since it was installed */
export function pendingSkills(dir: string) {
  const names = [...new Set([...skillNames(skillSources(dir)), ...skillNames(skillsDir(dir))])].sort()
  return names.flatMap(name => {
    const proposed = skillText(skillSources(dir), name)
    const installed = skillText(skillsDir(dir), name)
    if (proposed === installed) return []
    const change = installed === null ? 'new' : proposed === null ? 'reaped' : 'changed'
    const description = /^description:\s*(.*)$/m.exec(proposed ?? installed ?? '')?.[1] ?? ''
    return [{ name, change, description, file: join(skillSources(dir), name, 'SKILL.md') }]
  })
}

/** the manager accepts a proposal: installed as the dream wrote it, or gone when the dream reaped it */
export function installSkill(dir: string, name: string) {
  if (!isSkillName(name) || !pendingSkills(dir).some(p => p.name === name))
    throw new Error(`no proposed skill ${name}: factory skills lists them`)
  rmSync(join(skillsDir(dir), name), { recursive: true, force: true })
  if (existsSync(join(skillSources(dir), name)))
    cpSync(join(skillSources(dir), name), join(skillsDir(dir), name), { recursive: true })
}

/** the manager refuses a proposal: what is installed stands, and the dream reads why in its inbox */
export function rejectSkill(dir: string, name: string, why: string) {
  if (!isSkillName(name) || !pendingSkills(dir).some(p => p.name === name))
    throw new Error(`no proposed skill ${name}: factory skills lists them`)
  rmSync(join(skillSources(dir), name), { recursive: true, force: true })
  if (existsSync(join(skillsDir(dir), name)))
    cpSync(join(skillsDir(dir), name), join(skillSources(dir), name), { recursive: true })
  return add(dir, {
    summary: `The manager rejected the proposed skill ${name}: ${why}`,
    from: 'manager',
    body: `Do not propose it again as it was. ${why}`,
  })
}

/** each skill's name and description, for the dream */
export function skills(dir: string) {
  const root = skillSources(dir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
    .map(d => {
      const text = readFileSync(join(root, d.name, 'SKILL.md'), 'utf8')
      return { name: d.name, description: /^description:\s*(.*)$/m.exec(text)?.[1] ?? '' }
    })
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ')
/**
 * what the manager did, from its session transcripts: what it was asked (the person, or a patrol) and the
 * commands and skills it ran, one line each, after \`since\`. Also every skill's uses, all time: what the dream reaps by
 */
export function managerActivity(lines: string[], since: number) {
  const activity: { at: number; line: string }[] = []
  const used = new Map<string, { n: number; last: number }>()
  for (const raw of lines) {
    if (!raw.includes('"type":"user"') && !raw.includes('"tool_use"')) continue
    let e: { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown } }
    try {
      e = JSON.parse(raw)
    } catch {
      continue
    }
    const at = Date.parse(e.timestamp ?? '')
    const content = e.message?.content
    const hm = new Date(at).toISOString().slice(0, 16).replace('T', ' ')
    if (e.type === 'user' && !e.isMeta && typeof content === 'string') {
      if (at > since) activity.push({ at, line: `- ${hm} asked: ${clip(content, 300)}` })
      continue
    }
    if (e.type !== 'assistant' || !Array.isArray(content)) continue
    for (const c of content as { type: string; name?: string; input?: Record<string, string> }[]) {
      if (c.type !== 'tool_use') continue
      if (c.name === 'Skill') {
        const name = c.input?.skill ?? '?'
        const u = used.get(name) ?? { n: 0, last: 0 }
        used.set(name, { n: u.n + 1, last: Math.max(u.last, at) })
      }
      if (at <= since) continue
      const what =
        c.name === 'Bash' ? c.input?.command : c.name === 'Skill' ? c.input?.skill : c.input?.file_path
      activity.push({ at, line: `- ${hm} ${c.name}: ${clip(what ?? '', 200)}` })
    }
  }
  return { activity: activity.sort((a, b) => a.at - b.at).map(a => a.line), used }
}

/**
 * `<home>/patrol-log.jsonl` lines turned into dream activity: one line per action a patrol took, plus
 * one for its report, for entries after `since`. This function skips a bad JSON line; it does not throw
 * (claude-factory-72v.6).
 */
export function patrolActivity(lines: string[], since: number): string[] {
  const out: { at: number; line: string }[] = []
  for (const raw of lines) {
    if (!raw.trim()) continue
    let e: { at?: number; actions?: string[]; report?: string }
    try {
      e = JSON.parse(raw)
    } catch {
      continue
    }
    if (!e.at || e.at <= since) continue
    const hm = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')
    for (const action of e.actions ?? []) out.push({ at: e.at, line: `- ${hm} patrol: ${clip(action, 200)}` })
    if (e.report?.trim()) out.push({ at: e.at, line: `- ${hm} patrol report: ${clip(e.report, 300)}` })
  }
  return out.sort((a, b) => a.at - b.at).map(o => o.line)
}

export const dreamPrompt = (
  dir: string,
  journal: string[],
  uses: string[],
  closed: string[],
  manager: { activity: string[]; skills: string[] } = { activity: [], skills: [] },
  promotions: string[] = [],
  duplicates: string[] = [],
  unsafe: string[] = [],
) => `You are the factory's dream: you groom its shared memory in ${dir} while no worker needs you. Workers read CORE.md in every brief, see one line per topic, and find notes by semantic search over each note's summary and body, ranked with its topic's README. Groom it so that retrieval finds the right note and the most important comes first.

The structure, three tiers:
- CORE.md: the fact-and-behavior tier. The lessons nearly every run needs, most important first, verified; link nothing, say it. Its top holds for every rig; a \`## rig: <name>\` section holds what nearly every run in that rig needs, and only that rig's workers read it. Every worker re-reads it on every turn, so each part (the top, each rig section) stays under ${CORE_BUDGET} bytes, one short line per lesson (at most 200 characters: the rule, not its story; the story goes in a note). Briefs cut a part at that budget, so what is past it is lost to them: move detail into topic notes, which search finds.
- <topic>/README.md: frontmatter \`summary:\` one line saying what the topic covers (briefs show it), then the topic's notes listed most important first, one line each.
- <topic>/LONG.md: the long tier. One merged lesson per \`## summary\` heading, followed by a comment \`<!-- id: {"id":"...", ...} -->\`. A tiering pass (\`factory memory compact\`, which runs after you finish) merges an aging, used short note in here on its own. Never change an entry's \`id\`: usage counts and renames follow it. You can still edit an entry's body, or merge two entries into one by hand (see point 7): when you do, never delete the kept id, and never remove an alias already on it.
- <topic>/<note>.md: the short tier. One learning each, frontmatter summary (one line a search can match), rig (only when it holds for one repo), from, at; then the body: what, why, how it was verified. Topics are short kebab-case names (beads, herdr, ci, fabriek-deploy); keep them few, 3 to 15 notes each.
- inbox/: new notes from workers. Empty it every pass.
A lesson that holds only while some bead is open (an owner's hold, a pending decision, a known outage) names that bead ("until fab-8aq4 closes") and never goes in CORE.md: when the bead closes, it is retired.
A note about one bead's own status (already fixed on main, a duplicate of another, still live at HEAD) is not memory: it belongs in that bead's comments. Drop it, unless it teaches something about how to tell (how to check that a bead is already done, say).

This pass:
1. File every inbox note under a topic (git mv, or write a new file and git rm the old one). One that says what an existing note says: merge it into that note and git rm it.
2. Merge duplicates anywhere; when two notes disagree, keep what the newer evidence shows and say so. Remove what is wrong, stale, or so specific to one run that no other would use it. Retire or rewrite whatever waits on a bead in "Closed beads" below. A note never shown in a search for 30 days and never helping is a candidate to drop, unless it is newer than that.
3. Read the run journal below for lessons no note holds yet: a station that failed for a reason the next worker could have avoided, a fix that worked, a review finding that recurs, a person's decision later runs should follow. Write each as a note. Skip the routine.
4. Rewrite each touched topic's README and CORE.md so their order is by importance: what helped workers most (Usage below) first, then what holds most broadly. A note that keeps helping belongs higher, its lesson in CORE.md when it holds for every rig.
5. Manager skills, proposed in ${skillSources(dir)} (the manager reviews each new, changed or reaped one and installs it or not; a rejection comes back to you as an inbox note): the manager is the Claude session that runs the factory for the person; Manager activity below is what it was asked and what it ran. Where it did the same multi-step work three or more times (the same sequence of commands to triage a stuck station, answer one kind of worker question, check a rig, start work), write it a skill so it need not work it out again: <name>/SKILL.md, a kebab-case name, frontmatter \`name:\` and \`description:\` (one line saying when to use it: the manager picks skills by it), then the steps with the exact commands, what to look for and what to decide. Fold what the activity shows into an existing skill rather than writing a near copy. Reap (git rm -r) a skill that no longer fits how the factory works, or that the manager has not used in 30 days and is older than that (Skill uses below). Write no skill for one-off work.
6. Promotion candidates below: each is a LONG.md entry that several runs have found helpful several times. Write it as one short line (under 200 characters) in CORE.md: the top when every rig needs it, else that entry's rig's \`## rig:\` section. The LONG.md entry stays as that line's detail.
7. Possible duplicates below: each pair of LONG.md entries scores as saying nearly the same thing. Merge the two into one entry: keep the older id, add the removed entry's id to the kept entry's \`"aliases"\` list in its id line's JSON (so its usage count carries over; start the list if it has none), then delete the removed entry's heading, id line and body.
8. Unsafe LONG.md files below: each holds text before its first \`## summary\` + id comment that a tiering pass cannot place in any entry, so it cannot merge a new note into that topic until you fix it. Rewrite the file by hand: either give that text its own \`## summary\` heading and an id comment, or delete it when it says nothing worth keeping.
Work only in ${dir} (Read, Write, Edit, mkdir, git mv, git rm, git rm -r a reaped skill); the factory commits what you leave. Finish with one paragraph saying what you changed.

## Manager skills (name: uses, last used: description)
${manager.skills.join('\n') || '(none yet)'}

## Manager activity since the last dream
${manager.activity.join('\n') || '(nothing new)'}

## Usage (helped: a worker said the note helped; shown: a search returned it)
${uses.join('\n') || '(no notes yet)'}

## Promotion candidates (a LONG.md entry helped across several runs: write it into CORE.md)
${promotions.join('\n') || '(none)'}

## Possible duplicates (two LONG.md entries scoring as the same lesson: merge them)
${duplicates.join('\n') || '(none)'}

## Unsafe LONG.md files (a merge cannot write into these until you fix them by hand)
${unsafe.join('\n') || '(none)'}

## Closed beads this memory names
${closed.join('\n') || '(none)'}

## Run journal since the last dream (run, rig, station#attempt outcome: report)
${journal.join('\n') || '(nothing new)'}`
