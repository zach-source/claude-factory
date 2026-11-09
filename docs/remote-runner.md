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
- **Session survival**: the agents keep sessions under their config dirs, which a resumed task loses, because only `/workspace` is restored. So the Task sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `PI_CODING_AGENT_DIR` under `/workspace/w/.factory-worker/`, and `serve` reads `state.json` so it never briefs a session twice. If `state.json` says `working`, the VM stopped in the middle of a turn. Then `serve` first sends a resume turn that names the tool call the stop cut off (claude-factory-p0yt).
- **Model**: taken from the station's agent string (`--model '…'`, or codex's `-m`). The command is replaced, because `claude-smart` and herdr do not exist in the VM.
- **Sandbox class**: AX runs a task in gVisor by default. Use `factory rig set <rig> --sandbox-class microvm`. A rig with `sandboxClass: microvm` gets `spec.sandboxClass: microvm` on its Tasks, and Substrate runs them in a Cloud Hypervisor guest with a real Linux kernel. Nix builds need this, because they fail under gVisor while the build environment starts. The cluster needs a WorkerPool with `sandboxClass: microvm`. Without the setting, the Task leaves the field out, for an AX without it.
- **Root, then the worker user**: Substrate starts every task as root with only `AUDIT_WRITE`, `KILL` and `NET_BIND_SERVICE`, and tools such as PostgreSQL's `initdb` refuse root. The Task asks for `SETUID`, `SETGID` and `CHOWN` in `spec.capabilities` (an AX field that becomes the container's `securityContext.capabilities.add`; `FACTORY_AX_CAPABILITIES` overrides the list, and set empty leaves the field out for an AX without it). `serve` starts as root, does what only root can (makes the actor's `/` and `/workspace`, which are 0700, traversable, writes `/etc/hosts`, gives the workspace, its home and Nix's store and database to the image's `worker` user, since Substrate shows every image file as root's), then runs itself again as `worker`, so the clone, Nix, the devenv and every agent turn run unprivileged. Root in an `ax ssh` shell has no `DAC_OVERRIDE` or `CAP_FOWNER`, so it cannot write the worker's files: `nix` there runs as `worker` (a wrapper ahead of it on `PATH`), and git reads the worker's repos (`safe.directory` is `*`) but cannot write them; run `setpriv --reuid=worker --regid=worker --init-groups <command>` for that. The laptop's own `ax ssh` calls need the same thing: `ax.ts`'s `poll`, `prompt` and `put` prefix their `factory worker <sub> ...` command with `setpriv --reuid=worker --regid=worker --init-groups env HOME=/home/worker USER=worker` whenever the task's capabilities include `SETUID` and `SETGID` (the default; `env` resets `HOME`, which `setpriv` otherwise leaves as root's own and the worker cannot read). `.factory-worker` is `worker:worker` `0755`, so without this a root `put` fails `EACCES` on its `mkdir`, and `serve` never gets its brief. With `FACTORY_AX_CAPABILITIES` empty (`serve` stayed root) the laptop sends the bare command instead. Without the capabilities `serve` stays root, and Claude then needs `IS_SANDBOX=1` to skip permissions, which the image sets because the microVM is the sandbox.

### Harnesses in the VM

