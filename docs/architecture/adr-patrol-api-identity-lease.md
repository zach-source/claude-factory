# ADR: Separate the patrol API identity and lease

## Context and scope

Bead: `claude-factory-1ocuv`. Base: `e5d5281d`.
This ADR refines dependent work item 1 in `adr-server-patrol-os-boundary.md`.
The owner handler trusts person certificates and reads replay state in `src/server-api.ts`.
The local lease in `src/lease.ts` uses a parent pid. It cannot identify a remote patrol.
The mail path in `src/cli.ts:12757` appends an event before the owner handler saves its replay result.
The patrol state in `src/once.ts:150` has a separate write path for tick mail.
These paths do not provide an atomic remote effect with a replay receipt.

The full API, durable mail protocol, and integration exceed one 120-minute pass.
This run supplies the dormant transport, identity checks, metadata reads, and remote lease protocol.
`claude-factory-dnaso` supplies durable worker mail, retained input mail, completion receipts, and server integration.
That bead must precede `claude-factory-76hg1`, the isolated runtime bead.
The isolated evidence and owner activation remain in `claude-factory-k1c02`.
Do not claim that this increment completes the original mail requirements or permits activation.

## Decision

Add `src/patrol-api.ts` with an explicit handler and a separate TLS listener.
Add `src/patrol-lease.ts` for the remote lease state machine.
Use Node TLS, Node crypto, and the existing `serveSocket` HTTP parser.
Do not add a dependency, a CLI fallback, a general RPC dispatcher, or a shell runner.
The constructor takes trusted server certificate material, an audience, an identity provider, and a metadata provider.
Only tests construct the listener in this increment. No production caller, flag, manifest, or credential file changes.
The follow-up must wire the listener to the active server writer, then supply the durable adapters.
Keep the existing owner listener, catalog, local lease, and local patrol unchanged.

Rejected alternatives:

- Person certificates give patrol owner access.
- Worker tokens carry the wrong role and scope.
- Catalog rights alone expose future operations by accident.
- The current owner replay file does not bind a result to an identity and lease generation.
- A CLI mail adapter cannot atomically save its effect and replay receipt.
- A PID lease cannot fence a remote client or a prior server instance.
- Full integration in this pass would combine identity, persistence, mail, and runtime changes without enough test time.

## Transport and identity contract

The future listener uses HTTPS on a separate configured port; 8445 is the reserved default.
There is no HTTP mode, proxy identity header, redirect, cookie, or client certificate identity on this listener.
TLS authenticates the server. A person certificate alone grants no patrol access.
Require TLS 1.2 or later. Clients must verify the server certificate and hostname.
The owner port still rejects every Authorization header and trusts only its existing person CA.

The only credential header is `Authorization: Patrol patrol_v1_<secret>`.
The secret is exactly 43 unpadded base64url characters for 32 random bytes.
Require canonical base64url after decode and encode. Reject every other scheme and token form.
The server stores only a SHA-256 digest of the complete token.
Use a fixed-length, constant-time digest comparison. Never log the token or its digest.
This is a distinct opaque patrol credential, not a signed claim or a worker token.

The trusted identity provider returns records with exactly these fields:

| Field | Type and constraint |
| --- | --- |
| `id` | Identifier; unique for each credential incarnation |
| `digest` | 64 lowercase hexadecimal characters; unique |
| `audience` | Identifier equal to the configured server audience |
| `notBefore` | Nonnegative safe integer, Unix milliseconds |
| `expiresAt` | Safe integer greater than `notBefore` |
| `rigs` | 1 to 100 distinct identifiers; no wildcard |

An identifier matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.
The provider returns at most 100 records. Invalid records or duplicate ids or digests refuse all requests.
Authenticate with `notBefore <= now < expiresAt` on every request, including a replay.
Read only the identity provider before authentication; do not read application state.
The provider is a trusted callback in this increment, not a new file parser.
Tests replace its records to prove revocation and rotation without a server restart.
Removal revokes an identity immediately. Rotation creates a new id and digest.
Changing the audience or rig set invalidates that identity's lease and replay scope.
The lease must bind the full authorized record, not just its id.
Credential issuance and live storage remain owner-only follow-up work.
Use synthetic test tokens only. Do not add an issuance command in this run.

