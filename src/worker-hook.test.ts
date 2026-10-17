import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  BEADS_ACTOR_REASON,
  DEEP_COMMAND_REASON,
  denyReason,
  LIVE_REASON,
  LONG_COMMAND_REASON,
  REASON,
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
// This test does not set personOnly. The 8192-character limit applies only when personOnly is set.
// So it does not apply here.
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

test('denyReason denies a 4000-level stacked eval rm -rf form, fast, no personOnly (claude-factory-epz)', () => {
  expect(denyReason('eval '.repeat(DEEP_RM_N) + 'rm '.repeat(DEEP_RM_N) + '; rm -rf x')).toBe(
    DEEP_COMMAND_REASON,
  )
}, 500)

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
// unchecked. So denyReason now denies a command longer than 8192 characters outright, before any
// scan, when personOnly is set.
const LONG_COMMAND_8192 = 'x'.repeat(8192)
const LONG_COMMAND_8193 = 'x'.repeat(8193)

test('denyReason denies a command over 8192 characters outright when personOnly is set (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8193, undefined, ACME)).toBe(LONG_COMMAND_REASON)
})

test('denyReason keeps today’s behavior for a command over 8192 characters when personOnly is empty or absent (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8193)).toBeUndefined()
  expect(denyReason(LONG_COMMAND_8193, undefined, [])).toBeUndefined()
})

test('denyReason gives a normal verdict for a command at exactly 8192 characters, personOnly set (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8192, undefined, ACME)).toBeUndefined()
})

// claude-factory-1by: anyShellReason calls shCFlagIndex(words.slice(j)) for each sh/bash/zsh/dash
// word. words.slice(j) costs O(n-j).
//
// The scan it feeds also costs O(n-j). On a miss, j moves by only 1.
//
// So a run of n such words with no `-c` cluster costs O(n^2). No personOnly is set here.
//
// So the 8192-character cap (claude-factory-25z.20) does not apply. Nothing else bounds the scan.
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

test('denyReason denies a 40000-word sh scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(denyReason('sh '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

test('denyReason denies a 40000-word bash -x scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(denyReason('bash -x '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

test('denyReason denies a 40000-word sh -- scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(denyReason('sh -- '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

test('denyReason denies an eval-wrapped 40000-word sh scan, fast, no personOnly (claude-factory-1by)', () => {
  expect(denyReason('eval ' + 'sh '.repeat(SCAN_N) + '; rm -rf x')).toBe(REASON)
}, 500)

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

test('denyReason still allows a 40000-word sh scan whose last word is a `-c` flag with no script (claude-factory-1by)', () => {
  expect(denyReason('sh '.repeat(SCAN_N) + '-c ls')).toBeUndefined()
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

// claude-factory-lbn: denyAt's find branch loops i over cmd. At each -exec/-execdir word, it
// runs cmd.slice(i + 1), then reads rest[0]. A slice costs O(n - i). A run of n -exec words makes
// n such slices, so the find branch costs O(n^2). This test does not set personOnly. So the
// 8192-character cap (claude-factory-25z.20) does not apply.
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

test('denyReason denies a 200000-word find -exec scan, fast, no personOnly (claude-factory-lbn)', () => {
  expect(denyReason('find . ' + '-exec '.repeat(FIND_N) + '; rm -rf x')).toBe(REASON)
}, 500)

// claude-factory-lbn: this shape still slices once per -exec word. It does so even when the fix
// checks baseWord(cmd[i + 1]) === 'rm' before the slice (the bead's own first proposal).
// The slice itself costs O(n), not the check before it. Each rm here carries no recursive flag.
// So the command must stay allowed.
test('denyReason allows a 200000-word find -exec rm scan, fast, no recursive flag (claude-factory-lbn)', () => {
  expect(denyReason('find . ' + '-exec rm '.repeat(FIND_N))).toBeUndefined()
}, 500)

test('denyReason denies a 200000-word find -exec rm scan with a recursive rm at the end (claude-factory-lbn)', () => {
  expect(denyReason('find . ' + '-exec rm '.repeat(FIND_N) + '-exec rm -rf x')).toBe(REASON)
}, 500)

test('denyReason denies a 200000-word find -execdir scan with a recursive rm at the end (claude-factory-lbn)', () => {
  expect(denyReason('find . ' + '-execdir '.repeat(FIND_N) + '-execdir rm -rf x \\;')).toBe(REASON)
}, 500)

const HOOK = join(import.meta.dir, 'worker-hook.ts')

async function run(stdin: string, env?: Record<string, string | undefined>, argv: string[] = []) {
  const p = Bun.spawn(['bun', HOOK, ...argv], {
    stdin: new Response(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
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
