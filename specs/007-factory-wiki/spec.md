# Feature Specification: Factory wiki — what the factory works on and how it solved it

**Feature Branch**: `007-factory-wiki`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "Build a spec for a wiki feature to help inform developers what the factory is working on and details about the solutions; similar to memory but a groomed, human readable data wiki."

## Context

The factory ships a large volume of work. On 2026-11-05, the factory merged 60 PRs across 4 rigs in 4 hours after one manager restart. A developer who wants to know what changed, or why, must read many sources today:

- Bead comments, which hold station reports in a short form for agents, for example `triage#1 small: ...` and `quick#1 ready: ...`.
- Run journals and state files in the factory home, which only the owner's machine has.
- PR bodies, one per change, with no link to related changes.
- Factory memory (`memory/`, 35 topic folders and `CORE.md`) holds short rules, bead ids and "until <bead> closes" notes. It serves agents: it ranks notes by use for a worker brief, not for a reader.
- The manager's chat recaps, which nobody keeps.

No place answers the questions that a developer asks. Examples are:

- "What is the factory doing in my repo this week?"
- "Why does the soak station now pass after 24 hours?"
- "Which change fixed the Codex login outage, and what was the cause?"

The wiki is that place. The factory grooms the wiki: it writes and keeps the pages up to date, merges duplicates and removes stale text. It is for people, so it uses plain sentences, links and no agent shorthand.

## Clarifications

### Session 2026-11-05

- Q: Where does the wiki live? → A: Markdown pages in one private git repo for the factory home. The git host renders them.
- Q: Do wiki changes need a person's approval? → A: Rig and solution pages publish directly. Each grooming pass opens a change for a person to approve.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A developer sees what the factory works on now (Priority: P1)

A developer on a rig team opens the wiki page for their repo. The page shows the work in progress, the work queued, the work that waits on a person, and what shipped in the last 7 days. Each item has a one- or two-sentence plain summary and links to its bead and PR.

**Why this priority**: This is the most frequent question. Today, only the owner can answer it with the factory console. This feature gives value without history or grooming.

**Independent Test**: Run the factory on one rig for a day. Open the page of that rig. Compare each listed item with the factory's own run list. Check that each in-flight run shows. Check also that each item that waits on a person and each merge of the last 7 days shows. Check that the links are correct.

**Acceptance Scenarios**:

1. **Given** a rig with runs in flight, **When** a developer opens the rig page, **Then** each run shows its goal in plain words, its current step, its age, and links to its bead and PR.
2. **Given** a run that waits on a person, **When** the page updates, **Then** the item shows in a "Waits on a person" section with the question in plain words and who can answer it.
3. **Given** a PR the factory merged in the last 7 days, **When** the page updates, **Then** it shows under "Shipped" with a summary of what changed for a user of the repo.
4. **Given** a run that ends, **When** the next update runs, **Then** the item leaves "In progress" and goes to "Shipped" or "Stopped", with the reason.

---

### User Story 2 - A developer reads how a problem was solved (Priority: P1)

When the factory closes a bead with a merged change of note, it writes or updates a solution page. The page says what the problem was, the cause, what changed, what it rejected and why, how it was verified, and what is still open. It links to the beads, PRs and releases. A developer can read it in a few minutes and understand the change without the agent transcripts.

**Why this priority**: This is the "details about the solutions" in the request. It is also the main difference from a change log. It keeps decisions and causes. Today, they are lost when a bead closes.

**Independent Test**: Take three closed beads from one week. For example, use a bug with a root cause, a feature and an incident. Check that each bead has a solution page with all required sections. Check also that a developer who did not work on the bead can answer "what was the cause" and "what changed" from the page alone.

**Acceptance Scenarios**:

1. **Given** a bug bead closed with a merged fix, **When** the wiki updates, **Then** a solution page exists with the symptom, the cause (marked as proven or as a hypothesis), the fix, the verification, and links.
2. **Given** a change that the factory made twice (two PRs for one bead), **When** the wiki updates, **Then** one page describes the result and names both PRs.
3. **Given** a trivial change (formatting, a version bump, a test-only change), **When** it merges, **Then** it shows only in the rig's "Shipped" list and gets no solution page.
4. **Given** a solution that a later change replaces, **When** the later change merges, **Then** the old page says it is superseded and links to the new page.

---

### User Story 3 - The wiki stays groomed (Priority: P2)

