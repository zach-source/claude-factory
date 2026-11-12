# ADR: Bound VM costs before the Grok spend meter

## Context

Bead: `claude-factory-53r2x`. Plan base: `6b9f0b16`; remote main: `c1280969`.
The remote changes do not change the files for this fix.
No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in this checkout.

`src/metrics.ts:481` accepts VM usage through `validUsage`.
Its cost check accepts any model and an integer cost up to `1e12` microdollars.
Report replay uses this check at `src/cli.ts:1465`.
The AX close fallback uses it at `src/cli.ts:5025`.
`appendUsage` sends those costs to `logGrokSpend`, which feeds the seven-day Grok budget gate.
A forged Claude row can thus add $1,000,000 to that meter.

## Decision and input contract

Keep a VM cost only when its row passes the existing validator and its model and cost pass one closed rule.
The model must match the case-sensitive expression `^grok(?:-[A-Za-z0-9._:-]+)?$`.
The cost must be a number, an integer, greater than zero, and at most `100000000` microdollars ($100).
Every other cost loses the `costMicro` field. Keep the otherwise valid usage row and its token counts.
Do not clamp a refused cost to the cap. Do not coerce a string to a number.

The existing outer grammar stays intact:

- The input is an array of at most 20 rows. Other input produces no rows.
- Each row needs `model`, `session`, `input`, `cacheWrite`, `cacheRead`, `output`, `turns`, and `peak`.
- `model` matches `^[A-Za-z0-9._:-]{1,64}$`; `session` matches `^[A-Za-z0-9-]{1,64}$`.
- Each numeric field is an integer from zero through `1e12`, inclusive.
- `costMicro` is optional and follows the new rule above.
- Laptop state supplies `node` and `seq`. VM values cannot override them.
- Unknown fields do not enter the output. Preserve this behavior; do not reject a row for extra fields.

No field is a path or executable text. This change parses no shell, config, or render grammar.
An invalid row produces no usage row and no spend entry.
A refused cost produces zero spend entries for that row, but its valid token row still reaches the usage store.
The report and task close must still complete. They are not downstream calls to suppress.

Bare `grok` stays valid because `grokUsageOf` uses it when model metadata is absent.
Model aliases with provider prefixes, uppercase `Grok`, and empty suffix `grok-` receive no cost authority.
Those aliases can still retain valid token rows.
Out of scope: provider alias normalization, proof of provider charges, token limits, aggregate cost limits, and historical meter repair.

Edit only the cost predicate in `src/metrics.ts` and tests in `src/remote.test.ts`.
Reuse `usageRow`, `storedRows`, `clusterUsage`, and `timeoutTick` where suitable.
No dependency, new abstraction, flag, or production CLI change is necessary.
The release station appends the normal Unreleased bullet. Do not change `.factory/`.

Rejected alternatives:

- Recompute from PRICES: this replaces provider costs with estimates and needs model and cache price policy.
- Check only `logGrokSpend`: invalid VM costs would remain in stored usage.
- Reject the complete row: this loses valid token counts without a need.
- Clamp the cost: a forged value would still enter the meter at $100.

## Acceptance criteria

Use `53r2x` in all new test names. This command proves AC1 through AC3:

```text
bun test --timeout 30000 src/remote.test.ts -t 53r2x
```

AC1. `53r2x cost grammar` tests `validUsage` directly with otherwise valid rows.
Accept costs `1` and `100000000` for both `grok` and `grok-4.7`.
Retain no cost for `100000001`, `1e12`, `0`, `-1`, `1.5`, `NaN`, `Infinity`, strings, null, objects, or absence.
Test those refused costs with a valid Grok model, so the model check cannot mask a bad cost check.
At cost `1`, refuse `claude-opus-4-7`, `gpt-6-astra`, `Grok-4.7`, `xgrok-4.7`, `grokish`, `grok-`, and `xai:grok-4.7`.
Keep each otherwise valid row, its token counts, and the laptop node and seq.
Retain the current empty result for invalid required fields, a non-array, and an array of 21 rows.
Unknown fields must not appear in output. Test both model and session length limits.

AC2. `53r2x replay cost boundary` uses real report replay through the fake AX harness.
Test three refused cases separately: Claude with `1e12`, Claude with `1`, and `grok-4.7` with `100000001`.
Each case stores its valid token row without `costMicro`, completes the report, and leaves `grokSpent(home)` at zero.
Assert zero added meter lines, not only a zero total. Use an empty test meter for each case.
An allowed control with `grok-4.7` and `100000000` stores that cost and yields exactly $100.
Replay that report again; stored usage and the meter must not increase.
Check `grokVerdict` with budget `1`: refused costs leave dispatch allowed; the accepted $100 cost denies it.

