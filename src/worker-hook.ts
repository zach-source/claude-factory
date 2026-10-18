/**
 * This PreToolUse hook for Bash denies `rm -r` and `rm -rf` in all spellings or wrappers.
 * It denies a chain of commands that holds a `cd` command and an `rm` command.
 * It denies an `rm` command with a target that holds a `$variable` expansion or a glob.
 * It denies an `rm` command with a target that resolves to a path external to the worktree root (claude-factory-99d).
 * It gives the reason at once, and the worker reads it and goes on.
 * The worker does not wait 2 minutes for Claude Code's own permission prompt.
 *
 * The prompt-only fix of claude-factory-9wu (src/worker-system.md) was not enough.
 * After PR #38 merged, two workers stopped at the prompt: lifecycle-mva1ki70a9 and lifecycle-mva7smkfhf.
 * A later worker (lifecycle-mvaf3xiato) stopped the same way on `rm -i "$X"/*`.
 * The -r/-rf check alone did not catch a variable or glob target with no recursive flag.
 *
 * It also denies a kubectl, ko or helm command against a rig's person-only kube context (claude-factory-25z).
 * Two deploy stations in the ax rig ran `kubectl --context acme apply`. The rig's goal reserves that step
 * for a person. An old memory note told the stations to run it anyway. A prose rule alone did not stop
 * the second station.
 * This hook receives the rig's list in its own argv: `--person-only-contexts a,b`.
 *
 * It also denies `gh pr merge` and `gh repo sync` (claude-factory-zl5).
 * It denies a GraphQL or REST call that merges a pull request.
 * It denies a GraphQL or REST call that turns on a pull request's auto-merge.
 * The owner decided that only a person merges a pull request.
 * GitHub's admin bypass lets a worker merge, even under a ruleset that needs a review.
 * Before this guard, two pull requests merged before their review ran (ax-aw1).
 *
 * It also denies `gh pr ready` outside the release station (claude-factory-zl5.2).
 * Implement opens a pull request as a draft. Only release marks it ready for review, once verify,
 * review and security pass. `gh pr ready --undo` (back to draft) is always allowed.
 *
 * It also denies a `git push` to a protected branch (claude-factory-zl5.3).
 * A protected branch is main or master: the rig's default branch.
 * A protected branch is also the branch that `origin/HEAD` points to.
 * A rig can also set a protected branch with `--protected-branch`.
 * This hook reads that list from its own argv, as `--protected-branches a,b`.
 *
 * A worker must push its own run branch, and open a pull request for it.
 * Only a person can push a protected branch.
 * The owner made the same rule for a merge: only a person can merge.
 * `git push -n` is a dry run: it does not push anything.
 * The hook allows a dry run at all times.
 *
 * It also denies one command that changes to a new branch and pushes HEAD to that branch (claude-factory-c63).
 * This hook reads the branch one time, before the change.
 * A later comparison with that name can miss the real, new target.
 * These commands can each change the branch:
 *   - `git checkout`
 *   - `git switch`
 *   - `git branch` with a rename flag
 *   - a `git symbolic-ref` write
 *   - `git rebase` with an explicit `<branch>` operand, or `git rebase --root <branch>`
 *   - `git stash branch <name>`
 *   - `git bisect reset <commit>`
 *   - `git update-ref --stdin`, which can run a hidden `symref-update HEAD <ref>` line
 *   - `gh pr checkout`
 * This hook denies the combination without the new branch name.
 *
 * This hook only denies.
 * It never approves a command that Claude Code's own prompt would refuse.
 * claude-factory-9wu rejected another design: a hook that approves `rm -rf`, which is a safety regression.
 * If a parse error occurs, the hook fails open and prints nothing.
 * Claude Code's own prompt stays the backstop.
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path'

export const REASON =
  'The factory denies this command: do not run rm -r or rm -rf, do not chain cd with rm, and do not ' +
  'rm a $variable path, a glob, or a path outside the worktree. ' +
  'Leave .scratch as is, use a new subfolder (for example .scratch/<name>-2): git ignores .scratch/. ' +
  'Use absolute paths or git -C <dir> in place of cd. Do not retry this command.'

// claude-factory-25z
export const LIVE_REASON =
  'The factory denies this command: in this rig only a person changes the live kube contexts. ' +
  'A kubectl, ko or helm command that mutates state there is refused, including one that names no ' +
  '--context, or a --context or --cluster whose value is not a literal name (fail closed: the ' +
  'current context is unknown here). This guard matches context and cluster names only. ' +
  'Do not retry this command. Report blocked: "parked, waiting on: <the exact command>".'

// claude-factory-25z.20, extended on every rig by claude-factory-dts: a command this long can
// make the guard's own scan slow enough to miss the 10 s PreToolUse hook timeout, which lets the
// command run unchecked.
const MAX_COMMAND_LENGTH = 8192

// claude-factory-dts: this cap now applies on every rig, not only one with a person-only kube
// context. A worker that hits this on a long report summary, bd description or PR body can put
// that text in a file under .scratch/ and pass it with --body-file, or as "$(cat .scratch/<name>)".
export const LONG_COMMAND_REASON =
  'The factory denies this command: it is longer than 8192 characters. A command this long can ' +
  "make the factory's own check too slow, on every rig. Split this command into shorter " +
  'commands and run them one at a time. For a long report summary, bd description or pull ' +
  'request body, put the text in a file under .scratch/ and pass it with --body-file, or as ' +
  '"$(cat .scratch/<name>)". Do not retry this exact command.'

// claude-factory-zl5
export const MERGE_REASON =
  'The factory denies this command: a worker never merges a pull request and never turns its ' +
  'auto-merge on. Only a person merges, by owner decision. This covers gh pr merge, gh repo sync, ' +
  'and a GraphQL or REST call that merges a pull request or a branch, or marks it for auto-merge. ' +
  'Report the pull request link and what it waits on; leave it open. Do not retry this command.'

// claude-factory-zl5.2
export const READY_REASON =
  'The factory denies this command: only the release station marks a pull request ready for ' +
  'review. Keep the pull request a draft here; report its link in your summary. Release marks it ' +
  'ready after verify, review and security pass. Do not retry this command.'

// claude-factory-zl5.22
export const ALIAS_REASON =
  'The factory denies this command: gh alias set and git config alias.<name> name another ' +
  'command, and this hook checks one command at a time, with no memory of an alias a prior ' +
  'command set. It denies an alias whose own text already denies, and gh alias import outright: ' +
  'that command reads a file of aliases this hook cannot check. Run the full command directly, ' +
  'with no alias. Do not retry this command.'

// claude-factory-bemr: a git or gh alias in this host's config can hide a denied verb.
// The alias can be set before this run started. It can name a denied verb such as push or checkout.
// gitReason and ghReason compare only literal builtin verb names. So the old alias hid the real verb (claude-factory-c63 bypass).
//
// This guard now looks up an unknown git or gh verb in gate.gitAliases or gate.ghAliases.
// It splits the expansion text into words. Real git and gh do the same.
// Then it scans the expanded command again.
//
// The guard denies with ALIAS_USE_REASON, not a silent allow, in these cases:
//
//   - it cannot read the alias table;
//
//   - the table sits behind an earlier directory or config-dir change;
//
//   - the alias runs a shell command;
//
//   - its text holds a character this guard cannot split;
//
//   - the chain of aliases runs past MAX_ALIAS_DEPTH levels;
//
//   - an unknown global flag (claude-factory-bemr.5) leaves the verb position unsure, and a
//     later word before -- matches a key in the alias table.
export const ALIAS_USE_REASON =
  'The factory denies this command: its first word is not a plain git or gh verb, and this guard ' +
  'cannot read it as a safe, pre-existing alias. A git or gh alias set before this run started can ' +
  'hide a denied verb, such as push or checkout, with no new word of its own on this command line. ' +
  'This guard denies the word when it cannot read the git or gh alias table (no answer from git ' +
  'config or gh alias list), when the table sits behind an earlier cd, pushd, popd, chdir, env -C, ' +
  '--git-dir, GH_CONFIG_DIR, XDG_CONFIG_HOME, or HOME change, when the alias runs a shell command ' +
  '(a leading !), when a gh alias text holds a dollar sign, a quote, or a backslash gh cannot ' +
  'split safely, when a git alias text holds an unclosed quote or a trailing backslash git cannot ' +
  'split, when an unknown global flag leaves the verb word unsure and a later word matches a known ' +
  'alias, or past a chain of 10 aliases. Run the full command directly, with no alias. Do not ' +
  'retry this exact command.'

// claude-factory-bemr: the depth cap on a chain of git or gh aliases that each expand to another
// alias (alias.x=y, alias.y=z, ...). Real git and gh each follow such a chain themselves; this
// guard fails closed past this many levels, the same fail-closed rule MAX_SHELL_DEPTH uses for a
// stacked eval or sh -c chain.
const MAX_ALIAS_DEPTH = 10

// claude-factory-zl5.3
export const PUSH_REASON =
  'The factory denies this command: a worker never pushes straight to a protected branch, by ' +
  'owner decision. A protected branch is main, master, the branch origin/HEAD names, or a branch ' +
  'the rig names with --protected-branch. Push your run branch instead, and open a pull request ' +
  'for the change, or a revert pull request for a rollback. Only a person pushes or merges a ' +
  'protected branch. Do not retry this command.'

// claude-factory-68gn: a cd, pushd, popd or chdir word can change the directory before a git
// push or git send-pack word. An env -C flag, an env --chdir flag, or a git --git-dir flag can
// do the same thing. Each one can move the push to a different repository.
//
// This guard cannot read the branch in that other repository. So it fails closed, the same way
// claude-factory-zl5.12 already does for an unresolved HEAD.
export const PUSH_DIR_REASON =
  'The factory denies this command: it changes the current directory (cd, pushd, popd, chdir, ' +
  'env -C, --chdir, or git --git-dir) before a git push or git send-pack. The factory cannot ' +
  'read the current branch there. A push that names HEAD or @ then denies outright. Name the ' +
  'remote branch directly instead, for example git push origin <run branch>, and never name a ' +
  'protected branch. Do not retry this exact command.'

// claude-factory-vco
export const ENV_SPLIT_ESCAPE_REASON =
  'The factory denies this command: an env -S or env --split-string value holds a backslash or ' +
  'a newline. env reads an escape such as \\_ as a word break, so this guard cannot read the ' +
  'real command. Write the command words plainly, without env -S. Do not retry this exact ' +
  'command.'

// claude-factory-z1p: the env -S and --split-string flags change a ${NAME} word in the value
// into one command word when env runs. denyAt reads only the typed text, so it cannot see the
// changed command (GNU env 9.11 and macOS /usr/bin/env both do this).
//
// A dollar sign with no braces makes env -S stop with an error. So this guard can deny any
// dollar sign in the value with no cost: no real command uses that form (checked on macOS,
// 2026-10-17).
export const ENV_SPLIT_VAR_REASON =
  'The factory denies this command: an env -S or env --split-string value holds a dollar sign. ' +
  'env expands ${NAME} in this value into a command word, so this guard cannot read the real ' +
  'command. Write the command words plainly, without env -S. Do not retry this exact command.'

// claude-factory-zl5.33
export const XARGS_REASON =
  'The factory denies this command: xargs runs right before a git or gh word. xargs can append ' +
  'its own operand, read from its own stdin, such as a push refspec or a gh verb. This guard ' +
  'checks the text of this command line, so it cannot read that operand before xargs does. ' +
  'Run the git or gh command directly, with every argument in the command line itself. ' +
  'Do not retry this exact command.'

/**
 * `gate` carries the context this guard needs for the merge-gate checks (claude-factory-zl5): the
 * running station's name, the rig's protected branch names, and small reads of the live repo and
 * filesystem a unit test can fake out. `main()` wires the real ones; a test passes its own.
 */
export interface HookGate {
  /** the running station, from FACTORY_FROM. Only the release station may mark a pull request ready. */
  station?: string
  /** branch names a worker never pushes to directly; defaults to main and master when unset or empty */
  protectedBranches?: string[]
  /** the short branch name `git -C <dir> symbolic-ref --short HEAD` reports, or undefined on any
   * error. `timeoutMs` bounds the git spawn (claude-factory-dts.4). */
  headOf?: (dir?: string, timeoutMs?: number) => string | undefined
  /** the short branch name the repo's `origin/HEAD` points to, or undefined on any error.
   * `timeoutMs` bounds the git spawn (claude-factory-dts.4). */
  originHead?: (timeoutMs?: number) => string | undefined
  /** the text of a small file this guard needs to read (a `gh api graphql` query file), capped and
   * resolved relative to the tool call's own cwd; undefined when it cannot be read */
  readFile?: (path: string) => string | undefined

  /** claude-factory-bemr: a map from a git alias name (lowercase, with no `alias.` prefix) to its
   * raw config expansion text, for every `alias.<name>` key `git -C <dir> config --get-regexp
   * ^alias\.` already set before this run started. Empty when the repo at `dir` sets none;
   * undefined on any read error. `timeoutMs` bounds the git spawn (claude-factory-dts.4). */
  gitAliases?: (dir?: string, timeoutMs?: number) => Map<string, string> | undefined
  /** claude-factory-bemr: a map from a gh alias name to its raw expansion text, from `gh alias
   * list`. gh ships one alias of its own (`co: pr checkout`), so this is defined even with no
   * user config; undefined only on a read error. `timeoutMs` bounds the gh spawn
   * (claude-factory-dts.4). */
  ghAliases?: (timeoutMs?: number) => Map<string, string> | undefined
}

/**
 * claude-factory-c63: `gitReason` reads the current branch one time. It uses `gate.headOf` to read
 * the branch when it examines a `git push` or `git send-pack` word.
 * One command can run a word that changes the branch, for example `git checkout main`.
 * The same command can later push `HEAD` to that branch.
 * `gate.headOf` reads the branch before that change, so a comparison with its answer misses the real target.
 *
 * `ScanState` monitors two facts, `branchChange` and `headPush`, across one whole top-level call to `denyAt`.
 * It monitors them across every segment and every recursion into a nested shell, `eval`, or `env -S` script
 * (claude-factory-c63). `denyReason` makes the object one time.
 * Each function that sees a word that changes the branch, or that pushes `HEAD`, passes that object on.
 *
 * `branchChange` becomes true when a segment holds a word that changes the branch that `gate.headOf` reports next.
 * These words are:
 *   - `git checkout`
 *   - `git switch`
 *   - `git branch` with a rename flag
 *   - a `git symbolic-ref` write
 *   - `git rebase` with an explicit `<branch>` operand, or `git rebase --root <branch>`
 *   - `git stash branch <name>`
 *   - `git bisect reset <commit>`
 *   - `git update-ref --stdin`, which can run a hidden `symref-update HEAD <ref>` line
 *   - `gh pr checkout`
 *
 * `headPush` becomes true when a segment holds a `git push` or `git send-pack` call.
 * Its refspec reads `currentBranch`. A call counts when it is bare, or when its refspec is a no-colon `HEAD` alias.
 *
 * `denyReason` denies with `PUSH_REASON` when both `branchChange` and `headPush` are true.
 * It does not need the new branch name. The check denies such a command.
 * A branch name read before the move does not prove that the push is safe.
 */
interface ScanState {
  branchChange: boolean
  headPush: boolean
}

// claude-factory-epz: anyShellReason recurses once for each stacked eval or sh -c word, with no
// limit. A command with many stacked eval words can make this guard's own scan too slow. The scan
// can then miss the 10 s PreToolUse hook timeout. A hook that times out lets the command run (fail
// open). denyAt gives this reason instead, past MAX_SHELL_DEPTH recursion levels (fail closed).
export const DEEP_COMMAND_REASON =
  'The factory denies this command: it nests more than 32 eval or sh -c levels, and the factory ' +
  'cannot check a command this deep in time. Run the inner command directly. Do not retry this exact command.'

// claude-factory-epz: the recursion limit for denyAt's eval/sh -c levels. 16 is too low: the
// claude-factory-25z.17 STACKED_EVAL tests use 24 levels, and need their old REASON or
// LIVE_REASON verdict. 32 keeps those tests green. At 32, a 4000-level stacked-eval `rm` form is a
// 31 ms deny, far inside the 10 s hook timeout.
const MAX_SHELL_DEPTH = 32

// wrapper commands whose own name we skip to find the command they run
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time'])

