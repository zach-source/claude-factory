# ADR: Limit rig data in read responses

## Decision

This plan covers claude-factory-5wwv and its related `rigs.list` exposure.
The base commit is `95e4a33d`.
Return only explicit rig display fields from catalog operation `board.show`.
Hide every param value in `rigListLines`, for both the CLI and `GET /v1/rigs`.
Keep param names and the literal value `<hidden>`.
Do not change stored rigs, worker inputs, `rigs()`, `tick()`, or `readOnlyBoard()`.

The security rule is fail-closed for rig fields: only the fields below can cross the board response boundary.
Unknown rig fields must not appear, even when their values do not match a secret pattern.
Do not spread a full rig or a nested rig object into the response.

| Object       | Allowed fields                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Rig          | `name`, `repo`, `factory`, `maxRuns`, `sweeps`, `goal`, `runner`, `sandboxClass`, `linear`, `linearSync` |
| `linear`     | `team`, `projects`, `labels`                                                                             |
| `linearSync` | `at`, `pulled`, `created`, `updated`, `stripped`, `unrouted`, `error`                                    |

Use the field types in `mod/types/index.d.ts:73`.
Copy only those fields into fresh objects; preserve optional field absence and array order.
Apply existing `redactRig` protection to the projected display data as defense in depth.
This retains secret-pattern protection for display strings without trusting that protection for configuration values.
Always omit `env`, `params`, and `beadsRemote`, regardless of key names, value shapes, or nesting.
Unknown fields inside `linear` and `linearSync` must also disappear.
Preserve all other board fields and the existing response envelope.
Preserve absent `rigs` and empty `rigs` behavior.
If `rigs` has an invalid shape, fail without serializing its raw contents; never fall back to the original object.
Retain the current behavior for a board without a `rigs` property, including the existing primitive-board test.

This change adds an output projection, not a shell, path, or configuration parser.
It adds no accepted input forms or downstream commands.
Arbitrary secrets placed in permitted display text remain outside this guarantee.
Other board sections, log history, and other rig commands remain outside this change.

## Evidence and consumers

- `src/core/catalog.ts:271` serializes the complete cached board.
- `src/cli.ts:7606` adds full rigs to a tick, with `linearSync` state.
- `src/cli.ts:597` returns full rigs in the lease-holder read-only board.
- `src/server.ts:318` gives the cached board to the client handler.
- `mod/hooks/views.tsx:805` draws rig identity, capacity, goal, sweeps, and Linear status.
- `mod/hooks/views.tsx:1298` uses runner, sandbox class, name, and capacity.
- `mod/hooks/register.tsx:320` stores tick rigs; line 344 passes them to patrol.
- `mod/hooks/view.ts:548` uses rig identity, goal presence, and capacity for patrol text.
- `herdr/mods/factory/view.js:131` stores tick rigs. Its current board views group runs by their rig names.
- `src/core/ops/runners.ts` already uses an explicit projection for its response.
- `src/cli.ts:11472` already calls `redactRig` for rig-list text.

The earlier bead comment predates the last change: rig-list text now hides known secret patterns.
It still exposes arbitrary param values under ordinary keys.
`redactRig` at `src/rigs-edit.ts:151` only hides known patterns or secret-like keys.
Thus `FOO=zqsecret` remains exposed.

## Design and alternatives

Put the board projection beside `board.show` in `src/core/catalog.ts`.
Use a small local helper only if the nested projection needs one.
Use existing types and `redactRig`; add no dependency or general serializer framework.
Change the param output loop in `src/cli.ts` to print `<hidden>` for every param value.
Keep the other rig-list fields and empty-list text unchanged.
Update the exact rig-list golden in `src/core/ops-cli.test.ts` for this deliberate contract change.
Do not change `redactRig` globally: other rig commands retain their current contract.

Reject a `redactRig`-only board fix: arbitrary secrets under ordinary keys still pass.
Reject a blacklist of three fields: future configuration fields would pass by default.
Reject projection in `rigs()` or `tick()`: internal worker and manager paths need the original configuration.
Reject a second API-only rig-list formatter: one formatter keeps CLI and API output equal.
No frontend code change is necessary for the selected display fields.

## Acceptance criteria

All criteria are pre-merge. None is must-see-live.
Run each named test with `bun test --timeout 30000` and its test file.

AC1. Add `board.show omits private rig fields` in `src/core/catalog-handler.test.ts`.
GET `/v1/board` with complete rig fixtures must return 200 and contain no `zqsecret` anywhere in the body.
Use separate rows for `env.FOO`, `env.API_KEY`, `params.FOO`, and `params.API_KEY`.
Add a credential-bearing `beadsRemote` URL and an unknown rig field with the same marker.
Add unknown nested fields in `linear` and `linearSync`.
Assert absent field names, not only absent marker values.
The allowed-field control must preserve every listed display field and nested field with benign values.
Include both runner types, zero capacity, absent capacity, empty sweeps, and absent sweeps.

