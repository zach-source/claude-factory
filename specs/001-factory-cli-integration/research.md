# Research: One factory CLI for every factory operation

Facts come from `main` at the time of this plan (`src/cli.ts`, `bin/`, `hack/`, `docs/`).

## Already built on main

Do not make a task for any item in this table. The status "done" means that main has the code and the plan only reuses it.

| #   | What                                                             | Where                                                                    | Status      |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- |
| A1  | `factory init <dir>`                                             | `src/cli.ts`, case `init`                                                | done        |
| A2  | `factory manager` (accepts `--resume <session>`)                 | `src/cli.ts`, case `manager`                                             | done        |
| A3  | `rig add` (define or replace a whole rig), `rig rm`, `rig list`  | `src/cli.ts`, case `rig`; `defineRig` holds the launch validation        | done        |
| A4  | `rigs.json` read and write helpers (`rawRigs`, `writeJson`)      | `src/cli.ts`                                                             | done        |
| A5  | `factory devenv` reads `devenv.json` (`DevenvConfig`)            | `src/devenv.ts`, `src/cli.ts` case `devenv`                              | done (read) |
| A6  | `stop`, `resume`, `queue`, `metrics`, `memory`, `status`         | `src/cli.ts`                                                             | done        |
| A7  | `refuseWorker`: a worker cannot run a person-only command        | `src/cli.ts`                                                             | done        |
| A8  | Token slot logic as a shell script (`bin/claude-token`), tested  | `bin/claude-token`, `src/claude-token.test.ts`                           | done (script) |
| A9  | Public-repo guard `hack/guard-private.sh`                        | `hack/guard-private.sh`                                                  | done (script) |
| A10 | Worker image build as a shell script                             | `hack/push-worker.sh`                                                    | done (script) |
| A11 | One-step start as a shell script                                 | `bin/factory-up`                                                         | done (script) |

Not built on main (the plan covers these): `rig set`, `rig show`, `rig env`, `rig egress`, `rig beads-remote`, rig history and undo, the stored settings file and the `settings` command, `devenv` config write, `image` command, `token` subcommand, `up` subcommand, the README line for the guard install, and the delete of `bin/factory-up` and `hack/push-worker.sh`.

## Facts that the design uses

| #  | Fact                                                                                                                                                              | Source                                  |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| F1 | The runner reads its settings from `process.env.FACTORY_*` at the point of use (`FACTORY_AX_IMAGE`, `FACTORY_AX_VAULT`, `FACTORY_AX_CONTEXT`, and others).         | `src/ax.ts`, `src/cli.ts`               |
| F2 | `FACTORY_MAX_RUNS` is read once at module load (`MAX_BUSY`). A stored value must reach `process.env` before that line runs.                                        | `src/cli.ts:271`                        |
| F3 | `FACTORY_AX_ENV` names a JSON file. The code reads it with `readJson`.                                                                                             | `src/cli.ts:2032`                       |
| F4 | `rig add` writes the whole file with `writeJson` after a read. There is no lock.                                                                                   | `src/cli.ts:11625`                      |
| F5 | `bin/claude-token` takes its store from five `CLAUDE_TOKEN_*` variables, and sends tokens on stdin, never in argv.                                                  | `bin/claude-token`                      |
| F6 | `hack/push-worker.sh` prints `image@digest` on stdout. It reads `REG`, `BUILDER`, `TARGET`, `AX_CLI_REPO` and `AX_CLI_COMMIT`.                                     | `hack/push-worker.sh`                   |
| F7 | `docs/remote-runner.md` and `docs/onboarding.md` name `bin/factory-up` and `hack/push-worker.sh`. The README names `bin/factory-up`. FR-018 needs a change to each.  | `README.md`, `docs/`                    |
| F8 | The Rig type comments say "edit rigs.json by hand" for several fields (for example `maxPerCluster`, `plugins`). FR-018 needs the comments and docs to change.      | `src/cli.ts` (Rig type)                 |

## Decisions

### D1. Settings reach the code through `process.env`

**Decision**: A new `settings.json` in the factory home holds a map from setting name to value. At CLI start, before any module reads the environment, the CLI copies each stored value into `process.env` if the variable is not set. The environment therefore wins (FR-009), and no call site changes (F1, F2).

**Why**: About 30 call sites read `process.env.FACTORY_*`. One load step is smaller and safer than a change at each site.

**Alternatives rejected**: A `getSetting()` function at each call site (large diff, and a missed site gives a silent wrong value). A wrapper script that exports the values (does not work for a manager started by another tool).

