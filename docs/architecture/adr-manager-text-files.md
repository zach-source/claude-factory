# Pass manager text through files

Status: accepted plan for `claude-factory-0s5e`.

## Context

Baseline: `7595aef6`.
Manager text can quote a bead or worker report.
An apostrophe can end a shell argument and expose a second command.
Single quotes without an escape rule do not protect this text.

`src/cli.ts` already confines text files through `textFileArg`.
Mail and memory bodies already use this helper.
`src/cli.ts` expands remote worker files before the outbox write.
It expands mail before the server client call.
`mod/hooks/register.tsx` asks the person about the command, without a file-content preview.
Thus, a file note for `decide` would hide part of the decision.

## Decision and scope

Use the existing helper for these command forms:

| Command | File field | Existing options to preserve |
| --- | --- | --- |
| `mail <run> <box> [--wake] --text-file <path>` | Mail text; already supported | `--wake` |
| `poke <run> --text-file <path>` | Steer text | No-text default nudge |
| `fork <run> <station> --note-file <path>` | Fork note | No-note form |
| `start <factory> <rig-or-repo> --goal-file <path> [--owned]` | Goal | Explicit `--owned` permission check |
| `memory add --summary-file <path> --body-file <path>` | Summary and body | `--rig`, `--from`, `--kind`, `--until`, `--supersedes`, `--anyway` |
| `memory search --query-file <path>` | Query | `--rig`, `--from`, `--no-core` |
| `skills reject <name> --reason-file <path>` | Reject reason | Existing manager permission check |
| `rig add <name> <repo> [factory] --goal-file <path>` | Rig goal | Existing rig options |

Preserve existing inline forms for callers. Preserve a summary file with no body and with an inline body.
Preserve an inline summary with a body file.
The shared rig parser can support `rig set --goal-file` with the same rules; test it if exposed.
Do not expand file flags on unrelated subcommands.

Keep `decide` and `decisions answer` inline.
For both, instruct the model to use single quotes and replace each apostrophe with the shell sequence `'\''`.
The full escaped command must remain visible in the existing confirm dialog.
Do not change approval scope, turn grants, worker refusal, or patrol refusal.
Do not add a file flag to either decision verb.

Parse command options before file content enters the operation.
File content must never become an option, permission, command, or path for another read.
For example, a goal containing `--owned` cannot grant owner authority.
Keep existing domain checks and text normalization, including `trimEnd`, report cleanup, and memory note validation.
Where an existing domain rule refuses flag-like text, retain that refusal with zero operation calls.
Do not silently remove, reinterpret, or execute such text.

Use narrow command branches in `src/cli.ts`; do not add a general shell parser or a dependency.
Update CLI help with the file forms.
Update the manager manual in `mod/hooks/register.tsx` and the command examples in `src/steps/patrol.md`.
Inspect other `src/steps/` files for the same scoped command examples.
Use Write to create each value in a fresh `<FACTORY_HOME>/text/` file before the shell call.
Use a plain generated filename. Quote the path with the same apostrophe escape rule.
Never build a file with shell interpolation of the payload.

Update the two manager skills named in the bead comments:
`plugins/factory-rig/skills/factory-handoff/SKILL.md` and `plugins/factory-rig/skills/factory-prioritize/SKILL.md`.
Use `bd create --body-file`, `bd comment --file`, and `bd close --reason-file` for their text.
Use an escaped single-quoted title where bd needs an inline title.
Put acceptance and notes in the body file. Keep the skills' owner consent rules.
For existing beads, use a file comment for supplemental context rather than inline update text.
Copy rig names from `rig list`, not from the worker's `File in:` text.

Tests belong in `src/text-file-flags.test.ts`, `src/steps.test.ts`, and `src/prompt-quotes.test.ts`.
Extend `mod/tests/quote-checks.ts` and `mod/tests/quote-untrusted.test.tsx` for the prompt contract.
Use the existing CLI, gate, start, and rig test fixtures where necessary.
Do not change `.factory/`, worker guards, live settings, or the permission model.

Do not use inline text in manager examples. Preserve legacy inline CLI calls.
Reject file inputs for decisions: the current confirmation displays the command, not an immutable payload.
Reject a new shell grammar: this change removes payloads from shell text instead.

## Input contract

The new file mode uses a closed argv grammar for each row above.
Accept only that row's IDs, existing documented options, and file fields.
Each file field takes exactly one path and occurs at most once.
Reject unknown options, absent paths, duplicate fields, extra positional text, and inline/file conflicts for the same field.
Memory summary and body are separate fields; either can select inline or file input.
Preserve legacy inline parsing when no new file mode applies.

