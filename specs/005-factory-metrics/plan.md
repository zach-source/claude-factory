# Implementation Plan: Delivery and quality metrics

**Branch**: `005-factory-metrics` | **Date**: 2026-10-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-factory-metrics/spec.md`

## Summary

`factory metrics` gets two new reports: `dora` and `quality`. Both read the run records that the command reads today, plus three new inputs:

- a **change table**: one row for each merged pull request, from `gh` and git;
- a **link store**: one row for each failure after a merge, linked to its change;
- the **launch log** that exists today, for the harness and model of each station.

A pure module calculates the metrics from these inputs. The CLI, the console view, the weekly report, the `/metrics` endpoint and the OTLP push all show the same numbers.

The first release is US1 (DORA), US2 (attribution) and US5 (quality by group). It needs no change to worker prompts and no new token cost. US3, US4, US6 and US7 come later, in that order. Research: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript on Bun 1.3.13.

**Primary Dependencies**: None new. `gh` and `git` give the change data. `Bun.serve` serves `/metrics`. `fetch` sends OTLP/HTTP JSON. The factory code builds the Prometheus text format and the OTLP JSON body by hand. Each is a few lines. A library would add a dependency for one call.

**Storage**: Local mode: `changes.jsonl` and `links.jsonl` under the factory home, append only, with a key on each row. Server mode (spec 004, step S6): tables `changes` and `failure_links` in the `factory` database.

**Testing**: `bun test src`. Pure functions get table tests. The attribution pass gets a test against a temp git repo with fake `gh` output, as the CLI tests do today. The console view gets a test in `mod/hooks/tabs.test.tsx`.

**Target Platform**: The laptop (local mode) and the cluster server (server mode).

**Project Type**: CLI, plus the console plugin.

**Performance Goals**: SC-006: the metrics add less than 2 s on a home with 2,500 runs. The attribution pass is incremental: it reads `gh` and git only after its last cursor for each repository.

**Constraints**: Read-only on runs, beads and GitHub (FR-025). Workers never see scores (FR-021). Every harness and both modes (FR-024).

**Scale/Scope**: 12 rigs, about 2,300 runs, about 1,300 merged pull requests in history.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle I rule                                                      | Check                                                                                                                                                                                                                                      | Result |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| All workers get the same skills, rules and MCP servers                | The first release changes no worker prompt. US3 changes the report format for review, security and check. That change goes into the station prompts, which every harness reads, and into the CLI parser, which every harness calls. | Pass   |
| No skill or access through a path that only one backend or runner has | The metrics read records that the factory writes for every harness: run logs, `launches.jsonl` and usage. The harness and model are a group key, not a path.                                                                             | Pass   |
| A change for one runner must reach all runners in the same change     | FR-008 (a PR field in rollback, soak, incident and postmortem reports) changes the report schema, which herdr and AX workers both use through `factory report`.                                                                          | Pass   |

Re-check after Phase 1: the contracts give the same fields for every harness. The `harness` and `model` group keys come from `launches.jsonl`, which every launch writes. Pass.

## Project Structure

### Documentation (this feature)

```text
specs/005-factory-metrics/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1: changes, links, findings, probes
├── quickstart.md        # Phase 1: checks for each user story
├── contracts/
│   ├── cli.md           # Phase 1: factory metrics dora | quality | links | serve
│   └── telemetry.md     # Phase 1: /metrics names and the OTLP push
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── dora.ts              # new, pure: deployments, lead time, failure rate, recovery, rework from changes + links + records
├── quality.ts           # new, pure: first-pass yields, passes per ship, churn, smoothing, group keys
├── changes.ts           # new: the change table: gh pr list (merged) + git, incremental, with a cursor per repo
├── attribution.ts       # new: the link pass: run logs, reverts, discovered-from beads, blame (suspected)
├── telemetry.ts         # new: Prometheus text and the OTLP JSON body from one metrics object
├── metrics.ts           # changed: export the record helpers that dora.ts and quality.ts share
├── cli.ts               # changed: `factory metrics dora|quality|links|serve`, `--since`, `--by`, `--json`
mod/hooks/views.tsx      # changed: Metrics tab (key 8)
mod/hooks/register.tsx   # changed: the view dispatch and a weekly report timer
factories/lifecycle.ts   # changed in a later phase: the PR field in rollback, soak, incident, postmortem reports (FR-008)
factories/ship.ts        # changed in a later phase: the same field for the ship stations
```

**Structure Decision**: Pure calculation modules with I/O at the edges, as `metrics.ts` is today. `changes.ts` and `attribution.ts` are the only modules that call `gh` or git. Thus the tests of `dora.ts` and `quality.ts` need no fakes.

## Phases

Each phase is one PR set with its own check. After each phase the factory works as before.

| Phase | What                                                                                                                                                                                                            | Check                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P1    | The change table (`changes.ts`) with a history backfill, and `factory metrics dora` with deployments and lead time only.                                                                                       | Quickstart 1: deployments and lead time match a hand count for one rig (SC-001).         |
| P2    | The link store and the attribution pass (`attribution.ts`): run logs, reverts, fix-forward beads, suspected blame links, `factory metrics links` and `links wrong <id>`. Backfill all history (FR-027).        | Quickstart 2: the test repo gives the expected links. SC-002 on 14 days of real data.    |
| P3    | The rest of DORA: change failure rate, recovery time, rework rate. The 30-day window and the trend.                                                                                                            | Quickstart 1, all five numbers.                                                          |
| P4    | `factory metrics quality --by ...` (US5), with smoothing.                                                                                                                                                      | Quickstart 3: two models at implement rank in the expected order (SC-003).               |
| P5    | Output paths: the console Metrics tab, `factory metrics serve` (`/metrics`), the OTLP push, and the weekly report from the pm.                                                                               | Quickstart 4: a scrape and a push both show the same numbers as `--json`.                |
| P6    | US3: the finding format in review, security and check (warn for 7 days, then refuse), the PR field in ship-side reports (FR-008), the finding outcome pass, and the verdict scores.                          | Quickstart 5.                                                                            |
| P7    | US4: defect probes, off by default; first setting all AX rigs, 3 each day.                                                                                                                                     | Quickstart 6.                                                                            |
| P8    | US6: the judge, the console grading view and the calibration gate.                                                                                                                                             | Quickstart 7.                                                                            |
| P9    | US7: the dream reads the metrics file, cites it in proposals, and `factory proposals` shows before and after.                                                                                                  | Quickstart 8.                                                                            |

P1 to P5 are the first release (US1, US2, US5).

## Owner steps

- P5: give the OTLP endpoint and its auth (env `FACTORY_OTLP_ENDPOINT`, `FACTORY_OTLP_HEADERS`). Give the scrape path for `/metrics` in local mode, if Grafana must scrape the laptop.
- P7: turn the probe switch on for each rig, and confirm the budget.
- P8: grade the calibration set (about 30 changes for each rubric item).

## Risks

- **Pull requests that are not linked to a run.** A person merges some changes by hand. They count for DORA (spec edge case) and get no station scores. The change table marks them `run: null`.
- **Squash merges.** Blame on a squash commit gives the squash, not the original commits. The change table maps a squash commit to its PR by the `(#n)` in its subject (research R2).
- **Free-text history.** Before FR-008, a rollback or soak run names its PR only in its summary text. The backfill reads the PR URL from the summary and from the bead's `ship_pr` metadata. The backfill marks links found this way as `source: text`. Quickstart 2 checks a sample of them by hand.
- **gh rate limits.** The backfill of about 1,300 PRs uses `gh pr list --state merged --limit 1000` pages, not one call for each PR.

## Complexity Tracking

No constitution violation needs a justification.
