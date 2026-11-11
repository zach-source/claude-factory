# ADR: Show controls as escapes in the manager Allow question

## Context

Bead: `claude-factory-ksx5`. Plan base: `8d6a84ed`.

The manager shows command text in a permission question.
`mod/hooks/view.ts:1296` cuts the head without an escape pass.
The substitution window at `:1333` also contains raw command text.
`mod/hooks/register.tsx:1584` presents the question through AskUserQuestion.
ESC, CR, bidi controls, and repeated newlines can obscure that question.
The bead comment also shows that 300 spaces hide the arguments of `factory decide`.

Existing tests cover cut counts, hidden gates, substitution windows, and surrogate pairs.
The fix must preserve those protections and the original command.
No repo CLAUDE.md, AGENTS.md, or CONTRIBUTING.md exists at this plan base.
The memory search returned no notes. This plan changes no executable code.

## Decision

Change the command display in `mod/hooks/view.ts`.
Extend `mod/tests/gate.test.ts` and `mod/tests/substitution-gate.test.ts`.
Use the existing test harness and standard string operations. Add no dependency or shell parser.

The display rule is total: no command-derived C0, DEL, or specified bidi control can reach the question unchanged.
The class is U+0000–U+001F, U+007F, U+202A–U+202E, and U+2066–U+2069.
Show LF, CR, and TAB as `\n`, `\r`, and `\t`.
Show other C0 controls and DEL as lowercase `\xhh` escapes.
Show the specified bidi controls as lowercase `\uhhhh` escapes.
Apply this rule to the head and the substitution window, including unreadable command forms.

Represent each run of two or more ASCII spaces as `\x20{N}`, where N is the source count.
Keep a single ASCII space unchanged. Label the preview notation when a repeated-space marker occurs.
This preserves the count inside quoted arguments and exposes arguments after 300 spaces.
Do not collapse arbitrary Unicode whitespace or discard controls.

Keep CUT at 300 displayed UTF-16 units for the head, excluding its suffix.
Select complete display tokens only. Never split an escape, space marker, or valid surrogate pair.
Retain each selected token's consumed source extent so cut counts refer to source units, not escape length.
Preserve the existing `… (N of M characters not shown)` suffix for omitted source text.
M uses the existing head source: joined command text, or raw text for the unreadable case.
The existing count convention uses JavaScript UTF-16 units; do not silently change it to code points.

Keep the substitution window centered on the raw source hit, with the existing 40-unit context on each side.
Escape that selected window after its surrogate-safe source cut.
Bound its escaped content at 492 units, plus edge ellipses, to allow surrogate-safe edges.
Keep the hit position in raw source coordinates.
Use actual source coverage for later-hit counts and hidden-gate notices after the head changes.
Do not use rendered offsets to index raw or joined command text.
Preserve the existing conservative count across canonical and unreadable reads.

Keep display transforms separate from gate detection and execution.
Preserve `ask`, `kinds`, denial text, caller rules, and Allow-token behavior.
The downstream Bash command must retain its original bytes after the existing trusted prefix.
This fix adds no input acceptance grammar and no new guard.
Existing shell recognition remains authoritative; no rejected form becomes allowed because its preview looks safe.
New shell forms, quoted-verb recognition, tool coverage, other prompt fields, and general Unicode confusables remain out of scope.

Rejected alternatives:

- Strip controls: the person loses evidence about the command.
- Collapse all whitespace: quoted text and command separators appear equivalent when they are not.
- Escape only the head: the substitution window remains exposed.
- Escape after the old 300-unit cut only: the 300-space case still hides the decision arguments.
- Change shared `cutText`: unrelated views need no behavior change.
- Change gate recognition: separate beads cover those defects.

## Acceptance criteria

### AC1: Escape the complete control class

Add tests named `ksx5 AC1` in the two existing test files.
Test every member of the defined class in both preview positions.
Include ESC, CR, U+202E, and 260 newlines in one command.
Place controls before the head cut and around a substitution beyond a long plain prefix.
Use a decide command so the hook presents an actual AskUserQuestion.
Assert the final question has no raw member of the class.
Assert exact visible escapes for members that the preview includes.
Assert a cut mark for the long row. Do not treat omitted text as evidence of correct escapes.
Negative rows: plain ASCII, single spaces, and valid emoji retain their content.
Proof: `claude plugin test mod`.

### AC2: Show significant arguments after repeated spaces

