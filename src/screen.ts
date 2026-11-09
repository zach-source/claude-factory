// The worker screen read (claude-factory-hpmc.3): a byte cap and one bounded process run.
// See docs/architecture/adr-runs-screen.md.

export const SCREEN_MAX = 65536
/** the whole read, cleanup included, must end inside 10 s */
const DEADLINE_MS = 9000
/** a hard ceiling on stdout and on stderr, each */
const BUFFER_MAX = 128 * 1024

export const REASON = {
  noWorker: 'run has no worker',
  badAddress: 'worker address is not valid',
  unavailable: 'worker screen could not be read',
  tooLarge: 'worker screen is too large',
  timeout: 'worker screen timed out',
} as const

/**
 * the last SCREEN_MAX bytes as text. `cut` says the caller already took a tail of a longer stream. A cut can split
 * a UTF-8 character: its leading bytes are dropped, so no replacement character shows.
 */
export function tailUtf8(buf: Uint8Array, cut = false): string {
  let b = buf
  if (b.length > SCREEN_MAX) {
    b = b.subarray(b.length - SCREEN_MAX)
    cut = true
  }
  if (cut) {
    let i = 0
    while (i < 3 && i < b.length && (b[i]! & 0xc0) === 0x80) i++
    b = b.subarray(i)
  }
  return Buffer.from(b).toString('utf8')
}

/**
 * run argv once: a 9 s deadline with a hard kill, and 128 KiB for stdout and for stderr each.
 * Never throws. A failure gives a reason without the stderr or the output of the process.
 */
export function boundedRun(argv: string[]): { text: string } | { reason: string } {
  try {
    const p = Bun.spawnSync(argv, {
      env: process.env,
      stdin: 'ignore',
      timeout: DEADLINE_MS,
      killSignal: 'SIGKILL',
      maxBuffer: BUFFER_MAX,
    })
    if (p.exitedDueToTimeout) return { reason: REASON.timeout }
    if (p.exitedDueToMaxBuffer) return { reason: REASON.tooLarge }
    if (p.exitCode !== 0) return { reason: REASON.unavailable }
    return { text: tailUtf8(p.stdout) }
  } catch {
    return { reason: REASON.unavailable }
  }
}
