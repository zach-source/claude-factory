import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALIAS_REASON,
  BEADS_ACTOR_REASON,
  DEEP_COMMAND_REASON,
  denyReason,
  ENV_SPLIT_ESCAPE_REASON,
  ENV_SPLIT_VAR_REASON,
  type HookGate,
  LIVE_REASON,
  LONG_COMMAND_REASON,
  MERGE_REASON,
  PUSH_DIR_REASON,
  PUSH_REASON,
  READY_REASON,
  REASON,
  scanReason,
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
// This check is much faster than the 500 ms time limit of this test.
// This test does not read or measure the time used. `test()`'s own time limit does that check.
const DEEP_RM_N = 4000
const DEEP_RM_COMMAND = 'eval '.repeat(DEEP_RM_N) + 'rm '.repeat(DEEP_RM_N) + '; rm -rf x'

test('scanReason denies a 4000-level stacked eval rm -rf form, fast, no personOnly (claude-factory-epz)', () => {
  expect(scanReason(DEEP_RM_COMMAND)).toBe(DEEP_COMMAND_REASON)
}, 500)

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
const FIND_N = 200000

test('scanReason denies a 200000-word find -exec scan, fast, no personOnly (claude-factory-lbn)', () => {
  expect(scanReason('find . ' + '-exec '.repeat(FIND_N) + '; rm -rf x')).toBe(REASON)
}, 500)

// claude-factory-dts: the same over-8192-character command denies with LONG_COMMAND_REASON
// through denyReason, on every rig.
test('denyReason denies the same 200000-word find -exec scan with LONG_COMMAND_REASON (claude-factory-dts)', () => {
  expect(denyReason('find . ' + '-exec '.repeat(FIND_N) + '; rm -rf x')).toBe(LONG_COMMAND_REASON)
})

// claude-factory-lbn: this shape still slices once per -exec word. It does so even when the fix
// checks baseWord(cmd[i + 1]) === 'rm' before the slice (the bead's own first proposal).
// The slice itself costs O(n), not the check before it. Each rm here carries no recursive flag.
// So the command must stay allowed.
test('scanReason allows a 200000-word find -exec rm scan, fast, no recursive flag (claude-factory-lbn)', () => {
  expect(scanReason('find . ' + '-exec rm '.repeat(FIND_N))).toBeUndefined()
}, 500)

test('scanReason denies a 200000-word find -exec rm scan with a recursive rm at the end (claude-factory-lbn)', () => {
  expect(scanReason('find . ' + '-exec rm '.repeat(FIND_N) + '-exec rm -rf x')).toBe(REASON)
}, 500)

test('scanReason denies a 200000-word find -execdir scan with a recursive rm at the end (claude-factory-lbn)', () => {
  expect(scanReason('find . ' + '-execdir '.repeat(FIND_N) + '-execdir rm -rf x \\;')).toBe(REASON)
}, 500)

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
// gitChdir must fail closed in this case. It must deny with PUSH_DIR_REASON, and must not
// call gate.headOf.
const GIT_CHDIR_UNSAFE_ROWS: [string][] = [
  ['git --attr-source -C -C /acme/prot push origin HEAD'],
  ['git --attr-source -C -C /acme/prot send-pack origin HEAD'],
]

test.each(GIT_CHDIR_UNSAFE_ROWS)(
  'denyReason fails closed on an unresolved -C value, for %j (claude-factory-3f2z.7)',
  cmd => {
    const dirs: (string | undefined)[] = []
    const gate: HookGate = {
      cwd: '/acme/cwd',
      headOf: dir => {
        dirs.push(dir)
        return dir === '/acme/prot' ? 'main' : 'factory/x'
      },
    }
    expect(denyReason(cmd, '/acme/root', undefined, gate)).toBe(PUSH_DIR_REASON)
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
const GIT_CHDIR_FAKE_VERB_ROWS: [string][] = [
  ['git --attr-source push -C /acme/prot push origin HEAD'],
  ['git --attr-source send-pack -C /acme/prot send-pack origin HEAD'],
  ['git --attr-source push -C /acme/prot push'],
  ['git --attr-source push -C /acme/prot push origin'],
  ['git --attr-source push -C /acme/prot push --force'],
  ['git --attr-source send-pack -C /acme/prot send-pack origin'],
]

test.each(GIT_CHDIR_FAKE_VERB_ROWS)(
  'denyReason does not trust a fake push/send-pack word as the verb, for %j (claude-factory-3f2z.8)',
  cmd => {
    const dirs: (string | undefined)[] = []
    const gate: HookGate = {
      cwd: '/acme/cwd',
      headOf: dir => {
        dirs.push(dir)
        return dir === '/acme/prot' ? 'main' : 'factory/x'
      },
    }
    expect(denyReason(cmd, '/acme/root', undefined, gate)).toBe(PUSH_DIR_REASON)
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

// claude-factory-zl5.35: `git send-pack` is the plumbing `git push` itself calls, with no `push`
// word on its own command line. It takes the same refspec syntax, so this guard checks it the
// same way, through `refspecTarget` and `protectedBranchSet`.
test('denyReason denies git send-pack to a protected branch (claude-factory-zl5.35)', () => {
  expect(denyReason('git send-pack origin refs/heads/main')).toBe(PUSH_REASON)
  expect(denyReason('git send-pack --all origin')).toBe(PUSH_REASON)
  expect(denyReason('git send-pack origin', undefined, undefined, { headOf: () => 'main' })).toBe(PUSH_REASON)
  // the uncertain-verb path: an unrecognized global flag ahead of send-pack
  expect(denyReason('git --unknown-flag send-pack origin main')).toBe(PUSH_REASON)
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

// claude-factory-zl5.43: a dashed git-core binary name (`git-push`, `git-send-pack`, found on
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
const C63_GATE = { headOf: () => 'factory/x', originHead: () => 'main' }

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
