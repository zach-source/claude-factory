# ADR: Hide secret-like rig keys

## Context

Bead: `claude-factory-3wjn`. Base: `9e909c9d`.

`src/rigs-edit.ts:133` checks four key substrings before `rig show` prints JSON.
Plain values under `GITLAB_PAT`, `NPM_AUTH`, `DB_PASS`, and `GH_CREDENTIALS` escape that check.
The bead's security comment also identifies nested keys under `env` and `params` as a leak.

## Decision

Use the existing regex and recursive walk. Add no dependency or parser.
Set `SECRET_KEY` to `/(TOKEN|SECRET|KEY|PASSWORD|PASS|PAT|AUTH|CREDENTIAL|PRIVATE|CERT)/i`.
Preserve the keyed context through objects and arrays below top-level `env` and `params`.
Every property in that context whose key contains a listed substring must become `<hidden>`, regardless of value type.
This is one fail-closed output rule for that key class, at every depth within those two fields.
Keep the existing value-shape checks everywhere else and on unmatched string values.
Keep all source data unchanged; redact only the output copy.

The substring rule intentionally includes `PATH`, `COMPAT`, and `AUTHOR`.
Do not add word boundaries or exceptions for these names.
Outside top-level `env` and `params`, key names alone must not cause redaction.
In particular, `egress[].key` must retain a plain vault key name such as `VAULT_KEY`.

This change adds no input guard, config parser, path resolver, or downstream execution.
The existing JSON input path and CLI grammar remain unchanged.
Unknown secret shapes under unmatched keys remain outside scope.
Key checks outside `env` and `params`, schema validation, and `rig set --env` remain outside scope.

Rejected alternatives:

- Word boundaries: these contradict the requested substring rule and can miss compound key names.
- Hide every value: this would remove useful ordinary values and vault key names.
- Hide non-string values alone: this would obscure safe nested data instead of checking its keys.
- A new helper or dependency: the existing walk and regex can do the work.

Files: `src/rigs-edit.ts`, `src/rigs-edit.test.ts`, and `src/rigs-edit-cli.test.ts`.
Add one release bullet at the end of `CHANGELOG.md` Unreleased when the implementation is complete.
Do not change `.factory/`.

## Acceptance criteria

All test names below start with `3wjn AC` and use synthetic values only.
Proof for AC1 through AC4: `bun test src/rigs-edit.test.ts src/rigs-edit-cli.test.ts`.

### AC1: Hide the whole secret-key class

Add unit test `3wjn AC1 secret key class` in `src/rigs-edit.test.ts`.
Test each new word in both `env` and `params`: `GITLAB_PAT`, `NPM_AUTH`, `DB_PASS`, `GH_CREDENTIALS`, `PRIVATE`, and `CERT`.
Add lowercase `pat`, mixed-case `cErT`, and existing `A_TOKEN`, `N_SECRET`, `api_key`, and `DB_PASSWORD` rows.
Use plain values that match no secret value shape. Every result must equal `<hidden>`.
Add `PATH`, `COMPAT`, and `AUTHOR` rows; their values must also be hidden.
Negative controls `OK` and `base_branch` must retain ordinary values.

### AC2: Preserve context below env and params

Add unit test `3wjn AC2 nested secret keys` in `src/rigs-edit.test.ts`.
Under both fields, test an ordinary object containing `INNER_TOKEN` and an array containing an object with `pat`.
The secret properties must become `<hidden>`; ordinary sibling values must remain unchanged.
Test matching properties with string, number, null, object, and array values; hide the entire value.
Do not infer safety from a value's type or an intervening array.

### AC3: Preserve output boundaries and source data

Add unit test `3wjn AC3 redaction boundaries` in `src/rigs-edit.test.ts`.
Keep `egress: [{ key: 'VAULT_KEY' }]`, ordinary metadata, numbers, and safe array entries unchanged.
Keep a plain `extra.PRIVATE` value unchanged: its key is outside the two protected subtrees.
Keep existing token-shape and URL-userinfo redaction tests green, including values below unmatched keys.
Assert that the original input object equals its pre-call copy after redaction.

### AC4: Prove the CLI output

Extend the existing spawn test in `src/rigs-edit-cli.test.ts` with `3wjn AC4` in its name.
Seed a plain unique value under `env.GITLAB_PAT` in the isolated test home.
For rig name and repo path lookup, require exit 0, valid JSON, and `<hidden>` at that property.
Require empty stderr and absence of the unique value from both output streams.
Keep a plain `egress[].key` value visible. Require byte-identical `rigs.json` and an unchanged history count.
Retain the unknown-rig refusal and worker/patrol show tests.
Use the existing helper that strips factory identity variables and disables self-update.

### AC5: Prove failures before the fix and pass final checks

Commit tests first. Run the proof command against unchanged source and record the expected AC1, AC2, and AC4 failures.
Then change the source and run the same command to completion.
Keep both commits in one PR; never submit a red tests-only head for approval.
After the fix commit, use `factory mutate <file:line> <old> <new> -- <test command>`.
Remove each new regex alternative independently. Each mutant must compile and fail its respective row.
Separately reset keyed context at object descent and array descent. AC2 must kill each mutant.
Mutation exit 0 means the test killed the mutant. Restore the source and check the worktree after each mutation.

Format touched files with `bunx prettier@3.9.9 --write <files>`.
Run `bun run test`, `bunx tsc --noEmit -p .`, and `bunx prettier@3.9.9 --check .`.
Run `gitleaks detect --log-opts=origin/main..HEAD` and `bun audit`.
Required final-head CI checks: `test`, `plugin`, `typecheck`, and `format`.
Report local tool gaps separately; do not weaken tests or claim unrun checks passed.

## Risk

This is security-sensitive secret redaction.
The wider substring rule hides more ordinary output, including `PATH`; stored values do not change.
Nested redaction fixes the issue in the bead's security comment without a schema change.
No data migration, credential change, production access, or new permission applies.
Unknown secret shapes outside the key class remain a documented limit.
Security-sensitive: yes (secrets)

## Rollout and rollback

Use one draft PR for tests and source changes. Require review and security before a person merges it.
No flag or migration order applies. This fix does not depend on `rig set --env`.
Release through the normal ship path after merge.
Rollback uses a revert PR for a person to merge; never push the default branch directly.
A revert restores the leak, so prefer a narrow fix forward for output compatibility problems.

## Observability

No new metrics or logs apply; do not log secret values.
The ship soak can repeat AC4 with synthetic data in a disposable home through the released executable.
Check exit status, parsed JSON, secret absence, and unchanged fixture bytes.
Do not read the live rig configuration for this check.
No AC is must-see-live; final-head tests prove the output rule without production access.

## Tasks

1. T1 (`claude-factory-3wjn.1`): Add AC1 through AC4 tests. Commit tests and record expected failures against unchanged source.
2. T2 (`claude-factory-3wjn.2`): Extend the regex and preserve keyed context. Add the release bullet and complete AC5 checks.

T2 depends on T1. Both tasks fit one 120-minute implementation pass and one PR.
