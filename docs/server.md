# Factory server: local mode, server mode and the way back

Source: `specs/004-factory-server/` (spec.md, plan.md, quickstart.md).

## The two modes

The design has two modes. Each rig belongs to one factory home, so each rig is in one mode.

- **Local mode.** The manager runs on the laptop (`bin/factory up`). The CLI works on the local home. The herdr runner and the AX runner both work. A worker sends its reports through the outbox. An AX worker gets a memory snapshot at launch. Use local mode for a rig that needs laptop workers (FR-014).
- **Server mode.** One process, `factory server`, ticks, starts and watches AX tasks, and holds the writer lease. The cluster design uses only AX rigs and a home on a PVC. Only patrol has a server timer today. Set `--patrol-every-ms` above 0 to enable it; the default is 0 (off). The server does not schedule pm, briefer, reviewer or dream.

Both modes use one codebase (FR-018). Shared files hold the prompts of the judgment steps (FR-019). The worker API design keeps worker prompts the same except for the server address. The worker CLI transport is planned.

## The server

- `/healthz` shows that the server runs. The file lease (`server-lease.json`) limits writers, but has races. Two servers can claim an expired lease and both write before the next lease check. A tick can also write after a blocked event loop outlasts the lease. Do not use the file lease as proof of one writer (FR-007).
- The worker API serves report, mail and progress (FR-017). Enable its TLS listener with `--worker-port 8443 --worker-key <path>` and the client flags below. The worker key file must hold at least 32 bytes. A signed per-task token gives access to its own run only. Memory, usage and prompt routes are planned. Workers still use the local CLI path and the outbox, even with `FACTORY_SERVER` set; task launch issues no worker tokens.
- The person calls the client API with a person certificate. Enable it with `--client-port 8444 --tls-cert <path> --tls-key <path> --person-ca <path>`. Without these options, the server has no client listener.
- Patrol uses the subscription OAuth tokens of the workers. After a usage limit, its step runner tries another token slot. The design requires token swaps or a wait until the limit lifts (FR-015).
- The server backs up its home to git, as the laptop does (`src/homebackup.ts`). `FACTORY_SERVER_BACKUP_REMOTE` sets the remote.

## Choose the mode

- Set `FACTORY_SERVER` to the server address for client CLI commands. Workers keep the local path. Some CLI commands have no server form; the CLI refuses them. Automatic `mod` timer control through `FACTORY_SERVER` is planned. The plugin does not stop or restart its timers from this variable today.
- Unset `FACTORY_SERVER`. The CLI works on the local home again.

## Owner steps

The factory does not do these steps. The owner does them. These are cutover requirements, not proof of complete features.

1. **S2, cluster resources.** Make the namespace, the PVC and the Secrets. The Secrets are: GitHub token, Linear token, worker token key and person CA. Add the gateway route for port 8444.
2. **S2, switch.** Stop the laptop manager for the AX rigs.
3. **Fleet Dolt upgrade to 2.5.0 (dm-g14).** Do this before S5.
4. **S4, switch.** Change `FACTORY_SERVER` in the manager session.
5. **S8, AX gateway and SVID work.** Do this work in the AX repos. Then the gateway connects with task SVIDs and the server accepts the SPIFFE ID in place of the token.

## The way back

The design requires a way back after each cutover step (FR-016). Local mode must stay supported after the last step. The table gives the intended recovery paths. Planned rows are not current procedures.

| Step | What it does                                                     | Way back                                                             |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| S1   | AX runs do not need the laptop. AX tasks get a memory snapshot.  | Git revert.                                                          |
| S2   | Server on the cluster. AX rigs move to a server home on the PVC. | Stop the server. Copy the home back from the PVC backup. Run `bin/factory up`. |
| S3   | Partial: worker report, mail and progress routes. Worker CLI transport and other endpoints are planned. | Owner removes the server rule from the egress policy. Workers use the outbox. |
| S4   | Partial: patrol timer. Other judgment timers and automatic `mod` timer control are planned. | Stop the server patrol timer. Unset `FACTORY_SERVER`. Start the local manager. |
| S5   | Planned: beads primary on the fleet Dolt server. Needs Dolt 2.5.0. | Point the rigs back at the laptop shared server. |
| S6   | Planned: state in Dolt. `factory migrate dolt` has no CLI case today; do not run it. | Preserve the file home on the PVC before migration. Restore that home for local mode. |
| S7   | Planned: CI runs the CLI and `mod` tests in both modes. | None needed. |
| S8   | Planned: task SVIDs in place of tokens. | Keep tokens accepted until the owner removes them. |

After each step, check local mode (quickstart 7). Unset `FACTORY_SERVER`. Start the laptop manager with `bin/factory up`. Each rig must finish one run. In an AX task, `factory memory search "hello"` must print notes from the launch snapshot.
