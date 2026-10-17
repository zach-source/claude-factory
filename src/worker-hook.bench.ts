/**
 * This script is a benchmark for claude-factory-1by.
 *
 * The function `anyShellReason` (`src/worker-hook.ts:559-606`) scans a segment for the shell words sh, bash, zsh and dash.
 * Before the claude-factory-1by fix, the function scanned the rest of the segment again at each such word, with `shCFlagIndex(words.slice(j))`.
 * The function then moved forward by only one word.
 * As a result, the scan ran in `O(n^2)` time, where n is the word count.
 * The fix replaces that per-word rescan with two forward pointers (`nc`, `nd`) that each cross the segment once, for `O(n)` total.
 *
 * Run this script by hand with this command: `bun run src/worker-hook.bench.ts`.
 * The command `bun test src factories` does not run this script, because the script name does not end in `.test.ts`.
 *
 * The script prints one line for each input size.
 * Each line shows the input size in words and bytes.
 * Each line also shows the wall-clock time for one `denyReason` call.
 * Each line also shows the ratio to the time at the previous input size.
 * Read the ratio column, not the raw time.
 *
 * When n doubles, a ratio near 4 means `O(n^2)`.
 * A ratio near 2 means `O(n log n)`.
 * A ratio near 1 means `O(n)`.
 *
 * On this machine, the load average from `uptime` can be 2 to 4 times the core count.
 * Each run's raw times change with this load, so each run differs.
 * Use the ratio column, not the raw times, to read the growth rate.
 * The bead that opened this task reports 570 ms at `n=10000`, under a load average of 6 to 11.
 * Compare your own time at `n=10000` with that number to judge the effect of load noise on your run.
 */
import { denyReason } from './worker-hook'

function shellRun(n: number): string {
  return 'sh '.repeat(n) + '; rm -rf x'
}

function timeOnce(command: string): number {
  const t0 = performance.now()
  denyReason(command)
  return performance.now() - t0
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

async function main() {
  const sizes =
    Number(process.argv[2] ?? 0) > 0 ? [Number(process.argv[2])] : [2500, 5000, 10000, 20000, 40000]
  console.log(`node ${process.version ?? ''} bun ${process.versions?.bun ?? ''} pid ${process.pid}`)
  console.log('n(words)\tbytes\tms\tratio-to-prev\trss-after')
  let prevMs: number | undefined
  for (const n of sizes) {
    const cmd = shellRun(n)
    const ms = timeOnce(cmd)
    const ratio = prevMs ? ms / prevMs : 1
    const rss = process.memoryUsage().rss
    console.log(`${n}\t${fmtBytes(cmd.length)}\t${ms.toFixed(1)}\t${ratio.toFixed(2)}\t${fmtBytes(rss)}`)
    prevMs = ms
  }
}

await main()