## Closed request and response contract

The rule is default denial: only an exact method, path, field set, identity scope, and lease state can reach an adapter.
No catalog lookup can add an operation to this allow set.
Paths below are literal ASCII. Only `<run>` is variable, and it must match the identifier grammar.
Reject query strings, percent escapes, dot segments, duplicate slashes, trailing slashes, and absolute-form request targets.
Check the raw target before URL normalization; extend `serveSocket` with an optional patrol-only target check if necessary.
Keep owner transport behavior unchanged.
There is no caller-supplied file path, shell command, argument vector, URL, environment, or operation name.
These forms are outside the grammar, not inputs to another tool.

GET requests have no body. POST requires `Content-Type: application/json` and a body of at most 4096 UTF-8 bytes.
POST bodies must be compact JSON objects whose bytes equal `JSON.stringify(JSON.parse(body))`.
This canonical form rejects duplicate keys, extra whitespace, and alternate escape forms before any adapter call.
Object field order need not be sorted. Unknown fields, null, arrays, wrong types, and missing fields are invalid.
Reuse the socket limits: 16 KiB headers, no transfer encoding, and no repeated request headers except Accept.
Add an optional 4096-byte patrol body limit to the shared parser; retain the owner's existing limit.
Use a 30-second request-read deadline and close each connection after one response.
Reject oversized bodies from Content-Length before buffer growth beyond the limit.
Apply the same byte limit to a direct handler call in tests.

All POST requests require `Idempotency-Key` matching `^[A-Za-z0-9-]{8,128}$`.
An epoch or generation is a lowercase canonical UUID from `crypto.randomUUID()`.
The server chooses all lease times; clients cannot request a TTL or supply a clock.

| Method and path | Exact body | Success response |
| --- | --- | --- |
| GET `/v1/patrol/snapshot` | None | `{epoch, runs}` |
| GET `/v1/patrol/runs/<run>` | None | `{run}` |
| POST `/v1/patrol/lease/acquire` | `{epoch}` | `{epoch, generation, expiresAt}` |
| POST `/v1/patrol/lease/renew` | `{epoch, generation}` | `{epoch, generation, expiresAt}` |
| POST `/v1/patrol/lease/complete` | `{epoch, generation, outcome}` | `{completed: true}` |

`outcome` is exactly `success` or `failed`. Completion only releases the lease in this increment.
It must not consume mail or mark a model step successful elsewhere.
The snapshot contains at most 1000 run rows, sorted by id, with no silent truncation.
Each run row has exactly `{id, rig}`. Both values use the identifier grammar.
Reject duplicate run ids and unknown metadata fields.
The metadata provider must return only these identifiers, never raw run records, logs, or board JSON.
Validate and explicitly reconstruct every response. Malformed metadata gives 503, with no partial response.
The snapshot includes only rigs in the authenticated record.
The scoped read selects from that same authorized metadata view; absent and out-of-scope runs both give 404.
No detailed run adapter is called for a run outside that view.
This metadata-only snapshot deliberately contains no free text, mail, summaries, paths, environment, credentials, or provider fields.
`boardView` is not a sufficient patrol projection: it preserves other top-level fields.

Every other route stays denied, including worker mail until the dependent bead lands.
Explicit negative rows include owner decisions, gates, start, owned start, goto, abort, halt, wake, held-run changes, screen, logs, and catalog.
Also deny worker routes, arbitrary file reads, shell execution, and all alternative HTTP methods.

Use fixed error codes and no reflected request data:
400 for invalid syntax; 401 for invalid identity; 403 for a forbidden operation;
404 for an unavailable scoped run; 409 for lease or replay conflict; 503 for unavailable metadata or capacity.
TLS failure closes the connection. Unknown paths return 403 after authentication.
Error bodies contain exactly `{error}`, with a fixed enum string.
The enum values are `invalid_request`, `invalid_identity`, `forbidden`, `not_found`, `conflict`, and `unavailable`, respectively.
All success responses use status 200 and `application/json`. Times are safe integer Unix milliseconds.

