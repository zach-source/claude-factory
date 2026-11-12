# Feature Specification: Pluggable auth providers for worker harnesses

**Feature Branch**: `spec/011-auth-providers`
**Created**: 2026-11-12
**Status**: Draft
**Input**: Owner request 2026-11-12: Make the authentication of the worker harnesses pluggable. Cover these: Claude subscriptions, Codex (ChatGPT) subscriptions, SuperGrok sessions, and API-key vendors (Cursor key, xAI, OpenAI, Typesafe, Linear). A new vendor must be one provider plugin. Review and reuse our own ccswitch library (Go, v2.13.1).

## Context

The factory starts workers with several harnesses (Claude, Codex, Cursor, Grok and pi). Each harness needs a credential. Today each vendor has its own code path:

- **Claude subscriptions.** One vault item holds all the Claude token slots and the live field. The command `bin/claude-token best` copies the slot with the most room into the live field. Each of these can start the swap: the swap command, the broker and `factory token`.
- **Codex (ChatGPT) subscriptions.** ccswitch on the laptop refreshes the Codex sessions. The command `bin/codex-token` copies a session into the live item. The `codex-refresh` CronJob also refreshes Codex tokens. The manager keeps a Codex auth file of its own.
- **SuperGrok sessions.** The `grok-refresh` CronJob refreshes the session. The refresh token is in the same item that agent-vault reads. The factory records the spend in a log file.
- **API keys.** The keys for Cursor, xAI, OpenAI, Typesafe and Linear are in the password vault. A person adds each key to agent-vault with a hand patch. The factory reads the Cursor use into a meter file of its own.

On 2026-11-12 this design has these problems:

- **Too many refreshers.** Two CronJobs and the laptop can refresh tokens. A refresh token can be single-use. When two refreshers use the same token, the vendor revokes the chain. Then a person must log in again.
- **The laptop is a dependency.** The Codex refresh and all logins need the laptop.
- **Late swaps.** The factory finds a limit only after a worker hits it. The worker loses its station time.
- **Guessed error text.** The Cursor and Grok limit patterns are guesses. No real error text is in a test.
- **Seven state files.** Each vendor keeps its limit and swap state in its own file and format (FR-019 lists them).
- **Settings in different forms.** Claude has `token.*`. Cursor and Grok have one or two settings each. Codex, xAI and OpenAI have only env values.
- **Hand patches for agent-vault.** Each new key needs a hand patch of the agent-vault configuration.
- **A new vendor touches many files.** A new vendor needs changes in these places: the harness, the swap, the meter, the limit text and agent-vault.

This spec adds one auth core in the factory. Each vendor is a provider plugin of that core.

### Changes to other specs

| Spec | Requirement | Change |
| --- | --- | --- |
| 004 | Decision "Credential for the manager's agent steps" | Kept. The manager steps use the same accounts. The auth core picks the account for them. |
| 005 | Token report | Changed. The token report shows the plan use of each account. |
| 008 | Operation catalog | Changed. The catalog gets the auth operations. Every front end uses them. |
| 010 | FR-018 (secrets out of the image and backup) | Kept. The auth state on the home volume holds no secret value. |
| 010 | The pod holds the lease | Changed. The pod also runs the refresh loop under its lease. |

## Decisions (owner, 2026-11-12)

1. **One refresher.** The server pod of spec 010 runs the refresh loop under its lease. The pod uses a vault writer token (a Connect token of the password vault). No refresh needs the laptop. The `codex-refresh` and `grok-refresh` CronJobs retire after the new loop works. The migration lists the steps.
2. **A mixed code home.**
   - **ccswitch** stays the laptop seeder. It does the logins and the device flows. It gets the missing vendors (the Grok session and the key vendors) and an export that seeds the factory.
   - **The factory core** (TypeScript, `src/auth/`) owns the provider interface. It owns the refresh, the usage meters, the classify step (limit or refused login), the pick and the catalog operations. Every front end calls these operations (constitution Principle II, spec 008 catalog).
   - Do not port all of ccswitch.
3. **Storage.**
   - One vault item for each account. The item names follow the ccswitch names.
   - One live item for each vendor. Agent-vault reads the live item.
   - A refresh token never leaves its account item.
   - The worker VM only gets placeholders.
