# Changelog

Each release is tagged `v<version>` and its version is set in `package.json` and
`mod/.claude-plugin/plugin.json`. Versions follow [semver](https://semver.org); until 1.0 a
minor release may change the factory format, the CLI or the run state.

## 0.2.0 (2026-10-06)

- herdr's sidebar shows each run's station and what holds it (`$factory` on the run's workspace:
  working, needs you, stuck, parked, or when a timed wait ends), and each manager's workspace
  carries its factory's rollup, e.g. "5 running · 1 need you · 1 parked".

## 0.1.0 (2026-10-06)

The first release: herdr software factories, run from a Claude Code session.

### Runs

- A factory is a graph of stations compiled to an xstate machine; a run is a fold over its
  events, persisted (fsynced) under `.factory-state/runs/<run>/`, so a restarted manager
  picks up where it stopped.
- Each station is worked by its own coding agent in a herdr tab of the run's git worktree;
  its report routes the run. Gates are decided by the person only, through `factory decide`.
- Durable workers: a lost pane resumes its session, a swallowed launch is retried, an idle
  worker is nudged before it is failed, retries back off, and a run that loops is held after
  its step budget. Station deadlines warn once and give half again.
- A worker blocked on a person, a human review or merge, or another run reports `blocked`:
  the run parks with no worker and no attempt spent, and wakes when mailed or after
  `parkMin`.
- `factory stop` and `factory resume` shut workers down gracefully and bring them back.
- `factory fork`, `goto`, `retry`, `abort` and `rm` for the manager.

### Factories

- `lifecycle`: build (triage, plan, implement, verify, review, security, release, approve,
  deploy, soak, rollback), incidents and postmortems, and the monitor, maintain and improve
  sweeps.
- A repo can own its factory (`factory adopt`), and each run follows the version its starting
  commit holds; the improve sweep proposes changes to it.

### Rigs and backlog

- Rigs name the repos a factory works, each with its own cap, sweeps and goal
  (`factory rig add`); `factory init` makes a factory directory.
- Beads drive planning and execution: one bead a run, its tasks as children, each station's
  report as a comment; review and security findings are posted on the pull request.
- A rig can run its workers as Claude, Codex or pi (`--agent`), with its own MCP servers
  (`--mcp`).

### Manager and console

- The `mod/` Claude Code mod ticks every run, patrols the factory as its manager (mail,
  gates, stuck stations, backlog) and draws a live console docked beside the chat, with
  rigs, a mailbox with quick answers, and gate decisions.
- Factory memory: workers share notes, ordered by what helped, groomed by a daily dream.
- `factory metrics`: ship rate, time to ship, approve wait, review loops, failure kinds and
  per-station visits, failures and durations, for the factory and each rig; finished runs
  are kept in `metrics.jsonl` after `factory rm`.
