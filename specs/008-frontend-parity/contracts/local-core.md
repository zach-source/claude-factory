# Contract: the local core (`factory core`)

## Start and stop

```sh
factory core [--home <dir>] [--port <n>]   # runs in the front of a terminal or a herdr pane
factory core status                        # running or not, holder, port, catalog version
factory core stop                          # stops the core and releases the lease
```

- The home is `--home`, else `$FACTORY_HOME`.
- The core takes the manager lease of `src/lease.ts` with kind `core`. If another holder has a live lease, the core exits with code 1 and names the holder.
- The core renews the lease on each tick (5 s), as each holder does today.

## Listener

- It binds `127.0.0.1` only. The port is `--port`, else the last port in `<home>/core.json`, else a free port. The core writes `{port, pid, startedAt, catalogVersion}` to `<home>/core.json`.
- It writes a random token of 32 bytes to `<home>/core.token` with mode 0600 when the file does not exist.
- Each request needs `Authorization: Bearer <token>`. A request without it gets 401.
- A request with a `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` gets 403 (the DNS rebinding guard of `src/ui.ts:257`).
- A browser request that changes state needs `X-Factory-Intent: operator-ui-v1` and an `Origin` of the core itself (spec 006 rules).

## Web UI login

`factory ui` opens `http://127.0.0.1:<port>/#token=<token>`. The page keeps the token in `sessionStorage` and sends it as the bearer token. The fragment does not go to the server or into a log.

## Work that the core does

| Each | Work | Code today |
| --- | --- | --- |
| 5 s | tick | `tick()` in `src/cli.ts:6455` |
| 60 s | patrol | `patrolOnce` in `src/once.ts` |
| 2 min | brief | `briefOnce` |
| 5 min | review, decisions | `reviewOnce`, `decisionsList` |
| 1 h | pm | `pmOnce` |

A step with no work makes no model call, as today. The core writes the same logs: `patrol-log.jsonl`, `pm-log.jsonl`, `brief-log.jsonl`, `review-log.jsonl` and `manager-usage.jsonl`.

## Front ends with no core

A front end that finds no running core does this:

- The CLI runs the operation in process, as it does today. It does not tick in the background.
- The Claude mod, the Herdr mod and the web UI show "no core" and the command `factory core`. They do not tick.
