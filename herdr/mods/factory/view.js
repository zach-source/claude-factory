// The pure view code of the Herdr app factory mod. It has no `herdr` import and no elements.
// Thus bun test can load it.
//
// Some functions copy mod/hooks/view.ts (the Claude mod). src/herdr-view.test.ts keeps them equal.

export const isLive = r => !!r.node && r.node !== 'done' && r.node !== 'aborted'

/** what one live run does: a gate wins over stuck, stuck over waiting */
export const stateOf = r =>
  r.gate
    ? 'gates'
    : r.sub === 'stuck' || r.agent === 'blocked'
      ? 'stuck'
      : r.sub === 'waiting'
        ? 'waiting'
        : 'working'

export const BOARD_STATES = ['gates', 'stuck', 'working', 'waiting']

/** one line of at most `max` characters */
export const line = (text, max) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** a run id short enough for a column */
export function shortId(id) {
  const tail = id.slice(id.lastIndexOf('-') + 1) || id
  return tail.length <= 9 ? tail : `${tail.slice(0, 4)}…${tail.slice(-4)}`
}

/** the live runs by rig, then by state in BOARD_STATES order, each oldest first. Empty groups are left out. */
export function board(runs) {
  const age = r => r.since ?? Infinity
  const live = runs.filter(r => !r.error && isLive(r))
  const rigs = [...new Set(live.map(r => r.rig ?? 'no rig'))].sort()
  return rigs.map(rig => ({
    rig,
    states: BOARD_STATES.map(state => ({
      state,
      runs: live
        .filter(r => (r.rig ?? 'no rig') === rig && stateOf(r) === state)
        .sort((a, b) => (age(a) === age(b) ? 0 : age(a) < age(b) ? -1 : 1)),
    })).filter(s => s.runs.length),
  }))
}

