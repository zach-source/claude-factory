import { SECRETS, secretFile } from './homebackup'
import { TOKEN_SHAPE } from './linear'
import type { Bead } from './beads'
import type { Row } from './cli'

export type Page = {
  kind: 'rig' | 'solution' | 'topic' | 'index' | 'glossary'
  title: string
  rigs?: string[]
  beads?: string[]
  prs?: string[]
  topics?: string[]
  status?: 'current' | 'superseded' | 'stale'
  superseded_by?: string
  cause?: 'proven' | 'hypothesis'
  updated?: string
}

export const SECTIONS = [
  'Problem',
  'Cause',
  'Change',
  'Options rejected',
  'Verification',
  'Still open',
  'Links',
]
const KINDS = ['rig', 'solution', 'topic', 'index', 'glossary']
const KEYS = [
  'kind',
  'title',
  'rigs',
  'beads',
  'prs',
  'topics',
  'cause',
  'status',
  'superseded_by',
  'updated',
]
const LISTS = ['rigs', 'beads', 'prs', 'topics']
// An alias copies its scalar. A small block can thus decode to a huge page. Cap the block and refuse repeats.
const MAX_FRONTMATTER = 4096
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** `## ` heading names outside ``` fences */
const headings = (body: string) => {
  let fenced = false
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    else if (!fenced && line.startsWith('## ')) out.push(line.slice(3).trim())
  }
  return out
}

/** Validates the whole field grammar: a returned Page is valid. Each reason is a fixed string, never page text. */
export function parse(text: string): { page: Page; body: string } | { reasons: string[] } {
  const lines = text.split('\n')
  const end = lines.indexOf('---', 1)
  if (lines[0] !== '---' || end < 0) return { reasons: ['no frontmatter'] }
  const fm = lines.slice(1, end).join('\n')
  if (fm.length > MAX_FRONTMATTER) return { reasons: ['frontmatter: too long'] }
  let y: unknown
  try {
    y = Bun.YAML.parse(fm)
  } catch {
    return { reasons: ['no frontmatter'] }
  }
  if (!y || typeof y !== 'object' || Array.isArray(y)) return { reasons: ['no frontmatter'] }
  const d = y as Record<string, unknown>
  const body = lines.slice(end + 1).join('\n')
  const r: string[] = []
  if (Object.keys(d).some(k => !KEYS.includes(k))) r.push('unknown field')
  const kind = d.kind as Page['kind']
  if (!KINDS.includes(kind)) r.push('kind: invalid')
  if (!str(d.title)) r.push('title: missing')
  for (const f of LISTS) {
    const v = d[f]
    if (v !== undefined && !(Array.isArray(v) && v.every(str))) r.push(`${f}: not a string list`)
    else if (Array.isArray(v) && new Set(v).size !== v.length) r.push(`${f}: repeated entry`)
  }
  const n = (f: string) => (Array.isArray(d[f]) ? d[f].length : 0)
  if ((kind === 'rig' || kind === 'solution') && n('rigs') < 1) r.push('rigs: missing')
  if (kind === 'solution') {
    if (n('topics') < 1) r.push('topics: missing')
    if (d.cause !== 'proven' && d.cause !== 'hypothesis') r.push('cause: missing')
  } else if (d.cause !== undefined) r.push('cause: solution only')
  const st = d.status
  if (st !== undefined && !['current', 'superseded', 'stale'].includes(st as string))
    r.push('status: invalid')
  if (st === 'superseded' && !str(d.superseded_by)) r.push('superseded_by: missing')
  if (st !== 'superseded' && d.superseded_by !== undefined) r.push('superseded_by: not superseded')
  if (d.updated !== undefined && !(typeof d.updated === 'string' && STAMP.test(d.updated)))
    r.push('updated: invalid')
  if (kind === 'solution') {
    const h = headings(body)
    for (const s of SECTIONS) if (!h.includes(s)) r.push(`missing section: ${s}`)
    if (!r.some(x => x.startsWith('missing section')) && h.join('\n') !== SECTIONS.join('\n'))
      r.push('sections: order or extra')
  }
  return r.length ? { reasons: r } : { page: d as Page, body }
}

/** JSON is YAML: each value is one quoted line, so no title text can add a frontmatter line */
export function format(page: Page, body: string): string {
  const p = page as Record<string, unknown>
  const rows = KEYS.filter(k => p[k] !== undefined).map(k => `${k}: ${JSON.stringify(p[k])}`)
  return `---\n${rows.join('\n')}\n---\n${body}`
}

/** The failing pages only, in input order. A reason never holds page text. */
export function scanPages(pages: { path: string; text: string }[]): { path: string; reasons: string[] }[] {
  const out: { path: string; reasons: string[] }[] = []
  for (const { path, text } of pages) {
    const reasons: string[] = []
    const p = parse(text)
    // YAML escapes decode in parse(), so scan the raw text and the decoded fields
    const decoded = 'page' in p ? Object.values(p.page).flat().join('\n') : ''
    if (secretFile(Buffer.from(text)) || secretFile(Buffer.from(decoded))) reasons.push('secret shape')
    if ('reasons' in p) reasons.push(...p.reasons)
    if (reasons.length) out.push({ path, reasons })
  }
  return out
}

export type RigRow = Row & { createdAt: number }
export type Merged = { url: string; title: string; mergedAt: number; solution?: string }

const WEEK = 7 * 24 * 3600_000
const live = (r: Row) => r.node !== 'done' && r.node !== 'aborted'
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const strip = (s: string) => s.replace(/^[\w.-]+#\d+ [\w-]+:\s*/, '')
const sentence = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  const m = t.match(/^(.*?)[.!?](?=\s|$)/)
  return (m?.[1] ?? t.replace(/[.!?]+$/, '')).trim()
}
const dot = (s: string) => (s ? ` — ${s}.` : '')
const age = (ms: number) =>
  ms < 3600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3600_000)} h`
