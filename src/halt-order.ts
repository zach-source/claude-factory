// One writer for the halt state (specs/010-server-pod/contracts/halt-order.md, claude-factory-gogxc.3).
// stop and resume change halt.json and resume.json only while they hold tick.lock. A command that cannot
// get the lock in time posts to halt-cmd.jsonl. The next tick applies the queue first, in seq order.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type HaltCmd = { seq: number; cmd: 'stop' | 'resume'; at: number }
export const LOCK_WAIT_MS = 10_000

const seqFile = (home: string) => join(home, 'halt-seq')
const queueFile = (home: string) => join(home, 'halt-cmd.jsonl')

/** the seq of the last person command; 0 before the first */
export const haltSeq = (home: string) =>
  existsSync(seqFile(home)) ? Number(readFileSync(seqFile(home), 'utf8')) || 0 : 0

/** raises seq by one. ponytail: two processes that read at the same time can share a seq; the queue then keeps file order. */
export function bumpSeq(home: string) {
  const seq = haltSeq(home) + 1
  writeFileSync(seqFile(home), String(seq))
  return seq
}

/**
 * Run `apply` while holding the lock. If the lock is not free within `waitMs`, queue the command.
 * `apply` throws to refuse a command (for example, stop while already stopped): the throw reaches the caller.
 */
export async function runHaltCmd(
  home: string,
  lock: () => (() => void) | null,
  cmd: HaltCmd['cmd'],
  apply: (cmd: HaltCmd['cmd']) => string,
  waitMs = LOCK_WAIT_MS,
  now = Date.now(),
): Promise<{ out: string } | { queued: number }> {
  const end = now + waitMs
  let release = lock()
  while (!release && Date.now() < end) {
    await new Promise(r => setTimeout(r, 100))
    release = lock()
  }
  if (!release) {
    const seq = bumpSeq(home)
    appendFileSync(queueFile(home), JSON.stringify({ seq, cmd, at: Date.now() } satisfies HaltCmd) + '\n')
    return { queued: seq }
  }
  try {
    bumpSeq(home)
    return { out: apply(cmd) }
  } finally {
    release()
  }
}

/** a tick calls this under the lock, before it reads the halt state; a refused command is dropped */
export function drainHaltQueue(home: string, apply: (cmd: HaltCmd['cmd']) => string) {
  if (!existsSync(queueFile(home))) return
  const cmds = readFileSync(queueFile(home), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as HaltCmd)
    .sort((a, b) => a.seq - b.seq)
  rmSync(queueFile(home))
  for (const c of cmds) {
    try {
      apply(c.cmd)
    } catch {} // the person asked for a state that already holds: nothing to do
  }
}
