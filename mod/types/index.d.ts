// what `factory tick` prints (src/cli.ts Row), as the pane draws it
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
  last?: { node: string; attempt: number; outcome: string; summary: string }
  /** the bead the run works, in a repo tracked with beads */
  bead?: string
  /** set while the run waits at a gate for the person */
  gate?: { question: string; outcomes: string[] }
}
export type FactoryMail = { run: string; from: string; text: string; at: number }
export type FactoryBoard = { runs: FactoryRun[]; mail: FactoryMail[] }

declare module 'claude-code' {
  interface PluginState {
    factory: { board: FactoryBoard }
  }
}