AC3. `53r2x close cost boundary` repeats AC2's three refused cases and its allowed control through `timeoutTick`.
Use no pre-stored usage, so `storeAxUsage` must consume the fake VM response.
Assert the cost fields, token fields, meter totals, zero refused-cost meter lines, and successful close.
Assert that the worker usage call precedes task deletion. Retain the existing no-second-read test for pre-stored usage.
Reset only the isolated fixture meter between cases; never use the real factory home.

AC4. Prove the model and cap checks independently after the fix commit.
Use `factory mutate <file:line> <old> <new> -- <test command>` with the focused AC1-through-AC3 command.
First remove only the model predicate; Claude cost `1` must fail the tests.
Then raise only the cap to `1e12`; Grok cost `100000001` must fail the tests.
Each mutant must compile. The mutation command must exit zero, which means the tests killed the mutant.
Record the exact commands and results. Restore the source and confirm a clean worktree after each mutation.

AC5. The final implementation head passes these repository checks:

```text
bun test --timeout 30000 src factories
bunx tsc --noEmit -p .
claude plugin test mod
bunx prettier@3.9.9 --check .
bun audit
gitleaks detect --log-opts=origin/main..HEAD
```

Run the implement station gate. Required CI checks are test, plugin, typecheck, and format on the final head.
Run `bun run typecheck` when the generated plugin types exist; otherwise record that local gap and the CI check.
Negative controls include existing invalid-row, report deduplication, AX fallback, and Grok meter tests.
Tests and fix must reach one draft pull request. The final required checks must all pass.

## Test plan and tasks

1. `claude-factory-53r2x.1`: Commit the regression tests first. Implement AC1, AC2, and AC3 in `src/remote.test.ts`.
   Run the focused command on pre-fix code and record the expected cost-field and meter failures.
   Format the test file. This intermediate commit can be red; it must not ship alone.
2. `claude-factory-53r2x.2`: Commit the minimal validator fix in `src/metrics.ts` after task 1.
   Run AC1 through AC5. Format the touched files. Record both independent mutation results.

Both tasks fit one 120-minute implement pass. No other bead must land first.
The plan station commits only this ADR. The implementation station owns the tests, fix, and draft pull request.

## Risk

This security-sensitive change validates untrusted VM input before a local spend gate.
It changes no auth, credentials, schema, or token accounting.
Valid Grok sessions above $100 lose their cost field. Unknown provider aliases also lose that field.
The cap applies per row, not per session across rows or reports.
A worker can still forge a Grok model and submit capped costs; 20 maximum rows can add $2,000 per accepted array.
This fix bounds the reported exploit. It does not make VM costs authoritative or eliminate every budget denial.
Historical poisoned meter lines remain until their seven-day expiry. This run must not delete them.
Security-sensitive: yes (untrusted usage input validation)

## Rollout and rollback

No flag or migration is necessary. Keep `FACTORY_GROK_WEEKLY_BUDGET_USD` unchanged.
Deploy through the normal release path after a person merges the pull request.
The laptop validator protects both paths without a VM image change.
Rollback uses a revert pull request and a person merge, then the normal release path.
A rollback restores the weak cost check. It does not restore discarded costs or repair existing meter rows.

## Observability

No AC is must-see-live. The fake AX tests provide deterministic exploit evidence before merge.
The ship soak checks the deployed revision and the existing Grok status summary through authorized reads.
When a normal AX report occurs, compare its usage row and the corresponding meter delta in the isolated authorized view.
No new production metric, log payload, forged live report, or credential access is necessary.
Do not claim a live exploit test from static status alone. Record any unavailable live observation as a soak gap.

## Plan evidence

After `bun install --frozen-lockfile`, the focused baseline passed: 15 tests, 42 assertions, zero failures.
Command: `bun test --timeout 30000 src/remote.test.ts -t 'AX usage|replayed AX report|timed out stores|worker usage output'`.
The first attempt lacked `xstate`; dependency install resolved it.
The VM lacks `bunx`. The equivalent direct Prettier command passed:
`bun node_modules/prettier/bin/prettier.cjs --check docs/architecture/adr-vm-grok-cost-bound.md`.
Full tests, typecheck, plugin checks, and live checks are implementation or ship work; this plan does not claim those results.
Memory search reported that its snapshot had not arrived. One broad search command hit the worker hook; no denial bypass occurred.
