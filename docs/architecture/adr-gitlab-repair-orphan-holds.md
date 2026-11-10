# ADR: Preserve open and approved GitLab merge requests

## Context

Bead: `claude-factory-6r645`. Plan base: `cd3743a3`.
`src/cli.ts:10934` returns no repair facts for GitLab rigs.
Thus `repairPass` has no GitLab held beads at line 11027.
`src/cli.ts:11520` also sets GitLab approval to false without an approval read.
An automatic parent close can lose its hold. The orphan sweep can close an approved MR after a person closes its bead.
The GitHub repair safeguards already exist. This change connects GitLab evidence to those safeguards.

## Design

Extend `rigPrs` in `src/cli.ts` to read open GitLab MRs from the configured origin.
Use `spawnGlab`, explicit `--hostname`, the repo cwd, and the existing timeout convention.
Use `projects/<encoded owner/repo>/merge_requests?state=opened&per_page=100&page=<n>`.
Read consecutive pages until a short page. An exact full final page needs an empty next page.
Collect and validate all pages before repair effects. A failed page must abort repairs for that rig.
Do not treat an invalid response as an empty list.
Normalize each row to `PrFact`: `iid` to `number`, `web_url` to `url`, `source_branch` to `headRefName`, and `opened` to `OPEN`.
The repair hold needs no approval read. Both drafts and ready MRs hold their known run beads.
Use the existing `heldBeads`, `repairs`, and `closeParents` paths without a second hold policy.
Keep the GitHub all-state list and its current behavior.
GitLab merged history, conflict probes, and automatic unship parity are outside this change.
Do not send GitLab facts to a GitHub API probe. An unknown conflict result must cause no conflict action.
The digest shares `rigPrs`; its GitLab facts will now include open MRs only.

In the GitLab orphan view, read `projects/<encoded owner/repo>/merge_requests/<iid>/approvals`.
Preserve the current MR detail checks for conflicts, draft status, and requested changes.
Set `approved` from the literal boolean `approved` in a valid approval object.
An approval read failure or an invalid approval field must return an unreadable view, never `approved: false`.
The sweep then skips effects for that MR through its existing null-view path.
Literal approval true must preserve the MR even when the detail status also reports requested changes.
Do not copy the optional-approval fallback from `parseGitlabView`: that fallback serves a display, not a close decision.
Reuse its API pattern and boolean semantics. No new dependency or generic forge framework is necessary.

Primary files: `src/cli.ts`, `src/repairs.test.ts`, `src/orphans.test.ts`, and `src/orphans-cli.test.ts`.
A small helper in `src/prs.ts` with tests in `src/prs.test.ts` is acceptable if it keeps the adapter testable.
Prefer existing test fixtures. Do not export the entire repair scheduler only for a unit test.
Add one release bullet at the end of Unreleased in `CHANGELOG.md` during implementation.
No `.factory/` change is necessary.

### Input contract and failure rule

The rule is: incomplete or invalid forge evidence must never authorize a destructive repair or orphan action.
The new list reader accepts a JSON array of MR objects.
Each row must have a positive integer `iid`, nonempty string `web_url`, nonempty string `source_branch`, and `state: opened`.
The URL must identify that IID on the configured GitLab host and project using the existing URL parser.
An unexpected state or invalid required field invalidates the page; it must not disappear through a filter.
An empty array is a valid complete page. Optional API fields do not affect this hold.
The approval reader accepts an object with a boolean `approved`; other API fields do not affect the decision.
Extra API metadata is outside the decision projection and can be ignored. It cannot supply a host, command, or path.
Reject null, arrays as objects, scalar responses, invalid JSON, missing fields, and wrong field types.
Endpoints use only the configured origin, an encoded project path, a positive integer IID, and a generated positive page number.
Do not follow a response URL or pagination URL as an API destination.
No shell command, configuration language, arbitrary endpoint, or new origin syntax is in scope.
Preserve the existing orphan MR detail parser and branch eligibility rules.

### Rejected alternatives

- A hardcoded false approval destroys the safeguard when a person approves an MR.
- An empty list after an API failure permits a parent close without evidence.
- A fixed first page misses older open MRs and repeats the reported defect.
- A second hold policy in `repairs.ts` duplicates the tested GitHub policy.
- Full GitLab repair parity adds merged-history and conflict behavior beyond this bug.
- A generic forge rewrite increases scope without a second required use.

## Acceptance criteria

Prefix new test names with `6r645 ACn`.

1. **AC1: GitLab facts reach both repair holds.**
   Use the real GitLab adapter with a fake glab list and the run-to-bead map.
   In `src/repairs.test.ts`, prove `heldBeads` prevents the done-epic close and the ancestor close.
   Test draft and ready MRs, a nested project path, and a later-page MR.
   Negative rows: another run, another rig, a non-factory branch, and an unknown run must not hold this bead.
   Existing normalized CLOSED and MERGED rows must not hold. Merged evidence must still permit its existing close decision.
   Check: `bun test --timeout 30000 src/repairs.test.ts src/prs.test.ts src/orphans-cli.test.ts`.

2. **AC2: Repair list failures preserve data.**
   Add adapter and CLI tests for command failure, timeout, invalid JSON, wrong top-level type, and invalid required fields.
   Include a valid first page followed by a failed or malformed page.
   Assert zero repair bead mutations for that rig; never use the partial facts as a complete list.
   A separate valid rig must still complete its pass. A valid empty page must permit normal no-hold behavior.
   Assert exact configured host, encoded project, page sequence, and zero GitHub API calls for GitLab facts.
   Check: the AC1 command. The CLI test must trace effects, not only inspect a held-set helper.

