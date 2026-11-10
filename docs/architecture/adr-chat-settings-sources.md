# Keep project settings out of manager chat

Status: accepted plan for `claude-factory-wua3v`.

## Context

At `4323f250`, `src/core/chat.ts:82` starts Claude in `ctx.home` with the Write tool.
It supplies a Bash hook through `--settings` and resumes stored sessions.
`src/once.ts:254` does not restrict settings sources.
A project file can therefore supply configuration outside the core's hook object.
The reported `disableAllHooks` bypass has no real-Claude reproduction yet.

The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents `--setting-sources` with `user`, `project`, and `local` sources.
The local Claude 2.1.319 help confirms that interface. CI pins Claude 2.1.291 for its plugin check.
Neither fact proves hook precedence. AC3 must test that behavior.

## Decision

Every manager chat launch must exclude both project and local settings sources.
Pass `--setting-sources user` as two argv entries, alongside the core's explicit `--settings` JSON.
Use a narrow optional field on `ModelCall`, such as `settingSources?: 'user'`.
Set it in `send` for every turn. Emit it in the shared Claude branch of `modelSpawn`.
Do not expose a user flag or accept source text from a conversation, file, or environment variable.
Preserve the default for other callers and preserve the Codex argv.

This is a source exclusion rule, not a path denylist.
All project and local settings are untrusted, regardless of keys, file contents, or time of creation.
The core must never retry without the restriction after a launch error.
Claude remains the settings parser. This change adds no parser, path grammar, or downstream render step.
User and managed settings remain trusted inputs outside this rule.
Writes to user configuration, shell interpreter escapes, and edits to factory application settings remain outside this task.
This change does not make chat a filesystem sandbox.

Change `src/core/chat.ts`, `src/once.ts`, `src/core/chat.test.ts`, and `src/once-cli.test.ts`.
Use existing test fixtures. Add a focused CLI integration fixture only if existing fixtures cannot exercise real Claude.
Do not change `.factory/`, worker guards, credentials, or live configuration.

Reject a Write-only hook: Bash can also create these files, and existing files still load.
Reject a filename denylist: it needs path normalization and does not control configuration already on disk.
Reject a global source restriction: it changes unrelated model callers.
Reject `--bare` or safe mode: these modes can disable the hooks that this task must preserve.

## Acceptance criteria

AC1. Test `wua3v chat excludes project sources on every turn` must cover a fresh turn and a resumed turn.
Both calls must select only `user` and retain the explicit Bash guard, tools, cwd, and environment.
The first call must have no resume ID. The second must use the stored valid session ID.
Run `bun test --timeout 30000 src/core/chat.test.ts -t wua3v`.

AC2. Test `wua3v model argv preserves source restriction` must capture the actual spawned argv.
Cover `runModel` and `runModelAsync`, fresh persistence, and resume.
Assert exactly one `--setting-sources` entry with value `user`, plus the intact explicit hook JSON.
Negative controls: an unset option adds no source flag; a Codex call adds no Claude source flag.
An unsupported-option child failure must return failure with one spawn and zero fallback spawns.
Run `bun test --timeout 30000 src/once-cli.test.ts -t wua3v`.

AC3. Test `wua3v real Claude retains chat guard` must exercise real Claude, not an argv stub.
Use an isolated factory home, configuration directory, and session store under the test scratch directory.
Do not read credentials or alter the real home. Use a local model transport fixture where feasible.
Record the exact command, Claude version, fixture revision, exit status, and hook counts in the task evidence.
The implementation must document its repeatable probe command in this ADR before task closure.
The fixture must drive a Bash tool request and observe the real `chat-guard` result.
Use a hook wrapper that records invocation, then delegates to the repository's `chat-guard`.
Use a fake `factory` executable that records downstream calls. Never execute a real gated command.

Test each file separately, then both together:

- `<home>/.claude/settings.json` with `disableAllHooks: true`.
- `<home>/.claude/settings.local.json` with `disableAllHooks: true`.
- A benign project hook that writes a test marker, to prove source exclusion independently of disable precedence.

Cover files present before the first turn and files created between the first turn and resume.
The explicit guard must run for each requested Bash call on the fixed launch.
Project hook markers must remain absent.
`factory decide lifecycle-acme ship ok` must return the guard's approval refusal with zero downstream factory calls.
`factory status` must remain allowed and reach only the fake executable.
An absent-file control must retain both outcomes.
Require a tool-call event and a hook invocation; model refusal, auth failure, timeout, or no tool call is not proof.

Run the same fixture without the source restriction first. Record the actual baseline, even if Claude already blocks the bypass.
The benign hook marker must distinguish default sources from the restricted launch.
Do not invent a successful exploit if upstream protection prevents it.
If no real-Claude probe can run, report the evidence gap and block completion; an argv test cannot satisfy AC3.
Do not change credentials to make the probe work.

AC4. Preserve the existing guard and chat behavior.
Run `bun test --timeout 30000 src/core/chat.test.ts src/once-cli.test.ts`.
Keep the existing allow, ask, deny, malformed-input, queue, session, error, and usage assertions.
Malformed hook input must deny; no input from this task can authorize an owner command.
After the fix commit, mutate the chat source selection and argv emission separately.
Each buildable mutant must fail its focused assertion. Restore the committed code after each mutation.

