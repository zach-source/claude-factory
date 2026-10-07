import type { Factory } from '../src/machine'

// The whole software lifecycle as one graph. A run enters at triage (or at a
// station, `lifecycle@incident`) and walks one of these loops:
//
//   build      plan → implement ⇄ verify ⇄ review (→ security) → release → approve → deploy → soak
//   optimize   baseline → plan → implement ⇄ verify (against the target) → … → soak     (abandon when disproved)
//   refactor   characterize → plan → implement ⇄ verify (pinned behavior holds) → … → soak
//   operate    soak regressed → rollback → plan (fix forward) → … → soak resolved → postmortem
//   incident   incident → rollback | plan → … → soak resolved → postmortem
//   sweeps     monitor (30 min) · maintain (daily) · improve (daily, rotating refactor/performance/cost)
//              loop forever and file what they find as separate work
//
// approve is the one place a person must act: nothing merges or deploys without them.
// In a repo with beads, a run's bead is its epic: plan records the tasks as its children,
// implement works them, verify and review file findings as more, release needs them all
// closed, and sweeps file to the backlog, where `factory` labels what starts on its own.
//
// `factory adopt <repo>` copies this file into the repo as .factory/lifecycle.ts. From then on the
// factory is the repo's code: improve's factory lens and postmortems file changes to it, and they ship
// like any change, through review and approve. Each run follows the version its starting commit holds.

const claude = (model?: string) =>
  `claude-smart --new --no-channels --dangerously-skip-permissions${model ? ` --model '${model}'` : ''}`
const SONNET = claude('claude-sonnet-5[1m]') // execution
const OPUS = claude() // claude-smart's default model: planning, judgment, review
const FABLE = claude('claude-fable-5') // security and architecture

const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Small commits whose messages say why. Run the formatter and linters on what you touch. Never skip, disable or weaken a test to get green.
- Never commit secrets. Only deploy and rollback touch the default branch or production; nobody force-pushes.
- Production is read-only for every station but deploy and rollback.
- Stay in scope: file anything else you find as separate work (see Tracking), at most three per station.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, pull request, deploy state) and never repeat an external action that already happened.
- Your report summary is the next station's whole briefing: concrete and complete, numbers over adjectives, links over descriptions.
- .factory/ is this factory's own definition: change it only in a run whose goal is to change it, check every edited file with \`factory check\` (see your brief) before committing, and keep the approve gate before anything merges or deploys.`

