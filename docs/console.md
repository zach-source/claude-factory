# The console

The console shows every run. It sits beside the chat. Type `/factory` to open it.

Keys 1-7 switch tabs. Press `tab` to move between controls. Press `enter` to press the
focused control. Press `esc` to go back to the prompt.

The header shows four counts, when they are not zero: runs working, runs awaiting you,
stuck runs, and waiting runs. It also shows a sparkline of run activity. A `stop` button
appears while runs are live. A `resume` button appears when the factory is paused or
stopping.

While the console is closed, a band above the prompt still shows the run count and an
`open console` button. If a run is at a gate, the band shows that gate's question and its
outcome buttons, so you can decide it without opening the console.

## Board (key 1)

The Board tab lists every run. Its data comes from `factory tick`, which the console polls
every 5 seconds. Opening a run also calls `factory show <run>` and reads the worker's pane
with `herdr pane read`.

Live runs sit in four columns by state, in this order: `? AWAITING YOU` (yellow), `! STUCK`
(red), `● WORKING` (green) and `◷ WAITING` (blue). Each run is in exactly one, the same
state the header and status line count. A column lists its runs oldest first. From 120
columns the runs awaiting you take a full-width band on top, where a gate's question and
buttons have room, and the other three sit side by side below it, an empty one reading `none`.
Narrower, they stack as titled sections in the same order, and an empty one is left out.
Finished runs sit below a `Finished` rule, collapsed by default.

Each run is a compact card: its id (shortened to `mv4y…yjy4` in a narrow column) and rig, its
bead and goal, its station with a time (elapsed in the station, `quiet 40m` for a stuck run,
`wakes 14:20` for a waiting one) followed by its try, how long ago it last reported and any
usage-limit wait, and one line of why: the gate's question, the stuck reason or the last
summary. An open card's `-` at its top shrinks it back to the compact card. A gate's note input and outcome buttons show on its card.

| Key or button | What it does |
| --- | --- |
| `1` | Switch to the Board tab. |
| `open` | Expand the run's full card: below the columns when they are side by side, in place of the compact card when stacked. It shows the full goal, the Steer controls, Tasks, Journal, and the Worker pane peek. |
| A gate's outcome buttons | Decide the run's gate. An optional note goes to the next station. |

An open card adds these controls, under a `Steer` rule:

| Key or button | What it does |
| --- | --- |
| A mail input | Send a message into the worker's current session. This input shows only while the run is working and is not at a gate. |
| A station select | Pick a target station for `go to` or `fork at`. |
| `go to <station>` / `restart <station>` | Move the run to the picked station. The label reads `restart` when the picked station is the run's current one. |
| `fork at <target>` | Start another run at the picked station, as a copy of this one. |
| `retry` | Retry a stuck run. |
| `jump to worker` (`j`) | Jump to the run's pane. |
| `abort` | Abort the run. |
| `close` (`b`) | Collapse the card. |

Below Steer, an open card shows three more sections. Tasks shows the run's bead's children: a
closed-of-total count and bar, then up to 8 open ones. Journal shows the run's last 8 reports.
Worker shows a peek at the worker's pane output.

The Finished list, below the live runs, adds:

| Key or button | What it does |
| --- | --- |
| `show` / `hide` | Show or hide the last 10 finished runs. |
| `open` | Open a finished run's card. |
| `remove` | Remove the run with `factory rm`. The run's branch stays. |

Use Board to see what every run is doing right now, to decide a gate, to steer a run to a
different station, or to read a run's recent history.

