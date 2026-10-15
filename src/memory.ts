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
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// A factory's shared memory: what its workers learned, three levels deep so a brief stays short and a
// search finds the rest.
//   CORE.md              the few lessons nearly every run needs: every brief carries it whole
//   <topic>/README.md    what the topic covers, then its notes in order of importance: briefs list topics
//   <topic>/<note>.md    one learning each, found by `factory memory search`
//   inbox/<note>.md      new notes, until the dream files them under a topic
// The dream (`factory dream`) grooms it daily. The folder is its own git repo, so every pass can be undone.

// A note's tier: short (one worker's note, in <topic>/<slug>.md or inbox/), long (a merged lesson, in
// <topic>/LONG.md, one entry per `## ` heading), fact (a distilled CORE.md bullet). search ranks higher
// tiers above short notes with TIER_BONUS, because they already survived a dream's judgment.
export type Tier = 'short' | 'long' | 'fact'
export type Note = {
  path: string
  summary: string
  rig?: string
  from?: string
  at?: string
  body: string
  tier?: Tier
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
  }
}

export const format = (n: Omit<Note, 'path'>) =>
  [
    '---',
    `summary: ${n.summary.replace(/\n/g, ' ')}`,
    ...(n.rig ? [`rig: ${n.rig}`] : []),
    ...(n.from ? [`from: ${n.from}`] : []),
    ...(n.at ? [`at: ${n.at}`] : []),
    '---',
    n.body.trim(),
    '',
  ].join('\n')

/** one entry inside a topic's LONG.md. A dream merges several short notes into one entry like this. */
export type LongEntry = { id: string; summary: string; rig?: string; from?: string; at?: string; body: string }

const LONG_HEADER = '---\ntier: long\n---\n'
const longEntryText = (e: LongEntry) =>
  [
    `## ${e.summary.replace(/\n/g, ' ')}`,
    `<!-- id: ${e.id}${e.rig ? ` rig: ${e.rig}` : ''}${e.from ? ` from: ${e.from}` : ''}${e.at ? ` at: ${e.at}` : ''} -->`,
    '',
    e.body.trim(),
    '',
  ].join('\n')

/** a topic's LONG.md, serialized: frontmatter `tier: long`, then one `## summary` + id comment per entry */
export const formatLong = (entries: LongEntry[]) => [LONG_HEADER, ...entries.map(longEntryText)].join('\n')

const LONG_ID = /^<!--\s*id:\s*(\S+)(?:\s+rig:\s*(\S+))?(?:\s+from:\s*(\S+))?(?:\s+at:\s*(\S+))?\s*-->\s*$/

