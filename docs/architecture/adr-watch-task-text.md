# ADR: Clean review text before watch creates a task

## Context

Bead: `claude-factory-b0vm`. Inspected base: `18a9a04b`.

`src/watch.ts:186` trims and clips review bodies, but preserves unsafe characters.
`src/cli.ts:11832` takes the first line for a task title.
`src/cli.ts:11835` passes the body to the task description.
The task store and console can thus receive terminal controls and invisible format characters.
`cleanText` and `cleanReport` already define the required character policy at `src/cli.ts:1762` and `:1765`.

## Decision

Clean both arguments at the existing watch `b.create` boundary in `src/cli.ts`.
Apply `cleanText` to the first line after the existing `cut(..., 80)` operation.
Pass 80 as its maximum; retain the current cap without a new ellipsis.
Apply `cleanReport` to the complete description, including the URL and two LF separators.
Keep the shared helpers unchanged.
Keep the existing body trim, `BODY_CLIP = 2000`, fallback text, and trust checks unchanged.

The output rule covers every Unicode Cc, Cf, Zl, and Zp character.
Replace each such character with a space in the title.
Use the same rule in the description, except that LF and TAB remain unchanged.
No unsafe character in these classes can pass through either argument, subject only to those two description exceptions.
This is text normalization, not a new command parser or authorization guard.
No shell grammar, path grammar, or downstream rejection rule applies.
The input fields are the existing decision bodies and URL; they remain data arguments to the beads adapter.

Change `src/watch.test.ts` to record fake-bd argv as JSON arrays.
Update its existing assertions to read argument boundaries without loss.
Do not add a production abstraction, dependency, flag, or file.
Plan changes only this ADR. Implementation changes the CLI and its existing watch test file.

## Acceptance criteria

### AC1: Remove the complete unsafe character class

Add tests named `b0vm AC1` in `src/watch.test.ts`.
Use the real watch CLI and fake-bd fixture to assert actual `create` arguments.
Test ESC followed by `[2J`, CR, NUL, DEL, C1 U+0085, Cf U+202E, Zl U+2028, and Zp U+2029.
Place unsafe characters inside the first line and a later line, away from trim boundaries.
Include title TAB as a denied title character.
Assert exact expected space replacements and absence of the whole prohibited class.
The literal printable suffix `[2J` remains text after ESC becomes a space.
Test both a trusted `CHANGES_REQUESTED` review and a trusted `/changes` comment.
Proof: `bun test --timeout 30000 src/watch.test.ts`.

### AC2: Preserve permitted text and limits

Add tests named `b0vm AC2` with the same command.
Ordinary ASCII, non-ASCII letters, and an emoji must remain unchanged.
Description LF and TAB must remain unchanged; title controls must become spaces.
Preserve the `PR change request: ` prefix and the URL plus two LF separators.
Preserve the existing first-line cut at 80 characters without an added ellipsis.
Preserve the existing body cut at 2000 characters and its Unicode-safe cut behavior.
Test long text around both limits and a short plain-text control row.
Preserve the existing empty-review fallback text.
Each accepted request must create one task with `--parent acme-1` and `-t task`.

### AC3: Preserve request eligibility and route behavior

Add or extend tests named `b0vm AC3` with the same command.
OWNER, MEMBER, and COLLABORATOR people remain eligible for reviews and `/changes` notes.
Bots, NONE association, and absent association must create zero tasks.
Ordinary comments without `/changes` and reviews without a change request must create zero tasks.
Include old requests at or before the park time; these must create zero tasks.
Assert the existing changes route, and no second task after a second watch pass before tick.
Retain existing GitLab fallback, no-deploy-worker, and failed-view tests.
No eligibility expansion or review-body command execution is permitted.

### AC4: Prove the regression and complete checks

Record the AC1 failure against pre-fix code at the actual title and description assertions.
Keep the tests and fix in one PR; the final head must pass.
After the fix commit, use `factory mutate` to bypass each new sanitizer separately.
Use `factory mutate <file:line> <old> <new> -- bun test --timeout 30000 src/watch.test.ts`.
Each mutant must compile; the corresponding argument assertion must kill it.
Run `bun run test`, `bunx tsc --noEmit -p .`, and `bunx prettier@3.9.9 --check .`.
Run `gitleaks detect --log-opts=origin/main..HEAD` and `bun audit`.
Require green `test`, `plugin`, `typecheck`, and `format` CI on the final PR head.
Record local tool gaps explicitly; use exact-head CI for unavailable plugin checks.

## Test plan

Write AC1 tests first, then the AC2 and AC3 controls.
Use JSON argv records rather than shell-joined logs, which lose LF and argument boundaries.
Keep the fixture's isolated `FACTORY_HOME`, stripped worker markers, and `FACTORY_SELF_UPDATE=0`.
Run the focused command before the fix and record the unsafe-argument failures.
Then apply the two boundary changes and run AC1 through AC4.
Do not alter a shared sanitizer merely to satisfy this path's tests.

## Rejected alternatives

- Clean only the title: the description still carries unsafe text into the task store.
- Clean only in `src/watch.ts`: the task boundary then depends on an upstream cleanup convention.
- Change the beads adapter globally: that changes unrelated task producers beyond this defect.
- Reject the whole review: that loses a valid change request because its text contains a control character.
- Add a new sanitizer: existing helpers already implement the required character classes.

## Risk

This is security-sensitive input normalization at an external review boundary.
Format characters can affect legitimate script layout; the existing helper policy intentionally replaces them.
No task schema, API, credential, permission, dependency, or database migration changes.
Existing stored tasks remain unchanged; this fix applies to new watch-created tasks.
Route summaries, mail bodies, other task producers, and general terminal escape parsing remain outside this plan.
No new defect or wider production exposure follows from the proposed two argument changes.
Security-sensitive: yes (untrusted review text)

## Rollout and rollback

Use one draft PR with tests first and the fix second.
Complete verify, review, and security before a person merges it.
Release through the normal CLI distribution path; no flag or migration order is necessary.
For rollback, revert the fix through a new PR for a person to merge.
A rollback restores the unsafe text path; prefer a fix forward for compatibility defects.
Do not change a live system or existing task data as part of this run.

## Observability

The argv assertions prove that unsafe characters cannot enter new tasks through this path.
Existing `watch.json` route counts and task parent links show that task creation still works.
No new metric or raw-review log is necessary.
Ship soak can repeat the focused fixture with the released CLI in a disposable home.
Do not inject controls into a real review or use the live factory home for a probe.
No AC is must-see-live; local end-to-end tests and exact-head CI prove this bounded change.
Production reads, if needed, belong to ship soak and remain subject to owner access rules.

## Tasks

1. `claude-factory-b0vm.1`: Add AC1 through AC3 tests and record the pre-fix failure. Commit tests first.
2. `claude-factory-b0vm.2`: Clean both arguments, prove mutations, and complete AC4. Commit the fix second.

Task 2 depends on task 1. Both tasks fit one implementation pass within 120 minutes.
Do not publish the tests-only state as a completed change with red required checks.
