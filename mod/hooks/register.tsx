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
  FactoryPatrolLogEntry,
  FactoryPlan,
  FactoryPmLogEntry,
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
  hasAgentTool,
  interviewAnswer,
  interviewPrompt,
  isValidPlan,
  line,
  mailKey,
  openInterviews,
  patrol,
  patrolsText,
  pmDue,
  pmRetryDelay,
  quickAnswer,
  statusText,
  type Interview,
} from './view'

const PANE = 'factory'
const TICK_MS = 5000
// ponytail: a heartbeat costs one manager turn per interval while workers run; make it a setting if that hurts
const PATROL_MS = 10 * 60_000
/** a patrol subagent that never answers (a dead model turn, a wedged tool) stops blocking new ones */
const PATROL_WATCHDOG_MS = 15 * 60_000
/** a denied spawn waits this long before the next attempt, instead of asking again every tick */
const PATROL_RETRY_MS = 60_000
const PATROL_TYPE = 'factory:patrol'
/** a run the main chat touched stays out of a patrol for this long: the person and a patrol
 * must not act on the same run at once */
const PATROL_HOLD_MS = 5 * 60_000
/** matches a patrol's own Bash command that acts on a run: recorded for the patrol log */
const PATROL_VERB = /\bfactory\s+(mail|poke|retry|goto|fork|abort|rm|queue|start)\b/
/** Matches a main-chat Bash command that acts on one run. The 2nd capture group holds the run id.
 * `touchedTargets` below uses `matchAll` with this pattern to find every match in a compound
 * command (`&&`, `;`), not only the first (claude-factory-72v.20). `matchAll` needs the `g` flag
 * set here. `String.prototype.matchAll` clones the pattern on each call, so reuse of this one
 * `RegExp` object across calls is safe. */
const TOUCH_RE = /\bfactory\s+(mail|poke|retry|goto|fork|abort|rm|decide)\s+(\S+)/g
/** patrol-log.jsonl keeps at most this many lines, oldest dropped first */
const PATROL_LOG_CAP = 50
/** how many of the newest log entries a fresh patrol's own prompt carries, and `/factory patrols` prints */
const PATROL_LOG_RECENT = 10
const PM_TYPE = 'factory:pm'
/** a pm turn that never answers (a dead model turn) stops blocking the next one. This mirrors the patrol's own watchdog. */
const PM_WATCHDOG_MS = 15 * 60_000
/** pm-log.jsonl keeps at most this many lines, oldest dropped first */
const PM_LOG_CAP = 50
/** verbs act()'s own args[0] uses for the same run-acting commands, for the console's buttons */
const TOUCH_VERBS = new Set(['mail', 'poke', 'retry', 'goto', 'fork', 'abort', 'rm', 'decide'])
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
/** the last patrol's log entry, drawn in the pane header and band; null before any patrol wrote one */
const lastPatrol = atom(
  { plugin: 'factory', key: 'lastPatrol' } as const,
  null as FactoryPatrolLogEntry | null,
)
/** the pm's last plan, refreshed from `<home>/plan.json` each tick (a cheap fs read); drawn in the
 * header, the band and the Rigs tab. `null` before the pm ever wrote one, the same convention
 * `lastPatrol` uses (`$.state.set` only ever stores JSON data, which has no `undefined`). */
const plan = atom({ plugin: 'factory', key: 'plan' } as const, null as FactoryPlan | null)
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
You run this session's herdr software factories, and the person runs them through you: they tell you what they want, you turn it into runs, keep the runs moving, and bring them only the decisions that are theirs. Each run is an xstate machine over a graph of stations; every station is worked by its own Claude session (a worker) in a herdr tab of the run's git worktree, and the outcome it reports routes the run along the graph. The runtime ticks every few seconds: it launches workers, resumes a lost session once, nudges an idle worker twice before failing it, and retries with backoff. A hidden patrol subagent, not this session, answers mail, works stuck stations and starts backlog work on its own timer; you see only what is the person's to decide. A hidden pm subagent also ranks each rig's next work on its own timer; its proposals (a priority, a goal or an owner-only change) reach the person as a decision item in the Interview tab, never applied by either of you.
Gates: when the person asks you to decide one, show them the question, the evidence (the pull request, the verify and review summaries) and the outcomes, then run \`${cli} decide <run> <outcome> "<note>"\` only with the outcome they chose (they confirm it again in a dialog; \`${cli} decisions answer\` opens that same confirm dialog, for the same reason). A gate is always the person's call: never decide one on your own.
\`${cli} rig add <name> <repo> [factory] [--max n] [--sweeps monitor,maintain,improve|none] [--goal <text>]\` defines or redefines a rig and \`${cli} rig rm <name>\` drops it (its runs carry on); do either only when the person asks. When the person wants the factory's own definition changed, file that as work on \`.factory/\` rather than editing it in this session.
A message starting "[factory] interview" follows the person pressing 'Interview me' in the console: it lists open questions (parked or stuck runs, human-flagged and owner-only bd beads) that still need a short, clear shape. For each, run \`${cli} decisions propose <key> "<question>" "<label: effect | label: effect>" [--context "<sentence>"]\`, using the item's own key exactly as given: a question of 160 characters or fewer that names the decision in plain words, an optional \`--context\` sentence of 200 characters or fewer, and 2-4 options, each "label: effect" with a label of 40 characters or fewer and an effect of 100 characters or fewer. Mark at most one option recommended, by adding "(recommended)" after its effect. When the answer is already on record (the person decided this elsewhere), answer it directly instead of proposing: for an \`iv:\` key, mail that station with it; for a \`bd:\` or \`own:\` key, there is no station to mail, so run \`${cli} decisions answer <rig> <bead> "<text>"\` instead. Never propose for a \`gate:\` key, which only the person decides, and never for a \`prompt:\` key (a blocked worker waiting on a prompt in its pane) -- look at it instead. An \`own:\` key (an owner-only bead) keeps its two fixed options, start now and not now: propose only a shorter question or context for it, never new options.
Report to the person in at most three lines: what changed, what you did, what needs them. A heartbeat with nothing to do gets one line.
Your skills (the Skill tool) are the factory's playbooks for work you keep repeating, written by the dream from your past sessions: when one fits the task, use it rather than working it out again.
When the person says a skill proposal needs review (the patrol's report toasted this), run \`${cli} skills\` to list it, read each file it names, then \`${cli} skills install <name>\` only when its commands are right and safe for this factory and it saves real work, or \`${cli} skills reject <name> "<why>"\` otherwise. Tell the person what you installed.`

/** the patrol subagent's whole system prompt (omitClaudeMd: true replaces the session's). It never
 * reaches the person directly: $.agent.spawn's prompt is its one turn, and its answer goes to a
 * log and a toast, never into the main chat. */
