# Implementation Plan: Factory product and harness-independent manager

**Branch**: `codex/006-factory-product` | **Date**: 2026-10-29 | **Spec**: [spec.md](spec.md)

**Status**: Planned; implementation, deployment, and live qualification have not run. The user authorized planning and creation of Beads, not release or cutover.

**Beads epic**: `claude-factory-aya5` — 42 owner-held implementation tasks; Beads is authoritative for status and dependencies.

## Summary

Extend the existing TypeScript/Bun factory with a persistent service, a standalone browser client, and harness-independent manager jobs. Preserve xstate, the existing lifecycle templates, Beads, memory, worker guards, and the herdr/AX runner boundary. Extract reusable operations from the CLI rather than invoking its shell command parser from HTTP handlers.

Server work continues the unimplemented S2-S7 parts of spec 004 under this feature's graph. S0-S1 are not recreated. S8 (task SVIDs) remains an external future capability; signed per-task identity is sufficient for the first release. Existing spec 005 work supplies metric calculations and server integration. No second metric engine is planned.

## Technical Context

- **Language/version**: TypeScript 5 on the existing Bun 1.3.13 baseline. Browser code uses standard HTML, CSS, and DOM APIs compiled with the existing Bun bundler. Keep explicit `tsc` checks; bundling is not a type check.
- **Dependencies**: Existing xstate, Bun, Beads, git, AX and harness CLIs. No new application framework, ORM, global state library, or SDK. Add a pinned Envoy sidecar for owner TLS validation because the recorded Bun TLS spike failed wrong-CA rejection. Add Playwright only as a development dependency for repeatable browser, certificate, focus, and reconnection checks that unit tests cannot cover; pin its tested version and browsers in the setup task.
- **Storage**: Existing file home in local mode; 004's dedicated Dolt factory database for production server state, with memory Markdown and repository/worktree data on persistent storage. Temporary file-backed server prototypes are not product release candidates. Backups must cover both database and file artifacts.
- **Testing**: Bun unit/contract tests; existing CLI, factory, and plugin suites; isolated Dolt integration and real TLS rejection fixtures; Playwright end-to-end tests; separately authorized AX qualification. Never use the live factory as a unit-test fixture.
- **Platforms**: Linux AX server and workers; desktop Chrome/Chromium on macOS and Linux for the initial browser qualification; existing macOS local CLI/plugin behavior retained. Other browsers are not claimed supported until tested.
- **Performance/reference setup**: 10 projects, 50 active run projections, 1,000 retained runs. Initial reference service: 2 vCPU/4 GiB; database: 2 vCPU/4 GiB; external workers have separate capacity. This is a test setup, not a capacity guarantee. Measure spec SC-005 before changing sizing or adding caches.
- **Scope**: Single operator, multiple clients, five main views and persistent chat. Server workers remain AX-only. Local herdr/AX operation stays supported.

## Constitution Check

| Gate | Before research | After design |
| --- | --- | --- |
| One source for worker rules and skills | Existing `src/worker-system.md`, `src/harness.ts`, and worker image identified | Harness qualification compares effective rule/skill manifests for each supported combination; no browser-only configuration can bypass this. |
| Required tools reach every selected worker | Existing refusal behavior must be preserved | Capability resolution fails closed. Manager steps receive their own least-privilege manifest, not a privileged worker profile. |
| Changes reach all backends/runners or gaps are tracked | Known constitution gaps are not assumed resolved | Beads includes parity qualification and links the existing Pi parity issue as a dependency; local regressions remain mandatory. |
| No unsupported permission widening | Owner identity remains distinct | Owner certificate is never mounted into agents; remote manager jobs run in AX with scoped identity and no server-state mount. |

Design passes these gates without a constitution exception. Runtime capability and authorization qualification remain release gates, not claims made by this plan.

## Project Structure

Documentation delivered here: `plan.md`, `research.md`, `data-model.md`, `contracts/control-api.md`, `contracts/harness.md`, `contracts/operator-ui.md`, and `quickstart.md`. `spec.md` remains the product requirement baseline. Beads holds tasks and dependencies; no `tasks.md` is maintained.

Proposed source paths below are implementation targets, not claims that the files already exist:

