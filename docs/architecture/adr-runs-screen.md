# ADR: Read a bounded worker screen through runs.screen

## Context and decision

This plan covers bead claude-factory-hpmc.3 and spec 008, FR-012.
The core catalog already supplies run reads through `Port`.
AX workers run headless. They have no worker tmux pane.
Their session stream lives in `own()/<harness>.jsonl`.
Use that stream as the AX screen. Return its raw text; JSONL content remains text.
Do not add a terminal renderer or a transcript parser.

Add `runs.screen` with `GET /v1/runs/:id/screen`.
Use one required `id` field, output `text`, rights `read`, `mutates: false`, and `long: false`.
Use the existing catalog version and response conventions.
The successful response contains screen text, without a JSON envelope or an extra newline.
An empty available screen succeeds with empty text.

Resolve the current saved run context through a new `corePort.screen` helper.
Do not call `show()`, load a factory definition, read beads, or refresh the board.
Use only the saved worker address `c.pane`.
For Herdr, call `herdr pane read <pane> --lines 60`.
For AX, call `ax ssh <task> -- <asWorker(factory worker screen)>`.
Preserve the existing AX context, workspace selection, executable override, and worker user rules.
Add the internal `factory worker screen` verb with no arguments.
It reads at most the last 65,536 bytes of the current harness stream with a bounded file read.
Only regular stream files qualify. Reject symlinks and special files before a read.
Do not use `poll()`: it also reads the outbox and starts git.
Do not use the manager pane or `attachRead()`: they belong to a different worker.

Each caller must cap returned UTF-8 text at 65,536 bytes, with the newest text retained.
Discard an incomplete UTF-8 prefix after a tail cut. Do not append a truncation marker.
Bound subprocess stdout and stderr buffers separately; 128 KiB each is the hard ceiling.
Output within those buffers but above 64 KiB succeeds with the last 64 KiB.
A buffer overflow fails with a bounded reason; it must not return a partial success.
Use one process attempt with a 9,000 ms deadline and a hard kill.
The whole operation must return within 10,000 ms, including cleanup.
Do not retry or fall back to another worker.

## Closed input contract

This change is security-sensitive: it checks inputs and reads worker output through infrastructure access.
Accept only the following fields and forms. Reject other forms before any process launch.

- API: one raw run id that passes the existing catalog `id` rule.
- API: no query fields, caller paths, worker address, command, limit, or timeout override.
- Saved Herdr address: `^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$`.
- Saved AX address: exactly `ax://` plus one RFC 1123 label of 1 through 63 characters.
- AX label: lowercase letters, digits, and internal hyphens; first and last characters are alphanumeric.
- Worker verb: no arguments; harness is exactly `claude`, `codex`, `cursor`, `grok`, or `pi`.
- Worker path: the configured worker directory plus that enum value and the literal suffix `.jsonl`.

An absent harness keeps the current default, `claude`.
An unknown harness must fail, without a file read.
The configured directory comes from the process environment, never from an API input.
Use argument arrays. Do not interpolate a run id or worker address into shell text.
Do not parse shell commands, arbitrary URLs, transcript JSON, user paths, or tmux targets.
Those forms are out of scope and must not become alternate input forms.
Preserve the client port's refusal of Authorization headers.
Keep screen contents and remote stderr out of logs and error reasons.

## Acceptance criteria

All criteria are pre-merge checks. None is must-see-live.
Use the named tests below with `bun test --timeout 30000` and the listed test file.

AC1. Test `runs.screen catalog and route` in `src/core/catalog-handler.test.ts` proves the new GET route and metadata.
Update `src/core/catalog.test.ts` and catalog name/count expectations.
A valid fixture id returns status 200 and the exact screen bytes.
No idempotency key or expected revision is necessary.
POST remains 404; unknown query fields, duplicate fields, encoded separators, and malformed ids return 400.
An Authorization header remains 403. Every refused row makes zero port and subprocess calls.

AC2. Test `runs.screen herdr fixture` in `src/core/ops-cli.test.ts` exercises the real core port with a saved run.
A fake Herdr binary returns two distinct screens on successive calls; the operation returns each current screen.
Assert the exact pane-read argv and `--lines 60`.
An empty pane screen succeeds.
Assert zero AX calls and no run-state, mail, outbox, or revision changes.
Do not require a new top-level CLI alias; use the core port from an isolated process if necessary.

AC3. Test `runs.screen AX fixture` in `src/ax.test.ts` records the mocked AX argv.
Assert one ssh call to the saved task and the fixed worker-screen verb.
Cover configured context and both existing worker-user capability modes.
Assert zero Herdr, resume, prompt, create, delete, or poll calls.
Test `worker screen stream` in `src/worker.test.ts` covers all five harness streams with distinct fixture text.
The absent harness uses Claude; an empty regular stream succeeds.
No stream yields a reason, not a blank success.
Pi shows the last available stream; its headless process does not supply new output during a turn.

AC4. Test `runs.screen refusal reasons` in `src/core/ops-cli.test.ts` covers unknown runs and null or absent worker addresses.
It also covers invalid address types, unsupported schemes, whitespace, control bytes, shell syntax, and flag-shaped addresses.
Cover `ax://`, uppercase AX labels, trailing hyphens, extra path segments, and overlong names.
Valid controls include `w1:p1`, `p1`, and `ax://f-run-1`.
Every invalid row fails before a downstream process call.
Use `RunResult.code = 1`, empty stdout, and a stable reason through the existing 422 API error convention.
Distinguish absent run, no worker, invalid address, unavailable screen, process failure, overflow, and timeout.
A missing executable, dead pane, unreachable task, or old worker verb must fail with the applicable reason.
Do not include raw subprocess stderr, credentials, or screen text in errors.

