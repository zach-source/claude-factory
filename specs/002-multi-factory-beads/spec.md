# Feature Specification: Several factories on the same rigs, with beads as a requirement

**Feature Branch**: `spec/002-multi-factory-beads`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "think about how there could be multiple factories working on the same rigs; different users or different machines; define the best method of identifying the factory and claiming work and the sync frequency. support beads outright, include a beads guide for using the factory"

## Where this starts

Today one factory works a rig. Its identity is implicit. The code assumes that every `factory/...` name is its own:

| Area                              | Behavior today                                                                                                                | Problem when a second factory works the same rig                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor (`src/beads.ts` `actorOf`)  | `factory/<run>` holds a run's bead. Workers write as `factory/<run>/<station>`. Dispatch, queue and sweeps write as `factory` | Two factories write as the same `factory`. No bd record tells which factory holds a claim                                                                                                    |
| Claim (`beads.claim`)             | `bd update --claim` on the local store                                                                                        | On per-machine stores that sync through a Dolt remote, both claims succeed locally. bd's pull settles the `assignee` cell last-write-wins, so the first factory can lose a claim it acted on |
| Lease (`HEARTBEAT_MS` = 2 min)    | Heartbeats keep bd's 5-minute lease                                                                                           | bd keeps leases in a table that does not replicate (`leases` is in `dolt_ignore`). Another machine cannot see the lease, so it cannot tell a live claim from a dead one                      |
| Lost claim (`beat`)               | Sets an error on the run. The run continues                                                                                   | Two runs work the same bead and open two pull requests                                                                                                                                       |
| Sync (`SYNC_MS` = 5 min)          | `bd sync` per rig, inside dispatch                                                                                            | A claim is invisible to other machines for up to 5 minutes plus their own sync lag                                                                                                           |
| Pull request labels (`labelPass`) | Acts on every labeled PR in the rig. A PR whose branch is not a live local run gets a new rework run                          | Every factory starts a rework run for the same PR. Each factory can close another factory's PR                                                                                               |
| Sweeps (`sweep`)                  | Each factory keeps one run of each sweep per rig                                                                              | N factories run N monitor, maintain and improve sweeps on one repo                                                                                                                           |
| Run caps (`room`, `maxRuns`)      | Per factory                                                                                                                   | No limit for the rig as a whole                                                                                                                                                              |
| Branches (`createRun`)            | `factory/<run>`                                                                                                               | Nothing in the name says which factory owns the branch                                                                                                                                       |
| Beads optional                    | Runs in a repo without `.beads` keep a checklist. `rig add` needs `.beads` but does not check `bd`, the remote, or the schema | Coordination between factories depends on beads, so beads cannot be optional                                                                                                                 |

## Clarifications

### Session 2026-10-14

- Q: What identifies a factory? → A: A random id that `factory init` generates once and keeps in the factory home, plus a human name. The id is in every bd actor and branch name. The name is for display only.
- Q: Which topology is recommended? → A: One beads store per machine, synced through one Dolt remote per rig. Two factories that use the same Dolt server are one replica, and their claims are atomic with no extra step. The factory supports both topologies with one protocol.
- Q: Can a factory take over another factory's stale claim by itself? → A: No. The board shows a claim whose factory has been quiet for 2 hours. A person (or the manager, on the person's word) releases it with one command.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Two machines of one person share a rig (Priority: P1)

The person runs a factory on a laptop and a factory on a desktop. Both work the same rig. Each ready bead labeled `factory` becomes exactly one run, on one of the two machines.

**Why this priority**: This is the most common reason for a second factory. Today it can start the same bead twice.

**Independent Test**: Make two factory homes with two beads stores that sync through one Dolt remote (a `file://` remote is enough). Queue ten beads. Let both factories dispatch at the same time. Make sure that each bead has exactly one run and that the two factories agree on who holds each bead.

**Acceptance Scenarios**:

1. **Given** two factories and one queued bead, **When** both dispatch in the same second, **Then** exactly one factory launches a worker for it. The other factory skips it with no error.
2. **Given** a bead that factory A holds, **When** factory B syncs, **Then** B shows the bead as held by A's name, and B never comments on it, settles it, heartbeats it or releases it.
3. **Given** factory A's laptop is asleep for 8 hours, **When** factory B runs, **Then** A's beads stay A's. B's board shows them as held by a quiet factory after 2 hours.
4. **Given** the Dolt remote cannot be reached, **When** a factory dispatches, **Then** it starts no new run on that rig, its live runs continue, and the board says why.

---

### User Story 2 - Two people's factories share a repo (Priority: P1)

Two people each run a factory on the same repo. Each person can see which factory and which run holds each bead, and which factory owns each pull request.

**Why this priority**: A team needs to know whose factory did what before it can trust two factories on one repo.

