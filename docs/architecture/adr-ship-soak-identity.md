# ADR: Match ship soak follow-ups and count the current soak

## Context

Source bead: `claude-factory-v5eq`. Baseline: `871bf05a`.
The soak rule at `factories/ship.ts:161` matches a follow-up by release alone.
It does not state that the current soak counts toward the fourth-soak deadline.
Bead comments also require unreadable-health rules and two prohibition tests.
The existing 134 ship and lifecycle tests pass without these protections.

## Decision

Change only the ship soak prompt and its contract tests.
Extend the lifecycle contract test; keep the lifecycle prompt unchanged.
Use the existing journal and bead links. Add no runtime state, dependency, or parser.

The deadline exception remains one fail-closed rule.
Permit healthy with unseen output only for ordinary risk, a passed deadline, complete health evidence, and a matching follow-up.
Unknown risk remains must-see-live. Unreadable health never counts as clean.
The deadline grants no permission for a live read or an owner action.

Require an open `verify:live` bead with the same release, unseen output, and `discovered-from:<bead>` source.
Read candidate details and dependencies before reuse.
All three identities must match; release identity alone is insufficient.
If no match exists, use the existing create command and body-file rule.
Keep its P2 priority, `verify:live` label, source dependency, and absence of the `factory` label.
Keep the deferred AC ledger and follow-up ID in the close reason.

Count prior unsure and blocked soak reports for this release since deploy, plus the current soak exactly once.
Exclude other releases, reports before deploy, and worker retries without a soak report.
Keep the deadline at count four or 24 hours after deploy, whichever occurs first.
State the current-inclusive count and matched follow-up ID in the soak report when the deadline applies.

State that absent or unreadable rollout or log evidence is not clean.
At the deadline, this state reports blocked with the missing output, trigger, and `Question:`.
Preserve the existing regression path and must-see-live prohibition.

## Acceptance criteria

These criteria test prompt contracts, not model compliance.
Use sentence-local assertions with `soakSentence`; do not accept tokens from unrelated sentences.
Use complete sentence equality where a substring can survive removal of a requirement.
Tests belong in `factories/ship.test.ts`, except AC4 in `factories/lifecycle.test.ts`.
Run `bun test --timeout 30000 factories/ship.test.ts factories/lifecycle.test.ts` for AC1-AC5.

| AC | Test name | Required cases and exclusions |
| --- | --- | --- |
| AC1 | `v5eq AC1 follow-up identity` | Allow reuse only for an open verify:live bead with matching release, output, and source dependency. Reject another release, another output under the same release/source, another source under the same release/output, absent dependency, and closed beads. Pin candidate reads and all three requirements in the reuse sentence. No match retains the existing create path. |
| AC2 | `v5eq AC2 current soak count` | Pin prior unsure and blocked reports plus this soak exactly once. Two prior reports plus this soak give three: before 24 hours, remain unsure. Three prior reports plus this soak give four: the deadline qualifies. Exactly 24 hours qualifies at count one. Other releases, pre-deploy reports, and retries without reports do not count. Pin count evidence in the report instruction. Retain the existing four-soak route test. |
| AC3 | `v5eq AC3 unreadable health blocks` | Complete rollout, no restarts, clean logs, and no regression permit the ordinary deadline path. Absent or unreadable rollout evidence, absent or unreadable logs, incomplete rollout, and dirty logs prevent healthy. Pin the unreadable-health rule and the blocked result with output, trigger, and Question. An unauthorized read cannot supply health evidence; the deadline grants no access. Actual regression retains the regressed edge. |
| AC4 | `v5eq AC4 plan forbids must-see-live deadline` | Pin the complete observability sentence that ends with `the soak then never uses its deadline.` Permit this requirement only in the plan prompt. Removing `never` must fail. Retain ship's unknown-risk and security-sensitive exclusions at count four and 24 hours. |
| AC5 | `v5eq AC5 shell quote prohibition` | Pin the complete sentence `Do not use double quotes: bash expands $(...), backticks and $VAR in them.` Use soakSentence. Retain the single-quote escape rule, plain title, body-file, no factory label, and deferred AC ledger tests. Removing the sentence or its prohibition must fail. |

