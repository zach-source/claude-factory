# Data model: factory server state in Dolt

The server keeps its state in one Dolt database, `factory`. Each table below replaces one or more files under the factory home. Each write is a SQL transaction. The server makes a Dolt commit after each tick that changed rows, so `dolt_log` and `AS OF` give the state at an earlier time.

The memory notes stay Markdown files in their own git repository (spec assumption). Only their usage events and index move to Dolt.

## Tables

### `runs`

Replaces `runs/<id>/run.json`, `state.json` and `track.json`.

| Column                     | Type             | Notes                                                                                             |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `id`                       | varchar(64) PK   | The run id, for example `lifecycle-mvpd9jfxmd`.                                                   |
| `rig`                      | varchar(64)      | FK to `rigs.name`.                                                                                |
| `factory`                  | varchar(64)      | The factory name.                                                                                 |
| `factory_def`              | json             | The compiled factory graph at run start (today `runs/<id>/factory.ts`). A run keeps its own copy. |
| `goal`                     | text             |                                                                                                   |
| `bead`                     | varchar(64) null |                                                                                                   |
| `branch`                   | varchar(255)     | The git branch that the worker pushes.                                                            |
| `snapshot`                 | json             | The xstate persisted snapshot (today `state.json` `snapshot`).                                    |
| `cursor`                   | bigint           | The id of the last `run_events` row that the machine applied.                                     |
| `node`, `sub`              | varchar(64)      | Copied from the snapshot on each write, for queries.                                              |
| `created_at`, `updated_at` | bigint           | Epoch ms.                                                                                         |
| `ended_at`                 | bigint null      | Set at `done` or `aborted`.                                                                       |

Rule: only the tick writes `snapshot` and `cursor`, in the same transaction that reads the new `run_events`.

### `run_events`

Replaces `runs/<id>/inbox.jsonl`. Every event that the run machine takes: reports, mail, decisions, steers, timer events.

| Column    | Type                    | Notes                                                                       |
| --------- | ----------------------- | --------------------------------------------------------------------------- |
| `id`      | bigint PK auto          | Gives the order.                                                            |
| `run`     | varchar(64)             | FK to `runs.id`.                                                            |
| `event`   | json                    | The machine event, for example `{type:"DONE", seq, outcome, summary, at}`.  |
| `call_id` | varchar(64) unique null | The `worker_calls.id` that made it. A retried call cannot add a second row. |
| `at`      | bigint                  |                                                                             |

### `worker_calls`

New. One row for each API call from a worker. It makes a retry safe and keeps an audit trail.

| Column               | Type           | Notes                                                                                  |
| -------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `id`                 | varchar(64) PK | A UUID that the worker CLI makes once per call and sends again on each retry.          |
| `run`, `node`, `seq` |                | From the worker token, never from the request body.                                    |
| `token`              | varchar(64)    | The token id.                                                                          |
| `kind`               | varchar(32)    | `report`, `mail`, `memory.add`, `memory.helped`, `memory.search`, `usage`, `progress`. |
| `args`               | json           |                                                                                        |
| `status`             | varchar(16)    | `applied`, `refused`.                                                                  |
| `reason`             | text null      | The refusal reason, sent back to the worker.                                           |
| `at`                 | bigint         |                                                                                        |

### `mail`

Replaces the manager mail log and the per-station mailboxes.

| Column       | Type           | Notes                             |
| ------------ | -------------- | --------------------------------- |
| `id`         | bigint PK auto |                                   |
| `run`        | varchar(64)    |                                   |
| `from`, `to` | varchar(64)    | A station, `manager` or `person`. |
| `text`       | text           |                                   |
| `at`         | bigint         |                                   |

### `decisions`, `plans`, `gate_briefs`, `reviews`

Replace `decisions.json`, `plan.json`, `gate-briefs.json` and `reviews.json`. These files have no lock today. Each one becomes a table with a key column and a `body json` column, plus `at`. The key is the one that the file uses today. It is the decision key (`gate:`, `bd:`, `own:`, `iv:`, `prompt:`), the rig name, or the gate visit (`gate:<run>@<seq>`).

### `usage`

Replaces `runs/<id>/usage.jsonl` and `manager-usage.jsonl`.

| Column                                         | Type             | Notes                                                              |
| ---------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `id`                                           | bigint PK auto   |                                                                    |
| `run`                                          | varchar(64) null | Null for a manager agent step.                                     |
| `node`, `seq`                                  |                  |                                                                    |
| `step`                                         | varchar(32) null | `patrol`, `pm`, `briefer`, `reviewer`, `dream`, for an agent step. |
| `harness`                                      | varchar(16)      | `claude`, `codex`, `pi`, `sdk`.                                    |
| `model`                                        | varchar(64)      |                                                                    |
| `session`                                      | varchar(64)      |                                                                    |
| `input`, `cache_write`, `cache_read`, `output` | bigint           | Tokens. Codex gives `cached_input_tokens` as `cache_read`.         |
| `at`                                           | bigint           |                                                                    |

### `launches`

Replaces `launches.jsonl`: run, node, seq, harness, model, task name, image, at.

### `agent_steps`

Replaces `patrol-log.jsonl`, `pm-log.jsonl`, `brief-log.jsonl` and `review-log.jsonl`.

| Column                   | Type           | Notes                                |
| ------------------------ | -------------- | ------------------------------------ |
| `id`                     | bigint PK auto |                                      |
| `step`                   | varchar(32)    |                                      |
| `started_at`, `ended_at` | bigint         |                                      |
| `outcome`                | varchar(16)    | `ok`, `timeout`, `limit`, `error`.   |
| `token_slot`             | varchar(32)    | The subscription token slot it used. |
| `summary`                | text           |                                      |

### `memory_events`

Replaces `memory/.usage.jsonl`: `path`, `kind` (`shown`, `helped`, `confirmed`), `from` (`<run>/<node>` or null), `at`.

### `worker_tokens`

New. One row for each worker token that the server issued.

| Column               | Type           | Notes                                                                      |
| -------------------- | -------------- | -------------------------------------------------------------------------- |
| `id`                 | varchar(64) PK | The token id, inside the signed token.                                     |
| `task`               | varchar(128)   | The AX task name. Later, the SPIFFE ID maps to this.                       |
| `run`, `node`, `seq` |                |                                                                            |
| `expires_at`         | bigint         |                                                                            |
| `revoked_at`         | bigint null    | Set when the station ends or the run ends. A revoked token gets a refusal. |

### `rigs`

Replaces `rigs.json`. The same fields, one row for each rig, with `params`, `egress` and `linear` as json columns. The person changes it through the client API (`rig add`, `rig rm`) or a reviewed SQL change.

### `lease`

One row. `holder` (pod name), `until` (epoch ms). The server renews it on each tick. A second server process that finds a live lease does not tick (FR-007).

## State transitions

A run's states and edges do not change. The tick does the same work as today, in one transaction for each run:

1. Read the `run_events` rows after `cursor`.
2. Send them to the machine.
3. Write `snapshot`, `cursor`, `node` and `sub`.
4. Do the side effects that the new state needs, after the commit: start a task, send a prompt, revoke a token.

A side effect that fails does not roll back the state. The next tick sees the state and does the side effect again. This is the same rule that the file design uses today.

## Migration

`factory migrate dolt` reads a factory home and writes each table. It then compares counts: runs, events, mail, usage rows, decisions and memory events. It refuses to finish if a count differs. The file home stays as it was, so the person can go back.
