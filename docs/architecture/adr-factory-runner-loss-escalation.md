# ADR: Escalate a repeated CI runner loss to a host bug

## Context

On a pull request of the infra-blocks rig, two stations of one run reran the
Lint job 8 times (postmortem beads infra-blocks-b9hm and infra-blocks-9ijs).
Kubelet evicted the ARC runner pods on one host. The rule "rerun at most
twice" was only in factory memory. A blocked run parked, but no station filed
work to fix the host.

## Decision

`factories/lifecycle.ts` holds one house rule (`rules`). The brief of every
station shows it. `notBlocked` lists the matching reason to block.

- A runner loss is a CI job with the conclusion failure or cancelled, where a
  job annotation says the runner lost communication or got a shutdown signal,
  or a step of the job still has no conclusion.
- The station writes `Runner loss: <workflow> / <job> / <step> <job URL>` in
  its report. The journal keeps the line.
- The first loss at a key: rerun one time. File no bead.
- The second loss at the same key: do not rerun. File or update one host bug.
  Then report blocked with the bug id and both job URLs.
- The rule never merges, never marks a pull request ready and never skips a
  required check.

## Scenario matrix

The test `runner-loss scenario matrix` in `factories/lifecycle.test.ts` reads
this table. Each phrase must appear in `lifecycle.rules`.

| id | given | then | phrase |
| -- | ----- | ---- | ------ |
| S1 | the runner pod is lost and a step has no conclusion | counts, report line | `Runner loss: <workflow> / <job> / <step> <job URL>` |
| S2 | a step failed with a log | not a runner loss | `a step of the job still has no conclusion` |
| S3 | the first loss at a key | rerun one time, no bead | `gh run rerun <run id> --failed` |
| S4 | the second loss at the same key, seen by an earlier station | escalate, no rerun | `in a \`Runner loss:\` line of the journal` |
| S5 | an open host bug matches | comment and dependency, no new bead | `bd dep add <id> <run bead> -t discovered-from` |
| S6 | no host bug matches | create a bug, no factory label | `--deps discovered-from:<run bead>` |
| S7 | no kube context | write "not run" and the command | `ARC diagnostic: not run: <reason>` |
| S8 | the host bug exists | report blocked, merge gate kept | `never replaces the person's merge` |

## Rejected options

- A copy of the rule in each station prompt: the copies drift.
- Code in `src/cli.ts` that reads CI and counts losses: the reconciler does
  not read CI jobs.
- "Rerun at most twice": it gives three runs on one host fault.
- The `factory` label on the host bug: the person sets its priority.
- A new station-specific rule in `ship.ts` and `release.ts`: `ship.ts` must
  not import `lifecycle.ts`. The tests pin the `rules` text of `ship.ts` and
  `sweeps.ts` equal to the text of `lifecycle.ts`, so both hold a copy of this
  bullet. `release.ts` has its own rules. Bead claude-factory-7qzc tracks it.

## Consequences

- Runs that start before the merge keep the old text.
- Each brief grows by about 1.9 KB.
- Rollback: a pull request that reverts the merge commit. Beads that the rule
  filed stay open for the person.
