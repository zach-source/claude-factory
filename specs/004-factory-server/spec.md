# Feature Specification: Factory server and an independent manager

**Feature Branch**: `004-factory-server`

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Let the factory run as a server that the workers can call, and run the manager independently, not as a Claude Code mode. Help me design factory as a server." (epic claude-factory-xbzd)

## Context

Today the factory is a CLI with files in one factory home. Three things hold the factory together:

- **The manager is a Claude Code session.** The `mod` plugin ticks the factory at intervals of 5 s. It also runs these hidden subagents:
  - the patrol (at intervals of 10 min)
  - the pm (at intervals of 1 hour)
  - the briefer
  - the reviewer

  If that session stops, the factory stops.
- **The laptop pulls from VM workers.** A VM worker cannot reach the factory. It writes `report`, `mail` and `memory add` lines to an outbox file. On each tick, the laptop reads the outbox with `ax ssh <task> -- factory worker poll`. Only three commands can go through the outbox.
- **The state is files with directory locks.** Only one CLI process at a time can tick (`tick.lock`). Some shared files (`decisions.json`, `plan.json`, `gate-briefs.json`) have no lock.

Measured on 2026-10-26, after six days with all workers on AX:

- The memory has 0 "helped" events since 2026-10-20, against 529 before that date. The outbox does not pass `memory helped`.
- A memory search in a VM finds nothing, because the VM has no copy of the memory store.
- Notes added from a VM lose their run id.
- Codex workers record no token usage.

Epic claude-factory-vffe fixes the first, third and fourth gaps inside the current design. This feature removes their cause. Workers get a direct channel to the factory. The factory runs without a laptop session.

## Decisions (owner, 2026-10-26)

| Topic | Decision |
|---|---|
| Where the server runs | On the AX cluster, next to the workers. The laptop and the console are clients. |
| What drives the manager | A plain-code loop in the server does the ticks, timers and rules. Each judgment step (patrol, pm, briefer, reviewer, dream) is an agent call: headless Claude Code (`claude -p`) with a small tool set. The owner chose this over the Agent SDK on 2026-10-26, because the SDK docs ask for an API key and the owner uses the subscription tokens. |
| How a worker proves who it is | By its AX task identity. The owner asked for AX task mTLS. AX does not issue task certificates yet (its roadmap item "SPIFFE Identity for Tasks"), and its egress gateway decrypts all VM HTTPS. Thus step 1 uses a signed per-task token, and a later step uses the AX task SVID (plan research R1, 2026-10-26). |
| Laptop herdr workers | Retire the herdr runner. The four laptop rigs move to AX, so every worker uses the same path and the same identity. |
| Credential for the manager's agent steps | The subscription OAuth tokens that the workers use (the token slots that `ax-token best` swaps). The steps share the weekly limits with the workers. |
| Where the state lives | In Dolt, next to the beads data. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A VM worker calls the factory directly (Priority: P1)

A worker in an AX VM runs `factory report`, `mail`, `memory add`, `memory helped` and `memory search`, as a laptop worker does. Each call goes to the factory server and gets an answer at once. There is no outbox file and no poll.

**Why this priority**: It closes all four measured gaps at their cause. It also removes the `ax ssh` poll. That poll costs one SSH session for each live task on each tick.

**Independent Test**: Start one run on an AX rig. The worker searches the memory and gets notes. The worker marks one note helped. The worker adds a note and reports. The memory then shows the helped event and the note with `from: <run>/<station>`. The run moves to its next station within 10 s of the report.

**Acceptance Scenarios**:

1. **Given** a live AX run at station `implement`, **When** its worker runs `factory memory search "<query>"`, **Then** the worker gets the same notes that a laptop worker gets for that query.
2. **Given** a live AX run, **When** its worker reports an outcome, **Then** the server applies it to that run within 10 s. The worker gets a success answer or the reason for a refusal.
3. **Given** a worker of run A, **When** it sends a report or mail for run B, **Then** the server refuses the call and records the attempt.
4. **Given** a codex or pi worker, **When** its station ends, **Then** the server has that station's token usage, with the model name.

---

### User Story 2 - The factory keeps working when the laptop is off (Priority: P1)

The server runs on the cluster. It ticks the runs, starts and watches AX workers, replays nothing, and keeps its state in Dolt. The laptop can sleep or be off.

**Why this priority**: Since 2026-10-20 all live work runs on AX, but each step still needs a laptop process. A laptop sleep or restart stops the factory.

