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
}

// what `factory backlog` prints
export type FactoryBead = { id: string; title: string; priority?: number; type?: string; labels?: string[] }
export type FactoryBacklog = (FactoryRig & {
  /** its runs holding a worker now */
  busy: number
  queued: FactoryBead[]
  unqueued: FactoryBead[]
  error?: string
})[]

export type FactoryView = 'board' | 'run' | 'backlog' | 'mail' | 'new' | 'rigs'
/** what the person has typed and not sent */
export type FactoryDraft = {
  repo: string
  factory: string
  goal: string
  mail: string
  /** the station the run view's goto and fork act on */
  target: string
  /** a gate's note, per run */
  notes: Record<string, string>
  /** what the person is typing back to a worker's mail, per message (mailKey) */
  replies?: Record<string, string>
  /** what the person already answered, per message */
  answered?: Record<string, string>
  /** the mail view's sub-tab */
  mailTab?: 'open' | 'answered'
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
      history: number[]
      draft: FactoryDraft
    }
  }
}
