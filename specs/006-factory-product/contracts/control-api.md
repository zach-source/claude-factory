# Contract: Product control interface

## Compatibility and transport

Extend spec 004's `/v1` worker/client surface. New implementations route existing CLI and plugin operations through the same handlers; do not shell out with user-provided strings. Public reads are authenticated and side-effect free. JSON response envelopes contain `schemaVersion`, `factoryId`, `revision`, `observedAt`, and `data`; existing command outputs remain compatible at the CLI adapter.

Owner HTTPS origin: Envoy requires a certificate signed by the owner CA, validates expiry, and uses `SANITIZE_SET` for XFCC. The application accepts exactly one verified fingerprint on its loopback-only owner listener, maps it to an enabled owner principal, and checks revocation per request. The worker/manager listener ignores and rejects owner forwarding headers. No public route reaches the internal listener. Agents run outside this pod and have neither owner key nor storage access.

Browser mutations require `Content-Type: application/json`, `X-Factory-Intent: operator-ui-v1`, exact allowed `Origin`, and same-origin Fetch Metadata where present. CLI requests use `X-Factory-Intent: operator-cli-v1`; absent Origin is allowed only with the non-simple intent header and a valid owner certificate, never for cross-site Fetch Metadata. Reject cross-origin CORS preflight. Do not use ambient cookies or accept HTML form submissions as commands. Origin checks supplement authentication; they do not replace it.

Set a restrictive same-origin content security policy, deny framing, use `nosniff`, and disable sensitive-response caching. Serve only packaged assets or authorized artifact IDs, never arbitrary filesystem paths.

## Command envelope

Every mutation requires `Idempotency-Key` and body `{expectedRevision, ...operationFields}`. Decisions additionally require `decisionId` and `evidenceDigest`. The server derives actor identity from transport credentials, never body fields. Scope keys to stable owner/job/task principal identity, not a transient connection.

- Accepted: `202 {commandId,status:"accepted",targetRevision}` after durable commit. A synchronous completed command can return `200` with the same record shape.
- Duplicate same body: original command/result, even if its original revision is now old.
- Reused key with changed body, stale revision, or conflicting decision: `409` with safe current context; no new effect.
- Invalid input: `400` or `422`; unauthenticated `401`; forbidden `403`; unknown authorized resource `404`; oversized `413`; bounded request-rate rejection `429`; unavailable persistence `503` without acceptance.
- Pending external work stays pending/unknown until observed. `GET /v1/commands/:id` returns acceptance and execution status separately.

Readiness failures return capability/reason/next-action codes, not raw process output with credentials. Lists use cursor pagination with a default 50 and maximum 200; message bodies default to a 64 KiB limit. Larger artifact uploads are not part of this API.

## Owner reads

| Route | Data |
| --- | --- |
| `GET /v1/board`, `/v1/runs/:id` | Pure current projections and detailed timeline; never call tick as a read side effect. |
| `GET /v1/projects`, `/v1/projects/:id/readiness` | Lossless project configuration and last readiness results; explicit refresh is a command if it triggers probes. |
| `GET /v1/backlog`, `/v1/prs`, `/v1/plan`, `/v1/decisions` | Existing sources with scope, pagination and freshness. |
| `GET /v1/harnesses`, `/v1/settings`, `/v1/health` | Redacted capabilities, settings, compatibility and component health. |
| `GET /v1/metrics`, `/v1/usage`, `/v1/proposals` | Existing metrics/proposals plus accounting coverage. |
| `GET /v1/conversations/:id`, `/v1/commands/:id` | Chat history and resulting references; command outcome. |
| `GET /v1/events?after=<cursor>` | SSE invalidations with durable sequence, resource and revision. Expired cursor returns `409 snapshot_required`; reconnect fetches authoritative state. |

Authorization is rechecked before delivering stream data. Revoke closes affected streams; reconnect cannot bypass revocation. Heartbeats alone do not assert data freshness. Conditional polling uses revision/ETag and a successful freshness check; fallback every 2 seconds only while the client is active.

## Owner mutations

| Route | Fields/effect |
| --- | --- |
| `POST /v1/start` | template, project, bead, goal, optional explicit overrides; readiness and ownership before launch. |
| `PUT /v1/rigs/:id` | Existing compatible rig fields, revision and lossless patch semantics; UI calls these projects. |
| `DELETE /v1/rigs/:id` | Reject unresolved active work; preserve history. |
| `POST /v1/runs/:id/mail` | target and text; record pending delivery until observed. |
| `POST /v1/runs/:id/retry`, `/goto`, `/abort`, `/harness` | Current revision, target station/profile when applicable; confirmed termination before replacement. |
| `POST /v1/halt` | scope factory/project and mode pause/resume; compatibility maps existing stop to pause-new-admissions, not cancel-all. |
| `POST /v1/runs/:id/decide`, `/v1/decisions/:id/answer` | Exact decision/evidence, outcome, note; one atomic answer plus effect intent. |
| `PUT /v1/settings/harnesses/:id`, `/v1/settings/budgets/:id` | Protected references and validated accounting/capabilities; defaults affect future runs. |
| `POST /v1/conversations/:id/messages` | User text and context references; creates a manager job, not blanket approval. |
| `POST /v1/attention/:id/ack` | Read/ack state only. |
| `POST /v1/proposals/:id/install`, `/reject` | Existing proposal validation and revision; no new proposal store. |
| `POST /v1/migrations/preview`, `/:id/execute`, `/:id/rollback` | Preview is non-mutating to source execution; execute/rollback require explicit current owner command and reconciled ownership. |
| `POST /v1/diagnostics/preview`, `/export` | Redacted selection; default excludes source/transcripts; no upload. |

## Worker and manager roles

Retain 004 worker report/mail/memory/usage/progress routes and signed per-task identity. Token claims include factory, task, run/job, station/attempt where relevant, role, expiry and unique revocable ID. A server checks both signature and active task/attempt status. A request body cannot widen scope; old attempts are refused. Durable worker outbox entries retain request IDs across retries and are removed only after recorded acknowledgment.

Manager jobs use a separate scoped principal and only allowed query/start/queue/mail/retry/propose operations, filtered by configured project and action policy. They cannot access owner listener, decide, credential administration, migration, production cutover, or owner-only proposal installs. Worker tokens cannot start work or change project configuration. Return structured refusal for unknown actions; never interpret a command string from the model as an owner command.

## Required contract cases

Same-key duplicate and changed-body conflict; stale target/evidence; simultaneous opposite answers; no-cert/wrong-CA/expired/revoked cert; forged XFCC; direct internal listener attempt; worker-to-owner and cross-run attempts; manager claimed approval; cross-origin form/fetch/preflight; stream revocation; storage unavailable; lost launch response; event-cursor gap; malicious artifact/link/text input; unknown cancellation; delayed old report. Each case must name its expected refusal or durable result.