/** a topic's LONG.md, parsed back into its entries: parseLong(formatLong(x)) === x */
export function parseLong(text: string): LongEntry[] {
  const body = text.startsWith(LONG_HEADER) ? text.slice(LONG_HEADER.length) : text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  return body
    .split(/\n(?=## )/)
    .filter(part => part.startsWith('## '))
    .map(part => {
      const lines = part.split('\n')
      const summary = lines[0]!.slice(3).trim()
      const m = LONG_ID.exec(lines[1] ?? '')
      const rest = (m ? lines.slice(2) : lines.slice(1)).join('\n').replace(/^\n/, '')
      return {
        id: m?.[1] ?? slug(summary),
        summary,
        rig: m?.[2],
        from: m?.[3],
        at: m?.[4],
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
      return { note: n, score: t ? (1 - TOPIC_WEIGHT) * own + TOPIC_WEIGHT * dot(t, query) : own }
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

export async function search(
  dir: string,
  query: string,
  { rig, limit = 5 }: { rig?: string; limit?: number } = {},
) {
  const { notes, topics } = walk(dir)
  const vec = await vectors(dir, [...notes, ...topics.values()])
  const [q] = await embed([QUERY + query])
  return close(
    rank(notes, vec, t => (topics.has(t) ? vec(topics.get(t)!) : undefined), q!, rig),
    limit,
  )
}

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

// How notes get used. A search shows a note. A worker says it helped. The dream orders notes by this.
// `runs` counts the distinct runs or stations that helped a note (its `by`). For an older line with no
// `by`, it counts the distinct UTC day instead. decide()'s promote threshold reads `runs`.
export type Use = { path: string; shown: number; helped: number; at: number; runs: number }
const usageFile = (dir: string) => join(dir, '.usage.jsonl')
/** appended only while workers search, one short line each, so concurrent writers do not interleave */
export const use = (
  dir: string,
  paths: string[],
  kind: 'shown' | 'helped',
  at = Date.now(),
  by?: string,
) => {
  if (paths.length)
    appendFileSync(
      usageFile(dir),
      paths.map(path => JSON.stringify({ path, [kind]: 1, at, ...(by ? { by } : {}) })).join('\n') + '\n',
    )
}
/** each note's totals, under the name the dream gave it. compact() folds old lines into one with `runs` set, already counted; this adds only what is new since. */
export const tally = (lines: string[], renamed: Record<string, string> = {}) => {
  const out = new Map<string, { path: string; shown: number; helped: number; at: number; runsBase: number; keys: Set<string> }>()
  for (const line of lines.filter(Boolean)) {
    const u: Partial<Use> & { path: string; at: number; by?: string } = JSON.parse(line)
    const path = renamed[u.path] ?? u.path
    const t = out.get(path) ?? { path, shown: 0, helped: 0, at: 0, runsBase: 0, keys: new Set<string>() }
    t.shown += u.shown ?? 0
    t.helped += u.helped ?? 0
    t.at = Math.max(t.at, u.at)
    if (typeof u.runs === 'number') t.runsBase += u.runs
    else t.keys.add(u.by ?? day(u.at))
    out.set(path, t)
  }
  const result = new Map<string, Use>()
  for (const [path, t] of out)
    result.set(path, { path, shown: t.shown, helped: t.helped, at: t.at, runs: t.runsBase + t.keys.size })
  return result
}
export const usage = (dir: string, renamed?: Record<string, string>) =>
  tally(existsSync(usageFile(dir)) ? readFileSync(usageFile(dir), 'utf8').split('\n') : [], renamed)

/** a note's path, inside its topic's LONG.md when it has a `#id` suffix */
export function noteExists(dir: string, path: string): boolean {
  const i = path.indexOf('#')
  if (i < 0) return existsSync(join(dir, path))
  const file = join(dir, path.slice(0, i))
  return existsSync(file) && parseLong(readFileSync(file, 'utf8')).some(e => e.id === path.slice(i + 1))
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
  for (const seen = new Set<string>(); map[p] && map[p] !== p && !seen.has(p); ) {
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
  const kept = [...usage(dir, resolved).values()].filter(u => noteExists(dir, u.path))
  writeFileSync(`${usageFile(dir)}.tmp`, kept.map(u => JSON.stringify(u) + '\n').join(''))
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
const PROMOTE_HELPED = 3 // a long entry helped at least this often...
const PROMOTE_RUNS = 3 // ...across at least this many distinct runs, becomes a promotion candidate

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
  | { kind: 'promote'; path: string; reason: string }
  | { kind: 'dedupe'; a: string; b: string; reason: string }

/** the tiering pass's plan. No fs, no clock. Every boundary (7, 30 days; 3 helps or runs) is a table test. */
export function decide(
  short: ShortCandidate[],
  long: LongCandidate[],
  sims: SimPair[] = [],
): Decision[] {
  const decisions: Decision[] = []
  for (const n of short) {
    if (n.topic === 'inbox') continue // the dream files these; decide() never touches them
    if (n.superseded) {
      decisions.push({ kind: 'archive', path: n.path, reason: `superseded by ${n.superseded}` })
      continue
    }
    if (n.helped === 0 && n.staleDays >= ARCHIVE_STALE_DAYS) {
      decisions.push({
        kind: 'archive',
        path: n.path,
        reason: `never helped, unused for ${Math.floor(n.staleDays)} days`,
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
    if (s.score >= SAME) decisions.push({ kind: 'dedupe', a: s.a, b: s.b, reason: `similarity ${s.score.toFixed(2)}` })
  return decisions
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

export const dreamPrompt = (
  dir: string,
  journal: string[],
  uses: string[],
  closed: string[],
  manager: { activity: string[]; skills: string[] } = { activity: [], skills: [] },
) => `You are the factory's dream: you groom its shared memory in ${dir} while no worker needs you. Workers read CORE.md in every brief, see one line per topic, and find notes by semantic search over each note's summary and body, ranked with its topic's README. Groom it so that retrieval finds the right note and the most important comes first.

The structure, three levels:
- CORE.md: the lessons nearly every run needs, most important first, verified; link nothing, say it. Its top holds for every rig; a \`## rig: <name>\` section holds what nearly every run in that rig needs, and only that rig's workers read it. Every worker re-reads it on every turn, so each part (the top, each rig section) stays under ${CORE_BUDGET} bytes, one short line per lesson (at most 200 characters: the rule, not its story; the story goes in a note). Briefs cut a part at that budget, so what is past it is lost to them: move detail into topic notes, which search finds.
- <topic>/README.md: frontmatter \`summary:\` one line saying what the topic covers (briefs show it), then the topic's notes listed most important first, one line each.
- <topic>/<note>.md: one learning each, frontmatter summary (one line a search can match), rig (only when it holds for one repo), from, at; then the body: what, why, how it was verified. Topics are short kebab-case names (beads, herdr, ci, fabriek-deploy); keep them few, 3 to 15 notes each.
- inbox/: new notes from workers. Empty it every pass.
A lesson that holds only while some bead is open (an owner's hold, a pending decision, a known outage) names that bead ("until fab-8aq4 closes") and never goes in CORE.md: when the bead closes, it is retired.
A note about one bead's own status (already fixed on main, a duplicate of another, still live at HEAD) is not memory: it belongs in that bead's comments. Drop it, unless it teaches something about how to tell (how to check that a bead is already done, say).

This pass:
1. File every inbox note under a topic (git mv, or write a new file and git rm the old one). One that says what an existing note says: merge it into that note and git rm it.
2. Merge duplicates anywhere; when two notes disagree, keep what the newer evidence shows and say so. Remove what is wrong, stale, or so specific to one run that no other would use it. Retire or rewrite whatever waits on a bead in "Closed beads" below. A note never shown in a search for 30 days and never helping is a candidate to drop, unless it is newer than that.
3. Read the run journal below for lessons no note holds yet: a station that failed for a reason the next worker could have avoided, a fix that worked, a review finding that recurs, a person's decision later runs should follow. Write each as a note. Skip the routine.
4. Rewrite each touched topic's README and CORE.md so their order is by importance: what helped workers most (Usage below) first, then what holds most broadly. A note that keeps helping belongs higher, its lesson in CORE.md when it holds for every rig.
5. Manager skills, proposed in ${skillSources(dir)} (the manager reviews each new, changed or reaped one and installs it or not; a rejection comes back to you as an inbox note): the manager is the Claude session that runs the factory for the person; Manager activity below is what it was asked and what it ran. Where it did the same multi-step work three or more times (the same sequence of commands to triage a stuck station, answer one kind of worker question, check a rig, start work), write it a skill so it need not work it out again: <name>/SKILL.md, a kebab-case name, frontmatter \`name:\` and \`description:\` (one line saying when to use it: the manager picks skills by it), then the steps with the exact commands, what to look for and what to decide. Fold what the activity shows into an existing skill rather than writing a near copy. Reap (git rm -r) a skill that no longer fits how the factory works, or that the manager has not used in 30 days and is older than that (Skill uses below). Write no skill for one-off work.
Work only in ${dir} (Read, Write, Edit, mkdir, git mv, git rm, git rm -r a reaped skill); the factory commits what you leave. Finish with one paragraph saying what you changed.

## Manager skills (name: uses, last used: description)
${manager.skills.join('\n') || '(none yet)'}

## Manager activity since the last dream
${manager.activity.join('\n') || '(nothing new)'}

## Usage (helped: a worker said the note helped; shown: a search returned it)
${uses.join('\n') || '(no notes yet)'}

## Closed beads this memory names
${closed.join('\n') || '(none)'}

## Run journal since the last dream (run, rig, station#attempt outcome: report)
${journal.join('\n') || '(nothing new)'}`