const PATROL = (cli: string) => `## Factory patrol
You are the factory manager's patrol, a subagent it spawns on a timer or on new mail so this work never queues behind the person's own chat with the manager. Nothing you say here reaches the person directly: mail a worker, decide nothing a person must decide, and end with the short report below.
You get what is new and the board; work through it in this order, acting only through the factory CLI below:
1. Mail: answer a worker's question yourself (\`mail\`) when the goal, the journal or the factory's memory (\`${cli} memory search <query>\`) settles it. Otherwise mail that worker's own station to report blocked, with a line \`Question: <the decision, in plain words>\` and \`Options: <label>: <effect> | <label>: <effect>\`, so the person sees it in the console's Interview tab; never wait on them yourself. Save a decision later runs should follow too: \`${cli} memory add --kind rule "<summary>" "<the decision and why>"\` (add \`--until <bead|owner/repo#N|YYYY-MM-DD>\` too if the summary or body names a bead or PR).
2. Stuck stations: read the error, the journal and the worker's screen, then retry, goto, fork with a note, or abort. Say what you chose and why.
   Parked stations mail you "<station> is parked, waiting on: …": a worker reported blocked, so no attempt is spent and a fresh one rechecks on its own. When it waits on the person (a review, a merge, a decision), mail that station to report blocked with Question:/Options: as above, naming the pull request if there is one: deploy parks on a pull request until the person merges it, which is their ship decision, so never merge it for them. \`${cli} waiting\` lists everything that waits on the person, with how to answer each.
   A stuck mail that says "<station> already re-planned once" means its round cap has an onRounds target: it already went to plan once and hit the cap again. Never goto it to implement, or to another station in its own loop. Instead, goto plan with a note, abort, or report it to the person.
   A mail that says "<station> reported <outcome> again on <AC ids>" names a station that reported the same outcome twice in a row on the same acceptance criterion. Read both of its reports. Then mail implement one concrete steer, or goto plan. Never goto implement with no new direction.
3. Workers that are blocked on a prompt, silent, or going in circles: read the pane, then \`poke\` the worker with a concrete steer or mail its station. Never approve a permission prompt for it.
4. Finished runs and free room: note what shipped. Read \`${cli} backlog\`: for each rig with room under its cap, hand the factory what is worth doing next there (\`queue\` or \`start\`). A rig with a goal is the person's standing direction: start the beads that advance it (one bead a run: an epic whose children exist is refused, so start its children; a bead carrying its owner's decisions (metadata.owner_decisions) is refused too, and is theirs: never pass --owned yourself; a bead with a parent starts with \`start\`, not \`queue\`; read the repo's own \`bd ready\` and specs for them), most important and least blocked first, and file a bead for a missing piece. Without a goal, leave what needs the person's priority to them, and list it by rig. When the prompt carries a Plan, give each rig with room its next work from that list, in order, skipping a bead already in a run or refused; with no Plan, choose as above.
5. Skill proposals: mail from "dream" lists the manager skills it wrote, changed or reaped. You have no way to install or reject one yourself, so put it in your report's first line ("N skill proposal(s) need review") instead of your usual line there: this toasts straight to the person, who can ask the manager to work it.
Never act on a run a board row marks held: the person is on it, leave it for the next patrol.
Never run \`${cli} decide\`, \`${cli} decisions answer\` or \`${cli} start ... --owned\`: each is denied to you outright. Gates and owner-only beads are the person's alone; report them, never decide them.
The factory CLI, through Bash:
- \`${cli} status [run]\`: every run, or one run's full journal
- \`${cli} mail <run> <station> "<text>"\`: answer or steer a worker (delivered into its session)
- \`${cli} poke <run> ["<steer>"]\`: nudge the worker at the run's current station; with no text it is told to report or say what blocks it
- \`${cli} retry <run>\` (a stuck station), \`${cli} goto <run> <station|done>\` (also skips a timed wait), \`${cli} abort <run>\`, \`${cli} fork <run> <station> "<note>"\`, \`${cli} rm <run>\` (finished runs)
- \`${cli} start <factory>[@station] <rig|repo> "<goal>"\`: factories are files in ${cli.replace(/bin\/factory$/, 'factories/')}; lifecycle covers build, release, incidents, optimization and refactoring, sweeps covers the standing monitor, maintain and improve passes
- \`herdr pane read <pane> --source recent --lines 80\`: see what a worker is doing
The factory works rigs: named repos, listed by \`${cli} rig\`. A rig's ready beads labeled \`factory\` start as runs, \`${cli} sweep\` starts one run per pass for each sweep it asks for, on that sweep's own cadence, and its own cap (\`--max\`) bounds its busy runs under the town's. A rig's name stands for its repo in every command.
In a repo with beads, every run works a bead: its epic, whose children are the plan's tasks, with each station's report as a comment. A rig's backlog is its beads: \`${cli} queue <rig> <bead> [station]\` labels one \`factory\`; \`station:<name>\` starts it at that station; sweeps file what can wait unlabeled, for the person to prioritize. A bead deferred by a hold or an abort goes back to the factory when it is undeferred.
A repo owns its factory once \`${cli} adopt <rig>\` copies the template to \`.factory/lifecycle.ts\` and it is committed: each run follows the version its starting commit holds, the improve sweep and postmortems propose changes to it, and those ship through review and the person's merge like any change.
End your reply with a report of at most 3 lines: the first line says what needs the person, or "nothing" when there is none; the rest say what changed and what you did.`

/** the pm subagent's whole system prompt (claude-factory-dun). It has no Bash, so this prompt, the
 * facts the manager's own \`agent.spawn\` call carries as its only turn, and its own answer are the
 * whole of it: it reads and ranks, and changes nothing itself. */