/** the basename of a command word: drops a leading backslash (`\rm`) and any path (`/bin/rm`) */
function baseWord(w: string): string {
  const s = w.replace(/^\\/, '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * Splits a command string into segments (shell words).
 * It splits on &&, ||, ;, |, &, a newline, ( ), $( and a backtick.
 * It keeps a single-quoted span literal.
 * It reads a backslash escape (\\ \" \$ \`) inside a double-quoted span.
 * It reads a backslash escape outside quotes too.
 * A segment keeps one shell word per space.
 * A quoted span with spaces inside stays one word, so a quoted argument such as "rm -rf x" never
 * splits into separate rm/-rf/x words.
 *
 * A backslash right before a real newline is a POSIX line continuation, inside double quotes or
 * outside them. Both characters drop and the text around them joins into one word, the same as a
 * real shell. This never ends a word. It never keeps a literal newline.
 */
function segments(cmd: string): string[][] {
  const segs: string[][] = []
  let cur: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (hasWord) cur.push(word)
    word = ''
    hasWord = false
  }
  const endSeg = () => {
    endWord()
    segs.push(cur)
    cur = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      hasWord = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      // a backslash-newline is a POSIX line continuation even inside double quotes: the shell
      // removes both characters and joins the surrounding text, it does not keep a literal newline.
      else if (c === '\\' && cmd[i + 1] === '\n') i++
      else if (c === '\\' && '"\\$`'.includes(cmd[i + 1] ?? '')) word += cmd[++i]
      else word += c
      hasWord = true
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      hasWord = true
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) {
      // a backslash-newline outside quotes is a POSIX line continuation: the shell removes both
      // characters and joins the text around them into one word. It does not end the word and it
      // does not keep a literal newline.
      if (cmd[i + 1] === '\n') {
        i++
        continue
      }
      word += cmd[++i]
      hasWord = true
      continue
    }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
      endSeg()
      i++
      continue
    }
    if (';|&\n()`'.includes(c)) {
      endSeg()
      continue
    }
    if (/\s/.test(c)) {
      endWord()
      continue
    }
    word += c
    hasWord = true
  }
  endSeg()
  return segs.filter(s => s.length > 0)
}

/** true when `w` is a short-flag cluster (e.g. `-rf`) or a long flag (`--recursive`) that means recursive */
function recursiveFlag(w: string): boolean {
  if (w === '--recursive' || w.startsWith('--recursive=')) return true
  if (w.startsWith('--')) return false
  if (w.startsWith('-') && w.length > 1) return /[rR]/.test(w.slice(1))
  return false
}

/**
 * `words` is an rm command and its args. `words[start]` is the rm word itself.
 * This function returns true when `words` asks for a recursive delete.
 * It stops at the first `--` word or the first non-flag word.
 *
 * claude-factory-lbn: this function reads `words` by index. It does not call
 * `words.slice(start + 1)`. The find branch below calls this function once for each
 * `-exec rm` or `-execdir rm` word. A slice there would still cost O(n) for each call, and
 * O(n^2) in total.
 */
function isRecursiveRm(words: string[], start = 0): boolean {
  for (let k = start + 1; k < words.length; k++) {
    const w = words[k]!
    if (w === '--') return false
    if (w.startsWith('-')) {
      if (recursiveFlag(w)) return true
      continue
    }
    return false
  }
  return false
}

/**
 * Returns the operands of an rm command. `words[0]` is the rm word itself.
 * An operand is a non-flag word before a `--`, or any word after a `--`
 * (a word there can start with `-` and still be a path).
 */
function rmTargets(words: string[]): string[] {
  const targets: string[] = []
  let afterDashDash = false
  for (const w of words.slice(1)) {
    if (afterDashDash) {
      targets.push(w)
      continue
    }
    if (w === '--') {
      afterDashDash = true
      continue
    }
    if (!w.startsWith('-')) targets.push(w)
  }
  return targets
}

/**
 * Checks rm target `t` for risk.
 * A `$` expansion, a glob char (`*`, `?`, `[`), or a leading `~` makes `t` risky.
 * A path that resolves outside `root` also makes `t` risky, when the caller passes `root`.
 * `root` itself counts as outside, so `rm <root>` is risky too.
 * When the caller omits `root`, an absolute path or a path with a `..` segment is risky instead.
 */
function riskyTarget(t: string, root?: string): boolean {
  if (/[$*?[]/.test(t) || t.startsWith('~')) return true
  if (root === undefined) return t.startsWith('/') || t.split('/').includes('..')
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  const resolved = resolvePath(base, t)
  return !resolved.startsWith(base + '/')
}

/** `words` with any leading VAR=val, wrapper (sudo, env, time...), `timeout <n>` or `xargs [flags]` stripped */
function realCommand(words: string[]): string[] {
  let w = words
  for (;;) {
    if (!w.length) return w
    const head = w[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w = w.slice(1)
      continue
    }
    const b = baseWord(head)
    if (WRAPPERS.has(b)) {
      w = w.slice(1)
      continue
    }
    if (b === 'timeout') {
      w = w.slice(1)
      if (/^[\d.]+[smhd]?$/.test(w[0] ?? '')) w = w.slice(1)
      continue
    }
    if (b === 'xargs') {
      w = w.slice(1)
      while (w.length && w[0]!.startsWith('-')) w = w.slice(1)
      continue
    }
    return w
  }
}

// claude-factory-8pc.24: bd fills a bead's created_by field from the BEADS_ACTOR variable.
// See src/cli.ts lines 1089 and 1198.
// The flood guard's sweepFiler (src/sweeps.ts) trusts created_by to find a sweep-filed bead.
// A worker can set, clear or re-export BEADS_ACTOR itself.
// That files a bead the guard never sees, with no cap and no sweep-queue allowlist.
//
// This check is defense in depth, not a full fix.
// A worker can still write around a denied command in other ways.
// The real boundary stays server-side: the flood guard must never trust a label or field the
// filer itself controls.
// claude-factory-8pc.18 fixed the same gap for the sweep:<station> label.
export const BEADS_ACTOR_REASON =
  'The factory denies this command: do not set, clear, export, or re-export BEADS_ACTOR. ' +
  "bd fills a bead's created_by from this variable, and the flood guard trusts created_by to find a " +
  'sweep-filed bead. Do not retry this command.'

const ENV_IGNORE_ENVIRONMENT_LONG = 'ignore-environment'

// claude-factory-igj: returns true when a bare value word (not a dash word) names BEADS_ACTOR.
// A match is any text that contains the name, which also matches the exact name.
// This match is defensive and fails closed. See BEADS_ACTOR_REASON above.
function valueNamesBeadsActor(v: string | undefined): boolean {
  return v !== undefined && v.includes('BEADS_ACTOR')
}

// claude-factory-igj: finds the sh/bash/zsh/dash `-c` script word after words[start], the same
// way anyShellReason finds it: the first flag cluster that holds c, then the first word after it
// that is not itself a flag, or the word right after a literal --.
function shCScriptValue(words: string[], start: number): string | undefined {
  let nc = start
  while (nc < words.length && words[nc] !== '--' && !isShCCluster(words[nc]!)) nc++
  if (nc >= words.length || words[nc] === '--') return undefined
  for (let k = nc + 1; k < words.length; k++) {
    const w = words[k]!
    if (w === '--') return words[k + 1]
    if (w.startsWith('-')) continue
    return w
  }
  return undefined
}

// claude-factory-igj: this checks words from index start to the end of the one segment words.
// It returns true for a bd word there, or for a sh/bash/zsh/dash -c script or an eval word that
// holds a bd word. depth bounds the recursion. MAX_SHELL_DEPTH bounds it the same way, for
// anyShellReason's own eval/sh -c recursion.
//
// claude-factory-igj.8: the scan reads every word after start, not only words[start]. A wrapper
// word (env, nice, nohup, sudo, and so on) can sit between start and the sh/bash/zsh/dash or
// eval word. This scan still finds that later word.
function segmentRunsBdCommand(words: string[], start: number, depth: number): boolean {
  for (let k = start; k < words.length; k++) {
    const bw = baseWord(words[k]!)
    if (bw === 'bd') return true
    if (bw === 'sh' || bw === 'bash' || bw === 'zsh' || bw === 'dash') {
      const script = shCScriptValue(words, k)
      if (script !== undefined && stringNamesBdCommand(script, depth + 1)) return true
    } else if (bw === 'eval') {
      const rest = words.slice(k + 1).join(' ')
      if (rest && stringNamesBdCommand(rest, depth + 1)) return true
    }
  }
  return false
}

// claude-factory-igj: true when a bd word sits anywhere inside s, read as shell words, or
// inside a sh/bash/zsh/dash -c script or an eval word nested in s. depth bounds the recursion
// the same way MAX_SHELL_DEPTH bounds anyShellReason's eval/sh -c recursion.
function stringNamesBdCommand(s: string, depth = 0): boolean {
  if (depth > MAX_SHELL_DEPTH) return true
  for (const seg of segments(s)) {
    if (segmentRunsBdCommand(seg, 0, depth)) return true
  }
  return false
}

/**
 * Scans the options and `NAME=value` assignments of an `env` word.
 * The scan starts right after `words[envIndex]`.
 *
 * It returns `true` when it finds a word that names `BEADS_ACTOR`. Such a word is one of these:
 * - The bare name.
 * - A dash word that holds the name (`-uBEADS_ACTOR`, `--unset=BEADS_ACTOR`).
 * - The separate value word of a value flag (`-u BEADS_ACTOR`, `--unset BEADS_ACTOR`).
 *
 * It also returns `true` when an `env -S` value sets, clears or (re-)exports `BEADS_ACTOR`.
 * The scan reads that value with its own recursive scan.
 *
 * Otherwise, it returns `cmdStart`. This is the index of the real command word of `env`.
 * The value is `words.length` when every later word is an option or an assignment.
 *
 * It also returns `clearsAll`. This is `true` when a `-i` cluster, a lone `-`, or an
 * `--ignore-environment` prefix clears the whole environment.
 * The command at `cmdStart` runs under that cleared environment.
 *
 * claude-factory-igj: the old scan stopped at the first word that was not a recognized env option.
 * A value flag's own value word (`-C /tmp`, `-u bd`) ended the scan.
 * So a later `-u BEADS_ACTOR` or `-i` never ran.
 *
 * This scan walks a value flag past its own value word.
 * It parses argv the same way real `env` does.
 * The scan stops only at the real command word.
 * That word is the first word that is neither an option nor a `NAME=value` assignment.
 * It can also be the word after a literal `--`.
 *
 * A word at or after that command word is never read as one of env's own options.
 * The caller reads it as the real command's own word instead.
 */
function envOptionScan(
  words: string[],
  envIndex: number,
  depth: number,
): { cmdStart: number; clearsAll: boolean } | true {
  const span = envSplitStringScan(words, envIndex)
  let clearsAll = false
  for (let j = envIndex + 1; j < words.length; j++) {
    const ew = words[j]!
    if (span && span.sIndex === j) {
      // claude-factory-igj item 10: a short cluster can place other letters before the S
      // flag. The old code below removed that whole word. It lost any letter before S,
      // including i. This code now reads those letters as a prefix and puts the prefix
      // back as its own word in the scan below. The recursive scan on that word then sets
      // clearsAll the ordinary way, through the one cluster-letter loop below, not through
      // a second copy of that rule here.
      const sWord = words[j]!
      const prefix =
        sWord.startsWith('-') && !sWord.startsWith('--') ? sWord.slice(1, sWord.indexOf('S')) : ''
      const recombined = [
        'env',
        ...words.slice(envIndex + 1, j),
        ...(prefix ? ['-' + prefix] : []),
        ...segments(span.value).flat(),
        ...words.slice(span.end),
      ]
      if (touchesBeadsActor(recombined, depth + 1)) return true
      j = span.end - 1 // skip the flag and its own value word; it already ran above
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ew)) continue // a NAME=value assignment: not the command
    if (ew === '--') return { cmdStart: j + 1, clearsAll }
    if (ew === '-') {
      clearsAll = true
      continue
    }
    if (ew.startsWith('--')) {
      const body = ew.slice(2)
      const eqAt = body.indexOf('=')
      const name = eqAt === -1 ? body : body.slice(0, eqAt)
      const attached = eqAt === -1 ? undefined : body.slice(eqAt + 1)
      if (name.length > 0 && ENV_IGNORE_ENVIRONMENT_LONG.startsWith(name)) {
        clearsAll = true
        continue
      }
      if (
        attached === undefined &&
        name.length > 0 &&
        ENV_LONG_VALUE_FLAGS.some(full => full.startsWith(name))
      ) {
        if (valueNamesBeadsActor(words[j + 1])) return true
        j++ // skip this flag's own separate value word
        continue
      }
      if (attached !== undefined && attached.includes('BEADS_ACTOR')) return true
      continue // an unrelated long option (--debug, --version, ...): keep scanning
    }
    if (ew.startsWith('-') && ew.length > 1) {
      const chars = ew.slice(1)
      for (let ci = 0; ci < chars.length; ci++) {
        const c = chars[ci]!
        if (c === 'i') {
          clearsAll = true
          continue
        }
        if (c === 'S' || ENV_SHORT_VALUE_FLAGS.has(c)) {
          const rest = chars.slice(ci + 1)
          const value = rest.length > 0 ? rest : words[j + 1]
          if (rest.length === 0) j++ // the value is the next whole word: skip it
          if (c !== 'S' && valueNamesBeadsActor(value)) return true
          break // the cluster's value, attached or skipped, ends the cluster
        }
      }
      continue
    }
    return { cmdStart: j, clearsAll } // the real command: not an option, not an assignment
  }
  return { cmdStart: words.length, clearsAll }
}

/**
 * This function returns true when a word in `words` sets, clears, or (re-)exports BEADS_ACTOR.
 *
 * claude-factory-igj: when a word is `env`, `envOptionScan` finds the clear-all flags of `env`.
 * It also finds any word that names `BEADS_ACTOR`.
 * It reports where the real command of `env` starts.
 *
 * The command can be a `bd` word.
 * It can run under a cleared environment (`clearsAll`).
 * In this case, the check `b === 'bd'` below sets `runsBd`.
 * This check runs for every word in `words`, at any position.
 *
 * `stringNamesBdCommand` checks the command in two cases:
 * - The command is a `sh`, `bash`, `zsh` or `dash` word with a `-c` script.
 * - The command is an `eval` word.
 *
 * In each case, `stringNamesBdCommand` checks the text that the command runs.
 * `stringNamesBdCommand` looks for a `bd` word in that text.
 * A plain, whole-word scan of `words` would not find that word.
 * For example, in `env -i sh -c 'bd create x'`, the word `bd` is inside the script text.
 */
function touchesBeadsActor(words: string[], depth = 0): boolean {
  if (depth > MAX_SHELL_DEPTH) return true
  let envClearsAll = false
  let runsBd = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (/^BEADS_ACTOR=/.test(w)) return true
    const b = baseWord(w)
    if (b === 'bd') runsBd = true
    // claude-factory-8pc.27: an option word (-n, -x, and so on) can come between the verb and
    // the name, as in `export -n BEADS_ACTOR`. Step past each option word first.
    if (b === 'export' || b === 'declare' || b === 'typeset' || b === 'readonly') {
      let j = i + 1
      while (words[j]?.startsWith('-') && words[j] !== '--') j++
      if (words[j] !== undefined && /^BEADS_ACTOR(=|$)/.test(words[j]!)) return true
    }
    if (b === 'unset' && words.slice(i + 1).includes('BEADS_ACTOR')) return true
    // claude-factory-8pc.27: `env -u BEADS_ACTOR` clears the name for the command that env
    // runs. `env -i` clears every name.
    if (b === 'env') {
      const scan = envOptionScan(words, i, depth)
      if (scan === true) return true
      if (scan.clearsAll) {
        envClearsAll = true
        const { cmdStart } = scan
        // claude-factory-igj.8: scan every word from cmdStart to the end of this segment, not
        // only words[cmdStart]. A wrapper word (env, nice, nohup, sudo, and so on) can sit
        // between env's own options and the real sh/bash/zsh/dash or eval word.
        if (cmdStart < words.length && segmentRunsBdCommand(words, cmdStart, depth + 1)) {
          runsBd = true
        }
      }
    }
  }
  return envClearsAll && runsBd
}

/**
 * True when `words` has an `xargs` word, with a `git` or `gh` word after it in the same segment.
 *
 * claude-factory-zl5.33: xargs can read its own operand from stdin. It appends that operand after
 * every word on this command line. That operand can be a push refspec or a gh verb. This guard
 * reads only the command text. It cannot read an operand xargs adds at run time. So it denies the
 * whole command: it does not trust text that can be incomplete.
 *
 * claude-factory-zl5.39: an earlier version of this guard skipped only a fixed list of prefixes,
 * then xargs's own flags, then read one word after that. Real git moved `main` through 3 forms
 * this missed: a value flag with its value as a separate word (`xargs -n 1 git push origin`), a
 * wrapper between xargs and git (`xargs env git push origin`, `xargs sudo ...`), and a long flag
 * with no value (`xargs -L 1 git push origin`). This guard no longer parses xargs's own flags. It
 * denies on a `git` or `gh` word anywhere after `xargs` in the same segment, flag, wrapper or
 * value word included.
 */
function xargsHidesOperand(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (baseWord(words[i]!) !== 'xargs') continue
    for (let j = i + 1; j < words.length; j++) {
      const b = baseWord(words[j]!)
      if (b === 'git' || b === 'gh') return true
    }
  }
  return false
}

// claude-factory-zl5.41: these environment variables replace git's own config lookup.
// Real git reads `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` as a config
// list of any length. `GIT_CONFIG_PARAMETERS` holds the same list in git's own internal format.
// `GIT_CONFIG`, `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` each name a config file this guard
// cannot read. Each name can set a key that `isPushConfigWrite` denies, for example
// `push.default=matching`. The command line shows no such value for this guard to check.
//
// claude-factory-zl5.45: `HOME` and `XDG_CONFIG_HOME` name the same kind of unreadable file.
// Git reads `$HOME/.gitconfig` as its own global config, with no `GIT_CONFIG_*` name in sight.
// Git reads `$XDG_CONFIG_HOME/git/config` the same way. `GIT_DIR` and `GIT_COMMON_DIR` point git
// at a different repository. That repository's config file counts too.
const DANGEROUS_GIT_CONFIG_ENV =
  /^(GIT_CONFIG(_GLOBAL|_SYSTEM|_COUNT|_PARAMETERS|_KEY_\d+|_VALUE_\d+)?|HOME|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR)$/

/**
 * True when `words` has a plain `NAME=value` word, or an `export NAME=value` word, that sets one
 * of the `DANGEROUS_GIT_CONFIG_ENV` names, anywhere in the segment.
 *
 * claude-factory-zl5.41: a plain assignment right before a git word sets that one git call's own
 * environment. An `export` sets a shell variable that stays set for every later command in the
 * same shell, including a git call on a later, `;`-separated line. This check reads either form
 * the same way: it does not track which statement runs `export`, so a export in one segment and a
 * git call in another still deny, through `hasDangerousConfigEnv` in `denyAt`.
 */
function setsDangerousGitConfigEnv(words: string[]): boolean {
  for (const w of words) {
    const eq = w.indexOf('=')
    if (eq <= 0) continue
    if (DANGEROUS_GIT_CONFIG_ENV.test(w.slice(0, eq))) return true
  }
  return false
}

/**
 * True when any word in the raw `command` text has baseWord `git` or `git-<verb>`
 * (claude-factory-zl5.44).
 *
 * This reads the unparsed text, not one segment's `words` array. A quoted argument to `eval` or
 * `bash -c` stays one `segments()` word with its own spaces inside (for example `'git push
 * origin'`), so a `baseWord` check on that one word never matches `git`. A wrapper flag
 * `realCommand` does not know by name (`nice -n 5`, `command -p`, `stdbuf -o0`) can also push a
 * `git` word past a cheap `cmd[0]` check. This scan instead splits the whole raw text on
 * whitespace and quote characters, so it reads a `git` word at any depth: inside a quoted
 * recursion argument, behind an unknown wrapper, or set by a separate `export` statement earlier
 * in the same command.
 *
 * `denyAt` calls this only when `hasDangerousConfigEnv` is already true, so a stray `git`-shaped
 * word in an unrelated value only matters alongside one of the `DANGEROUS_GIT_CONFIG_ENV` names.
 */
function commandHasGitWord(command: string): boolean {
  for (const w of command.split(/['"`\s;&|()<>]+/)) {
    if (!w) continue
    const b = baseWord(w)
    if (b === 'git' || /^git-/.test(b)) return true
  }
  return false
}

// claude-factory-25z: global flags that take a separate value word, so the verb search can step past
// them even when they come before the verb (`kubectl -n ax --context acme rollout restart ...`)
const KUBECTL_VALUE_FLAGS = new Set([
  '--context',
  '-n',
  '--namespace',
  '--kubeconfig',
  '--cluster',
  '--user',
  '--username',
  '--password',
  '--token',
  '--server',
  '-s',
  '-v',
  '--v',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--tls-server-name',
  '--cache-dir',
  '-o',
  '--output',
  '--request-timeout',
  '--as',
  '--as-group',
])
const KO_VALUE_FLAGS = new Set(['--context'])
const HELM_VALUE_FLAGS = new Set([
  '--kube-context',
  '-n',
  '--namespace',
  '--kubeconfig',
  '--kube-apiserver',
  '--kube-token',
  '--kube-as-user',
  '--kube-as-group',
  '--kube-ca-file',
  '--kube-tls-server-name',
  '--registry-config',
  '--repository-cache',
  '--repository-config',
  '--burst-limit',
  '--qps',
])

const KUBECTL_MUTATING_VERBS = new Set([
  'apply',
  'create',
  'replace',
  'patch',
  'delete',
  'edit',
  'scale',
  'autoscale',
  'set',
  'label',
  'annotate',
  'taint',
  'drain',
  'cordon',
  'uncordon',
  'expose',
  'run',
  'cp',
  'debug',
  // claude-factory-25z.16: `exec` runs an arbitrary command inside a live pod; `cp` is itself
  // built on `exec`, so denying `cp` but allowing `exec` or `attach` is inconsistent. Neither has
  // a --dry-run flag.
  'exec',
  'attach',
])
const KUBECTL_ROLLOUT_MUTATING = new Set(['restart', 'undo', 'pause', 'resume'])
// claude-factory-25z.11: `auth can-i` only reads; `auth reconcile` writes RBAC objects.
const KUBECTL_AUTH_MUTATING = new Set(['reconcile'])
const KUBECTL_CERTIFICATE_MUTATING = new Set(['approve', 'deny'])
const KO_MUTATING_VERBS = new Set(['apply', 'create', 'delete', 'run'])
// claude-factory-25z.13: `del` and `un` are helm's own aliases for `uninstall`.
const HELM_MUTATING_VERBS = new Set(['install', 'upgrade', 'uninstall', 'delete', 'del', 'un', 'rollback'])

/**
 * Finds each value of a flag in `names`, in word order. A flag can use the `--flag value` form
 * or the `--flag=value` form.
 *
 * This function stops at a literal `--`. A word after `--` is an operand, not a flag.
 *
 * claude-factory-bemr.8: `flagValue` below keeps only the last value. Call this function for a
 * flag that git applies anew each time it appears, such as `-C`.
 */
function flagValuesInOrder(words: string[], names: Set<string>): string[] {
  const result: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') break
    if (names.has(w)) {
      result.push(words[i + 1]!)
      continue
    }
    let matched = false
    for (const n of names) {
      if (w.startsWith(`${n}=`)) {
        result.push(w.slice(n.length + 1))
        matched = true
        break
      }
    }
    if (matched) continue
    // claude-factory-zl5.7: a 2-character short flag (`-X`) can take its value with no separator.
    // For example, `-XPUT` sets the value to PUT. curl does the same. A long flag (`--method`) never takes this form.
    for (const n of names) {
      if (n.length === 2 && n[1] !== '-' && w.startsWith(n) && w.length > n.length) {
        result.push(w.slice(n.length))
        break
      }
    }
  }
  return result
}

/**
 * Finds the value of the LAST flag in `names` in `words`. See `flagValuesInOrder` for the word
 * forms this reads.
 * claude-factory-25z.8: kubectl, ko and helm all use the last copy of a repeated flag, not the
 * first.
 */
function flagValue(words: string[], names: Set<string>): string | undefined {
  const values = flagValuesInOrder(words, names)
  return values.length > 0 ? values[values.length - 1] : undefined
}

// the charset `factory rig add --person-only-context` accepts (src/cli.ts:3663): a literal name
// holds only these characters.
const CONTEXT_NAME = /^[A-Za-z0-9._@:/-]+$/

/**
 * Checks if a flag value is a literal name. Returns true when the value holds a character
 * outside CONTEXT_NAME: the value is then not a literal name.
 * claude-factory-25z.9: a `$` marks a shell expansion. A backtick marks command substitution.
 * claude-factory-25z.15: a brace (`{a,b}`), a glob (`*`, `?`, `[`) or a leading `~` also expands,
 * before kubectl, ko or helm reads the value. This hook matches context and cluster names only.
 * It cannot resolve any of these forms, so it treats the value as unknown and fails closed.
 */
function unknownFlagValue(v: string): boolean {
  return !CONTEXT_NAME.test(v)
}

/**
 * Get the index of the first non-flag word in `words`.
 * Step past a known global flag. If the flag is in `valueFlags` and has no `=`, step past its
 * value word too. Return `uncertain: true` when a flag has no `=` and is not in `valueFlags`
 * (claude-factory-25z.6): this function then does not know if the flag takes a value word.
 *
 * claude-factory-bemr.5: `noValueFlags` names flags that never take a value word.
 * The search steps past one of these flags with no doubt.
 * It does not set `uncertain` for it.
 * A caller that does not pass `noValueFlags` keeps the old behavior with no change.
 */
function firstVerbIndex(
  words: string[],
  valueFlags: Set<string>,
  noValueFlags?: Set<string>,
): { index: number; uncertain: boolean } {
  let uncertain = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w.startsWith('-') && w !== '-') {
      if (w.includes('=')) continue
      if (valueFlags.has(w)) {
        i++
        continue
      }
      if (noValueFlags?.has(w)) continue
      uncertain = true
      continue
    }
    return { index: i, uncertain }
  }
  return { index: -1, uncertain }
}

