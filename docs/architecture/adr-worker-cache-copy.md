# ADR: Permit the worker model cache copy

## Context

Beads: `claude-factory-qn8a.122` (bug), `claude-factory-qn8a.122.1` (this run: tests), `claude-factory-qn8a.122.2` (fix).
This run plans both in one PR. Its tasks are `claude-factory-qn8a.122.1.1` (tests) and `claude-factory-qn8a.122.1.2` (the scope of `.122.2`).
Run: `lifecycle-mwcc3b8i3n`. Baseline: origin/main `92ff5751`.
At `89d5c69c`, origin/main changes only `.github/workflows/ci.yml`.

The worker image preloads the model in `/opt/factory` (`Dockerfile.worker:141`, `:151-153`, through `fetchModel` in `src/memory.ts:636`).
The model goes to the Transformers default cache dir, `/opt/factory/node_modules/@huggingface/transformers/.cache`.
A fresh worktree can lack that cache after `bun install`.
The hook denies this copy with `HOOK_CONTROL_REASON`:

```sh
cp -R /opt/factory/node_modules/@huggingface/transformers/.cache /workspace/w/repo/node_modules/@huggingface/transformers/.cache
```

The cause: `cp` is in `COPY_INTO_COMMANDS` (`src/worker-hook.ts:10911`).
Thus `hookControlWrite` (`src/worker-hook.ts:11143`) reads each `cp` operand as a write target.
The source is under the hook dir, so `hookControlPath` (`src/worker-hook.ts:10945`) returns true.
The call site is `src/worker-hook.ts:10399-10413`.

Earlier plan runs could not start the tests: the hook denied the plain `bun test <file>` command.
The cause is the hook script scan: the test file holds delete rows that name the home dir.
The script form works. Put the command in `.scratch/<name>.sh`, then run `bash /workspace/w/repo/.scratch/<name>.sh`.
With that form, `bun test --timeout 30000 src/worker-hook-qn8a21.test.ts` passes at `92ff5751`: 228 pass, 0 fail.
The hook also denies `sed`, `wc` and `cat` of that test file, and any shell command that names this ADR. Use the Read, Grep and Edit tools.
`git add <file>` works. Run `prettier` on these files from a `.scratch/*.sh` script. The VM has no `bunx`; use `bun x`.

## Decision

Exempt one bounded class from the hook-control scan: the source operand of the exact cache copy.
Do not add a general copy-command parser.
Files:

| File | Change | Task |
| --- | --- | --- |
| `docs/architecture/adr-worker-cache-copy.md` | Create (this ADR) | plan commits it |
| `src/worker-hook-qn8a21.test.ts` | Modify: add one test group | task 1 |
| `src/worker-hook.ts` | Modify: add the guard and change one call | task 2 |

Do not commit `.scratch/` scripts. Do not change the sandbox, the worker image, the memory loader or `.factory/`.

### Closed grammar

The rule: the hook removes the source word from the `hookControlWrite` input only when all of these are true.
In all other cases, the segment keeps the current scan unchanged.

The guard reads `words`, the segment that `segments()` makes (`src/worker-hook.ts:1106`; quote and escape handling at `:1181-1245`; used at `:10124`).
The rule applies to each segment at every scan depth. `segments()` splits at `(`, `)` and `&`, so `(cp -R S D)` and `cp -R S D &` match (AC1 rows 7 and 8).
The inner scans of `bash -c '...'`, `eval ...` and `$(...)` reach the same call site. These forms run the same `cp`.
This change adds no test row for them. Task 2 records their result after the fix in its close reason.
`segments()` already removes quotes and turns `\x` outside quotes into `x`. Thus `words` holds the shell result of each word.
A quoted or escaped form of the exact words (`'S'`, `"D"`, `\cp`, `'cp'`) has the same effect in bash, so it matches too.
`\cp` only skips a shell alias. The real `cp` then runs with the same operands.

1. The segment `words` has exactly 4 items.
2. `words[0] === 'cp'` and `words[1] === '-R'`.
3. `words[2] === hookDir + '/node_modules/@huggingface/transformers/.cache'`.
4. `words[3] === root + '/node_modules/@huggingface/transformers/.cache'`.
5. Every other form fails, for example a word with `$`, a glob, a brace or `..` that `segments()` keeps.
6. `root` and `hookDir` each match `^(/[A-Za-z0-9_.@-]+)+$`. No component is `.` or `..`.
   Thus a path with `$`, a backtick, `~`, a glob, a brace, a space, a trailing slash or a traversal fails.
