// The manager session: ticks every factory run, draws the console (a pane) and the band above
// the prompt, and wakes this session's model to patrol the factory. All run state lives with the
// factory CLI (../bin/factory); this module drives it and keeps only what the console shows.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  FactoryBacklog,
  FactoryBoard,
  FactoryDetail,
  FactoryDraft,
  FactoryMail,
  FactoryRig,
  FactoryRun,
  FactoryView,
} from '../types'
import {
  backlogView,
  band,
  boardView,
  footer,
  header,
  isLive,
  mailView,
  newView,
  runView,
  type Actions,
  type UI,
} from './views'
import { patrol } from './view'

const PANE = 'factory'
const TICK_MS = 5000
// ponytail: a heartbeat costs one manager turn per interval while workers run; make it a setting if that hurts
const PATROL_MS = 10 * 60_000
const board = atom({ plugin: 'factory', key: 'board' } as const, { runs: [], mail: [] } as FactoryBoard)
const view = atom({ plugin: 'factory', key: 'view' } as const, 'board' as FactoryView)
const selected = atom({ plugin: 'factory', key: 'selected' } as const, null as string | null)
const detail = atom({ plugin: 'factory', key: 'detail' } as const, null as FactoryDetail | null)
const peek = atom({ plugin: 'factory', key: 'peek' } as const, '')
const backlog = atom({ plugin: 'factory', key: 'backlog' } as const, [] as FactoryBacklog)
/** runs holding a worker, one sample a tick: the header's sparkline */
const history = atom({ plugin: 'factory', key: 'history' } as const, [] as number[])
const draft = atom(
  { plugin: 'factory', key: 'draft' } as const,
  {
    repo: '',
    factory: 'lifecycle',
    goal: '',
    mail: '',
    target: '',
    notes: {},
  } as FactoryDraft,
)
const VIEWS = new Set<string>(['board', 'run', 'backlog', 'mail', 'new'])

