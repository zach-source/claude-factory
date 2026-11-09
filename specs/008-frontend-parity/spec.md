# Feature Specification: Manager core and front-end parity

**Feature Branch**: `spec/008-frontend-parity`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "Build into the constitution to build a web, cli, claude mod, and herdr mod so they all have the same features and functionality; build a server core for the factory/manager that is easy to extend and build different front ends for." Constitution Principle II (Front-end Parity, v1.1.0) governs this feature.

## Context

On 2026-11-07, the factory has four front ends. Each front end has a different set of features:

| Front end | What it has | What it does not have |
| --- | --- | --- |
| Claude Code mod (`mod/`) | All features: the board and 7 tabs (Board, Backlog, Mail, Rigs, PRs, Interview, Runners), stop and resume, the manager chat, the patrol, pm, briefer and reviewer subagents, the Bash gate on the manager's commands | It is the only front end with the manager chat and the subagents. About 4,600 lines in `mod/hooks` hold factory logic that no other front end can use. |
| Herdr app mod (`herdr/mods/factory`) | The tick, the headless manager steps (`--once`), the lease, the board, the Interview dialog, toasts, a status band | The Backlog, Mail, Rigs, PRs and Runners tabs, stop and resume, a worker screen for an AX run, the manager chat |
| CLI (`bin/factory`) | Almost all operations as commands | The manager chat, the gate briefs on the board, a live view |
| Web UI (`factory ui`) | A dashboard of beads and epic progress | It reads only. It cannot send a command. |

Two specs already describe a factory server:

- Spec 004 adds the factory server with the `/v1` interface. It keeps two modes: local mode and server mode.
- Spec 006 adds the control interface contract (`contracts/control-api.md`) and the operator UI for server mode.

Neither spec makes the Claude mod and the Herdr mod clients of that interface. Neither spec covers local mode with the same interface. So, a fix in one front end does not reach the others. This feature closes that gap.

## Decisions (owner, 2026-11-07)

| Topic | Decision |
| --- | --- |
| Front ends | Four front ends: the web UI, the CLI, the Claude Code mod and the Herdr app mod. All four have the same features and functionality (constitution Principle II). |
| Core | One manager core owns every feature and rule. The front ends are thin clients. |
| Interface | The core uses the `/v1` interface of specs 004 and 006. This spec does not make a second interface. It adds the operations that are missing from it. |
| Modes | The core runs in local mode (on the laptop, for a local factory home) and in server mode (spec 004). The front ends work in both modes with no change to their code. |
| Extension | Each feature is one operation in one catalog. A front end gets a new operation from the catalog with no change to the core. |
| Enforcement | A parity check fails the build when a front end does not have an operation and the gap list has no gap entry for it. |

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A developer adds a feature one time (Priority: P1)

A developer adds a new manager feature, for example "pause one rig". The developer adds one operation to the core catalog. The operation has its input, its output, its rules and its tests. The web UI, the CLI, the Claude mod and the Herdr mod then show the operation. Each front end can run it. The developer writes no factory logic in a front end.

**Why this priority**: This is the cause of the gap. If a feature must be written four times, the front ends drift apart again.

**Independent Test**: Add a test operation to the catalog. Do not change front-end code. Each of the four front ends lists the operation, runs it, and shows the same result.

**Acceptance Scenarios**:

1. **Given** a new operation in the catalog, **When** each front end starts, **Then** it shows the operation. It shows its name, inputs and help text from the catalog.
2. **Given** a new operation with a rule (for example, "only the owner can run it"), **When** a person runs it from any front end without the right, **Then** the core refuses it. It gives the same reason in all four front ends.
3. **Given** a change to an operation's rule in the core, **When** the build runs, **Then** no front end needs a change. The new rule applies without a change to any front end.

---

### User Story 2 - The person does the same work from any front end (Priority: P1)

The person works the factory from the front end that the person opens. That front end can be a browser, a terminal, a Claude Code session or the Herdr app. Each front end has the same features:

