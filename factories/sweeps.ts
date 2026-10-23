import type { Factory } from '../src/machine'

// The standing sweeps. `factory tick` starts each one on its own cadence (src/sweeps.ts, cli.ts's
// `sweep()`). lifecycle.ts does not run them. Each node here is one pass. It starts on its own timer,
// for each rig that enables it (`everyMin`, checked in `src/sweeps.ts`'s `sweepNames` and `dueSweeps`).
// A pass is one run. It goes straight to `done`. The cadence lives in `sweep()`, not in a self-loop.
//
//   monitor   production watch, read-only, every 30 min, on a rig with a `--slo` command set
//   ci        red main-branch CI, every 2 h; a run starts only when `sweep()` finds a new red
//   flakes    flaky tests of the last 7 days, once a week; a run starts only when it finds a candidate
//   advisories  dependency and base-image CVEs, once a week; `factory advisories file` does the filing
//   maintain  dependency, end-of-life runtime and docs maintenance, once a day
//   improve   refactor, performance, cost and factory-health review, once a day, lens in rotation
//   hygiene   proposes closing shipped, duplicate and stale beads, once a day, in code (no model, no run)
//
// Each pass files what it finds as separate work in the backlog. The flood guard
// (src/sweeps.ts's `sweepGuard`, applied in `dispatch()`) caps every rig at 5 sweep-filed beads in
// any 24 hour window. It starts a kept bead on its own only when the bead carries
// `sweep-queue:incident`, `sweep-queue:main-ci-red`, `sweep-queue:critical-advisory` or
// `sweep-queue:flaky-test`. Every other bead waits for a person.
//
// This file is self-contained. It does not import from lifecycle.ts. This lets `ownCopy` and
// `factory adopt` copy it into a repo on its own.

const claude = (model: string) => `{claude} --dangerously-skip-permissions --model '{${model}}'`
const SONNET = claude('exec_model')
const OPUS = claude('judge_model')
// production reads need the laptop's kubectl, cluster access and network, which a rig's VM workers
// (--runner ax) do not have
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

/** every pass's shared closing paragraph: the flood guard's rules, so each worker knows why a finding
 * may wait, and never tries to force one through by hand */
const guardNote = (station: string) =>
  `The factory labels what you file sweep:${station}, and keeps at most 5 such beads for this rig in ` +
  `any 24 hour window; a later finding still gets filed, just held for a person instead of started. ` +
  `It starts a kept one on its own only when it also carries sweep-queue:incident, ` +
  `sweep-queue:main-ci-red, sweep-queue:critical-advisory or sweep-queue:flaky-test: label a finding one of those only when ` +
  `it earns it. Every other finding waits for a person to prioritize.`

