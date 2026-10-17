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
 * This hook only denies.
 * It never approves a command that Claude Code's own prompt would refuse.
 * claude-factory-9wu rejected another design: a hook that approves `rm -rf`, which is a safety regression.
 * If a parse error occurs, the hook fails open and prints nothing.
 * Claude Code's own prompt stays the backstop.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

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

// claude-factory-25z.20: a command this long can make the guard's own scan slow enough to miss
// the 10 s PreToolUse hook timeout, which lets the command run unchecked.
const MAX_COMMAND_LENGTH = 8192

export const LONG_COMMAND_REASON =
  'The factory denies this command: it is longer than 8192 characters, and this rig checks commands ' +
  'against a person-only kube context. A command this long can make that check too slow. ' +
  'Split this command into shorter commands and run them one at a time. Do not retry this exact command.'

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

// claude-factory-zl5.3
export const PUSH_REASON =
  'The factory denies this command: a worker never pushes straight to a protected branch, by ' +
  'owner decision. A protected branch is main, master, the branch origin/HEAD names, or a branch ' +
  'the rig names with --protected-branch. Push your run branch instead, and open a pull request ' +
  'for the change, or a revert pull request for a rollback. Only a person pushes or merges a ' +
  'protected branch. Do not retry this command.'

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
  /** the short branch name `git -C <dir> symbolic-ref --short HEAD` reports, or undefined on any error */
  headOf?: (dir?: string) => string | undefined
  /** the short branch name the repo's `origin/HEAD` points to, or undefined on any error */
  originHead?: () => string | undefined
  /** the text of a small file this guard needs to read (a `gh api graphql` query file), capped and
   * resolved relative to the tool call's own cwd; undefined when it cannot be read */
  readFile?: (path: string) => string | undefined
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

/** true when `words` (the rm command and its args) ask for a recursive delete, stopping flag scanning at `--` or the first non-flag word */
function isRecursiveRm(words: string[]): boolean {
  for (const w of words.slice(1)) {
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
 * Finds the value of the LAST flag in `names` in `words`. A flag can take the `--flag value`
 * form or the `--flag=value` form.
 * claude-factory-25z.8: kubectl, ko and helm all use the last copy of a repeated flag, not the
 * first.
 * This function stops at a literal `--`. A word after `--` is an operand, or an argument to the
 * command kubectl runs (for example `kubectl run x -- --dry-run=client`). It is never a kubectl
 * flag.
 */
function flagValue(words: string[], names: Set<string>): string | undefined {
  let result: string | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') break
    if (names.has(w)) {
      result = words[i + 1]
      continue
    }
    let matched = false
    for (const n of names) {
      if (w.startsWith(`${n}=`)) {
        result = w.slice(n.length + 1)
        matched = true
        break
      }
    }
    if (matched) continue
    // claude-factory-zl5.7: a 2-character short flag (`-X`) can take its value with no separator.
    // For example, `-XPUT` sets the value to PUT. curl does the same. A long flag (`--method`) never takes this form.
    for (const n of names) {
      if (n.length === 2 && n[1] !== '-' && w.startsWith(n) && w.length > n.length) {
        result = w.slice(n.length)
        break
      }
    }
  }
  return result
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
 */
function firstVerbIndex(words: string[], valueFlags: Set<string>): { index: number; uncertain: boolean } {
  let uncertain = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w.startsWith('-') && w !== '-') {
      if (w.includes('=')) continue
      if (valueFlags.has(w)) {
        i++
        continue
      }
      uncertain = true
      continue
    }
    return { index: i, uncertain }
  }
  return { index: -1, uncertain }
}

