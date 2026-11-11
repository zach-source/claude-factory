# Data Model: Factory server pod as the control plane

All state is files in the factory home on the pod volume, as today. This feature adds no database.

## Server pod

| Field | Source | Rule |
| --- | --- | --- |
| holder | `hostname/pid/rand` (`server.ts:80`) | One pod process holds the server lease. |
| mode | `FACTORY_SERVER_MODE=1` | Paths for worktrees, repos and account-swap state are under the home volume. |
| ports | 8080 health, 8443 workers, 8444 person and manager | 8444 needs a client certificate from the person CA. |

## Manager lease (`leases.ts`)

| Field | Rule |
| --- | --- |
| holder | In server mode, this is the pod. Any other ticker refuses and names it (FR-002). |
| renewed | The pod renews it while it ticks. If it is stale, another pod can take it. A mod tick in server mode never takes it. |

## Halt state (`halt.json`, `resume.json`)

| Field | Rule |
| --- | --- |
| state | One of `running` (no file), `stopping`, `paused`. |
| at | The time of the person command that set the state. |
| seq | New: a number that each person command raises by one. A tick writes the halt state only if `seq` is the same as when it read it (contracts/halt-order.md). |
| told, closed | As today. |

State changes:

- running → stopping: on `stop`.
- stopping → paused: when the tick sees all workers closed.
- stopping or paused → running: on `resume`.

The tick and the commands make these changes in one order (FR-003).

## Manager identity

| Field | Rule |
| --- | --- |
| certificate | Client certificate with `CN=manager`, signed by the person CA. The pod keeps it in a Secret. The pod gives it to the manager task when the pod creates the task. |
| rights | Allowed: reads, mail, `say`, run decide, and the patrol operations (contracts/manager-api.md). Refused: halt, image changes, `rig rm`, certificate changes (FR-019). |

## Manager task

| Field | Rule |
| --- | --- |
| name | `f-manager-session`. It is a new name, so the old `f-manager` stays suspended as the rollback copy. |
| image | `FACTORY_AX_MANAGER_IMAGE`. Only the person changes it (FR-019). |
| command | `factory manager session` (R7). The task holds no factory home. |
| env | `FACTORY_SERVER=<pod>`, the manager certificate, the Claude token slots, and the egress keys (as `managerEgress`, but without the home backup). |
| health | `up`, `starting`, `down` or `limited`, with the reason. The pod shows it on every front end (FR-006). |

## Home volume and backup

| Item | Rule |
| --- | --- |
| PVC | `factory-home`, class `synology-iscsi-retain`, ReadWriteOnce. It is the main copy (FR-004). |
| Backup | The git branch `manager-home`. The command `factory server backup` writes it. Its age shows on every front end (FR-005). |
| Secrets | Not in the PVC paths that the backup takes, and not in the image (FR-018). |

## Private name

| Item | Value |
| --- | --- |
| Service | `factory-server-lb`, type LoadBalancer, `lbipam.cilium.io/ips: <lb-ip>` (verify that it is free). |
| DNS | `factory.<private-zone> -> <lb-ip>`. The owner adds it. |
| Server certificate | `serverName` = that name, from `factory cert person`. |
