# ADR: Stream client board changes

## Scope and evidence

This plan serves claude-factory-bb05 in one pull request.
The console can still poll `GET /v1/board`.
No console change, factory definition, credential change, or live switch belongs in this run.

At base `2fbc32a9`, `clientHandler` rejects `/v1/events` through the catalog route match.
`serveSocket` waits for `res.arrayBuffer()` before it writes a response.
Thus, a new stream in the handler also needs a transport change.
`serve` stores the last tick result and skips results with `busy: true`.
No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in this checkout.

Baseline command:

```sh
bun test --timeout 30000 src/server-api-handler.test.ts src/server-api-tls.test.ts src/server.test.ts
```

Result: 135 pass, 0 fail, 411 assertions on Bun 1.4.4.
The current `events not served` test pins the old 404 response.

## Decision

Keep the event state in the `clientHandler` instance in `src/server-api.ts`.
Give the handler a small board-update entry point.
Connect that entry point to `serve` through an optional callback in `src/server.ts`.
Call it when a successful tick updates `last`, before the next tick starts.
Do not poll from each request or invoke a tick from the API.

Compare `JSON.stringify(result ?? null)` with the previous serialized board.
Start with serialized `null` and event id 0.
Each different serialization adds one event, with the next decimal id.
The first non-null board therefore has id 1.
Equal serializations, busy results, and thrown ticks add no event.
A successful null result after a non-null board adds a null event, consistent with the board route.
Property order follows the existing JSON output; this plan adds no canonical JSON serializer.
Store serialized snapshots so later object mutations cannot change old events.

Keep the last 256 events in memory, even without connected clients.
Use exact integer comparisons, such as BigInt, for ids and cursors.
Ids are decimal strings on the wire, not JSON BigInt values.
No new dependency, durable store, flag, or configuration value is needed.

`GET /v1/events` defaults to `after=0`.
The raw URL search must be empty or match `^\?after=[0-9]+$`.
This closed grammar permits one literal key and one nonempty ASCII decimal value.
Reject every other query with 400 before stream creation or subscription.
Leading zeroes are valid. Percent escapes, duplicate keys, extra separators, and extra keys are invalid.
The existing HTTP request-target length limit still applies.
No shell, config, or external-tool input parser is added.

Send retained events whose ids exceed the cursor, in ascending order, then send new events.
The handoff from replay to new events must lose and duplicate no event.
For a cursor older than the ring, send the retained suffix only.
For a cursor equal to or greater than the latest id, wait for an id greater than that cursor.
Before the first board, open an empty stream and wait.
Ids and history reset when the process restarts.
Clients must reconnect with `after=0` after a server restart or an unknown cursor lifetime.
This is a snapshot feed, not a durable audit log.
`Last-Event-ID` does not replace the explicit query cursor in this version.

Each event uses the default SSE message type and this UTF-8 frame:

```text
id: <decimal-id>
data: <single-line JSON board>

```

Send status 200 and `Content-Type: text/event-stream; charset=utf-8` immediately.
Send `Cache-Control: no-cache`.
In `serveSocket`, stream SSE response chunks without `arrayBuffer()`.
Use HTTP/1.1 close-delimited output with `Connection: close`, no Content-Length, and no Transfer-Encoding.
Keep the current finite-response path for other routes.
Keep one request per connection and the current request grammar.
Do not replace the node:tls certificate gate with Bun.serve.

Respect socket backpressure: wait for drain after a false socket write result.
Do not let a slow client block the tick or other clients.
Bound each subscriber backlog to 256 pending event frames, apart from the frame in transport.
Close a subscriber that exceeds that bound; do not silently skip its live events.
An implementation can instead use a ring cursor and close the subscriber when its next event leaves the ring.
Connect socket close to Request abort and response-reader cancellation.
Remove subscribers on abort, cancel, stream error, socket error, and server stop.
Do not add per-client tick timers or heartbeat events.

## Acceptance criteria

All tests below run with the baseline command above.
Extend the existing test files; no new test framework is needed.

