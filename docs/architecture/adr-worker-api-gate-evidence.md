# ADR: Finish the worker API with a defined gate

## Context

Run bead: `claude-factory-6odwp`. Original scope: `claude-factory-akiq.9`, T009.
PR: <https://github.com/zach-source/claude-factory/pull/799>.
Plan base: `b01536a08fb62ff97e2af41505ebb0dd37135ced`.

The API code and its regression tests already exist. All four children of this run are closed.
The journal records two API defects: oversized refused rows and tokens that expire or revoke during the queue wait.
The current code fixes both defects. The journal records red tests and killed mutations for these fixes.
Do not repeat those changes or create tests solely to obtain another red result.

The repeated implement passes mixed two requirements: correct API behavior and a complete gate on this particular VM.
The VM could not fetch the semantic model. Several unchanged tests also exceeded time limits or lacked tools.
These observations do not establish an API regression. Earlier reports alternated between CI evidence and a mandatory local gate.
That unresolved evidence rule caused repeated partial reports, main merges, and commits without a source change.

This plan explicitly replaces the local-only part of AC13. It does not waive any test or assertion.
The full CI gate on the final PR head can satisfy AC13. Local focused checks remain necessary.
Do not require another model download or full VM suite solely to repeat the known host gap.

At the plan base, the PR is open and draft. All five CI jobs passed.
The plan read the test job log: 17,983 pass, 0 fail.
Evidence: <https://github.com/zach-source/claude-factory/actions/runs/42850100637/job/129948102523>.
The journal reports 238 plugin passes; the plan independently confirmed the successful plugin job status.
This evidence applies to the plan base, not to a later commit.

No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file was present. The supplied worker rules apply.

## Decision and design

Finish this run as a bounded evidence task. Retain the API design and its existing tests.
This plan changes only this ADR. Implement must update this ADR with final evidence in one commit.
No new production code, dependency, flag, factory definition, changelog, or version change is necessary.

The retained design uses `workerHandler` in `src/server-api.ts` for report, mail, and progress.
`src/tokens.ts` verifies identity. The handler checks token validity before admission and after the queue wait.
The handler uses its own promise chain and the writer lease. It writes a pending row before a downstream command.
Report and mail use the existing CLI with token-derived `FACTORY_FROM` and `FACTORY_RUN`.
Progress writes an applied call row without a CLI call.
`src/server.ts` and `deploy/server.yaml` define the worker listener and key path.
The JSON call store remains the S3 implementation; a Dolt table belongs to S6.

Rejected alternatives:

- Repeat the full suite on this VM: the known model-fetch failure supplies no new API evidence.
- Weaken time limits, skip model tests, or mock the full gate: these options reduce the required evidence.
- Change the worker hook or model network policy: neither change belongs to this run.
- Add an API feature to justify another implement pass: no remaining API defect has evidence.
- Require live Quickstarts before merge: token rollout belongs to `claude-factory-akiq.12` and needs owner steps.

The existing worker, runner, TLS, deploy, client, and docs tests characterize the retained structure.
Do not change `.factory/` or the pinned lifecycle definition to bypass the round cap.

## Acceptance criteria

AC1 through AC12 retain the original behavior requirements. AC13 below replaces the ambiguous local-only gate requirement.
Unless stated otherwise, the named tests are in `src/server-api-worker.test.ts`.
Run them with `bun test --timeout 30000 src/server-api-worker.test.ts`.

