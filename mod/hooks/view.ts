// Pure layout helpers for the factory console: no `$`, no elements.
import type { FactoryBead, FactoryMail, FactoryPrs, FactoryRig, FactoryRun } from '../types'

/** one station on a run's path: how often it ran, and whether the run is there now */
export type Stop = { id: string; runs: number; isCurrent: boolean }

/** a run's path through its graph in first-visit order, loops folded into run counts */
export function track(trail: readonly string[], current: string): Stop[] {
  const stops = new Map<string, Stop>()
  for (const id of trail) {
    const stop = stops.get(id) ?? { id, runs: 0, isCurrent: false }
    stops.set(id, { ...stop, runs: stop.runs + 1 })
  }
  if (current && current !== 'done' && current !== 'aborted')
    stops.set(current, { ...(stops.get(current) ?? { id: current, runs: 0 }), isCurrent: true })
  return [...stops.values()]
}

/** the bead types the backlog filters by, after `all` */
export const BEAD_TYPES = ['bug', 'feature', 'task', 'epic', 'chore']

/**
 * A backlog list as priority tiers, highest first (no priority last), each bead followed by its
 * children. A type keeps the beads of that type and their children; a child whose parent is not in
 * the list stands at its own tier. `limit` stops adding whole families once that many rows are drawn.
 */
export function tiers(beads: readonly FactoryBead[], type = 'all', limit = Infinity) {
  const shown = type === 'all' ? new Set(beads.map(b => b.id)) : new Set<string>()
  if (type !== 'all') {
    const hit = new Set(beads.filter(b => b.type === type).map(b => b.id))
    for (const b of beads) if (hit.has(b.id) || hit.has(b.parent ?? '')) shown.add(b.id)
  }
  const list = beads.filter(b => shown.has(b.id))
  const ids = new Set(list.map(b => b.id))
  const kidsOf = (id: string) => list.filter(b => b.parent === id)
  const family = (b: FactoryBead, depth: number): { bead: FactoryBead; depth: number }[] => [
    { bead: b, depth },
    ...kidsOf(b.id).flatMap(k => family(k, depth + 1)),
  ]
  const out: { tier: string; rows: { bead: FactoryBead; depth: number }[] }[] = []
  let drawn = 0
  const roots = list.filter(b => !b.parent || !ids.has(b.parent))
  for (const p of [0, 1, 2, 3, 4, undefined]) {
    const rows: { bead: FactoryBead; depth: number }[] = []
    // ponytail: a priority outside 0-4 is not drawn; bd allows only those
    for (const b of roots.filter(r => r.priority === p))
      if (drawn + rows.length < limit) rows.push(...family(b, 0))
    drawn += rows.length
    if (rows.length) out.push({ tier: p === undefined ? 'no priority' : `P${p}`, rows })
  }
  return { tiers: out, total: list.length, drawn }
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** the last `width` samples as block characters, scaled to their peak or to `floor`, whichever is higher */
export function sparkline(values: readonly number[], width: number, floor = 1) {
  const recent = values.slice(-width)
  const peak = Math.max(floor, ...recent)
  return recent
    .map(v => BLOCKS[Math.round((v / peak) * (BLOCKS.length - 1))])
    .join('')
    .padStart(width, ' ')
}

/** a duration the way a glance wants it: 45s, 4m, 1h12m, 2d3h */
export function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`
}

/** a progress bar `width` cells wide */
export function bar(done: number, total: number, width: number) {
  // a rig can run past its cap (runs it had before the cap, a manager's start): the bar stays full
  const filled = total ? Math.min(width, Math.max(0, Math.round((done / total) * width))) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** one line of at most `max` characters */
export const line = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

export const clockOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const idleKey = (r: FactoryRun) => `idle:${r.rig}`
const blockKey = (r: FactoryRun) => `${r.id}:${r.node}:${r.since}`

/** one manager message, across ticks: a run's mail is told apart by when it was sent */
export const mailKey = (m: Pick<FactoryMail, 'run' | 'at'>) => `${m.run}@${m.at}`

/** mail the person still owes an answer, and mail done with: answered (in the console, by mail, or by a report since), or its run has ended */
export function mailTabs(
  mail: readonly FactoryMail[],
  runs: readonly FactoryRun[],
  answered: Record<string, string> = {},
) {
  const byId = new Map(runs.map(r => [r.id, r]))
  const isDone = (m: FactoryMail) => {
    const r = byId.get(m.run)
    if (answered[mailKey(m)] || !r?.node || r.node === 'done' || r.node === 'aborted') return true
    // the run reported since (the asker carried on, or a gate was decided), or its station was mailed back
    return (r.last?.at ?? 0) > m.at || (r.node === m.from && (r.mailedAt ?? 0) > m.at)
  }
  return { open: mail.filter(m => !isDone(m)), answered: mail.filter(isDone) }
}

/**
 * the person's quick answer to a worker's mail, and the mailbox it goes to: the asking station's, or the
 * station the run has moved on to, told what it answers. null when the run is over and nobody would read it.
 */
export function quickAnswer(
  m: FactoryMail,
  run: Pick<FactoryRun, 'node'> | undefined,
  kind: 'approve' | 'reject' | 'reply',
  note: string,
) {
  if (!run || !isRunLive(run)) return null
  const said = note.trim()
  const text =
    kind === 'approve'
      ? `The person approves: go ahead.${said ? ` ${said}` : ''}`
      : kind === 'reject'
        ? `The person rejects it: do not go ahead.${said ? ` ${said}` : ''}`
        : `The person answers: ${said}`
  const to = run.node === m.from ? m.from : run.node!
  return {
    to,
    text: to === m.from ? text : `About the ${m.from} station's message "${line(m.text, 120)}": ${text}`,
  }
}