export default {
  name: 'lifecycle',
  start: 'triage',
  agent: SONNET,
  backoffSec: 60,
  maxSteps: 24,
  rules,
  nodes: {
    // ── intake ───────────────────────────────────────────────────────────────
    triage: {
      timeoutMin: 20,
      prompt: `Classify the goal and route it. Read enough of the repo (docs, layout, recent history, any issue or alert the goal cites) to decide; change nothing.
- build: a feature, a bug fix or any change whose intent is known
- optimize: make something faster or cheaper (a latency, throughput, memory or cost goal)
- refactor: restructure code without changing behavior
- incident: production is broken or degraded now
- monitor, maintain or improve: start that standing sweep (the goal names it)
- reject: unclear, already tracked (a run in \`factory status\`, an open issue), or not worth doing; say why
Summary: the goal restated as a testable outcome, its constraints, and the files and systems involved.`,
      next: {
        build: 'plan',
        optimize: 'baseline',
        refactor: 'characterize',
        incident: 'incident',
        monitor: 'monitor',
        maintain: 'maintain',
        improve: 'improve',
        reject: 'done',
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
      prompt: `Review the branch's diff against the default branch as you would before a merge: correctness, the tests' quality, simplicity, naming, error handling, backward compatibility, migrations and observability. Change no code.
A change to .factory/ changes how every later run works: read it as a policy change, not a refactor.
Post the review on the pull request: push the branch and open it as a draft if this run has none yet, then \`gh pr review --comment\` with the verdict and every finding at its file and line (GitHub refuses approve and request-changes on a pull request the same account opened).
Report approve; changes with a numbered list of everything to fix, found in one pass over the whole diff (including each earlier fix's sibling sites), so the next round does not surface what this one could have, each also recorded as a task of this run (see Tracking); or security when everything else is approved and the plan or the diff is security-sensitive, or when it changes .factory/ in a way that removes a gate, lets more run unattended, or raises a limit or a cadence. Include the pull request link.`,
      next: { approve: 'release', changes: 'implement', security: 'security' },
    },
    security: {
      agent: FABLE,
      timeoutMin: 45,
      prompt: `Security review of the branch's diff, thinking as an attacker: authentication and authorization, input validation and injection, secrets, crypto, SSRF, deserialization, dependency risk, infrastructure permissions, sensitive data in logs. Check it against the plan's risk section. Change no code.
Post it on the pull request the way review does.
Report approve, or changes with each finding, its severity and its fix, each also recorded as a bug task of this run (see Tracking).`,
      next: { approve: 'release', changes: 'implement' },
    },

    // ── the outer loop: ship it, watch it, undo it ───────────────────────────
    release: {
      timeoutMin: 75,
      prompt: `Prepare the release. Every task of this run must be closed (see Tracking); if any is open, report red naming them. Rebase onto the latest default branch (re-run the tests if anything moved), add the changelog entry and the version bump the repo's conventions call for, push the branch and update the pull request review opened (open one if there is none) and mark it ready for review. Its description carries the plan's summary, the verification evidence and the rollback plan. Wait for CI and read every failing check.
Report ready with the pull request link, the CI status and exactly what shipping will do; or red with the failures.`,
      next: { ready: 'approve', red: 'implement' },
    },
    approve: {
      gate: true,
      prompt:
        'Ship it? Read the pull request and the evidence. ship merges and deploys it; changes sends it back to implement with your note; hold ends the run, leaves the pull request open and defers its bead until you undefer it.',
      next: { ship: 'deploy', changes: 'implement', hold: { to: 'done', defer: true } },
    },
    deploy: {
      retries: 1,
      timeoutMin: 90,
      prompt: `Ship the approved pull request the repo's way. First check what is already done (merged? tagged? deployed?) and do only what is not.
Before the change lands, record the production baseline it will be compared against: error rate, latency, saturation and cost signals. Then merge, tag or publish, run or watch the deploy pipeline to the end, verify the rollout (for example kubectl rollout status) and run a smoke check.
Report deployed with the version, the time and the baseline; published when the release has no running service to watch (a library, a CLI, a change to .factory/ only, which runs started from now on follow); failed when the rollout did not complete.
When the pull request cannot land yet because the repo wants something only a person can give (an approving review, an admin merge, a required check a human runs), or a queue or another release holds it, do not report failed: nothing has reached production. Report blocked with the pull request link and exactly what it waits for, so the person is asked; you are woken to check again.`,
      next: { deployed: { to: 'soak', delayMin: 15 }, published: 'done', failed: 'rollback' },
    },
    soak: {
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
      retries: 3,
      timeoutMin: 45,
      prompt: `Restore service. Check what is already rolled back, then roll back the release your inbox names the repo's way (redeploy the previous version, revert the merge, or turn the flag off) and confirm recovery against the baseline.
Report recovered with what you did, the evidence of recovery and everything learned about the cause: plan takes it from there to fix forward.`,
      next: { recovered: 'plan' },
    },

    // ── incidents ────────────────────────────────────────────────────────────
    incident: {
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

    // ── standing sweeps: each loops on a timer and files work as runs ────────
    monitor: {
      timeoutMin: 20,
      prompt: `One pass of production watch, read-only: SLOs and error budgets, alert states, error rates and new error types, latency, saturation, failing jobs, certificate and quota expiry, and the health of recent deploys. Compare with the previous passes in the journal.
File what hurts users now as separate work that starts on its own at the incident station, at priority 0. File defects that can wait as separate work for a person to prioritize. Never file what is already tracked or running.
Report watching with the key numbers, which the next pass compares against; stop only when the goal says to.`,
      next: { watching: { to: 'monitor', delayMin: 30 }, stop: 'done' },
    },
    maintain: {
      timeoutMin: 60,
      prompt: `One pass of maintenance. Look for, most urgent first: security advisories on dependencies and base images; failing or flaky tests and CI jobs; deprecated APIs and end-of-life runtimes; dependency updates (patch and minor batched, majors one at a time); issues labeled \`factory\` in the tracker; docs that drifted from the code.
File each item worth doing as separate work, at most five per pass, skipping what is already tracked: security advisories start on their own at the plan station; everything else is for a person to prioritize.
Report again with what you filed and what you skipped on purpose, which the next pass reads; stop only when the goal says to.`,
      next: { again: { to: 'maintain', delayMin: 1440 }, stop: 'done' },
    },
    improve: {
      agent: OPUS,
      timeoutMin: 90,
      prompt: `One pass of continuous improvement, through the next lens in rotation after the journal's last pass: refactor, then performance, then cost, then the factory itself.
- refactor: hotspots where churn meets complexity, duplication, modules too large to change safely
- performance: the slowest endpoints, queries and jobs in production telemetry; slow tests and builds
- cost: over-provisioned or idle resources, expensive queries, storage and transfer, CI minutes, model token spend, this factory's own runs included (retries, loops, the model each station uses)
- the factory itself: how recent runs went, from \`factory status\` and, with beads, the closed factory beads' comments (bd list -l factory --status closed, bd comments <id>): stations that fail or retry often, implement ⇄ verify or review loops a better plan or prompt would have avoided, stuck runs, gates that are always answered the same way, timeouts, cadences and models that cost more than they return. Each finding is one proposed change to .factory/, with the journals that show it
Rank what you find by expected gain over effort, with evidence, and file the top items as separate work for a person to prioritize, set to start at the characterize station (refactor), the baseline station (performance, cost) or the plan station (the factory itself), at most three per pass, skipping what is already tracked.
Report again with the lens, the findings and what you filed; stop only when the goal says to.`,
      next: { again: { to: 'improve', delayMin: 1440 }, stop: 'done' },
    },
  },
} satisfies Factory