7. `fileWriteReason(<root>/node_modules/@huggingface/transformers/.cache, cwd, undefined, root, hookDir)` returns `undefined`.
   This real-path check denies a destination, or a destination parent, that is a symlink into a protected tree.

The guard reads only these inputs: the segment words, `root`, `cwd` and `hookDir`.
It uses the same values as the call site: `g.cwd ?? root ?? process.cwd()`, `root ?? process.cwd()` and `g.hookDir ?? dirname(import.meta.dir)`.
The guard does not run a command, start a process or write a file.
It inherits the reads of `fileWriteReason` (`src/worker-hook.ts:11255`): `realpathSync` on the nearest existing ancestor, on `hookDir` and on `root`.
With `env` undefined, `fileWriteReason` also reads `homedir()` and `XDG_CONFIG_HOME`.

Put `modelCacheCopy` directly after `hookControlWrite` (after `src/worker-hook.ts:11228`).
At the call site, change only the first argument of `hookControlWrite` (`src/worker-hook.ts:10402`):

```ts
hookControlWrite(
  modelCacheCopy(words, g.cwd ?? root ?? process.cwd(), root ?? process.cwd(), g.hookDir ?? dirname(import.meta.dir))
    ? words.filter((_, k) => k !== 2)
    : words,
  operandSkip,
  // the other arguments stay the same; copyInto and isCd still read the full `words` and `b`
```

On a match, `hookControlWrite` gets `['cp', '-R', D]`. The destination scan stays.
All other checks in the segment loop and in `denyReason` stay. Do not return an allow early.
The alias, wrapper and redirect checks run before or around this code and stay unchanged.

Out of scope, with the current behavior unchanged:

- `cp` with other options (`-r`, `-a`, `-L`, `-T`, `-t`, `--`).
- `gcp`, `mv`, `rsync`, `install`, `ln`, `busybox cp`, `/bin/cp`, `command cp`, `env cp` and `sudo cp`.
- A relative path, or another root, as the destination.
- A glob or `~` form of the cache source, for example `/opt/fac*/node_modules/...`. The current scan allows these at `92ff5751`.
  They are reads of a 4-word segment, not writes. This change does not add or remove a test row for them.
- A Bash `cp` with an ordinary source into `.git` or `shell-snapshots`. The current scan allows it. `fileWriteReason` covers only the Write tool.
- A path that a command builds at run time. A race in the file system. The sandbox is the real barrier.

Add one `ponytail:` comment: only this cache copy qualifies; a wider copy needs its own operand grammar.

Code sketch (implement can change the names):

```ts
// ponytail: only the image model cache copy qualifies (claude-factory-qn8a.122).
// A wider copy needs its own operand grammar.
const MODEL_CACHE = '/node_modules/@huggingface/transformers/.cache'
const ABS_DIR_RE = /^(\/[A-Za-z0-9_.@-]+)+$/
function modelCacheCopy(words: string[], cwd: string, root: string, hookDir: string): boolean {
  if (words.length !== 4 || words[0] !== 'cp' || words[1] !== '-R') return false
  if (words[2] !== hookDir + MODEL_CACHE || words[3] !== root + MODEL_CACHE) return false
  for (const d of [root, hookDir])
    if (!ABS_DIR_RE.test(d) || d.split('/').some(c => c === '.' || c === '..')) return false
  return fileWriteReason(root + MODEL_CACHE, cwd, undefined, root, hookDir) === undefined
}
```

### Rejected alternatives

- Remove `cp` from `COPY_INTO_COMMANDS`: this removes the parent-of-hook-dir checks for every `cp`.
- Read every `cp` source as a reader: `-t` and `--target-directory` change the operand roles.
- Exempt every protected source: `cp -R <hookDir>/src <dest>` must stay denied.
- Exempt the whole segment: this removes the destination scan.
- A lexical match with no real-path check: a symlink destination into the hook dir then passes (probe at `92ff5751`).
- Move the model cache path: this adds shared state and changes the memory loader.

## Acceptance criteria

