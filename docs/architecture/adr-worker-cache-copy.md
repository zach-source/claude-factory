# ADR: Permit the worker model cache copy

## Context

Bead: `claude-factory-qn8a.122`. Run: `lifecycle-mwaudj5iss`.
Plan baseline: `7aac5a63`.

The worker image preloads the model at `Dockerfile.worker:153`.
A fresh worktree can lack that cache after `bun install`.
The guard treats the source of `cp` as a possible write target at `src/worker-hook.ts:11136`.
The hook directory includes the image cache. Thus, the source triggers `HOOK_CONTROL_REASON`.

## Decision

Permit one bounded class: a recursive model cache copy from the hook installation into the worktree dependency cache.
Do not add a general copy-command parser.
Change `src/worker-hook.ts` and extend `src/worker-hook-qn8a21.test.ts`.
Keep `src/worker-hook-qn8a21b.test.ts` as regression coverage.
Do not change the sandbox, worker image, memory loader, or factory definition.

Use the existing command tokens and guard context.
Exempt only the source operand from the hook-control write scan after the complete transfer matches the grammar below.
Continue all other guard checks. Never return an unconditional allow from `denyReason`.
Keep the destination checks, including `fileWriteReason` for an existing destination symlink into a protected tree.
Do not execute a command or fetch a model from the guard.
Add a short `ponytail:` comment: only this cache transfer qualifies; broader copy support needs a separate operand grammar.

### Closed grammar

The reader consumes only these fields:

- Command tokens: exactly four words, `cp`, `-R`, source, destination.
- Guard context: `root`, `cwd`, and `hookDir`, with their current defaults.
- Source: exactly `<hookDir>/node_modules/@huggingface/transformers/.cache`.
- Destination: exactly `<root>/node_modules/@huggingface/transformers/.cache`.
- Both paths: absolute literal paths, with no expansion, glob, brace, traversal, or trailing slash.
- Each root component: ASCII letters, digits, `_`, `-`, `.`, or `@`; no component equals `.` or `..`.

Ordinary quotes around a complete literal token can retain the same meaning under the current tokenizer.
Do not infer an exception from a token that needs shell expansion.
The exception applies only to the four-word segment. Other segments retain every current check.
Any unknown option, extra operand, wrapper, alternate executable, redirect, or incomplete form fails the exception.
The existing conservative scan then handles the complete segment, including its protected source.
This preserves denial for an unrecognized cache transfer; it does not deny unrelated safe commands.
Keep current alias checks and scan budgets. An alias must not turn a destructive command into an exempt copy.

Out of scope: general `cp`, `gcp`, `mv`, `rsync`, `install`, links, archive extraction, and arbitrary protected-source reads.
Runtime path construction and filesystem races retain the existing best-effort limits. The sandbox remains the security boundary.

Rejected alternatives:

- Remove `cp` from `COPY_INTO_COMMANDS`: this weakens ancestor-write checks.
- Mark every copy operand as a reader: this hides destination writes.
- Exempt all protected sources: copy options can change operand roles.
- Change the global model cache path: this adds shared state and alters the memory loader.
- Copy through another tool after a denial: this does not repair the false positive.

## Acceptance criteria

### AC1: The cache transfer allows

Add a `qn8a.122` test group in `src/worker-hook-qn8a21.test.ts`.
Use `denyReason` with `hookDir=/opt/factory`, `root=/workspace/w/repo`, and `cwd=/workspace/w/repo`.
The following command must return `undefined`:

```sh
cp -R /opt/factory/node_modules/@huggingface/transformers/.cache /workspace/w/repo/node_modules/@huggingface/transformers/.cache
```

Also test a second fixture root and hook directory. Test complete quoted literal operands.
These checks prevent a workstation-specific exception.
The reverse transfer must deny. A different protected source must still deny.
Proof: `bun test --timeout 30000 src/worker-hook-qn8a21.test.ts -t qn8a.122`.

### AC2: The exception fails closed

Use the same test group and command as AC1.
For the cache source, test extra operands, absent operands, and unknown options.
Test `-t`, `--target-directory`, `--target-directory=`, `-T`, `--backup`, `-L`, `-r`, and `-a`.
Test `mv`, `ln`, `rsync`, `gcp`, `busybox cp`, and `env cp`.
Test glob, brace, variable, command-substitution, traversal, and trailing-slash path forms.
Each row must deny; an earlier guard can supply the denial reason.
Test an alias that changes `cp` to a destructive command with the existing alias fixture mechanism.
Test a valid transfer followed by a protected write. The full command must deny.
Test a protected redirect on the copy segment. It must deny.
Keep ordinary safe copies and protected-file readers allowed through their existing paths.
Use a sentinel or spy to prove that rejected inputs cause zero copy, subprocess, or model-download calls.
Guard tests evaluate command text only; they must not execute hostile rows.

### AC3: Protected writes retain their denials