- see the board, a run, its log and its worker screen (a herdr pane or an AX task)
- see and change the backlog, the mail, the rigs, the PRs and the runners
- answer gates and decisions with their briefs (the Interview)
- start, queue, stop, resume and abort runs
- talk to the manager in a chat, and see the patrol, pm, briefer and reviewer reports

**Why this priority**: This is the feature that the owner asked for.

**Independent Test**: Run one parity scenario of 12 steps in each front end on the same test factory home. The 12 steps are:

1. Show the board.
2. Open a run.
3. Read its worker screen.
4. Queue a bead.
5. Answer a gate.
6. Answer a decision.
7. Add mail.
8. Change a rig setting.
9. Stop the factory.
10. Resume it.
11. Ask the manager a question.
12. Read the last patrol report.

The end state of the home is the same after each front end.

**Acceptance Scenarios**:

1. **Given** a live AX run, **When** the person opens it in any front end, **Then** the front end shows the run's worker screen.
2. **Given** an open gate, **When** the person answers it in one front end, **Then** the other open front ends show the answer within 5 s. They do not offer the gate again.
3. **Given** a stopped factory, **When** the person selects resume in any front end, **Then** the core resumes the same workers as `factory resume` does.
4. **Given** a manager chat in the Herdr mod, **When** the person asks the manager to queue a bead, **Then** the manager queues it through the same operation. The other front ends use that same operation.

---

### User Story 3 - The core runs the local factory on the laptop (Priority: P1)

The person runs a local factory home. A local core process on the laptop ticks the factory. The same process runs the manager steps and holds the manager lease. The Claude mod, the Herdr mod, the CLI and the web UI connect to it as clients. The person can close every front end. The local core continues.

**Why this priority**: The owner runs the factory in local mode today. Without a local core, the Claude mod and the Herdr mod keep their own copies of the logic.

**Independent Test**: Start the local core on a test home. Close all front ends for 1 hour. Then open each front end. The factory completes at least 3 station changes while the person keeps all front ends closed. Each front end shows the same board.

**Acceptance Scenarios**:

1. **Given** a local home with no core, **When** a front end starts, **Then** it starts the local core or tells the person how to start it. It does not tick by itself.
2. **Given** a running local core, **When** a second core tries to start for the same home, **Then** the second core refuses to start. It names the holder of the lease.
3. **Given** a local core, **When** the person moves the home to server mode, **Then** the front ends connect to the server without a code change.

---

### User Story 4 - The build finds a front end that lacks a feature (Priority: P2)

A developer adds an operation and does not add it to the Herdr mod. The build fails and names the operation and the front end. The developer either adds the operation to the front end, or adds a gap entry with a bead id. Then the build passes.

**Why this priority**: Without a check, parity is a rule that people forget.

**Independent Test**: Remove one operation from one front end's list. The build fails with the name of the operation and the front end. Add a gap entry with a bead id. The build passes, and the gap shows in the build output.

**Acceptance Scenarios**:

1. **Given** an operation that a front end does not show, **When** the build runs, **Then** it fails unless the gap list has a gap entry for it. The gap entry names that operation, that front end and a bead id.
2. **Given** a gap entry whose bead is closed, **When** the build runs, **Then** it fails. It asks the developer to remove the gap entry or to reopen the bead.
3. **Given** a front end that has factory logic of its own (for example, a copy of a validation rule), **When** a review runs, **Then** the reviewer finds it. The reason is that the parity check lists each place where a front end decides an outcome.

---

### User Story 5 - A developer adds a new front end (Priority: P2)

A developer makes a fifth front end, for example a phone view or a terminal UI. The developer reads the catalog and the interface contract. The new front end gets all existing operations with no change to the core.

**Why this priority**: The owner asked for a core that is easy to extend with new front ends.

**Independent Test**: Make a small test front end that reads the catalog and runs operations through the interface. It runs the 12-step parity scenario with no change to the core.

**Acceptance Scenarios**:

1. **Given** the catalog and the interface contract, **When** a developer makes a new front end, **Then** the developer needs no core change. The new front end can show and run every operation.
2. **Given** a front end built for an older catalog version, **When** it connects to a newer core, **Then** the core tells it which operations it does not know. The front end shows those operations in a generic form.

