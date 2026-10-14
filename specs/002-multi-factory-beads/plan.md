# Implementation Plan: Several factories on the same rigs, with beads as a requirement

**Branch**: `spec/002-multi-factory-beads` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-multi-factory-beads/spec.md`. Decisions and the bd facts they rest on: [research.md](research.md).

## Summary

Give each factory a generated id, and put it in every bd actor and branch name, so that a factory can tell its own work from another factory's work. Confirm each claim by pushing it to the rig's Dolt remote before a worker starts: the remote orders the claims, and the first push wins. Sync every 2 minutes with back-off, publish a presence record per factory, and give each rig one steward for its sweeps and for labels on pull requests that are not on a factory branch. Make beads a requirement: `rig add` checks the setup, `factory beads doctor` reports on it, and the no-beads paths go away. `docs/beads.md` is the guide.

## Technical Context

**Language/Version**: TypeScript on Bun (as today)

**Primary Dependencies**: bd 1.3+ (beads, Dolt-backed), Dolt remotes (remotesapi, DoltHub or git origin), herdr, gh

**Storage**: `<home>/factory.json` (new), `<home>/sync.json` (extended), each rig's beads store (`bd kv` keys, issues)

**Testing**: `bun test`. New bd tests use two embedded stores in temporary directories and a `file://` Dolt remote, and are skipped when `bd` is missing.

**Target Platform**: macOS and Linux hosts that run a factory, plus AX VMs as workers

**Project Type**: CLI and runner (`bin/factory`, `src/cli.ts`)

**Constraints**: The machine is often heavily loaded. A bd call can take a minute, so the design adds no bd call to the 5-second tick, and remote calls happen only in the beads pass.

**Scale/Scope**: 2 to 4 factories per rig, up to about 10 rigs, up to 16 busy runs per factory

## Constitution Check

`.specify/memory/constitution.md` is still the unfilled template, so there are no project gates. The repo's working rules apply instead: the smallest change that works, pure decisions apart from I/O (the claim batch, ownership and back-off are pure functions with tests), and no new tool. Pass.

## Project Structure

### Documentation (this feature)

```text
specs/002-multi-factory-beads/
├── spec.md
├── research.md   # bd facts and the decisions D1-D8
└── plan.md       # this file
docs/beads.md     # the guide (FR-019), in this change
```

### Source Code (repository root)

```text
src/
├── identity.ts        # new: factory.json, actor grammar, ownership tests (pure + one file read)
├── identity.test.ts   # new
├── beads.ts           # claim batch, push/pull, presence, steward, kv
├── beads.test.ts      # extended: two stores + file:// remote
├── cli.ts             # dispatch, beat, track, label pass, sweeps, rig add, beads doctor/takeover, stop/resume
├── cli.test.ts        # extended: pure helpers
├── machine.ts         # a lost-claim hold reason (no new state)
└── worker.ts          # no change: BEADS_ACTOR arrives from the launch env
mod/hooks/view.ts, views.tsx   # board: factories per rig, beads held elsewhere
docs/beads.md, docs/remote-runner.md, README.md
```

## Design

### 1. Identity

`src/identity.ts`:

- `identity(home)`: reads `<home>/factory.json`, and writes it first when it is missing (`id`: 6 characters of `abcdefghijkmnpqrstuvwxyz23456789` from `crypto.getRandomValues`; `name`: `<user>-<short host>` lowercased to `[a-z0-9-]`; `created`).
- `factory init <dir> [--name n]` writes it. `factory init --new-id` (in a home) replaces the id. It refuses while runs are live, because their claims carry the old id.
- Actor grammar:

| Writer                                        | Actor                          | Example                                    |
| --------------------------------------------- | ------------------------------ | ------------------------------------------ |
| The factory (dispatch, queue, sweeps, labels) | `factory:<id>`                 | `factory:k3x9qa`                           |
| A run (its claim, its comments, its settle)   | `factory:<id>/<run>`           | `factory:k3x9qa/lifecycle-mg81c2x4a7`      |
| A station's worker (local or AX)              | `factory:<id>/<run>/<station>` | `factory:k3x9qa/lifecycle-mg81c2x4a7/plan` |
| Legacy run (created before this feature)      | `factory/<run>`                | `factory/lifecycle-mf2k1a9z3b`             |

