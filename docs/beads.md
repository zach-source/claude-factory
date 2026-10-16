# Using the factory with beads

[Beads](https://github.com/steveyegge/beads) (`bd`) is the factory's task tracker. You put work into a repo's beads. The factory takes the beads that you hand it, runs each one as a run, and writes back what happened. This guide covers what you do, what the factory does, and what to leave alone.

Several factories on one rig (two machines, or two people) is designed in [specs/002-multi-factory-beads](../specs/002-multi-factory-beads/spec.md) and is not built yet. Until it is, give each rig to one factory. See [Sharing beads across machines](#sharing-beads-across-machines) for what works today.

## Make a repo a rig

1. Install `bd` and put it first on your `PATH`. The runner and every worker use the first `bd` they find, and it must match the repo's beads schema.
2. Initialize beads in the repo, once:

   ```sh
   cd ~/repos/my-app
   bd init                 # makes .beads/ and the Dolt store
   bd config get issue_prefix   # the prefix of the ids, e.g. app-
   ```

   On a machine that runs one Dolt server for all its repos (`dolt.shared-server: true` in `.beads/config.yaml`, or `BEADS_DOLT_SHARED_SERVER=1`), `bd init`, migrations and other server-wide operations lock every repo on that server for minutes. Do them when no factory is busy.

3. Add the rig to your factory:

   ```sh
   factory rig add app ~/repos/my-app --max 3
   ```

   `rig add` refuses a repo with no `.beads` (`run bd init there first`). For a local worker, run `claude` in the repo once and accept its trust dialog. If you do not, the rig's runs wait to start.

## Hand work to the factory

A rig's ready beads that carry the label `factory` become runs. Dispatch looks every 30 seconds, while the rig and the factory have room (the rig's `--max` and `FACTORY_MAX_RUNS`).

```sh
bd create "Add a /health endpoint" -t feature -p 1 -d "What, why, and how to verify it" -l factory
factory queue app app-42          # or label a bead that already exists (also takes it out of rejected)
factory queue app app-42 plan     # start it at the plan station (adds station:plan)
```

A bead is **queued** (dispatch starts it) when all of these are true:

| Condition                             | What makes it false                                                       |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `bd ready` lists it                   | It is closed, deferred, in progress, or blocked by an open dependency     |
| It has the `factory` label            | You did not label it, or a station rejected it (label `rejected`)         |
| It has no assignee                    | Someone (a person, a run) holds it                                        |
| It is top-level                       | It has a parent: it is a task of some bead                                |
| It has no open children               | It is an epic that you split into children (see below)                    |
| Its metadata has no `owner_decisions` | Its owner hands it out. Start it by hand with `factory start ... --owned` |

A ready bead **without** the `factory` label is **unqueued**: the board's Backlog lists it for you to prioritize, and the manager does not start it. You queue it when you want it done.

**Priority**: dispatch takes queued beads in `bd ready` order, which is by priority first (`-p 0` is the most urgent, `-p 4` the backlog). Set it with `bd update <id> -p <n>` or `bd priority`.

**Start one now**, not at the next dispatch: `factory start lifecycle app app-42`. `start` claims the bead for the new run. A goal that is not a bead id creates a new bead from the goal. A goal shaped like one of the rig's own bead ids (its `issue_prefix`, e.g. `app-42`) never creates a bead: if bd cannot find it, or cannot answer at all (a timeout, bd down), `start` fails and creates nothing, rather than filing a new bead titled with the id text.

## Epics and children

The factory uses a bead's children as its task list:

- **A run's own plan**: the plan station records its tasks as children of the run's bead, in dependency order. Implement works `bd ready --parent <bead>` and closes each task with its commit. Verify, review and security file what they find as more children. Release refuses while any child is open.
- **An epic that you split yourself**: dispatch does not start a bead that has open children, and it never starts a child (only top-level beads). The manager or you start the children one at a time with `factory start lifecycle app <child-id>`. `factory start` on the epic itself refuses and lists its open children.
- When a run ends and its bead still has open children, the bead stays open and unassigned for them, with a comment that says so.

## While a run works a bead

The run **claims** the bead: bd sets the assignee to `factory/<run>` and the status to `in_progress`. The run heartbeats the claim every 2 minutes, well inside bd's 5-minute lease, so a `bd reclaim` reaper never takes live work. Workers write as `factory/<run>/<station>`, so `bd show` and the bead's history tell you which station did what.

What the factory writes:

- each station's report, as a comment on the bead (a sweep's routine passes excepted);
- the plan's tasks, as children, and their closes;
- new beads for separate work that a worker finds, linked with `discovered-from:<bead>`. Work that should start on its own gets the `factory` label. Work for you to prioritize does not. Sweeps file incidents and security fixes with the label and the rest without it.

