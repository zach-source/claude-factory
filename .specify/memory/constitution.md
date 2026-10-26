# claude-factory Constitution

## Core Principles

### I. Worker Parity (NON-NEGOTIABLE)

All workers must receive the same skills, rules and MCP servers. This applies to every agent backend (claude, codex, pi) and to every runner (the laptop pane, the AX VM).

- A skill or a set of rules that a worker gets must reach all backends and runners through one source. Today that source is `src/worker-system.md`. Claude reads it as its system prompt. Codex reads it as `AGENTS.md`.
- Do not give a skill to a worker through a path that only one backend or runner has. An example is a Claude plugin that only the laptop has. If a plugin is necessary, put it into the worker image. Then give it to all backends.
- An MCP server that a rig sets (`rig add --mcp`) must reach every worker of that rig. If a runner or backend cannot load the server, the factory must refuse the setting. It must not run the worker without the server. (`rig add` refuses `--mcp` for a remote runner for this reason.)
- A change can add a skill, rules or an MCP server to one backend or runner. Then it must add it to all of them in the same change. If it cannot, it must file a bead for each gap. The PR must name each gap.

## Governance

This constitution has priority over other practices in this repo. Each PR and review must make sure that the change obeys it. To change the constitution, open a PR that gives the reason and updates the version.

Known gaps on 2026-10-26: AX Claude workers get no `asd-ste100` plugin (claude-factory-fxu). Codex workers get no `asd-ste100` skill. pi workers get no `worker-system.md`. A pi worker runs without the rig MCP servers (src/harness.ts warns and goes on). A laptop Claude worker also gets the plugins in `FACTORY_WORKER_PLUGINS`.

**Version**: 1.0.0 | **Ratified**: 2026-10-26 | **Last Amended**: 2026-10-26
