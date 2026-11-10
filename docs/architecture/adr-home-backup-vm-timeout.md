# ADR: Diagnose the large home backup test on a VM

## Context

Bead: `claude-factory-pnhpp`. Plan base: `51f342a3`.
The full VM suite reported a 120000 ms timeout in `src/homebackup.test.ts:63`.
The second backup returned no `changed` value at line 82. This result does not identify the failed operation.
The first backup checks `error`; the second backup discards the result before it checks `changed`.
The test creates two files above 60 MiB and verifies compression, repeat backup, and restore.

The docs head is `d6067de983993ea6070c21a502a12362e98096e3`, from merged PR #810.
The plan compared both backup files against fetched `origin/main`; neither file differs.
This comparison does not prove equal runtime conditions or equal dependencies.
The docs change remains outside this defect.

The plan ran the unchanged focused suite at `51f342a3` with an isolated home and scratch temporary directory.
Bun 1.4.4 and gitleaks 8.30.1 match CI. All 33 tests and 264 assertions passed in 177.80 seconds.
The large test took 100.56 seconds against its 120-second limit.
Shell time reported 233.78 CPU user seconds and 39.58 CPU system seconds for the whole suite.
The VM reported 8 GiB memory, zero load, and a 65536 open-file limit.
CPU time, process count, and virtual memory limits were unlimited.
`ps` and the expected cgroup counter paths were unavailable. Phase measurements remain work for implement.
The plan did not run the paired source exports or the full suite. No root cause is established.

## Decision and design

Complete a bounded diagnosis and improve the existing test result checks in this run.
Do not change production backup code without a proven cause.
Use existing Git, Bun, gitleaks, and OS counters. Add no dependency or permanent profiler.
Keep diagnostic scripts and exported source snapshots under `.scratch/` in this worktree.
Do not create or alter another Git checkout.

First, compare fresh source exports of fetched `origin/main` and the docs head on the same VM.
Use `git archive` for the exports. Record the full source SHAs and tool versions.
Install each export with `bun install --frozen-lockfile`.
Give each run a fresh `FACTORY_HOME` and scratch temporary directory.
Set `FACTORY_SELF_UPDATE=0`; remove `FACTORY_OUTBOX` and `FACTORY_FROM` from the test environment.
Run each focused suite twice, in alternating revision order.
Use `bun test --timeout 30000 src/homebackup.test.ts` without timeout changes.
The explicit 120000 ms timeout still governs the large test.

Record wall time, CPU time, peak memory where available, CPU quota, process limits, and disk capacity.
Record CPU load before and after each run. Record unavailable counters explicitly.
Use a scratch-only profiler to separate fixture creation, Git operations, each secret scan, compression, and restore.
Use local bare remotes only. Never access a real backup home or remote.
Wrappers must preserve subprocess arguments, input, output, exit status, and timeout behavior.
Record only operation labels, elapsed time, exit status, signal, and timeout status.
Never record file contents, scan matches, environment values, auth headers, or raw scanner output.
Compare an instrumented run with an unmodified run to identify profiler overhead.

Next, change only the large test in `src/homebackup.test.ts`.
Keep the second result in a variable. Assert that its `error` is undefined before the existing `changed === false` assertion.
Assert that the second result has the first result's SHA and that the remote tip did not move.
Assert that each SHA is a nonempty string before equality checks.
Use the existing Git helper. Do not add a helper with one caller.
For diagnostic evidence, classify failures by phase without public raw error text.
Keep every existing size, byte-equality, small-file, and cleanup assertion.

Add measured results and the conclusion to this ADR during implement.
Separate observations from hypotheses. A focused pass does not disprove a full-suite resource failure.
If focused runs pass, attempt one isolated full suite within the 120-minute station budget.
Use `bun test --timeout 30000 src factories`; preserve its complete result in scratch.
Attribute unrelated failures only after a same-VM baseline comparison.
If time prevents the full-suite comparison, record the gap instead of a root-cause claim.

A production fix is outside this first diagnostic slice.
If evidence identifies one, file a separate dependent bug with the measurements and a proposed regression test.
Make that bug depend on this bead. Do not claim this run fixed production behavior.
If evidence remains inconclusive, record that result and the next specific experiment.
Do not create speculative performance work from a timeout alone.

### Rejected alternatives

- A larger timeout can hide an operation failure and lacks a measured basis.
- A smaller fixture loses the existing large-file coverage.
- A fake scanner in the large test removes the real scan cost from this reproduction.
- A scan bypass or cache changes secret protection without evidence.
- A generic benchmark service adds work that this diagnosis does not need.
- A production fix before phase measurements assumes a cause that the failure does not establish.

