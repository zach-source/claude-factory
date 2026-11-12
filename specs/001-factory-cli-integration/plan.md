# Implementation Plan: One factory CLI for every factory operation

**Branch**: `plan/001-factory-cli-integration` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-factory-cli-integration/spec.md`

## Summary

Move the loose factory operations into the `factory` CLI (`src/cli.ts`). The work has five parts:

1. Rig edit commands (`rig set|show|env|egress|beads-remote|history|undo`) on one locked write path for `rigs.json`.
2. A stored `settings.json` in the factory home, loaded into `process.env` at start (the environment wins), and a `settings` command.
3. `factory image build` (replaces `hack/push-worker.sh`).
4. `factory token` (list, use, best) with a configured read command and write command.
5. `factory up` (replaces `bin/factory-up`), the README guard-install line, and doc changes.

Main already has some parts. [research.md](research.md) lists them. No task repeats them.

## Technical Context

**Language/Version**: TypeScript on Bun (the repo's one entry point, `bin/factory`)

**Primary Dependencies**: None new. Node built-ins (`fs`, `child_process`) and the existing helpers in `src/cli.ts`.

**Storage**: Files in the factory home: `rigs.json` (existing), `settings.json` (new), `devenv.json` (existing), `rigs-history/` (new)

**Testing**: `bun test` (existing `*.test.ts` files next to the source)

**Target Platform**: macOS and Linux laptop shell; the settings reach AX workers through the existing launch code

**Project Type**: CLI

**Performance Goals**: `token best` ends in less than 30 seconds (SC-004)

**Constraints**: Public repo: no private host name, store item ID or secret in any file (SC-006). Tokens on stdin only, never in argv or output (FR-013). Docs in ASD-STE100.

**Scale/Scope**: One person, up to a few dozen rigs, 2 to 5 token slots

## Constitution Check

| Principle                    | Result | Note                                                                                                                                    |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| I. Worker Parity             | Pass   | The feature adds no skill, rule or MCP server to a worker. `rig set --mcp` keeps the refusal that `rig add` has for a remote runner (D5). |

Gate result: pass. Re-checked after design: pass. No complexity violation.

## Project Structure

### Documentation (this feature)

```text
specs/001-factory-cli-integration/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── cli.md
└── tasks.md             # made by the beads tasks step, not by this plan
```

### Source Code (repository root)

```text
src/
├── rigs-edit.ts         # new: editRigs (lock, snapshot, atomic write), applyRigChange, redactRig (pure core)
├── settings.ts          # new: SETTING_KEYS, resolveSettings (pure), loadIntoEnv, setSetting
├── claude-token.ts      # new: slot list/use/best; store commands from settings
├── image.ts             # new: image build and digest parse
├── up.ts                # new: start checks (pure) and run
├── cli.ts               # change: wire new subcommands; call loadIntoEnv first; extract validateRig from defineRig
└── *.test.ts            # one test file per new module
bin/factory-up           # delete (FR-017)
hack/push-worker.sh      # delete (FR-017)
README.md, docs/         # change (FR-016, FR-018)
```

**Structure Decision**: Flat `src/` files, as the repo does today. Each new module has a pure core and a thin I/O edge. `cli.ts` only parses arguments and calls the module.

## Design notes

- Load order: `loadIntoEnv` runs before the line that reads `FACTORY_MAX_RUNS` (research F2). It runs as the first statement of `cli.ts` or in a tiny module that `cli.ts` imports first.
- Every rig command goes through `editRigs` ([research D4](research.md)). `rig add` and `rig rm` move to it too, so no writer skips the lock.
- A live run keeps the rig settings it launched with. `createRun` stores the rig entry in `runs/<id>/rig.json`. Stations read it through `runRig`. A live edit can only take access away. Stored settings (`settings.json`) still reach a live run. claude-factory-oqucu tracks that.
- `rig` write subcommands call `refuseWorker`, as `rig add` does. The spec says the manager can call them, so `refuseWorker` must keep allowing the manager. A task checks the existing rule.

## Delivery order

1. `settings.ts` and the `settings` command (P1, story 2).
2. `rigs-edit.ts` and the rig commands (P1, story 1). Independent of step 1.
3. `image build` (P2, story 3). Needs step 1.
4. `token` (P2, story 4). Needs step 1.
5. `up` (P3, story 5). Independent.
6. Guard README line (P3, story 6).
7. Delete `bin/factory-up` and `hack/push-worker.sh`, change the docs (FR-017, FR-018). Last, after steps 3 and 5.

## Complexity Tracking

No violation to justify.
