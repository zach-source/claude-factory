# Contract: the ccswitch seeder and the export

Covers FR-025, FR-025a and FR-026. This is a change in the ccswitch repo (Go). It gets its own release after v2.13.1. The factory does not copy ccswitch login code.

## New ccswitch commands

| Command | What it does |
| --- | --- |
| `ccswitch grok login <email>` | Runs `grok login --device-auth` with a temporary `GROK_HOME`. Writes `Grok-Session-<email>`. Deletes the temporary `auth.json`, so that no second refresher has the token. |
| `ccswitch key add <vendor> <label>` | Reads the key on stdin. Writes `Key-<vendor>-<label>`. Vendors: `cursor`, `xai`, `openai`, `typesafe`, `linear`, and any name that matches `^[a-z]+$`. |
| `ccswitch export --to factory [<item>...]` | For each named item (default: all items of the providers that the factory lists), it sets `refresh_holder=factory:<home id>` in the item and calls `auth.seed`. |

## The export call

ccswitch sends `POST /v1/auth/seed` (server mode, with the person certificate) or runs `factory auth seed` (local mode). The body holds names only:

```json
{ "items": [{ "provider": "codex", "label": "<email>", "item": "Codex-Token-<email>" }] }
```

The factory reads each item from the vault. It checks the fields of its provider. It adds the account with state `unknown`. Then the first refresh or meter reading sets the state.

## The hand-off rule

- After an export, the factory owns the refresh of the item.
- ccswitch `refresh`, `usage-all`, `token get --codex` and `daemon` must not refresh an item whose `refresh_holder` names another holder. They may read it.
- `ccswitch export --release <item>` gives the item back to ccswitch. It clears `refresh_holder` after the factory confirms that it took the account out of its refresh loop.
- This rule fixes a gap of ccswitch v2.13.1: it refreshes non-active Claude accounts with no lock (research R4).

## Not in the factory

- OAuth PKCE and device flows.
- Claude Code lock files and `~/.claude.json`.
- ccswitch backends other than the vault (keychain, file, KV).
