# Feature Specification: Delivery and quality metrics

**Feature Branch**: `005-factory-metrics`

**Created**: 2026-10-29

**Status**: Draft

**Input**: User description: "Create a spec to build DORA type metrics and to help develop quality metrics we can use to improve the factory."

## Context

`factory metrics` counts flow today: run fates, station outcomes, hours to ship, review rounds and token use. It does not show if the shipped work was good. The values below are for one factory home on 2026-10-29:

- 2,287 runs: 738 shipped, 553 sent to the ship queue, 286 rejected at triage, 283 aborted.
- Ship rate: 43% of the ended runs. Time to ship: 2.5 h median, 11.9 h p90.
- Review sent work back 909 times. 85 runs had 3 or more review rounds. Implement ran 2.11 times for each shipped run.
- Rollback ran 110 times (11 recovered, 99 blocked). Soak found 2 regressions. 16 incident runs and 28 postmortems ran.

None of these numbers connect a merged change to a later failure. So the factory cannot tell a good review from a lucky one. It cannot tell a model that ships fast from a model that ships defects.

The DORA research program defines five delivery metrics. They are: deployment frequency, change lead time, change failure rate, failed deployment recovery time and deployment rework rate. This feature calculates them from factory data. Then it adds quality metrics. These metrics score the verdict of each station against the results after the merge.

**Design rules**:

