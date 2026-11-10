# Restrict local patrol Write paths

Status: accepted plan for `claude-factory-oxib`.

## Context

At `49f59282`, `mod/hooks/register.tsx:1322` grants Write to the local patrol.
The tool hooks at lines 1404 and 1408 cover Monitor and Bash only.
`isPatrolAgent` at line 406 confirms an agent type through the engine.
`rt.patrolIds` retains known patrol IDs, which include old patrols.
The current prompt already directs text files to `<FACTORY_HOME>/text/`.

The latest bead comment limits this work to the local mod patrol.
Server patrol confinement belongs to `claude-factory-t54il.3`.
Console chat and settings guards belong to `claude-factory-qh8v2.3` and `.4`.
Text-file cleanup is outside this change.

## Decision

Add a Write `tool.call` hook in `mod/hooks/register.tsx`.
Use the engine's `agentId`, never file content, to identify a patrol.
A known ID in `rt.patrolIds` must match even after its patrol stops or another patrol replaces it.
Otherwise, use `isPatrolAgent` to confirm the ID, regardless of `rt.isPatrolling` or prior Bash calls.
Do not change `rt.patrolId`, action logs, or patrol lifecycle state from this hook.
No agent ID, or an unconfirmed ID, follows the existing hook chain unchanged.
An agent-list error cannot remove protection from a known patrol ID.
Unconfirmed IDs retain existing identity semantics; this change does not solve unavailable engine identity.

For a confirmed patrol, use one fail-closed rule:
Allow only a valid absolute POSIX path whose lexical normalized value is a strict descendant of normalized `rt.home/text`.
Every other path returns a stable deny result before `next` or any file write.
The deny must name the permitted directory without file content or the rejected path.
No dialog or turn-level permission can override this deny.
Pass allowed events unchanged to `next(e)` exactly once.
This hook must not override another hook's denial.

The closed path grammar is:

- Read only `e.file_path` as the tool's path field, plus trusted `e.agentId` and `rt.home`.
- `file_path` must be a nonempty string that starts with `/` and contains no NUL.
- `rt.home` must also be a nonempty absolute POSIX path without NUL. Missing or invalid home denies patrol Write.
- Normalize repeated `/`, `.` and `..` components with standard POSIX path semantics.
- Require a separator boundary after the normalized text directory. Deny the directory itself.
- Relative paths, tilde paths, URI paths, and Windows drive or UNC paths are outside the grammar and must deny.
- POSIX names can contain spaces, Unicode, backslashes, and shell punctuation. These characters are literal, without expansion or decoding.
- The hook does not parse `content` or other engine metadata. The Write tool retains its own schema checks.

Use the platform path library, where the mod runtime supports it. Do not add a dependency or a shell subprocess.
Tests must exercise the actual mod runtime to prove that the chosen API works there.
Keep the predicate local unless the mod runtime needs an existing shared path utility.
The runtime rejected `node:path` in the implementation test.
Use a local component normalizer because the runtime permits only relative imports and `claude-code`.

This is lexical confinement, not filesystem isolation.
The hook does not resolve symlinks or detect hard links, mounts, or concurrent path replacement.
A path inside `text/` can therefore reach an external file through a link.
Record this deliberate limit with a short `ponytail:` comment beside the predicate.
The upgrade path is an OS boundary or a writer with directory-relative, no-follow file operations.
Bash redirects, Edit, NotebookEdit, and other tools are outside this rule.
Do not claim that this hook prevents all patrol writes outside `text/`.

Change `mod/hooks/register.tsx` and `mod/tests/patrol.test.tsx`.
The implement brief prohibits a changelog entry or version change. The release step writes the changelog.
Use `mod/tests/gate.test.ts` only if an existing settings hook needs a composition regression.
Retain any settings protection from `claude-factory-qh8v2.4` if it lands first.
The tasks do not depend on that bead and must not stack on its branch.

Reject a raw string-prefix check: it accepts sibling names and traversal.
Reject relative paths: the hook must not guess the Write tool's current directory.
Reject prompt-only controls: injected text can disregard them.
Reject realpath-only checks: new files need absent ancestors, and a check cannot prevent a later symlink race.
Reject a new sandbox here: this task adds a local tool policy, not an OS boundary.

## Acceptance criteria

All paths below use an isolated test home `/fixture/home`.
Run AC1 through AC4 with `claude plugin test mod`.
Name each new test with the `oxib` prefix and the criterion number.

AC1. `oxib AC1 path grammar` must deny each path outside the closed grammar or normalized subtree.
Rows: `/fixture/home/other/a`, `/fixture/home/text-other/a`, `/fixture/home/text/../a`, `/fixture/home/text`, and `/fixture/home/text/`.
Also deny empty, absent, null, numeric, array, object, and NUL path values.
Also deny `text/a`, `../text/a`, `~/text/a`, `file:///fixture/home/text/a`, `C:\\text\\a`, and `\\\\host\\text\\a`.
Test missing, empty, relative, and NUL home values with an otherwise valid path.
Each rejection must return deny, call no downstream Write handler, write no file, and open no dialog.

