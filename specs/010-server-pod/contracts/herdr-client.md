# Contract: the herdr mod over /v1

Covers FR-010 and SC-005.

## Config

`herdr install --server <url>` writes `config.json` with `{server, cert, key, ca}` in place of `{cli, home, machine}`. The files are the person certificate files in `~/.config/factory/`. Do not use both modes in one config. A config that has both fails at load.

## Calls

- **Each beat (5 s):** one `GET /v1/snapshot?views=board,decisions,lease&maxAge=N`. The mod uses one HTTPS call, through the herdr app fetch if the app has one, or else `curl --cert` on the laptop. It makes no `hc` hop and starts no CLI.
- **Live changes:** if the app can hold a stream, the mod opens `GET /v1/events` (SSE) and refreshes on each event. The beat then falls to 30 s.
- **Actions:** each action posts to its catalog route with an `Idempotency-Key`. The mod shows the pod's answer or refusal text as it is.
- **Worker screen:** `GET /v1/runs/:id/screen`.

## Rules

- The mod holds no factory logic (constitution II). It does not validate, schedule or check rights.
- The server-mode `snapshot` route takes `maxAge`, which fixes the `--max-age` mismatch with `client.ts:76`.
- A view opens in under 1 s for 95% of opens (SC-005). The test measures it against a pod with a home of 400 runs.
