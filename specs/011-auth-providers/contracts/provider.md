# Contract: the provider interface

Covers FR-001 to FR-004, FR-012 and FR-016. A provider is one file in `src/auth/providers/`. `src/auth/providers/index.ts` lists the providers. To add a provider, do these steps:
1. Add one file.
2. Add one line to the index.
3. Add its fixtures and its tests.

## Shape

```ts
type Kind = 'subscription' | 'session' | 'key'

type Provider = {
  name: string                    // ^[a-z]+$ ; it is the first part of an account id
  kind: Kind
  harnesses: Harness[]            // may be empty (a manager tool key, such as linear)
  item: {
    title(label: string): string  // the ccswitch name, research R3
    secret: string[]              // the secret field names in the account item
    plain: string[]               // the other fields (expires_at, account id, issuer)
  }
  live: {
    vaultKeys: { key: string; field: string; hosts: string[] }[]  // SCREAMING_SNAKE_CASE keys
    placeholder: Record<string, string>                           // env name -> placeholder value
  }
  refresh?: (item: ItemValues, fetch: Fetch) => Promise<RefreshResult>
  meter?: (access: string, item: ItemValues, fetch: Fetch) => Promise<MeterReading[]>
  patterns: { limit: Pattern[]; refused: Pattern[] }
  defaults: { refreshMargin?: string; launchLimit?: number; meterEvery?: string }
}

type RefreshResult =
  | { ok: true; access: string; refresh?: string; expiresAt: number }  // refresh is set only when it rotated
  | { ok: false; why: 'refused' | 'unclear'; status?: number; code?: string }

type Pattern = { id: string; re: RegExp; resetsAt?: (m: RegExpMatchArray, at: number) => number | null }
```

## Rules

- A provider keeps no state. It does no file or vault input or output. The core gives it the item values and a `fetch`. The core writes the result.
- `refresh` must return `why: 'refused'` only for an answer that ends the chain. Examples are the Codex error codes `invalid_grant`, `refresh_token_reused`, `refresh_token_expired` and `refresh_token_invalidated`. A 401 is also an example (research R6). A timeout, a 429 or a 5xx is `unclear`.
- `meter` must return `[]` when the source is not available (429, 5xx). The core then keeps the last indication until it is older than 2 periods. This rule comes from ccswitch ("unavailable never swaps", research R5).
- Each pattern id must have at least one fixture in `src/auth/fixtures/<name>/`. The fixture must show the correct class.
- A provider must not put a secret value in an error message. The core removes secret shapes from each error. It does this before it records the error.

## The first providers

| Name | Kind | Harnesses | Account item | Live keys | Refresh | Meter |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | subscription | claude | `Claude-Token-<email>` or `Claude Code-Account-<id8>-<email>` | `ANTHROPIC` | OAuth only | usage endpoint, then header probe |
| `codex` | subscription | codex | `Codex-Token-<email>` | `CODEX_CHATGPT`, `CODEX_CHATGPT_ACCOUNT` | yes | `wham/usage` |
| `grok` | session | grok | `Grok-Session-<email>` | `GROK_SESSION` | yes (OIDC) | weekly spend log |
| `cursor` | key | cursor | `Key-cursor-<label>` | `CURSOR_API_KEY` | no | the Cursor usage call of `cursor-meter.ts` |
| `xai` | key | grok (key mode) | `Key-xai-<label>` | `XAI_API_KEY` | no | none |
| `openai` | key | codex (key mode) | `Key-openai-<label>` | `OPENAI` | no | none |
| `typesafe` | key | none (manager) | `Key-typesafe-<label>` | `TYPESAFE` | no | none |
| `linear` | key | none (manager) | `Key-linear-<label>` | `LINEAR` | no | none |

The live key names are the names in `ax.ts` today. They do not change, so no change is necessary in agent-vault for the current vendors.
