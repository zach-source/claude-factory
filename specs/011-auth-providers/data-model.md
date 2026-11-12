# Data Model: Pluggable auth providers

The auth state is one file in the factory home. The secrets stay in the password vault. This feature adds no database. In server mode the home is on the pod volume (spec 010).

## Provider (code, `src/auth/providers/<name>.ts`)

| Field | Type | Rule |
| --- | --- | --- |
| name | string | Unique. Examples: `claude`, `codex`, `grok`, `cursor`, `xai`, `openai`, `typesafe`, `linear`. |
| kind | `subscription` \| `session` \| `key` | `subscription` and `session` have a refresh call. `key` has none. |
| harnesses | list of harness names | The harnesses that use this vendor. Example: `codex` for the Codex provider. A key vendor such as Linear can have none (it serves an MCP server or a tool). |
| itemTitle(account) | function | Gives the vault item title of an account. It follows the ccswitch names (research R3). |
| fields | list | The account item fields that the provider reads. The secret fields are marked `secret: true`. |
| live | `{ item, fields, vaultKeys }` | The live item and the agent-vault keys for this vendor. Example: Codex has `CODEX_CHATGPT` and `CODEX_CHATGPT_ACCOUNT`. |
| placeholder | string | The value that a worker VM gets in place of the secret. |
| refresh? | function | Takes the refresh value and gives the new access value, the new refresh value (if rotated) and the expiry. Only for `subscription` and `session`. |
| meter? | function | Gives a meter reading for one account. Optional. |
| patterns | `{ limit: RegExp[], refused: RegExp[] }` | The classify patterns. Each pattern has at least one fixture in `src/auth/fixtures/<name>/`. |
| settings | list of setting keys | Its keys under `auth.<name>.*` (see Settings). |

Rules:

- A provider holds no state. The core holds the state.
- A provider never logs or returns a refresh value except to the core refresh step.

## Account

| Field | Type | Rule |
| --- | --- | --- |
| id | `<provider>:<label>` | Unique. The label is the ccswitch label (an email or a slot name). |
| provider | string | A provider name. |
| label | string | The ccswitch label. |
| item | string | The vault item title (from `itemTitle`). |
| state | `ok` \| `limited` \| `dead` \| `unknown` | See state changes. |
| order | number | The place in the pick order when two accounts have the same room. |
| expiresAt | ms or null | The expiry of the access value. `null` for a key. |
| lastRefresh | ms or null | The time of the last good refresh. |
| limitedUntil | ms or null | Set by a `limit` result or a meter at its limit. |
| deadAt, deadWhy | ms, string | Set when the vendor refuses the refresh value. |
| meter | Meter reading or null | The last reading. |

State changes:

- `unknown` → `ok`: a good refresh or a good meter reading.
- `ok` → `limited`: a meter at or above the launch limit, or a `limit` classify result. `limitedUntil` is the reset time, or now + 30 minutes when no reset time is known (as `MANAGER_LIMIT_UNKNOWN_MS` today).
- `limited` → `ok`: `limitedUntil` is past, and a new meter reading (if the provider has a meter) shows room.
- `ok` or `limited` → `dead`: the vendor refuses the refresh value (FR-010). The core sends one mail.
- `ok` → `refresh` (a step, not a state): a `refused` classify result. If the refresh is good, the state stays `ok`. If the vendor refuses it, the state goes to `dead`.
- `dead` → `unknown`: the person seeds the account again (ccswitch export) or runs `auth.mark --state unknown`.

## Account item (vault, one for each account)

| Field | Secret | Rule |
| --- | --- | --- |
| access value | yes | Access token, session token or key. |
| refresh value | yes | Only for `subscription` and `session`. It never leaves this item (FR-009). |
| expires_at | no | The expiry of the access value. |
| rotated_at | no | New. The time when the core stored the last rotated refresh value. |
| refresh_seq | no | New. A number that the core raises by one at each stored rotation. |
| vendor fields | mixed | Example: the Codex account id, the Grok OIDC issuer and client id. |

The item title follows the ccswitch names (research R3).

## Live item (vault, one for each vendor)

| Field | Rule |
| --- | --- |
| the access field(s) | The access value of the picked account. Agent-vault reads it. |
| active | The label of the picked account. It is not a secret. |
| no refresh field | A live item must not hold a refresh value. Today the Grok item holds `refresh_token`. The migration moves it (research R7). |

Rules:

- The core writes all access fields of one swap in one item edit (FR-015).
- The core writes the live item only after the account item has the current access value.

## Refresh lease (in the auth state)

