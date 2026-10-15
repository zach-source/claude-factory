// The manager session: ticks every factory run, draws the console (a pane) and the band above
// the prompt, and wakes this session's model to patrol the factory. All run state lives with the
// factory CLI (../bin/factory); this module drives it and keeps only what the console shows.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  FactoryBacklog,
  FactoryPrs,
  FactoryBoard,
  FactoryDecisions,
  FactoryDetail,
  FactoryDraft,
  FactoryMail,
  FactoryRig,
  FactoryRun,
  FactoryView,
} from '../types'
import {
  backlogView,
  rigsView,
  band,
  boardView,
  footer,
  header,
  interviewView,
  isLive,
  mailView,
  prsView,
  type Actions,
  type UI,
} from './views'
import {
  beadInterviews,
  interviewAnswer,
  interviewPrompt,
  interviews,
  line,
  mailKey,
  patrol,
  quickAnswer,
  statusText,
  withProposals,
  type Interview,
} from './view'

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
const backlogType = atom({ plugin: 'factory', key: 'backlogType' } as const, 'all')
const prs = atom({ plugin: 'factory', key: 'prs' } as const, [] as FactoryPrs)
const decisions = atom(
  { plugin: 'factory', key: 'decisions' } as const,
  { rigs: [], proposals: {} } as FactoryDecisions,
)
/** runs holding a worker, one sample a tick: the header's sparkline */
const history = atom({ plugin: 'factory', key: 'history' } as const, [] as number[])
const draft = atom(
  { plugin: 'factory', key: 'draft' } as const,
  {
    mail: '',
    target: '',
    notes: {},
    replies: {},
    answered: {},
  } as FactoryDraft,
)
const VIEWS = new Set<string>(['board', 'backlog', 'mail', 'prs', 'rigs', 'interview'])

