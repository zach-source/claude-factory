# Research: Beads are required and checked

What `bd` does that the checks depend on, and the decisions that follow. The cut spec (2026-11-09) keeps only these. The bd facts about claims, leases and replicas belong to the deferred multi-factory design. They are in the git history of this file.

## bd facts

| #   | Fact                                                                                                                                                       | Source                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| B1  | `bd --version` prints the version. The repo pins `bd` 1.3.2 for workers (`Dockerfile.worker`) and 1.3.0 for the server image (`Dockerfile.server`).        | `Dockerfile.worker`, `Dockerfile.server`                    |
| B2  | A push from a store that lacks the remote's latest commits is refused until it pulls. A remote with no data answers "not found on remote" to a pull.       | `docs/remote-runner.md` (measured on AX), `docs/beads.md`   |
| B3  | The first `bd` on `PATH` must match the repo's beads schema. A worker with another `bd` fails with schema errors.                                          | `docs/onboarding.md`, `docs/beads.md` (problem table)       |

Not yet verified (Phase 0 of the plan pins each one in a test): the exact output of `bd --version` and `bd dolt remote list`, and the exact "not found on remote" message.

## Decisions

### D1. Checks stop at the first failure in `rig add`

**Decision**: `rig add` runs the checks in order (bd version, `.beads`, store answers, remote, remote has data) and stops at the first `FAIL`. The message names the fix.

**Why**: Each check needs the one before it. A store check on a repo with no `.beads` only repeats the first error. One clear fix at a time is easier to follow than a list.

### D2. `beads doctor` runs all the checks it can and writes nothing

**Decision**: Doctor prints one line per check and marks a check `skipped` when an earlier one failed. It never writes to `bd` or to `rigs.json`.

**Why**: A person runs doctor to learn what is wrong. A tool that fixes things by itself can hide the cause. The fix is a command that the person runs.

### D3. A remote is required unless the rig is local

**Decision**: A rig with no Dolt remote fails `rig add` unless `--beads-local` is given. `--beads-local` records `Rig.beadsLocal` and skips the remote checks.

**Why**: A second factory or an AX worker cannot work a rig with no remote. The person must choose "local" on purpose. The message says why a remote is necessary.

**Alternative rejected**: A warning only. A rig with no remote then looks fine until a worker fails to bootstrap its store.

### D4. Error messages name the fix

**Decision**: Every `FAIL` and every `rig add` failure has the command or step that fixes it: `bd init`, `bd dolt start`, `bd doctor`, `bd dolt remote add origin <url>`, `bd dolt push`, `--beads-local`, or "upgrade `bd`".

**Why**: SC-005. A message with no fix sends the person to the source code.

### D5. Existing rigs get a warning, not a failure

**Decision**: Doctor reports a rig that has no remote and no `beadsLocal` as `warn`. Dispatch for it does not change.

**Why**: The rig worked before this change. A new failure here would stop working rigs for a check that they never ran.