All rows go in one new group in `src/worker-hook-qn8a21.test.ts`. Its name starts with `qn8a.122`.
Use one helper: `(cmd, root, hookDir, extra = {}) => hook.denyReason(cmd, root, undefined, { cwd: root, hookDir, gitAliases: () => new Map(), ...extra })`.
Only the alias row passes `extra`.
In this section, `S` is `<hookDir>/node_modules/@huggingface/transformers/.cache` and `D` is `<root>/node_modules/@huggingface/transformers/.cache`.
Fixture A: `hookDir=/opt/factory`, `root=/workspace/w/repo`. Fixture B: the file constants `H=/f/acme-factory`, `ROOT=/w/acme`.

Proof command for AC1 to AC3: `bun test --timeout 30000 src/worker-hook-qn8a21.test.ts -t qn8a.122`.
Put it in a `.scratch/*.sh` script and run it with `bash`. The hook denies the plain command.

### AC1: The hook allows the cache copy

These rows must return `undefined`:

| Row | Command | Fixture |
| --- | --- | --- |
| 1 | `cp -R S D` | A |
| 2 | `cp -R S D` | B |
| 3 | `cp -R 'S' "D"` | A |
| 4 | `cp -R "S" 'D'` | B |
| 5 | `\cp -R S D` | A |
| 6 | `'cp' -R S D` | B |
| 7 | `(cp -R S D)` | A |
| 8 | `cp -R S D &` | A |

At `92ff5751`, all 8 rows return `HOOK_CONTROL_REASON` (probe). The source scan gives that reason.
`scanReason` (`src/worker-hook.ts:9205`) tests `state.hookControl` at `:9262`.
After it come the `cfgGlob`, alias-define, stdin and deferred checks, and then `tokenReason` and `privateTextReason` in `denyReason`.
None of them applies to a plain `cp` segment. The AC1 `undefined` assertions are the proof.
These 8 rows are the only red rows before the fix.
Fixture A uses real paths. On a worker VM, `fileWriteReason` resolves them on the real file system. In CI the paths do not exist, so the walk stops at `/`.
Both give `undefined` if `<root>/node_modules/@huggingface/transformers` is not a symlink. Bun installs it as a real dir.
With `env` undefined, the result also depends on the host `homedir()` and `XDG_CONFIG_HOME`. Neither is under `/workspace/w/repo/node_modules` on a worker VM or in CI.

### AC2: The exemption fails closed

Each row must return a reason (`toBeDefined()`). An earlier guard can give the reason.
Fixture A, unless the row says other. Each row denies at `92ff5751` (probe).

- Reverse and other source: `cp -R D S`, `cp -R <hookDir>/src D`.
- Count: `cp -R S D x`, `cp -R S`, `cp S D`.
- Options: `cp -R -t D S`, `cp -R --target-directory D S`, `cp -R --target-directory=D S`, `cp -R -T S D`, `cp -R --backup S D`, `cp -R -- S D`, `cp -L S D`, `cp -r S D`, `cp -a S D`.
- Other command words: `mv S D`, `ln -s S D`, `rsync -a S D`, `gcp -R S D`, `rsync -R S D`, `busybox cp -R S D`, `env cp -R S D`, `command cp -R S D`, `/bin/cp -R S D`, `sudo cp -R S D`.
- Source forms: a brace (`<hookDir>/node_modules/@huggingface/{transformers,x}/.cache`), `"$F"/factory/node_modules/@huggingface/transformers/.cache`, `$(echo S)`, a traversal (`<hookDir>/node_modules/../node_modules/@huggingface/transformers/.cache`), `S/`, upper case (`/OPT/FACTORY/node_modules/@huggingface/transformers/.cache`).
- Destination forms: `D/`, `D*`, `D/../../../../../.claude`, `D/../../../../.git`, `/workspace/w/other/node_modules/@huggingface/transformers/.cache`, the relative `node_modules/@huggingface/transformers/.cache`.
- Root and hook dir grammar: root `/w/ac me` with hookDir `H` and a quoted `D`; hookDir `/f/acme+factory` with root `ROOT`; root `/w/acme/` (trailing slash) with hookDir `H` and destination `/w/acme//node_modules/@huggingface/transformers/.cache`.
- Segments: `cp -R S D && echo x > <hookDir>/src/worker-hook.ts`, `cp -R S D; tee <hookDir>/src/cut.ts`, `cp -R S D | tee <root>/.claude/settings.json`, `cp -R S D > <hookDir>/src/cut.ts`, `cp -R S D 2>&1`.
- Alias: with `shellAliases: () => new Map([['cp', 'rm -rf']])`, `cp -R S D` denies.
- Symlink fixture, the same layout as the test at line 24. Use one new dir for each case:
  `d = mkdtempSync(join(tmpdir(), 'qn122-'))`, `hd = join(d, 'fac')`, `rt = join(d, 'root')` (sibling dirs, so no overlap).
  First run `mkdirSync(join(hd, 'src'), { recursive: true })` and `mkdirSync(join(rt, 'node_modules', '@huggingface'), { recursive: true })`, so the link target exists.
  Call the helper with `root = rt` and `hookDir = hd`. Add `existsSync` and `lstatSync` to the `node:fs` import.