const isRunLive = (r: Pick<FactoryRun, 'node'>) => !!r.node && r.node !== 'done' && r.node !== 'aborted'
/** a run holding a worker: neither waiting on a timer nor at a gate */
const isBusy = (r: FactoryRun) => isRunLive(r) && r.sub !== 'waiting' && !r.gate

/** one rig at a glance: its live runs by station, what needs the person, what has ended */
export function rigStats(rig: Pick<FactoryRig, 'name' | 'maxRuns'>, runs: readonly FactoryRun[]) {
  const mine = runs.filter(r => r.rig === rig.name)
  const live = mine.filter(isRunLive)
  const stations = new Map<string, number>()
  for (const r of live) stations.set(r.node!, (stations.get(r.node!) ?? 0) + 1)
  const busy = live.filter(isBusy).length
  return {
    busy,
    room: rig.maxRuns === undefined ? null : Math.max(0, rig.maxRuns - busy),
    stations: [...stations].map(([node, n]) => ({ node, n })),
    gates: live.filter(r => r.gate).map(r => r.id),
    stuck: live.filter(r => r.sub === 'stuck' || r.agent === 'blocked').map(r => r.id),
    done: mine.filter(r => r.node === 'done').length,
    aborted: mine.filter(r => r.node === 'aborted').length,
  }
}

/** minutes as a floor to 10, so the board repeats until a run's facts really move */
const tens = (min: number) => `${Math.floor(min / 10) * 10}+ min`

/** what a patrol says of a working run beside its station: the attempt, how long, how quiet, a paused runner */
export function runFacts(r: Pick<FactoryRun, 'attempt' | 'attempts' | 'inMin' | 'quietMin' | 'limitUntil'>) {
  return [
    r.attempt && r.attempts && `attempt ${r.attempt}/${r.attempts}`,
    r.inMin !== undefined && r.inMin >= 10 && `${tens(r.inMin)} in station`,
    r.quietMin !== undefined && r.quietMin >= 10 && `quiet ${tens(r.quietMin)}`,
    r.limitUntil && `runner paused by its usage limit until ${clockOf(r.limitUntil)}`,
  ]
    .filter(Boolean)
    .map(f => `, ${f}`)
    .join('')
}

