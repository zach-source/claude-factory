# ADR: Refuse Monitor in the manager mod

## Context

Bead: `claude-factory-nsrax`. Base: `51f342a313235d72c1795568ecbfbbcd231f594a`.

The default manager tool list excludes Monitor at `src/cli.ts:4040`.
The launch appends caller arguments at `src/cli.ts:4061`.
The plugin can also load outside that launch.
The Bash hook at `mod/hooks/register.tsx:1404` does not cover Monitor.
That hook pins the factory home and caller markers at `mod/hooks/register.tsx:1483`.

The installed Claude Code 2.1.319 SDK defines `MonitorInput` at `sdk-tools.d.ts:2968`.
It accepts `description`, `timeout_ms`, optional `command`, and optional `ws` with `url` and `protocols`.
The command is a shell script. Monitor starts a background task.

Plan ran two isolated plugin tests with mocked executors against a scratch copy of the current mod.
Both tests passed with local Claude Code 2.1.319 and with the CI package, 2.1.291.
The first test sent `/repo/bin/factory decide r1 ship` through Monitor.
The executor received the original command once, with no dialog or caller prefix.
The second test proved that a Monitor hook can deny a subagent call before the executor runs.
No real shell command, model request, or live factory operation ran through Monitor.
Actual Monitor exposure in a live manager session remains unverified.
This is a defense for sessions that expose Monitor, not proof of an exploit in the default launch.

Probe commands:

```sh
claude plugin test .scratch/monitor-probe
npm exec --yes --package=@anthropic-ai/claude-code@2.1.291 -- claude plugin test .scratch/monitor-probe
```

The scratch probes are evidence, not required artifacts. Implement must add permanent tests below.

## Decision

Add one unconditional `on('tool.call', { tool: 'Monitor' }, ...)` refusal in `mod/hooks/register.tsx`.
Apply it to every caller, including the main chat and all subagents.
Return a fixed denial that names Monitor and directs shell commands to Bash.
Do not call `next`, ask a question, create an Allow token, or start a process.
Place the hook beside the existing Bash hook. Keep the Bash hook unchanged.

The fail-closed rule is tool-level: no Monitor invocation can pass through the factory mod.
The allowed Monitor input grammar is empty. The guard reads only the engine's tool identity.
It reads no command, path, URL, timeout, description, or caller identity.
All field combinations receive the same refusal before shell execution or socket access.
This includes WebSocket-only calls, empty commands, absent commands, unknown fields, and future Monitor modes.
Engine schema rejection before the hook is also safe, but valid input rows must prove the mod's own refusal.

This deliberate compatibility limit removes all Monitor use from sessions with the factory mod.
No default manager workflow needs Monitor. Bash remains the supported command tool with its existing gates.
No new dependency, parser, flag, CLI guard, or factory definition is necessary.

Scope excludes other tools, shell grammar defects in Bash, marker removal, and direct module or server access.
Existing related beads cover those paths. This hook does not replace the sandbox.

## Acceptance criteria

### AC1: Refuse every Monitor call before execution

Add tests named `nsrax AC1` to `mod/tests/gate.test.ts`.
Use `$.tool.call` and a mocked downstream Monitor executor.
Every valid Monitor row must return the fixed mod denial and make zero executor calls.
Assert zero AskUserQuestion calls, zero Allow-token writes, and zero command-process or socket calls from the request.
Separate plugin startup effects from the request counters.

Denied rows:

- `/repo/bin/factory decide r1 ship`.
- `FACTORY_AX_IMAGE=x factory start acme w-1`.
- `/repo/bin/factory status` and `true`, even though Bash permits these commands.
- A compound command, a quoted verb, and a command with a backslash-newline.
- A WebSocket-only call with `ws: { url: 'wss://example.invalid/events' }`.

Use `description: 'x'` and `timeout_ms: 1000` in valid rows.
Also test empty, absent, null, and non-string commands, combined `command` and `ws`, and an unknown field.
Malformed rows can receive an engine rejection or the mod denial, but must make zero downstream calls.
Do not treat an unrelated startup failure as a successful refusal.

Proof: `claude plugin test mod`, using mocked executors only.
Negative control: disable only the new refusal in a scratch mutation; valid rows must reach the mock and fail assertions.

### AC2: Cover all callers without permission exceptions

Add tests named `nsrax AC2` in the same file.
Apply AC1 to an absent `agentId`, an arbitrary subagent ID, and the factory patrol, pm, briefer, and reviewer identities.
Use the existing agent mocks where identity setup is necessary.
An old patrol ID and an unknown ID must receive the same refusal.
An existing Allow-for-this-turn grant must not permit Monitor or cause another dialog.
The request must not create, consume, or replace an Allow token.
Use the existing token fixture in `mod/tests/main-chat-marker.test.ts` if it avoids duplicate setup.
There are no allowed Monitor caller rows.
Proof: `claude plugin test mod`.

