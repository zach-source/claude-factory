# ADR: Read a bounded worker screen through the core

## Context

This plan covers `claude-factory-hpmc.3`, in run `lifecycle-mw93mog3th`.
The run bead is `claude-factory-keuya`. The catalog dependency, `hpmc.1`, is closed.
The route contract already names `GET /v1/runs/:id/screen`.
No repo-local CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists at this revision.

`src/core/ops/runs.ts` uses the core port for run reads.
`src/cli.ts:12436` builds that port. Core modules must not import the CLI.
`src/ax.ts:779` polls workers through SSH as the worker user.
That poll also reads the outbox and runs git. It has a 30-second timeout.
`src/worker.ts:529` appends harness output to `<worker-dir>/<harness>.jsonl`.
Workers do not have a terminal pane. The AX screen is the latest text from that stream.
The stream can contain JSON lines. This operation does not parse or render them.
Pi has no new output until its turn ends. An empty stream is a valid empty screen.

## Decision

Add `runs.screen` as a local catalog operation in `src/core/ops/runs.ts`.
Use `output: text`, `rights: read`, `mutates: false`, `long: false`, and catalog version 1.
Its only input is the required `id` field. Keep the route contract unchanged.
Return the existing `RunResult` type through a new port method.
Use the current run state to select its pane. Do not call `show`, which also queries beads.
Do not restore, start, prompt, poll, or close a worker.

For a herdr pane, execute this argv:

```text
herdr pane read <pane> --source recent-unwrapped --lines 60
```

Honor the existing `FACTORY_HERDR` executable selection.
For AX, add a narrow helper in `src/ax.ts`. Keep the existing context, atespace, and worker-user setup.
Execute `ax ssh <task> -- <asWorker argv for factory worker screen>`.
Add the exact zero-argument `factory worker screen` verb in `src/cli.ts` and `src/worker.ts`.
Use positional file reads to return the final 65,536 bytes of the selected harness stream.
Close the descriptor on each exit path. Do not load the whole stream.
Do not use a session ID, an outbox, a transcript search, or a shell command.

Use asynchronous subprocess reads for both transports, with one deadline and no retry.
Set the subprocess deadline to 9,000 ms, to leave time for a response within 10 seconds.
Kill and reap the local process at the deadline. Release its streams and timer.
Keep only the final 65,536 bytes of stdout and at most 4,096 bytes of stderr in memory.
Drain excess bytes without accumulation. Do not wait until exit to apply these caps.
Keep valid UTF-8 at a cut boundary. The encoded result must remain within its byte cap.
The cap excludes the HTTP envelope. Do not append a newline or a truncation marker beyond the cap.
An output overflow alone is not an error: the operation returns the newest text.

Use `timedOut: true` for a timeout; the current handler returns HTTP 504.
Use `OpError(404, ...)` for an absent run and `OpError(409, ...)` for a run without a pane.
Use code 1 with a fixed reason for a failed transport, invalid stored address, or unavailable worker verb.
The current handler returns HTTP 422 for those failures.
Do not return raw transport stderr, auth headers, environment values, or remote command lines in errors.
Keep successful screen text verbatim, apart from the byte cap and UTF-8 boundary.

### Closed input grammar

Accept only a catalog `id` that matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
Accept no query fields, body fields, caller paths, line limits, commands, task names, or transport overrides.
Validate the ID before any run-file access, including direct operation calls.
Resolve only that run's current `pane` field. Do not accept a caller-supplied pane.
Treat null or absent pane as no worker. Treat every other non-string pane as invalid.

