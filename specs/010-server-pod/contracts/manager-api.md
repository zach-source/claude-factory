# Contract: manager identity and new /v1 operations

Covers FR-008, FR-010, FR-011 and FR-019. All operations go into the one catalog (`src/core/catalog.ts`). There is no second interface (spec 008 FR-003).

## Identity

- The manager task shows a client certificate with `CN=manager`, signed by the person CA, on port 8444.
- The pod maps `CN=manager` to the role `manager`. Every other `CN` from the person CA is the role `person`.
- Each catalog operation names the roles it allows (`op.rights`). The pod refuses an operation for a role that is not in the list, with HTTP 403 and the reason. This is the first use of `op.rights`, so it must also work for the existing operations.

## Rights

| Operation group | person | manager |
| --- | --- | --- |
| All reads (`GET /v1/...`) | yes | yes |
| `runs/:id/mail`, `runs/:id/decide`, `decisions/.../answer` | yes | yes |
| `runs/:id/goto`, `runs/:id/abort`, `start` | yes | yes |
| `halt` (stop, resume) | yes | **no** |
| `manager/image`, `server/image` | yes | **no** |
| `rigs/:rig` delete | yes | **no** |
| New patrol operations (below) | yes | yes |
| `manager/say` | yes | no (the manager does not type to itself) |

## New operations

These are the commands that `client.ts:56` refuses in server mode today, and the mod and the patrol prompt use them. One task for each group:

| Route | CLI command today | Kind |
| --- | --- | --- |
| `POST /v1/runs/:id/poke` | `poke` | command |
| `POST /v1/runs/:id/retry` | `retry` | command |
| `POST /v1/runs/:id/fork` | `fork` | command |
| `DELETE /v1/runs/:id` | `rm` | command |
| `POST /v1/queue` | `queue` | command |
| `POST /v1/rigs/:rig/unhold` | `unhold` | command |
| `PATCH /v1/rigs/:rig` | `rig set` | command |
| `POST /v1/sweeps/:name` | `sweep` | command |
| `POST /v1/adopt` | `adopt` | command |
| `GET /v1/memory/search`, `POST /v1/memory` | `memory search`, `memory add` | read, command |
| `GET/PUT /v1/plan/facts`, `PUT /v1/plan` | `plan facts`, `plan set` | read, command |
| `GET/PUT /v1/gate-brief/:run` | `gate-brief facts`, `gate-brief set` | read, command |
| `GET/PUT /v1/review/:run` | `review facts`, `review set` | read, command |
| `POST /v1/manager/log/:kind` | patrol, pm, brief, review log rows; `manager-usage` | command |
| `POST /v1/manager/say` | `say` | command (person only) |
| `GET /v1/manager` | none | read: task health, image, session age, last log rows |

- Mutating calls keep the `Idempotency-Key` rule and the audit of `server-api.ts`.
- `FROM_ALLOWED` (`client.ts:19`) goes away. The role rights replace it.
- Spec 008 epic claude-factory-hpmc plans the catalog. Do not repeat a route that hpmc already has.
