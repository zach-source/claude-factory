# ADR: A macOS Seatbelt sandbox for laptop herdr workers

## Context

Bead: `claude-factory-o7h6h`. A laptop herdr worker runs as the person's user, with no OS sandbox.
Claude, codex, cursor and grok start with their permission or sandbox bypass flags (`src/cli.ts` AGENT and LAUNCHERS).
The person key `~/.config/factory/person.key` (`src/client.ts` tlsFor) has only the text guard `src/token-guard.ts`.
A text guard cannot see a file name built at run time, or the code in a script that the worker writes and runs.
A worker does not need the key: its `factory` CLI keeps the local path (`src/client.ts` isWorker).

## Decision

- On macOS, the runner starts each laptop herdr worker as `/usr/bin/sandbox-exec -p <profile> <agent ...>`.
  The wrap is in `launch()` (`src/cli.ts`). It goes after the env prefix of the line that `command()` (`src/harness.ts`) makes.
- The profile is `(version 1)`, `(allow default)`, then deny rules only:
  - read, write and link of `~/.config/factory`, for every harness;
  - read, write and link of the token stores of the other harnesses (the default path and the env override);
  - write of each ancestor of a denied path, so a rename of an ancestor cannot move the key out of the rule.
- The harness's own token store stays readable, because the harness reads it to log in.
- On macOS without `/usr/bin/sandbox-exec`, the runner refuses the launch.
  On another platform with a person key, the runner refuses the launch. On another platform without a key, the launch does not change.
- A path that the profile cannot quote (`"`, `\`, a control character) or that is not absolute refuses the launch.
- No kill switch: a worker can write `$FACTORY_HOME/settings.json`, which fills the runner's env. Rollback is a revert.

## Rejected

- Claude Code's own sandbox settings: they cover only claude and only its Bash tool, and the network proxy can break git, bd and gh.
- The codex sandbox: it denies writes, not reads.
- An allow-list profile (`(deny default)`): the harnesses, bun, git, bd, gh and nix need too many paths and services.
- A write deny on the factory home files: it does not close the class below, so it adds code for no closure.

## Consequences

- A direct read of the key by the worker's process tree fails with EPERM, also for a name built at run time.
- Not covered: code that a worker plants for a process outside the sandbox (the runner's git and bd calls in the worktree,
  `settings.json`, launch scripts, shell rc files, herdr, launchd, cron). A follow-up bead covers that class.
- Not covered: the worker can read its own harness token. A follow-up bead covers that.
- The verification runs only on a Mac. The owner runs the macOS test before the merge and the per-harness check after the deploy.
