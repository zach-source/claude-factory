# Changelog

Each release is tagged `v<version>` and its version is set in `package.json` and
`mod/.claude-plugin/plugin.json`. Versions follow [semver](https://semver.org); until 1.0 a
minor release may change the factory format, the CLI or the run state.

## Unreleased

- A worker can never merge or push its own default branch. Only a person's merge, through
  auto-merge, can ship a pull request. (claude-factory-zl5)
  - Cause: the owner's ruleset decision (2026-10-16) lets GitHub merge a pull request on
    green through auto-merge. But admin bypass on the ruleset also lets a worker's own
    `gh pr merge` or push skip review. `ax-aw1` found two pull requests that merged before
    their own review ran.
  - Fix: `implement` now opens the draft pull request (`factories/lifecycle.ts`). `review`
    opens one only as a fallback, when none exists yet. Only `release` marks a pull request
    ready for review. No station, `release` included, ever runs `gh pr merge`; only a person
    merges, through GitHub's own auto-merge on green.
  - The worker `PreToolUse` hook (`src/worker-hook.ts`) denies these commands at every other
    station: `gh pr merge` (plain, `--auto`, `--admin`, or wrapped in `sudo`, `env`,
    `timeout`, `watch`, `bash -lc`, or `eval`); `gh pr ready`; and the GraphQL
    `enablePullRequestAutoMerge` and `markPullRequestReadyForReview` mutations. The hook
    finds a mutation by name in `-f`/`-F`/`--field=`/`--raw-field=` text, or in an
    `@file`/`--input` payload.
  - The hook also denies `git push` to a protected branch, and a REST or GraphQL API write
    to one. A write is `PATCH`/`DELETE .../git/refs/heads/<branch>`,
    `PUT`/`POST`/`DELETE .../contents/<path>`, `createCommitOnBranch`, `updateRef(s)`,
    `deleteRef`, or `git -c alias.<x>=push`. A protected branch is `main`, `master`, a rig's
    own `protectedBranches` list, or its `origin/HEAD` target. The hook reads `origin/HEAD`
    and the current branch live from the worktree, and denies the push when either read
    fails: a timeout, a detached `HEAD`, or no `origin` remote.
  - Added: `factory rig add <rig> <repo> --protected-branch <name>` (repeat the flag for
    more than one branch). Use it for a rig whose default branch is not `main` or `master`,
    for example `factory rig add ax ~/repos/ax --protected-branch acme-deploy`. A rig with
    the list gets its own `worker-settings-<rig>.json` file, the same pattern the
    `--person-only-context` flag already uses.
  - No station, `rollback` included, pushes straight to the default branch any more.
    `rollback` now opens a pull request that reverts the merge instead.
  - A round-2 review found 8 more bypasses. The hook now closes each one.
    - `gh api` now reads a `-p`/`--preview` value word. The real endpoint can no longer hide
      behind it.
    - `gh api` now reads a `-f`/`-F` field pair in its `-f=name=value` form. It also splits a
      clustered short flag, such as `-iXPUT` or `-if`, into separate flags first.
    - The hook treats `/graphql` and a full `https://.../graphql` URL the same as a bare
      `graphql` endpoint.
    - A `$name` or a `` `cmd` `` in a field value or a path segment now denies the command.
      The hook reads only the command's own text. It cannot read what the shell puts there
      later.
    - A `git push` refspec of `@` or `head`, in any letter case, now denies the same as the
      current branch name would. A `heads/<branch>` refspec denies the same as
      `refs/heads/<branch>`.
    - `git -c remote.<name>.push=<value>` and `git config remote.<name>.push <value>` now
      deny the command outright, next to the existing `alias.<name>=push` check.
    - `gh alias set <name> "<expansion>"` now denies the command when the expansion's own
      text would deny it. `gh alias import` denies the command outright.
  - Owner step still open: the `ax` rig has no `protectedBranches` set yet. Its own
    non-`main` default branch stays unprotected until a person adds it with
    `factory rig add ax ... --protected-branch <name>`. A VM-runner rig gets the new hook
    only after a person rebuilds and pushes its worker image (`hack/push-worker.sh`).

- Dispatch now checks a ready bead before it starts a run for it, and skips a bead a merged
  pull request or a live run already covers. (claude-factory-6as)
  - Cause: a 3-day review (2026-10-13 to 16) found 40 of 319 triage visits (12.5%) were
    rejects, and 30 of those (9.4% of all visits) were beads already done: a merged pull
    request had done the work before triage ever saw the bead. Each one still cost a run,
    a worktree and a triage session.
  - Fix: `citesBead` and `alreadyDone` (`src/prs.ts`) are a pure check. They test a bead's
    exact id, or a dotted child id of a bead with no open children, against the titles of
    the rig's merged pull requests. `precheckSkip` (`src/cli.ts`) calls them right before
    `dispatch()` hands a candidate bead to `createTracked`. It uses `gh pr list --state
    merged --search <id>` (plus the bead's own run branches) in the rig's repo. On a hit,
    it rejects the bead (`rejected_by: dispatch`, with the pull request's evidence in the
    reject reason) and leaves one comment; it never closes the bead. `FACTORY_PRECHECK=0`
    turns the check off. `rejected_by: dispatch` plus a `factory queue` requeue also skips
    the check, so a person's override costs no `gh` call. A `gh` failure or timeout fails
    open: the run starts, and `HOME/precheck.jsonl` gets a `skip` row.
  - The same pass also stops a second run for a ready, unassigned bead a live run already
    holds (it lost its own claim). Dispatch leaves one comment naming the run, deduped by
    a `dispatch_skip` metadata stamp, and starts no second run.
  - `factory metrics` (`src/metrics.ts`) now prints the triage reject rate and how many of
    those rejects say the work was already done (`ALREADY_DONE`), plus how many runs the
    pre-check skipped, by kind, from `HOME/precheck.jsonl`: `triage rejects R of V (D
    already done); dispatch skipped S (merged-pr M, live-run L), gh fail-open F`.
- Added: `factory gc [--days N] [--dry-run]`. For a done or aborted run older
  than `N` days (`FACTORY_GC_DAYS`, default 7), it removes the run's
  `prompts/`, its `f-*.brief.md` briefs and its `*.before-*`/`*.pre-*` backups.
  It keeps `run.json`, `state.json`, the journal, `inbox` and `prs.json`.
  (claude-factory-503.1)
  - It also removes a launch script under `HOME/launch/` once a strict read of
    live `herdr` panes shows no pane still uses it. A failed or missing
    `herdr` read skips launch-script removal for that pass, so it never
    deletes a script that may still be in use.
  - `--dry-run` only prints file counts and bytes for each kind (prompts,
    briefs, backups, launch scripts), and a total. It deletes nothing.
  - `tick()` now starts one `factory gc` pass at most once an hour
    (`FACTORY_GC_MS`). `FACTORY_GC=0` turns this off. This follows the same
    pattern as the existing `dream`, `config-sync` and `self-update` passes.
  - `gc` can remove `prompts/` from a done or aborted run. A later goto on
    that run can revive it. `spawn()` and `resumeFile()` (`src/cli.ts`) now run
    `mkdir` on the `prompts/` directory before they write into it, so a
    revived run can start a worker. `sessionsOf()` now reads the union of the
    run's `prompts.list` file and a rebuilt `prompts/` directory, so a revived
    run keeps its old station names.
  - A second `gc` pass after such a revive now writes `prompts.list` as the
    union of its old contents and the current `prompts/` listing. Before this
    fix, the second pass overwrote the list, and lost the names the first
    pass had kept.
  - `gcPass()` now skips one unreadable run directory. It names the directory
    on stderr and continues the rest of the pass, instead of failing the
    whole pass.
- Deploy no longer starts a worker against an unmerged pull request. (claude-factory-960)
  - Cause: a run reached `deploy` as soon as release reported, so a worker always launched
    even when the pull request was still open. The worker then found nothing to do and
    parked: 1.50 deploy sessions per shipped run over 3 days (2026-10-13 to 16, by the
    `fate()` this change ships), 215M tokens spent on parks.
  - Fix: `Node.awaitsPr` (`src/machine.ts`) marks a station, `deploy` in `factories/lifecycle.ts`,
    that must wait for a linked pull or merge request before it starts a worker. When an
    arrival's report names one and `awaitsPr` is set, the run parks at once, spending no
    worker and no attempt, the same way a worker's own `blocked` report parks it.
  - `factory watch` (`src/cli.ts`) now runs every minute, down from 5, in its own child
    process (`kickWatch()`, like `kickDevenv()`), and caches one `gh`/`glab pr view` per
    pull or merge request URL per pass. It wakes a pre-launch park at once when the pull
    request is already merged or closed, and within about a minute of a merge, close,
    comment, review or push once it starts open. A closed pull request still routes as
    today, through `deploy`'s own `hold`/`changes` outcomes.
  - `factory metrics` now reports deploy sessions per shipped run, and only counts
    `deployed` or `published` as a ship (`fate()`, `src/metrics.ts`); a deploy `blocked`
    or `handoff` entry never counts as a ship.
- A stuck run no longer counts against `FACTORY_MAX_RUNS`, the town-wide cap.
  (claude-factory-ytz)
  - A run goes stuck when it passes `factory retry`'s attempt budget. The run then waits
    for the owner.
  - `busyRigs()` (`src/cli.ts`) now returns two sets: `busy` and a new `held` set.
  - `dispatch`, `rework`, `assertRoom`, `backlog` and `rig list` count `held` only against
    a rig's own `maxRuns`. They do not count `held` against the town cap.
  - `room()` takes `held` as a new, optional argument.
  - `rig list` adds a new line: `town: busy X/MAX, stuck Y`.
  - The default `FACTORY_MAX_RUNS` moves from 8 to 16. This is the cap the owner already
    uses.
- Fixed: a large prior report can kill a worker turn with this error: `ENAMETOOLONG: name too long, posix_spawn claude`. (claude-factory-kcg)
  - Cause: `turn()` in `src/worker.ts` put the whole prompt as the last argv element
    for `claude`, `codex` and `pi`. Linux's `MAX_ARG_STRLEN` caps one argv string at
    131072 bytes. A long prompt, for example a station report with a large pasted
    diff, failed `posix_spawn` past this cap.
  - Fix 1: `turnArgv()` now builds an argv with no prompt text, for all 3 harnesses.
    `turn()` sends the prompt on stdin instead (`stdin: new Blob([text])`).
  - Fix 2: `src/cli.ts`'s `brief()` already clipped journal lines to 1500 characters.
    3 other spots had no clip: the `lastFail`, `handedOff` and `parked` summaries,
    and inbox mail text. A new `clipReport()` (`REPORT_MAX` = 32000 characters) now
    runs at all 5 places where a report or mail reaches a brief or a delivered mail.
    It never cuts between a UTF-16 surrogate pair's two units.
  - Fix 3: `src/ax.ts`'s `ax.prompt()` sends mid-run mail as one base64 argv to the
    `factory worker prompt` command. Base64 text is 4/3 the size of the source text,
    so a mail over about 96 KiB failed the same way on a VM worker. A new
    `clipBytes()` (`PROMPT_MAX_BYTES` = 90000) clips the UTF-8 byte length before the
    base64 encode. It backs off over a multi-byte character, so it never splits one.
- Console: a due patrol now runs as a hidden `factory:patrol` subagent (`$.agent.spawn`,
  `mod/hooks/register.tsx`), instead of waking the manager's own main chat with `$.prompt.submit`.
  The person can keep typing while a patrol runs; a patrol adds no turn to the main chat and no
  task-notification turn either. `$.agent.register('patrol')` registers the type in
  `session.start`, with `agent.offer` hiding it from the model. Only one patrol runs at a time
  (`isPatrolling`), freed by its own `turn.complete` or a 15-minute watchdog. The tool.call hook
  now denies a patrol's gated command (`factory decide`, `decisions answer`, a `start --owned`)
  outright, with no `$.ui.ask` dialog: nobody is there to answer it. The same hook holds a run the
  main chat touched in the last 5 minutes out of the next patrol, and denies a patrol's own
  command on that run too. Each patrol's outcome (its actions, token use, report) appends one
  line to `<home>/patrol-log.jsonl` (capped at 50 lines), shown by a new `/factory patrols`
  command and folded into the dream's manager-activity digest (`memory.patrolActivity` in
  `src/memory.ts`). The pane header and the band above the prompt show how long ago the last
  patrol ran. Owner decisions still surface through the existing decisions/interview queue. A
  subagent's Bash prefix also carries `FACTORY_PATROL=1`, next to `FACTORY_HOME`; `src/cli.ts`
  refuses `decide`, `decisions answer`, `decisions propose` and an owner-only `start` whenever
  it is set, a second layer behind the hook's own regex deny. The run-touched hold and its deny
  now read every run id a compound Bash command names (`matchAll`, not only the first match),
  and the hold also covers an older patrol the watchdog freed but which still runs late.
  (claude-factory-72v)
- Added: a rig can name kube contexts that only a person can change live. Use
  `factory rig add <rig> <repo> --person-only-context <context>` (repeat the flag for more
  than one context). The worker `PreToolUse` hook (`src/worker-hook.ts`) now refuses a
  `kubectl`, `ko` or `helm` command that mutates state at one of those contexts. It also
  refuses a mutating command with no named `--context` (fail closed). `ruleLines` adds a
  line under a worker's "## Rig goal" section that names the contexts and the park text, so
  the rule reaches the brief, not only a memory note. A rig with the list gets its own
  `worker-settings-<rig>.json`; a rig with no list keeps the shared file.
  (claude-factory-25z)
- Added: a Linear pull loop (claude-factory-b6c). A rig opts in with `factory rig add
  ... --linear <team_id[,team_id]>` (or a `rigs.json` `linear.team` field, plus optional
  `projects`/`labels` for routing). `tick()` runs `bd linear sync` for each opted-in rig
  about every 20 minutes (`--pull-if-stale`, debounced). `src/linear.ts` lists each rig's
  team on the Linear GraphQL API by issue identifier, never a URL. It routes each issue to
  a rig by a `[<rig-name>] ...` project-name prefix, or by a configured project or label
  match. It pulls only the routed issues, changed since the last good pull, into `bd`. The
  loop never pushes. The Linear API key comes from a secret broker's Connect-style REST API,
  read at run time. It reads the broker's 3 header values by env (`OP_CONNECT_TOKEN`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) or from the macOS Keychain service
  `claude-factory`. The key never sits in a committed file. `bd linear pull` copies the `factory` and `station:*`
  labels onto each pulled bead. The loop strips both labels. A failed strip holds dispatch,
  so a Linear label can never pick a run's start station or start a run before the person
  adds the `factory` label. `factory rig` and the console Rigs tab show each rig's last
  pull time, its pulled, skipped and unrouted counts, and its last error. Each new error
  reports once, not on every tick. See `docs/beads.md` for the full design.
- Fixed: the worker `PreToolUse` hook in `src/worker-hook.ts` (claude-factory-cr6)
  denied only `rm -r`/`rm -rf` and a `cd`+`rm` chain. A worker can still run a plain
  `rm` on a `$variable` path or a glob, or on a path outside the worktree. One such
  run (`rm -i "$TMPDIR_EVAL"/*`) stalled about 2 minutes on Claude Code's own
  "possibly-empty variable path" prompt. Nobody answers that prompt. Claude Code
  denies the command on its own, after the delay. `denyReason` now also denies any
  `rm` (with any flags, or none) whose operand has one of these: a `$` or `~`
  expansion, a glob character (`*`, `?`, `[`), or a path outside the worktree root.
  `main()` picks the root from `CLAUDE_PROJECT_DIR`, then the hook input's `cwd`,
  then `process.cwd()`. The reason text stays the same one `REASON` constant. The
  hook still only denies a command; it never approves one. (claude-factory-99d)
- The console's Interview tab now shows a short item for each question. Each item has a
  title (the run or bead id, and the decision in plain words). Each item has one line of
  context, and 2-4 options. Each option has a label and an effect. A `details` toggle holds
  the full raw report; the item itself does not show it. The manager can mark one option
  "(recommended)". With no marked option, no option stands out. Items that ask the same
  decision fold into one row: the same bead, or the same question in the same rig. One answer
  to a folded row answers every run or bead in it. `factory decisions propose` now takes an
  optional `--context` sentence. It refuses a question over 160 characters, a context over
  200, fewer than 2 or more than 4 options, a label over 40 characters, an effect over 100, or
  more than one recommended option. On a refusal, `decisions.json` stays unchanged. The
  `[factory] interview` prompt, the manager's system prompt, the blocked-run brief and
  `repeatQuestion` all ask for this same shape. (claude-factory-9f6)
- Fixed: a bug let the pkg-gate's Go sumdb floor (`refreshGoFloor` in `src/pkggate.ts`) rise to near `now` in one refresh. The floor then stayed there until the pod restarted. An attacker who owned all 9 sampled `index.golang.org` entries could log each one in `sum.golang.org` right before a refresh. The old `Math.max(old, new)` ratchet then kept that high floor. Each refresh now stores the `sum.golang.org` tree size it read before lookups (`goFloor.latest`). It caps the floor's rise at `prev.record + 3 * max(0, latest - prev.latest)`. This cap is 3 times the real sumdb traffic since the last refresh. The `Math.max` ratchet is gone, so a refresh can also lower the floor. A lower floor only refuses more versions. The cap limits one refresh only. Two follow-ups stay open. A sustained attack can still raise the floor across many refreshes (claude-factory-ldb). The first refresh after a pod start has no cap yet (claude-factory-b9f). (claude-factory-56j)
- Fixed: a worker ran `rm -r`/`rm -rf` on its own `.scratch/` folder. The prompt rule in
  `src/worker-system.md` (claude-factory-9wu) did not stop this. The worker then
  waited about 2 minutes on Claude Code's own permission prompt, which nobody answers,
  until Claude Code denied it on its own. New `src/worker-hook.ts` adds a
  `PreToolUse` Bash hook, `denyReason(command)`, that denies the command at once, with
  one reason:
  - It tokenizes the command (quote-aware). It denies a recursive `rm`, or a `cd`
    segment paired with an `rm` segment in one command.
  - It checks inside a `sh`/`bash`/`zsh -c` string, and inside the command after
    `find`'s `-exec`/`-execdir`.
  - It only denies a command. It never approves a command that Claude Code's own
    prompt would refuse.
  - `workerSettings()` (herdr workers) adds this hook as the last `PreToolUse` entry,
    after the user's own hooks, so a secret guard such as ctxguard still runs first.
  - `vmClaudeFlags()` (AX/VM workers) runs the same hook from the VM image's own copy,
    at `${ax.FACTORY_DIR}/src/worker-hook.ts`. `Dockerfile.worker` already ships `bun`
    and `src/`, so the image needs no change. (claude-factory-cr6)
- CI and releases now run on their own, with no hand edits. `.github/workflows/ci.yml`
  runs 4 required checks on every pull request and on `main`. `test` runs
  `bun test --timeout 30000 src factories`; `PKGGATE_E2E_REQUIRE=1` makes a missing
  go/npm/pip/uv/python3/zip on the runner fail the test by name, instead of skipping it.
  `plugin` runs `claude plugin test mod`. `typecheck` runs `tsc --noEmit -p .`; it skips
  `tsc -p mod`, because that command needs `mod/.claude-plugin/types/`, a directory that
  only a live Claude Code session writes. `format` runs `prettier@3.9.9 --check .`. The
  repo now commits `.prettierrc` and `.prettierignore`, and pins `prettier` as an exact
  `3.9.9` devDependency. `src/release.ts` bumps `package.json` and
  `mod/.claude-plugin/plugin.json` together, and moves the CHANGELOG's `## Unreleased`
  section under a new version heading. It refuses a version mismatch between the two
  files, an empty Unreleased section, and an existing tag. A person starts a release from
  the Actions tab: `release.yml`'s `workflow_dispatch` takes `bump: patch|minor|major`
  and `dry_run`, and opens pull request `release/vX.Y.Z` with that bump already made.
  The person merges it with `gh pr merge --match-head-commit <SHA>`; this command
  refuses the merge if the branch moved past the SHA the checks ran on, so no unchecked
  commit can reach `main` this way. After the merge, `release-tag.yml` tags the merge
  commit and publishes the GitHub release on its own. gitsign, Sigstore's keyless
  signer, signs each new tag through the workflow's own GitHub OIDC identity; this
  public repo stores no signing key. `factory self-update` (new `src/selfupdate.ts`)
  fast-forwards the checkout that holds `bin/factory` to `origin/main`. `tick()` runs it
  at most once every 5 minutes. It refuses a dirty tree, a diverged branch, a non-`main`
  branch, or `FACTORY_SELF_UPDATE=0`. [docs/releasing.md](docs/releasing.md) has the
  full recipe. (claude-factory-5h9)
- Fixed: `claude plugin test mod` has no `--timeout` flag, so each test used the kit's fixed 5000 ms limit. At a shared-host load average over 100, some async tests (the ones that call `$` or `on`) failed with `Error: timed out after 5000 ms`, with no code change. This happened in `mod/tests/prs.test.tsx`, `rigs.test.tsx` and 5 other test files: `backlog.test.tsx`, `board.test.tsx`, `gate.test.ts`, `interview.test.tsx` and `tabs.test.tsx`. These 7 files' 30 async tests now pass `{ timeoutMs: 30_000 }` as the kit's `test()` second argument. (claude-factory-abm)
- A rig's devenv can now declare services (`devenv.nix`'s `services.postgres`, say) and get them started. `worker serve` reads the devenv's process list from `DEVENV_TASK_FILE`. It starts each process directly, never through `devenv up`, which would run `enterShell`. It starts each process's own `after` dependencies first, and waits on each one's readiness probe before it. It merges each process's own `env` field over the serve env, for the spawn and the probe. It builds an HTTP probe's URL from devenv's `{host,port,path,scheme}` object. When the devenv does not already set `DATABASE_URL`, `serve` sets it for the agent. The first turn's brief gets a `[factory] services: ...` line that names each process as ready or failed. `FACTORY_SERVICES=0` turns this off for one rig. `FACTORY_SERVICES_WAIT_MS` changes the readiness budget (120000 ms by default; a non-numeric or non-positive value falls back to it instead of blocking the first turn forever). (claude-factory-5sn)
- Fixed: a worker's cleanup command (`rm -rf`) and a `cd <dir> && ...` chain outside the worktree triggered Claude Code's own permission prompt. Nobody answers this prompt. An unattended worker waited up to 2 minutes, then got denied. `worker.excludeScratch()` (`src/worker.ts`) now adds `.scratch/` to `<git-common-dir>/info/exclude`. It adds the line only once, and keeps any existing lines. `createRun` (`src/cli.ts`) calls it right after `herdr worktree create`. The AX clone (`src/worker.ts`) calls it right after `git clone`. `src/worker-system.md` now tells a worker to keep scratch state in `.scratch/` inside the worktree. It tells the worker never to chain `cd` with another command, and never to run `rm -rf`. It tells the worker to use `git -C`, `go -C` or an absolute path instead. It tells the worker to make a fresh `.scratch/<new-name>` in place of a cleanup. (claude-factory-9wu)
- Fixed: `src/devenv.test.ts`'s isDue cache-key test spawns about 18 real git processes (init, commit, clone, fetch). At a shared-host load average of 40 it took 5.1-6.7s, past bun's default 5000 ms per-test timeout. The test now passes `30_000` as `test()`'s third argument, the same pattern `src/remote.test.ts` uses for its own real-git test. (claude-factory-fpf)
- Fixed: `waitReady`'s http ready probe (`src/worker.ts`) called `fetch()` with no signal. A probed port can accept the connection, then never answer. This can block one `fetch` call past `FACTORY_SERVICES_WAIT_MS`. The first turn then waited longer than its documented budget. The http probe now passes `signal: AbortSignal.timeout(4000)`, the same 4s budget the exec probe already had. The wait loop now reads elapsed time after each probe, not before it. A timed-out probe now counts at once, not on the next 1s tick. (claude-factory-iap)
- Fixed: the pkg-gate's `/go/sumdb/*` passthrough (`handleGo` in `src/pkggate.ts`) forwarded every request to `cfg.upstream.go` (`proxy.golang.org`), a host that no longer serves `/sumdb/`. Any non-2xx became a hard 502, and a gated Go task with the default `GOSUMDB` can verify no module: the egress policy strips `sum.golang.org` from a gated task, so it cannot fall back there either. The gate now answers `/supported` itself, with no upstream fetch, and forwards `latest`, `lookup/*` and `tile/*` to `cfg.upstream.sumdb` (`sum.golang.org`) with `redirect: 'manual'`. Any other db name or sub-path gets a 404, with no fetch. (claude-factory-1hc)
- Fixed: two deploy stations did live steps that the rig's goal reserved for the
  person. `ax-768` pushed images and ran `kubectl apply` on the live cluster.
  `claude-factory-5h9` made a GitHub ruleset and changed a repository setting. The
  root cause: no worker brief carried the rig goal. A station had no way to see
  which steps to skip. `ruleLines(def, rigGoal)` (`src/cli.ts`) now adds this goal to
  every worker's brief, in a new "## Rig goal" section right after "## House
  rules", when the rig has a goal. A run with no rig, or a rig with no goal, gets
  the same brief as before. `factories/lifecycle.ts` and `factories/release.ts`
  each add one house rule. It marks these steps owner-only: a hand-run change to a
  live system (`kubectl apply`/`patch`/`scale`/`delete`/`rollout restart`, `helm`
  or `terraform apply`); an image push to a production registry; a
  branch-protection or ruleset change; a repository or organization setting; or a
  credential, secret or token change. A station runs an owner-only step only when
  the run's bead or the manager's factory mail says the person approved that exact
  step. Otherwise, the station does every other step, then reports blocked with
  "parked, waiting on: \<the owner step and the exact command\>". The lifecycle
  deploy prompt and the release rollout prompt each add a line: a merge approves
  the change it carries, not an owner-only step. (claude-factory-9gx)
