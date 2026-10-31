# Implementation Plan: Factory server and an independent manager

**Branch**: `004-factory-server` | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-factory-server/spec.md`

## Summary

The factory becomes one server process on the AX cluster. The server runs the tick loop, starts and watches AX tasks, and runs the manager's judgment steps as headless Claude Code. Workers call a worker API with a signed per-task token. The person calls a client API with a person certificate.

The CLI keeps its commands. With `FACTORY_SERVER` set, the CLI is a client. Without it, the CLI works on a local home, as today. The first server release runs on the current file layout on a PVC. A later step moves the state to Dolt. Research: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript on Bun 1.3.13 (the version that CI and the image use).

**Primary Dependencies**: `Bun.serve` (HTTP and TLS), xstate (the run machines, unchanged), the Claude Code CLI (`claude -p` for agent steps), `ax`, `kubectl`, `git`, `gh`, `bd`, `dolt` in the server image. For SQL in step S6, use `Bun.SQL` (MySQL protocol) if spike S0 shows that it works with Dolt. Otherwise, use `mysql2`.

**Storage**: Steps S2 to S5: the current factory home files on a PVC, with one writer. Step S6: a `factory` database on the fleet Dolt server. Memory notes: a git repository on the PVC in every step.

**Testing**: `bun test src factories` and `claude plugin test mod`, as today. New: API tests that start `Bun.serve` on a random port against a temp home, the same way the CLI tests use a temp `FACTORY_HOME`. The quickstart checks run on a test namespace.

**Target Platform**: Linux containers on the AX cluster (amd64). The laptop (macOS) runs only the client.

**Project Type**: CLI plus a long-lived web service, in the same codebase.

**Performance Goals**: A report moves its run within 10 s (SC-003). The server ticks every 5 s, as the console does today, with 28 live runs (the AX pool size).

**Constraints**: One writer at a time (FR-007). No report lost or applied two times across a restart or the cutover (SC-006). Both modes stay supported: local and server (FR-014, FR-016, FR-018). Constitution I.

**Scale/Scope**: 12 rigs, up to 28 live runs, about 1,500 runs kept, 279 memory files.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle I rule                                                                               | Check                                                                                                                                                                                                                                                     | Result                                               |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| All workers get the same skills, rules and MCP servers                                         | The server does not change how a worker gets skills or rules. The worker image and `worker-system.md` stay the one source.                                                                                                                                | Pass                                                 |
| No skill or access through a path that only one backend or runner has                          | The worker API is the same for Claude, codex and pi workers, because the factory CLI calls it, not the harness. Memory search and helped now reach VM workers, which closes a gap that exists today.                                                      | Pass                                                 |
| A change for one runner must reach all runners in the same change, or file a bead for each gap | Each mode gives all of its workers one path (research R8). Local mode: herdr and AX workers use the CLI and the outbox, and an AX worker gets a memory snapshot (FR-020). Server mode: AX workers only, all through the worker API. A rig is in one mode. | Pass, with one rule: a herdr rig stays in local mode |

Re-check after Phase 1: the contracts give every endpoint to every harness. The usage endpoint takes `harness` as a field, so codex and pi usage go through the same path (FR-013). Pass.

## Project Structure

### Documentation (this feature)

```text
specs/004-factory-server/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1: Dolt tables (step S6)
├── quickstart.md        # Phase 1: checks for each user story
├── contracts/
│   ├── worker-api.md    # Phase 1: the API that workers call
│   └── client-api.md    # Phase 1: the API that the person's clients call
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── server.ts            # new: `factory server`: the tick loop, the two listeners, the step timers
├── server-api.ts        # new: request handlers; each one calls the existing CLI functions
├── tokens.ts            # new: sign, check and revoke worker tokens
├── steps.ts             # new: run a judgment step as `claude -p` with tools, a time limit and a token slot
├── client.ts            # new: the CLI's client mode when FACTORY_SERVER is set
├── cli.ts               # changed: createRun skips herdr for AX rigs; launch puts FACTORY_TOKEN in the task env
├── worker.ts            # changed: report, mail and memory calls go to the API; the outbox is the fallback
├── ax.ts                # changed: egressPolicy adds the factory server rule for every task
└── store/               # step S6 only: the Dolt adapter and `factory migrate dolt`
mod/hooks/register.tsx   # changed: server mode (FACTORY_SERVER set) runs no timers; local mode is unchanged
src/steps/*.md           # new: one prompt for each manager step, read by the mod and by steps.ts (FR-019)
deploy/server.yaml       # new: Namespace, ServiceAccount, RBAC, PVC, Deployment, Service, NetworkPolicy
Dockerfile.server        # new: oven/bun:1.3.13-debian plus claude, git, gh, bd, dolt, ax, kubectl
```

**Structure Decision**: One codebase. The server imports the same modules as the CLI, so the tick, the run machines and the memory code run unchanged in the pod. This follows the broker (`src/broker.ts`, `deploy/broker.yaml`, `Dockerfile.broker`).

## Cutover steps

Each step is a separate PR set with its own check. After each step the factory works, and the owner can go back.

| Step | What                                                                                                                                                                                                                                                                                                            | Check                                                                                                        | Way back                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| S0   | Spikes: (a) an `https` egress rule from a VM to an in-cluster Service with a cluster-CA certificate; (b) `Bun.SQL` against Dolt; (c) one judgment step as `claude -p` with JSON output and usage; (d) `Bun.serve` with `requestCert` on a second port.                                                          | Each spike has a short note in research.md.                                                                  | None needed.                                                                 |
| S1   | Make AX runs independent of the laptop, in both modes: `createRun` skips herdr for an AX rig, and a clone cache replaces the laptop worktree. Send a memory snapshot to each AX task in local mode (vffe.4).                                                                                                    | An AX run in local mode finishes with herdr stopped, and its worker gets notes from `factory memory search`. | Git revert.                                                                  |
| S2   | Deploy the server on the cluster. Split the home: the AX rigs move to a server home on the PVC, and the herdr rigs stay in the local home. The server ticks and runs the AX runner. Workers still use the outbox; the server polls it, as the laptop does now. The laptop CLI and console use `FACTORY_SERVER`. | Quickstart 4, 5, 6 and 7.                                                                                    | Copy the home back from the PVC backup and run `bin/up`.                     |
| S3   | The worker API: tokens, report, mail, memory search, add, helped, usage, prompt. The worker CLI calls it. The outbox stays as the fallback.                                                                                                                                                                     | Quickstart 1, 2 and 3. Epic claude-factory-vffe .4 closes.                                                   | Unset the server rule in the egress policy; workers fall back to the outbox. |
| S4   | Judgment steps in the server: patrol, pm, briefer, reviewer, dream, each as `claude -p` with a token slot. The `mod` plugin stops its timers when `FACTORY_SERVER` is set.                                                                                                                                      | Quickstart 4 (patrol rows). SC-005 over 7 days.                                                              | Unset `FACTORY_SERVER` in the manager session; the mod timers run again.     |
| S5   | Beads primary on the fleet Dolt server. The server runs bd against it; the laptop bd pulls and pushes. Needs dm-g14 (fleet Dolt 2.5.0).                                                                                                                                                                         | `bd ready` on the laptop and in the server agree for each rig.                                               | Point the rigs back at the laptop shared server.                             |
| S6   | State to Dolt: the adapter in `src/store/` and `factory migrate dolt`, as in data-model.md.                                                                                                                                                                                                                     | The count checks in the migration. `factory status`, `metrics` and `memory search` match before and after.   | The file home on the PVC stays as it was before the migration.               |
| S7   | Run the CLI and `mod` test suites in both modes in CI (SC-008).                                                                                                                                                                                                                                                 | The CI job passes for each mode.                                                                             | None needed.                                                                 |
| S8   | When AX issues task SVIDs, the gateway connects with them, and the server accepts the SPIFFE ID in place of the token.                                                                                                                                                                                          | Quickstart 2 with an SVID and no token.                                                                      | Tokens stay accepted until the owner removes them.                           |

## Owner steps

These steps need the owner. The factory does not do them:

- The cluster resources for S2: the namespace, the PVC, the Secrets (GitHub token, Linear token, the worker token key, the person CA) and the gateway route for port 8444.
- The fleet Dolt upgrade to 2.5.0 (dm-g14), before S5.
- The AX gateway and SVID work for S8, in the AX repos.
- Each cutover switch: stop the laptop manager in S2, and change `FACTORY_SERVER` in S4.

## Risks

- **Usage limits on agent steps.** The steps share the subscription limits with the workers. The server swaps token slots, as `ax-token best` does. Spike S0c records how a limit shows in `claude -p` JSON output.
- **The PVC is a single point of failure.** The home backup to git (`src/homebackup.ts`) runs from the server, as it does on the laptop today.
- **Egress to the server.** If spike S0a fails, use an `http` egress rule to the Service inside the cluster, with the token as the only check. Record that choice in research.md.

## Complexity Tracking

No constitution violation needs a justification. The design adds one process type (the server), which the spec requires.
