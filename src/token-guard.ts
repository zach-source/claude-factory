/**
 * The harness token guard (claude-factory-qn8a.19). codexWorker links CODEX_HOME/auth.json to the person's
 * ChatGPT login, and Claude keeps its login in .credentials.json, .claude.json or the keychain. A worker never
 * needs these files. Two checks serve the worker hook:
 *   - `tokenReason` reads the raw Bash text, before any parse, as home-guard does.
 *   - `tokenPathReason` checks the path of a Read or Grep tool call.
 * Both fail closed: a path that can name a token file or dir and is not provably inside the worktree is denied.
 * Out of scope (claude-factory-qn8a.72): a name built at run time ('au'+'th.json', base64, printf), a variable set in an
 * earlier call, a recursive read from an ancestor of a token dir (grep -r x ~), a symlink with an innocent name reached
 * through a glob or a bare word, token env vars (CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY), the gh token store, and codex
 * tools other than its shell.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join as joinPath, resolve, sep } from 'node:path'
import { fold, unshell, WORD } from './home-guard'

export const TOKEN_READ_REASON =
  'The factory denies this command: it can read a harness token file (auth.json, .credentials.json, .claude.json) ' +
  'or a token dir (~/.codex, ~/.claude, $CODEX_HOME, $CLAUDE_CONFIG_DIR) outside the worktree, or the keychain. ' +
  'A worker never needs these. If you only name the file in a message, write the text to .scratch/ and pass it ' +
  'with -F or --body-file. Do not retry this exact command.'

const TOKEN_FILES = new Set(['auth.json', '.credentials.json', '.claude.json'])
const TOKEN_DIRS = new Set(['.codex', '.claude'])
// $CODEX_HOME is a component of rule 6 (codexComp), so only the Claude var is listed
const TOKEN_VARS = new Set(['claude_config_dir'])
const KEYCHAIN = new Set(['find-generic-password', 'find-internet-password', 'dump-keychain'])
// a piece ends at blank, quote, backtick, paren, redirect, ;, |, &, = and :. Not at , { } (brace lists stay whole).
const SPLIT = /[\s'"`()<>;|&=:]+/
const PATTERN = /[*?[\]{}!\\$]/
const MARKER = /(?:^|[^\w.-])\.(?:codex|claude)(?![\w.-])|codex_home|claude_config_dir/
// a cd or pushd moves the shell, but pieces resolve against base: a relative token file name then counts as marked
const CD = /(?:^|[\s;&|(])(?:cd|pushd)(?=[\s;&|)]|$)/

// a -C or --chdir flag (env, git, tar) moves the command too. Case matters here: grep -c is no chdir.
const CHDIR = /(?:^|\s)(?:-C|--chdir(?==|\s|$))/

export interface TokenEnv {
  home: string
  codexHome?: string | undefined
  claudeConfigDir?: string | undefined
}

/** the real path of `p`: the nearest existing ancestor through realpath, plus the rest. undefined on any other error */
function realPath(p: string): string | undefined {
  let real = p
  const rest: string[] = []
  for (;;) {
    try {
      return joinPath(realpathSync(real), ...rest)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(real) === real) return undefined
      rest.unshift(basename(real))
      real = dirname(real)
    }
  }
}

/** a checker: is `p` (resolved against `base`) inside the worktree, by lexical and by real path? No root: never. */
function insideOf(root: string | undefined) {
  let realRoot = root
  try {
    if (root) realRoot = realpathSync(root)
  } catch {}
  const roots = [root, realRoot].filter((r): r is string => !!r).map(r => resolve(r))
  const within = (p: string) => roots.some(r => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep))
  return (p: string, base: string) => {
    if (!roots.length || p.split('/').includes('..')) return false
    const abs = resolve(base, p)
    const real = realPath(abs)
    return !!real && within(abs) && within(real)
  }
}