| Field | Rule |
| --- | --- |
| account | The account id. |
| holder | The holder of the manager lease (spec 010 server lease in server mode, the manager lease in local mode) and the home id. |
| at | The time when the holder took it. |
| ttl | 10 minutes. A holder renews it at each step. A stale lease can be taken. |
| vault copy | A field `refresh_holder` in the account item has the same holder. This stops a second home (laptop and pod) that shares the account (research R4). |

## Meter reading

| Field | Rule |
| --- | --- |
| used | A number from 0 to 1 (a part of the limit). |
| window | `5h`, `7d`, `month`, `week-spend` or the vendor window. |
| resetsAt | ms or null. |
| at | The read time. A reading older than 2 meter periods counts as no reading. |
| source | `headers`, `usage-api`, `spend-log` or `none`. |

A provider can give more than one reading (for example, Claude `5h` and `7d`). The pick uses the highest `used` of the readings.

## Classify result

| Field | Rule |
| --- | --- |
| class | `limit`, `refused` or `none`. |
| provider, account | From the run's harness and the picked account at launch. |
| resetsAt | From the text, when the text has it. Else null. |
| pattern | The id of the pattern that matched, for the run log. |

## Auth state (`<home>/auth-state.json`)

```json
{
  "version": 1,
  "accounts": { "<provider>:<label>": { "state": "ok", "expiresAt": 0, "meter": null } },
  "picked": { "<provider>": "<label>" },
  "leases": { "<provider>:<label>": { "holder": "<home>/<pid>", "at": 0 } },
  "runners": { "<runner>": { "<harness>": { "limitedUntil": 0 } } },
  "manager": { "claude": { "limitedUntil": 0, "kind": "seven_day" }, "codex": { "refusedAt": 0 } },
  "spend": { "grok": [{ "run": "<run>", "usd": 0, "at": 0 }] }
}
```

- The core writes it with `writeJson` under the tick lock, as the other home files today.
- It holds no secret value. A test checks that no field matches the secret shapes of the providers.
- The git home backup takes it, as other home files.

It replaces these files:

| Old file | New place |
| --- | --- |
| `harness-limit-<runner>.json` | `runners.<runner>.<harness>.limitedUntil` |
| `token-swap-<runner>.json`, `token-swap-<runner>-codex.json`, `token-swap-steps.json` | `accounts.*` and the swap history in the run log |
| `cursor-meter.json` | `accounts.cursor:*.meter` |
| `grok-spend.jsonl` | `spend.grok` (rows older than 8 days are dropped) |
| `manager-limit.json` | `manager.claude` |
| `manager-codex-auth.json` | `manager.codex` |
| `claude-switch-backup/factory-limits.json` (local mode) | `accounts.claude:*.limitedUntil` |

## Settings

Each provider has its keys under `auth.<provider>.*`. The settings file of `factory settings` stores them, as today.

| Key | Default | Meaning |
| --- | --- | --- |
| `auth.<p>.accounts` | none | The labels in pick order, separated by spaces. |
| `auth.<p>.launch-limit` | `0.95` | A launch needs `used` under this value. |
| `auth.<p>.refresh-margin` | provider default | Refresh when the access value expires in less than this time. |
| `auth.<p>.meter-every` | `5m` | The meter period. |
| `auth.<p>.live-item` | none | The live item title. |
| `auth.vault` | none | The vault of the account items and the live items. |
| `auth.writer` | none | A shell command that prints the vault writer token, or the env name. It must not be the token value. |

Old names stay as aliases:

| Old key | New key |
| --- | --- |
| `token.live-field`, `token.slot-field`, `token.active-field`, `token.read`, `token.write` | `auth.claude.*` (same meaning) |
| `cursor.cap` | `auth.cursor.launch-limit` (a percent becomes a part) |
| `grok.auth` | `auth.grok.mode` |
| `grok.weeklyBudgetUsd` | `auth.grok.weekly-budget-usd` |
| env `FACTORY_AX_TOKEN_SWAP`, `FACTORY_AX_CODEX_TOKEN_SWAP` | not needed: the core swaps. The env stays read for the rollback. |

## Agent-vault key list

| Field | Rule |
| --- | --- |
| vaultKey | Example: `CODEX_CHATGPT`. From `provider.live.vaultKeys`. |
| item, field | The live item and the field. |
| placeholder | The value in the worker VM. |
| hosts | The vendor hosts that agent-vault adds the key for. |

The core makes this list from the provider list (`auth.keys`). A later step applies it to agent-vault (research R9).
