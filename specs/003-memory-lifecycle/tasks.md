---
description: "Task list for the memory lifecycle (compress, age, learn)"
---

# Tasks: Memory lifecycle — compress, age, learn

**Input**: Design documents from `specs/003-memory-lifecycle/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, quickstart.md

**Tests**: These are required. The project works test-first, so each task starts with a failing table test or CLI test, then the code.
**Tracking**: Beads are the tracker. Each task names its bead. Top epic: `claude-factory-3u1`. Run `bd ready` to see what can start.

## Format: `[ID] [P?] [Story] Description (bead)`

## Phase 1: Setup

- [x] T001 Write generic memory and run fixtures (notes of each kind, a usage history, done/aborted/active runs, and a journal with one failure class repeated over 3 runs) in `src/fixtures/memory-lifecycle/`. Use no private names (shared by all stories; part of the first bead to start).

## Phase 2: Foundational

- [x] T002 [US5] `factory memory eval --self [n] [--seed s]` in `src/memory.ts` `evaluate()` and in `src/cli.ts`, to give a baseline before any rank change (claude-factory-9l7)

**Checkpoint**: the baseline recall@5 and MRR are recorded in the bead before US3 starts.

## Phase 3: User Story 1 — the factory home stays small and its records survive (P1) 🎯 MVP

**Goal**: bounded disk use, versioned usage, no mass archive. **Independent test**: quickstart steps 1, 5 and 9.

- [ ] T003 [P] [US1] Write the pure `gcPlan()` and `factory gc [--days 7] [--dry-run]` beside `case 'rm'` in `src/cli.ts`. Run it hourly from the tick, and remove launch scripts whose pane is gone. If herdr is unreachable, remove nothing (claude-factory-503.1)
- [ ] T004 [P] [US1] Drop `.usage.jsonl*` from the memory `.gitignore` in `src/cli.ts` `dream()`, and run `compact()` before each commit so the repo is clean after a dream (claude-factory-503.3)
- [ ] T005 [US1] In `src/memory.ts` `decide()`/`applyTiers()`: archive a note never shown at 14 days, cap each pass at 25 (oldest first), and log the plan to `dream.log` before applying. Archive nothing while the usage history is under 14 days (claude-factory-503.2)

## Phase 4: User Story 2 — notes are dense and retire on time (P1)

**Goal**: only facts, rules or recipes get in, and time-bound notes retire themselves. **Independent test**: quickstart steps 2–4.

- [x] T006 [US2] A pure `gate()` plus frontmatter `kind` (`fact`|`rule`|`recipe`) and `until` in `src/memory.ts` `parse`/`format`. `memory add --kind/--until` exits 2 with usage text, in `src/cli.ts` (claude-factory-3u1.1.1)
- [x] T007 [US2] A duplicate add logs `confirmed`; add `--supersedes <path>` (writes `superseded:` and logs `contradicted`), in `src/cli.ts` ~3689 and `src/memory.ts` `use()`/`tallyRaw()` (claude-factory-3u1.1.2)
- [x] T008 [P] [US2] A per-topic cap of 15 in `src/memory.ts` `dreamPrompt()` and `applyTiers()` (claude-factory-3u1.1.3)
- [ ] T009 [US2] Expiry from `until:`: a `retire` decision fed by `closedBeads()`, PR state (`src/prs.ts`) and dates. If a lookup fails, keep the note and flag it (claude-factory-3u1.1.4)
- [x] T010 [P] [US2] Document the new flags in `src/worker-system.md`, the README memory section and the CHANGELOG (claude-factory-3u1.1.5)

## Phase 5: User Story 3 — memory ranks and ages by real use (P2)

**Goal**: one decay score drives search ranking and the tier decisions. **Independent test**: quickstart step 6. **Needs**: US1 and US2 (the beads hold these dependencies).

- [x] T011 [US3] Write `activation(events, now)` in `src/memory.ts`. Weights: helped 1.0 (0.3 when `ok=false`), confirmed 1.0, shown 0.15, contradicted −1.0. Use a 90-day window; folded lines keep their events (claude-factory-3u1.2.1)
- [x] T012 [US3] `decide()` uses θm/θa/θc thresholds in place of the 7/30-day limits, with boundary table tests (claude-factory-3u1.2.2)
- [x] T013 [US3] A bonus of at most 0.02 in `rank()`. `eval --self` must not regress (claude-factory-3u1.2.3, needs 9l7)
- [x] T014 [P] [US3] `memory helped` requires `--from` or takes `FACTORY_RUN`/`FACTORY_STATION` from the env, in `src/cli.ts` (claude-factory-p11)
- [x] T015 [US3] Outcome-weighted helps: the dream sets `ok` from the journal, in `src/cli.ts` `dream()` (claude-factory-3u1.2.4)

## Phase 6: User Story 4 — repeated lessons become behavior (P2)

**Goal**: the dream proposes rules, and the manager or a person installs or rejects them. **Independent test**: quickstart step 7. **Needs**: US3.

- [x] T016 [US4] A pure `failureClasses()`, a dream prompt section, and at most 3 `.proposals/<name>.md` per dream (claude-factory-3u1.3.1)
- [x] T017 [US4] `factory proposals` list/install/reject plus manager mail, in `src/cli.ts`. A rung above core files a bead and never edits factory code (claude-factory-3u1.3.2)
- [x] T018 [US4] A `demote` decision for a core fact that keeps being contradicted, in `src/memory.ts` (claude-factory-3u1.3.3)

## Phase 7: User Story 5 — the owner can tell whether memory works (P3)

**Goal**: the numbers SC-003 to SC-005 need. **Independent test**: quickstart step 8.

- [x] T019 [P] [US5] Eval categories (update/temporal/abstain) in `src/memory.ts` `evaluate()` (claude-factory-3u1.4.1)
- [x] T020 [P] [US5] Per-dream lifecycle metrics in `dream.log`, in `src/cli.ts` (claude-factory-3u1.4.2)

## Phase 8: Polish

- [ ] T021 Run the quickstart end to end on a copy of a factory home; record the before/after numbers (disk, % notes with `kind`, % citing a bead/PR without `until`, recall@5) on `claude-factory-3u1`
- [ ] T022 `npm test`, typecheck, and prettier on the touched lines only

## Dependencies

- Setup T001, then T002 (baseline). US1 and US2 can run in parallel after T001.
- US3 needs US1 (tracked usage) and US2 (confirmed/contradicted events). T013 also needs T002.
- US4 needs US3. US5's T019 and T020 can run at any time.

## Parallel examples

- US1: T003 and T004 touch different functions; T005 follows T004 (usage must be tracked before the never-shown rule matters).
- US2: T008 and T010 run alongside T006, T007 and T009.
- US3: T014 runs alongside T011 and T012.

## Implementation strategy

MVP = Phase 3 (US1). It frees about 200 MB and removes the mass-archive risk on its own. Then US2, then release. US3 and US4 follow, measured against the T002 baseline.
