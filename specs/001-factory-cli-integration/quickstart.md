# Quickstart: validate the feature

Run these checks in a scratch factory. Use a throw-away directory.

## Prerequisites

- `bun` and `claude` on `PATH`.
- A scratch factory: `bin/factory init /tmp/factory-qs && export FACTORY_HOME=/tmp/factory-qs`.
- A rig: `bin/factory rig add demo <repo-path>`.

## 1. Change one rig field (story 1, SC-001)

1. Run `bin/factory rig show demo > before.txt`.
2. Run `bin/factory rig set demo --goal 'new goal'`.
3. Run `bin/factory rig show demo > after.txt`.
4. Expected: `diff before.txt after.txt` shows only the goal line.
5. Run `bin/factory rig egress add demo example.test`, then `rig egress rm demo example.test`. Expected: the egress list returns to its first state.
6. Run `bin/factory rig set demo --runner <runner with no egress policy>` and then an egress add. Expected: exit 1, a reason, and `rigs.json` unchanged.

## 2. Stored settings (story 2, SC-003)

1. Run `bin/factory settings set ax.context ctx-a`.
2. In a new shell with no `FACTORY_*` export, run `bin/factory settings list`. Expected: `ax.context` is `ctx-a`, source `stored`.
3. Run `FACTORY_AX_CONTEXT=ctx-b bin/factory settings list`. Expected: `ctx-b`, source `environment (overrides stored)`.

## 3. Image (story 3)

1. Set `image.registry` and `image.builder`.
2. Run `bin/factory image build`. Expected: `image@digest` printed, and `ax.image` holds it.
3. Make the build fail (a bad builder name). Expected: exit 1, `ax.image` unchanged.

## 4. Token slots (story 4, SC-004, SC-005)

1. Set `token.read` and `token.write` to commands for a test store (a directory of files works).
2. Run `bin/factory token`, then `bin/factory token use 2`, then `bin/factory token best`.
3. Expected: the live slot changes, and no output holds a token. Run `... | grep -c <token>` and expect 0.

## 5. Up (story 5)

Run `bin/factory up /tmp/factory-new` in a herdr pane. Expected: the factory is made and the manager starts. Run it with `bun` off `PATH`. Expected: exit 1 and the tool name.

## 6. Guard (story 6)

In a clean clone, run the README install command. Stage a line that matches a private pattern. Expected: the commit is refused.

## 7. Repo checks (SC-002, SC-006, FR-017, FR-018)

- `test ! -e bin/factory-up && test ! -e hack/push-worker.sh`.
- `grep -rn 'bin/factory-up\|push-worker' README.md docs src` returns nothing.
- `grep -rn "by hand" README.md docs` shows no instruction to edit `rigs.json` or write `devenv.json`.
- `bun test` passes.