const PM = (cli: string) => `## Factory pm
You are the factory manager's pm, a hidden subagent it spawns about once an hour, and again soon
after a run finishes. You have no \`${cli}\`, no Bash, and no other tool: you cannot read a file or
run a command outside this turn. Everything you need is in the JSON below, one entry per rig
(each rig's ready candidates, its open epics and their progress, beads it closed in the last day,
which beads a live run owns right now, and starvation or plan-gap findings the factory code
already found). The manager's own code checks your answer by hand, writes \`plan.json\` and files
any finding or proposal as a bd bead: you change nothing yourself.

For each rig with candidates, put them in the order that best serves its goal. Stay inside the
priority band bd already gave each one: you reorder only within one priority, and a bead never
moves ahead of a bead in a numerically lower (higher-value) priority. Give each one a one-line
why, 120 characters or fewer. Leave a rig with no candidates out of your answer; it then keeps its
candidates in their own default order with no custom why.

Propose, never decide, any change to a P0 or P1 bead's priority, a rig's goal, or an owner-only
step: name the rig, the bead if there is one, the change, and why. Nothing applies a proposal; a
person reads it later as a decision item. Only propose where a fact or finding below calls for it.

End your reply with exactly one fenced \`json\` block and nothing else after it, in this shape:
\`\`\`json
{"rigs": {"<rig>": [{"id": "<bead id>", "why": "<120 chars or fewer>"}]}, "proposals": [{"rig": "<rig>", "bead": "<id, optional>", "change": "<what changes>", "why": "<why>"}]}
\`\`\`
An id that is not one of that rig's own candidates is dropped, and so is a field in the wrong
shape. Write no other fenced block, and nothing after this one.`

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
  /** the running patrol subagent's id. $.agent.spawn sets it; its turn.complete clears it */
  patrolId: undefined as string | undefined,
  /** the last 20 patrol subagent ids. The watchdog uses this list to ignore a late turn.complete */
  patrolIds: [] as string[],
  /** when the running patrol started, for the watchdog; undefined while none runs. A started
   * patrol's own clock time can be 0 (a fresh session, or every mod test's mock clock), so this
   * must not be a bare number compared for truthiness: 0 is falsy and would hide a real start. */
  patrolStartedAt: undefined as number | undefined,
  /** a denied spawn's next attempt; 0 means try at once */
  retryAt: 0,
  /** interviewMe's own one-at-a-time guard, apart from isPatrolling: it still runs in the main loop */
  isInterviewing: false,
  /** a run id's last touch by the main chat: a Bash factory command or a console action. A
   * patrol leaves a recently touched run alone for PATROL_HOLD_MS. */
  touched: new Map<string, number>(),
  /** the running patrol's own factory commands this run, each clipped to 200 chars. turn.complete
   * reads and resets this into the patrol log (claude-factory-72v.5). */
  patrolActions: [] as string[],
  /** told once that the console sits above the prompt because the layout cannot dock it */
  isInlineTold: false,
  isPmEnabled: true,
  /** when the pm last wrote a confirmed plan turn; committed only once a spawn is confirmed, the
   * same as rt.patrolAt. 0 means never. */
  pmAt: 0,
  isPlanning: false,
  /** the running pm subagent's id. $.agent.spawn sets it; its turn.complete clears it */
  pmId: undefined as string | undefined,
  /** the last 20 pm subagent ids, the same reason rt.patrolIds keeps the patrol's own */
  pmIds: [] as string[],
  /** when the running pm started, for its watchdog; undefined while none runs. Compared to
   * undefined, never bare truthiness, since 0 is a real start time too (patrolStartedAt's own
   * comment explains why). */
  pmStartedAt: undefined as number | undefined,
  /** a live->not-live drop this tick, or an earlier one still pending through the debounce window */
  pmWanted: false,
  /** the live run ids as of the last pmNow call, to notice a drop (live -> not live) next tick */
  liveIds: new Set<string>(),
  /** the next attempt after a failed spawn or a failed `factory plan facts` call; 0 means try at once */
  pmRetryAt: 0,
  /** pm spawns that failed (a deny or a throw), or `factory plan facts` calls that failed
   * (claude-factory-4hb), since the last spawn that worked; feeds `pmRetryDelay`'s backoff
   * (claude-factory-dun.29). A working spawn resets this to 0. */
  pmFailures: 0,
  /** set once this process finds the manager has no Agent tool (claude-factory-dun.29): gathers no
   * more facts and spawns nothing until a restart starts a fresh process. `undefined` means not
   * blocked, or not checked yet. */
  pmBlocked: undefined as string | undefined,
  /** true while `pmNow` awaits `factory plan facts`, before `isPlanning` is set (claude-factory-dun.12):
   * `tick()` calls `pmNow` with `void`, so a later tick must not start a second facts gather */
  isGatheringFacts: false,
}

async function factory($: EngineInterface, args: string[]) {
  // ponytail: the API's 10-minute ceiling; a tick over 13 runs on slow EFS took 137s, past the old 120s
  const r = await $.process.run([rt.cli, ...args], { timeoutMs: 600_000 })
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
    // cheap (one fs read, no CLI subprocess): refreshed every tick, not gated behind a tab's own view
    const freshPlan = await readPlan($)
    await update($, plan, () => freshPlan ?? null)
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
    // the pm runs on its own cadence, independent of autopilot/the patrol: a person driving the
    // main chat still wants a fresh plan. Halted, nothing runs, not even the pm. Not awaited
    // (claude-factory-dun.12), the same reason refresh() above is not: `factory plan facts` must
    // not hold up the next tick's board, mail and patrol.
    if (!res.halt) void pmNow($, res.runs)
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

/**
 * True once `$.agent.list()` names `agentId` as a `PATROL_TYPE` agent. This is the only sure way
 * to tell the running patrol's own subagent from any other one (claude-factory-72v.9). It
 * returns false on any error, including "no implementation". Most tests have only one subagent,
 * so they never need to mock `agent.list`. A missing mock there must read as "not the patrol",
 * never as "assume yes".
 */
async function isPatrolAgent($: EngineInterface, agentId: string) {
  try {
    const agents = await $.agent.list()
    return agents.some(a => a.id === agentId && a.type === PATROL_TYPE)
  } catch {
    return false
  }
}

/** `<home>/patrol-log.jsonl`, oldest first; `[]` before the first patrol ever wrote one, or with no home yet */
async function readPatrolLog($: EngineInterface): Promise<FactoryPatrolLogEntry[]> {
  if (!rt.home) return []
  const text = await $.fs.read(`${rt.home}/patrol-log.jsonl`).catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        return [JSON.parse(l) as FactoryPatrolLogEntry]
      } catch {
        return [] // a half-written line from a crashed write: skip it rather than lose the rest
      }
    })
}

/** appends one patrol's outcome, keeping only the newest PATROL_LOG_CAP lines */
async function appendPatrolLog($: EngineInterface, entry: FactoryPatrolLogEntry) {
  if (!rt.home) return
  const log = [...(await readPatrolLog($)), entry].slice(-PATROL_LOG_CAP)
  await $.fs.write(`${rt.home}/patrol-log.jsonl`, `${log.map(e => JSON.stringify(e)).join('\n')}\n`)
}

/** True once `$.agent.list()` names `agentId` as a `PM_TYPE` agent, the same check `isPatrolAgent`
 * makes for the patrol. Returns false on any error, including "no implementation". */
async function isPmAgent($: EngineInterface, agentId: string) {
  try {
    const agents = await $.agent.list()
    return agents.some(a => a.id === agentId && a.type === PM_TYPE)
  } catch {
    return false
  }
}

