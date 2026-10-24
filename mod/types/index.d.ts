// what `factory tick` prints (src/cli.ts Row), as the board draws it
export type FactoryRun = {
  id: string
  factory?: string
  goal?: string
  node?: string
  sub?: string
  attempt?: number
  attempts?: number
  pane?: string | null
  agent?: string | null
  error?: string | null
  last?: FactoryEntry
  /** set while the run waits at a gate for the person */
  gate?: { question: string; outcomes: string[]; brief?: string }
  /** the bead the run works, in a repo tracked with beads */
  bead?: string
  /** the rig whose repo it works */
  rig?: string
  /** the stations of its recent reports, oldest first */
  trail?: string[]
  since?: number
  wakeAt?: number
  /** when its current station's box last got mail: a reply to what it asked */
  mailedAt?: number
  /** set on a rig's row (not a run's) while the rig has room, no goal and no ready beads */
  idle?: string
  /** minutes its current worker has run */
  inMin?: number
  /** minutes since its worker's tail or branch head last changed */
  quietMin?: number
  /** when its runner's usage limit lifts, while the runner waits on it */
  limitUntil?: number
}
export type FactoryEntry = { node: string; attempt: number; outcome: string; summary: string; at: number }
export type FactoryMail = { run: string; from: string; text: string; at: number }
/** the tick's runs and rigs, and the manager's mail so far; rigs is missing in a board saved before rigs were drawn */
export type FactoryBoard = {
  runs: FactoryRun[]
  mail: FactoryMail[]
  rigs?: FactoryRig[]
  /** set while `factory stop` winds the workers down, and while the factory stays paused */
  halt?: 'stopping' | 'paused'
  /** when ticks began failing: what the board shows is from before then; cleared by the next good tick */
  staleSince?: number
}

// what `factory show <run>` prints: everything the run view draws
export type FactoryEdge = { outcome: string; to: string; delayMin?: number; defer?: true }
export type FactoryDetail = FactoryRun & {
  seq: number
  run: {
    id: string
    goal: string
    bead?: string
    factory: string
    branch: string
    worktree: string
    repo: string
  }
  log: FactoryEntry[]
  inbox: { from: string; text: string; at: number }[]
  start: string
  stations: { id: string; gate: boolean; next: FactoryEdge[] }[]
  tasks: { id: string; title: string; status: string }[] | null
  /** a station's worker is (or is about to be) on it: not waiting, stuck or at a gate */
  isWorking: boolean
}

/** a repo the factory works, with its own cap, sweeps and goal (src/cli.ts Rig) */
export type FactoryRig = {
  name: string
  repo: string
  factory: string
  maxRuns?: number
  sweeps?: string[]
  goal?: string
  /** this rig's Linear routing (claude-factory-b6c, claude-factory-b6c.18); absent when the rig has no Linear pull */
  linear?: { team: string[]; projects?: string[]; labels?: string[] }
  /** this rig's last Linear pull, added by `factory tick` from `linear-sync.json` */
  linearSync?: {
    at: number
    pulled?: number
    created?: number
    updated?: number
    stripped?: number
    /** issues this rig's team(s) listed that no opted-in rig claimed; never pulled */
    unrouted?: number
    error?: string
  }
}

// what `factory backlog` prints
export type FactoryBead = {
  id: string
  title: string
  priority?: number
  type?: string
  labels?: string[]
  /** the bead it is a child of */
  parent?: string
  /** its children closed and in all, counting the ones no longer listed */
  children?: { done: number; total: number }
  /** the open beads it waits on */
  blockedBy?: string[]
}
export type FactoryBacklog = (FactoryRig & {
  /** its runs holding a worker now */
  busy: number
  queued: FactoryBead[]
  unqueued: FactoryBead[]
  error?: string
})[]

/** every pull request each run touches, by run, kept (merged and closed too) until the run is removed
 * (`factory prs`): `error` here is a run-wide gh failure (its branch listing or search), not one PR's own */