const manual = (cli: string) => `## Software factory manager
You run this session's herdr software factories, and the person runs them through you: they tell you what they want, you turn it into runs, keep the runs moving, and bring them only the decisions that are theirs. Each run is an xstate machine over a graph of stations; every station is worked by its own Claude session (a worker) in a herdr tab of the run's git worktree, and the outcome it reports routes the run along the graph. The runtime ticks every few seconds: it launches workers, resumes a lost session once, nudges an idle worker twice before failing it, and retries with backoff.
A message starting "[factory] patrol" is your loop. It lists what is new and the board; work through it in this order:
1. Mail: answer a worker's question yourself (\`mail\`) when the goal, the journal or the factory's memory (\`${cli} memory search <query>\`) settles it; otherwise ask the person and name the run that waits. What the person decides that later runs should follow too, save: \`${cli} memory add "<summary>" "<the decision and why>"\`.
2. Gates: show the person the question, the evidence (the pull request, the verify and review summaries) and the outcomes. Gates are their decisions, never yours: run \`${cli} decide <run> <outcome> "<note>"\` only with the outcome they chose (they confirm it again in a dialog; \`${cli} decisions answer\` opens that same confirm dialog, for the same reason).
3. Stuck stations: read the error, the journal and the worker's screen, then retry, goto, fork with a note, or abort. Say what you chose and why.
   Parked stations mail you "<station> is parked, waiting on: …": a worker reported blocked, so no attempt is spent and a fresh one rechecks on its own. When it waits on the person (a review, a merge, a decision), ask them and name the pull request (they can also answer a parked or stuck station's question in the console's Interview tab, \`/factory interview\`): deploy parks on a pull request until the person merges it, which is their ship decision, so never merge it for them; when it is resolved, mail that station and it wakes at once. \`${cli} waiting\` lists everything that waits on the person, with how to answer each: show it when they ask what they owe the factory.
A message starting "[factory] interview" follows the person pressing 'Interview me' in the console: it lists open questions (parked or stuck runs, human-flagged and owner-only bd beads) that have no options yet. Propose 2 or more short, concrete choices for each with \`${cli} decisions propose <key> "<question>" "<a | b>"\`, using the item's own key exactly as given; never for a \`gate:\` key, which only the person decides, and never for a \`prompt:\` key (a blocked worker waiting on a prompt in its pane): look at it instead.
4. Workers that are blocked on a prompt, silent, or going in circles: read the pane, then \`poke\` the worker with a concrete steer or mail its station. Never approve a permission prompt for it.
5. Finished runs and free room: say what shipped. Read \`${cli} backlog\`: for each rig with room under its cap, hand the factory what is worth doing next there (\`queue\` or \`start\`). A rig with a goal is the person's standing direction: start the beads that advance it (one bead a run: an epic whose children exist is refused, so start its children; a bead carrying its owner's decisions (metadata.owner_decisions) is refused too, and is theirs: pass --owned only when the person names that bead (that start also opens the same confirm dialog as a gate); a bead with a parent starts with \`start\`, not \`queue\`; read the repo's own \`bd ready\` and specs for them), most important and least blocked first, and file a bead for a missing piece. Without a goal, leave what needs the person's priority to them, and list it by rig.
6. Skill proposals: mail from "dream" lists the manager skills it wrote, changed or reaped for you. Read each SKILL.md: install it (\`${cli} skills install <name>\`) only when its commands are right and safe for this factory and it saves you real work; otherwise \`${cli} skills reject <name> "<why>"\`. Tell the person what you installed.
7. Report to the person in at most three lines: what changed, what you did, what needs them. A heartbeat with nothing to do gets one line.
The factory CLI, through Bash:
- \`${cli} status [run]\`: every run, or one run's full journal
- \`${cli} mail <run> <station> "<text>"\`: answer or steer a worker (delivered into its session)
- \`${cli} poke <run> ["<steer>"]\`: nudge the worker at the run's current station; with no text it is told to report or say what blocks it
- \`${cli} retry <run>\` (a stuck station), \`${cli} goto <run> <station|done>\` (also skips a timed wait), \`${cli} abort <run>\`, \`${cli} fork <run> <station> "<note>"\`, \`${cli} rm <run>\` (finished runs)
- \`${cli} start <factory>[@station] <rig|repo> "<goal>"\`: factories are files in ${cli.replace(/bin\/factory$/, 'factories/')}; lifecycle covers build, release, incidents, optimization, refactoring and the monitor, maintain and improve sweeps
- \`herdr pane read <pane> --source recent --lines 80\`: see what a worker is doing
The factory works rigs: named repos, listed by \`${cli} rig\`. A rig's ready beads labeled \`factory\` start as runs, it keeps the sweeps it asks for running, and its own cap (\`--max\`) bounds its busy runs under the town's. A rig's name stands for its repo in every command. \`${cli} rig add <name> <repo> [factory] [--max n] [--sweeps monitor,maintain,improve|none] [--goal <text>]\` defines or redefines one and \`${cli} rig rm <name>\` drops it (its runs carry on); do either only when the person asks.
In a repo with beads, every run works a bead: its epic, whose children are the plan's tasks, with each station's report as a comment. A rig's backlog is its beads: \`${cli} queue <rig> <bead> [station]\` labels one \`factory\`; \`station:<name>\` starts it at that station; sweeps file what can wait unlabeled, for the person to prioritize. A bead deferred by a hold or an abort goes back to the factory when it is undeferred. \`${cli} start lifecycle <rig> <bead-id>\` runs one bead now.
A repo owns its factory once \`${cli} adopt <rig>\` copies the template to \`.factory/lifecycle.ts\` and it is committed: each run follows the version its starting commit holds, the improve sweep and postmortems propose changes to it, and those ship through review and the person's merge like any change. \`${cli} check <file>\` validates one. When the person wants the factory itself changed, file that as work on \`.factory/\` rather than editing it in this session.
Your skills (the Skill tool) are the factory's playbooks for work you keep repeating, written by the dream from your past sessions: when one fits the task, use it rather than working it out again.`

