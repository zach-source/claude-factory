# Data model: Factory product

## Storage boundary

Extend spec 004's factory database; do not copy Beads or memory Markdown into a second authority. Local-mode file readers/writers remain supported. New server models use a schema version and transactional migrations. Use stable opaque IDs, UTC timestamps, an explicit factory IANA timezone, and monotonically increasing resource revisions. Provider secrets are never model fields: store protected references only.

## Entities and constraints

| Entity | Required fields and relationships | Constraints |
| --- | --- | --- |
| Factory | id, mode, schemaVersion, revision, timezone, paused, managerProfileId, limits | One configured mode per home; no automatic mode switch. |
| Writer lease | factoryId, holderId, epoch, expiresAt | Conditional acquisition/renewal using database time; every mutation validates current epoch. |
| Owner principal | id, certificateFingerprint, enabled, revokedAt | Fingerprint unique; explicit provisioning; evaluate enabled state on every request, including established TLS connections. |
| Project | id, factoryId, repoRef, goal, templateRef, workerDefaults, runner, limits, revision, extraConfig | Preserve unknown advanced fields; server runner must be AX; reject deletion with unresolved active work. |
| Work link | projectId, beadId, claimOwner, runId | Beads owns issue content and claims; validate ownership before admission. No parallel issue store. |
| Harness profile | id, harness, binaryVersion, model, role, credentialRef, authMode, capabilities, manifestDigest, qualifiedAt, revision | A credential reference and account billing source are explicit; role qualification is not inferred from binary presence. |
| Run | id, projectId, beadId, goal, templateDigest, capturedConfig, revision, operationalState, pauseReason | One current operational state. Defaults resolve once; overrides are explicit events. |
| Attempt | id, runId, station, seq, harnessProfileSnapshot, runnerAddress, taskName, sessionId, previousAttemptId, state, reportSeq, startedAt, endedAt | Unique run/station/seq; stable task identity; session is namespaced by harness/version. Unknown termination blocks successor. |
| Command | id, factoryId, principalId, idempotencyKey, bodyHash, targetType/id, expectedRevision, kind, payload, status, result, createdAt | Unique factory/principal/key; same key plus changed body is conflict; response replay returns original command. |
| Effect intent | id, commandId, attemptOrJobId, kind, targetIdentity, requestDigest, state, observation | Stored with accepted state. Reconcile unknown external effects before replay. |
| Event | factoryId, sequence, entityId, revision, type, observedAt, data | Ordered durable cursor; no provider secrets or raw arbitrary executable content. |
| Decision | id, runId or projectId, gateVisitId, targetRevision, evidenceDigest, options, status, answerCommandId | A later gate visit creates a new ID. Only one accepted answer; evidence is a relevant-content digest, not a display timestamp. |
| Decision answer | decisionId, ownerPrincipalId, evidenceDigest, outcome, note, answeredAt | Immutable audit record committed with resulting command intent; execution outcome remains separate. |
| Manager job | id, factoryId, projectId?, kind, inputRevision, contextDigest, profileSnapshot, manifestDigest, attempt, taskName, status, deadline, retryPolicy, result | Role-scoped authority only; stable identity per job attempt; never carries owner certificate. |
| Conversation/message | conversationId, messageId, principalId or jobId, text, commandRefs, decisionRefs, createdAt | Display/history only; text never grants authority. No full transcript dependency for recovery. |
| Attention acknowledgment | principalId, eventOrDecisionId, acknowledgedAt | Unique pair; survives reconnect; acknowledgment does not answer a decision. |
| Evidence | id, entityId, kind, sourceRef, sourceRevision, observedAt, status, redactedSummary | Separate source completion/publication/merge/deployment/qualification facts; unavailable is explicit. |
| Usage | id, attemptOrJobId, sourceEventId, harness, model, input/output/cache units, cost?, basisVersion?, provenance, observedAt | Deduplicate source events; provenance reported/estimated/unknown; nullable values are not zero. |
| Budget | scopeType/id, unit, limit, timezone, enabled, accountingPolicy | Factory and project scopes both apply; unsupported monetary accounting cannot be enabled as enforced. |
| Budget window | budgetId, startUtc, endUtc, observedUsage, accountingComplete | Resolve calendar boundaries in the configured timezone including DST; preserve actual boundaries on timezone edits. |
| Migration | id, sourceFactory, targetFactory, backupRefs, schemaVersions, sourceRevision, state, ownerCommandId, reconciliationEvidence | One active ownership transfer per factory; no destination scheduling before handover completes. |

## State transitions

- Command: `accepted -> executing -> completed | failed | unknown`; validation refusals are audited without an accepted effect. `unknown -> executing` requires reconciliation proving retry safe; otherwise hold. A duplicate never creates a second command.
- Attempt: `planned -> launching -> running -> awaiting-report | cancelling -> ended`; launch or cancellation uncertainty enters `reconciling`. Only confirmed ended/safe-absent predecessors permit replacement. Old report sequences are refused.
- Decision: `open -> answered | superseded`; accepted answers are immutable. Evidence or gate-visit changes supersede the old decision and create a new one as appropriate.
- Manager job: `queued -> launching -> running -> succeeded | failed | waiting-limit | cancelled | reconciling`; retries create a linked attempt within the configured bound. Lease recovery does not restart an uncertain task blindly.
- Migration: `previewed -> prepared -> source-drained -> transferred -> verified`; interruptions enter `held`. Rollback enters `reconciling -> restored` only after accounting for all post-transfer effects.

## Transaction boundaries

1. Authenticate principal and read its current revocation/role state. Validate payload and required capabilities.
2. In one transaction, lock/check the writer epoch and target revision; look up the idempotency tuple before applying expected-revision checks to a duplicate. Reject changed request bodies under a reused key.
3. Validate decision evidence/authority, Beads ownership, pause state and budgets as applicable. External ownership checks must not be treated as an atomic cross-database transaction: persist the observed claim and reconcile before launch.
4. Persist the command, state revision, decision answer when applicable, event, and effect intent together; only then acknowledge acceptance.
5. Execute/reconcile the effect outside the transaction using its stable task identity. Record the observed result with the same fencing rules. No broad database lock is held while awaiting a provider.

Admission serializes observed accounting and concurrency. It does not promise a strict spend ceiling on already-running jobs. Repeated cumulative usage events must update by delta or replace the same source row, never double-count.

## Retention and compatibility

Reuse existing policies, but retain command deduplication identities for at least the lifetime of related runs and their replayable outboxes; after compaction preserve tombstones sufficient to reject old duplicates. Do not delete unresolved effects, active attempts or open decisions. Event cursor expiration returns a snapshot-required response rather than silently skipping changes.

A backup manifest links database snapshot, memory commit, configuration revision, and worktree/artifact inventory. A downgrade must pass schema compatibility or use a reconciled export. Production recovery never imports raw old snapshots over active scheduling.
