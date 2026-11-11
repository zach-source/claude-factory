# Feature Specification: Factory server pod as the control plane

**Feature Branch**: `spec/010-server-pod`
**Created**: 2026-11-11
**Status**: Draft
**Input**: Owner request 2026-11-11: Run one cluster pod that is the factory application. The pod contains the web frontend and the backend. The backend starts the AX task of the manager and owns it. All front ends work through the server. This includes the Herdr mod and the CLI.

## Context

Today the remote factory runs in one AX task, `f-manager`. That task holds the factory home, the herdr session, the Claude manager session and the mod that drives the ticks. On 2026-11-11 this design caused these problems:

- **Two writers can tick.** A `factory server` in the same task takes the manager lease. It does so when the lease of the manager pane is stale. Then two processes tick one home.

- **A lost resume.** A tick started before `factory resume`. This tick wrote its old halt state back. The factory stayed paused for about 2 hours. The status showed "30 working" (bead claude-factory-sg4s3).

- **A long pause at each manager image change.** An image change deletes the task and its workspace. The new task restores the home from the git backup. Then it builds the memory cache again. The factory pauses for about 25 minutes.

- **Slow status.** `factory status` over ssh into the task took more than 200 s.

- **A slow Herdr mod.** The Herdr mod is slow for remote flows. Each view reads the home through the task.

- **No web server.** The web page of spec 008 (PR 885) has no server to serve it. The AX manager runs no `factory server`.

This spec moves the control plane into one cluster pod. The pod holds the home and makes the ticks. The pod serves the web page and the `/v1` interface. It also starts the AX task of the Claude manager and maintains it.

### Changes to other specs

| Spec | Requirement | Change |
| --- | --- | --- |
| 004 | FR-001 (one server process ticks) | Kept. The server is the pod of this spec. |
| 004 | FR-008 (manager steps as `claude -p`) | Changed. The Claude manager is a long-lived session in an AX task that the pod starts. Steps that the pod runs headless stay allowed. |
| 004 | FR-012 (state in Dolt) | Deferred. The state stays as files on the pod volume. A later spec can move it to Dolt. |
| 008 | FR-005, FR-006 (one core ticks; lease) | Kept. In server mode, the pod is that core. |
| 008 | FR-012 (Herdr mod views) | Changed. The Herdr mod reads and acts only through the pod `/v1` interface in server mode. It does not read the home files. |
| 008 | Web UI | Changed. The pod serves the web page. A browser reaches it on a private name. |

## Decisions (owner, 2026-11-11)

1. **The pod ticks.** The server pod runs the tick loop and holds the manager lease. No other process ticks a server-mode home. The AX manager task holds only the Claude manager session (patrol, decisions, and direction). That session calls the pod interface. It does not read the home files or run mod ticks.
2. **The home is on the pod volume.** The factory home (runs, `rigs.json`, mail, memory, beads stores) is on a persistent volume of the pod. The git home backup stays as a second copy. A manager task upgrade needs no restore, because the task holds no state.
3. **Private web access.** The browser reaches the web page on a private DNS name over WARP (`<private-zone>`). The route is a cluster Service and Ingress with a cluster certificate. The person logs in with the person client certificate of spec 004 (mutual TLS).
4. **A new spec.** This is spec 010. It names what it changes in specs 004 and 008.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Exactly one process ticks the remote factory (Priority: P1)

The person runs the remote factory. Only the pod ticks it. A stop, a resume or a manager restart never lets a second process tick. It never loses a command.

**Why this priority**: Two tickers and a lost resume stopped all work for hours on 2026-11-11. The factory is not safe until you fix this.

**Independent Test**: Start the pod and the manager task. Send `factory stop`, then `factory resume`, while a tick runs. Restart the manager task. Make sure that the halt state is the last one that the person sent. Make sure that only the pod holds the lease.

**Acceptance Scenarios**:

1. **Given** a tick runs, **When** the person sends resume, **Then** the next tick runs the factory, and no tick writes an older halt state over the resume.
2. **Given** the pod holds the lease, **When** another process tries to tick the same home, **Then** that process refuses and names the pod as the holder.
3. **Given** the manager task restarts, **When** it starts again, **Then** the factory keeps its halt state, and no tick stops.

---

### User Story 2 - A manager image change does not pause the factory (Priority: P1)

The person or a release changes the manager image. The pod replaces the manager task. Runs keep going. The home needs no restore.

**Why this priority**: Each image change paused the factory for about 25 minutes. There were three image changes on 2026-11-11.

**Independent Test**: Change the manager image while runs are active. Measure how long no tick runs and how long no new worker starts.

**Acceptance Scenarios**:

1. **Given** active runs, **When** the pod replaces the manager task with a new image, **Then** ticks continue, and workers keep their runs.
2. **Given** a new manager task, **When** it starts, **Then** it reads its open decisions and mail from the pod, and it does not restore a home.
3. **Given** the pod itself gets a new image, **When** the new pod starts, **Then** it opens the same volume, takes the lease, and ticks within 2 minutes.

