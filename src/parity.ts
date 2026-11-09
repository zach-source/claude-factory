// Front-end parity (spec 008, FR-018, FR-019): each front end runs catalog.echo through its generic view,
// or a gap in parity-gaps.json names an open bead that adds that view.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CATALOG, fieldOk, type Input, type Op, type RunResult } from './core/catalog'

export type FrontEndName = 'cli' | 'web' | 'claude-mod' | 'herdr-mod'
export type FrontEnd = {
  name: FrontEndName
  /** runs one catalog op through the front end's generic view; hpmc.8-11 fill it */
  generic?: (op: string, input: Input) => Promise<RunResult>
  ownViews: string[]
  hidden: { op: string; shownIn: string }[]
}
export const FRONT_ENDS: FrontEnd[] = [
  { name: 'cli', ownViews: [], hidden: [] },
  { name: 'web', ownViews: [], hidden: [] },
  { name: 'claude-mod', ownViews: [], hidden: [] },
  { name: 'herdr-mod', ownViews: [], hidden: [] },
]
export type Gap = { op: string; frontEnd: FrontEndName; bead: string; reason: string }
export const GAPS_FILE = resolve(import.meta.dir, '..', 'parity-gaps.json')

const KEYS = ['op', 'frontEnd', 'bead', 'reason']
// a harness gap: a station that cannot run the same on that harness (claude-factory-gf16e.2); not a front-end gap
export type HarnessGap = { harness: string; station: string; bead: string; reason: string }
const HARNESS_KEYS = ['harness', 'station', 'bead', 'reason']
const HARNESSES = ['claude', 'codex', 'grok', 'pi', 'cursor']
const BEAD_FIELD = { name: 'bead', kind: 'id', required: true, help: '' } as const
const F = 'parity-gaps.json'

/** the harness gaps of the gap file; parseGaps checks their shape */
export const harnessGaps = (text: string): HarnessGap[] =>
  (JSON.parse(text) as Record<string, string>[]).filter(o => 'harness' in o) as HarnessGap[]

/** Parse the gap file. Fail closed: throw at the first bad item. */
export function parseGaps(text: string, catalog: Op[] = CATALOG): Gap[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${F}: not JSON`)
  }
  if (!Array.isArray(data)) throw new Error(`${F}: not an array`)
  const names = new Set(FRONT_ENDS.map(f => f.name as string))
  const seen = new Map<string, number>()
  const gaps: Gap[] = []
  let dup: Error | undefined
  data.forEach((it: unknown, i) => {
    const bad = (m: string) => new Error(`${F}: item ${i}: ${m}`)
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw bad('not an object')
    const o = it as Record<string, unknown>
    const ks = Object.keys(o)
    if (ks.includes('harness')) {
      if (ks.length !== HARNESS_KEYS.length || !HARNESS_KEYS.every(k => ks.includes(k)))
        throw bad('keys must be harness, station, bead, reason')
      for (const k of HARNESS_KEYS)
        if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw bad(`${k} must be a string`)
      if (!HARNESSES.includes(o.harness as string)) throw bad(`harness ${o.harness} is not a harness`)
      if (!fieldOk(BEAD_FIELD, o.bead as string)) throw bad('bead must be a bead id')
      return
    }
    if (ks.length !== KEYS.length || !KEYS.every(k => ks.includes(k)))
      throw bad('keys must be op, frontEnd, bead, reason')
    for (const k of KEYS) if (typeof o[k] !== 'string') throw bad(`${k} must be a string`)
    const g = o as Gap
    if (!catalog.some(c => c.name === g.op)) throw bad(`op ${g.op} is not in the catalog`)
    if (!names.has(g.frontEnd)) throw bad(`frontEnd ${g.frontEnd} is not a front end`)
    if (!fieldOk(BEAD_FIELD, g.bead)) throw bad('bead must be a bead id')
    if (!g.reason.trim()) throw bad('reason is empty')
    gaps.push({ op: g.op, frontEnd: g.frontEnd, bead: g.bead, reason: g.reason })
    const key = `${g.op}\u0000${g.frontEnd}`
    if (!seen.has(key)) seen.set(key, i)
    else dup ??= bad(`duplicate of item ${seen.get(key)}`)
  })
  if (dup) throw dup
  return gaps
}

/** The problems, in order: per front end the generic view, then ownViews, then hidden. */
export async function checkParity(catalog: Op[], fronts: FrontEnd[], gaps: Gap[]): Promise<string[]> {
  const known = new Set(catalog.map(o => o.name))
  const out: string[] = []
  for (const fe of fronts) {
    if (!gaps.some(g => g.op === 'catalog.echo' && g.frontEnd === fe.name)) {
      const why = await echoFails(fe)
      if (why) out.push(`${fe.name}: the generic view cannot run catalog.echo: ${why}`)
    }
    for (const v of fe.ownViews)
      if (!known.has(v)) out.push(`${fe.name}: own view ${v} is not in the catalog`)
    for (const h of fe.hidden) {
      if (!known.has(h.op)) out.push(`${fe.name}: hidden ${h.op} is not in the catalog`)
      else {
        const other = fronts.find(f => f.name === h.shownIn)
        if (!other || other.hidden.some(x => x.op === h.op))
          out.push(`${fe.name}: hidden ${h.op} must name a front end that shows it`)
      }
    }
  }
  return out
}

async function echoFails(fe: FrontEnd): Promise<string | undefined> {
  if (!fe.generic) return 'no generic view'
  const t = `parity-${crypto.randomUUID()}`
  try {
    const r = await fe.generic('catalog.echo', { text: t })
    if (r.code !== 0 || r.out !== `${t}\n`) return `code ${r.code}, out ${String(r.out).slice(0, 80)}`
  } catch (e) {
    return (e as Error).message
  }
}

export type Show = (id: string) => { code: number; out: string; err: string }
const OPEN = new Set(['open', 'in_progress', 'blocked', 'deferred'])

/** `factory parity`: 0 when each gap bead reads as open, else 1. */
export function parity(o: { file: string; show: Show; print: (l: string) => void }): number {
  let gaps: Gap[]
  try {
    gaps = parseGaps(readFileSync(o.file, 'utf8'))
  } catch (e) {
    const m = (e as Error).message
    o.print(m.startsWith(F) ? `parity: ${m}` : `parity: cannot read ${o.file}: ${m}`)
    return 1
  }
  const why = new Map<string, string | undefined>()
  for (const g of gaps) if (!why.has(g.bead)) why.set(g.bead, notOpen(g.bead, o.show(g.bead)))
  let k = 0
  for (const g of gaps) {
    const w = why.get(g.bead)
    if (!w) continue
    k++
    o.print(`parity: ${g.bead} (${g.frontEnd} ${g.op}): ${w}`)
  }
  if (!k) o.print(`parity: ${gaps.length} gaps, all beads open`)
  else o.print(`parity: ${k} of ${gaps.length} gaps name a bead that is not open`)
  return k ? 1 : 0
}

function notOpen(id: string, r: ReturnType<Show>): string | undefined {
  if (r.code !== 0) return `bd show failed: ${r.err.trim().split('\n')[0]!.slice(0, 200) || `exit ${r.code}`}`
  let row: { id?: unknown; status?: unknown } | undefined
  try {
    const a: unknown = JSON.parse(r.out)
    row = Array.isArray(a) ? a[0] : undefined
  } catch {}
  if (!row || row.id !== id || typeof row.status !== 'string') return 'bd show gave no row for it'
  if (!OPEN.has(row.status)) return `status ${row.status}, remove the gap or reopen the bead`
}
