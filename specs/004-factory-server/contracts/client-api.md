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
