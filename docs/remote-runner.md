# Remote runner: station workers in AX microVMs on gtr

Status (2026-10-06): exploring on branch `explore/ax-remote-runner`. Nothing is installed on gtr yet.

## Gates

| Gate                                                    | State                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| gtr serves ClusterTrustBundle and PodCertificateRequest | **open** (2026-10-06: `kubectl --context gtr api-resources --api-group=certificates.k8s.io` lists both, v1beta1) |
| A registry to push Substrate, AX and worker images      | **closed**: waiting on the user (see Questions)                                                                  |
| Laptop 5-min load under 12 for a local kind trial       | **closed**: 36-38 on 2026-10-06                                                                                  |

The registry gate is now what blocks an install. Substrate v0.3.0 publishes no images that can be pulled without credentials, so every image has to be built and pushed somewhere gtr can pull from.

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

## What AX gives us (read from google/ax at ac23328)

- **Task**: `spec.image`, `spec.command`, `spec.env`, `spec.resources`, `spec.workspaces`, `spec.debug`. Phases are `Pending`, `Running`, `Suspended`, `Failed` and `Terminating`.
- **Workspace**: `spec.git` (repo and branch to clone) and `spec.files` (files to write). The runner prepares each workspace once, and its directory survives suspend and resume.
- **Runner contract** (docs/runner.md): PID 1 is `/usr/local/bin/ax-task-runner`. It serves `/healthz` and `/readyz` on port 80 and runs `spec.command` in the first workspace. It stays up after the command exits and forwards SIGTERM.
- **CLI**: `ax apply -f -`, `ax get task <n>` (YAML), `ax suspend task`, `ax resume task`, `ax delete task`, and `ax ssh <task> -- cmd` (needs `spec.debug: true`).
- **Networking**: tasks have no Service. Everything goes through `atenet-router` with header `ate-target-actor: <atespace>/<task>`, and the router **resumes a suspended task** before it proxies the request. That is the hook for waking a worker when its mail arrives.
- What AX does not give: a way to talk to a running agent. The default runner runs the command once, and nothing feeds it more input. The factory needs nudges and mail, so the worker supervises its own Claude turns (see the design).

## Design

### The seam in the runner

Today a worker is a herdr pane. `src/cli.ts` touches it in four places: `spawn` (new tab, run the agent), `paneInfo` (status and Claude session), `herdr agent prompt` (mail, nudges, the time warning) and `herdr pane close`. The run's context already stores the worker's address in `c.pane`.

An AX worker keeps the same shape. `c.pane` holds `ax:<task>`, and that prefix sends each of the four calls to `src/ax.ts` instead of herdr. Nothing in the machine or the snapshot changes, and herdr runs are untouched.

### A station as an AX Task

- **One Task per worker launch**, named `f-<run>-<seq>` (an RFC 1123 label of at most 63 characters). It runs in atespace `factory`, with one Workspace of the same name.
- **Workspace** = the run's branch: `git: [{name: origin, repo: <rig's https remote>, branch: <run branch>}]`. The brief goes in as a file: `files: [{path: .factory-worker/brief.md}]`. Before applying the Task, the laptop pushes the run branch, because the VM clones it from GitHub.
- **Command**: `factory worker serve`, from the factory CLI baked into the image. It starts `claude -p --dangerously-skip-permissions --output-format stream-json --verbose [--model M]` on the brief, records the session id, then waits. Every later prompt (a nudge, a mail, the time warning) arrives as a file in `.factory-worker/prompts/`. It runs as `claude -p --resume <session> …`, one turn at a time, so **a nudge or a mail reply resumes the same session**. Skipping permissions is acceptable here because the microVM is the boundary.
- **Model**: taken from the station's `agent` string (`--model '…'`). The command itself is replaced, because `claude-smart` and herdr do not exist in the VM.

### Getting `factory report|mail|memory` back to the laptop

The CLI in the VM runs with `FACTORY_OUTBOX=/workspace/<ws>/.factory-worker/outbox.jsonl`. `report`, `mail` and `memory add` append one JSON line there and do nothing else. The laptop pulls on each tick with `ax ssh <task> -- factory worker poll <cursor>`. That prints `{status, session, lines}`, where `status` is `working` while a turn runs, `idle` between turns, or `exited`. The laptop replays each line as if the worker had run the command locally: a report or mail goes to the run's `inbox.jsonl`, and a memory note is added to the shared memory. A report also makes the laptop `git fetch` the run branch into the worktree, so later stations and `factory status` see the commits.

Pulling keeps the laptop unreachable from the cluster. Nothing on gtr needs a route back to the laptop.

`memory search` in the VM cannot be answered from the outbox, because a search has to return results inside the same command. The prototype puts `CORE.md` and the topic READMEs in the brief (as today). A search in the VM then greps a copy of the memory directory shipped in the Workspace's `files` (see Questions).

### Suspend while a worker waits on mail

When the worker is idle and has asked the manager a question (the existing `isAsking` check), the laptop runs `ax suspend task`, and Substrate snapshots the VM. When mail for that station arrives, the laptop runs `ax resume task` and then delivers the mail as a prompt. The router would also resume the task on the first request, but the explicit resume keeps the order clear. A suspended worker is never polled.

### Credentials: agent-vault brokers everything

The VM never holds a real credential. Its environment carries dummy `ANTHROPIC_API_KEY` and `GH_TOKEN` values, plus `HTTPS_PROXY=http://<agent-token>:<vault>@agent-vault.factory-spike-vault:14322` and the vault's CA (`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`). agent-vault swaps the dummies for the real keys on the way out: Anthropic for Claude, GitHub for git and gh. The real keys enter agent-vault only through the user.

### How a rig opts in

```sh
factory rig add web ~/repos/web --runner ax     # rigs.json: "runner": "ax"
```

Only runs on a rig with `runner: "ax"` launch AX tasks, and every other run stays a herdr pane. The `ax` binary, its server (`AX_SERVER`, or auto-detected from the kube context) and the image (`FACTORY_AX_IMAGE`) come from the environment of the laptop's factory loop.

## Open questions (mine)

- Does `ax ssh` pass stdin? The prototype puts prompt text in an argument (base64) so it does not depend on stdin.
- Does `ax ssh` resume a suspended task? Polling skips `Suspended` tasks either way.
- Cost of `ax ssh` per tick: one gRPC exec per working worker every 5 s. If that is too heavy, poll every 30 s, or serve the outbox over HTTP from the runner through `atenet-router`.

## Questions for the user

1. **Registry**: may I push the Substrate, AX and worker images to private `ghcr.io/stigenai/*` packages, with a pull secret in `ate-system`, `ax-system` and the task namespace? Until you say so, every image is built locally only.
2. **Agent token in the Task**: AX's `spec.env` is plain text in the Task, and it has no secretRef. The agent-vault agent token in `HTTPS_PROXY` is scoped to the proxy and revocable. Is it acceptable to put it in `spec.env`, or should the worker image read it from a mounted Secret?
3. **Memory search in the VM**: is grep over a shipped copy of the memory good enough for remote workers, or should the image carry the bge-small embedding model?