const PR = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g
const prLink = (text: string) => {
  const m = [...text.matchAll(PR)].pop()
  return m ? `[PR #${m[1]}](${m[0]})` : ''
}
const title = (r: Row) => {
  const g = (r.goal ?? '').split('\n')[0] ?? ''
  return (r.bead && g.startsWith(`${r.bead}: `) ? g.slice(r.bead.length + 2) : g) || r.id
}
const step = (r: Row) => `[${r.node}](../glossary.md#${r.node})`
const list = (items: string[]) => (items.length ? items.join('\n') : 'None.')
const stamp = (ms: number) => new Date(ms).toISOString().replace('.000', '')

/** The rig page from contracts/pages.md. Pure: the caller gives the clock and all data, so the same input gives the same text. */
export function renderRigPage(
  rig: string,
  rows: RigRow[],
  waiting: ReadonlySet<string>,
  shipQueue: Bead[],
  merged: Merged[],
  now: number,
): string {
  const liveRows = rows.filter(live).sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id))
  const sum = (r: Row) => strip(r.last?.summary ?? '')
  const item = (r: RigRow, what: string) =>
    `- **${title(r)}**${dot(what)} Step: ${step(r)}, ${age(now - r.createdAt)}.`
  const ask = (r: Row) => {
    const q = r.last?.summary.match(/^Question:[ \t]*(.*)$/m)?.[1]
    return sentence(q || r.gate?.question || r.error || sum(r))
  }
  const ids = (r: Row, extra = '') =>
    `  [${r.bead ?? r.id}]${prLink(r.last?.summary ?? '') && ` · ${prLink(r.last?.summary ?? '')}`}${extra}`
  const waits = liveRows.filter(r => waiting.has(r.id))
  const progress = liveRows.filter(r => !waiting.has(r.id))
  const beads = new Set(liveRows.map(r => r.bead))
  const stopped = rows
    .filter(r => r.node === 'aborted' && r.last && now - r.last.at <= WEEK)
    .sort((a, b) => b.last!.at - a.last!.at || cmp(a.id, b.id))
  const shipped = merged
    .filter(m => now - m.mergedAt <= WEEK)
    .sort((a, b) => b.mergedAt - a.mergedAt || cmp(a.url, b.url))
  const queued = (b: Bead) => {
    const u = String(b.metadata?.ship_pr ?? '')
    const link = u.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/) ? prLink(u) : ''
    return `- **${b.title}** — waits in the ship queue.\n  [${b.id}]${link && ` · ${link}`}`
  }
  const body = [
    '',
    `# ${rig}`,
    '',
    '> The factory makes this page again every 30 min. Do not edit it: an edit does not stay.',
    '',
    '## Waits on a person',
    '',
    list(waits.map(r => `${item(r, ask(r))}\n${ids(r, ' · answers: owner')}`)),
    '',
    '## In progress',
    '',
    list(progress.map(r => `${item(r, sentence(sum(r)))}\n${ids(r)}`)),
    '',
    '## Queued',
    '',
    list(shipQueue.filter(b => !beads.has(b.id)).map(queued)),
    '',
    '## Shipped (last 7 days)',
    '',
    list(
      shipped.map(
        m =>
          `- **${m.title}** — merged ${day(m.mergedAt)}.${m.solution ? ` [Solution](../${m.solution})` : ''}\n  ${prLink(m.url) || m.url}`,
      ),
    ),
    '',
    '## Stopped (last 7 days)',
    '',
    list(
      stopped.map(
        r => `- **${title(r)}**${dot(sentence(sum(r)))} Stopped ${day(r.last!.at)}.\n  [${r.bead ?? r.id}]`,
      ),
    ),
    '',
    `Last update: ${stamp(now)}`,
    '',
  ].join('\n')
  return format({ kind: 'rig', title: `${rig} — factory work`, rigs: [rig], updated: stamp(now) }, body)
}