/**
 * true when `w` is a short-flag cluster that holds `c` (for example `-c`, `-lc`, `-ec`).
 * This finds the `-c "script"` argument of a `sh`, `bash`, `zsh` or `dash` call.
 *
 * claude-factory-25z.10: `bash -lc "..."` and `sh -ec "..."` bundle other short flags with `c`.
 * A plain `cmd.indexOf('-c')` misses them. That also hides an `rm -rf` or a live-apply command
 * that sits inside the quoted script, from both guards.
 *
 * This is false for a long flag (`--context`) and for a literal `--`, since both start with `--`.
 */
function isShCCluster(w: string): boolean {
  return !w.startsWith('--') && w.startsWith('-') && w.length > 1 && /c/.test(w.slice(1))
}

/** true when some word in `words`, before a literal `--` separator (if any), is in `verbs`. */
function hasMutatingWordBeforeDashDash(words: string[], verbs: Set<string>): boolean {
  for (const w of words) {
    if (w === '--') return false
    if (verbs.has(w)) return true
  }
  return false
}

/**
 * True when `ctx` names a context this hook must deny: it is missing, it is an unresolved shell
 * expansion (claude-factory-25z.9), or it is in `personOnly`.
 * A missing `ctx` fails closed: this function does not then know the current context.
 */
function contextDenied(ctx: string | undefined, personOnly: string[]): boolean {
  return ctx === undefined || unknownFlagValue(ctx) || personOnly.includes(ctx)
}

/**
 * Check if `cmd` (a kubectl, ko or helm command) changes state at a context in `personOnly`.
 * Return true for that case, and for a command with no named context (fail closed: this function
 * does not know the current context).
 * Also return true when an unknown flag makes the verb search uncertain, and a later word before
 * `--` names a mutating verb (claude-factory-25z.6). This hook does not know every global flag that
 * takes a value word. An unknown flag must not hide a mutating verb that follows it.
 */
function liveApplyDenied(cmd: string[], personOnly: string[]): boolean {
  const b = baseWord(cmd[0]!)
  const tail = cmd.slice(1)
  if (b === 'kubectl') {
    const { index: vi, uncertain } = firstVerbIndex(tail, KUBECTL_VALUE_FLAGS)
    const verb = vi >= 0 ? tail[vi]! : undefined
    const sub = vi >= 0 ? tail[vi + 1] : undefined
    let mutating =
      verb === undefined
        ? false
        : verb === 'rollout'
          ? !!sub && KUBECTL_ROLLOUT_MUTATING.has(sub)
          : verb === 'auth'
            ? !!sub && KUBECTL_AUTH_MUTATING.has(sub)
            : verb === 'certificate'
              ? !!sub && KUBECTL_CERTIFICATE_MUTATING.has(sub)
              : KUBECTL_MUTATING_VERBS.has(verb)
    if (!mutating && uncertain) {
      mutating =
        hasMutatingWordBeforeDashDash(tail, KUBECTL_MUTATING_VERBS) ||
        hasMutatingWordBeforeDashDash(tail, KUBECTL_ROLLOUT_MUTATING) ||
        hasMutatingWordBeforeDashDash(tail, KUBECTL_AUTH_MUTATING) ||
        hasMutatingWordBeforeDashDash(tail, KUBECTL_CERTIFICATE_MUTATING)
    }
    if (!mutating) return false
    // claude-factory-25z.7: --dry-run=client|server exempts every mutating kubectl verb, not only
    // apply. A bare --dry-run or --dry-run=none still mutates and stays denied.
    const dryRun = flagValue(cmd, new Set(['--dry-run']))
    if (dryRun === 'client' || dryRun === 'server') return false
    const ctx = flagValue(cmd, new Set(['--context']))
    if (contextDenied(ctx, personOnly)) return true
    // claude-factory-25z.9: --cluster overrides which cluster a named context talks to.
    const cluster = flagValue(cmd, new Set(['--cluster']))
    return cluster !== undefined && (unknownFlagValue(cluster) || personOnly.includes(cluster))
  }
  if (b === 'ko') {
    const { index: vi, uncertain } = firstVerbIndex(tail, KO_VALUE_FLAGS)
    let mutating = vi >= 0 && KO_MUTATING_VERBS.has(tail[vi]!)
    if (!mutating && uncertain) mutating = hasMutatingWordBeforeDashDash(tail, KO_MUTATING_VERBS)
    if (!mutating) return false
    const ctx = flagValue(cmd, new Set(['--context']))
    return contextDenied(ctx, personOnly)
  }
  if (b === 'helm') {
    const { index: vi, uncertain } = firstVerbIndex(tail, HELM_VALUE_FLAGS)
    let mutating = vi >= 0 && HELM_MUTATING_VERBS.has(tail[vi]!)
    if (!mutating && uncertain) mutating = hasMutatingWordBeforeDashDash(tail, HELM_MUTATING_VERBS)
    if (!mutating) return false
    const ctx = flagValue(cmd, new Set(['--kube-context']))
    return contextDenied(ctx, personOnly)
  }
  return false
}

// claude-factory-zl5: gh's own global flags that take a value word. The verb search steps past
// them. This matters when they come before the verb (`gh -R o/r pr merge 5`).
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname'])
// `gh api` flags that take a value word. The endpoint search steps past them.
// claude-factory-zl5.15: `-p` and `--preview` also take a value word. That value is a
// comma-separated preview name list. Without this, the endpoint search read the value word as the
// endpoint. The real endpoint and the method after it were not checked.
const GH_API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '--input',
  '--hostname',
  '--cache',
  '-t',
  '--template',
  '-q',
  '--jq',
  '-p',
  '--preview',
])

// claude-factory-zl5.16: a boolean `gh api` short flag with no value of its own. Only `-i`
// (`--include`) is known here.
const GH_API_BOOL_SHORT = new Set(['i'])
// claude-factory-zl5.16: a `gh api` short flag that takes a value, by its single character.
// pflag lets a caller cluster these with a leading run of GH_API_BOOL_SHORT chars, the attached
// value (if any) coming right after. For example `-iXPUT` is `-i` plus `-XPUT`.
const GH_API_VALUE_SHORT = new Set(['X', 'f', 'F', 't', 'q', 'p', 'H'])

/**
 * Splits a clustered `gh api` short flag word, for example `-iXPUT` or `-if`, into separate words
 * that `flagValue` and `ghApiFields` already read.
 * claude-factory-zl5.16: pflag lets a caller write boolean short flags, then at most one
 * value-taking short flag, as one word.
 *
 * For `-iXPUT`, the result is `-i` and `-XPUT`, with the value `PUT` attached.
 * For `-if`, the result is `-i` and a bare `-f`.
 * The value of `-f` is the next word, unchanged.
 *
 * A word with an unknown short flag character returns as is.
 * This function splits only a cluster that it reads in full.
 */
function expandGhShortClusters(words: string[]): string[] {
  const out: string[] = []
  for (const w of words) {
    if (!w.startsWith('-') || w.startsWith('--') || w.length < 2) {
      out.push(w)
      continue
    }
    const chars = w.slice(1)
    const expanded: string[] = []
    let i = 0
    let ok = true
    while (i < chars.length) {
      const c = chars[i]!
      if (GH_API_BOOL_SHORT.has(c)) {
        expanded.push(`-${c}`)
        i++
        continue
      }
      if (GH_API_VALUE_SHORT.has(c)) {
        expanded.push(`-${chars.slice(i)}`)
        i = chars.length
        continue
      }
      ok = false
      break
    }
    if (!ok || !expanded.length) {
      out.push(w)
      continue
    }
    out.push(...expanded)
  }
  return out
}
// a GraphQL mutation name that merges a pull request or a branch
const MERGE_MUTATIONS = ['enablePullRequestAutoMerge', 'mergePullRequest', 'mergeBranch']
// a GraphQL mutation name that marks a pull request ready for review (claude-factory-zl5.2)
const READY_MUTATIONS = ['markPullRequestReadyForReview']
// claude-factory-zl5.10: a GraphQL mutation name that writes a ref (a branch), or a commit on one.
// This guard denies any call that names one of these mutations.
// It does not read the mutation input for a branch name. The REST checks below do read one.
// Few tools outside release tooling use these names. A simple, strict rule is safe here.
const PUSH_MUTATIONS = ['createCommitOnBranch', 'updateRef', 'updateRefs', 'deleteRef']

/**
 * Collects every `-f`/`--raw-field`/`-F`/`--field` name=value pair in `words`, a `gh api` call's
 * own arguments. It stops at a literal `--`.
 * `gh api` repeats these flags, one per field. This reads every one, not only the last.
 * `flagValue` differs: it reads a flag that `gh`, `kubectl`, `ko` or `helm` itself takes once.
 *
 * claude-factory-zl5.6: `gh` reads a name=value pair in 3 forms.
 * Form 1: `-f name=value` is 2 words.
 * Form 2: `--raw-field=name=value` is 1 word. The long flag and the pair join with `=`.
 * Form 3: `-fname=value` is 1 word. The short flag and the pair join with no separator.
 * `--field` and `-F` take the same 3 forms.
 */
function ghApiFields(words: string[]): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = []
  const addPair = (v: string | undefined) => {
    const eq = v?.indexOf('=') ?? -1
    if (v !== undefined && eq >= 0) fields.push({ name: v.slice(0, eq), value: v.slice(eq + 1) })
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') break
    if (w === '-f' || w === '-F' || w === '--raw-field' || w === '--field') {
      addPair(words[i + 1])
      i++
      continue
    }
    if (w.startsWith('--raw-field=')) {
      addPair(w.slice('--raw-field='.length))
      continue
    }
    if (w.startsWith('--field=')) {
      addPair(w.slice('--field='.length))
      continue
    }
    // claude-factory-zl5.16: a 4th form, `-f=name=value` or `-F=name=value`: the short flag and
    // the pair join with `=`, one char later than form 3 (`-fname=value`). Check this form first,
    // since form 3's `w.length > 2` check below would otherwise also match it and misread the
    // leading `=` as part of the field name.
    if (w.startsWith('-f=') || w.startsWith('-F=')) {
      addPair(w.slice(3))
      continue
    }
    if ((w.startsWith('-f') || w.startsWith('-F')) && w.length > 2) {
      addPair(w.slice(2))
    }
  }
  return fields
}

// claude-factory-zl5.18: a `$` or a backtick marks a shell expansion that this hook cannot read.
// That expansion can sit in a field value, a REST path segment, or a `-c name=value` pair.
// The hook reads the command's own text, not what the shell later puts there.
//
// `$Q` or `` `cmd` `` stays as literal text here, so a check that reads it as the final value
// misses the real one.
//
// This follows the rule of `REFSPEC_UNSAFE` for a `git push` refspec, narrowed to the two
// characters a field value can carry.
const SHELL_UNSAFE = /[$`]/

/**
 * Reads the text of every `query` or `input` field of a `gh api graphql` call.
 * It also reads the call's `--input` file, when set.
 *
 * A field value that starts with `@` names a file.
 * `gate.readFile` reads that file, relative to the tool call's own cwd.
 *
 * `unresolved` is true when this cannot read a file's text.
 * It is also true for a shell expansion in a field value that this hook cannot read
 * (claude-factory-zl5.18, `SHELL_UNSAFE`).
 * The caller then fails closed, because the real query text is unknown here.
 */
function graphqlTexts(apiArgs: string[], gate: HookGate): { texts: string[]; unresolved: boolean } {
  const texts: string[] = []
  let unresolved = false
  const take = (v: string) => {
    if (SHELL_UNSAFE.test(v)) {
      unresolved = true
      return
    }
    if (!v.startsWith('@')) {
      texts.push(v)
      return
    }
    const content = gate.readFile?.(v.slice(1))
    if (content === undefined) unresolved = true
    else texts.push(content)
  }
  // claude-factory-zl5.24: The `--input` flag sends the whole JSON request body to `gh api`
  // for the GraphQL call. The body is not raw query text.
  //
  // GitHub decodes a backslash-u escape in the `query` string. The decoded name can be
  // `mergePullRequest`.
  //
  // A scan of the raw file bytes as plain text does not find this escape. In the raw bytes,
  // the escape stays as literal characters.
  //
  // This function reads the body as JSON first. It reads only the `query` string in the
  // body. GitHub uses that string for the call.
  //
  // If the body is not correct JSON, this function cannot read the query. The function
  // then fails closed and sets `unresolved`.
  const takeInputBody = (v: string) => {
    if (SHELL_UNSAFE.test(v)) {
      unresolved = true
      return
    }
    const content = v.startsWith('@') ? gate.readFile?.(v.slice(1)) : undefined
    if (content === undefined) {
      unresolved = true
      return
    }
    try {
      const body: unknown = JSON.parse(content)
      if (body && typeof body === 'object' && typeof (body as { query?: unknown }).query === 'string') {
        texts.push((body as { query: string }).query)
      }
    } catch {
      unresolved = true
    }
  }
  for (const f of ghApiFields(apiArgs)) if (f.name === 'query' || f.name === 'input') take(f.value)
  const inputFile = flagValue(apiArgs, new Set(['--input']))
  if (inputFile !== undefined) takeInputBody(`@${inputFile}`)
  return { texts, unresolved }
}

/** true when a `gh api graphql` call's query text names one of `mutations`, or its text is unknown */
function hasGraphqlMutation(apiArgs: string[], gate: HookGate, mutations: string[]): boolean {
  const { texts, unresolved } = graphqlTexts(apiArgs, gate)
  if (unresolved) return true
  return texts.some(t => mutations.some(m => new RegExp(`\\b${m}\\b`).test(t)))
}

/**
 * Strips a trailing `#fragment`, then a trailing `?query`, then a trailing `/`, from `endpoint`
 * (claude-factory-zl5.25).
 *
 * The real `gh` tool drops a `#fragment` before it sends the request. A check that reads the
 * raw endpoint text, fragment and all, can miss a path this function's callers must catch:
 * `pulls/5/merge#x`, `merges#x`, `git/refs#x`, `git/refs/heads/main#x` and `graphql#x` all reach
 * the same real endpoint as the same path with no fragment.
 *
 * Every endpoint check in this file (`isGraphqlEndpoint`, `ghApiMergeDenied`, `ghApiPushDenied`)
 * must read this one normalized form, not the raw endpoint text.
 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '')
}

/**
 * True when `endpoint` names the GraphQL endpoint, in any form that `gh api` accepts
 * (claude-factory-zl5.17).
 * The bare word `graphql` is the common form.
 * A leading slash (`/graphql`) or a full URL (`https://api.github.com/graphql`, or an enterprise
 * host's own `.../api/graphql`) names the same endpoint.
 *
 * Each form skips the merge, ready and push mutation checks, unless this function reads it.
 * A trailing slash, query string or `#fragment` does not change the endpoint
 * (claude-factory-zl5.25).
 */
function isGraphqlEndpoint(endpoint: string): boolean {
  const path = normalizeEndpoint(endpoint)
  if (path === 'graphql' || path === '/graphql') return true
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.*\/graphql$/.test(path)
}

/**
 * True when a `gh api` call merges a pull request or a branch through the REST or GraphQL API.
 * `apiArgs` is the call's own arguments, after the `api` word.
 *
 * REST: `PUT .../pulls/<n>/merge` merges a pull request. `POST .../merges` merges a branch.
 * `gh api` sends POST on its own when a caller gives `-f`, `-F` or `--input` data and names no
 * other method with `-X` or `--method`. So a merges call with no explicit method still counts.
 *
 * GraphQL: the `graphql` endpoint's query or `--input` body names `enablePullRequestAutoMerge`,
 * `mergePullRequest` or `mergeBranch`.
 *
 * claude-factory-zl5.18: the `<n>` in `/pulls/<n>/merge` can be any text without a slash.
 * A shell variable or command substitution that has not expanded yet reads as its own literal,
 * unresolved text here, for example `$N`.
 *
 * This guard does not need the real number.
 * A `PUT` to any `/pulls/<x>/merge` path still merges a pull request.
 */
function ghApiMergeDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint) return false
  if (isGraphqlEndpoint(endpoint)) return hasGraphqlMutation(apiArgs, gate, MERGE_MUTATIONS)
  // claude-factory-zl5.25: gh drops a `#fragment` before it sends the request, so this guard
  // must read the normalized path, not the raw endpoint text.
  const path = normalizeEndpoint(endpoint)
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  const hasData = ghApiFields(apiArgs).length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
  const effective = method || (hasData ? 'POST' : 'GET')
  if (effective === 'PUT' && /\/pulls\/[^/?#]+\/merge$/.test(path)) return true
  return (effective === 'POST' || effective === 'PUT') && /\/merges$/.test(path)
}

/**
 * True when a `gh api` call's `graphql` endpoint marks a pull request ready for review
 * (claude-factory-zl5.2): its query or `--input` body names `markPullRequestReadyForReview`.
 */
function ghApiReadyDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  return (
    endpoint !== undefined &&
    isGraphqlEndpoint(endpoint) &&
    hasGraphqlMutation(apiArgs, gate, READY_MUTATIONS)
  )
}

