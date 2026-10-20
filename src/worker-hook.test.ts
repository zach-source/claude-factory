import { expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALIAS_REASON,
  baseWord,
  baseWordForTest,
  ALIAS_USE_REASON,
  BEADS_ACTOR_REASON,
  COMMENT_REASON,
  DEEP_COMMAND_REASON,
  denyReason,
  COMMENT_CONTINUATION_REASON,
  DOLLAR_QUOTE_REASON,
  DYNAMIC_VERB_REASON,
  ASSIGNMENT_PREFIX_REASON,
  FUNCTION_DEF_REASON,
  ENV_SPLIT_ESCAPE_REASON,
  ENV_SPLIT_VAR_REASON,
  GH_BUILTIN_VERBS,
  GIT_BUILTIN_VERBS,
  type HookGate,
  HEREDOC_REASON,
  LIVE_REASON,
  LONG_COMMAND_REASON,
  MERGE_REASON,
  PUSH_DIR_REASON,
  PUSH_REASON,
  GLOBAL_GIT_CONFIG_REASON,
  READY_REASON,
  REASON,
  SCAN_BUDGET_REASON,
  scanReason,
  SHELL_ALIAS_DEFINE_REASON,
  SHELL_ALIAS_READ_REASON,
  SHELL_ALIAS_REASON,
  SHELL_STDIN_REASON,
  shellSnapshotAliases,
  XARGS_REASON,
} from './worker-hook'

const DENY = [
  'rm -rf foo',
  'rm -r foo',
  'rm -R foo',
  'rm -fr foo',
  'rm -f -r foo',
  'rm --recursive foo',
  '/bin/rm -rf foo',
  '\\rm -rf foo',
  'sudo rm -rf foo',
  'FOO=1 rm -rf foo',
  'git status && rm -rf .scratch/x',
  'cd /x && rm -rf y',
  'cd /x; rm -f y',
  'cd /x && rm y',
  'rm -rf /abs/.scratch/gittest\nls /abs',
  'rm -f a && rm -rf .scratch/c && git status',
  'ls | xargs rm -rf',
  'find . -name x -exec rm -rf {} +',
  // claude-factory-lbn: a bare `-exec` word right after another `-exec` must not stop the find
  // loop from reaching the `-exec rm -rf x` pair that follows.
  'find . -exec -exec rm -rf x',
  "bash -c 'rm -rf x'",
  '(rm -rf x)',
  'timeout 5 rm -rf x',
  // claude-factory-25z.14: a wrapper with flag args (watch has none here, but hides `sh` from
  // realCommand because `watch` is not a known wrapper) must not hide an `rm -rf` inside its
  // quoted script.
  'watch sh -c "rm -rf /tmp/x"',
  // claude-factory-25z.19: bash reads `-x` as its own xtrace option, not as the script. The
  // guard must still find the script after it.
  "bash -c -x 'rm -rf /tmp/x'",
  // claude-factory-25z.23: a backslash right before a real newline is a POSIX line continuation.
  // The shell drops both characters. The text keeps the same two words, "rm" and "-rf", the same
  // as a plain `rm -rf x`.
  'rm \\\n-rf x',
  // claude-factory-25z.23: this one already denied before the fix, by luck: the embedded newline
  // stayed inside the word, but the recursive-flag regex still matched the `r` in it. It must stay
  // denied after the fix too, when the newline is gone and the word is the plain `-rf`.
  'rm -\\\nrf x',
]

// a $variable or glob target, any rm flags (or none): claude-factory-99d.1
const DENY_VAR_OR_GLOB = [
  'rm -i "$X"/*',
  'rm $X',
  'rm "${X}"',
  'rm -- $X',
  'rm -f .scratch/*.md',
  'rm a?.md',
  'rm [ab].md',
  'rm $(ls)',
  "bash -c 'rm $X'",
]

const ALLOW = [
  'git -C .scratch/x status',
  'rm -f .scratch/a.md',
  'rm .scratch/a.md',
  'git rm -r --cached foo',
  'git commit -m "never run rm -rf"',
  "echo 'rm -rf x'",
  'bd create t -d "rm -rf stalls"',
  'cd /x && bun test',
  'ls -rt | grep -r rm src',
  'mkdir -p .scratch/x-2',
  'rm -- -r',
  '',
  // claude-factory-25z.23: a plain backslash-newline joins two words with no `rm` risk in them.
  'echo a\\\nb',
  // claude-factory-25z.23: a backslash-newline inside a quoted argument stays allowed too.
  'git commit -m "a\\\nb"',
  // claude-factory-lbn: the rm after -exec here carries no recursive flag.
  'find . -exec rm -f x \\;',
  // claude-factory-lbn: a mutant that drops the `baseWord(cmd[i + 1]) === 'rm'` check before
  // isRecursiveRm would deny this (isRecursiveRm reads `ls`'s own `-rf` flag as recursive).
  'find . -exec ls -rf x',
]

// stay allowed even though they mention $ or a glob char, because none is an rm operand: claude-factory-99d.1
const ALLOW_VAR_OR_GLOB = ['echo $X', 'ls *.md', "git rm '*.md'"]

// claude-factory-q462: a brace list expands before rm runs, so it can hide a path outside the root.
const DENY_BRACE_RM = [
  'rm {,../}x',
  'rm {x,/etc/passwd}',
  'rm -- {,../}x',
  'rm x{,../../y}',
  'rm -f {,../}x',
  'rm {a,b}',
  'rm .scratch/{a,b}.md',
]
const ALLOW_BRACE_NEIGHBOURS = [
  'rm x',
  'rm ./build/a',
  'mkdir -p {acme,widget}/{src,test}',
  'find . -name x -exec rm -f {} +',
]
const BRACE_OPTS = { headOf: () => 'factory/x' }

test.each(DENY_BRACE_RM)('denyReason denies an rm with a brace target %j', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
  expect(denyReason(cmd, '/root/repo', undefined, BRACE_OPTS)).toBe(REASON)
})

test.each(ALLOW_BRACE_NEIGHBOURS)('denyReason allows %j beside the brace rows', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
  expect(denyReason(cmd, '/root/repo', undefined, BRACE_OPTS)).toBeUndefined()
})

// claude-factory-e39x: zsh expands a leading =cmd word to a command path, so it can hide a path outside the root.
const DENY_EQUALS_RM = ['rm =x', 'rm -f =x', 'rm -- =x', 'rm -rf =x']
const ALLOW_EQUALS_NEIGHBOURS = ['rm x', 'rm x=y', 'rm ./build/a', 'env A=1 rm x']

test.each(DENY_EQUALS_RM)('denyReason denies an rm with a leading = target %j', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
  expect(denyReason(cmd, '/root/repo', undefined, BRACE_OPTS)).toBe(REASON)
})

test.each(ALLOW_EQUALS_NEIGHBOURS)('denyReason allows %j beside the = rows', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
  expect(denyReason(cmd, '/root/repo', undefined, BRACE_OPTS)).toBeUndefined()
})

const ROOT = '/w'

// an rm operand outside ROOT, checked with denyReason(cmd, ROOT): claude-factory-99d.2
const DENY_OUTSIDE_ROOT = ['rm -f /tmp_x', 'rm -f ../x', 'rm ~/x', 'rm /w/../etc/x', 'rm /w']

// an rm operand inside ROOT, checked with denyReason(cmd, ROOT): claude-factory-99d.2
const ALLOW_INSIDE_ROOT = [
  'rm -f .scratch/a.md',
  'rm .scratch/a.md',
  'rm /w/.scratch/a.md',
  'rm -f a.md',
  'rm -- -r',
]

test.each(DENY)('denyReason denies %j', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each(DENY_VAR_OR_GLOB)('denyReason denies an rm with a $variable or glob target %j', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each(DENY_OUTSIDE_ROOT)('denyReason denies an rm outside the root %j', cmd => {
  expect(denyReason(cmd, ROOT)).toBe(REASON)
})

test.each(ALLOW)('denyReason allows %j (fails open to the normal prompt)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

test.each(ALLOW_VAR_OR_GLOB)('denyReason allows %j (no rm operand)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

test.each(ALLOW_INSIDE_ROOT)('denyReason allows an rm inside the root %j', cmd => {
  expect(denyReason(cmd, ROOT)).toBeUndefined()
})

// claude-factory-25z.1: a rig's personOnlyContexts (for example ['acme']) denies a live kubectl/ko/helm
// change there, and denies one with no --context at all (fail closed: current-context is unknown).
const ACME = ['acme']

const DENY_LIVE = [
  'kubectl --context acme apply -f x.yaml',
  'kubectl --context=acme apply -f x.yaml',
  'kubectl -n ax --context acme rollout restart deploy/w',
  'kubectl --context acme scale deploy/w --replicas=3',
  'kubectl --context acme patch deploy/w -p x',
  'kubectl --context acme delete -f x.yaml',
  'ko apply -f config/',
  'kubectl apply -f x', // no --context: fail closed
  'sh -c "kubectl --context acme apply -f x"',
  'env KUBECONFIG=k timeout 30 kubectl --context acme apply -f -',
  'ko resolve -f c | kubectl --context acme apply -f -',
  'helm --kube-context acme upgrade r c',
  // claude-factory-25z.6: a global value flag ahead of the verb must not hide the verb.
  'kubectl -v 6 --context acme apply -f x',
  'kubectl -s https://h --context acme apply -f x',
  'kubectl --kubeconfig k -v 6 apply -f x',
  'helm --kube-token t --kube-context acme upgrade r c',
  'helm --kube-apiserver u upgrade r c',
  // claude-factory-25z.7: --dry-run=none still mutates.
  'kubectl --context acme create -f x --dry-run=none',
  // claude-factory-25z.8: kubectl/ko/helm take the LAST repeated flag, not the first.
  'kubectl --context other --context acme apply -f x',
  'kubectl --context acme apply -f x --dry-run=client --dry-run=none',
  'kubectl --context=acme run x --image=i -- --dry-run=client',
  'helm --kube-context other --kube-context acme upgrade r c',
  'ko apply --context other --context acme -f x',
  // claude-factory-25z.9: a $variable or backtick context value is unknown (fail closed), and a
  // --cluster override in the list denies too, even when --context names a different context.
  'CTX=acme; kubectl --context "$CTX" apply -f x',
  'kubectl --context other --cluster acme apply -f x',
  // claude-factory-25z.10: sh/bash -c detection must find a flag cluster, not only a bare -c.
  'bash -lc "kubectl --context acme apply -f x"',
  'sh -ec "kubectl --context acme apply -f x"',
  // claude-factory-25z.11: kubectl auth reconcile and certificate approve/deny mutate too.
  'kubectl --context acme auth reconcile -f r.yaml',
  'kubectl --context acme certificate approve csr1',
  'kubectl --context acme certificate deny csr1',
  // claude-factory-25z.12: an unstripped wrapper must not hide a kubectl/ko/helm word that follows it.
  'eval "kubectl --context acme apply -f x"',
  'find . -name "*.yaml" -exec kubectl --context acme apply -f {} \\;',
  'ls | xargs -n 1 kubectl --context acme apply -f',
  'timeout -s KILL 60 kubectl --context acme apply -f x',
  'watch kubectl --context acme scale deploy x --replicas 0',
  'nix shell nixpkgs#kubectl -c kubectl --context acme apply -f x',
  'direnv exec . kubectl --context acme apply -f x',
  // claude-factory-25z.13: helm's uninstall aliases del and un mutate too.
  'helm --kube-context acme del r',
  'helm --kube-context acme un r',
  // claude-factory-25z.14: a wrapper with flag args (sudo -u, nice -n, timeout -s) or a wrapper
  // this hook does not know by name (watch, find -exec) can push the sh/bash/eval word past
  // position 0, where the old check alone looked.
  'sudo -u root bash -lc "kubectl --context acme apply -f x"',
  'nice -n 10 eval "kubectl --context acme apply -f x"',
  'watch sh -c "kubectl --context acme apply -f x"',
  'timeout -s KILL 60 eval "kubectl --context acme apply -f x"',
  'find . -name x -exec sh -c "kubectl --context acme apply -f x" \\;',
  // claude-factory-25z.15: brace expansion and a glob in a --context value are not a literal name.
  'kubectl --context ac{m,m}e apply -f x',
  'kubectl --context acme{,} apply -f x',
  'kubectl --context=ac{m,m}e delete pod x',
  // claude-factory-25z.16: kubectl exec and attach mutate a live pod too.
  'kubectl --context acme exec -it pod -- sh -c "reboot"',
  'kubectl --context acme attach pod -c c -i',
  // claude-factory-25z.19: sh, bash and zsh keep reading their own options after the `-c`
  // cluster, up to the first word that is not one of their options. A flag word there is not
  // the script. The guard must still find the real script after it.
  "bash -c -x 'kubectl --context acme apply -f x'",
  "sh -c -e 'kubectl --context acme apply -f x'",
  "zsh -c -x 'kubectl --context acme apply -f x'",
  "sudo -u root bash -lc -x 'kubectl --context acme apply -f x'",
  "bash -c -O extglob 'kubectl --context acme apply -f x'",
  "bash -c -- 'kubectl --context acme apply -f x'",
  "sh -c -- 'kubectl --context acme apply -f x'",
  // claude-factory-25z.23: a backslash right before a real newline is a POSIX line continuation.
  // The shell drops both characters and joins the text around them into one word, so this is the
  // same command as a plain `kubectl --context acme apply -f x`.
  'kub\\\nectl --context acme apply -f x',
  'kubectl \\\n --context acme apply -f x',
  'kubectl --context acme \\\napply -f x',
  'helm \\\n --kube-context acme upgrade r c',
  // the same line continuation inside a double-quoted `bash -c` script.
  'bash -c "kubectl \\\n--context acme apply -f x"',
]

const ALLOW_LIVE = [
  'kubectl --context acme get pods',
  'kubectl --context acme rollout status deploy/w',
  'kubectl --context acme diff -f x',
  'kubectl --context kind-kind apply -f x', // an explicit, non-listed context
  'kubectl --context acme apply --dry-run=server -f x',
  // claude-factory-25z.7: --dry-run=client|server exempts every mutating verb, not only apply.
  'kubectl create secret generic s --dry-run=client -o yaml',
  'kubectl --context acme delete pod x --dry-run=server',
  // claude-factory-25z.11: `auth can-i` reads, it does not mutate.
  'kubectl --context acme auth can-i get pods',
  // claude-factory-25z.8: the LAST --context wins, and it names no listed context here.
  'kubectl --context acme apply -f x --context kind-kind',
  // claude-factory-25z.9: an unlisted --cluster does not deny an unlisted --context.
  'kubectl --context other --cluster kind-kind apply -f x',
  // claude-factory-25z.12: a quoted word that merely contains "kubectl apply" is not a command.
  'git commit -m "kubectl apply"',
  'grep -n kubectl README.md',
]

test.each(DENY_LIVE)('denyReason denies a live-apply command %j with personOnly acme', cmd => {
  expect(denyReason(cmd, undefined, ACME)).toBe(LIVE_REASON)
})

test.each(ALLOW_LIVE)('denyReason allows %j with personOnly acme', cmd => {
  expect(denyReason(cmd, undefined, ACME)).toBeUndefined()
})

test.each([...DENY_LIVE, ...ALLOW_LIVE])(
  'denyReason allows %j (fails open to the normal prompt) when personOnly is empty or absent',
  cmd => {
    expect(denyReason(cmd)).toBeUndefined()
    expect(denyReason(cmd, undefined, [])).toBeUndefined()
  },
)

// claude-factory-25z.17: a stack of `eval` words timed out the 10 s hook. The old anyShellReason
// re-read the same words at each later loop step. Each re-read doubled the cost of the one
// before it. 24 stacked `eval` words took 5 seconds on this machine, pre-fix. After the fix, this
// takes a few milliseconds. The test gives bun a short timeout, so the old code shows red (a
// reported timeout) instead of a slow pass, and the fixed code shows green well inside the
// timeout. This test does not read or assert the elapsed time: `test()`'s own timeout does the
// check.
const STACKED_EVAL = Array(24).fill('eval').join(' ')

test('denyReason denies a live-apply command behind a stack of eval words, fast (claude-factory-25z.17)', () => {
  expect(denyReason(`${STACKED_EVAL}; kubectl --context acme apply -f x`, undefined, ACME)).toBe(LIVE_REASON)
}, 500)

test('denyReason denies an rm -rf behind a stack of eval words, fast (claude-factory-25z.17)', () => {
  expect(denyReason(`${STACKED_EVAL}; rm -rf x`)).toBe(REASON)
}, 500)

// claude-factory-epz: anyShellReason's eval recursion has no depth limit.
// A command has n stacked eval words. Then it has an `rm -rf`.
// For n=1000, the time used is 185 ms.
// For n=2000, the time used is 679 ms.
// For n=4000, the time used is 4008 ms.
//
// This command is over 8192 characters, so denyReason denies it with LONG_COMMAND_REASON on
// every rig (claude-factory-dts). scanReason runs the same scan with no length cap, so it still
// proves the depth limit fix directly.
//
// A high load can make more time necessary for this check.
// The time necessary can then be more than the 10 s time limit of the PreToolUse hook.
// The hook then fails open. The command runs.
// This is the problem that this change corrects.
//
// A depth limit, MAX_SHELL_DEPTH = 32, corrects this problem.
// The hook denies a command that has more than 32 levels of eval.
// It will fail closed.
// This test does not read or measure the time used. `test()`'s own time limit does that check.
// The limit is 2000 ms, not 500 ms: the scan takes about 380 ms on a laptop and 611 ms was seen
// on a CI runner.
const DEEP_RM_N = 4000
const DEEP_RM_COMMAND = 'eval '.repeat(DEEP_RM_N) + 'rm '.repeat(DEEP_RM_N) + '; rm -rf x'

test('scanReason denies a 4000-level stacked eval rm -rf form, fast, no personOnly (claude-factory-epz)', () => {
  expect(scanReason(DEEP_RM_COMMAND)).toBe(DEEP_COMMAND_REASON)
}, 2000)

// claude-factory-dts: the same over-8192-character command denies with LONG_COMMAND_REASON
// through denyReason, on every rig, with no personOnly set.
test('denyReason denies the same 4000-level stacked eval rm -rf form with LONG_COMMAND_REASON (claude-factory-dts)', () => {
  expect(denyReason(DEEP_RM_COMMAND)).toBe(LONG_COMMAND_REASON)
})

test('denyReason denies a command nesting 33 eval levels (claude-factory-epz)', () => {
  expect(denyReason('eval '.repeat(33) + 'ls')).toBe(DEEP_COMMAND_REASON)
})

test('denyReason allows a command nesting only 32 eval levels (claude-factory-epz)', () => {
  expect(denyReason('eval '.repeat(32) + 'ls')).toBeUndefined()
})

test('denyReason denies a sh -c script that itself nests 32 eval levels, the sh -c wrapper counting as a level (claude-factory-epz)', () => {
  expect(denyReason(`sh -c "${'eval '.repeat(32)}ls"`)).toBe(DEEP_COMMAND_REASON)
})

test('denyReason allows a sh -c script that nests only 31 eval levels (claude-factory-epz)', () => {
  expect(denyReason(`sh -c "${'eval '.repeat(31)}ls"`)).toBeUndefined()
})

test('denyReason denies a 33-level stacked eval command with personOnly set too (claude-factory-epz)', () => {
  expect(denyReason('eval '.repeat(33) + 'ls', undefined, ACME)).toBe(DEEP_COMMAND_REASON)
})

// claude-factory-25z.20: the .17 fix made the scan linear. But a command of n eval words, then n
// bare kubectl words, then a real apply still costs about n^3. A command built to be about 26 KB
// can push that scan past the 10 s PreToolUse hook timeout. A timed-out hook runs the command
// unchecked. So denyReason denies a command longer than 8192 characters outright, before any
// scan.
//
// claude-factory-dts: this cap now applies on every rig, not only one with a person-only kube
// context. The old behavior (today's test name) was the bug this bead fixes, so this test now
// asserts the new, approved behavior: the cap denies with no personOnly set, the same as with
// personOnly set.
const LONG_COMMAND_8192 = 'x'.repeat(8192)
const LONG_COMMAND_8193 = 'x'.repeat(8193)

test('denyReason denies a command over 8192 characters outright when personOnly is set (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8193, undefined, ACME)).toBe(LONG_COMMAND_REASON)
})

test('denyReason denies a command over 8192 characters outright on every rig, personOnly empty or absent (claude-factory-dts)', () => {
  expect(denyReason(LONG_COMMAND_8193)).toBe(LONG_COMMAND_REASON)
  expect(denyReason(LONG_COMMAND_8193, undefined, [])).toBe(LONG_COMMAND_REASON)
})

test('denyReason gives a normal verdict for a command at exactly 8192 characters, personOnly set (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8192, undefined, ACME)).toBeUndefined()
})

// claude-factory-dts: the cap applies on every rig, so a command at exactly 8192 characters still
// gives a normal verdict with no personOnly set at all.
test('denyReason gives a normal verdict for a command at exactly 8192 characters, personOnly absent (claude-factory-dts)', () => {
  expect(denyReason(LONG_COMMAND_8192)).toBeUndefined()
})

// claude-factory-1by: anyShellReason calls shCFlagIndex(words.slice(j)) for each sh/bash/zsh/dash
// word. words.slice(j) costs O(n-j).
//
// The scan it feeds also costs O(n-j). On a miss, j moves by only 1.
//
// So a run of n such words with no `-c` cluster costs O(n^2).
//
// Each command below is over 8192 characters. denyReason now denies each one with
// LONG_COMMAND_REASON on every rig (claude-factory-dts). scanReason runs the same scan with no
// length cap, so it still proves the linear-time fix directly.
//
// Measured on the pre-fix code, load 12-30:
//
// 'sh '.repeat(40000) + '; rm -rf x' took 13.6 s.
//
// 'bash -x '.repeat(40000) + '; rm -rf x' took 36.3 s.
//
// 'sh -- '.repeat(40000) + '; rm -rf x' took 875 ms. The slice alone is quadratic.
//
// The inner scan stops at the first word there, because '--' matches right away.
//
// 'eval ' + 'sh '.repeat(40000) + '; rm -rf x' took 9.5 s.
//
// The eval recursion reaches the same sh-word loop at depth 1, at the same cost.
//
// Each time is far past the 500 ms limit this test sets below.
//
// The PreToolUse hook has a 10 s limit (src/cli.ts). Past that limit, the hook fails open.
//
// The command's `rm -rf` then runs.
//
// This test does not read or measure the time used. `test()`'s own time limit does that check.
const SCAN_N = 40000

test('scanReason denies a 40000-word sh scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(scanReason('sh '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

test('scanReason denies a 40000-word bash -x scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(scanReason('bash -x '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

test('scanReason denies a 40000-word sh -- scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(scanReason('sh -- '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

test('scanReason denies a 40000-word dynamic-shell-word scan, fast (claude-factory-sft4)', () => {
  expect(scanReason('echo ' + '$S '.repeat(SCAN_N) + '-c ' + '-x '.repeat(SCAN_N) + '; rm -rf x')).toBe(
    REASON,
  )
}, 500)

test('scanReason denies an eval-wrapped 40000-word sh scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(scanReason('eval ' + 'sh '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

// claude-factory-dts: one of the commands above, run through denyReason instead, denies with
// LONG_COMMAND_REASON: it is over 8192 characters, and the cap applies before any scan.
test('denyReason denies the same 40000-word sh scan with LONG_COMMAND_REASON (claude-factory-dts)', () => {
  expect(denyReason('sh '.repeat(SCAN_N) + '; rm -rf x')).toBe(LONG_COMMAND_REASON)
})

// claude-factory-1by: shapes the fix must keep denying or allowing exactly as before. A fix that
// jumps `j` blindly to the end of a segment on a cluster miss would wrongly allow the first two:
// the real `-c` script sits past a plain word (`eval`) or past a literal `--`.
test('denyReason still denies `sh eval rm -rf x` (claude-factory-1by)', () => {
  expect(denyReason('sh eval rm -rf x')).toBe(REASON)
})

test('denyReason still denies `sh foo -- bash -c "rm -rf x"` (claude-factory-1by)', () => {
  expect(denyReason('sh foo -- bash -c "rm -rf x"')).toBe(REASON)
})

test('denyReason still denies `sh -x -lc "rm -rf x"` (claude-factory-1by)', () => {
  expect(denyReason('sh -x -lc "rm -rf x"')).toBe(REASON)
})

// claude-factory-dts: this command is also over 8192 characters, so scanReason (no length cap)
// keeps the old allow verdict, and denyReason now denies it with LONG_COMMAND_REASON.
test('scanReason still allows a 40000-word sh scan whose last word is a `-c` flag with no script (claude-factory-1by)', () => {
  expect(scanReason('sh '.repeat(SCAN_N) + '-c ls')).toBeUndefined()
})

test('denyReason denies the same no-script sh scan with LONG_COMMAND_REASON (claude-factory-dts)', () => {
  expect(denyReason('sh '.repeat(SCAN_N) + '-c ls')).toBe(LONG_COMMAND_REASON)
})

// claude-factory-8pc.24: bd fills a bead's created_by from BEADS_ACTOR, which the flood guard's
// sweepFiler trusts. A worker that sets, clears or re-exports BEADS_ACTOR escapes the cap.
const BEADS_ACTOR_DENY = [
  'BEADS_ACTOR=person bd create "x" -l factory',
  'env BEADS_ACTOR=person bd create "x" -l factory',
  'export BEADS_ACTOR=person',
  'export BEADS_ACTOR',
  'unset BEADS_ACTOR',
  'declare -x BEADS_ACTOR=person',
  'bd create "x"; BEADS_ACTOR=person bd create "y" -l factory',
  "bash -c 'BEADS_ACTOR=person bd create x -l factory'",
]

test.each(BEADS_ACTOR_DENY)('denyReason denies %s (claude-factory-8pc.24)', cmd => {
  expect(denyReason(cmd)).toBe(BEADS_ACTOR_REASON)
})

test('denyReason allows a plain bd command and an unrelated VAR=val assignment (claude-factory-8pc.24)', () => {
  expect(denyReason('bd create "x" -l factory')).toBeUndefined()
  expect(denyReason('FOO=1 bd list --all')).toBeUndefined()
  // a word that only contains the text BEADS_ACTOR, not an assignment or export of it, is not denied
  expect(denyReason('echo BEADS_ACTOR_LOG=1')).toBeUndefined()
})

// claude-factory-8pc.27: each line clears BEADS_ACTOR before bd runs. bd then uses its own
// default actor. sweepFiler (src/sweeps.ts) never matches the filed bead. The round-7 security
// review found 3 of these forms let through by the claude-factory-8pc.24 fix.
const BEADS_ACTOR_CLEAR_DENY = [
  'env -u BEADS_ACTOR bd create "x" -l factory',
  'env --unset=BEADS_ACTOR bd create "x" -l factory',
  'env --unset BEADS_ACTOR bd create "x" -l factory',
  'env -i PATH=/usr/bin bd create "x" -l factory',
  'env --ignore-environment PATH=/usr/bin bd create "x" -l factory',
  'export -n BEADS_ACTOR; bd create "x" -l factory',
  'declare -n BEADS_ACTOR',
  // claude-factory-igj: these new lines close 4 gaps in the old scan.
  // Gap 1: one word can hold an option and the name BEADS_ACTOR together.
  'env -uBEADS_ACTOR bd create "x" -l factory',
  'env -0u BEADS_ACTOR bd create "x" -l factory',
  'env --uns=BEADS_ACTOR bd create "x" -l factory',
  'env --uns BEADS_ACTOR bd create "x" -l factory',
  // Gap 2: a lone dash works the same as -i.
  'env - bd create "x" -l factory',
  // Gap 3: a short word or a shortened long word can also mean -i.
  'env -iu FOO bd create "x" -l factory',
  'env -vi bd create "x" -l factory',
  'env --ign bd create "x" -l factory',
  'env --ignore-env bd create "x" -l factory',
  // Gap 4: the scan must not stop at an option's own value word.
  'env -C /tmp -u BEADS_ACTOR bd create "x" -l factory',
  'env -P /usr/bin -i bd create "x" -l factory',
  'env -a foo -i bd create "x" -l factory',
  // claude-factory-igj.4 (PR #109 review round 1): Gap 5. A value flag whose own value is the
  // word `bd` must not stop the scan before a later `-u BEADS_ACTOR` or `-i`.
  'env -u bd -u BEADS_ACTOR bd create "x" -l factory',
  'env -C bd -u BEADS_ACTOR bd create "x" -l factory',
  'env -C ./bd -i bd create "x" -l factory',
  'env -a bd -i bd create "x" -l factory',
  'env -P /x/bd -i bd create "x" -l factory',
  'env --chdir bd -i bd create "x" -l factory',
  'env --unset bd -i bd create "x" -l factory',
  'env -u bd -i bd create "x" -l factory',
  'env -S"-u bd -i" bd create "x" -l factory',
]

test.each(BEADS_ACTOR_CLEAR_DENY)('denyReason denies %s (claude-factory-8pc.27)', cmd => {
  expect(denyReason(cmd)).toBe(BEADS_ACTOR_REASON)
})

test('denyReason allows env -i on a command that is not bd (claude-factory-8pc.27)', () => {
  // env -i clears BEADS_ACTOR too, but it is this gap only when the cleared command is bd itself
  expect(denyReason('env -i PATH=/usr/bin ls')).toBeUndefined()
})

test('denyReason allows env -u on a variable other than BEADS_ACTOR (claude-factory-8pc.27)', () => {
  expect(denyReason('env -u OTHER_VAR bd create "x" -l factory')).toBeUndefined()
})

// claude-factory-igj: the wider scan must still allow these lines.
// It must not deny an option's own value word.
// It must not deny a bd flag or argument that only holds the text BEADS_ACTOR.
// It must not deny a wrapper that runs git, not bd.
const BEADS_ACTOR_CLEAR_ALLOW = [
  'env -i ls',
  'env -i PATH=/usr/bin ls',
  'bd list',
  'bd create "x" -l factory',
  'env -u OTHER_VAR bd create "x" -l factory',
  'echo BEADS_ACTOR_LOG=1',
  'env GIT_EDITOR=true git commit -m "fix BEADS_ACTOR guard"',
  'env FOO=1 bd list --include-infra',
  'env FOO=1 bd create "x" -d "BEADS_ACTOR note"',
  'env -C /tmp bd list',
  'env -C/opt/bin bd list',
  // claude-factory-igj.5 (PR #109 review round 1): the wider scan must not read past env's own
  // real command into that command's own flags and arguments.
  'env LC_ALL=C grep -rn BEADS_ACTOR src',
  'env FOO=1 grep -i x bd',
]

test.each(BEADS_ACTOR_CLEAR_ALLOW)('denyReason allows %s (claude-factory-igj)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-igj.6: a sh/bash -c script, or an eval word, can hide a bd word inside it.
// The check must find that bd word. This is true even under a clear-all env -i.
//
// claude-factory-igj.8: a wrapper word between env -i and the shell word must not hide the
// shell -c script. The old scan checked only the one word right after env's own options. Each
// line below adds a wrapper word there (env, nice, nohup, timeout 5, sudo, command, exec, time,
// or xargs), which hid the sh -c script from the old scan.
const BEADS_ACTOR_SHELL_SCRIPT_DENY = [
  'env -i sh -c "bd create x"',
  'env -i bash -c "bd create x -l factory"',
  'env -i eval "bd create x"',
  'env -i env sh -c "bd create x"',
  'env -i nice sh -c "bd create x"',
  'env -i nohup sh -c "bd create x"',
  'env -i timeout 5 sh -c "bd create x"',
  'env -i sudo sh -c "bd create x"',
  'env -i command sh -c "bd create x"',
  'env -i exec sh -c "bd create x"',
  'env -i time sh -c "bd create x"',
  'env -i xargs sh -c "bd create x"',
]

test.each(BEADS_ACTOR_SHELL_SCRIPT_DENY)('denyReason denies %s (claude-factory-igj.6)', cmd => {
  expect(denyReason(cmd)).toBe(BEADS_ACTOR_REASON)
})

// claude-factory-igj AC5: env -S splits a string into words at run time.
// Each line below hides a clear-all flag or the name BEADS_ACTOR inside that string.
const BEADS_ACTOR_SPLIT_STRING_DENY = [
  "env -S'-i bd create x' -l factory",
  'env -S\'-i\' bd create "x" -l factory',
  "env -S '-u BEADS_ACTOR bd create x' -l factory",
  // claude-factory-igj.10 (PR #109 review round 3): a short cluster can hold other option
  // letters before S (`-iS...`). The old scan dropped the whole -S word, so a clear-all `i`
  // right before S never ran. Real env clears the environment for each line below.
  "env -iS'bd create x'",
  "env -iS 'bd create x'",
  "env -0iS'bd create x'",
  'env -iS\'sh -c "bd create x"\'',
]

test.each(BEADS_ACTOR_SPLIT_STRING_DENY)('denyReason denies %s (claude-factory-igj)', cmd => {
  expect(denyReason(cmd)).toBe(BEADS_ACTOR_REASON)
})

// claude-factory-lbn: denyAt's find branch loops i over cmd. At each -exec/-execdir word, it
// runs cmd.slice(i + 1), then reads rest[0]. A slice costs O(n - i). A run of n -exec words makes
// n such slices, so the find branch costs O(n^2).
//
// Each command below is over 8192 characters. denyReason now denies each one with
// LONG_COMMAND_REASON on every rig (claude-factory-dts). scanReason runs the same scan with no
// length cap, so it still proves the linear-time fix directly.
//
// Measured on the pre-fix code, load 13.81:
//
// denyReason('find . ' + '-exec '.repeat(20000)) took 75.5 ms.
//
// denyReason('find . ' + '-exec '.repeat(40000)) took 233.0 ms (3.09x).
//
// denyReason('find . ' + '-exec '.repeat(80000)) took 1445.0 ms (6.20x). Each time n doubles,
// the ratio nears 4x. This ratio shows an O(n^2) scan.
//
// denyReason('find . ' + '-exec '.repeat(200000) + '; rm -rf x') took 11451.9 ms. This time is
// past the 10 s PreToolUse hook timeout (src/cli.ts). When the time passes that limit, the hook
// fails open. The command's `rm -rf` then runs unchecked.
//
// This test does not read or measure the time used. `test()`'s own time limit does that check.
//
// The limit is FIND_MS, not 500 ms: the linear scan takes about 280 ms on a laptop and 280 to 560 ms
// on a shared CI runner, so 500 ms failed CI at random. The O(n^2) scan above takes about 11 s, so
// 2000 ms still fails it by more than 5x.
const FIND_N = 200000
const FIND_MS = 2000

test(
  'scanReason denies a 200000-word find -exec scan, fast, no personOnly (claude-factory-lbn)',
  () => {
    expect(scanReason('find . ' + '-exec '.repeat(FIND_N) + '; rm -rf x')).toBe(REASON)
  },
  FIND_MS,
)

// claude-factory-dts: the same over-8192-character command denies with LONG_COMMAND_REASON
// through denyReason, on every rig.
test('denyReason denies the same 200000-word find -exec scan with LONG_COMMAND_REASON (claude-factory-dts)', () => {
  expect(denyReason('find . ' + '-exec '.repeat(FIND_N) + '; rm -rf x')).toBe(LONG_COMMAND_REASON)
})

// claude-factory-lbn: this shape still slices once per -exec word. It does so even when the fix
// checks baseWord(cmd[i + 1]) === 'rm' before the slice (the bead's own first proposal).
// The slice itself costs O(n), not the check before it. Each rm here carries no recursive flag.
// So the command must stay allowed.
test(
  'scanReason allows a 200000-word find -exec rm scan, fast, no recursive flag (claude-factory-lbn)',
  () => {
    expect(scanReason('find . ' + '-exec rm '.repeat(FIND_N))).toBeUndefined()
  },
  FIND_MS,
)

test(
  'scanReason denies a 200000-word find -exec rm scan with a recursive rm at the end (claude-factory-lbn)',
  () => {
    expect(scanReason('find . ' + '-exec rm '.repeat(FIND_N) + '-exec rm -rf x')).toBe(REASON)
  },
  FIND_MS,
)

test(
  'scanReason denies a 200000-word find -execdir scan with a recursive rm at the end (claude-factory-lbn)',
  () => {
    expect(scanReason('find . ' + '-execdir '.repeat(FIND_N) + '-execdir rm -rf x \\;')).toBe(REASON)
  },
  FIND_MS,
)

// claude-factory-j471: a wrapper word, an -ok/-okdir word or a redirect word in a find exec slot
// must not hide a recursive rm.
const J471_DENY = [
  'find / -exec sudo rm -rf {} \\;',
  'find / -exec env rm -rf {} \\;',
  'find . -exec nice rm -rf {} \\;',
  'find . -exec nohup rm -rf {} \\;',
  'find . -exec command rm -rf {} \\;',
  'find . -exec timeout 5 rm -rf {} \\;',
  'find . -exec sudo -u root rm -rf {} \\;',
  'find . -exec /usr/bin/time -l rm -rf {} \\;',
  'sudo find / -exec env rm -rf {} \\;',
  'find . -execdir env rm -r {} +',
  'find / -ok rm -rf {} \\;',
  'find / -okdir rm -rf {} \\;',
  'find / -ok sudo rm -rf {} \\;',
  'find . -name x -okdir env rm -r {} +',
  'find / -exec >f sudo rm -rf {} \\;',
  'find / -exec >f rm -rf {} \\;',
  '>f find / -ok rm -rf {} \\;',
  '>f find / -exec rm -rf {} \\;',
  'find / -exec 2>&1 env rm -rf {} \\;',
  '/usr/bin/time -l find / -exec >f rm -rf {} \\;',
  '/usr/bin/time -l find / -ok >f sudo rm -rf {} \\;',
  '/usr/bin/time -h find / -exec 2>&1 rm -rf {} \\;',
  'nice --adjustment=5 find / -exec >f rm -rf {} \\;',
  'env --ignore-environment find / -exec >f rm -rf {} \\;',
  'xargs -n 1 find / -exec >f rm -rf {} \\;',
]
for (const cmd of J471_DENY) {
  test(`denyReason denies ${cmd} (claude-factory-j471)`, () => {
    expect(denyReason(cmd, '/Users/acme/widget')).toBe(REASON)
  })
}

const J471_ALLOW = [
  'find / -exec ls {} \\;',
  'find . -exec env FOO=1 cat {} \\;',
  'find . -exec rm {} +',
  'find . -exec env rm {} +',
  'find . -exec sudo rm -f {} +',
  'find . -ok ls {} \\;',
  'find . -exec git rm -r --cached {} +',
  'echo x > out.txt',
  'find . -name rm -exec ls {} \\;',
]
for (const cmd of J471_ALLOW) {
  test(`denyReason allows ${cmd} (claude-factory-j471)`, () => {
    expect(denyReason(cmd, '/Users/acme/widget')).toBeUndefined()
  })
}

test(
  'scanReason allows a 200000-word find -exec env scan, fast (claude-factory-j471)',
  () => {
    expect(scanReason('find . ' + '-exec env '.repeat(FIND_N))).toBeUndefined()
  },
  FIND_MS,
)

test(
  'scanReason denies a 200000-word find -ok env scan with rm -rf at the end (claude-factory-j471)',
  () => {
    expect(scanReason('find . ' + '-ok env '.repeat(FIND_N) + '-ok env rm -rf x')).toBe(REASON)
  },
  FIND_MS,
)

const HOOK = join(import.meta.dir, 'worker-hook.ts')

// claude-factory-3f2z.2: `cwd` sets the filesystem cwd of the spawned hook process. It does not
// set `tool_input.cwd`. That value is inside `stdin`.
//
// `cwd` stands in for the cwd of the real Claude Code host process. A prior Bash call runs
// `cd`. This can leave the host process on a second repo. That repo can be different from the
// worktree root and from `tool_input.cwd`.
async function run(
  stdin: string,
  env?: Record<string, string | undefined>,
  argv: string[] = [],
  cwd?: string,
) {
  const p = Bun.spawn(['bun', HOOK, ...argv], {
    stdin: new Response(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    cwd,
  })
  const out = await new Response(p.stdout).text()
  const code = await p.exited
  return { out, code }
}

test('run as `bun src/worker-hook.ts`, a deny command on stdin prints one PreToolUse deny object and exits 0', async () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf foo' } })
  const { out, code } = await run(input)
  expect(code).toBe(0)
  expect(JSON.parse(out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  })
}, 10_000)

test('run as `bun src/worker-hook.ts --person-only-contexts acme`, a live-apply command prints one deny object; without the argv it prints nothing (claude-factory-25z.1)', async () => {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'kubectl --context acme apply -f x' },
  })
  const withArgv = await run(input, undefined, ['--person-only-contexts', 'acme'])
  expect(withArgv.code).toBe(0)
  expect(JSON.parse(withArgv.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: LIVE_REASON,
    },
  })
  const withoutArgv = await run(input)
  expect(withoutArgv).toEqual({ out: '', code: 0 })
}, 10_000)

test('run as `bun src/worker-hook.ts`, an allow command, a non-Bash tool or bad JSON on stdin prints nothing and exits 0', async () => {
  const allow = await run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -f a.md' } }))
  expect(allow).toEqual({ out: '', code: 0 })
  const other = await run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }))
  expect(other).toEqual({ out: '', code: 0 })
  const bad = await run('not json')
  expect(bad).toEqual({ out: '', code: 0 })
}, 10_000)

test('with no CLAUDE_PROJECT_DIR, main() takes root from input.cwd: claude-factory-99d.2', async () => {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  const deny = await run(
    JSON.stringify({ tool_name: 'Bash', cwd: '/w', tool_input: { command: 'rm -f /tmp_x' } }),
    env,
  )
  expect(deny.code).toBe(0)
  expect(JSON.parse(deny.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  })
  const allow = await run(
    JSON.stringify({ tool_name: 'Bash', cwd: '/w', tool_input: { command: 'rm -f /w/a.md' } }),
    env,
  )
  expect(allow).toEqual({ out: '', code: 0 })
}, 10_000)

// claude-factory-zl5.1: a worker never merges a pull request. It never turns on auto-merge.
// Only a person merges, by owner decision. ax-aw1 found two PRs merged before their review ran.
const DENY_MERGE = [
  'gh pr merge 5',
  'gh pr merge --auto --squash 5',
  'gh pr merge --admin 5',
  'gh pr merge -R o/r 5',
  'sudo gh pr merge 5',
  'env FOO=1 gh pr merge 5',
  'timeout 5 gh pr merge 5',
  'watch gh pr merge 5',
  "bash -lc 'gh pr merge 5'",
  "eval 'gh pr merge 5'",
  'gh\\\n pr merge 5',
  'gh pr \\\nmerge 5',
  'gh repo sync',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api -XPUT repos/o/r/pulls/5/merge', // claude-factory-zl5.7: an attached short flag, curl style
  'gh api repos/o/r/merges -f base=main',
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
  "gh api graphql -F query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId } }'",
  // claude-factory-zl5.6: --raw-field=/--field= (attached) and -f<x>=/-F<x>= (attached, no space)
  "gh api graphql --raw-field=query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  "gh api graphql --field=query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
  "gh api graphql -fquery='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  "gh api graphql -Fquery='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
]

test.each(DENY_MERGE)('denyReason denies %j', cmd => {
  expect(denyReason(cmd)).toBe(MERGE_REASON)
})

const ALLOW_MERGE = [
  'gh pr view 5',
  'gh pr checks 5',
  'gh pr create --title merge',
  'gh pr diff 5',
  'gh pr comment 5 --body merge',
  'gh api repos/o/r/pulls/5/merge', // GET: read-only
  "gh api graphql -f query='query { viewer { login } }'",
  'git commit -m "deny enablePullRequestAutoMerge"', // text outside a gh api segment
]

test.each(ALLOW_MERGE)('denyReason allows %j', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-zl5.1: a query=@file or --input file can name a file this hook cannot read.
// This hook then does not know that file's content, so the check fails closed and denies the call.
//
// When the hook's gate can read the file, it scans the real content instead.
test('denyReason resolves a graphql query=@file through gate.readFile, and fails closed when it cannot read it', () => {
  const safe = { readFile: () => 'query { viewer { login } }' }
  const mutating = {
    readFile: () => 'mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }',
  }
  expect(denyReason('gh api graphql -f query=@m.graphql', undefined, undefined, safe)).toBeUndefined()
  expect(denyReason('gh api graphql -f query=@m.graphql', undefined, undefined, mutating)).toBe(MERGE_REASON)
  // no gate.readFile at all: the file's content is unknown, so this fails closed
  expect(denyReason('gh api graphql -f query=@m.graphql')).toBe(MERGE_REASON)
  expect(denyReason('gh api graphql --input body.json')).toBe(MERGE_REASON)
})

// claude-factory-zl5.24: `--input` sends gh api the whole JSON request body for the GraphQL
// call, not raw query text. GitHub's own JSON parser decodes a `\u` escape inside the body's
// `query` string before it runs it, so this guard must parse the body the same way and read its
// decoded `query` string, not scan the raw file bytes.
test('denyReason parses a graphql --input body as JSON and reads its own query string (claude-factory-zl5.24)', () => {
  const safeBody = { readFile: () => JSON.stringify({ query: 'query { viewer { login } }' }) }
  const mutatingBody = {
    readFile: () =>
      JSON.stringify({ query: 'mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }' }),
  }
  // the same mutation name, spelled with a JSON backslash-u escape. Only JSON.parse decodes it
  // to the plain `mergePullRequest` text.
  const escapedMutatingBody = {
    readFile: () => '{"query": "mutation { merge\\u0050ullRequest(input: {}) { clientMutationId } }"}',
  }
  // not valid JSON: the body's real query text is unknown, so this fails closed
  const notJsonBody = {
    readFile: () => 'mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }',
  }
  expect(denyReason('gh api graphql --input body.json', undefined, undefined, safeBody)).toBeUndefined()
  expect(denyReason('gh api graphql --input body.json', undefined, undefined, mutatingBody)).toBe(
    MERGE_REASON,
  )
  expect(denyReason('gh api graphql --input body.json', undefined, undefined, escapedMutatingBody)).toBe(
    MERGE_REASON,
  )
  expect(denyReason('gh api graphql --input body.json', undefined, undefined, notJsonBody)).toBe(MERGE_REASON)
})

// claude-factory-zl5.1: a stack of eval words must not hide a merge command, and must not time out
// the 10 s hook (claude-factory-25z.17's bound).
const STACKED_EVAL_MERGE = Array(24).fill('eval').join(' ')
test('denyReason denies a merge command behind a stack of eval words, fast', () => {
  expect(denyReason(`${STACKED_EVAL_MERGE}; gh pr merge 5`)).toBe(MERGE_REASON)
}, 500)

// claude-factory-zl5.2: only the release station marks a pull request ready for review. implement,
// review, verify and no station at all (undefined) all deny it the same way.
const NON_RELEASE_STATIONS = [undefined, 'implement', 'review', 'verify']
const READY_COMMANDS = [
  'gh pr ready 5',
  'gh pr ready',
  'gh api graphql -f query=\'mutation { markPullRequestReadyForReview(input: {id: "x"}) { clientMutationId } }\'',
  // claude-factory-zl5.6: the same attached-field gap applies to markPullRequestReadyForReview
  'gh api graphql -fquery=\'mutation { markPullRequestReadyForReview(input: {id: "x"}) { clientMutationId } }\'',
  'sudo gh pr ready 5',
  "bash -lc 'gh pr ready 5'",
]

for (const station of NON_RELEASE_STATIONS) {
  test.each(READY_COMMANDS)(`denyReason denies %j at station ${station}`, cmd => {
    expect(denyReason(cmd, undefined, undefined, { station })).toBe(READY_REASON)
  })
}

test.each(READY_COMMANDS)('denyReason allows %j at the release station', cmd => {
  expect(denyReason(cmd, undefined, undefined, { station: 'release' })).toBeUndefined()
})

// claude-factory-zl5.2: gh pr ready --undo (back to draft) is always allowed, at every station.
const UNDO_COMMANDS = ['gh pr ready --undo', 'gh pr ready 5 --undo', 'gh pr ready --undo 5']
for (const station of [...NON_RELEASE_STATIONS, 'release']) {
  test.each(UNDO_COMMANDS)(`denyReason allows %j at station ${station}`, cmd => {
    expect(denyReason(cmd, undefined, undefined, { station })).toBeUndefined()
  })
}

// claude-factory-zl5.2: main() reads the running station from FACTORY_FROM and carries it into the
// gate, so `gh pr ready` denies with no FACTORY_FROM set and allows at the release station.
test('run as `bun src/worker-hook.ts`, gh pr ready denies with FACTORY_FROM unset and allows at release', async () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr ready 5' } })
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.FACTORY_FROM
  const denied = await run(input, env)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: READY_REASON,
    },
  })
  const allowed = await run(input, { ...env, FACTORY_FROM: 'release' })
  expect(allowed).toEqual({ out: '', code: 0 })
}, 10_000)

// claude-factory-zl5.3: a worker never pushes straight to a protected branch (main, master, the
// branch origin/HEAD names, or one the rig names with --protected-branch).
const DENY_PUSH = [
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin x:refs/heads/main',
  'git push origin +main',
  'git push -f origin main',
  'git push origin :main',
  'git push origin main:',
  'git push origin --delete main',
  'git push --all origin',
  'git push --branches origin',
  'git push --mirror origin',
  'git push --prune origin',
  'git -C dir push origin main',
  'git push origin master',
  'sudo git push origin main',
  'env FOO=1 git push origin main',
  'timeout 5 git push origin main',
  'watch git push origin main',
  "bash -lc 'git push origin main'",
  "eval 'git push origin main'",
  'git\\\n push origin main',
  'git push\\\n origin main',
]

test.each(DENY_PUSH)('denyReason denies %j', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

// claude-factory-zl5.3: a bare `git push` or `git push origin HEAD` pushes the current branch, so
// it denies when that branch is a protected one, and a $variable/backtick/glob/brace refspec is
// unresolved here, so it fails closed (denies).
const DENY_PUSH_CURRENT_BRANCH = ['git push', 'git push origin HEAD', 'git push -u origin HEAD']

test.each(DENY_PUSH_CURRENT_BRANCH)('denyReason denies %j when the current branch is main', cmd => {
  expect(denyReason(cmd, undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
})

const DENY_PUSH_UNSAFE_REFSPEC = [
  'git push origin $BRANCH',
  "git push origin '`x`'",
  "git push origin 'feat/*'",
  "git push origin '{a,b}'",
]

test.each(DENY_PUSH_UNSAFE_REFSPEC)(
  'denyReason denies a push with an unresolved refspec %j (fail closed)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

test('denyReason denies a push to a branch the rig names with --protected-branch', () => {
  expect(
    denyReason('git push origin acme/deploy', undefined, undefined, {
      protectedBranches: ['acme/deploy'],
    }),
  ).toBe(PUSH_REASON)
})

test('denyReason denies a push to the branch origin/HEAD names, even off main and master', () => {
  expect(denyReason('git push origin develop', undefined, undefined, { originHead: () => 'develop' })).toBe(
    PUSH_REASON,
  )
})

// claude-factory-zl5.3: a stack of eval words must not hide a push command, and must not time out
// the 10 s hook (claude-factory-25z.17's bound).
const STACKED_EVAL_PUSH = Array(24).fill('eval').join(' ')
test('denyReason denies a push command behind a stack of eval words, fast', () => {
  expect(denyReason(`${STACKED_EVAL_PUSH}; git push origin main`)).toBe(PUSH_REASON)
}, 500)

const ALLOW_PUSH = [
  'git push origin factory/x',
  'git push origin v1.2.3',
  'git push origin --tags',
  'git push -n origin main',
  'git push --dry-run origin main',
]

test.each(ALLOW_PUSH)('denyReason allows %j (current branch unknown here)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-ctae.1: git parse-options accepts a unique prefix of a long flag name. Each
// row below is an abbreviation of a `PUSH_BROAD_FLAGS` member. Real git 2.54 confirmed that
// `git push --mirr <bare>` pushes every ref, `main` included, the same reach as `--mirror`.
const DENY_PUSH_BROAD_FLAG_ABBREVIATION = [
  'git push --mirr o',
  'git push --mi o',
  'git push --al o',
  'git push --branc o',
  'git push --prun o',
]

test.each(DENY_PUSH_BROAD_FLAG_ABBREVIATION)(
  'denyReason denies %j (claude-factory-ctae.1, an abbreviated broad push flag)',
  cmd => {
    const gate = { headOf: () => 'factory/x', originHead: () => 'main' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

// claude-factory-ctae.2: an abbreviation of `--repo`, `--push-option`, `--receive-pack` or
// `--exec` still takes the next word as its value, the same as the exact flag. This guard cannot
// tell which word git reads as the value and which as a refspec, so it denies the whole push.
// Real git 2.54 confirmed that `git push --rece git-receive-pack o` on `main` pushes `main`.
const DENY_PUSH_VALUE_FLAG_ABBREVIATION = [
  'git push --rece x o',
  'git push --rep x o',
  'git push --exe x o',
  'git push --push-o x o',
]

test.each(DENY_PUSH_VALUE_FLAG_ABBREVIATION)(
  'denyReason denies %j (claude-factory-ctae.2, an abbreviated push value flag)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
  },
)

test('denyReason allows the exact push value flag, which skips its own value word (claude-factory-ctae.2)', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(denyReason('git push --receive-pack x o factory/x', undefined, undefined, gate)).toBeUndefined()
})

// claude-factory-ctae.3: a `--no-dry-run` word, or a unique abbreviation of it, clears `dryRun`
// again, in any order with `-n`/`--dry-run` on the same command line. Real git 2.54 confirmed
// that each row below moves `main`, even though a bare `-n` or `--dry-run` alone never pushes.
const DENY_PUSH_NO_DRY_RUN = ['git push -n --no-dry-run o main', 'git push --dry-run --no-dr o main']

test.each(DENY_PUSH_NO_DRY_RUN)(
  'denyReason denies %j (claude-factory-ctae.3, --no-dry-run clears dry-run)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

test('denyReason denies git send-pack --dry-run --no-dry-run o main (claude-factory-ctae.3)', () => {
  expect(denyReason('git send-pack --dry-run --no-dry-run o main')).toBe(PUSH_REASON)
})

// claude-factory-ctae.7: the push side has both an exact and an abbreviated `--no-dry-run` row
// (`DENY_PUSH_NO_DRY_RUN` above). This row gives send-pack the same abbreviated-form coverage.
test('denyReason denies git send-pack --dry-run --no-dr o main (claude-factory-ctae.7, abbreviated --no-dry-run)', () => {
  expect(denyReason('git send-pack --dry-run --no-dr o main')).toBe(PUSH_REASON)
})

// claude-factory-ctae.5: these flags already deny through the existing refspec check. Each row
// pins that result so a future change to the flag scan cannot silently stop denying it.
const DENY_PUSH_DELETE_OR_FORCE_WITH_LEASE = [
  'git push --del o main',
  'git push --force-with o main',
  'git push --force-with-lease=main o main',
  'git push -d o main',
]

test.each(DENY_PUSH_DELETE_OR_FORCE_WITH_LEASE)(
  'denyReason denies %j (claude-factory-ctae.5, --delete and --force-with-lease abbreviations)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

test('denyReason allows git push --del o factory/x (claude-factory-ctae.5)', () => {
  expect(denyReason('git push --del o factory/x')).toBeUndefined()
})

// claude-factory-ctae.9: `--recurse-submodules` takes a required value word, the same as
// `--repo` or `--exec`. Real git 2.54 confirmed this: `git push --recurse-submodules no x`,
// with headOf=main and no refspec, pushes the current branch (`main`) to remote `x`. Without
// this flag in the value-flag sets, the guard read `no` as the remote and `x` as an
// unprotected refspec, and allowed the call.
const DENY_PUSH_RECURSE_SUBMODULES = ['git push --recurse-submodules no x', 'git push --recurse-sub no x']

test.each(DENY_PUSH_RECURSE_SUBMODULES)(
  'denyReason denies %j (claude-factory-ctae.9, --recurse-submodules is a push value flag)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
  },
)

test('denyReason allows the exact push --recurse-submodules, which skips its own value word (claude-factory-ctae.9)', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(
    denyReason('git push --recurse-submodules no o factory/x', undefined, undefined, gate),
  ).toBeUndefined()
})

// claude-factory-ctae.11: `-o` takes a required value word, the same as `--repo` or `--exec`.
// A short-flag cluster that also holds `o`, for example `-uo` or `-fo`, takes the next word as
// that same value. Real git 2.54 confirmed this: `git push -uo x origin` on `main`, with no
// other refspec, pushes `main` to remote `origin`.
const DENY_PUSH_SHORT_FLAG_CLUSTER_WITH_O = ['git push -uo x origin', 'git push -fo x origin']

test.each(DENY_PUSH_SHORT_FLAG_CLUSTER_WITH_O)(
  'denyReason denies %j (claude-factory-ctae.11, a short-flag cluster that holds -o)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
  },
)

// claude-factory-ctae.12: an abbreviated value flag, or an `-o` short-flag cluster, hides the
// next word as that flag's own value.
//
// Before this fix, `gitPushDenied` read `dryRun` before it read this `unreadableValueFlag` risk.
// A hidden `-n` or `--dry-run` word is really that flag's own value, not a dry-run flag.
// The old check order made the guard allow the whole call as a false dry run.
//
// Real git 2.54 confirmed the real risk. Each row below moves `main`, even with the apparent
// dry-run flag present.
const DENY_PUSH_UNREADABLE_VALUE_FLAG_THEN_DRY_RUN_WORD = [
  'git push --rep -n origin main',
  'git push --rep --dry-run origin main',
  'git push -uo -n origin',
  'git push --push-o -n origin main',
]

test.each(DENY_PUSH_UNREADABLE_VALUE_FLAG_THEN_DRY_RUN_WORD)(
  'denyReason denies %j (claude-factory-ctae.12, an unreadable value flag denies before the dry-run allow)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

// claude-factory-ctae.12: `--mirror` does not hide a later word as its own value, so a real
// `-n` right before it still means a dry run. This row pins that this fix did not turn the
// `broad` flags into another `unreadableValueFlag` case.
test('denyReason allows git push -n --mirror o (claude-factory-ctae.12, a true broad flag stays a real dry run)', () => {
  expect(denyReason('git push -n --mirror o')).toBeUndefined()
})

test('denyReason allows a bare git push, git push origin HEAD and git push -u origin HEAD on a run branch', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(denyReason('git push', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git push origin HEAD', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git push -u origin HEAD', undefined, undefined, gate)).toBeUndefined()
})

// claude-factory-zl5.19: `@` is a short alias for `HEAD`.
// On a case-insensitive filesystem (macOS), git's own ref lookup also resolves `head`, in any
// letter case, to `HEAD`.
// Real git confirmed that both push the current branch.
// A refspec of `@` or `head` must deny the same way a bare `HEAD` does on a protected current
// branch.
const DENY_PUSH_HEAD_ALIAS = ['git push origin @', 'git push origin head', 'git push origin Head']

test.each(DENY_PUSH_HEAD_ALIAS)(
  'denyReason denies %j when the current branch is main (claude-factory-zl5.19)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
  },
)

test('denyReason allows git push origin @ and head on a run branch (claude-factory-zl5.19)', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(denyReason('git push origin @', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git push origin head', undefined, undefined, gate)).toBeUndefined()
})

// claude-factory-zl5.20: real git resolves an unqualified push `<dst>` by trying it under `refs/`
// first, so `heads/main` reaches the real `refs/heads/main`, the same branch a bare `main`
// reaches. Real git confirmed this DWIM for both the colon form and the bare form.
const DENY_PUSH_HEADS_PREFIX = ['git push origin HEAD:heads/main', 'git push origin heads/main']

test.each(DENY_PUSH_HEADS_PREFIX)(
  'denyReason denies %j (claude-factory-zl5.20, DWIM reaches refs/heads/main)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

// claude-factory-zl5.21: a `-c alias.<name>=push` or `git config alias.<name> push` write defines
// a push alias; `-c remote.<name>.push=<refspec>` or `git config remote.<name>.push <refspec>`
// sets a push override. Either write can send a later, plain-looking push to a protected branch
// with no push word, and no protected branch name, on that later command line. This guard denies
// the write itself.
const DENY_GIT_CONFIG_PUSH = [
  'git config alias.p push',
  'git config alias.p "push origin main"',
  'git config remote.origin.push HEAD:refs/heads/main',
  'git -c remote.origin.push=HEAD:refs/heads/main push',
]

test.each(DENY_GIT_CONFIG_PUSH)('denyReason denies %j (claude-factory-zl5.21)', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

// claude-factory-zl5.28: an `alias.<name>` write denies on any value now, not only a `push`
// command. Real git confirmed `alias.p` set to `!git push`, and `alias.x` set to `!git`, each
// let a later command reach `main` the same way a `push`-valued alias does.
//
// `git config set <name> <value>` is git 2.46's new subcommand form of the same write. The old
// operand-position read missed it: it read the word `set` itself as the key name. These rows
// cover that form for `alias.<name>`, `remote.<name>.push` and `push.default`.
const DENY_GIT_CONFIG_PUSH_ANY_VALUE = [
  "git config alias.p '!git push'",
  "git -c alias.p='!git push' p origin main",
  'git config alias.x "!git"',
  'git config set alias.p push',
  'git -c alias.p=push p origin main',
  'git config set remote.origin.push HEAD:refs/heads/main',
  'git config --comment x remote.origin.push HEAD:refs/heads/main',
  'git config --value x remote.origin.push HEAD:refs/heads/main',
  'git config --blob x remote.origin.push HEAD:refs/heads/main',
  'git config --url x remote.origin.push HEAD:refs/heads/main',
  'git config --comm x remote.origin.push HEAD:refs/heads/main',
  'git config --val x remote.origin.push HEAD:refs/heads/main',
  'git config -zf x remote.origin.push HEAD:refs/heads/main',
  'git config -zt x remote.origin.push HEAD:refs/heads/main',
  'git config -ft remote.origin.push HEAD:refs/heads/main',
  'git config -flt remote.origin.push HEAD:refs/heads/main',
  'git config -zft remote.origin.push HEAD:refs/heads/main',
  'git config -tf remote.origin.push HEAD:refs/heads/main',
  'git config -fz remote.origin.push HEAD:refs/heads/main',
  'git config set --value x remote.origin.push HEAD:refs/heads/main',
  'git config set --comment x alias.p push',
  'git config push.default upstream',
  'git config push.default tracking',
  'git -c push.default=upstream push origin main',
]

test.each(DENY_GIT_CONFIG_PUSH_ANY_VALUE)('denyReason denies %j (claude-factory-zl5.28)', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

const ALLOW_GIT_CONFIG = [
  'git config user.name "Test"',
  'git config --get remote.origin.url',
  'git config get alias.co',
  'git config push.default simple',
  'git config get push.default',
]

test.each(ALLOW_GIT_CONFIG)('denyReason allows %j', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-zl5.12: a HEAD-targeting push is a bare `git push`, or `git push origin HEAD`.
// When this guard cannot read the current branch, it has no name to check against the
// protected list. This guard then fails closed. It denies, and does not let the push through.
const DENY_PUSH_UNKNOWN_CURRENT_BRANCH = ['git push', 'git push origin HEAD', 'git push -u origin HEAD']

test.each(DENY_PUSH_UNKNOWN_CURRENT_BRANCH)(
  'denyReason denies %j when the current branch cannot be read (fail closed, claude-factory-zl5.12)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
    expect(denyReason(cmd, undefined, undefined, { headOf: () => undefined })).toBe(PUSH_REASON)
  },
)

// claude-factory-zl5.13: `gate.originHead` is wired (the rig reads the real origin/HEAD), but the
// read failed. This guard cannot tell the rig's real default branch from any other, so it denies
// every branch-targeting push outright, even to a branch name that is not on the protected list.
test('denyReason denies a push to any branch when a wired gate.originHead cannot read it (fail closed, claude-factory-zl5.13)', () => {
  const gate = { originHead: () => undefined }
  expect(denyReason('git push origin develop', undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(denyReason('git push origin factory/x', undefined, undefined, gate)).toBe(PUSH_REASON)
})

// claude-factory-zl5.13: a rig with no gate.originHead at all never reads origin/HEAD. The
// unresolved-read deny does not apply: main, master and protectedBranches still apply alone.
test('denyReason allows a push to an unprotected branch when the rig has no gate.originHead at all', () => {
  expect(denyReason('git push origin develop')).toBeUndefined()
})

test('denyReason allows git -C .scratch/x status (not a push)', () => {
  expect(denyReason('git -C .scratch/x status')).toBeUndefined()
})

// claude-factory-3f2z.1: gitReason resolves the push dir against gate.cwd, the tool call's own
// cwd. It folds every -C in the command, in order. Real git folds a repeated -C global flag
// the same way: an absolute value replaces the dir, a relative value joins onto it, and an
// empty value changes nothing.
//
// root=/acme/root is the worktree root. gate.cwd=/acme/cwd stands in for a prior Bash call's
// cd into a second repo. Each row's headOf fake denies only at its own expected dir, so a wrong
// dir allows the push instead of denying it. The fake also records every dir that headOf saw.
const GIT_CHDIR_ROWS: [string, string][] = [
  ['git push origin HEAD', '/acme/cwd'],
  ['git -C sub push origin HEAD', '/acme/cwd/sub'],
  ['git -C /a -C b push origin HEAD', '/a/b'],
  ['git -C /a -C /c push origin HEAD', '/c'],
  ['git -C "" push origin HEAD', '/acme/cwd'],
]

test.each(GIT_CHDIR_ROWS)(
  'denyReason folds -C onto gate.cwd for %j, denies only at dir %j (claude-factory-3f2z.1)',
  (cmd, expectedDir) => {
    const dirs: (string | undefined)[] = []
    const gate: HookGate = {
      cwd: '/acme/cwd',
      headOf: dir => {
        dirs.push(dir)
        return dir === expectedDir ? 'main' : 'factory/x'
      },
    }
    expect(denyReason(cmd, '/acme/root', undefined, gate)).toBe(PUSH_REASON)
    expect(dirs).toEqual([expectedDir])
  },
)

// claude-factory-3f2z.4: an unknown flag before the verb makes the verb search uncertain.
// One example is `--attr-source HEAD`. The fallback then finds the verb by `indexOf`.
// It must set `verbIndex` to that found position.
//
// Without that set, `dir` folds only the words before the wrong, early guess. It then
// misses the `-C sub` word that comes after the guess. The push then reads the wrong branch.
test('denyReason folds -C before push, through the uncertain-verb fallback (claude-factory-3f2z.4)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    cwd: '/acme/cwd',
    headOf: dir => {
      dirs.push(dir)
      return dir === '/acme/cwd/sub' ? 'main' : 'factory/x'
    },
  }
  expect(denyReason('git --attr-source HEAD -C sub push origin HEAD', '/acme/root', undefined, gate)).toBe(
    PUSH_REASON,
  )
  expect(dirs).toEqual(['/acme/cwd/sub'])
})

test('denyReason folds -C before send-pack, through the uncertain-verb fallback (claude-factory-3f2z.4)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    cwd: '/acme/cwd',
    headOf: dir => {
      dirs.push(dir)
      return dir === '/acme/cwd/sub' ? 'main' : 'factory/x'
    },
  }
  expect(
    denyReason('git --attr-source HEAD -C sub send-pack origin HEAD', '/acme/root', undefined, gate),
  ).toBe(PUSH_REASON)
  expect(dirs).toEqual(['/acme/cwd/sub'])
})

// claude-factory-3f2z.1 (AC2): the same -C fold must not over-deny. When the real dir's branch
// is not protected, the push still allows.
test('denyReason allows git -C sub push origin HEAD when the resolved dir is on an unprotected branch (claude-factory-3f2z.1)', () => {
  const gate: HookGate = { cwd: '/acme/cwd', headOf: dir => (dir === '/acme/cwd/sub' ? 'feature' : 'main') }
  expect(denyReason('git -C sub push origin HEAD', '/acme/root', undefined, gate)).toBeUndefined()
})

// claude-factory-3f2z.1 (AC5): with no gate.cwd, headOf keeps reading root, unchanged from
// before this fix.
test('denyReason reads root for a push dir when gate.cwd is unset (claude-factory-3f2z.1, AC5)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    headOf: dir => {
      dirs.push(dir)
      return 'main'
    },
  }
  expect(denyReason('git push origin HEAD', '/acme/root', undefined, gate)).toBe(PUSH_REASON)
  expect(dirs).toEqual(['/acme/root'])
})

// claude-factory-3f2z.7: `-c`, `--git-dir`, `--work-tree` and `--namespace` each take one
// value word, with no `=`. gitChdir must step over that value word.
// gitChdir must not read that word as a `-C` flag.
//
// Each row below puts an extra `-C` word after one of these flags. That extra `-C` word is
// the flag's own value. It is not a real `-C` flag.
//
// The real `-C` word follows the extra word. The real `-C` word must set the dir.
// headOf here denies only at /acme/prot. A wrong fold reads the extra `-C` word as the real
// flag. A wrong fold then allows the push.
const GIT_CHDIR_VALUE_FLAG_ROWS: [string, boolean][] = [
  ['git --namespace -C -C /acme/prot push origin HEAD', false],
  ['git --work-tree -C -C /acme/prot push origin HEAD', false],
  ['git --namespace -C -C /acme/prot send-pack origin HEAD', true],
]

test.each(GIT_CHDIR_VALUE_FLAG_ROWS)(
  'denyReason steps over a value-flag word before folding -C, for %j (claude-factory-3f2z.7)',
  (cmd, isSendPack) => {
    const dirs: (string | undefined)[] = []
    const gate: HookGate = {
      cwd: '/acme/cwd',
      headOf: dir => {
        dirs.push(dir)
        return dir === '/acme/prot' ? 'main' : 'factory/x'
      },
    }
    expect(denyReason(cmd, '/acme/root', undefined, gate)).toBe(PUSH_REASON)
    expect(dirs).toEqual(['/acme/prot'])
    void isSendPack
  },
)

// claude-factory-3f2z.7: regression guard. Here the real `-C` word comes first, so it
// already sets the dir to the protected dir.
//
// The extra `-C` word is the value of `--namespace`. It is the last word, so it sets
// nothing. This command must stay denied after the fix, the same as before the fix.
test('denyReason keeps denying when the real -C comes before a value-flag word (claude-factory-3f2z.7)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    cwd: '/acme/cwd',
    headOf: dir => {
      dirs.push(dir)
      return dir === '/acme/prot' ? 'main' : 'factory/x'
    },
  }
  expect(denyReason('git -C /acme/prot --namespace -C push origin HEAD', '/acme/root', undefined, gate)).toBe(
    PUSH_REASON,
  )
  expect(dirs).toEqual(['/acme/prot'])
})

// claude-factory-3f2z.7: an unknown flag before the verb can also take a value word.
// This hook does not know that flag, through the uncertain-verb fallback.
//
// A value word that starts with `-` can look like a `-C` flag. gitChdir then cannot tell a
// real `-C <dir>` word apart from this value word.
// gitChdir must fail closed in this case. It must not call gate.headOf.
// claude-factory-bemr.12: `--super-prefix` stands in for `--attr-source` here. `--attr-source`
// moved into `GIT_VALUE_FLAGS` under claude-factory-bemr.9, so it no longer tests this row's
// point (a flag this hook does not know). `--super-prefix` is a real git global flag, and this
// hook still does not know it.
//
// claude-factory-bemr.16 (AC20): each command here has a literal `-C` word in `tail`. The
// uncertain-path alias check now denies these with `ALIAS_USE_REASON`, before `gitChdir` ever
// runs. This is a deny-to-deny reason change: the row stayed denied, and `gate.headOf` is still
// never called.
const GIT_CHDIR_UNSAFE_ROWS: [string][] = [
  ['git --super-prefix -C -C /acme/prot push origin HEAD'],
  ['git --super-prefix -C -C /acme/prot send-pack origin HEAD'],
]

test.each(GIT_CHDIR_UNSAFE_ROWS)(
  'denyReason fails closed on an unresolved -C value, for %j (claude-factory-3f2z.7, bemr.16)',
  cmd => {
    const dirs: (string | undefined)[] = []
    const gate: HookGate = {
      cwd: '/acme/cwd',
      headOf: dir => {
        dirs.push(dir)
        return dir === '/acme/prot' ? 'main' : 'factory/x'
      },
      // claude-factory-bemr.12: an empty, readable alias table. `--super-prefix` leaves the verb
      // search unsure, so the row must clear the bemr.9 uncertain-path alias check before it
      // reaches the `-C`-unsafe fallback this row tests.
      gitAliases: () => new Map(),
    }
    expect(denyReason(cmd, '/acme/root', undefined, gate)).toBe(ALIAS_USE_REASON)
    expect(dirs).toEqual([])
  },
)

// claude-factory-3f2z.8 (P1 fail-open regression): an unknown flag's own value word can fake the
// push or send-pack verb. Before the fix, the old code trusted that fake word outright and
// missed a real -C word that came after it. gate.headOf then read gate.cwd, an unprotected dir,
// and the push allowed.
// claude-factory-3f2z.9 (P1 fail-open regression): the fallback found the fake verb's own
// `pushTail`, with no refspec, a remote-only operand, or `--force`. The old code still asked
// gitPushDenied/sendPackDenied with that wrong pushTail. A bare push, or a push with no
// branch-naming refspec, read as safe there, so the push allowed.
// claude-factory-bemr.12: `--super-prefix` stands in for `--attr-source` here, for the same
// reason as `GIT_CHDIR_UNSAFE_ROWS` above: `--attr-source` is now a known value flag
// (claude-factory-bemr.9), so it no longer fakes an unknown flag's value word.
const GIT_CHDIR_FAKE_VERB_ROWS: [string][] = [
  ['git --super-prefix push -C /acme/prot push origin HEAD'],
  ['git --super-prefix send-pack -C /acme/prot send-pack origin HEAD'],
  ['git --super-prefix push -C /acme/prot push'],
  ['git --super-prefix push -C /acme/prot push origin'],
  ['git --super-prefix push -C /acme/prot push --force'],
  ['git --super-prefix send-pack -C /acme/prot send-pack origin'],
]

// claude-factory-bemr.16 (AC20): each row has a literal `-C` word in `tail`. The uncertain-path
// alias check now denies these with `ALIAS_USE_REASON`, before the fake-verb push logic below it
// ever runs. Deny-to-deny reason change: `gate.headOf` stays uncalled.
test.each(GIT_CHDIR_FAKE_VERB_ROWS)(
  'denyReason does not trust a fake push/send-pack word as the verb, for %j (claude-factory-3f2z.8, bemr.16)',
  cmd => {
    const dirs: (string | undefined)[] = []
    const gate: HookGate = {
      cwd: '/acme/cwd',
      headOf: dir => {
        dirs.push(dir)
        return dir === '/acme/prot' ? 'main' : 'factory/x'
      },
      // claude-factory-bemr.12: see GIT_CHDIR_UNSAFE_ROWS above.
      gitAliases: () => new Map(),
    }
    expect(denyReason(cmd, '/acme/root', undefined, gate)).toBe(ALIAS_USE_REASON)
    expect(dirs).toEqual([])
  },
)

// claude-factory-3f2z.8: regression guard. --attr-source takes the -C word as its own value
// here, so no -C flag applies, and the push must still read gate.cwd.
test('denyReason still reads gate.cwd for git --attr-source -C push, with no real -C flag (claude-factory-3f2z.8)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    cwd: '/acme/cwd',
    headOf: dir => {
      dirs.push(dir)
      return dir === '/acme/prot' ? 'main' : 'factory/x'
    },
  }
  expect(denyReason('git --attr-source -C push', '/acme/root', undefined, gate)).toBeUndefined()
  expect(dirs).toEqual(['/acme/cwd'])
})

// claude-factory-3f2z.8: regression guard. The real -C word before push must still fold onto
// gate.cwd and deny at the protected dir, the same as before the fix (claude-factory-3f2z.4).
test('denyReason still folds the real -C before push, through the uncertain-verb fallback (claude-factory-3f2z.8)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    cwd: '/acme/cwd',
    headOf: dir => {
      dirs.push(dir)
      return dir === '/acme/prot' ? 'main' : 'factory/x'
    },
  }
  expect(
    denyReason('git --attr-source HEAD -C /acme/prot push origin HEAD', '/acme/root', undefined, gate),
  ).toBe(PUSH_REASON)
  expect(dirs).toEqual(['/acme/prot'])
})

test('denyReason reads an undefined push dir when neither gate.cwd nor root is set (claude-factory-3f2z.1, AC5)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    headOf: dir => {
      dirs.push(dir)
      return 'main'
    },
  }
  expect(denyReason('git push origin HEAD', undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(dirs).toEqual([undefined])
})

// claude-factory-zl5.3: main() reads the rig's protected branch names from --protected-branches on
// its own argv, split on comma, and carries origin/HEAD and the current branch through real git
// calls. claude-factory-zl5.13: a fake root with no real git repo cannot resolve origin/HEAD at
// all, so it denies every branch-targeting push there, not only main and master.
test('run as `bun src/worker-hook.ts`, with no origin/HEAD to read, main and other branches both deny (claude-factory-zl5.13)', async () => {
  const denyInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: '/w',
    tool_input: { command: 'git push origin main' },
  })
  const denied = await run(denyInput)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
  const otherInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: '/w',
    tool_input: { command: 'git push origin factory/x' },
  })
  const deniedOther = await run(otherInput)
  expect(deniedOther.code).toBe(0)
  expect(JSON.parse(deniedOther.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
}, 10_000)

// claude-factory-zl5.13: this test needs origin/HEAD to resolve, so it uses a real scratch repo
// (like the claude-factory-zl5.9 tests below), not a fake root. On that repo, --protected-branches
// makes the only difference: a push to acme/deploy denies with the argv, and allows without it.
test('run as `bun src/worker-hook.ts --protected-branches acme/deploy`, a push to that branch denies; without the argv it allows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-push-protected-branch-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: dir,
    tool_input: { command: 'git push origin acme/deploy' },
  })
  const withArgv = await run(input, env, ['--protected-branches', 'acme/deploy'])
  expect(withArgv.code).toBe(0)
  expect(JSON.parse(withArgv.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
  const withoutArgv = await run(input, env)
  expect(withoutArgv).toEqual({ out: '', code: 0 })
}, 10_000)

// claude-factory-dts: a long multi-push command must deny fast, inside the hook's 10 s timeout.
// The old code ran one spawn per push segment, with no cache: 583 segments took 10527 ms at
// load 52, past the timeout, so the hook failed open. memoGate caches each spawn, so the fix
// denies the same command well under 10 s.
test('run as `bun src/worker-hook.ts --protected-branches acme/deploy`, 583 stacked push segments deny with PUSH_REASON, under 10s (claude-factory-dts)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-push-long-multi-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  delete env.FACTORY_OUTBOX
  delete env.FACTORY_FROM
  env.FACTORY_SELF_UPDATE = '0'
  const command = 'git push o b; '.repeat(583) + 'git push origin main'
  expect(command.length).toBe(8182)
  const input = JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command } })
  const start = Date.now()
  const { out, code } = await run(input, env, ['--protected-branches', 'acme/deploy'])
  const elapsedMs = Date.now() - start
  expect(code).toBe(0)
  expect(JSON.parse(out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
  expect(elapsedMs).toBeLessThan(10_000)
}, 30_000)

// claude-factory-dts: this command has 1500 push segments, 21020 characters, over the
// MAX_COMMAND_LENGTH cap of 8192. The hook now denies it with LONG_COMMAND_REASON on every rig,
// not only one with --person-only-contexts set. Before the fix, a rig with no
// --person-only-contexts scanned the whole command, which took 25876 ms at load 52, past the
// hook's 10 s timeout.
test('run as `bun src/worker-hook.ts --protected-branches acme/deploy`, 1500 stacked push segments deny with LONG_COMMAND_REASON (claude-factory-dts)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-push-too-long-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  delete env.FACTORY_OUTBOX
  delete env.FACTORY_FROM
  env.FACTORY_SELF_UPDATE = '0'
  const command = 'git push o b; '.repeat(1500) + 'git push origin main'
  expect(command.length).toBe(21020)
  const input = JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command } })
  const { out, code } = await run(input, env, ['--protected-branches', 'acme/deploy'])
  expect(code).toBe(0)
  expect(JSON.parse(out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: LONG_COMMAND_REASON,
    },
  })
}, 30_000)

// claude-factory-zl5.10: a REST or GraphQL call can write a ref or a file through the API. This
// can commit to, or delete, a protected branch with no `git push` word on the command line.
// `git -c alias.<name>=push` is the same trick for plain `git push`: it runs `push` under a
// different name.
const DENY_API_PUSH = [
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc123',
  'gh api -X DELETE repos/o/r/git/refs/heads/main',
  'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc123', // POST (has data, no -X): create ref
  'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ== -f branch=main',
  'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ==', // no branch field: fails closed
  "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { updateRefs(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { deleteRef(input: {}) { clientMutationId } }'",
  'git -c alias.p=push p origin main',
  "git -c alias.p='push --force' p origin main",
]

test.each(DENY_API_PUSH)('denyReason denies %j', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

const ALLOW_API_PUSH = [
  'gh api repos/o/r/git/refs/heads/main', // GET: read-only
  'gh api -X PATCH repos/o/r/git/refs/heads/factory/x -f sha=abc123', // not a protected branch
  'gh api repos/o/r/contents/a.txt', // GET: read-only
  'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ== -f branch=factory/x',
  "gh api graphql -f query='query { viewer { login } }'",
  'git -c user.name=push commit -m x', // not an alias.* key
]

test.each(ALLOW_API_PUSH)('denyReason allows %j', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-zl5.15: `-p`/`--preview` take a value word. GH_API_VALUE_FLAGS did not list it.
// So the value word stood in for the real endpoint. The method and endpoint after it went
// unchecked.
const DENY_MERGE_PREVIEW = [
  'gh api -p corsair -X PUT repos/o/r/pulls/5/merge',
  'gh api --preview corsair -X PUT repos/o/r/pulls/5/merge',
]

test.each(DENY_MERGE_PREVIEW)('denyReason denies %j (claude-factory-zl5.15)', cmd => {
  expect(denyReason(cmd)).toBe(MERGE_REASON)
})

// claude-factory-zl5.16: gh reads a field pair as `-f=name=value` too: an `=` right after the
// 1-char flag. gh also lets a caller cluster a boolean short flag (`-i`) with a value-taking
// one (`-X`, `-f`, `-F`), in one word.
const DENY_MERGE_PFLAG = [
  "gh api graphql -f=query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  "gh api graphql -F=query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  'gh api -iXPUT repos/o/r/pulls/5/merge',
  'gh api -if base=main repos/o/r/merges',
]

test.each(DENY_MERGE_PFLAG)('denyReason denies %j (claude-factory-zl5.16)', cmd => {
  expect(denyReason(cmd)).toBe(MERGE_REASON)
})

const ALLOW_MERGE_PFLAG = ['gh api -i repos/o/r/pulls/5/merge'] // GET + --include: read-only
test.each(ALLOW_MERGE_PFLAG)('denyReason allows %j', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-zl5.17: `gh api` takes the GraphQL endpoint as a bare `graphql`, a leading-slash
// path, or a full URL. Each form must reach the same merge, ready and push mutation checks.
const DENY_MERGE_GRAPHQL_ENDPOINT = [
  "gh api /graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  "gh api https://api.github.com/graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
]

test.each(DENY_MERGE_GRAPHQL_ENDPOINT)('denyReason denies %j (claude-factory-zl5.17)', cmd => {
  expect(denyReason(cmd)).toBe(MERGE_REASON)
})

// claude-factory-zl5.18: a `$variable` or `$(command)` in a field value, and a shell-expanded PR
// number in a REST path, read as literal, unresolved text here. Each must fail closed (deny),
// not pass with no match.
const DENY_MERGE_SHELL_EXPANSION = [
  'gh api graphql -f query="$Q"',
  'gh api graphql -f query="$(cat f)"',
  'gh api -X PUT repos/o/r/pulls/$N/merge',
]

test.each(DENY_MERGE_SHELL_EXPANSION)('denyReason denies %j (claude-factory-zl5.18, fail closed)', cmd => {
  expect(denyReason(cmd)).toBe(MERGE_REASON)
})

// claude-factory-zl5.18 is a sibling bug in ghApiPushDenied's own field reads: a `ref` or
// `branch` field that is a shell expansion must fail closed too, the same as a graphql query.
const DENY_API_PUSH_SHELL_EXPANSION = [
  'gh api repos/o/r/git/refs -f ref="$REF" -f sha=abc123',
  'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ== -f branch="$BRANCH"',
]

test.each(DENY_API_PUSH_SHELL_EXPANSION)('denyReason denies %j (claude-factory-zl5.18, fail closed)', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

// claude-factory-zl5.25: the gh tool removes a `#fragment` before it sends the request. A REST
// or GraphQL endpoint with a `#fragment` must still reach the same merge, ready and push checks.
const DENY_HASH_FRAGMENT = [
  'gh api -X PUT repos/o/r/pulls/5/merge#x',
  'gh api repos/o/r/merges#x -f base=main -f head=x',
  "gh api graphql#x -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
]

test.each(DENY_HASH_FRAGMENT)('denyReason denies %j (claude-factory-zl5.25)', cmd => {
  expect(denyReason(cmd)).toBe(MERGE_REASON)
})

const DENY_HASH_FRAGMENT_PUSH = [
  'gh api repos/o/r/git/refs#x -f ref=refs/heads/main -f sha=abc123',
  'gh api -X PATCH repos/o/r/git/refs/heads/main#x -f sha=abc123',
]

test.each(DENY_HASH_FRAGMENT_PUSH)('denyReason denies %j (claude-factory-zl5.25)', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

// claude-factory-zl5.26: REF_HEADS_PATH must capture the whole name of a slash-named branch. It
// must not stop at the first slash. It must decode a percent-encoded branch name. It must also
// match the API path `git/ref/`, not only `git/refs/`.
const DENY_REF_HEADS_SLASH_AND_ENCODING = [
  'gh api -X PATCH repos/o/r/git/refs/heads/acme/deploy -f sha=abc123',
  'gh api -X PATCH repos/o/r/git/refs/heads/%6Dain -f sha=abc123',
  'gh api -X DELETE repos/o/r/git/refs/heads/%6Dain',
  'gh api -X PATCH repos/o/r/git/ref/heads/main -f sha=abc123',
]

test.each(DENY_REF_HEADS_SLASH_AND_ENCODING)('denyReason denies %j (claude-factory-zl5.26)', cmd => {
  expect(denyReason(cmd, undefined, undefined, { protectedBranches: ['acme/deploy'] })).toBe(PUSH_REASON)
})

test('denyReason denies a malformed percent-encoded branch name (fail closed, claude-factory-zl5.26)', () => {
  expect(denyReason('gh api -X PATCH repos/o/r/git/refs/heads/%zz')).toBe(PUSH_REASON)
})

// claude-factory-zl5.26: the `branch` field of a `contents` write must also pass through
// `stripRefsHeads`. The `ref` field of a ref-create call passes through it the same way.
const DENY_CONTENTS_BRANCH_PREFIX = [
  'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ== -f branch=refs/heads/main',
  'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ== -f branch=heads/main',
]

test.each(DENY_CONTENTS_BRANCH_PREFIX)('denyReason denies %j (claude-factory-zl5.26)', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

// claude-factory-zl5.30: a percent-encoded slash after `heads` (`heads%2Fmain`) names the same path as a literal one (`heads/main`).
// GitHub decodes the whole path before it reads it.
// The raw, still-encoded path has no `/` there. So REF_HEADS_PATH never matches the raw text.
// Only a whole-path decode before the match catches this.
const DENY_REF_HEADS_ENCODED_SLASH = [
  'gh api -X PATCH repos/o/r/git/refs/heads%2Fmain -f sha=abc123',
  'gh api -X DELETE repos/o/r/git/refs/heads%2Fmain',
]

test.each(DENY_REF_HEADS_ENCODED_SLASH)('denyReason denies %j (claude-factory-zl5.30)', cmd => {
  expect(denyReason(cmd)).toBe(PUSH_REASON)
})

// claude-factory-zl5.22: `gh alias set` or `gh alias import` can hide a denied gh command behind
// a short name this hook has no memory of from a later, separate `gh <name>` call.
//
// claude-factory-zl5.27: a text scan of the expansion cannot catch every such case. Real gh and
// real git confirmed 3 gaps: `gh alias set m '!gh pr merge 5'` (the `!` runs the rest with the
// shell, not as a `gh` subcommand, so the expansion has no `gh pr merge` word); `gh alias set m -`
// (the expansion comes from stdin, a stream this hook cannot read); and `gh alias set p pr` then
// a later `gh p merge 5` (gh appends the later call's own extra words to the alias; this hook
// checks one command line at a time, so it never sees `merge` on the defining line). So this
// guard denies every `gh alias set` call outright, with no scan of its expansion text, and also
// denies `gh alias import` outright (it reads a file this hook cannot check).
const DENY_GH_ALIAS = [
  'gh alias set m "pr merge"',
  'gh alias set m "gh pr merge"',
  'gh alias set co "pr checkout"',
  "gh alias set m '!gh pr merge 5'",
  'gh alias set m -',
  'gh alias set p pr',
]

test.each(DENY_GH_ALIAS)('denyReason denies %j (claude-factory-zl5.22, zl5.27)', cmd => {
  expect(denyReason(cmd)).toBe(ALIAS_REASON)
})

test('denyReason denies gh alias import outright (claude-factory-zl5.22)', () => {
  expect(denyReason('gh alias import aliases.yml')).toBe(ALIAS_REASON)
})

const ALLOW_GH_ALIAS = ['gh alias list', 'gh alias delete co']
test.each(ALLOW_GH_ALIAS)('denyReason allows %j', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-zl5.13: ghApiPushDenied shares protectedBranchSet with gitPushDenied. An
// unresolved origin/HEAD read denies an API branch write too, not only a `git push`.
test('denyReason denies a gh api branch write to any branch when a wired gate.originHead cannot read it', () => {
  const gate = { originHead: () => undefined }
  expect(
    denyReason(
      'gh api -X PATCH repos/o/r/git/refs/heads/factory/x -f sha=abc123',
      undefined,
      undefined,
      gate,
    ),
  ).toBe(PUSH_REASON)
  expect(
    denyReason(
      'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=YQ== -f branch=factory/x',
      undefined,
      undefined,
      gate,
    ),
  ).toBe(PUSH_REASON)
})

// claude-factory-zl5.9: main() wires gate.headOf and gate.originHead through real `git
// symbolic-ref` calls. A reviewer set both to return undefined by hand, and the 328 tests at the
// time still passed: this end-to-end test runs the hook against a real scratch git repo instead.
test('run as `bun src/worker-hook.ts`, on a real repo on main a bare git push denies (claude-factory-zl5.9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-push-main-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  const input = JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git push' } })
  const denied = await run(input, env)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
}, 10_000)

// claude-factory-zl5.12: `git symbolic-ref --short HEAD` fails on a detached HEAD. This end-to-end
// test proves the real `headOf` wiring in main() denies there, not only a test's own fake gate.
// It sets refs/remotes/origin/HEAD to a resolvable branch first, so the deny comes from the
// unknown current branch (zl5.12), not from an unresolved origin/HEAD (zl5.13, tested above).
test('run as `bun src/worker-hook.ts`, on a real repo with a detached HEAD, a bare git push denies (claude-factory-zl5.12)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-push-detached-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  Bun.spawnSync(['git', '-C', dir, 'checkout', '-q', '--detach', 'HEAD'])
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  const input = JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git push' } })
  const denied = await run(input, env)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
}, 10_000)

test('run as `bun src/worker-hook.ts`, with origin/HEAD set to develop a push to develop denies, off main and master (claude-factory-zl5.9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-push-originhead-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'feature', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  // claude-factory-zl5.9: a real clone sets refs/remotes/origin/HEAD; this writes the same ref by
  // hand, with no real remote, so the test needs no network and no second repo.
  Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  const denyInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: dir,
    tool_input: { command: 'git push origin develop' },
  })
  const denied = await run(denyInput, env)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
  // the current branch, "feature", is still not protected: the originHead wiring must not over-deny
  const allowInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: dir,
    tool_input: { command: 'git push origin feature' },
  })
  const allowed = await run(allowInput, env)
  expect(allowed).toEqual({ out: '', code: 0 })
}, 10_000)

// claude-factory-3f2z.2: main() must set gate.cwd from tool_input.cwd. It must not use the
// worktree root (CLAUDE_PROJECT_DIR).
//
// This test keeps CLAUDE_PROJECT_DIR set. The zl5.9 and zl5.12 tests above do not. This test
// proves the real cross-repo case.
//
// A prior Bash call runs `cd`. This leaves tool_input.cwd on a second repo. A later
// `git push origin HEAD` or bare `git push` must read the branch of that second repo. It must
// not read the branch of the worktree root (claude-factory-3f2z, AC1).
test('run as `bun src/worker-hook.ts` with CLAUDE_PROJECT_DIR set, a HEAD push denies on the tool call cwd repo, not on root (claude-factory-3f2z.2, AC1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-3f2z-root-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'factory/x', root])
  Bun.spawnSync(['git', '-C', root, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const other = mkdtempSync(join(tmpdir(), 'wh-3f2z-other-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', other])
  Bun.spawnSync(['git', '-C', other, 'commit', '-q', '-m', 'init', '--allow-empty'])
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root }
  for (const command of ['git push origin HEAD', 'git push']) {
    const input = JSON.stringify({ tool_name: 'Bash', cwd: other, tool_input: { command } })
    const denied = await run(input, env)
    expect(denied.code).toBe(0)
    expect(JSON.parse(denied.out.trim())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: PUSH_REASON,
      },
    })
  }
}, 10_000)

// claude-factory-3f2z.2 (AC2): the same wiring must not wrongly deny a push.
//
// The tool call cwd repo is on an unprotected branch. The hook must still allow the push. This
// is true even though the worktree root is on another branch.
test('run as `bun src/worker-hook.ts` with CLAUDE_PROJECT_DIR set, a HEAD push allows on the tool call cwd repo when its branch is unprotected (claude-factory-3f2z.2, AC2)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-3f2z-root-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'factory/x', root])
  Bun.spawnSync(['git', '-C', root, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const other = mkdtempSync(join(tmpdir(), 'wh-3f2z-other-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'feature', other])
  Bun.spawnSync(['git', '-C', other, 'commit', '-q', '-m', 'init', '--allow-empty'])
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root }
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: other,
    tool_input: { command: 'git push origin HEAD' },
  })
  expect(await run(input, env)).toEqual({ out: '', code: 0 })
}, 10_000)

// claude-factory-3f2z.2 (AC3): a relative `git -C sub push origin HEAD` must resolve `sub`
// against tool_input.cwd. It must not use the hook process's own filesystem cwd. It must not
// use the worktree root.
//
// `rootDir/sub` and `processCwdDir/sub` are both on an unprotected branch (`feature`). A hook
// that reads either one by mistake allows the push. `toolCwdDir/sub` is the real target, and it
// is on `main`. Only a fix that resolves against `tool_input.cwd` denies here.
test('run as `bun src/worker-hook.ts`, a relative git -C sub push resolves against tool_input.cwd, not the hook process cwd or root (claude-factory-3f2z.2, AC3)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'wh-3f2z-root-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'factory/x', rootDir])
  Bun.spawnSync(['git', '-C', rootDir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync([
    'git',
    '-C',
    rootDir,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  ])
  const rootSub = join(rootDir, 'sub')
  Bun.spawnSync(['git', 'init', '-q', '-b', 'feature', rootSub])
  Bun.spawnSync(['git', '-C', rootSub, 'commit', '-q', '-m', 'init', '--allow-empty'])

  const processCwdDir = mkdtempSync(join(tmpdir(), 'wh-3f2z-hookcwd-'))
  const processCwdSub = join(processCwdDir, 'sub')
  Bun.spawnSync(['git', 'init', '-q', '-b', 'feature', processCwdSub])
  Bun.spawnSync(['git', '-C', processCwdSub, 'commit', '-q', '-m', 'init', '--allow-empty'])

  const toolCwdDir = mkdtempSync(join(tmpdir(), 'wh-3f2z-toolcwd-'))
  const toolCwdSub = join(toolCwdDir, 'sub')
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', toolCwdSub])
  Bun.spawnSync(['git', '-C', toolCwdSub, 'commit', '-q', '-m', 'init', '--allow-empty'])

  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: rootDir }
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: toolCwdDir,
    tool_input: { command: 'git -C sub push origin HEAD' },
  })
  const denied = await run(input, env, [], processCwdDir)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
}, 10_000)

// claude-factory-zl5.8: main() wires gate.readFile to a real, capped file read, resolved against
// the tool call's own cwd (`i.cwd`). A query=@file this guard can read is scanned for real; one it
// cannot read still fails closed (denies).
test('run as `bun src/worker-hook.ts`, gh api graphql -f query=@file reads the real file at the tool call cwd (claude-factory-zl5.8)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-graphql-file-'))
  writeFileSync(
    join(dir, 'm.graphql'),
    'mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }',
  )
  writeFileSync(join(dir, 'q.graphql'), 'query { viewer { login } }')
  const denyInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: dir,
    tool_input: { command: 'gh api graphql -f query=@m.graphql' },
  })
  const denied = await run(denyInput)
  expect(denied.code).toBe(0)
  expect(JSON.parse(denied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: MERGE_REASON,
    },
  })
  const allowInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: dir,
    tool_input: { command: 'gh api graphql -f query=@q.graphql' },
  })
  const allowed = await run(allowInput)
  expect(allowed).toEqual({ out: '', code: 0 })
  // a file this guard cannot read (it does not exist) still fails closed
  const missingInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: dir,
    tool_input: { command: 'gh api graphql -f query=@missing.graphql' },
  })
  const missingDenied = await run(missingInput)
  expect(missingDenied.code).toBe(0)
  expect(JSON.parse(missingDenied.out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: MERGE_REASON,
    },
  })
}, 10_000)

// claude-factory-zl5.31: Real git confirmed that `push.default matching` sends every local branch
// to a remote branch with the same name.
//
// That later command line has no refspec. `tracking` is the older name of `upstream`. This guard now
// denies `matching` and any value that it does not recognize. This guard cannot tell a safe value
// from a risky one, since it has no real git to ask.
const DENY_PUSH_DEFAULT_MATCHING_OR_UNKNOWN = [
  'git config push.default matching',
  'git config set push.default matching',
  'git -c push.default=matching push origin main',
  'git config push.default banana',
]

test.each(DENY_PUSH_DEFAULT_MATCHING_OR_UNKNOWN)(
  'denyReason denies %j (claude-factory-zl5.31, matching or an unknown value fails closed)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

test('denyReason allows the push.default values this guard already knows are safe (claude-factory-zl5.31)', () => {
  expect(denyReason('git config push.default current')).toBeUndefined()
  expect(denyReason('git config push.default simple')).toBeUndefined()
  expect(denyReason('git config push.default nothing')).toBeUndefined()
})

// claude-factory-zl5.32: real git confirmed a bare `:` refspec pushes every branch with a
// matching name on both ends, the same broad reach as `--all`. This guard used to read `:` as
// naming no branch at all, which let the push through with no protected-branch check.
const DENY_PUSH_MATCHING_COLON = ['git push origin :', 'git push origin +:']

test.each(DENY_PUSH_MATCHING_COLON)(
  'denyReason denies %j (claude-factory-zl5.32, a bare colon pushes every matching branch)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

// claude-factory-zl5.33: xargs can read an operand from its own stdin and append it after the
// text already on this command line. That operand can be the push refspec or the gh verb this
// guard would otherwise check, so it denies the whole command instead of trusting the text that
// stays visible.
const DENY_XARGS_BEFORE_GIT_OR_GH = [
  'xargs git push origin main',
  'echo main | xargs git push origin',
  'sudo xargs gh pr ready 5',
  'ls | xargs -n1 git push origin',
]

test.each(DENY_XARGS_BEFORE_GIT_OR_GH)(
  'denyReason denies %j (claude-factory-zl5.33, xargs can append a hidden operand)',
  cmd => {
    expect(denyReason(cmd)).toBe(XARGS_REASON)
  },
)

test('denyReason allows xargs ahead of a command that is not git or gh (claude-factory-zl5.33)', () => {
  expect(denyReason('echo hi | xargs echo')).toBeUndefined()
  expect(denyReason('git log | xargs -n1 echo')).toBeUndefined()
})

// claude-factory-zl5.33: Without this guard, a bare `git push origin` behind xargs reads as a push
// of the current branch (HEAD). The real target, which xargs appends from its own stdin, is not in
// this command text. On a run branch such as `feature`, this guard does not protect that read, so
// the command passes with no deny at all. This test checks the real case that the fix closes,
// not only a reason-text mismatch.
test('denyReason denies a push behind xargs even on an unprotected current branch (claude-factory-zl5.33)', () => {
  const gate = { headOf: () => 'feature' }
  expect(denyReason('echo main | xargs git push origin', undefined, undefined, gate)).toBe(XARGS_REASON)
})

// claude-factory-zl5.34: `--config-env=<name>=<envvar>` sets `<name>` from an environment variable
// that this guard cannot read. It denies the same 3 keys that `-c <name>=<value>` denies. It does
// not check a value, because it has no value to check.
//
// Each row below is a bare push with no refspec of its own, on a run branch (`feature`).
// A guard that does not check `--config-env` reads each row as a safe push of the current branch.
// Only the `--config-env` check denies each row.
const DENY_CONFIG_ENV_PUSH = [
  'git --config-env=alias.p=ENVVAR p origin',
  'git --config-env=remote.origin.push=ENVVAR push origin',
  'git --config-env=push.default=ENVVAR push origin',
]

test.each(DENY_CONFIG_ENV_PUSH)('denyReason denies %j (claude-factory-zl5.34)', cmd => {
  const gate = { headOf: () => 'feature' }
  expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
})

test('denyReason allows --config-env on an unrelated key (claude-factory-zl5.34)', () => {
  expect(denyReason('git --config-env=user.name=ENVVAR push origin feature')).toBeUndefined()
})

// claude-factory-bemr.13: `--config-env` has a second, bare form: `--config-env name=envvar`,
// with no `=` right after `--config-env` itself. Real git 2.54 runs this form the same way it
// runs the attached form above. This guard must read the same name from either form.
const DENY_CONFIG_ENV_PUSH_BARE_FORM = [
  'git --config-env alias.p=ENVVAR p origin',
  'git --config-env remote.origin.push=ENVVAR push origin',
]

test.each(DENY_CONFIG_ENV_PUSH_BARE_FORM)(
  'denyReason denies %j, the bare --config-env form (claude-factory-bemr.13)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason allows the bare --config-env form on an unrelated key (claude-factory-bemr.13)', () => {
  expect(denyReason('git --config-env user.name=ENVVAR push origin feature')).toBeUndefined()
})

// claude-factory-zl5.35: `git send-pack` is the plumbing `git push` itself calls, with no `push`
// word on its own command line. It takes the same refspec syntax, so this guard checks it the
// same way, through `refspecTarget` and `protectedBranchSet`.
test('denyReason denies git send-pack to a protected branch (claude-factory-zl5.35)', () => {
  expect(denyReason('git send-pack origin refs/heads/main')).toBe(PUSH_REASON)
  expect(denyReason('git send-pack --all origin')).toBe(PUSH_REASON)
  expect(denyReason('git send-pack origin', undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
  // the uncertain-verb path: an unrecognized global flag ahead of send-pack.
  // claude-factory-bemr.5 (AC11): an explicit empty gitAliases stub keeps this row's original
  // intent (the uncertain-verb push-tail scan, not an alias) now that the uncertain path also
  // reads the alias table.
  expect(
    denyReason('git --unknown-flag send-pack origin main', undefined, undefined, {
      gitAliases: () => new Map(),
    }),
  ).toBe(PUSH_REASON)
})

test('denyReason allows git send-pack to a run branch (claude-factory-zl5.35)', () => {
  expect(denyReason('git send-pack origin refs/heads/feature')).toBeUndefined()
})

// claude-factory-zl5.39: review-r2 found that xargs ahead of a bare `git`/`gh` word denies
// (zl5.33), but real git still moved `main` through 3 sibling forms: a value flag with its value
// as its own word, a wrapper between xargs and git, and a long flag with no value. Each row below
// is a bare push with no refspec of its own, on a run branch (`feature`): a guard that stops at
// the first word after xargs reads each one as a safe push of the current branch.
const DENY_XARGS_VALUE_FLAG_OR_WRAPPER = [
  'echo main | xargs -n 1 git push origin',
  'xargs -L 1 git push origin',
  'xargs env git push origin',
  'xargs sudo git push origin',
  'xargs timeout 5 git push origin',
]

test.each(DENY_XARGS_VALUE_FLAG_OR_WRAPPER)(
  'denyReason denies %j (claude-factory-zl5.39, an xargs value flag or wrapper still hides git)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(XARGS_REASON)
  },
)

test('denyReason allows xargs with a flag ahead of a command that is not git or gh (claude-factory-zl5.39)', () => {
  expect(denyReason('xargs -n 1 echo hi')).toBeUndefined()
  expect(denyReason('xargs -L 1 sudo echo hi')).toBeUndefined()
})

// claude-factory-zl5.40: review-r2 found that `sendPackDenied` (zl5.35) read no ref as a push of
// `HEAD` alone, and ignored `--stdin` and `--mirror`. Real git moved `main` for each row below.
const DENY_SEND_PACK_BROAD = [
  'git send-pack ../remote.git',
  // these 2 rows also name an explicit, otherwise-safe ref (a run branch), so each one isolates
  // its own flag check: with the flag check removed, the explicit ref alone would read as safe
  // and this guard would allow the call.
  'echo refs/heads/main | git send-pack --stdin ../remote.git refs/heads/feature',
  'git send-pack --mirror ../remote.git refs/heads/feature',
]

test.each(DENY_SEND_PACK_BROAD)(
  'denyReason denies %j (claude-factory-zl5.40, no ref, --stdin and --mirror all push broadly)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason allows git send-pack with an explicit run-branch ref and no --stdin or --mirror (claude-factory-zl5.40)', () => {
  expect(denyReason('git send-pack ../remote.git refs/heads/feature')).toBeUndefined()
})

// claude-factory-ctae.4: a unique abbreviation of `--all`, `--mirror` or `--stdin` denies the
// same way the exact flag does. Real git 2.54 confirmed each row below moves `main`.
const DENY_SEND_PACK_BROAD_FLAG_ABBREVIATION = [
  'git send-pack --mirr ../remote.git refs/heads/factory/x',
  'git send-pack --al ../remote.git refs/heads/factory/x',
  'git send-pack --stdi ../remote.git refs/heads/factory/x',
]

test.each(DENY_SEND_PACK_BROAD_FLAG_ABBREVIATION)(
  'denyReason denies %j (claude-factory-ctae.4, an abbreviated send-pack broad flag)',
  cmd => {
    const gate = { headOf: () => 'factory/x' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

// claude-factory-ctae.4: an abbreviation of `--receive-pack` or `--exec` still takes the next
// word as its value, the same as the exact flag. This guard cannot tell which word git reads as
// the value, so it denies the whole call. Real git 2.54 confirmed that `git send-pack
// --receive-pack git-receive-pack <remote>` with no ref moves every branch, `main` included.
const DENY_SEND_PACK_VALUE_FLAG = [
  'git send-pack --receive-pack x ../remote.git',
  'git send-pack --exec x ../remote.git',
  'git send-pack --rece x ../remote.git refs/heads/factory/x',
  // claude-factory-ctae.6: `--push-option` is a 3rd member of `SEND_PACK_VALUE_FLAGS`, with no
  // row of its own until now. An abbreviation still takes a value word this guard cannot read.
  'git send-pack --push-o x ../remote.git',
]

test.each(DENY_SEND_PACK_VALUE_FLAG)(
  'denyReason denies %j (claude-factory-ctae.4, a send-pack value flag with no ref or an abbreviated form)',
  cmd => {
    const gate = { headOf: () => 'factory/x' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason allows the exact send-pack value flag, which skips its own value word (claude-factory-ctae.4)', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(
    denyReason(
      'git send-pack --receive-pack x ../remote.git refs/heads/factory/x',
      undefined,
      undefined,
      gate,
    ),
  ).toBeUndefined()
})

// claude-factory-ctae.6: the exact `--push-option` word also skips its own value word, the same
// as `--receive-pack` above. Only the abbreviated form denies.
test('denyReason allows the exact send-pack --push-option, which skips its own value word (claude-factory-ctae.6)', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(
    denyReason(
      'git send-pack --push-option x ../remote.git refs/heads/factory/x',
      undefined,
      undefined,
      gate,
    ),
  ).toBeUndefined()
})

// claude-factory-ctae.8: `--remote` is a 4th member of `SEND_PACK_VALUE_FLAGS`, with no row of
// its own until now. Real git 2.54 confirmed that `git send-pack --remote x ../remote.git`,
// with no ref, reads `x` as the value of `--remote` and pushes every matching branch. The
// abbreviated `--remo` form still takes a value word this guard cannot read.
const DENY_SEND_PACK_REMOTE = [
  'git send-pack --remote x ../remote.git',
  'git send-pack --remo x ../remote.git refs/heads/factory/x',
]

test.each(DENY_SEND_PACK_REMOTE)(
  'denyReason denies %j (claude-factory-ctae.8, send-pack --remote is a value flag)',
  cmd => {
    const gate = { headOf: () => 'factory/x' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason allows the exact send-pack --remote, which skips its own value word (claude-factory-ctae.8)', () => {
  const gate = { headOf: () => 'factory/x' }
  expect(
    denyReason('git send-pack --remote x ../remote.git refs/heads/factory/x', undefined, undefined, gate),
  ).toBeUndefined()
})

// claude-factory-ctae.12: the send-pack side of the same check-order bug.
//
// Before this fix, `sendPackDenied` read `dryRun` before it read `unsafeValueFlag`.
// A `--dry-run` word right after an abbreviated `send-pack` value flag is really that flag's
// own value word. It is not a dry-run flag.
// The old check order made the guard allow the whole call.
//
// Real git 2.54 confirmed each row below moves `main`.
const DENY_SEND_PACK_UNSAFE_VALUE_FLAG_THEN_DRY_RUN_WORD = [
  'git send-pack --push-o --dry-run ../r.git main',
  'git send-pack --rece --dry-run ../r.git main',
]

test.each(DENY_SEND_PACK_UNSAFE_VALUE_FLAG_THEN_DRY_RUN_WORD)(
  'denyReason denies %j (claude-factory-ctae.12, an unsafe send-pack value flag denies before the dry-run allow)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_REASON)
  },
)

// claude-factory-zs39: git reads every word after the first `--` as an operand, never as a flag.
// The old parsers skipped the `--` word and then read later words as flags. A `-n` after `--` hid
// a real push to `main` as a dry run, and `--repo` or `-o` swallowed the refspec as a value.
// Real git 2.54 confirmed each row below moves `main`.
const ZS39_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }
const DENY_WORDS_AFTER_DOUBLE_DASH = [
  'git push -- origin main -n',
  'git push origin main -- --dry-run',
  'git push -- origin --repo main',
  'git push -- origin -o main',
  'git push -- origin main --all',
  'git send-pack -- ../r.git main -n',
  'git send-pack ../r.git -- main --dry-run',
]

test.each(DENY_WORDS_AFTER_DOUBLE_DASH)(
  'denyReason denies %j (claude-factory-zs39, words after -- are operands)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBe(PUSH_REASON)
  },
)

// Real git 2.54 reads `-n` and `--all` after `--` as ref names that match nothing, so `main` stays.
const ALLOW_WORDS_AFTER_DOUBLE_DASH = [
  'git push -n -- origin main',
  'git push -- origin factory/x',
  'git send-pack -n -- ../r.git main',
  'git push -- origin -n',
  'git push -- origin --all',
]

test.each(ALLOW_WORDS_AFTER_DOUBLE_DASH)(
  'denyReason allows %j (claude-factory-zs39, a real flag before -- or a flag-like ref name stays allowed)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBeUndefined()
  },
)

test('denyReason still denies git push --repo -- origin main (claude-factory-zs39, the value flag eats --)', () => {
  expect(denyReason('git push --repo -- origin main', undefined, undefined, ZS39_GATE)).toBe(PUSH_REASON)
})

// claude-factory-cu5m: the shell expands a dynamic word before git runs. A dynamic word has a
// dollar sign, a backtick, a glob or a brace. It can become `--all`, `--mirror` or `--`.
// The parsers cannot read it. So the guard must deny it. Real git 2.54 confirmed the first 3 rows.
const DENY_DYNAMIC_PUSH_WORD = [
  'R=--all; git push $R origin',
  'git push $R origin',
  'git push "$R" origin',
  'git push --$X origin',
  'git push -$X origin',
  'git push $R feature',
  "git push $'--' origin main -n",
  'git push ${D} origin main -n',
  'git push -$X- origin main -n',
  'git push "$(echo --)" origin main -n',
  'git send-pack $R ../r.git',
  'git send-pack $R ../r.git feature',
  'git push --repo $R feature',
  'git push -o $X origin feature',
  'git push --push-option=$X origin feature',
  'git push -- $R feature',
  'git push `echo --all` origin',
  'git push * origin',
  'git push {--all,} origin',
  'git send-pack --receive-pack $X ../r.git feature',
  'git send-pack ../r.git -$X feature',
  'git-push $R origin',
  'git-send-pack $R ../r.git feature',
  'git -C . push $R origin',
  'git push origin feature --repo=$R',
  'git send-pack `echo --all` ../r.git',
  'git-send-pack `echo --all` ../r.git',
  'git-push `echo --all` origin',
  'git push "`echo --all`" origin',
  'gi\\t push `echo --all` origin',
  "g''it push `echo --all` origin",
  '"gi"t push `echo --all` origin',
  'git pu\\sh `echo --all` origin',
  "git pu''sh `echo --all` origin",
  'git push (-)-all origin',
  'git push (--all|--mirror) origin',
  'touch -- --all; git push (-)-all origin',
  'touch -- --all; git push origin (-)-all',
  'hash -d a=--all; git push ~a origin',
  'git push ~a origin',
  'git push origin ~a',
  'git send-pack ~a ../r.git',
]

// origin/main (hewq) denies every unquoted ANSI-C quote first, with its own reason.
const denyWithPushReason = (cmd: string) => {
  const reason = denyReason(cmd, undefined, undefined, ZS39_GATE)
  if (cmd.includes('$' + "'")) expect(reason).toBeDefined()
  else expect(reason).toBe(PUSH_REASON)
}

test.each(DENY_DYNAMIC_PUSH_WORD)(
  'denyReason denies %j (claude-factory-cu5m, dynamic word)',
  denyWithPushReason,
)

const DENY_DYNAMIC_GLOBAL_WORD = [
  'git -c $Y push origin',
  'git -c "$Y" push origin feature',
  'git -c ${Y} push origin',
  'git -c x$Y=1 push origin',
  'git --config-env=$Y push origin',
  'git --config-env $Y push origin',
  'git -c $Y send-pack ../r.git feature',
  'git -c user.name=$N push origin feature',
]

test.each(DENY_DYNAMIC_GLOBAL_WORD)(
  'denyReason denies %j (claude-factory-cu5m.6, dynamic global word)',
  cmd => {
    // origin/main (p43v) denies a dynamic -c or --config-env key first, with DYNAMIC_VERB_REASON.
    expect([PUSH_REASON, DYNAMIC_VERB_REASON]).toContain(
      denyReason(cmd, undefined, undefined, ZS39_GATE) as string,
    )
  },
)

const DENY_PROCESS_SUBST = [
  'git push origin feature --repo <(:) main',
  'git push origin feature --repo >(:) main',
  'git push origin feature -o <(:) main',
  'git send-pack ../r.git feature --receive-pack <(:) main',
]

test.each(DENY_PROCESS_SUBST)('denyReason denies %j (claude-factory-cu5m.10, process substitution)', cmd => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBe(PUSH_REASON)
})

const DENY_REDIRECT_AMP = ['2>&1', '>&2', '<&0', '1>&-', '>&-', '>|log', '>>|log', '2>|log'].flatMap(op => [
  `git push origin feature ${op} main`,
  `git send-pack ../r.git feature ${op} main`,
])

test.each(DENY_REDIRECT_AMP)('denyReason denies %j (claude-factory-cu5m.12, & or | redirect)', cmd => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBe(PUSH_REASON)
})

const ALLOW_REDIRECT_AMP = [
  'git push origin feature >/dev/null 2>&1',
  'git push -u origin feature 2>&1 | tail -5',
  'git push origin feature &',
  'git push origin feature |& cat',
  'git push origin feature >|log',
  'echo hi >&2 && git push origin feature',
]

test.each(ALLOW_REDIRECT_AMP)('denyReason allows %j (claude-factory-cu5m.12, & or | redirect)', cmd => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBeUndefined()
})

const DENY_REDIRECT_AMP_GT = ['&>/dev/null', '&>>log', '&>|log', '&>!log'].flatMap(op => [
  `git push origin feature ${op} main`,
  `git send-pack ../r.git feature ${op} main`,
])

test.each(DENY_REDIRECT_AMP_GT)('denyReason denies %j (claude-factory-cu5m.13, &> redirect)', cmd => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBe(PUSH_REASON)
})

// claude-factory-abmq: bash joins a backslash-newline inside a redirect operator, so `>BSNL&1` is `>&1`.
// segments() dropped the continuation and then read the `&` or `|` as a segment end.
const DENY_REDIRECT_CONT = [
  '>\\\n&1',
  '>\\\n|log',
  '<\\\n&0',
  '2>\\\n&1',
  '>\\\n\\\n&1',
  '&\\\n>log',
  '&\\\n>>log',
].flatMap(op => [`git push origin feature ${op} main`, `git send-pack ../r.git feature ${op} main`])

test.each(DENY_REDIRECT_CONT)('denyReason denies %j (claude-factory-abmq, continuation in redirect)', cmd => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBe(PUSH_REASON)
})

const ALLOW_REDIRECT_CONT = [
  'git push origin feature 2>&1',
  'git push origin feature >\\\n&1',
  'git send-pack ../r.git feature >\\\n|log',
]

test.each(ALLOW_REDIRECT_CONT)(
  'denyReason allows %j (claude-factory-abmq, continuation in redirect)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBeUndefined()
  },
)

// claude-factory-59pp: bash and zsh read `&>` as one redirect, dash reads a separator. segments()
// returns both readings, so the words after the redirect stay with the command word.
const AMP_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }
const BSNL = '\\\n'

const DENY_AMP_RM = [
  'rm &>/dev/null -rf /',
  'rm &>>f -rf /',
  'rm &>|f -rf /',
  'rm &>!f -rf /',
  'rm&>f -rf /',
  `rm &${BSNL}>f -rf /`,
  `rm &${BSNL}${BSNL}>>f -rf /`,
  'sh -c "rm &>/dev/null -rf /"',
]

test.each(DENY_AMP_RM)('denyReason denies %j (claude-factory-59pp, rm after &>)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_GATE)).toBeDefined()
})

// claude-factory-7xmz: a redirect word before the command word hides rm from realCommand.
const DENY_REDIR_RM = [
  '{a[b[0]]}>f rm -rf /',
  '{a[0][1]}>f rm -rf /',
  '>/dev/null rm -rf /',
  '2>&1 rm -rf /',
  '>&2 rm -rf /',
  '</dev/null rm -rf /',
  '> /dev/null rm -rf /',
  '&>/dev/null rm -rf /',
  '>|f rm -rf /',
  '2>>f rm -rf /',
  '<<<x rm -rf /',
  '>/dev/null rm /etc/passwd',
  '>f rm -r acme',
  'sudo >/dev/null rm -rf /',
  'env >f rm -rf /',
  'nice 2>&1 rm -rf /',
  'nohup >f rm -rf /',
  'timeout 5 >f rm -rf /',
  'command >f rm -rf /',
  'exec 2>&1 rm -rf /',
  'X=1 >f rm -rf /',
  '>f X=1 rm -rf /',
  'sudo -u root >f env >g rm -rf /',
  'find / -exec >/dev/null rm -rf {} \\;',
  'find / -execdir 2>&1 rm -rf {} +',
  '>f find / -exec rm -rf {} \\;',
  'rm >f -r acme',
  'rm 2>&1 -rf acme',
  'cd /x; >f rm -f y',
  '>f cd /x; rm -f y',
  '{x}>f rm -rf /',
  '>&| f rm -rf /',
  '>&! f rm -rf /',
  '>>&| f rm -rf /',
  '>>&! f rm -rf /',
  '>&|f rm -rf /',
  '1>&| f rm -rf /',
  'sudo >&! f rm -rf /',
  'find / -exec >&! f rm -rf {} \\;',
  '>! f rm -rf /',
  '>>| f rm -rf /',
  '{a[0]}>f rm -rf /',
  '{a[x+1]}>f rm -rf /',
  'repeat 1 { 2>/dev/null rm -rf / }',
  'repeat 1 {2>&1 rm -rf / }',
  'repeat 1 { >/dev/null rm -rf / }',
]

test.each(DENY_REDIR_RM)('denyReason denies %j (claude-factory-7xmz, redirect word before rm)', cmd => {
  expect(denyReason(cmd, '/Users/acme/widget')).toBe(REASON)
})

const ALLOW_REDIR_RM = [
  'echo x > out.txt',
  'cat < acme.txt',
  'rm acme.txt 2>/dev/null',
  '>/dev/null rm acme.txt',
  'rm acme',
  "echo '>x' rm -rf /",
  '>/dev/null echo rm -rf /',
  'ls >&2 | wc -l',
  'cmd 2>&1 | grep x',
  'echo x >&2',
  'echo {a,b} {c,d}',
  'echo {a[0]} x',
]

test.each(ALLOW_REDIR_RM)('denyReason allows %j (claude-factory-7xmz, redirect word)', cmd => {
  expect(denyReason(cmd, '/Users/acme/widget')).toBeUndefined()
})

// claude-factory-59pp.10: the live gate sets ghAliases and gitAliases. With them, a redirect word at
// the gh verb slot must not hide the real verb.
const AMP_LIVE_GATE = {
  ...AMP_GATE,
  ghAliases: () => new Map<string, string>(),
  gitAliases: () => new Map<string, string>(),
}

const DENY_AMP_GH_MERGE = [
  'gh &>/dev/null pr merge 1',
  'gh&>/dev/null pr merge 1',
  'gh &>>f pr merge 1',
  'gh &> /dev/null pr merge 1',
  'gh pr &>/dev/null merge 1',
  'gh >/dev/null pr merge 1',
  'gh 2>/dev/null pr merge 1',
  'gh > f pr merge 1',
  'gh repo &>/dev/null sync',
]

test.each(DENY_AMP_GH_MERGE)('denyReason denies %j (claude-factory-59pp.10, gh merge)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(MERGE_REASON)
})

test('denyReason denies gh pr ready after &> (claude-factory-59pp.10)', () => {
  expect(denyReason('gh &>/dev/null pr ready 1', '/root/repo', undefined, AMP_LIVE_GATE)).toBe(READY_REASON)
})

test.each(['gh pr view 1 &>/dev/null', 'gh api x > f', 'gh pr list 2>/dev/null'])(
  'denyReason allows %j with live aliases (claude-factory-59pp.10)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBeUndefined()
  },
)

// claude-factory-59pp.12: here-string, here-doc and read-write redirects have a target word too.
test.each([
  'gh <<< x pr merge 1',
  'gh pr <<< x merge 1',
  'gh <> f pr merge 1',
  'gh pr <> f merge 1',
  'gh << x pr merge 1',
])('denyReason denies %j (claude-factory-59pp.12)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(MERGE_REASON)
})

// claude-factory-g4l4: a redirect word between rm and its -r flag must not hide the recursive rm.
const G4L4_GATE = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  ghAliases: () => new Map<string, string>(),
  gitAliases: () => new Map<string, string>(),
}
test.each([
  'rm 2>o -r src',
  'rm >o -r src',
  'rm 2>&1 -r src',
  'rm <o -r src',
  'rm -f 2>o -r src',
  'sudo -u rm rm 2>o -r src',
  'rm &>o -r src',
  'rm 2> o -r src',
  'rm {x}>o -r src',
  'rm >|o -r src',
  'rm <<<x -r src',
  'rm 2>o 2> p -r src',
  'rm 2> -r src',
  'rm 2>o -R src',
  'rm 2>o --recursive src',
  'rm 2>o -fr src',
  'nice rm 2>o -r src',
  'time -l rm 2>o -r src',
  'find . -exec rm 2>o -r {} \\;',
  'rm 2> -- -r src',
  'rm > -- -r src',
  'rm &> -- -rf src',
  'rm << -- -r src',
  'nice rm 2> -- -r src',
  'find . -exec rm 2> -- -r {} \\;',
])('denyReason denies %j (claude-factory-g4l4)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, G4L4_GATE)).toBe(REASON)
})

test.each([
  'rm 2>o a.txt',
  'ls 2>o -R',
  'rm 2>o -f a.txt',
  'rm 2>o -- -r',
  'find . -exec rm 2>o {} \\;',
  'rm a.txt 2>o',
  'rm 2> -- a.txt',
])('denyReason allows %j (claude-factory-g4l4)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, G4L4_GATE)).toBeUndefined()
})

// claude-factory-59pp.13: segments() strips quotes, so a quoted word like a redirect must not hide the verb.
test("denyReason denies gh --repo '>x' pr merge 1 (claude-factory-59pp.13)", () => {
  expect(denyReason("gh --repo '>x' pr merge 1", '/root/repo', undefined, AMP_LIVE_GATE)).toBe(MERGE_REASON)
})

// claude-factory-zsj0: a flag between `pr` or `repo` and the sub word must not hide the sub word.
test.each([
  'gh pr -R o/r merge 1',
  'gh pr --repo=o/r merge 1',
  'gh pr --repo o/r merge 1',
  'gh pr -Ro/r merge 1',
  'gh pr -R o/r -R o/r merge 1',
  'gh -R o/r pr -R o/r merge 1',
  'gh pr -R o/r >f merge 1',
  'gh pr --bogus x merge 1',
  'gh pr --bogus merge 1',
  'gh repo --bogus x sync',
  'gh repo -R o/r sync',
])('denyReason denies %j with MERGE_REASON (claude-factory-zsj0)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(MERGE_REASON)
})

test.each(['gh pr -R o/r ready 1', 'gh pr --bogus x ready 1'])(
  'denyReason denies %j at implement, allows at release (claude-factory-zsj0)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(READY_REASON)
    expect(denyReason(cmd, '/root/repo', undefined, { ...AMP_LIVE_GATE, station: 'release' })).toBeUndefined()
  },
)

test('denyReason allows gh pr -R o/r ready --undo 1 (claude-factory-zsj0)', () => {
  expect(denyReason('gh pr -R o/r ready --undo 1', '/root/repo', undefined, AMP_LIVE_GATE)).toBeUndefined()
})

test.each(['gh pr -R o/r $X 1', 'gh repo --repo=o/r $X'])(
  'denyReason denies dynamic sub word %j (claude-factory-zsj0)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test.each(['gh pr -R o/r checkout 5 && git push o HEAD', 'gh pr --bogus x checkout 5 && git push o HEAD'])(
  'denyReason denies %j (claude-factory-zsj0)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(PUSH_REASON)
  },
)

test.each([
  'gh pr -R o/r view 1',
  'gh pr --repo=o/r view 1',
  'gh pr -Ro/r view 1',
  'gh pr -R merge view 1',
  'gh pr --repo merge view 1',
  'gh pr -R o/r list',
])('denyReason allows %j (claude-factory-zsj0)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBeUndefined()
})

// claude-factory-59pp.14: git and kubectl take the verb from the same slot.
test.each([
  'git >/dev/null push origin main',
  'git 2>/dev/null push origin main',
  'git <<< x push origin main',
])('denyReason denies %j (claude-factory-59pp.14)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBe(PUSH_REASON)
})

test.each(['git push origin feature >/dev/null', 'git log >f'])(
  'denyReason allows %j (claude-factory-59pp.14)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, AMP_LIVE_GATE)).toBeUndefined()
  },
)

test.each([
  'kubectl >/dev/null apply -f x --context acme',
  'kubectl 2>/dev/null delete pod x --context acme',
])('denyReason denies %j with personOnly acme (claude-factory-59pp.14)', cmd => {
  expect(denyReason(cmd, undefined, ACME)).toBe(LIVE_REASON)
})

const DENY_AMP_XARGS = [
  'xargs &>/dev/null gh pr view 1',
  'xargs&>/dev/null gh pr view 1',
  'xargs -n1 &>>f gh pr view 1',
  'XARGS &>/dev/null gh pr view 1',
  `xargs &${BSNL}>/dev/null gh pr view 1`,
  'xargs &>/dev/null git log',
]

test.each(DENY_AMP_XARGS)('denyReason denies %j (claude-factory-59pp, xargs after &>)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_GATE)).toBe(XARGS_REASON)
})

// This test pins the verdict only. No row separates the dash reading from the joined reading until
// claude-factory-4a4o (a leading redirect word hides rm) is fixed, so the joined-only mutant survives.
test('denyReason denies a command after &> in both readings (claude-factory-59pp)', () => {
  expect(denyReason('true &>/dev/null gh pr merge 1', '/root/repo', undefined, AMP_LIVE_GATE)).toBe(
    MERGE_REASON,
  )
})

const ALLOW_AMP = [
  'sleep 1 & echo hi',
  'a & b',
  'a && b',
  'echo hi &',
  'echo hi & > f',
  'ls &>/dev/null',
  'ls &>/dev/null && echo ok',
  'bun test &>log; echo done',
  'gh pr view 1 &>/dev/null',
  'git log &>/dev/null',
  'echo "a &>b" rm -rf /',
  "echo 'gh &>x pr merge 1'",
]

test.each(ALLOW_AMP)('denyReason allows %j (claude-factory-59pp)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, AMP_GATE)).toBeUndefined()
})

const AMP_SHELL_ROWS = [
  `echo "'git push origin main'" | xargs &>/dev/null sh -c`,
  'xargs&>/dev/null sh -c',
  'xargs &>>f bash -c',
  'XARGS &>/dev/null sh -c',
  'xargs -n1 &>/dev/null sh -c',
  `xargs &${BSNL}>/dev/null sh -c`,
]

test.each(AMP_SHELL_ROWS)(
  'denyReason gives the same verdict with and without &> for %j (claude-factory-59pp)',
  cmd => {
    const bare = cmd.replace(/&(\\\n)*>>?\S*/, '')
    expect(denyReason(cmd, '/root/repo', undefined, AMP_GATE)).toBe(
      denyReason(bare, '/root/repo', undefined, AMP_GATE),
    )
  },
)

// claude-factory-cu5m.14: oracle = git as a shell function that writes its args to a file; zsh 5.9
// and bash run each row. A DENY op is one where the shell passes main to git. The test spawns no shell.
const SHELL_OPERATOR_DENY = [
  '2>&1',
  '>&2',
  '<&0',
  '1>&-',
  '>&-',
  '&>/dev/null',
  '&>>log',
  '&>|log',
  '>|log',
  '>>|log',
  '2>|log',
  '>!log',
  '>>!log',
  '&>!log',
  '>log',
  '> log',
  '>>log',
  '2>log',
  '<log',
  '< log',
  '<>log',
  '<<<x',
  '<(:)',
  '>(:)',
  '=(:)',
  '$(:)',
  '"$(:)"',
  '`:`',
  '{a,b}',
]
const SHELL_OPERATOR_ALLOW = ['|&', '&|', '&!', ';', '&&', '||', '|', '&', '2>&1|cat', '2>&1;']
const SHELL_OPERATOR_SWEEP: [string, boolean][] = [
  ...SHELL_OPERATOR_DENY.map(op => [op, true] as [string, boolean]),
  ...SHELL_OPERATOR_ALLOW.map(op => [op, false] as [string, boolean]),
].flatMap(([op, deny]) => [
  [`git push origin feature ${op} main`, deny] as [string, boolean],
  [`git send-pack ../r.git feature ${op} main`, deny] as [string, boolean],
])

test.each(SHELL_OPERATOR_SWEEP)('denyReason sweep %j denies=%j (claude-factory-cu5m.14)', (cmd, deny) => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBe(deny ? PUSH_REASON : undefined)
})

const ALLOW_DYNAMIC_PUSH_WORD = [
  'git status &>/dev/null',
  'cat <(git log) && git status',
  'diff <(sort a) <(sort b)',
  'git push origin feature 2>&1 | tee >(cat)',
  'git -c core.pager=$P log',
  'git push origin feature',
  'git push -u origin feature',
  'git push origin +feature',
  'git push origin HEAD:refs/heads/feature',
  'git push git@github.com:acme/widget.git feature',
  'git push ~/r.git feature',
  'git push -n origin main',
  'git send-pack ../r.git feature',
  'git push',
  'git push origin feature 2>&1',
  'git push origin feature --force-with-lease',
  'echo `date` && git status',
  'docker push acme/widget:`date +%s`',
  'git push origin feature && (cd /x && ls)',
  '(git push origin feature)',
  'echo "$(git rev-parse HEAD)"',
  'echo $(git push origin feature)',
]

test.each(ALLOW_DYNAMIC_PUSH_WORD)('denyReason allows %j (claude-factory-cu5m, no dynamic word)', cmd => {
  expect(denyReason(cmd, undefined, undefined, ZS39_GATE)).toBeUndefined()
})

// claude-factory-zl5.41: review-r2 found 3 siblings of the zl5.21/zl5.28/zl5.34 config-write
// guard: `remote.*.mirror` (acts like `--mirror` on every later push to that remote),
// `include.path`/`includeIf.*.path` (loads another config file this guard cannot read), and the
// `GIT_CONFIG_*` environment variables (replace git's own config lookup outright). Each row is a
// bare push with no refspec of its own, on a run branch (`feature`).
const DENY_CONFIG_WRITE_SIBLINGS = [
  'git config remote.origin.mirror true',
  'git -c remote.origin.mirror=true push origin',
  'git --config-env=remote.origin.mirror=ENVVAR push origin',
  'git config include.path /x/cfg',
  'git -c include.path=/x/cfg push origin',
  'git config includeIf.onbranch:main.path /x/cfg',
  // each row below sets exactly one GIT_CONFIG_* env name, so each one tests its own branch of
  // DANGEROUS_GIT_CONFIG_ENV on its own: a row with 2 or more names together cannot show that
  // either one, alone, still denies.
  'export GIT_CONFIG_COUNT=1; git push origin',
  'GIT_CONFIG_KEY_0=push.default git push origin',
  'GIT_CONFIG_VALUE_0=matching git push origin',
  'GIT_CONFIG_PARAMETERS="count=1 key0=push.default value0=matching" git push origin',
  'GIT_CONFIG=/x/cfg git push origin',
  'GIT_CONFIG_GLOBAL=/x/cfg git push origin',
  'GIT_CONFIG_SYSTEM=/x/cfg git push origin',
]

test.each(DENY_CONFIG_WRITE_SIBLINGS)(
  'denyReason denies %j (claude-factory-zl5.41, a config-write or GIT_CONFIG_* env sibling)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason allows an unrelated config key and an unrelated env var (claude-factory-zl5.41)', () => {
  expect(denyReason('git config remote.origin.url https://example.test/r.git')).toBeUndefined()
  expect(denyReason('git config user.name "A Name"')).toBeUndefined()
  const gate = { headOf: () => 'feature' }
  expect(denyReason('MY_OWN_VAR=1 git push origin', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('GIT_CONFIG_COUNT=1 echo hi')).toBeUndefined()
})

// claude-factory-zl5.42: review found `env -S`/`env --split-string` hides a merge, a ready, or a
// push: BSD and GNU `env` split the string into words and run it, the same shape of hazard as
// `eval`. Real git 2.54 moved remote `main` for the push row below (`env -S 'git push -q origin
// main'`). Each row below pairs the flag form with the reason the recursed command itself denies.
//
// claude-factory-68gn.13/.14 (review round 3): the push rows use `PUSH_DIR_REASON`, not
// `PUSH_REASON`, since `wordsCarryChdir` (`envChdirPresent`'s own scan) now fails closed on any
// `-S`/`--split-string` word on its own, with no look at what it holds. `gh pr merge`/`gh pr
// ready` never read the current branch, so they deny with the same reason either way.
const DENY_ENV_SPLIT_STRING: Array<[string, string]> = [
  ["env -S 'gh pr merge 5'", 'MERGE_REASON'],
  ["env -S 'gh pr ready 5'", 'READY_REASON'],
  ["env -S 'git push origin main'", 'PUSH_DIR_REASON'],
  // the attached form: no space between -S and the quoted value
  ["env -S'git push origin main'", 'PUSH_DIR_REASON'],
  // a short-flag cluster ahead of S, value as its own word
  //
  // claude-factory-68gn.13/.14 (review round 3): every row below that pushes gets
  // `PUSH_DIR_REASON`, not `PUSH_REASON`.
  // - `wordsCarryChdir` (the scan in `envChdirPresent`) fails closed on any
  //   `-S`/`--split-string` word alone. It does not read what the word holds.
  // - These rows use the fix from `claude-factory-dgf` for `envSplitStringValue`. That scan reads
  //   what the `-S` value holds, so the guard can still recurse into it.
  // - A value flag ahead of `-S` must not hide it.
  ["env -vS 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env --split-string='git push origin main'", 'PUSH_DIR_REASON'],
  // claude-factory-dgf (AC1): a value flag takes its own value word (FOO, /tmp, /usr/bin). That
  // word does not start with `-`. The old scan stopped there and never reached `-S`. The fix must
  // skip past the value word.
  ["env -u FOO -S 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env -C /tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  ["env -P /usr/bin -S 'git push origin main'", 'PUSH_DIR_REASON'],
  // claude-factory-dgf (AC2): the long forms of the same value flags.
  ["env --unset FOO -S 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env --chdir /tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  ["env --argv0 x -S 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env -a x -S 'git push origin main'", 'PUSH_DIR_REASON'],
  // claude-factory-dgf (AC3): a short cluster that ends in a value flag (`-iu FOO`) skips one word.
  ["env -iu FOO -S 'git push origin main'", 'PUSH_DIR_REASON'],
  // claude-factory-dgf (AC4): GNU getopt_long accepts a unique prefix of a long option name.
  ["env --spl 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env --sp='git push origin main'", 'PUSH_DIR_REASON'],
  //
  // claude-factory-dgf.4: a prefix of a long value flag name must also skip the value word.
  // Real GNU env 9.11 runs `--uns FOO -S` and `--ch /tmp -S`.
  ["env --uns FOO -S 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env --ch /tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  //
  // claude-factory-dgf.5: the attached long form (`--unset=FOO`) holds its value in one word.
  // It must not take the next word too. That word is the real `-S`.
  ["env --unset=FOO -S 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env --chdir=/tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  //
  // claude-factory-dgf.6: the attached short form (`-uFOO`) also holds its value in one word.
  // It must not take the next word. That word is the real `-S`.
  ["env -uFOO -S 'git push origin main'", 'PUSH_DIR_REASON'],
  ["env -C/tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  //
  // claude-factory-dgf.7: a bare `-` is not an option word. The scan must pass it and continue.
  // Real macOS `/usr/bin/env - -S 'echo x'` runs the string. BSD `env` reads `-` as an option.
  ["env - -S 'git push origin main'", 'PUSH_DIR_REASON'],
]
const ENV_SPLIT_STRING_REASON: Record<string, string> = {
  MERGE_REASON,
  READY_REASON,
  PUSH_DIR_REASON,
}

test.each(DENY_ENV_SPLIT_STRING)(
  'denyReason denies %j (claude-factory-zl5.42/dgf, env -S/--split-string hides the real command)',
  (cmd, reasonName) => {
    expect(denyReason(cmd)).toBe(ENV_SPLIT_STRING_REASON[reasonName])
  },
)

test('denyReason allows env with no -S/--split-string flag (claude-factory-zl5.42)', () => {
  expect(denyReason('env FOO=1 echo hi')).toBeUndefined()
  expect(denyReason('env -i git status')).toBeUndefined()
})

// claude-factory-s1fj: env -S puts its split words into argv, and env keeps parsing the words
// after the value. So a shell word in the value runs the -c script that follows it.
const DENY_ENV_SPLIT_SHELL: Array<[string, string | undefined]> = [
  ["env -S 'sh' -c 'git push origin main'", undefined],
  ["env -S 'bash' -c 'git push origin main'", undefined],
  ["env -S 'sh' -c 'cd /other/repo && git push origin HEAD'", undefined],
  ["env -S 'zsh' -c 'git push origin main'", undefined],
  ["env -S'sh' -c 'git push origin main'", undefined],
  ["env --split-string=sh -c 'git push origin main'", undefined],
  ["env -S 'sh -x' -c 'git push origin main'", undefined],
  ["env -S 'sh -c' 'git push origin main'", undefined],
  ["env -S '-i sh' -c 'git push origin main'", undefined],
  ["env -u FOO -S 'sh' -c 'git push origin main'", undefined],
  ["env -vS 'sh' -c 'git push origin main'", undefined],
  ["env -S 'sh' -c 'gh pr merge 5'", 'MERGE_REASON'],
  ["env -S 'bash -e' -c 'gh pr merge 5'", 'MERGE_REASON'],
  ["env -S 'git -C /other/repo' push origin HEAD", undefined],
  ["env -S 'eval' 'git push origin main'", undefined],
  ["env -S 'nice sh' -c 'git push origin main'", undefined],
  ["env -S 'env' sh -c 'git push origin main'", undefined],
  ["env -S 'gh pr #x' merge 5", 'MERGE_REASON'],
  ["env -S 'gh pr # c' merge 5", 'MERGE_REASON'],
  ["env -S '-u \"a #\" sh' -c 'git push origin main'", undefined],
  ["env -S \"-u 'a #' sh\" -c 'git push origin main'", undefined],
  ['env -S \'-u "a #" gh pr\' merge 5', 'MERGE_REASON'],
  ["env -S 'FOO= #x sh' -c 'git push origin main'", undefined],
  ["env -S 'FOO= #x gh pr' merge 5", 'MERGE_REASON'],
]
test.each(DENY_ENV_SPLIT_SHELL)(
  'denyReason denies %j (claude-factory-s1fj, env -S shell word runs the later -c script)',
  (cmd, reasonName) => {
    const r = denyReason(cmd)
    expect(r).toBeDefined()
    if (reasonName) expect(r).toBe(ENV_SPLIT_STRING_REASON[reasonName])
  },
)

test.each([
  "env -S 'sh' -c 'echo x'",
  "env -S 'bash -x' -c 'echo x'",
  "env -S 'echo hi' there",
  "env -S 'git status'",
  "env -S 'sh' -c 'echo it'\\''s'",
])('denyReason allows %j (claude-factory-s1fj)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

test('denyReason bounds a long env -S chain that ends in a push (claude-factory-s1fj)', () => {
  const cmd = 'env -S env '.repeat(40) + "-S sh -c 'git push origin main'"
  const t0 = Date.now()
  expect(denyReason(cmd)).toBeDefined()
  expect(Date.now() - t0).toBeLessThan(1000)
}, 30_000)

// claude-factory-vco: GNU env and macOS /usr/bin/env split an env -S value at each \_ and at
// each real newline, quoted or not. denyAt's tokenizer does not split there, so a value such
// as 'git\_push\_origin\_main' stays one word and never matches the push check. Each row below
// holds a backslash or a newline and must deny with ENV_SPLIT_ESCAPE_REASON.
const DENY_ENV_SPLIT_ESCAPE: string[] = [
  // the 3 bead rows (claude-factory-vco)
  "env -S 'git\\_push\\_origin\\_main'",
  "env -S 'git push\\_origin main'",
  "env -S 'gh\\_pr merge 5'",
  // the same value in every flag form -S/--split-string accepts
  "env -S'git\\_push origin main'",
  "env -vS 'git\\_push origin main'",
  "env --split-string='git\\_push origin main'",
  'env -S "git\\_push origin main"',
  "/usr/bin/env -S 'git\\_push origin main'",
  // a real newline inside the value
  "env -S 'git\npush origin main'",
  // another \_ word break, later in the value
  "env -S 'rm\\_-rf\\_/'",
  // a lone trailing backslash, with no character after it before the closing quote
  "env -S 'git push origin main\\'",
]

test.each(DENY_ENV_SPLIT_ESCAPE)(
  'denyReason denies %j (claude-factory-vco, a backslash or newline in an env -S value hides the real command)',
  cmd => {
    expect(denyReason(cmd)).toBe(ENV_SPLIT_ESCAPE_REASON)
  },
)

test('denyReason allows env -S values with no backslash and no newline (claude-factory-vco)', () => {
  expect(denyReason("env -S 'echo hi'")).toBeUndefined()
  expect(denyReason("env -S 'git status'")).toBeUndefined()
  // the gate must not depend on gate or root
  const gate = { headOf: () => 'feature' }
  expect(denyReason("env -S 'git status'", undefined, undefined, gate)).toBeUndefined()
  expect(denyReason("env -S 'git status'", '/some/root')).toBeUndefined()
  expect(denyReason('env FOO=1 echo hi')).toBeUndefined()
  expect(denyReason('env -i git status')).toBeUndefined()
})

// claude-factory-dgf (AC5): these forms must stay allowed. Real `env` stops reading options
// at the first `NAME=VALUE` word. A `-S` after that word is the command itself, not a flag.
// `-u` and `-C` with no later `-S` set up the environment for an unrelated command. `-uS` is
// one cluster whose first character, `u`, takes the rest of the word, `S`, as its own value.
// So this cluster has no separate `-S` flag.
test('denyReason allows env value-flag forms with no real split-string flag (claude-factory-dgf)', () => {
  expect(denyReason("env FOO=1 -S 'git push origin main'")).toBeUndefined()
  expect(denyReason('env -u FOO echo hi')).toBeUndefined()
  expect(denyReason('env -C /tmp git status')).toBeUndefined()
  expect(denyReason("env -uS 'git push origin main'")).toBeUndefined()
})

// claude-factory-z1p: env -S and --split-string change a ${NAME} word into one command word
// when env runs. A row such as `FOO=push env -S 'git ${FOO} origin main'` really pushes. The
// shell prefix assignment sets FOO. Then env turns `${FOO}` into `push`. denyAt reads only the
// typed `${FOO}` text, so it never matches a push or merge check. This guard denies any `$` in
// the value first, before denyAt runs.
const DENY_ENV_SPLIT_VAR = [
  "FOO=push env -S 'git ${FOO} origin main'",
  "FOO=merge env -S 'gh pr ${FOO} 5'",
  // env -i clears the inherited environment; real env still expands ${FOO} to the value a
  // later prefix assignment or the caller's own shell sets, so this still hides a push.
  "env -i -S 'git ${FOO} origin main'",
  // the attached form: no space between -S and the quoted value
  'env -S"git ${FOO} origin main"',
  "env --split-string='git ${FOO} origin main'",
  // a short-flag cluster ahead of S, value as its own word
  "env -vS 'git ${FOO} origin main'",
  // a ${NAME} reference inside a word, not the whole word
  "env -S 'git pu${X} origin main'",
  // a bare dollar sign with no braces: env -S itself fails on this, so denying it costs nothing
  "env -S 'echo $HOME'",
]

test.each(DENY_ENV_SPLIT_VAR)(
  'denyReason denies %j (claude-factory-z1p, env -S with a dollar sign hides the real command)',
  cmd => {
    expect(denyReason(cmd)).toBe(ENV_SPLIT_VAR_REASON)
  },
)

test('denyReason allows env -S/--split-string with no dollar sign (claude-factory-z1p)', () => {
  expect(denyReason("env -S 'echo hi'")).toBeUndefined()
  expect(denyReason('env FOO=bar printenv FOO')).toBeUndefined()
  expect(denyReason('echo ${HOME}')).toBeUndefined()
  expect(denyReason('FOO=1 printenv FOO')).toBeUndefined()
})

// claude-factory-hewq: an unquoted $'...' or $"..." quote is decoded by bash and zsh, and the two
// shells decode it differently. segments() cannot read the real words, so denyAt denies it.
const DENY_DOLLAR_QUOTE = [
  "bash -c $'git push origin main'",
  "sh -c $'git\\x20push origin main'",
  "env -S 'sh' -c $'git\\x20push origin main'",
  'bash -c $"git push origin main"',
  "echo $'it\\'s' ; git push origin main",
  'bash -c "bash -c \\$\'git push origin main\'"',
  // a line continuation between the $ and the quote does not hide it (hewq.4)
  "bash -c $\\\n'git push origin main'",
  "sh -c $\\\n'git\\x20push origin main'",
  "bash -c $\\\n\\\n'git push origin main'",
  "env -S 'sh' -c $\\\n'git\\x20push origin main'",
  'bash -c $\\\n"git push origin main"',
  // accepted over-deny: a harmless escape also denies
  "echo $'a\\tb'",
  "IFS=$'\\n' read -r x",
]

test.each(DENY_DOLLAR_QUOTE)('denyReason denies %j (claude-factory-hewq, $-quote hides words)', cmd => {
  expect(
    denyReason(cmd, '/root/repo', undefined, { headOf: () => 'factory/x', originHead: () => 'main' }),
  ).toBe(DOLLAR_QUOTE_REASON)
})

test('denyReason allows a $ that does not start a $-quote (claude-factory-hewq)', () => {
  const gate = { headOf: () => 'factory/x', originHead: () => 'main' }
  for (const cmd of [
    "echo \\$'x'",
    'echo \'$\'"x"',
    'echo "$\'x\'"',
    'git push origin factory/x',
    "echo $\\\n\\'x\\'",
  ]) {
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBeUndefined()
  }
})

// claude-factory-4i60: a call word can hide a git, sh or rm word in a function body.
// The guard cannot follow the call. It denies every function definition.
const FN_GATE = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
}
const DENY_FUNCTION_DEF = [
  `f() { sh x; }; f -c 'git push origin main'`,
  `f () { sh x; }; f -c 'git push origin main'`,
  `f ( ) { sh x; }; f -c 'git push origin main'`,
  `f(\t) { sh x; }; f -c 'git push origin main'`,
  `f(\\\n) { sh x; }; f -c 'git push origin main'`,
  `f( \\\n \\\n ) { sh x; }; f -c 'git push origin main'`,
  `f\\\n() { sh x; }; f -c 'git push origin main'`,
  `f()\n{ sh x; }\nf -c 'git push origin main'`,
  `f() ( sh x ); f -c 'git push origin main'`,
  `f()(sh x);f -c 'git push origin main'`,
  `f() sh x; f -c 'git push origin main'`,
  `f g () { sh x }; g -c 'git push origin main'`,
  `"f"() { sh x; }; f -c 'git push origin main'`,
  `'f'() { sh x; }; f -c 'git push origin main'`,
  `echo \\$() { sh x; }`,
  `a\\=() { sh x; }; a= -c 'git push origin main'`,
  `\\<() { sh x; }; \\< -c 'git push origin main'`,
  `eval 'f() { sh x; }'; f -c 'git push origin main'`,
  `sh -c 'f() { sh x; }; f -c "git push origin main"'`,
  `bash -c 'f() { sh x; }; f -c "git push origin main"'`,
  `zsh -c 'f() { sh x; }; f -c "git push origin main"'`,
  `echo $(f() { sh x; }; f -c 'git push origin main')`,
  'echo `f() { sh x; }; f -c "git push origin main"`',
  `f() { sh x; }; export -f f; bash -c 'f -c "git push origin main"'`,
  // function keyword (4i60.2)
  `function f { sh x; }; f -c 'git push origin main'`,
  `function f() { sh x; }; f -c 'git push origin main'`,
  `{ function f { sh x; }; }; f -c 'git push origin main'`,
  `if true; then function f { sh x; }; fi; f -c 'git push origin main'`,
  `! function f { sh x; }; f -c 'git push origin main'`,
  `time function f { sh x; }; f -c 'git push origin main'`,
  `time -p function f { sh x; }; f -c 'git push origin main'`,
  `! time function f { sh x; }; f -c 'git push origin main'`,
  `func\\\ntion f { sh x; }; f -c 'git push origin main'`,
  `\\function f { :; }`,
  `while true; do function f { :; }; done`,
  `true || function f { :; }`,
  // each prefix word alone, and a newline inside the pair
  `if false; then :; else function f { :; }; fi`,
  `if false; then :; elif true; then function f { :; }; fi`,
  `if false; then :; elif function f { :; }; then :; fi`,
  `while function f { :; }; do :; done`,
  `until function f { :; }; do :; done`,
  `for x in a; do function f { :; }; done`,
  `time -p function f { :; }`,
  `f(\n) { :; }`,
  `env BASH_FUNC_f%%=$v bash -c f`,
  // function tables and imports (4i60.3)
  `functions[f]='sh x'; f -c 'git push origin main'`,
  `functions+=(f 'sh x'); f -c 'git push origin main'`,
  `set -A functions f 'sh x'; f -c 'git push origin main'`,
  `typeset "functions[f]=sh"`,
  'dis_functions[f]=x',
  `env 'BASH_FUNC_f%%=() { sh x; }' bash -c 'f -c "git push origin main"'`,
  `v='() { sh x; }'; env "BASH_FUNC_f%%=$v" bash -c f`,
  `v='() { sh x; }'; env "$n=$v" bash -c f`,
  // command positions after a later word (4i60.5)
  `repeat 1 function f { sh x }; f -c 'git push origin main'`,
  `repeat 1 { function f { sh x } }; f -c 'git push origin main'`,
  `if [[ 1 ]] { function f { sh x } }; f -c 'git push origin main'`,
  `{ :; } always { function f { sh x } }; f -c 'git push origin main'`,
  `time -- function f { sh x; }; f -c 'git push origin main'`,
  `time -p -- function f { sh x; }; f -c 'git push origin main'`,
  // command position after ]] (4i60.8)
  `if [[ 1 ]] function f { sh x }; f -c 'git push origin main'`,
  `if [[ 0 == 1 ]] { :; } elif [[ 1 ]] function f { sh x }; f -c 'git push origin main'`,
  `while [[ 1 ]] function f { sh x }; f -c 'git push origin main'`,
  `until [[ 1 ]] function f { sh x }; f -c 'git push origin main'`,
  `if [[ 1 ]] \\function f { sh x }; f -c 'git push origin main'`,
  // accepted over-deny: a heredoc write of a function (4i60.6)
  `cat > .scratch/x.sh <<'EOF'\nf() { :; }\nEOF`,
  // accepted over-deny: a bare functions word
  'grep -n functions src/x.ts',
  // moved from ALLOW_DYNAMIC_PUSH_WORD: the guard now denies every definition
  'f() { git push origin feature; }',
  // accepted over-denies: an empty pair is a definition shape
  '(( ))',
  'ls *()',
]

test.each(DENY_FUNCTION_DEF)('denyReason denies %j (claude-factory-4i60, function definition)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, FN_GATE)).toBe(FUNCTION_DEF_REASON)
})

// These rows had another deny reason before 4i60. The more specific reason still wins.
test('denyReason keeps the older reason for definitions with another deny (claude-factory-4i60)', () => {
  const run = (c: string) => denyReason(c, '/root/repo', undefined, FN_GATE)
  expect(run('g() { git "$@"; }; g push origin main')).toBe(DYNAMIC_VERB_REASON)
  expect(run('git-x() { git "$@"; }; git-x push origin main')).toBe(DYNAMIC_VERB_REASON)
  expect(run(`() { sh x } -c 'git push origin main'`)).toBe(PUSH_REASON)
  expect(run(`function { sh x } -c 'git push origin main'`)).toBe(PUSH_REASON)
  // fmeu: the brace group body now reaches the rm check first
  expect(run(`f() { rm "$@"; }; f -rf /tmp/x`)).toBe(REASON)
})

const ALLOW_FUNCTION_DEF_LOOKALIKE = [
  'a=(); echo hi',
  'a+=(); echo hi',
  'x=$(); echo hi',
  'x=$( ); echo hi',
  'x=$\\\n(); echo hi',
  'diff <() >()',
  'cat =()',
  'diff <(sort a) <(sort b)',
  'grep -n function src/x.ts',
  'echo function',
  'git log --grep=function',
  'git commit -m "fix f() { x }"',
  `echo 'f() { sh "$@"; }'`,
  'bash .scratch/x.sh',
  'ls functions.txt',
]

test.each(ALLOW_FUNCTION_DEF_LOOKALIKE)('denyReason allows %j (claude-factory-4i60, no definition)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, FN_GATE)).toBeUndefined()
})

test('denyReason scans a long function-like input fast (claude-factory-4i60)', () => {
  for (const cmd of ['( '.repeat(4000), 'f'.repeat(8000) + '()', 'x=$('.repeat(2000)]) {
    const t = Date.now()
    denyReason(cmd, '/root/repo', undefined, FN_GATE)
    expect(Date.now() - t).toBeLessThan(1000)
  }
})

// claude-factory-zl5.43: a dashed git-core binary name (`git-push`,`git-send-pack`, found on
// PATH or under `git --exec-path`) runs the same code as `git <verb>`, with no `git` word in the
// command line at all. Real git 2.54 moved remote `main` through the plain `git-push` form.
test('denyReason denies dashed git-core binaries (claude-factory-zl5.43)', () => {
  expect(denyReason('git-push origin main')).toBe(PUSH_REASON)
  const gate = { headOf: () => 'feature' }
  expect(denyReason('git-send-pack ../remote.git', undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(denyReason('/nix/store/abc123-git-2.54.0/libexec/git-core/git-push origin main')).toBe(PUSH_REASON)
  // the combo check (claude-factory-zl5.44) must also read a dashed binary as a git word
  expect(denyReason('GIT_CONFIG_GLOBAL=/x/cfg git-push origin', undefined, undefined, gate)).toBe(PUSH_REASON)
})

test('denyReason allows a dashed git-core binary pushing a run branch (claude-factory-zl5.43)', () => {
  expect(denyReason('git-push origin feature')).toBeUndefined()
})

// claude-factory-zl5.44: `hasGitWord` (the combo check paired with a DANGEROUS_GIT_CONFIG_ENV
// name) used to read only one segment's `cmd[0]`, past `realCommand`'s own strip. Real git 2.54
// moved remote `main` for `nice -n 5 git push origin` and `bash -c 'git push origin'`, each with
// `push.default = matching` set through the unreadable config file `GIT_CONFIG_GLOBAL` names.
// Each row pushes the current branch (`feature`, not protected) with no explicit refspec: the
// generic any-position git scan allows that on its own, so only the combo check can deny it, and
// each row isolates the combo check from the unrelated "unresolved current branch" fail-closed
// rule (claude-factory-zl5.12), which would otherwise deny every row on its own.
const DENY_DANGEROUS_ENV_GIT_WORD_SIBLINGS = [
  'GIT_CONFIG_GLOBAL=x nice -n 5 git push origin',
  'GIT_CONFIG_GLOBAL=x command -p git push origin',
  'GIT_CONFIG_GLOBAL=x stdbuf -o0 git push origin',
  "GIT_CONFIG_GLOBAL=x eval 'git push origin'",
  "GIT_CONFIG_GLOBAL=x bash -c 'git push origin'",
  "export GIT_CONFIG_GLOBAL=x; bash -c 'git push origin'",
]

test.each(DENY_DANGEROUS_ENV_GIT_WORD_SIBLINGS)(
  'denyReason denies %j (claude-factory-zl5.44, a dangerous git config env var pairs with a hidden git word)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason allows the same wrappers with no dangerous git config env var (claude-factory-zl5.44)', () => {
  const gate = { headOf: () => 'feature' }
  expect(denyReason('nice -n 5 git push origin', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason("bash -c 'git push origin'", undefined, undefined, gate)).toBeUndefined()
})

// claude-factory-zl5.45: `HOME` and `XDG_CONFIG_HOME` redirect git's global config the same way
// `GIT_CONFIG_GLOBAL` does. `GIT_DIR` and `GIT_COMMON_DIR` point git at a different repository's
// config. Real git 2.54 moved remote `main` for the `HOME=` and `XDG_CONFIG_HOME=` rows, with
// `push.default = matching` set in the config file each variable names.
const DENY_HOME_AND_GIT_DIR_SIBLINGS = ['HOME=d git push origin', 'XDG_CONFIG_HOME=d git push origin']

test.each(DENY_HOME_AND_GIT_DIR_SIBLINGS)(
  'denyReason denies %j (claude-factory-zl5.45, HOME/XDG_CONFIG_HOME redirect git config like GIT_CONFIG_GLOBAL)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

test('denyReason denies GIT_DIR and GIT_COMMON_DIR paired with a git word (claude-factory-zl5.45)', () => {
  const gate = { headOf: () => 'feature' }
  expect(denyReason('GIT_DIR=/other/.git git push origin', undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(denyReason('GIT_COMMON_DIR=/other/.git git push origin', undefined, undefined, gate)).toBe(
    PUSH_REASON,
  )
})

test('denyReason allows HOME set with no git word (claude-factory-zl5.45)', () => {
  expect(denyReason('HOME=d echo hi')).toBeUndefined()
})

// claude-factory-c63: gitReason reads the current branch one time, at scan time, through
// gate.headOf. One command can change the branch. The same command can push HEAD.
//
// The branch changes after the scan. A check against the old branch name does not find the push.
// This guard now denies by default. If one command has a branch-change word and a later push to HEAD, it denies the command.
// The denial uses PUSH_REASON. The guard does not need to know the new branch name.
// claude-factory-bemr.5 (AC11): gitAliases is an explicit stub with no entries. These rows test
// the uncertain-verb path with an unrelated flag, not an alias; an empty table keeps that intent
// while still letting the new uncertain-fallback alias check read a (real, empty) table.
const C63_GATE = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
}

const DENY_BRANCH_CHANGE_THEN_HEAD_PUSH = [
  'git checkout main; git push o HEAD',
  'git branch -M main && git push o HEAD',
  'git branch -m main; git push',
  'git branch --move factory/x main && git push o @',
  'git switch main && git push',
  'git switch -c main && git push -u o HEAD',
  'git symbolic-ref HEAD refs/heads/main; git push o head',
  'git push o HEAD && git checkout main',
  'git -C . checkout main; git push o +HEAD',
  'git-checkout main; git push o HEAD',
  "bash -c 'git checkout main'; git push o HEAD",
  'git checkout main; bash -c "git push o HEAD"',
  'gh pr checkout 5 && git push',
  'git checkout main; git send-pack o HEAD',
  // claude-factory-c63.4: a rebase that names an explicit `<branch>` operand checks it out first.
  'git rebase origin/main main && git push o HEAD',
  'git rebase --onto origin/main x main; git push',
  // claude-factory-c63.5: `git stash branch <name>` makes and checks out a new branch.
  'git stash branch release && git push o HEAD',
  // claude-factory-c63.6: the uncertain-verb path, with an unknown global flag or a nested shell.
  'git --bogus checkout main && git push o HEAD',
  // 2 unknown words push `rebase`/`stash` out of `firstVerbIndex`'s reach, so only the
  // uncertain-verb word scan (not the certain-verb path) can find them.
  'git --bogus value rebase main main && git push o HEAD',
  'git --bogus value stash branch x && git push o HEAD',
  "eval 'git checkout main' && git push o HEAD",
  "env -S 'git checkout main' && git push o HEAD",
  'git symbolic-ref -d HEAD; git push',
  'git branch --mo main; git push',
  'git branch -fM main; git push',
  // claude-factory-c63.7: with `--root`, rebase takes no `<upstream>`, so 1 operand is the
  // explicit `<branch>` and checks it out first.
  'git rebase --root main && git push o HEAD',
  'git rebase -i --root main; git push',
  // claude-factory-c63.8: `git bisect reset <commit>` checks out `<commit>` and ends the bisect.
  'git bisect start HEAD HEAD~1; git bisect reset main; git push o HEAD',
  'git --bogus value bisect reset main && git push o HEAD',
  // claude-factory-c63.9: `git update-ref --stdin` can run a hidden `symref-update HEAD <ref>`
  // line this hook cannot read. The guard denies on the `--stdin` flag alone.
  "printf 'symref-update HEAD refs/heads/main\\n' | git update-ref --stdin && git push o HEAD",
  'git update-ref --stdin < refs.txt; git push o HEAD',
  'git --bogus value update-ref --stdin && git push o HEAD',
  // claude-factory-c63.10: the uncertain-verb word scan also covers `branch` and `update-ref`,
  // and `ghReason`'s uncertain path covers `checkout` for `gh pr checkout`.
  'git --bogus value branch -M main && git push o HEAD',
  'gh --bogus value pr checkout 5 && git push o HEAD',
  // claude-factory-c63.11: git accepts a 3-or-more character abbreviation of a long flag.
  // `--stdi` and `--st` read stdin the same as `--stdin`; `--roo` and `--ro` read `--root`
  // the same way.
  "printf 'symref-update HEAD refs/heads/main\\n' | git update-ref --stdi && git push o HEAD",
  "printf 'symref-update HEAD refs/heads/main\\n' | git update-ref --st && git push o HEAD",
  'git rebase --roo main && git push o HEAD',
  'git rebase --ro main && git push o HEAD',
  // claude-factory-ctae.13: `pushReadsCurrentBranch` now parses `send-pack` with
  // `sendPackOperands`, the same parser `sendPackDenied` uses. The old, separate scan did not
  // clear `dryRun` on `--no-dry-run`, and did not skip a `SEND_PACK_VALUE_FLAGS` value word.
  // Real git 2.54 confirmed each row below moves `main`, on branch `factory/x` after the
  // earlier `git checkout main` moves it.
  'git checkout main; git send-pack -n --no-dry-run o HEAD',
  'git checkout main; git send-pack --dry-run --no-dr o HEAD',
  'git checkout main; git send-pack --remote -n o HEAD',
  // claude-factory-zs39: words after `--` are operands.
  'git checkout main; git push -- o HEAD -n',
  'git checkout main; git send-pack -- o HEAD -n',
]

test.each(DENY_BRANCH_CHANGE_THEN_HEAD_PUSH)(
  'denyReason denies %j (claude-factory-c63: a same-command branch change then a HEAD push fails closed)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, C63_GATE)).toBe(PUSH_REASON)
  },
)

const ALLOW_BRANCH_CHANGE_NO_HEAD_PUSH = [
  'git checkout other && git status',
  'git branch -a && git push o HEAD',
  'git symbolic-ref --short HEAD && git push o HEAD',
  'git checkout main; git push o factory/x',
  'git checkout main; git push o HEAD:factory/x',
  'git checkout main; git push -n o HEAD',
  'git push o HEAD',
  // claude-factory-c63.4: no explicit `<branch>` operand, so rebase keeps the current branch.
  'git rebase origin/main && git push',
  // claude-factory-c63.5: a stash subcommand other than `branch` does not change the branch.
  'git stash pop && git push o HEAD',
  // claude-factory-c63.6: `--merged` is a list flag, not the rename flag `-m`/`-M`/`--move`.
  'git branch --merged && git push o HEAD',
  // claude-factory-c63.7: `--root` with no operand names no `<branch>`, so rebase keeps the
  // current branch checked out.
  'git rebase --root && git push o HEAD',
  // claude-factory-c63.8: `git bisect reset` with no operand returns to the branch bisect
  // started from. It does not name a new one.
  'git bisect reset && git push o HEAD',
  // claude-factory-c63.9: with no `--stdin`, `update-ref` only moves a ref's target commit. It
  // never moves the `HEAD` symref, so the branch does not change.
  'git update-ref HEAD abc123 && git push o HEAD',
  'git update-ref refs/heads/other abc123 && git push o HEAD',
  //
  // claude-factory-c63.11: `--no-root` is not an abbreviation of `--root`. It does not start
  // with `--root`. So rebase still needs 2 operands to name an explicit `<branch>`. 1 operand
  // is not enough.
  'git rebase --no-root main && git push o HEAD',
]

test.each(ALLOW_BRANCH_CHANGE_NO_HEAD_PUSH)(
  'denyReason allows %j (claude-factory-c63: no branch change, or the push names an explicit, unprotected target)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, C63_GATE)).toBeUndefined()
  },
)

// claude-factory-9zd5: a shell redirect or another file tool can write `.git/HEAD` directly.
// The same tool can also write a linked worktree's `.git/worktrees/<name>/HEAD`, the linked
// worktree's own `.git` file, or `.git/config`. None of these paths uses a `git` word.
//
// claude-factory-c63 denies only a `git` verb that changes the branch. It does not read raw file
// writes. So this form reached `main` at d7e9e71 with no check: `printf 'ref: refs/heads/main' > .git/HEAD; git push o HEAD` returned allow (undefined).
//
// This guard now sets `state.gitAdminPath` from three signals.
// R1 matches a segment that names a `.git` path.
// R2 matches a segment that names a `HEAD`-named redirect target or write operand.
// R3 matches a segment with a `--git-dir`, `--absolute-git-dir`, `--git-path` or `--git-common-dir` flag, or a `GIT_DIR` or `GIT_COMMON_DIR` name.
//
// `denyReason` denies with `PUSH_REASON` when `gitAdminPath` and `headPush` are both true, in any order.
// This is the same rule that claude-factory-c63 already applies to a branch-change word.
//
// `GIT_ADMIN_PATH_GATE` uses the same shape as `C63_GATE`.
// Its `headOf` reports an unprotected branch (`factory/x`).
// So a row here denies only through the new `gitAdminPath` rule.
// It never denies through the older, simpler current-branch check.
const GIT_ADMIN_PATH_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }

const DENY_GIT_ADMIN_PATH_THEN_HEAD_PUSH = [
  // D1: the exact probe from the bead.
  "printf 'ref: refs/heads/main' > .git/HEAD; git push o HEAD",
  // D2: a linked worktree's own HEAD file, with the redirect operator run straight into the path
  // (no space), and a bare push (defaults to a HEAD-alias refspec).
  "printf 'ref: refs/heads/main' >.git/worktrees/acme/HEAD && git push",
  // D3: `tee` writes the same path as a plain operand, through a pipe, and the push names `@`.
  'echo x | tee /r/acme/widget/.git/worktrees/w1/HEAD; git push origin @',
  // D4: an uppercase `.GIT` directory name and a lowercase `head` file name (R1/R2 are case-insensitive).
  'cp f .GIT/head; git push o HEAD',
  // D5: the linked-worktree `.git` file itself (a gitlink, not a directory) names no `HEAD` at all.
  "printf 'gitdir: /r/.git/worktrees/other' > .git; git push o HEAD",
  // D7: `git rev-parse --git-dir`/`--absolute-git-dir`/`--git-path HEAD` resolve the real path for
  // the write, inside a quoted command substitution (R3 scans the raw word for the flag name; the
  // first two rows also end in a literal `/HEAD`, so R2 catches them too).
  'printf x > "$(git rev-parse --git-dir)/HEAD"; git push o HEAD',
  'printf x > "$(git rev-parse --absolute-git-dir)/HEAD"; git push o HEAD',
  'printf x > "$(git rev-parse --git-path HEAD)"; git push o HEAD',
  // D8: the `GIT_DIR` environment variable names the same directory.
  'printf x > "$GIT_DIR/HEAD"; git push o HEAD',
  // D9: the write, or the push, runs inside a nested shell, `eval`, or `env -S` script. The shared
  // `ScanState` object carries `gitAdminPath` and `headPush` across the `anyShellReason` recursion.
  'bash -c "printf \'ref: refs/heads/main\' > .git/HEAD"; git push o HEAD',
  'eval "printf \'ref: refs/heads/main\' > .git/HEAD" && git push o HEAD',
  'env -S "printf \'ref: refs/heads/main\' > .git/HEAD" && git push o HEAD',
  "printf 'ref: refs/heads/main' > .git/HEAD; bash -c 'git push o HEAD'",
  // D10: quotes or a backslash split the path; `segments()` already removes them before this scan
  // runs, so the word reads as the plain `.git/HEAD` path.
  'printf x > .g\'i\'t/HE"A"D; git push o HEAD',
  'printf x > .g\\it/HEAD; git push o HEAD',
  // a backslash right before a real newline is a POSIX line continuation inside the word too.
  'printf x > .git/HE\\\nAD; git push o HEAD',
  // D11: a glob in the redirect target can still match `HEAD` (or a `.git`-shaped directory).
  'printf x > .g*/H*; git push o HEAD',
  'printf x > H?AD; git push o HEAD',
  // D12: the push can run before the write; `denyReason` reads the whole command, so order does
  // not matter (AC1).
  "git push o HEAD; printf 'ref: refs/heads/main' > .git/HEAD",
  // D14: `dd`, `mv` and `ln` can place a plain operand named `HEAD`, with no redirect operator at
  // all (R2 also reads a write tool's own operand, not only a shell redirect target).
  'dd of=HEAD if=f; git push',
  'mv f HEAD; git push',
  'ln -sf f HEAD; git push',
  // D15: `git config` can add a `push` alias that redirects a bare push to a protected branch,
  // through a write to `.git/config` with no `git config` verb at all (R1 catches the `.git/config`
  // path; the bare `git push` after it reads `HEAD` by default).
  'printf \'[remote "o"] push = HEAD:refs/heads/main\' >> .git/config; git push',
  //
  // D16 (claude-factory-9zd5.6): a bare redirect operator can stand as its own word, inside a
  // `git` segment. This makes `HEAD` a redirect-form word (`pendingRedirectTarget`). R2 still
  // catches it, even when `isGitOrGhSegment` is true. A redirect target is always a write
  // target, even in the git command's own segment.
  'git show x:y > HEAD; git push o HEAD',
  'git log >> HEAD; git push o HEAD',
]

test.each(DENY_GIT_ADMIN_PATH_THEN_HEAD_PUSH)(
  'denyReason denies %j (claude-factory-9zd5: a same-command .git-path write then a HEAD push fails closed)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, GIT_ADMIN_PATH_GATE)).toBe(PUSH_REASON)
  },
)

// D6: `cd .git` moves into the real git directory. A bare `> HEAD` there writes the real file.
//
// claude-factory-68gn's own cd-tracking rule already denies this command. This guard's new check
// never runs. `cd .git` sets `movedSoFar`. The later push then reads an unknown current branch.
// It denies with `PUSH_DIR_REASON`, not `PUSH_REASON`.
//
// This row still proves the command denies. It does not prove that `gitAdminPath` alone denies
// it. D1-D5 and D7-D15 prove that.
test('denyReason denies the command (claude-factory-9zd5, D6: a cd into .git, then a write and a push, still denies)', () => {
  expect(
    denyReason(
      "cd .git && printf 'ref: refs/heads/main' > HEAD && cd .. && git push o HEAD",
      undefined,
      undefined,
      GIT_ADMIN_PATH_GATE,
    ),
  ).toBe(PUSH_DIR_REASON)
})

// D13: `gate.cwd` names a directory that itself is, or sits inside, a path component ending in
// `.git`. A worker can build the write target from a shell variable (`${x}AD`), with no `.git` or
// `HEAD` text anywhere in the command for R1-R3 to read. This guard still denies, because it reads
// `gate.cwd` itself (R4), not only the command text. The second row has no file write at all: being
// inside a `.git`-named directory is itself the signal.
const GIT_ADMIN_CWD_GATE = { ...GIT_ADMIN_PATH_GATE, cwd: '/r/acme/.git' }

test('denyReason denies the command (claude-factory-9zd5, D13: a HEAD push from a cwd inside a .git-named dir fails closed, even when the write target is built from a shell variable)', () => {
  expect(
    denyReason('x=HE; printf y > ${x}AD; git push o HEAD', undefined, undefined, GIT_ADMIN_CWD_GATE),
  ).toBe(PUSH_REASON)
  expect(denyReason('git push o HEAD', undefined, undefined, GIT_ADMIN_CWD_GATE)).toBe(PUSH_REASON)
})

const ALLOW_GIT_ADMIN_PATH_NO_HEAD_PUSH = [
  // A2: a write to an unrelated file, then a HEAD push, stays allowed.
  'printf x > .scratch/notes.md; git push o HEAD',
  // A3: the write alone, with no push at all, stays allowed.
  "printf 'ref: refs/heads/main' > .git/HEAD",
  // A4: an explicit, unprotected or already-qualified refspec reads no current branch, so
  // `headPush` never becomes true, even next to a `.git/HEAD` write.
  'printf x > .git/HEAD; git push o factory/x',
  'printf x > .git/HEAD; git push o HEAD:refs/heads/factory/x',
  // A5: `.gitignore` and `.github` are not a `.git` name (R1's own lookahead excludes them), and
  // neither is a `HEAD`-named word (R2 needs an exact match, not a substring).
  'cat .gitignore && git push o HEAD',
  'ls .github && git push',
  // A6: a `.git` URL push target is not a `.git` name either (R1's own lookbehind excludes a
  // `.git` suffix with a word character right before it).
  'git push https://github.com/acme/widget.git HEAD',
  // A7: a `HEAD` or `origin/HEAD` word inside a git argv is a normal ref argument, not a write
  // (R2 skips a non-redirect word in a git or gh segment).
  'git log origin/HEAD..HEAD && git push o HEAD',
  'echo "pushing HEAD" && git push',
  // A9: `git rev-parse HEAD` reads `HEAD` as a normal git argument, in its own segment.
  'sha=$(git rev-parse HEAD) && git push o HEAD',
  // A11 (claude-factory-9zd5.5): `origin/HEAD` in a non-git segment (`echo`, not `git` or `gh`)
  // still allows. `REMOTE_TRACKING_HEAD_RE` skips a remote-tracking-ref word on its own, with no
  // help from the `isGitOrGhSegment` skip.
  'echo origin/HEAD && git push o HEAD',
]

test.each(ALLOW_GIT_ADMIN_PATH_NO_HEAD_PUSH)('denyReason allows %j', cmd => {
  expect(denyReason(cmd, undefined, undefined, GIT_ADMIN_PATH_GATE)).toBeUndefined()
})

test('denyReason allows a plain HEAD push alone with a cwd at the worktree root (A1)', () => {
  expect(
    denyReason('git push o HEAD', undefined, undefined, { ...GIT_ADMIN_PATH_GATE, cwd: '/r/acme/widget' }),
  ).toBeUndefined()
})

// A10: splitting the write and the push into 2 separate top-level commands does not help a
// worker bypass this guard. The write alone is allowed (A3). By the time the second command runs,
// the real `HEAD` file already names the new branch, so `gate.headOf` legitimately reads it, and
// the plain claude-factory-zl5.3 current-branch check (not this fix) denies the push. This shows
// the next scan reads the real, moved `HEAD`: `gitAdminPath` does not need to persist across
// separate commands.
test('denyReason allows the write alone, and denies a later, separate HEAD push through the current branch (claude-factory-9zd5, A10)', () => {
  expect(denyReason("printf 'ref: refs/heads/main' > .git/HEAD")).toBeUndefined()
  expect(denyReason('git push o HEAD', undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
})

// claude-factory-ty8y: a write to the global git config (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`,
// `/etc/gitconfig`) has no git verb. It can set `remote.<n>.push`, `push.default` or an alias that
// pushes. Any later git word in the same command then pushes with no check. The guard denies when
// a global-config path word and any git word stand in one command, in any order.
const GLOBAL_GIT_CONFIG_GATE = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  cwd: '/r/acme/widget',
  gitAliases: () => new Map<string, string>(),
}

const DENY_GLOBAL_GIT_CONFIG_WRITE = [
  `printf '[remote "origin"] push = HEAD:refs/heads/main' >> ~/.gitconfig; git push`,
  'printf x > ~/.gitconfig; git push',
  'printf x >> $HOME/.gitconfig && git push origin',
  'printf x >> "${HOME}/.gitconfig"; git push',
  'printf x >> ~acme/.gitconfig; git push',
  'printf x >> "$XDG_CONFIG_HOME/git/config"; git push',
  'printf x >> ~/.config/git/config; git push',
  'printf x >> /etc/gitconfig; git push',
  // each regex alternative alone: a literal git/config path, and a bare XDG_CONFIG_HOME word.
  'printf x >> /home/acme/xdg/git/config; git push',
  'printf x >> $XDG_CONFIG_HOME/${n}; git push',
  'echo x | tee -a ~/.gitconfig; git push',
  "sed -i '' 's/a/b/' ~/.gitconfig; git push",
  'cp f ~/.gitconfig; git push',
  'mv f ~/.config/git/config; git push',
  'ln -sf f ~/.gitconfig; git push',
  'install f ~/.gitconfig; git push',
  'dd of=$HOME/.gitconfig if=f; git push',
  `python3 -c "open('/Users/acme/.gitconfig','a').write('x')"; git push`,
  'printf x >> ~/.git\\\nconfig; git push',
  'bash -c "printf x >> ~/.gitconfig"; git push',
  'cd ~ && printf x >> .gitconfig && cd - && git status',
  'cd ~/.config/git && printf x >> config; cd /r/acme/widget; git status',
  // AC2: order and nesting do not matter.
  'git push; printf x >> ~/.gitconfig',
  "printf x >> ~/.gitconfig; bash -c 'git push'",
  'eval "printf x >> ~/.gitconfig" && git push',
  'env -S "printf x >> ~/.gitconfig" && git push',
  // AC3: any git word denies, not only push.
  `printf '[alias] p = push o HEAD:main' >> ~/.gitconfig; git p`,
  `printf '[include] path = /r/x' >> ~/.gitconfig; git push`,
  'printf x >> ~/.gitconfig; git push origin factory/x',
]

test.each(DENY_GLOBAL_GIT_CONFIG_WRITE)(
  'denyReason denies %j (claude-factory-ty8y: a global git config path then a git word fails closed)',
  cmd => {
    expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
      GLOBAL_GIT_CONFIG_REASON,
    )
  },
)

// ty8y.4: the write alone denies. A worker cannot split the write and the push into 2 Bash calls.
const DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE = [
  `printf '[remote "origin"] push = HEAD:refs/heads/main' >> ~/.gitconfig`,
  'printf x > ~/.gitconfig',
  'printf x >~/.gitconfig',
  'printf x 2>> ~/.gitconfig',
  'printf x >> "$XDG_CONFIG_HOME/git/config"',
  'printf x >> /etc/gitconfig',
  'cat f > ~/.config/git/config',
  'echo x | tee -a ~/.gitconfig',
  "sed -i '' 's/a/b/' ~/.gitconfig",
  'cp f ~/.gitconfig',
  'mv f ~/.config/git/config',
  'ln -sf f ~/.gitconfig',
  'install f ~/.gitconfig',
  'dd of=$HOME/.gitconfig if=f',
  `python3 -c "open('/Users/acme/.gitconfig','a').write('x')"`,
  'bash -c "printf x >> ~/.gitconfig"',
  'printf x >> .gitconfig',
  'git config --list > ~/.gitconfig',
  'git diff --output=~/.gitconfig',
  // ty8y.7: a glob target.
  'printf x >> ~/.gitc*',
  'printf x >> $HOME/.git?onfig',
  'printf x >> "${HOME}/.gitconf[i]g"',
  'cp f ~/.gitc*',
  'tee -a ~/.config/g*/config',
  'printf x >> /etc/gitc*',
]

test.each(DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE)('denyReason denies %j alone (claude-factory-ty8y.4)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(GLOBAL_GIT_CONFIG_REASON)
})

test('denyReason scans a many-star glob fast and denies it (claude-factory-ty8y.24)', () => {
  const cmd = `touch ~/.c${'*'.repeat(24)}x; printf x >> ~/.gitconfig; git push`
  const t = performance.now()
  const r = denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)
  expect(performance.now() - t).toBeLessThan(1000)
  expect(r).toBe(GLOBAL_GIT_CONFIG_REASON)
  const t2 = performance.now()
  expect(denyReason(`tee ~/.c${'*a'.repeat(24)}x`, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
    GLOBAL_GIT_CONFIG_REASON,
  )
  expect(performance.now() - t2).toBeLessThan(1000)
})

// claude-factory-267o: wordNamesHead shares the star collapse and the fail-closed cap.
test('denyReason tests a many-star write target fast (claude-factory-267o)', () => {
  const run = (cmd: string) => {
    const t = performance.now()
    const r = denyReason(cmd, '/r/acme/widget', undefined, GIT_ADMIN_PATH_GATE)
    return { r, ms: performance.now() - t }
  }
  const stars = '*'.repeat(8000)
  const a1 = run(`echo x > H${stars}x; printf x >> ~/.gitconfig; git push`)
  expect(a1.r).toBe(GLOBAL_GIT_CONFIG_REASON)
  expect(a1.ms).toBeLessThan(1000)
  const a2 = run(`echo x > H${stars}x; git push`)
  expect(a2.r).toBeUndefined()
  expect(a2.ms).toBeLessThan(1000)
  const a3 = run(`echo x > H${stars}; git push`)
  expect(a3.r).toBe(PUSH_REASON)
  expect(a3.ms).toBeLessThan(1000)
  const a4 = run(`cat H${'*?'.repeat(4000)}; git push`)
  expect(a4.r).toBe(PUSH_REASON)
  expect(a4.ms).toBeLessThan(1000)
})

test.each([
  ['cat a*b*b*b*b*b; git push', PUSH_REASON],
  ['cat a*b*c*d*e; git push', undefined],
  ['echo x > H*; git push', PUSH_REASON],
  ['echo x > HE?D; git push', PUSH_REASON],
  ['echo x > H[E]AD; git push', PUSH_REASON],
  ['echo x > out*.log', undefined],
  ['echo x > out*.log; git push', undefined],
])('denyReason glob cap row %s (claude-factory-267o)', (cmd, want) => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GIT_ADMIN_PATH_GATE)).toBe(want)
})

// ty8y.9-11: a git segment that writes through its operands, a directory operand, the <> redirect.
const DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R2 = [
  'git --work-tree=$HOME checkout HEAD -- .gitconfig',
  'git --work-tree ~ restore --source=HEAD .gitconfig',
  'GIT_WORK_TREE=~ git checkout HEAD -- .gitconfig',
  'git -C ~ checkout HEAD -- .gitconfig',
  'git clone /r/acme/evil ~/.config/git',
  'git clone /r/acme/evil ~/.config/git/',
  'git diff --output ~/.gitconfig',
  'cp config ~/.config/git/',
  'cp config ~/.config/git',
  'ln -s f ~/.config/git/',
  'mv f $XDG_CONFIG_HOME/git/',
  'printf x 1<>~/.gitconfig',
  'printf x 1<> ~/.gitconfig',
  'printf x <>~/.gitconfig',
  'printf x >| ~/.gitconfig',
  'printf x >|~/.gitconfig',
  'gh release download v1 -O ~/.gitconfig',
]

test.each(DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R2)(
  'denyReason denies %j alone (claude-factory-ty8y r2)',
  cmd => {
    expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
      GLOBAL_GIT_CONFIG_REASON,
    )
  },
)

test.each([
  'bd search gitconfig',
  'bd create "fix ~/.gitconfig guard" -t bug',
  'bun test src/worker-hook.test.ts -t gitconfig',
  'gh pr comment 1 --body "checked ~/.gitconfig"',
  'factory memory add "~/.gitconfig note" "x"',
  'ls ~/.config/git',
])('denyReason allows %j (claude-factory-ty8y r2: text operands)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBeUndefined()
})

// Accepted false positive: the word ~/.config/git has the base name git, and cd names the directory.
test('denyReason denies cd into the global git config directory (claude-factory-ty8y r2)', () => {
  expect(denyReason('cd ~/.config/git', '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
    GLOBAL_GIT_CONFIG_REASON,
  )
})

// ty8y.14-18 (review r3): work trees outside the root, gh clone, the .config directory, dot segments.
const DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R3 = [
  'git --work-tree=/Users/acme checkout HEAD -- .',
  'git --work-tree ~ checkout -f HEAD',
  'GIT_WORK_TREE=~ git checkout -f HEAD',
  'git --work-tree=/etc checkout HEAD -- .',
  'git --work-tree=../x checkout HEAD -- .',
  "git --work-tree=/Users/acme checkout HEAD -- ':(glob)*config'",
  'git --git-dir=/r/acme/widget/.git checkout HEAD -- .gitconfig',
  'GIT_DIR=/r/acme/widget/.git git checkout HEAD -- .gitconfig',
  'gh repo clone acme/evil ~/.config/git',
  'gh gist clone abc ~/.config/git',
  'rsync -a /r/acme/evil/ ~/.config/',
  'cp -R /r/acme/evil ~/.config',
  'mv /r/acme/evil ~/.config',
  'ln -sfn /r/acme/evil ~/.config',
  'tar -C ~/.config -xf x.tar',
  'unzip -d ~/.config x.zip',
  'cp x ~/.config/git/.',
  'cp x ~/.config/git/./',
  'cp x ~/.config/git/./config',
  'cp x ~/.config//git/config',
  'printf x > ~/./.gitconfig',
  'bun test --reporter-outfile=~/.gitconfig',
  'bun test --reporter-outfile ~/.gitconfig',
]

test.each(DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R3)(
  'denyReason denies %j alone (claude-factory-ty8y r3)',
  cmd => {
    expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
      GLOBAL_GIT_CONFIG_REASON,
    )
  },
)

test.each([
  'git --work-tree=. status',
  'git --work-tree=/r/acme/widget/sub status',
  'ls ~/.config',
  'cat ~/.config/git/config',
  'gh pr list --search clone',
])('denyReason allows %j (claude-factory-ty8y r3)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBeUndefined()
})

// ty8y.19-22 (review r4): dot segments under the root, the cwd as work tree, core.worktree, gh --clone.
const DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R4 = [
  'git --work-tree=/r/acme/widget/../.. checkout HEAD -- .',
  'git --work-tree=/r/acme/widget/sub/../../.. checkout -f HEAD',
  'GIT_WORK_TREE=/r/acme/widget/.. git checkout -f HEAD',
  'git -C ~ --git-dir=/r/acme/widget/.git checkout -f HEAD',
  'cd /Users/acme && git --git-dir=/r/acme/widget/.git checkout -f HEAD',
  'pushd ~; git --git-dir=/r/acme/widget/.git checkout -f HEAD',
  'git -C ~ --git-dir /r/acme/widget/.git checkout -f HEAD',
  'cd /Users/acme && GIT_DIR=. git checkout -f HEAD',
  'pushd ~; GIT_DIR=. git checkout -f HEAD',
  'GIT_DIR=. git -C ~ checkout -f HEAD',
  'git config core.worktree /Users/acme',
  'git config --local core.worktree ~',
  'git config --add core.worktree /etc',
  'git config --replace-all core.worktree /x',
  'git config set core.worktree /x',
  'git config --comment x core.worktree /Users/acme',
  'git config --value x core.worktree /Users/acme',
  'git config --co x core.worktree /Users/acme',
  'git config --val x core.worktree /Users/acme',
  'git config -zf x core.worktree /Users/acme',
  'git config -ft core.worktree /Users/acme',
  'git config set --value x core.worktree /Users/acme',
  'git config CORE.WorkTree /x',
  'git -c core.worktree=/x checkout -f HEAD',
  'git -c CORE.WorkTree=. status',
  'gh repo fork acme/evil --clone -- ~/.config/git',
  'gh repo fork acme/evil --clone=true -- ~/.config/git',
]

test.each(DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R4)(
  'denyReason denies %j alone (claude-factory-ty8y r4)',
  cmd => {
    expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
      GLOBAL_GIT_CONFIG_REASON,
    )
  },
)

test.each([
  'git --work-tree=/r/acme/widget/sub status',
  'git --work-tree=. status',
  'git --git-dir=.git log',
  'git -C src status',
  'git -C /r/acme/widget/sub status',
  'git config core.worktree .',
  'git config --get core.worktree',
  'git config core.worktree /r/acme/widget/sub',
  'gh repo fork acme/evil --clone=false',
  'gh issue list --search gitconfig',
])('denyReason allows %j (claude-factory-ty8y r4)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBeUndefined()
})

// ty8y.5: a quoted or escaped git word still counts as a git word.
const DENY_QUOTED_GIT_WORD = [
  'printf x >> ~/.gitconfig; "gi"t push',
  'printf x >> ~/.gitconfig; g\\it push',
  `printf x >> ~/.gitconfig; sh -c '"gi"t push'`,
  `cd ~/.config && "gi"t status`,
]

test.each(DENY_QUOTED_GIT_WORD)('denyReason denies %j (claude-factory-ty8y.5)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(GLOBAL_GIT_CONFIG_REASON)
})

test.each([
  'export GIT_CONFIG_GLOBAL=/r/acme/x; "gi"t push',
  'export GIT_CONFIG_GLOBAL=/r/acme/x; g\\it push',
])('denyReason denies %j (claude-factory-ty8y.5, GIT_CONFIG_GLOBAL rule)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(PUSH_REASON)
})

const ALLOW_GLOBAL_GIT_CONFIG = [
  'cat ~/.gitconfig',
  'cat ~/.gitconfig; git status',
  'git push',
  'git push origin factory/x',
  'git config --global user.name',
  'cat vite.config.ts && git push',
  'cat .gitignore && git push',
  'git push https://github.com/acme/widget.git HEAD',
  'ls ~/.config/gh',
  // ty8y.6: a git or reader segment that only names the path is not a write.
  'git add .config/settings.json',
  'git log -- .config/x',
  'git diff --stat -- docs/gitconfig.md',
  'rg gitconfig src; git status',
  'ls ~/.config/nvim; git status',
  'grep -r gitconfig docs; git status',
  'cp ~/a/*.txt .',
  'printf x >> out.txt',
]

test.each(ALLOW_GLOBAL_GIT_CONFIG)(
  'denyReason allows %j (claude-factory-ty8y: no global git config write)',
  cmd => {
    expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBeUndefined()
  },
)

// claude-factory-93fx: APFS folds case fully, so U+FB01 (fi) and U+00DF (ss) name the same file.
const LIG = 'ﬁ'
const DENY_FOLD = [
  `printf x >> ~/.gitcon${LIG}g`,
  `cp f ~/.gitcon${LIG}g`,
  `cp f /etc/gitcon${LIG}g`,
  `cp f ~/.GITCON${LIG}G`,
  `cp f ~/.con${LIG}g/git/con${LIG}g`,
  `cp f /home/acme/xdg/git/con${LIG}g`,
  `cp f ~/.gitcon${LIG}*`,
  `cd /etc; cp f gitcon${LIG}g`,
  `cd ~/.con${LIG}g; git status`,
  `cd ~/.con${LIG}g/git; printf x >> con${LIG}g`,
]
test.each(DENY_FOLD)('denyReason denies the folded form %j (claude-factory-93fx)', cmd => {
  expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(GLOBAL_GIT_CONFIG_REASON)
})
test.each([`cat ~/.gitcon${LIG}g`, `ls vite.con${LIG}g.ts`, `git status`])(
  'denyReason allows %j (claude-factory-93fx)',
  cmd => {
    expect(denyReason(cmd, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBeUndefined()
  },
)
test('denyReason gives a ligature twin the verdict of its ASCII row (claude-factory-93fx)', () => {
  const rows = [
    ...DENY_GLOBAL_GIT_CONFIG_WRITE,
    ...DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE,
    ...DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R2,
    ...DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R3,
    ...DENY_GLOBAL_GIT_CONFIG_WRITE_ALONE_R4,
    ...ALLOW_GLOBAL_GIT_CONFIG,
  ]
  let n = 0
  for (const row of rows) {
    const twin = row.replace(
      /(?<=[./t])con(fi)g/gi,
      (_m, f) => 'con' + (f === 'fi' ? LIG : LIG.toUpperCase()) + 'g',
    )
    if (twin === row) continue
    n++
    const want = denyReason(row, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)
    expect([twin, denyReason(twin, '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)]).toEqual([
      twin,
      want,
    ])
  }
  expect(n).toBeGreaterThan(20)
})

// A command that is not a reader names the path: it fails closed, also when it reads.
test('denyReason denies a non-reader that names the global git config (claude-factory-ty8y, accepted false positive)', () => {
  expect(denyReason('awk 1 ~/.gitconfig', '/r/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
    GLOBAL_GIT_CONFIG_REASON,
  )
})

// claude-factory-68gn: `gitReason` read the current branch with `gate.headOf(root)`.
// `root` never moves, but an earlier `cd`, `pushd` or `popd` word in one command can move the real
// push to another repository. A `HEAD` alias push (`HEAD`, `@`, or no refspec at all) then reads
// the branch of the wrong repository. If that other checkout was on a protected branch, the push
// reached it without a check.
//
// This guard now treats the current branch as unknown when an earlier `cd`, `pushd` or `popd`
// word appears anywhere in the command. This is the same fail-closed rule that claude-factory-zl5.12
// already uses for an unknown branch. The guard denies with the new `PUSH_DIR_REASON`.
//
// AC1/AC2: every row below denies, whatever `gate.headOf` would say, because the push never reads it.
// AC3, checked separately below, uses a gate that counts calls to prove this.
// `cd`/`pushd`/`popd` count at any word position, for example `builtin cd` or `command cd`, and
// behind any segment separator (`&&`, `;`, `||`). They also count inside the flat segments that
// `segments()` makes of a `( ... )` subshell.
const DENY_PUSH_AFTER_DIR_CHANGE = [
  'cd /other && git push origin HEAD',
  'pushd /other && git push origin HEAD',
  'popd && git push origin HEAD',
  'cd /other; git push origin',
  'cd /other || git push origin HEAD',
  '(cd /other && git push origin HEAD)',
  'builtin cd /other && git push origin HEAD',
  'command cd /other && git push origin HEAD',
  'cd /other && git push origin @',
  'cd /other && git send-pack origin HEAD',
  // claude-factory-68gn.5: zsh's chdir builtin does the same job as cd. zsh is the worker
  // shell on this host. This guard must list chdir too, not only cd, pushd and popd.
  'chdir /other && git push origin HEAD',
  'builtin chdir /other && git push origin HEAD',
]

test.each(DENY_PUSH_AFTER_DIR_CHANGE)(
  'denyReason denies %j: an earlier directory change makes the current branch unknown (claude-factory-68gn, AC1/AC2)',
  cmd => {
    let calls = 0
    // this gate would allow the push if it were ever consulted: 'feature' is not a protected
    // branch. The test still expects a deny, and this also checks the call count (AC3's own
    // dedicated test below checks the same thing for one row, with no other assertion mixed in).
    const gate = {
      headOf: (dir?: string) => {
        calls++
        return 'feature'
      },
    }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
    expect(calls).toBe(0)
  },
)

// AC3: once a `cd`/`pushd`/`popd` word moves the push, `gate.headOf` is never called for it. A
// relative `-C` after the move would resolve against the wrong directory anyway (see the design
// note in the plan: this guard does not try to track the real target directory).
test('denyReason never calls gate.headOf for a HEAD push after an earlier directory change (claude-factory-68gn, AC3)', () => {
  let calls = 0
  const gate = {
    headOf: (dir?: string) => {
      calls++
      return 'feature'
    },
  }
  expect(denyReason('cd /other && git push origin HEAD', '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  expect(calls).toBe(0)
})

// AC4: an explicit, non-protected target names its own branch. It does not need the current
// branch at all, so it still allows after a directory change.
const ALLOW_PUSH_AFTER_DIR_CHANGE_EXPLICIT_BRANCH = [
  'cd /other && git push origin feature',
  'cd /other && git push origin HEAD:feature',
  'cd /other && git push origin HEAD:refs/heads/feature',
  'pushd /other && git push origin feature',
]

test.each(ALLOW_PUSH_AFTER_DIR_CHANGE_EXPLICIT_BRANCH)(
  'denyReason allows %j: an explicit non-protected target names its own branch (claude-factory-68gn, AC4)',
  cmd => {
    expect(denyReason(cmd, '/root/repo')).toBeUndefined()
  },
)

// AC4: an explicit, protected target still denies after a directory change.
const DENY_PUSH_AFTER_DIR_CHANGE_EXPLICIT_PROTECTED = [
  'cd /other && git push origin main',
  'pushd /other && git push origin main',
]

test.each(DENY_PUSH_AFTER_DIR_CHANGE_EXPLICIT_PROTECTED)(
  'denyReason denies %j: an explicit protected target still denies after a directory change (claude-factory-68gn, AC4)',
  cmd => {
    // moved is true here, so gitReason's reason is always PUSH_DIR_REASON (claude-factory-68gn.9:
    // pin the one reason the code returns, so a change of reason shows up as a test failure).
    expect(denyReason(cmd, '/root/repo')).toBe(PUSH_DIR_REASON)
  },
)

// AC5: these verdicts do not change. A `cd` after the push, or in an unrelated command, never
// moves it: `movedSoFar` only accumulates from an earlier segment onward.
test('denyReason keeps its old verdict when cd comes after the push or in an unrelated command (claude-factory-68gn, AC5)', () => {
  const gate = { headOf: () => 'feature' }
  expect(denyReason('git push origin HEAD', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git push origin HEAD; cd /other', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('cd /other && git status')).toBeUndefined()
  expect(denyReason('cd /other && git status', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git -C dir push origin main')).toBe(PUSH_REASON)
})

// AC6: a cd in an outer segment must still deny a HEAD push. The push can run through sh -c,
// bash -c, eval, or env -S. `anyShellReason` reads `movedSoFar` at each recursion site. `denyAt`
// seeds its own `movedSoFar` from the `movedBefore` value it gets.
// The `eval` row quotes its argument (`eval 'git push origin HEAD'`). This makes the one word
// not a bare `git` token. So the row tests `anyShellReason`'s own eval recursion (line ~1897).
// It does not test `anyGitReason`'s flat scan. An unquoted `eval git push origin HEAD` would
// pass that flat scan on its own, with no help from the recursion this AC tests.
const DENY_PUSH_AFTER_DIR_CHANGE_THROUGH_RECURSION = [
  "cd /other && sh -c 'git push origin HEAD'",
  "cd /other && bash -c 'git push origin HEAD'",
  "cd /other && eval 'git push origin HEAD'",
  "cd /other && env -S 'git push origin HEAD'",
]

test.each(DENY_PUSH_AFTER_DIR_CHANGE_THROUGH_RECURSION)(
  'denyReason denies %j: a directory change carries through sh -c/bash -c/eval/env -S recursion (claude-factory-68gn, AC6)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

// AC7: env -C/--chdir and git --git-dir move the push the same way a cd does, even with no cd
// word at all. Each spelling below denies a HEAD push and allows an explicit, non-protected one.
const DENY_PUSH_AFTER_ENV_OR_GIT_DIR_MOVE = [
  'env -C /other git push origin HEAD',
  'env -C/other git push origin HEAD',
  'env --chdir /other git push origin HEAD',
  'env --chdir=/other git push origin HEAD',
  'git --git-dir /other/.git push origin HEAD',
  'git --git-dir=/other/.git push origin HEAD',
  // claude-factory-68gn.6: a value flag before -C or --chdir must not hide it. env -u FOO
  // -C /usr pwd prints /usr: the flag takes the word right after it as its value.
  'env -u FOO -C /other git push origin HEAD',
  'env --unset FOO --chdir /other git push origin HEAD',
  "env -u FOO -C /other sh -c 'git push origin HEAD'",
]

test.each(DENY_PUSH_AFTER_ENV_OR_GIT_DIR_MOVE)(
  'denyReason denies %j: env -C/--chdir and git --git-dir move the push like a cd (claude-factory-68gn, AC7)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

// claude-factory-68gn.7: anyShellReason reads its own env -C/--chdir flag (through
// envChdirPresent) before it recurses into sh -c, bash -c or eval. This differs from the rows
// above: those go through anyGitReason's flat scan, since git follows env directly in the same
// segment. These rows push env -C's own moved flag through anyShellReason's recursion instead.
const DENY_PUSH_AFTER_ENV_CHDIR_THROUGH_RECURSION = [
  "env -C /other sh -c 'git push origin HEAD'",
  "env --chdir=/other bash -c 'git push origin HEAD'",
]

test.each(DENY_PUSH_AFTER_ENV_CHDIR_THROUGH_RECURSION)(
  'denyReason denies %j: env -C/--chdir carries through anyShellReason recursion (claude-factory-68gn, AC7/.7)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

const ALLOW_PUSH_AFTER_ENV_OR_GIT_DIR_MOVE_EXPLICIT_BRANCH = [
  'env -C /other git push origin feature',
  'env --chdir=/other git push origin feature',
  'git --git-dir=/other/.git push origin feature',
]

test.each(ALLOW_PUSH_AFTER_ENV_OR_GIT_DIR_MOVE_EXPLICIT_BRANCH)(
  'denyReason allows %j: an explicit non-protected target names its own branch (claude-factory-68gn, AC7)',
  cmd => {
    expect(denyReason(cmd, '/root/repo')).toBeUndefined()
  },
)

// claude-factory-68gn.10: review round 2 found that an `env -S`/`env --split-string` value is
// itself re-parsed as more `env` flags at run time. A `-C`/`--chdir` hidden inside that value
// moves the child the same way a literal `-C` word would (checked on this host: `env -S '-C
// /usr' pwd` prints `/usr`). `envChdirPresent` skipped the whole value word without reading it,
// so each row below allowed before this fix (58eda29).
const DENY_PUSH_AFTER_ENV_SPLIT_STRING_HIDES_CHDIR = [
  "env -S '-C /other' git push origin HEAD",
  "env --split-string '-C /other' git push origin HEAD",
  "env -S'-C /other' git push origin HEAD",
  "env --split-string='-C /other' git push origin HEAD",
  "env -S '-u FOO -C /other' git push origin HEAD",
]

test.each(DENY_PUSH_AFTER_ENV_SPLIT_STRING_HIDES_CHDIR)(
  'denyReason denies %j: an env -S/--split-string value hides a -C/--chdir (claude-factory-68gn.10)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

test('denyReason allows an env -S/--split-string chdir to an explicit non-protected branch (claude-factory-68gn.10)', () => {
  expect(denyReason("env -S '-C /other' git push origin feature", '/root/repo')).toBeUndefined()
})

// claude-factory-68gn.11: review round 2 found that `-a`/`--argv0` (GNU env's own zeroth-argument
// flag) and a short-flag cluster whose last letter is a value flag (`-iu`, `-va`, `-0u`) were
// both missing from the value-flag scan. Each row below allowed before this fix (58eda29): the
// scan misread the value word right after one of these as `env`'s own command, and stopped
// before it ever reached the `-C`/`--chdir` or `-S`/`--split-string` flag that came after it.
const DENY_PUSH_AFTER_ENV_VALUE_FLAG_HIDES_CHDIR = [
  'env -a x -C /other git push origin HEAD',
  'env --argv0 x --chdir /other git push origin HEAD',
  'env -iu FOO -C /other git push origin HEAD',
  'env -va x -C /other git push origin HEAD',
  'env -0u FOO --chdir=/other git push origin HEAD',
]

test.each(DENY_PUSH_AFTER_ENV_VALUE_FLAG_HIDES_CHDIR)(
  'denyReason denies %j: -a/--argv0 or a clustered value flag hides a -C/--chdir (claude-factory-68gn.11)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

// claude-factory-68gn.11: the same miss, but for envSplitStringValue's own scan: a push straight
// to main, with no cd at all, hidden behind -a/-iu ahead of -S.
//
// claude-factory-68gn.13/.14 (review round 3): these deny with PUSH_DIR_REASON, not PUSH_REASON,
// for the same reason the zl5.42 table above does: wordsCarryChdir now fails closed on any -S
// word on its own.
const DENY_ENV_VALUE_FLAG_HIDES_SPLIT_STRING = [
  "env -a x -S 'git push origin main'",
  "env -iu FOO -S 'git push origin main'",
]

test.each(DENY_ENV_VALUE_FLAG_HIDES_SPLIT_STRING)(
  'denyReason denies %j: -a/--argv0 or a clustered value flag hides -S/--split-string (claude-factory-68gn.11)',
  cmd => {
    expect(denyReason(cmd)).toBe(PUSH_DIR_REASON)
  },
)

test('denyReason allows an env -a/clustered-flag chdir or split-string to an explicit non-protected branch (claude-factory-68gn.11)', () => {
  expect(denyReason('env -a x -C /other git push origin feature', '/root/repo')).toBeUndefined()
  expect(denyReason('env -iu FOO -C /other git push origin feature', '/root/repo')).toBeUndefined()
  expect(denyReason("env -a x -S 'git push origin feature'")).toBeUndefined()
  expect(denyReason("env -iu FOO -S 'git push origin feature'")).toBeUndefined()
})

// claude-factory-68gn.12 (review round 3): GNU getopt_long accepts a unique prefix of a long
// option name. wordsCarryChdir matched only the whole name.
// A prefix hid a -C/--chdir or an -S/--split-string flag.
// This is the same class of gap as claude-factory-68gn.6/.11.
// Checked on this host (GNU coreutils 9.11): env --ch=/usr pwd and env --chd /usr pwd both
// print /usr.
const DENY_PUSH_AFTER_ENV_LONG_FLAG_PREFIX = [
  'env --ch=/other git push origin HEAD',
  'env --chd /other git push origin HEAD',
  'env --u FOO -C /other git push origin HEAD',
  'env --uns FOO -C /other git push origin HEAD',
  'env --arg x -C /other git push origin HEAD',
  "env --spl='-C /other' git push origin HEAD",
]

test.each(DENY_PUSH_AFTER_ENV_LONG_FLAG_PREFIX)(
  'denyReason denies %j: a unique prefix of a long env flag name still carries its hazard (claude-factory-68gn.12)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

test('denyReason allows a prefixed env long flag to an explicit non-protected branch (claude-factory-68gn.12)', () => {
  expect(denyReason('env --ch=/other git push origin feature', '/root/repo')).toBeUndefined()
  expect(denyReason('env --arg x -C /other git push origin feature', '/root/repo')).toBeUndefined()
})

// claude-factory-68gn.13/.14 (review round 3): wordsCarryChdir no longer reads an -S/
// --split-string value at all.
// It fails closed on the flag itself: bare, attached, or ending a short cluster.
// This closes two gaps at once.
//
// - claude-factory-68gn.13: GNU and BSD env -S strip a matching quote pair from each word in
//   the value, before the split. The old scan split on whitespace alone.
//   So a quoted -C inside the value kept its quote marks, as one word, and never matched.
//   Checked on this host: env -S '"-C" /other' pwd and env -S "'-C' /other" pwd both print
//   /other.
// - claude-factory-68gn.14: env also appends the words already on its own command line, after
//   the -S value, to the value's own split words.
//   It reads that whole combined list as one.
//   Checked on this host: env -S '-u' X -C /other pwd prints /other.
//   X becomes -u's value, and -C moves the command.
const DENY_PUSH_AFTER_ENV_SPLIT_STRING_EDGE_CASES = [
  'env -S \'"-C" /other\' git push origin HEAD',
  'env -S "\'-C\' /other" git push origin HEAD',
  "env -S '-u' X -C /other git push origin HEAD",
  "env -S '-u' X --chdir=/other git push origin HEAD",
]

test.each(DENY_PUSH_AFTER_ENV_SPLIT_STRING_EDGE_CASES)(
  'denyReason denies %j: a quoted or combined-argv -S value still fails closed (claude-factory-68gn.13/.14)',
  cmd => {
    const gate = { headOf: () => 'feature' }
    expect(denyReason(cmd, '/root/repo', undefined, gate)).toBe(PUSH_DIR_REASON)
  },
)

// claude-factory-68gn, AC3: no mutation of these two forms trusts gate.headOf once -S is present.
test('denyReason never calls gate.headOf for a push after an env -S of any form (claude-factory-68gn.13/.14, AC3)', () => {
  let calls = 0
  const gate = {
    headOf: () => {
      calls++
      return 'feature'
    },
  }
  expect(denyReason('env -S \'"-C" /other\' git push origin HEAD', '/root/repo', undefined, gate)).toBe(
    PUSH_DIR_REASON,
  )
  expect(calls).toBe(0)
})

// claude-factory-bemr: a pre-existing alias must not hide a guarded verb.
// BEMR_GIT_ALIASES and BEMR_GH_ALIASES copy the real aliases from this bead's triage host.
// That host ran git 2.54.0 and gh 2.98.0.
const BEMR_GIT_ALIASES = new Map([
  ['co', 'checkout'],
  ['br', 'branch'],
  ['st', 'status'],
  ['lg', 'log --oneline --graph'],
  ['wip', '!git stash'],
  ['unwip', '!git stash pop'],
])
const BEMR_GH_ALIASES = new Map([
  ['co', 'pr checkout'],
  ['pv', 'pr view'],
])
//
// claude-factory-bemr: headOf gives a branch name that is not a protected branch.
// This proves each denied case below denies for the right reason.
// The fix must set state.branchChange from the resolved alias.
//
// The test must not pass only because main or master is a protected name on its own.
// originHead gives main, the value the real triage session read.
const BEMR_GATE: HookGate = {
  gitAliases: () => BEMR_GIT_ALIASES,
  ghAliases: () => BEMR_GH_ALIASES,
  headOf: () => 'factory/x',
  originHead: () => 'main',
}

const BEMR_AC1_COMMANDS = [
  'git co main && git push o HEAD',
  'git br -M main && git push o HEAD',
  'gh co 5 && git push',
]

test.each(BEMR_AC1_COMMANDS)(
  'denyReason denies %j: a pre-existing alias that resolves to checkout/branch/pr-checkout must not hide the push (claude-factory-bemr, AC1)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, BEMR_GATE)).toBe(PUSH_REASON)
  },
)

test('denyReason denies "git p origin main": an alias to push denies the same as the literal verb (claude-factory-bemr, AC2)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['p', 'push']]) }
  expect(denyReason('git p origin main', undefined, undefined, gate)).toBe(PUSH_REASON)
})

// claude-factory-bemr.16: "git -C /w p origin main" has a -C word before the non-builtin verb
// p. This guard no longer reads gate.gitAliases at dir /w: it denies ALIAS_USE_REASON outright,
// with no call to gate.gitAliases at all (AC15).
test('denyReason denies "git -C /w p origin main" with ALIAS_USE_REASON, and never calls gate.gitAliases (claude-factory-bemr.16, AC15)', () => {
  let calls = 0
  const gate: HookGate = {
    gitAliases: () => {
      calls++
      return new Map([['p', 'push']])
    },
  }
  expect(denyReason('git -C /w p origin main', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
  expect(calls).toBe(0)
})

test('denyReason denies "git CO main && git push o HEAD": the alias lookup folds the verb to lower case (claude-factory-bemr, AC3)', () => {
  expect(denyReason('git CO main && git push o HEAD', undefined, undefined, BEMR_GATE)).toBe(PUSH_REASON)
})

test('denyReason denies "git x main && git push o HEAD": a chain of two aliases still resolves to checkout (claude-factory-bemr, AC3)', () => {
  const gate: HookGate = {
    gitAliases: () =>
      new Map([
        ['x', 'co'],
        ['co', 'checkout'],
      ]),
    headOf: () => 'factory/x',
  }
  expect(denyReason('git x main && git push o HEAD', undefined, undefined, gate)).toBe(PUSH_REASON)
})

test('denyReason denies "git q origin main": a quoted alias expansion still denies the push to main (claude-factory-bemr, AC4)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['q', 'pu"sh"']]) }
  expect(denyReason('git q origin main', undefined, undefined, gate)).toBe(PUSH_REASON)
})

test('denyReason denies "git q2 origin main" with ALIAS_USE_REASON: an unclosed quote in the alias text fails closed (claude-factory-bemr, AC4)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['q2', 'pu"sh']]) }
  expect(denyReason('git q2 origin main', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "git wip" with ALIAS_USE_REASON: a leading ! shell alias cannot be re-scanned (claude-factory-bemr, AC5)', () => {
  expect(denyReason('git wip', undefined, undefined, BEMR_GATE)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies a git alias chain deeper than MAX_ALIAS_DEPTH with ALIAS_USE_REASON (claude-factory-bemr, AC5)', () => {
  const entries: [string, string][] = Array.from({ length: 20 }, (_, i) => [`b${i}`, `b${i + 1}`])
  const gate: HookGate = { gitAliases: () => new Map(entries) }
  expect(denyReason('git b0 main', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "git zz main" with ALIAS_USE_REASON when gate.gitAliases is unset (claude-factory-bemr, AC5)', () => {
  expect(denyReason('git zz main', undefined, undefined, {})).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "git zz main" with ALIAS_USE_REASON when gate.gitAliases gives undefined (claude-factory-bemr, AC5)', () => {
  const gate: HookGate = { gitAliases: () => undefined }
  expect(denyReason('git zz main', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "cd /other && git co main" with ALIAS_USE_REASON: an earlier cd hides the alias table for that directory (claude-factory-bemr, AC5)', () => {
  expect(denyReason('cd /other && git co main', undefined, undefined, BEMR_GATE)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "git --git-dir=/other co main" with ALIAS_USE_REASON: --git-dir hides the alias table the same way (claude-factory-bemr, AC5)', () => {
  expect(denyReason('git --git-dir=/other co main', undefined, undefined, BEMR_GATE)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "gh zz 5" with ALIAS_USE_REASON when gate.ghAliases is unset (claude-factory-bemr, AC5)', () => {
  expect(denyReason('gh zz 5', undefined, undefined, {})).toBe(ALIAS_USE_REASON)
})

const BEMR_GH_CONFIG_ENV_COMMANDS = [
  'GH_CONFIG_DIR=/x gh co 5',
  'XDG_CONFIG_HOME=/x gh co 5',
  'HOME=/x gh co 5',
]

test.each(BEMR_GH_CONFIG_ENV_COMMANDS)(
  'denyReason denies %j with ALIAS_USE_REASON: a config-dir assignment before a non-builtin gh verb hides the alias table (claude-factory-bemr, AC5)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, BEMR_GATE)).toBe(ALIAS_USE_REASON)
  },
)

// claude-factory-axok: ghReason's own MAX_ALIAS_DEPTH check has no test.
// The git-side chain check (AC5 above) has a matching gh check.
// This test makes sure that no cyclic gh table can hang the hook.
test('denyReason denies a gh alias chain deeper than MAX_ALIAS_DEPTH with ALIAS_USE_REASON (claude-factory-axok)', () => {
  const entries: [string, string][] = Array.from({ length: 20 }, (_, i) => [`b${i}`, `b${i + 1}`])
  const gate: HookGate = { ghAliases: () => new Map(entries) }
  expect(denyReason('gh b0 5', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

// claude-factory-bemr.11: anyGitReason and anyGhReason examine every word of a command.
// They do not examine only the command word.
//
// This finds a git or gh word that another command hides.
// It also finds a git or gh word in a plain argument, such as a grep pattern.
//
// The round-1 review asked for a decision and for test rows.
// This guard keeps the wider examination.
// It denies when it is not sure, so each row here denies.
const BEMR11_NON_COMMAND_GIT_WORD_COMMANDS = [
  'cd docs && grep git README.md',
  'grep -rn git src',
  'grep gh README.md',
]

test.each(BEMR11_NON_COMMAND_GIT_WORD_COMMANDS)(
  'denyReason denies %j with ALIAS_USE_REASON: a git or gh word in an unrelated argument still opens the alias scan (claude-factory-bemr.11)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, {})).toBe(ALIAS_USE_REASON)
  },
)

test('denyReason denies "gh bang" with ALIAS_USE_REASON: a leading ! gh alias cannot be re-scanned (claude-factory-bemr, AC6)', () => {
  const gate: HookGate = { ghAliases: () => new Map([['bang', '!echo hi']]) }
  expect(denyReason('gh bang', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "gh dollar" with ALIAS_USE_REASON: a $ in the gh alias text cannot be re-scanned (claude-factory-bemr, AC6)', () => {
  const gate: HookGate = { ghAliases: () => new Map([['dollar', 'pr list $X']]) }
  expect(denyReason('gh dollar', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "gh zz 5" with ALIAS_USE_REASON when gate.ghAliases gives undefined (claude-factory-bemr, AC6)', () => {
  const gate: HookGate = { ghAliases: () => undefined }
  expect(denyReason('gh zz 5', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies "gh m 5" with MERGE_REASON: the re-scan of a gh alias to pr merge reaches the real merge guard (claude-factory-bemr, AC6)', () => {
  const gate: HookGate = { ghAliases: () => new Map([['m', 'pr merge']]) }
  expect(denyReason('gh m 5', undefined, undefined, gate)).toBe(MERGE_REASON)
})

const BEMR_AC7_ALLOW_COMMANDS = [
  'git co feature',
  'git co feature && git status',
  'git checkout other && git status',
  'git st',
  'git lg',
  'gh pv 5',
  // claude-factory-bemr.16 (AC17): a no-value global flag still allows an alias with no -C word.
  'git --no-pager co feature',
]

test.each(BEMR_AC7_ALLOW_COMMANDS)(
  'denyReason allows %j: an alias to a read-only verb still allows (claude-factory-bemr, AC7)',
  cmd => {
    expect(denyReason(cmd, undefined, undefined, BEMR_GATE)).toBeUndefined()
  },
)

test('denyReason allows "git status" when gate.gitAliases maps status to push: a builtin verb wins over an alias (claude-factory-bemr, AC7)', () => {
  let calls = 0
  const gate: HookGate = {
    gitAliases: () => {
      calls++
      return new Map([['status', 'push']])
    },
  }
  expect(denyReason('git status', undefined, undefined, gate)).toBeUndefined()
  expect(calls).toBe(0)
})

test('denyReason allows "git foo main" when gate.gitAliases resolves but has no foo entry (claude-factory-bemr, AC7)', () => {
  const gate: HookGate = { gitAliases: () => new Map() }
  expect(denyReason('git foo main', undefined, undefined, gate)).toBeUndefined()
})

//
// claude-factory-bemr (AC8): a builtin verb must spawn neither gate.gitAliases nor
// gate.ghAliases. countingGate above wraps only headOf and originHead, so this test uses its
// own small counting gate for the two new fields.
function countingAliasGate() {
  const calls = { gitAliases: 0, ghAliases: 0 }
  const gate: HookGate = {
    gitAliases: () => {
      calls.gitAliases++
      return new Map()
    },
    ghAliases: () => {
      calls.ghAliases++
      return new Map()
    },
  }
  return { gate, calls }
}

test('denyReason calls neither gate.gitAliases nor gate.ghAliases for a builtin verb (claude-factory-bemr, AC8)', () => {
  const { gate, calls } = countingAliasGate()
  expect(denyReason('git push origin x', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git status', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('gh pr view', undefined, undefined, gate)).toBeUndefined()
  expect(calls.gitAliases).toBe(0)
  expect(calls.ghAliases).toBe(0)
})

// claude-factory-bemr.16: gate.gitAliases now takes no dir argument. It always reads the tool
// call's own cwd. memoGate keeps one cached value for the whole denyReason call, the same way
// it already does for gate.ghAliases, so a command with many segments spawns git config at
// most once.
test('denyReason calls gate.gitAliases at most once for one denyReason call, across many segments (claude-factory-bemr.16, AC8)', () => {
  let calls = 0
  const gate: HookGate = {
    gitAliases: () => {
      calls++
      return new Map()
    },
  }
  const command = Array.from({ length: 8 }, (_, i) => `git x${i} main`).join('; ')
  expect(denyReason(command, undefined, undefined, gate)).toBeUndefined()
  expect(calls).toBe(1)
})

// claude-factory-bemr.16 (AC15): a -C word before a non-builtin verb denies ALIAS_USE_REASON
// outright, for every segment, with no call to gate.gitAliases at all. A command with many such
// segments must not need many git config spawns, or any.
test('denyReason denies with ALIAS_USE_REASON and calls gate.gitAliases 0 times for many "-C <dir> <non-builtin verb>" segments (claude-factory-bemr.16, AC15)', () => {
  let calls = 0
  const gate: HookGate = {
    gitAliases: () => {
      calls++
      return new Map()
    },
  }
  const command = Array.from({ length: 9 }, (_, i) => `git -C d${i} x main`).join('; ')
  expect(denyReason(command, undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
  expect(calls).toBe(0)
})

// claude-factory-bemr (AC9): this spawns the real `bun src/worker-hook.ts` binary.
// GIT_CONFIG_GLOBAL points git at one alias file, with co=checkout and st=status.
// GIT_CONFIG_NOSYSTEM=1 blocks any system-wide alias. GH_CONFIG_DIR is an empty directory, so
// gh alias list reads no alias of its own.
test('run as `bun src/worker-hook.ts`, a real git alias co=checkout cannot hide the push guard (claude-factory-bemr, AC9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-bemr-alias-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'factory/x', dir])
  Bun.spawnSync(['git', '-C', dir, 'commit', '-q', '-m', 'init', '--allow-empty'])
  Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const configFile = join(dir, 'gitconfig-bemr')
  writeFileSync(configFile, '[alias]\n\tco = checkout\n\tbr = branch\n\tst = status\n')
  const ghConfigDir = mkdtempSync(join(tmpdir(), 'wh-bemr-gh-config-'))
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  env.GIT_CONFIG_GLOBAL = configFile
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GH_CONFIG_DIR = ghConfigDir
  for (const cmd of [
    'git co main && git push o HEAD',
    'git br -M main && git push o HEAD',
    'gh co 5 && git push',
  ]) {
    const input = JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: cmd } })
    const { out, code } = await run(input, env)
    expect(code).toBe(0)
    expect(JSON.parse(out.trim())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: PUSH_REASON,
      },
    })
  }
  const stInput = JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git st' } })
  expect(await run(stInput, env)).toEqual({ out: '', code: 0 })
}, 20_000)

// claude-factory-bemr.5 (AC12): each flag here is a real git global flag.
// Git 2.54.0 confirms each one takes no value word (`git --no-pager status`, `git -P status`).
// The verb search must step past each flag with no doubt.
// The alias lookup must then run at the real verb slot (`co`), not at the flag's own word.
//
// claude-factory-bemr.10: `--bare` is not in this list. It moves the command, as `--git-dir` does.
// It has its own test below. It does not use the plain PUSH_REASON row that every other flag here uses.
const GIT_NO_VALUE_GLOBAL_FLAGS_FOR_TEST = [
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
  '--no-lazy-fetch',
]

test.each(GIT_NO_VALUE_GLOBAL_FLAGS_FOR_TEST)(
  'denyReason denies "git %s co main && git push o HEAD" (claude-factory-bemr.5, AC12)',
  flag => {
    const gate: HookGate = {
      headOf: () => 'factory/x',
      originHead: () => 'main',
      gitAliases: () => new Map([['co', 'checkout']]),
    }
    expect(denyReason(`git ${flag} co main && git push o HEAD`, undefined, undefined, gate)).toBe(PUSH_REASON)
  },
)

// claude-factory-bemr.10: real git's `--bare` sets GIT_DIR to the current directory.
// So real git reads a different config file.
// A plain search at the same path finds another file.
// When `--bare` is in the command, this guard cannot use an alias table that it reads in the plain way.
// So it denies ALIAS_USE_REASON. It does not resolve `co` through the table and deny PUSH_REASON.
test('denyReason denies "git --bare co main && git push o HEAD" with ALIAS_USE_REASON (claude-factory-bemr.10, AC12)', () => {
  const gate: HookGate = {
    headOf: () => 'factory/x',
    originHead: () => 'main',
    gitAliases: () => new Map([['co', 'checkout']]),
  }
  expect(denyReason('git --bare co main && git push o HEAD', undefined, undefined, gate)).toBe(
    ALIAS_USE_REASON,
  )
})

// claude-factory-bemr.10: `status` is a builtin word.
// The alias-resolution block never runs for a builtin word.
// So `--bare` does not change this verdict, even though it moves the command.
test('denyReason allows "git --bare status" (claude-factory-bemr.10, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['co', 'checkout']]) }
  expect(denyReason('git --bare status', undefined, undefined, gate)).toBeUndefined()
})

// claude-factory-bemr.12: this guard folds `--bare` into one shared `effectiveMoved` value.
// `push` is a builtin word. `gate.headOf` names a branch that is not protected. A plain
// `git push origin HEAD` allows. `--bare` makes the branch read untrusted, so this guard denies
// `PUSH_DIR_REASON` instead.
test('denyReason denies "git --bare push origin HEAD" with PUSH_DIR_REASON (claude-factory-bemr.12)', () => {
  const dirs: (string | undefined)[] = []
  const gate: HookGate = {
    headOf: dir => {
      dirs.push(dir)
      return 'feature'
    },
    originHead: () => 'main',
  }
  expect(denyReason('git push origin HEAD', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git --bare push origin HEAD', undefined, undefined, gate)).toBe(PUSH_DIR_REASON)
  expect(dirs).toEqual([undefined])
})

// claude-factory-bemr.5 (AC12): an unknown flag still leaves the verb search unsure.
// It is not a value flag. It is not a no-value global flag either.
// This guard must not allow that command in silence.
// It scans every non-flag word before a literal `--` instead.
test('denyReason denies ALIAS_USE_REASON when an unknown flag leaves the verb unsure and a later word is a non-builtin alias (claude-factory-bemr.5, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['co', 'checkout']]) }
  expect(denyReason('git --totally-unknown-flag co main', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies ALIAS_USE_REASON when an unknown flag leaves the verb unsure and the alias table cannot be read (claude-factory-bemr.5, AC12)', () => {
  const gate: HookGate = { gitAliases: () => undefined }
  expect(denyReason('git --totally-unknown-flag status', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
})

test('denyReason denies ALIAS_USE_REASON when an unknown flag leaves the verb unsure and an earlier cd already moved the directory (claude-factory-bemr.5, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map() }
  expect(denyReason('cd /tmp && git --totally-unknown-flag status', undefined, undefined, gate)).toBe(
    ALIAS_USE_REASON,
  )
})

// claude-factory-bemr.5 (AC12): an unknown flag can still leave a command allowed.
// The table here is readable and empty.
// Every word after the flag is a builtin word.
// The fallback scan finds nothing that looks like an alias, so it allows the command.
test('denyReason allows "git --totally-unknown-flag status" with a readable empty alias table (claude-factory-bemr.5, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map() }
  expect(denyReason('git --totally-unknown-flag status', undefined, undefined, gate)).toBeUndefined()
})

// claude-factory-bemr.6 (AC13): main() must read the git alias table at i.cwd.
// It must not read the table at CLAUDE_PROJECT_DIR.
// This test spawns the real binary with two repos.
// The first repo stands in for CLAUDE_PROJECT_DIR. It sets no alias.
// The second repo is the Bash tool's cwd. It sets a local alias.p = push.
//
// Before this fix, the hook read the first repo's empty table and found no entry for p.
// The hook then allowed the command.
test("run as `bun src/worker-hook.ts`, a real git alias set only in the tool call's cwd cannot hide the push guard (claude-factory-bemr.6, AC13)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'wh-bemr6-root-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', projectDir])
  const cwdDir = mkdtempSync(join(tmpdir(), 'wh-bemr6-cwd-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', cwdDir])
  Bun.spawnSync(['git', '-C', cwdDir, 'config', 'alias.p', 'push'])
  const ghConfigDir = mkdtempSync(join(tmpdir(), 'wh-bemr6-gh-config-'))
  const env: Record<string, string | undefined> = { ...process.env }
  env.CLAUDE_PROJECT_DIR = projectDir
  env.GIT_CONFIG_NOSYSTEM = '1'
  delete env.GIT_CONFIG_GLOBAL
  env.GH_CONFIG_DIR = ghConfigDir
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: cwdDir,
    tool_input: { command: 'git p origin main' },
  })
  const { out, code } = await run(input, env)
  expect(code).toBe(0)
  expect(JSON.parse(out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
}, 20_000)

// claude-factory-bemr.16 (AC15): a -C word before a non-builtin verb now denies ALIAS_USE_REASON
// outright, even when the dir it names really does hold the alias the old fold would have found.
// This test starts the real binary. cwdDir sets alias.p = push. sub is a plain subdirectory of
// cwdDir, with no .git of its own. The old fold would have read cwdDir's table and found p, and
// denied PUSH_REASON. The new guard never computes that dir at all.
test('run as `bun src/worker-hook.ts`, "git -C sub p origin main" denies ALIAS_USE_REASON (claude-factory-bemr.16, AC15)', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'wh-bemr6-root2-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', projectDir])
  const cwdDir = mkdtempSync(join(tmpdir(), 'wh-bemr6-cwd2-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', cwdDir])
  Bun.spawnSync(['git', '-C', cwdDir, 'config', 'alias.p', 'push'])
  mkdirSync(join(cwdDir, 'sub'))
  const ghConfigDir = mkdtempSync(join(tmpdir(), 'wh-bemr6-gh-config2-'))
  const env: Record<string, string | undefined> = { ...process.env }
  env.CLAUDE_PROJECT_DIR = projectDir
  env.GIT_CONFIG_NOSYSTEM = '1'
  delete env.GIT_CONFIG_GLOBAL
  env.GH_CONFIG_DIR = ghConfigDir
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: cwdDir,
    tool_input: { command: 'git -C sub p origin main' },
  })
  const { out, code } = await run(input, env)
  expect(code).toBe(0)
  expect(JSON.parse(out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: ALIAS_USE_REASON,
    },
  })
}, 20_000)

// claude-factory-bemr.16 (AC15): the plan's own 3 example bypasses from review rounds 1-4 each
// deny ALIAS_USE_REASON, with no call to gate.gitAliases. None of these commands reaches the
// table lookup: each has a -C word before, or anywhere around, the non-builtin verb.
const BEMR16_AC15_COMMANDS = [
  'git -C sub co main && git push o HEAD',
  'git -C a -C b p origin main',
  'git --attr-source -- -C other p origin main',
]

test.each(BEMR16_AC15_COMMANDS)(
  'denyReason denies %j with ALIAS_USE_REASON, and never calls gate.gitAliases (claude-factory-bemr.16, AC15)',
  cmd => {
    let calls = 0
    const gate: HookGate = {
      headOf: () => 'factory/x',
      originHead: () => 'main',
      gitAliases: () => {
        calls++
        return new Map([
          ['co', 'checkout'],
          ['p', 'push'],
        ])
      },
    }
    expect(denyReason(cmd, undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
    expect(calls).toBe(0)
  },
)

// claude-factory-bemr.16 (AC15): this test starts the real binary. cwdDir/a has no alias of its
// own. Only cwdDir/a/b sets alias.p = push. The old fold would have read cwdDir/a/b's table
// through 2 folded -C words and found p, and denied PUSH_REASON. The new guard denies
// ALIAS_USE_REASON outright instead, with no git config spawn for the alias table.
test('run as `bun src/worker-hook.ts`, "git -C a -C b p origin main" denies ALIAS_USE_REASON (claude-factory-bemr.16, AC15)', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'wh-bemr8-root-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', projectDir])
  const cwdDir = mkdtempSync(join(tmpdir(), 'wh-bemr8-cwd-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', cwdDir])
  mkdirSync(join(cwdDir, 'a'))
  const abDir = join(cwdDir, 'a', 'b')
  mkdirSync(abDir)
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', abDir])
  Bun.spawnSync(['git', '-C', abDir, 'config', 'alias.p', 'push'])
  const ghConfigDir = mkdtempSync(join(tmpdir(), 'wh-bemr8-gh-config-'))
  const env: Record<string, string | undefined> = { ...process.env }
  env.CLAUDE_PROJECT_DIR = projectDir
  env.GIT_CONFIG_NOSYSTEM = '1'
  delete env.GIT_CONFIG_GLOBAL
  env.GH_CONFIG_DIR = ghConfigDir
  const input = JSON.stringify({
    tool_name: 'Bash',
    cwd: cwdDir,
    tool_input: { command: 'git -C a -C b p origin main' },
  })
  const { out, code } = await run(input, env)
  expect(code).toBe(0)
  expect(JSON.parse(out.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: ALIAS_USE_REASON,
    },
  })
}, 20_000)

// claude-factory-bemr.16 (AC14): this is the bead's own original repro. A -C word that sits
// after the git verb (`git sw -C main`, where sw is an alias for switch) is not a global flag at
// all: real git's switch reads its own -C as a create-and-switch flag. The old gitGlobalDirFlags
// fold scanned the whole tail, found this post-verb -C, and asked gate.gitAliases for the wrong
// directory ("main"). That directory's table had no sw entry, so the old guard allowed the
// command. The new guard reads gate.gitAliases at the tool call's own cwd only, with no fold, so
// it resolves sw -> switch correctly, sees switch changes the branch, and denies the later push.
test('denyReason denies "git sw -C main && git push origin HEAD" with PUSH_REASON (claude-factory-bemr.16, AC14)', () => {
  const gate: HookGate = {
    headOf: () => 'factory/x',
    originHead: () => 'main',
    gitAliases: () => new Map([['sw', 'switch']]),
  }
  expect(denyReason('git sw -C main && git push origin HEAD', undefined, undefined, gate)).toBe(PUSH_REASON)
})

// claude-factory-bemr.16 (AC14): --exec-path (2-word form, no =) is an unknown flag that takes
// no attached value, so the verb search stays unsure: firstVerbIndex reads the next word, /x, as
// the unsure candidate verb. The uncertain-path -C check then denies outright, with no attempt to
// place the real -C word before or after the real verb (sw).
test('denyReason denies "git --exec-path /x sw -C main && git push origin HEAD" with ALIAS_USE_REASON (claude-factory-bemr.16, AC14)', () => {
  const gate: HookGate = {
    headOf: () => 'factory/x',
    originHead: () => 'main',
    gitAliases: () => new Map([['sw', 'switch']]),
  }
  expect(
    denyReason('git --exec-path /x sw -C main && git push origin HEAD', undefined, undefined, gate),
  ).toBe(ALIAS_USE_REASON)
})

// claude-factory-bemr.16 (AC16): a -C before a builtin verb is not changed by this fix. The
// alias-resolution block never runs for a builtin verb, so these 3 rows keep their old outcomes.
// "status" and "log" are read-only, so they allow. "push" denies PUSH_REASON through gitChdir,
// the separate, already-correct pre-verb -C fold that only the push path uses.
test('denyReason allows "git -C sub status" and "git -C sub log" (claude-factory-bemr.16, AC16)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['co', 'checkout']]) }
  expect(denyReason('git -C sub status', undefined, undefined, gate)).toBeUndefined()
  expect(denyReason('git -C sub log', undefined, undefined, gate)).toBeUndefined()
})

test('denyReason denies "git -C sub push origin factory/x" with PUSH_REASON when factory/x is protected (claude-factory-bemr.16, AC16)', () => {
  const gate: HookGate = {
    protectedBranches: ['factory/x'],
    gitAliases: () => new Map([['co', 'checkout']]),
  }
  expect(denyReason('git -C sub push origin factory/x', undefined, undefined, gate)).toBe(PUSH_REASON)
})

// claude-factory-bemr.16 (AC18): this test starts the real binary, with input.cwd in a second
// repo that sets a local alias.p = push. "git p origin main" has no -C word, so it reaches the
// table lookup at cwd and denies PUSH_REASON. "git -C . p origin main" has a -C word before the
// verb, so it denies ALIAS_USE_REASON outright, with no git config spawn for the alias table.
test('run as `bun src/worker-hook.ts`, AC18: cwd alias denies PUSH_REASON with no -C, ALIAS_USE_REASON with -C . (claude-factory-bemr.16, AC18)', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'wh-bemr16-root-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', projectDir])
  const cwdDir = mkdtempSync(join(tmpdir(), 'wh-bemr16-cwd-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', cwdDir])
  Bun.spawnSync(['git', '-C', cwdDir, 'config', 'alias.p', 'push'])
  const ghConfigDir = mkdtempSync(join(tmpdir(), 'wh-bemr16-gh-config-'))
  const env: Record<string, string | undefined> = { ...process.env }
  env.CLAUDE_PROJECT_DIR = projectDir
  env.GIT_CONFIG_NOSYSTEM = '1'
  delete env.GIT_CONFIG_GLOBAL
  env.GH_CONFIG_DIR = ghConfigDir
  const plainInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: cwdDir,
    tool_input: { command: 'git p origin main' },
  })
  const { out: plainOut, code: plainCode } = await run(plainInput, env)
  expect(plainCode).toBe(0)
  expect(JSON.parse(plainOut.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PUSH_REASON,
    },
  })
  const dotCInput = JSON.stringify({
    tool_name: 'Bash',
    cwd: cwdDir,
    tool_input: { command: 'git -C . p origin main' },
  })
  const { out: dotCOut, code: dotCCode } = await run(dotCInput, env)
  expect(dotCCode).toBe(0)
  expect(JSON.parse(dotCOut.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: ALIAS_USE_REASON,
    },
  })
}, 20_000)

// claude-factory-bemr.9 (AC12): --attr-source takes one value word, even a literal --.
// This flag must not leave the verb search unsure. It must step past the value word.
// It must then place the alias lookup at the real verb (`p`).
test('denyReason denies "git --attr-source -- p origin main" with PUSH_REASON (claude-factory-bemr.9, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['p', 'push']]) }
  expect(denyReason('git --attr-source -- p origin main', undefined, undefined, gate)).toBe(PUSH_REASON)
})

// claude-factory-bemr.9 (AC12): --config-env also takes one value word.
// This is true for its 2-word form, which has no attached =.
test('denyReason denies "git --config-env x p origin main" with PUSH_REASON (claude-factory-bemr.9, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['p', 'push']]) }
  expect(denyReason('git --config-env x p origin main', undefined, undefined, gate)).toBe(PUSH_REASON)
})

// claude-factory-bemr.9 (AC12): the uncertain-path fallback scan must not stop at a literal --.
// An unrecognized flag can still leave the verb search unsure.
// This happens even when this guard handles --attr-source.
// So this guard scans the whole tail, including a word after --.
test('denyReason denies ALIAS_USE_REASON when an unknown flag before -- leaves the verb unsure and a later word, after --, is a non-builtin alias (claude-factory-bemr.9, AC12)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['p', 'push']]) }
  expect(denyReason('git --totally-unknown-flag -- p origin main', undefined, undefined, gate)).toBe(
    ALIAS_USE_REASON,
  )
})

// claude-factory-bemr.14 / bemr.16: `--attr-source` (a sibling of `--config-env`, both in
// GIT_VALUE_FLAGS) can read a literal `--` as its own value word. A scan for the real verb must
// not stop at that `--`: real git 2.54 still reads a flag right after it.
//
// bemr.16: this row is one of the plan's own AC15 examples (BEMR16_AC15_COMMANDS above). It
// stays here too, to keep the --attr-source nuance documented next to the --git-dir row below.
test('denyReason denies "git --attr-source -- -C OTHER p origin main" with ALIAS_USE_REASON, and never calls gate.gitAliases (claude-factory-bemr.14, bemr.16)', () => {
  let calls = 0
  const gate: HookGate = {
    gitAliases: () => {
      calls++
      return new Map([['p', 'push']])
    },
  }
  expect(denyReason('git --attr-source -- -C OTHER p origin main', undefined, undefined, gate)).toBe(
    ALIAS_USE_REASON,
  )
  expect(calls).toBe(0)
})

// claude-factory-bemr.14: this row proves the --git-dir check. Without --attr-source, "git
// --git-dir OTHER/.git p origin main" already denies ALIAS_USE_REASON: a --git-dir flag makes
// the alias table unknown (claude-factory-68gn), the same as an earlier cd.
test('denyReason denies "git --attr-source -- --git-dir OTHER/.git p origin main" with ALIAS_USE_REASON (claude-factory-bemr.14)', () => {
  const gate: HookGate = { gitAliases: () => new Map([['p', 'push']]) }
  expect(
    denyReason('git --attr-source -- --git-dir OTHER/.git p origin main', undefined, undefined, gate),
  ).toBe(ALIAS_USE_REASON)
})

// claude-factory-bemr.14: `gitDashCPushDenied` has the same `--` hazard. These two rows prove it
// for the `-c name=value` form and the attached `--config-env=name=value` form.
test('denyReason denies "git --attr-source -- -c alias.p=push p origin main" with PUSH_REASON (claude-factory-bemr.14)', () => {
  expect(denyReason('git --attr-source -- -c alias.p=push p origin main')).toBe(PUSH_REASON)
})

test('denyReason denies "git --attr-source -- --config-env=alias.p=E p origin main" with PUSH_REASON (claude-factory-bemr.14)', () => {
  expect(denyReason('git --attr-source -- --config-env=alias.p=E p origin main')).toBe(PUSH_REASON)
})

// claude-factory-bemr.14 / bemr.16: `--attr-source` also reads a word that looks like `-C` as
// its own value word, not as a real -C flag. That consumed word still appears literally in
// `tail.slice(0, vi)`. The guard denies on the literal word, with no attempt to tell a consumed
// value apart from a real flag (bemr.16's narrower, conservative rule). It calls gate.gitAliases
// 0 times.
test('denyReason denies "git --attr-source -C sub" with ALIAS_USE_REASON, and never calls gate.gitAliases (claude-factory-bemr.14, bemr.16)', () => {
  let calls = 0
  const gate: HookGate = {
    gitAliases: () => {
      calls++
      return new Map([['sub', 'status']])
    },
  }
  expect(denyReason('git --attr-source -C sub', undefined, undefined, gate)).toBe(ALIAS_USE_REASON)
  expect(calls).toBe(0)
})

// claude-factory-bemr.7: these tests check worker-hook.ts's own exported GIT_BUILTIN_VERBS and
// GH_BUILTIN_VERBS sets, not a copy. An edit to either shipped set now reaches this test.
//
// Each test checks every name against the host's real git or gh. git or gh can be absent on
// some hosts. The test then skips.

test('every GIT_BUILTIN_VERBS name is a real git builtin (claude-factory-bemr.7, AC10)', () => {
  let real: Set<string>
  try {
    const p = Bun.spawnSync(['git', '--list-cmds=builtins'])
    if (p.exitCode !== 0) return
    real = new Set(p.stdout.toString().split(/\s+/).filter(Boolean))
  } catch {
    return
  }
  for (const name of GIT_BUILTIN_VERBS) {
    expect(real.has(name)).toBe(true)
  }
})

// claude-factory-bemr.7: `gh help`'s own command-list lines each start with two spaces, the
// command name, then a colon (for example `  org:           Manage organizations`). The old
// check used `helpText.includes(name)`, a plain substring test. That test passed `org` for the
// wrong reason: `org` sits inside the word `organizations` in that same line, not because `org`
// is its own listed command. `listedNames` holds only a whole name taken from the start of such
// a line, from every section (CORE COMMANDS, GITHUB ACTIONS COMMANDS, ALIAS COMMANDS, ADDITIONAL
// COMMANDS, HELP TOPICS).
//
// `gh help` and `gh version` run as real commands, but gh's own top-level listing never prints
// either one as a `name:` line: it prints them only as the `--help` and `--version` flags, in
// the FLAGS section. `flagNames` holds a name taken the same way from that section, with its
// leading `--` removed, so `help` and `version` can still match there.
test("every GH_BUILTIN_VERBS name is a real gh command, and not one of this host's own gh aliases (claude-factory-bemr.7, AC10)", () => {
  let helpText: string
  try {
    const p = Bun.spawnSync(['gh', 'help'])
    if (p.exitCode !== 0) return
    helpText = p.stdout.toString()
  } catch {
    return
  }
  const aliasSection = helpText
    .split(/\n(?=[A-Z][A-Z ]+\n)/)
    .find(block => block.startsWith('ALIAS COMMANDS'))
  const aliasNames = new Set(
    (aliasSection ?? '')
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/)[0])
      .filter(Boolean)
      .map(w => w!.replace(/:$/, '')),
  )
  const listedNames = new Set(Array.from(helpText.matchAll(/^ {2}([a-z][a-z-]*):/gm)).map(m => m[1]!))
  const flagsSection = helpText.split(/\n(?=[A-Z][A-Z ]+\n)/).find(block => block.startsWith('FLAGS'))
  const flagNames = new Set(
    Array.from((flagsSection ?? '').matchAll(/^ {2}--([a-z][a-z-]*)/gm)).map(m => m[1]!),
  )
  for (const name of GH_BUILTIN_VERBS) {
    expect(aliasNames.has(name)).toBe(false)
    expect(listedNames.has(name) || flagNames.has(name)).toBe(true)
  }
})

// claude-factory-dts: a counting fake gate. It wraps each real git-reading function the test
// gives it, and counts each real call. It never counts a call memoGate skips (a cache hit, or a
// headOf call past MAX_HEAD_DIRS).
function countingGate(real: {
  headOf?: (dir?: string) => string | undefined
  originHead?: () => string | undefined
}) {
  const calls = { headOf: 0, originHead: 0 }
  const gate: HookGate = {}
  if (real.headOf) {
    const fn = real.headOf
    gate.headOf = dir => {
      calls.headOf++
      return fn(dir)
    }
  }
  if (real.originHead) {
    const fn = real.originHead
    gate.originHead = () => {
      calls.originHead++
      return fn()
    }
  }
  return { gate, calls }
}

// claude-factory-dts (AC1, AC2): before the fix, gitReason called gate.headOf(dir) once per push
// segment, and protectedBranchSet called gate.originHead() once per push segment (inside
// gitPushDenied). A command with 583 'git push o b;' segments plus a trailing protected push
// made 584 calls of each, pre-fix. The memo now makes one real call of each, for the whole
// denyReason call.
test('denyReason calls gate.originHead and gate.headOf at most once each across 583 push segments (claude-factory-dts, AC1/AC2)', () => {
  const { gate, calls } = countingGate({ headOf: () => 'feature', originHead: () => 'main' })
  const command = 'git push o b; '.repeat(583) + 'git push origin main'
  expect(denyReason(command, undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(calls.originHead).toBe(1)
  expect(calls.headOf).toBe(1)
})

// claude-factory-dts (AC3): headOf keeps one cached result for each distinct dir, up to
// MAX_HEAD_DIRS = 8. Here, 20 segments name 20 distinct dirs, and none push HEAD, so the
// verdict does not depend on headOf's result. The call count still stays at or under 8.
test('denyReason calls gate.headOf for at most 8 distinct dirs, out of 20 (claude-factory-dts, AC3)', () => {
  const { gate, calls } = countingGate({ headOf: dir => `branch-of-${dir}`, originHead: () => 'main' })
  const command = Array.from({ length: 20 }, (_, i) => `git -C d${i} push o b`).join('; ')
  expect(denyReason(command, undefined, undefined, gate)).toBeUndefined()
  expect(calls.headOf).toBeLessThanOrEqual(8)
})

// claude-factory-dts (AC3): the first 8 segments each name a new distinct dir (d1..d8), so they
// fill the memo's cache. The 9th segment names a 9th distinct dir (d9) and pushes HEAD. Past
// MAX_HEAD_DIRS, headOf(d9) returns undefined with no real call: the current branch there is
// unknown, so the push fails closed (denies), the same rule an unresolvable headOf already used
// before this memo existed (claude-factory-zl5.12).
test('denyReason fails closed on a 9th distinct dir past MAX_HEAD_DIRS=8 (claude-factory-dts, AC3)', () => {
  const { gate, calls } = countingGate({ headOf: dir => `branch-of-${dir}` })
  const eightDirs = Array.from({ length: 8 }, (_, i) => `git -C d${i + 1} push o b`).join('; ')
  const command = `${eightDirs}; git -C d9 push o HEAD`
  expect(denyReason(command, undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(calls.headOf).toBe(8)
})

// claude-factory-dts (AC4): the memo must cache an unresolved (undefined) gate.originHead result
// too, and keep giving that same unresolved answer on every later call within one denyReason
// call. An unresolved origin/HEAD denies every branch-targeting push (claude-factory-zl5.13), so
// the first of 2 push segments already denies; the memo still makes only 1 real call.
test('denyReason caches an undefined gate.originHead result, and still denies every push (claude-factory-dts, AC4)', () => {
  const { gate, calls } = countingGate({ originHead: () => undefined })
  expect(denyReason('git push o b; git push o b', undefined, undefined, gate)).toBe(PUSH_REASON)
  expect(calls.originHead).toBe(1)
})

// claude-factory-dts (AC4): a rig that wires no gate.originHead and no gate.headOf at all must
// keep today's behavior: no origin/HEAD check at all, and no fail-closed current-branch check
// for a non-HEAD push. memoGate must leave an unset field unset, not call a function that is not
// there.
test('denyReason with no gate.headOf or gate.originHead at all keeps allowing an unprotected push (claude-factory-dts, AC4)', () => {
  expect(denyReason('git push origin develop', undefined, undefined, {})).toBeUndefined()
})

// claude-factory-dts (AC4): one memo, built once at the denyReason entry, must cover every
// recursion level anyShellReason takes through `sh -c` or `eval`, not only the top-level scan.
// The inner `sh -c` script holds 2 push segments of its own; the outer command holds a 3rd. All
// 3 read the current branch and origin/HEAD through the same memo, so each real function still
// runs once, even though the scan recurses one level deeper to reach 2 of the 3 segments.
test('denyReason shares one memo across an sh -c recursion level (claude-factory-dts, AC4)', () => {
  const { gate, calls } = countingGate({ headOf: () => 'feature', originHead: () => 'main' })
  const command = `sh -c 'git push o b; git push o b'; git push o b`
  expect(denyReason(command, undefined, undefined, gate)).toBeUndefined()
  expect(calls.headOf).toBe(1)
  expect(calls.originHead).toBe(1)
})

// claude-factory-dts.4: MAX_HEAD_DIRS limits the spawn count. It does not limit the spawn time.
// A slow git command can use its full timeout on each spawn.
// Up to 8 headOf dirs plus 1 originHead spawn can add up to 9 full timeouts.
// That is more than the hook's own 10 s PreToolUse timeout.
// A shared deadline (GATE_BUDGET_MS = 6000 ms) limits the total spawn time too.
//
// This test uses a fake clock. It does not use a sleep.
// The fake headOf moves the clock forward by 5500 ms on each call.
// This is a spawn of 5500 ms.
// `spyOn(Date, 'now')` makes memoGate read the fake clock. It does not change memoGate.
test('denyReason stops spawning headOf once the shared gate budget runs out, before MAX_HEAD_DIRS, and still denies the trailing push (claude-factory-dts.4)', () => {
  let fakeNow = 0
  const dateSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow)
  try {
    let headOfCalls = 0
    const seenTimeouts: (number | undefined)[] = []
    const gate: HookGate = {
      headOf: (dir, timeoutMs) => {
        headOfCalls++
        seenTimeouts.push(timeoutMs)
        fakeNow += 5500
        return `branch-of-${dir}`
      },
    }
    // 2 segments name 2 dirs (d1, d2). This is below MAX_HEAD_DIRS = 8.
    // A 3rd segment names a 3rd dir (d3). It pushes HEAD.
    // Its verdict uses the result of headOf(d3).
    const command = 'git -C d1 push o b; git -C d2 push o b; git -C d3 push o HEAD'
    // The budget ends after 2 calls (5500 ms, then 11000 ms of fake time).
    // This is before MAX_HEAD_DIRS = 8.
    //
    // The memo skips the 3rd call. No spawn occurs.
    // The current branch at d3 is unknown. It then fails closed: PUSH_REASON.
    // This is the same rule that the MAX_HEAD_DIRS cap uses.
    expect(denyReason(command, undefined, undefined, gate)).toBe(PUSH_REASON)
    expect(headOfCalls).toBe(2)
    // Each call gets a timeoutMs of at most the time left before the shared deadline.
    // At the start, timeoutMs is 2000 ms. This is the full per-spawn cap.
    // Then timeoutMs is 500 ms. This occurs when only 500 ms of budget is left.
    expect(seenTimeouts).toEqual([2000, 500])
  } finally {
    dateSpy.mockRestore()
  }
})

// claude-factory-dts.4: the shared deadline applies to the two gate fields, not only headOf.
// One slow headOf call uses all of the GATE_BUDGET_MS = 6000 ms budget.
// gitReason reads headOf before gitPushDenied reads originHead (see :1623 and :1332).
// So that one slow call also stops the originHead spawn in the same push segment.
//
// The target branch here ('feature-branch') is not main, master, or in gate.protectedBranches.
// An originHead call that finds a different branch can let this push pass.
// When the budget is spent, the memo skips that spawn. It gives an unresolved answer.
// An unresolved answer fails closed (claude-factory-zl5.13): PUSH_REASON.
test('a single slow headOf call that spends the whole gate budget also skips the originHead spawn in the same push (claude-factory-dts.4)', () => {
  let fakeNow = 0
  const dateSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow)
  try {
    let headOfCalls = 0
    let originHeadCalls = 0
    const gate: HookGate = {
      headOf: () => {
        headOfCalls++
        fakeNow += 7000
        return 'feature'
      },
      originHead: () => {
        originHeadCalls++
        return 'release'
      },
    }
    expect(denyReason('git push origin feature-branch', undefined, undefined, gate)).toBe(PUSH_REASON)
    expect(headOfCalls).toBe(1)
    expect(originHeadCalls).toBe(0)
  } finally {
    dateSpy.mockRestore()
  }
})

// claude-factory-sft4: a dynamic word in the shell slot (a variable, a glob, a brace or a tilde)
// expands to sh, bash, zsh or dash at run time. The guard must still read the -c script.
const SFT4_GATE = {
  headOf: (d?: string) => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
}
const SFT4_PUSH = "'git push origin main'"
const SFT4_DENY = [
  `SH=sh; $SH -c ${SFT4_PUSH}`,
  `/bin/s? -c ${SFT4_PUSH}`,
  `s{h,} -c ${SFT4_PUSH}`,
  `SH=sh; \${SH} -c ${SFT4_PUSH}`,
  `SH=sh; "$SH" -c ${SFT4_PUSH}`,
  `SH=sh; $SH -lc ${SFT4_PUSH}`,
  `SH=sh; $SH -e -c ${SFT4_PUSH}`,
  `/bin/[s]h -c ${SFT4_PUSH}`,
  `/bin/sh* -c ${SFT4_PUSH}`,
  `s{h..h} -c ${SFT4_PUSH}`,
  `~/s? -c ${SFT4_PUSH}`,
  `~x -c ${SFT4_PUSH}`,
  `s[h -c ${SFT4_PUSH}`,
  `s]h -c ${SFT4_PUSH}`,
  `s{h -c ${SFT4_PUSH}`,
  `s}h -c ${SFT4_PUSH}`,
  `env /bin/s? -c ${SFT4_PUSH}`,
  `SH=sh; env $SH -c ${SFT4_PUSH}`,
  `SH=sh; nice $SH -c ${SFT4_PUSH}`,
  `SH=sh; sudo -u x $SH -c ${SFT4_PUSH}`,
  `SH=sh; timeout 5 $SH -c ${SFT4_PUSH}`,
  'SH=sh; $SH -c "git push origin main"',
  "SH=sh; $SH -c 'rm -rf /'",
  `$E eval "git push origin main; echo" -c x`,
  `$E eval 'git push origin main;' -c x`,
  `$E env -S 'git push origin main' -c x`,
  `nice $N eval 'git push origin main' -c x`,
  `env -S '/bin/s?' -c ${SFT4_PUSH}`,
  `env -S "/bin/s? -c 'git push origin main'"`,
  `"\`echo sh\`" -c ${SFT4_PUSH}`,
  `"\`echo /bin/sh\`" -c ${SFT4_PUSH}`,
  `"\`echo sh\`" -c 'rm -rf x'`,
  `"\`echo sh\`" -c 'gh pr merge 1'`,
  `$X env -C /tmp/other sh -c 'git push'`,
  `$X env -C /tmp/other sh -c 'git push origin'`,
  `$X env -C /tmp/other sh -c 'git push origin HEAD'`,
  `$X env -C /tmp/other sh -c 'git send-pack origin HEAD'`,
  `$X env --chdir /tmp/other bash -c 'git push'`,
  `$X env -C /tmp/other zsh -lc 'git push'`,
  `$X env -C /tmp/other sh -c -- 'git push'`,
  `"$X" env -C /tmp/other sh -c 'git push'`,
  `\${X} env -C /tmp/other dash -c 'git push'`,
]

test.each(SFT4_DENY)('denyReason denies a dynamic shell word: %s (claude-factory-sft4)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
})

test('denyReason denies a bd command behind a dynamic shell word (claude-factory-sft4)', () => {
  expect(denyReason("SH=sh; env -i $SH -c 'bd create x'")).toBe(BEADS_ACTOR_REASON)
  expect(denyReason("env -u BEADS_ACTOR $SH -c 'bd create x'")).toBe(BEADS_ACTOR_REASON)
  expect(denyReason('env -i "`echo sh`" -c \'bd create x\'')).toBe(BEADS_ACTOR_REASON)
})

const SFT4_ALLOW = [
  "env -S 'sh' -c 'echo x'",
  'for f in *.ts; do echo $f; done',
  "SH=sh; $SH -c 'echo x'",
  "/bin/s? -c 'echo x'",
  '$EDITOR file.txt',
  '$CC -c foo.c',
  'cc -c *.c',
  `"$PYTHON" -c 'print(1)'`,
  'ls *.ts -c',
  "$X sh -c 'git push'",
  "env -C /tmp/other sh -c 'git push origin feature'",
]

test.each(SFT4_ALLOW)('denyReason allows a harmless dynamic word: %s (claude-factory-sft4)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

test('scanReason denies a 40000-word run of $SH words, fast (claude-factory-sft4)', () => {
  expect(scanReason('echo ' + '$SH '.repeat(SCAN_N) + "-c 'rm -rf x'")).toBe(REASON)
}, 500)

// claude-factory-jsy0: zsh (EQUALS option) expands a word that starts with `=cmd` to the command
// path. bash does not. A leading `=` word in the command or shell slot must count as dynamic.
const JSY0_DENY = [
  '=git push origin main',
  '=git -C /tmp/other push origin main',
  '=gh pr merge 1',
  "=sh -c 'git push origin main'",
  "=bash -c 'git push origin main'",
  "=sh -lc 'git push origin main'",
  "=zsh -e -c 'git push origin main'",
  "=sh -c 'rm -rf /'",
  "command =sh -c 'git push origin main'",
  "env =sh -c 'git push origin main'",
  "nohup =sh -c 'git push origin main'",
]

test.each(JSY0_DENY)('denyReason denies a leading = word: %s (claude-factory-jsy0)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
})

const JSY0_ALLOW = [
  'x=y git status',
  'git commit --message=hi',
  'git log --format=%H -1',
  'echo =',
  '[ a = push ]',
  'test x = checkout',
  'echo a==b',
  'echo == push',
  '=git status',
  "=sh -c 'echo x'",
  "sh -c 'echo x'",
]

test.each(JSY0_ALLOW)('denyReason allows a harmless = word: %s (claude-factory-jsy0)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

const LPIU_DENY = [
  '$G >f push origin main',
  '$G 2>&1 push origin main',
  '$G > f push origin main',
  '$G >f $V origin main',
  'sudo $G >f push origin main',
  '=git >f push origin main',
  '=git 2>/dev/null push origin main',
  '=git >f -C /tmp push origin main',
]

test.each(LPIU_DENY)(
  'denyReason denies a redirect after a dynamic command word: %s (claude-factory-lpiu)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
  },
)

const LPIU_ALLOW = ['ls >f', '$G >f', 'cp $A $B', 'cp $A >f $B', '$G >f status', 'echo $X >push']

test.each(LPIU_ALLOW)('denyReason allows a harmless redirect: %s (claude-factory-lpiu)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

// claude-factory-6sz8: zsh expands =X to the path of X in every word position. A guard must read
// =rm as rm, =sudo as sudo and so on.
const SZ8_DENY = [
  '=rm -rf /',
  'sudo =rm -rf /',
  'env =rm -rf /',
  'nice =rm -rf /',
  'nice -n 5 =rm -rf /',
  'command =rm -rf /',
  'exec =rm -rf /',
  'time =rm -rf /',
  'timeout 5 =rm -rf /',
  'A=1 =rm -rf /',
  '=rm -r x',
  '=rm x/../../etc',
  '=rm /etc/passwd',
  '=sudo rm -rf /',
  '=env rm -rf /',
  '=nice rm -rf /',
  '=command rm -rf /',
  '=timeout 5 rm -rf /',
  '=xargs rm -rf < f',
  '=find / -exec rm -rf {} +',
  'find / -exec =rm -rf {} +',
  '=rm x; cd ..',
  'cd ..; =rm x',
  '=RM -rf /',
  '=\\rm -rf /',
  "=r''m -rf /",
  "'=rm' -rf /",
  'if true; then =rm -rf /; fi',
  'echo x | =rm -rf /',
]

test.each(SZ8_DENY)('denyReason denies an = command word: %s (claude-factory-6sz8)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
})

const SZ8_ALLOW = [
  '== x',
  'a=b ls',
  'echo =rm',
  '=ls',
  '=rm x',
  'ls =rm',
  '==rm -rf /',
  'echo a==b',
  'echo == push',
]

test.each(SZ8_ALLOW)('denyReason allows a harmless = word: %s (claude-factory-6sz8)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

// zsh `repeat N cmd` runs cmd N times in the same segment. Bash prints "command not found".
const DTR2_DENY = [
  'repeat 1 rm -rf /',
  'repeat 1 =rm -rf /',
  'repeat 1+1 rm -rf /',
  'repeat x=2 rm -rf /',
  'repeat 1 sudo rm -rf /',
  'repeat 1 repeat 1 rm -rf /',
  'repeat 1 A=1 rm -rf /',
  'repeat 1 do rm -rf /; done',
  'if true; then repeat 1 rm -rf /; fi',
  'time repeat 1 rm -rf /',
  '! repeat 1 rm -rf /',
  'echo x | repeat 1 rm -rf /',
  'repeat 1 xargs rm -rf < f',
  'repeat 1 timeout 5 rm -rf /',
  'repeat 1 $G $V origin main',
  'echo x | repeat 1 $SH',
  'repeat $N echo hi',
  'repeat ${N} ls',
  'repeat `n` ls',
  'repeat ~ ls',
  'repeat $N rm -rf /',
  'repeat "$(cat f)" rm -rf /',
]

test.each(DTR2_DENY)('denyReason denies a zsh repeat command: %s (claude-factory-dtr2)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
})

test.each(['repeat $N echo hi', 'repeat ${N} ls', 'repeat ~ ls'])(
  'denyReason names a dynamic repeat count: %s (claude-factory-dtr2)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

const DTR2_PIN = [
  'repeat 2 git push origin main',
  'repeat 1 eval "rm -rf /"',
  'repeat 1 sh -c "rm -rf /"',
  'repeat 1 git checkout main && git push o HEAD',
  'repeat 1 BEADS_ACTOR=x bd create t',
]

test.each(DTR2_PIN)('denyReason keeps denying: %s (claude-factory-dtr2)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
})

const DTR2_ALLOW = [
  'echo repeat 1',
  'repeat 1 ls',
  'repeat 3 echo hi',
  'repeat 1 git status',
  'repeat',
  'repeat 1',
  'ls repeat 1 rm',
  'repeat 1 rm x',
]

test.each(DTR2_ALLOW)('denyReason allows a harmless repeat word: %s (claude-factory-dtr2)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

const DYN_RM_DENY = [
  '$N rm -rf /',
  'X=command; $X rm -rf /',
  '"$X" rm -rf /',
  '${X} rm -rf /',
  '$X -p rm -rf /',
  '$X -- rm -rf /',
  '$X sudo rm -rf /',
  '$X command rm -rf /',
  '$X /bin/rm -rf /',
  '$X rm ../x',
  '$X rm -r x',
  '$X find . -exec rm -r {} +',
  '$X find / -execdir rm -rf {} \\;',
  'sudo $X rm -rf /',
  'env $X rm -rf /',
  'sudo -E $X rm -rf /',
  'env -v $X rm -rf /',
  'timeout 5 $X rm -rf /',
  'nice -n 5 $X rm -rf /',
  'if true; then $X rm -rf /; fi',
  'echo x | $X rm -rf /',
  '$X rm a; cd /x',
  'cd /x; $X rm a',
  '$X -u root rm -rf /',
  '$X -C 5 rm -rf /',
  '$X -n 5 rm -rf /',
  '$X 5 rm -rf /',
  '$X -k 5 5 rm -rf /',
  '$X -u root $Y rm -rf /',
  '$X -u find rm -rf /',
  'X=env; $X -u find rm -rf /',
  '$X -C find rm -rf /',
  '$X -u find /bin/rm -rf /',
  '$X find rm -rf /',
  '$X -u rm rm -r src',
  'X=env; $X -u rm rm -r src',
  '$X -u rm -- rm -r src',
  '$X -u rm rm -rf src',
  '$X -u rm =rm -r src',
  '$X -C rm rm -r src',
  '$X -u rm sudo rm -r src',
  '$X -u rm find src -exec rm -r {} +',
  'find . -exec $X rm -rf / {} \\;',
  'find . -exec $X rm -r src {} \\;',
  'find . -exec $X rm {} +',
  'find . -exec ${X} rm -rf {} +',
  'find . -exec "$X" rm -rf {} +',
  'find . -execdir $X rm -rf {} +',
  'find . -exec $X -u rm rm -r src {} +',
  'find . -exec $X -u + rm -rf / {} \\;',
  'sudo find . -exec $X rm -rf {} +',
  'find . -name x -exec $X rm -rf / {} \\;',
  'find . -exec $X rm -rf / {} \\; -print',
  'find . \\( -exec $X rm -rf / {} \\; \\)',
  'X=env; find . -exec $X rm -rf / {} \\;',
]

test.each(DYN_RM_DENY)(
  'denyReason denies rm behind a dynamic command word: %s (claude-factory-2a3i)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
  },
)

const DYN_RM_KEEP = [
  '$N ls',
  'echo $N rm',
  'echo $N rm -rf /',
  '$N rm a',
  '$N rm build/x',
  '"$PY" -c "print(1)"',
  '$X ls -d /',
  'echo rm -rf /',
  'find . -exec $X ls {} +',
]

test.each(DYN_RM_KEEP)('denyReason keeps allowing a harmless dynamic word: %s (claude-factory-2a3i)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

const DYN_LATER_DENY = [
  '$X -u root $Y -rf /',
  '$X -u root $Y ../x',
  '$X -n 5 $Y -rf /',
  '$X -u root "$Y" -rf /',
  '$X -u root ${Y} ../x',
  '$X -u root -- $Y -rf /',
  '$X -u root $Y -- -rf /',
  '$X -u root $Y -r src',
  '$X -u root $Y /',
  '$X a b $Y -rf /',
  'X=env; $X -u root $Y -rf /',
  '{ $X -u root $Y -rf /; }',
  'sudo -u root $X -u root $Y ../x',
  'find . -exec $X -u root $Y -rf / {} \\;',
  '$X $Y -rf /',
  '$X $Y ../x',
  '$X -u $Y -rf /',
]

test.each(DYN_LATER_DENY)(
  'denyReason denies a dynamic word after a dynamic head and wrapper flags: %s (claude-factory-0xw4)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
  },
)

const DYN_LATER_KEEP = ['echo $X -u root $Y -rf /', 'git -C $Y status']

test.each(DYN_LATER_KEEP)('denyReason keeps allowing: %s (claude-factory-0xw4)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeUndefined()
})

test('denyReason denies a later dynamic word after a risky-free dynamic head (fail-closed, claude-factory-0xw4)', () => {
  expect(denyReason('$GIT -C $DIR log $REF', '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
})

test('denyReason reads a long dynamic head command in linear time (claude-factory-0xw4)', () => {
  const cmd = '$X ' + '$A '.repeat(1300) + '-x '.repeat(1300)
  expect(cmd.length).toBeLessThan(8192)
  const t = Date.now()
  expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).not.toBe(LONG_COMMAND_REASON)
  expect(Date.now() - t).toBeLessThan(1000)
}, 30_000)

test.each(['$(echo command) rm -rf /', '$N git push origin main', 'rm -rf /', '$X =rm -rf /'])(
  'denyReason keeps denying: %s (claude-factory-2a3i)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, SFT4_GATE)).toBeTruthy()
  },
)

test.each([
  ['=rm', 'rm'],
  ['=RM', 'rm'],
  ['=/bin/rm', 'rm'],
  ['=\\rm', 'rm'],
  ['\\=rm', 'rm'],
  ['==rm', '==rm'],
  ['=', '='],
  ['a=b', 'a=b'],
])('baseWord reads %s as %s (claude-factory-6sz8)', (w, want) => {
  expect(baseWordForTest(w)).toBe(want)
})

// claude-factory-2pdm: a command substitution inside double quotes runs in the shell. Every guard
// must see its body, as it sees the same text outside quotes.
const DQ_GATE: HookGate = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map(),
  ghAliases: () => new Map(),
}
const BT = '`'
const DENY_DQ_SUBST: [string, string][] = [
  ['echo "$(git push origin main)"', PUSH_REASON],
  ['x="$(git push origin main)"', PUSH_REASON],
  ['v="$(gh pr merge 5)"', MERGE_REASON],
  ['echo "${X:-$(git push origin main)}"', PUSH_REASON],
  ['echo "$(git push "origin" main)"', PUSH_REASON],
  ['echo "a $(git send-pack ../r.git main) b"', PUSH_REASON],
  ['echo "$(gh pr merge 5)"', MERGE_REASON],
  ['echo "$(rm -rf x)"', REASON],
  ['echo "$(kubectl --context acme apply -f x)"', LIVE_REASON],
  ['echo "$(git checkout main)"; git push', PUSH_REASON],
  [`echo "${BT}git push origin main${BT}"`, PUSH_REASON],
  // parse traps
  ['echo "$(echo x # )\ngit push origin main)"', PUSH_REASON],
  ['echo "$(case a in a) git push origin main;; esac)"', PUSH_REASON],
  ['echo "$(git\\\n push origin main)"', PUSH_REASON],
  ['echo "$(echo ")"; git push origin main)"', PUSH_REASON],
  ['echo "$(echo \\); git push origin main)"', PUSH_REASON],
  ['echo "$(echo $(true); git push origin main)"', PUSH_REASON],
  ['echo "$(echo "$(echo "x")"; git push origin main)"', PUSH_REASON],
  ['echo "$(echo ${x//)/}; git push origin main)"', PUSH_REASON],
  ['echo "$(bash <<\'EOF\'\ngit push origin main\nEOF\n)"', PUSH_REASON],
  ['echo "$(echo "$(git push origin main)")"', PUSH_REASON],
  ['echo "$(echo \')\'; git push origin main)"', PUSH_REASON],
  ['echo "$(echo "x"; git push origin main)"', PUSH_REASON],
  ['echo "$(git push origin main', PUSH_REASON],
  ['echo "$(cat <<\'EOF\'\nx\nEOF\n; git push origin main)"', PUSH_REASON],
  ['echo "$(cat <<EOF\ngit push origin main\nEOF\n)"', PUSH_REASON],
  ['echo "$(cat <<\'EOF\' ; git push origin main\nx\nEOF\n)"', PUSH_REASON],
  // fallback keeps the quote reading: code after the closing quote stays visible
  ['x="$(echo ${HOME})" && git push origin main', PUSH_REASON],
  ['x="$(case a in a) true;; esac)" && git push origin main', PUSH_REASON],
  ['x="$(echo \\;#)" && git push origin main', PUSH_REASON],
  [`x="${BT}echo hi" && git push origin main`, PUSH_REASON],
  // here-document delimiter words that continue
  ['echo "$(bash <<\'EOF\'x\ngit push origin main\nEOFx\n)"', PUSH_REASON],
  ['echo "$(bash <<E"OF"\ngit push origin main\nEOF\n)"', PUSH_REASON],
  ['echo "$(bash <<E\\OF\ngit push origin main\nEOF\n)"', PUSH_REASON],
  [`echo "$(bash <<'E'"OF"\ngit push origin main\nEOF\n)"`, PUSH_REASON],
  // bash ends a here-document at a line that starts with the delimiter and then a paren
  ['git commit -m "$(cat <<\'EOF\'\nmsg\nEOF)" && git push origin main', PUSH_REASON],
  ['echo "$(bash <<\'EOF\'\nEOF)"; git push origin main', PUSH_REASON],
  // a hash after a paren starts a comment
  ['echo "$( (true)# )\ngit push origin main\n)"', PUSH_REASON],
  // a quote char in a comment or here-document text is not a quote
  ['echo "$(true # a"b\ngit push origin main\n)"', PUSH_REASON],
  ['echo "$(true # don\'t\ngit push origin main\n)"', PUSH_REASON],
  ["echo \"$(cat <<'EOF'\ndon't\nEOF\ngit push origin main\n)\"", PUSH_REASON],
  ['echo "$(cat <<EOF\ndon\'t\nEOF\ngit push origin main\n)"', PUSH_REASON],
  // a backslash-newline inside a lookahead of the substitution reader
  ['echo "$\\\n(git push origin main)"', PUSH_REASON],
  ['x="$\\\n(git push origin main)"', PUSH_REASON],
  ['echo "$(echo $\\\n{x//)/}; git push origin main)"', PUSH_REASON],
  ['echo "$(true; c\\\nase a in a) git push origin main;; esac)"', PUSH_REASON],
  ['echo "$(cat <\\\n<\'EOF\'\n)\nEOF\ngit push origin main\n)"', PUSH_REASON],
  // a hash after a close paren or inside a brace is not a comment
  ['echo "$(echo $(true)#; git push origin main)"', PUSH_REASON],
  ['echo "$(echo $((1))#; git push origin main)"', PUSH_REASON],
  ['echo "$(cat <(true)#; git push origin main)"', PUSH_REASON],
  ['echo "$(echo ${x:- #}; git push origin main)"', PUSH_REASON],
  // a substitution after an empty segment still counts in order: the body moves HEAD before the push
  ['; echo "$(git checkout main)"; git push', PUSH_REASON],
]

test.each(DENY_DQ_SUBST)('denyReason denies %j (double-quoted substitution)', (cmd, reason) => {
  expect(denyReason(cmd, '/root/repo', ['acme'], DQ_GATE)).toBe(reason)
})

// claude-factory-j1dr: the cleaned reading of a double-quoted substitution blanks quotes in a false
// comment or here-document. The raw body is read too, so a quoted command word still denies.
const DENY_J1DR = [
  `echo "$(echo $(true)#x ; 'g'it push origin main)"`,
  `echo "$(cat <<E"O"F\nx\nEOF\n'g'it push origin main\n)"`,
  `echo "$(echo <(true)#x ; 'g'it push origin main)"`,
  `echo "$(echo >(true)#x ; 'g'it push origin main)"`,
  `echo "$(echo =(true)#x ; 'g'it push origin main)"`,
  `echo "$(echo $((1<<2))\n'g'it push origin main\n2\n)"`,
]
const ALLOW_J1DR = [
  'echo "$(diff <(echo a) <(echo b))"',
  'echo "$(echo $((1<<2)))"',
  `git commit -m "$(cat <<EOF\nit's ok\nEOF\n)"`,
  `echo "$(true # it's\n)"; echo hi`,
]
test.each(DENY_J1DR)('denyReason denies %j (j1dr)', cmd => {
  expect(denyReason(cmd, '/root/repo', ['acme'], DQ_GATE)).toBeTruthy()
})
test.each(ALLOW_J1DR)('denyReason allows %j (j1dr)', cmd => {
  expect(denyReason(cmd, '/root/repo', ['acme'], DQ_GATE)).toBeUndefined()
})

// claude-factory-mozp: a backslash at the end of a comment line is literal in a shell, so the next
// line runs as a command. segments() joins the lines, so the guard must deny the comment line.
const BS = '\\'
const NL = '\n'
const DENY_COMMENT_CONTINUATION: [string, string][] = [
  [`true #${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true #a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true # a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true;#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true # it's${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true # a${BS}${NL}git${BS}${NL} push origin main`, COMMENT_CONTINUATION_REASON],
  [`true # a${BS}${NL}gh pr merge 5`, COMMENT_CONTINUATION_REASON],
  [`true # a${BS}${NL}rm -rf /`, COMMENT_CONTINUATION_REASON],
  [`echo $(true # a${BS}${NL}git push origin main${NL})`, COMMENT_CONTINUATION_REASON],
  [`echo "$(true # a${BS}${NL}git push origin main${NL})"`, COMMENT_CONTINUATION_REASON],
  [`x="$(true # a${BS}${NL}git push origin main${NL})"`, COMMENT_CONTINUATION_REASON],
  [`echo DQ"$(true # a${BS}${NL}git push origin main${NL})"DQ`, COMMENT_CONTINUATION_REASON],
  // quote concatenation: the backslash and the newline sit in different quote spans
  [`sh -c 'true #a${BS}'"${NL}"'git push origin main'`, COMMENT_CONTINUATION_REASON],
  [`bash -c 'true #a${BS}'"${NL}git push origin main"`, COMMENT_CONTINUATION_REASON],
  [`eval 'true #a${BS}'"${NL}"'git push origin main'`, COMMENT_CONTINUATION_REASON],
  [`echo $(sh -c 'true #a${BS}'"${NL}"'git push origin main')`, COMMENT_CONTINUATION_REASON],
  // every character that can start a word before the comment hash
  [`true|#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true&&#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`true&#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`(true)#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`(#a${BS}${NL}git push origin main${NL})`, COMMENT_CONTINUATION_REASON],
  [`echo $(#a${BS}${NL}git push origin main${NL})`, COMMENT_CONTINUATION_REASON],
  [`true\t#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`#a${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  // the rows from the bead, with a space before the backslash: the push word is already visible
  [`true # a ${BS}${NL}git push origin main`, COMMENT_CONTINUATION_REASON],
  [`echo $(true # a ${BS}${NL}git push origin main${NL})`, COMMENT_CONTINUATION_REASON],
  [`echo "$(true # a ${BS}${NL}git push origin main${NL})"`, COMMENT_CONTINUATION_REASON],
  [`x="$(true # a ${BS}${NL}git push origin main${NL})"`, COMMENT_CONTINUATION_REASON],
]

test.each(DENY_COMMENT_CONTINUATION)(
  'denyReason denies %j (comment line ends in a backslash)',
  (cmd, reason) => {
    expect(denyReason(cmd, '/root/repo', ['acme'], DQ_GATE)).toBe(reason)
  },
)

const ALLOW_COMMENT_CONTINUATION = [
  `echo x#y${BS}${NL}git status`,
  `echo '#'${BS}${NL}git status`,
  `echo "#"${BS}${NL}git status`,
  `echo a #b${NL}git status`,
  `git status # note${BS}`,
  `git status # note${BS}${NL}  `,
]

test.each(ALLOW_COMMENT_CONTINUATION)('denyReason allows %j (no comment continuation)', cmd => {
  expect(denyReason(cmd, '/root/repo', ['acme'], DQ_GATE)).toBeUndefined()
})

const ALLOW_DQ_SUBST = [
  'echo "git push origin main"',
  "echo 'git push origin main'",
  "echo '$(git push origin main)'",
  'echo "\\$(git push origin main)"',
  "git commit -m \"$(cat <<'EOF'\nworker-hook: deny git push origin main in quotes\n\nIt don't scan rm -rf x.\nEOF\n)\"",
  'git commit -m "$(cat <<-\'EOF\'\n\tgit push origin main\n\tEOF\n)"',
  'git commit -m "$(date) fix"',
  'echo "$((1+2))"',
  'echo "$(date # don\'t panic\n)"',
  'gh pr create --title t --body "$(cat .scratch/body.md)"',
]

test.each(ALLOW_DQ_SUBST)('denyReason allows %j (double-quoted text)', cmd => {
  expect(denyReason(cmd, '/root/repo', ['acme'], DQ_GATE)).toBeUndefined()
})

test('denyReason keeps a gh api graphql file query in double quotes denied', () => {
  expect(denyReason('gh api graphql -f query="$(cat f)"', '/root/repo', ['acme'], DQ_GATE)).toBe(MERGE_REASON)
})

// claude-factory-wmsr: a word-start comment and a here-document body are text. A quote char in them
// must not hide the next command from segments().
const WM = 'git push origin main'
const DENY_WMSR_COMMENT: [string, string][] = [
  [`true # don't\n${WM}`, COMMENT_REASON],
  [`true;# it's\n${WM}`, COMMENT_REASON],
  [`true |# it's\n${WM}`, COMMENT_REASON],
  [`true &# it's\n${WM}`, COMMENT_REASON],
  [`true &&# it's\n${WM}`, COMMENT_REASON],
  [`# don't\n${WM}`, COMMENT_REASON],
  [`true # a\\\n${WM}`, COMMENT_CONTINUATION_REASON],
  [`echo $(true # a\\\n${WM}\n)`, COMMENT_CONTINUATION_REASON],
  [`echo $(true)#' \n${WM}\n'`, COMMENT_REASON],
]
test.each(DENY_WMSR_COMMENT)('denyReason denies %j (comment text, wmsr)', (cmd, reason) => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBe(reason)
})

const DENY_WMSR_COMMENT_ANY = [
  `echo $(true)#x ; 'g'it push origin main`,
  `x=ab; echo $(( #x )); ${WM}`,
  `echo \${x:- #}; ${WM}`,
]
test.each(DENY_WMSR_COMMENT_ANY)('denyReason denies %j (hash that is no comment, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

const ALLOW_WMSR_COMMENT = [
  'echo a#b',
  'echo $((1+2))',
  "gh pr view 1 # it's ok",
  "git push origin factory/x # don't",
]
test.each(ALLOW_WMSR_COMMENT)('denyReason allows %j (comment text, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

const WB = '`'
const DENY_WMSR_HEREDOC: [string, string][] = [
  [`cat <<EOF\ndon't\nEOF\n${WM}`, HEREDOC_REASON],
  [`echo $(cat <<EOF\ndon't\nEOF\n${WM}\n)`, HEREDOC_REASON],
  [`cat <<'EOF'\ndon't\nEOF\n${WM}`, HEREDOC_REASON],
  [`cat <<"EOF"\ndon't\nEOF\n${WM}`, HEREDOC_REASON],
  [`cat <<\\EOF\ndon't\nEOF\n${WM}`, HEREDOC_REASON],
  [`cat <<-EOF\n\tdon't\n\tEOF\n${WM}`, HEREDOC_REASON],
  [`cat <<A <<B\ndon't\nA\nit's\nB\n${WM}`, PUSH_REASON],
  [`cat <<EOF # it's\nx\nEOF\n${WM}`, COMMENT_REASON],
  [`cat <<EOF\n$(${WM})\nEOF`, DYNAMIC_VERB_REASON],
  [`cat <<EOF\n${WB}${WM}${WB}\nEOF`, DYNAMIC_VERB_REASON],
  ['cat <<EOF\n$(date)\nEOF', DYNAMIC_VERB_REASON],
  [`cat <<EOF\ndon't $(${WM})\nEOF`, HEREDOC_REASON],
  [`cat <<EOF\nx`, HEREDOC_REASON],
  [`cat <<EOF\nx\nEOF \n${WM}`, PUSH_REASON],
  [`cat <<EOF\nx\nEOF)\n${WM}`, PUSH_REASON],
  [`cat <<EOF\nx\nEOF\r\n${WM}`, PUSH_REASON],
  [`cat <<$X\nx\n$X\n${WM}`, PUSH_REASON],
  [`cat <<\nx\n\n${WM}`, PUSH_REASON],
  [`cat <<\n\n${WM}`, PUSH_REASON],
  [`cat <<EOF\nx\n`, HEREDOC_REASON],
  [`cat <<EOF\nEOFx\nEOF\n${WM}`, PUSH_REASON],
  [`cat <<EOF\nx\n EOF\nEOF\n${WM}`, PUSH_REASON],
  [`cat <<EOF "a\nb"\nx\nEOF\n${WM}`, PUSH_REASON],
  [`echo $((1<<2))\n${WM}\n2`, PUSH_REASON],
  [`echo \${x:-<<2}\n${WM}\n2`, PUSH_REASON],
]
test.each(DENY_WMSR_HEREDOC)('denyReason denies %j (here-document, wmsr)', (cmd, reason) => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBe(reason)
})

// claude-factory-wmsr.4-.6: a body can feed a later command; the guard scans it as commands.
const DENY_WMSR_HEREDOC_FEED = [
  `cat <<EOF |\n# x\n${WM}\nEOF\nsh`,
  `cat <<EOF |&\n# x\n${WM}\nEOF\nsh`,
  `cat <<EOF | # c\n# x\n${WM}\nEOF\nsh`,
  `cat <<EOF \\\n|\n# x\n${WM}\nEOF\nsh`,
  `cat <<'EOF' |\n# x\n${WM}\nEOF\nsh`,
  `(cat <<EOF\n# x\n${WM}\nEOF\n) | sh`,
  `bash < <(\ncat <<EOF\n# x\n${WM}\nEOF\n)`,
  `{ cat <<EOF\n# x\n${WM}\nEOF\n} | sh`,
  `{\ncat <<EOF\n# x\n${WM}\nEOF\n} | sh`,
  `echo ${WB}cat <<EOF\n# x\n${WM}\nEOF\n${WB} | sh`,
  `if true; then\ncat <<EOF\n# x\n${WM}\nEOF\nfi | sh`,
  `while read l; do echo $l; done <<EOF\n# x\n${WM}\nEOF`,
  `psql <<EOF\n# x\n\\! ${WM}\nEOF`,
  `sqlite3 <<EOF\n# x\n.shell ${WM}\nEOF`,
  `cat <<EOF\n# x $(case x in x) ${WM};; esac)\nEOF`,
  `cat <<EOF\n# x ${WB}date\nEOF`,
]
test.each(DENY_WMSR_HEREDOC_FEED)('denyReason denies %j (body feeds a command, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

// claude-factory-wmsr.8-.9: a rebound consumer or stdout; the guard scans the body as commands.
const DENY_WMSR_HEREDOC_REBIND = [
  `exec 3> >(sh)\ncat <<EOF >&3\n# x\n${WM}\nEOF`,
  `exec > >(sh)\ncat <<EOF\n# x\n${WM}\nEOF`,
  `exec 1> >(sh)\ngit commit -F - <<EOF\n# x\n${WM}\nEOF`,
  `mkfifo f; sh <f &\ncat <<EOF >f\n# x\n${WM}\nEOF`,
  `cat() ( sh )\ncat <<EOF\n# x\n${WM}\nEOF`,
  `function cat { sh; }\ncat <<EOF\n# x\n${WM}\nEOF`,
  `eval 'cat() ( sh )'\ncat <<EOF\n# x\n${WM}\nEOF`,
  `shopt -s expand_aliases; alias cat=sh\ncat <<EOF\n# x\n${WM}\nEOF`,
  `hash -p /bin/sh cat\ncat <<EOF\n# x\n${WM}\nEOF`,
  `command hash -p /bin/sh cat\ncat <<EOF\n# x\n${WM}\nEOF`,
  `builtin hash -p /bin/sh cat\ncat <<EOF\n# x\n${WM}\nEOF`,
  `hash cat=/bin/sh\ncat <<EOF\n# x\n${WM}\nEOF`,
]
test.each(DENY_WMSR_HEREDOC_REBIND)('denyReason denies %j (rebound consumer, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

// claude-factory-wmsr.10-.11: a consumer can hand stdin to a shell; the body is scanned as commands.
const WB10 = `\n# x\n${WM}\nEOF`
const DENY_WMSR_HEREDOC_STDIN = [
  `perl -e 'system("sh")' <<EOF${WB10}`,
  `perl -pe 'BEGIN{open STDOUT,"|sh"}' <<EOF${WB10}`,
  `python3 -c 'import os; os.system("sh")' <<EOF${WB10}`,
  `python3 x.py <<EOF${WB10}`,
  `node -e 'require("child_process").execSync("sh",{stdio:"inherit"})' <<EOF${WB10}`,
  `bun -e 'x' <<EOF${WB10}`,
  `ruby -e 'system("sh")' <<EOF${WB10}`,
  `GIT_EDITOR='sh -s' git commit --allow-empty -e <<EOF${WB10}`,
  `git -c core.editor='sh -s' commit -e <<EOF${WB10}`,
  `git config core.editor 'sh -s'\ngit commit --allow-empty <<EOF${WB10}`,
  `git -c sequence.editor='sh -s' rebase -i <<EOF${WB10}`,
  `GIT_SEQUENCE_EDITOR='sh -s' git commit -F - <<EOF${WB10}`,
  `EDITOR='sh -s' git commit -F - <<EOF${WB10}`,
  `git commit --edit -F - <<EOF${WB10}`,
  `git -c core.editor='sh -s' commit -F - <<EOF${WB10}`,
  `gh pr create --editor --body-file - <<EOF${WB10}`,
  `gh issue create -e -F - <<EOF${WB10}`,
  `git commit -e <<EOF${WB10}`,
  `git commit --allow-empty <<EOF${WB10}`,
  `GH_EDITOR='sh -s' gh pr create <<EOF${WB10}`,
  `gh config set editor 'sh -s'\ngh pr create <<EOF${WB10}`,
  `gh alias set x '!sh'\ngh x <<EOF${WB10}`,
  `X=1 cat <<EOF${WB10}`,
]
test.each(DENY_WMSR_HEREDOC_STDIN)('denyReason denies %j (stdin reaches a shell, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

const ALLOW_WMSR_HEREDOC_STDIN = [
  "python3 <<'EOF'\nprint(\"don't\")\nEOF",
  "python3 - <<'EOF'\nprint(\"don't\")\nEOF",
  "git commit -F - <<'EOF'\ndon't\nEOF",
  "git commit --file=- <<'EOF'\ndon't\nEOF",
  "git commit --file - <<'EOF'\ndon't\nEOF",
  "gh pr create --body-file - <<'EOF'\ndon't\nEOF",
]
test.each(ALLOW_WMSR_HEREDOC_STDIN)('denyReason allows %j (text stdin, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

// claude-factory-wmsr.14: a body is scanned as its own command text, so no reader can hide it.
const DENY_WMSR_HEREDOC_OPTS = [
  `sort -S 1k --compress-program=sh <<EOF${WB10}`,
  `sort -S 1k --compress-prog sh <<EOF${WB10}`,
  `/usr/bin/sort -S 1k --compress-program=sh <<EOF${WB10}`,
  `bd edit x <<EOF\n:!sh${WB10}`,
  `gh pr create -fe <<EOF${WB10}`,
  `gh pr create -de <<EOF${WB10}`,
  `git commit -p -F - <<EOF${WB10}`,
  `git commit --patch -F - <<EOF${WB10}`,
  `git commit -i -F - <<EOF${WB10}`,
  `git commit --interactive -F - <<EOF${WB10}`,
  `bash <<'EOF'\ndon't\nEOF\n${WM}`,
  `bash <<'EOF'\ndon't\nx' ; ${WM}\nEOF`,
]
test.each(DENY_WMSR_HEREDOC_OPTS)('denyReason denies %j (body scanned as commands, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

// claude-factory-wmsr.17-.18: a double-quoted substitution in a body, and a bare brace in `${ }`.
const DENY_WMSR_HEREDOC_DQSUB = [
  `bash <<'EOF'\necho "$(${WM})"\nEOF`,
  `sh <<'EOF'\necho "$(${WM})"\nEOF`,
  `cat <<'EOF' | sh\necho "$(${WM})"\nEOF`,
  `bash <<'EOF'\necho "${WB}${WM}${WB}"\nEOF`,
  `echo $(bash <<'EOF'\necho "$(${WM})"\nEOF\n)`,
  `echo \${x:-{a} #y}; ${WM}`,
]
test.each(DENY_WMSR_HEREDOC_DQSUB)('denyReason denies %j (nested substitution, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

// claude-factory-wmsr.20-.21: a header closed on its own line, and a quote or comment in a substitution.
const DENY_WMSR_HEREDOC_CLOSE = [
  `x=$(cat <<EOF)\necho 'x\nEOF\n'; ${WM}`,
  `x=$(cat <<'EOF')\necho 'x\nEOF\n'; ${WM}`,
  `echo $(cat <<EOF)\necho 'x\nEOF\n'; ${WM}`,
  `x=$(cat <<EOF); true\necho 'x\nEOF\n'; ${WM}`,
  `x=\`cat <<EOF\`\necho 'x\nEOF\n'; ${WM}`,
  `cat <<EOF\ndon't $(echo ")"; ${WM})\nEOF`,
  `cat <<EOF\ndon't $(echo ')'; ${WM})\nEOF`,
  `cat <<EOF\ndon't $(echo # )\n${WM}\n)\nEOF`,
]
test.each(DENY_WMSR_HEREDOC_CLOSE)(
  'denyReason denies %j (header close or quoted substitution, wmsr)',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
  },
)

// claude-factory-wmsr.23-.26: a comment skip past a backtick, $[ ] arithmetic, a brace in a nested
// substitution, and a backslash-newline between the two < of a here-document.
const DENY_WMSR_ROUND7 = [
  `echo \`true # x\`; ${WM}`,
  `echo \`true # \`; ${WM}`,
  `x=\`echo a # b\`; ${WM}`,
  `echo $(echo \`true # x\`); ${WM}`,
  `x=1; echo $[ #x ] ' \n'; ${WM}`,
  `echo $[ 1<<2 ]\necho 'a\n2\n' ; ${WM}`,
  `echo \${x:-\`echo } \` #y}; ${WM}`,
  `echo \${x:-$(echo } ) #y}; ${WM}`,
  `cat <\\\n<EOF\ndon't\nEOF\n${WM}`,
  `cat <\\\n<'EOF'\ndon't\nEOF\n${WM}`,
  `cat <\\\n<-EOF\ndon't\nEOF\n${WM}`,
]
test.each(DENY_WMSR_ROUND7)('denyReason denies %j (round 7, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

test.each(['echo `echo a` # x', "cat <<'EOF'\ndon't\nEOF"])('denyReason allows %j (round 7, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

const ALLOW_WMSR_HEREDOC_OPTS = [
  "sort <<'EOF'\ndon't\nEOF",
  "gh pr create -f -d --body-file - <<'EOF'\nit's\nEOF",
  "git commit --file - --no-edit <<'EOF'\ndon't\nEOF",
]
test.each(ALLOW_WMSR_HEREDOC_OPTS)('denyReason allows %j (isolated body, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

test('denyReason denies a shift row with a later push (wmsr)', () => {
  expect(denyReason(`echo $((1<<2))\n${WM}\n2`, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

const ALLOW_WMSR_HEREDOC = [
  "cat <<'EOF'\ndon't\nEOF",
  `git commit -F - <<'EOF'\nFix: don't git push origin main\nEOF`,
  `cat <<<"it's"`,
  "cat <<'EOF' | grep x\ndon't\nEOF",
  "cd x && git commit -F - <<'EOF'\ndon't\nEOF",
  "cat > notes.md <<'EOF'\ndon't\nEOF",
]
test.each(ALLOW_WMSR_HEREDOC)('denyReason allows %j (here-document, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

// origin/main (l43b) denies these three too, with SHELL_STDIN_REASON. The hazard flags add no allow.
test.each([
  "cat <<EOF\nit's $HOME\nEOF",
  "cat <<'EOF'\ndon't $(date)\nEOF",
  "bash <<'EOF'\necho \"don't\"\nEOF",
])('denyReason denies %j like origin/main (wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

// claude-factory-wmsr (capped): rows where a shell runs the push and the round-8 reading allowed it.
const DENY_WMSR_CAPPED = [
  "x=1; echo $[ $(echo ]) #x ] '\n'; git push origin main",
  "x=1; echo $[ `echo ]` #x ] '\n'; git push origin main",
  "x=1; echo $[ ${x:-]} #x ] '\n'; git push origin main",
  "echo $[ $(echo ]) 1<<2 ]\necho 'a\n2\n'; git push origin main",
  "cat <<EOF ${x:-\nEOF\n}\n'\nEOF\ngit push origin main",
  "cat <<EOF ${x:-\nEOF\n}\ndon't\nEOF\ngit push origin main",
  "cat <<EOF $(\nEOF\n)\ndon't\nEOF\ngit push origin main",
  "cat <<EOF $(echo\nEOF\n)\ndon't\nEOF\ngit push origin main",
  "cat <<EOF $[\nEOF\n]\ndon't\nEOF\ngit push origin main",
  "cat <<EOF $((\nEOF\n))\ndon't\nEOF\ngit push origin main",
  "x=1; echo $[ $(true ]) #x ] '\n'; git push origin main",
  "x=1; echo $[ `true ]` #x ] '\n'; git push origin main",
  "x=1; echo $[ ${y+]} #x ] '\n'; git push origin main",
  "echo $[ $(true ]) 1<<2 ]\necho 'a\n2\n'; git push origin main",
  "echo $[ `true ]` 1<<2 ]\necho 'a\n2\n'; git push origin main",
  "echo $[ ${y+]} 1<<2 ]\necho 'a\n2\n'; git push origin main",
]
test.each(DENY_WMSR_CAPPED)('denyReason denies %j (capped, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

// A # right after a brace or a redirect char can start a comment in a shell.
const DENY_WMSR_COMMENT_PREV = [
  `echo a >#it's\n${WM}`,
  `echo a <#it's\n${WM}`,
  `{ true; }#it's\n${WM}`,
  `true {#it's\n${WM}`,
]
test.each(DENY_WMSR_COMMENT_PREV)('denyReason denies %j (comment after brace or redirect, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

test('denyReason denies more than 32 here-documents in one command (wmsr)', () => {
  const one = 'cat <<EOF\nx\nEOF\n'
  expect(denyReason(one.repeat(33) + 'echo hi', '/root/repo', undefined, ZS39_GATE)).toBe(HEREDOC_REASON)
  expect(denyReason(one.repeat(5) + 'echo hi', '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

// Accepted false denies (claude-factory-3sgg): a hazard char and more text follow, so the guard
// cannot tell a comment or a body from a command.
const DENY_WMSR_FALSE_DENY = [
  "true # don't\necho hi",
  "cat <<EOF\nit's $(date +%Y)\nEOF",
  "cat <<'EOF' > f\nit's\nEOF\ngit add f",
  "cat <<EOF\n# it's\nEOF\necho hi",
]
test.each(DENY_WMSR_FALSE_DENY)('denyReason denies %j (accepted false deny, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeTruthy()
})

const ALLOW_WMSR_CAPPED = [
  // no hazard char and no command in the body (checked in bash 5.3 and zsh 5.9: no push)
  '(cat <<EOF)\nhi\nEOF',
  'cat <<EOF\n# x $(date\nEOF',
  // a backslash-newline between the second and third < makes a here-string, not a here-document
  'cat <<\\\n<x\necho hi',
  `git commit -m "$(cat <<'EOF'\nFix: don't break\nEOF\n)"`,
  `git commit -m "$(cat <<'EOF'\nFix: don't break\nEOF\n)" && git push origin factory/x`,
  `gh pr create --title t --body "$(cat <<'EOF'\nIt's a fix\nEOF\n)"`,
  `git commit -F - <<'EOF'\nFix: don't break\nEOF`,
  "cat > notes.md <<'EOF'\n# Title\ndon't\nEOF",
  "cat <<'EOF' | grep x\ndon't\nEOF",
  "true # don't push",
  "git commit -m x # it's",
  "echo $[ 1 ] # it's fine",
]
test.each(ALLOW_WMSR_CAPPED)('denyReason allows %j (capped, wmsr)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, ZS39_GATE)).toBeUndefined()
})

test('denyReason denies a deep double-quoted substitution nest', () => {
  expect(denyReason('echo "$('.repeat(40) + 'true' + ')"'.repeat(40), '/root/repo', ['acme'], DQ_GATE)).toBe(
    DEEP_COMMAND_REASON,
  )
})

test('denyReason scans many double-quoted substitutions and an unmatched chain fast', () => {
  const t0 = performance.now()
  denyReason(Array.from({ length: 1000 }, () => '"$(true)"').join(' '), '/root/repo', ['acme'], DQ_GATE)
  denyReason('echo "$(' + 'a "$('.repeat(1000), '/root/repo', ['acme'], DQ_GATE)
  expect(performance.now() - t0).toBeLessThan(1000)
})

test('denyReason denies a spaced deep-open substitution chain in double quotes, fast (2pdm.16)', () => {
  const rows = ['echo "' + '$(a '.repeat(2040), 'git push origin main #"' + '$(a '.repeat(2040)]
  for (const row of rows) {
    const t0 = performance.now()
    expect(denyReason(row, '/root/repo', ['acme'], DQ_GATE)).toBeTruthy()
    expect(performance.now() - t0).toBeLessThan(1000)
  }
})

test('denyReason does not give the deep reason for a few fallback substitutions (2pdm.16)', () => {
  expect(denyReason('echo "$(echo ${HOME}) $(echo ${PWD})"', '/root/repo', ['acme'], DQ_GATE)).not.toBe(
    DEEP_COMMAND_REASON,
  )
})

// claude-factory-cbai: a nested `env -S` or `env -i eval` command made the beads-actor scan cost
// about 2x for each level. A 219-char command took 82 s, past the 10 s hook timeout, so the hook
// failed open. These rows check the time of one denyReason call and pin the verdicts.
const CBAI_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }
const CBAI_N = 30

function cbaiEnvS(n: number, inner: string): string {
  return "env -S '" + 'env -S '.repeat(n - 1) + inner + "'"
}
function cbaiEvalI(n: number, inner: string): string {
  return 'env -i ' + 'eval '.repeat(n) + inner
}
function cbaiEnvSSh(n: number, inner: string): string {
  return "env -S '" + 'env -S '.repeat(n - 1) + "sh' -c '" + inner + "'"
}
function cbaiTimed(command: string): { reason: string | undefined; ms: number } {
  const t0 = performance.now()
  const reason = denyReason(command, undefined, undefined, CBAI_GATE)
  return { reason, ms: performance.now() - t0 }
}

for (const inner of [
  'git push origin main',
  'git push',
  'git push origin',
  'git push --force origin HEAD:main',
]) {
  test(`denyReason scans ${CBAI_N} nested env -S levels around \`${inner}\` in under 1 s, with the n=2 verdict (claude-factory-cbai)`, () => {
    const { reason, ms } = cbaiTimed(cbaiEnvS(CBAI_N, inner))
    expect(ms).toBeLessThan(1000)
    expect(reason).toBe(denyReason(cbaiEnvS(2, inner), undefined, undefined, CBAI_GATE)!)
    expect(reason).toBeDefined()
  }, 30000)
}

test('denyReason denies env -i with 30 stacked eval words and a push in under 1 s (claude-factory-cbai)', () => {
  const { reason, ms } = cbaiTimed(cbaiEvalI(CBAI_N, 'git push origin main'))
  expect(ms).toBeLessThan(1000)
  expect(reason).toBe(PUSH_REASON)
}, 30000)

test('denyReason denies 16 eval levels around many = words and rm targets, then rm -rf /, in under 2 s (claude-factory-mmc9.26)', () => {
  const body = 'a= '.repeat(1365) + 'rm -f ' + 'x '.repeat(2048)
  const cmd = ('eval '.repeat(16) + body).slice(0, 8192 - '; rm -rf /'.length) + '; rm -rf /'
  const t0 = performance.now()
  const reason = denyReason(cmd, process.cwd(), ['acme'], { ...CBAI_GATE, gitAliases: () => new Map() })
  const ms = performance.now() - t0
  expect(reason).toBe(REASON)
  expect(ms).toBeLessThan(2000)
}, 60000)

for (const [name, body] of [
  ['a=/rm x600 then x words', 'a=/rm '.repeat(600) + 'x '.repeat(4000)],
  ['a=/rm -- x4000', 'a=/rm -- '.repeat(4000)],
] as const) {
  test(`denyReason denies 32 eval levels around ${name} in under 2 s (claude-factory-mmc9.27)`, () => {
    const cmd = ('eval '.repeat(32) + body).slice(0, 8192 - '; rm -rf /'.length) + '; rm -rf /'
    const t0 = performance.now()
    const reason = denyReason(cmd, process.cwd(), ['acme'], { ...CBAI_GATE, gitAliases: () => new Map() })
    const ms = performance.now() - t0
    expect([REASON, SCAN_BUDGET_REASON]).toContain(reason!)
    expect(ms).toBeLessThan(2000)
  }, 60000)
}

test('denyReason gives env -i with 30 stacked eval words and echo the n=2 verdict in under 1 s (claude-factory-cbai)', () => {
  const { reason, ms } = cbaiTimed(cbaiEvalI(CBAI_N, 'echo hi'))
  expect(ms).toBeLessThan(1000)
  expect(reason).toBe(denyReason(cbaiEvalI(2, 'echo hi'), undefined, undefined, CBAI_GATE))
}, 30000)

test('denyReason returns for 30 nested env -S levels around sh -c in under 1 s (claude-factory-cbai)', () => {
  const { ms } = cbaiTimed(cbaiEnvSSh(CBAI_N, 'git push origin main'))
  expect(ms).toBeLessThan(1000)
}, 30000)

test('scanReason takes a small work budget and denies with SCAN_BUDGET_REASON when it is spent (claude-factory-cbai)', () => {
  const command = 'ls -la; echo hello world; pwd; echo done; ls /tmp'
  expect(typeof SCAN_BUDGET_REASON).toBe('string')
  expect(scanReason(command, undefined, undefined, CBAI_GATE, 50)).toBe(SCAN_BUDGET_REASON)
  expect(scanReason(command, undefined, undefined, CBAI_GATE)).toBeUndefined()
})

test('scanReason denies with SCAN_BUDGET_REASON, not BEADS_ACTOR_REASON, when touchesBeadsActor spends the budget (claude-factory-cbai)', () => {
  // denyAt spends 10 characters on the command. touchesBeadsActor needs 11 more.
  expect(scanReason('echo a b c', undefined, undefined, CBAI_GATE, 15)).toBe(SCAN_BUDGET_REASON)
  expect(scanReason('echo a b c', undefined, undefined, CBAI_GATE, 100)).toBeUndefined()
})

test('scanReason denies with SCAN_BUDGET_REASON when stringNamesBdCommand spends the budget (claude-factory-cbai)', () => {
  // denyAt spends 22 and touchesBeadsActor 21. The sh -c script needs 7 more. With the script
  // read for free, the bd word in it would give BEADS_ACTOR_REASON.
  const command = "env -i sh -c 'bd list'"
  expect(scanReason(command, undefined, undefined, CBAI_GATE, 45)).toBe(SCAN_BUDGET_REASON)
  expect(scanReason(command, undefined, undefined, CBAI_GATE, 1000)).toBe(BEADS_ACTOR_REASON)
})

test('denyReason spends the default work budget on an 8192-character stacked env -i eval command and denies, fast (claude-factory-cbai)', () => {
  const command = 'env -i eval '.repeat(700).slice(0, 8192)
  const { reason, ms } = cbaiTimed(command)
  expect(reason).toBe(SCAN_BUDGET_REASON)
  expect(ms).toBeLessThan(2000)
}, 30000)

// The verdicts of main (ee6b84d plus s1fj, where env -S sh -c is scanned) for each form, inner command and nest level n=1..8.
// a = allow, B = BEADS_ACTOR_REASON, D = PUSH_DIR_REASON, P = PUSH_REASON.
const CBAI_VERDICTS: [string, string][] = [
  ['envS|git push origin main', 'DDDDDDDD'],
  ['envS|git push', 'DDDDDDDD'],
  ['envS|git push origin', 'DDDDDDDD'],
  ['envS|git push --force origin HEAD:main', 'DDDDDDDD'],
  ['envS|bd list', 'aaaaaaaa'],
  ['envS|BEADS_ACTOR=x bd list', 'BBBBBBBB'],
  ['envS|env -u BEADS_ACTOR bd list', 'BBBBBBBB'],
  ['envS|echo hi', 'aaaaaaaa'],
  ['evalI|git push origin main', 'PPPPPPPP'],
  ['evalI|git push', 'aaaaaaaa'],
  ['evalI|git push origin', 'aaaaaaaa'],
  ['evalI|git push --force origin HEAD:main', 'PPPPPPPP'],
  ['evalI|bd list', 'BBBBBBBB'],
  ['evalI|BEADS_ACTOR=x bd list', 'BBBBBBBB'],
  ['evalI|env -u BEADS_ACTOR bd list', 'BBBBBBBB'],
  ['evalI|echo hi', 'aaaaaaaa'],
  ['envSsh|git push origin main', 'DDDDDDDD'],
  ['envSsh|git push', 'DDDDDDDD'],
  ['envSsh|git push origin', 'DDDDDDDD'],
  ['envSsh|git push --force origin HEAD:main', 'DDDDDDDD'],
  ['envSsh|bd list', 'aaaaaaaa'],
  ['envSsh|BEADS_ACTOR=x bd list', 'BBBBBBBB'],
  ['envSsh|env -u BEADS_ACTOR bd list', 'BBBBBBBB'],
  ['envSsh|echo hi', 'aaaaaaaa'],
]

test('denyReason keeps its pinned verdict for nested env -S, env -i eval and env -S sh -c forms (claude-factory-cbai)', () => {
  const forms: Record<string, (n: number, inner: string) => string> = {
    envS: cbaiEnvS,
    evalI: cbaiEvalI,
    envSsh: cbaiEnvSSh,
  }
  const label = (r: string | undefined) =>
    r === undefined
      ? 'a'
      : r === BEADS_ACTOR_REASON
        ? 'B'
        : r === PUSH_DIR_REASON
          ? 'D'
          : r === PUSH_REASON
            ? 'P'
            : '?'
  for (const [key, want] of CBAI_VERDICTS) {
    const [form, inner] = key.split('|') as [string, string]
    let got = ''
    for (let n = 1; n <= 8; n++) {
      got += label(denyReason(forms[form]!(n, inner), undefined, undefined, CBAI_GATE))
    }
    expect([key, got]).toEqual([key, want])
  }
})

const ESCAPED_REDIR_PREFIXES = ['\\>&', '\\>|', '\\<&', "'>'&", '">"&', "$'>'&"]

const DENY_ESCAPED_REDIR = [
  ...ESCAPED_REDIR_PREFIXES.flatMap(op => [
    `echo ${op}git push origin main`,
    `true ${op}git send-pack ../r.git main`,
  ]),
]

test.each(DENY_ESCAPED_REDIR)(
  'denyReason denies %j (claude-factory-cu5m.15, escaped redirect char)',
  denyWithPushReason,
)

test('denyReason keeps the gh merge deny after an escaped redirect (claude-factory-cu5m.15)', () => {
  expect(denyReason('echo \\>&gh pr merge 5')).toBeDefined()
})

// claude-factory-p43v: a dynamic word at the git verb slot hides the real command. gitReason now
// denies that word first, with DYNAMIC_VERB_REASON.
const P43V_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }

// AC1: a dynamic word at the git verb slot.
const DENY_DYNAMIC_GIT_VERB = [
  'V=push; git $V o main',
  'git "$V" o main',
  'git ${V} o main',
  'git $(echo push) o main',
  'git "$(echo push)" o main',
  'git {push,} o main',
  'git pu?h o main',
  'git pu*h o main',
  'git pu[s]h o main',
  'git ~ o main',
  'git $FLAGS push o main',
  'git-$V o main',
  'eval "git $V o main"',
  "sh -c 'git $V o main'",
]

test.each(DENY_DYNAMIC_GIT_VERB)(
  'denyReason denies %j (claude-factory-p43v.1 AC1: a dynamic word at the git verb slot fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// AC2: the c63 class. The dynamic-verb check in the first git segment denies before the
// branch-change/head-push scan reaches the later, literal `git push` segment.
test('denyReason denies the c63-class command with a dynamic verb (claude-factory-p43v.1 AC2)', () => {
  expect(denyReason('V=checkout; git $V main; git push o HEAD', '/x', undefined, P43V_GATE)).toBe(
    DYNAMIC_VERB_REASON,
  )
})

// AC9: no over-deny. A dynamic word in an argument slot, not the verb slot, stays allowed.
const ALLOW_DYNAMIC_WORD_NOT_AT_VERB_SLOT = [
  'for f in a b; do git add $f; done',
  'git log $REF',
  'git diff "$BASE"...HEAD',
  'git commit -m "$MSG"',
  'git commit -m "$(cat m)"',
  'git commit -m $(cat m)',
  'git -C "$WT" status',
  'git -C "$WT" checkout -b x',
  'X=$(git rev-parse HEAD)',
  'git checkout "$B"',
]

test.each(ALLOW_DYNAMIC_WORD_NOT_AT_VERB_SLOT)(
  'denyReason allows %j (claude-factory-p43v.1 AC9: a dynamic word off the verb slot is not the verb)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// AC3: segments() keeps an unquoted opening backtick as a marker in the word it ends. The
// backtick then reaches the git verb slot through the usual dynamic-word check.
test('denyReason denies a backtick command substitution at the git verb slot (claude-factory-p43v.2 AC3)', () => {
  expect(denyReason('git `echo push` o main', '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

// AC4: a dynamic word at the gh verb slot, or at the pr/repo/alias subcommand slot, fails closed.
const DENY_DYNAMIC_GH_VERB = [
  'gh $V merge 5',
  'gh "$V" pr merge 5',
  'gh pr $V 5',
  'gh pr "$V" 5',
  'gh repo $S',
  'gh alias $S p pr all',
]

test.each(DENY_DYNAMIC_GH_VERB)(
  'denyReason denies %j (claude-factory-p43v.3 AC4: a dynamic word at the gh verb or sub slot fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason denies "gh pr $S 5; git push o HEAD" (claude-factory-p43v.3 AC4: a dynamic gh sub slot denies even with a later git push)', () => {
  expect(denyReason('gh pr $S 5; git push o HEAD', '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

// gh commands with a dynamic word off the verb/sub slot stay allowed (no over-deny).
const ALLOW_DYNAMIC_GH_WORD_NOT_AT_VERB_SLOT = ['gh pr view $N', 'gh pr create --title "$T" --body-file f']

test.each(ALLOW_DYNAMIC_GH_WORD_NOT_AT_VERB_SLOT)(
  'denyReason allows %j (claude-factory-p43v.3 AC4: a dynamic word off the gh verb/sub slot is not the verb)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// AC5: a dynamic argument to a branch-change verb sets state.branchChange. Paired with a later
// HEAD push, the whole command denies with PUSH_REASON, the c63 rule, even though neither
// segment alone denies.
const DENY_DYNAMIC_BRANCH_CHANGE_ARG_THEN_HEAD_PUSH = [
  'git stash $V main; git push o HEAD',
  'git bisect $V; git push o HEAD',
  'git branch $F main; git push o HEAD',
  'git rebase $X; git push o HEAD',
  'git update-ref HEAD $R; git push o HEAD',
]

test.each(DENY_DYNAMIC_BRANCH_CHANGE_ARG_THEN_HEAD_PUSH)(
  'denyReason denies %j (claude-factory-p43v.4 AC5: a dynamic branch-change arg then a HEAD push fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(PUSH_REASON)
  },
)

// Each AC5 command, with no later push, stays allowed: branchChange alone never denies.
const ALLOW_DYNAMIC_BRANCH_CHANGE_ARG_NO_PUSH = ['git stash $V', 'git rebase "$BASE"', 'git branch $F']

test.each(ALLOW_DYNAMIC_BRANCH_CHANGE_ARG_NO_PUSH)(
  'denyReason allows %j (claude-factory-p43v.4 AC5: a dynamic branch-change arg with no push stays allowed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// AC6: a dynamic git config key fails closed, with DYNAMIC_VERB_REASON: isPushConfigWrite cannot
// check a key this guard cannot read.
const DENY_DYNAMIC_GIT_CONFIG_KEY = [
  'git config $K push',
  'git config $S alias.p push',
  'git config set $K push',
]

test.each(DENY_DYNAMIC_GIT_CONFIG_KEY)(
  'denyReason denies %j (claude-factory-p43v.4 AC6: a dynamic git config key fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows git config user.name "$N" (claude-factory-p43v.4 AC6: a literal key with a dynamic value stays allowed)', () => {
  expect(denyReason('git config user.name "$N"', '/x', undefined, P43V_GATE)).toBeUndefined()
})

// AC7: a dynamic command word can hide the real command. Each row has no literal git or gh
// word before the dynamic word. The next non-flag word is a trigger word, such as push, pr or
// config. No wrapper name on this list strips the dynamic word by name.
const DENY_DYNAMIC_COMMAND_WORD = [
  'G=git; $G push o main',
  '"$GIT" push o main',
  'sudo $G push o main',
  'watch $G push o main',
  'timeout 5 $G push o main',
  '$X 5 $G push o main',
  '$G -C x push o main',
  '$G -c alias.p=push p o main',
  '$GH pr merge 5',
]

test.each(DENY_DYNAMIC_COMMAND_WORD)(
  'denyReason denies %j (claude-factory-p43v.5 AC7: a dynamic command word before a guarded verb fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// AC8: a command substitution or backtick expression at the command slot. segments() ends the
// word there (claude-factory-p43v.2), so the whole segment reduces to a bare `$` or a
// backtick-marked word. That alone denies, with no need to read the trailing words.
const DENY_SUBSTITUTION_OPENER = [
  '$(which git) push o main',
  'sudo $(which git) push o main',
  '`which git` push o main',
]

test.each(DENY_SUBSTITUTION_OPENER)(
  'denyReason denies %j (claude-factory-p43v.5 AC8: a substitution opener at the command slot fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// AC9 (more rows): a dynamic command word scan must not deny a loop variable, a value flag's own
// value, or a command this guard already denies for another reason with its old reason.
const ALLOW_OR_UNCHANGED_DYNAMIC_COMMAND_WORD: Array<[string, string | undefined]> = [
  ['for f in a b; do git add $f; done', undefined],
  ['git log $REF', undefined],
  ['git diff "$BASE"...HEAD', undefined],
  ['git commit -m "$MSG"', undefined],
  ['git commit -m "$(cat m)"', undefined],
  ['git commit -m $(cat m)', undefined],
  ['gh pr view $N', undefined],
  ['gh pr create --title "$T" --body-file f', undefined],
  ['git -C "$WT" status', undefined],
  ['git -C "$WT" checkout -b x', undefined],
  ['X=$(git rev-parse HEAD)', undefined],
  ['bd update $ID -s in_progress', undefined],
  ['"$HOME/.local/bin/claude" plugin test mod', undefined],
  ['"$PY" -c \'print(1)\'', undefined],
  ['echo $(date)', undefined],
  ['git checkout "$B"', undefined],
  ['cp "$A" "$B"', undefined],
  ['git push origin "$BR"', PUSH_REASON],
  ['git -C "$D" push o main', PUSH_REASON],
]

test.each(ALLOW_OR_UNCHANGED_DYNAMIC_COMMAND_WORD)(
  'denyReason keeps its old verdict for %j (claude-factory-p43v.5 AC9: no over-deny from the dynamic command word scan)',
  (cmd, reason) => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(reason)
  },
)

// AC11 (claude-factory-p43v.6): a dynamic word at the kubectl, ko or helm verb slot fails
// closed. The same holds for a dynamic word at the kubectl rollout, auth or certificate sub
// slot. The context check then decides, the same way it decides for a listed mutating verb.
const DENY_DYNAMIC_LIVE_APPLY_VERB = [
  'kubectl $V -f x --context acme',
  'kubectl rollout $S deploy/x --context acme',
  'ko $V -f x --context acme',
  'helm $V r c --kube-context acme',
]

test.each(DENY_DYNAMIC_LIVE_APPLY_VERB)(
  'denyReason denies %j with personOnly acme (claude-factory-p43v.6 AC11: a dynamic kubectl/ko/helm verb or sub fails closed)',
  cmd => {
    expect(denyReason(cmd, undefined, ACME)).toBe(LIVE_REASON)
  },
)

test('denyReason allows kubectl $V -f x --context kind-x with personOnly acme (claude-factory-p43v.6 AC11: an unlisted context stays allowed)', () => {
  expect(denyReason('kubectl $V -f x --context kind-x', undefined, ACME)).toBeUndefined()
})

// claude-factory-p43v.8: two dynamic words in a row hide the wrapper word and the verb.
const DENY_TWO_DYNAMIC_COMMAND_WORDS = [
  'G=git V=push; $G $V origin main',
  '$G ${V} origin main',
  '"$G" "$V" origin main',
]

test.each(DENY_TWO_DYNAMIC_COMMAND_WORDS)(
  'denyReason denies %j (claude-factory-p43v.8: two dynamic words in a row hide git and its verb)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.8 AC9: a dynamic word after a literal command word is an argument, not a second command word.
const ALLOW_TWO_DYNAMIC_COMMAND_WORDS = ['cp "$A" "$B"', '"$PY" -c \'print(1)\'']

test.each(ALLOW_TWO_DYNAMIC_COMMAND_WORDS)(
  'denyReason allows %j (claude-factory-p43v.8: no over-deny from the two-dynamic-word check)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.9: a dynamic git -c or --config-env key hides a push config write.
const DENY_DYNAMIC_DASH_C_KEY = [
  'git -c $K=push p origin main',
  'git -c "$K"=push p origin main',
  'git --config-env=$K=E p origin main',
]

test.each(DENY_DYNAMIC_DASH_C_KEY)(
  'denyReason denies %j (claude-factory-p43v.9: a dynamic -c/--config-env key fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason denies git -c user.name="$N" push origin main with PUSH_REASON, not DYNAMIC_VERB_REASON (claude-factory-p43v.18: a literal key with a dynamic value)', () => {
  expect(denyReason('git -c user.name="$N" push origin main', '/x', undefined, P43V_GATE)).toBe(PUSH_REASON)
})

// claude-factory-p43v.10: a dynamic command word before a mutating kubectl, ko or helm verb hides it.
const DENY_DYNAMIC_LIVE_APPLY_COMMAND_WORD = [
  'K=kubectl; $K apply -f x --context acme',
  '$K delete pod x --context acme',
]

test.each(DENY_DYNAMIC_LIVE_APPLY_COMMAND_WORD)(
  'denyReason denies %j with personOnly acme, with DYNAMIC_VERB_REASON not LIVE_REASON (claude-factory-p43v.10/.17: a dynamic command word before a mutating kubectl/ko/helm verb fails closed)',
  cmd => {
    expect(denyReason(cmd, undefined, ACME)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows $K apply -f x --context kind-x with personOnly acme (claude-factory-p43v.10: an unlisted context stays allowed)', () => {
  expect(denyReason('$K apply -f x --context kind-x', undefined, ACME)).toBeUndefined()
})

// claude-factory-p43v.11: a dynamic gh api endpoint or method hides a merge or push call.
const DENY_DYNAMIC_GH_API = [
  'gh api repos/acme/widget/pulls/1/$M -X PUT',
  'gh api $E -X PUT',
  'gh api -X $X repos/acme/widget/pulls/1/merge',
]

test.each(DENY_DYNAMIC_GH_API)(
  'denyReason denies %j (claude-factory-p43v.11: a dynamic gh api endpoint or method fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows gh api repos/acme/widget/pulls/$N (claude-factory-p43v.11: a GET of a dynamic endpoint stays allowed)', () => {
  expect(denyReason('gh api repos/acme/widget/pulls/$N', '/x', undefined, P43V_GATE)).toBeUndefined()
})

test('denyReason allows gh api $E -X GET (claude-factory-p43v.11: an explicit GET of a dynamic endpoint stays allowed)', () => {
  expect(denyReason('gh api $E -X GET', '/x', undefined, P43V_GATE)).toBeUndefined()
})

// claude-factory-p43v.13: a `-c`/`--config-env` pair can be dynamic as a whole.
// It then has no literal `=` for gitDashCKeyDynamic to split on. It hides the key.
const DENY_DYNAMIC_DASH_C_PAIR = [
  'git -c "$KV" p origin main',
  'git -c $KV p origin main',
  'git --config-env=$KE p origin main',
]

test.each(DENY_DYNAMIC_DASH_C_PAIR)(
  'denyReason denies %j (claude-factory-p43v.13: a dynamic -c/--config-env pair with no literal = fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.14: a dynamic -c key can follow a dynamic command word.
// `anyDynamicCommandReason`'s own -c check compared the key only against a fixed name list.
const DENY_DYNAMIC_COMMAND_DASH_C_KEY = ['$G -c $K=push p origin main', '$G -c "$KV" p origin main']

test.each(DENY_DYNAMIC_COMMAND_DASH_C_KEY)(
  'denyReason denies %j (claude-factory-p43v.14: a dynamic -c key after a dynamic command word fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.15: a shell reserved word (do, then, if, !) can sit before the dynamic
// command word. It then moves the dynamic word off cmd[0]. The p43v.8 and p43v.10 anchors miss it.
const DENY_DYNAMIC_COMMAND_AFTER_RESERVED_WORD = [
  'for f in a; do $G $V origin main; done',
  'if true; then $G $V origin main; fi',
  'while true; do $G $V origin main; done',
  '! $G $V origin main',
  'if $G $V origin main; then :; fi',
  'for f in a; do $G -c $K=push p origin main; done',
]

test.each(DENY_DYNAMIC_COMMAND_AFTER_RESERVED_WORD)(
  'denyReason denies %j (claude-factory-p43v.15: a shell reserved word before the dynamic command word still fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

const DENY_DYNAMIC_LIVE_APPLY_AFTER_RESERVED_WORD = [
  'if true; then $K apply -f x --context acme; fi',
  '! $K apply -f x --context acme',
]

test.each(DENY_DYNAMIC_LIVE_APPLY_AFTER_RESERVED_WORD)(
  'denyReason denies %j with personOnly acme (claude-factory-p43v.15: a shell reserved word before the dynamic live-apply word still fails closed)',
  cmd => {
    expect(denyReason(cmd, undefined, ACME)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows cp "$A" "$B" (claude-factory-p43v.15: no over-deny from the reserved-word skip)', () => {
  expect(denyReason('cp "$A" "$B"', '/x', undefined, P43V_GATE)).toBeUndefined()
})

test('denyReason allows for f in *.ts; do git add $f; done (claude-factory-p43v.15: a loop over an argument still allows)', () => {
  expect(denyReason('for f in *.ts; do git add $f; done', '/x', undefined, P43V_GATE)).toBeUndefined()
})

// claude-factory-p43v.16: a dynamic word can sit before a kubectl rollout, auth or certificate
// sub-verb. Each case hid a live-apply call.
// An unknown wrapper, such as caffeinate, can also push a dynamic word past position 0.
// anyLiveApplyWord never finds a word that is not a literal kubectl, ko or helm name.
const DENY_DYNAMIC_LIVE_APPLY_SUBVERB = [
  '$K rollout restart deploy/x --context acme',
  '$K rollout undo deploy/x --context acme',
  '$K certificate approve x --context acme',
  '$K auth reconcile -f x --context acme',
  'caffeinate $K apply -f x --context acme',
]

test.each(DENY_DYNAMIC_LIVE_APPLY_SUBVERB)(
  'denyReason denies %j with personOnly acme (claude-factory-p43v.16: a dynamic word before a kubectl sub-verb, or behind an unknown wrapper, fails closed)',
  cmd => {
    expect(denyReason(cmd, undefined, ACME)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows $K apply -f x --context kind-x with personOnly acme (claude-factory-p43v.16: an unlisted context stays allowed)', () => {
  expect(denyReason('$K apply -f x --context kind-x', undefined, ACME)).toBeUndefined()
})

test('denyReason allows $K get pods --context acme with personOnly acme (claude-factory-p43v.16: a read-only verb stays allowed)', () => {
  expect(denyReason('$K get pods --context acme', undefined, ACME)).toBeUndefined()
})

// claude-factory-p43v.17: a dynamic word with no --context can sit before "install" or "run".
// Those match a helm or ko verb. The old code denied this with LIVE_REASON.
// That reason names kubectl, ko or helm. The hook read none of those 3 words here.
const DENY_DYNAMIC_UNNAMED_TOOL = ['$PIP install requests', '"$NPM" install']

test.each(DENY_DYNAMIC_UNNAMED_TOOL)(
  'denyReason denies %j with personOnly acme, with DYNAMIC_VERB_REASON not LIVE_REASON (claude-factory-p43v.17)',
  cmd => {
    expect(denyReason(cmd, undefined, ACME)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.19: a wrapper flag, or coproc, can sit between the wrapper name and the
// dynamic command-word pair. The old realCommand stopped at the wrapper's first flag.
// It then read the flag word as cmd[0]. It missed the pair check from claude-factory-p43v.8.
const DENY_DYNAMIC_PAIR_AFTER_WRAPPER_FLAGS = [
  'sudo -u x $G $V o main',
  'sudo -g x $G $V o main',
  'env -i $G $V o main',
  'nice -n 5 $G $V o main',
  'time -p $G $V o main',
  'exec -a x $G $V o main',
  'timeout -s KILL 5 $G $V o main',
  'command -p $G $V o main',
  'coproc $G $V o main',
  'sudo -u x $GH $V merge 5',
]

test.each(DENY_DYNAMIC_PAIR_AFTER_WRAPPER_FLAGS)(
  'denyReason denies %j (claude-factory-p43v.19: a wrapper flag or coproc hides the dynamic command-word pair)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows cp "$A" "$B" after a wrapper flag fix (claude-factory-p43v.19: no over-deny)', () => {
  expect(denyReason('sudo -u x cp "$A" "$B"', '/x', undefined, P43V_GATE)).toBeUndefined()
})

test('denyReason allows "$PY" -c \'print(1)\' (claude-factory-p43v.19: no over-deny)', () => {
  expect(denyReason('sudo -u x "$PY" -c \'print(1)\'', '/x', undefined, P43V_GATE)).toBeUndefined()
})

// claude-factory-p43v.20: `--config-env` after a dynamic command word hides a push config write,
// the same way a dynamic `-c` key does (claude-factory-p43v.14). The attached form
// (`--config-env=name=envvar`) and the two-word form (`--config-env name=envvar`, real git 2.54
// accepts both) must both fail closed.
const DENY_DYNAMIC_CONFIG_ENV_AFTER_COMMAND_WORD = [
  '$G --config-env=alias.p=E p o main',
  '$G --config-env=$K=E p o main',
  '$G --config-env="$KE" p o main',
  '$G --config-env alias.p=E p o main',
]

test.each(DENY_DYNAMIC_CONFIG_ENV_AFTER_COMMAND_WORD)(
  'denyReason denies %j (claude-factory-p43v.20: a dynamic command word before --config-env fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows $G --config-env=user.name=MYNAME p o main (claude-factory-p43v.20: a non-push key stays allowed)', () => {
  expect(denyReason('$G --config-env=user.name=MYNAME p o main', '/x', undefined, P43V_GATE)).toBeUndefined()
})

// claude-factory-p43v.21 AC13: an unknown flag of a known wrapper also hides the dynamic
// command-word pair. commandAnchors walks past every flag shape, known or not.
const DENY_UNKNOWN_WRAPPER_FLAG_PAIR = [
  'sudo -E $G $V o main',
  'sudo -n $G $V o main',
  'sudo -H $G $V o main',
  'sudo -ux $G $V o main',
  'sudo --user=x $G $V o main',
  'sudo --user x $G $V o main',
  'sudo -nE $G $V o main',
  'sudo --preserve-env $G $V o main',
  'sudo -u x -E $G $V o main',
  'sudo -E $GH $V merge 5',
  'env -v $G $V o main',
  'env --ignore-environment $G $V o main',
  'nice -5 $G $V o main',
  'nice -n5 $G $V o main',
  'nice --adjustment=5 $G $V o main',
  'timeout --signal=KILL 5 $G $V o main',
  'timeout -sKILL 5 $G $V o main',
  'timeout -v 5 $G $V o main',
  'timeout --preserve-status 5 $G $V o main',
  'exec -cl $G $V o main',
  '/usr/bin/time -l $G $V o main',
]

test.each(DENY_UNKNOWN_WRAPPER_FLAG_PAIR)(
  'denyReason denies %j (claude-factory-p43v.21 AC13: an unlisted wrapper flag still hides the dynamic command-word pair)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.21 AC14: a $(...) or backtick substitution can stand for `git` behind an
// unknown wrapper flag. A dynamic word before a live-apply verb, behind an unknown wrapper flag,
// also fails closed. `$K apply -f x` with no `--context` already denies on its own. A wrapper
// flag must not undo that deny.
const DENY_UNKNOWN_WRAPPER_FLAG_PLAN_PROBE = [
  'sudo -E $(which git) push o main',
  'sudo -E `which git` push o main',
  'sudo -E $K apply -f x',
]

test.each(DENY_UNKNOWN_WRAPPER_FLAG_PLAN_PROBE)(
  'denyReason denies %j with personOnly acme (claude-factory-p43v.21 AC14: a substitution or live-apply word behind an unknown wrapper flag still fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.21 AC15: a generated matrix. Every WRAPPER x FLAGSHAPE x PAYLOAD cell must
// deny. Z, Y and zz name flags no wrapper has.
const AC15_WRAPPERS = [
  'sudo',
  '/usr/bin/sudo',
  'env',
  'nice',
  'time',
  '/usr/bin/time',
  'exec',
  'command',
  'nohup',
  'timeout 5',
  'xargs',
]
const AC15_FLAG_SHAPES = ['', '-Z', '-Z v', '-ZY', '--zz', '--zz=v', '--zz v', '-Z --']
const AC15_DYNAMIC_PAYLOADS = [
  '$G $V o main',
  '"$G" "${V}" o main',
  '$GH $V merge 5',
  '$(which git) push o main',
  '`which git` push o main',
  '$K apply -f x',
  '$K rollout restart deploy/x --context acme',
]
const AC15_MATRIX: string[] = []
for (const wrapper of AC15_WRAPPERS) {
  for (const flags of AC15_FLAG_SHAPES) {
    for (const payload of AC15_DYNAMIC_PAYLOADS) {
      AC15_MATRIX.push([wrapper, flags, payload].filter(p => p.length > 0).join(' '))
    }
  }
}

test.each(AC15_MATRIX)(
  'denyReason denies %j with personOnly acme (claude-factory-p43v.21 AC15: every wrapper x flag-shape x dynamic-payload cell fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.21 AC16: the same matrix, with a safe payload, must stay allowed.
const AC16_SAFE_PAYLOADS = ['ls', 'cp a b', '"$PY" -c x']
const AC16_MATRIX: string[] = []
for (const wrapper of AC15_WRAPPERS) {
  for (const flags of AC15_FLAG_SHAPES) {
    for (const payload of AC16_SAFE_PAYLOADS) {
      AC16_MATRIX.push([wrapper, flags, payload].filter(p => p.length > 0).join(' '))
    }
  }
}

test.each(AC16_MATRIX)(
  'denyReason allows %j with personOnly acme (claude-factory-p43v.21 AC16: a safe payload behind any wrapper flag shape stays allowed)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.21 AC16: named no-over-deny rows. Each dynamic word here is not a second
// command word in a pair.
const ALLOW_WRAPPER_NO_OVER_DENY = [
  'sudo -u x cp "$A" "$B"',
  'env -i "$PY" -c x',
  'sudo -u x ls',
  'cp "$A" "$B"',
  '"$PY" -c x',
  'for f in *.ts; do git add $f; done',
  'sudo -E ls -la',
  'nice -n 5 make test',
  'timeout 30 bun test',
]

test.each(ALLOW_WRAPPER_NO_OVER_DENY)(
  'denyReason allows %j (claude-factory-p43v.21 AC16: no over-deny from the wrapper-flag chase)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.21: this is an accepted fail-closed deny, not an over-deny. An unknown
// flag can take the next word as its own value. Maybe `v` is the value of `-Z`, and `cp` is the
// real command. The hook cannot tell `sudo -Z v cp "$A" "$B"` apart from that case.
const ACCEPTED_FAIL_CLOSED_DENY = [
  'sudo -E cp "$A" "$B"',
  'sudo -Z v cp "$A" "$B"',
  'sudo --zz v cp "$A" "$B"',
]

test.each(ACCEPTED_FAIL_CLOSED_DENY)(
  'denyReason denies %j (claude-factory-p43v.21: an unknown flag that could take a value, before a dynamic pair, fails closed)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.21: the chase stops at a plain word with no dynamic word after it. A `--`
// word also stops the chase at once.
const ALLOW_WRAPPER_CHASE_STOPS = ['sudo -Z v ls', 'sudo -Z v cp a b', 'sudo -Z -- cp "$A" "$B"']

test.each(ALLOW_WRAPPER_CHASE_STOPS)(
  'denyReason allows %j (claude-factory-p43v.21: the wrapper-flag chase stops at a plain word with no dynamic word after it)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.22: `coproc NAME { cmd; }` names the coprocess. `NAME` is a plain word,
// not the real command. commandAnchors skips it too.
test('denyReason denies coproc NAME { $G $V o main; } (claude-factory-p43v.22: a coproc name before a brace group still hides the dynamic command-word pair)', () => {
  expect(denyReason('coproc NAME { $G $V o main; }', '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason denies coproc NAME { git push o main; } with PUSH_REASON (claude-factory-p43v.22: a literal push behind a coproc name keeps its own reason)', () => {
  expect(denyReason('coproc NAME { git push o main; }', '/x', undefined, P43V_GATE)).toBe(PUSH_REASON)
})

// claude-factory-p43v.25: `env` and `sudo` both read a `NAME=value` word after their own name, or
// after their own flags, as an environment variable to set for the real command. commandAnchors
// must skip that word too, the same way it skips one before the wrapper's own name.
const DENY_WRAPPER_NAME_EQUALS_VALUE = [
  'env A=1 $G $V o main',
  'sudo A=1 $G $V o main',
  'env -i A=1 B=2 $G $V o main',
  'env A=1 $(which git) push o main',
  'nohup env A=1 $G $V o main',
]

test.each(DENY_WRAPPER_NAME_EQUALS_VALUE)(
  'denyReason denies %j (claude-factory-p43v.25: a NAME=value operand after a wrapper still hides the dynamic pair)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

const ALLOW_WRAPPER_NAME_EQUALS_VALUE_SAFE_PAYLOAD = ['env A=1 ls', 'env A=1 cp "$A" "$B"']

test.each(ALLOW_WRAPPER_NAME_EQUALS_VALUE_SAFE_PAYLOAD)(
  'denyReason allows %j (claude-factory-p43v.25: no over-deny from the NAME=value skip)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.26: `timeout`'s own duration word can follow its own `--`, the same way it
// can follow a known or an unknown flag. commandAnchors must skip it there too.
const DENY_TIMEOUT_DASHDASH_DURATION = ['timeout -- 5 $G $V o main', 'timeout -s KILL -- 5 $G $V o main']

test.each(DENY_TIMEOUT_DASHDASH_DURATION)(
  'denyReason denies %j (claude-factory-p43v.26: timeout -- DURATION still hides the dynamic pair)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason allows timeout -- 30 bun test (claude-factory-p43v.26: no over-deny from the timeout -- duration skip)', () => {
  expect(denyReason('timeout -- 30 bun test', '/x', undefined, P43V_GATE)).toBeUndefined()
})

// claude-factory-p43v.27: MAX_COMMAND_ANCHORS caps the number of candidates the wrapper-flag
// chase adds. A long run of unknown flag/value pairs can use up that cap before the chase
// reaches the real dynamic word. commandAnchors must fall back to a single forward scan.
test('denyReason denies sudo with 16 unknown -R / pairs before $G $V o main (claude-factory-p43v.27: the MAX_COMMAND_ANCHORS cap still finds the dynamic pair)', () => {
  const cmd = 'sudo ' + '-R / '.repeat(16) + '$G $V o main'
  expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason denies sudo with 8 real sudo value-flag pairs before $G $V o main (claude-factory-p43v.27: known value flags also exhaust the cap)', () => {
  const cmd = 'sudo ' + '-R / -t 5 '.repeat(8) + '-R / $G $V o main'
  expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason denies the AC19 wrapper-lead bench shape (claude-factory-p43v.27: sudo with 1024 unknown -Z v pairs before $G $V o main)', () => {
  const cmd = 'sudo ' + '-Z v '.repeat(1024) + '$G $V o main'
  expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

// A bare `{}` word is not dynamic at the command slot. No shell expands this word there.
// `denyReason` must not read `cp` or `delete` after `{}` as a kubectl verb that changes
// data. The command `xargs -I {}` puts `{}` at this slot. `denyReason` must not deny this
// kind of `xargs` command, even with no real call to `git`, `gh`, `kubectl`, `ko` or
// `helm`. This rule has the id claude-factory-p43v.28.
//
// `{}` is still dynamic outside the command slot. `commandAnchors` must read `{}` as not
// dynamic only at the command slot. The `cmd[0]` check in `anyDynamicCommandReason` must
// do the same. The `cmd[0]` check in `anyDynamicLiveApplyReason` must do the same. This
// rule is in `dynamicCommandWord`, in `src/worker-hook.ts`. The rows below must still
// pass after this fix. This rule has the id claude-factory-p43v.29.
//
// `denyAt` calls `anyDynamicLiveApplyReason` only when `personOnly?.length` is true. The rows
// below must set `personOnly` to `ACME`. They must not set `personOnly` to `undefined`. The
// value `ACME` makes the test run the part of the code that had the bug. The value
// `undefined` does not make the test run this part of the code.
const ALLOW_XARGS_BARE_BRACES = [
  'xargs -I {} cp {} dest',
  'git ls-files | xargs -I {} cp {} out/',
  'xargs -I {} cp {} "$D"',
  'xargs -I{} cp {} "$D"',
  'xargs -I {} delete {}',
]

test.each(ALLOW_XARGS_BARE_BRACES)(
  'denyReason allows %j with personOnly acme (claude-factory-p43v.28/.29: {} at the command slot is not dynamic)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBeUndefined()
  },
)

test('denyReason denies git {push,} o main (claude-factory-p43v.28: a brace word with text inside it stays dynamic)', () => {
  expect(denyReason('git {push,} o main', '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

// claude-factory-p43v.29: p43v.28 made `dynamicWord('{}')` give `false` for every caller. That
// stopped the `xargs -I {}` over-deny, but it also let `{}` hide a real `git` or `gh` verb, with
// `find -exec` or `xargs -I {}` filling it in at run time. `dynamicCommandWord` is the real fix:
// `{}` stays dynamic in `dynamicWord` itself, and only the command-slot checks that gave the
// over-deny read `{}` as not dynamic.
const DENY_BRACE_COMMAND_WORD = [
  'find push -maxdepth 0 -exec git {} origin main ;',
  'find . -exec git {} o main +',
  'git {} o main',
  '{} push o main',
  'sh -c "git {} o main"',
  'find merge -maxdepth 0 -exec gh pr {} 5 ;',
]

test.each(DENY_BRACE_COMMAND_WORD)(
  'denyReason denies %j (claude-factory-p43v.29: a {} word at the command or verb slot stays dynamic)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.30: `env` and `sudo` read any `NAME=value` operand as an assignment, not
// only one shaped like a shell identifier. A name with a dot, a dash or a leading digit, or an
// assignment after a literal `--`, used to reach the wrapper's own flag-value slot and hide the
// dynamic pair behind it.
const DENY_WIDE_ASSIGNMENT_OPERAND = [
  'env a.b=1 $G $V o main',
  'env a-b=1 $G $V o main',
  'env 1A=x $G $V o main',
  'env -i a.b=1 $G $V o main',
  'sudo a.b=1 $G $V o main',
  'env -- A=1 $G $V o main',
  'sudo -- A=1 $G $V o main',
]

test.each(DENY_WIDE_ASSIGNMENT_OPERAND)(
  'denyReason denies %j (claude-factory-p43v.30: a wide NAME=value operand still hides the dynamic pair)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

const ALLOW_WIDE_ASSIGNMENT_OPERAND = ['env a.b=1 ls', 'env A=1 ls', 'env A=1 cp "$A" "$B"']

test.each(ALLOW_WIDE_ASSIGNMENT_OPERAND)(
  'denyReason allows %j (claude-factory-p43v.30: no over-deny from the wider NAME=value skip)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.31: `timeout` always takes one duration operand, right after its own flags
// or its own `--`. The old shape test missed GNU `timeout`'s own `1e1` and `inf` forms. This hook
// now skips that one operand outright, whatever shape it has, so it cannot hide the dynamic pair
// behind it.
const DENY_TIMEOUT_ANY_DURATION_SHAPE = [
  'timeout 1e1 $G $V o main',
  'timeout inf $G $V o main',
  'timeout -- 1e1 $G $V o main',
]

test.each(DENY_TIMEOUT_ANY_DURATION_SHAPE)(
  'denyReason denies %j (claude-factory-p43v.31: timeout skips its duration operand whatever its shape)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

const ALLOW_TIMEOUT_ANY_DURATION_SHAPE = ['timeout 30 bun test', 'timeout -- 30 bun test']

test.each(ALLOW_TIMEOUT_ANY_DURATION_SHAPE)(
  'denyReason allows %j (claude-factory-p43v.31: no over-deny from the wider timeout duration skip)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.32: the chase in `commandAnchors` used to stop right after it added a
// dynamic word, even when that word was only an unknown flag's own value, or itself a known
// wrapper's name. Either case can hide the real dynamic pair deeper in the command.
const DENY_CHASE_PAST_NESTED_WRAPPER = [
  'sudo -Z "$P" env $G $V o main',
  'sudo -Z $P env $(which git) push o main',
]

test.each(DENY_CHASE_PAST_NESTED_WRAPPER)(
  'denyReason denies %j (claude-factory-p43v.32: the chase restarts at a nested wrapper, in place of stopping on its name)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

function pad17Flags(): string {
  const parts: string[] = []
  for (let n = 0; n <= 16; n++) parts.push(`-z${n}`, `v${n}`)
  return parts.join(' ')
}

const DENY_CHASE_PAST_CAP_SKIPS_FLAGS = [
  `sudo ${pad17Flags()} --x=$P 1 $G $V o main`,
  `sudo ${pad17Flags()} -p $P 1 $G $V o main`,
]

test.each(DENY_CHASE_PAST_CAP_SKIPS_FLAGS)(
  'denyReason denies %j (claude-factory-p43v.32: the post-cap scan skips flag words and keeps looking for a true dynamic pair)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

const ALLOW_CHASE_PAST_NESTED_WRAPPER = ['sudo -u x cp "$A" "$B"', 'env -i "$PY" -c x']

test.each(ALLOW_CHASE_PAST_NESTED_WRAPPER)(
  'denyReason allows %j (claude-factory-p43v.32: no over-deny from the chase restart or the post-cap pair scan)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-p43v.32: a long run of `-Z v env` repeats used to restart the chase once per
// repeat, with no cap on how many times. `commandAnchors` grew `anchors` by 2 for each repeat,
// with no bound, so a caller that re-slices `words` once per anchor paid O(n^2) for an O(n) input.
// This test proves the cap now applies to that restart path too: it must finish well inside the
// hook's 10 s fail-open timeout, with a wide margin, on a load-noisy CI runner.
test('denyReason finishes quickly on a long sudo -Z v env chain (claude-factory-p43v.32: the restart path is capped, no O(n^2) blowup)', () => {
  const cmd = 'sudo ' + '-Z $P env '.repeat(500) + '$G $V o main'
  const t0 = performance.now()
  const r = denyReason(cmd, '/x', undefined, P43V_GATE)
  const ms = performance.now() - t0
  expect(r).toBe(DYNAMIC_VERB_REASON)
  expect(ms).toBeLessThan(2000)
})

// claude-factory-p43v.33: before this change, `scanForFirstDynamicPair` added an anchor only
// for a correct pair, 2 dynamic words next to each other. After the `MAX_COMMAND_ANCHORS` cap,
// a payload with only 1 dynamic word did not get an anchor.
//
// Each row below has only 1 dynamic word after the cap, with 1 or more literal words after it.
// This literal part can be a resolved binary from `$(which git)`. Special code in `segments()`
// for parentheses can divide this binary into 2 pieces.
//
// The 1 dynamic word can also be a command word on its own (`$K`, `$G`, or `$GH`), before a
// literal verb or flag.
//
// `R33` repeats the flag `-R` many times. `-R` is a real `sudo` flag, for "run as this role".
// This hook's `WRAPPER_VALUE_FLAGS.sudo` does not list `-R` as a value flag or as a bare flag.
//
// So each `-R /` pair stays unknown to `commandAnchors`, and the chase runs past the cap.
//
// `N33` repeats `-Z v env` many times. The chase restarts at each nested `env`, so these rows
// go through the cap's other exit, inside the nested-wrapper branch.
const R33 = '-R / '.repeat(16)
const N33 = '-Z v env '.repeat(9)

const DENY_PAST_CAP_SINGLE_DYNAMIC_WORD = [
  `sudo ${R33}$(which git) push o main`,
  'sudo ' + R33 + '`which git` push o main',
  `sudo ${R33}$K apply -f x`,
  `sudo ${R33}$G -C . $V o main`,
  `sudo ${R33}$GH -R a/b $V merge 5`,
  `sudo ${R33}"$G" -c a.b=1 "\${V}" o main`,
  `sudo ${N33}$(which git) push o main`,
  `sudo ${N33}$K apply -f x`,
]

test.each(DENY_PAST_CAP_SINGLE_DYNAMIC_WORD)(
  'denyReason denies %j (claude-factory-p43v.33: a lone dynamic word past the cap still anchors)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.33: `sudo R ls` and `sudo R cp a b` have no dynamic word at all. They must
// stay allowed: the fallback anchor only fires when the forward scan finds a real dynamic word.
// `sudo R cp "$A" "$B"` already denies before this fix too (a true pair, `$A` next to `$B`, with
// no flag between them). It is an accepted deny, not a new one from this fix.
const ALLOW_PAST_CAP_NO_DYNAMIC_WORD = [`sudo ${R33}ls`, `sudo ${R33}cp a b`]

test.each(ALLOW_PAST_CAP_NO_DYNAMIC_WORD)(
  'denyReason allows %j (claude-factory-p43v.33: no over-deny when nothing past the cap is dynamic)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBeUndefined()
  },
)

test('denyReason still denies sudo R cp "$A" "$B" (claude-factory-p43v.33: a true pair past the cap is an accepted deny, unchanged by this fix)', () => {
  const cmd = `sudo ${R33}cp "$A" "$B"`
  expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
})

// claude-factory-p43v.27/.32 rows must stay denied: a true dynamic pair past the cap must still
// win over the new single-word fallback, so a lone unrelated dynamic word earlier in a long
// padding run never shadows the real `$G $V` pair that follows it.
test.each([...DENY_CHASE_PAST_CAP_SKIPS_FLAGS])(
  'denyReason still denies %j (claude-factory-p43v.33: a true pair still wins over the single-word fallback)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// claude-factory-p43v.35 (review round 8, review 5563842942): the chase in `commandAnchors`
// reads a dynamic word `k` as the real command and stops there, through `if (dyn) break`. When
// `mayBeValue` is set, `k` can be an unknown flag's own value, not the real command. When a flag
// word sits between `k` and `k2`, `k2` can be a flag's value too. Neither word anchors the real
// command, so it never gets a chance to deny.
//
// AC20: each row below must give `DYNAMIC_VERB_REASON`.
//
const AC20_DENY_FLAG_VALUE_BEFORE_PAIR = [
  'sudo --user $U --close-from 3 $G $V o main',
  'sudo --user $U --close-from 3 $(which git) push o main',
  'sudo --user $U --close-from 3 $GH $V merge 5',
  'env --unset "$X" --chdir /tmp $G $V o main',
  'env --chdir "$D" -u X $G $V o main',
  'sudo -Z $A -Y lit $G $V o main',
  'nice --adjustment "$N" --zz 5 $G $V o main',
  'xargs --max-args $N --max-procs 4 $G $V o main',
]

test.each(AC20_DENY_FLAG_VALUE_BEFORE_PAIR)(
  'denyReason denies %j with personOnly acme (claude-factory-p43v.35 AC20: a dynamic flag value before another flag pair no longer hides the dynamic payload)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

// AC21: each row below has no dynamic command pair and must stay allowed. The fix must not
// deny a plain wrapped command only because an unknown flag's value looks like a command word.
const AC21_ALLOW_NO_DYNAMIC_PAIR = [
  'sudo --chdir "$D" --user x ls',
  'sudo --user $U --close-from 3 ls',
  'env --unset "$X" --chdir /tmp make test',
  'env --chdir "$D" make test',
  'xargs -n 1 cp "$A"',
  'sudo -u x cp "$A" "$B"',
  'cp "$A" "$B"',
]

test.each(AC21_ALLOW_NO_DYNAMIC_PAIR)(
  'denyReason allows %j with personOnly acme (claude-factory-p43v.35 AC21: no over-deny when the wrapped command has no dynamic pair)',
  cmd => {
    expect(denyReason(cmd, '/x', ACME, P43V_GATE)).toBeUndefined()
  },
)

// claude-factory-bjp0: a shell variable word before the git verb hides a protected push. The
// p43v fix in gitReason's `dynamicWord(tail[vi]!)` check (DYNAMIC_VERB_REASON) already closes
// this gap. These rows prove the fix on the production gate shape.

// main() always sets gate.gitAliases and gate.ghAliases, from gitConfigAliases and
// ghAliasList. P43V_GATE above leaves both unset. An unset gitAliases or ghAliases can
// hide a bug that shows only when the gate reads the alias table. A row with no alias
// functions does not test the real path.
const BJP0_GATE = {
  headOf: () => 'main',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const BJP0_GATE_FACTORYX = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}

test('denyReason denies git $X push origin main (claude-factory-bjp0 AC1: a dynamic word at the verb slot hides a protected push)', () => {
  expect(denyReason('git $X push origin main', '/w', undefined, BJP0_GATE)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason denies git "$X" push origin HEAD (claude-factory-bjp0 AC2: a quoted dynamic verb word hides a HEAD push)', () => {
  expect(denyReason('git "$X" push origin HEAD', '/w', undefined, BJP0_GATE)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason denies git -C sub $X push origin main (claude-factory-bjp0 AC3: a -C directory before the dynamic verb word still hides the push)', () => {
  expect(denyReason('git -C sub $X push origin main', '/w', undefined, BJP0_GATE)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason allows git push origin factory/x (claude-factory-bjp0 AC4: control, a literal push to the current branch stays allowed)', () => {
  expect(denyReason('git push origin factory/x', '/w', undefined, BJP0_GATE_FACTORYX)).toBeUndefined()
})

// claude-factory-1zr5: a Claude Code shell-snapshot alias (gp, gco) runs git, but the hook sees no git word.
const SNAP_ALIASES = new Map<string, string | null>([
  ['gp', 'git push'],
  ['gpoat', 'git push origin --all && git push origin --tags'],
  ['gpf', 'git push --force-with-lease --force-if-includes'],
  ['gco', 'git checkout'],
  ['g', 'git'],
  ['k', 'kubectl'],
  ['rmrf', 'rm -rf'],
  ['rm', 'rm -i'],
  ['gh', 'op plugin run -- gh'],
  ['bad', null],
  ['loop1', 'loop2'],
  ['loop2', 'loop1'],
])
const snapGate = (shellAliases?: HookGate['shellAliases']): HookGate => ({
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
  shellAliases,
})
const SNAP_GATE = snapGate(() => SNAP_ALIASES)

const SNAP_DENY_ALIAS = [
  'gp origin main',
  'gp',
  'gp origin',
  'gp --force origin factory/x',
  'gpoat',
  'gp --all origin',
  'gpf origin main',
  'gco main',
  'g push origin main',
  'echo x && gp origin main',
  'sudo gp origin main',
  'FOO=1 gp origin main',
  'bad x',
  'A+=/x gp origin main',
  'B[1]=/x gp origin main',
  'A+=/x gco main',
  'C[k]+=/x gp origin main',
  'a=/x gp origin main',
  'A[a]b]=/x gp origin main',
  '>/tmp/x gp origin main',
  '2>/dev/null gp origin main',
  '</dev/null gp origin main',
  '>/tmp/x gco main',
  '>|/tmp/x gp origin main',
  '&>/tmp/x gp origin main',
  'A=1 >/tmp/x gp origin main',
  '3>/tmp/x gp origin main',
  '>>/tmp/x gp origin main',
]
test.each(SNAP_DENY_ALIAS)('denyReason denies the shell-snapshot alias row %j (claude-factory-1zr5)', cmd => {
  expect(denyReason(cmd, '/w', undefined, SNAP_GATE)).toBe(SHELL_ALIAS_REASON)
})

const SLASH_ALIASES = new Map<string, string | null>([...SNAP_ALIASES, ['gc', 'git commit']])
test.each(['bin/factory gc --dry-run', 'FACTORY_HOME=/t /abs/bin/factory gc', 'A+=1 /abs/bin/factory gc'])(
  'denyReason allows %j: an alias word after a path command word does not expand (claude-factory-1zr5)',
  cmd => {
    expect(
      denyReason(
        cmd,
        '/w',
        undefined,
        snapGate(() => SLASH_ALIASES),
      ),
    ).toBeUndefined()
  },
)
test.each(['sudo gc', 'FOO=1 gc', 'echo x && gc', 'gc'])(
  'denyReason still denies %j with gc as an alias at command position or after a bare word (claude-factory-1zr5)',
  cmd => {
    expect(
      denyReason(
        cmd,
        '/w',
        undefined,
        snapGate(() => SLASH_ALIASES),
      ),
    ).toBe(SHELL_ALIAS_REASON)
  },
)

test('denyReason rescans an alias that does not run git: kubectl, rm -rf, a gh wrapper (claude-factory-1zr5)', () => {
  expect(denyReason('k --context acme apply -f x', '/w', ['acme'], SNAP_GATE)).toBe(LIVE_REASON)
  expect(denyReason('rmrf build', '/w', undefined, SNAP_GATE)).toBe(REASON)
  expect(denyReason('gh pr merge 5', '/w', undefined, SNAP_GATE)).toBe(MERGE_REASON)
})

test.each(['git push origin feature', 'git status', 'ls -la', 'rm -i notes.txt', 'gh pr view 5'])(
  'denyReason allows %j with the snapshot table set (claude-factory-1zr5)',
  cmd => {
    expect(denyReason(cmd, '/w', undefined, SNAP_GATE)).toBeUndefined()
  },
)

test.each(SNAP_DENY_ALIAS.filter(c => c !== 'bad x' && !/^[A-Za-z]\[/.test(c)))(
  'denyReason allows %j when shellAliases is unset or empty, as before (claude-factory-1zr5)',
  cmd => {
    const pre = denyReason(cmd, '/w', undefined, snapGate())
    expect(
      denyReason(
        cmd,
        '/w',
        undefined,
        snapGate(() => new Map()),
      ),
    ).toBe(pre)
    expect(pre).toBeUndefined()
  },
)

const ALIAS_DEFINE_DENY = [
  "alias g='git push origin main'; eval g",
  "alias g='git push origin main'; trap g EXIT",
  "alias g='git push origin main'; . ./g.sh",
  "alias g='git push origin main'; source ./g.sh",
  "alias -g M=main; eval 'git push origin M'",
  "alias g='rm -rf /'; eval g",
  "shopt -s expand_aliases; alias g='git push origin main'; eval g",
  `bash -c "shopt -s expand_aliases; alias g='git push origin main'; eval g"`,
  "builtin alias g='git push origin main'; eval g",
  "\\alias g='git push origin main'; eval g",
  "alias -- g='git push origin main'; eval g",
  "alias a=b g='git push origin main'; eval g",
  "alias 'g'='git push origin main'; eval g",
  "command alias g='git push origin main'; eval g",
  "al''ias g='git push origin main'; eval g",
  "alias g='git push origin main'; echo $(g)",
  "alias g='git push origin main'; echo `g`",
  "alias g='git push origin main'; cat <(g)",
  `eval "alias g='git push origin main'"; eval g`,
  "aliases[g]='git push origin main'; eval g",
  "typeset aliases[g]='git push origin main'; eval g",
  "galiases[M]=main; eval 'git push origin M'",
  "BASH_ALIASES[g]='git push origin main'; eval g",
  ': ${aliases[g]::=git push origin main}; eval g',
  "A=alias; $A g='git push origin main'; eval g",
  "A=al; ${A}ias g='git push origin main'; eval g",
  "A=alias; builtin $A g='git push origin main'; eval g",
  'cat $aliases; eval g',
  'ls ${galiases[M]}; eval g',
  'aliases=x cat y; eval g',
  "alias ll='ls > out'",
  "n=ali; set -A ${n}ases g 'echo PWNED'; eval g",
  "n=ali; set -A ${n}ases g 'echo PWNED'; echo $(g)",
  "n=ali; set -A $n'ases' g 'echo PWNED'; eval g",
  `n=ali; set -A "$n"ases g 'echo PWNED'; eval g`,
  `n=ali; set -A $n"ases" g 'echo PWNED'; echo $(g)`,
  "set -A ali$(echo ases) g 'echo PWNED'; eval g",
  "x=$(printf '%s' ali; printf '%s' ases); set -A $x g 'echo PWNED'; eval g",
  `zsh -c 'n=ali; set -A $n"ases" g "echo PWNED"; eval g'`,
  'n=ali; typeset "${n}ases[g]=echo PWNED"; eval g',
  "n=ali; noglob typeset ${n}ases[g]='echo PWNED'; eval g",
  'n=ali; read -r "${n}ases[g]" <<< \'echo PWNED\'; eval g',
  "n=BASH_ALI; printf -v \"${n}ASES[g]\" '%s' 'echo PWNED'; eval g",
  'n=ali; print -v "${n}ases[g]" \'echo PWNED\'; eval g',
]
const ALIAS_DEFINE_ALLOW = [
  "alias ll='ls -l'",
  'alias -g M=widget',
  'alias a=b c=d',
  'alias a=b && alias c=d',
  'alias',
  'alias g',
  'grep -n alias src/worker-hook.ts',
  'rg -n shellAliases src | head',
  'gh alias list',
  'bd search alias',
  'bun test src/worker-hook.test.ts -t alias',
  'git log --grep=alias',
  '/abs/bin/factory report run-x 5 approve "Fix the alias guard"',
  '/abs/bin/factory memory search "shell alias"',
  './bin/factory memory search "alias"',
]

test.each(ALIAS_DEFINE_DENY)(
  'denyReason denies a command that defines an alias and runs more: %s (claude-factory-mn2y)',
  cmd => {
    expect(denyReason(cmd, '/w', undefined, snapGate())).toBeDefined()
    expect(
      denyReason(
        cmd,
        '/w',
        undefined,
        snapGate(() => new Map()),
      ),
    ).toBeDefined()
  },
)

test.each(["alias g='echo acme'; eval g", "alias ll='ls -l'; ll"])(
  'denyReason gives the alias-define reason: %s (claude-factory-mn2y)',
  cmd => {
    expect(denyReason(cmd, '/w', undefined, snapGate())).toBe(SHELL_ALIAS_DEFINE_REASON)
    expect(
      denyReason(
        cmd,
        '/w',
        undefined,
        snapGate(() => new Map()),
      ),
    ).toBe(SHELL_ALIAS_DEFINE_REASON)
  },
)

test.each(ALIAS_DEFINE_ALLOW)('denyReason allows a plain alias command: %s (claude-factory-mn2y)', cmd => {
  expect(denyReason(cmd, '/w', undefined, snapGate())).toBeUndefined()
  expect(
    denyReason(
      cmd,
      '/w',
      undefined,
      snapGate(() => new Map()),
    ),
  ).toBeUndefined()
})

test('denyReason denies an alias chain past the depth cap but ends on an alias cycle, as zsh does (claude-factory-1zr5)', () => {
  expect(denyReason('loop1 x', '/w', undefined, SNAP_GATE)).toBeUndefined()
  const long = new Map<string, string | null>()
  for (let i = 0; i < 20; i++) long.set(`c${i}`, `c${i + 1}`)
  expect(
    denyReason(
      'c0 x',
      '/w',
      undefined,
      snapGate(() => long),
    ),
  ).toBe(SHELL_ALIAS_REASON)
  const short = new Map<string, string | null>([
    ['c0', 'c1'],
    ['c1', 'echo'],
  ])
  expect(
    denyReason(
      'c0 x',
      '/w',
      undefined,
      snapGate(() => short),
    ),
  ).toBeUndefined()
})

test('denyReason denies every command when the snapshot table cannot be read, and reads it once (claude-factory-1zr5)', () => {
  let calls = 0
  const gate = snapGate(() => {
    calls++
    return undefined
  })
  expect(denyReason('git status', '/w', undefined, gate)).toBe(SHELL_ALIAS_READ_REASON)
  expect(calls).toBe(1)
  let n = 0
  const many = snapGate(() => (n++, new Map()))
  expect(denyReason('ls && ls && ls ; echo a b c', '/w', undefined, many)).toBeUndefined()
  expect(n).toBe(1)
})

test('denyReason keeps a dynamic alias word dynamic when it rescans the expansion (claude-factory-1zr5)', () => {
  const t = new Map<string, string | null>([
    ['kk', 'kubectl'],
    ['q', 'echo'],
  ])
  expect(
    denyReason(
      'kk $V apply -f x',
      '/w',
      ['acme'],
      snapGate(() => t),
    ),
  ).toBeDefined()
  expect(
    denyReason(
      "q 'a;b' c",
      '/w',
      undefined,
      snapGate(() => t),
    ),
  ).toBeUndefined()
})

// claude-factory-1zr5: a fake snapshot folder; the values are fake and use acme/widget names
function snapDir(files: Record<string, string>, ageSec: Record<string, number> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'))
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
    const t = new Date(Date.now() - (ageSec[name] ?? 0) * 1000)
    utimesSync(join(dir, name), t, t)
  }
  return dir
}

test('shellSnapshotAliases parses bare, quoted, joined and multi-line values and maps the rest to null (claude-factory-1zr5)', () => {
  const dir = snapDir({
    'snapshot-zsh-1.sh': [
      'f() { :; }',
      'alias -- acme=widget',
      "alias -- gp='git push'",
      "alias -- q='echo '\\''a b'\\'' c'",
      "alias -- multi='echo one",
      "two'",
      "alias -- dollar=$'a\\nb'",
      'alias -- amp=a&b',
      "alias -- after='x'",
      '',
    ].join('\n'),
  })
  const t = shellSnapshotAliases(dir)!
  expect(t.get('acme')).toBe('widget')
  expect(t.get('gp')).toBe('git push')
  expect(t.get('q')).toBe("echo 'a b' c")
  expect(t.get('multi')).toBe('echo one\ntwo')
  expect(t.get('dollar')).toBeNull()
  expect(t.get('amp')).toBeNull()
  expect(t.get('after')).toBe('x')
  expect(t.has('f')).toBe(false)
})

test('shellSnapshotAliases reads the newest 3 files and lets a newer file win (claude-factory-1zr5)', () => {
  const dir = snapDir(
    {
      'snapshot-zsh-a.sh': "alias -- old='x'\n",
      'snapshot-zsh-b.sh': "alias -- gp='echo b'\nalias -- mid='y'\n",
      'snapshot-zsh-c.sh': "alias -- gp='echo c'\n",
      'snapshot-zsh-d.sh': "alias -- gp='git push'\n",
      'notes.txt': "alias -- other='z'\n",
    },
    { 'snapshot-zsh-a.sh': 40, 'snapshot-zsh-b.sh': 30, 'snapshot-zsh-c.sh': 20, 'snapshot-zsh-d.sh': 10 },
  )
  const t = shellSnapshotAliases(dir)!
  expect(t.get('gp')).toBe('git push')
  expect(t.get('mid')).toBe('y')
  expect(t.has('old')).toBe(false)
  expect(t.has('other')).toBe(false)
})

test('shellSnapshotAliases gives an empty Map for a missing folder and undefined for a read error (claude-factory-1zr5)', () => {
  expect(shellSnapshotAliases(join(tmpdir(), 'snap-missing-acme'))?.size).toBe(0)
  expect(shellSnapshotAliases(snapDir({}))?.size).toBe(0)
  const big = snapDir({ 'snapshot-zsh-1.sh': 'x'.repeat(4 * 1024 * 1024 + 1) })
  expect(shellSnapshotAliases(big)).toBeUndefined()
  const notDir = snapDir({ 'file.txt': '' })
  expect(shellSnapshotAliases(join(notDir, 'file.txt'))).toBeUndefined()
  const bad = snapDir({})
  mkdirSync(join(bad, 'snapshot-zsh-1.sh'))
  expect(shellSnapshotAliases(bad)).toBeUndefined()
})

// claude-factory-1zr5: the spawned hook reads the folder that CLAUDE_CONFIG_DIR names
const spawnEnv = (configDir: string) => ({
  ...process.env,
  FACTORY_OUTBOX: undefined,
  FACTORY_FROM: undefined,
  FACTORY_SELF_UPDATE: '0',
  CLAUDE_CONFIG_DIR: configDir,
})
test('the spawned hook denies a snapshot alias word and allows git status with an empty folder (claude-factory-1zr5)', async () => {
  const withAlias = mkdtempSync(join(tmpdir(), 'cfg-'))
  mkdirSync(join(withAlias, 'shell-snapshots'))
  writeFileSync(join(withAlias, 'shell-snapshots', 'snapshot-zsh-1.sh'), "alias -- gp='git push'\n")
  const empty = mkdtempSync(join(tmpdir(), 'cfg-'))
  mkdirSync(join(empty, 'shell-snapshots'))
  const cmd = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
  const denied = await run(cmd('gp origin main'), spawnEnv(withAlias))
  expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecisionReason).toBe(SHELL_ALIAS_REASON)
  expect((await run(cmd('git status'), spawnEnv(empty))).out).toBe('')
  const unreadable = mkdtempSync(join(tmpdir(), 'cfg-'))
  writeFileSync(join(unreadable, 'shell-snapshots'), '')
  const blocked = await run(cmd('git status'), spawnEnv(unreadable))
  expect(JSON.parse(blocked.out).hookSpecificOutput.permissionDecisionReason).toBe(SHELL_ALIAS_READ_REASON)
}, 30_000)

// claude-factory-a8pr: macOS APFS resolves Git, GH, SH to the real binaries, so a capitalized
// command word must get the same verdict as its lowercase twin.
const A8PR_GATE = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const A8PR_ROOT = '/r/acme/widget'
const A8PR_PERSON_ONLY = ['acme']
const a8prVerdict = (cmd: string) => denyReason(cmd, A8PR_ROOT, A8PR_PERSON_ONLY, A8PR_GATE)

const A8PR_DENY: [string, string][] = [
  ['Git push origin main', 'git push origin main'],
  ['GIT push origin main', 'git push origin main'],
  ['Git-push origin main', 'git-push origin main'],
  ['/usr/bin/Git push origin main', '/usr/bin/git push origin main'],
  ['Git config --global alias.p push', 'git config --global alias.p push'],
  ['Git checkout main && git push', 'git checkout main && git push'],
  ['Gh pr merge 1', 'gh pr merge 1'],
  ['GH pr merge 1', 'gh pr merge 1'],
  ['Gh pr ready 1', 'gh pr ready 1'],
  ['Gh api -X PUT repos/acme/widget/pulls/1/merge', 'gh api -X PUT repos/acme/widget/pulls/1/merge'],
  ["SH -c 'git push origin main'", "sh -c 'git push origin main'"],
  ["Sh -c 'git push origin main'", "sh -c 'git push origin main'"],
  ["/bin/SH -c 'git push origin main'", "/bin/sh -c 'git push origin main'"],
  ["BASH -c 'git push origin main'", "bash -c 'git push origin main'"],
  ["Zsh -c 'git push origin main'", "zsh -c 'git push origin main'"],
  ['Sudo Git push origin main', 'sudo git push origin main'],
  ['Env Git push origin main', 'env git push origin main'],
  ['Kubectl apply -f x.yaml --context acme', 'kubectl apply -f x.yaml --context acme'],
  ['Helm upgrade x y --kube-context acme', 'helm upgrade x y --kube-context acme'],
  ['Rm -rf /etc', 'rm -rf /etc'],
  // U+017F (long s) folds to s on APFS; toLowerCase alone keeps it
  ["ſh -c 'git push origin main'", "sh -c 'git push origin main'"],
  ["/bin/ſh -c 'git push origin main'", "/bin/sh -c 'git push origin main'"],
  ["baſh -c 'git push origin main'", "bash -c 'git push origin main'"],
  ["zſh -c 'git push origin main'", "zsh -c 'git push origin main'"],
  ["daſh -c 'git push origin main'", "dash -c 'git push origin main'"],
  ["ſh -c 'gh pr merge 1'", "sh -c 'gh pr merge 1'"],
  ["ſh -c 'git config --global alias.p push'", "sh -c 'git config --global alias.p push'"],
  ['echo main | xargſ git push origin', 'echo main | xargs git push origin'],
  ['ſudo rm -rf /etc', 'sudo rm -rf /etc'],
]

test.each(A8PR_DENY)('denyReason denies %j like its lowercase twin (claude-factory-a8pr)', (cmd, twin) => {
  const want = a8prVerdict(twin)
  expect(want).toBeDefined()
  expect(a8prVerdict(cmd)).toBe(want)
})

test.each(['Git status', 'Gh pr view 1', 'Git log --oneline'])(
  'denyReason allows %j (claude-factory-a8pr: reads stay allowed)',
  cmd => {
    expect(a8prVerdict(cmd)).toBeUndefined()
  },
)

// claude-factory-mmc9: zsh and bash read NAME+=value as an assignment. zsh also reads
// NAME[sub]=value and NAME[sub]+=value. The hook must skip these words and read the real command.
const MMC9_DENY = [
  'A+=x rm -rf /',
  'A+= rm -rf /',
  'A=x B+=y rm -rf /',
  'A+=x sudo rm -rf /',
  'A+=x xargs rm -rf',
  'A+=x\\\n rm -rf /',
  'A[k]=x rm -rf /',
  'A[k]+=x rm -rf /',
  'A[1]=x rm -rf /',
  'A[a[1]]=x rm -rf /',
  "A['k y']=x rm -rf /",
  'A["k]"]=x rm -rf /',
  'sudo A+=x rm -rf /',
  'env A+=x rm -rf /',
  'env a.b=1 rm -rf /',
  'é=x rm -rf /',
  'Aé+=x rm -rf /',
  'é[1]=x rm -rf /',
  'Ａ=x rm -rf /',
  'Aा=x rm -rf /',
  'Aิ=x rm -rf /',
  'Ⅰ=x rm -rf /',
  '٣=x rm -rf /',
  'Ⓐ=x rm -rf /',
  'AⒶ=x rm -rf /',
  '\u{1F130}=x rm -rf /',
  'ा=x rm -rf /',
  'ͅ=x rm -rf /',
  '٣[1]=x rm -rf /',
]

test.each(MMC9_DENY)('denyReason denies %j (claude-factory-mmc9, assignment forms)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

const MMC9_DYNAMIC = [
  'A+=x $',
  'A+=x $G $V origin main',
  'A[k]+=x $G $V origin main',
  'A+=x sudo -Z $P $G $V origin main',
]

test.each(MMC9_DYNAMIC)('denyReason denies %j as a dynamic verb (claude-factory-mmc9)', cmd => {
  expect(denyReason(cmd)).toBe(DYNAMIC_VERB_REASON)
})

const MMC9_SUBSCRIPT_FLAG = [
  'A[(r)x]=x rm -rf /',
  'A[(r)x]+=x rm -rf /',
  'A[(x]=x rm -rf /',
  'Ⓐ[(r)x]=x rm -rf /',
  '٣[(r)x]=x rm -rf /',
  'typeset -a A; A[(r)x]=x rm -rf /',
]

test.each(MMC9_SUBSCRIPT_FLAG)('denyReason denies %j (claude-factory-mmc9.6, subscript flag)', cmd => {
  expect(denyReason(cmd)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason allows ls A[(r)x] (claude-factory-mmc9.6)', () => {
  expect(denyReason('ls A[(r)x]')).toBeUndefined()
})

test('denyReason denies A+=x $K apply with personOnly acme (claude-factory-mmc9)', () => {
  expect(denyReason('A+=x $K apply -f x.yaml', undefined, ACME)).toBe(DYNAMIC_VERB_REASON)
})

test('denyReason keeps its verdict on A+=x gh and git forms (claude-factory-mmc9)', () => {
  const gate: HookGate = { headOf: () => 'factory/x', originHead: () => 'main', gitAliases: () => new Map() }
  expect(denyReason('A+=x gh pr merge 1')).toBe(MERGE_REASON)
  expect(denyReason('A+=x git push origin main', undefined, undefined, gate)).toBe(PUSH_REASON)
})

test.each(['$G=x $V o main', '$G+=x $V o main', '${A}+=x $G $V o main'])(
  'denyReason keeps denying the dynamic head %j (claude-factory-mmc9)',
  cmd => {
    expect(denyReason(cmd)).toBe(DYNAMIC_VERB_REASON)
  },
)

test.each(['A+=x ls', 'A+=x bd list --all', 'echo A+=x', 'git commit -m A+=x', 'ls A[k]=x'])(
  'denyReason allows %j (claude-factory-mmc9, not a hidden command)',
  cmd => {
    expect(denyReason(cmd)).toBeUndefined()
  },
)

test.each([
  'env -i A+=x sh -c "bd create t"',
  'env -i a.b=1 sh -c "bd create t"',
  'env -i A[k]=x bd create t',
])('denyReason denies %j (claude-factory-mmc9, env assignment forms)', cmd => {
  expect(denyReason(cmd)).toBe(BEADS_ACTOR_REASON)
})

test.each(
  ['nice', 'time', 'nohup', 'exec', 'command', 'builtin']
    .map(w => `${w} ./d=1/rm -r ./d`)
    .concat(['nice -n 5 ./d=1/rm -r ./d', 'sudo nice ./d=1/rm -r ./d']),
)('denyReason denies %j (claude-factory-mmc9.10, only sudo and env read NAME=v as assignment)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each([
  'sudo timeout 5 ./d=1/rm -r ./d',
  'env timeout 5 ./d=1/rm -r ./d',
  'sudo xargs ./d=1/rm -r ./d',
  'env xargs ./d=1/rm -r ./d',
  'sudo A=1 timeout 5 ./d=1/rm -r ./d',
])('denyReason denies %j (claude-factory-mmc9.11, timeout and xargs clear the wrapper flag)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each([
  'sudo /tmp/d=1/rm -r ./d',
  'sudo /tmp/d=1/rm -rf /',
  'sudo -u root /tmp/d=1/rm -r ./d',
  'sudo A=1 /tmp/d=1/rm -r ./d',
  'sudo -- ./d=1/rm -r ./d',
  'sudo -u root -- ./d=1/rm -r ./d',
  'sudo -- /tmp/d=1/rm -r ./d',
])('denyReason denies %j (claude-factory-mmc9.19, sudo runs this word as the command)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each(['sudo A=1 ls', 'sudo /tmp/d=1/ls -la'])(
  'denyReason allows %j (claude-factory-mmc9.19, the word is an assignment, not the command)',
  cmd => {
    expect(denyReason(cmd)).toBeUndefined()
  },
)

test.each([
  'sudo ~/d=1/rm -r ./d',
  'sudo ~/d=1/rm -rf /',
  'sudo ~root/d=1/rm -r ./d',
  'sudo ~+/d=1/rm -r ./d',
  'sudo $HOME/d=1/rm -r ./d',
  'sudo ${HOME}/d=1/rm -r ./d',
  'sudo $D=1/rm -r ./d',
  'sudo -u root ~/d=1/rm -r ./d',
  'sudo A=1 ~/d=1/rm -r ./d',
])('denyReason denies %j (claude-factory-mmc9.20, the shell expands the word before sudo reads it)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

// The home guard from origin/main denies this row first, with its own reason.
test('denyReason denies a quoted home word before /d=1/rm under sudo (claude-factory-mmc9.20)', () => {
  expect(denyReason('sudo "$HOME"/d=1/rm -r ./d')).not.toBeNull()
})

test.each([
  'A+=x B+=y rm -rf /',
  'A+=x sudo B+=y rm -rf /',
  'sudo -E A+=1 rm -rf /',
  'sudo -- A=1 rm -rf /',
  'A=1 time B=2/rm -r ./d',
  '/usr/bin/time A=1/rm -r ./d',
])('denyReason denies %j (claude-factory-mmc9.22, both readings of a word with =)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each(['FOO=bar ls -la', 'make A=1 -j4', 'git -c a=b status', 'rm -f a=b', 'time ls'])(
  'denyReason allows %j (claude-factory-mmc9.22, no rm under either reading)',
  cmd => {
    expect(denyReason(cmd)).toBeUndefined()
  },
)

test.each(['cd .. && A+=1 rm foo', 'cd .. && sudo A+=1 rm foo', 'A+=1 cd ..; rm foo'])(
  'denyReason denies %j (claude-factory-mmc9.25, rm and cd under a non-ASCII-name assignment)',
  cmd => {
    expect(denyReason(cmd)).toBe(REASON)
  },
)

const MMC9_13_WRAPPERS = ['nice', 'nohup', 'exec', 'command', 'builtin', 'timeout 5', 'xargs']
test.each(
  MMC9_13_WRAPPERS.flatMap(w => ['A=1/rm -r ./d', 'A+=1/rm -r ./d', 'é=1/rm -r ./d'].map(c => `${w} ${c}`)),
)('denyReason denies %j (claude-factory-mmc9.13, a word with = after a wrapper is the command)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each([
  'A+=x ls',
  'é=x',
  'A[1]=x',
  'A[1]=x; echo ok',
  'echo A+=x',
  'ls A[(r)x]',
  'sudo timeout 5 ls',
  'env a.b=1 ls',
])('denyReason allows %j (claude-factory-mmc9.13, assignment only at a shell-prefix position)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

test.each(['nice A=1 $G $V origin main', 'nohup -- A=1 $G $V origin main', 'env A=1 $G $V origin main'])(
  'denyReason keeps denying %j (claude-factory-mmc9.15, commandAnchors skips the operand fail-closed)',
  cmd => {
    expect(denyReason(cmd)).toBe(DYNAMIC_VERB_REASON)
  },
)

test.each([
  'sudo ./d=1/rm -r ./d',
  'env /tmp/d=1/rm -r ./d',
  'env -- ./d=1/rm -r ./d',
  'A=1/rm -r ./d',
  'env A+=1/rm -r ./d',
  'sudo A+=1/rm -r ./d',
  'é=1/rm -r ./d',
  'Ⓐ=1/rm -r ./d',
  'A²=1/rm -r ./d',
  'A[k]=1/rm -r ./d',
  'time A=1/rm -r ./d',
  'time -p é=1/rm -r ./d',
  'time -- é=1/rm -r ./d',
  'time -p Ⓐ=1/rm -r ./d',
  'time -p A[k]=1/rm -r ./d',
  '/usr/bin/time A+=1/rm -r ./d',
  '/usr/bin/time é=1/rm -r ./d',
  '/usr/bin/time A=1/rm -r ./d',
  '\\time A=1/rm -r ./d',
  '"time" A=1/rm -r ./d',
  'tim""e A+=1/rm -r ./d',
])('denyReason denies %j (claude-factory-mmc9.22, a word with = is the command or an assignment)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each([
  'é=x ls',
  'A[k]=x ls',
  'time A[k]=x ls',
  'B[1]=2 /abs/bin/factory gc',
  'C[k]+=3 /abs/bin/factory gc',
  'B[1]=/x gp origin main',
  'C[k]+=/x gp origin main',
  'A[a]b]=/x gp origin main',
  'time -p é=1 /abs/bin/factory gc',
  '/usr/bin/time A+=1 /abs/bin/factory gc',
  'tim""e A+=1 /abs/bin/factory gc',
])('denyReason denies %j (claude-factory-mmc9.14, ambiguous assignment prefix)', cmd => {
  expect(denyReason(cmd)).toBe(ASSIGNMENT_PREFIX_REASON)
})

// claude-factory-4i60.14: the baseWord cache returns the uncached value for every input
const BASE_WORD_TABLE = ['\\rm', '/bin/SH', 'Git', '/usr/bin/\u017Ftat', '', 'dir/', 'a/b/GH', '\\\\x']

test('baseWord cache equals the uncached function, also after a cache clear', () => {
  const check = () => {
    for (const w of BASE_WORD_TABLE) {
      expect(baseWord(w)).toBe(baseWordForTest(w))
      expect(baseWord(w)).toBe(baseWordForTest(w))
    }
  }
  check()
  for (let i = 0; i < 4200; i++) baseWord(`/x/W${i}`)
  check()
  expect(baseWord('\\rm')).toBe('rm')
  expect(baseWord('/bin/SH')).toBe('sh')
  expect(baseWord('dir/')).toBe('')
})

// claude-factory-tyz6: zsh reads a lone - in command position as a precommand modifier, so the next word is the command.
const DENY_ZSH_DASH_PRECOMMAND = [
  '- rm -r ./d',
  '- rm -rf /',
  'A=1 - rm -r ./d',
  'A=1; - rm -r ./d',
  "'-' rm -r ./d",
  '\\- rm -r ./d',
  '"-" rm -r ./d',
  '- - rm -r ./d',
  '- exec rm -r ./d',
  '- builtin rm -r ./d',
  'exec - rm -r ./d',
  'builtin - rm -r ./d',
  'env - rm -r ./d',
  'time - rm -r ./d',
  'sudo - rm -r ./d',
  'if - rm -r ./d; then :; fi',
  'echo x && - rm -r ./d',
]

test.each(DENY_ZSH_DASH_PRECOMMAND)(
  'denyReason denies the dash precommand row %j (claude-factory-tyz6)',
  cmd => {
    expect(denyReason(cmd)).toBe(REASON)
  },
)

test.each(['- $G $V origin main', 'G=git V=push; - $G $V origin main'])(
  'denyReason denies the dash precommand dynamic verb row %j (claude-factory-tyz6)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason keeps the git, gh and sh -c denies behind a dash (claude-factory-tyz6)', () => {
  expect(denyReason('- git push origin main')).toBe(PUSH_REASON)
  expect(denyReason('- gh pr merge 1')).toBe(MERGE_REASON)
  expect(denyReason('- sh -c "rm -r ./d"')).toBeDefined()
})

test.each(['- ls', 'cat -', 'echo - x', 'ls -', 'git diff -'])(
  'denyReason allows %j (claude-factory-tyz6: a dash is not always a precommand)',
  cmd => {
    expect(denyReason(cmd)).toBeUndefined()
  },
)

// claude-factory-j1ki: the shell splits an unquoted expansion (${IFS}, $IFS, ${X}, $(...)) that is
// glued to other text into word breaks. The guard must read the split words.
const J1KI_GATE = {
  headOf: (d?: string) => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
}
const J1KI_REASON_ROWS = [
  'rm${IFS}-rf${IFS}/',
  'rm$IFS-rf$IFS/',
  '${IFS}rm${IFS}-rf${IFS}/',
  'rm${IFS%?}-rf${IFS%?}/',
  'rm${IFS:0:1}-rf${IFS:0:1}/',
  'rm${=IFS}-rf${=IFS}/',
  'rm$=IFS-rf$=IFS/',
  'rm${X}-rf${X}/',
  'rm$1-rf$1/',
  'rm$@-rf$@/',
  'rm${IFS}../x',
  'rm$(echo " ")-rf$(echo " ")/',
  'sudo rm${IFS}-rf${IFS}/',
  'env rm${IFS}-rf${IFS}/',
  'X=1 rm${IFS}-rf${IFS}/',
  'cd /x; rm${IFS}-rf${IFS}/',
  'true && rm${IFS}-rf${IFS}/',
  'find . -exec rm${IFS}-rf {} +',
  'find${IFS}.${IFS}-exec${IFS}rm${IFS}-rf${IFS}{}${IFS}+',
  "rm$( (printf ' ') )-rf /",
  'rm$(printf "%s" "$(printf " ")")-rf /',
  "rm$(printf '%s' \"$(printf ' ')\")-rf /",
]
const J1KI_PUSH_ROWS = [
  'git${IFS}push${IFS}origin${IFS}main',
  'git$IFS"push"$IFS"origin"$IFS"main"',
  "git$IFS'push'$IFS'origin'$IFS'main'",
  'git$IFS\\push$IFS\\origin$IFS\\main',
]
const J1KI_MERGE_ROWS = ['gh${IFS}pr${IFS}merge${IFS}1']
const J1KI_DYNAMIC_ROWS = ['gh$IFS"pr"$IFS"merge"${IFS}1', 'gh$IFS"pr"$IFS"merge"$IFS1']
const J1KI_ALIAS_ROWS = [
  'export$IFS"HOME=/x"; gh co 5',
  'export${IFS}GH_CONFIG_DIR=/x; gh co 5',
  'export${IFS}HOME=/x; gh co 5',
]
const J1KI_MOVE_ROWS = ['cd${IFS}/x; git push', 'cd$IFS/x && git push origin HEAD', 'pushd${IFS}/x; git push']
// claude-factory-j1ki.12 to .15: security review rows.
const J1KI_REASON_ROWS2 = [
  'cd${IFS}/x; rm ./f',
  'cd /x; rm${IFS}./f',
  'cd${IFS}/x; rm${IFS}./f',
  'rm${IFS}./f; cd${IFS}/x',
  "echo $(rm$(printf ' ')-r ./d)",
  "x=$(rm$(printf ' ')-r ./d)",
  "echo $(:; rm$(printf ' ')-r ./d)",
  "x=$(echo $(rm$(printf ' ')-r ./d))",
  '"rm"$(printf \' \')"-r" ./d',
  '"rm"$(printf \' \')"-r"$(printf \' \')"./d"',
]
const J1KI_PUSH_ROWS2 = [
  'export${IFS}GIT_CONFIG_GLOBAL=/x; git push origin HEAD',
  'export${IFS}GIT_CONFIG_GLOBAL=/x && git push origin HEAD',
  'export${IFS}GIT_CONFIG_GLOBAL=/x\ngit push origin HEAD',
  'export${IFS}GIT_CONFIG_SYSTEM=/x; git push origin HEAD',
  "export${IFS}GIT_CONFIG_PARAMETERS='x'; git push origin HEAD",
  'export${IFS}HOME=/x; git push origin HEAD',
  'declare${IFS}-x${IFS}GIT_CONFIG_GLOBAL=/x; git push origin HEAD',
  "x=$(git$(printf ' ')push$(printf ' ')origin$(printf ' ')main)",
  '"git"$(printf \' \')"push"$(printf \' \')"origin"$(printf \' \')"main"',
]
test.each(J1KI_REASON_ROWS2)('claude-factory-j1ki.12-15: %s denies with REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
})
test.each(J1KI_PUSH_ROWS2)('claude-factory-j1ki.12-15: %s denies with PUSH_REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(PUSH_REASON)
})
test.each([
  'export${IFS}PATH=/x; git status',
  'cd /x && ls',
  'rm ./f',
  'echo $(date)',
  'echo "$(date)"',
  'git commit -m "a$(date)b"',
  'echo "a"$(date) "b"',
])('claude-factory-j1ki.12-15: %s stays allowed', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBeUndefined()
})
const J1KI_ALLOW_ROWS = [
  'ls ${IFS}',
  'echo a${X}b',
  'echo${IFS}hi',
  'ls$IFS-la',
  '$HOME/.local/bin/claude plugin test mod',
  '"$ROOT/bin/factory" report x 2 ready s',
  'git commit -m "a ${X} b"',
  'git -C "$WT"/sub status',
  'ls build/a${X}b 2>/dev/null',
  'find "$D"/x -name y -delete',
  'echo a$(date)b',
]
// claude-factory-dnw1: a nested default inside a glued brace expansion must not end at the first "}".
test.each(['rm${X:-${IFS}}-rf${X:-${IFS}}/', 'rm${X:-${Y:-${IFS}}}-rf${X:-${IFS}}/', 'rm${X:-${IFS}}-rf /'])(
  'claude-factory-dnw1: %s denies with REASON',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
  },
)
test('claude-factory-dnw1: glued nested default git push denies with PUSH_REASON', () => {
  expect(
    denyReason('git${X:-${IFS}}push${X:-${IFS}}origin${X:-${IFS}}main', '/root/repo', undefined, J1KI_GATE),
  ).toBe(PUSH_REASON)
})
// A bare "{" in a default is literal in bash (words: rm { -rf /), so it must not add depth.
test('claude-factory-dnw1: a bare brace in a glued default still denies rm', () => {
  expect(denyReason('rm${IFS}${X:-{}${IFS}-rf${IFS}/', '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
})
test('claude-factory-dnw1: a bare brace in a glued default still denies git push', () => {
  expect(
    denyReason('git${IFS}${X:-{}${IFS}push${IFS}origin${IFS}main', '/root/repo', undefined, J1KI_GATE),
  ).toBe(REASON)
})
test('claude-factory-dnw1: a bare brace does not hide a later close brace', () => {
  expect(denyReason('rm${X:-{}${IFS}-rf${IFS}/}', '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
})
test.each([
  String.raw`rm${'${IFS}'}${'${X:-\\${}'}${'${IFS}'}-rf${'${IFS}'}/${'${IFS}'}x}`,
  "rm${IFS}${X:-'${'}${IFS}-rf${IFS}/${IFS}x}",
])('claude-factory-dnw1: an escaped or quoted dollar-brace does not nest: rm %s', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
})
test.each([
  String.raw`git${'${IFS}'}${'${X:-\\${}'}${'${IFS}'}push${'${IFS}'}origin${'${IFS}'}main${'${IFS}'}x}`,
  "git${IFS}${X:-'${'}${IFS}push${IFS}origin${IFS}main${IFS}x}",
])('claude-factory-dnw1: an escaped or quoted dollar-brace does not nest: git %s', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(PUSH_REASON)
})
const N = '${X:-${IFS}}'
test.each([String.raw`rm${N}${'${Y:-\\${}'}${N}-rf${N}/${N}}`, `rm${N}\${Y:-'\${'}${N}-rf${N}/${N}}`])(
  'claude-factory-dnw1: a nested default and a hidden dollar-brace in one word: rm %s',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
  },
)
test.each([
  String.raw`git${N}${'${Y:-\\${}'}${N}push${N}origin${N}main${N}}`,
  `git${N}\${Y:-'\${'}${N}push${N}origin${N}main${N}}`,
])('claude-factory-dnw1: a nested default and a hidden dollar-brace in one word: git %s', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(PUSH_REASON)
})
test('claude-factory-dnw1: an unclosed glued default keeps the words after it', () => {
  expect(denyReason('rm${X:-${IFS}-rf${IFS}/', '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
})
test.each(['echo ${X:-${HOME}}x', 'ls ${A:-${B}}/c', 'echo ${X:-x}y'])(
  'claude-factory-dnw1: %s stays allowed',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBeUndefined()
  },
)
test.each([String.raw`rm${'${IFS}'}\${$IFS-rf$IFS/$IFS}`, "rm${IFS}'${'$IFS-rf$IFS/$IFS}"])(
  'claude-factory-dnw1: a hidden dollar-brace and bare IFS breaks: rm %s',
  cmd => {
    expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
  },
)
test.each([
  String.raw`git${'${IFS}'}\${$IFS''push$IFS''origin$IFS''main$IFS}`,
  "git${IFS}'${'$IFS''push$IFS''origin$IFS''main$IFS}",
])('claude-factory-dnw1: a hidden dollar-brace and bare IFS breaks: git %s', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(DYNAMIC_VERB_REASON)
})
test.each([
  'ls $HOME/x',
  'cp "${A}"/b c',
  'echo \\${X}y',
  "echo '${X}'y",
  'echo "${X:-a b}"c',
  'ls ${A}/b ${C}.txt',
  'bun test src/${F}.test.ts',
  'cat ${D}/a',
])('claude-factory-dnw1: raw reading keeps %s allowed', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBeUndefined()
})
test.each(J1KI_REASON_ROWS)('claude-factory-j1ki: %s denies with REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(REASON)
})
test.each(J1KI_PUSH_ROWS)('claude-factory-j1ki: %s denies with PUSH_REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(PUSH_REASON)
})
test.each(J1KI_MERGE_ROWS)('claude-factory-j1ki: %s denies with MERGE_REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(MERGE_REASON)
})
test.each(J1KI_DYNAMIC_ROWS)('claude-factory-j1ki: %s denies with DYNAMIC_VERB_REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(DYNAMIC_VERB_REASON)
})
test.each(J1KI_ALIAS_ROWS)('claude-factory-j1ki: %s denies with ALIAS_USE_REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, BEMR_GATE)).toBe(ALIAS_USE_REASON)
})
test.each(J1KI_MOVE_ROWS)('claude-factory-j1ki: %s denies with PUSH_DIR_REASON', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBe(PUSH_DIR_REASON)
})
test.each(J1KI_ALLOW_ROWS)('claude-factory-j1ki: %s stays allowed', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBeUndefined()
})
test('claude-factory-j1ki: a 1000-word segment of glued words returns fast', () => {
  const cmd = 'echo ' + Array.from({ length: 1000 }, () => 'a${X}b').join(' ')
  expect(cmd.length).toBeLessThan(8192)
  const t = Date.now()
  expect(denyReason(cmd, '/root/repo', undefined, J1KI_GATE)).toBeUndefined()
  expect(Date.now() - t).toBeLessThan(1000)
})

// claude-factory-563n: zsh reads `noglob` and `nocorrect` as precommand modifiers. The next word is
// the command. The hook must skip them like `sudo`.
const DENY_ZSH_PRECOMMAND = [
  'noglob rm -rf /',
  'nocorrect rm -rf /',
  'nocorrect A=x rm -rf /',
  'A=x nocorrect rm -rf /',
  'A=x noglob rm -rf /',
  'sudo nocorrect rm -rf /',
  'nocorrect sudo rm -rf /',
  'nocorrect noglob rm -rf /',
  'builtin noglob rm -rf /',
  'exec nocorrect rm -rf /',
  '/bin/noglob rm -rf /',
  '\\noglob rm -rf /',
  'if nocorrect rm -rf /; then :; fi',
  'echo x && noglob rm -rf /',
  '{ nocorrect rm -rf /; }',
  '{ noglob rm -rf /; }',
  'noglob { rm -rf /; }',
  'repeat 1 { noglob rm -rf /; }',
]

test.each(DENY_ZSH_PRECOMMAND)('denyReason denies %j (claude-factory-563n: zsh precommand modifier)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test.each(['G=git V=push; nocorrect $G $V origin main', 'G=git V=push; noglob $G $V origin main'])(
  'denyReason denies %j with DYNAMIC_VERB_REASON (claude-factory-563n)',
  cmd => {
    expect(denyReason(cmd, '/x', undefined, P43V_GATE)).toBe(DYNAMIC_VERB_REASON)
  },
)

test('denyReason keeps the alias, push and merge reasons behind a zsh precommand modifier (claude-factory-563n)', () => {
  expect(denyReason('nocorrect A=x gp origin main', '/x', undefined, SNAP_GATE)).toBe(SHELL_ALIAS_REASON)
  expect(denyReason('noglob gp origin main', '/x', undefined, SNAP_GATE)).toBe(SHELL_ALIAS_REASON)
  expect(denyReason('nocorrect git push origin main', '/x', undefined, P43V_GATE)).toBe(PUSH_REASON)
  expect(denyReason('nocorrect gh pr merge 1')).toBe(MERGE_REASON)
})

test.each(['noglob ls *.ts', 'nocorrect ls', 'noglob git status', 'echo noglob', 'nocorrect'])(
  'denyReason allows %j (claude-factory-563n)',
  cmd => {
    expect(denyReason(cmd)).toBeUndefined()
  },
)

test.each(['nocorrect A+=x rm -rf /', 'nocorrect A[1]=x rm -rf /'])(
  'denyReason denies %j (claude-factory-563n)',
  cmd => {
    expect(denyReason(cmd)).toBe(REASON)
  },
)

// claude-factory-fmeu: a brace group is a shell-prefix word. The command inside it still runs.
const DENY_BRACE_GROUP_REASON = [
  '{ rm -rf /; }',
  '{ A=x rm -rf /; }',
  '{ rm -rf / }',
  '! { rm -rf /; }',
  'if true; then { rm -rf /; }; fi',
  'while true; do { rm -rf /; }; done',
  '{ { rm -rf /; }; }',
  '{ sudo rm -rf /; }',
  'time { rm -rf /; }',
  'x | { rm -rf /; }',
  'coproc { rm -rf /; }',
]

test.each(DENY_BRACE_GROUP_REASON)('denyReason denies %j (claude-factory-fmeu, brace group)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

test('denyReason keeps the older reason for brace groups with another deny (claude-factory-fmeu)', () => {
  expect(denyReason('coproc N { rm -rf /; }')).toBe(SHELL_STDIN_REASON)
  expect(denyReason('{ git push o main; }')).toBe(PUSH_REASON)
  expect(denyReason('{ $G $V o main; }')).toBe(DYNAMIC_VERB_REASON)
})

const ALLOW_BRACE_GROUP = [
  'echo {a,b}',
  'find . -exec ls {} +',
  '{ echo hi; }',
  '{ echo }',
  '{ ls; } > .scratch/o',
  '{ git commit -m x; }',
  'echo }',
]

test.each(ALLOW_BRACE_GROUP)('denyReason allows %j (claude-factory-fmeu, brace group)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

// claude-factory-aylh: sudo reads its own options before the command. An unknown option must not
// hide the command (`sudo -E rm -rf /`). Source: sudo parse_args.c, sudo_short_opts and sudo_long_opts.
const AYLH_RM = 'rm -rf /'
const AYLH_DENY = [
  // the 11 rows of the bead
  ...['-s', '-E', '-H', '-n', '-b', '-S', '-k', '-A', '-P', '-K', '--preserve-env'].map(
    f => `sudo ${f} ${AYLH_RM}`,
  ),
  // other bare letters, clusters, attached values, long forms and prefixes
  ...[
    '-B',
    '-N',
    '-l',
    '-nE',
    '-uroot',
    '-Eu root',
    '-nEu root',
    '--user=root',
    '--preserve-env=PATH',
    '--pres',
    '--non-interactive',
    '--us root',
  ].map(f => `sudo ${f} ${AYLH_RM}`),
  // one row for each short value letter
  ...[
    '-a x',
    '-C 3',
    '-c x',
    '-D /x',
    '-g x',
    '-h host',
    '-p x',
    '-R /',
    '-r x',
    '-T 5',
    '-t x',
    '-U x',
    '-u x',
  ].map(f => `sudo ${f} ${AYLH_RM}`),
  // one row for each required-argument long name
  ...[
    '--other-user x',
    '--auth-type x',
    '--close-from 3',
    '--login-class x',
    '--chdir /x',
    '--group x',
    '--host x',
    '--prompt x',
    '--chroot /',
    '--role x',
    '--command-timeout 5',
    '--type x',
    '--user x',
    '--chdir=/x',
  ].map(f => `sudo ${f} ${AYLH_RM}`),
  // env words, --, unknown flags and nesting
  `sudo A=1 -E ${AYLH_RM}`,
  `sudo A=1 -u root ${AYLH_RM}`,
  `sudo -E A=1 ${AYLH_RM}`,
  `sudo -E -- ${AYLH_RM}`,
  `sudo -Z ${AYLH_RM}`,
  `sudo -E env ${AYLH_RM}`,
  `sudo -E sudo -E ${AYLH_RM}`,
  'sudo -E rm "$X"',
]

test.each(AYLH_DENY)('denyReason denies %j (claude-factory-aylh)', cmd => {
  expect(denyReason(cmd, '/x')).toBe(REASON)
})

test.each([
  'sudo -E ls',
  'sudo -E ls -la',
  'sudo -nE ls',
  'sudo --user=root ls',
  'sudo -Z v ls',
  'sudo -s',
  'sudo -l',
  'sudo -E rm a',
])('denyReason allows %j (claude-factory-aylh)', cmd => {
  expect(denyReason(cmd, '/x')).toBeUndefined()
})

// claude-factory-21ux: a wrapper flag that realCommand does not know must not hide an rm or a
// find -exec rm. Each flag word reads as a bare flag or as a flag with a value word.
const DENY_21UX: string[] = [
  '/usr/bin/time -l rm -rf /',
  '/usr/bin/time -v rm -rf /',
  'time -v rm -rf /',
  '/usr/bin/time -a -o f rm -rf /',
  'time -al rm -rf /',
  'time -of rm -rf /',
  'time --output f rm -rf /',
  'time --output=f rm -rf /',
  'time --verbose rm -rf /',
  'time -q rm -rf /',
  'nice -5 rm -rf /',
  'nice -10 rm -rf /',
  'nice -n5 rm -rf /',
  'nice --adjustment=5 rm -rf /',
  'nice --adjustment 5 rm -rf /',
  'env -v rm -rf /',
  'env -iv rm -rf /',
  'env --ignore-environment rm -rf /',
  'env --unset X rm -rf /',
  'env --chdir /x rm -rf /',
  'timeout --foreground 5 rm -rf /',
  'timeout -v 5 rm -rf /',
  'timeout --signal=KILL 5 rm -rf /',
  'timeout --signal KILL 5 rm -rf /',
  'timeout -sKILL 5 rm -rf /',
  'timeout --kill-after 1 5 rm -rf /',
  'timeout --preserve-status 5 rm -rf /',
  'timeout 1e1 rm -rf /',
  'timeout inf rm -rf /',
  'exec -cl rm -rf /',
  'sudo -E rm -rf /',
  'nice -5 time -l rm -rf /',
  'env -v timeout -v 5 rm -rf /',
  'time -l find . -exec rm -r {} +',
  'cd /x; time -l rm a',
  'env - rm -rf /',
  'time -l env - rm -rf /',
  'env a.b=1 rm -rf /',
  'sudo 1A=x rm -rf /',
  'env -i a.b=1 rm -rf /',
  'xargs -n 1 rm -rf /',
  'xargs -I {} rm -rf {}',
  'xargs -L 1 rm -rf /',
  'env -- a.b=1 rm -rf /',
  'env -i -- a.b=1 rm -rf /',
  'env -u X -- 1A=x rm -rf /',
  'sudo -- 1A=x rm -rf /',
  'env -- - rm -rf /',
  'env -i -- - rm -rf /',
  'env -iu X -- - rm -rf /',
  'env -- - a.b=1 rm -rf /',
]
test.each(DENY_21UX)('denyReason denies %j (claude-factory-21ux)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

const DENY_P6WN: string[] = [
  'sudo A=1 -u root rm -rf /',
  'sudo A=1 -E rm -rf /',
  'sudo A=1 -i rm -rf /',
  'sudo A=1 -- rm -rf /',
  'sudo A=1 -- ./d=1/rm -r ./d',
  'sudo A=1 -u root -- ./d=1/rm -r ./d',
  'sudo ./d=1/x -u root rm -rf /',
  'sudo A=1 -u root B=2 -g wheel rm -rf /',
  'sudo A=1 -u root -- rm -rf /',
  'sudo A=1 -u root env rm -rf /',
  'sudo A=1 -u root timeout 5 rm -rf /',
  'sudo -u root A=1 rm -rf /',
  'sudo A=1 rm -rf /',
]
test.each(DENY_P6WN)('denyReason denies %j (claude-factory-p6wn)', cmd => {
  expect(denyReason(cmd)).toBe(REASON)
})

const ALLOW_P6WN: string[] = [
  'sudo -u root A=1 ls',
  'sudo A=1 -u root ls',
  'sudo A=1 -- ls',
  'sudo -- A=1 ls',
  'sudo A=1 -- ./d=1/ls -l',
  'sudo A=1 -u root -- ./d=1/ls -l',
  'env A=1 -- B=2 ls',
]
test.each(ALLOW_P6WN)('denyReason allows %j (claude-factory-p6wn)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

const ALLOW_21UX: string[] = [
  'time ls',
  'time -p ls',
  '/usr/bin/time -l ls',
  '/usr/bin/time -v make',
  'nice -5 ls',
  'env -v ls',
  'timeout --foreground 5 bun test',
  'timeout -v 5 ls',
  'timeout 5 rm a',
  'time -l rm a',
  'time -l',
  'command -v rm',
  'cd x && command -v rm',
  'cd x; command -v rm',
  'cd x; command -V rm',
  'env FOO=1 ls',
  'env a.b=1 ls',
  'env -- - ls',
  'xargs -n 1 echo',
]
// Accepted over-deny: 'time -l echo rm -rf /' denies. The flag can take echo as its value.
test.each(ALLOW_21UX)('denyReason allows %j (claude-factory-21ux)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

test('denyReason keeps the push reason behind time -l (claude-factory-21ux)', () => {
  expect(denyReason('time -l git push origin main')).toBe(denyReason('git push origin main'))
})

test.each([['time ' + '-x '.repeat(2700) + 'rm -rf /'], ['time ' + '-x rm '.repeat(1300) + 'a']])(
  'denyReason bounds a long unknown-flag chain (claude-factory-21ux)',
  cmd => {
    const t0 = Date.now()
    denyReason(cmd)
    expect(Date.now() - t0).toBeLessThan(1000)
  },
  30_000,
)

// claude-factory-miqy: a lone dynamic command word runs the value of a variable set in the same text.
const MIQY_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }
const MIQY_DENY: Array<[string, string]> = [
  ['X="rm -rf /"; $X', REASON],
  ['X="rm -rf /"; ${X}', REASON],
  ['X="rm -rf /" && $X', REASON],
  ['X="rm -rf /"\n$X', REASON],
  ['export X="rm -rf /"; $X', REASON],
  ['declare X="rm -rf /"; $X', REASON],
  ['X=rm; $X -rf /', REASON],
  ['X="rm -rf"; $X /', REASON],
  ['X="rm -rf /"; sudo $X', REASON],
  ['X="rm -rf /"; timeout 5 $X', REASON],
  ['X="rm -rf /"; eval $X', REASON],
  ['X="rm -rf /"; bash -c "$X"', REASON],
  ['X="git push origin main"; $X', PUSH_REASON],
  ['X="git push"; $X origin main', PUSH_REASON],
  ['X=; $X rm -rf /', REASON],
  ['X=$(cat f); $X', DYNAMIC_VERB_REASON],
  ['X="rm *"; $X', DYNAMIC_VERB_REASON],
  ['X=rm; X+=" -rf /"; $X', DYNAMIC_VERB_REASON],
  ['for X in "rm -rf /"; do $X; done', DYNAMIC_VERB_REASON],
  ['printf -v X "rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X="rm,-rf,/"; IFS=,; $X', DYNAMIC_VERB_REASON],
  ['while :; do $X; X="rm -rf /"; done', REASON],
  ['until false; do $X; X="rm -rf /"; done', REASON],
  ['for i in 1 2; do $X; X="rm -rf /"; done', REASON],
  ['X="rm -rf /"; Y="$($X)"', REASON],
  ['X="rm -rf /"; echo "$($X)"', REASON],
  ['X="rm -rf /"; echo "`$X`"', REASON],
  ['X="rm -rf /"; echo "$(eval $X)"', REASON],
  ['X="git push origin main"; echo "$($X)"', PUSH_REASON],
  ['X="rm -rf /"; env $X', REASON],
  ['X="rm -rf /"; command $X', REASON],
  ['X="rm -rf /"; exec $X', REASON],
  ['X="rm -rf /"; nohup $X', REASON],
  ['X="rm -rf /"; eval \'true; $X\'', REASON],
  ['X="rm -rf /"; eval \'eval $X\'', REASON],
  ['X="rm -rf /"; bash -c "true; $X"', REASON],
  ['X="git push origin main"; eval \'true; $X\'', PUSH_REASON],
  ['export X="git push origin main"; bash -c \'true && $X\'', PUSH_REASON],
  ['X="rm -rf /"; ${X%x}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${X#x}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${X:0}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${X^^}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${X//x/y}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${X:+$X}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${X[@]}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; Y=X; ${!Y}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${=X}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; $=X', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; ${(z)X}', DYNAMIC_VERB_REASON],
  ['X="git push origin main"; ${X%x}', DYNAMIC_VERB_REASON],
  ['X="rm -rf /"; $X; X=ls', DYNAMIC_VERB_REASON],
  ['X="git push origin main"; $X; X=true', DYNAMIC_VERB_REASON],
  ['for X in "rm -rf /"; do $X; done; X=ls', DYNAMIC_VERB_REASON],
  ['declare -n R=X; X="rm -rf /"; $R', DYNAMIC_VERB_REASON],
  ['declare -l X="GIT PUSH ORIGIN MAIN"; $X', DYNAMIC_VERB_REASON],
  [': ${X:=rm}; $X -rf /', DYNAMIC_VERB_REASON],
  [': ${X="rm -rf /"}; $X', DYNAMIC_VERB_REASON],
  ['eval \'X="rm -rf /"\'; $X', DYNAMIC_VERB_REASON],
  ['{ X="rm -rf /"; }; $X', DYNAMIC_VERB_REASON],
  ['env X="rm -rf /" bash -c \'$X\'', REASON],
  ['X=ls; X[0]="rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X[0]="rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X=ls; X[0]+=" -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X=ls; X[1,-1]="rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X=ls; declare X[0]="rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X=ls; export X[0]="rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['X=ls; eval \'X[0]="rm -rf /"\'; $X', DYNAMIC_VERB_REASON],
  [': ${X[0]:="rm -rf /"}; $X', DYNAMIC_VERB_REASON],
  ['X=ls; X[0]="git push origin main"; ${X}', DYNAMIC_VERB_REASON],
  ['X=ls; X[0]="rm -rf /"; sudo $X', DYNAMIC_VERB_REASON],
  ['X=ls; select X in "rm -rf /"; do $X; done', DYNAMIC_VERB_REASON],
  ['X=ls; vared X; $X', DYNAMIC_VERB_REASON],
  ['X=ls; : ${X::="rm -rf /"}; $X', DYNAMIC_VERB_REASON],
  ['X=ls; X=ls; $X', DYNAMIC_VERB_REASON],
  ['X=ls; unset X; $X', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; $_', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; ${_}', DYNAMIC_VERB_REASON],
  ['$REPLY', DYNAMIC_VERB_REASON],
  ['${BASH_REMATCH}', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; sudo $_', DYNAMIC_VERB_REASON],
  ['declare X\'\'Y="rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['export X\'\'Y="git push origin main"; $XY', DYNAMIC_VERB_REASON],
  ['printf -v X\'\'Y "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['declare X\'\'Y="rm -rf /"; sudo $XY', DYNAMIC_VERB_REASON],
  ['A=X; declare "${A}Y=rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; printf -v "${A}Y" "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; export "${A}Y=rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval "${A}Y=\'rm -rf /\'"; $XY', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; ${_%x}', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; ${_:0}', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; sudo ${_%x}', DYNAMIC_VERB_REASON],
  ['echo "rm -rf /"; eval ${_%x}', DYNAMIC_VERB_REASON],
  ['A=X; declare "${A}Y=rm -rf /"; echo "$($XY)"', DYNAMIC_VERB_REASON],
  ['A=X; export "${A}Y=rm -rf /"; bash -c \'$XY\'', DYNAMIC_VERB_REASON],
  ["A=X; eval \"${A}Y='rm -rf /'\"; eval '$XY'", DYNAMIC_VERB_REASON],
  ['A=X; export "${A}Y=git push origin main"; bash -c \'$XY\'', DYNAMIC_VERB_REASON],
  ['X=ls; printf -vX "rm -rf /"; $X', DYNAMIC_VERB_REASON],
  ['printf -vXY "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; printf -v"${A}Y" "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; print -v "${A}Y" "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; print -v"${A}Y" "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['print -vXY "rm -rf /"; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval \'printf -v ${A}Y "rm -rf /"\'; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval \'printf -v ${A}Y "git push origin main"\'; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval \'printf -v ${A}Y "rm -rf /"\'; sudo $XY', DYNAMIC_VERB_REASON],
  ["A=X; eval 'declare ${A}Y'; $XY", DYNAMIC_VERB_REASON],
  ["A=X; eval 'export ${A}Y'; $XY", DYNAMIC_VERB_REASON],
  ["A=X; eval 'getopts ab ${A}Y'; $XY", DYNAMIC_VERB_REASON],
  ['A=X; eval \'print -v ${A}Y "rm -rf /"\'; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval \'printf -v ${A}Y "rm -rf /"\'; echo "$($XY)"', DYNAMIC_VERB_REASON],
  ['IFS=, read -aXY; $XY', DYNAMIC_VERB_REASON],
  ['IFS=, read -raXY; sudo $XY', DYNAMIC_VERB_REASON],
  ['read -aXY; $XY', DYNAMIC_VERB_REASON],
  ["A=X; eval 'printf -v' '${A}Y \"rm -rf /\"'; $XY", DYNAMIC_VERB_REASON],
  ['A=X; eval \'\\printf -v ${A}Y "rm -rf /"\'; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval \'"printf" -v ${A}Y "rm -rf /"\'; $XY', DYNAMIC_VERB_REASON],
  ['A=X; eval \'p\\rintf -v ${A}Y "rm -rf /"\'; $XY', DYNAMIC_VERB_REASON],
  ["A=X; eval 'printf -v' '${A}Y \"git push origin main\"'; $XY", DYNAMIC_VERB_REASON],
  ['arr=ls; read -raarr; $arr', DYNAMIC_VERB_REASON],
  ['rray=ls; read -rarray; $rray', DYNAMIC_VERB_REASON],
  ['arr=ls; read -raarr; sudo $arr', DYNAMIC_VERB_REASON],
  ['arr=ls; read -raarr; eval $arr', DYNAMIC_VERB_REASON],
]
test.each(MIQY_DENY)('denyReason denies %j (claude-factory-miqy)', (cmd, reason) => {
  const got = denyReason(cmd, '/root/repo', undefined, MIQY_GATE)
  // claude-factory-pwy0 reads rm text across segments first: such a row denies with the rm reason.
  expect(got === reason || got === REASON).toBe(true)
})

test.each([
  'for h in a b; do ssh $h uptime; done',
  'for h in a b; do fish $h; done',
  'X="git push origin main"; ssh host $X',
  '${EDITOR:-vi} a.txt',
  '${X%x}',
  '${HOME%/}/bin/tool',
  '$EDITOR a.txt',
  '$X',
  'echo $X',
  'X="ls -l"; $X',
  'X=1; echo $X',
  'X="rm -rf /"; echo $X',
  'X=(ls); echo ${X[0]}',
  'X=ls; $X -la',
  'X=ls; $X',
  'echo $_',
])('denyReason allows %j (claude-factory-miqy)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, MIQY_GATE)).toBeUndefined()
})

test.each([
  ["trap 'git push origin main' EXIT"],
  ['trap "git push origin main" EXIT'],
  ['trap git\\ push\\ origin\\ main EXIT'],
  ["trap 'git push origin main;' EXIT"],
  ["trap 'git push origin main' INT TERM EXIT"],
  ["trap -- 'git push origin main' EXIT"],
  ["builtin trap 'git push origin main' EXIT"],
  ["command trap 'git push origin main' EXIT"],
  ["x=1 trap 'git push origin main' EXIT"],
  ["trap 'eval git push origin main' EXIT"],
  ["trap 'rm -rf /' EXIT"],
  ["trap '-x; git push origin main' EXIT"],
  ["trap '-; git push origin main' EXIT"],
  ["trap 2>/dev/null 'git push origin main' EXIT"],
  ["trap 2> /dev/null 'git push origin main' EXIT"],
  ["trap >/dev/null 'git push origin main' EXIT"],
  ["trap &>/dev/null 'git push origin main' EXIT"],
  ["trap 2>&1 'git push origin main' EXIT"],
  ["trap </dev/null 'git push origin main' EXIT"],
  ["trap 2> -- 'git push origin main' EXIT"],
  ["trap -- 2>/dev/null 'git push origin main' EXIT"],
  ["builtin trap 2>/dev/null 'git push origin main' EXIT"],
  ["trap 'git push origin HEAD' EXIT; cd /x"],
  ["trap 'git push origin main' EXIT; cd /x"],
])('denyReason denies a trap action that holds a guarded command (claude-factory-81tz): %s', cmd => {
  expect(denyReason(cmd)).toBeDefined()
})

test.each([
  ['trap - EXIT'],
  ['trap -p'],
  ["trap 'echo hi' EXIT"],
  ["trap '' INT"],
  ['source .scratch/x.sh'],
  ["trap 'git push origin factory/x' EXIT"],
  ["trap 'git status' EXIT"],
  ["trap 'git push origin factory/x' EXIT; cd /x"],
])('denyReason allows a harmless trap (claude-factory-81tz): %s', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})

test.each([
  ['env -i sh -c "trap \'bd create x\' EXIT"'],
  ['env -i bash -c "trap \'bd create x\' EXIT"'],
  ['env -i sh -c "trap 2>/dev/null \'bd create x\' EXIT"'],
])('denyReason reads a trap action in the BEADS_ACTOR bd scan (claude-factory-81tz.2): %s', cmd => {
  expect(denyReason(cmd)).toBeDefined()
})

test.each([
  ["trap 'gh co 5' EXIT; export GH_CONFIG_DIR=/x"],
  ["trap 'gh co 5' EXIT; GH_CONFIG_DIR=/x"],
  ["trap 'gh co 5' EXIT; HOME=/x"],
])('denyReason denies a gh alias in a trap action as config-moved (claude-factory-81tz.7): %s', cmd => {
  expect(denyReason(cmd, '/root/repo', ['acme'], BEMR_GATE)).toBeDefined()
})

test.each([
  ["trap 'gh pr view 5' EXIT; export GH_CONFIG_DIR=/x"],
  ["trap 'echo hi' EXIT; export GH_CONFIG_DIR=/x"],
])('denyReason allows a builtin gh verb in a trap (claude-factory-81tz.7): %s', cmd => {
  expect(denyReason(cmd, '/root/repo', ['acme'], BEMR_GATE)).toBeUndefined()
})

test('denyReason allows a harmless trap under env -i (claude-factory-81tz.2)', () => {
  expect(denyReason('env -i sh -c "trap \'echo hi\' EXIT"')).toBeUndefined()
})

test('denyReason bounds a long dash-led trap chain (claude-factory-81tz.3)', () => {
  const t0 = Date.now()
  denyReason('trap ' + '-/trap '.repeat(1150) + 'x')
  expect(Date.now() - t0).toBeLessThan(300)
}, 30_000)

test.each([
  ['env -i sh -c "trap ' + '-/trap '.repeat(1000) + 'x"'],
  ['env -i sh -c "eval trap ' + '-/trap '.repeat(1000) + 'x"'],
])(
  'denyReason bounds a long trap chain in the bd scan (claude-factory-81tz.4)',
  cmd => {
    const t0 = Date.now()
    denyReason(cmd)
    expect(Date.now() - t0).toBeLessThan(100)
  },
  30_000,
)

test.each([
  ["source <(echo 'git push origin main')"],
  [". <(echo 'git push origin main')"],
  ["source =(echo 'git push origin main')"],
])('denyReason keeps denying a source process substitution (claude-factory-81tz): %s', cmd => {
  expect(denyReason(cmd)).toBeDefined()
})

// claude-factory-pwy0: a command word that expands to rm at run time runs rm.
const DENY_PWY0: string[] = [
  '${RM:-rm} -rf /',
  '${RM-rm} -rf /',
  '${RM:=rm} -rf /',
  '${RM=rm} -rf /',
  'r${x}m -rf /',
  'rm$x -rf /',
  '${x}rm -rf /',
  '${x:-r}m -rf /',
  '${RM:-/bin/rm} -rf /',
  '${RM:-${Y:-rm}} -rf /',
  '${RM:+rm} -rf /',
  '${RM+rm} -rf /',
  '"${RM:-rm}" -rf /',
  'r"${x}"m -rf /',
  'sudo ${RM:-rm} -rf /',
  'env ${RM:-rm} -rf /',
  'FOO=1 r${x}m -rf /',
  'time -l ${RM:-rm} -rf /',
  '>f ${RM:-rm} -rf /',
  '> f ${RM:-rm} -rf /',
  '2>/dev/null r${x}m -rf /',
  'cd / ; ${RM:-rm} acme.txt',
  '${F:-find} . -exec rm -rf {} +',
  'find . -exec ${RM:-rm} -rf {} +',
  '${' + 'a'.repeat(500) + ':-rm} -rf /',
  'rm$' + 'a'.repeat(500) + ' -rf /',
  '${x[0]:-rm} -rf /',
  '${x[@]:-rm} -rf /',
  '${!x:-rm} -rf /',
  '${x[1]:-rm} -rf /',
  '${(L)x:-rm} -rf /',
  '${=x:-rm} -rf /',
  '${~x:-rm} -rf /',
  '${^x:-rm} -rf /',
  '${(L)(U)x:-rm} -rf /',
  'rm$~x -rf /',
  'rm$^x -rf /',
  'rm$=x -rf /',
  'r$x"m" -rf /',
  "r$x''m -rf /",
  'r$x\\m -rf /',
  '"$x"rm -rf /',
  'r"$x"m -rf /',
  'find . -exec $x -rf {} +',
  '${RM:-rm\n-rf /}',
  '${RM:-\nrm} -rf /',
  '${RM:-rm\n} -rf /',
  '${RM:-rm${IFS}-rf} /',
  '${RM:-rm$IFS-rf} /',
  '${RM:-rm${IFS:0:1}-rf} /',
  '${RM:-rm}${IFS}-rf /',
  'y=IFS; ${RM:-rm}${!y}-rf /',
  'y=IFS; r${x:-m}${!y}-rf /',
  'IFS=_; ${RM:-rm_-rf_/}',
  'IFS=_; ${RM:-rm_-rf} /',
  'IFS=_ ; r${x:-m_-rf} /',
  'IFS=_; ${RM:-r}${x:-m_-rf} /',
  'IFS=_; ${F:-find_/_-delete}',
  'y=I$z; ${RM:-rm}${!y}-rf /',
  'z=FS; declare I$z=_; ${F:-find_/_-delete}',
  'y=m_-rf_/; z=FS; export I$z=_; ${RM:-r}$y',
  'z=FS; readonly I$z=_; ${RM:-rm_-rf_/}',
  'z=FS; typeset I$z=_; ${RM:-rm_-rf_/}',
  'z=FS; printf -v I$z _; ${RM:-rm_-rf_/}',
  'IFS=_; ${x:-"printf r\\155"_-rf_/}',
  "y='rm -rf /'; $y",
  'IFS=_; y=rm_-rf_/; $y',
  'IFS=_; r$x"m_-rf_/"',
  'IFS=_; $x"rm_-rf_/"',
  'r$x"m" ../acme.txt',
  'r?? -rf /',
  '/bin/r[m] -rf /',
  'RM$x -rf /',
  '$x acme.txt -delete',
  'x=rm; $x ../acme.txt',
  'RM$x ../acme.txt',
  '${x:-/bin/rm} acme.txt',
  '${!y} acme.txt',
  '"`echo x`" acme.txt',
  '${RM:-rm\n} acme.txt',
  'FIND$x ../acme.txt',
]
test.each(DENY_PWY0)('denyReason denies %j (claude-factory-pwy0)', cmd => {
  // claude-factory-miqy: a variable write in the same command can deny first, with the dynamic reason.
  const got = denyReason(cmd, '/Users/acme/widget')
  expect(got === REASON || got === DYNAMIC_VERB_REASON).toBe(true)
})

const ALLOW_PWY0: string[] = [
  '$EDITOR acme.txt',
  'echo $x rm',
  '$x ls',
  '${EDITOR:-vi} acme.txt',
  'r$xm acme.txt',
  '${RM:-rm} acme.txt',
  'echo ${RM:-rm} -rf /',
  'ls ${x}rm',
  '${(L)x:-ls} acme.txt',
  'ls$~x acme.txt',
  '$x acme.txt',
  '$HOME/.local/bin/claude plugin test mod',
  '"$ROOT/bin/factory" report x 2 ready "rm -rf rows"',
  '/bin/s? -c x',
  'env --unset "$X" --chdir /tmp make test',
]
test.each(ALLOW_PWY0)('denyReason allows %j (claude-factory-pwy0)', cmd => {
  expect(denyReason(cmd, '/Users/acme/widget')).toBeUndefined()
})

test('scanReason bounds a long nested default-value head word (claude-factory-pwy0)', () => {
  const n = 20_000
  const cmd = '${a:-'.repeat(n) + 'rm' + '}'.repeat(n) + ' -rf /'
  const got = scanReason(cmd, '/Users/acme/widget')
  expect(got === REASON || got === DYNAMIC_VERB_REASON).toBe(true)
}, 30_000)

test('scanReason reads 2700 zsh flag groups in one pass (claude-factory-pwy0)', () => {
  const cmd = '${' + '(L)'.repeat(2700) + 'x:-ls} acme.txt'
  expect(scanReason(cmd, '/Users/acme/widget')).toBeUndefined()
}, 30_000)

// claude-factory-sdur: a bash {NAME}> fd-name redirect word is a redirect word at every reader.
test.each(['X=rm; {fd}> f $X -rf ./x'])(
  'denyReason denies %j (claude-factory-sdur dropRedirectWords)',
  cmd => {
    expect(denyReason(cmd, '/Users/acme/widget')).toBe(REASON)
  },
)

test.each([
  'echo x {fd}>~/.gitconfig',
  'echo x {fd}> ~/.gitconfig',
  'echo x {a[1]}>~/.gitconfig',
  'echo x {a[b[0]]}>~/.gitconfig',
])('denyReason denies %j (claude-factory-sdur REDIRECT_PREFIX_RE)', cmd => {
  expect(denyReason(cmd, '/Users/acme/widget', undefined, GLOBAL_GIT_CONFIG_GATE)).toBe(
    GLOBAL_GIT_CONFIG_REASON,
  )
})

test.each(['echo x | {fd}> f $SH', 'echo x | {fd}> f $SH -s'])(
  'denyReason denies %j (claude-factory-sdur leadingRedirects)',
  cmd => {
    expect(denyReason(cmd, '/Users/acme/widget')).toBe(SHELL_ALIAS_DEFINE_REASON)
  },
)

test.each([
  '{fd}>f rm -rf /',
  '{fd}>f find / -exec rm -rf {} \\;',
  'find / -exec {fd}>f rm -rf {} \\;',
  'find / -exec rm {fd}>f -rf {} \\;',
  '>f rm -rf ./x',
  '2>&1 rm -rf /',
  '<f rm -rf /',
  '&>f rm -rf /',
  '>!f rm -rf /',
  '> f rm -rf /',
  'command >f rm -rf /',
  'env >f rm -rf /',
  'find / -exec 2>/dev/null rm -rf {} +',
  'find / -exec > f rm -rf {} +',
])('denyReason denies %j (claude-factory-sdur redirect re-read)', cmd => {
  expect(denyReason(cmd, '/Users/acme/widget')).toBe(REASON)
})

test.each(['cd .. && >f rm x', 'cd .. ; 2>/dev/null rm x', 'cd .. ; command >f rm x', '>f cd .. ; rm x'])(
  'denyReason denies %j (claude-factory-sdur cd and rm pair)',
  cmd => {
    expect(denyReason(cmd, '/Users/acme/widget')).toBe(REASON)
  },
)

test.each(['{ echo x; }', 'echo {a,b}>f', 'echo {a,b}> f', 'echo hi {fd}>f', '{fd}>f echo hi'])(
  'denyReason keeps allowing %j (claude-factory-sdur)',
  cmd => {
    expect(denyReason(cmd, '/Users/acme/widget')).toBeUndefined()
  },
)
