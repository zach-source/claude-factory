# Contract: telemetry

One function in `src/telemetry.ts` builds both formats from the metrics object. Thus `/metrics`, the OTLP push and `--json` always agree.

## Series

All series are gauges for the configured window. Labels: `rig`, and for quality series also `station`, `harness` and `model`.

| Name                                   | Unit    | Value                                            |
| -------------------------------------- | ------- | ------------------------------------------------ |
| `factory_deployments`                  | count   | Deployments in the window.                       |
| `factory_deployments_per_day`          | 1/day   |                                                  |
| `factory_lead_time_seconds`            | seconds | Label `quantile` = `0.5` or `0.9`.               |
| `factory_lead_time_queue_seconds`      | seconds | Median.                                          |
| `factory_lead_time_run_seconds`        | seconds | Median.                                          |
| `factory_change_failure_ratio`         | ratio   |                                                  |
| `factory_change_failures`              | count   | Direct links only.                               |
| `factory_suspected_failures`           | count   |                                                  |
| `factory_recovery_seconds`             | seconds | Label `quantile`.                                |
| `factory_open_failures`                | count   |                                                  |
| `factory_rework_ratio`                 | ratio   |                                                  |
| `factory_first_pass_verify_ratio`      | ratio   | Smoothed. Quality labels.                        |
| `factory_first_pass_review_ratio`      | ratio   | Smoothed. Quality labels.                        |
| `factory_passes_per_ship`              | count   | Quality labels.                                  |
| `factory_group_failure_ratio`          | ratio   | Smoothed. Quality labels.                        |
| `factory_churn14_ratio`                | ratio   | Quality labels.                                  |
| `factory_group_runs`                   | count   | Quality labels. Lets a panel hide low counts.   |
| `factory_window_days`                  | days    | No labels.                                       |

The factory does not send a value that is null (no data).

## `/metrics`

- Prometheus text format 0.0.4, `Content-Type: text/plain; version=0.0.4`.
- A 60 s cache: a scrape inside 60 s of the last one gets the same body.
- Local mode: `factory metrics serve --port <n>`. Server mode: the server mounts the handler (spec 004).
- No auth on the local port. Unless you give `--host`, bind to `127.0.0.1`.

## OTLP push

- If you set `FACTORY_OTLP_ENDPOINT`, each metrics pass sends `POST <endpoint>/v1/metrics` with an OTLP/HTTP JSON `ExportMetricsServiceRequest`.
- `FACTORY_OTLP_HEADERS`: extra headers in the OTel form `k1=v1,k2=v2`.
- Resource attributes: `service.name=factory`, `factory.home=<home name>`, `factory.mode=local|server`.
- A failed push logs one line and does not fail the command.
- The weekly report timer and the server's metrics timer both push. The CLI pushes only with `--push`.
