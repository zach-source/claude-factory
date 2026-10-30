# Research: Factory product

**Date**: 2026-10-29. Findings below distinguish inspected code, prior recorded experiments, and decisions requiring implementation qualification.

## R1 Existing server work

**Decision**: Continue 004 S2-S7 in the new graph; preserve local mode and defer SVID adoption.
**Evidence**: Read the 004 spec, plan, research and contracts from [PR #318](https://github.com/zach-source/claude-factory/pull/318), plus `specs/004-factory-server/spikes.md` and the current `claude-factory-xbzd` record. Only S0-S1 were explicitly approved; its closed status does not mean S2-S8 shipped. The design's later two-mode decision supersedes the epic's older note about retiring herdr.
**Rationale**: Reusing the foundation avoids a second server while respecting the existing owner scope.
**Alternatives**: Treating the closed epic as a complete server would skip required implementation and qualification. Restarting S0 duplicates completed experiments.

## R2 Browser implementation

**Decision**: Standard DOM/HTML/CSS modules and the installed Bun bundler; no frontend runtime framework. Extract only browser-safe pure console models.
**Evidence**: `package.json` has Bun types, TypeScript, Prettier, xstate and the existing transformer dependency; it has no standalone React renderer. `mod/hooks/register.tsx` imports the Claude plugin host, while `mod/hooks/view.ts` contains reusable pure view calculations. [Bun's bundler documentation](https://bun.sh/docs/bundler) documents TypeScript/browser bundling; retain Bun 1.3.13 and prove the needed subset locally rather than upgrading to match current docs.
**Rationale**: Five views and explicit server-owned state do not require a second application platform. Native controls support accessible forms and decisions.
**Alternatives**: Next.js/React add a new runtime and migration burden; rendering the Claude plugin in a browser is not supported by the existing code. A homegrown generic component framework is also out of scope.
**Validation**: A temporary TypeScript DOM entry bundled successfully with the installed Bun 1.3.13 using `bun build --target browser`; this proves the chosen build subset, not browser behavior. Browser interaction, focus preservation, SSE recovery, and accessibility need Playwright fixtures and manual assistive-technology checks. Add Playwright as a pinned development dependency for these checks, not production.

## R3 Owner identity and TLS

**Decision**: Preserve owner client certificates but terminate them in a pinned Envoy sidecar; serve UI and owner APIs from one authenticated origin. Use verified certificate fingerprints mapped to enabled operator principals on every request.
**Evidence**: Recorded S0d on Bun 1.3.13 accepted a wrong-CA certificate. Its `node:tls` workaround verified the peer, but HTTP framing on top was not proven. Envoy documents [trusted CA validation](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/transport_sockets/tls/v3/common.proto) and [sanitized client-certificate forwarding](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/headers#x-forwarded-client-cert). Configure required client certificates and an explicit CA; defaults alone do not establish the boundary.
**Rationale**: A standard TLS/HTTP proxy avoids both the observed bug and writing a custom protocol parser. This adds a deployment component, justified by a demonstrated failure.
**Alternatives**: Bun mTLS fails the recorded acceptance case. Handwritten framing over `node:tls` increases protocol risk. New OIDC/account management expands the single-operator scope and changes the existing identity decision.
**Validation**: Pin and test the actual image version; wrong-CA, no-cert, expired, revoked, forged forwarding, direct-listener, origin, and keep-alive-after-revocation cases must fail. No claim of deployed validation is made here.

## R4 Durable commands and external effects

**Decision**: Dolt transactions hold state revisions, command deduplication, events, effect intents and writer fencing. External effects use stable attempt/job IDs with inspect-before-retry reconciliation.
**Evidence**: S0b proved basic `Bun.SQL` reads, writes and transactions against Dolt 2.6.0. It did not prove lock semantics, failover, or remote side-effect atomicity. Existing `src/runner.ts` separates launch/info/deliver/close but does not make external operations transactional.
**Rationale**: Durable intent plus conservative reconciliation handles lost responses without pretending arbitrary side effects are exactly-once.
**Alternatives**: UI-owned scheduling and file writes in multiple processes violate the product requirement. An event-stream platform or new ORM adds no necessary capability at this scale.
**Validation**: Two real database connections, forced crashes, affected-row/lock tests, stale fencing, ambiguous launches and delayed old reports; unknown termination must hold replacement.

## R5 Harnesses and credentials

**Decision**: Extend existing argv/output adapters and guards with versioned capability profiles. Use Claude/Codex CLIs, not new provider SDKs. Pin actual qualified versions during implementation; models are configured profile values, not hard-coded current recommendations.
**Evidence**: `src/harness.ts` defines Claude/Codex/Pi detection, resume/MCP behavior and Codex guard checks. `src/worker.ts` implements `turnArgv`, `sessionIn`, credential-home validation, and quota parsing. These are source evidence of current repo integration, not proof of all future CLI versions or account entitlements.
**Rationale**: Reuse known integrations while making unsupported features explicit. Do not infer account/auth state from configuration files or memory.
**Alternatives**: A generic arbitrary command profile hides required capabilities. Moving to API-only SDKs changes the existing credential/billing choice.
**Validation**: Captured redacted output fixtures plus explicitly authorized live checks; verify guards and the exact installed binary. Preserve Pi worker behavior and resolve the existing `claude-factory-hg9o` parity issue before product qualification.

## R6 Manager authority

**Decision**: The service schedules bounded manager jobs in isolated AX tasks. Jobs get a role-scoped token, narrow egress and tool manifest, shared prompts and a context bundle, not server persistence or owner credentials.
**Evidence**: Current management in `mod/hooks/register.tsx` uses Claude-host agents and timers; `src/worker.ts` provides existing headless execution machinery. Worker guards alone do not make a colocated agent safe to read the service's files and keys.
**Rationale**: Server authorization must be independent of an LLM's compliance with a prompt. Deterministic scheduling remains available during manager failure.
**Alternatives**: Running arbitrary manager tools inside the state-owning pod creates a path around the owner API. Passing the owner's browser identity to chat makes forged approval text consequential.

## R7 Metrics, memory and task ownership

**Decision**: Reuse spec 005 calculations and spec 003 proposals; new work supplies presentation and admission control only. External dependencies are `claude-factory-fc80.5`, `.15`, `.28`, `.27`, and Pi parity `claude-factory-hg9o`.
**Evidence**: Live Beads inspection shows these issues open; no existing managed `006-factory-product` implementation graph exists. The closed specification-authoring task is not an implementation task and must stay closed. `src/autoqueue.ts` treats `owner` as held.
**Rationale**: Explicit cross-feature edges retain the existing owners and avoid duplicate work. All newly planned records carry `owner` before becoming visible to autoqueue; no implementation is launched by graph creation.
**Alternatives**: New metrics tasks duplicate active work; relying on epic closed status hides unfinished server integration.

## R8 Migration and release

**Decision**: Rehearse exclusive ownership transfer and rollback using consistent database plus file snapshots; reconcile accepted post-cutover effects before any rollback. Require a separate deployment gate and seven-day live evidence.
**Rationale**: A stale snapshot cannot safely replace current external state. Unit-test success, source merge and live qualification are different milestones.
**Alternatives**: Copying the old home back loses accepted operations; automatic migration on upgrade violates the explicit mode boundary.

## Research disposition

No unresolved product choice blocks the plan. Remaining validation items are explicit implementation/qualification tasks: database locking, exact harness and proxy versions, owner certificate installation, real credential compatibility, browser accessibility, reference load, and live AX recovery. They are not marked proven by documentation review. Owner-controlled infrastructure and cutover remain separate gates.
