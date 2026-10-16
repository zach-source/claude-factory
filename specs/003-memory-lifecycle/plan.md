# Implementation Plan: Memory lifecycle — compress, age, learn

**Branch**: `003-memory-lifecycle` | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/003-memory-lifecycle/spec.md`

## Summary

Five slices, smallest-risk first:

1. **Retention and safety** (P1): `factory gc`, an archive cap with a logged plan, usage and the rename log committed.
2. **Compress** (P1): write gates on `memory add` (`--kind`, `--until`), a `confirmed` event on a duplicate, `--supersedes`, and a per-topic cap.
3. **Age** (P2): a pure `activation()` score that replaces the 7/30-day limits in `decide()` and adds a bounded bonus in `rank()`. `until:` expiry becomes a `decide()` input. `--from` is required.
4. **Learn** (P2): the dream clusters failure classes into at most 3 `.proposals/`. `factory proposals install|reject` copies the `skills` flow, and any rung above a core fact files a bead.
5. **Measure** (P3): `memory eval --self`, eval categories, and per-dream lifecycle metrics.

Every decision stays a pure function in `src/memory.ts` with table tests. All I/O stays in `src/cli.ts`, and git stays the undo for every change.

## Technical Context

**Language/Version**: TypeScript on Bun (as the repo).
**Primary Dependencies**: existing only: `@huggingface/transformers` (bge-small embeddings), `bd`, `git`. No new dependency.
**Storage**: the memory git repo (markdown notes, `LONG.md`, `CORE.md`, `.archive/`), `.usage.jsonl` (now tracked), `.renames.jsonl`, and the new `.proposals/<name>.md`. Run dirs live under `runs/`.
**Testing**: `bun test src factories` plus `claude plugin test mod`; table tests in `src/memory.test.ts`; CLI tests in `src/cli.test.ts`.
**Target Platform**: macOS/Linux factory host; AX VM workers call the same CLI through the outbox.
**Project Type**: CLI plus a library module (`src/memory.ts`).
**Performance Goals**: a tier pass and gc each finish in seconds on 500 notes and 600 runs, well inside the tick's 120 s limit. gc runs at most hourly.
**Constraints**: The repo is public, so fixtures must be generic. Usage lines append concurrently, one short line each (already the case). There are no new LLM calls outside the dream.
**Scale/Scope**: about 400–1,000 notes, about 30 topics, about 600 runs, 16 to 50 concurrent workers.

## Constitution Check

`.specify/memory/constitution.md` is still the unfilled template, so the project's CLAUDE.md principles serve as the gates:

- **Pure core, I/O at the edges**: `activation`, `decide`, `gate` (the write check), `failureClasses` and `gcPlan` are all pure. ✅
- **Simplicity**: no new store, no graph, no new model, no new config file. Defaults are constants, with env overrides only where a memory setting already has one. ✅
- **Test-first**: each slice starts with red table tests. ✅
- **Reversible**: archives, retirements and proposals are git commits in the memory repo. gc removes only reproducible files. ✅
- **Public repo**: examples stay generic. ✅

Post-design re-check: still passes. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-memory-lifecycle/
├── plan.md          # this file
├── research.md      # Phase 0 decisions
├── data-model.md    # Phase 1 entities and frontmatter
├── quickstart.md    # Phase 1 validation guide
├── contracts/
│   └── cli.md       # CLI surface changes
└── tasks.md         # /speckit-tasks (mirrored into beads)
```

### Source Code (repository root)

```text
src/
├── memory.ts        # activation(), decide() changes, gate(), parse kind/until, cap, failureClasses(), proposals, evalSelf()
├── memory.test.ts   # table tests per slice
├── cli.ts           # memory add/helped flags, gc case, proposals case, dream wiring, closedBeads()/PR state into decide
├── cli.test.ts
├── harness.ts       # launch dir listing for gc (writeLaunch already here)
└── worker-system.md # how to add a note: kind, until, supersedes
docs/
└── memory.md or README memory section  # the new flags and tiers
```

**Structure Decision**: single project. Every change lands in the existing files above. The only new on-disk path is the memory repo's `.proposals/`.

## Phases (build order)

| Phase | Slice | Main code | Size | Absorbs |
|---|---|---|---|---|
| A | gc for runs and launch scripts | `cli.ts` beside `case 'rm'`, `gcPlan()` pure | S | 503.1 |
| A | Usage and renames committed; repo clean after a dream | `cli.ts` `dream()` gitignore line, compact before commit | S | 503.3 |
| A | Archive cap 25, plan logged to `dream.log`, never-shown at 14 d | `memory.ts` `decide()`/`applyTiers()` | S | 503.2 |
| B | `--kind` / `--until` write gate, a `gate()` pure fn | `memory.ts` `parse`/`format`/`add`, `cli.ts` memory add | S | new |
| B | `confirmed` event on a duplicate; `--supersedes` | `cli.ts:3689`, `memory.ts` `use()`/`tallyRaw()` | S | new |
| B | Per-topic cap 15 (dream prompt plus tier pass refusing growth) | `memory.ts` `dreamPrompt()`, `applyTiers()` | S | new |
| C | `activation()` plus `rank()` bonus plus thresholds in `decide()` | `memory.ts` | M | extends 503.2 |
| C | `until:` expiry from bead/PR/date into `decide()` | `cli.ts` `closedBeads()`, `prs.ts` state, `memory.ts` | S | new |
| C | `--from` required, or taken from `FACTORY_RUN` | `cli.ts` memory helped/add | S | p11 |
| C | Outcome-weighted helps (green 1.0, red 0.3) from the journal | `cli.ts` dream, `memory.ts` `activation()` | S | new |
| D | `failureClasses()` from the journal; `.proposals/`; dream prompt section | `memory.ts`, `cli.ts` dream | M | new |
| D | `factory proposals list/install/reject`; manager mail; a bead for rung 3 and up | `cli.ts` like `skills`/`skillMail()` | M | new |
| D | Demote a contradicted core fact | `memory.ts` `decide()` | S | new |
| E | `memory eval --self [n] [--seed]`; categories in `.eval.jsonl` | `memory.ts` `evaluate()` | S | 9l7 |
| E | Lifecycle metrics in `dream.log` | `cli.ts` dream | S | new |
| — | Docs: worker-system.md, README/docs memory section, CHANGELOG | docs | S | — |

Dependencies: A before C (the score needs tracked usage), B's events before C's score, C before D (proposals use scores), and E's `--self` should land before C so there is a baseline.

## Complexity Tracking

None.
