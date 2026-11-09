/**
 * A second entry of this hook (matcher Write|Edit|MultiEdit|NotebookEdit|apply_patch) runs `fileWriteReason` (or `applyPatchReason` for a codex apply_patch)
 * on the tool's file path (claude-factory-g4du). The Bash text rules below do not see those tools.
 *
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
 * One exception (claude-factory-l3tl): a person can give a rig merge authority. The hook then lets the
 * ship factory's release station run one strict `gh pr merge` form (see `prMergeReason`).
 * GitHub's admin bypass lets a worker merge, even under a ruleset that needs a review.
 * Before this guard, two pull requests merged before their review ran (ax-aw1).
 *
 * It also denies `gh pr ready` outside the release station and the approving stations (review,
 * security, check) (claude-factory-zl5.2, claude-factory-usp5). Implement opens a pull request as a
 * draft. The station that approves it marks it ready. `gh pr ready --undo` (back to draft) is always allowed.
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

import { appendFileSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join as joinPath, posix, resolve as resolvePath, sep } from 'node:path'
import { HOME_REASON, homeReason } from './home-guard'
import { TOKEN_READ_REASON, tokenPathReason, tokenReason } from './token-guard'
export { TOKEN_READ_REASON }
import * as self from './worker-hook'
import { cut } from './cut'

export const REASON =
  'The factory denies this command: do not run rm -r or rm -rf, do not chain cd with rm, and do not ' +
  'rm a $variable path, a glob, or a path outside the worktree. ' +
  'Leave .scratch as is, use a new subfolder (for example .scratch/<name>-2): git ignores .scratch/. ' +
  'Use absolute paths or git -C <dir> in place of cd. Do not retry this command.'

// claude-factory-25z
export const LIVE_REASON =
  'The factory denies this command: in this rig only a person changes the live kube contexts. ' +
  'A kubectl, ko, helm or flux command that mutates state there is refused, including one that names no ' +
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

// claude-factory-ukho: the fix for a shell form that this guard cannot read.
export const SCRATCH_HINT =
  'Write these steps with the Write tool to .scratch/<name>.sh (or .scratch/<name>.ts for denyReason rows), then run it by its literal path.'

// claude-factory-1zr5
export const SHELL_ALIAS_REASON =
  'The factory denies this command: a word in it is a shell alias from the Claude Code shell snapshot ' +
  'that runs git or gh, or that this hook cannot read. The hook cannot check what the alias does. ' +
  'Type the full git or gh command, with no alias. Do not retry this exact command.'

// claude-factory-mn2y
export const SHELL_ALIAS_DEFINE_REASON =
  'The factory denies this command: it defines a shell alias (alias, an aliases[...] or BASH_ALIASES ' +
  'write, or a dynamic command word) and also runs more. An eval, trap, source, substitution or ' +
  'sourced file reads the new alias after this hook ran. Define no alias; type the full command. ' +
  'Do not retry this exact command. ' +
  SCRATCH_HINT

// claude-factory-1zr5
export const SHELL_ALIAS_READ_REASON =
  'The factory denies this command: the hook cannot read the Claude Code shell-snapshot folder, so it ' +
  'cannot tell which words are shell aliases. Report blocked with that fact. Do not retry this exact command.'

// claude-factory-zl5
export const MERGE_REASON =
  'The factory denies this command: a worker never merges a pull request and never turns its ' +
  'auto-merge on. Only a person merges, by owner decision. This covers gh pr merge, gh repo sync, ' +
  'and a GraphQL or REST call that merges a pull request or a branch, or marks it for auto-merge. ' +
  'Report the pull request link and what it waits on; leave it open. Do not retry this command.'

// claude-factory-l3tl
export const MERGE_FORM_REASON =
  'The factory denies this command: this rig gives the ship release station merge authority, but ' +
  'only one form. Run exactly: gh pr merge <number> --merge --match-head-commit <40-hex head SHA>, ' +
  'with -R set to the owner/repo of this rig (required). Add --auto for a repo with a merge queue. ' +
  'Use no other flag, no URL, no variable and no alias. ' +
  'Do not retry this exact command.'

// claude-factory-zl5.2
export const READY_REASON =
  'The factory denies this command: only the station that approves a pull request (review, ' +
  'security, check) or release marks it ready for review. Keep the pull request a draft here; ' +
  'report its link in your summary. Do not retry this command.'

// claude-factory-0gww.3: the stations that may run as the reviewer identity (the same names as REVIEWER_STATIONS in ax.ts)
const REVIEWER_STATIONS = ['review', 'security', 'check']
// claude-factory-usp5: the approving stations and release may mark a pull request ready
const mayReady = (gate: HookGate) =>
  gate.station === 'release' || REVIEWER_STATIONS.includes(gate.station ?? '')

// claude-factory-0gww.3
export const APPROVE_REASON =
  'The factory denies this command: only a review, security or check station that runs as the ' +
  'reviewer identity may approve a pull request. Here, post a comment review: gh pr review N ' +
  '--comment --body-file f, or --request-changes. This hook also denies a gh call that creates a ' +
  'review with an event it cannot read. Do not retry this command.'

// claude-factory-hoz8
export const GLAB_APPROVE_REASON =
  'The factory denies this command: the factory has no GitLab reviewer identity, so only a person ' +
  'approves a merge request. Post a note instead: glab api --method POST projects/:id/merge_requests/<n>/notes -F body=@<path>. This hook also denies a ' +
  'glab approve call it cannot read. Do not retry this command.'

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

// claude-factory-qn8a.18
export const REPO_SETTING_REASON =
  'The factory denies this command: a gh api write to repository settings, security features, ' +
  'access, secrets or the repository itself is owner-only. Do not retry this command. Report ' +
  'blocked: parked, waiting on: the owner step and the exact command. Issue, pull request, ' +
  'status, check, commit, release and workflow-run writes stay allowed.'

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

// claude-factory-ty8y: the global git config (~/.gitconfig, $XDG_CONFIG_HOME/git/config,
// /etc/gitconfig) can set remote.<n>.push, push.default or an alias that pushes.
export const GLOBAL_GIT_CONFIG_REASON =
  'The factory denies this command: it writes the global git config (~/.gitconfig, ' +
  '$XDG_CONFIG_HOME/git/config or /etc/gitconfig), or it names that path next to a git command. ' +
  'The file can set a push target or an alias that pushes to a protected branch. Do not write ' +
  'the global git config. To read it, use cat, or run the read as its own command. ' +
  'Do not retry this exact command.'

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

// claude-factory-1r7x: zsh runs the text of a glob qualifier e:...: or +name as a command.
export const GLOB_CODE_REASON =
  'The factory denies this command: an unquoted ( ) group glued to a word holds e, +, a $ or a ' +
  'backtick. zsh reads it as a glob qualifier and runs that text as a command for each file. ' +
  'Quote the pattern, or use find. Do not retry this exact command.'

// claude-factory-hewq: bash and zsh decode an unquoted $'...' or $"..." quote, and they decode it
// in different ways. segments() cannot read the real words, so denyAt denies the quote.
export const DOLLAR_QUOTE_REASON =
  'The factory denies this command: it holds an unquoted $\'...\' or $"..." quote. The shell ' +
  'decodes this quote, so this guard cannot read the real command words. Write the words ' +
  'plainly, or use printf or a file. Do not retry this exact command.'

// claude-factory-mozp: in a comment the shell keeps a backslash, so a backslash-newline does not
// join the lines. segments() joins them, so the guard denies the comment line itself.
export const COMMENT_CONTINUATION_REASON =
  'The factory denies this command: a # comment line ends with a backslash and more text follows. ' +
  'In a comment the shell keeps the backslash, so the next line runs as a command that this guard ' +
  'reads as comment words. Remove the backslash, or run the next command in a separate Bash call. ' +
  'Do not retry this exact command.'

// claude-factory-mmc9.14: bash and zsh disagree on a non-ASCII or subscripted assignment prefix.
export const ASSIGNMENT_PREFIX_REASON =
  'The factory denies this command: it starts with an assignment word that bash and zsh read in ' +
  'different ways (a non-ASCII name or a [subscript]). The guard cannot know which command runs. ' +
  'Use an ASCII NAME=value prefix, or set the variable on its own line. Do not retry this exact ' +
  'command.'

// claude-factory-wmsr: a quote, a backtick or a backslash in a comment can hide a later command
// from segments(). It reads the text as words. segments() only flags the hazard. It never changes
// the words it returns.
export const COMMENT_REASON =
  'The factory denies this command: it holds a # whose line has a quote, a backtick or a ' +
  'backslash, and more text follows. The shell can read that text as a comment, so a quote there ' +
  'can hide a later command from this guard. Remove the # text, or run the later commands in a ' +
  'separate Bash call. Do not retry this exact command.'

// claude-factory-wmsr: the same hazard for a here-document body. The shell reads the body as raw
// lines, but this guard reads it as shell text.
export const HEREDOC_REASON =
  'The factory denies this command: it holds a here-document with a quote, a backtick or a ' +
  'backslash, and more text follows it. A quote in the body can hide a later command from this ' +
  "guard. Use a quoted delimiter such as <<'EOF' in a commit message form, run the later " +
  'commands in a separate Bash call, or write the text with the Write tool. Do not retry this ' +
  'exact command. ' +
  SCRATCH_HINT

// claude-factory-06th: bash 5.3 runs the text after `${ ` or `${|` as a command. This guard cannot read it.
export const FUNSUB_REASON =
  'The factory denies this command: it holds ${ followed by a blank or |. bash 5.3 runs the text ' +
  'after it as a command, and this hook cannot read it. To write such text to a file, use the ' +
  'Write tool. Do not retry this exact command.'

// claude-factory-4i60: a function name can hide a git, gh, sh, eval, kubectl or rm word, so the
// guard denies every shell function definition.
export const FUNCTION_DEF_REASON =
  'The factory denies this command: it defines a shell function. A function name can hide a git, ' +
  'gh, sh, eval, kubectl or rm word from this guard, and the guard cannot follow the call. Write ' +
  'the commands plainly. A heredoc write of the function is also denied. Do not retry this ' +
  'exact command. ' +
  SCRATCH_HINT

// claude-factory-upag
export const QUOTED_ASSIGNMENT_REASON =
  'The factory denies this command: a word has a quote or a backslash before its first =. Bash ' +
  'and zsh run such a word as a command. They do not read it as a NAME=value assignment. The ' +
  'guard cannot tell which command runs. Write the assignment with no quote in the name, or call ' +
  'the command by a plain path. Do not retry this exact command.'

// claude-factory-zl5.33
export const XARGS_REASON =
  'The factory denies this command: xargs runs right before a git or gh word. xargs can append ' +
  'its own operand, read from its own stdin, such as a push refspec or a gh verb. This guard ' +
  'checks the text of this command line, so it cannot read that operand before xargs does. ' +
  'Run the git or gh command directly, with every argument in the command line itself. ' +
  'Do not retry this exact command.'

// claude-factory-l43b: a shell word with no -c script reads its script from stdin, a here-string
// or a here-document. The text that feeds it is not in this word list, so this guard cannot read
// the script. xargs before a shell word hides its script in the same way.
export const SHELL_STDIN_REASON =
  'The factory denies this command: a shell word (sh, bash, zsh, dash or a dynamic word) can read ' +
  'its script from a pipe, a redirect or a here-string, or xargs runs a shell. This guard cannot ' +
  'read that script. Run the commands directly, or run a script file with a literal name. ' +
  'Do not retry this exact command. ' +
  SCRATCH_HINT

// claude-factory-3frd: a dollar or backtick word after a literal sh -c cluster.
export const SH_DYNAMIC_SCRIPT_REASON =
  'The factory denies this command: a sh, bash, zsh or dash -c call has a word after -c that holds ' +
  '$ or a backtick. The shell expands it at run time, so the guard cannot read the script. Run the ' +
  'commands directly, with literal words. Do not retry this exact command. ' +
  SCRATCH_HINT

// claude-factory-38jm: reason for a dynamic word in the option slot of a shell call.
export const SH_DYNAMIC_FLAG_REASON =
  'The factory denies this command: a word in the option slot of a sh, bash, zsh or dash call ' +
  'holds a shell expansion ($, a backtick, a glob, a brace or a paren). The shell can expand it ' +
  'to -c and a script that the guard cannot read. Write the shell flags and the script plainly. ' +
  'Do not retry this exact command. ' +
  SCRATCH_HINT

// claude-factory-p43v: a command or subcommand word can hold a dollar sign, a backtick, a glob
// character, a brace, or a leading tilde. The shell has not expanded that word yet. This guard
// reads the typed text. It does not read the shell's own expansion of that text.
//
// A check for one literal verb, such as push, cannot match an unexpanded word. Every check after
// it then reads the wrong verb, or no verb at all.

export const DYNAMIC_VERB_REASON =
  'The factory denies this command: a word at the command or subcommand slot holds a shell ' +
  'expansion ($, a backtick, a glob, a brace, or a leading ~). The shell expands this word at ' +
  'run time, so the guard cannot read the real command. Write the git, gh, kubectl, ko or helm ' +
  'command and subcommand words plainly. Do not retry this exact command.'

/**
 * `gate` carries the context this guard needs for the merge-gate checks (claude-factory-zl5): the
 * running station's name, the rig's protected branch names, and small reads of the live repo and
 * filesystem a unit test can fake out. `main()` wires the real ones; a test passes its own.
 */
export interface HookGate {
  /** claude-factory-abs: the clock denyReason reads for its scan deadline (SCAN_TIME_MS). A test fakes it. Default Date.now. */
  now?: () => number
  /** the running station, from FACTORY_FROM. Only the release station may mark a pull request ready. */
  station?: string
  /** claude-factory-l3tl: the factory name, from FACTORY_DEF_NAME. With `mergeAuthority` and the
   * `release` station it lets `gh pr merge` pass in one strict form (see `mayMerge`). */
  factory?: string
  /** claude-factory-l3tl: the owner/repo that follows `--merge-authority` on this hook's argv. A missing or bad value gives no merge. */
  mergeAuthority?: string
  /** true when FACTORY_GH_REVIEWER is 1 and the station is a reviewer station: only then may a gh call approve a pull request (claude-factory-0gww.3) */
  reviewer?: boolean
  /** branch names a worker never pushes to directly; defaults to main and master when unset or empty */
  protectedBranches?: string[]
  /** This field holds the tool call's own cwd (`i.cwd`). It is not the worktree root.
   * Claude Code keeps one Bash cwd across calls.
   * After an earlier `cd`, the cwd can differ from `root` (claude-factory-3f2z).
   *
   * `main()` sets this field from `i.cwd` alone. It has no fallback to `root`.
   * If the hook input has no cwd, this field stays undefined.
   *
   * `gitReason` resolves a `git push` dir against `gate.cwd ?? root`.
   * So an undefined value falls back to `root` at that call site.
   * `readFile` resolves a `gh api` file argument with a similar fallback.
   * It uses its own `i.cwd || root` expression.
   *
   * `cwdInsideGitDir` (claude-factory-9zd5) reads this field directly.
   * It reads the field through `scanReason`'s R4 check.
   * On undefined, it reports false.
   * It does not know where the command runs.
   * So it denies nothing on that fact alone. */
  cwd?: string
  /** claude-factory-qn8a.21: the dir that holds the running hook's src/ (default: the parent of this file's dir). */
  hookDir?: string
  /** the short branch name `git -C <dir> symbolic-ref --short HEAD` reports, or undefined on any
   * error. `timeoutMs` bounds the git spawn (claude-factory-dts.4). */
  headOf?: (dir?: string, timeoutMs?: number) => string | undefined
  /** the short branch name the repo's `origin/HEAD` points to, or undefined on any error.
   * `timeoutMs` bounds the git spawn (claude-factory-dts.4). */
  originHead?: (timeoutMs?: number) => string | undefined
  /** the text of a small file this guard needs to read (a `gh api graphql` query file), capped and
   * resolved relative to the tool call's own cwd; undefined when it cannot be read */
  readFile?: (path: string) => string | undefined

  /** claude-factory-bemr: a map from a git alias name (lowercase, no `alias.` prefix) to its raw
   * config text. The keys come from `alias.<name>` in `git config --get-regexp ^alias\.`. The
   * hook reads this at the tool call's own cwd, before this run started.
   *
   * The map is empty when that directory sets no alias. It is undefined on a read error.
   *
   * claude-factory-bemr.16: this field reads one directory only: the tool call's own cwd. It
   * takes no `dir` argument.
   *
   * An earlier design folded `-C` words to guess a different directory. That fold had to match
   * git's own parser exactly. Three rounds (bemr.8, bemr.14, bemr.16) each found one more mismatch
   * between the fold and git. `gitReason` now denies outright when a word can move this directory
   * away from cwd. It does not try to compute the new directory. `timeoutMs` bounds the git spawn
   * (claude-factory-dts.4). */
  gitAliases?: (timeoutMs?: number) => Map<string, string> | undefined
  /** claude-factory-bemr: a map from a gh alias name to its raw expansion text, from `gh alias
   * list`. gh ships one alias of its own (`co: pr checkout`), so this is defined even with no
   * user config; undefined only on a read error. `timeoutMs` bounds the gh spawn
   * (claude-factory-dts.4). */
  ghAliases?: (timeoutMs?: number) => Map<string, string> | undefined
  /** claude-factory-1zr5: the shell aliases in the newest Claude Code shell snapshots (see
   * `shellSnapshotAliases`): name to unquoted value, or null for a value the reader cannot unquote.
   * The Bash tool shell expands them, but the hook sees only the alias word. Unset means no alias
   * check. Undefined from the function means a read error: the hook denies every command. */
  shellAliases?: () => Map<string, string | null> | undefined
  /** claude-factory-usqc: the function names in the same snapshots (see `shellSnapshotFunctions`). Unset
   * or undefined means the hook cannot prove an argument word safe, so it scans every word for an alias. */
  shellFunctions?: () => Set<string> | undefined
  /** claude-factory-jluz.1: the 1-based lines of `text` that match the repo's private patterns
   * (`<git common dir>/info/private-patterns`). Undefined: the repo has no such file, nothing to check.
   * `[0]`: the check itself failed. Unset: no check. */
  privateHits?: (text: string) => number[] | undefined
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
 *
 * claude-factory-9zd5: `gitAdminPath` adds a third fact `ScanState` monitors.
 * A shell redirect, or another file tool, can write `.git/HEAD` with no `git` word at all.
 * It can also write a linked worktree's `.git/worktrees/<name>/HEAD`, the linked worktree's own
 * `.git` file, or `.git/config`.
 *
 * `denyAt` calls `namesGitAdminPath` on each segment's raw words. It sets `gitAdminPath` true on
 * a match. `denyReason` denies with `PUSH_REASON` when `headPush` is true and either
 * `branchChange` or `gitAdminPath` is true. This is the same rule as above. It now covers this
 * new, verb-free write path too.
 *
 * claude-factory-ty8y: two more facts, `globalGitConfig` and `gitWord`. A shell redirect, or another
 * file tool, can write the global git config (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`,
 * `/etc/gitconfig`) with no `git` word. That file can set `remote.<n>.push`, `push.default` or an
 * alias that pushes. `globalGitConfigUse` classifies each segment. A `write` (a redirect target, an
 * `of=` target, a glob that can name the file, or an operand of a command that is not a reader)
 * denies at once with `GLOBAL_GIT_CONFIG_REASON`. A git segment and a reader segment skip their
 * operands. A `mention` (a `.config` directory word) sets `globalGitConfig`. `scanReason` denies
 * when `globalGitConfig` is true and `gitWord` is true. `gitWord` comes from the dequoted segment
 * words, so `"gi"t` counts. `hasDangerousConfigEnv` reads it too.
 * Residual, not fixed: a path built from a shell variable (`F=~/.gitconfig; echo x >> $F`), a
 * `.git/config` write alone (claude-factory-cpn), and a directory copy with no path operand (`cp -R /r/acme/dot/. ~/`, `tar -xf x.tar -C ~`).
 * Fix for the whole class: claude-factory-yoib (a push-time read of the effective git config).
 */
interface ScanState {
  /** claude-factory-k8iz: what the other segments of the enclosing scans hold; a nested eval or sh -c scan reads it. */
  outer: OtherSegs
  branchChange: boolean
  headPush: boolean
  gitAdminPath: boolean
  // claude-factory-l43b: true when the raw command holds a pipe, a < character or a coproc word.
  // Then a shell word can read its script from stdin. Set once in scanReason, never reset.
  stdinFed: boolean
  /** claude-factory-l43b: set when a shell reads stdin. denyReason returns SHELL_STDIN_REASON last, so a more specific reason from the same command wins. */
  stdinDeferred: boolean
  /** k8iz: set when the late dollar-word deny fired, so a stdin-shell reason can win over it. */
  ifsLate: boolean
  /** claude-factory-clcc: set when a glob char sits in a command word. denyReason returns DYNAMIC_VERB_REASON after SHELL_STDIN_REASON. */
  globDeferred: boolean
  /** claude-factory-4iod: set when a brace body reads as a risky rm. denyReason returns REASON after the older reasons. */
  bodyDeny: boolean
  cfgGlob: boolean
  /** claude-factory-3frd: set when a word after a sh -c cluster holds a dollar or backtick. scanReason returns SH_DYNAMIC_SCRIPT_REASON last. */
  dynamicScript: boolean
  globalGitConfig: boolean
  /** claude-factory-qn8a.21: a segment can write a hook-control path. scanReason denies it after any more specific reason. */
  hookControl: boolean
  gitWord: boolean
  /** claude-factory-mn2y: set when any segment, at any depth, may define a shell alias. */
  aliasWrite: boolean
  /** claude-factory-usqc: set, for the whole call, when a segment is not a flat command with an external first word. Then `shellAliasReason` scans every word. */
  aliasArgsOff: boolean
  /** claude-factory-mn2y: set when a builtin or unknown command has an expansion argument. A name built from it may write the aliases table. */
  dynArg: boolean
  /** claude-factory-2pdm.16: count of substitution reads that fell back to the rest of the command */
  substFallbacks: number
  /** claude-factory-4iod.11: dequoted words that began with an unquoted `{`. Only these can open a zsh brace group. */
  braceWords: Set<string>
  /** claude-factory-qn8a.21.19: dequoted word -> its forms with each quoted or escaped { } , replaced by a sentinel char. */
  quotedBraces: Map<string, string[]>
  // claude-factory-cbai: the scan work left, in characters read. A scan step subtracts what it
  // reads. Below zero, the scan stops and denies (fail closed).
  work: number
  /** claude-factory-abs: the clock reading after which the scan denies with SCAN_TIME_REASON. Infinity: no deadline. */
  deadline: number
  now: () => number
  /** claude-factory-abs: set when spendWork passed the deadline. scanReason then returns SCAN_TIME_REASON, allow included. */
  timedOut: boolean
  /** claude-factory-c1jb: alias rescans that denyAt already allowed, by their inputs, with the state.outer that the rescan wrote. A repeat of one is skipped and puts that value back. */
  aliasSeen: Map<string, OtherSegs>
}

// Each field here is a budget or the memo. Any other ScanState field goes into the alias memo key.
const MEMO_SKIP = new Set<string>([
  'work',
  'deadline',
  'now',
  'timedOut',
  'substFallbacks',
  'aliasSeen',
  'quotedBraces',
])

// claude-factory-cbai: this reason is for a command whose scan reads more than the work budget.
export const SCAN_BUDGET_REASON =
  'The factory denies this command: the factory cannot check it in the time it has, because the ' +
  'command nests too many wrapper words. Run the inner command directly. Do not retry this exact command.'

// claude-factory-cbai: the default work budget of one scanReason call, in characters read. A
// nested env -S or eval command can make a scan cost 2^n. A hook that passes its 10 s timeout
// lets the command run (fail open). The budget is a fail-closed bound on any such growth.
// Calibration: the largest work of any test in worker-hook.test.ts is 3,600,054 characters (the
// 1.8 MB uncapped scanReason rows). 16,000,000 is more than 4x that. An 8192-character stacked
// env -i eval command spends it in about 0.7 s.
export const MAX_SCAN_WORK = 16_000_000

/** Subtracts n from the work left. Returns true when the budget is spent. */
function spendWork(state: ScanState, n: number): boolean {
  state.work -= n
  // claude-factory-abs: every denyAt level and every alias rescan comes here, so each one checks the clock.
  if (state.deadline !== Infinity && state.now() > state.deadline) {
    state.timedOut = true
    state.work = -1
  }
  return state.work < 0
}

// claude-factory-abs: this reason is for a command whose scan runs past SCAN_TIME_MS (a slow shape or a loaded host).
export const SCAN_TIME_REASON =
  'The factory denies this command: the factory cannot check it in the time it has, because the ' +
  'scan ran too long. Run a simpler command. Do not retry this exact command.'

// claude-factory-abs: the time one denyReason call may scan, in ms from its start. The memoGate spawn budget is
// GATE_BUDGET_MS (6000) and runs inside the scan. The rest of the 10 s PreToolUse timeout covers Bun start and stdin.
export const SCAN_TIME_MS = 7000

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

// wrapper commands whose own name we skip to find the command they run. `noglob` and `nocorrect`
// are zsh precommand modifiers: the next word is the command, and they take no flags
// (claude-factory-563n).
// claude-factory-tyz6: a lone `-` is a zsh precommand modifier. zsh runs the next word as the command.
const WRAPPERS = new Set([
  'sudo',
  'command',
  'builtin',
  'exec',
  'env',
  'nice',
  'nohup',
  'time',
  'noglob',
  'nocorrect',
  '-',
])

/**
 * the lowercase basename of a command word: drops a leading backslash (`\rm`) and any path
 * (`/bin/rm`). It lowercases because macOS APFS is case-insensitive: `Git`, `GH` and `/bin/SH`
 * run the real binaries, so every guard must see them as `git`, `gh` and `sh`. APFS also folds
 * U+017F (long s) to `s`, so the fold goes through upper case: `toLowerCase` alone keeps it.
 */
function baseWordUncached(w: string): string {
  let s = w
  // claude-factory-6sz8: zsh EQUALS expands =X to the path of X in any word position.
  // Read =rm as rm, =\rm as rm and keep ==x as it is.
  if (s.charCodeAt(0) === 92) s = s.slice(1)
  if (s.length > 1 && s.charCodeAt(0) === 61 && s.charCodeAt(1) !== 61) {
    s = s.slice(1)
    if (s.charCodeAt(0) === 92) s = s.slice(1)
  }
  const i = s.lastIndexOf('/')
  const b = i >= 0 ? s.slice(i + 1) : s
  // ASCII fast path: the upper-then-lower fold is slow on huge scans
  return /[^\x00-\x7f]/.test(b) ? b.toUpperCase().toLowerCase() : b.toLowerCase()
}

// claude-factory-4i60.14: a scan reads the same few words many times. The cache key is the exact
// word and the value is the uncached result, so no verdict changes. It clears at the size bound.
const BASE_WORD_CACHE_MAX = 4096
const baseWordCache = new Map<string, string>()
export function baseWord(w: string): string {
  let r = baseWordCache.get(w)
  if (r === undefined) {
    r = baseWordUncached(w)
    if (baseWordCache.size >= BASE_WORD_CACHE_MAX) baseWordCache.clear()
    baseWordCache.set(w, r)
  }
  return r
}
export { baseWordUncached as baseWordForTest }

/** a command substitution found inside a double-quoted span: its body, and the count of segments before it */
interface DqSubstitution {
  body: string
  at: number
}

const MAX_SUBST_NEST = 64

// claude-factory-2pdm.16: each fallback read costs O(n) and scans the rest of the command again.
// Past this many in one top-level call, the command denies with DEEP_COMMAND_REASON.
const MAX_SUBST_FALLBACKS = 8

interface Joined {
  text: string
  toOrig: number[]
  toJoined: number[]
}

/**
 * claude-factory-2pdm: drops each backslash-newline pair (a POSIX line continuation) and keeps the
 * maps between the two index spaces. An escaped pair such as `\\` stays whole. The substitution
 * reader runs on the joined text, so its lookaheads never see a continuation.
 */
function joinContinuations(cmd: string): Joined {
  if (!cmd.includes('\\\n')) {
    const id = Array.from({ length: cmd.length + 1 }, (_, k) => k)
    return { text: cmd, toOrig: id, toJoined: id }
  }
  let text = ''
  const toOrig: number[] = []
  const toJoined: number[] = []
  for (let k = 0; k < cmd.length; k++) {
    if (cmd[k] === '\\' && cmd[k + 1] === '\n') {
      toJoined[k] = text.length
      toJoined[k + 1] = text.length
      k++
      continue
    }
    const n = cmd[k] === '\\' && k + 1 < cmd.length ? 2 : 1
    for (let m = 0; m < n; m++) {
      toJoined[k + m] = text.length
      toOrig.push(k + m)
      text += cmd[k + m]
    }
    k += n - 1
  }
  toJoined[cmd.length] = text.length
  toOrig.push(cmd.length)
  return { text, toOrig, toJoined }
}

/**
 * claude-factory-2pdm: `start` is the index of a `$` or a backtick inside a double-quoted span.
 * Returns the body of the command substitution that starts there, and the index right after its
 * close. Returns undefined when no substitution starts there.
 * Fail closed: when the close is not found, or the body holds a word this matcher cannot read
 * (`case`, `${`), the body is the rest of the command. `end` then points right after the opener,
 * so the caller keeps the double-quote reading of the rest and the quotes stay in step.
 */
function dqSubstitution(
  cmd: string,
  start: number,
): { body: string; end: number; fallback: boolean } | undefined {
  if (cmd[start] === '`') {
    for (let j = start + 1; j < cmd.length; j++) {
      if (cmd[j] === '\\') j++
      else if (cmd[j] === '`') {
        return { body: cmd.slice(start + 1, j).replace(/\\([`\\$"])/g, '$1'), end: j + 1, fallback: false }
      }
    }
    return { body: cmd.slice(start + 1).replace(/\\([`\\$"])/g, '$1'), end: start + 1, fallback: true }
  }
  if (cmd[start] !== '$' || cmd[start + 1] !== '(') return undefined
  const close = parenEnd(cmd, start + 2, 0)
  if (close < 0) return { body: cmd.slice(start + 2), end: start + 2, fallback: true }
  return { body: cmd.slice(start + 2, close), end: close + 1, fallback: false }
}

/**
 * Returns the index of the `)` that closes a `$(` whose body starts at `from`, or -1.
 * It reads single quotes, double quotes (with a nested substitution), `$'..'`, a backslash escape,
 * a backtick span, a word-start comment, a here-document and nested parentheses.
 * It returns -1 for a word it cannot read: `case`, `${`, or a nest deeper than MAX_SUBST_NEST.
 */
function parenEnd(cmd: string, from: number, nest: number): number {
  if (nest > MAX_SUBST_NEST) return -1
  let depth = 1
  const pending: { delim: string; dash: boolean }[] = []
  for (let i = from; i < cmd.length; i++) {
    const c = cmd[i]!
    const prev = cmd[i - 1]
    let slashes = 0
    while (i - 1 - slashes >= from && cmd[i - 1 - slashes] === '\\') slashes++
    const wordStart = i === from || (slashes % 2 === 0 && /[\s;&|()]/.test(prev ?? ''))
    if (c === '\\') {
      i++
    } else if (c === "'") {
      i = cmd.indexOf("'", i + 1)
      if (i < 0) return -1
    } else if (c === '$' && cmd[i + 1] === "'") {
      for (i += 2; i < cmd.length && cmd[i] !== "'"; i++) if (cmd[i] === '\\') i++
      if (i >= cmd.length) return -1
    } else if (c === '$' && cmd[i + 1] === '{') {
      return -1
    } else if (c === '"') {
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\') i++
        else if (cmd[i] === '`') {
          for (i++; i < cmd.length && cmd[i] !== '`'; i++) if (cmd[i] === '\\') i++
        } else if (cmd[i] === '$' && cmd[i + 1] === '(') {
          const e = parenEnd(cmd, i + 2, nest + 1)
          if (e < 0) return -1
          i = e
        }
      }
      if (i >= cmd.length) return -1
    } else if (c === '`') {
      for (i++; i < cmd.length && cmd[i] !== '`'; i++) if (cmd[i] === '\\') i++
      if (i >= cmd.length) return -1
    } else if (c === '#' && wordStart) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++
    } else if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/.exec(cmd.slice(i, i + 300))
      if (!m) return -1
      const after = cmd[i + m[0].length]
      if (after !== undefined && !/[\s;&|<>()]/.test(after)) return -1
      if ((m[2] ?? m[3] ?? m[4] ?? '').includes('\\')) return -1
      pending.push({ delim: m[2] ?? m[3] ?? m[4] ?? '', dash: m[1] === '-' })
      i += m[0].length - 1
    } else if (c === '\n' && pending.length) {
      let at = i + 1
      for (const p of pending) {
        for (;;) {
          if (at > cmd.length) return -1
          const nl = cmd.indexOf('\n', at)
          const line = cmd.slice(at, nl < 0 ? cmd.length : nl)
          at = nl < 0 ? cmd.length + 1 : nl + 1
          const l = p.dash ? line.replace(/^\t+/, '') : line
          if (l === p.delim) break
          if (p.delim !== '' && l.startsWith(p.delim)) return -1
        }
      }
      pending.length = 0
      i = at - 1
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      if (--depth === 0) return i
    } else if (wordStart && c === 'c' && /^case[\s]/.test(cmd.slice(i, i + 5))) {
      return -1
    }
  }
  return -1
}

/**
 * claude-factory-2pdm: a quote char inside a comment or a here-document line is not a quote, but
 * segments() reads it as one and hides the commands after it. This returns the body with each
 * quote char and backtick in a comment, and each quote char in a here-document line, made a space.
 * It never drops comment text: the word-start test can be wrong after a close paren or in a brace.
 * It keeps every newline, and keeps the other here-document text, because a shell can read it.
 * A nested `$(` span inside double quotes stays as it is: scanning that span cleans it again.
 */
function cleanSubstitutionBody(body: string): string {
  let out = ''
  const pending: { delim: string; dash: boolean }[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    let slashes = 0
    while (i - 1 - slashes >= 0 && body[i - 1 - slashes] === '\\') slashes++
    const wordStart = i === 0 || (slashes % 2 === 0 && /[\s;&|()]/.test(body[i - 1]!))
    if (c === '\\') {
      out += body.slice(i, i + 2)
      i++
    } else if (c === "'") {
      const e = body.indexOf("'", i + 1)
      if (e < 0) return out + body.slice(i)
      out += body.slice(i, e + 1)
      i = e
    } else if (c === '$' && body[i + 1] === "'") {
      let e = i + 2
      for (; e < body.length && body[e] !== "'"; e++) if (body[e] === '\\') e++
      out += body.slice(i, e + 1)
      i = e
    } else if (c === '"') {
      let e = i + 1
      for (; e < body.length && body[e] !== '"'; e++) {
        if (body[e] === '\\') e++
        else if (body[e] === '`') {
          for (e++; e < body.length && body[e] !== '`'; e++) if (body[e] === '\\') e++
        } else if (body[e] === '$' && body[e + 1] === '(') {
          const close = parenEnd(body, e + 2, 0)
          if (close < 0) return out + body.slice(i)
          e = close
        }
      }
      out += body.slice(i, e + 1)
      i = e
    } else if (c === '`') {
      let e = i + 1
      for (; e < body.length && body[e] !== '`'; e++) if (body[e] === '\\') e++
      out += body.slice(i, e + 1)
      i = e
    } else if (c === '#' && wordStart) {
      let e = i
      while (e + 1 < body.length && body[e + 1] !== '\n') e++
      out += body.slice(i, e + 1).replace(/['"`]/g, ' ')
      i = e
    } else if (c === '<' && body[i + 1] === '<' && body[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/.exec(body.slice(i, i + 300))
      if (!m) {
        out += c
        continue
      }
      pending.push({ delim: m[2] ?? m[3] ?? m[4] ?? '', dash: m[1] === '-' })
      out += m[0]
      i += m[0].length - 1
    } else if (c === '\n' && pending.length) {
      out += c
      let at = i + 1
      for (const p of pending) {
        while (at <= body.length) {
          const nl = body.indexOf('\n', at)
          const line = body.slice(at, nl < 0 ? body.length : nl)
          const isEnd = (p.dash ? line.replace(/^\t+/, '') : line) === p.delim
          out += isEnd ? line : line.replace(/['"]/g, ' ')
          at = nl < 0 ? body.length + 1 : nl + 1
          if (nl >= 0) out += '\n'
          if (isEnd) break
        }
      }
      pending.length = 0
      i = at - 1
    } else {
      out += c
    }
  }
  return out
}

/**
 * claude-factory-2pdm: true for the body of the usual commit-message form, `cat <<'EOF'`, a quoted
 * delimiter, its lines, the delimiter line, and then only blank space. The shell prints those
 * lines. It runs none of them.
 */
function isCatHeredoc(body: string): boolean {
  const m = /^\s*cat[ \t]+<<(-?)[ \t]*(?:'([^'\s]+)'|"([^"\s]+)"|\\([A-Za-z_]\w*))[ \t]*\n/.exec(body)
  if (!m) return false
  const delim = m[2] ?? m[3] ?? m[4]!
  const lines = body.slice(m[0].length).split('\n')
  for (let k = 0; k < lines.length; k++) {
    const line = m[1] === '-' ? lines[k]!.replace(/^\t+/, '') : lines[k]!
    if (line === delim) return lines.slice(k + 1).every(l => l.trim() === '')
    if (line.startsWith(delim)) return false
  }
  return false
}

/**
 * claude-factory-5hjj: true when the group that opens at `cmd[open]` closes and then nothing
 * follows it but a space, a separator or the end. A command word with such a group has no
 * argument, so it is harmless. Python bodies (`print(len(x))`) take this path.
 */
function groupEndsCommand(cmd: string, open: number): boolean {
  let depth = 0
  let j = open
  for (; j < cmd.length; j++) {
    const c = cmd[j]!
    if (c === '\\') j++
    else if (c === "'") {
      j = cmd.indexOf("'", j + 1)
      if (j < 0) return false
    } else if (c === '"') {
      for (j++; j < cmd.length && cmd[j] !== '"'; j++) if (cmd[j] === '\\') j++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) break
  }
  if (j >= cmd.length) return false
  j++
  while (cmd[j] === ' ' || cmd[j] === '\t') j++
  return j >= cmd.length || ';&|\n)'.includes(cmd[j]!)
}

/** claude-factory-1r7x: the raw text of the group that opens at `cmd[open]`, up to its matching `)`. */
function groupBody(cmd: string, open: number): string {
  let depth = 0
  let j = open
  for (; j < cmd.length; j++) {
    const c = cmd[j]!
    if (c === '\\') j++
    else if (c === "'") {
      j = cmd.indexOf("'", j + 1)
      if (j < 0) return cmd.slice(open + 1)
    } else if (c === '"') {
      for (j++; j < cmd.length && cmd[j] !== '"'; j++) if (cmd[j] === '\\') j++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) break
  }
  return cmd.slice(open + 1, j)
}

/** What segments() reports to its caller. A set flag makes denyAt deny the command. */
type SegInfo = {
  dollarQuote: boolean
  state?: ScanState
  deep?: boolean
  // claude-factory-wmsr: a # that may start a comment holds a quote in its line
  comment?: boolean
  funcDef?: boolean
  // claude-factory-wmsr: a here-document that segments() cannot read with certainty
  heredoc?: boolean
  // claude-factory-5hjj: segments that end in a `(` marker glued to the word before it
  glued?: Set<string[]>
  quotedNames?: Map<string[], number[]>
  // claude-factory-4a4o: an unquoted < or > sits inside a word, after other text (`rm>f`)
  gluedRedir?: boolean
  // claude-factory-1r7x: a glued ( ) group holds e, +, $ or a backtick: a zsh glob qualifier that runs code
  globCode?: boolean
}

const HAZARD_RE = /['"`\\]/
function lastHazard(cmd: string): number {
  for (let k = cmd.length - 1; k >= 0; k--) if (HAZARD_RE.test(cmd[k]!)) return k
  return -1
}
type Hz = { clearTo: number; checks: number; last: number; quoted: [number, number][] }
function prevRaw(cmd: string, i: number): string {
  let k = i - 1
  while (k >= 1 && cmd[k] === '\n' && cmd[k - 1] === '\\') k -= 2
  return k < 0 ? '\n' : cmd[k]!
}
function commentHazard(cmd: string, i: number, hasWord: boolean, info: SegInfo, hz: Hz): void {
  if (info.comment || i < hz.clearTo) return
  if (hasWord && !'{}<>'.includes(prevRaw(cmd, i))) return
  let e = cmd.indexOf('\n', i)
  if (e < 0) e = cmd.length
  const line = cmd.slice(i, e)
  if (HAZARD_RE.test(line) && (line.includes('`') || /\S/.test(cmd.slice(e + 1)))) info.comment = true
  else hz.clearTo = e
}
function heredocHazard(cmd: string, i: number, info: SegInfo, hz: Hz, afterLt: boolean): void {
  if (info.heredoc || afterLt) return
  let j = i + 1
  while (cmd[j] === '\\' && cmd[j + 1] === '\n') j += 2
  if (cmd[j] !== '<') return
  j++
  while (cmd[j] === '\\' && cmd[j + 1] === '\n') j += 2
  if (cmd[j] === '<') return
  // claude-factory-1r7x.8: a newline after an odd run of backslashes is a continuation. The command line goes on.
  let nl = cmd.indexOf('\n', j)
  while (nl > 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(cmd.slice(j, nl))) nl = cmd.indexOf('\n', nl + 1)
  if (nl < 0 || !/\S/.test(cmd.slice(nl + 1))) return
  if (++hz.checks > 32) {
    info.heredoc = true
    return
  }
  const m = /^(-?)[ \t]*(?:'(\w+)'|"(\w+)"|\\(\w+)|(\w+))(?=[ \t;&|<>()\n])/.exec(cmd.slice(j, nl + 1))
  if (!m) {
    info.heredoc = true
    return
  }
  if (hz.last === -2) hz.last = lastHazard(cmd)
  const hazard = hz.last > nl
  const dash = m[1] === '-'
  const quoted = m[5] === undefined
  const delim = m[2] ?? m[3] ?? m[4] ?? m[5]!
  let p = nl + 1
  while (p <= cmd.length) {
    let e = cmd.indexOf('\n', p)
    if (e < 0) e = cmd.length
    const line = cmd.slice(p, e)
    if (line === delim || (dash && line.replace(/^\t+/, '') === delim)) {
      const body = cmd.slice(nl + 1, p)
      if (quoted) hz.quoted.push([nl + 1, p])
      if (hazard && (/\S/.test(cmd.slice(e + 1)) || (!quoted && /\$\(|`|\\\n/.test(body))))
        info.heredoc = true
      return
    }
    // claude-factory-wmsr.37: in a backtick body, a line that starts with the delimiter plus a backtick ends the body early.
    if (hazard && (dash ? line.replace(/^\t+/, '') : line).startsWith(delim)) {
      info.heredoc = true
      return
    }
    p = e + 1
  }
  info.heredoc = true
}

/**
 * Splits a command string into segments (shell words).
 * It splits on &&, ||, ;, |, &, a newline, ( ), $( and a backtick.
 * It keeps a ( and ) marker word for a paren in argument position, such as a zsh glob group or <( and >(.
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
 *
 * claude-factory-p43v: an opening backtick keeps a backtick mark in the word it ends. A closing
 * backtick keeps no mark of its own.
 *
 * When `subs` is set, segments() pushes the body of each command substitution found inside a
 * double-quoted span. The caller must scan each body. The word keeps its raw text.
 *
 * claude-factory-59pp: when an unquoted & comes right before a >, the result holds both readings.
 * The split reading (dash) comes first. The joined reading (bash, zsh) follows it and keeps &> in
 * its own word, so the words after the redirect stay with the command.
 */
const FD_PREFIX_RE = /^(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\})$/
function segments(
  cmd: string,
  info?: SegInfo,
  subs?: DqSubstitution[],
  ampJoin = false,
  cutRedir = false,
): string[][] {
  const segs: string[][] = []
  let sawAmpGt = false
  let cur: string[] = []
  let word = ''
  let hasWord = false
  let joined: Joined | undefined
  let quote: '"' | "'" | null = null
  const parens: boolean[] = []
  // claude-factory-p43v.2: true between an unquoted opening backtick and its closing one.
  let inBacktick = false
  // claude-factory-4iod.11: true when the word began with an unquoted `{`. The set is side data
  // for the brace reading in denyAt. The segments() output does not change.
  let wordBrace = false
  let nameRaw = false
  let sawEq = false
  // claude-factory-qn8a.21.19: indexes of a quoted or escaped { } or , in the word. The shell keeps them as text.
  let quotedBrace: number[] = []
  const qb = (c: string) => {
    if (c === '{' || c === '}' || c === ',') quotedBrace.push(word.length)
  }
  const endWord = () => {
    if (hasWord && quotedBrace.length && info?.state) {
      // UTF-16 units, the unit that qb() counts (a code-point array shifts after an astral char)
      const chars = word.split('')
      for (const k of quotedBrace) if (k < chars.length) chars[k] = BRACE_SENTINEL[chars[k]!] ?? chars[k]!
      const hid = info.state.quotedBraces.get(word)
      const form = chars.join('')
      if (hid) {
        if (!hid.includes(form)) hid.push(form)
      } else info.state.quotedBraces.set(word, [chars.join('')])
    }
    quotedBrace = []
    if (hasWord && nameRaw && word.includes('=') && info?.quotedNames) {
      const m = info.quotedNames.get(cur)
      if (m) m.push(cur.length)
      else info.quotedNames.set(cur, [cur.length])
    }
    if (hasWord) {
      cur.push(word)
      if (wordBrace) info?.state?.braceWords.add(word)
    }
    wordBrace = false
    word = ''
    hasWord = false
    nameRaw = false
    sawEq = false
  }
  const endSeg = () => {
    endWord()
    segs.push(cur)
    cur = []
  }
  let redirPrev = false
  // claude-factory-4i60: true when the last unquoted, unescaped char was $, <, > or =. A line
  // continuation keeps it. It exempts `$()`, `<()`, `>()`, `=()` and `a=()` from funcDef.
  let exemptPrev: boolean = false
  let closePrev = false
  const hz: Hz = { clearTo: -1, checks: 0, last: -2, quoted: [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    const wasExempt: boolean = exemptPrev
    exemptPrev = false
    // claude-factory-1r7x.7: true when the last char closed a group, a substitution or a backtick. A `(` right after it still glues to the word.
    const afterClose: boolean = closePrev
    closePrev = false
    // claude-factory-cu5m.15: true only when the last loop step read an unquoted, unescaped < or >.
    const afterRedir: boolean = redirPrev
    redirPrev = false
    if (quote === "'") {
      if (c === "'") quote = null
      else {
        qb(c)
        word += c
      }
      hasWord = true
      continue
    }
    if (quote === '"') {
      let sub: { body: string; end: number } | undefined
      if ((c === '$' || c === '`') && !info?.deep) {
        joined ??= joinContinuations(cmd)
        const r = dqSubstitution(joined.text, joined.toJoined[i]!)
        if (r) {
          sub = { body: r.body, end: joined.toOrig[r.end]! }
          if (r.fallback && info?.state && ++info.state.substFallbacks > MAX_SUBST_FALLBACKS) {
            info.deep = true
          }
        }
      }
      if (sub) {
        // claude-factory-2pdm: the shell runs a command substitution inside double quotes. The
        // raw text stays in this word, so the dynamic-word checks still see the `$`. The body
        // goes to `subs` for denyAt to scan.
        subs?.push({ body: sub.body, at: segs.length })
        word += cmd.slice(i, sub.end)
        i = sub.end - 1
      } else if (c === '"') quote = null
      // a backslash-newline is a POSIX line continuation even inside double quotes: the shell
      // removes both characters and joins the surrounding text, it does not keep a literal newline.
      else if (c === '\\' && cmd[i + 1] === '\n') i++
      else if (c === '\\' && '"\\$`'.includes(cmd[i + 1] ?? '')) {
        qb(cmd[i + 1]!)
        word += cmd[++i]
      } else {
        qb(c)
        word += c
      }
      hasWord = true
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      if (!sawEq) nameRaw = true
      hasWord = true
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) {
      // a backslash-newline outside quotes is a POSIX line continuation: the shell removes both
      // characters and joins the text around them into one word. It does not end the word and it
      // does not keep a literal newline.
      if (cmd[i + 1] === '\n') {
        // claude-factory-abmq: a continuation is not a char, so `>BSNL&1` stays one redirect.
        redirPrev = afterRedir
        closePrev = afterClose
        i++
        exemptPrev = wasExempt
        continue
      }
      if (!sawEq) nameRaw = true
      qb(cmd[i + 1]!)
      word += cmd[++i]
      hasWord = true
      continue
    }
    if (info && c === '#') commentHazard(cmd, i, hasWord, info, hz)
    if (info && c === '<') heredocHazard(cmd, i, info, hz, afterRedir && prevRaw(cmd, i) === '<')
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
      endSeg()
      i++
      continue
    }
    if (c === '(' || c === ')') {
      // claude-factory-cu5m: in zsh a `(` in argument position starts a glob group, such as
      // `(-)-all`. Keep a marker word, so the push parsers see it. A subshell and `$(`
      // add no marker, and neither does the `)` that closes them. `<(` and `>(` keep one, because a word after them must stay in the push tail.
      const prev = cmd[i - 1] ?? ''
      if (c === '(') {
        // claude-factory-4i60: an empty `()` pair after a word is a function definition.
        if (info && !wasExempt) {
          let j = i + 1
          while (j < cmd.length) {
            if (cmd[j] === ' ' || cmd[j] === '\t' || cmd[j] === '\n') j++
            else if (cmd[j] === '\\' && cmd[j + 1] === '\n') j += 2
            else break
          }
          if (cmd[j] === ')') info.funcDef = true
        }
        if (
          info &&
          (hasWord || afterClose) &&
          !info.globCode &&
          !(wasExempt && '$<>'.includes(prev)) &&
          !(wasExempt && prev === '=' && (word === '=' || cur.every(shellAssignmentWord))) &&
          !(prev === '{' && cmd[i - 2] === '$' && !/(?:^|[^\\])(?:\\\\)*\\$/.test(cmd.slice(0, i - 2))) &&
          !(prev === '[' && /^(?:\$\w+)?\[$/.test(word)) &&
          !hz.quoted.some(([a, b]) => i >= a && i < b) &&
          /[e+$`]/.test(groupBody(cmd, i))
        ) {
          info.globCode = true
        }
        const arg = (hasWord || cur.length > 0) && prev !== '$'
        parens.push(arg)
        if (arg) {
          // claude-factory-5hjj: a glued `(` (`/bin/r(m)`, `/bin/@(r)m`) is a glob group in the
          // word. It is not a function pair, `a=(` or `<(`.
          // A call such as `print(1)` in an interpreter body has nothing after the group, so it passes.
          if (
            info &&
            hasWord &&
            !wasExempt &&
            !info.funcDef &&
            !(prev === '{' && cmd[i - 2] === '$' && !/(?:^|[^\\])(?:\\\\)*\\$/.test(cmd.slice(0, i - 2))) &&
            !(prev === '[' && /^(?:\$\w+)?\[$/.test(word)) &&
            !groupEndsCommand(cmd, i)
          ) {
            ;(info.glued ??= new Set()).add(cur)
          }
          endWord()
          cur.push('(')
        }
      } else if (parens.pop()) {
        endWord()
        cur.push(')')
      }
      if (c === ')') closePrev = true
      endSeg()
      continue
    }
    if ((c === '&' || c === '|') && afterRedir) {
      // claude-factory-cu5m.12: a `&` or `|` right after `<` or `>` is part of a redirect
      // (`>&`, `<&`, `>|`, `>>|`) in zsh, bash and sh. It is not a separator.
      word += c
      redirPrev = c === '&' && cmd[i + 1] === '|'
      hasWord = true
      continue
    }
    // claude-factory-p43v: an opening backtick starts a command substitution. This guard cannot
    // read it, so it ends the segment here. It keeps a backtick mark in the word it ends, so a
    // later scan can see that this word is unsafe. A closing backtick only ends the segment.
    if (c === '`') {
      if (!inBacktick) {
        word += c
        hasWord = true
      }
      inBacktick = !inBacktick
      if (!inBacktick) closePrev = true
      endSeg()
      continue
    }
    if (c === '&') {
      // claude-factory-59pp: bash and zsh read `&>` and `&>>` as one redirect. dash reads a
      // separator and then `>`. The split pass is the dash reading. The ampJoin pass is the bash
      // reading: it starts a new word with the `&`, so the words after the redirect stay with the command.
      let j = i + 1
      while (cmd[j] === '\\' && cmd[j + 1] === '\n') j += 2
      let k = j + 1
      while (cmd[k] === '\\' && cmd[k + 1] === '\n') k += 2
      if (cmd[j] === '!' && cmd[k] !== '(') {
        // claude-factory-qn8a.5: zsh `&!` is one separator (disown). The `!` is not part of the next word.
        endSeg()
        i = j
        continue
      }
      if (cmd[j] === '>') {
        sawAmpGt = true
        if (ampJoin) {
          endWord()
          word = '&'
          hasWord = true
          continue
        }
      }
    }
    if (c === '|' && !quote && />&$/.test(word)) {
      // claude-factory-7xmz.4: zsh reads `>&|` as one redirect. The split pass ends the segment
      // here. The joined pass keeps the `|` in the word, so the words after it stay with the command.
      sawAmpGt = true
      if (ampJoin) {
        word += c
        continue
      }
    }
    if (';|&\n'.includes(c)) {
      endSeg()
      continue
    }
    if (/\s/.test(c)) {
      endWord()
      continue
    }
    // claude-factory-hewq: an unquoted $' or $" starts a quote the shell decodes. Flag it. The word
    // output stays the same, and denyAt denies the whole command.
    // A backslash-newline pair between the $ and the quote drops at lexing, so skip it (hewq.4).
    if (info && c === '$') {
      let j = i + 1
      while (cmd[j] === '\\' && cmd[j + 1] === '\n') j += 2
      if (cmd[j] === "'" || cmd[j] === '"') info.dollarQuote = true
    }
    if (c === '{' && !hasWord) wordBrace = true
    if (c === '=') sawEq = true
    // claude-factory-4a4o: bash and zsh start a redirect at an unquoted < or > inside a word, so
    // `rm>f -rf /` runs rm. The default reading keeps one word. The cut reading ends the word here.
    if ((c === '<' || c === '>') && hasWord && !/[<>]/.test(word) && !FD_PREFIX_RE.test(word)) {
      if (info) info.gluedRedir = true
      if (cutRedir) endWord()
    }
    word += c
    hasWord = true
    redirPrev = c === '<' || c === '>'
    exemptPrev = c === '$' || c === '<' || c === '>' || c === '='
  }
  endSeg()
  const out = segs.filter(s => s.length > 0)
  if (sawAmpGt && !ampJoin)
    out.push(
      ...segments(
        cmd,
        { dollarQuote: false, state: info?.state, deep: info?.deep },
        undefined,
        true,
        cutRedir,
      ),
    )
  return out
}

// claude-factory-4i60: words that can come before a `function` keyword in a command position.
const FUNCTION_PREFIX_WORDS = new Set([
  '{',
  '!',
  'time',
  '-p',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
])

const FUNCTION_TABLE_WORD = /^(dis_)?functions(\[|\+?=|$)/
const FUNCTION_IMPORT_VALUE = /^[^=]*=\(\) \{/

/**
 * claude-factory-4i60: true when this segment defines a shell function with the `function`
 * keyword. The lexer already drops quotes and escapes, so `\function` matches too.
 */
function namesFunctionDefinition(words: string[]): boolean {
  // claude-factory-4i60.15: every check below needs one of these strings in a word
  if (!/function|BASH_FUNC_|=\(\) \{/.test(joinedWords(words))) return false
  let k = 0
  while (k < words.length && FUNCTION_PREFIX_WORDS.has(words[k]!)) k++
  if (words[k] === 'function') return true
  // claude-factory-4i60.5: a command position also follows `{` and the like inside
  // the segment (zsh `repeat 1 {`, `if [[ 1 ]] {`, `} always {`), `repeat <word>`, and `time --`.
  for (let j = 1; j < words.length; j++) {
    if (words[j] !== 'function') continue
    const prev = words[j - 1]!
    if (FUNCTION_PREFIX_WORDS.has(prev) && prev !== '-p' && prev !== 'time') return true
    if (prev === ']]') return true
    if (words[j - 2] === 'repeat') return true
    if (prev === '--' && (words[j - 2] === 'time' || words[j - 2] === '-p')) return true
  }
  // the zsh functions table, a bash BASH_FUNC_ import, and a bash function-import value
  return words.some(
    w => FUNCTION_TABLE_WORD.test(w) || w.includes('BASH_FUNC_') || FUNCTION_IMPORT_VALUE.test(w),
  )
}

/** true when `w` is a short-flag cluster (e.g. `-rf`) or a long flag (`--recursive`) that means recursive */
function recursiveFlag(w: string): boolean {
  if (w === '--recursive' || w.startsWith('--recursive=')) return true
  if (w.startsWith('--')) return false
  if (w.startsWith('-') && w.length > 1) return /[rR]/.test(w.slice(1))
  return false
}

/** A redirect word. Group 1 is the glued target: empty when the target is the next word. */
const RM_REDIRECT_WORD = /^(?:[0-9]*|\{[A-Za-z_][A-Za-z0-9_]*\})(?:&>>?|>>?|<<<|<<-?|<>|<)[|!&]?(.*)$/s

/**
 * `words` is an rm command and its args. `words[start]` is the rm word itself.
 * This function returns true when `words` asks for a recursive delete.
 * It skips redirect words and their targets. It stops at the first `--` word or the first other non-flag word.
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
    if (BRACE_LIST_WORD.test(w)) {
      // claude-factory-gj9l: pieces can join with the text outside the braces ({-,}r). A - with r or R in the word counts.
      if (bracePieceRecursive(w) || (w.includes('-') && /[rR]/.test(w))) return true
      if (!w.startsWith('-')) continue
    }
    if (w.startsWith('-')) {
      if (recursiveFlag(w)) return true
      continue
    }
    // claude-factory-g4l4: the shell takes a redirect word out of the rm args, so flags after it still count.
    const redirect = RM_REDIRECT_WORD.exec(w)
    if (redirect) {
      if (redirect[1] === '') {
        const next = words[k + 1] ?? '-'
        if (next === '--' || !next.startsWith('-')) k++
      }
      continue
    }
    return false
  }
  return false
}

const FIND_EXEC_WORDS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/**
 * claude-factory-j471: true when `cmd`, a find command, runs a recursive rm in an exec slot.
 * A slot word is `-exec`, `-execdir`, `-ok` or `-okdir`. The word after the slot is the head.
 * A NAME=value head is not read here. assignmentReadingsDeny reads it. If the head is rm, `isRecursiveRm` reads it. If the head is a
 * wrapper (sudo, env, nice, timeout, xargs ...), the scan reads every later word once for an rm
 * word. Then it returns, because each later slot is a part of the range that it read.
 *
 * claude-factory-lbn: this function reads `cmd` by index. It does not call `cmd.slice(i + 1)`.
 * `isRecursiveRm(cmd, k)` starts right after the rm word and stops at the first non-flag word.
 * Scans from different slots do not overlap. The wrapper scan runs at most once. So the whole
 * function costs O(n), not O(n^2).
 */
function findExecRmDeny(cmdIn: string[]): boolean {
  const cmd = cmdIn.some(w => /[<>]/.test(w)) ? dropRedirectWords(cmdIn) : cmdIn
  let braceScanned = false
  for (let i = 0; i < cmd.length; i++) {
    if (!FIND_EXEC_WORDS.has(cmd[i]!) && !globActionWord(cmd[i]!)) {
      // gj9l: a brace word can expand to an exec word plus a wrapper. Scan the rest once.
      if (!braceScanned && BRACE_LIST_WORD.test(cmd[i]!)) {
        braceScanned = true
        for (let j = i + 1; j < cmd.length; j++) {
          if (baseWord(cmd[j]!) === 'rm' && isRecursiveRm(cmd, j)) return true
        }
      }
      continue
    }
    const k = i + 1
    if (k >= cmd.length) continue
    const b = baseWord(cmd[k]!)
    if (b === 'rm') {
      if (isRecursiveRm(cmd, k)) return true
      continue
    }
    if (WRAPPERS.has(b) || b === 'timeout' || b === 'xargs') {
      for (let j = k + 1; j < cmd.length; j++) {
        if (baseWord(cmd[j]!) === 'rm' && isRecursiveRm(cmd, j)) return true
      }
      return false
    }
  }
  return false
}

// easj.9: primaries whose next word is a value, so an expansion there is not an action word.
const FIND_VALUE_PRIMARY =
  /^-(name|iname|path|ipath|wholename|iwholename|regex|iregex|lname|ilname|type|xtype|user|group|perm|size|newer|samefile|fstype|printf|fprintf|fprint|fprint0|fls|mindepth|maxdepth|mtime|atime|ctime|mmin|amin|cmin|links|inum|uid|gid|context|newer[a-zA-Z]{2})$/

// easj.9: an expansion can make the word -delete when its literal text is a subsequence of -delete.
function dynamicMayBeDelete(w: string): boolean {
  const lit = w.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\w+|`[^`]*`|["'\\$`]/g, '')
  return hasLettersInOrder('-delete', lit.toLowerCase())
}

function findHasDelete(cmd: string[]): boolean {
  return cmd.some(
    (w, i) =>
      w === '-delete' ||
      (w.startsWith('-') && /[$`]/.test(w)) ||
      (i >= 2 && /[$`]/.test(w) && !FIND_VALUE_PRIMARY.test(cmd[i - 1]!) && dynamicMayBeDelete(w)) ||
      (w.startsWith('-') && BRACE_LIST_WORD.test(w) && hasLettersInOrder(w, '-delete')) ||
      (globActionWord(w) && globMatchesDelete(w)),
  )
}

/**
 * claude-factory-easj: `find -delete` removes every match, like `rm -r`.
 * Returns true when the find command `cmd` has a delete word.
 * It must also have a start path that is dynamic or outside `root`.
 * A delete word is `-delete`, a glob word that can match it, or a brace word with its letters.
 * The rule allows the root itself and a find with no start path. It only denies.
 */
function findDeleteDeny(cmdIn: string[], root?: string): boolean {
  const cmd = cmdIn.some(w => /[<>]/.test(w)) ? dropRedirectWords(cmdIn) : cmdIn
  if (!findHasDelete(cmd)) return false
  if (findDeletePathDeny(cmd, root)) return true
  // qn8a.12: xargs in an exec slot fills a nested find's start path with stdin text. One forward scan: exec, xargs, find.
  const e = cmd.findIndex(w => FIND_EXEC_WORDS.has(w))
  const x = e < 0 ? -1 : cmd.findIndex((w, i) => i > e && baseWord(w) === 'xargs')
  const f = x < 0 ? -1 : cmd.findIndex((w, i) => i > x && baseWord(w) === 'find')
  if (f >= 0 && findHasDelete(cmd.slice(f))) return true
  // easj.15: a find inside an exec slot of this find runs with its own start paths.
  // easj.19: no recursion. This loop visits every exec word, so a nested find needs only the path test.
  for (let k = 1; k < cmd.length - 1; k++) {
    if (!FIND_EXEC_WORDS.has(cmd[k]!)) continue
    const raw = cmd.slice(k + 1)
    const sub0 = realCommand(raw)
    // qn8a.13: a brace list in a wrapper word or the head can expand to find with any start path.
    if (raw.slice(0, raw.length - sub0.length + 1).some(w => BRACE_LIST_WORD.test(w))) return true
    const sub = sub0.some(w => /[<>]/.test(w)) ? dropRedirectWords(sub0) : sub0
    if (sub.length && baseWord(sub[0]!) === 'find' && findHasDelete(sub) && findDeletePathDeny(sub, root))
      return true
  }
  return false
}

// The start-path test of findDeleteDeny for one find command that has a delete word.
function findDeletePathDeny(cmd: string[], root?: string): boolean {
  // easj.4: GNU -files0-from reads the start paths from a file, so the guard cannot read them.
  if (cmd.some(w => w.startsWith('-files0-from'))) return true
  let i = 1
  for (; i < cmd.length; i++) {
    const w = cmd[i]!
    if (w === '--') {
      i++
      break
    }
    // easj.3: BSD find reads -f clustered (-sf) and glued (-f/). The path is the rest of the word or the next word.
    const fm = /^-[HLPEXdsx]*f(.*)$/.exec(w)
    if (fm) {
      const p = fm[1] || cmd[i + 1]
      if (p !== undefined && findPathRisky(p, root)) return true
      if (!fm[1]) i++
      continue
    }
    if (w === '-D') {
      i++
      continue
    }
    if (!/^-([HLPEXdsx]+|O\d+)$/.test(w)) break
  }
  for (; i < cmd.length; i++) {
    const w = cmd[i]!
    if ((w.startsWith('-') && w !== '-') || w === '(' || w === '!') break
    // easj.9: a later word that may expand to -delete starts the expression, not a path.
    // easj.12: break only when this word is the sole delete word; a real delete word keeps the path test.
    if (
      i >= 2 &&
      /[$`]/.test(w) &&
      dynamicMayBeDelete(w) &&
      !findHasDelete(cmd.map((v, j) => (j === i ? 'x' : v)))
    )
      break
    if (findPathRisky(w, root)) return true
  }
  return false
}

// A glob word that can match the file name -delete. A bracket class is read as a wildcard, so it errs toward deny.
function globMatchesDelete(w: string): boolean {
  const re = w.replace(/\[[^\]]*\]|[*?]|[\\^$.+(){}|[\]]/g, m =>
    m === '*' ? '.*' : m[0] === '[' || m === '?' ? '.' : '\\' + m,
  )
  return new RegExp('^' + re + '$').test('-delete')
}

function findPathRisky(t: string, root?: string): boolean {
  if (/[$*?[{`]/.test(t) || t.startsWith('~') || /^=[^=]/.test(t)) return true
  if (root === undefined) return t.startsWith('/') || t.split('/').includes('..')
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  const resolved = resolvePath(base, t)
  return resolved !== base && !resolved.startsWith(base + '/')
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
 * A `$` expansion, a glob char (`*`, `?`, `[`), a brace (`{`, a list that hides a path), a leading `~`, or a leading `=cmd` (zsh expands it to a command path) makes `t` risky.
 * A path that resolves outside `root` also makes `t` risky, when the caller passes `root`.
 * `root` itself counts as outside, so `rm <root>` is risky too.
 * When the caller omits `root`, an absolute path or a path with a `..` segment is risky instead.
 */
function riskyTarget(t: string, root?: string): boolean {
  if (/[$*?[{]/.test(t) || t.startsWith('~') || /^=[^=]/.test(t)) return true
  if (root === undefined) return t.startsWith('/') || t.split('/').includes('..')
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  const resolved = resolvePath(base, t)
  return !resolved.startsWith(base + '/')
}

// claude-factory-p43v.15: a shell reserved word can come right before the real command word.
// realCommand skips each reserved word.
// The p43v.8 and p43v.10 checks then find the real command word behind it.
//
// claude-factory-p43v.19: bash's `coproc NAME? command` starts a background job in the same way.
// realCommand treats coproc as a reserved word too.
// coproc takes no flag of its own. The real command follows it.
//
// claude-factory-fmeu: a brace group `{ cmd; }` runs cmd in the same shell.
// The `{` word is a shell prefix, so realCommand skips it and finds cmd.
// The closing `}` is a separate word. No check acts on it.
const RESERVED_LEADING_WORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  'coproc',
  '{',
])

// claude-factory-p43v.19: this map lists the flags that take a separate value word.
// It covers each wrapper above and `timeout`.
// realCommand must skip that value word too.
//
// If realCommand does not skip the value word, that word becomes `cmd[0]`.
// Then `cmd[0]` is the value word, not the real command.
// A dynamic word after the wrapper's own flags then never reaches the p43v.8 pair check.
//
// Source: each wrapper's own man page.
// sudo takes a value after -u, -g, -C, -D, -h, -p, -U, -r and -t.
// `realCommand` reads sudo through `skipSudoFlags`. `commandAnchors` still uses the sets below.
// env takes a value after -u, -C, -P, -L, -U and -a.
// nice takes a value after -n.
//
// time takes a value after -o and -f.
// exec takes a value after -a.
// timeout takes a value after -s and -k.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t']),
  env: new Set(['-u', '-C', '-P', '-L', '-U', '-a']),
  nice: new Set(['-n']),
  time: new Set(['-o', '-f']),
  exec: new Set(['-a']),
  timeout: new Set(['-s', '-k']),
}

// claude-factory-p43v.19: this map lists each wrapper's own bare flags.
// A bare flag takes no value word.
// `skipWrapperFlags` must know each of these flags by name.
//
// It must not skip every unknown flag.
// `env -S` and `env --split-string` take a value.
// This hook reads that value in `envSplitStringValue`.
// A generic skip would also skip that value word, and can empty `cmd`.
// An empty `cmd` makes `denyAt` skip the whole segment (claude-factory-dts).
// Then `denyAt` would also skip the `env -S` check.
//
// `skipWrapperFlags` skips a flag only when it knows that flag by name for that wrapper.
// It stops at the first flag that it does not know.
// It leaves that flag word, and each word after it, in place.
// This way, a wrapper flag that this hook does not recognize is never silently skipped.
const WRAPPER_BARE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-i']),
  env: new Set(['-i']),
  time: new Set(['-p']),
  exec: new Set(['-c', '-l']),
  command: new Set(['-p']),
}

// claude-factory-aylh: sudo option tables. Source: sudo parse_args.c, sudo_short_opts
// "+Aa:BbC:c:D:Eeg:Hh::iKklNnPp:R:r:SsT:t:U:u:Vv". Each letter below takes a value.
// The other letters (A B b E e H i K k l N n P S s V v) are bare.
const SUDO_SHORT_VALUE_FLAGS = new Set(['a', 'C', 'c', 'D', 'g', 'h', 'p', 'R', 'r', 'T', 't', 'U', 'u'])

// The 31 names of sudo_long_opts. true means required_argument. `preserve-env` takes a value
// only after `=`, so it is false.
const SUDO_LONG_OPTIONS: Record<string, boolean> = {
  'other-user': true,
  'auth-type': true,
  'close-from': true,
  'login-class': true,
  chdir: true,
  group: true,
  host: true,
  prompt: true,
  chroot: true,
  role: true,
  'command-timeout': true,
  type: true,
  user: true,
  background: false,
  edit: false,
  'set-home': false,
  login: false,
  'remove-timestamp': false,
  list: false,
  'preserve-env': false,
  'preserve-groups': false,
  shell: false,
  validate: false,
  askpass: false,
  bell: false,
  help: false,
  'reset-timestamp': false,
  'no-update': false,
  'non-interactive': false,
  stdin: false,
  version: false,
}

/**
 * Skip the options and the NAME=value words that sudo reads before its command.
 * It follows getopt_long: `--` ends the options, a long name can be a unique prefix,
 * and a short cluster such as `-nEu root` ends in a value letter that takes the next word.
 * It reads an unknown option as bare. Real sudo runs nothing after an unknown option,
 * so this cannot hide a command that runs.
 */
function skipSudoFlags(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (w === '--') return words.slice(i + 1)
    if (w[0] !== '-' && w[0] !== '/' && w.indexOf('=') > 0) {
      i++
      continue
    }
    if (w === '-' || w[0] !== '-') break
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq)
      let required = false
      if (eq < 0) {
        if (name in SUDO_LONG_OPTIONS) required = SUDO_LONG_OPTIONS[name]!
        else {
          const hits = Object.keys(SUDO_LONG_OPTIONS).filter(k => k.startsWith(name))
          if (hits.length === 1) required = SUDO_LONG_OPTIONS[hits[0]!]!
        }
      }
      i += required ? 2 : 1
      continue
    }
    let step = 1
    for (let k = 1; k < w.length; k++) {
      if (SUDO_SHORT_VALUE_FLAGS.has(w[k]!)) {
        if (k === w.length - 1) step = 2
        break
      }
    }
    i += step
  }
  return words.slice(i)
}

/**
 * The function skips each flag word after a known wrapper's own name.
 * It handles one word pair at a time.
 * It skips only a flag that this hook knows by name for that wrapper.
 * The known flags appear in `WRAPPER_VALUE_FLAGS` or `WRAPPER_BARE_FLAGS`.
 *
 * A flag in `WRAPPER_VALUE_FLAGS[wrapperName]` also skips the word after it.
 * That word is the value word of the flag.
 * A flag in `WRAPPER_BARE_FLAGS[wrapperName]` skips only itself.
 *
 * The scan stops at the first word that is not a known flag of that wrapper.
 * A bare `-` also stops the scan, because it is not a flag.
 * A `--` word also stops the scan.
 * The scan skips that `--` word first, because it ends the wrapper's own option list.
 */
function skipWrapperFlags(wrapperName: string, words: string[]): string[] {
  if (wrapperName === 'sudo') return skipSudoFlags(words)
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapperName]
  const bareFlags = WRAPPER_BARE_FLAGS[wrapperName]
  let w = words
  while (w.length && w[0] !== '-' && w[0]!.startsWith('-')) {
    const flag = w[0]!
    if (flag === '--') {
      w = w.slice(1)
      break
    }
    if (valueFlags?.has(flag)) {
      w = w.slice(2)
      continue
    }
    if (bareFlags?.has(flag)) {
      w = w.slice(1)
      continue
    }
    break
  }
  return w
}

// claude-factory-p43v.25/.30: true when `w` is a `NAME=value` operand. A wrapper such as `sudo`
// or `env` reads this word as an environment assignment for the command it runs next. It does
// not read this word as that command.
//
// This matches any word with an `=` sign after its first letter. The name before the `=` need
// not be a shell identifier. Proof, run on this host: `env a.b=1 sh -c 'echo x'`,
// `env 1A=x sh -c 'echo x'` and `env -- A=1 sh -c 'echo $A'` each read the word before `sh` as an
// assignment, not as the command (claude-factory-p43v.30).
//
// A word that starts with `-` never matches, even one with an `=` in it, for example an unknown
// `--name=value` flag. `commandAnchors` reads such a word through its own dash-flag branch, in
// place of this one.
function wrapperAssignmentOperand(w: string): boolean {
  return w[0] !== '-' && w.indexOf('=') > 0
}

// claude-factory-5hjj.14: commands that never run an argument.
const GLUED_ARG_SAFE = new Set(
  'ls echo printf cat grep rg head tail wc file stat du diff sort uniq cut tr'.split(' '),
)
/**
 * claude-factory-5hjj: `head` ends with the word that has a glued `(`.
 * The function returns false only if the word is provably an argument. Otherwise it returns true.
 * It returns true unless the head is in the first segment of the whole command (`first`). An
 * earlier segment can change PATH, an alias or a hash.
 * It returns true unless head[0] is a plain literal and every other head word has only plain, glob
 * and flag characters. A `$` or a backtick denies.
 * It returns true if the word is a command anchor.
 * It returns true if head[0] is not in GLUED_ARG_SAFE. This denies a PATH= prefix, env, sudo and
 * an unknown wrapper such as `caffeinate g(i)t`.
 * The function returns false for a glued `(` in a plain argument, for example `ls a(b)`.
 */
function gluedAtCommandSlot(head: string[], first: boolean): boolean {
  const last = head.length - 1
  if (last < 0) return false
  if (!first || !/^[\w./+][\w./+-]*$/.test(head[0]!)) return true
  if (!head.every((x, k) => k === 0 || /^[\w./+=*?@![\]-]+$/.test(x))) return true
  const anchors = commandAnchors(head)
  if (anchors.includes(last)) return true
  if (!GLUED_ARG_SAFE.has(head[0]!.replace(/^\/(usr\/)?bin\//, ''))) return true
  return false
}

// claude-factory-mmc9: true when the shell reads `w` as a prefix assignment, not as the command.
// bash and zsh read `NAME=v` and `NAME+=v` (append). zsh also reads `NAME[sub]=v` and
// `NAME[sub]+=v`. The name must be a literal identifier: a word such as `$G=x` word-splits into
// the real command, so the hook must not skip it. The subscript can hold any text, including `]`
// and quotes. The greedy match can skip more than the shell does. Then the hook reads later words
// as the command and denies more, never less.
// claude-factory-mmc9.8: zsh uses glibc iswalnum for names. That set is wider than letters, so the
// name is any Alphabetic, mark, number or `_`, and not an ASCII digit first. A wider match only
// makes the hook deny more.
const SHELL_NAME = '(?![0-9])[\\p{Alphabetic}\\p{M}\\p{N}_]+'
const ASSIGNMENT_WORD_RE = new RegExp(`^${SHELL_NAME}(?:\\[[\\s\\S]*\\])?\\+?=`, 'u')
const SUBSCRIPT_NAME_RE = new RegExp(`^${SHELL_NAME}\\[`, 'u')
function shellAssignmentWord(w: string): boolean {
  return ASSIGNMENT_WORD_RE.test(w)
}

// claude-factory-mmc9.14: bash reads only an ASCII `NAME=v` or `NAME+=v` as an assignment. A
// non-ASCII name or a subscript is an assignment in zsh and a command in bash. The hook cannot
// know the shell, so it denies such a word at a shell-prefix position when a word follows it.
const STRICT_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
function hasAmbiguousAssignmentPrefix(words: string[]): boolean {
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!
    // claude-factory-mmc9.17: only the unquoted keyword `time` reads NAME=v as an assignment.
    // /usr/bin/time and a quoted time run the word as the command. Deny any such word fail-closed.
    if (baseWord(w) === 'time') {
      const rest = skipWrapperFlags('time', words.slice(i + 1))
      if (rest.length >= 2 && ASSIGNMENT_WORD_RE.test(rest[0]!)) return true
    }
    if (RESERVED_LEADING_WORDS.has(w) || w === 'time') continue
    if (!ASSIGNMENT_WORD_RE.test(w)) return false
    if (!STRICT_ASSIGNMENT_RE.test(w)) return true
  }
  return false
}

/** `words` with any leading VAR=val, wrapper (sudo, env, time...), `timeout <n>` or `xargs [flags]` stripped */
function realCommand(words: string[]): string[] {
  return realCommandInfo(words).cmd
}

// claude-factory-dtr2: zsh runs `repeat N cmd` as `cmd`, N times, in the same segment.
// This walk removes `repeat` and the count word. It reads the rest as the command.
// `dynamicRepeatCount` is true if the count word is dynamic. The caller must deny that case.
// `segments()` can split one quoted `$(...)` count into several words.
// Then the removed word is only a part of the count.
function realCommandInfo(words: string[]): { cmd: string[]; dynamicRepeatCount: boolean } {
  let w = words
  let dynamicRepeatCount = false
  for (;;) {
    if (!w.length) return { cmd: w, dynamicRepeatCount }
    const head = w[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w = w.slice(1)
      continue
    }
    if (RESERVED_LEADING_WORDS.has(head)) {
      w = w.slice(1)
      continue
    }
    const b = baseWord(head)
    if (b === 'repeat') {
      if (w.length > 1 && dynamicWord(w[1]!)) dynamicRepeatCount = true
      w = w.slice(2)
      continue
    }
    if (WRAPPERS.has(b)) {
      w = skipWrapperFlags(b, w.slice(1))
      continue
    }
    if (b === 'timeout') {
      w = skipWrapperFlags('timeout', w.slice(1))
      if (/^[\d.]+[smhd]?$/.test(w[0] ?? '')) w = w.slice(1)
      continue
    }
    if (b === 'xargs') {
      w = w.slice(1)
      while (w.length && w[0]!.startsWith('-')) w = w.slice(1)
      continue
    }
    return { cmd: w, dynamicRepeatCount }
  }
}

// claude-factory-mmc9.25: this function mirrors realCommand, but it returns an index.
function realCommandStart(words: string[], from: number, memo: Map<number, number>): number {
  const seen: number[] = []
  let i = from
  let out = -1
  for (;;) {
    if (i >= words.length) {
      out = words.length
      break
    }
    const m = memo.get(i)
    if (m !== undefined) {
      out = m
      break
    }
    seen.push(i)
    const head = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || RESERVED_LEADING_WORDS.has(head)) {
      i++
      continue
    }
    const b = baseWord(head)
    if (WRAPPERS.has(b)) {
      const after = words.slice(i + 1)
      i = i + 1 + (after.length - skipWrapperFlags(b, after).length)
      continue
    }
    if (b === 'timeout') {
      const after = words.slice(i + 1)
      let j = i + 1 + (after.length - skipWrapperFlags('timeout', after).length)
      if (/^[\d.]+[smhd]?$/.test(words[j] ?? '')) j++
      i = j
      continue
    }
    if (b === 'xargs') {
      i++
      while (i < words.length && words[i]!.startsWith('-')) i++
      continue
    }
    out = i
    break
  }
  for (const k of seen) memo.set(k, out)
  return out
}

// claude-factory-gj9l: deny-only. In a find command, a brace-list word can become the -exec action or the rm word.
// This function does not expand braces.
// (A) The word can be the action when rm with recursive flags follows it.
// (B) The word can hold rm when it has the letters r and m in order.
//     Deny if recursive flags follow it, or if a piece of the word is one.
// The function scans each flag run one time, so the cost is O(n).
function bracePieceRecursive(w: string): boolean {
  return w.split(/[{},]/).some(p => recursiveFlag(p) || p.startsWith('--rec'))
}

function findBraceRmDeny(cmd: string[]): boolean {
  let clearUntil = 0
  const recursive = (j: number): boolean => {
    if (j < clearUntil) return false
    if (isRecursiveRm(cmd, j)) return true
    let k = j + 1
    while (k < cmd.length) {
      const c = cmd[k]!
      const redirect = RM_REDIRECT_WORD.exec(c)
      if (redirect) {
        if (redirect[1] === '') {
          const next = cmd[k + 1] ?? '-'
          if (next === '--' || !next.startsWith('-')) k++
        }
      } else if (!c.startsWith('-') && !BRACE_LIST_WORD.test(c)) break
      k++
    }
    clearUntil = k
    return false
  }
  for (let i = 1; i < cmd.length; i++) {
    const w = cmd[i]!
    const isExec = w === '-exec' || w === '-execdir'
    if (!isExec && !BRACE_LIST_WORD.test(w)) continue
    if (i + 1 < cmd.length && baseWord(cmd[i + 1]!) === 'rm' && recursive(i + 1)) return true
    if (isExec || !hasLettersInOrder(w, 'rm')) continue
    if (recursive(i)) return true
    if (bracePieceRecursive(w)) return true
  }
  return false
}

function rmFindDeny(cmd: string[], root?: string, riskyMemo?: Map<string, boolean>): boolean {
  if (!cmd.length) return false
  const b = baseWord(cmd[0]!)
  if (b === 'rm') {
    return (
      isRecursiveRm(cmd) ||
      rmTargets(cmd).some(t => {
        if (!riskyMemo) return riskyTarget(t, root)
        let r = riskyMemo.get(t)
        if (r === undefined) riskyMemo.set(t, (r = riskyTarget(t, root)))
        return r
      })
    )
  }
  if (b === 'find' && (findBraceRmDeny(cmd) || findExecRmDeny(cmd) || findDeleteDeny(cmd, root))) return true
  return false
}

// claude-factory-mmc9.22: deny-only second readings for every non-dash word with =.
// The word can be the command (bash runs a non-ASCII or path name) or an assignment.
// This check returns true when rm or find -exec rm runs under either reading.
function assignmentReadingsDeny(words: string[], root: string | undefined, state: ScanState): boolean {
  const memo = new Map<number, number>()
  // claude-factory-mmc9.26: read each start index once. Many words with = share one command
  // start. A repeated read costs O(words * targets) and can pass the hook timeout.
  const read = new Map<number, boolean>()
  const riskyMemo = new Map<string, boolean>()
  const denyAt = (s: number): boolean => {
    if (s >= words.length) return false
    let v = read.get(s)
    if (v === undefined) {
      const b = baseWord(words[s]!)
      if (b === 'rm' || b === 'find') {
        // claude-factory-mmc9.27: charge each uncached read. Many starts (a=/rm) cost O(words) each.
        if (spendWork(state, words.length - s)) return true
        v = rmFindDeny(words.slice(s), root, riskyMemo)
      } else v = false
      read.set(s, v)
    }
    return v
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w[0] === '-' || w.indexOf('=') < 0) continue
    if (denyAt(i)) return true
    if (denyAt(realCommandStart(words, i + 1, memo))) return true
  }
  return false
}

/**
 * claude-factory-pwy0: what the other segments of a command hold. A variable set in one segment
 * can put flags or the letters rm into a dynamic command word in another.
 */
type OtherSegs = { flags: boolean; rmfind: boolean; ifs: boolean }
const NO_OTHER_SEGS: OtherSegs = { flags: false, rmfind: false, ifs: false }
const DYN_CHARS = /[$`*?[]/
const DYN_FLAG_TEXT = /(?<![-:])-[A-Za-z]*[rR]|:--[A-Za-z]*[rR]|--rec|-delete|-exec|-ok/
const DYN_FLAG_WORDS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])
// A glob word such as -exe? can match a file named -exec, so find runs it as an action.
const globActionWord = (w: string): boolean => /^[-*?[]/.test(w) && /[*?[]/.test(w)
const findExecWord = (w: string): boolean => w === '-exec' || w === '-execdir' || globActionWord(w)

function hasLettersInOrder(w: string, letters: string): boolean {
  let k = 0
  for (let i = 0; i < w.length && k < letters.length; i++) if (w[i]!.toLowerCase() === letters[k]) k++
  return k === letters.length
}

/**
 * claude-factory-pwy0: one fail-closed rule for a dynamic command word `cmd[start]` (it holds
 * `$`, a backtick or a glob character, and its base word is not rm or find). No model of shell
 * expansion: it denies when the word can run rm or find with flags, or rm on a risky target.
 * A: the word cannot be read (open `${`, `${!`, backtick, `$(`).
 * B: recursive flags follow, the word holds flag text, or a later word is -delete/-exec/-ok.
 * C: another segment holds flag text (a variable there can put flags in the word). Also (k8iz), a
 * word with a dollar or backtick denies late when the text has 2+ segments, its segment starts with
 * a NAME= or NAME+= prefix, or an outer scan had one of these. Accepted false denies:
 * `export EDITOR=vim; $EDITOR f`, `SH=sh; $SH -c 'echo x'`, `export${IFS}PATH=/x; git status`.
 * D: the word may read as rm or find, and a target is risky or a default value holds a path.
 * E (0xw4): a later dynamic word is followed by recursive flags (the head can be env or sudo).
 * F (0xw4): a risky target follows the first later dynamic word.
 * Returns rm: true when D holds but no target is risky, for the cd + rm rule. O(length).
 */
function dynamicHeadDeny(
  cmd: string[],
  start: number,
  root: string | undefined,
  other: OtherSegs,
): { deny: boolean; rm: boolean } {
  const w = cmd[start]!
  // The lexer cuts a word at a zsh flag group `${(L)`; denyAt reads that command again without it.
  const bal = w.endsWith('${') ? w.slice(0, -2) : w
  if (w.includes('`') || w.includes('${!') || bal.split('{').length > bal.split('}').length)
    return { deny: true, rm: false }
  if (isRecursiveRm(cmd, start) || DYN_FLAG_TEXT.test(w) || other.flags || (other.ifs && /[$`]/.test(w)))
    return { deny: true, rm: false }
  if (start === 0) {
    for (let k = 1; k < cmd.length; k++)
      if (DYN_FLAG_WORDS.has(cmd[k]!) || globActionWord(cmd[k]!)) return { deny: true, rm: false }
  }
  // claude-factory-0xw4: the head can expand to env, sudo or command with value flags (-u root),
  // so a later dynamic word can be rm. Deny-only; never sets rm.
  // claude-factory-hevt: segments() cuts a word at a substitution, so a later word that ends in $,
  // holds a backtick, or is ( after < cannot be read: the real target sits in the next segment. Deny.
  for (let k = start + 1; k < cmd.length; k++) {
    const t = cmd[k]!
    if (start > 0 && (t === ';' || t === '+')) break
    if (t.endsWith('$') || t.includes('`') || (t === '(' && cmd[k - 1] === '<'))
      return { deny: true, rm: false }
  }
  let later = 0
  let scanned = -2
  for (let k = start + 1; k < cmd.length; k++) {
    const t = cmd[k]!
    if (start > 0 && (t === ';' || t === '+')) break
    if (!DYN_CHARS.test(t)) continue
    if (!later) later = k
    // Safe skip: isRecursiveRm at the earlier dash word k-1 already reads this word as a flag.
    if (t[0] === '-' && scanned === k - 1) {
      scanned = k
      continue
    }
    scanned = t[0] === '-' ? k : -2
    if (isRecursiveRm(cmd, k)) return { deny: true, rm: false }
  }
  const riskyFrom = (from: number): boolean => {
    let afterDashDash = false
    for (let k = from; k < cmd.length; k++) {
      const t = cmd[k]!
      if (start > 0 && (t === ';' || t === '+')) break
      if (!afterDashDash && t === '--') {
        afterDashDash = true
        continue
      }
      if (!afterDashDash && t.startsWith('-')) continue
      if (riskyTarget(t, root)) return true
    }
    return false
  }
  if (later && riskyFrom(later + 1)) return { deny: true, rm: false }
  if (!(other.rmfind || hasLettersInOrder(w, 'rm') || hasLettersInOrder(w, 'find')))
    return { deny: false, rm: false }
  const dflt = /\$\{[^}:=+-]*:?[-=+]/.exec(w)
  if (dflt) {
    const rest = w.slice(dflt.index + dflt[0].length)
    if (rest.includes('/') || rest.includes('~') || rest.includes('..')) return { deny: true, rm: false }
  }
  if (riskyFrom(start + 1)) return { deny: true, rm: false }
  return { deny: false, rm: true }
}
export { dynamicHeadDeny as dynamicHeadDenyForTest }

/**
 * claude-factory-21ux: true when an rm or find-exec-rm rule denies the command that starts at `cmd[0]`.
 * `rm` is true when `cmd[0]` is an rm word that the rule did not deny.
 */
function rmFindReading(
  cmd: string[],
  root: string | undefined,
  other: OtherSegs = NO_OTHER_SEGS,
): { deny: boolean; rm: boolean } {
  const b = baseWord(cmd[0]!)
  if (b !== 'rm' && b !== 'find' && DYN_CHARS.test(cmd[0]!)) {
    const d = dynamicHeadDeny(cmd, 0, root, other)
    if (d.deny || d.rm) return d
  }
  if (b === 'rm') {
    if (isRecursiveRm(cmd) || rmTargets(cmd).some(t => riskyTarget(t, root))) return { deny: true, rm: false }
    return { deny: false, rm: true }
  }
  if (b === 'find') {
    if (findBraceRmDeny(cmd) || findExecRmDeny(cmd) || findDeleteDeny(cmd, root))
      return { deny: true, rm: false }
    for (let i = 0; i < cmd.length; i++) {
      if (!findExecWord(cmd[i]!) || i + 1 >= cmd.length) continue
      const next = cmd[i + 1]!
      if (DYN_CHARS.test(next) && dynamicHeadDeny(cmd, i + 1, root, other).deny)
        return { deny: true, rm: false }
    }
    if (findHasDelete(cmd)) return { deny: false, rm: true }
  }
  return { deny: false, rm: false }
}

/**
 * claude-factory-21ux: realCommand stops at a wrapper flag that it does not know.
 * In `/usr/bin/time -l rm -rf /`, the command word then looks like `-l`, and rm is hidden.
 * This function walks the same prefix as realCommand.
 * It reads each unknown wrapper flag two ways: as a bare flag (skip one word),
 * and as a flag with a value word (skip two words).
 * It reads the `timeout` duration two ways: one word of any shape, or no word.
 * Each command word that a reading reaches gets the rm and find rule.
 * This function never changes `cmd`, so no operandSkip rule relaxes.
 *
 * It can only add a denial. `rm` is true when a reading reaches an rm word that the rule allows.
 * The caller then sets hasRm, for the cd + rm rule.
 * Each (index, wrapper) state runs once, so the walk has O(n) states.
 */
function wrapperReadingsDeny(
  words: string[],
  root: string | undefined,
  other: OtherSegs = NO_OTHER_SEGS,
): { deny: boolean; rm: boolean } {
  const n = words.length
  const seenHead = new Set<number>()
  const seenFlag = new Set<string>()
  const work: Array<() => void> = []
  let rm = false
  let found = false
  const head = (i: number): void => {
    if (i >= n || seenHead.has(i)) return
    seenHead.add(i)
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || RESERVED_LEADING_WORDS.has(w)) {
      work.push(() => head(i + 1))
      return
    }
    const b = baseWord(w)
    if (WRAPPERS.has(b) || b === 'timeout') {
      work.push(() => flags(b, i + 1))
      return
    }
    if (b === 'xargs') {
      work.push(() => xargsFlags(i + 1))
      return
    }
    const r = rmFindReading(words.slice(i), root, other)
    if (r.deny) found = true
    if (r.rm) rm = true
  }
  // claude-factory-cwt9: the lexer drops a substitution, so `-$(y)` or `-E$(y)` reads as `-` or `-E`.
  // The dropped text can be a command word. A recursive flag and a risky target after the dash
  // word: after a lone dash or a dynamic dash word, any risky operand denies. After a real dash
  // word, a recursive flag and a risky target deny. A plain -r after a real dash word is safe:
  // `xargs -0 -r ls /` is common.
  const dashHidesRm = (j: number): boolean => {
    const nx = words[j + 1]
    if (nx === undefined) return false
    // claude-factory-cwt9.11: a dash word with a dynamic part, or a lone dash, can hide a command
    // word. The literal rm rule denies any risky operand, so deny any risky operand after it.
    // This tests no flag, so a new spelling of a recursive flag cannot get past it.
    if (words[j] === '-' || DYN_CHARS.test(words[j]!)) {
      if (words.slice(j + 1).some(x => !x.startsWith('-') && riskyTarget(x, root))) return true
    }
    if (
      nx !== '-r' &&
      nx !== '-R' &&
      isRecursiveRm(words, j) &&
      rmTargets(words.slice(j)).some(t => riskyTarget(t, root))
    )
      return true
    // A plain -r is recursive only when the first operand is risky.
    // `xargs -0 -r ls /` has the operand `ls`, so it stays allowed.
    if (!/^-[A-Za-z]*[rR]/.test(nx)) return false
    const first = words.slice(j + 1).find(x => !x.startsWith('-'))
    return first !== undefined && riskyTarget(first, root)
  }
  const xargsFlags = (j: number): void => {
    const key = 'xargs:' + j
    if (seenFlag.has(key)) return
    seenFlag.add(key)
    const w = words[j]
    if (w === undefined) return
    if (!w.startsWith('-')) {
      work.push(() => head(j))
      return
    }
    if (DYN_CHARS.test(w)) work.push(() => head(j))
    if (dashHidesRm(j)) found = true
    work.push(() => xargsFlags(j + 1))
    work.push(() => xargsFlags(j + 2))
  }
  const flags = (name: string, j: number): void => {
    const key = name + ':' + j
    if (seenFlag.has(key)) return
    seenFlag.add(key)
    const w = words[j]
    if (w === undefined) return
    if (name === 'command' && /^-[pvV]*[vV][pvV]*$/.test(w)) return
    if (name === 'env' && w === '-') {
      work.push(() => flags(name, j + 1))
      return
    }
    if ((name === 'env' || name === 'sudo') && wrapperAssignmentOperand(w)) {
      work.push(() => flags(name, j + 1))
      return
    }
    if (w.startsWith('-') && dashHidesRm(j)) found = true
    if (w === '-' || !w.startsWith('-')) {
      after(name, j)
      return
    }
    if (w !== '--' && DYN_CHARS.test(w)) work.push(() => head(j))
    if (w === '--') {
      let k = j + 1
      if (name === 'env' && words[k] === '-') k++
      if (name === 'env' || name === 'sudo') while (k < n && wrapperAssignmentOperand(words[k]!)) k++
      after(name, k)
      return
    }
    if (WRAPPER_VALUE_FLAGS[name]?.has(w)) {
      work.push(() => flags(name, j + 2))
      return
    }
    if (WRAPPER_BARE_FLAGS[name]?.has(w)) {
      work.push(() => flags(name, j + 1))
      return
    }
    work.push(() => flags(name, j + 1))
    work.push(() => flags(name, j + 2))
  }
  const after = (name: string, j: number): void => {
    work.push(() => head(j))
    if (name === 'timeout' && j < n && !words[j]!.startsWith('-')) work.push(() => head(j + 1))
  }
  head(0)
  while (work.length && !found) work.pop()!()
  return { deny: found, rm }
}

// claude-factory-p43v.21: This list contains `WRAPPERS`, plus `timeout` and `xargs`.
// `commandAnchors` reads the flags of each wrapper, as `realCommand` does.
// It uses the same `WRAPPER_VALUE_FLAGS` and `WRAPPER_BARE_FLAGS` maps.
// `realCommand` keeps only one index, the index where it stops.
// `commandAnchors` can keep more than one index.
const LEAD_WRAPPERS = new Set([...WRAPPERS, 'timeout', 'xargs'])

// claude-factory-usqc: the reserved words and builtins of bash 5.3 and zsh 5.9, plus LEAD_WRAPPERS.
// Source: bash -c 'compgen -b; compgen -k' and zsh -fc 'print -l ${(k)builtins} ${(k)reswords}'.
// A first word in this set is never a flat external command.
export const SHELL_WORDS = new Set([
  ...'! : [ [[ ]] { } - . alias autoload bg bind bindkey break builtin bye caller case cd chdir command compadd comparguments compcall compctl compdescribe compfiles compgen compgroups complete compopt compquote compset comptags comptry compvalues continue coproc declare dirs disable disown do done echo echotc echoti elif else emulate enable end esac eval exec exit export false fc fg fi float for foreach function functions getln getopts hash help history if in integer jobs kill let limit local log logout mapfile nocorrect noglob popd print printf private pushd pushln pwd r read readarray readonly rehash repeat return sched select set setopt shift shopt source suspend test then time times trap true ttyctl type typeset ulimit umask unalias unfunction unhash unlimit unset unsetopt until vared wait whence where which while zcompile zformat zle zmodload zparseopts zregexparse zstyle'.split(
    ' ',
  ),
  ...LEAD_WRAPPERS,
])

// claude-factory-p43v.21: This limit sets the maximum number of candidate indices.
// `commandAnchors` gives no more indices than this limit.
// Each row that this hook must deny resolves in one of the first candidates.
// For the full rule, read the doc comment of the function.
//
// `MAX_COMMAND_LENGTH` (8192) sets the maximum number of words in the full command.
// This limit adds a second, low-cost safeguard.
// It stops `commandAnchors` before it reads a long list of plain, non-dynamic words, one at a time.
// This occurs if no wrapper flag is unknown to this hook.
const MAX_COMMAND_ANCHORS = 16

/**
 * Gives each index in `words` where the shell can start the actual command.
 *
 * claude-factory-p43v.21: Before this change, `anyDynamicCommandReason` and
 * `anyDynamicLiveApplyReason` read only `realCommand(words)[0]`.
 * These checks use that index as the only index where the actual command starts.
 * `realCommand` stops at a wrapper flag that `skipWrapperFlags` does not know by name.
 * Then it keeps that flag word, or a word after it, at index 0.
 * So the dynamic-word checks read the incorrect word.
 *
 * This function gives a short list of candidate start indices.
 * It replaces the one index.
 * The caller checks each candidate with `words.slice(a)`.
 * The earlier code checked `realCommand(words)` in the same manner.
 *
 * It first skips a `VAR=val` word or a `RESERVED_LEADING_WORDS` word at the start.
 * For example: `do`, `then`, `if`, `coproc` (claude-factory-p43v.15/.19).
 *
 * If the next word is not a known wrapper, that word is the only candidate.
 *
 * If it is a known wrapper (`sudo`, `env`, `nice`, `time`, `exec`, `command`, `builtin`,
 * `nohup`, `timeout`, `xargs`), this function reads the flags of that wrapper.
 *
 * - The function skips each flag that this hook knows for that wrapper.
 *   If the flag has a value, the function also skips the value word.
 *
 * - `timeout` also skips one word that gives the time (`5`, `30s`) after its own flags.
 *
 * - `--` ends the wrapper's own flags. The word after it is the only candidate.
 *   No more checks occur. A literal `--` shows clearly where the actual command starts.
 *
 * - If a word is itself a known wrapper, this function starts the same walk again at that word.
 *   This function checks a nested wrapper (for example `sudo env sh -c ...`) in one step.
 *
 * - For each other flag, this hook does not know the flag by name.
 *   The function skips that flag. The next word can be a value of that flag.
 *   That word is not the actual command.
 *
 * The first plain word that this walk finds is always a candidate.
 * After that, this function adds the next non-flag word as a candidate if one of these
 * conditions applies:
 *
 * - The added word is dynamic (claude-factory-p43v.1).
 *
 * - An unknown flag can have taken an earlier word as its value.
 *
 * This function stops adding candidates if one of these conditions applies:
 *
 * - After it adds a dynamic word, it adds one more word and stops.
 *   The pair check of claude-factory-p43v.8 checks no more words than this.
 *
 * - There are no more words.
 *
 * - The number of candidates becomes equal to `MAX_COMMAND_ANCHORS`.
 */
// claude-factory-p43v.32/p43v.33: `commandAnchors`, below this comment, has two capped exits.
// Both exits call this one function.
//
// The scan reads `words` from `start` onward.
// It looks for the first dynamic pair.
// A dynamic pair is 2 non-flag words, one right after the other, with only flag words in between.
// The function `dynamicCommandWord` must give `true` for the first word.
// The function `dynamicWord` must give `true` for the second word.
//
// The scan skips each flag word.
// The scan skips a flag word even when its value has a `$` or a backtick.
// A flag word is never the real command.
// The scan must not stop on a flag word.
// If a later pair exists, the scan must not accept one dynamic word with no partner.
//
// claude-factory-p43v.33: a real command can hide behind one dynamic word.
// The tail after this word has only literal words.
// One example is a resolved binary from `$(which git)`.
// `segments()` splits this binary into 2 words.
// The split happens at the parentheses.
// A literal `push` word comes after the split.
//
// A second example is `$K apply -f x`.
// In this example, `apply` is a plain word, not a dynamic word.
// The pair rule alone never anchors this single dynamic word.
// Some later checks need only `cmd[0]` to be dynamic.
// These checks never run on the word in this example.
// Two examples of these checks are the bare `$` or backtick check, and the live-apply check.
//
// This scan remembers the first dynamic word.
// The word can have a partner.
// The word can have no partner.
// The scan pushes the word as a fallback index.
// The forward scan must find no pair first.
// A later pair always wins over the fallback.
//
// The padding shape `-R / ... $G $V o main` still gives `$G`/`$V` as a pair.
// An earlier, unrelated dynamic word in the padding never hides this pair.
//
// The scan pushes at most 2 more indices onto `anchors`.
// The scan never pushes more than 2 indices.
// The scan runs in O(n) time.
function scanForFirstDynamicPair(words: string[], start: number, anchors: number[]): void {
  let firstSingle = -1
  for (let m = start; m < words.length; m++) {
    const mw = words[m]!
    if (mw.startsWith('-') && mw !== '-') continue
    if (!dynamicCommandWord(mw, words, m)) continue
    if (firstSingle < 0) firstSingle = m
    let m2 = m + 1
    while (m2 < words.length && words[m2]!.startsWith('-') && words[m2] !== '-') m2++
    if (m2 >= words.length || !dynamicWord(words[m2]!)) continue
    anchors.push(m)
    anchors.push(m2)
    return
  }
  if (firstSingle >= 0) anchors.push(firstSingle)
}

// claude-factory-4iod: zsh opens a brace group at a `{` word inside a segment (`repeat 1 {`,
// `[[ 1 ]] {`, `} always {`). Index 0 is the job of RESERVED_LEADING_WORDS. Each result is the
// words of one brace body. zsh also opens the group when the command word touches the brace
// (`repeat 1 {rm -rf / }`, `repeat 1 {sh}`, `repeat 1 {rm{,} -rf / }`), so an unquoted word that
// starts with `{` opens one too, and its text after the braces is the first body word.
// claude-factory-4iod.11: the only no-space brace words that do not open a group are the words
// made wholly of brace lists (`{a,b}`, `{1..3}`, `{acme,widget}/{src,test}`): brace expansion.
// claude-factory-4iod.12: a word that began inside quotes (`'{print$1}'`) is text and never
// opens a group. segments() records the unquoted ones in ScanState.braceWords.
// This reading only denies: a false match gives a harmless body.
const MAX_BRACE_BODIES = 16
// True when every top-level brace group of `w` closes and holds a top-level comma or `..`.
function isBraceList(w: string): boolean {
  let i = 0
  while (i < w.length) {
    if (w[i] !== '{') {
      i++
      continue
    }
    let depth = 0
    let list = false
    let j = i
    for (; j < w.length; j++) {
      const c = w[j]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) break
      } else if (depth === 1 && (c === ',' || (c === '.' && w[j + 1] === '.'))) list = true
    }
    if (depth !== 0 || !list) return false
    i = j + 1
  }
  return true
}
function braceOpensGroup(w: string, braceWords: Set<string>): boolean {
  if (w === '{') return true
  // `{fd}>f` is a bash and zsh redirect word, not a group.
  if (w === '{}' || !w.startsWith('{') || /\s/.test(w) || /^\{[^{}]*\}[<>]/.test(w)) return false
  return braceWords.has(w) && !isBraceList(w)
}
// The first word of a glued body: the text after the leading braces, less the closing braces
// that match no opening brace in it (`{sh}` gives `sh`).
function braceHead(w: string): string {
  let head = w.replace(/^\{+/, '')
  let depth = 0
  for (const c of head) depth += c === '{' ? 1 : c === '}' ? -1 : 0
  while (depth < 0 && head.endsWith('}')) {
    head = head.slice(0, -1)
    depth++
  }
  return head
}
// zsh reads a glued `{word` as a group only where a command starts: the segment start, after a
// reserved word or `repeat N`, after a wrapper, after `]]` or `} always`, and at the end of a
// `for`, `foreach` or `select` head. In an argument it is a plain word (`echo {a[0]} x`).
function gluedBraceSlots(words: string[]): Set<number> {
  const slots = new Set(commandAnchors(words))
  const loop = words[0] === 'for' || words[0] === 'foreach' || words[0] === 'select'
  const test = words.includes('[[')
  for (let k = 1; k < words.length; k++) {
    const prev = words[k - 1]!
    if (loop || (test && prev === ']]') || (prev === 'always' && words[k - 2] === '}')) slots.add(k)
    else if (RESERVED_LEADING_WORDS.has(words[0]!) && RESERVED_LEADING_WORDS.has(prev)) slots.add(k)
  }
  return slots
}
function braceBodies(words: string[], braceWords: Set<string>): string[][] {
  const out: string[][] = []
  let slots: Set<number> | undefined
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    if (!braceOpensGroup(w, braceWords)) continue
    if (w === '{' ? k === 0 : !(slots ??= gluedBraceSlots(words)).has(k)) continue
    const head = braceHead(w)
    out.push(head ? [head, ...words.slice(k + 1)] : words.slice(k + 1))
  }
  return out
}

/**
 * claude-factory-2a3i: reads the word after each dynamic command word as a possible rm or find.
 * Returns 'deny' for a recursive or risky rm, or a find -exec/-execdir rm. Returns 'rm' for an
 * allowed rm (the caller then applies the rm + cd rule). Returns undefined otherwise.
 * One slice for each anchor. commandAnchors caps the anchors.
 */
function dynamicHeadRmReading(words: string[], root?: string): 'deny' | 'rm' | undefined {
  let result: 'rm' | undefined
  const anchors = commandAnchors(words).slice()
  // A find -exec, -execdir, -ok or -okdir slot is a command slot too. The scan is monotone in the
  // start index, so the smallest dynamic slot gives the result of all of them. No cap needed.
  for (let i = 0; i + 1 < words.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(words[i]!)) continue
    if (!dynamicCommandWord(words[i + 1]!, words, i + 1)) continue
    anchors.push(i + 1)
    break
  }
  for (const a of anchors) {
    const head = words[a]!
    if (!dynamicCommandWord(head, words, a)) continue
    // A `{` or `}` word is a group marker, and realCommand strips it. A `name()` word is a function
    // definition. definesFunction denies it with its own reason.
    if (head === '{' || head === '}' || /^[^$`]*\(\)$/.test(head)) continue
    // The head can expand to a wrapper with value flags or operands (`-u root`, `-n 5`, `5`). So
    // scan forward over every rm word. An rm word can be a flag value, so the real rm can come
    // later. The first rm word gets the full rule. Each later rm word gets the recursive-flag rule.
    // One pass for each anchor: O(n).
    let first = true
    for (let k = a + 1; k < words.length; k++) {
      if (baseWord(words[k]!) !== 'rm') continue
      if (isRecursiveRm(words, k)) return 'deny'
      if (!first) continue
      first = false
      const rest = realCommand(words.slice(k))
      if (!rest.length || baseWord(rest[0]!) !== 'rm') continue
      if (isRecursiveRm(rest) || rmTargets(rest).some(t => riskyTarget(t, root))) return 'deny'
      result = 'rm'
    }
  }
  return result
}

/**
 * claude-factory-qn8a.14: the indices of the command heads in `words`. A redirect word is not a
 * head. This reads the words without redirects first, then the original words, so a quote the
 * tokenizer dropped cannot hide a head. Every index is into `words`. The redirect-free heads come
 * first, so a caller that reads only `[0]` sees the real head.
 */
function commandAnchors(words: string[]): number[] {
  const kept = nonRedirectIndices(words)
  const raw = commandAnchorsOf(words)
  if (kept.length === words.length) return raw
  const out = commandAnchorsOf(kept.map(k => words[k]!)).map(k => kept[k]!)
  // Budget: the merged list never grows past the longer single list. The first raw head can use
  // one extra slot only while the list is under the one-pass cap.
  const limit = Math.max(raw.length, out.length)
  raw.forEach((a, i) => {
    if (out.includes(a)) return
    if (out.length < limit || (i === 0 && out.length < MAX_COMMAND_ANCHORS)) out.push(a)
  })
  return out
}

// claude-factory-qn8a.14: the first head of each reading: without redirects, then the raw words.
// A caller that reads only the first head must treat both as possible.
function firstHeads(words: string[]): number[] {
  const kept = nonRedirectIndices(words)
  const raw = commandAnchorsOf(words)[0]
  if (kept.length === words.length) return raw === undefined ? [] : [raw]
  const k = commandAnchorsOf(kept.map(i => words[i]!))[0]
  const out = k === undefined ? [] : [kept[k]!]
  if (raw !== undefined && !out.includes(raw)) out.push(raw)
  return out
}

export { commandAnchors as commandAnchorsForTest }

function commandAnchorsOf(words: string[]): number[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (shellAssignmentWord(w)) {
      i++
      continue
    }
    if (w === 'coproc') {
      i++
      // claude-factory-p43v.22: `coproc NAME { cmd; }` names the coprocess before the brace
      // group. `NAME` is a plain word, not the real command. Skip it too, when the word after it
      // opens a brace group or a subshell (`{` or `(`). `coproc { cmd; }` has no such name.
      const name = words[i]
      const after = words[i + 1]
      if (name !== undefined && name !== '{' && name !== '(' && (after === '{' || after === '(')) i++
      continue
    }
    if (RESERVED_LEADING_WORDS.has(w)) {
      i++
      continue
    }
    if (baseWord(w) === 'repeat') {
      i += 2
      continue
    }
    break
  }
  if (i >= words.length) return []
  let base = baseWord(words[i]!)
  if (!LEAD_WRAPPERS.has(base)) return [i]

  const anchors: number[] = []
  let j = i + 1
  let mayBeValue = false
  let timeoutDurationPending = base === 'timeout'

  // claude-factory-p43v.32: the outer loop can run more than once. One pass walks a wrapper's own
  // flags and finds `j`, the first candidate after them. If the chase below then finds that the
  // next candidate word is itself a known wrapper (for example `env` in
  // `sudo -Z "$P" env $G $V origin main`), this hook has not yet read that wrapper's own flags.
  // The outer loop runs the flag walk again, with `base` and `j` set to that wrapper, in place of
  // adding the wrapper's own name as a flat, unchecked candidate.
  outer: for (;;) {
    for (;;) {
      if (j >= words.length) return anchors
      const w = words[j]!
      const valueFlags = WRAPPER_VALUE_FLAGS[base]
      const bareFlags = WRAPPER_BARE_FLAGS[base]
      if (w === '--') {
        j++
        // A literal `--` ends the wrapper's own option list. The word right after it is the
        // real command, once this branch skips a `timeout` duration or a `NAME=value` operand.
        // It is never an unknown flag's own value. Clear `mayBeValue` here. An earlier unknown
        // flag, before this `--`, must not make the chase below add a later, non-dynamic word
        // as a candidate too.
        mayBeValue = false
        // claude-factory-p43v.26/.31: `timeout` always takes one duration operand (`5`, `30s`,
        // `1e1`, `inf`), right after its own flags, or right after its own `--`. Skip that word
        // here, whatever shape it has (claude-factory-p43v.31). `timeoutDurationPending` is
        // `false` once this skip runs, so a later numeral word is read as a real argument, not
        // skipped again.
        if (base === 'timeout' && timeoutDurationPending && j < words.length) {
          j++
          timeoutDurationPending = false
        }
        // claude-factory-p43v.30: a `NAME=value` operand (claude-factory-p43v.25) can also
        // follow a wrapper's own `--`. Skip each one here too.
        while (j < words.length && wrapperAssignmentOperand(words[j]!)) j++
        if (j >= words.length) return anchors
        const nb = baseWord(words[j]!)
        if (LEAD_WRAPPERS.has(nb)) {
          base = nb
          j++
          mayBeValue = false
          timeoutDurationPending = nb === 'timeout'
          continue
        }
        break
      }
      if (valueFlags?.has(w)) {
        j += 2
        continue
      }
      if (bareFlags?.has(w)) {
        j += 1
        continue
      }
      // claude-factory-p43v.25/.30: a `NAME=value` word (see `wrapperAssignmentOperand`) can
      // follow a wrapper's own name or flags. `sudo` and `env` both read this form as an
      // environment variable to set for the real command, not as that command. Skip each one;
      // `realCommand` already skips this form before it reads the wrapper's own name.
      if (wrapperAssignmentOperand(w)) {
        j++
        continue
      }
      if (w.startsWith('-') && w !== '-') {
        j++
        mayBeValue = true
        continue
      }
      if (base === 'timeout' && timeoutDurationPending) {
        j++
        timeoutDurationPending = false
        continue
      }
      const nb = baseWord(w)
      if (LEAD_WRAPPERS.has(nb)) {
        base = nb
        j++
        mayBeValue = false
        timeoutDurationPending = nb === 'timeout'
        continue
      }
      break
    }

    anchors.push(j)
    let k = j
    for (;;) {
      // claude-factory-p43v.29: this chase reads a word as if it names the real command (the git
      // or gh binary, or a kubectl/ko/helm tool word). `dynamicCommandWord` reads `{}` as not
      // dynamic here; see the comment above that function.
      const dyn = dynamicCommandWord(words[k]!, words, k)
      if (!dyn && !mayBeValue) break
      let k2 = k + 1
      while (k2 < words.length && words[k2]!.startsWith('-') && words[k2] !== '-') k2++
      if (k2 >= words.length) break
      // claude-factory-p43v.32: `k2` can itself be a known wrapper's own name (see the comment
      // above the outer loop). Restart the flag walk there, in place of adding it as a flat
      // candidate.
      const nb2 = baseWord(words[k2]!)
      if (LEAD_WRAPPERS.has(nb2)) {
        anchors.push(k2)
        // claude-factory-p43v.32: a long run of `-Z v env -Z v env ...` restarts this chase once
        // per repeat. With no cap here, `anchors` grows by 2 for each repeat, with no bound. The
        // caller then re-slices `words` once per anchor. Many such slices, each over the same
        // long `words` array, cost O(n) each, so an unbounded `anchors` array costs O(n^2)
        // overall. Cap it the same way the plain branch below does, with the same scan for one
        // more pair past the cap.
        if (anchors.length >= MAX_COMMAND_ANCHORS) {
          scanForFirstDynamicPair(words, k2 + 1, anchors)
          return anchors
        }
        base = nb2
        j = k2 + 1
        mayBeValue = false
        timeoutDurationPending = nb2 === 'timeout'
        continue outer
      }
      anchors.push(k2)
      // claude-factory-p43v.35: `dyn` alone must not stop the chase here.
      // A true `mayBeValue` can mark word `k` as an unknown flag's own value, not the real
      // command. A flag word between `k` and `k2` can also mark `k2` as a flag's value.
      // This pair is not a true anchor in that case. The chase must go on from `k2`.
      if (dyn && (!mayBeValue || k2 === k + 1)) break
      if (anchors.length >= MAX_COMMAND_ANCHORS) {
        // claude-factory-p43v.27/.32: the loop above stops at a set number of candidates. Many
        // unknown flags in a row can use up that number before the loop finds the actual
        // dynamic word. After the cap, `scanForFirstDynamicPair` finds one more pair, past `k2`.
        scanForFirstDynamicPair(words, k2, anchors)
        return anchors
      }
      k = k2
    }
    return anchors
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
  'Do not pass the bd --actor flag either: it sets the same author. ' +
  'Put text that names the flag in a file (--file, --body-file). ' +
  "bd fills a bead's created_by from this variable, and the flood guard trusts created_by to find a " +
  'sweep-filed bead. Do not retry this command.'

// claude-factory-ab8n: one guard per variable a worker must not change. cmds holds the command words
// that read the variable: bd reads BEADS_ACTOR; FACTORY_FROM and FACTORY_RUN are read by the words in FACTORY_CLI_WORDS.
type EnvGuard = { name: string; cmds: ReadonlySet<string>; reason: string; flag?: string }
// claude-factory-qn8a.27: the CLI is TypeScript, so only the factory launcher or a JS runtime starts it.
// ponytail: a script file under a cleared env (env -i bash x.sh), another interpreter (python3, perl)
// and a runtime copied to another name pass. The sandbox is the barrier. Upgrade: none planned, because the hook is a best-effort guard. Each runtime word also over-denies a harmless env -i run.
const FACTORY_CLI_WORDS: ReadonlySet<string> = new Set([
  'factory',
  'bun',
  'bunx',
  'node',
  'nodejs',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'deno',
  'tsx',
  'ts-node',
])
export const FACTORY_FROM_REASON =
  'The factory denies this command: do not set, clear, export, or re-export FACTORY_FROM. ' +
  'The factory reads the mail sender from this variable, and the owner-only rule trusts mail from the ' +
  'manager. Do not retry this command.'
export const FACTORY_RUN_REASON =
  'The factory denies this command: do not set, clear, export, or re-export FACTORY_RUN. ' +
  'The factory reads the run of this worker from this variable, and it refuses a report or mail for any other run. ' +
  'Do not retry this command.'
const FACTORY_RUN_GUARD: EnvGuard = {
  name: 'FACTORY_RUN',
  cmds: FACTORY_CLI_WORDS,
  reason: FACTORY_RUN_REASON,
}
// claude-factory-qn8a.31: bin/factory unpacks the FACTORY_VM_ENV JSON into its own env and its children's
// env, so a worker that sets it can carry GIT_CONFIG_*, FACTORY_FROM, FACTORY_RUN, HOME or BEADS_ACTOR.
export const FACTORY_VM_ENV_REASON =
  'The factory denies this command: do not set, clear, export, or re-export FACTORY_VM_ENV. ' +
  'The factory unpacks this variable into the environment of every factory command, so it can carry any ' +
  'other variable past the other guards. Do not retry this command.'
const FACTORY_VM_ENV_GUARD: EnvGuard = {
  name: 'FACTORY_VM_ENV',
  cmds: new Set(['factory']),
  reason: FACTORY_VM_ENV_REASON,
}
const BEADS_ACTOR_GUARD: EnvGuard = {
  name: 'BEADS_ACTOR',
  cmds: new Set(['bd']),
  reason: BEADS_ACTOR_REASON,
  flag: 'actor',
}
const FACTORY_FROM_GUARD: EnvGuard = {
  name: 'FACTORY_FROM',
  cmds: FACTORY_CLI_WORDS,
  reason: FACTORY_FROM_REASON,
}

const ENV_IGNORE_ENVIRONMENT_LONG = 'ignore-environment'

// claude-factory-igj: returns true when a bare value word (not a dash word) names BEADS_ACTOR.
// A match is any text that contains the name, which also matches the exact name.
// This match is defensive and fails closed. See BEADS_ACTOR_REASON above.
function valueNamesBeadsActor(v: string | undefined, g: EnvGuard): boolean {
  return v !== undefined && v.includes(g.name)
}

// claude-factory-qn8a.26: true when a word that does not start with `--` can expand to the flag.
// Remove the expansion parts. If the rest starts with `-` and its name is empty or abbreviates
// the flag, deny. If the word held a glob character and the rest abbreviates the flag, deny.
function expandedFlag(w: string, flag: string): boolean {
  if (!/[{}*?[\]`$]/.test(w)) return false
  const rest = w
    .replace(/`[^`]*`/g, '')
    .replace(/\$\([^)]*\)/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$[A-Za-z_0-9@*#?!$-]?/g, '')
    .replace(/[{},*?[\]]/g, '')
  const name = rest.replace(/^-+/, '').split('=')[0]!
  if (rest.startsWith('-')) return name === '' || flag.startsWith(name) || name.startsWith(flag.slice(0, 3))
  return /[*?[]/.test(w) && name.length > 0 && flag.startsWith(name)
}

// claude-factory-qn8a.26: true when a word without a leading `--` can expand to the flag.
// A span ($( ), ${ }, backtick) can print any text, so it becomes a marker.
// Text after the first `=` is a value. A word with whitespace is not a flag.
// Deny a dash run that a marker or `$` follows.
// Else deny when the end of the last bare $NAME plus the text after it is part of `--flag`.
// The name can end at any letter, because dequote removes the quote boundary.
// Accepted false positive: `bd show $repo`.
function dynamicFlag(w: string, flag: string): boolean {
  if (!/[$`]/.test(w)) return false
  const s = w
    .replace(/`[^`]*`/g, '\0')
    .replace(/\$\([^)]*\)\)?/g, '\0')
    .replace(/\$\{[^}]*\}/g, '\0')
    .split('=')[0]!
  if (/\s/.test(s)) return false
  if (/^-+[\0$]/.test(s)) return true
  const m = /(?:\0|\$([A-Za-z_0-9]*))([^\0$]*)$/.exec(s)
  if (!m) return false
  const name = m[1] ?? ''
  for (let i = 0; i <= name.length; i++) {
    const t = name.slice(i) + m[2]!
    if (t !== '' && ('--' + flag).includes(t)) return true
  }
  return false
}

// claude-factory-qn8a.26: true when a word after the bd word is a long flag that abbreviates
// g.flag. bd 1.3.2 refuses a prefix, but a later version can accept it (fail closed). The name
// needs 3 or more characters. Quoting does not change argv, so a quoted or post-`--` word also
// counts. A flag name that holds an expansion ($, backtick, brace, glob) can become the flag, so
// it counts too. The scan starts after the first bd word.
// ponytail: this reads dequoted words. A word that has no literal `--` start and expands to the
// flag (a whole-word variable, `| xargs bd`) is not covered. The upgrade path (a raw-quote rule)
// is claude-factory-qn8a.97.
function hasFlagPrefix(words: string[], from: number, g: EnvGuard): boolean {
  if (!g.flag) return false
  for (let i = from + 1; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith('--')) {
      if (expandedFlag(w, g.flag) || dynamicFlag(w, g.flag)) return true
      continue
    }
    const name = w.slice(2).split('=')[0]!
    if (/[$`{*?[]/.test(name)) return true
  }
  return false
}

// claude-factory-sft4: true for a word that is, or can expand at run time to, sh, bash, zsh or
// dash. A variable, a glob, a brace group or a tilde in this slot hides the shell name, so the
// guard reads the -c script after it. The script is denied only when the script itself is denied.
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash'])
function shellSlotWord(w: string): boolean {
  // claude-factory-jsy0: zsh EQUALS expands a leading =cmd to the command path.
  return SHELL_NAMES.has(baseWord(w)) || /[$`*?[\]{}]/.test(w) || w.startsWith('~') || /^=[^=]/.test(w)
}

// claude-factory-igj: finds the sh/bash/zsh/dash `-c` script word after words[start], the same
// way anyShellReason finds it: the first flag cluster that holds c (or a dynamic word), then the first word after it
// that is not itself a flag, or the word right after a literal --.
function shCScriptValue(words: string[], start: number): string | undefined {
  let nc = start
  while (nc < words.length && words[nc] !== '--' && !possibleShCCluster(words[nc]!)) nc++
  if (nc >= words.length || words[nc] === '--') return undefined
  for (let k = nc + 1; k < words.length; k++) {
    const w = words[k]!
    if (w === '--') return words[k + 1]
    if (w.startsWith('-')) continue
    return w
  }
  return undefined
}

// claude-factory-ibas: the first dynamic head word (X in `$X "rm -rf /"`) can expand to eval or
// sh -c. Then the later words are a script. Returns the script texts to read: the joined words
// (eval) and each later word that holds a space or shell operator (sh -c "$1"). Only the first
// dynamic anchor counts; the joined read recurses into the later ones (cbai).
// claude-factory-qn8a.14: commandAnchors skips redirect words, so a redirect before the head
// does not hide the script.
function dynamicHeadScripts(words: string[]): string[] {
  // A wrapper skips a zsh split word (${=X}) as NAME=value, so it is never an anchor. Add it.
  const splits = words.flatMap((w, i) => (/^"?\$\{?=/.test(w) ? [i] : []))
  for (const a of [...commandAnchors(words), ...splits]) {
    const head = words[a]!
    // A head with a slash ("$ROOT/bin/factory") names a path, so it is not read.
    // ibas.6, .7: drop ${...} groups first; any other unquoted dollar (e$X) makes it dynamic.
    const bare = head.replace(/\$\{[^}]*\}/g, '$V')
    // ibas.9: only a slash after the last close brace is a path; a nested or escaped brace hides none.
    const path = head.slice(head.lastIndexOf('}') + 1).includes('/')
    if (head.startsWith("'") || !bare.includes('$') || path) continue
    const rest = words.slice(a + 1)
    // The tokenizer drops quotes, so a quoted here-string token looks like a here-string. Read the script anyway.
    if (!rest.length) return []
    return [rest.join(' '), ...rest.filter(w => /[\s;&|<>()$`]/.test(w))]
  }
  return []
}

// claude-factory-igj: this checks words from index start to the end of the one segment words.
// It returns true for a bd word there, or for a sh/bash/zsh/dash -c script or an eval word that
// holds a bd word. depth bounds the recursion. MAX_SHELL_DEPTH bounds it the same way, for
// anyShellReason's own eval/sh -c recursion.
//
// claude-factory-igj.8: the scan reads every word after start, not only words[start]. A wrapper
// word (env, nice, nohup, sudo, and so on) can sit between start and the sh/bash/zsh/dash or
// eval word. This scan still finds that later word.
function segmentRunsBdCommand(
  words: string[],
  start: number,
  depth: number,
  state: ScanState,
  g: EnvGuard,
): boolean {
  // claude-factory-cbai: the first eval word's recursion reads every later word of the segment
  // (rest holds them all, later eval words too). A later eval word then needs no recursion of its
  // own. Without this skip, n stacked eval words cost about 2^n work.
  let evalScanned = false
  let slotEnd = 0
  let trapEnd = 0
  for (const t of dynamicHeadScripts(start ? words.slice(start) : words))
    if (stringNamesBdCommand(t, state, g, depth + 1)) return true
  for (let k = start; k < words.length; k++) {
    const bw = baseWord(words[k]!)
    if (g.cmds.has(bw)) return true
    if (shellSlotWord(words[k]!)) {
      // claude-factory-38jm: a dynamic word in the option slot can expand to -c and a bd script.
      // Fail closed. slotEnd keeps the walks O(n), as in anyShellReason.
      if (k >= slotEnd) {
        const walk = shOptionSlotWalk(words, k)
        if (walk.dynamic && SHELL_NAMES.has(bw)) return true
        slotEnd = walk.end
      }
      // A brace list word is denied as a dynamic verb before this scan matters. Reading its script
      // here would change that reason to the BEADS_ACTOR one (claude-factory-38jm AC4).
      const script = BRACE_LIST_WORD.test(words[k]!) ? undefined : shCScriptValue(words, k)
      if (script !== undefined && stringNamesBdCommand(script, state, g, depth + 1)) return true
    } else if (bw === 'trap' && k >= trapEnd) {
      // claude-factory-81tz.2: the trap action and every word after trap are scripts. Read them like eval.
      // claude-factory-81tz.4: trapEnd skips a trap word inside an earlier walk, so the scan stays O(n).
      // claude-factory-81tz.5: read every word to the end, since a redirect word can sit before the action.
      for (let a = k + 1; a < words.length; a++)
        if (stringNamesBdCommand(words[a]!, state, g, depth + 1)) return true
      trapEnd = words.length
    } else if (bw === 'eval' && !evalScanned) {
      evalScanned = true
      const rest = words.slice(k + 1).join(' ')
      if (rest && stringNamesBdCommand(rest, state, g, depth + 1)) return true
    }
  }
  return false
}

// claude-factory-igj: true when a bd word sits anywhere inside s, read as shell words, or
// inside a sh/bash/zsh/dash -c script or an eval word nested in s. depth bounds the recursion
// the same way MAX_SHELL_DEPTH bounds anyShellReason's eval/sh -c recursion.
function stringNamesBdCommand(s: string, state: ScanState, g: EnvGuard, depth = 0): boolean {
  if (depth > MAX_SHELL_DEPTH || spendWork(state, s.length)) return true
  for (const seg of segments(s)) {
    if (segmentRunsBdCommand(seg, 0, depth, state, g)) return true
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
  state: ScanState,
  spanScanned: { done: boolean },
  g: EnvGuard,
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
      // claude-factory-cbai: the first env -S span of a segment recurses on a rebuilt line that
      // holds every later word. Each later env word's span sits in that line with the same
      // prefix, value and suffix, so the recursion reads it there. A later span then needs no
      // recursion of its own. Without this skip, n nested spans cost about 2^n work.
      if (!spanScanned.done) {
        spanScanned.done = true
        const recombined = [
          'env',
          ...words.slice(envIndex + 1, j),
          ...(prefix ? ['-' + prefix] : []),
          ...segments(span.value).flat(),
          ...words.slice(span.end),
        ]
        if (touchesBeadsActor(recombined, state, g, depth + 1)) return true
      }
      j = span.end - 1 // skip the flag and its own value word; it already ran above
      continue
    }
    if (wrapperAssignmentOperand(ew)) continue // a NAME=value assignment: not the command
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
        if (valueNamesBeadsActor(words[j + 1], g)) return true
        j++ // skip this flag's own separate value word
        continue
      }
      if (attached !== undefined && attached.includes(g.name)) return true
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
          if (c !== 'S' && valueNamesBeadsActor(value, g)) return true
          break // the cluster's value, attached or skipped, ends the cluster
        }
      }
      continue
    }
    return { cmdStart: j, clearsAll } // the real command: not an option, not an assignment
  }
  return { cmdStart: words.length, clearsAll }
}

const MENTION_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  'time',
  '{',
  '}',
])
// Commands that run no shell string from their arguments. `git` is ok only for `commit` and `log`.
const MENTION_LITERAL_OK = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'bd', 'factory'])

/**
 * claude-factory-qn8a.25: returns true when the segment mentions the guarded name outside a read-only command.
 * A mention is the name with no [A-Za-z0-9_] after it. It has no left boundary, so `-vNAME` and `MY_NAME` count.
 * `$NAME` and `${NAME}` are reads, not mentions.
 * The command word comes after the leading keywords, one `env` and the `X=y` words.
 * It must be in MENTION_LITERAL_OK, or be `git` with `commit` or `log` as the next word
 * (other git commands and global options can run a shell string). The mention word must not hold any of $ ` ( ) { } [ ] = < >.
 * Every other form denies.
 * ponytail: a name built at run time (`printf -v "$v"`) is not found. The sandbox is the barrier. No upgrade path in a text guard.
 */
function mentionsGuardedName(words: string[], name: string): boolean {
  let ok: boolean | undefined
  for (const w of words) {
    let mention = false
    for (let i = w.indexOf(name); i !== -1; i = w.indexOf(name, i + 1)) {
      if (/[A-Za-z0-9_]/.test(w[i + name.length] ?? '')) continue
      if (w[i - 1] === '$' || (w[i - 1] === '{' && w[i - 2] === '$' && w[i + name.length] === '}')) continue
      mention = true
      break
    }
    if (!mention) continue
    if (/[$`(){}[\]=<>]/.test(w)) return true
    if (ok === undefined) {
      let k = 0
      while (k < words.length && MENTION_KEYWORDS.has(words[k]!)) k++
      if (words[k] === 'env') k++
      while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!)) k++
      const cmd = k < words.length ? baseWord(words[k]!) : ''
      ok =
        MENTION_LITERAL_OK.has(cmd) ||
        (cmd === 'git' && (words[k + 1] === 'commit' || words[k + 1] === 'log'))
    }
    if (!ok) return true
  }
  return false
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
function touchesBeadsActor(words: string[], state: ScanState, g: EnvGuard, depth = 0): boolean {
  if (depth > MAX_SHELL_DEPTH) return true
  let chars = 0
  for (const w of words) chars += w.length + 1
  if (spendWork(state, chars)) return true
  if (mentionsGuardedName(words, g.name)) return true
  const spanScanned = { done: false }
  let envClearsAll = false
  let runsBd = false
  // the index of each bd word
  const bdIdx: number[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const b = baseWord(w)
    if (g.cmds.has(b)) bdIdx.push(i)
    // claude-factory-8pc.27: `env -u BEADS_ACTOR` clears the name for the command that env
    // runs. `env -i` clears every name.
    if (b === 'env') {
      const scan = envOptionScan(words, i, depth, state, spanScanned, g)
      if (scan === true) return true
      if (scan.clearsAll) {
        envClearsAll = true
        const { cmdStart } = scan
        // claude-factory-igj.8: scan every word from cmdStart to the end of this segment, not
        // only words[cmdStart]. A wrapper word (env, nice, nohup, sudo, and so on) can sit
        // between env's own options and the real sh/bash/zsh/dash or eval word.
        if (cmdStart < words.length && segmentRunsBdCommand(words, cmdStart, depth + 1, state, g)) {
          runsBd = true
        }
      }
    }
  }
  if (bdIdx.length > 0 && hasFlagPrefix(words, bdIdx[0]!, g)) return true
  if (!envClearsAll) return false
  if (runsBd) return true
  if (bdIdx.length === 0) return false
  // ponytail: claude-factory-jsoe is a known gap. `env -i grep -rn bd src` denies. A reader exemption was
  // bypassed twice (qn8a.9.13, qn8a.9.14), so a bd word under a clear-all env always denies.
  return true
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
    if (baseWord(words[i]!.replace(/[<>][\s\S]*$/, '')).toLowerCase() !== 'xargs') continue
    for (let j = i + 1; j < words.length; j++) {
      const b = baseWord(words[j]!)
      if (b === 'git' || b === 'gh' || b === 'glab') return true
    }
  }
  return false
}

// claude-factory-l43b: a redirect word starts with an optional fd number, then < or >.
const REDIRECT_WORD = /^(?:\d*|\{[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\})[<>]/
const REDIRECT_OPERATOR = /^(?:\d*|\{[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\})(<<<|<<-?|<|>>?|<>|>\||[<>]&)$/

/** Returns how many leading redirect words (and their targets) `words` has. */
function leadingRedirects(words: string[]): number {
  let i = 0
  while (i < words.length && REDIRECT_WORD.test(words[i]!)) {
    i += REDIRECT_OPERATOR.test(words[i]!) ? 2 : 1
  }
  return Math.min(i, words.length)
}

const SHELL_VALUE_LONG_FLAGS = new Set(['--rcfile', '--init-file'])

const SHELL_SAFE_LONG_FLAGS = new Set([
  '--norc',
  '--noprofile',
  '--posix',
  '--login',
  '--verbose',
  '--restricted',
  '--noediting',
  '--debugger',
])

/**
 * claude-factory-l43b.10/.14: true when a shell operand names stdin. It folds //, ./ and .. so
 * `//dev/stdin` matches. It matches by tail, because the working directory is unknown.
 */
function stdinPathOperand(word: string): boolean {
  const n = posix.normalize(word)
  return /(^|\/)stdin$/.test(n) || /(^|\/)fd\/\d+$/.test(n) || /^\d+$/.test(n)
}

/**
 * claude-factory-l43b.16: true only for a plain script path. Any quote, $, glob, redirect,
 * comment, space or other shell syntax in the word fails the charset, so the guard denies it.
 */
function plainScriptOperand(w: string): boolean {
  return /^[A-Za-z0-9_.\/@+,-]+$/.test(w) && !w.startsWith('-') && !stdinPathOperand(w)
}

/**
 * claude-factory-l43b: true when the shell word at `words[k]` can read its script from stdin.
 * This is a strict parse. It gives false only for a -c script before the operand, or for a plain
 * script path as the first operand. Every other word shape gives true.
 */
function shellReadsStdin(words: string[], k: number): boolean {
  for (let i = k + 1; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') {
      const next = words[i + 1]
      return next === undefined || !plainScriptOperand(next)
    }
    if (isShCCluster(w)) return false
    if (SHELL_VALUE_LONG_FLAGS.has(w)) {
      // claude-factory-l43b.21: bash -i reads the rcfile, so a non-plain value can name stdin.
      i++
      if (!plainScriptOperand(words[i] ?? '')) return true
      continue
    }
    if (SHELL_SAFE_LONG_FLAGS.has(w)) continue
    if (/^[-+][A-Za-z]+$/.test(w)) {
      const flags = w.slice(1)
      if (flags.includes('s')) return true
      for (const _ of flags.match(/[oO]/g) ?? []) {
        i++
        if (!/^[A-Za-z_]+$/.test(words[i] ?? '')) return true
      }
      continue
    }
    return !plainScriptOperand(w)
  }
  return true
}

const SOURCE_WORDS = new Set(['source', '.'])

/**
 * claude-factory-l43b.5: true when `w` names a shell. A redirect can stick to the word
 * (`sh<<<P`, `sh<f`), so this drops everything from the first < or > before it reads the name.
 */
function isShellWord(w: string): boolean {
  return SHELL_NAMES.has(baseWord(w.replace(/[<>][\s\S]*$/, '')).toLowerCase())
}

/**
 * claude-factory-l43b: a shell word with no -c script, in a command that a pipe, a redirect or a
 * coproc can feed. Covers a literal shell word and a dynamic command word. Returns the reason.
 */
function shellStdinReason(words: string[], state: ScanState): string | undefined {
  const own = shellStdinReason1(words, state)
  if (own) return own
  for (const body of braceBodies(words, state.braceWords).slice(0, MAX_BRACE_BODIES)) {
    const r = shellStdinReason1(body, state)
    if (r) return r
  }
  return undefined
}
function shellStdinReason1(words: string[], state: ScanState): string | undefined {
  if (!state.stdinFed) return undefined
  for (let j = 0; j < words.length; j++) {
    if (isShellWord(words[j]!) && shellReadsStdin(words, j)) return SHELL_STDIN_REASON
  }
  const lead = leadingRedirects(words)
  const rest = lead ? words.slice(lead) : words
  for (const a of commandAnchors(rest)) {
    if (dynamicCommandWord(rest[a]!, rest, a) && shellReadsStdin(rest, a)) return SHELL_STDIN_REASON
    // claude-factory-l43b.20: a dynamic anchor can be xargs, so a shell word after it denies.
    if (dynamicCommandWord(rest[a]!, rest, a) && rest.slice(a + 1).some(isShellWord))
      return SHELL_STDIN_REASON
    // claude-factory-l43b.9: `source` and `.` run the file they read like a shell script.
    if (SOURCE_WORDS.has(baseWord(rest[a]!)) && shellReadsStdin(rest, a)) return SHELL_STDIN_REASON
  }
  return undefined
}

const XARGS_REPLACE_FLAG = /^-[^-]*[IiJ]|^--replace(=|$)/

const XARGS_VALUE_FLAGS = new Set([
  '-I',
  '-i',
  '-J',
  '-R',
  '-S',
  '-n',
  '-L',
  '-l',
  '-P',
  '-s',
  '-E',
  '-e',
  '-d',
  '-a',
  '--max-args',
  '--max-procs',
  '--max-lines',
  '--max-chars',
  '--delimiter',
  '--arg-file',
  '--eof',
  '--replace',
])

/**
 * claude-factory-l43b: true when `words` has an `xargs` word with a shell word after it, or a
 * dynamic word in the command slot. `xargs sh -c` takes its script from words that xargs can
 * add from its own stdin, so this guard cannot read the script.
 */
function xargsRunsShell(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (baseWord(words[i]!.replace(/[<>][\s\S]*$/, '')).toLowerCase() !== 'xargs') continue
    const cands: number[] = []
    for (let j = i + 1; j < words.length; j++) {
      if (isShellWord(words[j]!)) return true
    }
    let j = i + 1
    while (j < words.length) {
      const w = words[j]!
      if (w === '--') {
        j++
        continue
      }
      if (!w.startsWith('-') || w === '-') break
      if (XARGS_VALUE_FLAGS.has(w)) {
        j += 2
        continue
      }
      if (j + 1 < words.length && dynamicCommandWord(words[j + 1]!, words, j + 1)) cands.push(j + 1)
      j++
    }
    if (j < words.length && dynamicCommandWord(words[j]!, words, j)) cands.push(j)
    // claude-factory-l43b.16: xargs adds words from its stdin to the shell argv, so any shell
    // word after xargs denies.
    // A dynamic command word with a literal -c script is scanned by anyShellReason. A replace flag
    // or a # word makes that script word unreadable, so those deny.
    const replaced = words.slice(i + 1).some(w => XARGS_REPLACE_FLAG.test(w))
    for (const c of cands) if (replaced || !hasLiteralCScript(words, c)) return true
  }
  return false
}

/** True when a -c cluster after `words[k]` has a plain, non-flag script word after it. */
function hasLiteralCScript(words: string[], k: number): boolean {
  for (let i = k + 1; i < words.length; i++) {
    if (!isShCCluster(words[i]!)) continue
    for (let m = i + 1; m < words.length; m++) {
      if (words[m] === '--') continue
      if (words[m]!.startsWith('-')) continue
      return !dynamicWord(words[m]!) && !words[m]!.startsWith('#')
    }
    return false
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

// claude-factory-9zd5: R1. A word names a `.git` path when it holds a `.git` name as a path
// component, for example `.git`, `.git/HEAD`, `cd .git`, or `/abs/.git/config`.
//
// APFS, the macOS default filesystem, ignores case.
// So `.GIT/head` names the same file as `.git/HEAD`.
//
// The alternation `(^|[^A-Za-z0-9_.-])` matches in 2 cases:
//   - The start of the word.
//   - A character before `.git`, if that character is not a letter, digit, underscore, dot or dash.
// This rule rejects a `.git` suffix after a word character.
// For example, the `widget.git` in a clone URL does not match.
//
// The negative lookahead `(?![A-Za-z0-9_-])` checks the character after `.git`.
// It matches the end of the word.
// It also matches a character that is not a letter, digit, underscore or dash.
// This rule rejects `.gitignore` and `.github`.
// Both continue past `.git` with a letter.
const GIT_NAME_RE = /(^|[^A-Za-z0-9_.-])\.git(?![A-Za-z0-9_-])/i

// claude-factory-9zd5: R3. A word names a git-dir lookup when it holds a name from this list:
//   - `--git-dir`, `--absolute-git-dir`, `--git-path`, `--git-common-dir`
//   - `GIT_DIR`, `GIT_COMMON_DIR`
// The match checks the whole word, not only the start.
// This also catches a name inside a quoted command substitution.
// For example, `"$(git rev-parse --git-path HEAD)"` stays one word in `segments()`.
//
// `GIT_DIR` and `GIT_COMMON_DIR` point git at another repository's directory or files.
// A command can set one of them, then push.
// The push then goes there, with no `--git-dir` flag at all.
//
// This check applies no segment-skip rule.
// A command that only reads a git-dir path triggers a known, accepted false positive.
// For example, `cat "$(git rev-parse --git-dir)/HEAD"; git push` triggers it.
// See the bead's RISK section.
// The worker must make one more Bash call with an explicit refspec.
const GIT_DIR_FLAG_RE = /--git-dir|--absolute-git-dir|--git-path|--git-common-dir|GIT_DIR|GIT_COMMON_DIR/i

// claude-factory-ty8y: a word that names the global git config file. The alternatives are:
// `gitconfig` (`~/.gitconfig`, `/etc/gitconfig`), `git/config` (`$XDG_CONFIG_HOME/git/config`),
// a `.config` directory word (a `cd` into it, then a bare `git/config` or `config` write), and
// `XDG_CONFIG_HOME`. It does not match `vite.config.ts`, `.gitignore`, `widget.git` or `.git/config`.
const GLOBAL_GIT_CONFIG_RE =
  /gitconfig|(^|[^A-Za-z0-9_.-])git\/config(?![A-Za-z0-9_-])|(^|[^A-Za-z0-9_.-])\.config(?=\/|$)|XDG_CONFIG_HOME/i

// claude-factory-ty8y: the alternatives of GLOBAL_GIT_CONFIG_RE that name the file itself, not a
// directory on the way to it. A non-reader command that holds such a word writes, or can write.
const GLOBAL_GIT_CONFIG_FILE_RE =
  /gitconfig|(^|[^A-Za-z0-9_.-])git\/config(?![A-Za-z0-9_-])|(^|[^A-Za-z0-9_.-])\.config(\/git)?\/?["']?$|XDG_CONFIG_HOME/i

// claude-factory-ty8y: paths a glob word is tested against, to find a glob that can name the file.
const GLOBAL_GIT_CONFIG_SAMPLES = [
  '~/.gitconfig',
  '~acme/.gitconfig',
  '$HOME/.gitconfig',
  '${HOME}/.gitconfig',
  '/home/acme/.gitconfig',
  '/Users/acme/.gitconfig',
  '/etc/gitconfig',
  '~/.config/git/config',
  '~/.config/git',
  '~/.config/git/',
  '$XDG_CONFIG_HOME/git/config',
  '${XDG_CONFIG_HOME}/git/config',
]

// claude-factory-ty8y: commands that read their operands. A reader writes only through a redirect.
const READER_COMMANDS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'ls',
  'stat',
  'file',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'diff',
  'cmp',
  'test',
  '[',
  'echo',
  'printf',
  'readlink',
  'realpath',
  'basename',
  'dirname',
])

// claude-factory-ty8y.12: commands whose operands are text (a search word, a title, a comment body).
const TEXT_OPERAND_COMMANDS = new Set(['bd', 'factory', 'gh'])

function globNamesGlobalGitConfig(word: string, state?: ScanState): boolean {
  const w = word.replace(/^["']+|["']+$/g, '')
  if (!/[*?[]/.test(w)) return false
  // claude-factory-ty8y.24, 267o: globCanMatch collapses star runs and fails closed over the star cap.
  return globCanMatch(w, GLOBAL_GIT_CONFIG_SAMPLES, state)
}

type OperandSkip = 'none' | 'reader' | 'operands'

// claude-factory-ty8y.9: a git segment with one of these words can write a path operand: the work
// tree moves, or a clone or worktree creates the path. Such a segment keeps its operands checked.
const GIT_OPERAND_WRITER_RE = /^(--work-tree|--git-dir|-C|GIT_WORK_TREE=|GIT_DIR=|clone$|worktree$)/

// claude-factory-ty8y.12, .18: flags that make a skipped command write their value.
const OUTPUT_FLAG_SOURCE = '--output|-o|-O|-D|--dir|--reporter-outfile'
const OUTPUT_FLAG_RE = new RegExp(`^(${OUTPUT_FLAG_SOURCE})`)
const OUTPUT_FLAG_EXACT_RE = new RegExp(`^(${OUTPUT_FLAG_SOURCE})$`)

// claude-factory-ty8y.14: true when a work tree flag or env word moves the work tree out of `root`.
// A git checkout or restore into another work tree can write the global git config.
// claude-factory-ty8y.19: a `..` segment is bad, also when the path stays under `root`.
// The `..` test runs before the root test. This guard fails closed.
function pathOutsideRoot(raw: string | undefined, root: string | undefined): boolean {
  const v = (raw ?? '').replace(/^["']+|["']+$/g, '')
  if (v === '.') return false
  if (!v || /[~$`\\]|(^|\/)\.\.(\/|$)/.test(v)) return true
  if (root && (v === root || v.startsWith(root + '/'))) return false
  return v.startsWith('/')
}

// claude-factory-lbn: the segment checks below test the same joined text. One cached join keeps a
// 200000-word segment from paying for it once per check. The cache holds the last array only.
let joinedFor: string[] | undefined
let joinedText = ''
function joinedWords(words: string[]): string {
  if (joinedFor !== words) {
    joinedFor = words
    joinedText = words.join('\n')
  }
  return joinedText
}

// `moved` is true when a cd, pushd or popd word ran before this segment (claude-factory-ty8y.20).
const SEGMENT_MAY_TOUCH_RE = /config|xdg|git|worktree|work-tree|[*?[{<>]|(^|\n)-C(\n|$)/i
// claude-factory-93fx: APFS folds case fully (U+FB01 fi, U+00DF ss), but a regex i flag folds simply.
// Fold a non-ASCII text the same way as baseWord before a path regex tests it.
function foldNonAscii(s: string): string {
  return /[^\x00-\x7f]/.test(s) ? s.toUpperCase().toLowerCase() : s
}
// One pass over the joined words. When it fails, none of the four ty8y segment checks can match.
function segmentMayTouchGit(words: string[]): boolean {
  return SEGMENT_MAY_TOUCH_RE.test(foldNonAscii(joinedWords(words)))
}

function gitWorkTreeOutside(words: string[], root: string | undefined, moved = false): boolean {
  if (!/--work-tree|GIT_WORK_TREE=|--git-dir|GIT_DIR=|(^|\n)-C(\n|$)/.test(joinedWords(words))) return false
  const bad = (raw: string | undefined): boolean => pathOutsideRoot(raw, root)
  let hasWorkTree = false
  let hasGitDir = false
  let badC = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const c = w.charCodeAt(0)
    if (c !== 45 && c !== 71) continue
    if (w === '--work-tree') {
      hasWorkTree = true
      if (bad(words[i + 1])) return true
    } else if (w.startsWith('--work-tree=')) {
      hasWorkTree = true
      if (bad(w.slice(12))) return true
    } else if (w.startsWith('GIT_WORK_TREE=')) {
      hasWorkTree = true
      if (bad(w.slice(14))) return true
    } else if (w === '--git-dir' || w.startsWith('--git-dir=') || w.startsWith('GIT_DIR=')) {
      hasGitDir = true
    } else if (w === '-C' && bad(words[i + 1])) {
      badC = true
    }
  }
  // claude-factory-ty8y.20: a git dir with no work tree makes the cwd the work tree.
  return hasGitDir && !hasWorkTree && (moved || badC)
}

// claude-factory-ty8y.21: a git config write of core.worktree, or any `-c core.worktree=`, moves the
// work tree. A value outside `root` denies. A read form has no value word, so it allows.
function gitCoreWorktreeOutside(words: string[], root: string | undefined): boolean {
  if (!/core\.worktree|(^|\n)config(\n|$)/i.test(joinedWords(words))) return false
  if (words.some(w => w.length > 13 && /^(-c|--config-env)?core\.worktree=/i.test(w))) return true
  const at = words.indexOf('config')
  if (at < 0) return false
  if (!words.some(w => baseWord(w) === 'git')) return false
  const operands: string[] = []
  const args = words.slice(at + 1)
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (w.startsWith('-') && w !== '-') {
      if (!w.includes('=') && gitConfigTakesValue(w)) i++
      continue
    }
    operands.push(w)
  }
  const start = operands[0] === 'set' ? 1 : 0
  const name = (operands[start] ?? '').replace(/^["']+|["']+$/g, '')
  if (!/^core\.worktree$/i.test(name)) return false
  const value = operands[start + 1]
  return value !== undefined && pathOutsideRoot(value, root)
}

// claude-factory-ty8y.17: collapses `//`, `/./` and a trailing `/.` so a path spelling cannot dodge the regexes.
function normalizeConfigPath(word: string): string {
  return word
    .replace(/\/+/g, '/')
    .replace(/\/(\.\/)+/g, '/')
    .replace(/\/\.(["']?)$/, '$1')
}

const PLAIN_WORD_RE = /^[^\/.*?[{~$\\'"<>&|]*$/

/**
 * claude-factory-ty8y: classifies one segment's raw words.
 * `write`: a redirect target, a `dd` `of=` target, or an operand of a command that is not a reader
 * names the global git config file, the `.config` directory, or a glob that can name the file.
 * `mention`: a word names a directory on the way to it (`.config`), or the file where the
 * segment skips operands.
 *
 * A git segment and a reader segment skip their non-redirect operands. They only name a path.
 * A skipped command still checks the value of an output flag, because it writes that value.
 */
function globalGitConfigUse(
  words: string[],
  skip: OperandSkip,
  isCd = false,
  state?: ScanState,
): 'write' | 'mention' | undefined {
  // Whole-segment fast path (claude-factory-lbn scan cost). A word can name the file only through
  // the text config or XDG, a glob character, a brace, or a redirect operator.
  if (!/config|XDG|[*?[{<>]/i.test(foldNonAscii(joinedWords(words)))) return undefined
  let use: 'mention' | undefined
  let pending = false
  let prevWriterFlag = false
  for (const word of words) {
    const afterWriterFlag = prevWriterFlag
    prevWriterFlag = skip === 'operands' && OUTPUT_FLAG_EXACT_RE.test(word)
    const wasPending = pending
    pending = false
    // Fast path (claude-factory-lbn scan cost): a plain word holds no path or glob character, so no
    // regex below can match it, unless it is a redirect, an of= word, or names gitconfig or XDG.
    if (
      !wasPending &&
      PLAIN_WORD_RE.test(word) &&
      !/^of=|gitconfig|XDG_CONFIG_HOME/i.test(foldNonAscii(word))
    )
      continue
    let candidate = normalizeConfigPath(word)
    let redirect = wasPending
    const m = word.match(REDIRECT_PREFIX_RE)
    if (m && m[0].length === word.length) {
      pending = true
      continue
    }
    if (m) {
      candidate = normalizeConfigPath(word.slice(m[0].length))
      redirect = true
    } else if (!wasPending && /^of=/i.test(word)) {
      candidate = normalizeConfigPath(word.slice(3))
      redirect = true
    }
    if (!redirect) {
      if (skip === 'reader') continue
      if (skip === 'operands' && !afterWriterFlag && !OUTPUT_FLAG_RE.test(word)) continue
    }
    candidate = foldNonAscii(candidate)
    if (isCd && !redirect) {
      if (GLOBAL_GIT_CONFIG_RE.test(candidate)) use = 'mention'
      continue
    }
    if (GLOBAL_GIT_CONFIG_FILE_RE.test(candidate) || globNamesGlobalGitConfig(candidate, state))
      return 'write'
    if (GLOBAL_GIT_CONFIG_RE.test(candidate)) use = 'mention'
  }
  return use
}

// the protected files as globs: rigs.json and one worker-settings file per rig (and per skills set)
const FACTORY_CONFIG_GLOBS = ['rigs.json', 'worker-settings*.json', 'inbox.jsonl', 'state.json']

type GlobTok = { star: true } | { star: false; test: (c: string) => boolean; lit?: string }

// End index of the bracket class that opens at g[i]. odd: bash reads it (a leading ], [:x:], [=x=], [.x.]) in a way a JS class cannot.
function classEnd(g: string, i: number): { j: number; odd: boolean } | undefined {
  let k = i + 1
  if (g[k] === '!' || g[k] === '^') k++
  let odd = false
  if (g[k] === ']') {
    odd = true
    k++
  }
  for (; k < g.length; k++) {
    if (g[k] === '[' && /[:=.]/.test(g[k + 1] ?? '')) {
      const e = g.indexOf(g[k + 1]! + ']', k + 2)
      odd = true
      if (e >= 0) k = e + 1
    } else if (g[k] === ']') return { j: k, odd }
  }
  return undefined
}

function globToks(g: string): GlobTok[] {
  const out: GlobTok[] = []
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    const cls = c === '[' ? classEnd(g, i) : undefined
    if (c === '*') out.push({ star: true })
    else if (c === '?') out.push({ star: false, test: () => true })
    else if (cls?.odd) {
      // ponytail: an odd class reads as any one char (fail closed); an exact read would be tighter
      out.push({ star: false, test: () => true })
      i = cls.j
    } else if (cls) {
      const j = cls.j
      let re: RegExp
      try {
        re = new RegExp(
          '^[' +
            g
              .slice(i + 1, j)
              .replace(/^!/, '^')
              .replace(/\\/g, '\\\\') +
            ']$',
          'i',
        )
      } catch {
        re = /^/
      }
      out.push({ star: false, test: x => re.test(x) })
      i = j
    } else out.push({ star: false, test: x => x === c, lit: c })
  }
  return out
}

/**
 * claude-factory-qn8a.20: returns `true` when glob `a` and glob `b` can match one common string.
 * The tokens are `*`, `?`, `[class]` and a literal. Two classes, or a class and `?`, count as a meet.
 * The search visits each pair of token positions once, so the cost is O(|a|*|b|).
 * With a `state`, the search spends scan work. An empty budget also fails closed.
 */
export function globsMeet(a: string, b: string, state?: ScanState): boolean {
  const p = globToks(a)
  const q = globToks(b)
  if (state && spendWork(state, (p.length + 1) * (q.length + 1))) return true
  const seen = new Set<number>()
  const go = (i: number, j: number): boolean => {
    const k = i * (q.length + 1) + j
    if (seen.has(k)) return false
    seen.add(k)
    if (i === p.length && j === q.length) return true
    const x = p[i]
    const y = q[j]
    if (x?.star && go(i + 1, j)) return true
    if (y?.star && go(i, j + 1)) return true
    if (!x || !y) return false
    if (x.star && y.star) return go(i + 1, j + 1)
    if (x.star) return go(i, j + 1)
    if (y.star) return go(i + 1, j)
    if (x.lit !== undefined) return y.test(x.lit) && go(i + 1, j + 1)
    if (y.lit !== undefined) return x.test(y.lit) && go(i + 1, j + 1)
    return go(i + 1, j + 1)
  }
  return go(0, 0)
}
const FACTORY_CONFIG_MAY_RE = /rigs|settings|inbox|state|[*?[{<>\\"']/i
// no `=` and no leading `-`: a flag with a glued value (--output=/h/rigs.json) is no path
const FACTORY_CONFIG_EXEMPT_RE = /^[\w.@%+,:/][\w.@%+,:/-]*$/

/**
 * claude-factory-qn8a.20: 1 when a path word names rigs.json or a worker-settings file, 2 when a
 * glob with a letter can match one, 3 when a glob with no letter can match one, else 0.
 */
function namesFactoryConfig(word: string, state?: ScanState): 0 | 1 | 2 | 3 {
  const c = foldNonAscii(normalizeConfigPath(word))
    .toLowerCase()
    .replace(/["'\\]/g, '')
  // a list brace expands to each member; a range or a long list reads as a star; {} and {x} stay literal
  let all = [c]
  for (let n = 0; n < 8 && all.some(s => /\{[^{}]*\}/.test(s)); n++)
    all = all.flatMap(s => {
      const m = /\{([^{}]*)\}/.exec(s)
      if (!m) return [s]
      const at = (body: string) => s.slice(0, m.index) + body + s.slice(m.index + m[0].length)
      if (m[1]!.includes('..')) return [at('*')]
      return m[1]!.includes(',') ? m[1]!.split(',').map(at) : [at('\u0001' + m[1] + '\u0002')]
    })
  if (all.length > 64) return 2
  return Math.max(...all.map(s => namesFactoryConfigPlain(s.replace(/[\u0001\u0002]/g, ''), state))) as
    0 | 1 | 2 | 3
}

// 1: the word names the file. 2: a glob with a literal letter can match it. 3: a glob with no letter can.
function namesFactoryConfigPlain(c: string, state?: ScanState): 0 | 1 | 2 | 3 {
  if (
    c.includes('rigs.json') ||
    c.includes('worker-settings') ||
    c.includes('inbox.jsonl') ||
    c.includes('state.json')
  )
    return 1
  const last = c.split('/').pop() ?? c
  if (!/[*?[]/.test(last)) return 0
  // a class names its first member, so w[o]rker-settings-acme.json reads as the settings file
  let first = ''
  for (let i = 0; i < last.length; i++) {
    const cls = last[i] === '[' ? classEnd(last, i) : undefined
    if (!cls) first += last[i]
    else {
      first += cls.odd ? '?' : last[i + 1] === '!' || last[i + 1] === '^' ? last[i + 2] : last[i + 1]
      i = cls.j
    }
  }
  if (/rigs\.json|worker-settings|inbox\.jsonl|state\.json/.test(first)) return 1
  if (!FACTORY_CONFIG_GLOBS.some(g => globsMeet(last, g, state))) return 0
  return /[a-z]/.test(last) ? 2 : 3
}

/**
 * claude-factory-qn8a.20, -qn8a.24: 'name' when one segment writes the factory home rigs.json, a
 * worker-settings*.json file or a run inbox.jsonl or state.json (a write there forges manager mail),
 * 'glob' when a glob guess can match one. Only a redirect or `of=`
 * target is exempt, and only as a plain path inside `root`. Any other write word that names the
 * file denies, because the hook cannot tell the source of a cp or mv from its destination.
 * A glob with no letter (`*`) is a guess only when its directory part is not a plain path inside `root`.
 * The write words are those of `globalGitConfigUse`: a redirect target, an `of=` value, an output
 * flag value, and every word of a segment that does not skip its operands.
 * ponytail: these pass: a name built at run time (a variable, printf), a script file, a symlink
 * from an earlier call, a program that picks the path, git config -f (qn8a.50),
 * the hook source and settings.local.json (qn8a.21), a re-point of origin (qn8a.45), a
 * directory copy that names no file (qn8a.52), and a symlink made earlier in the same command (qn8a.54).
 * The sandbox is the barrier.
 * Upgrade path: resolve each word against the real FACTORY_HOME.
 */
function factoryConfigWrite(
  words: string[],
  skip: OperandSkip,
  isCd: boolean,
  root: string | undefined,
  cwd: string | undefined,
  moved: boolean,
  state?: ScanState,
): 'name' | 'glob' | undefined {
  if (!FACTORY_CONFIG_MAY_RE.test(foldNonAscii(joinedWords(words)))) return undefined
  let found: 'glob' | undefined
  const relativeOk = !moved && (!cwd || (!!root && (cwd === root || cwd.startsWith(root + '/'))))
  const exempt = (w: string): boolean => {
    const v = normalizeConfigPath(w.replace(/["']/g, ''))
    if (!root || !FACTORY_CONFIG_EXEMPT_RE.test(v) || v.split('/').includes('..')) return false
    return v.startsWith('/') ? v.startsWith(root + '/') : relativeOk
  }
  const insideDir = (w: string): boolean => {
    const v = normalizeConfigPath(w.replace(/["']/g, ''))
    const dir = v.slice(0, v.lastIndexOf('/') + 1)
    if (!root || !/^[\w.@%+,:/-]*$/.test(dir) || dir.split('/').includes('..')) return false
    return dir.startsWith('/') ? dir.startsWith(root + '/') : relativeOk
  }
  let pending = false
  let prevWriterFlag = false
  for (const word of words) {
    const afterWriterFlag = prevWriterFlag
    prevWriterFlag = skip === 'operands' && OUTPUT_FLAG_EXACT_RE.test(word)
    const wasPending = pending
    pending = false
    if (!wasPending && !FACTORY_CONFIG_MAY_RE.test(foldNonAscii(word))) continue
    let target = word
    let redirect = wasPending
    const m = word.match(REDIRECT_PREFIX_RE)
    if (m && m[0].length === word.length) {
      pending = true
      continue
    }
    if (m) {
      target = word.slice(m[0].length)
      redirect = true
    } else if (!wasPending && /^of=/i.test(word)) {
      target = word.slice(3)
      redirect = true
    }
    if (!redirect) {
      if (skip === 'reader' || isCd) continue
      if (skip === 'operands' && !afterWriterFlag && !OUTPUT_FLAG_RE.test(word)) continue
    }
    const named = namesFactoryConfig(target, state)
    // an operand of cp, mv or ln can be a source or a destination: only a redirect or of= target is exempt
    if (named === 1 && !(redirect && exempt(target))) return 'name'
    if (named === 2) found = 'glob'
    if (named === 3 && !insideDir(target)) found = 'glob'
  }
  return found
}

/** claude-factory-ty8y: true when a dequoted word of a segment is a git or git-<verb> word. */
function hasGitWordIn(words: string[]): boolean {
  if (!/git/i.test(joinedWords(words))) return false
  return words.some(w => {
    if (!/git/i.test(w)) return false
    const b = baseWord(w)
    return b === 'git' || /^git-/.test(b)
  })
}

// claude-factory-9zd5: removes a leading redirect operator from a word.
// This applies to one word that holds the operator and the target, with no space.
// Examples: `>.git/HEAD`, `2>/path`, `&>>/path`.
// A word that holds only the operator matches in full, such as a bare `>` or `>>`.
// The caller then reads the next word as the target.
const REDIRECT_PREFIX_RE = /^(?:\d+|&|\{[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\})?(?:<>|>>?&?[|!]?)/

// claude-factory-9zd5: matches a remote-tracking `HEAD` word, for example `origin/HEAD` or
// `refs/remotes/origin/HEAD`. This word names a read-only ref that git itself manages. It does not
// name a file that a worker writes. R2 skips a non-redirect word that matches this form.
const REMOTE_TRACKING_HEAD_RE = /^(refs\/remotes\/)?[A-Za-z0-9._-]+\/HEAD$/i

/**
 * claude-factory-9zd5: converts a shell glob to a case-insensitive `RegExp`.
 * The glob supports `*`, `?` and a `[...]` character class.
 * The function anchors the regex at both ends.
 *
 * Any other character matches itself.
 * The function escapes that character for regex.
 *
 * `namesGitAdminPath` uses this to test a glob word, such as `H?AD` or a glob ending in `H*`.
 * It checks whether the glob can match the literal name `HEAD`.
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      out += '.*'
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      let j = i + 1
      let cls = '['
      if (glob[j] === '!' || glob[j] === '^') {
        cls += '^'
        j++
      }
      while (j < glob.length && glob[j] !== ']') {
        cls += glob[j] === '\\' ? '\\\\' : glob[j]
        j++
      }
      cls += ']'
      out += cls
      i = j
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

const MAX_GLOB_STARS = 4

/**
 * claude-factory-267o: returns `true` if the glob can match one of the samples.
 * Star runs collapse to one star. A glob with more than `MAX_GLOB_STARS` stars fails closed
 * (returns `true`), because a backtracking match can outlast the hook timeout.
 * With a `state`, each test spends scan work. An empty budget also fails closed.
 * A glob that is not a valid pattern matches nothing.
 */
function globCanMatch(glob: string, samples: readonly string[], state?: ScanState): boolean {
  const collapsed = glob.replace(/\*+/g, '*')
  if (collapsed.split('*').length - 1 > MAX_GLOB_STARS) return true
  if (state && spendWork(state, collapsed.length * samples.length)) return true
  try {
    const re = globToRegExp(collapsed)
    return samples.some(s => re.test(s))
  } catch {
    return false
  }
}

/**
 * claude-factory-9zd5: returns `true` if the last path component of `candidate` names `HEAD`.
 * The last component is the text after the final `/`.
 * With no `/`, the last component is the whole string.
 *
 * The check uses an exact, case-insensitive match. It does not test for a substring.
 * For example, `pushing HEAD` and `.gitignore` do not match.
 *
 * If the last component has a glob character (`*`, `?` or `[`), the function tests the glob instead.
 * It checks whether the glob, read as a shell pattern, can match the literal name `HEAD`.
 */
function wordNamesHead(candidate: string, state?: ScanState): boolean {
  const last = candidate.split('/').pop() ?? candidate
  if (/[*?[]/.test(last)) return globCanMatch(last, ['HEAD'], state)
  return last.toLowerCase() === 'head'
}

/**
 * claude-factory-9zd5: returns `true` when `words` holds a sign of a direct write to a git
 * administrative path, or a git-dir lookup.
 * The words are one segment's raw words, before `realCommand` strips a leading `VAR=val` or wrapper word.
 *
 * `denyAt` calls this beside `setsDangerousGitConfigEnv`.
 * On a match, `denyAt` sets `state.gitAdminPath`.
 * See the `ScanState` comment above for the full rule.
 *
 * `isGitOrGhSegment` holds `true` when the segment's own command is `git`, a dashed `git-<verb>` binary, or `gh`.
 * R2 (the `HEAD`-named word check) skips a non-redirect word in such a segment.
 * Both `git push o HEAD` and `git log origin/HEAD..HEAD` name `HEAD` as a normal argument, not a write target.
 *
 * The function checks each word in 3 steps, in this order:
 *   - R1: tests `GIT_NAME_RE` against the raw word, with no skip rule.
 *     A `.git` name is a write target, or a `cd` target, wherever it appears.
 *   - R3: tests `GIT_DIR_FLAG_RE` against the raw word, also with no skip rule (see that constant's comment).
 *   - R2: tests the redirect target or write-operand form (see below) with `wordNamesHead`, the only step with a skip rule.
 *
 * A word counts as a redirect-form candidate in 3 ways:
 *   - It holds a `REDIRECT_PREFIX_RE` match with more text after it (`>.git/HEAD`).
 *   - It directly follows a bare redirect-operator word (`> .git/HEAD`, 2 words).
 *   - It holds a `dd`-style `of=` prefix (`of=HEAD`).
 * Any other word is plain and non-redirect. Examples: an `mv` or `ln` operand, a quoted message, a git argument.
 *
 * R2 skips a non-redirect word when `isGitOrGhSegment` holds `true`.
 * R2 also skips a non-redirect word that matches `REMOTE_TRACKING_HEAD_RE`.
 * R2 never skips a redirect-form word.
 * A write is a write, even inside a `git` segment's own redirect, such as `git log > HEAD`.
 */
function namesGitAdminPath(words: string[], isGitOrGhSegment: boolean, state?: ScanState): boolean {
  let pendingRedirectTarget = false
  for (const word of words) {
    if (GIT_NAME_RE.test(word)) return true
    if (GIT_DIR_FLAG_RE.test(word)) return true

    const wasPending = pendingRedirectTarget
    pendingRedirectTarget = false

    let candidate = word
    let isRedirectForm = wasPending

    const m = word.match(REDIRECT_PREFIX_RE)
    if (m && m[0].length === word.length) {
      // the whole word is a bare redirect operator (`>`, `2>>`, ...); the next word is the target
      pendingRedirectTarget = true
      continue
    }
    if (m) {
      candidate = word.slice(m[0].length)
      isRedirectForm = true
    } else if (!wasPending && /^of=/i.test(word)) {
      candidate = word.slice(3)
      isRedirectForm = true
    }

    if (!isRedirectForm) {
      if (isGitOrGhSegment) continue
      if (REMOTE_TRACKING_HEAD_RE.test(candidate)) continue
    }
    if (wordNamesHead(candidate, state)) return true
  }
  return false
}

// claude-factory-9zd5: R4. Returns `true` when `cwd` holds a path component that ends in `.git`.
// The match ignores case. It covers a bare `.git` directory and a `<name>.git` bare-repo directory.
// A headPush from inside such a directory denies outright (`scanReason`).
// The denial applies whatever the command text says.
//
// A worker can build a write target from a shell variable, such as `${x}AD`.
// The command can contain no `.git` or `HEAD` text at all, so R1-R3 have nothing to read.
function cwdInsideGitDir(cwd: string | undefined): boolean {
  if (!cwd) return false
  return cwd.split('/').some(part => part.toLowerCase().endsWith('.git'))
}

// claude-factory-cu5m: `segments()` ends a segment at a backtick and drops it. So the output of a
// backtick command is not a word of the `git push` segment, and the push parsers cannot see it.
// That output can be `--all`. This scan reads the raw text: a backtick, a git word and a push or
// send-pack word together. It over-denies a backtick that sits in an unrelated quoted argument.
// This is fail closed.
// claude-factory-cu5m.13: the same scan covers `&>` (also `&>>`, `&>|`, `&>!`). zsh and bash read it
// as a redirect. `segments()` now scans both readings (claude-factory-59pp). This check stays as a
// fail closed backstop. It over-denies `git push origin feature &>/dev/null`.
// claude-factory-abmq: bash joins `&BSNL>` into `&>`, so the scan allows backslash-newline pairs
// between the `&` and the `>`. It also denies `git push origin feature &BSNL>/dev/null`.
function backtickBesidePush(command: string): boolean {
  if (!/`|&(?:\\\n)*>/.test(command)) return false
  const words = segments(command).flat().map(baseWord)
  return (
    words.some(b => b === 'git' || /^git-/.test(b)) &&
    words.some(b => b === 'push' || b === 'send-pack' || b === 'git-push' || b === 'git-send-pack')
  )
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

// claude-factory-qn8a.17: the flux CLI (v2.9.5). Names are exact: cobra has no prefix match.
const FLUX_VALUE_FLAGS = new Set([
  '--as',
  '--as-group',
  '--as-uid',
  '--as-user-extra',
  '--cache-dir',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--cluster',
  '--context',
  '--kube-api-burst',
  '--kube-api-qps',
  '--kubeconfig',
  '-n',
  '--namespace',
  '--server',
  '--timeout',
  '--tls-server-name',
  '--token',
  '--user',
])
const FLUX_BOOL_FLAGS = new Set([
  '--disable-compression',
  '--insecure-skip-tls-verify',
  '--ns-follows-kube-context',
  '--verbose',
])
const FLUX_READ_VERBS = new Set([
  'build',
  'check',
  'completion',
  'debug',
  'diff',
  'envsubst',
  'events',
  'export',
  'get',
  'help',
  'list',
  'logs',
  'pull',
  'stats',
  'trace',
  'tree',
  'version',
])
const FLUX_MUTATING_VERBS = new Set([
  'bootstrap',
  'create',
  'delete',
  'install',
  'migrate',
  'plugin',
  'push',
  'reconcile',
  'resume',
  'suspend',
  'tag',
  'trigger',
  'uninstall',
])

/**
 * This function finds each value of a flag in `names`, in word order. A flag can use the
 * `--flag value` form. It can also use the `--flag=value` form.
 *
 * This function stops at a literal `--`. A word after `--` is an operand, not a flag.
 *
 * claude-factory-bemr.8: `flagValue` below keeps only the last value.
 * Call this function for a flag that git applies again each time it appears, such as `-C`.
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
 * This function finds the value of the LAST flag in `names` in `words`. See `flagValuesInOrder`
 * for the word forms that this function reads.
 * claude-factory-25z.8: kubectl, ko and helm all use the last copy of a repeated flag.
 * They do not use the first copy.
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
  skipBlank = false,
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
    // claude-factory-t1xo: cobra stripFlags skips an empty word and a lone `-` when it looks for a
    // sub command. A value flag above already took its value word, so this skip runs at the
    // word slot only. Only the cobra tools (gh, kubectl, ko, helm) ask for it.
    if (skipBlank && isBlankWord(w)) continue
    return { index: i, uncertain }
  }
  return { index: -1, uncertain }
}

/** claude-factory-t1xo: true for an empty word or a lone `-`, which cobra skips at a sub command slot. */
function isBlankWord(w: string): boolean {
  return w === '' || w === '-'
}

/**
 * claude-factory-38jm: true when `w` is a `-c` cluster, or a dynamic word that the shell can
 * expand to one. The `-c` scans use this test, so a dynamic word after a literal operand
 * (`sh script.sh $X 'git push origin main'`) reads like `sh script.sh -c '...'`.
 */
function possibleShCCluster(w: string): boolean {
  return isShCCluster(w) || (w !== '--' && dynamicPushWord(w))
}

/**
 * claude-factory-38jm: reads the option slot of the sh/bash/zsh/dash word at `words[j]`.
 * The walk starts at `words[j + 1]`. It returns `dynamic: true` when a word in that slot holds a
 * shell expansion (`dynamicPushWord`). The shell can expand such a word to `-c` and a script.
 *
 * The walk stops with `dynamic: false` at a literal `--`, at a literal `-c` cluster (the `-c`
 * scan reads the script then), or at the first literal operand (a word that does not start with
 * `-` or `+`). It skips a lone `-` and each literal flag word. After a short flag word that
 * holds `o` or `O`, and after `--rcfile`, `--init-file` or `--emulate`, the next word is the flag value. The
 * walk skips a literal value, and returns true for a dynamic one.
 *
 * `end` is the index of the word that stopped the walk, or `words.length`. The walk from a later
 * shell word below `end` reads a suffix of this walk and ends the same way.
 */
function shOptionSlotWalk(words: string[], j: number): { dynamic: boolean; end: number } {
  for (let i = j + 1; i < words.length; i++) {
    const w = words[i]!
    if (w === '--' || isShCCluster(w)) return { dynamic: false, end: i }
    if (dynamicPushWord(w)) return { dynamic: true, end: i }
    if (w === '-') continue
    if (!w.startsWith('-') && !w.startsWith('+')) return { dynamic: false, end: i }
    const takesValue =
      w === '--rcfile' || w === '--init-file' || w === '--emulate' || (!w.startsWith('--') && /[oO]/.test(w))
    if (takesValue) {
      i++
      if (i < words.length && dynamicPushWord(words[i]!)) return { dynamic: true, end: i }
    }
  }
  return { dynamic: false, end: words.length }
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

const UNDO_PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/

/**
 * claude-factory-qn8a.23: true only for the closed grammar `pr [-R|--repo <repo>] ready W...`.
 * `tail` is the words after `gh`. W is `--undo` (exactly once), one PR selector (a number or a
 * github.com pull URL) or one `-R|--repo <owner/repo>` (once in the tail). Any other word cancels
 * the exemption, because gh uses the last value of a bool flag and pflag gives the word after `-R` to it.
 */
function undoForm(tail: string[]): boolean {
  let i = 0
  let undo = false
  let sel = false
  let repo = false
  const takeRepo = (): boolean => {
    const v = tail[i + 1]
    if (repo || v === undefined || !MERGE_REPO.test(v)) return false
    repo = true
    i += 2
    return true
  }
  if (tail[i++] !== 'pr') return false
  if ((tail[i] === '-R' || tail[i] === '--repo') && !takeRepo()) return false
  if (tail[i++] !== 'ready') return false
  while (i < tail.length) {
    const w = tail[i]!
    if (w === '--undo' && !undo) {
      undo = true
      i++
    } else if ((MERGE_PR_NUMBER.test(w) || UNDO_PR_URL.test(w)) && !sel) {
      sel = true
      i++
    } else if ((w === '-R' || w === '--repo') && takeRepo()) {
      // consumed
    } else return false
  }
  return undo
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
 * Check if `cmd` (a kubectl, ko, helm or flux command) changes state at a context in `personOnly`.
 * Return true for that case, and for a command with no named context (fail closed: this function
 * does not know the current context).
 * Also return true when an unknown flag makes the verb search uncertain, and a later word before
 * `--` names a mutating verb (claude-factory-25z.6). This hook does not know every global flag that
 * takes a value word. An unknown flag must not hide a mutating verb that follows it.
 */
function liveApplyDenied(cmd: string[], personOnly: string[], strict = false): boolean {
  const scan = (skipBlank: boolean): boolean =>
    liveApplyDeniedOn(cmd, personOnly, skipBlank, strict) ||
    scanWithoutRedirects(cmd, dropped =>
      liveApplyDeniedOn([cmd[0]!, ...dropped], personOnly, skipBlank, strict),
    ) === true
  // claude-factory-t1xo: the second pass skips a blank word at the verb and sub slots, like cobra.
  return scan(false) || (cmd.slice(1).some(isBlankWord) && scan(true))
}

function liveApplyDeniedOn(cmd: string[], personOnly: string[], skipBlank = false, strict = false): boolean {
  const b = baseWord(cmd[0]!)
  const tail = cmd.slice(1)
  if (b === 'kubectl') {
    const { index: vi, uncertain } = firstVerbIndex(tail, KUBECTL_VALUE_FLAGS, undefined, skipBlank)
    const verb = vi >= 0 ? tail[vi]! : undefined
    const subRest = vi >= 0 ? tail.slice(vi + 1) : []
    // claude-factory-qbtz.2: the sub word can follow a flag, so find it the way the verb is found.
    const subScan = firstVerbIndex(subRest, KUBECTL_VALUE_FLAGS, undefined, skipBlank)
    const sub = subScan.index >= 0 ? subRest[subScan.index] : undefined
    const subSet =
      verb === 'rollout'
        ? KUBECTL_ROLLOUT_MUTATING
        : verb === 'auth'
          ? KUBECTL_AUTH_MUTATING
          : verb === 'certificate'
            ? KUBECTL_CERTIFICATE_MUTATING
            : undefined
    // claude-factory-p43v.6: a dynamic verb hides the real kubectl command. A dynamic sub word
    // hides the real rollout, auth or certificate action. This guard fails closed on either one,
    // the same way it fails closed on a listed verb or sub name.
    let mutating =
      verb !== undefined && dynamicWord(verb)
        ? true
        : verb === undefined
          ? false
          : verb === 'rollout'
            ? !!sub && (dynamicWord(sub) || KUBECTL_ROLLOUT_MUTATING.has(sub))
            : verb === 'auth'
              ? !!sub && (dynamicWord(sub) || KUBECTL_AUTH_MUTATING.has(sub))
              : verb === 'certificate'
                ? !!sub && (dynamicWord(sub) || KUBECTL_CERTIFICATE_MUTATING.has(sub))
                : KUBECTL_MUTATING_VERBS.has(verb)
    if (!mutating && subSet && subScan.uncertain) {
      for (const w of subRest) {
        if (w === '--') break
        if (subSet.has(w) || dynamicWord(w)) {
          mutating = true
          break
        }
      }
    }
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
    const { index: vi, uncertain } = firstVerbIndex(tail, KO_VALUE_FLAGS, undefined, skipBlank)
    // claude-factory-p43v.6: a dynamic verb fails closed, the same as a listed mutating verb.
    let mutating = vi >= 0 && (dynamicWord(tail[vi]!) || KO_MUTATING_VERBS.has(tail[vi]!))
    if (!mutating && uncertain) mutating = hasMutatingWordBeforeDashDash(tail, KO_MUTATING_VERBS)
    if (!mutating) return false
    const ctx = flagValue(cmd, new Set(['--context']))
    return contextDenied(ctx, personOnly)
  }
  if (b === 'helm') {
    const { index: vi, uncertain } = firstVerbIndex(tail, HELM_VALUE_FLAGS, undefined, skipBlank)
    // claude-factory-p43v.6: a dynamic verb fails closed, the same as a listed mutating verb.
    let mutating = vi >= 0 && (dynamicWord(tail[vi]!) || HELM_MUTATING_VERBS.has(tail[vi]!))
    if (!mutating && uncertain) mutating = hasMutatingWordBeforeDashDash(tail, HELM_MUTATING_VERBS)
    if (!mutating) return false
    const ctx = flagValue(cmd, new Set(['--kube-context']))
    return contextDenied(ctx, personOnly)
  }
  if (b === 'flux') {
    const { index: vi, uncertain } = firstVerbIndex(tail, FLUX_VALUE_FLAGS, FLUX_BOOL_FLAGS, skipBlank)
    const verb = vi >= 0 ? tail[vi]! : undefined
    // ponytail: only the mutating-verb list covers these cases: an unknown verb or plugin name
    // behind a wrapper that commandAnchors does not know ('caffeinate flux ... zzz'), a dynamic
    // tool word ('$F zzz'), and a short-flag cluster ('-nns'). Upgrade: list more wrappers.
    let mutating = verb !== undefined && (dynamicWord(verb) || FLUX_MUTATING_VERBS.has(verb))
    if (!mutating && uncertain) mutating = hasMutatingWordBeforeDashDash(tail, FLUX_MUTATING_VERBS)
    if (!mutating && strict && verb !== undefined) mutating = uncertain || !FLUX_READ_VERBS.has(verb)
    if (!mutating) return false
    if (contextDenied(flagValue(cmd, new Set(['--context'])), personOnly)) return true
    const cluster = flagValue(cmd, new Set(['--cluster']))
    return cluster !== undefined && (unknownFlagValue(cluster) || personOnly.includes(cluster))
  }
  return false
}

// claude-factory-zl5: gh's own global flags that take a value word. The verb search steps past
// them. This matters when they come before the verb (`gh -R o/r pr merge 5`).
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname'])
// claude-factory-zsj0: the persistent value flags of `gh pr` and `gh repo`. Cobra finds the sub
// word past them. pflag has no long-flag prefix match, so the names are exact.
const GH_SUB_VALUE_FLAGS = new Set(['-R', '--repo'])
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
// ponytail: a deny list. A GitHub mutation added later passes. Upgrade path: an allow-list (claude-factory-qn8a.81).
const REPO_SETTING_MUTATIONS = [
  'updateRepository',
  'archiveRepository',
  'unarchiveRepository',
  'createBranchProtectionRule',
  'updateBranchProtectionRule',
  'deleteBranchProtectionRule',
  'createRepositoryRuleset',
  'updateRepositoryRuleset',
  'deleteRepositoryRuleset',
  'updateRepositoryWebCommitSignoffSetting',
]

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
 * True when `endpoint` is surely the GraphQL endpoint: the bare word, `/graphql`, or a URL whose
 * path is exactly `/graphql` or `/api/graphql`. Only this narrow form lets a guard skip its REST
 * check (claude-factory-qn8a.18.7). Any other URL that ends in `/graphql` (`//graphql`,
 * `/api//graphql`, `/x/graphql`) is read as GraphQL and as REST: a host can route it to
 * GraphQL (GitLab answers `//api/graphql` with a 308), and `.../contents/api/graphql` is a file path.
 */
function isNarrowGraphqlEndpoint(endpoint: string): boolean {
  const path = normalizeEndpoint(endpoint)
  if (path === 'graphql' || path === '/graphql') return true
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+(?:\/api)?\/graphql$/.test(path)
}

/**
 * For a guard that reads a mutation list: true = deny, false = allow (narrow GraphQL endpoint),
 * undefined = the guard must go on to its REST check.
 */
function graphqlVerdict(
  endpoint: string,
  apiArgs: string[],
  gate: HookGate,
  mutations: string[],
): boolean | undefined {
  if (!isGraphqlEndpoint(endpoint)) return undefined
  if (hasGraphqlMutation(apiArgs, gate, mutations)) return true
  return isNarrowGraphqlEndpoint(endpoint) ? false : undefined
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
  const gql = graphqlVerdict(endpoint, apiArgs, gate, MERGE_MUTATIONS)
  if (gql !== undefined) return gql
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
// claude-factory-0gww.3: a GraphQL mutation name that creates or submits a pull request review
const REVIEW_MUTATIONS = ['addPullRequestReview', 'submitPullRequestReview']
// a REST path that creates a review, or submits a pending one
const REVIEWS_PATH = /(^|\/)pulls\/[^/]+\/reviews(\/[^/]+\/events)?$/
// the only review events that are no approval
const SAFE_REVIEW_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES'])

/**
 * claude-factory-0gww.3: true when a `gh api` call can approve a pull request and this hook cannot prove it does not.
 * GraphQL: the query names `addPullRequestReview` or `submitPullRequestReview` (an unreadable query denies too).
 * REST: a non-GET call to `.../pulls/<n>/reviews` or `.../pulls/<n>/reviews/<id>/events` is allowed only when every
 * `event` value is literally `COMMENT` or `REQUEST_CHANGES`. A call to the create path with no event makes a pending
 * review, which is no approval. A submit path with no event, a shell expansion, an `@file` value, or an `--input`
 * body that is unreadable, not JSON, or has another event: deny.
 */
function ghApiReviewDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint) return false
  const gql = graphqlVerdict(endpoint, apiArgs, gate, REVIEW_MUTATIONS)
  if (gql !== undefined) return gql
  const path = decodeApiPath(normalizeEndpoint(endpoint))
  if (path === undefined) return true
  const match = REVIEWS_PATH.exec(path)
  if (!match) return false
  const fields = ghApiFields(apiArgs)
  const inputFile = flagValue(apiArgs, new Set(['--input']))
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  if ((method || (fields.length > 0 || inputFile !== undefined ? 'POST' : 'GET')) === 'GET') return false
  const events = fields.filter(f => f.name === 'event').map(f => f.value)
  if (inputFile !== undefined) {
    const content = SHELL_UNSAFE.test(inputFile) ? undefined : gate.readFile?.(inputFile)
    if (content === undefined) return true
    try {
      const body: unknown = JSON.parse(content)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return true
      const event = (body as { event?: unknown }).event
      if (event !== undefined) {
        if (typeof event !== 'string') return true
        events.push(event)
      }
    } catch {
      return true
    }
  }
  if (events.length === 0) return match[2] !== undefined
  return events.some(e => !SAFE_REVIEW_EVENTS.has(e))
}

/**
 * claude-factory-0gww.3: true when a `gh pr review` call (`words`: its arguments after `review`) can approve.
 * It is allowed only with a literal `-c`, `--comment`, `-r` or `--request-changes`, and with no `-a`, `--approve`,
 * `--approve=...`, short cluster that holds `a`, or shell expansion in a flag position. The word after a value flag is data.
 */
function prReviewApproves(words: string[]): boolean {
  let mode = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') break
    if (['-b', '--body', '-F', '--body-file', '-R', '--repo'].includes(w)) {
      i++
      continue
    }
    if (w === '-c' || w === '--comment' || w === '-r' || w === '--request-changes') mode = true
    else if (w === '--approve' || w.startsWith('--approve=')) return true
    else if (/^-[^-]/.test(w) && w.includes('a')) return true
    else if (dynamicWord(w)) return true
  }
  return !mode
}

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
  const gql = graphqlVerdict(endpoint, apiArgs, gate, PUSH_MUTATIONS)
  if (gql !== undefined) return gql
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

// claude-factory-qn8a.18: the repository sub-resources that a worker can write with `gh api`.
// All other paths under a repository are settings.
const REPO_WRITE_OK =
  /^(?!check-suites\/preferences(?:\/|$))(?:(?:issues|pulls|git|contents|statuses|check-runs|check-suites|commits|comments|releases|dispatches)(?:\/|$)|actions\/runs\/[^/]+\/(?:rerun|rerun-failed-jobs|cancel)$|actions\/jobs\/[^/]+\/rerun$|actions\/workflows\/[^/]+\/dispatches$)/

/**
 * True when a `gh api` call writes to a repository setting (claude-factory-qn8a.18).
 * A write is a call whose effective method is not GET. `ghApiMergeDenied` uses the same rule.
 * A repository path is `repos/<o>/<r>/...` or `repositories/<id>/...`, with an optional URL prefix.
 * The call passes only if the part after the repository root matches `REPO_WRITE_OK`.
 * The repository itself (an empty tail) is a setting.
 * This is an allow-list, so a new GitHub setting endpoint fails closed.
 *
 * The call is also denied in these cases:
 * - The path has a bad percent-encoding or a `.` or `..` segment.
 * - A `repos` word is in the path, but no repository root explains it.
 * - A GraphQL query names a `REPO_SETTING_MUTATIONS` entry, or this hook cannot read the query.
 */
function ghApiRepoSettingDenied(apiArgs: string[], gate: HookGate): boolean {
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint) return false
  const gql = graphqlVerdict(endpoint, apiArgs, gate, REPO_SETTING_MUTATIONS)
  if (gql !== undefined) return gql
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  const hasData = ghApiFields(apiArgs).length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
  if ((method || (hasData ? 'POST' : 'GET')) === 'GET') return false
  const decoded = decodeApiPath(normalizeEndpoint(endpoint))
  if (decoded === undefined) return true
  // ponytail: a doubled slash is not collapsed, so such a path fails closed (no repository root matches).
  if (decoded.split('/').some(s => s === '.' || s === '..')) return true
  const path = decoded
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/, '')
    .replace(/^\/api\/v3(?=\/|$)/, '')
    .replace(/^\//, '')
  const root = /^(?:repos\/[^/]+\/[^/]+|repositories\/[^/]+)(?:\/(.*))?$/i.exec(path)
  if (root) return !REPO_WRITE_OK.test(root[1] ?? '')
  return path.split('/').some(s => /^repos(?:itories)?$/i.test(s))
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
 * claude-factory-59pp.10: remove redirect words from `words`. A redirect word (`&>f`, `>f`,
 * `2>/dev/null`, `<f`) is not an argument of the command. If the word is a bare operator (`&>`,
 * `>`), its target is the next word, and this function removes that word too.
 * Without this, the redirect word reads as the gh verb or the gh sub word and hides the real one.
 */
function dropRedirectWords(words: string[]): string[] {
  return nonRedirectIndices(words).map(i => words[i]!)
}

// The indices of the words that are not redirect words. A bare operator also drops its target.
function nonRedirectIndices(words: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < words.length; i++) {
    // claude-factory-7xmz.4: zsh also reads `>&|`, `>&!`, `>>&|`, `>>&!`, `>|`, `>!`. 7xmz.5: bash
    // reads a `{a[0]}` fd name with a subscript.
    const m =
      /^(?:[0-9]*|\{[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\})(?:&>>?|>>?|<<<|<<-?|<>|<)(?:&[|!]?|[|!])?(.*)$/s.exec(
        words[i]!,
      )
    if (!m) {
      out.push(i)
      continue
    }
    if (m[1] === '') i++
  }
  return out
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
  const pass = (skipBlank: boolean): string | undefined =>
    ghReasonOn(cmd.slice(1), gate, state, ghConfigMoved, aliasDepth, skipBlank) ??
    scanWithoutRedirects(cmd, dropped =>
      ghReasonOn(dropped, gate, state, ghConfigMoved, aliasDepth, skipBlank),
    )
  // claude-factory-t1xo: the second pass skips a blank word at the verb and sub slots, like cobra.
  return pass(false) ?? (cmd.slice(1).some(isBlankWord) ? pass(true) : undefined)
}

/**
 * claude-factory-59pp.13, .14: segments() strips quotes. A quoted word such as `'>x'` then looks
 * like a redirect. So a guard scans a command as given, and again with the redirect words removed.
 * It denies if either scan denies. `scan` gets the tail without redirect words, and only when
 * that tail differs from the given tail.
 */
function scanWithoutRedirects<T>(
  cmd: string[],
  scan: (droppedTail: string[]) => T | undefined,
): T | undefined {
  const tail = cmd.slice(1)
  const dropped = dropRedirectWords(tail)
  return dropped.length === tail.length ? undefined : scan(dropped)
}

/** claude-factory-l3tl: true only for the ship factory's release station, on a rig that opted in. */
function mayMerge(gate: HookGate): boolean {
  return (
    typeof gate.mergeAuthority === 'string' &&
    MERGE_REPO.test(gate.mergeAuthority) &&
    gate.factory === 'ship' &&
    gate.station === 'release'
  )
}

function mergeDenyReason(gate: HookGate): string {
  return mayMerge(gate) ? MERGE_FORM_REASON : MERGE_REASON
}

const MERGE_PR_NUMBER = /^[1-9][0-9]*$/
const MERGE_SHA = /^[0-9a-f]{40}$/
const MERGE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/**
 * claude-factory-l3tl: the reason to deny a `gh pr merge` call, or undefined for the one allowed form.
 * `tail` is the words after `gh`. The call passes only if `mayMerge(gate)` and every check holds:
 * `pr merge` are the first two words, this is the first scan (no alias, no blank skip), and each
 * later word is one PR number, `--merge`, `--match-head-commit <40 hex>` or `-R/--repo owner/repo`,
 * each at most once. `-R` is required and must equal `gate.mergeAuthority` (case-blind): the rig's own repo.
 * Without it, gh takes the repo from GH_REPO or the cwd. Any other word (a flag, a variable, a redirect, `--`) denies.
 */
function prMergeReason(
  tail: string[],
  gate: HookGate,
  aliasDepth: number,
  skipBlank: boolean,
): string | undefined {
  if (!mayMerge(gate)) return MERGE_REASON
  if (aliasDepth !== 0 || skipBlank || tail[0] !== 'pr' || tail[1] !== 'merge') return MERGE_FORM_REASON
  let num = false
  let merge = false
  let auto = false
  let sha = false
  let repo = false
  const w = tail.slice(2)
  for (let k = 0; k < w.length; k++) {
    const a = w[k]!
    if (MERGE_PR_NUMBER.test(a) && !num) num = true
    else if (a === '--merge' && !merge) merge = true
    // claude-factory-usp5: --auto enqueues on a repo with a merge queue; the ruleset still needs its review
    else if (a === '--auto' && !auto) auto = true
    else if ((a === '--match-head-commit' || a.startsWith('--match-head-commit=')) && !sha) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : w[++k]
      if (v === undefined || !MERGE_SHA.test(v)) return MERGE_FORM_REASON
      sha = true
    } else if ((a === '-R' || a === '--repo' || a.startsWith('--repo=')) && !repo) {
      const v = a.startsWith('--repo=') ? a.slice(7) : w[++k]
      if (v === undefined || v.toLowerCase() !== gate.mergeAuthority!.toLowerCase()) return MERGE_FORM_REASON
      repo = true
    } else return MERGE_FORM_REASON
  }
  return merge && sha && repo ? undefined : MERGE_FORM_REASON
}

function ghReasonOn(
  tail: string[],
  gate: HookGate,
  state: ScanState,
  ghConfigMoved: boolean,
  aliasDepth: number,
  skipBlank = false,
): string | undefined {
  if (spendWork(state, tail.join(' ').length + 1)) return SCAN_BUDGET_REASON
  const { index: vi, uncertain } = firstVerbIndex(tail, GH_VALUE_FLAGS, undefined, skipBlank)
  const verb = vi >= 0 ? tail[vi] : undefined
  // claude-factory-zsj0: a flag after `pr` or `repo` must not become the sub word.
  const rest = vi >= 0 ? tail.slice(vi + 1) : []
  const subScan =
    verb === 'pr' || verb === 'repo'
      ? firstVerbIndex(rest, GH_SUB_VALUE_FLAGS, undefined, skipBlank)
      : { index: -1, uncertain: false }
  const sub =
    verb === 'pr' || verb === 'repo'
      ? subScan.index >= 0
        ? rest[subScan.index]
        : undefined
      : skipBlank
        ? rest.find(w => !isBlankWord(w))
        : rest[0]
  // claude-factory-p43v: a dynamic verb word can hide the real gh command. The same risk applies
  // at the git verb slot, where dynamicWord denies it. A dynamic sub word under pr, repo or alias
  // can hide the real merge, sync, ready, checkout or alias-set call, and this guard denies both
  // words. This check runs before the alias-resolution block below. So a dynamic verb never
  // reaches the alias table as a literal verb name.
  if (verb !== undefined && dynamicWord(verb)) return DYNAMIC_VERB_REASON
  if ((verb === 'pr' || verb === 'repo' || verb === 'alias') && sub !== undefined && dynamicWord(sub)) {
    return DYNAMIC_VERB_REASON
  }
  // claude-factory-bemr: resolve a pre-existing gh alias at the verb slot.
  // Skip this when the verb search itself is uncertain.
  // `firstVerbIndex` then does not know if `verb` is the real word.
  // The uncertain-fallback word scans below still cover that case, the same as before.
  // claude-factory-t1xo.5: the blank-skipping pass resolves the alias only when it skipped a blank
  // before the verb. Otherwise pass 1 already resolved it, and its recursion ran both passes.
  const aliasAlreadyDone = skipBlank && !tail.slice(0, Math.max(vi, 0)).some(isBlankWord)
  if (!uncertain && verb !== undefined && !GH_BUILTIN_VERBS.has(verb) && !aliasAlreadyDone) {
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
  if (verb === 'pr' && sub === 'checkout') state.branchChange = true
  if (verb === 'pr' && sub === 'merge') return prMergeReason(tail, gate, aliasDepth, skipBlank)
  if (verb === 'repo' && sub === 'sync') return MERGE_REASON
  if (verb === 'pr' && sub === 'ready') {
    if (undoForm(tail)) return undefined
    return mayReady(gate) ? undefined : READY_REASON
  }
  if (
    verb === 'pr' &&
    sub === 'review' &&
    !gate.reviewer &&
    prReviewApproves(rest.slice(subScan.index + 1))
  ) {
    return APPROVE_REASON
  }
  if (verb === 'api') {
    // claude-factory-zl5.16: this splits a clustered short flag (`-iXPUT`, `-if`) into separate
    // words. Every check below already reads these words, so this runs first.
    const apiArgs = expandGhShortClusters(tail.slice(vi + 1))
    if (ghApiMergeDenied(apiArgs, gate)) return MERGE_REASON
    if (ghApiReadyDenied(apiArgs, gate) && !mayReady(gate)) return READY_REASON
    if (ghApiPushDenied(apiArgs, gate)) return PUSH_REASON
    if (ghApiRepoSettingDenied(apiArgs, gate)) return REPO_SETTING_REASON
    if (!gate.reviewer && ghApiReviewDenied(apiArgs, gate)) return APPROVE_REASON

    // claude-factory-p43v.11: a dynamic endpoint or method can still hide a merge or push call
    // that the 3 literal checks above miss, because they compare the word's raw, unresolved
    // text against a fixed pattern or method name.
    // A dynamic -X or --method value fails closed at once.
    // A dynamic endpoint fails closed only when the effective method is not GET.
    const methodRaw = flagValue(apiArgs, new Set(['-X', '--method']))
    if (methodRaw !== undefined && dynamicWord(methodRaw)) return DYNAMIC_VERB_REASON
    const { index: dei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
    const dynamicEndpoint = dei >= 0 ? apiArgs[dei] : undefined
    if (dynamicEndpoint !== undefined && dynamicWord(dynamicEndpoint)) {
      const hasData =
        ghApiFields(apiArgs).length > 0 || flagValue(apiArgs, new Set(['--input'])) !== undefined
      const effective = (methodRaw ?? (hasData ? 'POST' : 'GET')).toUpperCase()
      if (effective !== 'GET') return DYNAMIC_VERB_REASON
    }
    return undefined
  }
  if (verb === 'alias') {
    const first = rest.findIndex(w => !isBlankWord(w))
    return ghAliasDenied(skipBlank && first > 0 ? rest.slice(first) : rest)
  }
  // claude-factory-zsj0: an unknown flag before the sub word can hide it. Scan the words, fail closed.
  // This does not depend on the top-level `uncertain`: an extra flag must not switch it off.
  if ((verb === 'pr' || verb === 'repo') && subScan.uncertain) {
    if (hasMutatingWordBeforeDashDash(rest, new Set(['merge', 'sync']))) return mergeDenyReason(gate)
    if (verb === 'pr' && hasMutatingWordBeforeDashDash(rest, new Set(['ready']))) {
      return mayReady(gate) ? undefined : READY_REASON
    }
    if (hasMutatingWordBeforeDashDash(rest, new Set(['checkout']))) state.branchChange = true
    if (!gate.reviewer && verb === 'pr' && hasMutatingWordBeforeDashDash(rest, new Set(['review']))) {
      if (prReviewApproves(rest)) return APPROVE_REASON
    }
  }
  if (uncertain) {
    if (hasMutatingWordBeforeDashDash(tail, new Set(['merge', 'sync']))) return mergeDenyReason(gate)
    if (hasMutatingWordBeforeDashDash(tail, new Set(['ready'])))
      return mayReady(gate) ? undefined : READY_REASON
    // claude-factory-c63.10: an unknown global flag can hide the `pr` word the same way it
    // hides `verb` above, so a plain word scan for `checkout` is the only check left. No
    // probe today reaches a real `gh pr checkout` call this way: real gh exits with code 1
    // on the unknown flag first. This word scan still sets `branchChange`, fail closed.
    if (hasMutatingWordBeforeDashDash(tail, new Set(['checkout']))) state.branchChange = true
    if (
      !gate.reviewer &&
      hasMutatingWordBeforeDashDash(tail, new Set(['review'])) &&
      prReviewApproves(tail)
    ) {
      return APPROVE_REASON
    }
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

// a glab REST path that approves a merge request; read on the decoded, lower-case path
const GLAB_APPROVE_PATH = /merge_requests\/.*\/approve(?![a-z])/i

// claude-factory-qn8a.32.11
export const GLAB_DYNAMIC_REASON =
  'The factory denies this command: a glab word holds a shell expansion ($, a backtick, a glob, a brace ' +
  'or a leading ~) that this guard cannot read. Write the glab words plainly. For a text value, use ' +
  'single quotes, or run glab api --method POST projects/:id/merge_requests/<n>/notes -F body=@<path> as ' +
  'the whole command. Do not retry this exact command.'

// claude-factory-qn8a.33
export const GLAB_QUICK_ACTION_REASON =
  'The factory denies this command: GitLab runs a text line that starts with a slash command (/approve, ' +
  '/merge, /ready) as a quick action, so it can approve or merge with no approve word. Write the word ' +
  'later in the line, or start the line with other text. Do not retry this exact command.'

export const GLAB_TEXT_REASON =
  'The factory denies this command: glab sends note or description text that this hook cannot read (a ' +
  'shell expansion, an editor, stdin, --fill, --template, --recover, or a file in a command that is not ' +
  'the glab call alone), or a blank value (glab reads it from stdin). Write the text in single quotes, or run glab api --method POST ' +
  'projects/:id/merge_requests/<n>/notes -F body=@<path> as the whole command. Do not retry this exact command.'

/**
 * claude-factory-qn8a.33: true when a line of `text` is a GitLab quick action line. The first token of
 * the line (after zero-width characters and spaces) starts with `/` and a letter, and holds no second `/`.
 * The rule is a shape, not a list of names, because GitLab adds quick actions (/submit_review).
 */
function quickActionLine(text: string): boolean {
  return text
    .split(/\r\n|[\n\r]/)
    .some(l => /^\/[A-Za-z][^\s/]*(\s|$)/.test(l.replace(/^[\s\u200b-\u200d\u2060]+/, '')))
}

/**
 * claude-factory-qn8a.33: the text values of the flag with short letter `letter` and long name `long`.
 * A short cluster that holds the letter gives the rest of the word after it (also without a leading `=`),
 * or the next word when the rest is empty. This can read extra text, and that only adds a deny.
 */
function glabFlagValues(tail: string[], letter: string, long: string): string[] {
  const out: string[] = []
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === `--${long}`) {
      if (i + 1 < tail.length) out.push(tail[++i]!)
    } else if (w.startsWith(`--${long}=`)) out.push(w.slice(long.length + 3))
    else if (/^-[^-]/.test(w) && w.includes(letter)) {
      const rest = w.slice(w.indexOf(letter) + 1)
      if (rest) out.push(rest, rest.replace(/^=/, ''))
      else if (i + 1 < tail.length) out.push(tail[++i]!)
    }
  }
  return out
}

/**
 * claude-factory-qn8a.33: denies note or description text of `glab mr note|create|update` that holds a
 * quick action line, or that this hook cannot read (a shell expansion, an editor, --fill, --template).
 * `single` is true for a single-quoted raw word, where bash expands nothing.
 */
function glabTextReason(tail: string[], single: (w: string) => boolean): string | undefined {
  if (tail[0] !== 'mr') return undefined
  const sub = tail[1]
  if (sub !== 'note' && sub !== 'create' && sub !== 'update') return undefined
  const args = tail.slice(2)
  const values =
    sub === 'note' ? glabFlagValues(args, 'm', 'message') : glabFlagValues(args, 'd', 'description')
  if (sub !== 'note') {
    if (args.some(w => /^--(fill|fill-commit-body|recover|template)(=|$)/.test(w) || /^-[^-]*f/.test(w)))
      return GLAB_TEXT_REASON
  } else if (
    values.length === 0 &&
    !['list', 'delete', 'reopen', 'resolve'].includes(args[0] ?? '') &&
    !args.some(w => w === '-h' || w === '--help')
  )
    return GLAB_TEXT_REASON
  // glab reads a blank value from stdin
  if (values.some(v => v.replace(/[\s\u0085]/g, '') === '' || v === '-' || (/[$`]/.test(v) && !single(v))))
    return GLAB_TEXT_REASON
  return values.some(quickActionLine) ? GLAB_QUICK_ACTION_REASON : undefined
}

// claude-factory-qn8a.32.15: glab has more write paths than a deny list holds, so only these forms pass
const GLAB_COMMANDS = new Map<string, Set<string> | undefined>([
  [
    'mr',
    new Set([
      'create',
      'list',
      'view',
      'diff',
      'note',
      'update',
      'checkout',
      'rebase',
      'revoke',
      'approvers',
    ]),
  ],
  ['ci', new Set(['status', 'list', 'get', 'trace'])],
  ['issue', new Set(['list', 'view', 'note'])],
  ['repo', new Set(['view'])],
  ['api', undefined],
  ['version', undefined],
])

export const GLAB_VERB_REASON =
  'The factory denies this command: glab is allowed in these forms only: mr (create, list, view, diff, ' +
  'note, update, checkout, rebase, revoke, approvers), ci (status, list, get, trace), issue (list, view, ' +
  'note), repo view, api and version. Write the command and the sub word first, then the flags ' +
  '(glab mr list -R a/b, not glab -R a/b mr list). Do not retry this exact command.'

export const GLAB_API_REASON =
  'The factory denies this command: glab api is allowed in 3 forms only. A read: one endpoint, GET, no ' +
  'field. A GraphQL read: glab api graphql -f query=<text>, with no mutation. A note write: POST to ' +
  'projects/<id>/merge_requests[/<n>/notes|unapprove] with -f or -F fields. Use glab mr note or ' +
  'glab issue note for other text. Do not retry this exact command.'

const GLAB_SEG = '[A-Za-z0-9_-][A-Za-z0-9_.-]*'
const GLAB_NOTE_PATH = new RegExp(
  `^projects/(:id|\\d+|${GLAB_SEG}(%2[Ff]${GLAB_SEG})*)/merge_requests(/\\d+/(notes|unapprove))?$`,
)
// a single-quoted static word, and a long flag with a double-quoted value: bash expands nothing that splits or vanishes
const GLAB_SINGLE_WORD = /^[^'"$`\\*?[{}~]*'[^']*'$/
const GLAB_QUOTED_VALUE = /^--([a-z][a-z0-9-]*)="(?:[^"`\\$[]|\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\})*"$/
const GLAB_NO_QUOTED_VALUE = new Set([
  'ready',
  'title',
  'fill',
  'fill-commit-body',
  'draft',
  'wip',
  'method',
  'field',
  'raw-field',
  'input',
  'form',
  'header',
  'hostname',
  'repo',
  'output',
])

/**
 * The words that the raw command text makes safe for rule 1, as the hook sees them without quotes.
 * `segments()` drops quotes, so this reads the raw text. `ok(w)` is true when every raw word with the
 * text `w` is a single-quoted static word or `--name="..."`. `single(w)` is true when every such raw word
 * is a single-quoted static word, where bash expands nothing.
 */
function glabRawWords(command: string): { ok: (w: string) => boolean; single: (w: string) => boolean } {
  const ok = new Set<string>()
  const single = new Set<string>()
  const bad = new Set<string>()
  const s = command.replace(/\\\n/g, '')
  let w = ''
  let q = ''
  const end = () => {
    if (!w) return
    const m = GLAB_QUOTED_VALUE.exec(w)
    if (GLAB_SINGLE_WORD.test(w)) {
      ok.add(w.replace(/'/g, ''))
      single.add(w.replace(/'/g, ''))
    } else if (m && !GLAB_NO_QUOTED_VALUE.has(m[1]!)) ok.add(w.replace(/"/g, ''))
    else bad.add(w.replace(/['"]/g, ''))
    w = ''
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) {
      w += c
      if (c === q) q = ''
      else if (q === '"' && c === '\\') w += s[++i] ?? ''
    } else if (c === "'" || c === '"') {
      q = c
      w += c
    } else if (c === '\\') w += c + (s[++i] ?? '')
    else if (/[\s;|&<>()]/.test(c)) end()
    else w += c
  }
  end()
  return { ok: x => ok.has(x) && !bad.has(x), single: x => single.has(x) && !bad.has(x) }
}

const GLAB_API_PLAIN = new Set(['-i', '--include', '--paginate', '--silent'])
const GLAB_API_FIELD = new Set(['-f', '-F', '--field', '--raw-field'])

/**
 * claude-factory-qn8a.32.11: true when the words of a `glab api` call (without the `api` word) fit one of
 * 3 closed forms. R reads one endpoint with GET. Q reads GraphQL with one `-f query=` text and no
 * mutation. W posts fields to a merge request note, unapprove or create path.
 * It reads every word and skips no flag value, so a flag cannot hide a word.
 */
function glabApiAllowed(args: string[], fieldsOut?: { flag: string; value: string }[]): boolean {
  const methods: (string | undefined)[] = []
  const pos: string[] = []
  const fields: { flag: string; value: string }[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (GLAB_API_PLAIN.has(w)) continue
    const eq = w.startsWith('--') ? w.indexOf('=') : -1
    const name = eq > 0 ? w.slice(0, eq) : w
    const inline = eq > 0 ? w.slice(eq + 1) : undefined
    const next = () => inline ?? args[++i]
    if (name === '--output') {
      const v = next()
      if (v !== 'json' && v !== 'ndjson') return false
    } else if (name === '-R' || name === '--repo' || name === '--hostname') {
      const v = next()
      if (!v || v.startsWith('-')) return false
    } else if (name === '-X' || name === '--method') methods.push(next())
    else if (/^-X./.test(w)) methods.push(w.slice(2))
    else if (GLAB_API_FIELD.has(name)) {
      const v = next()
      if (v === undefined || v.startsWith('-')) return false
      fields.push({ flag: name, value: v })
    } else if (w.startsWith('-')) return false
    else pos.push(w)
  }
  fieldsOut?.push(...fields)
  const method = methods[0]
  if (pos.length !== 1 || methods.length > 1 || (methods.length === 1 && method === undefined)) return false
  if (fields.length === 0 && (method === undefined || method === 'GET')) return true
  if (pos[0] === 'graphql') {
    const f = fields[0]
    if (!f) return false
    return (
      method === undefined &&
      fields.length === 1 &&
      (f.flag === '-f' || f.flag === '--raw-field') &&
      f.value.startsWith('query=') &&
      !f.value.startsWith('query=@') &&
      !/mutation|subscription/i.test(f.value)
    )
  }
  return (method === undefined || method === 'POST') && GLAB_NOTE_PATH.test(pos[0]!)
}

/** True when the raw or decoded endpoint text matches `re`. An endpoint that cannot be decoded gives `undecodable`. */
function glabPathMatch(endpoint: string, re: RegExp, undecodable = false): boolean {
  const decoded = decodeApiPath(endpoint)
  if (decoded === undefined) return undecodable
  const views = [normalizeEndpoint(endpoint), normalizeEndpoint(decoded), decoded]
  // resolve dot segments and repeated slashes, then drop a trailing slash
  const resolved = views.map(p => posix.normalize(p).replace(/(.)\/+$/, '$1'))
  return [...views, ...resolved].some(p => re.test(p))
}

/**
 * claude-factory-hoz8, claude-factory-qn8a.32: the reason to deny a `glab` call that can approve or merge
 * a merge request, mark a draft ready, or hide any of these. `words` start at the `glab` word.
 * The factory has no GitLab reviewer identity, so approve is denied at every station.
 * This is a closed grammar, not a model of the glab flag parser. It reads every word of the call and
 * skips no flag value, so a flag cannot hide a word (rounds 1 to 3 of qn8a.32 each found a new parser gap).
 * Like `ghReason`, it scans the words as given and again without redirect words. Only the second scan
 * checks `glab api` against its 3 closed forms.
 * claude-factory-qn8a.33: each call spends the length of `command` from the scan work, because the raw
 * words and the line backstop read the whole command for each glab word. A spent budget gives
 * SCAN_BUDGET_REASON. `depth` is 0 only for the command that the person typed, not for a wrapper script.
 */
function glabReason(
  words: string[],
  gate: HookGate,
  command: string,
  depth: number,
  state: ScanState,
): string | undefined {
  if (spendWork(state, command.length + 1)) return SCAN_BUDGET_REASON
  const tail = words.slice(1)
  const dropped = dropRedirectWords(tail)
  const raw = { ...glabRawWords(command), whole: depth === 0 && glabWholeCommand(command) }
  const same = dropped.length === tail.length
  return (
    glabReasonOn(tail, same, raw, gate) ??
    (same ? undefined : glabReasonOn(dropped, true, raw, gate)) ??
    // claude-factory-qn8a.33: backstop. A quote can hold a newline, whatever the parse does with it.
    (quickActionLine(command.replace(/\\\n/g, '')) ? GLAB_QUICK_ACTION_REASON : undefined)
  )
}

type GlabRaw = {
  ok: (w: string) => boolean
  single: (w: string) => boolean
  whole: boolean
}

/**
 * claude-factory-qn8a.33: true when the glab call is the whole command. The raw text starts with `glab`
 * and holds no list, pipe, subshell, expansion or newline outside single quotes. A redirect is allowed.
 * Only then does the hook read an `@file` field: in any other command an earlier part can write the file
 * after the hook reads it. A script that a wrapper (bash -c) runs is never the whole command (`depth` > 0).
 */
function glabWholeCommand(command: string): boolean {
  const s = command.replace(/\\\n/g, '').trim()
  return /^glab\s/.test(s) && !/[;&|\n\r()`$]/.test(s.replace(/'[^']*'/g, "''"))
}

/**
 * claude-factory-qn8a.33: denies a `glab api` note or merge request write when a field holds a quick action
 * line or text this hook cannot read. `-f` and `--raw-field` send the value as written. `-F` and `--field`
 * read the file after `@`; the hook reads it only when the glab call is the whole command.
 */
function glabFieldsReason(
  fields: { flag: string; value: string }[],
  raw: GlabRaw,
  gate: HookGate,
): string | undefined {
  for (const { flag, value } of fields) {
    const eq = value.indexOf('=')
    const text = eq < 0 ? value : value.slice(eq + 1)
    let body = text
    if (text.startsWith('@') && (flag === '-F' || flag === '--field')) {
      if (text === '@-' || text.startsWith('@~') || !raw.whole) return GLAB_TEXT_REASON
      const file = gate.readFile?.(text.slice(1))
      if (file === undefined) return GLAB_TEXT_REASON
      body = file
    }
    if (quickActionLine(body)) return GLAB_QUICK_ACTION_REASON
  }
  return undefined
}

function glabReasonOn(tail: string[], checkApi: boolean, raw: GlabRaw, gate: HookGate): string | undefined {
  const exempt = raw.ok
  if (tail.includes('approve')) return GLAB_APPROVE_REASON
  const api = tail.indexOf('api')
  const args = api < 0 ? [] : [...tail.slice(0, api), ...tail.slice(api + 1)]
  // a glob word such as `...approve?x=1` still names the approve path in its literal text
  if (args.some(w => !w.startsWith('-') && glabPathMatch(w, GLAB_APPROVE_PATH, /merge_requests/i.test(w))))
    return GLAB_APPROVE_REASON
  if (tail.includes('merge') || tail.includes('accept') || tail.some(w => /^--auto-merge(=|$)/.test(w)))
    return MERGE_REASON
  if (tail.some(w => dynamicWord(w) && !exempt(w))) return GLAB_DYNAMIC_REASON
  const subs = GLAB_COMMANDS.get(tail[0] ?? '')
  if (!GLAB_COMMANDS.has(tail[0] ?? '') || (subs && !subs.has(tail[1] ?? ''))) return GLAB_VERB_REASON
  if (
    !mayReady(gate) &&
    tail.includes('update') &&
    tail.some(w => /^--(ready|title|fill|draft=|wip=)/.test(w) || /^-[^-]*[rtf]/.test(w))
  ) {
    return READY_REASON
  }
  const text = glabTextReason(tail, raw.single)
  if (text) return text
  if (api < 0 || !checkApi) return undefined
  const fields: { flag: string; value: string }[] = []
  if (glabApiAllowed(args, fields))
    return args.includes('graphql') ? undefined : glabFieldsReason(fields, raw, gate)
  if (/approv/i.test(args.join(' '))) return GLAB_APPROVE_REASON
  if (args.some(isGraphqlEndpoint)) {
    const { texts, unresolved } = graphqlTexts(expandGhShortClusters(args), gate)
    if (unresolved || texts.some(t => /approv/i.test(t))) return GLAB_APPROVE_REASON
  }
  return GLAB_API_REASON
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
  command: string,
  depth: number,
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
    if (baseWord(words[j]!) === 'glab') {
      const r = glabReason(words.slice(j), gate, command, depth, state)
      if (r) return r
    }
  }
  return undefined
}

export const FACTORY_CONTROL_REASON =
  'The factory denies this command: only the person or the manager runs factory say, stop, resume, ' +
  'start, fork, goto, retry, abort, rm, tick, loop, self-update, gc, sweep, beads, watch, sync, dream, devenv, linear, queue, poke, attach, manager, migrate-to-ax, ' +
  'rig with a sub other than list, and memory with a sub other than search, add, helped, eval or compact --dry-run. ' +
  'Mail the manager instead. Do not retry this command.'

// claude-factory-5y7b, claude-factory-3c4w: the verbs only the person or the manager runs.
const FACTORY_CONTROL_VERBS = new Set([
  'say',
  'stop',
  'resume',
  'start',
  'fork',
  'goto',
  'retry',
  'abort',
  'rm',
  'tick',
  'loop',
  'self-update',
  'gc',
  'sweep',
  'beads',
  'watch',
  'sync',
  'dream',
  'devenv',
  'linear',
  'queue',
  'poke',
  'attach',
  'manager',
  'migrate-to-ax',
])

/**
 * claude-factory-5y7b: a factory word at any position (after sudo, env, timeout, bash -c) whose next
 * word is a control verb, or is dynamic, so the guard cannot read it. Same any-position scan as anyGhReason.
 */
function anyFactoryControlReason(words: string[]): string | undefined {
  for (let j = 0; j + 1 < words.length; j++) {
    if (baseWord(words[j]!) !== 'factory') continue
    // claude-factory-rtbv.3: segments() removes quotes, so a quoted `'>'` looks like a redirect word.
    // Read the words as given and with redirect words dropped; deny if either reading denies.
    const given = words.slice(j + 1)
    const dropped = dropRedirectWords(given)
    const reason = factoryVerbReason(given) ?? factoryVerbReason(dropped)
    if (reason) return reason
    // claude-factory-qn8a.5.8: segments() ends the segment at a `(`, so `factory > >(cat) tick` leaves
    // `factory > > (` and the verb is in the next segment. If only redirect words come before that `(`,
    // the verb is unreadable: deny. ponytail: factory only; gh, git, kubectl, helm and rm have the
    // same gap (claude-factory-qn8a.40, known gaps in worker-hook-qn8a5.test.ts).
    if (
      given[given.length - 1] === '(' &&
      given.length > 1 &&
      dropRedirectWords(given.slice(0, -1)).length === 0
    )
      return FACTORY_CONTROL_REASON
  }
  return undefined
}

function factoryVerbReason(rest: string[]): string | undefined {
  const next = rest[0]
  if (next === undefined) return undefined
  if (FACTORY_CONTROL_VERBS.has(next.toLowerCase())) return FACTORY_CONTROL_REASON
  if (dynamicWord(next)) return DYNAMIC_VERB_REASON
  if (next.toLowerCase() === 'rig' && rest.length > 1) {
    const sub = rest[1]!
    if (dynamicWord(sub)) return DYNAMIC_VERB_REASON
    if (sub !== 'list') return FACTORY_CONTROL_REASON
  }
  // claude-factory-6rmg: the CLI takes a literal first non-flag word as the sub, so read it first and fail closed.
  if (next.toLowerCase() === 'memory') {
    const sub = rest[1]
    if (sub === undefined) return FACTORY_CONTROL_REASON
    if (dynamicWord(sub)) return DYNAMIC_VERB_REASON
    if (['search', 'add', 'helped', 'eval'].includes(sub)) return undefined
    const tail = rest.slice(2)
    if (sub === 'compact' && tail.length > 0 && tail.every(w => w === '--dry-run')) return undefined
    return FACTORY_CONTROL_REASON
  }
  return undefined
}

// claude-factory-zl5.3: git's own global flags that take a value word (`git -C dir push ...`).
// The verb search steps past them. GH_VALUE_FLAGS does the same for `gh`.
//
// claude-factory-bemr.9: `--attr-source` and `--config-env` also each take one value word.
// Real git reads that word as-is, even a literal `--`.
//
// For example, `git --attr-source -- zz` runs the `zz` alias. The verb search must step past
// that value word. It must not mark the word `uncertain`.
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
// claude-factory-cu5m: a word the shell can expand to a flag before git runs. It adds a zsh named
// directory (`~name`, for example after `hash -d name=--all`) to REFSPEC_UNSAFE. `~/path` stays safe.
const dynamicPushWord = (w: string): boolean => REFSPEC_UNSAFE.test(w) || /[()]/.test(w) || /^~[^/]/.test(w)

// claude-factory-p43v: dynamicWord checks a command or subcommand word, in place of a push
// refspec. It uses the same character set as REFSPEC_UNSAFE.
//
// dynamicWord also treats a leading tilde as dynamic. The shell reads a leading tilde as a home
// directory, before it runs the word as a command. A matched word hides the real verb this
// guard must read.
//
// claude-factory-p43v.28/.29: the word `{}` is dynamic. `find -exec` and `xargs -I {}` fill it in
// at run time. Example: `find push -maxdepth 0 -exec git {} origin main ;` runs
// `git push origin main`. `dynamicWord` must read `{}` as dynamic. Then `gitReason`, `ghReason`
// and the AC7 scan in `anyDynamicCommandReason` deny a `{}` word at the git or gh verb slot.
//
// claude-factory-p43v.28 made `dynamicWord('{}')` give `false` to stop an incorrect deny of
// `xargs -I {} cp {} dest`. That command names no `git` or `gh` word. `commandAnchors` read the
// first `{}`, the value of the `-I` flag, as a command-slot candidate. The guard then read the
// next word, `cp`, as the actual command. `cp` matched a `kubectl` mutating verb, so
// `anyDynamicLiveApplyReason` denied the command incorrectly.
//
// The `false` result stopped that one incorrect deny. It also let all git or gh verb-slot commands
// go through without a deny.
//
// claude-factory-p43v.29 is the correct change: `dynamicCommandWord`, which is right below. Three
// sites use `dynamicCommandWord`, not `dynamicWord`. They are `commandAnchors`, and the `cmd[0]`
// check in `anyDynamicCommandReason` and in `anyDynamicLiveApplyReason`. All other uses keep
// `dynamicWord`, where `{}` stays dynamic.
//
// A word with text between `{` and `}`, for example `{push,}`, continues to match
// `REFSPEC_UNSAFE`. It stays dynamic in the two functions.
function dynamicWord(w: string): boolean {
  // claude-factory-jsy0: zsh EQUALS expands a leading =cmd to the command path.
  return REFSPEC_UNSAFE.test(w) || w.startsWith('~') || /^=[^=]/.test(w)
}
// claude-factory-teku: a head `$_`, or a zsh form such as `${=_}`. the flag-group re-read in
// denyAt strips `(...)`, so `${(@)_}` reads as `${_}` there.
const LAST_ARG_HEAD = /\$[^A-Za-z0-9_{}\s]*(?:_|\{[^A-Za-z0-9_}]*_)(?![A-Za-z0-9_])/

// claude-factory-qn8a.9.12: the exemption for `[` and `[[` is a closed grammar.
// Bash reads the operand of -v, -eq, -ne, -lt, -le, -gt and -ge as arithmetic.
// A value such as `a[$(cmd)]` then runs a command.
// Only string tests pass: `W`, `U W` and `W B W`, then the closer as the last word.
// W is a plain literal. In `[[` it can also be a $NAME or ${NAME} word, because `[[` does not split words.
// The scan reads each word in two views. One view masks a quoted word to one space.
// The other view removes the quotes, so "$X" and $X look the same in `[`. `[` takes no expansion.
// Every other form returns false, so the head stays dynamic.
const TEST_UNARY = new Set(['-n', '-z', '-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h'])
const TEST_BINARY = new Set(['=', '==', '!='])
const TEST_LITERAL = /^[A-Za-z0-9_.\/:@%+,-]+$/
const TEST_EXPANSION = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/
function testBuiltinSafe(head: string, args: readonly string[]): boolean {
  const closer = head === '[[' ? ']]' : ']'
  if (args[args.length - 1] !== closer) return false
  const ops = args.slice(0, -1)
  const ok = (w: string) => TEST_LITERAL.test(w) || w === ' ' || (head === '[[' && TEST_EXPANSION.test(w))
  if (ops.length === 1) return ok(ops[0]!)
  if (ops.length === 2) return TEST_UNARY.has(ops[0]!) && ok(ops[1]!)
  return ops.length === 3 && TEST_BINARY.has(ops[1]!) && ok(ops[0]!) && ok(ops[2]!)
}

// claude-factory-p43v.29: read the comment above `dynamicWord` first, because this function reads
// `{}` as not dynamic. Three sites use it, not `dynamicWord`: `commandAnchors`, and the `cmd[0]`
// check in `anyDynamicCommandReason` and in `anyDynamicLiveApplyReason`. Each site reads a word as
// the actual command. That command is the git or gh binary, or a kubectl, ko or helm tool word.
// A `{}` word there is usually a wrapper's placeholder value, such as `xargs -I {}`, not a tool
// name. This exemption lets `xargs -I {} cp {} dest` and `xargs -I {} delete {}` run.
// claude-factory-qn8a.9.9: bash runs a `$(...)` inside the subscript of `[ -v 'a[$(cmd)]' ]` and of an
// arithmetic operand in `[[ ... -eq ... ]]`, even when quoted. So `[` and `[[` are exempt only when
// the caller passes the segment words and no later word holds `(` or a backtick. Without them, deny.
function dynamicCommandWord(w: string, words?: readonly string[], i?: number): boolean {
  // claude-factory-0hkb: the exact words `[` and `[[` are the test builtin. A word that only starts with `[` stays dynamic.
  if ((w === '[' || w === '[[') && words && i !== undefined && testBuiltinSafe(w, words.slice(i + 1)))
    return false
  return w !== '{}' && dynamicWord(w)
}

// claude-factory-mn2y: external programs cannot change the parent shell's alias table. Never add
// a shell builtin (echo, print, printf, read, typeset, :) to this list.
const ALIAS_SAFE_COMMANDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'git',
  'gh',
  'bd',
  'cat',
  'head',
  'tail',
  'wc',
  'sed',
  'awk',
  'jq',
  'sort',
  'bun',
  'ls',
  'diff',
  'kubectl',
  'docker',
  'ssh',
  'fish',
])

// claude-factory-mn2y: a command word with a slash and no expansion is an external program.
function externalProgram(w: string): boolean {
  return ALIAS_SAFE_COMMANDS.has(w) || (w.includes('/') && !/[$`]/.test(w))
}

// claude-factory-mn2y: any expansion in an argument can build a parameter name (set -A $n'ases').
const NAME_BUILT = /[$`]/

// claude-factory-mn2y: a name-building argument of a command that is not provably external.
function segmentDynArg(words: string[]): boolean {
  return firstHeads(words).some(first => {
    if (
      externalProgram(words[first]!) ||
      words[first] === 'echo' ||
      words[first] === 'cd' ||
      // claude-factory-0hkb: the test builtin writes no alias; its arguments are not names
      ((words[first] === '[' || words[first] === '[[') &&
        testBuiltinSafe(words[first]!, words.slice(first + 1))) ||
      words[first]!.startsWith('#')
    )
      return false
    return words.some((w, i) => i > first && NAME_BUILT.test(w))
  })
}

export { segmentDynArg as segmentDynArgForTest }

// claude-factory-mn2y: true when this segment may define a shell alias.
// W1: a word holds "alias" (any case) and is not provably an argument of a safe program.
// W2: a dynamic command word, then a word with "=" or a dynamic word ($A g=...).
// claude-factory-kuyx: a segment that is "alias" with only plain words (no "=", no expansion)
// lists aliases and defines none, so it is not a define.
function segmentMayDefineAlias(words: string[]): boolean {
  if (words[0] === 'alias' && words.slice(1).every(w => /^[A-Za-z0-9_.:@%+,/-]+$/.test(w))) return false
  const anchors = commandAnchors(words)
  const heads = firstHeads(words)
  const safe = heads.length > 0 && heads.every(h => externalProgram(words[h]!))
  const first = Math.max(...heads)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!/alias/i.test(w)) continue
    if (safe && i > first && !/[$`]/.test(w)) continue
    return true
  }
  for (const a of anchors) {
    if (!dynamicCommandWord(words[a]!, words, a)) continue
    for (let i = a + 1; i < words.length; i++) {
      if (/^[^-=]+=/.test(words[i]!) || /[$`]/.test(words[i]!)) return true
    }
  }
  return false
}
export { segmentMayDefineAlias as segmentMayDefineAliasForTest }

// claude-factory-mn2y: the raw text has no expansion, substitution or brace, and every segment
// is an alias command.
function plainAliasOnly(command: string): boolean {
  const raw = command.replace(/\\\r?\n/g, '')
  if (/[$`()<>{}]/.test(raw)) return false
  const segs = segments(raw)
  return segs.length > 0 && segs.every(w => w[0] === 'alias')
}

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

// claude-factory-qn8a.33
export const GITLAB_PUSH_OPTION_REASON =
  'The factory denies this command: a GitLab merge_request push option other than create, target, ' +
  'target_project, title, draft, label, unlabel, remove_source_branch, milestone, assign or unassign can ' +
  'merge or approve, and a description with a slash command line runs it. Do not retry this exact command.'

const GITLAB_PUSH_OPTION_KEYS = new Set([
  'create',
  'target',
  'target_project',
  'title',
  'draft',
  'label',
  'unlabel',
  'remove_source_branch',
  'milestone',
  'assign',
  'unassign',
])

/**
 * claude-factory-qn8a.33: true when a push option of `git push` or `git send-pack` can merge a GitLab merge
 * request or run a quick action. The option is `-o V`, `--push-option V` or `--push-option=V`, also as a
 * unique prefix of the long name. A short word that holds `o` (`-oV`, `-uoV`) gives the rest of the word,
 * or the next word. This can read extra text, and that only adds a deny.
 * GitLab removes white space from the key and does not anchor the `merge_request.` or `mr.` name, so the
 * hook does the same. That key passes only from a closed list.
 * The `description` key passes when its value has no quick action line.
 */
function pushOptionDenied(pushTail: string[]): boolean {
  for (let i = 0; i < pushTail.length; i++) {
    const w = pushTail[i]!
    if (w === '--') break
    let value: string | undefined
    if (w === '--push-option') value = pushTail[++i]
    else if (/^-[^-]/.test(w) && w.includes('o')) {
      const rest = w.slice(w.indexOf('o') + 1)
      value = rest || pushTail[++i]
    } else if (
      w.startsWith('--') &&
      w.includes('=') &&
      matchesLongFlagPrefix(w.slice(0, w.indexOf('=')), '--push-option')
    )
      value = w.slice(w.indexOf('=') + 1)
    else continue
    const eq = value?.indexOf('=') ?? -1
    const key = (eq < 0 ? (value ?? '') : value!.slice(0, eq)).toLowerCase().replace(/\s+/g, '')
    const m = /(?:merge_request|mr)\.(.*)$/.exec(key)
    if (!m) continue
    if (m[1] === 'description') {
      if (quickActionLine(value!.slice(eq + 1))) return true
    } else if (!GITLAB_PUSH_OPTION_KEYS.has(m[1]!)) return true
  }
  return false
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
  dynamicWord: boolean
} {
  // claude-factory-cu5m: the shell expands or splits a dynamic word before git runs. The word
  // can become `--all`, `--mirror` or `--`. This guard cannot read it, so it tests every word.
  const dynamicWord = tail.some(dynamicPushWord)
  const operands: string[] = []
  let broad = false
  let unreadableValueFlag = false
  let tags = false
  let dryRun = false
  let noDryRun = false
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    // claude-factory-zs39: git reads every word after the first `--` as an operand, never a flag.
    if (w === '--') {
      operands.push(...tail.slice(i + 1))
      break
    }
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
  return { operands, broad, unreadableValueFlag, tags, dryRun: dryRun && !noDryRun, dynamicWord }
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
  const { operands, broad, unreadableValueFlag, tags, dryRun, dynamicWord } = pushOperands(tail)
  // claude-factory-ctae.12: this check must come before the dryRun check. A word that looks
  // like `-n` or `--dry-run`, right after an abbreviated value flag or an `-o` short-flag
  // cluster, is really that flag's own value word. It is not a real dry-run flag.
  if (unreadableValueFlag) return true
  // claude-factory-cu5m: deny a dynamic word before the dryRun check. The word can hide a flag.
  if (dynamicWord) return true
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

// claude-factory-qn8a.33: `push.pushOption` adds a push option to every later push. The hook cannot read it then.
function isPushOptionName(name: string): boolean {
  return name.toLowerCase() === 'push.pushoption'
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
  if (isAliasName(name) || isPushOptionName(name)) return true
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
 *
 * claude-factory-bemr.13: `--config-env` also has a bare 2-word form, `--config-env name=envvar`,
 * with no `=` right after `--config-env` itself. Real git 2.54 runs that form the same as the
 * attached form. This guard checks the same name against the same key list for both forms.
 *
 * claude-factory-bemr.14: this scan steps over the value word of each other flag in
 * `GIT_VALUE_FLAGS` (such as `--attr-source`) before it checks for a literal `--`. Real git 2.54
 * can read that literal `--` as the value word of `--attr-source`, not as the end of the flags.
 * A scan that breaks there, or that does not step over that value word, misses a `-c` or
 * `--config-env` word right after it.
 */
// claude-factory-zl5.34: `--config-env=<name>=<envvar>` sets `<name>` to the text of the
// environment variable `<envvar>`. It sets the same key as `-c <name>=<value>`.
//
// claude-factory-p43v.20: Git 2.54 accepts two forms of `--config-env`. The attached form is
// `--config-env=<name>=<envvar>`. The two-word form is `--config-env <name>=<envvar>`.
// Git 2.54 reads the same environment variable for both forms. `gitDashCPushDenied` checks
// both forms. claude-factory-bemr.13 added the two-word form.
const CONFIG_ENV_PREFIX = '--config-env='

/**
 * This function checks `name` against the key list. For a `-c name=value` write,
 * `gitDashCPushDenied` denies these keys:
 * - `alias.*`
 * - `remote.*.push`
 * - `remote.*.mirror`
 * - `push.default`
 * - `include.path`
 * - `includeIf.*.path`
 *
 * The attached `--config-env=` form uses this check. The two-word form uses it too
 * (claude-factory-bemr.13, claude-factory-p43v.20).
 *
 * This check does not read a value (claude-factory-zl5.34). The guard can read the name of
 * `<envvar>`. It cannot read the text that `<envvar>` holds.
 *
 * The guard cannot test that text against the `push.default` value rule in
 * `isPushConfigWrite`. Without a value to test, this check fails closed.
 * claude-factory-zl5.41 adds the mirror and include keys to the list.
 */
function isDeniedConfigEnvName(name: string): boolean {
  return (
    isRemotePushName(name) ||
    isRemoteMirrorName(name) ||
    isAliasName(name) ||
    isPushDefaultName(name) ||
    isPushOptionName(name) ||
    isIncludeName(name)
  )
}

function gitDashCPushDenied(tail: string[]): boolean {
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w.startsWith(CONFIG_ENV_PREFIX)) {
      const rest = w.slice(CONFIG_ENV_PREFIX.length)
      const eq = rest.indexOf('=')
      if (eq < 0) continue
      if (isDeniedConfigEnvName(rest.slice(0, eq))) return true
      continue
    }
    // claude-factory-bemr.13: the bare 2-word form. Real git reads the next word as `name=envvar`,
    // with no `=` right after `--config-env` itself.
    if (w === '--config-env') {
      const pair = tail[i + 1]
      i++
      const eq = pair?.indexOf('=') ?? -1
      if (pair === undefined || eq < 0) continue
      if (isDeniedConfigEnvName(pair.slice(0, eq))) return true
      continue
    }
    // real git reads `-c name=value` only as 2 separate words: no `=` form, no `--config` form.
    if (w === '-c') {
      const pair = tail[i + 1]
      i++
      const eq = pair?.indexOf('=') ?? -1
      if (pair === undefined || eq < 0) continue
      if (isPushConfigWrite(pair.slice(0, eq), pair.slice(eq + 1))) return true
      continue
    }
    if (w === '--') break
    // claude-factory-bemr.14: step over the value word of every other GIT_VALUE_FLAGS flag
    // (such as `--attr-source`), so a `--` it reads as its own value does not end this scan.
    if (!w.includes('=') && GIT_VALUE_FLAGS.has(w)) {
      i++
      continue
    }
  }
  return false
}

/**
 * True when `pair` hides its key from `isPushConfigWrite`.
 * `pair` is the key=value text of a `-c` or `--config-env` value word.
 * The caller removes the flag name and any `=` prefix first.
 * claude-factory-p43v.9 added this check. claude-factory-p43v.13 extended it.
 *
 * When `pair` has a literal `=`, this function checks only the key part, which is the text before
 * that `=`.
 *
 * `pair` can also be dynamic as a whole, with no literal `=` of its own.
 * The shell expands one word, such as `$KV`, into the whole `key=value` text at run time.
 * `gitDashCKeyDynamic` and `isPushConfigWrite` cannot read a key inside that expansion, so this
 * function checks all of `pair`.
 * For example, `git -c "$KV" p origin main` can set `alias.p=push` through a `$KV` that holds that
 * whole pair. The command line has no `=` to split.
 */
function dashCPairKeyDynamic(pair: string | undefined): boolean {
  if (pair === undefined) return false
  const eq = pair.indexOf('=')
  return dynamicWord(eq >= 0 ? pair.slice(0, eq) : pair)
}

/**
 * True when the key part of a `-c name=value` or `--config-env=name=envvar` flag is dynamic.
 * This check comes from claude-factory-p43v.9.
 * It is the sibling of `gitConfigKeyDynamic`, for the global `-c` or `--config-env` flag that
 * `gitDashCPushDenied` reads right above.
 *
 * `isPushConfigWrite` compares the key with a fixed list of names.
 * The shell does not resolve a dynamic key yet.
 * That comparison cannot match the dynamic key, so the write passes without a check.
 * For example, `git -c $K=push p origin main` can set `alias.p` to `push` with no check at all.
 *
 * This function denies the dynamic key itself, with `DYNAMIC_VERB_REASON`, before
 * `isPushConfigWrite` reads it.
 * `dashCPairKeyDynamic` also covers the case where the whole `-c`/`--config-env` value is dynamic,
 * with no literal `=` of its own (claude-factory-p43v.13).
 */
function gitDashCKeyDynamic(tail: string[]): boolean {
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    if (w === '--') break
    if (w.startsWith(CONFIG_ENV_PREFIX)) {
      if (dashCPairKeyDynamic(w.slice(CONFIG_ENV_PREFIX.length))) return true
      continue
    }
    if (w !== '-c') continue
    if (dashCPairKeyDynamic(tail[i + 1])) return true
  }
  return false
}

// claude-factory-zl5.21: `git config` flags that take a value word of their own. The operand
// search below steps past them, the same way `GIT_PUSH_VALUE_FLAGS` does for `git push`.
const GIT_CONFIG_VALUE_FLAGS = new Set([
  '-f',
  '--file',
  '--blob',
  '-t',
  '--type',
  '--default',
  '--comment',
  '--value',
  '--url',
])

// claude-factory-v5iw: git accepts a unique prefix of a long flag (`--comm`) and a short cluster
// (`-zf`), so both forms take a value word too. A long prefix of one letter or more that starts a
// value flag takes the next word. So does a cluster whose first `f` or `t` is its last letter. Git
// gives the rest of a cluster to the first `f` or `t`, so in `-ft` and `-tf` the next word is the key.
function gitConfigTakesValue(w: string): boolean {
  if (GIT_CONFIG_VALUE_FLAGS.has(w)) return true
  if (w.startsWith('--')) return w.length >= 3 && [...GIT_CONFIG_VALUE_FLAGS].some(f => f.startsWith(w))
  return /^-[a-eg-su-zA-Z]*[ft]$/.test(w)
}

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
/**
 * Reads the key and value operands of a `git config` call's own arguments (`configArgs`).
 * gitConfigSubcommandPushDenied and gitConfigKeyDynamic each need this same scan, so it is one
 * function, not two copies.
 *
 * Returns undefined when `configArgs` names no key operand.
 */
function gitConfigKeyValue(configArgs: string[]): { name: string; value: string | undefined } | undefined {
  const operands: string[] = []
  for (let i = 0; i < configArgs.length; i++) {
    const w = configArgs[i]!
    if (w === '--') {
      operands.push(...configArgs.slice(i + 1))
      break
    }
    if (w.startsWith('-') && w !== '-') {
      if (w.includes('=')) continue
      if (gitConfigTakesValue(w)) i++
      continue
    }
    operands.push(w)
  }
  const start = operands[0] === 'set' ? 1 : 0
  const name = operands[start]
  if (name === undefined) return undefined
  return { name, value: operands[start + 1] }
}

function gitConfigSubcommandPushDenied(configArgs: string[]): boolean {
  const kv = gitConfigKeyValue(configArgs)
  return kv !== undefined && isPushConfigWrite(kv.name, kv.value)
}

/**
 * True when the key operand of `configArgs` is dynamic (claude-factory-p43v). The shell has not
 * resolved this key yet, so isPushConfigWrite cannot check it. The caller denies with
 * DYNAMIC_VERB_REASON, not PUSH_REASON, so it learns to write the key plainly.
 */
function gitConfigKeyDynamic(configArgs: string[]): boolean {
  const kv = gitConfigKeyValue(configArgs)
  return kv !== undefined && dynamicWord(kv.name)
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
  dynamicWord: boolean
} {
  // claude-factory-cu5m: same rule as `pushOperands`. Test every word of `tail`.
  const dynamicWord = tail.some(dynamicPushWord)
  const operands: string[] = []
  let broad = false
  let dryRun = false
  let noDryRun = false
  let stdin = false
  let unsafeValueFlag = false
  for (let i = 0; i < tail.length; i++) {
    const w = tail[i]!
    // claude-factory-zs39: git reads every word after the first `--` as an operand, never a flag.
    if (w === '--') {
      operands.push(...tail.slice(i + 1))
      break
    }
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
  return { operands, broad, stdin, dryRun: dryRun && !noDryRun, unsafeValueFlag, dynamicWord }
}

function sendPackDenied(tail: string[], currentBranch: string | undefined, gate: HookGate): boolean {
  const { operands, broad, stdin, dryRun, unsafeValueFlag, dynamicWord } = sendPackOperands(tail)
  // claude-factory-ctae.12: this check must come before the dryRun check, the same order
  // `gitPushDenied` uses. A word that looks like `-n` or `--dry-run`, right after an
  // abbreviated value flag, is really that flag's own value word. It is not a real dry-run flag.
  if (unsafeValueFlag) return true
  // claude-factory-cu5m: deny a dynamic word before the dryRun check. The word can hide a flag.
  if (dynamicWord) return true
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

// claude-factory-p43v: true when a word in the list is dynamic, before a literal -- word, if
// any. This is the dynamicWord form of hasMutatingWordBeforeDashDash.
//
// One of these words, for one of the branch-change verbs, can hide a rename flag, a stdin flag,
// or a branch name. This guard fails closed on an unread word. It sets state.branchChange.
function hasDynamicWordBeforeDashDash(words: string[]): boolean {
  for (const w of words) {
    if (w === '--') return false
    if (dynamicWord(w)) return true
  }
  return false
}

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
    const { operands, dryRun, dynamicWord } = sendPackOperands(tail)
    // claude-factory-cu5m: keep parser parity with `sendPackDenied`.
    if (dynamicWord) return true
    if (dryRun) return false
    return operands.slice(1).some(isHeadAliasRefspec)
  }
  const { operands, tags, dryRun, dynamicWord } = pushOperands(tail)
  // claude-factory-cu5m: keep parser parity with `gitPushDenied`.
  if (dynamicWord) return true
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
 * True when a word in `tail` is `--git-dir` or starts with `--git-dir=`.
 *
 * claude-factory-bemr.16: this is a plain whole-tail word test.
 *
 * An earlier design also folded every `-C` word into one directory, for `gate.gitAliases`. That
 * fold had to match git's own global-option parser exactly. Three review rounds each found one
 * more case where the fold and git disagreed. Each disagreement let the hook allow a command it
 * should have denied.
 *
 * `gitReason` no longer folds a `-C` directory at all. It reads `gate.gitAliases` at the tool
 * call's own cwd. It denies outright when a `-C` word could move that read elsewhere. See
 * `gate.gitAliases`'s own comment.
 */
function hasGitDirWord(tail: string[]): boolean {
  return tail.some(w => w === '--git-dir' || w.startsWith('--git-dir='))
}

/**
 * `gitChdir` returns this value instead of a dir string when it cannot trust the dir that it folded.
 * A caller must then treat the dir as unknown. It must not call `gate.headOf` with it.
 */
const GIT_CHDIR_UNSAFE = Symbol('git-chdir-unsafe')

/**
 * The function folds every `-C` value in `words` into `base`, in order.
 * Real git folds a repeated `-C` global flag in the same way.
 *
 * An absolute value replaces the dir. For a relative value, the function resolves it against
 * the dir so far, through `resolvePath`. An empty value (`-C ""`) changes nothing.
 *
 * `words` must hold only the words before the git verb (`vi`, see claude-factory-zl5.3).
 * A `-C` after the verb is a refspec word or a similar word. It is not a git global flag.
 * Real git also rejects it as a global flag in that position.
 *
 * claude-factory-3f2z: This change closes the gap. Before this change, a relative `-C <dir>`
 * resolved against the cwd of the hook process. It now resolves against the cwd of the tool
 * call (`base`, from `gate.cwd`).
 *
 * claude-factory-3f2z.7: `-c`, `--git-dir`, `--work-tree` and `--namespace` (the rest of
 * `GIT_VALUE_FLAGS`) also take a value word, with no `=`. The function must step over that
 * value word, the same way `firstVerbIndex` does. So it never reads that word as a `-C` flag.
 *
 * A word before the verb that this function does not know can take a value word of its own.
 * This happens with a git version or flag that this hook does not know.
 * The word is not in `GIT_VALUE_FLAGS`, so `firstVerbIndex` already marks the verb search `uncertain`.
 *
 * In this case, the word after the unknown flag can look like a `-C` flag. That word is really
 * the value of the unknown flag. The word after that can look like the value of a `-C` flag. That
 * word is really the start of the folded dir.
 *
 * This function cannot tell a real `-C <dir>` apart from this case when the value it would fold
 * starts with `-`. A real directory name almost never starts with `-`. So the function fails
 * closed. It returns `GIT_CHDIR_UNSAFE` instead of folding a dir that it cannot trust.
 */
function gitChdir(words: string[], base: string | undefined): string | undefined | typeof GIT_CHDIR_UNSAFE {
  let dir = base
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '-C') {
      const v = words[i + 1]
      i++
      if (!v) continue
      if (v.startsWith('-') && v !== '-') return GIT_CHDIR_UNSAFE
      dir = v.startsWith('/') ? v : resolvePath(dir ?? '', v)
      continue
    }
    if (!w.includes('=') && GIT_VALUE_FLAGS.has(w)) {
      i++
      continue
    }
  }
  return dir
}

/**
 * Returns the reason to deny `cmd`, a command that starts with a `git` word.
 * Returns undefined to allow `cmd`.
 *
 * claude-factory-zl5.3: This finds the `push` verb after the git global flags.
 * These flags are `-C`, `-c`, `--git-dir`, `--work-tree` and `--namespace`.
 * It uses the same method that `ghReason` uses to find the verb of `gh`.
 * `dir` folds every `-C` before the verb onto `gate.cwd`. If `gate.cwd` is unset, `dir` uses
 * `root` instead (claude-factory-3f2z; see `gitChdir`). `gate.headOf(dir)` reads the current branch there.
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
  return (
    gitReasonOn(cmd.slice(1), root, gate, state, moved, aliasDepth) ??
    scanWithoutRedirects(cmd, dropped => gitReasonOn(dropped, root, gate, state, moved, aliasDepth))
  )
}

function gitReasonOn(
  tail: string[],
  root: string | undefined,
  gate: HookGate,
  state: ScanState,
  moved: boolean,
  aliasDepth: number,
): string | undefined {
  // claude-factory-p43v.9: a dynamic -c or --config-env key fails closed before
  // gitDashCPushDenied reads it against a fixed list of names.
  if (gitDashCKeyDynamic(tail)) return DYNAMIC_VERB_REASON
  if (gitDashCPushDenied(tail)) return PUSH_REASON
  const { index: vi, uncertain } = firstVerbIndex(tail, GIT_VALUE_FLAGS, GIT_NO_VALUE_GLOBAL_FLAGS)
  // claude-factory-p43v: the shell can change a dynamic word at the verb slot to any git
  // subcommand. The checks below test the word against a fixed list of names. They miss a
  // dynamic word. This check denies the word first.
  //
  // This check runs before the alias-resolution block below. So that block cannot read the
  // dynamic word as a literal verb name. It cannot look up that word in the alias table.
  if (vi >= 0 && dynamicWord(tail[vi]!)) return DYNAMIC_VERB_REASON
  //
  // claude-factory-p43v: a dynamic word in the arguments of branch, symbolic-ref, rebase, stash,
  // bisect or update-ref can hide a rename flag, a stdin flag or a branch name. This guard fails
  // closed on that word. It does the same for a literal word.
  //
  // Each verb in BRANCH_CHANGE_UNCERTAIN_VERBS is also in GIT_BUILTIN_VERBS. So this check does
  // not reach the alias-resolution block below with one of these verbs. That block skips a
  // builtin verb.
  if (
    vi >= 0 &&
    (gitChangesBranch(tail[vi]!, tail.slice(vi + 1)) ||
      (BRANCH_CHANGE_UNCERTAIN_VERBS.has(tail[vi]!) && hasDynamicWordBeforeDashDash(tail.slice(vi + 1))))
  ) {
    state.branchChange = true
  } else if (uncertain && hasMutatingWordBeforeDashDash(tail, BRANCH_CHANGE_UNCERTAIN_VERBS)) {
    state.branchChange = true
  }
  // See claude-factory-68gn. A --git-dir flag moves the command. It acts the same as a cd word.
  // The effectiveMoved value includes this flag. The dir value does not.
  //
  // If effectiveMoved is true, the function must not use the -C value. A relative -C path
  // resolves against the directory where this hook started. Do not resolve it against the
  // directory where an earlier cd moved the command.
  //
  // claude-factory-bemr.10: --bare moves the command, as --git-dir does. Real git reads a
  // different config file with --bare.
  // `git --bare status` still passes the checks below. The word status is a builtin word, so it
  // never reaches the alias-resolution block.
  //
  // claude-factory-bemr.16: hasGitDirWord is a plain whole-tail word test. It no longer includes
  // a -C directory value. For the reason, read the comment in gate.gitAliases.
  const effectiveMoved = moved || hasGitDirWord(tail) || tail.includes('--bare')
  const verb = vi >= 0 ? tail[vi] : undefined
  //
  // See claude-factory-bemr. This part of the function finds a git alias for the verb.
  // It does not run this part when the verb position is not sure.
  // It also does not run this part when verb is a builtin command.
  // Git uses a builtin command before an alias with the same name. This function does the same.
  //
  // claude-factory-bemr.16: gate.gitAliases always reads the tool call's own cwd. It takes no
  // dir argument. A -C word before the verb can move where real git would read the alias table.
  // This guard does not try to follow that word to a new directory. It denies the command
  // outright instead, under one more condition than before:
  //
  //   0. tail.slice(0, vi), the words before the verb, holds a literal -C word.
  //
  // claude-factory-bemr.7: this part denies the command with ALIAS_USE_REASON under five more
  // conditions:
  //
  //   1. effectiveMoved is true. An earlier cd, pushd, popd, --git-dir or --bare word makes the
  //      alias table unknown for that directory.
  //
  //   2. The alias chain runs deeper than MAX_ALIAS_DEPTH levels. This limit stops a cycle of
  //      aliases, which can stop the hook from completing.
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
    if (tail.slice(0, vi).includes('-C')) return ALIAS_USE_REASON
    if (effectiveMoved) return ALIAS_USE_REASON
    if (aliasDepth > MAX_ALIAS_DEPTH) return ALIAS_USE_REASON
    const table = gate.gitAliases?.()
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
    // This part denies ALIAS_USE_REASON under four conditions:
    //
    //   1. effectiveMoved is true.
    //
    //   2. claude-factory-bemr.16: a literal -C word sits anywhere in tail. This guard cannot
    //      place that word before or after the real verb for sure, so it denies either way.
    //
    //   3. The alias table cannot be read.
    //
    //   4. A non-flag word, anywhere in tail, is both a non-builtin word and a key in the
    //      alias table. That word is a likely alias use. This guard cannot place it for sure.
    //
    // claude-factory-bemr.9: this scan does not stop at a literal --. An unrecognized flag can
    // use -- as its value. For example, `git --attr-source -- zz` runs the `zz` alias.
    // This guard scans every word in tail for the real verb.
    if (effectiveMoved) return ALIAS_USE_REASON
    if (tail.includes('-C')) return ALIAS_USE_REASON
    const table = gate.gitAliases?.()
    if (!table) return ALIAS_USE_REASON
    for (const w of tail) {
      if (w.startsWith('-') && w !== '-') continue
      const lw = w.toLowerCase()
      if (GIT_BUILTIN_VERBS.has(lw)) continue
      if (table.has(lw)) return ALIAS_USE_REASON
    }
  }
  // claude-factory-zl5.21: the `git config` subcommand's own form of the same two writes.
  if (vi >= 0 && tail[vi] === 'config') {
    if (gitConfigKeyDynamic(tail.slice(vi + 1))) return DYNAMIC_VERB_REASON
    if (gitConfigSubcommandPushDenied(tail.slice(vi + 1))) return PUSH_REASON
  }
  let pushTail: string[] | undefined
  let isSendPack = false
  let verbIndex = vi
  // claude-factory-3f2z.8: `vi` can be an unknown flag's value word that reads `push` or
  // `send-pack`. The two branches above now check `!uncertain`, so they no longer trust that word
  // as the verb. The branch below then scans all of `tail` for the first `push` or `send-pack`
  // word instead. That scan can still find the same wrong word, with the real verb later. A `-C`
  // word this guard must read can then sit between the wrong word and the real verb. A literal
  // `-C` word inside `pushTail` is a warning sign of that case: this guard denies the push and
  // does not call `gate.headOf`.
  let uncertainChdirUnsafe = false
  if (vi >= 0 && !uncertain && tail[vi] === 'push') {
    pushTail = tail.slice(vi + 1)
  } else if (vi >= 0 && !uncertain && tail[vi] === 'send-pack') {
    pushTail = tail.slice(vi + 1)
    isSendPack = true
  } else if (uncertain && hasMutatingWordBeforeDashDash(tail, new Set(['push', 'send-pack']))) {
    const pi = tail.indexOf('push')
    const si = tail.indexOf('send-pack')
    if (pi >= 0 && (si < 0 || pi < si)) {
      pushTail = tail.slice(pi + 1)
      verbIndex = pi
    } else if (si >= 0) {
      pushTail = tail.slice(si + 1)
      isSendPack = true
      verbIndex = si
    }
    // claude-factory-3f2z.8: see the comment above `uncertainChdirUnsafe`.
    if (pushTail?.includes('-C')) uncertainChdirUnsafe = true
  }
  if (!pushTail) return undefined
  // claude-factory-3f2z.9: `uncertainChdirUnsafe` can have the value `true`.
  // When it has this value, the verb position that this code finds is not correct.
  // Then `pushTail` is also incorrect, not only `dir`.
  // The correct refspec can be hard to see in an incorrect `pushTail`.
  // It can look like a remote name or one more operand.
  //
  // Git reads the correct verb. That verb is after the incorrect one in the command. Git pushes the current branch to that verb.
  // This guard does not trust `pushTail`, so it cannot parse it.
  // It denies the push directly. It does not get to `gitPushDenied` or `sendPackDenied`.
  if (uncertainChdirUnsafe) return PUSH_DIR_REASON
  // claude-factory-cu5m.6: a dynamic word before the verb can expand to `-c remote.X.push=...` or
  // to a pair that `gitDashCPushDenied` cannot read. This guard denies it before any dry-run check.
  if (tail.slice(0, verbIndex).some(dynamicPushWord)) return PUSH_REASON
  if (pushReadsCurrentBranch(pushTail, isSendPack)) state.headPush = true
  // claude-factory-68gn: a --git-dir flag moves the push the same way a cd does, so it folds into
  // `moved` here instead of into `dir`. Once `moved`, a -C value is not trusted either: a relative
  // -C resolves against the directory this hook started in, not the one a cd already moved to.
  //
  // claude-factory-3f2z: When not moved, `dir` folds every `-C` flag before the verb onto
  // `gate.cwd`, through `gitChdir`. `gate.cwd` is the tool call's own cwd, not the process cwd
  // and not `root` alone.
  const dir = effectiveMoved ? undefined : gitChdir(tail.slice(0, verbIndex), gate.cwd ?? root)
  // claude-factory-3f2z.7: `dir` is `GIT_CHDIR_UNSAFE` when `gitChdir` cannot trust the fold
  // (an unknown flag's value word can be misread as `-C`, and the word after that as the `-C`
  // value). This guard then must not call `gate.headOf` with that symbol: it treats the branch
  // as unknown, the same way it treats `effectiveMoved`, and reports `PUSH_DIR_REASON`.
  const dirUnsafe = dir === GIT_CHDIR_UNSAFE || uncertainChdirUnsafe
  const currentBranch = effectiveMoved || dirUnsafe ? undefined : gate.headOf?.(dir)
  const reason = effectiveMoved || dirUnsafe ? PUSH_DIR_REASON : PUSH_REASON
  if (pushOptionDenied(pushTail)) return GITLAB_PUSH_OPTION_REASON
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

// claude-factory-p43v.5: `anyGitReason` and `anyGhReason` check these words in a `gitReason` or
// `ghReason` call. A dynamic word can sit in the command or subcommand slot and hide one of
// them, with no literal `git` or `gh` word before it. This set names each hidden word.
const DYNAMIC_COMMAND_TRIGGER = new Set([
  'push',
  'send-pack',
  'checkout',
  'switch',
  'branch',
  'symbolic-ref',
  'rebase',
  'stash',
  'bisect',
  'update-ref',
  'config',
  'pr',
  'repo',
  'alias',
  'api',
])

const TRIGGER_ALT = [...DYNAMIC_COMMAND_TRIGGER].join('|')
const DYN_EXP = /\$\{[^{}]*\}|\$[a-z_]\w*|\$[@*#?!$0-9-]/g
const DYN_END_R1 = new RegExp(`(?:^|-)(?:${TRIGGER_ALT})$`)
const DYN_END_R2 = new RegExp(`.(?:${TRIGGER_ALT})$`)

/**
 * claude-factory-ycaq: `$G-push` runs the `git-push` binary when `$G` holds a git-core path.
 * The dashed-binary rule cannot read a dynamic word. This function treats every expansion as
 * possibly empty. It drops quotes and backslashes and makes the word lowercase (APFS is
 * case-blind). R1: remove every expansion. Deny when the text left ends in a verb at the start
 * or after a dash. R2: the tokenizer drops quotes, so `"$G"push` reads as the bare name `$Gpush`.
 * For each bare name, deny when the name and the rest end in any char and a verb. The caller runs
 * this in the late fallback, so a real command reason (glued IFS push) wins.
 */
function dynamicDashedVerb(w: string): boolean {
  const s = w.replace(/\\\n/g, '').replace(/\\/g, '').replace(/["']/g, '').toLowerCase()
  if (DYN_END_R1.test(s.replace(DYN_EXP, ''))) return true
  for (const m of s.matchAll(/\$([a-z_]\w*)/g)) {
    const name = m[1]!
    const rest = s.slice(m.index! + m[0].length)
    if (DYN_END_R2.test(name + rest.replace(DYN_EXP, ''))) return true
  }
  return false
}

/**
 * claude-factory-clcc: bash and zsh expand a glob in the command word, so `/bin/[r]m -rf /` runs
 * rm. A word is a glob command word when it holds `*`, `?` or a `[..]` pair. A lone `[` or `[[`
 * is not a glob. An array assignment (`A[1]=x`) is not a command word. A glob that can match a
 * shell name and is followed by `-c` stays allowed only when every file it matches is a shell:
 * the shell scan then reads that script. The shell runs the first match.
 */
function globCommandWord(w: string, next?: string): boolean {
  if (!/[*?]/.test(w) && !/\[[\s\S]*\]/.test(w)) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*\[[\s\S]*\]\+?=/.test(w)) return false
  if (next === '-c' && globMatchesShellName(w)) return false
  return true
}

const ROOT_BIN_DIRS = new Set(['/bin', '/usr/bin', '/sbin', '/usr/sbin'])

function globMatchesShellName(g: string): boolean {
  const slash = g.lastIndexOf('/')
  const dir = slash < 0 ? '.' : g.slice(0, slash) || '/'
  // claude-factory-clcc.10: only a fixed root-owned dir. A relative glob depends on a cwd that an
  // earlier cd can change, and a writable dir can change between this check and the run.
  if (!ROOT_BIN_DIRS.has(dir)) return false
  const leaf = g.slice(slash + 1)
  let re = ''
  for (let i = 0; i < leaf.length; i++) {
    const c = leaf[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const j = leaf.indexOf(']', i + 1)
      if (j < 0) return false
      re += leaf.slice(i, j + 1).replace(/^\[!/, '[^')
      i = j
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  try {
    const r = new RegExp('^' + re + '$')
    // The shell runs the first match, so every match must be a shell.
    const hits = readdirSync(dir).filter(n => r.test(n) && (leaf.startsWith('.') || !n.startsWith('.')))
    return hits.length > 0 && hits.every(n => SHELL_NAMES.has(n))
  } catch {
    return false
  }
}

/** True when a glob command word sits at any command anchor of `words`. */
function anyGlobCommandWord(words: string[]): boolean {
  return commandAnchors(words).some(a => globCommandWord(words[a]!, words[a + 1]))
}

// claude-factory-38jm: a brace word with a comma or a `..` range.
const BRACE_LIST_WORD = /\{[^{}]*(,|\.\.)[^{}]*\}/

/**
 * The function returns `DYNAMIC_VERB_REASON` for a segment where a dynamic word hides the real
 * command (claude-factory-p43v.5). No wrapper that this hook knows by name names the command.
 * No `git`, `gh` or `git-*` word names it either. It returns undefined to allow `words`.
 *
 * This function checks two cases.
 *
 * AC8: `realCommand(words)` reduces to one bare word. That word is `$`.
 *
 * It can also end in the backtick marker that `segments()` leaves on an unquoted opening
 * backtick (claude-factory-p43v.2). Both forms mean that a substitution gives the command name.
 * This hook cannot read that substitution. It denies the segment outright.
 *
 * AC7: the function uses a one-pass, lazy-pointer scan over the rest of the segment.
 * Its cost is O(n).
 *
 * No dynamic word starts its own scan (claude-factory-p43v.5 AC10). The scan keeps track of
 * one fact. That fact is whether a literal `git`, `gh` or `git-*` word ran earlier.
 * Before such a word runs, the hook denies a dynamic word in two cases.
 *
 * - First, its next non-flag word is in `DYNAMIC_COMMAND_TRIGGER`.
 *   The scan skips the value word of a `GIT_VALUE_FLAGS` or `GH_VALUE_FLAGS` flag.
 * - Second, a `-c name=value` flag follows it directly.
 *   The key is one that `isPushConfigWrite` denies. This is the dynamic-command-word form of
 *   `gitDashCPushDenied`.
 * - Third, a `--config-env name=envvar` or `--config-env=name=envvar` flag follows it directly.
 *   The key is one that `isDeniedConfigEnvName` denies (claude-factory-p43v.20). This is the
 *   dynamic-command-word form of the `--config-env` check in `gitDashCPushDenied`.
 *
 * A run of flags does not count as "the next word" by itself.
 * The run passes the dynamic word on to the next word.
 *
 * claude-factory-p43v.8: the AC7 scan above marks a dynamic word as "shown" when it reads it.
 * The scan never checks the word right after a dynamic word against `dynamicWord`.
 * It checks that word only against `DYNAMIC_COMMAND_TRIGGER`.
 * So `$G $V origin main` (after `G=git V=push`) reads `$G` as the command.
 * It never checks `$V`. `$V` is not in `DYNAMIC_COMMAND_TRIGGER`, so the old scan moves on.
 *
 * This check runs first, for each index `a` in `commandAnchors(words)`.
 * It uses `cmd = words.slice(a)` each time.
 *
 * Claude-factory-p43v.21: `commandAnchors` can find an index behind a wrapper flag this hook
 * does not know by name. `realCommand(words)[0]` alone used to find the wrong word there, or no
 * word at all.
 *
 * The check denies when `cmd[0]` is dynamic and the next non-flag word in `cmd` is dynamic too.
 * Because of this start point, `cp "$A" "$B"` and `"$PY" -c 'print(1)'` pass the check.
 * Neither `cp` nor the script word of `"$PY" -c` is the second dynamic word in a pair that
 * starts at the command slot.
 */
function anyDynamicCommandReason(words: string[], braceWords: Set<string>): string | undefined {
  const own = anyDynamicCommandReason1(words, braceWords)
  if (own) return own
  for (const body of braceBodies(words, braceWords).slice(0, MAX_BRACE_BODIES)) {
    const r = anyDynamicCommandReason1(body)
    if (r) return r
  }
  return undefined
}
function anyDynamicCommandReason1(words: string[], braceWords?: Set<string>): string | undefined {
  for (const a of commandAnchors(words)) {
    // A glued `{word` at an anchor opens a group. braceBodies reads its body as a command.
    if (braceWords && words[a] !== '{' && braceOpensGroup(words[a]!, braceWords)) continue
    // claude-factory-mmc9.6: segments() ends a word at `(`, so `A[(r)x]=x cmd` leaves the word `A[` at
    // the anchor. zsh runs that as an assignment with a subscript flag. Deny a name-and-bracket
    // anchor word that is not a whole assignment word.
    if (SUBSCRIPT_NAME_RE.test(words[a]!) && !shellAssignmentWord(words[a]!)) {
      return DYNAMIC_VERB_REASON
    }
    // claude-factory-38jm: bash expands `{sh,-c}` into two words before it runs the command. A
    // brace list or range at a command anchor can hide the whole command. `{}` alone (xargs -I) has
    // no comma and no `..`, so it stays allowed.
    if (BRACE_LIST_WORD.test(words[a]!)) return DYNAMIC_VERB_REASON
    // claude-factory-teku: `$_` is the last argument of the previous command, so it can hold any
    // command, and no NAME=value in the text sets it. It is never a legitimate command head.
    if (LAST_ARG_HEAD.test(words[a]!)) return DYNAMIC_VERB_REASON
    const cmd = words.slice(a)
    if (cmd.length === 1 && (cmd[0] === '$' || cmd[0]!.endsWith('`'))) return DYNAMIC_VERB_REASON
    // claude-factory-p43v.29: this reads `cmd[0]` as if it names the real command (the git or gh
    // binary). `dynamicCommandWord` reads `{}` as not dynamic here; see the comment above it.
    if (cmd.length > 0 && dynamicCommandWord(cmd[0]!, cmd, 0)) {
      let k = 1
      while (k < cmd.length) {
        const w = cmd[k]!
        if (!w.startsWith('-') || w === '-') break
        k += GIT_VALUE_FLAGS.has(w) || GH_VALUE_FLAGS.has(w) ? 2 : 1
      }
      if (k < cmd.length && dynamicWord(cmd[k]!)) return DYNAMIC_VERB_REASON
    }
  }

  let sawGitWord = false
  let pendingDynamic = false
  for (let i = 0; i < words.length;) {
    const w = words[i]!
    const b = baseWord(w)
    if (b === 'git' || b === 'gh' || GIT_DASHED_BINARY.test(b)) {
      sawGitWord = true
      pendingDynamic = false
      i++
      continue
    }
    if (w.startsWith('-') && w !== '-') {
      if ((w === '-c' || w === '--config-env') && !sawGitWord && pendingDynamic) {
        const pair = words[i + 1]
        // claude-factory-p43v.14: a dynamic key, or a pair with no literal `=` of its own,
        // fails closed the same way `gitDashCKeyDynamic` does for a literal `git` command.
        if (dashCPairKeyDynamic(pair)) return DYNAMIC_VERB_REASON
        const eq = pair?.indexOf('=') ?? -1
        if (pair !== undefined && eq >= 0) {
          const name = pair.slice(0, eq)
          // claude-factory-p43v.20: `--config-env`'s two-word form reads an envvar name, not a
          // value, so it uses `isDeniedConfigEnvName`'s key-only check, not `isPushConfigWrite`.
          const denied =
            w === '-c' ? isPushConfigWrite(name, pair.slice(eq + 1)) : isDeniedConfigEnvName(name)
          if (denied) return DYNAMIC_VERB_REASON
        }
      }
      // claude-factory-p43v.20: the attached `--config-env=name=envvar` form of the same flag.
      if (w.startsWith(CONFIG_ENV_PREFIX) && !sawGitWord && pendingDynamic) {
        const pair = w.slice(CONFIG_ENV_PREFIX.length)
        if (dashCPairKeyDynamic(pair)) return DYNAMIC_VERB_REASON
        const eq = pair.indexOf('=')
        if (eq >= 0 && isDeniedConfigEnvName(pair.slice(0, eq))) return DYNAMIC_VERB_REASON
      }
      i += GIT_VALUE_FLAGS.has(w) || GH_VALUE_FLAGS.has(w) || w === '--config-env' ? 2 : 1
      continue
    }
    if (!sawGitWord && pendingDynamic && DYNAMIC_COMMAND_TRIGGER.has(w)) return DYNAMIC_VERB_REASON
    pendingDynamic = !sawGitWord && dynamicWord(w)
    i++
  }
  return undefined
}

/**
 * True when a word in `words` is a bare `kubectl`, `ko`, `helm` or `flux` token. From that word on, the
 * words must start a mutating command denied by `personOnly`.
 * claude-factory-25z.12: this hook does not know every wrapper by name (`eval`, `find -exec`,
 * `xargs`, `timeout` with flags, `watch`, `nix shell ... -c`, `direnv exec`). A wrapper it does not
 * know must not hide that word. So this checks every position in the segment, not only the head.
 * A word that only contains the text "kubectl" does not match. This covers a quoted argument, a
 * path, and an unrelated flag value.
 */
function anyLiveApplyWord(words: string[], personOnly: string[]): boolean {
  const anchors = commandAnchors(words)
  for (let j = 0; j < words.length; j++) {
    const bw = baseWord(words[j]!)
    if (
      (bw === 'kubectl' || bw === 'ko' || bw === 'helm' || bw === 'flux') &&
      // flux fails closed on an unknown verb, but only where a command really starts.
      liveApplyDenied(words.slice(j), personOnly, anchors.includes(j))
    ) {
      return true
    }
  }
  return false
}

/**
 * Returns true when `liveApplyDenied` denies `cmd`, with `tool` substituted at its own position 0.
 * The `anyDynamicLiveApplyReason` function cannot know what a dynamic word resolves to at run time.
 * The word can be `kubectl`, `ko`, `helm` or `flux`.
 * This function checks all 4 tools. It fails closed when any one of them is denied (claude-factory-p43v.16).
 */
function anyToolLiveApplyDenied(tail: string[], personOnly: string[]): boolean {
  return ['kubectl', 'ko', 'helm', 'flux'].some(tool => liveApplyDenied([tool, ...tail], personOnly))
}

/**
 * Returns `DYNAMIC_VERB_REASON` when a dynamic word hides a mutating `kubectl`, `ko` or `helm` call.
 * Returns undefined to allow `words`.
 *
 * `liveApplyDenied` runs only after `anyLiveApplyWord` finds a literal `kubectl`, `ko` or `helm` word.
 * A dynamic word, such as `$K` in `$K apply -f x --context acme`, is none of those 3 literal words.
 * That scan never calls `liveApplyDenied` for such a word (claude-factory-p43v.10).
 *
 * This function checks two cases. Both cases use `anyToolLiveApplyDenied`, which owns every verb,
 * sub-verb, flag and context rule that `liveApplyDenied` has.
 *
 * First, `realCommand(words)` can open with a dynamic word. This is the `cmd[0]` anchor from
 * claude-factory-p43v.8. This case also covers a dynamic kubectl rollout, auth or certificate
 * sub-verb, such as `$K rollout restart deploy/x --context acme` (claude-factory-p43v.16).
 * The old code checked only a flat verb set, so it missed every sub-verb rule.
 *
 * Second, an unknown wrapper, such as `caffeinate`, can move a dynamic word past position 0
 * (claude-factory-p43v.16). This case checks every position in `words`, the same way
 * `anyLiveApplyWord` checks a literal tool name.
 *
 * This wider check applies only when an explicit `--context` or `--kube-context` flag names a
 * context in `personOnly`. A rule that fails closed when the command names no context, applied
 * at every position, would deny far too much. The word after any dynamic word need not name a
 * live-apply tool at all (claude-factory-p43v.17).
 *
 * Either case returns `DYNAMIC_VERB_REASON`, not `LIVE_REASON`. `LIVE_REASON` names `kubectl`,
 * `ko` or `helm` outright.
 *
 * This function never reads one of those 3 literal words. A dynamic word, such as `$PIP` in
 * `$PIP install requests`, can also match a mutating verb of a tool that this hook never names
 * (claude-factory-p43v.17). `DYNAMIC_VERB_REASON` names the real cause instead. An unreadable
 * word sits at the command slot.
 */
function anyDynamicLiveApplyReason(
  words: string[],
  personOnly: string[],
  braceWords: Set<string>,
): string | undefined {
  const own = anyDynamicLiveApplyReason1(words, personOnly)
  if (own) return own
  for (const body of braceBodies(words, braceWords).slice(0, MAX_BRACE_BODIES)) {
    const r = anyDynamicLiveApplyReason1(body, personOnly)
    if (r) return r
  }
  return undefined
}
function anyDynamicLiveApplyReason1(words: string[], personOnly: string[]): string | undefined {
  // claude-factory-p43v.21: `commandAnchors` can name an index behind a wrapper flag this hook
  // does not know by name, where `realCommand(words)[0]` alone finds the wrong word.
  // claude-factory-p43v.29: this reads `cmd[0]` as if it names a kubectl, ko or helm tool word.
  // `dynamicCommandWord` reads `{}` as not dynamic here; see the comment above it.
  for (const a of commandAnchors(words)) {
    const cmd = words.slice(a)
    if (
      cmd.length &&
      dynamicCommandWord(cmd[0]!, cmd, 0) &&
      anyToolLiveApplyDenied(cmd.slice(1), personOnly)
    ) {
      return DYNAMIC_VERB_REASON
    }
  }
  for (let j = 0; j < words.length; j++) {
    if (!dynamicWord(words[j]!)) continue
    const rest = words.slice(j + 1)
    const ctx = flagValue(rest, new Set(['--context', '--kube-context']))
    if (ctx === undefined || !personOnly.includes(ctx)) continue
    if (anyToolLiveApplyDenied(rest, personOnly)) return DYNAMIC_VERB_REASON
  }
  return undefined
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
 * `nc` holds the next index at or after the current `j` whose word passes `possibleShCCluster`.
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
 * approximation. No test compares it with the old function. src/worker-hook.test.ts holds the two
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

// claude-factory-s1fj: env reads a word that starts with # in an -S value as a comment to the end
// of the value. It keeps the words after the value. Cut the value there, as env does.
// A # inside single or double quotes is part of a word, so track quote state.
function envSplitCommentCut(val: string): string {
  let quote = ''
  for (let i = 0; i < val.length; i++) {
    const c = val[i]!
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"') i++
    } else if (c === "'" || c === '"') quote = c
    else if (c === '\\') i++
    else if (c === '#' && (i === 0 || /[ \t\n\v\f\r]/.test(val[i - 1]!))) return val.slice(0, i)
  }
  return val
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
  vars?: VarTable,
): string | undefined {
  let nc = -1
  let nd = -1
  let scriptNc = -1
  let dynChecked = -1
  let scriptK = 0
  let scriptMoved = false
  let slotEnd = 0
  let trapEnd = 0
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
      const r = denyAt(val, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore, [], vars)
      if (r) return r
      // claude-factory-s1fj: env inserts the split words into argv and keeps parsing the words
      // after the value. Rebuild that argv and scan it, so a shell word in the value reaches
      // the sh -c scan with the script that follows it. The shape matches envOptionScan.
      const span = envSplitStringScan(words, j)!
      const sWord = words[span.sIndex]!
      const prefix =
        sWord.startsWith('-') && !sWord.startsWith('--') ? sWord.slice(1, sWord.indexOf('S')) : ''
      const argv = [
        'env',
        ...words.slice(j + 1, span.sIndex),
        ...(prefix ? ['-' + prefix] : []),
        ...segments(envSplitCommentCut(val)).flat(),
        ...words.slice(span.end),
      ]
      const line = argv.map(requoteWord).join(' ')
      return denyAt(line, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore, [], vars)
    }
    if (shellSlotWord(words[j]!)) {
      // claude-factory-38jm: a shell word below slotEnd is a value word of an earlier walk. Its
      // walk is a suffix of that one, so it ends the same way. Skipping it keeps the scan O(n).
      if (j >= slotEnd) {
        const walk = shOptionSlotWalk(words, j)
        if (walk.dynamic && SHELL_NAMES.has(bw)) return SH_DYNAMIC_FLAG_REASON
        slotEnd = walk.end
      }
      if (nc < j) {
        nc = j
        // A dynamic shell word is no literal shell name, so a dynamic word after it is no flag.
        // That keeps nc fixed over a run of such words and the script memo O(n).
        const isClusterAt = SHELL_NAMES.has(bw) ? possibleShCCluster : isShCCluster
        while (nc < words.length && !isClusterAt(words[nc]!)) nc++
      }
      if (nd < j) {
        nd = j
        while (nd < words.length && words[nd] !== '--') nd++
      }
      if (nc >= nd) continue
      const literal = SHELL_NAMES.has(baseWord(words[j]!))
      // claude-factory-3frd: only a literal shell name before the -c cluster makes it a shell call.
      if (dynChecked !== nc) {
        dynChecked = nc
        if (isShCCluster(words[nc]!) && words.slice(0, nc).some(w => SHELL_NAMES.has(baseWord(w)))) {
          for (let d = nc; d < words.length; d++) {
            if (/[$`]/.test(words[d]!)) {
              state.dynamicScript = true
              break
            }
          }
        }
      }
      if (scriptNc === nc && scriptMoved === moved) {
        if (literal) j = scriptK
        continue
      }
      let k = nc + 1
      let found: string | undefined
      for (; k < words.length; k++) {
        const w = words[k]!
        if (w === '--') {
          k++
          if (k < words.length)
            found = denyAt(
              words[k]!,
              root,
              personOnly,
              gate,
              depth + 1,
              state,
              moved,
              ghConfigMovedBefore,
              [],
              vars,
            )
          break
        }
        if (w.startsWith('-')) continue
        found = denyAt(w, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore, [], vars)
        if (found) break
      }
      if (found) return found
      scriptNc = nc
      scriptK = k
      scriptMoved = moved
      if (literal) j = k
      continue
    }
    if (bw === 'trap') {
      // claude-factory-81tz: the trap action is a script the shell runs later. Read it like an eval script.
      // claude-factory-81tz.3: a trap word below trapEnd is a dash word of an earlier walk. That walk
      // already read its words and the action. Skipping it keeps the scan O(n).
      if (j < trapEnd) continue
      // claude-factory-81tz.5: a redirect word can sit before the action, so read every word to the end.
      // claude-factory-81tz.6, .7: the action runs at exit, after every later word (a cd, a config
      // env). Read each word after trap with all later-state flags on.
      for (let k = j + 1; k < words.length; k++) {
        const o = denyAt(words[k]!, root, personOnly, gate, depth + 1, state, true, true)
        if (o) return o
      }
      trapEnd = words.length
      continue
    }
    if (bw === 'eval') {
      const rest = words.slice(j + 1)
      // bash eval has no options, and zsh eval skips every leading `-` word, also after `--`: drop each one, none is the script head.
      while (rest.length && ['--', '-'].includes(rest[0]!.replace(/["'\\]/g, ''))) rest.shift()
      if (rest.length) {
        const r = denyAt(
          rest.join(' '),
          root,
          personOnly,
          gate,
          depth + 1,
          state,
          moved,
          ghConfigMovedBefore,
          [],
          vars,
        )
        if (r) return r
      }
      break
    }
  }
  // claude-factory-ibas: run last, so an earlier rule keeps its own reason.
  for (const t of dynamicHeadScripts(words)) {
    const r = denyAt(t, root, personOnly, gate, depth + 1, state, moved, ghConfigMovedBefore, [], vars)
    // A here-string keeps its own, more specific reason (SHELL_STDIN_REASON). The tokenizer drops
    // quotes, so a quoted here-string token looks the same: it still denies, with that reason.
    if (r) return words.some(w => w.includes('<<<')) ? SHELL_STDIN_REASON : r
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

// claude-factory-zzxp: the per-spawn cap of the two alias reads. Only a plain decimal integer
// in 1..GATE_BUDGET_MS counts. Every other value gives 2000, so a bad value still fails closed.
export function aliasSpawnCapMs(v: string | undefined): number {
  return v !== undefined && /^[1-9][0-9]{0,3}$/.test(v) && Number(v) <= GATE_BUDGET_MS ? Number(v) : 2000
}
// Test knob, default 2000. The factory never sets it.
const ALIAS_SPAWN_CAP_MS = aliasSpawnCapMs(process.env.FACTORY_HOOK_ALIAS_TIMEOUT_MS)

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
        if (remaining > 0) result = real(Math.min(ALIAS_SPAWN_CAP_MS, remaining))
      }
      return result
    }
  }
  // claude-factory-bemr: gitAliases spawns git config at most one time for one denyReason call.
  // claude-factory-bemr.16: gate.gitAliases takes no dir argument any more: it always reads the
  // tool call's own cwd, so one cached value covers the whole call, the same way memo.ghAliases
  // does above.
  if (gate.gitAliases) {
    const real = gate.gitAliases
    let called = false
    let result: Map<string, string> | undefined
    memo.gitAliases = () => {
      if (!called) {
        called = true
        const remaining = deadline - Date.now()
        if (remaining > 0) result = real(Math.min(ALIAS_SPAWN_CAP_MS, remaining))
      }
      return result
    }
  }
  // claude-factory-usqc: the same for shellFunctions.
  if (gate.shellFunctions) {
    const real = gate.shellFunctions
    let called = false
    let result: Set<string> | undefined
    memo.shellFunctions = () => {
      if (!called) {
        called = true
        result = real()
      }
      return result
    }
  }
  // claude-factory-1zr5: shellAliases reads the snapshot folder at most one time for one denyReason call.
  if (gate.shellAliases) {
    const real = gate.shellAliases
    let called = false
    let result: Map<string, string | null> | undefined
    memo.shellAliases = () => {
      if (!called) {
        called = true
        result = real()
      }
      return result
    }
  }
  return memo
}

// claude-factory-jluz.1: the repo is public. A worker must not publish a private name in a PR or issue text.
export const privateTextReason = (command: string, gate?: HookGate): string | undefined => {
  if (!gate?.privateHits) return undefined
  const files = new Set<string>()
  let publishes = false
  for (const words of segments(command)) {
    const f = ghPublishFiles(words)
    if (f) publishes = true
    for (const x of f ?? []) files.add(x)
  }
  if (!publishes) return undefined
  const found: string[] = []
  const lines = gate.privateHits(command)
  if (lines === undefined) return undefined
  if (lines.length) found.push(`the command text (${lineList(lines)})`)
  for (const f of files) {
    const text = gate.readFile?.(f)
    if (text === undefined)
      return `${PRIVATE_TEXT_PREFIX}the body file ${f} cannot be read, so it cannot be checked. Write the body to a plain file first, then name that file.`
    const hits = gate.privateHits(text) ?? []
    if (hits.length) found.push(`${f} (${lineList(hits)})`)
  }
  return found.length
    ? `${PRIVATE_TEXT_PREFIX}the text would publish private names. Matches: ${found.join('; ')}. Use placeholders such as acme in the title and body. Do not retry this exact command.`
    : undefined
}
const PRIVATE_TEXT_PREFIX = 'The factory denies this command: '
const lineList = (n: number[]) => (n[0] === 0 ? 'the check failed' : `line ${n.join(', ')}`)

/** The body files of a `gh` call that publishes text to GitHub, or undefined for any other call. */
function ghPublishFiles(words: string[]): string[] | undefined {
  const cmd = realCommand(words)
  if (baseWord(cmd[0] ?? '') !== 'gh') return undefined
  const tail = cmd.slice(1)
  const { index: vi } = firstVerbIndex(tail, GH_VALUE_FLAGS)
  const verb = vi >= 0 ? tail[vi] : undefined
  const rest = vi >= 0 ? tail.slice(vi + 1) : []
  if (verb === 'pr' || verb === 'issue') {
    const { index: si } = firstVerbIndex(rest, GH_SUB_VALUE_FLAGS)
    const sub = si >= 0 ? rest[si] : undefined
    const subs = verb === 'pr' ? ['create', 'edit', 'comment', 'review'] : ['create', 'edit', 'comment']
    if (sub === undefined || !subs.includes(sub)) return undefined
    return flagValuesInOrder(rest.slice(si + 1), new Set(['-F', '--body-file']))
  }
  if (verb !== 'api') return undefined
  const apiArgs = expandGhShortClusters(rest)
  const { index: ei } = firstVerbIndex(apiArgs, GH_API_VALUE_FLAGS)
  const endpoint = ei >= 0 ? apiArgs[ei] : undefined
  if (!endpoint || !/(^|\/)(pulls|issues)(\/|$)/.test(decodeApiPath(normalizeEndpoint(endpoint)) ?? endpoint))
    return undefined
  const fields = ghApiFields(apiArgs)
  const input = flagValue(apiArgs, new Set(['--input']))
  const method = (flagValue(apiArgs, new Set(['-X', '--method'])) ?? '').toUpperCase()
  if ((method || (fields.length > 0 || input !== undefined ? 'POST' : 'GET')) === 'GET') return undefined
  const files = fields.filter(f => f.value.startsWith('@')).map(f => f.value.slice(1))
  return input === undefined ? files : [...files, input]
}

/** claude-factory-jluz.1: for `gate.privateHits`. grep runs the patterns, so the match is the one the commit guard makes. */
export function privateHitLines(text: string, cwd: string): number[] | undefined {
  try {
    const g = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--git-common-dir'], { timeout: 5000 })
    if (g.exitCode !== 0) return undefined
    const file = resolvePath(cwd, g.stdout.toString().trim(), 'info', 'private-patterns')
    const pats = readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
    if (!pats.length) return undefined
    const p = Bun.spawnSync(['grep', '-n', '-i', '-E', ...pats.flatMap(x => ['-e', x])], {
      stdin: Buffer.from(text),
      timeout: 5000,
    })
    if (p.exitCode === 1) return []
    if (p.exitCode !== 0) return [0]
    return p.stdout
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(l => Number.parseInt(l, 10))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : [0]
  }
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
 * claude-factory-qn8a.30: a last backslash gets one added newline first, as the Bash tool adds one.
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
  // claude-factory-qn8a.30: the Bash tool adds a newline, so a last backslash joins the next line
  if (command.endsWith('\\')) command += '\n'
  // the home guard reads the text first (with the added newline): no parse bypass can reach a delete of $HOME
  const home = homeReason(command, gate?.readFile)
  if (home) return home
  if (rawActorFlag(command)) return BEADS_ACTOR_REASON
  const now = gate?.now ?? Date.now
  const scan = scanReason(command, root, personOnly, gate, MAX_SCAN_WORK, now() + SCAN_TIME_MS)
  if (scan) return scan
  // claude-factory-qn8a.19: a read of a harness token file or dir. It reads the raw text, not the parse.
  return tokenReason(command, gate?.cwd ?? root ?? process.cwd(), root) ?? privateTextReason(command, gate)
}

/**
 * claude-factory-qn8a.26: true when the raw text has a bd token and a flag token (--act, --acto
 * or --actor). The check ignores segment edges, quotes and backslashes. A substitution, a heredoc
 * or an `sh -c` text cannot hide the flag. Text that only names the flag is also denied (fail
 * closed). A dynamic word (variable, brace, glob, xargs) is not covered: claude-factory-qn8a.97.
 */
function rawActorFlag(command: string): boolean {
  const flat = command.replace(/\\\n/g, '').replace(/['"\\]/g, '')
  return /(?<![\w.-])bd(?![\w.-])/i.test(flat) && /(?<![\w-])--act(?:or?)?(?![\w-])/.test(flat)
}

/**
 * claude-factory-mozp: returns true when a comment line ends in a backslash and more text follows.
 * A comment starts at a `#` that begins a word. The shell keeps the backslash, so the next line
 * runs as a command. segments() joins the two lines. The check reads the raw text, one test for
 * each line, so the cost is linear. A `#` after a space inside quotes also counts. That is a
 * deny that is not needed, which is safe.
 */
function commentLineContinues(cmd: string): boolean {
  let k = cmd.indexOf('#')
  while (k !== -1) {
    if (k === 0 || /[\s;&|()<>`]/.test(cmd[k - 1]!)) {
      const e = cmd.indexOf('\n', k)
      if (e === -1) return false
      if (cmd[e - 1] === '\\' && /\S/.test(cmd.slice(e + 1))) return true
      k = cmd.indexOf('#', e)
    } else {
      k = cmd.indexOf('#', k + 1)
    }
  }
  return false
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
  budget: number = MAX_SCAN_WORK,
  deadline: number = Infinity,
): string | undefined {
  const state: ScanState = {
    branchChange: false,
    headPush: false,
    gitAdminPath: false,
    stdinFed: /[|<]|>\(|=\(|\bcoproc\b/.test(command),
    stdinDeferred: false,
    ifsLate: false,
    globDeferred: false,
    bodyDeny: false,
    cfgGlob: false,
    dynamicScript: false,
    globalGitConfig: false,
    hookControl: false,
    gitWord: false,
    aliasWrite: false,
    aliasArgsOff: false,
    dynArg: false,
    substFallbacks: 0,
    outer: NO_OTHER_SEGS,
    braceWords: new Set(),
    quotedBraces: new Map(),
    work: budget,
    deadline,
    now: gate?.now ?? Date.now,
    timedOut: false,
    aliasSeen: new Map(),
  }
  const deferred = () =>
    state.stdinDeferred
      ? SHELL_STDIN_REASON
      : state.dynamicScript
        ? SH_DYNAMIC_SCRIPT_REASON
        : state.globDeferred
          ? DYNAMIC_VERB_REASON
          : undefined
  const g = memoGate(gate ?? {})
  const reason = denyAt(command, root, personOnly, g, 0, state, false, false)
  if (state.timedOut) return SCAN_TIME_REASON
  if (reason) {
    if (!(state.ifsLate && state.stdinDeferred && reason === REASON)) return reason
    const aliasDef = state.aliasWrite && !plainAliasOnly(command)
    return aliasDef ? SHELL_ALIAS_DEFINE_REASON : SHELL_STDIN_REASON
  }
  // claude-factory-ty8y: a global git config path word plus any git word denies, before the
  // headPush check, because an alias call sets no headPush.
  if (state.globalGitConfig && (state.gitWord || commandHasGitWord(command))) return GLOBAL_GIT_CONFIG_REASON
  if (state.bodyDeny && !state.stdinDeferred) return REASON
  if (state.cfgGlob && !state.stdinDeferred)
    return state.globDeferred ? DYNAMIC_VERB_REASON : FACTORY_CONFIG_REASON
  if (state.hookControl) return state.stdinDeferred ? SHELL_STDIN_REASON : HOOK_CONTROL_REASON
  if (state.cfgGlob) return FACTORY_CONFIG_REASON
  // claude-factory-mn2y: an alias the command defines is not in gate.shellAliases. A later eval,
  // trap, source or substitution reads it after this hook ran. Deny unless the command is only
  // plain alias segments.
  // A name built from an expansion can write the aliases table (set -A ${n}ases g ...), so an
  // expansion argument plus a second segment or a substitution counts as a write too.
  const dynWrite = state.dynArg && /[;&|\n`]|\$\(|<\(/.test(command) && !plainAliasOnly(command)
  if (state.aliasWrite && !plainAliasOnly(command)) return SHELL_ALIAS_DEFINE_REASON
  if (!state.headPush) {
    if (state.stdinDeferred) return SHELL_STDIN_REASON
    return dynWrite ? SHELL_ALIAS_DEFINE_REASON : deferred()
  }
  // claude-factory-9zd5: R4. A headPush denies when the command itself holds a branch-change or
  // git-admin-path signal (branchChange, gitAdminPath), or when gate.cwd itself names a directory
  // inside a .git-named path. cwdInsideGitDir reads gate.cwd, not the command text, so it also
  // denies a write this guard's own word scan cannot read, such as a shell-variable target.
  if (state.branchChange || state.gitAdminPath || cwdInsideGitDir(g.cwd)) return PUSH_REASON
  if (state.stdinDeferred) return SHELL_STDIN_REASON
  if (dynWrite) return SHELL_ALIAS_DEFINE_REASON
  return deferred()
}

// claude-factory-1zr5: the most alias expansions one word can chain through. A longer chain denies.
const MAX_SHELL_ALIAS_DEPTH = 10

// claude-factory-1zr5: writes one segment word back as shell text, so a rescan reads the same word.
// A word with a $, backtick, glob or similar char stays bare, so the dynamic-word checks still see it.
// A bare word that also holds a space or an operator char cannot be written safely: null.
function aliasWordText(w: string, marked = false): string | null {
  if (marked && /[$`*?[{~\\!]/.test(w)) {
    // claude-factory-upag: keep the mark. Quote the name part only, so the rest stays dynamic.
    const eq = w.indexOf('=')
    const rest = eq < 0 ? w : w.slice(eq)
    const bad = /[$`*?[{~\\!\s;&|<>()#'"]/.test(w.slice(0, Math.max(eq, 0)))
    if (eq <= 0 || bad || /[\s;&|<>()#'"]/.test(rest)) return null
    return `'${w.slice(0, eq)}'${rest}`
  }
  if (/[$`*?[{~\\!]/.test(w)) return /[\s;&|<>()#'"]/.test(w) ? null : w
  if (marked) return `'${w.replace(/'/g, `'\\''`)}'`
  return requoteWord(w)
}
function requoteWord(w: string): string {
  const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(w)?.[0] ?? ''
  return `${name}'${w.slice(name.length).replace(/'/g, `'\\''`)}'`
}

/**
 * claude-factory-1zr5: the Bash tool shell expands a snapshot alias that is a word of this segment,
 * but the other checks see only the alias word. This function reads every word of the segment (any
 * position, like `anyGitReason`). For a word in `table`:
 *   - a value that is null (the reader could not unquote it) denies.
 *   - a name other than git or gh, whose expansion holds a git, gh or git-<verb> word, denies.
 *   - any other alias: the expansion replaces the word, and `denyAt` scans the result again.
 *     It skips the names already expanded, as zsh does, and denies past MAX_SHELL_ALIAS_DEPTH.
 */
// claude-factory-usqc: builtins that print or test and never run, define or load a word. A function
// or an alias of the same name still fails Q5 and Q3.
const PURE_BUILTINS = new Set(['echo', 'printf', 'pwd', 'true', 'false'])
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
function firstCommandWord(words: string[]): number {
  return words.findIndex(w => !ASSIGNMENT_WORD.test(w))
}

/**
 * claude-factory-usqc: true when the shell expands no alias in a word after the command word of this
 * segment. That holds when the first word is a plain name (Q2) that is no alias (Q3), no shell
 * word (Q4) and no snapshot function (Q5). A function can eval its arguments, so `gate.shellFunctions`
 * must be set and must not hold a command_not_found handler. Q1: an assignment-only segment fails.
 */
function flatExternal(words: string[], table: Map<string, string | null>, gate: HookGate): boolean {
  const f = firstCommandWord(words)
  if (f < 0) return false
  // An expansion `${ cmd; }`, `${| cmd; }` or zsh `${functions[f]::=body}` can define a function in this shell.
  if (words.some(x => x.includes('${'))) return false
  const w = words[f]!
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(w) || table.has(w)) return false
  const lower = baseWord(w)
  if (SHELL_WORDS.has(lower) && !PURE_BUILTINS.has(lower)) return false
  const fns = gate.shellFunctions?.()
  if (!fns || fns.has('command_not_found_handler') || fns.has('command_not_found_handle')) return false
  for (const n of fns) if (n.toLowerCase() === lower) return false
  return true
}

function shellAliasReason(
  words: string[],
  table: Map<string, string | null>,
  stack: readonly string[],
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
  depth: number,
  state: ScanState,
  moved: boolean,
  ghMoved: boolean,
  marks?: readonly number[],
): string | undefined {
  let end = words.length
  const first = firstCommandWord(words)
  if (!state.aliasArgsOff) end = first + 1
  else if (
    first >= 0 &&
    words[first]!.includes('/') &&
    !/[=<>&|()]/.test(words[first]!) &&
    !table.has(words[first]!)
  ) {
    end = first + 1
  }
  for (let i = 0; i < end; i++) {
    const name = words[i]!
    if (!table.has(name) || stack.includes(name)) continue
    const value = table.get(name)
    if (value === null || value === undefined) return SHELL_ALIAS_REASON
    if (stack.length >= MAX_SHELL_ALIAS_DEPTH) return SHELL_ALIAS_REASON
    if (spendWork(state, value.length + words.length)) return SCAN_BUDGET_REASON
    const info: SegInfo = { dollarQuote: false, quotedNames: new Map() }
    const expansion = segments(value, info)
    if (info.dollarQuote) return SHELL_ALIAS_REASON
    if (name !== 'git' && name !== 'gh') {
      const runsGit = expansion.some(seg =>
        seg.some(x => {
          const b = baseWord(x)
          return b === 'git' || b === 'gh' || GIT_DASHED_BINARY.test(b)
        }),
      )
      if (runsGit) return SHELL_ALIAS_REASON
    }
    // claude-factory-upag: a word marked as a quoted assignment name stays single-quoted whole,
    // so the rescan marks it again.
    const before = words.slice(0, i).map((w, k) => aliasWordText(w, marks?.includes(k)))
    const after = words.slice(i + 1).map((w, k) => aliasWordText(w, marks?.includes(i + 1 + k)))
    const parts = (expansion.length ? expansion : [[]]).map(seg => {
      const m = info.quotedNames?.get(seg)
      return seg.map((w, k) => aliasWordText(w, m?.includes(k)))
    })
    parts[0] = [...before, ...parts[0]!]
    parts[parts.length - 1] = [...parts[parts.length - 1]!, ...after]
    const texts: string[] = []
    for (const quoted of parts) {
      if (quoted.includes(null)) return SHELL_ALIAS_REASON
      texts.push(quoted.join(' '))
    }
    // claude-factory-c1jb: n alias words in one segment reach the same rescan text in n! orders. denyAt reads the
    // stack only as a set (includes, length), so one allowed rescan covers every order. The key holds every scan
    // state field except MEMO_SKIP.
    const text = texts.join(' ; ')
    const stateKey = Object.entries(state)
      .filter(([k]) => !MEMO_SKIP.has(k))
      .map(
        ([k, v]) =>
          k +
          '=' +
          (v instanceof Set
            ? [...v].sort().join('\0')
            : typeof v === 'object'
              ? JSON.stringify(v)
              : String(v)),
      )
      .join('\u0002')
    const key = [moved, ghMoved, depth, stateKey, [...stack, name].sort().join('\0'), text].join('\u0001')
    const seen = state.aliasSeen.get(key)
    if (seen) {
      state.outer = seen
      continue
    }
    const reason = denyAt(text, root, personOnly, gate, depth, state, moved, ghMoved, [...stack, name])
    if (reason) return reason
    state.aliasSeen.set(key, state.outer)
  }
  return undefined
}

// claude-factory-miqy: bash splits an unquoted `$X` into words. So a command word `$X` runs X's value.
// This table holds each NAME=value the command text sets. The table stores undefined for a value the hook cannot read.
// The hook reads a visible value as the command. A name with no visible set stays allowed.
type VarTable = Map<string, string | undefined>
const VAR_REF = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/
const VAR_UNREADABLE = /[$`\\;&|<>()"'*?[\]{}~!#]/

function recordVarWrites(words: string[], vars: VarTable): void {
  const b = baseWord(words[0] ?? '')
  // miqy.9: a name set twice with different values is unreadable.
  const set = (name: string, value: string | undefined) =>
    vars.set(name, vars.has(name) && vars.get(name) !== value ? undefined : value)
  if (b === 'for' && words[1]) set(words[1], undefined)
  if (
    b === 'read' ||
    b === 'mapfile' ||
    b === 'readarray' ||
    b === 'printf' ||
    b === 'print' ||
    b === 'getopts'
  ) {
    for (const w of words.slice(1)) {
      if (/^[A-Za-z_]\w*$/.test(w)) set(w, undefined)
      // miqy.18: a glued -vNAME writes NAME.
      const g = /^-v([A-Za-z_]\w*)$/.exec(w)
      if (g) set(g[1]!, undefined)
    }
  }
  // miqy.21: a glued read -aNAME (also -raNAME) writes NAME, after an IFS=, prefix too.
  if (words.some(w => baseWord(w) === 'read')) {
    for (const w of words) {
      // miqy.23: the split of flags and name is unknown (-raarr), so mark every possible name.
      if (/^-[A-Za-z]*a[A-Za-z_]\w*$/.test(w)) {
        for (const m of w.matchAll(/a(?=([A-Za-z_]\w*)$)/g)) set(m[1]!, undefined)
      }
    }
  }
  const declares = ['export', 'declare', 'typeset', 'local', 'readonly'].includes(b)
  let i = 0
  while (i < words.length && (/^[A-Za-z_]\w*\+?=/.test(words[i]!) || (i === 0 && declares))) {
    if (i > 0 || !declares) {
      const m = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/.exec(words[i]!)!
      set(m[1]!, m[2] ? undefined : m[3]!)
    }
    i++
  }
  if (declares) {
    // miqy.10: a flag (-n, -l, -u ...) can change what the name holds, so its names are unreadable.
    const flagged = words.slice(1).some(w => /^[-+][A-Za-z]/.test(w))
    for (const w of words.slice(1)) {
      const m = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/.exec(w)
      if (m) set(m[1]!, m[2] || flagged ? undefined : m[3]!)
      else if (/^[A-Za-z_]\w*$/.test(w)) set(w, undefined)
    }
  }
  // miqy.11: env/sudo NAME=value words are readable. Any other write inside a word (an eval script) is not.
  const wraps = b === 'env' || b === 'sudo'
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    const lead = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/.exec(w)
    if (lead && k >= i && wraps) set(lead[1]!, lead[2] ? undefined : lead[3]!)
    for (const m of w.matchAll(/(?:^|[\s;&|({])([A-Za-z_]\w*)\+?=/g)) {
      const handled = m.index === 0 && (k < i || declares || wraps)
      if (!handled) vars.set(m[1]!, undefined)
    }
  }
}

// claude-factory-miqy.8: an operator or zsh form also runs the split value of its name.
// claude-factory-bc1u: also the brace-less flag run ($~X, $=~X) and the glued subscript ($X[1,2]).
const VAR_OP_REF =
  /^\$(?:[=~^]+([A-Za-z_]\w*)(?:[[:][\s\S]*)?|\{[!=~^]*(?:\([^)]*\))?([A-Za-z_]\w*)[\s\S]*\}|([A-Za-z_]\w*)\[[\s\S]*)$/
function varOpName(w: string): string | undefined {
  const m = VAR_OP_REF.exec(w)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

// claude-factory-piqf: a head word that glues text to the expansion of a set name runs the split
// value (X=' -rf /'; rm${X}). The guard does not read that value, so it denies. The one exception
// is a head path such as ${HOME%/}/bin/tool: a literal "/" follows the last expansion, so the word
// stays one path. Then every set name must hold a plain value with no space and no IFS, and may
// have only its one write and the op-form reads in this word.
function gluedHeadReason(head: string, vars: VarTable, mentions: (name: string) => number): boolean {
  const names = [...head.matchAll(/\$\{?[=~^]*(?:\([^)]*\))?([A-Za-z_]\w*)/g)].map(m => m[1]!)
  if (!names.length) return false
  const opsOf = (n: string): string[] =>
    [...head.matchAll(new RegExp(`\\$\\{${n}([^}A-Za-z0-9_][^}]*)\\}`, 'g'))].map(m => m[1]!)
  const zsOf = (n: string): number =>
    [...head.matchAll(new RegExp(`\\$\\{?[=~^]+(?:\\([^)]*\\))?${n}\\b`, 'g'))].length
  const setNames = names.filter(n => mentions(n) > opsOf(n).length + zsOf(n))
  if (!setNames.length) return false
  if (vars.has('IFS')) return true
  let end = -1
  for (const m of head.matchAll(/\$\{[^}]*\}|\$[=~^]*[A-Za-z_]\w*/g)) end = m.index! + m[0].length
  if (head[end] !== '/') return true
  for (const n of setNames) {
    const value = vars.get(n)
    if (typeof value !== 'string' || IMPLICIT_VARS.has(n) || /\s/.test(value) || VAR_UNREADABLE.test(value))
      return true
    const ops = opsOf(n)
    if (ops.some(o => /[\s$\`'"\\*?[]/.test(o))) return true
    if (mentions(n) > 1 + ops.length) return true
  }
  return false
}

// claude-factory-miqy.12: count the raw-text mentions of NAME that are not a pure read (the plain and braced forms).
// A write form the table does not know still shows as a mention, so the head check fails closed.
const MENTION_COUNTERS = new WeakMap<VarTable, (name: string) => number>()
// miqy.17: a nested level inherits the outer level's dynamic-name write check.
const DYNWRITE_CHECKS = new WeakMap<VarTable, () => boolean>()
// claude-factory-miqy.13: names the shell sets itself. A head of one of them denies.
const IMPLICIT_VARS = new Set([
  '_',
  'REPLY',
  'BASH_REMATCH',
  'MAPFILE',
  'OPTARG',
  'COPROC',
  'READLINE_LINE',
  'reply',
  'match',
  'MATCH',
])
function countMentions(text: string, name: string): number {
  let n = 0
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g'))) {
    const i = m.index!
    const pure = text[i - 1] === '$' || (text.slice(i - 2, i) === '${' && text[i + name.length] === '}')
    if (!pure) n++
  }
  return n
}

function varRefName(w: string): string | undefined {
  const m = VAR_REF.exec(w)
  return m ? (m[1] ?? m[2]) : undefined
}

function shellQuoteWord(w: string): string {
  return /^[\w./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`
}

// claude-factory-j1ki: the shell splits an unquoted expansion that is glued to other text in one
// word (rm${IFS}-rf${IFS}/) into several words. segments() keeps it as one word, so no rule reads
// the real command. This returns the words with each such expansion read as a word break, or
// undefined when no word holds a glued expansion. A whole-word expansion ($X, ${X}) is not glued.
const GLUED_EXPANSION_RE = /\$(?:\(\([^)]*\)\)|\([^)]*\)|=?[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g
// claude-factory-dnw1: a ${...} span ends at its matching close brace, so a nested default
// (${X:-${IFS}}) is one expansion. Only a "${" adds depth: a bare "{" in a default is literal. Each
// span becomes $@ for the split. An unclosed span ends at the first "}" (or after "${" when none),
// so no word after it is dropped. segments() drops quotes and backslashes, so the depth reading
// cannot tell an escaped or single-quoted "${" from a real one. The caller also reads with byDepth
// false (the first "}" ends the span, and a stray "}" left over is a word break) and denies if
// either reading denies. The stray break covers a word where an escaped "${" fools the depth
// reading and a nested default fools the first-close reading. replaceGluedExpansions reads the raw
// text, where quotes and backslashes are visible, and is the reading that does not depend on them.
function flattenBraceExpansions(w: string, byDepth: boolean): string {
  let out = ''
  for (let i = 0; i < w.length;) {
    if (w[i] !== '$' || w[i + 1] !== '{') {
      // A stray "}" is the tail of a nested span that an escaped or quoted "${" hid: read it as a break.
      out += !byDepth && w[i] === '}' ? '$@' : w[i]
      i++
      continue
    }
    let depth = 0
    let end = -1
    for (let j = i + 1; byDepth && j < w.length; j++) {
      if (w[j] === '{' && w[j - 1] === '$') depth++
      else if (w[j] === '}' && --depth === 0) {
        end = j
        break
      }
    }
    if (end < 0) end = w.indexOf('}', i)
    out += '$@'
    i = (end < 0 ? i + 1 : end) + 1
  }
  return out
}
// claude-factory-qn8a.10: true when a ${ is not followed by a simple closed body. A simple body holds no
// whitespace, ; | &, quote, backslash, backtick, $, brace, paren or angle bracket. bash splits any other
// span into words, and segments() cuts the word early and drops quotes. This rule reads no quotes, so no
// quote form hides a span. It fails closed and only denies.
function hasSplitBrace(text: string): boolean {
  return /\$\{(?![^\s;|&'"`$(){}<>\\]*\})/.test(text)
}
function splitGluedExpansions(words: string[], byDepth = true): string[] | undefined {
  let out: string[] | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const parts = w.includes('$')
      ? flattenBraceExpansions(w, byDepth)
          .split(GLUED_EXPANSION_RE)
          .filter(p => p !== '')
      : [w]
    // No part, or one part equal to the word: the word is one whole expansion, or holds none.
    if (parts.length === 0 || (parts.length === 1 && parts[0] === w)) {
      out?.push(w)
      continue
    }
    // A word that is one expansion plus nothing else gives parts.length 0 above. A word with one
    // expansion and one literal part gives parts.length 1 with parts[0] !== w, and is glued.
    if (!out) out = words.slice(0, i)
    out.push(...parts)
  }
  return out
}

// claude-factory-j1ki.9: segments() drops quotes, so splitGluedExpansions cannot see where a bare
// $NAME ends when a quote or a backslash follows it. This reads the raw text instead.
const GLUED_BARE_NAME_RE = /\$[A-Za-z_][A-Za-z0-9_]*(?=["'\\])/g

// claude-factory-j1ki.10: returns the index after the close paren of the "$(" at `from`. The close
// paren is found by depth, and quotes and backslashes in the body are skipped. A body with no
// close paren runs to the end of the text (fail closed).
function substitutionEnd(command: string, from: number): number {
  let depth = 0
  let q = ''
  for (let k = from + 1; k < command.length; k++) {
    const c = command[k]!
    if (q) {
      if (c === '\\' && q === '"') k++
      else if (c === q) q = ''
      continue
    }
    if (c === '\\') k++
    else if (c === "'" || c === '"') q = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return k + 1
  }
  return command.length
}

// claude-factory-j1ki.10/.14/.15: returns `command` with each $( ) that sits glued to other text
// read as a space. A double quote next to the $( ) counts as glue, so "rm"$(x)"-r" is read. A $( )
// with a space or paren on both sides is a whole word and stays, but the scan goes into its body.
// The body of a glued $( ) is read again and added as an extra line, so a glued $( ) inside it is
// read too.
function replaceGluedSubstitutions(command: string, fill = ' '): string {
  let out = ''
  let last = 0
  const extra: string[] = []
  let from = command.indexOf('$(')
  while (from !== -1) {
    const end = substitutionEnd(command, from)
    const before = from > 0 ? command[from - 1]! : ' '
    const after = end < command.length ? command[end]! : ' '
    const wordStart =
      Math.max(
        command.lastIndexOf(' ', from),
        command.lastIndexOf('\n', from),
        command.lastIndexOf('\t', from),
      ) + 1
    const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
    let cmdStart = 0
    for (let k = wordStart - 1; k >= 0; k--) {
      const ch = command[k]!
      if (ch === '\n' || ch === ';' || ch === '&' || ch === '|' || (ch === '(' && command[k - 1] !== '$')) {
        cmdStart = k + 1
        break
      }
    }
    // An assignment word skips only in the prefix slot. After env or sudo it is an argument.
    const assignWord = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(command.slice(wordStart, from))
    const assign =
      assignWord &&
      !/['"\\`]/.test(command.slice(0, wordStart)) &&
      command
        .slice(cmdStart, wordStart)
        .split(/\s+/)
        .every(w => w === '' || ASSIGN.test(w))
    if ((/[\s(]/.test(before) && /[\s)]/.test(after)) || (fill !== ' ' && assign)) {
      from = command.indexOf('$(', from + 2)
      continue
    }
    // After env or sudo, NAME=$(y) splits: the part after the first word is a command word.
    out += command.slice(last, from) + (assignWord && fill !== ' ' ? ' ' : '') + fill
    last = end
    const body = command.slice(from + 2, command[end - 1] === ')' ? end - 1 : end)
    const inner = body.includes('$(') ? replaceGluedSubstitutions(body, fill) : body
    if (inner !== body) extra.push(inner)
    from = command.indexOf('$(', end)
  }
  return out + command.slice(last) + extra.map(e => '\n' + e).join('')
}

// claude-factory-dnw1.9: segments() drops quotes and backslashes, so the readings above cannot tell
// an escaped or single-quoted "${" from a real one. This reads the raw text. An unquoted, unescaped
// ${...} (close brace by depth, only "${" adds depth) or bare $NAME / $special glued to other text
// becomes a space. Double-quoted text is not split by the shell, so it stays. An unclosed span
// replaces only the "${". In keep mode, only an exact $IFS or ${IFS} becomes a space. Every other glued
// span stays as typed, so a head word such as g${X:-it} stays dynamic and the dynamic verb rule sees it.
function replaceGluedExpansions(command: string, keep = false): string {
  let out = ''
  let q = ''
  const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (q) {
      if (c === '\\' && q === '"') {
        out += c + (command[i + 1] ?? '')
        i++
        continue
      }
      if (c === q) q = ''
      out += c
      continue
    }
    if (c === '\\') {
      out += c + (command[i + 1] ?? '')
      i++
      continue
    }
    if (c === "'" || c === '"') {
      q = c
      out += c
      continue
    }
    if (c !== '$') {
      out += c
      continue
    }
    let end = i + 1
    const n = command[i + 1]
    if (n === '{') {
      let depth = 0
      end = -1
      for (let j = i + 1; j < command.length; j++) {
        if (command[j] === '{' && command[j - 1] === '$') depth++
        else if (command[j] === '}' && --depth === 0) {
          end = j + 1
          break
        }
      }
      if (end < 0) end = i + 2
    } else if (n !== undefined && /[A-Za-z_]/.test(n)) {
      while (end < command.length && /[A-Za-z0-9_]/.test(command[end]!)) end++
    } else if (n !== undefined && /[0-9@*#?$!-]/.test(n)) end++
    else {
      out += c
      continue
    }
    const span = command.slice(i, end)
    if (isSpace(command[i - 1]) && isSpace(command[end])) {
      out += span
    } else if (!keep || span === '$IFS' || span === '${IFS}') out += ' '
    else out += span
    i = end - 1
  }
  return out
}
const IFS_MOD_SPAN_RE = /\$\{IFS[^A-Za-z0-9_}]|\$\{[^}]*\$\{?IFS(?![A-Za-z0-9_])/

function quoteWord(w: string): string {
  return "'" + w.replace(/'/g, "'\\''") + "'"
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
  aliasStack: readonly string[] = [],
  outerVars?: VarTable,
): string | undefined {
  // claude-factory-qn8a.30: zsh drops a last backslash of an eval, -c or trap script. Read it as a join.
  if (depth > 0 && command.endsWith('\\')) command += '\n'
  // claude-factory-wmsr: the here-document and comment reasons come last. A scan reason that names
  // a real command wins over them.
  // claude-factory-pwy0: the lexer splits a word at the `(` of a zsh flag group, `${(L)x:-rm}`.
  // Read the command again without the flag groups. This is deny-only: only the rm reason counts.
  if (command.includes('${(')) {
    const bare = command.replace(/\$\{(?:\([^()]*\))+/g, '${')
    if (bare !== command) {
      const r = denyAt(
        bare,
        root,
        personOnly,
        gate,
        depth,
        state,
        movedBefore,
        ghConfigMovedBefore,
        aliasStack,
      )
      if (r === REASON) return r
      // claude-factory-qn8a.5.7: the re-read can hold `${` + blank; keep that deny (fail closed).
      if (r === FUNSUB_REASON) return r
      // claude-factory-teku: `${(@)_}` reads as `${_}` here; a head `$_` stays denied.
      if (r === DYNAMIC_VERB_REASON && LAST_ARG_HEAD.test(bare)) return r
    }
  }
  const late: { reason?: string; glued?: string; kept?: string } = {}
  return (
    denyAtScan(
      command,
      root,
      personOnly,
      gate,
      depth,
      state,
      movedBefore,
      ghConfigMovedBefore,
      late,
      aliasStack,
      outerVars,
    ) ??
    late.glued ??
    late.kept ??
    late.reason
  )
}

function denyAtScan(
  command: string,
  root: string | undefined,
  personOnly: string[] | undefined,
  gate: HookGate,
  depth: number,
  state: ScanState,
  movedBefore: boolean,
  ghConfigMovedBefore: boolean,
  late: { reason?: string; glued?: string; kept?: string },
  aliasStack: readonly string[],
  outerVars?: VarTable,
): string | undefined {
  if (!command) return undefined
  if (spendWork(state, command.length)) return SCAN_BUDGET_REASON
  // claude-factory-mozp: every decoded script (sh -c, eval, alias, substitution) passes here too.
  if (commentLineContinues(command)) return COMMENT_CONTINUATION_REASON
  // claude-factory-06th: bash 5.3 `${ cmd; }` and `${| cmd; }` run cmd. Read the raw text, quotes included (fail closed).
  if (/\$\{[\s|]/.test(command.replace(/\\\n/g, ''))) return FUNSUB_REASON
  // claude-factory-1zr5: a table the hook cannot read denies every command (fail closed).
  const aliasTable = gate.shellAliases?.()
  if (gate.shellAliases && !aliasTable) return SHELL_ALIAS_READ_REASON
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
  const subs: DqSubstitution[] = []
  const quoteInfo: SegInfo = {
    dollarQuote: false,
    funcDef: false,
    state,
    quotedNames: new Map(),
  }
  const segs = segments(command, quoteInfo, subs)
  // claude-factory-4a4o: a redirect glued to a word is a second reading. It only adds segments.
  if (quoteInfo.gluedRedir && !quoteInfo.deep)
    segs.push(
      ...segments(command, { dollarQuote: false, state, deep: quoteInfo.deep }, undefined, false, true),
    )
  if (quoteInfo.deep) return DEEP_COMMAND_REASON
  if (quoteInfo.dollarQuote) return DOLLAR_QUOTE_REASON
  if (quoteInfo.globCode) return GLOB_CODE_REASON
  // claude-factory-j1ki: segments() breaks a word at "$(", so splitGluedExpansions never sees a
  // command substitution glued to text. Read the command again with each such substitution as a
  // space. This text has fewer "$(" than the source, so the recursion ends.
  let unglued = command.includes('$(') ? replaceGluedSubstitutions(command) : command
  if (unglued.includes('$')) unglued = unglued.replace(GLUED_BARE_NAME_RE, ' ')
  if (unglued !== command) {
    const split = denyAt(unglued, root, personOnly, g, depth + 1, state, movedSoFar, ghConfigMovedSoFar)
    if (split && split !== HEREDOC_REASON && split !== COMMENT_REASON) late.glued ??= split
  }
  // claude-factory-cwt9.12: the lexer drops a glued substitution, so `-E$(y)` reads as `-E`. Read the
  // command again with each one as the text `$_`, so the word stays dynamic. It has fewer "$(" too.
  if (command.includes('$(')) {
    const kept = replaceGluedSubstitutions(command, '$_')
    if (kept !== command) {
      const split = denyAt(kept, root, personOnly, g, depth + 1, state, movedSoFar, ghConfigMovedSoFar)
      if (split && split !== HEREDOC_REASON && split !== COMMENT_REASON) late.glued ??= split
    }
  }
  if (unglued.includes('$')) {
    const raw = replaceGluedExpansions(unglued)
    if (raw !== unglued) {
      const split = denyAt(raw, root, personOnly, g, depth + 1, state, movedSoFar, ghConfigMovedSoFar)
      if (split && split !== HEREDOC_REASON && split !== COMMENT_REASON) late.glued ??= split
    }
  }
  // claude-factory-y094: read the command with only each glued $IFS or ${IFS} as a space.
  if (command.includes('$')) {
    const kept = replaceGluedExpansions(command, true)
    if (kept !== command) {
      const split = denyAt(kept, root, personOnly, g, depth + 1, state, movedSoFar, ghConfigMovedSoFar)
      if (split && split !== HEREDOC_REASON && split !== COMMENT_REASON) late.kept ??= split
    }
    if (IFS_MOD_SPAN_RE.test(command) && command.split('$').length > 2) late.kept ??= DYNAMIC_VERB_REASON
  }
  if (quoteInfo.heredoc) late.reason ??= HEREDOC_REASON
  if (quoteInfo.comment) late.reason ??= COMMENT_REASON
  let definesFunction = quoteInfo.funcDef
  let quotedAssign = false
  let ambiguousAssignment = false
  let subIdx = 0
  const vars: VarTable = new Map(outerVars)
  const joined = command.split('\\\n').join('')
  const inheritedCount = outerVars && MENTION_COUNTERS.get(outerVars)
  const mentionCache = new Map<string, number>()
  const mentions = (name: string): number => {
    let n = mentionCache.get(name)
    if (n === undefined) {
      n = Math.max(countMentions(joined, name), inheritedCount ? inheritedCount(name) : 0)
      mentionCache.set(name, n)
    }
    return n
  }
  MENTION_COUNTERS.set(vars, mentions)
  // claude-factory-miqy: collect every write first. A set after the use still counts.
  for (const w of segs) recordVarWrites(w, vars)
  // miqy.11: ${NAME:=v} and ${NAME=v} write a name the lexer does not show as a write.
  for (const m of command.matchAll(/\$\{([A-Za-z_]\w*):?=/g)) vars.set(m[1]!, undefined)
  // The lexer splits ${(z)X} at the parens, so read the raw text: a zsh flag form of a set name denies.
  if (vars.size > 0) {
    for (const m of command.matchAll(/\$\{[!=~^]*\([^)]*\)([A-Za-z_]\w*)/g)) {
      if (vars.has(m[1]!)) return DYNAMIC_VERB_REASON
    }
  }
  // miqy.15: a write whose name comes from an expansion is unreadable, so every variable head denies.
  const dynName = (x: string): boolean => /^[^=]*[$`]/.test(x)
  const NAME_WRITERS = [
    'declare',
    'typeset',
    'local',
    'readonly',
    'export',
    'read',
    'mapfile',
    'readarray',
    'getopts',
    'eval',
  ]
  let dynWriteCache: boolean | undefined
  const inheritedDyn = outerVars && DYNWRITE_CHECKS.get(outerVars)
  const dynWrite = (): boolean =>
    (dynWriteCache ??=
      (inheritedDyn ? inheritedDyn() : false) ||
      segs.some(ws =>
        ws.some((w, k) => {
          const b = baseWord(w)
          // An eval script with no "=" writes nothing, so it is no dynamic-name write.
          // miqy.20: an eval script that names a writer word counts too.
          if (b === 'eval') {
            // miqy.22: join the args and drop quotes and backslashes, as eval does.
            const args = ws.slice(k + 1)
            if (!args.some(dynName)) return false
            const j = args.join(' ').replace(/["'\\]/g, '')
            return (
              j.includes('=') ||
              /(?:^|[\s;&|({])(?:declare|typeset|local|readonly|export|read|mapfile|readarray|getopts|printf|print|vared)\b/.test(
                j,
              )
            )
          }
          if (NAME_WRITERS.includes(b)) return ws.slice(k + 1).some(dynName)
          if (b === 'printf' || b === 'print') {
            return ws
              .slice(k + 1)
              .some((x, j, a) => (a[j - 1] === '-v' && dynName(x)) || (/^-v./.test(x) && dynName(x.slice(2))))
          }
          return false
        }),
      ))
  DYNWRITE_CHECKS.set(vars, dynWrite)
  const scanValue = (name: string, rest: string[]): string | undefined => {
    if (dynWrite()) return DYNAMIC_VERB_REASON
    const n = mentions(name)
    if (n === 0 && !vars.has(name) && !IMPLICIT_VARS.has(name)) return undefined
    const value = vars.get(name)
    if (
      n !== 1 ||
      IMPLICIT_VARS.has(name) ||
      value === undefined ||
      vars.has('IFS') ||
      VAR_UNREADABLE.test(value)
    ) {
      return DYNAMIC_VERB_REASON
    }
    const text = [...value.split(/\s+/).filter(Boolean), ...rest.map(shellQuoteWord)].join(' ')
    return denyAt(text, root, personOnly, g, depth + 1, state, movedSoFar, ghConfigMovedSoFar)
  }
  const varsGuard = (words: string[], cmd: string[]): boolean =>
    cmd.length > 0 &&
    !anyDynamicCommandReason(words, state.braceWords) &&
    !(personOnly?.length && anyDynamicLiveApplyReason(words, personOnly, state.braceWords))
  // claude-factory-pwy0: per-segment flag text and rm/find text, so a dynamic word reads the others.
  const segFlag = segs.map(sg => DYN_FLAG_TEXT.test(sg.join(' ')))
  const segRmFind = segs.map(sg => /rm|find/i.test(sg.join(' ')))
  // k8iz: a segment with IFS, a dollar or a backtick can set IFS or build a value. A NAME= with a
  // quote, backslash or space in the value can split into words with the default IFS.
  // Rule (k8iz): a command word with a dollar or backtick can read any value that an earlier
  // or outer segment, a prefix assignment, a loop or `set --` gave it. So it denies when the
  // text has 2+ segments or its own segment starts with a NAME= or NAME+= prefix.
  // A zsh flag group cuts a word into segments, so it does not count there.
  const ZSF = /\[\([A-Za-z]+\)/
  const manySegs =
    segs.length > 1 &&
    !command.includes('${(') &&
    (!ZSF.test(command) || segments(command.replace(/(\[)\([A-Za-z]+\)/g, '$1')).length > 1)
  const segIfs = segs.map(sg => manySegs || /^[A-Za-z_]\w*\+?=/.test(sg[0] ?? ''))
  const flagCount = segFlag.filter(Boolean).length
  const rmFindCount = segRmFind.filter(Boolean).length
  const outerSegs = state.outer
  const otherSegs = (i: number, withIfs = false): OtherSegs => ({
    flags: outerSegs.flags || flagCount - (segFlag[i] ? 1 : 0) > 0,
    rmfind: outerSegs.rmfind || rmFindCount - (segRmFind[i] ? 1 : 0) > 0,
    ifs: withIfs && (outerSegs.ifs || segIfs[i]!),
  })
  // claude-factory-2pdm: scans the double-quoted substitution bodies that sit before segment
  // `upTo`, in order, so a body that moves HEAD counts for a later push.
  const scanSubs = (upTo: number): string | undefined => {
    for (; subIdx < subs.length && subs[subIdx]!.at <= upTo; subIdx++) {
      const body = subs[subIdx]!.body
      if (isCatHeredoc(body)) continue
      // claude-factory-j1dr: the cleaner may blank quotes in a false comment or here-document, so
      // the raw body is read too. This only adds a deny reading.
      const clean = cleanSubstitutionBody(body)
      for (const text of clean === body ? [body] : [clean, body]) {
        const r = denyAt(
          text,
          root,
          personOnly,
          g,
          depth + 1,
          state,
          movedSoFar,
          ghConfigMovedSoFar,
          [],
          vars,
        )
        // claude-factory-wmsr: a body this guard cannot read waits. A later real command reason wins.
        if (r === HEREDOC_REASON || r === COMMENT_REASON) late.reason ??= r
        else if (r) return r
      }
    }
    return undefined
  }
  // claude-factory-usqc: read every segment before the first one is scanned. One segment that is not a
  // flat external command turns the argument-word skip off for the whole call.
  if (aliasTable && !state.aliasArgsOff && !segs.every(w => flatExternal(w, aliasTable, g)))
    state.aliasArgsOff = true
  for (let segIdx = 0; segIdx < segs.length; segIdx++) {
    state.outer = otherSegs(segIdx, true)
    const subReason = scanSubs(segIdx)
    if (subReason) return subReason
    const words = segs[segIdx]!
    if (!state.aliasWrite && segmentMayDefineAlias(words)) state.aliasWrite = true
    if (!state.dynArg && segmentDynArg(words)) state.dynArg = true
    if (aliasTable) {
      const aliased = shellAliasReason(
        words,
        aliasTable,
        aliasStack,
        root,
        personOnly,
        g,
        depth,
        state,
        movedSoFar,
        ghConfigMovedSoFar,
        quoteInfo.quotedNames?.get(words),
      )
      if (aliased) return aliased
    }
    const splitWords = splitGluedExpansions(words)
    for (const sw of [splitWords, splitGluedExpansions(words, false)]) {
      if (!sw?.length) continue
      const split = denyAt(
        sw.map(quoteWord).join(' '),
        root,
        personOnly,
        g,
        depth + 1,
        state,
        movedSoFar,
        ghConfigMovedSoFar,
      )
      if (split && split !== HEREDOC_REASON && split !== COMMENT_REASON) late.glued ??= split
    }
    if (!definesFunction && namesFunctionDefinition(words)) definesFunction = true
    if (!ambiguousAssignment && hasAmbiguousAssignmentPrefix(words)) ambiguousAssignment = true
    // claude-factory-8pc.24: check the raw segment words, before realCommand strips a leading
    // VAR=val or wrapper word, so `BEADS_ACTOR=x bd create ...` and `env BEADS_ACTOR=x bd create
    // ...` both still show the assignment here.
    for (const g of [BEADS_ACTOR_GUARD, FACTORY_FROM_GUARD, FACTORY_RUN_GUARD, FACTORY_VM_ENV_GUARD]) {
      if (touchesBeadsActor(words, state, g)) return state.work < 0 ? SCAN_BUDGET_REASON : g.reason
    }
    // claude-factory-zl5.33: checked before realCommand strips xargs, since the thing this
    // check denies is exactly what realCommand's own strip would otherwise hide.
    if (xargsHidesOperand(words)) return XARGS_REASON
    // claude-factory-5hjj: a glob group glued to a command word hides the command from every scan.
    if (quoteInfo.glued?.has(words) && gluedAtCommandSlot(words.slice(0, -1), depth === 0 && segIdx === 0))
      return DYNAMIC_VERB_REASON
    if (setsDangerousGitConfigEnv(words) || (splitWords && setsDangerousGitConfigEnv(splitWords)))
      hasDangerousConfigEnv = true
    // claude-factory-upag: a quoted assignment name keeps its own reason where assignmentReadingsDeny
    // would deny the same word first.
    const marks = quoteInfo.quotedNames?.get(words)
    if (marks) {
      const probe = [...words]
      for (const k of marks) probe[k] = '\u0000'
      if (realCommand(probe).length > realCommand(words).length) quotedAssign = true
    }
    if (assignmentReadingsDeny(words, root, state)) {
      if (quotedAssign) return QUOTED_ASSIGNMENT_REASON
      return state.work < 0 ? SCAN_BUDGET_REASON : REASON
    }
    // claude-factory-mmc9.25: realCommand skips only an ASCII NAME=. For each word with =, read
    // the word and the command after it. This sets hasRm and hasCd for the rm and cd pair check.
    {
      const memo2 = new Map<number, number>()
      for (let i = 0; i < words.length; i++) {
        const w = words[i]!
        if (w[0] === '-' || w.indexOf('=') < 0) continue
        const s = realCommandStart(words, i + 1, memo2)
        for (const h of [w, words[s] ?? '']) {
          const hb = baseWord(h)
          if (hb === 'rm') hasRm = true
          else if (hb === 'cd') hasCd = true
        }
      }
    }
    // claude-factory-4iod: deny-only second reading of each inner brace body. It never feeds a
    // relaxing input such as operandSkip or configUse.
    const bodies = braceBodies(words, state.braceWords)
    if (bodies.length > MAX_BRACE_BODIES) return SCAN_BUDGET_REASON
    for (const body of bodies) {
      const inner = wrapperReadingsDeny(body, root, otherSegs(segIdx))
      if (inner.deny) state.bodyDeny = true
      if (inner.rm) hasRm = true
      if (baseWord(realCommand(body)[0] ?? '') === 'cd') hasCd = true
    }
    const info = realCommandInfo(words)
    if (info.dynamicRepeatCount) return DYNAMIC_VERB_REASON
    const cmd = info.cmd
    for (const c of [cmd, realCommandInfo(dropRedirectWords(words)).cmd])
      if (c.length && dynamicCommandWord(c[0]!, c, 0) && dynamicDashedVerb(c[0]!))
        late.reason ??= DYNAMIC_VERB_REASON
    // k8iz: true when the miqy table read this pure $NAME head's value, so the late deny skips it.
    let headValueRead = false
    // The older dynamic-word scan keeps its own reason when it denies first.
    if (varsGuard(words, cmd)) {
      const headName = varRefName(cmd[0]!)
      if (headName) {
        const r = scanValue(headName, cmd.slice(1))
        if (r) return r
        headValueRead = vars.has(headName)
      } else if (gluedHeadReason(cmd[0]!, vars, mentions)) {
        // A later real command reason wins over this broad one.
        late.reason ??= DYNAMIC_VERB_REASON
      } else {
        // The head may name a set variable. ${!Y} names another one, so any set name denies.
        const opName = varOpName(cmd[0]!)
        if (
          opName &&
          (IMPLICIT_VARS.has(opName) ||
            vars.has(opName) ||
            mentions(opName) >= 2 ||
            cmd[0]!.startsWith('${!') ||
            dynWrite())
        )
          return DYNAMIC_VERB_REASON
        // piqf read this glued head and allowed it (no IFS, a path value), so the late deny skips it.
        const h0 = cmd[0]!
        if (/\$(?:\{[^}]*\}|[A-Za-z_]\w*)\//.test(h0) && !/[`]|\$\(/.test(h0)) headValueRead = true
      }
    }
    {
      // claude-factory-xbr1: skipSudoFlags skips a $=X or ${=X} word as NAME=value, and wrapper
      // value slots skip $X. A skipped word that expands a set name may split into a command.
      const skipped = words.slice(0, words.length - cmd.length)
      let k = 0
      while (k < skipped.length && /^[A-Za-z_]\w*\+?=/.test(skipped[k]!)) k++
      // claude-factory-qn8a.10: segments() ends a word at whitespace. bash reads a ${ word on to its
      // matching close brace and splits it, so an unclosed ${ in a wrapper slot can hide the command.
      // segments() also drops quotes, so the raw text is read.
      // A backslash-newline between the dollar and the brace joins them, so join it before the scan.
      // claude-factory-qn8a.10.6: realCommandInfo does not skip a redirect word, NAME+=value, an xargs
      // flag value or a find -exec body, so also read: a wrapper word before a $ word in the segment.
      const qWrap = words.findIndex(w => {
        const bw = baseWord(w)
        return LEAD_WRAPPERS.has(bw) || bw === 'find'
      })
      if (
        (skipped.slice(k).some(w => w.includes('$')) ||
          (qWrap >= 0 && words.slice(qWrap + 1).some(w => w.includes('$')))) &&
        hasSplitBrace(command.replace(/\\\n/g, ''))
      )
        late.reason ??= DYNAMIC_VERB_REASON
      for (const w of skipped.slice(k)) {
        // claude-factory-qn8a.11: a glob in a skipped word can expand to several words and hide rm.
        if (/[*?[]/.test(w)) late.reason ??= DYNAMIC_VERB_REASON
        for (const m of w.matchAll(/\$\{?[!=~^]*(?:\([^)]*\))?([A-Za-z_]\w*)/g)) {
          const n = m[1]!
          if (IMPLICIT_VARS.has(n) || vars.has(n) || mentions(n) >= 2 || m[0].startsWith('${!') || dynWrite())
            late.reason ??= DYNAMIC_VERB_REASON
        }
      }
    }
    if (!cmd.length) {
      // claude-factory-cwt9: `sudo -`y`` leaves no command word, but the backtick word can be one.
      if (words.some(w => w[0] === '-' && w.includes('`')) && wrapperReadingsDeny(words, root).deny)
        return REASON
      continue
    }
    const b = baseWord(cmd[0]!)
    // claude-factory-qn8a.22: the worker has the apply_patch tool, which the hook checks; codex applies a shell one unseen
    if (/^apply_?patch$/.test(b)) return APPLY_PATCH_SHELL_REASON
    // claude-factory-9zd5: namesGitAdminPath reads this segment's raw words, the same words
    // touchesBeadsActor and setsDangerousGitConfigEnv read above. isGitOrGhSegment tells R2
    // whether this segment's own command is git, a dashed git-<verb> binary, or gh.
    const isGitOrGhSegment = b === 'git' || /^git-/.test(b) || b === 'gh'
    if (namesGitAdminPath(words, isGitOrGhSegment, state)) state.gitAdminPath = true
    const mayTouch = segmentMayTouchGit(words)
    if (mayTouch && hasGitWordIn(words)) state.gitWord = true
    const isGitSegment = b === 'git' || /^git-/.test(b)
    const operandSkip: OperandSkip = READER_COMMANDS.has(b)
      ? 'reader'
      : (isGitSegment && !words.some(w => GIT_OPERAND_WRITER_RE.test(w))) ||
          (TEXT_OPERAND_COMMANDS.has(b) &&
            !(
              b === 'gh' &&
              (words.includes('clone') || words.some(w => /^--clone(=(?!false$)|$)/.test(w)))
            )) ||
          (b === 'bun' && cmd[1] === 'test')
        ? 'operands'
        : 'none'
    const configUse = mayTouch
      ? globalGitConfigUse(
          words,
          operandSkip,
          b === 'cd' || b === 'pushd' || b === 'popd' || b === 'chdir',
          state,
        )
      : undefined
    if (configUse === 'mention') state.globalGitConfig = true
    const cfgWrite = factoryConfigWrite(
      words,
      operandSkip,
      b === 'cd' || b === 'pushd' || b === 'popd' || b === 'chdir',
      root,
      g.cwd,
      movedSoFar,
      state,
    )
    if (cfgWrite === 'name') return FACTORY_CONFIG_REASON
    // a glob is a guess: a later real reason wins over it
    if (cfgWrite === 'glob') state.cfgGlob = true
    // claude-factory-25z.12: this scans every word, not only cmd[0]. An unknown wrapper must not
    // hide a kubectl, ko or helm word that follows it.
    //
    // claude-factory-p43v.10/.16/.17: a dynamic word can also hide kubectl, ko or helm itself.
    // anyLiveApplyWord never finds that word. The dynamic-word check returns its own reason,
    // DYNAMIC_VERB_REASON, not LIVE_REASON.
    if (personOnly?.length) {
      if (anyLiveApplyWord(words, personOnly)) return LIVE_REASON
      const dynamicLiveApply = anyDynamicLiveApplyReason(words, personOnly, state.braceWords)
      if (dynamicLiveApply) return dynamicLiveApply
    }
    // claude-factory-zl5: the same any-position scan, for a gh word a wrapper (sudo, env, watch,
    // timeout) can push past position 0.
    const ghFound = anyGhReason(words, g, state, ghConfigMovedSoFar, command, depth)
    if (ghFound) return ghFound
    const controlFound = anyFactoryControlReason(words)
    if (controlFound) return controlFound
    // claude-factory-zl5.3: the same any-position scan, for a git word a wrapper can push past
    // position 0. claude-factory-68gn: movedSoFar carries an earlier segment's cd/pushd/popd word
    // into this one.
    const gitFound = anyGitReason(words, root, g, state, movedSoFar)
    if (gitFound) return gitFound
    // claude-factory-p43v.5: a dynamic word, with no git or gh word of its own before it, can
    // still hide a verb or subcommand that anyGitReason and anyGhReason never see, because no
    // literal git or gh word ever starts this segment.
    // claude-factory-lpiu: a redirect word (`$G >f push`) is no flag, so read the words again
    // without redirects. This only adds denials.
    const dynamicCmdFound =
      anyDynamicCommandReason(words, state.braceWords) ??
      anyDynamicCommandReason(dropRedirectWords(words), state.braceWords)
    if (dynamicCmdFound) return dynamicCmdFound
    // claude-factory-clcc: deferred, so a more specific reason (a shell that reads stdin) wins.
    // claude-factory-clcc.11: no case-pattern skip. A glob case pattern denies (accepted over-deny),
    // because a body command can repeat a pattern word.
    if (anyGlobCommandWord(words)) state.globDeferred = true
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
      vars,
    )
    if (shellReason) return shellReason
    // claude-factory-4iod.5: a glued first word (`{git push`) hides from every word scan, so
    // the first glued body runs the full guard. Its own later glued bodies are suffixes of it:
    // the recursion reads them, so one call per level keeps the cost linear.
    // A glued `{` opens a group only at a command slot (see gluedBraceSlots).
    const gluedSlots = gluedBraceSlots(words)
    const glued = words.findIndex(
      (w, k) => k >= 1 && w !== '{' && braceOpensGroup(w, state.braceWords) && gluedSlots.has(k),
    )
    if (glued > 0) {
      const head = braceHead(words[glued]!)
      // claude-factory-4iod.10: a head with an expansion (`{${X:-rm} -rf / }`) names no command
      // the guard can read, so it denies at once.
      if (/[$`]/.test(head)) return DYNAMIC_VERB_REASON
      const text = (head ? [head, ...words.slice(glued + 1)] : words.slice(glued + 1)).join(' ')
      if (text) {
        const r = denyAt(text, root, personOnly, g, depth + 1, state, movedSoFar, ghConfigMovedSoFar)
        if (r) return r
      }
    }
    // claude-factory-l43b: a shell word with no -c script reads its script from stdin.
    const stdinShell = shellStdinReason(words, state)
    if (stdinShell || xargsRunsShell(words)) state.stdinDeferred = true
    if (
      !state.hookControl &&
      hookControlWrite(
        words,
        operandSkip,
        b === 'cd' || b === 'pushd' || b === 'popd' || b === 'chdir',
        g.cwd ?? root ?? process.cwd(),
        root ?? process.cwd(),
        g.hookDir ?? dirname(import.meta.dir),
        state,
        words.some(w => COPY_INTO_COMMANDS.has(baseWord(w))) ||
          (b === 'git' && words.some(w => GIT_OPERAND_WRITER_RE.test(w))),
      )
    )
      state.hookControl = true
    if (
      configUse === 'write' ||
      (mayTouch && (gitWorkTreeOutside(words, root, movedSoFar) || gitCoreWorktreeOutside(words, root)))
    )
      return GLOBAL_GIT_CONFIG_REASON
    // claude-factory-2a3i: a dynamic command word can expand to `command`, `sudo` or `env`, so the
    // word after it can be the real rm or find. Deny-only: cmd, b and operandSkip stay unchanged.
    const dynRm = dynamicHeadRmReading(words, root)
    if (dynRm === 'deny') return REASON
    if (dynRm === 'rm') hasRm = true
    // claude-factory-7xmz: a redirect word can come before the command word. It can also come in a
    // wrapper, assignment or find -exec slot. realCommand stops at it, so rm stays hidden.
    // This second reading only adds denies. It drops the redirect words and reads the command again.
    // The `<` and `>` check makes a segment with no redirect word almost free.
    if (words.some(w => w.includes('<') || w.includes('>'))) {
      const c2 = realCommand(dropRedirectWords(words))
      const b2 = c2.length ? baseWord(c2[0]!) : ''
      if (b2 === 'rm') {
        if (isRecursiveRm(c2) || rmTargets(c2).some(t => riskyTarget(t, root))) return REASON
        hasRm = true
      } else if (b2 === 'cd') {
        hasCd = true
      }
    }
    if (b === 'rm') {
      if (isRecursiveRm(cmd) || rmTargets(cmd).some(t => riskyTarget(t, root))) return REASON
      hasRm = true
    } else if (DIR_CHANGE_WORDS.has(b)) {
      hasCd = true
    } else if (b === 'find') {
      // claude-factory-clcc: a glob char in the word after -exec, -execdir, -ok or -okdir can expand to rm.
      for (let i = 0; i < cmd.length; i++) {
        if (cmd[i] === '-exec' || cmd[i] === '-execdir' || cmd[i] === '-ok' || cmd[i] === '-okdir') {
          if (i + 1 < cmd.length && globCommandWord(cmd[i + 1]!, cmd[i + 2])) return DYNAMIC_VERB_REASON
        }
      }
      if (findBraceRmDeny(cmd) || findExecRmDeny(cmd) || findDeleteDeny(cmd, root)) return REASON
      if (findHasDelete(cmd)) hasRm = true
    }
    // easj.16/.17: a find with a delete word denies when an xargs word comes before the find word
    // (the replacement string can fill the start path) or when the tool call's cwd is outside root.
    if (findHasDelete(words)) {
      const fi = words.findIndex(w => baseWord(w) === 'find')
      if (fi >= 0) {
        if (words.slice(0, fi).some(w => baseWord(w) === 'xargs')) return REASON
        if (g.cwd !== undefined && g.cwd !== root && findPathRisky(g.cwd, root)) return REASON
      }
    }
    // claude-factory-j471: a redirect word (`>f find ...`, `find -exec >f rm ...`) can hide the
    // find word or the slot head. Read the segment again without its redirect words.
    if (words.some(w => /[<>]/.test(w))) {
      const c2 = realCommand(dropRedirectWords(words))
      if (
        c2.length &&
        baseWord(c2[0]!) === 'find' &&
        (findBraceRmDeny(c2) || findExecRmDeny(c2) || findDeleteDeny(c2, root))
      )
        return REASON
      if (c2.length && baseWord(c2[0]!) === 'find' && findHasDelete(c2)) hasRm = true
    }
    // claude-factory-21ux: read an unknown wrapper flag as a bare flag and as a flag with a value.
    const readings = wrapperReadingsDeny(words, root, otherSegs(segIdx))
    // claude-factory-clcc: a glob command word keeps its own reason when this reading denies it.
    if (readings.deny)
      return anyGlobCommandWord(words.filter(w => !w.includes('$'))) ? DYNAMIC_VERB_REASON : REASON
    if (readings.rm) hasRm = true
    // k8iz: this reading is late, so a specific reason (push, alias, here-document) wins.
    if (
      (segIfs[segIdx] || outerSegs.ifs) &&
      !late.reason &&
      !headValueRead &&
      wrapperReadingsDeny(words, root, otherSegs(segIdx, true)).deny
    ) {
      late.reason = REASON
      state.ifsLate = true
    }
    // claude-factory-pwy0: a leading redirect word hides a dynamic command word that reads as rm.
    if (words.some(w => w.includes('$')) && words.some(w => /[<>]/.test(w))) {
      const dropped = wrapperReadingsDeny(dropRedirectWords(words), root, otherSegs(segIdx))
      if (dropped.deny) return REASON
      if (dropped.rm) hasRm = true
      if (
        (segIfs[segIdx] || outerSegs.ifs) &&
        !late.reason &&
        !headValueRead &&
        wrapperReadingsDeny(dropRedirectWords(words), root, otherSegs(segIdx, true)).deny
      ) {
        late.reason = REASON
        state.ifsLate = true
      }
    }
    // claude-factory-sdur: a redirect word (`>f`, `{fd}>f`) is not the command or an -exec word.
    // Read the segment again without redirect words. Deny-only.
    if (words.some(w => /[<>]/.test(w))) {
      const noRedir = dropRedirectWords(words)
      if (noRedir.length !== words.length) {
        const real = realCommand(noRedir)
        if (rmFindDeny(real, root)) return REASON
        const base = baseWord(real[0] ?? '')
        if (base === 'rm') hasRm = true
        else if (base === 'cd') hasCd = true
      }
    }
    // claude-factory-68gn: a cd, pushd, popd or chdir word anywhere in this segment moves the
    // shell's own current directory for every segment after it (not for an env -C or --git-dir
    // flag, which only moves the one command it wraps: anyGitReason's and anyShellReason's own
    // `moved` accumulator reads those, and this segment's own cd/pushd/popd/chdir word, through
    // their own forward scan). This check runs after the checks above, so it affects only a
    // later segment's push, never this one.
    if (splitWords) {
      const splitBase = baseWord(realCommand(splitWords)[0] ?? '')
      if (splitBase === 'rm') hasRm = true
      else if (splitBase === 'cd') hasCd = true
    }
    if (hasDirChangeWord(words) || (splitWords && hasDirChangeWord(splitWords))) movedSoFar = true
    // claude-factory-bemr: the same rule, for a GH_CONFIG_DIR, XDG_CONFIG_HOME, or HOME
    // assignment anywhere in this segment. It carries into every later segment's gh alias
    // lookup, the same way movedSoFar does above for a git alias lookup.
    if (hasGhConfigEnvWord(words) || (splitWords && hasGhConfigEnvWord(splitWords))) ghConfigMovedSoFar = true
  }
  const tailReason = scanSubs(Infinity)
  if (tailReason) return tailReason
  if (hasDangerousConfigEnv && (state.gitWord || commandHasGitWord(command))) return PUSH_REASON
  if (backtickBesidePush(command)) return PUSH_REASON
  if (definesFunction) return FUNCTION_DEF_REASON
  if (quotedAssign) return QUOTED_ASSIGNMENT_REASON
  // claude-factory-clcc: a glob command word keeps its own reason, as in the stdin deferral.
  if (ambiguousAssignment) return state.globDeferred ? DYNAMIC_VERB_REASON : ASSIGNMENT_PREFIX_REASON
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
// dir is the directory to read config for.
// claude-factory-bemr.16: main() always calls this with the tool call's own cwd. It never
// passes a directory that a -C fold computed.
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

// claude-factory-1zr5: unquotes the text after `name=` in one `alias -- name=value` snapshot line.
// zsh prints a value bare, or as single-quoted spans joined with `\'`. A quoted span can cross lines.
// It returns the value and the index of the line that ends it, or null for any other quoting.
function unquoteAliasValue(
  lines: string[],
  first: number,
  start: number,
): { value: string; end: number } | null {
  let value = ''
  let li = first
  let line = lines[li]!
  let i = start
  let quoted = false
  for (;;) {
    if (i >= line.length) {
      if (!quoted) return { value, end: li }
      li++
      if (li >= lines.length) return null
      value += '\n'
      line = lines[li]!
      i = 0
      continue
    }
    const c = line[i]!
    if (quoted) {
      if (c === "'") quoted = false
      else value += c
      i++
    } else if (c === "'") {
      quoted = true
      i++
    } else if (c === '\\' && i + 1 < line.length) {
      value += line[i + 1]
      i += 2
    } else if (/[A-Za-z0-9_@%+=:,./~^-]/.test(c)) {
      value += c
      i++
    } else {
      return null
    }
  }
}

const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
const SNAPSHOT_FILES = 3

/** claude-factory-usqc: the texts of the newest snapshot files, oldest first. A missing folder gives []. A read error or a file over 4 MiB gives undefined. */
export function snapshotTexts(dir: string): string[] | undefined {
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => /^snapshot-.*\.sh$/.test(n))
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : undefined
  }
  try {
    const files = names
      .map(n => ({ path: joinPath(dir, n), st: statSync(joinPath(dir, n)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, SNAPSHOT_FILES)
      .reverse()
    if (files.some(f => f.st.size > SNAPSHOT_MAX_BYTES)) return undefined
    return files.map(f => readFileSync(f.path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * claude-factory-usqc: the function names in the same snapshot files, with the same file choice and
 * size cap as `shellSnapshotAliases`. A line `name () {` (indented or not), `function name {` or
 * `function name() {` names one. A missing folder gives an empty Set. A read error gives undefined.
 */
export function shellSnapshotFunctions(
  dir: string,
  read: (dir: string) => string[] | undefined = snapshotTexts,
): Set<string> | undefined {
  const texts = read(dir)
  if (!texts) return undefined
  const names = new Set<string>()
  for (const text of texts)
    for (const line of text.split('\n')) {
      const m = /^\s*(?:function\s+(\S+?)\s*(?:\(\s*\))?\s*\{|(\S+)\s*\(\)\s*\{)/.exec(line)
      if (m) names.add(m[1] ?? m[2]!)
      // Claude Code writes a bash function as `eval $'name () \n{ ...'` (`eval -- ` for a name that
      // starts with - or +). A line this reader cannot name fails closed.
      else if (/^eval\b/.test(line)) {
        const e = /^eval(?: --)? \$?'([A-Za-z0-9_.:@%+-]+) \(\) /.exec(line)
        if (!e) return undefined
        names.add(e[1]!)
      }
    }
  return names
}

/**
 * claude-factory-1zr5: reads the shell aliases from the newest three `snapshot-*.sh` files in `dir`
 * (Claude Code's shell-snapshots folder), a newer file over an older one. The Bash tool shell
 * sources a snapshot before each command, so its aliases expand there. The hook never learns which
 * snapshot a session uses, so it reads the union.
 *
 * A value maps to null when this reader cannot unquote it. A missing folder gives an empty Map.
 * A folder or file that cannot be read, or a file over 4 MiB, gives undefined (fail closed).
 * `read` gives the file texts, oldest first (default `snapshotTexts`).
 */
export function shellSnapshotAliases(
  dir: string,
  read: (dir: string) => string[] | undefined = snapshotTexts,
): Map<string, string | null> | undefined {
  const texts = read(dir)
  if (!texts) return undefined
  const table = new Map<string, string | null>()
  try {
    for (const text of texts) {
      const lines = text.split('\n')
      for (let n = 0; n < lines.length; n++) {
        const m = /^alias -- ([^=\s]+)=/.exec(lines[n]!)
        if (!m) continue
        const parsed = unquoteAliasValue(lines, n, m[0].length)
        if (parsed) {
          table.set(m[1]!, parsed.value)
          n = parsed.end
        } else {
          table.set(m[1]!, null)
        }
      }
    }
  } catch {
    return undefined
  }
  return table
}

// Claude's Bash tool runs a call for 2 min when it names no timeout
const BASH_DEFAULT_MS = 120_000
// the least a clamped call still gets, so a report or a commit runs even past the deadline
const CLAMP_FLOOR_MS = 30_000

/**
 * A Bash call's timeout cut to what is left before the station's deadline (FACTORY_DEADLINE, ms), or undefined
 * when the call already ends in time. A command then ends before the run fails, and the worker still has
 * its turn to commit and report (claude-factory-p0yt). A background call has no timeout to clamp.
 */
export function clampTimeout(
  input: { timeout?: number; run_in_background?: boolean },
  deadline: number,
  now: number,
) {
  if (input.run_in_background || !Number.isFinite(deadline)) return undefined
  const left = Math.max(CLAMP_FLOOR_MS, deadline - now)
  return left < (input.timeout ?? BASH_DEFAULT_MS) ? left : undefined
}

export const HOOK_CONTROL_REASON =
  'The factory denies this write: it targets the hook source, a .claude/settings.json or settings.local.json file, a .cursor/hooks.json file, or a file in .grok. A write there turns the guard off. To read the file, use cat or git show origin/main:<path>. Do not retry this write.'

// a parent of the hook dir (also a bare /) is a hook-control path in a segment with one of these words and in cd:
// find / and ls -d / and alias ~ must stay allowed
// Best effort (claude-factory-qn8a.65): a new parent-of-hook-dir form is not a defect here. The sandbox is the real barrier.
const COPY_INTO_COMMANDS = new Set([
  'cp',
  'mv',
  'rsync',
  'install',
  'ln',
  'tar',
  'unzip',
  'ditto',
  'bsdtar',
  'gtar',
  'pax',
  'cpio',
  '7z',
  '7za',
  '7zr',
  'gcp',
  'gmv',
  'ginstall',
  'patch',
])
const CD_WORDS = new Set(['cd', 'pushd', 'popd', 'chdir'])
const HOOK_MODULES = ['worker-hook.ts', 'home-guard.ts', 'cut.ts']
const SETTINGS_NAMES = ['settings.json', 'settings.local.json']

// claude-factory-qn8a.21.11: APFS folds case fully (U+017F long s opens as s), so fold the way foldNonAscii does.
const foldLower = (s: string): string => s.toUpperCase().toLowerCase()

/**
 * claude-factory-qn8a.21: true when `abs` is a hook-control path. That is a `.claude` dir, a settings.json or
 * settings.local.json in one, or (outside `root`) the hook dir or a path under it.
 * With `ancestor`, a parent of the hook dir counts too (Bash write words only; a reader operand is skipped before).
 * Case folds to lower. If root and the hook dir overlap, only the hook modules count.
 */
function hookControlPath(abs: string, root: string, hookDir: string, ancestor = false): boolean {
  const a = foldLower(abs)
  const parts = a.split('/').filter(Boolean)
  const n = parts.length
  if (parts[n - 1] === '.claude') return true
  if (parts[n - 1] === '.cursor' || (n >= 2 && parts[n - 2] === '.cursor' && parts[n - 1] === 'hooks.json'))
    return true
  // grok loads hooks and config from .grok/hooks/*.json and .grok/config.toml
  if (parts[n - 1] === '.grok' || parts[n - 2] === '.grok' || (n >= 3 && parts[n - 3] === '.grok'))
    return true
  if (n >= 2 && parts[n - 2] === '.claude' && SETTINGS_NAMES.includes(parts[n - 1]!)) return true
  const h = foldLower(hookDir)
  const r = foldLower(root)
  const under = (p: string, d: string) => p === d || p.startsWith(d.endsWith('/') ? d : d + '/')
  if (under(h, r) || under(r, h)) return HOOK_MODULES.some(m => a === `${h}/src/${m}`)
  // a Bash write word can name a parent of the hook dir (cp -R x /f/, tar -C /f); a Write tool path cannot
  return under(a, h) || (ancestor && under(h, a))
}

// `{a,b}` and `{x..y}` expansion with nesting, capped. undefined means over the cap. A group with no comma
// and no sequence stays literal, as in bash.
// claude-factory-qn8a.21.17: `budget.n` counts the characters read; at zero the result is undefined (deny), so
// the hook stays inside its 10 s timeout.
export function expandBraces(w: string, cap = 64, budget = { n: 200_000 }): string[] | undefined {
  let from = 0
  for (;;) {
    const open = w.indexOf('{', from)
    if (open < 0) return [w]
    let depth = 0
    let close = -1
    const cuts: number[] = []
    if ((budget.n -= w.length - open) < 0) return undefined
    for (let i = open; i < w.length; i++) {
      const c = w[i]
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        close = i
        break
      } else if (c === ',' && depth === 1) cuts.push(i)
    }
    if (close < 0) {
      // bash skips an unmatched { and expands a later group
      from = open + 1
      continue
    }
    const pre = w.slice(0, open)
    const post = w.slice(close + 1)
    const body = w.slice(open + 1, close)
    let alts: string[] | undefined
    if (cuts.length) {
      alts = []
      let at = open + 1
      for (const c of [...cuts, close]) {
        alts.push(w.slice(at, c))
        at = c + 1
      }
    } else {
      const sq = body.match(/^([-+]?\d+|[A-Za-z])\.\.([-+]?\d+|[A-Za-z])(?:\.\.([-+]?\d+))?$/)
      if (sq && /\d/.test(sq[1]!) === /\d/.test(sq[2]!)) {
        const num = /\d/.test(sq[1]!)
        const x = num ? Number(sq[1]) : sq[1]!.charCodeAt(0)
        const y = num ? Number(sq[2]) : sq[2]!.charCodeAt(0)
        const step = Math.abs(Number(sq[3] ?? 1)) || 1
        if (Math.abs(y - x) / step + 1 > cap) return undefined
        // a zero-padded end pads every value to the longer end, as bash does; a negative padded end denies
        const padded = num && (/^-?0\d/.test(sq[1]!) || /^-?0\d/.test(sq[2]!))
        if (padded && (sq[1]!.startsWith('-') || sq[2]!.startsWith('-'))) return undefined
        const width = padded ? Math.max(sq[1]!.length, sq[2]!.length) : 0
        alts = []
        for (let v = x; x <= y ? v <= y : v >= y; v += x <= y ? step : -step)
          alts.push(num ? String(v).padStart(width, '0') : String.fromCharCode(v))
      }
    }
    if (!alts) {
      from = close + 1
      continue
    }
    const out: string[] = []
    for (const alt of alts) {
      const sub = expandBraces(pre + alt + post, cap, budget)
      if (!sub) return undefined
      out.push(...sub)
      if (out.length > cap) return undefined
    }
    return out
  }
}

/**
 * claude-factory-qn8a.21: true when one word, read as a write target, can name a hook-control path.
 * A word with an expansion (`$`, a backtick, ~user) denies when a part of it names the hook dir, a hook module,
 * `.claude` or a settings file. A glob denies when it can match one (a `*` never matches a leading dot).
 * Out of scope (ponytail): a path built at run time, a symlink made in the same command.
 * A write into a parent of the hook dir is best effort only (claude-factory-qn8a.65).
 */
function hookControlWord(
  word: string,
  cwd: string,
  root: string,
  hookDir: string,
  state?: ScanState,
  copyInto = false,
  isCd = false,
): boolean {
  const x = word.replace(/["'\\]/g, '')
  if (!x) return false
  // the caller expanded the braces (braceVariants); a charge per word keeps the scan inside the work budget
  if (state && spendWork(state, x.length + 1)) return true
  const base = foldLower(hookDir.split('/').filter(Boolean).pop() ?? '\0')
  // $HOME as a copy or cd target is a parent of the hook dir; other bare expansions stay allowed (cp "$A" "$B")
  if ((copyInto || isCd) && /^\$\{?(home|userprofile|oldpwd)\}?\/*$/i.test(x)) return true
  if (/[$`]|^~[^/]/.test(x)) {
    const ps = foldLower(x).split('/').filter(Boolean)
    const last = ps[ps.length - 1] ?? ''
    return (
      ps.includes(base) ||
      ps.includes('.claude') ||
      HOOK_MODULES.includes(last) ||
      SETTINGS_NAMES.includes(last)
    )
  }
  const abs = resolvePath(cwd, x === '~' || x.startsWith('~/') ? homedir() + x.slice(1) : x)
  if (/[*?[]/.test(x)) {
    const fabs = foldNonAscii(abs)
    const samples = [
      hookDir,
      `${hookDir}/src`,
      `${hookDir}/package.json`,
      ...HOOK_MODULES.map(m => `${hookDir}/src/${m}`),
    ]
    if (!abs.startsWith(root + '/') && globCanMatch(fabs, samples.map(foldNonAscii), state)) return true
    const ps = fabs.split('/').filter(Boolean)
    const last = ps[ps.length - 1]
    const prev = ps[ps.length - 2]
    if (last?.startsWith('.') && globCanMatch(last, ['.claude'], state)) return true
    return !!(
      prev?.startsWith('.') &&
      globCanMatch(
        `${prev}/${last}`,
        SETTINGS_NAMES.map(s => `.claude/${s}`),
        state,
      )
    )
  }
  return hookControlPath(abs, root, hookDir, copyInto || isCd)
}

const BRACE_SENTINEL: Record<string, string> = { '{': '\u0001', '}': '\u0002', ',': '\u0003' }

/**
 * claude-factory-qn8a.21.17 .18 .19: the word, then each brace expansion of it, so the caller reads every result
 * with the flag rules. The tokenizer removed the quotes, so a quoted or escaped brace or comma may be text for the
 * shell. `hidden` holds the word with those chars replaced by sentinels. The word is expanded both ways and the
 * sentinels go back in each result. undefined means over the cap or the work bound (deny).
 */
function braceVariants(word: string, hidden: string[] = [], state?: ScanState): string[] | undefined {
  if (!word.includes('{')) return [word]
  const out = [word]
  const back = ['{', '}', ',']
  for (const h of [word, ...hidden]) {
    const alts = expandBraces(h)
    if (!alts) return undefined
    // the work budget and the deadline apply in every segment kind (qn8a.21.20)
    if (
      state &&
      spendWork(
        state,
        alts.reduce((n, a) => n + a.length + 1, 0),
      )
    )
      return undefined
    for (const a of alts) out.push(a.replace(/[\u0001-\u0003]/g, c => back[c.charCodeAt(0) - 1]!))
  }
  // a stray { or } the shell keeps as text: read the result without it too (ponytail: only adds deny readings)
  return out.flatMap(v => (/[{}]/.test(v) ? [v, v.replace(/[{}]/g, '')] : [v]))
}

// claude-factory-qn8a.21.12 .15: every tail of a single-dash word (-s4o/f gives 4o/f, o/f and /f).
// A tail that is not a hook-control path allows, so a reader flag such as tail -n5 stays allowed.
// A word over 1024 chars gives the tail `.claude`, which denies (fail closed, bounded scan).
function gluedTails(x: string): string[] {
  if (x.length < 2 || x[0] !== '-' || x[1] === '-') return []
  if (x.length > 1024) return ['.claude']
  const out: string[] = []
  for (let i = 2; i < x.length; i++) out.push(x.slice(i))
  return out
}

const OVERCAP_WRITE_MARK_RE =
  /-[oOD]|--(?:output|dir|reporter-outfile)|of=|\.claude|settings|worker-hook|home-guard|cut\.ts|package|\//i
const HOOK_CONTROL_MAY_RE = /[\/$`~*?[{<>\\]|\.claude|settings|worker-hook|home-guard|cut\.ts|package/i

/**
 * claude-factory-qn8a.21: true when a segment can write a hook-control path. It uses the model of
 * `globalGitConfigUse`: a redirect target, an `of=` value, an output-flag value, or an operand of a command
 * that is not a reader. A git or text-operand segment skips its operands. A cd, pushd or popd into a hook-control
 * dir or any `.claude` dir denies. The value of an `--opt=value` word is tested too.
 */
function hookControlWrite(
  words: string[],
  skip: OperandSkip,
  isCd: boolean,
  cwd: string,
  root: string,
  hookDir: string,
  state?: ScanState,
  copyInto = false,
): boolean {
  if (isCd) {
    // cd with no operand, cd -, or a .. that leaves root: the guard does not track the cwd across segments
    const ops = words.filter(w => !CD_WORDS.has(baseWord(w)) && !/^-./.test(w))
    if (!ops.length || ops.includes('-')) return true
    if (
      ops.some(w => {
        if (!/(^|\/)\.\.(\/|$)/.test(w)) return false
        const r = resolvePath(cwd, w.replace(/["'\\]/g, ''))
        return r !== root && !r.startsWith(root + '/')
      })
    )
      return true
  }
  if (!hookControlPath(cwd, root, hookDir) && !HOOK_CONTROL_MAY_RE.test(foldNonAscii(joinedWords(words))))
    return false
  let pending = false
  let prevWriterFlag = false
  // a bare / counts as the last word, as a cd word, or in a copy word after a dir flag or a plain operand
  // (tar -C /, cp -t /, rsync x / -v); sudo -R / stays allowed
  const last = words[words.length - 1]
  let prev = ''
  const test = (x: string) =>
    (x !== '/' ||
      x === last ||
      isCd ||
      (copyInto && (!prev.startsWith('-') || /^-[CtdDo]$|^--target-directory$/.test(prev)))) &&
    (hookControlWord(x, cwd, root, hookDir, state, copyInto, isCd) ||
      // a glued output value (7z -o/f, tar -C/f)
      (copyInto &&
        /^-[oCtD]./.test(x) &&
        hookControlWord(x.slice(2), cwd, root, hookDir, state, true, isCd)) ||
      // a short flag with a glued value or a cluster (curl -so/f, wget -qO/f, make -C.claude): each tail is a value
      gluedTails(x).some(t => hookControlWord(t, cwd, root, hookDir, state, false, false)))
  for (const [k, word] of words.entries()) {
    prev = words[k - 1] ?? ''
    const afterWriterFlag = prevWriterFlag
    const wasPending = pending
    pending = false
    prevWriterFlag = false
    // claude-factory-qn8a.21.18: read the word and each brace expansion of it with the same flag rules
    const variants = braceVariants(word, state?.quotedBraces.get(word), state)
    for (const v of variants ?? [word]) {
      prevWriterFlag ||= skip === 'operands' && OUTPUT_FLAG_EXACT_RE.test(v)
      let candidate = v
      let redirect = wasPending
      const m = v.match(REDIRECT_PREFIX_RE)
      if (m && m[0].length === v.length) {
        pending = true
        continue
      }
      if (m) {
        candidate = v.slice(m[0].length)
        redirect = true
      } else if (!wasPending && /^of=/i.test(v)) {
        candidate = v.slice(3)
        redirect = true
      }
      if (isCd && !redirect) {
        if (!variants || test(v) || /(^|\/)\.claude(\/|$)/i.test(v.replace(/["'\\]/g, ''))) return true
        continue
      }
      if (!redirect) {
        // claude-factory-qn8a.21.22: an over-cap list with a write marker must not take the operand skip
        if (!variants && skip === 'operands' && OVERCAP_WRITE_MARK_RE.test(word)) return true
        if (skip === 'reader') continue
        if (skip === 'operands' && !afterWriterFlag && !OUTPUT_FLAG_RE.test(v) && !gluedTails(v).length)
          continue
      }
      // an over-cap list denies where the word would be read as a write target
      if (!variants || test(candidate)) return true
      const eq = candidate.match(/^(?:--[\w-]+|[A-Za-z_]\w*)=([\s\S]+)$/)
      if (eq && test(eq[1]!)) return true
    }
  }
  return false
}

export const FACTORY_CONFIG_REASON =
  'The factory denies this write: it targets the factory home rigs.json, a worker-settings*.json file or a run inbox.jsonl or state.json, or a path with that name that the hook cannot place inside the worktree. The first two set the rig merge authority and the deny hook; only a person edits them. A write to inbox.jsonl or state.json forges manager mail. To read one, use cat. To make a test copy, redirect into .scratch/ in the worktree: cat /h/rigs.json > .scratch/rigs.json. Do not retry this exact command.'

export const FILE_WRITE_REASON =
  "The factory denies this file write: it targets a .git dir, the global git config or Claude Code's shell-snapshots folder. A worker never needs to write these. Use git commands for repo state."

/** True when the path parts (lower case) name a .git component, a git config file or a shell-snapshots folder. */
function protectedParts(parts: string[], xdg: string[]): boolean {
  const n = parts.length
  const last = parts[n - 1]
  if (parts.includes('.git') || parts.includes('shell-snapshots')) return true
  if (last === '.gitconfig' || last === 'gitconfig') return true
  if (n >= 2 && last === 'config' && parts[n - 2] === 'git') return true
  if (parts.some((p, k) => p === '.config' && parts[k + 1] === 'git')) return true
  return xdg.length > 0 && xdg.every((p, k) => parts[k] === p) && parts[xdg.length] === 'git'
}

/**
 * claude-factory-g4du: the reason to deny a Write, Edit, MultiEdit or NotebookEdit of `path`, or undefined.
 * It fails closed on a missing, empty, NUL or ~user path. It checks the lexical path and the real path
 * (the nearest existing ancestor through realpath), in lower case, so a symlink or a case change does not pass.
 * Known gaps: a hard link made earlier, a bare repo dir named x.git, GIT_CONFIG_GLOBAL, the gh config.
 * The hook source and .claude/settings*.json answer with HOOK_CONTROL_REASON
 * (claude-factory-qn8a.21); rigs.json and worker-settings*.json are claude-factory-qn8a.20.
 */
export function fileWriteReason(
  path: unknown,
  cwd: string,
  env: { home: string; xdg?: string | undefined } = { home: homedir(), xdg: process.env.XDG_CONFIG_HOME },
  root: string = process.env.CLAUDE_PROJECT_DIR || cwd,
  hookDir: string = dirname(import.meta.dir),
): string | undefined {
  if (typeof path !== 'string' || !path || path.includes('\0') || /^~[^/]/.test(path))
    return FILE_WRITE_REASON
  const abs = resolvePath(cwd, path === '~' || path.startsWith('~/') ? env.home + path.slice(1) : path)
  const split = (x: string) => foldLower(foldNonAscii(x)).split(sep).filter(Boolean)
  const xdg = env.xdg ? split(resolvePath(env.xdg)) : []
  let real = abs
  const rest: string[] = []
  for (;;) {
    try {
      real = joinPath(realpathSync(real), ...rest)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(real) === real) return FILE_WRITE_REASON
      rest.unshift(real.slice(dirname(real).length + 1))
      real = dirname(real)
    }
  }
  let realHook = hookDir
  try {
    realHook = realpathSync(hookDir)
  } catch {}
  if (
    hookControlPath(abs, root, hookDir) ||
    hookControlPath(real, root, hookDir) ||
    hookControlPath(real, root, realHook)
  )
    return HOOK_CONTROL_REASON
  if (protectedParts(split(abs), xdg) || protectedParts(split(real), xdg)) return FILE_WRITE_REASON
  // claude-factory-qn8a.20: rigs.json and worker-settings*.json set the merge authority and the hook.
  // Only a path inside the worktree root (lexical, and real) may carry one of these names.
  let realRoot = root
  try {
    if (root) realRoot = realpathSync(root)
  } catch {}
  const inside = (p: string) => [root, realRoot].some(r => !!r && p.startsWith(r.endsWith(sep) ? r : r + sep))
  const config = (p: string) =>
    /^((rigs|worker-settings.*)\.json|inbox\.jsonl|state\.json)$/i.test(
      foldNonAscii(p.split(sep).pop() ?? ''),
    )
  return [abs, real].some(p => config(p) && !inside(p)) ? FACTORY_CONFIG_REASON : undefined
}

export const APPLY_PATCH_REASON =
  'The factory denies this apply_patch: the hook cannot read it. The hook reads only the lines that start with *** and needs each one to be *** Begin Patch, *** End Patch, *** End of File, or *** Add File:, *** Delete File:, *** Update File: or *** Move to: and a path that does not start with ~. If a content line starts with ***, edit that line with a script in .scratch/. Do not retry this exact patch.'

export const APPLY_PATCH_SHELL_REASON =
  'The factory denies this command: it runs apply_patch in the shell. Use your apply_patch tool. The hook checks each path of that tool. Do not retry this exact command.'

// The Rust char::is_whitespace set: codex trims patch lines with it. JS trim() differs at U+0085 and U+FEFF.
const RUST_WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const RUST_TRIM = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g')

/**
 * claude-factory-qn8a.22: the paths that a codex apply_patch input adds, deletes, updates or moves to, or
 * undefined when the input is not the closed grammar (the fail-closed case). Pure: it calls no fs function.
 * Only tool_input.command is read, and it must be the only key. Each line that starts with *** (after the
 * Rust trim) must be a known header; any other *** line, a ~ path or a patch with no Add, Delete or Update header is undefined.
 */
export function applyPatchPaths(input: unknown): string[] | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const keys = Object.keys(input)
  const command = (input as { command?: unknown }).command
  if (keys.length !== 1 || typeof command !== 'string') return undefined
  if (command.includes('\0')) return undefined
  const paths: string[] = []
  let files = 0
  for (const raw of command.split('\n')) {
    const line = raw.replace(RUST_TRIM, '')
    if (!line.startsWith('***')) continue
    if (line === '*** Begin Patch' || line === '*** End Patch' || line === '*** End of File') continue
    const m = /^\*\*\* (Add File|Delete File|Update File|Move to): (.+)$/.exec(line)
    if (!m || m[2]!.startsWith('~')) return undefined
    if (m[1] !== 'Move to') files++
    paths.push(m[2]!)
  }
  return files ? paths : undefined
}

/** claude-factory-qn8a.22: the reason to deny a codex apply_patch input, or undefined. Same arguments as fileWriteReason. */
export function applyPatchReason(
  input: unknown,
  cwd: string,
  env?: { home: string; xdg?: string | undefined },
  root?: string,
  hookDir?: string,
): string | undefined {
  const paths = applyPatchPaths(input)
  if (!paths) return APPLY_PATCH_REASON
  for (const p of paths) {
    const r = fileWriteReason(p, cwd, env, root, hookDir)
    if (r) return r
  }
  return undefined
}

/** The name of the exported *REASON constant that holds `reason`, or UNKNOWN. Counts denials by rule (claude-factory-dsfg). */
export function reasonName(reason: string): string {
  for (const [k, v] of Object.entries({ ...self, HOME_REASON }))
    if (k.endsWith('REASON') && v === reason) return k
  return 'UNKNOWN'
}

const HARNESSES = ['claude', 'codex', 'pi', 'cursor', 'grok']

/**
 * claude-factory-uzes, -wkg4: the deny log keeps no secret. The first `=` or `${` and all text after it become ***.
 * Why: bash word rules (quotes, IFS, braces, substitutions) are not regular, so no regex finds where a value ends.
 * Out of scope (claude-factory-pwg3): a secret with no `=` and no `${` before it, as in `printf -v X v`.
 */
export function maskAssignments(command: string): string {
  return command.replace(/(=|\$\{)[\s\S]*/, '$1***')
}

/**
 * claude-factory-dsfg: record one denial as a JSON line in FACTORY_HOME/runs/<FACTORY_RUN>/denials.jsonl, and,
 * for an AX worker whose laptop replays it (FACTORY_DENY_LOG=1), in the outbox. It runs after the deny is
 * printed and never throws: a log failure must not change the deny. It makes no dir; the laptop made the run dir.
 */
function logDenial(reason: string, command: string, harness: string | undefined) {
  try {
    const run = process.env.FACTORY_RUN
    const station = process.env.FACTORY_FROM
    const at = Date.now()
    const h = harness && HARNESSES.includes(harness) ? harness : 'unknown'
    const name = reasonName(reason)
    const cmd = cut(maskAssignments(command), 200)
    if (process.env.FACTORY_OUTBOX && process.env.FACTORY_DENY_LOG === '1')
      appendFileSync(
        process.env.FACTORY_OUTBOX,
        JSON.stringify({ deny: { at, harness: h, reason: name, command: cmd }, from: station, at }) + '\n',
      )
    if (process.env.FACTORY_HOME && run && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run))
      appendFileSync(
        joinPath(process.env.FACTORY_HOME, 'runs', run, 'denials.jsonl'),
        JSON.stringify({ at, run, station, harness: h, reason: name, command: cmd }) + '\n',
        { mode: 0o600 },
      )
  } catch {}
}

/** claude-factory-sibp: main() prints this when a guard throws. It holds no exception text and no command text. */
export const HOOK_ERROR_REASON =
  'The factory denies this command: the factory hook failed while it checked the command. ' +
  'Run a simpler command. Do not retry this exact command.'

function denyOut(reason: string) {
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

/**
 * Cursor's preToolUse input in Claude's shape: Shell is Bash. Write (an edit also arrives as Write) and Delete carry a
 * file_path, so both go to the file-write guard. Read, Grep and other tools keep their names.
 */
export function cursorInput(input: unknown) {
  const i = input as { tool_name?: string }
  const tool = i?.tool_name
  const name = tool === 'Shell' ? 'Bash' : tool === 'Delete' ? 'Write' : tool
  return name === tool ? input : { ...i, tool_name: name }
}

/** the lines `handle` printed, in Cursor's reply: the first deny (user_message shows to the model), else allow */
export function cursorReply(printed: string[]) {
  for (const l of printed) {
    const o = JSON.parse(l).hookSpecificOutput
    if (o?.permissionDecision === 'deny')
      return {
        permission: 'deny',
        user_message: o.permissionDecisionReason,
        agent_message: o.permissionDecisionReason,
      }
  }
  return { permission: 'allow' }
}

/**
 * Grok's preToolUse input in Claude's shape: run_terminal_command is Bash, an edit or write is Write, read_file is Read
 * (its path is target_file). Grok reads Claude's reply as it is, so there is no reply adapter.
 */
export function grokInput(input: unknown) {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> }
  const t = i?.tool_name
  if (t === 'run_terminal_command') return { ...i, tool_name: 'Bash' }
  if (t === 'search_replace' || t === 'write') return { ...i, tool_name: 'Write' }
  if (t === 'read_file')
    return { ...i, tool_name: 'Read', tool_input: { ...i.tool_input, file_path: i.tool_input?.target_file } }
  return t === 'grep' ? { ...i, tool_name: 'Grep' } : input
}

async function main() {
  const text = await Bun.stdin.text()
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return
  }
  if (flag('--harness') === 'cursor') {
    // a guard prints its deny through console.log: catch the lines and answer in Cursor's shape
    const printed: string[] = []
    const log = console.log
    console.log = (l: string) => void printed.push(l)
    try {
      guard(cursorInput(input))
    } finally {
      console.log = log
    }
    console.log(JSON.stringify(cursorReply(printed)))
    return
  }
  guard(flag('--harness') === 'grok' ? grokInput(input) : input)
}

const flag = (name: string) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

function guard(input: unknown) {
  // claude-factory-sibp: a throw in any guard denies. An uncaught throw exits 1, and Claude Code lets the command run.
  try {
    handle(input)
  } catch {
    denyOut(HOOK_ERROR_REASON)
    const argh = process.argv.indexOf('--harness')
    logDenial(HOOK_ERROR_REASON, '', argh >= 0 ? process.argv[argh + 1] : process.env.FACTORY_HARNESS)
  }
}

function handle(input: unknown) {
  const i = input as {
    tool_name?: string
    cwd?: string
    tool_input?: {
      command?: string
      timeout?: number
      run_in_background?: boolean
      file_path?: unknown
      notebook_path?: unknown
      path?: unknown
    }
  }
  const argh = process.argv.indexOf('--harness')
  // claude-factory-ay4w: a hook config with no --harness falls back to the launch env (an AX VM sets FACTORY_HARNESS)
  const harness = argh >= 0 ? process.argv[argh + 1] : process.env.FACTORY_HARNESS
  if (i?.tool_name === 'apply_patch') {
    // claude-factory-qn8a.22: a codex apply_patch carries its paths in the patch text
    const reason = applyPatchReason(
      i.tool_input,
      i.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      undefined,
      process.env.CLAUDE_PROJECT_DIR || i.cwd || process.cwd(),
    )
    if (reason) {
      denyOut(reason)
      logDenial(reason, `apply_patch ${applyPatchPaths(i.tool_input)?.join(' ') ?? ''}`, harness)
    }
    return
  }
  if (i?.tool_name && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(i.tool_name)) {
    const reason = fileWriteReason(
      i.tool_input?.file_path ?? i.tool_input?.notebook_path,
      i.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      undefined,
      process.env.CLAUDE_PROJECT_DIR || i.cwd || process.cwd(),
    )
    if (reason) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      )
      const p = i.tool_input?.file_path ?? i.tool_input?.notebook_path
      logDenial(reason, `${i.tool_name} ${typeof p === 'string' ? p : ''}`, harness)
    }
    return
  }
  if (i?.tool_name === 'Read' || i?.tool_name === 'Grep') {
    // claude-factory-qn8a.19: a Read or Grep of a harness token file or dir
    const cwd = i.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const reason = tokenPathReason(
      i.tool_name,
      i.tool_input,
      cwd,
      process.env.CLAUDE_PROJECT_DIR || i.cwd || process.cwd(),
    )
    if (reason) {
      denyOut(reason)
      const p = i.tool_name === 'Grep' ? i.tool_input?.path : i.tool_input?.file_path
      logDenial(reason, `${i.tool_name} ${typeof p === 'string' ? p : ''}`, harness)
    }
    return
  }
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
  // claude-factory-usqc: the alias and function readers share one read of each snapshot file.
  const snapDir = joinPath(process.env.CLAUDE_CONFIG_DIR || joinPath(homedir(), '.claude'), 'shell-snapshots')
  let snapCache: { texts: string[] | undefined } | undefined
  const snapRead = (d: string) => (snapCache ??= { texts: snapshotTexts(d) }).texts
  const gate: HookGate = {
    station: process.env.FACTORY_FROM,
    factory: process.env.FACTORY_DEF_NAME,
    mergeAuthority: process.argv[process.argv.indexOf('--merge-authority') + 1],
    reviewer:
      process.env.FACTORY_GH_REVIEWER === '1' && REVIEWER_STATIONS.includes(process.env.FACTORY_FROM ?? ''),
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
    // claude-factory-bemr.16: this code takes no -C value and no dir argument. gitReason denies
    // outright instead of asking this code to read a different directory. readFile uses the
    // same i.cwd-then-root fallback rule.
    gitAliases: timeoutMs => gitConfigAliases(i.cwd || root, timeoutMs),
    ghAliases: timeoutMs => ghAliasList(timeoutMs),
    // claude-factory-1zr5: the Bash tool shell sources a Claude Code snapshot of the user's aliases
    shellAliases: () => shellSnapshotAliases(snapDir, snapRead),
    shellFunctions: () => shellSnapshotFunctions(snapDir, snapRead),
    // claude-factory-3f2z.2 / claude-factory-9zd5: the tool call's own cwd, with no fallback to
    // `root` here. `gitReason`'s push-dir fold (`gitChdir`) and `cwdInsideGitDir`'s R4 check both
    // read this field; `gitReason` falls back to `root` itself at its own call site.
    cwd: i.cwd,
    privateHits: text => privateHitLines(text, i.cwd || root),
  }
  const reason = denyReason(i.tool_input?.command ?? '', root, personOnly, gate)
  if (!reason) {
    const timeout = process.env.FACTORY_DEADLINE
      ? clampTimeout(i.tool_input ?? {}, Number(process.env.FACTORY_DEADLINE), Date.now())
      : undefined
    if (timeout)
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: `the station's deadline is ${Math.round(timeout / 1000)} s away: timeout cut to that`,
            updatedInput: { ...i.tool_input, timeout },
          },
        }),
      )
    return
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  logDenial(reason, i.tool_input?.command ?? '', harness)
}

if (import.meta.main) await main()
