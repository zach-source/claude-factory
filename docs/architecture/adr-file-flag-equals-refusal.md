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
Change only `src/cli.ts`, `src/report-summary-file.test.ts`, and `src/text-file-flags.test.ts` during implementation.
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

Out of scope: generic equals-option support, other flags, path policy changes, replayable grammar, and server transport defects.
Do not change `memory add` production code. Add only its regression row.
The related server-mode literal-text bead remains separate; this fix adds no second pass over expanded file contents.

Rejected alternatives:

- Accept equals-form file input: this adds file reads and path semantics beyond the requested refusal.
- Search arbitrary substrings: this rejects permitted prose and longer words.
- Add a shared parser or dependency: two existing checks and standard string methods cover the defect.
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

AC5. Prove both new conditions and preserve the required checks.
Record each report and mail regression failure before the fix; a network or setup failure does not qualify.
Commit the tests first, then the fix, within one PR.
After the fix commit, use `factory mutate <file:line> <old> <new> -- <test cmd>` for each new condition alone.
Replace only that `startsWith` result with false. Each mutant must compile and fail the corresponding `9ydy` test.
Record exit 0 from each mutation command and a clean source restore.
Run the focused command, `bun test --timeout 30000 src factories`, and `claude plugin test mod`.
Run `bunx tsc --noEmit -p .` and `bunx prettier@3.9.9 --check .`.
Also run `gitleaks detect --log-opts=origin/main..HEAD`, `bun audit`, and the station's made-worse gate.
The final PR head must pass CI checks `test`, `plugin`, `typecheck`, and `format`.
Record local environment gaps separately. Never weaken a test or ship a deliberately red final head.

## Test plan and evidence

Implement writes AC1 through AC4 tests first and records the two expected pre-fix failures.
Use the existing fixtures and synthetic text. Do not use real reports, mail recipients, or secret files.
Then implement the two predicate changes and complete AC5.

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

Use one draft PR with both task commits. A person merges after verify, review, and security.
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

1. `claude-factory-9ydy.1`: Commit AC1 through AC4 tests after the pre-fix proof.
2. `claude-factory-9ydy.2`: Commit the two checks after the focused tests pass; complete AC5 and the draft PR.

Task 1 blocks task 2. Both fit one 120-minute implement pass and one PR.
No external bead, merge, owner decision, or live step blocks this plan.