```text
src/core.ts                    # extracted typed operations; cli remains a compatibility adapter
src/server.ts                  # independent loop, listener lifecycle, readiness
src/server-api.ts              # typed HTTP validation and role dispatch
src/client.ts                  # existing CLI/plugin server-mode client
src/tokens.ts                  # scoped worker and manager identities
src/commands.ts                # durable command acceptance and reconciliation
src/owner-auth.ts               # trusted certificate identity, origin and revocation checks
src/store/                     # Dolt transaction, lease, migration and backup support
src/harness.ts, src/worker.ts   # reuse launch/resume/parsing and worker guards
src/harness-profile.ts         # capability resolution and immutable effective config
src/steps.ts, src/steps/*.md    # shared prompts and bounded manager-job lifecycle
src/project-config.ts          # readiness and lossless project edits
src/product-queries.ts         # read-only projections, pagination, evidence freshness
src/budgets.ts                 # accounting coverage and admission policy
src/migrate.ts, src/homebackup.ts # reuse and extend backup/cutover behavior
web/index.html, web/app.ts, web/styles.css
web/api.ts, web/views/          # native DOM views and a shared typed client
web/tsconfig.json              # DOM lib, no server imports
web/tests/                     # browser scenarios and fixture client
src/product-*.test.ts           # service, recovery, authority and capability tests
hack/product-check.ts           # deterministic fixture scenarios and evidence output
hack/product-soak.ts            # explicitly enabled live qualification recorder
Dockerfile.server, deploy/server.yaml, deploy/owner-proxy.yaml
```

Reuse the pure grouping and presentation logic in `mod/hooks/view.ts` after moving only browser-safe parts to a shared module. Do not import `claude-code` or Node/Bun I/O into the browser. Keep `mod/hooks/views.tsx` as the local-mode view adapter. Exclude `web/` from the server tsconfig and check it with its own configuration. Use ordinary DOM modules, not a new generic component framework.

## Architecture and ownership

### Service foundation

`src/core.ts` exposes validated operations independent of CLI parsing. Only the service loop owns scheduling in server mode; reading a board never ticks or launches anything. Existing CLI commands remain valid and select local execution or `src/client.ts` using the established server configuration. The plugin disables its timers in server mode and becomes a read/action client.

Dolt transactions commit the command record, state revision, events, and pending effect intent together. A fenced lease prevents competing server writers. External effects run after commit and use a stable attempt/job identity; uncertain responses are reconciled before retry. SQL row-lock/conditional-update behavior and affected-row reporting must be qualified against the pinned Dolt version, not assumed from the basic SQL spike.

The service must not promise exactly-once delivery of arbitrary remote side effects. It guarantees durable accepted intent, duplicate request detection, and conservative reconciliation. Unknown launch or cancellation holds replacement. A successful HTTP receipt is distinct from completed execution.

### Owner and agent boundaries

Owner traffic terminates mTLS in Envoy using the owner CA, required client certificates, and sanitized single-certificate forwarding. The owner application listener binds loopback inside the service pod and is not exposed by a Service. The sidecar supplies the verified certificate fingerprint; the application maps it to an enabled owner principal and checks revocation on every request. Worker/manager listeners never accept this forwarded identity. Do not use the failed Bun `requestCert` path or handwritten HTTP framing over `node:tls`.

The browser and owner CLI share the authenticated origin. Mutations require JSON, a custom intent header, idempotency key, and current state revision. Browser Origin must match exactly; deny cross-origin preflight and cross-site Fetch Metadata. No cookie or bearer token is put in JavaScript storage. Operator certificate installation remains an explicit provisioning prerequisite.

Manager judgment and chat tool execution run as isolated AX jobs with role-scoped tokens, restricted egress, a bounded tool manifest, and no owner key, database password, scheduler credentials, or server volume. They may propose owner decisions but cannot answer them. The service schedules and records jobs; the harness never owns scheduling or permission policy.

### Harnesses and manager jobs

Keep harness and runner separate. Extend the existing harness helpers into explicit capabilities rather than replacing their guards. Claude and Codex manager calls use the CLI paths already evidenced in `src/worker.ts`; exact binary versions, flags, auth modes, and output parsers are verified in fixtures. Do not infer subscription/API entitlement or pricing from a model name. Use configured credential references, one shared prompt source, and the durable context bundle.

Project/station precedence is resolved when a run starts. Each attempt records the actual settings and content digests. Changing defaults affects later runs, not an in-flight captured configuration. An explicit harness switch is cancellation, confirmed reconciliation, then a new linked attempt with a redacted handoff. Same-harness native resume is available only if its adapter passes qualification.

### Browser and queries

Serve bundled static files from the authenticated owner origin. Use the 004 `/v1` query surface and resumable SSE events, with a bounded 2-second conditional-poll fallback while connected. Events invalidate projections; they are not another source of truth. On stream/cursor loss fetch a snapshot. Show stale after 15 seconds without a successful freshness check. Preserve focused inputs and unsent drafts across rendering; never auto-submit drafts on reconnect.

