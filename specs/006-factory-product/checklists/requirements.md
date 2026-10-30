# Specification Quality Checklist: Factory product and harness-independent manager

**Purpose**: Validate requirements quality before implementation planning.
**Created**: 2026-10-29
**Feature**: [spec.md](../spec.md)
**Review ownership**: Author review under `speckit-specify`.
**Marker semantics**: Checked items describe specification quality, not implemented or qualified product behavior.

## Content Quality

- [x] CHK001 Defines operator outcomes rather than prescribing a frontend framework, database schema, transport, or implementation structure.
- [x] CHK002 Explains the full product scope and why each user journey matters.
- [x] CHK003 Defines product terms and surfaces for a reader without repository knowledge.
- [x] CHK004 Includes prioritized scenarios, requirements, entities, measurable outcomes, and assumptions.

## Requirement Completeness

- [x] CHK005 Contains no unresolved clarification markers or template placeholders.
- [x] CHK006 Requirements describe observable behavior with explicit failure and unsupported-capability handling.
- [x] CHK007 Success criteria are measurable and state their test conditions and proposed-target status.
- [x] CHK008 Success criteria measure operator and product outcomes without prescribing implementation technology.
- [x] CHK009 Every story has an independent test and Given/When/Then acceptance scenarios.
- [x] CHK010 Covers stale decisions, ambiguous launches, duplicate commands, missing usage, expired credentials, and interrupted migration.
- [x] CHK011 Separates the complete first product release from deferred team, marketplace, native-client, and billing features.
- [x] CHK012 Identifies dependencies on specs 002–005, existing interfaces, owner decisions, and the worker-parity constitution.

## Feature Readiness

- [x] CHK013 Acceptance coverage maps all 38 functional requirements to user stories and all 10 success criteria to relevant journeys.
- [x] CHK014 Stories cover onboarding, independent execution, harness choice, steering, decisions, chat, outcomes, and maintenance.
- [x] CHK015 Defines qualification evidence and stop conditions for each release stage; does not claim those outcomes have passed.
- [x] CHK016 Preserves local/server modes and identifies the deliberate extensions of spec 004.
- [x] CHK017 Preserves S2-S8 owner gates and distinguishes the closed S0-S1 epic from delivery of the full server.
- [x] CHK018 Keeps implementation tasks in Beads and records the next planning inputs without adding a parallel task ledger.

## Review Notes

- Scope follows the prior proposal: one operator and several repositories, standalone server UI, Claude and Codex as manager and worker choices, existing Pi worker compatibility, and qualified extension points.
- The live Beads record for `claude-factory-xbzd` and the existing 004 design were inspected. The later explicit two-mode decision in 004 takes precedence over the epic's earlier note about retiring herdr.
- Spec 005 counts merge as deployment for its delivery metric. This spec requires an explicit label and separate runtime deployment evidence, preserving both meanings without silently redefining the metric.
- Runtime and usability success criteria are future release gates. This documentation review does not qualify a running service or authorize production changes.
- No before/after-specify hooks are registered in `.specify/extensions.yml`. The registered Beads hooks apply to planning and analysis.
- Ready for `/speckit-plan`; concrete authentication integration, harness qualification, state migration, and compatibility decisions belong in that plan.
