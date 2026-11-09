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
  failed: 'worker screen process failed',
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
  const text = Buffer.from(b).toString('utf8')
  // invalid bytes decode to 3-byte U+FFFD: cap the decoded text again, on a character edge
  const out = Buffer.from(text, 'utf8')
  if (out.length <= SCREEN_MAX) return text
  const t = out.subarray(out.length - SCREEN_MAX)
  let j = 0
  while (j < 3 && j < t.length && (t[j]! & 0xc0) === 0x80) j++
  return t.subarray(j).toString('utf8')
}

/**
 * run argv once: a 9 s deadline with a hard kill, and 128 KiB for stdout and for stderr each.
 * Never throws. A failure gives a reason, never the stderr or the output: a launch error or a foreign signal is a process failure, a nonzero exit means the screen is unavailable.
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
    if (p.exitCode === null) return { reason: REASON.failed }
    if (p.exitCode !== 0) return { reason: REASON.unavailable }
    return { text: tailUtf8(p.stdout) }
  } catch {
    return { reason: REASON.failed }
  }
}
