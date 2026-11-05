/**
 * The home-directory guard (claude-factory: a worktree cleanup script deleted the person's home).
 * Two layers use it:
 *   - `homeReason` runs first in the worker hook. It reads the raw command text, and the text of
 *     each script file the command names (unless the whole command is read-only), before any
 *     parse. A delete word plus a whole-home reference denies the call.
 *   - `rmSafe` replaces each recursive `rmSync` in the runner. It refuses `/`, the home dir and
 *     every dir above the home dir.
 */
import { lstatSync, rmSync, type RmOptions, type Stats } from 'node:fs'
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

/**
 * The APFS full case fold: ASCII lower case, else upper then lower case, so U+017F and the sharp s
 * fold as the file system folds them. It runs on every OS (fail closed).
 */
const fold = (s: string) => (/[^\x00-\x7f]/.test(s) ? s.toUpperCase().toLowerCase() : s.toLowerCase())

/** true for `/`, a home dir and every dir above a home dir, by case-folded compare */
export function protectedPath(p: string, protect = homes()): boolean {
  const r = fold(resolve(p))
  return protect.some(h => {
    const f = fold(h)
    return r === f || f.startsWith(r.endsWith(sep) ? r : r + sep)
  })
}

/**
 * rmSync, but it throws on `/`, $HOME or a parent of $HOME.
 * Bun rmSync can return with no error and keep the tree while another process writes into it.
 * So rmSafe checks the path after the delete. It tries up to 3 times, then it throws.
 * A new object at the same path (a lock that another process took) ends the retry. rmSafe never removes it.
 * ponytail: the identity is dev, ino and birthtimeMs. A reused inode with the same birthtime can look
 * the same. Upgrade path: a flock or a unique lock file name.
 */
export function rmSafe(p: string, opts?: RmOptions, rm: (p: string, o?: RmOptions) => void = rmSync): void {
  if (protectedPath(p)) throw new Error(`refusing to delete ${p}: it is /, $HOME or a dir above $HOME`)
  const id = (s: Stats | undefined) => s && `${s.dev}:${s.ino}:${s.birthtimeMs}`
  const before = id(lstatSync(p, { throwIfNoEntry: false }))
  rm(p, opts)
  if (before === undefined) return
  for (let i = 2; i <= 3; i++) {
    if (id(lstatSync(p, { throwIfNoEntry: false })) !== before) return
    Bun.sleepSync(20 * i)
    rm(p, opts)
  }
  if (id(lstatSync(p, { throwIfNoEntry: false })) === before)
    throw new Error(`rmSafe: ${p} still exists after 3 tries`)
}

/** rmSafe for a finally block: a failed cleanup must not hide the try block's error or result. */
export function rmQuiet(p: string, opts?: RmOptions, rm?: (p: string, o?: RmOptions) => void): void {
  try {
    rmSafe(p, opts, rm)
  } catch {}
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
  for (const h of protect) for (let d = h; d !== dirname(d); d = dirname(d)) paths.add(fold(d))
  const alts = ['~', String.raw`\$home`, String.raw`\$\{home\}`, ...[...paths].map(escape)]
  return new RegExp(`${LEAD}(?:${alts.join('|')})${TAIL}`)
}

// The word regex holds folded text, so it tests folded text. DELETE and API also test the original: rmSync is case-sensitive.
const hits = (text: string, word: RegExp) => {
  const f = fold(text)
  return (DELETE.test(text) || DELETE.test(f)) && (word.test(f) || API.test(text))
}

// a word that names a script file: a script extension, or a ./ or / path
const SCRIPT =
  /(?:^|[\s'"=(`;&|])((?:\.{0,2}\/)?[\w./-]+\.(?:sh|bash|zsh|py|ts|js|mjs|cjs|rb|pl)|\.{1,2}\/[\w./-]+)(?=$|[\s'";&|)`])/g

// the only command words of a read-only command: none of them runs a file it is given
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'diff',
  'grep',
  'echo',
  'printf',
  'cd',
  'bd',
  'git',
])
const GIT_SUBS = new Set(['diff', 'log', 'show', 'status', 'blame'])

