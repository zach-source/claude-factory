# ADR: Gate the server patrol fix on test access

## Context

Bead: `claude-factory-t54il`. PR: https://github.com/zach-source/claude-factory/pull/812.

Four implement passes stopped at the worker hook. They left HEAD at `e2c8b15b`.
Commit `678ce2f4` completed T1. Commit `e2c8b15b` added incomplete T2 tests.
The PR remains a draft. Its test, typecheck, and format checks fail. Plugin and nix checks pass.

This plan pass reproduced a denial for `rg -n '^' src/core/guards.test.ts`.
The hook reported possible home deletion. The command did not start.
The read of `src/core/guards.ts` passed. That source still exports none of the planned server guards.
The exact cleanup expression remains unknown because the hook denied access to the test file.
The reports establish an access prerequisite, not a need for another implement retry.

## Decision

Park this run until the manager resolves the access restriction or supplies an approved correction.
Do not change readers, move tests, remove assertions, or bypass the hook to evade this denial.
Do not change the worker hook in this security fix.

Preserve T1 and the incomplete tests. Finish T2 and T3 in the same PR after access returns.
The plan comment from 2026-11-10 remains the detailed implementation contract.
This ADR adds a prerequisite and preserves its AC numbers below.
The server patrol must remain off. This change provides tool controls, not an OS security boundary.
The separate OS barrier remains `claude-factory-axo88`.

## Design contract

Server mode comes from `FACTORY_STEP_ISOLATE=1`, before runStep removes that variable.
Use `patrol-guard --server` for Bash, Read, Grep, Glob, and Write.
Keep the local patrol behavior unchanged.

In `src/core/guards.ts`, add `secretPath`, `serverBashReason`, and `serverToolReason`.
Reuse `realPath` from `src/token-guard.ts`.
The secret roots are `/etc/factory`, `/run/secrets`, `/var/run/secrets`, and `/proc`.
Deny paths within these roots, their ancestors, and symlink aliases.
Check both lexical and resolved paths. Deny unresolved paths and invalid or relative cwd values.

Bash accepts one literal command only. It must not expand or execute shell text during validation.
Outside quotes, allow spaces, tabs, and characters `A-Z a-z 0-9 _ . / : = @ % + , -`.
Single quotes accept literal text. Double quotes reject dollar signs, backticks, backslashes, and exclamation marks.
Reject unfinished quotes, empty commands, and all other unquoted syntax.
Adjacent quoted and unquoted parts form one word.

The executable must be `factory`, the exact CLI path, or `bd`.
The factory verb set is `status mail poke retry goto abort fork rm start queue backlog waiting home memory rig file-elsewhere`.
Memory accepts only `search` or `add`. Rig accepts no subcommand, or exactly `list`.
Start accepts a factory name with an optional station suffix, then a rig name.
Queue accepts a rig name. Names match `[A-Za-z0-9][A-Za-z0-9_-]*`.
Reject a start factory name or start/queue rig name that resolves to an existing cwd entry.
This stops factory imports from a path under model control.
Apply the secret path rule to every argument, its value after `=`, and its attached short-option value.
Apply the existing `check(command, 'subagent')` only after these checks pass.
A rejection must make zero downstream command calls.

The hook reads `tool_name`, `tool_input`, and `cwd` from JSON.
Bash reads `command`. Read and Write read `file_path`.
Grep reads optional `path`, with cwd as the default.
Glob reads optional `path` and required `pattern`.
Glob rejects absolute patterns, tilde prefixes, and parent path segments.
Grep filter fields do not select a new path.
Reject invalid field types, null inputs, unknown tools, and exceptions before any tool call.
Write accepts only paths strictly under `FACTORY_HOME/text`, both lexically and after symlink resolution.
Use the guard process environment for FACTORY_HOME. Reject an absent or relative value.

In `src/cli.ts`, parse the server flag and return exit 2 for a denial.
In `src/once.ts`, pass server mode and merge the hook settings with existing deny rules.
Add `Read(//etc/factory/**)`, `Read(//run/secrets/**)`, `Read(//var/run/secrets/**)`, and `Read(//proc/**)`.
T1 in `src/steps.ts` retains its secret env filter, cwd pin, and shell rc removal.
Do not change `deploy/server.yaml`, the patrol prompt, or `.factory/`.

Rejected alternatives: repeated retries cannot remove the access block.
A path deny list alone permits scripts and shell expansion.
Permission settings alone do not cover all Bash access.
A separate container needs a larger API and lease design; the follow-up owns that work.

## Acceptance criteria and tests

First restore authorized access to the existing test file and its test and format commands.
Do not interpret a hook denial as a failed test.