AC2. `oxib AC2 allowed paths` must pass valid strict descendants unchanged, once each.
Rows: `/fixture/home/text/a`, `/fixture/home/text/sub/a`, `/fixture/home/text//a`, and `/fixture/home/text/sub/../a`.
Include a path with spaces and Unicode, plus literal shell punctuation and a literal backslash in a POSIX filename.
Cover a home with a trailing slash and a home with spaces.
Cover new files and existing files; the hook must not depend on file existence.
An in-subtree lexical path that traverses a symlink has the same hook result. Test and label this explicit limit.
The downstream test handler must be a stub; it must never follow a real external symlink.
Negative control: a normalized path outside the subtree still denies when its raw prefix names `text/`.

AC3. `oxib AC3 patrol identity` must apply AC1 and AC2 to three patrol cases.
Cases: a known current ID, a known old ID after replacement, and a newly confirmed ID whose first tool is Write.
Repeat known-ID rejection when `agent.list` fails and when `rt.isPatrolling` is false.
The hook must not adopt the old ID as current or change lifecycle state.
Controls: absent ID, confirmed unrelated agent, unconfirmed ID, and unknown ID with an agent-list error retain existing behavior.
For those controls, an outside path reaches the next handler unchanged.

AC4. `oxib AC4 hook composition` must retain a downstream deny for an otherwise allowed patrol path.
A patrol path denial must not call downstream handlers, ask for approval, or use a main-chat turn allowance.
Existing Bash and main-chat tests must still pass. Do not broaden the main-chat Write policy in this task.

AC5. Final checks must pass on the complete pull request head.
Run `bun test --timeout 30000 src factories`, `claude plugin test mod`, and `bun x tsc --noEmit -p .`.
Run `bun run typecheck` when generated mod types exist; otherwise record that local gap and the required CI results.
Run `bun run format:check`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
The required CI checks are test, plugin, typecheck, and format. No final required check can remain red.
After the fix commit, mutate each guard independently with `factory mutate` and the plugin test command.
Remove the Write hook; weaken the separator boundary; bypass invalid-path denial; remove the fresh-ID fallback; remove known-ID protection.
Each mutant must build and fail a relevant AC assertion. Record the commands, statuses, and restored clean tree.

## Test plan

Write and commit AC1 through AC4 tests before the fix.
Use the existing `agentListMock`, home fixtures, and downstream handler counters in `mod/tests/patrol.test.tsx`.
Show baseline failures for outside paths and fresh patrol IDs before source edits.
Allowed controls alone do not prove the guard.
Keep the test commit and fix commit in one draft pull request; never ship the red test commit alone.
Run AC1 through AC5 after the fix. Reserve time for the mutation checks and final gates.

## Risk

This change is security-sensitive because it parses untrusted paths and controls a tool permission.
Absolute paths preserve the current prompt contract. Relative patrol writes will now fail.
Lexical checks leave symlink and Bash escape paths open; the OS remains the real security boundary.
Unknown agent IDs follow the existing identity contract and need no broader policy in this patch.
No schema, data migration, credential change, file deletion, or production write is necessary.
Existing text files remain intact. A denied write can leave prior content, as it does today.
Security-sensitive: yes (input parsing and tool permissions)

## Rollout and rollback

Use one draft pull request, then review and security on its final head.
A person merges it. Use the normal mod release process without a new flag or migration.
The manager must load the new mod before the hook takes effect.
If that needs a manager restart, surface the owner step; no station here restarts the live manager.
Rollback uses a revert pull request and a person's merge, then the normal release process.
Rollback restores unrestricted patrol Write paths under the session's existing permissions.

## Observability

Use existing tool deny results. Add no metrics, path logs, or content logs.
The ship soak checks the loaded release revision and repeats the plugin regression suite against that artifact in isolation.
It can cite ordinary patrol tool outcomes if available. Never probe an external write in the live home.
No AC is must-see-live. All policy outcomes have an isolated test oracle.

## Tasks

1. `claude-factory-oxib.1`: test contract, one commit, 35 minutes. Add AC1 through AC4 and record baseline failures.
2. `claude-factory-oxib.2`: hook and proof, 55 minutes. Add the hook and limit comment; prove AC1 through AC5.

Task 2 depends on task 1. Reserve 30 minutes for final checks and handoff.
Both tasks fit one implementation pass. No production or factory-definition change is in scope.

## Plan evidence

The tracked-file search found no CLAUDE.md, AGENTS.md, or CONTRIBUTING file.
Plan read README.md, package.json, CI commands, existing ADRs, hook code, tests, and both relevant bead records.
The bead had no children. This run had no pull request.
The memory command returned no notes in the worker memory home.
Plan changes only this ADR. The implementation stations must supply baseline failures and mutation evidence.
`bun install --frozen-lockfile` passed without lockfile changes.
`claude plugin test mod` passed: 238 tests, zero failures.
`bun x tsc --noEmit -p .` passed. Prettier formatted this ADR.
Plan did not run the full source suite, mod typecheck, audit, secret scan, or production checks.