export default {
  name: 'sweeps',
  start: 'maintain',
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
    // sweep() in src/cli.ts handles this station in code (src/hygiene.ts). It starts no run and
    // never closes a bead. The prompt only keeps the node valid.
    hygiene: {
      everyMin: 1440,
      timeoutMin: 5,
      prompt: 'Code-only pass: the factory runs it itself and starts no worker here. Report filed.',
      next: { filed: 'done' },
    },
    monitor: {
      runner: LAPTOP,
      everyMin: 30,
      timeoutMin: 20,
      prompt: `One pass of production watch, read-only. The rig's \`--slo\` command ran before you started: its output is in your inbox, clipped to 4 KiB. It ran only because it changed since the last pass; an unchanged read starts no run at all. Read SLOs and error budgets, alert states, error rates and new error types, latency, saturation, failing jobs, certificate and quota expiry, and the health of recent deploys from it, against the previous passes in the journal.
File what hurts users now as separate work that starts on its own at the incident station, at priority 0, labeled sweep-queue:incident. File defects that can wait as separate work for a person to prioritize. Never file what is already tracked or running.
${guardNote('monitor')}
Report filed with the key numbers, which the next pass compares against, and what you filed.`,
      next: { filed: 'done' },
    },
    ci: {
      runner: LAPTOP,
      everyMin: 120,
      timeoutMin: 20,
      prompt: `One pass on a red main branch. The factory read the CI runs of the default branch before it started you. Your inbox holds one line for each red workflow that no open bead tracks yet: its key (ci-red:<workflow id>-<first failing SHA, 7 characters>), the workflow name, the first failing SHA and the URL of the newest run. The mail holds no log text.
Read the failing run's log (\`gh run view <id> --log-failed\`) and find the cause. File ONE bead for all the keys in your inbox: \`bd create -t bug -p 1\`, with the labels factory, station:plan, sweep-queue:main-ci-red and every key from the mail. Put the diagnosis, the first failing SHA and the run URLs in its description. Do not file a second bead for the same keys.
${guardNote('ci')}
Report filed with the keys and the bead id.`,
      next: { filed: 'done' },
    },
    flakes: {
      runner: LAPTOP,
      everyMin: 10080,
      timeoutMin: 30,
      prompt: `One weekly pass on flaky tests. The factory read the last 7 days of CI runs of the default branch before it started you. Your inbox holds up to three candidates, each a test that failed in 2 or more runs that later passed: its id, its key (flake:<12 hex characters>), the number of flaky runs n, queue (true or false) and the run URLs. The mail holds no log text.
File one bead for each candidate: title \`quarantine + fix flaky test: <id>\`, \`bd create -t bug -p 2\`, with the candidate's key as a label. Put the evidence (the run URLs and the failure you read in the log) in the description. Add the labels factory, station:plan and sweep-queue:flaky-test only when the candidate has queue true. Without queue, file the bead with no factory label.
${guardNote('flakes')}
Report filed with the ids and the beads you filed.`,
      next: { filed: 'done' },
    },
    maintain: {
      everyMin: 1440,
      timeoutMin: 60,
      prompt: `One pass of maintenance. Look for, most urgent first: deprecated APIs and end-of-life runtimes; dependency updates (patch and minor batched, majors one at a time); issues labeled \`factory\` in the tracker; docs that drifted from the code. The ci and flakes sweeps own red main-branch CI and flaky tests: do not file those.
File each item worth doing as separate work, at most five per pass, skipping what is already tracked. The advisories sweep owns security advisories; do not file them. Everything else is for a person to prioritize.
${guardNote('maintain')}
Report filed with what you filed and what you skipped on purpose.`,
      next: { filed: 'done' },
    },
    advisories: {
      runner: LAPTOP, // the person's gh reads Dependabot alerts, and the live bin/factory has the filing command
      everyMin: 10080,
      timeoutMin: 45,
      prompt: `One pass of the advisories sweep: dependency and base-image CVEs. You only collect. A command does the dedupe and the filing.
1. Dependabot: \`gh api --paginate 'repos/<owner>/<repo>/dependabot/alerts?state=open'\`. If it answers 403 or 404, set dependabot to "off". A person must enable the alerts; you never do.
2. Also run the audit tool of each lockfile: \`bun audit --json\`, \`npm audit --json\`, \`govulncheck -json\`, \`pip-audit -f json\`. On a GitOps rig, scan the image refs with trivy or grype if installed; if not, write "image scan skipped" in your report.
3. Read the installed version of each package from the lockfile. Use null when you cannot find it, and null for a missing fix.
4. Write .scratch/advisories.json: {"repo":"<owner>/<repo>","dependabot":"ok"|"off","advisories":[{"id":"GHSA-...|CVE-...","aliases":[],"severity":"critical|high|medium|low","package":"","ecosystem":"","installed":"1.2.3"|null,"fixed":"1.2.4"|null,"source":"dependabot|bun-audit|...","manifest":"bun.lock"}]}. Copy no free text (summary, description) into it: the command refuses a bad field and files nothing.
5. Run \`factory advisories file .scratch/advisories.json\`. It skips every advisory id already filed, files critical and high ones (a major-version bump is held for a person, with no auto-start label), and puts medium and low ones in one digest bead. Never file an advisory bead by hand, and never set a label on one.
No lockfile and no image refs: report filed 0.
${guardNote('advisories')}
Report filed with the command's last line (filed N, queued, held, digest rows, owner step).`,
      next: { filed: 'done' },
    },
    improve: {
      agent: OPUS,
      everyMin: 1440,
      timeoutMin: 90,
      prompt: `One pass of continuous improvement, through the next lens in rotation after the last pass's (read the most recent closed sweep:improve beads' comments, \`bd list -l sweep:improve --status closed\`, to find which lens ran last): refactor, then performance, then cost, then the factory itself.
- refactor: hotspots where churn meets complexity, duplication, modules too large to change safely
- performance: the slowest endpoints, queries and jobs in production telemetry; slow tests and builds
- cost: over-provisioned or idle resources, expensive queries, storage and transfer, CI minutes, model token spend, this factory's own runs included (retries, loops, the model each station uses)
- the factory itself: how recent runs went, from \`factory status\` and, with beads, the closed factory beads' comments (bd list -l factory --status closed, bd comments <id>): stations that fail or retry often, implement ⇄ verify or review loops a better plan or prompt would have avoided, stuck runs, gates that are always answered the same way, timeouts, cadences and models that cost more than they return. Each finding is one proposed change to .factory/, with the journals that show it
Rank what you find by expected gain over effort, with evidence, and file the top items as separate work for a person to prioritize, set to start at the characterize station (refactor), the baseline station (performance, cost) or the plan station (the factory itself), at most three per pass, skipping what is already tracked.
${guardNote('improve')}
Report filed with the lens, the findings and what you filed.`,
      next: { filed: 'done' },
    },
  },
} satisfies Factory
