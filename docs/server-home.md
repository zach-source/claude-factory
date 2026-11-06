# Server home: split the rigs, cut over, go back

This page describes step S2 of `specs/004-factory-server/plan.md`. The AX rigs are in the server home on the PVC. The herdr rigs stay in the local home. Each rig runs in exactly one home. Do not run a rig in two homes.

Only the owner can do the steps that are marked **Owner step**. The factory does not do these steps.

## The rule

- The server home (`/var/lib/factory/home` in `deploy/server.yaml`) runs only rigs with `runner: ax`.

- If a rig in the server home has another runner, `factory server` fails its tick. It does not run the tick.
  - `/healthz` shows `tickOk: false`.
  - The log line starts with `tick failed: server home holds`.

- In a server home, a station with a local runner (herdr) does not start. The run holds.
  - The manager gets one mail: `station <node> needs a local runner`.
  - The decision on where such stations run is in claude-factory-dhq7.

- After the split, the local home keeps a tombstone file, `home-split.json`. The file names each rig or repo that belongs to the server home.
  - `rig list` hides the named rig or repo.
  - `start`, `fork`, `dispatch` and `ship` refuse it.
  - `rig add` refuses it.

- If `home-split.json` cannot be read, those commands fail. They do not skip the check.

## Split the home

Run this procedure on the laptop. The local home needs at least one `runner: ax` rig. Each moved rig needs an `origin` remote.

1. Make sure that no run has a worker in a herdr pane on a moved rig.

2. Finish or abort those runs. You can also let them reach a gate or a wait.

3. Run `factory home split <dir> --dry-run`. The command prints the rigs that move, the rigs that stay and the runs that move.

   It writes nothing.

4. Run `factory home split <dir>`.
   - `<dir>` must not exist, or must be empty.
   - It must not be inside the home.
   - The command takes `tick.lock`.
   - It stops with `a tick holds tick.lock: try again` if a tick runs.

5. The command copies the run directories, with their `.seen` files, into `<dir>/runs`.

   It writes `<dir>/rigs.json` with an `https` remote for each rig.

   Then it writes `home-split.json` in the local home.

   It removes the moved rigs and runs from the local home.

If the split stops before it writes `home-split.json`, the local home is unchanged and nothing uses `<dir>`.

The command refuses to run in an AX task. It refuses when `FACTORY_SERVER` is set. It refuses when a worker runs it.

## Cutover

1. **Owner step.** Create the namespace, the PVC, the Secrets and the gateway route for port 8444. Apply `deploy/server.yaml`.

2. **Owner step.** Copy `<dir>` to the PVC at `/var/lib/factory/home`. The server must not run while you copy.

3. **Owner step.** Stop the laptop manager. Start the server (`replicas: 1`).

4. Set `FACTORY_SERVER` on the laptop for the CLI and the console.

5. Check the server home:
   - The count of `runs/` directories is the same before and after a `rollout restart`.
   - The `DONE` count in each `runs/<id>` log is the same before and after a `rollout restart`.
   - `server-lease.json` names one holder for a full minute. The second pod logs `lease held by`.
   - Local mode on a home with one herdr rig and one AX rig works as before.

The reports in the outbox are not lost. They are not doubled. The replay count of each task is in `runs/<id>/<task>.seen`. That file moves with the run directory.

## The way back

1. **Owner step.** Scale the server to 0: `kubectl -n factory scale deployment factory-server --replicas=0`.

2. **Owner step.** Copy the home from the PVC, or from its backup, to a laptop directory `<dir>`.

3. Run `factory home join <dir> --dry-run`.

   Then run `factory home join <dir>`.

   The command copies the runs back. It adds the rigs to `rigs.json` with their laptop repo paths. It removes `home-split.json` last.

   It refuses if a run id or a rig name already exists in the local home.

4. Unset `FACTORY_SERVER`.

5. Run `bin/factory-up`. The laptop manager runs a tick for every rig again.

## Known limits

- The memory store is copied at the split. The two copies then differ (claude-factory-4z8f).
- The run `worktree` paths in a moved `run.json` stay as they were. A live AX run keeps its worktree in the AX task.
- Quickstart 4 to 7 on a live namespace need the owner steps above. The tests of this change use temporary homes only.

See also [remote-runner.md](remote-runner.md).