/**
 * The manager's loop: what to wake this session's model with, or null when nothing calls for it.
 * New mail and newly blocked workers wake it at once; `isDue` adds a heartbeat while any worker runs
 * or a rig with a goal has room for more runs. `keys` are the blocked workers this patrol reports,
 * for the caller to remember in `seen`. The board and rig goals are sent only when they differ from
 * `lastBoard`, the `board` an earlier patrol returned: every patrol stays in the manager's context.
 */
export function patrol(
  runs: readonly FactoryRun[],
  mail: readonly FactoryMail[],
  seen: ReadonlySet<string>,
  isDue: boolean,
  rigs: readonly FactoryRig[] = [],
  lastBoard?: string,
) {
  const live = runs.filter(isRunLive)
  const blocked = live.filter(r => r.agent === 'blocked' && !seen.has(blockKey(r)))
  const isWorking = live.some(r => r.sub === 'working' && !r.gate)
  const busy = (g: FactoryRig) => rigStats(g, runs).busy
  const goals = rigs.filter(g => g.goal)
  const hasRoom = goals.some(g => busy(g) < (g.maxRuns ?? Infinity))
  // ponytail: told once per rig for the session; a rig that idles again later waits for a restart or other news
  const idle = runs.filter(r => r.idle && !seen.has(idleKey(r)))
  if (!mail.length && !blocked.length && !idle.length && !(isDue && (isWorking || hasRoom))) return null
  const news = [
    // the whole report is a `factory show` away; a parked station's can run to pages
    ...mail.map(m => `- ${m.run} / ${m.from}: ${line(m.text, 300)}`),
    ...blocked.map(r => `- ${r.id} / ${r.node}: its worker (pane ${r.pane}) is waiting on a prompt`),
    ...idle.map(r => `- rig ${r.rig}: idle, ${r.idle}. Set it a goal or queue beads for it.`),
  ]
  const board = live.map(
    r =>
      `- ${r.id}${r.rig ? ` (rig ${r.rig})` : ''} at ${r.node}/${r.sub}${r.gate ? ', awaiting the person' : runFacts(r)}: ${line(r.goal ?? '', 100)}`,
  )
  const state = [
    board.length ? `Board:\n${board.join('\n')}` : 'Board: no runs.',
    ...(goals.length
      ? [
          `Rig goals: with room, give each rig the next work toward its goal.\n${goals
            .map(g => `- ${g.name}, busy ${busy(g)}${g.maxRuns ? `/${g.maxRuns}` : ''}: ${g.goal}`)
            .join('\n')}`,
        ]
      : []),
  ].join('\n')
  const text = [
    '[factory] patrol',
    news.length
      ? `New:\n${news.join('\n')}`
      : 'Heartbeat: nothing new was reported. Check that every working station is making progress.',
    state === lastBoard ? 'Board and rig goals: unchanged since the last patrol.' : state,
  ].join('\n')
  return { text, keys: [...blocked.map(blockKey), ...idle.map(idleKey)], board: state }
}

