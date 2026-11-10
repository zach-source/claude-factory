# ADR: Lock memory and wiki commands before git access

## Context

Bead: `claude-factory-ot1ew`. Plan base: `ba2a3771`.

Five memory command paths call `commitMemory` without `dream.lock`.
Wiki find and status call `wikiGit` without `wiki.lock`.
A concurrent agent pass can change git metadata before its post-pass guard restores it.

Current defenses already include `NO_HOOKS`, `repoConfigOk`, and post-pass metadata checks.
An absent fsmonitor marker alone does not prove that a command took the lock.
The oracle must include zero git calls from the refused command.

The proposal file path is `proposals install` for a non-core rung, not a separate `proposals file` verb.
The security comment on the bead also describes a process death before metadata restoration.
Existing pre-pass checks cover that case in part. Persistent recovery snapshots remain outside this concurrency fix.

## Decision

Use the existing `hold` function in `src/cli.ts:5130`.
Acquire `dream.lock` before each skill or proposal mutation, proposal read for installation, and bead creation.
Hold it through `commitMemory` and the command result. Release it in `finally`.
Acquire `wiki.lock` before `wikiFind` or `wikiStatus`. Release it in `finally`.
Validate command syntax and preserve worker and patrol refusals before protected work.

If acquisition fails, print `memory: busy` or `wiki: busy` on stderr and exit with code 1.
Do not print a success result, page rows, or status JSON on that path.
Do not wait for the pass. The caller can retry after it ends.

The fail-closed rule covers every repository operation in these seven command paths.
Without ownership of the matching pass lock, the command must do no repository work or external effect.
This includes git config inspection, mutations, and proposal bead creation.
Keep the lock until all protected work ends; a prior observation that the lock is free is insufficient.

Do not add a lock inside `commitMemory` or `wikiGit`: existing pass callers already own their locks.
Do not change lock names, stale-lock recovery, git flags, config validation, or the post-pass guards.
Update the two wiki tests that explicitly require access during a held lock.
Update nearby comments that claim these commands take no lock.

Expected files:

- `src/cli.ts`: command lock scopes and obsolete comments.
- `src/memory-proposals.test.ts`: memory command regression tests, with existing fixtures where practical.
- `src/cli-wiki-find.test.ts`: wiki lock tests and success controls.
- `src/memory-dream-gitdir.test.ts`: the paused dream overlap test.
- `src/cli-wiki-groom.test.ts`: the paused groom overlap test.

Prefer existing fixtures. A dedicated test file is acceptable only if process isolation needs it.
Do not add a production abstraction for one caller, a dependency, a flag, or a factory definition change.

Rejected alternatives:

- `isHeld` alone: a pass can start after the check and before git access.
- Lock only `commitMemory`: file changes and bead creation occur before the commit; pass callers also already own the lock.
- Rely only on git flags or the config allow-list: concurrent metadata changes still cross the pass boundary.
- Wait for a pass: a command can block for 45 minutes.
- Reject all memory reads: list commands do not need this git exclusion.
- Extend post-pass recovery here: it does not close the active-pass window and exceeds this task.

No new parser reads shell text, git config, lock fields, or path syntax.
The existing CLI grammar and `hold` implementation remain authoritative.
No new closed grammar is necessary. General shell parsing and arbitrary git metadata validation are out of scope.

## Acceptance criteria

Use `ot1ew` in each new test name.
Run the focused command below for AC1 through AC5:

```text
bun test --timeout 30000 src/memory-proposals.test.ts src/cli-wiki-find.test.ts src/memory-dream-gitdir.test.ts src/cli-wiki-groom.test.ts -t ot1ew
```

AC1. `ot1ew memory busy matrix` must cover all five memory paths with a live holder of `dream.lock`:

| Command | Fixture |
| --- | --- |
| `skills install sample` | Valid pending skill |
| `skills reject sample reason` | Valid pending skill |
| `proposals install sample` | Valid core proposal |
| `proposals install sample --rig widget` | Valid non-core proposal and fake bead tool |
| `proposals reject sample reason` | Valid pending proposal |

Each row must return code 1, emit `memory: busy`, and leave stdout empty.
Assert zero git calls, zero bead creation calls, unchanged proposal and skill bytes, and unchanged CORE.md.
Assert that the original lock owner remains intact.
Use a subprocess call recorder after fixture setup; an absent marker file alone is insufficient.
Neither worker nor patrol inputs gain permission: retain their current refusals, with zero protected effects.

AC2. `ot1ew wiki busy matrix` must cover `wiki find sample` and `wiki status` with a live `wiki.lock` holder.
Each row must return code 1, emit `wiki: busy`, and leave stdout empty.
Assert zero git, gh, and bd calls, unchanged wiki files, and unchanged lock ownership.
Replace both old `AC7 ... takes no wiki.lock` assertions with this stronger exclusion contract.
Keep malformed-input code 2 and worker refusals. Neither case may call git.