// runtime handles only: a hot reload starts them over, which ensureTicking allows for
const rt = {
  cli: '',
  /** this session's factory: every command the model runs works it, wherever its shell has cd'd */
  home: '',
  timer: undefined as { cancel: () => void } | undefined,
  isTicking: false,
  /** a tick was asked for while one ran: run another right after it, so an action shows at once */
  isTickWanted: false,
  isAutopilot: true,
  agents: new Map<string, string | null | undefined>(),
  /** manager mail no patrol has carried yet */
  unsent: [] as FactoryMail[],
  /** blocked workers a patrol already reported */
  seen: new Set<string>(),
  patrolAt: 0,
  /** when the PRs tab last asked GitHub */
  prsAt: 0,
  /** when the Backlog tab last listed every rig's beads */
  backlogAt: 0,
  /** when the interview tab last swept bd for decisions */
  decisionsAt: 0,
  /** the sig of the board and rig goals the manager was last sent, and when */
  sig: undefined as string | undefined,
  sigAt: 0,
  isPatrolling: false,
  /** told once that the console sits above the prompt because the layout cannot dock it */
  isInlineTold: false,
}

async function factory($: EngineInterface, args: string[]) {
  const r = await $.process.run([rt.cli, ...args], { timeoutMs: 120_000 })
  const isOk = r.exitCode === 0
  // stderr carries logs (a tick's reaped panes, its children's warnings): mixed into the JSON, it broke the parse
  return { isOk, out: (isOk ? r.stdout : `${r.stdout}${r.stderr}`).trim() }
}

/** a failed tick: say why in full enough to act on, and mark the board stale until a tick succeeds */
async function tickFailed($: EngineInterface, why: string) {
  const now = await $.clock.now()
  $.ui.status(`factory tick failed: ${line(why, 160)}`)
  await update($, board, b => ({ ...b, staleSince: b.staleSince ?? now }))
}

async function tick($: EngineInterface) {
  if (rt.isTicking) {
    rt.isTickWanted = true
    return
  }
  rt.isTicking = true
  try {
    const { isOk, out } = await factory($, ['tick'])
    if (!isOk) return await tickFailed($, out)
    const res = JSON.parse(out) as {
      busy?: true
      runs: FactoryRun[]
      manager: FactoryMail[]
      rigs?: FactoryRig[]
      halt?: 'stopping' | 'paused'
    }
    if (res.busy) return
    await update($, board, b => ({
      runs: res.runs,
      mail: [...b.mail, ...res.manager].slice(-50),
      rigs: res.rigs ?? [],
      halt: res.halt,
    }))
    const live = res.runs.filter(isLive)
    const busy = live.filter(r => !r.gate && r.sub !== 'waiting').length
    await update($, history, h => [...h, busy].slice(-120))
    // not awaited: a slow tab fetch (backlog, decisions) must not hold the board's next tick
    void refresh($)

    $.ui.status(statusText(res.runs))
    for (const r of res.runs) {
      if (r.agent === 'blocked' && rt.agents.get(r.id) !== 'blocked')
        $.ui.toast(`factory: ${r.id} ${r.node} worker is waiting on a prompt in pane ${r.pane}`)
      rt.agents.set(r.id, r.agent)
    }

    if (res.manager.length) $.ui.toast(`factory: ${res.manager.length} message(s) for the manager`)
    if (rt.isAutopilot) {
      rt.unsent.push(...res.manager)
      // paused, nothing should start: only mail wakes the manager, not the heartbeat or a rig's goal
      if (!res.halt || rt.unsent.length)
        await patrolNow($, res.halt ? [] : res.runs, res.halt ? [] : (res.rigs ?? []))
    }
  } catch (err) {
    await tickFailed($, String(err))
  } finally {
    rt.isTicking = false
    if (rt.isTickWanted) {
      rt.isTickWanted = false
      void tick($)
    }
  }
}

