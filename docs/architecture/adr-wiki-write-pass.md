# ADR: Write wiki solution pages from closed beads

## Context

This plan covers T007, bead `claude-factory-tx6c.7`. The write helpers and person guard already exist.
The initial plan added the write pass. Four implement rounds then fixed partial input and process checks.
The current branch includes that work. The revision below defines the remaining work and overrides conflicting details below.
No repository CLAUDE.md, AGENTS.md or CONTRIBUTING file exists in this checkout.
The station brief supplies the repo rules.

## Current handoff at 0a91a6f2

This section overrides earlier task lists and AC10 implementation choices. AC1–AC9 and the source grammar remain unchanged.
Keep PR #714 as a draft. Keep `.16` and `.17` closed. No new production defect is established.
The latest review examined `4864c110`; commit `489966b7` then added `known`, a macOS fallback, and two controls.
Plan ran the two new controls: two passed, zero failed. Those results do not prove the full lifecycle contract.

### Remaining findings

1. Ownership still depends on a successful process scan before the first observation.
   `scanTagged()` ignores environment-read errors at `src/wiki-kick.test.ts:73`.
   `settled()` and `stopOwned()` accept an empty scan as completion at lines 106 and 93.
   The `known` set fixes loss after observation; retain that behavior or its equivalent.
2. The macOS branch at line 60 has no executed platform control.
   It ignores the injected `readEnv` and `list` functions used by the new environment-failure test.
   That test therefore cannot test its intended failure on macOS.
   A fallback present in source is not evidence that the supported host works.
3. The assertion control at line 544 catches the assertion and calls `stopOwned()` directly.
   It does not exercise the registered cleanup hook or prove fixture retention when exit proof fails.

These are three bounded parts of the recurring AC10 finding. Do not repeat completed source or recovery work.

### AC10 completion checks

The fail-closed rule is: only independent exit proof for every owned launch permits fixture removal.
Unknown ownership, a failed observation, an empty scan, an absent lock, or a signal request cannot prove exit.
Process inspection must never select an unrelated process for a signal.
Use fixture launch receipts, direct handles, or a small fixture supervisor to register ownership before the launch returns.
Keep this mechanism in `src/wiki-kick.test.ts`; use an existing process API and no production option.
Prefer this explicit lifecycle to a host-wide environment parser. Remove obsolete scan code if receipts replace it.
Do not add a shell parser. Arbitrary host processes, external process control, and production supervision are out of scope.

| AC10 control | Required evidence and negative rows |
| --- | --- |
| AC10.1: ownership before observation | Delay a real fixture child before its first lock. Deny its first and later environment reads. A live child cannot produce successful cleanup. Stop and await it before removal. Keep the existing after-observation refusal control. |
| AC10.2: supported hosts | Exercise the lifecycle without `/proc`. Linux and macOS must use the same exit contract. A failed observer or transport must fail closed. Test both platform branches through injection if branches remain. Never skip the environment-failure control on macOS. |
| AC10.3: assertion and cleanup failure | Use a nested Bun test fixture with an intentional assertion failure and the actual cleanup hook. Its parent must observe nonzero exit, child exit, and fixture removal after exit. Deny exit proof in a second row: the hook must fail and retain the fixture. The outer test must stop its own children afterward. |

Name the new tests `AC10 ownership before observation`, `AC10 supported hosts`, and `AC10 assertion cleanup`.
Proof for each: `bun test --timeout 60000 src/wiki-kick.test.ts --test-name-pattern AC10`.
Retain the eight earlier controls, explicit refusal checks for all four stubs, and zero external calls/outbox writes.
Retain real write, ambient, refresh and groom CLI passes. Synthetic controls supplement those passes.
The no-launch row must permit immediate completion with zero launch receipts and zero fixture transport calls.
The normal completion row must permit cleanup after proven exit. A child that removes its lock remains owned until exit.
Retain ownership across home changes. Do not signal a reused PID without proof that it remains the owned process.
If a process observer remains, test its unknown/error result separately from confirmed absence.
`kill(pid, 0)` permission failures are unknown; only confirmed absence or an awaited exit can establish exit.

### Tasks and validation

1. Reopen `.18`: AC10.1, one commit, 40 minutes. Add the first-observation failure control before the fixture correction.
   Record its failure, then make ownership independent of successful environment reads.
2. `.19`, AC10.2: one commit, 25 minutes, after `.18`.
   Remove host-specific discovery if step one makes it unnecessary. Otherwise test each retained platform adapter explicitly.
3. `.20`, AC10.3: one commit, 25 minutes, after `.19`.
   Test the actual cleanup hook through the isolated nested fixture, including failure to prove exit.
4. Reserve 30 minutes for regression checks and the evidence table. Required CI wait time is separate.

Use `.scratch/` for generated probe files. A nested test must use isolated tools, home, transport and routing values.
Commit only the final green fixture changes for each task. Record red results before the correction in its task comment.
Do not ship required checks red. Do not add another process library or a general fixture framework.
Run each of these files with `bun test --timeout 60000`: `src/cli-wiki-write.test.ts`, `src/wiki-kick.test.ts`,
`src/wiki.test.ts`, `src/prs.test.ts`, and `src/cli-wiki-find.test.ts`. Then repeat `src/wiki-kick.test.ts`.
Run `bun run typecheck`, changed-file Prettier, `git diff --check`, `bun audit`, and the repository gate.
Run `gitleaks detect --log-opts=origin/main..HEAD`. Require final-head test, typecheck, plugin and format CI.
Each close comment must map its control to a test name, exit assertion, fixture assertion, command and result.
For each changed guard, commit first and kill one independent mutant with the relevant control.
An unsupported host result must remain an explicit evidence gap; do not describe an untested fallback as verified.

### Risk, rollout and observability