**Independent Test**: With two factories on one rig, run `bd show` on a claimed bead and look at a run's pull request. Make sure that both name the factory.

**Acceptance Scenarios**:

1. **Given** a claimed bead, **When** a person runs `bd show`, **Then** the assignee names the factory id and the run. The factory list maps the id to a name, a user and a host.
2. **Given** a pull request from factory A's run that has the `rework` label, **When** factory B checks labels, **Then** B does nothing. A handles it.
3. **Given** a pull request from a person (not a factory branch) that has the `rework` label, **When** both factories check labels, **Then** only the rig's steward starts a rework run.
4. **Given** two factories on one rig, **When** sweeps run, **Then** the rig has one run of each sweep, from the steward.

---

### User Story 3 - Beads are required and checked (Priority: P1)

The person adds a rig and learns at once whether its beads setup works for the factory. They do not learn it later from a failed dispatch.

**Why this priority**: Coordination depends on beads. A missing remote or an old `bd` must fail early with a clear fix.

**Independent Test**: Run `factory rig add` on a repo without `.beads`, on a repo whose `bd` is too old, and on a repo whose Dolt remote has no data. Make sure that each one fails with a message that names the fix. Then run `factory beads doctor` on a correct rig and make sure that every check passes.

**Acceptance Scenarios**:

1. **Given** a repo without `.beads`, **When** the person adds it as a rig, **Then** the command fails and gives the `bd init` command.
2. **Given** a rig with a Dolt remote that has no data, **When** the person adds it, **Then** the command fails and gives the `bd dolt push` command to seed it.
3. **Given** a rig with no Dolt remote, **When** the person adds it without `--beads-local`, **Then** the command fails and says that a remote is necessary for a second factory or for AX workers.
4. **Given** any rig, **When** the person runs `factory beads doctor`, **Then** they see one line per check (bd version, store, remote, seed, node id, factories seen, steward, conflicts) with a fix for each failure.

---

### User Story 4 - A person releases a dead factory's work (Priority: P2)

A factory stops for good (a broken machine, a deleted home). The person returns its claimed beads to the queue.

**Why this priority**: Without this step, a dead factory's beads stay in progress forever.

**Independent Test**: Make factory A claim a bead, then stop A and make its presence record 3 hours old. In factory B, run the takeover command. Make sure that the bead is unassigned, has a comment that names A and its branch, and is dispatched again.

**Acceptance Scenarios**:

1. **Given** a bead held by a factory that was last seen 3 hours ago, **When** the person runs `factory beads takeover <bead>`, **Then** the bead is released with a comment and becomes ready again.
2. **Given** a bead held by a factory that was seen 10 minutes ago, **When** the person runs the takeover command without `--force`, **Then** it refuses and says when that factory was last seen.
3. **Given** a run whose claim was taken over, **When** its factory comes back, **Then** the run parks for the person, and its factory does not write to the bead.

---

### User Story 5 - The beads guide (Priority: P2)

A person who has not used the factory reads one guide and can make a repo a rig, hand it work, share it across machines and fix the common problems.

**Why this priority**: Today the beads rules are spread over the README, `docs/remote-runner.md` and the code.

**Independent Test**: Follow `docs/beads.md` from an empty repo to a dispatched run, then to a second machine's factory. No step needs the source code.

**Acceptance Scenarios**:

1. **Given** the guide, **When** a person follows it, **Then** they make a rig, queue a bead, see it start, and add a Dolt remote.
2. **Given** a common problem (a bead that does not start, a sync error, a lost claim), **When** a person looks it up in the guide, **Then** the guide gives its cause and fix.

---

### Edge Cases

