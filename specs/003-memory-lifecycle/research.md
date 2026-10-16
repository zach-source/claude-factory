# Research: Memory lifecycle

Sources: the 2026-10-15 measurement of a live factory home and the strategy survey (ExpeL arXiv 2308.10144; ACT-R decay and MemoryBank arXiv 2305.10250; Graphiti temporal model; Letta sleep-time compute and skill learning; Agent Workflow Memory arXiv 2409.07429; Dynamic Cheatsheet arXiv 2504.07952; A-MEM arXiv 2502.12110; LongMemEval and LoCoMo).

## R1. Scoring signal
- **Decision**: an ACT-R base-level activation, `A = ln(Σ w_k · (t_k/day)^-0.5)`, over the last 90 days of events. Weights: helped 1.0 (0.3 when the attempt failed), confirmed 1.0, shown 0.15, contradicted −1.0 (subtracted from the sum, floor at a tiny epsilon). A note with no events gets −∞ and is handled by the never-shown rule.
- **Rationale**: one pure number covers recency and frequency together. It replaces the 7/30-day cliffs and costs no extra calls. It is a proven model of human memory decay.
- **Alternatives**: an LLM importance rating at write time (costly, and the model rates its own notes); raw helped/shown counts (today's approach, which ignores recency); Ebbinghaus with per-note strength (more state for little gain).

## R2. Thresholds
- **Decision**: merge when A > θm and age ≥ 7 d; archive when A < θa and age ≥ 14 d, or when the note was never shown and is ≥ 14 d old; promote when A > θc across ≥ 3 runs. θ values are constants, picked by a table test against the measured home's distribution (θm at about the 50th percentile, θa at about the 10th). Each threshold gets one env override, matching `FACTORY_MEMORY_TIERS`.
- **Rationale**: these values keep today's merge behaviour and let the archive act before day 30.

## R3. Rank bonus
- **Decision**: `rank()` adds `clamp(A, 0, Amax) / Amax · 0.02`, the same scale as `TIER_BONUS.fact`. Relevance still dominates.
- **Rationale**: the eval showed recall@5 0.87. A small bonus only breaks near-ties, so `eval --self` must not regress.

## R4. Validity intervals
- **Decision**: frontmatter `until: <bead-id> | <PR url or owner/repo#n> | YYYY-MM-DD`. The tier pass gets `expired: true` from `closedBeads()` (existing), from PR state (`src/prs.ts`), or from the date. An unreachable lookup leaves the note `expired: false` and flagged.
- **Rationale**: this is Graphiti's interval idea without the graph, and it makes retirement deterministic.

## R5. Write gate
- **Decision**: `memory add` requires `--kind fact|rule|recipe`. A body matching a bead id (`[a-z]+-[a-z0-9]{3}(\.\d+)*`) or a PR reference needs `--until` unless the kind is `recipe`. `--anyway` still skips the duplicate check, but not the gate. Workers learn the flags from `worker-system.md` and from the refusal text.
- **Rationale**: Dynamic Cheatsheet: "strategies, not transcripts". 68% of notes are run-log shaped.

## R6. Confirm and contradict events
- **Decision**: a duplicate add logs `confirmed` (today it logs `helped`, which inflates helps). `--supersedes <path>` writes `superseded: <new>` on the old note (decide() already archives that) and logs `contradicted` on it.
- **Rationale**: ExpeL's upvote and downvote operations.

## R7. Usage in git
- **Decision**: drop `.usage.jsonl*` from the memory `.gitignore`. `commitMemory('notes since the last dream')` already runs first in `dream()`, so concurrent appends land in that commit. Run `compact()` before the dream's own commit and again before the tier commit, so `.renames.jsonl` is committed.
- **Rationale**: losing the file resets every decision. It is about 72 KB and append-only.

## R8. Learning ladder
- **Decision**: the rungs are note → CORE line → station or worker-instruction line → skill or checklist → mechanical check. The dream gets a "failure classes" section: a pure `failureClasses(journal)` groups `(station, normalized outcome reason)` seen in ≥ 3 runs. It writes at most 3 proposals per dream to `.proposals/<name>.md` (frontmatter: rung, target, status; body: the change and its evidence). `factory proposals install` applies rung 1 (CORE.md) itself. Rung 2 and up runs `bd create` in the factory's own rig, and factory code never changes. `reject <why>` writes an inbox note, as `rejectSkill` does.
- **Rationale**: ExpeL, Agent Workflow Memory and Letta skill learning show that distilled rules and skills improve agents. Human review keeps the public repo safe.
- **Alternatives**: the dream edits station prompts directly (rejected: unreviewed changes to public code); generating hooks (deferred).

## R9. Retention
- **Decision**: `gcPlan(runs, now, days)` is pure. It returns paths in done or aborted runs older than `days`: `prompts/`, `f-*.brief.md`, `*.before-*`, `*.pre-*`. Launch scripts are removed when their pane id is not in herdr's live pane list. If herdr is unreachable, no launch scripts are removed. Each pruned run gets a `record()` line.
- **Rationale**: 184 MB of reproducible prompts make up 75% of the home.

## R10. Evaluation
- **Decision**: `memory eval --self [n] [--seed s]` samples n notes. The query is each note's first body sentence, and the target is that note. It reports recall@5 and MRR. `.eval.jsonl` cases may carry `category: update|temporal|abstain`. An abstain case expects no result above `FLOOR`.
- **Rationale**: there is a baseline now (0.87 / 0.75), and the LongMemEval categories cover the new behaviours.

## Not built
A knowledge graph, a vector DB, LLM importance scores, an RL policy, a new embedding model, the dream editing `factories/*.ts`, putting archived notes back into search, or hook generation (rung 5).
