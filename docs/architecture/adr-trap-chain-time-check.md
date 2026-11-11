# ADR: Keep trap scan checks stable under host load

## Context

Bead: `claude-factory-xfbp6`. Status: implemented. This is a CI reliability repair, not a new bypass.

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
At baseline, each case took one `Date.now()` sample and discarded the scan result.
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

The selected wall ceiling is 300 ms for all three original cases.
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

## Implement evidence: Bun 1.4.4

The probe source was `5fe8a0dbcb18cc9e76bf4afcbf49edaa94bcfba8`.
The production file matched `origin/main`; its Git blob was `d667374c`.
The host reported `actor`, Linux 4.19.0-gvisor, six CPUs, and six CPUs in its affinity mask.
The load averages were zero before and after the probe. This VM load value did not measure the induced contention.
Bun reported `1.4.4 (38afee6c8)`. Node reported `v22.23.4`.

Commands:

```sh
python3 .scratch/trap-measure.py
python3 .scratch/trap-control.py
bun test --timeout 30000 src/worker-hook.test.ts -t '81tz|xfbp6'
```

The disposable probes called `denyReason`; they never executed a shell input under test.
Each fresh process measured direct, wrapped, and eval shapes in that order.
The direct shape used 1,150 words. The wrapped and eval shapes used 1,000 words.
For each shape, the probe measured the first call, then counted a separate call with a fixed clock.
It then measured the warm call and counted another separate call.
The real-clock samples used the production clock and deadline.
`performance.now()` measured elapsed milliseconds. `process.cpuUsage()` measured process CPU milliseconds, including runtime threads.
CPU samples had coarse steps and sometimes exceeded wall time. They cannot replace the wall check.

The first comparison used 20 fresh processes per group and CPU affinity `taskset -c 0`.
The no-burner group had no induced CPU load. The second group had three Python busy processes on that CPU.
A full-file test ran concurrently. Thus, the no-burner group was not a machine-idle control.
All 240 measured scans and all 240 separate count scans returned undefined.
All counts were 17,263 direct, 19,031 wrapped, and 28,047 eval.
These equal `15n+13`, `19n+31`, and `28n+47`.

Each cell below holds `first wall / CPU; warm wall / CPU`, in milliseconds.
Every sample appears, including those above 100 ms or 300 ms. Values have two decimal places.

