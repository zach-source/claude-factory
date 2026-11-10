# Contract: worker API

Workers call this API. The caller is a worker CLI (`factory report|mail|memory|usage|progress`) in an AX task.

## Transport and identity

- HTTPS on port 8443 of the `factory` Service. VM workers reach it through the `https` egress rule that every task gets. The AX egress gateway decrypts the request and makes its own TLS connection to the server (research R1).
- The worker sends `Authorization: Bearer $FACTORY_TOKEN`. The server signed this token at launch over `{task, run, node, seq, exp}` and put it in the task env.
- The server takes the run, node and seq only from the token, never from the request body. It refuses each call whose path or body names another run, another node or another seq.
- The server also refuses a call when the `worker_tokens` row for the token is revoked or the token is expired. The server revokes it when the station ends.
- Later step: when AX issues task SVIDs, the gateway connects with the task's SVID, and the server accepts the SPIFFE ID in place of the token. The endpoints do not change.

## Common rules

- Each request has the header `Idempotency-Key: <uuid>`. The worker CLI makes it once for each command and sends it again on each retry. The server answers a repeated key with the first answer, and does not apply the call again.
- Request and response bodies are JSON.
- A refusal is HTTP 403 or 409 with `{"refused": "<reason>"}`. The worker CLI prints the reason and exits 1, the same as the CLI does today.
- If the server cannot be reached, the worker CLI retries with backoff for up to 10 min. Then it writes the call to the local outbox file. The server reads that file at the next station start or through `worker poll`. The outbox path stays as a fallback only.

## Endpoints

| Method and path                 | Body                                                              | Replaces                                         | Rules                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/report`               | `{outcome, summary}`                                              | `factory report <run> <seq> <outcome> <summary>` | The run, node and seq come from the token. The outcome must be an edge of the node. A gate node takes no report. The beads push must succeed before the CLI calls (unchanged worker-side rule). |
| `POST /v1/mail`                 | `{to, text}`                                                      | `factory mail <run> <to> <text>`                 | `to` is `manager` or a node of the same run.                                                                                                                                                    |
| `GET /v1/memory/search?q=&rig=` |                                                                   | `factory memory search`                          | Answers the same notes, in the same text format, as the laptop CLI. Records `shown` events with `from=<run>/<node>`.                                                                            |
| `POST /v1/memory/add`           | `{kind, summary, body, until?, supersedes?, rig?}`                | `factory memory add`                             | The server sets `from=<run>/<node>`. The current gate checks (kind, until, supersedes) apply.                                                                                                   |
| `POST /v1/memory/helped`        | `{paths: [...]}`                                                  | `factory memory helped`                          | Each path must be inside the memory store. The server sets `from=<run>/<node>`.                                                                                                                 |
| `POST /v1/usage`                | `{harness, model, session, input, cacheWrite, cacheRead, output}` | the `usage` field of an outbox report            | One row for each session and model. The CLI sends it before the report.                                                                                                                         |
| `POST /v1/progress`             | `{note}`                                                          | `progress.json`                                  | Optional.                                                                                                                                                                                       |
| `GET /v1/prompt?after=<n>`      |                                                                   | `worker prompt` files sent by `ax.put`           | Long poll. The answer is the next prompt for this station, or 204 after 30 s.                                                                                                                   |

## Not allowed for a worker token

`decide`, `goto`, `start`, `stop`, `resume`, `rig`, `decisions answer` and every client endpoint. A worker token cannot act for the person (FR-011). The client API is on another port, which needs a person certificate.

## Implemented rules (report, mail and progress)

`workerHandler` in `src/server-api.ts` serves these three routes. The memory, usage and prompt routes are not served yet.

- Order of checks and status codes. The first check that fails answers.
  1. 404: not `POST /v1/report`, `/v1/mail` or `/v1/progress`, or a query string.
  2. 503: this server does not hold the lease.
  3. 403: no Bearer token, a bad token, or claims that are not a run station (run or node `.` or `..`, node `manager`).
  4. 400: the `Idempotency-Key` does not match `^[A-Za-z0-9-]{8,128}$`.
  5. 503: the call store does not parse.
  6. 409: the key was used for another token or body, or the first call with this key did not finish (`pending`).
  7. 400: the body breaks the closed grammar below.
  8. 403: the body names another `run`, `node` or `seq` than the token.
  9. 409: the run is not at the node and seq of the token, or the run is unknown.
  10. 409: the CLI refused the call. 504: the CLI timed out and the call can have applied.
- Rows. Only a call with a live token and a good key makes a row. The checks 1 to 6 write no row. A replay writes no row. A refusal from check 7 on writes a `refused` row.
- Store. The rows are in `<home>/worker-calls.json` (mode 0600), kept 7 days, until the Dolt table of S6. The row key is the Idempotency-Key. The row holds the token id, never the token. Status `pending` marks a call that started and did not finish: the same key gets 409 and the CLI never runs two times.
- Body keys. `run`, `node` and `seq` are optional in each body and must equal the token. Other keys are closed: report `outcome, summary`; mail `to, text`; progress `note`. There is no `wake` key.
- A report and a mail run the CLI (`factory report`, `factory mail`) with `FACTORY_FROM` and `FACTORY_RUN` from the token, so the CLI applies the same rules as the outbox path.