---

### User Story 3 - Every front end works through the server (Priority: P1)

The person uses the web page, the CLI, the Claude mod or the Herdr mod. Each one reads and acts through the pod `/v1` interface. All of them show the same state. All of them accept the same commands.

**Why this priority**: Constitution Principle II needs one core for all front ends. Today the Herdr mod reads home files through the task, so it is slow and it can differ from the CLI.

**Independent Test**: Do the same action (stop, resume, decide a gate, send mail) from each front end in turn. Make sure that each other front end shows the change within 5 s.

**Acceptance Scenarios**:

1. **Given** the Herdr mod in server mode, **When** the person opens the status view, **Then** the view opens in less than 1 s, and it reads no home file.
2. **Given** the CLI on the laptop, **When** the person runs `factory status` against the server, **Then** the answer comes in less than 2 s.
3. **Given** an action from the web page, **When** the Claude mod and the Herdr mod are open, **Then** both show the result within 5 s.

---

### User Story 4 - The person opens the web page from a browser (Priority: P2)

The person is on the private network over WARP. The person opens the private name of the factory in a browser, picks the person certificate, and sees the factory.

**Why this priority**: The web page is ready (PR 885 and PR 892). Nothing serves it. It is the fastest way to follow the work.

**Independent Test**: From a laptop on WARP with the person certificate, open the private name. From a device without the certificate, try the same name.

**Acceptance Scenarios**:

1. **Given** WARP and the person certificate, **When** the person opens the private name, **Then** the page shows the Overview section within 3 s.
2. **Given** no person certificate, **When** someone opens the private name, **Then** the connection is refused, and no factory data is sent.
3. **Given** a device not on the private network, **When** it looks up the name, **Then** it cannot reach the page.

---

### User Story 5 - The home moves to the pod with no lost runs (Priority: P1)

The person moves the live home from the `f-manager` task to the pod volume. The move loses no run, report, mail or decision. If the move fails, the person returns to the old design.

**Why this priority**: The factory runs real work for many rigs. A lost report or a double tick can break a release.

**Independent Test**: Run the migration on a copy of the home first. Then run it on the live home. Compare the run count, the open decisions and the last report of each run before and after.

**Acceptance Scenarios**:

1. **Given** the live factory, **When** the migration starts, **Then** the factory pauses. A backup newer than the pause exists. The old task stops ticks before the pod takes the lease.
2. **Given** the home is on the pod volume, **When** the pod resumes the factory, **Then** every run that was active before the pause continues, and the pod applies no report two times.
3. **Given** the migration fails at any step, **When** the person starts the rollback, **Then** the old `f-manager` design runs again from the last backup, and the rollback loses no run.

---

### User Story 6 - Local mode stays as it is (Priority: P2)

A person runs a factory on a laptop home, with `factory ui`, herdr and the Claude mod. This spec does not change that.

**Why this priority**: Spec 004 and spec 008 keep local mode. This spec is only for server mode.

**Independent Test**: Run the local-mode test set of spec 008 after the change.

**Acceptance Scenarios**:

1. **Given** a laptop home, **When** the person runs the factory, **Then** it ticks and serves `factory ui` as before.

### Edge Cases

- The pod restarts in the middle of a tick. The next tick must finish or undo the half step. The pod applies no report two times.

- The volume is full or read-only. The pod stops its ticks. It shows the reason on every front end. It does not lose a report.

- The manager task cannot start. The cause can be an AX failure or an image pull failure. The pod keeps its ticks. It shows the manager as down. It retries with a back-off.

- The manager task runs, but its Claude session is out of tokens. The pod keeps its ticks. The person sees the manager as limited.

- Two pods start (for example, during a rollout): only one holds the lease. The other serves only reads, or waits.

- The person certificate expires: the page refuses it and the CLI shows the expiry date. The person can make a new certificate.

- WARP is down. The CLI and the Herdr mod still reach the pod over their own route. The page waits.

- The git backup cannot push. The pod keeps its ticks, because the volume is the main copy. It shows the backup age.

