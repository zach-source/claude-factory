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

/** the open questions the Interview dialog shows: the core list (`factory interview`), one button for each option */
export const interviewItems = items =>
  (items ?? []).map(iv => ({
    ...iv,
    detail: iv.context || line(iv.details ?? '', 300),
    options: iv.options.map(o => o.label),
  }))

/** the shell words for one answer: the core routes it (gate, bead, start now, mail) */
export const answerArgs = (item, option) => ['interview', 'answer', item.key, option]

/** the board of a snapshot as the state the tabs share, or why it failed */
export function parseTick(code, out, err) {
  if (code !== 0) return { error: line(err || out || `factory board exited ${code}`, 300) }
  try {
    const res = JSON.parse(out)
    return {
      runs: res.runs ?? [],
      halt: res.halt,
      lease: res.lease ?? null,
      managerLimited: res.managerLimited ?? null,
      managerCodexAuth: res.managerCodexAuth ?? null,
    }
  } catch {
    return { error: line(`factory board printed no JSON: ${out || err}`, 300) }
  }
}

/** the halt state as the first part of the header: 'paused' or 'stopping', else '' */
export const haltText = halt => (halt === 'paused' || halt === 'stopping' ? halt : '')

/** the lease as one part of the header: 'lease: holder (kind)', or '' when no lease is on the board */
export const leaseText = lease =>
  lease?.holder ? `lease: ${lease.holder}${lease.kind ? ` (${lease.kind})` : ''}` : ''

/**
 * the header line of the board: the run counts, the limits, the manager context and the lease.
 * The mod never ticks, so it is always a reader: no part of the line says "read-only".
 */
