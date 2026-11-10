# ADR: Server jobs for pm, brief, and review

## Context

Bead: `claude-factory-juo9t`. Plan base: `4323f250`.
FR-008 in `specs/004-factory-server/spec.md` requires server agent steps.
`src/server.ts:158` shares a job helper between backup and patrol.
`src/cli.ts:13721` starts the isolated patrol child.
`src/once.ts:467`, `:551`, and `:569` already implement pm, brief, and review through `runStep`.
The server does not start those three commands.

## Decision and design

Add `factory server --agent-steps 1`. The default is `0`.
This flag enables pm, brief, and review together. It does not change the patrol flag or dream policy.
Keep the interval for pm fixed at 3,600,000 ms. The first attempt occurs one hour after server start.
A restart resets that timer. Do not add catch-up work or a persistent timer.
Use an injected interval in `serve` tests; do not expose another production flag.

Extend the existing job helper in `src/server.ts` with an explicit trigger for accepted ticks.
The timer and tick paths must share the same pending, lease, stop, and failure checks.
Do not add a second scheduler or put this policy in a front end.
On each successful, non-busy tick, persist the current board before any brief or review child starts.
Preserve `keepTick` mail behavior when patrol is on.
When only agent steps are on, save `manager-tick.json` without duplicate mail or an unused mail queue.
Share the existing board-write operation from `src/once.ts` if necessary.

Trigger brief when the board has a gate without a brief.
Trigger review when the board has a pending review.
The existing once commands select one candidate and consult their attempt logs.
Retain their oldest-gate order, review-key order, and failed-attempt deduplication.
A repeated eligible board can start a no-op child; it must not repeat a model call for an attempted key.
Do not trigger from a stale board after a busy or failed tick.
Do not start new jobs while the board reports a halt.
Different job kinds can run together. Each kind must have at most one child at a time.

In `src/cli.ts`, share the patrol child launcher with the three new fixed command arrays.
The arrays are `[CLI, 'pm', '--once']`, `[CLI, 'brief', '--once']`, and `[CLI, 'review', '--once']`.
Use `kickEnv`, remove inherited `FACTORY_LEASE_HOLDER` and `FACTORY_LEASE_KIND`, and set `FACTORY_STEP_ISOLATE=1`.
Retain the child's existing manager lease checks and the server-parent lease identity.
No board field supplies a command, argument, path, model, or tool name.
Add a kill callback for each new child. Stop must cancel future triggers and signal each active new child.
This work does not promise process-group cleanup; the existing patrol limitation remains.

Keep pm, briefer, and reviewer tool sets empty in `STEP_SPECS`.
Keep their models, timeouts, turn caps, strict MCP mode, and `FACTORY_PATROL=1` behavior.
Keep local `--once` behavior and the person-only gate decision unchanged.
The child does not install or reject a proposal; review only records a recommendation.

### Dream exception

Retain the separate dream runner, as the bead explicitly permits.
`src/cli.ts:8036` already calls `kickDream` from tick; `:6809` checks its stamp and lock.
Dream has a memory transaction around its model call, not just a text response.
Preserve `dream.lock`, daily/full-inbox cadence, failed-attempt stamp, 45-minute timeout, and memory commit order.
Preserve nested Git checks, symlink cleanup, HEAD checks, repository-config checks, and the proposal cap.
Preserve Claude memory permissions and Codex workspace sandbox, network refusal, and environment allowlist.
`runStep` currently has no equivalent adapter for those two runners and their post-call checks.
A conversion would enlarge this task and can weaken those controls.
Do not add another dream timer, change dream credentials, or claim dream writes `agent-steps.jsonl`.
Dream retains `dream.log` and `manager-usage.jsonl` evidence.
The credential bead already owns the decision about automatic dream and wiki access.
Correct any claim in `docs/server.md` that the server does not start dream.

Expected code files: `src/server.ts`, `src/cli.ts`, and a small board-write extraction in `src/once.ts` if needed.
Expected tests: `src/server.test.ts`, with `src/once-cli.test.ts` or `src/steps.test.ts` only where needed.
Update server help, `docs/server.md`, and one bullet at the end of Unreleased in `CHANGELOG.md`.
No deployment, credential, `.factory/`, frontend, or database change belongs to this task.

Rejected alternatives: another scheduler duplicates lease and overlap logic.
Direct model calls bypass the existing step policy and logs.
Always-on jobs change costs and authority before the live prerequisites pass.
Four separate flags add controls without a present need.

## Acceptance criteria

Prefix new tests with `juo9t ACn`.
Run each named test with `bun test --timeout 30000 src/server.test.ts -t 'juo9t ACn'`.

1. **AC1: Explicit flag.** Test `juo9t AC1 flag grammar`.
   Accept only one `--agent-steps` pair with the exact value `0` or `1`; omission means `0`.
   Reject missing values, duplicates, other values, unknown flags, and positional text before any child or listener starts.
   Keep the existing server flag grammar, numeric constraints, and TLS path rules unchanged.
   No shell-command or external-config parser is added. Arbitrary command strings and path forms are out of scope.
   Process tests must prove zero child calls on rejected input and zero new jobs when the flag is off.

2. **AC2: Hourly pm.** Test `juo9t AC2 pm cadence` with a controlled clock or injected short interval.
   Assert no attempt before the first interval, one at the boundary, and another after the next interval.
   Assert production wiring uses 3,600,000 ms.
   Deny attempts without the server lease, during a halt, during a pending pm, and after stop.
   A rejected child promise must log failure and permit the next interval.