A path can be absolute or relative to cwd.
Resolve it through `textFileArg` before any operation or remote request.
The real target must be a regular readable file strictly below `<FACTORY_HOME>/text/` or the real worktree `.scratch/`.
The latter root must not be a symlink, and cwd must be within that git worktree.
Permit a child symlink only when its real target stays inside an allowed root.
Reject root-prefix siblings, traversal outside both roots, escaped symlinks, missing files, directories, empty text, and whitespace-only text.
The existing size limit is 100 KiB per file; retain the separate total outbox limit.
Reject every other path form before the target operation or network request.
File resolution can run the existing git root probe; this is not a target operation.

This is an argv and file-source contract, not a claim to validate arbitrary shell programs.
Shell grammar, quoted-verb gate bypasses, arbitrary third-party commands, and worker sandbox escapes remain outside this change.

## Acceptance criteria

AC1. `0s5e file fields preserve text` covers every row in the table with the actual CLI or captured target operation.
Run `bun test --timeout 30000 src/text-file-flags.test.ts`.
Assert exact text after existing normalization and exactly one intended operation.
Cover apostrophes, double quotes, semicolons, pipes, newlines, backticks, `$VAR`, and `$(...)`.
Use a harmless marker payload in a shell integration test; assert that the marker never appears.
Allow old inline forms and the no-text poke/fork forms.
Reject conflicting fields. Test flag-like payloads such as `--owned`, `--anyway`, and `--rig` separately.
They must remain data or fail an existing domain check; they must never change options.

AC2. `0s5e file mode fails closed` tests the full input contract for each new file-field consumer.
Use the same command as AC1, plus existing start and rig fixtures as needed.
Negative rows include missing paths, duplicate flags, unknown flags, extra words, and both inline and file values.
Path rows include every rejected class above, a symlinked `.scratch`, and a prefix sibling such as `text-other/`.
Positive rows include both allowed roots, a nested path, and a confined symlink.
Test 100 KiB and 100 KiB plus one byte.
Assert zero target calls, outbox writes, run creations, note writes, skill changes, and rig changes on rejection.
Unrelated preexisting filesystem fixtures must remain unchanged.

AC3. `0s5e remote text is data` covers local mail, server-client mail, and worker outbox mail/memory add.
Run `bun test --timeout 30000 src/text-file-flags.test.ts src/server-api-cli.test.ts`.
Expand summary and body files before remote serialization. The wire holds text, never local paths or file flags.
Reject unresolved `--summary-file` as well as `--body-file` in memory replay.
Preserve forced worker `--from`, run ownership, sequence checks, and the outbox size limit.
Reject bad files before any remote call or queue write.
Manager-only verbs must remain unavailable through worker replay; do not extend the replay allowlist.

AC4. `0s5e manager examples use files` checks the manual, patrol, scoped step examples, and both manager skills.
Run `bun test --timeout 30000 src/steps.test.ts src/prompt-quotes.test.ts` and `claude plugin test mod`.
Every scoped non-decision text field must use its supported file form.
For bd titles and the two decision verbs, require the explicit apostrophe escape instruction.
Checker negative controls must reject single-quoted, double-quoted, and bare free-text placeholders for file-capable fields.
Positive controls must accept IDs, paths, explicit decision exceptions, and commands without text.
Do not make the checker accept arbitrary quoted placeholders to obtain a pass.

AC5. `0s5e decision text remains visible` exercises the existing confirm path with an escaped hostile note.
Run `claude plugin test mod` and `bun test --timeout 30000 src/main-chat-gate.test.ts src/worker-control.test.ts`.
Assert that the dialog contains the full escaped command and that denial makes zero target calls.
With approval, a fake target must receive one literal note and no extra command.
Patrol and worker calls must still fail. Keep `decisions answer` inline with the same positive and negative controls.
File-backed start with `--owned` must retain its existing approval requirement.
No file content can supply that option.

AC6. The final pull request head passes the four required CI checks: test, plugin, typecheck, and format.
Run `bun test --timeout 30000 src factories`, `bunx tsc --noEmit -p .`, and `claude plugin test mod` locally.
Use the CI environment requirements from `.github/workflows/ci.yml` for mandatory Postgres and package-gate tests.
Run `bunx prettier@3.9.9 --check .`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Record local tool gaps and exact-head CI evidence. Never weaken a check.

