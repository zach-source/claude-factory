# ADR: Keep 50 manager mails in the server

## Decision

This plan covers claude-factory-8llm on base `d5ad7685`.
Each tick contains only new manager mail. The server currently retains only the last tick.
Keep the last 50 manager mails across accepted ticks in each `serve()` instance.
Return them through `mail.list` and GET `/v1/mail`, oldest first.
Keep `board.show`, GET `/v1/board`, and SSE board data unchanged.

## Design

Use an array beside `last` in `src/server.ts:123`.
Inside the existing non-busy branch, append an array-valued `r.manager` and retain `slice(-50)`.
Use array concatenation; add no dependency, class, configurable limit, or persistent store.
Preserve every mail object and its order. Do not deduplicate equal mail objects or sort by timestamps.
Absent, null, and non-array `manager` values contribute no mail. Do not validate individual mail fields here.
Busy ticks and thrown tick errors contribute no mail and do not clear history.
Empty accepted ticks do not clear history. Each new server instance starts with empty history.
Keep `last`, `onBoard`, and board publication on their current path. Never replace the board's `manager` array with history.

Expose a mail accessor from `serve()`.
Pass it through `main()` in `src/server.ts:387`, `ClientOpts`, and the catalog `Ctx` to `mail.list`.
Use an optional `mail: () => unknown[]` callback in `src/server-api.ts` and `src/core/catalog.ts`.
In `src/core/ops/mail.ts`, keep the existing null-board check and 503 response.
Use the callback when present. Otherwise retain the current board-based behavior for existing callers.
An empty callback result must not fall back to the board.
Remove the obsolete shortcut comment about lost mail.
Keep the JSON array, trailing newline, response envelope, and read permission unchanged.

Expected source files: `src/server.ts`, `src/server-api.ts`, `src/core/catalog.ts`, and `src/core/ops/mail.ts`.
Extend existing tests in `src/server-api-tls.test.ts`, `src/server.test.ts`, and `src/core/ops.test.ts` as needed.
Do not change `.factory/`, clients, or the tick producer.

Rejected alternatives:

- Accumulate mail in the board: this changes board bytes and SSE semantics.
- Accumulate only in a client: slow clients still lose mail before their first read.
- Store mail on disk: durability exceeds this bounded, process-local requirement.
- Add a general ring class: array concatenation and `slice` already provide the required behavior.

## Acceptance criteria

All criteria are pre-merge. None is must-see-live.
Run the named tests with `bun test --timeout 30000` and their file paths.

AC1. Add `mail history spans three ticks` in `src/server-api-tls.test.ts`.
Drive three accepted ticks, each with one distinct mail. GET `/v1/mail` must return all three in tick order.
Assert complete objects, the existing response envelope, and zero CLI or port calls.
Repeat the GET. It must return identical bytes and must not consume or duplicate mail.

AC2. Add `mail history retains the last 50 entries` in `src/server-api-tls.test.ts`.
Cover 50 entries, then 51 entries, then 60 entries across ticks. The last response must contain entries 11 through 60.
Also cover one tick with 60 entries. It must retain the last 50 in source order.
Include equal objects and timestamps out of order. Keep duplicates and insertion order.
Reject any output above 50 entries; do not retain the oldest ten in the 60-entry rows.

AC3. Add `mail history survives empty busy and failed ticks` in `src/server.test.ts`.
After a mail tick, exercise absent, null, non-array, and empty-array `manager` values.
Then exercise a busy tick with mail and a thrown tick error. History must remain unchanged in every row.
A later accepted mail tick must append once. A second server instance must not inherit the first instance's mail.
The tests must stop each server and wait for its shutdown.

AC4. Add `mail history preserves board bytes` in `src/server-api-tls.test.ts`.
After three mail ticks, `/v1/board` must still contain only the third tick's mail and unchanged other fields.
Compare the complete response bytes with the existing board serializer's expected output.
Retain `tick answers the last tick result and runs nothing` without changed expectations.
Retain the board and SSE tests in `src/server-api-handler.test.ts` and `src/core/catalog-handler.test.ts`.
History must not alter the source tick objects or the values passed to `onBoard`.

AC5. Add `mail.list uses history with the existing no-tick contract` in `src/core/ops.test.ts`.
Null or undefined board still throws 503 `no tick yet`, even with a mail callback.
An accepted empty board returns an empty array. An empty callback takes precedence over nonempty board mail.
Without a callback, array-valued board mail remains supported; absent or non-array mail returns an empty array.
Keep the existing JSON-line tests and no-tick tests unchanged.
Keep all client authentication refusal tests unchanged; no route, parser, or permission rule changes.

## Test plan

First add the regression tests through the existing server and catalog interfaces.
Use controlled tick completion and bounded waits, not long fixed sleeps.
Commit tests before the fix. Show AC1 and AC2 fail because the response contains only the newest tick.
Do not use missing exports or type errors as the red evidence.
Then add the mail callback and its focused AC5 assertions with the implementation.
Run this focused suite after the fix:

```sh
bun test --timeout 30000 src/server.test.ts src/server-api-tls.test.ts src/server-api-handler.test.ts src/core/ops.test.ts src/core/catalog-handler.test.ts
bunx tsc --noEmit -p .
bun run format:check
```

Before the draft PR completes, run the repository test and plugin commands.
Require test, plugin, typecheck, and format CI checks on the final head SHA.
Run the station's required gate, `gitleaks detect --log-opts=origin/main..HEAD`, and `bun audit`.
Never ship the test-only commit with red required checks.

## Risk

The server retains up to 50 existing mail objects in memory; it creates no disk history.
The bound counts messages, not bytes, as the current mod does.
A restart loses this history. More than 50 new mails between reads can still cause loss.
The route exposes the same mail content to the same authorized callers for a longer period.
This change adds no auth, secret, crypto, permission, input parser, or infrastructure access behavior.
Preserve existing transport controls and never log message content.
There is no schema migration or new dependency.
The optional callback preserves existing direct catalog callers.
Security-sensitive: no

## Rollout and rollback

Use the normal draft PR, verification, review, person merge, and ship sequence.
No flag or migration is necessary. A normal server release starts with empty mail history.
Do not restart a live server by hand without the required owner approval.
To undo the change, revert the implementation and its new tests through a separate PR.
The previous release again returns only last-tick mail. No data conversion is necessary.

## Observability

No new metric or log is necessary.
During authorized soak, compare two `/v1/mail` responses across an empty accepted tick.
Existing mail must remain present, in order, with at most 50 entries.
Check `/healthz` for successful ticks and `/v1/board` for last-tick semantics.
Do not emit test mail into production or include mail bodies in the report.
If no natural mail occurs, report that limit; the deterministic tests provide the required proof.
Live checks are soak observations, never pre-merge acceptance gates.

## Tasks

1. `claude-factory-8llm.1`: Add regression tests for AC1-AC4 and preserve AC5 controls. Commit tests and record semantic failures.
2. `claude-factory-8llm.2`: Add bounded history and the callback, then complete AC5. Commit after focused tests and typecheck pass.

Task 2 depends on task 1. Both tasks fit one implementation pass and one PR.
Release owns the changelog entry. Plan commits only this ADR.
