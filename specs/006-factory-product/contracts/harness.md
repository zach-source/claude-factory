# Contract: Harness and manager execution

## Profile and capability contract

A profile declares harness ID/version, supported roles, configured model, credential reference/auth mode, runner compatibility, rule/skill manifest digest, required guard configuration, and qualification record. Existing `Harness` names remain Claude, Codex and Pi; new adapters register explicit descriptors. Do not infer capabilities from executable names alone.

Capabilities: headless execute, inspect, message delivery, confirmed cancellation, native session resume, structured output, usage provenance, required tools/MCP, rules/skills, and isolated role execution. Some are optional per role; capability requirements come from the workflow and permission policy. For example, no native resume permits a fresh linked attempt only after predecessor confirmation, while missing required MCP refuses admission.

Resolve worker profile at run creation in station/project/factory order and store its full non-secret snapshot. Model and auth-mode values are explicitly configured; changing profile defaults does not rewrite running work. A readiness probe records actual binary version, guard status, credential validity result without secret value, and tool/skill availability. A probe failure does not weaken flags or switch provider.

## Adapter operations

| Operation | Input | Required output |
| --- | --- | --- |
| prepare | Role, profile snapshot, context/prompt file, tool manifest, stable attempt/job identity | Validated argv/env references and redacted manifest, or structured refusal. Never interpolate a user shell string. |
| launch | Prepared request and runner identity | Stable task address plus accepted/unknown state; lost response triggers inspect of the same task. |
| inspect | Stable task address and identity | running/waiting/ended/unknown, harness session, available progress/usage, observation time; absence from a listing is not confirmed termination. |
| deliver | Task identity, message ID and text | Pending/confirmed/refused; duplicate message IDs cannot send twice when the transport supports acknowledgment, otherwise uncertainty is surfaced and not blindly retried. |
| cancel | Task identity and command ID | Cancellation request followed by separate observed termination. |
| decode | Bounded output events and expected result schema | Validated result, usage with provenance, wait reason, or malformed-result failure. Raw output is untrusted and redacted before UI/export. |

Reuse `turnArgv`, `sessionIn`, quota parsing, `codexHome`, `CODEX_GUARD_FLAGS`, MCP conversion, and skills materialization. Extract reusable pure functions only as needed; preserve old flags and regression fixtures. A common harness adapter must not let manager code inherit a worker's permission-bypass profile by accident.

## Manager jobs

The service owns schedules for patrol, planner, briefer, reviewer, dream, interview and interactive chat. Each job stores input revisions, timeout, bounded retry policy, tool allowlist, credential reference and permission scope before launch. It runs in an AX task with only its role token and approved egress; no owner certificate, Dolt credentials, cluster-control credentials, or server-state mount.

Input context includes goals, selected backlog, recent durable actions, relevant run summaries, pending decisions, shared rules and evidence references. Prompts live under `src/steps/` and are shared with local-mode plugin agents. Outputs follow a typed result envelope: `summary`, `observations`, `proposals`, `commandRefs`, `decisionRefs`, `usageStatus`. Invalid/missing output is failure, not an empty success. Any performed actions remain separate durable commands even if the final summary is lost.

Agent tool access passes through the same operation policy as the UI. Commands not permitted to that role become proposals or refusals. Free text cannot approve a gate. Manager failure, quota wait, or timeout cannot stop deterministic scheduling, reporting, or operator controls.

## Handoff and credentials

A harness switch cancels/reconciles the predecessor first, then records a new attempt with the same goal and a handoff: workspace commit/revision, completed command/effect references, artifacts, outstanding decisions, applicable rule/skill manifests, and permitted next actions. Redact secrets. Native session IDs are namespaced by harness and cannot be transferred across harnesses.

Only explicitly configured credential-slot rotation or provider/harness fallback is eligible. Record old/new profile, reason, billing source, and configuration revision. Require equivalent permissions/tools and supported budget accounting. If the predecessor's final state is unknown, hold; a quota signal alone does not prove termination.

## Qualification matrix

Claude manager/Claude worker, Claude/Codex, Codex/Claude, Codex/Codex must pass a deterministic multi-station workflow with gate, retry and restart. Also test mixed-station overrides, same-harness resume, cross-harness handoff, unknown cancellation, bad output, expired auth, quota wait, unsupported tool/skill, and a third adapter with deliberate capability gaps.

Pi workers retain local/AX tests and shared rules; Pi management is disabled until its role tests pass. Existing Pi parity work `claude-factory-hg9o` is reused. Live credential checks require explicit fixture accounts and authorized budgets; captured logs never contain credentials. No tests spend quotas deliberately to force a limit.
