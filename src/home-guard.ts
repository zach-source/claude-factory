/**
 * The home-directory guard (claude-factory: a worktree cleanup script deleted the person's home).
 * Two layers use it:
 *   - `homeReason` runs first in the worker hook. It reads the raw command text, and the text of
 *     each script file the command runs, before any parse. A delete word plus a whole-home
 *     reference denies the call.
 *   - `rmSafe` replaces each recursive `rmSync` in the runner. It refuses `/`, the home dir and
 *     every dir above the home dir.
 */
import { rmSync, type RmOptions } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'

export const HOME_REASON =
  'The factory denies this command: it deletes or moves with a delete word and names the home ' +
  'directory (~, $HOME, the home path, or a dir above it), or it runs a script that does. Name ' +
  'the exact path inside the worktree to delete. Never write a cleanup that can resolve to $HOME.'

/** the home dirs to protect: os.homedir() and $HOME, when they differ */
export function homes(): string[] {
  return [...new Set([homedir(), process.env.HOME].filter((h): h is string => !!h).map(h => resolve(h)))]
}

/** true for `/`, a home dir and every dir above a home dir */
export function protectedPath(p: string, protect = homes()): boolean {
  const r = resolve(p)
  return protect.some(h => r === h || h.startsWith(r.endsWith(sep) ? r : r + sep))
}

/** rmSync, but it throws on `/`, $HOME or a parent of $HOME */
export function rmSafe(p: string, opts?: RmOptions): void {
  if (protectedPath(p)) throw new Error(`refusing to delete ${p}: it is /, $HOME or a dir above $HOME`)
  rmSync(p, opts)
}

// a delete or move word in shell or in a script language
const DELETE =
  /(^|[^\w-])(rm|rmdir|unlink|shred|trash|mv)\b|-delete\b|--delete|\bgit\b[^\n;&|]*\bclean\b|\bworktree\s+remove\b|rmtree|rmSync|rimraf|unlinkSync|remove_dir_all|RemoveAll|os\.remove|Remove-Item|fs\.rm\b|\.rm\(/

// what may follow a whole-home word: the end, a space, a quote, a separator, or `/`, `/*`, `/.`
const TAIL = String.raw`(?=$|[\s'";&|)]|/(?:\*|\.)?(?:$|[\s'";&|)]))`
const LEAD = String.raw`(?:^|[\s'"=(:])`
const API =
  /homedir\(\)|expanduser\(\s*['"]~\/?['"]\s*\)|Path\.home\(\)|UserHomeDir|environ\[\s*['"]HOME['"]\s*\]|getenv\(\s*['"]HOME['"]\s*\)|env\.HOME\b|ENV\[\s*['"]HOME['"]\s*\]/

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** a regex for a whole-home word: ~, $HOME, ${HOME}, a home path or a dir above it (not `/`) */
function homeWord(protect: string[]): RegExp {
  const paths = new Set<string>()
  for (const h of protect) for (let d = h; d !== dirname(d); d = dirname(d)) paths.add(d)
  const alts = ['~', String.raw`\$HOME`, String.raw`\$\{HOME\}`, ...[...paths].map(escape)]
  return new RegExp(`${LEAD}(?:${alts.join('|')})${TAIL}`)
}

const hits = (text: string, word: RegExp) => DELETE.test(text) && (word.test(text) || API.test(text))

// a word that names a script file: a script extension, or a ./ or / path
const SCRIPT =
  /(?:^|[\s'"=])((?:\.{0,2}\/)?[\w./-]+\.(?:sh|bash|zsh|py|ts|js|mjs|cjs|rb|pl)|\.{1,2}\/[\w./-]+)(?=$|[\s'";&|)])/g

/**
 * HOME_REASON when `command`, or a script file it names, holds a delete word and a whole-home
 * word. `readFile` reads a named script (small files only); without it, only the command text counts.
 * ponytail: one level of scripts, no follow of a script that calls another; add it if a bypass shows
 */
export function homeReason(
  command: string,
  readFile?: (path: string) => string | undefined,
  protect = homes(),
): string | undefined {
  const word = homeWord(protect)
  if (hits(command, word)) return HOME_REASON
  if (!readFile) return undefined
  for (const m of command.matchAll(SCRIPT)) {
    const text = readFile(m[1]!)
    if (text !== undefined && hits(text, word)) return HOME_REASON
  }
  return undefined
}