// The closed token grammar of readOnly, matched one token at a time (sticky): blanks, a separator,
// a redirect, or a word. A redirect must be followed by a blank, a separator or the end. A word
// piece is a plain char, a single-quoted string, or a double-quoted string with no $, backtick or !
// and a backslash only before a char that bash keeps. The pieces start with different chars, so
// the regex cannot backtrack badly.
const TOKEN =
  /([ \t]+)|(;|&&|\|\||\||\n)|((?:2>&1|>\/dev\/null)(?=[ \t\n;&|]|$))|((?:[\w./:@%+,=^~-]|"(?:[^"\\$`!]|\\[^"\\$`\n!])*"|'[^']*')+)/y
const SED_SCRIPT = /^\d+(,\d+)?p(;\d+(,\d+)?p)*$/

// One reader segment: a reader word, git with a read subcommand, or sed -n with line-range p scripts
function readerSegment(w: string[]): boolean {
  if (w[0] === 'sed') {
    const script = (w[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
    return (
      w[1] === '-n' &&
      SED_SCRIPT.test(script) &&
      !w.slice(3).some(a => a.replace(/['"]/g, '').startsWith('-'))
    )
  }
  if (!READERS.has(w[0] ?? '')) return false
  if (w[0] !== 'git') return true
  let i = 1
  for (;;) {
    if (w[i] === '-C') i += 2
    else if (w[i] === '--no-pager') i++
    else break
  }
  return GIT_SUBS.has(w[i] ?? '')
}

/**
 * True when `command` tokenizes fully in the closed grammar (TOKEN) and each segment, split at
 * ; && || | and newline, is a reader (readerSegment). The only redirects are 2>&1 and >/dev/null
 * (2>/dev/null reads as the word 2 and >/dev/null). Any other char (lone &, <, >, (, ), {, }, $,
 * backtick, #, glob, backslash outside quotes) or an empty segment gives false (fail closed), so
 * the script read runs. A sed word after the script, with quotes removed, must not start with -. For git, only
 * -C <dir> and --no-pager can come before a read subcommand. For sed, only -n with line-range p
 * scripts (no w, e, r, -i, -f).
 * ponytail: a program that an earlier git config or env var sets (diff.external, core.pager,
 * textconv) is not covered. False denies stay for awk, rg, sort, jq, find, xargs, globs, $,
 * subshells, heredocs, line joins and non-reader verbs. Upgrade path: a real shell parser.
 */
function readOnly(command: string): boolean {
  let seg: string[] = []
  for (let pos = 0; pos < command.length;) {
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(command)
    if (!m) return false
    pos = TOKEN.lastIndex
    if (m[4] !== undefined) seg.push(m[4])
    else if (m[2] !== undefined) {
      if (!readerSegment(seg)) return false
      seg = []
    }
  }
  return seg.length > 0 && readerSegment(seg)
}

/**
 * HOME_REASON when `command`, or a script file it names, holds a delete word and a whole-home
 * word. `readFile` reads a named script (small files only); without it, only the command text counts.
 * A read-only command (see readOnly) runs no file, so its named files are not read.
 * ponytail: one level of scripts, no follow of a script that calls another; add it if a bypass shows
 */
export function homeReason(
  command: string,
  readFile?: (path: string) => string | undefined,
  protect = homes(),
): string | undefined {
  const word = homeWord(protect)
  if (hits(command, word)) return HOME_REASON
  if (!readFile || readOnly(command)) return undefined
  for (const m of command.matchAll(SCRIPT)) {
    const text = readFile(m[1]!)
    if (text !== undefined && hits(text, word)) return HOME_REASON
  }
  return undefined
}