/**
 * A background fork of the manager inherits its HERDR_PANE_ID and this mod, and would patrol as a second
 * manager (and its hooks would type into the real manager's pane). Only the session herdr sees running in
 * the pane patrols; outside herdr, or when herdr can't say, this session does.
 */
async function isPaneSession($: EngineInterface) {
  const r = await $.process.run(['sh', '-c', '[ -n "$HERDR_PANE_ID" ] && herdr pane get "$HERDR_PANE_ID"'], {
    timeoutMs: 10_000,
  })
  try {
    const owner = JSON.parse(r.stdout).result.pane.agent_session?.value
    return !owner || owner === (await $.session.id())
  } catch {
    return true
  }
}

/** wake this session's model to patrol, one patrol at a time */
async function patrolNow($: EngineInterface, runs: FactoryRun[], rigs: FactoryRig[]) {
  if (rt.isPatrolling) return
  if (!(await isPaneSession($))) return
  const now = await $.clock.now()
  // ponytail: the whole board again each hour, so a manager that compacted it away gets it back
  const last = now - rt.sigAt < 3_600_000 ? rt.sig : undefined
  const due = patrol(runs, rt.unsent, rt.seen, now - rt.patrolAt >= PATROL_MS, rigs, last)
  // a due heartbeat whose board repeats the last one sent wakes nobody: patrolAt stays put, so a
  // real change right after this tick still wakes on the next 5 s tick, not at the next 10 min mark
  if (!due) return
  if (due.sig !== last) [rt.sig, rt.sigAt] = [due.sig, now]
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
  // the session's directory decides its factory once; the model's Bash cd's freely after that
  const { isOk, out } = await factory($, ['home'])
  if (isOk) rt.home = out
  rt.timer = $.clock.every(TICK_MS, () => void tick($))
  void tick($)
}

/** a stored view of 'run', from before the Run tab folded into Board, reads as 'board'; the one
 * place both `readView` (refresh's fetch gate) and the render switch map it, so they can't drift */
export const mapView = (v: string): FactoryView => (v === 'run' ? 'board' : (v as FactoryView))

async function readView($: EngineInterface): Promise<FactoryView> {
  return mapView(await read($, view))
}

/** what the open view needs beyond the board: a run's whole record and its worker's screen, or the backlog */
async function refresh($: EngineInterface) {
  const shown = await readView($)
  if (shown === 'board') {
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
    // ponytail: a bd call per rig, ~20 s, at most every 30 s while the tab is open
    const now = await $.clock.now()
    if (rt.backlogAt && now - rt.backlogAt < 30_000) return
    rt.backlogAt = now
    const { isOk, out } = await factory($, ['backlog'])
    if (isOk) await update($, backlog, () => JSON.parse(out) as FactoryBacklog)
  } else if (shown === 'prs') {
    // ponytail: a gh call per rig, at most once a minute while the tab is open
    const now = await $.clock.now()
    if (now - rt.prsAt < 60_000) return
    rt.prsAt = now
    const { isOk, out } = await factory($, ['prs'])
    if (isOk) await update($, prs, () => JSON.parse(out) as FactoryPrs)
  } else if (shown === 'interview') {
    // ponytail: a bd call per rig, at most once a minute while the tab is open; the button forces one now
    const now = await $.clock.now()
    if (now - rt.decisionsAt < 60_000) return
    await sweepDecisions($)
  }
}

/** every rig's open bd decisions, into the interview tab's open list. A rig's own bd error is carried in its
 * row (drawn by interviewView); a failed call itself (the CLI never ran, or its JSON did not parse) is told
 * with a status line instead of dropped silently, so the person knows the open list may be stale. */
async function sweepDecisions($: EngineInterface) {
  rt.decisionsAt = await $.clock.now()
  const { isOk, out } = await factory($, ['decisions'])
  if (isOk) await update($, decisions, () => JSON.parse(out) as FactoryDecisions)
  else $.ui.status(`factory decisions failed: ${out.split('\n')[0]?.slice(0, 80)}`)
}