/**
 * Index of a short-flag cluster that holds `c` (for example `-c`, `-lc`, `-ec`), used to find the
 * `-c "script"` argument of a `sh`, `bash`, `zsh` or `dash` call.
 * claude-factory-25z.10: `bash -lc "..."` and `sh -ec "..."` bundle other short flags with `c`.
 * A plain `cmd.indexOf('-c')` misses them, which also hides an `rm -rf` or a live-apply command
 * inside the quoted script from both guards.
 * Skips a long flag (`--context`) and stops at a literal `--`. Returns -1 when no cluster matches.
 */
function shCFlagIndex(words: string[]): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') return -1
    if (w.startsWith('--')) continue
    if (w.startsWith('-') && w.length > 1 && /c/.test(w.slice(1))) return i
  }
  return -1
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
  for (const f of ghApiFields(apiArgs)) if (f.name === 'query' || f.name === 'input') take(f.value)
  const inputFile = flagValue(apiArgs, new Set(['--input']))
  if (inputFile !== undefined) take(`@${inputFile}`)
  return { texts, unresolved }
}

/** true when a `gh api graphql` call's query text names one of `mutations`, or its text is unknown */
function hasGraphqlMutation(apiArgs: string[], gate: HookGate, mutations: string[]): boolean {
  const { texts, unresolved } = graphqlTexts(apiArgs, gate)
  if (unresolved) return true
  return texts.some(t => mutations.some(m => new RegExp(`\\b${m}\\b`).test(t)))
}

/**
 * True when `endpoint` names the GraphQL endpoint, in any form that `gh api` accepts
 * (claude-factory-zl5.17).
 * The bare word `graphql` is the common form.
 * A leading slash (`/graphql`) or a full URL (`https://api.github.com/graphql`, or an enterprise
 * host's own `.../api/graphql`) names the same endpoint.
 *
 * Each form skips the merge, ready and push mutation checks, unless this function reads it.
 * A trailing slash or query string does not change the endpoint.
 */
function isGraphqlEndpoint(endpoint: string): boolean {
  const path = endpoint.split('?')[0]!.replace(/\/+$/, '')
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
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  const hasData = ghApiFields(apiArgs).length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
  const effective = method || (hasData ? 'POST' : 'GET')
  if (effective === 'PUT' && /\/pulls\/[^/?]+\/merge(\?.*)?$/.test(endpoint)) return true
  return (effective === 'POST' || effective === 'PUT') && /\/merges(\?.*)?$/.test(endpoint)
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

// claude-factory-zl5.10: a REST path that updates or deletes an existing branch ref.
// Like the merge check above, this reads the path's tail, as in `/pulls/<n>/merge`.
// A `/repos/<owner>/<repo>/` prefix is optional. An endpoint can be a full URL or a short path.
const REF_HEADS_PATH = /\/git\/refs\/heads\/([^/?]+)/
// a REST path that creates a new ref. The caller names the new ref in a `ref` field.
const REFS_CREATE_PATH = /\/git\/refs\/?(\?.*)?$/
// a REST path that creates or replaces a file. It commits to a branch. It does not use `git push`.
const CONTENTS_PATH = /\/contents\/.+/

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
 * claude-factory-zl5.18: it also denies when the `ref` or `branch` field is a shell expansion
 * that this hook cannot read (`SHELL_UNSAFE`).
 * A check against a literal, unresolved `$BRANCH` finds no match.
 * So the call would wrongly pass.
 */
function ghApiPushDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint) return false
  if (isGraphqlEndpoint(endpoint)) return hasGraphqlMutation(apiArgs, gate, PUSH_MUTATIONS)
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  const fields = ghApiFields(apiArgs)
  const hasData = fields.length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
  const effective = method || (hasData ? 'POST' : 'GET')
  const { branches: protectedSet, unresolved } = protectedBranchSet(gate)
  const refMatch = REF_HEADS_PATH.exec(endpoint)
  if (refMatch)
    return (effective === 'PATCH' || effective === 'DELETE') && (unresolved || protectedSet.has(refMatch[1]!))
  if (REFS_CREATE_PATH.test(endpoint) && effective === 'POST') {
    const ref = fields.find(f => f.name === 'ref')?.value
    return ref === undefined || unresolved || SHELL_UNSAFE.test(ref) || protectedSet.has(stripRefsHeads(ref))
  }
  if (
    CONTENTS_PATH.test(endpoint) &&
    (effective === 'PUT' || effective === 'POST' || effective === 'DELETE')
  ) {
    const branch = fields.find(f => f.name === 'branch')?.value
    return branch === undefined || unresolved || SHELL_UNSAFE.test(branch) || protectedSet.has(branch)
  }
  return false
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
 */
