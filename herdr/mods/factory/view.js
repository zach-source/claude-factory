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

/** the step names and how often each runs (ms). A step that is due and finds no work makes no model call. */
export const STEPS = { patrol: 60_000, brief: 120_000, review: 300_000, pm: 3_600_000, decisions: 300_000 }

/**
 * The factory commands one beat starts, as { name, words }.
 * A remote mod only reads: `tick --board` shows the board and changes nothing, and `decisions` lists.
 * It never runs tick, patrol, brief, review or pm, so it never takes the manager lease.
 */
export function beatJobs(cfg, state, ran, now) {
  if (cfg.machine)
    return [
      { name: 'board', words: ['tick', '--board'] },
      { name: 'decisions', words: ['decisions'] },
    ]
  const jobs = [{ name: 'tick', words: ['tick', '--keep-mail'] }]
  // a manager without the lease only shows the board (claude-factory-s01d.2)
  if (state.readOnly || state.halt) return jobs
  for (const [name, every] of Object.entries(STEPS))
    if (now - (ran[name] ?? 0) >= every)
      jobs.push({
        name,
        words:
          name === 'decisions' ? ['decisions'] : name === 'review' ? ['review', '--once'] : [name, '--once'],
      })
  return jobs
}

/** the shell words of a control button; only these CLI commands are allowed */
export function actionWords(action, arg) {
  if (['stop', 'resume'].includes(action)) return [action]
  if (['abort', 'unhold', 'say'].includes(action) && arg) return [action, arg]
  throw new Error(`no such action: ${action}`)
}

/** the terminal command for the manager chat of a remote config, or null for a local one */
export const chatArgv = cfg => (cfg.machine ? ['hc', 'attach', `${cfg.machine}/manager`] : null)

/** the exec call of a remote job: [command, args]. It runs in the foreground, since hc exec kills what a command leaves behind. */
export const directJob = (cfg, words) => ['env', [`FACTORY_HOME=${cfg.home}`, cfg.cli, ...words]]