- A factory home is copied to a second machine. Both copies have the same id. The second one to start sees its own id live on another host and refuses to dispatch.
- A person claims a `factory` bead by hand on their own machine, at the same time as a factory claims it. After both sync, the bead has one assignee. If the factory lost, its run parks for the person.
- An AX worker pushes to the remote between a factory's pull and its push. The factory's push is refused. The factory releases its new claims, pulls, and claims again.
- The steward stops (`factory stop`). It keeps the steward role and its presence says `paused`. Nobody else runs the rig's sweeps until it resumes or a person moves the role.
- Two factories set the steward at the same time on a rig that has none. After a sync, both read the same value. The other one stops its sweeps.
- A run created before this feature holds its bead as `factory/<run>` and its branch is `factory/<run>`. It finishes with no change.
- The Dolt remote is down for a long time. Presence goes quiet for every factory. Nobody takes over a claim, because takeover needs a person.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Each factory MUST have an id that is generated once and stored in the factory home, and a name that a person can change. Two factories MUST NOT share an id.
- **FR-002**: Each bd write that a factory makes MUST carry an actor that starts with `factory:<id>`. A run's claim MUST be `factory:<id>/<run>`, and its workers MUST write as `factory:<id>/<run>/<station>`.
- **FR-003**: A run's branch MUST be `factory/<id>/<run>`.
- **FR-004**: A factory MUST treat as its own only the actors, runs and branches that carry its own id, plus the legacy `factory/<run>` names of runs in its own home.
- **FR-005**: A factory MUST NOT claim, heartbeat, comment as owner, close, defer, reject, reopen or release a bead that another actor holds. The takeover command is the only exception.
- **FR-006**: A factory MUST launch a worker for a bead only after its claim is confirmed. On a store with a Dolt remote, a claim is confirmed only when the push that carries it succeeds. A claim that does not reach the remote MUST be released locally.
- **FR-007**: When a factory finds that another actor holds the bead of one of its live runs, it MUST stop all bead writes for that run and park the run for the person.
- **FR-008**: Each factory MUST publish a presence record for each rig: id, name, user, host, state (running, stopping, paused) and time. It MUST update the record at least every 10 minutes and when its state changes.
- **FR-009**: Each rig MUST have at most one steward. Only the steward runs the rig's sweeps and acts on labels of pull requests that are not on a factory branch.
- **FR-010**: A factory MUST act on pull request labels only for its own branches, plus the PRs that are not on a factory branch when it is the steward.
- **FR-011**: A rig MAY have a rig-wide cap on the factory runs that hold its beads. Each factory MUST respect it in addition to its own cap.
- **FR-012**: A factory MUST sync each rig's beads with its Dolt remote every 2 minutes. When a sync fails, the factory MUST back off (2, 4, 8, 16, then 30 minutes) and show the error on the board. It MUST mail the manager after 3 failures in a row.
- **FR-013**: `factory beads takeover <bead>` MUST release a bead held by another factory only when that factory has been quiet for 2 hours or more, unless `--force` is given. It MUST comment on the bead with the holder and its branch.
- **FR-014**: `factory rig add` MUST verify that `bd` is present and new enough, that the repo has `.beads`, that the store answers, and that the Dolt remote exists and has data. With `--beads-local`, it MUST skip the remote checks and record that the rig has no remote.
- **FR-015**: `factory beads doctor [rig]` MUST report each check with a fix. It MUST NOT change anything.
- **FR-016**: Every run MUST work a bead. The factory MUST refuse to start a run in a repo without `.beads`.
- **FR-017**: `factory stop` MUST keep the factory's claims and steward roles, and MUST set its presence to `paused`. A paused factory MUST NOT claim new beads.
- **FR-018**: Runs created before this feature MUST finish with their legacy actor and branch, with no migration step.
- **FR-019**: `docs/beads.md` MUST explain how to use the factory with beads. The README and `docs/remote-runner.md` MUST link to it.

### Key Entities

- **Factory identity**: The id (6 lowercase base32 characters), the name, and the creation time, in `<home>/factory.json`.
- **Actor**: `factory:<id>` for the factory itself, `factory:<id>/<run>` for a run's claim, `factory:<id>/<run>/<station>` for a worker.
- **Presence record**: One per factory per rig, in the rig's beads store. It holds the id, name, user, host, state, version and time.
- **Steward**: The one factory that does a rig's shared duties. The rig's beads store names it.
- **Replica**: One beads store. Factories that use the same Dolt server are one replica. Stores that sync through a Dolt remote are separate replicas.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In a test with two factories, 3 replicas (two factories and one simulated AX worker that pushes) and 50 queued beads dispatched at the same time, no bead gets two runs.
- **SC-002**: A bead that one factory claims is shown as held on every other factory's board within 3 minutes while the remote is up.
- **SC-003**: With two factories on one rig, the rig has one run of each sweep at any time, apart from at most one sync interval after a steward change.
- **SC-004**: No factory writes to a bead or a pull request that another factory owns, in a test that runs both factories through dispatch, label passes, sweeps and stop.
- **SC-005**: Each failure of `factory rig add` and each failed check of `factory beads doctor` gives a command or step that fixes it.
- **SC-006**: A person who follows `docs/beads.md` gets a bead from `bd create` to a running worker without reading the source.
- **SC-007**: A factory with live runs from before this feature upgrades and finishes those runs with no manual step.

## Assumptions

- bd 1.3 or later. Its behavior here was read from bd 1.3.0: `--claim` is atomic within one store, leases do not replicate, `bd sync` settles issue cells last-write-wins, and a Dolt push is refused when the remote has commits the local store does not have.
- Each rig has one Dolt remote that every factory of the rig can reach: a Dolt server's remotesapi, DoltHub, or the repo's git origin (`refs/dolt/data`).
- Factories on one rig run versions of claude-factory that use the same claim protocol. An older factory on the same rig is not supported.
- Memory and the dream stay per factory. A shared memory is out of scope.
- People can still claim beads by hand. The factory never dispatches an assigned bead, and it parks a run whose claim a person took.
