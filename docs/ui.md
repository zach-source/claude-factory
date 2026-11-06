# factory ui

`factory ui` starts a local web page. It shows the beads of every rig and the progress of each epic.

## Start

```sh
factory ui [--port 4792] [--no-sync]
```

Open `http://127.0.0.1:4792`. The server binds `127.0.0.1` only. It refuses a request whose `Host` header is not `127.0.0.1` or `localhost`.

The command reads `rigs.json` of the factory home (`FACTORY_HOME`). It uses each rig that has a `.beads` directory in its repo path.

## Sync

The page pulls the beads of each rig from its Dolt remote:

- when the command starts,
- when you press the **Sync** button,
- every 10 minutes.

The sync only pulls. It never pushes. It runs `CALL DOLT_PULL('--user', <user>, <remote>, 'main')` on the Dolt server of the rig, with `beadsRemote` of the rig in `rigs.json`. A rig with no `beadsRemote` is not synced.

If a sync fails, the card of that rig shows the error. The page still shows the local data.

With `--no-sync`, the page does not pull. The **Sync** button then only reads the local beads again.

## Needs you

The first tab, **Needs you**, lists everything that waits on a person. Its badge shows the count. Each rig card shows its own count, and each rig tab has a section with its items. The list is sorted by age, oldest first.

There are four kinds of item:

- **run**: a factory run that is parked, stuck, or at a gate or a prompt. The item shows the rig, run, station, age, question, PR links and the command that answers (`factory decide`, `factory mail` or `factory retry`). The server reads the same data as `factory waiting` (`waitingItems` in `src/sidebar.ts`). It does not run that command.
- **ship**: the next PR to merge in the ship queue of a rig.
- **owner bead**: an open bead with the label `owner`.
- **human bead**: an open bead with the label `human`.

A bead item also shows how many open beads it blocks. The count comes from the `blocks` dependencies that `bd list --json` already holds. It needs no extra `bd` call. The age of a bead is its `created_at`, because the rows do not say when the label was added.

## Caches

- **Memory**: the server keeps one snapshot for each rig: the `bd list` rows and the epic progress. The API serves only from this snapshot. A request never runs `bd`.
- **Disk**: after each refresh, the server writes the snapshot to `FACTORY_HOME/ui-cache/<rig>.json`. At start, it loads these files first. The page shows the data at once, with its as-of time, before the first sync ends. The home backup excludes this folder (`/home/ui-cache/` in `EXCLUDES`).
- **Skip**: before `bd list`, the server reads the Dolt `main` commit hash (`SELECT DOLT_HASHOF('main')`). If it is the hash of the snapshot, the server does not read the beads again.
- **One sync for each rig**: a **Sync** click while a rig syncs joins that sync.
- **HTTP**: each `/api` reply has an `ETag`. A request with a matching `If-None-Match` gets `304`.
- **As-of and stale**: each rig card shows the as-of time. The card shows `STALE` when the data is older than 20 minutes, or when the last sync failed for that long.

## Data

For each rig the server runs `bd list --all --json --limit 0` in the repo path. It keeps the result in memory.

| Path                  | Content                                                       |
| --------------------- | ------------------------------------------------------------- |
| `GET /api/needs`      | everything that waits on a person, oldest first               |
| `GET /api/rigs`       | one summary for each rig: totals, open epics, sync state      |
| `GET /api/rigs/<name>` | the summary, all epics with their beads, and all beads        |
| `POST /api/sync`      | start one sync and one read of all rigs, then reply           |

The epic counts follow the `epic-progress` script. A bead that is not an epic counts under each epic above it. A sub-epic shows indented. An open bead with no parent bead is a one-off.

## Page

- **overview**: one card for each rig. It shows the totals by status and a bar for each open epic.
- **one tab for each rig**: the epics with bars. Click an epic to show its beads. Below them is the table of beads with filters for status, type and priority, and a text search. Click a bead to see its detail.

## Limits

- The page shows the first 500 beads that match a filter.
- The page has no login. Run it on a machine that you trust.
