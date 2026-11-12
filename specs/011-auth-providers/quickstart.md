# Quickstart: check the auth providers

These scenarios show that each user story works.

Run them first with a temporary home and test accounts. Then run them on a copy of the live home. Then run them on the live factory after each migration phase (contracts/migration.md).

## Prerequisites

- A test vault with one test account for each subscription vendor.

- A dummy key for one key vendor.

- ccswitch with the seeder commands (contracts/seeder.md).

- Server mode: the pod of spec 010 and the secret-sync item `factory-vault-writer`.

- Local mode: a laptop home and your own vault sign-in.

## 1. One refresher (user story 1)

1. Set `expires_at` of the test Grok account item to now + 30 minutes.

2. Within 1 minute, `factory auth` shows a new `lastRefresh` for the account. The refresh counter shows `rotated` one time.

3. Read the account item. `refresh_seq` goes up by one. `rotated_at` is not older than `last_refresh`.

4. On a second home that shares the vault, run `factory auth refresh grok <email>`. The command refuses and names the holder.

5. Replace the refresh value in the test item with a revoked one. Within 10 minutes, the account is `dead`. The manager gets one mail (SC-004).

## 2. Pick before a limit (user story 2)

1. Use the fake meter of the test provider (`FACTORY_AUTH_FAKE_METER=claude:a=0.97,claude:b=0.40`).

2. Start a run on a Claude station. The run log shows the account `claude:b`.

3. Set both accounts to 0.99. The run waits. Every front end shows the earliest reset time.

## 3. Classify fixtures (user story 3)

1. Run `bun test src/auth`. Each fixture in `src/auth/fixtures/` gets the class in its header (SC-006).

2. Run `factory auth classify codex < src/auth/fixtures/codex/<case>.txt`. It prints the same class.

## 4. A new provider (user story 4)

1. Add `src/auth/providers/example.ts` (kind `key`, one pattern, one fixture) and its line in the index.

2. Run `factory auth providers`. It lists the example provider.

3. Run `factory auth keys`. It has the example key.

4. Run `factory settings`. It shows `auth.example.*`.

5. Run `git diff --stat`. It shows changes only in the provider file, the index line and the fixture (SC-005).

## 5. Seed from the laptop (user story 5)

1. Run `ccswitch key add xai test`. Give the key on stdin.

2. Run `ccswitch export --to factory Key-xai-test`.

3. Run `factory auth`. It lists `xai:test` with state `unknown`. After the first check, the state is `ok`.

## 6. Plan use (user story 6)

1. Run `factory metrics --tokens`. The "Plan use" section lists each account with its use, window and reset.

2. Open the auth view in the web UI, the Claude mod and the Herdr mod. Each one shows the same rows (SC-007).

## 7. Local mode (user story 7)

1. On a laptop home with no pod, run the local-mode suite of spec 008 and `bun test src/auth` (SC-009).

2. On the laptop, when Claude reaches its limit, ccswitch swaps the account with `ccswitch switch-to`, as today.

## 8. Migration and rollback (user story 8)

1. On a copy of the home, run the phases M1 to M4 of contracts/migration.md for Grok.

2. Run the full rollback. Time it. The rollback must finish in less than 30 minutes (SC-010).

3. The `grok-refresh` CronJob runs again. It refreshes the token. The pod refresh counter does not change.

4. Run a secret scan (`gitleaks dir`) on the home, the backup branch and a VM workspace. The scan finds nothing (SC-008).
