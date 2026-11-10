# ADR: Reap finished runs during hourly gc

## Context

Bead: `claude-factory-lt4u`. Plan base: `e6c6ff9f`.
The reported baseline was 3,968 run directories, with 3,861 done or aborted runs.
The original `gcPass` removed reproducible files but retained each run directory.
`factory rm` already removes a finished run and preserves its metrics and branch.
This change adds automatic retention, not a performance target.

## Decision and design

Use the existing retention setting: `--days N`, then `FACTORY_GC_DAYS`, then 7 days.
Use the last journal entry time, with `createdAt(id)` as the existing fallback.
A run is eligible at `now - finishedAt >= N * 86_400_000`.
Only `done` and `aborted` qualify. Unknown state or invalid time must retain the run.
Use one pass time so all rows have the same cutoff.

Extend `gcPlan` in `src/gc.ts` with eligible run IDs, independent of the reproducible file list.
A run with no prompts, briefs, or backups must still qualify.
Keep the current launch-script rules and file totals.

Extract the `rm` body in `src/cli.ts:14591` into one shared helper.
Both `rm` and `gcPass` must use that helper. The gc core operation must refuse workers before any host effect.
Re-read current state before removal. A run that became live must stay.
Preserve `makeWritable`, gate-lock removal, herdr removal, registered worktree removal, and guarded orphan cleanup.
Preserve the clean-submodule exception to the no-force rule.
Do not import the dirty-worktree snapshot policy from `gc --worktrees`.
Remove the worktree first. Append `record(id)` to `metrics.jsonl` next. Delete the run directory last.
Never delete a branch in this helper. Never continue to run-directory deletion after either prior step fails.

Replace the artifact-removal loop with one helper call per eligible run.
Do not prune artifacts from a run that the helper cannot reap. Retain that evidence for diagnosis.
Catch each run failure, log its ID and reason, then try the next run.
A second pass must tolerate a worktree that the first pass removed before a metrics write failed.
Keep existing metrics duplicate handling: a retry can append another record, and the last record wins.

Add a small durable `gc.log` in `FACTORY_HOME` for timestamped reap results and per-run failures.
Also print those results on the CLI. Reuse `gc.scrubUrlUserinfo` for error text.
This file is necessary because `kickGc` discards stdout and stderr (`src/cli.ts:6806`).
Do not add a telemetry service, new setting, or separate scheduler.
Dry-run prints eligible IDs, but does not call the helper or append metrics or gc logs.
Keep the existing `gc.stamp` and temporary lock behavior during dry-run; the promise is no deletion.
Update the gc help text in `src/cli.ts:12913` to state whole-run retention and branch preservation.

Use existing tests in `src/gc.test.ts`, `src/gc-cli.test.ts`, `src/gc-worktrees-cli.test.ts`, and `src/gc-kick.test.ts`.
Use real local Git worktrees for successful reap fixtures; the current gc CLI fixture is not a Git worktree.
Do not relax cleanup guards to accept that fixture.
No `.factory/` file changes are necessary.

### Rejected alternatives

- A subprocess `factory rm` per run adds startup cost and makes per-run errors harder to control.
- A second copy of the rm logic can lose future safety fixes.
- Raw recursive deletion bypasses dirty-worktree and submodule checks.
- Reuse of `gc --worktrees` changes branch retention and permits dirty-worktree snapshots.
- Select only `gcPlan.runs`: that list excludes runs whose reproducible files are already absent.
- Console output alone cannot expose failures from the hourly process.

## Acceptance criteria

Prefix new test names with `lt4u ACn`. These IDs replace no AC IDs in older tests.

1. **AC1: Whole-run removal and metrics.** In `src/gc-cli.test.ts`, test old done and old aborted runs with default settings.
   Each run directory and clean worktree must disappear. Each branch must retain its original tip.
   `metrics.jsonl` must retain the ID, final state, journal, and stored usage through `record(id)`.
   Include a run with no reproducible files and a run whose worktree is already absent.
   A second pass must add no record for a run already removed.
   Negative rows: no branch delete command, no remote mutation, and no duplicate record on a successful second pass.

2. **AC2: Retention rule.** Add a fixed-time table to `src/gc.test.ts` and CLI controls to `src/gc-cli.test.ts`.
   Test done and aborted at the cutoff, one millisecond younger, and one millisecond older.
   Test a custom environment cutoff and a CLI cutoff that overrides it.
   Retain every nonterminal state, regardless of age, including active, parked, and stuck states.
   Retain future or nonfinite times, unknown state, and unreadable or incomplete run metadata.
   Test the run-ID time fallback when the journal has no entry.
   Reject non-positive and nonnumeric `--days` before removal, as today.
   Retain a run that becomes live before the helper recheck.
   Ineligible rows must make zero removal, chmod, and metrics-append calls for that run.

