# Remote runner: station workers in AX microVMs on gtr

**Status (2026-10-06 13:30): Substrate v0.3.0 and AX v0.3.1 are installed on gtr** (images
`ghcr.io/stigenai/substrate/*:v0.3.0-stigenai.2` and `ghcr.io/stigenai/ax/*`; atelet runs on gtr-150..153 only,
which carry `ate.dev/substrate-version`). Only the `gvisor-default` SandboxConfig exists: no microVM class yet.
The prototype now targets AX v0.3.1, whose Workspace has no `files`, so the brief travels in the Task's env
(`FACTORY_BRIEF`). Next: a worker image with the v0.3.1 runner, an `ax` CLI built at v0.3.1 on the laptop,
the `factory` atespace and the agent-vault, then one station end to end.

## Gates

| Gate                                                    | State                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| gtr serves ClusterTrustBundle and PodCertificateRequest | **open** (2026-10-06: `kubectl --context gtr api-resources --api-group=certificates.k8s.io` lists both, v1beta1) |
| Registry for the worker image                           | **open**: private `ghcr.io/stigenai/factory-worker` (your answer); you run the push                              |
| Laptop 5-min load under 12 for a kind trial             | moot: Substrate and AX are installed on gtr, so no kind trial is needed                                          |

`hack/push-worker.sh` builds the worker image on the `gtr-amd64` buildx builder (buildkit running on gtr), not on the arm64 laptop, and pushes it.

## What works

- A KubeVirt Ubuntu VMI on gtr boots in about 31 s and reaches api.anthropic.com, api.github.com and npm in 50-70 ms (from the earlier spike).
- In a scratch agent-vault, a dummy bearer was swapped for the real test credential (hash matched), and a bad agent token was refused with 407 (from the earlier spike).
- The Kubernetes API service proxy read a file inside a VM in 0.36 s (from the earlier spike).
- gtr serves the certificate APIs Substrate needs:

```
$ kubectl --context gtr api-resources --api-group=certificates.k8s.io
NAME                         SHORTNAMES   APIVERSION                    NAMESPACED   KIND
certificatesigningrequests   csr          certificates.k8s.io/v1        false        CertificateSigningRequest
clustertrustbundles                       certificates.k8s.io/v1beta1   false        ClusterTrustBundle
podcertificaterequests                    certificates.k8s.io/v1beta1   true         PodCertificateRequest
```

