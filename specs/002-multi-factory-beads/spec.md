# Feature Specification: Beads are required and checked

**Feature Branch**: `spec/002-multi-factory-beads`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "think about how there could be multiple factories working on the same rigs; different users or different machines; define the best method of identifying the factory and claiming work and the sync frequency. support beads outright, include a beads guide for using the factory"

**Scope (2026-11-09)**: This spec now covers only User Story 3: beads are required and checked. The multi-factory parts are in [Deferred](#deferred).

## Where this starts

Today `rig add` needs `.beads`, but it does not check `bd`, the store, the Dolt remote or the schema. A run in a repo without `.beads` keeps a checklist.

| Area           | Behavior today                                                                                                                                                                                  | Problem                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Beads optional | `defineRig` in `src/cli.ts` fails only when `.beads` is missing. `beadFor` returns `{ goal }` and `tracking()` gives a checklist when the repo has no `.beads`. There is no `beads doctor` command | A missing `bd`, an old `bd`, a dead store or an unseeded remote shows up later, as a failed dispatch with no fix in the text |

## Clarifications

### Session 2026-10-14

- Q: What identifies a factory? → A: A random id that `factory init` generates once and keeps in the factory home, plus a human name. The id is in every bd actor and branch name. The name is for display only. (Deferred with US1.)
- Q: Which topology is recommended? → A: One beads store per machine, synced through one Dolt remote per rig. (Deferred with US1.)
- Q: Can a factory take over another factory's stale claim by itself? → A: No. A person releases it with one command. (Deferred with US4.)

### Session 2026-11-09

- Q: What stays of this spec? → A: Owner decision: cut the spec to User Story 3 ("Beads are required and checked") with FR-014, FR-015 and FR-016. User Story 5 (`docs/beads.md`, FR-019) is done. The rest is deferred. See [Deferred](#deferred).

## User Scenarios & Testing _(mandatory)_

### User Story 3 - Beads are required and checked (Priority: P1)

The person adds a rig and learns at once whether its beads setup works for the factory. They do not learn it later from a failed dispatch.

**Why this priority**: A missing remote or an old `bd` must fail early with a clear fix. A run that works no bead has no record of its work.

**Independent Test**: Run `factory rig add` on a repo without `.beads`, on a repo whose `bd` is too old, and on a repo whose Dolt remote has no data. Make sure that each one fails with a message that names the fix. Then run `factory beads doctor` on a correct rig and make sure that every check passes. Then start a run in a repo without `.beads` and make sure that it is refused.

**Acceptance Scenarios**:

1. **Given** a repo without `.beads`, **When** the person adds it as a rig, **Then** the command fails and gives the `bd init` command.
2. **Given** a `bd` that is older than the minimum version, **When** the person adds a rig, **Then** the command fails and tells the person to upgrade `bd`.
3. **Given** a rig with a Dolt remote that has no data, **When** the person adds it, **Then** the command fails and gives the `bd dolt push` command to seed it.
4. **Given** a rig with no Dolt remote, **When** the person adds it without `--beads-local`, **Then** the command fails and says that a remote is necessary for a second factory or for AX workers.
5. **Given** a rig with no Dolt remote, **When** the person adds it with `--beads-local`, **Then** the rig is added, the remote checks are skipped, and the rig is recorded as having no remote.
6. **Given** any rig, **When** the person runs `factory beads doctor`, **Then** they see one line per check (bd version, store, remote, seed) with a fix for each failure, and nothing changes.
7. **Given** a repo without `.beads`, **When** a person or the factory starts a run there, **Then** the start is refused and the message gives the `bd init` command.

---

### User Story 5 - The beads guide (Priority: P2) - Done

A person who has not used the factory reads one guide and can make a repo a rig, hand it work, share it across machines and fix the common problems.

**Status**: Done. `docs/beads.md` exists, and the README and `docs/remote-runner.md` link to it. FR-019 is done. The only open step is to update the guide for FR-014 to FR-016 when they ship (see the plan).

---

### Edge Cases

- The `bd` command is not on `PATH`. The check names `bd` and gives the install step.
- The store exists but does not answer (a Dolt server that is down). The check says so and gives `bd dolt start` or `bd doctor`.
- The rig has a remote and the person does not want a check of it (offline). `--beads-local` skips the remote checks, and `factory beads doctor` reports the rig as local.
- A rig that exists before this change has no remote and no `beadsLocal` record. `factory beads doctor` reports it with a warning, not a failure. Dispatch for it does not change.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-014**: `factory rig add` MUST verify that `bd` is present and new enough, that the repo has `.beads`, that the store answers, and that the Dolt remote exists and has data. With `--beads-local`, it MUST skip the remote checks and record that the rig has no remote.
- **FR-015**: `factory beads doctor [rig]` MUST report each check on one line with a fix. It MUST NOT change anything.
- **FR-016**: Every run MUST work a bead. The factory MUST refuse to start a run in a repo without `.beads`.
- **FR-019** (done): `docs/beads.md` MUST explain how to use the factory with beads. The README and `docs/remote-runner.md` MUST link to it.

### Key Entities

- **Check**: One test of a rig's beads setup (bd version, store, remote, seed). It has a name, a result (`ok`, `warn` or `FAIL`) and a fix.
- **Rig beads mode**: Either a rig with a Dolt remote, or a local rig (`beadsLocal`) that `--beads-local` records.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-005**: Each failure of `factory rig add` and each failed check of `factory beads doctor` gives a command or step that fixes it.
- **SC-006**: A person who follows `docs/beads.md` gets a bead from `bd create` to a running worker without reading the source.
- **SC-008**: `factory start` and `factory fork` in a repo without `.beads` start no run and print the `bd init` command.

## Assumptions

- The repo pins `bd` in two places today: `Dockerfile.worker` (`BD_VERSION=1.3.2`, the version that workers run) and `Dockerfile.server` (`BD_VERSION=1.3.0`). `docs/onboarding.md` says that the first `bd` on `PATH` must match the repo's schema. The minimum version for FR-014 is one constant in `src/`. This spec sets it to 1.3.0, the lowest pin. The owner can raise it to 1.3.2.
- Each rig that is not `--beads-local` has one Dolt remote that every factory and AX worker of the rig can reach: a Dolt server's remotesapi, DoltHub, or the repo's git origin (`refs/dolt/data`).
- People can still claim beads by hand. The factory never dispatches an assigned bead.

## Deferred

Owner decision 2026-11-09. These parts are out of scope. Two designs replace the need for them: one manager anywhere (the one-manager lease, and the AX manager that reaches herdr with `herdr --remote`), and Dolt as the primary copy of beads ([spec 004](../004-factory-server/spec.md)). Come back to them if several factories on one rig become a need.

- **US1** (two machines of one person share a rig), **US2** (two people's factories share a repo) and **US4** (a person releases a dead factory's work).
- **FR-001 to FR-013**: factory id, actors, branches, ownership, push-confirmed claims, lost claims, presence, steward, label rules, rig-wide cap, sync cadence and takeover.
- **FR-017** and **FR-018**: `factory stop` keeps claims and sets presence to `paused`, and legacy runs finish with no migration.
- **SC-001 to SC-004** and **SC-007**: the success criteria of those parts.
- **Where-this-starts rows moved here** (one line each):
  - Actor: `factory/<run>` is the same for every factory. Two factories write as the same `factory`.
  - Claim: `bd update --claim` is local, so two stores that sync can both claim.
  - Lease: bd leases do not replicate, so another machine cannot see a live claim.
  - Lost claim (`beat`): sets an error on the run, and the run continues.
  - Sync: 5 minutes per rig, so a claim is late for other machines.
  - Pull request labels: every factory acts on every labeled PR.
  - Sweeps: each factory runs its own sweeps on the rig.
  - Run caps: per factory, none for the rig.
  - Branches: `factory/<run>` does not name the factory.

The full text of the cut parts is in the git history of this file (before the 2026-11-09 commit).
