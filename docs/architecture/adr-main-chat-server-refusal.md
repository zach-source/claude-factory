# ADR: Refuse a factory server from the main chat

## Context

Bead: `claude-factory-05sap`. Base: `a1ab9d50`.

The CLI checks main-chat permission before dispatch in `src/cli.ts:13436`.
The server case checks worker markers at `src/cli.ts:13704`, but does not check `FACTORY_MAIN_CHAT`.
The server creates a client handler at `src/server.ts:336`.
The catalog calls gate and decision operations directly at `src/core/catalog.ts:643` and `src/core/catalog.ts:731`.
These calls do not pass through the CLI permission check.

## Decision

Refuse every `server` command when `FACTORY_MAIN_CHAT` has a nonempty value.
Use the existing marker convention: an absent or empty value does not identify the main chat.
Apply the refusal before client forwarding, server dispatch, backup, lease access, or server configuration reads.
The refusal must name `FACTORY_MAIN_CHAT` and tell the person to start the server from their own shell.
An Allow token must not permit a persistent server or be consumed by this refusal.

Add the small condition to the existing early refusal path in `src/cli.ts`.
Keep the existing worker checks and direct command Allow checks.
Do not add `server` to `MAIN_CHAT_KINDS`: an Allow token cannot bound future client calls.
Use `src/main-chat-gate.test.ts` for the regression tests.
Change `src/core/caller.ts` only if the existing caller helpers make the condition simpler.
No new dependency, flag, parser, or factory definition is necessary.

The rule covers the whole server verb, including backup and unknown arguments.
It does not parse shell text, request bodies, or configuration paths.
There is no new external-input grammar.
The only inputs are the CLI's parsed command and `FACTORY_MAIN_CHAT`.
All argument and path forms under `server` receive the same refusal before their interpretation.

## Host audit and scope

At the base commit, `src/server.ts` is the only production caller of `clientHandler` and `clientListener`.
The CLI reaches it through `server.main` at `src/cli.ts:13740`.
Direct `decide` and `decisions answer` calls already pass through the early main-chat check.
The Herdr mod is a client, not another catalog host.
Repeat this audit at implementation HEAD with:

```sh
rg -n 'clientHandler|clientListener|gatesOps.decide|decisionsOps.answer|server.main' src mod
```

Protect any new CLI host of these same gate operations under the same rule.
Do not generalize the guard to all network services.
The broker has a distinct token-swap endpoint, not a catalog gate or decision handler.
Broker endpoint policy, arbitrary module imports, marker removal, and existing server access remain outside this change.
This marker check is not an OS sandbox or an authentication replacement.

## Acceptance criteria

### AC1: Refuse the entire server command class

With any nonempty `FACTORY_MAIN_CHAT`, every server invocation exits nonzero with the explicit main-chat refusal.
Test marker values `1`, `0`, and `false`; the last two are nonempty strings, not Boolean values.
Test bare `server`, `server backup`, valid port flags, client TLS flags, and unknown arguments.
Use nonexistent TLS paths to prove the refusal precedes certificate reads.
Test `FACTORY_ALLOW` with a valid token; the refusal must leave the token intact.
Test `FACTORY_SERVER` with a local request recorder; it must receive zero requests.
Proof: `bun test --timeout 30000 src/main-chat-gate.test.ts`.
Name the new tests with `05sap AC1`.

### AC2: Refuse before server effects

A spawned CLI with the marker must exit normally with a refusal, not through a test timeout or signal.
It must bind neither the health port nor the client port.
It must make zero server-start and backup calls and create no server lease.
Use a subprocess preload spy or equivalent test seam to count the downstream calls.
Keep one real spawned-CLI case with a reserved local port and explicit refusal assertions.
A port check only after process exit is insufficient proof: a process can bind and then close a port.
The test must distinguish the refusal from an occupied-port error or a missing TLS file error.
Use a bounded asynchronous child and always stop and await it in test cleanup.
Proof: the same command, with test names `05sap AC2`.

### AC3: Preserve permitted callers and existing gates

With the marker absent or empty, an isolated shell server must start and answer `/healthz`.
Stop and await each server after the check.
Existing worker and patrol marker cases must still refuse server startup.
Strip inherited worker markers, including `BEADS_ACTOR`, from permitted test children.
Strip server, outbox, backup, and main-chat configuration from test children unless the row needs it.
Use a fresh `FACTORY_HOME`, an empty rig map, and `FACTORY_SELF_UPDATE=0` for every child.
Existing main-chat `status`, denied direct decisions, and one-time Allow tests must pass unchanged.
Proof: `bun test --timeout 30000 src/main-chat-gate.test.ts src/core/caller.test.ts src/core/caller.main-chat.test.ts src/core/caller.turn-allow.test.ts src/server.test.ts`.
Name new compatibility tests `05sap AC3`.

### AC4: Verify the complete patch

Record the host audit results, the pre-fix regression failure, and the post-fix pass in the implementation report.
After the fix commit, mutate only the new refusal condition to permit startup.
Use `factory mutate <file:line> <old> <new> -- bun test --timeout 30000 src/main-chat-gate.test.ts`.
The mutant must compile, and the regression must kill it.
Run `bun run test`, `bunx tsc --noEmit -p .`, and `bunx prettier@3.9.9 --check .`.
Run `gitleaks detect --log-opts=origin/main..HEAD` and `bun audit`.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final PR head.
Do not ship the tests-only commit with red checks.

## Test plan

Write AC1 and AC2 tests first, then AC3 controls.
Run them against the pre-fix source and record the expected failure.
Keep these tests and the fix in one PR.
Prefer the existing test setup to a new helper module.
Do not run test servers against the factory's real home or rig map.

## Rejected alternatives

- Add a server Allow kind: one token would grant an unbounded series of future decisions.
- Check only HTTP handlers: this leaves other server startup effects available to the main chat.
- Reject all manager commands: this breaks permitted commands beyond the defect.
- Change the shell text hook: the CLI must enforce the rule after shell interpretation.
- Refactor catalog authorization: this change only needs a startup refusal for the model caller.

## Risk

This is security-sensitive permission code.
The intended compatibility change prevents main-chat server startup and backup, even with an Allow token.
The person can still start the server from their shell without the marker.
There is no data format, protocol, dependency, or database migration.
The change does not stop a server that already exists.
Inherited test environment values can cause false passes; AC3 requires clean child environments.
Security-sensitive: yes (permission gate)

## Rollout and rollback

Use the normal draft PR, verify, review, and security stations.
A person must merge the PR before release.
No live command, credential change, flag, or migration is part of this plan.
Ship must distribute the CLI through the normal release path.
If rollback is necessary, revert the fix through a new PR for a person to merge.
A rollback restores the bypass; do not use it as a substitute for a fix forward.

## Observability

The CLI exit code and explicit refusal on stderr prove the denied caller path.
The isolated server's `/healthz` response proves the permitted shell path.
Ship soak can repeat AC1 and AC3 with the released CLI and a disposable home.
Use no production home, production gate, or real decision for this check.
No new metric or log stream is necessary.
No AC is must-see-live; local process evidence and exact-head CI prove this startup guard.
Any production read remains a ship-soak step subject to owner access rules.

## Tasks

1. `claude-factory-05sap.1`: Add regression and compatibility tests for AC1 through AC3. Commit after the pre-fix failure record.
2. `claude-factory-05sap.2`: Add the early refusal and complete the host audit. Commit after focused checks; then complete AC4 validation.

Task 2 depends on task 1. Both tasks belong in one PR and one implementation pass of at most 120 minutes.
Plan changes only this ADR. Implement must keep source changes within the stated permission boundary.