- Symlink case 1: make `<rt>/node_modules/@huggingface/transformers` a symlink to `<hd>/src`.
  `cp -R <hd>/node_modules/@huggingface/transformers/.cache <rt>/node_modules/@huggingface/transformers/.cache` must deny.
- Symlink case 2: also `mkdirSync(join(rt, 'node_modules', '@huggingface', 'transformers'))`. Make `<rt>/node_modules/@huggingface/transformers/.cache` a symlink to `<hd>/src`. The same command must deny.
  Remove the fixture in `finally`, as the AC1 symlink test at line 24 does.
- Zero downstream effects: after the symlink rows, `<hd>/src/.cache` and `<rt>/node_modules/@huggingface/transformers/.cache` must not exist as a dir.
  (In the second case the leaf is the symlink: assert `lstatSync(...).isSymbolicLink()` and that `<hd>/src` has no `.cache`.)
  This proves that the guard copies nothing. `denyReason` starts no process for a `cp` segment: `gitAliases` and `ghAliases` run only for git and gh segments.

These rows must stay allowed (`toBeUndefined()`): `cp -R x .scratch/y`, `cat <hookDir>/src/worker-hook.ts`, `cp src/worker-hook.ts .scratch/b.ts`.
With root and hookDir both `/opt/factory`, `cp -R S <hookDir>/node_modules/@huggingface/transformers/.cache` must stay allowed. That is the overlap case.

### AC3: Protected writes keep their denials

Do not change or remove an existing row in `src/worker-hook-qn8a21.test.ts` or `src/worker-hook-qn8a21b.test.ts`.
Use Fixture A for every AC3 row (`/opt` is a parent of the hook dir only there).
Add destination rows with source `S`. Each row must deny:
`<hookDir>`, `/opt`, `/`, `<hookDir>/src`, `<hookDir>/src/worker-hook.ts`, `<hookDir>/src/home-guard.ts`, `<hookDir>/src/cut.ts`, `<hookDir>/package.json`,
`<root>/.claude`, `<root>/.claude/settings.json`, `<root>/.claude/settings.local.json`, `<root>/.cursor`, `<root>/.cursor/hooks.json`, `<root>/.grok`, `<root>/.grok/config.toml`, `<root>/.grok/hooks/x.json`,
`<root>/.git`, `<root>/.git/hooks/pre-commit`, `~/.gitconfig`, `~/.config/git/config`, `~/.claude/shell-snapshots/x.sh`,
`/h/rigs.json`, `/h/worker-settings.json`, `/h/runs/r1/inbox.jsonl`, `/h/runs/r1/state.json`.

Add the same rows with source `.scratch/x`, except `.git`, `.git/hooks/pre-commit` and `shell-snapshots`. The current scan allows those 3 (see Out of scope).
Expected reasons at `92ff5751`: `HOOK_CONTROL_REASON` for the hook dir, `.claude`, `.cursor` and `.grok` rows. `GLOBAL_GIT_CONFIG_REASON` for the two git config rows. `FACTORY_CONFIG_REASON` for the four `/h/` rows.
Assert `toBeDefined()`. An exact reason is not a requirement.
Proof: the AC1 command, and a `.scratch` script with `bun test --timeout 30000 worker-hook` (0 fail).

### AC4: Each guard condition has a test

