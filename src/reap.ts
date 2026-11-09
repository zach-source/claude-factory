import { dlopen } from 'bun:ffi'
import { readdirSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'

/** the exit code of this wrapper when it cannot make sure that no process of the turn is left: serve stops on it */
export const REAP_FAILED = 125

/**
 * `bun src/reap.ts <argv...>`: run the command as a child subreaper. When it exits, kill every process that it left
 * (in any session or process group: a codex shell command runs in a new session) so that none can change the guard
 * files before the next turn (claude-factory-qn8a.35).
 */
function liveChildren() {
  const me = String(process.pid)
  return readdirSync('/proc')
    .filter(n => /^\d+$/.test(n))
    .filter(n => {
      try {
        const s = readFileSync(`/proc/${n}/stat`, 'utf8')
        const [state, ppid] = s.slice(s.lastIndexOf(')') + 2).split(' ')
        return ppid === me && state !== 'Z' && state !== 'X'
      } catch {
        return false // gone
      }
    })
    .map(Number)
}

function fail(msg: string): never {
  process.stderr.write(`reap: ${msg}\n`)
  process.exit(REAP_FAILED)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  // ponytail: no subreaper off Linux; serve runs only in the Linux VM, and this keeps macOS test runs of serve working
  const linux = process.platform === 'linux'
  if (linux) {
    try {
      const { symbols } = dlopen('libc.so.6', {
        prctl: { args: ['i32', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' },
      })
      if (symbols.prctl(36 /* PR_SET_CHILD_SUBREAPER */, 1, 0, 0, 0) !== 0) throw new Error('prctl')
    } catch {
      fail('cannot become a child subreaper')
    }
  }
  const p = Bun.spawn(argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  await p.exited
  if (linux) {
    let left: number[] = []
    try {
      for (let i = 0; i < 20; i++) {
        left = liveChildren()
        if (!left.length) break
        for (const pid of left)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        Bun.sleepSync(20)
      }
      if (left.length) left = liveChildren()
    } catch {
      fail('cannot list the processes of the turn')
    }
    // ponytail: zombies of killed leftovers live until this process exits (one turn); add waitpid through bun:ffi if a turn leaves many
    if (left.length) fail(`${left.length} processes outlived the turn`)
  }
  process.exit(p.exitCode ?? 128 + (constants.signals[p.signalCode as keyof typeof constants.signals] ?? 1))
}