![The console's board tab](images/console-board.png)

## Backlog (key 2)

The Backlog tab lists each rig's beads. Its data comes from `factory backlog`: each rig's
beads labeled `factory`, plus its unlabeled beads that are ready to start, and beads held back
by an open bead (marked `⛔` with the blocker's id). Per rig that is three `bd` listings
(ready, blocked, every bead for the child counts), not one call per bead.

A type filter narrows the list: `all`, `bug`, `feature`, `task`, `epic`, or `chore`.

Each rig gets one rule: `── api · busy 2/2 · 3 queued · 41 waiting ──`. Its goal, cap bar and
stations are on the Rigs tab. Below the rule are two lists: beads that will start on their
own, and beads that wait for you to queue them (the first 15).

A parent shows `[done/total]` of its children and starts collapsed; `▸` opens it and `▾`
closes it, and its children hang from it with `├─` and `└─`.

A bead that a sweep pass filed carries a `sweep:<name>` label (for example `sweep:maintain`).
Both lists group these apart from the priority tiers, under their own `sweep:<name> (n)`
heading, so a sweep's findings do not mix into a person's own priority order.

| Key or button | What it does |
| --- | --- |
| `2` | Switch to the Backlog tab. |
| A type button (`all`, `bug`, `feature`, `task`, `epic`, `chore`) | Filter both lists to that bead type. |
| `▸` / `▾` | Show or hide a parent's children. |
| `all rigs` | Shows only after the Rigs tab's `backlog` button picked one rig; clears that filter. |
| `queue` | Queue a bead to start on its own. This button shows only for a bead with no parent that is not queued yet. |
| `start now` | Start a run on this bead now, with `factory start`. |

Use Backlog to see what work is ready in each rig, and to queue or start a bead.

## Mail (key 3)

The Mail tab lists messages between the manager and the workers. Its data comes from
`board.mail`, the last 50 messages.

Two sub-tabs split the list: "not answered" and "answered".

| Key or button | What it does |
| --- | --- |
| `3` | Switch to the Mail tab. |
| `not answered (n)` / `answered (n)` | Switch sub-tab. |
| `open run` | Open the message's run on Board. |
| A feedback input | Type a note for the worker. Optional with `approve` or `reject`. |
| `approve` | Answer the message with approval. |
| `reject` | Answer the message with rejection. |
| `send feedback` | Send the typed feedback as the answer. This button shows only once you have typed something. |

When a message's run is at a gate, its newest message shows that gate's outcome buttons
instead of approve/reject.

Use Mail to answer a worker's question without opening its run, and to see what you have
already answered.

## Rigs (key 4)

The Rigs tab lists every rig. Its data comes from `board.rigs` (the factory's `rigs.json`)
and the current runs.

Each rig shows a capacity bar, how busy it is against its cap, its sweeps, and its goal. It
also shows a count of runs per station, which runs are awaiting you, which are stuck, and
how many have finished or aborted.

| Key or button | What it does |
| --- | --- |
| `4` | Switch to the Rigs tab. |
| `backlog` | Switch to the Backlog tab, showing only this rig. |
| `open` | Open a run that belongs to no rig. |

A rig with no live runs says so. Runs that belong to no rig get their own list, "outside
any rig".

When the pm ranks a rig, the Rigs tab shows a "Next up" line. The line names up to 3 beads,
in order, each as `<id> (P<priority>) <why>`.

A yellow line follows for each finding: a starved epic, a goal with no open bead, or a gap
in the plan. The header and the band also show the plan's age, for example "plan 12m ago ·
2 findings", or "plan stale" after 2 hours.

A rig can opt into the [Linear pull loop](beads.md#linear) with `rig add ... --linear <team id>`.
Such a rig shows one more line.

- After a pull, the dim line reads "linear · pulled N · \<age\> ago". It adds ", unrouted M"
  right after the pulled count when an issue matched no rig (see
  [Route issues to a rig](beads.md#route-issues-to-a-rig)).
- When the last pull failed, the red line reads "linear: \<error\>".
- A rig with no `--linear` team shows no line.

Use Rigs to see how full each rig is and whether any of its runs need you.

## PRs (key 5)

The PRs tab lists pull requests. Its data comes from `factory prs`, the per-run PR record,
refreshed at most once every 60 seconds. Until the first answer arrives, the tab shows
"Asking GitHub…".

PRs are grouped by rig, then by run. Live runs come first. Then come up to 25 ended runs,
newest first; older ones are counted but not shown.

Each run shows its id, its bead, and either a button to its current station (or `decide`
when it is at a gate) or "run ended". Below that are its own PRs: repo and number, state
and checks, role, and title. PRs only mentioned in a report or message, not opened or
reviewed by the run, list under "also named".

| Key or button | What it does |
| --- | --- |
| `5` | Switch to the PRs tab. |
| `<station> ›` | Open the run on Board, at its current station. |
| `decide ›` | Open the run on Board, to decide its gate. This button shows instead of `<station> ›` when the run is at a gate. |

Use PRs to see every pull request a rig's runs have touched, and to jump to a run whose PR
needs a look.

## Interview (key 6)

The Interview tab lists questions that only you can answer. Its data comes from runs that
are at a gate, parked, stuck, or waiting on a pane prompt. It also comes from `factory decisions`:
each rig's bd beads flagged for a person, and its unassigned ready beads. The `factory decisions`
data refreshes at most one time in 60 seconds. The tab also shows the options that the manager
proposed for a bare item.

Each item has a short title with the run or bead id and the decision in plain words. For
example, the title can be "ama-gs2: will you merge PR #68 now?" Below the title is one line of
context that shows what is true at this time. Below the context are 2-4 option buttons. Each button has a short label.
Next to each button is one line on its effect.

When the manager marks one option as recommended, its button shows a mark. This button also
stands out more than the others. The full raw report is behind a `details` toggle. The
collapsed row does not show the report.

A gate item's context line starts with `Brief: ` and shows the first line of the evidence brief.
The hidden `factory:briefer` subagent writes this brief once for each gate visit, and the context
line stays empty until then. The `details` toggle shows the full brief, up to 8 lines, from the pull
request, the verify and review summaries, and the run's own goal. The briefer cannot decide the
gate, and you still pick the outcome yourself.

A run that parked with `parked, waiting on: <command>` is an owner step. The `questions` sub-tab
shows all owner steps from all rigs first, under one `Owner steps (N)` header. Each row shows the
exact command, the run, the rig and the age. An owner step never folds into another row. Your
answer to a row mails only that run's station.

Two other open items that have the same decision fold into one row. This applies to the same bead, or
to the same question in the same rig. Answering that row answers every run or bead that the row covers.

| Key or button | What it does |
| --- | --- |
| `6` | Switch to the Interview tab. |
| `Interview me` | Sweep every rig for new gates, parked or stuck runs, blocked workers, and bd decisions, and ask the manager to propose a title, context and options for the items that still need them. |
| `questions (n)` / `answered (n)` | Switch sub-tab. |
| `open run` | Open the item's run on Board. |
| A gate's outcome buttons | Decide the run's gate. Shows for a gate item. |
| `open pane` | Jump to the run's pane. Shows for a worker waiting on a prompt. |
| `details ▸` / `details ▾` | Show or hide the full raw report behind the short title and context. |
| An answer input | Type an answer in your own words. Shows for a parked, stuck, bd-bead, or owner-only item. |
| An option button | Pick one of the options. The recommended one, when there is one, stands out and says "(recommended)"; with no marked option, none is singled out. |
| `send answer` | Send the typed answer. Shows once you have typed something. |
| `abort run` | Abort the item's run. |

Use Interview to see every open question across every rig in one list, instead of checking
Board, Mail, and Rigs in turn.

## Runners (key 7)

The Runners tab shows where the workers run. It has one section for each runner: `herdr`
(panes on this machine) and each other runner that a rig names, for example `ax` (VMs). The
data comes from `factory tick`.

A section header shows the runner's rig count, its busy runs and its live runs. Below it, a
line lists the rigs on that runner. A rig shows its sandbox class (for example `microvm`) when
it has one, and `(off)` when its `maxRuns` is 0. Then each live run has one row: its id, rig,
station and state, and pane (`ax://<task>` for a VM worker).

A run goes to its rig's runner. A run with no rig goes to `ax` if its pane is an `ax://`
task, and to `herdr` if not.

