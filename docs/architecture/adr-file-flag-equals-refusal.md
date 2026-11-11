# ADR: Refuse equals file flags in report and mail text

## Context

Bead: `claude-factory-9ydy`. Plan base: `ec5b4fffd99246333af894061e61f024fdb8b78b`.

The CLI treats `--summary-file=<path>` and `--text-file=<path>` as text.
It posts the token instead of the intended file contents. This defect does not read the named file.
The whole-word refusal already exists at `src/cli.ts:830` and `src/cli.ts:891`.
The memory command already refuses `--body-file=<path>` with exit 2.
No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in this checkout. The supplied station rules apply.

## Decision and scope

Extend each existing text-slot check with `some`, equality, and `startsWith`.
Use `--summary-file=` for report and `--text-file=` for mail.
Change only `src/cli.ts`, `src/client.ts`, `src/report-summary-file.test.ts`, `src/text-file-flags.test.ts`, and `src/client.test.ts` during implementation.
Plan adds only this ADR. Release owns the changelog.

The fail-closed rule applies to each argv token in the text portion of the command.
Refuse any token equal to the reserved file flag or with that flag followed immediately by `=` at its start.
The only file-input form remains the exact flag followed by one path in its supported slot.
Report text starts after run, sequence, and outcome. Mail text starts after run and box, plus optional leading `--wake`.
The path value in a valid split form retains its current validation; it is not a text slot.
Read no equals-form path and infer no new path grammar. The suffix can be empty or contain arbitrary characters.
The CLI reads argv tokens, not shell syntax or another tool's input. No shell parser or render step applies.
Text with a prefix before the flag substring remains text, including a single argv token with spaces before the substring.
File contents retain current behavior, even when they contain flag text.

Out of scope: generic equals-option support, other flags, path policy changes, replayable grammar, and other server transport defects. Server-mode mail gets the same refusal at `src/client.ts:122`.
Do not change `memory add` production code. Add only its regression row.
The related server-mode literal-text bead remains separate; this fix adds no second pass over expanded file contents.

Rejected alternatives:

- Accept equals-form file input: this adds file reads and path semantics beyond the requested refusal.
- Search arbitrary substrings: this rejects permitted prose and longer words.
- Add a shared parser or dependency: three existing checks and standard string methods cover the defect.
- Change replayable alone: local commands would still post the wrong text.

## Acceptance criteria

Use this focused command for AC1 through AC4:

```sh
bun test --timeout 30000 src/report-summary-file.test.ts src/text-file-flags.test.ts
```

Name new tests `9ydy AC1`, `9ydy AC2`, `9ydy AC3`, and `9ydy AC4` for focused selection.

AC1. Report refuses the reserved equals-token class in every text slot, with exit 1 and the report usage line.
Assert zero events after each denied row in `src/report-summary-file.test.ts`.
Cover `--summary-file=<fixture>`, `--summary-file=`, and each token after an ordinary summary word.
Use a real synthetic file for one row and a nonexistent path for another; both must produce the same usage refusal.
Keep whole-word later-slot, absent-path, extra-word, blank-file, directory, missing-file, and size-limit denials.

AC2. Mail applies the same rule for `--text-file=` in `src/text-file-flags.test.ts`.
Assert exit 1, the mail usage line, and zero events after each denied row.
Cover nonempty and empty equals suffixes, both first and after an ordinary text word.
Repeat these rows with leading `--wake`. Keep all existing whole-word and invalid-file denials.

AC3. Preserve permitted text and valid split forms in both test files.
For each verb, allow `prefix--summary-file=x` or `prefix--text-file=x`, as applicable.
Also allow one argv token such as `use --summary-file=x` or `use --text-file=x`.
Assert exit 0 and the exact text in the event, under the existing cleanup rules.
Retain valid split-form report outcomes, mail with and without `--wake`, and memory file-body tests.
Add `--body-file=<fixture>` to memory's malformed-form rows; assert exit 2 and zero notes.
This memory row must pass before the source fix.

AC4. VM commands refuse before they append to the outbox.
Use isolated homes and outboxes in the existing test harnesses.
Add one equals-form refusal for report, mail, and memory in VM mode.
Assert exit 1 for report and mail, exit 2 for memory, and zero outbox entries.
Retain the valid split-form VM tests that queue text rather than paths.
Strip inherited caller markers and disable self-update for all child CLI tests.

AC5. Prove all three new conditions and preserve the required checks.
Record each report and mail regression failure before the fix; a network or setup failure does not qualify.
Commit the tests first. Commit the fix in the same PR.
After the fix commit, use `factory mutate <file:line> <old> <new> -- <test cmd>` for each new condition alone.
Replace only that `startsWith` result with false. Each mutant must compile and fail the corresponding `9ydy` test.
Record exit 0 from each mutation command and a clean source restore.
Run the focused command, `bun test --timeout 30000 src factories`, and `claude plugin test mod`.
Run `bunx tsc --noEmit -p .` and `bunx prettier@3.9.9 --check .`.
Also run `gitleaks detect --log-opts=origin/main..HEAD`, `bun audit`, and the station's made-worse gate.
The final PR head must pass CI checks `test`, `plugin`, `typecheck`, and `format`.
Record local environment gaps separately. Never weaken a test or ship a deliberately red final head.

AC6. Server-mode mail must apply the same token rule before file resolution or an HTTP request.
Run `bun test --timeout 30000 src/client.test.ts`.
The test `9ydy equals-form --text-file refuses in server mode, longer words stay text` covers eight denied rows.
Cover empty and nonempty suffixes, first and later text slots, with and without leading `--wake`.
Each row must return a route error, exit 1, and send zero requests.
The longer word `x--text-file=y` must remain a text route.
Retain existing split-form, invalid-file, and malformed-form tests.
The server predicate needs its own pre-fix failure and killed mutant under AC5.

