# ADR: Bound release soak when its own output is unseen

## Context

Source bead: `claude-factory-geo6`. Baseline: `7595aef6`.

`factories/release.ts:93` blocks after two unsure soaks with unseen output.
The run can then wait without a deadline despite a healthy rollout.
Ship has a deadline, but its AC ledger does not exist in release.
This plan changes release prompts only. It does not change ship policy or the runner.

## Decision

Use the journal, the rollout report, and a source bead comment as durable evidence.
Do not add state, a dependency, an AC ledger, or a common prompt module.
Keep imports type-only.

The deadline exception is one fail-closed rule:
permit healthy with unseen output only after the deadline, with known ordinary risk,
complete health evidence, and a durable follow-up for every unseen output.
If any prerequisite is unknown, the exception does not apply.
Actual regression always takes the existing `regressed` edge.

Classify the whole release from all constituent plans, beads, and review comments.
Any security-sensitive change, data/schema migration, or explicit must-see-live AC
makes the whole release must-see-live. An unknown class has the same result.
Security comments include `review#<n> security:`, `check#<n> security:`, and `security#<n>` prefixes.
For this class, the deadline never applies.
After two consecutive unsure soaks, including the current soak, report blocked.
Name the unseen output, its trigger, and a `Question:` line.

For an ordinary release, count prior unsure and blocked soak reports with unseen output
since this release's latest rollout, then add the current soak once.
Do not count worker launches, retries without reports, other versions, or reports before that rollout.
The deadline is count >= 4 OR elapsed time >= 24 hours, whichever occurs first.
Use the UTC completion time in the rollout report for this version and all target environments.
Clarify that field in rollout's existing report instructions.
Do not use cut time, merge time, or a soak restart time.
If the time is absent, invalid, or in the future, disable the time arm only.
The count arm remains valid when its journal evidence is complete.
Do not invent absent count evidence.
Put the version, rollout time, count, and unseen outputs first in every soak report.
Briefs clip prior summaries to 1500 characters and retain only 25 entries.
Read the full run journal or source comments when a brief omits required evidence.

Before the deadline, ordinary unseen output reports unsure.
At the deadline, all target environments must have the expected version and a complete rollout.
They must be ready, have no restarts, have clean logs, and show no regression against the baseline.
Absent, unreadable, or unauthorized health evidence never counts as clean.
An incomplete or unknown health check reports blocked with evidence and `Question:`.
No deadline grants access or approval for a live command.

Before healthy, search `bd list -l verify:live --status open,in_progress,blocked`.
Read candidate bodies before reuse. Match the source release bead, release version,
and every unseen output with its trigger and target environment.
Reuse one active follow-up that covers that set. A closed or unrelated bead does not qualify.
If no match exists, create one P2 task with `verify:live` and `discovered-from:<source bead>`.
Do not add `factory` or dispatch labels. Put all unseen outputs in this one task.
Use `--body-file`; use plain words and shell-safe single quotes for the title.
Never interpolate untrusted text into a command.
The body names the source bead, version, outputs, triggers, environments, and deferred checks.
Confirm the saved bead with `bd show` before reuse or completion.
If a search, read, create, or comment fails, report blocked; never infer success.
If no source bead exists, report blocked with a question for the manager.

Add the same evidence to the source bead comment and the soak summary before healthy:
version, rollout UTC time or its absence, count including this soak, deadline arm,
risk class, health evidence, unseen outputs, triggers, and the follow-up ID.
Mark each deferred check `not checked (not fired yet: filed <id>)`.
Do not mark an unseen check passed. Do not add ship's close or AC-ledger commands.
After a retry, inspect this evidence and reuse the same qualifying follow-up.

## Acceptance criteria

All named tests below belong in `factories/ship.test.ts`, which already imports release.
Run them with `bun test --timeout 30000 factories/ship.test.ts -t geo6`.
Tests pin complete policy sentences and their scope, not scattered tokens.
They validate the prompt contract; they do not prove model compliance.

| AC | Named test | Required positive and negative rows |
| --- | --- | --- |
| AC1 | `geo6 AC1 deadline evidence` | Current count 3 and age below 24h stays unsure; count 4 qualifies; age exactly 24h qualifies at count 1. Count includes prior blocked reports and this soak once. Exclude another version, pre-rollout reports, and bare retries. Missing, future, or invalid time cannot satisfy the time arm; count 4 still can. Unknown count cannot satisfy the count arm. |
| AC2 | `geo6 AC2 risk exceptions` | Ordinary known risk permits the exception. Each security marker, security-sensitive plan/bead, data migration, schema migration, explicit must-see-live AC, and unknown risk denies it. One exceptional constituent denies the whole release. Two consecutive unsure soaks block this class with output, trigger, and Question. Count 4 and age 24h cannot override it. |
| AC3 | `geo6 AC3 health gate` | Complete expected-version rollout, ready targets, no restarts, clean logs, and no regression permit follow-up. Incomplete rollout, wrong version, restarts, dirty logs, absent baseline, unreadable checks, and denied reads prevent healthy. Regression takes rollback before any deadline exception. An observed output retains the normal health path. |
| AC4 | `geo6 AC4 durable follow-up` | Exact active source/version/output/trigger/environment match reuses one bead. Closed beads, same version with another source, or absent outputs require a new complete follow-up. Failed search/read/create/comment prevents healthy. No source bead prevents healthy. Both report and source comment name the confirmed ID and each deferred check. No automatic dispatch label, AC ledger, or source close command appears. |
| AC5 | `geo6 AC5 scope and routes` | Release soak alone gains verify:live policy. Rollout only clarifies its existing time field. Ship policy, owner-only rules, merge gates, rollback prompt, node settings, and edges stay unchanged. Three unsure outcomes then healthy visit four soaks and done; regressed visits rollback. |