AC3. `ot1ew pass overlap` must exercise a real CLI dream and a real CLI groom with fake agent processes.
Each fake agent changes `.git/config`, signals readiness, and waits for a release marker.
Run `skills reject sample reason` during dream; run both wiki read verbs during groom.
Prove that each pass still owns its lock when the competing command exits.
Assert the AC1 or AC2 refusal, zero competing git calls, and no fsmonitor execution marker.
Add a memory overlap row with a nested gitdir fixture and alternates, using the existing safe fixture pattern.
Never execute an exploit outside the disposable test home.
Use bounded readiness waits and explicit release markers, not sleeps as the ordering proof.
Release and await both child processes in `finally`, even when an assertion fails.
Do not count post-pass cleanup calls as calls from the refused command.

AC4. `ot1ew lock lifetime` must prove acquisition before the first protected operation and retention through the last.
Use a fake downstream git or bead command to record the lock PID while the command runs.
Cover each memory path and both wiki verbs, including the non-core bead callback.
Assert that another lock acquisition fails at that point.
After success or a handled exception, assert that a fresh command can acquire the lock.
Include a failing skill/proposal operation and a failing wiki operation; neither may leave a live lock behind.
Do not add process-exit recovery semantics beyond the existing `hold` contract.

AC5. `ot1ew unlocked controls` must preserve all seven successful paths when no matching lock is held.
Assert the original mutations, commit behavior, bead count, wiki result rows, and status JSON.
Memory list commands must still work while `dream.lock` is held and must call no git.
A held `wiki.lock` must not block a memory command; a held `dream.lock` must not block a wiki read.
Preserve wiki no-match code 1, missing-wiki behavior, and existing input validation.
Keep config allow-list, nested-repo, fence, worker, and patrol refusal tests intact.

AC6. Final required checks must pass on one final PR head.
Run `bun test src factories`, `bun run typecheck`, `claude plugin test mod`, and `bun run format:check`.
Run `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
Run the repo gate required by implement. Record any unavailable local tool and the exact-head CI substitute.
Required CI checks are test, plugin, typecheck, and format.
Do not ship a final head with deliberately red required checks.

## Test plan

Commit the regression tests first. Record their failures on the parent code before the fix.
Existing defenses can keep the fsmonitor marker absent before this fix; require failures from the lock and zero-call assertions.
Then implement the minimal command scopes and make the tests pass in the same pull request.

Use fresh `FACTORY_HOME` values, fake git/bead/network tools, and no real service calls.
Strip worker routing variables such as `FACTORY_OUTBOX`, `FACTORY_FROM`, and `FACTORY_RUN` from child environments.
Set `FACTORY_SELF_UPDATE=0` and `FACTORY_NO_KICK=1`.
Use fixture identities such as `acme/widget`.

After the fix commit, mutate each command scope alone through `factory mutate` and its focused test.
Each mutation must still build and must fail its specific assertion.
Do not route all mutations through one shared refusal that masks a missed caller.
Record command, changed location, exit status, and failed assertion in the task evidence.
Run complete touched-file suites after the focused tests, then AC6.

## Risk

This change is security-sensitive: git can execute programs through repository metadata under the factory identity.
The lock closes the concurrent command window; it does not replace the sandbox or the existing metadata guards.
The principal risks are missed caller scopes, lock leaks, and changes to callers that expect wiki status JSON.
Busy wiki reads now return code 1 with no JSON. Callers must retry after the pass ends.
Busy memory commands must not change data or create a bead before refusal.
There are no data migrations, credential changes, or new configuration values.
The existing stale-lock race remains unchanged; this work adds no new lock implementation.
Security-sensitive: yes (repository metadata execution and command exclusion)

## Rollout and rollback

Use one draft pull request for both tasks. Obtain review and security review before the normal release.
A person must merge it. Deploy through the existing ship process after that merge.
No flags, migration order, live write, or owner-only command is necessary.
Rollback requires a revert pull request and a person merge, then the normal release process.
A rollback restores the concurrent-access gap. Record that risk in the revert request.

## Observability

The busy stderr line and exit code prove a refusal. Add no metrics or logs of repository content.
The ship soak checks the deployed revision through its normal release evidence.
It can repeat the isolated overlap tests against that revision without a live malicious pass.
No AC is must-see-live. No production credential, live read, or synthetic attack is necessary.

## Commit tasks

1. `claude-factory-ot1ew.1`: Add AC1 through AC5 regression tests and replace the two obsolete wiki assertions.
   Commit tests first. Record the expected red results on the parent code. Budget: 45 minutes.
2. `claude-factory-ot1ew.2`: Add command lock scopes and update obsolete comments. Depend on task 1.
   Commit the fix. Run focused tests, touched-file suites, isolated mutations, and AC6. Budget: 60 minutes.

Reserve 15 minutes for final evidence and the draft pull request.
Both tasks fit one 120-minute implement pass. No dependency on another unmerged bead is necessary.
Do not modify `.factory/` or the completed f1zc guards.

## Plan evidence

Plan read the bead comment, command paths, lock implementation, and existing memory and wiki tests.
No root CLAUDE.md, AGENTS.md, or CONTRIBUTING.md exists in this checkout.
The supplied worker instructions apply. The memory search returned no notes in this VM.
The branch had no prior PR or child tasks at plan start.
Plan ran only document checks; it did not run source tests, build, plugin tests, or a live reproduction.
Implement must supply the red-to-green evidence above.