This work is **security-sensitive** because fixture children can retain inherited access after cleanup.
No production code, state migration, dependency, flag, `.factory/` file or live operation changes in this plan.
Reject fixed sleeps, lock-only cleanup, and scan emptiness as exit proof; each repeats the same failure class.
Keep the existing CLI, three-hour kick, halt policy, agent tools and 45-minute timeout contracts.
Review and security must inspect the final head. A person must merge PR #714 before release.
Rollback uses a revert PR and a person's merge. Preserve wiki pages and `wiki-state.json`.
Test observability consists of launch receipts, exit results, fixture retention, and the control evidence table.
Production observability remains committed pages, `written`, `lastWriteAt`, masked `wiki.log`, counts and the push result.
AC7 remains **must-see-live**, only in authorized ship soak: `factory wiki write --bead claude-factory-3w8o`.
The soak must inspect its own seven-section page with PR #590 and #591 and its state/log/remote result.
The soak must not use its deadline instead of that evidence. No live read is a pre-merge criterion.

## Prior handoff at 855bb6a5

This section replaces earlier task lists. AC1–AC10 and the finite source table remain the acceptance contract.
Keep draft PR #714. Do not repeat the production fixes or the completed source matrix.
Commit `c8a2e607` adds eight real-pass matrices across both forges, entry paths and source parts.
Keep `.16` and `.17` closed unless a named acceptance check fails. Reopen only `.18` for the remaining lifecycle gap.

### Remaining lifecycle gap

At `src/wiki-kick.test.ts:36`, `reap()` sends a signal to the current lock holder but does not await exit.
At line 47, cleanup deletes the fixture immediately afterward.
At line 116, a start deadline has no child identity to stop.
At line 120, an end deadline forgets the observed PID if the child already removed its lock.
Refresh and groom tests at lines 129, 145, 167, 300, 320 and 342 still use page, log or delay checks.
The delayed fixture at line 393 has no unconditional cleanup if its wait fails.
The prior `/proc` refusal fix is present. Retain it.
These are test-lifecycle gaps, not evidence of a new production defect.

### AC10 completion: ownership survives lock removal

The test must own each launched fixture process until it proves exit, independently of `wiki.lock`.
Record launch identity before a child can outlive its test. Retain each identity across home changes and lock removal.
Use process handles or a fixture supervisor with a completion handshake. Keep this mechanism inside the test fixture.
Use a process group only when the fixture owns that group. Never signal an arbitrary PID from an untrusted file.
The lock can show pass progress; it cannot be the sole child registry.
After normal completion, prove exit before result assertions and fixture removal.
After any assertion error or deadline, stop owned children and await exit before fixture removal.
Await `child.exited` for direct Bun children. For detached children, prove exit through the owned supervisor or equivalent lifecycle.
An exit signal request alone is not exit proof. A failed `/proc` read alone is not exit proof.
If cleanup cannot prove exit, fail explicitly and retain the fixture for diagnosis.

Add these named AC10 controls before the fixture correction:

| Test control | Required result |
| --- | --- |
| Child starts after three seconds | Wait observes start and exit; assertions occur after exit |
| Child starts after the start deadline | Wait rejects; cleanup stops and awaits the owned child before it can use deleted fixtures |
| Child never completes with its lock present | Wait rejects; cleanup proves exit before fixture removal |
| Child removes its lock but remains alive | End deadline rejects; cleanup stops the saved child identity and proves exit |
| Assertion fails after launch | Unconditional cleanup stops and awaits that child |
| Home changes within one test | Cleanup accounts for children from every home, not only the final home |
| Live PID with an unreadable `/proc` record | Treat the child as alive until independent exit proof exists |
| No-launch policy row | Zero launches; no phantom child wait or fixture transport call |

Apply the same exit proof to write, ambient, refresh and groom launches in `src/wiki-kick.test.ts`.
Retain the fixture forge/agent stubs, transport interception, routing exclusions and parent environment restoration.
Verify each default stub records and refuses an explicit call; do not infer that behavior from an unused stub.
Keep actual CLI pass assertions. A fixture supervisor must not replace the production pass with a simulated success.
Proof: `bun test --timeout 60000 src/wiki-kick.test.ts`.
Repeat that file once after the combined wiki suite to detect leftover children.

### Remaining task and checks

1. `.18`, one commit, 90 minutes: add the lifecycle controls, record their failure, then correct fixture ownership and cleanup.
   Change `src/wiki-kick.test.ts`; change the write fixture only if the same ownership gap is reachable there.
   Use existing process APIs. Add no dependency, production flag, parser or generic process framework.
   Include a test-to-control evidence table in the task close comment.
2. Reserve 30 minutes for regression, typecheck, format and evidence. Required CI wait time is separate.

Run `bun test --timeout 60000 src/cli-wiki-write.test.ts src/wiki-kick.test.ts src/wiki.test.ts src/prs.test.ts src/cli-wiki-find.test.ts`.
Then run repository typecheck, test/plugin checks, the repository gate, `bun audit` and gitleaks.
Required test, typecheck, plugin and format CI must pass on the final PR head.
Do not reopen source tasks merely to repeat old fixes. Report a specific failed row if the matrix finds a regression.
Do not accept a suite total as proof of lifecycle cleanup. Name each control and its exit assertion.

### Scope, risk and release

This correction is **security-sensitive**: tests must not leave children with inherited access after their fixtures disappear.
Reject another lock-only kill or fixed sleep: neither proves process ownership or exit.
No production code, migration, permission, state format, dependency or `.factory/` change is planned.
Retain the three-hour kick, halt rule, agent tools, 45-minute default and existing override contracts.
Review and security must inspect the final head. A person must merge PR #714 before release.
Rollback uses a revert PR and a person's merge. Preserve wiki pages and `wiki-state.json`.
AC7 remains **must-see-live** for authorized ship soak; it is not a pre-merge requirement.
The soak must run `factory wiki write --bead claude-factory-3w8o` and inspect its own committed seven-section page.
That page must name PR #590 and #591. Check state, masked log, counts and remote result.
The soak cannot substitute its deadline for this evidence.

## Prior handoff at 9b8bc55d

This section overrides prior task lists, not AC1–AC10 or their source grammar.
Keep draft PR #714 and all existing fixes. Do not repeat completed production work.
Task `.17` now has code/release source checks and committed-page recovery checks. Keep it closed unless a check fails.
Reopen `.18`, then `.16`. These two commits fit one 120-minute pass.

### Remaining evidence gaps

