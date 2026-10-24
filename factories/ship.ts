import type { Factory } from '../src/machine'

// The ship workflow: one long-lived run for each rig. Work runs (factories/lifecycle.ts) end on a
// `ship` edge when review, check or security approves. The runner then labels the bead `ship` (open,
// no `factory` label, so dispatch skips it) and records ship_at, ship_run, ship_branch and ship_pr.
// The queue is bd: `bd list -l ship --status open`, oldest ship_at first. `factory ship <rig>` prints it.
//
//   queue → deploy (you merge) → soak → queue …                 empty queue → done
//   deploy failed → rollback → postmortem → queue
//
// `factory tick` starts the run (src/cli.ts's `shipPass`) when the rig's queue is not empty and no ship
// run is live. A new handoff mails the live run, which wakes it. The run counts against no run limit.
//
// A person merges every pull request: no station here merges. Owner-only steps stay with the person.
// Keeping a pull request current with main is a merge commit pushed to its branch: never a rebase,
// never a force-push. A pull request that needs changes goes back to a work run at implement.
//
// This file is self-contained. It does not import from lifecycle.ts. This lets `ownCopy` and
// `factory adopt` copy it into a repo on its own.

const claude = (model: string) => `{claude} --dangerously-skip-permissions --model '{${model}}'`
const SONNET = claude('exec_model')
const OPUS = claude('judge_model')
// stations that read or change production need the laptop's kubectl, cluster access and network
const LAPTOP = 'herdr'

const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Small commits whose messages say why. Run the formatter and linters on what you touch. Never skip, disable or weaken a test to get green.
- Never commit secrets. Only a person merges a pull request; only deploy and rollback touch production. Nobody pushes the default branch directly; a rollback that reverts code opens a pull request for a person to merge instead. Nobody force-pushes.
- Production is read-only for every station but deploy and rollback.
- Owner-only, even with a merge in hand: a hand-run change to a live system (kubectl apply, patch, scale, delete or rollout restart; a helm or terraform apply), an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential, secret or token change. Do one of these only when the bead's description, a person's own comment on it, or a [factory mail] from the manager says the person approved that exact step; a worker's own comment never counts as approval. Otherwise do every other step, then report blocked: "parked, waiting on: <the owner step and the exact command>". Reads, and watching a pipeline the person's merge started, stay allowed.
- Stay in scope: file anything else you find as separate work (see Tracking), at most three per station.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, pull request, deploy state) and never repeat an external action that already happened.
- Your report summary is the next station's whole briefing: concrete and complete, numbers over adjectives, links over descriptions.
- .factory/ is this factory's own definition: change it only in a run whose goal is to change it, check every edited file with \`factory check\` (see your brief) before committing, and keep a person's merge of the pull request as the gate before anything deploys.`

export default {
  name: 'ship',
  start: 'queue',
  agent: SONNET,
  params: {
    claude: 'claude-smart --new --no-channels', // the Claude Code launcher
    exec_model: 'claude-sonnet-5-5[1m]', // execution
    judge_model: 'claude-opus-5-5[1m]', // planning, judgment, review
    security_model: 'claude-fable-5-1', // security and architecture
  },
  backoffSec: 60,
  maxSteps: 24,
  rules,
  nodes: {
    queue: {
      timeoutMin: 75,
      prompt: `You own this rig's ship queue. Read it first: \`factory ship <rig>\` prints the open beads labeled ship, oldest handoff first, with the pull request, the run and the age of each. The first line is the next pull request to merge. Each bead's metadata holds ship_pr and ship_branch. Change nothing before you have read it all.