- Added: a hidden `pm` subagent ranks each rig's next work and flags starved epics,
  so the backlog patrol's rule 5 (start something when a rig has room) picks the
  most important work first instead of plain bd order. It wakes once an hour, and
  again soon after a run finishes (`pmDue`, `mod/hooks/view.ts`), spawned the same
  way as the patrol (`$.agent.register`/`spawn`, `factory:pm`, no tool at all: it
  can read and rank only the facts its own prompt carries, never run `bd`, read a
  file or edit one itself).
  `factory plan facts|set|show` (`src/cli.ts`) gathers each rig's ready beads, goal,
  open epics and recent closes; validates the pm's answer; and writes
  `<home>/plan.json` (`writeJson`, tmp+rename) plus one line per run to
  `<home>/pm-log.jsonl`. `dispatch()` (`src/cli.ts`) and the patrol prompt
  (`mod/hooks/view.ts`) use the plan's order when it is under 2 hours old;
  missing, corrupt or stale, both fall back to today's plain bd order, unchanged.
  `rankPlan` and `orderByPlan` (`src/plan.ts`) keep the pm inside the owner's
  existing priority bands: it reorders only within one priority, and a planned
  bead never passes a numerically lower (higher-value) one. A starved epic (no
  new work for `starveHours` hours, 24 by default, while lower-priority work
  shipped) and a goal with no open bead both become findings that `plan set`
  files as a `human`-labeled bead (`beads.ts` `fileFinding`), an Interview-tab
  decision item like a proposal. A plan gap (a done epic still open, or a goal
  with no bead in the plan at all) files as an unlabeled bead instead, for a
  person to triage. `plan set` dedupes each finding by `pm_finding` metadata,
  capped at 3 new beads per rig per run. Any P0/P1, goal or owner-only change is only
  ever proposed, also as a `human`-labeled decision item in the Interview tab:
  nothing applies it. The console's Rigs tab
  shows each rig's top 3 next-up items and its findings; the header and the band
  show the plan's own age, or "plan stale" past 2 hours. `pm` in the plugin's
  `userConfig` turns the pm off. (claude-factory-dun)
