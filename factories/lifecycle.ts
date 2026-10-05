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
//              loop forever and file what they find as runs of their own
//
// approve is the one place a person must act: nothing merges or deploys without them.

const claude = (model?: string) =>
  `claude-smart --new --no-channels --dangerously-skip-permissions${model ? ` --model '${model}'` : ''}`
const SONNET = claude('claude-sonnet-5[1m]') // execution
const OPUS = claude() // claude-smart's default model: planning, judgment, review
const FABLE = claude('claude-fable-5') // security and architecture

const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Small commits whose messages say why. Run the formatter and linters on what you touch. Never skip, disable or weaken a test to get green.
- Never commit secrets. Only deploy and rollback touch the default branch or production; nobody force-pushes.
- Production is read-only for every station but deploy and rollback.
- Stay in scope: file anything else you find as a run of its own (see Reporting), at most three per station.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, pull request, deploy state) and never repeat an external action that already happened.
- Your report summary is the next station's whole briefing: concrete and complete, numbers over adjectives, links over descriptions.`

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
- reject: unclear, already covered by a run in \`factory status\`, or not worth doing; say why
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
For an optimization, the target number and how verify measures it, from the baseline. For a refactor, the target structure and the invariants characterize pinned. After a rollback or an incident, plan the fix forward from what the journal learned.
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
      prompt: `Build what the plan in the journal specifies. Test first: write the failing test, watch it fail, make it pass. If your inbox holds failures or review findings, fix every one and say how.
For an optimization: one hypothesis at a time, re-measured with the baseline's command. When the journal shows two attempts that missed the target, report abandon with what was learned.
For a refactor: no behavior change; the characterization tests stay untouched and green.`,
      next: { ready: 'verify', abandon: 'done' },
    },
    verify: {
      timeoutMin: 60,
      prompt: `Check the branch independently; trust no earlier report and change no code.
Run the full pipeline the repo defines: the build, every test suite, linters, type checks, and the security scanners it has (dependency audit, secret scan, static analysis). Check each acceptance criterion from the plan and say how you verified it. For an optimization, re-run the baseline's measurement and compare it with the target. For a refactor, confirm the characterization tests are unchanged and green.
Report green with the evidence, or red with a numbered list of every failure and how to reproduce it.`,
      next: { green: 'review', red: 'implement' },
    },
    review: {
      agent: OPUS,
      timeoutMin: 45,
      prompt: `Review the branch's diff against the default branch as you would before a merge: correctness, the tests' quality, simplicity, naming, error handling, backward compatibility, migrations and observability. Change no code.
Report approve; changes with a numbered list of exactly what to fix; or security when everything else is approved and the plan or the diff is security-sensitive.`,
      next: { approve: 'release', changes: 'implement', security: 'security' },
    },
    security: {
      agent: FABLE,
      timeoutMin: 45,
      prompt: `Security review of the branch's diff, thinking as an attacker: authentication and authorization, input validation and injection, secrets, crypto, SSRF, deserialization, dependency risk, infrastructure permissions, sensitive data in logs. Check it against the plan's risk section. Change no code.
Report approve, or changes with each finding, its severity and its fix.`,
      next: { approve: 'release', changes: 'implement' },
    },

    // ── the outer loop: ship it, watch it, undo it ───────────────────────────
    release: {
      timeoutMin: 60,
      prompt: `Prepare the release. Rebase onto the latest default branch (re-run the tests if anything moved), add the changelog entry and the version bump the repo's conventions call for, push the branch and open a pull request, or update the one this run already opened. Its description carries the plan's summary, the verification evidence and the rollback plan. Wait for CI and read every failing check.
Report ready with the pull request link, the CI status and exactly what shipping will do; or red with the failures.`,
      next: { ready: 'approve', red: 'implement' },
    },
    approve: {
      gate: true,
      prompt:
        'Ship it? Read the pull request and the evidence. ship merges and deploys it; changes sends it back to implement with your note; hold ends the run and leaves the pull request open.',
      next: { ship: 'deploy', changes: 'implement', hold: 'done' },
    },
    deploy: {
      retries: 1,
      timeoutMin: 90,
      prompt: `Ship the approved pull request the repo's way. First check what is already done (merged? tagged? deployed?) and do only what is not.
Before the change lands, record the production baseline it will be compared against: error rate, latency, saturation and cost signals. Then merge, tag or publish, run or watch the deploy pipeline to the end, verify the rollout (for example kubectl rollout status) and run a smoke check.
Report deployed with the version, the time and the baseline; published when the release has no running service to watch (a library, a CLI); failed when the rollout did not complete.`,
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
      prompt: `Write the blameless postmortem from the journal: impact, timeline, root cause, contributing factors, what went well, and the action items. File each action item that needs work as a run of its own (missing tests, alerts, runbooks, guardrails). If the factory itself should change (a station, a prompt, a rule), mail the manager the change. Your summary is the postmortem.`,
      next: { filed: 'done' },
    },

    // ── standing sweeps: each loops on a timer and files work as runs ────────
    monitor: {
      timeoutMin: 20,
      prompt: `One pass of production watch, read-only: SLOs and error budgets, alert states, error rates and new error types, latency, saturation, failing jobs, certificate and quota expiry, and the health of recent deploys. Compare with the previous passes in the journal.
File what hurts users now as an incident run (factory path + "@incident"); file defects that can wait as build runs ("@plan"). Never file what \`factory status\` already shows.
Report watching with the key numbers, which the next pass compares against; stop only when the goal says to.`,
      next: { watching: { to: 'monitor', delayMin: 30 }, stop: 'done' },
    },
    maintain: {
      timeoutMin: 60,
      prompt: `One pass of maintenance. Look for, most urgent first: security advisories on dependencies and base images; failing or flaky tests and CI jobs; deprecated APIs and end-of-life runtimes; dependency updates (patch and minor batched, majors one at a time); issues labeled \`factory\` in the tracker; docs that drifted from the code.
File each item worth doing as a run of its own ("@plan" when its intent is clear), at most five per pass, skipping what \`factory status\` already shows.
Report again with what you filed and what you skipped on purpose, which the next pass reads; stop only when the goal says to.`,
      next: { again: { to: 'maintain', delayMin: 1440 }, stop: 'done' },
    },
    improve: {
      agent: OPUS,
      timeoutMin: 90,
      prompt: `One pass of continuous improvement, through the next lens in rotation after the journal's last pass: refactor, then performance, then cost.
- refactor: hotspots where churn meets complexity, duplication, modules too large to change safely
- performance: the slowest endpoints, queries and jobs in production telemetry; slow tests and builds
- cost: over-provisioned or idle resources, expensive queries, storage and transfer, CI minutes, model token spend, this factory's own runs included (retries, loops, the model each station uses)
Rank what you find by expected gain over effort, with evidence, and file the top items as runs ("@characterize" for a refactor, "@baseline" for performance or cost), at most three per pass, skipping what \`factory status\` already shows. Mail the manager any change to the factory itself.
Report again with the lens, the findings and what you filed; stop only when the goal says to.`,
      next: { again: { to: 'improve', delayMin: 1440 }, stop: 'done' },
    },
  },
} satisfies Factory