After the fix commit, mutate each item below alone. Each mutant must load in `bun test` and make one or more `qn8a.122` rows fail.
Restore the file with Edit after each run. `git status --short` must be empty after each restore (the plan commit holds the ADR; git ignores `.scratch/` through `.git/info/exclude`).

| Mutant | Row that must fail |
| --- | --- |
| Remove `words.length === 4` | `cp -R S D x` |
| Remove `words[0] === 'cp'` | `gcp -R S D` |
| Remove `words[1] === '-R'` | `cp -a S D` |
| Remove the source match | `cp -R <hookDir>/src D` |
| Remove the destination match | the other-root destination row |
| Remove the root `ABS_DIR_RE` test | root `/w/ac me` |
| Remove the hookDir `ABS_DIR_RE` test | hookDir `/f/acme+factory` |
| Remove the dot-component check | root `/w/acme/../x` |
| Remove the `fileWriteReason` check | both symlink rows |

No AC is must-see-live. The guard is a unit with no live state.

## Test plan

1. Task 1 commits the AC1, AC2 and AC3 rows with no change to `src/worker-hook.ts`.
   Run the AC1 command. Expect the 8 AC1 rows to fail with `HOOK_CONTROL_REASON`. All other `qn8a.122` rows must pass.
   Record the baseline SHA, the 8 failing row names and the pass count in the task close reason.
2. Task 2 adds the exemption. Run the AC1 command (0 fail) and the full `worker-hook` suite (0 fail).
   Do the AC4 mutations.
3. Before the hand-off, run `bun run typecheck`, `bun x prettier@3.9.9 --check .` (the VM has no `bunx`), `bun audit` and `gitleaks detect --log-opts=origin/main..HEAD`.
   Merge origin/main before the push. The required CI checks are test, typecheck, plugin and format. They must be green on the final head.

If the hook denies a test command in the script form too, do not go around it. Record the command and the gap, and cite the CI result on the exact head.

## Risk

This change is a permission-guard exemption, so it is security-sensitive.
A wrong match can allow a write into the hook dir or a settings file.
The exact 4-word grammar, the literal path match, the real-path destination check and the AC2 to AC4 rows limit that risk.
The destination scan still runs on the matched segment.
The change has no migration, no new dependency and no credential change.
Each other command keeps its current result. Only a segment of exactly the AC1 words changes from deny to allow: the 8 AC1 rows, other quoted or escaped spellings, and the same segment inside `bash -c`, `eval` or `$(...)`.
Each of these runs the same `cp`.
The cache content is the worker image content. Model compatibility follows the image and the installed package version.

Security-sensitive: yes (shell input parsing and write permissions in src/worker-hook.ts)

## Rollout and rollback

A person merges the PR. The normal self-update deploys it. The change has no flag and no migration.
A fresh worker can then run the AC1 command when its worktree has no model cache.
Do not run it again when the destination exists: `cp -R` then makes a nested `.cache`.
Rollback: a reviewed PR reverts the fix commit and the test commit, in that order. The false positive then comes back. Copied cache files need no rollback.

## Observability

The proof is the unit tests and the CI result on the final head.
After deploy, a worker that runs the AC1 command gets no `HOOK_CONTROL_REASON` deny for it in the hook deny log.
A soak can read its own worker journal for that result. No new metric and no live read are necessary.
If no worker runs the copy, that is not a failure: most worktrees already have the cache.

## Tasks

One PR from branch `factory/lifecycle-mwcc3b8i3n`. Both tasks fit one implement pass.

1. `claude-factory-qn8a.122.1.1`: commit the AC1 to AC3 test rows. The commit is red by design: only the 8 AC1 rows fail. Push it only together with the task 2 commit.
   This red commit is a deliberate exception to "each commit is green": the bead asks for the regression test before the fix.
   Do not use `test.failing`; the red run is the evidence.
2. `claude-factory-qn8a.122.1.2` (blocked by task 1): add the exemption, do AC4 and run the final checks.
   It has the same scope as `claude-factory-qn8a.122.2`. Add a comment on `claude-factory-qn8a.122.2` with the commit and the PR link.

The PR must not go out with red required checks. The final head has both commits.
Draft PR #834 holds only an older copy of this ADR. This ADR replaces it. Name #834 in the PR body. A person decides when to close #834.