## Lease and replay protocol

One handler instance owns one global patrol lease across its configured rigs.
It creates a fresh epoch at construction. Each successful acquire creates a fresh generation.
The TTL is 60000 milliseconds. Renewal extends expiry to `now + 60000`.
At `now >= expiresAt`, the lease is stale. A repeated acquire cannot renew a live lease.
The exact acquire replay returns its original generation and expiry while that lease remains valid.
Any other acquire conflicts while a lease exists, even from the same identity.
Use an injected clock for tests. A backward clock jump invalidates the current lease.
Serialize lease transitions and replay access; keep each transition synchronous without an intervening await.
Recheck identity, epoch, and lease immediately before a transition or replay.

Bind a replay entry to identity incarnation, audience, scope, epoch, generation, key, route, and canonical body.
Acquire entries bind to the generation that the server issued.
The same key with another route or body gives 409 with no effect.
Another identity cannot obtain a prior response, lease generation, or completion receipt.
An expired, revoked, replaced, or stale-generation request cannot read replay state.
Keep at most 4096 replay entries per epoch. At capacity, refuse new mutations with 503 before any effect.
Do not evict entries to permit a duplicate effect. This dormant increment needs no disk store.

A successful completion releases only its own current generation.
Retain a terminal receipt so the exact completion replay can return success before its original lease expiry.
That receipt is eligible only while no newer generation exists and the same identity remains valid.
A new acquire invalidates that exception. A stale completion cannot release the newer lease.
Failure completion has the same lease effect and cannot consume mail.
After restart, all old epochs, generations, and replays fail with 409.
A client must get a new snapshot and acquire again. Never resurrect a lease from a local PID.

No mutation in this increment calls an external effect adapter.
No lease state claims coordination with another server process or the local manager lease.
The dependent integration must enforce one active server writer and exclude a local manager before remote acquire.
Do not expose this constructor from `server.main` until those checks and the durable effects pass.

## Acceptance criteria

### AC1: Identity precedes application access

Proof: `bun test --timeout 30000 src/patrol-api.test.ts`, tests named `1ocuv AC1`.
Use real loopback TLS with a fake server certificate, plus direct handler tests.
Allow a valid canonical Patrol token within its time and audience bounds.
Deny missing auth, Bearer worker tokens, arbitrary Patrol tokens, person-certificate-only callers, malformed tokens, and duplicate headers.
Deny not-yet-valid, expired, revoked, wrong-audience, duplicate-record, malformed-record, and rotated-old identities.
Seed a replay entry before each relevant denial. Assert zero replay lookups, metadata calls, catalog calls, CLI calls, and lease transitions.
Identity-provider reads and fixed audit output are the only permitted calls for these denials.

### AC2: Closed grammar and operation allow set

Proof: the same command, tests named `1ocuv AC2`.
Exercise each allowed route, exact body, method, and positive identifier boundary.
Reject every unknown field, wrong type, missing field, oversized body, noncanonical JSON, and malformed key.
Include duplicate JSON fields, encoded separators, traversal, query strings, trailing slashes, and method variants.
Exercise every forbidden operation class above, including worker mail and held-run changes.
Each rejection must cause zero metadata, replay, catalog, CLI, or lease-effect calls.
Use a raw TLS request for target-normalization and header tests; Request alone normalizes some invalid paths.

### AC3: Explicit, scoped metadata projection

Proof: the same command, tests named `1ocuv AC3`.
Allow the authorized rig and deny a second rig with the same run-id shape.
Test absent runs, malformed metadata, more than 1000 rows, and unknown provider fields.
Seed fake secrets in extra fields, nested objects, logs, and free text. None may reach a response or audit line.
Assert response keys exactly, including nested rows. No detailed run reader or general catalog operation may run.
The metadata-provider call is permitted only after identity and request authorization.

### AC4: Lease exclusion and fenced replay

