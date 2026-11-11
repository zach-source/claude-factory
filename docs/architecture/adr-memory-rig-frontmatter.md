# ADR: Refuse ambiguous rig metadata in memory notes

## Context

Bead: `claude-factory-u509`. Original plan base: `ec5b4fff`. Revised plan base: `62deb0dc`.

`src/memory.ts:82` accepts only LF frontmatter without a BOM.
Its metadata map keeps the last duplicate key.
An unread rig becomes shared metadata. Search and VM snapshots can then expose the note to another rig.
The bead reports no affected notes in its 2026-11-06 store copy.
This plan does not claim that the current live store has no affected notes.

No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in this checkout.
Use the supplied worker rules, package scripts, and `.github/workflows/ci.yml`.

The plan resumed after four implement rounds. The original body-isolation rule missed a legacy delimiter ambiguity.
The old parser read `---\n---\nrig: other\n---\nbody` as scoped metadata.
The empty-header fix changed that note to shared scope. Security required a conservative exception.
Commit `cd77518f` implements that exception. This revision defines it and replaces the conflicting body-isolation promise.
The current six focused tests pass, but the empty-header cases lack direct topic README coverage.
Finish with one test commit. Do not redesign the parser or repeat completed fixes.

## Decision and grammar

One rule governs short-note scope: a rig declaration must be unique and canonical, or the note must fail closed.
A parse failure must never convert a rig declaration into shared scope.

Use the current line-based format. Do not add YAML or another dependency.
Accept LF and CRLF line ends, including mixed line ends, and one optional BOM at byte zero.
Normalize only the parser input view. Do not rewrite the source file or snapshot payload.

The accepted header starts at offset zero after the optional BOM.
Its delimiters are complete `---` lines without spaces. The closing delimiter can end at EOF.
The header contains the existing scalar fields: `summary`, `rig`, `from`, `at`, `kind`, `until`, and `superseded`.
Keep the existing interpretation of fields other than `rig`, including ignored unknown keys.
Field values remain literal text; do not interpret YAML quotes, comments, escapes, aliases, lists, or objects.
The current parser does not claim general YAML support.

A canonical rig declaration has the form `rig:` at column zero, then optional spaces or tabs, then a nonempty value.
The value must contain non-whitespace text. Preserve the existing literal value semantics for valid notes.
A rig-like declaration is a line that matches `^[ \t]*rig[ \t]*:` without case sensitivity.
The scan region is the complete header when a valid header exists.
Without a valid header, scan the complete text. Do not add a line-count cutoff that padding can bypass.
After a populated header, body lines remain prose and cannot change scope.
An empty header has one compatibility exception, defined below.

For an empty header, locate the first subsequent complete `---` line in the normalized text.
The line can end at EOF. Spaces around that delimiter do not count.
If it exists, inspect only the lines between the empty header and that delimiter.
If any line matches the rig-like grammar, reject the note for every query rig.
This rule includes canonical, malformed, empty, and duplicate declarations. Do not assign any declaration from this region as metadata.
If no subsequent delimiter exists, the body cannot change scope.
If the region has no rig-like line, preserve shared scope. Do not scan past that first subsequent delimiter.
Thus `---\n---\nrig: other\n` stays shared, but `---\n---\nrig: other\n---` fails closed.
The note `---\n---\nbody\n---\nrig: other\n---\n` stays shared.
Apply the same rule to short notes and topic `README.md` files.

Reject any rig-like declaration outside the canonical form in that scan region.
Reject duplicate declarations, even equal values, mixed-case duplicates, and a valid declaration beside a malformed declaration.
Reject empty or whitespace-only rig values.
Without a valid header, reject every rig-like declaration in the text.
With no declaration in the scan region, preserve shared notes, including legacy plain notes without frontmatter.

Use a reserved nonempty invalid-rig sentinel within the existing `Note.rig` representation.
Explicitly reject that sentinel in `rank()` and the snapshot predicate before scope equality checks.
Do not rely on a rig name that seems unlikely: even a query equal to the sentinel must reject the note.
An omitted rig must also reject invalid notes. Preserve its current behavior for valid scoped notes.
No new flag, migration, persistent quarantine store, or public API is necessary.

This parser reads note text, not executable input. It reads no path syntax from metadata.
Preserve existing snapshot path and symlink checks.
Rejection means zero rank callbacks for the rejected note and zero snapshot payload copies for that note.
A mixed snapshot can still invoke tar for valid notes. Do not require zero tar calls for an otherwise valid snapshot.

