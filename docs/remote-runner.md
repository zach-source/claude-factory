# Remote runner: station workers in AX microVMs on gtr

**Status (2026-10-11 13:02): a worker runs end to end on gtr, with agent-vault supplying every key.** A
read-only smoke task (image `factory-worker:26670e1`, `FACTORY_AX_VAULT=factory`) cloned private
`stigenai/spindle` through the egress gateway as the nixfleet-axel bot, ran Claude (Anthropic answered), called
`gh api` (the installation's 48 repos) and reported back through the outbox. No key was copied anywhere:
agent-vault reads the Claude token from 1Password Connect and mints the GitHub token from the axel App, whose
private key it reads from 1Password. Running on the agent-vault PRs #12 and #13 (merged into one test image) and
with the gateway pointed at the factory's agent-vault in `factory-spike-ax`, not six-city's. Next: one real
station end to end. Earlier (2026-10-07): suspend and resume kept the clone and the session; a `factory mail` in
the VM came back through `poll`. Egress history: sdsmint makes `https` rules MITM; the gateway's DNS cache is
`V4_PREFERRED` on gtr (with `ALL` it picked api.anthropic.com's IPv6 address, which gtr can't route). Oddity for
the install's owner: example.com (Cloudflare, 172.66.147.243) gets 503, the gateway's upstream TLS reporting a
certificate for api.anthropic.com.

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

## On gtr (2026-10-06, Substrate v0.3.0-stigenai.2, AX v0.3.1, gVisor)

- CLIs: `go install github.com/google/ax/cmd/ax@v0.3.1`, which tunnels to `ax-system/svc/ax-server` through
  the kube context on its own. `kubectl-ate` has to be built from the v0.3.0 source tree, because
  `go install` refuses it over its replace directives.
- An atespace (`factory`) exists as soon as something is applied to it.
- A smoke Task with the worker image went Pending to Running in about 25 s. Over `ax ssh`: Claude Code
  2.1.291, bd 1.3.0, gh 2.98.0, agent-vault, bun 1.3.13, `factory worker poll 0` →
  `{"status":"exited","lines":[]}`, uid 0 with `IS_SANDBOX=1`, kernel `4.19.0-gvisor`.
- **Egress is per actor, and AX sets none.** Without an EgressPolicy the gateway logs
  `egress denied: actor has no egress policy`. The policy lives in Substrate, not AX:
  `kubectl ate create egress-policy <task> -a factory -f policy.yaml`. The runner will have to create it
  after `ax apply`. That suits the design: a worker's policy can allow agent-vault and nothing else.
- With `http: {hostnames: ["example.com"]}`, `curl http://example.com/` returned 200 in 0.097 s.
- `tls_passthrough` rules do nothing in v0.3.0 (`internal/egresspolicy/egresspolicy.go`: "tls_passthrough
  rules match nothing for now"): the tunnel opens with `sniRules: 0`, and the TLS is closed (`flags=UH`).
- An `https: {hostnames: ["api.github.com"]}` rule registers (`sniRules: 1`), but the connection still
  fails: `https` means the gateway terminates the TLS, and this install's gateway runs without MITM ("No
  MITM here" in its Envoy config; the demo turns it on with `--experimental-use-sdsmint`).
- Through agent-vault (scratch vault in `factory-spike-ax`, policy allowing only cleartext HTTP to its
  Service): `agent-vault ca fetch` from the task worked, so plain requests to the vault pass. The proxy's
  `CONNECT api.github.com:443` got 403 from the gateway (`egress denied: no rule allows the destination`,
  `method: CONNECT`, `host: api.github.com:443`). Cleartext rules match the request's Host, which for a
  proxy is the upstream, not the vault, and a rule for the upstream would send the request around the vault.
  agent-vault offers only `CONNECT` and absolute-form proxying, both of which name the upstream.

## What AX gives us (read from google/ax at ac23328; installed: v0.3.1)

- **Task**: `spec.image`, `spec.command`, `spec.env`, `spec.resources`, `spec.workspaces`, `spec.debug`. Phases are `Pending`, `Running`, `Suspended`, `Failed` and `Terminating`.
- **Workspace**: `spec.git` (repo, branch, `dir`); `spec.files` exists at ac23328 but not in v0.3.1. The runner prepares each workspace once, using a marker under `/ax`, and the directory survives suspend and resume.
- **Runner contract** (docs/runner.md): PID 1 is `/usr/local/bin/ax-task-runner`. It serves `/healthz` and `/readyz` on port 80 and runs `spec.command` in the first workspace. It stays up after the command exits and forwards SIGTERM.
- **CLI**: `ax apply -f -`, `ax get task <n>` (YAML), `ax suspend task`, `ax resume task`, `ax delete task|workspace`, and `ax ssh <task> -- cmd` (needs `spec.debug: true`). `ax` parses `-a`, `-n`, `--server` and `--context` anywhere on its command line, including after `--`. That is why prompts travel as base64.
- **Networking**: tasks have no Service. Everything goes through `atenet-router` with header `ate-target-actor: <atespace>/<task>`, and the router **resumes a suspended task** before it proxies the request.
- What AX does not give: a way to talk to a running agent. The runner runs the command once, and nothing feeds it more input. The factory needs nudges and mail, so the worker supervises its own Claude turns.

## Design (as built)

### The Runner interface

Where a worker runs is one interface, `Runner` in `src/runner.ts`. The reconciler holds a worker's address in the run's context (`c.pane`) and calls `runnerOf(address)` for everything it does to it. A rig's `runner` names the runner that launches its workers.

```ts
export type Runner = {
  name: string
  /** the worker's pane and conversation live on this machine: it can be restarted in place, its transcript read, the trust dialog matters */
  local: boolean
  launch(job: Job): string // the worker's address
  info(run: Run, address: string): WorkerInfo | null // { status, agent?, session? }; null once gone
  deliver(address: string, text: string): boolean // false: not delivered yet, try next tick
  close(address: string): void
  suspend?(address: string): void // park a worker that waits on someone
  phase?(address: string): string | null // state without side effects, for listings
}
export const runners: Record<string, Runner> // the registry
export function runnerOf(address: string): Runner
```

`Job` is what a launch needs: the run, factory, station, context, the session to resume (if any), the prompt file, and `brief()` (the whole brief, for a runner whose workers start with no conversation).

- **herdr** is one implementation. Its address is the bare pane id, as before, so runs in flight keep working; `local: true`.
- **ax** is another (this document). Its address is `ax://<task>`; `local: false`; it implements `suspend`.
- `runnerOf` reads a registered runner name before `://`; anything else means herdr. herdr's pane ids have a `:` (`wA6:p1`) but never `://`, so a runner other than herdr gives addresses `<name>://<id>`.
- `local` replaces the old `isAx` branches: a worker that is not local is not restarted in place when it disappears (its session is where it ran), is not relaunched or retyped as a pane's agent would be, has no transcript on the laptop (the runner hands over its last entry, `WorkerInfo.tail`, for the usage limit and the context size), is not held by Claude's trust dialog, and its workspace panes are not reaped as strays.

**Adding a third runner**: write a module that implements `Runner` and register it (`runners.<name> = …`). Then `rig add --runner <name>` accepts it (the error lists the registered names) and nothing in the reconciler changes. The machine and the snapshots do not know runners exist.

### A station as an AX Task

- **One Task per worker launch**, named `f-<run>-<seq>` (an RFC 1123 label of at most 63 characters, keeping the seq), in atespace `factory` (`FACTORY_AX_ATESPACE`). It has one Workspace of the same name, mounted at `/workspace/w`.
- **Workspace**: an empty volume. `serve` clones the run's branch into `/workspace/w/repo` itself (`FACTORY_REPO`, `FACTORY_BRANCH`), retrying until the task's egress policy exists. AX's own `git:` workspace clones inside the VM before any policy can exist, fails, and still reports the workspace Ready (seen on gtr). The brief travels in the Task's env as `FACTORY_BRIEF` (v0.3.1's Workspace has no `files`), so it never lands in the repo. Before applying the Task, the laptop pushes the run branch, because the VM clones it from GitHub. A `git@` remote is rewritten to https, because the VM has no ssh key and the egress gateway supplies GitHub's token.
- **Brief**: the same brief a herdr worker gets, with the laptop's CLI path replaced by `factory` and the worktree path replaced by `/workspace/w/repo`. It adds one line: push to `origin <branch>` before reporting.
- **Command**: `factory worker serve [--model M]` (`src/worker.ts`). It runs the rig's agent headless on the brief (see Harnesses in the VM) and takes the session id from the first turn. Each queued prompt (`.factory-worker/prompts/`) then runs as another turn of that session, one at a time, and the file is deleted only after its turn. **A nudge or a mail reply continues the same session.**
- **Session survival**: the agents keep sessions under their config dirs, which a resumed task loses, because only `/workspace` is restored. So the Task sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `PI_CODING_AGENT_DIR` under `/workspace/w/.factory-worker/`, and `serve` reads `state.json` so it never briefs a session twice.
- **Model**: taken from the station's agent string (`--model '…'`, or codex's `-m`). The command is replaced, because `claude-smart` and herdr do not exist in the VM.
- **Root**: the runner is PID 1 and runs as root, and Claude refuses `--dangerously-skip-permissions` as root unless `IS_SANDBOX=1` is set. The image sets it, because the microVM is the sandbox.

### Harnesses in the VM

The VM runs the agent the rig chose, the one `agentOfNode` gives a pane (the rig's `--agent`, else the station's, else the factory's), told apart by `harnessOf`. The laptop passes it as `FACTORY_HARNESS` (`claude`, `codex` or `pi`); an agent command that is none of them (a script) is refused at launch, and `rig add --runner ax --agent …` refuses it up front. Each turn is headless and has no permission prompts, because the microVM is the sandbox.

| Harness | First turn                                                                                             | Later turns                                       | Session id                                   |
| ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------- |
| claude  | `claude -p --dangerously-skip-permissions --output-format stream-json --verbose`                       | the same with `--resume <session>`                | `session_id` in the stream's init event      |
| codex   | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [-m M] -- <brief>` | `codex exec resume --json … -- <thread> <prompt>` | `thread_id` of the `thread.started` event    |
| pi      | `pi -p --session-dir <own>/pi --session-id <uuid> [--provider P] [--model M] <brief>`                  | the same `--session-id`                           | chosen by serve (pi creates it on first use) |

What was checked: `codex exec --help` and `codex exec resume --help` on codex-cli 0.160.1 (flags, `resume [SESSION_ID] [PROMPT]`, which flags resume lacks, so only the model is forwarded), the `thread.started` / `thread_id` event from codex's `exec_events.rs` (Context7, `/openai/codex`), and `pi --help` on pi 0.80.2 (`-p/--print`, `--session-id <id>` "creating it if missing", `--session-dir`). Not run against a live model: no run of either agent against its API was made.

- **claude**: also gets main's worker flags that hold in a VM (`vmClaudeFlags`): `--tools` (the worker tool list), `--setting-sources project,local`, `--system-prompt-file` (the image carries `src/worker-system.md`) and `--settings` with no auto memory, MCP connectors off, skip-permissions accepted and the compaction backstop. Left out because they are the laptop's: the user's hooks and env, its plugin dirs, its global CLAUDE.md (there is none in the VM). `FACTORY_LEAN=0` sends none, as for a pane. The model comes from the `--model` flag as before.
- **codex**: the key is `OPENAI_API_KEY` (and `CODEX_API_KEY`, which `codex exec` reads), set to `placeholder` when `FACTORY_AX_VAULT` is set. The rig must open `api.openai.com` and name the vault key behind it (Per-rig egress). The image installs `@openai/codex` at a pinned version.
- **pi**: its provider's key is a different env var per provider, so none is set here: add the right one with `placeholder` to `FACTORY_AX_ENV` and the provider's host and key to `--egress`. `--provider` is read from the agent string. The image installs `@earendil-works/pi-coding-agent` at a pinned version.
- **MCP**: `--mcp` is refused with the ax runner: the servers' commands would have to exist in the VM.

### Per-rig egress

The default policy is Anthropic and GitHub. A rig adds rules after those:

```
--egress <host>[,<host>...][=<KEY>[:<Header>:<Prefix>]]     repeatable
```

Hosts are hostnames. With `=KEY` the gateway puts the agent-vault credential `KEY` (SCREAMING_SNAKE_CASE, as agent-vault names it) in `Header` after `Prefix` (default `Authorization` and `Bearer `; `KEY:x-api-key:` sends the bare key). Without `=KEY` the hosts are reachable and nothing is injected. Without `FACTORY_AX_VAULT` no rule injects. The rules are stored on the rig (`egress` in `rigs.json`: `{hosts, key?, header?, prefix?}[]`), validated by `rig add`, and only for a runner with an egress policy.

```sh
# a codex rig: OpenAI's API, with OPENAI in the factory vault (agent-vault, next to ANTHROPIC and GITHUB)
factory rig add api ~/repos/api --runner ax --agent "codex -m gpt-5-codex" --egress api.openai.com=OPENAI
# more hosts without a key (a package index), and a header that is not Authorization
factory rig add web ~/repos/web --runner ax --egress pypi.org,files.pythonhosted.org --egress api.example.com=EXAMPLE:x-api-key:
```

The key itself lives in the agent-vault vault, never on the laptop or in the VM; the policy only names it.

### Getting `factory report|mail|memory add` back to the laptop

The Task sets `FACTORY_OUTBOX`. Inside the VM, `factory report`, `mail` and `memory add` append `{argv, from, at}` to the outbox and print `queued for the factory` (for a report, also `you are done, stop now`). Each tick, `taskInfo` runs `ax ssh <task> -- factory worker poll <cursor>`, which prints `{status, session, lines}`. The VM's agent writes the outbox, and it may be steered by what it read, so only three commands replay (`replayable`): a `report` on this task's own run and seq, `mail` on its own run, and `memory add`. Each runs as the same CLI command locally, with `FACTORY_FROM` set to the station the laptop recorded at launch (`<run>/<task>.json`), never the line's `from`, and `FACTORY_OUTBOX` cleared (a test caught the replay queueing itself again). It advances `<run>/<task>.cursor` after each line. Any other line (`decide`, `goto`, another run's report) and a refused command (a stale seq, a bad outcome) go back to the worker as a prompt.

`poll` also prints `tail`: a Claude worker's last transcript entry. The reconciler reads the usage limit and the context size from it, as it does from a pane's transcript. A VM's Claude runs on the vault's token, which ccswitch does not rotate, so a worker refused for the limit is held until `resetsAt` (the manager is told once), and the nudge after that gives it its next turn. After a report, the laptop runs a best-effort `git pull --ff-only` into the run's worktree.

Pulling means nothing on gtr ever needs a route back to the laptop.

`memory search` inside the VM is not wired up: it searches an empty memory (Question 3). `CORE.md` and the topic list still reach the worker in its brief.

### Suspend while a worker waits on mail

A worker that is idle and has asked the manager (the existing `isAsking`) is suspended with `ax suspend task`. Its status shows `suspended` on the board, and it is not polled. When the answer arrives, `deliver` sees the task is not `Running` and runs `ax resume task`, and the mail stays unread. The next tick delivers it to the running task.

### Keys: the egress gateway puts them in, from agent-vault

The VM holds no key and no token. Every HTTPS request out goes through Substrate's egress gateway, which decrypts it (sdsmint), checks it against the task's EgressPolicy, and, for a rule with `replaceHeaders`, swaps the placeholder in an auth header for a credential it fetches from its credential provider: agent-vault (`ate-secret://agent-vault/<vault>/<KEY>`). A gateway serves one provider. Substrate's reference provider reads Kubernetes Secrets, which would mean copying keys into them; agent-vault reads them from where they live.

- **Launch** (`src/ax.ts`): reads the gateway's public CA (ClusterTrustBundle `egress-mitm.ate.dev:mitm:primary-bundle`), applies the Task with it in `FACTORY_CA`, then tries once to create the task's policy with `kubectl ate create egress-policy`. AX creates the actor a moment after the apply, so the first try usually fails; each tick tries again (`policy` in `<run>/<task>.json`) and shows the worker as `pending` until it takes. Nothing sleeps in a tick, and every `ax` call has a 30 s timeout. A task whose actor never shows fails on the station's deadline.
- **Placeholders** (only with `FACTORY_AX_VAULT`, because GitHub answers a placeholder Basic header with 400 even for a public clone): `CLAUDE_CODE_OAUTH_TOKEN` (claude) or `OPENAI_API_KEY` and `CODEX_API_KEY` (codex), and `GH_TOKEN`, set to `placeholder`, and git's `http.https://github.com/.extraHeader` set to `Authorization: Basic placeholder` through `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, so every git in the VM sends it.
- **Policy**: HTTPS to `api.anthropic.com` (`Authorization: Bearer` ← `ANTHROPIC`), `api.github.com` and `uploads.github.com` (`Authorization: Bearer` ← `GITHUB`), and `github.com` (`Authorization: Basic` ← `GITHUB_BASIC`, base64 of `x-access-token:<token>`, since git sends Basic auth). Then the rig's own rules, and nothing else, so the task sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Without `FACTORY_AX_VAULT` the policy has the hosts and no injection.
- **In the VM** (`setup()` in `src/worker.ts`, on every start): writes the CA and points `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `SSL_CERT_FILE` at it (the gateway re-signs every host the VM may reach, so it is the only root needed), then clones the run's branch.
- **Who may fetch**: Substrate makes one actor per task (`spiffe://substrate-actor.local/actor/factory/<task>`). One agent-vault agent, `factory-tasks`, registered as `spiffe://substrate-actor.local/actor/factory/*` with `proxy` on vault `factory`, covers every task in the atespace (agent-vault PR #12), so the runner registers nothing per task.
- **Where the keys come from** (`hack/agent-vault.yaml`): `ANTHROPIC` is a reference to 1Password `Personal Agents/claude-code-oauth/CLAUDE_CODE_OAUTH_TOKEN` through gtr's 1Password Connect; `GITHUB` and `GITHUB_BASIC` are references to a `github-app` source (agent-vault PR #13) that mints a nixfleet-axel installation token (stigenai org, all repos) with the App's private key read from 1Password, refreshed every 5 minutes and refused once 10 minutes stale. The only Secret is the Connect token (read-only on Personal Agents).

### Turning it on

```sh
# build and push the worker image on gtr's buildkit (needs `docker login ghcr.io` with write:packages)
hack/push-worker.sh    # prints image@digest
```

```sh
# on the laptop running the factory loop
export FACTORY_AX_IMAGE=ghcr.io/stigenai/factory-worker@sha256:…   # from push-worker.sh
export FACTORY_AX_CONTEXT=gtr                                # kube context for ax and kubectl (kubectl-ate on PATH)
export FACTORY_AX_VAULT=factory                              # agent-vault vault with ANTHROPIC, GITHUB, GITHUB_BASIC
export FACTORY_AX_ENV=~/.config/factory/ax-env.json          # optional: more env for the task, never a real key
factory rig add web ~/repos/web --runner ax                   # rigs.json: "runner": "ax"
# a codex rig also needs its host and its vault key (OPENAI in the vault): --agent "codex" --egress api.openai.com=OPENAI
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
