# Research: factory server

Phase 0 of the plan. Each item gives the decision, the reason and the alternatives. The facts come from the code map of 2026-10-26 (file:line references) and two research passes.

## R1. Worker identity

**Decision**: The server identifies a worker by its AX task name (`f-<run>-<seq>`). The server already records the run, node and seq for each task at launch, so the task name gives all three. Step 1 proves the task name with a signed token. A later step proves it with an AX task SVID.

- Step 1: at launch, the server signs a token (HMAC-SHA256, server key) over `{task, run, node, seq, exp}`. It puts the token in the task env as `FACTORY_TOKEN`. The worker CLI sends `Authorization: Bearer <token>` over the normal `https` egress rule. The server checks the signature, the expiry and the `worker_tokens` revocation row.
- Later step: AX issues each task an X.509 SVID (AX `docs/roadmap.md`, "SPIFFE Identity for Tasks"). The egress gateway makes its upstream connection to the factory server with the task's SVID. The server accepts the SPIFFE ID in place of the token, and maps it to the task name.

**Rationale**:
- The AX egress gateway decrypts every HTTPS request from a VM and makes its own upstream TLS connection (`src/ax.ts:289-290`, `src/worker.ts:990,1040`, `docs/remote-runner.md:174`). A client certificate in the VM reaches the gateway, not the server. Per-task mTLS from the VM cannot work as AX works today.
- AX has no task identity today. Its roadmap names SPIFFE task identity as future work.
- A token in the task env gives the same scope as a per-task key in the task: the VM holds the secret in both cases, and both allow only that run, station and seq.

**Alternatives considered**:
- TLS passthrough in the gateway for the factory host: keeps VM-side mTLS, but removes gateway inspection for that host and needs gateway work first.
- A per-task secret header that the gateway injects from the vault (as `DOLT_BASIC`): the VM never sees it, but agent-vault has no per-task keys today.

## R2. Person identity

**Decision**: The server has a second listener on port 8444. This listener requires a client certificate from a person CA. It uses `Bun.serve` with `tls.requestCert: true` and `rejectUnauthorized: true`, and `ca` = person CA. A connection that completes the handshake on that port is the person. The laptop reaches it on the LAN through the cluster gateway, not through the AX egress gateway.

**Rationale**: The factory has one owner. `Bun.serve` can require and check a client certificate, but its request handler cannot read the certificate (`bun-types` `bun.d.ts:4653-4660`; Bun `node:https` lacks `getPeerCertificate()`, `docs/runtime/nodejs-compat.mdx:52`). With one listener for each role, the server does not need to read the certificate. Workers cannot reach port 8444 with a person certificate, so FR-011 holds.

**Alternatives considered**: a TLS sidecar (ghostunnel or Envoy) that forwards the certificate subject in a header. Add it when there is more than one person.

## R3. Manager steps

**Decision**: Each judgment step runs as headless Claude Code (`claude -p`) with a subscription OAuth token slot, the same way the workers run (owner decision 2026-10-26). A small wrapper in the server gives each step:

- a fixed tool list (`--tools`), `--strict-mcp-config`, no plugins, and an isolated config dir (`CLAUDE_CONFIG_DIR`);
- a time limit (the server kills the process);
- `--output-format json`, for the result text and the usage;
- the token slot from the broker's `POST /token/best` (`src/broker.ts`), and a swap when a step ends on a usage limit (the same `limitHit` rule as `src/cli.ts:1735`).

**Rationale**: Anthropic's docs say that developers who build with the Agent SDK "should use API key authentication" (code.claude.com/docs/en/legal-and-compliance). Headless Claude Code with the owner's own subscription is the use the workers already make. The patrol, briefer, reviewer and pm already run as Claude sessions with fixed tools (`mod/hooks/register.tsx:1346-1393`), so their prompts need little change.

**Alternatives considered**: the Agent SDK with an API key (clear terms, per-token bill); the Agent SDK with the OAuth token (unclear terms).

