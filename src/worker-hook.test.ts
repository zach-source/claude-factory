import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { DEEP_COMMAND_REASON, denyReason, LIVE_REASON, LONG_COMMAND_REASON, REASON } from './worker-hook'

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
