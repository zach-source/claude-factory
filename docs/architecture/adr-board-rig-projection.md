# ADR: Limit rig data in read responses

## Decision

This plan covers claude-factory-5wwv and its related `rigs.list` exposure.
The original base commit is `95e4a33d`.
This revision uses head `839967f513f772b090f4b81dd3a072338bf6f58a` of PR #787.
Return only explicit rig display fields from catalog operation `board.show` and GET `/v1/events`.
Use the same `boardView` projection before SSE serialization, replay-cache insertion, and live delivery.
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
The closed output schema has these leaf types:

- Strings: `name`, `repo`, `factory`, `goal`, `runner`, `sandboxClass`, and `linearSync.error`.
- Finite numbers: `maxRuns`, `linearSync.at`, `pulled`, `created`, `updated`, `stripped`, and `unrouted`.
- String arrays: `sweeps`, `linear.team`, `linear.projects`, and `linear.labels`.

Each rig, `linear`, and `linearSync` must be a non-null object, never an array.
An absent field remains absent. An explicit null value fails validation.
Every present allowed leaf must match its type; never coerce a value.
Unknown fields disappear; they do not extend the output schema.
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
Export that projection for `src/server-api.ts`; do not copy its field rules.
Project before the SSE publisher compares JSON or changes its event ID, ring, or subscribers.
If projection fails, discard the publication without a frame, an ID increment, or a payload log.
Retain the last valid replay frame. A later valid board must still reach subscribers.
Compare projected JSON: a change to private fields alone must not create an event.
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

## Cause of the repeated rounds

The original plan named the snapshot route but missed the SSE response boundary.
Its field table also left leaf validation implicit.
Implementation declared AC4 complete through other tests, although those tests did not cover both rig routes.
Reviews then found missing controls in separate rounds.
The release-note task also conflicted with the pinned station rule; release owns that note.

Commit `40e6196c` closes the SSE runtime path with the shared projection.
Its test at `src/server-api-handler.test.ts:490` combines private values and rejects only a malformed `rigs` collection.
It does not prove the separate private-field rows, nested failures, source preservation, or recovery required by task `.6`.
Narrow the next pass to those controls. Keep the runtime design and all completed HTTP work.
Reopen task `.6`; do not create a second defect for the same missing controls.

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

AC6. Add `events project each private rig field before replay and live delivery` in `src/server-api-handler.test.ts`.
Use separate rows for `env.FOO`, `env.API_KEY`, `params.FOO`, `params.API_KEY`, and credential-bearing `beadsRemote`.
Add separate unknown fields on the rig, `linear`, and `linearSync` with the `zqsecret` marker.
For each row, publish before subscription, then publish a distinct valid display change after subscription.
Assert exact projected replay and live frames, with consecutive IDs.
Assert no private field names or marker in either frame or captured logs.
Cover both runners and normal, halted, and read-only boards across the controls.
Use one complete benign display fixture to assert all allowed fields and array order.
Freeze nested source data and compare the whole source after publication and replay.
Keep unrelated board data, including `manager`, `reviews`, `reviewed`, runs, lease, and halt, unchanged when present.
The publisher must make zero board-provider, port, and runner calls.

AC7. Add `events reject malformed rig data without cache or delivery changes` in the same test file.
Cover null, primitive, and array values for rig entries, `linear`, and `linearSync`.
Cover a non-array `rigs` collection.
For each allowed leaf in the schema, supply a wrong-type object with the marker.
Also cover non-finite numbers and string arrays with object members.
Publish a valid board, each malformed row, and a distinct valid board.
Exercise rejection both before subscription and with an active subscriber.
Assert exact replay and live output: only valid frames, consecutive IDs, and no marker in logs.
Assert unchanged source data and zero board-provider, port, and runner calls.
Use valid sentinel frames to prove rejection; do not rely only on a timer or an absent substring.
HTTP malformed responses remain 500; SSE malformed publications create no event.

AC8. Add `events deduplicate the public view` in the same test file.
Two boards with equal display data and different private values create one event.
A later display change creates the next event.
Keep existing `events query grammar` and `events replay and ring` controls green.
Keep Authorization 403, POST 404, unknown query 400, and duplicate `after` 400 controls.
Refusals must make zero board-provider, port, and runner calls and create no subscriber.
Valid empty queries and decimal `after` remain allowed; no route grammar change is part of this work.
Existing ring capacity, replay order, disconnect, and process-local ID tests must still pass.

Prove AC6-AC8 with `bun test --timeout 30000 src/server-api-handler.test.ts`.
Include that file in the AC5 gate, together with `src/rigs-edit.test.ts`.

