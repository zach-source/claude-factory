# Feature Specification: One factory CLI for every factory operation

**Feature Branch**: `cli-spec`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "A full CLI integration of claude-factory. The factory is gaining loose helper scripts and hand edits (bin/factory-up, hack/push-worker.sh, hack/guard-private.sh, a new bin/claude-token for swapping Claude token slots, rig goals edited by hand in the factory home rigs.json, factory devenv, AX rig env and egress). Fold all of that into one coherent factory CLI."

## Survey: what a person does today outside the CLI

The `factory` CLI (`src/cli.ts`) covers runs, rigs (`rig add|rm|list`), the memory, metrics, `devenv`, `stop|resume` and the manager. The operations below have no command, or have a command that is not enough:

| #   | Operation                                                                            | How a person does it today                                                                                                                                                                             | Gap                                                                                |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Start a factory and its manager in one step                                          | `bin/factory-up`: install dependencies, `factory init` if new, warn outside herdr, `factory manager`                                                                                                   | A separate script, not a `factory` command                                         |
| 2   | Change one rig setting (goal, cap, sweeps, runner)                                   | Edit `rigs.json` by hand, or run `rig add` again with every flag                                                                                                                                       | `rig add` replaces the whole rig, so a person must repeat every flag to change one |
| 3   | Set a rig's env (`FACTORY_NIX_CACHE`, `FACTORY_BAZELRC`, `FACTORY_KUBE_SERVER`, ...) | Edit `env` in `rigs.json` by hand                                                                                                                                                                      | No flag                                                                            |
| 4   | Set a rig's beads remote                                                             | Edit `beadsRemote` (`{name, url, user}`) in `rigs.json` by hand                                                                                                                                        | No flag                                                                            |
| 5   | Add or remove one egress rule on a rig                                               | `rig add` again with every `--egress`, or edit `egress` by hand                                                                                                                                        | No add or remove of one rule                                                       |
| 6   | Keep a copy before a risky rig edit                                                  | Copy `rigs.json` to a side file by hand                                                                                                                                                                | No history or undo                                                                 |
| 7   | Build and push the worker image                                                      | `hack/push-worker.sh` with `REG` and `BUILDER`, then copy the digest into `FACTORY_AX_IMAGE` by hand                                                                                                   | Two manual steps, and the result is not stored                                     |
| 8   | Configure the AX runner                                                              | Export `FACTORY_AX_IMAGE`, `FACTORY_AX_VAULT`, `FACTORY_AX_ENV`, `FACTORY_AX_CONTEXT`, `FACTORY_AX_ATESPACE`, `FACTORY_AX_CAPABILITIES`, `FACTORY_KUBECTL`, `FACTORY_MAX_RUNS` and others in the shell | Settings live in the shell profile, not in the factory, and no command shows them  |
| 9   | Write the AX extra env file                                                          | Write the JSON file that `FACTORY_AX_ENV` names by hand                                                                                                                                                | No command                                                                         |
| 10  | Configure the devenv cache                                                           | Write `devenv.json` (builder, token command, push command) in the factory home by hand                                                                                                                 | No command; `factory devenv` only reads it                                         |
| 11  | See and swap the Claude token that AX workers use                                    | A private script in the factory home: show each token slot's 7-day and 5-hour use, make slot N live, or make the slot with the lowest use live                                                         | Outside the repo; the secret store item is hard-coded in it                        |
| 12  | Guard the public repo against secrets and private names                              | `hack/guard-private.sh` wired into git hooks by hand, with a pattern file kept by hand in the git common dir                                                                                           | Repo tooling for contributors, set up by hand                                      |

## Clarifications

### Session 2026-10-14

- Q: Which secret stores must the token slot commands support? → A: Any store, through read and write commands configured per factory. The repo holds no store item IDs.
- Q: Must the factory swap the token slot by itself when AX workers hit a usage limit? → A: No. This feature swaps only on command. An automatic swap is separate work.
- Q: Which contributor tools become `factory` subcommands? → A: The worker image build does, because it sets a factory setting. The public-repo guard stays a repo script.
- Q: What happens to `bin/factory-up` and the `hack/` scripts when the new commands ship? → A: Delete `bin/factory-up` and `hack/push-worker.sh` in the same change. `hack/guard-private.sh` stays.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Change a rig without editing JSON (Priority: P1)

The person changes one setting of a rig: its goal, cap, sweeps, runner, agent, MCP file, params, env, egress rules or beads remote. They give only the setting that changes. Every other setting stays as it is.

**Why this priority**: The person edits rig goals often. Hand edits to `rigs.json` are the most frequent operation outside the CLI. A bad hand edit can stop dispatch for every rig.

**Independent Test**: Define a rig. Change only its goal with one command. Make sure that the goal changed. Make sure that every other field is the same. Make sure that no hand edit was necessary.

**Acceptance Scenarios**:

1. **Given** a rig with a cap, sweeps, egress rules and env, **When** the person sets a new goal, **Then** only the goal changes.
2. **Given** a rig with three egress rules, **When** the person adds a fourth rule, **Then** the rig has four rules. **When** the person removes one rule by its host, **Then** the rig has the other three.
3. **Given** a rig, **When** the person sets one env key and then unsets it, **Then** the rig env holds the key and then does not.
4. **Given** a rig, **When** the person sets its beads remote, **Then** the CLI validates the name and user as it does at launch time. It refuses a bad value before it writes.
5. **Given** an invalid value (for example, an egress rule on a rig whose runner has no egress policy), **When** the person sets it, **Then** the CLI refuses it and says why. `rigs.json` does not change.
6. **Given** any rig, **When** the person shows it, **Then** they see every field, and the CLI does not print a secret value.

---

### User Story 2 - Factory settings live in the factory (Priority: P1)

The person keeps the factory's runner settings in the factory home. These settings are the worker image, the vault and the cluster context. They also include the run cap, the extra AX env and the devenv cache. The person reads and changes them with the CLI. The person does not use shell exports or hand-written JSON files.

**Why this priority**: Today a manager started from a shell without the right exports launches workers with the wrong image or vault. One place for these settings removes that class of failure.

**Independent Test**: In a new shell with no `FACTORY_*` exports, start the manager. Make sure that it uses the settings stored in the factory home.

**Acceptance Scenarios**:

1. **Given** a factory home, **When** the person sets the worker image, **Then** the next AX launch uses it with no shell export.
2. **Given** a setting stored in the factory home and the same setting exported in the shell, **When** the factory reads it, **Then** the export wins, and the settings command says that it wins.
3. **Given** a factory, **When** the person lists its settings, **Then** they see each value and where it comes from (stored, environment or default). A secret is never printed.
4. **Given** the devenv cache settings, **When** the person sets the builder, token command and push command with the CLI, **Then** `factory devenv` reads them as it reads `devenv.json` today.

---

### User Story 3 - Build and register the worker image in one step (Priority: P2)

The person builds and pushes the AX worker image. The factory stores the pushed image with its digest as the factory's worker image.

**Why this priority**: Today the person copies a digest from script output into an export. A wrong copy launches an old image.

**Independent Test**: Run the image command with a registry and a builder. Make sure that the image is pushed and the factory's worker image setting holds the new digest.

**Acceptance Scenarios**:

1. **Given** a registry and a builder in the factory settings, **When** the person builds the image, **Then** the CLI prints the image with its digest and stores it as the worker image.
2. **Given** a build that fails, **When** the command ends, **Then** the stored worker image does not change.

---

### User Story 4 - See and swap the Claude token slot (Priority: P2)

The person sees which Claude token slot the AX workers use. The person also sees each slot's 7-day and 5-hour use. They make one slot live by its number. Or they let the factory choose the slot with the lowest 7-day use that is not refused.

**Why this priority**: When one account reaches its weekly limit, every AX worker stops. Today the fix is a private script with hard-coded store item IDs.

**Independent Test**: With two slots configured, show the slots, then make slot 2 live. Make sure that the live slot is 2 and no token is printed.

**Acceptance Scenarios**:

1. **Given** configured token slots, **When** the person lists them, **Then** they see the live slot and each slot's 7-day use, 5-hour use and status. No token is printed.
2. **Given** a slot with no token, **When** the person makes it live, **Then** the CLI refuses and the live slot does not change.
3. **Given** every slot is refused for its limit, **When** the person asks for the best slot, **Then** the CLI says so and changes nothing.
4. **Given** a factory with no token store configured, **When** the person lists slots, **Then** the CLI says how to configure one.

---

### User Story 5 - Start the factory in one command (Priority: P3)

The person starts a factory and its manager with one `factory` command. The command makes the factory if it is new, makes sure that dependencies are installed, and warns outside herdr.

**Why this priority**: `bin/factory-up` works today. If it moves into the CLI, the CLI becomes the one entry point. This adds little new value.

**Independent Test**: In a herdr pane, run the command for a new directory. Make sure that the factory is made and the manager starts.

**Acceptance Scenarios**:

1. **Given** a directory with no `rigs.json`, **When** the person starts it, **Then** the factory is made and its manager starts there.
2. **Given** a missing `bun` or `claude`, **When** the person starts it, **Then** the CLI names the missing tool and stops.
3. **Given** a shell outside herdr, **When** the person starts it, **Then** the CLI warns that workers have no panes and starts the manager.

---

### User Story 6 - Repo contributor guard (Priority: P3)

A contributor to the public repo installs the guard that refuses a commit with a secret or a private infrastructure name. The guard stays the repo script `hack/guard-private.sh`. The README gives one command that installs it.

**Why this priority**: It protects the public repo, but it is contributor tooling, not a factory operation.

**Independent Test**: In a new clone, run the install command from the README, then stage a line that matches a private pattern. Make sure that the commit is refused.

**Acceptance Scenarios**:

1. **Given** a clone, **When** the contributor installs the guard, **Then** the pre-commit and commit-msg hooks run it, and the beads hooks still run.
2. **Given** no private pattern file, **When** a commit runs, **Then** the guard says that nothing was checked and lets the commit go, as today.

---

### Edge Cases

- Two commands change `rigs.json` at the same time (the manager and the person). The last write must not drop the other change.
- A setting changes while runs are live. A live run keeps the settings it launched with. The change applies to the next launch.
- A rig name and a repo path refer to the same rig. Each rig command accepts either.
- `rigs.json` is not valid JSON after an older hand edit. The CLI refuses to write and names the file and the error.
- A setting that names a secret (a token command, a vault key) is shown by name or command, never by value.
- The token store is locked or needs an interactive sign-in. The CLI says so and changes nothing.
- An old factory home has `devenv.json` and shell exports but no stored settings. It keeps its behavior with no migration step.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The CLI MUST change one or more named fields of an existing rig. It MUST keep every other field.
- **FR-002**: The CLI MUST set and unset single keys in a rig's env.
- **FR-003**: The CLI MUST add one egress rule to a rig. It MUST remove one rule by its host list.
- **FR-004**: The CLI MUST set and clear a rig's beads remote, with the same validation that the launch uses.
- **FR-005**: The CLI MUST validate every rig change before it writes. If the CLI refuses a change, it MUST leave `rigs.json` unchanged.
- **FR-006**: The CLI MUST show one rig with all of its fields, with no secret values.
- **FR-007**: The CLI MUST write `rigs.json` so that a concurrent writer does not lose a change.
- **FR-008**: The CLI MUST store factory settings in the factory home. The settings are: worker image, vault, cluster context and namespace, capabilities, run cap, extra AX env and devenv cache settings.
- **FR-009**: The CLI MUST let an environment variable override a stored setting. The CLI MUST show which source each value comes from.
- **FR-010**: The CLI MUST build and push the worker image. It MUST store the pushed image with its digest as the worker image only when the push succeeds.
- **FR-011**: The CLI MUST list the Claude token slots with the live slot and each slot's 7-day use, 5-hour use and status.
- **FR-012**: The CLI MUST make a named slot live. On request, it MUST make the slot with the lowest 7-day use among the allowed slots live.
- **FR-013**: The CLI MUST never print a token or a secret value.
- **FR-014**: The token store MUST be configured per factory. The repo MUST NOT contain store item IDs or other private names. The factory settings hold a read command and a write command for the store. The CLI supports any store through these commands.
- **FR-015**: The CLI MUST start a factory and its manager in one command. If the factory is new, the CLI MUST make the factory first.
- **FR-016**: The public-repo guard MUST stay the repo script `hack/guard-private.sh`. It is not a `factory` subcommand. The README MUST give one command that installs it into the pre-commit and commit-msg hooks next to the beads hooks.
- **FR-017**: The change that adds the new commands MUST delete `bin/factory-up` and `hack/push-worker.sh`. No wrapper stays.
- **FR-019**: The CLI MUST NOT change the live token slot by itself. A usage limit on a slot does not start a swap.
- **FR-018**: The usage text and README MUST document every new command. They MUST no longer tell the person to edit `rigs.json` or to write `devenv.json` by hand.

### Key Entities

- **Factory home**: The directory that holds `rigs.json`, the runs, and the stored factory settings.
- **Rig**: A repo the factory works. It has a name, a repo path, a factory, a cap, sweeps, a goal, a runner, an agent, an MCP file, params, env, egress rules and a beads remote.
- **Egress rule**: A list of hosts, an optional port, and an optional vault key with a header and prefix.
- **Factory setting**: A named value with a source: stored, environment or default.
- **Token slot**: A numbered Claude token in a secret store. One slot is live, and the AX workers use it.
- **Worker image**: The AX worker image reference with its digest.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A person changes any one rig field with one command and no hand edit to `rigs.json`.
- **SC-002**: None of the 12 surveyed operations needs a hand edit to a factory file or a shell export.
- **SC-003**: A manager started from a clean shell launches AX workers with the same image and vault as one started from the person's usual shell.
- **SC-004**: A swap to the best token slot takes one command and less than 30 seconds.
- **SC-005**: No command output in the test suite contains a token or secret value.
- **SC-006**: A search of the repo finds no private infrastructure name or store item ID added by this feature.

## Assumptions

- The CLI stays one Bun entry point (`bin/factory`). New operations are subcommands of it.
- The stored settings live in one file in the factory home, next to `rigs.json`. The file holds no secret values, only names and commands that fetch them.
- `rig add` keeps its current behavior (define or replace a whole rig), so existing scripts and docs stay valid.
- The token slot model is the same as today. The store holds numbered slot tokens, one live token that agent-vault reads, and the number of the live slot. The configured commands read and write these values.
- The person signs in to the token store interactively. The CLI does not keep a session.
- The factory's own runs and the manager can call the new rig commands. The commands are the supported way for the manager to change a rig.
- The guard's private pattern file stays a hand-kept file in the git common dir. Its content is private, so no command writes it.
