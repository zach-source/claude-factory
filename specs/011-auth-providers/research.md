# Research: Pluggable auth providers

Date: 2026-11-12. Sources:

- claude-factory on origin/main d290aa3d.
- ccswitch v2.13.1 (ee461a2).
- The owner decisions of 2026-11-12.

The file paths of ccswitch are relative to the ccswitch repo. The others are relative to this repo. The CronJobs `codex-refresh` and `grok-refresh` are not in this repo. They are in the GitOps repo. `bin/grok-token:4` names the Grok CronJob.

## R1. Today's auth code is in ten files, and no file owns it

- **Finding**:
  - The auth logic is in `claude-token.ts`, `codex-auth.ts`, `cursor-meter.ts`, `grok-meter.ts`, `token-guard.ts`, `cli.ts`, `worker.ts`, `steps.ts`, `ax.ts` and `broker.ts`.
  - The three `bin/*-token` scripts are a second copy of some of it, in bash.
  - `src/auth/` does not exist.
- **Swappers today**. Four paths can change the live Claude account:
  - `runTokenSwap` (`cli.ts:3380`) runs `FACTORY_AX_TOKEN_SWAP`.
  - `swapAccount` (`cli.ts:3292`) runs `ccswitch switch-to` on the laptop.
  - The broker `POST /token/best` (`broker.ts:417`) runs `claude-token best`. The manager steps call it (`steps.ts:95`).
  - The person can run `factory token use|best` (`cli.ts:15449`).
- **Decision**: Put one auth core in `src/auth/`. Move the logic there. The CLI, the broker, the steps and the tick call the core. The `bin/*-token` scripts stay for the rollback window. After that, they become thin calls of `factory auth`.
- **Alternatives**: Keep the files and add one more provider each time. Not chosen: a new vendor then touches the harness, the swap, the meter, the classify step and the egress code (FR-004).

## R2. The provider interface: the core does the work, the plugin gives the vendor facts

- **Decision**: The core defines a provider as a plain object. The fields are in data-model.md, "Provider". See contracts/provider.md. The core owns these parts:
  - the refresh loop and the single-writer rule
  - the pick
  - the classify step
  - the auth state
  - the agent-vault key list
  - the operations
- **Rationale**:
  - The vendors differ in only a few facts:
    - the token URL and client id
    - the usage source
    - the error text
    - the item fields
    - the placeholder
  - The core runs the same logic for each vendor.
  - ccswitch has no provider interface (`internal/cli/cli.go:64-74`). Claude and Codex use two separate code paths. Therefore, we cannot reuse a ccswitch interface. We use its facts (R3, R5, R6).
- **Alternatives**:
  - A plugin as a subprocess, such as a ccswitch call. Not chosen: decision 2 puts refresh, meters and classify in the core.
  - A class hierarchy. Not chosen: plain data and functions fit the catalog style of `src/core`.

## R3. The vault items follow the ccswitch names

- **Finding (ccswitch)**:
  - An item title is `<ItemPrefix> - <key>`. The default prefix is `Claude Code Account` (`internal/config/config.go:72-80`).
  - The keys are:
    - `Claude Code-Account-<id8>-<email>` for a Claude OAuth backup (`internal/account/keys.go:10-23`)
    - `Claude-Token-<email>` for a long-lived Claude token (`internal/cli/token.go:140`)
    - `Codex-Account-<label>` for a Codex profile (`internal/codex/registry.go:20`)
    - `Codex-Token-<email>` for a Codex token session (`internal/cli/token_codex.go:25`)
  - The vault CLI writes a Document with the blob. The Connect server writes a secure note with one concealed field `credentials` (`internal/backend/<vault-backend>/cli.go:222-259`, `connect.go:72, 200-235`). The items have no tags and no sections.