The VM runs the agent the rig chose, the one `agentOfNode` gives a pane (the rig's `--agent`, else the station's, else the factory's), told apart by `harnessOf`. The laptop passes it as `FACTORY_HARNESS` (`claude`, `codex`, `cursor`, `grok` or `pi`); an agent command that is none of them (a script) is refused at launch, and `rig add --runner ax --agent …` refuses it up front. A codex agent, and a lifecycle station's Codex split, run in the VM only when `FACTORY_AX_CODEX=1` is set. Set it only with an image that has the codex guard below. An older image ignores the guard files, and its codex would run with no deny hook. A cursor agent runs only when `FACTORY_AX_CURSOR=1` is set, with an image that has the pinned `cursor-agent` (`CURSOR_VERSION` in `Dockerfile.worker`). The VM gets a placeholder `CURSOR_API_KEY`. The egress rule injects the vault key `CURSOR_API_KEY` on `api2.cursor.sh/auth/` only, where the CLI swaps its key for an access token. The other Cursor hosts (`api2.cursor.sh`, `api3.cursor.sh`, `repo42.cursor.sh`, `*.api5.cursor.sh`) pass with no key. The deny hook is `~/.cursor/hooks.json`, written by `serve` before each turn. Each turn is headless and has no permission prompts, because the microVM is the sandbox.

| Harness | First turn                                                                                             | Later turns                                       | Session id                                   |
| ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------- |
| claude  | `claude -p --dangerously-skip-permissions --output-format stream-json --verbose`                       | the same with `--resume <session>`                | `session_id` in the stream's init event      |
| codex   | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [-m M] -- <brief>` | `codex exec resume --json … -- <thread> <prompt>` | `thread_id` of the `thread.started` event    |
| pi      | `pi -p --session-dir <own>/pi --session-id <uuid> [--provider P] [--model M] <brief>`                  | the same `--session-id`                           | chosen by serve (pi creates it on first use) |

What was checked: `codex exec --help` and `codex exec resume --help` on codex-cli 0.160.1 (flags, `resume [SESSION_ID] [PROMPT]`, which flags resume lacks, so only the model is forwarded), the `thread.started` / `thread_id` event from codex's `exec_events.rs` (Context7, `/openai/codex`), and `pi --help` on pi 0.80.2 (`-p/--print`, `--session-id <id>` "creating it if missing", `--session-dir`). Not run against a live model: no run of either agent against its API was made.

- **claude**: also gets main's worker flags that hold in a VM (`vmClaudeFlags`). These are `--tools` (with `Skill`), `--setting-sources project,local`, `--system-prompt-file` and `--settings` (no auto memory, MCP off, skip-permissions, `disableBundledSkills` and the compaction backstop). It skips the laptop's hooks, env, plugin dirs and global `CLAUDE.md` (there is none in the VM). It gets the plugins of its station's skills from the image, by `--plugin-dir` (`asd-ste100` for a station that lists it). It gets no `STE_VOCAB_PATH`/`STE_JEV_URL`. The launch sets `FACTORY_SKILLS` to the skill names, so codex and pi workers get the same set. An empty list gives no plugin. `FACTORY_LEAN=0` sends none, as for a pane. The model still comes from the `--model` flag.
- **codex**: one of two login modes. If the rig's egress names `api.openai.com`, the worker uses the API key: `OPENAI_API_KEY` and `CODEX_API_KEY` (which `codex exec` reads) are `placeholder` when `FACTORY_AX_VAULT` is set, and the rig's own rule injects the vault key `OPENAI` (Per-rig egress). Any other codex worker uses a ChatGPT subscription login. The VM gets no API-key env. Its `CODEX_HOME` holds an `auth.json` with `auth_mode` `chatgpt` and placeholder tokens: codex reads the `id_token` claims without a signature check, and it does not refresh before the `exp` of the access token (year 2100). The task's policy opens `chatgpt.com` only for the path prefix `/backend-api/codex/` (the rest of `/backend-api` holds the person's chats). The gateway sets `Authorization: Bearer` from the vault key `CODEX_CHATGPT` and `ChatGPT-Account-ID` from `CODEX_CHATGPT_ACCOUNT`. The placeholder `auth.json` has no `tokens.account_id`, so codex skips workspace routing (`GET /backend-api/wham/accounts/check` before each turn), which the policy keeps closed. `auth.openai.com` stays closed, so the VM never refreshes. The image installs `@openai/codex` at a pinned version.
  - **Guard** (claude-factory-72dq): the laptop sends the `CODEX_HOME` files in `FACTORY_CODEX_HOME_FILES`. These are `hooks.json`, with the deny hook from the image's own `worker-hook.ts`, and `config.toml`, with the compaction limit and the repo as trusted (and, in ChatGPT mode, `forced_login_method = "chatgpt"`, `cli_auth_credentials_store = "file"` and the placeholder `auth.json`). Before each turn, `serve` writes them and adds `AGENTS.md` from the image's `worker-system.md`, `worker-vm.md` and `worker-codex.md`. `serve` removes each file and writes it again, so a symlink at its path has no effect. A directory at its path, or a `CODEX_HOME` that is a symlink, stops `serve`. `serve` runs each codex turn under `src/reap.ts`, a child subreaper. When codex exits, the reaper kills each process that the turn left, in any session. Each turn runs codex with the guard flags (`--enable hooks`, `--disable` for each feature that skips the hook). `serve` fails closed in these cases: the files are missing, the repo has a `.codex` directory, or `codex features list` does not show the guard on. The guard includes `unified_exec` off. `--disable` cannot turn it off, and its `write_stdin` skips the hook. So the image pins it in `/etc/codex/requirements.toml` (`[features] unified_exec = false`, claude-factory-fzm3). An image without the pin fails closed.
- **pi**: its provider's key is a different env var per provider, so none is set here: add the right one with `placeholder` to `FACTORY_AX_ENV` and the provider's host and key to `--egress`. `--provider` is read from the agent string. The image installs `@earendil-works/pi-coding-agent` at a pinned version.
- **CI logs**: the default policy opens 140 hosts with no key: `productionresultssa{0..19,30..49,100..199}.blob.core.windows.net`. `gh api repos/<o>/<r>/actions/jobs/<id>/logs` follows a 302 to one of them. So `factory ci <pr>` can read a failed job log in the VM. A wildcard on `blob.core.windows.net` opens every Azure storage account. For this reason the list is explicit (`ACTIONS_LOG_HOSTS` in `src/ax.ts`). A new GitHub shard stays closed until you change the list. Read the new list with `gh api meta --jq .domains.actions`.
- **MCP**: `--mcp` is refused with the ax runner: the servers' commands would have to exist in the VM.

### Per-rig egress

The default policy is Anthropic and GitHub. A rig adds rules after those:

```
--egress <host>[,<host>...][=<KEY>[:<Header>:<Prefix>]]     repeatable
```

Hosts are hostnames. With `=KEY` the gateway puts the agent-vault credential `KEY` (SCREAMING_SNAKE_CASE, as agent-vault names it) in `Header` after `Prefix` (default `Authorization` and `Bearer `; `KEY:x-api-key:` sends the bare key). Without `=KEY` the hosts are reachable and nothing is injected. Without `FACTORY_AX_VAULT` no rule injects. The rules are stored on the rig (`egress` in `rigs.json`: `{hosts, key?, header?, prefix?, port?, pathPrefixes?}[]`), validated by `rig add` and `rig egress add`, and only for a runner with an egress policy. `factory rig egress add <rig> <rule> [--port n] [--path-prefix /path/]...` adds one rule. `factory rig egress rm <rig> <hosts>` removes one.

```sh
# a codex rig: OpenAI's API, with OPENAI in the factory vault (agent-vault, next to ANTHROPIC and GITHUB)
factory rig add api ~/repos/api --runner ax --agent "codex -m gpt-5-codex" --egress api.openai.com=OPENAI
# more hosts without a key (a package index), and a header that is not Authorization
factory rig add web ~/repos/web --runner ax --egress pypi.org,files.pythonhosted.org --egress api.example.com=EXAMPLE:x-api-key:
```

The key itself lives in the agent-vault vault, never on the laptop or in the VM; the policy only names it.

### Getting `factory report|mail|memory add` back to the laptop

The Task sets `FACTORY_OUTBOX`. Inside the VM, `factory report`, `mail`, `memory add` and `memory helped` append `{argv, from, at}` to the outbox and print `queued for the factory` (for a report, also `you are done, stop now`) -- but only once their own args pass `worker.outboxUsage`: `--help`/`-h` in a positional slot (never free text) prints usage and exits 0 without touching the outbox, and malformed args (`report` with fewer than 3 args, a non-numeric seq, or an outcome starting with `-`; `mail` with fewer than 2 args; `memory helped` with no note path) print usage on stderr and exit 1, also without touching the outbox. The laptop would refuse some `memory add` commands. These have no summary, a stray `--flag`, or a `memory.gate` failure (a missing or bad `--kind`, or a bad `--until`). The VM prints the reason on stderr and exits 2. It does not touch the outbox. Before this, `factory report --help` queued a real outbox line indistinguishable from an actual report (claude-factory-4x1). Each tick, `taskInfo` runs `ax ssh <task> -- <as the worker user> factory worker poll <cursor>` (see Root, then the worker user), which prints `{status, session, lines}`. Before polling, it sends whatever is still queued to `put` (the brief, the run's beads copy) in at most `PUT_TICK_PARTS` (8) parts a tick, each of at most `ax.PUT_PART` (96 KB of base64 each, since Substrate takes no ssh argument much past 128 KiB): `ax ssh <task> -- <as the worker user> factory worker put <name> <part> <parts> <base64>` for each. A `put` that fails (the VM still waking, or a worker-user problem) is retried every tick for up to 5 minutes (`TaskSide.putFailedAt`, `.putError`; `TaskSide.putPart` holds the next part, and a part that lands clears `putFailedAt`); past that the attempt FAILs with ax's stderr (`WorkerInfo.failed`), instead of retrying silently until the station's own time limit with nothing in the journal. The VM's agent writes the outbox, and it may be steered by what it read, so only four commands replay (`replayable`): a `report` on this task's own run and seq, `mail` on its own run, `memory add` and `memory helped`. The laptop removes every `--from` from the last two and sets `--from <run>/<station>`. Each runs as the same CLI command locally, with `FACTORY_FROM` set to the station the laptop recorded at launch (`<run>/<task>.json`), never the line's `from`, and `FACTORY_OUTBOX` cleared (a test caught the replay queueing itself again). `FACTORY_RUN` is set to the run, so a runner that inherited another run's value still replays its own lines. A worker with `FACTORY_RUN` set cannot run `report`, `mail`, `poke`, `retry`, `goto`, `abort`, `decide` or `memory add|helped --from` for any other run (`otherRunRefusal`). It polls from cursor `0` every tick and dedupes by content: `<run>/<task>.seen` holds, for every line it has already replayed, a count keyed by that line's sha256 (a line repeated twice replays twice, matching the multiset of lines really there). This survives a worker shrinking `outbox.jsonl` (a line-count cursor does not: an edited or deleted already-replayed line would misalign every line after it, and claude-factory-4x1 is a worker hiding a probe that way). When a line already counted as replayed goes missing, the laptop appends `<iso> missing N of M consumed lines` to `<run>/<task>.outbox-edited` and prompts the worker that the outbox is append-only, once per increase in how much is missing, not every tick it stays missing. A task that started before this (an old `<run>/<task>.cursor`, no `.seen` yet) treats its first `cursor` lines, as polled now, as already replayed. Any other line (`decide`, `goto`, another run's report) and a refused command (a stale seq, a bad outcome) go back to the worker as a prompt. A deny line (a `deny` key and no `argv` key) is not a command: the laptop sends no prompt, appends a valid one to `<run>/denials.jsonl` and marks it seen (claude-factory-dsfg). The worker hook masks the value of each `NAME=value` word in its `command` field first (claude-factory-uzes).

A report carries the VM's token usage. When a station closes with no stored usage for its node and seq (a timeout or a lost worker), the laptop runs `ax ssh <task> -- <as the worker user> factory worker usage`. It sends the printed JSON array through `validUsage` and stores the rows with the laptop's node and seq. An image without that verb exits 1, and the laptop stores no rows.

`poll` also prints `tail`: a Claude worker's last transcript entry. The reconciler reads the usage limit and the context size from it, as it does from a pane's transcript. A VM's Claude runs on the vault's token, which ccswitch does not rotate, so a worker refused for the limit is held until `resetsAt` (the manager is told once), and the nudge after that gives it its next turn. After a report, the laptop runs a best-effort `git pull --ff-only` into the run's worktree.

If `FACTORY_AX_TOKEN_SWAP` is set, the reconciler starts that command. The reconciler does not only wait. The command moves the vault to a new slot. Then the reconciler sends the manager a mail that shows which slot is live. The worker continues when agent-vault reads the vault again, in 5 minutes or less, not at `resetsAt`. A wait can be longer than that window. This happens with no swap command or after a failed swap. Then the reconciler parks the station until `resetsAt`. It sends a FAIL with a `hold`, spends no attempt and closes the task. The manager gets one mail, "held, not failed".

A `rate_limit` entry with no `quotaLimits` is also a limit hit. The reset time comes from the text "resets <date> (UTC)". A 401 is a hit too.

A file named for the runner stops one more run for the same limit. Codex has its own: `FACTORY_AX_CODEX_TOKEN_SWAP` (for example `bin/codex-token refresh`, which copies the live label again when its token expires within `CODEX_TOKEN_MARGIN_HOURS`, default 48; or `bin/codex-token best`; `refresh` exits 3 when it copies nothing, so use `best` if a usage limit must also swap labels), the state file `token-swap-<runner>-codex.json` and a mail that names the live label. The `ax` runner finds a Codex limit from `poll`'s `limit` field, which the VM reads from the `turn.failed` or `error` line "You've hit your usage limit" of `codex exec --json`. `poll` gives kind `auth` for a `turn.failed` line with one of these texts: "unexpected status 401 Unauthorized", "access token could not be refreshed" or "Failed to refresh token: <status>". The last text means that the authority refused the VM's placeholder refresh. An `error` retry line never gives `auth`. The reconciler runs the same swap command. With no swap command, it parks the station for 1 hour. The reason is "login refused (auth)". After 1 hour, the reconciler checks the stream again. The reconciler also runs the Codex command when its state file is 12 hours old or older, so the live field never goes stale (an access token lasts about 10 days). The Codex command runs at most one time each hour for each runner, also after a refusal. Without `FACTORY_AX_CODEX_TOKEN_SWAP`, nothing copies the token again, and the copy expires. The reason in the run log names the harness: "Codex login refused (auth)" or "Claude usage limit (seven_day)".

`bin/codex-token` copies the access token and account id of a ccswitch Codex session into the op item that agent-vault reads. Set `CODEX_TOKEN_ITEM`, `CODEX_TOKEN_VAULT`, `CODEX_TOKEN_LIVE_FIELD` (vault key `CODEX_CHATGPT`), `CODEX_TOKEN_ACCOUNT_FIELD` (vault key `CODEX_CHATGPT_ACCOUNT`), `CODEX_TOKEN_ACTIVE_FIELD` and `CODEX_TOKEN_LABELS` (the emails, in priority order). Create each session once on the laptop with `ccswitch token create --codex <email>`: ccswitch keeps these sessions fresh. Do not use your own `Codex-Account-<label>` profiles: your interactive codex refreshes those, and a second refresher spends their single-use refresh tokens. The script never writes a refresh token. Run it with no argument to see each label's use of the limit. Each worker of that runner uses this file. If there is no command, or if the command does not complete, the reconciler waits as shown above. For example, the command does not complete when all slots are also at their limit. `bin/claude-token best` is one such command; the comment at the top of the script names its variables. The broker image also runs it. `factory token [list] | use <n> | best` does the same work from five settings (see the README, Token slots).

Pulling means nothing on the cluster ever needs a route back to the laptop.

The launch puts `memory.tgz`: the rig's notes with a cut `.index.json` and `.usage.jsonl`. If it is over `MEMORY_SNAPSHOT_MAX` (8 MiB), the launch does not put it. The side file then has `memorySkipped` with the reason. The first `memory search` in the VM unpacks it into `FACTORY_HOME/memory`. A search before the last part lands finds nothing. In addition, the launch runs `memory search --from <run>/<station>` once on the laptop. The query is the station and the goal. The brief carries the top 5 notes with their laptop paths, and the `shown` events carry the run and station. If the search fails, times out or finds nothing, the brief has no notes and the launch goes on. A resumed session runs no search. `CORE.md` and the topic list also reach the worker in its brief. When a note helps, the worker runs `factory memory helped --from <run>/<station> <note path>`, and the outbox carries it to the laptop.

### Beads in the VM

How the factory uses beads in general is in [beads.md](beads.md).

The laptop keeps each rig's issue store in its own dolt server and pushes it to the repo's GitHub origin, where dolt keeps it under `refs/dolt/data`. The VM reaches GitHub through the egress gateway, so it works on that copy:

- **Launch**: the laptop pushes the rig's store (`bd dolt push` in the run's worktree), so what it wrote since (the run's plan, say) is on GitHub, and sets `FACTORY_BEADS`.
- **In the VM**: after the repo clone, `serve` runs `bd bootstrap` in `.factory-worker/beads`, a directory of its own with the repo's https origin, since the repo's `.beads` config names the laptop's dolt server; `BEADS_DOLT_SHARED_SERVER=0` keeps bd off it. The agent's `bd` finds the clone through `BEADS_DIR` and is plain bd: reads and writes, ids as bd gives them. A resumed task keeps the clone.
- **Back**: `factory report` in the VM pulls (merging what was pushed meanwhile) and pushes before it queues the report, retrying when another push won the race. The laptop and the VM can change the same row in `dependencies` on the same day. dolt's auto-merge then declines, and the pull hits a merge conflict. The pull retries with `--strategy ours`. This keeps the VM's version on the conflicting rows, the same policy as the laptop's own pull, below. The laptop does not comment on those rows. A sync can still fail after 3 tries. Then `factory report` refuses and queues nothing; it names the failed step (`pull` or `push`) and bd's own last error line, and tells the worker to mail the manager. When the laptop replays the report it pulls the rig's store, so the next station sees the worker's writes.

If the pull fails with a schema skew (`table has unknown fields`), the VM's bd is older than the store, and no retry helps. Then `factory report` does not refuse. It queues the report with a `bdSkew` field that holds the redacted error, and exits 0. The laptop does not replay such a report. It checks the field (a string of 300 chars or fewer that holds the skew text), and holds the station as an outage: for the first 4 holds in a row (`OUTAGE_HOLDS` in `src/machine.ts`) the run spends no attempt. The 5th hold in a row fails like any other fault and spends an attempt. The log keeps the worker's outcome and text. The laptop writes `bd-skew-<rig>.json` in `$FACTORY_HOME` and sends the manager one Question for the rig. While the file is less than 60 min old, no VM of that rig starts. After that, one start goes through as a probe. The hold ends 3 h after the first skew report (`since` in the file). Later reports and probes do not move that time, so a VM cannot renew the hold. A normal report replay deletes the file. To end a hold by hand, delete the file.

Pushes from a stale copy are refused until it pulls. A pull merges cell by cell, so different fields and new issues from both sides survive; when both sides changed the same field, the later push wins. A changed `dependencies` row is the exception. dolt does not auto-merge it. This is the conflict that the VM's pull, above, retries past. Measured on a test cluster: a 534-issue store (204 MB) bootstraps in 3 s.

A large store makes GitHub slow for this (a push of one past 1 GB did not finish in 40 minutes), so a rig can share its beads through a Dolt server of its own instead: `beadsRemote` in `rigs.json`, `{ name, url, user }`. `factory rig beads-remote set <rig> --name n --url u --user user` sets it, and `rig beads-remote clear <rig>` clears it. `factory rig egress add <rig> <host>=<KEY>:Authorization:'Basic ' --port <n>` adds its egress rule. The laptop pushes and pulls the remote `name` in its store, as `user` (its Dolt server holds the password, in `DOLT_REMOTE_PASSWORD`). The VM bootstraps from `url` (`FACTORY_BEADS_REMOTE`, written as the clone's `sync.remote`) with `DOLT_REMOTE_USER` set to `user` and `DOLT_REMOTE_PASSWORD=placeholder`. Dolt sends those as an `Authorization: Basic` header, so the rig's egress names the server's host and port with a vault key holding the real `base64(user:password)`, injected after `Basic ` (`{hosts, port, key, header: "Authorization", prefix: "Basic "}`). The gateway injects only on HTTPS it intercepts, so the remotesapi serves TLS with a certificate the gateway's upstream trust accepts. A launch pulls the remote before it pushes. A pull runs in one transaction: it commits the laptop's pending writes, merges, and where the laptop and a VM changed the same row it keeps the VM's (the worker did the work it reports on), then comments on each overwritten issue what the laptop had.

### Tools in the VM

The image carries no language toolchains. It carries Nix instead: single-user (gVisor refuses `setgroups`, so there is no daemon and no build users) and the worker user's once `serve` starts, substituting from `cache.nixos.org` and `devenv.cachix.org` (with its flake registry from `channels.nixos.org`; turning that off in `nix.conf` would change every devenv's derivation) and building what neither holds, with nixpkgs and `devenv` in the image. `devenv` is in the image, but `devenv shell` fails in a VM: local Nix builds die under gVisor before the builder starts (`reading a line: Input/output error`), even for a one-line derivation, and a devenv profile is always built locally. A rig whose repo has a `devenv.nix` can serve its devenv from a binary cache of its own instead: build `devenv shell` once outside a VM at the same path (`/workspace/w/repo`, since its derivations depend on it) and push the closure to a cache (attic, say), set the rig's env `FACTORY_NIX_CACHE` to the cache's URL and public key (`https://cache.example:8443/devenv devenv:AAAA...=`), and add the cache to its egress with the cache's token injected (`--egress cache.example=NIX_CACHE`; HTTPS only, since the gateway injects nothing over plain HTTP). Each VM then loads the devenv's environment into the worker before the agent starts, with Nix asking the cache with a placeholder password the gateway replaces, and the brief tells the agent its tools are on PATH. It never runs `devenv shell`, whose enterShell runs the repo's git hooks. It also drops the `eval ${shellHook:-}` line from `devenv print-dev-env`'s script before it sources the script, so `enterShell` does not run. `factory devenv [rig...] [--force]` does the build and push: for each AX rig with `FACTORY_NIX_CACHE` (or the rigs named), it fetches the default branch and builds its devenv in the worker image (`FACTORY_AX_IMAGE`) on a buildx builder, at the VM's path, then runs the cache's push command on the closure. It skips a rig whose `devenv.nix`, `devenv.yaml` and `devenv.lock` and the image are as last built; the tick runs it every half hour, so a lock change is cached within the hour. It reads three settings from `$FACTORY_HOME/devenv.json`. Set them with `factory settings set`, and see them with `factory settings`:

```sh
factory settings set devenv.builder '<amd64 buildx builder>'
factory settings set devenv.token '<command printing the push token, e.g. op read ...>'
factory settings set devenv.push "nix shell nixpkgs#attic-client -c sh -euc 'attic login c <cache-server> \"\$(cat /run/secrets/cache)\" >/dev/null && attic push c:<cache> \$ROOTS'"
```

The tokens (the push token and `gh auth token`, for a private repo's clone) reach the build only as buildx secrets. Each rig's log is `$FACTORY_HOME/devenv/<rig>.log`. An agent installs what it lacks with `nix shell nixpkgs#go nixpkgs#gnumake ... -c <command>`, or uses the repo's own `nix develop`. Both caches are in every task's egress. The package age gate below (`FACTORY_AX_PKG_GATE`) is opt-in, off by default: until it is on for a rig, that rig's package registries go in `--egress` the same as any other host (a Go rig, say, needs `proxy.golang.org,sum.golang.org`), and nix-provided toolchains reach them directly with no age check at all. Once the gate is on, the opposite holds: a rig's package registries never go in `--egress` directly, since they are stripped from the policy even if listed, and nix-provided toolchains reach the real registries over no wrapper at all, so every rig goes through the gate instead (`setup-envtest`'s non-registry hosts still need `--egress`: `raw.githubusercontent.com,release-assets.githubusercontent.com,objects.githubusercontent.com`).

When the devenv's cache holds its closure, `serve` starts the devenv's processes and services next (for example `devenv.nix`'s `services.postgres`). It runs each process's own command directly. It never runs `devenv up` or `devenv shell`, because both run the repo's `enterShell`. `serve` reads the process list from `DEVENV_TASK_FILE` (devenv's `tasks.json`). It skips a oneshot (`devenv:enterShell` and the like) and a process whose `start.enable` is `false`.

`tasks.json` lists the rest by name, not by dependency. `serve` reorders them by each process's own `after` list first. This way, a dependency starts before the process that names it. `serve` starts each one detached, with its own `env` field merged over `serve`'s env. It logs each one to `.factory-worker/services/<name>.log`.

`serve` checks each process's own readiness probe. The probe is `process.ready.exec`, run with the same merged env, or `process.ready.http.get`. The `http.get` probe is an object with `host`, `port`, `path` and `scheme` fields; `serve` turns it into a URL. `serve` waits up to `FACTORY_SERVICES_WAIT_MS` for the probe to pass (120000 ms by default). A `FACTORY_SERVICES_WAIT_MS` value that is not a positive, finite number also falls back to 120000 ms. If the devenv does not already set `DATABASE_URL`, `serve` sets it in the agent's env. It builds the value from `PGHOST`/`PGPORT`, or from a socket-dir form when `PGHOST` is a path.

The first turn's brief ends with a `[factory] services: ...` line. This line names each process as ready or failed. A process that exits, or never turns ready, does not block the turn; its failure line names its log. To turn this off, set `FACTORY_SERVICES=0` in the rig's env.

#### Toolbelt

The image carries the tools that every rig needs: `devenv`, a JDK (`keytool`), `gitleaks` and `jq`. The house rules run `gitleaks` at every station, so it is in the image. The image carries no Go. `Dockerfile.worker` pins nixpkgs with `NIXPKGS_REV`. It prefetches that rev into the store and checks the content against `NIXPKGS_NARHASH` (change both together), links it as a GC root (`/nix/var/nix/gcroots/nixpkgs-pin`) and sets `NIX_PATH` to the link. It also registers the store path as `nixpkgs`. So `nix-shell -p go` and `nix shell nixpkgs#go` give the same Go, from the pin. Never point `NIX_PATH` at a channel: a channel can be older than the pin.

Each tool that only some rigs need goes in that rig's `devenv.nix`: `go`, `govulncheck`, `kustomize`, `kubeconform`, `bats`, `promtool`, `postgresql` and so on. A rig pins each tool at the version its CI uses. The `factory devenv` pass above builds the devenv and pushes it to the rig's attic cache. A VM loads it from the cache with no full build.

| Rig kind | Where the tools come from |
| --- | --- |
| AX rig with `FACTORY_NIX_CACHE` | the rig's `devenv.nix`, cached by `factory devenv` |
| AX rig without `FACTORY_NIX_CACHE` | the image tools and `nix shell nixpkgs#<pkg>` |
| Laptop (herdr) rig | the laptop `PATH`; a laptop worker never loads a devenv |

To add a tool to a rig:

1. Add the package to `packages` in the rig's `devenv.nix`. Use the same version as the rig's CI. If the pin has another version, add a `devenv.yaml` input pinned to a nixpkgs rev with the CI version, or move the CI pin.
2. Merge the change. The next `factory devenv` pass rebuilds the devenv. Check that `$FACTORY_HOME/devenv/<rig>.json` shows `ok: true`.
3. For a tool that every rig needs, add it to the `nix profile install` line in `Dockerfile.worker` and to the build smoke after it. Add a row to `src/dockerfile.test.ts`.

A new image digest changes the cache key of every rig, so the first pass after an image change rebuilds each cached rig.

`serve`'s setup also makes three things a sandboxed test expects: a `localhost` entry (the VM has no `/etc/hosts`), `GOTOOLCHAIN=local` (Go comes from the image pin or the rig's devenv, and the default egress has no Go toolchain host), and a `kube-apiserver` wrapper for envtest (`TEST_ASSET_KUBE_APISERVER`) that adds `--advertise-address=127.0.0.1`, since the VM's only address is link-local and kube-apiserver will not advertise one. Measured on a test cluster: a Go operator repo's `make vet test` (74 packages, envtest included) passes in a VM.

A Bazel rig shares a remote cache through the gateway. The rig's `env` (in `rigs.json`, over `FACTORY_AX_ENV`) sets `FACTORY_BAZELRC` to its cache flags, with the cache's key header set to a placeholder, and its egress names the cache host with the vault key to inject there (`<cache-host>=<KEY>:x-buildbuddy-api-key:` for BuildBuddy). Set it with `factory rig env set <rig> 'FACTORY_BAZELRC=<flags>'` (quote the whole `KEY=VALUE` when the value has spaces). `serve` writes those flags to the VM's `~/.bazelrc`, then adds the gateway's CA twice: `--tls_certificate` for the cache's gRPC, and a Java trust store for Bazel's JVM, which fetches modules and toolchains and reads no PEM. `keytool` comes from the image's JDK (an older image gets it from Nix). `serve` writes the Java flags only when `keytool` made the store, and sets `sessionCacheSize=1` to stop parallel-fetch PKIX failures. A rig with no `FACTORY_BAZELRC` gets the same CA lines when the repo root has `MODULE.bazel`, `WORKSPACE` or `WORKSPACE.bazel`. A Bazel workspace in a subdirectory needs `FACTORY_BAZELRC` on its rig. The rig's egress also needs Bazel's own hosts: `releases.bazel.build,bcr.bazel.build,mirror.bazel.build,codeload.github.com` and its rules' package registries. Measured on a test cluster: a Go package's build, cold in 164 s, ran again after `bazel clean` in 19 s, with all 324 actions remote cache hits.

A rig can read its Kubernetes cluster from the VM, with no token in it. The cluster grants a ServiceAccount read-only access (the built-in `view` role and read on the cluster-scoped resources it leaves out: nodes, persistent volumes, namespaces, storage classes, CRDs; never Secrets or exec), and agent-vault holds its token (`KUBE_READ`, say, a reference like any key). The rig's env sets `FACTORY_KUBE_SERVER` to the API server's in-cluster URL (`https://kubernetes.default.svc.cluster.local`), and `serve` writes `~/.kube/config` with that server, the gateway's CA and the token `placeholder`. The rig's egress names that host with the key (`--egress kubernetes.default.svc.cluster.local=KUBE_READ`, `Authorization: Bearer` by default), and the gateway must trust the API server: its upstream roots need the cluster's CA, which signs kube-apiserver's certificate and is no public root. The brief tells the agent kubectl reads the live cluster and cannot change it.

A rig can read AWS from the VM as a read-only role (`factory-readonly`), with no AWS key in the VM. A credential broker outside this repo (nix-fleet-hosts) issues the role's credentials in the AWS container-credentials format. To turn it on, the person runs these commands:

```sh
factory rig env set <rig> AWS_CONTAINER_CREDENTIALS_FULL_URI=https://<broker-host>:8443/v1/aws/<account>/<task-name>
factory rig env set <rig> AWS_REGION=<region>
factory rig egress add <rig> '<broker-host>=AWS_BROKER:Authorization:' --port 8443 --path-prefix /v1/aws/<account>/
```

- **Env**: set `AWS_CONTAINER_CREDENTIALS_FULL_URI` to `https://<broker-host>:8443/v1/aws/<account>/<task-name>`, and set `AWS_REGION`. Use the same `<account>` as in the egress `pathPrefixes`. If the accounts differ, the gateway refuses the request. When the URI is set, `ax.launch` sets `AWS_CONTAINER_AUTHORIZATION_TOKEN` to `placeholder`. It replaces any other value, and it drops a token that has no URI. The VM never holds a real token.
- **Egress for the broker**: `{"hosts":["<broker host>"],"key":"AWS_BROKER","header":"Authorization","prefix":"","port":8443,"pathPrefixes":["/v1/aws/<account>/"]}`. The broker listens on https port 8443, so the rule must name the port. The gateway adds the `AWS_BROKER` bearer to every request that it lets through to the broker host, and the VM picks the path. Without `pathPrefixes`, every task on the rig can get `factory-readonly` in all 5 accounts, the root account included. `pathPrefixes` limits the rule to one account, so give each rig one `<account>` alias. An old `atenet` ignores `pathPrefixes` and applies the rule to all paths. The AWS SDKs send the token as the raw `Authorization` value, with no `Bearer ` prefix. The gateway replaces `placeholder` with the vault key `AWS_BROKER`. The vault key must hold the same value as the broker's bearer.
- **Egress for AWS**: one rule with no key. It lists the AWS hostnames the role needs, for example `sts`, `iam`, `ec2`, `eks`, `s3`, `logs`, `monitoring` and `route53` on `amazonaws.com`. Add the regional names for the rig's region. The gateway refuses a host that is not in the list. `factory rig egress add <rig> sts.amazonaws.com,...` adds it.
- **CA**: `serve` sets `AWS_CA_BUNDLE` to the gateway's CA. The AWS CLI does not read `SSL_CERT_FILE`.
- **Brief**: when the URI is set, the brief tells the agent that AWS reads work. It also says that AWS refuses every write and every secret read.

The broker must meet five conditions. The gateway's upstream roots must trust its certificate (the Fleet CA). A NetworkPolicy must allow ingress only from `ate-system`. It must compare the bearer. It must not trust `<task-name>` for authorization, because the VM picks it. It must refuse every path that is not exactly `/v1/aws/<account>/<task-name>`.

The broker must refuse these paths: a dot segment (`..` or `.`), a percent-encoded `/` or `.`, and a path with an extra segment. Then the gateway prefix match and the broker read the same account.

S3 bucket hostnames are not reachable, so the agent runs `aws configure set default.s3.addressing_style path` before it reads an S3 object.

Owner-only steps: merge the broker change, add the vault key `AWS_BROKER`, and run the `rig env set` and `rig egress add` commands above.

### Package age gate

Substrate's `EgressPolicy` allows a task by hostname and port only: once `proxy.golang.org` or `pypi.org` is in a task's egress, every path on it is open, including to `nix shell nixpkgs#go -c go get <fresh module>` reaching the real registry directly, past whatever age check a PATH wrapper (`pkg-guard` on a laptop) would have made. So the age gate is a proxy outside the VM, `factory pkg-gate serve` (`src/pkggate.ts`), the only registry host a task may ever reach once it is on: `/go` speaks the GOPROXY protocol, `/npm/<pkg>` serves the packument with young versions and their tarballs removed, `/pypi/simple/<pkg>` serves the PEP 691 index the same way, all refusing a version younger than `PKG_GATE_MIN_DAYS` (4 by default) and failing closed (refuse, not pass through) on an upstream error or a missing or unparseable publish time.

**Factory server rule**: `FACTORY_AX_WORKER_SERVER=https://<host>[:port]` on the laptop (for example `https://factory.factory.svc.cluster.local:8443`) adds one https rule to the factory server for every task launched after. The rule has no `effects`: the worker CLI sends its own token. `ax.egressPolicy` throws for a value that is not an https URL, or that names port 8444 (the person-CA listener, which a VM must never reach). If you unset the variable, the policy is byte-identical to before and workers fall back to the outbox.

`FACTORY_AX_PKG_GATE=<scheme://host[:port]>` on the laptop turns it on for every task launched after (a running task keeps its policy until relaunched):

- **Policy** (`ax.egressPolicy`): adds the gate's own rule, and strips every one of `ax.REGISTRY_HOSTS` (`proxy.golang.org`, `sum.golang.org`, `goproxy.io`, `goproxy.cn`, `registry.npmjs.org`, `registry.npmjs.com`, `registry.yarnpkg.com`, `registry.npmmirror.com`, `pypi.org`, `pypi.python.org`, `test.pypi.org`, `files.pythonhosted.org`) from the rig's own egress rules, dropping a rule left with none. This is what enforces the gate: a worker that unsets an env var below, or reaches for `nix shell nixpkgs#go` directly, still hits a refused host. `factory rig add --egress` warns (but still adds) when a rig lists one of these hosts, since a gated policy drops it silently later. If a rig's rule for one of those hosts carried its own key (a private registry's auth header, injected the way the Dolt or kube rules above are), the strip removes that rule too, with no substitute: a private package becomes unreachable once the gate is on, since the gate itself forwards no auth upstream.
- **Convenience env** (`ax.launch`): sets `GOPROXY`, `NPM_CONFIG_REGISTRY`, `BUN_CONFIG_REGISTRY`, `YARN_NPM_REGISTRY_SERVER`, `PIP_INDEX_URL`, `UV_DEFAULT_INDEX` and `UV_INDEX_URL` at the gate (plus `PIP_TRUSTED_HOST`/`UV_INSECURE_HOST` and `YARN_UNSAFE_HTTP_WHITELIST` for an `http://` gate, since pip, uv and yarn berry all refuse a plain-http registry outright otherwise), so a toolchain that honors them needs nothing else. Only the egress strip above is what a worker cannot route around.
- **Bazel** (`worker.ts` `bazelrc()`): when `FACTORY_BAZELRC` is set, adds `--repo_env=GOPROXY=...`, `--repo_env=PIP_INDEX_URL=...` and `--repo_env=NPM_CONFIG_REGISTRY=...` for whichever of those the launch env above set, so `rules_go`/`rules_python`/`rules_js` fetch through the gate too.
- **Go first-log check**: `proxy.golang.org`'s `.info` `Time` is the tagged commit's time. The module's author controls that time. A new tag on an old commit works. A backdated commit also works. So the gate also checks the `sum.golang.org` log of each version. The gate looks up `<module>@<version>` at `PKG_GATE_UPSTREAM_SUMDB` (`https://sum.golang.org` by default). It does this for each Go version that is old enough to pass the `.info` check. The first time `sum.golang.org` logs a version's content hash, it gives the lookup a record id. A later lookup returns the same id. So an author cannot backdate it. The gate also keeps a floor. The floor is an estimate of the record id in force at `now - PKG_GATE_MIN_DAYS` days. The gate builds the floor from `index.golang.org` (`PKG_GATE_UPSTREAM_GO_INDEX`, `https://index.golang.org` by default). It samples versions first seen near that time. It looks up each sample in `sum.golang.org`. Before those lookups, it reads the current tree size of `sum.golang.org` (`GET /latest`). It drops any sample whose own record id sits at or past that size. The refresh's own lookup traffic set such a record. An old entry did not. So the record proves nothing about what `sum.golang.org` held well before now. The refresh takes the minimum of the remaining record ids as its raw estimate. A refresh that fails, or that keeps too few samples after the drop, leaves the existing floor in place. Otherwise, the new floor is the lower of two values: the raw estimate, and a cap. The cap is the old floor plus 3 times the real `sum.golang.org` traffic since the last successful refresh. This traffic is the growth in its tree size over that span. The assumption: the sumdb record rate now is at least 1/3 of the rate `PKG_GATE_MIN_DAYS` days ago. So that traffic count is a fair lower bound on how far the true floor can move. A `capped: true` line can also come from an honest rate drop of more than 3x. That case only makes the floor lag low. It is an availability cost, not a safety gap. Suppose an attacker controls every entry that `index.golang.org` samples. Suppose the attacker logs each one in `sum.golang.org` right before the refresh. The cap limits only that one refresh's rise. Suppose the attacker owns the samples at every refresh in a row. The cap alone would let the floor gain about 2x real traffic per refresh. So the gate also keeps a ceiling. The gate stores each tree size that a refresh reads, with the time of the read. It keeps the newest read at or before `now - PKG_GATE_MIN_DAYS` and every later read. The ceiling is the tree size at `now - PKG_GATE_MIN_DAYS`, estimated from that history. If the history is shorter than `PKG_GATE_MIN_DAYS`, the gate extrapolates the observed growth rate. Otherwise, it interpolates between two real reads. The ceiling is absolute, so it does not compound across refreshes. The attacker's own lookups only raise the tree size, and so they lower the ceiling (claude-factory-ldb). A cold start (no floor yet) with a history shorter than 30 minutes (`GO_FLOOR_WINDOW_MS`) has no ceiling, because a short span multiplies noise by `PKG_GATE_MIN_DAYS` divided by the span. This includes the first refresh (claude-factory-qyuu). Once a floor exists, the ceiling applies at every span above 0. The gate sets a negative tree size growth to 0. Thus a smaller `/latest` cannot put the ceiling above the tree size. Suppose the wall clock is not after the newest stored read (a clock step back). Then the refresh fails and keeps the floor. It stores no read (claude-factory-35em). The cap means a refresh can also lower the floor. A lower floor refuses more versions, which is the safe side. A decision waits on a refresh only when the floor is still unset. That is a cold start. A cold start also has no cap on its first refresh. This is a residual gap, filed as claude-factory-b9f. Once a floor exists, a stale one still decides at once. Its refresh runs in the background instead. A refresh that fails backs off (30s, doubling up to 10 minutes) before the gate tries `index.golang.org` again. A version with a record id above the floor is too new. The gate does not accept it, even when its `.info` `Time` alone looks old enough. `/healthz` reports the current floor as `goFloor: {record, at} | null`. Each refresh attempt logs one JSON line. On success, the line is `{eco:'go', floor, at, samples, sampled, capped}`. On failure, the line is a `decision: 'error'` line. Neither line names a URL. The gate's namespace needs egress to `sum.golang.org` and `index.golang.org`, as well as to `proxy.golang.org`.
- **Client sumdb passthrough** (claude-factory-1hc): by default, `GOSUMDB` makes the go command verify each module against `sum.golang.org`. It does this through the proxy's `/sumdb/sum.golang.org/*` path. `proxy.golang.org` answers 404 on every one of those paths. So the gate answers `GET /go/sumdb/sum.golang.org/supported` itself, with no upstream fetch. It forwards `latest`, `lookup/*` and `tile/*` straight to `PKG_GATE_UPSTREAM_SUMDB`. This lets a gated task's default `GOSUMDB` verify modules through the gate. Without it, the go command falls back to a direct `sum.golang.org` fetch, which the egress strip above blocks.
- **Upstream redirects** (claude-factory-qls): the gate follows a 3xx from an upstream by hand, at most 5 hops. Each hop must go to a configured upstream (`PKG_GATE_UPSTREAM_*`) or to `https://storage.googleapis.com` (the host `proxy.golang.org` can use for a `.zip`). The gate answers 502 for any other target and never requests it. The sumdb passthrough refuses every 3xx.
- **The person's lever**: `PKG_GATE_ALLOWLIST_GO`/`_NPM`/`_PYPI` (colon-separated module/package names, exact match, bypassing the age check including a missing publish time, one list per ecosystem so an entry for one never unlocks the same spelling in another) is set only on the gate's own Deployment (`deploy/pkg-gate.yaml`), never by a worker or a task's env, so nothing a VM sends can change a decision. The gate refuses to start if the old shared `PKG_GATE_ALLOWLIST` is still set, rather than reinterpreting it. `PKG_GATE_UPSTREAM_GO`/`_NPM`/`_PYPI`/`_FILES`/`_SUMDB`/`_GO_INDEX` override the real registries the gate itself fetches from (`proxy.golang.org`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `sum.golang.org`, `index.golang.org` by default); neither is normally set.
- **Deploying it**: `deploy/pkg-gate.yaml` runs `factory pkg-gate serve` as the worker image, with its `ax-task-runner` entrypoint overridden, behind a plain `Service` on port 8080 — not TLS, unlike the Dolt remotesapi and a nix cache above. Those are served over HTTPS because the gateway's MITM decrypts them to inject a vault credential (`replaceHeaders`); the gate's own egress rule has no `key`, so there is nothing to inject and TLS buys it nothing, at the cost of the gateway's upstream trust needing a new entry for it (as `kubernetes.default.svc.cluster.local` above does). So `FACTORY_AX_PKG_GATE=http://pkg-gate.pkg-gate.svc.cluster.local:8080`. The gate's own namespace, not a task's EgressPolicy, needs outbound internet access to the real registries; that is the cluster operator's NetworkPolicy, not this repo's.
- **Residual gaps, filed and out of scope here**: Direct fetches of public dependencies never go through the gate. The fetches go to `github.com` and use `GOPROXY=direct` or `git+https` (claude-factory-lpv). The first Go sumdb floor refresh after a pod start has no prior traffic count. It cannot limit its rise against one. So it still trusts its raw sample (claude-factory-b9f).

### OTel export (claude-factory-ozso)

Set `FACTORY_OTLP_ENDPOINT` to make every Claude and codex worker export OTel. The value is a plain `http://` or `https://` base URL, for example `http://host:4318`. It has no user, path or query. If it is unset or not valid, a launch carries no OTel.

- **Resource tags**: `OTEL_RESOURCE_ATTRIBUTES` holds `factory.run`, `factory.station`, `factory.rig`, `factory.attempt`, `factory.harness` and `factory.model`.
- **Claude**: the launch env holds `CLAUDE_CODE_ENABLE_TELEMETRY=1`, the OTLP http/json exporters for logs, metrics and traces, and `OTEL_LOG_TOOL_DETAILS=1`. The factory never sets `OTEL_LOG_USER_PROMPTS`.
- **codex**: the factory appends an `[otel]` block to the worker's `config.toml` (`log_user_prompt = false`). Pane workers and VM workers (`vmCodexHome`) get the same block.
- **AX**: the laptop reaches the collector at a NodePort and a VM reaches it in the cluster. `FACTORY_AX_OTLP_ENDPOINT` replaces `FACTORY_OTLP_ENDPOINT` for AX tasks. Each task policy gets a plain http rule for that host and port, with no key and no header. A pi worker gets no OTel. The AX manager task gets both variables from the laptop, so tasks it launches export OTel too.
- **Content off**: use `factory rig set <rig> --otel-content off`. The rig gets no `OTEL_LOG_TOOL_DETAILS` for Claude and no codex log exporter, because codex logs hold tool arguments and output. Traces and metrics stay.
- **Owner step**: set the two variables for the factory runner (and for the AX manager if it launches tasks). New launches use them. A running worker keeps its env. To turn it off, unset them.

### Suspend while a worker waits on mail

A worker that is idle and has asked the manager (the existing `isAsking`) is suspended with `ax suspend task`. Its status shows `suspended` on the board, and it is not polled. When the answer arrives, `deliver` sees the task is not `Running` and runs `ax resume task`, and the mail stays unread. The next tick delivers it to the running task.

AX can fail to restore a suspended task. The task then has phase `Failed` and a condition `Ready=False` with reason `ActorResumeFailed`. The message holds the `runsc restore` error. AX does not retry it. The failure reason of the attempt is `phase Failed: ActorResumeFailed: <message>`.

The factory also writes `$FACTORY_HOME/ax-no-suspend-<rig>.json` (`{at, why}`) and sends one mail from `factory` to the manager. For 24 hours after `at`, the factory does not suspend an idle worker of that rig that asked the manager. That worker stays `Running`, and the mail reaches it with `worker prompt`. Delete the file to end the window early.

### Keys: the egress gateway puts them in, from agent-vault

The VM holds no key and no token. Every HTTPS request out goes through Substrate's egress gateway, which decrypts it (sdsmint), checks it against the task's EgressPolicy, and, for a rule with `replaceHeaders`, swaps the placeholder in an auth header for a credential it fetches from its credential provider: agent-vault (`ate-secret://agent-vault/<vault>/<KEY>`). A gateway serves one provider. Substrate's reference provider reads Kubernetes Secrets, which would mean copying keys into them; agent-vault reads them from where they live.

- **Launch** (`src/ax.ts`): reads the gateway's public CA (ClusterTrustBundle `egress-mitm.ate.dev:mitm:primary-bundle`), applies the Task with it in `FACTORY_CA`, then tries once to create the task's policy with `kubectl ate create egress-policy`. AX creates the actor a moment after the apply, so the first try usually fails; each tick tries again (`policy` in `<run>/<task>.json`) and shows the worker as `pending` until it takes. Nothing sleeps in a tick, and every `ax` call has a 30 s timeout. A task whose actor never shows fails on the station's deadline while the shared controller is healthy. The reason names the cause: `worker never started on AX after <N> min: task phase Pending`, `...: egress policy not created` or `...: brief.md not yet copied to the VM`. A worker that started and then went silent still fails `no report within <N> min`.
- **Placeholders** (only with `FACTORY_AX_VAULT`, because GitHub answers a placeholder Basic header with 400 even for a public clone): `CLAUDE_CODE_OAUTH_TOKEN` (claude) or `OPENAI_API_KEY` and `CODEX_API_KEY` (codex in API-key mode; ChatGPT mode sets neither), and `GH_TOKEN`, set to `placeholder`, and git's `http.https://github.com/.extraHeader` set to `Authorization: Basic placeholder` through `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, so every git in the VM sends it.
- **Policy**: HTTPS to `api.anthropic.com` (`Authorization: Bearer` ← `ANTHROPIC`), `api.github.com` and `uploads.github.com` (`Authorization: Bearer` ← `GITHUB`), and `github.com` (`Authorization: Basic` ← `GITHUB_BASIC`, base64 of `x-access-token:<token>`, since git sends Basic auth; the manager task uses `GITHUB_BASIC_MANAGER` there when `FACTORY_AX_BACKUP_REMOTE` is set, and then gets no `zach-source` path rules). Then the rig's own rules, and nothing else, so the task sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Without `FACTORY_AX_VAULT` the policy has the hosts and no injection.
- **Repos of the zach-source account** (`GITHUB_OWNER_KEYS` in `src/ax.ts`): the GitHub App has one installation token for each account. With a vault, only the AX manager policy adds two rules that match a request path (`pathPrefixes`). A worker policy never has them:
  - `github.com` with path `/zach-source/` uses `GITHUB_ZS_BASIC`.
  - `api.github.com` and `uploads.github.com` with path `/repos/zach-source/` use `GITHUB_ZS`.
  - Other paths keep `GITHUB_BASIC` and `GITHUB`.
  - `gh pr` sends pull request calls to `/graphql`. No path prefix can choose a key there. So a worker of a rig with origin owner `zach-source` gets `GITHUB_ZS` and `GITHUB_ZS_BASIC` on the other paths too.
  - The task side file keeps this owner as `githubOwner`, and a retry of the policy uses it.
  - A side file with no `githubOwner`, a GitLab rig and the AX manager task keep the default keys. So the manager cannot use `gh pr view` on a zach-source pull request.
  - The factory CLI does not use `gh pr` for this reason (claude-factory-fbyg). It reads and writes pull requests with `gh api repos/<owner>/<repo>/...`. The path names the owner, so the manager gets the `GITHUB_ZS` key. The dispatch pre-check, the garbage collector and `factory metrics` also read pull requests with REST list calls that name the owner (claude-factory-oz6s). `gh search prs` stays for companion pull requests in other repos. It reads only public repos or repos that the default key can read.
  - A prefix chooses a key. It is not an access control.
  - Rollout order: first the Substrate fork with `pathPrefixes` (`ateapi`, then `atenet`, then `kubectl-ate` and the broker image). An old `atenet` ignores `pathPrefixes` and applies the rule to all paths. An old `ateapi` or `kubectl-ate` can refuse the field, and then no task gets a policy. Do not merge this change before the rollout.
- **Reviewer identity** (`reviewerTask` in `src/ax.ts`, claude-factory-0gww): a task can approve a pull request as a second GitHub App, the reviewer App. The author App does not approve. This is off by default. To turn it on, set `FACTORY_AX_REVIEWER_OWNER=<owner>` and `FACTORY_AX_VAULT` on the laptop. A task gets the reviewer identity when two things are true. Its station is `review`, `security` or `check`. The owner of the rig's GitHub origin equals `FACTORY_AX_REVIEWER_OWNER`. For such a task:
  - `api.github.com` and `uploads.github.com` use the vault key `GITHUB_REVIEWER`. Its value is a raw installation token of the reviewer App (`pull_requests` write, `contents` read). The header is `Authorization: Bearer`, the same as for `GITHUB`. The key reaches only two paths. The first is `/repos/<owner>/<repo>/`, a `pathPrefixes` entry from the rig origin. The second is `/graphql`, an exact `paths` entry. The `gh pr view`, `checks` and `review` commands use GraphQL. Every other API path gets 403 from the gateway. The rule needs a Substrate with `HTTPSRule.paths` (Substrate fork commit 6b0654200). An older `ateapi` or `kubectl-ate` refuses the field, and then no reviewer task gets a policy. A reviewer side file with no `githubRepo` (a task from before this rule) gets no policy and ends as gone.
  - `github.com` uses the vault key `GITHUB_REVIEWER_BASIC`. Its value is base64 of `x-access-token:<reviewer installation token>` (`contents` read).
  - So the task can clone but cannot push. An approval covers only commits that the task did not write.
  - If the vault has no `GITHUB_REVIEWER_BASIC`, the clone fails and the station fails. The policy never falls back to the author key.
  - A review or check station never pushes. If the run has no pull request, the station reports changes. Then `implement` or `quick` pushes the branch and opens the draft pull request.
  - Some runs have beads and a rig with no `beadsRemote`. Their beads sync over the GitHub origin, and `bd dolt push` needs write access. Such a task gets no reviewer identity. It keeps the author keys and can only comment.
  - The task env has `FACTORY_GH_REVIEWER=1`, and the brief says so. Only the factory sets this variable, and only for a reviewer task. `launchTask` removes it from `FACTORY_AX_ENV` and from the rig's `env`. The side file keeps `reviewer: true`, and a retry of the policy uses it.
  - The worker hook allows an approving review only when `FACTORY_GH_REVIEWER=1` and the station is one of these three. An approving review is `gh pr review --approve`, or a `gh api` call with `event=APPROVE`. Every other station and every herdr worker can only comment or request changes.
  - The prompts of these stations post the review with `commit_id` set to the SHA they reviewed. They do not approve a pull request that the reviewer identity authored.
  - To turn it off, unset `FACTORY_AX_REVIEWER_OWNER`. The next tasks get the author keys. The worker image has its own copy of the hook. Rebuild the image to ship the hook rule.
  - Owner steps (a worker never runs these): create the reviewer GitHub App and install it on the repos. Store its installation token in the vault as `GITHUB_REVIEWER`. Store the base64 of `x-access-token:<that token>` as `GITHUB_REVIEWER_BASIC`. Finish the ruleset activation in the repo's risk-merge document. Set `FACTORY_AX_REVIEWER_OWNER`, then restart the manager.
- **A rig on GitLab** (its origin is a GitLab host `H`): the policy adds one rule for `H` that replaces `PRIVATE-TOKEN`, the header `glab` 1.99 sends with `GITLAB_TOKEN` set, with `GITLAB`, and `Authorization: Basic`, which git sends, with `GITLAB_BASIC`. The VM gets `GITLAB_TOKEN=placeholder`, `GITLAB_HOST=H` and a second git `http.https://H/.extraHeader` (`GIT_CONFIG_COUNT=2`). A GitHub rig's policy and env do not change.
- **In the VM** (`setup()` in `src/worker.ts`, on every start): writes the CA and points `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `SSL_CERT_FILE` at it (the gateway re-signs every host the VM may reach, so it is the only root needed), then clones the run's branch.
- **Who may fetch**: Substrate makes one actor per task (`spiffe://substrate-actor.local/actor/factory/<task>`). One agent-vault agent, `factory-tasks`, registered as `spiffe://substrate-actor.local/actor/factory/*` with `proxy` on vault `factory`, covers every task in the atespace, so the runner registers nothing per task.
- **Where the keys come from**: agent-vault holds `ANTHROPIC`, `GITHUB`, `GITHUB_BASIC`, `GITHUB_ZS` and `GITHUB_ZS_BASIC` (and `GITHUB_BASIC_MANAGER` for the backup, and `GITLAB` and `GITLAB_BASIC` for a rig on GitLab, and any rig key such as `OPENAI`, and `CODEX_CHATGPT` and `CODEX_CHATGPT_ACCOUNT` for codex in ChatGPT mode) in the vault `FACTORY_AX_VAULT` names, as references to wherever they live (a password manager, a GitHub App that mints installation tokens). The cluster holds no copy of a key. `GITLAB` is a GitLab access token with the `api` scope (what `glab` sends); `GITLAB_BASIC` is base64 of `<user>:<the same token>` (what git sends as Basic auth; the token needs `write_repository`).
- **Devenv cache and GitLab**: `factory devenv` fetches the repo with a `github.com` header and `gh auth token`, so a private GitLab rig's devenv build cannot fetch it. Such a rig has no cached devenv, and its workers use `nix shell` as they would without one.

### A known outage: the egress gateway and `api.anthropic.com`

Seen 2026-10-13 02:11Z and twice on 2026-10-14 (14:21Z, 14:35Z); a 2026-10-14 15:13-15:21Z recheck found it intermittent (145 503s against 203 200s to the same destination IP and byte-identical cert within one hour).

- **Signature**: Envoy marks the connection `UF`, the `egress_forward_proxy` cluster's `ssl.fail_verify_san` counter equals its `cx_connect_fail` count, and every new connection to `api.anthropic.com` gets a 503 body containing `upstream connect error or disconnect/reset before headers`. The cert itself is fine (CN and SAN both `api.anthropic.com`), the node reaches the host, and GitHub through the same gateway keeps working.
- **Trigger**: while agent-vault cannot serve the `ANTHROPIC` credential, `ate-system/atenet-egress` denies with a stale credential; once agent-vault serves it again, new connections to `api.anthropic.com` keep failing this way.
- **Owner**: Substrate, not this repo. The gateway is `ate-system/atenet-egress`, a Deployment this repo's code never touches (`src/ax.ts`'s `kubectl` calls only read the gateway's `ClusterTrustBundle` and apply this task's own `egress-policy` CRD). The suspected root cause is Envoy's `auto_san_validation` on the dynamic forward proxy. Tracked upstream as `claude-factory-ue9`, for a person to report to Substrate; not fixed in this repo.
- **Workaround, partial**: `kubectl -n ate-system rollout restart deploy/atenet-egress`. As of the 2026-10-14 15:13-15:21Z recheck this no longer reliably clears the failure (it can still leave the mix of 503s and 200s above), so treat it as worth trying, not a guaranteed fix.
- **What the runner does about it** (so one outage does not cost a station its attempt): `egressFailure()` in `src/worker.ts` recognizes only this exact Envoy text in a finished turn's output — never a generic 5xx, rate-limit, or 529 overloaded refusal, which Claude already retries itself, so matching those here would mask a real API failure instead of the gateway's. When a turn ends on it, `serveTurns` (`src/worker.ts`) retries in place: the same session once there is one, with `EGRESS_RETRY_PROMPT` ("The last turn failed on the egress gateway refusing a new connection to the model API (see above). Try again."), or the brief again with no session yet. A prompt file queued for the turn is deleted only after the turn, so a retry never loses or reorders it. Backoff doubles from `FACTORY_EGRESS_WAIT_MS` (default 30 s), capped at 10× that (5 min at the default), for up to `FACTORY_EGRESS_BUDGET_MS` (default 30 min); each retry appends one `serve.log` line ("egress failure, retry N: ..."). A turn that gets through clears the outage. While it is ongoing, `state.json`'s `egress: {since, tries, last}` rides `worker.poll()` → `ax.Poll` → `WorkerInfo` back to the laptop. `reconcile` (`src/cli.ts`) checks the VM's record with `trustedEgress`. A bad `since`, `tries` or `last` drops the record. Control characters in `last` become spaces. `last` is cut to 200 characters. `reconcile` mails the manager once per outage. It mails again only if `since` is higher and 30 min of laptop time have passed since the last mail. The file `<run>/egress-paged-<node>.json` holds `{since, at}`. It is keyed per run and node since the gateway is shared and a single outage hits every concurrent AX worker at once) and spends no idle nudge while serve is still retrying. As soon as the worker goes `idle` or `done` with the outage still set — meaning serve already spent its own retry budget and gave up, not once this station's own nudges are spent — `reconcile` fails that tick, named, instead of the generic "worker stopped without reporting": `egress gateway: model API unreachable since <ISO> (<n> retries): <last>`. That fail carries `hold`. The machine then parks the station in `waiting` and spends no attempt. The journal outcome is `outage`. The wait is 15, 30, 60, then 120 min (`OUTAGE_HOLD_MIN` and `OUTAGE_HOLDS` in `src/machine.ts`). The manager gets one "held, not failed" mail for each streak. A fifth outage in a row fails like any other fault. `reconcile` also holds "worker stopped without reporting" in two cases: a usage-limit refusal came after the attempt started, or the runner's limit page is active. The wake time is then not before the reset. Only `reconcile` sets `hold`. A worker's own `report fail` always spends an attempt.
- **Env knobs**: `FACTORY_EGRESS_WAIT_MS` (base backoff, ms; default 30000) and `FACTORY_EGRESS_BUDGET_MS` (total retry budget, ms; default 1800000 = 30 min). Setting the budget to `0` turns retrying off without a code change. Both are read only by the VM half (`src/worker.ts`), so set them through `FACTORY_AX_ENV`.

