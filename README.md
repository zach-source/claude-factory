# claude-factory

Software factories for loop-graph engineering on herdr. A factory is a graph of
stations; a run is an xstate machine over that graph whose snapshot is persisted
on every tick. Each station is worked by its own Claude session in a herdr tab of
the run's git worktree, and the outcome it reports routes the run along the graph.
A Claude mod turns one session into the manager: it ticks every run, draws the
board, and wakes the manager model with mail.

## Run it

```sh
bun install
# the manager session, in a herdr pane
claude-smart --new --plugin-dir ~/repos/workspaces/claude-factory/mod
```

In the manager session:

```
/factory start lifecycle ~/repos/my-app Add a /health endpoint with tests
/factory start lifecycle@monitor ~/repos/my-app watch production
/factory start lifecycle@maintain ~/repos/my-app keep it maintained
/factory start lifecycle@improve ~/repos/my-app keep improving it
/factory                      # the board: runs, stations, workers, gates, manager mail
/factory status <run>         # one run's full journal
```

## The lifecycle factory

[`factories/lifecycle.ts`](factories/lifecycle.ts) is the whole software lifecycle in one graph:

| Loop                         | Stations                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| build                        | triage → plan → implement ⇄ verify ⇄ review (→ security) → release → **approve** → deploy → soak |
| optimize (performance, cost) | baseline → plan → implement ⇄ verify against the target → … → soak; abandon when disproved       |
| refactor                     | characterize (pin behavior) → plan → implement ⇄ verify → … → soak                               |
| operate                      | soak regressed → rollback → plan (fix forward) → … → soak resolved → postmortem                  |
| incident                     | incident → rollback or plan → … → postmortem, which files the action items                       |
| sweeps                       | monitor (every 30 min), maintain (daily), improve (daily, rotating refactor, performance, cost)  |

Sweeps never end: each pass files what it finds as runs of its own (`lifecycle@incident`,
`@plan`, `@baseline`, `@characterize`), skipping duplicates. **approve** is a gate: nothing
merges or deploys until you decide it, with the board's buttons or `/factory decide`.
Models follow the tiers: Sonnet executes, Opus plans and reviews, Fable reviews security.
`factories/lifecycle.test.ts` walks every loop through the machine.

`bin/factory help` lists every command; the manager model uses the same CLI.

## Define a factory

`factories/<name>.ts` exports a graph ([review-loop](factories/review-loop.ts)):

```ts
export default {
  name: 'review-loop',
  start: 'implement',
  nodes: {
    implement: { prompt: '...', next: { ready: 'review' } },
    review: { prompt: '...', next: { approve: 'done', changes: 'implement' } },
  },
} satisfies Factory
```

Per station: `retries` (default 2), `timeoutMin` (60), `agent` (worker command), and
`gate: true` for a station the person decides instead of a worker. An edge can wait:
`{ to: 'soak', delayMin: 15 }` parks the run with no worker; `goto` skips the wait.
Per factory: `agent`, `rules` (house rules in every brief), `backoffSec` (30, doubling),
`maxSteps` (20 worker launches before the run is held for the manager; every timed
edge refills it, so a sweep loops forever). Edits apply at the next tick.

## How a run behaves

- **Snapshots**: `.factory/runs/<run>/state.json` is the run. Every tick restores
  it, drains `inbox.jsonl`, reconciles the worker, and writes it back (fsynced),
  so a crashed or restarted manager picks up where it stopped.
- **Mailboxes and journal**: a station's report summary is mailed to the next
  station, and every brief carries the run's journal of all reports, so a plan or a
  baseline reaches every later station. The manager and workers mail each other
  with `factory mail`; a worker waiting on an answer is not nudged.
- **Gates**: a gate pages the manager with the evidence. Only `factory decide` answers
  it: workers are refused, and the manager model's decide needs your Allow in a dialog.
- **Retries**: a failed report, timeout, closed pane or a worker that goes idle
  without reporting (after two nudges) backs off and retries with a fresh worker.
  Out of retries, the station is stuck and the manager is paged. Stations with
  side effects you never want repeated: `retries: 0`.
- **Durable workers**: a worker whose pane dies resumes its own Claude session once
  before falling back to a retry; fresh workers are told what the branch already
  committed. Reports carry the worker's `seq`, so stale and duplicate ones drop.
- **Quarterbacking**: `decide`, `retry`, `goto <station|done>`, `abort`, `fork <run>
<station> [note]` (try another approach on a copy), `rm` (finished runs; the branch
  stays). `start` and `fork` refuse past `FACTORY_MAX_RUNS` (8) runs holding a worker.

## Caveats

- Workers run `--dangerously-skip-permissions` by default, each in its own
  worktree. Set `agent` to change that.
- Claude trusts a worktree through its main repo. Start runs on repos you have
  already opened in Claude, or each worker stops at the folder-trust dialog (the
  board shows it as blocked).
- Station prompts are stack-agnostic and defer to the repo's own CLAUDE.md,
  CONTRIBUTING and CI. Deploy, soak, rollback and monitor need the workers to reach
  your deploy tooling and telemetry (kubectl, gh, the Grafana MCP) the way you do.
- The gate guard against workers is an environment check, not a lock: a worker set
  on it could still run `factory decide`. The manager-session dialog is enforced.
- One manager session at a time: a second one shares the ticks, and manager
  mail goes to whichever one ticks first.
