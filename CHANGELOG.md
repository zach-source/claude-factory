# Changelog

Each release is tagged `v<version>` and its version is set in `package.json` and
`mod/.claude-plugin/plugin.json`. Versions follow [semver](https://semver.org); until 1.0 a
minor release may change the factory format, the CLI or the run state.

## Unreleased

- Fixed: a worker pane's launch line was typed into the shell key by key, so any `jk` substring in it (a run ID, worktree path or prompt-file path) fired zsh-vi-mode's insert-mode escape mid-line, leaving stray characters and a continuation prompt; the station then failed with "the worker never started". `src/harness.ts` now writes the real launch command to a 0600 script (`writeLaunch`, `<FACTORY_HOME>/launch/<pane>.sh`) and `src/cli.ts`'s `typeLaunch` types only the fixed `LAUNCH_LINE` into the pane (launch, in-pane resume, and relaunch's retype), so no run-specific text is ever typed into a worker's shell.
- An AX worker whose turn ends on the egress gateway's SAN-verification outage to `api.anthropic.com` (envoy flag `UF`, `cx_connect_fail` on `egress_forward_proxy`) now retries the same session with backoff instead of failing the attempt: `egressFailure` in `src/worker.ts` detects the signature for Claude, Codex and Pi, `serve` retries within a budget (`FACTORY_EGRESS_WAIT_MS`/`FACTORY_EGRESS_BUDGET_MS`) that spans the whole outage rather than resetting per turn, and `poll`/`WorkerInfo` surface it. `reconcile` mails the manager once per outage (keyed per run and node) and, if the outage outlasts the budget, fails the attempt with a named reason instead of the generic "worker stopped without reporting". The upstream fix (Substrate's `ate-system/atenet-egress`) is tracked separately as claude-factory-ue9; see `docs/remote-runner.md` for the signature and the manual workaround.
- The console's PRs tab (7) now shows every pull request a run touches, not just an open one on its own `factory/*` branch in the run's own rig: each run keeps `runs/<run>/prs.json` (url, repo, number, role, first-seen station), filled from reports and mail and refreshed from `gh` (draft/open/merged/closed, review decision, checks) with a backoff on repeated failures. Merged and closed PRs stay listed until the run is removed, drafts are marked, and companion PRs in other repos (and PRs on other branch names) are no longer dropped.
- A rig with room, no goal and no ready `factory` beads gets a row from dispatch (`idle: no goal, no ready beads`) that the board shows as idle, and the patrol tells the manager once per rig instead of dropping it, so a rig left with nothing to do is noticed without waking the manager every heartbeat.
- The manager's patrol board gives each working run its facts: `- r1 (rig web) at implement/working, attempt 2/3, 30+ min in station, quiet 10+ min, runner paused by its usage limit until 14:00: goal`. `factory tick` rows carry them as `inMin`, `quietMin` and `limitUntil`. Minutes are floored to 10 so an unchanged board is still sent once.
- A station whose attempt fails by going silent (no report in time, or stalled) the same way as the attempt before it is held `stuck` at once, spending no further attempt, with a question for the console's Interview tab (`retry` or `abort`) instead of a third identical try.
- A worker that is `working` but shows no new output (its transcript tail and local branch head unchanged) for 20 minutes is nudged once; after 20 more its attempt fails as `stalled: no output for N min` and the manager is mailed the station, run, minutes and last line. Before, a hung turn counted as working until 1.5 times the station's limit. The fingerprint is kept in the run's `progress.json`, so a restart does not reset it.
- The console's Backlog tab groups each list by priority (P0 first), filters by bead type (all, bug, feature, task, epic, chore), and draws a bead's children indented under it. A type filter keeps the beads of that type with their children; a child whose parent is elsewhere stands at its own priority. The unqueued list stops after 15 rows without splitting a parent from its children.
- Fixed: AX workers never started since v0.7.0 moved them to a non-root `worker` user: the laptop's own `ax ssh` calls (`poll`, `prompt`, `put`) still ran as root, which has no `DAC_OVERRIDE` over `.factory-worker` (owned `worker:worker`), so `put` hit `EACCES` and the brief, sent only that way, never landed; `serve` then died waiting for it with no attempt ever starting. `ax ssh` commands now run through `setpriv` as `worker` by default (bare when `FACTORY_AX_CAPABILITIES` is empty). A `put` that still fails is retried for 5 minutes, then fails the attempt with ax's error instead of running out the station's time limit silently; a task gone because `serve` exited now fails with its log, not just "worker pane … was closed".
- The Interview tab's 'Interview me' button asks the manager to sweep every live run and rig, plus bd, for open decisions a run can't settle on its own — gates awaiting an outcome, workers blocked on a permission prompt, parked or stuck stations, and pending bd items (`bd human list`, owner-only beads) — and list them alongside worker-raised questions. A bare bd question with no options gets the manager's own proposed options (`factory decisions propose`), and the person's answer flows back the same way today's answers do: a gate decides only through its own outcome button, a bd item is answered or started through `factory decisions answer`/`factory start --owned`, and both of those, like `factory decide`, now need the person's explicit Allow before the manager session can run them.

