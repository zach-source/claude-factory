# ADR: Put gc behind the core operation interface

## Context and scope

Bead: `claude-factory-n69b2`. Base: `6a3a5d96`.
Constitution Principle II requires core ownership and front-end parity, or explicit gap records.
`src/cli.ts:15198` owns gc dispatch. `src/cli.ts:7164` and `:7781` contain the two passes.
`src/gc.ts` contains their plans. The core catalog has no gc operation.

This run delivers the core operation, local CLI, server CLI, and three explicit UI gap records.
The three UI clients have no generic operation view at this base.
Their generic views remain open work under `claude-factory-hpmc.9`, `.10`, and `.11`.
Build those clients separately. A new browser mutation channel exceeds this run's 120-minute implementation budget.

The dependent work is:

| Front end | Gc bead | Generic client prerequisite |
| --- | --- | --- |
| Web | `claude-factory-5aweq` | `claude-factory-hpmc.11` |
| Claude mod | `claude-factory-j3zj6` | `claude-factory-hpmc.9` |
| Herdr app | `claude-factory-zsuj2` | `claude-factory-hpmc.10` |

Each gc bead also depends on this run's bead. The current PR must name all three gaps.
This pass does not claim full UI parity. It supplies the common contract that those clients must use.

## Decision and design

Add `gc.run` to `src/core/catalog.ts`: `POST /v1/gc`, text output, owner rights, and `mutates: true`.
Dry-run uses the same POST route and caller checks. It is not a read-rights bypass.
Use the current synchronous result contract, `{code, out, err}`, and the server's current timeout behavior.
Successful `/v1/gc` replies carry that result as JSON, including stderr diagnostics when `code` is zero.
The catalog's text output describes `out`. Clients must emit both `out` and `err` from the result.
Nonzero results retain the existing HTTP error envelope.
Do not invent command polling in this pass. The UI follow-ups must use their established long-operation support.

Add `src/core/ops/gc.ts` for caller checks, option validation, mode selection, defaults, locks, and stamp policy.
Call `refuseWorker(ctx.env, 'gc', true)` before any gc effect.
Follow the existing `Port` pattern for the host's guarded gc effects and lock access.
Keep the existing pass bodies and removal helpers in `src/cli.ts` as host adapters in this bounded pass.
Keep the plan rules in `src/gc.ts`. Do not copy any removal rule into a client.
The port must not contain another command dispatcher, caller policy, or option parser.
The core operation must not spawn `factory gc` or import `cli.ts` by value.

Move the switch body to the core operation. Leave only argument conversion and result emission in the CLI.
Extend `src/client.ts` to send the same input to `/v1/gc` in server mode.
Use one small gc argument converter for local and server CLI paths.
Keep the converter free of filesystem reads and shell evaluation.
Thread output callbacks through the two pass bodies so each caller receives the same text and errors.
Do not replace global console functions or call `process.exit` from a server operation.
Preserve per-candidate diagnostics, existing exit codes, log formats, and failure isolation.

The hourly and daily child launch paths remain unchanged.
Both continue to invoke the existing CLI, which now reaches the core operation.
No `.factory/` change, scheduler, dependency, or storage migration is necessary.

### Closed input contract

Accept only these optional object fields. Reject all other fields and types before any gc port call.

