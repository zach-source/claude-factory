# The console

The console shows every run. It sits beside the chat. Type `/factory` to open it.

Keys 1-6 switch tabs. Press `tab` to move between controls. Press `enter` to press the
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

Live runs come first. Within live runs, the order is: runs at a gate, then stuck runs,
then working runs, then waiting runs. Finished runs sit below a `Finished` rule, collapsed
by default.

Each run is a card. A closed card shows the run's id, bead, station, and standing. It also
shows the goal's first line, the station trail, the last report, and any error.

| Key or button | What it does |
| --- | --- |
| `1` | Switch to the Board tab. |
| `open` | Expand the card in place. It shows the full goal, the Steer controls, Tasks, Journal, and the Worker pane peek. |
| `jump to worker` (`j`) | Jump to the run's pane in herdr. |
| `retry` | Retry a stuck run. This button shows only when the run is stuck. |
| `abort` | Abort the run. |
| A gate's outcome buttons | Decide the run's gate. An optional note goes to the next station. |
| `close` (`b`) | Collapse an open card. |

An open card adds these controls, under a `Steer` rule:

| Key or button | What it does |
| --- | --- |
| A mail input | Send a message into the worker's current session. This input shows only while the run is working and is not at a gate. |
| A station select | Pick a target station for `go to` or `fork at`. |
| `go to <station>` / `restart <station>` | Move the run to the picked station. The label reads `restart` when the picked station is the run's current one. |
| `fork at <target>` | Start a new run at the picked station, as a copy of this one. |
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
beads labeled `factory`, plus its unlabeled beads that are ready to start.

A type filter narrows the list: `all`, `bug`, `feature`, `task`, `epic`, or `chore`.

Each rig shows its repo, its factory, how busy it is, and its goal. Below that are two
lists: beads that will start on their own, and beads that wait for you to queue them (the
first 15).

| Key or button | What it does |
| --- | --- |
| `2` | Switch to the Backlog tab. |
| A type button (`all`, `bug`, `feature`, `task`, `epic`, `chore`) | Filter both lists to that bead type. |
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
| `backlog` | Switch to the Backlog tab. |
| `open` | Open a run that belongs to no rig. |

A rig with no live runs says so. Runs that belong to no rig get their own list, "outside
any rig".

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
are at a gate, parked, stuck, or waiting on a pane prompt, plus `factory decisions`
(each rig's bd beads flagged for a person, and its unassigned ready beads, refreshed at
most once every 60 seconds), plus any options the manager has proposed for a bare item.

| Key or button | What it does |
| --- | --- |
| `6` | Switch to the Interview tab. |
| `Interview me` | Sweep every rig for new gates, parked or stuck runs, blocked workers, and bd decisions, and ask the manager to propose options for the bare ones. |
| `questions (n)` / `answered (n)` | Switch sub-tab. |
| `open run` | Open the item's run on Board. |
| A gate's outcome buttons | Decide the run's gate. Shows for a gate item. |
| `open pane` | Jump to the run's pane. Shows for a worker waiting on a prompt. |
| An answer input | Type an answer in your own words. Shows for a parked, stuck, bd-bead, or owner-only item. |
| An option button | Pick one of the manager's proposed answers. The first option is primary. |
| `send answer` | Send the typed answer. Shows once you have typed something. |
| `abort run` | Abort the item's run. |

Use Interview when you want one list of every open question across every rig, instead of
checking Board, Mail, and Rigs in turn.