/**
 * the 'Interview me' button: refresh bd decisions now (sweepDecisions, also used by the throttled auto-refresh),
 * then once ask the manager to propose options for whatever is still bare after merging any stored proposals
 * (interviewPrompt excludes gates and anything that already has options). Skipped like a patrol: never from a
 * background fork of the manager, and never while one patrol or interview round is already in its turn.
 */
async function interviewMe($: EngineInterface) {
  await sweepDecisions($)
  if (rt.isPatrolling) return
  if (!(await isPaneSession($))) return
  const [b, dec, d] = await Promise.all([read($, board), read($, decisions), read($, draft)])
  const answered = Object.fromEntries((d.interviewed ?? []).map(x => [x.key, x.answer]))
  const items = withProposals(
    [...interviews(b.runs, answered), ...beadInterviews(dec.rigs, answered)],
    dec.proposals,
  )
  const text = interviewPrompt(items)
  if (!text) return
  rt.isPatrolling = true
  // not awaited: it resolves only once the session is idle and this round's turn starts, like a patrol
  void $.prompt
    .submit({ text })
    .catch(() => {})
    .finally(() => {
      rt.isPatrolling = false
    })
}

async function act($: EngineInterface, args: string[]) {
  const { isOk, out } = await factory($, args)
  $.ui.toast(out.split('\n').at(-1) || `${args.join(' ')}: queued`)
  rt.backlogAt = 0 // a queue or start changes the backlog: the next tick lists it again
  void tick($)
  return isOk
}

async function show($: EngineInterface, next: FactoryView, run?: string) {
  if (run && run !== (await read($, selected))) {
    await update($, selected, () => run)
    await update($, detail, () => null)
    await update($, peek, () => '')
    await update($, draft, d => ({ ...d, target: '', mail: '' }))
  }
  if (next === 'backlog') rt.backlogAt = 0 // opening the tab lists it now, not at the next throttle window
  await update($, view, () => next)
  // columns: the dock's width beside a fullscreen transcript; rows: its height inline above the prompt
  await $.ui.open({ id: PANE, title: 'Factory', focus: true, rows: 40, columns: 100 })
  await refresh($)
}

/** opens a run's card in place on the board, or (run === null) closes whichever card is open */
async function select($: EngineInterface, run: string | null) {
  if (run === null) {
    await update($, selected, () => null)
    await update($, detail, () => null)
    await update($, peek, () => '')
    await update($, draft, d => ({ ...d, target: '', mail: '' }))
    return
  }
  await show($, 'board', run)
}

/** a gate answered with the note the person typed for it, which then clears */
async function decide($: EngineInterface, run: string, outcome: string) {
  const note = (await read($, draft)).notes[run] ?? ''
  if (!(await act($, ['decide', run, outcome, ...(note ? [note] : [])]))) return
  // the decision lands at the next tick, seconds away under load: the board says so now, so the gate's
  // buttons do not look like they did nothing
  await update($, board, b => ({
    ...b,
    runs: b.runs.map(r => (r.id === run ? { ...r, gate: undefined, agent: `${outcome} decided` } : r)),
  }))
  await update($, draft, d => ({ ...d, notes: { ...d.notes, [run]: '' } }))
}

/**
 * the person's quick answer from the mailbox, mailed to the worker. The manager hears of it at its next
 * patrol, so it does not answer the same question again.
 */
async function answer($: EngineInterface, m: FactoryMail, kind: 'approve' | 'reject' | 'reply') {
  const d = await read($, draft)
  const key = mailKey(m)
  const reply = quickAnswer(
    m,
    (await read($, board)).runs.find(r => r.id === m.run),
    kind,
    d.replies?.[key] ?? '',
  )
  if (!reply) return $.ui.toast(`factory: ${m.run} has ended, nobody would read the answer`)
  if (!(await act($, ['mail', m.run, reply.to, reply.text]))) return
  rt.unsent.push({
    run: m.run,
    from: 'person',
    text: `answered ${m.from}'s message in the console: ${reply.text}`,
    at: Date.now(),
  })
  await update($, draft, x => ({
    ...x,
    replies: { ...x.replies, [key]: '' },
    answered: Object.fromEntries([...Object.entries(x.answered ?? {}), [key, reply.text]].slice(-100)),
  }))
}