Proof: `bun test --timeout 30000 src/patrol-lease.test.ts src/patrol-api.test.ts`, tests named `1ocuv AC4`.
Test simultaneous acquires, exact retries, conflicting keys, renew, successful completion, and failed completion.
Test expiry at the exact boundary, backwards time, restart, identity rotation, changed rigs, and changed audience.
Test old completion after a new acquire, terminal receipt replay, and replay capacity exhaustion.
Assert one acquire winner, no duplicate transition, and no stale release or renewal.
Invalid identity and stale lease rows must make zero replay lookups and zero downstream effects.
Restart must reject an old epoch even with the old key and a valid token.

### AC5: No activation or mail loss

Proof: `bun test --timeout 30000 src/server.test.ts src/lease.test.ts src/steps.test.ts src/once-cli.test.ts src/server-api-handler.test.ts src/server-api-tls.test.ts src/client.test.ts src/patrol-api.test.ts`.
Name new rows `1ocuv AC5`. Preserve all existing owner and worker-token refusal tests.
Seed patrol mail before failed completion, expiry, restart, and forbidden mail requests.
Assert byte-for-byte equality afterward; this increment must never open the mail state file.
Keep the existing spawn-failure and usage-limit mail-retention checks.
Default server startup exposes no patrol listener and starts no patrol model.
Nonzero `--patrol-every-ms` still fails before server effects. Explicit zero remains valid.
Inspect `git diff origin/main -- deploy src/server.ts src/cli.ts src/once.ts src/lease.ts` for unintended activation or state changes.

### AC6: Complete checks and audit contract

Proof: `bun run test`, `bun run typecheck`, `bun run format:check`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Required CI checks must pass on the final PR head: test, plugin, typecheck, and format.
Audit tests must assert the exact field set and no token, digest, body, free text, or raw error.
Report tool gaps plainly. No AC in this dormant increment is must-see-live.

### AC6 recovery plan after three partial passes

Task `claude-factory-1ocuv.6` remains open. Tasks `.1` through `.5` remain closed.
The AX parent fix retains the separate real-bd test and every test limit.
The remaining gate evidence does not establish a patrol regression.
Do not change patrol behavior to address an unrelated scan-time failure.

Use this order for the next implementation pass:

1. Read task `.6` and its comments. Check the draft PR head and its required checks.
2. Compare the local tools with `.github/workflows/ci.yml`. Use Bun 1.4.4 and Prettier 3.9.9.
3. Run the focused `src/worker-hook-38jm.test.ts` suite without concurrent checks. Record each failed row and its duration.
4. Measure the same rows at `origin/main` in this worktree. Restore only the files that this comparison changes.
5. Select one measured scanner cost. State one hypothesis before a code change.
6. Make one minimal fix. Keep the existing assertions, input sizes, and time limits.
7. Repeat the baseline command. Reject the fix if the target still fails after two attempts.
8. Commit a successful fix before its separate guard mutations. Push before the next task.
9. Repeat the focused home-guard and worker-hook failures from task `.6` in sequence.
10. Merge `origin/main`, then run the complete CI-equivalent gate at the final head.

The full test command must retain `PKGGATE_E2E_REQUIRE=1` and `PG_SCRATCH_REQUIRE=1`.
Use a script in `.scratch/` for these environment variables and the required local tools.
Run the complete plugin check, root type check, format check, audit, and secret scan.
Run `bun run typecheck` separately. Report absent generated mod types as a local input gap.
The CI root type check does not prove the mod type check.
Report failed model downloads separately from tests that execute and fail.
Do not bypass network limits or obtain live credentials for model data.
Do not close `.6` from a focused pass or an older green CI head.
The final report must retain each unresolved local failure and the exact-head CI result.

This plan adds no activation, credential change, scanner bypass, larger limit, or weaker assertion.
It does not authorize a ready report while a required check remains incomplete.

## Test plan and tasks

Write tests before implementation. Use temporary homes and fake credentials only.
Name each new test with its AC number so verify can cite it.
Commit regression tests first; record the pre-fix failures.
A missing module proves only an absent feature. Later mutation checks must prove the security assertions.
After implementation, commit before each `factory mutate` check.
Mutate the identity refusal, unknown-field refusal, generation check, and explicit response projection separately.
Each mutant must compile, and its dedicated test must fail. Record the exact commands and exit codes.
Never push a ready PR with red required checks by design.