AC5 also updates `3w8o AC4 only soak carries the deadline rule`.
Exclude release soak from its blanket prohibition; retain the prohibition for every other release node.
Use `factory check factories/release.ts` to prove the definition remains valid.
There is no new parser, validator, or executable guard.
A shell grammar, Kustomize parser, and new downstream tool adapter are out of scope.
Prompt tests must not substitute a test-only policy engine for the actual prompt.

## Test plan

First commit the geo6 contract tests. Record their failures against the unchanged release prompt.
Keep both commits in one PR. Do not ship a PR with red required checks.
Then change the prompts and the existing scope assertion.

After the implementation commit, use `factory mutate <file:line> <old> <new> -- <test command>`.
Each mutant must build and exit 0 from `factory mutate` because the focused test fails.
Mutate each clause alone in `factories/release.ts`:

| Mutation | Test that must kill it |
| --- | --- |
| M1: change fourth soak to fifth | AC1 |
| M2: change 24 hours to 48 hours | AC1 |
| M3: exclude the current soak | AC1 |
| M4: count another release or use merge time | AC1, separate mutations |
| M5: let absent time satisfy elapsed time | AC1 |
| M6: remove each risk exception or the unknown-risk rule | AC2, one mutation per exception |
| M7: permit one exceptional constituent | AC2 |
| M8: remove each health prerequisite or accept unreadable health | AC3, one mutation per prerequisite |
| M9: let regression use healthy at the deadline | AC3 |
| M10: remove each source/version/output/trigger/environment match | AC4, one mutation per field |
| M11: permit healthy after each failed bead operation | AC4, one mutation per operation |
| M12: omit the confirmed ID from either durable record | AC4, separate mutations |
| M13: add the factory label to the follow-up | AC4 |

Run the full factory tests, repository typecheck, and Prettier 3.9.9.
Run `bun run test`, `bun run typecheck`, and `bunx prettier@3.9.9 --check .` before handoff.
Run `bun audit`, the made-worse gate, and `gitleaks detect --log-opts=origin/main..HEAD`.
Record local tool gaps. Required CI test, plugin, typecheck, and format checks must pass on the PR head.

## Risk

This change is security-sensitive because it relaxes a release guard.
The exception must never bypass a security check or grant infrastructure access.
Prompt tests cannot prove future agent conduct; security review must check the whole rule.
No schema, stored state, credentials, or production data change.
Old runs retain their pinned factory. No migration is necessary.
Security-sensitive: yes (release guard and infrastructure access)

## Rollout and rollback

A person merges the reviewed PR. Existing release runs keep their pinned definition.
New release runs receive the new policy. No flag or live switch is necessary.
Rollback uses a revert PR with a person's merge; it restores the former prompt for future runs.
Keep follow-up beads and source comments after rollback.

## Observability

No new metric is necessary. Future journals must show the count, time source, deadline arm,
health evidence, deferred checks, and one confirmed follow-up ID before deadline-based healthy.
Ship soak checks a new release run's prompt and its report when that path occurs naturally.
If this guard change has not fired, do not force a production release to test it.
AC2 is must-see-live for this guard change: soak must see the protected path retain its block.
Its own soak cannot use the deadline exception. Pre-merge checks use fixtures only.
Live observation belongs to soak, with existing access rules; it is not a pre-merge acceptance gate.

## Tasks

1. `claude-factory-geo6.1`: Add AC1-AC5 contract tests and route fixtures. Commit the tests first; record the expected policy failures.
2. `claude-factory-geo6.2`: Change release soak and rollout time text. Update the scope assertion. The release step owns the changelog.
   Run focused tests, mutations, definition validation, and required repository checks. Commit the complete fix.

These two tasks fit one 120-minute implement pass and one PR.
No dependency on the separate ship follow-up fix is necessary.

## Rejected alternatives

- Copy ship's AC ledger: release has no ledger or queue-close contract.
- Copy ship verbatim: its count, match, and unreadable-health clauses have known gaps.
- Add runner state or a common module: the journal already holds the required history.
- Block all unseen output forever: this preserves the original stall for ordinary changes.
- Treat missing telemetry as clean: this permits false health reports.
