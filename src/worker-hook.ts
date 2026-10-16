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
 * This hook only denies.
 * It never approves a command that Claude Code's own prompt would refuse.
 * claude-factory-9wu rejected another design: a hook that approves `rm -rf`, which is a safety regression.
 * If a parse error occurs, the hook fails open and prints nothing.
 * Claude Code's own prompt stays the backstop.
 */

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
  'The factory denies this command: it is longer than 8192 bytes, and this rig checks commands ' +
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
    for (const n of names) {
      if (w.startsWith(`${n}=`)) {
        result = w.slice(n.length + 1)
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
])
// a GraphQL mutation name that merges a pull request or a branch
const MERGE_MUTATIONS = ['enablePullRequestAutoMerge', 'mergePullRequest', 'mergeBranch']
// a GraphQL mutation name that marks a pull request ready for review (claude-factory-zl5.2)
const READY_MUTATIONS = ['markPullRequestReadyForReview']

/**
 * Collects every `-f`/`--raw-field`/`-F`/`--field` name=value pair in `words`, a `gh api` call's
 * own arguments. It stops at a literal `--`.
 * `gh api` repeats these flags, one per field. This reads every one, not only the last.
 * `flagValue` differs: it reads a flag that `gh`, `kubectl`, `ko` or `helm` itself takes once.
 */
function ghApiFields(words: string[]): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') break
    if (w === '-f' || w === '--raw-field' || w === '-F' || w === '--field') {
      const v = words[i + 1]
      const eq = v?.indexOf('=') ?? -1
      if (v !== undefined && eq >= 0) fields.push({ name: v.slice(0, eq), value: v.slice(eq + 1) })
      i++
    }
  }
  return fields
}

/**
 * Reads the text of every `query` or `input` field of a `gh api graphql` call. It also reads the
 * call's `--input` file, when set.
 * A field value that starts with `@` names a file. `gate.readFile` reads it, relative to the tool
 * call's own cwd.
 * `unresolved` is true when this cannot read a file's text. The caller then fails closed: the
 * real query text is unknown here.
 */
function graphqlTexts(apiArgs: string[], gate: HookGate): { texts: string[]; unresolved: boolean } {
  const texts: string[] = []
  let unresolved = false
  const take = (v: string) => {
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
 * True when a `gh api` call merges a pull request or a branch through the REST or GraphQL API.
 * `apiArgs` is the call's own arguments, after the `api` word.
 * REST: `PUT .../pulls/<n>/merge` merges a pull request. `POST .../merges` merges a branch.
 * `gh api` sends POST on its own once a caller gives `-f`, `-F` or `--input` data and names no
 * other method with `-X` or `--method`. So a merges call with no explicit method still counts.
 * GraphQL: the `graphql` endpoint's query or `--input` body names `enablePullRequestAutoMerge`,
 * `mergePullRequest` or `mergeBranch`.
 */
function ghApiMergeDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint) return false
  if (endpoint === 'graphql') return hasGraphqlMutation(apiArgs, gate, MERGE_MUTATIONS)
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  const hasData = ghApiFields(apiArgs).length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
  const effective = method || (hasData ? 'POST' : 'GET')
  if (effective === 'PUT' && /\/pulls\/\d+\/merge(\?.*)?$/.test(endpoint)) return true
  return (effective === 'POST' || effective === 'PUT') && /\/merges(\?.*)?$/.test(endpoint)
}

/**
 * True when a `gh api` call's `graphql` endpoint marks a pull request ready for review
 * (claude-factory-zl5.2): its query or `--input` body names `markPullRequestReadyForReview`.
 */
function ghApiReadyDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  return endpoint === 'graphql' && hasGraphqlMutation(apiArgs, gate, READY_MUTATIONS)
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
    const apiArgs = tail.slice(vi + 1)
    if (ghApiMergeDenied(apiArgs, gate)) return MERGE_REASON
    if (ghApiReadyDenied(apiArgs, gate)) return gate.station === 'release' ? undefined : READY_REASON
    return undefined
  }
  if (uncertain) {
    if (hasMutatingWordBeforeDashDash(tail, new Set(['merge', 'sync']))) return MERGE_REASON
    if (hasMutatingWordBeforeDashDash(tail, new Set(['ready'])))
      return gate.station === 'release' ? undefined : READY_REASON
  }
  return undefined
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
 * wrong candidate (an option's own value word, for example `extglob`) is safe: denyReason returns
 * undefined for it. Each word is still read once. The loop moves `j` to the last word it checked,
 * so a later step never reads this span again (the .17 bound).
 */
function anyShellReason(
  words: string[],
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
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
          if (k < words.length) found = denyReason(words[k]!, root, personOnly, gate)
          break
        }
        if (w.startsWith('-')) continue
        found = denyReason(w, root, personOnly, gate)
        if (found) break
      }
      if (found) return found
      j = k
      continue
    }
    if (bw === 'eval') {
      const rest = words.slice(j + 1)
      if (rest.length) {
        const r = denyReason(rest.join(' '), root, personOnly, gate)
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
  if (!command) return undefined
  // claude-factory-25z.20: this guard's own scan cost rises with the length of `command` (see
  // anyLiveApplyWord and anyShellReason). A command built to be long enough can push that scan
  // past the 10 s PreToolUse hook timeout, which lets the command run unchecked. When a
  // person-only context list is set, deny a command this long outright instead of scanning it.
  if (personOnly?.length && command.length > MAX_COMMAND_LENGTH) return LONG_COMMAND_REASON
  const g = gate ?? {}
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
    // claude-factory-25z.14: the same scan, for a sh/bash/zsh/dash/eval word a wrapper with flag
    // args (`sudo -u`, `nice -n`, `timeout -s`) or an unknown wrapper (`watch`, `find -exec`) can
    // push past position 0. This recurses into the script it runs, covering both guards above.
    const shellReason = anyShellReason(words, root, personOnly, g)
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
  const gate: HookGate = { station: process.env.FACTORY_FROM }
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