### Manager image

The manager runs as a long-lived AX task. It needs more tools than a worker. `Dockerfile.worker` has a second target, `manager`. This target builds on the worker image, so the two images share their layers. The `manager` target adds these items:

- `dolt` from the pinned nixpkgs (`NIXPKGS_REV`). `bd` uses `dolt` in server mode.
- `herdr`, the upstream release binary at `HERDR_VERSION` (default `0.9.3`), checked against `HERDR_SHA256`. `herdr --remote` on the laptop needs a compatible herdr in the task. Keep `HERDR_VERSION` the same as the laptop's `herdr --version`.
- The Nix `sshd` (`/nix/var/nix/profiles/default/bin/sshd`) is already in the worker image. The attach uses it (see Attach to the AX manager).
- The runner `ax-task-runner` (both targets). To build it against an env fork with a guest fix, set the build arg `ENV_REPLACE` to a `module@version`. That module replaces `github.com/agent-substrate/env`. Example: an env fork with `live_output`, so `ax stdio` streams have no 10 MiB stdout cap.
- The `ax` CLI, built from `./cmd/ax`. By default it builds from `google/ax` at `v0.3.1`. To use a fork with the `AX_ROUTER` patch, set `AX_CLI_REPO` and `AX_CLI_COMMIT` in the environment of `factory image build --target manager`.
- The mod, in `/opt/factory/mod`. The manager's Claude loads it as a plugin dir.
- `FACTORY_IN_AX=1` in the image env.

