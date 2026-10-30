# Spikes S0a-S0d: factory server (claude-factory-xbzd)

On 2026-10-29, the spikes used Bun 1.3.13, dolt 2.6.0 and Claude Code 2.1.291. The spike code is in `.scratch/`. It is not committed. The spikes did not apply anything to a cluster.

## S0a

**Question**: how does a VM reach an in-cluster factory server?

**In-cluster services that a VM reaches today**:

| Service | Scheme | Where it is written |
| --- | --- | --- |
| kube API (`https://kubernetes.default.svc.cluster.local`) | https, cluster CA signs the server; the gateway re-signs for the VM | `docs/remote-runner.md:153` |
| Dolt remotesapi (`beadsRemote.url`) | https, a certificate that the gateway's upstream trust accepts (the Fleet CA) | `docs/remote-runner.md:125` |
| Nix binary cache (`FACTORY_NIX_CACHE`, port 8443) | https, Fleet CA | `docs/remote-runner.md:129` |
| AWS broker (port 8443) | https, Fleet CA | `docs/remote-runner.md:158`, `:163` |
| pkg-gate (`FACTORY_AX_PKG_GATE`) | plain http, port 8080 | `deploy/pkg-gate.yaml:11-14`, `docs/remote-runner.md:179`, `src/ax.ts:359` (`gateRule`), `src/ax.ts:553` |

The spec cites `docs/remote-runner.md:151` for the kube API. In this tree the text is at line 153.

**Why https is the rule**: The egress gateway replaces a placeholder with a vault credential. It does this only on HTTPS that it intercepts (`docs/remote-runner.md:125`, `:179`). The pkg-gate uses http. Its egress rule has no `key`, so the gateway injects nothing (`deploy/pkg-gate.yaml:11-14`).

**Decision**: Serve the factory API over https with a Fleet-CA certificate. A VM then holds only a placeholder token. The gateway replaces the placeholder with the real token.

The http fallback means that the VM holds the real token. The gateway cannot inject over http. Use the http fallback only for a route that does not need a token. The cluster-side steps (Service, certificate, NetworkPolicy, egress rule) are owner steps in S2. This spike does not do them.

## S0b

**Question**: can `Bun.SQL` drive a Dolt server?

**Setup**: `dolt init` in `.scratch/dolt/db`, then `dolt sql-server --port 3399`. Client: `new SQL('mysql://root@127.0.0.1:3399/db')`.

| Statement | Result |
| --- | --- |
| `SELECT dolt_version()` | `2.6.0` |
| `CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))` | ok |
| `INSERT` two rows | ok |
| `SELECT * FROM t` | `[{id:1,v:"a"},{id:2,v:"b"}]` |
| `SELECT` with a bound parameter (`${2}`) | `[{id:2,v:"b"}]` |
| `CALL DOLT_COMMIT('-Am','first')` | `[{hash:"k9g5..."}]` |
| `db.begin` that throws after an `INSERT` | error reaches the caller; row count stays 2 (rolled back) |
| `db.begin` that returns | row count 3 (committed) |
| `CALL DOLT_COMMIT('-Am','second')` | `[{hash:"s927..."}]` |
| `SELECT message FROM dolt_log` | `second`, `first`, `Initialize data repository` |
| `SELECT * FROM dolt_status` | empty after the commit |

**Decision**: use `Bun.SQL`. It needs no dependency. Every statement worked, including transactions and Dolt procedures.

## S0c

**Question**: Can one judgment step run as `claude -p` with JSON output?

**Command**: `claude -p --output-format json --tools Read --strict-mcp-config --max-turns 2 "Reply with exactly the word: pong"`, with the existing login. No credential file was read.

**Exit code**: 0.

The JSON output has these **top-level keys**:

- `type`
- `subtype`
- `is_error`
- `result`
- `stop_reason`
- `terminal_reason`
- `api_error_status`
- `num_turns`
- `session_id`
- `uuid`
- `total_cost_usd`
- `duration_ms`
- `duration_api_ms`
- `usage`
- `modelUsage`
- `permission_denials`
- `fast_mode_state`
- `subagent_stats`
- timing keys (`ttft_ms` and others)