AC2. Add `board.show projection preserves internal state` in `src/core/catalog-handler.test.ts`.
Exercise normal, halted, and read-only board fixtures with the same secret rows.
Freeze the source fixture; assert unchanged source data after two GETs.
Assert unchanged runs, manager mail, lease, halt, and review fields.
Cover absent rigs, empty rigs, malformed rig collections, and malformed rig entries.
Malformed rig data must fail without echoing any raw value.
Keep null-board 503, JSON content type, primitive-board behavior, and existing envelope behavior.
All board reads must make zero runner or port calls and emit no fixture secrets in logs.

AC3. Add `rigs.list hides every param value` in `src/core/ops-cli.test.ts`.
Use its real core-port fixture and `serverGet` helper, not a safe mock formatter.
GET `/v1/rigs` and run `factory rig list` against isolated fixture rigs.
Both must retain param names and return `<hidden>` for ordinary and secret-like keys.
Test `FOO=zqsecret`, `API_KEY=zqsecret`, a benign value, an empty string, and multiple rigs.
The body must contain no marker, env value, or beadsRemote credential.
Assert unchanged fixture storage and equal CLI/API text.
Keep the no-rigs control and every non-param line in the existing golden.

AC4. Extend route refusal rows in `src/core/catalog-handler.test.ts` for both endpoints.
Authorization headers remain 403; unknown or duplicate query fields remain 400; POST remains 404.
Each refused request must make zero board, port, and runner calls.
Valid GETs remain allowed without an idempotency key.
The change must not alter read rights, mTLS policy, or catalog metadata.

AC5. Run the existing frontend and server checks after the fix.
Commands: `bun test --timeout 30000 src/core src/server-api.test.ts src/server.test.ts src/herdr-view.test.ts`.
Run `claude plugin test mod` for board, rigs, runners, and patrol coverage.
Run `bunx tsc --noEmit -p .` and `bunx prettier@3.9.9 --check .`.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final PR head.
No tests can remain red when implement submits the draft PR.

## Test plan and tasks

1. Task `claude-factory-5wwv.1`: commit the regression tests first.
   AC1 and AC3 must fail on the unchanged implementation because the marker reaches the response.
   Add AC2 and AC4 controls in the same test commit.
   Change only the deliberate param-value golden expectation; do not weaken another assertion.
2. Task `claude-factory-5wwv.2`: commit the projection and param-value fix after task `.1`.
   Run AC1 through AC5, then the full repository CI-equivalent checks.
   Add one release bullet at the end of Unreleased in `CHANGELOG.md`.
   Run `bun audit`, `gitleaks detect --log-opts=origin/main..HEAD`, and the required factory gate.

Both tasks fit one implement pass and one draft PR.
The tests-first commit can be red locally; the PR must contain the fix and pass all required checks.
Record red and green commands, test names, and SHAs in the task evidence.
No mutation test is necessary if the committed tests fail on the pre-fix code for the stated exposure.

## Risk

This change is security-sensitive because read responses expose configuration secrets.
The primary risk is a missed nested field or a fallback to the original rig on an error.
Explicit nested projection and response-level tests address that risk.
Clients that depend on private board fields lose those fields by design.
Rig-list clients retain param names but lose all param values, including benign values.
The listed frontend consumers need neither class of values.
There is no storage migration, credential change, or infrastructure change.
Do not copy real secrets into fixtures, logs, task evidence, or reports.
Security-sensitive: yes (secrets in read API responses)

## Rollout and rollback

Use the normal reviewed release after the person merges the PR.
No flag, configuration migration, or migration order is necessary.
The projection applies on the next board request, even if the cached tick predates the release.
Do not restart a live manager without the required owner approval.
Prefer a fix forward if a consumer fails.
A code rollback requires a revert PR and a person merge; it restores the known exposure.
Never change credentials or production state as part of this plan.

## Observability

Use HTTP status and response shape; add no metric or payload log.
The ship soak can check successful board and rig-list reads through the existing authorized client path.
It can check that board rigs omit private fields and rig-list params show `<hidden>`.
Record counts and pass/fail only, never response bodies or credentials.
Production access is not a pre-merge criterion or a requirement for this plan station.
If no authorized client path exists, report that live checks did not run; do not request credentials.

## Plan validation

No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in the tracked file list.
The supplied rules and existing architecture records define this plan format.
The baseline command passed: `bun test --timeout 30000 src/core/catalog-handler.test.ts src/core/ops-cli.test.ts`.
Result: 65 tests passed, zero failed, 210 assertions.
This confirms the current tests do not cover the reported secret exposure.
Typecheck passed with `node node_modules/typescript/bin/tsc --noEmit -p .`.
The VM has no `bunx`; use `bun x` or the installed tool path.
The repository formatter ignores Markdown. Check this record with Prettier and `--ignore-path /dev/null`.
This station changes only this architecture record; implementation tests and the full test suite remain for implement.