- Score outcomes after the merge first. Use LLM judgment only where outcomes cannot show quality. Use it only after a person has calibrated it.
- Group each metric by rig, station, harness and model. The owner can then compare the choices that the factory makes.
- Do not show scores to workers. A score that a worker can see becomes a target (Goodhart's law). Scores change routing and prompts only through the owner and the dream, not through the worker prompt.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner sees the DORA metrics for each rig (Priority: P1)

The owner runs one command. The output shows the five DORA metrics for each rig in a time window. It also shows the trend against the previous window.

**Why this priority**: The data for it exists today. It gives one shared measure of delivery. The other stories build on this measure.

**Independent Test**: On a copy of a factory home, run `factory metrics dora --window 7d`. Compare each number with a hand count from the run logs and git for one rig.

**Acceptance Scenarios**:

1. **Given** runs that shipped in the window,
   - **When** the owner runs `factory metrics dora`,
   - **Then** the output shows, for each rig:
     - deployments per day,
     - change lead time (median and p90),
     - change failure rate,
     - failed deployment recovery time (median and p90),
     - deployment rework rate.
2. **Given** a rig with no deploy station (merge is the release).
   - **When** the metrics run.
   - **Then** a merge to the default branch counts as the deployment. The output says so.
3. **Given** `--json`.
   - **When** the metrics run.
   - **Then** the output is one JSON object for each rig and window. The object is for the console and for other tools.
4. **Given** a window with fewer than 5 deployments for a rig.
   - **When** the metrics run.
   - **Then** the rates show the count next to them (for example `1/3`). They do not show a bare percent.

---

### User Story 2 - Each failure after a merge is linked to the change that caused it (Priority: P1)

When a change fails after the merge, the factory records which merged change caused the failure. A failure is one of these: a rollback, a soak regression, an incident, a revert or a fix-forward bead.

**Why this priority**: Change failure rate and each quality score in this spec need this link. Without it, the factory counts failures but cannot connect them to a change.

**Independent Test**: Make a test repo with 3 merged changes. Revert one change. Create a fix bead `discovered-from` a second change. Check that the link store names the correct change for each failure. Check that it names no change for the third.

**Acceptance Scenarios**:

1. **Given** a rollback, soak `regressed` or incident run for a pull request.
   - **When** it ends.
   - **Then** the factory records a failure link to that pull request and to the run that shipped it.
2. **Given** a commit on the default branch that reverts a merged change.
   - **When** the attribution pass runs.
   - **Then** it records a failure link to the reverted change.
3. **Given** a bug bead filed within 14 days of a merge. The bug bead has `discovered-from` a bead that the merge closed.
   - **When** the attribution pass runs.
   - **Then** it records a fix-forward link.
4. **Given** a fix whose diff changes lines that a merge added in the last 14 days.
   - **When** the attribution pass runs. The check uses `git blame` on the fix's parent.
   - **Then** it records a suspected link with a lower weight than a direct link.
5. **Given** a link that the owner marks wrong.
   - **When** the metrics run.
   - **Then** they leave that link out.

---

### User Story 3 - Each review and security verdict gets a score (Priority: P2)

The factory scores review, security and check stations by the results after their verdicts. Recall is the share of defects that the station finds before the merge. Precision is the share of the station's change requests that led to a change that stayed.

**Why this priority**: Review is the factory's largest quality control (909 send-backs). Today, the metrics treat a review that approves a defect and a review that stops a good change the same.

**Independent Test**: Use a test set of runs with known subsequent failures and known review rounds. Check the precision and recall that the scorer gives for each station, harness and model.

**Acceptance Scenarios**:

1. **Given** a station approved a change that has a subsequent failure link.
   - **When** the scorer runs.
   - **Then** it counts a miss for that station, harness and model.
2. **Given** a station sent a change back with findings.
   - **When** the next implement attempt changes the named lines, and the change is not reverted before the merge.
   - **Then** each such finding counts as a hit.
3. **Given** a finding that the next implement attempt answers with no change. The next review round accepts that answer.
   - **When** the scorer runs.
   - **Then** the finding counts as a false positive.
4. **Given** a review report.
   - **When** the station reports.
   - **Then** its findings are in a fixed form with these fields: id, file, line, severity, category and text. The CLI refuses a report with no findings and outcome `changes`.

---

### User Story 4 - The factory tests its reviewers with known defects (Priority: P2)

On a schedule, the factory copies a sample of recent pull request branches. It adds one known defect to each copy. It runs the review station on each copy. It records whether the station finds the defect.

**Why this priority**: Recall from real failures needs weeks of data. It misses defects that do not cause a failure. A known defect gives a direct recall measure within one day.

**Independent Test**: Run the probe on 5 branches with 5 defect kinds in a test repo. Check that no real pull request, branch or bead changes. Check that the results name each station, harness and model.

**Acceptance Scenarios**:

1. **Given** the probe is on for a rig.
   - **When** it runs.
   - **Then** it works only on a local copy of the branch. It does not open a pull request, push a branch or change a bead.
2. **Given** a defect catalog (for example: an off-by-one, a removed check, a swallowed error, an unsafe input path, a deleted test).
   - **When** the probe runs.
   - **Then** it adds one defect to each copy. It records the kind and the location.
3. **Given** the review report for a probe copy.
   - **When** a finding names the file and a line within 5 lines of the defect.
   - **Then** the probe counts a catch.
4. **Given** a daily token budget for probes.
   - **When** the budget is used.
   - **Then** no more probes start that day.

---

### User Story 5 - The owner sees the quality of code for each harness and model (Priority: P2)

The owner sees, for each rig, harness and model: first-pass yield, change failure rate, rework and churn. For example, the owner can compare one model at implement with a different model at implement on the same rig.

**Why this priority**: The factory selects a harness and a model for each station. Today that choice has cost and speed data, but no quality data.

**Independent Test**: Run `factory metrics quality --by model` on a test home with two models at implement. In this test, one model's changes have more failure links. Check that the output ranks the models in that order, with the counts.

**Acceptance Scenarios**:

1. **Given** shipped runs.
   - **When** `factory metrics quality` runs.
   - **Then** it shows for each group:
     - first-pass verify yield,
     - first-pass review yield,
     - implement passes for each shipped run,
     - change failure rate,
     - 14-day churn of merged lines,
     - the count of runs.
2. **Given** a group with fewer than 10 shipped runs.
   - **When** the metrics run.
   - **Then** the rates are smoothed toward the rig's rate. The output marks the group as low count.
3. **Given** `--by station|harness|model|rig`.
   - **When** the metrics run.
   - **Then** the output groups by those keys, in that order.

---

### User Story 6 - A calibrated judge scores what outcomes cannot show (Priority: P3)

A judge model grades a weekly sample of merged changes against a rubric. The rubric items are readability, test value and diff size against the task. The owner first grades a calibration set. The judge is used only while it agrees with the owner.

**Why this priority**: These qualities matter, but outcomes do not show them. A judge that is not calibrated gives numbers with no known meaning.

**Independent Test**: The owner grades 30 changes. Run the judge on the same 30 changes. Check that the agreement number is reported. Check that the judge does not publish scores below the agreement threshold.

**Acceptance Scenarios**:

1. **Given** a calibration set graded by the owner.
   - **When** the judge runs on it.
   - **Then** the factory reports the agreement (Cohen's kappa for each rubric item).
2. **Given** agreement below 0.6 on a rubric item.
   - **When** the weekly sample runs.
   - **Then** the factory does not publish that item's scores. It says why.
3. **Given** a pairwise compare of two changes for the same kind of task.
   - **When** the judge runs.
   - **Then** it does not see which harness or model made each change.

---

### User Story 7 - The metrics change the factory (Priority: P3)

The dream reads the quality metrics. It proposes changes: a routing change (a different model at a station), a prompt line or a skill. Each proposal names the metric and the numbers that support it. After the owner installs a proposal, the factory reports the metric before and after.

**Why this priority**: Metrics that nobody acts on are cost with no gain. The learning ladder (proposals) exists now.

**Independent Test**: Give the dream a metrics file. In this file, one model has half the review recall of a different model on the same rig. Check that the dream files a routing proposal that cites those numbers.

**Acceptance Scenarios**:

1. **Given** a metric that moved past a threshold for 2 windows.
   - **When** the dream runs.
   - **Then** it files a proposal that cites the metric, the groups and the counts.
2. **Given** an installed proposal.
   - **When** 2 windows pass.
   - **Then** `factory proposals` shows the metric before and after the install.

### Edge Cases

- A run that shipped more than one pull request: each pull request is a separate deployment and a separate change.
- A change that a person merged by hand, not the factory: it counts for DORA. It has no station scores.
- A revert of a revert: the second revert removes the first failure link.
- A failure connected to two changes: each change gets a weight of 1/2.
- A rig with history from before this feature: the attribution pass runs on its history once. It uses the same rules. It marks those links as backfilled.
- A defect probe with a copy that does not build: the probe records `invalid`. It does not count the probe for recall.
- Clock skew between the laptop and the cluster: all times are UTC epoch ms from the record that made them.

## Requirements *(mandatory)*

### Functional Requirements

**DORA metrics**

- **FR-001**: The factory MUST calculate these five metrics for each rig and time window:
  - deployment frequency,
  - change lead time,
  - change failure rate,
  - failed deployment recovery time,
  - deployment rework rate.
- **FR-002**: A deployment MUST be a deploy station outcome `deployed` or `published`. For a rig with no deploy station, it MUST be the merge of the change to the default branch.
- **FR-003**: Change lead time MUST run from the first commit of the change to its deployment. The factory MUST also report two parts of it:
  - the time from bead creation to run start (queue time), and
  - the time from run start to deployment (run time).
- **FR-004**: Change failure rate MUST be the share of deployments in the window that have at least one failure link of these kinds:
  - rollback,
  - soak regression,
  - incident,
  - revert.
- **FR-005**: Deployment rework rate MUST be the share of deployments in the window that were not planned, that is:
  - a fix-forward for an earlier failure,
  - a revert,
  - a hotfix run.
- **FR-006**: The failure signal is the start of a rollback, incident or regression run. Failed deployment recovery time MUST run from the failure signal to one of these points:
  - the end of the run that recovered,
  - the deployment of the fix.

**Failure attribution**

- **FR-007**: The factory MUST keep a link store. Each link records:
  - the failure kind,
  - the failing change (repository, pull request, merge commit),
  - the run that shipped it,
  - the evidence (run id, commit or bead),
  - a weight,
  - the time.
- **FR-008**: The rollback, soak, incident and postmortem stations MUST name the pull request that they act on in a fixed field of their report.
- **FR-009**: An attribution pass MUST find reverts, fix-forward beads and suspected blame links (User Story 2, scenarios 2 to 4). It MUST add links for them. It MUST be idempotent. A second pass adds no duplicates.
- **FR-010**: The owner MUST be able to mark a link wrong. The metrics MUST leave out a link marked wrong.

**Review and verdict scores**

- **FR-011**: Review, security and check reports MUST carry findings in a fixed form. The form has these fields: id, file, line, severity, category and text. The CLI MUST refuse a `changes` outcome with no findings.
- **FR-012**: The scorer MUST calculate, for each verdict station, harness, model and rig:
  - recall from failure links,
  - precision from finding outcomes,
  - the rate of owner overrides.
- **FR-013**: A finding outcome MUST be one of these:
  - fixed: the next attempt changed the named lines and the change stayed,
  - disputed: no change, and the next round accepted that,
  - ignored: no change, no answer,
  - unknown.

**Defect probes**

- **FR-014**: The defect probe MUST work only on local copies. It MUST NOT push, open a pull request, write a bead or post to GitHub.
- **FR-015**: The probe MUST have a per-rig switch and a daily token budget. The switch and the budget MUST be off by default.
- **FR-016**: The probe MUST run the review station with the same prompt, harness and model that a real review uses. Its result then measures the real station.

**Quality metrics and judge**

- **FR-017**: The factory MUST calculate, for each group:
  - first-pass verify yield,
  - first-pass review yield,
  - implement passes for each shipped run,
  - change failure rate,
  - the share of a change's added lines that change again within 14 days.
- **FR-018**: Rates for groups with fewer than 10 events MUST be smoothed toward the parent group's rate (a beta prior). They MUST show the raw count.
- **FR-019**: The judge MUST NOT publish a rubric item's scores while its agreement with the owner's calibration set is below kappa 0.6.
- **FR-020**: The judge MUST NOT see the harness, model or station names of the changes that it grades.

**Use and safety**

- **FR-021**: Workers MUST NOT see scores in their prompts, briefs or memory.
- **FR-022**: The dream MUST be able to read the metrics and cite them in proposals.
- **FR-023**: The console MUST show the DORA metrics and the quality metrics in a view.
- **FR-024**: Each metric MUST work in both factory modes (local and server, spec 004). It MUST also work for each harness (Constitution I).
- **FR-025**: All metric commands MUST be read-only on runs, beads and GitHub. The exceptions are the link store and the probe results.

### Key Entities

- **Deployment**: one change that reaches its target. Fields: rig, change, run, kind (deploy or merge), time.
- **Change**: one merged pull request. Fields: repository, number, merge commit, first commit time, run, bead, the harness and model of each station that worked on it.
- **Failure link**: a failure and the change that caused it (FR-007).
- **Finding**: one item in a verdict report (FR-011), with its outcome (FR-013).
- **Probe**: one known-defect test. Fields: change copy, defect kind, location, station, harness, model, result (catch, miss, invalid).
- **Judge grade**: one rubric item for one change, with the calibration agreement that applies.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For one rig and a 7-day window, each DORA number matches a hand count within 5%.
- **SC-002**: At least 80% of rollback, soak regression and incident runs in a 14-day window have a failure link to a change.
- **SC-003**: The owner can compare two models at the same station on the same rig, with counts, in one command.
- **SC-004**: Defect probes give a recall number for each review harness and model within 7 days after the switch goes on. The probes stay inside the daily token budget.
- **SC-005**: Within 30 days, the dream files at least one proposal that cites a quality metric, and the owner installs it or rejects it with a reason.
- **SC-006**: The metric commands add less than 2 s to `factory metrics` on a home with 2,500 runs.

## Assumptions

- Run logs, launch records (harness and model for each attempt), beads with `discovered-from`, git history and `gh` give the data that US1, US2 and US5 need.
- The workers need no new behavior for these, except FR-008 and FR-011.
- A merge commit or squash commit names its pull request number, so git history maps to changes.
- The owner grades about 30 changes for each rubric item to calibrate the judge.
- The 14-day window for fix-forward links and churn is a first value. The owner can change it.
- In local mode, the link store is a file in the factory home. In server mode, it is a table (spec 004, data model).
