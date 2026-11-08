# Data model: Manager core and front-end parity

## Operation

One feature of the factory or the manager. It is code in `src/core/ops/`. The catalog registers it.

| Field | Type | Rule |
| --- | --- | --- |
| `name` | string | Unique. Dot form: `<group>.<verb>`, for example `runs.abort`, `board.show`. It must not change after a release. |
| `summary` | string | One line of help text. Each front end shows it. |
| `inputs` | list of Field | Each field has a name and a kind. Kinds come from `src/core/catalog.ts`: id, text, note, path, flag, enum. A field has a required or optional setting and help text. |
| `output` | enum | `table`, `text`, `json` or `stream`. The generic view uses it to show the result. |
| `rights` | enum | `read` (any client), `owner` (the person), `manager` (the manager's own steps). A worker never calls a catalog operation. |
| `mutates` | bool | True when the operation changes state. A changing operation needs an idempotency key and the current revision (spec 006 command envelope). |
| `long` | bool | True when the operation can take more than 10 s. The route then returns a command id. |
| `route` | method and path | One `/v1` route. Reads are GET. Changes are POST. |
| `since` | catalog version | The catalog version that added the operation. |

**Rules**: The registry refuses two operations with one name or one route. An operation with `mutates: true` must not have `rights: read`.

## Catalog

| Field | Type | Rule |
| --- | --- | --- |
| `version` | integer | It goes up by 1 for each release that adds, removes or changes an operation. |
| `operations` | list of Operation | Sorted by name. Served at `GET /v1/catalog` without `run`. |

## Core instance

One running core for one factory home.

| Field | Type | Rule |
| --- | --- | --- |
| `home` | path | The factory home. |
| `mode` | enum | `local` or `server`. |
| `holder` | lease holder | The manager lease of `src/lease.ts`. Only one core for each home. |
| `listen` | host and port | Local mode: `127.0.0.1` and a port in `<home>/core.json`. Server mode: the spec 004 listeners. |
| `catalogVersion` | integer | The catalog that this core serves. |

**States**: `starting` → `ticking` (it holds the lease) → `stopping` → `stopped`. A core that cannot get the lease stays `stopped` and names the holder.

## Command

One request from a front end to run a changing or long operation. It is the command record of spec 006.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | Made by the core. |
| `op` | operation name | |
| `actor` | person, manager step or front end | From the credential, never from the body. |
| `frontEnd` | enum | `cli`, `web`, `claude-mod`, `herdr-mod` or another name. For the audit log only. It gives no rights. |
| `idempotencyKey` | string | The same key and body give the first result again. |
| `status` | enum | `accepted` → `running` → `done` or `failed`. |
| `result` | The output of the operation, or an error with a reason | |

## Event

A change notice for the open front ends.

| Field | Type | Rule |
| --- | --- | --- |
| `seq` | integer | Goes up by 1 for each event in a home. |
| `resource` | string | For example `run:<id>`, `board`, `gate:<run>`, `conversation:<id>`. |
| `revision` | integer | The new revision of the resource. |

A front end that gets an event reads the resource again. Events carry no data (spec 006 `/v1/events`).

## Manager conversation

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | |
| `session` | Claude session id | The `--resume` value of the next turn. |
| `turns` | list | Each turn: who (person or manager), the text, the front end, the time, the commands that the turn ran. |

Stored in `<home>/conversations/<id>.jsonl`. Any front end can read it and add a turn.

## Front end

| Field | Type | Rule |
| --- | --- | --- |
| `name` | string | `cli`, `web`, `claude-mod`, `herdr-mod`. |
| `ownViews` | list of operation names | Each name must be in the catalog. |
| `hidden` | list of (operation name, shown in) | An operation that this front end cannot show. The `shown in` value names a front end that shows it. |

## Gap entry

One line in `parity-gaps.json`.

| Field | Type | Rule |
| --- | --- | --- |
| `op` | operation name | Must be in the catalog. |
| `frontEnd` | front end name | |
| `bead` | bead id | Must be open (`factory parity` checks it on the laptop). |
| `reason` | string | |
