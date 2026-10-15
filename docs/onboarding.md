# Onboarding

This guide takes you from nothing to your first finished run. It is written in ASD-STE100 Simplified Technical English. Each section gives the commands and the facts that you need. The links at the end show where to read more.

## 1. What claude-factory is

A factory is a graph of stations. A station is one step of the work, for example `plan`, `implement` or `review`. A run is one piece of work that moves through the stations. The factory saves the state of each run on every tick.

A Claude session works each station. This session is the worker. It runs in a herdr pane, in its own git worktree. The worker reports an outcome. The outcome decides the next station.

The manager is one Claude session that runs the factory. It reads the board, answers mail, and starts new work. You talk to the manager. The manager brings to you only what you must decide.

A rig is a repo that the factory works. Beads (`bd`) is the task tracker in the repo. A ready bead with the label `factory` starts as a run. The console is the screen that shows all runs. Open it with `/factory`.

## 2. What you need

The repo does not state a version for most tools. The table shows what the repo states.

| Tool | Needed | What the repo states |
| --- | --- | --- |
| Claude Code (`claude`) | Yes | `bin/factory-up` stops if `claude` is not on `PATH`. No version is stated. |
| `bun` | Yes | `bin/factory-up` stops if `bun` is not on `PATH`. No version is stated. |
| herdr | Yes | The workers use herdr panes. Start the manager in a herdr pane. No version is stated. |
| `bd` (beads) | Yes | The first `bd` on `PATH` must match the repo's beads schema. The multi-factory spec reads bd 1.3.0. |
| `gh` | Yes | The factory reads pull requests with `gh`. Workers open and watch pull requests with `gh`. |
| `glab` | No | Use it for a rig whose origin is GitLab. `factory prs` reads merge requests through `glab api`. |
| devenv | No | The AX runner builds a repo devenv. Read [remote-runner.md](remote-runner.md). |
| AX | No | The remote runner. Read [remote-runner.md](remote-runner.md). |

## 3. Install

1. Clone the claude-factory repo and go into it.
2. Install the dependencies:

   ```sh
   bun install
   ```

3. Make a factory. A factory is a directory for its rigs and runs:

   ```sh
   bin/factory init ~/my-factory
   ```

4. Check that the factory is the one you expect:

   ```sh
   cd ~/my-factory
   /path/to/claude-factory/bin/factory home
   ```

The `factory home` command prints the factory that the commands work on. The factory is the directory in `FACTORY_HOME`. If `FACTORY_HOME` is not set, the factory is the nearest directory up that holds a `rigs.json`. If both are absent, the factory is `.factory-state/` in the current directory.

To do the install and start the manager in one step, run this command in a herdr pane:

```sh
bin/factory-up [factory-dir] [--resume <session>]
```

The command installs the dependencies, makes the factory if it is new, and starts the manager. The default factory directory is `$FACTORY_HOME`. If `FACTORY_HOME` is not set, it is `~/factory`.

## 4. Add your first rig

1. Make sure the repo has beads. If it does not, run `bd init` in the repo. `rig add` refuses a repo with no `.beads`.
2. Run `claude` in the repo one time. Accept the folder-trust dialog. If you do not accept it, the runs of the rig wait for trust and no worker starts.
3. Add the rig:

   ```sh
   factory rig add api ~/repos/api --max 3 --goal ship the v2 API
   ```

4. Check the rig:

   ```sh
   factory rig
   ```

The next table shows the options that you need first. `factory --help` lists all options.

| Option | Meaning |
| --- | --- |
| `--max n` | The cap of busy runs for this rig. It sits under `FACTORY_MAX_RUNS` (default 8). |
| `--goal text...` | Your direction for the rig. While the rig has room, the manager gives it the next work for this goal. |
| `--sweeps a,b\|none` | The sweeps that the factory keeps running. The default is all sweeps of lifecycle: `monitor`, `maintain` and `improve`. |
| `--runner herdr\|ax` | Where the workers run. The default is `herdr` panes on this machine. |

