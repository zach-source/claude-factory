# Quickstart: validate the manager core and front-end parity

Use a test factory home under `/tmp`. Do not use the live home until T013 (owner-held).

## Prerequisites

- `bun install` in the repo
- `herdr-app` and the Claude Code CLI on the laptop
- a test home: `FACTORY_HOME=/tmp/fx bin/factory init /tmp/fx` and one test rig with a fixture factory (the fixtures of `src/cli.test.ts`)

## 1. The catalog (US1, US5)

```sh
FACTORY_HOME=/tmp/fx bin/factory core &          # the local core
FACTORY_HOME=/tmp/fx bin/factory op              # lists every operation
FACTORY_HOME=/tmp/fx bin/factory op catalog.echo --text hi
```

Expected: the list has every operation in `contracts/catalog.md`. `catalog.echo` prints `hi`.

Add a test operation to the catalog only. Do not change a front end. Restart the core. Expected: the CLI, the web UI, the Claude mod and the Herdr mod each list the operation and run it.

## 2. The parity check (US4)

```sh
bun test src/parity.test.ts
```

Expected: pass. In a scratch copy, remove the generic view of one front end. Expected: the test fails and names that front end. Add a gap entry with a bead id. Expected: pass. The output shows the gap.

## 3. The local core with all front ends closed (US3)

1. Start `factory core` on `/tmp/fx` with a fixture run of 3 stations.
2. Close all front ends for 1 hour (a test can use a short fixture clock).
3. Open each front end.

Expected: the run made at least 3 station changes. Each front end shows the same board within 5 s.

Start a second `factory core` on the same home. Expected: exit code 1. The message names the holder.

## 4. The 12-step parity scenario (US2, SC-003)

Run each step in each front end: CLI, web UI, Claude mod, Herdr mod.

1. Show the board.
2. Open a run.
3. Read its worker screen (one herdr pane run and one AX run).
4. Queue a bead.
5. Answer a gate.
6. Answer a decision.
7. Add mail to a run.
8. Change a rig setting.
9. Stop the factory.
10. Resume it.
11. Ask the manager a question in the chat.
12. Read the last patrol report.

Expected: after each front end runs the steps, the test home has the same state. That state includes the same run states, gate answers, mail and rig settings. For the CLI and the web UI, run `bun test src/parity-scenario.test.ts`. For the two mods, run `claude plugin test mod` and the Herdr view tests.

## 5. A change shows in other front ends (SC-005)

Open the web UI and the Herdr mod. Answer a gate in the CLI. Expected: both show the answer within 5 s and do not offer the gate again.

## 6. The guard (US6)

In the Claude mod, ask the manager to run `factory mail r1 plan "$(id)"`. Expected: the core's `guard.check` answers "ask". The question shows in the Claude mod. A Deny stops the command. Run the same command from a manager chat in the web UI. Expected: the same question and the same reason.