4. **Swap.**
   - Keep the copy into the live field. Agent-vault reads the live field again about every 5 minutes.
   - Add usage meters. A meter stops a launch. The pick takes the best account before a limit.
   - Keep the text match (regex) as a backstop. It gets fixture tests from real error text.
   - A dead refresh chain sends mail to the manager.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Exactly one process refreshes each token (Priority: P1)

The server pod refreshes every vendor token. No CronJob and no laptop refreshes a token in server mode. A rotated refresh token is never used two times.

**Why this priority**: A second refresher with a single-use token revokes the chain. Then the account stops until a person logs in again. This stops all workers of that vendor.

**Independent Test**: Start the pod with two Claude accounts, one Codex account and one Grok session. Let the access tokens expire. Make sure that the pod refreshes each one. Make sure that the log shows one refresh for each expiry. Start a second refresher on the same home. Make sure that it refuses and names the pod.

**Acceptance Scenarios**:

1. **Given** an access token that expires in less than the refresh margin, **When** the refresh loop runs, **Then** the pod gets a new token. It writes the new refresh token to the account item. Only then does it write the new access token.
2. **Given** a refresh that fails after the vendor rotated the token, **When** the loop runs again, **Then** it reads the stored token and does not send the old refresh token again.
3. **Given** the pod holds the lease, **When** another process tries to refresh in server mode, **Then** that process refuses and names the pod.
4. **Given** the vendor refuses the stored refresh token, **When** the loop sees the refusal, **Then** it marks the account as dead, takes it out of the pick, and sends one mail to the manager.

---

### User Story 2 - The factory picks an account before a limit (Priority: P1)

Before the factory starts a worker, it reads the usage meter of each account of that vendor. It picks the account with the most room. It does not start a worker on an account that is at its limit.

**Why this priority**: Today a worker finds the limit first. It loses its station time, and the swap comes late.

**Independent Test**: Give one Claude account a meter at 97% of the weekly limit and one at 40%. Start a run. Make sure that the worker gets the second account. Set both to 99%. Make sure that the factory holds the run and shows the reset time.

**Acceptance Scenarios**:

1. **Given** two accounts with different use, **When** the factory starts a worker, **Then** the worker gets the account with the most room.
2. **Given** every account of a vendor is above its launch limit, **When** a run waits for that vendor, **Then** the factory does not start a worker, and it shows the earliest reset time on every front end.
3. **Given** the pick changes the account, **When** the live item gets the new value, **Then** new workers use the new account within one agent-vault read period (about 5 minutes). Running workers keep their placeholders.

---

### User Story 3 - The text match still catches a limit (Priority: P1)

A worker shows a limit error or a refused login that the meter did not predict. The classify step reads the text and tells a limit from a refused login. It applies the correct action.

**Why this priority**: The meters can be late or wrong. The backstop stops a loop of failed starts.

**Independent Test**: Run the classify step on each fixture of real error text. Make sure that each fixture gets the expected class.

**Acceptance Scenarios**:

1. **Given** a fixture of a real limit error for each vendor, **When** the classify step reads it, **Then** the class is `limit` and the step gives the reset time when the text has one.
2. **Given** a fixture of a real refused login, **When** the classify step reads it, **Then** the class is `refused` and the account goes to the refresh loop, not to a swap.
3. **Given** text that is neither, **When** the classify step reads it, **Then** the class is `none` and the factory does nothing.

---

### User Story 4 - A new vendor is one provider plugin (Priority: P2)

A developer adds a new vendor. The developer writes one provider plugin and adds its settings. The factory then refreshes, meters, classifies, picks and gives agent-vault keys for that vendor, with no change in other files.

**Why this priority**: The factory added three vendors in two weeks. Each one touched many files.

**Independent Test**: Add a test provider that has a fake key and a fake meter. Make sure that the catalog lists it. Make sure that the pick uses it. Make sure that the agent-vault key list contains it. Make sure that no file outside the plugin and its fixtures changed.

**Acceptance Scenarios**:

1. **Given** a new provider plugin, **When** the factory starts, **Then** the provider is in the provider list with its kind (subscription, session or key).
2. **Given** a provider of kind key, **When** the factory makes the agent-vault key list, **Then** the list has an entry for that vendor with its placeholder.
3. **Given** a provider without a meter, **When** the pick runs, **Then** the pick uses the accounts in their set order, and only the text match finds a limit.