## R4. Where the server runs and how workers reach it

**Decision**: Namespace `factory`, a Deployment with 1 replica and the `Recreate` strategy, a PVC, and a Service. The pattern is the broker's (`deploy/broker.yaml`: ServiceAccount, RBAC, NetworkPolicy, `oven/bun:1.3.13-debian` image). VM workers reach the Service through an `https` egress rule that `egressPolicy` adds for every task (`src/ax.ts:398-476`). The server's TLS certificate must be one that the gateway trusts upstream. The gateway already trusts the cluster CA for the kube API (`docs/remote-runner.md:151`).

**To verify in spike S0**: an `https` egress rule to an in-cluster Service, with a server certificate from the cluster CA, gets through the gateway.

## R5. What moves from the laptop to the server

The code map lists what a tick for an AX run uses from the laptop. Each item needs a server form:

| Laptop dependency | Use today | Server form |
|---|---|---|
| herdr | `createRun` makes a herdr worktree for every run, AX too, and fails without herdr (`src/cli.ts:5354-5373`) | Skip herdr for an AX rig. This is a fix in the current code (step S1). |
| The laptop worktree | The push source before a launch and the pull target after a report (`src/cli.ts:1397-1414`, `:746`), and the bd sync dir | A clone cache for each rig on the PVC. |
| Rig `repo` paths | Local checkouts | A clone URL in the rig. `mapRigs` already rewrites paths when `FACTORY_IN_AX=1` (`src/axrepos.ts:24-26`). |
| `gh` | The laptop's gh login (`src/cli.ts:2905`, `:3377`, `:4275`, others) | A GitHub token in a Secret. A GitHub App needs an owner step. |
| bd | The laptop shared Dolt server; sync with `CALL DOLT_PUSH/PULL` (`src/cli.ts:550-571`) | The fleet Dolt server is the primary copy (owner decision). The server runs bd against it. |
| Linear | The macOS Keychain (`src/linear.ts:108-150`) | A Secret. |
| Self-update, config sync, home backup | Git in the laptop checkout (`src/selfupdate.ts`, `src/cli.ts:3799-3814`, `src/homebackup.ts`) | Self-update becomes an image roll. Config sync and home backup run from the PVC. |
| `kubectl`, `ax` | The laptop kube context | The server's ServiceAccount. Policies go through the broker, as for the AX manager. |

## R6. State store

**Decision**: Step S2 runs the server on the current file layout, on the PVC, with the server as the one writer. Step S6 moves the state to a `factory` database on the fleet Dolt server (owner decision), after the fleet server runs Dolt 2.5.0 (dolt-maintenance bead dm-g14).

**Rationale**: The tick and its passes read and write files in about 40 places (`src/cli.ts`). If the whole state moves in the same step as the cluster move, one cutover carries two large risks. With the file layout first, the CLI code runs in the pod unchanged, and the worker API calls the same functions (`post()`, `memory.add`).

**To verify in spike S0**: Bun 1.3.13 `Bun.SQL` connects to Dolt over the MySQL protocol. If it does not, use `mysql2`. No SQL client is in production code today; Dolt is reached through the `dolt` CLI (`src/cli.ts:563-571`).

## R7. The console and the CLI

**Decision**: The CLI gets one switch. When `FACTORY_SERVER` is set, each command calls the client API. When it is not set, the CLI works on the local factory home, as today. The `mod` plugin calls the CLI (`mod/hooks/register.tsx:362-367`), so the console works through the server with no change to its views. Its timers (tick, patrol, pm, briefer, reviewer) stop when `FACTORY_SERVER` is set, because the server runs them.

## R8. Order of the laptop rigs and the server

**Finding**: Constitution I needs one worker path. After the cutover the laptop has no factory home, so a laptop herdr worker has nowhere to report. The four laptop rigs must move to AX before the cutover (step S1), or stop them during the cutover.