- **AC1: Query grammar.** Add `events query grammar` in `src/server-api-handler.test.ts`.
  Allow no query, `after=0`, `after=0001`, and `after=9007199254740993`.
  Deny empty values, `abc`, `-1`, `+1`, `1x`, `1.0`, `1e2`, whitespace, Unicode digits, and percent escapes.
  Deny duplicate `after`, unknown keys, bare keys, and a trailing ampersand.
  Each denied row returns 400, creates no subscriber, and calls no runner or Port method.
  Valid rows call no runner or Port method either.
- **AC2: Tick changes.** Add `events follow accepted tick results` in `src/server.test.ts`.
  Two distinct non-null results from the initial null state produce ids 1 and 2.
  An equal fresh object, a busy tick, and a thrown tick add no event.
  A nested field change adds one event. A later null result adds one null event.
  A reused mutable object cannot alter an old replay payload.
  GET /v1/board keeps its current response and pre-tick 503 behavior.
- **AC3: Replay and live delivery.** Add `events replay then stream over mTLS` in `src/server-api-tls.test.ts`.
  Use random health and client ports, a fake tick, and disposable person certificates.
  Open after baseline id n; release two controlled tick changes and receive ids n+1 and n+2.
  Reconnect with after=n+1 and receive only n+2 until another change occurs.
  Assert exact JSON payloads, UTF-8 text, blank-line framing, headers, and arrival before connection close.
  A change at the replay/live boundary appears once. Two clients see the same ids.
  A pre-tick stream opens immediately and later receives id 1.
- **AC4: Bounded history.** Add `events retain 256 snapshots` in `src/server-api-handler.test.ts`.
  Publish 258 changes without clients; after=0 returns only ids 3 through 258.
  after=257 returns 258; after=258 waits; after=259 ignores 259 and later receives 260.
  A cursor above Number.MAX_SAFE_INTEGER must not round into another cursor.
  A fresh handler resets history and starts at id 1.
- **AC5: Cleanup and pressure.** Add `events release slow and closed clients` in the handler and TLS tests.
  Abort before the first event and after one event; both remove the subscriber.
  Cancel a response reader, destroy a client socket, and stop the server; each releases stream resources.
  Force socket backpressure and subscriber overflow with controlled test doubles, not a timing-only memory assertion.
  Assert bounded pending frames, stream closure on overflow, and continued delivery to a fast client.
  A socket close during drain must release the pending read and write tasks.
- **AC6: Access and transport invariants.** Extend the existing TLS and refusal tables for the events route.
  An Authorization header, including an empty value, returns 403 before query checks or subscription.
  No certificate, a foreign CA, and a server-only certificate never reach the handler.
  The health port, non-GET methods, and an extra path segment still return 404.
  Existing malformed HTTP requests still make zero handler calls.
  Chunked request bodies, Expect, Upgrade, duplicate headers, and invalid lengths remain denied.
  Valid finite GET and POST responses, request idle limits, and action idempotency still pass their existing tests.
- **AC7: Contract and checks.** Update `specs/004-factory-server/contracts/client-api.md` with the decisions above.
  Remove only the obsolete events-404 claim and explain stream connection lifetime.
  The release station adds one bullet at the end of Unreleased in CHANGELOG.md.
  Required checks on the final head must pass: test, plugin, typecheck, and format.
  Run `bun audit`, the repository gate, and `gitleaks detect --log-opts=origin/main..HEAD`.
  Record each unavailable local check; do not claim a pass from an unfinished command.

## Test-first work

First add the AC1, AC2, and AC3 tests through the existing handler and serve interfaces where possible.
Replace the obsolete `events not served` assertion with the new route contract.
Run the focused command on pre-fix code and record assertion failures from the absent route or absent event delivery.
A compile error from a proposed helper does not prove the defect.
Then add the remaining boundary and resource tests with the implementation.
Keep test and implementation commits in one pull request; the final head must have no intentional red check.
Use explicit tick barriers and bounded read deadlines instead of short sleeps.
Use the existing isolated openssl client approach for certificate-denial rows.
Each test must close sockets, cancel readers, stop servers, and use a disposable factory home.

