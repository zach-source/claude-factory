// The gate briefer's pure logic. It has no IO.
// `factory gate-brief facts|set` (src/cli.ts) uses this module for two things.
// It builds the key for one gate visit. It also cleans the briefer subagent's raw answer.
// The CLI stores the cleaned brief for the console's Interview tab (claude-factory-2u2).

// This function removes C0/C1 control characters, Unicode line and paragraph separators, and bidi overrides.
// src/plan.ts's `stripControl` removes the same set from untrusted bead text (claude-factory-dun.26).
// This version keeps `\n`, because a brief can hold several lines.
// `plan.ts`'s `sanitize` turns each line break into a space, which a brief must not do.
const stripControl = (s: string) =>
  s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '')

/**
 * This is the key for one gate visit. `interviews()` (mod/hooks/view.ts) builds the same key.
 * The console's Interview tab and the refusal in `gate-brief set` use this key to decide what "this visit" means.
 * `startedAt` (the run's `since`) changes only when the run leaves the gate node and enters it again.
 * It does not change while the run stays there.
 */
export const gateKey = (runId: string, startedAt: number) => `gate:${runId}@${startedAt}`

/**
 * Cleans the briefer's raw answer for the console.
 * It removes control characters other than `\n`.
 * It drops blank lines.
 * It shortens each remaining line to `maxLineLen` characters.
 * It keeps at most `maxLines` lines, oldest first.
 * It returns `''` when no real text remains.
 */
export function clipBrief(raw: string, maxLines = 8, maxLineLen = 200): string {
  return stripControl(raw)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map(l => (l.length > maxLineLen ? `${l.slice(0, maxLineLen - 1)}…` : l))
    .join('\n')
}
