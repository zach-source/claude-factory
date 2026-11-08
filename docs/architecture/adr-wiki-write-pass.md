# ADR: Write wiki solution pages from closed beads

## Context

This plan covers T007, bead `claude-factory-tx6c.7`. The write helpers and person guard already exist.
The CLI has no write pass. The tick starts refresh only.
No repository CLAUDE.md, AGENTS.md or CONTRIBUTING file exists in this checkout.
The station brief supplies the repo rules.

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

## Test plan and tasks

Use fresh test homes and stub bd, forge and agent processes. Tests must not reach a live service.
Strip `FACTORY_OUTBOX`, `FACTORY_FROM` and `FACTORY_RUN`; set `FACTORY_SELF_UPDATE=0`.
Set `FACTORY_NO_KICK=1` except in kick tests. Wait for detached children before cleanup.

1. Commit tests first: AC1–AC7 fixtures, partial failures, guard refusals and the kick matrix.
   Run the focused command above. Record expected failures on the pre-change code.
2. Commit the write pass: collection, prompt context, bounded input, agent, guard, commit and durable progress.
   Touch `src/cli.ts`, `src/wiki.ts` and their tests only as needed. Check AC1–AC5 and AC7.
3. Commit the kick and CLI help. Check AC6 and all wiki regression tests.
   Run `bun test src factories`, the repo typecheck, plugin tests, formatter, gate, gitleaks and `bun audit`.
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
