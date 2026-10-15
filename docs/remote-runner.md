# Remote runner: station workers in AX microVMs

A rig can run its workers as [AX](https://github.com/google/ax) tasks on a Kubernetes cluster with Substrate
instead of herdr panes on the laptop. Each worker launch is a microVM that runs the rig's agent headless, reaches
only the hosts its egress policy allows, and holds no key: the egress gateway puts them in on the way out.

## What AX gives us (read from google/ax at ac23328; built against v0.3.1)

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
  info(run: Run, address: string): WorkerInfo | null // { status, agent?, session?, failed? }; null once gone (ax instead sets failed, to carry why into the FAIL reason)
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
- **Workspace**: an empty volume. `serve` clones the run's branch into `/workspace/w/repo` itself (`FACTORY_REPO`, `FACTORY_BRANCH`), retrying until the task's egress policy exists. AX's own `git:` workspace clones inside the VM before any policy can exist, fails, and still reports the workspace Ready. The brief goes over as a `put` once the task starts, not in the Task's env (`FACTORY_BRIEF` is a fallback the Launch API still takes, for a caller with a short brief and no run to put it from; the laptop always puts): Substrate takes no env value past 32 KiB, and a brief with a bead's spec passes that easily. `serve`'s `sentFile` waits for it (300 tries, 2 s apart) before giving up and dying, which is why a `put` that cannot land is fatal to the whole worker, not just one file. Before applying the Task, the laptop pushes the run branch, because the VM clones it from GitHub. A `git@` remote is rewritten to https, because the VM has no ssh key and the egress gateway supplies GitHub's token.
- **Brief**: the same brief a herdr worker gets, with the laptop's CLI path replaced by `factory` and the worktree path replaced by `/workspace/w/repo`. It adds one line: push to `origin <branch>` before reporting.
- **Command**: `factory worker serve [--model M]` (`src/worker.ts`). It runs the rig's agent headless on the brief (see Harnesses in the VM) and takes the session id from the first turn. Each queued prompt (`.factory-worker/prompts/`) then runs as another turn of that session, one at a time, and the file is deleted only after its turn. **A nudge or a mail reply continues the same session.**
- **Session survival**: the agents keep sessions under their config dirs, which a resumed task loses, because only `/workspace` is restored. So the Task sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `PI_CODING_AGENT_DIR` under `/workspace/w/.factory-worker/`, and `serve` reads `state.json` so it never briefs a session twice.
- **Model**: taken from the station's agent string (`--model '…'`, or codex's `-m`). The command is replaced, because `claude-smart` and herdr do not exist in the VM.
- **Root, then the worker user**: Substrate starts every task as root with only `AUDIT_WRITE`, `KILL` and `NET_BIND_SERVICE`, and tools such as PostgreSQL's `initdb` refuse root. The Task asks for `SETUID`, `SETGID` and `CHOWN` in `spec.capabilities` (an AX field that becomes the container's `securityContext.capabilities.add`; `FACTORY_AX_CAPABILITIES` overrides the list, and set empty leaves the field out for an AX without it). `serve` starts as root, does what only root can (makes the actor's `/` and `/workspace`, which are 0700, traversable, writes `/etc/hosts`, gives the workspace, its home and Nix's store and database to the image's `worker` user, since Substrate shows every image file as root's), then runs itself again as `worker`, so the clone, Nix, the devenv and every agent turn run unprivileged. Root in an `ax ssh` shell has no `DAC_OVERRIDE` or `CAP_FOWNER`, so it cannot write the worker's files: `nix` there runs as `worker` (a wrapper ahead of it on `PATH`), and git reads the worker's repos (`safe.directory` is `*`) but cannot write them; run `setpriv --reuid=worker --regid=worker --init-groups <command>` for that. The laptop's own `ax ssh` calls need the same thing: `ax.ts`'s `poll`, `prompt` and `put` prefix their `factory worker <sub> ...` command with `setpriv --reuid=worker --regid=worker --init-groups env HOME=/home/worker USER=worker` whenever the task's capabilities include `SETUID` and `SETGID` (the default; `env` resets `HOME`, which `setpriv` otherwise leaves as root's own and the worker cannot read). `.factory-worker` is `worker:worker` `0755`, so without this a root `put` fails `EACCES` on its `mkdir`, and `serve` never gets its brief. With `FACTORY_AX_CAPABILITIES` empty (`serve` stayed root) the laptop sends the bare command instead. Without the capabilities `serve` stays root, and Claude then needs `IS_SANDBOX=1` to skip permissions, which the image sets because the microVM is the sandbox.

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