## 0.7.0 (2026-10-14)

- A release factory waits for a release's pull requests to merge, then cuts the release and rolls it out the way the repo does it. A recipe station learns that from `.factory/release.md`, the repo's docs, scripts and CI, and its last releases, since every repo releases differently.
- VM workers run as a non-root `worker` user: Substrate starts every task as root, which tools such as PostgreSQL's `initdb` refuse. The Task asks for `SETUID`, `SETGID` and `CHOWN` (AX's `spec.capabilities`; `FACTORY_AX_CAPABILITIES` overrides the list, and set empty leaves the field out for an AX without it). `serve` starts as root, gives the workspace, the home and Nix's store to `worker` (Substrate shows every image file as root's), then runs itself again as `worker`. A DB-tier test can now start a loopback Postgres in the VM.
- Root in an `ax ssh` shell can use Nix and read the worker's repos again: a `nix` wrapper runs Nix as `worker` for root once `worker` owns Nix's database, and git trusts the repos (`safe.directory`).
- A VM reaches Nix's global flake registry (`channels.nixos.org` is in the default egress), so `nix shell nixpkgs#...` works for the worker user. Turning the registry off in `nix.conf` instead would change every devenv's derivation and miss the rig's cached devenv.
- A rig that sets `FACTORY_KUBE_SERVER` gets read-only `kubectl` on its cluster with no token in the VM: `serve` writes a kube config whose bearer token is a placeholder, and the rig's egress injects a read-only identity's token from the vault.
- `bin/claude-token` shows how much of its 7-day and 5-hour limit each stored Claude token has used, and makes one of them the token agent-vault serves (`use N`, `best`). It reads every store name from env, so it holds nothing private.
- With `FACTORY_AX_TOKEN_SWAP` set (for example `bin/claude-token best`), a VM worker's usage limit runs that command once, mails the manager the live slot, and resumes the worker after the vault's refresh, not at the limit's reset. Without it, or when the swap fails, workers wait for the reset as before.
- The repo carries spec-kit, and `specs/001-factory-cli-integration` specifies one factory CLI for the scripts and hand edits around the factory today.
- The VM brief says to run tests the repo's way (`make test`), which sets envtest up: workers that ran a bare `go test` failed on missing envtest binaries. The worker image carries `devenv` and substitutes from `devenv.cachix.org`, but `devenv shell` does not work in a VM yet: every local Nix build fails under gVisor (its builder dies before it starts), and a devenv profile is always built locally.
- A rig with a binary cache of its repo's devenv (`FACTORY_NIX_CACHE`, its egress injecting the cache's token) gets that devenv's environment in every VM worker: tools on PATH and variables set before the agent starts, without `devenv shell` and its git hooks. See the remote runner doc.
- `factory devenv` builds each such rig's devenv outside the VMs and pushes it to the rig's cache, again whenever its devenv files or the worker image change; the tick runs it every half hour.
- The console's Interview tab (8) asks the person each question a run cannot settle on its own: a station parked on their decision or stuck out of retries. A blocked worker ends its summary with `Question:` and, for clear choices, `Options: a | b`, which become buttons; the answer is mailed to the station (waking a parked one, retrying a stuck one), the manager hears of it, and the answered tab keeps the questions and answers.

