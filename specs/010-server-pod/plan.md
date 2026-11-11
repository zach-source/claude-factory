# Implementation Plan: Factory server pod as the control plane

**Branch**: `spec/010-server-pod` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/010-server-pod/spec.md`

## Summary

One cluster pod becomes the control plane of the server-mode factory.

- **What the pod runs:** `factory server`, which exists already (R1). It ticks, it holds the manager lease, and it serves `/v1` and the web page.
- **Where the home is:** on a Retain PVC.
- **The manager task:** the pod starts it, as a session-only AX task (R7). That task runs the Claude manager session and calls `/v1` with a manager certificate (R6).
- **The front ends:** all four use `/v1` in server mode. The herdr mod calls HTTPS directly (R9).
- **Browser access:** a LAN LoadBalancer IP on a `<private-zone>` name over WARP, with TLS that ends in the pod (R10).
- **Manifests:** they go to the GitOps repo (R12). The owner merges them, and Flux applies them.

## Technical Context

**Language/Version**: TypeScript on Bun (as today). Kubernetes YAML for Flux.
**Primary Dependencies**:
- the existing `factory server`, the catalog (`src/core`), `src/client.ts` and `src/ax.ts`
- the `ax` CLI, `gh`, `git`, `bd`, `dolt` and `gitleaks` in `Dockerfile.server`
- Cilium LB IPAM and the the password vault operator in the cluster

**Storage**: files on a PVC (`synology-iscsi-retain`). The git home backup is the second copy. No Dolt state (spec 004 FR-012 is out of scope).
**Testing**: `bun test` (unit and integration with a temp home), `kubectl apply --dry-run=client` and `kustomize build` for the manifests, and the quickstart scenarios on the cluster.
**Target Platform**: the the cluster k0s cluster (amd64), and the AX VMs for the manager task.
**Project Type**: a CLI and server in one codebase, plus GitOps manifests in a second repo.
**Performance Goals**:
- `factory status` under 2 s at p95 (SC-004)
- herdr views under 1 s (SC-005)
- cross-front-end change within 5 s (SC-006)
- a pod restart stops ticks for under 2 min (SC-003)

**Constraints**:
- exactly one ticker (FR-002)
- no secret in the image or the backup (FR-018)
- local mode unchanged (FR-017)
- AX allows at most 32 env entries for each task

**Scale/Scope**: one factory home, about 14 rigs, up to 40 live runs and 28 AX worker slots.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
| --- | --- | --- |
| I. Worker Parity | AX workers do not change (FR-014). Every worker gets the same skills and rules from `src/worker-system.md`. The worker API stays the spec 004 one. | Pass |
| II. Front-end Parity | All four front ends use the one `/v1` interface in server mode (FR-010, FR-011). New manager operations go into the catalog (R6), not into the mod. A front end that cannot show an operation gets a gap entry in `parity-gaps.json` with a bead. | Pass |
| II. Local and server mode | Local mode stays (FR-017, user story 6). The server mode switch (R2) is the only new mode flag. | Pass |
| Governance | The spec PR names its changes to specs 004 and 008. | Pass |

Re-check after Phase 1: pass. The contracts add routes to the existing catalog only. The herdr mod and the web page hold no logic (contracts/herdr-client.md).

## Project Structure

### Documentation (this feature)

```text
specs/010-server-pod/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── halt-order.md        # one writer for the halt state
│   ├── manager-api.md       # manager identity, rights, new /v1 operations
│   ├── manager-task.md      # session-only task and its life cycle from the pod
│   ├── herdr-client.md      # the herdr mod over /v1
│   └── cluster.md           # manifests, Services, secrets, DNS
└── checklists/requirements.md
```

### Source Code (repository root)

```text
claude-factory/
├── src/server.ts            # tick takes the manager lease in server mode (R3); manager task supervision job (R5)
├── src/server-api.ts        # manager identity and rights on the client port (R6)
├── src/core/catalog.ts      # new operations: patrol commands, say, manager logs (R6, R8)
├── src/core/ops/            # one file for each new operation group
├── src/client.ts            # server mode for the new operations; snapshot --max-age (R9)
├── src/cli.ts               # FACTORY_SERVER_MODE paths (R2); halt order (R4, with sg4s3)
├── src/managerhost.ts       # `factory manager session` host mode (R7)
├── src/ax.ts                # launchManager from the pod; lease check by manager lease (R3, R5)
├── mod/hooks/register.tsx   # no tick in server mode; logs through /v1 (R7)
├── herdr/mods/factory/      # fetch /v1 with the person certificate (R9)
├── Dockerfile.server        # tools the tick needs (verify ax CLI, gitleaks)
└── docs/remote-runner.md    # server pod runbook, migration, rollback

the GitOps repo/
└── <gitops-overlays>/factory/
    ├── namespace.yaml  serviceaccount.yaml  secret-sync-item.yaml
    ├── pvc.yaml  deployment.yaml  service.yaml  service-lb.yaml
    ├── networkpolicy.yaml  kustomization.yaml  README.md
```

**Structure Decision**: The code stays in the one claude-factory codebase (spec 004 FR-018). The cluster manifests move to the GitOps repo. `deploy/server.yaml` stays as a generic example.

## Phases and order

Each phase leaves a working factory (spec 004 FR-016).

| Phase | Work | Needs | Overlap with existing beads |
| --- | --- | --- | --- |
| A | Halt order: one writer (R4) | none | claude-factory-sg4s3 (in progress, loop `w3KZ`) |
| B | Server mode paths and env (R2), and the tick takes the manager lease (R3) | A | akiq (server epic) |
| C | Manager identity and rights; new catalog operations (R6, R8) | B | hpmc (catalog), aya5 (control API) |
| D | The herdr mod over `/v1` (R9) | C for actions; reads can start now | hpmc (Herdr views), ql0jz (closed: speed) |
| E | Session-only manager task, and pod supervision of it (R5, R7) | C | none |
| F | Cluster overlay in the GitOps repo, secrets and the LB name (R10, R11, R12) | B | none (owner merges and applies) |
| G | Migration of the live home and the rollback (R13) | A to F | none (owner go-ahead) |
| H | Retire the `f-manager` host path after 30 days | G | none |

## Complexity Tracking

| Item | Why it is needed | Simpler choice rejected because |
| --- | --- | --- |
| A manager certificate with rights checks | FR-019: the manager must not change halt or images. `op.rights` is not checked today. | One owner certificate for the manager gives the manager owner rights. |
| A LoadBalancer IP and not the Cloudflare Tunnel | Decision 3 needs the person certificate (mTLS), and the Tunnel ends TLS at the edge. | Cloudflare Access is a different login. |