## Alternatives

- Per-request board polling can miss changes between polls and creates extra timers.
- A handler-only response never reaches clients because the listener awaits the complete body.
- A durable event database adds migration work outside this snapshot contract.
- Bun.serve for the client port removes the explicit certificate gate that existing tests protect.
- A generic event bus or catalog stream abstraction has one user and adds unnecessary code.
- Automatic Last-Event-ID support adds a second cursor grammar outside the requested query contract.

## Risk

This change is security-sensitive: it parses public query input and changes the authenticated response transport.
Keep the certificate gate, Authorization refusal, and HTTP request grammar intact.
Full board snapshots contain the same data as the person-only board endpoint.
Do not log board payloads, query text, certificates, or credentials.
Retained memory depends on board size; this plan bounds event counts and subscriber backlog, not individual board size.
Slow clients must not cause unlimited queues or delay ticks.
History is volatile; reconnect after retention loss can omit old snapshots.
Clients can recover current state through the board endpoint and a fresh cursor.
No database migration or change to existing endpoint output is needed.
Security-sensitive: yes (query input and authenticated stream transport)

## Rollout and rollback

Use the existing server release path after the person merges the pull request.
No feature flag or migration order is needed.
Keep console board polling until its separate stream integration is ready.
Owner-only credentials, live changes, and manager restarts remain outside this run.
Rollback uses a revert pull request and the normal release path after a person merges it.
Streams close at server stop; clients can resume board polling.
No event-store cleanup is needed.

## Observability

No new metrics system is needed.
The local mTLS test proves frame delivery, replay, and cleanup before merge.
For ship soak, use the approved person client to read `/v1/events?after=0` and `/healthz`.
Check Content-Type, increasing event ids during natural board changes, and continued health ticks.
Compare the newest payload with `/v1/board` when the board is stable.
Do not cause a live board change merely to test SSE.
If live access needs owner approval, record that separate soak step; it is not a pre-merge acceptance criterion.
No AC is must-see-live. Deterministic fake-tick tests prove the feature when production has no natural change.

## Commit tasks

1. `claude-factory-bb05.2`: Add the first failing SSE tests in the existing handler, TLS, and server test files.
   Check: the focused command fails on missing behavior, with the existing access checks still intact.
2. `claude-factory-bb05.1`: Add tick publication, the bounded ring, the query check, stream transport, and resource tests.
   Check: AC1 through AC6 pass with the focused command; run typecheck and format on the changed code.
3. `claude-factory-bb05.3`: Update the client contract; run the complete final checks. Release owns the Unreleased entry.
   Check: AC7 passes and the final pull request head has all required checks green.

The three commits fit one 120-minute implement pass.
No other bead must land first, and no known production defect becomes worse through this plan.

## Revision after four implement rounds

This section defines the remaining work. AC1 through AC7 and the product design above remain in force.
The original tasks and review tasks through `claude-factory-bb05.8` are closed.
Do not repeat their implementation or the initial red-test commit.
Keep draft PR #770 and this branch. Do not open another pull request.

At head `4694be2f`, the focused command passes 179 tests with 586 assertions.
Commit `cb3d384b` contains the latest test change; `4694be2f` merges main after that change.
The journal reversed these two roles in its fourth implement report.

### Cause of the repeated reviews

The tests mixed replay evidence with live-delivery evidence.
The two tests at `src/server-api-tls.test.ts:339` use 50 ms ticks without control from the reader.
Both can receive every frame from history, yet pass assertions that claim live delivery.
Earlier duplicate checks stopped reads before the final assertion, so later chunks escaped those checks.
Review also found untested transport branches; the controlled socket tests now cover those branches.

The latest barrier test at `src/server-api-tls.test.ts:402` proves headers before the first tick completes.
It also proves two live frames and EOF after server stop.
It starts with empty history, so it does not itself prove the replay-to-live boundary.
The handler test `replay then live, each event once` covers that boundary without the TLS transport.
No definite product defect remains from these observations.

