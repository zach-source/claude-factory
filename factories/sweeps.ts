import type { Factory } from '../src/machine'

// The standing sweeps. `factory tick` starts each one on its own cadence (src/sweeps.ts, cli.ts's
// `sweep()`). lifecycle.ts does not run them. Each node here is one pass. It starts on its own timer,
// for each rig that enables it (`everyMin`, checked in `src/sweeps.ts`'s `sweepNames` and `dueSweeps`).
// A pass is one run. It goes straight to `done`. The cadence lives in `sweep()`, not in a self-loop.
//
//   monitor   production watch, read-only, every 30 min, on a rig with a `--slo` command set
//   drift     GitOps drift watch, read-only, hourly, on a rig with a `--drift` command set
//   maintain  dependency, advisory and docs maintenance, once a day
//   improve   refactor, performance, cost and factory-health review, once a day, lens in rotation
//
// Each pass files what it finds as separate work in the backlog. The flood guard
// (src/sweeps.ts's `sweepGuard`, applied in `dispatch()`) caps every rig at 5 sweep-filed beads in
// any 24 hour window. It starts a kept bead on its own only when the bead carries
// `sweep-queue:incident`, `sweep-queue:main-ci-red` or `sweep-queue:critical-advisory`. Every other
// bead waits for a person.
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
  `sweep-queue:main-ci-red or sweep-queue:critical-advisory: label a finding one of those only when ` +
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
    drift: {
      runner: LAPTOP,
      everyMin: 60,
      timeoutMin: 30,
      prompt: `One pass of GitOps drift watch, read-only. Never apply, patch, reconcile, suspend or resume anything: no kubectl apply, patch, delete or edit, no flux reconcile, suspend or resume, no helm upgrade. Only read.
The rig's \`--drift\` command ran before you started. Your inbox holds its current read and the previous read with its time, each clipped to 4 KiB. A resource is a Flux Kustomization or HelmRelease.
1. Not Ready, or suspended: a resource in both reads (the reads are at least 60 minutes apart, so 1 hour) is stuck. File it as separate work that starts on its own at the incident station: priority 0 when its workloads are down, else priority 1, labeled sweep-queue:incident and station:incident, with the \`factory\` label. A resource in the current read only is new: wait for the next pass.
2. Image tags behind: in the manifests, find each image whose source repo has a newer GitHub release (gh release list, gh api, read-only). File one bump bead in this rig for it, with no \`factory\` label and no sweep-queue label, so a person prioritizes it.
One open bead per resource. Give each bead the label drift:<key>: drift:<kind>.<namespace>.<name> for a resource (kind in lower case), drift:image.<image with / changed to .> for an image. Before you file, run bd list -l drift:<key> and look for a bead that is not closed. If one exists, comment on it with the current state and file nothing new. A closed bead does not count.
${guardNote('drift')}
Report filed with the resources you checked, what you filed and what you commented on.`,
      next: { filed: 'done' },
    },
    maintain: {
      everyMin: 1440,
      timeoutMin: 60,
      prompt: `One pass of maintenance. Look for, most urgent first: security advisories on dependencies and base images; failing or flaky tests and CI jobs; deprecated APIs and end-of-life runtimes; dependency updates (patch and minor batched, majors one at a time); issues labeled \`factory\` in the tracker; docs that drifted from the code.
File each item worth doing as separate work, at most five per pass, skipping what is already tracked. A security advisory starts on its own at the plan station, labeled sweep-queue:critical-advisory; a red main-branch CI run starts on its own at the plan station too, labeled sweep-queue:main-ci-red; everything else is for a person to prioritize.
${guardNote('maintain')}
Report filed with what you filed and what you skipped on purpose.`,
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
