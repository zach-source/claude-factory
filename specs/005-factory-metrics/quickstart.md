# Quickstart: check the metrics

Each check names the user story and the spec items that it proves. Checks 1 to 4 are the first release.

## 1. DORA for one rig (US1, SC-001)

```sh
factory metrics dora --rig <rig> --since 30d
factory metrics dora --rig <rig> --since 30d --json > /tmp/dora.json
```

Count by hand for the same rig and window:

- deployments: `gh pr list -R <repo> --state merged --search "merged:>=<from>"`, count;
- lead time: for 5 PRs, merge time minus first commit time;
- failure rate: the links from check 2 that are not `suspected` or `wrong`.

Expected: each number is within 5% of the hand count. A rig with a deploy station also shows `merge to deploy`.

## 2. Attribution (US2, SC-002)

Make a temp repo with 3 merged PRs (A, B, C) and fake `gh` output, as the CLI tests do. Revert A. File a bug bead `discovered-from` the bead of B. Then:

```sh
factory metrics links
```

Expected:

- a `revert` link to A, a `fix-forward` link to B, no link to C;
- a second run of the pass adds no rows;
- `factory metrics links wrong <id of B link>` removes B from the failure rate.

On real data: for 14 days, at least 80% of rollback, soak `regressed` and incident runs have a link. Check 10 links with `source: text` by hand.

## 3. Quality by model (US5, SC-003)

Use a test home with two models at implement on one rig. Model X has 3 failure links in 10 changes. Model Y has 0 in 10 changes:

```sh
factory metrics quality --rig <rig> --by station,model
```

Expected: X is above Y. Both rows show `k/n`. A group with fewer than 10 runs shows `*`.

## 4. Outputs agree (FR-023, FR-026)

```sh
factory metrics serve --port 9464 &
curl -s localhost:9464/metrics | grep factory_change_failure_ratio
FACTORY_OTLP_ENDPOINT=http://localhost:4318 factory metrics dora --push
```

Expected: the scrape, the OTLP body (read it in a local collector with the debug exporter) and `--json` give the same values. The console Metrics tab shows the same numbers. `factory metrics report` prints the weekly report.

## 5. Verdict scores (US3, later phase)

Use a test home with two reviews. The first review approved a change that later has a revert link. The second review had 3 findings that led to 2 changes that stayed:

Expected: `factory metrics verdicts` shows a miss for the first review and precision 2/3 for the second.

## 6. Defect probes (US4, later phase)

Turn the probe on for a test rig with 5 probes. Expected: 5 rows in `probes.jsonl`, no new branch, no PR and no bead. The daily budget stops a sixth probe.

## 7. Judge gate (US6, later phase)

Grade 30 changes for one rubric item in the console. Expected: `factory judge status` shows kappa. Below 0.6, the item's scores do not appear in any output.

## 8. Proposals cite metrics (US7, later phase)

Give the dream a metrics file. In the file, one model's failure rate is 2 times another's at implement on the same rig, for 2 windows. Expected: a proposal that names both groups and their `k/n`.