/** expand the brace groups of `s` that hold a top-level comma. Past 256 results it gives ['*'] (fail closed). */
function expand(s: string, left = { n: 256 }): string[] {
  if (--left.n < 0) return ['*'] // the budget counts each call, so the work stays bounded
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (depth++ === 0) start = i
    } else if (s[i] === '}' && depth > 0 && --depth === 0) {
      const alts: string[] = []
      let d = 0
      let from = start + 1
      for (let k = from; k < i; k++) {
        if (s[k] === '{') d++
        else if (s[k] === '}') d--
        else if (s[k] === ',' && d === 0) {
          alts.push(s.slice(from, k))
          from = k + 1
        }
      }
      if (!alts.length) continue
      alts.push(s.slice(from, i))
      return alts.flatMap(a => expand(s.slice(0, start) + a + s.slice(i + 1), left))
    }
  }
  return [s]
}

/**
 * The glob `f` (folded) as a matcher: * is any run, ? and [..] one char, $NAME and $ {..} any run, a stray { } ] ! \ any run.
 * A linear DP over the name, so a run of stars cannot backtrack. The first ] is found once.
 */
function globRe(f: string): { test(name: string): boolean } {
  const toks: (string | null | true)[] = [] // string: a literal char, null: one char, true: any run
  const close = f.indexOf(']', 2)
  for (let i = 0; i < f.length;) {
    const c = f[i] as string
    if (c === '$') {
      const m = /^\$(?:\{[^}]*\}?|\w+|[@*#?!$-])/.exec(f.slice(i))
      toks.push(true)
      i += m ? m[0].length : 1
    } else if (c === '[' && close > i + 1) {
      toks.push(null)
      i = close + 1
    } else if (c === '?') {
      toks.push(null)
      i++
    } else if ('*[{}]!\\'.includes(c)) {
      toks.push(true)
      i++
    } else {
      toks.push(c)
      i++
    }
  }
  return {
    test(name: string) {
      let row = new Array<boolean>(name.length + 1).fill(false)
      row[0] = true
      for (const x of toks) {
        const next = new Array<boolean>(name.length + 1).fill(false)
        if (x === true) {
          let on = false
          for (let j = 0; j <= name.length; j++) next[j] = on = on || !!row[j]
        } else
          for (let j = 1; j <= name.length; j++) next[j] = !!row[j - 1] && (x === null || x === name[j - 1])
        row = next
      }
      return !!row[name.length]
    },
  }
}

/** can the last component `f` (folded) name a token file or a token dir? */
function kind(f: string): { file: boolean; dir: boolean } {
  if (!PATTERN.test(f)) return { file: TOKEN_FILES.has(f), dir: TOKEN_DIRS.has(f) }
  const one = /^\$(?:(\w+)|\{(\w+)\}|\{[^}]*\}|[@*#?!$-])$/.exec(f)
  if (one) return { file: false, dir: TOKEN_VARS.has(one[1] ?? one[2] ?? '') }
  // A name with no literal char ({}, [, *, &!) is shell syntax or a bare wildcard. A variable stands for any text:
  // with fewer than 3 literal chars it would match every token name. A wildcard-only name is covered by rule 6.
  const lits = f.replace(/\$(?:\{[^}]*\}?|\w+|[@*#?!$-])|[*?[\]{}!\\,&()]/g, '').length
  if (lits < (f.includes('$') ? 3 : 2)) return { file: false, dir: false }
  const res = expand(f).map(globRe)
  const hit = (names: Set<string>) => [...names].some(n => res.some(r => r.test(n)))
  return { file: hit(TOKEN_FILES), dir: hit(TOKEN_DIRS) }
}

/** can the folded component `c` name ~/.codex or $CODEX_HOME? A glob needs 2 literal chars (.c*). */
const codexComp = (c: string) =>
  /^\$\{?codex_home\}?$/.test(c) ||
  (PATTERN.test(c) ? expand(c).some(x => globRe(x).test('.codex')) && kind(c).dir : c === '.codex')

function pieceDenied(
  p: string,
  base: string,
  marker: boolean,
  inside: (p: string, base: string) => boolean,
): boolean {
  const comps = p.split('/').filter(Boolean)
  const last = comps.at(-1)
  if (last === undefined) return false
  const f = fold(last)
  const dirParts = comps.slice(0, -1)
  const dyn = p.startsWith('~') || p.startsWith('$') || dirParts.some(c => c.includes('$'))
  const k = kind(f)
  // rule 6: a .codex component or a CODEX_HOME var component anywhere, outside the worktree
  if (comps.some(c => codexComp(fold(c))) && (dyn || !inside(p, base))) return true
  if (!k.file && !k.dir) return false
  if (dyn) return true // rule 5a: never guess an expansion
  // rule 5b: a pattern in the name or in a dir part checks the literal dir prefix
  const lit = [...dirParts]
  const n = lit.findIndex(c => PATTERN.test(c))
  const pat = PATTERN.test(f) || n >= 0
  const target = pat ? (p.startsWith('/') ? '/' : '') + lit.slice(0, n < 0 ? lit.length : n).join('/') : p
  if (!inside(target || '.', base)) return true
  // rule 5c: a relative token file name, with a token marker in the text
  return k.file && marker && !p.startsWith('/')
}

/** the reason to deny the Bash text `command`, or undefined. `base` is the cwd of the call, `root` the worktree. */
export function tokenReason(command: string, base: string, root?: string): string | undefined {
  const inside = insideOf(root)
  const seen = new Set<string>()
  const literal = new Set<string>()
  {
    // unshell drops each backslash-newline, so one pass reads what the joined text would
    const words = [...command.matchAll(WORD)].map(m => unshell(m[0]))
    const joined = fold(words.join(' '))
    const marker = MARKER.test(joined) || CD.test(joined) || CHDIR.test(words.join(' '))
    for (const w of words) {
      if (KEYCHAIN.has(fold(w))) return TOKEN_READ_REASON
      for (const p of w
        .split(SPLIT)
        .flatMap(x => (/,/.test(x) ? [x, ...x.split(/[,{}]/)] : x.split(/[{}]/)))) {
        if (!p) continue
        const key = `${marker ? 1 : 0}${p}`
        if (seen.has(key)) continue
        seen.add(key)
        if (pieceDenied(p, base, marker, inside)) return TOKEN_READ_REASON
        if (p.includes('/') && !PATTERN.test(p)) literal.add(p)
      }
    }
  }
  // rule 7: a symlink with an innocent name that resolves to a token file or dir outside the worktree
  for (const p of literal) {
    const real = realPath(resolve(base, p.startsWith('~/') ? homedir() + p.slice(1) : p))
    if (!real) continue
    const f = fold(basename(real))
    if ((TOKEN_FILES.has(f) || TOKEN_DIRS.has(f)) && !inside(real, base)) return TOKEN_READ_REASON
  }
  return undefined
}

/**
 * The reason to deny a Read (file_path) or Grep (path) tool call, or undefined. A Grep with no path searches `cwd`.
 * A Grep path that equals or holds a known token location is denied, since the search reads the file text.
 */
export function tokenPathReason(
  tool: string,
  input: { file_path?: unknown; path?: unknown } | undefined,
  cwd: string,
  root: string | undefined,
  env: TokenEnv = {
    home: homedir(),
    codexHome: process.env.CODEX_HOME,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  },
): string | undefined {
  const raw = tool === 'Grep' ? input?.path : input?.file_path
  if (tool === 'Grep' && raw === undefined) return undefined
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || /^~[^/]/.test(raw)) return TOKEN_READ_REASON
  const p = raw === '~' || raw.startsWith('~/') ? env.home + raw.slice(1) : raw
  if (insideOf(root)(p, cwd)) return undefined
  const abs = resolve(cwd, p)
  const both = [abs, realPath(abs)].filter((x): x is string => !!x)
  if (both.length < 2) return TOKEN_READ_REASON
  if (tool === 'Grep') {
    const known = [
      joinPath(env.home, '.codex'),
      env.codexHome,
      joinPath(env.home, '.claude'),
      env.claudeConfigDir,
      joinPath(env.home, '.claude.json'),
    ].filter((x): x is string => !!x)
    for (const kn of known)
      for (const v of [resolve(kn), realPath(resolve(kn))])
        for (const a of both)
          if (v && (v === a || v.startsWith(a.endsWith(sep) ? a : a + sep))) return TOKEN_READ_REASON
  }
  for (const a of both) {
    const comps = a.split(sep).filter(Boolean).map(fold)
    const f = comps.at(-1) ?? ''
    if (TOKEN_FILES.has(f) || TOKEN_DIRS.has(f) || comps.includes('.codex')) return TOKEN_READ_REASON
  }
  return undefined
}
