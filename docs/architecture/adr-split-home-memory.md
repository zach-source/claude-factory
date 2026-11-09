# ADR: One memory store after the home split

Status: proposed; prerequisite order needs a decision.
Run: lifecycle-mw9jvudcon. Bead: claude-factory-4z8f.

## Evidence and decision gate

At `22496d82`, `src/cli.ts:365` selects `HOME/memory` for each process.
The memory commands at `src/cli.ts:13049` use that directory.
`CONFIG_SYNC` at `src/cli.ts:6515` pushes memory only through a home with a Git origin.
`src/client.ts` has no memory routes. `serverMode()` excludes workers.
The server client API already uses person certificates and refuses worker tokens.
There is no `home split` implementation on this head.

[PR 665](https://github.com/zach-source/claude-factory/pull/665) contains the split.
Its draft head is `ff8851f2c7f06b3977ae12ef99ac65de932a020d`.
Its review holds the split on this bead, unless the owner accepts divergence.
Worker API task `claude-factory-akiq.9` depends on split task `claude-factory-akiq.5`.
Memory API task `claude-factory-akiq.10` depends on `.9`.
Worker transport task `claude-factory-akiq.12` depends on `.10`.
Thus a dependency on those tasks would create a release cycle.

Recommended order: land the API code before the live split. Keep the split deployment gate intact.
The manager must coordinate that order before implementation starts. Do not add a cyclic dependency.
No live split, credential change, or acceptance of divergence follows from this ADR.

## Design

The server owns the memory store for a split installation.
The local home uses the server for memory reads and writes.
An unsplit home keeps its current behavior.
Use the existing client API for the person and manager. Use the worker API for worker tokens.
Never give a worker the person certificate or let its token reach the client port.

Reuse the memory handlers from T010. Share validation, dedupe, usage events, and output format with the local CLI.
Do not build a second note parser or a directory merge protocol.
Keep the existing note format, `.usage.jsonl`, `.renames.jsonl`, and supersedes behavior.
Return store-relative note references. A returned reference must work in a later `helped` or `--supersedes` command.

The persisted split state must select the memory owner, even when `FACTORY_SERVER` is absent.
All split-home memory commands must use that owner or refuse the operation.
An unset environment variable must not reactivate the stale local store.
An unavailable owner must not cause a local search or local mutation.
Worker transport can queue a write under T012. Its output must distinguish queued from applied.
Replay must preserve the request identity across API retries and outbox delivery.

Local herdr workers need the same scoped memory transport as AX workers.
Their run state stays local. Memory routing must not move their report, mail, or run control to the server.
T012 must provide this transport before this plan can claim full ownership.
Local launch briefs and VM snapshots must come from the owner too.
Otherwise worker advice stays stale despite correct interactive search.

Only the owner can run dream, compact, archive, or other memory maintenance.
The local process must refuse these operations in split mode unless a defined owner operation exists.
Do not add remote maintenance operations in this change.
The local `CONFIG_SYNC` must not push its frozen memory copy over the owner store.
Keep local configuration sync unchanged.

Files: `src/client.ts`, `src/cli.ts`, `src/server-api.ts`, `src/core/catalog.ts`, and the T010 memory handler.
Use `src/core/ops/memory.ts` only if the catalog needs that operation module.
Extend the split state and tests from PR 665 after the prerequisite decision.
Update `specs/004-factory-server/contracts/client-api.md` and `docs/remote-runner.md` with the final routes and cutover steps.
Use `src/memory.ts` only for shared behavior that the T010 handler does not already expose.
Do not edit `.factory/`.

Rejected alternatives:

- Timer merges need conflict rules for note edits, archive moves, rename maps, and usage events. Git alone cannot preserve their meaning.
- A shared filesystem link cannot connect a laptop and the server PVC.
- Two writable copies with periodic overwrite lose notes or usage events.
- Local ownership makes the server depend on laptop availability.
- A worker token on the client port defeats the current identity boundary.

## Closed input contract

Use catalog-backed client operations. Search records shown events, so use `POST /v1/memory/search` on the client port.
Worker routes remain under the T010 contract. Do not change their authentication rules here.
Client POST operations use the existing UUID idempotency key and durable replay behavior.

| Client route | JSON fields |
| --- | --- |
| `/v1/memory/search` | Required `q`: nonempty text. Optional `rig`: ID, `from`: attribution, `noCore`: true. |
| `/v1/memory/add` | Required `kind`: fact, rule, or recipe; `summary`: nonempty text; `body`: text, possibly empty. Optional `rig`, `from`, `until`, `supersedes`, `anyway`: true. |
| `/v1/memory/helped` | Required `path`: one note reference; `from`: attribution. The CLI sends one operation per path. |

Text fields have at most 65,536 characters and no NUL. Apply the existing report text sanitizer.
IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
Attribution is two such IDs separated by one slash. Worker attribution comes only from the verified token.
The existing `memory.gate()` validates kind and until. `--anyway` never bypasses this gate.
Only the declared fields are valid. Refuse unknown fields, duplicate query keys, wrong types, and missing required values.
Refuse all query fields on client POST routes. Refuse request bodies that are not JSON objects.

A note reference is a store-relative Markdown path, optionally followed by one nonempty entry fragment.
Each path segment must be nonempty and must not equal `.` or `..`.
Refuse absolute paths, backslashes, NUL, control characters, and symbolic links in any path component.
Resolve the rename map within the owner store. Check containment again after resolution.
Require a regular `.md` file and an existing entry for a fragment.
Permit `CORE.md#entry` and `topic/LONG.md#entry` when the entry exists.
Refuse directories, missing files, missing entries, and escapes through rename targets.
Do not URL-decode JSON note references.
Filesystem paths in `--body-file` are client-only inputs. Read their contents locally; never send the path for server access.

Validate the complete request before any model call, handler call, subprocess, or memory write.
Tests must assert zero downstream calls for every refusal.
Server-side shell text, arbitrary file reads, bulk imports, archive uploads, and remote maintenance are outside this grammar.

## Acceptance criteria

All test commands below use disposable homes and a loopback test server. They do not read production memory.
The named cases belong in `src/memory-owner.test.ts`, unless another file is explicit.

1. **AC1 — one store:** `bun test --timeout 30000 src/memory-owner.test.ts`, case `two homes share notes`.
   Add through the server worker path; local search returns that note without a sync tick.
   Add through the local client path; server search returns that note.
   A sentinel note present only in the frozen local copy must not appear.
   Compare the top five owner and client references for ten fixed queries.
2. **AC2 — usage and retries:** the same command, case `helped survives retry and restart`.
   Help from each side reaches the owner usage log with the correct attribution.
   Replay one request after a lost response and server restart; its helped event count stays one.
   Two distinct request IDs must produce two events. No event reaches the frozen local copy.
   The T012 API-to-outbox retry must also preserve the count.
3. **AC3 — closed boundary:** the same command, case `invalid memory requests have no effects`.
   Cover every rejection class in the closed contract, including traversal, symlinks, rename escapes, and unknown fields.
   Cover valid short notes, LONG entries, CORE entries, rig filters, and Unicode note text.
   Assert zero handler, model, subprocess, and write calls after refusal.
   Existing server TLS tests must still reject absent person identity and worker tokens on the client port.
   Worker tests must reject expired, revoked, and wrong-scope tokens, plus forged attribution.
4. **AC4 — owner failure:** the same command, case `owner failure never uses stale memory`.
   Cover refusal, timeout, absent server, malformed owner state, and absent `FACTORY_SERVER` in split mode.
   Search fails clearly; writes fail or report queued under T012. Neither path reports an applied write.
   Assert no local note or usage mutation. Unsplit local add, search, and helped must still pass.
5. **AC5 — all callers:** the same command, case `split callers keep one memory owner`.
   Cover person, manager, local herdr worker, AX worker, outbox replay, launch brief, and VM snapshot.
   Prove local worker report and mail still use their original run home.
   Local dream and compact must refuse; owner maintenance must still work.
   A split local config sync must skip memory push but retain config push.
6. **AC6 — cutover:** the same command, case `cutover preserves the authoritative store`.
   With writers stopped, seed the owner from one unsplit source and compare note and usage checksums.
   A repeated cutover must not recopy memory. An existing, different owner store must refuse replacement.
   Preserve both source copies on refusal. Never auto-merge divergent histories.
   A backup restore rehearsal must retain a note and helped event added after cutover.
7. **AC7 — must-see-live:** after approved cutover, soak must see its own cross-home evidence.
   Use a real reusable note from a worker, with its unique reference and run/station attribution.
   Run `factory memory search --rig <rig> <query>` from the local client and the server worker.
   Run `factory memory helped --from <run>/<station> <reference>` from the other side.
   Confirm the owner event and both search results through approved read access.
   Record the reference, attribution, and event count; omit note bodies and credentials.
   The soak must not report healthy without this evidence. A deadline cannot replace it.

## Test plan and tasks

Do not start the test commit until the prerequisite order is resolved and the shared API transport is present.
Keep all implementation commits in one pull request. Its required checks must pass before approval.
Use deterministic model fixtures for route tests. Use the installed model for the ten-query integration comparison.
Do not weaken an existing test when the model is absent; report that local test gap.
Each child task below is one commit. The target is 120 minutes after prerequisites land.

1. `claude-factory-4z8f.1`, test commit, 30 minutes: add AC1–AC6 regression cases with fresh homes and a loopback server.
   First show `two homes share notes` red on the pre-fix head. Save the failure in the implementation report.
2. `claude-factory-4z8f.2`, API commit, 40 minutes: add the client routes and reuse T010 handlers with the closed contract.
   Pass AC1–AC3 and existing client, catalog, TLS, and memory tests.
3. `claude-factory-4z8f.3`, ownership commit, 35 minutes: wire split state, caller routing, maintenance refusal, and config sync exclusion.
   Pass AC4–AC6 and the existing split, snapshot, outbox, and memory tests.
4. `claude-factory-4z8f.4`, release contract commit, 15 minutes: update contracts, cutover instructions, and one Unreleased changelog bullet.
   Check touched files with Prettier. Run the required test, plugin, typecheck, and format checks on the final SHA.

Use `FACTORY_SELF_UPDATE=0` and fresh `FACTORY_HOME` values in subprocess tests.
Remove inherited `FACTORY_FROM` and `FACTORY_OUTBOX` unless that test explicitly needs them.
Run `bun test --timeout 30000 src factories`, `bunx tsc --noEmit -p .`, and `claude plugin test mod`.
Run `bunx prettier@3.9.9 --check .`, `bun audit`, and the required secret scan before approval.
Do not claim these checks ran at plan; this station changes only this ADR.

## Risk

This change is security-sensitive: remote input, identity, note paths, and infrastructure access cross trust boundaries.
Preserve token scope, mTLS, request limits, sanitization, and durable replay semantics.
Do not put secrets, note bodies, or request credentials in diagnostics.
The server becomes an availability dependency for local memory commands.
Fail closed rather than silently return stale advice or accept a second writable store.
Older clients must not write after cutover. Update both homes before the owner switch.
Existing divergent stores need an explicit reconciliation decision; this change must preserve them, not guess a winner.
The server PVC needs a verified backup before the stale local memory branch stops as a backup source.
Do not remove the local copy or its Git history during cutover.
Security-sensitive: yes (identity, remote input, filesystem paths, infrastructure access)

## Rollout and rollback

1. Resolve the dependency cycle. Keep PR 665 and the live split gate intact until the decision permits progress.
2. Land the API and transport prerequisites, then this change, with green required checks.
3. Upgrade both homes. Stop memory writers and drain pending memory outboxes before the owner switch.
4. Back up both stores. Verify the owner backup and the restore rehearsal.
5. Seed only an empty owner store from the unsplit source. Refuse a different existing store.
6. Persist the owner selection before local writers resume. Retain the local copy as a frozen backup.
7. Obtain explicit approval for any live-system or credential command. No such command runs from this plan.
8. Complete AC7 after the authorized cutover.

There is no new feature flag. Split state selects the owner; an unsplit home keeps local behavior.
For rollback, stop writers and drain outboxes first. Back up the current owner store.
Restore that current store to the unsplit home before the owner selection changes.
Do not reactivate the old local copy; it lacks post-cutover notes and events.
Use a revert pull request for code rollback. A person merges it.
Do not force-push the memory branch or erase either store to resolve a conflict.

## Observability

Use the existing request status, durable replay records, and owner usage log.
Show applied, queued, and refused outcomes distinctly. A failed request must name the operation without note content.
AC7 supplies cross-home search and helped evidence to soak.
The backup restore check supplies durability evidence before cutover.
No new metrics service or polling loop is necessary.
