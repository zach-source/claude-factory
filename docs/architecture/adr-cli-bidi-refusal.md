# ADR: Refuse unsafe Unicode in proposal and bead text

## Context

Bead: `claude-factory-k173`. Base: `18a9a04b`.

`src/cli.ts:941` checks Unicode Cc only.
`fileElsewhere` checks titles and descriptions before its first bd call at `src/cli.ts:12253`.
`decisionsPropose` checks questions, contexts, and ordinary options at `src/cli.ts:12928`.
These paths accept bidi overrides and isolates, which can change the text that a person sees.
The bead's security comment also puts U+2028 and U+2029 in scope.
`textFileArg` calls `trimEnd()` at `src/cli.ts:937`; this can remove those separators before validation.

Plan ran the two current suites at the base: 54 tests passed, with 469 assertions.
No new regression tests or source changes form part of this plan commit.

## Decision

Extend the existing text guard in `src/cli.ts` with the explicit class:
U+202A through U+202E, U+2066 through U+2069, U+2028, and U+2029.
Call this class B below. It contains 11 code points.

The fail-closed rule rejects any consumed field with a member of B or a prohibited Unicode Cc character.
The sole Cc exceptions are LF and tab within descriptions.
Apply the rule before option parsing, bd calls, or proposal writes.
Reject unsafe text; do not replace or delete unsafe characters to accept the request.
Keep the current safe error format: field, hexadecimal code point, and index, without raw input.

Check B in file contents before `trimEnd()` can remove U+2028 or U+2029.
Keep the current trailing-whitespace convention for safe files, including their final LF.
Use a small, scoped extension to `textFileArg` for its two affected callers if necessary.
Do not change the text policy for mail or memory, which also use this helper.
Keep current path, size, grammar, worker, and patrol checks.

Consumed fields are title and description for `file-elsewhere`, and question, context, and ordinary option text for `decisions propose`.
For `own:` keys, question and context remain subject to the rule.
Caller options for `own:` keys remain unused and unchecked; never read their options file.
Keep the fixed options `start now` and `not now`.

This change adds no parser for another tool's input.
The existing CLI grammar remains closed: reject unknown flags, duplicate flags, mixed positional/file forms, and missing required fields.
File-elsewhere accepts exactly target, `--from`, one title form, and one description form.
Its text flags are `--title`, `--title-file`, `--description`, and `--description-file`.
Propose accepts its current positional form with optional `--context`, or its file form.
The file form accepts `--question-file`, `--options-file`, and optional `--context-file`; `own:` does not need options.
File paths must resolve within `<FACTORY_HOME>/text/` or the real worktree `.scratch/` under the current path checks.
Symlink escapes, non-files, oversized files, and paths outside those roots remain denied.
Invalid requests make zero bd calls and no proposal writes. Local path checks can still call git.

Out of scope: decision keys, rig names, extra-argument error text, other CLI verbs, stored historical text, and general Unicode normalization.
Other Cf characters, including ZWJ, remain permitted under the existing field rules.
Related beads `claude-factory-7dz7` and `claude-factory-ag58e` cover separate paths and do not block this change.

Rejected alternatives:

- Reject all Cf: this would reject valid ZWJ emoji.
- Reuse a sanitizer: silent text changes can change a person's choice.
- Check only parsed options: parsing can remove unsafe separators before the check.
- Change every `textFileArg` consumer: this would widen scope to mail and memory.
- Add a dependency or new validator module: the platform regex support and current helper are sufficient.

## Acceptance criteria

### AC1: Refuse unsafe bead text before bd

Add tests named `k173 AC1` in `src/file-elsewhere-cli.test.ts`.
For every B code point, test title and description through both literal and file arguments.
Use interior characters plus leading and trailing U+2028/U+2029 rows, with nonempty safe text beside them.
Each row must exit 1 and make zero bd calls, including lookup, create, and comment.
Assert the hexadecimal code point in stderr and no raw B character in stdout or stderr.
Retain the existing ESC, CR, DEL, C1, file NUL, title LF, and title tab refusals.

Proof: `bun test --timeout 30000 src/file-elsewhere-cli.test.ts`.

### AC2: Refuse unsafe proposals without state changes