Out of scope: CORE section grammar, LONG entry JSON grammar, general YAML, Unicode lookalike keys, and arbitrary prose intent.
Quoted keys, flow maps, bare-CR line ends, and non-colon declarations are not supported rig syntax.
Do not expand this change into a new document validator.

Expected files: `src/memory.ts`, `src/memory.test.ts`, `src/memory-snapshot.test.ts`, and `CHANGELOG.md`.
The release station appends one bullet at the end of Unreleased. Implement must not add that bullet.
Do not change `.factory/` or factory definitions.

Rejected alternatives:

- Accept only exact writer output: CRLF and BOM notes still lose scope.
- Normalize every key: ambiguous hand edits gain authority, and duplicate precedence remains unsafe.
- Use only a sentinel: `rank()` currently accepts every rig when the query omits its rig.
- Scan a fixed prefix: padding moves an unread declaration beyond the guard.
- Scan every body: examples such as `rig: other` would suppress correctly scoped notes.
- Ignore all empty-header bodies: legacy scoped notes can become shared. Use the bounded compatibility exception instead.
- Use a YAML library: its grammar changes literal field semantics and exceeds this fix.

## Acceptance criteria

Use `u509` in all new test names. This command proves AC1 through AC4:

```text
bun test --timeout 30000 src/memory.test.ts src/memory-snapshot.test.ts -t u509
```

AC1. `u509 parse scope matrix` must cover all six reported forms through `parse()` and `rank()`.
Use query rig `acme` and source rig `other`.
The six rows are CRLF, BOM, indented key, capital key, no header with a body declaration, and duplicate keys.
For the duplicate row, use `rig: other` followed by `rig: acme`.
No row can return the note to `acme`.
CRLF and BOM rows must retain `other` and remain available to `other`.
Also accept BOM plus CRLF, mixed LF/CRLF, and a closing delimiter at EOF.
Canonical `acme` and shared notes must remain available to `acme`; canonical `other` must remain denied.

AC2. `u509 ambiguous scope is closed` must reject the full class, not only the six examples.
Cover tabs, mixed case, whitespace before the colon, equal duplicates, reverse duplicates, and mixed canonical/malformed duplicates.
Cover empty values, whitespace-only values, a missing closing delimiter, and a declaration after 100 prefix lines without a header.
Test each rejected note with `acme`, `other`, no query rig, and a query equal to the invalid sentinel.
Each result must be empty. Instrument `vec`, `topicVec`, and `act`; assert zero calls for rejected notes.
A shared note without declarations must remain allowed. A populated header must isolate body declarations from metadata.

AC3. `u509 snapshot scope matrix` must cover AC1 and AC2 through actual snapshot archives.
Use regular short-note paths such as `ci/case.md` and topic `README.md` paths.
For `acme`, inspect archive names and extracted bytes; no denied path or unique denied body marker can occur.
Seed `.index.json` and `.usage.jsonl`; assert that neither contains denied paths in the extracted snapshot.
Repeat invalid-note checks with no rig and with a query equal to the invalid sentinel.
Include valid shared and same-rig notes so exclusion cannot pass through an empty archive alone.
Compare retained source files byte for byte, including CRLF and BOM notes scoped to `acme`.
Existing LONG, CORE, symlink, nested-path, and no-rig snapshot controls must stay green.

AC4. `u509 writer compatibility` must preserve canonical metadata and body text across `parse(format(note))`.
Include `from: a/x, b/y`, all existing optional fields, a shared note, and body `## ` headings.
Include literal `rig: other` in a body after a valid header; it must not override or invalidate that header.
Retain `parseLong(formatLong(entries))` controls with multiple rigs and `## ` body headings.
Do not require byte equality across serialization; assert field and body equality for writer-shaped input.

AC5. The final implementation head must pass the repository checks:

```text
bun test --timeout 30000 src factories
bunx tsc --noEmit -p .
claude plugin test mod
bunx prettier@3.9.9 --check .
bun audit
gitleaks detect --log-opts=origin/main..HEAD
```

Run the implement station gate. Required CI checks are test, plugin, typecheck, and format on the final head.
`bun run typecheck` also checks `mod`; CI omits that part because its generated types need a live Claude session.
Record unavailable local checks and exact-head CI evidence. Never weaken a required check.
The final pull request must contain the tests and fix together, with no deliberately red final checks.

