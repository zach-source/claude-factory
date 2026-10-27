import type { Factory } from '../src/machine'

// The whole software lifecycle as one graph. A run enters at triage (or at a
// station, `lifecycle@incident`) and walks one of these loops:
//
//   build      plan → implement ⇄ verify ⇄ review (→ security) → hand off to ship
//   small      triage → quick ⇄ check (→ security if flagged) → hand off to ship
//   optimize   baseline → plan → implement ⇄ verify (against the target) → … → hand off   (abandon when disproved)
//   refactor   characterize → plan → implement ⇄ verify (pinned behavior holds) → … → hand off
//   incident   incident → rollback | plan → … → hand off
//
// Approval ends the run on a `ship` edge. The runner leaves the bead open with the label `ship`, and the
// rig's one ship run (factories/ship.ts) owns release, the wait for your merge, deploy, soak, rollback
// and postmortem. A run holds no slot after the handoff. If ship finds the pull request needs changes,
// it starts a new run for the bead at implement. Runs that started before this change follow the
// release, deploy and soak nodes in their own pinned factory.json, so they finish on the old path.
//
// The standing sweeps (monitor, maintain, improve) are not here: they live in factories/sweeps.ts,
// their own factory, one pass per run, started by `factory sweep` on each sweep's own cadence
// (src/sweeps.ts). A pinned run from before claude-factory-8pc still loads this file's own copy of
// them if its factory.json holds one; see that bead for the move.
//
// The pull request is the one place a person must act. Ship's deploy waits for a person to merge it and
// never merges itself, so nothing reaches the default branch or production without them.
// In a repo with beads, a run's bead is its epic: plan records the tasks as its children,
// implement works them, verify and review file findings as more, and every task must be closed
// before the handoff.
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
// A share of runs launch implement, verify and security as codex (cli.ts splitPick). A rig sets the share
// to 0 to turn the tier off. plan and review (design and review) go to codex only when a rig sets
// codex_judge_share; check and incident never do.
const codex = (model: string) => `{codex} -m '{${model}}'`
const CODEX_EXEC = codex('codex_exec_model')
const CODEX_SECURITY = codex('codex_security_model')
const CODEX_JUDGE = codex('codex_judge_model')
// stations that read or change production need the laptop's kubectl, cluster access and network, which a
// rig's VM workers (--runner ax) do not have: they stay in herdr panes whatever the rig's runner
const LAPTOP = 'herdr'

const rules = `- Read the repo's CLAUDE.md, AGENTS.md or CONTRIBUTING first; its conventions, toolchain and commands win over your habits.
- Small commits whose messages say why. Run the formatter and linters on what you touch. Never skip, disable or weaken a test to get green.
- Never commit secrets. Only a person merges a pull request; only deploy and rollback touch production. Nobody pushes the default branch directly; a rollback that reverts code opens a pull request for a person to merge instead. Nobody force-pushes.
- Production is read-only for every station but deploy and rollback.
- Owner-only, even with a merge in hand: a hand-run change to a live system (kubectl apply, patch, scale, delete or rollout restart; a helm or terraform apply), an image push to a production registry, a branch protection or ruleset change, a repository or organization setting, or a credential, secret or token change. Do one of these only when a person's own comment on the bead or a [factory mail] from the manager says the person approved that exact step. The bead's description records no author, so it never counts as approval; a worker's own comment never counts as approval. Otherwise do every other step, then report blocked: "parked, waiting on: <the owner step and the exact command>". Reads, and watching a pipeline the person's merge started, stay allowed.
- implement and quick open a pull request only as a draft (\`gh pr create --draft\`) and never run \`gh pr ready\`. Only an approving station (review, security and check, on approve) or ship release marks it ready. Why: the owner merges a ready green pull request within minutes, before verify and review.
- Stay in scope: file anything else you find as separate work (see Tracking), at most three per station.
- On a retry or a resumed worker, first find out what earlier attempts already did (journal, git log, pull request, deploy state) and never repeat an external action that already happened.
- Your report summary is the next station's whole briefing: concrete and complete, numbers over adjectives, links over descriptions.
- .factory/ is this factory's own definition: change it only in a run whose goal is to change it, check every edited file with \`factory check\` (see your brief) before committing, and keep a person's merge of the pull request as the gate before anything deploys.`