- **Decision**:
  - The core reads both shapes (a Document and a `credentials` field).
  - The core writes an account item in the shape that the item has.
  - For the new vendors, ccswitch adds these keys:
    - `Grok-Session-<email>`
    - `Key-<vendor>-<label>` (for example `Key-xai-main`)
  - The core adds two new plain fields, `refresh_holder` and `refresh_seq` (R4), to each item.
  - Only the live items have named fields, because agent-vault reads one field (`ate-secret://agent-vault/<vault>/<KEY>`, `ax.ts:561`).
- **Rationale**: Decision 3 says "match ccswitch naming". A second naming scheme would make two items for one account.
- **Open question for the owner (Q1)**: The names `Grok-Session-<email>` and `Key-<vendor>-<label>` are new. The default is these names.

## R4. The single-use refresh token rule

- **Finding**:
  - ccswitch treats the Claude and Codex refresh tokens as single-use tokens that rotate. A replay revokes the chain (`internal/refresh/oauth.go:63-68`, `internal/cli/rotate.go:14-37`, `internal/codex/refresh.go:31-33, 127-138`).
  - ccswitch locks only on the laptop:
    - Claude Code's lock files for the active account (`internal/cli/claudelock.go`)
    - a flock for each email for Codex token sessions (`internal/cli/token_codex.go:76-106`)
  - It refreshes non-active Claude accounts with no lock (`internal/refresh/refresh.go:83-149`).
  - ccswitch writes the live slot first, then the backup (`internal/cli/rotate.go:38-79`).
  - When the store write fails, ccswitch writes a local copy and warns that the refresh token is spent (`internal/cli/token_codex.go:56-70`).
  - Therefore, a laptop process and a cluster process can both refresh one account today. No rule stops this.
- **Decision**: The refresh step in the core has these rules (contracts/refresh.md):
  1. Take the refresh lease of the account in the auth state. Also write `refresh_holder=<home id>` in the account item. If the item names another live holder, stop.
  2. Read the account item again. Use its refresh value and its `refresh_seq`.
  3. Call the vendor.
  4. If the vendor sends a new refresh value, write it to the account item at once. Write `refresh_seq+1` and `rotated_at` together with it. Write it before any other step.
  5. Then write the access value and `expires_at` to the account item.
  6. Then, if the core picks this account, copy the access value to the live item.
  7. If step 4 fails, do not try the same refresh value again. Mark the account `unknown` with the reason "rotated value not stored". Send mail at once. A second try with the old value would revoke the chain.
  8. If the result is unclear (a timeout, a 5xx), read the item again before a new try. If `refresh_seq` changed, another writer did the refresh.
- **Rationale**:
  - The steps make sure of three things:
    - Only one writer refreshes an account.
    - The core stores the rotated token before the access token.
    - The core never sends a refresh token two times.
  - The `refresh_holder` field extends the lease across homes. For example, a laptop home and the pod, or ccswitch and the pod.
- **ccswitch change**: ccswitch must not refresh an item whose `refresh_holder` names another holder (spec FR-025a). Its `usage-all` and `refresh` commands skip such items and show "owned by <holder>".
- **Alternatives**:
  - A lock in Dolt. Not now: spec 010 keeps the state in files.
  - The vault item version as a compare-and-set. The Connect API gives an item version. The vault CLI path of ccswitch does not check it. Use `refresh_seq` as a plain check. Add the version check when both sides use Connect.

## R5. Claude: long-lived tokens in the VM, and a usage endpoint that costs no tokens

- **Finding**:
  - The VM slots are `account_%s_token` fields. `probe` sends them as a Bearer with `anthropic-beta: oauth-2025-04-20` (`claude-token.ts:111`).
  - ccswitch makes long-lived tokens with `claude setup-token` (`Claude-Token-<email>`, `internal/cli/token.go:28-35`).
  - These tokens have no refresh token. Therefore, the Claude VM path has no refresh today. On the laptop path, ccswitch refreshes OAuth accounts (`internal/refresh/oauth.go`).
  - The factory meter is `probe`. It makes a 1-token call to a small model and reads the `anthropic-ratelimit-unified-{5h,7d}-utilization` headers (`claude-token.ts:40-60`).
  - ccswitch reads `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`. It reads `five_hour` and `seven_day` `{utilization, resets_at}` (`internal/cli/usage.go:276-288, 504-535`).
  - ccswitch treats 401 and 403 as expired. It treats 429 and 5xx as unavailable, and it never swaps on unavailable (`internal/cli/autoswitch.go:251-256`).
