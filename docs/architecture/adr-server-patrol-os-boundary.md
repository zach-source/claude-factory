# ADR: Require an OS boundary for the server patrol

## Context

Bead: `claude-factory-axo88`. Base: `51f342a3`.

The server starts `factory patrol --once` in its own container at `src/cli.ts:13723`.
The child can read server secrets through files and `/proc`.
Tool hooks cannot enforce an OS boundary when a hook fails to start.
The pod drops capabilities, so a child cannot establish a new uid boundary.
The client API treats every client certificate as an owner at `src/server-api.ts:364`.
The patrol reads local state at `src/once.ts:380`.
Its lease uses the server parent pid through `src/lease.ts:70`.

## Decision and scope

Use a separate patrol pod for the final design.
Do not share the server home, PID namespace, ServiceAccount, or secret volumes.
Use server-side patrol authorization and a remote lease before any patrol action.
Keep model credentials outside the tool process through a constrained model proxy.
The patrol receives only its own scoped API identity and a bounded model capability.
Those capabilities are credentials; do not describe the patrol as completely credential-free.
It must have no server credentials or provider login files.

The full change exceeds one 120-minute implement pass.
This run supplies the first part: refuse the unsafe server patrol path.
Dependent beads supply the API, then the container boundary and model transport.
The final bead supplies isolated evidence and the owner activation procedure.
Completion of this run does not prove the OS boundary or permit activation.

For this run, retain `--patrol-every-ms 0` for compatibility.
Refuse every nonzero patrol interval before the server starts.
The error must state that server patrol needs an isolated runner.
Remove the local patrol child closure from `src/cli.ts`.
Remove its unused callback parameter and dispatch from `server.main` in `src/server.ts`.
Retain the internal `serve` job mechanism and its concurrency tests for later remote use.
Keep local `factory patrol --once`, the mod patrol, and their existing checks.
Keep the default server, tick, backup, health, and owner client API behavior.
Update `docs/server.md` to remove instructions that enable the unsafe timer.
Keep `--patrol-every-ms` absent from `deploy/server.yaml`.
Do not change `.factory/`, `factories/`, credentials, or live infrastructure.

This refusal is a migration guard, not a sandbox for arbitrary local commands.
Direct shell access to the server container remains outside this first part.
The later pod must enforce the boundary even when every tool hook is absent.

Rejected alternatives:

- More path hooks leave same-uid file and process access intact.
- A uid switch needs capabilities that the pod does not have.
- A sidecar shares pod network access to server listeners and cannot have its own NetworkPolicy.
- A person certificate gives the patrol owner rights and cannot serve as its identity.
- A provider login file inside the patrol pod remains readable by its tools.
- The full migration in one pass combines four security boundaries without enough time for evidence.

## Acceptance criteria for this run

### AC1: Closed server flag grammar

Proof: `bun test --timeout 30000 src/server.test.ts`, tests named `axo88 AC1`.

The existing parser consumes an array of alternating flag and value strings.
It reads these numeric flags: `--port`, `--every-ms`, `--lease-ms`, `--client-port`, and `--patrol-every-ms`.
Numeric tokens contain decimal digits only; retain existing port and lease constraints.
It reads these path flags: `--tls-cert`, `--tls-key`, and `--person-ca`.
Paths remain opaque, nonempty strings that do not start with `--`.
The client port and all three paths must occur together.
Unknown flags, repeated flags, missing values, and positional arguments remain invalid.
There is no shell expansion, path resolution, config-file parse, or render in this parser.
Equals syntax, environment prefixes, shell strings, and argument files are outside its grammar.

The fail-closed rule is: server patrol interval must equal zero after the existing decimal parse.
Allow an absent interval, `0`, and `000`.
Deny `1`, `200`, `60000`, and a decimal value that overflows to Infinity.
Deny `-1`, `NaN`, `Infinity`, `1e3`, `0.0`, empty values, and duplicate interval flags.
Reject unknown and malformed forms before any downstream call.
Retain permitted TLS path and normal server flag rows.
Do not broaden another flag's grammar in this run.

