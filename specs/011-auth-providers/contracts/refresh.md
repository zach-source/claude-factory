# Contract: the refresh loop and the single-writer rule

Covers FR-005 to FR-011. Research R4 and R10 give the reasons.

## Who runs it

| Mode | Runner | Condition | Vault access |
| --- | --- | --- | --- |
| Server | the server pod tick loop (spec 010) | the pod holds the server lease | the writer token from the secret-sync item `factory-vault-writer`, as a file |
| Local | the laptop factory tick | the laptop holds its manager lease | the person's vault sign-in |

No other process refreshes. These callers do not refresh. They ask the core for a pick, or they read the auth state:

- `bin/*-token`
- the broker
- the manager steps

The loop runs every minute. It refreshes an account when `expiresAt - now < refreshMargin`. It also refreshes after a `refused` classify result.

## One refresh, step by step

```text
1  lease   take leases[<id>] in the auth state (ttl 10 min); stop if another holder has it
2  claim   read the account item; if refresh_holder names another live holder, stop and show it
           else write refresh_holder=<home id>
3  read    read the item again: refresh value, refresh_seq
4  call    provider.refresh(item)
5  store   if the result has a rotated refresh value:
             write refresh value, refresh_seq+1, rotated_at to the account item  (first write)
6  access  write access value, expires_at, last_refresh to the account item
7  live    if this account is picked: copy the access fields to the live item in one edit
8  state   write accounts[<id>] in the auth state (no secret value)
```

## Failure rules

| Where | Result | Action |
| --- | --- | --- |
| 4 | `refused` | The core sets state `dead`. It sends one mail to the manager. The mail names the account, the provider, the time and the `ccswitch` login command. The pick drops the account. |
| 4 | `unclear` | Retry with back-off (1, 2, 4, 8 min, then every 15 min). Before each retry, do step 3 again. If `refresh_seq` changed, another writer refreshed. Then take its values and stop. |
| 5 | the write fails after the vendor issued a new value | Do not send the old refresh value again. Set state `unknown`, reason "rotated value not stored", and send a mail at once. Keep the new access value in memory and copy it to the live item if needed. Work goes on until it expires. Retry only the write, with the new value from memory. Do not retry the vendor call with the old value. |
| 6 or 7 | the write fails | Retry the write. The refresh value is safe. |
| any | the vault is down | Keep the current access values. Show "vault down" on every front end. Use back-off as for `unclear`. |
| any | the writer token is refused | Stop all writes. Send one mail to the manager. Show "vault writer refused". |

## Do not

- Do not send one refresh value to the vendor two times. This applies after the vendor accepted it.

- Do not write a refresh value to the live item, the auth state or a log.

- Do not write a refresh value to a metric, to mail or to a worker VM.

- Do not refresh in server mode from a process that does not hold the pod lease.

- Do not refresh an account whose item names another live `refresh_holder`.

## Mail

The core sends one mail for each dead chain. The mail goes to `manager`. It names the account and the command to fix it. For example: `ccswitch codex login <email>`, then `ccswitch export --to factory`. The core sends a second mail for the same account only after the account is `ok` again.

## Metrics

- `factory_auth_refresh_total{provider,result}` counts each result: `ok`, `rotated`, `refused` or `unclear`.
- `factory_auth_account_state{provider,account,state}` is 1 for the current state of each account.