## Acceptance criteria

1. **AC1: Reproducible comparison.** Record four focused runs across the two pinned source exports.
   Proof: `bun test --timeout 30000 src/homebackup.test.ts`, with revision, environment, durations, and exit status per run.
   Include CPU load, resource limits, and phase measurements from at least one scratch diagnostic run.
   Negative rows: no shared test home, live backup remote, timeout increase, or result inferred from `changed` alone.
   If a counter is unavailable, name it and state the measurement limit.
   A pass must remain a pass observation, not proof that the original full-suite failure cannot recur.

2. **AC2: Repeat backup guarantees.** The large test checks both backup errors and equal first/second SHAs.
   The remote tip must stay equal after the second backup; `changed` must remain exactly `false`.
   Both source files must remain above 60 MiB. Restore must remain byte-equal for both files.
   Small files must stay plain; pushed blobs must stay below 50 MiB; restore must remove gzip artifacts.
   Proof: `bun test --timeout 30000 src/homebackup.test.ts` and review of the test diff.
   Negative rows: an error outcome, absent SHA, changed SHA, new remote commit, or `changed: true` must fail.
   Do not substitute `false` for an absent `changed` value or accept a truthy/falsy comparison.

3. **AC3: Preserve backup safety.** Keep the production backup, scan, redaction, restore, and auth code unchanged.
   Proof: `git diff origin/main -- src/homebackup.ts src/secrets.ts` and the complete focused suite.
   Existing negative cases must still refuse a missing scanner, excluded restore paths, and an unready home.
   Existing secret fixtures must still redact staged secrets and preserve source files.
   No new guard, parser, path grammar, or configuration format belongs in this run.

4. **AC4: Evidence and no regression.** The ADR must state the measured result, cause status, and any remaining gap.
   Prove each new result assertion detects its own invalid outcome with a temporary test-local mutation after a commit.
   Use synthetic error text only. Restore the mutation and rerun the focused suite.
   Run `bunx tsc --noEmit -p .`, pinned Prettier, `bun audit`, and the repository secret scan.
   If `bunx` is absent, use `bun x` with the same arguments.
   Require exact-head CI checks `test`, `plugin`, `typecheck`, and `format` before approval.
   Record the `nix` job result too. Do not substitute unrelated earlier CI results.
   Negative rows: no skipped test, weaker assertion, timeout change, or claim that an unrun check passed.

## Test plan

Start with the unchanged focused test and the paired revision measurements in AC1.
If the failure recurs, retain its phase and status as the pre-change evidence.
Write the explicit second-error and SHA assertions before any proposed production fix.
This run has no authorized production fix, and its new checks can pass on the baseline.
Do not invent a red baseline. Prove the new checks with independent invalid-result mutations under AC4.
An error mutation must fail the error assertion; a changed SHA must fail its equality assertion.
A moved remote tip must fail the remote equality assertion.
The existing `changed: true` negative row must still fail the exact Boolean assertion.
Each mutation must still compile. Each check must fail for its intended assertion, not an earlier shared assertion.

## Risk

The large fixture can consume substantial CPU, memory, and disk space.
Bound the experiment count and retain the existing subprocess and test limits.
Diagnostic output can expose secret scanner input. Use only synthetic local fixtures and phase metadata.
This run changes tests and this ADR only. It does not change secret protection or infrastructure access.
No migration, public API change, backup format change, or runtime compatibility change is necessary.
A later scan or auth change needs a separate security-sensitive plan and security review.
Security-sensitive: no

## Rollout and rollback

Open one draft pull request with this ADR, measured evidence, and the test changes.
No flag, migration, deployment, or owner credential step is necessary.
A person merges the pull request after the required checks and reviews.
Rollback uses a normal revert pull request for the test and ADR commits. Never force-push.

## Observability

The evidence is the paired VM measurements, focused test results, and exact-head CI.
There is no production change and no production metric target in this diagnostic slice.
No AC is must-see-live. Soak needs no live backup, pod, or secret scan read.
Do not infer production backup health from a test pass.

## Tasks

1. Record the paired VM diagnosis in this ADR. Check AC1 and the evidence part of AC4. Commit the measured conclusion.
2. Strengthen the large test result checks. Check AC2 through AC4. Commit the test change and final evidence.

Task 2 depends on task 1. Keep the total implement work within 120 minutes.
The report lists the child bead IDs. Any production fix needs a separate dependent bead with its own bounded scope.