/** `<home>/pm-log.jsonl`, oldest first; `[]` before the first pm turn ever wrote one, or with no home yet */
async function readPmLog($: EngineInterface): Promise<FactoryPmLogEntry[]> {
  if (!rt.home) return []
  const text = await $.fs.read(`${rt.home}/pm-log.jsonl`).catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        return [JSON.parse(l) as FactoryPmLogEntry]
      } catch {
        return [] // a half-written line from a crashed write: skip it rather than lose the rest
      }
    })
}

/** appends one pm turn's outcome, keeping only the newest PM_LOG_CAP lines */
async function appendPmLog($: EngineInterface, entry: FactoryPmLogEntry) {
  if (!rt.home) return
  const log = [...(await readPmLog($)), entry].slice(-PM_LOG_CAP)
  await $.fs.write(`${rt.home}/pm-log.jsonl`, `${log.map(e => JSON.stringify(e)).join('\n')}\n`)
}

/** `<home>/plan.json`, the pm's last ranking; `undefined` with no home yet, no file, invalid
 * JSON, or a malformed shape (a rig entry missing `items`/`findings`, claude-factory-dun.18).
 * `patrol()` (view.ts) itself checks freshness, so a stale plan here still reaches it, the same
 * as a missing one, and the prompt falls back the same way for both. */