The factory grooms the wiki on a schedule. It merges pages on the same topic, rewrites pages that grew by appends into one clear text, marks or removes facts that are no longer true, and keeps a topic index. A person can correct a page, and the factory keeps the correction.

**Why this priority**: Without grooming, the wiki becomes a second run log. Grooming is what makes the wiki different from raw notes. Stories 1 and 2 give value before grooming.

**Independent Test**: Seed a wiki copy with two duplicate pages. Add a page with five appended updates and a page that names a removed setting. Run one grooming pass. Check that the duplicates merge into one page with a redirect. Check that the appended page reads as one text. Check that the factory removes or marks the stale fact, and that the page history has a note about it.

**Acceptance Scenarios**:

1. **Given** two pages on the same topic, **When** a grooming pass runs, **Then** they merge into one page, and the old address points to it.
2. **Given** a page that names a setting, file or command that no longer exists in the repo, **When** a grooming pass runs, **Then** the fact is marked stale or removed, and the page history says why.
3. **Given** a person edited a page, **When** a later grooming pass or update runs, **Then** the person's text stays unless a later fact makes it false, and then the factory flags it and does not overwrite it.
4. **Given** a grooming pass, **When** it finishes, **Then** each change is in the page history, and one revert restores the pages as they were before the pass.

---

### User Story 4 - A developer finds a topic (Priority: P2)

A developer searches or browses the wiki by repo, by topic (for example "ship soak", "AX workers", "Codex login"), or by bead or PR id, and gets to the right page.

**Why this priority**: With many pages, a reader needs a way in. Browse by rig and topic. This is enough at first.

**Independent Test**: Pick 10 questions from developer chat. For example, use "why did my PR get the conflict label?". Check that a developer finds the answer page in 2 minutes or less for at least 8 of them.

**Acceptance Scenarios**:

1. **Given** a bead or PR id, **When** a developer searches for it, **Then** the wiki shows the solution page or the rig item that names it.
2. **Given** a topic page, **When** a developer opens it, **Then** it lists its solution pages, newest first, with one line each.

---

### User Story 5 - The wiki gives back to the factory (Priority: P3)

The factory can read a groomed wiki page as background for a worker, when the page is on the worker's topic. Memory stays the source of short rules for workers. The wiki is the longer, explained version.

**Why this priority**: It is useful. However, the wiki is first for people. Memory already feeds workers.

**Independent Test**: Give a worker a task on a topic that has a wiki page. Check that the brief of the worker links or quotes the page. Check also that the brief stays within the brief size limit.

**Acceptance Scenarios**:

1. **Given** a worker task on a topic with a wiki page, **When** the brief is made, **Then** it links the page and stays in the brief size limit.

---

### Edge Cases