export type FactoryPrs = {
  run: string
  rig?: string
  bead?: string
  node: string
  ended: boolean
  at: number
  error?: string
  prs: {
    url: string
    repo: string
    number: number
    title: string
    /** 'gitlab' on a merge request; absent on a GitHub PR */
    forge?: 'gitlab'
    role: 'code' | 'companion' | 'deploy' | 'mentioned'
    /** the station that first named it, or '' when it was only found by search or branch */
    station: string
    /** OPEN, MERGED, CLOSED or UNKNOWN before its first `gh pr view` */
    state: 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'
    isDraft: boolean
    /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or '' */
    reviewDecision: string
    /** CLEAN, BLOCKED, DIRTY, UNSTABLE, BEHIND, UNKNOWN */
    mergeStateStatus: string
    checks: { pass: number; fail: number; pending: number }
    updatedAt: string
    /** this one PR's own last `gh` (or `glab`) failure, kept until it is viewed again successfully */
    error?: string
  }[]
}[]

export type FactoryView = 'board' | 'backlog' | 'mail' | 'prs' | 'rigs' | 'interview'
/** what the person has typed and not sent */
export type FactoryDraft = {
  mail: string
  /** the station the run view's goto and fork act on */
  target: string
  /** a gate's note, per run */
  notes: Record<string, string>
  /** what the person is typing back to a worker's mail, per message (mailKey) */
  replies?: Record<string, string>
  /** what the person already answered, per message */
  answered?: Record<string, string>
  /** the interview view's sub-tab */
  interviewTab?: 'open' | 'answered'
  /** the questions answered in the interview view, newest last; a run-based one keeps run/node, a bd
   * decision keeps rig/bead instead */
  interviewed?: {
    key: string
    run?: string
    node?: string
    rig?: string
    bead?: string
    question: string
    answer: string
    at: number
  }[]
  /** the mail view's sub-tab */
  mailTab?: 'open' | 'answered'
  /** the board lists finished runs */
  isFinishedShown?: boolean
  /** the Backlog's parents whose children are shown (collapsed by default) */
  backlogOpen?: string[]
  /** the one rig the Backlog shows; all of them when unset */
  backlogRig?: string
  /** the interview items whose details toggle the person opened, by key; collapsed by default */
  interviewOpen?: string[]
}

/** `factory decisions`' shape (src/cli.ts decisionsList): each rig's open bd decisions, or what stopped
 * it reading them, plus any options the manager proposed for an item that had none */
export type FactoryDecisions = {
  rigs: {
    rig: string
    factory: string
    beads: { id: string; title: string; description?: string; kind: 'bead' | 'owned' }[]
    error?: string
  }[]
  proposals: Record<string, { question: string; context?: string; options: string[]; at: number }>
}

/** one patrol subagent's outcome: turn.complete (register.tsx) appends one of these per patrol to
 * `<home>/patrol-log.jsonl`, capped at 50 lines. `/factory patrols` prints the last 10. */
export type FactoryPatrolLogEntry = {
  at: number
  agentId?: string
  reason: string
  durationMs: number
  /** input + output tokens the patrol's turn cost; absent when the turn reported none */
  tokens?: number
  /** the patrol's own run-acting factory commands this run, each clipped to 200 chars */
  actions: string[]
  /** the patrol's final answer, clipped to 600 chars */
  report: string
}

/** one pm subagent turn's outcome. register.tsx's pm `turn.complete` hook appends one of these to
 * `<home>/pm-log.jsonl`, capped at 50 lines (claude-factory-dun.5). The pm never reports free text.
 * `items`/`findings`/`filed` come from `factory plan set`'s own JSON stdout, not from the pm.
 * `error` is set instead of them when the pm's answer had no fenced JSON block, or `plan set` failed. */
export type FactoryPmLogEntry = {
  at: number
  agentId?: string
  reason: string
  durationMs: number
  /** input + output tokens the pm's turn cost; absent when the turn reported none */
  tokens?: number
  items?: number
  findings?: number
  filed?: number
  error?: string
}

