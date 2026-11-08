# ADR: Read command heads past redirects

## Context

Bead: `claude-factory-qn8a.14`. Status: revised plan after four implementation rounds.

At `30e36e0e`, all ten unsafe rows below return `undefined` from `denyReason`.
The three safe controls also return `undefined`.
A scratch probe confirmed these results without execution of the command text.

`commandAnchors` treats a redirect word as the command head.
A slash in that word can hide a dynamic command from a later check.
The same problem occurs after `nice` and `sudo`.

At `3ef9d269`, the unquoted rows deny, but the quoted script rows still allow.
The tests at `src/worker-hook.test.ts:12259` can pass without an assertion when the plain command allows.
The earlier ADR amendment confused parity with the required denial. This revision removes that amendment.

The missing prerequisite is the dynamic script reader from PR 235.
The owner closed that PR for conflicts, not because the owner rejected its behavior.
The [owner comment](https://github.com/zach-source/claude-factory/pull/235#issuecomment-6306781897) permits a class run to reuse its commits.
Rebuild the required reader here. Do not reopen PR 235 or wait for its deferred bead.
Keep the tests and the prerequisite in PR 702. Do not ship a deliberately red final head.

## Decision

Change `src/worker-hook.ts` and `src/worker-hook.test.ts`.
The release station writes the changelog, per `factories/lifecycle.ts:200`. Implement must add no release note or version bump.
Do not change the factory definition or the sandbox.

Use the existing redirect grammar in `dropRedirectWords`.
Make the shared anchor reader see the command after redirects, including redirects within wrapper prefixes.
Keep indices relative to the original word array for every caller.
Preserve wrapper flag values, assignments, timeout durations, anchor caps, scan budgets, and nested wrapper behavior.
Do not duplicate the redirect regular expression across readers.
A small shared redirect-width helper is acceptable if both readers use it.

Keep the redirect work through `3ef9d269`. Adapt `dynamicHeadScripts` from `412b8d4` to the current shared anchors.
Read the joined words after the first dynamic head as an eval script.
Also read each later word with whitespace or a shell operator as a possible script.
Use the existing `denyAt` path in `anyShellReason`, after the current checks, so existing reasons keep priority.
Use the same extraction in `segmentRunsBdCommand` through `stringNamesBdCommand` with the current `EnvGuard` argument.
Preserve the caller's root, gate, variable table, directory state, recursion depth, and shared work budget.
Do not copy the old function signatures or reset the budget for each script.
Read only the first applicable dynamic anchor per interpretation. The joined script covers later dynamic heads through recursion.
Reuse the prior nested-brace and path controls. Do not add a parser dependency or resolve variables from the environment.

The tokenizer removes some quote information.
Keep the original interpretation as well as the interpretation without redirects where quotes create ambiguity.
A denial from either interpretation must win.
Audit every `commandAnchors` caller, including callers that read only its first result.
Do not assume that an extra index at the end fixes those callers.

Rejected alternatives:

- Patch only `dynamicHeadRmReading`: quoted scripts and other anchor users retain the defect.
- Strip redirects from all command arrays: indices change, and quoted arguments can lose their original interpretation.
- Deny all dynamic heads after redirects: this rejects the three required safe controls.
- Add a shell parser dependency: the installed tokenizer and redirect reader already supply the required data.
- Retain parity tests: they accept the reported bypass and can make zero assertions.
- Wait for ibas: its PR is closed, and the prerequisite fits this run.
- Cherry-pick the complete old branch: it includes obsolete context and a release note that this station must not write.

## Grammar and scope

This is a best-effort deny hook, not permission to execute a command.
The sandbox remains the security boundary.
The fail-closed rule is: redirects must not hide a dynamic head or a prohibited script after that head.
If either supported interpretation denies, the complete command must deny before command execution.

The reader uses only the token string, its original index, and the next token for a detached target.
The closed redirect grammar follows `dropRedirectWords`:

- Descriptor: absent, decimal digits, or `{NAME}` with the existing optional subscript syntax.
- Operator: `>`, `>>`, `&>`, `&>>`, `<`, `<>`, `<<`, `<<-`, or `<<<`.
- Suffix: the existing optional `&`, `&|`, `&!`, `|`, or `!` forms.
- Target: the rest of the same token, or exactly one next token when the rest is empty.
- Target text is opaque. Absolute paths, relative paths, descriptors, and expansion text receive no filesystem resolution here.

Use the exact existing regular expression as the grammar authority; do not broaden it in this patch.
Words outside this grammar must not disappear as redirects. Keep them in the original scan.
Existing checks retain their rejection rules for unsupported shell syntax and incomplete input.
This patch adds no shell execution, target expansion, file open, render, or downstream command call.
Tests call the pure guard with fake gate readers; unsafe command text must never run.

The script reader accepts token strings and original indices from the existing tokenizer, not a second shell parser.
Its dynamic-head grammar covers dollar expansions, quoted dollar heads, literal prefixes such as `e$X`, and zsh split expansions.
Retain the old tests for nested and escaped parameter braces before a slash.
A literal path suffix after the last parameter brace excludes the head from this script interpretation.
Examples are `$ROOT/bin/factory` and `${ROOT}/bin/factory`. An expansion-internal slash is not a literal path suffix.
Single-quoted literal heads are not dollar expansions.
Script candidates are the joined suffix and each suffix word with whitespace or `; & | < > ( ) $` or backtick.
The existing shell reader checks these candidates. Its malformed-input, depth, and work-limit rejections must remain fail-closed.
Unrecognized redirects must not consume a word or its next token. Keep their raw interpretation under the existing checks.
Do not treat an unrecognized form as a safe path or discard it.
This deny-only hook does not claim a closed grammar for all allowed shell commands.
It adds no downstream execution. Tests must show zero command executions, file opens for targets, and real gate subprocess calls.

Out of scope: a full shell grammar, redirect side effects, process-substitution target parsing,
new wrapper syntax, and the separate assignment defect in `qn8a.59`.
The process-substitution defect in `qn8a.40` remains separate.
Do not make this patch depend on either sibling.
Also out of scope: all other `qn8a.6` instances, a dynamic head as the tool itself (`$X -rf /`), and `find -exec` redesign.

## Acceptance criteria

Use root `/root/repo`, `headOf: () => 'factory/x'`, `originHead: () => 'main'`,
and `gitAliases: () => new Map()` for the core table.
Use fake gate readers for all other gate data that a test needs.

AC1. Test `qn8a.14 redirect dynamic deny` must reject all rows below.
Run `bun test --timeout 30000 src/worker-hook.test.ts -t qn8a.14`.
Record the failures before the fix, then the pass after the fix.
Denial means a nonempty reason; allowance means `undefined`.

Every row needs an unconditional denial assertion. Also deny the quoted rows without a redirect.
The missing ibas reader is part of this implementation, not an exception to AC1.

```text
>/dev/null $X "rm -rf /"
> /dev/null $X "rm -rf /"
>x $X "rm -rf /"
>>log $X "rm -rf /"
2>/dev/null $X "rm -rf /"
>/dev/null 2>&1 $X "rm -rf /"
nice >/dev/null $X "rm -rf /"
sudo >/dev/null $X "rm -rf /"
>/dev/null $X rm -rf /
>/dev/null $X "git push origin main"
```

AC2. Test `qn8a.14 redirect controls` must preserve these allowances:

```text
>/dev/null $X "hello world"
>/dev/null "$ROOT/bin/factory" status
>/dev/null $EDITOR notes.md
```

The same test must preserve these denials:

```text
>/dev/null eval "rm -rf /"
>/dev/null rm -rf /
>/dev/null sh -c "rm -rf /"
>/dev/null $X -c "rm -rf /"
&>/dev/null $X "rm -rf /"
</dev/null $X "rm -rf /"
2>&1 $X "rm -rf /"
```

Run the AC1 command for AC2.

AC3. Test `qn8a.14 redirect anchor invariants` must cover the class beyond the original rows.
Add table cases for attached and detached targets, repeated redirects, assignments before redirects,
and redirects before and after nested wrappers.
Include `sudo -u root >out nice -n 5 >err $X "rm -rf /"`
and `timeout >out 5 $X "rm -rf /"`; both must deny.
For each supported redirect family, put `$X "rm -rf /"` after its complete prefix; it must deny.
Preserve the existing tests for quoted redirect-like words and unknown wrapper flags.
Add a safe nested-wrapper control with `$EDITOR notes.md` that must allow.
Check the current behavior first; do not broaden existing denials to satisfy a new allowance.
Exercise an anchored glob denial and an alias-definition denial after a redirect with their existing gate fixtures.
Record which test covers each anchor caller. Keep current caps and index semantics.
The caller map must include these ten consumers:
`gluedAtCommandSlot`, `gluedBraceSlots`, `dynamicHeadRmReading`, `shellStdinReason1`, `segmentDynArg`,
`segmentMayDefineAlias`, `anyGlobCommandWord`, `anyDynamicCommandReason1`, `anyLiveApplyWord`, and `anyDynamicLiveApplyReason1`.
Use actual alias fixtures, including a fake alias that expands to a prohibited command.
Replace the conditional tests at `src/worker-hook.test.ts:12294` with explicit expected results.
Pin both first-head classifications for `['>x', '/bin/echo', 'alias']` and `['>x', 'echo', '$name']`.
Preserve the `sdur` reason-order tests and all unknown-flag and tail-scan denials.
Pin the raw baseline budget before edits: the ordinary cap is 16, and the existing tail scan can add candidates.
The review's `nice` plus 40 `-Q $G` pairs plus `x` returns 18 without a redirect.
It must return at most 18 with `>x`; do not impose a false absolute limit of 16 on the tail scan.
Preserve the current single-pass bound for plain, nested-wrapper, unknown-flag, and tail-scan cases.
Do not discard a required raw denial to meet a count. A length assertion alone does not prove behavior.
Run the AC1 command and `bun test --timeout 30000 src/worker-hook.test.ts`.

AC4. Prove the redirect fix matters with a buildable mutation.
Commit the tests first and the fix second in the same pull request.
After the fix commit, disable only the new redirect skip.
Use `factory mutate <file:line> <old> <new> -- bun test --timeout 30000 src/worker-hook.test.ts -t qn8a.14`.
The mutant must build, and at least one AC1 assertion must fail. Exit 0 means the test killed the mutant.
If the implementation has separate skip branches, mutate each branch alone.
Also mutate the joined script read, individual script read, environment-guard mirror, and path classification separately.
Each mutation needs a targeted failed assertion, not an unrelated error or a build failure.
If `factory mutate` refuses this file, use a temporary literal edit after a commit and restore only that edit.
Restore the committed code and confirm a clean worktree.
No required check may remain red on the final pull request head.

AC5. Preserve the repository checks on the final head.
Run `bun test --timeout 30000 src factories`, `bunx tsc --noEmit -p .`,
`claude plugin test mod`, and `bunx prettier@3.9.9 --check .`.
Run `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
Record tool gaps separately; do not call an unavailable check a pass.
The required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on that head.
Use Bun 1.4.4, Prettier 3.9.9, and Claude Code 2.1.291, as specified in `.github/workflows/ci.yml`.
The full test command must also set `PKGGATE_E2E_REQUIRE=1` and `PG_SCRATCH_REQUIRE=1`, as CI does.
Put those exports in a scratch script if the worker hook rejects inline assignments.

AC6. Test `qn8a.14 dynamic script prerequisite` must check both script interpretations and the shared environment guards.
Run the AC1 command. These inputs must deny, both plain and after `>out`:

```text
$X 'rm -rf' /
$X x "rm -rf /"
$X 'git push' origin main
${X:-${Y}/} "rm -rf /"
e$X "rm -rf /"
env -u BEADS_ACTOR $X 'bd create acme'
env -u FACTORY_FROM $X 'factory mail acme manager'
```

Use fake gates and test-local environment values for both guarded variables. No real bead or mail command may run.
Retain the PR 235 nested-brace, quoted-head, split-head, and safe-path rows in the existing test file.
These inputs must allow with and without `>out`:

```text
"$PY" -c "print(1)"
$X "hello world"
$EDITOR notes.md
$GIT status
$X "a b" c
$GREP -n "foo bar" file
$CC -o out "my file.c"
${PAGER:-less} "notes file.md"
"${ROOT}/bin/factory" status
```

AC7. Test `qn8a.14 script budget` must preserve bounded work and reject exhausted parser budgets before execution.
Run the AC1 command and the existing worker-hook timing tests without higher thresholds.
Measure both PR 235 cases: 200 `$X` words then `"x y"`, and `$X` then 200 `"x y"` words.
Each must finish in less than 1 second on the test runner. Record durations before and after the fix.
Add nested-script cases that exhaust depth and work budgets; assert denial and zero downstream command executions.
Do not add production metrics or execute any supplied script to measure this behavior.

## Risk, rollout, and rollback

This change is security-sensitive because it parses shell input.
The main risks are false allowances, false denials, wrong word indices, and extra scan cost.
The existing cap and timing tests must retain their thresholds.
There are no data changes, migrations, credentials, new flags, or configuration changes.

Use one draft pull request for the tests and fix. Review and security must inspect the shared parser change.
A person must merge the pull request before the normal release process deploys it.
The release must use the merged commit. No owner-only live command is part of this plan.
Rollback uses a new revert pull request and the normal release process.
A rollback restores the known bypass; record that risk before a person approves it.

## Observability

The existing hook denial result and reason provide the signal. Add no metrics or command-text logs.
Verify the released revision through the normal release evidence.
Run the AC1 and AC2 tables against that revision in an isolated checkout.
Never execute their command strings in a shell.
No acceptance criterion is must-see-live: this fix has a deterministic parser oracle and needs no production event.
The ship soak can use revision evidence and offline guard results; it needs no live shell probe.

## Commit tasks

1. `claude-factory-qn8a.14.7`: add unconditional AC1–AC3 and AC6–AC7 tests in `src/worker-hook.test.ts`.
   Record red results against `3ef9d269`. Check the focused command and baseline safe controls.
2. `claude-factory-qn8a.14.3` (reopened): adapt the script prerequisite in `src/worker-hook.ts`. Depend on task 1.
   Preserve the redirect fix and the anchor budget. Check AC1–AC7 and isolated mutations.
   Correct stale comments in the touched functions and refresh the PR evidence. Add no changelog entry.

Both tasks fit one 120-minute implement pass and one pull request.
The test commit can fail locally before the fix; the final pull request head must pass every required check.

## Plan evidence

Plan read the repo metadata, existing ADR, CI workflow, anchor callers, redirect reader, and prior PR 235 code.
No root `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` exists in this checkout.
The retry starts at `3ef9d269`, with a clean worktree and draft PR 702.
CI run `42461843247` passed test, plugin, typecheck, and format on that code head.
The focused `qn8a.14|leadingRedirects|sdur|anchor` command passed 86 tests with 74 assertions.
A separate pure probe confirmed three quoted-script allowances, one unquoted denial, and all three required safe allowances.
The memory search returned no local notes. Plan changes only this ADR.
Plan did not repeat the full suite, typecheck, plugin check, audit, secret scan, or mutations.
These prior checks do not satisfy the revised AC1 or prove the future implementation.