AC6 local gap rule (re-plan after four partial implement rounds). One class of local failure does not block ready:
a test that fails because the memory model cannot load on the VM (claude-factory-v4kta).
A failure is in this class only if all three conditions are true:
- The output of that failed test itself shows one of these texts: `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `fetch failed`, or a `huggingface.co` URL.
- After the suite, `bun -e 'await (await import("./src/memory.ts")).fetchModel()'` at the same HEAD exits non-zero with the same error. This probe only confirms the VM gap. It never puts a test in the class alone.
- The exact-head CI `test` job passes. That job runs the same tests and fetches the model (src/memory.ts:550; ci.yml has no cache step).
Every other local failure blocks ready, also a time-bound failure and the Git builtin failure.
Run the gate with Nix Git (`nix-shell -p git ...`). Host Git 2.47.0 fails the Git builtin test; Nix Git 2.56.0 passes it.
Do not copy the model cache, change egress or ask again for a cache input.
The required checks are test, plugin, typecheck and format (ci.yml:3). Also report nix.
Put the count and names of model-class failures and the CI job URL in the run report.

## Test plan and tasks

One implementation pass can finish this scope in 120 minutes.
All tasks ship in one pull request; no intermediate test failure ships alone.

1. `claude-factory-0s5e.1`: Add the AC1-AC5 regression tests before the fix. Commit the tests and record the baseline failures.
   Existing mail and decision controls must pass; new flags and prompt assertions must expose the gap.
2. `claude-factory-0s5e.2`: Add the CLI file forms and remote normalization. Preserve the input contract and all permission checks.
   Commit when AC1-AC3 pass. Use the existing helpers rather than a new framework.
3. `claude-factory-0s5e.3`: Update the manager prompts, skills, and help. Keep the decision exceptions explicit.
   Commit when AC4-AC5 pass. Leave the changelog to the release step, as the implement brief requires.
4. `claude-factory-0s5e.4`: Prove the guards and complete AC6. Commit only necessary final corrections and evidence in this ADR.
   After the fix commit, use `factory mutate` for independent confinement, conflict, and replay checks.
   Each mutant must build and fail its focused test. Restore the committed source after each probe.
5. `claude-factory-0s5e.7`: Merge current origin/main and run the AC6 gate one time under the local gap rule.
   Ready when all non-model local failures are zero and the four required exact-head PR checks pass.

## Risk

This change is security-sensitive: it changes input parsing at the shell and file trust boundary.
An early argv expansion can reinterpret file text as an option. Parse options first and keep text separate.
An unresolved remote file flag can read a file on the receiver. Reject it before replay.
A file-backed decision can conceal consent text. Keep those two verbs inline with an explicit escape rule.
Inline CLI forms remain compatible; manager prompts prefer file forms.
No database migration, schema change, credential change, or new dependency is necessary.
The existing helper leaves text files in place. This plan adds no retention process.
Security-sensitive: yes (input parsing, file confinement, and permission preservation)

## Rollout and rollback

Ship CLI support and prompt changes together after review, security review, green checks, and the person's merge.
No feature flag or data migration is necessary.
Use the normal release process. Do not change the live manager from this station.
Reload manager prompts only after the new CLI is available.
For rollback, revert the prompts and CLI in one pull request for the person to merge.
Stored text, mail, notes, runs, and rig goals need no conversion.

## Observability

Use existing command exit status, inbox events, outbox events, and stored note/goal text.
Add no payload logs, metrics, or live access requirement.
The ship soak can check the deployed CLI version and loaded prompt revision through its authorized release checks.
Local isolated fixtures prove the literal-data contract without a production write.
No AC is must-see-live. Production reads are not a pre-merge condition.

## Implementation evidence

The regression commit is `716473ba`. The CLI fix is `a31fdfcb`. The prompt commit is `cbce75f8`.
The baseline tests exposed absent flags, unsafe prompt examples, and unresolved summary files on replay.
The CLI and client parse options before file text enters an operation.
Mail uses `--` before flag-like payloads on the worker and client paths.
The client also uses `--` to keep a start goal separate from explicit `--owned` authority.
Memory file text that starts with `--` retains the existing domain refusal.
The worker brief also uses files for memory summaries and queries.
The sibling audit found no affected examples in the other manager step files.
Both decision verbs retain their confirm dialog and inline escape rule.
The real-shell test proves denial makes zero calls and approval delivers one literal note.
Independent mutation probes cover confinement, argv conflicts, replay refusal, each file consumer, and owner authority.
The focused tests detect all 25 valid mutations. Each mutant passed TypeScript before its test.
One initial minimum-text mutation survived. A missing-summary test detects it now.
One initial field mutation did not build. A valid field mutation replaced it and the test detected it.

No changelog entry, version change, dependency, factory-definition change, or production action is part of this implementation.

## Repeat local gate

The repeat suite at `ba782483` completed 17,988 tests in 777.54 seconds.
It passed 17,956 tests, skipped two tests, and failed 30 tests.
The three reported time failures did not recur. No test limit or guard changed.
The two 40,000-word scans took 126.91 ms and 97.04 ms under the full suite.
The unclosed-quote checks took 16.92 ms and 45.07 ms.
The memory model fetch failed with `ECONNRESET`; 29 memory tests failed.
The Git builtin test failed with Git 2.47.0 and passed with Nix Git 2.56.0.
The focused Git check passed 27 tests with zero failures.
