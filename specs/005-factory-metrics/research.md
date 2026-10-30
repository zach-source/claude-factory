# Research: delivery and quality metrics

Phase 0 of the plan. Each item gives the decision, the reason and the alternatives.

## R1. The change table

**Decision**: One `gh pr list --state merged --json number,headRefName,mergedAt,mergeCommit,createdAt,commits,baseRefName` call for each repository, paged, from the last cursor. Each merged PR is one change.

- **Deployment time** = `mergedAt` (owner decision: the merge is the deployment).
- **First commit time** = the earliest `authoredDate` in `commits`. If the list is empty, use `createdAt`.
- **Run** = the run id in `headRefName` (`factory/<run id>`). If the branch has another name, the change has `run: null`.
- **Bead** = the run's bead, from `run.json` or from the run record in `metrics.jsonl`.
- **Deploy time** (the second point, FR-002) = the `at` of the first deploy outcome `deployed` in the ship run that names this PR.

**Rationale**: A check on 2026-10-29 showed that `headRefName` gives the run id for factory PRs. Thus a change maps to its run with no text parse. One paged call gets 100 PRs, so the history backfill of about 1,300 PRs needs about 15 calls.

**Alternatives considered**: `git log --merges` only. It has no PR metadata for squash merges and no first commit time for deleted branches.

## R2. Squash merges and blame

**Decision**: The change table keeps the merge commit. For a squash merge, it is the one squash commit, and the PR number is the `(#n)` at the end of the commit subject. Blame and revert checks use the merge commit.

**Rationale**: GitHub writes `(#n)` in each squash subject and `Merge pull request #n` in each merge commit subject. Both forms map a commit on the default branch to one PR.

## R3. Failure links and their sources

**Decision**: The attribution pass reads four sources. Each link records its `source`:

| Source       | Kind                                    | How the pass finds the change                                                                                                                              | Counts in the rate |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `run`        | rollback, soak regression, incident     | Before FR-008: the PR URL in the run's summaries, then the bead's `ship_pr` metadata. After FR-008: the fixed PR field in the report.                         | Yes                |
| `revert`     | revert                                  | A commit on the default branch with `This reverts commit <sha>` in its body, where `<sha>` is a change's merge commit or one of its commits.                 | Yes                |
| `bead`       | fix-forward                             | A bead of type bug, made within 14 days after a merge, with a `discovered-from` dependency on the bead that the change closed.                             | Yes                |
| `blame`      | suspected                               | A fix change deletes or edits lines. `git blame` on the fix's parent gives those lines to a change merged in the last 14 days. | No (owner decision) |

A link from history has `backfilled: true`. A link from free text has `source: text` in place of `run`, so the owner can check a sample.

**Rationale**: The `run` source covers what the factory sees itself. The `revert` and `bead` sources cover failures that a person or another run found. The `blame` source finds more, but with more noise, so it shows apart.

## R4. Recovery time

**Decision**: Recovery starts at the `createdAt` of the run that found the failure (a rollback, soak or incident run), or at the `created_at` of the fix-forward bead. It ends at the first of these:

- the end of a rollback run with outcome `recovered`,
- the end of an incident run with outcome `fix` or `rollback`, after its fix merged,
- the merge of the change that the fix-forward bead's run made.

A failure with no end yet counts as open, and the output shows the open count.

## R5. Smoothing for small groups

**Decision**: A beta-binomial estimate. For a group with `k` events of `n`, and a parent group rate `p`, the smoothed rate is `(k + 10·p) / (n + 10)`. The parent of a model group is its station on the same rig. The parent of a station group is the rig.

**Rationale**: It is one line. It pulls a group with 2 events toward its parent, and leaves a group with 200 events almost unchanged. The output always shows `k/n` next to the smoothed rate (FR-018).

## R6. Churn

**Decision**: 14 days after a merge, the pass runs `git blame` at the default branch head on each file that the change touched. Churn is the share of the change's added lines that blame no longer gives to the change. The pass stores the result in the change row (`churn14`) and does not run it again.

**Rationale**: One blame for each file, one time for each change. A lookup at day 14 gives a fixed number, and later reads cost nothing.

**Alternatives considered**: `git log -L` for each hunk. It is slower and gives the same answer.

## R7. Group keys

**Decision**: The harness and model of a station come from `launches.jsonl` (`run`, `node`, `seq`, `harness`, `model`). A change's implement group is the harness and model of the last implement attempt before the merge. A verdict group is the harness and model of the attempt that gave the verdict.

## R8. Telemetry

**Decision**:

- **`/metrics`**: `factory metrics serve --port <n>` starts `Bun.serve` with one route. It calculates the metrics on each scrape, with a 60 s cache. In server mode (spec 004), the server mounts the same handler on its own port.
- **OTLP push**: after each metrics pass, if `FACTORY_OTLP_ENDPOINT` is set, the factory sends one OTLP/HTTP JSON body to `<endpoint>/v1/metrics`. `FACTORY_OTLP_HEADERS` gives the headers, in the OTel `key=value,key=value` form.
- One function builds both formats from the same metrics object.

**Rationale**: The owner asked for both paths. Both formats are small and fixed. A hand-made body avoids a new dependency for one call. The 60 s cache keeps a scrape from running the passes again.

**Alternatives considered**: the OpenTelemetry JS SDK. It adds a set of packages for one push, and its periodic reader does not fit a CLI that exits.

## R9. The weekly report

**Decision**: `factory metrics report` prints a short text. The text has four parts:

- the five DORA numbers and their trend;
- the 3 worst groups for failure rate;
- the 3 worst groups for first-pass yield;
- the open failures.

In local mode, the console plugin runs it once each week on a timer and mails it to the manager. In server mode, the server runs it on the same schedule.

## Later phases

- **R10. Findings**: the review report gets `--findings <file>`, a JSON array of `{id, file, line, severity, category, text}`. The outcome pass compares each finding with the next implement attempt's diff (lines within 5 of the finding) and with the next review round's text.
- **R11. Probes**: a probe does these steps:

1. Copy the branch to a temp worktree.
2. Make one change from a fixed catalog. Use a small script for each kind.
3. Run the review prompt for that rig with the same harness and model.
4. Record the result in `probes.jsonl`.

A probe never pushes.
- **R12. Judge**: Cohen's kappa for each rubric item, between the owner's grades and the judge's grades on the calibration set. The gate is kappa 0.6.
