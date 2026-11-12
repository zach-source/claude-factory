# Contract: the auth operations in the catalog

Covers FR-013 to FR-016 and FR-022 to FR-024. These operations go into `src/core/catalog.ts` as `local` operations in `src/core/ops/auth.ts`. They follow the catalog rules. The name is `<group>.<verb>` with `^[a-z]+\.[a-z]+$`. The route starts with `/v1/`. A changing operation must have `Idempotency-Key` (spec 008 contracts/catalog.md).

| Operation | CLI | Route | Rights | Changes |
| --- | --- | --- | --- | --- |
| `auth.providers` | `factory auth providers` | `GET /v1/auth/providers` | read | no |
| `auth.accounts` | `factory auth` | `GET /v1/auth/accounts` | read | no |
| `auth.meters` | `factory auth meters` | `GET /v1/auth/meters` | read | no |
| `auth.keys` | `factory auth keys [--format agent-vault]` | `GET /v1/auth/keys` | read | no |
| `auth.pick` | `factory auth pick <provider>` | `POST /v1/auth/:provider/pick` | manager | yes (the live item, when the pick changes) |
| `auth.swap` | `factory auth swap <provider> <label>` | `POST /v1/auth/:provider/swap` | owner | yes |
| `auth.mark` | `factory auth mark <provider> <label> <state>` | `POST /v1/auth/:provider/mark` | owner | yes |
| `auth.refresh` | `factory auth refresh <provider> <label>` | `POST /v1/auth/:provider/refresh` | owner | yes, `long` |
| `auth.seed` | `factory auth seed` (ccswitch uses this command) | `POST /v1/auth/seed` | owner | yes |
| `auth.classify` | `factory auth classify <provider> < text` | `POST /v1/auth/classify` | read | no |
| `auth.capture` | `factory auth capture <run>` | `POST /v1/auth/capture` | owner | yes (a fixture file in the worktree, not in the home) |

- `auth.classify` changes nothing. It is POST only because it takes a body, as `guard.check` does.
- The old commands stay as aliases until the migration ends:
  - `factory token [list|use|best]` uses `auth.accounts`, `auth.swap` and `auth.pick` for `claude`.
  - `factory unhold <runner> [--codex]` uses `auth.mark ... ok` for the accounts of that runner.

## Outputs

`auth.accounts` returns this (no secret value):

```json
{
  "accounts": [
    {
      "id": "codex:<email>",
      "provider": "codex",
      "state": "ok",
      "picked": true,
      "expiresAt": 0,
      "lastRefresh": 0,
      "limitedUntil": null,
      "holder": "<home id>",
      "meter": [{ "window": "7d", "used": 0.41, "resetsAt": 0, "at": 0 }]
    }
  ],
  "vault": "ok"
}
```

`auth.keys` returns the agent-vault key list (data-model.md). With `--format agent-vault`, the CLI prints the configuration patch. A person applies the patch. The patch holds item and field names, not values.

## Pick rules (`auth.pick` and each launch)

1. Take the accounts of the provider with state `ok`, or with state `limited` and `limitedUntil` in the past.
2. Take out each account whose load is at or above `launch-limit`. The load is the highest `used` of its fresh indications.
3. Sort by load, low first. Accounts with no indication go after the accounts with indications, in `auth.<p>.accounts` order.
4. Keep the current account when its load is less than the best load plus 0.10 (hysteresis, from ccswitch). Change the picked account at most one time in 5 minutes for each provider (cooldown, from ccswitch).
5. If no account is left, hold the runs that must use the provider. Return the earliest `limitedUntil` or `resetsAt`.

## Front ends

Each front end shows `auth.accounts` and `auth.meters`. The views are a table in the web UI, `factory auth` in the CLI, a tab in the Claude mod and a tab in the Herdr mod. A front end that cannot show the table shows one line instead. For example, the status band shows that line. The line names the worst provider and links to `factory auth`. If a front end does not get the views in the same change, the PR files one bead for each gap (constitution Principle II).