AC6. `u509 empty header` tests must prove the compatibility exception through rank and snapshot.
Use both `ci/case.md` and a topic `README.md` for every row.
Cross LF, CRLF, mixed line ends, BOM plus LF, and BOM plus CRLF with these cases:

- Denied: canonical `rig: other`, canonical `rig: acme`, capital, indented, blank, and duplicate declarations before the next delimiter.
- Allowed shared: an empty header at EOF; body declarations without another delimiter; declarations only after the next delimiter.
- Allowed scoped: a populated `rig: acme` header with each body declaration form and later delimiters.

Test the next delimiter with a newline and at EOF. A line with spaces around `---` is not a delimiter.
For denied rows, query `acme`, `other`, no rig, and the invalid sentinel. Assert zero rank callbacks.
For allowed shared rows, each query retains the note. Scoped controls retain the existing query semantics.
Extract archives and check denied paths, body markers, index entries, and usage entries; compare allowed file bytes.
Run the AC1 command. Both current empty-header tests and all other `u509` tests must stay green.
This extends the existing tests; no new fixture file or test framework is necessary.

## Test plan

Implement must commit the regression tests first and record failures against the parent code.
Use deterministic vectors and fixture archives; the focused tests must need no model download or live memory store.
Write fixtures under disposable test directories. Never alter the live store.
Then commit the minimal fix in the same pull request. The release station owns the changelog bullet.
After that commit, use `factory mutate` to remove each independent refusal or normalization branch.
Run the relevant focused test for each mutation. Record exit 0 as killed; mutants must still compile.
Preserve explicit sentinel refusal tests, because equality and absent-rig branches can otherwise bypass rejection.

For this resumed plan, retain the completed test and fix commits. Do not manufacture a red final head.
Extend AC6 first; current production code should pass. Then prove the new rows catch the former defects with mutations.
Remove `gapRig ||` to test disclosure. Scan the complete gap to test over-refusal past the first delimiter.
Scan the whole body after an empty header to test over-refusal without a later delimiter.
Commit before each mutation check, restore the source, and confirm a clean worktree afterward.
No production edit is necessary unless the matrix identifies a failure within this exact grammar.

## Risk

This change is security-sensitive input parsing at the boundary between rig scopes.
Malformed hand-edited notes can disappear from search and snapshots. Their source files remain intact.
A plain legacy note with a rig-like body line will now fail closed, even far below its first line.
This conservative case has no reliable header boundary. Add canonical frontmatter to make the intended scope explicit.
Populated headers preserve body examples. Empty headers use the explicit compatibility exception.
That exception can suppress a hand-written body example before a later delimiter. The source file remains intact.
This intentional refusal resolves ambiguous old scope; it does not widen access.
Writer output and unambiguous shared notes keep their prior behavior.
No data migration, credential change, infrastructure access, or production write is part of this run.
No new production regression is known; no made-worse dependency is necessary.
Security-sensitive: yes (memory input parsing and rig isolation)

## Rollout and rollback

Use the normal draft pull request, verify, review, security, and human merge path.
Deploy the merged code through the normal ship run. No flag or migration order is necessary.
The next search and snapshot parse the source notes again; no vector-index rebuild is necessary for scope enforcement.
Existing VM snapshots do not change retroactively. Fresh launches must receive snapshots from the fixed factory version.
Do not promise that this patch removes notes from already-issued VM archives.
Rollback requires a revert pull request and a human merge. It restores the prior exposure risk.
Do not delete or rewrite memory notes as part of rollback.

## Observability

No new metric or log is necessary. Unit scope matrices and extracted archive checks provide the direct evidence.
The ship soak can run the focused matrix from the deployed revision against scratch fixtures.
Record the deployed revision and matrix result. Do not put private note content in logs or reports.
No AC is must-see-live. No live store, pod, database, or private service read gates this merge.

## Tasks

Tasks `claude-factory-u509.1` through `.6` are closed. Preserve their commits and evidence.
The release station owns the changelog entry, as task `.5` records.

1. `claude-factory-u509.7`: Extend AC6 tests for short notes and topic README files. Check: focused command and three mutations.

Task `.7` follows completed task `.6`.
One test commit fits one 120-minute implement pass in existing draft PR #862.
Run AC5 on the final head, then return to verify, review, and security. No new pull request is necessary.
The plan station commits only this ADR. Child beads record the implementation tasks.