3. **AC3: Approved GitLab orphans stay open.**
   In `src/orphans-cli.test.ts`, return `approved: true` from the exact approvals endpoint.
   Test a person-closed bead and a deferred bead. Assert zero MR close calls and zero review forks.
   Assert the existing owner label and hold reason. An existing owner label must cause no duplicate label call.
   Add a GitLab URL row to `src/orphans.test.ts`; the CLI row must exercise the API adapter too.
   Include approval true with requested changes. Preserve the MR in that row.
   Negative control: approval false permits the existing closed/deferred orphan close when all other checks allow it.
   The exact `every child is closed` reason must still hold without an approval lookup.
   Check: `bun test --timeout 30000 src/orphans.test.ts src/orphans-cli.test.ts`.

4. **AC4: Unknown approval never permits effects.**
   Test failed detail and approval calls, timeout, malformed JSON, null, array, missing approved, and nonboolean approved.
   Include `"false"`, `"true"`, zero, and one as invalid approval values.
   Each unreadable view must cause zero close, label, fork, and record calls for that MR.
   Read calls are permitted. A following valid MR must still proceed within the existing action and lookup caps.
   Preserve GitHub results, fork exclusions, live-owner holds, CI checks, and stopped-factory behavior.
   Check: the AC3 command and `bun test --timeout 30000 src/prs.test.ts` if a parser changes.

5. **AC5: Final head passes the repo checks.**
   Run `bun test --timeout 30000 src factories`, `claude plugin test mod`, and `bunx tsc --noEmit -p .`.
   Run `bunx prettier@3.9.9 --check .`, `bun audit`, and `gitleaks detect --log-opts=origin/main..HEAD`.
   Run the factory-required gate. Record any environment gap without a substitute claim.
   Final-head CI test, plugin, typecheck, and format must pass before handoff for approval.
   No required test can remain red by design. No production query is a pre-merge criterion.

## Test plan

First commit the regression tests. Show AC1 and AC3 fail on the plan base through the real adapters.
AC1 must fail because GitLab facts are absent. AC3 must fail because the sweep closes the approved MR.
Add the failure rows in that test commit. Keep all implementation commits in the same PR.
Use fake glab and bd commands, an isolated factory home, and explicit subprocess call traces.
Strip `FACTORY_OUTBOX` and `FACTORY_FROM`; set `FACTORY_SELF_UPDATE=0` as the existing fixtures do.
Update fake glab fixtures to answer the approvals path before the broader MR detail pattern.
Do not let the detail response accidentally stand in for the approval response.
After the fix, run the focused commands and AC5.
Prove the approval guard with a buildable mutation through `factory mutate` after the implementation commit.
Restore the worktree and record the command, exit status, and test name.

## Risk

This change is security-sensitive because external API data controls automatic bead and MR actions.
Unknown evidence must retain work. That policy can delay cleanup during an API outage.
Extra page reads increase latency on large projects. Existing timeouts bound each subprocess.
Approval state can change after a read; this plan adds no transaction across GitLab and beads.
Existing sweep caps and ownership checks remain intact.
No schema, credentials, permissions, stored record format, or migration changes are necessary.
GitHub behavior must remain compatible. No new worker-hook or live-system change is in scope.
Security-sensitive: yes (forge input parsing and approval-based action safeguards)

## Rollout and rollback

Use one draft PR with tests first and a green final head. A person must merge before normal release.
No flag or migration order is necessary. The new behavior starts with the normal factory release.
Rollback uses a revert PR and the normal release process; no direct production command is authorized here.
A rollback restores the GitLab defect. It cannot reopen beads or MRs that the old code closed.
Do not automatically reopen historical work in this run. The owner must assess any historical repair separately.

## Observability

Use existing `repairs.jsonl`, `orphans.json`, bead state, MR state, and owner labels.
The ship soak can correlate a normal pass time with an open run bead and its open MR.
For an approved orphan, correlate `held for the person: approved` with the retained MR and owner label.
API failures must retain the existing repair diagnostic or orphan unreadable-view diagnostic.
No new metric or dashboard is necessary. Do not record tokens or raw API payloads.
These are ship-run reads, subject to owner access rules. They are not plan-stage or pre-merge gates.
No AC is must-see-live; deterministic adapter and sweep tests prove the contract without a manufactured production orphan.

## Commit tasks

1. `claude-factory-6r645.1`: Regression tests for AC1 through AC4. Check: focused suites; record baseline failures. Budget: 35 minutes.
2. `claude-factory-6r645.2`: GitLab open-list adapter and repair holds. Check: AC1 and AC2. Budget: 30 minutes. Depends on task 1.
3. `claude-factory-6r645.3`: GitLab approval view, release note, and final checks. Check: AC3 through AC5. Budget: 55 minutes. Depends on task 2.

All three tasks belong to this run and one PR. The total implementation budget is 120 minutes.

## Plan evidence

No repo or inspected parent rule file exists. The supplied factory rules apply.
The bead has no prior implementation tasks. The run branch has no PR or new commit at plan start.
The factory memory search returned no local notes.
`bun install --frozen-lockfile` passed.
`bun test --timeout 30000 src/repairs.test.ts src/orphans.test.ts` passed: 81 tests and 246 assertions.
Those tests prove existing pure-policy behavior; they do not prove the missing GitLab adapters.
Plan did not run the full build, full suite, plugin tests, or production checks.
One file-search command was denied by the worker hook. No bypass was attempted.
The repo Prettier check passed; `.prettierignore` excludes Markdown. No Markdown linter exists in the package scripts.