Accept herdr pane strings that match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
This includes `w1:p1` and opaque pane IDs. It excludes slashes and option prefixes.
Accept AX addresses only as `ax://<task>`, where the task is a DNS label of 1 through 63 characters.
The task grammar is `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
Reject every other address before a subprocess call. Never send an ID or task through a shell.

The worker verb accepts no operands or flags.
Its only file selector is `FACTORY_HARNESS`, with default `claude`.
Accept only `claude`, `codex`, `cursor`, `grok`, or `pi`.
Read only `<own()>/<accepted-harness>.jsonl`, with the existing worker directory configuration.
Reject an unknown harness before file access. Reject symlinks and non-regular files without a read.
A missing stream returns empty text; other file errors return a fixed reason.
There is no new parser for shell input, JSON output, URLs, session IDs, or config files.
Interactive attach, tmux discovery, arbitrary remote commands, and frontend rendering are out of scope.

## Acceptance criteria and first tests

Implement must commit the new tests first and record their failures on the pre-change code.
Keep the tests and the implementation in one pull request. The final required checks must pass.

| AC | Test and proof | Positive and negative rows |
| --- | --- | --- |
| AC1 | `bun test src/core/catalog.test.ts src/core/catalog-handler.test.ts src/core/ops.test.ts` | The catalog exposes the exact read metadata and route. A valid GET calls the port once. POST, query fields, encoded separators, an empty ID, traversal, and an overlong ID call no port. Authorization-header requests remain denied with zero port calls. Direct invalid inputs cause zero file reads or process calls. |
| AC2 | `bun test src/core/ops-cli.test.ts` with fixture run state and fake herdr | A `w1:p1` pane returns the last screen through the real port and HTTP handler. Assert exact argv. An opaque safe pane ID also works. An absent run returns 404. A null pane returns 409 with a reason. Invalid pane types, whitespace, shell punctuation, slash paths, and option prefixes cause zero subprocess calls. No run files or outbox files change. |
| AC3 | `bun test src/ax.test.ts src/core/ops-cli.test.ts` with fake ax | An `ax://f-acme-1` run returns its worker screen. Assert context, atespace, worker identity, and exact argv. Test a one-character task and a 63-character task. Empty, 64-character, uppercase, slash, whitespace, trailing-hyphen, and option-like tasks cause zero SSH calls. A failed SSH or old worker verb returns a fixed non-success reason, with no stderr secret in the response. |
| AC4 | `bun test src/worker.test.ts` plus worker-verb cases in `src/core/ops-cli.test.ts` | Each of the five harnesses returns its own stream tail. Test default Claude, empty and missing streams, exact cap, cap plus one, multi-byte cuts, and a large file. Assert bounded file reads. Unknown harnesses and extra verb operands cause zero stream reads. Symlinks, directories, and FIFOs return an error without a read or hang. No other harness file is read. |
| AC5 | Transport cases in `bun test --timeout 30000 src/core/ops-cli.test.ts src/ax.test.ts` | For both backends, flood stdout and stderr, then hang. Assert bounded retained bytes, newest output, a timeout result within 10 seconds, and local process exit. Check a quiet hang and normal exit too. A concurrent fast request must finish before the hung request times out. Assert HTTP 504 for timeout and HTTP 422 for nonzero exit. |
| AC6 | `bun test src/core/import.test.ts src/core/ops-cli.test.ts src/core/catalog-handler.test.ts` | Core imports cause no output or writes. Existing routes and catalog parity stay valid after the new entry. AX screen reads cause no poll, git, outbox replay, worker launch, prompt, or close calls. Tests compare run state and relevant file bytes before and after both success and failure. |

Use fake executables and isolated factory homes. Strip `FACTORY_OUTBOX` and `FACTORY_FROM` in CLI subprocess fixtures.
Set `FACTORY_SELF_UPDATE=0`. Do not require AX credentials or a live cluster for any acceptance test.
Tests must exercise the concrete port and transports, not only a fake port response.
Use the repo's test fixture conventions. Update catalog name/count fixtures without removal of their checks.

## Files and rejected options

Touch `src/core/catalog.ts`, `src/core/ops/runs.ts`, `src/cli.ts`, `src/ax.ts`, and `src/worker.ts`.
Extend the test files named above and any typed port fixtures that need the new method.
Add no changelog entry or version change. The release step writes the changelog.
Leave `src/worker-system.md` and `.factory/` unchanged.
Keep transport logic outside the core import graph. Reuse current configuration and worker identity helpers.
Do not add a dependency, persistent cache, configurable cap, or second screen API.

- Reject `ax.poll`: it has unrelated reads, a longer timeout, and a Claude-only session tail.
- Reject tmux capture: these workers execute print-mode harnesses without a terminal pane.
- Reject synchronous SSH: it blocks other API reads for the full timeout.
- Reject shell interpolation: task text must never become executable shell input.
- Reject whole-file reads and post-exit truncation: they do not bound resource use.
- Reject new frontend views: `hpmc.10` and `hpmc.11` own those changes.

## Risk, rollout, and rollback