| Group | Process | Direct | Wrapped | Eval |
| --- | ---: | --- | --- | --- |
| No burners | 1 | 328.08 / 730.00; 153.41 / 260.00 | 187.67 / 310.00; 174.76 / 320.00 | 227.58 / 380.00; 232.94 / 420.00 |
| No burners | 2 | 295.80 / 550.00; 141.59 / 230.00 | 167.27 / 280.00; 157.91 / 310.00 | 199.84 / 290.00; 215.40 / 300.00 |
| No burners | 3 | 287.01 / 520.00; 145.87 / 270.00 | 161.83 / 320.00; 155.01 / 280.00 | 206.45 / 350.00; 205.09 / 300.00 |
| No burners | 4 | 297.89 / 630.00; 125.86 / 210.00 | 166.64 / 290.00; 136.84 / 270.00 | 186.31 / 300.00; 224.74 / 280.00 |
| No burners | 5 | 295.93 / 560.00; 148.43 / 260.00 | 161.18 / 300.00; 148.05 / 280.00 | 222.52 / 350.00; 197.07 / 240.00 |
| No burners | 6 | 329.76 / 650.00; 150.96 / 240.00 | 183.46 / 320.00; 165.47 / 260.00 | 227.49 / 390.00; 250.92 / 360.00 |
| No burners | 7 | 352.79 / 730.00; 174.54 / 280.00 | 182.59 / 320.00; 194.26 / 390.00 | 284.06 / 500.00; 281.02 / 470.00 |
| No burners | 8 | 327.69 / 590.00; 160.05 / 260.00 | 175.56 / 300.00; 174.70 / 340.00 | 223.26 / 390.00; 227.96 / 380.00 |
| No burners | 9 | 297.89 / 620.00; 150.18 / 250.00 | 170.13 / 290.00; 155.09 / 290.00 | 206.76 / 330.00; 206.28 / 360.00 |
| No burners | 10 | 305.38 / 540.00; 146.31 / 230.00 | 190.33 / 280.00; 175.23 / 350.00 | 208.43 / 340.00; 248.99 / 380.00 |
| No burners | 11 | 326.55 / 620.00; 144.64 / 270.00 | 178.07 / 300.00; 168.06 / 310.00 | 192.96 / 310.00; 224.50 / 310.00 |
| No burners | 12 | 285.52 / 590.00; 118.34 / 200.00 | 162.42 / 300.00; 146.89 / 280.00 | 206.63 / 320.00; 198.51 / 290.00 |
| No burners | 13 | 310.95 / 580.00; 134.43 / 210.00 | 164.74 / 300.00; 151.32 / 270.00 | 206.65 / 320.00; 207.71 / 260.00 |
| No burners | 14 | 327.63 / 700.00; 150.34 / 250.00 | 176.70 / 270.00; 165.32 / 320.00 | 214.17 / 360.00; 223.48 / 350.00 |
| No burners | 15 | 325.81 / 630.00; 150.87 / 240.00 | 181.86 / 290.00; 159.39 / 280.00 | 209.89 / 320.00; 217.79 / 300.00 |
| No burners | 16 | 341.37 / 680.00; 146.02 / 230.00 | 180.60 / 320.00; 168.19 / 320.00 | 218.39 / 350.00; 228.04 / 320.00 |
| No burners | 17 | 310.90 / 650.00; 149.86 / 250.00 | 176.41 / 240.00; 165.91 / 350.00 | 247.18 / 400.00; 205.63 / 340.00 |
| No burners | 18 | 343.81 / 610.00; 170.57 / 320.00 | 181.08 / 320.00; 164.13 / 320.00 | 228.75 / 410.00; 227.31 / 360.00 |
| No burners | 19 | 341.55 / 660.00; 159.69 / 240.00 | 180.05 / 320.00; 157.36 / 320.00 | 202.70 / 320.00; 214.64 / 310.00 |
| No burners | 20 | 354.15 / 680.00; 190.53 / 340.00 | 180.68 / 290.00; 167.23 / 340.00 | 207.38 / 330.00; 241.82 / 390.00 |
| Three burners | 1 | 321.02 / 640.00; 151.30 / 240.00 | 171.71 / 290.00; 140.91 / 260.00 | 213.81 / 340.00; 201.05 / 280.00 |
| Three burners | 2 | 298.06 / 580.00; 137.04 / 220.00 | 149.85 / 260.00; 153.67 / 300.00 | 170.51 / 280.00; 200.87 / 260.00 |
| Three burners | 3 | 279.68 / 540.00; 133.87 / 190.00 | 179.19 / 280.00; 182.17 / 330.00 | 227.47 / 360.00; 217.58 / 300.00 |
| Three burners | 4 | 287.86 / 570.00; 133.89 / 230.00 | 176.66 / 290.00; 177.75 / 330.00 | 233.53 / 400.00; 217.28 / 270.00 |
| Three burners | 5 | 291.33 / 550.00; 137.12 / 210.00 | 157.52 / 260.00; 148.25 / 280.00 | 204.31 / 360.00; 240.44 / 380.00 |
| Three burners | 6 | 322.15 / 550.00; 152.05 / 250.00 | 177.76 / 270.00; 154.98 / 270.00 | 232.05 / 350.00; 267.61 / 410.00 |
| Three burners | 7 | 420.57 / 550.00; 174.63 / 240.00 | 197.85 / 320.00; 207.64 / 360.00 | 260.00 / 330.00; 244.79 / 290.00 |
| Three burners | 8 | 441.36 / 680.00; 222.99 / 230.00 | 247.61 / 270.00; 194.72 / 320.00 | 225.62 / 350.00; 293.66 / 470.00 |
| Three burners | 9 | 333.38 / 560.00; 170.59 / 270.00 | 198.99 / 290.00; 168.13 / 300.00 | 232.90 / 380.00; 227.80 / 330.00 |
| Three burners | 10 | 319.51 / 550.00; 148.86 / 260.00 | 185.00 / 350.00; 162.38 / 300.00 | 207.03 / 300.00; 217.21 / 300.00 |
| Three burners | 11 | 310.97 / 550.00; 145.42 / 260.00 | 187.07 / 300.00; 189.38 / 300.00 | 232.68 / 330.00; 217.72 / 280.00 |
| Three burners | 12 | 346.83 / 610.00; 150.74 / 260.00 | 177.08 / 300.00; 178.14 / 330.00 | 196.26 / 280.00; 209.77 / 250.00 |
| Three burners | 13 | 292.45 / 480.00; 145.31 / 240.00 | 161.59 / 330.00; 154.97 / 290.00 | 223.40 / 340.00; 218.74 / 260.00 |
| Three burners | 14 | 446.96 / 550.00; 158.69 / 240.00 | 203.88 / 330.00; 185.24 / 340.00 | 210.76 / 320.00; 231.64 / 360.00 |
| Three burners | 15 | 309.43 / 600.00; 162.81 / 270.00 | 176.42 / 340.00; 159.15 / 320.00 | 227.92 / 400.00; 234.33 / 250.00 |
| Three burners | 16 | 394.70 / 610.00; 197.08 / 210.00 | 188.28 / 250.00; 198.93 / 350.00 | 275.01 / 460.00; 273.13 / 460.00 |
| Three burners | 17 | 423.22 / 690.00; 153.58 / 250.00 | 206.51 / 300.00; 244.49 / 450.00 | 250.59 / 430.00; 236.51 / 410.00 |
| Three burners | 18 | 359.70 / 600.00; 155.60 / 260.00 | 228.66 / 280.00; 213.55 / 320.00 | 224.71 / 400.00; 215.97 / 250.00 |
| Three burners | 19 | 371.01 / 610.00; 183.36 / 210.00 | 258.33 / 230.00; 194.37 / 370.00 | 218.73 / 360.00; 225.41 / 310.00 |
| Three burners | 20 | 332.05 / 570.00; 173.91 / 300.00 | 195.54 / 320.00; 292.63 / 340.00 | 276.87 / 450.00; 217.98 / 420.00 |