A rig name stands for its repo in all commands. To remove a rig, run `factory rig rm api`. Nothing new starts, and its runs continue.

### Label a bead

A bead starts as a run when all of these are true: it is ready, it has the label `factory`, it has no assignee, and it is a top-level bead. Dispatch looks every 30 seconds while the rig and the factory have room.

```sh
bd create "Add a /health endpoint" -t feature -p 1 -d "What, why, and how to verify it" -l factory
factory queue api api-42        # label a bead that exists
```

A ready bead without the label is not queued. The Backlog tab lists it for you. The facts about beads are in [beads.md](beads.md).

## 5. Start the manager and open the console

The manager is a lean Claude session. It has Bash and file tools. It has no MCP servers. The factory starts it with the plugin in `mod/`. This plugin adds `/factory`.

1. Start herdr, and open a pane.
2. Go into the factory directory: `cd ~/my-factory`.
3. Start the manager:

   ```sh
   /path/to/claude-factory/bin/factory manager
   ```

   To bring back a manager session, add `--resume <session>`.
4. In the manager session, type `/factory`. The console opens beside the chat.

With `autopilot` on (the default), the manager wakes on a `[factory] patrol`. A patrol starts when:

- the manager has mail (a question, a stuck station, a gate, a finished run);
- a worker waits on a prompt;
- 10 minutes pass while workers run, or while a rig with a goal has room, and the board or the
  rig goals changed since the last patrol (time in station does not count as a change).

An unchanged board still goes out in full once an hour, so a manager that compacted it away
from its context gets it back.

Between patrols, the runtime ticks every 5 seconds. A tick starts and resumes workers. It nudges an idle worker two times, and then retries with backoff. Run only one manager session for each factory.

To tick with no console, run `factory loop [--interval ms]` in the factory directory.

## 6. Your first run

1. Make sure the rig has a ready bead with the label `factory`. Dispatch starts it. To start a bead at once, type this in the manager session:

   ```
   /factory start lifecycle api api-42
   ```

   The goal can be a bead id or plain text. Plain text creates a new bead.
2. Type `/factory`. Press `1` to open the Board. Find your run in a column.
3. Watch the run move through the stations of the `lifecycle` factory: `triage`, `plan`, `implement`, `verify`, `review`, `release`, `deploy` and `soak`.
4. If the run needs you, it appears in `? AWAITING YOU`. Read the question on the card. Press an outcome button to answer the gate. You can add a note for the next station.
5. When `release` finishes, the worker marks the pull request ready. Open the pull request on GitHub and read it.
6. Merge the pull request. Only you can merge it. The factory does not merge. The `deploy` station waits until you merge, then it deploys and watches the rollout.
7. If you want changes, request changes on the pull request. The run goes back to `implement`. If you close the pull request, the run ends and its bead is deferred.
8. When the run ends, it moves under `Finished` on the Board. Its bead is closed.

You can also answer a gate in the terminal: `factory decide <run> <outcome> [note...]`. Only you can answer a gate. A worker is refused.

## 7. The console in one minute

Keys `1` to `6` switch tabs. Press `tab` to move between controls, `enter` to press one, and `esc` to go back to the prompt.

| Key | Tab | What it shows |
| --- | --- | --- |
| `1` | Board | All runs in columns by state: awaiting you, stuck, working, waiting. You answer gates here. |
| `2` | Backlog | The bead tree of each rig. You can `queue` a bead or `start now`. |
| `3` | Mail | Messages between the manager and the workers. You can approve, reject, or send feedback. |
| `4` | Rigs | The status of each rig: capacity, sweeps and goal. |
| `5` | PRs | The pull requests and merge requests that the runs touched. |
| `6` | Interview | One list of every question that only you can answer. |

The full guide for each tab, with its keys and buttons, is in [console.md](console.md).

