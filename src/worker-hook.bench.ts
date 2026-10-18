/**
 * This script is a benchmark for claude-factory-1by and claude-factory-lbn.
 *
 * Shape "shell" (claude-factory-1by): The function `anyShellReason` (`src/worker-hook.ts:559-606`) examines a segment for the shell words sh, bash, zsh and dash.
 * Before the claude-factory-1by change, the function examined the remaining words of the segment again at each such word, with `shCFlagIndex(words.slice(j))`.
 * Then it moved forward by only one word.
 * As a result, the check took `O(n^2)` time, where n is the word count.
 * The change replaces that per-word check with two forward pointers, `nc` and `nd`.
 * Each pointer reads the segment one time, so the total time is `O(n)`.
 *
 * Shape "find" (claude-factory-lbn, fixed 2026-10-17):
 * The `find` part of `denyAt` (`src/worker-hook.ts:658-677`) checks a segment for `-exec` and `-execdir` words.
 * Before the fix, the code made `rest` with `cmd.slice(i + 1)` at each such word. It then read `rest[0]`.
 * The slice itself took `O(n-i)` time.
 *
 * When there was no match, `i` moved forward by only one word.
 * As a result, the total time of the loop was `O(n^2)`.
 * This bug had the same shape as the "shell" bug above, but in a different function.
 *
 * The fix gives `isRecursiveRm` a `start` index. The function reads `cmd` in place, without a slice.
 * Each call starts its scan at an `rm` word and stops at the first non-flag word.
 * A later `-exec`/`-execdir` match starts a new scan only at its own `rm` word. So the scans do not overlap.
 * The total time of the loop is now `O(n)`.
 *
 * Measured after the fix, load average 81-85:
 * `denyReason('find . ' + '-exec '.repeat(200000))` took 191.2 ms.
 * `denyReason('find . ' + '-exec '.repeat(400000))` took 470.2 ms. The ratio is 2.46x for a 2x input. An `O(n^2)` scan gives a ratio of ~4x.
 *
 * Before the fix, at load 13.81, `n=20000` took 75.5 ms.
 * `n=40000` took 233.0 ms (3.09x).
 * `n=80000` took 1445.0 ms (6.20x).
 *
 * Use this repro input to check any future fix here: `'find . -exec rm '.repeat(n)`.
 * A fix that only adds a check for `rest[0] === 'rm'` before the slice still slices once for
 * each `-exec`. This input catches that case. The current fix stays `O(n)` on this input too,
 * because it does not slice at all.
 *
 * Use one of these commands to start this script by hand:
 *   `bun run src/worker-hook.bench.ts` (shape "shell", default sizes)
 *   `bun run src/worker-hook.bench.ts shell [n]` (shape "shell", one size)
 *   `bun run src/worker-hook.bench.ts find [n]` (shape "find", one input size, or the default input sizes)
 * The command `bun test src factories` does not start this script. This is because the script name does not end in `.test.ts`.
 *
 * The script prints one line for each input size.
 * Each line shows the input size in words and bytes.
 * Each line also shows the wall-clock time for one `scanReason` call. `scanReason` runs the same
 * scan `denyReason` does, with no length cap, so a big input here still measures the scan this
 * script targets, in place of the MAX_COMMAND_LENGTH short-circuit `denyReason` now gives on
 * every rig for an input this big (claude-factory-dts).
 * Each line also shows the ratio to the time at the previous input size.
 * Read the ratio column, not the raw time.
 *
 * When n doubles, a ratio near 4 means `O(n^2)`.
 * A ratio near 2 means `O(n log n)`.
 * A ratio near 1 means `O(n)`.
 *
 * On this machine, the load average from `uptime` can be 2 to 4 times the core count.
 * The raw times change with this load, so each run is different.
 * Use the ratio column, not the raw times, to read the growth rate.
 *
 * The bead that opened the "shell" task reports 570 ms at `n=10000`, with a load average of 6 to 11.
 * The "find" bead (claude-factory-lbn) reports 80 ms at `n=20000`, 400 ms at `n=40000`, and 1.36 s at `n=80000`.
 * That bead does not give a load average.
 * Compare your time at the same `n` with those numbers to judge the effect of load noise on your run.
 */
import { scanReason } from './worker-hook'

function shellRun(n: number): string {
  return 'sh '.repeat(n) + '; rm -rf x'
}

function findRun(n: number): string {
  return 'find . ' + '-exec '.repeat(n)
}

function timeOnce(command: string): number {
  const t0 = performance.now()
  scanReason(command)
  return performance.now() - t0
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

async function main() {
  const args = process.argv.slice(2)
  const shape = args[0] === 'find' || args[0] === 'shell' ? args[0] : 'shell'
  const sizeArg = args[0] === 'find' || args[0] === 'shell' ? args[1] : args[0]
  const buildRun = shape === 'find' ? findRun : shellRun
  const sizes = Number(sizeArg ?? 0) > 0 ? [Number(sizeArg)] : [2500, 5000, 10000, 20000, 40000]
  console.log(
    `node ${process.version ?? ''} bun ${process.versions?.bun ?? ''} pid ${process.pid} shape ${shape}`,
  )
  console.log('n(words)\tbytes\tms\tratio-to-prev\trss-after')
  let prevMs: number | undefined
  for (const n of sizes) {
    const cmd = buildRun(n)
    const ms = timeOnce(cmd)
    const ratio = prevMs ? ms / prevMs : 1
    const rss = process.memoryUsage().rss
    console.log(`${n}\t${fmtBytes(cmd.length)}\t${ms.toFixed(1)}\t${ratio.toFixed(2)}\t${fmtBytes(rss)}`)
    prevMs = ms
  }
}

await main()