3. **AC3: Fresh tick work.** Test `juo9t AC3 tick candidates`.
   A gate without a brief triggers brief; a pending review triggers review; both can trigger together.
   Assert the child reads the board from that tick, including when patrol is off.
   Empty, already-briefed, busy, failed, halted, and lease-lost ticks must start no corresponding child.
   Repeated keys must produce no second model call. A new gate visit or review key must remain eligible.
   Use the existing attempt-log policy for failed keys; do not introduce automatic retry behavior.

4. **AC4: Process evidence and isolation.** Test `juo9t AC4 server step rows` for pm, briefer, and reviewer separately.
   Use a disposable home, fake Claude stream, real server command, and valid facts and answers for each step.
   Assert an `outcome: ok` row with the correct step in `agent-steps.jsonl` for each model call.
   Assert the command child receives `FACTORY_STEP_ISOLATE=1`.
   Assert the model receives the step HOME and config directory, empty tools, strict MCP, and `FACTORY_PATROL=1`.
   Assert the model receives neither `FACTORY_SERVER` nor `FACTORY_STEP_ISOLATE`.
   Assert no inherited lease identity, person gate action, proposal install, or proposal reject occurs.
   Repeat with the flag off and assert zero new step rows.
   Preserve existing local once tests and their nonisolated behavior.

5. **AC5: Lifecycle.** Test `juo9t AC5 job lifecycle` for each new job.
   A pending child prevents overlap of its own kind; another kind can proceed.
   Child failure does not stop ticks or other jobs. A later eligible trigger can run.
   Stop calls each active child's kill hook and starts no later child.
   Lease loss prevents new jobs. Two server holders on one home must not both start jobs.
   Existing backup and patrol tests must remain green.

6. **AC6: Dream exception and regressions.** Review this ADR and the corrected server documentation.
   Run `bun test --timeout 30000 src/memory-dream` to preserve the dream guards and both runners.
   No new dream spawn, tool grant, timer, or credential change is allowed.
   Run `bun test --timeout 30000 src/steps.test.ts src/once-cli.test.ts src/review-cli.test.ts`.
   Existing invalid model answers, stale gate keys, and attempted review keys must retain their refusals.

## Test plan

Commit the AC1 through AC5 regression tests first. Record their expected failures against the plan base.
Use the patrol process fixture in `src/server.test.ts:655` as the starting point.
Strip `FACTORY_OUTBOX` and `FACTORY_FROM`; set `FACTORY_SELF_UPDATE=0` and `FACTORY_NO_KICK=1` in test children.
Never use a real token or a live home. Use valid fixtures so an infrastructure failure cannot mimic a regression.
Then implement the jobs and run AC1 through AC6.
Before handoff, run `bun run test`, `bun run typecheck`, and `bunx prettier@3.9.9 --check .`.
Run `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
Run the repository made-worse gate before ready; retain exact-head required CI evidence for test, typecheck, plugin, and format.
Do not ship red required checks. Report local tool gaps separately from CI results.

## Risk

This work is security-sensitive: it starts model processes with untrusted facts and inherited server context.
The isolation marker is not an OS security boundary. Empty tool sets do not grant authority to decide gates.
The credential and file-access fixes must precede live activation.
No data migration exists. Current plan, brief, review, and step log formats remain unchanged.
The shared flag defaults off, so existing server command lines keep their present behavior.
Dream remains an existing access risk; this change neither adds dream calls nor grants dream credentials.
Security-sensitive: yes (child permissions, credential isolation, untrusted model facts)

## Rollout and rollback

Merge code with `--agent-steps` absent from deployments.
Do not enable live jobs in this run.
Live activation depends on `claude-factory-cu2yf` and `claude-factory-t54il`, plus review and security approval.
The credential bead must also resolve its dream/wiki access decision before activation.
A person must approve the exact live change. This plan supplies no such approval.
To stop the new jobs, the owner restores `--agent-steps 0` and restarts through the approved deployment path.
Code rollback uses a revert PR. No log or state removal is necessary.

## Observability

The future activation soak must see its own pm, briefer, and reviewer rows in `agent-steps.jsonl`.
Mark that activation check **must-see-live**; a deadline alone cannot establish health.
Supply eligible test work through an approved path, then match timestamps and keys in the existing per-step logs.
Check `pm-log.jsonl`, `brief-log.jsonl`, and `review-log.jsonl` for successful application, not just model success.
Check `/healthz` for continued ticks and the expected lease holder.
Check that no duplicate call occurs for the same brief or review key.
Dream evidence remains in `dream.log` and `manager-usage.jsonl`.
These live reads belong to the later authorized soak, not pre-merge acceptance.

## Tasks

1. T1, `claude-factory-juo9t.1`: Add AC1 through AC5 tests first. One test commit; record red baseline evidence.
2. T2, `claude-factory-juo9t.2`: Add the flag, shared triggers, board persistence, and isolated children. One implementation commit; pass AC1 through AC5.
3. T3, `claude-factory-juo9t.3`: Correct server docs and help, add the changelog bullet, and verify AC6. One completion commit; run all required checks.

Order T1 before T2 before T3. Target one 120-minute implement pass.
The test commit and its fix must ship in one PR. This ADR is the plan station's only tracked change.