/** one pending skill or proposal with no verdict yet: an item of `factory tick`'s `reviews` field
 * (mirrors `ReviewItem` in src/memory.ts, without its text) (claude-factory-ag2). */
export type FactoryReviewItem = {
  key: string
  kind: 'skill' | 'proposal'
  name: string
  change: string
}

/** a pending item as the patrol shows it: an item of `factory tick`'s `reviews` field (no verdict) or
 * its `reviewed` field (with one). The manager or the person confirms the verdict. */
export type FactoryReviewRow = FactoryReviewItem & {
  recommendation?: 'install' | 'reject'
  why?: string
}

/** one reviewer attempt's outcome, appended to `<home>/review-log.jsonl`, capped at 50 lines
 * (claude-factory-ag2). `key` is the item's own key (`reviewKey()`, src/memory.ts). `error` is set
 * when the facts call, the spawn, the answer or `factory review set` failed. */
export type FactoryReviewLogEntry = {
  at: number
  key: string
  agentId?: string
  reason?: string
  durationMs: number
  tokens?: number
  error?: string
}

/** one briefer subagent attempt's outcome. register.tsx's briefer `turn.complete` branch, and
 * `briefNow` itself on a failed facts gather, spawn deny or spawn throw, append one of these to
 * `<home>/brief-log.jsonl`, capped at 50 lines (claude-factory-2u2). `key` is the gate visit's own
 * key (`gateKey()`, src/gatebrief.ts). `error` is set instead of a clean write when the facts call,
 * the spawn, or `factory gate-brief set` failed. */
export type FactoryBriefLogEntry = {
  at: number
  key: string
  agentId?: string
  reason?: string
  durationMs: number
  /** input + output tokens the briefer's turn cost; absent when the turn reported none, or when
   * this entry was written before a turn ever ran (a facts-gather or a spawn-deny/throw) */
  tokens?: number
  error?: string
}

/** one ranked bead in a rig's plan (mirrors `PlanItem`, src/plan.ts). `why` is the pm's one-line
 * reason for the bead's place in the order. `why` is 120 characters or fewer. */
export type FactoryPlanItem = { id: string; title: string; priority: number; why: string }
/** a starvation or plan-gap finding in the pm's plan (mirrors `Finding`, src/plan.ts) */
export type FactoryPlanFinding = {
  kind: 'starved-epic' | 'goal-no-beads' | 'epic-done-open' | 'goal-no-plan'
  rig: string
  bead?: string
  key: string
  text: string
}
/** a change only the person may make. The pm proposes it; nothing applies it (mirrors
 * `Proposal`, src/plan.ts). */
export type FactoryPlanProposal = { rig: string; bead?: string; change: string; why: string }
/** one rig's part of `<home>/plan.json` (mirrors `RigPlan`, src/plan.ts) */
export type FactoryRigPlan = { items: FactoryPlanItem[]; findings: FactoryPlanFinding[] }
/** `<home>/plan.json`, the pm subagent's last ranking (mirrors `Plan`, src/plan.ts). `at` is the
 * time the pm wrote it. A plan 2 or more hours old is stale: the patrol and `dispatch()` then use
 * today's order instead. */
export type FactoryPlan = {
  at: number
  rigs: Record<string, FactoryRigPlan>
  proposals: FactoryPlanProposal[]
}

declare module 'claude-code' {
  interface PluginState {
    factory: {
      board: FactoryBoard
      view: FactoryView
      selected: string | null
      detail: FactoryDetail | null
      peek: string
      backlog: FactoryBacklog
      /** the backlog's type filter: 'all' or a bead type */
      backlogType: string
      prs: FactoryPrs
      history: number[]
      draft: FactoryDraft
      decisions: FactoryDecisions
      /** the last patrol's log entry, drawn in the pane header and band; null before any patrol wrote one */
      lastPatrol: FactoryPatrolLogEntry | null
      /** the pm's last plan, refreshed each tick; null before the pm ever wrote one. `null`, not
       * `undefined`: `$.state.set` only ever stores JSON data, which has no `undefined` */
      plan: FactoryPlan | null
    }
  }
}