Add tests named `ksx5 AC2` in `mod/tests/gate.test.ts`.
Use `/repo/bin/factory decide` plus 300 spaces plus `r2 ship`.
Assert that the question contains `r2 ship` and `\x20{300}`.
Repeat for `decisions answer acme w-1` before its short answer and for `start` before `--owned`.
Test two spaces, a single space, and 300 spaces inside a quoted argument.
The quoted row must show an explicit count, not imply one literal space.
Assert unchanged gate kinds and original command bytes in a mocked Allow path.
Negative rows: ordinary one-space commands stay unchanged; tabs and newlines use escapes, not the space marker.
Proof: `claude plugin test mod`.

### AC3: Preserve truthful bounds and notices

Add tests named `ksx5 AC3` across both test files.
Pin exact source counts for controls that expand before the cut and spaces that contract before the cut.
Cover lengths 299, 300, and 301 for plain ASCII.
Cover surrogate pairs at the head boundary and both window boundaries.
Cover an escape token at the head boundary. Assert no partial escape or replacement character.
Assert hidden-gate notices for each existing gate kind beyond the actual visible head.
Test repeated spaces before a hidden second gate and before a substitution.
Test later substitution candidates inside and outside the actual visible source coverage.
Retain odd/even backslash-newline and comment-continuation rows with their current gate outcomes.
No notice can claim a fully visible occurrence is hidden solely because the old cut was 300 source units.
Existing conservative counts for alternate reads remain permitted.
Proof: `claude plugin test mod`; retain all existing cut and window assertions for unchanged rows.

### AC4: Preserve permission behavior

Use existing gate, substitution, and main-chat-marker suites plus the new integration rows.
A Deny answer and an absent or invalid answer must make zero downstream Bash calls.
A subagent gated call must make zero dialog and downstream Bash calls.
A substitution-only factory command must stay denied, even when the mock would answer Allow.
A confirmed ordinary decide command must run once with the existing prefix and original command body.
Status and existing safe single-quoted substitution text must remain allowed without a dialog.
One-call and turn-scoped grants must retain their existing lifetime and scope.
Proof: `claude plugin test mod`.

### AC5: Prove the regression and pass the required checks

Record the new tests' expected failures on pre-fix code, then their pass after the fix.
Commit the tests first. Keep tests and the fix in one PR with a green final head.
After the fix commit, use `factory mutate <file:line> <old> <new> -- claude plugin test mod`.
Independently bypass the head escape, window escape, and repeated-space display paths.
Each mutant must compile and fail the related assertion. Exit 0 means the test killed the mutant.
If one helper serves both escapes, mutate its two call sites independently.

Run these checks on the final implementation:

```sh
bun run test
bun run typecheck
bun run format:check
gitleaks detect --log-opts=origin/main..HEAD
bun audit
```

CI requires `test`, `plugin`, `typecheck`, and `format` on the final PR head.
CI uses `bunx tsc --noEmit -p .` because clean checkouts lack generated mod engine types.
If local `bun run typecheck` lacks those files, record that gap and run the CI command plus the plugin suite.
Do not fabricate engine types or weaken checks.

## Test and task order

One implement pass must finish both tasks within 120 minutes.

1. `claude-factory-ksx5.1`: Commit regression tests for AC1–AC4. Record expected display failures with `claude plugin test mod`.
2. `claude-factory-ksx5.2`: Commit the minimal preview fix. Pass AC1–AC5, then open one draft PR for both commits.

Task 2 depends on task 1. The tests-only commit must not ship alone.
The station report records child IDs and the ADR commit.
No task changes `.factory/`, public CLI behavior, or the worker hook.

## Risk

This is security-sensitive permission prompt code.
An incorrect preview can hide the action that a person authorizes.
Offset drift can also hide a later gate or misstate omitted text.
Tests must cover display and decision behavior separately.
The compact space notation changes presentation, including quoted text, but preserves its explicit source count.
No database, stored token, credential, migration, or command protocol changes.
No new log captures command contents.
Security-sensitive: yes (permission prompt and untrusted command display)

## Rollout and rollback

Use the normal reviewed plugin release after a person merges the PR.
Use no feature flag or data migration. Require security review.
The owner controls any manager restart that the release needs.
To undo the change, revert the fix and its tests through a new reviewed PR.
Rollback restores the known display defect; report that risk to the owner.
Do not change live credentials or systems for this work.

## Observability

The plugin tests capture the same question that AskUserQuestion receives.
Their assertions prove control absence, bounded previews, counts, and zero execution on refusal.
No new metric or log is necessary for this local display change.
The ship soak checks the released revision and its plugin test results through approved release checks.
An owner can inspect a denied synthetic question in a fresh manager session after release.
That optional check must not execute a real decision or use a real secret.
No AC is must-see-live. A production read or owner demonstration is not a pre-merge condition.