AC5. Tests `runs.screen byte cap` and `worker screen bounded read` cover ASCII and multibyte UTF-8.
Put a unique marker at the end of each fixture and assert that it survives.
Cover 65,535, 65,536, and 65,537 bytes, plus a larger stream file.
Assert the final byte length, exact suffix, and absence of a replacement character at a split prefix.
Prove that the worker reads at most 65,536 file bytes, not the whole file.
Reject unknown harnesses, symlinks, directories, and FIFOs with zero stream reads.
Use `src/core/ops-cli.test.ts`, `src/ax.test.ts`, and `src/worker.test.ts`.
A fake process that exceeds either 128 KiB buffer fails; stderr cannot bypass the bound.

AC6. Test `runs.screen deadline` in `src/core/ops-cli.test.ts` uses real fake binaries for both backends.
Each fake must remain alive beyond 10 seconds unless the operation kills it.
Cover a silent process and a process that continues to emit output below the buffer ceiling.
Measure operation time with a monotonic clock; require less than 10,000 ms.
Assert a timeout reason, empty stdout, one attempt, and no surviving capture process.
A fast successful control must still return its exact text.
Do not prove this only with a rejected promise; the process must stop.

AC7. Existing catalog, API, CLI, AX, and worker tests retain their behavior.
Run `bun test --timeout 30000 src factories`, `bunx tsc --noEmit -p .`, and `claude plugin test mod`.
Run `bunx prettier@3.9.9 --check .`, `bun audit`, and the repository secret scan.
Required CI checks test, plugin, typecheck, and format must pass on the final PR SHA.
There is no standalone build target; typecheck is the compile check.
Do not weaken tests, raise time limits, or ship a deliberately red PR head.

## Files and rejected alternatives

Change `src/core/catalog.ts`, `src/core/ops/runs.ts`, `src/cli.ts`, `src/ax.ts`, and `src/worker.ts`.
Extend the test files named in AC1 through AC6 and existing typed Port fixtures.
Use the platform process timeout and buffer limits where they meet AC5 and AC6.
If they do not, use the smallest bounded stream reader and hard-kill path.
Keep any shared helper local to this feature; add no dependency or general runner framework.

A tmux capture fails for current headless AX workers.
A full poll returns unrelated data and has larger time and buffer limits.
A whole transcript read has unbounded memory cost.
A promise timeout alone leaves the subprocess alive.
A manager-pane fallback can expose the wrong conversation.
No UI, factory definition, authentication change, or separate generic CLI framework belongs in this run.

## Tests first and commit tasks

Use one draft pull request for both tasks, in dependency order.
Commit the new failing tests before the implementation.
Prove the failures come from the absent operation or worker verb, not fixture setup.
The test commit can be red locally; the final PR head must be green.

1. `claude-factory-hpmc.3.1`: add AC1 through AC6 fixtures and assertions. Budget 35 minutes.
   Check the focused tests and format. Record the expected baseline failures.
2. `claude-factory-hpmc.3.2`: add the operation, bounded reads, and errors. Budget 60 minutes.
   Check AC1 through AC7. Reserve 25 minutes for full checks and review evidence.

Task `.3.1` blocks task `.3.2` in beads.
Commit each task separately. Keep both commits in the same PR.
No external feature dependency remains: the core-catalog parent dependency is closed.

## Risk, rollout, rollback, and observability

Worker screens can contain private text. Use the existing client transport boundary.
Do not log, persist, or copy screen text into telemetry.
Review and security must inspect address validation, process bounds, file selection, and error redaction.
The operation changes no stored data and needs no schema migration or new flag.
The new worker verb needs the released worker code.
Release worker support before the core endpoint where the release process permits that order.
Old workers must return a clear unavailable-screen error. Never resume or replace them for this read.
A person must approve any production registry push or live switch outside the normal authorized release pipeline.
This plan does not grant that approval.
No pre-merge criterion depends on a production read.

A person merges the reviewed PR. Deploy follows the normal release process.
Rollback uses a new revert PR and the normal release process.
Clients must tolerate an absent catalog operation after rollback.
An old worker image remains compatible with the other operations.

The ship soak checks the released revision and the catalog entry through the existing client interface.
If an authorized live screen read is available, record status, elapsed milliseconds, and byte count only.
Do not record the screen body or remote stderr.
No live sample is mandatory: fixture checks prove backend selection, byte limits, and the deadline.
No new metric or persistent log is necessary.
No known bug becomes worse through this change.

## Plan evidence

The plan started from commit `2d2003d9` with a clean worktree and no run PR.
This checkout has no CLAUDE.md, AGENTS.md, or CONTRIBUTING file.
The plan read the supplied rules, bead history, core code, AX code, worker code, tests, and CI commands.
The memory search returned no local notes.
The baseline core check passed 134 tests and 425 assertions across three files.
Plan did not run the full suite, plugin check, typecheck, audit, or production reads.
This station changes only this ADR.