Add destination rows for the hook directory, its ancestors, and its three protected modules.
Cover `.claude`, both Claude settings files, `.cursor`, `.cursor/hooks.json`, and `.grok` config and hook files.
Cover `.git`, global git config, shell snapshots, and factory settings outside the worktree.
Include `rigs.json`, `worker-settings.json`, `inbox.jsonl`, and `state.json` outside the worktree.
Use the cache source and an ordinary source for these destination rows.
Use `fileWriteReason` fixtures for a cache destination symlink into a protected tree.
Retain overlap coverage where the worktree and hook directory share a root.
Do not weaken existing assertions to accommodate the exception.
Proof: `bun test --timeout 30000 worker-hook` plus the AC1 command.
After the fix commit, mutate the source match, destination match, and token-count check separately.
Each valid mutant must fail a relevant negative test. Restore the exact committed source after each run.

### AC4: A fresh cache supports local model search

Use a disposable worker fixture under `.scratch/` with the dependency tree and no destination model cache.
Use the revised hook to check the AC1 transfer with the fixture root.
Execute the allowed transfer once. Compare source and destination model-file hashes.
Disable remote model access through the installed Transformers environment API in a scratch test runner.
Run `src/memory.test.ts` with `-t 'semantic search finds the note'` through that runner.
The test must pass from the copied cache without a model fetch.
With no destination cache and remote access disabled, the same probe must fail before the copy.
Do not delete or alter the image cache or an existing worktree cache for this test.
Record the exact fixture commands and results in the task comment.
This is a local fixture check, not a production read. No AC is must-see-live.

## Test plan

### Test access prerequisite

Three implement passes could not start the required guard tests because the worker hook denied them.
The next plan must identify an authorized test environment before implementation resumes.
Do not repeat denied commands through another tool or change the hook environment.
The manager request for this prerequisite is in the run mail.
Both tasks remain open. No regression test or source exception exists yet.

The plan recheck at `3191f744` received the same denial before Bun started.
PR #834 remains open and draft: https://github.com/zach-source/claude-factory/pull/834.
The plan is blocked on an authorized environment that can execute the exact baseline command below.
Do not send this unchanged prerequisite back to implement as ready.
After the manager supplies that environment, run the baseline before task 1.
Keep AC1 through AC4 and both existing tasks; no separate guard repair belongs in this run without direction.

Commit the AC1 through AC3 regression tests before the fix.
Show the AC1 allow row fails against the baseline with `HOOK_CONTROL_REASON`.
Show existing protected-write rows pass before and after the fix.
Then add the minimum source exemption and run AC1 through AC4.
Run `bun run test`, `bun run typecheck`, and `bun run format:check` before the final handoff.
Run `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
Required CI checks are test, typecheck, plugin, and format on the final head.
Keep the PR draft through implementation. Do not ship a final head with deliberately red tests.

Plan did not execute the reported copy or alter the guard.
The worker hook denied the baseline test command before it ran:

```sh
bun test --timeout 30000 src/worker-hook-qn8a21.test.ts src/worker-hook-qn8a21b.test.ts
```

The denial cited a home-directory delete or move. A test-file search received the same denial.
Plan has no baseline test result. Implement must use an authorized test environment if the worker hook still prevents these checks.
Do not bypass a hook denial. Report the exact gap and obtain final-head CI evidence.

## Risk

This permission-guard exception is security-sensitive.
Wrong operand classification can permit a protected write.
Exact grammar, destination checks, alias checks, and negative tests bound that risk.
The change has no database migration, credential change, or new dependency.
Existing unsupported copy forms retain their current behavior.
The cache content remains the worker image content; model compatibility follows the installed dependency and image versions.
No known production defect becomes worse from this plan.

Security-sensitive: yes (shell input parsing and write permissions)

## Rollout and rollback

Use the normal reviewed release after a person merges the PR.
No flag or migration order is necessary.
A fresh worker uses the AC1 command when its dependency cache is absent.
Do not repeat that command against an existing cache; `cp` can add a nested `.cache` directory.
Rollback reverts the exception and its new tests through a reviewed PR.
The old false positive returns. Existing cache files need no rollback.

## Observability

Use the worker command result, the local model-search result, and the existing `HOOK_CONTROL_REASON` denial log.
The ship soak can inspect its authorized worker journal for a successful cache copy and model search.
No new metric, production access, or live read is necessary before merge.
An absent cache-copy event alone does not imply failure; a worker can already have the cache.

## Tasks

1. `claude-factory-qn8a.122.1`: Commit regression tests for AC1 through AC3. Record the pre-fix failure and protected-write baseline.
2. `claude-factory-qn8a.122.2`: Commit the bounded source exemption. Complete AC1 through AC4, mutation proof, and final checks.

Task 2 depends on task 1. Both tasks belong in one PR and fit one 120-minute implement pass.
The tests commit can be red locally. The final PR head must pass all required checks.
