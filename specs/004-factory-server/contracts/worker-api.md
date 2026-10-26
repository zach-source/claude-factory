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

| Method and path | Body | Replaces | Rules |
|---|---|---|---|
| `POST /v1/report` | `{outcome, summary}` | `factory report <run> <seq> <outcome> <summary>` | The run, node and seq come from the token. The outcome must be an edge of the node. A gate node takes no report. The beads push must succeed before the CLI calls (unchanged worker-side rule). |
| `POST /v1/mail` | `{to, text}` | `factory mail <run> <to> <text>` | `to` is `manager` or a node of the same run. |
| `GET /v1/memory/search?q=&rig=` | | `factory memory search` | Answers the same notes, in the same text format, as the laptop CLI. Records `shown` events with `from=<run>/<node>`. |
| `POST /v1/memory/add` | `{kind, summary, body, until?, supersedes?, rig?}` | `factory memory add` | The server sets `from=<run>/<node>`. The current gate checks (kind, until, supersedes) apply. |
| `POST /v1/memory/helped` | `{paths: [...]}` | `factory memory helped` | Each path must be inside the memory store. The server sets `from=<run>/<node>`. |
| `POST /v1/usage` | `{harness, model, session, input, cacheWrite, cacheRead, output}` | the `usage` field of an outbox report | One row for each session and model. The CLI sends it before the report. |
| `POST /v1/progress` | `{note}` | `progress.json` | Optional. |
| `GET /v1/prompt?after=<n>` | | `worker prompt` files sent by `ax.put` | Long poll. The answer is the next prompt for this station, or 204 after 30 s. |

## Not allowed for a worker token

`decide`, `goto`, `start`, `stop`, `resume`, `rig`, `decisions answer` and every client endpoint. A worker token cannot act for the person (FR-011). The client API is on another port, which needs a person certificate.
