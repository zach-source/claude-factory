# Contract: metrics CLI

All commands are read-only on runs, beads and GitHub. The only files that they write are `changes.jsonl`, `links.jsonl`, their cursors, and the cache for `serve` (FR-025).

Common flags:

| Flag           | Default | Meaning                                                                    |
| -------------- | ------- | -------------------------------------------------------------------------- |
| `--rig <r>`    | all     | One rig only.                                                              |
| `--since <n>d` | `30d`   | The window. The trend compares it with the `n` days before it (FR-026).   |
| `--json`       | off     | Print the metrics object (data-model.md) in place of text.                |
| `--no-sync`    | off     | Do not read `gh` or git. Use the stored change table and links only.      |
| `--push`       | off     | Also send the metrics to `FACTORY_OTLP_ENDPOINT` (contracts/telemetry.md). |

## `factory metrics dora`

Unless you give `--no-sync`, it runs the change pass and the attribution pass from their cursors before it calculates.

Text output, one block for each rig:

```text
<rig>  30d (prev 30d)
  deployments      42  1.4/day   (prev 35, 1.2/day)
  lead time        3.1h median / 14.2h p90   queue 1.0h  run 2.0h
  failure rate     3/42  7%      (prev 2/35)   suspected 2
  recovery         1.5h median / 6.0h p90    open 1
  rework rate      5/42  12%
  merge to deploy  0.8h median
```

A rate with fewer than 5 deployments shows only `k/n` (US1 scenario 4).

## `factory metrics quality [--by station,harness,model,rig]`

Default `--by station,model`. Text output, one row for each group, worst failure rate first:

```text
station    harness  model           runs  1st verify  1st review  passes/ship  fail rate   churn14
implement  codex    <model a>         61  48/61 0.79  30/52 0.58         1.9  4/52 0.08      0.11
implement  claude   <model b>          8   6/8 0.74*   4/7 0.55*         2.3  1/7 0.10*      -
```

`*` marks a smoothed value for a low-count group (FR-018).

## `factory metrics links [--kind k] [--open]`

Lists the failure links in the window: id, kind, source, change, evidence, found, recovered.

## `factory metrics links wrong <id> [<why>]`

Marks a link wrong (FR-010). It appends the row again with `wrong: true`. A worker or a patrol cannot run it.

## `factory metrics report`

Prints the weekly report (research R9).

## `factory metrics serve [--port 9464]`

Serves `/metrics` (contracts/telemetry.md). It runs until you stop it.

## Later phases

- `factory report <run> <seq> changes "<summary>" --findings <file>` (US3). For 7 days after release, a `changes` report with no findings gives a warning. After that, the CLI refuses it.
- `factory metrics verdicts [--by ...]` (US3): recall, precision and override rate.
- `factory probe run [--rig r]` and `factory probe status` (US4).
- `factory judge calibrate <item>` and `factory judge status` (US6).