The last commit added both GitLab detail entry paths, real file-refusal passes, release pairs and default kick tools.
It did not complete the field matrix. For example, the file table omits string `false`, invalid JSON and failed commands.
The file table still uses only discovery. GitHub detail/file checks also need the full matrix and durable refusal assertions.
At `src/wiki-kick.test.ts:78`, `passEnded()` returns after its polling limit without an assertion.
An absent lock can mean either a completed child or a child that has not started.
The page marker at line 319 does not prove process exit. Several launch tests still use fixed sleeps.
At `src/cli-wiki-write.test.ts:56`, the default `gh repo` response succeeds without an explicit fixture override.
These are acceptance evidence gaps. This plan does not claim a new production defect.

### Finite AC8 test inventory

Retain the closed source grammar below. Validate consumed fields before filters, defaults or projections.
An incomplete source must stay pending; it must never become a successful empty source.
Ignore unused API fields. Branch lookup, shell parsing and new page fields remain out of scope.
Use table tests for the following value classes. Each slash-separated value is a separate row.
For each applicable field, run the table through metadata and discovery on both forges.
Use the appropriate forge field name. The GitLab overflow field has no GitHub equivalent.

| Field or boundary | Accepted rows | Rejected rows |
| --- | --- | --- |
| Detail root/read | Valid object with extra unused field | Failed command; invalid JSON; null; array; empty object |
| `number` / `iid` | Requested positive integer | Absent; null; string; zero; fraction; different integer |
| `title` | Nonempty string | Absent; null; empty string; number |
| GitHub `merged_at` | Valid date-time; null | Absent; number; empty string; impossible date |
| GitLab `state` | merged; opened; closed; locked | Absent; null; number; unknown string |
| `body` / `description` | Absent; null; string | Boolean; number; array; object |
| Files root/read | Valid nonempty files/changes list | Failed command; invalid JSON; null; wrong root type; absent changes; empty list |
| File row | Object with valid path | Null; array; empty object |
| `filename` / `new_path` | `src/a.ts`; `src/nested/a.ts` | Absent; null; number; empty; `/a`; `a//b`; `./a`; `a/../b`; backslash; control character |
| `patch` / `diff` | Absent; string | Null; boolean; number; array; object |
| GitLab `overflow` | Absent; false | True; null; 0; 1; empty string; string `false`; array; object |
| `metadata.ship_pr` | Absent; canonical rig URL | Null; boolean; number; empty string; array; object; noncanonical URL |

For metadata URLs, retain the existing host, project, credentials, port, query, fragment and number-mismatch refusal tests.
Retain strict discovery root/row, date, identity and pagination tests in `src/prs.test.ts`.
Reference those tests in the task evidence; do not duplicate every parser row in CLI tests.
The CLI detail/file matrix must exercise both entry paths. Include a nested GitLab project as a positive and negative control.
For metadata absence, assert discovery occurs. For malformed metadata, assert zero discovery, detail, file and agent calls for that bead.
For rejected discovery, assert zero detail/file/agent calls. For rejected detail, assert zero file/agent calls.
For rejected files, assert zero agent calls for the affected bead and no classification-based completion.
Use real passes for refusals. Each must retain the exact prior `lastWriteAt` and exclude the affected bead from `written`.
Assert that an unrelated valid bead can commit. Count calls by bead or PR, not across unrelated work.
Known unmerged metadata remains pending. Valid empty discovery can settle a bead; invalid source data cannot.
Positive rows must reach their expected next stage. An early unrelated refusal does not prove field acceptance.
Proof: `bun test --timeout 60000 src/prs.test.ts src/cli-wiki-write.test.ts`.

### AC9 and AC10 completion evidence

Keep AC9's fixed dates, both prompt source records, seven-section committed blobs, exact timestamps and stable third-pass HEAD.
Audit all five cases: GitHub detail/files, global GitHub, GitLab full ID, GitLab short ID and code/release pair.
Do not infer a missing PR source object from a URL in the bead object. Assert both PR records in the prompt.
Proof: `bun test --timeout 60000 src/cli-wiki-write.test.ts --test-name-pattern AC9`.

AC10 requires proof of child completion, not merely a bounded wait.
Track each launched fixture child through a completion signal and process exit, or an equivalent observable lifecycle.
On a wait deadline, fail the test and stop/reap its fixture children before cleanup.
Do not accept an absent lock as proof that an unobserved child exited.
Use this check in every affected launch test and the ambient-environment regression, before assertions and cleanup.
Add a controlled delayed-child test that exceeds the old two-second start window.
Add a child that does not complete; the wait must fail rather than report success.
Test unexpected `gh repo` as a recorded refusal. Permit a successful private-repo response only through an explicit fixture override.
Keep default fail-and-record `gh`, `glab`, Claude and Codex tools, routing exclusions, transport interception and parent restoration.
Retain local git and fixture source reads as positive controls. No regression can contact a real service on pre-fix code.
Proof: `bun test --timeout 60000 src/cli-wiki-write.test.ts src/wiki-kick.test.ts`.

### Commits, risk and release

1. `.18`, 35 minutes: add delayed-child and timeout checks first, then correct waits and default forge responses.
   Commit only the test fixture changes. Run AC10 before the source matrix.
2. `.16`, 65 minutes: complete the finite matrix and record each row's test name and call/state assertions.
   Run AC8, AC9 and all wiki regression tests. Keep `.17` closed if its audit passes.
   Add a production fix only if a new row proves a defect; commit the red test before that fix.

Reserve 20 minutes for format, typecheck and final evidence. CI wait time is separate.
Do not repeat old red tests against old commits. New tests can pass current production code.
For new guard checks, commit first, then mutate one guard at a time; each mutant must build and fail its intended test.
The final PR head must pass test, typecheck, plugin and format CI. A prior head does not satisfy this requirement.
Use the repository test/typecheck commands, the repository gate, `bun audit`, and gitleaks before the final handoff.
Do not close a task with only a suite total: include the finite matrix or lifecycle evidence it owns.

