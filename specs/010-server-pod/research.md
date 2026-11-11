# Research: Factory server pod as the control plane

Date: 2026-11-11. Sources: the code on origin/main 5b736d38, the cluster the cluster, the GitOps repo, and the AX fork.

## R1. Most of the pod exists already

- **Decision**: Use `Dockerfile.server`, `deploy/server.yaml` and `factory server` (`src/server.ts`, `src/server-api.ts`). Do not write a new server.
- **Rationale**:
  - `factory server` has the tick loop, the server lease (`<home>/server-lease.json`), the home backup job and `/healthz` on 8080.
  - It also has the client port 8444 with person mTLS and the web page on `GET /`.
  - The worker port 8443 takes a task token.
  - The catalog has 27 `/v1` routes, and mutating calls need an `Idempotency-Key`.
  - `deploy/server.yaml` has namespace `factory`, a ServiceAccount, RBAC, PVC `factory-home` and a Deployment with one replica.
  - Namespace `factory` does not exist on the cluster. So nothing from it runs.
- **Alternatives**: a new service. Not chosen, because it would be a second interface (spec 008 FR-003).

## R2. The pod needs a server-mode environment, not the laptop paths

- **Decision**: Add one mode switch for the pod: `FACTORY_SERVER_MODE=1`. Code that checks `inAx()` or laptop paths must read this mode too:
  - repo and worktree mapping
  - `bd dolt`
  - `repos sync`
  - the worktree root, which today is `~/.herdr/worktrees`
  - the account-swap state, which today is `~/.claude-switch-backup`

  Put all of these paths on the home volume.
- **Rationale**: Today `FACTORY_IN_AX` is unset in the pod. So `repos sync` refuses outside AX (`cli.ts:9469`), and worktrees default to `~/.herdr/worktrees`.
- **Alternatives**: set `FACTORY_IN_AX=1` in the pod. Not chosen, because that mode also means "in a VM behind the egress gateway", and the pod is not.

## R3. Exactly one ticker: the server lease and the manager lease are two locks today

- **Decision**: In server mode, the pod's tick takes the manager lease (`leases.ts`), as `factory tick` does. The server lease stays as the guard for one pod process.
  - A `factory tick`, `patrol` or `loop` that runs while the pod holds the manager lease refuses. It names the pod.
  - `lease()` (`ax.ts:959`) refuses to start while a live AX manager task holds a lease. That check must use the manager lease, not the task name.
- **Rationale**: Today the server tick does not take the manager lease (`cli.ts:604`). So a mod tick and a server tick can run on one home. This is the "two writers" problem.
- **Alternatives**: a Dolt compare-and-set lease. Not now: spec 004 FR-012 is out of scope.

## R4. Halt order: commands and ticks need one writer

- **Decision**: In the pod, `stop`, `resume` and the tick write the halt state in one queue.
  - `/v1/halt` and the CLI `stop` and `resume` take `tick.lock`, or they post into the tick queue.
  - `haltStep` reads `halt.json` and `resume.json` again under the lock, right before it writes.
  - Bead claude-factory-sg4s3 (loop `w3KZ`) makes this fix for today's design. This spec reuses it.
- **Rationale**:
  - The tick holds the `halt` object it read at `cli.ts:8128`, and it writes the whole file at `cli.ts:4956`.
  - `stop` (`cli.ts:14054`) and `resume` (`cli.ts:14062`) take no lock.
  - The 2026-11-11 lost resume happened through this race.
- **Alternatives**: a version number on `halt.json` with compare-and-swap. This is possible, but the lock is smaller.

## R5. The pod drives the manager task with the `ax` CLI and a bearer token

- **Decision**: The pod runs `ax` against `ax-server` over https. It sets:
  - `AX_SERVER=https://ax-server.ax-system.svc:8443`
  - `AX_AUTH_TOKEN` from a Secret
  - `AX_CA_FILE`
  - `GRPC_ENFORCE_ALPN_ENABLED=false`

  The life-cycle calls are `ax apply -f -` (create and image change), `ax get task`, `ax suspend task`, `ax resume task`, `ax delete task` and `ax delete workspace`, and `ax stdio` (exec). The calls go through `ax.launchManager` (`ax.ts:1263`).
- **Rationale**:
  - The factory uses the `ax` CLI and not kube CRDs (`ax.ts:~300`). `ax-server` checks `AX_AUTH_TOKEN` (constant-time compare).
  - The CLI sends the token only over https.
  - A delete removes `/workspace/w`. That is safe now, because the task holds no state.
- **Alternatives**: kube RBAC on CRDs. Not possible, because AX keeps state in Redis and has no `task.ax.io` CRD.
- **Open check**: verify that `factory-ax-auth` is set on the cluster. Without it, `ax-server` runs with auth off.

## R6. The manager session needs more `/v1` operations and its own identity

- **Decision**:
  - **Identity:** the manager gets a client certificate signed by the person CA, with `CN=manager`. The pod applies a small rights set to it:
    - Allowed: the reads, mail, decide on a run, `say`, and the patrol operations.
    - Refused: halt, image changes and rig deletion (FR-019).
  - **Operations:** the patrol commands that are refused in server mode today become catalog operations:
    - `poke`, `retry`, `fork`, `rm`, `queue`, `rig set`, `sweep`, `adopt`, `unhold`
    - `memory search` and `memory add`
    - `plan facts`, `plan set`, `gate-brief facts`, `gate-brief set`, `review facts`, `review set`
    - the patrol, pm, brief and review logs, and `manager-usage`
  - **Overlap:** spec 008 epic claude-factory-hpmc already plans the catalog. This plan adds tasks only for the operations that hpmc does not list.
