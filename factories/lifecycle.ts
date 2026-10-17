import type { Factory } from '../src/machine'

// The whole software lifecycle as one graph. A run enters at triage (or at a
// station, `lifecycle@incident`) and walks one of these loops:
//
//   build      plan → implement ⇄ verify ⇄ review (→ security) → release → deploy (you merge) → soak
//   small      triage → quick ⇄ check (→ security if flagged) → release → deploy (you merge)
//   optimize   baseline → plan → implement ⇄ verify (against the target) → … → soak     (abandon when disproved)
//   refactor   characterize → plan → implement ⇄ verify (pinned behavior holds) → … → soak
//   operate    soak regressed → rollback → plan (fix forward) → … → soak resolved → postmortem
//   incident   incident → rollback | plan → … → soak resolved → postmortem
//
// The standing sweeps (monitor, maintain, improve) are not here: they live in factories/sweeps.ts,
// their own factory, one pass per run, started by `factory sweep` on each sweep's own cadence
// (src/sweeps.ts). A pinned run from before claude-factory-8pc still loads this file's own copy of
// them if its factory.json holds one; see that bead for the move.
//
// The pull request is the one place a person must act. Deploy waits for a person to merge it and
// never merges itself, so nothing reaches the default branch or production without them.
// In a repo with beads, a run's bead is its epic: plan records the tasks as its children,
// implement works them, verify and review file findings as more, and release needs them all closed.
//
// `factory adopt <repo>` copies this file into the repo as .factory/lifecycle.ts. From then on the
// factory is the repo's code: improve's factory lens and postmortems file changes to it, and they ship
// like any change, through review and your merge. Each run follows the version its starting commit holds.

// The worker commands name params (below); the runner fills them in from a rig's --param, the
// environment's FACTORY_<NAME> (FACTORY_CLAUDE, FACTORY_EXEC_MODEL, ...) or these defaults.
const claude = (model: string) => `{claude} --dangerously-skip-permissions --model '{${model}}'`
const SONNET = claude('exec_model')
const OPUS = claude('judge_model')
const FABLE = claude('security_model')
// stations that read or change production need the laptop's kubectl, cluster access and network, which a
// rig's VM workers (--runner ax) do not have: they stay in herdr panes whatever the rig's runner
const LAPTOP = 'herdr'

const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Small commits whose messages say why. Run the formatter and linters on what you touch. Never skip, disable or weaken a test to get green.
- Never commit secrets. Only a person merges a pull request; only deploy and rollback touch production, and rollback alone may revert on the default branch; nobody force-pushes.
- Production is read-only for every station but deploy and rollback.
- Owner-only, even with a merge in hand: a hand-run change to a live system (kubectl apply, patch, scale, delete or rollout restart; a helm or terraform apply), an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential, secret or token change. Do one of these only when the bead's description, a person's own comment on it, or a [factory mail] from the manager says the person approved that exact step; a worker's own comment never counts as approval. Otherwise do every other step, then report blocked: "parked, waiting on: <the owner step and the exact command>". Reads, and watching a pipeline the person's merge started, stay allowed.
- Stay in scope: file anything else you find as separate work (see Tracking), at most three per station.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, pull request, deploy state) and never repeat an external action that already happened.
- Your report summary is the next station's whole briefing: concrete and complete, numbers over adjectives, links over descriptions.
- .factory/ is this factory's own definition: change it only in a run whose goal is to change it, check every edited file with \`factory check\` (see your brief) before committing, and keep a person's merge of the pull request as the gate before anything deploys.`

export default {
  name: 'lifecycle',
  start: 'triage',
  agent: SONNET,
  params: {
    claude: 'claude-smart --new --no-channels', // the Claude Code launcher
    exec_model: 'claude-sonnet-5[1m]', // execution
    judge_model: 'claude-opus-5-5[1m]', // planning, judgment, review
    security_model: 'claude-fable-5', // security and architecture
  },
  backoffSec: 60,
  maxSteps: 24,
  rules,
  nodes: {
    // ── intake ───────────────────────────────────────────────────────────────
    triage: {
      timeoutMin: 20,
      prompt: `Classify the goal and route it. Read enough of the repo (docs, layout, recent history, any issue or alert the goal cites) to decide; change nothing.
