# Quickstart: check the server pod

These scenarios prove each user story. Run them first on a copy of the home in a test namespace, then on the live factory after the migration.

## Prerequisites

- WARP on, and the person certificate in `~/.config/factory/` and in the browser.
- `FACTORY_SERVER=https://factory.<private-zone>:8444` for the CLI.
- The pod and the manager task must be active (contracts/cluster.md, contracts/manager-task.md).

## 1. One ticker (user story 1)

1. Run `factory status`. The top line shows `running` and the lease holder (the pod).
2. Run `factory stop`. Within one tick, run `factory resume`. The top line shows `running` again, and new workers start.
3. In the manager task, run `factory tick`. It reads the board and does not tick. The lease holder stays the pod.
4. Delete the manager task (`ax delete task f-manager-session`). Ticks continue, and the pod starts a new task within 2 min.

## 2. Manager image change without a pause (user story 2)

1. Set a new manager image as the person.
2. Watch `starts.jsonl` on the pod volume through `GET /v1/metrics`. New starts continue during the change.
3. The new session reads `GET /v1/manager/brief` and shows the same open decisions.

## 3. All front ends through /v1 (user story 3)

1. Time `factory status`. It must be under 2 s.
2. Open each herdr view. Each opens in under 1 s.
3. Send mail to a run from the web page. The Claude mod and the herdr mod show it within 5 s.

## 4. Browser access (user story 4)

1. Open `https://factory.<private-zone>:8444/` and pick the person certificate. The Overview shows within 3 s.
2. From a device without the certificate: the TLS handshake fails, and the page shows no data.

## 5. Migration (user story 5)

Follow `docs/remote-runner.md`, "Move the home to the server pod". The check after the move compares these values. They must be equal:

- the run count by state
- the open decisions
- the last report of each active run

## 6. Local mode (user story 6)

Run `bun test` for the local-mode suite of spec 008. Run `factory ui` on a laptop home. Nothing changes.
