# ADR: Set the actor for patrol bead comments

## Status

Proposed. A person must select the actor scope before implement starts.
Bead: `claude-factory-xizec`. Run: `lifecycle-mwa17akohk`.
The bead explicitly reserves the design for a person. No comment supplies that decision.
This ADR records the proposal and the decision gate. It does not authorize implementation.

## Evidence

Plan read commit `3dda942254b760fcf0d636ba6bc013aca6e2feb3`, which also matches `origin/main`.
No earlier plan commit, child task, or pull request exists for this run.

- `mod/hooks/register.tsx:1467` exports `FACTORY_PATROL=1` for every call with `e.agentId`.
- That prefix does not export `BEADS_ACTOR`.
- `mod/hooks/view.ts:1181` implements `bdWrite`. It rejects explicit actor overrides but does not reject environment resets.
- `src/client.ts:26` treats an actor with the prefix `factory/` as a worker caller.
- `mod/tests/patrol.test.tsx` has hook tests with agent identity mocks and downstream command capture.

The existing prefix covers all subagents, not only the patrol.
Thus, the suggested one-line change also gives unrelated subagents the patrol actor.
The manager fallback through `prompt.submit` has no subagent identity. A subagent-only prefix does not cover that fallback.
The person must select this scope with those limits visible.

## Proposed design

Recommend a fixed actor for confirmed patrol subagents only: `BEADS_ACTOR=factory:patrol`.
Use the existing patrol identity check and retained patrol IDs. Do not trust a model-supplied agent name.
Keep the main manager and unrelated subagents outside this first change.
The manager fallback retains its current identity until the person selects a broader scope.
Keep the actor out of the `factory/` namespace.

Change `mod/hooks/register.tsx`, `mod/hooks/view.ts`, and `mod/tests/patrol.test.tsx` after the decision.
Use the existing hook and test helpers. Add no dependency, setting, factory definition, or credential change.

The guard rule must fail closed when a supported command can remove or replace the fixed actor.
It must reject before the downstream Bash call. Tests must assert zero downstream calls for each rejection.
Do not implement only a list of reported environment spellings.
At the resumed plan, define the closed grammar for environment wrappers and assignments before a guard task starts.
Specify command heads, option words, assignment names, values, separators, and accepted executable path forms.
Reject all other forms in that grammar before execution. Do not infer safe behavior from an unknown option.

The current text guard is best effort. It does not establish authenticated comment authorship.
`claude-factory-tm9of` covers expansions and indirect argument construction that hide explicit actor flags.
Keep that work separate unless the person selects complete author enforcement in this run.
Do not claim that a fixed environment variable prevents an explicit actor flag from a hidden expansion.
The proposed scope excludes script contents, aliases, copied executables, and actor data from bead imports or SQL.
These limits must remain explicit in the final plan and pull request.

Alternatives:

- Pin every subagent to `factory:patrol`: less code, but it gives unrelated agents a false role.
- Pin the manager too: covers the fallback, but changes the author of manager comments on behalf of the person.
- Deny only `USER`, `HOME`, and Git configuration overrides: ordinary comments still inherit the host identity.
- Add only an export: `env -i` can remove it, and a hidden actor flag can override it.
- Build a new shell parser: excessive scope before the person selects the required guarantee.

## Proposed acceptance criteria

These criteria are provisional. The resumed plan must resolve the scope and grammar before it reports ready.
Use `claude plugin test mod` for AC1 through AC4.

AC1. Test `xizec patrol actor` must execute the captured prefix with a harmless local actor probe.
The resulting environment must contain `BEADS_ACTOR=factory:patrol` for a confirmed patrol.
Test absent and conflicting inherited actors, a late patrol ID, and a patrol call before identity adoption.
Host `USER`, `HOME`, and Git configuration values must not select the resulting actor.
Do not call the shared bead database or change the host Git configuration.

AC2. Test `xizec actor scope` must pin the selected identity scope.
For the recommended scope, a manager call and an unrelated subagent must receive no new actor export.
Test the manager fallback explicitly. Preserve the current `FACTORY_PATROL` and `FACTORY_HOME` behavior.
Briefer and reviewer Bash calls must still deny.

AC3. Test `xizec actor environment` must cover the final closed grammar with unconditional verdict assertions.
Required deny examples include `env -i bd comment acme-1 ok` and `env --ignore-environment bd comment acme-1 ok`.
Also deny `env -u BEADS_ACTOR bd comment acme-1 ok` and direct `BEADS_ACTOR` overrides.
Retain the existing denials for `--actor`, `--author`, their accepted abbreviations, and `comments add -a`.
Test unsupported wrapper options, malformed assignments, and incomplete input. Each rejection must make zero downstream Bash calls.
The resumed plan must decide whether harmless `USER`, `HOME`, and `GIT_CONFIG_*` overrides deny or retain the fixed actor.
Do not treat those overrides as author changes when the fixed actor remains present.

AC4. Test `xizec actor controls` must allow ordinary `bd comment acme-1 ok`, `bd show acme-1`, and `bd list --json`.
Preserve the current allowed read verbs and ordinary non-bd commands.
Commit the tests before the fix. Record their specific failures before the fix and their pass after it.
Mutate the actor export and each new guard branch separately. Each mutant must build and fail its own assertion.

AC5. The final head must pass test, plugin, typecheck, and format CI checks.
Run `bun test --timeout 30000 src factories`, `claude plugin test mod`, and `bunx tsc --noEmit -p .`.
Run `bunx prettier@3.9.9 --check .`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
Record any local gap. Never ship a final head with deliberate test failures.

## Risk

This is security-sensitive because comment identity affects the interpretation of owner approval.
A fixed environment actor is not an authenticated identity. The sibling expansion defect remains relevant.
The wrong scope can label a manager or an unrelated agent as the patrol.
Broad text denials can reject harmless comments and environment setup.
No data migration or schema change is necessary. Existing comment authors remain unchanged.
Security-sensitive: yes (comment identity and shell input guards)

## Rollout and rollback

Use the normal draft pull request, review, security review, and person merge process after the decision.
No flag or migration is necessary. The person must restart a live manager if the release needs that step.
Rollback uses a revert pull request and a person merge. It restores the current identity defect.
Do not change a live manager, credentials, or repository settings in this run.

## Observability

The ship soak can inspect an ordinary patrol comment and compare its author with the selected actor.
Use an existing comment; do not add a production comment solely for this check.
Confirm that ordinary patrol bead reads and comments complete without new guard errors.
No production read is a pre-merge requirement. No AC is must-see-live.
No metric or new log is necessary for this proposal.

## Tasks after the decision

No implementation child exists yet. The decision controls both the identity scope and the guard contract.
The resumed plan must create these tasks with final AC references and dependency order:

1. Add actor, scope, and guard regression tests. Commit the tests and record the expected failures.
2. Add the selected actor prefix and environment guard. Run AC1 through AC5 and the separate mutations.

Both tasks must share one pull request. Budget one implement pass of 120 minutes.
If the person selects complete author enforcement, reassess `claude-factory-tm9of` before tasks become ready.
No change in this proposal makes a production defect more frequent, wider, or longer.

## Decision

Question: Which callers must get a fixed bead actor: patrol only, all subagents, or the manager too?
Options: Patrol only: preserve manager identity (recommended) | All subagents: select an actor for each role | Manager too: also cover fallback calls