`bun:jsc` heap sizes before and after real-clock calls ranged from 631,028 to 5,493,505 bytes.
The probe did not force GC. It had no collection event trace or collection duration.
These heap values do not identify a GC cause.

The affinity comparison had overlapping ranges. It did not isolate the effect of contention.
A second comparison alternated five fresh no-burner processes with five processes under 12 Python busy processes.
This comparison used the wrapped shape without CPU affinity and five warmup calls before each sample.
Each busy process ran `python3 -c 'while True: pass'` and stopped after its sample.
The baseline test still ran concurrently. Each pair used the same source and input.
All ten real-clock scans and ten separate count scans returned undefined with 19,031 calls.

| Pair | No burners: wall / CPU (ms) | 12 burners: wall / CPU (ms) |
| ---: | --- | --- |
| 1 | 201.32 / 270.00 | 640.62 / 250.00 |
| 2 | 201.12 / 280.00 | 806.96 / 380.00 |
| 3 | 204.36 / 340.00 | 636.35 / 240.00 |
| 4 | 189.95 / 340.00 | 673.47 / 220.00 |
| 5 | 198.16 / 290.00 | 646.09 / 300.00 |

The CPU load increased elapsed time from 190–204 ms to 636–807 ms without more scan checks.
Process CPU time did not increase in proportion to wall time.
This controlled comparison proves that CPU contention can change the wall result without more scan work.
The first direct calls also took 286–354 ms without induced load; warm direct calls took 118–191 ms.
This shows a process-state effect at equal input size and scan count. It does not isolate JIT work from GC.
The historical CI event still has no proven cause. This VM result does not identify the historical runner load.

The unchanged 100 ms assertions failed in a selected run at 183 ms and 255 ms.
That run had 45 passes and two failures. The direct check passed at 248.28 ms.
All nine new count cases passed on the production guard before mutation.
The probe also verified undefined results for all original shapes.
Thus, the old ceiling can fail without increased scan work or a changed verdict.

The evidence supports 300 ms for the two wrapped checks under ordinary host load, with an independent work bound.
Both wrapped shapes stayed below 300 ms in the 40-process comparison.
The existing direct ceiling remains 300 ms. The count cases precede the wall cases and exercise the same scan paths.
The 12-burner control exceeds 300 ms; no claim covers arbitrary host contention.
The wall check still catches expensive work between clock calls. The count check catches repeated scans without host-clock noise.
No scan deadline, work budget, test timeout, or production guard changes.

