# ADR: Preserve literal text in worker outbox replay

## Context

Bead: `claude-factory-yn9ag`. Base: `7595aef6`.

The VM expands file text before `worker.queue` in `src/cli.ts:13461`.
The expansion loses the distinction between options and text.
`replayable` at `src/cli.ts:787` rejects a summary equal to `--summary-file`.
The mail handler at `src/cli.ts:14697` treats file text `--wake` as an option.
`outboxUsage` at `src/worker.ts:172` accepts that mail record.
The worker API uses a separate path. This change must not depend on that API.

Plan installed dependencies with `bun install`.
The command below passed: 4 tests, 27 assertions, 213 tests excluded.

```sh
bun test --timeout 30000 src/remote.test.ts -t 'summary-file'
```

These tests cover expansion and path refusal separately. They do not prove exact text through replay.
Plan did not run the full replay probe, full suite, build, or live checks.

## Decision

Use the existing JSONL `argv` transport with an explicit `--` boundary for report and mail text.
Parse options before file expansion. Preserve each file value as one string after the boundary.
New producers must emit these canonical forms:

```text
["report", run, seq, outcome, "--", summary]
["mail", run, box, "--", text]
["mail", run, box, "--wake", "--", text]
```

Apply the same forms to inline text after the existing CLI option parse.
Join inline words with the existing single-space rule. Do not trim or split file text.
The local report and mail handlers must consume the boundary once and treat the final string as data.
They must not pass literal data through a second option or file parse.
Retain `cleanReport` and its existing control-character policy.
This exact-text contract concerns option text and ordinary whitespace, not control characters that the report sanitizer replaces.

Touch `src/cli.ts`, `src/worker.ts`, and `src/remote.test.ts`.
Extend existing CLI tests if necessary for the direct local handler.
Use small functions only where queue and replay share the same parse.
Do not add a dependency, transport service, environment bypass, or factory definition change.

### Closed grammar and trust rule

For the new forms, accept only the three arrays above, with strings in every slot and exact array lengths.
The boundary is structural only in the specified slot. A boundary inside the final string is data.
`run` must equal the trusted run. Report `seq` must equal the trusted attempt as a decimal string.
The existing local handler must validate the report outcome against the current station.
The existing mail handler must validate the destination. The optional wake token must equal `--wake`.
The final string must satisfy existing nonblank text requirements.
Apply the existing 100 KiB UTF-8 argv cap, including structural words, before sync or replay spawn.
Reject malformed new forms before any CLI replay spawn, event post, or file access from the record.

Retain the envelope fields `argv`, `from`, `at`, `usage`, `bdSkew`, and `start` with their current validation.
Never trust `from`; use the station from the local side record.
Keep the existing usage, start, beads-sync, cursor, and duplicate-line rules.
Do not use envelope metadata as authority to permit a file read.
The new grammar has no path field. Every final string is data, even if it names a local file.

Retain accepted legacy records without a boundary and their existing option semantics.
Continue to reject legacy report `--summary-file` and mail `--text-file` forms in the option slots.
This includes mail with an initial `--wake` before `--text-file`.
Do not reinterpret an ambiguous old record as file-derived literal text; the old record has lost that information.
Keep other verbs denied, except the existing memory add/helped paths.
Memory transport, shell syntax, worker API transport, and local summary-file root policy are outside this change.

Rejected alternatives:

- Relax the file-flag refusal: this permits a VM to request a laptop file read.
- Escape only these two words: other option-like values would still depend on parser details.
- Add a second JSON command schema: a positional boundary suffices and preserves the existing replay machinery.
- Send a VM path to the laptop: the laptop must never open a VM-selected path.

## Acceptance criteria

Use test names that include `yn9ag AC1`, `yn9ag AC2`, or `yn9ag AC3` in `src/remote.test.ts`.

### AC1: Exact text survives queue and replay

Create real text files in an allowed isolated test root.
Queue report summary `--summary-file` and mail text `--wake` through the VM CLI.
Feed the emitted outbox lines into the existing fake cluster and real tick path.
Assert exactly one report event with summary `--summary-file`.
Assert exact mail text `--wake`, the trusted station sender, and no `wake=true`.
Replay the same snapshot twice. Assert no extra events.
Also assert that explicit `--wake` plus a file whose text is `--wake` yields text `--wake` and `wake=true`.
Allowed text controls: `--text-file`, `--`, `-h`, multiline text, quotes, Unicode, and leading or trailing spaces.
Use separate run fixtures when a report would finish the run.
Empty or whitespace-only files remain denied with no queue append and no beads sync.
Proof: `bun test --timeout 30000 src/remote.test.ts -t 'yn9ag AC1'`.

