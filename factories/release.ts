import type { Factory } from '../src/machine'

// Ship a release made of pull requests that are already open: wait for each to merge, then cut and roll
// out the release the repo's own way.
//
//   recipe → gather (each pull request merged) → cut (the release pull request) → rollout (you merge) → soak
//
// Every repo releases differently (release branches, tags, version files, a promotion pipeline), so no
// station assumes one: recipe learns it from the repo — .factory/release.md first, then its docs, scripts,
// CI jobs and how its last releases were actually done — and every later station follows that recipe.
// As in lifecycle, a person's merge is the only gate: no station merges a pull request.
//
//   factory start release <rig> "<version or bead>: <the pull requests it ships>"

const claude = (model: string) => `{claude} --dangerously-skip-permissions --model '{${model}}'`
const SONNET = claude('exec_model')
const OPUS = claude('judge_model')
// stations that read or change production need the laptop's access, as in lifecycle
const LAPTOP = 'herdr'

// the Runner loss bullet is a copy of the one in lifecycle.ts (release.ts imports only types); ship.test.ts pins it equal
const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Follow the release recipe in the journal exactly; where it is silent, do what the repo's last release did and say so.
- Only a person merges a pull request; only rollout and rollback touch production. Nobody pushes a release branch or the default branch directly; a rollback that reverts code opens a pull request for a person to merge instead. Nobody force-pushes.
- Owner-only, even with a merge in hand: a hand-run change to a live system (kubectl apply, patch, scale, delete or rollout restart; a helm or terraform apply), an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential, secret or token change. Do one of these only when a person's own comment on the bead or a [factory mail] from the manager says the person approved that exact step. The bead's description records no author, so it never counts as approval; a worker's own comment never counts as approval. Otherwise do every other step, then report blocked: \`parked, waiting on: <the owner step and the exact command>\`. Reads, and watching a pipeline the person's merge started, stay allowed.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, tags, pull requests, pipelines) and never repeat an external action that already happened.
- Stay in scope: file anything else you find as separate work (see Tracking), at most three per station.
- Your report summary is the next station's whole briefing: concrete and complete, links over descriptions.
- Runner loss in CI: a runner loss is a CI job with the conclusion failure or cancelled where a job annotation says the runner lost communication with the server or got a shutdown signal, or a step of the job still has no conclusion (\`gh api repos/<owner>/<repo>/actions/jobs/<job id> --jq '.steps[]'\`). A failed step with a log, a step timeout with a log and a cancel by a person or by concurrency are not a runner loss. If you cannot read the jobs API, do not count a runner loss: use the other rules for the red check. Write \`Runner loss: <workflow> / <job> / <step> <job URL>\` in your report; the key is the workflow, job and step name. At the first loss at a key, run \`gh run rerun <run id> --failed\` one time and file no bead. At the second loss at the same key, in this station or in a \`Runner loss:\` line of the journal, do not rerun. Run \`bd search 'CI runner loss: <workflow> / <job> / <step>' --status open,in_progress,blocked\`. If a bead is open, add both job URLs and the diagnostic with \`bd comment <id> --file <path>\` and run \`bd dep add <id> <run bead> -t discovered-from\`; create no second bead. If none is open, run \`bd create 'CI runner loss: <workflow> / <job> / <step>' -t bug -p 2 --deps discovered-from:<run bead> --body-file <path>\` with no \`-l factory\`, because the person sets the priority; <run bead> is this run's own bead. The file holds both job URLs, the runner names and the diagnostic. For an ARC runner, take runner_name from the jobs API and run \`kubectl -n arc-system logs <gha-rs-controller pod> --since=48h | grep '"podReason": "Evicted"'\`. Write eviction in the bug only when the grep shows that runner pod. If you have no kube context or the rules do not allow the read, write \`ARC diagnostic: not run: <reason>\` and the exact command in the bug; do not guess a cause. Then report blocked with the host bug id and both job URLs. The host bug never replaces the person's merge: do not merge, do not run \`gh pr ready\` and do not skip a required check.`

export default {
  name: 'release',
  start: 'recipe',
  agent: SONNET,
  params: {
    claude: 'claude-smart --new --no-channels',
    exec_model: 'claude-sonnet-5-5[1m]',
    judge_model: 'claude-opus-5-5[1m]',
  },
  backoffSec: 60,
  maxSteps: 40, // gather and rollout park and wake many times while people merge
  rules,
  nodes: {
    recipe: {
      agent: OPUS,
      timeoutMin: 45,
      prompt: `Learn how this repo releases, and what this release holds. Change no code.
1. The recipe, in this order of authority: .factory/release.md if the repo has one; release docs (RELEASING, CONTRIBUTING, AGENTS.md, README); release scripts and Makefile targets; CI jobs that cut, tag, promote or deploy; then the last three releases as they actually happened (release branches, tags, version bumps, changelog entries, release pull requests, pipelines). Write it as numbered steps: the integration branch changes merge into, how the version is chosen and where it is written, the changelog, how the release is cut (branch, tag, pull request into which branch), what a person must approve or merge, how each environment is rolled out and verified, and how a release is rolled back.
2. The contents: every pull request the goal names (and, with beads, those its bead and children cite), each with its link, title, target branch and state. Add nothing the goal does not ask for.
3. The version, by the repo's rule.
When the repo has no written recipe, file separate work to add yours as .factory/release.md.
Report ready with the recipe, the contents and the version; or reject when the goal names no pull request or the repo has no way to release it, saying why.`,
      next: { ready: 'gather', reject: { to: 'done', reject: true } },
    },
    gather: {
      timeoutMin: 20,
      parkMin: 30, // GitLab merge requests are not watched: a park is how this station polls them
      prompt: `Check every pull request in the release's contents against its target branch: merged, open (and what it waits for: review, CI, conflicts, a person), or closed unmerged. Change nothing.
Report merged when all are merged, with each merge commit. Otherwise report blocked, listing each one not merged with its link and what it waits for, so the person is asked; you are woken to check again. One closed unmerged: mail the manager whether to ship without it and report blocked until the answer, then follow it.`,
      next: { merged: 'cut' },
    },
    cut: {
      timeoutMin: 60,
      prompt: `Cut the release by the recipe, from the integration branch as it is now: the version bump, the changelog entry listing every pull request in it, and the release branch, tag or release pull request the recipe calls for. First check what is already cut and do only what is not. When the recipe has a pull request carry the release, open it with the contents, the version and the rollback plan in its description, and wait for its CI.
Report ready with the release pull request or tag link, the CI status, and exactly what merging and rolling it out will do; or red with every failure and how to reproduce it.`,
      next: { ready: 'rollout', red: { to: 'cut', delayMin: 30 } },
    },
    // the Made-worse gate line is a copy of worseGate in ship.ts and lifecycle.ts; lifecycle.test.ts pins the three equal
    rollout: {
      runner: LAPTOP,
      retries: 1,
      timeoutMin: 120,
      parkMin: 30,
      prompt: `Roll the release out by the recipe once a person has approved it: their merge of the release pull request (or the approval the recipe names) is the go, and you never merge it yourself. First check what is already done (merged? tagged? which environments have it?) and do only what is not.
That approval covers the release it carries, not an owner-only step (see House rules): a hand-run kubectl or helm apply, an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential change. Do every other step, then park with \`parked, waiting on: <the owner step and the exact command>\` and a \`Question:\` line asking the person to run it or to approve you running it.
Not approved yet: report blocked with the link and what it waits for; if a person closed it, report hold with their reason.
Made-worse gate: before you mark ready, merge or deploy a pull request, run \`bd dep list <bead> --direction=up -t discovered-from\` for its bead. Run \`bd show <id>\` for each open bead in the list. A bead gates the pull request when its description or a comment contains \`Made worse by: <bead>\`, or says that this change makes it worse in production. The gate clears only when that bead is closed, or when a person's own comment on it or a [factory mail] from the manager says to ship anyway. If a bead gates the pull request, do not mark it ready, merge it or deploy it. If it is not a draft, run \`gh pr ready <n> --undo\`. Report blocked with each gating bead id and a \`Question:\` line that asks the person to ship before the fix or to wait. If a bd command fails, report blocked with the command: never ship on a failed read.
Approved: record the production baseline it will be compared against from the window just before, then run or watch each environment's rollout in the recipe's order to the end, verify it (pipeline status, the deployed version, rollout status) and run a smoke check.
The smoke check must see the change's own output on the live system: the file it writes, the log line it prints, or the process or subagent it starts. A passing neighbor command does not prove the change. If the change has not fired yet, that is "not fired yet": report unsure, never deployed.
For deployed and unsure reports, the time must be the UTC rollout completion time for this version across all target environments.
Report deployed with the version, the environments, the time, the baseline and the own output you saw; unsure to soak with the version, the time, the baseline, the exact output that soak must see and its trigger, when the change has not fired yet; published when the release has no running service to watch (and, except for a docs-only or test-only change, you saw its own output); failed when a rollout did not complete.`,
      next: {
        deployed: { to: 'soak', delayMin: 15 },
        unsure: { to: 'soak', delayMin: 15 },
        published: 'done',
        failed: 'rollback',
        hold: { to: 'done', defer: true },
      },
    },
    soak: {
      runner: LAPTOP,
      timeoutMin: 30,
      prompt: `The release has run for a soak period. Compare production now with the baseline rollout recorded: error rates and new error types, latency, saturation, SLO burn, logs, and the checks each pull request in it named. Read-only.
Actual regression always reports regressed to rollback before any deadline exception. Observed own output retains the normal health path against the baseline. Healthy requires own output on the live system unless every deadline exception requirement below holds.
Put the version, rollout UTC time or its absence, current-inclusive count, and unseen outputs first in every soak report.
For this version since its latest rollout, count prior unsure and blocked soak reports with unseen output, plus this soak once. Do not count other versions, pre-rollout reports, worker launches, or retries without reports.
The deadline is the fourth such soak or 24 hours after rollout, whichever comes first. Count 3 before 24 hours stays unsure; count 4 qualifies; exactly 24 hours qualifies at count 1.
Use the rollout report's UTC completion time for this version across all target environments. Never use cut, merge, or restart time. Absent, future, or invalid time disables only the time arm; count 4 still qualifies with complete count evidence. Unknown count cannot satisfy the count arm.
Briefs retain 25 entries and clip summaries to 1500 characters. Read full history or source bead comments when the brief lacks required evidence.
Classify the whole release from all constituent plans, beads, and review comments. Only known ordinary risk permits the deadline exception. Any exceptional constituent denies the exception for the whole release.
A security-sensitive plan or bead makes the release must-see-live. A data migration makes the release must-see-live. A schema migration makes the release must-see-live. An explicit must-see-live AC makes the release must-see-live. Unknown risk makes the release must-see-live.
A bead comment with a review#<n> security:, check#<n> security:, or security#<n> prefix makes the release must-see-live.
For must-see-live releases, the deadline never applies, even at count 4 or age 24 hours. After two consecutive unsure soaks with unseen output, including this soak, report blocked with the output, trigger, and a \`Question:\` line. For ordinary releases with unseen output, report unsure before the deadline.
Deadline-based healthy requires complete rollout in all target environments. Deadline-based healthy requires the expected version in all target environments. Deadline-based healthy requires ready targets. Deadline-based healthy requires no restarts. Deadline-based healthy requires clean logs. Deadline-based healthy requires no regression against the baseline.
Absent baseline, unreadable checks, or denied reads prevent healthy; never infer clean health. At the deadline, incomplete or unknown health reports blocked with evidence and a \`Question:\` line. The deadline grants no live access or owner approval.
The next follow-up and record rules apply only to deadline-based healthy with unseen output.
Before deadline-based healthy, search \`bd list -l verify:live --status open,in_progress,blocked\` and read candidate bodies.
Reuse one active bead only when the source release bead matches. Reuse requires the same release version. Reuse requires all unseen outputs. Reuse requires all their triggers. Reuse requires all target environments. Closed beads, another source with the same version, or absent outputs do not qualify.
If no match exists, run \`bd create 'verify live release output' -t task -p 2 -l verify:live --deps discovered-from:<source bead> --body-file <path>\`. Add no factory or dispatch labels. The body lists the source bead, version, all unseen outputs, triggers, environments, and deferred checks. Use --body-file and a plain-word, shell-safe single-quoted title; never interpolate untrusted text into commands.
Confirm the saved bead with \`bd show <id>\`. Failed search blocks healthy. Failed read blocks healthy. Failed create blocks healthy. Failed comment blocks healthy. Absent source bead blocks healthy with a question for the manager.
If a bead operation fails or the source bead is absent, report blocked; never infer success. Name the command and evidence.
Before healthy, record the confirmed follow-up ID in the source bead comment. Before healthy, record the confirmed follow-up ID in the soak summary. Both records must also name version, rollout time or absence, current-inclusive count, deadline arm, risk, health, outputs, and triggers.
Each deferred check says \`not checked (not fired yet: filed <id>)\`, never passed. On retry, inspect this evidence and reuse the qualifying follow-up.
At the deadline, report healthy with unseen output only after all risk, health, and durable follow-up requirements hold. State a cause as a hypothesis unless you reproduced it. Say how you reproduced it or what would prove it.`,
      next: {
        healthy: 'done',
        unsure: { to: 'soak', delayMin: 15 },
        regressed: 'rollback',
      },
    },
    rollback: {
      runner: LAPTOP,
      retries: 3,
      timeoutMin: 45,
      prompt: `Restore service. Check what is already rolled back, then roll back by the recipe: redeploy the previous version, turn the flag off, or open a pull request that reverts the release, since you never push a release branch or the default branch directly. Confirm recovery against the baseline. File the fix forward as separate work for a person to prioritize, citing the pull request that caused it.
Report recovered with what you did, the evidence, and the revert pull request's link if you opened one. A cause is a hypothesis unless you reproduced it: say how you reproduced it, or what would prove it.`,
      next: { recovered: 'done' },
    },
  },
} satisfies Factory
