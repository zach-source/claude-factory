import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  denyReason,
  LIVE_REASON,
  LONG_COMMAND_REASON,
  MERGE_REASON,
  PUSH_REASON,
  READY_REASON,
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

// claude-factory-25z.20: the .17 fix made the scan linear. But a command of n eval words, then n
// bare kubectl words, then a real apply still costs about n^3. A command built to be about 26 KB
// can push that scan past the 10 s PreToolUse hook timeout. A timed-out hook runs the command
// unchecked. So denyReason now denies a command longer than 8192 bytes outright, before any
// scan, when personOnly is set.
const LONG_COMMAND_8192 = 'x'.repeat(8192)
const LONG_COMMAND_8193 = 'x'.repeat(8193)

test('denyReason denies a command over 8192 bytes outright when personOnly is set (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8193, undefined, ACME)).toBe(LONG_COMMAND_REASON)
})

test('denyReason keeps today’s behavior for a command over 8192 bytes when personOnly is empty or absent (claude-factory-25z.20)', () => {
  expect(denyReason(LONG_COMMAND_8193)).toBeUndefined()
  expect(denyReason(LONG_COMMAND_8193, undefined, [])).toBeUndefined()
})

test('denyReason gives a normal verdict for a command at exactly 8192 bytes, personOnly set (claude-factory-25z.20)', () => {
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

// claude-factory-zl5.1: a query=@file or --input file reference the hook cannot read is unknown, so
// it fails closed (denies); when the hook's gate can read the file, it scans the real content.
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
  expect(denyReason('gh api graphql --input body.json', undefined, undefined, safe)).toBeUndefined()
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
  'git -c alias.p=pushups p', // the alias value is not "push" or "push "
]

test.each(ALLOW_API_PUSH)('denyReason allows %j', cmd => {
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
