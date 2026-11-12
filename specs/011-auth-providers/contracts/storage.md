# Contract: vault items, live items and the agent-vault key list

Covers FR-009, FR-015, FR-021 and FR-027. Research R3, R7 and R9 give the reasons.

## Account items (one for each account)

| Provider | Title (`<ItemPrefix> - <key>`) | Secret fields | Plain fields |
| --- | --- | --- | --- |
| claude (token) | `Claude-Token-<email>` | the token | `expires_at`, `refresh_holder`, `refresh_seq` |
| claude (oauth) | `Claude Code-Account-<id8>-<email>` | the ccswitch blob (access and refresh) | as above, plus `rotated_at` |
| codex | `Codex-Token-<email>` | the `auth.json` blob (access, refresh, id token) | `account_id`, `expires_at`, `refresh_holder`, `refresh_seq`, `rotated_at` |
| grok | `Grok-Session-<email>` | `access_token`, `refresh_token` | `oidc_issuer`, `oidc_client_id`, `expires_at`, `last_refresh`, `refresh_holder`, `refresh_seq`, `rotated_at` |
| key vendors | `Key-<vendor>-<label>` | `credential` | `added_at` |

- `<ItemPrefix>` is the ccswitch prefix setting. The core reads it from `auth.item-prefix`, with the ccswitch default.
- The core reads a blob from a Document or from the `credentials` field. It writes back in the same shape (research R3).
- The core and ccswitch never write a secret value through argv. They use stdin or the Connect API body.

## Live items (one for each vendor)

| Provider | Live item fields | Agent-vault key |
| --- | --- | --- |
| claude | the live token field (`token.live-field`), `active` | `ANTHROPIC` |
| codex | access token, account id, `active` | `CODEX_CHATGPT`, `CODEX_CHATGPT_ACCOUNT` |
| grok | `access_token`, `email`, `active` | `GROK_SESSION` |
| cursor, xai, openai, typesafe, linear | `credential`, `active` | `CURSOR_API_KEY`, `XAI_API_KEY`, `OPENAI`, `TYPESAFE`, `LINEAR` |

Rules:

- A live item has no refresh field. The migration removes `refresh_token` from today's Grok item. It also removes the Claude slot fields from the Claude live item (contracts/migration.md).
- A swap writes all fields of one live item in one edit. Agent-vault sees the old set or the new set, never a mix.
- `active` holds the label, not a secret. The status shows it.

## Worker VMs

The VM gets the `placeholder` env of each provider of its harness (today `ax.ts:687-720`). The gateway puts in the value from agent-vault. A VM never gets a value from an account item or a live item. `token-guard.ts` and the seatbelt rules stay as they are.

## The agent-vault key list (`auth.keys`)

```json
{
  "vault": "<agent-vault vault>",
  "keys": [
    {
      "key": "CODEX_CHATGPT",
      "provider": "codex",
      "item": "<live item title>",
      "field": "<field>",
      "hosts": ["chatgpt.com/backend-api/codex/"],
      "placeholder": "placeholder"
    }
  ]
}
```

- `ax.ts` builds `egressPolicy`, `managerEgress` and the placeholder env from this list. Thus a new provider gets its egress rule with no edit of `ax.ts`.
- The step that writes this list into the agent-vault configuration is a later step. It needs agent-vault as a managed GitOps object. Today it is a bare pod. Until then, `factory auth keys --format agent-vault` prints the patch. A person applies it.