---

### User Story 5 - The person seeds a new account from the laptop (Priority: P2)

The person logs in to a vendor on the laptop with ccswitch. ccswitch writes the account item in the vault and exports it to the factory. The factory adds the account to the pick within one refresh period.

**Why this priority**: Logins need a browser. The laptop stays the place for logins, but not for refreshes.

**Independent Test**: Log in to a test account with ccswitch. Run the export. Make sure that the factory lists the account. Make sure that the account item has the expected name.

**Acceptance Scenarios**:

1. **Given** a new login in ccswitch, **When** the person runs the export, **Then** the account item exists with the ccswitch name, and the factory lists the account.
2. **Given** an export of an account that exists, **When** the export runs, **Then** it changes only that account item, and the refresh loop keeps one writer.
3. **Given** a key vendor, **When** the person adds a key with ccswitch, **Then** the key goes into its account item, and the factory adds the vendor to the agent-vault key list.

---

### User Story 6 - The person sees the plan use of each account (Priority: P2)

The person opens the token report or the auth view on any front end. The person sees each account, its vendor, its state, its plan use and its next reset.

**Why this priority**: The person pays for each plan. The person must see whether each plan gets good use.

**Independent Test**: Open the auth view on each front end. Make sure that each one shows the same accounts and values.

**Acceptance Scenarios**:

1. **Given** accounts with meters, **When** the person opens the token report, **Then** the report shows the use of each account as a part of its plan limit, with the window and the reset time.
2. **Given** a dead account, **When** the person opens the auth view, **Then** the view shows the account as dead, the time, and the login command to fix it.

---

### User Story 7 - Local mode keeps working (Priority: P2)

A person runs a factory on a laptop home. The laptop refreshes and swaps the tokens, as today, through the same auth core.

**Why this priority**: Spec 004, 008 and 010 keep local mode.

**Independent Test**: Run the local-mode test set of spec 008 and the auth tests with a laptop home.

**Acceptance Scenarios**:

1. **Given** a laptop home with no server pod, **When** a token is near its expiry, **Then** the laptop factory refreshes it under its own manager lease.
2. **Given** a laptop home and a server-mode home that share an account, **When** both want to refresh it, **Then** only the one that holds the refresh lease of that account refreshes it.

---

### User Story 8 - The person moves to the new auth state and can go back (Priority: P1)

The person moves the live factory from the old files and CronJobs to the auth core. The move loses no account and no limit state. If the move fails, the person goes back to the old design.

**Why this priority**: All workers need credentials. A failed move stops the factory.

**Independent Test**: Run the migration on a copy of the home. Compare the accounts, the limit state and the live items before and after. Run the rollback. Make sure that the old CronJobs and files work again.

**Acceptance Scenarios**:

1. **Given** the old state files, **When** the migration runs, **Then** one auth state holds the same accounts, limits and reset times, and the old files stay as a read-only copy.
2. **Given** the new refresh loop works for 7 days, **When** the person retires the CronJobs, **Then** no other process refreshes a token.
3. **Given** the migration fails at any step, **When** the person starts the rollback, **Then** the CronJobs and the old files work again, and no refresh token is used two times.

### Edge Cases

- The pod restarts during a refresh. The vendor rotated the token, but the pod did not store it. The chain can be dead. The loop must see this, mark the account, and send mail. It must not try the old token in a loop.
- The vault is not available. The loop keeps the current access tokens. It retries with a back-off. It shows the vault state on every front end.
- The vault writer token expires or loses its rights. The loop stops its writes, and it sends mail to the manager.
- A vendor changes its usage API. The meter returns "unknown". The pick treats the account as having room, and the text match stays the backstop.
- A meter says "room", but the worker gets a limit. The classify step marks the account as limited until the reset time. The meter value is noted as wrong.
- Two accounts have the same name in two vendors. The account key includes the vendor.
- A person changes an account item by hand while the loop runs. The loop reads the item again before each write.
- The laptop and the pod try to refresh the same account. Only the holder of the account refresh lease refreshes it.
- Agent-vault reads the live item during a swap. The live item has the old or the new value. It never has half a value.
- All accounts of a vendor are dead. The factory holds every run that needs the vendor and tells the manager.

