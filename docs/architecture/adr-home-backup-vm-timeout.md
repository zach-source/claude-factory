# ADR: Diagnose the large home backup test on a VM

## Context

Bead: `claude-factory-pnhpp`. Plan base: `51f342a3`.
The full VM suite reported a 120000 ms timeout in `src/homebackup.test.ts:63`.
The second backup returned no `changed` value at line 82. This result does not identify the failed operation.
At the plan base, the first backup checked `error`; the second backup discarded the result before its `changed` check.
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

### VM evidence from implement

The paired exports used these source SHAs:

- Main: `51f342a313235d72c1795568ecbfbbcd231f594a`.
- Docs: `d6067de983993ea6070c21a502a12362e98096e3`.

Neither backup source file differs between these revisions.
Each export used `bun install --frozen-lockfile`, Bun 1.4.4, and gitleaks 8.30.1.
Each run used a separate scratch home and temporary directory under `.scratch/paired/`.
Each run set `FACTORY_SELF_UPDATE=0` and removed `FACTORY_OUTBOX` and `FACTORY_FROM`.
All backup remotes were local test fixtures.
The command was `bun test --timeout 30000 src/homebackup.test.ts`.
The large test retained its explicit 120000 ms limit.

| Run | Source | Wall seconds | User CPU seconds | System CPU seconds | Large test seconds | Tests pass/fail | Assertions | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Main | 187.26 | 246.47 | 42.22 | 104.65 | 33/0 | 264 | 0 |
| 2 | Docs | 189.72 | 247.25 | 45.01 | 105.75 | 33/0 | 264 | 0 |
| 3 | Main | 190.66 | 242.64 | 47.83 | 105.03 | 33/0 | 264 | 0 |
| 4 | Docs | 194.62 | 247.92 | 50.24 | 107.36 | 33/0 | 264 | 0 |

The VM reported six CPUs and 8 GiB memory, with no swap.
Load averages were zero before and after every run.
The VM counter implementation can limit these observations; zero does not prove spare host CPU capacity.
The open-file limit was 65536. CPU time, process count, and virtual memory limits were unlimited.
The filesystem reported 1067.04 GiB total and 884.67 GiB available before the runs.
Child peak RSS reached 2185436 KiB after run 1 and 2187120 KiB after run 3.
This RSS counter is a cumulative child maximum, not an independent peak for each run.
The paths `cpu.max`, `pids.max`, and `memory.max` under `/sys/fs/cgroup/` were unavailable.
Thus, these measurements cannot rule out a host CPU quota or a process limit outside the VM view.
The VM also lacked `ps`, so no process-list measurement was available.

A separate scratch export measured the large test with phase wrappers.
The wrappers passed subprocess arguments and options unchanged and returned the original results.
They retained input, output, error, signal, and timeout behavior.
The log held only phase labels, durations, exit codes, signals, and error codes.
It held no scanner input or scanner report.
The test passed in 103.62 seconds, versus 104.65 and 105.03 seconds without wrappers on main.
This comparison detected no positive profiler overhead; it cannot separate small overhead from run variance.

| Phase | Count | Total seconds | Detail |
| --- | --- | --- | --- |
| Fixture creation and file writes | 1 | 1.13 | Two files used the same large buffer. |
| Secret scan | 4 | 82.45 | Individual times: 41.31, 0.13, 40.87, 0.14 seconds. |
| Git subprocess | 74 | 12.97 | Maximum call: 2.79 seconds. |
| Compression | 4 | 2.90 | Two files for each backup. |
| Decompression | 2 | 0.76 | Part of restore. |
| Complete restore | 1 | 1.91 | Includes its Git calls and decompression. |

All four scan subprocesses exited 0. No measured subprocess reported a signal or timeout error.
Some Git probes returned nonzero status as part of normal branch and difference checks; the test passed.
The second backup returned no error.
The first profiler command selected the package test script because its Bun option order was wrong.
Implement stopped that run and excluded it from the measurements above.

The scans consumed about 79.6% of the measured large test time.
This observation identifies the largest measured cost, not the cause of the earlier failure.
The failure did not recur in the four paired focused runs. No production change follows from this evidence.
The next experiment must capture phase status during a full-suite recurrence on the same VM.
It must also compare the focused test immediately afterward, with host CPU quota data if available.

The test change retains the second result and checks its error before its exact Boolean `changed` result.
It checks nonempty string SHAs for both backups and requires the same SHA.
It checks the remote tip before and after the second backup.
All original size, blob, byte-equality, small-file, and cleanup checks remain.
Production backup and secret code stay unchanged.
The paired focused evidence does not include a full-suite comparison.
The station report records the final gate and independent mutation results.

A later clean baseline under `factory mutate` exceeded the large test limit at 120.83 seconds.
A second clean baseline exceeded the limit at 120.62 seconds.
Both runs used the stronger assertions and unchanged production code.
The tool refused each mutation and left the file clean.
Each test reported 30 assertion calls but no failed result assertion. This does not identify the slow phase.
This observation confirms that a focused run can also exceed the limit on this VM.
It does not establish the cause of the original absent `changed` result.
The timeout and all assertions remain unchanged.

A repeat phase run on the main export passed in 114.37 seconds, 10.75 seconds above the first phase run.
Its scans took 45.14, 0.15, 45.94, and 0.14 seconds: 91.37 seconds total.
Git calls took 14.22 seconds total; compression took 2.75 seconds.
Fixture creation and file writes took 1.33 seconds. Complete restore took 2.12 seconds.
All scans exited 0, with no subprocess signal or timeout error.
These observations show runtime variance in the unchanged production path.
They do not identify why the original second backup returned no `changed` value.

### Proof after the first main merge

At `72ba8312`, all nine independent mutations returned factory exit 0 and test exit 1.
Each mutant failed at its intended assertion, not a timeout or an earlier shared assertion.
The result mutants used `ReturnType<typeof backup>`. A separate TypeScript check accepted each synthetic result shape.
The tool restored the test file after each run. The complete focused suite then passed 33 tests and 272 assertions.
That suite took 203.65 seconds. All five CI jobs passed on the same head.

The local full gate used the CI command with both required-test variables set to `1`.
Its 2400-second command limit expired with exit 124, 57 failed cases, and no final totals.
The large backup test passed. The gate used Python 3.12.15 and Go 1.26.10; CI uses Go 1.23.
This result is a local gate gap, not a pass or a cause for the original backup failure.
The station report holds the selected-case comparison and the next head's remaining proof work.

Main advanced during this gate. The next merge includes test-isolation fixes outside the backup files.
Proof on `72ba8312` does not replace the final self-check after that merge.
The timeout and production code remain unchanged.

### Proof on the unchanged final test

The next implement pass retained main `7595aef6`; fetched main had no new commit.
At `87678c57`, all nine independent mutations again returned factory exit 0 and test exit 1.
Each mutant failed at its intended assertion. No mutant failed from a timeout.
The result mutants retained `ReturnType<typeof backup>`.
The tool restored each edit. The complete focused suite then passed 33 tests and 272 assertions in 33.92 seconds.
These results show further runtime variance. They do not establish the original failure's cause.
The station report records the final-head gate and mutation results after this evidence commit.

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