AC7. Preserve the text-root validation from main after the merge.
Keep `readTextFile('--summary-file', textFilePath('--summary-file', path))` and the equals-prefix refusal.
Run the five-file command below, TypeScript, and Prettier 3.9.9.
Report split-form files inside the text roots must pass; outside paths, dotdot paths, and symlink escapes must fail.
Each refusal must create zero report events. Keep the AC1 equals-token tests beside these path tests.
Check both merged files for conflict markers, including the seven-pipe base marker.
Run `git merge-tree --write-tree origin/main HEAD`; it must exit 0.
This command proves no text conflict. The tests and exact-head CI prove behavior.

```sh
bun test --timeout 30000 src/report-summary-file.test.ts src/text-file-flags.test.ts src/client.test.ts src/remote.test.ts src/security-route-cli.test.ts
```

## Test plan and evidence

Implement writes AC1 through AC4 tests first and records the two expected pre-fix failures.
Use the existing fixtures and synthetic text. Do not use real reports, mail recipients, or secret files.
Then implement the three predicate changes and complete AC5.

Plan installed dependencies with `bun install --frozen-lockfile`.
The focused baseline produced 13 passes and one failure, with 132 assertions.
The existing memory success test failed at `src/text-file-flags.test.ts:150` after a connection reset.
A repeat without `FACTORY_SERVER` had the same result. The cause remains unverified.
This is not proof of the equals-form defect. Implement must distinguish this local gap from new regression failures.
Plan did not run the full suite, plugin check, or typecheck. No production reads occurred.

## Risk

This change is security-sensitive because it changes CLI input parsing.
The known defect loses intended text; it does not expose a file.
The compatibility change refuses standalone equals-form tokens that formerly became literal text.
Longer-word controls limit false refusals. Existing path checks remain intact.
There are no data migrations, schema changes, credentials, new flags, or configuration changes.
The fix does not repair past events. Review and security must check slot boundaries and the VM refusal.
Security-sensitive: yes (CLI input parsing)

## Rollout and rollback

Use the existing draft PR with all task commits. A person merges after verify, review, and security.
Use the normal CLI release path. No migration order or feature flag applies.
Do not change `.factory/`, deploy from plan, or perform an owner-only action.
If rollback is necessary, open a revert PR for a person to merge, then use the normal release path.
Rollback restores the text-loss defect. Prefer a small corrective patch for false refusals.

## Observability

The existing exit code, usage line, and absent event or outbox entry prove refusal.
No new metrics or raw input logs are necessary.
Ship soak can repeat the focused tests against the released revision in a disposable home.
Record the release SHA and results. Do not post a probe to a live run or manager mailbox.
No AC is must-see-live. No production read is a pre-merge acceptance gate.

## Tasks

1. `claude-factory-9ydy.1`: Tests and pre-fix proof. Closed.
2. `claude-factory-9ydy.2`: Local predicates and mutations. Closed.
3. `claude-factory-9ydy.3`: Complete the mail matrix and per-row event checks. Closed.
4. `claude-factory-9ydy.4`: Server-mail predicate, eight refusal rows, and mutation. Closed.
5. `claude-factory-9ydy.5`: Merge main and retain both test groups. Closed at `6e28a4d4`.
6. `claude-factory-9ydy.6`: Commit final evidence after the merge. This is the only open task.

## Revised scope after the round cap

The first plan missed the separate server-mail entry point in its numbered criteria and task list.
The first implementation also omitted two required mail rows and per-row event checks.
A later main change caused a merge conflict after those fixes. These are separate causes, not one unresolved predicate defect.
The current source has all three checks. The current tests have both eight-row mail matrices.
The merge retains the text-root check and both report test groups.

The next implement pass has one bounded task: final evidence for AC1 through AC7.
Commit only an evidence update to this ADR unless a check proves a new regression in this scope.
Do not repeat closed tasks, create another PR, or change production predicates without that evidence.
Use PR #861. Keep it a draft through verify, review, and security.
Run the five-file command and the AC5 checks. Record failures by test name, assertion, and revision.
The journal proves the memory success test failed at baseline with ECONNRESET.
It does not prove the four other memory search failures share that cause.
For each remaining failure, obtain exact-head green CI or prove the same failure on main in an isolated home.
Do not call those failures environment defects without evidence.
Existing red-first and mutation records remain valid for unchanged predicates.
The report predicate mutation after the merge already passed in implement round 4.
Repeat a mutation only if its predicate changes.

Record the final code SHA and all check results in one ADR commit.
After that commit, require green CI on the new head before implement reports ready.
The task fits one 120-minute pass. If CI exceeds that time, report blocked on PR #861.
Verify checks the final head. Security reviews the merge resolution and any later code delta.
No new feature, external bead, owner action, or live read is part of this task.

## Final evidence

Code head: b797fc87. It contains origin/main.
Command: the five-file command in AC7.
Result on the branch: 295 pass, 5 fail.
The same 5 tests fail on a clean origin/main worktree with the same command: 257 pass, 5 fail.
So the branch adds no failure.

- text-file-flags: "memory add --body-file stores the file text as the body (AC2)". It fails with ECONNRESET in the VM.
- remote: "memory search --from logs shown with the run and station; without it, no by".
- remote: "a VM memory search says why it found nothing > row d".
- remote: "an ax launch searches the laptop memory once and puts the top notes in the brief".
- remote: "an AX-rig run with herdr failing (claude-factory-xbzd S1) > an AX rig's herdr-runner station reopens its worktree through herdr worktree open".

CI on the exact head runs the full suite. No predicate changed, so no mutation ran again.