## Test plan and tasks

1. Task `claude-factory-5wwv.1`: commit the regression tests first.
   AC1 and AC3 must fail on the unchanged implementation because the marker reaches the response.
   Add AC2 and AC4 controls in the same test commit.
   Change only the deliberate param-value golden expectation; do not weaken another assertion.
2. Task `claude-factory-5wwv.2`: commit the projection and param-value fix after task `.1`.
   Run AC1 through AC5, then the full repository CI-equivalent checks.
   Release adds one bullet at the end of Unreleased in `CHANGELOG.md`; implement must not add it.
   Run `bun audit`, `gitleaks detect --log-opts=origin/main..HEAD`, and the required factory gate.

Both tasks fit one implement pass and one draft PR.
The tests-first commit can be red locally; the PR must contain the fix and pass all required checks.
Record red and green commands, test names, and SHAs in the task evidence.
No mutation test is necessary if the committed tests fail on the pre-fix code for the stated exposure.

Tasks `.1` through `.5` are complete; preserve their commits and tests.
Task `.6` now has one remaining test commit, after `40e6196c`:

1. Extend `src/server-api-handler.test.ts` with AC6-AC8 controls.
2. Run the focused test command and the expanded AC5 gate.
3. Commit the tests, then prove the privacy and failure controls with separate mutations.
   Replace `boardView(board)` with `board` for the first mutation.
   Remove the malformed-publication return for the second mutation.
   Each mutant must build and fail its named test; restore each mutation before the next check.
4. Record each command, result, and SHA on task `.6`, then close it.

These tests can pass on the current fix; do not undo completed work to create a red tests-first commit.
The earlier SSE test was red before `40e6196c`; the new controls prove that fix with mutations.
If a control exposes a runtime defect, commit its red test first, then the smallest fix before submission.
Do not submit a PR with red required checks.
This remainder fits one 120-minute implement pass in the existing draft PR.
Verify, review, and security must assess the final head; a prior approval does not cover new commits.

## Risk

This change is security-sensitive because read responses expose configuration secrets.
The primary risk is a missed nested field or a fallback to the original rig on an error.
Explicit nested projection and response-level tests address that risk.
SSE now suppresses private-only changes and discards malformed publications.
Thus a malformed publication can leave clients on the last valid snapshot until a valid board arrives.
SSE IDs remain process-local and ordered; they count public changes rather than private configuration changes.
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
A new server process starts with an empty SSE ring; no persistent replay migration exists.
Do not treat a code update alone as proof that an old process or its raw replay ring stopped.
Do not restart a live manager without the required owner approval.
Prefer a fix forward if a consumer fails.
A code rollback requires a revert PR and a person merge; it restores the known exposure.
Never change credentials or production state as part of this plan.

## Observability

Use HTTP status and response shape; add no metric or payload log.
The ship soak can check successful board and rig-list reads through the existing authorized client path.
It can check that board rigs omit private fields and rig-list params show `<hidden>`.
It can inspect one replay and one live SSE frame for absent private fields through the same authorized path.
No synthetic secret, private payload log, new metric, or mandatory live AC is necessary.
Record counts and pass/fail only, never response bodies or credentials.
Production access is not a pre-merge criterion or a requirement for this plan station.
If no authorized client path exists, report that live checks did not run; do not request credentials.

## Original plan validation

No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in the tracked file list.
The supplied rules and existing architecture records define this plan format.
The baseline command passed: `bun test --timeout 30000 src/core/catalog-handler.test.ts src/core/ops-cli.test.ts`.
Result: 65 tests passed, zero failed, 210 assertions.
This confirmed that the original tests did not cover the reported secret exposure.
Typecheck passed with `node node_modules/typescript/bin/tsc --noEmit -p .`.
The VM has no `bunx`; use `bun x` or the installed tool path.
The repository formatter ignores Markdown. Check this record with Prettier and `--ignore-path /dev/null`.
This station changes only this architecture record; implementation tests and the full test suite remain for implement.

## Revised plan validation

At `839967f5`, the expanded AC5 test command passed: 495 tests, zero failures, 2525 assertions across 15 files.
An earlier invocation hit the tool's 60-second limit; the completed run took 77.78 seconds.
TypeScript, explicit ADR Prettier, and `bun audit` passed.
The full suite and plugin tests did not run at this plan station.
Task `.6` is open and ready; tasks `.1` through `.5` remain closed.
The new AC6-AC8 controls remain for implement; these baseline results do not prove those new controls.