const manual = (cli: string) => `## Software factory manager
You run this session's herdr software factories, and the person runs them through you: they tell you what they want, you turn it into runs, keep the runs moving, and bring them only the decisions that are theirs. Each run is an xstate machine over a graph of stations; every station is worked by its own Claude session (a worker) in a herdr tab of the run's git worktree, and the outcome it reports routes the run along the graph. The runtime ticks every few seconds: it launches workers, resumes a lost session once, nudges an idle worker twice before failing it, and retries with backoff.
A message starting "[factory] patrol" is your loop. It lists what is new and the board; work through it in this order:
1. Mail: answer a worker's question yourself (\`mail\`) when the goal or the journal settles it; otherwise ask the person and name the run that waits.
2. Gates: show the person the question, the evidence (the pull request, the verify and review summaries) and the outcomes. Gates are their decisions, never yours: run \`${cli} decide <run> <outcome> "<note>"\` only with the outcome they chose (they confirm it again in a dialog).
3. Stuck stations: read the error, the journal and the worker's screen, then retry, goto, fork with a note, or abort. Say what you chose and why.
4. Workers that are blocked on a prompt, silent, or going in circles: read the pane, then \`poke\` the worker with a concrete steer or mail its station. Never approve a permission prompt for it.
5. Finished runs and free room: say what shipped. Read \`${cli} backlog\`: for each rig with room under its cap, hand the factory what is worth doing next there (\`queue\` or \`start\`). A rig with a goal is the person's standing direction: start the beads that advance it (a bead with a parent starts with \`start\`, not \`queue\`; read the repo's own \`bd ready\` and specs for them), most important and least blocked first, and file a bead for a missing piece. Without a goal, leave what needs the person's priority to them, and list it by rig.
6. Report to the person in at most three lines: what changed, what you did, what needs them. A heartbeat with nothing to do gets one line.
The factory CLI, through Bash:
- \`${cli} status [run]\`: every run, or one run's full journal
- \`${cli} mail <run> <station> "<text>"\`: answer or steer a worker (delivered into its session)
- \`${cli} poke <run> ["<steer>"]\`: nudge the worker at the run's current station; with no text it is told to report or say what blocks it
- \`${cli} retry <run>\` (a stuck station), \`${cli} goto <run> <station|done>\` (also skips a timed wait), \`${cli} abort <run>\`, \`${cli} fork <run> <station> "<note>"\`, \`${cli} rm <run>\` (finished runs)
- \`${cli} start <factory>[@station] <rig|repo> "<goal>"\`: factories are files in ${cli.replace(/bin\/factory$/, 'factories/')}; lifecycle covers build, release, incidents, optimization, refactoring and the monitor, maintain and improve sweeps
- \`herdr pane read <pane> --source recent --lines 80\`: see what a worker is doing
The factory works rigs: named repos, listed by \`${cli} rig\`. A rig's ready beads labeled \`factory\` start as runs, it keeps the sweeps it asks for running, and its own cap (\`--max\`) bounds its busy runs under the town's. A rig's name stands for its repo in every command. \`${cli} rig add <name> <repo> [factory] [--max n] [--sweeps monitor,maintain,improve|none] [--goal <text>]\` defines or redefines one and \`${cli} rig rm <name>\` drops it (its runs carry on); do either only when the person asks.
In a repo with beads, every run works a bead: its epic, whose children are the plan's tasks, with each station's report as a comment. A rig's backlog is its beads: \`${cli} queue <rig> <bead> [station]\` labels one \`factory\`; \`station:<name>\` starts it at that station; sweeps file what can wait unlabeled, for the person to prioritize. A bead deferred by a hold or an abort goes back to the factory when it is undeferred. \`${cli} start lifecycle <rig> <bead-id>\` runs one bead now.
A repo owns its factory once \`${cli} adopt <rig>\` copies the template to \`.factory/lifecycle.ts\` and it is committed: each run follows the version its starting commit holds, the improve sweep and postmortems propose changes to it, and those ship through review and the approve gate like any change. \`${cli} check <file>\` validates one. When the person wants the factory itself changed, file that as work on \`.factory/\` rather than editing it in this session.`

// runtime handles only: a hot reload starts them over, which ensureTicking allows for
const rt = {
  cli: '',
  timer: undefined as { cancel: () => void } | undefined,
  isTicking: false,
  isAutopilot: true,
  cwd: '',
  agents: new Map<string, string | null | undefined>(),
  /** manager mail no patrol has carried yet */
  unsent: [] as FactoryMail[],
  /** blocked workers a patrol already reported */
  seen: new Set<string>(),
  patrolAt: 0,
  isPatrolling: false,
}

async function factory($: EngineInterface, args: string[]) {
  const r = await $.process.run([rt.cli, ...args], { timeoutMs: 120_000 })
  return { isOk: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() }
}

async function tick($: EngineInterface) {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    const { isOk, out } = await factory($, ['tick'])
    if (!isOk) return $.ui.status(out.split('\n')[0]?.slice(0, 80))
    const res = JSON.parse(out) as {
      busy?: true
      runs: FactoryRun[]
      manager: FactoryMail[]
      started?: string[]
      rigs?: FactoryRig[]
    }
    if (res.busy) return
    await update($, board, b => ({ runs: res.runs, mail: [...b.mail, ...res.manager].slice(-50) }))
    const live = res.runs.filter(isLive)
    const busy = live.filter(r => !r.gate && r.sub !== 'waiting').length
    await update($, history, h => [...h, busy].slice(-120))
    await refresh($)

    const stuck = live.filter(r => r.sub === 'stuck').length
    const gates = live.filter(r => r.gate).length
    const notes = [stuck && `${stuck} stuck`, gates && `${gates} awaiting you`].filter(Boolean)
    $.ui.status(live.length ? [`${live.length} running`, ...notes].join(', ') : undefined)
    if (res.started?.length) $.ui.toast(`factory: started from beads ${res.started.join(', ')}`)
    for (const r of res.runs) {
      if (r.agent === 'blocked' && rt.agents.get(r.id) !== 'blocked')
        $.ui.toast(`factory: ${r.id} ${r.node} worker is waiting on a prompt in pane ${r.pane}`)
      rt.agents.set(r.id, r.agent)
    }

    if (res.manager.length) $.ui.toast(`factory: ${res.manager.length} message(s) for the manager`)
    if (rt.isAutopilot) {
      rt.unsent.push(...res.manager)
      await patrolNow($, res.runs, res.rigs ?? [])
    }
  } catch (err) {
    $.ui.status(String(err).slice(0, 80))
  } finally {
    rt.isTicking = false
  }
}