function ghReason(cmd: string[], gate: HookGate): string | undefined {
  const tail = cmd.slice(1)
  const { index: vi, uncertain } = firstVerbIndex(tail, GH_VALUE_FLAGS)
  const verb = vi >= 0 ? tail[vi] : undefined
  const sub = vi >= 0 ? tail[vi + 1] : undefined
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
  if (verb === 'alias') return ghAliasDenied(tail.slice(vi + 1), gate)
  if (uncertain) {
    if (hasMutatingWordBeforeDashDash(tail, new Set(['merge', 'sync']))) return MERGE_REASON
    if (hasMutatingWordBeforeDashDash(tail, new Set(['ready'])))
      return gate.station === 'release' ? undefined : READY_REASON
  }
  return undefined
}

/**
 * True when `words[0]` is or acts as a `gh` command word, for the expansion check in
 * `ghAliasDenied` (claude-factory-zl5.22).
 * An alias expansion names its command with no leading `gh` word.
 * For example, `gh alias set m "pr merge"` expands to `pr merge`, not `gh pr merge`.
 * So this adds a `gh` word when the expansion has none, before `ghReason` runs on it.
 */
function asGhCommand(words: string[]): string[] {
  return baseWord(words[0]!) === 'gh' ? words : ['gh', ...words]
}

/**
 * The reason to deny `subArgs`, a `gh alias` call's own arguments after the `alias` word.
 * Returns undefined to allow the call (claude-factory-zl5.22).
 * `gh alias set <name> <expansion>` defines a short name for another command.
 * A later `gh <name> ...` call runs that command. That call has no `gh pr merge` or similar word.
 *
 * This hook checks one command line at a time.
 * It has no memory of an alias that a prior command set, so it cannot catch that later call.
 * Instead, it denies the defining call when the expansion's own text already denies through
 * `ghReason`.
 *
 * `gh alias import <file>` reads a whole file of aliases.
 * This hook cannot see that file.
 * The hook denies that call outright, with `ALIAS_REASON`.
 */
function ghAliasDenied(subArgs: string[], gate: HookGate): string | undefined {
  const sub = subArgs[0]
  if (sub === 'import') return ALIAS_REASON
  if (sub !== 'set') return undefined
  const operands = subArgs.slice(1).filter(w => w !== '--' && !w.startsWith('-'))
  const expansion = operands[1]
  if (expansion === undefined) return undefined
  const words = expansion.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return undefined
  return ghReason(asGhCommand(words), gate)
}

/**
 * True when a word in `words` is a bare `gh` token, from which the words start a command this
 * guard denies (claude-factory-zl5). Scans every position, the same fail-closed rule
 * `anyLiveApplyWord` uses for kubectl, ko and helm, so a wrapper this hook does not strip by name
 * cannot hide a `gh` word that follows it.
 */
function anyGhReason(words: string[], gate: HookGate): string | undefined {
  for (let j = 0; j < words.length; j++) {
    if (baseWord(words[j]!) === 'gh') {
      const r = ghReason(words.slice(j), gate)
      if (r) return r
    }
  }
  return undefined
}