### Narrow test design

Replace the two timed TLS delivery tests with one controlled replay-to-live test in the same file.
Keep the pre-tick header test and all access, query, history, and transport checks.
Use the existing disposable certificates, random ports, and openssl client pattern.
Use one active stdout reader per client and parse complete blank-line-delimited frames across arbitrary chunks.
Flush the UTF-8 decoder at EOF. Do not infer event counts from socket chunk counts.
Use bounded deadlines for each wait. A timeout or early EOF must fail the test.

The test `controlled replay crosses into live delivery once` must follow this sequence:

1. Hold each fake tick until the test releases it. Observe publication before the next step.
2. Publish board 1 with UTF-8 text. Confirm that the board route exposes board 1.
3. Open clients A and B with `after=0`. Read their headers and complete replay frame 1.
4. Keep both readers active. Release board 2 with a nested field change.
5. Require complete live frame 2 on both clients before another tick can complete.
6. Open client C with `after=1`. Require replay frame 2, without frame 1.
7. Release a null board. Require live frame 3 with JSON `null` on A, B, and C.
8. Release another null board. Wait for that tick to complete; it must add no event.
9. Release a distinct final marker board. Require frame 4 on all three clients before server stop.
10. Stop the server and read through EOF. Assert exact complete frame arrays: A/B `[1,2,3,4]`, C `[2,3,4]`.

The final marker proves delivery after the equal tick through the same ordered stream.
All three clients must receive the same payload for each shared id.
Assert exact payloads, headers, ids, UTF-8 text, and frame separators, as AC3 already requires.
Duplicate, absent, stale-cursor, partial, and extra frames must fail the exact-array assertions.
Do not create a heartbeat or another product event type for the marker; use an ordinary fake board.
Use `finally` to release pending ticks, stop servers, cancel readers, and kill and await child processes.
Also destroy the fake socket after the existing header-pressure assertion at `src/server-api-handler.test.ts:609`.
Assert that its subscriber count reaches zero.

This replaces evidence with stronger evidence; it removes no acceptance requirement or denied input row.
Do not add a generic stream framework, product API, dependency, or production change for this test.
Keep the optional lazy event-state optimization outside this pass; it does not block the feature.
Another transport rewrite would increase risk without a known defect to fix.

### Remaining task and proof

The remaining task, `claude-factory-bb05.9`, is one test commit within one 120-minute implement pass.
Its files are `src/server-api-tls.test.ts` and `src/server-api-handler.test.ts` only.

First add the controlled test and confirm that it passes the current implementation.
Commit the test before mutation checks. The initial absent-route red tests already exist in the journal.
Prove the new test fails for each isolated, buildable defect:

- Remove live subscriber registration at `subs.add(sub)`; replay works, but required live frames fail.
- Enqueue each replay frame twice; exact frame arrays fail, even when duplicates arrive in separate chunks.
- Remove the equal-board early return; the final marker has the wrong id and the frame arrays fail.

Use the factory mutation command, or restore each manual mutation before the next one.
Record the failing assertion or deadline for each mutant. A compile error is not proof.
Confirm a clean worktree after each manual restoration.
Then run the focused command, `bun x tsc --noEmit`, and Prettier 3.9.9 on both test files.
Verify must inspect the barriers and exact-array assertions, not only the test names or pass count.
Review must map this test to AC3 and the existing controlled socket tests to AC5.
Run the AC7 gates on the final head; no required check can remain red by design.

### Risk, release, and scope

The remaining commit changes test evidence and cleanup only. It adds no migration, flag, or public behavior.
The original security review remains required because the complete pull request changes query input and authenticated transport.
Rollout, rollback, and ship observability remain as specified above. No AC is must-see-live.
No owner action or other bead must complete before this test task.
No known production defect becomes worse. No separate feature split is needed.
Security-sensitive: yes (query input and authenticated stream transport)