Render external text with `textContent`; link only validated `https` URLs or authorized local artifact routes. No raw transcript HTML, arbitrary Markdown HTML, external scripts, or source text in support exports by default. Native form labels, focus order, live regions, and explicit loading/error states are acceptance requirements.

### Budgets and metrics

Use existing usage parsers and spec 005 calculations. Record absent usage as unknown. Admission checks factory and project budgets in one serialized transaction, including retries and manager jobs. Monetary enforcement requires a supported, versioned accounting basis; absent coverage holds affected admissions. In-flight work can exceed admission limits and this is displayed. Use the configured IANA timezone for calendar-day reset, including DST; persist the resolved window boundaries.

Metric calculations, attribution, dream-metric proposals, and server-mode metrics remain owned by the existing `claude-factory-fc80` graph. The product integrates those APIs and retains merge-based metric labels separately from runtime delivery evidence.

## Delivery and dependency strategy

### Setup and foundation

Record explicit owner disposition of 004 S2-S7 and the revised TLS/isolation design before implementing that server scope. The present request only authorizes this plan and task creation. Build isolated contract fixtures independently. Extract core operations, add the Dolt command/lease store, role-scoped transport, worker delivery, server recovery, and CLI/plugin compatibility. The existing closed S0-S1 epic is evidence to reuse, not a blocker that falsely proves the server complete.

### Independently testable story slices

- **US1**: project readiness/configuration, browser shell, and onboarding using fixture services before live integration.
- **US2**: disconnected-client and restart/ambiguous-effect qualification over the service foundation.
- **US3**: capability registry, parity, credentials, harness switching, and the four manager-worker combinations.
- **US4**: read projections/events and run steering with acknowledged versus completed command states.
- **US5**: atomic versioned decision service and decision inbox; identity tests precede owner action UI release.
- **US6**: common prompts, bounded isolated manager jobs, chat commands, and durable attention acknowledgments.
- **US7**: accounting/budgets, existing metric integration, evidence presentation, and existing proposal review.
- **US8**: image/installation health, migration/rollback, compatibility, diagnostics, and owner-provisioned test deployment.

Accessibility/load, usability, security, CI/mode regression, and seven-day qualification are separate cross-cutting acceptance work. Story fixtures may use mocked providers, but every live qualification result is explicitly marked as such.

### Existing external dependencies

At planning time `claude-factory-fc80.5` (DORA), `.15` (quality CLI), `.28` (server metrics), and `.27` (dream cites metrics) are open. The corresponding product integration tasks depend on those exact issues; do not recreate them or claim their workers. `claude-factory-hg9o` is the existing Pi parity issue and blocks product parity qualification until its result is verified. Recheck status at implementation time; a closed issue still needs the actual merged capability and test evidence.

No live implementation is dispatched by this planning run. Pre-create the epic and task records with `owner` labels before reconciliation so the autoqueue cannot pick up an incomplete graph. The reconciler preserves these human labels. Preserve existing tasks/owners and add only the named external blocking edges. Owner-controlled provisioning and production cutover are distinct gate tasks with recorded evidence, not inferred approvals.

## Rollout and recovery

Development first uses isolated fixture homes and a disposable Dolt database. Server-mode qualification requires separately authorized test infrastructure. Transfer ownership only after stopping/draining the source and reconciling active attempts; record database and file backup revisions before cutover. Retain a read-only source backup.

Rollback is a reconciliation operation, not copying an old home over newer state. Stop admissions, identify all post-cutover commands/effects, reconcile live workers and external delivery, export current accepted state to the target format, and acquire scheduling ownership only once. Reject incompatible downgrade until a compatible restore/reconciliation path exists.

Do not deploy with lost accepted operations, duplicate workers, identity bypass, missing required capabilities, or failed rollback rehearsal. Record source, publication, deployment, and qualification separately. Production rollout needs its own owner gate after test evidence; seven-day soak and final acceptance follow that authorized target selection.

## Validation and complexity

See [quickstart.md](quickstart.md) for deterministic and live evidence requirements. All SC-001–SC-010 are represented in Beads. CI must retain existing local tests and add server, browser, TLS and store checks. Formatting and type checks cover server and browser separately.

The only new tools are Envoy for a proven TLS boundary and Playwright for real-browser acceptance. Both address failures unit tests cannot establish. No new framework or ORM is justified. Database tables, command intents, and role adapters are required by durability and identity requirements, not general-purpose extensibility.
