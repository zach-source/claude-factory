# Preserve owner and parent holds

Status: accepted plan for `claude-factory-jmvx`.

## Context

At `18a9a04b`, three paths omit hold checks.
`src/cli.ts:9089` refuses patrol queue and start requests for hold labels, but excludes `owner`.
`src/beads.ts:247` permits an orphan child without a parent hold check.
`src/cli.ts:10383` supplies held candidates to the PM.
The same files at `origin/main` (`42254bcd`) have no changes from this baseline.

Dispatch already checks the child's owner label, `owner_decisions`, and other hold labels at `src/cli.ts:10063`.
Explicit person queue commands remove hold labels and owner hand-off metadata at `src/beads.ts:427`.
They do not remove `owner_decisions`.
This plan preserves that authority split.

## Decision

Use one fail-closed eligibility rule within these entry points:
Automation must not release a target hold or select work whose required direct parent has a hold.
An unknown required parent cannot supply permission to start its child.
The presence of `factory` on either bead never overrides a hold.

Extend `isHoldLabel` in `src/beads.ts` to include exact `owner`.
Retain exact `human`, exact `rejected`, and the case-sensitive `held:` prefix, with any suffix, including empty.
Keep `isOwned` separate: it means truthy `metadata.owner_decisions`.
Do not change `isHandedOff`, which also needs an owner question.
The owner label alone must protect a hand-off.

Extend `isOrphanChild` to refuse a direct parent with a hold label or `isOwned(parent)`.
Use the existing parent map. Preserve absent-parent, live-parent, assignment, and factory-label rules.
This shared rule covers dispatch and PM candidates without extra `bd` calls.
In `rigFacts`, filter the candidate's own hold labels before the 40-candidate cap.
Retain the existing owner, open-child, and Linear filters.
The patrol target check uses the shared label predicate; preserve its existing ancestor discovery checks.
The patrol also refuses a direct parent with a hold label or `owner_decisions`.

Files: `src/beads.ts`, `src/cli.ts`, and the four test files in AC1 through AC4.
No new module, dependency, flag, or factory definition is necessary.
Release owns the changelog entry.

This change adds no parser or shell-command grammar.
It reads existing `Bead.labels`, `Bead.parent`, `Bead.id`, `Bead.metadata.owner_decisions`, and existing linked-run state.
Labels use literal, case-sensitive comparisons; absent labels mean no label hold.
The direct parent ID uses the existing exact map lookup; an absent map entry denies orphan eligibility.
No path, command string, title, or description supplies authority.
Keep the existing patrol lookup failure, cycle, and eight-record ancestry limit checks.

Out of scope: recursive hold inheritance beyond the direct parent, arbitrary malformed bd JSON, and new status-based holds.
Also out of scope: patrol identity isolation, person commands, shell hooks, auto-queue policy, and a general ancestry resolver.
The existing patrol ancestor walk remains a discovered-from check; this task does not expand it into recursive hold inheritance.
The rule does not claim to stop a concurrent label change after the snapshot read.

Reject prompt-only controls because dispatch must enforce the rule without model cooperation.
Reject separate owner label checks in each path because the shared predicate already represents label holds.
Reject a dispatch-only parent check because the PM would still select the same child.
Reject new per-candidate parent subprocesses because the existing map has the necessary records.

## Acceptance criteria

Use isolated homes and fake bd fixtures. Prefix new test names with `jmvx AC`.
Never use production queue commands as a test.

AC1. `jmvx AC1 patrol target holds` in `src/hygiene-cli.test.ts` proves patrol queue refusal before any bd update.
Run `bun test --timeout 30000 src/hygiene-cli.test.ts`.
With `FACTORY_PATROL=1`, deny `owner`, `human`, `rejected`, `held:`, `held:station`, and `held:cluster:acme`.
Test each label alone and with `factory`. Include `owner` without `owner_question` or `owner_decisions`.
Each denial must exit nonzero, identify the hold, and make zero bd writes.
Through the shared start guard, test an owner-labeled named bead with patrol `start`; assert zero run creation and claim writes.
Allowed controls: no hold, `ownerish`, `Owner`, `humane`, `held`, and `rejected-by`, subject to existing discovery rules.
Existing unknown-target, unreadable-parent, cycle, depth, and discovered-from tests must still pass.

AC2. `jmvx AC2 person queue authority` in `src/hygiene-cli.test.ts` proves the same label rows permit explicit person queue.
Use the AC1 command without patrol identity in the isolated fixture.
Assert that the update removes the hold and adds `factory`.
For owner hand-offs, assert removal of `owner_question` and `owner_since`.
Assert that queue does not clear `owner_decisions`; dispatch must still refuse that metadata-controlled bead.
Run the hygiene test command and `bun test --timeout 30000 src/dispatch.test.ts src/beads.test.ts`.