### D2. Source tracking

**Decision**: `settings list` computes the source of each key from three facts: the shell had the variable before the load step (environment), `settings.json` has the key (stored), or neither (default). The pure function `resolveSettings(stored, env)` returns `{value, source}` and the CLI snapshots `env` before the load step.

**Why**: A pure function is easy to test (the project prefers pure core logic).

### D3. Secrets

**Decision**: `settings.json` holds only names and commands. `settings list` and `rig show` redact any value whose key is in a fixed secret-key list or whose rig-env key matches `/(TOKEN|SECRET|KEY|PASSWORD)/i`. A command string (token read or write command) is shown as written.

**Why**: FR-013 and the edge case on secret names. A command is not a secret. A value in a rig env can be one.

### D4. One write path for `rigs.json`

**Decision**: Every rig change calls `editRigs(fn)`. It takes a lock (`mkdir rigs.json.lock`, retried for 5 seconds, stale after 30 seconds), reads and parses the file, runs `fn` on the parsed list, validates, writes to a temp file and renames it. `rig add` and `rig rm` use the same function. A parse error refuses the write and names the file and the error.

**Why**: FR-007 and FR-005. A rename is atomic, so a reader never sees a partial file. The lock removes a lost update (F4). `home-guard.ts` already notes a lock as the upgrade path for its own file.

**Alternatives rejected**: `flock` (not on macOS by default). A compare-and-swap on a file hash only (it detects a conflict but does not merge).

### D5. Validation is the launch validation

**Decision**: `rig set` builds the new rig object and passes it through the same checks that `defineRig` runs. The plan extracts those checks into a pure function `validateRig(rig)` that both `defineRig` and `rig set` call. If a check lives in `defineRig` in a form that is hard to extract, the task lists the exact checks to move.

**Why**: Acceptance scenario 4 and 5 of story 1: "validates as it does at launch time".

### D6. History and undo

**Decision**: `editRigs` copies the old file to `<home>/rigs-history/<timestamp>.json` before each write. It keeps the last 20. `rig history` lists them. `rig undo [n]` restores one through `editRigs`, so an undo is also undoable.

**Why**: Gap 6 of the survey. The spec has no FR for it, but SC-002 says that none of the 12 operations needs a hand step. This is the least code that closes gap 6.

### D7. Token slots move into the TypeScript CLI

**Decision**: `factory token [list]`, `factory token use <n>` and `factory token best` run the slot logic of `bin/claude-token` in `src/claude-token.ts`. The store is two settings, `token.read` and `token.write` (shell commands). The read command prints the value of a named field. The write command takes the field name as `$1` and the value on stdin. Tokens go only on stdin. Usage is read from Anthropic rate-limit headers with the same request that the script makes today.

**Why**: FR-011 to FR-014. The repo must hold no store item IDs, so the store is a pair of commands (clarification Q1).

**Open point**: The spec does not say whether `bin/claude-token` stays. The plan keeps it until the new command has a test for every case of `src/claude-token.test.ts`. A later change can delete it. `docs/remote-runner.md` points to it as a swap command, so the doc changes in the same task that removes the script. The owner decides.

### D8. Image build

**Decision**: `factory image build [--target worker|manager]` runs `docker buildx build` (the arguments of `hack/push-worker.sh`), reads the digest from the metadata file, and then calls `setSetting('AX_IMAGE', ref)`. For `--target manager` it stores `FACTORY_AX_MANAGER_IMAGE`. A non-zero exit from the build writes nothing (FR-010). The registry and builder are settings `image.registry` and `image.builder`.

### D9. `factory up`

**Decision**: `factory up [dir] [manager args]` checks `bun` and `claude`, installs dependencies when `node_modules` is missing or older than `bun.lock`, runs `init` when `rigs.json` is missing, warns when `HERDR_ENV` is not `1`, and then runs the manager code path in process. It keeps the `ponytail` shortcut that the script has.

### D10. The public-repo guard

**Decision**: No code change. Add one README command that installs `hack/guard-private.sh` into the pre-commit and commit-msg hooks next to the beads hooks (FR-016). The task checks the command in a clean clone.

### D11. Old homes

**Decision**: A home with no `settings.json` works as before: the load step finds no file and does nothing. The devenv cache settings stay in `devenv.json`. The `settings set devenv.builder|token|push` command writes that file, so `factory devenv` reads it as it does today (story 2, scenario 4). There is one file of record, so no migration is needed.
