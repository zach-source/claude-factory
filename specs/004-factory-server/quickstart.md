# Quickstart: check the factory server

These checks prove each user story on a test cluster namespace. Do them in order. Each check names the spec item that it proves.

## Prerequisites

- A namespace with the server Deployment and its PVC (see plan.md, step S2).
- A person certificate on the laptop: `factory cert person <name>` writes it to `~/.config/factory/person.{crt,key}`.
- `FACTORY_SERVER=https://<gateway address>:8444` in the laptop shell.
- A test rig on the AX runner with `maxRuns: 1` and a small repo.

## 1. A worker calls the server (US1, SC-001, SC-003)

```sh
factory start lifecycle test-rig "add a hello file"
factory status            # the run is at implement, pane ax://f-...
```

In the task (`ax ssh <task> -- ...`), check the worker env and one call:

```sh
factory memory search "hello"     # prints notes, not "nothing in ... yet"
```

Expected:

- The search prints the same top 5 notes as the laptop gives for "hello" with no `FACTORY_SERVER`.
- After the worker reports, `factory show <run>` shows the next station within 10 s.
- `SELECT kind, status FROM worker_calls WHERE run = '<run>'` shows the search, any helped call and the report, all `applied`.

## 2. A worker cannot act on another run (US1 scenario 3)

From the task, with its own token:

```sh
curl -H "Authorization: Bearer $FACTORY_TOKEN" \
  -X POST "$FACTORY_WORKER_API/v1/report" -d '{"run":"<other run>","outcome":"ok","summary":"x"}'
```

Expected: HTTP 403. A `worker_calls` row with status `refused` exists. The client API on port 8444 refuses the task's TLS connection.

## 3. Codex usage (US1 scenario 4, SC-007)

Start a run with `params: {codex_share: "1"}`. After implement ends:

```sh
factory metrics tokens | grep gpt-
```

Expected: a row for `gpt-6.1-sol` with nonzero tokens.

## 4. No laptop process for 1 hour (US2, SC-004)

1. Stop every factory process on the laptop, and close every Claude Code session.
2. Wait 1 hour.
3. Run `factory status` with `FACTORY_SERVER` set.

Expected: at least one run moved through 3 stations in that hour. `agent_steps` has patrol rows on their interval.

## 5. Server restart (US2 scenario 2, SC-006)

```sh
kubectl -n <ns> rollout restart deployment/factory-server
kubectl -n <ns> rollout status deployment/factory-server --timeout=120s
```

Expected: each live run continues from its stored state. For each run, the count of `DONE` events in `run_events` equals the count of reports in `worker_calls` with status `applied`.

## 6. One writer (US2 scenario 3)

Scale the Deployment to 2 for 1 min, then back to 1.

Expected: the `lease` row names one pod for that whole minute. The second pod logs "lease held" and does not tick.

## 7. Local mode (US6, FR-016, FR-018)

Unset `FACTORY_SERVER` and start the laptop manager with `bin/up` on a local home that has one herdr rig and one AX rig.

Expected:

- Each rig finishes one run, as before this feature.
- In the AX task, `factory memory search "hello"` prints notes from the launch snapshot.
- Do this check after each cutover step.
