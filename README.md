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
/factory start review-loop ~/repos/my-app Add a /health endpoint with tests
/factory                      # the board: runs, stations, workers, manager mail
/factory status <run>         # one run's full log
```

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

Per station: `retries` (default 2), `timeoutMin` (60), `agent` (worker command).
Per factory: `agent`, `backoffSec` (30, doubling), `maxSteps` (20 worker launches
before the run is held for the manager). Edits apply at the next tick.

## How a run behaves

- **Snapshots**: `.factory/runs/<run>/state.json` is the run. Every tick restores
  it, drains `inbox.jsonl`, reconciles the worker, and writes it back (fsynced),
  so a crashed or restarted manager picks up where it stopped.
- **Mailboxes**: a station's report summary is mailed to the next station; the
  manager and workers mail each other with `factory mail`. A station's box lasts
  its whole visit, so a retry sees everything the failed attempt saw.
- **Retries**: a failed report, timeout, closed pane or a worker that goes idle
  without reporting (after two nudges) backs off and retries with a fresh worker.
  Out of retries, the station is stuck and the manager is paged. Stations with
  side effects you never want repeated: `retries: 0`.
- **Durable workers**: a worker whose pane dies resumes its own Claude session once
  before falling back to a retry; fresh workers are told what the branch already
  committed. Reports carry the worker's `seq`, so stale and duplicate ones drop.
- **Quarterbacking**: `retry`, `goto <station|done>`, `abort`, `fork <run> <station>
  [note]` (try another approach on a copy), `rm` (finished runs; the branch stays).

## Caveats

- Workers run `--dangerously-skip-permissions` by default, each in its own
  worktree. Set `agent` to change that.
- Claude trusts a worktree through its main repo. Start runs on repos you have
  already opened in Claude, or each worker stops at the folder-trust dialog (the
  board shows it as blocked).
- One manager session at a time: a second one shares the ticks, and manager
  mail goes to whichever one ticks first.