## Requirements _(mandatory)_

### Functional Requirements

**Provider model**

- **FR-001**: The factory core MUST have one provider interface for every vendor. A provider MUST state its kind: `subscription` (OAuth with refresh), `session` (a browser session with refresh) or `key` (a static API key).
- **FR-002**: A provider MUST supply only the vendor-specific parts: its refresh call (if any), its meter (if any), its limit and refusal text patterns, its account item fields and its agent-vault placeholder. The core MUST own the refresh loop, the pick, the classify step, the auth state and the operations.
- **FR-003**: The factory MUST have a provider for each of these vendors: Claude subscription, Codex (ChatGPT) subscription, SuperGrok session, and the keys of Cursor, xAI, OpenAI, Typesafe and Linear.
- **FR-004**: A new vendor MUST need only one new provider plugin, its settings and its fixtures. It MUST NOT need a change in the harness launch, the pick, the swap or the agent-vault key list code.

**Refresh**

- **FR-005**: In server mode, only the server pod MUST refresh tokens. It MUST refresh only while it holds the lease of spec 010. In local mode, only the laptop factory that holds its manager lease MUST refresh.
- **FR-006**: Each account MUST have one refresh writer at a time. A refresh lease for each account MUST stop a second writer, also between a laptop home and a server home.
- **FR-007**: When a vendor rotates a refresh token, the refresher MUST store the new refresh token in the account item before it stores or uses the new access token.
- **FR-008**: The refresher MUST NOT send a refresh token that it already sent and that the vendor accepted. After an unclear result (for example a timeout), it MUST read the account item again before it tries again.
- **FR-009**: A refresh token MUST stay in its account item. It MUST NOT go into the live item, the auth state file, a log, a metric, mail or the worker VM.
- **FR-010**: When the vendor refuses a refresh token, the refresher MUST mark the account as dead. It MUST take the account out of the pick. It MUST send one mail to the manager with the account name and the login command.
- **FR-011**: The `codex-refresh` and `grok-refresh` CronJobs MUST retire after the new loop has worked for the time that the migration sets.

**Meters and pick**

- **FR-012**: A provider with a usage source MUST give a meter for each account: the use, the limit, the window and the reset time.
- **FR-013**: Before a worker launch, the core MUST pick the account with the most room for that vendor. It MUST NOT start a worker on an account above its launch limit.
- **FR-014**: When all accounts of a vendor are above the launch limit or dead, the core MUST hold the runs that need that vendor and show the earliest reset time on every front end.
- **FR-015**: When the pick changes the account of a vendor, the core MUST copy the access value into the live item of that vendor in one write. Agent-vault reads that live item.

**Classify**

- **FR-016**: The classify step MUST read worker text and return one of `limit`, `refused` or `none`, with the vendor, the account and the reset time when the text has one.
- **FR-017**: Each limit and refusal pattern MUST have a fixture test from real captured error text. The fixtures MUST have no secret value and no private name.
- **FR-018**: A `limit` result MUST mark the account as limited until the reset time. A `refused` result MUST send the account to the refresh loop.

**State and settings**

- **FR-019**: One auth state MUST replace these files: `harness-limit-<runner>.json`, `token-swap-*.json`, `cursor-meter.json`, `grok-spend.jsonl`, `manager-limit.json`, `manager-codex-auth.json` and the local-mode `factory-limits.json`. The auth state MUST hold no secret value.
- **FR-020**: Every vendor MUST have settings in the same form: its accounts, its launch limit, its refresh margin and its meter period. The Claude `token.*` settings MUST keep working as names for the Claude provider.
- **FR-021**: The worker VM MUST get only placeholders. It MUST NOT get an access token, a refresh token or a key value.

**Operations and front ends**

- **FR-022**: The auth features MUST be catalog operations of the core. These operations list the providers and accounts. They show the meters, pick, swap, mark an account, refresh now, classify and show the agent-vault key list. Every front end MUST use these operations (constitution Principle II).
- **FR-023**: Only the person MUST be able to swap, mark or refresh an account. The manager identity of spec 010 MAY read the auth state. The manager identity MAY also ask for a pick.
- **FR-024**: The token report (spec 005) MUST show the plan use of each account: use as a part of the limit, the window and the reset time.

**Seeder**

