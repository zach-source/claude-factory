# ADR: Refuse ambiguous rig metadata in memory notes

## Context

Bead: `claude-factory-u509`. Plan base: `ec5b4fff`.

`src/memory.ts:82` accepts only LF frontmatter without a BOM.
Its metadata map keeps the last duplicate key.
An unread rig becomes shared metadata. Search and VM snapshots can then expose the note to another rig.
The bead reports no affected notes in its 2026-11-06 store copy.
This plan does not claim that the current live store has no affected notes.

No repository CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in this checkout.
Use the supplied worker rules, package scripts, and `.github/workflows/ci.yml`.

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
After a valid closing delimiter, body lines remain prose and cannot change scope.

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
Append one bullet at the end of Unreleased. Do not change `.factory/` or factory definitions.

Rejected alternatives:

- Accept only exact writer output: CRLF and BOM notes still lose scope.
- Normalize every key: ambiguous hand edits gain authority, and duplicate precedence remains unsafe.
- Use only a sentinel: `rank()` currently accepts every rig when the query omits its rig.
- Scan a fixed prefix: padding moves an unread declaration beyond the guard.
- Scan valid bodies: examples such as `rig: other` would suppress correctly scoped notes.
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
A shared note without declarations must remain allowed. A valid header must isolate body declarations from metadata.

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

## Test plan

Implement must commit the regression tests first and record failures against the parent code.
Use deterministic vectors and fixture archives; the focused tests must need no model download or live memory store.
Write fixtures under disposable test directories. Never alter the live store.
Then commit the minimal fix and the changelog bullet in the same pull request.
After that commit, use `factory mutate` to remove each independent refusal or normalization branch.
Run the relevant focused test for each mutation. Record exit 0 as killed; mutants must still compile.
Preserve explicit sentinel refusal tests, because equality and absent-rig branches can otherwise bypass rejection.

## Risk

This change is security-sensitive input parsing at the boundary between rig scopes.
Malformed hand-edited notes can disappear from search and snapshots. Their source files remain intact.
A plain legacy note with a rig-like body line will now fail closed, even far below its first line.
This conservative case has no reliable header boundary. Add canonical frontmatter to make the intended scope explicit.
Valid headers preserve body examples. Writer output and valid shared notes keep their prior behavior.
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

1. `claude-factory-u509.1`: Commit AC1 through AC4 regression tests first. Check: focused command, with recorded failures on parent code.
2. `claude-factory-u509.2`: Commit the parser fix, explicit consumer refusals, and changelog bullet. Check: AC1 through AC5 and branch mutations.

Task 2 depends on task 1. Both fit one 120-minute implement pass and one pull request.
The plan station commits only this ADR. Child beads record the implementation tasks.
