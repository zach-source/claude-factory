# Contract: the session-only manager task

Covers FR-006, FR-007 and FR-009.

## Host mode `factory manager session`

The task command is `factory manager session`. It does these steps:

1. `ttyGroup`, `asWorker` and `trustCA`, as `managerhost.host` does.
2. `prepareSsh`, and sshd for `factory attach`.
3. It starts herdr headless and the Claude manager in pane `w1:p1` (`managerCommand`, `superviseManager`).
4. A 30 s loop: it restarts the manager if it exits, and it posts its health to `POST /v1/manager/log/health`.

It must not run `awaitHome`, `restoreStep`, `warmMemory`, `reposSync` or `backupStep`. It has no `FACTORY_HOME` with state. The mod keeps its scratch files in a temp dir that holds no state.

## Environment of the task

- `FACTORY_SERVER=https://factory-server.factory.svc:8444`, plus the manager certificate files.
- The Claude token slots and the egress keys of `managerEgress`, but no `GITHUB_BASIC_MANAGER` for the home backup.
- The total stays at 32 entries or fewer, because that is the AX limit.

## Life cycle from the pod

| Event | Pod action |
| --- | --- |
| Pod start, no task | `ax apply -f -` with the task manifest (`ax.launchManager`). |
| Task `down` for 3 checks | `ax delete task` and `ax apply`, with a back-off of 1, 2, 4, then 10 min. |
| Person sets a new manager image | `ax delete task` and `ax delete workspace`, then `ax apply` with the new image. Ticks continue during this (FR-009). |
| Person suspends the manager | `ax suspend task`. The pod keeps ticking, and the board shows the manager as suspended. |
| Claude usage limit | The task reports `limited`. The pod keeps ticking. `superviseManager` swaps the token slot as today. |

## First brief of a new session

At the start, the manager session reads `GET /v1/manager/brief`. The brief holds the open decisions, unread mail, the plan and the last 20 patrol log rows. That brief replaces the old transcript resume.