3. **AC3: Dry-run.** In `src/gc-cli.test.ts`, assert eligible IDs appear in `gc --dry-run` output.
   Young and live IDs must not appear as reap candidates.
   Compare run files, worktree contents, branch tips, metrics, and gc logs before and after.
   Assert zero helper, chmod, and removal calls. Retain launch scripts too.
   The existing gc stamp and lock are outside this no-deletion assertion.

4. **AC4: Removal safety.** Extend real-worktree tests in `src/gc-worktrees-cli.test.ts` to cover plain `gc` and `rm`.
   Allow clean registered worktrees, read-only directory cleanup, and the existing clean-submodule case.
   Retain dirty tracked files, untracked user files, locked worktrees, dirty submodules, and submodule commits without remote refs.
   Retain an unregistered path when the existing guard refuses it.
   Cover symlinks, paths outside worktree roots, mismatched run names, the repo itself, and a failed Git registration read.
   A refusal must make zero recursive-delete calls for that path and must retain the run directory and branch.
   Do not add force removal on a status failure. Keep the present guard grammar and its full regression suite.
   No new shell, Git-output, or configuration parser is in scope.

5. **AC5: Failure isolation and archive order.** In `src/gc-cli.test.ts`, place a failed candidate before a valid candidate.
   Test worktree removal failure and metrics append failure separately.
   The failed run directory must stay. The next valid candidate must still reap when its operations can succeed.
   A metrics append failure must prevent run-directory deletion; a worktree failure must prevent archive and run deletion.
   Retry after repair must succeed, including an already-absent worktree.
   Assert CLI output and `gc.log` contain the failed ID, time, and reason.
   Assert successful IDs also appear in the log. Fake URL credentials must not appear there.
   An incomplete run directory must produce a diagnostic without stopping other candidates.

6. **AC6: Hourly integration.** Extend `src/gc-kick.test.ts` with an eligible fixture and wait for its actual deletion.
   A tick must start the reap pass and preserve the metric record.
   `FACTORY_GC=0`, an existing gc lock, and a fresh hourly stamp must prevent the automatic pass.
   A direct `factory gc` remains explicit and works with `FACTORY_GC=0`, as today.
   Keep launch-script safety tests and all `gc --worktrees` tests green.

7. **AC7: Release evidence, must-see-live.** This is a ship soak criterion, not a pre-merge gate.
   After normal release, read `gc.log`, `metrics.jsonl`, the relevant run paths, and branch refs from the factory host.
   Observe one automatic pass remove an eligible run and retain its metrics and branch tip.
   Confirm a live run and a young finished run remain.
   Record the release SHA, pass time, and run IDs. A stamp alone is insufficient evidence.
   Do not create or age production runs to manufacture this result. Wait for a natural eligible run.
   If the host read needs owner access, request that read through the manager. Do not substitute a deadline for evidence.

## Test plan

First commit the AC1 whole-run regression and AC3 dry-run ID assertion. Show both failures on the base code.
Add the AC2 table and AC4 through AC6 tests in that same test commit.
Change obsolete artifact-retention expectations to the new explicit retention contract; do not remove their safety assertions.
Keep `goto` and `resumeFile` coverage on retained young fixtures or explicit missing-prompt fixtures.
An expired run no longer exists for `goto`; do not promise revival after retention expiry.

Run `bun test --timeout 30000 src/gc.test.ts src/gc-cli.test.ts src/gc-worktrees-cli.test.ts src/gc-kick.test.ts`.
Run `bunx tsc --noEmit -p .` and changed-file Prettier checks.
Before handoff, run the repo test and plugin commands, the required gate, `bun audit`, and the secret scan.
Use `gitleaks detect --log-opts=origin/main..HEAD` for the commit range.
The final PR head must pass CI test, plugin, typecheck, and format.
Use buildable mutations for the terminal-state check, age check, and archive-before-delete order after the implementation commit.
Record the exact mutation command and result. Restore the worktree before handoff.

## Risk

This change is security-sensitive: unattended worktree deletion reuses filesystem permission changes and path checks.
Data loss is the primary risk. Dirty worktree checks and archive-before-delete order must remain intact.
The metrics record is not a backup of briefs, mail, logs, or pinned factory definitions.
Rollback cannot reconstruct those files after deletion.
Existing home backups are the recovery source; this plan adds no backup format or migration.
The branch remains, but later `gc --worktrees` can treat it as unowned after the run metadata disappears.
This follows the requested rm semantics; do not extend branch cleanup in this run.
The separate `claude-factory-r55o5` edge cases still refuse removal and retain all data.
This plan does not broaden their force allowance or make their retention failure worse.
No authentication, credentials, remote infrastructure commands, or new external input language changes are necessary.
Security-sensitive: yes (filesystem permissions and worktree deletion)

