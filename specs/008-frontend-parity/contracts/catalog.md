# Contract: the operation catalog

This contract extends the `/v1` interface of spec 004 and `specs/006-factory-product/contracts/control-api.md`. It adds no second interface. The command envelope, the error codes, the idempotency rules and the events of the 006 contract apply to each operation.

## Read the catalog

`GET /v1/catalog` returns:

```json
{
  "schemaVersion": 1,
  "factoryId": "<id>",
  "revision": 0,
  "observedAt": "<time>",
  "data": {
    "version": 1,
    "operations": [
      {
        "name": "runs.abort",
        "summary": "Abort a run and close its worker.",
        "inputs": [{ "name": "id", "kind": "id", "required": true, "help": "the run id" }],
        "output": "text",
        "rights": "owner",
        "mutates": true,
        "long": false,
        "route": { "method": "POST", "path": "/v1/runs/:id/abort" },
        "since": 1
      }
    ]
  }
}
```

- Any client with read rights can read the catalog.
- A path segment `:name` takes the input of the same name. The other inputs go in the query (GET) or the JSON body (POST).

## Run an operation

A front end calls the operation's route. A changing operation needs `Idempotency-Key` and `expectedRevision`, as in the 006 command envelope. A `long` operation returns `202 {commandId, status: "accepted"}`. The front end reads `GET /v1/commands/:id` until `status` is `done` or `failed`.

## Version difference

Each request sends `X-Factory-Catalog: <version>`. When the version is not the core's version, the answer has `catalogDiff: {added: [...], removed: [...], changed: [...]}`. A front end shows an added operation in its generic view. A removed operation is not offered.

## The first operations

These operations come from the current CLI. The CLI command stays. It calls the operation. The `/v1` routes that exist today keep their path.

| Operation | CLI today | Route |
| --- | --- | --- |
| `catalog.show` | (new) | `GET /v1/catalog` |
| `catalog.echo` | (new, the parity fixture) | `GET /v1/catalog/echo` |
| `board.show` | `factory tick` (JSON) | `GET /v1/board` |
| `runs.show` | `factory show <run>` | `GET /v1/runs/:id` |
| `runs.status` | `factory status` | `GET /v1/status` |
| `runs.screen` | `herdr pane read` or `ax ssh` (new op) | `GET /v1/runs/:id/screen` |
| `runs.start` | `factory start` | `POST /v1/start` |
| `runs.queue` | `factory queue` | `POST /v1/queue` |
| `runs.mail` | `factory mail` | `POST /v1/runs/:id/mail` |
| `runs.goto` | `factory goto` | `POST /v1/runs/:id/goto` |
| `runs.abort` | `factory abort` | `POST /v1/runs/:id/abort` |
| `gates.decide` | `factory decide` | `POST /v1/runs/:id/decide` |
| `gates.brief` | `factory gate-brief facts` | `GET /v1/runs/:id/brief` |
| `decisions.list` | `factory decisions` | `GET /v1/decisions` |
| `decisions.answer` | `factory decisions answer` | `POST /v1/decisions/:rig/:bead/answer` |
| `interview.list` | `factory interview` | `GET /v1/interview` |
| `interview.answer` | `factory interview answer` | `POST /v1/interview/answer` |
| `backlog.show` | `factory backlog` | `GET /v1/backlog` |
| `prs.show` | `factory prs` | `GET /v1/prs` |
| `plan.show` | `factory plan show` | `GET /v1/plan` |
| `metrics.show` | `factory metrics` | `GET /v1/metrics` |
| `rigs.list`, `rigs.set` | `factory rig list`, `factory rig set` | `GET /v1/rigs`, `POST /v1/rigs/:name` |
| `runners.show` | (the mod's Runners tab) | `GET /v1/runners` |
| `mail.list` | the manager mail in the tick | `GET /v1/mail` |
| `factory.halt` | `factory stop`, `factory resume` | `POST /v1/halt` with `mode` |
| `lease.show`, `lease.release` | `factory lease status`, `release` | `GET /v1/lease`, `POST /v1/lease/release` |
| `steps.reports` | the patrol, pm, brief and review logs | `GET /v1/steps` |
| `flows.show` | `factory flows` (new) | `GET /v1/flows` |
| `guard.check` | the Claude mod's `tool.call` gate | `POST /v1/guard/check` (read: it changes nothing) |
| `chat.send`, `chat.show` | the Claude mod chat | `POST /v1/conversations/:id`, `GET /v1/conversations/:id` |

The task that moves an operation can change the route of a new operation. That task must update this table in the same change.

## The flow graph: `flows.show`

`flows.show` is a read operation. Inputs: `factory` (a factory name; default: the factory with the most runs) and `since` (a cursor in ms since epoch, or a window such as `1h`, `24h`, `7d`; default `24h`). It returns:

```json
{
  "factory": "lifecycle",
  "since": 1700000000000,
  "now": 1700086400000,
  "nodes": [
    {
      "id": "plan",
      "gate": false,
      "legacy": false,
      "rank": 0,
      "order": 0,
      "counts": { "working": 1, "parked": 0, "stuck": 0 },
      "dwell": { "p50": 120000, "p90": 600000 },
      "runs": ["lifecycle-abc12"]
    }
  ],
  "edges": [
    { "from": "plan", "outcome": "done", "to": "build", "back": false, "timed": false, "traversals": 4 }
  ],
  "exits": [{ "from": "merge", "outcome": "ship", "to": "ship" }],
  "moves": [{ "run": "lifecycle-abc12", "from": "plan", "outcome": "done", "to": "build", "at": 1700000001000 }]
}
```

- `rank` is the depth from the start station over forward edges. A back edge goes to a station with a rank that is equal or lower. A back edge has `back: true`.
- `order` is the position of the station in the definition. It does not change between calls.
- `counts` are the live runs at the station, by run state (`sub`). `runs` lists their ids.
- `dwell` is the time that runs stay at the station, in ms, from the run logs in the window. It is `null` when there is no sample.
- `traversals` counts the log entries `{node, outcome, at}` in the window for that edge. `timed` is true when the edge has `delayMin`.
- `exits` are edges to another factory (`requeue`) or to the ship queue (`ship`). They are not stations.
- `moves` are the traversals with `at` after `since`, oldest first.
- A run pinned to an older version of the factory adds its own stations with `legacy: true`.