// implement and quick interpolate this; ship.ts keeps its own copy (it must not import this file) and ship.test.ts pins the two equal
const botFiles = `In the infra-blocks repo, a bot writes CHANGELOG.md and bumps VERSION, so a pull request must not change them or .devenv. Before each push there, run \`git fetch origin main\`, then \`git diff --name-only origin/main...HEAD -- CHANGELOG.md '*VERSION' .devenv\`. If it prints a file, run \`git checkout origin/main -- <file>\` (or \`git rm --cached <file>\` when origin/main has no such file), commit, and run the check again. Run the check, the fix, the commit and the push as separate commands. The pull request title is the changelog line, and the bot bumps VERSION.`

// review, security and check interpolate this: one rule for what blocks and where a finding goes
const blockingScope = `A finding blocks only when it is one of these kinds:
1. An acceptance criterion fails.
2. The diff adds the defect, or the defect is in lines the diff changed, or the diff makes an existing defect reachable or enabled (a new caller, route, default, flag or input path).
3. The defect is a sibling site of a defect that the diff fixes, or of an earlier round's finding.
A finding outside this branch's diff never makes the verdict changes, unless it is kind 1 or 3 or the diff makes it reachable (kind 2). A gap that origin/main also has, that no acceptance criterion names and that is not kind 2 or 3 does not block: list it under 'Not blocking' and file it as separate work. Run \`bd search\` first and add the instance to an open class bead. If none is open, file one bead per class at P2 or lower, with the instances as evidence (\`--deps discovered-from:<run bead>\`, see Tracking). Only a person, or triage or plan on the run's own bead, sets P0 or P1. Each blocking finding names its kind: 1, 2 or 3.`

// review, security and check interpolate this: how the verdict reaches the pull request. When FACTORY_GH_REVIEWER is 1
// the task runs with the reviewer identity's token, and the worker hook allows the approving call
const postVerdict = `If \`printenv FACTORY_GH_REVIEWER\` prints 1, you run as the reviewer identity, and your review counts toward the merge rules. Read \`gh pr view <n> --json author,headRefOid\`. If the author is the reviewer identity, or headRefOid is not the commit you reviewed, or the head holds a commit that you made, do not approve: review the new head, or post a comment. Else post the verdict with \`gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews -f commit_id=<the SHA you reviewed> -f event=APPROVE -F body=@<file written with the Write tool>\`: event=APPROVE when you report approve (also when you report security), event=REQUEST_CHANGES when you report changes. Put every finding in the body at its file and line. If that variable is not 1, run \`gh pr review --comment\` with the verdict and every finding at its file and line (GitHub refuses approve and request-changes on a pull request the same account opened). When you report approve, and no check is red and \`git merge-tree\` against origin/main shows no conflict, mark the pull request ready: \`gh pr ready <n> -R <owner>/<repo>\`. Do not mark it ready when you report changes or security.`

