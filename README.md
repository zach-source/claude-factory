# claude-factory

Software factories for loop-graph engineering on herdr. A factory is a graph of
stations; a run is an xstate machine over that graph whose snapshot is persisted
on every tick. Each station is worked by its own Claude session in a herdr tab of
the run's git worktree, and the outcome it reports routes the run along the graph.
A Claude mod turns one session into the manager: it ticks every run, draws the
board, and wakes the manager model with mail and toward each rig's goal.

## Run it

```sh
bun install
bin/factory init ~/my-factory   # a new factory: a directory for its rigs and runs
cd ~/my-factory
# the manager session, in a herdr pane: a session started in a factory's directory works it
# fullscreen layout: the console docks right of the chat (herdr and tmux default to the main screen)
CLAUDE_CODE_NO_FLICKER=1 claude-smart --new --plugin-dir ~/repos/workspaces/claude-factory/mod
```

In the manager session:

```
/factory rig add my-app ~/repos/my-app --max 3 --goal ship the v2 API   # a rig: a repo the factory works
/factory start lifecycle my-app Add a /health endpoint with tests
/factory start lifecycle@monitor my-app watch production
/factory start lifecycle@maintain my-app keep it maintained
/factory start lifecycle@improve my-app keep improving it
/factory                      # the board: runs, stations, workers, gates, manager mail
/factory status <run>         # one run's full journal
```

## The manager drives