AC5. The final pull request head must pass `test`, `plugin`, `typecheck`, and `format` CI checks.
Run the local CI equivalents from `.github/workflows/ci.yml`:

- `bun test --timeout 30000 src factories` with `PKGGATE_E2E_REQUIRE=1` and `PG_SCRATCH_REQUIRE=1`.
- `bunx tsc --noEmit -p .`.
- `claude plugin test mod`.
- `bunx prettier@3.9.9 --check .`.
- `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.

Report local tool gaps separately. No required check can remain red on the final head.

## Test plan

Write and commit AC1 and AC2 regressions before the fix. Show their specific failed assertions on the baseline.
Establish the AC3 baseline in the same first task. Keep tests and fix in one pull request.
Then add the source restriction, run AC1 through AC5, and record mutation results.
Use only test-local homes. Strip inherited worker outbox variables from test CLI children.
Set `FACTORY_SELF_UPDATE=0` for those children.

## Risk

This change is security-sensitive because it controls hook enforcement and permissions.
Project and local customizations no longer affect manager chat. This is intentional.
User and managed configuration remain effective; this task does not defend against their compromise.
Resume must keep the restriction even when an older session used default sources.
There are no data migrations, schema changes, credential changes, or file deletions.
Security-sensitive: yes (permissions and hook enforcement)

## Rollout and rollback

Use one draft pull request. Review and security must inspect the final head before a person merges it.
Use the normal release process after merge. No new runtime flag or migration is necessary.
The next chat child uses the new argv after the host process loads the release.
If the manager needs a restart, surface that owner step; do not restart it here.
Rollback uses a revert pull request and the normal release process, with a person's merge.
A rollback restores the project-settings exposure. State that risk in the revert description.

## Observability

Use existing chat error records and hook results. Add no metrics or command-content logs.
The ship soak checks the released revision and repeats AC3 against that artifact in an isolated home.
Record the released Claude version and probe result. Never seed malicious settings in the live factory home.
No AC is must-see-live: the oracle is an isolated real-Claude probe, not a production mutation.

## Tasks

1. `claude-factory-wua3v.1`: tests and real-Claude baseline. One commit, 50 minutes. Checks: AC1 and AC2 expected failures, plus AC3 baseline evidence.
2. `claude-factory-wua3v.2`: source restriction and proof. One commit, 40 minutes. Checks: AC1 through AC5 and separate mutations.

Task 2 depends on task 1. Reserve 30 minutes for final checks and handoff.
If the probe exposes a wider defect, report it before broadening this plan.
Related draft PR 811 changes chat Write guards; it is not a prerequisite for source exclusion.
Recheck that PR before edits and retain its independent protections if it merges first.
Do not stack this pull request on that branch.

## Plan evidence

The root file search found no CLAUDE.md, AGENTS.md, or CONTRIBUTING.md. Plan read README.md and package.json.
The bead had no children or prior comments. The memory search returned no local notes.
PR 811 was open and draft at `cf83ecf73def2945a040179e90bb46a6c3555d36`.
One later glob search was denied by the worker hook. Plan did not retry that command.
The first focused test attempt failed before execution because xstate was absent.
After `bun install --frozen-lockfile`, the focused suite passed: 27 tests, 145 assertions, zero failures.
`bun x tsc --noEmit -p .` passed. The standalone `bunx` command was absent.
Plan used the installed Prettier entry point for the ADR.
Plan did not run the full test suite, plugin check, audit, or secret scan.
Plan did not run a real-Claude settings probe or claim a reproduced bypass.

## Implementation baseline

Claude 2.1.319 reproduced the bypass with the local transport in `src/chat-settings.integration.test.ts`.
The fixture uses isolated homes and session stores under `.scratch/` and a fake downstream `factory`.
It supplies a dummy API key to a local HTTP server. It reads no credentials.
Use this command from the repository root:

```sh
WUA3V_REAL_CLAUDE=1 bun test src/chat-settings.integration.test.ts
```

Before the fix, this command exited 1 at the restricted guard-count assertion: expected 4, received 0.
The unrestricted baseline completed all eight cases first.
Without files, both turns ran four guard hooks and only two downstream `status` calls.
With either file, or both files, present before launch, both turns ran zero guard hooks.
Each turn reached the fake downstream `decide` command.
With files created before resume, the first turn ran two hooks; the resumed turn ran zero.
The benign project hook marker appeared without the restriction in all file cases.
AC1 and AC2 also failed at their source-selection assertions before the fix.

After the fix, the same command exited 0: one test, 253 assertions, and 16 matrix cases.
Each case used a fresh turn, a resumed turn, and a resumed benign-hook control: 48 Claude calls total.
Each restricted case retained four guard calls across the first two turns and six after the benign control.
Every requested Bash call matched a recorded guard result by tool ID.
Each `status` result had code 0. Each `decide` result had code 2 and the approval refusal.
Only `status` reached the fake executable. No project hook marker appeared in a restricted case.
The fixture revision starts at `e4389cd2`; the source-restriction commit adds the final per-call result checks.
The test writes its version, case outcomes, and hook counts to `.scratch/chat-settings-<timestamp>/evidence.json`.