This work is **security-sensitive** because source validation and child isolation control external access.
No new flag, dependency, migration, state format, production permission or `.factory/` change is necessary.
Reject a parser rewrite and another partial value patch. Existing adapters and table tests are sufficient.
Preserve the 180-minute kick, halt policy, 45-minute agent default, person guard and committed-page progress.
Keep the existing `FACTORY_WIKI_WRITE_MIN`, `FACTORY_DREAM_CODEX` and test timeout override contracts.
Release still needs review, security, exact-head CI and a person's merge. Rollback uses a revert PR and a person's merge.
Preserve wiki pages and state on rollback. Do not reset progress by hand.
Observe counts, masked `wiki.log` failures, state, committed pages and the remote result.
AC7 remains **must-see-live** for authorized ship soak: its own page must contain PR #590 and #591.
Run `factory wiki write --bead claude-factory-3w8o` only in that authorized live step.
The soak cannot substitute its deadline for evidence. No live read is a pre-merge acceptance condition.

## Prior revision after review round four

This revision takes precedence over earlier task lists. AC1–AC9 remain required; AC10 below adds test isolation.
Keep draft PR #714. Tasks `.1` through `.15` are complete. Do not repeat them.
Only tasks `.18`, `.17` and `.16` remain, in that order.

### Cause and design correction

The previous revision defined a closed grammar, but its tests did not cover each field's presence and value separately.
At `2664622d`, `wikiPrInfo` uses `!f.overflow`; `wikiWrite` uses `raw != null` for `ship_pr`.
Both expressions merge invalid present values with a valid absent field.
The review reproduced false completion for null metadata and false completeness for false-valued overflow fields.
The recovery tests also omit committed-content checks and some third passes.
Finally, setup bypasses the child environment policy that the command wrapper applies.

Keep the existing strict adapters and incomplete-result path. Replace truth tests with explicit presence and type checks.
Do not add a validator framework or a second source parser.
Build a table of consumed fields before the fix. Each row must identify its test and downstream-call assertion.
Audit the entire table below and the earlier complete-input table, rather than only the two reproduced values.
Use the existing test files. No production module extraction is necessary.

| Field | Absent | Accepted present value | Rejected present value |
| --- | --- | --- | --- |
| `metadata.ship_pr` | Permit discovery | Canonical rig PR URL under the earlier identity grammar | Null, boolean, number, empty string, array, object or noncanonical URL |
| GitLab changes `overflow` | Complete if other fields pass | Boolean false | Null, true, number, string, array or object |
| Detail `number` / `iid` | Incomplete | Requested positive integer | Null, wrong type, zero, fractional or different number |
| Detail `title` | Incomplete | Nonempty string | Null, empty string or another type |
| GitHub detail `merged_at` | Incomplete | Null or valid date-time under AC8 | Other type, empty string or invalid date-time |
| GitLab detail `state` | Incomplete | opened, closed, locked or merged | Null, another string or another type |
| Detail `body` / `description` | Empty text | Null or string | Boolean, number, array or object |
| File `filename` / `new_path` | Incomplete | Relative path under AC8 | Null, empty string, another type or prohibited path form |
| File `patch` / `diff` | No patch | String | Null, boolean, number, array or object |

JSON cannot contain undefined. Missing JSON properties are absent; do not use null as their equivalent.
Ignore unused API fields. Reject all other forms of consumed fields before classification or agent work.
Retain the earlier root, row, URL, date-time, page-limit and path grammar without expansion.
Test metadata and discovery entry paths for both forges, including nested GitLab project paths.
Branch discovery, unused API fields, shell source and new page grammar remain outside this correction.

### Acceptance extensions

**AC8 completion — Presence and value matrix.** Extend `src/cli-wiki-write.test.ts`; retain `src/prs.test.ts` coverage.
Test every table row above with absent, accepted and rejected values on each applicable forge and entry path.
For overflow, explicitly test absent, false, true, null, 0, 1, empty string, string false, array and object.
Test GitLab detail roots, states, identities, titles and descriptions, then changes roots, rows, paths, diffs and overflow.
Use command failure, invalid JSON, null, array/object mismatch and empty changes as negative controls.
Valid absent/false overflow, absent/null descriptions, known unmerged states and extra unused fields remain accepted source shapes.
A known unmerged metadata PR remains pending under the existing policy; valid empty discovery can settle a bead.
Invalid metadata causes zero discovery, detail, file or agent calls for that bead.
Invalid discovery causes zero detail, file or agent calls; invalid detail causes zero file or agent calls.
Invalid files cause zero classification-based completion or agent calls for that bead.
Each rejection preserves the prior timestamp and excludes the bead from `written`.
Valid unrelated beads can commit. Existing pending pushes can retry.
Proof: `bun test --timeout 30000 src/prs.test.ts src/cli-wiki-write.test.ts`.

**AC9 completion — Durable three-pass proof.** Use fixed old, new and prior dates in the date-aware fake bead list.
Add GitLab full-ID recovery beside short-ID recovery; retain GitHub global, malformed detail and malformed files cases.
For per-bead refusal, pass one commits only the newer page and preserves the exact prior timestamp.
For global GitHub refusal, pass one makes zero agent calls and preserves the exact prior timestamp.
Repair the source before pass two. Assert committed blobs with `git show HEAD:<page>`, not only worktree text or prompts.
Assert all seven sections, both code and release links, and both `written` identities after recovery.
Assert the exact maximum completed close timestamp, not merely a value different from the prior timestamp.
Pass three must preserve that timestamp and commit SHA, with zero additional agent requests.
Use these assertions for each recovery case. A stub page with both links must also require both prompt source records.
This prevents a prebuilt fixture from concealing loss of the release input.
Proof: `bun test --timeout 30000 src/cli-wiki-write.test.ts`.

**AC10 — Isolated child processes.** Fix setup and command children in both write and kick test files before source tests.
Use one local environment construction path per file. Setup must use the same policy as later CLI calls.
Remove inherited `FACTORY_WIKI_REMOTE`, `FACTORY_OUTBOX`, `FACTORY_FROM` and `FACTORY_RUN` before any child starts.
Use a fresh `FACTORY_HOME`, `FACTORY_SELF_UPDATE=0`, and fixture forge/agent tools before the real PATH.
Use `FACTORY_NO_KICK=1` except for explicit kick tests. Tests can supply controlled overrides after isolation.
Stub both `gh` and `glab`; unexpected calls must fail and record the attempt, without real forge fallback.
Use local git for fixture operations. Intercept remote transport attempts in the regression; never test against a live endpoint.
Seed ambient remote and routing values before setup, then exercise setup, write and kick children.
Assert zero external forge/transport calls, zero outbox writes, no inherited wiki remote and no parent-environment changes.
Permit controlled fixture forge calls and local commits as positive controls. Wait for detached children before fixture cleanup.
Proof: `bun test --timeout 60000 src/cli-wiki-write.test.ts src/wiki-kick.test.ts`.
The regression must use fake transport tools even on pre-fix code, so its expected failure has no external effect.