export default {
  name: 'lifecycle',
  start: 'triage',
  agent: SONNET,
  params: {
    claude: 'claude-smart --new --no-channels', // the Claude Code launcher
    exec_model: 'claude-sonnet-5-5[1m]', // execution
    judge_model: 'claude-opus-5-5[1m]', // planning, judgment, review
    security_model: 'claude-fable-5-1', // security and architecture
    codex: 'codex --dangerously-bypass-approvals-and-sandbox', // the codex launcher (the deny hook stays on)
    codex_exec_model: 'gpt-6.1-sol', // codex in place of exec_model
    codex_security_model: 'gpt-6-astra', // codex in place of security_model
    codex_share: '0.3', // share of runs whose implement and verify use codex; 0 turns it off
    codex_security_share: '0.3', // share of runs whose security uses codex; 0 turns it off
    codex_judge_model: 'gpt-6-astra', // codex in place of judge_model at plan and review
    codex_judge_share: '0', // share of runs whose plan and review use codex; off until a rig sets it
  },
  backoffSec: 60,
  maxSteps: 24,
  rules,
  // a station gets asd-ste100 only when it writes text a person reads (claude-factory-qda)
  skills: [],
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
- rollout: the goal is to ship pull requests that are already open or merged (release, deploy, roll out), with nothing to build. The bead moves to the release factory, which starts at recipe. Name the pull requests in the summary.
- decision: the work cannot go on without a person's decision. Put the question on the bead (a bd comment) and end the summary with a \`Question:\` line and an \`Options:\` line. The run ends deferred. \`bd undefer\` starts it again at plan. If every acceptance criterion of the bead is a live read (kubectl get or logs on a production context, an edge GET, a Mimir query), the bead needs no code, and you run on a VM (\`kubectl config get-contexts\` lists no context), do not route it to plan or implement. Classify it decision, name the exact reads, and ask the manager to run them from the laptop or to start the run on a laptop runner.
- elsewhere: the change belongs in another rig's repo. File the bead there: run bd create with your cwd in that rig's repo (see \`factory rig\`), the label \`factory\`, and this bead's id in its description. Then comment the new id on this bead. If you cannot reach that repo (a VM worker), put one line \`File in: <rig>: <title> | <description>\` in the summary for the manager. The run ends deferred.
- reject: unclear, already tracked (a run in \`factory status\`, an open issue), or not worth doing; say why
If the goal is a red main or a CI job red on main, run \`gh pr list --state open --search '<failing file or test> in:title,body'\` and \`factory status\`. If an open PR or a live run already fixes it, reject as already tracked and name that PR.
Summary: the goal restated as a testable outcome, its constraints, and the files and systems involved.`,
      next: {
        rollout: { to: 'done', requeue: { factory: 'release' } },
        decision: { to: 'done', defer: { station: 'plan' } },
        elsewhere: { to: 'done', defer: true },
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
      skills: ['asd-ste100'],
      agent: OPUS,
      split: { agent: CODEX_JUDGE, share: 'codex_judge_share' },
      timeoutMin: 45,
      prompt: `Write the spec every later station works from: your summary is that spec. Cover:
1. Acceptance criteria, each one testable and numbered AC1, AC2, ... so verify and review can cite them. Each AC names the test or command that proves it, and its negative rows (the inputs that must stay denied or allowed). For a guard, validator or parser, define the class as one fail-closed rule, not as a list of forms, and name the forms that are out of scope.
2. Design: the change, the files it touches, the alternatives you rejected and why.
3. Test plan: the failing tests implement writes first.
4. Risk: security, data, migrations, backward compatibility. Write "security-sensitive" when it touches auth, secrets, crypto, input parsing, permissions or infrastructure access.
5. Rollout and rollback: flags, migration order, how to undo it.
6. Observability: the metrics, logs or checks that prove it works in production; the ship run's soak reads them.
7. Tasks: the work broken into small tasks, each one commit with its own check, in dependency order. Record them (see Tracking) and list them in the summary. If this bead's tests stay red until the change of another bead lands, plan both in one pull request (the tests commit first, then the change), or make this bead depend on the other bead. Do not plan a pull request that ships with red required checks by design.
For an optimization, the target number and how verify measures it, from the baseline. For a refactor, the target structure and the invariants characterize pinned. After a rollback or an incident, plan the fix forward from what the journal learned. For a change to the factory itself (.factory/), the acceptance criteria say what future runs will do differently and how that shows in their journals.
Commit nothing but an architecture decision record, and only where the repo keeps them.
When the plan cannot go on without a person's decision, put the question on the bead and report decision, with \`Question:\` and \`Options:\` lines at the end of the summary. The run ends deferred; \`bd undefer\` starts it again at plan.`,
      next: { ready: 'implement', decision: { to: 'done', defer: { station: 'plan' } } },
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
      skills: ['asd-ste100'],
      split: { agent: CODEX_EXEC, share: 'codex_share' },
      timeoutMin: 120,
      prompt: `Build what the plan in the journal specifies, one task at a time in dependency order (see Tracking), closing each with its commit. Test first: write the failing test, watch it fail, make it pass. Failures and review findings come back as new tasks and in your inbox: fix every one and say how. A finding names an instance: grep for its siblings and fix the class, not the one line.
Before you report ready, run this self-check at the final HEAD, after your last commit. Do what review would:
1. Merge origin/main last and resolve any conflict. Then run the full gate the way CI runs it: the same commands, the pinned tool versions and the whole test suite, not only the files you touched. If load makes timing tests flake, run those files alone and say so.
2. Make an AC table: each plan AC id and the test or command that proves it.
3. Break each new branch, error path and guard alone. See a test fail. Then restore it.
4. After your last code change, read again each doc, comment, docstring and pull request line that the diff touches or that names a changed symbol (grep for it). Check each claim against the code, and run each command you documented exactly as written. Keep each doc block directly above its function.
5. After a send-back, read the whole delta since the last reviewed head (\`git diff <reviewed sha>..HEAD\`) for defects that your fixes added. Grep for the siblings of each finding.
6. Add no changelog entry and no version bump: the repo's release step writes the changelog at release time.
7. ${botFiles}
Close every task of this run (see Tracking). Push the branch and open it as a draft pull request (gh pr create --draft) if this run has none yet. Your ready report must hold a block that starts 'Self-check:'. The block has the AC table, the gate commands with their pass and fail counts, and the list of mutations. Say in the summary that you pushed, and give the pull request link.
Earlier draft pull request: when the bead's comments name a draft pull request that an earlier run opened for this bead, continue on that branch, push to it and open no new pull request.
Ship rework: when the bead's metadata names a ship_pr and a ship_branch (the ship run sent this pull request back), the pull request already exists. Work on that branch, push with \`git push origin HEAD:<ship_branch>\` and open no new pull request. Name the ship pull request in the summary.
For an optimization: one hypothesis at a time, re-measured with the baseline's command. When the journal shows two attempts that missed the target, report abandon with what was learned. abandon is only that: it ends the run with nothing shipped. When what is left waits on a person's decision, push the branch, name it and the draft pull request in the summary, put the question on the bead, and report decision with \`Question:\` and \`Options:\` lines at the end of the summary. The run ends deferred; \`bd undefer\` starts it again at plan.
For a refactor: no behavior change; the characterization tests stay untouched and green.`,
      next: { ready: 'verify', abandon: 'done', decision: { to: 'done', defer: { station: 'plan' } } },
    },
    verify: {
      split: { agent: CODEX_EXEC, share: 'codex_share' },
      timeoutMin: 75,
      prompt: `Check the branch independently; trust no earlier report and change no code.
Run the full pipeline the repo defines: the build, every test suite, linters, type checks, and the security scanners it has (dependency audit, secret scan, static analysis). Check each acceptance criterion from the plan and say how you verified it. Then try to fail it as review would: \`git merge-tree\` it against origin/main (a conflict is red); break each new guard or comparison and see a test fail; check that each fixture can occur in real data, each claim in a changed doc matches the code, and each documented command runs as written. For an optimization, re-run the baseline's measurement and compare it with the target. For a refactor, confirm the characterization tests are unchanged and green. For a change to .factory/, run the factory check on every changed file.
Report green with the evidence, or red with a numbered list of every failure, the AC id each one fails, and how to reproduce it, each also recorded as a bug task of this run (see Tracking). End a red report with one line \`Failing: AC2, AC6\` naming only the AC ids that still fail, so a repeat on the same id is easy to spot and a passing AC named elsewhere in the report never counts as one.`,
      repeatMail: 'red', // red twice in a row on the same AC id (the report's own "Failing:" line) mails the manager; the run still goes to implement
      mergeCheck: 'red', // a conflicting branch goes back to implement with no verify worker
      next: { green: 'review', red: 'implement' },
    },
    review: {
      skills: ['asd-ste100'],
      agent: OPUS,
      split: { agent: CODEX_JUDGE, share: 'codex_judge_share' },
      timeoutMin: 45,
      rounds: 3, // a fourth round of changes is held for the manager: the loop is not converging
      onRounds: 'plan', // a capped run re-plans with its findings instead of parking for a hand goto
      prompt: `Review the branch's diff against the default branch as you would before a merge: correctness, the tests' quality, simplicity, naming, error handling, backward compatibility, migrations and observability. Change no code.
A change to .factory/ changes how every later run works: read it as a policy change, not a refactor.
${blockingScope}
Post the review on the pull request: implement opens it as a draft; push the branch and open one yourself if this run still has none. ${postVerdict}
Report approve; changes with a numbered list of everything to fix, found in one pass over the whole diff (including each earlier fix's sibling sites), so the next round does not surface what this one could have, each also recorded as a task of this run (see Tracking); or security when everything else is approved and the plan or the diff is security-sensitive, or when it changes .factory/ in a way that removes a gate, lets more run unattended, or raises a limit or a cadence. Include the pull request link. For security, also include \`git diff --stat origin/main...HEAD\` (at most 60 files, then "+N more") and one line per changed area, so a retry after a timeout can work from that instead of rereading the whole branch.`,
      next: { approve: { to: 'done', ship: true }, changes: 'implement', security: 'security' },
    },
    security: {
      skills: ['asd-ste100'],
      agent: FABLE,
      split: { agent: CODEX_SECURITY, share: 'codex_security_share' },
      timeoutMin: 45,
      // claude-factory-3t2: 5 of 65 security visits timed out at 45 min, all on one large rig. The
      // retry right after a timeout gets 75 min and a narrower brief, instead of the same 45 min
      // and the whole branch again; a 2nd timeout in a row still goes to isRepeatFail's stuck+mail.
      onTimeout: {
        timeoutMin: 75,
        prompt: `Do not re-read the whole branch. Start from the changed-files list and the diff summary in review's or check's report in your Inbox. If there is none, run \`git diff --stat origin/main...HEAD\`. Read the hunks of the riskiest files first (auth, input parsing, secrets, permissions, .factory/). Post each finding on the pull request as you find it. Report before the limit, and name the files you did not read.`,
      },
      prompt: `Security review of the branch's diff, thinking as an attacker: authentication and authorization, input validation and injection, secrets, crypto, SSRF, deserialization, dependency risk, infrastructure permissions, sensitive data in logs. Check it against the plan's risk section, or triage's summary on a small run. Change no code.
${blockingScope}
A high or critical finding that origin/main also has and that is not kind 1, 2 or 3 does not block, but name it in the report as a high or critical finding for a person to prioritize.
Post it on the pull request. ${postVerdict}
Report approve, or changes with each finding, its severity and its fix, each also recorded as a bug task of this run (see Tracking).`,
      next: { approve: { to: 'done', ship: true }, changes: 'implement' },
    },

    // ── the small route: a tiny, docs-only or test-only change skips plan and a separate review ──────
    quick: {
      skills: ['asd-ste100'],
      timeoutMin: 60,
      prompt: `Build what triage's summary in the journal says, with no plan. Test first when code changes. Merge origin/main, run the formatter and the tests of what you touched, commit.
Fix every finding check sends back and say how, closing each task check filed, with its commit (see Tracking), as implement does for review's findings.
Ship rework: when the bead's metadata names a ship_pr and a ship_branch (the ship run sent this pull request back), work on that branch, push with \`git push origin HEAD:<ship_branch>\` and open no new pull request.
${botFiles}
If the work proves bigger than small (more files, a security-sensitive surface, a new dependency, a design choice), report full with why, and plan takes it.`,
      next: { ready: 'check', full: 'plan', abandon: 'done' },
    },
    check: {
      skills: ['asd-ste100'],
      agent: OPUS,
      timeoutMin: 60,
      rounds: 3, // a fourth round of changes is held for the manager: the loop is not converging
      prompt: `One station does both verify and review for a small change. Trust no earlier report.
Run the repo's full pipeline: the build, every test suite, linters, type checks, and the security scanners it has (dependency audit, secret scan, static analysis). Then try to fail it: \`git merge-tree\` it against origin/main (a conflict is red); break each new guard, branch and error path and see a test fail; check that each claim in a changed doc or docstring matches the code, and each documented command runs as written. For a change to .factory/, run the factory check on every changed file.
Then review the diff as you would before a merge: correctness, the tests' quality, simplicity, naming, backward compatibility. A change to .factory/ changes how every later run works: read it as a policy change, not a refactor.
${blockingScope}
Push the branch and open it as a draft pull request if this run has none yet, then post the verdict. ${postVerdict}
Report approve; or changes with one numbered list of every failure and finding, found in one pass over the whole diff, each also recorded as a task of this run (see Tracking); or security when everything else is approved and the diff or the bead is security-sensitive (auth, secrets, crypto, input parsing, permissions, infrastructure access, or the label \`security\`), or the diff changes .factory/ in a way that removes a gate, lets more run unattended, or raises a limit or a cadence. Include the pull request link. For security, also include \`git diff --stat origin/main...HEAD\` (at most 60 files, then "+N more") and one line per changed area, so a retry after a timeout can work from that instead of rereading the whole branch.`,
      next: { approve: { to: 'done', ship: true }, changes: 'quick', security: 'security' },
    },

    // ── undo it: a rollback, from an incident. Release, deploy and soak live in factories/ship.ts ──
    rollback: {
      skills: ['asd-ste100'],
      runner: LAPTOP,
      retries: 3,
      timeoutMin: 45,
      prompt: `Restore service. Check what is already rolled back, then roll back the release your inbox names the repo's way: redeploy the previous version, turn the flag off, or open a pull request that reverts the merge, since you never push the default branch directly. Confirm recovery against the baseline.
Report recovered with what you did, the evidence of recovery, the revert pull request's link if you opened one, and everything learned about the cause: plan takes it from there to fix forward.`,
      next: { recovered: 'plan' },
    },

    // ── incidents ────────────────────────────────────────────────────────────
    incident: {
      skills: ['asd-ste100'],
      runner: LAPTOP,
      agent: OPUS,
      timeoutMin: 30,
      prompt: `Production is degraded. Diagnose, read-only: the impact and blast radius, when it started, what changed then (deploys, config, dependencies, traffic), and the evidence in metrics, logs and traces.
Report rollback when a recent release caused it (name it and the version to return to); fix when it needs a code or config change (say how urgent, and what mitigates it meanwhile); noise when it is a false alarm (file a run to tune the alert).`,
      next: { rollback: 'rollback', fix: 'plan', noise: 'done' },
    },
  },
} satisfies Factory
