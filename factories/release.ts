import type { Factory } from "../src/machine";

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

const claude = (model: string) =>
  `{claude} --dangerously-skip-permissions --model '{${model}}'`;
const SONNET = claude("exec_model");
const OPUS = claude("judge_model");
// stations that read or change production need the laptop's access, as in lifecycle
const LAPTOP = "herdr";

const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Follow the release recipe in the journal exactly; where it is silent, do what the repo's last release did and say so.
- Only a person merges a pull request; only rollout and rollback touch production, and rollback alone may revert on a release branch or the default branch; nobody force-pushes.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, tags, pull requests, pipelines) and never repeat an external action that already happened.
- Stay in scope: file anything else you find as separate work (see Tracking), at most three per station.
- Your report summary is the next station's whole briefing: concrete and complete, links over descriptions.`;

export default {
  name: "release",
  start: "recipe",
  agent: SONNET,
  params: {
    claude: "claude-smart --new --no-channels",
    exec_model: "claude-sonnet-5[1m]",
    judge_model: "claude-opus-5-5[1m]",
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
      next: { ready: "gather", reject: { to: "done", reject: true } },
    },
    gather: {
      timeoutMin: 20,
      parkMin: 30, // GitLab merge requests are not watched: a park is how this station polls them
      prompt: `Check every pull request in the release's contents against its target branch: merged, open (and what it waits for: review, CI, conflicts, a person), or closed unmerged. Change nothing.
Report merged when all are merged, with each merge commit. Otherwise report blocked, listing each one not merged with its link and what it waits for, so the person is asked; you are woken to check again. One closed unmerged: mail the manager whether to ship without it and report blocked until the answer, then follow it.`,
      next: { merged: "cut" },
    },
    cut: {
      timeoutMin: 60,
      prompt: `Cut the release by the recipe, from the integration branch as it is now: the version bump, the changelog entry listing every pull request in it, and the release branch, tag or release pull request the recipe calls for. First check what is already cut and do only what is not. When the recipe has a pull request carry the release, open it with the contents, the version and the rollback plan in its description, and wait for its CI.
Report ready with the release pull request or tag link, the CI status, and exactly what merging and rolling it out will do; or red with every failure and how to reproduce it.`,
      next: { ready: "rollout", red: { to: "cut", delayMin: 30 } },
    },
    rollout: {
      runner: LAPTOP,
      retries: 1,
      timeoutMin: 120,
      parkMin: 30,
      prompt: `Roll the release out by the recipe once a person has approved it: their merge of the release pull request (or the approval the recipe names) is the go, and you never merge it yourself. First check what is already done (merged? tagged? which environments have it?) and do only what is not.
Not approved yet: report blocked with the link and what it waits for; if a person closed it, report hold with their reason.
Approved: record the production baseline it will be compared against from the window just before, then run or watch each environment's rollout in the recipe's order to the end, verify it (pipeline status, the deployed version, rollout status) and run a smoke check.
Report deployed with the version, the environments, the time and the baseline; published when the release has no running service to watch; failed when a rollout did not complete.`,
      next: {
        deployed: { to: "soak", delayMin: 15 },
        published: "done",
        failed: "rollback",
        hold: { to: "done", defer: true },
      },
    },
    soak: {
      runner: LAPTOP,
      timeoutMin: 30,
      prompt: `The release has run for a soak period. Compare production now with the baseline rollout recorded: error rates and new error types, latency, saturation, SLO burn, logs, and the checks each pull request in it named. Read-only.
Report healthy when it holds; unsure to soak one more period (at most twice in a row); regressed, with the evidence, when it got worse.`,
      next: {
        healthy: "done",
        unsure: { to: "soak", delayMin: 15 },
        regressed: "rollback",
      },
    },
    rollback: {
      runner: LAPTOP,
      retries: 3,
      timeoutMin: 45,
      prompt: `Restore service. Check what is already rolled back, then roll back by the recipe (redeploy the previous version, revert the release, or turn the flag off) and confirm recovery against the baseline. File the fix forward as separate work for a person to prioritize, citing the pull request that caused it.
Report recovered with what you did and the evidence.`,
      next: { recovered: "done" },
    },
  },
} satisfies Factory;