// claude-factory-zl5.10: a REST path can update or delete an existing branch ref.
// Like the merge check above, this reads the tail of the path, for example `/pulls/<n>/merge`.
// The `/repos/<owner>/<repo>/` prefix is optional. An endpoint can be a full URL or a short path.
//
// claude-factory-zl5.26: this pattern captures all characters up to a `?` or `#`. It does not stop at the first `/`.
// A branch name can contain a slash, for example `acme/deploy`. The old pattern read only `acme`.
// GitHub also accepts the singular `git/ref/heads/<branch>` path for the same read and write. So this pattern matches `refs?`.
//
// claude-factory-zl5.30: this pattern reads an already-decoded path (`decodeApiPath` below).
// So a percent-encoded slash after `heads` (`heads%2Fmain`) matches the same as a literal one (`heads/main`).
// The raw, still-encoded path has no `/` there. A match against the raw text misses this path.
const REF_HEADS_PATH = /\/git\/refs?\/heads\/([^?#]+)/
// a REST path that creates a new ref. The caller names the new ref in a `ref` field.
// claude-factory-zl5.25: `normalizeEndpoint` already strips a `?query` and `#fragment`, so this
// pattern no longer needs to match one.
const REFS_CREATE_PATH = /\/git\/refs\/?$/
// a REST path that creates or replaces a file. It commits to a branch. It does not use `git push`.
const CONTENTS_PATH = /\/contents\/.+/

/**
 * Decodes a percent-encoded REST path once, in full (claude-factory-zl5.30).
 *
 * GitHub decodes the whole path before it reads it. A percent-encoded slash (`heads%2Fmain`)
 * names the same path segment as a literal one (`heads/main`).
 * A pattern that reads the raw, encoded text can miss that match. It does not only read the wrong branch name.
 * So every REST pattern in `ghApiPushDenied` (`REF_HEADS_PATH`, `REFS_CREATE_PATH`, `CONTENTS_PATH`) must read this decoded form.
 *
 * Returns undefined when the text is not valid percent-encoding. The caller then fails closed.
 * This is the same rule that `SHELL_UNSAFE` uses for a shell expansion that this hook cannot read.
 */
function decodeApiPath(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/**
 * True when a `gh api` call writes to a protected branch through the REST or GraphQL API.
 * The command line has no `git push` word (claude-factory-zl5.10).
 *
 * REST: `PATCH` or `DELETE .../git/refs/heads/<branch>` updates or deletes that branch's ref.
 * `POST .../git/refs` creates a new ref. The `ref` field, not the URL, names the branch.
 * `PUT`, `POST` or `DELETE .../contents/<path>` commits a file to a branch.
 * The `branch` field names that branch. If there is no `branch` field, the call uses the default branch.
 *
 * GraphQL: this guard denies a `graphql` endpoint. Its query or `--input` body names a `PUSH_MUTATIONS` entry.
 * The entries are `createCommitOnBranch`, `updateRef`, `updateRefs` and `deleteRef`.
 *
 * If this guard cannot read a branch name (no `ref` or `branch` field), it denies the call.
 * claude-factory-zl5.13: it also denies when `protectedBranchSet` reports `unresolved`.
 * In that case, it cannot check the branch name against the rig's real default branch.
 *
 * claude-factory-zl5.18: it also denies when the `ref` or `branch` field is a shell expansion.
 * This hook cannot read that expansion (`SHELL_UNSAFE`).
 * A check against a literal, unresolved `$BRANCH` finds no match.
 * So the call passes, but this guard must deny it.
 *
 * claude-factory-zl5.30: it also denies when the URL path has malformed percent-encoding (`decodeApiPath` fails).
 * This hook cannot read the real path then.
 */
function ghApiPushDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint) return false
  if (isGraphqlEndpoint(endpoint)) return hasGraphqlMutation(apiArgs, gate, PUSH_MUTATIONS)
  // claude-factory-zl5.25: read the normalized path, which has no `#fragment` or `?query`, for every REST pattern below.
  // claude-factory-zl5.30: then decode the whole path once. Do this before any pattern reads it.
  // GitHub decodes a percent-encoded slash in the path. `heads%2Fmain` names the same path as `heads/main`.
  // A raw-text match against the still-encoded form misses that match.
  const normalized = normalizeEndpoint(endpoint)
  const path = decodeApiPath(normalized)
  if (path === undefined) return true
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  const fields = ghApiFields(apiArgs)
  const hasData = fields.length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
  const effective = method || (hasData ? 'POST' : 'GET')
  const { branches: protectedSet, unresolved } = protectedBranchSet(gate)
  const refMatch = REF_HEADS_PATH.exec(path)
  if (refMatch) {
    if (effective !== 'PATCH' && effective !== 'DELETE') return false
    if (unresolved) return true
    // claude-factory-zl5.30: `path`, and so `refMatch[1]`, is already decoded in full above.
    // Strip a `refs/heads/` or `heads/` prefix that the decode reveals. Do this before the check against the protected set.
    return protectedSet.has(stripRefsHeads(refMatch[1]!))
  }
  if (REFS_CREATE_PATH.test(path) && effective === 'POST') {
    const ref = fields.find(f => f.name === 'ref')?.value
    return ref === undefined || unresolved || SHELL_UNSAFE.test(ref) || protectedSet.has(stripRefsHeads(ref))
  }
  if (CONTENTS_PATH.test(path) && (effective === 'PUT' || effective === 'POST' || effective === 'DELETE')) {
    // claude-factory-zl5.26: strip a `refs/heads/` or `heads/` prefix here too, the same as the
    // `ref` field above. Without this, `branch=refs/heads/main` and `branch=heads/main` named
    // the protected branch `main`, but matched no entry in the protected set.
    const branch = fields.find(f => f.name === 'branch')?.value
    return (
      branch === undefined ||
      unresolved ||
      SHELL_UNSAFE.test(branch) ||
      protectedSet.has(stripRefsHeads(branch))
    )
  }
  return false
}

// claude-factory-bemr: the builtin top-level `gh` commands, from `gh help`'s `CORE COMMANDS`,
// `GITHUB ACTIONS COMMANDS`, and `ADDITIONAL COMMANDS` sections (gh 2.98.0), plus `help` and
// `version`.
// It does not include `gh help`'s `ALIAS COMMANDS` and `HELP TOPICS` sections, but keeps
// `accessibility`, since gh runs it as a real command too.
// A real `gh` always picks a builtin command over a same-named alias.
// `ghReason` below does the same.
export const GH_BUILTIN_VERBS = new Set([
  'auth',
  'browse',
  'codespace',
  'discussion',
  'gist',
  'issue',
  'org',
  'pr',
  'project',
  'release',
  'repo',
  'skill',
  'cache',
  'run',
  'workflow',
  'agent-task',
  'alias',
  'api',
  'attestation',
  'completion',
  'config',
  'copilot',
  'extension',
  'gpg-key',
  'label',
  'licenses',
  'preview',
  'ruleset',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'accessibility',
  'help',
  'version',
])

// claude-factory-bemr: `GH_CONFIG_DIR` sets gh's config directory directly.
// `XDG_CONFIG_HOME` and `HOME` each name a parent of the default directory gh uses when
// `GH_CONFIG_DIR` is unset.
// An assignment of any of these, before a non-builtin `gh` word, can change the alias table
// this guard reads.
// This is the same risk `cd` holds for a git repository directory.
const GH_CONFIG_ENV_NAMES = new Set(['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'])

/** True when `w` is a plain `NAME=value` word that sets one of `GH_CONFIG_ENV_NAMES`. */
function isGhConfigEnvAssign(w: string): boolean {
  const eq = w.indexOf('=')
  return eq > 0 && GH_CONFIG_ENV_NAMES.has(w.slice(0, eq))
}

/** True when any word in `words` is a `GH_CONFIG_ENV_NAMES` assignment (claude-factory-bemr). */
function hasGhConfigEnvWord(words: string[]): boolean {
  return words.some(isGhConfigEnvAssign)
}

/**
 * Splits a `gh` alias's raw expansion `text` into words, or returns undefined to fail closed.
 * claude-factory-bemr: real `gh` splits an alias's expansion on whitespace alone, with no quote
 * parsing.
 * A leading exclamation mark makes the alias a shell command that gh runs with the shell, not
 * as `gh` words.
 * A dollar sign, a quote mark, or a backslash in the text can hide a shell expansion this guard
 * cannot read.
 * This function fails closed on each of these cases, before it splits the text.
 */
function ghAliasExpansion(text: string): string[] | undefined {
  if (text.startsWith('!') || /[$'"\\]/.test(text)) return undefined
  const words = text.split(/\s+/).filter(Boolean)
  return words.length ? words : undefined
}

/**
 * The reason to deny `cmd`, a command that starts with a `gh` word, or undefined to allow it.
 * claude-factory-zl5.1: `gh pr merge` and `gh repo sync` always deny. A GraphQL or REST call that
 * merges a pull request or a branch, found through `ghApiMergeDenied`, denies the same way.
 * claude-factory-zl5.2: `gh pr ready` and a GraphQL `markPullRequestReadyForReview` call deny
 * outside the release station; `gh pr ready --undo` (back to draft) is always allowed.
 * claude-factory-25z.6: an unknown global flag before the verb makes the verb search uncertain.
 * This then falls back to a plain word scan for `merge`, `sync` or `ready` before a literal `--`,
 * the same fail-closed rule the live-apply guard uses for an unknown kubectl/ko/helm flag.
 *
 * claude-factory-c63: `gh pr checkout` changes the branch `gate.headOf` names next, the same as
 * `git checkout`. This sets `state.branchChange`, the scan state shared for the whole top-level
 * call; it does not deny on its own.
 *
 * claude-factory-bemr: `ghConfigMoved` is true once an earlier config-directory assignment
 * already hid the alias table.
 * `aliasDepth` counts the alias expansions already followed to reach `cmd`.
 * When the verb is not a builtin `gh` command, this function reads the gate's alias list for
 * that word.
 * It re-scans the word's expansion as the real command, the way real `gh` resolves an alias.
 * It denies with `ALIAS_USE_REASON` when it cannot do this safely.
 */
function ghReason(
  cmd: string[],
  gate: HookGate,
  state: ScanState,
  ghConfigMoved = false,
  aliasDepth = 0,
): string | undefined {
  const tail = cmd.slice(1)
  const { index: vi, uncertain } = firstVerbIndex(tail, GH_VALUE_FLAGS)
  const verb = vi >= 0 ? tail[vi] : undefined
  // claude-factory-bemr: resolve a pre-existing gh alias at the verb slot.
  // Skip this when the verb search itself is uncertain.
  // `firstVerbIndex` then does not know if `verb` is the real word.
  // The uncertain-fallback word scans below still cover that case, the same as before.
  if (!uncertain && verb !== undefined && !GH_BUILTIN_VERBS.has(verb)) {
    if (ghConfigMoved) return ALIAS_USE_REASON
    if (aliasDepth > MAX_ALIAS_DEPTH) return ALIAS_USE_REASON
    const table = gate.ghAliases?.()
    if (!table) return ALIAS_USE_REASON
    const text = table.get(verb)
    if (text !== undefined) {
      const expansion = ghAliasExpansion(text)
      if (!expansion) return ALIAS_USE_REASON
      const expanded = ['gh', ...tail.slice(0, vi), ...expansion, ...tail.slice(vi + 1)]
      return ghReason(expanded, gate, state, ghConfigMoved, aliasDepth + 1)
    }
    // no entry for this word: an unrecognized word, fall through to the checks below unchanged,
    // the same as before this guard existed.
  }
  const sub = vi >= 0 ? tail[vi + 1] : undefined
  if (verb === 'pr' && sub === 'checkout') state.branchChange = true
  if (verb === 'pr' && sub === 'merge') return MERGE_REASON
  if (verb === 'repo' && sub === 'sync') return MERGE_REASON
  if (verb === 'pr' && sub === 'ready') {
    if (hasMutatingWordBeforeDashDash(tail, new Set(['--undo']))) return undefined
    return gate.station === 'release' ? undefined : READY_REASON
  }
  if (verb === 'api') {
    // claude-factory-zl5.16: this splits a clustered short flag (`-iXPUT`, `-if`) into separate
    // words. Every check below already reads these words, so this runs first.
    const apiArgs = expandGhShortClusters(tail.slice(vi + 1))
    if (ghApiMergeDenied(apiArgs, gate)) return MERGE_REASON
    if (ghApiReadyDenied(apiArgs, gate)) return gate.station === 'release' ? undefined : READY_REASON
    if (ghApiPushDenied(apiArgs, gate)) return PUSH_REASON
    return undefined
  }
  if (verb === 'alias') return ghAliasDenied(tail.slice(vi + 1))
  if (uncertain) {
    if (hasMutatingWordBeforeDashDash(tail, new Set(['merge', 'sync']))) return MERGE_REASON
    if (hasMutatingWordBeforeDashDash(tail, new Set(['ready'])))
      return gate.station === 'release' ? undefined : READY_REASON
    // claude-factory-c63.10: an unknown global flag can hide the `pr` word the same way it
    // hides `verb` above, so a plain word scan for `checkout` is the only check left. No
    // probe today reaches a real `gh pr checkout` call this way: real gh exits with code 1
    // on the unknown flag first. This word scan still sets `branchChange`, fail closed.
    if (hasMutatingWordBeforeDashDash(tail, new Set(['checkout']))) state.branchChange = true
  }
  return undefined
}

/**
 * The reason to deny `subArgs`, a `gh alias` call's own arguments after the `alias` word.
 * Returns undefined to allow the call.
 *
 * `gh alias set <name> <expansion>` defines a short name for another command. A later
 * `gh <name> ...` call runs that command, with no `gh pr merge` or similar word of its own.
 * This hook checks one command line at a time. It has no memory of an alias that a prior
 * command set, so it cannot catch that later call.
 *
 * claude-factory-zl5.27: an expansion text scan cannot catch every way `set` can hide a denied
 * command. Real gh and real git confirmed 3 such gaps: a `!` shell-command expansion (gh runs it
 * with the shell, not as a `gh` subcommand, so it has no `gh pr merge` word for a text scan to
 * find); the `-` form, which reads the expansion from stdin, a stream this hook cannot read; and
 * a later call to the new short name with its own extra arguments, for example `gh p merge 5`
 * after `gh alias set p pr`, where `merge` sits on a command line this guard never sees.
 *
 * So this guard denies every `gh alias set` call outright, not only one whose own expansion
 * text already denies.
 *
 * `gh alias import <file>` reads a whole file of aliases. This hook cannot see that file.
 * The hook denies that call outright too, with the same `ALIAS_REASON`.
 */
function ghAliasDenied(subArgs: string[]): string | undefined {
  const sub = subArgs[0]
  return sub === 'set' || sub === 'import' ? ALIAS_REASON : undefined
}

/**
 * True when a word in `words` is a bare `gh` token (claude-factory-zl5).
 * From that word on, the words can start a command this guard must deny.
 * A wrapper this hook does not know by name can push a `gh` word after position 0.
 * This function scans each position, so it finds that word.
 * `anyLiveApplyWord` uses the same rule for kubectl, ko, and helm.
 *
 * claude-factory-bemr: `movedBefore` is true when an earlier segment already set
 * `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, or `HOME`.
 * This function also scans this segment on its own.
 * So it still finds an assignment that sits right before the `gh` word, with no `;` or `&&`
 * between them.
 */
function anyGhReason(
  words: string[],
  gate: HookGate,
  state: ScanState,
  movedBefore: boolean,
): string | undefined {
  let moved = movedBefore
  for (let j = 0; j < words.length; j++) {
    if (isGhConfigEnvAssign(words[j]!)) {
      moved = true
      continue
    }
    if (baseWord(words[j]!) === 'gh') {
      const r = ghReason(words.slice(j), gate, state, moved)
      if (r) return r
    }
  }
  return undefined
}

// claude-factory-zl5.3: git's own global flags that take a value word (`git -C dir push ...`).
// The verb search steps past them. GH_VALUE_FLAGS does the same for `gh`.
//
// claude-factory-bemr.9: `--attr-source` and `--config-env` also take one value word each.
// Real git reads that word as-is, even a literal `--` (`git --attr-source -- zz` runs the `zz`
// alias). The verb search must step past that value word, not mark it `uncertain`.
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--attr-source',
  '--config-env',
])

// claude-factory-bemr.5: git's own global flags that never take a value word.
// Real git's synopsis lists each one with no argument.
// The verb search steps past one of these with no doubt, the same as a known value flag.
// This guard already knows the next word is the verb, not that flag's value.
const GIT_NO_VALUE_GLOBAL_FLAGS = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
  '--no-lazy-fetch',
])
// `git push`'s own flags that take a value word. The operand search steps past them.
//
// claude-factory-ctae.9: `git push`'s usage text lists `--recurse-submodules
// (check|on-demand|no)` as a flag with a required value. Real git 2.54 confirmed this.
// `git push --recurse-submodules no <remote>` reads `no` as that value, not as the remote.
// `--no-recurse-submodules` takes no value of its own. This guard leaves it out of this set.
const GIT_PUSH_VALUE_FLAGS = new Set([
  '--repo',
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--recurse-submodules',
])

// claude-factory-ctae.2: the long-flag members of `GIT_PUSH_VALUE_FLAGS`, for abbreviation checks.
// Git parse-options accepts a unique prefix of each long flag name.
// An exact word matches `GIT_PUSH_VALUE_FLAGS` above and skips its value word.
// An abbreviation reaches the same flag. This guard cannot tell which word git reads as the value
// and which as a refspec. It denies the whole push instead of a guess (fail closed).
// claude-factory-ctae.9: `--recurse-submodules` joins this list for the same reason.
const GIT_PUSH_LONG_VALUE_FLAGS = [
  '--repo',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--recurse-submodules',
]