### AC2: Replay never opens a VM-selected file

Test malformed new forms: missing text, extra tokens, non-string values, and extra options after the boundary.
Forms without a boundary remain subject to legacy validation; do not mistake ordinary legacy text for a new form.
Test wrong run, wrong attempt, invalid outcome, and an unauthorized verb.
Test legacy file flags with absolute paths, relative paths, `../` paths, and symlink paths.
Include both legacy mail option slots.
Each invalid transport row must cause zero replay spawns, zero events, and zero record-directed file reads.
For handler-level outcome or destination refusals, assert zero events; one validated CLI spawn is permitted.
Instrument the replay seam for zero-call assertions. Do not count unrelated tick startup reads or processes.
Use a sentinel file and assert that its text reaches no event, log, or prompt.
A valid literal string equal to that path must remain the path string, never the file content.
Malformed rows must not prevent a subsequent valid line from replay.
Proof: `bun test --timeout 30000 src/remote.test.ts -t 'yn9ag AC2'`.

### AC3: Existing transport controls remain effective

Keep legacy ordinary report, mail, explicit wake, memory add, and memory helped records functional.
Preserve forced sender identity, active-attempt checks, help behavior, and malformed-input refusals.
Test the 100 KiB boundary and one-byte excess with multibyte text included in byte accounting.
An oversized record must produce no replay spawn. An oversized producer request must produce no append or beads sync.
Keep failed beads-sync refusal, schema-skew hold, report usage/start metadata, and cursor tests green.
Proof: `bun test --timeout 30000 src/remote.test.ts`.

### AC4: Required checks pass on the complete change

Record AC1 failure on pre-fix code before the source change. Both defect assertions must fail for their stated reasons.
Commit tests first, then the fix, within one PR. Do not hand off a red required check as an expected state.
After the fix commit, mutate the report and mail literal branches separately with `factory mutate`.
Each mutant must compile and fail the relevant AC1 assertion. Mutation exit 0 means the test killed the mutant.
Run these repo checks:

```sh
bun run test
bunx tsc --noEmit -p .
bunx prettier@3.9.9 --check .
gitleaks detect --log-opts=origin/main..HEAD
bun audit
```

CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final PR head.
CI omits `tsc -p mod` because a clean checkout lacks live engine types.

## Risk

This change is security-sensitive because replay parses untrusted VM input.
A misplaced boundary can permit a file read or change a mail wake action.
The closed grammar and zero-call tests protect that boundary.
No database migration or credential change is necessary.
New readers accept old unambiguous records. Old readers do not understand the new boundary.
Old ambiguous records need a fresh worker command after the update; do not edit an append-only outbox.
Security-sensitive: yes (input parsing across the VM replay trust boundary)

## Rollout and rollback

Deploy the reader before any worker producer that emits the new boundary.
Ship must confirm that the manager CLI has the fix before the new worker image or checkout serves commands.
Do not assume an old manager can safely consume new records.
No feature flag or persistent schema migration is necessary.
Keep the new reader until all new-format records drain if a producer rollback is necessary.
Revert through a PR for a person to merge. Never pair a new producer with an old reader.
Owner-only live steps remain outside this plan.

## Observability

Use the run inbox and journal to count report and mail events and compare their exact text.
Use the existing replay-refusal prompt and seen cursor to diagnose a rejected or repeated record.
Add no raw-text logs or metrics. Report summaries and mail can contain private data.
The ship soak can use an isolated factory home and fake cluster to repeat AC1 on the shipped revision.
No AC is must-see-live. No production read is a pre-merge condition.

## Tasks

1. `claude-factory-yn9ag.1`: Add AC1 through AC3 regression tests. Record the AC1 pre-fix failures and commit the tests.
2. `claude-factory-yn9ag.2`: Add canonical text boundaries and strict replay validation. Complete AC1 through AC4 and commit the fix.

Task 2 depends on task 1. Both tasks fit one 120-minute implementation pass and one PR.
The plan commit contains only this ADR. The report lists the child bead IDs.

## Revised verification plan

Three partial passes completed the source fix and the regression tests.
Local model access and time checks prevented a green local gate.
The manager accepted green CI as AC3 and AC4 proof, per the task 2 close record.
Both child tasks are closed. No further source change is necessary.
Merge current main, then repeat the regression tests, typecheck, format check, scans, and literal branch mutations.
Require all CI checks on that final head before the handoff to verify.
Retain the local gate failures in the report. Do not change tests or limits to hide them.
