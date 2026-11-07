# Implementation Plan: Manager core and front-end parity

**Branch**: `spec/008-frontend-parity` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-frontend-parity/spec.md`

## Summary

Put every factory and manager feature into one catalog of operations in the core (`src/core/`). The core serves the catalog through the `/v1` interface of specs 004 and 006. It runs in process, not as a `bun src/cli.ts` subprocess. A new command, `factory core`, runs the core for a local factory home on the laptop. It holds the manager lease, ticks, and runs the manager steps and the manager chat. The four front ends become clients of the catalog:

- the CLI (`bin/factory`)
- the web UI (`web/`, the shell from aya5.11)
- the Claude Code mod (`mod/`)
- the Herdr app mod (`herdr/mods/factory`)

Each front end has a generic view that shows and runs any operation from the catalog. A front end can add its own view for an operation, but only for presentation. A parity test fails the build when a front end does not reach an operation. Only a gap entry in `parity-gaps.json` allows that gap.

## Technical Context

**Language/Version**: TypeScript on Bun 1.3 (the pinned version), as today

**Primary Dependencies**: none new. Bun's `Bun.serve` and `fetch`, `node:tls` (exists in `src/server-api.ts`), the Claude Code mod kit, the Herdr app's gpui-kit (`exec`, `fetch`)

**Storage**: the factory home files (local mode). Dolt state in server mode comes from spec 004 S6 and spec 006 aya5.4, not from this feature.

**Testing**: `bun test`, `bunx tsc --noEmit`, `claude plugin test mod`, `herdr-app check herdr/mods/factory`, prettier; the browser fixture tooling of aya5.2 for the web UI

**Target Platform**: macOS laptop (local mode); the AX cluster (server mode, spec 004)

**Project Type**: a CLI and service with four clients

**Performance Goals**: a change shows in the other open front ends within 5 s (SC-005). A guard check from the Claude mod answers in under 1 s. The mod's hook has a 10 s limit.

**Constraints**:

- No second interface. Each operation maps to one `/v1` route (FR-003).
- The current CLI syntax and output stay the same (FR-023).
- The Herdr app stops an `exec` after 30 s, so long operations return a command id (FR-017).
- The live factory must not stop during the move (FR-024).

**Scale/Scope**: about 70 CLI subcommands and 14 `/v1` routes today; 4 front ends; 1 person

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle | Check | Result |
| --- | --- | --- |
| I. Worker Parity | The feature does not change what a worker gets. The manager steps keep the step prompts in `src/steps/*.md` for every harness. | Pass |
| II. Front-end Parity | This feature is the way to meet Principle II. Each task that adds an operation adds it to the catalog. All front ends then get it through their generic view. Each gap that stays is in `parity-gaps.json` with an open bead. | Pass |
| Governance | The plan names the open beads of specs 004 and 006 that this feature delivers (see Reconciliation). | Pass |

Re-check after Phase 1: pass. The contracts keep all logic in `src/core/` and give the front ends only the catalog, the routes and the events.

## Reconciliation with specs 004 and 006

The owner asked that this feature does no work twice. These open beads are the same work as a task of this feature. When the task merges, the bead closes as superseded by it:

| Open bead | Its work | Delivered by |
| --- | --- | --- |
| claude-factory-aya5.3 T003 Extract typed factory operations from CLI side effects | typed operations in `src/core.ts`, called in process | T001 and T002 (the catalog and the moved operations) |
| claude-factory-aya5.8 T008 Make CLI and plugin thin server clients | CLI and plugin as clients, no double schedule | T008 (CLI) and T009 (Claude mod) |
| claude-factory-akiq.16 T016 Stop the mod timers when FACTORY_SERVER is set | the mod runs no timers in server mode | T009: the mod runs no timers in any mode, because the core runs them |

These beads stay as they are, and this feature uses their result:

- akiq.15 (judgment steps as `claude -p` in the server): the local core runs the same steps through `src/once.ts`. Both modes use one step runner.
- aya5.5 (idempotent command acceptance), aya5.6 (identity transport), aya5.9 (TLS and browser boundary): these are for server mode. The catalog keeps the command envelope of `contracts/control-api.md` (006), so these tasks fit in with no change.
- aya5.11 (browser shell and typed client, closed): T011 builds the web UI on `web/`.

## Project Structure

### Documentation (this feature)

```text
specs/008-frontend-parity/
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── catalog.md       # the operation catalog and its routes
│   ├── local-core.md    # factory core: listener, auth, lease, events
│   └── frontends.md     # generic view, own views, parity gaps
└── checklists/requirements.md
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── catalog.ts       # Op type, Field kinds (moved from server-api.ts), registry, version
│   ├── ops/             # one file for each group: board.ts, runs.ts, rigs.ts, mail.ts, gates.ts, manager.ts, …
│   ├── guards.ts        # gatedCommand, bdWrite, verb rules (moved from mod/hooks/view.ts)
│   ├── commands.ts      # command ids and status for long operations
│   ├── events.ts        # change events for /v1/events
│   └── chat.ts          # the manager conversation
├── server-api.ts        # routes come from the catalog; runs operations in process
├── server.ts            # adds local mode (factory core)
├── client.ts            # one client for the CLI and the mods (catalog, call, events)
└── cli.ts               # each moved command calls its operation
web/                     # the web UI (aya5.11 shell) with the generic view
mod/hooks/               # the Claude mod: presentation and Claude Code hooks only
herdr/mods/factory/      # the Herdr mod: presentation only
parity-gaps.json         # the open gaps of Principle II
src/parity.test.ts       # the parity check
```

**Structure Decision**: one repository, as today. The core is a directory of `src/`, so the CLI and the server share it with no package boundary.

## Delivery

| Phase | Tasks | Result |
| --- | --- | --- |
| Setup | T001 catalog | The catalog exists and serves the 14 current routes in process. |
| Foundational | T002 operations, T003 worker screen, T004 local core, T005 guards, T006 manager chat, T007 parity check | Every feature is an operation. The local core runs the factory. The build checks parity. |
| US1, US2, US5 | T008 CLI, T009 Claude mod, T010 Herdr mod, T011 web UI | The four front ends are clients with the same features. |
| US2, US3, US4 | T012 parity scenario | The 12-step scenario passes in each front end in local mode. |
| Polish | T013 docs and cutover | The live home moves to the local core through the lease (owner-held). |

Server mode: the same front-end code connects to the spec 004 server when it exists. The server-mode run of the parity scenario joins akiq.19 (both modes in CI).

## Rollout

1. T001 to T007 add code beside the current paths. The Claude mod manager on the live home does not change.
2. T008 to T011 change one front end each. Each front end works with no core (it falls back to the CLI in process) until T013.
3. T013 is owner-held. The owner stops the Claude mod manager. The owner starts `factory core`, and the lease moves. The rollback reverses this change. Stop the core. Then start the Claude mod manager.

## Complexity Tracking

| Item | Why it is necessary | Simpler choice and why it is not enough |
| --- | --- | --- |
| A local core process | The front ends must work with all front ends closed (US3). Without it, the Claude mod or the Herdr mod must keep its own tick and timers. | Keep the tick in the Claude mod: then the other front ends cannot run the factory, which breaks Principle II. |
| A generic view in each front end | A new operation must reach all four front ends with no front-end code (FR-007). | A hand view for each operation in each front end: four copies of each feature, which is the cause of the gap. |