AC3. `jmvx AC3 parent holds` in `src/dispatch.test.ts` and `src/beads.test.ts` proves direct parent protection.
Run `bun test --timeout 30000 src/dispatch.test.ts src/beads.test.ts`.
Use each AC1 hold label on the parent, plus a separate truthy `owner_decisions` row without hold labels.
Test child-only `factory`, parent-only `factory`, and both labels where the existing fixture exposes inherited ready rows.
Give the parent no live run, so a live-run check cannot hide a missing hold check.
Dispatch must create zero child runs and zero child claims. It must not clear either bead's hold.
Its `dispatch.json` row must identify the skipped child and its parent; the existing `child of <id>` reason is sufficient.
Also test with `FACTORY_PRECHECK=0`; that switch must not disable hold checks.
Allowed controls: an unheld parent, and each AC1 lookalike label, retain orphan-child eligibility.
Keep absent parent, live parent, assigned child, and neither-bead-labeled rows denied.
Keep direct child hold and direct `owner_decisions` rows denied.

AC4. `jmvx AC4 plan candidates` in `src/plan-cli.test.ts` proves PM candidate exclusion through `factory plan facts`.
Run `bun test --timeout 30000 src/plan-cli.test.ts`.
Exclude every AC1 hold row on a candidate and every AC3 direct parent hold row.
Retain eligible unheld candidates and lookalike labels.
Put at least 40 held rows before an eligible row; the held rows must not consume the candidate cap.
Assert both output and saved facts exclude held candidates.
Assert zero bd writes and zero new per-candidate `bd children` or parent lookup calls.
Preserve existing owner metadata, open-child, Linear, title sanitization, and plan-order tests.

AC5. Final evidence must cover the complete pull request head.
Run `bun test --timeout 30000 src factories`, `claude plugin test mod`, and `bun x tsc --noEmit -p .`.
Run `bun run format:check`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Run the factory's made-worse gate. Record its result and any local tool gap.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final head.
CI uses the root typecheck; generated mod types are not necessary for this change.
After the fix commit, use `factory mutate <file:line> <old> <new> -- <test command>`.
Independently remove owner label protection, parent label protection, parent owner metadata protection, and the PM target hold filter.
Each mutant must build and fail the relevant AC assertion. Record exit 0 from each killed mutant and a restored clean tree.

## Test plan

Commit AC1 through AC4 tests first. Record red baseline assertions for all three reported gaps before source edits.
Do not count a fixture crash or a missing tool as a red regression proof.
Use the existing fake bd command logs, `runDirs`, and saved plan facts as the oracles.
Strip worker outbox variables and use `FACTORY_SELF_UPDATE=0` in subprocess fixtures, as existing tests do.
Commit the minimal source fix second. Keep both commits in one draft pull request.
No required check can remain red at handoff to approval.

## Risk

This change is security-sensitive because it protects owner authority and automated dispatch permissions.
The shared predicate also affects named patrol start requests; AC1 covers that path.
Children of held direct parents now wait even when their own factory label is present.
That is the intended compatibility change. A person must release the parent hold before dispatch selects the child.
No stored data, schema, migration, credentials, or infrastructure access changes.
The person queue path retains its current behavior. Rollback reopens these authorization gaps.
Security-sensitive: yes (owner authority and dispatch permissions)

## Rollout and rollback

Use one draft pull request with review and security on its final head. A person merges it.
Use the normal release process. No flag or migration order is necessary.
The CLI process must use the new revision before the checks take effect.
If release needs an owner-only manager restart, surface that exact step; this run does not perform it.
Rollback uses a revert pull request, a person's merge, and the normal release process.
Do not alter holds or owner metadata to undo the code.

## Observability

Use patrol refusal text, `dispatch.json` skip rows, and `factory plan facts` candidate IDs.
Add no metric or log stream. Do not log bead descriptions or owner question text.
Ship soak confirms the release revision and repeats the regression suite against that artifact in an isolated home.
Ordinary dispatch skip rows can provide extra evidence when available through an authorized read.
No AC is must-see-live. Do not create live holds or queue real owner work for a probe.

## Tasks

1. `claude-factory-jmvx.1`: regression tests, one commit, 35 minutes. Check AC1 through AC4 against the baseline.
2. `claude-factory-jmvx.2`: guard changes, one commit, 55 minutes. Check AC1 through AC5 and record mutation proof.

Task 2 depends on task 1. Reserve 30 minutes for final checks and the draft pull request.
Both tasks fit one 120-minute implementation pass. No external code dependency is necessary.
No known bug becomes worse through this plan. No separate work was filed.

## Plan evidence

The tracked root has no CLAUDE.md, AGENTS.md, or CONTRIBUTING.md.
Plan read README.md, package.json, CI commands, an existing ADR, the guard code, tests, and the bead history.
The bead had no children, and the branch had no pull request.
The memory search returned no local notes. One wildcard file search hit a hook denial; no bypass was attempted.
`bun install --frozen-lockfile` passed without a lockfile change.
Plan changes only this ADR. Implement must supply red regression and mutation evidence.
The four-file baseline test command passed: 187 tests, zero failures, 840 assertions, 218.91 seconds.
Its first attempt reached the command's 60-second limit; the complete repeat had a 240-second limit.
The root typecheck, ADR Prettier check, and `git diff --check` passed.
Plan did not run the full source suite, plugin suite, audit, secret scan, package build, or production checks.
