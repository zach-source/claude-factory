# Implementation Plan: Beads are required and checked

**Branch**: `spec/002-multi-factory-beads` | **Date**: 2026-10-14, cut down 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-multi-factory-beads/spec.md`. Decisions and the bd facts they rest on: [research.md](research.md).

## Summary

Make beads a requirement. `rig add` checks the beads setup and stops at the first failure with its fix. `factory beads doctor [rig]` runs the same checks without a change. A run in a repo without `.beads` is refused. The multi-factory design (identity, claim protocol, presence, steward, takeover) is deferred. See the spec.

## Technical Context

**Language/Version**: TypeScript on Bun (as today)

**Primary Dependencies**: `bd` (beads, Dolt-backed). The minimum version is one constant. See the Assumptions in the spec.

**Storage**: `rigs.json` gets one new optional field, `Rig.beadsLocal`. Nothing else is stored.

**Testing**: `bun test`. The checks take a runner function for `bd`, so the tests need no `bd` and no Dolt remote.

**Constraints**: The machine is often heavily loaded. A bd call can take a minute, so each check has a 60-second limit. The checks never run in the 5-second tick. They run only from `rig add` and `beads doctor`.

**Scale/Scope**: 4 to 6 tasks. About 10 rigs.

## Constitution Check

`.specify/memory/constitution.md` is still the unfilled template, so there are no project gates. The repo's working rules apply: the smallest change that works, pure decisions apart from I/O (each check is a pure function of the output of one `bd` call), and no new tool. Pass.

## What exists today

| Item                                           | Where                                                        | State                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `.beads` check in `rig add`                    | `defineRig`, `src/cli.ts`: `hasBeads(repo)` then `fail(...)` | Done. It already gives the `bd init` fix. Keep it as check 2 |
| `hasBeads`                                     | `src/beads.ts`                                               | Done. Reuse it                                              |
| `Rig.beadsRemote`                              | `src/cli.ts`                                                 | Done. It is the `beads-remote` plugin's remote. Do not change it |
| `bd` version check, store check, remote checks | none                                                         | New                                                         |
| `factory beads doctor`                         | none (`factory beads` with no subcommand is the internal pass that `kickBeads` starts) | New. Keep the no-subcommand pass |
| `--beads-local`, `Rig.beadsLocal`              | none                                                         | New                                                         |
| No-beads paths                                 | `beadFor` returns `{ goal }`. `tracking()` has a checklist branch. The README says "Without `.beads/`, runs keep task lists in their reports instead" | Remove (FR-016) |
| `docs/beads.md`                                | exists (US5, FR-019)                                         | Done. Update for FR-014 to FR-016 and for the deferral      |

## Design

### 1. Checks (`src/beadscheck.ts`, new)

One pure module. A check is `{ name, result: 'ok' | 'warn' | 'FAIL', detail, fix }`. Each check takes the output of one `bd` call, so it is a pure function and the tests need no `bd`. A runner that calls `bd` with a 60-second limit sits at the edge.

| #   | Check             | Source                                                 | Fix on failure                                                                                                                       |
| --- | ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `bd` version      | `bd --version`, at least `MIN_BD`                      | Install or upgrade `bd`. Put it first on `PATH`                                                                                      |
| 2   | `.beads` exists   | `hasBeads(repo)`                                       | `bd init` in the repo                                                                                                                |
| 3   | Store answers     | `bd ping`, 60 s                                        | `bd dolt start` (server mode) or `bd doctor`                                                                                         |
| 4   | Dolt remote       | `bd dolt remote list`, skipped for a local rig         | `bd dolt remote add origin <url>`, or `--beads-local` for a rig that only this factory will work. A remote is necessary for a second factory or for AX workers |
| 5   | Remote has data   | `bd dolt pull` does not say "not found on remote"      | `bd dolt push` once, to seed the remote                                                                                              |

Rules:

- Messages name the fix. Each `FAIL` line has the command to run.
- A failed check stops `rig add` at that check (later checks need the earlier ones). `beads doctor` runs every check it can and marks the rest `skipped`.
- A rig with `beadsLocal` skips checks 4 and 5. Doctor prints `local rig: no remote` for it.
- Phase 0 pins the exact output of `bd --version`, `bd dolt remote list` and the "not found on remote" message in a test, as the cut plan did. If a message differs from the one here, the test changes, not the design.

### 2. `rig add` (FR-014)

- `defineRig` calls the checks in order and calls `fail(<detail> + <fix>)` on the first `FAIL`. The existing `.beads` line becomes check 2.
- `--beads-local` goes in the `rig add` usage text and in the options. It sets `Rig.beadsLocal = true`.
- A rig that exists before this change is not checked again. Doctor reports it.

### 3. `factory beads doctor [rig]` (FR-015)

- A new subcommand in the `case 'beads'` branch of `src/cli.ts`. With no argument it checks every rig in `rigs.json`. With a name it checks one.
- One line per check: `ok`, `warn` or `FAIL`, the check name, the detail and the fix. It writes nothing: no `bd` write, no `rigs.json` write.
- Exit code 0 when no check is `FAIL`, else 1.
- A pre-existing rig with no remote and no `beadsLocal` gets `warn`, not `FAIL`.

### 4. Init beads for a run without `.beads` (FR-016)

- `beadFor` runs `bd init --local` in a repo without `.beads` and prints one line that says so. Then it files the run's bead as usual. If the init fails, it calls `fail` with the error and the `bd init` fix. This covers `factory start` and `factory fork`.
- `tracking()` loses its checklist branch. A run always has a bead.
- The README sentence "Without `.beads/`, runs keep task lists in their reports instead" goes away. The usage text "In a repo with .beads, every run works a bead" becomes "Every run works a bead".
- Not changed: the sweeps guard (the `no .beads directory` message in the sweeps pass). It is a related path that already skips such a rig.

### 5. Docs

- `docs/beads.md`: add `--beads-local` and `factory beads doctor` to the setup section and to the problem table. Replace the line that says that several factories on one rig are "designed in specs/002 and not built yet" with a line that says this is deferred.
- `README.md`: remove the no-beads sentence. Add `beads doctor` to the command list.
- `docs/onboarding.md`: replace "The multi-factory spec reads bd 1.3.0" with the pinned minimum.

## Files to change

| File                               | Change                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/beadscheck.ts`                | New. Checks, `MIN_BD`, the runner                                                            |
| `src/beadscheck.test.ts`           | New. Each check, for ok, warn and FAIL, with a fake runner                                   |
| `src/cli.ts`                       | `defineRig` and its usage text, `Rig.beadsLocal`, `beads doctor`, `beadFor`, `tracking()`, usage text |
| `src/cli.test.ts`                  | `rig add` failures (no `.beads`, old `bd`, no remote, unseeded remote), `--beads-local`, doctor line format, `start` in a bare repo runs `bd init --local` |
| `Dockerfile.server`                | `BD_VERSION` 1.3.0 to 1.3.2                                                                  |
| `README.md`, `docs/beads.md`, `docs/onboarding.md` | As in section 5                                                              |

## Phases and tasks

| Phase | Work                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------- |
| 0     | Pin the output of `bd --version`, `bd dolt remote list` and the unseeded-remote message in a test |
| 1     | `src/beadscheck.ts` and its tests                                                                 |
| 2     | `rig add` checks and `--beads-local` (FR-014)                                                     |
| 3     | `factory beads doctor` (FR-015)                                                                   |
| 4     | Init beads for a run without `.beads` (FR-016)                                                            |
| 5     | Docs, and the public-repo check                                                                   |

## Owner decisions (2026-11-09)

1. **Minimum `bd`:** `MIN_BD` is 1.3.2, the worker pin. Raise `BD_VERSION` in `Dockerfile.server` from 1.3.0 to 1.3.2 in the same change.
2. **A bare repo:** `factory start` runs `bd init --local` there (FR-016). It does not refuse.