---

### User Story 6 - The manager's judgment steps run in the core (Priority: P2)

The patrol, the pm, the briefer, the reviewer and the manager chat run in the core. Today they are subagents of the Claude mod, or headless `--once` commands in the Herdr mod. After this feature, each front end only shows their reports and sends the person's chat to the core.

**Why this priority**: The manager steps are most of the logic that only the Claude mod has. Spec 004 (User Story 3) and epic claude-factory-s01d already move them toward headless steps.

**Independent Test**: Close the Claude mod and open only the Herdr mod. The patrol runs on its timer, and the person can chat with the manager. The patrol and chat logs are the same files that the Claude mod writes today.

**Acceptance Scenarios**:

1. **Given** only the web UI is open, **When** new manager mail comes in, **Then** the core runs the patrol. The web UI shows the patrol report.
2. **Given** a chat in any front end, **When** the manager wants to run a command that needs the person's approval (for example, the Bash gate in `mod/hooks/view.ts`), **Then** the core asks the person in that front end. The core makes the decision with one rule for all front ends.

### Edge Cases

- Two front ends send different answers to the same gate at the same time. The core keeps one answer and tells the other front end of the conflict (spec 006 revision rules).
- A front end is older or newer than the core. The core tells the front end of the difference. It must not run an operation that the front end sent with the wrong inputs.
- The core is not available. Each front end shows that the core is down and the last data it has, with its age. It must not tick, launch or decide by itself.
- A front end cannot show a feature in its space (for example, the status band of one line). It shows a link or a command that opens the feature in another front end. The parity check counts this as present.
- An operation takes longer than a front end can wait (the Herdr app stops a call after 30 s). The core accepts the operation and gives a command id. The front end shows its status until it is done.
- The manager chat in the Claude mod is a Claude Code session. The other front ends do not have one. The core runs the chat itself, and the Claude mod's chat becomes one more client of it.
- A person runs the old Claude mod manager and the new local core on the same home. The lease lets only one of them tick and patrol.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The core MUST hold one catalog of operations. Each operation has a name, inputs, outputs, help text, the rights it needs, and whether it reads or changes state.
- **FR-002**: Every factory and manager feature MUST be an operation in the catalog. This includes:
  - the board, run detail, worker screen, backlog, mail, rigs, PRs and runners
  - gates, decisions, start, queue, stop, resume and abort
  - the manager chat and the manager step reports
- **FR-003**: The core MUST serve the catalog and its operations through the `/v1` interface of specs 004 and 006. This feature MUST NOT add a second interface.
- **FR-004**: The core MUST run in local mode for a local factory home and in server mode. The same front-end code MUST work with both.
- **FR-005**: In local mode, the core MUST tick the factory and run the manager steps while no front end is open.
- **FR-006**: Only one core MUST tick and patrol a factory home at a time. The core MUST use the manager lease (epic claude-factory-s01d) and name the holder when it refuses.
- **FR-007**: Each front end MUST get the list of operations from the catalog. A front end MUST NOT need a code change to show and run a new operation in a generic form.
- **FR-008**: A front end MUST NOT validate, schedule, authorize or change factory state by itself. It MUST send each command to the core and show the core's answer.
- **FR-009**: The core MUST apply the same rules, refusals and messages to a command from any front end.
- **FR-010**: Each front end MUST show changes from other front ends within 5 s while it is open.
- **FR-011**: The web UI MUST send commands, not only read. It MUST have every operation of the catalog.
- **FR-012**: The Herdr mod MUST get the Backlog, Mail, Rigs, PRs and Runners views, stop and resume, the AX worker screen and the manager chat.
- **FR-013**: The Claude mod MUST become a client of the core. Its factory logic in `mod/hooks` MUST move into the core. The mod keeps only presentation and the Claude Code hooks that send events to the core.
- **FR-014**: The CLI MUST run every operation of the catalog, including the manager chat and the gate briefs.
- **FR-015**: The patrol, pm, briefer, reviewer and manager chat MUST run in the core. They MUST write the logs that they write today (`patrol-log.jsonl`, `pm-log.jsonl`, `brief-log.jsonl`, `review-log.jsonl`, `manager-usage.jsonl`).
- **FR-016**: A guard that the manager's own commands must pass (for example, the Bash gate) MUST be a core rule. When the rule needs the person's approval, the core MUST ask in the front end that the person uses.
- **FR-017**: An operation that takes more than 10 s MUST give a command id at once. Each front end MUST show its status until it is done.
- **FR-018**: The build MUST fail when a front end does not have an operation of the catalog. The build passes only when the gap list names that operation, that front end and an open bead.
- **FR-019**: The build MUST fail when a gap entry names a closed bead.
- **FR-020**: The catalog MUST have a version. The core MUST tell an older or newer front end which operations differ.
- **FR-021**: A new front end MUST be able to show and run every operation with only the catalog and the interface contract.
- **FR-022**: A front end MAY add presentation only: layout, keys, colors and the order of items. When it cannot show a feature in its space, it MUST give a link or a command to a front end that can.
- **FR-023**: The current CLI commands and their outputs MUST stay compatible. The CLI MUST run them through the catalog.
- **FR-024**: The move MUST NOT stop a live factory. The old Claude mod manager and the new core MUST be able to change places through the lease, with no lost mail, report or decision.

