# Manager chat capability boundary

Status: proposed; person decision required for `claude-factory-xrbpw`.
Baseline: `51f342a3`. This ADR does not authorize a source change.

## Evidence and boundary

`src/core/guards.ts:14` permits manager commands outside the known gated forms.
`src/core/chat.ts:86` grants Bash, Read, Grep, Glob, and Write.
`src/core/chat.ts:91` excludes project settings but retains user settings.
`src/server-api.ts:364` does not enforce operation rights; its callers share the person identity.
The bead comments describe scripts, inline programs, socket helpers, and certificate access.
Plan did not run those programs against a live service or read a credential.

The untrusted party is the model, its tool arguments, and all text it reads.
The trusted parties are the core, the model runtime, and person-controlled runtime configuration.
The current model can execute code as the same user as the core.
A text hook cannot separate those parties after it grants arbitrary code execution.
An environment marker does not establish identity because model code can remove it.

The existing macOS worker Seatbelt ADR does not provide the required boundary.
It excludes indirect writes that a trusted process later executes and does not cover Linux chat.
A complete sandbox needs filesystem, process, socket, network, and credential isolation on each supported host.
An API rights check alone cannot distinguish a model with the person's certificate.

## Decision required

Choose between a temporary text-only chat and a larger isolated chat design.
The recommended first part removes every model tool from core manager chat.
It closes the reported model execution paths with existing launch controls.
It also removes ordinary chat reads and all chat actions, including ungated actions.
That product change conflicts with triage's requirement to preserve ordinary reads.
The person must accept that change before implementation starts.

The alternative retains tools but needs a separate isolation design and host support decisions.
Do not describe an interpreter denylist as that alternative.
Do not start sandbox implementation from this conditional plan.

## Proposed design if text-only chat is accepted

Set `tools: ''` and `strictMcp: true` in `src/core/chat.ts` for every turn.
Retain project/local source exclusion and the existing direct guard behavior.
The shared launch already emits `--tools` with an empty value and disables slash commands.
Verify that strict MCP configuration supplies no server, including servers from user configuration.
Change `src/once.ts` only if the real-runtime test finds that the current controls are insufficient.
No automatic fallback can restore a tool after a launch failure.

Update `src/steps/chat.md` to explain that chat can discuss supplied text but cannot inspect or change factory state.
The person can use the existing console or their own CLI for reads and actions.
Do not execute suggested commands from model output.
Do not add a command parser, a read proxy, an approval token, or a new configuration flag.
The accepted model-tool grammar is empty: no tool name, argument field, or path form is accepted.
Shell quoting, interpreters, executable paths, and API request grammar are outside the parser because no tool dispatch occurs.
Unknown or injected tool requests must reach zero downstream tools, files, sockets, or factory operations.

Change tests in `src/core/chat.test.ts`, `src/once-cli.test.ts`, and `src/chat-settings.integration.test.ts`.
Preserve the existing settings test fixture; extend it with a separately named capability test.
Do not weaken the direct guard tests or change `mod/hooks/view.ts` or `src/server-api.ts` for this first part.
Do not change `.factory/`, workers, patrols, credentials, or live configuration.