- **Decision**:
  - The Claude provider has two account forms:
    - `token`: a long-lived token. It has no refresh. The core warns 30 days before its expiry.
    - `oauth`: a refresh token (local mode, and any OAuth account that ccswitch exports).
  - The meter uses the usage endpoint first, because it costs no tokens. If that endpoint refuses a long-lived token, the meter uses the header probe.
  - Use ccswitch's load rule: load = max(5h, 7d).
  - Use its "unavailable never swaps" rule.
- **Open check**: Does `/api/oauth/usage` take a `setup-token` token? Test it on one slot before the meters phase. The fallback keeps the meter.
- **Open question for the owner (Q2)**: Do the VM slots stay long-lived tokens? Or must the pod refresh OAuth accounts for Claude too? The default is to keep the long-lived tokens in the VM, and to support OAuth for local mode and new exports.

## R6. Codex: the pod takes over the session refresh from ccswitch

- **Finding**:
  - `bin/codex-token` reads `ccswitch token get --codex <email>`. That command gives an `auth.json` with an empty refresh token (`internal/codex/refresh.go:205-216`). `bin/codex-token` copies the access token and the account id into the live item.
  - ccswitch renews a session when less than 24 h is left (`internal/cli/token_codex.go`).
  - The factory runs the copy every 12 h (`refreshCodexToken`, `cli.ts:3427`).
  - Thus the Codex chain needs the laptop (the ccswitch refresh). The `codex-refresh` CronJob is a second refresher of the same sessions.
  - The token URL is `https://auth.openai.com/oauth/token` with the public Codex client id. The errors `invalid_grant`, `refresh_token_reused`, `refresh_token_expired`, `refresh_token_invalidated` and any 401 end the session (`internal/codex/refresh.go:18-33, 127-181`).
  - The meter is `GET https://chatgpt.com/backend-api/wham/usage` with `ChatGPT-Account-Id`. It reads `rate_limit.{primary,secondary}_window.{used_percent, limit_window_seconds, reset_at}` (`internal/codex/usage.go:13-139`).
- **Decision**:
  - The Codex provider in the core refreshes `Codex-Token-<email>` items with the same URL and error list.
  - The core sets `refresh_holder` to the pod.
  - The meter reads `wham/usage`.
  - The live item keeps its fields (`CODEX_CHATGPT`, `CODEX_CHATGPT_ACCOUNT`, `ax.ts:1193`).
  - `manager-codex-auth.json` becomes `manager.codex` in the auth state.
- **Rationale**: This removes the laptop from the Codex chain (decision 1). The core uses the same URL and the same error list as ccswitch, so the behavior stays the same.

## R7. Grok: move the refresh token out of the live item

- **Finding**:
  - `bin/grok-token` writes one item with these fields: `access_token` (vault key `GROK_SESSION`), `refresh_token`, `expires_at`, `email`, `oidc_issuer`, `oidc_client_id` and `last_refresh`.
  - Agent-vault reads this item. The `grok-refresh` CronJob refreshes it.
  - The access token lasts 6 hours (`bin/grok-token:1-25`).
  - ccswitch has no Grok support.
- **Decision**:
  - Split the item. The account item `Grok-Session-<email>` holds `refresh_token`, `oidc_issuer`, `oidc_client_id`, `expires_at` and `last_refresh`.
  - The live item keeps only `access_token` and `email`.
  - The Grok provider refreshes at the OIDC token endpoint of `oidc_issuer`. The refresh margin is 1 hour, because the access token lasts only 6 hours.
  - The spend log becomes `spend.grok` in the auth state. The weekly budget gate stays.