- `ownerOf(actor, self, localRuns)` returns `'self'`, `{ factory: id }`, `'person'` or `'unknown-factory'` (a legacy `factory/<run>` whose run is not in this home). It is pure, and every guard below uses it.
- Branches: `factory/<id>/<run>`. `run.json` already stores `branch`, so legacy runs keep `factory/<run>`. `prOwner` and `prs()` compare against `run.branch` and the own prefix, and stop rebuilding the branch from the run id.
- Each run stores its `actor` in `run.json` at creation. `actorOf(run)` reads it, so a legacy run (no field) keeps `factory/<run>`.

### 2. Claim protocol (D2)

All in the beads pass, which already holds `beads.lock`, per rig:

```text
candidates = dispatchable(local bd ready) - owned - with open children - over cap
if none or no room: done (no remote call)
if rig has a Dolt remote:
  attempt up to 3 times:
    pull                                   # bd dolt pull, or the beadsRemote SQL path
    candidates = recompute from bd ready   # beads claimed elsewhere drop out
    claimed = [c for c in candidates[:room] if bd update c --claim as factory:<id>/<newRunId>]
    push                                   # bd dolt push, or the beadsRemote SQL path; NOT bd sync
    ok:        confirmed = claimed; break
    rejected:  bd unclaim each in claimed; continue   # back to base values, so the remote's claim stands
    other err: bd unclaim each in claimed; record a sync failure (back-off); confirmed = []; break
else:
  confirmed = [c for c in candidates[:room] if bd update c --claim]
for each confirmed: createRun (on failure: defer the bead, as createTracked does today)
```

`createTracked` splits into `claimBatch` (in `src/beads.ts`, the loop above with the bd and remote calls injected, so the order can be tested without bd) and `createRun`. `factory start <bead>` uses the same batch of one.

A push is "rejected" when bd reports that the remote has commits the store lacks. Phase 0 pins the exact signal (exit code or message) in a test.

### 3. Heartbeat and lost claims (D8)

- `beat` is unchanged in cadence (2 min) and in the order it tries things (heartbeat, then re-claim, then show).
- When `heartbeat` returns false, `track.json` gets `lost: { by: <assignee>, at }`. From then on, `track` writes nothing to the bead. The next tick holds the run in `stuck` with the question "bead `<id>` is now held by `<owner>`: retry (take it back with `factory beads takeover --force`) or abort". This is the same Interview path as a repeated silent failure (`src/machine.ts`). An abort with `lost` set leaves the bead alone.

### 4. Sync cadence and back-off (D6)

- `SYNC_MS` becomes 2 min. `sync.json` per rig becomes `{ at, error?, failures }`. The next sync is due at `at + min(2 * 2^(failures-1), 30)` min (2 min when `failures` = 0).
- A pure `syncDue(entry, now)` decides. The claim pull and push in section 2 count as a sync: success resets `failures`, and a transport failure adds one.
- After the third failure in a row, the board row turns into manager mail (once per streak), with the last error and `factory beads doctor <rig>`.
- `bd sync` exit 2 or 4 (a conflict, or a stuck working set) is not transient: no back-off growth, the error stands, and the mail goes out at once with `bd conflicts list`.

### 5. Presence and copied homes (D3, D4)

- `beads.presence.write(rec)` = `bd kv set factory.presence.<id> <json>`, at most every 10 min per rig from the beads pass, and at once on `stop`, `resume`, `rig add` and `rig rm`. Record: `{ name, user, host, state: running|stopping|paused, version: <git short sha of claude-factory>, at }`.
- `beads.presence.list()` = `bd kv list`, filtered to `factory.presence.`.
- Before dispatch, a factory reads its own key. Another `host` with `at` in the last 30 min stops dispatch on that rig and shows the D4 error.
- The board's rig row gets `factories: [{ name, state, quietMin }]` and `heldElsewhere: n` (in-progress beads whose owner is another factory). The backlog lists them under "held by other factories".

### 6. Steward and pull request labels (D5)

- `beads.steward.get()` and `set(id)` on `factory.steward`.
- `sweep()`: for each rig, skip unless the steward is this factory. If unset, set it and continue.
- `labelPass()`: classify each PR by its `headRefName` with `ownerOf`:
  - own branch: as today (mail the run, or rework, or close and abort);
  - another factory's branch (including a legacy `factory/<run>` that is not in this home): skip;
  - not a factory branch: only the steward acts.
