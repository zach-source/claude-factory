# Feature Specification: Memory lifecycle — compress, age, learn

**Feature Branch**: `003-memory-lifecycle`

**Created**: 2026-10-15

**Status**: Draft

**Input**: User description: "Factory memory that compresses, ages and learns behaviors." (full input: the 2026-10-15 memory review and strategy research; summarized under Context)

## Context

A factory home 9 days old holds 405 short memory notes, filed from about 2,100 inbox notes. Measured on it:

- A shown note helped only 7.7% of the time; 193 notes were never shown.
- 68% of notes cite a bead or PR id, as a run log would; 47 say "until <bead> closes" in prose.
- The tier pass has archived 0 notes. When the store reaches 30 days, about 190 notes qualify for archive in one pass.
- Usage counts are not kept in version control, so their loss resets every tier decision.
- Run data is 245 MB, 75% of it reproducible prompt files, with no retention.
- Search finds a note from its own first sentence in the top 5 results 87% of the time (MRR 0.75).

The design borrows proven ideas: insight voting from experience (ExpeL), recency and frequency decay (ACT-R, MemoryBank), validity intervals on facts (Graphiti), offline consolidation and skill learning (Letta, Agent Workflow Memory), and "strategies, not transcripts" (Dynamic Cheatsheet).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The factory home stays small and its records survive (Priority: P1)

The owner runs the factory for weeks. Finished runs' reproducible files go away on their own, old launch scripts go away, and the usage counts that drive memory decisions are versioned, so no single file loss resets them. No pass archives a large part of memory at once.

**Why this priority**: Disk grows without bound today, and a mass archive at day 30 is a known risk (a 139-note merge pass already had to be reverted). These are cheap fixes with the largest safety gain.

**Independent Test**: On a copy of a factory home, run retention in dry-run and real modes; check bytes freed per kind, that active runs and kept files are untouched, and that a tier pass archives no more than the cap and records its plan.

**Acceptance Scenarios**:

1. **Given** finished runs older than the retention age, **When** retention runs, **Then** their prompt files, briefs and stray backups are removed and their state, journal, PR list and inbox stay.
2. **Given** an active run of any age, **When** retention runs, **Then** nothing of that run is removed.
3. **Given** a launch script whose pane no longer exists, **When** retention runs, **Then** the script is removed.
4. **Given** retention in dry-run mode, **When** it runs, **Then** it lists what it would remove and the bytes per kind, and removes nothing.
5. **Given** 190 notes qualify for archive, **When** one tier pass runs, **Then** at most the per-pass cap are archived (oldest first), the plan is logged before it applies, and one version-control revert restores them.
6. **Given** a dream finishes, **When** it commits, **Then** usage counts and the rename log are in the commit and the memory repo has no uncommitted changes.

---

### User Story 2 - Notes are dense and retire on time (Priority: P1)

A worker adds a lesson. The factory takes it only in a durable form: a fact, a rule or a recipe. A note about a bead or PR states when it stops being true, and the factory retires it when that bead or PR closes or that date passes. Each topic stays within a cap.

**Why this priority**: Most of the store reads as run logs; time-bound notes linger after they stop being true and crowd search. Fixing the write path stops the sprawl at its source.

**Independent Test**: Add notes of each kind, with and without a validity marker; close the named bead; run a tier pass; check which notes were refused, kept and retired.

**Acceptance Scenarios**:

1. **Given** a new note without a kind, **When** a worker adds it, **Then** the add is refused with a message that names the three kinds.
2. **Given** a new note that cites a bead or PR id, has no validity marker and is not a recipe, **When** a worker adds it, **Then** the add is refused with a message that says status belongs in the tracker, or to add a validity marker.
3. **Given** a note valid until a bead, **When** that bead closes, **Then** the next tier pass retires the note to the archive, whatever its usage.
4. **Given** a note valid until a date, **When** that date passes, **Then** the next tier pass retires it.
5. **Given** a topic at its short-note cap, **When** the dream files more notes there, **Then** the topic ends the pass at or under the cap, by merging or dropping.
6. **Given** a new note that duplicates an existing one, **When** a worker adds it, **Then** no new note is written and the existing note records a confirmation.
7. **Given** a new note that replaces an older one, **When** a worker adds it naming the older note as superseded, **Then** the older note is marked superseded and the next tier pass archives it.

---

### User Story 3 - Memory ranks and ages by real use (Priority: P2)

Each note has one score built from how recently and how often it helped, was confirmed or was shown, with helps from successful attempts weighing more. Search uses the score as a small bonus; merge, archive and promotion decisions use it instead of fixed day limits.

**Why this priority**: Fixed 7- and 30-day limits treat a note helped yesterday like one never used. A single decay score makes every tier decision consistent; it depends on Story 1's versioned usage.

**Independent Test**: Feed fixed usage histories into the decision step and check the score, rank order and merge/archive/promote outcomes against a table of expected results.

