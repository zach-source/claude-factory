# ADR: Separate laptop tools from harness credentials

## Status

Proposed. This plan needs an owner decision before implementation.
Bead: `claude-factory-e7mvc`. Baseline: `a1ab9d50`.
No credential, host, or runtime change belongs to this plan station.

## Evidence

`src/harness.ts:328` excludes each harness's own stores from the Seatbelt deny rules.
`src/harness.ts:355` allows other operations by default, without a keychain service deny rule.
`src/cli.ts:3991` applies this sandbox to the harness and its children.
The harness and its tools therefore share access to the harness credentials.
`src/harness.test.ts:289` explicitly asserts the own-store exception.
`src/token-guard.ts:9` excludes names built at runtime from its text guard.

The [Claude sandbox reference](https://code.claude.com/docs/en/sandboxing) limits that sandbox to shell commands.
File tools, MCP servers, hooks, and mods remain outside that boundary.
Thus, a Bash sandbox alone does not meet this bead's contract.
The AX gateway replaces credential headers (`src/ax.ts:505`), but this is not a local laptop broker.
No macOS enforcement test ran in this Linux VM.

## Decision required

Prefer a credential broker outside the worker boundary for the full solution.
The worker must receive no long-lived credential in a file, environment variable, response, or inherited descriptor.
The broker must send authenticated requests, not return credentials to the worker.
The worker must have no direct access to the credential stores or keychain services.

This requires proof of each harness's endpoint, refresh, and login behavior before a concrete broker design.
It also requires a service lifecycle and protection from the worker's user identity.
A local socket or another process under the same user does not alone supply that protection.
The current code does not establish these properties for all four harnesses.
Do not assume that API-key support proves support for a subscription login.

The owner must choose between a broker project and an immediate refusal of laptop launches.
The refusal is containment, not successful harness login, and changes the requested availability contract.
Do not silently select AX, change a rig, install a service, or change credentials.
Do not present either option as a small settings fix.

## Acceptance contract for the full solution

These ACs define the required outcome, not permission to deploy an unproved broker.
The selected design must supply the test entry points below before it can become ready.

- **AC1: Tool isolation.** All worker-controlled tool execution must lack access to every long-lived harness credential.
  Prove this with `bun test --timeout 30000 src/harness.test.ts` on macOS.
  Add the named test `laptop tools cannot read harness credentials`.
  Use fake stores for Claude, Codex, Cursor, and Grok, with default and override paths.
  Denied rows: direct reads, runtime-built names, scripts, descendant processes, recursive reads, symlinks, hard links, and ancestor renames.
  Include built-in file tools, local MCP tools, and plugin execution where the harness permits them.
  Allowed rows: normal worktree reads, writes, skills, and ordinary child processes.
  A profile string assertion alone cannot prove AC1.
- **AC2: Keychain isolation.** Tools must not retrieve harness credentials through any keychain client.
  Add `laptop tools cannot query harness keychain items` to the macOS test command in AC1.
  Denied rows: the security CLI, a runtime-built command, and direct Security.framework calls from a child process.
  Use a disposable test keychain with fake items, including a client with prior access permission.
  Allowed rows: TLS certificate validation and the positive checks in AC4.
  Test both own-harness and cross-harness access. Never print a real credential.
- **AC3: Fail closed.** An absent, invalid, or unsupported boundary must stop launch before any worker or tool starts.
  Prove this with `bun test --timeout 30000 src/cli.test.ts src/harness.test.ts`.
  Add `laptop credential boundary refuses unsafe launch`.
  Denied rows: unavailable isolation, unknown harness, stale policy, failed broker, unsupported version, and unsafe custom wrapper.
  Include resume, fallback, and new sessions. Assert zero worker, tool, and authentication calls after rejection.
  Allowed row: a supported harness with a complete boundary.
- **AC4: Work remains possible.** Each supported harness must complete an authenticated turn and an ordinary tool call.
  Add `laptop credential boundary preserves work` as a macOS integration test.
  Check git status, a local commit, skill access, bd reads, gh reads, and an authenticated git remote read.
  Use test repositories and test services before merge. Record exact harness versions and the commit SHA.
  Denied rows: credential reads during the same successful session and any request to export a broker credential.
  If a network proxy exists, all positive checks must pass through that proxy.
- **AC5: Must-see-live.** After an approved rollout, soak must see AC4 pass through each enabled laptop harness.
  Run the same macOS integration entry point in read-only smoke mode with the deployed SHA.
  Record success counts, tool-denial counts, harness versions, and boundary mode; omit secrets and request bodies.
  Soak must see its own output. A deadline cannot replace this evidence.
  An owner must authorize any credential, service-install, or live-switch step separately.

Kernel compromise and unrelated secrets are outside this bead.
Runtime-built names, keychain access, environment credentials, and alternate tools are inside its boundary.
The related session-data and cross-run control-file beads remain separate.
However, a selected design cannot trust policy files or services that a worker can alter.

## Design constraints and rejected alternatives

Expected integration files are `src/harness.ts`, `src/cli.ts`, and their existing tests.
Update `README.md` only after the selected boundary passes its tests.
Keep the text guard as defense in depth. Do not extend it as the primary fix.
Do not change `.factory/`.

Reject extra text patterns: they cannot enforce access after code constructs a name.
Reject removal of own-store exceptions alone: the harness then loses login access.
Reject file rules alone: they do not close keychain access.
Reject a Bash-only sandbox: the documented boundary excludes other tools and applies only to Claude.
Reject an environment token or copied token file: worker code can still obtain the credential.
Reject an unrestricted localhost proxy: it moves the credential without defining an authentication boundary.

No new parser is approved by this ADR.
Before broker implementation, its ADR must define a closed request grammar.
List every accepted method, field, header, endpoint, and path form for each supported harness version.
Reject every other form before DNS, connection, credential lookup, refresh, or upstream request.
Tests must count these downstream calls and assert zero on rejection.
Do not use a general CONNECT proxy or worker-selected upstream URL as the credential API.

## Test plan and first work unit

The owner decision comes first. Do not create an implementation PR with deliberately red required checks.
The first work unit after a broker choice is a bounded feasibility proof, at most 120 minutes.
Use fake credentials and local endpoints. Do not change a person's login or install a live service.
Record missing proof as a result, not as a successful boundary.

1. `claude-factory-e7mvc.1`: Specify a standalone macOS adversarial fixture with the AC1 and AC2 cases.
   First prove that the baseline exposes fake own-store data. Record that result without real token output.
   Keep an intentionally vulnerable baseline probe outside the required suite.
   The future fix tests must fail before the fix and pass after it.
   Check: `bun test --timeout 30000 src/harness.test.ts` and an explicit macOS fixture invocation.
2. `claude-factory-e7mvc.2`: Record the per-harness broker compatibility matrix and the exact next design in this ADR.
   Cover endpoint overrides, refresh, subscription login, keychain isolation, and every tool execution route.
   Check: the fixture results and `bunx prettier@3.9.9 --check docs/architecture/adr-laptop-harness-credentials.md`.

Each numbered task is one commit. The second depends on the first. Both tasks have blocked status until the owner decides.
The resumed plan must specify the fixture entry point before it marks these tasks ready.
File later broker implementation as dependent work after the proof defines its scope.
If the owner selects launch refusal, replace these tasks with refusal tests first and the launch gate second.
That plan must state explicitly that AC4 is deferred; refusal does not close the full credential-isolation goal.

## Risk

This is security-sensitive auth, secret, permission, and infrastructure work.
A partial boundary can give false assurance while tools retain a credential read path.
A keychain deny rule can also stop login or certificate checks.
A proxy can break git, bd, gh, refresh, or subscription use.
No data migration is proposed. Existing laptop launch behavior must change only after the selected tests pass.
Review and security review are required. macOS proof cannot come from Linux-only CI.
Security-sensitive: yes (auth, secrets, permissions, infrastructure access)

## Rollout and rollback

This ADR changes no runtime behavior and adds no flag.
After the owner decision, plan fixture proof, implementation, macOS verification, review, security review, and a person's merge in that order.
Separate service setup and credential changes as exact owner steps before any live rollout.
Do not add a worker-controlled flag that restores credential access.
Rollback of a future boundary must stop affected laptop workers first.
A code revert requires a pull request and a person's merge; it must not silently restore unsafe launches.

## Observability

The future boundary must report a stable refusal reason without token contents, headers, or credential paths.
Record the harness, boundary version, launch result, and probe pass/fail counts.
The soak checks AC5. Current logs cannot establish the missing tool boundary.

Question: Should this work start with a credential broker proof, or temporarily refuse laptop worker launches?
Options: Broker proof: Preserve the full login goal; plan a larger follow-up (recommended) | Launch refusal: Stop laptop workers now; defer secure login
