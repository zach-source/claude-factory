# Quickstart: check the auth providers

These scenarios prove each user story. Run them first with a temporary home and test accounts, then on a copy of the live home, then on the live factory after each migration phase (contracts/migration.md).

## Prerequisites

- A test vault with one test account for each subscription vendor, and a dummy key for one key vendor.
- ccswitch with the seeder commands (contracts/seeder.md).
- Server mode: the pod of spec 010, and the secret-sync item `factory-vault-writer`. Local mode: a laptop home and your own vault sign-in.

## 1. One refresher (user story 1)

1. Set `expires_at` of the test Grok account item to now + 30 minutes.
2. Within 1 minute, `factory auth` shows a new `lastRefresh` for it. The refresh counter shows `rotated` one time.
3. Read the account item: `refresh_seq` went up by one, and `rotated_at` is not older than `last_refresh`.
4. On a second home that shares the vault, run `factory auth refresh grok <email>`. It refuses and names the holder.
5. Replace the refresh value in the test item with a revoked one. Within 10 minutes the account is `dead`, and the manager has one mail (SC-004).

## 2. Pick before a limit (user story 2)

1. Use the fake meter of the test provider (`FACTORY_AUTH_FAKE_METER=claude:a=0.97,claude:b=0.40`).
2. Start a run on a Claude station. The run log shows the account `claude:b`.
3. Set both to 0.99. The run waits, and every front end shows the earliest reset time.

## 3. Classify fixtures (user story 3)

1. Run `bun test src/auth`. Each fixture in `src/auth/fixtures/` gets the class in its header (SC-006).
2. Run `factory auth classify codex < src/auth/fixtures/codex/<case>.txt`. It prints the same class.

## 4. A new provider (user story 4)

1. Add `src/auth/providers/example.ts` (kind `key`, one pattern, one fixture) and its line in the index.
2. `factory auth providers` lists it. `factory auth keys` has its key. `factory settings` shows `auth.example.*`.
3. `git diff --stat` shows changes only in the provider file, the index line and the fixture (SC-005).

## 5. Seed from the laptop (user story 5)

1. `ccswitch key add xai test` (the key on stdin), then `ccswitch export --to factory Key-xai-test`.
2. `factory auth` lists `xai:test` with state `unknown`, then `ok` after the first check.

## 6. Plan use (user story 6)

1. Run `factory metrics --tokens`. The "Plan use" section lists each account with its use, window and reset.
2. Open the auth view in the web UI, the Claude mod and the Herdr mod. All show the same rows (SC-007).

## 7. Local mode (user story 7)

1. On a laptop home with no pod, run the local-mode suite of spec 008 and `bun test src/auth` (SC-009).
2. A Claude limit on the laptop swaps the account through `ccswitch switch-to`, as today.

## 8. Migration and rollback (user story 8)

1. On a copy of the home, run the phases M1 to M4 of contracts/migration.md for Grok.
2. Run the full rollback. Time it (less than 30 minutes, SC-010). The `grok-refresh` CronJob runs again and refreshes the token. The pod refresh counter does not change.
3. Run a secret scan (`gitleaks dir`) on the home, the backup branch and a VM workspace. It finds nothing (SC-008).
