# ADR: Keep parity gaps tied to source tasks

## Context

Run bead: `claude-factory-4px5z`. Base: `069070fb`.
The checkout parity command fails on 10 of 17 front-end rows after a successful `bd dolt pull`.
Nine IDs are absent: `claude-factory-hpmc.15` through `.20`, `.28`, `.29`, and `.30`.
The last ID covers two rows. `bd history claude-factory-hpmc.15` has no history.
This evidence does not prove a purge or a replication defect.

Commit `faee3c1a` added six Herdr gaps. Commits `1053d7aa` and `ea6e6a75` added snapshot and Flow gaps.
The source client tasks `.9`, `.10`, and `.11` remain open in the real issue store.
Task `.10` explicitly owns the six Herdr tabs and screens.
Tasks `.9` and `.11` own the Claude mod and web clients.

`src/parity.ts:22` resolves the data beside the installed source tree.
`Dockerfile.worker:142` and `Dockerfile.server:43` omit that data from their CLI packages.
The manager inherits the worker stage. `flake.nix:36` already includes the data.
The broker installs no full factory CLI and needs no change.

## Decision and design

Correct references through the existing source tasks. Do not reconstruct issue history without source records.
Keep all operations, front ends, reasons, harness rows, and row order unchanged.
Change only the ten affected `bead` fields:

| Old suffix under `claude-factory-hpmc` | Operation and front end | Source task |
| --- | --- | --- |
| `.15` through `.20` | Herdr backlog, mail, rigs, PRs, runners, and worker screen | `claude-factory-hpmc.10` |
| `.28` | `flows.show`, web | `claude-factory-hpmc.11` |
| `.29` | `flows.show`, Claude mod | `claude-factory-hpmc.9` |
| `.30` | `snapshot.show`, web | `claude-factory-hpmc.11` |
| `.30` | `snapshot.show`, Claude mod | `claude-factory-hpmc.9` |

Before the reference change, add scope comments to all three source tasks.
Each comment must name its rows and the old IDs. Link this run and this ADR.
The `.9` and `.11` comments must explicitly add the Flow view and single-snapshot board read to their acceptance scope.
The comments must require client fixture evidence before removal of those gaps.
Do not close or reopen those tasks to satisfy the gate. Do not add dispatch labels.
Use `bd dolt push`, then `bd dolt pull`, and read all three tasks again before the final gate.
If another run closed a source task, inspect its evidence before any change. Do not manufacture an open status.

Add `parity-gaps.json` to the worker and server package COPY lists.
Keep the Nix runtime list intact. Add package checks in `src/dockerfile.test.ts`.
Update the data assertions in `src/parity.test.ts` for the mapping above.
Add a relocated-package smoke test there, with a fresh home and no checkout data fallback.
The smoke test must copy the relevant runtime tree into a test directory and invoke its own `bin/factory parity`.
Strip worker outbox variables and set `FACTORY_SELF_UPDATE=0`, as existing CLI fixtures do.
Tests can use a fake `bd`; final integration evidence must use the real issue store.

No new runtime parser, dependency, option, sync service, or database migration is necessary.
Keep `src/parity.ts`, the pre-push hook, and `.factory/` unchanged.
Do not repair the permission warning or extend harness-gap enforcement in this run.

Rejected alternatives:

- A missing-bead exemption makes the parity gate pass without source work.
- Removal of gap rows hides absent features.
- Fake replacement records under lost IDs invent provenance.
- Nine new tasks duplicate the existing client work and exceed the necessary scope.
- A working-directory fallback hides package defects and can read unrelated gap data.
- A new replication subsystem lacks evidence of a replica defect.

## Acceptance criteria

1. **AC1: Honest references.** Extend `src/parity.test.ts` with names prefixed `4px5z AC1`.
   Assert the exact mapping above and all 17 front-end rows at this base.
   Compare all non-bead fields and all unaffected rows with the base data.
   Preserve the three gc rows and every harness row byte-for-byte in meaning.
   Negative rows: absent IDs remain invalid; no gap disappears; no unrelated bead changes.
   Check the three scope comments with `bd show` and `bd comments` for each source task.

2. **AC2: Self-contained packages.** Add `4px5z AC2` tests in `src/dockerfile.test.ts` and `src/parity.test.ts`.
   Require the data in the worker and server stages and the Nix runtime list.
   Check manager inheritance. Run the relocated CLI with all-open fixture beads and require exit 0.
   Remove only the relocated data file and require exit 1 with zero `bd show` calls.
   The checkout data must not rescue that failure. With the data restored, a closed fixture bead must cause exit 1.
   These checks prove package layout; an image build remains separate evidence.