- Rollback: `pm`'s `userConfig` default is now `false` (`mod/.claude-plugin/plugin.json`).
  (claude-factory-dun)
  - Cause: a manager session already running when PR #58 merged (4f695d1) never re-ran its
    `session.start` hook, so it never called `$.agent.register('pm', ...)`. A hot reload
    picks up most code changes, but not that call. `pmNow()` inside `tick()` is not
    `session.start`-gated, so it kept calling `$.agent.spawn('pm', ...)` every
    `PM_RETRY_MS` (60 s), forever, against an agent type the engine never learned. 56+
    minutes after the merge, `<home>/plan.json` and `<home>/pm-log.jsonl` had never once
    appeared, while `<home>/plan-facts.json` kept churning on every retry.
  - Fix: the `userConfig` schema's declared default flips from `true` to `false`
    (`mod/.claude-plugin/plugin.json`). A manager process reloads `plugin.json` on every
    file change under `mod/` and recomputes `options.pm` from it each time (no stored
    override existed), so this stops `pmNow()` at its own `if (!rt.isPmEnabled) return`
    guard without a process restart. This bullet touches no pm code or test; all pm tests
    still pass. A person sets `pm: true` to turn it back on, once a real fix (the manager
    process restarts, or agent registration runs on every hot reload too) closes the
    `session.start` gap.