// A `git push` flag that pushes every branch, or deletes a remote branch with no local match.
// Each flag can reach a protected branch with no refspec that names it.
// This guard denies these flags outright.
// claude-factory-ctae.1: it also denies a unique abbreviation of one flag.
// Git parse-options accepts a unique long-flag prefix the same as the full flag name.
const PUSH_BROAD_FLAGS = ['--all', '--branches', '--mirror', '--prune']
// A refspec that has a `$variable`, a backtick, a glob (`*`, `?`, `[`, `]`) or a brace (`{`, `}`).
// This guard cannot resolve any of these before git does. It treats the refspec as unknown and
// fails closed. It denies the push.
const REFSPEC_UNSAFE = /[$`*?[\]{}]/

/**
 * Removes a leading `refs/heads/` or `heads/` from `ref`.
 * After this, `refs/heads/main`, `heads/main` and `main` compare equal.
 *
 * claude-factory-zl5.20: real `git push` resolves an unqualified `<dst>` by trying it under
 * `refs/` first.
 * So `heads/main` matches the real `refs/heads/main`, which a bare `main` also matches.
 * Real git confirmed that both forms reach `main`.
 */
function stripRefsHeads(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  if (ref.startsWith('heads/')) return ref.slice('heads/'.length)
  return ref
}

/**
 * True when `s` is a way to spell `HEAD`, the ref that names the current branch.
 * claude-factory-zl5.19: `@` is a short alias for `HEAD`.
 * On a case-insensitive filesystem, such as the macOS default, git's own loose-ref lookup also
 * resolves `head`, in any letter case, to the same `HEAD` file.
 *
 * Real git confirmed that `git push origin @` and `git push origin head` both push the current
 * branch there.
 * This guard reads `s` the same way, so it does not miss either form.
 * A push to the current branch therefore cannot pass through unchecked.
 */
function isHeadAlias(s: string): boolean {
  return s === '@' || s.toUpperCase() === 'HEAD'
}

/**
 * Returns the remote branch name that a push `refspec` updates.
 * Returns undefined when the refspec names no branch (an unresolved `HEAD`, see below).
 * `unsafe` is true when this guard cannot read the name. The guard then fails closed.
 * It uses the same rule as `unknownFlagValue` for a kube context.
 *
 * A refspec has the form `[+]<src>[:<dst>]`. This guard removes the leading `+` (force) first.
 * After a colon, `<dst>` names the remote branch.
 * claude-factory-zl5.11: an empty `<src>` (`:main`) deletes the remote branch that `<dst>` names.
 *
 * In this example, that branch is `main`.
 * An empty `<dst>` (`main:`) names no branch of its own.
 * This guard reads the text of `<src>` instead. Here that text is `main`, as for a bare `main`.
 *
 * With no colon, the whole text names the remote branch, except a bare `HEAD`.
 *
 * A bare `HEAD` makes git push the current branch to a remote branch of the same name.
 * So this guard reads `currentBranch` for that case.
 *
 * `currentBranch` can have the value `undefined`. `gate.headOf` sets it to `undefined`
 * on a timeout, or on a detached `HEAD`. claude-factory-zl5.12: in that case this guard
 * fails closed. It has no branch name to check against the protected list. It denies the push.
 */
function refspecTarget(
  spec: string,
  currentBranch: string | undefined,
): { target?: string; unsafe: boolean } {
  const s = spec.startsWith('+') ? spec.slice(1) : spec
  if (REFSPEC_UNSAFE.test(s)) return { unsafe: true }
  // claude-factory-zl5.32: Real git confirmed that a bare `:` refspec pushes every branch that has
  // the same name at both ends, with the same broad reach as `--all`.
  //
  // Earlier, this guard read `:` as an empty source and an empty destination. It then used the text
  // of the no-colon branch, which is also empty, so it named no branch at all. That let a push with
  // this refspec pass unchecked. Now this guard reads `:` as unsafe, the same fail-closed result that
  // `PUSH_BROAD_FLAGS` gives for `--all`.
  if (s === ':') return { unsafe: true }
  const ci = s.indexOf(':')
  if (ci < 0) {
    if (isHeadAlias(s)) {
      if (currentBranch === undefined) return { unsafe: true }
      return { target: currentBranch, unsafe: false }
    }
    return { target: stripRefsHeads(s), unsafe: false }
  }
  const dst = s.slice(ci + 1)
  return { target: stripRefsHeads(dst === '' ? s.slice(0, ci) : dst), unsafe: false }
}

/**
 * `tail` holds the arguments of a `git push` call after the `push` word.
 * `operands` holds every non-flag word, in order.
 * `operands[0]` is the remote, if the call names one. The other operands are refspecs.
 *
 * `broad` is true for `--all`, `--branches`, `--mirror` and `--prune`.
 * Each of these flags can push or prune every branch. No refspec names a branch.
 * claude-factory-ctae.1: `broad` is also true for a unique abbreviation of one of those flags.
 * These flags do not hide a later word as a flag's own value. A real `-n` or `--dry-run`
 * word elsewhere on the same line still means a dry run.
 *
 * `unreadableValueFlag` is `true` for 2 cases.
 * Case 1: a unique abbreviation of a value flag in `GIT_PUSH_LONG_VALUE_FLAGS` (claude-factory-ctae.2).
 * Case 2: a short-flag cluster that holds the letter `o`, but not `-o` alone.
 * Examples are `-uo` and `-fo` (claude-factory-ctae.11).
 *
 * Each of these 2 forms hides a word behind a flag's own value. That hidden word can be a
 * refspec, or another flag such as `-n`, and this guard cannot read it.
 * claude-factory-ctae.12: the caller must check `unreadableValueFlag` before it reads `dryRun`.
 * A word after one of these 2 forms that looks like `-n` or `--dry-run` is that flag's own value.
 * It is not a dry-run flag. Real git 2.54 confirmed this risk: `git push --rep -n origin main`
 * and `git push -uo -n origin` both move `main`.
 *
 * `tags` is true for `--tags`.
 *
 * `dryRun` is true for `-n` or `--dry-run`. A dry run never pushes. The caller allows it
 * with no more checks, but only after it checks `unreadableValueFlag` first.
 * claude-factory-ctae.3: a unique abbreviation of `--no-dry-run` clears `dryRun` again.
 * Real git uses whichever of the 2 flags comes last on the command line (claude-factory-ctae.10).
 * This guard's own rule only adds denies, so the guard stays fail closed.
 */
function pushOperands(tail: string[]): {
  operands: string[]
  broad: boolean
  unreadableValueFlag: boolean
  tags: boolean
  dryRun: boolean
} {
  const operands: string[] = []
  let broad = false
  let unreadableValueFlag = false
  let tags = false
  let dryRun = false
  let noDryRun = false
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === '--') continue
    if (w.startsWith('-') && w !== '-') {
      if (w.includes('=')) continue
      if (GIT_PUSH_VALUE_FLAGS.has(w)) {
        i++
        continue
      }
      // claude-factory-ctae.11: a short-flag cluster other than `-o` itself that holds the
      // letter `o` (`-uo`, `-fo`) also reads the next word as `-o`'s value. This guard cannot
      // tell that word from a refspec, so it fails closed the same way it does for an
      // abbreviated long value flag.
      if (!w.startsWith('--') && w !== '-o' && w.slice(1).includes('o')) unreadableValueFlag = true
      else if (PUSH_BROAD_FLAGS.some(f => matchesLongFlagPrefix(w, f))) broad = true
      else if (GIT_PUSH_LONG_VALUE_FLAGS.some(f => matchesLongFlagPrefix(w, f))) unreadableValueFlag = true
      else if (w === '--tags') tags = true
      else if (w === '-n' || w === '--dry-run') dryRun = true
      else if (matchesLongFlagPrefix(w, '--no-dry-run')) noDryRun = true
      continue
    }
    operands.push(w)
  }
  return { operands, broad, unreadableValueFlag, tags, dryRun: dryRun && !noDryRun }
}

/**
 * This guard denies a direct write to: `main`, `master`, `gate.protectedBranches`,
 * and the branch that `gate.originHead` names.
 *
 * claude-factory-zl5.3: a rig's real default branch can differ from both. For example, acme/deploy.
 * claude-factory-zl5.10: `gitPushDenied` and `ghApiPushDenied` use this same set.
 * An API ref write or file write reaches the same protected branches as a `git push`.
 *
 * The rig sets `gate.originHead` when it reads the real `origin/HEAD`. `unresolved` is true
 * when that read fails: a timeout, or no `origin` remote.
 *
 * claude-factory-zl5.13: on `unresolved`, a caller must deny outright. It cannot check a
 * branch name against the rig's real default branch, since it does not know that name.
 *
 * `unresolved` stays false when the rig sets no `gate.originHead` at all. The rig then never
 * reads `origin/HEAD`, but `main`, `master` and `protectedBranches` still apply.
 */
function protectedBranchSet(gate: HookGate): { branches: Set<string>; unresolved: boolean } {
  const branches = new Set(['main', 'master', ...(gate.protectedBranches ?? [])])
  let unresolved = false
  if (gate.originHead) {
    const originHead = gate.originHead()
    if (originHead) branches.add(originHead)
    else unresolved = true
  }
  return { branches, unresolved }
}

/**
 * Returns true when `tail` reaches a protected branch.
 * `tail` holds the arguments of a `git push` call.
 *
 * `currentBranch` is the branch that the push starts from. `gate.headOf` reads it when needed.
 * A bare `git push` and `git push <remote> HEAD` both push the current branch.
 * For these, this guard reads `currentBranch`.
 */
function gitPushDenied(tail: string[], currentBranch: string | undefined, gate: HookGate): boolean {
  const { operands, broad, unreadableValueFlag, tags, dryRun } = pushOperands(tail)
  // claude-factory-ctae.12: this check must come before the dryRun check. A word that looks
  // like `-n` or `--dry-run`, right after an abbreviated value flag or an `-o` short-flag
  // cluster, is really that flag's own value word. It is not a real dry-run flag.
  if (unreadableValueFlag) return true
  if (dryRun) return false
  if (broad) return true
  const refspecs = operands.slice(1)
  // claude-factory-zl5.3: --tags with no refspec pushes only tags, not the current branch.
  const specs = refspecs.length ? refspecs : tags ? [] : ['HEAD']
  if (specs.length === 0) return false
  const { branches: protectedSet, unresolved } = protectedBranchSet(gate)
  // claude-factory-zl5.13: an unresolved origin/HEAD read means this guard cannot tell the
  // rig's real default branch from any other. It denies every branch-targeting push outright.
  if (unresolved) return true
  for (const spec of specs) {
    const { target, unsafe } = refspecTarget(spec, currentBranch)
    if (unsafe) return true
    if (target !== undefined && protectedSet.has(target)) return true
  }
  return false
}

// claude-factory-zl5.21: a `remote.<name>.push` config key sets the default push refspec for that
// remote. A later bare `git push <name>` sends there, not to the current branch.
// That later command line has no refspec of its own for this guard to read.
function isRemotePushName(name: string): boolean {
  return /^remote\.[^.]+\.push$/i.test(name)
}

// claude-factory-zl5.41: a `remote.<name>.mirror` config key makes a later push to that remote
// act like `git push --mirror`. It sends and deletes refs to match the local repo. That later
// push has no refspec of its own. Real git confirmed `git config remote.origin.mirror true`,
// then `git push origin`, moves `main`.
function isRemoteMirrorName(name: string): boolean {
  return /^remote\.[^.]+\.mirror$/i.test(name)
}

// claude-factory-zl5.41: an `include.path` or `includeIf.<cond>.path` key loads another config
// file into this one. That file can set any key this guard already denies, such as
// `push.default = matching`. This guard cannot read that file. So it denies the write itself, on
// any value, the same way `isRemotePushName` does.
function isIncludeName(name: string): boolean {
  return /^include\.path$/i.test(name) || /^includeif\.[^.]+\.path$/i.test(name)
}

// claude-factory-zl5.21: an `alias.<name>` config key. The name has no dot and no `=`.
function isAliasName(name: string): boolean {
  return /^alias\.[^.=]+$/i.test(name)
}

// claude-factory-zl5.28: the `push.default` config key. Its value picks the remote branch a bare
// `git push` reaches, with no refspec of its own on that later command line.
function isPushDefaultName(name: string): boolean {
  return name.toLowerCase() === 'push.default'
}

// claude-factory-zl5.28: Real git confirmed that `upstream` and `tracking`, its older name, make a
// bare `git push` reach the upstream branch of the current branch. For example, that branch is `main`.
//
// claude-factory-zl5.31: Real git also confirmed that `matching` sends every local branch to a
// remote branch with the same name. That later command line has no refspec. A local `main` branch
// reaches the remote `main`, whatever branch is current.
//
// `current`, `simple` (the git default since 2.0) and `nothing` only reach the branch that this
// guard already checks through `currentBranch`. They stay allowed. Any other value fails closed,
// the same rule that `REFSPEC_UNSAFE` uses for a refspec that this guard cannot read in full.
const PUSH_DEFAULT_SAFE_VALUES = new Set(['current', 'simple', 'nothing'])
function isUpstreamPushDefaultValue(value: string): boolean {
  return !PUSH_DEFAULT_SAFE_VALUES.has(value.toLowerCase())
}

/**
 * True when `name` and `value` together set up a later push to a branch this guard cannot check
 * on that later command line (claude-factory-zl5.21, extended by claude-factory-zl5.28).
 *
 * An `alias.<name>` key denies on any value. Real git confirmed that a `!` shell command value,
 * for example `!git push`, runs a push the same way a plain `push` value does. A scan for only
 * the word `push` in the value missed that form, so this guard no longer reads the value at all:
 * any `alias.<name>` write denies.
 *
 * A `remote.<name>.push` key denies on any value. A `push.default` key denies only on the value
 * `upstream` or `tracking` (claude-factory-zl5.28).
 *
 * A `remote.<name>.mirror` key, `include.path` and `includeIf.<cond>.path` deny on any value, the
 * same way `remote.<name>.push` does (claude-factory-zl5.41).
 *
 * `value` is undefined for a read with no value operand. This guard allows that: it only denies
 * a write.
 */
function isPushConfigWrite(name: string, value: string | undefined): boolean {
  if (isRemotePushName(name) || isRemoteMirrorName(name) || isIncludeName(name)) return true
  if (value === undefined) return false
  if (isAliasName(name)) return true
  return isPushDefaultName(name) && isUpstreamPushDefaultValue(value)
}

/**
 * True when `tail` sets a config key `isPushConfigWrite` denies, through a `-c name=value` flag
 * (claude-factory-zl5.10, extended by claude-factory-zl5.21 and claude-factory-zl5.28).
 * For example, `git -c alias.p=push p origin main` runs a push. The command line has no `push` word.
 * `git -c remote.origin.push=HEAD:refs/heads/main push` sends a bare `push` to `main`.
 * That push has no refspec of its own.
 *
 * This guard does not read the branch that a `remote.*.push` value names, or the one a push
 * alias reaches. A worker has no normal reason to set any of these 3 keys. So this guard denies
 * the write itself.
 *
 * It uses the same fail-closed rule as `REFSPEC_UNSAFE`, for a value that this guard does not
 * read in full.
 */
// claude-factory-zl5.34: `--config-env=<name>=<envvar>` sets `<name>` from the text of the
// environment variable named `<envvar>`. It sets the same key that `-c <name>=<value>` sets from
// the command line. Real git accepts only this one attached form, with `=` right after `--config-env`.
const CONFIG_ENV_PREFIX = '--config-env='

function gitDashCPushDenied(tail: string[]): boolean {
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === '--') break
    if (w.startsWith(CONFIG_ENV_PREFIX)) {
      // claude-factory-zl5.34: This guard can read the name of `<envvar>`, but not the text of the
      // environment variable that it names.
      //
      // It cannot check that text against the `push.default` value rule in `isPushConfigWrite`.
      // So this guard denies any of these keys that this flag sets: `alias.*`, `remote.*.push`,
      // `remote.*.mirror`, `push.default`, `include.path`, `includeIf.*.path`
      // (claude-factory-zl5.41 adds the mirror and include keys). It checks no value, so it
      // fails closed.
      const rest = w.slice(CONFIG_ENV_PREFIX.length)
      const eq = rest.indexOf('=')
      if (eq < 0) continue
      const name = rest.slice(0, eq)
      if (
        isRemotePushName(name) ||
        isRemoteMirrorName(name) ||
        isAliasName(name) ||
        isPushDefaultName(name) ||
        isIncludeName(name)
      )
        return true
      continue
    }
    // real git reads `-c name=value` only as 2 separate words: no `=` form, no `--config` form.
    if (w !== '-c') continue
    const pair = tail[i + 1]
    const eq = pair?.indexOf('=') ?? -1
    if (pair === undefined || eq < 0) continue
    if (isPushConfigWrite(pair.slice(0, eq), pair.slice(eq + 1))) return true
  }
  return false
}

// claude-factory-zl5.21: `git config` flags that take a value word of their own. The operand
// search below steps past them, the same way `GIT_PUSH_VALUE_FLAGS` does for `git push`.
const GIT_CONFIG_VALUE_FLAGS = new Set(['-f', '--file', '-t', '--type', '--default'])

/**
 * True when `configArgs`, the arguments of a `git config` call after the `config` word, sets a
 * key `isPushConfigWrite` denies. This is the `git config` form of the `-c` write that
 * `gitDashCPushDenied` already denies. For example, `git config alias.p push` replaces
 * `git -c alias.p=push`.
 *
 * claude-factory-zl5.28: git 2.46 adds a `set` subcommand: `git config set <name> <value>`. Real
 * git confirmed this new form writes the same key as the old, subcommand-less
 * `git config <name> <value>`. Without a check for the leading `set` word, this guard read it as
 * the key name, and the real key name as the value, so it checked the wrong pair and let the
 * write through. This guard now skips one leading `set` word before it reads the key and value.
 */
function gitConfigSubcommandPushDenied(configArgs: string[]): boolean {
  const operands: string[] = []
  for (let i = 0; i < configArgs.length; i++) {
    const w = configArgs[i]!
    if (w === '--') {
      operands.push(...configArgs.slice(i + 1))
      break
    }
    if (w.startsWith('-') && w !== '-') {
      if (w.includes('=')) continue
      if (GIT_CONFIG_VALUE_FLAGS.has(w)) i++
      continue
    }
    operands.push(w)
  }
  const start = operands[0] === 'set' ? 1 : 0
  const name = operands[start]
  if (name === undefined) return false
  return isPushConfigWrite(name, operands[start + 1])
}

// claude-factory-zl5.35: `git send-pack` is the plumbing command that `git push` itself calls.
// It moves refs to a remote over the same transports that `push` uses, such as ssh.

// It has no `push` word of its own, and its synopsis is `git send-pack [--all] [--dry-run]
// [--mirror] [--stdin] [<host>:]<directory> [<ref>...]`. The first word that is not a flag is
// the destination, not a refspec. The other words use the same refspec syntax that
// `gitPushDenied` already reads. So this guard reuses `refspecTarget` on each one.

// claude-factory-zl5.40: an earlier version of this guard read no ref as a push of `HEAD` alone.
// Real git confirmed the real rule: with no ref and no `--all`, send-pack pushes every local
// branch to a same-named remote branch, the same broad reach as `push.default=matching`.

// This guard also ignored 2 flags. `--stdin` reads refs from its own stdin, text this guard
// cannot read. `--mirror` has the same broad reach as `--all`, and also deletes refs.

// This guard now denies outright on `--mirror`, `--stdin`, or no ref at all. It still checks a
// named ref against the protected branch set, the same as before.

// claude-factory-ctae.4: these `send-pack` flags each use the next word as a value.
// This guard skips the exact flag's value word. A short form of the flag also uses the
// next word as a value, but this guard cannot read it. So `sendPackDenied` denies the
// whole call instead of a guess.
//
// claude-factory-ctae.8: `--remote` joins this list. Real git 2.54's help text lists
// `--[no-]remote <remote>` as a flag with a value. The man page does not list this flag.
// `git send-pack --remote x ../remote.git` with no ref uses `x` as that value, not as a ref.
// Without `--remote` in this set, this guard read `x` as the remote and the URL as the one ref.
const SEND_PACK_VALUE_FLAGS = new Set(['--receive-pack', '--exec', '--push-option', '--remote'])

// claude-factory-ctae.4: git's parse-options code accepts a unique prefix of a long flag name
// here too. This guard checks `--all`, `--mirror` and `--stdin` the same way `pushOperands`
// checks them for `git push`. `--no-stdin` stays an exact match. An exact match only relaxes
// the guard.
//
// claude-factory-ctae.13: `sendPackDenied` and `pushReadsCurrentBranch` must parse a `send-pack`
// call the same way. Before this change, each function had its own parser.
// One parser can skip a flag's value word that the other parser does not skip.
// A call can then pass both checks, when the call must fail at least one check.
// Both functions now call this one parser.
function sendPackOperands(tail: string[]): {
  operands: string[]
  broad: boolean
  stdin: boolean
  dryRun: boolean
  unsafeValueFlag: boolean
} {
  const operands: string[] = []
  let broad = false
  let dryRun = false
  let noDryRun = false
  let stdin = false
  let unsafeValueFlag = false
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === '--') continue
    if (w.startsWith('-') && w !== '-') {
      if (SEND_PACK_VALUE_FLAGS.has(w)) {
        i++
        continue
      }
      if (matchesLongFlagPrefix(w, '--all') || matchesLongFlagPrefix(w, '--mirror')) broad = true
      else if (w === '--dry-run' || w === '-n') dryRun = true
      else if (matchesLongFlagPrefix(w, '--no-dry-run')) noDryRun = true
      else if (matchesLongFlagPrefix(w, '--stdin')) stdin = true
      else if (w === '--no-stdin') stdin = false
      else if ([...SEND_PACK_VALUE_FLAGS].some(f => matchesLongFlagPrefix(w, f))) unsafeValueFlag = true
      continue
    }
    operands.push(w)
  }
  return { operands, broad, stdin, dryRun: dryRun && !noDryRun, unsafeValueFlag }
}

function sendPackDenied(tail: string[], currentBranch: string | undefined, gate: HookGate): boolean {
  const { operands, broad, stdin, dryRun, unsafeValueFlag } = sendPackOperands(tail)
  // claude-factory-ctae.12: this check must come before the dryRun check, the same order
  // `gitPushDenied` uses. A word that looks like `-n` or `--dry-run`, right after an
  // abbreviated value flag, is really that flag's own value word. It is not a real dry-run flag.
  if (unsafeValueFlag) return true
  if (dryRun) return false
  if (broad || stdin) return true
  const refspecs = operands.slice(1)
  // claude-factory-zl5.40: no ref means a broad, matching-style push. This guard cannot name
  // every branch that reaches, so it denies the whole call (fail closed) instead of defaulting
  // to `HEAD`.
  if (refspecs.length === 0) return true
  const { branches: protectedSet, unresolved } = protectedBranchSet(gate)
  if (unresolved) return true
  for (const spec of refspecs) {
    const { target, unsafe } = refspecTarget(spec, currentBranch)
    if (unsafe) return true
    if (target !== undefined && protectedSet.has(target)) return true
  }
  return false
}

// claude-factory-c63: in the uncertain-verb path, an unknown global flag can push the real verb
// past `vi`. These words can each change the branch that `gate.headOf` names next. The code uses
// the same fail-closed scan that `hasMutatingWordBeforeDashDash` already uses for `push` and `send-pack` below.
//
// claude-factory-c63 added `rebase` and `stash` to this set. A rebase with an explicit `<branch>`
// word can change the branch first. The subcommand `git stash branch <name>` makes a new branch
// and checks it out.
//
// claude-factory-c63.8 added `bisect`. The command `git bisect reset <commit>` checks out
// `<commit>`. It also ends the bisect.
//
// claude-factory-c63.9 added `update-ref`. The command `git update-ref --stdin` can read a
// line from stdin that this hook cannot see: `symref-update HEAD <ref>`. So this word scan
// denies the whole call. It does not check the rest of the call.
//
// claude-factory-c63.10 added `branch`. A plain word scan cannot tell a rename flag (`-m` or
// `-M`) from a read-only `git branch` call. So the scan denies both. This path is rare, because
// it needs an unknown global flag first. Real git exits with code 129 on that flag.
const BRANCH_CHANGE_UNCERTAIN_VERBS = new Set([
  'checkout',
  'switch',
  'branch',
  'symbolic-ref',
  'rebase',
  'stash',
  'bisect',
  'update-ref',
])

/**
 * True when `word` equals `longFlag`, a long flag such as `--stdin`.
 * It is also true when `word` is an abbreviation of `longFlag` with 3 or more characters
 * (claude-factory-c63.11).
 *
 * Git's option parser accepts a short, unique abbreviation of a long flag.
 * It also accepts some abbreviations that can match another flag's name.
 * This function does not tell these two kinds apart.
 * It treats every abbreviation of `longFlag` as a match. This fails closed.
 *
 * A real abbreviation that matches two flags makes git refuse the whole call.
 * In that case, git exits with code 129.
 *
 * Real git 2.54 confirms this risk.
 * `git update-ref --stdi` (or `--st`) reads stdin, the same as `--stdin`.
 * `git rebase --roo <branch>` (or `--ro <branch>`) reads `--root` the same way.
 * Both commands exit with code 0.
 */
function matchesLongFlagPrefix(word: string, longFlag: string): boolean {
  if (word === longFlag) return true
  return word.length >= 3 && word.startsWith('--') && longFlag.startsWith(word)
}

/**
 * True when `args`, the arguments of a `git branch` call, holds a rename flag (claude-factory-c63).
 * The rename flags are `-m`, `-M`, `--move`, and an abbreviation of `--move` (claude-factory-c63.11).
 * A short-flag cluster that holds `m` or `M` is also a rename flag.
 * A rename can change the branch that `gate.headOf` names next.
 */
function branchRenameDenied(args: string[]): boolean {
  for (const w of args) {
    if (w === '--') break
    if (matchesLongFlagPrefix(w, '--move')) return true
    if (w.startsWith('-') && !w.startsWith('--') && /[mM]/.test(w.slice(1))) return true
  }
  return false
}

/**
 * True when the arguments of a `git symbolic-ref` call (`args`) write or delete a ref, not read one
 * (claude-factory-c63): a `-d`/`--delete` flag, or 2 or more non-flag words (the ref name and its
 * new target).
 */