### Independent regression controls

The tests were committed as `15750b86` before each mutation.

```sh
factory mutate src/worker-hook.ts:3129 'bw === '\''trap'\'' && k >= trapEnd' 'bw === '\''trap'\''' -- bun test --timeout 30000 src/worker-hook.test.ts -t 'xfbp6'
factory mutate --timeout 180 src/worker-hook.ts:8805 'if (j < trapEnd) continue' 'if (false) continue' -- bun test --timeout 30000 src/worker-hook.test.ts -t 'bounds trap scan work at 250'
git diff -- src/worker-hook.ts
```

| Guard removed | Result | Evidence |
| --- | --- | --- |
| `k >= trapEnd` | KILLED, exit 0 | Six tests failed; the work budget denied harmless chains. No test timeout occurred. |
| `j < trapEnd` | KILLED, exit 0 | Three 250-word tests failed the count bound; the last used 319,547 calls against 7,564. |

The first shell-scan mutation command used all nine cases and exceeded the external 120-second command timeout.
That attempt supplies no mutation proof. The source was restored before the narrower command above.
Both completed mutants compiled, reached the affected scan, and failed the intended assertions.
The final source diff was empty.
An overlapping third full-file sample loaded the shell-scan mutant. It is invalid as a baseline, but remains in the local log.
The later clean-source full-file run replaces it in the baseline evidence.

### Full-file comparisons before the ceiling repair

The command was `bun test --timeout 30000 src/worker-hook.test.ts`.
Run 1 used the original tests. Runs 2 and 3 included the nine count tests from `15750b86`.
All three used the same unchanged production source. The failed mutant overlap is separate from these three runs.

| Run | Pass | Fail | Total seconds | Direct ms | Wrapped ms | Eval ms |
| ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 6,621 | 6 | 101.06 | 206.09 | 202.82 | 290.41 |
| 2 | 6,632 | 4 | 96.79 | 156.22 | 176.73 | 244.90 |
| 3 | 6,632 | 4 | 97.92 | Passed, below 300 | 175.72 | 273.31 |

Each run failed the old two 100 ms checks and the host Git builtin list test.
Run 1 also failed three unrelated time checks. Runs 2 and 3 each failed the dynamic-shell-word time check.
The nine count tests passed in runs 2 and 3. No production change explains the elapsed-time differences.

### Historical CI log

Implement downloaded the job log with this command:

```sh
gh api repos/zach-source/claude-factory/actions/jobs/129829247784/logs --allow-escape-sequences > .scratch/historical-failure.log
```

The log confirms 70.49 ms direct, 72.10 ms wrapped, and 132.53 ms eval-trap test durations.
The eval-trap assertion measured 131 ms. The job had 17,937 passes, three skips, and two failures in 699.57 seconds.
The other failure concerned the backup test `d289.20`.
The log has no CPU or GC trace for the failed scan. It does not prove the historical variation mechanism.

### Full project baseline with CI prerequisites

The [evidence CI run](https://github.com/zach-source/claude-factory/actions/runs/42832949200) tested `26e59cd4bd04e26b93c3db06d4d72e499607fda2`.
Its test job ran `PKGGATE_E2E_REQUIRE=1 PG_SCRATCH_REQUIRE=1 bun test --timeout 30000 src factories` with the pinned CI tools.
It completed 17,951 tests across 234 files in 678.25 seconds: 17,948 passed, three skipped, and zero failed.
All nine count cases passed. The original wall checks also passed at 56.04, 54.34, and 79.24 ms.
The wrapped ceilings were still 100 ms. This is the complete project baseline before the ceiling repair.
The plugin, typecheck, format, and nix checks also passed on that SHA.
These checks do not replace the required CI checks on the final repair SHA.

A local project diagnostic also started before the repair. It used Go 1.26.10 instead of CI's Go 1.23.
The current Nix package set no longer supplies Go 1.23. The CI run above supplies the pinned-tool baseline.

## Repair

The two wrapped real-clock checks now use 300 ms. The direct check retains 300 ms.
All three checks assert an undefined scan result and measure elapsed time before the result assertion.
All original chain inputs, the 30,000 ms test timeout, and all production code remain unchanged.
The nine independent count checks retain the linear envelope at each selected input size.
Final local and CI results belong in the implement report and the pull request.