You talk to the manager session; it runs the factory. With `autopilot` on (the default)
the mod wakes the manager model with a `[factory] patrol` whenever there is mail for it (a
worker's question, a stuck station, a gate, a finished run), when a worker is blocked on a
prompt, and every 10 minutes while workers run or a rig with a goal has room. A patrol answers mail, unsticks runs
(`retry`, `goto`, `fork`, `abort`), pokes workers (`factory poke <run> [steer]`), takes the
next work from the backlog when there is room, brings gates to you, and ends with a report
of at most three lines. Underneath, the runtime stays mechanical: it ticks every 5 s,
launches and resumes workers, nudges an idle one twice and retries with backoff, so a
quiet manager never stalls a run.

The roles follow [Gas Town](https://github.com/steveyegge/gastown): the manager is the
Mayor (your one point of contact, which hands out the work), station workers are polecats
(a fresh session per visit, a durable identity in the run), each repo the factory works is
a rig, the tick's nudges and session resumes are the Witness, the mod's timer is the daemon,
and mail escalates from worker to manager to you.

## Rigs

A factory is a directory (Gas Town's town): `factory init <dir>` makes one, its
`rigs.json` defines its rigs, and its runs live beside it. Commands, the manager session and
`factory loop` started inside it work that factory; `FACTORY_HOME` overrides, and with
neither the factory is `.factory-state/` here. Run several factories side by side, each with its
own manager.

A rig is a repo the factory works, by name. Its ready beads labeled `factory` start as runs,
it keeps its sweeps running, and it has its own cap on busy runs under the factory's
`FACTORY_MAX_RUNS`. A goal is the person's standing direction for the rig: while the rig has
room, the manager's heartbeat patrol carries it and gives the rig the next work toward it.

```sh
factory rig add web ~/repos/web --max 4                     # all of lifecycle's sweeps
factory rig add app ~/repos/app --max 3 --sweeps none --goal finish the v2 features
factory rig add infra ~/repos/infra lifecycle --max 2 --sweeps monitor
factory rig add docs ~/repos/docs review-loop --sweeps none
factory rig                                                 # each rig, its busy runs and sweeps
factory rig rm docs                                         # nothing new starts; its runs carry on
```

A rig's name stands for its repo in every command (`start lifecycle web ...`, `queue web
fx-12`); a repo outside the rigs is given as a path (`./app`, `~/repos/app`). The board tags each run with its rig and the backlog is grouped by rig, with its
room, so the manager fills each rig up to its own cap. Edit `rigs.json` by hand or
redefine a rig with `rig add`; there is one rig per repo.

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
`@plan`, `@baseline`, `@characterize`), skipping duplicates. `factory loop` ticks with no
console open and keeps one run of each of a rig's sweeps: abort a sweep to stop it, `rm`
it to let the loop start it again. **approve** is a gate: nothing
merges or deploys until you decide it, with the board's buttons or `/factory decide`.
Models follow the tiers: Sonnet executes, Opus plans and reviews, Fable reviews security.
`factories/lifecycle.test.ts` walks every loop through the machine.

`bin/factory help` lists every command; the manager model uses the same CLI.

## The factory improves itself

`factory adopt <repo>` copies the lifecycle template into `<repo>/.factory/lifecycle.ts`;
commit it, and the repo owns its factory like any other code:

- **Runs pin their factory.** `start lifecycle` (and a rig's dispatch) use the repo's own
  `.factory/lifecycle.ts` as of the commit the run starts from, copied into the run, so no
  later edit, the run's own included, changes the graph under it. Without a repo copy, the
  template in `factories/` is used. `factory status <run>` says which version a run follows.
- **New runs start from what has merged.** A run branches from the remote's default branch,
  freshly fetched, whenever that already holds your local HEAD; from local HEAD when you have
  unpushed work. So a merged factory change reaches the next run with nothing to pull.
- **The improve sweep's fourth lens is the factory itself**: it reads recent runs' journals
  and the closed factory beads' comments (retries, stuck stations, loops, gates always
  answered the same way, costly models) and files one change to `.factory/` per finding.
  Postmortems file the factory changes an incident exposed.
- **Those changes ship like any change**: plan, implement, `factory check` in verify, a review
  that reads them as policy (security review when they remove a gate, widen what runs
  unattended or raise a limit), and your approve gate. Deploy reports them as published.
- `factory check <file>` validates a factory: the graph, its outcomes and timed edges, and a
  way to `done` from every station. A factory whose starting commit does not validate is
  refused before any worker starts, and its bead is deferred with the reason.

## Shared memory and the dream

A factory's workers share what they learn in `<factory>/memory/`, three levels deep so a
brief stays short and a search finds the rest:

```
memory/
  CORE.md              the few lessons nearly every run needs: every brief carries it whole
  <topic>/README.md    what the topic covers, its notes most important first: briefs list topics
  <topic>/<note>.md    one learning each (summary, rig, from, at, body): found by search
  inbox/<note>.md      new notes, until the dream files them
```

- Workers search before they start and save what a later worker would otherwise relearn:
  `factory memory search [--rig r] <query>` (local embeddings, bge-small, no service; a note
  ranks by its own match and its topic's, and another rig's notes never show) and
  `factory memory add [--rig r] [--from run/station] <summary> [body]`. The manager searches
  it before answering a worker and saves the person's decisions that later runs should follow.
  `factory memory helped <note>` marks a note that saved a worker time; with how often searches
  return each note, it is what the dream orders by.
- **The dream** (`factory dream`; each tick starts one a day) is a headless Claude that can only
  edit inside the memory: it files the inbox under topics, merges duplicates, drops what is
  wrong or stale, writes lessons from the run journals since the last dream, and reorders the
  READMEs and `CORE.md` by importance. A lesson that holds only while a bead is open names it;
  the dream is told which named beads have closed and retires what waited on them. The memory is its own git repo, committed before and
  after each dream: `git -C <factory>/memory log -p` shows what a dream did, and a revert undoes it.

## Beads: planning and execution

In a repo with `.beads/`, beads is the factory's task tracker:

- **Every run works a bead**, its epic. `start` claims the bead its goal names
  (`/factory start lifecycle ~/repos/my-app fx-12`) or creates one from the goal.
- **Planning**: the plan station records its tasks as the bead's children, in dependency
  order. **Execution**: implement works `bd ready --parent <bead>` and closes each task with
  its commit; verify, review and security file their findings as more tasks; release
  refuses while any task is open.
- **The journal mirrors into the bead**: every station's report becomes a comment (a
  sweep's routine passes excepted), and workers' bd writes carry `factory/<run>/<station>`.
- **The end of a run settles its bead**: shipped or otherwise finished closes it; a hold or an
  abort defers it, unassigned (undefer it to hand it back); with open child beads, however the run
  ended, it stays open and unassigned for them.
- **The backlog dispatches itself**: every rig's ready, unassigned, top-level beads labeled
  `factory` become runs, every 30 s while the rig and the town have room. A
  `station:<name>` label starts one at that station.
- **Sweeps file to the backlog**: incidents and security fixes labeled `factory` start on
  their own; everything else is filed unlabeled for you to prioritize by adding the label.
- **Leases**: the run heartbeats its claim every 2 minutes, so a `bd reclaim` reaper never
  takes live work. Without `.beads/`, runs keep task lists in their reports instead.

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

- **Snapshots**: `.factory-state/runs/<run>/state.json` is the run (`FACTORY_HOME` moves it). Every tick restores
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
- The runner and the workers use whatever `bd` is first on PATH; it must match the
  repo's beads schema. Syncing beads across machines (`bd dolt push`) stays yours.
- One manager session at a time: a second one shares the ticks, and manager
  mail goes to whichever one ticks first.