- **Rationale**: Decision 3 says that a refresh token never leaves its account item. Today agent-vault can read the Grok refresh token.
- **ccswitch change**: It adds `ccswitch grok login` (a device flow with a temporary `GROK_HOME`, as `bin/grok-token` describes). The command writes `Grok-Session-<email>`.

## R8. Key vendors: no refresh, and meters only where a source exists

- **Finding**:
  - Cursor: `CURSOR_API_KEY`. The meter is `cursor-meter.ts` (5-minute cache, cap setting `cursor.cap`).
  - xAI: `XAI_API_KEY` (Grok key mode, `ax.ts:687-720`).
  - OpenAI: `OPENAI_API_KEY` and `CODEX_API_KEY` (Codex key mode, `OPENAI_RULE`, `ax.ts:1202`).
  - Typesafe and Linear: manager keys only (`managerEgress`, `ax.ts:1230`).
  - ccswitch knows only the OpenAI key, inside a Codex `auth.json` (`internal/codex/login.go:214-241`).
- **Decision**:
  - Each key vendor is a provider of kind `key` with no refresh.
  - Cursor keeps its meter (it moves into the provider).
  - xAI, OpenAI, Typesafe and Linear have no meter at first, so the text match is their only limit check.
  - ccswitch adds `ccswitch key add <vendor> <label>`. It reads the key on stdin and writes `Key-<vendor>-<label>`.
- **Alternatives**: A spend meter from the vendor billing APIs. Later, as a plugin change only.

## R9. Agent-vault keys from the provider list

- **Finding**:
  - The egress rules and the placeholders are in `ax.ts`:
    - `egressPolicy` `:543`
    - `CODEX_CHATGPT_RULE` `:1193`
    - `OPENAI_RULE` `:1202`
    - `managerEgress` `:1230`
    - placeholders `:687-720` and `:1103-1109`
  - Each key name must use SCREAMING_SNAKE_CASE (`ax.ts:86`).
  - Agent-vault itself runs as a bare pod. A person patches its configuration by hand. The scratchpad has patches for xAI, OpenAI and Typesafe.
  - Agent-vault reads the vault again about every 5 minutes (`TOKEN_SWAP_WAIT_MS`, `cli.ts:3317`).
- **Decision**:
  - The core makes the key list from the providers (`auth.keys`, contracts/auth-ops.md).
  - `ax.ts` builds its egress rules and placeholders from that list, not from constants.
  - A later step writes the agent-vault configuration from the list. This step needs a managed deployment of agent-vault (a GitOps object in place of the bare pod).
  - Until then, `factory auth keys --format agent-vault` prints the patch for a person to apply.
- **Rationale**: FR-027. The list removes the need to write a patch by hand. The bare pod blocks the automatic step.

## R10. The pod refreshes under its lease, with a vault writer token

- **Finding**:
  - Spec 010 puts the tick and the server lease in the pod (`server.ts`).
  - In server mode the account-swap directory is `<home>/claude-switch-backup` (`axrepos.ts:21-23`).
  - The broker and `bin/*-token` use a writer service account or the person's own vault sign-in.
  - ccswitch already has a Connect backend (`internal/backend/<vault-backend>/connect.go`).
- **Decision**:
  - The refresh loop is a job of the pod tick loop. It runs only while the pod holds the server lease.
  - It reads the writer token from a secret-sync item (`factory-vault-writer`) mounted as a file.
  - The loop never writes the token into the home, the env of a worker or a log.
  - The token has write rights only on the vault of the account items and the live items.
  - In local mode, the laptop factory runs the same loop under its manager lease, with the person's vault sign-in.
- **Rationale**: Decision 1. The secret-sync item keeps the token out of the image and the backup (spec 010 FR-018).

## R11. Classify: one step, with fixtures from real text