/** what an open pull request waits on, worst first: conflicts, failing checks, a review, then the merge */
export function prNeed(pr: Pick<FactoryPrs[number]['prs'][number], 'reviewDecision' | 'mergeStateStatus'>) {
  if (pr.mergeStateStatus === 'DIRTY') return { word: 'conflicts', color: 'red' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { word: 'changes requested', color: 'red' }
  if (pr.mergeStateStatus === 'UNSTABLE') return { word: 'checks failing', color: 'yellow' }
  if (pr.mergeStateStatus === 'BEHIND') return { word: 'behind its base', color: 'yellow' }
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { word: 'needs approval', color: 'yellow' }
  if (pr.mergeStateStatus === 'CLEAN') return { word: 'ready to merge', color: 'green' }
  if (pr.mergeStateStatus === 'BLOCKED') return { word: 'blocked by a rule', color: 'yellow' }
  return { word: 'checking', color: 'gray' }
}

/** a short check tally to append to a PR's state word, blank when nothing has run yet */
const checksOf = (checks: Pick<FactoryPrs[number]['prs'][number], 'checks'>['checks']) =>
  checks.pass || checks.fail || checks.pending
    ? ` (${checks.pass}✓${checks.fail ? ` ${checks.fail}✗` : ''}${checks.pending ? ` ${checks.pending}…` : ''})`
    : ''

/** a PR row's state word for the PRs tab: draft overrides everything, merged and closed are terminal,
 * an open PR gets whatever `prNeed` says it is waiting on; every case carries its own checks tally */
export function prState(
  pr: Pick<FactoryPrs[number]['prs'][number], 'isDraft' | 'state' | 'reviewDecision' | 'mergeStateStatus' | 'checks'>,
) {
  const checks = checksOf(pr.checks)
  if (pr.isDraft) return { word: 'draft', color: 'gray', checks }
  if (pr.state === 'MERGED') return { word: 'merged', color: 'magenta', checks }
  if (pr.state === 'CLOSED') return { word: 'closed', color: 'red', checks }
  return { ...prNeed(pr), checks }
}

/** one question the factory puts to the person: a run stuck or parked on something only they can settle */
export type Interview = {
  key: string
  run: string
  node: string
  rig?: string
  kind: 'parked' | 'stuck'
  question: string
  options: string[]
  /** what the worker reported, for the question's context */
  context: string
  at: number
}

/** a worker's `Question:` and `Options: a | b` lines, which the blocked brief asks for */
function asked(text: string) {
  const q = text.match(/(?:^|\n)\s*Question:\s*(.+)/i)?.[1]?.trim()
  const o = text.match(/(?:^|\n)\s*Options:\s*(.+)/i)?.[1]
  return {
    question: q,
    options: o
      ? o
          .split('|')
          .map(s => s.trim())
          .filter(Boolean)
      : [],
  }
}

/**
 * the questions open for the person, oldest first: each run parked by its own blocked report or stuck out of
 * retries. One is answered once the person answered it here, or its station was mailed since, or the run moved.
 */
export function interviews(runs: readonly FactoryRun[], answered: Record<string, string> = {}) {
  const out: Interview[] = []
  for (const r of runs) {
    if (!isRunLive(r) || r.gate) continue
    const last = r.last
    const parked =
      r.sub === 'waiting' && last && last.node === r.node && last.outcome === 'blocked' ? last : undefined
    if (!parked && r.sub !== 'stuck') continue
    const at = parked ? parked.at : (r.since ?? last?.at ?? 0)
    const key = `iv:${r.id}@${at}`
    if (answered[key] || (r.mailedAt ?? 0) > at) continue
    const context = (parked ? parked.summary : (r.error ?? last?.summary)) ?? ''
    const a = asked(context)
    out.push({
      key,
      run: r.id,
      node: r.node!,
      rig: r.rig,
      kind: parked ? 'parked' : 'stuck',
      question:
        a.question ??
        (parked
          ? `${r.node} is parked waiting on something outside the run. What should it do?`
          : `${r.node} is out of retries. How should it go on?`),
      options: a.options,
      context,
      at,
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** the mail that carries the person's answer to a question: their choice, what they typed, or both */
export function interviewAnswer(iv: Pick<Interview, 'question'>, choice: string | undefined, note: string) {
  const said = note.trim()
  const parts = [choice && `The person chose: ${choice}.`, said && `The person says: ${said}`].filter(Boolean)
  return parts.length ? `Answering "${line(iv.question, 200)}": ${parts.join(' ')}` : null
}