- A run or bead has a secret, a token, a customer name or a private address in its text. The wiki must not copy it.
- A rig is private and the factory's own repo is public. A page about a private rig must not go to a public place.
- A cause is a guess. The page must say "hypothesis" and what would prove it, as station reports do.
- The factory is down or the update fails. The pages show the time of the last update, so a reader knows they are old.
- A bead moves between rigs, or one change touches two rigs. Both rig pages link the same solution page.
- A person deletes a page. The factory must not make it again for the same topic, unless new work arrives on it.
- Many changes merge in a short time (60 in 4 hours). Updates must not create one page per PR. Small changes stay in the "Shipped" lists.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The wiki MUST have one page for each rig, with the sections "In progress", "Waits on a person", "Queued", "Shipped (last 7 days)" and "Stopped".
- **FR-002**: Each rig page item MUST have a plain-language summary of 1 or 2 sentences, its current step, its age and links to its bead and PR.
- **FR-003**: Rig pages MUST update at least every 30 minutes while the factory runs, and each page MUST show the time of its last update.
- **FR-004**: When a bead closes with a merged change that is not trivial, the factory MUST write or update one solution page for it.
- **FR-005**: A solution page MUST have these sections: Problem, Cause, Change, Options rejected, Verification, Still open, Links. It MUST mark the cause as proven (with how) or as a hypothesis.
- **FR-006**: The factory MUST NOT write a solution page for a trivial change: a docs-only, test-only, formatting-only or version-bump change.
- **FR-007**: The wiki MUST group solution pages into topic pages, and it MUST keep one index of rigs and topics.
- **FR-008**: Pages MUST use plain language for a developer: full sentences, no agent shorthand (no `triage#1`, no station codes without an explanation), and terms that link to a glossary on first use.
- **FR-009**: A grooming pass MUST run at least once each day. It MUST merge duplicate pages, rewrite appended pages into one text, and mark or remove facts that the repo no longer supports.
- **FR-010**: A grooming pass MUST change at most a set number of pages each run, MUST log its plan before it applies, and MUST be reversible with one revert.
- **FR-011**: Each page MUST keep a history of changes, with who made each one (the factory or a person) and why.
- **FR-012**: The factory MUST keep a person's edit. If a later fact makes the edit false, it MUST flag the page for a person and MUST NOT overwrite the edit.
- **FR-013**: The factory MUST remove secrets, tokens and credentials from all text before it writes a page. It MUST use the same check that guards worker output today.
- **FR-014**: The wiki MUST store pages for a private rig only where readers of that rig can read them. A page MUST NOT name a private rig's details in a place that a public repo or a public reader can reach.
- **FR-015**: A developer MUST be able to find a page by rig, by topic, and by bead or PR id.
- **FR-016**: A solution page that a later change replaces MUST say that it is superseded and MUST link to the new page.
- **FR-017**: The factory MUST NOT make a page again for a topic that a person deleted, until new work arrives on that topic.
- **FR-018**: Memory MUST stay the source of short rules for workers. The wiki MUST NOT replace memory, and a memory note MAY link to a wiki page.
- **FR-019**: The wiki MUST live as Markdown pages in one private git repo for the factory home. The git host renders the pages, and git keeps the page history. Each reader MUST have read access to that repo. Pages MUST NOT go to the public claude-factory repo.
- **FR-020**: The factory MUST publish rig page and solution page updates directly. A person corrects them after. Each grooming pass (merges, rewrites, stale-fact removals) MUST open one change for a person to approve, and the pass MUST NOT apply until a person approves it.

### Key Entities

- **Rig page**: One per rig. The live view of the factory's work in that repo: items by state, the last update time, and a link to the rig's topics.
- **Work item**: One bead or run as the rig page shows it: plain summary, step, age, state, links. It comes from factory state. Nobody edits it by hand.
- **Solution page**: The explained story of one change of note: problem, cause, change, options rejected, verification, still open, links. It can cover more than one bead or PR, and it can be superseded.
- **Topic page**: A group of solution pages on one subject (for example "ship soak"), with a short overview that the factory grooms.
- **Index and glossary**: The entry point. It lists rigs and topics, and it explains factory terms (station, soak, rig, ship lane, bead).
- **Page history entry**: One change to a page: when, who (the factory or a person), what changed and why.
- **Grooming pass**: One scheduled run that plans and applies merges, rewrites and stale-fact fixes, with a cap on the number of pages it changes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer who did not work on a change can answer "what changed and why" from its solution page in 5 minutes or less, for at least 8 of 10 sampled changes.
- **SC-002**: A developer finds the answer page for at least 8 of 10 common questions in 2 minutes or less.
- **SC-003**: Each rig page agrees with the factory's own run list for 100% of in-flight items, and it is never more than 30 minutes old while the factory runs.
- **SC-004**: At least 90% of non-trivial merged changes have a solution page within 24 hours of the merge.
- **SC-005**: After 30 days, no two pages have the same topic, and fewer than 5% of pages name a setting, file or command that the repo no longer has.
- **SC-006**: 0 secrets, tokens or private-rig details appear in any page in a place that its readers cannot already see. An audit checks a sample each week.
- **SC-007**: The owner gets fewer "what is the factory doing in my repo?" questions from developers. Target: half as many after one month.

## Assumptions

- Readers are developers on the rig teams and the factory owner. They can read the repos the wiki talks about. Customers and the public are not readers.
- The wiki is read-mostly. People correct pages, but the factory writes most of the text.
- The sources of the wiki are the factory's own records: run state, station reports, bead comments, PRs, releases and memory. The wiki adds no new source of truth.
- "Trivial change" uses the same classes that the ship station uses today (docs-only, test-only, `.factory/`-only), plus formatting and version bumps.
- Pages use ASD-STE100 Simplified Technical English, as all text for people in this project does.
- A 7-day "Shipped" window and a 30-minute update are enough. Older shipped items stay in solution and topic pages.
- The factory home already has a way to run a pass on a schedule (the dream and tier passes), and the wiki grooming can use the same kind of schedule.
- Out of scope for the first version: comments and discussion on pages, notifications to developers, and wiki pages for work the factory did not do.