## 0.6.0 (2026-10-12)

- The lifecycle factory's approve gate is gone: your merge of the pull request is the gate. Release goes straight to deploy, which parks until a person merges and never merges itself; changes requested on the pull request send the run back to implement, and closing it ends the run with its bead deferred. Across 286 gates the answer was ship 285 times, and a third of shipped runs then waited at deploy for the same person's merge anyway.
- AX workers install the tools a repo needs with Nix (single-user, binary cache only, nixpkgs pinned in the image); `serve` adds a localhost entry, `GOTOOLCHAIN=local` and an envtest kube-apiserver wrapper for the VM's link-local address.
- A triage reject no longer closes the run's bead: it stays open and ready, its `factory` label swapped for `rejected`, with who rejected it, when and why in its metadata (an edge's `reject: true`); queuing it again takes it back.
- The manager reviews the skills the dream proposes before they install: the dream writes them to `memory/.manager/skills/` (Claude Code refused its writes under `.claude/`, so none ever installed), a tick mails the manager each new, changed or reaped one, and `factory skills install|reject` decides it.
- The manager starts in bypass permissions, not the person's default mode: auto mode refused the production reads a patrol needs.
- The console's Rigs tab drew nothing once a rig ran past its cap: its bar asked for a negative repeat.
- A rig's `beadsRemote` pull no longer stalls on a conflict: in one transaction it commits the laptop's pending bd writes, merges, and keeps the VM's version of any row both sides changed, commenting on each overwritten issue what the laptop had. A launch pulls before it pushes.
- An AX station's next attempt starts from what its gone worker pushed: the laptop's worktree catches up with a rebase (dropping commits the worker already has, as after its own rebase onto main) instead of pushing its stale copy over the branch every tick.
- A rig's `beadsRemote` shares its beads with VM workers through a Dolt server instead of the repo's GitHub origin: the laptop pushes and pulls that remote, and the VM bootstraps from it with only a placeholder password, which the egress gateway replaces (egress rules take a `port`).
- A rig's `env` reaches its VM workers, and `FACTORY_BAZELRC` there becomes the VM's `~/.bazelrc` plus the egress gateway's CA (`--tls_certificate`, and a Java trust store for Bazel's JVM): a Bazel rig shares a remote cache whose key the gateway injects.
- A VM worker's `factory report` is refused while its bd changes cannot reach GitHub: queued without them, the report ended the VM and the changes with it.
- Beads for AX workers: the VM clones the rig's issue store from the repo's GitHub origin (where the laptop's dolt pushes it), works it with plain bd, and pushes it back before it reports; the laptop pulls when it replays the report.
- A VM worker's brief goes over `ax ssh` once its task runs: Substrate takes no env value past 32 KiB.
- A station can name its own `runner`; it wins over the rig's. Lifecycle keeps the stations that read or change production (baseline, deploy, soak, rollback, incident, monitor) on herdr, so a rig with `--runner ax` sends only the code stations to VMs.

## 0.5.0 (2026-10-11)

- Remote runners: where a worker runs is a `Runner` (`src/runner.ts`), picked per rig with `rig add --runner`. Besides herdr panes, a rig's workers can run as AX tasks: a microVM per launch that runs the rig's agent (claude, codex or pi) headless, reaches only the hosts its egress policy allows (`--egress` adds a rig's own) and holds no key, since the egress gateway injects them from agent-vault. The VM's report, mail and memory add come back through an outbox the laptop polls and replays only for the worker's own run and attempt, as its station. See [docs/remote-runner.md](docs/remote-runner.md).
- A worker that hits its account's usage limit restarts on the next account (via `ccswitch switch-to`), resuming its session; with every account limited, workers wait for the first reset instead of timing out.
- Manager skills: the dream writes skills for the manager from the work its sessions repeat and reaps the unused ones; the manager loads them from the memory (`memory/.manager/.claude/skills/`) with the Skill tool.
- `factory manager` supervises the manager's Claude: refused for a usage limit, it swaps the account and resumes the manager's session. Swaps are recorded for every factory on the machine.

## 0.4.0 (2026-10-11)

- Lean workers: a Claude worker runs on its own settings (the user's hooks and environment only),
  a short worker system prompt and the tools workers use, with MCP tools deferred behind ToolSearch,
  auto memory off and the global CLAUDE.md excluded. Before any work, an infra-blocks worker's
  context dropped from ~98k tokens to ~26k, and every turn carries the difference.
  `FACTORY_LEAN=0` turns it off.
- Handoff: past `maxContextK` (200k) a Claude worker is asked to commit and report `handoff` with
  notes, and a fresh worker carries on at the same station; at 1.25x it is cut off. Implement
  sessions had reached 567k, re-read on every turn.
- CORE.md is cut at 2.5 KB a part (its top, each rig's section) in briefs, and the dream keeps it
  to one short line a lesson; it had grown to 16 KB in every brief.
- `factory metrics --tokens`: what the live runs' workers spent, by station.
- A `conflict` or `rework` label on a PR a live run owns (its branch, or linked in its reports) mails
  that run's station instead of starting a second worker on the same branch; `close` aborts that run.
- A parked station whose linked PRs are all merged or closed wakes on its plain `parkMin` timer, not
  the 8-hour backstop: nothing will change those PRs.
- A station parked on pull requests (its blocked report links them) is watched with `gh` and mailed
  awake when one is merged, closed or updated, instead of a fresh worker re-checking on a timer;
  the timer backstops it at 8 hours. Deploy re-checks were most of infra-blocks' worker launches.
- A run on a repo Claude does not trust starts no worker (it would stall at the trust dialog until
  its timeout, every attempt); the manager is paged once, and `rig add` warns.
- Stations take `rounds`: past that many reports of one outcome in a run, the next is held for the
  manager. Lifecycle's review has 3, so a review loop that is not converging gets a person.
- Pull request labels act: `close` closes the PR (and aborts its run), `conflict` starts a run of the
  new one-station `rework` factory (YAML) that merges the base in, resolves, tests and pushes.
  `rework` starts the same run for a PR that needs changes: it triages the PR, makes what its reviews
  and checks ask for, or labels it `close` when it is no longer wanted.
- Beads sync: every 5 minutes, each rig whose beads have a Dolt remote runs `bd sync`, so work
  and claims from other machines reach dispatch and the factory's reach them. Failures, such as a
  remote nobody seeded yet, show as the rig's error and don't stop its dispatch.
- Factories extend each other: `extends: lifecycle` and only the stations you add or change, where
  a node merges into the base's field by field and `next` outcome by outcome. A factory can be
  written in JSON, YAML or TOML as well as TypeScript. Runs pin their factory resolved, as
  `factory.json`; runs started before keep their pinned `factory.ts`.

## 0.3.0 (2026-10-07)

- A factory's `params` are what its worker commands name as `{name}`: lifecycle's launcher
  (`claude`, default `claude-smart --new --no-channels`) and its three models. A rig sets them
  (`factory rig add ... --param exec_model=...`), else `FACTORY_<NAME>` in the environment
  (`FACTORY_CLAUDE`), else the factory's default; `factory check` names any it does not give. The
  default worker and the dream follow `FACTORY_CLAUDE` too, and a wrapper it names runs as Claude.
- `factory manager` starts a factory's manager lean: Bash and file tools only, no MCP servers,
  claude.ai connectors or Chrome. A manager started with `claude-smart` carried ~134k tokens of
  tool definitions into every call; this one starts at ~29k.
- A station that reports `blocked` again waits twice as long before its next check (60, 120,
  240 minutes, at most 8h): each check starts a whole worker.
- Only the session herdr sees in the manager's pane patrols. A background fork of the manager
  inherited its pane and patrolled as a second manager, and its stale-session hook typed
  `/compact` into the real manager's pane.
- The manager's context stays small. A station that parks again tells the manager nothing new; the
  patrol caps each message at 300 characters and sends the board and rig goals only when they
  change (and hourly); and `factory manager` runs `opus`, which Claude Code compacts, instead of
  `opus[1m]`. Managers had grown to 400–550k tokens, re-read on every call.
- `factory waiting`: everything that waits on the person, by rig: gates, parked stations with what
  holds them and their pull requests, stuck runs, and the command that answers each.
- Fewer lost workers: a worker waiting on the manager's answer is warned at its deadline, not failed;
  an idle worker is nudged four times, each wait twice the last, before it fails; and workers are
  told to wait on builds and CI in the foreground. verify and release get 75 minutes.
- Fewer review rounds: implement and verify now run review's mechanical checks (merge with
  origin/main, break each guard, check doc claims and documented commands, fix a finding's
  siblings), and review lists everything it finds in one pass.
- A run's first station is shown the commits already on the default branch that name its bead,
  so triage checks them instead of rediscovering an existing fix.
- The tick reaps what herdr holds that no run needs: a finished run's workspace (its worktree and
  branch stay until `factory rm`, which removes the worktree with git once the workspace is gone),
  and a Claude idle in a live run's workspace that is not its worker.
- The console's mail splits into not answered and answered: mail you answer (in the console, by
  `factory mail` or through the manager), mail its run has reported past, and mail whose run has
  ended leave the list you work from.
- The console's PRs tab (7, or `factory prs`): each rig's open pull requests from run branches,
  drafts left out, with what each waits on (conflicts, failing checks, approval, the merge) and its
  run's station or gate.
- The board's finished runs fold away (show/hide, folded at first) and list only the last 10.

## 0.2.0 (2026-10-06)

- herdr's sidebar shows each run's station and what holds it (`$factory` on the run's workspace:
  working, needs you, stuck, parked, or when a timed wait ends), and each manager's workspace
  carries its factory's rollup, e.g. "5 running · 1 need you · 1 parked".

## 0.1.0 (2026-10-06)

The first release: herdr software factories, run from a Claude Code session.

### Runs

- A factory is a graph of stations compiled to an xstate machine; a run is a fold over its
  events, persisted (fsynced) under `.factory-state/runs/<run>/`, so a restarted manager
  picks up where it stopped.
- Each station is worked by its own coding agent in a herdr tab of the run's git worktree;
  its report routes the run. Gates are decided by the person only, through `factory decide`.
- Durable workers: a lost pane resumes its session, a swallowed launch is retried, an idle
  worker is nudged before it is failed, retries back off, and a run that loops is held after
  its step budget. Station deadlines warn once and give half again.
- A worker blocked on a person, a human review or merge, or another run reports `blocked`:
  the run parks with no worker and no attempt spent, and wakes when mailed or after
  `parkMin`.
- `factory stop` and `factory resume` shut workers down gracefully and bring them back.
- `factory fork`, `goto`, `retry`, `abort` and `rm` for the manager.

### Factories

- `lifecycle`: build (triage, plan, implement, verify, review, security, release, approve,
  deploy, soak, rollback), incidents and postmortems, and the monitor, maintain and improve
  sweeps.
- A repo can own its factory (`factory adopt`), and each run follows the version its starting
  commit holds; the improve sweep proposes changes to it.

### Rigs and backlog

- Rigs name the repos a factory works, each with its own cap, sweeps and goal
  (`factory rig add`); `factory init` makes a factory directory.
- Beads drive planning and execution: one bead a run, its tasks as children, each station's
  report as a comment; review and security findings are posted on the pull request.
- A rig can run its workers as Claude, Codex or pi (`--agent`), with its own MCP servers
  (`--mcp`).

### Manager and console

- The `mod/` Claude Code mod ticks every run, patrols the factory as its manager (mail,
  gates, stuck stations, backlog) and draws a live console docked beside the chat, with
  rigs, a mailbox with quick answers, and gate decisions.
- Factory memory: workers share notes, ordered by what helped, groomed by a daily dream.
- `factory metrics`: ship rate, time to ship, approve wait, review loops, failure kinds and
  per-station visits, failures and durations, for the factory and each rig; finished runs
  are kept in `metrics.jsonl` after `factory rm`.
