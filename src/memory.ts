import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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

export type Note = { path: string; summary: string; rig?: string; from?: string; at?: string; body: string }

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

/** every note, with its topic's README beside it: the dot folders (.git, the index) are not memory */
function walk(dir: string) {
  const notes: Note[] = []
  const topics = new Map<string, Note>()
  if (!existsSync(dir)) return { notes, topics }
  for (const topic of readdirSync(dir, { withFileTypes: true })) {
    if (!topic.isDirectory() || topic.name.startsWith('.')) continue
    for (const f of readdirSync(join(dir, topic.name))) {
      if (!f.endsWith('.md')) continue
      const n = parse(join(topic.name, f), readFileSync(join(dir, topic.name, f), 'utf8'))
      if (f === 'README.md') topics.set(topic.name, n)
      else notes.push(n)
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
  return (await embedder!(texts, { pooling: 'cls', normalize: true })).tolist()
}

type Index = { model: string; vecs: Record<string, { hash: string; vec: number[] }> }
const textOf = (n: Note) => `${n.summary}\n${n.body}`.slice(0, 2000) // bge reads 512 tokens
const hashOf = (text: string) => createHash('sha1').update(text).digest('hex')

/** the notes' vectors, embedding only what changed since the last search */
async function vectors(dir: string, all: Note[]) {
  const file = join(dir, '.index.json')
  const old: Index = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { model: MODEL, vecs: {} }
  const prev = old.model === MODEL ? old.vecs : {}
  const stale = all.filter(n => prev[n.path]?.hash !== hashOf(textOf(n)))
  const fresh = await embed(stale.map(textOf))
  const vecs = Object.fromEntries(
    all.map(n => {
      const i = stale.indexOf(n)
      return [n.path, i < 0 ? prev[n.path]! : { hash: hashOf(textOf(n)), vec: fresh[i]! }]
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
  const mine = walk(dir).notes.filter(n => !n.rig || !note.rig || n.rig === note.rig)
  // ponytail: every summary embedded on each add, ~1 s per few hundred notes; cache them beside the
  // full-text vectors if the memory grows past that
  const [v, ...vs] = await embed([note.summary, ...mine.map(n => n.summary)])
  const best = mine.map((n, i) => ({ note: n, score: dot(vs[i]!, v!) })).sort((a, b) => b.score - a.score)[0]
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

/** CORE.md for one rig: what holds everywhere, and its own `## rig: <name>` section; other rigs' go */
export function coreFor(text: string, rig?: string) {
  let section: string | null = null
  const kept = text.split('\n').filter(line => {
    const m = /^##\s+rig:\s*(\S+)/.exec(line)
    if (m) section = m[1]!
    else if (/^##\s/.test(line)) section = null
    return section === null || section === rig
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

// how notes get used, the signal the dream orders by: a search shows a note, a worker says it helped
export type Use = { path: string; shown: number; helped: number; at: number }
const usageFile = (dir: string) => join(dir, '.usage.jsonl')
/** appended only while workers search, one short line each, so concurrent writers do not interleave */
export const use = (dir: string, paths: string[], kind: 'shown' | 'helped', at = Date.now()) => {
  if (paths.length)
    appendFileSync(
      usageFile(dir),
      paths.map(path => JSON.stringify({ path, [kind]: 1, at })).join('\n') + '\n',
    )
}
/** each note's totals, under the name the dream gave it */
export const tally = (lines: string[], renamed: Record<string, string> = {}) => {
  const out = new Map<string, Use>()
  for (const line of lines.filter(Boolean)) {
    const u: Partial<Use> & { path: string; at: number } = JSON.parse(line)
    const path = renamed[u.path] ?? u.path
    const t = out.get(path) ?? { path, shown: 0, helped: 0, at: 0 }
    out.set(path, {
      path,
      shown: t.shown + (u.shown ?? 0),
      helped: t.helped + (u.helped ?? 0),
      at: Math.max(t.at, u.at),
    })
  }
  return out
}
export const usage = (dir: string, renamed?: Record<string, string>) =>
  tally(existsSync(usageFile(dir)) ? readFileSync(usageFile(dir), 'utf8').split('\n') : [], renamed)
/** after a dream: one line per note left, renames followed; a removed note's counts go with it */
export function compact(dir: string, renamed: Record<string, string>) {
  const kept = [...usage(dir, renamed).values()].filter(u => existsSync(join(dir, u.path)))
  writeFileSync(`${usageFile(dir)}.tmp`, kept.map(u => JSON.stringify(u) + '\n').join(''))
  // ponytail: a search appending between the read and this rename loses its count; a lock if counts must be exact
  renameSync(`${usageFile(dir)}.tmp`, usageFile(dir))
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
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

export const dreamPrompt = (
  dir: string,
  journal: string[],
  uses: string[],
  closed: string[],
) => `You are the factory's dream: you groom its shared memory in ${dir} while no worker needs you. Workers read CORE.md in every brief, see one line per topic, and find notes by semantic search over each note's summary and body, ranked with its topic's README. Groom it so that retrieval finds the right note and the most important comes first.

The structure, three levels:
- CORE.md: the lessons nearly every run needs, most important first, verified; link nothing, say it. Its top holds for every rig (at most 15 lines); a \`## rig: <name>\` section (at most 15 lines each) holds what nearly every run in that rig needs, and only that rig's workers read it.
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
Work only in ${dir} (Read, Write, Edit, mkdir, git mv, git rm); the factory commits what you leave. Finish with one paragraph saying what you changed.

## Usage (helped: a worker said the note helped; shown: a search returned it)
${uses.join('\n') || '(no notes yet)'}

## Closed beads this memory names
${closed.join('\n') || '(none)'}

## Run journal since the last dream (run, rig, station#attempt outcome: report)
${journal.join('\n') || '(nothing new)'}`