1. T1 (`claude-factory-1ocuv.1`): Add AC1 through AC5 tests and fake TLS fixtures. Check the expected pre-fix failures. Budget: 25 minutes.
2. T2 (`claude-factory-1ocuv.2`): Add the closed transport, identity checks, and metadata projection. Pass AC1 through AC3. Budget: 35 minutes.
3. T3 (`claude-factory-1ocuv.3`): Add lease transitions, replay, audit, and compatibility checks. Pass AC4 through AC6 and mutations. Budget: 60 minutes.

T2 depends on T1. T3 depends on T2. Each task is one commit.
The follow-up chain is `claude-factory-1ocuv` → `claude-factory-dnaso` → `claude-factory-76hg1` → `claude-factory-k1c02`.
Use new focused test files beside their modules; reuse existing TLS fixture helpers where possible.
Only `src/server-api.ts` needs a possible shared-parser change; it must remain optional for owner requests.
Update the client API contract with a link to this ADR and the dormant scope in T3.
Do not change the general catalog or broaden `src/lease.ts` for this increment.

## Dependent durable effects

The follow-up must define and implement an atomic effect-and-receipt boundary before it exposes worker mail.
Its allow set adds only scoped worker mail and retained input mail to this protocol.
It must never expose owner actions, starts, held-run mutations, arbitrary files, or shell execution.
Use a server-derived sender, current worker destination, and `wake: false`; reject caller overrides.
Authorize rig, run, station attempt, hold state, identity, and current generation before replay or dispatch.
Fence the effect at its commit, not just before an asynchronous adapter starts.
Persist an effect identifier with the mail event so a crash after effect commit cannot duplicate mail.
Completion can acknowledge only input mail ids from that generation's snapshot.
It must preserve mail that arrived after the snapshot and all mail after model failure, expiry, or stale completion.
Tests must inject crashes before and after each durable write and model failure before completion.
They must prove duplicate effects, restart, overlap, stale completion, and new-mail retention without live credentials.
The follow-up plan must specify exact added JSON fields and persistence paths before implementation.
No required test in this increment depends on that future change.

## Risk

This work is security-sensitive: it adds authentication, untrusted-input parsing, authorization, and lease permissions.
An opaque token permits replay if stolen. TLS, narrow scope, expiration, and revocation bound that risk.
This increment has no durable effect, migration, mail consumption, or production route.
Restart invalidates the in-memory epoch. That is deliberate and safe only while effects remain disabled.
The complete feature needs durable receipts before it can send or acknowledge mail.
Owner certificate behavior and local manager leases must remain unchanged.
The metadata-only view excludes free-text secret sources and accepts only identifiers.
Future free-text views need a separate disclosure review.

Security-sensitive: yes (authentication, authorization, input parsing, remote leases)

## Rollout, rollback, and observability

Ship through a draft PR, required checks, review, security, and a person's merge.
This increment has no activation flag or data migration. Do not change live credentials or manifests.
The dependent integration must land before the isolated runtime can activate.
Rollback uses a revert PR; no state restore is necessary for this dormant code.

Emit a structured audit event for each handled request and lease transition.
Its exact fields are `at`, `operation`, `status`, `reason`, `identity`, `epoch`, and `generation`.
`at` is Unix milliseconds; `status` is the numeric HTTP status.
`operation` is `snapshot`, `run`, `acquire`, `renew`, `complete`, or `unknown`.
`reason` is `ok` or one of the error enum values above.
Use null for unavailable identity or generation. Use fixed enum reasons and fixed operation labels, including `unknown`.
Never include the path, remote token, digest, request body, or raw exception.
Local tests prove this output. Production has no patrol output in this increment because no listener exists there.
The final activation bead must mark a successful isolated patrol step as must-see-live.
That soak must correlate identity, epoch, generation, accepted operation, and completion without credential values.