// claude-factory-zl5.3: git's own global flags that take a value word (`git -C dir push ...`).
// The verb search steps past them. GH_VALUE_FLAGS does the same for `gh`.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
// `git push`'s own flags that take a value word. The operand search steps past them.
const GIT_PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
// A `git push` flag that pushes every branch, or deletes a remote branch with no local match.
// Each flag can reach a protected branch with no refspec that names it. This guard denies these flags outright.
const PUSH_BROAD_FLAGS = new Set(['--all', '--branches', '--mirror', '--prune'])
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
 * Parses `tail`, which holds the arguments of a `git push` call after the `push` word.
 * `operands` holds every non-flag word, in order.
 * `operands[0]` is the remote, when named. The rest are refspecs.
 *
 * `broad` is true for these flags: `--all`, `--branches`, `--mirror` and `--prune`.
 * Each one can push or prune every branch with no refspec that names one.
 * `tags` is true for `--tags`.
 *
 * `dryRun` is true for `-n` or `--dry-run`.
 * This never pushes, so the caller allows it outright.
 */
function pushOperands(tail: string[]): {
  operands: string[]
  broad: boolean
  tags: boolean
  dryRun: boolean
} {
  const operands: string[] = []
  let broad = false
  let tags = false
  let dryRun = false
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === '--') continue
    if (w.startsWith('-') && w !== '-') {
      if (w.includes('=')) continue
      if (GIT_PUSH_VALUE_FLAGS.has(w)) {
        i++
        continue
      }
      if (PUSH_BROAD_FLAGS.has(w)) broad = true
      else if (w === '--tags') tags = true
      else if (w === '-n' || w === '--dry-run') dryRun = true
      continue
    }
    operands.push(w)
  }
  return { operands, broad, tags, dryRun }
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
  const { operands, broad, tags, dryRun } = pushOperands(tail)
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

// claude-factory-zl5.21: an `alias.<name>` config value runs a push. It does so by itself, or as
// its first word. For example, `push` or `push --force`.
function isPushAliasValue(value: string): boolean {
  return value === 'push' || value.startsWith('push ')
}

// claude-factory-zl5.21: a `remote.<name>.push` config key sets the default push refspec for that
// remote. A later bare `git push <name>` sends there, not to the current branch.
// That later command line has no refspec of its own for this guard to read.
function isRemotePushName(name: string): boolean {
  return /^remote\.[^.]+\.push$/i.test(name)
}

// claude-factory-zl5.21: an `alias.<name>` config key. The name has no dot and no `=`.
function isAliasName(name: string): boolean {
  return /^alias\.[^.=]+$/i.test(name)
}

/**
 * True when `tail` sets a `-c alias.<name>=<value>` or `-c remote.<name>.push=<value>` config key
 * (claude-factory-zl5.10, extended by claude-factory-zl5.21 to the `remote.*.push` key).
 * For example, `git -c alias.p=push p origin main` runs a push. The command line has no `push` word.
 * `git -c remote.origin.push=HEAD:refs/heads/main push` sends a bare `push` to `main`.
 * That push has no refspec of its own.
 *
 * This guard does not read the branch that a `remote.*.push` value names.
 * It also does not read the branch that a push alias reaches.
 * A worker has no normal reason to set either key.
 * So this guard denies the write itself.
 *
 * It uses the same fail-closed rule as `REFSPEC_UNSAFE`, for a value that this guard does not
 * read in full.
 */
function gitDashCPushDenied(tail: string[]): boolean {
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === '--') break
    // real git reads `-c name=value` only as 2 separate words: no `=` form, no `--config` form.
    if (w !== '-c') continue
    const pair = tail[i + 1]
    const eq = pair?.indexOf('=') ?? -1
    if (pair === undefined || eq < 0) continue
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (isRemotePushName(name)) return true
    if (isAliasName(name) && isPushAliasValue(value)) return true
  }
  return false
}

// claude-factory-zl5.21: `git config` flags that take a value word of their own. The operand
// search below steps past them, the same way `GIT_PUSH_VALUE_FLAGS` does for `git push`.
const GIT_CONFIG_VALUE_FLAGS = new Set(['-f', '--file', '-t', '--type', '--default'])

