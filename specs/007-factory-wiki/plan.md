# Implementation Plan: Factory wiki — what the factory works on and how it solved it

**Branch**: `007-factory-wiki` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/007-factory-wiki/spec.md`

## Summary

The wiki is a second git repo in the factory home, `$HOME/wiki/`, next to `memory/`.
Its remote is one private repo.
The git host shows the Markdown.
Three passes write the wiki:

1. **Refresh** (P1, pure code, each 30 min):
   - Make one page for each rig.
   - Use the run list, `factory waiting` data and the merged PR cache.
   - Do not use an LLM.
   - Commit and push directly.
2. **Write** (P1, agent, each 3 h):
   - Find beads that closed with a merged, non-trivial PR since the last pass.
   - Run one `claude -p` call in `wiki/`.
   - The call writes or updates their solution and topic pages.
   - Commit and push directly.
3. **Groom** (P2, agent, each 24 h):
   - Run one `claude -p` call on a `groom/<date>` branch.
   - The call merges, rewrites and marks stale pages.
   - It can change at most 15 pages.
   - Push the branch and open a PR with the plan as the body.
   - A person merges or closes the PR.

Find (P2) uses three things:
- the index page
- a `beads:` and `prs:` list in each page's frontmatter
- the command `factory wiki find <id>`

The worker brief link (P3) must wait for a later slice.

All decisions are pure functions in a new `src/wiki.ts` with table tests:
- page render
- the trivial-change check
- the human-line guard
- the secret scan
- the prompts

`src/cli.ts` only gets the kicks, the subcommands and the git and `gh` calls.

## Technical Context

**Language/Version**: TypeScript on Bun, as in the rest of the repo.

**Primary Dependencies**: only the existing ones: `git`, `gh`, `bd`, and `claude -p`, or codex when `FACTORY_DREAM_CODEX` is set, as the dream uses. There is no new dependency.

**Storage**: `$HOME/wiki/` is a git repo with the remote `FACTORY_WIKI_REMOTE`. Pass state is in `$HOME/wiki-state.json`. Stamps are `wiki-refresh.stamp`, `wiki-write.stamp` and `wiki-groom.stamp`, and locks are `wiki.lock`. See [data-model.md](data-model.md).

**Testing**: `bun test src factories`. Table tests go in `src/wiki.test.ts`, and the CLI wiring test goes in `src/cli-wiki.test.ts` with `FACTORY_NO_KICK=1` and a temp home.

**Target Platform**: the factory host (macOS or Linux), where the manager and `tick()` run. AX VMs do not run wiki passes.

**Project Type**: a CLI with a library module (`src/wiki.ts`).

**Performance Goals**: refresh must finish in less than 10 s for 10 rigs and 600 runs. It runs detached, so it does not slow the tick. Write and groom each have a 45 min timeout, the same as the dream.

**Constraints**:
- The claude-factory repo is public, so fixtures must be generic.
- The wiki remote must be private. The factory refuses to push when `gh repo view` reports `PUBLIC`.
- Pages must not contain a secret.
- Rig pages must not call an LLM.

**Scale/Scope**: about 8 rigs, about 60 merges each day, and about 10 to 20 solution pages each day after the trivial filter. That makes about 300 to 600 pages after one month.

## Constitution Check

**I. Worker Parity**: the wiki passes are not workers, so the brief, skills and MCP rules do not apply to them. They run on the factory host, as the dream does. The write and groom passes use the same runner switch as the dream (`claude -p`, or codex with `FACTORY_DREAM_CODEX`). So the two backends that the dream supports also both work here. The P3 brief link, when it comes, goes in `src/worker-system.md`, which all backends read. ✅

**Governance**: the PR names its gaps. There is one known gap: the groom PR flow is new, so no other flow opens a PR in a non-rig repo today. That is a new pattern, not a constitution violation. ✅

**Project practice gates (CLAUDE.md)**:
- Pure core, I/O at the edges. ✅
- No new dependency or store type: the wiki is a git repo, as memory is. ✅
- Test-first. ✅
- Reversible: each pass is one git commit, or one PR for groom. ✅

**Post-design re-check**: still passes. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/007-factory-wiki/
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Pages, state, passes
├── quickstart.md        # Validation scenarios
├── contracts/
│   ├── cli.md           # factory wiki subcommands and env
│   └── pages.md         # Page layout, frontmatter and sections
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── wiki.ts              # NEW: pure: renderRigPage, trivial(), humanLines(), scanPages(), writePrompt(), groomPrompt(), groomPlan cap
├── wiki.test.ts         # NEW: table tests
├── cli.ts               # kickWiki (3 stamps) in tick() finally; `factory wiki init|refresh|write|groom|find|status`
├── cli-wiki.test.ts     # NEW: temp-home CLI tests (refresh output, refusal on a public remote, secret block)
└── homebackup.ts        # reuse secretFile() / SECRETS (export if needed)
docs/
└── wiki.md              # NEW: owner setup (remote, env), how passes run, how to approve a groom PR
```

**Structure Decision**: this is one module, like `src/memory.ts`.
Its wiring goes in `src/cli.ts`, beside `kickDream`.
There is no new factory definition and no new station.
The passes follow the dream pattern: a detached subcommand, a lock, the stamp written first, then the work.

## Complexity Tracking

No violations.
