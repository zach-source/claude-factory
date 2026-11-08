# ADR: Read command heads past redirects

## Context

Bead: `claude-factory-qn8a.14`. Status: proposed for implementation.

At `30e36e0e`, all ten unsafe rows below return `undefined` from `denyReason`.
The three safe controls also return `undefined`.
A scratch probe confirmed these results without execution of the command text.

`commandAnchors` treats a redirect word as the command head.
A slash in that word can hide a dynamic command from a later check.
The same problem occurs after `nice` and `sudo`.

## Decision

Change `src/worker-hook.ts` and `src/worker-hook.test.ts`.
Add one release note at the end of Unreleased in `CHANGELOG.md`.
Do not change the factory definition or the sandbox.

Use the existing redirect grammar in `dropRedirectWords`.
Make the shared anchor reader see the command after redirects, including redirects within wrapper prefixes.
Keep indices relative to the original word array for every caller.
Preserve wrapper flag values, assignments, timeout durations, anchor caps, scan budgets, and nested wrapper behavior.
Do not duplicate the redirect regular expression across readers.
A small shared redirect-width helper is acceptable if both readers use it.

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

## Grammar and scope

This is a best-effort deny hook, not permission to execute a command.
The sandbox remains the security boundary.
The fail-closed rule is: redirects must not hide a command head from any existing anchored denial.
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

Out of scope: a full shell grammar, redirect side effects, process-substitution target parsing,
new wrapper syntax, and the separate assignment defect in `qn8a.59`.
The process-substitution defect in `qn8a.40` remains separate.
Do not make this patch depend on either sibling.

## Acceptance criteria

Use root `/root/repo`, `headOf: () => 'factory/x'`, `originHead: () => 'main'`,
and `gitAliases: () => new Map()` for the core table.
Use fake gate readers for all other gate data that a test needs.

AC1. Test `qn8a.14 redirect dynamic deny` must reject all rows below.
Run `bun test --timeout 30000 src/worker-hook.test.ts -t qn8a.14`.
Record the failures before the fix, then the pass after the fix.
Denial means a nonempty reason; allowance means `undefined`.

Amendment: the rows with a quoted script word after `$X` cannot deny from this
change. The quoted-script rule is claude-factory-ibas (PR 235, closed unmerged;
the bead is deferred). Until ibas lands, the test for those rows asserts parity:
the verdict with the redirect equals the verdict without it. Unquoted rows must deny.
The control `2>&1 $X "rm -rf /"` in AC2 follows the same rule.

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
Run the AC1 command and `bun test --timeout 30000 src/worker-hook.test.ts`.

AC4. Prove the redirect fix matters with a buildable mutation.
Commit the tests first and the fix second in the same pull request.
After the fix commit, disable only the new redirect skip.
Use `factory mutate <file:line> <old> <new> -- bun test --timeout 30000 src/worker-hook.test.ts -t qn8a.14`.
The mutant must build, and at least one AC1 assertion must fail. Exit 0 means the test killed the mutant.
If the implementation has separate skip branches, mutate each branch alone.
Restore the committed code and confirm a clean worktree.
No required check may remain red on the final pull request head.

AC5. Preserve the repository checks on the final head.
Run `bun test --timeout 30000 src factories`, `bunx tsc --noEmit -p .`,
`claude plugin test mod`, and `bunx prettier@3.9.9 --check .`.
Run `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
Record tool gaps separately; do not call an unavailable check a pass.
The required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on that head.

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

1. Add the AC1–AC3 regression tests. Record red results against the parent code.
   Check: the focused command, plus a baseline inventory of existing control results.
2. Fix the shared anchor reader and add the release note. Depend on task 1.
   Check: AC1–AC5, the caller audit, and isolated mutations.

Both tasks fit one 120-minute implement pass and one pull request.
The test commit can fail locally before the fix; the final pull request head must pass every required check.

## Plan evidence

Plan read the repo metadata, existing ADR, CI workflow, anchor callers, and redirect reader.
No root `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` exists in this checkout.
The bead had no children or prior comments. This branch had no pull request.
The memory search returned no local notes.
Plan changed only this ADR; implementation and mutation evidence belong to the next station.

Tasks: `claude-factory-qn8a.14.1` adds tests; `claude-factory-qn8a.14.2` depends on it and supplies the fix.
The hook baseline has 6,326 passes and one failure in the Git builtin inventory test.
That failure also occurs alone on Git 2.47.0. No production code changed in plan.
Typecheck and the ADR format check pass.
The VM has no `bunx` executable; `bun x` or the installed binary supplies the equivalent command.
Plan did not run the full repo suite, plugin check, audit, or secret scan.
