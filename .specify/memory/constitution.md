# claude-factory Constitution

## Core Principles

### I. Worker Parity (NON-NEGOTIABLE)

All workers must receive the same skills, rules and MCP servers. This applies to every agent backend (claude, codex, pi) and to every runner (the laptop pane, the AX VM).

- A skill or a set of rules that a worker gets must reach all backends and runners through one source. Today that source is `src/worker-system.md`. Claude reads it as its system prompt. Codex reads it as `AGENTS.md`.
- Do not give a skill to a worker through a path that only one backend or runner has. An example is a Claude plugin that only the laptop has. If a plugin is necessary, put it into the worker image. Then give it to all backends.
- An MCP server that a rig sets (`rig add --mcp`) must reach every worker of that rig. If a runner or backend cannot load the server, the factory must refuse the setting. It must not run the worker without the server. (`rig add` refuses `--mcp` for a remote runner for this reason.)
- A change can add a skill, rules or an MCP server to one backend or runner. Then it must add it to all of them in the same change. If it cannot, it must file a bead for each gap. The PR must name each gap.

### II. Front-end Parity (NON-NEGOTIABLE)

The factory has one manager core. The core owns each feature and each rule of the factory and the manager. Each front end is a thin client of the core. Each front end must have the same features and functionality. The front ends are:

- the web UI
- the CLI (`bin/factory`)
- the Claude Code mod (`mod/`)
- the Herdr app mod (`herdr/mods/factory`)

The rules:

- A front end must not hold factory logic of its own. Validation, scheduling, gate and decision authority, leases, guards and state changes belong in the core. A front end only shows the data of the core. It sends the person's commands to the core.
- Each feature is an operation of the core. A front end gets an operation through the one interface of the core. A front end must not use its own copy of the code for an operation.
- A change can add a feature or change its behavior. Then the change must add it to the core and to each front end in the same change. If it cannot, it must file a bead for each front end that does not have it. The PR must name each gap.
- A new front end must use the same core interface. It must get the current features without a change to the core.
- The core must work in local mode (state on the laptop). It must also work in server mode (spec 004). A front end must work in each mode that it supports, with no change to its own code.
- A front end can add only presentation. Presentation means layout, keys, colors and the order of items. A front end that cannot show a feature must give a link or command to a front end that can. For example, a status band of one line cannot show a feature.

Cause: on 2026-11-07, the Herdr mod had about half of the features of the Claude mod. Each front end kept its own copy of the logic. A fix in one front end did not apply to the others.

## Governance

This constitution has priority over other practices in this repo. Each PR and review must make sure that the change obeys it. To change the constitution, open a PR that gives the reason and updates the version.

Known gaps on 2026-10-27 (after claude-factory-fxu, claude-factory-qo6i, claude-factory-hg9o and claude-factory-qda):

- The `asd-ste100` hooks (the session brief and the score check) run only for Claude workers. Codex and pi workers get its skill and the STE rule in its brief, but not its hooks.
- A VM worker gets the image's plugins for its station's skills. A laptop worker gets a plugin only when the person has it on. A skill name must be in the image (`VM_PLUGINS`), so a skill is on every backend or refused.
- The `egm` review runs only for Claude workers. Codex and pi workers get no egm skill or review instruction (claude-factory-yt5d).

Known gaps of Principle II on 2026-11-07 (spec 008 closes them):

- There is no core interface that all front ends use. The Claude mod holds factory logic in `mod/hooks`. Examples are the Bash gate in `view.ts`, the patrol and pm timers, and the board views. The core does not own this logic.
- The Herdr mod does not have these tabs: Backlog, Mail, Rigs, PRs and Runners. It has no stop and resume control. It has no worker screen for an AX run. It has no manager chat.
- The web UI is `factory ui`. It is a dashboard that only reads. It cannot send commands.
- The CLI has the operations. Some operations are only in the Claude mod. Examples are the manager chat and the gate briefs on the board.

**Version**: 1.1.0 | **Ratified**: 2026-10-26 | **Last Amended**: 2026-11-07
