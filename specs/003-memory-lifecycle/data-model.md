# Data model: Memory lifecycle

## Note (markdown file, frontmatter)
| Field | Type | Rule |
|---|---|---|
| summary | string | required (existing) |
| rig | string? | existing |
| from, at | string? | existing |
| kind | `fact`\|`rule`\|`recipe` | required on new adds (FR-006); missing on old notes means "unknown" |
| until | string? | bead id, PR ref, or `YYYY-MM-DD`; required when the body cites a bead/PR, unless kind=recipe (FR-007) |
| superseded | string? | existing; set by `--supersedes` on the old note |

Tiers: `short` (topic file) → `long` (`<topic>/LONG.md` entry) → `fact` (`CORE.md` bullet). Any tier → `archive` (`.archive/<topic>.md`).

## Usage event (`.usage.jsonl`, one JSON line, now tracked in git)
`{ path, at, by?, shown?|helped?|confirmed?|contradicted?: 1, ok?: boolean }`
- `by` = `run/station`; required for helped, confirmed and contradicted (FR-017)
- `ok` = whether the attempt ended green, filled by the dream from the journal (R1). When it is missing, the help counts at full weight.
- Folded lines from `compact()` keep `keys` (existing) and gain per-kind `events: [[at, kind, w]]`, cut down to the 90-day window.

## Score (derived, never stored)
`activation(events, now) -> number`; inputs to `decide()` and `rank()`.

## ShortCandidate (decide input) — additions
`activation: number`, `expired: boolean`, `expiredReason?: string`, `kind?: string`, `everShown: boolean`.

## Decision — additions
`{ kind: 'retire', path, reason }` (validity ended); `{ kind: 'demote', path, reason }` (core fact contradicted); archive decisions are capped per pass (FR-005).

## Proposal (`.proposals/<name>.md`)
Frontmatter `rung: core|instruction|skill|check`, `target` (e.g. `CORE.md`, `station:implement`, `worker-system`), `status: pending|installed|rejected`, `evidence: [run ids, note paths]`, `created`. The body holds the proposed change text. State moves pending → installed (rung core: line added; higher: bead filed, its id recorded) or pending → rejected (the reason goes to an inbox note).

## FailureClass (derived)
`{ station, reason, runs: string[] }` with `runs.length >= 3`, built from journal outcomes by normalising the reason (lowercased, ids and numbers stripped).

## GcPlan (derived)
`{ run, paths: string[], bytes }[]` plus `launch: string[]`. Only done or aborted runs older than N days are included.