### Key Entities

- **Operation**: one feature of the factory or the manager. It has a name, inputs, outputs, help text, needed rights, a read or change flag, and a version.
- **Catalog**: the list of all operations, with a version. The core serves it. Each front end reads it.
- **Core instance**: one running core for one factory home, in local mode or server mode. It holds the manager lease.
- **Front end**: a client of the core (web UI, CLI, Claude mod, Herdr mod, or a later one). It has a list of the operations it shows and a presentation for each.
- **Gap entry**: a pair of an operation and a front end that does not have it yet, with an open bead id.
- **Command**: one request from a front end to run an operation. It has an id, the person, the inputs, a status and a result.
- **Manager conversation**: the chat between the person and the manager. The core holds it. Any front end can show it and add to it.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of the catalog's operations are in each of the four front ends, or have a gap entry with an open bead.
- **SC-002**: When a developer adds a new operation, the change has 0 lines of factory logic in a front end. Only optional presentation lines are in front-end files.
- **SC-003**: The 12-step parity scenario passes in each of the four front ends, in local mode and in server mode, with the same end state of the home.
- **SC-004**: With all front ends closed for 1 hour, the local core completes at least 3 station changes. A front end that opens after that shows the current board within 5 s.
- **SC-005**: A change in one front end (for example, a gate answer) shows in the other open front ends within 5 s.
- **SC-006**: A test front end runs the parity scenario with 0 changes to the core.
- **SC-007**: At the end of this feature, the gap list is empty, or each entry has an open bead and the owner accepts it.
- **SC-008**: The move from today's Claude mod manager to the core loses 0 mail items, reports, gate answers or decisions on the live home.

## Assumptions

- The person is the one owner of the factory. Team roles are outside this feature, as in spec 006.
- In local mode, the core listens only on the laptop. It does not take connections from other hosts.
- The web UI in local mode is served by the local core on the laptop. In server mode it is the operator UI of spec 006.
- Spec 006's command rules apply: idempotency keys, revisions and conflict answers.
- The headless manager steps of epic claude-factory-s01d (`factory patrol|pm|brief|review --once`) are the start point for FR-015.
- The current `factory ui` dashboard becomes the start of the web UI (owner decision of 2026-11-06: it stays in claude-factory).
- Codex and pi as the harness of a manager step are outside this feature. Spec 006 covers harness choice.

## Dependencies

- Spec 004 (factory server): the `/v1` interface, the modes, and the server.
- Spec 006 (factory product): the control interface contract, the command rules, the operator UI.
- Epic claude-factory-s01d: the headless manager steps and the manager lease.
- Constitution Principle II (v1.1.0).

## Out of Scope

- A public or multi-user web service.
- A phone app. User Story 5 tests only that a new front end can be added.
- New factory features. This feature moves the current features into the core and gives them to every front end.
