# Contract: wiki pages

The page fields are in [data-model.md](../data-model.md). This file shows the exact page shapes that `scanPages()` checks.

## Rig page (`rigs/<rig>.md`)

```markdown
---
kind: rig
title: <rig> — factory work
rigs: [<rig>]
updated: 2026-11-05T21:00:00Z
---

# <rig>

> The factory makes this page again every 30 min. Do not edit it: an edit does not stay.

## Waits on a person
- **<bead title>** — <first sentence of the question>. Step: [soak](../glossary.md#soak), 46 h.
  [<bead id>] · [PR #3646](<url>) · answers: owner

## In progress
- **<bead title>** — <first sentence of the last report>. Step: [review](../glossary.md#review), 2 h.
  [<bead id>] · [PR #123](<url>)

## Queued
## Shipped (last 7 days)
- **<PR title>** — merged 2026-11-05. [Solution](../solutions/2026-11/<slug>.md)
## Stopped (last 7 days)

Last update: 2026-11-05T21:00:00Z
```

- A section with no items shows `None.`.
- The factory writes the whole page on each refresh. A person's edit to a rig page does not stay.
- The factory skips the human-line guard for rig pages, because the page header says so.

## Solution page (`solutions/<yyyy-mm>/<slug>.md`)

```markdown
---
kind: solution
title: Soak passes a healthy rollout after a deadline
rigs: [claude-factory]
topics: [ship-soak]
beads: [claude-factory-3w8o]
prs: [https://github.com/<owner>/claude-factory/pull/591, https://github.com/<owner>/claude-factory/pull/590]
cause: proven
status: current
updated: 2026-11-05T23:45:00Z
---

# Soak passes a healthy rollout after a deadline

## Problem
## Cause
## Change
## Options rejected
## Verification
## Still open
## Links
```

- `scanPages()` checks four things:
  - All 7 headings are present, in this order.
  - The page has at least one entry in `topics`.
  - `cause` has a value.
  - If `status: superseded`, `superseded_by` has a value.
- When the cause is a hypothesis, the Cause section must say what would prove it.

## Topic page (`topics/<topic>.md`)

The frontmatter has `kind: topic`, `title` and `updated`. The body has an `## Overview` section that groom keeps, and a `## Solutions` section with one line for each solution page, newest first.

## Text rules (put into the write and groom prompts)

- Write in ASD-STE100. Write for a developer who did not work on the change.
- Do not write agent shorthand (`triage#1`, `quick#1 ready:`).
- When the text first names a factory term on a page, link it to the glossary.
- Do not copy text that looks like a token, a key, a password or a private address.
