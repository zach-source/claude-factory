# Factory server: local mode, server mode and the way back

Source: `specs/004-factory-server/` (spec.md, plan.md, quickstart.md).

## The two modes

The factory has two modes. Each rig belongs to one factory home, so each rig is in one mode.

- **Local mode.** The manager runs on the laptop (`bin/up`). The CLI works on the local home. The herdr runner and the AX runner both work. A worker sends its reports through the outbox. An AX worker gets a memory snapshot at launch. Use local mode for a rig that needs laptop workers (FR-014).
- **Server mode.** One process, `factory server`, runs on the AX cluster. It ticks, starts and watches AX tasks, and holds the writer lease. It runs the judgment steps (patrol, pm, briefer, reviewer, dream) as `claude -p`. A server-mode factory runs only AX rigs. Its home is on a PVC.

Both modes use one codebase and the same CLI commands (FR-018). A worker prompt differs only in the server address. The prompts of the judgment steps come from one source in both modes (FR-019).

## The server

- `/healthz` shows that the server runs. One writer at a time holds the lease (`server-lease.json`). A second server cannot write (FR-007).
- Workers call the worker API with a signed per-task token. A token gives access to its own run only. The factory CLI makes the calls, so Claude, codex and pi workers use the same path (FR-017).
- The person calls the client API with a person certificate, on port 8444.
- The judgment steps use the subscription OAuth tokens of the workers. If a token reaches its usage limit, the server swaps to another token slot, as `ax-token best` does. Or it waits until the limit lifts (FR-015).
- The server backs up its home to git, as the laptop does (`src/homebackup.ts`). `FACTORY_SERVER_BACKUP_REMOTE` sets the remote.

## Choose the mode

- Set `FACTORY_SERVER` to the server address. The CLI and the console then act as clients of the server. The `mod` plugin stops its timers.
- Unset `FACTORY_SERVER`. The CLI works on the local home again.

## Owner steps

The factory does not do these steps. The owner does them.

1. **S2, cluster resources.** Make the namespace, the PVC and the Secrets. The Secrets are: GitHub token, Linear token, worker token key and person CA. Add the gateway route for port 8444.
2. **S2, switch.** Stop the laptop manager for the AX rigs.
3. **Fleet Dolt upgrade to 2.5.0 (dm-g14).** Do this before S5.
4. **S4, switch.** Change `FACTORY_SERVER` in the manager session.
5. **S8, AX gateway and SVID work.** Do this work in the AX repos. Then the gateway connects with task SVIDs and the server accepts the SPIFFE ID in place of the token.

## The way back

Each cutover step leaves a working factory. The owner can go back to local mode after each step (FR-016). Local mode stays supported after the last step.

| Step | What it does                                                     | Way back                                                             |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| S1   | AX runs do not need the laptop. AX tasks get a memory snapshot.  | Git revert.                                                          |
| S2   | Server on the cluster. AX rigs move to a server home on the PVC. | Copy the home back from the PVC backup. Run `bin/up`.                |
| S3   | Worker API.                                                      | Unset the server rule in the egress policy. Workers use the outbox.  |
| S4   | Judgment steps in the server.                                    | Unset `FACTORY_SERVER` in the manager session. The `mod` timers run. |
| S5   | Beads primary on the fleet Dolt server. Needs Dolt 2.5.0.        | Point the rigs back at the laptop shared server.                     |
| S6   | State in Dolt (`factory migrate dolt`).                          | The file home on the PVC stays as it was before the migration.       |
| S7   | CI runs the CLI and `mod` tests in both modes.                   | None needed.                                                         |
| S8   | Task SVIDs in place of tokens.                                   | Tokens stay accepted until the owner removes them.                   |

After each step, check local mode (quickstart 7). Unset `FACTORY_SERVER`. Start the laptop manager with `bin/up`. Each rig must finish one run. In an AX task, `factory memory search "hello"` must print notes from the launch snapshot.
