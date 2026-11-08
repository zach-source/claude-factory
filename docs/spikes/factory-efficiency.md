# Spike: factory efficiency (claude-factory-aure)

This spike measures where the factory spends tokens and worker sessions without a result.
It ranks the waste by size and gives one fix for each item.
Each fix is a child bead of `claude-factory-aure`.

- Window: the 7 days before 2026-11-08. It includes the runs created in that window.

- Source: one live factory home with 13 rigs. This document names `claude-factory`. It calls the other rigs `rig-a` to `rig-l`.

- Method: read-only. The data comes from these sources:
  - `metrics.jsonl`
  - `runs/*/state.json`
  - `runs/*/usage.jsonl`
  - `launches.jsonl`
  - `manager-usage.jsonl`
  - `patrol-log.jsonl`
  - `pm-log.jsonl`
  - `merged-prs.json`
  - `factory metrics --since 7d --tokens --json`

- Fates come from `fate()` in `src/metrics.ts`. The fate counts match `factory metrics`: 773 shipped, 430 closed, 153 aborted, 106 rejected, 34 handed off, 95 running.

- Cost in USD is the API list price from `PRICES` in `src/metrics.ts`. The factory runs on subscription accounts. So the USD figure is only a scale. The real limit is the weekly account limit. In this window, 180 station visits stopped on `Claude usage limit (seven_day)`. So each token of waste is lost throughput.

## 1. Before the numbers: the token report counts sessions two times

`factory metrics --tokens` reports 8557M tokens for the window. The real figure is 6096M (+40% over-count).

- Cause: `usageIn` (`src/cli.ts:11530`) takes every transcript whose mtime is at or after the station start. The previous station's transcript changes again after the next station starts. So `storeUsage` stores that session again under the next station.

- Evidence: `usage.jsonl` has 9886 rows and 7088 unique run+session pairs. In one run, the session of triage seq 1 is also stored under plan seq 2. `storeUsage` stores the plan session again under implement seq 3. The same pattern repeats for the other stations in the run.

- Effect: the station table is wrong. For example, verify shows 1196M tokens. The real figure is 318M.

All numbers below count each run+session one time. The first station that stored a session owns it.

The report also misses some spend:

- A worker that times out or stops without a report stores no usage (772 visits).
- AX codex workers store no usage rows (1904 launches, 0 rows).
- `PRICES` has no Fable price, so 939M Fable tokens have no USD figure.

## 2. Totals

| Item | Value |
|------|-------|
| Worker tokens (one count a session) | 6096M in 7229 sessions |
| Manager tokens (patrol, pm, dream, reviewer) | 482M |
| Shipped runs | 773 |
| Tokens per shipped run (all worker tokens / shipped) | 7.9M |
| Sessions per shipped run (all sessions / shipped) | 9.4 |
| Tokens in shipped runs only, per shipped run | 6.3M, 7.2 sessions |
| Cache hit rate (cache read / context) | 94% |
| USD at API prices, priced models only | about $4450 workers, $564 manager |
| USD split by token type | cache read 43%, cache write 35%, output 22%, input 0% |

Model mix (worker tokens):

| Model | Tokens | Sessions |
|-------|--------|----------|
| claude-opus-5-5 | 2611M (43%) | 2043 |
| claude-sonnet-5-5 | 2494M (41%) | 4580 |
| claude-fable-5-1 | 939M (15%) | 488 |
| claude-haiku-5-5 | 40M (1%) | 114 |
| codex (gpt-6-astra, gpt-6.1-sol) | not stored | 1904 launches |

Tokens by fate:

- shipped: 4868M
- aborted: 403M
- running: 382M
- handed off: 241M
- closed: 187M
- rejected: 16M

### By station

| Station | Tokens | Sessions | Tokens per shipped run |
|---------|--------|----------|------------------------|
| implement | 1764M | 1243 | 2.3M |
| review | 1243M | 1025 | 1.6M |
| plan | 1067M | 708 | 1.4M |
| security | 981M | 586 | 1.3M |
| verify | 318M | 1098 | 0.4M |
| check | 274M | 341 | 0.4M |
| triage | 156M | 1313 | 0.2M |
| quick | 146M | 339 | 0.2M |
| all others | 147M | 576 | 0.2M |

Review, security and check together use 45% of the tokens of the runs that end approved.

### By rig

| Rig | Runs | Shipped | Tokens | Tokens per shipped run |
|-----|------|---------|--------|------------------------|
| claude-factory | 373 | 268 | 2468M | 9.2M |
| rig-a | 496 | 174 | 1329M | 7.6M |
| rig-b | 235 | 111 | 730M | 6.6M |
| rig-d | 137 | 81 | 582M | 7.2M |
| rig-c | 147 | 51 | 364M | 7.1M |
| rig-f | 44 | 26 | 300M | 11.5M |
| rig-e | 67 | 33 | 78M | 2.4M |
| rig-g | 31 | 10 | 77M | 7.7M |
| rig-h | 16 | 4 | 46M | 11.5M |
| rig-k | 11 | 4 | 45M | 11.2M |
| rig-i | 14 | 4 | 35M | 8.7M |
| rig-j | 12 | 2 | 34M | 16.8M |
| rig-l | 9 | 5 | 11M | 2.2M |

