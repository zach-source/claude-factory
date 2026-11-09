# Contract: client API

The person's clients call this API: the console (the `mod` plugin), the factory CLI on the laptop, and a Claude Code session that uses the CLI.

## Transport and identity

- HTTPS with mutual TLS on port 8444 of the `factory` Service. This port accepts only a client certificate from the person CA. A connection that completes the TLS handshake is the person (research R2).
- `factory cert person` issues the certificate once. The person keeps it on the laptop in `~/.config/factory/`.
- The server does not accept worker tokens on this port.
- The laptop reaches the Service through the cluster gateway on the LAN. The client sets the server address in `FACTORY_SERVER`. When `FACTORY_SERVER` is not set, the CLI works on the local factory home as it does today. This is the way back (FR-016).

## Read endpoints

| Method and path                                                          | Answers                                                                                   | Replaces               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------- |
| `GET /v1/board`                                                          | The tick rows: runs, rigs, halt, mail, staleness. The same JSON as `factory tick` prints. | `factory tick`         |
| `GET /v1/runs/<id>`                                                      | The same JSON as `factory show <id>`.                                                     | `factory show`         |
| `GET /v1/status`                                                         | The same text as `factory status`.                                                        | `factory status`       |
| `GET /v1/prs`, `/v1/backlog`, `/v1/metrics`, `/v1/decisions`, `/v1/plan` | The same JSON or text as the CLI command of that name.                                    | the CLI commands       |
| `GET /v1/catalog` | The operation catalog of specs/008-frontend-parity/contracts/catalog.md. | (new) |
| `GET /v1/catalog/echo?text=<text>` | The text. A parity fixture. | (new) |
| `POST /v1/guard/check` with `{command, role}` | `{decision}`: allow, ask with the question and the reason, or deny with the reason. It changes nothing and needs no `Idempotency-Key`. | the Claude mod's Bash gate (new) |
| `GET /v1/events?after=<id>`                                              | Server-sent events: one event for each board change.                                      | the console's 5 s poll |

## Action endpoints

Each action endpoint takes `Idempotency-Key`, as in the worker API.

| Method and path                                 | Body                                    | Replaces                            |
| ----------------------------------------------- | --------------------------------------- | ----------------------------------- |
| `POST /v1/runs/<id>/decide`                     | `{outcome, note}`                       | `factory decide`                    |
| `POST /v1/runs/<id>/mail`                       | `{to, text}`                            | `factory mail` from the person      |
| `POST /v1/runs/<id>/goto`, `/abort`             |                                         | `factory goto`, `factory rm`        |
| `POST /v1/start`                                | `{factory, rig, goal, station?, bead?}` | `factory start`                     |
| `POST /v1/halt`                                 | `{mode: "stop" or "resume"}`            | `factory stop`, `factory resume`    |
| `POST /v1/decisions/<key>/answer`               | `{text}`                                | `factory decisions answer`          |
| `PUT /v1/rigs/<name>`, `DELETE /v1/rigs/<name>` | the rig fields                          | `factory rig add`, `factory rig rm` |

## Rules kept from today

- Only the person decides a gate. The agent steps have no person certificate, so they cannot call `decide`.
- The console asks for a confirmation before a decide, as it does today. The server does not trust a client to ask. It records each decision with the time and the client address.

## CLI client mode (`src/client.ts`)

Set `FACTORY_SERVER` to an origin to send CLI forms to this API. Without it, the CLI works on the local home.

- The origin must be `https:`, or `http:` on `127.0.0.1`, `localhost` or `[::1]`. It has no user, path, query or hash. If it is not valid, the CLI exits 1 and sends no request.
- For `https:`, the client reads `~/.config/factory/person.crt`, `person.key` and `ca.crt`. If one file is missing, the CLI exits 1 and names the path.
- A worker ignores `FACTORY_SERVER`. A worker has `FACTORY_FROM` other than `manager`, or `FACTORY_RUN`, `FACTORY_DEF_NAME`, or `BEADS_ACTOR` that starts with `factory/`.
- If `FACTORY_FROM` is `manager`, the client refuses all forms except `mail` and the reads. The reads are `show`, `status`, `prs`, `backlog`, `decisions [list]`, `plan` and `metrics`.
- If `FACTORY_PATROL` is set, the client refuses `tick`, `stop`, `resume`, `decide`, `start` and `decisions answer`.
- A refusal sends no request.
- `mail` sends the `cwd` of the client. If `cwd` is inside the run worktree, the server must answer with a 4xx. This is the `managerSender` check in `src/cli.ts`. It is a duty of claude-factory-akiq.7.
- Each path segment (run, node, rig, bead) must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
- Each POST has a new `Idempotency-Key` and `content-type: application/json`.
- A 2xx body goes to stdout and the exit code is 0. Any other status writes `factory server: <status> <first 500 characters>` to stderr and the exit code is 1.
- If the request fails, the CLI exits 1. It does not use the local home.