AC1-AC3 define the behavior of future ship runs and their journals.
The journal must show a current-inclusive count and a follow-up with all three identities.
Unreadable-health reports must show blocked, never deadline-based healthy.
No new parser or executable guard exists. Shell grammar expansion and bead-store validation are out of scope.
Do not add a test-only policy engine to simulate agent decisions.

## Test plan

First add the contract tests and record the expected failures against unchanged prompts.
AC1-AC3 must expose the current defects. AC4 and AC5 initially pass because their prompt rules already exist.
Then change the ship prompt. Keep both commits in one PR; final required checks must pass.
Preserve existing `3w8o` and `geo6` tests, with focused updates where old wording changes.

Commit the fix before mutations. Use this command form with exact source text and the current line number:

```text
factory mutate <file:line> <old> <new> -- bun test --timeout 30000 factories/ship.test.ts factories/lifecycle.test.ts
```

Each row is a separate mutation. Each mutant must build, fail its contract test, and return factory mutate exit 0.
Use a `.scratch/` script for command arguments with shell metacharacters.

| Row | Mutation | Required failure |
| --- | --- | --- |
| M1 | Remove the same-release requirement from the reuse sentence. | AC1 |
| M2 | Remove the same-output requirement from the reuse sentence. | AC1 |
| M3 | Remove the discovered-from requirement from the reuse sentence only. | AC1 |
| M4 | Replace the current-soak clause with exclusion of this soak. | AC2 |
| M5 | Change exactly once to twice in the current-soak clause. | AC2 |
| M6 | Change fourth soak to fifth soak. | AC2 |
| M7 | Allow unreadable rollout evidence to count as clean. | AC3 |
| M8 | Allow unreadable log evidence to count as clean. | AC3 |
| M9 | In lifecycle.ts, replace `the soak then never uses its deadline` with `the soak then uses its deadline`. | AC4 |
| M10 | Delete the complete double-quote prohibition sentence from ship.ts. | AC5 |
| M11 | Replace `Do not use double quotes` with `Use double quotes`. | AC5 |

Also run `factory check factories/ship.ts` after the prompt edit.
Run `bun run test`, `bun run typecheck`, and `bunx prettier@3.9.9 --check .`.
Run `bun audit`, the brief's made-worse gate, and `gitleaks detect --log-opts=origin/main..HEAD`.
Record local tool gaps. Required test, plugin, typecheck, and format CI must pass on the final PR head.

## Risk

This change is security-sensitive because it changes the release health gate and protects shell quote rules.
Tests prove prompt text, not future agent conduct. Security review must check the full exception.
No credentials, stored state, schema, or production data change. No migration is necessary.
Existing runs retain their pinned definitions.
Security-sensitive: yes (release guard and shell quote rules)

## Rollout and rollback

A person merges the reviewed PR. New ship runs receive the revised definition.
No flag, migration, or live switch is necessary. Do not alter this run's pinned factory.
Rollback uses a revert PR and a person's merge. Existing follow-up beads remain valid records.

## Observability

Use future ship journals and follow-up bead details; add no metric or production probe.
Observe the count, source dependency, output identity, and missing-evidence result when these paths occur naturally.
AC3 is must-see-live for this security-sensitive change: its soak must observe the protected block with unavailable health evidence.
Do not cause an outage or revoke access to create that case.
If the case has not occurred, follow must-see-live policy and request the needed evidence.
This change's own soak cannot use the deadline exception.
Live evidence belongs to soak, under existing access rules, never to a pre-merge acceptance gate.

## Tasks

1. `claude-factory-v5eq.1`: Add AC1-AC5 contract tests. Commit the tests first and record baseline failures.
2. `claude-factory-v5eq.2`: Change the ship prompt. Commit the fix, kill M1-M11, and complete the stated checks.

Task 2 depends on task 1. Both tasks fit one 120-minute implement pass and one PR.
Release owns its normal changelog entry. Plan commits only this ADR.

## Rejected alternatives

- Match release only: one release can contain several outputs and source beads.
- Match output without source: another worker's follow-up can hide this bead's check.
- Count only journal entries: the fourth soak has no report yet and waits for a fifth soak.
- Add runtime state or copy all release.ts policy: neither is necessary for this bounded prompt fix.
- Treat unreadable telemetry as clean: the exception would permit false health reports.
