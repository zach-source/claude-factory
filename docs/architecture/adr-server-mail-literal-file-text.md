# ADR: Preserve literal file text in server mail

## Context

Bead: `claude-factory-teyn1`. Base: `7595aef6`.

`src/cli.ts:13520` expands mail file arguments before `client.main`.
`src/client.ts:117` then interprets the expanded third argument as an option.
A file that contains `--wake` thus causes a usage refusal instead of mail.
The ordinary file test at `src/client.test.ts:506` does not cover this case.

## Decision

Parse the server mail options from the original argv before file expansion.
Keep the parsed wake value separate from the file text through request construction.
Never parse file text as argv, a path, an option, or shell code.
Preserve the existing `trimEnd()` behavior; this change does not promise trailing whitespace preservation.

Change `src/cli.ts` and `src/client.ts` only as necessary for this boundary.
Pass raw argv to the client and supply a small callback for the existing mail file expansion.
The route must capture the original wake option before it calls that callback.
Use the original text offset after expansion; do not inspect expanded text for options again.
Keep direct inline route calls compatible when no callback exists.
A file-form route without a file resolver must refuse instead of sending the path as text.
Do not import `cli.ts` from `client.ts`: the CLI module has import effects.
Reuse `fileArgs` and `textFileArg`; do not copy their path checks or create a general parser framework.

Extend `src/client.test.ts` for spawned CLI tests and route tests.
Extend `src/server-api-handler.test.ts` for a spawned CLI through the real `clientHandler` and its mail port spy.
Keep server production code unchanged unless a demonstrated test failure requires a small related change.
No dependency, factory definition, protocol, or persistent format change is necessary.

## Parser boundary and grammar

The fail-closed rule applies to file-form mail: accept only the existing complete form and validated file before any HTTP request.
The form is `mail <run> <box> [--wake] --text-file <path>`.
Run and box must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
Only the original third argument can select the optional `--wake`.
The file flag must follow box or that one wake option, with exactly one nonempty path and no remaining argument.
A separate `--text-file` token elsewhere in the text arguments must retain its current refusal.

The path can be absolute or relative to cwd.
Its real path must descend from `<FACTORY_HOME>/text/` or the current git worktree's real `.scratch/` directory.
The cwd must lie inside that worktree, and `.scratch/` itself must not be a symlink.
Existing allowed file symlinks must resolve within an allowed root.
The file must be readable, regular, nonblank, and at most 100 KiB before text conversion.
Reuse the existing implementation as the authority for path and size checks.
Reject every invalid file form or file before transport; tests must assert zero HTTP requests and zero mail calls.

The request remains `POST /v1/runs/<run>/mail`.
Its fields remain `to`, `text`, `from: 'manager'`, `cwd`, and optional `wake: true`.
The server must retain its existing body validation and worker-worktree sender refusal.
This change does not parse another tool's language or add a shell grammar.

Inline mail keeps its current grammar: run, box, optional leading wake, then text words joined by spaces.
Unknown option-like words within file text remain data, including `--text-file`, `--from`, and `--unknown`.
Equals-form flags, new option positions, `--` syntax, local mail, memory flags, and outbox transport changes are out of scope.
Related beads `claude-factory-9ydy` and `claude-factory-kq7p` own the other flag defects.
Do not make this fix depend on those beads or ship red checks by design.

## Acceptance criteria

### AC1: Preserve file text independently of wake

Add tests named `teyn1 AC1` in `src/client.test.ts`.
Spawn the real CLI with `FACTORY_SERVER` set to an isolated loopback request recorder.
For each file value below, assert exit 0, exactly one mail request, and the expected text.

- `--wake`: text must equal `--wake`, and the request must omit `wake`.
- `--text-file`, `--from`, and `--unknown`: each value must remain literal text.
- Ordinary text and multiline text with leading whitespace, quotes, and shell metacharacters: preserve text except trailing whitespace.
- Repeat `--wake` and ordinary text with an explicit argv `--wake` before `--text-file`: the request must contain `wake: true`.

Assert the path, recipient, sender, cwd, and idempotency key as well as the text.
Proof: `bun test --timeout 30000 src/client.test.ts`.

### AC2: Retain file validation and inline compatibility

