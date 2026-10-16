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
  gate?: { question: string; outcomes: string[] }
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
    }
  }
}