**Acceptance Scenarios**:

1. **Given** two notes equally relevant to a query, **When** one has a higher score, **Then** it ranks first; **and given** a clearly more relevant note with a lower score, **Then** relevance still wins.
2. **Given** a note whose score falls below the archive threshold and that is at least 14 days old, **When** a tier pass runs, **Then** it is archived (within the cap).
3. **Given** a note never shown and at least 14 days old, **When** a tier pass runs, **Then** it is archived (within the cap).
4. **Given** a long-tier entry with a score above the promotion threshold across at least 3 runs, **When** a tier pass runs, **Then** it is proposed for the core facts.
5. **Given** a help recorded without the run that it helped, **When** a worker records it, **Then** it is refused with usage text, or the run is taken from the worker's environment.

---

### User Story 4 - Repeated lessons become behavior (Priority: P2)

When the same station fails the same way across several runs, or a lesson keeps being re-learned, the dream proposes a durable change one rung up a ladder: core fact, then a line in a station's or worker's instructions, then a skill or checklist, then a mechanical check. The manager or a person installs or rejects each proposal. Changes to factory code always become a tracked work item for a person.

**Why this priority**: More notes do not change behavior; the research shows that rules and skills distilled from experience do. It builds on the scores and events of Stories 2 and 3.

**Independent Test**: Seed a journal with three runs failing one station for one reason; run a dream; check one proposal appears with its evidence; install and reject it and check the effects.

**Acceptance Scenarios**:

1. **Given** the same station and failure reason in 3 or more runs, **When** a dream runs, **Then** it writes a proposal naming the change, its rung and the runs and notes as evidence.
2. **Given** more than 3 candidate proposals, **When** a dream runs, **Then** it writes at most 3.
3. **Given** a pending proposal, **When** the manager is next told of pending work, **Then** the message lists it with install and reject commands.
4. **Given** a proposal installed at the core-fact rung, **When** installed, **Then** the core facts gain the line; **given** a station-instruction or higher rung, **Then** a tracked work item is filed for a person and no factory code changes.
5. **Given** a rejected proposal, **When** rejected with a reason, **Then** the reason returns to memory so the same proposal is not repeated.
6. **Given** a core fact that new notes keep contradicting, **When** a tier pass runs, **Then** it is demoted to a note.

---

### User Story 5 - The owner can tell whether memory works (Priority: P3)

The owner runs one command and gets a search-quality score with no hand-written cases, plus scores by category (knowledge updates, time-bound facts, questions memory should not answer). Lifecycle metrics are reported after each dream.

**Why this priority**: Without numbers, no change in Stories 1–4 can be judged. The baseline must exist before scoring changes land, but it does not block them.

**Independent Test**: Run the self-evaluation on a fixed store and check it reports top-5 hit rate and MRR, reproducibly for a fixed seed.

**Acceptance Scenarios**:

1. **Given** a store with no curated cases, **When** the owner runs self-evaluation with a sample size, **Then** it reports top-5 hit rate and MRR from cases built from the notes.
2. **Given** curated cases tagged by category, **When** evaluation runs, **Then** it reports a score per category.
3. **Given** a dream finishes, **When** it logs, **Then** the log shows notes per topic, archives this pass, the share of notes with a kind, and the share citing a bead or PR without a validity marker.

---

### Edge Cases

- A validity marker names a bead or PR the factory cannot look up (deleted, other forge, tracker unreachable): the note is kept and flagged, never retired on a failed lookup.
- A note's usage history is empty because it predates usage tracking: its age comes from its add commit and it counts as never shown only after the 14-day minimum.
- Retention runs while a run is finishing: a run counts as finished only once its state says done or aborted.
- The usage file is missing on an existing home: the first dream starts it fresh and logs that scores restart; no pass archives on a store whose usage history is under 14 days.
- Two dreams or a dream and a manual compact overlap: the existing dream lock serializes them.
- A superseded note names a path that does not exist (renamed): the rename log resolves it; if still missing, the add is refused.
- Existing notes without a kind: they stay readable and searchable; the dream assigns kinds as it files, and the write gate applies only to new adds.

## Requirements *(mandatory)*

### Functional Requirements

**Retention and safety**

- **FR-001**: The factory MUST offer a retention command with a retention age (default 7 days) and a dry-run mode, and MUST also run retention periodically on its own, at most once an hour.
- **FR-002**: Retention MUST remove only reproducible files of finished (done or aborted) runs: prompt files, briefs and stray backups; it MUST keep each run's state, journal, PR list and inbox, and record a metrics line per pruned run.
- **FR-003**: Retention MUST remove launch scripts whose pane no longer exists.
- **FR-004**: Usage events and the rename log MUST be under version control in the memory repo, and a dream MUST leave the repo with no uncommitted changes.
- **FR-005**: A tier pass MUST archive at most a per-pass cap (default 25, oldest first) and MUST log its full plan before applying it.

**Compress**

