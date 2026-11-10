# ADR: Preserve backup contents and parent continuity

## Context

Bead: `claude-factory-ohn03`. Plan base: `81d9602d41529762b5470d07579315322d795a2c`.

The original CI job failed at the final parent assertion in `src/homebackup.test.ts:151`.
The same head passed on retry, without a source change.

- [Failed job](https://github.com/zach-source/claude-factory/actions/runs/42799399772/job/129772756308): 17917 pass, 3 skip, 1 fail.
- [Retry](https://github.com/zach-source/claude-factory/actions/runs/42799399772/job/129778099726): 17918 pass, 3 skip, 0 fail.

Plan reproduced a parent mismatch on unchanged code with Git 2.56.0, Bun 1.4.4, and gitleaks 8.30.1.
The first 10 isolated runs passed. Run 11 failed in the row with an existing remote ancestor.
A scratch copy then reproduced the absent parent in the empty-remote row, after two passes.
The probe read the backup result before the parent query:

- `next.error` was absent; `next.changed` was `false`.
- `next.sha` equaled the previous successful backup SHA.
- The work tree file held `[2]`; the index and HEAD held `[1]`.
- The remote retained its previous tip. No new commit existed to supply the expected parent.

A second probe reproduced the mismatch in the existing-ancestor row after five passes.
Its cached file time was `1794314894:693090811`.
The work tree mtime was `1794314894980.1187` milliseconds.
The index mtime before backup was `1794314894837.0193` milliseconds.
The file and cached entry had size 3 and the same inode.
Thus, these failures involve a missed same-size file change, not proof of remote history deletion.
They do not prove that the original CI failure had the same cause.

Git describes same-size edits and timestamp granularity as a stat-cache hazard.
It also describes index safeguards for that hazard. See [Git 2.56.0 technical documentation](https://github.com/git/git/blob/v2.56.0/Documentation/technical/racy-git.adoc).
Implementation proved the operation with a controlled coarse stat cache and a racy index timestamp.
Direct `git add` read the changed bytes from a copy of that index.
`git rm --cached home/memory` before the add rewrote the index and hid the changed bytes.
The later `read-tree` did not restore that check.
The new `ohn03` regression failed with `changed=false` before the fix.
The snapshot now stages home files before that index rewrite, after the dream marker update.
It then replaces memory entries through the existing alternate index.
This keeps the dream marker, memory exclusions, and staged scan under the same snapshot contract.
No index rebuild or extra content scan is necessary.
The controlled case proves this operation can cause the failure; the original CI cause remains unknown.
Do not infer a Git version defect or a load timeout from these observations.

Plan also tried an uncommitted scratch change that placed the main add before the memory snapshot.
Two runs passed; the third returned `gitleaks exit null` during the concurrent full-suite run.
That experiment proves neither a fix nor a cause. It is not the selected design.

## Decision

Fix the missed snapshot change at its proved source. Keep the backup protocol and history rules.
First add complete outcome assertions and a controlled regression in `src/homebackup.test.ts`.
Then make the smallest necessary correction in `src/homebackup.ts`.
Use the existing Git interface and test fixtures. No dependency, public API, flag, or new service is necessary.

The regression must identify the cache/index operation with a controlled input or causal comparison.
Prefer an existing Git primitive that refreshes the required content without a broad index rebuild.
The final code choice depends on that proof; a timestamp hypothesis alone does not authorize a speculative rewrite.
If the evidence identifies a different source, record that evidence and update this ADR before the fix.
Keep this work within one implementation pass of 120 minutes.
If no controlled cause emerges within 40 minutes, mail the manager with the results and the remaining question.
Do not report diagnostic assertions alone as a completed fix.

The snapshot must remain under the existing lock.
The scan, redaction, compression, commit, and push must consume staged data after the lock release.
Memory must remain plain files in the backup, with the correct dream marker.
The correction must retain exclusions, secret checks, and fast-forward-only push behavior.
No guard or parser grammar changes belong to this plan.
Auth, restore policy, backup scheduling, worker hooks, and `.factory/` changes are outside scope.

Rejected alternatives:

- Remove the parent assertion or change `[2]` to a longer fixture: either can hide the missed snapshot.
- Add a sleep, retry, or larger timeout: no evidence shows that those changes correct the snapshot contract.
- Force a push or recreate the remote branch: that puts accepted history at risk.
- Unconditionally rebuild every index or rescan every blob: first prove why a smaller correction cannot work.
- Move the memory snapshot without further checks: that can omit a newly written dream marker from the backup.
- Rewrite reconciliation because a parent query failed: a backup can omit the commit before reconciliation starts.

## Acceptance criteria

### AC1: Identify the missed change and expose each outcome

Extend `d289.20` and add a regression named `ohn03` in `src/homebackup.test.ts`.
Check the optional initial backup, rejected backup, replacement backup, and final backup before dependent Git queries.
Check the hook copy exit code before use.
Successful results must have no error or skip and a nonempty SHA.
The rejected result must remain a push error, not an unrelated scan or process error.
Keep every original assertion and both remote-history rows.

Record the failing operation, relevant file/index facts, and a causal control in the bead.
The regression must fail on pre-fix code and pass with the correction.
Use controlled Git/filesystem state or an existing test seam; do not use elapsed sleeps as the correctness oracle.
Negative controls: unchanged content remains unchanged; an explicit backup failure never counts as a successful snapshot.
Do not print credentials, environment dumps, real backup contents, or raw production command output.

Proof commands:

```sh
nix shell nixpkgs#git -c bun test --timeout 30000 src/homebackup.test.ts -t ohn03
nix shell nixpkgs#git -c bun test --timeout 30000 src/homebackup.test.ts -t d289.20
```

### AC2: Preserve contents and accepted history

For an empty remote, the fixed replacement must be a root commit without the rejected commit.
For an existing remote, its parent must equal the accepted tip before rejection.
In both rows, the next changed backup must produce a new tip whose parent equals the replacement SHA.
Assert that the final remote file contains `[2]` and that `next.sha` equals the remote tip.
Assert that the rejected commit is not an ancestor of the replacement or final tip.
Assert that an existing accepted tip remains an ancestor of the final tip.
Keep the `[1]` replacement-tree assertion and the `changed: true` assertion.
Unchanged content must keep the same tip and return `changed: false` without an error.
No successful case can use a force push or drop accepted ancestors.

Proof: the AC1 commands and the existing no-change test in the full `homebackup.test.ts` file.
After the fix commit, use `factory mutate <file:line> <old> <new> -- <regression command>`.
The buildable mutant must undo the fix alone, and the regression must kill it.

### AC3: Preserve refusal and snapshot boundaries

Run all of `src/homebackup.test.ts` without weaker assertions.
Keep unready homes, incomplete restores, nested home repositories, and missing scanners denied.
Keep rejected or divergent remote pushes denied without force.
Keep credentials and excluded paths out of the remote tree.
Keep plain and encoded secret redaction, memory snapshots, compression, and restore byte equality intact.
Keep held-lock skips, post-lock work tree isolation, and unchanged backups allowed as before.
Keep remote access failures distinct from an absent branch.

Proof: `nix shell nixpkgs#git -c bun test --timeout 30000 src/homebackup.test.ts`.
Use synthetic data and local bare remotes only.

### AC4: Check repeat runs and the full suite

Run `d289.20` in 30 fresh Bun processes with Git 2.56.0. All 30 must pass without retry.
Record versions, run count, exit codes, and failures before and after the fix.
Use a scratch script for the loop. Stop on failure and preserve its safe diagnostic facts.
Run the full source suite, not only the isolated test:

```sh
nix shell nixpkgs#git -c bun test --timeout 30000 src factories
claude plugin test mod
bunx tsc --noEmit -p .
bunx prettier@3.9.9 --check .
gitleaks detect --log-opts=origin/main..HEAD
bun audit
```

Install dependencies with `bun install --frozen-lockfile` first.
Use the repo test prerequisites. Record local dependency gaps separately from assertion failures.
CI adds `PKGGATE_E2E_REQUIRE=1` and `PG_SCRATCH_REQUIRE=1` to the source-suite command.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final PR head.
Do not fabricate plugin engine type files to run `tsc -p mod`; CI omits that command.
If a broad index rebuild is necessary, compare the large-file test duration before and after it under the same conditions.
This is a correctness fix, not an optimization target.

### AC5: Keep failures visible without new sensitive output

The corrected successful backup must retain the existing `home/backup.json` contract.
Its recorded SHA must equal the remote tip; its error must be absent.
A failed scan or push must retain an error and must not claim a new remote backup.
The existing no-change/record test and refusal tests prove these rows.
Add only the smallest assertion needed if the regression reveals a gap in that coverage.
Do not add raw file, token, Git environment, or remote URL output to production logs.

## Risk

This is security-sensitive backup code because the snapshot feeds secret scans and remote infrastructure access.
An incorrect index correction can omit current files, bypass redaction, or retain rejected content.
An incorrect reconciliation change can discard accepted history.
A broad index rebuild can increase lock duration and scan cost for large homes.
Keep the existing scan and history checks. Prefer a fix confined to the proved cache operation.
No stored schema, remote branch format, public API, or credential change is necessary.
No database migration applies. Existing backups must remain restorable.
Security-sensitive: yes (backup snapshot, secret scan, and remote access)

## Rollout and rollback

Use one draft PR with the tests commit first and the fix commit second.
The final PR must pass all required checks. Do not ship a red tests-only PR.
A person must merge after verify, review, and security.
Use the normal release path. No new flag or migration order applies.
Do not delete, recreate, or force-update a backup branch.
If rollback is necessary, open a revert PR for a person to merge.
Rollback restores the snapshot defect; it must not alter backup data or remote refs.
Any live manager restart remains an owner step with exact approval.

## Observability

Use the existing backup result, `backup.json`, backup age, and backup error checks.
Ship soak must report the released revision and backup health through its permitted checks.
Where authorized, compare two successful backup SHAs after a normal state change and check their ancestry.
Do not insert synthetic edits into a live home or read private backup contents to satisfy this plan.
No AC is must-see-live. Disposable local remotes prove content and ancestry before merge.
Live reads belong to ship soak or the owner; they are not pre-merge acceptance gates.

## Tasks

1. `claude-factory-ohn03.1`: Prove the stale index cause and commit AC1/AC2 regression tests. Budget: 40 minutes.
2. `claude-factory-ohn03.2`: Correct the proved operation and commit the fix with AC1 through AC5 evidence. Budget: 80 minutes.

Task 1 blocks task 2. Both tasks belong in one PR. No external merge blocks this plan.
[PR #822](https://github.com/zach-source/claude-factory/pull/822) also edits `homebackup.test.ts` for the large-file test.
Check its state before the final merge from main and preserve both changes if it lands.
Do not absorb its timeout work or wait for it without a concrete dependency.
Plan commits only this ADR. Scratch probes and logs remain untracked.

## Implementation checks

The resumed implement station checked commit `0153f488` with Git 2.56.0 and Bun 1.4.4.
All 30 fresh-process `d289.20` repetitions passed without retry.
The complete home backup suite passed: 34 tests, zero failures.
The plugin suite passed: 238 tests, zero failures.
Typecheck, Prettier 3.9.9, gitleaks 8.30.1, and `bun audit` passed.

The `ohn03` regression killed two buildable mutants at `src/homebackup.ts:170`:

- Replace the home add with `git status --porcelain`.
- Insert the memory index removal before the home add.

The second mutant restores the proved index rewrite order.
Both mutants returned `changed=false`; the regression required `changed=true`.
The mutation tool restored the source after each test.

All five CI checks passed at `0153f488`, which includes the main merge:
[CI run](https://github.com/zach-source/claude-factory/actions/runs/42827327819).
The final PR head must also pass the required checks.
