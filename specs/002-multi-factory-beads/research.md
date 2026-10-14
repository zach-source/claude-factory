# Research: Several factories on the same rigs

What bd does that the design depends on, and the decisions it leads to. Facts come from bd 1.3.0 (`bd <cmd> --help`, and `bd sql` on this repo's store) and from the current code.

## bd facts

| #   | Fact                                                                                                                                                                                                                                         | Source                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| B1  | `bd update <id> --claim` sets the assignee to the actor and the status to `in_progress`, atomically within one store. It is idempotent for the same actor and refused for another actor's live claim.                                        | `bd update --help`                                                                 |
| B2  | A claim carries a lease with a TTL. `bd heartbeat` extends it. `bd reclaim` returns an expired lease's issue to `open` after a grace window (default 10 min, "roughly 2x the claim TTL"). The factory treats the TTL as 5 min.               | `bd heartbeat --help`, `bd reclaim --help`, `HEARTBEAT_MS` comment in `src/cli.ts` |
| B3  | Leases are node-local. The `leases` table is in `dolt_ignore`, so a push or pull never carries it. A heartbeat writes no Dolt commit. "Cross-machine claim visibility rides the issue's status and assignee, which do commit."               | `bd heartbeat --help`; `select * from dolt_ignore`                                 |
| B4  | Clients of one Dolt sql-server are one replica: one leases table, one atomic `--claim`.                                                                                                                                                      | `bd reclaim --help` (Replicas and leases)                                          |
| B5  | `bd reclaim` skips leases that another replica granted when `BEADS_NODE_ID` (or `bd config set node_id`, per machine) is set. bd states two invariants for replicas: lease TTL > sync interval, and grace window > sync interval.            | `bd reclaim --help`                                                                |
| B6  | `bd sync` = pull, positive conflict check, `is_blocked` repair, push with bounded retries. The pull auto-settles "last-write-wins on issue cells". Exit codes: 0 ok, 1 error, 2 conflict (halted), 3 retries exhausted, 4 stuck working set. | `bd sync --help`                                                                   |
| B7  | A push from a store that lacks the remote's latest commits is refused until it pulls.                                                                                                                                                        | `docs/remote-runner.md` (measured on AX)                                           |
| B8  | `bd update --if-assignee <a>` and `bd unclaim --if-assignee <a>` are compare-and-swap writes (exit 13 on a stale guard). `--if-assignee` cannot be combined with `--claim`.                                                                  | `bd update --help`, `bd unclaim --help`                                            |
| B9  | `bd kv set/get/list` stores user-defined key-value data in the store.                                                                                                                                                                        | `bd kv --help`                                                                     |
| B10 | `bd dolt pull --strategy ours\|theirs` works on embedded storage only. On server-mode storage, conflicts are resolved with `bd conflicts resolve`.                                                                                           | `bd dolt pull --help`                                                              |

Not yet verified (Phase 0 of the plan tests each one): that the rejected push in B7 has an exit code or message that tells it apart from an unreachable remote; that a claim followed by `unclaim` merges with no conflict (see D2); that `bd kv` data replicates (it must not be in `local_metadata`, which is in `dolt_ignore`); that bd accepts `:` in an actor and an assignee.

## Decisions

### D1. Identity: a generated id in the factory home

**Decision**: `factory init` writes `<home>/factory.json` with `id` (6 lowercase base32 characters, about 1 billion values), `name` (default `<user>-<short host>`, changeable) and `created`. A home without the file gets one the first time the runner needs the identity. The id goes in every actor (`factory:<id>/...`) and branch (`factory/<id>/<run>`). The name appears only in the presence record and on the board.

**Why**: The id must stay the same when the person renames the factory or moves the machine, and it must not depend on things that two factories can share (a user name, a host name, a repo path). A copied home is the one way that two factories get the same id. The presence record finds that case (D4).

**Alternatives rejected**: `user@host` as the id. Two homes on one host (the README supports this) would collide, and a rename would orphan every claim. A UUID: it is unique, but it makes every actor and branch name long for no gain at this scale.

### D2. Claim protocol: push-confirmed claims

**Decision**: On a store with a Dolt remote, a claim counts only after the push that carries it succeeds. The order is: pull, claim locally, push. If the push is refused because the remote moved, release the new claims, pull, and claim again (at most 3 attempts). The worker launches only after the push succeeds. With no remote (one store, or clients of one Dolt server), `--claim` alone is enough (B1, B4).

**Why**: A Dolt push is a fast-forward of the remote's branch, so the remote orders the claims: the first push wins (B7). The release before the pull matters. After a claim and its release, the bead's `assignee` and `status` cells hold their merge-base values again. A three-way merge then takes the remote's values with no conflict, so another factory's claim that is already on the remote stands. If the factory pulled with its own claim in place, bd's pull would settle the `assignee` cell last-write-wins (B6). The later claim, ours, could then replace a claim that another factory has already acted on. `bd sync` is not used for the claim push for the same reason: its push retry pulls and merges with that rule.

**Cost**: one pull and one push per dispatch pass that claims anything, at most every 30 seconds per rig, and only when the rig has room and ready candidates. A pass with nothing to claim costs no remote call.

**Alternatives rejected**:

- _Claim locally and let the 5-minute sync spread it (today)._ Two factories can both run a bead for up to 10 minutes. Last-write-wins then makes one of them lose a claim that it already acted on.
- _Require one shared Dolt server._ Claims are atomic and leases are global, but every bd call goes over the network. A laptop away from the server can do nothing, and the server is a single point of failure. The factory supports this topology (it is one replica), but does not require it.
- _A lock outside beads (a git ref per bead on the origin)._ A ref push is atomic, but it adds a second state that can disagree with beads, and it needs its own release and stale rules.

### D3. Liveness across replicas: a presence record, not the lease

**Decision**: Each factory writes a presence record per rig into the rig's beads store, at most every 10 minutes and on each state change. It is the key `factory.presence.<id>` in `bd kv`, holding `{name, user, host, state, version, at}`. A factory whose record is 30 minutes old is _quiet_ on the board. After 2 hours, `factory beads takeover` may release its claims. A factory never runs `bd reclaim` on another factory's actors and never uses `--any-replica`.

**Why**: Leases do not cross replicas (B3), so another machine cannot tell a dead claim from a live one by the lease. The presence record replicates with the issues. Ten minutes keeps the commit count low (144 a day per factory per rig, which `bd compact` can squash). Thirty minutes is three missed writes. Two hours covers a laptop that sleeps or loses the network for a while. Takeover stays manual because the quiet factory may have commits that it has not pushed. A person can find out. A timer cannot.

**Fallback**: If Phase 0 shows that `bd kv` does not replicate, the record goes into the metadata of one bead per factory, labeled `factory-presence`, which the factory holds and never closes.

### D4. Copied homes

**Decision**: When a factory reads its own presence record and finds another host with a time in the last 30 minutes, it refuses to dispatch, and the board says: "factory id `<id>` is live on `<host>`: run `factory init --new-id` here".

### D5. Rig-wide duties: one steward per rig

**Decision**: The key `factory.steward` in the rig's `bd kv` names the factory id that runs the rig's sweeps and acts on labels of pull requests that are not on a factory branch. A factory that finds the key unset (after a pull) sets it to its own id. Every factory obeys the value it reads. `factory rig steward <rig>` moves the role. `factory rig rm` gives it up.

**Why**: Sweeps and labels on person-owned PRs are per-repo work. N factories doing them gives N monitor sweeps and N rework runs. An explicit key needs no election protocol. If two factories set it at the same time, they agree after the next sync, and the loser has started at most one extra sweep run, which is harmless because sweeps skip duplicates.

### D6. Sync cadence

| What                         | Today             | Decision                                                                      | Why                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat                    | 2 min             | 2 min (no change)                                                             | Node-local, writes no commit (B3). It protects the claim from a local `bd reclaim`.                                                                                                                                                                                                                     |
| Lease TTL                    | 5 min (bd)        | 5 min (no change)                                                             | bd's value.                                                                                                                                                                                                                                                                                             |
| Claim pull and push          | none              | Around each dispatch pass that claims, at most every 30 s per rig             | Correctness comes from D2, not from the interval.                                                                                                                                                                                                                                                       |
| Background `bd sync` per rig | 5 min             | 2 min                                                                         | Freshness: a bead that another factory claimed or closed drops out of dispatch quickly, so few claims are wasted. A beads pass can be several minutes late under load. 2 + 2 is still under the 5-minute TTL, which satisfies bd's invariant (B5) if a person runs a federated reaper. 3 min would not. |
| Presence write               | none              | 10 min, and on stop, resume and rig changes                                   | D3.                                                                                                                                                                                                                                                                                                     |
| Quiet, takeover              | none              | 30 min, 2 h                                                                   | D3.                                                                                                                                                                                                                                                                                                     |
| Back-off after a failed sync | retry after 5 min | 2, 4, 8, 16, then 30 min; reset on success; mail the manager after 3 failures | A down remote must not cost a bd process every 2 min. Three failures is about 14 min, long enough to skip a short blip.                                                                                                                                                                                 |
| Dispatch                     | 30 s              | 30 s (no change)                                                              |                                                                                                                                                                                                                                                                                                         |

While a rig's last claim push failed because the remote could not be reached, the rig claims nothing new (it cannot confirm a claim). Its live runs go on, and their heartbeats are local.

### D7. Topology recommendation

**Decision**: The recommended topology is one beads store per machine and one Dolt remote per rig. Factories that share a Dolt server (two homes on one machine, or a team server that every machine can always reach) are one replica. That is also supported, and the claim's push step is skipped when the store has no remote.

**Why**: The per-machine topology works for all three cases (one person on two machines, two people, laptop plus AX workers). It keeps bd calls local, which matters on a loaded machine. It also works offline: runs go on, and only new claims wait. AX workers already use it: they bootstrap a store from the remote and push to it (`src/worker.ts` `setupBeads`, `syncBeads`).

### D8. Lost claims park the run

**Decision**: When a heartbeat finds another actor on a live run's bead (`beads.heartbeat` returns false), the run stops all bead writes and parks stuck. The Interview tab asks the person to retry or abort, as for a repeated silent failure. An abort then leaves the bead alone.

**Why**: Today the run gets an error row and goes on, so two runs push to two pull requests for one bead. The factory cannot know if the other holder is a person or a factory, or which of the two runs is further along. A person can.