- **FR-006**: Adding a note MUST require a kind: fact, rule or recipe.
- **FR-007**: Adding a note that cites a bead or PR id MUST require a validity marker (a bead, a PR, or a date), unless its kind is recipe.
- **FR-008**: Duplicate detection at add time MUST stay; a duplicate add MUST record a confirmation event on the existing note.
- **FR-009**: Adding a note MUST accept a superseded note; the older note MUST be marked superseded.
- **FR-010**: Each topic MUST be held to a short-note cap (default 15) by the dream and the tier pass.
- **FR-011**: The core facts MUST stay under their size budget, ordered by score.

**Age**

- **FR-012**: Each note MUST have a decay score from its usage events in the last 90 days, where recent and frequent events count more; helps and confirmations weigh fully, shows weigh little, and helps from failed attempts weigh less than from successful ones.
- **FR-013**: Search MUST use the score only as a bounded bonus, so relevance dominates.
- **FR-014**: Merge, archive and promotion decisions MUST use the score in place of fixed day limits, with a 7-day minimum age to merge and 14 days to archive.
- **FR-015**: A note never shown and at least 14 days old MUST qualify for archive.
- **FR-016**: A note whose validity bead or PR has closed, or whose date has passed, MUST be retired deterministically by the tier pass, not by the dream's judgment.
- **FR-017**: Recording a help MUST name the run it helped, or take it from the worker's environment; otherwise it MUST be refused.

**Learn behaviors**

- **FR-018**: The dream MUST find failure classes (same station and failure reason in 3 or more runs) and re-learned lessons, and MUST write at most 3 proposals per dream, each naming its rung, the change and its evidence.
- **FR-019**: The factory MUST offer install and reject for proposals, matching the existing skill-proposal flow, and MUST tell the manager once of each set of pending proposals.
- **FR-020**: Installing a core-fact proposal MUST add the line to the core facts; installing any higher rung MUST file a tracked work item for a person and MUST NOT change factory code.
- **FR-021**: A rejection's reason MUST return to memory; a core fact contradicted repeatedly MUST be demoted to a note.
- **FR-022**: The dream MUST NOT edit factory definitions or worker instructions directly.

**Measure**

- **FR-023**: The factory MUST offer a self-evaluation that builds cases from notes and reports top-5 hit rate and MRR, reproducible for a fixed seed; curated cases MUST support categories (knowledge update, temporal, abstain) with a score per category.
- **FR-024**: Each dream MUST log lifecycle metrics: notes per topic, archives this pass, share of notes with a kind, share citing a bead or PR without a validity marker.

### Key Entities

- **Note**: one lesson in a topic; has kind, optional validity marker, optional superseded marker, tier (short, long, core, archive), age from its add commit.
- **Usage event**: one shown, helped, confirmed or contradicted record for a note, with the run, station, time and attempt outcome.
- **Score**: a note's decay score, derived from its usage events; never stored as truth.
- **Proposal**: a suggested behavior change with rung, target, change text, evidence (runs, notes) and status (pending, installed, rejected with reason).
- **Failure class**: a station plus a failure reason seen across runs.
- **Retention record**: what retention removed from a run, and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The factory home's run data stays under a bounded size: after retention, finished runs older than the retention age hold no prompt files (about 200 MB freed on the measured home).
- **SC-002**: No tier pass archives more than the cap, and the revert rate of archive commits is near 0.
- **SC-003**: Within 30 days of launch, the share of notes that cite a bead or PR without a validity marker falls from 68% to under 10%.
- **SC-004**: Within 30 days, the share of shown notes that help rises from 7.7% to over 20%.
- **SC-005**: Search quality does not regress: self-evaluation top-5 hit rate stays at or above 0.87.
- **SC-006**: A note tied to a bead is retired within one tier pass of that bead closing.
- **SC-007**: For each failure class that gets an installed rule, that station's retry rate for that class falls over the next 10 runs that reach it.
- **SC-008**: The re-learn rate (a lesson re-added after it reached the core facts) falls month over month.

## Assumptions

- Work items are beads; a "tracked work item for a person" is a bead in the factory's own tracker.
- Defaults (retention 7 days, archive cap 25, topic cap 15, 90-day score window, 14-day archive minimum, at most 3 proposals per dream) are configurable but need no new configuration surface beyond environment variables, as existing memory settings use.
- The existing dream lock, rename log, duplicate check, skill-proposal flow and closed-bead lookup are reused.
- The memory repo stays private; it holds internal names. The public factory repo uses only generic examples and fixtures.
- Out of scope: a knowledge graph, a vector database, LLM importance ratings, a learned memory policy, a new embedding model, and the dream editing factory code. Generating hooks from rules (rung 5) is deferred; the ladder stops at a work item for a person.
- Existing beads absorbed: claude-factory-503 (503.1 retention, 503.2 archive cap, 503.3 usage in version control), claude-factory-9l7 (self-evaluation), claude-factory-p11 (help names its run).