### AC2: Refusal precedes server effects

Proof: `bun test --timeout 30000 src/server.test.ts`, tests named `axo88 AC2`.

Call `server.main` with a positive interval and spies for its downstream effects.
Assert zero calls to listeners, tick, backup, model spawn, and patrol state writes.
Use valid client flag structure with nonexistent certificate paths to prove refusal precedes file reads.
Use the existing real CLI fixture with a fake Claude executable and fresh home.
The CLI must exit nonzero with the isolated-runner refusal, without timeout or signal termination.
Assert no fake-model marker, server lease, patrol lease, or agent-step row.
Assert the seeded patrol mail file remains byte-for-byte equal.
An after-exit port probe alone does not prove zero listener calls; retain the direct spies.
Strip inherited factory worker, server, outbox, and main-chat variables from permitted subprocess tests.
Set `FACTORY_SELF_UPDATE=0` and await every child in test cleanup.

### AC3: Preserve supported behavior

Proof: `bun test --timeout 30000 src/server.test.ts src/once.test.ts src/steps.test.ts src/lease.test.ts`.
Name new tests `axo88 AC3`.

A default server and an explicit-zero server must answer `/healthz` and complete a tick.
Neither server may start a model or consume patrol mail.
Retain backup, owner client API, lease conflict, job non-overlap, failure recovery, and shutdown tests.
Retain local patrol success, model-start failure, usage-limit retry, and mail retention tests.
The existing enabled-server test must become an explicit refusal test because this contract changes.
Do not skip that test or remove its model marker and mail assertions.
Do not weaken internal scheduler tests to accommodate the production-path removal.

### AC4: Documentation and complete checks

Proof: `bun run test`, `bun run typecheck`, and `bun run format:check`.
Also run `gitleaks detect --log-opts=origin/main..HEAD` and `bun audit`.
Required CI checks must pass on the final PR head: test, plugin, typecheck, and format.
Report local tool gaps plainly; cite exact-head CI for the corresponding check.
Inspect `git diff origin/main -- deploy/server.yaml` and `rg -n 'patrol-every-ms' docs/server.md deploy/server.yaml`.
The deployment must have no change and no patrol activation flag.
The docs must state the refusal, dependent work, and owner gate.
No AC in this first part is must-see-live.

## Test plan

Write and commit the AC1 and AC2 regression tests before the implementation.
Run them on the old code and record assertion failures, not hook refusals or tool failures.
Then implement the refusal and remove the production spawn path in a second commit.
Run AC1 through AC4 on that final head; intermediate red tests must not reach a ready PR.
After the fix commit, use `factory mutate` to replace the zero-only condition with the old positive-interval rule.
The dedicated AC1 test must kill that mutant while the code still compiles.
Run the direct-main and spawned-CLI tests as separate checks of AC2.
Do not mutate by hand across unrelated changes.

## Dependent work: final boundary contract

The follow-up plans must preserve these requirements and define their concrete wire schemas before implementation.
These requirements are not acceptance criteria for this first PR.

1. Patrol API and lease. Use a distinct patrol identity, never the person CA identity or a worker token.
   Authorize on the server before catalog dispatch, idempotency replay, or state access.
   Default-deny all routes and operations absent from the explicit patrol allow set.
   Start with snapshot, scoped run reads, worker mail, and lease operations; add actions only with dedicated authorization tests.
   Deny owner decisions, gates, owned starts, held-run changes, credentials, arbitrary shell, and arbitrary file reads.
   Define exact JSON fields, types, limits, identifier forms, methods, and paths in the follow-up ADR.
   Unknown fields, invalid identity, wrong audience, expired claims, and stale leases must make zero downstream calls.
   Bind every mutation to a server-issued lease generation and idempotency scope.
   Test overlap, expiry, restart, stale completion, identity changes, and mail retention after failed model calls.
   Preserve owner client and worker-token denial behavior.
   Do not expose raw server env, home paths, credentials, or unfiltered logs in snapshots.