## Rollout and rollback

Use one draft PR for all test and implementation commits. A person must merge it before normal release.
No schema migration or factory definition update is necessary.
The existing hourly gc begins whole-run retention after release; the default remains seven days.
For a rehearsal, use an isolated factory home and `gc --dry-run`; do not run a plan-stage command on the live home.
The owner can set `FACTORY_GC=0` to stop automatic gc. Manual `gc` remains possible.
The owner can raise `FACTORY_GC_DAYS` before release to retain more history.
These are mitigation options, not authorized live configuration changes in this run.
Rollback uses a revert PR and normal release. It stops future reaps but does not restore deleted directories.

## Observability

`gc.log` supplies per-run success or refusal evidence even when the hourly process has no console.
`metrics.jsonl` preserves the removed run record. Existing metrics readers deduplicate by ID.
Soak correlates these records with absent run paths and retained branch refs under AC7.
No metric counter or dashboard is necessary.

## Original commit tasks

1. `claude-factory-lt4u.1`: AC1 through AC6 tests; show the baseline regression. Budget: 30 minutes.
2. `claude-factory-lt4u.2`: shared rm helper; preserve behavior and guards. Check: rm safety tests and typecheck. Budget: 20 minutes.
3. `claude-factory-lt4u.3`: whole-run gc, durable logs, and help text. Check: all final checks above. Budget: 70 minutes.

Each task depends on the prior task. All three belong in one PR with a green final head.
The first test commit can be red; no station must ship that intermediate commit.

## Original plan evidence

Plan read the bead, related bug, code, tests, CI workflow, and existing ADRs.
No root `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` exists in this checkout.
The memory search returned no local notes. No PR exists for this run branch.
`bun install --frozen-lockfile` passed.
`bun test --timeout 30000 src/gc.test.ts src/gc-cli.test.ts src/gc-kick.test.ts` passed: 82 tests, 185 assertions.
Plan did not run the full build, full suite, plugin tests, worktree suite, or production checks.
Those baseline tests prove the current artifact-only behavior, not the future reap behavior.
The ADR passed `bun node_modules/prettier/bin/prettier.cjs --check docs/architecture/adr-gc-finished-runs.md`.
The VM has no `bunx` command; use the installed tool entry point if necessary.

## Revised plan after the implement round cap

Revision base: `94aa9514dad843df3cd34c88e8b35b87864e764a`.
The existing draft PR is <https://github.com/zach-source/claude-factory/pull/785>.
Keep its implementation and completed tests. AC1 through AC7 remain the contract.
This revision replaces the original task schedule, not the acceptance criteria.

### Cause and bounded scope

Task `.7` combined several independent test groups. Workers closed it with explicit omissions.
Review required plain-gc evidence, but earlier reports substituted tests of the different `gc --worktrees` policy.
Later tests checked final files without all required call assertions.
Commit `94aa9514` now covers most state assertions. Do not repeat those additions.
No new runtime defect was established in this plan pass.

Change the test design: use one local call trace for the remaining side-effect assertions.
Keep it within the existing test file and isolated CLI child process.
Trace subprocess arguments and recursive filesystem removal. Delegate normal operations to their real implementations.
Trace metrics appends separately from reads of `usage.jsonl`.
Do not add a runtime environment flag, generic dependency container, or new production parser.
If child instrumentation needs a launcher, generate it inside the test fixture.
Use `bun --preload <fixture> src/cli.ts` for those cases; the normal wrapper also executes this module.
A scratch probe confirmed that `mock.module('node:fs', ...)` from `bun:test` can wrap `rmSync` in this child.
Capture real functions before the mock. Delegate calls after the trace, except the single injected append failure.
Assert a positive control reaches each traced operation before you trust a zero-call assertion.
Exclude fixture setup and teardown from the trace. Match operations to the candidate path or run ID.
Preserve actual Git worktrees and file assertions alongside the trace.

### Evidence map and remaining rows

| AC | Evidence present at the revision base | Remaining work |
| --- | --- | --- |
| AC1 | `gc-cli.test.ts:861`: exact stored sessions, complete journal, unchanged local refs | Trace zero branch-delete and remote-mutation commands during reap |
| AC2 | `gc-cli.test.ts:876`: herdr changes the second candidate to live before its recheck | Assert zero chmod, removal, and metrics append for that candidate |
| AC3 | `gc-cli.test.ts:909`: recursive contents, metrics, log, and branch tip remain unchanged | Assert zero helper side effects, chmod, and removal calls |
| AC4 | `gc-cli.test.ts:574,691,780,836`: dirt, locks, path guards, submodules, and orphan cases | Add repo-path, explicit registration failure, top-level status failure, and recursive-delete traces |
| AC5 | `gc-cli.test.ts:640,938`: global append failure and isolated record-read failure | Inject one actual append failure; prove next-candidate success and retry |
| AC6 | `gc-kick.test.ts:124,181`: hourly record fields and explicit gc with `FACTORY_GC=0` | No new row; retain these checks |
| AC7 | No local substitute | Existing must-see-live ship soak only |

