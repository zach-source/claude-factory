import { secretFile } from './homebackup'

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
  let y: unknown
  try {
    y = Bun.YAML.parse(lines.slice(1, end).join('\n'))
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