2. Isolated patrol runtime. Use a separate Deployment with `automountServiceAccountToken: false` and no host namespaces.
   Mount only its scratch volume and its narrowly scoped identity; never mount the server PVC or secrets.
   Drop all capabilities, forbid privilege escalation, and use non-root uid and default seccomp.
   Restrict egress to the patrol API and model proxy; deny internal health/admin ports and arbitrary destinations.
   Keep the provider credential inside the proxy or existing credential service, outside the tool process.
   The proxy must restrict provider origin, request routes, methods, body size, time, and spend.
   It must reject redirects and arbitrary proxy destinations without outbound calls.
   Do not assume `/token/best` supplies credentials; it changes a slot only.
   No fallback may start a model in the server container or reuse a local server home.
   Reuse existing model transport only after its tests prove these properties.
3. Isolated evidence and rollout. Test with fake secrets, fake provider, real container namespaces, and disabled tool hooks.
   Reads of the worker key, TLS key, backup credential, ServiceAccount token, and server login paths must fail with ENOENT.
   Prove the server process is absent from the patrol PID namespace; scan `/proc` for a fake server-env marker.
   A coincident numeric pid in another namespace is not the server process.
   Check environment key names without secret values; exclude GH_TOKEN, AX_AUTH_TOKEN, LINEAR_API_KEY, and provider credentials.
   Prove allowed API work, denied owner operations, denied direct server access, and denied proxy destination changes.
   Use a checked-in test command with no silent skip when the container runtime is unavailable in CI.
   Keep activation off until the owner approves the exact credential and deploy commands.
   The final soak AC must-see-live: a patrol step from the new pod completes through its scoped API lease.
   Its logs must correlate the pod identity, lease generation, step outcome, and accepted operation without credential values.

## Risk

This work is security-sensitive because it removes a path with access to server secrets.
The first part deliberately refuses a previously accepted positive interval.
A deployment outside this repo that uses that interval will fail to start until its owner removes the flag.
The checked-in deployment has no such flag.
Do not infer the state of a live deployment from that file.
There is no data migration or credential change in this run.
Keep retained mail and local patrol state intact.
The final design adds remote retry and lease risks; its tests must cover duplicate effects and stale completions.
Model proxy access still permits model spend and needs explicit bounds.
No production reads or owner-only steps belong to this plan station.

Security-sensitive: yes (secrets, permissions, server patrol execution)

## Rollout, rollback, and observability

Merge through a draft PR, required checks, review, security, and a person's merge.
Before a production update, the owner must check that their actual server arguments omit a positive patrol interval.
Do not run that live check during pre-merge verification.
Ship this first part with no new flag, credential, manifest, or live apply.
The startup error proves refusal; health and tick tests prove that the zero configuration still works.
After an approved update, the ship soak checks normal health and the absence of local patrol starts.
Do not claim that absence proves the final OS boundary.
The later activation soak needs its own successful isolated step output before it reports healthy.
For rollback, open a revert PR; do not merge or deploy it from this station.
The owner must keep patrol disabled before any rollback that restores the unsafe path.
No state restore is necessary.

## Tasks

1. T1 (`claude-factory-axo88.1`): Add failing AC1 and AC2 tests in `src/server.test.ts`; retain the supported-behavior checks.
   Commit the tests and record pre-fix failures.
2. T2 (`claude-factory-axo88.2`): Refuse nonzero server patrol, remove local spawn wiring, and update `docs/server.md`.
   Run AC1 through AC4 and the mutation check, then commit.

T2 depends on T1. Both tasks fit one 120-minute implement pass.
The separate beads form this dependency chain:
`claude-factory-axo88` → `claude-factory-1ocuv` (API) → `claude-factory-76hg1` (runtime) → `claude-factory-k1c02` (evidence).
The three follow-ups have no factory label; the person controls their priority.
The implementation report must list those unresolved beads; this first part does not complete the full boundary.
