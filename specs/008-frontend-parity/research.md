# Research: Manager core and front-end parity

Facts come from a survey of the code at `origin/main` 1920ad88 (2026-11-07).

## R1. The shape of an operation

**Decision**: An operation is a plain object in `src/core/catalog.ts`. It has a name, a summary, input fields and an output kind. It has the rights that it needs. It also has a read or change flag, a `long` flag, its route and a `run(ctx, input)` function. The input fields use the `Field` kinds that `src/server-api.ts:169-280` has today (`fieldOk`). The kinds move into the catalog.

**Rationale**: The repo has no schema library. The route table in `server-api.ts:188-252` is already the nearest thing to a catalog. Its field kinds already check the inputs of the 14 routes. One registry replaces the route table, the `client.ts:54-118` argv map and the hand help text at `cli.ts:11389`.

**Alternatives**: zod or typebox. Both are new dependencies that the field kinds already cover (ponytail ladder rung 4). JSON Schema files: a second source next to the code, which can drift.

## R2. Run operations in process

**Decision**: An operation's `run` calls a function from `src/core/ops/`. The code of each CLI command moves out of the `switch` in `cli.ts:11596` into its operation. The CLI case then calls the operation. `cliRunner` (`server-api.ts:132`) starts a `bun src/cli.ts` subprocess for each call. It goes away when the last route moves.

**Rationale**: `server-api.ts:130` already names this as the next step. aya5.3 asks for the same result ("imports do not start a CLI or tick"). Each call starts a subprocess that loads all of `cli.ts` (13,171 lines) again. The plan sets a limit of 1 s for the Claude mod's guard check. T005 must measure the time.

**Alternatives**: keep the subprocess and only add a catalog. That is slower, and the CLI keeps its logic in the `switch`, where the other front ends cannot reach it.

## R3. The core in local mode

**Decision**: `factory core [--home <dir>]` runs `src/server.ts` in local mode:

- It takes the manager lease (`src/lease.ts`). The Claude mod, the Herdr mod and `factory loop` use the same lease (epic claude-factory-s01d). It does not use `server-lease.json`.
- It listens on `127.0.0.1` only, on a port in `<home>/core.json`. A token in `<home>/core.token` (mode 0600) authorizes the calls.
- It runs the tick each 5 s.
- It runs the manager step timers of `src/once.ts`. The timers are: patrol 60 s, brief 2 min, review 5 min, decisions 5 min and pm 1 h.
- The Herdr mod runs them the same way today.

**Rationale**: A Herdr mod can only `exec` and `fetch` (Herdr app AGENTS.md). It cannot use a unix socket. A browser also needs an HTTP origin. The token file keeps other users of the laptop out. `src/ui.ts:48,257` already binds to `127.0.0.1` and refuses a Host that is not localhost (DNS rebinding guard). The core uses the same guard.

**Alternatives**: a unix socket. The Herdr mod and the browser cannot reach it. The mTLS certificate of spec 004 for each person is too heavy for a local home. The browser setup is in aya5.9 and applies to server mode.

## R4. Front ends and the generic view

**Decision**: Each front end has one generic view. It reads `GET /v1/catalog` and shows each operation with its summary and inputs. It runs the operation through its route and shows the output. The output kind sets the form: table, text or JSON. A front end can register its own view for an operation name, for example the board. An own view is presentation only.

**Rationale**: This is how a new operation reaches all front ends with no front-end code (FR-007, US1, US5).

**Alternatives**: hand-made views only. Each new feature then needs four front-end changes. That is the current gap.

## R5. The Herdr mod and long operations

**Decision**: The Herdr mod calls the core with `fetch`. An operation with `long: true` returns `202` and a command id at once. The front end reads `GET /v1/commands/:id` until it is done. This is the command record of spec 006 (`contracts/control-api.md`).

**Rationale**: The Herdr app stops an `exec` after 30 s. Today the mod runs each job detached and reads `.out` and `.done` files (`herdr/mods/factory/main.js:26-28`). The command id replaces those files.

**Alternatives**: keep the detached jobs. They are a second way to run the factory, and only the Herdr mod has it.

## R6. Guards for the manager's own commands

**Decision**: `gatedCommand`, `bdWrite`, `INSTALL_VERB`, `META_WRITE` and `PATROL_VERB` (`mod/hooks/view.ts:1153-1361`) move to `src/core/guards.ts`. A read operation `guard.check` returns allow, ask or deny with the reason. The Claude mod's `tool.call` hook calls it. When the answer is "ask", the front end that the person uses shows the question. The headless steps use the same module through `factory patrol-guard`.

**Rationale**: The rule then lives in one place. The `#697` fix (2026-11-07) changed only the mod. With this change, the rule reaches every front end and every step.

**Alternatives**: copy the guard into each front end. That is what Principle II forbids.

## R7. The manager chat

**Decision**: The core holds each manager conversation in `<home>/conversations/<id>.jsonl`. `chat.send` runs one turn with `claude -p --resume <session>` and the manager tool set of akiq.15. The CLI (`factory chat`), the web UI and the Herdr mod are clients of it. The Claude mod's own session is a chat front end too. Its turns go into the same conversation file through its `prompt.submit` and `turn.complete` hooks. The other front ends can then show them.

**Rationale**: The owner uses the subscription tokens, not an API key (spec 004 decision of 2026-10-26). `claude -p` is the way the steps already run (`src/once.ts`).

**Alternatives**: the Agent SDK. It needs an API key. Only the Claude mod chat. The other front ends then have no chat, which is a gap.

## R8. The parity check

**Decision**: `src/parity.test.ts` runs in `bun test`:

1. It loads the catalog.
2. For each front end, it runs one fixture operation through that front end's generic view. This proves that the front end reaches every operation in the catalog.
3. It reads each front end's own-view registry. Each name must be an operation in the catalog.
4. It reads `parity-gaps.json`. Each entry must name an operation, a front end and a bead id, with a reason.
5. A front end can hide an operation (for example, the status band). The hide list must name the front end that shows it.

`factory parity` checks on the laptop that each gap bead is still open (the CI has no access to the beads server). The pre-push hook runs it.

**Rationale**: The generic view gives each front end every operation, so the test checks the generic view and the exceptions.

**Alternatives**: a list of operations in each front end. That is a second list to keep in step with the catalog.

## R9. Order of the move

**Decision**: First, move the reads (board, run, backlog, PRs, decisions, plan, metrics, rigs, runners, mail, lease, step reports). Then, move the changes (decide, decisions answer, mail, goto, abort, start, queue, stop, resume, rig set, lease release). Then, move the guards and the chat. Each step keeps the CLI output the same. `cli.test.ts` checks it.

**Rationale**: Reads cannot break the live factory. Each moved command is a small PR with its own tests.