/** the status line: "3 working (api 2, web 1) · 1 awaiting you · 1 stuck"; '' when no run is live */
export function statusText(runs) {
  const n = { working: 0, gates: 0, stuck: 0, waiting: 0, rigs: {} }
  let live = 0
  for (const r of runs.filter(isLive)) {
    live++
    const s = stateOf(r)
    n[s]++
    if (s === 'working') n.rigs[r.rig ?? 'no rig'] = (n.rigs[r.rig ?? 'no rig'] ?? 0) + 1
  }
  if (!live) return ''
  const rigs = Object.entries(n.rigs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const byRig =
    rigs.length > 1
      ? ` (${rigs.map(([r, k]) => `${r} ${k}`).join(', ')})`
      : rigs.length
        ? ` (${rigs[0][0]})`
        : ''
  return [
    `${n.working} working${n.working ? byRig : ''}`,
    n.gates && `${n.gates} awaiting you`,
    n.stuck && `${n.stuck} stuck`,
    n.waiting && `${n.waiting} waiting`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** the runs whose worker became blocked since `before` (run id -> last agent state) */
export const newlyBlocked = (runs, before) =>
  runs.filter(r => r.agent === 'blocked' && before[r.id] !== 'blocked')

/** the run id -> agent state map for the next newlyBlocked call */
export const agentsOf = runs => Object.fromEntries(runs.map(r => [r.id, r.agent ?? null]))

/** the gates and decisions the Interview dialog shows: gates first, oldest first */
export function interviewItems(runs, decisions) {
  const gates = runs
    .filter(r => r.gate && isLive(r))
    .sort((a, b) => (a.since ?? 0) - (b.since ?? 0))
    .map(r => ({
      kind: 'gate',
      key: `gate:${r.id}`,
      run: r.id,
      title: r.gate.question || `${r.id} waits at ${r.node}`,
      detail: r.gate.brief ?? line(r.goal ?? '', 300),
      options: r.gate.outcomes,
    }))
  const beads = (decisions?.rigs ?? []).flatMap(d =>
    d.beads.map(b => {
      const key = `${b.kind === 'bead' ? 'bd' : 'own'}:${d.rig}:${b.id}`
      const p = decisions.proposals?.[key]
      return {
        kind: b.kind,
        key,
        rig: d.rig,
        bead: b.id,
        title: p?.question ?? b.title,
        detail: p?.context ?? line(b.description ?? '', 300),
        // an owner-only bead keeps its two fixed answers
        options:
          b.kind === 'owned' ? ['start now', 'not now'] : (p?.options ?? []).map(o => o.split(':')[0].trim()),
      }
    }),
  )
  return [...gates, ...beads]
}

/** the shell words for one answer: `decide` for a gate, `decisions answer` for a bead */
export const answerArgs = (item, option) =>
  item.kind === 'gate' ? ['decide', item.run, option] : ['decisions', 'answer', item.rig, item.bead, option]

/** the result of `factory tick`, or why it failed. A read-only tick names the lease holder. */
export function parseTick(code, out, err) {
  if (code !== 0) return { error: line(err || out || `factory tick exited ${code}`, 300) }
  try {
    const res = JSON.parse(out)
    if (res.busy) return { busy: true }
    return {
      runs: res.runs ?? [],
      manager: res.manager ?? [],
      rigs: res.rigs ?? [],
      halt: res.halt,
      readOnly: res.readOnly,
      managerLimited: res.managerLimited ?? null,
    }
  } catch {
    return { error: line(`factory tick printed no JSON: ${out || err}`, 300) }
  }
}

/** the board header when the manager's Claude is limited: 'manager: Claude limited until HH:MM', else '' */
export function managerLimitText(limited) {
  if (!limited || typeof limited.until !== 'number') return ''
  const d = new Date(limited.until)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `manager: Claude limited until ${hh}:${mm}`
}

/** the result of `factory snapshot --views board,decisions`: { tick, decisions } for the tabs to share */
export function parseSnapshot(code, out, err) {
  if (code !== 0) return { tick: { error: line(err || out || `factory snapshot exited ${code}`, 300) } }
  let views
  try {
    views = JSON.parse(out).views
  } catch {
    return { tick: { error: line(`factory snapshot printed no JSON: ${out || err}`, 300) } }
  }
  const board = views?.board
  const tick = board?.error
    ? { error: line(board.error, 300) }
    : parseTick(0, JSON.stringify(board ?? {}), '')
  const d = views?.decisions
  return { tick, decisions: d && !d.error ? d : undefined }
}

// Remote mode (claude-factory-hpmc.14): the manager runs on another machine, such as the AX task f-manager.

/** the config.json text as { cli, home, machine? }, or null when it is not one */
export function parseConfig(text) {
  try {
    const c = JSON.parse(text)
    if (typeof c?.cli !== 'string' || typeof c.home !== 'string') return null
    if (c.machine !== undefined && typeof c.machine !== 'string') return null
    return c
  } catch {
    return null
  }
}

/** the options that send an exec or a file read to the machine of a remote config */
export const onOf = cfg => (cfg.machine ? { on: cfg.machine } : undefined)

/** the one read-only call of a beat: the slim board and the decisions (claude-factory-hpmc.23) */
export const SNAPSHOT_WORDS = ['snapshot', '--views', 'board,decisions']

/** the shell words of a control button; only these CLI commands are allowed */
export function actionWords(action, arg) {
  if (['stop', 'resume'].includes(action)) return [action]
  if (['abort', 'unhold', 'say'].includes(action) && arg) return [action, arg]
  throw new Error(`no such action: ${action}`)
}

/**
 * the terminal command for the manager chat of a remote config, or null for a local one. While the manager's Claude
 * is limited (board managerLimited), it starts a Codex chat in a terminal named manager-codex on the machine, if
 * none is live, and attaches to it. The values travel as arguments of sh, so no quoting is needed.
 */
export function chatArgv(cfg, limited = null) {
  if (!cfg.machine) return null
  if (!limited) return ['hc', 'attach', `${cfg.machine}/manager`]
  const script =
    'hc run --bg --on "$0" --name manager-codex env "FACTORY_HOME=$1" "$2" manager chat --codex >/dev/null 2>&1; ' +
    'exec hc attach "$0/manager-codex"'
  return ['sh', '-c', script, cfg.machine, cfg.home, cfg.cli]
}

/** the label of the manager chat button */
export const chatLabel = limited => (limited ? 'Manager chat (codex)' : 'Manager chat')

/** the exec call of a remote job: [command, args]. It runs in the foreground, since hc exec kills what a command leaves behind. */
export const directJob = (cfg, words) => ['env', [`FACTORY_HOME=${cfg.home}`, cfg.cli, ...words]]

// The Flow tab (claude-factory-hpmc.26): it draws the flows.show graph (spec 008, FR-025).

export const FLOW_LENSES = ['live', 'flow', 'time']
export const FLOW_WINDOWS = ['1h', '24h', '7d']
export const FLOW_FACTORIES = ['lifecycle', 'ship']
const BOX_W = 120
const BOX_H = 46
const GAP_X = 80
const GAP_Y = 30
const PAD = 24
const BACK_DEPTH = 34
const MAX_DOTS = 4
/** a move this recent (ms) makes its run pulse */
export const PULSE_MS = 90_000

/** the words of the flows job */
export const flowJobWords = (factory, window) => ['flows', '--json', '--factory', factory, '--since', window]

/** the result of `factory flows --json`: { graph } or { error } */
export function parseFlows(code, out, err) {
  if (code !== 0) return { error: line(err || out || `factory flows exited ${code}`, 300) }
  try {
    const graph = JSON.parse(out)
    if (!Array.isArray(graph?.nodes)) throw new Error('no nodes')
    return { graph }
  } catch {
    return { error: line(`factory flows printed no JSON: ${out || err}`, 300) }
  }
}

/** the ids of the runs that moved in the last `ms` before the graph's own clock */
export const recentMovers = (graph, ms = PULSE_MS) => [
  ...new Set(graph.moves.filter(m => graph.now - m.at <= ms).map(m => m.run)),
]

/**
 * The boxes, dots and edges of the graph in px. Columns are ranks, rows are definition order.
 * Lens `flow` sizes an edge by log traversals; lens `time` heats a node by its p90 dwell (0 to 1).
 * An edge is a path: [['M', x, y], ['C', x, y, ax, ay, bx, by]]. A cubic goes to (x, y) through (ax, ay), (bx, by).
 */
export function flowLayout(graph, lens) {
  const ranks = [...new Set(graph.nodes.map(n => n.rank))].sort((a, b) => a - b)
  const col = new Map(ranks.map((r, i) => [r, i]))
  const rows = new Map()
  const slowest = Math.max(0, ...graph.nodes.map(n => n.dwell?.p90 ?? 0))
  const nodes = [...graph.nodes]
    .sort((a, b) => a.order - b.order)
    .map(n => {
      const row = rows.get(n.rank) ?? 0
      rows.set(n.rank, row + 1)
      return {
        id: n.id,
        label: n.legacy ? `${n.id} (old)` : n.id,
        gate: n.gate,
        legacy: n.legacy,
        x: PAD + col.get(n.rank) * (BOX_W + GAP_X),
        y: PAD + row * (BOX_H + GAP_Y),
        w: BOX_W,
        h: BOX_H,
        counts: n.counts,
        p90: n.dwell?.p90 ?? null,
        heat: lens === 'time' && slowest ? (n.dwell?.p90 ?? 0) / slowest : 0,
        dots: n.runs.slice(0, MAX_DOTS).map(run => ({ run })),
        chip: n.runs.length > MAX_DOTS ? `+${n.runs.length - MAX_DOTS}` : '',
      }
    })
  const by = Object.fromEntries(nodes.map(n => [n.id, n]))
  const edges = graph.edges
    .filter(e => by[e.from] && by[e.to])
    .map(e => {
      const a = by[e.from]
      const b = by[e.to]
      const width = lens === 'flow' ? 1 + Math.log2(1 + e.traversals) : 1.5
      const label = lens === 'flow' || e.traversals ? `${e.outcome} ${e.traversals}` : e.outcome
      if (e.back) {
        const y = Math.max(a.y, b.y) + BOX_H
        const ax = a.x + a.w / 2
        const bx = b.x + b.w / 2
        return {
          ...e,
          width,
          label,
          dashed: true,
          path: [
            ['M', ax, a.y + a.h],
            ['C', bx, b.y + b.h, ax, y + BACK_DEPTH, bx, y + BACK_DEPTH],
          ],
          lx: (ax + bx) / 2,
          ly: y + BACK_DEPTH,
        }
      }
      const sx = a.x + a.w
      const sy = a.y + a.h / 2
      const tx = b.x
      const ty = b.y + b.h / 2
      const mid = (sx + tx) / 2
      return {
        ...e,
        width,
        label,
        dashed: false,
        path: [
          ['M', sx, sy],
          ['C', tx, ty, mid, sy, mid, ty],
        ],
        lx: mid,
        ly: (sy + ty) / 2 - 8,
      }
    })
  const exits = graph.exits.map(x => ({ ...x, opens: FLOW_FACTORIES.includes(x.to) ? x.to : undefined }))
  const rowsMax = Math.max(1, ...rows.values())
  return {
    nodes,
    edges,
    exits: exits.map(x => (x.opens ? x : { from: x.from, outcome: x.outcome, to: x.to })),
    width: PAD * 2 + ranks.length * BOX_W + Math.max(0, ranks.length - 1) * GAP_X,
    height: PAD * 2 + rowsMax * BOX_H + (rowsMax - 1) * GAP_Y + BACK_DEPTH * 2,
  }
}