3. **AC3: Keep the gate fail-closed.** Run `bun test --timeout 30000 src/parity.test.ts src/dockerfile.test.ts`.
   A gap passes only when `bd show` succeeds and returns the requested ID with an accepted open status.
   Allow `open`, `in_progress`, `blocked`, and `deferred`.
   Deny missing IDs, wrong IDs, absent status, closed or unknown status, malformed JSON, timeout, and subprocess failure.
   Check repeated bead IDs once, but report every failed row.
   Retain the existing grammar tests: invalid JSON, shape, keys, types, catalog names, front ends, IDs, reasons, and duplicates fail.
   Add call counters for malformed gap files: rejection must make zero issue-store calls.
   No grammar extension belongs here. Shell parsing, new path inputs, and stricter `bd` reply schemas remain out of scope.

4. **AC4: Real-store integration.** After task comments sync, run `bun /workspace/w/repo/src/cli.ts parity`.
   Run the relocated package's `bin/factory parity` against the same real issue store, without fake `bd`.
   Both must exit 0 and report 17 open gaps at this base.
   Record the Git SHA, package path, command, count, and exit code in the task comment.
   Do not change `/opt/factory` to produce this evidence.
   A successful pull alone, a mocked result, or only a unit-test pass does not satisfy AC4.

5. **AC5: Installed release; must-see-live.** After the normal release, soak must run the installed `factory parity` in a fresh worker.
   Record its package revision, command path, gap count, and exit code 0 against the real issue store.
   The package must contain its own data. No checkout fallback or manual file copy can satisfy AC5.
   This is a post-merge soak criterion, never a pre-merge live access requirement.
   If the package remains old or the command fails, soak must not report healthy.

Concurrent valid gap additions can change the count. Verify must explain each delta against the final merged base.
Do not freeze the entire repository at 17 gaps after later source work changes it.

## Test plan

First commit the AC1 expected mapping and AC2 package assertions as failing tests.
Retain AC3 characterization tests. Confirm the expected failures on the base, with dependencies installed.
Then commit the data repair and package fix in the same PR. The final head must pass all required checks.
Use a committed mutation to prove that omission of the data file fails AC2.
Run `factory mutate` with the exact COPY-line change and the focused package test after the fix commit.
Do not treat a build error as a killed behavioral mutant.

Run `bun install --frozen-lockfile`, the focused command above, `bun run typecheck`, and `bun run test`.
Run `bunx prettier@3.9.9 --check` on changed files, `bun audit`, and the required CI checks on the final SHA.
Run `gitleaks detect --log-opts=origin/main..HEAD` and the factory made-worse gate before handoff.
Use normal image CI for the worker and server artifacts. Report any unavailable image build explicitly.
Do not require real issue-store network access during image construction.

## Risk

The main risk is false scope: a valid issue ID alone does not prove that it owns a gap.
The source-task comments and exact mapping tests make that ownership explicit.
No issue deletion, history rewrite, schema migration, credential change, or live system change belongs in this plan.
The runtime gate and its parser remain unchanged. Existing consumers retain their data format and exit codes.
The package change adds public data beside existing source files. It adds no infrastructure access or permission.
Security-sensitive: no

## Rollout and rollback

Sync source-task comments before the data change reaches other workers.
Merge only after the final checks pass and a person approves the PR.
Use the normal package release. A person must approve any owner-only live command separately.
There are no flags or migrations. Fresh workers receive the packaged data through the normal image release.
Revert a faulty package change through a new PR. Do not restore invalid IDs as a silent rollback.
If a mapping is wrong, keep the gap and correct it to a source task with verified scope.
Keep source-task comments as the audit trail; add corrections instead of removal.

## Observability

Use parity exit codes and the per-row errors. No new metric or log is necessary.
AC4 gives pre-merge integration evidence. AC5 gives the ship run its required installed-package evidence.
No production database, pod log, or metrics query is necessary.

## Tasks

Use three small commits in one PR, in this order. Budget: 90 minutes plus CI wait within the implement pass.

1. Add the failing mapping and package tests, plus the AC3 characterization rows. Check: focused tests fail for the intended defects.
2. Add source-task scope comments and correct the ten bead fields. Check: AC1 and checkout AC4 pass after issue sync.
3. Copy the package data and prove relocation. Check: AC2, AC3, package AC4, mutation, format, typecheck, and required CI pass.

Record comment IDs and commands in task 2. No separate metadata file is necessary.
Ship owns AC5 after merge. Keep all three implementation tasks in this run; no red-check PR is a valid handoff.