The manager task env, not the image, sets `AX_ROUTER` and `AX_SERVER`. They hold the in-cluster `atenet-router` and `ax-server` service addresses. When `AX_ROUTER` is set, a fork with the `AX_ROUTER` patch makes `ax ssh` dial the router directly. It does not dial the worker IP or open a port-forward. The VM needs an egress `http` rule to the router.

`ax-task-runner` stays PID 1. A build with no `--target` makes the worker image, as before. To build and push the manager image, first set `image.registry` and `image.builder` (see Turning it on, below):

```sh
factory image build --target manager    # prints image@digest, stores ax.manager-image
```

The command tags the image `<image.registry>/factory-manager:<sha>`. If `FACTORY_AX_MANAGER_IMAGE` is set in the environment, the command warns that it overrides the stored value.

### Turning it on

```sh
# build and push the worker image (an amd64 buildx builder; needs push access to the registry)
factory settings set image.registry <registry>/<org>
factory settings set image.builder <builder>
factory image build    # prints image@digest, stores ax.image
```

`factory image build` stored `ax.image`. You can store `ax.context`, `ax.vault` and `ax.env` (an absolute path) the same way with `factory settings set`, in place of the `FACTORY_AX_CONTEXT`, `FACTORY_AX_VAULT` and `FACTORY_AX_ENV` exports. An exported value wins.

