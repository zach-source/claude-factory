# Implementation Plan: Pluggable auth providers for worker harnesses

**Branch**: `spec/011-auth-providers` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/011-auth-providers/spec.md`

## Summary

The auth code is now in ten files (research R1). The new auth core in `src/auth/` holds all of it.

- **Providers:** Each vendor has one provider file. The vendors are Claude, Codex, Grok, Cursor, xAI, OpenAI, Typesafe and Linear (contracts/provider.md).

- **Refresh:** The server pod refreshes every account under its lease (contracts/refresh.md). It uses a vault writer token. The core stores a rotated refresh token before the access token. It never sends one refresh token two times (research R4).

- **Pick:** Usage meters stop a launch on a full account. The pick chooses the account with the most room. The text match is the backstop. Fixtures come from real text (research R5, R6, R11).

- **State:** One `auth-state.json` replaces seven state files (data-model.md).

- **Operations:** The auth features are catalog operations. Every front end gets them (contracts/auth-ops.md).

- **Seeder:** ccswitch stays the laptop seeder. Its changes add three things: the Grok session, the key vendors and an export. The export gives the refresh to the factory (contracts/seeder.md).

- **Agent-vault:** The core makes the agent-vault key list from the providers. A step applies the list. That step waits for a managed agent-vault (research R9).

- **Move:** A phased migration retires the `codex-refresh` and `grok-refresh` CronJobs. Each phase has a rollback (contracts/migration.md).

## Technical Context

**Language/Version**: TypeScript on Bun, as today. Go for the ccswitch change in its own repo.
**Primary Dependencies**:
- the catalog (`src/core/catalog.ts`), the settings (`src/settings.ts`), `src/ax.ts` (egress and placeholders) and `src/metrics.ts`
- the server pod and its lease (spec 010)
- the vault Connect API in server mode, and the vault CLI in local mode
- agent-vault (no change to its code)
- ccswitch v2.13.1 and later

**Storage**: `auth-state.json` in the factory home. It holds no secret value. The password vault holds the secrets: one account item for each account and one live item for each vendor.
**Testing**: `bun test` with a temporary home, a fake vault and a fake `fetch`. Fixture tests in `src/auth/fixtures/`. `go test` in ccswitch. The quickstart scenarios on a copy of the home.
**Target Platform**: the server pod (amd64) and the laptop (local mode). The AX VMs keep only placeholders.
**Project Type**: One codebase with a CLI and a server. It also has a change in the ccswitch repo and a change in the GitOps repo. The GitOps change covers the CronJobs and the secret-sync item.
**Performance Goals**:
- a dead chain gives mail within 10 minutes (SC-004)
- a pick before each launch takes less than 1 s with cached meters
- the meters read each account at most every 5 minutes

**Constraints**:
- one refresh writer for each account (FR-006)
- no secret value outside the vault and the gateway (FR-009, FR-021)
- local mode unchanged (FR-030)
- catalog names `^[a-z]+\.[a-z]+$`
- AX allows at most 32 env entries for each task. The placeholders come from the provider list. They add no new env per account

**Scale/Scope**: 8 providers, about 10 to 20 accounts, up to 40 live runs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
| --- | --- | --- |
| I. Worker Parity | Every worker of a harness gets the same placeholders and the same live item, on the laptop and on AX. The classify step runs for every harness (Claude, Codex, Cursor and Grok), not only for Claude. Pi keeps its current credential path in this spec. A pi provider is a later plugin, and the PR files a bead for it. | Pass |
| II. Front-end Parity | The auth features are catalog operations in the core (contracts/auth-ops.md). The CLI, the web UI, the Claude mod and the Herdr mod call them. The status band shows one line and a link. A front end that does not get its view in the same change gets a bead, and the PR names it. | Pass |
| II. Local and server mode | The core works on a laptop home (FR-030, research R15) and in the pod (research R10). | Pass |
| Governance | The spec names its changes to specs 004, 005, 008 and 010. | Pass |

Re-check after Phase 1: pass.

- The contracts add operations to the existing catalog only.
- The core loop runs the refresh, not a front end.
- The Herdr and Claude mods only show `auth.accounts` and `auth.meters`.

## Project Structure

### Documentation (this feature)

```text
specs/011-auth-providers/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── provider.md      # the provider interface and the first providers
│   ├── refresh.md       # the refresh loop and the single-writer rule
│   ├── auth-ops.md      # the catalog operations and the pick rules
│   ├── storage.md       # account items, live items, the agent-vault key list
│   ├── seeder.md        # the ccswitch commands and the export hand-off
│   └── migration.md     # phases and rollback
└── checklists/requirements.md
```

### Source Code (repository root)

```text
claude-factory/
├── src/auth/
│   ├── core.ts              # accounts, state changes, the auth state file
│   ├── refresh.ts           # the loop and the single-writer steps
│   ├── pick.ts              # the pick rules
│   ├── classify.ts          # runs the provider patterns; trustedHit stays in cli.ts
│   ├── vault.ts             # Connect API (server) and vault CLI (local); reads both item shapes
│   ├── keys.ts              # the agent-vault key list
│   ├── providers/           # claude.ts codex.ts grok.ts cursor.ts xai.ts openai.ts typesafe.ts linear.ts index.ts
│   └── fixtures/<provider>/ # captured error text
├── src/core/ops/auth.ts     # the catalog operations
├── src/core/catalog.ts      # the auth.* entries
├── src/settings.ts          # auth.* keys from the provider list; old keys as aliases
├── src/cli.ts               # the tick calls the core for limits, swaps and picks; old files only while M2 runs
├── src/worker.ts            # limitNow uses the provider patterns
├── src/ax.ts                # egress rules and placeholders from auth.keys
├── src/steps.ts, src/broker.ts  # swaps through auth.pick
├── src/metrics.ts           # account on usage rows; the "Plan use" section
├── src/server.ts            # the refresh job under the server lease
├── mod/, herdr/mods/factory/, the web UI   # the auth view (presentation only)
├── bin/claude-token, bin/codex-token, bin/grok-token  # kept for the rollback; later thin calls of factory auth
└── docs/remote-runner.md    # the auth runbook, migration and rollback