| AC    | Required behavior and negative rows                                                                                                                                      | Proof                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| AC1   | A valid report uses only token identity and creates one applied row. Body identity cannot redirect it.                                                                   | `report: applies once with the token identity`                                               |
| AC2   | Same-key retries and concurrent calls apply once. Another body or token gets 409. Pending calls never execute again.                                                     | The five idempotency tests, including `pending after a failed write`                         |
| AC3   | A foreign run, node, or seq gets 403 and a refused row. The runner receives zero calls. Equal optional identity stays allowed.                                           | `identity: a body that names another run, node or seq is refused`; Quickstart 2 test         |
| AC4   | Only a valid station token permits work. Invalid, expired, revoked, manager, and path-unsafe claims stay denied.                                                         | `token: each bad token is refused before any row`; six queue expiry and revocation tests     |
| AC5   | Only the three POST routes without queries pass admission. Bad routes or methods get 404. Bad keys get 400.                                                              | `route: only the three worker routes`                                                        |
| AC6   | The closed grammar below admits valid boundary values. Every malformed body gets 400, a refused row, and zero runner calls. Identity mismatch takes precedence with 403. | Body grammar, byte-cap, UTF-8 limits, and contract-order tests                               |
| AC7   | A missing run, corrupt state, old seq, or wrong node gets 409. No downstream command executes.                                                                           | `station: an old seq or another node is refused`                                             |
| AC8   | CLI refusal returns 409 and replays once. Timeout returns 504 without a fresh-key retry promise. Internal failure returns 500.                                           | `apply: a CLI refusal is a refused row`; real CLI e2e                                        |
| AC9   | Mail records the station sender. Progress records success without a runner call. Invalid text and recipients stay denied.                                                | `mail and progress`; body tests; real CLI e2e                                                |
| AC10  | Lease or corrupt-store failures fail closed. Rows retain seven days of replay protection. Oversized args cannot enlarge refused rows without bound.                      | Store tests, row-size test, pending-write test                                               |
| AC11  | TLS plus the real CLI proves report once, mail identity, and foreign-run refusal. Worker access needs no person certificate.                                             | `src/server-api-worker-e2e.test.ts`; literal Quickstart 2 test                               |
| AC11b | Explicit worker environment replaces person environment. Inherited worker settings cannot leak into isolated fixtures.                                                   | `src/server-api-runner.test.ts`; AX fixture test in `src/ax.test.ts`                         |
| AC12  | Worker flags, port, key path, and manifest remain compatible. Missing or short keys fail. Client routes still require person auth.                                       | `src/server-api-tls.test.ts`, `src/deploy.test.ts`, `src/client.test.ts`, `src/docs.test.ts` |
| AC13  | The final PR head passes the complete CI gate and local focused checks below. No skips or weaker assertions substitute for results.                                      | Final-head CI job URLs, test totals, local command exits, and source SHA                     |

For AC4, each queued report, mail, and progress call must fail with 403 after token expiry or revocation.
Each test must prove no second runner call and no row for the invalid queued call.
The check must precede cached-answer replay as well as new application.

### Closed input grammar

The fail-closed rule accepts only authenticated, current station calls with this exact route and body grammar.
The method is POST. Paths are `/v1/report`, `/v1/mail`, and `/v1/progress`, without queries.
`Authorization` must match `Bearer ([A-Za-z0-9._-]{1,4096})` and pass token verification.
`Idempotency-Key` must match `^[A-Za-z0-9-]{8,128}$`.
The content type is `application/json`, case-insensitive, with optional parameters.
The body is one JSON object, at most 128 KiB in UTF-8.

| Route    | Required keys and values                                                                      |
| -------- | --------------------------------------------------------------------------------------------- |
| report   | `outcome`: `^[a-z][a-z0-9-]{0,63}$`; `summary`: nonblank string, at most 102400 UTF-8 bytes   |
| mail     | `to`: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; `text`: nonblank string, at most 102400 UTF-8 bytes |
| progress | `note`: nonblank string, at most 2000 JavaScript string units                                 |

Each body can also contain `run`, `node`, and `seq`. Each must strictly equal its token claim, including type.
Reject all other fields, missing fields, nested values in required scalar fields, arrays, null, and malformed JSON.
No request field supplies a filesystem path or shell command. Token claims select the internal run state path.
Reject unsafe station claims before that path read. Do not extend this plan into a shell parser.
Unknown mail recipients and report outcomes remain subject to the CLI rules.
FR-006 retains the successful worker-side Beads push requirement, gate refusal, and station outcome rules.
This endpoint does not independently prove a remote Beads push; worker integration remains in `claude-factory-akiq.12`.

Every grammar or identity rejection must make zero downstream runner calls.
Bad authentication and bad admission keys write no row. Authenticated body refusals write bounded refused rows.
Top-level strings in stored args truncate at 500 units. Args above 2048 serialized units become a byte-count object.
This is a per-row bound, not a total file-size or rate limit.
Memory, usage, prompt, person commands, arbitrary routes, and shell grammar are outside this API slice.

### AC13 gate procedure

1. Install dependencies with `bun install --frozen-lockfile`.
2. Run the local focused command below.
3. Run `bun x tsc --noEmit -p .` and `bun x prettier@3.9.9 --check .`.
4. Run `bun build src/cli.ts --target bun --outfile .scratch/worker-api-cli.js`.
5. Run `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD --redact`.
6. Inspect every scan result. The journal identifies one historical example UUID; do not add broad scan exclusions.
7. Commit the ADR evidence and push both the run branch and the existing PR branch.
8. Require successful final-head `test`, `plugin`, `typecheck`, `format`, and `nix` jobs.
9. Read the full test job result through the jobs API. Record totals and the final SHA in the task comment.