- **The prototype**, against a fake `ax` and a fake `claude`. `bun test src` passes 36 tests, 10 of them new (`src/ax.test.ts`, `src/remote.test.ts`):
  - launching applies a Workspace (the run's branch, with the brief as a file) and a Task (`factory worker serve --model …`)
  - poll and prompt go through `ax ssh`, with prompts in base64
  - the worker briefs once, then runs queued prompts as `--resume <session>` turns, and a restarted worker does not brief again
  - inside a VM, `report`, `mail` and `memory add` only append to the outbox
  - a tick replays an AX worker's report from its outbox, advances the run and deletes the task and workspace
  - a worker that asked the manager is suspended, the answer resumes it first, and the mail is delivered on the next tick
- **The worker image**: `docker buildx build --check -f Dockerfile.worker .` reports `Check complete, no warnings found.`, and every base image resolves, including `golang:1.27-bookworm` and the stigenai agent-vault digest. It has not been built yet (load gate).

## What AX gives us (read from google/ax at ac23328; installed: v0.3.1)

- **Task**: `spec.image`, `spec.command`, `spec.env`, `spec.resources`, `spec.workspaces`, `spec.debug`. Phases are `Pending`, `Running`, `Suspended`, `Failed` and `Terminating`.
- **Workspace**: `spec.git` (repo, branch, `dir`); `spec.files` exists at ac23328 but not in v0.3.1. The runner prepares each workspace once, using a marker under `/ax`, and the directory survives suspend and resume.
- **Runner contract** (docs/runner.md): PID 1 is `/usr/local/bin/ax-task-runner`. It serves `/healthz` and `/readyz` on port 80 and runs `spec.command` in the first workspace. It stays up after the command exits and forwards SIGTERM.
- **CLI**: `ax apply -f -`, `ax get task <n>` (YAML), `ax suspend task`, `ax resume task`, `ax delete task|workspace`, and `ax ssh <task> -- cmd` (needs `spec.debug: true`). `ax` parses `-a`, `-n`, `--server` and `--context` anywhere on its command line, including after `--`. That is why prompts travel as base64.
- **Networking**: tasks have no Service. Everything goes through `atenet-router` with header `ate-target-actor: <atespace>/<task>`, and the router **resumes a suspended task** before it proxies the request.
- What AX does not give: a way to talk to a running agent. The runner runs the command once, and nothing feeds it more input. The factory needs nudges and mail, so the worker supervises its own Claude turns.

## Design (as built)

### The seam in the runner

A herdr worker is touched in four places: `spawn`, `paneInfo`, `herdr agent prompt` and `herdr pane close`. The run's context already keeps the worker's address in `c.pane`. An AX worker's address is `ax:<task>`, and that prefix routes the four calls to `launchTask`, `taskInfo`, `deliver` and `closeWorker` (`src/cli.ts`, over `src/ax.ts`). The machine and the snapshots are unchanged, and herdr runs take the same code path as before.

### A station as an AX Task

- **One Task per worker launch**, named `f-<run>-<seq>` (an RFC 1123 label of at most 63 characters, keeping the seq), in atespace `factory` (`FACTORY_AX_ATESPACE`). It has one Workspace of the same name, mounted at `/workspace/w`.
- **Workspace**: the run's branch cloned into `/workspace/w/repo` (`git: [{repo: <https remote>, branch, dir: repo}]`). The brief travels in the Task's env as `FACTORY_BRIEF` (v0.3.1's Workspace has no `files`), so it never lands in the repo. Before applying the Task, the laptop pushes the run branch, because the VM clones it from GitHub. A `git@` remote is rewritten to https, because the VM has no ssh key and agent-vault brokers the GitHub credential.
- **Brief**: the same brief a herdr worker gets, with the laptop's CLI path replaced by `factory` and the worktree path replaced by `/workspace/w/repo`. It adds one line: push to `origin <branch>` before reporting.
- **Command**: `factory worker serve [--model M]` (`src/worker.ts`). It runs `claude -p --dangerously-skip-permissions --output-format stream-json --verbose` on the brief and takes the session id from the stream. Each queued prompt (`.factory-worker/prompts/`) then runs as another `--resume <session>` turn, one at a time, and the file is deleted only after its turn. **A nudge or a mail reply continues the same session.**
- **Session survival**: Claude keeps sessions in `~/.claude`, which a resumed task loses, because only `/workspace` is restored. So the Task sets `CLAUDE_CONFIG_DIR=/workspace/w/.factory-worker/claude`, and `serve` reads `state.json` so it never briefs a session twice.
- **Model**: taken from the station's `agent` string (`--model '…'`). The command is replaced, because `claude-smart` and herdr do not exist in the VM.
- **Root**: the runner is PID 1 and runs as root, and Claude refuses `--dangerously-skip-permissions` as root unless `IS_SANDBOX=1` is set. The image sets it, because the microVM is the sandbox.

### Getting `factory report|mail|memory add` back to the laptop

The Task sets `FACTORY_OUTBOX`. Inside the VM, `factory report`, `mail` and `memory add` append `{argv, from, at}` to the outbox and print `queued for the factory` (for a report, also `you are done, stop now`). Each tick, `taskInfo` runs `ax ssh <task> -- factory worker poll <cursor>`, which prints `{status, session, lines}`. It replays every line by running the same CLI command locally, with `FACTORY_FROM` set to the station and `FACTORY_OUTBOX` cleared (a test caught the replay queueing itself again). It advances `<run>/<task>.cursor` after each line. A refused command (a stale seq, a bad outcome) goes back to the worker as a prompt. After a report, the laptop runs a best-effort `git pull --ff-only` into the run's worktree.

Pulling means nothing on gtr ever needs a route back to the laptop.

`memory search` inside the VM is not wired up: it searches an empty memory (Question 3). `CORE.md` and the topic list still reach the worker in its brief.

### Suspend while a worker waits on mail

A worker that is idle and has asked the manager (the existing `isAsking`) is suspended with `ax suspend task`. Its status shows `suspended` on the board, and it is not polled. When the answer arrives, `deliver` sees the task is not `Running` and runs `ax resume task`, and the mail stays unread. The next tick delivers it to the running task.

### Credentials: agent-vault brokers everything

The VM never holds a real credential. agent-vault swaps the dummy `ANTHROPIC_API_KEY` and `GH_TOKEN` for the real keys on the way out, and the real keys enter agent-vault only through you.

The VM does hold an agent token, which lets it use the proxy. AX can't mount a Secret into a Task, so the token goes in the Task's env. To keep it short-lived, **every task gets its own agent** (your choice, (b)). With `FACTORY_AX_VAULT=<vault>@<host:port>` set, a launch runs `agent-vault agent create <task> --vault <vault>:proxy --token-only` with the laptop's agent-vault session, and sets `HTTPS_PROXY`/`HTTP_PROXY=http://<token>:<vault>@<host:port>`. Deleting the task runs `agent-vault agent delete <task>`, so a leaked token dies with its run. A launch that fails to apply deletes its agent straight away. `FACTORY_AX_ENV` (a JSON file) still adds the dummy keys and the vault's CA (`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`), but no token.

### Turning it on

```sh
# build and push the worker image on gtr's buildkit (needs `docker login ghcr.io` with write:packages)
hack/push-worker.sh    # prints image@digest
```

```sh
# on the laptop running the factory loop
export FACTORY_AX_IMAGE=ghcr.io/stigenai/factory-worker@sha256:…   # from push-worker.sh
export FACTORY_AX_ENV=~/.config/factory/ax-env.json          # CA and dummy keys, no token
export FACTORY_AX_VAULT=factory@agent-vault.<ns>:14322       # one agent per task; needs `agent-vault auth login` here
export AX_SERVER=…                                           # or let ax find it from the kube context
factory rig add web ~/repos/web --runner ax                   # rigs.json: "runner": "ax"
```

Only that rig's new workers become AX tasks. A worker already running in a pane stays there, and `--runner herdr` switches the rig back. `FACTORY_AX` points at a different `ax` binary.

## Substrate on k0s: what has to change (read, not yet applied)

Substrate's installer (`go run ./cmd/ate-setup deploy ate-system`, behind `hack/install-ate.sh`) targets kind and GKE. Read against gtr:

- **The kubelet root is `/var/lib/k0s/kubelet`** (gtr's NFS, SPIRE and Synology CSI DaemonSets all mount it). atelet mounts `/var/lib/kubelet/plugins` and `/var/lib/kubelet/device-plugins` with `DirectoryOrCreate`. On gtr it would create empty directories that no kubelet reads, so `/dev/kvm` would never be advertised and no microVM would schedule. It needs a patch to the k0s paths.
- **Image pulls**: atelet pulls actor images itself, with the node's kubelet credential provider, at GKE's paths (`/home/kubernetes/bin`, `/etc/srv/kubernetes/cri_auth_config.yaml`, both `OrCreate`, so they would be written onto gtr's nodes). k0s has no provider there. Those mounts should be dropped, and then a private registry needs some other way for atelet to authenticate (Question 1).
- **Which nodes run atelet**: atelet selects `ate.dev/substrate-version`, which the installer puts on every unlabeled node. On gtr that would include the arm64 spark nodes (no KVM) and the control plane. Only gtr-150..153 should get the label (Question 4).
- **Storage**: atelet defaults to GCS. The kind overlay runs rustfs (S3) in `ate-system`, which can be reused, with its volume on one of gtr's storage classes.
- **The microVM runtime** ships no node changes: `install-microvm-deps.sh` stages the Kata and Cloud Hypervisor assets in the bucket, and atelet fetches them. Nothing touches k0s's containerd, and the dead `kata-fc` RuntimeClass stays dead.
- **The API server's JWT issuer** is derived from GKE settings or the cluster's OIDC discovery. On k0s, set `EXPECTED_JWT_ISSUER` to the issuer gtr's service-account tokens carry.

## Open questions (mine, answered by the first real run)

- Does `ax ssh` pass stdin, and does it resume a suspended task? Neither matters to the design: prompts are arguments, and suspended tasks are not polled.
- Cost of `ax ssh` per tick: one gRPC exec per working worker every 5 s. If that is too heavy, poll less often, or serve the outbox from the runner through `atenet-router`.
- Does agent-vault inject GitHub credentials into git's https Basic auth as it does for bearer APIs? If not, the Task sets `GIT_ASKPASS` to print the dummy token, and agent-vault swaps it.

## Answers (2026-10-06)

1. **Registry**: push to private `ghcr.io/stigenai/*`. Images: `substrate/<component>:v0.3.0`
   (`ate-setup deploy --image-repo ghcr.io/stigenai/substrate --image-tag v0.3.0`), `ax/ax-server:ac23328`,
   `factory-worker:<commit>`. Each namespace needs a pull secret, and atelet needs another way to pull
   actor images, because it doesn't read pull secrets (see Substrate on k0s).
2. **Agent token**: AX can't mount a Secret, so (b): one agent-vault agent per task, deleted with it (built; see the credentials section).
3. **Memory search in the VM**: an empty search is fine for a first run.
4. **Node labels**: label only gtr-150..153 with `ate.dev/substrate-version`.
5. **Worker commits**: keep the bot identity (`claude-factory worker`), as the image does today.

## Questions for the user

None open.