Add tests named `k173 AC2` in `src/decisions.test.ts`.
Test every B code point in question and context for `bd:`, `iv:`, and `own:` keys.
Cover positional arguments and file inputs.
For ordinary keys, test every B code point in option labels and effects, through positional and file inputs.
Include leading and trailing U+2028/U+2029, and separators adjacent to option delimiters.
Each row must exit 1 and leave an existing `decisions.json` byte-identical.
Also prove representative B failures leave an absent `decisions.json` absent.
Count every fake bd invocation, including list and ready; each invalid request must make zero calls.
Exclude fixture setup from these counters.
Assert the code point in stderr and no raw B character in either output stream.
Retain existing Cc, length, empty-field, option-count, worker, patrol, gate, and prompt refusals.

Proof: `bun test --timeout 30000 src/decisions.test.ts`.

### AC3: Preserve valid text and owner options

Add tests named `k173 AC3` in both suites.
Accept accented text, ordinary RTL letters, and a valid emoji sequence with U+200D ZWJ in every consumed field.
Check that the filed or stored value retains this text.
Descriptions must preserve interior LF and tab; one-line fields must still reject interior LF and tab.
Safe file inputs with a final LF must retain current success and trim behavior.
For `own:`, unsafe caller options must remain ignored in positional form.
An absent or unreadable options file must remain unread for `own:`.
Assert exactly `start now` and `not now` in the stored options.
The existing malformed grammar and file-path tests must pass without weaker assertions.

Proof: `bun test --timeout 30000 src/file-elsewhere-cli.test.ts src/decisions.test.ts`.

### AC4: Prove the regression and complete checks

First run the new tests against unchanged source and record the expected failures.
Then apply the fix and record the same tests as green.
After the fix commit, use `factory mutate <file:line> <old> <new> -- <test command>` for targeted mutations.
Independently remove the bidi override range, isolate range, and separator pair; each mutant must compile and fail its relevant tests.
Also bypass the pre-trim B check; the trailing-separator rows must fail.
Use the AC3 command as the test command. Mutation exit 0 means the tests killed the mutant.
Tests and fix must share one PR. Do not present a red tests-only head for approval.

Run these repo checks on the complete change:

```sh
bun run test
bunx tsc --noEmit -p .
bunx prettier@3.9.9 --check .
gitleaks detect --log-opts=origin/main..HEAD
bun audit
```

Format touched files with Prettier 3.9.9 first.
CI uses `tsc --noEmit -p .`; it omits `tsc -p mod` because clean checkouts lack engine types.
The required CI checks are `test`, `plugin`, `typecheck`, and `format` on the final PR head.
Report any local tool gap and cite exact-head CI evidence.

## Risk

This is security-sensitive input validation for text that a person uses to make decisions.
The intended compatibility change rejects the 11 new code points in consumed fields.
A broad Cf refusal would break emoji. A global file-helper change would alter unrelated commands.
Pre-trim checks must not reject the existing safe final-LF convention.
No schema, database, credential, or stored-data migration applies.
Historical unsafe text remains unchanged; this plan covers new CLI requests only.
Security-sensitive: yes (input validation)

## Rollout and rollback

Use one draft PR for both tasks. A person must merge after verify, review, and security.
Use the normal CLI release path. No flag or migration order applies.
Rollback uses a revert PR for a person to merge; it restores this validation gap.
Prefer a fix forward if a valid-text regression appears.
No owner-only live change is necessary for this fix.

## Observability

No new metrics or raw-input logs are necessary.
The CLI exit code, safe error code point, fake bd call count, and unchanged proposal file prove the refusal.
Ship soak can run AC1 through AC3 against the released revision with a disposable home and fake bd.
Record the released SHA and results. Never submit hostile text to real beads or the live proposal store.
No AC is must-see-live; isolated CLI tests and exact-head CI prove the behavior before merge.

## Tasks

1. `claude-factory-k173.1`: Add AC1 through AC3 tests in the two existing test files. Commit after the expected pre-fix failures.
2. `claude-factory-k173.2`: Extend the guard and scoped file-input check in `src/cli.ts`. Complete AC1 through AC4 and commit the fix.

Task 1 blocks task 2. Both fit one 120-minute implementation pass and one PR.
Plan commits only this ADR. Implement needs no new source files, dependencies, or factory definition changes.