/** One file of a PR. `patch` is the unified diff text from `gh api repos/<o>/<r>/pulls/<n>/files`. */
export type PrFile = { path: string; patch?: string }

const VERSION_LINE = /^[+-]\s*"version":\s*"[^"]*",?\s*$/

const versionOnly = (patch: string) => {
  const lines = patch.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  return lines.length > 0 && lines.every(l => VERSION_LINE.test(l))
}

const trivialFile = ({ path, patch }: PrFile) => {
  const parts = path.split('/')
  if (path.startsWith('/') || parts.includes('..')) return false
  const base = parts[parts.length - 1]!
  return (
    path.endsWith('.md') ||
    path.startsWith('docs/') ||
    base.includes('.test.') ||
    parts.some(p => p === 'test' || p === 'tests') ||
    path.startsWith('.factory/') ||
    path.endsWith('.lock') ||
    (base === 'package.json' && patch !== undefined && versionOnly(patch))
  )
}

/** True when the list has files and each file is docs, a test, .factory/, a lock file or a version-only package.json change. Any doubt gives false. */
export const trivial = (files: PrFile[]) => files.length > 0 && files.every(trivialFile)

export type WriteBead = {
  id: string
  title: string
  closeReason: string
  comments: string[]
  closedAt: number
  prs: string[]
}
export type WritePr = { url: string; title: string; body: string; files: PrFile[] }
export type WriteGroup = { beads: WriteBead[]; prs: WritePr[] }

/** FACTORY_WIKI_WRITE_CAP: a positive whole number, else 20. */
export const writeCap = (env: Record<string, string | undefined> = process.env) => {
  const v = env.FACTORY_WIKI_WRITE_CAP ?? ''
  return /^[1-9]\d*$/.test(v) ? Number(v) : 20
}