**Independent Test**: With live AX runs, stop every factory process on the laptop for 1 hour. Runs continue to start, report and move through stations. When the laptop comes back, the console shows the current state.

**Acceptance Scenarios**:

1. **Given** live AX runs and no laptop process, **When** a worker reports, **Then** the run moves to its next station and the next worker starts.
2. **Given** the server restarts, **When** it comes back, **Then** it continues each run from its stored state. No report is lost or applied two times.
3. **Given** two server processes start by mistake, **When** both try to tick, **Then** only one of them writes state. The other waits or exits.

---

### User Story 3 - The manager runs without a Claude Code session (Priority: P2)

The server runs the manager's judgment steps on its own timers: patrol, pm, briefer, reviewer, dream and interview proposals. Each step is an agent call with a fixed tool set and a time limit. The person sees the results in the console and answers decisions there. No Claude Code session has to stay open.

**Why this priority**: Today the patrol, pm, briefer and reviewer exist only while one Claude Code session runs with the `mod` plugin. Usage-limit swaps and restarts of that session stop them.

**Independent Test**: Close every Claude Code session. Within one patrol interval, a patrol runs, its log entry appears, and a gate gets its brief.

**Acceptance Scenarios**:

1. **Given** no Claude Code session, **When** a run reaches a gate, **Then** the briefer writes the gate's brief. The console shows it.
2. **Given** a judgment step that runs past its time limit, **When** the limit passes, **Then** the server stops that step and logs it. The server starts the next step on time.
3. **Given** the person decides a gate in the console, **When** they confirm, **Then** the server applies the decision. A gate is never decided by an agent step.

---

### User Story 4 - The person uses the console and a chat as clients (Priority: P2)

The console (the `mod` plugin, or another client) reads from the server and sends the person's actions to it. The person can still talk to the factory in a Claude Code session. That session calls the server through the factory CLI. It does not run ticks or timers.

**Why this priority**: The person must keep every control they have today: decide gates, answer the interview, mail a run, stop and resume.

**Independent Test**: Open the console on the laptop while the server runs on the cluster. Decide a gate. Mail a run. Press stop. Each action takes effect on the server.

**Acceptance Scenarios**:

1. **Given** the console is open, **When** a run changes station, **Then** the console shows the change within 10 s.
2. **Given** two consoles are open, **When** the person acts in one of them, **Then** the other shows the result.

---

### User Story 5 - The factory state moves to Dolt without a loss (Priority: P3)

The runs, mail, decisions, plans, gate briefs, reviews, metrics, usage and memory index move from files to Dolt. The memory notes stay readable as Markdown.

**Why this priority**: The server needs one store that more than one process can read safely, with history. It can start on the file layout with a single writer and move to Dolt in a later step.

**Independent Test**: Migrate a copy of the factory home. Then `factory status`, `factory metrics` and `factory memory search` give the same results from Dolt as from the files.

**Acceptance Scenarios**:

1. **Given** a copy of the factory home, **When** the migration runs, **Then** each run, mail line, decision and usage row is in Dolt. A count check passes for each kind.
2. **Given** the migration ran, **When** the person asks for the state at an earlier time, **Then** Dolt history gives it.

### Edge Cases