```sh
bun test --timeout 30000 src/server-api-worker.test.ts src/server-api-worker-e2e.test.ts src/server-api-runner.test.ts src/server-api-tls.test.ts src/deploy.test.ts src/client.test.ts src/docs.test.ts
```

The full CI test command must retain both required-test variables:

```sh
PKGGATE_E2E_REQUIRE=1 PG_SCRATCH_REQUIRE=1 bun test --timeout 30000 src factories
```

The plugin job runs `claude plugin test mod`. The nix job builds and smoke-tests the CLI.
CI uses Bun 1.4.4 and Prettier 3.9.9. Match the workflow tools for any full-suite reproduction.
CI intentionally omits `tsc -p mod`; its generated Claude types are absent in unattended sessions.
Report that gap explicitly. A successful root typecheck does not prove a mod typecheck.
Do not claim that old CI proves a new head. Do not create an empty commit merely to request another gate.
After the evidence commit, place final CI results in Beads and the report to avoid another evidence-only commit cycle.
An actual test failure needs diagnosis; a green status alone cannot dismiss a new functional failure.

## Test plan

No new behavior or parser is necessary. Existing red-first tests already cover the two security defects.
Retain the six queue tests and the oversized-row test. Retain every original assertion and limit.
If a new defect appears, first add a minimal failing test for that defect, then fix it in a separate commit.
Do not expand this pass into unrelated host repair. Record a precise external gap if the required CI cannot finish.
Apply the brief's runner-loss rule only when job evidence meets its definition.

## Risk

The retained code is security-sensitive: worker token auth, untrusted JSON, permission checks, and state writes.
Review and security must assess the source delta since their last reviewed SHA, especially the queued-token recheck.
This ADR adds no runtime behavior or migration. Exact-head CI cannot prove live token injection or secret installation.
The JSON store has seven-day retention and bounded args, but no total-row cap.
Pending rows prevent duplicate application after ambiguous failure; they do not promise automatic crash recovery.
The existing outbox remains available. No new made-worse defect has evidence in this plan.
Security-sensitive: yes (worker token auth, input validation, permissions, run state writes)

## Rollout and rollback

Keep PR 799 draft through implement and verify. Only the authorized approval stations can mark it ready.
A person must merge it. Do not create another PR or change branch protection.
The run branch is `factory/lifecycle-mwar7flxgl`; the PR branch is `factory/lifecycle-mwa2tteiqn`.
Push the same commits to both branches without a force push. Merge current main before the implement push.

The server uses `--worker-port 8443 --worker-key /etc/factory/worker-key/key`.
Before deployment, the owner must provide `factory-worker-key` with at least 32 bytes.
The owner command is `kubectl -n factory create secret generic factory-worker-key --from-file=key=<worker key file>`.
Do not execute it without the exact owner approval. This plan does not authorize deployment or a live read.
Worker launch, token injection, revocation lifecycle, and live Quickstarts remain in `claude-factory-akiq.12`.
The progress stall integration remains in `claude-factory-g34ko`. Memory and usage endpoints remain sibling work.

No migration is necessary for this evidence task. Preserve call rows and token records during any later rollout.
Rollback uses a normal revert PR and a person merge. Never delete the call store to clear pending results.
Do not retry an uncertain report with a new key. That can duplicate an applied report.

## Observability

For this run, evidence consists of handler tests, real TLS/CLI tests, and exact-head CI logs.
The server emits worker route, station, status, and applied/refused results. Call rows provide replay evidence.
Do not expose tokens, auth headers, summary bodies, or raw secret material in reports.
No AC in this run is must-see-live. Do not claim production health from these tests.
The later integration soak must see its own Quickstart report, foreign-run refusal, and same-key replay without a second application.
That live proof belongs to the integration run after owner setup. This plan performs no production read.

## Tasks

The four existing run children remain closed. Their source fixes and suitable-host evidence remain valid at their recorded SHAs.
Task `claude-factory-6odwp.5`: finalize AC13 evidence and hand off to verify, review, and security.
It has no dependency on an open source task. Allow one implement pass of at most 120 minutes.
Its one commit updates this ADR with local results and any precise gaps.
After that commit, the child comment records final-head CI evidence; no further source commit is necessary.
Check AC1 through AC13 with the commands above. Close the child only after all required results pass.
Do not close the run bead. Comment on `claude-factory-akiq.9.12` with this explicit AC13 disposition.