### AC3: Preserve Bash and launch behavior

The existing Bash gate, substitution, patrol, and main-chat-marker suites must pass without weaker assertions.
Required controls include denied gated Bash calls, approved gated calls, permitted status calls, and denied subagent gated calls.
Permitted Bash calls must retain the pinned home and the correct main-chat or patrol marker.
Existing one-call and turn-scoped Allow behavior must remain unchanged.
The default manager tool list must still exclude Monitor. Do not widen tools to demonstrate this defect.
Proof: `claude plugin test mod` and `bun test --timeout 30000 src/cli.test.ts src/main-chat-gate.test.ts`.

### AC4: Prove the regression and complete checks

Record the pre-fix failure of the new valid-input tests, followed by the post-fix pass.
Commit the fix before the mutation check.
Use `factory mutate <file:line> <old> <new> -- claude plugin test mod` to replace only the refusal with pass-through.
The mutant must compile, reach the mock, and fail the new assertions. Mutation exit 0 means the tests killed it.
Do not ship a red tests-only commit. Tests and source belong in one PR.

Run the repo checks:

```sh
bun run test
bunx tsc --noEmit -p .
bunx prettier@3.9.9 --check .
gitleaks detect --log-opts=origin/main..HEAD
bun audit
```

Format changed files with the repo's Prettier version before the check.
CI deliberately omits `tsc -p mod` because live engine type files are absent in clean checkouts.
The plugin suite supplies the engine validation. Do not fabricate engine type files.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final PR head.

## Design and test order

First add AC1 and AC2 tests to the existing gate test file.
Extend the existing marker test file only for the turn-token control if necessary.
Use mock counters to prove zero downstream effects. Never run the supplied factory action.
Record the expected failure before the source change, then commit the tests.
Add the single refusal hook, run AC1 through AC4, and commit the fix.
Keep the scope within one implementation pass of 120 minutes.

Rejected alternatives:

- Reuse the Bash hook: Monitor has a different result type and a background lifetime beyond the direct command call.
- Prefix Monitor commands only: this leaves dialogs, subagent restrictions, and token lifetime unresolved.
- Reject only recognized factory verbs: shell wrappers and unknown forms would remain open.
- Allow WebSocket-only Monitor calls: this adds a mode validator and network policy with no required manager use.
- Change only the default tool list: it already excludes Monitor and cannot protect other sessions with this plugin.

## Risk

This is security-sensitive permission code.
The intentional compatibility change denies Monitor, including WebSocket mode, wherever the factory mod is active.
Existing sessions with Monitor workflows must use supported tools or a separate session without the factory mod.
No data format, stored state, credential, protocol, or database migration changes.
The refusal does not stop a Monitor task that already exists.
Review and security must check the unconditional rule and the zero-execution assertions.
Security-sensitive: yes (tool permissions and shell execution)

## Rollout and rollback

Use one draft PR for the tests and fix. A person must merge it after verify, review, and security.
Release the plugin through the normal release path. No new flag or migration order applies.
A person must restart the manager to load the new hook. A disk update alone does not replace an active hook.
Do not restart the live manager from this run without the exact owner approval.
Stop any existing Monitor tasks through the normal owner workflow before the replacement session starts.
If rollback is necessary, open a revert PR for a person to merge.
Rollback restores this gap. Prefer a fix forward for compatibility defects.

## Observability

The fixed tool denial and the absence of a Monitor task prove the refusal path.
No new telemetry, command log, or raw input capture is necessary.
Ship soak can repeat the mocked plugin suite against the released plugin and supported engine version in a disposable home.
The ship report must state the plugin revision and whether the owner restarted the manager.
Do not claim active-session protection before that restart.
Do not test a real gate decision or a real network watch in production.
No AC is must-see-live: isolated engine dispatch and exact-head CI prove this unconditional hook.
Any live manager check remains an owner or ship-soak step, never a pre-merge acceptance gate.

## Tasks

1. `claude-factory-nsrax.1`: Add AC1 and AC2 regression tests. Check the pre-fix failure, then commit tests.
2. `claude-factory-nsrax.2`: Add the refusal. Complete AC1 through AC4 and commit the fix.

Task 1 blocks task 2. Both tasks belong in one PR. No external bead or PR blocks this plan.
Plan commits only this ADR. Implement changes only the hook and its tests, plus required release metadata if repository rules demand it.