async function readPlan($: EngineInterface): Promise<FactoryPlan | undefined> {
  if (!rt.home) return undefined
  const text = await $.fs.read(`${rt.home}/plan.json`).catch(() => '')
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isValidPlan(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Patrol, one at a time, as a hidden `factory:patrol` subagent. This adds no turn to the main chat.
 * A watchdog clears a patrol stuck past PATROL_WATCHDOG_MS (a dead model turn, a wedged tool). So
 * one bad patrol does not block every later one.
 *
 * A denied spawn leaves `rt.unsent`, `rt.seen` and `rt.patrolAt` as they were. A hook refused the
 * spawn. The code tries again after PATROL_RETRY_MS, so no mail is lost.
 *
 * A rejected spawn falls back to the pre-subagent path, `$.prompt.submit`, once for this patrol.
 * An old manager with no Agent tool in its `--tools` causes this. A status line says so. The
 * fallback repeats on every later due patrol, until the person restarts the manager.
 */
async function patrolNow($: EngineInterface, runs: FactoryRun[], rigs: FactoryRig[]) {
  const now = await $.clock.now()
  // patrolStartedAt is 0 at the first patrol of a fresh session (and of every mod test, whose
  // mock clock also starts at 0): a bare truthy check skipped the watchdog there forever, since
  // 0 is falsy. Compare to undefined instead, the only value that means "never started".
  if (rt.isPatrolling && rt.patrolStartedAt !== undefined && now - rt.patrolStartedAt >= PATROL_WATCHDOG_MS) {
    rt.isPatrolling = false
    $.ui.status('factory: a patrol ran past 15 min with no answer; the watchdog freed the next one')
  }
  if (rt.isPatrolling) return
  if (now < rt.retryAt) return
  if (!(await isPaneSession($))) return
  // drop a run outside PATROL_HOLD_MS, not only skip it: this keeps rt.touched small
  for (const [id, at] of rt.touched) if (now - at >= PATROL_HOLD_MS) rt.touched.delete(id)
  const hold = new Set(rt.touched.keys())
  // ponytail: the whole board again each hour, so a manager that compacted it away gets it back
  const last = now - rt.sigAt < 3_600_000 ? rt.sig : undefined
  // a cold subagent has no memory of earlier patrols: these let it see what they already did
  const log = (await readPatrolLog($)).slice(-PATROL_LOG_RECENT).flatMap(e => e.actions)
  const plan = await readPlan($)
  const due = patrol(
    runs,
    rt.unsent,
    rt.seen,
    now - rt.patrolAt >= PATROL_MS,
    rigs,
    last,
    hold,
    log,
    plan,
    now,
  )
  // a due heartbeat whose board repeats the last one sent wakes nobody: patrolAt stays put, so a
  // real change right after this tick still wakes on the next 5 s tick, not at the next 10 min mark
  if (!due) return
  rt.isPatrolling = true
  rt.patrolStartedAt = now
  rt.patrolActions = []
  try {
    const res = await $.agent.spawn({
      subagentType: PATROL_TYPE,
      prompt: due.text,
      description: 'factory patrol',
    })
    if (res.deny) {
      rt.isPatrolling = false
      rt.retryAt = now + PATROL_RETRY_MS
      $.ui.status(`factory: the patrol spawn was denied: ${line(res.deny, 160)}`)
      return
    }
    // claude-factory-72v.10: this commit, like rt.unsent/rt.seen/rt.patrolAt below, waits until the
    // spawn is confirmed. A denied spawn that committed rt.sig first lost the next heartbeat: the
    // retry, run with the same lastSig the denied one already set, saw no sig change and so no
    // news, and patrol() returned null (view.ts L369) for up to an hour (sigAt's own refresh).
    if (due.sig !== last) [rt.sig, rt.sigAt] = [due.sig, now]
    rt.unsent = due.kept
    for (const key of due.keys) rt.seen.add(key)
    rt.patrolAt = now
    rt.patrolId = res.agentId
    if (res.agentId) rt.patrolIds = [...rt.patrolIds, res.agentId].slice(-20)
  } catch (err) {
    // an old manager with no Agent tool in --tools: the same commit and fallback the old code did
    if (due.sig !== last) [rt.sig, rt.sigAt] = [due.sig, now]
    rt.unsent = due.kept
    for (const key of due.keys) rt.seen.add(key)
    rt.patrolAt = now
    $.ui.status(
      `factory: the patrol spawn failed (${line(String(err), 100)}); it fell back to the main chat. Restart the manager to fix it.`,
    )
    // claude-factory-72v.13: manual() no longer carries the patrol's own loop rules (PATROL does).
    // The fallback must carry them itself, or the main chat gets due.text with no rules to work it.
    void $.prompt
      .submit({ text: `${PATROL(rt.cli)}\n\n${due.text}` })
      .catch(() => {})
      .finally(() => {
        rt.isPatrolling = false
      })
  }
}

/**
 * The pm, one at a time, as a hidden `factory:pm` subagent (claude-factory-dun.5). This runs on its
 * own cadence (`pmDue`, view.ts), not every patrol: once an hour, and again soon after a run
 * finishes. It is independent of `rt.isAutopilot`: it is a standing background job, not the main
 * chat's own patrol loop, so it keeps running even with autopilot off.
 *
 * The pm has no Bash. This function gathers its facts itself (`factory plan facts`), spawns the
 * pm with that output as its one turn, and does nothing else: the pm's own `turn.complete` hook
 * below reads its answer and runs `factory plan set`. A watchdog clears a pm turn stuck past
 * PM_WATCHDOG_MS, the same way PATROL_WATCHDOG_MS clears a stuck patrol.
 *
 * A denied spawn, or a spawn that throws, leaves `rt.pmAt` untouched, so the next due check tries
 * again rather than waiting a full PM_INTERVAL_MS. Unlike the patrol, a failed pm spawn has no
 * `$.prompt.submit` fallback: the main chat has no use for raw plan-facts JSON.
 *
 * `tick()` calls this with `void`, not `await` (claude-factory-dun.12): `factory plan facts` can
 * run several `bd` calls and must never hold up the board, mail or patrol for the next 5s tick.
 * `rt.isGatheringFacts` guards the gap this opens: without it, a tick that starts while an
 * earlier `plan facts` call is still running (before `rt.isPlanning` is set, just below) could
 * start a second one.
 *
 * claude-factory-dun.29: a manager session started before Agent joined the engine's own
 * `--tools` list has no Agent tool, so every `$.agent.spawn` throws. A session like that must
 * stop before `factory plan facts` (several `bd` calls on every rig), not retry forever: once
 * `rt.pmBlocked` is set, this function returns at once on every later call. Only a restart, a
 * fresh process, clears it. A spawn that fails for any other reason (a deny, or a throw with the
 * Agent tool present) backs off `pmRetryDelay(rt.pmFailures)` instead of a fixed 60 s wait.
 *
 * claude-factory-4hb: a failed `factory plan facts` call backs off and logs the same way. A
 * `bd` outage is one cause. It uses the same `rt.pmFailures` counter. A mixed run of facts and
 * spawn failures still doubles its wait, up to the 60 min cap. This stops `factory plan facts`
 * from retrying every 60 s forever.
 */
async function pmNow($: EngineInterface, runs: FactoryRun[]) {
  if (!rt.isPmEnabled || rt.pmBlocked) return
  const now = await $.clock.now()
  if (rt.isPlanning && rt.pmStartedAt !== undefined && now - rt.pmStartedAt >= PM_WATCHDOG_MS) {
    rt.isPlanning = false
    $.ui.status('factory: a pm turn ran past 15 min with no answer; the watchdog freed the next one')
  }
  if (rt.isPlanning || rt.isGatheringFacts) return
  if (now < rt.pmRetryAt) return
  if (!(await isPaneSession($))) return
  // a run dropping live (done or aborted) since the last check wakes the pm again, after a
  // debounce: committed every call, due or not, so a drop during a long pm turn is not lost
  const liveIds = new Set(runs.filter(isLive).map(r => r.id))
  const liveDropped = [...rt.liveIds].some(id => !liveIds.has(id))
  rt.liveIds = liveIds
  const plan = await readPlan($)
  // claude-factory-dun.15: a hot reload or a new session resets rt.pmAt to 0, but the plan on
  // disk still carries its own `at`. pmDue folds that in, so a fresh plan right after a reload
  // does not look stale just because this session never ran the pm yet.
  const { due, wanted } = pmDue(now, rt.pmAt, plan?.at, liveDropped, rt.pmWanted)
  rt.pmWanted = wanted
  if (!due) return
  // the Agent-tool check, before any `bd` call: a missing `tool.list` event (an old engine, or a
  // test with no mock) throws, which reads as "unknown" (claude-factory-dun.28), the same path
  // this session took before this check existed.
  let toolNames: string[] | undefined
  try {
    toolNames = (await $.tool.list()).map(t => t.name)
  } catch {
    toolNames = undefined
  }
  if (hasAgentTool(toolNames) === false) {
    rt.pmBlocked = 'this manager has no Agent tool'
    $.ui.status(`factory: the pm is blocked: ${rt.pmBlocked}`)
    try {
      await appendPmLog($, { at: now, reason: 'blocked', durationMs: 0, error: rt.pmBlocked })
    } catch (err) {
      $.ui.status(`factory: failed to write the pm log: ${line(String(err), 160)}`)
    }
    return
  }
  rt.isGatheringFacts = true
  const { isOk, out: facts } = await factory($, ['plan', 'facts']).finally(() => {
    rt.isGatheringFacts = false
  })
  if (!isOk) {
    rt.pmFailures += 1
    rt.pmRetryAt = now + pmRetryDelay(rt.pmFailures)
    $.ui.status(`factory: plan facts failed: ${line(facts, 160)}`)
    try {
      await appendPmLog($, { at: now, reason: 'facts-failed', durationMs: 0, error: line(facts, 300) })
    } catch (err) {
      $.ui.status(`factory: failed to write the pm log: ${line(String(err), 160)}`)
    }
    return
  }
  rt.isPlanning = true
  rt.pmStartedAt = now
  try {
    const res = await $.agent.spawn({ subagentType: PM_TYPE, prompt: facts, description: 'factory pm' })
    if (res.deny) {
      rt.isPlanning = false
      rt.pmFailures += 1
      rt.pmRetryAt = now + pmRetryDelay(rt.pmFailures)
      const error = line(res.deny, 300)
      $.ui.status(`factory: the pm spawn was denied: ${line(res.deny, 160)}`)
      try {
        await appendPmLog($, { at: now, reason: 'spawn-failed', durationMs: 0, error })
      } catch (err) {
        $.ui.status(`factory: failed to write the pm log: ${line(String(err), 160)}`)
      }
      return
    }
    // committed only once the spawn is confirmed, the same reason patrolNow waits for its own
    rt.pmFailures = 0
    rt.pmAt = now
    rt.pmId = res.agentId
    if (res.agentId) rt.pmIds = [...rt.pmIds, res.agentId].slice(-20)
  } catch (err) {
    // no $.prompt.submit fallback here (unlike the patrol's own catch): raw facts JSON is nothing
    // the main chat can act on. rt.pmAt stays untouched, so the plan still reads as stale. A throw
    // (claude-factory-dun.11, not only `res.deny` above) backs off: 60 s, 120 s, 240 s, doubling up
    // to a 60 min cap (claude-factory-dun.29), so a manager that throws on every spawn does not
    // re-run `factory plan facts` every 60 s forever.
    rt.isPlanning = false
    rt.pmFailures += 1
    rt.pmRetryAt = now + pmRetryDelay(rt.pmFailures)
    const error = line(String(err), 300)
    $.ui.status(`factory: the pm spawn failed (${line(String(err), 100)}); it will try again when next due.`)
    try {
      await appendPmLog($, { at: now, reason: 'spawn-failed', durationMs: 0, error })
    } catch (e2) {
      $.ui.status(`factory: failed to write the pm log: ${line(String(e2), 160)}`)
    }
  }
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
 * then once ask the manager to propose options for whatever still needs one, the same open list the console
 * draws (interviewPrompt excludes a gate and a prompt, and anything that already needs no proposal). Skipped
 * like a patrol: never from a background fork of the manager. This still runs in the main loop (its own
 * `$.prompt.submit`, not a subagent), so its own `isInterviewing` flag guards it, apart from a patrol's
 * `isPatrolling`: the two may run at once.
 */
async function interviewMe($: EngineInterface) {
  await sweepDecisions($)
  if (rt.isInterviewing) return
  if (!(await isPaneSession($))) return
  const [b, dec, d] = await Promise.all([read($, board), read($, decisions), read($, draft)])
  const answered = Object.fromEntries((d.interviewed ?? []).map(x => [x.key, x.answer]))
  const items = openInterviews(b.runs, dec.rigs, dec.proposals, answered)
  const text = interviewPrompt(items)
  if (!text) return
  rt.isInterviewing = true
  // not awaited: it resolves only once the session is idle and this round's turn starts, like a patrol
  void $.prompt
    .submit({ text })
    .catch(() => {})
    .finally(() => {
      rt.isInterviewing = false
    })
}

async function act($: EngineInterface, args: string[]) {
  // the console acts on a run too: hold it out of the next patrol, same as a main-chat Bash command
  if (args[1] && TOUCH_VERBS.has(args[0] ?? '')) rt.touched.set(args[1], await $.clock.now())
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
 * starts it, and a failed start stops before recording that member's answer, so it stays open and the person
 * can try again rather than it quietly vanishing while the bead never ran. Gate and prompt items never reach
 * here: their buttons act directly (decide, jump).
 *
 * `mergeSame` may have folded other open items into this one (same bead, or the same question in the same
 * rig): `iv.also`. The same choice goes down each member's own path in turn -- its own mail or decisions
 * answer, its own retry/abort or start -- and every member's key lands in `draft.interviewed`, so none of
 * them asks the question again. The manager hears of each at its next patrol.
 *
 * A later member's action can fail. By then an earlier member's own action may already have gone through:
 * its mail sent, or its bead already holds a comment. This function records the earlier member's entry
 * before it stops. That member then does not ask its question again, even though the round did not finish.
 */
async function interview($: EngineInterface, iv: Interview, choice?: string) {
  const typed = (await read($, draft)).replies?.[iv.key] ?? ''
  const given = [choice, typed.trim()].filter(Boolean).join(': ')
  const at = await $.clock.now()
  const entries: NonNullable<FactoryDraft['interviewed']> = []
  // Clear the typed reply only when every member succeeds. If a member's mail, decisions answer, or
  // start fails, keep the typed reply. The person does not lose their text when part of the round
  // fails. Still flush `entries`: a member that already succeeded this round does not ask again.
  const flush = async (clearReply: boolean) =>
    update($, draft, d => ({
      ...d,
      replies: clearReply ? { ...d.replies, [iv.key]: '' } : d.replies,
      interviewed: [...(d.interviewed ?? []), ...entries].slice(-100),
    }))
  for (const member of [iv, ...(iv.also ?? [])]) {
    const text = interviewAnswer(member, choice, typed)
    if (!text) {
      await flush(false)
      return $.ui.toast('factory: pick an option or type an answer')
    }
    if (member.kind === 'bead' || member.kind === 'owned') {
      if (!(await act($, ['decisions', 'answer', member.rig!, member.bead!, text]))) return await flush(false)
      if (member.kind === 'owned' && choice === 'start now') {
        const row = (await read($, decisions)).rigs.find(r => r.rig === member.rig)
        if (!(await act($, ['start', row?.factory ?? 'lifecycle', member.rig!, member.bead!, '--owned'])))
          return await flush(false)
      }
    } else {
      if (!(await act($, ['mail', member.run!, member.node!, text]))) return await flush(false)
      if (member.kind === 'stuck') await act($, [choice === 'abort' ? 'abort' : 'retry', member.run!])
    }
    rt.unsent.push({
      run: member.run ?? member.bead ?? member.key,
      from: 'person',
      text: `answered ${member.node ?? member.rig ?? member.kind}'s question in the console: ${text}`,
      at,
    })
    // not named answer: the mod loader takes any second `answer` in the file for a redeclared hook function
    entries.push({
      key: member.key,
      run: member.run,
      node: member.node,
      rig: member.rig,
      bead: member.bead,
      question: member.question,
      answer: given,
      at,
    })
  }
  await flush(true)
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

/** Every run id a Bash command names with a run-acting verb (`mail`, `poke`, `retry`, `goto`,
 * `fork`, `abort`, `rm`, `decide`), not only the first. A compound command (`a && b`, `a; b`)
 * strings more than one of these together. claude-factory-72v.20: the old code read only the
 * first match (`normalized.match(TOUCH_RE)?.[2]`), so a benign command first in the string hid a
 * held run from the patrol's own deny, and a person's own compound command held only its first
 * run, leaving the rest open to the next patrol. */
function touchedTargets(normalized: string): string[] {
  return [...normalized.matchAll(TOUCH_RE)].map(m => m[2]!)
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
  rt.isPmEnabled = options.pm !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'factory',
      description:
        'Factory dashboard; or a factory command (start, status, decide, rig, queue, mail, poke, retry, goto, fork, abort, rm, patrols)',
      argumentHint: '[start|status|decide|rig|queue|mail|poke|retry|goto|fork|abort|rm|patrols ...]',
    })
    await ensureTicking($)
    // re-registered on every session.start (a hot reload included): the engine replaces the name, never duplicates it
    await $.agent
      .register({
        name: 'patrol',
        description:
          "The factory manager's hidden patrol: answers worker mail, works stuck stations, and starts backlog work, on its own timer.",
        prompt: PATROL(rt.cli),
        tools: ['Bash', 'Read', 'Grep', 'Glob'],
        model: 'sonnet',
        maxTurns: 40,
        omitClaudeMd: true,
      })
      // claude-factory-72v.15: a swallowed failure here left the person with no patrol and no
      // clue why. Show it: every heartbeat then falls back to $.prompt.submit (the catch block
      // in patrolNow), so a status line here at least explains the first one.
      .catch(err => $.ui.status(`factory: could not register the patrol agent: ${line(String(err), 160)}`))
    await $.agent
      .register({
        name: 'pm',
        description:
          "The factory manager's hidden pm: ranks each rig's next work toward its goal, on its own hourly timer.",
        prompt: PM(rt.cli),
        // No tool at all (claude-factory-dun.10). A Linear sync can set a bead's title to text we
        // do not trust. With Read, that text can make the pm copy a local file into a proposal's
        // `why`. `plan set` then files that text as a bead. `bd sync` can push it to the Dolt
        // remote. An empty array tells the engine to allow no tool call. Leaving `tools` out
        // instead gives the pm every tool its parent session has.
        tools: [],
        model: 'sonnet',
        maxTurns: 15,
        omitClaudeMd: true,
      })
      .catch(err => $.ui.status(`factory: could not register the pm agent: ${line(String(err), 160)}`))
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
    // this mod's own patrol-log.jsonl, not a factory CLI command: the CLI knows nothing of it
    if (args[0] === 'patrols') return { text: patrolsText(await readPatrolLog($)) }
    const { out } = await factory($, args)
    void tick($)
    return { text: out || 'ok' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // e.agentId is the subagent's own loop id (AgentLoop), absent on the main loop: the patrol's
    // first Bash call learns rt.patrolId from it. agent.spawn's resolved value never carries an
    // id back to the caller in a mod test (a registered agent type always resolves
    // { model: 'inherit' } there, confirmed live; claude-factory-72v memory), so a test can only
    // deliver the id this way. In a real session this confirms the id agent.spawn set.
    //
    // claude-factory-72v.9: "the first Bash call wins" used to adopt any subagent's id, not only
    // the patrol's own. A second, unrelated subagent could call Bash before the patrol's own
    // first call. That hijacked rt.patrolId. The real patrol's later actions then went unlogged,
    // and its own turn.complete stopped matching. $.agent.list() names each agent's real type
    // (AgentInfo.type). The engine sets this at spawn. Call order cannot fake it. Adopt an id
    // this way only once that list confirms it is really PATROL_TYPE. Most tests never spawn a
    // second subagent, so they never mock agent.list: treat its "no implementation" error the
    // same as "not confirmed", never as "assume yes".
    //
    // claude-factory-72v.17: this skipped rt.patrolIds, the list of ids already seen. An older
    // patrol, freed by the watchdog but still running late, could call Bash and get re-adopted as
    // rt.patrolId, stealing the live patrol's own actions and turn.complete match. Excluding
    // patrolIds here, the same way turn.complete's own fallback already does, closes that gap.
    if (
      rt.isPatrolling &&
      rt.patrolId === undefined &&
      e.agentId &&
      !rt.patrolIds.includes(e.agentId) &&
      (await isPatrolAgent($, e.agentId))
    ) {
      rt.patrolId = e.agentId
      rt.patrolIds = [...rt.patrolIds, e.agentId].slice(-20)
    }
    // the model's shell cd's into rigs to read them: its factory commands still work this factory.
    // claude-factory-72v.19: a subagent's prefix also carries FACTORY_PATROL=1. This is a second,
    // CLI-side layer behind the gated-command regex deny below. A command can obfuscate the gated
    // verb (a backslash inside it, a quoted argument). That can defeat the regex and still run a
    // clean verb against the CLI. src/cli.ts refuses `decide`, `decisions answer`, `decisions
    // propose` and an owner-only `start` whenever this var is set. It already refuses these the
    // same way for a worker's FACTORY_FROM. One residual stays out of scope here: a command that
    // both unsets this var and obfuscates the text still gets through. Fixing that needs the CLI
    // to know the caller's identity on its own.
    const prefix =
      (e.agentId ? 'export FACTORY_PATROL=1\n' : '') + (rt.home ? `export FACTORY_HOME='${rt.home}'\n` : '')
    const pinned = prefix ? { ...e, command: `${prefix}${e.command}` } : e
    const gated = gatedCommand(e.command)
    // gatedCommand's own normalize, repeated here so TOUCH_RE and PATROL_VERB see the same text
    // (a line continuation or a quoted newline must not hide a run-acting command from either)
    const normalized = e.command.replace(/\\\n/g, '')

    // [SECURITY] a subagent gets no dialog, since nobody is there to answer one. This denies a
    // gated command outright, for every subagent. The run-touched hold below, and the patrol-log
    // recording, differ. The person can run their own subagent on a run the main chat just
    // touched (claude-factory-72v.16 keeps the hold off that case). So both match only a patrol's
    // own agentId, never any other subagent's. claude-factory-72v.21: that used to mean only the
    // *current* rt.patrolId. The watchdog can free a patrol that still runs late under its own
    // agentId. Once a new patrol replaced rt.patrolId, the old check dropped that late one, so it
    // could still act on a run the fresh hold was meant to cover. rt.patrolIds remembers every
    // patrol id this session has confirmed (claude-factory-72v.9/.17), current or old. Matching
    // membership there, not only equality with the current id, closes that gap. The action log
    // stays scoped to the current id only: an old patrol's late action is not this patrol's report.
    if (e.agentId) {
      if (gated) return { deny: `${gated.deny} A patrol never decides this: leave it for the person.` }
      if (rt.patrolIds.includes(e.agentId)) {
        // claude-factory-72v.14: the prompt already leaves a held run's mail out, but that alone
        // did not stop the patrol's own Bash call from acting on a held run directly. This denies
        // it too, the same hold PATROL_HOLD_MS already gives the main chat. claude-factory-72v.20:
        // a compound command (`a && b`) can name more than one run; every target is checked, not
        // only the first.
        const now = await $.clock.now()
        for (const target of touchedTargets(normalized)) {
          const at = rt.touched.get(target)
          if (at !== undefined && now - at < PATROL_HOLD_MS)
            return {
              deny: `${target} was touched by the person in the last few minutes: a patrol must not act on it now.`,
            }
        }
        if (e.agentId === rt.patrolId && PATROL_VERB.test(normalized))
          rt.patrolActions = [...rt.patrolActions, line(e.command, 200)].slice(-50)
      }
      return next(pinned)
    }

    // the main chat: a factory command that acts on one run holds that run out of the next
    // patrol for PATROL_HOLD_MS, so the person and a patrol never act on the same run at once.
    // claude-factory-72v.20: a compound command can touch more than one run; every target is held,
    // not only the first.
    const touchedHere = touchedTargets(normalized)
    if (touchedHere.length) {
      const touchedNow = await $.clock.now()
      for (const target of touchedHere) rt.touched.set(target, touchedNow)
    }

    // a gate, a bd decision answer and an owner-only start are the person's call: the model may run
    // any of them only after they confirm it here, since it has no other way to intercept the manager's
    // own shell (FACTORY_FROM, which refuses these for workers, is unset in the manager session)
    if (!gated) return next(pinned)
    const choice = await $.ui.ask(gated.question, ['Allow', 'Deny']).catch(() => 'Deny')
    return choice === 'Allow' ? next(pinned) : { deny: gated.deny }
  })

  // hides PATROL_TYPE from the model's own agent listing and from `subagent_type`: only this plugin's own
  // `$.agent.spawn` of PATROL_TYPE starts it; `agent.offer` never governs that spawn
  on('agent.offer', { agent: PATROL_TYPE }, () => ({ isOffered: false }))
  // same, for the pm: only pmNow's own `$.agent.spawn` of PM_TYPE starts it
  on('agent.offer', { agent: PM_TYPE }, () => ({ isOffered: false }))

  // Clears patrolNow's one-at-a-time guard once the subagent's own turn ends, win or not. The
  // watchdog in patrolNow also clears it, for a turn that never completes.
  //
  // A main-loop turn carries no `agentId`. The check below requires `e.agentId` to be set.
  // claude-factory-72v.8: the old test (`e.agentId === rt.patrolId`) skipped this check. It
  // matched two main-loop turns by mistake, since `undefined === undefined` is true.
  //
  // The `rt.patrolId === undefined` branch below is a fallback for a mod test. It only runs once
  // `e.agentId` is set. In a real session, core sets `agent.spawn`'s resolved `agentId` before the
  // subagent's own turn starts, so `rt.patrolId` is never `undefined` here. In a mod test, core
  // never sets it: a mod's own `$.agent.spawn` call, for a registered agent type, always resolves
  // to `{ model: 'inherit' }` with no `agentId`, even when the test's own hook answers with one.
  // `rt.patrolIds` lists ids already seen. The fallback excludes those ids. This stops a late turn
  // from an older, already-freed patrol from matching by mistake.
  //
  // claude-factory-72v.17: excluding seen ids was not enough. An unrelated subagent's own turn,
  // never seen before, could still end first and match this branch: it would free isPatrolling,
  // and its own answer would be logged and toasted as the patrol's report. `isPatrolAgent` confirms
  // the id is really a running `factory:patrol` agent before this branch adopts it, the same check
  // the Bash hook above already makes.
  // one `on('turn.complete', ...)` handles both subagents: the engine refuses a 2nd registration
  // of the same event with no matcher (there is no per-agent-type matcher for this event, unlike
  // `agent.offer`'s `{ agent }`), so the patrol's own branch and the pm's own branch share one hook.
  on('turn.complete', async ($, e, next) => {
    if (
      rt.isPatrolling &&
      e.agentId &&
      (e.agentId === rt.patrolId ||
        (rt.patrolId === undefined &&
          !rt.patrolIds.includes(e.agentId) &&
          (await isPatrolAgent($, e.agentId))))
    ) {
      rt.isPatrolling = false
      rt.patrolId = undefined
      rt.patrolStartedAt = undefined
      const report = e.answer.length > 600 ? `${e.answer.slice(0, 599)}…` : e.answer
      const entry: FactoryPatrolLogEntry = {
        at: await $.clock.now(),
        agentId: e.agentId,
        reason: e.reason,
        durationMs: e.durationMs,
        tokens: e.usage ? e.usage.input_tokens + e.usage.output_tokens : undefined,
        actions: rt.patrolActions,
        report,
      }
      rt.patrolActions = []
      // claude-factory-72v.11: a write failure here (a full disk, a bad path) must not skip
      // next(e): isPatrolling is already cleared above, so the next patrol still runs either way.
      try {
        await appendPatrolLog($, entry)
        await update($, lastPatrol, () => entry)
        if (report.trim()) $.ui.toast(`factory patrol: ${line(report.split('\n')[0] ?? '', 200)}`)
      } catch (err) {
        $.ui.status(`factory: failed to write the patrol log: ${line(String(err), 160)}`)
      }
      return next(e)
    }

    // Clears pmNow's one-at-a-time guard once the pm's own turn ends, win or not (the same
    // agentId-confirmation fallback the patrol's own branch above uses for a mod test, which
    // never sees a real agentId back from `$.agent.spawn`). A pm turn never touches
    // `rt.isPatrolling`, `rt.patrolId` or patrol-log.jsonl: the two subagents are independent.
    //
    // On a match, this takes the LAST fenced ```json block of the answer (the pm's own prompt asks
    // for exactly one, but a model can still add stray prose or an example before it), writes it
    // to <home>/plan-answer.json, and runs `factory plan set` on that file -- the pm itself never
    // runs bd. A missing fence, or a `plan set` failure, is logged as an error and `plan set` is
    // never called for it, so a bad answer cannot write a half-formed plan.json.
    if (
      rt.isPlanning &&
      e.agentId &&
      (e.agentId === rt.pmId ||
        (rt.pmId === undefined && !rt.pmIds.includes(e.agentId) && (await isPmAgent($, e.agentId))))
    ) {
      rt.isPlanning = false
      rt.pmId = undefined
      rt.pmStartedAt = undefined
      const base = {
        at: await $.clock.now(),
        agentId: e.agentId,
        reason: e.reason,
        durationMs: e.durationMs,
        tokens: e.usage ? e.usage.input_tokens + e.usage.output_tokens : undefined,
      }
      const fences = [...e.answer.matchAll(/```json\s*([\s\S]*?)```/g)]
      const fence = fences.at(-1)?.[1]?.trim()
      let entry: FactoryPmLogEntry
      if (!fence) {
        entry = { ...base, error: "the pm's answer had no fenced json block" }
      } else if (!rt.home) {
        entry = { ...base, error: 'no factory home yet' }
      } else {
        const answerPath = `${rt.home}/plan-answer.json`
        try {
          await $.fs.write(answerPath, fence)
          const { isOk, out } = await factory($, ['plan', 'set', answerPath])
          if (!isOk) {
            entry = { ...base, error: line(out, 300) }
          } else {
            const summary = JSON.parse(out) as { items: number; findings: number; filed: number }
            entry = { ...base, items: summary.items, findings: summary.findings, filed: summary.filed }
          }
        } catch (err) {
          entry = { ...base, error: line(String(err), 300) }
        }
      }
      // a write failure here must not skip next(e): isPlanning is already cleared above, so the
      // next pm turn still runs either way (mirrors the patrol log's own try/catch, claude-factory-72v.11)
      try {
        await appendPmLog($, entry)
        if (entry.error) $.ui.status(`factory: the pm turn failed: ${line(entry.error, 160)}`)
      } catch (err) {
        $.ui.status(`factory: failed to write the pm log: ${line(String(err), 160)}`)
      }
    }
    return next(e)
  })

  // defense only: the probe behind claude-factory-72v found that a plugin's own `$.agent.spawn` queues
  // no task-notification turn (unlike the model's own background Agent call). This must not fire.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const id = e.text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
      if (id && (rt.patrolIds.includes(id) || rt.pmIds.includes(id)))
        return { drop: "a patrol or pm subagent's own task-notification" }
    }
    return next(e)
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
    const [b, rawShown, d, tail, bl, bt, pr, samples, dr, dec, now, sel, lp, pl] = await Promise.all([
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
      read($, lastPatrol),
      read($, plan),
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
              ? rigsView(p, b, pl, rt.pmBlocked)
              : shown === 'interview'
                ? interviewView(p, b, dr, dec)
                : boardView(p, b, dr, sel, d, tail)
    return (
      <Box flexDirection="column">
        {header(p, b, samples, shown, lp, pl)}
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
    return band(p, b, await read($, draft), await read($, lastPatrol), await read($, plan))
  })
}
