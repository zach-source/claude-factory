import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALIAS_REASON,
  DEEP_COMMAND_REASON,
  denyReason,
  LIVE_REASON,
  LONG_COMMAND_REASON,
  MERGE_REASON,
  PUSH_REASON,
  READY_REASON,
  REASON,
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
const DENY_ENV_SPLIT_STRING: Array<[string, string]> = [
  ["env -S 'gh pr merge 5'", 'MERGE_REASON'],
  ["env -S 'gh pr ready 5'", 'READY_REASON'],
  ["env -S 'git push origin main'", 'PUSH_REASON'],
  // the attached form: no space between -S and the quoted value
  ["env -S'git push origin main'", 'PUSH_REASON'],
  // a short-flag cluster ahead of S, value as its own word
  ["env -vS 'git push origin main'", 'PUSH_REASON'],
  ["env --split-string='git push origin main'", 'PUSH_REASON'],
  // claude-factory-dgf (AC1): a value flag takes its own value word (FOO, /tmp, /usr/bin). That
  // word does not start with `-`. The old scan stopped there and never reached `-S`. The fix must
  // skip past the value word.
  ["env -u FOO -S 'git push origin main'", 'PUSH_REASON'],
  ["env -C /tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  ["env -P /usr/bin -S 'git push origin main'", 'PUSH_REASON'],
  // claude-factory-dgf (AC2): the long forms of the same value flags.
  ["env --unset FOO -S 'git push origin main'", 'PUSH_REASON'],
  ["env --chdir /tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  ["env --argv0 x -S 'git push origin main'", 'PUSH_REASON'],
  ["env -a x -S 'git push origin main'", 'PUSH_REASON'],
  // claude-factory-dgf (AC3): a short cluster that ends in a value flag (`-iu FOO`) skips one word.
  ["env -iu FOO -S 'git push origin main'", 'PUSH_REASON'],
  // claude-factory-dgf (AC4): GNU getopt_long accepts a unique prefix of a long option name.
  ["env --spl 'git push origin main'", 'PUSH_REASON'],
  ["env --sp='git push origin main'", 'PUSH_REASON'],
  //
  // claude-factory-dgf.4: a prefix of a long value flag name must also skip its value word.
  // Real GNU env 9.11 runs `--uns FOO -S` and `--ch /tmp -S`.
  ["env --uns FOO -S 'git push origin main'", 'PUSH_REASON'],
  ["env --ch /tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  //
  // claude-factory-dgf.5: the attached long form (`--unset=FOO`) holds its value in one word.
  // It must not take the next word too. That word is the real `-S`.
  ["env --unset=FOO -S 'git push origin main'", 'PUSH_REASON'],
  ["env --chdir=/tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  //
  // claude-factory-dgf.6: the attached short form (`-uFOO`) holds its value in one word too.
  // It must not take the next word. That word is the real `-S`.
  ["env -uFOO -S 'git push origin main'", 'PUSH_REASON'],
  ["env -C/tmp -S 'gh pr merge 5'", 'MERGE_REASON'],
  //
  // claude-factory-dgf.7: a bare `-` is not an option word. The scan must pass it and continue.
  // Real macOS `/usr/bin/env - -S 'echo x'` runs the string: BSD `env` reads `-` as an option.
  ["env - -S 'git push origin main'", 'PUSH_REASON'],
]
const ENV_SPLIT_STRING_REASON: Record<string, string> = {
  MERGE_REASON,
  READY_REASON,
  PUSH_REASON,
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

// claude-factory-dgf (AC5): these must stay allowed. Real `env` stops reading options at the
// first `NAME=VALUE` word, so `-S` after one is the command itself, not a flag. `-u`/`-C` without
// a later `-S` just set up the environment for an unrelated command. `-uS` is one cluster whose
// first char, `u`, consumes the rest of the word (`S`) as its own value: no separate `-S` flag.
test('denyReason allows env value-flag forms with no real split-string flag (claude-factory-dgf)', () => {
  expect(denyReason("env FOO=1 -S 'git push origin main'")).toBeUndefined()
  expect(denyReason('env -u FOO echo hi')).toBeUndefined()
  expect(denyReason('env -C /tmp git status')).toBeUndefined()
  expect(denyReason("env -uS 'git push origin main'")).toBeUndefined()
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