| AC | Proof | Required negative and positive rows |
| --- | --- | --- |
| AC1 | `bun test --timeout 30000 src/once-cli.test.ts` | Server hook exits 2 for Read and Bash cat of the worker key. Deny TLS, backup, SA token, proc, ancestors, traversal, and symlink aliases. Allow Read of home/text/a.md and factory status. |
| AC2 | `bun test src/core/guards.test.ts` | Reject interpreters, env prefixes, unlisted verbs, shell operators, expansion, redirects, malformed quotes, and existing start/queue paths. Allow literal status, bd show, memory search, rig list, and quoted mail text. Assert zero downstream calls on rejection. |
| AC3 | Same guard test command | Deny secret paths for Read/Grep/Glob, invalid fields, unknown tools, unresolved paths, and Write outside home/text. Deny rc writes and symlink escapes. Allow a text write, a safe Read, and Grep with default cwd. |
| AC4 | `bun test src/steps.test.ts` | Remove AX_AUTH_TOKEN, LINEAR_API_KEY, backup env, and ACME_SECRET in server mode. Retain the documented model and GH_TOKEN exceptions. Preserve local env and explicit cwd. Check default Claude/Codex cwd, five rc files, and secret names from the deploy manifest. |
| AC5 | `bun test --timeout 30000 src/once-cli.test.ts` | Server settings include both hook matchers, --server, and all four Read denies. Preserve base denies. Local settings gain none of them. |
| AC6 | Same CLI test command | Existing local guard tests pass unchanged. Server mode rejects unknown tools and malformed JSON with exit 2. |
| AC7 | Full gate on the final PR SHA | Run repo test, typecheck, and format checks, gitleaks, and bun audit. Required CI must pass. No merge with the incomplete test commit as the final head. |

The full gate uses `bun run test`, `bun run typecheck`, and `bun run format:check`.
Use `gitleaks detect --log-opts=origin/main..HEAD` and `bun audit`.
No AC is must-see-live because this PR must not enable the server patrol.

Write the T3 integration tests before the implementation. Retain the T2 test tables already committed.
After access returns, record the pre-fix test failure, then finish each change.
Mutate each guard condition alone after a commit. Each mutant must build and fail its dedicated test.
Cover root, ancestor, symlink, option-value, cwd, name, existence, Write, and unknown-tool checks.

## Risk

This work is security-sensitive. The patrol consumes untrusted mail, titles, and journal text.
Tool hooks do not establish an OS boundary. Hook startup failure and same-uid access remain outside this scope.
Secrets within FACTORY_HOME and retained model credentials remain outside the path rule.
The OS barrier follow-up must address these limits before activation becomes safe.
The env filter can impair AX or Linear calls. Local behavior must remain unchanged.
No data migration exists. No production action belongs to this plan.

Security-sensitive: yes (secrets, permissions, untrusted command parsing)

## Rollout, rollback, and observability

Keep `--patrol-every-ms` at its default 0. Do not add it to the deployment.
Security review remains required. A person controls any later activation.
Rollback uses a revert PR. There is no state migration to reverse.
Hook stderr provides denial reasons. Step records and patrol transcripts provide later soak evidence.
Do not read production secrets or start a live patrol to verify this PR.

## Tasks and resume gate

1. T1, `claude-factory-t54il.1`: complete at `678ce2f4`; preserve it. Check AC4.
2. T2, `claude-factory-t54il.2`: blocked on access; then one completion commit for guards and tests. Check AC2 and AC3.
3. T3, `claude-factory-t54il.3`: follows T1 and T2; one commit for hooks and CLI tests. Check AC1 and AC5 through AC7.

The existing WIP commit remains in history. Do not rewrite published commits.
After access returns, the remaining scope targets one 120-minute implement pass.
Do not report ready until the manager resolves the access prerequisite.

## Resume check on 2026-11-11

The rework pass retained the access prerequisite and requested a manager correction.
It did not retry the denied test read or use another reader.
After `bun install`, `bun test src/steps.test.ts` passed: 27 tests, 0 failures, 183 assertions.
The formatter passed for `src/steps.ts`, `src/steps.test.ts`, and this ADR.
The fetched `origin/main` had no commits beyond HEAD `f81e20b0`.
T2 and T3 remain open. The full gate and AC1 through AC3 and AC5 through AC7 remain unverified.

## Test-command access check on 2026-11-11

The next pass requested a manager correction for the prior test-command denial.
No correction arrived before its report. The pass did not retry the denied command.
`git merge origin/main` reported no new commits.
After `bun install`, `bun test src/steps.test.ts` passed: 27 tests, 0 failures, 183 assertions.
T2 and T3 still need authorized test-command access. This checkpoint adds no behavior change.