### Remaining tasks and checks

These three commits fit one 120-minute implement pass, apart from CI wait time.

1. `claude-factory-tx6c.7.18`, 25 minutes: add the safe AC10 regression, observe failure, then fix both child wrappers.
   Commit the isolated fixtures and regression. Check AC10 before any source suite.
2. `claude-factory-tx6c.7.17`, 40 minutes: complete AC9 and add the AC8 matrix cases needed by `.16`.
   Commit tests first. Record expected failures for null metadata and invalid overflow against the unchanged production code.
3. `claude-factory-tx6c.7.16`, 50 minutes: apply explicit field validation in `src/cli.ts` and audit AC8 coverage.
   Run AC1–AC10 and the existing parser tests. Commit the fix only after the focused checks pass.

Keep these commits in the existing PR. Do not release the red test commit alone.
After the fix commit, mutate the overflow check and metadata presence check separately; each mutant must build and fail its test.
Restore each mutant before the next check. Do not duplicate the closed discovery work in `src/prs.ts` without new evidence.
Run the earlier full checks: root typecheck, full tests, plugin tests, format, repo gate, audit and gitleaks.
Require test, typecheck, plugin and format CI on the final head. Review and security must inspect the matrix and recovery assertions.

### Risk, release and evidence

This correction is **security-sensitive**: external input validation and child environments control access to external services.
It prevents false completion and accidental test access to an ambient remote. It adds no production access or credential change.
No migration, dependency, flag, state format or `.factory/` change is necessary.
Keep existing agent permissions, 45-minute timeout, group limits and 180-minute kick behavior.
Reject a larger adapter rewrite: explicit field checks and complete tests resolve the present defects within this pass.
Reject deferred coverage or dry-run-only proof: neither proves durable progress after a commit.
Keep pending counts and masked failures in `wiki.log`; repeated pending counts identify unresolved source input.
AC7 remains **must-see-live** for authorized ship soak, with its own page, state, log and remote result.
The live smoke remains outside pre-merge acceptance. No live command belongs to this plan station.
Release requires review, security and a person's merge. Rollback uses a revert PR and a person's merge.
Preserve committed wiki pages and state on rollback. Do not reset timestamps or delete pages by hand.

## Prior revision after four implement rounds

### Cause and scope

The earlier plan required complete input but did not define its fields before each lossy conversion.
The implementation added checks at separate layers. A later layer cannot detect a row that an earlier layer discarded.
The tests also treated dry runs as recovery tests. Dry runs cannot prove that `lastWriteAt` remains safe.

At commit `7b16655b`, strict discovery still returns `[]` for GitHub `merged_at: 42` and GitLab `state: unknown`.
It converts an absent GitHub title into an empty string. It accepts 300 rows without proof that discovery ended.
Local stub probes confirmed these results. These are instances of one incomplete-input defect, not separate feature requests.
Relevant code: `src/prs.ts` (`githubMergedJson`, `gitlabMergedJson`, `githubPulls`) and `src/cli.ts` (`mergedPrsFor`, `wikiWrite`).

Keep PR #714 and its existing implementation. Do not repeat tasks `.1` through `.13`.
Narrow this pass to the wiki source boundary and durable recovery tests.
Keep the existing agent, page guard, state format, group bounds and kick.
The tick now permits one wiki pass: refresh, then groom, then write. Preserve that order.
Do not change `.factory/`, add a dependency, create a new parser framework or change permissive pre-check callers.

### Complete-input rule

Strict discovery must validate every consumed field before a filter, default, projection or bead-title match can discard evidence.
Only a complete, valid response can prove that a bead has no merged PR.
Every failed read, invalid consumed field or unresolved page limit leaves the bead pending and preserves the previous timestamp.
Apply this rule to GitHub discovery, GitLab full-ID discovery, GitLab short-ID discovery and both forge detail paths.
Metadata and discovered URLs have the same identity rule. A malformed present metadata value is unresolved; an absent value permits discovery.

Use the existing strict option and error path. Validate at the earliest layer that has the required context.
Preserve a complete result or an explicit incomplete result through the caller. Do not encode incomplete input as `[]`.
The existing `null` and throw paths are sufficient. No new retry queue or general result framework is necessary.

The table defines a closed projection of API data. Ignore unused API fields; never use them as authority.
Reject every other value or shape for the fields that the table reads.

| Input | Accepted fields and forms | Refusal effect |
| --- | --- | --- |
| Discovery response | A successful command and a JSON array of non-null, non-array objects | Invalid JSON, command failure or another root shape makes the whole lookup incomplete |
| GitHub discovery row | `number`: integer 1–999999999; `html_url`: canonical rig PR URL with the same number; `title`: nonempty string; `merged_at`: null or a valid ISO date-time string | Validate all rows before the merge filter; missing, empty or malformed values stay unresolved |
| GitLab discovery row | `iid`: integer 1–999999999; `web_url`: canonical rig MR URL with the same number; `title`: nonempty string; `state`: opened, closed, locked or merged | Validate all rows before the state filter; unknown states stay unresolved |
| PR identity | HTTPS with the configured forge host and exact project path; GitHub `/pull/<n>` or GitLab `/-/merge_requests/<n>` | Reject credentials, ports, query, fragment, foreign host/project, dot segments, encoded separators and number mismatch before detail calls |
| Date-time | `YYYY-MM-DDTHH:mm:ss[.fraction](Z or ±HH:mm)` with a finite parsed value and valid calendar fields | Reject empty strings, numeric values, date-only values and impossible dates |
| GitHub detail | Object; `number` equals the requested number; `merged_at` follows the discovery rule | Null proves unmerged; malformed data cannot prove unmerged |
| GitLab detail | Object; `iid` equals the requested number; `state` follows the discovery rule | Known nonmerged states remain allowed; unknown states stay unresolved |
| Detail source text | `title` is a nonempty string; `body` or `description` is absent, null or a string | Normalize absent/null body to empty text; reject another type |
| GitHub files | Nonempty array with fewer than 100 object rows; each `filename` is a nonempty repository-relative path | Empty, full, malformed or failed replies stay unresolved |
| GitLab changes | Object with a nonempty `changes` array; `overflow` is absent or false; each row has `new_path` | True or malformed overflow, empty changes, malformed rows and command failure stay unresolved |
| File path and patch | Relative slash-separated path; no empty, dot or parent segment, leading slash, backslash or control character; optional string `patch`/`diff` | Reject other forms before classification; use patches only for package.json classification, then remove them |