| CLI form                                              | Request                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `tick`                                                | `GET /v1/board`                                               |
| `show <run>`                                          | `GET /v1/runs/<run>`                                          |
| `status`, `status <run>`                              | `GET /v1/status`, `GET /v1/status?run=<run>`                  |
| `prs`, `backlog`, `decisions [list]`, `plan [show]`   | `GET /v1/prs`, `/v1/backlog`, `/v1/decisions`, `/v1/plan`     |
| `metrics [--rig r] [--since s] [--json] [--tokens]`   | `GET /v1/metrics` with `rig`, `since`, `json=1`, `tokens=1`   |
| `decide <run> <outcome> [note...]`                    | `POST /v1/runs/<run>/decide {outcome, note}`                  |
| `mail <run> <to> [--wake] <text...>`                  | `POST /v1/runs/<run>/mail {to, text, from: "manager", cwd, wake?}` |
| `goto <run> <node>`, `abort <run>`                    | `POST /v1/runs/<run>/goto {node}`, `/abort {}`                |
| `start <factory>[@station] <rig> <goal...> [--owned]` | `POST /v1/start {factory, station?, rig, goal, owned?}`       |
| `stop`, `resume`                                      | `POST /v1/halt {mode}`                                        |
| `decisions answer <rig> <bead> <text...>`             | `POST /v1/decisions/<rig>/<bead>/answer {text}`               |

`help`, `check`, `mutate`, `ci`, `pg-scratch` and `devenv` run locally. Every other command, and every other form of the commands above, exits 1 with `factory <cmd> has no server mode`. `rig add` and `rig rm` wait for claude-factory-tsam.

## Server rules (`src/server-api.ts`)

The server checks the client certificate before it reads a request. It does not use `Bun.serve` for this port. In Bun 1.3.13, `Bun.serve` with `rejectUnauthorized` was not safe. It ran the handler for a certificate from another CA in 4 to 8 percent of the tries. The listener uses `node:tls`. It accepts only a client certificate that the person CA signed. Each connection carries one request, then closes.

- Start the listener with `--client-port`, `--tls-cert`, `--tls-key` and `--person-ca`. Give all four or none.
- A request with an `Authorization` header gets 403. This holds for any value and any route. A worker token never opens this port.
- The server serves only the routes in the tables above, except `GET /v1/events` (claude-factory-bb05) and `PUT` and `DELETE /v1/rigs/<name>` (claude-factory-tsam). Those give 404.
- `GET /v1/board` gives the result of the last tick of the server. It gives 503 before the first tick. It runs no CLI command.
- A decision answer goes to `POST /v1/decisions/<rig>/<bead>/answer`. A decision can only be made on this port. The health port (8080) gives 404 for `decide`.
- Status codes:
  - 400: bad form (path, query, body, key or content type).
  - 403: an `Authorization` header, or a mail `cwd` inside the run worktree.
  - 404: unknown route.
  - 409: another request already used the key.
  - 422: the CLI refused. The body holds the first 500 characters of stderr.
  - 503: no tick yet, or a corrupt store.
  - 504: the CLI ran for more than 60 s.
- A body is at most 128 KiB. A free-text field has 1 to 65536 characters and no U+0000. A `start` goal must not hold the word `--owned`.
- Each POST needs `content-type: application/json`. Each POST that changes state also needs `Idempotency-Key`. The server keeps each action answer for 24 h in `<home>/client-idempotency.json` (mode 0600). The same key and the same request give the stored answer, also after a restart. The same key with another request gives 409. If the file is corrupt, the server gives 503 and runs no action. The server runs one action at a time.
- Each POST that changes state and passes the form check adds one line to `<home>/client-actions.jsonl`. The line has the time, client address, method, path, key and status. A `decide` line also has the outcome. The line holds no free text.
- Each action runs `cli.ts` as a child process with the server home. The child env has no `FACTORY_SERVER`, `FACTORY_FROM`, `FACTORY_RUN`, `FACTORY_DEF_NAME`, `FACTORY_PATROL`, `FACTORY_OUTBOX` or `BEADS_ACTOR`. Mail text goes through a file in `<home>/text/`. The server removes the file after the call.
- `factory cert person <dir> <server-name>` makes the person CA, the person certificate and the server certificate in a new folder.