/**
 * True when `configArgs`, the arguments of a `git config` call after the `config` word, sets an
 * `alias.<name>` key to a value that runs a push.
 * It also returns true when `configArgs` sets a `remote.<name>.push` key, whatever the value
 * (claude-factory-zl5.21).
 * This is the `git config` form of the `-c` write that `gitDashCPushDenied` already denies.
 * For example, `git config alias.p push` replaces `git -c alias.p=push`.
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
  const name = operands[0]
  const value = operands[1]
  if (name === undefined) return false
  if (isRemotePushName(name)) return true
  return value !== undefined && isAliasName(name) && isPushAliasValue(value)
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
 */
function gitReason(cmd: string[], root: string | undefined, gate: HookGate): string | undefined {
  const tail = cmd.slice(1)
  if (gitDashCPushDenied(tail)) return PUSH_REASON
  const { index: vi, uncertain } = firstVerbIndex(tail, GIT_VALUE_FLAGS)
  // claude-factory-zl5.21: the `git config` subcommand's own form of the same two writes.
  if (vi >= 0 && tail[vi] === 'config' && gitConfigSubcommandPushDenied(tail.slice(vi + 1))) {
    return PUSH_REASON
  }
  let pushTail: string[] | undefined
  if (vi >= 0 && tail[vi] === 'push') pushTail = tail.slice(vi + 1)
  else if (uncertain && hasMutatingWordBeforeDashDash(tail, new Set(['push']))) {
    const pi = tail.indexOf('push')
    if (pi >= 0) pushTail = tail.slice(pi + 1)
  }
  if (!pushTail) return undefined
  const dir = flagValue(tail, new Set(['-C'])) ?? root
  const currentBranch = gate.headOf?.(dir)
  return gitPushDenied(pushTail, currentBranch, gate) ? PUSH_REASON : undefined
}

/**
 * Returns true when a word in `words` is a bare `git` token.
 * From that word, the words start a command that this guard denies (claude-factory-zl5.3).
 * The function scans every position, with the same fail-closed rule as `anyGhReason` for `gh`.
 * A wrapper that this hook does not strip by name cannot hide a `git` word that follows it.
 */