- **Finding**:
  - The detectors are `limitHit` (`cli.ts:3182`, Claude, structured), `codexLimit`, `cursorLimit` and `grokLimit` (`worker.ts:1466-1530`), `stepLimit` (`steps.ts:65-69`) and `isCodexAuthError` (`codex-auth.ts:11`).
  - The Cursor and Grok patterns say "the exact text is not yet seen" (`worker.ts:1491-1512`).
  - No test reads a fixture file. The tests use inline strings.
  - ccswitch has no error text fixtures.
- **Decision**:
  - Each provider gives its patterns. The core classify step runs them on the stream tail. The VM still runs it in `limitNow` (`worker.ts:1534`).
  - The core sends the result through `trustedHit` (`cli.ts:3169`), as today.
  - Put each fixture in `src/auth/fixtures/<provider>/<case>.txt`. Each fixture has a header line with the capture date and the expected class.
  - A capture step (`factory auth capture <run>`) copies the last error lines of a run into a fixture file with the secret shapes removed.
  - The guard hook and gitleaks check each fixture before it goes into the repo.
- **Rationale**: FR-016 and FR-017. Fixtures from real text stop the guesses.

## R12. Settings for every vendor

- **Finding**:
  - `SETTING_KEYS` (`settings.ts:13-44`) has `token.*` (Claude, no env), `cursor.cap`, `grok.auth` and `grok.weeklyBudgetUsd`.
  - Codex, xAI and OpenAI have only env values.
- **Decision**:
  - Add `auth.<provider>.*` keys and `auth.vault` (data-model.md, "Settings").
  - The old keys stay as aliases. `factory settings` shows both names, and it marks the old name.
  - The core makes the setting keys from the provider list, so a new provider gets its settings with no edit of `settings.ts`.
- **Rationale**: FR-020 and FR-004.

## R13. Plan use per account in the token report

- **Finding**:
  - The `Usage` row (`metrics.ts:385`) has no account field.
  - Only `agent-steps.jsonl` has `token_slot` (`steps.ts:61`).
  - The report is `tokensReport` (`metrics.ts:699`) and the weekly `tokenDigestMail` (`cli.ts:7180`).
- **Decision**:
  - Add `account` (`<provider>:<label>`) to each usage row at launch, from the pick.
  - The token report gets a section "Plan use". For each account, it shows the last meter reading (used, window, reset) and the tokens that the factory used on it in the window.
  - `/metrics` gets the gauge `factory_auth_used_ratio{provider,account,window}` and the counter `factory_auth_refresh_total{provider,result}`.
- **Rationale**: FR-024 and spec 005.

## R14. Migration and rollback

- **Decision**: Do the move in phases. You can undo each phase (contracts/migration.md).

  1. Shadow phase. The core reads the old files and writes the auth state. The old code still acts.

  2. The core acts on limits and swaps. It writes the old files too.

  3. Split the account items. Create a Grok account item. Create one item for each account in the Claude slots. Remove the refresh fields from the live items.

  4. Suspend the schedule of that vendor's CronJob first. Then the pod starts the refresh for one account of each vendor.

  5. After 7 days with no dead chain, delete the CronJobs from the GitOps repo. Then make a read-only copy of the old files.
- **Rollback**: Stop the pod refresh first (`auth.refresh.enabled=false`). Then resume the CronJobs. Then restore the old fields from the account items. The old files are still on the volume.
- **Open question for the owner (Q3)**: Is 7 days long enough before the CronJobs are deleted? The default is 7 days.

## R15. Local mode

- **Decision**:
  - The core works on a laptop home with no pod and no writer token (FR-030).
  - The laptop refresh uses the person's vault sign-in and the same `refresh_holder` rule.
  - `swapAccount` (`ccswitch switch-to`) stays the local swap for the laptop Claude login. It is the local provider action for `claude`. The core calls it.
  - `factory-limits.json` moves into the auth state.
- **Rationale**: Spec 004, 008 and 010 keep local mode.