rig-a has the lowest ship rate (38% of ended runs). It has 242 plan outages and 235 plan failures in the window.

## 3. Waste, ranked by size

| # | Waste | Tokens (7d) | Sessions or slots (7d) | Evidence |
|---|-------|-------------|------------------------|----------|
| 1 | Rework after a `changes` verdict | 1893M (31%) | 350 runs | sessions after the first review, check or security `changes` |
| 2 | Timed-out and lost workers | est. 659M (not stored) | 772 visits, 821 slot-hours | `no report within N min` 507, `worker stopped without reporting` 265 |
| 3 | Security on builds that are not security-sensitive | about 490M of 981M | 488 of 701 approved builds sent on | security approves 78% |
| 4 | Aborted runs | 403M (overlaps 1, 2, 7) | 153 runs | 18 runs with 20+ visits used 114M |
| 5 | Patrol calls that find nothing | about 150M of 299M | 2926 patrols | 26 of the last 50 reports start with "Nothing" |
| 6 | Repeat `blocked` re-checks | 66M | 440 sessions | soak 137, deploy 75, security 47, plan 46 |
| 7 | Same PR head reviewed again | 41M | 130 sessions | security 73, review 41, check 11, verify 5 |
| 8 | pm calls with no cache and no change | 16M ($67) | 800 calls | cache read 0; 49 of 50 filed 0 |
| 9 | Codex launches into a refused login | not stored | about 980 refused, 976 slot-hours | plan codex 73% `login refused` |
| 10 | AX launch failures | near 0 | about 720 visits, about 1190 slot-hours | see below |
| 11 | Launch loop | small | 1646 launches of one visit | `lifecycle-mvz96b7rvj` triage seq 1 |

### 3.1 Rework after a `changes` verdict

- 350 runs got at least one `changes` verdict from review, check or security.

- Their sessions after that verdict used 1893M tokens. This is 31% of all worker tokens.

- `factory metrics` reports these values:
  - implement passes per shipped run: 1.92
  - runs with 3+ review rounds: 40
  - cap re-plans: 86

- Some rework is necessary. Some rework is mechanical. A sweep in rig-c found 9 send-back rounds in 11 days for format and build-file misses.

- In rig-c, the cause is that the VM has no tool for the build-file check. Implement often skips `make verify`.

- A keyword count of the `changes` summaries was not reliable. So this document does not split rework by cause.

### 3.2 Timed-out and lost workers

Each row below is one station and harness. The rates are shares of launches in the window.

| Station | Harness and model | Launches | OK | Timeout | Lost | AX fail | Auth or limit |
|---------|-------------------|----------|----|---------|------|---------|---------------|
| plan | claude opus | 912 | 74% | 19% | 0% | 6% | 1% |
| review | claude sonnet | 139 | 78% | 21% | 0% | 1% | 0% |
| review | claude opus | 1075 | 81% | 9% | 0% | 8% | 2% |
| implement | claude sonnet | 1365 | 81% | 1% | 10% | 7% | 1% |
| implement | claude opus | 89 | 75% | 0% | 20% | 2% | 2% |
| verify | claude sonnet | 1209 | 91% | 0% | 2% | 7% | 0% |
| security | claude fable | 461 | 92% | 0% | 0% | 7% | 1% |

- A timeout holds the slot for a median of 47 min. A lost worker holds it for 58 min.

- These workers store no usage. The estimate is the visit count times the median session of that station:
  - plan: 245M
  - implement: 188M
  - review: 178M
  - others: 48M

### 3.3 Security on builds that are not security-sensitive

- Review reports `security` when "the plan or the diff is security-sensitive" (`factories/lifecycle.ts`).

- In the window, review sent 488 of 701 approved builds (70%) to security. In claude-factory, review sent 190 of 261.

- Security then approved 366 of 467 verdicts (78%) with no change.

- Security used 981M tokens. Fable used 939M. Opus used 30M at API prices. Haiku and Sonnet used the rest.

### 3.4 Aborted runs

- 153 aborted runs used 403M tokens. For most of them, the last station was `blocked`:
  - plan: 35
  - triage: 27
  - security: 21 (274M)
  - implement: 17
  - review: 13

- The large ones are security rounds. Each one hit the made-worse gate. Then it re-checked the gate.

- For example, `lifecycle-mw5jeh9wes` had 29 visits and 41M tokens at security round 7.

### 3.5 Patrol

- 2926 patrols ran in 7 days. That is 418 a day. The median gap is 92 s.

- `PATROL_MS` is 10 min. But mail and run changes start a patrol earlier.

- The patrols used 299M tokens. The median was 99k tokens a patrol. The cache hit rate was 73%. The cost was about $395.

- In `patrol-log.jsonl`, 26 of the last 50 reports start with "Nothing". All 50 reports have an empty `actions` list. So the log does not show which patrols acted.

### 3.6 Repeat `blocked` re-checks