/** wake this session's model to patrol, one patrol at a time */
async function patrolNow($: EngineInterface, runs: FactoryRun[], rigs: FactoryRig[]) {
  if (rt.isPatrolling) return
  const now = await $.clock.now()
  const due = patrol(runs, rt.unsent, rt.seen, now - rt.patrolAt >= PATROL_MS, rigs)
  if (!due) return
  rt.unsent = []
  for (const key of due.keys) rt.seen.add(key)
  rt.patrolAt = now
  rt.isPatrolling = true
  // not awaited: it resolves only once the session is idle and the patrol's turn starts
  void $.prompt
    .submit({ text: due.text })
    .catch(() => {})
    .finally(() => {
      rt.isPatrolling = false
    })
}

async function ensureTicking($: EngineInterface) {
  if (rt.timer) return
  const root = await $.fs.stat($.plugin.root, { resolve: true })
  rt.cli = `${root.realPath ?? $.plugin.root}/../bin/factory`
  rt.timer = $.clock.every(TICK_MS, () => void tick($))
  void tick($)
}

/** what the open view needs beyond the board: a run's whole record and its worker's screen, or the backlog */
async function refresh($: EngineInterface) {
  const shown = await read($, view)
  if (shown === 'run') {
    const id = await read($, selected)
    if (!id) return
    const { isOk, out } = await factory($, ['show', id])
    if (!isOk) return
    const d = JSON.parse(out) as FactoryDetail
    await update($, detail, () => d)
    const tail = d.pane
      ? await $.process
          .run(['herdr', 'pane', 'read', d.pane, '--source', 'recent-unwrapped', '--lines', '10'])
          .catch(() => undefined)
      : undefined
    await update($, peek, () => (tail?.exitCode === 0 ? tail.stdout.trimEnd() : ''))
  } else if (shown === 'backlog') {
    const { isOk, out } = await factory($, ['backlog'])
    if (isOk) await update($, backlog, () => JSON.parse(out) as FactoryBacklog)
  }
}

async function act($: EngineInterface, args: string[]) {
  const { out } = await factory($, args)
  $.ui.toast(out.split('\n').at(-1) || `${args.join(' ')}: queued`)
  await tick($)
}

async function show($: EngineInterface, next: FactoryView, run?: string) {
  if (run && run !== (await read($, selected))) {
    await update($, selected, () => run)
    await update($, detail, () => null)
    await update($, peek, () => '')
    await update($, draft, d => ({ ...d, target: '', mail: '' }))
  }
  await update($, view, () => next)
  await $.ui.open({ id: PANE, title: 'Factory', focus: true, rows: 40 })
  await refresh($)
}

/** a gate answered with the note the person typed for it, which then clears */
async function decide($: EngineInterface, run: string, outcome: string) {
  const note = (await read($, draft)).notes[run] ?? ''
  await act($, ['decide', run, outcome, ...(note ? [note] : [])])
  await update($, draft, d => ({ ...d, notes: { ...d.notes, [run]: '' } }))
}