/** Groups beads that share a PR (also through a chain). Drops trivial and unknown PRs. Keeps the `cap` groups with the oldest beads. */
export function writeGroups(beads: WriteBead[], prs: WritePr[], cap = writeCap()): WriteGroup[] {
  const real = new Map(prs.filter(p => !trivial(p.files)).map(p => [p.url, p]))
  const groups: { beads: WriteBead[]; urls: Set<string> }[] = []
  for (const bead of beads) {
    const urls = new Set(bead.prs.filter(x => real.has(x)))
    if (!urls.size) continue
    const hit = groups.filter(g => [...urls].some(x => g.urls.has(x)))
    const into = hit[0] ?? { beads: [], urls: new Set<string>() }
    if (!hit.length) groups.push(into)
    for (const g of hit.slice(1)) {
      into.beads.push(...g.beads)
      g.urls.forEach(x => into.urls.add(x))
      groups.splice(groups.indexOf(g), 1)
    }
    into.beads.push(bead)
    urls.forEach(x => into.urls.add(x))
  }
  const byAge = (a: WriteBead, b: WriteBead) => a.closedAt - b.closedAt || a.id.localeCompare(b.id)
  return groups
    .map(g => ({
      beads: g.beads.sort(byAge),
      prs: [...g.urls].sort().map(x => real.get(x)!),
    }))
    .sort((a, b) => byAge(a.beads[0]!, b.beads[0]!) || 0)
    .slice(0, cap)
}

const MASKS = [
  TOKEN_SHAPE,
  ...SECRETS.map(r => new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g')),
]
/** Replaces each token shape with `***`. */
const mask = (s: string) => MASKS.reduce((t, r) => t.replace(r, '***'), s)

const glossaryLink = (term: string) => `- ${term}: ../../glossary.md#${term.toLowerCase().replace(/ /g, '-')}`

/** The write prompt. Each string of the input goes through mask() before it enters the text. */
export function writePrompt(
  groups: WriteGroup[],
  tombstones: { path: string; at: string }[],
  glossaryTerms: string[],
): string {
  const clean = (v: unknown) =>
    JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' ? mask(x) : x))
  const tomb = tombstones.length
    ? tombstones.map(t => `- ${mask(t.path)} (removed ${mask(t.at)})`).join('\n')
    : 'None.'
  const terms = glossaryTerms.length ? glossaryTerms.map(glossaryLink).join('\n') : 'None.'
  return [
    'Write one solution page for each input item below.',
    'Put each page at `solutions/<yyyy-mm>/<slug>.md`. Use the month of the newest bead close.',
    '',
    '## Page shape',
    '',
    '```markdown',
    '---',
    'kind: solution',
    'title: <short title>',
    'rigs: [<rig>]',
    'topics: [<topic>]',
    'beads: [<bead id>]',
    'prs: [<PR URL>]',
    'cause: proven | hypothesis',
    'status: current',
    'updated: <UTC time, YYYY-MM-DDTHH:MM:SSZ>',
    '---',
    '',
    '# <title>',
    '',
    ...SECTIONS.flatMap(s => [`## ${s}`, '']),
    '```',
    '',
    'If `cause` is `hypothesis`, the Cause section must say what would prove it.',
    '',
    '## Text rules',
    '',
    '- Write in ASD-STE100. Write for a developer who did not work on the change.',
    '- Do not write agent shorthand (`triage#1`, `quick#1 ready:`).',
    '- Link the first use of a factory term on a page to the glossary. Use these links:',
    terms,
    '- Do not copy text that looks like a token, a key, a password or a private address.',
    '',
    '## Tombstones',
    '',
    'Do not write a tombstoned path. Write a new page on that topic only for a bead that closed after the date, at a path that ends `-<YYYY-MM>.md`.',
    tomb,
    '',
    '## Input items (JSON)',
    '',
    JSON.stringify(clean(groups), null, 2),
    '',
  ].join('\n')
}