function symbolicRefWrites(args: string[]): boolean {
  let operands = 0
  for (const w of args) {
    if (w === '--') continue
    if (w === '-d' || w === '--delete') return true
    if (w.startsWith('-')) continue
    operands++
  }
  return operands >= 2
}

/**
 * True when `args`, the arguments of a `git rebase` call, contain an explicit `<branch>`
 * (claude-factory-c63.4, claude-factory-c63.7).
 *
 * If `args` has 2 or more words that are not flags, `git rebase [<upstream> [<branch>]]`
 * checks out `<branch>` first. With `--root` (or an abbreviation of it, claude-factory-c63.11),
 * the call skips `<upstream>`. Then, if `args` has 1 word that is not a flag, that word is
 * `<branch>`. `git rebase --root <branch>` then checks out `<branch>`.
 *
 * If `args` has fewer words that are not flags, the call contains no `<branch>`.
 * `rebase` then keeps the current branch checked out. A value flag such as `--onto <newbase>`
 * can make this function wrongly deny a safe command. It never allows an unsafe command.
 */
function rebaseChangesBranch(args: string[]): boolean {
  let operands = 0
  let root = false
  for (const w of args) {
    if (w === '--') break
    if (matchesLongFlagPrefix(w, '--root')) root = true
    if (w.startsWith('-')) continue
    operands++
  }
  return operands >= (root ? 1 : 2)
}

/**
 * True when `args`, the arguments of a `git bisect` call, contain `reset` followed by an
 * explicit ref (claude-factory-c63.8). `git bisect reset <commit>` checks out `<commit>` and
 * stops the bisect.
 *
 * Plain `git bisect reset`, with no ref after `reset`, returns to the branch that the bisect
 * started from. That branch is not new. This scan has already listed it.
 */
function bisectChangesBranch(args: string[]): boolean {
  let sawReset = false
  for (const w of args) {
    if (w === '--') break
    if (w.startsWith('-')) continue
    if (!sawReset) {
      if (w !== 'reset') return false
      sawReset = true
      continue
    }
    return true
  }
  return false
}

/**
 * True when the first non-flag word of a `git stash` call's arguments (`args`) is `branch`
 * (claude-factory-c63.5). `git stash branch <name>` makes a new branch and checks it out.
 */
function stashChangesBranch(args: string[]): boolean {
  for (const w of args) {
    if (w === '--') return false
    if (w.startsWith('-')) continue
    return w === 'branch'
  }
  return false
}

/**
 * True when `args`, the arguments of a `git update-ref` call, hold `--stdin` or an abbreviation
 * of it (claude-factory-c63.9, claude-factory-c63.11).
 *
 * `git update-ref --stdin` reads its own ref commands from standard input. This hook cannot read
 * that input. One stdin command, `symref-update HEAD <ref>`, can point `HEAD` at a new branch.
 * So this function denies the whole call on the `--stdin` flag alone. It does not check the rest
 * of the call's command-line words.
 *
 * Real git 2.54 confirms this risk. When a piped `symref-update HEAD refs/heads/<branch>` line
 * reaches `git update-ref --stdin`, it moves the branch. `git symbolic-ref --short HEAD` then
 * reports the new branch.
 *
 * A plain `git update-ref HEAD <sha>`, with no `--stdin`, only updates a ref's target commit.
 * The same is true for `git update-ref refs/heads/<name> <sha>`. Neither command moves the
 * `HEAD` symref itself. So neither command changes the current branch.
 */
function updateRefChangesBranch(args: string[]): boolean {
  for (const w of args) {
    if (w === '--') break
    if (matchesLongFlagPrefix(w, '--stdin')) return true
  }
  return false
}

/**
 * Returns `true` when `verb` can change the next branch that `gate.headOf` names (claude-factory-c63).
 * `verb` is a git subcommand.
 *
 * `checkout` and `switch` can change the branch with all `args`.
 * `branch`, `symbolic-ref`, `rebase`, `stash`, `bisect` and `update-ref` can change the branch only with some `args`.
 * The functions `branchRenameDenied`, `symbolicRefWrites`, `rebaseChangesBranch`, `stashChangesBranch`, `bisectChangesBranch` and `updateRefChangesBranch` examine those `args`.
 */
function gitChangesBranch(verb: string, args: string[]): boolean {
  if (verb === 'checkout' || verb === 'switch') return true
  if (verb === 'branch') return branchRenameDenied(args)
  if (verb === 'symbolic-ref') return symbolicRefWrites(args)
  if (verb === 'rebase') return rebaseChangesBranch(args)
  if (verb === 'stash') return stashChangesBranch(args)
  if (verb === 'bisect') return bisectChangesBranch(args)
  if (verb === 'update-ref') return updateRefChangesBranch(args)
  return false
}

/**
 * True when `spec`, one refspec word, is a no-colon alias for `HEAD` (claude-factory-c63): the
 * same test that `refspecTarget` makes right before it reads `currentBranch`. This reads no
 * `currentBranch` value of its own. It only states whether a push with this refspec would.
 */
function isHeadAliasRefspec(spec: string): boolean {
  const s = spec.startsWith('+') ? spec.slice(1) : spec
  if (REFSPEC_UNSAFE.test(s)) return false
  if (s === ':') return false
  return !s.includes(':') && isHeadAlias(s)
}

/**
 * True when `tail` would read `currentBranch` to resolve a refspec (claude-factory-c63).
 * `tail` holds the arguments of a `git push` (`isSendPack` false) or `git send-pack`
 * (`isSendPack` true) call, after its own verb.
 * The call is not a dry run.
 * Some refspec is a no-colon `HEAD` alias after the code removes a leading `+`.
 * The default of `push` is `['HEAD']`, with no refspec and no `--tags`.
 *
 * A later branch change in the same command can move the branch past the name that `currentBranch` holds.
 * This function shows the risk. It does not resolve the real target.
 *
 * claude-factory-ctae.13: the `send-pack` branch now calls `sendPackOperands`, the same parser
 * `sendPackDenied` uses.
 *
 * Before this change, this branch had its own scan, apart from `sendPackOperands`.
 * That old scan did not clear `dryRun` on `--no-dry-run`.
 * It also did not skip the value word of a flag in `SEND_PACK_VALUE_FLAGS`.
 * The old scan can read a wrong `dryRun` value, or a wrong `operands` list, from the same
 * `tail` that `sendPackDenied` reads correctly.
 * This function can then return `false`, even when the call really reads `currentBranch`.
 *
 * Real git 2.54 confirmed the risk.
 * In one test, an earlier word in the same command moved `currentBranch` to `main`.
 * After that word, `git send-pack -n --no-dry-run o HEAD` really sent `HEAD`.
 * Real git resolved that `HEAD` to `main`. The command was not a dry run.
 */
function pushReadsCurrentBranch(tail: string[], isSendPack: boolean): boolean {
  if (isSendPack) {
    const { operands, dryRun } = sendPackOperands(tail)
    if (dryRun) return false
    return operands.slice(1).some(isHeadAliasRefspec)
  }
  const { operands, tags, dryRun } = pushOperands(tail)
  if (dryRun) return false
  const refspecs = operands.slice(1)
  const specs = refspecs.length ? refspecs : tags ? [] : ['HEAD']
  return specs.some(isHeadAliasRefspec)
}

// claude-factory-bemr: every builtin git verb, from `git --list-cmds=builtins` (git 2.54.0).
// git picks a builtin command over a same-named alias.
// `gitReason` below does the same.
// A name missing here only costs one extra alias-table lookup.
// A name here that real git does not treat as a builtin would let an alias of that name run
// unseen, so AC10 checks this set against a real git on every run that has one.
export const GIT_BUILTIN_VERBS = new Set([
  'add',
  'am',
  'annotate',
  'apply',
  'archive',
  'backfill',
  'bisect',
  'blame',
  'branch',
  'bugreport',
  'bundle',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-mailmap',
  'check-ref-format',
  'checkout',
  'checkout--worker',
  'checkout-index',
  'cherry',
  'cherry-pick',
  'clean',
  'clone',
  'column',
  'commit',
  'commit-graph',
  'commit-tree',
  'config',
  'count-objects',
  'credential',
  'credential-cache',
  'credential-cache--daemon',
  'credential-store',
  'describe',
  'diagnose',
  'diff',
  'diff-files',
  'diff-index',
  'diff-pairs',
  'diff-tree',
  'difftool',
  'fast-export',
  'fast-import',
  'fetch',
  'fetch-pack',
  'fmt-merge-msg',
  'for-each-ref',
  'for-each-repo',
  'format-patch',
  'fsck',
  'fsck-objects',
  'fsmonitor--daemon',
  'gc',
  'get-tar-commit-id',
  'grep',
  'hash-object',
  'help',
  'history',
  'hook',
  'index-pack',
  'init',
  'init-db',
  'interpret-trailers',
  'last-modified',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'mailinfo',
  'mailsplit',
  'maintenance',
  'merge',
  'merge-base',
  'merge-file',
  'merge-index',
  'merge-ours',
  'merge-recursive',
  'merge-recursive-ours',
  'merge-recursive-theirs',
  'merge-subtree',
  'merge-tree',
  'mktag',
  'mktree',
  'multi-pack-index',
  'mv',
  'name-rev',
  'notes',
  'pack-objects',
  'pack-redundant',
  'pack-refs',
  'patch-id',
  'pickaxe',
  'prune',
  'prune-packed',
  'pull',
  'push',
  'range-diff',
  'read-tree',
  'rebase',
  'receive-pack',
  'reflog',
  'refs',
  'remote',
  'remote-ext',
  'remote-fd',
  'repack',
  'replace',
  'replay',
  'repo',
  'rerere',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'send-pack',
  'shortlog',
  'show',
  'show-branch',
  'show-index',
  'show-ref',
  'sparse-checkout',
  'stage',
  'stash',
  'status',
  'stripspace',
  'submodule--helper',
  'switch',
  'symbolic-ref',
  'tag',
  'unpack-file',
  'unpack-objects',
  'update-index',
  'update-ref',
  'update-server-info',
  'upload-archive',
  'upload-archive--writer',
  'upload-pack',
  'var',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'whatchanged',
  'worktree',
  'write-tree',
])

/**
 * Splits a git alias's raw expansion `text` into words, or returns undefined to fail closed.
 * claude-factory-bemr: this follows real git's own `split_cmdline` from `alias.c`.
 * A single or double quote opens a quoted span, with no nesting.
 * A backslash escapes the next character, except inside a single-quoted span.
 * Real git refuses to run an alias with an unclosed quote, or a trailing backslash with
 * nothing after it (`fatal: bad alias.<name> string: unclosed quote`).
 * This function returns undefined for both, the same fail-closed answer real git gives.
 */
function splitCmdline(text: string): string[] | undefined {
  const words: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (!quote && /\s/.test(c)) {
      words.push(cur)
      cur = ''
      while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++
      continue
    }
    if (!quote && (c === '"' || c === "'")) {
      quote = c
      continue
    }
    if (c === quote) {
      quote = null
      continue
    }
    if (c === '\\' && quote !== "'") {
      i++
      const next = text[i]
      if (next === undefined) return undefined
      cur += next
      continue
    }
    cur += c
  }
  if (quote) return undefined
  words.push(cur)
  return words
}

/**
 * Folds every -C word in `tail`, in order, into one path for gate.gitAliases.
 *
 * claude-factory-bemr.8: real git applies each -C word as its own `cd`, one after the other.
 * `git -C a -C b` lands in `a/b`, not in `b` alone. An absolute -C word resets the path, the
 * same way a `cd /abs/path` does: it clears any -C word that came before it.
 *
 * Returns undefined when `tail` holds no -C word.
 */
function gitCDir(tail: string[]): string | undefined {
  const values = flagValuesInOrder(tail, new Set(['-C']))
  if (values.length === 0) return undefined
  let acc = '.'
  for (const v of values) {
    acc = isAbsolute(v) ? v : joinPath(acc, v)
  }
  return acc
}

/**
 * Returns the reason to deny `cmd`, a command that starts with a `git` word.
 * Returns undefined to allow `cmd`.
 *
 * claude-factory-zl5.3: this finds the `push` verb past git's own global flags.
 * Those flags are `-C`, `-c`, `--git-dir`, `--work-tree` and `--namespace`.
 * It uses the same method that `ghReason` uses to find the verb of `gh`.
 * `dir` is the value of `-C` when given. Otherwise, `dir` is `root`.
 * `gate.headOf(dir)` reads the current branch there.
 *
 * claude-factory-zl5.35: This guard checks `send-pack` in the same way as `push`, through `sendPackDenied`.
 *
 * claude-factory-c63: this also updates `state`, the scan state shared for the whole top-level call.
 * It sets `state.branchChange` when `gitChangesBranch` names a verb at `vi`.
 * When the verb search is uncertain, it searches for such a verb anywhere in `tail` before a literal `--`.
 * It sets `state.headPush` when `pushReadsCurrentBranch` returns true for the push or send-pack tail that this function finds.
 * `denyReason` denies the whole command when both flags are true at the end, even when neither alone denies here.
 *
 * claude-factory-68gn: `moved` is true when an earlier `cd`, `pushd` or `popd` word, in this
 * segment or an earlier one, already made the current directory unknown (see `anyGitReason` and
 * `denyAt`'s own `movedSoFar`). `moved` is also true when `tail` itself holds a `--git-dir` flag:
 * that flag points git at a different repository's `.git` directory, the same hazard as a `cd`.
 * When `moved`, this function does not call `gate.headOf` at all (it would read the wrong
 * directory, or a `-C` value that resolved relative to the wrong directory), and it treats
 * `currentBranch` as unknown. A denied push then returns `PUSH_DIR_REASON` in place of
 * `PUSH_REASON`, so the worker learns to name the branch instead of retrying the same command.
 */
function gitReason(
  cmd: string[],
  root: string | undefined,
  gate: HookGate,
  state: ScanState,
  moved: boolean,
  aliasDepth = 0,
): string | undefined {
  const tail = cmd.slice(1)
  if (gitDashCPushDenied(tail)) return PUSH_REASON
  const { index: vi, uncertain } = firstVerbIndex(tail, GIT_VALUE_FLAGS, GIT_NO_VALUE_GLOBAL_FLAGS)
  // See claude-factory-68gn. A --git-dir flag moves the command, the same as a cd word.
  // The effectiveMoved value includes this flag. The dir value does not include this flag.
  //
  // If effectiveMoved is true, this function must not trust the -C value.
  // A relative -C path resolves against the directory where this hook started.
  // It must not resolve against a directory that an earlier cd moved the command to.
  //
  // claude-factory-bemr.10: --bare moves the command the same way --git-dir does. Real git
  // reads a different config file there. `git --bare status` still passes below, since status
  // is a builtin word and never reaches the alias-resolution block.
  const effectiveMoved =
    moved || flagValue(tail, new Set(['--git-dir'])) !== undefined || tail.includes('--bare')
  const cValue = flagValue(tail, new Set(['-C']))
  const dir = cValue ?? root
  const verb = vi >= 0 ? tail[vi] : undefined
  // claude-factory-bemr.6: gate.gitAliases gets the raw -C value, or undefined with no -C.
  // It must not get dir's root fallback.
  // claude-factory-ox33 tracks that same root fallback for gate.headOf. It is out of scope here.
  // gate.gitAliases picks its own default: the tool call's own cwd, not CLAUDE_PROJECT_DIR.
  //
  // claude-factory-bemr.8: real git applies each -C word in turn, each one relative to where the
  // word before it left (`git -C a -C b` lands in a/b). gitCDir folds them this way. The cValue
  // field above reads only the last -C word, and so can miss a table in an earlier -C alone.
  const aliasDir = gitCDir(tail)
  //
  // See claude-factory-bemr. This part of the function finds a git alias for the verb.
  // It does not run this part when the verb position is not sure.
  // It also does not run this part when verb is a builtin command.
  // Git uses a builtin command before an alias with the same name. This function does the same.
  //
  // claude-factory-bemr.7: this part denies the command with ALIAS_USE_REASON under five
  // conditions:
  //
  //   1. effectiveMoved is true. An earlier cd, pushd, popd or --git-dir word makes the alias
  //      table unknown for that directory.
  //
  //   2. The alias chain runs deeper than MAX_ALIAS_DEPTH levels. This limit stops a cycle of
  //      aliases, which could stop the hook from completing.
  //
  //   3. The alias table is unset or undefined. The hook cannot read the table. It denies the
  //      command instead of a guess.
  //
  //   4. The alias entry's text starts with `!`. That alias runs a shell command, not a plain
  //      git command.
  //
  //   5. splitCmdline cannot split the alias entry's text. One example is an unclosed quote.
  //      Another is a trailing backslash.
  if (!uncertain && verb !== undefined && !GIT_BUILTIN_VERBS.has(verb)) {
    if (effectiveMoved) return ALIAS_USE_REASON
    if (aliasDepth > MAX_ALIAS_DEPTH) return ALIAS_USE_REASON
    const table = gate.gitAliases?.(aliasDir)
    if (!table) return ALIAS_USE_REASON
    const text = table.get(verb.toLowerCase())
    if (text !== undefined) {
      if (text.startsWith('!')) return ALIAS_USE_REASON
      const expansion = splitCmdline(text)
      if (!expansion) return ALIAS_USE_REASON
      const expanded = ['git', ...tail.slice(0, vi), ...expansion, ...tail.slice(vi + 1)]
      return gitReason(expanded, root, gate, state, moved, aliasDepth + 1)
    }
    // no entry for this word: an external git-<verb> or unrecognized word, fall through to the
    // checks below unchanged, the same as before this guard existed.
  } else if (uncertain) {
    // claude-factory-bemr.5: an unknown flag makes the verb search uncertain.
    // The flag is not in GIT_VALUE_FLAGS or GIT_NO_VALUE_GLOBAL_FLAGS.
    // The word firstVerbIndex found may be a flag's value, not the real verb.
    // This guard cannot place one alias at the verb slot for sure in that case.
    // It must not allow the command in silence either.
    //
    // This part denies ALIAS_USE_REASON under three conditions:
    //
    //   1. effectiveMoved is true.
    //
    //   2. The alias table cannot be read.
    //
    //   3. A non-flag word, anywhere in tail, is both a non-builtin word and a key in the
    //      alias table. That word is a likely alias use. This guard cannot place it for sure.
    //
    // claude-factory-bemr.9: this scan does not stop at a literal --. An unrecognized flag can
    // take -- as its own value (`git --attr-source -- zz` runs the `zz` alias), so this guard
    // scans every word in tail for the real verb.
    if (effectiveMoved) return ALIAS_USE_REASON
    const table = gate.gitAliases?.(aliasDir)
    if (!table) return ALIAS_USE_REASON
    for (const w of tail) {
      if (w.startsWith('-') && w !== '-') continue
      const lw = w.toLowerCase()
      if (GIT_BUILTIN_VERBS.has(lw)) continue
      if (table.has(lw)) return ALIAS_USE_REASON
    }
  }
  if (vi >= 0 && gitChangesBranch(tail[vi]!, tail.slice(vi + 1))) {
    state.branchChange = true
  } else if (uncertain && hasMutatingWordBeforeDashDash(tail, BRANCH_CHANGE_UNCERTAIN_VERBS)) {
    state.branchChange = true
  }
  // claude-factory-zl5.21: the `git config` subcommand's own form of the same two writes.
  if (vi >= 0 && tail[vi] === 'config' && gitConfigSubcommandPushDenied(tail.slice(vi + 1))) {
    return PUSH_REASON
  }
  let pushTail: string[] | undefined
  let isSendPack = false
  if (vi >= 0 && tail[vi] === 'push') {
    pushTail = tail.slice(vi + 1)
  } else if (vi >= 0 && tail[vi] === 'send-pack') {
    pushTail = tail.slice(vi + 1)
    isSendPack = true
  } else if (uncertain && hasMutatingWordBeforeDashDash(tail, new Set(['push', 'send-pack']))) {
    const pi = tail.indexOf('push')
    const si = tail.indexOf('send-pack')
    if (pi >= 0 && (si < 0 || pi < si)) {
      pushTail = tail.slice(pi + 1)
    } else if (si >= 0) {
      pushTail = tail.slice(si + 1)
      isSendPack = true
    }
  }
  if (!pushTail) return undefined
  if (pushReadsCurrentBranch(pushTail, isSendPack)) state.headPush = true
  const currentBranch = effectiveMoved ? undefined : gate.headOf?.(dir)
  const reason = effectiveMoved ? PUSH_DIR_REASON : PUSH_REASON
  if (isSendPack) return sendPackDenied(pushTail, currentBranch, gate) ? reason : undefined
  return gitPushDenied(pushTail, currentBranch, gate) ? reason : undefined
}