/**
 * the person's answer to an interview question. A parked or stuck run's answer mails its station, which wakes
 * it; a stuck one is retried with it in its inbox. A bd decision's answer runs `factory decisions answer`,
 * which comments on the bead (and closes it, for a human-flagged one); an owner-only bead's 'start now' also
 * starts it, and a failed start returns before recording the answer, so the item stays open and the person
 * can try again rather than it quietly vanishing while the bead never ran. Gate and prompt items never reach
 * here: their buttons act directly (decide, jump). The manager hears of it at its next patrol.
 */
async function interview($: EngineInterface, iv: Interview, choice?: string) {
  const typed = (await read($, draft)).replies?.[iv.key] ?? ''
  const text = interviewAnswer(iv, choice, typed)
  if (!text) return $.ui.toast('factory: pick an option or type an answer')
  if (iv.kind === 'bead' || iv.kind === 'owned') {
    if (!(await act($, ['decisions', 'answer', iv.rig!, iv.bead!, text]))) return
    if (iv.kind === 'owned' && choice === 'start now') {
      const row = (await read($, decisions)).rigs.find(r => r.rig === iv.rig)
      if (!(await act($, ['start', row?.factory ?? 'lifecycle', iv.rig!, iv.bead!, '--owned']))) return
    }
  } else {
    if (!(await act($, ['mail', iv.run!, iv.node!, text]))) return
    if (iv.kind === 'stuck') await act($, [choice === 'abort' ? 'abort' : 'retry', iv.run!])
  }
  const at = await $.clock.now()
  rt.unsent.push({
    run: iv.run ?? iv.bead ?? iv.key,
    from: 'person',
    text: `answered ${iv.node ?? iv.rig ?? iv.kind}'s question in the console: ${text}`,
    at,
  })
  // not named answer: the mod loader takes any second `answer` in the file for a redeclared hook function
  const given = [choice, typed.trim()].filter(Boolean).join(': ')
  await update($, draft, d => ({
    ...d,
    replies: { ...d.replies, [iv.key]: '' },
    interviewed: [
      ...(d.interviewed ?? []),
      {
        key: iv.key,
        run: iv.run,
        node: iv.node,
        rig: iv.rig,
        bead: iv.bead,
        question: iv.question,
        answer: given,
        at,
      },
    ].slice(-100),
  }))
}

/** herdr focuses the worker's pane: the person takes over that terminal */
async function jump($: EngineInterface, pane: string) {
  const r = await $.process.run(['herdr', 'agent', 'focus', pane]).catch(() => undefined)
  if (r?.exitCode !== 0) $.ui.toast(`factory: could not focus ${pane}`)
}

/** which Bash commands the manager model may not run without the person's explicit Allow: a gate decision,
 * answering a person's bd decision, and starting a bead that carries its owner's decisions. Each is the
 * person's call, not the model's, even though FACTORY_FROM (which refuses these for a worker) is unset here.
 * The shell still runs a backslash-newline line continuation and a quoted newline as one command, so this
 * normalizes the first away (bash joins a `\`-newline pair with NO character, even mid-word, so this drops
 * it rather than replacing it with a space) and matches across the second ([\s\S] instead of [^\n]) rather
 * than testing the raw text verbatim. */