function anyGitReason(words: string[], root: string | undefined, gate: HookGate): string | undefined {
  for (let j = 0; j < words.length; j++) {
    if (baseWord(words[j]!) === 'git') {
      const r = gitReason(words.slice(j), root, gate)
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
 */
function anyShellReason(
  words: string[],
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
  depth: number,
): string | undefined {
  for (let j = 0; j < words.length; j++) {
    const bw = baseWord(words[j]!)
    if (bw === 'sh' || bw === 'bash' || bw === 'zsh' || bw === 'dash') {
      const ci = shCFlagIndex(words.slice(j))
      if (ci < 0) continue
      let k = j + ci + 1
      let found: string | undefined
      for (; k < words.length; k++) {
        const w = words[k]!
        if (w === '--') {
          k++
          if (k < words.length) found = denyAt(words[k]!, root, personOnly, gate, depth + 1)
          break
        }
        if (w.startsWith('-')) continue
        found = denyAt(w, root, personOnly, gate, depth + 1)
        if (found) break
      }
      if (found) return found
      j = k
      continue
    }
    if (bw === 'eval') {
      const rest = words.slice(j + 1)
      if (rest.length) {
        const r = denyAt(rest.join(' '), root, personOnly, gate, depth + 1)
        if (r) return r
      }
      break
    }
  }
  return undefined
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
 */
export function denyReason(
  command: string,
  root?: string,
  personOnly?: string[],
  gate?: HookGate,
): string | undefined {
  return denyAt(command, root, personOnly, gate ?? {}, 0)
}

/**
 * denyReason's own body, with `depth` added (claude-factory-epz). `depth` is the number of
 * eval/sh -c recursion levels already taken to reach `command`. anyShellReason passes
 * `depth + 1` at each of its 3 recursion sites.
 */
function denyAt(
  command: string,
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
  depth: number,
): string | undefined {
  if (!command) return undefined
  // claude-factory-epz: this check comes before the 8192-char check, so a deep command denies
  // even when personOnly is empty or absent (the 8192 cap applies only when personOnly is set).
  if (depth > MAX_SHELL_DEPTH) return DEEP_COMMAND_REASON
  // claude-factory-25z.20: this guard's own scan cost rises with the length of `command` (see
  // anyLiveApplyWord and anyShellReason). A command built to be long enough can push that scan
  // past the 10 s PreToolUse hook timeout, which lets the command run unchecked. When a
  // person-only context list is set, deny a command this long outright instead of scanning it.
  if (personOnly?.length && command.length > MAX_COMMAND_LENGTH) return LONG_COMMAND_REASON
  const g = gate
  let hasRm = false
  let hasCd = false
  for (const words of segments(command)) {
    const cmd = realCommand(words)
    if (!cmd.length) continue
    const b = baseWord(cmd[0]!)
    // claude-factory-25z.12: scan every word, not only cmd[0], so a wrapper this hook does not
    // strip by name cannot hide a kubectl, ko or helm word that follows it.
    if (personOnly?.length && anyLiveApplyWord(words, personOnly)) return LIVE_REASON
    // claude-factory-zl5: the same any-position scan, for a gh word a wrapper (sudo, env, watch,
    // timeout) can push past position 0.
    const ghFound = anyGhReason(words, g)
    if (ghFound) return ghFound
    // claude-factory-zl5.3: the same any-position scan, for a git word a wrapper can push past
    // position 0.
    const gitFound = anyGitReason(words, root, g)
    if (gitFound) return gitFound
    // claude-factory-25z.14: the same scan, for a sh/bash/zsh/dash/eval word a wrapper with flag
    // args (`sudo -u`, `nice -n`, `timeout -s`) or an unknown wrapper (`watch`, `find -exec`) can
    // push past position 0. This recurses into the script it runs, covering both guards above.
    const shellReason = anyShellReason(words, root, personOnly, g, depth)
    if (shellReason) return shellReason
    if (b === 'rm') {
      if (isRecursiveRm(cmd) || rmTargets(cmd).some(t => riskyTarget(t, root))) return REASON
      hasRm = true
    } else if (b === 'cd') {
      hasCd = true
    } else if (b === 'find') {
      for (let i = 0; i < cmd.length; i++) {
        if (cmd[i] !== '-exec' && cmd[i] !== '-execdir') continue
        const rest = cmd.slice(i + 1)
        if (rest.length && baseWord(rest[0]!) === 'rm' && isRecursiveRm(rest)) return REASON
      }
    }
  }
  return hasRm && hasCd ? REASON : undefined
}

// claude-factory-zl5.3: runs `git symbolic-ref`, with a 2 s cap.
// The 2 s cap stops a stuck or missing git from blocking the 10 s PreToolUse hook.
// It returns undefined on an error, a non-zero exit, or empty output.
// `gate.headOf` and `gate.originHead` then treat the branch as unknown.
function gitSymbolicRef(args: string[]): string | undefined {
  try {
    const p = Bun.spawnSync(['git', ...args], { timeout: 2000 })
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
    headOf: dir => gitSymbolicRef(['-C', dir ?? root, 'symbolic-ref', '--short', 'HEAD']),
    originHead: () =>
      gitSymbolicRef(['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(
        /^origin\//,
        '',
      ),
    // claude-factory-zl5.8: this resolves against the tool call's own cwd, not `root`.
    // If `i.cwd` has no value (no `cd`, no override), this falls back to `root`.
    readFile: path => readSmallFile(path, i.cwd || root),
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
