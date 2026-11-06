# Contract: Operator experience

## Navigation and common state

A persistent navigation region links Overview, Projects, Work, Decisions, and Settings. Chat opens alongside the selected context. Project and run URLs are bookmarkable. A visible factory identity and mode prevent operating the wrong home. Global status shows connectivity/freshness, pause, outstanding decisions, and relevant holds.

Views display loading, empty, unavailable, stale and error states distinctly. Render authorized snapshots; do not tick while reading. Keep draft text and focus through updates. Stale mutations fail with an explanation and refreshed state; no offline command queue. An action shows submitted, accepted and observed completion separately, with a command-history link.

## Project onboarding

Select/connect repository and Beads context; choose an existing lifecycle template; set goal/capacity, worker defaults and runner; review readiness and effective configuration; explicitly start a work item. Server mode offers AX only. Advanced unsupported fields survive edits and are shown read-only with a pointer to their configuration source. Never silently install dependencies or initialize a foreign tracker.

Show harness role/version, model, billing/auth mode without secret, readiness, and missing capabilities. Manager profile selection is separate from worker defaults. Station overrides show their origin. Changes state whether they apply to future runs or require an explicit running-attempt handoff.

## Overview and Work

Use the existing board state grouping: needs decision, blocked/stuck, working, waiting, then ended work. Each run has one state and a concise reason. Detail adds the station/attempt timeline, effective settings, command outcomes, messages, PRs, delivery evidence and optional worker output.

Pause clearly means no new attempts, not immediate worker termination. Abort asks for cancellation and retains the run's evidence. Retry/go-to/harness-switch show the current target and effect before submission. Do not label pending delivery or cancellation as done. Project removal is refused while active work is unresolved.

## Decisions

One row per distinct gate visit or owner question, ordered by urgency then age. Show question, reason, evidence age/revision, two or more allowed choices where available, consequences, and any recommendation as advisory. Full evidence is one action away. The operator explicitly submits an outcome; background chat cannot do it.

If evidence changes while viewing, show the change and require a current submission. Answered history retains actor, time, note and resulting execution status. Attention acknowledgment/read state never answers the question. Memory/skill proposal review reuses the existing install/reject outcomes and restrictions.

## Chat and attention

Display explanations with links to state/evidence and distinguish inference. Applied manager operations link command IDs. Owner-only operations produce a decision card, not a success message. Harness replacement loads durable context and identifies the new manager job. Suppress repetitive unchanged alerts; persist acknowledgment. No external notifications in this release.

## Metrics, settings and diagnostics

Show source complete, published, merged, deployed and qualified as separate facts. Metric windows, definitions, sample counts and missing data come from spec 005. Label its merge-based deployment metric explicitly. Usage separates reported, estimated and unknown; budget UI explains admission limits and possible in-flight overspend. Show reset timezone/time and hold reasons.

Settings handle protected credential references and readiness, never provider secret text in the page. Diagnostics preview excludes source/transcripts by default and redacts secrets in all modes. Export downloads locally; it never uploads automatically.

## Accessibility and performance

Use native controls, semantic landmarks/headings, labels, visible focus, keyboard-accessible dialogs and live status announcements. Do not rely on color. Restore focus when panels close; avoid rebuilding focused input nodes during events. Qualify at desktop widths 1280 and 768 pixels, zoom 200%, keyboard-only and a real screen reader. Test spec SC-005 at 10 projects/50 active/1,000 retained runs, and conduct SC-001/SC-006 trials with five representative operators.
