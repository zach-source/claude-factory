/**
 * The home-directory guard (claude-factory: a worktree cleanup script deleted the person's home).
 * Two layers use it:
 *   - `homeReason` runs first in the worker hook. It reads the raw command text, and the text of
 *     each script file the command names (unless the whole command is read-only), before any
 *     parse. A delete word plus a whole-home reference denies the call.
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

/**
 * True when each segment of `command` starts with a bare reader word. Outside single quotes it
 * gives false for a backtick, `$(`, `${`, and outside all quotes for `#`, `$'` and `<<`. For git, only -C <dir> and --no-pager can come before a read
 * subcommand. Any other form gives false (fail closed), so the script read runs.
 * ponytail: a program that an earlier git config or env var sets (diff.external, core.pager,
 * textconv) is not covered. False denies stay for bun test with a file, sed, rg, awk, an
 * absolute-path git, and bd text in double quotes with `$(`, `${` or a backtick. Upgrade path: a real shell parser.
 */
function readOnly(command: string): boolean {
  const cmd = command
  const segs: string[] = []
  let cur = ''
  let q = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    // a line join (backslash, newline) outside single quotes; an escaped backslash is read as a pair below
    if (c === '\\' && cmd[i + 1] === '\n' && q !== "'") {
      i++
      continue
    }
    if (q !== "'" && (c === '`' || (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')))) return false
    if (q) {
      if (c === '\\' && q === '"') cur += c + (cmd[++i] ?? '')
      else {
        if (c === q) q = ''
        cur += c
      }
      continue
    }
    if (c === '\\') {
      cur += c + (cmd[++i] ?? '')
      continue
    }
    // a comment, $'..' string or heredoc breaks the quote tracking: fail closed
    if (c === '#' || (c === '$' && cmd[i + 1] === "'") || (c === '<' && cmd[i + 1] === '<')) return false
    if (c === "'" || c === '"') q = c
    const redirect = c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')
    if (/[;&|()\n]/.test(c) && !redirect) {
      segs.push(cur)
      cur = ''
    } else cur += c
  }
  segs.push(cur)
  return segs.every(s => {
    const w = s.trim().split(/\s+/).filter(Boolean)
    if (!w.length) return true
    if (!READERS.has(w[0]!)) return false
    if (w[0] !== 'git') return true
    let i = 1
    for (;;) {
      if (w[i] === '-C') i += 2
      else if (w[i] === '--no-pager') i++
      else break
    }
    return GIT_SUBS.has(w[i] ?? '')
  })
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