PR [798](https://github.com/zach-source/claude-factory/pull/798) remains open and draft at `ec303639`.
Its approval path is absent from this baseline. This plan does not depend on its merge.
Recheck it before implementation. Preserve any core-owned approval path that merges first.
The model must receive no authority to approve its own request or replay a prior approval.

## Conditional acceptance criteria

These criteria apply only after the person accepts text-only chat.

AC1. Test `xrbpw chat grants no tools` covers fresh and resumed turns through every front value.
Assert empty tools, strict MCP, source exclusion, and the existing queue, session, error, and usage behavior.
Negative rows include prior sessions with Bash calls and person text that requests tool restoration.
Neither row can change the launch capability set.
Proof: `bun test --timeout 30000 src/core/chat.test.ts -t xrbpw`.

AC2. Test `xrbpw launch has no fallback capability` captures the actual child argv.
Cover fresh persistence, resume, `runModel`, and `runModelAsync`.
Assert exactly one empty `--tools` value, strict MCP, disabled slash commands, and no broad `--allowedTools` value.
An unsupported-option error must produce one failed spawn and zero fallback spawns.
Control: non-chat calls retain their existing tool sets; Codex receives no new Claude flags.
Proof: `bun test --timeout 30000 src/once-cli.test.ts -t xrbpw`.

AC3. Test `xrbpw real Claude rejects model capabilities` uses the existing local model transport pattern.
Use isolated homes, configuration, session stores, fake executables, and a local API request recorder.
Use dummy credentials only. Strip inherited worker/outbox variables and set `FACTORY_SELF_UPDATE=0` in test children.
The transport must actually emit each attack tool request; a model refusal is insufficient evidence.
Record transport requests, tool errors, downstream counts, runtime version, and child exit status.

Negative rows cover direct gated commands, interpreter files, source/dot, inline programs, and socket helpers.
Include `bash file`, `sh file`, `source file`, `. file`, `bun -e`, `node -e`, and `python3 -c`.
Include `sh -c`, `curl`, `nc`, and `socat` with fake targets.
Also request Read of a dummy person key, Write of settings, and an unknown or MCP tool.
The fake script must attempt a gated fake factory call and a fake client API request.
Every restricted row must produce zero downstream calls and no attack file change.
Cover first turn and resume from a session that previously had tools.
Seed a local MCP server that records startup; strict configuration must leave its counter at zero.

Positive controls: a text response succeeds; an unrestricted baseline executes the harmless fake script and increments its counter.
The restricted model transport must advertise no callable tools.
Timeout, authentication failure, no transport request, and absent Claude are evidence gaps, never successful containment.
Proof: `XRBPW_REAL_CLAUDE=1 bun test --timeout 120000 src/chat-settings.integration.test.ts -t xrbpw`.
Implement must use this exact opt-in name or update this ADR before task closure.

AC4. Preserve direct guard behavior and person-owned access.
Existing tests must still permit `factory status`, refuse unapproved `decide`, and deny malformed hook input.
Those are guard tests; the restricted chat itself cannot call even `status`.
Existing isolated client API tests must still permit the person identity.
If PR 798 merges first, its approval, replay, and stale-ID tests must remain green.
Proof: `bun test --timeout 30000 src/core/chat.test.ts src/once-cli.test.ts src/server-api.test.ts`.

AC5. Complete the final checks on one PR with tests and fix together.
Run `bun run test`, `bun run typecheck`, `bunx prettier@3.9.9 --check .`, `bun audit`, and Gitleaks.
Use `gitleaks detect --log-opts=origin/main..HEAD`.
Required CI checks `test`, `plugin`, `typecheck`, and `format` must pass on the final head.
Report generated mod-type gaps separately; do not claim that root CI proves the mod typecheck.
After the fix commit, mutate the empty tool set and strict MCP selection separately with `factory mutate`.
Each buildable mutant must fail its focused regression. Do not ship a red tests-only PR.

## Test plan and tasks

Task `claude-factory-xrbpw.1` adds AC1 and AC2 regressions and the AC3 real-runtime baseline first.
Record specific pre-fix failures, then commit the tests. Budget: 50 minutes.
Task `claude-factory-xrbpw.2` applies the capability restriction and prompt change, then proves AC1 through AC5. Budget: 40 minutes.
Reserve 30 minutes for final checks. Task 2 depends on task 1; both belong in one PR.
Both tasks remain blocked until the person accepts this compatibility change.
If the person chooses isolation, replace these tasks with a new plan before implementation.
A future read proxy or OS sandbox requires a separate spec; this run does not silently add either.

## Risk

This is security-sensitive permission work.
Text-only chat loses automatic reads and actions; the console and person CLI remain available.
The runtime and person-controlled user/managed configuration remain trusted.
This plan does not contain a compromised runtime, existing malicious user configuration, or other local same-user processes.
There is no data migration, deletion, schema change, or credential change.
Do not grant tools again without a separate boundary design.
Security-sensitive: yes (model permissions and person API identity)

## Rollout and rollback

Obtain the person's product decision first. Then use a draft PR, review, security, and a person's merge.
There is no feature flag or migration order.
After release, each new model child must use the restricted launch, including resumed conversations.
If a manager restart is necessary, surface that owner step; do not perform it here.
Rollback uses a revert PR and a person's merge. It restores the known bypass and needs explicit risk disclosure.

## Observability

Use existing chat success/error records, plus the isolated runtime test's counters and version evidence.
Do not log command contents, credentials, or API payloads in production.
Ship soak repeats AC3 against the released artifact in an isolated home.
No AC is must-see-live. No production read or gated production action is a pre-merge criterion.

## Plan evidence

No root CLAUDE.md, AGENTS.md, or CONTRIBUTING file was present.
Plan read README.md, package.json, adjacent code, tests, CI configuration, and earlier ADRs.
The memory search returned no notes. No prior task or PR existed for this run branch.
The first focused test attempt failed because xstate was absent.
After `bun install --frozen-lockfile`, the focused baseline passed: 29 tests, 186 assertions, zero failures.
Plan did not run an exploit, a real-Claude capability probe, a full build, or the full suite.
No implementation or production change is complete.

Question: Can core manager chat become text-only until an isolated tool boundary exists?
Options: Text-only: Remove all chat tools now; use the console for reads and actions (recommended) | Keep tools: Plan full isolation first
