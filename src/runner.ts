// Where a station's worker runs. The reconciler never asks which: it holds a worker's address (c.pane) and
// calls runnerOf(address) for everything it does to it.
import type { Run } from './cli'
import type { Ctx, Factory } from './machine'

/** what a runner sees of a worker; `agent` is set while the harness is running in it (herdr: detected in the pane) */
export type WorkerInfo = {
  status: string
  agent?: string
  session?: string
  /** a non-local Claude worker's last transcript entry, where the reconciler reads a usage limit and the context size */
  tail?: string
  /** a non-local worker's VM repo HEAD and live-stream byte count: its progress signal when tail alone is empty or unchanged mid-turn */
  head?: string
  bytes?: number
  /** an ongoing egress-gateway outage the worker is retrying a turn through: see worker.ts egressFailure */
  egress?: { since: number; tries: number; last: string }
  /** a codex worker's turn that ended on a usage limit: see worker.ts codexLimit */
  limit?: { at: number; kind: string; resetsAt: number }
  /** set once a runner gives up retrying something itself (a put stuck over ax ssh): the reconciler fails the attempt with this reason instead of retrying silently */
  failed?: string
  /** the text of the one manager mail. Set only when AX failed to restore the task (ActorResumeFailed) and this call wrote the rig's no-suspend marker */
  resumeFailed?: string
  /** the redacted bd error of a report that went out without its bd sync: see worker.isSchemaSkew */
  bdSkew?: string
  /** why an AX worker has not started: the deadline names it instead of "no report" */
  pending?: string
}

/** what a runner needs to start a worker for one station attempt */
export type Job = {
  run: Run
  def: Factory
  node: string
  c: Ctx
  /** a conversation to carry on, for runners that can resume one */
  session?: string
  /** the prompt as a file under the run's dir: the brief, or the resume note when there is a session */
  file: string
  /** the whole brief, for a runner whose workers start with no conversation (a resume gets the note in `file`) */
  brief(): string
}

/**
 * A place workers run. To add one (a remote box, another scheduler), write a module that implements this and
 * register it: `runners.<name> = ...`. Then `rig add --runner <name>` accepts it, with no other change. A
 * worker's address is whatever launch returns; herdr's is the bare pane id (runs in flight keep working), every
 * other runner's is `<name>://<id>`, which is how runnerOf finds the runner that owns it: a herdr id has a `:`
 * (`wA6:p1`) but never `://`.
 */
export type Runner = {
  name: string
  /** the worker's pane and conversation live on this machine: it can be restarted in place, its transcript read, the trust dialog matters */
  local: boolean
  /** start a worker; returns its address */
  launch(job: Job): string
  /** the worker's status; null once it is gone */
  info(run: Run, address: string): WorkerInfo | null
  /** a prompt into the worker's conversation; false when it is not delivered yet (try again next tick) */
  deliver(address: string, text: string): boolean
  /** end the worker; gone already is fine */
  close(address: string): void
  /** park a worker that waits on someone, at no cost until deliver wakes it */
  suspend?(address: string): void
  /** the worker's state without side effects (info may replay or wake things), for listings; none shown when absent */
  phase?(address: string): string | null
}

export const DEFAULT_RUNNER = 'herdr'
export const runners: Record<string, Runner> = {}

/** the runner that owns a worker's address */
export function runnerOf(address: string): Runner {
  const name = /^(\w+):\/\//.exec(address)?.[1]
  return (name && runners[name]) || runners[DEFAULT_RUNNER]!
}
