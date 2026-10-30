# Data model: delivery and quality metrics

Local mode keeps each record type in a JSON Lines file under the factory home. Each row has a key. A reader keeps the last row for each key, so a pass can update a row by adding the row again. Server mode (spec 004, step S6) keeps the same fields in tables of the `factory` database.

## `changes.jsonl`: Change

One row for each merged pull request. Key: `repo` + `number`.

| Field         | Type           | Notes                                                                              |
| ------------- | -------------- | ---------------------------------------------------------------------------------- |
| `repo`        | string         | `owner/name`.                                                                      |
| `number`      | number         | The PR number.                                                                     |
| `rig`         | string         | The rig that holds the repository.                                                 |
| `mergeCommit` | string         | The merge or squash commit on the default branch.                                  |
| `mergedAt`    | number         | Epoch ms. The deployment time (FR-002).                                            |
| `firstCommit` | number         | Epoch ms. The earliest authored commit, or the PR creation time (research R1).     |
| `run`         | string \| null | The run id from `factory/<run id>`. Null for a PR that a person made.              |
| `bead`        | string \| null | The run's bead.                                                                    |
| `runStart`    | number \| null | The run's creation time. Lead time splits at this point (FR-003).                  |
| `beadCreated` | number \| null | The bead's creation time.                                                          |
| `deployedAt`  | number \| null | The first deploy outcome `deployed` for this PR, if the rig has a deploy station.  |
| `implement`   | object \| null | `{harness, model}` of the last implement attempt before the merge (research R7).   |
| `planned`     | boolean        | False for a fix-forward, a revert or a hotfix run (FR-005).                        |
| `added`       | number         | Lines added by the change.                                                         |
| `churn14`     | number \| null | The share of added lines changed again within 14 days. Null until day 14.          |
| `backfilled`  | boolean        | True for a row from the history backfill.                                          |

Cursor: `changes.cursor.json` holds the last `mergedAt` read for each repository.

## `links.jsonl`: FailureLink

One row for each failure linked to a change. Key: `kind` + `evidence`.

| Field        | Type    | Notes                                                                                 |
| ------------ | ------- | ------------------------------------------------------------------------------------- |
| `id`         | string  | A short hash of the key. `factory metrics links wrong <id>` uses it.                  |
| `kind`       | string  | `rollback`, `regression`, `incident`, `revert`, `fix-forward`, `suspected`.           |
| `repo`       | string  |                                                                                       |
| `number`     | number  | The failing change.                                                                   |
| `evidence`   | string  | A run id, a commit or a bead id.                                                      |
| `source`     | string  | `run`, `text`, `revert`, `bead`, `blame` (research R3).                               |
| `weight`     | number  | 1, or 1/n when one failure links to n changes.                                        |
| `foundAt`    | number  | Epoch ms. The start of recovery (research R4).                                        |
| `recoveredAt`| number \| null | Epoch ms. Null while the failure is open.                                      |
| `wrong`      | boolean | Set by the owner. The metrics leave out a wrong link (FR-010).                        |
| `backfilled` | boolean |                                                                                       |

Rule: only links with `kind` other than `suspected` and `wrong: false` count in the change failure rate (FR-004).

## Later phases

### `findings.jsonl`: Finding (US3)

Key: `run` + `seq` + `id`. Fields: `run`, `node`, `seq`, `id`, `file`, `line`, `severity` (`blocker`, `major`, `minor`), `category`, `text`, `harness`, `model`, `outcome` (`fixed`, `disputed`, `ignored`, `unknown`).

### `probes.jsonl`: Probe (US4)

Key: `id`. Fields: `id`, `rig`, `repo`, `number`, `kind` (the defect kind), `file`, `line`, `node`, `harness`, `model`, `result` (`catch`, `miss`, `invalid`), `tokens`, `at`.

### `grades.jsonl`: JudgeGrade (US6)

Key: `repo` + `number` + `item` + `by`. Fields: `item` (the rubric item), `by` (`owner` or `judge`), `score` (1 to 5), `at`. The calibration state for each item (`kappa`, `n`, `published`) is in `judge.json`.

## Metrics object

`dora.ts` and `quality.ts` return one object. The CLI `--json`, the console view, `/metrics` and the OTLP push all read it:

```ts
type Metrics = {
  window: { from: number; to: number; days: number }
  rigs: Record<string, {
    dora: {
      deployments: number
      perDay: number
      leadTime: { median: number | null; p90: number | null; queue: number | null; run: number | null }
      failureRate: { k: number; n: number }
      recovery: { median: number | null; p90: number | null; open: number }
      reworkRate: { k: number; n: number }
      mergeToDeploy: { median: number | null } | null
      suspected: number
    }
    previous: /* the same dora object for the window before */ unknown
    quality: Array<{
      station: string; harness: string; model: string
      runs: number
      firstPassVerify: { k: number; n: number; smoothed: number }
      firstPassReview: { k: number; n: number; smoothed: number }
      passesPerShip: number | null
      failureRate: { k: number; n: number; smoothed: number }
      churn14: number | null
      lowCount: boolean
    }>
  }>
}
```