- `decide()` now archives a never-shown short note after 14 days, caps how many
  notes one tiering pass can archive, and logs the plan before it writes
  anything. (claude-factory-503.2)
  - Cause: a tiering pass only archived a note at `helped===0` and 30 days old.
    A note nobody read, but nobody marked unhelpful either, can sit for up
    to 30 days, then age out all at once. One pass already archived about 190
    notes in one go; a person had to revert an earlier 139-merge pass for the
    same reason.
  - Fix: `decide()` (`src/memory.ts`) adds a 14-day never-shown rule: a short
    note with `shown===0` and `helped===0` at 14 or more days old archives,
    with the reason "never shown, N days old". Both this rule and the
    existing 30-day `helped===0` rule stop while `opts.historyDays` (the
    oldest usage record's age) is under 14 days, so a store with little usage
    history archives nothing on either rule; a `superseded` archive is exempt
    from this guard. `applyTiers()` (`src/memory.ts`) now caps archives at
    `opts.archiveCap`, 25 by default, or `FACTORY_MEMORY_ARCHIVE_CAP` (a whole
    number 0 or more; any other value falls back to 25). The cap keeps the
    oldest notes first, by `ageDays` descending and tied by path; a note past
    the cap becomes a new `held` decision instead, with the reason "over the
    archive cap of N this pass", and the cap counts `superseded` archives
    too.
  - `applyTiers()` now calls a new `onPlan(lines)` callback, built from the
    new `planLines()` export, once right after `decide()` and before any
    write or `rmSync`, on a dry run and on an empty plan as well. `dream()`
    and `factory memory compact` (`src/cli.ts`) both append this plan to
    `dream.log` before the pass applies it, and `--dry-run` prints the cap
    and the held count.
- A memory home's `.usage.jsonl` now survives in git, and a dream or
  `factory memory compact` no longer leaves the memory repo dirty.
  (claude-factory-503.3)
  - Cause: the memory `.gitignore` `dream()` writes (`src/cli.ts`) ignored
    `.usage.jsonl*`, so the append-only usage-count file (about 72 KB) never
    joined a commit. `memory.compact(renamed)` also ran after each dream or
    compact commit, so its rewrite of `.usage.jsonl` and its append to
    `.renames.jsonl` (`src/memory.ts:572-602`) always left `git status`
    dirty right after the commit that was meant to close out the pass.
  - Fix: the gitignore line is now `.index.json*\n.usage.jsonl.tmp\n`, so only
    `compact()`'s crash-safe temp file stays ignored and `.usage.jsonl` joins
    git. `dream()` (two commit sites) and `factory memory compact` now call
    `compact()` before `git add -A` and the commit, not after, so its writes
    land inside that same commit. The dream commit's rename map now reads
    `git diff -M --name-status --cached` against the staged index instead of
    `HEAD`, since no commit exists yet to diff against at that point.
  - Migration: a home with the old gitignore and an untracked `.usage.jsonl`
    starts tracking the file on its next dream.
- Fixed: the worker `PreToolUse` hook's `rm` guard can time out and fail
  open. `anyShellReason` (`src/worker-hook.ts`) recurses into `denyReason`
  once for each stacked `eval` or `sh -c` level, with no depth limit, and the
  8192-character length cap only fired when a rig passed `personOnly`.
  (claude-factory-epz)
  - Cause: `denyReason('eval '.repeat(4000) + 'rm '.repeat(4000) + '; rm -rf
    x')` with no `personOnly` took about 4 seconds at 32 KB, and grew 4-6x
    per doubling. Past the hook's 10-second timeout (`src/cli.ts`), a
    PreToolUse hook that times out lets the command run, so the `rm` guard
    had no bound on every rig that does not pass `personOnly`.
  - Fix: `denyAt(command, root, personOnly, depth)` now threads a `depth`
    through all 3 recursion sites and denies past `MAX_SHELL_DEPTH` (32),
    before the length check, so the limit applies with or without
    `personOnly`. The 8192-character cap stays. The cap's own wording now
    says "characters", not "bytes": `command.length` counts UTF-16 units.
    README.md gained one sentence on the 8192-character deny.

## 0.12.0 (2026-10-15)

- Memory: factory memory now tiers after each dream, instead of growing one small file per lesson forever. `<topic>/LONG.md` holds the long tier (one `## summary` heading and a stable `<!-- id: ... -->` per merged entry); `CORE.md` bullets are indexed as fact notes. A pure `decide()` (`src/memory.ts`) picks what to merge, archive, promote or flag as a possible duplicate; `applyTiers()` runs it for real, merging a shown-or-helped short note into its topic's `LONG.md` once it is 7 days old and archiving a never-helped, 30-day-stale or `superseded:` note into `.archive/<topic>.md`, with no usage lost (`compact()`'s rename log now follows a chain and a `#id`). `factory dream` runs this pass itself right after it commits, in its own `compact: N merged, M archived, F files -> G files` commit, unless `FACTORY_MEMORY_TIERS=0`; `factory memory compact [--dry-run]` runs it by hand. The dream prompt names the tiers and now lists promotion candidates (a `LONG.md` entry helped across 3+ runs) and possible duplicates (two `LONG.md` entries scoring the same by `longSimPairs()`) for the dream to act on. `factory memory eval` scores search (recall@5, MRR) against a fixed query set, to check tiering did not cost search quality. (claude-factory-59r)
- Fixed: the manager's heartbeat patrol (`patrol()` in `mod/hooks/view.ts`) woke the manager's Opus session on every due tick. It did this even when the board and rig goals had not changed. About 70% of patrols were "Heartbeat: nothing new". `patrol()` now builds a `sig` of the board and rig goals. The `sig` ignores elapsed-time facts, such as time in station and the quiet minute bucket. `patrol()` now returns null on a due heartbeat when there is no mail, no new blocked worker and no new idle rig, and the `sig` equals the last one sent. An unchanged board still goes out in full once an hour. This way a manager that compacted the board away gets it back. When a patrol does wake the manager, a short per-rig summary now comes first, ahead of the news line. One example is `Rigs: web busy 2/3, 1 at the person, 1 stuck; api busy 0/2.` This way, compaction that trims the end of the message keeps the summary. `mod/hooks/register.tsx` renames `rt.board`/`rt.boardAt` to `rt.sig`/`rt.sigAt`. (claude-factory-7ol.5)
- Fixed: the Go age gate (`src/pkggate.ts`) no longer trusts `.info` `Time` alone. A module's author controls that time and can backdate it. The gate now also checks when `sum.golang.org` first logged the version, against a floor it builds from `index.golang.org`. It refuses a version whose sum.golang.org record is newer than the floor, even when `.info` `Time` alone looks old enough. New env vars: `PKG_GATE_UPSTREAM_SUMDB` and `PKG_GATE_UPSTREAM_GO_INDEX` (`https://sum.golang.org` and `https://index.golang.org` by default). `/healthz` now reports the floor. The gate's namespace needs new egress to both hosts. (claude-factory-8ub)
- Fixed: a flood of lookups could push the Go age gate's sum.golang.org floor upward, toward sum.golang.org records the flood itself had just logged. The gate now reads sum.golang.org's current tree size first. It drops any sample at or past that size. It takes the minimum of what is left, not a median. A decision with a present floor no longer waits on the refresh it triggers. That refresh runs in the background instead, and backs off (30s, doubling up to 10 minutes) after a failure. A sumdb lookup now Go-case-escapes an uppercase version everywhere. `@latest` caches its own sumdb record instead of repeating the lookup on every request. (claude-factory-8ub.6 through 8ub.11)
- Fixed: the Go age gate cached a version's `.info` only when its raw `.info` body `Version` matched the request's escaped path segment exactly. An uppercase prerelease (`v1.0.0-RC1`, escaped `v1.0.0-!r!c1`) never matched, so every request for it repeated both the `.info` fetch and the `sum.golang.org` lookup. The gate now escapes the cached `Version` before comparing. (claude-factory-8ub.13)
- Docs: [docs/onboarding.md](docs/onboarding.md) takes a new developer from install to a first finished run, and then to the next steps. It is written in ASD-STE100 Simplified Technical English. README links it.
- GitLab rigs: workers, labels, parks and VMs. A worker on a GitLab rig gets a Forge note in its brief (`forgeNote` in `src/prs.ts`) that maps `gh pr ...` to `glab mr ...`; a GitHub rig's brief is unchanged. `labelPass` lists a GitLab rig's labeled merge requests through `glab api` (`parseGitlabLabeled`), then comments, unlabels and closes with `glab mr note/update/close`. `watchPass` also wakes a station parked on GitLab merge request URLs. For an `ax` rig on GitLab host H, the egress policy replaces `PRIVATE-TOKEN` with vault key `GITLAB` and `Authorization: Basic` with `GITLAB_BASIC`, and the VM gets `GITLAB_TOKEN`, `GITLAB_HOST=H` and a second git extraHeader. The owner adds `GITLAB` and `GITLAB_BASIC` to the vault and rebuilds the worker image (`Dockerfile.worker` now installs `glab`). `factory devenv` still fetches with a GitHub header, so a private GitLab rig has no cached devenv.
- Docs: new console screenshots, one per tab (Board wide, narrow and with one card open, Backlog, Mail, Rigs, PRs, Interview), made from demo data and shown in README's Console section, which now has a short subsection for each tab. The old `console-tabs.png` montage of the removed 8-tab layout is gone.
- Fixed: a VM worker's `factory report` hard-refused every outcome on a `bd dolt pull` merge conflict in `dependencies`. This happened even when the only unshared write already matched upstream. `worker.syncBeads()` (`src/worker.ts`) now retries a conflicted pull with `bd dolt pull --strategy ours`. This strategy keeps the VM's own row and lets the push go through. It prints a one-line notice only when the retry clears a real conflict. (claude-factory-c2c)
- The report refusal in `src/cli.ts` now names the failed `bd dolt` step and bd's last error line (URLs redacted, 300 chars). If a manual `bd dolt pull && bd dolt push` fails again, the message tells the worker to mail the manager. (claude-factory-c2c)

