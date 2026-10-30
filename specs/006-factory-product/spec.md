# Feature Specification: Factory product and harness-independent manager

**Feature Directory**: `006-factory-product`

**Created**: 2026-10-29

**Status**: Draft — specification only; implementation and deployment are not authorized by this document.

**Tracking**: `claude-factory-09lo` tracks specification authoring only. Implementation work belongs in Beads after planning.

**Input**: User description: "consider how to build the manager ui and interface to run the factory with claude, codex or other harnesses if so choose; basically extend our idea to be more of a product", followed by "let's create a spec to represent the entire work".

## Product intent

Factory lets an operator give repositories goals, run agents against work, resolve decisions, and verify what shipped. The operator chooses the manager harness independently from the workers. The factory continues operating when the operator closes the browser or chat.

This specification covers the complete first product release: service foundation, user interface, harness support, installation, migration, and qualification. The initial audience is one operator managing several repositories in a self-hosted installation. Team collaboration and a hosted multi-tenant service are outside this release.

Without reading a terminal transcript, the operator should understand what is working toward their goals, what needs a decision, what is blocked, which agents are doing the work, and what was delivered with what evidence and usage.

## Existing work and scope boundaries

| Existing work | Relationship |
| --- | --- |
| [004 factory-server design, PR #318](https://github.com/zach-source/claude-factory/pull/318) and [local spikes](../004-factory-server/spikes.md) | Own server communication, durable state, independent scheduling, identity, and cutover. Reuse this foundation; add a standalone interface and selectable manager harnesses. |
| `claude-factory-xbzd` | Beads records S0-S1 as shipped via PR #377. Owner approval was limited to S0-S1. The closed epic does not establish completion, approval, or runtime qualification of S2-S8. |
| [002 multi-factory Beads](../002-multi-factory-beads/spec.md) | Owns factory identity and shared-work claims. Multiple product clients must not become competing factories. |
| [003 memory lifecycle](../003-memory-lifecycle/spec.md) | Owns memory retention and learning proposals. Expose its review workflow, without a second memory system. |
| [005 delivery and quality metrics](../005-factory-metrics/spec.md) | Owns definitions, attribution, calibration, and reports. Integrate its outputs without recalculating different UI metrics. |
| [Existing console](../../docs/console.md) | Supplies established board, backlog, mail, projects, PR, and interview behavior to carry forward. |
| [Worker parity constitution](../../.specify/memory/constitution.md) | Required skills, rules, and tools must reach every selected worker or the configuration must be refused. |

The full 004 specification is on its design branch, not in this checkout. Its explicit two-mode decision preserves local mode with herdr and AX, while server mode runs AX workers. This product preserves that boundary. It does not retire local mode or require herdr execution in server mode.

This specification extends 004's Claude-only manager steps to selectable harnesses and its plugin-first console to a standalone browser interface. Claude remains a supported default. Existing credential and owner-identity decisions remain the baseline. Browser identity and other harness credentials require concrete design during planning; selecting a harness must not silently change billing source or permissions.

Creating or accepting this specification does not approve cluster changes, identity provisioning, state migration, cutover switches, or S2-S8 of the server plan.

## Product surfaces

| Surface | Purpose |
| --- | --- |
| Overview | Prioritize decisions and blocked work; show active work, capacity, health, and recent delivery evidence. |
| Projects | Connect repositories, set goals, inspect backlog, configure defaults, and see readiness. The UI calls a rig a project; existing CLI names remain valid. |
| Work | Follow stations and attempts; inspect evidence, reports, messages, and PRs; steer and recover runs. |
| Decisions | Answer actionable questions with context, evidence, options, consequences, and durable answer history. |
| Settings | Configure harnesses, models, credential references, execution environments, permissions, budgets, and installation health. |
| Manager chat | Explain state and request actions from any view, with links to resulting work and decisions. Conversation is not the sole record of state or authority. |

Metrics appear in project and overview detail. Memory and skill proposals appear in Decisions. Mail remains accessible from Work and chat. Layout can change during design, but these workflows must remain discoverable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a project and start useful work (Priority: P1)

An operator connects a repository, chooses an existing lifecycle template, sets a goal, and starts a work item without editing internal files.

**Why this priority**: First use must not require knowledge of factory internals.

**Independent Test**: On a fresh installation with infrastructure and credentials provisioned, use only the UI to connect a repository, select or create a Beads item, and start a run.

**Acceptance Scenarios**:

1. **Given** a repository and credentials, **When** it is connected, **Then** readiness checks cover repository access, Beads and ownership, capacity, harness availability, and required tools, rules, and skills; each failure has a next action.
2. **Given** a ready project, **When** the operator starts a work item, **Then** effective harness, model, runner, goal, and limits are visible before submission, and the acknowledged command links to one run and work item.
3. **Given** a missing prerequisite or conflicting factory ownership, **When** start is requested, **Then** admission is blocked with a reason; dependencies are not silently installed or initialized and ownership is not bypassed.
4. **Given** an existing template and advanced configuration, **When** project defaults are edited, **Then** validation preserves unrepresented settings and explains when changes take effect.

### User Story 2 - Keep the factory running independently (Priority: P1)

The operator closes all clients. The service continues scheduling, accepting reports, supervising workers, and running bounded manager jobs.

**Why this priority**: Availability must not depend on a conversation or browser window.

**Independent Test**: Run a deterministic multi-station fixture for one hour with all clients closed; restart the service and reconnect.

**Acceptance Scenarios**:

1. **Given** capacity and eligible work, **When** every client disconnects, **Then** scheduling and at least three station transitions proceed without a manager chat turn.
2. **Given** an acknowledged operation or lost response, **When** the service restarts and the client retries, **Then** accepted state survives and the same effect is not applied twice.
3. **Given** two service instances or an uncertain launch, **When** recovery runs, **Then** only one instance owns mutations and no replacement launches until predecessor ownership and execution state are reconciled; uncertainty appears as a hold.
4. **Given** unavailable durable storage, **When** a mutation arrives, **Then** it is not acknowledged as committed and new work is held until state can be recorded safely.

### User Story 3 - Choose manager and worker harnesses separately (Priority: P1)

The operator chooses Claude or Codex for management and independently chooses worker harnesses and models by project or station. Other harnesses become available after capability qualification.

**Why this priority**: Harness choice is central to the product, not a shell-command workaround.

**Independent Test**: Run one fixture under all four Claude/Codex manager-worker combinations, a mixed-station configuration, and a limited-capability third harness.

**Acceptance Scenarios**:

1. **Given** qualified Claude and Codex installations, **When** manager selection changes, **Then** new manager jobs use that choice without changing worker settings.
2. **Given** worker settings at several levels, **When** a run starts, **Then** station overrides take precedence over project defaults, then factory defaults; the resolved values and their origins are recorded and visible.
3. **Given** a missing required capability, **When** a harness is selected, **Then** launch is refused with the specific gap; requirements are not dropped and another harness is not silently substituted.
4. **Given** an active attempt, **When** defaults change, **Then** its configuration stays fixed. **When** the operator explicitly switches its harness, **Then** the predecessor must be confirmed stopped before a new linked attempt starts with a handoff brief; foreign harness conversations are not treated as natively resumable.
5. **Given** expired credentials or quota exhaustion, **When** execution cannot continue, **Then** affected work shows its reason and recovery path; only configured credential rotation or fallback is allowed, while unrelated eligible work continues.
6. **Given** an additional registered harness, **When** its role-specific qualification passes, **Then** existing setup and run workflows expose it without new product navigation. Pi worker compatibility is retained; Pi management is unavailable until qualified.

### User Story 4 - Understand and steer work (Priority: P1)

The operator reads current state and evidence and messages, pauses, retries, redirects, or aborts work without a terminal.

**Why this priority**: Operator control must scale with concurrent runs.

**Independent Test**: Seed working, waiting, blocked, decision-required, and ended runs, including stale observations; exercise every control.

**Acceptance Scenarios**:

1. **Given** runs in different states, **When** Overview opens, **Then** each run has one operational state, reason, project, station, attempt, observation time, and history link.
2. **Given** a selected run, **When** Work opens, **Then** its timeline shows commands, reports, attempts, decisions, messages, artifacts, and available worker output without requiring raw output to explain its state.
3. **Given** a worker message or abort, **When** requested, **Then** delivery or termination remains pending until confirmed; failure includes a reason and is not shown as completion.
4. **Given** a project or factory pause, **When** acknowledged, **Then** no new attempts start in that scope and active attempts may finish and report. Resume is explicit and does not retry failures implicitly. Abort requests cancellation and holds selected work from further scheduling.
5. **Given** an obsolete view, **When** retry or redirect is submitted, **Then** the service rejects the stale target with refreshed context. Disconnect labels cached data stale; reconnect does not silently submit previously unsent commands.
6. **Given** a project with active work, **When** removal is requested, **Then** the operator must resolve or abort that work before its execution configuration is removed; history is retained unless explicitly deleted.

### User Story 5 - Decide with evidence and clear authority (Priority: P1)

The operator reviews a question, its evidence, and the consequences of each choice and answers once.

**Why this priority**: Decisions separate autonomous work from owner-controlled actions.

**Independent Test**: Answer a gate concurrently from two clients, change its evidence, and try the operation with manager and worker identities.

**Acceptance Scenarios**:

1. **Given** a gate or owner step, **When** it appears, **Then** it states the question, blocking reason, evidence and observation times, options, consequences, and any recommendation marked as advisory.
2. **Given** a current decision, **When** the authorized operator answers, **Then** the record identifies the actor, exact target and action, evidence revision, time, and optional note; duplicates have one effect.
3. **Given** changed evidence, a new attempt, or an answered decision, **When** an old answer arrives, **Then** it is refused with current context. A later gate visit is a distinct decision.
4. **Given** a worker or manager, **When** it attempts an owner-only action directly or through chat, **Then** the service refuses it regardless of prompt text, environment flags, or claimed approval.
5. **Given** an accepted answer, **When** subsequent execution fails, **Then** the answer and execution failure remain distinct and the UI exposes recovery.

### User Story 6 - Manage through conversation (Priority: P2)

The operator asks the manager to explain blockers, prioritize work, and prepare changes using the console's state and permissions.

**Why this priority**: Conversation simplifies operation while commands remain inspectable.

**Independent Test**: Ask both manager harnesses to explain the same held run, prioritize a backlog, and propose an owner-only action.

**Acceptance Scenarios**:

1. **Given** a connected manager, **When** it explains a blockage, **Then** it links observations, distinguishes inference, and marks unavailable information.
2. **Given** an instruction within configured authority, **When** the manager changes work ordering or messages a worker, **Then** console command rules apply and the resulting command and state are inspectable.
3. **Given** an owner-only request in chat, **When** the manager responds, **Then** it produces a concrete decision; conversation text alone cannot grant approval.
4. **Given** a timed-out, malformed, or limited manager job, **When** it fails, **Then** outcome and available usage are recorded, retries are bounded, and deterministic scheduling and operator controls remain available.
5. **Given** a manager harness change, **When** a new job starts, **Then** it recovers goals, actions, pending decisions, and rules from durable records rather than depending on the old chat transcript.
6. **Given** unchanged non-actionable state, **When** background jobs run, **Then** no repetitive alert is sent. New decisions, material failures, and completions are visible; acknowledgment survives reconnect.

### User Story 7 - Assess outcomes, usage, and quality (Priority: P2)

The operator sees delivery evidence and usage by project, station, harness, and model and sets admission limits.

**Why this priority**: Operation needs evidence of useful delivery and resource consumption.

**Independent Test**: Supply known delivery and usage fixtures, including missing values and a merge without deployment evidence; exercise budgets and proposal review.

**Acceptance Scenarios**:

1. **Given** source completion, publication, merge, deployment, and qualification observations, **When** displayed, **Then** each milestone is separate and evidence-linked; a merge does not imply runtime rollout.
2. **Given** worker and manager usage, **When** totals are shown, **Then** reported, estimated, and unknown values remain distinct; unsupported cost is not zero.
3. **Given** spec 005 metrics, **When** displayed, **Then** definitions, samples, windows, freshness, and limitations remain consistent. Its merge-based deployment metric is labeled explicitly and does not change operational deployment status.
4. **Given** a daily admission budget, **When** accounted usage reaches it, **Then** no new scoped agent jobs start, including retries and background jobs; active jobs may report and in-flight overspend risk is stated. Factory and project limits must both allow admission.
5. **Given** missing required accounting, **When** monetary enforcement is requested or coverage is lost, **Then** the product does not claim an unenforceable limit; new affected admissions are held, with supported usage or concurrency controls explained.
6. **Given** a budget window, **When** it resets, **Then** the displayed factory timezone and reset time govern accounting. Inspection, pause, abort, and decision controls remain available at the limit.
7. **Given** a memory, skill, or routing proposal, **When** reviewed, **Then** Decisions shows the change and supporting evidence and uses the existing install/reject process; quality scores are not added to worker prompts.

### User Story 8 - Install, migrate, and maintain the product (Priority: P2)

The operator installs or upgrades Factory, connects remotely, imports an existing home, and recovers if migration fails.

**Why this priority**: A product needs repeatable installation and recovery beyond a working demo.

**Independent Test**: Install on the documented target, migrate active and held fixture runs, interrupt cutover, restore a backup, and test identity, diagnostics, and accessibility.

**Acceptance Scenarios**:

1. **Given** provisioned infrastructure, **When** installation runs, **Then** readiness covers service, storage, repository access, credentials, and capacity with actionable failures and no secret values.
2. **Given** an existing home, **When** migration is previewed, **Then** supported settings, blockers, ownership, affected runs, backup, and rollback are listed without changing the source.
3. **Given** explicit cutover authorization, **When** migration succeeds or is interrupted, **Then** only one owner schedules; identities, reports, decisions, work links, and history survive. Rollback reconciles post-cutover activity before ownership resumes.
4. **Given** local mode, **When** this release is installed, **Then** local herdr and AX workflows still work. Connecting a server client does not silently migrate a local home or change its mode.
5. **Given** missing, revoked, or worker identity, **When** private reads or owner mutations are attempted, **Then** access is denied. Requests from untrusted browser origins cannot perform authenticated mutations.
6. **Given** an upgrade or incompatible client, **When** compatibility is checked, **Then** required migration is explicit before mutation, with backup and recovery before destructive schema changes.
7. **Given** seeded secrets and repository content, **When** credentials are configured, a harness handoff occurs, or a support export is previewed, **Then** secrets do not enter prompts, ordinary configuration, browser storage, logs, handoff briefs, or exports. Exports exclude source and transcripts unless selected and are not uploaded automatically.
8. **Given** keyboard-only or assistive-technology use, **When** onboarding, navigation, run inspection, and decisions are exercised, **Then** all controls have labels, visible focus, and announced results; color is not the sole status signal. Empty, loading, stale, unavailable, and error states are distinguishable.

### Edge Cases

- A launch succeeds but its acknowledgment is lost: inspect the same attempt before replacement; absence from a listing is not proof of termination.
- An old worker reports after retry, redirect, abort, or migration: refuse the stale attempt without changing current state.
- Two clients submit duplicate commands or conflicting answers: retain one accepted result and report the conflict.
- Defaults change during a run: retain its captured configuration unless explicitly reconfigured; record the override.
- Credentials expire or required skills differ between runners: preserve the attempt and refuse unsupported execution rather than weakening requirements.
- A budget is exhausted while a decision waits: the operator may answer; resulting agent work waits for admission.
- An external PR, deployment, or metric source fails: retain the last observation with its age; current unknown state is not success.
- A backup predates external effects: reconcile current workers and delivery before rollback; do not replay effects from an older snapshot.

## Requirements *(mandatory)*

### Functional Requirements

#### Setup and durable operation

- **FR-001**: Provide standalone Overview, Projects, Work, Decisions, Settings, and manager chat without requiring a Claude plugin or terminal for routine operation.
- **FR-002**: Validate repository access, Beads readiness and ownership, capacity, harness readiness, and required worker capabilities before admission.
- **FR-003**: Support existing lifecycle templates, goals, capacity, work-item selection/creation, and effective launch preview through the UI.
- **FR-004**: Preserve advanced configuration during UI edits, disclose when changes apply, and prevent project removal from orphaning active work or silently deleting history.
- **FR-005**: In server mode, scheduling, reports, supervision, and manager-job scheduling MUST continue without connected clients or a laptop process.
- **FR-006**: Acknowledged commands and reports MUST survive restart; duplicate requests MUST not repeat effects. Pending, accepted, completed, refused, failed, and unknown outcomes MUST remain distinguishable.
- **FR-007**: One authority MUST own execution mutations. Recovery MUST reconcile attempts before replacement, refuse stale reports, and hold replacement while predecessor termination is uncertain.
- **FR-008**: UI, CLI, and manager MUST share validation, authorization, ownership, and concurrency rules. A client reading state MUST not become a scheduler.
- **FR-009**: Pause MUST stop new scoped attempts while allowing active reports; resume MUST be explicit. Abort MUST hold work and confirm cancellation before showing termination. Retry and redirect MUST target the current revision.

#### Harnesses and management

- **FR-010**: Claude and Codex MUST each qualify as manager and worker harnesses, including all four combinations. Manager, worker, and execution-environment choices MUST be independent within supported capabilities.
- **FR-011**: Worker settings MUST resolve station, project, then factory defaults. Runs MUST capture resolved configuration; attempts MUST record actual harness, model, runner, rule/skill versions, and explicit overrides.
- **FR-012**: Readiness MUST declare role-specific execution, inspection, delivery, cancellation, native resume, structured-result, usage, credential, and tool/rule capabilities. Missing required capabilities MUST block launch with a reason.
- **FR-013**: Additional harnesses MUST be registrable and qualifiable through the same capability contract and operator workflows. Preserve Pi worker support; do not advertise Pi management before qualification. An arbitrary shell command is not sufficient qualification.
- **FR-014**: An active harness switch MUST stop and reconcile the predecessor, create a linked attempt, and supply a handoff containing goal, workspace revision, actions, evidence, decisions, and rules. Do not imply cross-harness native resume.
- **FR-015**: Credential rotation and harness fallback MUST be explicitly configured, recorded, and capability-compatible; neither may silently change billing source, budget accounting, or authority.
- **FR-016**: Every supported combination MUST obey the worker-parity constitution. Disclose and track gaps; required behavior MUST be provided or admission refused.
- **FR-017**: Patrol, planning, briefing, proposal review, dream, and interview judgment jobs MUST operate independently of interactive chat with bounded tools, duration, retries, recorded outcome, and available usage. Their failure MUST not stop deterministic execution or operator controls.
- **FR-018**: Manager jobs MUST recover context from durable goals, actions, evidence, decisions, and rules. Shared manager instructions MUST have one authoritative source across supported harnesses and modes.
- **FR-019**: Chat actions MUST produce inspectable commands or decision proposals; explanations MUST link observations and identify inference and unavailable information. Chat text MUST not grant owner authority.
- **FR-020**: Surface new decisions, material failures, and completions without repetitive alerts for unchanged non-actionable state; preserve acknowledgment across reconnect.

#### Console, decisions, and evidence

- **FR-021**: Each run MUST show one operational state, reason, project, station, attempt, settings, and observation time, with an ordered command/report/decision history, messages, artifacts, and available worker output.
- **FR-022**: Label stale and disconnected views; reject obsolete actions with current context. Reconnect MUST not silently submit unsent commands.
- **FR-023**: Decisions MUST identify question, target, evidence revision, options, consequences, and advisory recommendations; answers MUST record authenticated actor, time, outcome, and note separately from execution success.
- **FR-024**: Only an authenticated operator with appropriate authority MUST answer owner gates or perform owner-only actions. Manager and worker identities MUST be unable to grant themselves that authority.
- **FR-025**: Apply an answer once to the exact reviewed decision and evidence revision; reject stale evidence, attempts, and answered decisions. Later gate visits MUST create distinct decisions.
- **FR-026**: Display source completion, publication, merge, deployment, and qualification as separate evidence-backed milestones; missing evidence MUST remain unknown.
- **FR-027**: Memory and skill proposals MUST use existing review/install/reject processes with evidence and recorded outcomes, without a competing memory or proposal store.

#### Usage and limits

- **FR-028**: Attribute worker and manager usage to project, role/station, attempt/job, harness, and model; distinguish reported, estimated, and unknown values. Unknown cost MUST not be zero.
- **FR-029**: Reuse spec 005 metric definitions, sample sizes, windows, freshness, and limitations; its merge-based deployment metric MUST not imply runtime deployment or qualification.
- **FR-030**: Provide factory and project concurrency and daily admission budgets in supported accounting units. All new agent jobs, retries, and background jobs MUST satisfy every applicable limit.
- **FR-031**: Use the configured factory timezone for budget windows and show reset time. Disclose in-flight overspend risk, hold new budgeted admissions when required accounting is unavailable, and preserve inspection, pause, abort, and decision controls at the limit.

#### Installation and compatibility

- **FR-032**: Document supported installation targets and provide setup/health checks for service, persistence, repositories, credentials, and capacity with actionable failures and no secret values.
- **FR-033**: Authenticate and authorize remote private reads and mutations; separate owner, manager, and worker identities. Revoked credentials MUST fail subsequent requests; untrusted browser origins MUST not submit authenticated mutations.
- **FR-034**: Use protected credential references and supported credential workflows. Provider and infrastructure secrets MUST not enter prompts, ordinary project configuration, browser storage, logs, handoff briefs, or support exports. Owner authentication must use the approved identity mechanism without exposing its credentials to agents.
- **FR-035**: Migration MUST offer a non-mutating preview, explicit cutover, backup, exclusive ownership transfer, and tested rollback. Preserve identities, accepted reports, decisions, work links, and history; reconcile post-cutover effects before rollback resumes work.
- **FR-036**: Preserve local mode with herdr and AX and the AX-only server-mode boundary of spec 004. Neither a UI action nor upgrade may silently change mode or ownership.
- **FR-037**: Check client/service and persisted-state compatibility before upgrade mutation and preserve a recovery path. Support exports MUST be previewable and redacted, exclude source/transcripts by default, and require a separate explicit action for external upload.
- **FR-038**: Core workflows MUST work with keyboard and assistive technology using accessible labels, visible focus, announced outcomes, and status beyond color. Empty, loading, unavailable, stale, and error states MUST be explicit.

### Key Entities

- **Factory**: Identity, mode, timezone, policies, limits, health, and scheduling owner.
- **Project (rig)**: Repository, goal, tracker, template, capacity, execution environment, and agent defaults owned by a factory.
- **Work item**: Beads record, dependencies, claim, and links to runs and delivery.
- **Run and attempt**: Goal and captured configuration; station visits and attempts with distinct ownership, sessions, results, and evidence.
- **Harness profile**: Harness/version, capabilities, models, protected credential reference, role qualification, and readiness.
- **Execution environment**: Location, availability, capacity, and supported capabilities, distinct from harness identity.
- **Manager job**: Bounded judgment, input revision, harness/model, authority, limits, output, and usage.
- **Command**: Actor, operation, target revision, duplicate-detection identity, and acceptance/execution result.
- **Decision**: Question, target/evidence revision, options, answer, actor, and resulting command references.
- **Evidence and delivery milestone**: Source, observed time, artifact/reference, applicable revision, and verification status.
- **Usage and budget**: Provenance, accounting coverage, scope, units, timezone window, and admission limit.
- **Migration record**: Source/destination ownership, backup, validation, cutover, and rollback reconciliation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These are proposed release thresholds, not current production measurements. Performance checks use a documented reference installation with 10 projects, 50 active runs, and 1,000 retained runs. External provider execution time is excluded from UI responsiveness measurements.

- **SC-001**: At least 4 of 5 first-time operators connect a prepared repository and start a run within 15 minutes using the UI and guide, without shell commands or internal edits. Infrastructure provisioning and account creation are measured separately.
- **SC-002**: With all clients disconnected for one hour, at least three station transitions complete. Injected service restarts produce zero lost acknowledged operations, duplicate applied reports, or overlapping workers for the same attempt.
- **SC-003**: All four Claude/Codex manager-worker combinations complete the same deterministic workflow with a human gate, retry, and restart. Mixed-station execution, third-harness registration, and unsupported-capability refusal also pass.
- **SC-004**: Across concurrent-command, stale-decision, revoked-identity, cross-run worker, untrusted-origin, and forged-approval scenarios, zero unauthorized/stale operations change state and each refusal has a reason.
- **SC-005**: At reference load, 95% of primary views become usable within 2 seconds and 95% of accepted changes appear within 5 seconds. Disconnect becomes visibly stale within 15 seconds; external observations show their own age.
- **SC-006**: At least 4 of 5 operators identify the blocking reason, next action, and delivery evidence for each of five prepared runs within 60 seconds per run without raw worker output.
- **SC-007**: Every fixture job/attempt has usage provenance or an unknown marker. Admission stops after the configured limit is observed, with zero unrecorded fallback or billing changes; timezone reset and missing-accounting holds pass.
- **SC-008**: Migration and rollback preserve all fixture run IDs, work links, accepted reports, decisions, and evidence with zero double-owned workers. Existing local herdr and AX acceptance scenarios continue to pass.
- **SC-009**: Keyboard and assistive-technology checks complete onboarding, inspection, pause/resume, and decisions without inaccessible controls. Access, credential, handoff, and export fixtures disclose zero seeded secrets.
- **SC-010**: A seven-day server-mode qualification needs no laptop manager session, loses zero accepted operations, creates zero duplicate attempts, and preserves controls through an injected manager failure. Every intervention and dependency outage is recorded for review.

### Acceptance coverage

| Story | Requirements | Success criteria |
| --- | --- | --- |
| US1: Onboarding | FR-001–004, FR-012 | SC-001 |
| US2: Independent execution | FR-005–008, FR-017 | SC-002, SC-010 |
| US3: Harness choice | FR-010–016 | SC-003, SC-007 |
| US4: Console and steering | FR-004, FR-006–009, FR-021–022 | SC-004–006 |
| US5: Decisions | FR-008, FR-023–025 | SC-004, SC-006 |
| US6: Conversation | FR-017–020, FR-024 | SC-003–004, SC-010 |
| US7: Outcomes and usage | FR-026–031 | SC-006–007 |
| US8: Operable product | FR-032–038 | SC-008–010 |

## Delivery stages and qualification gates

These are release boundaries, not an implementation task list. The plan must reconcile existing Beads ownership and produce its dependency graph in Beads.

| Stage | Outcome | Dependencies and exit evidence |
| --- | --- | --- |
| A: Service foundation | Recoverable independent service with authenticated client and worker actions. | Reconcile remaining 004 work and owner decisions; demonstrate US2/US5 authority and duplicate-prevention behavior plus local regressions. S0-S1 alone is insufficient. |
| B: Harness-independent management | Claude and Codex independently manage and execute the same lifecycle. | Stage A command/identity boundary; capability, shared-rule, handoff, accounting, and SC-003 qualification. |
| C: Operator product | Onboarding, console, decisions, and chat cover daily operation. | Stable A/B behavior; US1, US4–US7, usability, accessibility, and metric-definition checks. Fixtures must be labeled and never represented as live data. |
| D: Installable release | Installation, remote access, upgrades, migration, rollback, and diagnostics are qualified. | Stages A–C; US8, recovery rehearsals, and SC-010. Publish supported versions, capability matrix, operating guide, and qualification evidence. |

No affected stage may roll out with unresolved duplicate-worker behavior, lost accepted state, identity-boundary failure, missing required worker capabilities, or failed migration rollback. Hold new admissions and expose the reason; never widen permissions or resume explicitly held work to pass a demonstration.

Infrastructure, identity, secret provisioning, and production cutover remain owner-controlled steps. Specification acceptance and fixture success do not authorize them. Release records distinguish source completion, publication, deployment, and qualification.

## Assumptions

- The earlier proposal's single-operator, several-repository scope is the draft baseline. Multiple browser clients are supported; team administration is outside this release.
- Server mode targets existing AX infrastructure. Local mode remains supported but is not required to gain the new standalone manager service in this feature.
- Beads remains the work tracker and ownership authority. Existing GitHub and deployment evidence integrations are the initial delivery sources.
- Claude and Codex are required manager and worker choices; existing Pi workers remain compatible. Other management harnesses require qualification, not merely installation.
- Infrastructure and provider accounts may require external provisioning. The product explains prerequisites; it need not provision a cluster or purchase accounts.
- Existing retention and proposal policies remain authoritative. Migration does not reset retention or introduce automatic deletion of historical evidence.
- Spec 005 owns metrics. Intermediate releases can show missing metrics as unavailable, but cannot fabricate them for acceptance.
- Performance and usability targets require evaluation on a documented reference setup; they are not claims about production today.

## Explicitly outside this release

- Hosted multi-tenant billing, organization administration, team roles, and shared approval chains.
- Visual workflow design, arbitrary plugin marketplace, and automatic selection of the best model.
- New tracker backends, a replacement memory engine, or new delivery-metric definitions.
- Native desktop/mobile applications, offline factory control, and external notification integrations.
- Automatic production cutover, provider account purchase/provisioning, or relaxation of owner gates.

## Planning follow-through

Next is `/speckit-plan` for `006-factory-product`. Resolve the concrete client/service contract, browser owner identity, harness capabilities and qualification fixtures, per-harness credentials, shared manager instructions, migration/version compatibility, reference installation sizing, and dependencies on specs 002–005. Reuse existing implementations before selecting dependencies. Reconcile implementation work in Beads instead of maintaining a second task list here.