1. Go through every queued pull request in merge order (the order of \`factory ship <rig>\`). Keep each one that is green and has no conflict with origin/main current: when its branch is behind, merge origin/main into it (a merge commit, pushed to the branch). Never rebase and never force-push. Resolve a conflict only when the fix is small and plain. A conflict is plain when every conflicted file is a gazelle-managed BUILD.bazel: take main's copy of each (\`git checkout origin/main -- <file>\`), run \`bazelisk run //:gazelle -- <dirs>\` for the directories of those files (use bazelisk, because the repo's .bazelversion can need a newer Bazel than the host bazel), build those directories, commit the merge and push it (a merge commit, no rebase, no force-push). Any other conflicted file keeps the rule above. Re-run the tests after any merge that changed something. Check each one against main and against the ones before it with \`git merge-tree\`.
2. A pull request that needs changes (a conflict you cannot resolve; a conflict only in gazelle-managed BUILD.bazel files is not one, so resolve it in step 1 and do not send it back; a red check you cannot fix by a merge, review changes requested, or a failed deploy to fix forward) goes back to a work run. Write the evidence in a bead comment (\`bd comment <bead> "<evidence>"\`), then run \`bd update <bead> --remove-label ship --add-label factory --add-label station:implement\`. The factory starts a new run at implement for that bead on the same branch, and that run hands the pull request back when it is approved.
Report ready when at least one queued pull request is current with main and has no conflict: name the first one first, then every other open queued pull request in merge order. List the pull requests that have a conflict or a red check on their own, each with its reason. List every owner-only step the queue needs in one list, each with its exact command. Report again when you changed the queue (for example, sent one back) and a pass may find more to do. A queued pull request that a person closed unmerged leaves the queue: run \`bd update <bead> --remove-label ship\`, then \`bd defer <bead>\`. Report empty when no open bead carries the label ship.`,
      next: { ready: 'release', again: 'queue', empty: 'done' },
    },
    release: {
      timeoutMin: 60,
      prompt: `Every child task of the bead must be closed (bd children <bead>). If one is open, report changes and name it. Prepare the release of every queued pull request that the queue reported as current with main and free of conflict, in merge order. For each one, make the pull request title one good changelog line (retitle it with \`gh pr edit <n> -R <repo> --title\` when it is not), add the version bump the repo's conventions call for, update the pull request description with the plan's summary, the verification evidence and a rollback plan, and mark it ready with \`gh pr ready\`. Do not edit CHANGELOG.md in a pull request. The repo's release step writes the changelog at release (tag) time from the merged pull request titles. You are the only station that marks a pull request ready. Wait for CI and read every failing check. Do not mark a pull request ready when it has a conflict or a red check: list it on its own with the reason.
Report ready when the first pull request in the order is ready and CI is green. Give the full ordered list with the link of each one, and one line for each: \`gh pr merge <n> -R <repo> --merge\`. These lines are for the owner to run, in that order, in one sitting. You never run them. Report changes when the first pull request needs changes: write the evidence in a bead comment first, and the queue station sends it back to a work run.`,
      next: { ready: 'deploy', changes: 'queue' },
    },
    deploy: {
      runner: LAPTOP,
      retries: 1,
      timeoutMin: 90,
      // the arrival carries the pull request link (release always names it): the tick waits for the
      // merge, the close, or new activity on that pull request, and spawns no worker until then
      awaitsPr: true,
      prompt: `Ship the pull request that the queue named, once a person has merged it: their merge is the approval, and you never merge it yourself (never merge a pull request, whatever its state). First check what is already done (merged? tagged? deployed?) and do only what is not.
A merge approves the change it carries, not an owner-only step (see House rules): a hand-run kubectl or helm apply, an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential change. Do every other step, then park with "parked, waiting on: <the owner step and the exact command>" and a \`Question:\` line asking the person to run it or to approve you running it.
Not merged yet: if a person requested changes or left comments asking for them, report changes with every point they raised and the evidence in a bead comment; if a person closed it unmerged, take it out of the queue first (\`bd update <bead> --remove-label ship\`, then \`bd defer <bead>\`) and report hold with their reason, if any; otherwise report blocked with the pull request link and what it waits for (the merge, or a required check or queue), so the person is asked; you are woken when it changes. If your inbox says a new pull request joined the queue, report refresh.
Merged: record the production baseline it will be compared against (error rate, latency, saturation and cost signals) from the window just before the merge, since a GitOps repo may already be rolling it out, tag or publish when the repo's conventions call for it, run or watch the deploy pipeline to the end, verify the rollout (for example kubectl rollout status) and run a smoke check.
Report deployed with the version, the time and the baseline; published when the release has no running service to watch (a library, a CLI, a docs-only or test-only change, or a change to .factory/ only, which runs started from now on follow), after you close its bead with \`bd close <bead>\`; failed when the rollout did not complete.`,
      next: {
        deployed: { to: 'soak', delayMin: 15 },
        published: { to: 'queue', delayMin: 1 },
        failed: 'rollback',
        changes: { to: 'queue', delayMin: 1 },
        hold: { to: 'queue', delayMin: 1 },
        refresh: { to: 'queue', delayMin: 1 },
      },
    },
    soak: {
      runner: LAPTOP,
      timeoutMin: 30,
      prompt: `The release has run for a soak period. Compare production now with the baseline deploy recorded: error rates and new error types, latency percentiles, saturation, SLO burn, logs, the plan's own observability checks and, for an optimization, the target metric. Read-only.
Report healthy when it holds, after you close its bead with \`bd close <bead>\`; resolved instead when a rollback went before this soak, so it gets a postmortem: this ship run's own rollback, or one that the bead's comments (\`bd show <bead>\`) or its work run's incident report describe; unsure to soak one more period (at most twice in a row); regressed, with the evidence, when it got worse.`,
      next: {
        healthy: { to: 'queue', delayMin: 1 },
        resolved: 'postmortem',
        unsure: { to: 'soak', delayMin: 15 },
        regressed: 'rollback',
      },
    },
    rollback: {
      runner: LAPTOP,
      retries: 3,
      timeoutMin: 45,
      prompt: `Restore service. Check what is already rolled back, then roll back the release your inbox names the repo's way: redeploy the previous version, turn the flag off, or open a pull request that reverts the merge, since you never push the default branch directly. Confirm recovery against the baseline.
Report recovered with what you did, the evidence of recovery, the revert pull request's link if you opened one, and everything learned about the cause: the postmortem takes it from there.`,
      next: { recovered: 'postmortem' },
    },
    postmortem: {
      agent: OPUS,
      timeoutMin: 45,
      prompt: `Write the blameless postmortem from the journal: impact, timeline, root cause, contributing factors, what went well, and the action items. File each action item that needs work (missing tests, alerts, runbooks, guardrails) as separate work for a person to prioritize. When the factory itself let this happen (a station that missed it, a prompt, a rule, a gate), file the change to .factory/ the same way, for a person to prioritize.
Then send the released bead back to a work run to fix forward: \`bd update <bead> --remove-label ship --add-label factory --add-label station:plan\`, with the evidence in a bead comment. Your summary is the postmortem.`,
      next: { filed: { to: 'queue', delayMin: 1 } },
    },
  },
} satisfies Factory