## 0.11.0 (2026-10-15)

- Console: on a wide Board the runs awaiting you take a full-width band above the other three columns, so they sit on top and a gate's question and buttons have room. Each card now also shows its rig, its goal beside the bead, its try, how long ago it last reported and a usage-limit wait; the run id is shown whole where the card is wide enough. An open card has a `-` button at its top to shrink it back, besides the `close` at the bottom of its Steer row.
- A pane worker now gets the user's `asd-ste100` plugin alone, if the user turns it on. `workerSettings` (`src/cli.ts`) copies only `enabledPlugins` entries whose key starts `asd-ste100@` and whose value is `true`. Its hook and skill teach the worker to write PR text, commits, bead comments and reports in ASD-STE100. `WORKER_TOOLS` now lists `Skill`; `disableBundledSkills` keeps its cost at `+1.2k tokens/turn`, not `+2.2k`. `src/worker-system.md` tells a worker to load the `asd-ste100` skill before a long piece of text. A VM (`ax`) worker still lacks the plugin and its env; `claude-factory-fxu` tracks this gap.
- Console: the Board lays the live runs in four columns by state: `? AWAITING YOU`, `! STUCK`, `● WORKING` and `◷ WAITING`, each run in one (the state the header and status line count) and each column oldest first. Cards are compact: a shortened run id (`mv4y…yjy4`), the bead, the station with its time (`quiet 40m`, `wakes 14:20`) and one line of why. From 120 columns the columns sit side by side, empty ones kept as `none`; narrower they stack as titled sections without the empty ones. Gates are still answered on their card. `open` expands the full card below the columns, or in place when stacked.
- Console: the Backlog is the bead tree and the Rigs tab alone shows rig status. Each rig is one rule (`── api · busy 2/2 · 3 queued · 41 waiting ──`) with no goal or repo header. A parent shows `[done/total]` of its children and starts collapsed behind a `▸`/`▾` toggle (kept in the console's draft), its children hang from it with `├─`/`└─`, and a bead held back by an open bead shows `⛔ <blocker id>`. A rig's `backlog` button on the Rigs tab opens the Backlog on that rig, with an `all rigs` button to clear it. `factory backlog` adds `children` and `blockedBy` to each bead, and lists blocked beads: two more `bd` calls a rig (`bd blocked`, `bd list --all --brief`), none per bead.
- Console: a row's ids, badges and times keep their width and only its free text truncates, so the Backlog no longer breaks a bead's priority and id across lines (`P` then `0`, an id cut in two). Bead ids are padded so titles start in one column. A row repeats its priority only when it differs from its tier's, and a bead with none shows `–`, not `P2`. The same rule holds in the Finished, Mail, Interview, PRs and Rigs rows, and ids there are cyan as on the board.
- Console: the status line, header and band count runs the same way, each run in one state. The status line reads `5 working (api 2, web 3) · 1 awaiting you · 1 stuck` instead of `7 running`. The header no longer subtracts a gate that is also stuck twice.
- Console: a failed tick says `factory tick failed:` with 160 characters of its reason instead of 80, and the header shows `! stale since HH:MM` until a tick succeeds.
- Fixed: the Backlog tab held the board's ticks. Its ~20 s `factory backlog` ran on every tick and the tick waited for it, so with the tab open the board and patrols updated about every 25 s. The tick no longer waits on tab fetches, and the backlog is listed at most every 30 s, at once when the tab opens or after a queue or start.
- `factory prs` and the console's PRs tab track GitLab merge requests for rigs whose origin is GitLab (gitlab.com, a host named for it, or one `glab` is signed in to), through `glab api`, next to GitHub PRs through `gh`. MR URLs in reports and mail are picked up, and a merge request's state, draft, approvals, pipeline and merge status fill the same fields; its record carries `forge: "gitlab"` and the tab names it `group/project!7`. Workers still open and watch PRs with `gh` only.
- Docs: [docs/console.md](docs/console.md) breaks down every console tab (Board, Backlog, Mail, Rigs, PRs, Interview) with what it shows, its data source, a key/button table, and when to use it; README's Console section now links it.
- Fixed: a worker can delete lines from its own `outbox.jsonl`, for example to hide a probe. This also hid every later report. The old reader counted outbox lines in a cursor. A delete moves later lines below that cursor, so they never replay. (claude-factory-4x1)
- `src/cli.ts` now replays an outbox by a content hash of each line, not a line count. A duplicate line still replays twice. The run gets one notice when consumed lines go missing. An in-flight task's old line-count cursor migrates to the new scheme on its next poll. (claude-factory-4x1)
- Fixed: `factory report|mail|memory add` inside a VM worker queued `--help` and malformed calls as real outbox entries. `worker.outboxUsage()` in `src/worker.ts` now prints usage for `--help`/`-h` and exits non-zero on malformed args. Neither case touches the outbox. (claude-factory-4x1)

## 0.10.0 (2026-10-15)

- Fixed: `factory status`, `waiting` and `show` (the console's Run view) exited 1 on the first AX run whose server they could not reach, such as when the `ax-server` port-forward has died, listing nothing past it. That run's agent now reads `unreachable: <error>` and the rest of the listing still prints. The tick already caught this.
- Fixed: `factory memory add` caches the summaries' vectors beside the full-text ones, so it embeds only its own summary, and embeds in batches of 32. Embedding every summary in one batch on each add took over 7 minutes at 436 notes (28 s batched, 0.5 s cached), and the tick that replays a VM worker's add was killed at its 120 s limit before finishing, so every tick failed with a `$.process.run` HooksError and that outbox line was retried forever.
- Fixed: `factory worker poll` gave an AX worker still mid-turn no progress (`tail: null`, no session) because `serve`'s `turn()` buffered a harness's whole stdout and only read its session id after the process exited, so a 30-90 minute `claude -p` turn left `state.json`'s session unset for its entire run. The reconcile stall rule (`src/cli.ts`) then read an empty, unchanging fingerprint and nudged or failed a worker that was actually committing. `worker.ts` now streams `turn()`'s stdout and fires `onSession` the moment the init event appears; `lastTurn()` falls back to the live stream copy (`own()/<harness>.jsonl`) when the project transcript isn't there yet; `poll()` adds the worker's repo HEAD and live-stream byte count, and the stall signature is built from tail, HEAD and bytes together (head alone, or a non-streaming `pi` harness's byte count, no longer counts as a fingerprint, so local codex/pi/script workers and an AX `pi` worker stay exempt the way they were before).
- The console's Run tab is gone: pressing a board row's `open` now expands that run in place as an accordion card, drawing everything the Run tab did (goal, follows-factory/branch line, from-station edges, error, gate, Steer's mail/station/goto/fork/retry/jump/abort, the Tasks bar, the last 8 Journal entries and unread-inbox line, and the Worker pane peek), and `close` (hotkey `b`) collapses it; only one card is open at a time. The console is 6 tabs on hotkeys 1-6 (Board, Backlog, Mail, Rigs, PRs, Interview); the footer reads "1-6 views". `/factory run <id>` and a persisted `view: 'run'` both still open that run's card on Board instead.

## 0.9.0 (2026-10-15)

- The console's New run tab is gone: runs are started from the manager session or Backlog's `queue`/`start`, which this tab never fed into, and its only other caller was the Rigs tab's now-removed 'new run here' button. Rigs, PRs and Interview move down to hotkeys 5, 6 and 7.
- Fixed: `factory start <factory> <rig> <bead-id>` filed the bead id as a brand-new bead (titled after the id, with no description) and started a run on it instead, whenever its lookup of the existing bead failed for any reason other than a genuine not-found — including a `bd create`/`bd show` i/o timeout against the shared Dolt server, which also made some attempts exit 0 after creating the bogus bead. `beads.ts`'s `lookup()` now tells bd 1.3.0's real not-found (`Issue <id> not found`) apart from a query-time failure or a store-open failure (both of which can print the same not-found-shaped JSON body on stdout) and throws on the latter two; `beadFor()` in `cli.ts` fails the start instead of creating a bead when a bead-ID-shaped goal's lookup throws, or when it is genuinely not found under this rig's own prefix. `create()` now tags each attempt with a `factory_create` metadata token and checks `bd list --metadata-field` for it before retrying once on failure, so a retry can no longer create a duplicate bead. A failed start always exits non-zero.
- A VM runner's dependency age gate is no longer a PATH wrapper a worker can route around with `nix shell nixpkgs#go -c go get ...`: `factory pkg-gate serve` (`deploy/pkg-gate.yaml`) is an in-cluster Go/npm/PyPI registry proxy that refuses a version younger than `PKG_GATE_MIN_DAYS` (4 by default), failing closed on an upstream error or a missing publish time. `FACTORY_AX_PKG_GATE=<scheme://host[:port]>` makes it the only registry host a task's `EgressPolicy` allows (every other registry host is stripped, even one a rig lists directly), sets the common `GOPROXY`/`*_REGISTRY`/`*_INDEX`/`UV_*` env vars at it for convenience, and adds matching `--repo_env` flags to a Bazel rig's `.bazelrc`. `factory rig add --egress` now warns when a listed host is a registry one of these would strip. See docs/remote-runner.md, "Package age gate".

## 0.8.0 (2026-10-14)

- Fixed: dispatch synced each rig's beads with `bd sync`, which pulls and pushes as the laptop Dolt server's own `root`, so a remote that needs a login (a shared Dolt server) was refused every interval and the rig's claims never reached other machines. A rig with `beadsRemote` set now syncs through SQL as that remote's user (`CALL DOLT_PULL/DOLT_PUSH('--user', …)`), the way VM runs already did. The laptop's Dolt server must hold `DOLT_REMOTE_PASSWORD` in its environment.
- Every worker's system prompt (`src/worker-system.md`) now names `mktemp -d` as the place for scratch files (never a bare `/tmp_<name>` at the filesystem root, which two workers typed for `/tmp/<name>` on 2026-10-12 and then had a silent `cp ... 2>/dev/null` hide the failure) and says a mutation check restores the original with `git checkout -- <file>`, never a `cp` backup.
- Fixed: a worker pane's launch line was typed into the shell key by key, so any `jk` substring in it (a run ID, worktree path or prompt-file path) fired zsh-vi-mode's insert-mode escape mid-line, leaving stray characters and a continuation prompt; the station then failed with "the worker never started". `src/harness.ts` now writes the real launch command to a 0600 script (`writeLaunch`, `<FACTORY_HOME>/launch/<pane>.sh`) and `src/cli.ts`'s `typeLaunch` types only the fixed `LAUNCH_LINE` into the pane (launch, in-pane resume, and relaunch's retype), so no run-specific text is ever typed into a worker's shell.
- An AX worker whose turn ends on the egress gateway's SAN-verification outage to `api.anthropic.com` (envoy flag `UF`, `cx_connect_fail` on `egress_forward_proxy`) now retries the same session with backoff instead of failing the attempt: `egressFailure` in `src/worker.ts` detects the signature for Claude, Codex and Pi, `serve` retries within a budget (`FACTORY_EGRESS_WAIT_MS`/`FACTORY_EGRESS_BUDGET_MS`) that spans the whole outage rather than resetting per turn, and `poll`/`WorkerInfo` surface it. `reconcile` mails the manager once per outage (keyed per run and node) and, if the outage outlasts the budget, fails the attempt with a named reason instead of the generic "worker stopped without reporting". The upstream fix (Substrate's `ate-system/atenet-egress`) is tracked separately as claude-factory-ue9; see `docs/remote-runner.md` for the signature and the manual workaround.
- The console's PRs tab (7) now shows every pull request a run touches, not just an open one on its own `factory/*` branch in the run's own rig: each run keeps `runs/<run>/prs.json` (url, repo, number, role, first-seen station), filled from reports and mail and refreshed from `gh` (draft/open/merged/closed, review decision, checks) with a backoff on repeated failures. Merged and closed PRs stay listed until the run is removed, drafts are marked, and companion PRs in other repos (and PRs on other branch names) are no longer dropped.
- A rig with room, no goal and no ready `factory` beads gets a row from dispatch (`idle: no goal, no ready beads`) that the board shows as idle, and the patrol tells the manager once per rig instead of dropping it, so a rig left with nothing to do is noticed without waking the manager every heartbeat.
- The manager's patrol board gives each working run its facts: `- r1 (rig web) at implement/working, attempt 2/3, 30+ min in station, quiet 10+ min, runner paused by its usage limit until 14:00: goal`. `factory tick` rows carry them as `inMin`, `quietMin` and `limitUntil`. Minutes are floored to 10 so an unchanged board is still sent once.
- A station whose attempt fails by going silent (no report in time, or stalled) the same way as the attempt before it is held `stuck` at once, spending no further attempt, with a question for the console's Interview tab (`retry` or `abort`) instead of a third identical try.
- A worker that is `working` but shows no new output (its transcript tail and local branch head unchanged) for 20 minutes is nudged once; after 20 more its attempt fails as `stalled: no output for N min` and the manager is mailed the station, run, minutes and last line. Before, a hung turn counted as working until 1.5 times the station's limit. The fingerprint is kept in the run's `progress.json`, so a restart does not reset it.
- The console's Backlog tab groups each list by priority (P0 first), filters by bead type (all, bug, feature, task, epic, chore), and draws a bead's children indented under it. A type filter keeps the beads of that type with their children; a child whose parent is elsewhere stands at its own priority. The unqueued list stops after 15 rows without splitting a parent from its children.
- Fixed: AX workers never started since v0.7.0 moved them to a non-root `worker` user: the laptop's own `ax ssh` calls (`poll`, `prompt`, `put`) still ran as root, which has no `DAC_OVERRIDE` over `.factory-worker` (owned `worker:worker`), so `put` hit `EACCES` and the brief, sent only that way, never landed; `serve` then died waiting for it with no attempt ever starting. `ax ssh` commands now run through `setpriv` as `worker` by default (bare when `FACTORY_AX_CAPABILITIES` is empty). A `put` that still fails is retried for 5 minutes, then fails the attempt with ax's error instead of running out the station's time limit silently; a task gone because `serve` exited now fails with its log, not just "worker pane … was closed".
- The Interview tab's 'Interview me' button asks the manager to sweep every live run and rig, plus bd, for open decisions a run can't settle on its own — gates awaiting an outcome, workers blocked on a permission prompt, parked or stuck stations, and pending bd items (`bd human list`, owner-only beads) — and list them alongside worker-raised questions. A bare bd question with no options gets the manager's own proposed options (`factory decisions propose`), and the person's answer flows back the same way today's answers do: a gate decides only through its own outcome button, a bd item is answered or started through `factory decisions answer`/`factory start --owned`, and both of those, like `factory decide`, now need the person's explicit Allow before the manager session can run them.

## 0.7.0 (2026-10-14)

- A release factory waits for a release's pull requests to merge, then cuts the release and rolls it out the way the repo does it. A recipe station learns that from `.factory/release.md`, the repo's docs, scripts and CI, and its last releases, since every repo releases differently.
- VM workers run as a non-root `worker` user: Substrate starts every task as root, which tools such as PostgreSQL's `initdb` refuse. The Task asks for `SETUID`, `SETGID` and `CHOWN` (AX's `spec.capabilities`; `FACTORY_AX_CAPABILITIES` overrides the list, and set empty leaves the field out for an AX without it). `serve` starts as root, gives the workspace, the home and Nix's store to `worker` (Substrate shows every image file as root's), then runs itself again as `worker`. A DB-tier test can now start a loopback Postgres in the VM.
- Root in an `ax ssh` shell can use Nix and read the worker's repos again: a `nix` wrapper runs Nix as `worker` for root once `worker` owns Nix's database, and git trusts the repos (`safe.directory`).
- A VM reaches Nix's global flake registry (`channels.nixos.org` is in the default egress), so `nix shell nixpkgs#...` works for the worker user. Turning the registry off in `nix.conf` instead would change every devenv's derivation and miss the rig's cached devenv.
- A rig that sets `FACTORY_KUBE_SERVER` gets read-only `kubectl` on its cluster with no token in the VM: `serve` writes a kube config whose bearer token is a placeholder, and the rig's egress injects a read-only identity's token from the vault.
- `bin/claude-token` shows how much of its 7-day and 5-hour limit each stored Claude token has used, and makes one of them the token agent-vault serves (`use N`, `best`). It reads every store name from env, so it holds nothing private.
- With `FACTORY_AX_TOKEN_SWAP` set (for example `bin/claude-token best`), a VM worker's usage limit runs that command once, mails the manager the live slot, and resumes the worker after the vault's refresh, not at the limit's reset. Without it, or when the swap fails, workers wait for the reset as before.
- The repo carries spec-kit, and `specs/001-factory-cli-integration` specifies one factory CLI for the scripts and hand edits around the factory today.
- The VM brief says to run tests the repo's way (`make test`), which sets envtest up: workers that ran a bare `go test` failed on missing envtest binaries. The worker image carries `devenv` and substitutes from `devenv.cachix.org`, but `devenv shell` does not work in a VM yet: every local Nix build fails under gVisor (its builder dies before it starts), and a devenv profile is always built locally.
- A rig with a binary cache of its repo's devenv (`FACTORY_NIX_CACHE`, its egress injecting the cache's token) gets that devenv's environment in every VM worker: tools on PATH and variables set before the agent starts, without `devenv shell` and its git hooks. See the remote runner doc.
- `factory devenv` builds each such rig's devenv outside the VMs and pushes it to the rig's cache, again whenever its devenv files or the worker image change; the tick runs it every half hour.
- The console's Interview tab (8) asks the person each question a run cannot settle on its own: a station parked on their decision or stuck out of retries. A blocked worker ends its summary with `Question:` and, for clear choices, `Options: a | b`, which become buttons; the answer is mailed to the station (waking a parked one, retrying a stuck one), the manager hears of it, and the answered tab keeps the questions and answers.