## 8. When something goes wrong

### Find the cause

| Symptom | What it means | What to do |
| --- | --- | --- |
| A card shows in `! STUCK` | A station used all its retries, or a worker went idle. The manager is paged. | Open the card. Read the reason. Press `retry`, `go to <station>` or `abort`. |
| The header shows `! stale since HH:MM` | The last tick failed. The board shows old data. | Read the line `factory tick failed:` in the status line. It gives 160 characters of the reason. The mark goes away after a tick succeeds. |
| A run waits for trust | Claude does not trust the repo. | Run `claude` in the repo one time and accept. |
| A bead does not start | The rig is full, the bead is not queued, or the factory is stopped. | Run `factory rig` to see busy and max. Read the table of conditions in [beads.md](beads.md). |
| The run shows `unreachable: <error>` | The AX server did not answer. | Check the connection to the AX server. |

### Useful commands

| Command | Use |
| --- | --- |
| `factory status [run]` | Show the runs at a glance, or the full log of one run. |
| `factory waiting` | Show everything that waits on you, and how to answer each item. |
| `factory poke <run> [text...]` | Nudge the worker of the current station. |
| `factory retry <run>` | Retry a stuck run. |
| `factory goto <run> <node\|done>` | Move a run to a station. |
| `factory abort <run>` | Abort a run. Its bead is deferred. |
| `factory rm <run>` | Remove a finished run. Its branch stays. |

### Stop and resume

1. To stop the factory, run `factory stop`. Each working worker commits and waits. Its pane closes when it is quiet, after 5 minutes at most. Nothing starts or dispatches.
2. To see the progress, run `factory status`.
3. To bring the workers back, each in its own conversation, run `factory resume`.

The console also has a `stop` button and a `resume` button.

### Where the state lives

All files are under the factory directory (`FACTORY_HOME`). The factory has no log file for the tick. The manager session shows the tick messages.

| Path | Content |
| --- | --- |
| `rigs.json` | The rigs. You can edit it by hand. |
| `runs/<run>/state.json` | The saved state of a run. A restart continues from it. |
| `runs/<run>/inbox.jsonl` | The reports that wait for the next tick. |
| `halt.json` | The state of `factory stop`: stopping or paused. |
| `memory/` | The shared memory of the workers. It is its own git repo. |
| `launch/<pane>.sh` | The launch script of each worker pane. |
| `devenv/<rig>.log` | The build log of a rig for the AX runner. |

## 9. Next steps

- **Remote runner.** A rig can run its workers in AX microVMs on a Kubernetes cluster. Add `--runner ax` to `rig add`. Read [remote-runner.md](remote-runner.md).
- **GitLab rigs.** If the origin of a rig is GitLab, `factory prs` and the PRs tab show its merge requests. Sign in to `glab`. Workers still open and watch pull requests with `gh` only.
- **Memory.** Workers share what they learn. Use `factory memory search [--rig r] <query...>` to find a note. Use `factory memory add [--rig r] <summary> [body...]` to save one. `factory dream` cleans the memory. A tick starts one dream each day.
- **Your own factory.** Run `factory adopt <repo>` to copy the lifecycle template to `<repo>/.factory/lifecycle.ts`. Run `factory check <file>` to validate a factory file.
- **Metrics.** Run `factory metrics [--rig r] [--since 7d] [--json]`.
- **Other agents.** Use `--agent` to run a rig with `codex` or `pi`, and `--mcp` to give workers MCP servers.

| Read | For |
| --- | --- |
| [README.md](../README.md) | The full reference: rigs, lifecycle, memory, pull request labels, caveats. |
| [console.md](console.md) | Each console tab, its keys and buttons. |
| [beads.md](beads.md) | Queue work, epics, claims, and how to share beads. |
| [remote-runner.md](remote-runner.md) | The AX runner. |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in each release. |

Run `bin/factory --help` for the list of all commands.