async function startRun($: EngineInterface) {
  const d = await read($, draft)
  if (!d.goal.trim()) return $.ui.toast('factory: write a goal first')
  await act($, ['start', d.factory.trim() || 'lifecycle', d.repo.trim() || rt.cwd, d.goal.trim()])
  await update($, draft, x => ({ ...x, goal: '' }))
  await show($, 'board')
}

/** herdr focuses the worker's pane: the person takes over that terminal */
async function jump($: EngineInterface, pane: string) {
  const r = await $.process.run(['herdr', 'agent', 'focus', pane]).catch(() => undefined)
  if (r?.exitCode !== 0) $.ui.toast(`factory: could not focus ${pane}`)
}

function actions($: EngineInterface): Actions {
  return {
    cli: (...args) => void act($, args),
    show: (next, run) => void show($, next, run),
    draft: patch => void update($, draft, d => ({ ...d, ...patch })),
    decide: (run, outcome) => void decide($, run, outcome),
    start: () => void startRun($),
    jump: pane => void jump($, pane),
  }
}

export const register: Register = (on, options) => {
  rt.isAutopilot = options.autopilot !== false

  on('session.start', async ($, e, next) => {
    rt.cwd = e.cwd
    await $.command.register({
      name: 'factory',
      description:
        'Factory dashboard; or a factory command (start, status, decide, rig, queue, mail, poke, retry, goto, fork, abort, rm)',
      argumentHint: '[start|status|decide|rig|queue|mail|poke|retry|goto|fork|abort|rm ...]',
    })
    await ensureTicking($)
    return next(e)
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    await ensureTicking($) // a hot reload drops the timer
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    // `/factory`, `/factory backlog`, `/factory run <id>`: the console at that view
    if (!args.length || VIEWS.has(args[0]!)) {
      await show($, (args[0] as FactoryView | undefined) ?? 'board', args[1])
      return { text: 'Factory console opened.' }
    }
    const { out } = await factory($, args)
    void tick($)
    return { text: out || 'ok' }
  })

  // a gate is the person's call: the model may run decide only after they confirm it here
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!/\bfactory\s+decide\b/.test(e.command)) return next(e)
    const question = `The manager model wants to decide a factory gate: ${e.command.slice(0, 300)}. Allow it?`
    const answer = await $.ui.ask(question, ['Allow', 'Deny']).catch(() => 'Deny')
    return answer === 'Allow'
      ? next(e)
      : { deny: 'The person did not confirm this gate decision. Ask them which outcome they want.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!rt.cli) return composed
    return {
      sections: [...composed.sections, { id: 'factory:manager', text: manual(rt.cli), scope: 'session' }],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as unknown as UI
    const { Box } = ui
    // nothing here may be named h: JSX compiles to calls of the global h
    const [b, shown, d, tail, bl, samples, dr, now] = await Promise.all([
      read($, board),
      read($, view),
      read($, detail),
      read($, peek),
      read($, backlog),
      read($, history),
      read($, draft),
      $.clock.now(),
    ])
    const p = { ui, act: actions($), width: e.props.bodyColumns, now }
    const body =
      shown === 'run'
        ? runView(p, d, tail, dr)
        : shown === 'backlog'
          ? backlogView(p, bl)
          : shown === 'mail'
            ? mailView(p, b)
            : shown === 'new'
              ? newView(p, dr, rt.cwd)
              : boardView(p, b, dr)
    return (
      <Box flexDirection="column">
        {header(p, b, samples, shown)}
        {body}
        {footer(p)}
      </Box>
    )
  })

  // with the console closed, the band keeps the factory in view and answers the first gate in place
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, board)
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (e.props.hasSurvey || isOpen || !b.runs.some(isLive)) return next(e)
    const ui = $.ui.resolve(e) as unknown as UI
    const p = { ui, act: actions($), width: e.props.bodyColumns, now: await $.clock.now() }
    return band(p, b, await read($, draft))
  })
}