// claude-factory-zl5.43: a dashed git-core binary name (`git-push`, `git-send-pack`, and so on)
// runs the same code as `git <verb>`, with the verb baked into the binary name instead of a
// separate argument. `git --exec-path` holds one such binary per verb, and a real shell finds
// them there or on PATH with no `git` word anywhere in the command line. The capture group is the
// verb itself: `git-push origin main` reads the same as `git push origin main`.
const GIT_DASHED_BINARY = /^git-(.+)$/

// claude-factory-68gn: a word whose baseWord is one of these changes the shell's current
// directory. cd, pushd and chdir change it. popd restores an earlier one. zsh's own chdir
// builtin does the same job as cd, and zsh is the worker shell on this host (claude-factory-
// 68gn.5). denyAt tracks this across the whole command. anyGitReason and anyShellReason also
// track it within one segment, word by word.
const DIR_CHANGE_WORDS = new Set(['cd', 'pushd', 'popd', 'chdir'])

/** True when any word in `words` has a baseWord in `DIR_CHANGE_WORDS` (claude-factory-68gn). */
function hasDirChangeWord(words: string[]): boolean {
  return words.some(w => DIR_CHANGE_WORDS.has(baseWord(w)))
}

/**
 * Returns true when a word in `words` is a bare `git` token, or a dashed git-core binary name
 * (claude-factory-zl5.43). From that word, the words start a command that this guard denies
 * (claude-factory-zl5.3). The function scans every position, with the same fail-closed rule as
 * `anyGhReason` for `gh`. A wrapper that this hook does not strip by name cannot hide a `git`
 * word that follows it.
 *
 * claude-factory-68gn: `moved` starts at `movedBefore`, true when an earlier segment of the whole
 * command already moved the current directory (`denyAt`'s `movedSoFar`). It turns true for good
 * at the first `cd`, `pushd` or `popd` word in this segment, or the first `env` word here that
 * carries a `-C`/`--chdir` flag (`envChdirPresent`). This single forward pass reads `moved` into
 * every `git` word after that point, with no separate backward rescan at each one: a rescan at
 * every `git` word would cost O(n^2) on a command with many of them, the same class of bug
 * claude-factory-1by and claude-factory-lbn already fixed for other scans in this file.
 */
function anyGitReason(
  words: string[],
  root: string | undefined,
  gate: HookGate,
  state: ScanState,
  movedBefore: boolean,
): string | undefined {
  let moved = movedBefore
  for (let j = 0; j < words.length; j++) {
    const b = baseWord(words[j]!)
    if (DIR_CHANGE_WORDS.has(b)) {
      moved = true
      continue
    }
    if (b === 'env' && envChdirPresent(words, j)) {
      moved = true
      continue
    }
    if (b === 'git') {
      const r = gitReason(words.slice(j), root, gate, state, moved)
      if (r) return r
      continue
    }
    const dashed = GIT_DASHED_BINARY.exec(b)
    if (dashed) {
      const r = gitReason(['git', dashed[1]!, ...words.slice(j + 1)], root, gate, state, moved)
      if (r) return r
    }
  }
  return undefined
}

/**
 * True when a word in `words` is a bare `kubectl`, `ko` or `helm` token. From that word on, the
 * words must start a mutating command denied by `personOnly`.
 * claude-factory-25z.12: this hook does not know every wrapper by name (`eval`, `find -exec`,
 * `xargs`, `timeout` with flags, `watch`, `nix shell ... -c`, `direnv exec`). A wrapper it does not
 * know must not hide that word. So this checks every position in the segment, not only the head.
 * A word that only contains the text "kubectl" does not match. This covers a quoted argument, a
 * path, and an unrelated flag value.
 */
function anyLiveApplyWord(words: string[], personOnly: string[]): boolean {
  for (let j = 0; j < words.length; j++) {
    const bw = baseWord(words[j]!)
    if ((bw === 'kubectl' || bw === 'ko' || bw === 'helm') && liveApplyDenied(words.slice(j), personOnly)) {
      return true
    }
  }
  return false
}

/**
 * Looks for a `sh`, `bash`, `zsh`, `dash` or `eval` word at any position in `words`. It recurses
 * into denyReason on the script that word runs.
 *
 * claude-factory-25z.14: a wrapper this hook does not strip by name (`sudo -u`, `nice -n`,
 * `timeout -s`, `watch`, `find -exec`) can carry flag words of its own. These flag words push the
 * shell word past position 0. `realCommand` strips only a wrapper word it knows, so it leaves an
 * unknown wrapper's shell word in place, and `baseWord(cmd[0])` never finds it. This function
 * scans every word position instead, the same fail-closed scan `anyLiveApplyWord` uses.
 *
 * claude-factory-25z.17: the `eval` case reads every word from `j + 1` on. The `sh -c` case reads
 * one script word. A later loop step must not read those same words again in a new recursion. The
 * old code did read them again at each later `j`. Each extra read doubled the work of the read
 * before it. A command with many stacked `eval` words then took exponential time. This can time
 * out the 10 s hook, in place of a deny or an allow verdict. A shell or `eval` word now consumes
 * every word after it. The loop moves `j` past the script. For `eval` the loop stops: no word
 * after a bare `eval` has a use outside its own joined rest.
 *
 * claude-factory-25z.19: `sh`, `bash` and `zsh` keep reading their own options after the `-c`
 * cluster, up to the first word that is not one of their options. An option can itself take a
 * value word, for example `-O extglob`. So the real script can sit one or more words past
 * `words[j + ci + 1]`. This hook does not know every shell option. It tries every later word that
 * does not start with `-` as a candidate script. It also tries the word right after a literal
 * `--`, because an operand there can start with `-` and still be the script. A recursion on a
 * wrong candidate (an option's own value word, for example `extglob`) is safe: denyAt returns
 * undefined for it. Each word is still read once. The loop moves `j` to the last word it checked,
 * so a later step never reads this span again (the .17 bound).
 *
 * claude-factory-epz: `depth` counts how many eval/sh -c levels denyAt has already recursed
 * through to reach `words`. Each recursive call below passes `depth + 1`, so denyAt can fail
 * closed past MAX_SHELL_DEPTH levels instead of recursing without a bound.
 *
 * claude-factory-zl5.42: `env -S STRING` (GNU and BSD) splits `STRING` into words at run time and
 * runs it, the same shape of hazard as `eval`. `envSplitStringValue` reads `STRING` off the `env`
 * word's own flags: the plain `-S`/`--split-string` form with the value as a separate word, the
 * attached form (`-S'git push origin main'`, tokenized with the quote stripped as one word
 * `-Sgit push origin main`), a short-flag cluster (`-vS`), and `--split-string=...`.
 *
 * claude-factory-dgf: `env` has more value flags. These are `-u`/`--unset`, `-C`/`--chdir`, `-P`
 * and `--argv0`/`-a`. `envSplitStringValue` now reads past each flag's own value word. A value
 * word does not stop the scan before a later `-S`. The function also reads a prefix of a long
 * flag name, such as `--spl` for `--split-string`. GNU `getopt_long` reads a prefix this way.
 *
 * claude-factory-1by: `nc` and `nd` hold state across one call of this function, as two forward
 * pointers that only move up.
 *
 * `nc` holds the next index at or after the current `j` whose word passes `isShCCluster`.
 * `nd` holds the next index at or after `j` whose word is a literal `--`.
 *
 * Each pointer keeps its old value until `j` moves past it. Then the code scans forward from `j`
 * to find the pointer's new value; it never scans from the start. So over the whole call, each
 * pointer crosses each word at most once: O(n) in total. The old code called
 * `shCFlagIndex(words.slice(j))` at every `j`. Its slice copy and its scan each cost O(n-j). That
 * was the O(n^2) bug this change fixes.
 *
 * A cluster counts only when it comes before the next `--` (`nc < nd`). That is why
 * `sh foo -- bash -c "..."` still finds the cluster after the `--`, and `sh -- ...` still finds
 * none before it. This is an exact match for the old `shCFlagIndex` return value, not an
 * approximation: see src/worker-hook.test.ts for the differential checks and for the two
 * regression shapes that a blind jump past a miss would break.
 */
// claude-factory-dgf: `env` (GNU and BSD) reads each word after `env` as an option. It stops at
// the first word that is not an option. That word and each word after it is the real command.
//
// `-u`/`--unset`, `-C`/`--chdir`, `-P`/`-L`/`-U` (BSD) and `--argv0`/`-a` (GNU) each take a
// value. You can give the value in one of two ways:
//
// - In the same word as the flag: `-uFOO`, `--unset=FOO`.
// - As the next word: `-u FOO`. In this case, the value word does not start with `-`.
//
// The old scan read that word as the real command, so it never reached a later `-S`. The scan
// below reads the value of each value flag, not the command. So it can reach a later `-S`.
//
// GNU `getopt_long` also accepts a prefix of a long option name. It does so when the prefix names
// only one option. `--spl` and `--unset` (the full name) both name their own option this way.
//
// claude-factory-68gn.11: BSD `env` also reads a value after `-P` (alternate PATH), `-L` (login
// class) and `-U` (login). `ENV_SHORT_VALUE_FLAGS` has these two BSD letters too, with GNU's `u`,
// `C` and `a`. Checked on macOS: `env -u FOO -C /usr pwd` prints `/usr`, not the worktree root.
const ENV_LONG_SPLIT_STRING = 'split-string'
const ENV_LONG_VALUE_FLAGS = ['unset', 'chdir', 'argv0']
const ENV_SHORT_VALUE_FLAGS = new Set(['u', 'C', 'P', 'L', 'U', 'a'])

// claude-factory-zl5.42 / claude-factory-dgf: finds an env -S/--split-string flag after words[j].
// Returns its value, its own index sIndex, and end, the index of the first word after it.
// claude-factory-igj: touchesBeadsActor uses sIndex and end for its own recursive scan.
function envSplitStringScan(
  words: string[],
  j: number,
): { value: string; sIndex: number; end: number } | undefined {
  for (let k = j + 1; k < words.length; k++) {
    const w = words[k]!
    if (w === '-') continue // a bare `-` operand: not an option, keeps the scan going
    if (w === '--') return undefined // ends option parsing: the real command follows
    if (w.startsWith('--')) {
      const body = w.slice(2)
      const eqAt = body.indexOf('=')
      const name = eqAt === -1 ? body : body.slice(0, eqAt)
      const attached = eqAt === -1 ? undefined : body.slice(eqAt + 1)
      if (name.length > 0 && ENV_LONG_SPLIT_STRING.startsWith(name)) {
        if (attached !== undefined) return { value: attached, sIndex: k, end: k + 1 }
        const v = words[k + 1]
        return v === undefined ? undefined : { value: v, sIndex: k, end: k + 2 }
      }
      if (
        attached === undefined &&
        name.length > 0 &&
        ENV_LONG_VALUE_FLAGS.some(full => full.startsWith(name))
      ) {
        k++ // skip this flag's separate value word (`--unset FOO`, `--chdir /tmp`, ...)
      }
      continue // an unrelated long option (`--debug`, `--ignore-signal`, ...): keep scanning
    }
    if (w.startsWith('-')) {
      const chars = w.slice(1)
      for (let ci = 0; ci < chars.length; ci++) {
        const c = chars[ci]!
        if (c === 'S') {
          const rest = chars.slice(ci + 1)
          if (rest.length > 0) return { value: rest, sIndex: k, end: k + 1 }
          const v = words[k + 1]
          return v === undefined ? undefined : { value: v, sIndex: k, end: k + 2 }
        }
        if (ENV_SHORT_VALUE_FLAGS.has(c)) {
          const rest = chars.slice(ci + 1)
          if (rest.length === 0) k++ // the value is the next whole word: skip it
          break // the cluster's value, attached or skipped, ends the cluster
        }
      }
      continue // an unrelated short cluster (`-i`, `-v`, `-0`, ...): keep scanning
    }
    return undefined
  }
  return undefined
}

/**
 * Reads the value that the `env -S`/`env --split-string` word at `words[j]` splits and runs.
 * Returns undefined when no such flag is present. A thin wrapper over `envSplitStringScan`: see
 * that function for the scan rules.
 */
function envSplitStringValue(words: string[], j: number): string | undefined {
  return envSplitStringScan(words, j)?.value
}

// claude-factory-68gn.12: GNU `getopt_long` accepts a unique prefix of a long option name, which a whole-word match misses.
// Real GNU coreutils 9.11 `env` runs `--ch=/usr`, `--chd /usr`, `--u NAME`, `--uns NAME` and `--arg ARG`.
// Each form works the same as the full name.
// `wordsCarryChdir` matches a prefix against the base names below.
// `chdir` and `split-string` each move or hide the command (see the comment on `wordsCarryChdir` below).
// `unset` and `argv0` take a value of their own, but do neither on their own.
const ENV_LONG_CHDIR_NAMES = ['chdir', 'split-string']
const ENV_LONG_VALUE_ONLY_NAMES = ['unset', 'argv0']
// On this host (GNU coreutils 9.11), `env --help` lists these as the only other long options with no value.
// A long option must match one of these names in full, not by a prefix.
// A prefix match stays ambiguous between a flag named here and a flag that `wordsCarryChdir` does not know.
// Such flags include `--block-signal`, `--ignore-signal` and others.
// So `wordsCarryChdir` fails closed on such a match (claude-factory-68gn.12).
const ENV_LONG_NOVALUE_NAMES = ['ignore-environment', 'null', 'debug', 'help', 'version']
// The short letters `u` and `a` stand for `unset` and `argv0`.
// BSD `env` has its own `-P` (alternate `PATH`), `-L` (login class) and `-U` (login).
// Each of these takes a value of its own, as the next word or attached to the flag word.
// None of them moves or hides the command.
const ENV_SHORT_VALUE_ONLY_LETTERS = new Set(['u', 'a', 'P', 'L', 'U'])

/**
 * This function checks the `env` flags that start at `start`.
 * It returns true when `env` has a `-C`/`--chdir` or `-S`/`--split-string` flag before its command.
 * `envChdirPresent` is the caller for the real command line.
 * The same scan reads the first words of a recursed-into script, through `denyAt`.
 * GNU and BSD `env` change the child command's directory with `-C`/`--chdir`, as `cd` does.
 * On any `-S`/`--split-string` word, the function fails closed (returns true) and does not look past it.
 *
 * ```text
 * -C forms read (claude-factory-68gn.12 for prefixes):
 *   -C dir, --chdir dir
 *   --chdir=dir
 *   -Cdir
 *   -vC dir (short-flag cluster that includes C)
 *   unique prefix of the long name
 *
 * -S forms that fail closed:
 *   -S value
 *   -Svalue, --split-string=value
 *   -vS value (short-flag cluster that ends with S)
 *
 * -S values not read (checked on this host):
 *   env -S '-C /usr' pwd        prints /usr (claude-factory-68gn.10)
 *   env -S '"-C" /usr' pwd      prints /usr; the quotes come off before the split (claude-factory-68gn.13)
 *   env -S '-u' X -C /usr pwd   prints /usr; env appends the command-line words to the split words,
 *                               so X becomes the value of -u and -C moves the command (claude-factory-68gn.14)
 *   GNU and BSD env re-parse an -S value as more env flags at run time.
 * ```
 */
function wordsCarryChdir(words: string[], start: number): boolean {
  for (let k = start; k < words.length; k++) {
    const w = words[k]!
    if (w === '-') continue // a bare `-` operand, not a flag: BSD `env` reads it as `-i`
    if (w === '--') return false // ends env's own option parsing; the real command follows
    if (w.startsWith('--')) {
      const body = w.slice(2)
      const eqAt = body.indexOf('=')
      const name = eqAt === -1 ? body : body.slice(0, eqAt)
      const attached = eqAt !== -1
      if (name.length === 0) return true // "---foo" and the like: not a name we know, fail closed
      if (ENV_LONG_NOVALUE_NAMES.includes(name)) continue
      if (ENV_LONG_CHDIR_NAMES.some(full => full.startsWith(name))) return true
      if (ENV_LONG_VALUE_ONLY_NAMES.some(full => full.startsWith(name))) {
        if (!attached) k++
        continue
      }
      return true // an unrecognized or ambiguous long option name: fail closed
    }
    if (w.startsWith('-') && w.length > 1) {
      const chars = w.slice(1)
      let hazard = false
      let consumesNextWord = false
      for (let ci = 0; ci < chars.length; ci++) {
        const c = chars[ci]!
        if (c === 'C' || c === 'S') {
          hazard = true
          break
        }
        if (ENV_SHORT_VALUE_ONLY_LETTERS.has(c)) {
          if (chars.slice(ci + 1).length === 0) consumesNextWord = true
          break
        }
      }
      if (hazard) return true
      if (consumesNextWord) k++
      continue
    }
    return false // env's own command word; no chdir-hazard flag appeared before it
  }
  return false
}

/** `wordsCarryChdir`'s own entry point for the real command line (claude-factory-68gn). */
function envChdirPresent(words: string[], j: number): boolean {
  return wordsCarryChdir(words, j + 1)
}

// claude-factory-68gn: `movedBefore` is the same fail-closed state `denyAt` already tracks
// (`movedSoFar`) for a `cd`, `pushd` or `popd` word in an earlier segment of the whole command.
// `moved` starts there, and turns true for good at the first `cd`, `pushd` or `popd` word in this
// segment, or the first `env` word here that carries a `-C`/`--chdir` flag. Each recursion site
// below reads `moved` as it stands at that point in this single forward pass (the same O(n) shape
// `anyGitReason` uses, for the same reason: a rescan at each recursion site would cost O(n^2) on a
// command with many of them). The recursed-into `denyAt` call starts already moved, so a `git
// push` inside the recursed script fails closed the same way one right in this segment would
// (AC6 in the plan for claude-factory-68gn).
//
// claude-factory-bemr: `ghConfigMovedBefore` tracks a different hazard, a `GH_CONFIG_DIR`,
// `XDG_CONFIG_HOME`, or `HOME` assignment, not a `cd`.
// This function does not scan for that assignment itself.
// It only carries the value down, unchanged, into a nested script.
// A recursed-into `denyAt` call then runs its own scan for that assignment.
function anyShellReason(
  words: string[],
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
  depth: number,
  state: ScanState,
  movedBefore: boolean,
  ghConfigMovedBefore: boolean,
): string | undefined {
  let nc = -1
  let nd = -1
  let moved = movedBefore
  for (let j = 0; j < words.length; j++) {
    const bw = baseWord(words[j]!)
    if (DIR_CHANGE_WORDS.has(bw)) {
      moved = true
      continue
    }
    if (bw === 'env') {
      if (envChdirPresent(words, j)) moved = true
      const val = envSplitStringValue(words, j)
      if (val === undefined) continue
      // claude-factory-vco: GNU env and macOS /usr/bin/env read \_ or a real newline in this
      // value as a word break, quoted or not. They read \t as a tab in the same word. Any other
      // backslash use, including a lone trailing backslash, exits env with status 1. denyAt's
      // own tokenizer does none of this, so a hidden command such as 'git\_push\_origin\_main'
      // stays one harmless word there. Fail closed on any backslash or newline instead of
      // chasing every parser gap this escape can open.
      if (/[\\\n]/.test(val)) return ENV_SPLIT_ESCAPE_REASON
      // claude-factory-z1p: fail closed on a dollar sign before denyAt tokenizes the literal
      // text. denyAt would read a word such as `${FOO}` as-is and never match it to a real git
      // or gh verb; env expands it to one command word at run time, past this guard's sight.
      if (val.includes('$')) return ENV_SPLIT_VAR_REASON
      const r = denyAt(val, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore)
      if (r) return r
      break
    }
    if (bw === 'sh' || bw === 'bash' || bw === 'zsh' || bw === 'dash') {
      if (nc < j) {
        nc = j
        while (nc < words.length && !isShCCluster(words[nc]!)) nc++
      }
      if (nd < j) {
        nd = j
        while (nd < words.length && words[nd] !== '--') nd++
      }
      if (nc >= nd) continue
      let k = nc + 1
      let found: string | undefined
      for (; k < words.length; k++) {
        const w = words[k]!
        if (w === '--') {
          k++
          if (k < words.length)
            found = denyAt(words[k]!, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore)
          break
        }
        if (w.startsWith('-')) continue
        found = denyAt(w, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore)
        if (found) break
      }
      if (found) return found
      j = k
      continue
    }
    if (bw === 'eval') {
      const rest = words.slice(j + 1)
      if (rest.length) {
        const r = denyAt(rest.join(' '), root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore)
        if (r) return r
      }
      break
    }
  }
  return undefined
}