The file paths are source labels, not filesystem targets. Existing page rules still control every agent output path.
Keep the existing trivial-change classifier. Do not add a shell, YAML or diff parser.
Discovery does not consume branch names or merge SHAs for wiki selection. Branch discovery is outside this wiki call path.
Keep unused field defaults for other callers. Do not require unrelated review, label or branch fields here.

Completeness includes page boundaries. GitHub currently reads at most three pages of 100 rows.
That pre-check limit cannot prove complete wiki input. In wiki strict mode, read until a short page, at most 30 pages.
Reuse that GitHub result within the rig's current pass; do not repeat the scan for each bead.
Keep the three-page limit for permissive pre-check callers. Add no persistent cache or configuration flag.
In strict mode, a full final page cannot prove completion. Return incomplete at that limit.
GitLab currently reads one page of 30 rows for each search. Treat a full page as incomplete in strict mode.
Keep that search bound for this pass. Do not add an unbounded scan.
An empty or short valid final page proves completion. Test each boundary, including a full page followed by a short page.
Large repositories can remain pending under this conservative limit. The report must state this limit; a timestamp must not hide it.
Metadata success does not excuse incomplete discovery: discovery can contain a second release PR.

### Additional acceptance criteria

AC1–AC7 below remain required. Add AC8 and AC9; do not replace the prior checks.

**AC8 — Strict source grammar.** Add table tests in `src/prs.test.ts` and CLI cases in `src/cli-wiki-write.test.ts`.
Command: `bun test --timeout 30000 src/prs.test.ts src/cli-wiki-write.test.ts`.
Cover each accepted and rejected table row for each applicable forge and entry path.
Use valid empty lists, merged rows, known unmerged rows, extra unused fields and nested GitLab projects as positive controls.
Negative cases include null rows, arrays as rows, missing fields, wrong types, invalid identities and each full-page limit.
Test a GitHub match on page four, a short final page and 30 full pages.
Two beads in one rig must share one GitHub scan. A new pass must read fresh data after a refusal.
Test title loss, invalid merge states and URL/number mismatch before any row filter.
For rejected discovery input, assert zero detail, file-list and agent calls for the affected bead.
For rejected detail input, assert zero file-list and agent calls for that bead.
For rejected files, assert zero classifier-driven completion and zero agent calls for that bead.
Assert that valid unrelated beads can still complete. Do not require a global stop or suppress a valid pending push retry.
Legacy calls without strict mode must retain their existing results.

**AC9 — Durable recovery, not dry-run recovery.** Add real stub-agent passes in `src/cli-wiki-write.test.ts`.
Use an older bead with incomplete input and a newer bead with a valid metadata PR.
Seed an explicit `lastWriteAt` before both close dates. Make the fake bead list honor its date filter.
First pass: the newer bead commits; the older bead remains absent from `written`; `lastWriteAt` stays byte-for-byte unchanged.
Second pass: repair the old input; assert the old bead's seven-section page commits and enters `written`.
Third pass: assert no new page request for either committed bead.
Repeat for GitHub discovery, GitLab full-ID discovery, GitLab short-ID failure, malformed detail and malformed file data.
Include one valid code PR and one release PR in the recovered page.
For a global discovery refusal, first assert no agent call; then repair it and prove both beads recover.
Keep dry-run tests as AC1 output checks only.
Command: `bun test --timeout 30000 src/cli-wiki-write.test.ts`.

### Remaining commits and checks

Two tasks fit one 120-minute implement pass. Preserve all prior tests and closed tasks.
Tracked order: `claude-factory-tx6c.7.14` (tests), then `claude-factory-tx6c.7.15` (fix and checks).

1. Tests, 45 minutes: add the AC8 boundary matrix and AC9 durable recovery cases to the existing test files.
   Record failures against `7b16655b`. Commit tests first; do not publish a final head with red checks.
2. Fix, 70 minutes: enforce the complete-input rule in existing strict adapters and their wiki caller.
   Check AC1–AC9 and legacy adapter behavior. Use the existing incomplete-result path, without a new state format.
   Mutate merge-state validation, title validation, identity validation and final-page refusal separately after the fix commit.
   Each mutation must build and fail its intended test. Restore each mutation before the next check.