ccswitch/ (own repo)
└── internal/cli/            # grok login, key add, export --to factory, the refresh_holder check

the GitOps repo/
└── <gitops-overlays>/       # the factory-vault-writer secret-sync item; the CronJob suspend, then delete
```

**Structure Decision**: The auth core is one new directory in the one claude-factory codebase.

- ccswitch gets a small change in its own repo (decision 2). It is not a port.
- The GitOps changes are the writer token item and the CronJob retirement.
- The owner merges them.

## Phases and order

Each phase leaves a working factory.

| Phase | Work | Needs | Notes |
| --- | --- | --- | --- |
| A | `src/auth/` core, the auth state, the provider interface, the Claude, Codex, Grok and Cursor providers that wrap today's code (shadow mode, M1) | none | No behavior change. |
| B | Classify through the providers. Capture real error text and add fixtures. Replace the guessed Cursor and Grok patterns. | A | Can start at once with the capture step. |
| C | Meters and the pick. The tick, the broker and the steps call `auth.pick` (M2). | A | Usage endpoint open check (research R5). |
| D | The catalog operations and the four front-end views | A | Spec 008 parity rules. |
| E | Settings `auth.*`, aliases for the old keys | A | |
| F | The vault layer and the refresh loop in the pod, with the single-writer steps | A, spec 010 pod | The writer token item in the GitOps repo. |
| G | ccswitch: `grok login`, `key add`, `export --to factory`, the `refresh_holder` check | F (contract) | A ccswitch release. |
| H | Item split (M3) and the CronJob retirement for each vendor (M4) | F, G | Owner go-ahead for each vendor. |
| I | The key providers xAI, OpenAI, Typesafe and Linear. `ax.ts` egress from `auth.keys`. | A | |
| J | The "Plan use" section of the token report and the metrics | C | |
| K | Clean up (M5) after 7 days | H | Owner go-ahead. |
| L (later) | Write the agent-vault configuration from `auth.keys` | I, and a managed agent-vault | Agent-vault is a bare pod today. |

## Open questions for the owner

Each question has a default. Planning continues with the default.

1. **Q1. New item names** (research R3). The default is `Grok-Session-<email>` and `Key-<vendor>-<label>`. The names have the ccswitch prefix.

2. **Q2. Claude in the VMs** (research R5). The default: the VM slots use long-lived `setup-token` tokens. These tokens have no refresh. The core warns 30 days before expiry. OAuth refresh is for local mode. It is also for any OAuth account that ccswitch exports.

3. **Q3. Time before the CronJob deletion** (research R14). The default is 7 days with no dead chain.

4. **Q4. Launch limit and swap rules** (contracts/auth-ops.md). The default uses the ccswitch values. Launch limit: 0.95. Hysteresis: 0.10. Cooldown: 5 minutes. The Cursor cap of 60% stays as its `launch-limit` (0.60).

5. **Q5. A managed agent-vault** (research R9). Phase L needs agent-vault as a GitOps object. Is that a separate spec or part of this one? The default is a separate bead. The command `factory auth keys --format agent-vault` covers the gap.

## Complexity Tracking

| Item | Why it is needed | Simpler choice rejected because |
| --- | --- | --- |
| A `refresh_holder` field in each vault item, and the lease in the auth state | A laptop home, ccswitch and the pod can reach the same item. A lease in one home cannot stop the other two (research R4). | A lease only in the home: ccswitch on the laptop would still refresh the same item. |
| Read of two item shapes (Document and field) | ccswitch writes Documents with the vault CLI and secure notes with Connect (research R3). | Change all items to one shape: a migration of every ccswitch item for no gain in behavior. |
| A double write of the old files during M2 | The rollback must work with no loss of limit state (FR-029). | No double write: a rollback after M2 would lose the limits and swaps of that time. |