- A worker sends a report while the pod restarts. The worker keeps the call and sends it again (spec 004 FR-005).

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: In server mode, the factory MUST run as one cluster pod that holds the backend and the web page.
- **FR-002**: The pod MUST be the only process that ticks a server-mode home. It MUST hold the manager lease while it ticks. It MUST refuse to tick when another holder has a fresh lease, and it MUST name that holder.
- **FR-003**: Every change of the halt state (stop, pause, resume) MUST be applied in one order. A tick MUST NOT write a halt state that is older than the last command of the person.
- **FR-004**: The factory home MUST be on a persistent volume of the pod. The home MUST stay when the pod or the manager task restarts or gets a new image.
- **FR-005**: The pod MUST keep the git home backup as a second copy. It MUST show the backup age on every front end.
- **FR-006**: The pod MUST create, upgrade, suspend and remove the AX manager task. It MUST check the health of the task and show it on every front end.
- **FR-007**: The manager task MUST hold only the Claude manager session and what that session needs. It MUST NOT hold factory state, and it MUST NOT tick.
- **FR-008**: The manager session MUST read and change the factory only through the pod `/v1` interface, with an identity that the pod gives to the manager task.
- **FR-009**: A manager task upgrade MUST NOT pause ticks, and it MUST NOT need a home restore.
- **FR-010**: The CLI, the Claude mod, the Herdr mod and the web page MUST read and act on a server-mode factory only through the pod `/v1` interface. A front end MUST NOT read the home files of a server-mode factory.
- **FR-011**: The pod MUST serve the `/v1` interface of specs 004, 006 and 008. This spec MUST NOT add a second interface.
- **FR-012**: The pod MUST serve the web page on a private DNS name that only the private network (WARP) can reach.
- **FR-013**: The web page and the client interface MUST need the person client certificate of spec 004. The pod MUST refuse a connection without it before the pod sends factory data.
- **FR-014**: The worker interface of spec 004 MUST keep working with no change for AX workers. A worker MUST reach the pod with its task token.
- **FR-015**: A migration MUST move the live home from the `f-manager` task to the pod volume. It MUST pause the factory, make a backup newer than the pause, stop the old ticker before the pod takes the lease, and check the run count, the open decisions and the last report of each run after the move.
- **FR-016**: A rollback MUST bring back the old `f-manager` design from the last backup. Each migration step MUST say how to undo it.
- **FR-017**: Local mode MUST keep working: a laptop home, `factory ui`, herdr and the Claude mod, with no pod.
- **FR-018**: Secrets that the pod needs (person CA, server certificate key, gateway keys) MUST NOT be in the git backup or the container image.
- **FR-019**: Only the person MUST be able to change the manager image, the pod image or the halt state. A worker identity MUST NOT do any of these.

### Key Entities

- **Server pod**: the one cluster process for a server-mode factory. It holds the lease, ticks, serves `/v1` and the web page, and looks after the manager task.
- **Home volume**: the persistent volume with the factory home. It is the main copy of the factory state.
- **Home backup**: the git branch copy of the home. It is the second copy, and the source for a rollback.
- **Manager task**: the AX task with the Claude manager session. The pod owns its life cycle. It holds no state.
- **Manager lease**: the record of which process may tick a home, with a holder name and an age.
- **Halt state**: running, stopping or paused, with the time and the command that set it.
- **Person certificate**: the client certificate from spec 004 that a browser or the CLI shows to the pod.
- **Private name**: the DNS name on the private network that leads to the pod.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In 30 days of operation, no two processes tick one home at the same time, and no resume or stop command of the person is lost.
- **SC-002**: A manager image change stops no tick. New workers keep starting during the change. Today the gap is about 25 minutes.
- **SC-003**: A pod image change stops ticks for less than 2 minutes.
- **SC-004**: `factory status` against the server answers in less than 2 s for 95% of calls. Today it can take more than 200 s.
- **SC-005**: Each Herdr mod view opens in less than 1 s for 95% of opens in server mode.
- **SC-006**: A change from any front end shows on every other open front end within 5 s.
- **SC-007**: The person opens the web page from a browser on WARP in less than 3 s. A device without the person certificate gets no factory data.
- **SC-008**: The migration ends with the same run count, open decisions and last reports as before the pause, and the factory pause is less than 1 hour.
- **SC-009**: The local-mode tests of spec 008 pass with no change.

## Assumptions

- The cluster has a storage class for a persistent volume that one pod can mount for writing.
- WARP and the `<private-zone>` DNS zone can give the pod a private name, and the cluster can issue a certificate for it.
- AX lets a cluster workload create, upgrade, suspend and delete a task with an AX identity that the person grants to the pod.
- The manager session can use the pod `/v1` interface for everything it does today with files and mod ticks. Record each gap as a bead under spec 008 parity rules.
- This spec reuses the person CA and the person certificate of spec 004 as they are. The pod gets the server certificate and the CA from a cluster secret.
- Beads stores stay on the volume as today. The move of beads and state to Dolt is out of this spec.
- One pod is enough for the load of one factory home. High availability with more than one pod that ticks is out of scope.

## Dependencies

- Spec 004: the `/v1` client and worker interfaces, the person certificate, the task token for workers, the manager lease.
- Spec 008: the operation catalog and the parity check for the four front ends.
- Bead claude-factory-sg4s3: the ordered halt state (FR-003). This spec includes it.
- The AX control API for task life cycle from a cluster workload.

## Out of Scope

- Moving the factory state or beads to Dolt (spec 004 FR-012).
- More than one ticking pod, or a pod in another cluster.
- A public route or a login other than the person certificate.
- Changes to AX workers or to the worker prompts.