- **Rationale**:
  - `client.ts:56` refuses these commands, and `FROM_ALLOWED` (`client.ts:19`) lets a manager do only mail, show, status, prs, backlog, decisions, plan and metrics.
  - The mod writes `patrol-log.jsonl` and other files under `rt.home`.
  - `op.rights` is not checked today, so every person certificate counts as the owner.
- **Alternatives**: a manager token on the worker port. Not chosen, because the worker port is for runs and seqs (spec 004 FR-003).

## R7. The manager task holds only the session

- **Decision**: A new host mode, `factory manager session`, runs in the task. It starts sshd and attach, herdr headless and the Claude manager (`managerCommand`, `superviseManager`). It does not do:
  - restore, backup or memory warm
  - `repos sync`
  - a home of its own

  It sets `FACTORY_SERVER=<pod>` with the manager certificate. In server mode the mod does not tick: `ensureTicking` is off, and `factory tick` reads the board.
- **Rationale**: These parts of `managerhost.host` (`managerhost.ts:329`) are about state, and they move to the pod: `awaitHome`, `restoreStep`, `warmMemory`, `reposSync` and `backupStep`.
- **Session resume**: an image change deletes the task. So the Claude session transcript in `/workspace/w/claude` is lost. The new session gets a brief from the pod: open decisions, mail and the plan. This meets user story 2, scenario 2.

## R8. `say` becomes a `/v1` operation

- **Decision**: Add `POST /v1/manager/say`. The pod sends the text to the manager pane with `ax stdio <task> -- herdr pane send-text`, as `ax.say` (`ax.ts:1301`) does today from the laptop.
- **Rationale**: `say` types into a pane. Only the pod has the `ax` CLI and router to reach the task.

## R9. The herdr mod calls `/v1` over HTTPS, not `exec` through `hc`

- **Decision**: In server mode, the herdr mod reads `/v1/snapshot` and posts commands with the person certificate. It uses the herdr app's fetch if the app has one, else `curl` on the laptop. Fix the `snapshot` form mismatch. The mod sends `--max-age`, and `client.ts:76` refuses it.
- **Rationale**: Each 5 s beat today pays an `hc` hop plus a fresh start of the 14k-line CLI (`main.js:60`, `view.js:215`).
- **Alternatives**: keep the CLI with `FACTORY_SERVER` on the laptop. This works, but each call still pays a CLI start.

## R10. Private web access: a LAN LoadBalancer over WARP, not the Cloudflare Tunnel

- **Decision**:
  - **Service:** a `LoadBalancer` Service `factory-server-lb` with the annotation `lbipam.cilium.io/ips: <lb-ip>`. Check first that this IP is free.
  - **Ports:** 8444 for the person (web and CLI) and 8443 for workers.
  - **DNS:** the owner adds the record `factory.<private-zone> -> <lb-ip>`, the same way as `ax.<private-zone> -> <ax-server-lb-ip>`.
  - **TLS:** it ends in the pod, so the person mTLS works. The server certificate comes from `personCerts` with that name as `serverName`.
- **Rationale**:
  - `*.<private-zone>` names in `cloudflare-tunnel/config.yaml` go through Cloudflare Access, which ends TLS at the edge. A client certificate cannot pass through that.
  - Clients reach the LAN LBs (`ax-server-lb` <ax-server-lb-ip>, `beads-dolt-lb` <dolt-lb-ip>) over WARP private routing. TLS runs end to end.
- **Alternatives**:
  - Cilium Gateway TLSRoute passthrough: the repo has no passthrough setup.
  - Cloudflare Access with SSO: it is a different login from decision 3.

## R11. The pod needs real secrets, because no egress gateway serves it

- **Decision**: The pod gets its secrets from `secret-sync items`s in the GitOps repo:
  - a GitHub token (`GH_TOKEN`, or a sophie App key for a minted token)
  - `AX_AUTH_TOKEN`
  - the backup remote auth
  - the server certificate and key
  - the person CA certificate
  - Linear (optional)

  No secret goes into the image or the git backup (FR-018).
- **Rationale**: A VM manager gets its keys from the gateway with placeholders. A pod has no gateway. The ticks run `gh` for PR checks and merges.
- **Gap**: the Claude OAuth slots are needed only if the pod runs headless `claude -p` steps. In this design the Claude session is in the task, so the pod needs no Claude token.

## R12. Manifests go to the GitOps repo

- **Decision**: Move `deploy/server.yaml` into a new overlay `<gitops-overlays>/factory/`, in the style of `hindsight/`:
  - namespace, ServiceAccount, `secret-sync items`, PVC, Deployment, Services, `CiliumNetworkPolicy`
  - PVC storage class `synology-iscsi-retain` (Retain), so a delete keeps the home

  `deploy/server.yaml` in claude-factory stays as a generic example. The owner merges and Flux applies.
- **Rationale**: Owner direction 2026-11-11. The cluster is GitOps through Flux.

## R13. Migration and rollback

- **Decision**:
  1. Pause the factory.
  2. Wait for a backup newer than the pause (the host backup works since PR 878).
  3. Suspend `f-manager`: do not delete it, so it stays as the rollback copy.
  4. Restore the backup into the PVC with `factory server restore`, or a one-shot Job.
  5. Start the pod. It takes the manager lease.
  6. Compare the run count, open decisions and last reports.
  7. Resume.
  8. Start the session-only manager task under a new name, `f-manager-session`.

  **Rollback**: Stop the pod, then resume `f-manager`. Its home is as of the pause. Replay any reports since then from the pod home with `factory migrate`. Or restore the newest pod backup.
- **Rationale**: The 2026-11-09 data loss came from a task delete. A suspend keeps the old home.