- **FR-025**: ccswitch MUST stay the laptop tool for logins and device flows. It MUST add the Grok session and the key vendors. It MUST add an export. The export writes the account item with the ccswitch name. The export tells the factory about the account.
- **FR-025a**: After the export, the factory MUST own the refresh of that account. ccswitch MUST NOT refresh an account item that names another refresh holder.
- **FR-026**: The factory MUST NOT copy the login code of ccswitch. It MUST read the account items that ccswitch writes.

**Agent-vault**

- **FR-027**: The core MUST make the agent-vault key list from the provider list. A hand patch MUST NOT be necessary for a new vendor. The step that applies this list to agent-vault MAY come later. The reason is that agent-vault is a bare pod today.

**Migration**

- **FR-028**: A migration MUST move the six state files into the auth state. It MUST move the refresh from the CronJobs to the pod. It MUST keep the old files as a read-only copy. Each step MUST say how to undo it.
- **FR-029**: A rollback MUST bring back the CronJobs and the old files. The rollback MUST stop the pod refresh before the CronJobs start. This order keeps one writer at all times.
- **FR-030**: Local mode MUST keep working with no server pod and no vault writer token in the cluster.

### Key Entities

- **Provider**: the plugin for one vendor. It has a name, a kind, its settings, its item fields, its placeholder, and its optional refresh call and meter.
- **Account**: one login or key of one vendor. Its key is the vendor and the account name. It has a state: `ok`, `limited`, `dead` or `unknown`.
- **Account item**: the vault item of one account, with the ccswitch name. It holds the refresh token or the key. It is the only place for a refresh token.
- **Live item**: the vault item of one vendor that agent-vault reads. It holds the current access value of the picked account.
- **Auth state**: one file in the factory home with the accounts, their states, meters, limits, reset times and the picked account of each vendor. It holds no secret value.
- **Refresh lease**: the record of which process may refresh one account.
- **Meter reading**: the use, the limit, the window, the reset time and the read time of one account.
- **Classify result**: `limit`, `refused` or `none`, with the vendor, the account and the reset time.
- **Agent-vault key list**: the list of vendors, live items and placeholders that the core makes from the provider list.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In 30 days of server mode, no refresh chain dies because two refreshers used one token, and no person logs in again on the laptop for a refresh.
- **SC-002**: At least 90% of account changes happen before a worker hits a limit (from the meter). Today almost all changes come after a limit.
- **SC-003**: Fewer than 1 in 50 worker starts fails on a limit or a refused login.
- **SC-004**: A dead refresh chain sends mail to the manager within 10 minutes.
- **SC-005**: A new key vendor needs changes in only its plugin, its settings and its fixtures, and it takes one person less than 1 day.
- **SC-006**: All limit and refusal fixtures get the expected class.
- **SC-007**: Every front end shows the same accounts, states and plan use.
- **SC-008**: No secret value is found in the home, the backup, the logs or a worker VM by a secret scan after the migration.
- **SC-009**: The local-mode tests of spec 008 pass with no change.
- **SC-010**: The migration causes a stop of new worker starts for less than 15 minutes, and the rollback takes less than 30 minutes.

## Assumptions

- The password vault has a Connect server or an equal service that the pod can reach, and it gives a token that can write the account items and the live items.
- Agent-vault keeps its read of the live items about every 5 minutes, and it does not need a change for this spec.
- Claude, Codex and Grok give a usage value that a provider can read (an API or response headers). For a vendor without one, the text match is the only limit check.
- The ccswitch item names are stable, and the factory can read them.
- Local mode uses the same account items when the laptop can reach the vault.
- The owner keeps the key vendors' keys static. A key rotation is a person task.

## Dependencies

- Spec 010: the server pod, its lease and its home volume.
- Spec 008: the operation catalog and the parity check for the four front ends.
- Spec 005: the token report.
- ccswitch: the new vendors and the export (a separate repo and release).
- Agent-vault: it reads the live items. The step that makes its configuration from the key list depends on a managed deployment of agent-vault (it is a bare pod today).

## Out of Scope

- Logins and device flows in the factory. They stay in ccswitch on the laptop.
- A port of all of ccswitch to TypeScript.
- Key rotation for the static key vendors.
- A change to the agent-vault code.
- Per-worker credentials. Workers of one vendor share the live item, as today.