- 440 visits reported `blocked` right after a `blocked` visit at the same station: 66M tokens.
- A blocked park relaunches on a timer. The worker reads the same state and reports the same hold.
  Example: `ship-mvzklqdxyl` soak and deploy, many rounds.
- 24 of the security repeats name the made-worse gate.

### 3.7 Same PR head reviewed again

- 130 visits saw the same PR head as an earlier visit of the same station in the same run. These visits used about 41M tokens.

- For example, the review visits 6, 10 and 13 of `lifecycle-mw5gzcozcs` saw the same PR head.

### 3.8 pm

- 800 pm calls in 7 days, median gap 6 min.
- Every call has cache read 0 and about 19k cache write: 16M tokens, about $67.
- 49 of the last 50 pm-log entries filed 0. Each had the same 25 items and about 200 findings.

### 3.9 Codex launches into a refused login

- Codex is a share of plan, implement, verify, review and security launches: 1904 launches in the window.
- plan codex: 802 visits, 17% ok, 73% `login refused (auth)`. implement codex: 505 visits, 32% ok, 47% auth.
- Across all harnesses, 979 auth outages held a slot a median 62 min: 976 slot-hours.
- The factory stores no codex usage, so its token spend is unknown.

### 3.10 AX launch failures

These visits failed before a worker started. They spend near 0 tokens, but they spend an attempt and a slot.

| Failure | Visits | Median minutes held | Slot-hours |
|---------|--------|---------------------|------------|
| `Workspace is initializing` | 336 | 12 | 230 |
| `ActorTemplateCreationFailed` | 121 | 4 | 24 |
| `AtespaceCreationFailed` | 98 | 15 | 36 |
| `serve died` (bd bootstrap, clone) | 76 | 5 | 284 |
| `phase not found` | 67 | 37 | 47 |
| `egress policy not created` | 54 | 60 | 61 |
| `the laptop never sent brief.md` | 40 | 149 | 508 |
| `SandboxUnresponsive` | 5 | 9 | 1 |

The AX router keeps only live tasks. At the time of this spike, there were 5 live tasks. So these counts come from the run logs.

### 3.11 Launch loop

`lifecycle-mvz96b7rvj` logged 1646 launches of triage seq 1 in 2.3 h, one about every 5 s.
Each launch writes a brief and runs a memory search of up to 60 s.
70 other visits had 2 to 5 launches.

### 3.12 Smaller items (no bead)

- Guard denials: 1824 Claude Bash denials in the window. Each denial costs a worker turn.

  The largest reasons are these:

  - dynamic verb: 518
  - heredoc: 283
  - shell alias: 200
  - factory home: 187
- Brief size: median 41 KB (about 10k tokens), p90 57 KB. The rig section is about 13 KB in rig-a and goes to every station. Each turn reads the brief again from the cache.
- Cache hit rate is low for triage (81%), soak (73%) and queue (84%). These sessions are short, so the cache write of the first turn is a large share.

## 4. Fixes, ranked by expected saving

The savings are estimates for one week at the load of this window.

| Rank | Bead | Fix | Expected saving a week |
|------|------|-----|------------------------|
| 0 | claude-factory-aure.1 | Count each session one time; store usage on timeout and for codex; price Fable | none directly; it makes the numbers correct (2461M phantom tokens) |
| 1 | claude-factory-aure.2 | Send a build to security only for a security-sensitive diff, from the changed paths and the plan's risk line | about 490M tokens |
| 2 | claude-factory-aure.3 | A rig fast-check command (format, lint, build files) that implement and quick must run green before they report ready | about 380M tokens (assumption: a fifth of rework is mechanical) |
| 3 | claude-factory-aure.4 | Find the cause of plan and review timeouts; on a timeout, resume with "report now" before a fresh relaunch | about 330M tokens, 400 slot-hours |
| 4 | claude-factory-aure.5 | Skip the patrol call when the due signature has not changed and the heartbeat has not passed | about 150M tokens, $200 |
| 5 | claude-factory-aure.6 | Codex circuit breaker: on a refused login, set the codex share to 0 for the rig until the login works | about 900 launches, 900 slot-hours |
| 6 | claude-factory-aure.7 | Report AX launch failures as an outage (no attempt spent); detect "brief never sent" in minutes; back off per rig | about 1190 slot-hours, fewer aborts |
| 7 | claude-factory-aure.8 | A blocked park waits for an event (PR head moves, gate bead closes, mail), not a timer | about 60M tokens, 440 sessions |
| 8 | claude-factory-aure.9 | Before a review launch, compare the PR head with the station's last `Reviewed head`; reuse the verdict when equal | about 40M tokens, 130 sessions |
| 9 | claude-factory-aure.10 | Run pm only when the plan facts change; put the fixed prompt first so the cache hits | about 15M tokens, $60 |
| 10 | claude-factory-aure.11 | Hold a run after N launches of one visit with no worker | stops a rare loop |

Fixes 1 to 4 and 7 to 9 together: about 1.5B tokens a week, about 23% of worker tokens.
Fixes 5 and 6 together: about 2000 slot-hours a week.

Do fix 0 first. Without it, the station numbers that the other fixes use as their check are wrong.