```sh
# on the laptop running the factory loop
export FACTORY_AX_CONTEXT=<cluster>                               # kube context for ax and kubectl (kubectl-ate on PATH)
export FACTORY_AX_VAULT=factory                              # agent-vault vault with ANTHROPIC, GITHUB, GITHUB_BASIC, GITHUB_ZS, GITHUB_ZS_BASIC (GITHUB_BASIC_MANAGER for the backup; GITLAB, GITLAB_BASIC for a GitLab rig)
export FACTORY_AX_REVIEWER_OWNER=<github-owner>              # optional: review, security and check tasks of that owner's rigs approve as the reviewer App (vault keys GITHUB_REVIEWER and GITHUB_REVIEWER_BASIC)
export FACTORY_AX_ENV=~/.config/factory/ax-env.json          # optional: more env for the task, never a real key
export FACTORY_AX_TOKEN_SWAP="bin/factory token best"         # optional: swaps the vault's token on a usage limit (reads the token.* settings)
export FACTORY_AX_CODEX_TOKEN_SWAP="bin/codex-token refresh"  # for codex: a refresh check every 12 h, and a copy after a refused login (or "best")
export FACTORY_AX_PKG_GATE=http://pkg-gate.pkg-gate.svc.cluster.local:8080  # optional: see Package age gate, above
export FACTORY_AX_WORKER_SERVER=https://factory.factory.svc.cluster.local:8443  # optional: see Factory server rule, above
factory rig add web ~/repos/web --runner ax                   # rigs.json: "runner": "ax"
# a codex rig logs in with ChatGPT (vault keys CODEX_CHATGPT and CODEX_CHATGPT_ACCOUNT, filled by bin/codex-token); to use an API key instead: --agent "codex" --egress api.openai.com=OPENAI
```

