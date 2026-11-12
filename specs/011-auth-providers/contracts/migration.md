# Contract: migration and rollback

Covers FR-011, FR-028 and FR-029, and user story 8. Do each phase first on a copy of the home. Each phase has its undo step. At all times, exactly one process refreshes each account.

## Phases

| Phase | Do | Check | Undo |
| --- | --- | --- | --- |
| M1 Shadow | Ship `src/auth/`. The core reads the old files and writes `auth-state.json`. The old code still acts. | `factory auth` shows the same limits and reset times as the old files. | Delete `auth-state.json`. |
| M2 Act | The core acts on limits, picks and swaps. It also writes the old files, for the rollback. | Swaps happen through `auth.pick`. The old files stay the same as the auth state. | Set `auth.enabled=false`. The old code reads its files again. |
| M3 Split items | Copy the Claude slots into one `Claude-Token-<email>` item each. Copy the Grok refresh fields into `Grok-Session-<email>`. Keep the old fields for now. | The core can read each account item. Agent-vault still reads the same live fields. | Nothing to undo: the old fields are still there. |
| M4 One refresher for each vendor | For each vendor: 1. suspend its CronJob (`suspend: true` in the GitOps repo); 2. set `auth.<p>.refresh=on`; 3. run `ccswitch export --to factory` for its accounts. | The refresh counter shows `ok` or `rotated` for each account. No CronJob run happens after the suspend. | 1. set `auth.<p>.refresh=off`; 2. `ccswitch export --release`; 3. resume the CronJob. |
| M5 Clean up | After 7 days with no dead chain: delete the CronJobs from the GitOps repo. Remove `refresh_token` from the Grok live item and the slot fields from the Claude live item. Move the old state files to `<home>/attic/auth-<date>/` (read only). Stop the double write of M2. | A secret scan of the home, the backup and the VMs finds nothing (SC-008). | Restore the files from the attic. Restore the CronJobs from git history. Restore the fields from the account items (step 5 of the rollback). |

## Order rules

- In M4, the CronJob stops before the pod starts to refresh. In the rollback, the pod stops before the CronJob starts. There is no time with two refreshers.
- M4 runs for one vendor at a time:
  - Grok first. It has the shortest token life (6 hours), so a fault shows quickly.
  - Then Codex.
  - Then Claude OAuth accounts, if any.
- The factory keeps running in each phase. A swap during the move uses the live item, as today.

## Rollback (full)

1. Set `auth.refresh=off` for all providers. Check that the refresh counter does not change for 2 minutes.
2. Run `ccswitch export --release` for each item. This makes ccswitch the laptop refresher again for Codex.
3. Resume the `codex-refresh` and `grok-refresh` CronJobs.
4. Set `auth.enabled=false`. The old code uses the old files again (M2 kept them current).
5. If M5 is done, restore the old files from the attic.
   Write the Grok `refresh_token` back into its live item from `Grok-Session-<email>`.
   The reason is that the CronJob reads it there.
6. Check these items:
   - a Claude swap with `bin/claude-token best`
   - a Codex copy with `bin/codex-token refresh`
   - a Grok CronJob run

The rollback must take less than 30 minutes (SC-010).
