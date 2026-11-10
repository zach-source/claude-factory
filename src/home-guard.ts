/**
 * The home-directory guard (claude-factory: a worktree cleanup script deleted the person's home).
 * Two layers use it:
 *   - `homeReason` runs first in the worker hook. It reads the raw and the backslash-newline-joined command text, and the text of
 *     each script file the command names (unless the whole command is read-only), before any
 *     parse. It also reads the texts that git hooks, git config values and config files load. A delete word plus a whole-home reference denies the call.
 *   - `rmSafe` replaces each recursive `rmSync` in the runner. It refuses `/`, the home dir and
 *     every dir above the home dir.
 */
import { lstatSync, rmSync, type RmOptions, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'

export const HOME_REASON =
  'The factory denies this command: it deletes or moves with a delete word and names the home ' +
  'directory (~, $HOME, the home path, or a dir above it), or it runs a script, a git hook or a ' +
  'config file that does. Name the exact path inside the worktree to delete. Never write a cleanup ' +
  'that can resolve to $HOME.'

export const LOADED_REASON =
  'The factory denies this command: it cannot read the git config of this directory, or the hooks, ' +
  'config files and node_modules/.bin files there are too many or too large to check (over 1024 ' +
  'files or 4 MiB). Run the command from a smaller worktree, or ask the manager.'

export const OVERRIDE_REASON =
  'The factory denies this command: it names core.hooksPath, include.path or includeIf, or ' +
  'runs a git alias that does. The home guard cannot check the programs that such a setting ' +
  'loads. To search, use the Grep tool. For a commit message, use git commit -F <file>.'

// claude-factory-qn8a.37.14: an inline hooks dir or include override. The rule reads no value.
const OVERRIDE = /hookspath|include\.path|includeif\./
const strip = (t: string) =>
  t
    .replace(/\\\n/g, '')
    .replace(/['"\\$]/g, '')
    .toLowerCase()

/** the most files that the guard reads for the loaded texts of one command; the next read denies */
export const MAX_LOADED_READS = 64

/** the home dirs to protect: os.homedir() and $HOME, when they differ */
export function homes(): string[] {
  return [...new Set([homedir(), process.env.HOME].filter((h): h is string => !!h).map(h => resolve(h)))]
}

/**
 * The APFS full case fold: ASCII lower case, else upper then lower case, so U+017F and the sharp s
 * fold as the file system folds them. It runs on every OS (fail closed).
 */
export const fold = (s: string) => (/[^\x00-\x7f]/.test(s) ? s.toUpperCase().toLowerCase() : s.toLowerCase())

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

// claude-factory-ty63u: a cd, a pushd or a shell assignment of a whole-home word
const BIND = String.raw`(?:\b(?:cd|pushd)\s+(?:--\s+)?|\w=)['"]?`

/** a regex for a whole-home word: ~, $HOME, ${HOME}, a home path or a dir above it (not `/`) */
function homeWord(protect: string[], lead = LEAD): RegExp {
  const paths = new Set<string>()
  for (const h of protect) for (let d = h; d !== dirname(d); d = dirname(d)) paths.add(fold(d))
  const alts = ['~', String.raw`\$home`, String.raw`\$\{home\}`, ...[...paths].map(escape)]
  return new RegExp(`${lead}(?:${alts.join('|')})${TAIL}`)
}

// The word regex holds folded text, so it tests folded text. DELETE and API also test the original: rmSync is case-sensitive.
// Bash joins backslash-newline before it splits words, so the guard tests the joined text too. The join
// reads backslash pairs left to right: an escaped backslash stays, so an even run keeps its newline as a
// separator and a later backslash-newline in the next word still joins. The raw text stays tested too.
const join = (s: string) => s.replace(/\\([\s\S])/g, (m, c) => (c === '\n' ? '' : m))
const test1 = (text: string, word: RegExp) => {
  const f = fold(text)
  return (DELETE.test(text) || DELETE.test(f)) && (word.test(f) || API.test(text))
}
const hits = (text: string, word: RegExp) => test1(text, word) || test1(join(text), word)
// remove the JSON and TOML string escapes (a package.json script that puts \" around the home word)
const unjson = (t: string) => t.replace(/\\(["\\/])/g, '$1')

/**
 * claude-factory-ty63u: the test for a file that a loaded text names. That file can run for no command
 * (pwd, git status), yet a hit denies every command in the tree. So a hit needs a delete word and a
 * home word on one line (raw or joined), or a delete word and a home API or a cd, pushd or assignment
 * of a home word (`bind`) anywhere in the file.
 * ponytail: a line pair with no API or bind is not seen (`D=~/x` then `rm -rf ${D%/x}`). A command-named
 * script keeps the whole-file test. Upgrade path: a real shell parser.
 */
const namedFileHits = (t: string, word: RegExp, bind: RegExp) =>
  hits(t, bind) || [t, join(t)].some(s => s.split('\n').some(l => test1(l, word)))

// a run of path chars between a lead and a terminator char; ':' ends a path:line word
const SCRIPT = /(?:^|[\s'"=(`;&|:<>])([\w./-]+)(?=$|[\s'";&|)`:<>])/g
// a word names a file to read when it holds a / or ends in a script extension
const isFile = (w: string) => w.includes('/') || /\.(?:sh|bash|zsh|py|ts|js|mjs|cjs|rb|pl)$/i.test(w)

// A shell word is a run of: a char that is no blank, quote, backslash or metachar; a backslash and its next char;
// a quoted string (an unclosed quote runs to the end).
// Out of scope (denyReason denies most): a bare word without / or extension, $VAR, $(...), brace and glob
// expansion, ~user/, a script that calls a script, a file over the read limit.
export const WORD = /(?:[^\s'"\\;&|<>()`]|\\[\s\S]|'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?)+/g
export const unshell = (w: string) =>
  w.replace(/\\([\s\S])|'([^']*)'?|"((?:[^"\\]|\\[\s\S])*)"?/g, (_, esc, sq, dq) =>
    esc !== undefined
      ? esc === '\n'
        ? ''
        : esc
      : sq !== undefined
        ? sq
        : dq.replace(/\\\n/g, '').replace(/\\([$`"\\])/g, '$1'),
  )
// the word, its pieces split at = and :, and a leading ~/ replaced by each protected home
const candidates = (w: string, protect: string[]) =>
  [w, ...w.split(/[=:]/)].flatMap(c => (c.startsWith('~/') ? protect.map(h => h + c.slice(1)) : [c]))

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

const unquote = (a: string) => a.replace(/['"]/g, '')

// A Spec lists the words of a verb that never runs a file it names. `flags` and `value` are
// closed sets with exact match. The next word after a `value` flag is its value. `noColon`
// denies a positional word with a colon.
type Spec = { flags: string[]; value?: string[]; noColon?: boolean }
const GIT_NON_RUNNERS: Record<string, Spec> = {
  add: { flags: ['--', '-A', '--all', '-u', '--update', '-N', '--intent-to-add', '-v', '-f'] },
  commit: {
    flags: ['--', '-a', '-q', '--quiet', '--amend', '--no-edit', '-s', '-v'],
    value: ['-m', '-am', '-F'],
  },
  checkout: { flags: ['--', '-q', '-b', '-B'] },
  restore: { flags: ['--', '--staged', '--worktree', '-S', '-W', '-q'] },
  fetch: { flags: ['-q', '--quiet', '--prune', '-p', '--all', '--tags', '--no-tags'], noColon: true },
}
/** The only factory path that is a non-runner, besides the bare word. Any other path is a file to read. */
export const FACTORY_BIN = resolve(import.meta.dir, '..', 'bin', 'factory')
const FACTORY_SPEC: Spec = {
  flags: [],
  value: ['--summary-file', '--from', '--kind', '--rig', '--until', '--supersedes'],
}
const FACTORY_SUBS = new Set(['report', 'mail'])
const FACTORY_MEMORY_SUBS = new Set(['add', 'search', 'helped'])
const PRETTIER_SPEC: Spec = { flags: ['--write', '-w', '--check', '-c', '-l', '--list-different'] }
const MKDIR_SPEC: Spec = { flags: ['-p', '-v'] }

// the index of the git subcommand: only -C <dir> and --no-pager can come before it
function gitSub(w: string[]): number {
  let i = 1
  for (;;) {
    if (w[i] === '-C') i += 2
    else if (w[i] === '--no-pager') i++
    else return i
  }
}

// each word is a positional word, a flag of the closed set, or a value flag and its value
function argsOk(w: string[], s: Spec): boolean {
  for (let i = 0; i < w.length; i++) {
    const a = unquote(w[i]!)
    if (s.value?.includes(w[i]!)) i++
    else if (a.startsWith('-')) {
      if (!s.flags.includes(a)) return false
    } else if (s.noColon && a.includes(':')) return false
  }
  return true
}

// One non-runner segment: a verb of the closed table above, with words only from its grammar
function nonRunner(w: string[]): boolean {
  const v = w[0] ?? ''
  if (v === 'mkdir') return argsOk(w.slice(1), MKDIR_SPEC)
  if (v === 'bunx') return /^prettier(@[\d.]+)?$/.test(w[1] ?? '') && argsOk(w.slice(2), PRETTIER_SPEC)
  if (v === 'factory' || v === FACTORY_BIN) {
    const sub = FACTORY_SUBS.has(w[1] ?? '')
      ? 2
      : w[1] === 'memory' && FACTORY_MEMORY_SUBS.has(w[2] ?? '')
        ? 3
        : 0
    return sub > 0 && argsOk(w.slice(sub), FACTORY_SPEC)
  }
  if (v === 'git') {
    const i = gitSub(w)
    const k = w[i] ?? ''
    const s = Object.hasOwn(GIT_NON_RUNNERS, k) ? GIT_NON_RUNNERS[k] : undefined
    return !!s && argsOk(w.slice(i + 1), s)
  }
  return false
}

// One reader or non-runner segment: a reader word, git with a read subcommand, or sed -n with line-range p scripts
function readerSegment(w: string[]): boolean {
  if (nonRunner(w)) return true
  if (w[0] === 'sed') {
    const script = (w[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
    return w[1] === '-n' && SED_SCRIPT.test(script) && !w.slice(3).some(a => unquote(a).startsWith('-'))
  }
  if (!READERS.has(w[0] ?? '')) return false
  if (w[0] !== 'git') return true
  return GIT_SUBS.has(w[gitSub(w)] ?? '')
}

/**
 * True when `command` tokenizes fully in the closed grammar (TOKEN) and each segment, split at
 * ; && || | and newline, is a reader or a non-runner (readerSegment). A non-runner is git add,
 * commit, checkout, restore or fetch, bunx prettier, factory report, mail or memory add|search|helped,
 * or mkdir. Its words must be positional or in the verb's closed flag sets (nonRunner). The only redirects are 2>&1 and >/dev/null
 * (2>/dev/null reads as the word 2 and >/dev/null). Any other char (lone &, <, >, (, ), {, }, $,
 * backtick, #, glob, backslash outside quotes) or an empty segment gives false (fail closed), so
 * the script read runs. A sed word after the script, with quotes removed, must not start with -. For git, only
 * -C <dir> and --no-pager can come before a read subcommand. For sed, only -n with line-range p
 * scripts (no w, e, r, -i, -f).
 * ponytail: for what the loaded texts of homeReason cover and do not cover, see loadedTexts in
 * src/worker-hook.ts. False denies stay for awk, rg, sort, jq, find, xargs, globs, $, subshells,
 * heredocs, line joins and verbs outside the reader and non-runner tables. Upgrade path: a real
 * shell parser.
 */
function readOnly(command: string): boolean {
  let seg: string[] = []
  for (let pos = 0; pos < command.length; ) {
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

/** A text that a config file or a git hook loads, and the dir that its relative paths resolve against. */
export type LoadedText = { text: string; dir: string; alias?: true }

/**
 * Test the named files of `text` with `check`. With `dir`, each path resolves against `dir` and the
 * reads count against MAX_LOADED_READS ('cap' past it).
 */
function namedHits(
  text: string,
  readFile: (path: string) => string | undefined,
  check: (body: string) => boolean,
  protect: string[],
  seen: Set<string>,
  dir?: string,
  reads?: { n: number },
): boolean | 'cap' {
  const paths = [
    ...[...text.matchAll(SCRIPT)].map(m => m[1]!),
    ...[...join(text).matchAll(SCRIPT)].map(m => m[1]!),
    ...[...text.matchAll(WORD)].flatMap(m => candidates(unshell(m[0]), protect)),
  ]
  for (const w of paths) {
    if (!isFile(w)) continue
    const path = dir === undefined ? w : resolve(dir, w)
    if (seen.has(path)) continue
    seen.add(path)
    const body = readFile(path)
    if (body === undefined) continue
    if (reads && ++reads.n > MAX_LOADED_READS) return 'cap'
    if (check(body)) return true
  }
  return false
}

/**
 * HOME_REASON when `command`, a script file it names, or a loaded text holds a delete word and a
 * whole-home word. `readFile` reads a named script (small files only); without it, only the command text counts.
 * `loaded` holds the texts that git hooks, git config values and config files load (the worker hook
 * builds them). null means the loader failed: LOADED_REASON. With a
 * loader, a command or alias text that names core.hooksPath, include.path or includeIf gives
 * OVERRIDE_REASON. A loaded text is always tested, also for a
 * read-only command, and the files it names are read once (one level) and tested by namedFileHits.
 * A read-only command (see readOnly: readers and non-runners) runs no file, so its named files are not read.
 * ponytail: one level of scripts, no follow of a script that calls another; add it if a bypass shows
 */
export function homeReason(
  command: string,
  readFile?: (path: string) => string | undefined,
  protect = homes(),
  loaded?: LoadedText[] | null,
): string | undefined {
  const word = homeWord(protect)
  const bind = homeWord(protect, BIND)
  const loadedCheck = (b: string) => namedFileHits(b, word, bind) || namedFileHits(unjson(b), word, bind)
  if (hits(command, word)) return HOME_REASON
  if (loaded === null) return LOADED_REASON
  if (loaded !== undefined && OVERRIDE.test(strip(command))) return OVERRIDE_REASON
  const loadedSeen = new Set<string>()
  const reads = { n: 0 }
  for (const { text, dir, alias } of loaded ?? []) {
    if (alias && OVERRIDE.test(strip(text))) return OVERRIDE_REASON
    if (hits(text, word) || hits(unjson(text), word)) return HOME_REASON
    if (!readFile) continue
    const r = namedHits(text, readFile, loadedCheck, protect, loadedSeen, dir, reads)
    if (r === 'cap') return LOADED_REASON
    if (r) return HOME_REASON
  }
  if (!readFile || readOnly(command)) return undefined
  return namedHits(command, readFile, b => hits(b, word), protect, new Set<string>())
    ? HOME_REASON
    : undefined
}