function gatedCommand(rawCommand: string): { question: string; deny: string } | null {
  const command = rawCommand.replace(/\\\n/g, '')
  if (/\bfactory\s+decide\b/.test(command))
    return {
      question: `The manager model wants to decide a factory gate: ${command.slice(0, 300)}. Allow it?`,
      deny: 'The person did not confirm this gate decision. Ask them which outcome they want.',
    }
  if (/\bfactory\s+decisions\s+answer\b/.test(command))
    return {
      question: `The manager model wants to answer a person's bd decision: ${command.slice(0, 300)}. Allow it?`,
      deny: 'The person did not confirm this answer. Ask them what they want to say instead.',
    }
  if (/\bfactory\s+start\b[\s\S]*--owned\b/.test(command))
    return {
      question: `The manager model wants to start a bead carrying its owner's decisions: ${command.slice(0, 300)}. Allow it?`,
      deny: 'The person did not confirm starting this owner-only bead.',
    }
  return null
}

function actions($: EngineInterface): Actions {
  return {
    cli: (...args) => void act($, args),
    show: (next, run) => void show($, next, run),
    select: run => void select($, run),
    backlogType: t => void update($, backlogType, () => t),
    draft: patch => void update($, draft, d => ({ ...d, ...patch })),
    decide: (run, outcome) => void decide($, run, outcome),
    answer: (m, kind) => void answer($, m, kind),
    interview: (iv, choice) => void interview($, iv, choice),
    jump: pane => void jump($, pane),
    sweep: () => void interviewMe($),
  }
}

export const register: Register = (on, options) => {
  rt.isAutopilot = options.autopilot !== false

  on('session.start', async ($, e, next) => {
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
    // `/factory`, `/factory backlog`, `/factory run <id>` (an alias for the board with <id> open)
    const requested = args[0] === 'run' ? 'board' : args[0]
    if (!args.length || (requested && VIEWS.has(requested))) {
      await show($, (requested as FactoryView | undefined) ?? 'board', args[1])
      return { text: 'Factory console opened.' }
    }
    const { out } = await factory($, args)
    void tick($)
    return { text: out || 'ok' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // the model's shell cd's into rigs to read them: its factory commands still work this factory
    const pinned = rt.home ? { ...e, command: `export FACTORY_HOME='${rt.home}'\n${e.command}` } : e
    // a gate, a bd decision answer and an owner-only start are the person's call: the model may run
    // any of them only after they confirm it here, since it has no other way to intercept the manager's
    // own shell (FACTORY_FROM, which refuses these for workers, is unset in the manager session)
    const gated = gatedCommand(e.command)
    if (!gated) return next(pinned)
    const choice = await $.ui.ask(gated.question, ['Allow', 'Deny']).catch(() => 'Deny')
    return choice === 'Allow' ? next(pinned) : { deny: gated.deny }
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
    const [b, rawShown, d, tail, bl, bt, pr, samples, dr, dec, now, sel] = await Promise.all([
      read($, board),
      read($, view),
      read($, detail),
      read($, peek),
      read($, backlog),
      read($, backlogType),
      read($, prs),
      read($, history),
      read($, draft),
      read($, decisions),
      $.clock.now(),
      read($, selected),
    ])
    // a stored view of 'run', from before the Run tab folded into Board, reads as 'board'
    const shown = mapView(rawShown as string)
    const p = { ui, act: actions($), width: e.props.bodyColumns, now }
    // only the fullscreen layout docks a pane beside the chat; herdr, like tmux, defaults to the main screen
    if (e.props.placement === 'inline' && !rt.isInlineTold) {
      rt.isInlineTold = true
      $.ui.toast(
        'factory: the console docks to the right of the chat only in the fullscreen layout: start Claude with CLAUDE_CODE_NO_FLICKER=1 (and 110+ columns)',
      )
    }
    const body =
      shown === 'backlog'
        ? backlogView(p, bl, bt, dr)
        : shown === 'mail'
          ? mailView(p, b, dr)
          : shown === 'prs'
            ? prsView(p, pr, b)
            : shown === 'rigs'
              ? rigsView(p, b)
              : shown === 'interview'
                ? interviewView(p, b, dr, dec)
                : boardView(p, b, dr, sel, d, tail)
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