- build: a feature, a bug fix or any change whose intent is known
- small: a build that is docs-only, test-only, or a tiny fix (about 50 changed lines or fewer in 3 files or fewer, no new dependency, migration or public API change); the bead's label \`small\` asks for it. Never small when it is security-sensitive (auth, secrets, crypto, input parsing, permissions, infrastructure access), changes a factory definition (.factory/ or factories/), or the bead carries the label \`security\` or \`full\`; those are build. Bead type alone does not decide; type chore or a docs/test-only goal points to small.
- optimize: make something faster or cheaper (a latency, throughput, memory or cost goal)
- refactor: restructure code without changing behavior
- incident: production is broken or degraded now
- reject: unclear, already tracked (a run in \`factory status\`, an open issue), or not worth doing; say why
Summary: the goal restated as a testable outcome, its constraints, and the files and systems involved.`,
      next: {
        build: 'plan',
        small: 'quick',
        optimize: 'baseline',
        refactor: 'characterize',
        incident: 'incident',
        reject: { to: 'done', reject: true },
      },
    },

    // ── shaping: what to build, measured or pinned first ─────────────────────
    plan: {
      agent: OPUS,
      timeoutMin: 45,
      prompt: `Write the spec every later station works from: your summary is that spec. Cover:
1. Acceptance criteria, each one testable.
2. Design: the change, the files it touches, the alternatives you rejected and why.
3. Test plan: the failing tests implement writes first.
4. Risk: security, data, migrations, backward compatibility. Write "security-sensitive" when it touches auth, secrets, crypto, input parsing, permissions or infrastructure access.
5. Rollout and rollback: flags, migration order, how to undo it.
6. Observability: the metrics, logs or checks that prove it works in production; soak reads them.
7. Tasks: the work broken into small tasks, each one commit with its own check, in dependency order. Record them (see Tracking) and list them in the summary.
For an optimization, the target number and how verify measures it, from the baseline. For a refactor, the target structure and the invariants characterize pinned. After a rollback or an incident, plan the fix forward from what the journal learned. For a change to the factory itself (.factory/), the acceptance criteria say what future runs will do differently and how that shows in their journals.
Commit nothing but an architecture decision record, and only where the repo keeps them.`,
      next: { ready: 'implement' },
    },
    baseline: {
      runner: LAPTOP,
      timeoutMin: 60,
      prompt: `Measure before anyone optimizes. Build a reproducible measurement and commit it (a benchmark, a load script, a profiling recipe or a cost query):
- performance: latency percentiles, throughput, CPU and memory; profile to find where the time goes
- cost: what is spent and on what (resources requested against used, idle resources, storage, transfer, CI minutes, model tokens), from real billing or usage data, read-only
Report measured with the baseline numbers, the command that reproduces them, the hypotheses ranked by expected gain over effort, and a target; or nothing-to-gain, with the numbers, when no change is worth its risk.`,
      next: { measured: 'plan', 'nothing-to-gain': 'done' },
    },
    characterize: {
      timeoutMin: 60,
      prompt: `Pin today's behavior before anything moves. Write characterization tests around the code to refactor (inputs, outputs, errors, side effects, the public API), make them pass against the code as it is, and commit them. Change no production code.
Report pinned with the invariants the refactor must keep and the area's coverage.`,
      next: { pinned: 'plan' },
    },

    // ── the inner loop: build it, prove it, review it ────────────────────────
    implement: {
      timeoutMin: 120,
      prompt: `Build what the plan in the journal specifies, one task at a time in dependency order (see Tracking), closing each with its commit. Test first: write the failing test, watch it fail, make it pass. Failures and review findings come back as new tasks and in your inbox: fix every one and say how. A finding names an instance: grep for its siblings and fix the class, not the one line.
Before you report ready, do what review would: merge origin/main and resolve any conflict; for each new branch, error path and guard, break it and see a test fail; check each claim you wrote in a doc, ADR or docstring against the code, and run each command you documented exactly as written. Say in the summary that you did.
For an optimization: one hypothesis at a time, re-measured with the baseline's command. When the journal shows two attempts that missed the target, report abandon with what was learned. abandon is only that: it ends the run with nothing shipped. When what is left waits on a person's decision, mail the manager the question and wait for the answer.
For a refactor: no behavior change; the characterization tests stay untouched and green.`,
      next: { ready: 'verify', abandon: 'done' },
    },
    verify: {
      timeoutMin: 75,
      prompt: `Check the branch independently; trust no earlier report and change no code.
Run the full pipeline the repo defines: the build, every test suite, linters, type checks, and the security scanners it has (dependency audit, secret scan, static analysis). Check each acceptance criterion from the plan and say how you verified it. Then try to fail it as review would: \`git merge-tree\` it against origin/main (a conflict is red); break each new guard or comparison and see a test fail; check that each fixture can occur in real data, each claim in a changed doc matches the code, and each documented command runs as written. For an optimization, re-run the baseline's measurement and compare it with the target. For a refactor, confirm the characterization tests are unchanged and green. For a change to .factory/, run the factory check on every changed file.
Report green with the evidence, or red with a numbered list of every failure and how to reproduce it, each also recorded as a bug task of this run (see Tracking).`,
      next: { green: 'review', red: 'implement' },
    },
    review: {
      agent: OPUS,
      timeoutMin: 45,
      rounds: 3, // a fourth round of changes is held for the manager: the loop is not converging
      prompt: `Review the branch's diff against the default branch as you would before a merge: correctness, the tests' quality, simplicity, naming, error handling, backward compatibility, migrations and observability. Change no code.
A change to .factory/ changes how every later run works: read it as a policy change, not a refactor.
Post the review on the pull request: push the branch and open it as a draft if this run has none yet, then \`gh pr review --comment\` with the verdict and every finding at its file and line (GitHub refuses approve and request-changes on a pull request the same account opened).
Report approve; changes with a numbered list of everything to fix, found in one pass over the whole diff (including each earlier fix's sibling sites), so the next round does not surface what this one could have, each also recorded as a task of this run (see Tracking); or security when everything else is approved and the plan or the diff is security-sensitive, or when it changes .factory/ in a way that removes a gate, lets more run unattended, or raises a limit or a cadence. Include the pull request link. For security, also include \`git diff --stat origin/main...HEAD\` (at most 60 files, then "+N more") and one line per changed area, so a retry after a timeout can work from that instead of rereading the whole branch.`,
      next: { approve: 'release', changes: 'implement', security: 'security' },
    },
    security: {
      agent: FABLE,
      timeoutMin: 45,
      // claude-factory-3t2: 5 of 65 security visits timed out at 45 min, all on one large rig. The
      // retry right after a timeout gets 75 min and a narrower brief, instead of the same 45 min
      // and the whole branch again; a 2nd timeout in a row still goes to isRepeatFail's stuck+mail.
      onTimeout: {
        timeoutMin: 75,
        prompt: `Do not re-read the whole branch. Start from the changed-files list and the diff summary in review's or check's report in your Inbox. If there is none, run \`git diff --stat origin/main...HEAD\`. Read the hunks of the riskiest files first (auth, input parsing, secrets, permissions, .factory/). Post each finding on the pull request as you find it. Report before the limit, and name the files you did not read.`,
      },
      prompt: `Security review of the branch's diff, thinking as an attacker: authentication and authorization, input validation and injection, secrets, crypto, SSRF, deserialization, dependency risk, infrastructure permissions, sensitive data in logs. Check it against the plan's risk section, or triage's summary on a small run. Change no code.
Post it on the pull request the way review does.
Report approve, or changes with each finding, its severity and its fix, each also recorded as a bug task of this run (see Tracking).`,
      next: { approve: 'release', changes: 'implement' },
    },

    // ── the small route: a tiny, docs-only or test-only change skips plan and a separate review ──────
    quick: {
      timeoutMin: 60,
      prompt: `Build what triage's summary in the journal says, with no plan. Test first when code changes. Merge origin/main, run the formatter and the tests of what you touched, commit.
Fix every finding check sends back and say how, closing each task check filed, with its commit (see Tracking), as implement does for review's findings.
If the work proves bigger than small (more files, a security-sensitive surface, a new dependency, a design choice), report full with why, and plan takes it.`,
      next: { ready: 'check', full: 'plan', abandon: 'done' },
    },
    check: {
      agent: OPUS,
      timeoutMin: 60,
      rounds: 3, // a fourth round of changes is held for the manager: the loop is not converging
      prompt: `One station does both verify and review for a small change. Trust no earlier report.
Run the repo's full pipeline: the build, every test suite, linters, type checks, and the security scanners it has (dependency audit, secret scan, static analysis). Then try to fail it: \`git merge-tree\` it against origin/main (a conflict is red); break each new guard, branch and error path and see a test fail; check that each claim in a changed doc or docstring matches the code, and each documented command runs as written. For a change to .factory/, run the factory check on every changed file.
Then review the diff as you would before a merge: correctness, the tests' quality, simplicity, naming, backward compatibility. A change to .factory/ changes how every later run works: read it as a policy change, not a refactor.
Push the branch and open it as a draft pull request if this run has none yet, then \`gh pr review --comment\` with the verdict and every finding at its file and line. Leave the pull request a draft; release marks it ready.
Report approve; or changes with one numbered list of every failure and finding, found in one pass over the whole diff, each also recorded as a task of this run (see Tracking); or security when everything else is approved and the diff or the bead is security-sensitive (auth, secrets, crypto, input parsing, permissions, infrastructure access, or the label \`security\`), or the diff changes .factory/ in a way that removes a gate, lets more run unattended, or raises a limit or a cadence. Include the pull request link. For security, also include \`git diff --stat origin/main...HEAD\` (at most 60 files, then "+N more") and one line per changed area, so a retry after a timeout can work from that instead of rereading the whole branch.`,
      next: { approve: 'release', changes: 'quick', security: 'security' },
    },

    // ── the outer loop: ship it, watch it, undo it ───────────────────────────
    release: {
      timeoutMin: 75,
      prompt: `Prepare the release. Every task of this run must be closed (see Tracking); if any is open, report red naming them. Rebase onto the latest default branch (re-run the tests if anything moved), add the changelog entry and the version bump the repo's conventions call for, push the branch and update the pull request review opened (open one if there is none) and mark it ready for review. Its description carries the plan's summary (triage's on a small run), the verification evidence and the rollback plan. Wait for CI and read every failing check.
Report ready with the pull request link, the CI status and exactly what shipping will do; or red with the failures.`,
      next: { ready: 'deploy', red: 'implement' },
    },
    deploy: {
      runner: LAPTOP,
      retries: 1,
      timeoutMin: 90,
      // the arrival carries the pull request link (release always names it): the tick waits for the
      // merge, the close, or new activity on that pull request, and spawns no worker until then
      awaitsPr: true,
      prompt: `Ship the pull request once a person has merged it: their merge is the approval, and you never merge it yourself. First check what is already done (merged? tagged? deployed?) and do only what is not.
A merge approves the change it carries, not an owner-only step (see House rules): a hand-run kubectl or helm apply, an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential change. Do every other step, then park with "parked, waiting on: <the owner step and the exact command>" and a \`Question:\` line asking the person to run it or to approve you running it.
Not merged yet: if a person requested changes or left comments asking for them since release, report changes with every point they raised, each also recorded as a task of this run (see Tracking); if a person closed it unmerged, report hold with their reason, if any; otherwise report blocked with the pull request link and what it waits for (the merge, or a required check or queue), so the person is asked; you are woken when it changes.
Merged: record the production baseline it will be compared against (error rate, latency, saturation and cost signals) from the window just before the merge, since a GitOps repo may already be rolling it out, tag or publish when the repo's conventions call for it, run or watch the deploy pipeline to the end, verify the rollout (for example kubectl rollout status) and run a smoke check.
Report deployed with the version, the time and the baseline; published when the release has no running service to watch (a library, a CLI, a docs-only or test-only change, or a change to .factory/ only, which runs started from now on follow); failed when the rollout did not complete.`,
      next: {
        deployed: { to: 'soak', delayMin: 15 },
        published: 'done',
        failed: 'rollback',
        changes: 'implement',
        hold: { to: 'done', defer: true },
      },
    },
    soak: {
      runner: LAPTOP,
      timeoutMin: 30,
      prompt: `The release has run for a soak period. Compare production now with the baseline deploy recorded: error rates and new error types, latency percentiles, saturation, SLO burn, logs, the plan's own observability checks and, for an optimization, the target metric. Read-only.
Report healthy when it holds, or resolved instead when this run began with an incident or went through a rollback, so it gets a postmortem; unsure to soak one more period (at most twice in a row); regressed, with the evidence, when it got worse.`,
      next: {
        healthy: 'done',
        resolved: 'postmortem',
        unsure: { to: 'soak', delayMin: 15 },
        regressed: 'rollback',
      },
    },
    rollback: {
      runner: LAPTOP,
      retries: 3,
      timeoutMin: 45,
      prompt: `Restore service. Check what is already rolled back, then roll back the release your inbox names the repo's way (redeploy the previous version, revert the merge, or turn the flag off) and confirm recovery against the baseline.
Report recovered with what you did, the evidence of recovery and everything learned about the cause: plan takes it from there to fix forward.`,
      next: { recovered: 'plan' },
    },

    // ── incidents ────────────────────────────────────────────────────────────
    incident: {
      runner: LAPTOP,
      agent: OPUS,
      timeoutMin: 30,
      prompt: `Production is degraded. Diagnose, read-only: the impact and blast radius, when it started, what changed then (deploys, config, dependencies, traffic), and the evidence in metrics, logs and traces.
Report rollback when a recent release caused it (name it and the version to return to); fix when it needs a code or config change (say how urgent, and what mitigates it meanwhile); noise when it is a false alarm (file a run to tune the alert).`,
      next: { rollback: 'rollback', fix: 'plan', noise: 'done' },
    },
    postmortem: {
      agent: OPUS,
      timeoutMin: 45,
      prompt: `Write the blameless postmortem from the journal: impact, timeline, root cause, contributing factors, what went well, and the action items. File each action item that needs work (missing tests, alerts, runbooks, guardrails) as separate work for a person to prioritize, except a guardrail without which the incident can recur this week, which starts on its own. When the factory itself let this happen (a station that missed it, a prompt, a rule, a gate), file the change to .factory/ the same way, for a person to prioritize. Your summary is the postmortem.`,
      next: { filed: 'done' },
    },
  },
} satisfies Factory
