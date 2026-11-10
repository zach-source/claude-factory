// claude-factory-hpmc.25: the workflow graph of the flows.show operation (spec 008, FR-025).
// Pure: the port reads the factory and the runs, this file only computes.
import { edgeTo, type Edge, type Entry, type Factory } from './machine'
import { median, p90 } from './metrics'

/** `ended`: a kept record of a finished run. Its log counts for traversals and dwell; it is at no station */
export type FlowRun = { id: string; node: string; sub: string; createdAt: number; log: Entry[]; ended?: true }
export type FlowNode = {
  id: string
  gate: boolean
  legacy: boolean
  rank: number
  order: number
  counts: Record<string, number>
  dwell: { p50: number; p90: number } | null
  runs: string[]
}
export type FlowEdge = {
  from: string
  outcome: string
  to: string
  back: boolean
  timed: boolean
  traversals: number
}
export type FlowGraph = {
  factory: string
  since: number
  now: number
  nodes: FlowNode[]
  edges: FlowEdge[]
  exits: { from: string; outcome: string; to: string }[]
  moves: { run: string; from: string; outcome: string; to: string; at: number }[]
}

const UNIT: Record<string, number> = { h: 3_600_000, d: 86_400_000 }

/** `1h`, `24h`, `7d` count back from now; a bare number is a cursor in ms since epoch; none is 24h */
export function parseSince(s: string | undefined, now: number): number {
  if (s === undefined || s === '') return now - UNIT.d!
  const w = /^(\d+)([hd])$/.exec(s)
  if (w) return now - Number(w[1]) * UNIT[w[2]!]!
  if (/^\d+$/.test(s)) return Number(s)
  throw new Error(`since must be a window like 1h, 24h or 7d, or a time in ms: ${s}`)
}

/** where an edge ends when it is not a station: the ship queue, another factory, or the end of the run */
const exitOf = (e: Edge): string => {
  if (typeof e === 'string') return e
  if (e.ship) return 'ship'
  if (typeof e.requeue === 'object' && e.requeue.factory) return e.requeue.factory
  return e.to
}

/** depth from the start station over forward edges; an unreached station follows the deepest rank */
function ranks(def: Factory): Map<string, number> {
  const rank = new Map<string, number>([[def.start, 0]])
  const queue = [def.start]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const e of Object.values(def.nodes[id]?.next ?? {})) {
      const to = edgeTo(e)
      if (def.nodes[to] && !rank.has(to)) {
        rank.set(to, rank.get(id)! + 1)
        queue.push(to)
      }
    }
  }
  const deepest = Math.max(...rank.values())
  for (const id of Object.keys(def.nodes)) if (!rank.has(id)) rank.set(id, deepest + 1)
  return rank
}

export function flowGraph(i: { def: Factory; runs: FlowRun[]; since: number; now: number }): FlowGraph {
  const { def, runs, since, now } = i
  const rank = ranks(def)
  const target = (from: string, outcome: string) => {
    const e = def.nodes[from]?.next[outcome]
    return e === undefined ? undefined : edgeTo(e)
  }
  // every log entry of every run, with the time the run spent before it
  const steps = runs.flatMap(r =>
    r.log.map((e, k) => ({ run: r.id, e, dwell: e.at - (k ? r.log[k - 1]!.at : r.createdAt) })),
  )
  const dwellOf = (id: string) => steps.filter(s => s.e.node === id && s.e.at >= since).map(s => s.dwell)
  const legacy = [
    ...new Set(runs.flatMap(r => [...(r.ended ? [] : [r.node]), ...r.log.map(e => e.node)])),
  ].filter(id => !def.nodes[id])
  const nodes: FlowNode[] = [
    ...Object.entries(def.nodes).map(([id, n], order) => ({
      id,
      gate: !!n.gate,
      legacy: false,
      rank: rank.get(id)!,
      order,
    })),
    ...legacy.map((id, k) => ({
      id,
      gate: false,
      legacy: true,
      rank: 0,
      order: Object.keys(def.nodes).length + k,
    })),
  ].map(n => {
    const here = runs.filter(r => !r.ended && r.node === n.id)
    const d = dwellOf(n.id)
    return {
      ...n,
      counts: here.reduce<Record<string, number>>((c, r) => ({ ...c, [r.sub]: (c[r.sub] ?? 0) + 1 }), {}),
      dwell: d.length ? { p50: median(d)!, p90: p90(d)! } : null,
      runs: here.map(r => r.id),
    }
  })
  const inWin = steps.filter(s => s.e.at >= since && s.e.at <= now)
  const all = Object.entries(def.nodes).flatMap(([from, n]) =>
    Object.entries(n.next).map(([outcome, e]) => ({ from, outcome, e })),
  )
  const station = (e: Edge) => !!def.nodes[edgeTo(e)] && exitOf(e) === edgeTo(e)
  const edges = all
    .filter(({ e }) => station(e))
    .map(({ from, outcome, e }) => ({
      from,
      outcome,
      to: edgeTo(e),
      back: rank.get(edgeTo(e))! <= rank.get(from)!,
      timed: typeof e === 'object' && !!e.delayMin,
      traversals: inWin.filter(s => s.e.node === from && s.e.outcome === outcome).length,
    }))
  const exits = all
    .filter(({ e }) => !station(e))
    .map(({ from, outcome, e }) => ({ from, outcome, to: exitOf(e) }))
  const moves = inWin
    .map(s => ({
      run: s.run,
      from: s.e.node,
      outcome: s.e.outcome,
      to: target(s.e.node, s.e.outcome) ?? s.e.node,
      at: s.e.at,
    }))
    .sort((a, b) => a.at - b.at)
  return { factory: def.name, since, now, nodes, edges, exits, moves }
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`
const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || '-'

/** `factory flows`: one line a station, then one line an edge */
export function flowTable(g: FlowGraph): string {
  const rows = g.nodes.map(
    n =>
      `${n.id}${n.legacy ? ' (legacy)' : ''}\t${n.rank}\t${counts(n.counts)}\t${n.dwell ? secs(n.dwell.p90) : '-'}`,
  )
  const pad = Math.max(...rows.map(r => r.split('\t')[0]!.length))
  const lines = rows.map(r => {
    const [id, rank, c, d] = r.split('\t')
    return `${id!.padEnd(pad)}  ${rank}  ${c}  ${d}`.replace(/ +$/, '')
  })
  const arrows = g.edges.map(
    e => `${e.from} --${e.outcome}--> ${e.to}  ${e.traversals}${e.timed ? ' (timed)' : ''}`,
  )
  const exits = g.exits.map(e => `${e.from} --${e.outcome}--> (${e.to})`)
  return [`${g.factory}: station, rank, runs, p90`, ...lines, '', ...arrows, ...exits].join('\n')
}

/** `factory flows --mermaid` */
export function flowMermaid(g: FlowGraph): string {
  const box = (n: FlowNode) => (n.gate ? `${n.id}{${n.id}}` : n.id)
  return [
    'flowchart LR',
    ...g.nodes.map(n => `  ${box(n)}`),
    ...g.edges.map(e => `  ${e.from} ${e.back ? '-.->' : '-->'}|${e.outcome} ${e.traversals}| ${e.to}`),
  ].join('\n')
}