How the run's end settles the bead:

| The run                                   | The bead                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| shipped, or finished another way          | closed, with the last report as the reason                                                                                           |
| held for you, or aborted                  | deferred and unassigned. `bd undefer <id>` hands it back to the factory                                                              |
| rejected by a station (not the factory's) | open and ready, `factory` swapped for `rejected`, metadata `rejected_by`, `rejected_at`, `reject_reason`. Queue it again or close it |
| ended with open children                  | open and unassigned, for the children                                                                                                |

### What not to touch

- Do not close, defer, unclaim or reassign a bead that a run holds (assignee `factory/...`). The run settles it. If you want the run to stop, `factory abort <run>`. That defers the bead.
- Do not run `bd unclaim --force` or `bd reclaim --any-replica` on factory claims. A live run then loses its bead, and the next dispatch can start a second run for it.
- Do not remove a run's children to make release pass. Close them with a reason, or tell the run (`factory mail <run> <station> ...`).
- Commenting, adding children, changing the priority and adding dependencies are fine.

## Sharing beads across machines

Beads lives in a Dolt database. To share it, add a Dolt remote and push to it once:

```sh
cd ~/repos/my-app
bd dolt remote add origin http://dolt.example.internal:50051/my_app   # a Dolt server's remotesapi
# or a DoltHub database, or the repo's git origin (Dolt keeps the data under refs/dolt/data)
bd dolt push                     # the first push seeds the remote: it publishes the repo's beads
bd config set node_id laptop     # per machine, in ~/.config/bd/config.yaml; never in .beads/config.yaml
```

A self-hosted Dolt server has no owner in the path (`/<database>`), and the database must exist on the server before the first push. Use `http://` when the server's remotesapi does not serve TLS.

Then, on each machine:

```sh
bd sync          # pull, check conflicts, repair, push: the loop to run after you change beads by hand
bd dolt pull     # only pull
bd dolt push     # only push
```

The factory runs `bd sync` for each rig that has a Dolt remote every 5 minutes, so beads and claims from other machines reach dispatch, and the factory's writes reach them. A remote that has never been pushed to, or a conflict that `bd sync` cannot settle, shows as the rig's error on the board.

`node_id` matters only for `bd reclaim`: bd keeps a claim's lease on the machine that granted it, and with `node_id` set, a reaper on another machine skips it. Machines that use one Dolt server are one replica and share one `node_id`, or leave it unset.

### AX workers

Workers on the [AX runner](remote-runner.md#beads-in-the-vm) run in VMs with a clone of the rig's beads. The laptop pushes before each launch and pulls each report. A VM bootstraps from the repo's git origin, or from the rig's `beadsRemote` (`{ name, url, user }` in `rigs.json`) when the store is too large for GitHub. VMs write as their station's actor and never claim beads.

### Several factories

Today a factory assumes that every `factory/...` claim and branch on a rig is its own, and it claims beads on its local store before it syncs. Two factories on one rig can both start the same bead, and can both act on the same pull request labels. Give each rig to one factory until [spec 002](../specs/002-multi-factory-beads/plan.md) lands. A person can still use beads on another machine at the same time: the factory never starts a bead that someone holds.

## Linear

A rig can turn on a Linear pull loop. The loop copies Linear issues from a team into the
rig's beads. It uses `bd linear sync --pull-if-stale`. The loop never pushes changes back to
Linear.

### Turn it on

1. Find the Linear team's id. The id is a UUID. If a rig already syncs with Linear by hand,
   run `bd config get linear.team_id` to get the id.
2. Store the Linear API key, or the client id and secret of an OAuth app, in a secret manager.
   Write a command that prints the value. Put the command in `$FACTORY_HOME/linear.json`:

   ```json
   { "apiKey": "op read op://vault/linear/api-key" }
   ```

   For an OAuth app, use this format:

   ```json
   { "clientId": "op read op://vault/linear/client-id", "clientSecret": "op read op://vault/linear/client-secret" }
   ```

   This file holds a command. It never holds the value itself.

   If a value starts with `lin_api_` or `lin_oauth_`, the factory does not accept it. That value is a literal key, not a command.

   The factory never writes to `linear.json`. It never runs `bd config set` with the key.

3. Add the team to the rig:

   ```sh
   factory rig add app ~/repos/my-app --linear 04114abf-ddb7-4a6f-bb47-814fd2c44373
   ```

   The `--linear` flag can have one team id, or several team ids separated by commas.

   If you run `rig add` again with no `--linear` flag, the factory removes the field. It also turns the loop off for that rig.

### What the loop does

Every 20 minutes, the factory runs `bd linear sync --pull-if-stale --threshold 15m --team
<ids> --json` in the rig's repo. It does this for each rig that has the loop on.

The factory passes the key, or the OAuth pair, through the environment only. It never puts the key on the command line, on disk, or in a bead.

To run the sync now, use `factory linear [rig...] --force`. With no rig names, the command runs the sync for all rigs with the loop on. With rig names, it runs the sync only for those rigs.

A pull adds Linear labels to the beads it touches. A Linear label named `factory` can start a run by itself. To prevent this, the loop removes the `factory` label after each pull.

The loop checks every bead that now carries the `factory` label for the first time. This can be a new bead, or an old bead the pull updated. If a bead already had the label before the pull, it keeps the label.

The loop also checks for this label after a pull that errors or times out. The pull can label a bead before it fails.

Sometimes the factory cannot confirm that it removed a label. This can happen when `bd label remove` fails, or when the check after it fails. The factory tries that bead first on the next pass, before any bead the new pass finds.

A person's queue, not Linear's label, decides what the factory works on.

### Checking it

`factory rig list` shows the last pull for each rig with the loop on. The output shows the age of the pull, and either what it pulled or the error.

The console's [Rigs tab](console.md#rigs-key-4) shows the same line.

If a rig's pull fails, the factory mails the manager once for that error. If a later pull succeeds, it clears the error. A new error after that mails the manager again.

`$FACTORY_HOME/linear-sync.json` keeps each rig's last result. The factory cuts an error in this file to 200 characters. It replaces every secret value with `***`.

## Common problems

| Symptom                                                     | Cause and fix                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bead does not start                                       | Check the queued table above: `bd show <id>` (label, assignee, parent, status, `owner_decisions`), `bd children <id>`, `bd blocked`. Then check room: `factory rig` shows busy/max per rig. A stopped factory (`factory stop`) dispatches nothing. |
| The board says the rig is idle: "no goal, no ready beads"   | Nothing is queued and the rig has no goal. Queue a bead, or give the rig a goal (`rig add ... --goal ...`).                                                                                                                                        |
| `bd sync: the remote holds no beads yet`                    | Seed it once with `bd dolt push`. The factory does not do this for you, because it publishes the repo's beads.                                                                                                                                     |
| `bd sync` reports a conflict                                | Two machines changed the same field. `bd conflicts list`, `bd conflicts show <id>`, then `bd conflicts resolve <id> --ours` or `--theirs`, then `bd sync`.                                                                                         |
| `<bead> is already claimed by another worker`               | Someone holds it. `bd show <id>` names the assignee. If it is a stale run of this factory, `factory status` shows it: `factory abort <run>` defers the bead, and `bd undefer <id>` hands it back.                                                  |
| A run's error: `lost the claim on <bead> to another worker` | Someone else took the bead while the run worked it, often a manual `--claim` on another machine followed by a sync. Decide which one keeps it, and abort the other run (`factory abort <run>`).                                                    |
| `bd unavailable, the claim is kept and retried`             | bd did not answer (a shared Dolt server busy with a migration, or down). The run keeps its claim and retries. `bd ping`, then `bd dolt start` or `bd doctor`.                                                                                      |
| Every repo's `bd` hangs for minutes                         | A `bd init` or migration on a shared Dolt server holds its lock. Wait for it. For scratch databases, use `BEADS_DOLT_SHARED_SERVER=0 bd init` in a temporary directory.                                                                            |
| `bd` warns that `.beads` has permissions 0755               | `chmod 700 .beads`.                                                                                                                                                                                                                                |
| A worker's bd writes fail with schema errors                | The `bd` on `PATH` does not match the repo's schema. Use one `bd` version everywhere, the factory machine and the AX image included.                                                                                                               |
| A deferred bead never comes back                            | Deferred beads stay out of `bd ready` until you `bd undefer <id>`. That is how you hand held or aborted work back.                                                                                                                                 |
| A bead that a station rejected                              | It is open with the `rejected` label and the reason in its metadata (`bd show <id>`). `factory queue <rig> <id>` queues it again, or close it yourself.                                                                                            |
| `factory start ... <id>` fails with `could not look up bead <id> ...; nothing was created` | bd could not answer for a goal shaped like one of the rig's own bead ids (a timeout, bd down). Nothing was created or started; fix bd (`bd ping`) and start again. |
| `factory start ... <id>` fails with `no bead <id> in <repo>; nothing was created` | The id carries the rig's own prefix but bd genuinely has no such bead. Check the id, or drop the `<prefix>-` shape if you meant it as plain goal text. |
