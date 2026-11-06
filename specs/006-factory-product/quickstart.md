# Quickstart validation: Factory product

## Status and prerequisites

This is the acceptance runbook for the planned implementation. Commands under “Planned checks” are contracts for the implementation tasks to supply; they do not exist yet and must not be reported as passed now. Current documentation checks are runnable today. Use a disposable repo/home/database and test identities. Do not point fixture scripts at the live factory.

Reference prerequisites: Bun 1.3.13, repository dependencies, isolated Dolt service with the implementation-pinned version, the pinned Envoy test image, pinned Playwright/browser dependencies, and fixture certificates generated outside the repository. Live checks additionally require an owner-authorized AX test namespace, test repositories/Beads ownership, profile credentials and spending limits. Never print provider credentials or add them to fixtures.

## Current documentation checks

From the repository root:

```sh
bun run typecheck
bun test src/docs.test.ts
bunx --no-install prettier --check specs/006-factory-product
python3 .specify/extensions/beads/scripts/beads_tasks.py --help
bd dep cycles
```

These validate repository/documentation context, not the future product. Inspect the Beads epic for the implementation dependency graph; no Markdown task list is authoritative.

## Planned checks

Implementation adds `web:build`, `web:test`, `product:check`, and `product:soak` package scripts. `product:check --scenario <name>` invokes `hack/product-check.ts`, allocates its own temporary home and database namespace, runs the named deterministic fixture, and writes a redacted JSON evidence report. It refuses live factory paths and never applies cluster manifests. Reports contain code revision, component versions, fixture identities, scenario, observations, PASS/FAIL/NOT_RUN, and evidence paths.

```sh
bun run web:build
bun run web:test
bun run product:check --scenario ownership-recovery
bun run product:check --scenario command-authority
bun run product:check --scenario harness-matrix
bun run product:check --scenario ui-workflows
bun run product:check --scenario usage-budgets
bun run product:check --scenario migration-rollback
bun run product:check --scenario compatibility
```

### Q1 Ownership and recovery

Close every client for one hour while a deterministic workflow advances at least three stations. Inject service restart before/after command commit, after remote launch but before response, during cancellation, and with a second writer. Verify one owner, stable attempt task IDs, zero lost accepted operations, zero duplicate reports/effects, no overlapping replacement, and visible unknown-state holds. Use real Dolt connections to test fencing/locking. Proves SC-002 and FR-005–009.

### Q2 Identity and decisions

Exercise no certificate, wrong CA, expired/revoked certificate (including existing connections and streams), forged XFCC, direct listener access, worker/manager owner operations, cross-run reports, stale/opposite answers, changed idempotent bodies, origin/preflight/form attacks, and seeded secret outputs. Verify refusal and no state change, with one answer only for a current authorized decision. Proves SC-004 and the security portion of SC-009.

### Q3 Harness matrix

Run all four Claude/Codex manager-worker combinations against fixture adapter outputs, then explicitly authorized live profiles. Include gate, retry, service restart, mixed station defaults, native resume, cross-harness handoff, quota/credential errors, wrong output schema and unsupported required capabilities. Verify role isolation and parity manifests. Repeat local herdr/AX and Pi compatibility checks. Label fixture results separately from live results. Proves SC-003; no deliberate quota exhaustion.

### Q4 Browser operation and usability

Use Playwright with the test client certificate to connect a prepared repo, select/create a Beads item, inspect effective settings, start, message, pause/resume, retry, abort, decide, and inspect command/evidence history. Disconnect/reconnect while editing and while another client changes the target; drafts persist without replay. Malicious text is inert. Verify keyboard/focus at 1280/768 widths and 200% zoom; perform a separate real screen-reader review.

Five representative operators then complete onboarding and blocker/evidence tasks. Record each time and outcome against SC-001/SC-006, not an invented average. Load 10 projects/50 active/1,000 retained runs and measure p95 usability <=2 seconds, state visibility <=5 seconds, stale indication <=15 seconds. Proves SC-001, SC-005, SC-006 and accessibility in SC-009.

### Q5 Usage, budgets and proposals

Replay reported/estimated/unknown usage and duplicate cumulative events. Verify exact fixture totals, no unknown-as-zero cost, factory+project budget enforcement across workers/retries/manager jobs, DST/window reset, holds on missing accounting, and available pause/abort/decision controls. Load spec 005 metric fixtures and confirm its definitions and evidence labels. Install/reject an existing owner-only memory proposal through the authorized path and refuse that owner-only action from a manager token. Proves SC-007 and FR-026–031.

### Q6 Migration and compatibility

Preview migration without changing source state. Back up database plus file revisions, drain source, transfer ownership, and restore continuity with active/held runs. Interrupt each boundary and attempt a second owner. Produce a post-cutover accepted effect, then roll back by reconciling it rather than restoring blindly. Compare all IDs, accepted reports, decisions and links. Test incompatible client/schema rejection, source history preservation, and existing local suites. Proves SC-008 and FR-035–037.

### Q7 Authorized deployment and soak

Only after the test-infrastructure gate is closed with owner evidence, apply the reviewed manifests to the named test namespace and verify rollout using the repo's deployment procedure. Record readiness and actual versions. A separate owner gate selects and authorizes any production cutover; test authorization does not cover production.

After explicit target authorization, the planned command is:

```sh
bun run product:soak -- --target <approved-target> --approval <recorded-owner-reference> --days 7
```

The recorder verifies the target against the approval record, does not provision infrastructure or grant itself authority, and captures transitions, duplicate/lost-operation counters, manager failures, outages, interventions and delivery evidence. Required injections use the authorized fixture scope. Missing duration or instrumentation yields NOT_RUN, not PASS. Zero lost accepted operations/duplicate attempts and continuing controls through manager failure are required for SC-010.

## Stop conditions and evidence

Stop new admissions on any duplicate worker, lost accepted state, identity bypass, missing required capability, accounting-policy breach, or failed rollback. Preserve evidence and current ownership; do not auto-resume held work. Reports distinguish source completion, publication, deployment and qualification. An implementation task closes only with its specified check; the release acceptance task remains open until all required live evidence exists.