Add tests named `teyn1 AC2` in `src/client.test.ts`.
Refuse missing paths, extra arguments, repeated file flags, and file flags after inline words.
Refuse invalid run or box segments, missing files, directories, empty files, whitespace-only files, and files over 100 KiB.
Refuse files outside both roots, symlinks that escape a root, and a symlinked worktree `.scratch/` directory.
Each refusal must exit nonzero, identify the relevant error, and make zero HTTP requests.
Permit a file in home/text and a file in a real worktree `.scratch/`, including a relative path from that worktree.
Retain inline mail with and without explicit wake, and refuse missing inline text, including a lone explicit `--wake`.
Test a direct file-form route without a resolver: it must refuse and make zero transport calls.
Do not impose new restrictions on option-like inline text outside the existing reserved positions.
Proof: `bun test --timeout 30000 src/client.test.ts src/text-file-flags.test.ts`.

### AC3: Prove the server route and sender boundary

Add tests named `teyn1 AC3` in `src/server-api-handler.test.ts`.
Serve the real `clientHandler` on loopback with the existing mail port spy and an isolated home.
Spawn the real CLI with a permitted cwd and a file that contains `--wake`.
Assert one mail port call with literal text and false wake semantics; repeat with explicit wake and assert true.
Assert that no CLI bridge or other operation runs.
With cwd inside the target run worktree, assert HTTP 403 and zero mail port or CLI bridge calls.
Retain the existing invalid-sender and relative-cwd refusal tests.
Retain worker-marker client routing and local sender tests; workers must not gain manager transport access.
Proof: `bun test --timeout 30000 src/client.test.ts src/server-api-handler.test.ts src/mail-sender.test.ts`.

### AC4: Prove the complete patch

Record the pre-fix failure for AC1 and AC3, then their post-fix success.
The failure must show the usage refusal or wrong text/wake, not an unrelated environment failure.
After the fix commit, mutate the wake decision to inspect expanded text again.
Use `factory mutate <file:line> <old> <new> -- bun test --timeout 30000 src/client.test.ts`.
The mutant must compile and the literal-file test must kill it.
Run `bun run test`, `bunx tsc --noEmit -p .`, and `bunx prettier@3.9.9 --check .`.
Run `gitleaks detect --log-opts=origin/main..HEAD` and `bun audit`.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final PR head.
Record local tool gaps separately from CI evidence. Do not weaken a test to obtain a pass.

## Test plan

Write the failing AC1 and AC3 rows first, then the AC2 negative and compatibility rows.
Commit the tests before the fix, with the expected failure in the task record.
Keep both commits in one PR; do not release the tests-only state.
Use the existing test helpers rather than a new fixture framework.
Strip inherited worker, outbox, patrol, server, and main-chat markers from permitted subprocess environments.
Set a fresh `FACTORY_HOME`, empty rig map, and `FACTORY_SELF_UPDATE=0` for each isolated case.
Use asynchronous subprocesses so the loopback handler can answer requests.
Bound each subprocess and stop and await it during cleanup.
Never use the real factory home, mailboxes, or credentials in tests.

## Rejected alternatives

- Special-case the string `--wake`: this leaves the same data-versus-option error for other reserved text.
- Add an escaping sentinel to text: this changes mail content and creates a second decoding protocol.
- Change only local mail or the outbox: neither fixes the server client route.
- Read arbitrary paths in the client: this bypasses the existing root policy.
- Refactor every CLI parser: this expands the change beyond this defect and the 120-minute implementation pass.

## Risk

This is security-sensitive input parsing at a file and transport boundary.
An incorrect change can select wake unintentionally, expose file contents, or change sender behavior.
AC1 through AC3 check those risks and preserve the current trust boundaries.
The intended behavior change permits literal option text from a valid file.
Inline behavior, trailing-whitespace handling, wire fields, and server authorization remain compatible.
There is no database migration, credential change, or data rewrite.
Security-sensitive: yes (input parsing and file access)

## Rollout and rollback

Use one draft PR, then verify, review, and security before a person's merge.
Release through the normal ship path after the merge.
There is no flag, migration order, live switch, or owner credential step.
If rollback is necessary, revert the fix through a new PR for a person to merge.
Rollback restores the literal-option defect; prefer a small fix forward when possible.

## Observability

The CLI exit code, captured request, and server mail port arguments prove the behavior.
No new production log or metric is necessary; do not log mail content for this fix.
Ship soak can repeat AC1 and AC3 with the released CLI and disposable homes on loopback.
These checks need no production mailbox or privileged live read.
No AC is must-see-live; isolated process evidence and exact-head CI prove this parser boundary.

## Tasks

1. `claude-factory-teyn1.1`: Add regression and boundary tests for AC1 through AC3. Check the expected pre-fix failure, then commit the tests.
2. `claude-factory-teyn1.2`: Preserve raw mail option semantics through file expansion. Check AC1 through AC4, then commit the fix.

Task 2 depends on task 1. Both tasks must fit one implementation pass of at most 120 minutes.
The plan station commits only this ADR.