Run `bun test --timeout 30000 src/prs.test.ts src/cli-wiki-write.test.ts src/wiki.test.ts`.
Run `bun test --timeout 30000 src/wiki-kick.test.ts` separately if process load affects it.
Run the repo type check, formatter, full test and plugin commands from `package.json`.
Run the repo gate, `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
Required test, typecheck, plugin and format CI jobs must pass on the final head.
Review and security must inspect the complete matrix, not only the last failed example.

### Risks, rollout and alternatives

This revision is **security-sensitive**: it validates forge data and agent source identities.
The main data risk is silent loss behind `lastWriteAt`. The conservative incomplete result prevents that loss.
More inputs can remain pending, especially full discovery pages. That is an explicit operational limit, not completion.
Retain the existing summary's pending count and masked failure log. AC9 proves local progress; AC7 remains **must-see-live**.
The ship soak must inspect its own page, state, log and push result before it reports health.

No migration or flag is necessary. Keep the 180-minute kick and `FACTORY_WIKI_WRITE_MIN` behavior.
Keep `FACTORY_WIKI_AGENT_MS` unset outside tests; its default remains 45 minutes.
Release through the existing draft PR, review, security and person's merge. No live action belongs to this plan station.
Rollback uses a revert PR and a person's merge. Preserve wiki commits and state; do not advance or reset timestamps by hand.

Reject another isolated malformed-row patch: it leaves loss at adjacent conversion steps.
Reject a new discovery service or unbounded history crawl: neither fits this bounded correction.
Reject a new retry store: the existing timestamp rule already preserves unresolved work.
Reject changes to all pre-check callers: their permissive behavior predates this feature and has separate contracts.

## Decision

Add `factory wiki write [--dry-run] [--bead <id>]` in `src/cli.ts`.
Use `dream()` as the process pattern. Reuse the wiki lock, state, person guard, commit and push helpers.
Hold `wiki.lock` through collection, the agent, validation, commit, state update and push.
A real pass writes `wiki-write.stamp` before collection. A failed pass keeps its stamp.
A dry run takes the lock but changes no stamp, page, state, commit or remote.

Collect closed beads from each configured rig with beads support.
Use `closedSince()` with the date of `lastWriteAt`; filter timestamps locally with an inclusive boundary.
With no valid timestamp, start at the Unix epoch. Do not discard an initial backlog.
Fetch the full bead and comments: `closedSince()` returns brief rows.
Collect related run reports from local journals.
With `--bead`, select only that closed bead, without the timestamp limit. It must still have a merged PR.

Use `ship_pr` and `mergedPrsFor()` together, then deduplicate by canonical PR URL.
A metadata URL alone does not prove a merge. Check its merged state through the rig's forge client.
Keep all merged PRs for the bead, including separate code and release PRs.
Read file lists for `trivial()`; retain its current classification. Do not invent a whitespace-diff classifier here.
Exclude groups with no non-trivial merged PR. Keep all related merged PR links for each retained group.
Use `writeGroups()` for shared-PR groups and its existing cap, default 20, oldest first.
The current helper removes trivial PRs from each group. Restore those related PR links after group selection.
Test a code PR plus a trivial release PR; the page must retain both links.
Extend its input and prompt with rig names, reports and ISO close dates.
Preserve cross-rig identity when groups share a PR. Include all contributing rigs in the page.

Bound source strings before `writePrompt()` calls `mask()`.
Use at most 8,192 characters per source string and 32 comments plus 32 reports per bead.
Use at most 262,144 characters of source text per pass; defer excess groups without marking them complete.
Use deterministic order. Mark truncated text in the prompt.
Retain package.json patches only for the trivial-change check; omit all patches from the agent prompt.
Treat incomplete file lists or failed forge reads as unresolved input, not as trivial changes.

Skip beads in `written` or valid committed solution pages.
A later bead that shares an existing page's PR updates that page rather than creates a duplicate.
Reconstruct missing `written` entries from committed pages after a crash.
Pass existing page associations, glossary terms and tombstones to the prompt.

Capture `wikiBlame()` before the agent. Refuse the pass when it returns undefined.
Run Claude in `wiki/` with `-p --permission-mode acceptEdits` and `--settings JSON.stringify(passSettings())`.
Allow only Read, Write, Edit, Glob, Grep, `Bash(git mv:*)` and `Bash(git rm:*)`.
Do not grant tools that create git objects, commits or refs. Source text stays inline; no repo access is necessary.
Use a 45-minute timeout. Log the exit and masked output to `wiki.log`.
With `FACTORY_DREAM_CODEX`, use the dream's model check, private home, environment allowlist and workspace-write sandbox.
Use the wiki path as its workspace. Refuse wiki-local `.codex` configuration, including a symlink.
Preserve the dream's network-off and temporary-directory exclusions. Do not reuse a memory-specific trusted workspace path.

After the agent, call `keepPersonLines(before, reason)` before any commit.
On agent failure, timeout or guard refusal, commit no generated work and advance no write progress.
On success, use `scanPages()` and `commitWiki('write', summary)` with the existing path and secret checks.
Record only valid solution pages present in the resulting commit, not merely files present in the worktree.
An invalid or restored page does not complete its input group. Other valid pages can commit.
Keep unresolved items eligible for the next pass.

Update `written` after the commit. Preserve unrelated state fields.
Advance `lastWriteAt` to the newest completed bead only when no candidate remains unresolved or over the cap.
Otherwise retain the old timestamp. This conservative rule avoids a new retry queue.
Use an inclusive timestamp boundary to preserve equal-time beads.
A targeted `--bead` pass must not advance the global timestamp.
Call `pushWiki()` after the local commit and on a later empty pass, so a failed push can retry.
A failed push retains the valid local commit and its `written` entries. It must not regenerate those pages.

Add a separate write kick beside `kickWiki()` in the tick's `finally` block.
Default to 180 minutes. Accept a finite positive `FACTORY_WIKI_WRITE_MIN`; otherwise use 180.
Skip when halted, uninitialized, locked, too recent, or `FACTORY_NO_KICK=1`.
Stamp before the detached spawn. Keep refresh active while halted.

## Acceptance criteria

Each named test below belongs to `src/cli-wiki-write.test.ts`, unless another file appears.
The test command is `bun test src/cli-wiki-write.test.ts src/wiki.test.ts src/wiki-kick.test.ts`.

1. **AC1 — CLI grammar and dry run.** Test `write AC1 arguments and dry run`.
   Accept each flag once, in either order. Accept one nonempty bead identifier as the `--bead` value.
   Reject unknown flags, duplicate flags, extra operands, a missing value and a value that starts with `-`.
   Reject control characters and identifiers outside `[A-Za-z0-9][A-Za-z0-9._-]*`.
   Rejection exits 2 before any bead, forge, agent or git mutation call.
   Dry run prints masked groups and makes zero agent, commit or push calls. It preserves stamps and state.
   A held lock returns `wiki: busy` without collection. A missing wiki does not create one.
2. **AC2 — Complete input.** Test `write AC2 merged input and limits`; extend `src/wiki.test.ts`.
   A closed bead with code and release PRs yields one group with both links, rig, reports and ISO dates.
   Shared PRs yield one group. An open bead, unmerged PR or wholly trivial group yields none.
   A missing metadata field uses discovery. Metadata does not suppress discovery of a second PR.
   Unknown file data stays pending. Empty, malformed and failed forge responses must not imply success.
   Oversized strings and excess groups obey the bounds before masking; omitted groups remain eligible.
3. **AC3 — Agent contract.** Test `write AC3 process and failure` with stub agents.
   Assert cwd, exact tool list, settings, stdin, timeout and stamp-before-spawn order.
   Assert the Codex model, sandbox, environment and wiki workspace separately.
   Invalid model names or local `.codex` paths make zero agent calls.
   Nonzero exit and timeout retain the stamp, log failure, release the lock and make zero commit or progress updates.
4. **AC4 — Page and person guard.** Test `write AC4 guarded commit`.
   A valid solution has Problem, Cause, Change, Options rejected, Verification, Still open and Links, in that order.
   It declares `cause: proven` with evidence, or `cause: hypothesis` with the proof still needed.
   It appears in a factory `wiki write:` commit and in `written`.
   Missing sections, unknown frontmatter keys, secret shapes, unsafe paths, nonregular files and tombstones stay out of the commit.
   Test a valid page beside an invalid page. Only the valid bead enters `written`.
   A person's changed line restores the old page and adds a flag. HEAD movement makes zero commit and push calls.
   Reuse `src/wiki-person.test.ts` and `src/cli-wiki.test.ts` for the full existing guard grammar.
   Do not add a new shell or YAML parser. Existing `parse()`, `WIKI_PAGE_PATH` and `commitWiki()` define the closed page grammar.
   New fields, arbitrary filesystem paths, shell source and additional Bash tools are out of scope.
5. **AC5 — Retry and deduplication.** Test `write AC5 progress survives partial failure`.
   Run two passes. A committed bead causes no second agent page request, even if state lacks its entry.
   An older failed page remains eligible after a newer page succeeds.
   Test 21 separate groups with cap 20, equal close times, a failed rig read and a targeted old bead.
   No row disappears behind `lastWriteAt`. A later bead on the same PR uses the existing page path.
   A commit failure leaves progress unchanged. A push failure retries the push without another agent run.
6. **AC6 — Periodic write.** Add `write AC6 kick matrix` in `src/wiki-kick.test.ts`.
   No stamp or a stamp at least 180 minutes old permits one launch.
   A fresh stamp, missing wiki, held lock, paused halt, stopping halt or `FACTORY_NO_KICK=1` permits zero launches.
   Test override 1, zero, negative, nonnumeric and Infinity. Test two consecutive ticks after a failed spawn.
   Existing refresh-while-halted tests must still pass.
7. **AC7 — Output and smoke.** Test `write AC7 status and log` with an isolated home.
   Assert `wiki write: <n> pages from <m> beads; <k> waiting`, the exit log and status stamp.
   Counts describe committed pages and unresolved inputs. Never log raw source secrets.
   After release, the ship soak must inspect its own write output: **must-see-live**.
   The owner or authorized ship run uses `factory wiki write --bead claude-factory-3w8o`.
   One committed page must name PR #590 and #591 and contain all seven sections.
   The soak must check the page, state, log and remote result. A deadline alone does not prove health.
   This live smoke is not a pre-merge gate. Use an equivalent acme fixture for CI.

## Initial test plan and completed tasks

Use fresh test homes and stub bd, forge and agent processes. Tests must not reach a live service.
Strip `FACTORY_OUTBOX`, `FACTORY_FROM` and `FACTORY_RUN`; set `FACTORY_SELF_UPDATE=0`.
Set `FACTORY_NO_KICK=1` except in kick tests. Wait for detached children before cleanup.

1. Commit tests first: AC1–AC7 fixtures, partial failures, guard refusals and the kick matrix.
   Run the focused command above. Record expected failures on the pre-change code.
2. Commit the write pass: collection, prompt context, bounded input, agent, guard, commit and durable progress.
   Touch `src/cli.ts`, `src/wiki.ts` and their tests only as needed. Check AC1–AC5 and AC7.
3. Commit the kick and CLI help. Check AC6 and all wiki regression tests.
   Run `bun test --timeout 30000 src factories`, `bun x tsc --noEmit -p .`, and `claude plugin test mod`.
   Run `bun x prettier@3.9.9 --check .`, the repo gate, gitleaks and `bun audit`.
   Run `tsc -p mod` only when the generated plugin types exist; CI checks plugin types through its plugin job.
   Required CI checks must pass on the final head. Do not ship the tests commit by itself.

The tasks form one pull request and fit one 120-minute implement pass.
Tracked order: `claude-factory-tx6c.7.1` (tests), then `.7.2` (pass), then `.7.3` (kick and checks).
The dependency edges enforce this order. Estimates are 35, 55 and 30 minutes, apart from CI wait time.
No dependency needs another code change before this work starts.
The separate naive-reader check remains with the linked comprehension bead.

## Risks and alternatives

This change is **security-sensitive**: external text reaches an agent with file permissions and a forge client.
Pass only canonical PR identities for the configured rig to existing forge APIs as argument values, never shell source.
Reject foreign origins, credentials, query strings, fragments and non-PR paths before a metadata-driven API request.
Accept only `https://<rig-host>/<rig-owner>/<rig-repo>/pull/<positive-decimal>` for GitHub.
For GitLab, accept `https://<rig-host>/<rig-project-path>/-/merge_requests/<positive-decimal>`.
The host and project path must exactly match the parsed configured origin. Reject every other metadata URL form.
Test those rejections with zero metadata-driven network calls. Existing forge adapters retain their GitHub and GitLab path rules.
Use source masks, the existing person guard and private-only push. Do not widen their accepted inputs.
Agent tool restrictions are not a new sandbox. Preserve the existing Codex sandbox and guard checks.

State is outside git. A crash after commit must recover from committed pages.
A conservative timestamp can repeat reads, but `written` prevents repeated agent work.
No migration, dependency or new factory definition is necessary. Old state fields remain valid.

Reject a new station: this pass belongs beside dream and refresh.
Reject a second validator: the existing page and commit checks already define the contract.
Reject timestamp-to-now: it loses capped and failed items.
Reject new retry storage: retaining the timestamp is enough for this bounded pass.

## Rollout and rollback

Use the normal draft PR, review and security gates. A person must merge.
An existing wiki opts into the 180-minute kick after release. A missing wiki remains inactive.
No owner credential or live-system change forms part of this plan.
The ship run must follow the live-read and owner rules for its smoke.

Rollback uses a revert PR and a person's merge. Do not delete wiki pages or state.
The old version ignores the added kick and keeps the existing wiki commands.
Preserve pending inputs for a later fix. Use the normal factory halt if the owner needs an immediate stop.
