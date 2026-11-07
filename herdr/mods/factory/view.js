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
    }
  } catch {
    return { error: line(`factory tick printed no JSON: ${out || err}`, 300) }
  }
}