Only that rig's new workers become AX tasks, and only at stations without a `runner` of their own: a station with `runner: herdr` (lifecycle's baseline, incident and rollback, and ship's deploy, soak and rollback, which read or change production) keeps its workers in panes, where the laptop's kubectl and network are. A worker already running in a pane stays there, and `--runner herdr` switches the rig back. `FACTORY_AX` points at a different `ax` binary.

### Shared AX controller availability

Before a new AX launch or explicit `factory retry`, the laptop reads `ax-system/ax-controller` with `kubectl` in `FACTORY_AX_CONTEXT`. It must have ready and available replicas at its current observed generation. An unavailable controller, unreadable status, or failed observation holds the launch and refuses the retry before it resets the attempt budget. The query has a five-second request timeout and a six-second process timeout. The laptop identity needs permission to read this Deployment.

Existing pending workers are retained while that check fails; their station deadlines do not produce another failed attempt during the outage. The manager receives the reason once per run and reason. Running-worker collection and cleanup continue. When readiness returns, normal station deadlines and retry policy apply; this does not extend an attempt's deadline.

### Run the manager in AX

`factory manager --ax [manager args...]` starts the manager as the AX task `f-manager` (`FACTORY_AX_MANAGER` sets another name). Run it on the laptop. It applies one Workspace and one Task, then creates the task's egress policy.

- Set `FACTORY_AX_MANAGER_IMAGE` to the manager image (`Dockerfile.worker`, target `manager`), or store it with `factory image build --target manager` (setting `ax.manager-image`). The command stops with an error if it is not set.
- The command stops if the task already runs. The task is the one-manager lease (see Attach to the AX manager).
- The command stops if the Workspace `f-manager` exists, and names the `ax ... delete workspace f-manager` command. An old Workspace keeps an old home and its `.migrated`. To keep the Workspace (a suspend and resume), add `--reuse-workspace`. Do not delete the task to change its image: `ax delete task` also deletes the data in `/workspace/w`, even when the Workspace object stays. Only a suspend and resume keeps the home. To change the image, first make sure that the home backup is current (`factory status` shows `home backup: N min ago`). Then delete the task and the Workspace, and start again: the host restores the home from the backup.
- The command puts a new launch id in the task env as `FACTORY_AX_LAUNCH_ID`. With `--reuse-workspace`, the task has no launch id.
- The task has `spec.debug: true`, so `factory attach` and `factory say` can reach it.
- The task runs `factory manager host <manager args>`. The task env has `FACTORY_IN_AX=1`, `FACTORY_HOME=/workspace/w/home` and `CLAUDE_CONFIG_DIR=/workspace/w/claude`. Both directories are on the workspace volume, which stays across a suspend.
- The task env also holds the vault placeholders and `FACTORY_CA`, as a worker gets them. The task holds no secret. The laptop passes `FACTORY_MAX_RUNS`, `FACTORY_AX_IMAGE`, `FACTORY_AX_VAULT`, `FACTORY_AX_ATESPACE`, `FACTORY_AX_PKG_GATE`, `FACTORY_AX_CAPABILITIES` (also when it is empty), `FACTORY_AX_CODEX`, `FACTORY_AX_CURSOR`, `FACTORY_AX_GROK` and `GRPC_ENFORCE_ALPN_ENABLED` to the task when they are set. The task env always has `FACTORY_AX_MANAGER`, the task's own name, so the AX sweep in the task skips its own task. If the laptop has `CURSOR_API_KEY` (the Cursor pool meter), the task gets `CURSOR_API_KEY=placeholder` (only with `FACTORY_AX_VAULT`), and the manager policy gets `api2.cursor.sh` with the vault key `CURSOR_API_KEY` on `/auth/` only. The real key does not go to the task. It sends the content of `FACTORY_AX_ENV` (a JSON file on the laptop), because the task has no laptop paths. In the task, `FACTORY_AX_ENV` can be the JSON itself.
- `FACTORY_AX_MANAGER_SSH_PUBKEY` names a public key file on the laptop (for example `~/.ssh/id_ed25519.pub`). The laptop sends its lines as `FACTORY_SSH_AUTHORIZED_KEYS`. The command stops with an error if a line is not an OpenSSH public key. The error does not show the text. Do not give it a private key.
- The egress policy has the worker defaults (Anthropic, GitHub, the Nix caches), `claude.ai`, and the host of `AX_SERVER` when it is set. The command tries to create the policy for 2 minutes, because the actor appears a short time after the apply. If the policy exists (from an old task of the same name), the command updates it in place with `kubectl ate update egress-policy`. The update body has the stored `metadata` (`uid` and `version`) from `get -o json`. The policy broker does the same for a worker policy.

`factory manager host` runs inside the task. It stops unless `FACTORY_IN_AX=1`. It does these steps:

1. As root, it adds the worker user to the `tty` group. Then it becomes the worker user, installs the gateway CA, and makes `FACTORY_HOME`.
2. It writes the attach files in `/workspace/w/ssh` (see Attach to the AX manager). It does this before it waits for a home, so you can attach to a task that waits for `factory migrate-to-ax`.
3. Before it types the manager command into the pane (step 5), it seeds `$CLAUDE_CONFIG_DIR/.claude.json` (onboarding done, theme, project trust for `/workspace/w` and `/workspace/w/home`) and `settings.json` (`skipDangerousModePermissionPrompt`). A new config dir otherwise stops at the onboarding check, which the egress gateway blocks, and at the Bypass Permissions dialog.
4. It starts herdr with no terminal attached. herdr needs a terminal, so `script` gives it one of 200 columns and 50 rows.
5. It waits up to 60 seconds for `herdr pane list` to answer. Then it types `factory manager <args>` into the first pane (`w1:p1`).
6. Every 30 seconds it checks herdr. If herdr is gone, it starts herdr and the manager again. It adds `--resume <session>` when `manager-sessions.json` in `FACTORY_HOME` names a session.

Each restart is one line in `FACTORY_HOME/manager-host.log`.

Limits:

- The check runs every 30 seconds with no backoff. A herdr that dies again and again restarts every 30 seconds.
- If the manager exits but herdr stays up, the host does nothing. `factory manager` restarts its own Claude.
- The pane is always 200 columns wide.

### Attach to the AX manager

The manager runs in the AX task `f-manager` (`FACTORY_AX_MANAGER` sets another name). That task is the lease. While it is Running, Pending or Suspended, `factory manager`, `factory tick` and `factory loop` on the laptop stop and print how to attach. Inside the task, `FACTORY_IN_AX=1` turns the check off. The check runs only when `FACTORY_AX_CONTEXT` is set. If AX does not answer, the laptop prints a warning and runs. A laptop with no cluster must keep working.

- `factory attach` prints the manager pane once. `factory attach --follow` prints it again every 3 seconds. Press Ctrl-C to stop. The manager keeps running.
- `factory say '<text...>'` types the text and Enter into the manager pane. The text travels as base64, because `ax` reads `-a`, `-n`, `--server` and `--context` anywhere on its command line. A worker cannot run it: the CLI refuses it and the worker hook denies it.
- `FACTORY_AX_MANAGER_PANE` sets the pane id (default `w1:p1`, the first pane of a fresh herdr session). Use the id that `herdr pane list` shows in the task. The board is the `/factory` console in the same pane. It shows in the manager pane when the manager has `/factory` open.

`ax ssh` has no stdin and no PTY. So `factory attach` shows a snapshot and does not give you a keyboard. For a keyboard, use `herdr --remote` over ssh.

#### Attach with `herdr --remote`

The laptop's ssh starts `sshd -i` in the task through `ax stdio` (claude-factory-d289.1). `ax stdio TASK -- CMD` sends local stdin to the command in the task. It needs an ax CLI with `ax stdio` (the AX fork). Upstream `ax` v0.3.1 does not have it.

In the task, `factory manager host` writes these files in `/workspace/w/ssh`, as the worker user:

- `host_ed25519`: the host key. The host makes it on the first start. The volume keeps it, so the key stays the same across a restart.
- `authorized_keys`: the lines of `FACTORY_SSH_AUTHORIZED_KEYS`, on each start. Without that env, the file is empty and nobody can attach. `manager-host.log` then says `attach: off`.
- `sshd_config`: `HostKey`, `AuthorizedKeysFile`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`, `StrictModes no`, `UsePAM no`, `PidFile none`, and `SetEnv` with each one-line value of the host env (`PATH` included, so the session finds `herdr` and `factory`).

sshd runs as the worker user. A non-root sshd does no privilege separation and no chroot. Root in the task has no `SYS_CHROOT`, so a root sshd fails. The worker must be in the `tty` group, or sshd cannot chown the pty and the session gets no terminal.

On the laptop:

1. Set `FACTORY_AX_MANAGER_SSH_PUBKEY` before `factory manager --ax`.
2. Run `factory attach --ssh-config >> ~/.ssh/config`. It prints the Host block for the manager task (`FACTORY_AX_MANAGER`, default `f-manager`). It uses `FACTORY_AX`, `FACTORY_AX_CONTEXT` and `FACTORY_AX_ATESPACE`:

   ```
   Host f-manager
     User worker
     ProxyCommand ax --context <ctx> -a factory stdio f-manager -- setpriv --reuid=worker --regid=worker --init-groups /nix/var/nix/profiles/default/bin/sshd -i -f /workspace/w/ssh/sshd_config
   ```

3. Run `herdr --remote f-manager`. The first ssh asks you to accept the host key.

Limits (see claude-factory-d289.1 and claude-factory-d289.3):

- An image built without `ENV_REPLACE` has the guest cap of 10 MiB stdout for each process. Then one ssh connection dies after 10 MiB from the task to the laptop. Build the manager image with `ENV_REPLACE` set to an env fork with `live_output` (claude-factory-d289.3).
- The guest allows 10 processes at a time. Each ssh connection is one process.
- Do not set `HERDR_REMOTE_BINARY`. Its upload echoes the binary back, and without `ENV_REPLACE` it hits the 10 MiB cap. The image has herdr on `PATH`.

#### Attach with the Herdr app (herdr core)

The manager and worker images have herdr core (`hc`, `HC_VERSION` in `Dockerfile.worker`). The Herdr app on the laptop reaches a task through `hc machine add`. That command runs `hc connect` in the task over ssh, or over any command given with `--via`. The laptop `hc` must not be newer than the image's `hc`. Keep them at the same version.

- The manager: with the `Host f-manager` block from step 2 above, run `hc machine add f-manager`.
- A worker task has no sshd. Use `ax stdio` as the transport. hc gives the shell line to run as the last argument, so end the command with `sh -c`:

  ```bash
  hc machine add --temp --name <task> --via "ax --context <ctx> -a factory stdio <task> -- setpriv --reuid=worker --regid=worker --init-groups sh -c"
  ```

  The `ax` process needs the same AX env as the ProxyCommand in step 2. `--temp` marks the machine as short-lived. Remove it with `hc machine rm <task>` when the task ends.

The same limits as for `herdr --remote` apply: each connection is one guest process, and an image without `ENV_REPLACE` has the 10 MiB stdout cap.

### The AX sweep

A failed `ax delete`, or a run that ends with its worker up, can leave a task or a workspace on the cluster. The `factory beads` pass removes them. It runs at most every 10 minutes, only when a rig has `runner: 'ax'`, and not after `factory stop`.

The pass lists `ax get tasks` and `ax get workspaces`. If one list fails, it deletes nothing and shows a row from `ax-sweep.json` on the board. It deletes a name only when all of these are true:

- The name is not the manager task (`f-manager`).
- The name is `f-<run>-<seq>` for exactly one run of this home. A name that this home does not own stays.
- `<seq>` is not above the run's `seq` in `state.json`. A higher number is a launch that the state does not show yet.
- The run is done or aborted, or `<seq>` is below the run's `seq` and the run's worker is not `ax://<name>`.