Line numbers identify this revision base. Test names and AC IDs remain stable when lines move.
Use existing coverage for all other AC rows. Do not substitute worktree-gc tests for plain-gc rows.

For AC4, the refusal class is failure to establish safe removal under the existing rm policy.
An orphan must be a real directory below an allowed root, with a matching name, outside the repo.
Git must confirm that it is unregistered. Its `.git` must be absent or identify a dead gitdir.
Any failed check retains the target and run metadata. No recursive deletion can follow refusal.
Registered worktrees retain the existing Git refusal and clean-submodule policy.
Do not broaden force removal. Read-only repair can precede a Git refusal under the existing rm behavior.
The zero-chmod requirement applies to AC2 and AC3, not every registered dirty-worktree refusal.
Keep the existing metadata checks: nonempty string `id`, `repo`, and `worktree`; `id` must match the directory ID.
Keep the existing state, Git-output, and `.git` parsers. New shell grammars and new metadata formats are out of scope.

### Two remaining commit tasks

1. `claude-factory-lt4u.8`: Complete AC4 call evidence in `src/gc-cli.test.ts`. Budget: 40 minutes.
   Add the local trace with a successful-reap positive control.
   Add a repo-path fixture which reaches the repo protection, not an earlier name or root refusal.
   Make `git worktree list --porcelain` fail for a valid repo. Do not replace this with a nonexistent repo.
   Make the top-level status read fail after the clean-submodule check. Keep the existing submodule status-failure row too.
   Assert target contents, run metadata, branch tips, absent archive, and zero recursive deletion on each refusal.
   Add those trace assertions to existing orphan and unsafe-path rows.
   Check: `bun test --timeout 30000 src/gc-cli.test.ts src/gc-worktrees-cli.test.ts`.

2. `claude-factory-lt4u.9`: Complete AC1, AC2, AC3, and AC5 call evidence. Budget: 45 minutes, after task 1.
   Reuse the local trace. Extend existing tests rather than duplicate their fixtures.
   For AC1, prohibit branch-delete and remote-write commands, including delete-and-recreate sequences.
   For AC2, scope the zero-call assertions to the candidate that becomes live.
   For AC3, assert no worktree-removal command, chmod, archive append, or recursive deletion.
   Use the removal trace as helper-entry evidence; retain the early-return code check before `removeRun`.
   For AC5, fail only the first candidate's `metrics.jsonl` append, after `record(id)` succeeds.
   Assert its worktree is absent, its run directory remains, and the next candidate archives and disappears.
   Repair the injection and retry. Assert the retained run archives and disappears with its branch intact.
   Keep the existing global-write-failure and per-record-read-failure tests.
   Check: the four-file gc suite, typecheck, formatter, required gate, secret scan, audit, and exact-head CI.

Reserve 35 minutes for checks and handoff. Both tasks fit one 120-minute implement pass.
All work stays in PR 785. Do not create a stacked PR or defer safety rows to a later release.
Leave a task open if any named row remains absent. A green suite alone does not close an acceptance gap.
Each close comment must name its commit, test names, and check results.
The final report must map AC1 through AC6 to concrete assertions, including each negative row.

### Test-first and mutation evidence

Add each absent assertion before any production fix it exposes.
If a new test fails, show the failure on this revision base and fix only its cause.
If it already passes, do not force a fake regression. Use a buildable mutation to prove the relevant assertion.
After the test commit, mutate the live-state check, dry-run early return, and archive-before-delete order separately.
Use the factory mutation command and record each exact command and result.
Do not repeat already proven time and metadata mutations without a related code change.
A survived mutation is an evidence gap until the test catches its distinct path or the report proves redundancy.
Restore every mutation before handoff. No required check can remain red on the final PR head.

### Risk, rollout, and observability

The original Risk, Rollout and rollback, and Observability sections still apply.
This revision adds test evidence without a schema migration, retention change, or production operation.
Security review remains required because the implementation changes unattended deletion and filesystem permissions.
Keep AC7 as must-see-live after a person's merge and normal release.
No live read is a pre-merge acceptance condition. This plan authorizes no owner-only configuration change.
Security-sensitive: yes (filesystem permissions and worktree deletion)

### Revision checks

`bun install --frozen-lockfile` passed.
The four-file gc suite passed: 165 tests, 0 failures, 693 assertions.
This pass did not repeat the full repository suite, plugin tests, or live checks.
