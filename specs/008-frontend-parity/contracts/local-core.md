# Contract: the local core (`factory core`)

## Start and stop

```sh
factory core [--home <dir>] [--port <n>]   # runs in the front of a terminal or a herdr pane
factory core status                        # running or not, holder, port, catalog version
factory core stop                          # stops the core and releases the lease
```

- The home is `--home`, else `$FACTORY_HOME`, else the factory directory of the current directory (the `HOME` of `src/cli.ts`).
- The core takes the manager lease of `src/lease.ts` with kind `core` and holder `core:<pid>`. If another holder has a live lease, the core exits with code 1 and names the holder.
- The core renews the lease on its own interval (5 s), not after each tick. A tick that blocks the event loop for more than 60 s can lose the lease. Then the core stops and exits with code 1.
- The step children of the core get `FACTORY_LEASE_HOLDER`, `FACTORY_LEASE_KIND` and `FACTORY_LEASE_PID`. A lease that a child renews keeps the pid of the core.
- A worker cannot run `factory core`, `core stop` or `core status`. A patrol cannot run `core` or `core stop`.
- `FACTORY_CORE_TICK_MS` (an integer from 100 to 5000) sets the tick and renew interval. It exists for tests.
- `factory core stop` sends SIGTERM and waits up to 60 s. The core finishes the tick that runs, ends the step children (SIGTERM, then SIGKILL after 10 s), closes the event streams, releases its lease and writes the stop form of `core.json`.

## Listener

- It binds `127.0.0.1` only. The port is `--port`, else the last port in `<home>/core.json`, else a free port. The core writes `{port, pid, holder, startedAt, catalogVersion}` to `<home>/core.json`. On stop it writes `{port, catalogVersion, stoppedAt}`, so the next start reuses the port.
- It writes a random token of 32 bytes (64 hex characters) to `<home>/core.token` with mode 0600 when the file does not exist. The core starts only when the file is a regular file, owned by the user, with no group or other permission bits, and holds a token. Else it exits with code 1 and names the file.
- Each request, with no exception, goes through these checks in this order:
  1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (the DNS rebinding guard of `src/ui.ts:257`). Else 403.
  2. `Authorization: Bearer <token>`. Else 401.
  3. For a method other than GET and HEAD, a request with an `Origin` or `Sec-Fetch-Site` header needs the `Origin` of the core, `X-Factory-Intent: operator-ui-v1` and `Sec-Fetch-Site` absent or `same-origin`. Else 403. A CLI request has none of these headers and needs no intent header (the bearer token is the check).
- Every response has `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- The core serves `GET /v1/core` (state, ticks, steps, event seq), `GET /v1/events`, `GET /v1/commands/:id` and the catalog routes of `src/server-api.ts`.
- `GET /v1/events?after=<epoch>-<seq>` is a Server-Sent Events stream. An event holds `{seq, resource, revision}` and no other data. The `seq` is for each core run, and the `epoch` in the cursor changes at each start. A cursor of another epoch, or one outside the kept 1000 events, gets 409 `snapshot_required`. The core does not check the token again on an open stream.
- A catalog operation with `long: true` answers 202 and a command id. `GET /v1/commands/:id` gives the record. The records are in memory.

## Web UI login

`factory ui` opens `http://127.0.0.1:<port>/#token=<token>`. The page keeps the token in `sessionStorage` and sends it as the bearer token. The fragment does not go to the server or into a log. (Task T011.)

## Work that the core does

| Each | Work | Code today |
| --- | --- | --- |
| 5 s | tick, then `keepTick` (the same as `tick --keep-mail`) | `tick()` in `src/cli.ts:6810` |
| 60 s | patrol | child `factory patrol --once` (`patrolOnce` in `src/once.ts`) |
| 2 min | brief | child `factory brief --once` (`briefOnce`) |
| 5 min | review, decisions | child `factory review --once` (`reviewOnce`), child `factory decisions` (`decisionsList`) |
| 1 h | pm | child `factory pm --once` (`pmOnce`) |

The steps run as child processes, because `runModel` in `src/once.ts` is synchronous and would block the listener and the lease renew. A halted board starts no step. A step with no work makes no model call, as today. The core writes the same logs: `patrol-log.jsonl`, `pm-log.jsonl`, `brief-log.jsonl`, `review-log.jsonl` and `manager-usage.jsonl`.

## Front ends with no core

A front end that finds no running core does this:

- The CLI runs the operation in process, as it does today. It does not tick in the background.
- The Claude mod, the Herdr mod and the web UI show "no core" and the command `factory core`. They do not tick.