- `factory rig steward <rig>`: set the key to this factory's id and print the old value. `factory rig rm` clears the key when it holds it.

### 7. Rig-wide cap

- Optional `factory.max_runs` in the rig's `bd kv`. `factory rig cap <rig> <n|none>` sets it.
- `rigWideRoom(max, inProgress)`: `inProgress` counts top-level in-progress beads whose assignee `ownerOf` reads as a factory (any id, or legacy). The result is read after the claim pull. `room()` takes the smaller of this and the factory's own room. This is a soft cap: two factories that push at the same moment can pass it by one run each, until the next pass.

### 8. Takeover (FR-013)

`factory beads takeover <rig> <bead> [--force]`:

1. Pull. Show the bead. Refuse if its owner is this factory or a person (a person's claim is theirs).
2. Read the holder's presence. Refuse without `--force` if it was seen less than 2 h ago, or if its state is `paused` (a stopped factory is not dead). Print when it was seen.
3. `bd comment` with the holder, its last presence, and its branch `factory/<id>/<run>` (with `git ls-remote origin` to tell whether the branch exists on the origin). Then `bd unclaim <bead> --force --if-assignee <holder>`, then push. The bead is ready again, and the next dispatch (of any factory) takes it. The new run's brief already lists the commits that name the bead.

### 9. Stop and resume (FR-017)

`factory stop` and `resume` write presence at once (`stopping`, then `paused`, then `running`). The beads pass keeps running while halted, as today (heartbeats, presence, background sync). Dispatch, sweeps and the label pass stay off while halted, as today. A paused steward keeps the role.

### 10. Beads as a requirement

- `defineRig` (`rig add`) checks, in order, and stops at the first failure with its fix:
  1. `bd --version` is at least 1.3.0. Fix: upgrade bd.
  2. `.beads` exists. Fix: `bd init` in the repo.
  3. `bd ping` answers within 60 s. Fix: `bd dolt start` (server mode) or `bd doctor`.
  4. `bd dolt remote list` shows a remote, unless `--beads-local`. Fix: `bd dolt remote add origin <url>`, or `--beads-local` for a rig that only this factory will ever work.
  5. The remote has data (`bd dolt pull` does not say "not found on remote"). Fix: `bd dolt push` once.
  6. Warn (do not fail) when a store that has a remote has no `node_id` (`bd config get node_id` and `BEADS_NODE_ID`). Fix: `bd config set node_id <machine>`, unless the store is a shared Dolt server's.
- `Rig` gets `beadsLocal?: true`. `rig add` writes it, and dispatch skips the claim push for such a rig.
- `factory beads doctor [rig...]` runs the same checks plus: own presence (D4), the other factories with their state and quiet minutes, the steward and whether it is quiet, the in-progress beads held by quiet factories, `bd conflicts list`, the sync back-off state, and the beads directory mode (bd warns when it is not 0700). One line per check: `ok`, `warn` or `FAIL`, and a fix. It writes nothing.
- `factory beads sync [rig...]`: one pull and push now, outside the timer, reporting the result.
- `factory beads` with no subcommand stays the internal pass that `kickBeads` starts.
- Remove the no-beads paths: `beadFor` fails instead of returning `{ goal }`, `tracking()` loses its checklist branch, and `start` on a repo without `.beads` fails with the `bd init` fix. The README sentence "Without `.beads/`, runs keep task lists in their reports instead" goes away.

### 11. AX workers

There is no change in `src/worker.ts`. `BEADS_ACTOR` becomes `factory:<id>/<run>/<station>` through `actorOf(run)` at launch. VMs never claim. The comment that `overwritten()` puts on an issue says "the remote's version was kept" instead of "the VM's", because the remote can now hold another factory's writes too.

## Topologies

| Topology                                            | Stores                                                                                             | Claims                                                 | Notes                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One person, two machines (recommended setup)        | One store per machine, one Dolt remote per rig, `node_id` set per machine                          | Push-confirmed (D2)                                    | Each machine has its own factory home and id. The first factory to sweep becomes the steward. Caps are per machine, plus an optional rig-wide cap.                                             |
| Two people, one repo                                | As above. Each person has remote credentials of their own                                          | Push-confirmed                                         | Actors and presence show whose factory holds what. People's own claims are never touched. The steward is whoever is set first. Move it with `rig steward`.                                     |
| Laptop and AX workers (exists)                      | The laptop's store plus a clone per VM, through the rig's remote (`beadsRemote` or the git origin) | The laptop's factory claims. VMs never claim           | VM pushes move the remote, so the laptop's claim push is sometimes refused and retried (section 2). A second factory with AX workers on the same rig shares the remote with no extra setup.    |
| Two homes on one machine, or one shared Dolt server | One store (one replica)                                                                            | `--claim` alone (B1, B4). With no remote, no push step | Leases are global, so a local `bd reclaim` covers every factory, but factories still reclaim only their own actors. herdr is shared, and `reap` already touches only its own runs' workspaces. |

## Migration

No step for the person:

1. The first runner start after the upgrade writes `factory.json` for an existing home.
2. Live runs keep their legacy actor and branch (they have no `actor` field). Heartbeats, settles and label actions match them through `ownerOf`'s legacy rule (a `factory/<run>` whose run is in this home).
3. Writes with the bare actor `factory` (dispatch, queue, `syncRigBeads` comments, the dream's reads) become `factory:<id>`.
4. Background sync goes from 5 to 2 min. Rigs with no remote keep working as single-factory rigs until the person adds a remote or marks them `--beads-local` (the board warns until then, and `rig add` requires one or the other for new rigs).
5. The steward key is unset on existing rigs. The current factory sets it on its next sweep, so sweeps go on as before.

A second factory joins a rig only after its first factory has upgraded. An old factory does not confirm its claims, and does not know the steward key.

## Phases and tasks

Each phase ships on its own and leaves a single-factory setup working as before. Smallest safe step first.

### Phase 0 - Pin bd's behavior in tests (no behavior change)

| #   | File                | Task                                                                                                                                                             |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | `src/beads.test.ts` | A fixture: two embedded stores in temporary directories (`BEADS_DOLT_SHARED_SERVER=0`), one `file://` Dolt remote, seeded once. Skip when `bd` is missing.       |
| T02 | `src/beads.test.ts` | Push from a stale store is refused. Record the exit code and the message that tell it apart from an unreachable remote (a `file://` path that does not exist).   |
| T03 | `src/beads.test.ts` | A claims and pushes. B claims the same bead, its push is refused, B unclaims and pulls: B sees A as the assignee, and `bd conflicts list` is empty.              |
| T04 | `src/beads.test.ts` | `bd kv set` in A, push, pull in B: B reads the value. If not, switch D3 and D5 to their bead fallback before Phase 3.                                            |
| T05 | `src/beads.test.ts` | An actor `factory:abc234/run-1/plan` is accepted by `--claim`, `heartbeat`, `comment` and `unclaim --if-assignee`, and comes back unchanged in `bd show --json`. |

### Phase 1 - Identity and ownership guards

| #   | File                           | Task                                                                                                                                                                        |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T10 | `src/identity.ts`              | `identity(home)`, `newId()`, `actorFor(self, run, station?)`, `branchFor(self, run)`, `ownerOf(actor, self, localRuns)`, `branchOwner(ref, self, localRuns)`.               |
| T11 | `src/identity.test.ts`         | The grammar table above, the legacy cases, a foreign id, a person's name, and a branch that is not a factory branch.                                                        |
| T12 | `src/beads.ts`                 | `actorOf` reads the run's stored actor (legacy fallback `factory/<run>`). Remove the bare `'factory'` default from the callers.                                             |
| T13 | `src/cli.ts`                   | `factory init [--name n]` writes `factory.json`. `init --new-id`. `createRun` stores `actor` and uses `branchFor`. Every `beads(repo, 'factory')` call uses `factory:<id>`. |
| T14 | `src/cli.ts`                   | `prOwner`, `prs()` and `labelPass` classify by `branchOwner`, and skip other factories' branches.                                                                           |
| T15 | `src/cli.ts`, `src/machine.ts` | Lost claim: `track.json` `lost`, `track` skips writes, the run is held in `stuck` with the retry-or-abort question, and abort skips the settle.                             |
| T16 | `src/cli.ts`                   | The AX launch sets `BEADS_ACTOR` from `actorOf(run)`. `overwritten()` says "the remote's version".                                                                          |
| T17 | `src/cli.test.ts`              | `labelAction` with ownership, `prOwner` with both branch forms, and a lost-claim run that is not settled.                                                                   |

### Phase 2 - Push-confirmed claims and sync cadence

| #   | File                | Task                                                                                                                                                                                                          |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T20 | `src/beads.ts`      | `remote(rig)`: `pull()` and `push()` through `bd dolt` or the `beadsRemote` SQL path (`rigBeadsSync` moves here from `src/cli.ts`). They return `ok`, `rejected` or `error`.                                  |
| T21 | `src/beads.ts`      | `claimBatch(candidates, room, { pull, push, claim, unclaim, ready })` as in section 2. Pure apart from the injected calls.                                                                                    |
| T22 | `src/beads.test.ts` | `claimBatch` with fakes: rejected then ok, rejected 3 times, error, no remote. Then the real two-store race from T03 through `claimBatch`: 50 beads, two batches interleaved, no bead claimed twice (SC-001). |
| T23 | `src/cli.ts`        | `dispatch` uses `claimBatch`, then `createRun`. `createTracked` keeps its signature for `start` and the sweeps, and calls a batch of one.                                                                     |
| T24 | `src/cli.ts`        | `SYNC_MS` = 2 min, `sync.json` `failures`, `syncDue()`, manager mail after 3 failures, exit codes 2 and 4 handled as in section 4.                                                                            |
| T25 | `src/cli.test.ts`   | `syncDue` back-off table.                                                                                                                                                                                     |

### Phase 3 - Presence, steward, rig cap, takeover

| #   | File                                                     | Task                                                                                                                       |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| T30 | `src/beads.ts`                                           | `presence.write/list`, `steward.get/set/clear`, `rigMax.get/set` on `bd kv` (or the bead fallback from T04).               |
| T31 | `src/cli.ts`                                             | Presence from the beads pass (10 min) and from stop, resume, rig add and rig rm. Dispatch refuses on a copied home (D4).   |
| T32 | `src/cli.ts`                                             | `sweep()` steward check. `labelPass` acts on non-factory PRs only as steward. `rig steward`, and `rig rm` clears the role. |
| T33 | `src/cli.ts`                                             | `rigWideRoom`, `rig cap`.                                                                                                  |
| T34 | `src/cli.ts`                                             | `factory beads takeover` (section 8).                                                                                      |
| T35 | `src/cli.ts`, `mod/hooks/view.ts`, `mod/hooks/views.tsx` | Board: factories per rig with state and quiet minutes, `heldElsewhere`, quiet steward warning.                             |
| T36 | `src/cli.test.ts`                                        | `rigWideRoom`, quiet and takeover thresholds, steward decisions (unset, self, other).                                      |

### Phase 4 - Beads as a requirement

| #   | File                                                  | Task                                                                                                                                       |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| T40 | `src/cli.ts`                                          | `defineRig` checks 1-6 and `--beads-local`. `Rig.beadsLocal`.                                                                              |
| T41 | `src/cli.ts`                                          | `factory beads doctor [rig...]` and `factory beads sync [rig...]`. Usage text.                                                             |
| T42 | `src/cli.ts`                                          | Remove the no-beads paths in `beadFor`, `tracking()` and `start`.                                                                          |
| T43 | `src/cli.test.ts`                                     | Doctor line format, and `rig add` failures on a repo with no `.beads`, no remote and an unseeded remote (with the T01 fixture).            |
| T44 | `README.md`, `docs/beads.md`, `docs/remote-runner.md` | Document identity, the claim protocol, cadence, steward, takeover, doctor, and the multi-factory topologies. Remove the no-beads sentence. |

## Open questions for the owner

1. **Pinning work to one factory.** Should a bead labeled `factory@<name>` be dispatched only by that factory (for example, GPU work on the desktop)? It is cheap to add to `dispatchable`. It is not in this plan.
2. **Automatic takeover.** The plan never takes over by itself. Should the manager be allowed to run `takeover` without the person after a long quiet (24 h), when the holder's branch is not on the origin?
3. **Shared memory.** Each factory keeps its own memory and dream. Should factories on one rig share rig-scoped notes, for example through the rig's beads?
4. **Epics with children.** Dispatch skips a bead that has open children, and it skips every child (only top-level beads dispatch). So an epic that a person split into children waits until the manager or the person starts the children one by one. Should dispatch start an epic's ready children as their own runs? This applies with one factory too.
5. **Removing the no-beads path (T42).** This removes `factory start` on a repo without `.beads`. Is that acceptable, or should a bare repo get a `bd init --local` automatically?