The Task sets `FACTORY_OUTBOX`. Inside the VM, `factory report`, `mail` and `memory add` append `{argv, from, at}` to the outbox and print `queued for the factory` (for a report, also `you are done, stop now`). Each tick, `taskInfo` runs `ax ssh <task> -- <as the worker user> factory worker poll <cursor>` (see Root, then the worker user), which prints `{status, session, lines}`. Before polling, it sends whatever is still queued to `put` (the brief, the run's beads copy) in parts of at most `ax.PUT_PART` (96 KB of base64 each, since Substrate takes no ssh argument much past 128 KiB): `ax ssh <task> -- <as the worker user> factory worker put <name> <part> <parts> <base64>` for each. A `put` that fails (the VM still waking, or a worker-user problem) is retried every tick for up to 5 minutes (`TaskSide.putFailedAt`, `.putError`); past that the attempt FAILs with ax's stderr (`WorkerInfo.failed`), instead of retrying silently until the station's own time limit with nothing in the journal. The VM's agent writes the outbox, and it may be steered by what it read, so only three commands replay (`replayable`): a `report` on this task's own run and seq, `mail` on its own run, and `memory add`. Each runs as the same CLI command locally, with `FACTORY_FROM` set to the station the laptop recorded at launch (`<run>/<task>.json`), never the line's `from`, and `FACTORY_OUTBOX` cleared (a test caught the replay queueing itself again). It advances `<run>/<task>.cursor` after each line. Any other line (`decide`, `goto`, another run's report) and a refused command (a stale seq, a bad outcome) go back to the worker as a prompt.

`poll` also prints `tail`: a Claude worker's last transcript entry. The reconciler reads the usage limit and the context size from it, as it does from a pane's transcript. A VM's Claude runs on the vault's token, which ccswitch does not rotate, so a worker refused for the limit is held until `resetsAt` (the manager is told once), and the nudge after that gives it its next turn. After a report, the laptop runs a best-effort `git pull --ff-only` into the run's worktree.

If `FACTORY_AX_TOKEN_SWAP` is set, the reconciler starts that command. The reconciler does not only wait. The command moves the vault to a new slot. Then the reconciler sends the manager a mail that shows which slot is live. The worker continues when agent-vault reads the vault again, in 5 minutes or less, not at `resetsAt`.

A file named for the runner stops one more run for the same limit. Each worker of that runner uses this file. If there is no command, or if the command does not complete, the reconciler waits as shown above. For example, the command does not complete when all slots are also at their limit. `bin/claude-token` (`best` or `use <N>`) is one such command. See the comment on how to use that command for the adjustments that it must have.

Pulling means nothing on the cluster ever needs a route back to the laptop.

`memory search` inside the VM is not wired up: it searches an empty memory. `CORE.md` and the topic list still reach the worker in its brief.

### Beads in the VM

How the factory uses beads in general is in [beads.md](beads.md).

The laptop keeps each rig's issue store in its own dolt server and pushes it to the repo's GitHub origin, where dolt keeps it under `refs/dolt/data`. The VM reaches GitHub through the egress gateway, so it works on that copy:

- **Launch**: the laptop pushes the rig's store (`bd dolt push` in the run's worktree), so what it wrote since (the run's plan, say) is on GitHub, and sets `FACTORY_BEADS`.
- **In the VM**: after the repo clone, `serve` runs `bd bootstrap` in `.factory-worker/beads`, a directory of its own with the repo's https origin, since the repo's `.beads` config names the laptop's dolt server; `BEADS_DOLT_SHARED_SERVER=0` keeps bd off it. The agent's `bd` finds the clone through `BEADS_DIR` and is plain bd: reads and writes, ids as bd gives them. A resumed task keeps the clone.
- **Back**: `factory report` in the VM pulls (merging what was pushed meanwhile) and pushes before it queues the report, retrying when another push won the race. When the laptop replays the report it pulls the rig's store, so the next station sees the worker's writes.

Pushes from a stale copy are refused until it pulls. A pull merges cell by cell, so different fields and new issues from both sides survive; when both sides changed the same field, the later push wins. Measured on a test cluster: a 534-issue store (204 MB) bootstraps in 3 s.

A large store makes GitHub slow for this (a push of one past 1 GB did not finish in 40 minutes), so a rig can share its beads through a Dolt server of its own instead: `beadsRemote` in `rigs.json`, `{ name, url, user }`. The laptop pushes and pulls the remote `name` in its store, as `user` (its Dolt server holds the password, in `DOLT_REMOTE_PASSWORD`). The VM bootstraps from `url` (`FACTORY_BEADS_REMOTE`, written as the clone's `sync.remote`) with `DOLT_REMOTE_USER` set to `user` and `DOLT_REMOTE_PASSWORD=placeholder`. Dolt sends those as an `Authorization: Basic` header, so the rig's egress names the server's host and port with a vault key holding the real `base64(user:password)`, injected after `Basic ` (`{hosts, port, key, header: "Authorization", prefix: "Basic "}`). The gateway injects only on HTTPS it intercepts, so the remotesapi serves TLS with a certificate the gateway's upstream trust accepts. A launch pulls the remote before it pushes. A pull runs in one transaction: it commits the laptop's pending writes, merges, and where the laptop and a VM changed the same row it keeps the VM's (the worker did the work it reports on), then comments on each overwritten issue what the laptop had.

### Tools in the VM

The image carries no language toolchains. It carries Nix instead: single-user (gVisor refuses `setgroups`, so there is no daemon and no build users) and the worker user's once `serve` starts, substituting from `cache.nixos.org` and `devenv.cachix.org` (with its flake registry from `channels.nixos.org`; turning that off in `nix.conf` would change every devenv's derivation) and building what neither holds, with nixpkgs and `devenv` in the image. `devenv` is in the image, but `devenv shell` fails in a VM: local Nix builds die under gVisor before the builder starts (`reading a line: Input/output error`), even for a one-line derivation, and a devenv profile is always built locally. A rig whose repo has a `devenv.nix` can serve its devenv from a binary cache of its own instead: build `devenv shell` once outside a VM at the same path (`/workspace/w/repo`, since its derivations depend on it) and push the closure to a cache (attic, say), set the rig's env `FACTORY_NIX_CACHE` to the cache's URL and public key (`https://cache.example:8443/devenv devenv:AAAA...=`), and add the cache to its egress with the cache's token injected (`--egress cache.example=NIX_CACHE`; HTTPS only, since the gateway injects nothing over plain HTTP). Each VM then loads the devenv's environment into the worker before the agent starts, with Nix asking the cache with a placeholder password the gateway replaces, and the brief tells the agent its tools are on PATH. It never runs `devenv shell`, whose enterShell runs the repo's git hooks. `factory devenv [rig...] [--force]` does the build and push: for each AX rig with `FACTORY_NIX_CACHE` (or the rigs named), it fetches the default branch and builds its devenv in the worker image (`FACTORY_AX_IMAGE`) on a buildx builder, at the VM's path, then runs the cache's push command on the closure. It skips a rig whose `devenv.nix`, `devenv.yaml` and `devenv.lock` and the image are as last built; the tick runs it every half hour, so a lock change is cached within the hour. It reads `$FACTORY_HOME/devenv.json`:

```json
{
  "builder": "<amd64 buildx builder>",
  "token": "<command printing the cache's push token, e.g. op read ...>",
  "push": "nix shell nixpkgs#attic-client -c sh -euc 'attic login c <cache-server> \"$(cat /run/secrets/cache)\" >/dev/null && attic push c:<cache> $ROOTS'"
}
```

The tokens (the push token and `gh auth token`, for a private repo's clone) reach the build only as buildx secrets. Each rig's log is `$FACTORY_HOME/devenv/<rig>.log`. An agent installs what it lacks with `nix shell nixpkgs#go nixpkgs#gnumake ... -c <command>`, or uses the repo's own `nix develop`. Both caches are in every task's egress. The package age gate below (`FACTORY_AX_PKG_GATE`) is opt-in, off by default: until it is on for a rig, that rig's package registries go in `--egress` the same as any other host (a Go rig, say, needs `proxy.golang.org,sum.golang.org`), and nix-provided toolchains reach them directly with no age check at all. Once the gate is on, the opposite holds: a rig's package registries never go in `--egress` directly, since they are stripped from the policy even if listed, and nix-provided toolchains reach the real registries over no wrapper at all, so every rig goes through the gate instead (`setup-envtest`'s non-registry hosts still need `--egress`: `raw.githubusercontent.com,release-assets.githubusercontent.com,objects.githubusercontent.com`).

`serve`'s setup also makes three things a sandboxed test expects: a `localhost` entry (the VM has no `/etc/hosts`), `GOTOOLCHAIN=local`, and a `kube-apiserver` wrapper for envtest (`TEST_ASSET_KUBE_APISERVER`) that adds `--advertise-address=127.0.0.1`, since the VM's only address is link-local and kube-apiserver will not advertise one. Measured on a test cluster: a Go operator repo's `make vet test` (74 packages, envtest included) passes in a VM.

A Bazel rig shares a remote cache through the gateway. The rig's `env` (in `rigs.json`, over `FACTORY_AX_ENV`) sets `FACTORY_BAZELRC` to its cache flags, with the cache's key header set to a placeholder, and its egress names the cache host with the vault key to inject there (`<cache-host>=<KEY>:x-buildbuddy-api-key:` for BuildBuddy). `serve` writes those flags to the VM's `~/.bazelrc`, then adds the gateway's CA twice: `--tls_certificate` for the cache's gRPC, and a Java trust store for Bazel's JVM, which fetches modules and toolchains and reads no PEM. `keytool` comes from Nix, since the image has no JDK. The rig's egress also needs Bazel's own hosts: `releases.bazel.build,bcr.bazel.build,mirror.bazel.build,codeload.github.com` and its rules' package registries. Measured on a test cluster: a Go package's build, cold in 164 s, ran again after `bazel clean` in 19 s, with all 324 actions remote cache hits.

A rig can read its Kubernetes cluster from the VM, with no token in it. The cluster grants a ServiceAccount read-only access (the built-in `view` role and read on the cluster-scoped resources it leaves out: nodes, persistent volumes, namespaces, storage classes, CRDs; never Secrets or exec), and agent-vault holds its token (`KUBE_READ`, say, a reference like any key). The rig's env sets `FACTORY_KUBE_SERVER` to the API server's in-cluster URL (`https://kubernetes.default.svc.cluster.local`), and `serve` writes `~/.kube/config` with that server, the gateway's CA and the token `placeholder`. The rig's egress names that host with the key (`--egress kubernetes.default.svc.cluster.local=KUBE_READ`, `Authorization: Bearer` by default), and the gateway must trust the API server: its upstream roots need the cluster's CA, which signs kube-apiserver's certificate and is no public root. The brief tells the agent kubectl reads the live cluster and cannot change it.

### Package age gate

Substrate's `EgressPolicy` allows a task by hostname and port only: once `proxy.golang.org` or `pypi.org` is in a task's egress, every path on it is open, including to `nix shell nixpkgs#go -c go get <fresh module>` reaching the real registry directly, past whatever age check a PATH wrapper (`pkg-guard` on a laptop) would have made. So the age gate is a proxy outside the VM, `factory pkg-gate serve` (`src/pkggate.ts`), the only registry host a task may ever reach once it is on: `/go` speaks the GOPROXY protocol, `/npm/<pkg>` serves the packument with young versions and their tarballs removed, `/pypi/simple/<pkg>` serves the PEP 691 index the same way, all refusing a version younger than `PKG_GATE_MIN_DAYS` (4 by default) and failing closed (refuse, not pass through) on an upstream error or a missing or unparseable publish time.

`FACTORY_AX_PKG_GATE=<scheme://host[:port]>` on the laptop turns it on for every task launched after (a running task keeps its policy until relaunched):

- **Policy** (`ax.egressPolicy`): adds the gate's own rule, and strips every one of `ax.REGISTRY_HOSTS` (`proxy.golang.org`, `sum.golang.org`, `goproxy.io`, `goproxy.cn`, `registry.npmjs.org`, `registry.npmjs.com`, `registry.yarnpkg.com`, `registry.npmmirror.com`, `pypi.org`, `pypi.python.org`, `test.pypi.org`, `files.pythonhosted.org`) from the rig's own egress rules, dropping a rule left with none. This is what enforces the gate: a worker that unsets an env var below, or reaches for `nix shell nixpkgs#go` directly, still hits a refused host. `factory rig add --egress` warns (but still adds) when a rig lists one of these hosts, since a gated policy drops it silently later. If a rig's rule for one of those hosts carried its own key (a private registry's auth header, injected the way the Dolt or kube rules above are), the strip removes that rule too, with no substitute: a private package becomes unreachable once the gate is on, since the gate itself forwards no auth upstream.
- **Convenience env** (`ax.launch`): sets `GOPROXY`, `NPM_CONFIG_REGISTRY`, `BUN_CONFIG_REGISTRY`, `YARN_NPM_REGISTRY_SERVER`, `PIP_INDEX_URL`, `UV_DEFAULT_INDEX` and `UV_INDEX_URL` at the gate (plus `PIP_TRUSTED_HOST`/`UV_INSECURE_HOST` and `YARN_UNSAFE_HTTP_WHITELIST` for an `http://` gate, since pip, uv and yarn berry all refuse a plain-http registry outright otherwise), so a toolchain that honors them needs nothing else. Only the egress strip above is what a worker cannot route around.
- **Bazel** (`worker.ts` `bazelrc()`): when `FACTORY_BAZELRC` is set, adds `--repo_env=GOPROXY=...`, `--repo_env=PIP_INDEX_URL=...` and `--repo_env=NPM_CONFIG_REGISTRY=...` for whichever of those the launch env above set, so `rules_go`/`rules_python`/`rules_js` fetch through the gate too.
- **The person's lever**: `PKG_GATE_ALLOWLIST_GO`/`_NPM`/`_PYPI` (colon-separated module/package names, exact match, bypassing the age check including a missing publish time, one list per ecosystem so an entry for one never unlocks the same spelling in another) is set only on the gate's own Deployment (`deploy/pkg-gate.yaml`), never by a worker or a task's env, so nothing a VM sends can change a decision. The gate refuses to start if the old shared `PKG_GATE_ALLOWLIST` is still set, rather than reinterpreting it. `PKG_GATE_UPSTREAM_GO`/`_NPM`/`_PYPI`/`_FILES` override the real registries the gate itself fetches from (`proxy.golang.org`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` by default); neither is normally set.
- **Deploying it**: `deploy/pkg-gate.yaml` runs `factory pkg-gate serve` as the worker image, with its `ax-task-runner` entrypoint overridden, behind a plain `Service` on port 8080 — not TLS, unlike the Dolt remotesapi and a nix cache above. Those are served over HTTPS because the gateway's MITM decrypts them to inject a vault credential (`replaceHeaders`); the gate's own egress rule has no `key`, so there is nothing to inject and TLS buys it nothing, at the cost of the gateway's upstream trust needing a new entry for it (as `kubernetes.default.svc.cluster.local` above does). So `FACTORY_AX_PKG_GATE=http://pkg-gate.pkg-gate.svc.cluster.local:8080`. The gate's own namespace, not a task's EgressPolicy, needs outbound internet access to the real registries; that is the cluster operator's NetworkPolicy, not this repo's.
- **Residual gaps, filed and out of scope here**: a public dependency fetched straight from `github.com` (`GOPROXY=direct`, `git+https`) never goes through the gate (claude-factory-lpv); a Go module's `.info` `Time` is commit time, which an author can backdate (claude-factory-8ub).

### Suspend while a worker waits on mail

A worker that is idle and has asked the manager (the existing `isAsking`) is suspended with `ax suspend task`. Its status shows `suspended` on the board, and it is not polled. When the answer arrives, `deliver` sees the task is not `Running` and runs `ax resume task`, and the mail stays unread. The next tick delivers it to the running task.

### Keys: the egress gateway puts them in, from agent-vault

The VM holds no key and no token. Every HTTPS request out goes through Substrate's egress gateway, which decrypts it (sdsmint), checks it against the task's EgressPolicy, and, for a rule with `replaceHeaders`, swaps the placeholder in an auth header for a credential it fetches from its credential provider: agent-vault (`ate-secret://agent-vault/<vault>/<KEY>`). A gateway serves one provider. Substrate's reference provider reads Kubernetes Secrets, which would mean copying keys into them; agent-vault reads them from where they live.

- **Launch** (`src/ax.ts`): reads the gateway's public CA (ClusterTrustBundle `egress-mitm.ate.dev:mitm:primary-bundle`), applies the Task with it in `FACTORY_CA`, then tries once to create the task's policy with `kubectl ate create egress-policy`. AX creates the actor a moment after the apply, so the first try usually fails; each tick tries again (`policy` in `<run>/<task>.json`) and shows the worker as `pending` until it takes. Nothing sleeps in a tick, and every `ax` call has a 30 s timeout. A task whose actor never shows fails on the station's deadline.
- **Placeholders** (only with `FACTORY_AX_VAULT`, because GitHub answers a placeholder Basic header with 400 even for a public clone): `CLAUDE_CODE_OAUTH_TOKEN` (claude) or `OPENAI_API_KEY` and `CODEX_API_KEY` (codex), and `GH_TOKEN`, set to `placeholder`, and git's `http.https://github.com/.extraHeader` set to `Authorization: Basic placeholder` through `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, so every git in the VM sends it.
- **Policy**: HTTPS to `api.anthropic.com` (`Authorization: Bearer` ← `ANTHROPIC`), `api.github.com` and `uploads.github.com` (`Authorization: Bearer` ← `GITHUB`), and `github.com` (`Authorization: Basic` ← `GITHUB_BASIC`, base64 of `x-access-token:<token>`, since git sends Basic auth). Then the rig's own rules, and nothing else, so the task sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Without `FACTORY_AX_VAULT` the policy has the hosts and no injection.
- **In the VM** (`setup()` in `src/worker.ts`, on every start): writes the CA and points `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `SSL_CERT_FILE` at it (the gateway re-signs every host the VM may reach, so it is the only root needed), then clones the run's branch.
- **Who may fetch**: Substrate makes one actor per task (`spiffe://substrate-actor.local/actor/factory/<task>`). One agent-vault agent, `factory-tasks`, registered as `spiffe://substrate-actor.local/actor/factory/*` with `proxy` on vault `factory`, covers every task in the atespace, so the runner registers nothing per task.
- **Where the keys come from**: agent-vault holds `ANTHROPIC`, `GITHUB` and `GITHUB_BASIC` (and any rig key such as `OPENAI`) in the vault `FACTORY_AX_VAULT` names, as references to wherever they live (a password manager, a GitHub App that mints installation tokens). The cluster holds no copy of a key.

### A known outage: the egress gateway and `api.anthropic.com`

Seen 2026-10-13 02:11Z and twice on 2026-10-14 (14:21Z, 14:35Z); a 2026-10-14 15:13-15:21Z recheck found it intermittent (145 503s against 203 200s to the same destination IP and byte-identical cert within one hour).

- **Signature**: Envoy marks the connection `UF`, the `egress_forward_proxy` cluster's `ssl.fail_verify_san` counter equals its `cx_connect_fail` count, and every new connection to `api.anthropic.com` gets a 503 body containing `upstream connect error or disconnect/reset before headers`. The cert itself is fine (CN and SAN both `api.anthropic.com`), the node reaches the host, and GitHub through the same gateway keeps working.
- **Trigger**: while agent-vault cannot serve the `ANTHROPIC` credential, `ate-system/atenet-egress` denies with a stale credential; once agent-vault serves it again, new connections to `api.anthropic.com` keep failing this way.
- **Owner**: Substrate, not this repo. The gateway is `ate-system/atenet-egress`, a Deployment this repo's code never touches (`src/ax.ts`'s `kubectl` calls only read the gateway's `ClusterTrustBundle` and apply this task's own `egress-policy` CRD). The suspected root cause is Envoy's `auto_san_validation` on the dynamic forward proxy. Tracked upstream as `claude-factory-ue9`, for a person to report to Substrate; not fixed in this repo.
- **Workaround, partial**: `kubectl -n ate-system rollout restart deploy/atenet-egress`. As of the 2026-10-14 15:13-15:21Z recheck this no longer reliably clears the failure (it can still leave the mix of 503s and 200s above), so treat it as worth trying, not a guaranteed fix.
- **What the runner does about it** (so one outage does not cost a station its attempt): `egressFailure()` in `src/worker.ts` recognizes only this exact Envoy text in a finished turn's output — never a generic 5xx, rate-limit, or 529 overloaded refusal, which Claude already retries itself, so matching those here would mask a real API failure instead of the gateway's. When a turn ends on it, `serveTurns` (`src/worker.ts`) retries in place: the same session once there is one, with `EGRESS_RETRY_PROMPT` ("The last turn failed on the egress gateway refusing a new connection to the model API (see above). Try again."), or the brief again with no session yet. A prompt file queued for the turn is deleted only after the turn, so a retry never loses or reorders it. Backoff doubles from `FACTORY_EGRESS_WAIT_MS` (default 30 s), capped at 10× that (5 min at the default), for up to `FACTORY_EGRESS_BUDGET_MS` (default 30 min); each retry appends one `serve.log` line ("egress failure, retry N: ..."). A turn that gets through clears the outage. While it is ongoing, `state.json`'s `egress: {since, tries, last}` rides `worker.poll()` → `ax.Poll` → `WorkerInfo` back to the laptop. `reconcile` (`src/cli.ts`) mails the manager once per outage (deduped by `since` in `<run>/egress-paged-<node>.json`, keyed per run and node since the gateway is shared and a single outage hits every concurrent AX worker at once) and spends no idle nudge while serve is still retrying. As soon as the worker goes `idle` or `done` with the outage still set — meaning serve already spent its own retry budget and gave up, not once this station's own nudges are spent — `reconcile` fails that tick, named, instead of the generic "worker stopped without reporting": `egress gateway: model API unreachable since <ISO> (<n> retries): <last>`.
- **Env knobs**: `FACTORY_EGRESS_WAIT_MS` (base backoff, ms; default 30000) and `FACTORY_EGRESS_BUDGET_MS` (total retry budget, ms; default 1800000 = 30 min). Setting the budget to `0` turns retrying off without a code change. Both are read only by the VM half (`src/worker.ts`), so set them through `FACTORY_AX_ENV`.

### Turning it on

```sh
# build and push the worker image (an amd64 buildx builder; needs push access to REG)
REG=<registry>/<org> BUILDER=<builder> hack/push-worker.sh    # prints image@digest
```

```sh
# on the laptop running the factory loop
export FACTORY_AX_IMAGE=<registry>/<org>/factory-worker@sha256:…   # from push-worker.sh
export FACTORY_AX_CONTEXT=<cluster>                               # kube context for ax and kubectl (kubectl-ate on PATH)
export FACTORY_AX_VAULT=factory                              # agent-vault vault with ANTHROPIC, GITHUB, GITHUB_BASIC
export FACTORY_AX_ENV=~/.config/factory/ax-env.json          # optional: more env for the task, never a real key
export FACTORY_AX_TOKEN_SWAP="bin/claude-token best"          # optional: swaps the vault's token on a usage limit
export FACTORY_AX_PKG_GATE=http://pkg-gate.pkg-gate.svc.cluster.local:8080  # optional: see Package age gate, above
factory rig add web ~/repos/web --runner ax                   # rigs.json: "runner": "ax"
# a codex rig also needs its host and its vault key (OPENAI in the vault): --agent "codex" --egress api.openai.com=OPENAI
```

Only that rig's new workers become AX tasks, and only at stations without a `runner` of their own: a station with `runner: herdr` (lifecycle's baseline, deploy, soak, rollback, incident and monitor, which read or change production) keeps its workers in panes, where the laptop's kubectl and network are. A worker already running in a pane stays there, and `--runner herdr` switches the rig back. `FACTORY_AX` points at a different `ax` binary.