One pass deletes 10 names at most. `ax.log` in the factory home gets one `ax-sweep:` summary line for each pass, a `swept` line for each name, and a `remove ... failed` line for each failed delete. The close path writes the same failed line. `factory stop` halts the pass.

### Move the factory to AX

This section moves a running laptop factory to the manager task. The task needs the rig repos, the beads stores and the factory home. Use this runbook.

#### Repos and beads in the task

`rigs.json` holds the laptop's repo paths. In the task, `FACTORY_IN_AX=1` maps each rig's repo to `${FACTORY_REPOS:-/workspace/w/repos}/<rig name>`. The laptop is not changed. Runs that the laptop made have laptop paths in `run.json`. The task maps those paths to the same clones.

A rig can have a `remote` field: its https clone URL. `factory repos sync` clones every rig's `remote` that is missing, and fetches the others. It changes `git@` and `ssh://` GitHub URLs to https. The gateway puts the GitHub credential in. A rig with no `remote` and no clone is an error, and the command names the rig. `factory manager host` runs `factory repos sync` before it starts the manager. A failure goes into `manager-host.log` and does not stop the manager.

`factory repos sync` also makes the beads store of each rig that has a `.beads`. It uses the same steps as the worker (see Beads in the VM). The store is in `FACTORY_HOME/beads/<rig name>`. bd uses it through `BEADS_DIR`, with `BEADS_DOLT_SHARED_SERVER=0`. The store comes from the rig's `beadsRemote`, or from the `refs/dolt` of the GitHub origin. A rig with no `beadsRemote` needs `refs/dolt/data` on its origin. If the origin has none, set `beadsRemote` for the rig. The laptop-side `bd dolt push` and `bd dolt pull` in the task use that store.

To check every rig in the task, run `hack/ax-repos-check.sh`. It checks the clone and the beads store of each rig. With `AX_CHECK_START=1` it also runs `factory start` on each rig. That makes a real run on each rig, so run it only with the person's OK.

Limits:

- With a `beadsRemote`, the task runs plain `bd dolt push` and `bd dolt pull`. The laptop uses SQL on its Dolt server, and the task has no Dolt server. The laptop's rule for a pull conflict (keep the worker's row, and comment the other on the issue) does not run in the task. A conflict stops the pull with bd's own error.
- A store is made once. Later syncs pull; they do not make it again.
- A run that the laptop made keeps the laptop's worktree path. The task has no such worktree. A worker on AX does not need it.

#### Staging copy

To test a cutover with no pause of the laptop factory, use a staging task:

1. Set `FACTORY_AX_MANAGER=f-manager-stage` and `FACTORY_AX_MANAGER_DRY=1`. Set `FACTORY_AX_BACKUP_BRANCH` to a branch that does not exist, so no restore runs.
2. Run `factory manager --ax`, then `factory migrate-to-ax`. The migrate copies the home. It does not change the laptop.
3. With `FACTORY_AX_MANAGER_DRY=1`, the host runs `factory repos sync` and then stops. It starts no herdr, no manager, no tick and no backup. So the copy starts no worker and pushes nothing.
4. `factory repos sync` also makes the missing worktree of each live run, from its branch on origin. `manager-host.log` names each worktree that it could not make.
5. Delete the task, its Workspace and its egress policy after the checks.

#### Preflight

Do these checks before step 3. `<ctx>` is `FACTORY_AX_CONTEXT`, and the atespace is `factory` (`FACTORY_AX_ATESPACE`).

1. The Workspace `f-manager` must not exist. `ax --context <ctx> -a factory get workspace f-manager` must say not found. If it exists, delete it with `ax --context <ctx> -a factory delete workspace f-manager`. `factory manager --ax` also refuses it.
2. The Task `f-manager` must not exist. `ax --context <ctx> -a factory get task f-manager` must say not found.
3. Look for an old EgressPolicy: `kubectl ate --context <ctx> get egress-policy f-manager -a factory -o json`. An old policy does not stop the launch: `factory manager --ax` updates it in place.
4. The policy broker must be of the same build as the manager image. `GET /controller` on the broker must answer 200 with the controller readiness. An older broker answers 404. Then each worker launch in the task fails with `AX executor unavailable: controller readiness could not be observed (broker GET /controller answered 404: ...)`, and no worker task starts. To update the broker, run `kubectl set image deploy/factory-policy-broker -n factory-broker broker=<image@digest>`.
5. The dry run (step 2) must show no line `live runs whose branch is not pushed`. In the task, a tick makes each live run's worktree again, from the run branch on origin, in `FACTORY_HOME/worktrees/<run id>`. A commit that is only in a laptop worktree does not move. Push each named branch, then run the dry run again.
6. After step 3, the task env must have `FACTORY_AX_LAUNCH_ID` (`ax --context <ctx> -a factory get task f-manager`). `factory migrate-to-ax` reads it there and writes `launch=<id>` into `.migrated`.

The host starts the manager only on a `.migrated` with its own launch id. A backup restore writes the same id. With a launch id, a home with `rigs.json` and no good marker does not start the manager. In that case the host logs `.migrated is not of launch <id>` in `manager-host.log`. With no launch id (`--reuse-workspace`), the host trusts any `.migrated`, as before.

#### Steps

1. Stop the laptop manager. Stop `factory loop` and `factory tick` too.
2. Run `factory migrate-to-ax --dry-run`. It prints what moves, the size, and what stays. It writes nothing and sends nothing. If it stops with a list of runs, those runs have a worker in a herdr pane on the laptop. A pane cannot move. Finish or abort those runs, or let them reach a station boundary (a gate or a wait). Then run the dry run again.
3. Run `factory manager --ax`. The task starts. Its host sees an empty home and waits for the migration. It does not start the manager yet. For a new factory with no migration, set `FACTORY_AX_FRESH=1` on the laptop before this step.
4. Run `factory migrate-to-ax`. It packs a tar.gz and computes its sha256. Then it sends the archive to the task and unpacks it into `FACTORY_HOME` as the worker user. The unpack writes `FACTORY_HOME/.migrated` last, with the task's launch id. The host sees the marker, runs `factory repos sync`, and starts the manager.
   - If the ax CLI has `ax stdio` (the AX fork; its `--help` lists it), the archive goes in one stream on stdin. In the task, a shell script writes it to `.factory-worker/migrate.tgz.tmp`, compares its sha256 with the laptop's, and only then moves it to `migrate.tgz`. A mismatch removes the file and stops the migrate.
   - If the ax CLI has no `ax stdio`, the archive goes as base64 parts of 96 KB with `put`, one `ax ssh` call each. Then `sha256sum` in the task must give the laptop's hash. This is slow: about 14,000 calls for 1 GB.
5. Run `factory attach`. The board shows the same runs as the laptop did.

#### What moves

- `rigs.json`, with a `remote` added to each rig (the https form of `git remote get-url origin` in its repo). `repo` stays as written.
- `decisions.json`, `dispatch.json`, `metrics.jsonl`, `manager-sessions.json`, `memory/`, `launch/`, and the small top-level files.
- The directories of all live runs. For finished runs (done or aborted), only the newest 50 move. `--keep N` changes the number. Their records in `metrics.jsonl` are already written.
- In each run directory that moves, only the newest `*.memory.tgz` moves (highest attempt number). The laptop writes one at each AX worker launch and deletes it after the put, so the older ones are not used. The dry run gives their count and size.

These stay on the laptop: `tick.lock`, `bin`, `devenv/`, the backups of `rigs.json`, and any other top-level file over 5 MB. The dry run names them.

#### Back up the manager home

AX keeps the workspace of a task only across suspend and resume. A new task, for example after an image update, starts with an empty `/workspace/w`. The host can back up `FACTORY_HOME` and the manager's Claude memory and sessions to a private git branch. It restores them in a new task.

Owner steps (the factory does not do them):

1. Make a private GitHub repository. The backup holds run journals and transcripts. Keep the repository private.
   Do not install the GitHub App on it. Every worker task has the App token (`GITHUB_BASIC`). A worker can then push to the backup, and the next restore writes its files.
   Put a fine-grained token in the vault key `GITHUB_BASIC_MANAGER`. The value must be base64 of `x-access-token:<token>`, the same as `GITHUB_BASIC`. A raw token makes every `github.com` git call of the manager fail.
   The token needs read and write on the backup repository and on the rig repositories the manager syncs. A fine-grained token covers one resource owner only. If the owners differ, put the backup repository under the owner of the rig repositories, or use a classic token with the `repo` scope.
   The App must not cover the backup repository. An installation for "All repositories" covers a new repository at once. Then every worker of that account can force-push the backup branch.
   Do one of these:
   - Set the installation of that account to "Only select repositories". Leave the backup repository out.
   - Put the backup repository under an account that has no installation. Use a classic token with the `repo` scope.

   Then do this check. In a worker task, run `git ls-remote <backup url>`. It must get 401 or 403. If it lists refs, the App covers the repository. Do not continue.
   When `FACTORY_AX_BACKUP_REMOTE` is set, `factory manager --ax` gives the manager task that key for `github.com`. Worker tasks keep `GITHUB_BASIC`.
2. On the laptop, set `FACTORY_AX_BACKUP_REMOTE` to its https URL. Do not put a key in the URL. Optional: `FACTORY_AX_BACKUP_BRANCH` (default `manager-home`) and `FACTORY_AX_BACKUP_EVERY` in ms (default 600000).
3. Run `factory manager --ax`. The task gets the variables.

How it works:

- The host pushes a snapshot every `FACTORY_AX_BACKUP_EVERY` ms. It commits only when a file changed. The push is fast-forward only. The host never forces a push.
- Ticks run back to back and hold `tick.lock`. So when a backup is due, the host writes `FACTORY_HOME/backup.want`. A tick does not start while that file is younger than 10 min. The host tries the lock each second, for up to 10 min. When it takes the lock, it removes `backup.want`.
- Under `tick.lock`, the host only snapshots the memory and adds the files to the backup index. It frees the lock before the scan, the gzip, the commit and the push.
- If GitHub refused a push (for example GH001), the next push does not send the refused commit again. If the remote tip is absent or an ancestor of the local branch, the host pushes one commit of the current tree on that tip.
- The snapshot holds `home/` and the Claude memory and session files of the sessions in `manager-sessions.json`. It leaves out `.claude.json`, `.credentials.json`, `claude/**/settings*.json`, `rigs.json.*`, `*.lock`, `bin/`, `devenv/`, `herdr.log`, `manager-host.log` and `worktrees/`.
- gitleaks scans the staged files (all its rules, `generic-api-key` too). The push has `[REDACTED]` in place of each secret that it finds. The backup finds the secret by its text, not by the gitleaks line and column. The file in the home does not change.
  - `manager-host.log` gets `backup redacted <rule id> <path>` for each file. The log never holds the value.
  - If gitleaks is not on `PATH`, or a secret is left after the redaction, the backup stops. Nothing stays staged.
- GitHub refuses a file over 100 MB. So the push has each file over 50 MB as gzip, at `<path>.gz`. `home/.backup-gz.json` names these paths, and a restore unzips them back to `<path>`.
- The host does not back up while the home is not ready. An empty home never replaces a good backup.
- When the host starts with an empty home (no `rigs.json`, `runs/` or `.migrated`), it fetches the branch and writes `.migrated`. The manager then starts and resumes the last session. A used home is never changed. If the fetch fails (network or auth), the host tries again each cycle and does not start the manager. This holds with `FACTORY_AX_FRESH=1` too. If there is no remote or no branch, the host waits for `factory migrate-to-ax` as before.
- `home/memory` goes in as plain files, with or without a `.git` inside. The memory `.gitignore` applies, and uncommitted notes are saved. The git history of memory is not saved, so only files that the scan reads leave the VM. The snapshot writes `home/memory-dream.at`, the time of the last `dream:` commit. Restore runs `git init` in `home/memory` and makes one commit that has this date, so the next dream reads the journal from the last real dream.
- The scan reads the staged files (the blobs), not the work tree. It also checks URL user info, JWT, `sk-proj-`, `lin_api_`, `glpat-`, `AIza`, `ops_`, `npm_`, `xapp-` and `PRIVATE-TOKEN:`.
- If `home/.git` exists (the config sync repo), the backup refuses with an error. Git would save it as one empty link.
- A restore refuses a branch that holds a path the backup leaves out (for example `claude/settings.json` or `home/bin/`). It writes no file and returns an error.
- A restore writes `home/.restoring` before the checkout and removes it at the end. While the file exists, the host counts the home as not ready, restore runs again, and no backup runs. If the remote is unset while the file exists, a person must remove the file.
- Look at `home/backup.json` (`at`, `sha`, `error`), `manager-host.log` and `factory status` in the task (the backup age and the last error).

To test (owner only, it changes the live system): run `ax delete task f-manager`. Then run `factory manager --ax` with the new image. The manager must come back with the same runs, memory and session, with no migration from the laptop.

To turn it off, unset `FACTORY_AX_BACKUP_REMOTE` and run `factory manager --ax` again.

#### Safety

- The command refuses to send into a home that holds a factory (`rigs.json`, `runs/` or `.migrated`). `--force` overrides this. Use it only when no manager runs in the task.
- The host does not start the manager while the home is empty, or while a migration archive is on the volume.
- Runs on `ax://` workers move with no change. Their workers keep running while the move happens.
- The upload is `PUT_PART` bytes of base64 for each `ax ssh` call, because `ax ssh` has no stdin. A home of 100 MB sends in about 1500 calls. A part that fails is sent again 3 times. Then the command stops. Run it again, because a part sent twice does no harm.