| Key | Value in the run |
| --- | --- |
| `result` | `pong` |
| `is_error` | `false` |
| `subtype` | `success` |
| `terminal_reason` | `completed` |
| `api_error_status` | `null` |
| `stop_reason` | `end_turn` |
| `usage` | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` (plus detail keys) |
| model | there is no top-level `model` key. The model is the key of `modelUsage` (`claude-opus-5-5[1m]`) |

**Timeout kill**: `timeout -s TERM 2 claude -p ...` exits with status 124. Stdout and stderr hold 0 bytes. The caller must treat empty stdout as a failed step, not as an empty answer.

**Usage limit**: not observed. To force a limit, you must spend the account's quota. So the spikes did not verify this part.

The code needs these items:

- `limitHit` (`src/cli.ts:1927`) reads a transcript line. It returns `kind: 'auth'` for `error === 'authentication_failed'` or status 401.
- It returns the `rateLimitType` from `quotaLimits` when the status is `rejected`.
- For text, it uses the regexes for `weekly`, `session limit` and `5-hour`. `resetsAtFromText` (`src/cli.ts:1907`) reads `resets 3pm (UTC)`.
- The JSON result contains `is_error` and `api_error_status`, and you can expect the refusal text in `result`.

Map as follows. Confirm this on the first real case.

- If `is_error` is true and `api_error_status` is 401, the mapping gives `auth`.
- If `is_error` is true with 429, or `result` has a limit text, the code uses the same regexes and `resetsAtFromText`. Set `at` to the time of the call.

`quotaLimits` is a transcript field. It is not in the JSON result. So `resetsAt` comes only from the text.

**Decision**: A judgment step as `claude -p --output-format json` works. Examine `is_error` and `subtype`. Read `usage` for the usage report. Give each call a timeout.

## S0d

**Question**: can `Bun.serve` require a client certificate on a second port?

**Setup**: The openssl test CAs are in `.scratch/tls`. They are a person CA and an other CA. The directory also has one client certificate from each CA and a self-signed server certificate. Port A `4401` has plain `tls`. Port B `4402` has `tls: { ca: person-ca, requestCert: true, rejectUnauthorized: true }`.

| Request | Port | Result |
| --- | --- | --- |
| no client cert | A | 200 |
| no client cert | B | refused (connection closed; curl: `alert certificate required`) |
| other-CA cert | B | **200 (not refused)** |
| person-CA cert | B | 200 |

**Finding**: `Bun.serve` requires some client certificate, but it does not check the chain against `ca`. A certificate from the other CA passes. I tried `ca` as a string and as an array, with `fetch`, curl and `openssl s_client`. All gave the same result. `node:https` under Bun behaves the same way.

**Peer certificate**: the `Bun.serve` handler cannot read it. The `Request` and the server object have no peer-certificate API. `server.requestIP(req)` gives only the address. In `node:https` under Bun, `req.socket.getPeerCertificate()` returned `{}`.

**What works**: `node:tls` `createServer({ ca, requestCert: true, rejectUnauthorized: false }, socket => ...)` under Bun. `socket.authorized` and `socket.getPeerCertificate().subject.CN` are right. The person-CA client gave `authorized=true, cn=person-client`. The other-CA client gave `authorized=false, UNABLE_TO_VERIFY_LEAF_SIGNATURE, cn=other-client`.

**Decision**: do not use `Bun.serve` `requestCert` as the person gate. Pick one of these for S2:
1. Terminate client-certificate TLS in `node:tls` and check `socket.authorized` for each connection, or
2. Verify the chain against the person CA in the handler (the peer certificate must then reach it), or
3. Put the person port behind a proxy that checks the client certificate (the mesh or an ingress).

Option 1 is the smallest change. It is untested with HTTP framing on top and must be proven in S2.