| Field | Accepted form | Meaning |
| --- | --- | --- |
| `worktrees` | `true`, or absent | Worktree pass, or plain retention pass |
| `dryRun` | `true`, or absent | Preview, or execute |
| `days` | String matching `^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`; finite numeric value above zero | Plain pass retention |
| `rig` | Catalog `id` string: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` | One configured rig for the worktree pass |

Allow `days` only for the plain pass. Allow `rig` only with `worktrees: true`.
The plain default is explicit `days`, then `ctx.env.FACTORY_GC_DAYS`, then `7`.
Apply the same numeric rule to the environment default. An explicit valid value overrides an invalid environment default.
The worktree mode does not read `FACTORY_GC_DAYS`.
An unknown rig must fail before candidate removal or branch operations. Configured rig lookup can read the rig list.
Input cannot supply a home, path, repo, executable, environment map, caller role, or shell command.
Paths come only from the existing trusted home and rig data through the current guards.

CLI grammar: `gc [--days N] [--dry-run]` or `gc --worktrees [--rig ID] [--dry-run]`.
Flags can occur in any order, at most once. Reject missing values, unknown flags, positional words, and mixed-mode fields.
Reject `--flag=value`, `--`, and duplicate flags. No shell-source grammar, aliases, or shell expansion belongs in this converter.
The HTTP route accepts no query or path parameter. Keep the existing JSON size, idempotency, and transport checks.
Malformed input must cause zero lock, stamp, pass, chmod, removal, or subprocess calls.
Client rejection must cause zero HTTP calls. No transport failure can fall back to local gc.

This deliberately rejects undocumented CLI forms that the old scanner ignored.
It also rejects Infinity, numeric prefixes such as `0x7`, and whitespace around days.
Supported positive decimal, fraction, and exponent values remain valid.

### Files and rejected alternatives

Runtime files: `src/core/catalog.ts`, new `src/core/ops/gc.ts`, `src/cli.ts`, and `src/client.ts`.
Change `src/server-api.ts` only if result plumbing needs it; use its existing catalog dispatch and transport guards.
Add the three `gc.run` rows to `parity-gaps.json`. Keep unrelated gaps.
Update the existing gc help. The release step owns the changelog and version.
Tests use the existing core, client, server, gc, and parity suites named below.

- A catalog bridge back to the CLI leaves policy in a front end and risks recursion.
- Separate plain and worktree APIs duplicate caller checks and expose different option contracts.
- A wholesale move of the CLI helper graph creates unnecessary risk within this time limit.
- A new UI-specific delete route bypasses the core transport and duplicates security work.
- A new scheduler or automatic UI request changes retention frequency and lies outside this goal.

## Acceptance criteria

Prefix new test names with `n69b2 ACn`. All criteria below are pre-merge fixture checks.

1. **AC1: One core operation.** Extend `src/core/catalog.test.ts`, `catalog-handler.test.ts`, and `import.test.ts`.
   Assert the exact `gc.run` metadata and four inputs above.
   Direct operation calls and `/v1/gc` calls must use the gc port once, with no CLI runner call.
   Test both modes, successful results, thrown errors, and output isolation across two calls.
   Negative rows: no GET mutation, no read-rights preview, no import-time output, writes, tick, or CLI spawn.

2. **AC2: Closed inputs and caller rights.** Extend `src/core/ops.test.ts`, `src/client.test.ts`, and `catalog-handler.test.ts`.
   Test every accepted field and mode, defaults, explicit override, fractions, exponent values, and all flag orders.
   Reject unknown keys, arrays, nulls, wrong types, false flags, invalid rig IDs, and every invalid CLI class above.
   Reject zero, negatives, NaN, Infinity, overflow, whitespace, prefixes, and missing days values.
   Test each worker marker and `FACTORY_PATROL` independently, including dry-run.
   Denial must precede every gc port effect; client denial must precede the HTTP request.
   Allow an unmarked local person or manager and the existing authenticated server person.
   Deny worker bearer headers, bad content types, missing idempotency keys, and query parameters through existing transport rules.
   Keep TLS and loopback transport tests green. Do not claim that catalog rights alone enforce authorization.

3. **AC3: Local and server CLI parity.** Extend `src/core/ops-cli.test.ts`, `src/client.test.ts`, and `src/server-api-cli.test.ts`.
   Compare local CLI, direct core, and server CLI on equivalent isolated homes.
   Cover plain default, explicit days, plain dry-run, worktrees, worktrees dry-run, and rig selection.
   Pin normalized output, exit status, eligible IDs, and resulting files or refs for successful rows.
   Negative rows: wrong-rig candidates stay; unknown rig fails; unavailable server causes no local pass.
   An explicit server-mode request must touch only the server fixture home.
   Preserve nonzero failure behavior and the existing HTTP error envelope; do not require identical HTTP and CLI error formatting.

4. **AC4: Removal and dry-run invariants.** Run and extend `src/gc-cli.test.ts` and `src/gc-worktrees-cli.test.ts`.
   Reuse their real Git fixtures and the prior ADR's removal assertions through the new entry point.
   Plain gc must keep branches and archive metrics before run-directory deletion.
   Keep young, live, invalid-state, dirty, locked, unsafe-path, and unsafe-submodule candidates under the existing rules.
   Worktree gc must retain its separate snapshot, branch eligibility, and compare-and-swap rules.
   Never substitute worktree mode tests for plain mode tests.
   Plain dry-run can update `gc.stamp`; it must delete no data or append metrics or gc logs.
   Worktree dry-run must keep durable home contents, refs, and worktree files unchanged, including its stamp and journal.
   The HTTP transport still writes `client-idempotency.json` and `client-actions.jsonl` for an accepted POST.
   Both modes retain current temporary lock behavior. A held mode lock skips that pass; a thrown error releases it.
   Test zero deletion and chmod calls for dry-run and refused candidates, with a positive trace control.
   Test metrics failure prevents run deletion, and a candidate failure does not suppress the next valid candidate.

5. **AC5: Automatic behavior stays fixed.** Run `src/gc-kick.test.ts` and the existing daily worktree tests.
   The same child argv, home, intervals, initial daily stamp, lock checks, and disable variables must remain intact.
   Negative rows: fresh stamps, held locks, and disable variables start no automatic pass.
   Explicit gc still works when its automatic pass is disabled. No UI or catalog read starts a pass.

6. **AC6: Honest front-end gaps.** Extend `src/parity.test.ts` and run `factory parity`.
   Require exactly one `gc.run` gap for each deferred front end, with the IDs in the scope table.
   Reject a missing, duplicate, unknown-operation, or closed-bead gap under the existing parity rules.
   Keep all unrelated entries. The PR must name these three gaps and the core/CLI scope.
   The later beads must test actual adapter invocation, equivalent options and effects, refusals, and transport failure.
   A generic `catalog.echo` test alone does not prove gc parity.

## Test plan

First commit the AC1 missing-operation and AC3 missing-server-route tests. Show their expected failures on the base.
Add characterization rows for supported CLI forms and both dry-run modes before the move.
Add AC2 denial rows with call counters. Use one counter per protected effect and a positive control.
Keep all tests and implementation in one PR. Its final head must pass; do not ship the red test commit alone.

Focused command:

```text
bun test --timeout 30000 src/core src/client.test.ts src/server-api-cli.test.ts src/server-api-handler.test.ts src/server-api-tls.test.ts src/gc.test.ts src/gc-cli.test.ts src/gc-worktrees-cli.test.ts src/gc-kick.test.ts src/parity.test.ts
```

Use fresh fixture homes. Strip worker markers, `FACTORY_FROM`, and `FACTORY_OUTBOX` except in refusal tests.
Set `FACTORY_SELF_UPDATE=0` and prevent unrelated automatic child work in fixtures.
Use local fake remotes and stub external services. Never test deletion against a production home.
After the implementation commit, use `factory mutate` for caller refusal, mode selection, and dry-run dispatch guards separately.
Each mutant must build. Record each exact command and restore a clean worktree.

Final checks: `bun test --timeout 30000 src factories`, `claude plugin test mod`, and `bunx tsc --noEmit -p .`.
Run changed-file Prettier, `factory parity`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Run the factory's required report gate. Report any unavailable check plainly.
The final PR SHA must pass CI test, plugin, typecheck, and format.

## Risk

This change is security-sensitive: it exposes destructive filesystem and Git effects through a new core input boundary.
Keep caller refusal in the operation, even when a transport already checks its caller.
The current client API trusts the person transport; `rights: owner` is metadata, not independent role enforcement.
Do not expand bind addresses, certificate access, worker authorization, or credential handling.
The server can time out while a pass continues. Show that failure; do not retry automatically with a new key.
The existing locks and idempotency checks remain necessary across entry points.

No schema or retained-data migration occurs. Existing supported CLI output and retention behavior remain fixed.
The stricter argument contract changes only the undocumented forms listed above.
Known independent removal issues remain outside this pass: `o9031`, `r55o5`, `dxfyq`, and `se5` under the same bead prefix.
This pass adds no automatic invocation or faster retention policy. Do not alter their guards or claim their fixes.
If tests show this change makes one worse, apply the brief's made-worse gate before release.
Security-sensitive: yes (input validation, caller rights, filesystem permissions, and Git removal)

## Rollout and rollback

Use one draft PR for the three implementation tasks. Only a person merges it.
Release through the normal flow after review, security, and required checks.
No new flag, migration, production command, credential step, or factory definition change is necessary.
Keep existing gc disable variables and retention settings. They are not new deployment prerequisites.
The three UI beads follow this operation and their generic-client prerequisites.
Rollback uses a revert PR and normal release. It removes the new API and restores the prior CLI dispatch.
Rollback cannot restore files that gc already removed. Use existing backups for recovery.

## Observability

Retain `gc.log`, `gc-worktrees.jsonl`, metrics records, skip text, and per-pass error counts.
Retain the existing server action audit and idempotency records for `/v1/gc`.
After normal release, soak can read the catalog and normal pass records through authorized read paths.
Check the release SHA, operation metadata, pass times, and unchanged automatic cadence.
No AC is must-see-live: this refactor needs no manufactured production deletion to prove its contract.
Do not run even plain dry-run against production in plan or verify: it can write its stamp.

## Commit tasks

1. `claude-factory-n69b2.1`: AC1 through AC5 tests. Check the expected baseline failures. Budget: 25 minutes.
2. `claude-factory-n69b2.2`: core operation, port, CLI converter, output, and server route. Check AC1 through AC5. Budget: 55 minutes.
3. `claude-factory-n69b2.3`: gap rows, help, mutations, and final checks. Check AC6 and the final head. Budget: 40 minutes.

Each task depends on the prior task. The report lists the assigned child IDs.

## Plan evidence

No root CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists at the base.
Read the supplied rules, constitution, prior retention ADR, code, tests, and CI workflow.
The bead had no child tasks or prior comments. The branch had no PR or local changes.
The memory search returned no local notes.
`bun install --frozen-lockfile` passed.
`bun test --timeout 30000 src/core/catalog.test.ts src/core/import.test.ts src/gc.test.ts src/client.test.ts` passed.
Result: 123 tests, 525 assertions, zero failures.
`bun node_modules/typescript/bin/tsc --noEmit -p .` passed.
Changed-file Prettier and `git diff --check` passed.
Plan did not run the full runtime suite, plugin tests, package build, or production checks.
Two read commands hit hook denials. Neither command was retried.