This change is security-sensitive: it reads remote worker output and validates process and file inputs.
Use the current client-port access rules. Do not broaden credentials, network access, or worker rights.
A screen can contain sensitive task text. Do not copy screen bodies into audit logs or error messages.
Frontends must treat the result as data; this task adds no HTML or terminal renderer.
The bounded read limits memory use. The deadline limits stale SSH calls.
No database migration, persisted schema change, feature flag, or production write is necessary.

Ship the worker verb before, or with, the manager release that exposes the catalog operation.
Old workers return an explicit transport error. Do not restart them or fall back to an unbounded poll.
New workers use the verb after their normal image rollout. Keep old operations compatible.
Rollback through a pull request that reverts the feature commits. A worker with the extra verb remains compatible.
A person must merge. Owner-only rollout steps remain outside this run.

## Observability and checks

No AC is must-see-live. Local fixtures prove the feature before merge.
The ship soak can read one authorized herdr run and one new-image AX run through the client route.
Record backend, HTTP status, byte count, elapsed time, and deployed revision; do not record the screen body.
Expect HTTP 200, at most 65,536 screen bytes, and less than 10 seconds per call.
Record an unavailable backend as a coverage gap, not as proof of success.
Live reads belong to ship soak or an owner step, never to a pre-merge acceptance gate.
Use the normal soak deadline; this feature needs no new metrics or persistent logs.

## Commit tasks

1. `claude-factory-keuya.2`: Add the AC1 through AC6 tests. Record the expected failures before the feature exists.
2. `claude-factory-keuya.3`: Add the bounded worker verb and transport helpers. Check worker, AX, and transport tests.
3. `claude-factory-keuya.1`: Add the core port and catalog operation. Update catalog fixtures. Run all AC tests.

Tasks 2 and 3 depend on task 1; task 3 also depends on task 2.
Keep all three commits in one draft pull request.
Four partial passes could not run the transport tests because the tool hook denied them.

### Revised execution gate

The plan station reproduced the same denial on 2026-11-09 at `a3bdba46`.
The hook rejected this command before execution:

```text
bun test --timeout 30000 src/core/ops-cli.test.ts src/ax.test.ts
```

The stated reason concerns a home-directory delete or move, including scripts that do so.
The command itself requests neither action. The plan does not establish which transitive input caused the denial.
No alternate command form ran. Do not bypass the hook or change tests merely to evade it.

The missed cause of the repeated rounds was the handoff rule: an external test barrier remained an implementation prerequisite.
Another implementation pass cannot resolve that prerequisite through feature code.
Park this run as blocked until the manager supplies a hook correction or an authorized test path.
Do not report partial and send the same task through another implementation round.
Do not change `.factory/` or the worker hook within this feature.

After the manager resolves the barrier, run the exact command above before a ready handoff.
It must reach the test runner. Record assertion failures separately from tool or environment failures.
Keep existing test commits. Finish task `.2`; do not recreate its six test files.
Provide `pkill` through the supported VM toolchain before the full worker suite.
The previous ten `pkill` failures do not prove a feature defect.

Keep the three existing tasks, their dependency order, and AC1 through AC6.
Budget 30 minutes for the remaining test evidence, 60 minutes for transports, and 30 minutes for core integration.
External environment repair is outside that 120-minute implementation budget.
Do not split off AX: both transports share the absent port contract and the current test commits.
A split would leave required checks red or require test removal without resolution of the barrier.
Keep PR #746 as a draft until all feature checks pass and an authorized station approves it.

### Pre-change test evidence

At `c8d9c3cb`, after `bun install`, the AC1/core-import command gave 104 passes and 10 expected feature failures.
`bun test src/worker.test.ts` gave 52 passes and 22 failures.
Twelve failures name the absent `worker.screen`; ten other failures require the absent `pkill` tool.
`bun node_modules/typescript/bin/tsc --noEmit -p .` gave 12 errors for absent screen methods.
The hook denied the AC5 transport command and a read of `src/core/ops-cli.test.ts` before execution.
Its reason states that each command deletes or moves a home directory.
Neither command requests that action. Manager mail requests a hook correction or an allowed command.
Task 1 remains open until the transport tests can run.

Before handoff, run `bun test --timeout 30000 src factories`, `bunx tsc --noEmit -p .`, and `claude plugin test mod`.
Run `bunx prettier@3.9.9 --check .`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Use exact-head CI for any documented local tool gap. Do not waive required checks.