- **The server is down when a worker calls it.** The worker CLI retries with backoff for a limited time. Then it keeps the call in a local outbox file. The server reads that file on recovery. A report must never be lost.
- **A worker identity expires during a long station.** It lives longer than the longest station time limit, or the worker can renew it.
- **A worker sends a call for an old attempt (stale seq).** The server refuses it, as `factory report` does today.
- **A VM worker is steered by text it read.** Its identity limits it to its own run and station. It cannot decide a gate, start a run or change a rig.
- **A judgment step hits a usage limit.** The server marks the step as waiting until the limit lifts. The other steps continue.
- **A run is live during the cutover.** The cutover must not lose or double-apply a report from a run that started before it.
- **A laptop rig's repo cannot build in AX yet.** Its move to AX waits until its devenv or image works in a VM (FR-014). Until then it stays on the current laptop factory.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The factory MUST run as one long-lived server process on the AX cluster. This process ticks the runs and runs the manager's timers.
- **FR-002**: The server MUST give workers an API for: report, mail, memory search, memory add, memory helped, usage and progress. This API replaces the VM outbox and the `ax ssh` poll.
- **FR-003**: The server MUST identify each AX worker by its AX task, which names its run, station and attempt (seq). The proof is a signed per-task token now, and the AX task SVID when AX issues one. The server MUST refuse a call outside that scope: another run, another station, or an old seq.
- **FR-004**: The factory CLI in a worker MUST use the API with no change to the commands that the worker prompt names. `factory report <run> <seq> <outcome> <summary>` keeps its syntax.
- **FR-005**: If the server cannot be reached, the worker CLI MUST keep each call and deliver it later. A report MUST NOT be lost or applied two times.
- **FR-006**: The server MUST keep the current rules for worker calls: a report needs a successful beads push, a gate takes no report, and outcome names must match the station.
- **FR-007**: Only one server process at a time MUST write the factory state.
- **FR-008**: The server MUST run patrol, pm, briefer, reviewer and dream as agent steps with headless Claude Code (`claude -p`). Each step MUST have a fixed tool set, a time limit and a log entry.
- **FR-009**: No agent step MUST be able to decide a gate. Only the person decides a gate.
- **FR-010**: The server MUST give clients (the console, the CLI, a Claude Code session) an API to read the board, runs, mail, decisions, plans and PRs. The server MUST also accept the person's actions: decide, mail, answer, start, stop, resume.
- **FR-011**: Client calls from the person MUST need an identity that a worker identity cannot give.
- **FR-012**: The server MUST store the factory state in Dolt, with history. Memory notes MUST stay readable as Markdown files.
- **FR-013**: The server MUST record token usage for every worker harness (Claude, codex, pi), with the model name.
- **FR-014**: All workers MUST run in AX tasks. The herdr runner MUST be retired after the four laptop rigs run on AX.
- **FR-015**: The manager's agent steps MUST use the subscription OAuth tokens that the workers use. When a token reaches its usage limit, the server MUST swap to another token slot, as `ax-token best` does, or wait until the limit lifts.
- **FR-016**: The cutover MUST happen in steps that each leave a working factory. The person MUST be able to go back to the laptop manager after each step.
- **FR-017**: The design MUST keep constitution I (worker parity): every worker gets the same API, skills and memory access, on every runner.

### Key Entities

- **Factory server**: the one process that owns the state, ticks the runs and runs the manager timers.
- **Worker identity**: the identity of one AX task, proved by a signed token (later an SVID). It names the run, the station and the seq. It expires.
- **Worker call**: one request from a worker: a report, mail, memory call, usage or progress. It has an id, so a retry is not applied two times.
- **Agent step**: one judgment job (patrol, pm, briefer, reviewer, dream). It has a tool set, a time limit, a model, and a log entry with its usage.
- **Client**: the console, the CLI or a Claude Code session that acts for the person.
- **Factory state**: runs, mail, decisions, plans, gate briefs, reviews, metrics, usage and the memory index, in Dolt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A VM worker's memory search gives the same top 5 notes as a laptop search for the same query, for 10 of 10 test queries.
- **SC-002**: "Helped" events from VM workers appear again: more than 0 in the first week, from at least 3 rigs.
- **SC-003**: A worker report changes the run's station within 10 s in 95% of cases (today the poll adds up to one tick plus one SSH call).
- **SC-004**: The factory moves runs through at least 3 stations while no laptop process runs for 1 hour.
- **SC-005**: Patrol, pm and briefer run on their intervals for 7 days with no Claude Code session open.
- **SC-006**: 0 lost reports and 0 double-applied reports across the cutover, checked against the run logs.
- **SC-007**: Token usage rows exist for 100% of codex and pi stations after the change.

## Assumptions

- The AX cluster can run a long-lived Deployment with a persistent volume, and VM workers can reach it on the cluster network through their egress policy.
- The beads Dolt server on the cluster can hold one more database for the factory state, or the factory can run its own Dolt server.
- The policy broker (`factory broker serve`) and the package gate already run as in-cluster HTTP services. The factory server follows their pattern.
- The AX task launch can put a per-task token in the task env, as it puts `FACTORY_CA` there today.
- The console stays a Claude Code plugin in the first release. It becomes a thin client that calls the server.
- The memory notes stay in their own git repository, with the server as the only writer. Only the memory index and usage events move to Dolt.
- Epic claude-factory-vffe ships first. It fixes the measured gaps in the current design while this feature is built.
- Epic claude-factory-192 (the manager in an AX VM) is open. This feature replaces its approach: the manager becomes a server process, not a Claude Code session in a VM.