// claude-factory-dts: a long multi-push command denies slowly.
// Each push segment causes 2 git spawns.
// gitReason calls gate.headOf(dir).
// protectedBranchSet calls gate.originHead(), inside gitPushDenied and sendPackDenied.
// No code cached either call.
// A command with N push segments spawns about 2N git processes.
// This scan can run past the hook's own 10 s PreToolUse timeout (see :67-68).
// Past that timeout, the hook fails open: the command runs unchecked.
const MAX_HEAD_DIRS = 8

// claude-factory-dts.4: MAX_HEAD_DIRS gives the maximum number of spawns. It does not set a limit on the time of each spawn.
// Each git spawn can use its full timeout if it is stuck or slow.
// Up to 8 headOf spawns and 1 originHead spawn can use 9 full timeouts.
// That is more than the hook's own 10 s PreToolUse timeout.
// GATE_BUDGET_MS gives the maximum total time that memoGate spends on gate spawns for one denyReason call.
//
// When memoGate has used the budget, it skips the spawn and gives undefined. This is a fail-closed result.
// MAX_HEAD_DIRS uses the same fail-closed rule.
//
// 6000 ms is below the 10 s timeout, so the remaining scan has time to finish.
// The budget also covers one spawn that started before the deadline.
// That spawn gets its own timeout. memoGate decreases it to the time left (see the
// Math.min(2000, remaining) lines below).
const GATE_BUDGET_MS = 6000

/**
 * This memo for `gate` makes `headOf` and `originHead` each spawn git at most one time for one
 * `denyReason` call. One memo covers each push segment, each eval level and each sh -c level that
 * the scan goes through (claude-factory-dts).
 *
 * `originHead` calls the original function at most one time.
 * The memo keeps the result, and it also keeps an undefined result.
 * An unresolved `origin/HEAD` denies every branch-targeting push (claude-factory-zl5.13).
 * The memo must give that same unresolved answer again. It must not drop the answer on a
 * subsequent call.
 *
 * `headOf` keeps one cached result for each separate `dir` key, in a `Map`.
 * The unset `dir` is its own key. `headOf()` and `headOf(undefined)` share one entry.
 * When there are more than MAX_HEAD_DIRS = 8 separate dirs, `headOf` gives undefined.
 * It does not spawn a git process. This is a fail-closed result.
 *
 * `gitPushDenied` uses the same rule for an unknown current branch (claude-factory-zl5.12).
 *
 * A shared deadline also limits the time of each spawn (claude-factory-dts.4).
 * The deadline is GATE_BUDGET_MS after this memo is built.
 * Each call gives the original `headOf` or `originHead` a `timeoutMs`. This value is at most
 * the time left before the deadline.
 *
 * After the deadline, a call skips the spawn and gives undefined at once.
 * A slow or stuck git spawn cannot make the whole scan last longer than the hook's own
 * 10 s PreToolUse timeout.
 *
 * The wrapped gate keeps a field unset when the caller left it unset.
 * A caller that does not set `gate.headOf` and does not set `gate.originHead` has the same
 * behavior as before this memo.
 */
function memoGate(gate: HookGate): HookGate {
  const memo: HookGate = { ...gate }
  const deadline = Date.now() + GATE_BUDGET_MS
  if (gate.originHead) {
    const real = gate.originHead
    let called = false
    let result: string | undefined
    memo.originHead = () => {
      if (!called) {
        called = true
        const remaining = deadline - Date.now()
        if (remaining > 0) result = real(Math.min(2000, remaining))
      }
      return result
    }
  }
  if (gate.headOf) {
    const real = gate.headOf
    const cache = new Map<string | undefined, string | undefined>()
    memo.headOf = dir => {
      if (cache.has(dir)) return cache.get(dir)
      if (cache.size >= MAX_HEAD_DIRS) return undefined
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      const result = real(dir, Math.min(2000, remaining))
      cache.set(dir, result)
      return result
    }
  }
  // claude-factory-bemr: ghAliases spawns gh at most one time for one denyReason call.
  // The memo keeps the result, including an undefined result.
  if (gate.ghAliases) {
    const real = gate.ghAliases
    let called = false
    let result: Map<string, string> | undefined
    memo.ghAliases = () => {
      if (!called) {
        called = true
        const remaining = deadline - Date.now()
        if (remaining > 0) result = real(Math.min(2000, remaining))
      }
      return result
    }
  }
  // claude-factory-bemr: gitAliases keeps one cached result for each separate dir, the same
  // rule headOf uses. MAX_HEAD_DIRS caps the number of separate dirs, so a command with many
  // segments cannot force many git config spawns.
  if (gate.gitAliases) {
    const real = gate.gitAliases
    const cache = new Map<string | undefined, Map<string, string> | undefined>()
    memo.gitAliases = dir => {
      if (cache.has(dir)) return cache.get(dir)
      if (cache.size >= MAX_HEAD_DIRS) return undefined
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      const result = real(dir, Math.min(2000, remaining))
      cache.set(dir, result)
      return result
    }
  }
  return memo
}

/**
 * the reason to deny `command`, or undefined to let Claude Code's own prompt decide.
 * `root` is the worktree root. An rm operand outside it is risky too (see riskyTarget).
 * `personOnly` is the rig's list of kube contexts a person alone may change (claude-factory-25z).
 * A non-empty list also denies a kubectl, ko or helm mutation there.
 * It also denies one that names no --context at all.
 * `gate` carries the merge-gate checks' own context (claude-factory-zl5): the running station, the
 * rig's protected branches, and small reads of the live repo a test can fake out. These checks
 * always run, with the defaults the `HookGate` fields describe when `gate` or a field is unset.
 *
 * claude-factory-dts: this checks `command.length` once, before any scan, on every rig. Past
 * MAX_COMMAND_LENGTH it gives `LONG_COMMAND_REASON` outright. At or under that length, it calls
 * `scanReason`, which runs the real scan with no length cap of its own.
 */
export function denyReason(
  command: string,
  root?: string,
  personOnly?: string[],
  gate?: HookGate,
): string | undefined {
  if (command.length > MAX_COMMAND_LENGTH) return LONG_COMMAND_REASON
  return scanReason(command, root, personOnly, gate)
}

/**
 * The scan `denyReason` runs, with no length cap (claude-factory-dts). `denyReason` is the only
 * public entry point that checks `MAX_COMMAND_LENGTH`. A recursive call (through `anyShellReason`,
 * for `eval` or `sh -c`) reads a substring of a command that `denyReason` already capped. So this
 * inner scan does not need a cap of its own.
 *
 * `memoGate` wraps `gate` once here, so every recursion level (`denyAt`, `anyShellReason`)
 * through this one call shares one memoized `headOf`/`originHead`, in place of one real git spawn
 * for every push segment (claude-factory-dts).
 *
 * claude-factory-c63: after `denyAt` allows every segment on its own, this function still denies
 * with `PUSH_REASON`. It does so when the whole command holds both a branch-change word and a
 * HEAD-reading push. See `ScanState` above `denyAt`. `denyAt` would compare the push with a
 * branch name read before the change. An allow there does not prove that the real, later target
 * is safe.
 *
 * claude-factory-68gn: `false` is the `movedBefore` seed for this command (see `denyAt` below). No
 * `cd`, `pushd` or `popd` word has run yet at the top of a fresh `scanReason` call.
 * claude-factory-bemr: the second `false` is the `ghConfigMovedBefore` seed. No `GH_CONFIG_DIR`,
 * `XDG_CONFIG_HOME`, or `HOME` assignment has run yet either.
 */
export function scanReason(
  command: string,
  root?: string,
  personOnly?: string[],
  gate?: HookGate,
): string | undefined {
  const state: ScanState = { branchChange: false, headPush: false }
  const reason = denyAt(command, root, personOnly, memoGate(gate ?? {}), 0, state, false, false)
  if (reason) return reason
  return state.branchChange && state.headPush ? PUSH_REASON : undefined
}

/**
 * denyReason's own body, with `depth` added (claude-factory-epz). `depth` is the number of
 * eval/sh -c recursion levels already taken to reach `command`. anyShellReason passes
 * `depth + 1` at each of its 4 recursion sites: one for `env -S`, two for `sh`/`bash`/`zsh`/
 * `dash -c` (one for the `--` form, one for the plain form), and one for `eval`.
 *
 * `state` is the claude-factory-c63 scan state. It is one object that `denyReason` makes one time.
 * This function passes `state` down unchanged to every recursive call that it makes.
 * That includes each call that `anyShellReason` makes into a nested shell, `eval`, or `env -S` script.
 *
 * claude-factory-68gn: `movedBefore` is true when a `cd`, `pushd` or `popd` word already ran
 * before `command`, either in an outer command's earlier segment or in the script `command`
 * itself sat inside (an eval/sh -c/env -S argument, or an env -S split string). It seeds this
 * call's own `movedSoFar`, the same accumulator that a `cd`/`pushd`/`popd` word in one of
 * `command`'s own segments extends for every segment after it.
 *
 * claude-factory-bemr: `ghConfigMovedBefore` is the same kind of seed.
 * It is for a `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, or `HOME` assignment, not a `cd`.
 * It seeds this call's own `ghConfigMovedSoFar`.
 */
function denyAt(
  command: string,
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
  depth: number,
  state: ScanState,
  movedBefore: boolean,
  ghConfigMovedBefore: boolean,
): string | undefined {
  if (!command) return undefined
  // claude-factory-epz: a deep command denies here, with no personOnly check at all. The
  // MAX_COMMAND_LENGTH cap (claude-factory-25z.20) now runs once, in denyReason, before this
  // function ever runs (claude-factory-dts). denyAt itself checks no length at all.
  if (depth > MAX_SHELL_DEPTH) return DEEP_COMMAND_REASON
  const g = gate
  let hasRm = false
  let hasCd = false
  // claude-factory-zl5.41: this flag accumulates across every segment of `command`, not one
  // segment alone. An `export GIT_CONFIG_COUNT=1` and a later, `;`-separated `git push` are 2
  // different segments, and either order still denies, through the `commandHasGitWord` check
  // below (claude-factory-zl5.44: that check reads the whole raw `command` text, not one segment).
  let hasDangerousConfigEnv = false
  // claude-factory-68gn: true once a cd, pushd or popd word has run, in this command or an outer
  // one. `anyGitReason` reads it for every later segment, and denyAt passes the state forward on
  // every recursion into anyShellReason. It never resets back to false once set.
  let movedSoFar = movedBefore
  // claude-factory-bemr: the same kind of flag, for a GH_CONFIG_DIR, XDG_CONFIG_HOME, or HOME
  // assignment. `anyGhReason` reads it for every later segment.
  let ghConfigMovedSoFar = ghConfigMovedBefore
  for (const words of segments(command)) {
    // claude-factory-8pc.24: check the raw segment words, before realCommand strips a leading
    // VAR=val or wrapper word, so `BEADS_ACTOR=x bd create ...` and `env BEADS_ACTOR=x bd create
    // ...` both still show the assignment here.
    if (touchesBeadsActor(words)) return BEADS_ACTOR_REASON
    // claude-factory-zl5.33: checked before realCommand strips xargs, since the thing this
    // check denies is exactly what realCommand's own strip would otherwise hide.
    if (xargsHidesOperand(words)) return XARGS_REASON
    if (setsDangerousGitConfigEnv(words)) hasDangerousConfigEnv = true
    const cmd = realCommand(words)
    if (!cmd.length) continue
    const b = baseWord(cmd[0]!)
    // claude-factory-25z.12: scan every word, not only cmd[0], so a wrapper this hook does not
    // strip by name cannot hide a kubectl, ko or helm word that follows it.
    if (personOnly?.length && anyLiveApplyWord(words, personOnly)) return LIVE_REASON
    // claude-factory-zl5: the same any-position scan, for a gh word a wrapper (sudo, env, watch,
    // timeout) can push past position 0.
    const ghFound = anyGhReason(words, g, state, ghConfigMovedSoFar)
    if (ghFound) return ghFound
    // claude-factory-zl5.3: the same any-position scan, for a git word a wrapper can push past
    // position 0. claude-factory-68gn: movedSoFar carries an earlier segment's cd/pushd/popd word
    // into this one.
    const gitFound = anyGitReason(words, root, g, state, movedSoFar)
    if (gitFound) return gitFound
    // claude-factory-25z.14: the same scan, for a sh/bash/zsh/dash/eval word a wrapper with flag
    // args (`sudo -u`, `nice -n`, `timeout -s`) or an unknown wrapper (`watch`, `find -exec`) can
    // push past position 0. This recurses into the script it runs, covering both guards above.
    const shellReason = anyShellReason(
      words,
      root,
      personOnly,
      g,
      depth,
      state,
      movedSoFar,
      ghConfigMovedSoFar,
    )
    if (shellReason) return shellReason
    if (b === 'rm') {
      if (isRecursiveRm(cmd) || rmTargets(cmd).some(t => riskyTarget(t, root))) return REASON
      hasRm = true
    } else if (b === 'cd') {
      hasCd = true
    } else if (b === 'find') {
      // claude-factory-lbn: this loop reads `cmd` by index. It does not call `cmd.slice(i + 1)`.
      // `isRecursiveRm(cmd, i + 1)` starts its own scan right after `-exec` or `-execdir`, at the
      // `rm` word. It stops at the first non-flag word. A later `-exec`/`-execdir` match starts a
      // new scan only at its own `rm` word. The scans do not overlap. So the whole loop costs
      // O(n), not O(n^2).
      for (let i = 0; i < cmd.length; i++) {
        if (cmd[i] !== '-exec' && cmd[i] !== '-execdir') continue
        if (i + 1 < cmd.length && baseWord(cmd[i + 1]!) === 'rm' && isRecursiveRm(cmd, i + 1)) return REASON
      }
    }
    // claude-factory-68gn: a cd, pushd, popd or chdir word anywhere in this segment moves the
    // shell's own current directory for every segment after it (not for an env -C or --git-dir
    // flag, which only moves the one command it wraps: anyGitReason's and anyShellReason's own
    // `moved` accumulator reads those, and this segment's own cd/pushd/popd/chdir word, through
    // their own forward scan). This check runs after the checks above, so it affects only a
    // later segment's push, never this one.
    if (hasDirChangeWord(words)) movedSoFar = true
    // claude-factory-bemr: the same rule, for a GH_CONFIG_DIR, XDG_CONFIG_HOME, or HOME
    // assignment anywhere in this segment. It carries into every later segment's gh alias
    // lookup, the same way movedSoFar does above for a git alias lookup.
    if (hasGhConfigEnvWord(words)) ghConfigMovedSoFar = true
  }
  if (hasDangerousConfigEnv && commandHasGitWord(command)) return PUSH_REASON
  return hasRm && hasCd ? REASON : undefined
}

// claude-factory-zl5.3: runs `git symbolic-ref`. `timeoutMs` caps it, at 2000 ms by default.
// The cap stops a stuck or missing git process from blocking the 10 s PreToolUse hook.
// This function returns undefined on an error, a non-zero exit, or empty output.
// `gate.headOf` and `gate.originHead` then treat the branch as unknown.
//
// claude-factory-dts.4: memoGate passes a shorter `timeoutMs` near its own shared deadline.
// This stops one spawn from running the whole scan past the hook's own 10 s timeout.
function gitSymbolicRef(args: string[], timeoutMs = 2000): string | undefined {
  try {
    const p = Bun.spawnSync(['git', ...args], { timeout: timeoutMs })
    if (p.exitCode !== 0) return undefined
    return p.stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

// claude-factory-zl5.8: this caps the file size that `gate.readFile` reads.
// The cap stops one very large file from making the 10 s PreToolUse hook pass its timeout.
const MAX_GRAPHQL_FILE_BYTES = 65536

// claude-factory-zl5.8: reads a small file for `gate.readFile`. It resolves the path against `cwd`.
// `cwd` is the tool call's own cwd, `i.cwd`, not the worktree root. A relative `@file` path
// then resolves as `gh` resolves it, from where the command runs.
// It returns undefined on any error. It also returns undefined for a file over
// MAX_GRAPHQL_FILE_BYTES, or for a file that is not plain.
// `graphqlTexts` then treats the file text as unknown. It fails closed and denies.
function readSmallFile(path: string, cwd: string): string | undefined {
  try {
    const resolved = resolvePath(cwd, path)
    const stat = statSync(resolved)
    if (!stat.isFile() || stat.size > MAX_GRAPHQL_FILE_BYTES) return undefined
    return readFileSync(resolved, 'utf8')
  } catch {
    return undefined
  }
}

//
// claude-factory-bemr: this function reads every alias entry from git config, for gate.gitAliases.
// dir is the directory to read config for. gitReason already picked that directory.
// An exit code of 1 means git found no alias entry. The function then gives an empty map.
// Any other exit code, or an error, gives undefined. gitReason then denies the command, the
// same answer it gives for an unset gate.gitAliases.
function gitConfigAliases(dir: string, timeoutMs = 2000): Map<string, string> | undefined {
  try {
    const p = Bun.spawnSync(['git', '-C', dir, 'config', '-z', '--get-regexp', '^alias\\.'], {
      timeout: timeoutMs,
    })
    if (p.exitCode === 1) return new Map()
    if (p.exitCode !== 0) return undefined
    const map = new Map<string, string>()
    for (const rec of p.stdout.toString().split('\0')) {
      if (!rec) continue
      const nl = rec.indexOf('\n')
      if (nl < 0) continue
      const key = rec.slice(0, nl)
      if (!key.toLowerCase().startsWith('alias.')) continue
      map.set(key.slice('alias.'.length).toLowerCase(), rec.slice(nl + 1))
    }
    return map
  } catch {
    return undefined
  }
}

//
// claude-factory-bemr: this function reads every entry of gh alias list, for gate.ghAliases.
// A non-zero exit code, or a spawn error, gives undefined.
// ghReason then denies the command, the same answer it gives for an unset gate.ghAliases.
function ghAliasList(timeoutMs = 2000): Map<string, string> | undefined {
  try {
    const p = Bun.spawnSync(['gh', 'alias', 'list'], { timeout: timeoutMs })
    if (p.exitCode !== 0) return undefined
    const map = new Map<string, string>()
    for (const line of p.stdout.toString().split('\n')) {
      if (!line) continue
      const sep = line.indexOf(': ')
      if (sep < 0) continue
      map.set(line.slice(0, sep), line.slice(sep + 2))
    }
    return map
  } catch {
    return undefined
  }
}

async function main() {
  const text = await Bun.stdin.text()
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return
  }
  const i = input as { tool_name?: string; cwd?: string; tool_input?: { command?: string } }
  if (i?.tool_name !== 'Bash') return
  // Claude Code sets CLAUDE_PROJECT_DIR to the worktree root for a hook; input.cwd can be a
  // subdir of it after a `cd`, so it is only the second choice for root.
  const root = process.env.CLAUDE_PROJECT_DIR || i.cwd || process.cwd()
  // claude-factory-25z: the rig's person-only kube contexts, carried on this hook's own argv
  const argi = process.argv.indexOf('--person-only-contexts')
  const personOnly = argi >= 0 ? process.argv[argi + 1]?.split(',').filter(Boolean) : undefined
  // claude-factory-zl5.3: the rig's protected branch names, carried on this hook's own argv
  const argp = process.argv.indexOf('--protected-branches')
  const protectedBranches = argp >= 0 ? process.argv[argp + 1]?.split(',').filter(Boolean) : undefined
  const gate: HookGate = {
    station: process.env.FACTORY_FROM,
    protectedBranches,
    headOf: (dir, timeoutMs) =>
      gitSymbolicRef(['-C', dir ?? root, 'symbolic-ref', '--short', 'HEAD'], timeoutMs),
    originHead: timeoutMs =>
      gitSymbolicRef(['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], timeoutMs)?.replace(
        /^origin\//,
        '',
      ),
    // claude-factory-zl5.8: this resolves against the tool call's own cwd, not `root`.
    // If `i.cwd` has no value (no `cd`, no override), this falls back to `root`.
    readFile: path => readSmallFile(path, i.cwd || root),
    // claude-factory-bemr.6: this code reads the alias table at the tool call's own cwd.
    // It does not read the table at root.
    // The Bash tool runs the command at i.cwd. An earlier cd word can move i.cwd away from
    // root (CLAUDE_PROJECT_DIR).
    //
    // dir can be a relative -C value. Resolve dir against i.cwd.
    // Do not resolve dir against the hook process's own cwd.
    //
    // When dir is unset, the lookup dir is i.cwd. The code falls back to root only when
    // i.cwd is also unset. readFile uses this same fallback rule.
    gitAliases: (dir, timeoutMs) => gitConfigAliases(resolvePath(i.cwd || root, dir ?? '.'), timeoutMs),
    ghAliases: timeoutMs => ghAliasList(timeoutMs),
  }
  const reason = denyReason(i.tool_input?.command ?? '', root, personOnly, gate)
  if (!reason) return
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

if (import.meta.main) await main()
