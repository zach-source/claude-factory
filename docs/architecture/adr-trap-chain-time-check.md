# ADR: Keep trap scan checks stable under host load

## Context

Bead: `claude-factory-xfbp6`. Status: proposed. This is a CI reliability repair, not a new bypass.

The reported CI sample took 131 ms against a 100 ms limit on `b0d16431`.
The [failed job](https://github.com/zach-source/claude-factory/actions/runs/42815991372/job/129829247784) completed its test step.
This is not a runner loss.
The [main run](https://github.com/zach-source/claude-factory/actions/runs/42815613940) passed on `81d9602d`.
These results come from the bead and triage. Plan did not download the job log.

Plan examined `7595aef63dfb1de707f41a776da0c06d60caba53` with Bun 1.4.4.
The three selected tests passed in 60.93, 30.52, and 37.03 ms.
The full file passed those tests in 32.31, 28.63, and 41.48 ms.
The full file had 6,626 passes and one failure at `src/worker-hook.test.ts:6042`.
That failure concerns the host Git builtin list. Do not repair it in this run.
Plan did not run the full project suite, build, plugin check, audit, or CI.

`src/worker-hook.test.ts:10879` measures the direct chain against 300 ms.
Line 10885 defines two bd-scan cases with a 100 ms limit.
Each case takes one `Date.now()` sample and discards the scan result.
Wall time includes CPU suspension, runtime warmup, and garbage collection.
The historical sample does not identify which cause applied. Do not claim that it does.

The existing `HookGate.now` callback permits a deterministic count without a new production interface.
It runs at the scan entry and at work-budget checks.
A plan probe returned no denial for all three shapes at 250, 500, and 1,000 repeated words.
The callback counts were exactly `15n+13`, `19n+31`, and `28n+47`, respectively.
The shapes were direct trap, trap inside `env -i sh -c`, and eval trap inside that wrapper.
Process CPU samples exceeded wall time in some rows. Do not substitute process CPU time without runtime evidence.

## Decision

First prove the source of variation with controlled measurements. Then change the test, based on that evidence.
The expected repair uses two checks: a deterministic scan-count bound and a separate wall-time ceiling.
Keep the existing guard and its two `trapEnd` checks.
Do not change production code unless the measurements prove a production defect within this scope.
If they prove a different defect, update this ADR before the repair.

Use `src/worker-hook.test.ts` for the regression tests.
Use the existing `src/worker-hook.bench.ts` only if a repeatable diagnostic command needs a permanent home.
Record measurement tables and conclusions in this ADR. Keep disposable probes in `.scratch/`.
Do not add a dependency, configuration flag, parser, generic benchmark framework, or production telemetry.

For each shape, count calls through `now: () => { calls++; return 0 }`.
Require `calls <= 30 * n + 64` at `n = 250, 500, 1000`.
Require an undefined result. A fast budget denial must not pass as a successful scan.
This clock is for the count test only. The wall-time test must use the real clock and production deadline.
Retain the direct chain at 1,150 words and both bd chains at 1,000 words.

The proposed wall ceiling is 300 ms for all three original cases.
This is the current direct-chain ceiling and remains far below the 7,000 ms scan deadline.
The count assertion must replace the lost sensitivity of the 100 ms assertion before any ceiling change.
Do not change 100 ms until AC1 proves the variation mechanism and AC3 proves both regression checks.
If the evidence does not support 300 ms, retain 100 ms and revise the design with the manager.
Do not use retries, minimum-of-N samples, or a larger global test timeout to obtain a pass.

Rejected alternatives:

- A threshold increase alone removes regression sensitivity without proof.
- A ratio alone can hide fixed delays and noise at small input sizes.
- A fake clock alone does not detect slow work between callback calls.
- Process CPU time includes runtime threads and does not measure only the scan.
- A production parser rewrite has no demonstrated need.
- A new bypass issue duplicates neither the goal nor its evidence.

## Rule and scope

Preserve this fail-closed rule: a trap action must not hide a prohibited command or bypass the shared scan limits.
A denial in any action interpretation must deny the whole command.
The existing tokenizer, redirect rules, nested-script rules, and later directory/config state remain authoritative.
This change adds no input grammar and accepts no new shell forms or path forms.
New shell syntax, shell execution, credential access, and sandbox changes are out of scope.
Tests pass command strings to `denyReason`; they must never execute those strings.
No new renderer, subprocess, or downstream execution call is necessary.

## Acceptance criteria

### AC1: Explain the variation with evidence

Use Bun 1.4.4 and record the source SHA, host, CPU count, load, and exact commands.
Measure all three original cases in 20 fresh isolated processes and in three full-file runs.
Run `bun test --timeout 30000 src factories` once with the CI prerequisites.
Compare cold and warm calls, with and without controlled CPU contention.
Record wall time, process CPU time, scan counts, and available GC evidence separately.
Do not attribute GC from elapsed time alone.
Keep every sample, including failures; samples diagnose the defect and do not replace pass/fail assertions.
Show a controlled comparison that explains a crossing of the old 100 ms ceiling without extra scan work.
If scan work grows instead, investigate that path before the test repair.
Distinguish the reproduced mechanism from the unknown cause of the historical CI event.
Proof: the measurement table in this ADR and the exact-head CI test result.
Negative controls: the same command and source without contention; cold versus warm calls with equal input sizes.

### AC2: Preserve semantics

Run `bun test --timeout 30000 src/worker-hook.test.ts -t '81tz|xfbp6'`.
All existing `81tz` rows must retain their verdicts.
Denied controls include protected pushes, recursive deletion, redirects before an unsafe action, and a bd action under `env -i`.
Also retain the gh alias denials after later config changes and the source process-substitution denials.
Allowed controls include `trap - EXIT`, `trap -p`, an empty action, `echo hi`, `git status`, and unprotected pushes.
Retain the existing builtin gh verb and harmless `env -i` trap controls.
All three long harmless chains must return undefined in both count and wall-time tests.
The test strings must cause zero command executions.

### AC3: Preserve useful performance checks

The command from AC2 must check `calls <= 30*n+64` for every shape and size above.
The three original wall-time cases must remain below the evidence-approved ceiling, at most 300 ms.
Keep the 30,000 ms test timeout and the production limits unchanged.
Commit the tests before mutation proof.
Use `factory mutate <file:line> <old> <new> -- <test command>` for each mutation separately.
Remove `k >= trapEnd` in `segmentRunsBdCommand` for one mutation.
Disable `if (j < trapEnd) continue` in `anyShellReason` for the other mutation.
Each mutant must compile, reach its own affected path, and fail the deterministic bound or expected successful result.
A timeout, syntax failure, or unrelated test failure does not prove sensitivity.
Restore each mutation and require a clean source diff.
The unchanged scan is the positive control; the two independent repeated-scan mutants are the negative controls.
If a count misses either mutant, revise the fixture before any wall ceiling change.

### AC4: Pass the repository checks

Run the full worker-hook test file and `bun test --timeout 30000 src factories`.
Run `bunx tsc --noEmit -p .`, `claude plugin test mod`, and `bunx prettier@3.9.9 --check .`.
Run the factory gate, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Record local gaps separately. Do not weaken a test to resolve a host gap.
Require test, plugin, typecheck, and format CI checks on the final PR head.
Negative control: a red required check must prevent approval; a green older SHA does not satisfy this criterion.

## Test plan and tasks

Task `claude-factory-xfbp6.1` commits diagnostic evidence and new deterministic tests before the test-policy repair.
The existing production code can pass the new tests; the two regression mutants must fail them.
First reproduce the old wall-time failure under the controlled comparison from AC1.
This supplies the red result for the reliability defect without an intentionally red final PR.

Task `claude-factory-xfbp6.2` depends on `.1`. It commits the smallest evidence-supported repair to the existing time assertions.
Add explicit result assertions and retain the real-clock ceiling.
Run AC2 through AC4 and record the final evidence.
Both tasks fit one 120-minute implement pass and one draft PR.
If AC1 remains unresolved, report the evidence gap; do not close the tasks as complete.

## Risk

This work concerns security-sensitive shell input analysis, even if the final patch changes only tests.
A relaxed time check can conceal repeated scans. Independent mutation proof is mandatory.
A count test can couple to scan structure. The linear envelope gives small changes room without exact-count pins.
The wall-time check retains coverage for expensive operations that do not increase the callback count.
There is no data migration, API change, auth change, or new dependency.
Preserve all production budgets, denial reasons, and allowed controls.
Security-sensitive: yes (shell input analysis and guard performance)

## Rollout and rollback

Use one draft PR from this run branch. The owner merges it after the required approval stations.
No flags, migration, live system command, or credential step applies.
The change takes effect when CI runs the merged tests.
Rollback uses a new PR that reverts the repair commit and its test changes when necessary.
Keep the original guard intact. A person merges the rollback PR.

## Observability

Use CI test results, sample tables, and independent mutation results as evidence.
There is no new production output or live read requirement. No AC is must-see-live.
The ship soak checks the merged SHA and its required CI results.
Do not claim that one green run proves that all future host loads meet the wall ceiling.