### Policy broker

The manager runs in an AX VM. The VM cannot reach ate-api: the gateway fails the TLS call to it with grpc-status 14. So the manager cannot create a worker egress policy or read the gateway CA with `kubectl ate`. The policy broker does these two jobs for it.

The broker is a small HTTP server in the cluster (`factory broker serve [--port 8080]`, image from `Dockerfile.broker`, manifest `deploy/broker.yaml`). It runs `kubectl ate` with a projected ServiceAccount token (audience `api.ate-system.svc`). ate-api checks the token and its audience. It applies no other authorization, so the broker enforces the limits itself.

| Call                                  | Result                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PUT /policy/<atespace>/<actor>`      | Body is an EgressPolicy as JSON. The broker updates the stored policy in place, or creates it. |
| `DELETE /policy/<atespace>/<actor>`   | Deletes the policy. A policy that is gone already is not an error.                                  |
| `GET /ca`                             | The PEM of the gateway CA bundle.                                                                   |
| `GET /healthz`                        | `ok`.                                                                                               |

Limits:

- Only the atespaces in `FACTORY_BROKER_ATESPACES` (default `factory`).
- Never the policy of the manager actor (`FACTORY_AX_MANAGER`, default `f-manager`). You create that policy from the laptop.
- Atespace and actor must be RFC 1123 labels. The body must be a JSON object with `rules`, 64 KiB at most.
- The broker answers 400 and runs no command for a worker policy in these cases:
  - It names the vault key `AX_AUTH` or `GITHUB_BASIC_MANAGER`.
  - A `credentialUri` is not `ate-secret://agent-vault/<vault>/<KEY>`.
  - A rule has `pathPrefixes` or `paths` on a hostname pattern that can match a `github.com` host. Examples: `github.com`, `*.github.com`, `*.com`, `*`. The broker accepts one such rule: the reviewer rule. Its keys are exactly these:
    - `hostnames`: only `api.github.com` and `uploads.github.com`.
    - `pathPrefixes`: one `/repos/<owner>/<repo>/`.
    - `paths`: `["/graphql"]`.
    - `effects`: one `Authorization` `Bearer ` header from `GITHUB_REVIEWER`.
  - It names `GITHUB_REVIEWER` or `GITHUB_REVIEWER_BASIC` (in any case or spelling) outside two whole rules in `rules[i]`.
    - One rule is the reviewer rule above.
    - The other rule is a `github.com` rule. It has one `Authorization` `Basic ` header from `GITHUB_REVIEWER_BASIC` and no other key.
    - The policy can have each rule once. The `github.com` rule needs the reviewer rule.
    - The broker binds no station or `<owner>/<repo>` to the actor. See claude-factory-mzoy and claude-factory-rfjn.
  - The policy has the reviewer rule. Another object lists a github host in `hostnames` (`github.com`, `*.github.com`, `*.com`, `*`). That object has a key other than `hostnames` and `ports`. Hostnames that are not a list of strings in such an object also fail.
  - The policy has the reviewer rule. Another rule has a `credentialUri` whose vault key starts with `GITHUB`, on any host. So one policy cannot hold the reviewer key and a `GITHUB` author key. Limit 1: a GitHub token under a vault key name that does not start with `GITHUB` passes. Limit 2: the broker keeps no state, and a later PUT replaces the policy of the same actor. A compromised manager can thus give one task the two keys, one after the other (claude-factory-mzoy).
  - A key has a non-ASCII character.
  - The policy nests deeper than 32 levels.
  - A vault key goes to a host that the key is not pinned to. `keyHostRefusal` in `src/broker.ts` makes this check, after `workerPolicyRefusal`. The gateway adds the real key to each request to the named host, so a key on a relay host would leave the cluster in plain text. A key can be only in `rules[i].https.effects.replaceHeaders[j].credentialUri`. The rule has a closed shape: `rules[i]` has only `https`, `https` has only `hostnames`, `ports`, `pathPrefixes`, `paths` and `effects`, `effects` has only `replaceHeaders`, and each entry has only `header`, `prefix` and `credentialUri`. Every hostname of the rule must be a host of the key (exact text: no case fold, no trailing dot, no wildcard). A `credentialUri` or `effects` field anywhere else fails. A key with no pinned host fails. The pins are:

    | Key                                         | Hosts                                                  |
    | ------------------------------------------- | ------------------------------------------------------ |
    | Any key that starts with `GITHUB`           | `api.github.com`, `uploads.github.com`, `github.com`   |
    | `ANTHROPIC`                                 | `api.anthropic.com`                                    |
    | `XAI_API_KEY`                               | `api.x.ai`                                             |
    | `CURSOR_API_KEY`                            | `api2.cursor.sh`                                       |
    | `CODEX_CHATGPT`, `CODEX_CHATGPT_ACCOUNT`    | `chatgpt.com`                                          |
    | Any other key (`GITLAB`, `DOLT_BASIC`, a rig key) | The hosts in `FACTORY_BROKER_KEY_HOSTS`, else none |

    `FACTORY_BROKER_KEY_HOSTS` is a JSON object in the broker Deployment env. The manager VM cannot change it. Example: `{"GITLAB":["gitlab.acme.example"],"DOLT_BASIC":["dolt.acme.example"]}`. Each name is upper case, does not start with `GITHUB` and is not a built-in key. Each value is a non-empty list of lower-case host names (no `*`, no port, no trailing dot). A bad value stops the broker at start. Unset or empty means no extra keys. To fill it, list each key of the keyed `rig egress` entries in `rigs.json`, the `GITLAB` and `GITLAB_BASIC` keys with each GitLab rig host, and the Dolt key of each https `beadsRemote` host. After each new `factory rig egress add <host>=KEY` on an AX rig, deploy the broker again with that key. Until then the task shows only `pending: egress policy not created`. The reason is in the broker log. A `GITHUB*` key or a built-in key on another host (for example GitHub Enterprise) cannot be set by the config: rename the vault key. A pinned key can still go to any path and port of its own host. `createPolicy` does not run `keyHostRefusal`.
- `workerPolicyRefusal` in `src/broker.ts` makes this check. `createPolicy` uses the same function. The owner must apply `deploy/broker.yaml` with a new broker image to start the check in the cluster.
- The broker logs one line for each call, and one line `policy refused for <atespace>/<actor>: <reason>` for each refusal.

Any caller that reaches the broker can set the egress of any worker in the served atespaces. Give the broker address only to the manager task. The broker has no caller authentication.

Use in the manager task:

1. On the laptop, set `FACTORY_AX_MANAGER_AX_SERVER`, `FACTORY_AX_MANAGER_ROUTER` and `FACTORY_AX_MANAGER_BROKER` to the in-cluster URLs. Keep the values out of the repository. `factory manager --ax` then sets `AX_SERVER` and `FACTORY_POLICY_BROKER` in the task env.
2. The manager policy gets one `http` rule for the router and one for the broker. An `https` rule does not work for plain HTTP (h2c) to a service. When ax-server caller authentication is on, use an `https` AX server URL, for example `https://ax-server.ax-system.svc:8443`. The gateway then adds `Authorization: Bearer <AX_AUTH>`. On the laptop, export `AX_AUTH_TOKEN` in the shell that runs `factory`. The `ax` CLI sends it over the loopback tunnel.
3. In the VM, `FACTORY_POLICY_BROKER` makes `createPolicy` and `egressCA` call the broker with `curl`, not `kubectl`. Unset, they run `kubectl` as before.

Deploy: set `BROKER_IMAGE` to the image by digest. Run `envsubst '$BROKER_IMAGE $FACTORY_BROKER_KEY_HOSTS' < deploy/broker.yaml | kubectl apply -f -`. The ServiceAccount needs `get` on `clustertrustbundles`. The broker reaches ate-api at `api.ate-system.svc:443`. The cluster must let the namespace pull the image. For the token swap, also set the `CLAUDE_TOKEN_*` variables (see the header of `deploy/broker.yaml`) in the `envsubst` list.

Two more calls serve the manager's secrets (see Manager secrets):

| Call                    | Result                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /controller`       | The readiness fields of Deployment `ax-system/ax-controller` as JSON: generation, replicas, observed generation, ready and available replicas. No env or annotation. |
| `POST /token/best`      | Runs `claude-token best`. 200 with its first stdout line. 409 while one runs. 502 with the first stderr line. 404 when `CLAUDE_TOKEN_ITEM` is unset.       |

`GET /controller` needs `get` on that one Deployment (a Role in `ax-system`). `POST /token/best` changes the live Claude token for every AX worker, so `deploy/broker.yaml` has a NetworkPolicy. It lets only namespace `ate-system` (the egress gateway) reach port 8080. Confirm the gateway pod labels at apply. The response never holds a token.

### Manager secrets

The manager VM holds placeholders only. The egress gateway puts the real value in from the agent-vault vault (`FACTORY_AX_VAULT`).

| Secret                    | In the VM                                              | How it works                                                                                                                       |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Claude session            | `CLAUDE_CODE_OAUTH_TOKEN=placeholder`                  | Vault key `ANTHROPIC`, rule for `api.anthropic.com`.                                                                               |
| `gh`                      | `GH_TOKEN=placeholder`                                 | Vault key `GITHUB`, rules for `api.github.com` and `uploads.github.com`.                                                           |
| `git push`                | Basic-auth header with a placeholder                   | Vault key `GITHUB_BASIC`, rule for `github.com`. `zach-source` repos wait on claude-factory-192.11.                                |
| Dolt (`bd dolt pull`)     | `DOLT_REMOTE_PASSWORD=placeholder`                     | The rig's own egress entry for that host and port gives the vault key, header and prefix. Else the key is `DOLT_BASIC`. `managerEgress` adds one rule for each `https` `beadsRemote` host and port. A rig with none, or with an `http` remote, adds none.            |
| Linear (`--linear` rigs)  | Key `placeholder` when `FACTORY_IN_AX=1`               | Vault key `LINEAR`, header `Authorization`, no prefix. `managerEgress` adds the `api.linear.app` rule only for a `--linear` rig.   |
| AX server                 | `AX_AUTH_TOKEN=placeholder` for an `https` URL         | Vault key `AX_AUTH`, header `Authorization`, prefix `Bearer `. `managerEgress` gives an `https` `FACTORY_AX_MANAGER_AX_SERVER` an `https` rule (port from the URL, else 443). An `http` URL keeps a plain rule and no token. `createPolicy` refuses `AX_AUTH` in the policy of any task but the manager. |
| Router, broker            | none                                                   | Plain `http` (h2c) rules, no credential.                                                                                           |
| Kube API                  | none                                                   | The VM has none. `unavailable()` asks the broker `GET /controller`.                                                                |
| Token swap                | `FACTORY_AX_TOKEN_SWAP` is a `curl` POST to the broker | The broker pod runs `claude-token best`. The op writer token is the Secret `claude-token-op` there, never in the VM.                |

Workers only (not the manager): `BUILDBUDDY`, `ATTIC`, `OPENAI`, `CODEX_CHATGPT`, `CODEX_CHATGPT_ACCOUNT`, `GITLAB`.

Check it in the VM: `AX_CHECK_SWAP=1 RIG_REPO=<clone> BEADS_RIG_REPO=<clone> AX_PROBE_FILE=<task manifest with __NAME__> hack/ax-manager-check.sh`. `AX_CHECK_SWAP=1` is needed for the token swap check. It swaps the live Claude token for all AX workers. Without it, the check prints SKIP. The script prints PASS or FAIL for the `gh`, `git push`, `bd dolt pull`, token swap, AX apply and no-secret-on-disk checks.

Owner steps (a worker never runs these):

1. Merge the pull request.
2. Build and push the broker image by digest (`Dockerfile.broker` takes `OP_VERSION` and `OP_SHA256`).
3. Make a service account with write on the token vault only. Run `kubectl -n factory-broker create secret generic claude-token-op --from-literal=token=<op token>`.
4. Run `CLAUDE_TOKEN_ITEM=.. CLAUDE_TOKEN_VAULT=.. CLAUDE_TOKEN_LIVE_FIELD=.. CLAUDE_TOKEN_SLOT_FIELD=.. CLAUDE_TOKEN_ACTIVE_FIELD=.. BROKER_IMAGE=<digest> envsubst '<the variables>' < deploy/broker.yaml | kubectl apply -f -`.
5. Launch the manager again with `FACTORY_AX_MANAGER_BROKER`, `FACTORY_AX_MANAGER_AX_SERVER` and `FACTORY_AX_MANAGER_ROUTER` set.
6. For a `--linear` rig, add `LINEAR` to the agent-vault vault.

AX server caller authentication (owner steps, in order):

1. Add vault key `AX_AUTH` to the `FACTORY_AX_VAULT` vault. Use the same value as key `token` of Secret `ax-system/ax-server-auth`.
2. Make sure ax-server serves port 8443 and the `ax` CLI in the manager image supports https.
3. Set `FACTORY_AX_MANAGER_AX_SERVER=https://ax-server.ax-system.svc:8443` and launch the manager again.
4. On the laptop, install an `ax` CLI that sends the token (ax-0yc) and export `AX_AUTH_TOKEN`.
5. Create the Secret and restart ax-server. Without `AX_AUTH_TOKEN`, `ax get tasks` fails with Unauthenticated.

Rollback for this part: delete the Secret, or set the `http` URL again and launch the manager again.

Rollback: revert the pull request, apply the previous `broker.yaml` and image, and unset `FACTORY_AX_MANAGER_BROKER`. The laptop path does not change.