export function headerText(state, context) {
  if (state.error)
    return `board failed: ${state.error}${state.staleSince ? ` · stale since ${clock(state.staleSince)}` : ''}`
  return [
    haltText(state.halt),
    statusText(state.runs ?? []) || 'no live runs',
    managerLimitText(state.managerLimited),
    managerContextText(context),
    managerCodexAuthText(state.managerCodexAuth),
    leaseText(state.lease),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** the red line of a failed manager context read, or '' when it worked or shows nothing to read */
export function contextProblem(code, out, err) {
  if (code !== 0) return line(`manager context: ${err || out || `exit ${code}`}`, 300)
  try {
    const e = JSON.parse(out).views?.['manager.context']?.error
    return e ? line(`manager context: ${e}`, 300) : ''
  } catch {
    return ''
  }
}

/** the clock time of a stale board, 'HH:MM' */
const clock = at => new Date(at).toTimeString().slice(0, 5)

/** the board header when the manager's Claude is limited: 'manager: Claude limited until HH:MM', else '' */
export function managerLimitText(limited) {
  if (!limited || typeof limited.until !== 'number') return ''
  const d = new Date(limited.until)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `manager: Claude limited until ${hh}:${mm}`
}

/** a count of tokens for a header: 950, 55.1k, 1.2M */
export const tokensText = n =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`

/** the manager.context value as one header part: 'manager claude-fable-5-2 · 55.1k tokens · 27.6% of 200.0k', else '' */
export function managerContextText(c) {
  if (!c || typeof c.model !== 'string' || typeof c.tokens !== 'number') return ''
  return `manager ${c.model} · ${tokensText(c.tokens)} tokens · ${c.percent}% of ${tokensText(c.window)}`
}

/** the result of `factory snapshot --views manager`: the manager.context value, or null (no session, a failure) */
export function parseContext(code, out) {
  if (code !== 0) return null
  try {
    const c = (j => j.views?.['manager.context'] ?? j)(JSON.parse(out))
    return c && typeof c.model === 'string' ? c : null
  } catch {
    return null
  }
}

/** the board header when the manager's Codex key is refused (claude-factory-y3f8w.10), else '' */
export function managerCodexAuthText(auth) {
  return auth ? 'manager codex: key refused' : ''
}

/** the result of `factory snapshot --views board` or `--views decisions`: { tick, decisions } for the tabs to share */
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
  const d = views?.interview
  return {
    tick,
    interview: Array.isArray(d) ? d : undefined,
    // a failed view keeps the old list; the panel draws this line in red
    interviewError: d && !Array.isArray(d) && d.error ? line(`interview: ${d.error}`, 300) : undefined,
  }
}

// Remote mode (claude-factory-hpmc.14): the manager runs on another machine, such as the AX task f-manager.

/**
 * the config.json text as { cli, home, machine? } (local or remote mode) or { server, cert, key, ca } (server mode,
 * claude-factory-gogxc.15), or null when it is neither. A config with both modes is null.
 */
export function parseConfig(text) {
  try {
    const c = JSON.parse(text)
    const str = k => typeof c?.[k] === 'string'
    const srv = ['server', 'cert', 'key', 'ca'].some(k => c?.[k] !== undefined)
    const loc = ['cli', 'home', 'machine'].some(k => c?.[k] !== undefined)
    if (srv) return !loc && ['server', 'cert', 'key', 'ca'].every(str) ? c : null
    if (!str('cli') || !str('home')) return null
    if (c.machine !== undefined && !str('machine')) return null
    return c
  } catch {
    return null
  }
}

// Server mode: one HTTPS call to /v1 with the person certificate, by curl. The mod holds no factory logic.

/** an Idempotency-Key of the form ^[A-Za-z0-9-]{8,128}$ */
export const idemKey = () => `mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** the curl call of one /v1 request. A refusal prints its body (--fail-with-body) and exits non-zero. */
export function serverCall(conf, method, path, body, key = idemKey()) {
  const args = [
    '-sS',
    '--fail-with-body',
    '--max-time',
    '20',
    '--cert',
    conf.cert,
    '--key',
    conf.key,
    '--cacert',
    conf.ca,
  ]
  if (method !== 'GET')
    args.push(
      '-X',
      method,
      '-H',
      'content-type: application/json',
      '-H',
      `Idempotency-Key: ${key}`,
      '-d',
      JSON.stringify(body ?? {}),
    )
  return ['curl', [...args, conf.server.replace(/\/+$/, '') + path]]
}

/** the one snapshot request of a beat */
export const snapshotPath = maxAge => `/v1/snapshot?views=board,interview,lease&maxAge=${maxAge}`

/** the request of a control button, as [method, path, body] */
export function actionReq(action, arg) {
  if (['stop', 'resume'].includes(action)) return ['POST', '/v1/halt', { mode: action }]
  if (action === 'abort' && arg) return ['POST', `/v1/runs/${encodeURIComponent(arg)}/abort`, {}]
  if (action === 'unhold' && arg) return ['POST', `/v1/rigs/${encodeURIComponent(arg)}/unhold`, {}]
  if (action === 'say' && arg) return ['POST', '/v1/manager/say', { text: arg }]
  throw new Error(`no such action: ${action}`)
}

/** the request of one answer in the Interview dialog */
export const answerReq = (item, option) =>
  item.kind === 'gate'
    ? ['POST', `/v1/runs/${encodeURIComponent(item.run)}/decide`, { outcome: option, note: '' }]
    : [
        'POST',
        `/v1/decisions/${encodeURIComponent(item.rig)}/${encodeURIComponent(item.bead)}/answer`,
        { text: option },
      ]

/** the worker screen path of a run */
export const screenPath = id => `/v1/runs/${encodeURIComponent(id)}/screen`

/** the options that send an exec or a file read to the machine of a remote config */
export const onOf = cfg => (cfg.machine ? { on: cfg.machine } : undefined)

/** a GET answer is reused this long (ms), so a click on a run does not call the pod again at once */
export const GET_CACHE_MS = 3_000

/**
 * The read-only calls of a beat (claude-factory-hpmc.23, ql0jz). The board and the decisions are two calls, so the
 * slow decisions (one bd call for each rig) never hold the board. `maxAge` (ms) lets the core answer from its cache.
 */
export const snapshotWords = (view, maxAge) => ['snapshot', '--views', view, '--max-age', String(maxAge)]
/** the board is at most this old (ms) on each beat; the first beat takes any cached board, so a screen opens at once */
export const BOARD_MAX_AGE = 6_000
export const FIRST_MAX_AGE = 3_600_000
/** the decisions are refreshed this often (ms) */
export const DECISIONS_MS = 60_000

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
  if (cfg.server || !cfg.machine) return null
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

/** A cached flows graph younger than this (ms) is not requested again. Before, each beat computed it again. */
export const FLOWS_MAX_AGE = 30_000

/** true if the cache has no graph for the flow id, or the graph is older than FLOWS_MAX_AGE */
export const flowDue = (cache, id, now) => !cache[id] || now - cache[id].at >= FLOWS_MAX_AGE

/**
 * Put the result of a flows job in the cache. The job started for the flow id `id`.
 * The graph goes under `id`, not under the id on screen.
 * The graph shows only if `id` is still the id on screen (`current`).
 */
export function flowResult(cache, current, id, flow, now) {
  return {
    cache: flow.graph ? { ...cache, [id]: { ...flow, at: now } } : cache,
    shown: id === current ? flow : undefined,
  }
}

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