## 0.6.0 (2026-10-12)

- The lifecycle factory's approve gate is gone: your merge of the pull request is the gate. Release goes straight to deploy, which parks until a person merges and never merges itself; changes requested on the pull request send the run back to implement, and closing it ends the run with its bead deferred. Across 286 gates the answer was ship 285 times, and a third of shipped runs then waited at deploy for the same person's merge anyway.
- AX workers install the tools a repo needs with Nix (single-user, binary cache only, nixpkgs pinned in the image); `serve` adds a localhost entry, `GOTOOLCHAIN=local` and an envtest kube-apiserver wrapper for the VM's link-local address.
- A triage reject no longer closes the run's bead: it stays open and ready, its `factory` label swapped for `rejected`, with who rejected it, when and why in its metadata (an edge's `reject: true`); queuing it again takes it back.
- The manager reviews the skills the dream proposes before they install: the dream writes them to `memory/.manager/skills/` (Claude Code refused its writes under `.claude/`, so none ever installed), a tick mails the manager each new, changed or reaped one, and `factory skills install|reject` decides it.
- The manager starts in bypass permissions, not the person's default mode: auto mode refused the production reads a patrol needs.
- The console's Rigs tab drew nothing once a rig ran past its cap: its bar asked for a negative repeat.
- A rig's `beadsRemote` pull no longer stalls on a conflict: in one transaction it commits the laptop's pending bd writes, merges, and keeps the VM's version of any row both sides changed, commenting on each overwritten issue what the laptop had. A launch pulls before it pushes.
- An AX station's next attempt starts from what its gone worker pushed: the laptop's worktree catches up with a rebase (dropping commits the worker already has, as after its own rebase onto main) instead of pushing its stale copy over the branch every tick.
- A rig's `beadsRemote` shares its beads with VM workers through a Dolt server instead of the repo's GitHub origin: the laptop pushes and pulls that remote, and the VM bootstraps from it with only a placeholder password, which the egress gateway replaces (egress rules take a `port`).
- A rig's `env` reaches its VM workers, and `FACTORY_BAZELRC` there becomes the VM's `~/.bazelrc` plus the egress gateway's CA (`--tls_certificate`, and a Java trust store for Bazel's JVM): a Bazel rig shares a remote cache whose key the gateway injects.
- A VM worker's `factory report` is refused while its bd changes cannot reach GitHub: queued without them, the report ended the VM and the changes with it.
- Beads for AX workers: the VM clones the rig's issue store from the repo's GitHub origin (where the laptop's dolt pushes it), works it with plain bd, and pushes it back before it reports; the laptop pulls when it replays the report.
- A VM worker's brief goes over `ax ssh` once its task runs: Substrate takes no env value past 32 KiB.
- A station can name its own `runner`; it wins over the rig's. Lifecycle keeps the stations that read or change production (baseline, deploy, soak, rollback, incident, monitor) on herdr, so a rig with `--runner ax` sends only the code stations to VMs.

## 0.5.0 (2026-10-11)

- Remote runners: where a worker runs is a `Runner` (`src/runner.ts`), picked per rig with `rig add --runner`. Besides herdr panes, a rig's workers can run as AX tasks: a microVM per launch that runs the rig's agent (claude, codex or pi) headless, reaches only the hosts its egress policy allows (`--egress` adds a rig's own) and holds no key, since the egress gateway injects them from agent-vault. The VM's report, mail and memory add come back through an outbox the laptop polls and replays only for the worker's own run and attempt, as its station. See [docs/remote-runner.md](docs/remote-runner.md).
- A worker that hits its account's usage limit restarts on the next account (via `ccswitch switch-to`), resuming its session; with every account limited, workers wait for the first reset instead of timing out.
- Manager skills: the dream writes skills for the manager from the work its sessions repeat and reaps the unused ones; the manager loads them from the memory (`memory/.manager/.claude/skills/`) with the Skill tool.
- `factory manager` supervises the manager's Claude: refused for a usage limit, it swaps the account and resumes the manager's session. Swaps are recorded for every factory on the machine.

## 0.4.0 (2026-10-11)

- Lean workers: a Claude worker runs on its own settings (the user's hooks and environment only),
  a short worker system prompt and the tools workers use, with MCP tools deferred behind ToolSearch,
  auto memory off and the global CLAUDE.md excluded. Before any work, an infra-blocks worker's
  context dropped from ~98k tokens to ~26k, and every turn carries the difference.
  `FACTORY_LEAN=0` turns it off.
- Handoff: past `maxContextK` (200k) a Claude worker is asked to commit and report `handoff` with
  notes, and a fresh worker carries on at the same station; at 1.25x it is cut off. Implement
  sessions had reached 567k, re-read on every turn.
- CORE.md is cut at 2.5 KB a part (its top, each rig's section) in briefs, and the dream keeps it
  to one short line a lesson; it had grown to 16 KB in every brief.
- `factory metrics --tokens`: what the live runs' workers spent, by station.
- A `conflict` or `rework` label on a PR a live run owns (its branch, or linked in its reports) mails
  that run's station instead of starting a second worker on the same branch; `close` aborts that run.
- A parked station whose linked PRs are all merged or closed wakes on its plain `parkMin` timer, not
  the 8-hour backstop: nothing will change those PRs.
- A station parked on pull requests (its blocked report links them) is watched with `gh` and mailed
  awake when one is merged, closed or updated, instead of a fresh worker re-checking on a timer;
  the timer backstops it at 8 hours. Deploy re-checks were most of infra-blocks' worker launches.
- A run on a repo Claude does not trust starts no worker (it would stall at the trust dialog until
  its timeout, every attempt); the manager is paged once, and `rig add` warns.
- Stations take `rounds`: past that many reports of one outcome in a run, the next is held for the
  manager. Lifecycle's review has 3, so a review loop that is not converging gets a person.
- Pull request labels act: `close` closes the PR (and aborts its run), `conflict` starts a run of the
  new one-station `rework` factory (YAML) that merges the base in, resolves, tests and pushes.
  `rework` starts the same run for a PR that needs changes: it triages the PR, makes what its reviews
  and checks ask for, or labels it `close` when it is no longer wanted.
- Beads sync: every 5 minutes, each rig whose beads have a Dolt remote runs `bd sync`, so work
  and claims from other machines reach dispatch and the factory's reach them. Failures, such as a
  remote nobody seeded yet, show as the rig's error and don't stop its dispatch.
- Factories extend each other: `extends: lifecycle` and only the stations you add or change, where
  a node merges into the base's field by field and `next` outcome by outcome. A factory can be
  written in JSON, YAML or TOML as well as TypeScript. Runs pin their factory resolved, as
  `factory.json`; runs started before keep their pinned `factory.ts`.

## 0.3.0 (2026-10-07)

- A factory's `params` are what its worker commands name as `{name}`: lifecycle's launcher
  (`claude`, default `claude-smart --new --no-channels`) and its three models. A rig sets them
  (`factory rig add ... --param exec_model=...`), else `FACTORY_<NAME>` in the environment
  (`FACTORY_CLAUDE`), else the factory's default; `factory check` names any it does not give. The
  default worker and the dream follow `FACTORY_CLAUDE` too, and a wrapper it names runs as Claude.
- `factory manager` starts a factory's manager lean: Bash and file tools only, no MCP servers,
  claude.ai connectors or Chrome. A manager started with `claude-smart` carried ~134k tokens of
  tool definitions into every call; this one starts at ~29k.
- A station that reports `blocked` again waits twice as long before its next check (60, 120,
  240 minutes, at most 8h): each check starts a whole worker.
- Only the session herdr sees in the manager's pane patrols. A background fork of the manager
  inherited its pane and patrolled as a second manager, and its stale-session hook typed
  `/compact` into the real manager's pane.
- The manager's context stays small. A station that parks again tells the manager nothing new; the
  patrol caps each message at 300 characters and sends the board and rig goals only when they
  change (and hourly); and `factory manager` runs `opus`, which Claude Code compacts, instead of
  `opus[1m]`. Managers had grown to 400–550k tokens, re-read on every call.
- `factory waiting`: everything that waits on the person, by rig: gates, parked stations with what
  holds them and their pull requests, stuck runs, and the command that answers each.
- Fewer lost workers: a worker waiting on the manager's answer is warned at its deadline, not failed;
  an idle worker is nudged four times, each wait twice the last, before it fails; and workers are
  told to wait on builds and CI in the foreground. verify and release get 75 minutes.
- Fewer review rounds: implement and verify now run review's mechanical checks (merge with
  origin/main, break each guard, check doc claims and documented commands, fix a finding's
  siblings), and review lists everything it finds in one pass.
- A run's first station is shown the commits already on the default branch that name its bead,
  so triage checks them instead of rediscovering an existing fix.
- The tick reaps what herdr holds that no run needs: a finished run's workspace (its worktree and
  branch stay until `factory rm`, which removes the worktree with git once the workspace is gone),
  and a Claude idle in a live run's workspace that is not its worker.
- The console's mail splits into not answered and answered: mail you answer (in the console, by
  `factory mail` or through the manager), mail its run has reported past, and mail whose run has
  ended leave the list you work from.
- The console's PRs tab (7, or `factory prs`): each rig's open pull requests from run branches,
  drafts left out, with what each waits on (conflicts, failing checks, approval, the merge) and its
  run's station or gate.
- The board's finished runs fold away (show/hide, folded at first) and list only the last 10.

## 0.2.0 (2026-10-06)

- herdr's sidebar shows each run's station and what holds it (`$factory` on the run's workspace:
  working, needs you, stuck, parked, or when a timed wait ends), and each manager's workspace
  carries its factory's rollup, e.g. "5 running · 1 need you · 1 parked".

## 0.1.0 (2026-10-06)

The first release: herdr software factories, run from a Claude Code session.

### Runs

- A factory is a graph of stations compiled to an xstate machine; a run is a fold over its
  events, persisted (fsynced) under `.factory-state/runs/<run>/`, so a restarted manager
  picks up where it stopped.
- Each station is worked by its own coding agent in a herdr tab of the run's git worktree;
  its report routes the run. Gates are decided by the person only, through `factory decide`.
- Durable workers: a lost pane resumes its session, a swallowed launch is retried, an idle
  worker is nudged before it is failed, retries back off, and a run that loops is held after
  its step budget. Station deadlines warn once and give half again.
- A worker blocked on a person, a human review or merge, or another run reports `blocked`:
  the run parks with no worker and no attempt spent, and wakes when mailed or after
  `parkMin`.
- `factory stop` and `factory resume` shut workers down gracefully and bring them back.
- `factory fork`, `goto`, `retry`, `abort` and `rm` for the manager.

### Factories

- `lifecycle`: build (triage, plan, implement, verify, review, security, release, approve,
  deploy, soak, rollback), incidents and postmortems, and the monitor, maintain and improve
  sweeps.
- A repo can own its factory (`factory adopt`), and each run follows the version its starting
  commit holds; the improve sweep proposes changes to it.

### Rigs and backlog

- Rigs name the repos a factory works, each with its own cap, sweeps and goal
  (`factory rig add`); `factory init` makes a factory directory.
- Beads drive planning and execution: one bead a run, its tasks as children, each station's
  report as a comment; review and security findings are posted on the pull request.
- A rig can run its workers as Claude, Codex or pi (`--agent`), with its own MCP servers
  (`--mcp`).

### Manager and console

- The `mod/` Claude Code mod ticks every run, patrols the factory as its manager (mail,
  gates, stuck stations, backlog) and draws a live console docked beside the chat, with
  rigs, a mailbox with quick answers, and gate decisions.
- Factory memory: workers share notes, ordered by what helped, groomed by a daily dream.
- `factory metrics`: ship rate, time to ship, approve wait, review loops, failure kinds and
  per-station visits, failures and durations, for the factory and each rig; finished runs
  are kept in `metrics.jsonl` after `factory rm`.
