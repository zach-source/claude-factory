# Changelog

Each release is tagged `v<version>` and its version is set in `package.json` and
`mod/.claude-plugin/plugin.json`. Versions follow [semver](https://semver.org); until 1.0 a
minor release may change the factory format, the CLI or the run state.

## Unreleased

- Changed: `factory plan set` no longer files PM findings (`starved-epic`, `goal-no-beads`, `epic-done-open`, `goal-no-plan`) as beads. The PM pass filed about 95 near-duplicate finding beads in a few days, one for each epic and kind, and they only added noise. Findings stay in `plan.json`, and the board and `plan show` list them. PM proposals (`pm proposal: ...`, labeled `human`) are filed as before, with the same dedupe key and the cap of 3 new beads for each rig.
- New: one ship run for each rig (claude-factory-rtuw). `factories/ship.ts` owns release, the wait for your merge, deploy, soak, rollback and postmortem. When review, security or check approves, a lifecycle run now ends on a `ship` edge, leaves its bead open with the label `ship`, and holds no run slot. Ship runs count against no run limit, and one rig has at most one. `factory ship <rig>` prints the queue; `factory status` and `factory waiting` show it, with all owner-only steps in one list. A queued PR that needs changes returns to a work run at implement on its own branch. Runs that started earlier finish on the old release, deploy and soak path. Gates are the same: a person merges.
- Fixed: a queued (`factory`-labeled) parent bead with open children started nothing. Dispatch skips the parent for its open children, and a child started on its own only when its parent had no `factory` label. Now a child of a parent with no live run starts on its own when the child or the parent has the label. A parent with a live run still carries its children. In one rig, a P0 parent and its child waited this way.
- Fixed: main CI after #197 and #158 merged. #197 (bc1u) allowed the heads `$X[1,-1]` and `$X[1] a.txt`. #158 (clcc) denies a glob char in a command word, and in bash `$X[1]` is `$X` plus the glob `[1]`. The two rows now expect a deny (fail closed).
- Fixed: the alias guard (claude-factory-mn2y) denied `ssh $h uptime` and `fish $h` in a command with a second segment, so main failed the miqy allow rows. `ssh` and `fish` are now on `ALIAS_SAFE_COMMANDS`: a child process cannot change the parent shell's alias table.
- Fixed: the label pass mailed a run (or started a rework run) before it took the `conflict` or `rework` label off. When `gh pr edit --remove-label` failed, every pass mailed again: one run got 305 copies in 11 hours. The label now comes off first, and a failed removal sends nothing.
- New: `FACTORY_WORKER_PLUGINS` (comma-separated plugin names, the `enabledPlugins` key before `@`) keeps those plugins in a worker's settings, next to `asd-ste100`. A plugin must also be enabled in the user's settings. Example: `FACTORY_WORKER_PLUGINS=ponytail`.
- New: a `manager` target in `Dockerfile.worker`, for the image of the AX manager task (claude-factory-192.1). It builds on the worker image and adds `herdr`, `dolt`, the `ax` CLI and the mod (`/opt/factory/mod`), and sets `FACTORY_IN_AX=1`. A build with no `--target` still makes the worker image. `TARGET=manager hack/push-worker.sh` pushes it as `factory-manager`.
- `factory migrate-to-ax` now also moves the manager Claude's auto-memory and the transcripts of the sessions in `manager-sessions.json`, from `<CLAUDE_CONFIG_DIR>/projects/<slug of the session cwd>` on the laptop to the task's project dir. It sets each session's `cwd` to the task's. Before, the host's `--resume` of the last session failed in the task, and the manager lost its memory (claude-factory-192.5).
- New: rig repos and beads stores for the AX manager, and `factory migrate-to-ax [--dry-run] [--force] [--keep N]` (claude-factory-192.4, claude-factory-192.5). In the task a rig's repo is the clone `${FACTORY_REPOS:-/workspace/w/repos}/<rig>`; an optional rig field `remote` is its https clone URL. `factory repos sync` clones or fetches each rig and bootstraps its beads store (`BEADS_DOLT_SHARED_SERVER=0`, the worker's way). `factory manager host` runs it and waits on an empty home for the `.migrated` marker (or `FACTORY_AX_FRESH=1`). `migrate-to-ax` refuses live runs on local herdr panes, packs the factory home without old finished runs, and unpacks it in the task. See "Move the factory to AX" in docs/remote-runner.md.
- New: `factory manager --ax [args]` runs the manager as the long-lived AX task `f-manager` (claude-factory-192.2). It needs `FACTORY_AX_MANAGER_IMAGE`, refuses if the task already runs, applies the task with `spec.debug`, and creates its egress policy (worker defaults, `claude.ai`, the `AX_SERVER` host). In the task, `factory manager host` starts herdr with no terminal, runs `factory manager` in its first pane, and starts both again, with `--resume`, if herdr dies. `ax.manifest` takes the command as a parameter; worker tasks do not change.
- New: a one-manager lease and a pane bridge for the AX manager (claude-factory-192.6, claude-factory-192.7). `factory manager`, `factory tick` and `factory loop` stop on the laptop while the AX task `f-manager` is Running, Pending or Suspended, and name `factory attach` and `factory say`. If AX does not answer, they warn and run. `factory attach [--follow]` prints the manager pane over `ax ssh`. `factory say <text...>` types text into it. `ax ssh` has no stdin or PTY, so this is not a real `herdr attach`.
- New: a home-directory guard. A worktree cleanup deleted a person's home directory. The worker hook now runs `homeReason` first, on the raw command text, before any parse. It denies a command that holds a delete word (`rm`, `rmdir`, `unlink`, `mv`, `find -delete`, `rsync --delete`, `git clean`, `git worktree remove`, `rmtree`, `rmSync`, `rimraf` and others) and a whole-home word (`~`, `$HOME`, `${HOME}`, the home path, a dir above it, or `homedir()`, `expanduser("~")` and similar). It also reads each script file that the command runs (`bash cleanup.sh`, `./cleanup`) and applies the same check to its text. In the runner, `rmSafe` replaces each recursive `rmSync`. It throws on `/`, `$HOME` and every dir above `$HOME`. A path under home, such as `~/.cache/x`, stays allowed.
- Fixed: the worker hook now reads `&>` as bash and zsh read it. Before, the hook split the command at the `&`, so the words after a `&>` redirect left their command (`rm &>/dev/null -rf /`, `gh &>/dev/null pr merge 1`, `xargs &>/dev/null gh pr view 1`). Now the hook scans two readings: the dash reading (a separator, then `>`) and the bash reading (one redirect). It also reads `&>>`, `&>|`, `&>!` and a backslash-newline between `&` and `>`. A `&` alone, `&&` and `ls &>/dev/null` stay as before (claude-factory-59pp).
- The Claude Code shell snapshot aliases `gp`, `gpoat` and `gco` expand to git commands. The worker hook saw no `git` word, so it allowed `gp origin main`. Worker settings now set `CLAUDE_ENV_FILE` to `src/worker-shell-env.sh`, which runs `unalias -a`. A user value moves to `FACTORY_USER_ENV_FILE`. The hook also reads the newest snapshot files and denies an alias word for `git` or `gh`. It denies when the read fails. A path command word, such as `bin/factory gc`, skips the check for its arguments. CI installs zsh (claude-factory-1zr5).

- The worker hook now denies a dynamic word in the option slot of a `sh`, `bash`, `zsh` or `dash` call, and a brace list word (`{sh,-c}`, `{a..c}`) at a command anchor. The shell can expand such a word to `-c` and a script that the guard cannot read. Before, `C=-c; sh $C 'git push origin main'` and `{sh,-c} 'git push origin main'` were allowed. The new `SH_DYNAMIC_FLAG_REASON` names the first case. A dynamic word after a literal operand now reads like a `-c` flag, and the `bd` scan fails closed on the same shapes. The hook also denies harmless uses such as `bash "$f"`. Literal forms such as `sh script.sh` and `xargs -I {} cp {} dest` stay allowed (claude-factory-38jm).
- Fixed: a parked deploy no longer wakes a worker for a bot comment, a CI status or a label. The watch now wakes a parked station for a new head commit, a merge, a close, or a review or comment by a person. A pull request closed without a merge routes the `hold` outcome, and a person's change request routes `changes`, both with no worker. Near the 8-hour timer, an unchanged open pull request parks the station again. Expect deploy sessions per shipped run to fall from 1.80 toward 1.0 (claude-factory-5wav).

- The worker hook now denies a write to the global git config, with or without a git word in the command (claude-factory-ty8y). The paths are `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and `/etc/gitconfig`. A write is a redirect target, a `dd` `of=` target, a glob that can name the file, or an operand of any command that is not a reader. Before, a shell redirect wrote `remote.origin.push`, `push.default` or a push alias into that file, and a later `git push` or alias call was allowed. The hook also denies a `.config` directory word next to a git word, also when the git word is quoted or escaped. A git segment and a reader (`cat`, `ls`, `rg`, `grep`) can still name the path as an operand. The new reason text is `GLOBAL_GIT_CONFIG_REASON`. The hook does not read a path built from a shell variable (`F=~/.gitconfig; echo x >> $F`), a Write or Edit tool write (claude-factory-ak7) or a `.git/config` write alone (claude-factory-cpn). It also does not read a directory copy that writes the file with no path operand (`cp -R /r/acme/dot/. ~/`, `tar -xf x.tar -C ~`). The hook now reads the `<>` and `>|` redirects. A git command with `--work-tree`, `-C`, `GIT_WORK_TREE`, `clone` or `worktree` keeps its operands checked. A `bd`, `factory`, `gh` or `bun test` call can name the path as text. A `--work-tree` or `GIT_WORK_TREE` value outside the worktree is denied. `--git-dir` and `GIT_DIR` also keep git operands checked. A `gh` clone keeps its operands checked. An operand that ends at the `.config` directory is a write. The hook collapses `//`, `/./` and a trailing `/.` before it reads a path. `bun test --reporter-outfile` is an output flag. A `..` segment in a `--work-tree` value is denied, also under the worktree. A `--git-dir` or `GIT_DIR` word with a `-C` outside the worktree, or after a `cd`, is denied. A `core.worktree` write outside the worktree, and any `-c core.worktree=`, is denied. A `gh repo fork --clone` keeps its operands checked. A fix for the whole class is a push-time read of the effective git config (claude-factory-yoib).

- The worker hook now keeps a redirect whole when a backslash-newline line continuation sits inside it, such as `>\<newline>&1`, `>\<newline>|log` or `&\<newline>>log`. Bash joins the continuation. Before, the guard split the push tail at the `&` or `|`. In bash, the hook did not deny `git push origin feature >\<newline>&1 main`. Now it denies this command, and the same for `git send-pack` (claude-factory-abmq).

- The worker hook now folds the command word to lowercase before each `git`, `gh`, shell, `sudo`, `xargs`, `kubectl`, `helm` and `rm` check. macOS APFS ignores case, so `Git push origin main`, `GH pr merge 1` and `/bin/SH -c 'git push origin main'` ran the real program and passed every guard. A non-ASCII word folds with upper then lower case, so the long s (U+017F) that APFS folds to `s` also denies (claude-factory-a8pr).

- Added regression tests for a bug. A shell variable word before the `git` verb hides a protected push. Three example commands: `git $X push origin main`, `git "$X" push origin HEAD`, and `git -C sub $X push origin main`. The `DYNAMIC_VERB_REASON` fix from claude-factory-p43v already denies them on `main`. The new rows set `gate.gitAliases` and `gate.ghAliases`, the gate shape `main()` uses in production. The existing `P43V_GATE` rows leave both unset (claude-factory-bjp0).

- Fixed: a nested `env -S` or `env -i eval` command made the worker hook scan take about 2x longer for each level. A 219-character command took 82 s, past the 10 s hook timeout, so the hook failed open and the command ran unchecked. The scan now reads each `env -S` span and each `eval` word once. A work budget (`MAX_SCAN_WORK`) also stops any scan that grows too large and denies with `SCAN_BUDGET_REASON`. No other verdict changes (claude-factory-cbai).

- The worker hook now denies a `git push` or `git send-pack` that has a shell-dynamic word: a `$`, a backtick, a glob or a brace. The shell can expand such a word to `--all`, `--mirror` or `--` before git runs, and the parsers read it as a literal remote or flag. A backtick next to a push in one command also denies (claude-factory-cu5m). The guard also denies a zsh glob group such as `(-)-all` and a `~name` word in the push tail, and it reads a quoted `git` or `push` word next to a backtick. It also keeps a redirect such as `2>&1`, `>&2` or `>|log` inside the push tail, and it denies `&>` beside a push.

- The worker hook now denies an unquoted `$'...'` or `$"..."` quote. Before, `bash -c $'git push origin main'` and `sh -c $'git\x20push origin main'` were allowed, because the guard read the quote as a plain word. Bash and zsh decode the quote in different ways, so the hook denies it. It also denies harmless uses such as `echo $'a\tb'` (claude-factory-hewq).

- The worker hook now scans the command that `env -S` really runs. `env` puts the split words into argv and keeps reading the words after the value. Before, `env -S 'sh' -c 'git push origin main'` was allowed, because the scan stopped after the `-S` value. The hook now denies it, and the `bash`, `zsh`, `sh -x`, `--split-string=`, `eval` and `git -C` forms too (claude-factory-s1fj).

- The worker hook now scans a command substitution inside double quotes, `"$(...)"` or a backtick pair. Before, `echo "$(git push origin main)"` was allowed, because the quoted span stayed one word and no guard read its body. Each body now goes through every guard, as the unquoted form does. The usual `git commit -m "$(cat <<'EOF' ... EOF)"` form is still allowed.

- The worker hook now reads every word after `--` in `git push` and `git send-pack` as an operand, as git does. Before, `git push -- origin main -n` was allowed as a dry run, and `git push -- origin -o main` hid the `main` refspec as a value (claude-factory-zs39). A flag-like ref name after `--`, such as `-n`, is no longer read as a flag.

- Workers and the manager now run the `haiku` alias on Haiku 5.5 (`claude-haiku-5-5`): `ANTHROPIC_DEFAULT_HAIKU_MODEL` is set in their settings env, since Claude Code 2.1.291 still maps `haiku` to Haiku 4.5. Workers also get `SHUNT_MODEL=haiku`, so a shunt-guard denial names the model to hand a large read to (`Agent` with `model: haiku`). In 7 days of transcripts, workers hit the guard 91 times and never delegated the read, because the denial named no model and workers do not load the `shunt` skill. A user's own value for either variable wins. The manager's `briefer` subagent (no tools, at most 3 turns) moves from Sonnet to Haiku.

- Model defaults move to the current models, at the same per-token prices: `exec_model` is now `claude-sonnet-5-5[1m]` (was `claude-sonnet-5[1m]`) in the lifecycle, sweeps, release, review-loop and rework factories, and `security_model` is now `claude-fable-5-1` (was `claude-fable-5`) in lifecycle and sweeps. `judge_model` stays `claude-opus-5-5[1m]`. A rig's `--param` or `FACTORY_EXEC_MODEL` / `FACTORY_SECURITY_MODEL` still overrides them.

- Fixed: `gitReason` (`src/worker-hook.ts`) read a `git push`'s dir from
  `flagValue(tail, {-C}) ?? root`, where `root` is the worktree root. A
  relative `-C <dir>` value stayed unresolved text; the real `headOf`
  wiring in `main()` then spawned `git -C <that text>`, which resolves
  against the hook process's own filesystem cwd, not the tool call's own
  cwd. A prior Bash call's `cd` into a second repo made a later
  `git push origin HEAD` or bare `git push` there read the wrong repo's
  branch, or the wrong dir inside it. (claude-factory-3f2z)
  - Fix: `HookGate` adds `cwd`, the tool call's own cwd (`input.cwd`).
    `gitReason` now folds every `-C` before the push verb onto
    `gate.cwd ?? root`, in order, through a new `gitChdir` helper: an
    absolute value replaces the dir, a relative value joins onto it, and
    an empty value changes nothing.
  - Fix: `main()` sets `gate.cwd = i.cwd || root`, the same fallback
    `readFile` already uses for a `gh api` file argument.
  - Fix: `gitChdir` now steps over the value word of `-c`, `--git-dir`,
    `--work-tree` and `--namespace`. Before this fix, `gitChdir` read
    any `-C` word as the `-C` flag, even a flag's own value word, and a
    real `-C` after it can get ignored (a fail-open). `gitChdir` now
    also denies the push when an unknown flag's value word looks like
    `-C`. (claude-factory-3f2z.7)
  - Fix: `gitReason`'s two certain-verb branches now also check `!uncertain`.
    An unknown flag's own value word can read `push` or `send-pack`.
    `gitReason` trusted that word as the verb, even when `firstVerbIndex`
    marked the verb search `uncertain`. It then missed a real `-C` word
    between the fake verb and the true, later verb. `gate.headOf` then
    read the wrong, unprotected dir (a fail-open). The uncertain-verb
    fallback now also denies the push when its own guessed `pushTail`
    holds a literal `-C` word. (claude-factory-3f2z.8)

  - Fix: The denial from the previous fix did not stop `gitReason`, which
    still called `gitPushDenied` and `sendPackDenied` with the untrusted
    `pushTail`. In that tail, a bare `push`, a push with only a remote
    operand, and a push with `--force` and no refspec all read as safe.
    So the push was still allowed.
    `gitReason` now returns the deny reason at once when it finds the
    untrusted `pushTail`, and it does not call `gitPushDenied`,
    `sendPackDenied`, or `gate.headOf`. (claude-factory-3f2z.9)
- `worker-hook`: fail closed when one command does one of these, then pushes `HEAD` to a
  protected branch in the same command (claude-factory-9zd5):
  - writes a git administrative path (`.git`, `.git/HEAD`, a linked worktree's
    `.git/worktrees/<name>/HEAD`, or `.git/config`)
  - names a `--git-dir`/`--absolute-git-dir`/`--git-path`/`--git-common-dir` flag, or a
    `GIT_DIR`/`GIT_COMMON_DIR` name
  - writes a plain word or glob named `HEAD` outside `git`/`gh` argv (a redirect target, or a
    `dd`, `mv` or `ln` operand), with no `.git` path needed at all
  - runs from a cwd already inside a `.git`-named directory

- `worker-hook`: the protected-branch push guard now denies a unique abbreviation of a `git push`
  or `git send-pack` long flag, the same as the full flag name. This covers `--all`,
  `--branches`, `--mirror`, `--prune`, `--repo`, `--push-option`, `--receive-pack`, `--exec`,
  `--recurse-submodules`, `--remote` and `--stdin`. An abbreviated value flag (`--repo`,
  `--push-option`, `--receive-pack`, `--exec`, `--recurse-submodules` on push; `--receive-pack`,
  `--exec`, `--push-option`, `--remote` on send-pack) still takes the next word as its value, so
  the guard denies the whole call instead of a guess. `git push -o <value>` works the same way:
  a short-flag cluster that also holds the letter `o` (`-uo`, `-fo`) takes the next word as that
  value too, so the guard denies the whole call. A `--no-dry-run` word, or an abbreviation of
  it, now clears an earlier `-n`/`--dry-run` flag on the same command line, in either order. Real
  git 2.54 confirmed each form still pushes a protected branch.

  The guard now checks this value-flag risk before it checks for a dry run.
  A word right after an abbreviated value flag, or an `-o` short-flag cluster, can look like
  `-n` or `--dry-run`. That word is really the flag's own value. It is not a dry-run flag.
  Real git 2.54 confirmed the risk. `git push --rep -n origin main` still pushes.
  `git push -uo -n origin` also still pushes.
  A true dry-run flag with no value flag in front of it still allows the push.
  One example is `git push -n --mirror o`.

  `sendPackDenied` and the same-command HEAD-push risk check now share one parser for a
  `git send-pack` call's arguments. A flag change in one parser can no longer drift out of
  step with the other. (claude-factory-ctae)

- `worker-hook`: fail closed when one command changes the branch (`checkout`,
  `switch`, `branch -m`/`-M`, `symbolic-ref HEAD`, `rebase <upstream> <branch>`,
  `rebase --root <branch>`, `stash branch`, `bisect reset <ref>`, `update-ref --stdin`,
  or a git-flag abbreviation of one of these) and then pushes `HEAD` to a protected
  branch in the same command. (claude-factory-c63)
- `touchesBeadsActor` in `src/worker-hook.ts` now reads the options of an `env` word. It reads them
  the same way as the real `env` command. The old scan stopped too soon.
  It stopped at the first word that is not a flag, or at the first `bd` word.

  The old scan did not catch these bypass forms:

  - `env -uBEADS_ACTOR`: a short option joined to its value
  - a lone `env -`: the same effect as `--ignore-environment`
  - `env -iu FOO`: a cluster of short options
  - `env -C /tmp -u BEADS_ACTOR`: the value flag `-C /tmp` ended the old scan too soon

  The old scan also did not catch these forms:

  - `env -S'-i ...'`: the `env -S` value can clear or unset `BEADS_ACTOR`
  - `env -u bd -u BEADS_ACTOR`: the first `-u` value is `bd`, which ended the old scan before the later `-u BEADS_ACTOR`
  - `env -i sh -c 'bd create x'` and `env -i bash -c "..."`: a `bd` word hides in a shell `-c`
    script, under a clear-all `env -i`
  - `env -i eval "bd create x"`: a `bd` word hides in an `eval` word, under a clear-all `env -i`
  - `env -iS'bd create x'`: a short cluster can hold other option letters before the `env -S`
    flag. The earlier fix for `env -S` removed the whole word. That removal lost a clear-all
    `i` right before the flag

  The fix also corrects an error in the first version of the wider scan. That version read past
  the `env` command itself. It also read into the flags and arguments of the command that `env`
  runs. The guard now allows these two lines again:

  ```
  env LC_ALL=C grep -rn BEADS_ACTOR src
  env FOO=1 grep -i x bd
  ```

  The guard now denies every bypass form above. This change is bead claude-factory-igj.
  It follows claude-factory-8pc.24 and claude-factory-8pc.27.

- Fixed: `gitReason` (`src/worker-hook.ts`) read the current branch with
  `gate.headOf(root)`, where `root` never moves. An earlier `cd`, `pushd` or
  `popd` word in the same command can move the real push to a different
  repository. A `HEAD`-alias push (`HEAD`, `@`, or no refspec at all) then
  read the wrong repository's branch, and can reach a protected branch
  there unchecked. (claude-factory-68gn)
  - Fix: `anyGitReason` and `anyShellReason` each track `moved` in one
    forward pass over a segment's words, seeded by `denyAt`'s own
    `movedSoFar` (true once a `cd`, `pushd` or `popd` word has run, in this
    command or an outer one). An `env -C`/`env --chdir` flag or a `git
    --git-dir` flag also sets `moved`, for the one command it wraps. Once
    `moved`, `gitReason` never calls `gate.headOf` and never trusts a `-C`
    value; a denied push returns the new `PUSH_DIR_REASON` in place of
    `PUSH_REASON`. An explicit, non-protected branch still allows: it does
    not need the current branch at all.
  - The `moved` state threads through `denyAt`'s `sh -c`/`bash -c`/`eval`/
    `env -S` recursion too, so a `cd` before one of those still denies a
    `HEAD` push inside the recursed script.
  - Fix: `DIR_CHANGE_WORDS` also lists `chdir`, zsh's own builtin for the
    same job as `cd`. zsh is the worker shell on this host, so `chdir
    /other && git push origin HEAD` denied the same as a `cd` would.
  - Fix: `envChdirPresent` and `envSplitStringValue` now skip the value
    word of `-u`/`--unset`, `-P`, `-L` and `-U`. Before this fix, a value
    flag ahead of `-C`/`--chdir` or `-S`/`--split-string` hid it: `env -u
    FOO -C /other git push origin HEAD` allowed, the same way a real
    `env -u FOO -C /usr pwd` prints `/usr`, not the worktree root.
  - Fix (review round 2): `envChdirPresent` now also reads a `-C`/
    `--chdir` flag hidden inside an `env -S`/`env --split-string` value.
    GNU and BSD `env` both re-parse that value as more of `env`'s own
    flags at run time: `env -S '-C /usr' pwd` prints `/usr`. Before this
    fix, `env -S '-C /other' git push origin HEAD` allowed.
    (claude-factory-68gn.10)
  - Fix (review round 2): the value-flag skip above also covers `-a`/
    `--argv0` (the zeroth argument of the command `env` runs) and a
    short-flag cluster whose last letter is a value flag, such as `-iu`,
    `-va` or `-0u`. Before this fix, `env -iu FOO -C /other git push
    origin HEAD` and `env -a x -S 'git push origin main'` both allowed:
    `env -iu FOO -C /usr pwd` prints `/usr` the same way `env -u FOO -C
    /usr pwd` does. (claude-factory-68gn.11)
  - Fix (review round 3): `wordsCarryChdir` now reads a unique prefix of
    a long `env` flag name. GNU `getopt_long` accepts a prefix in place
    of the name in full. Before this fix, `env --ch=/other git push
    origin HEAD` and `env --arg x -C /other git push origin HEAD` both
    allowed. (claude-factory-68gn.12)
  - Fix (review round 3): `wordsCarryChdir` no longer reads what an
    `-S`/`--split-string` value holds. It denies the flag itself now, in
    any form. GNU and BSD `env` strip a quote pair from each word in the
    value before the split. The old code split on whitespace alone, and
    missed a quoted flag inside: `env -S '"-C" /other' pwd` prints
    `/other`. Before this fix, the quoted form allowed.
    (claude-factory-68gn.13)
  - Fix (review round 3): `env` also appends the words already on its
    own command line, after an `-S`/`--split-string` value, to that
    value's own split words. It reads the combined list as one:
    `env -S '-u' X -C /other pwd` prints `/other`, since `X` becomes
    `-u`'s value and `-C` moves the command. Before this fix, this
    shape allowed too. (claude-factory-68gn.14)

- `worker-hook` checks the verb slot of a command.
  A dynamic word there now fails the check.
  A dynamic word can be a shell variable.
  It can also be a command substitution.
  It can also be a glob word.

  The old hook read that word as the literal verb. It let two commands through. Both allowed. One example is `V=push; git $V origin main`. A second example is `V=checkout; git $V main; git push origin HEAD`.

  The new reason code is `DYNAMIC_VERB_REASON`. It denies each case in the table below.

  | Case | Example | Bead |
  |---|---|---|
  | Dynamic word at the `git` verb slot | `git-$V, eval, sh -c` | claude-factory-p43v.1, claude-factory-p43v.2 |
  | Dynamic word at the `gh` verb slot, or at the `pr, repo, alias` subcommand slot | - | claude-factory-p43v.3 |
  | Dynamic `git config` key | - | claude-factory-p43v.4 |
  | Dynamic word before a guarded verb | `$G push origin main` | claude-factory-p43v.5 |
  | Substitution opener | `$(which git) push origin main` | claude-factory-p43v.5 |
  | Dynamic word at the `kubectl, ko, helm` verb slot, or at the `kubectl rollout, auth, certificate` subcommand slot | - | claude-factory-p43v.6 |
  | Two dynamic command words in a row | `$G $V origin main` | claude-factory-p43v.8 |
  | Dynamic `git -c`/`--config-env` key | `git -c $K=push p origin main` | claude-factory-p43v.9 |
  | Dynamic command word before a mutating `kubectl, ko, helm` verb | `$K apply -f x --context acme` | claude-factory-p43v.10 |
  | Dynamic `gh api` endpoint or `-X`/`--method` value | `gh api $E -X PUT` | claude-factory-p43v.11 |
  | Dynamic `-c`/`--config-env` pair with no literal `=` | `git -c "$KV" p origin main` | claude-factory-p43v.13 |
  | Dynamic `-c` key after a dynamic command word | `$G -c $K=push p origin main` | claude-factory-p43v.14 |
  | Shell reserved word (`do, then, if, !`) before the dynamic command word | `for f in a; do $G $V origin main; done` | claude-factory-p43v.15 |
  | Dynamic word before a `kubectl rollout, auth, certificate` sub-verb, or behind an unknown wrapper | `caffeinate $K apply -f x --context acme` | claude-factory-p43v.16 |
  | Wrapper flag, or `coproc`, before the dynamic command-word pair | `sudo -u x $G $V origin main` | claude-factory-p43v.19 |
  | Dynamic command word before `--config-env` (attached or two-word form) | `$G --config-env alias.p=E p origin main` | claude-factory-p43v.20 |
  | Unlisted wrapper flag before the dynamic command-word pair, known or unknown, attached or separate, with or without a value | `sudo -E $G $V origin main` | claude-factory-p43v.21 |
  | `coproc NAME` before a brace group or subshell, before the dynamic command-word pair | `coproc NAME { $G $V origin main; }` | claude-factory-p43v.22 |
  | `NAME=value` operand after a wrapper's own name or flags | `env A=1 $G $V origin main` | claude-factory-p43v.25 |
  | `timeout`'s duration word after its own `--` | `timeout -- 5 $G $V origin main` | claude-factory-p43v.26 |
  | The `MAX_COMMAND_ANCHORS` cap on many unknown flag/value pairs in a row | `sudo` plus 16 `-R /` pairs plus `$G $V origin main` | claude-factory-p43v.27 |
  | A `{}` word (`find -exec`, `xargs -I {}`) at the git or gh verb slot | `find push -maxdepth 0 -exec git {} origin main ;` | claude-factory-p43v.29 |
  | `NAME=value` operand with a dot, a dash or a leading digit in the name, or after a wrapper's own `--` | `env a.b=1 $G $V origin main`, `env -- A=1 $G $V origin main` | claude-factory-p43v.30 |
  | `timeout`'s duration operand in the GNU `1e1` or `inf` form | `timeout 1e1 $G $V origin main` | claude-factory-p43v.31 |
  | A nested wrapper's own name, or an unpaired dynamic flag value, stopping the chase early | `sudo -Z "$P" env $G $V origin main` | claude-factory-p43v.32 |
  | A single dynamic word past the `MAX_COMMAND_ANCHORS` cap, with a literal tail and no dynamic partner | `sudo` plus 16 `-R /` pairs plus `$K apply -f x` | claude-factory-p43v.33 |
  | A dynamic flag value before another flag pair stops the chase too soon | `sudo --user $U --close-from 3 $G $V origin main` | claude-factory-p43v.35 |

  `commandAnchors` (`src/worker-hook.ts`) gives a short list of start indices. It replaces the
  old single verb-slot index. It goes around a wrapper's flags, known or unknown. An unknown
  flag does not move the real command off that index.

  An unknown flag can read the next word as its own value. This is why the hook denies
  `sudo -Z v cp "$A" "$B"`. The hook cannot tell `v` apart from the value of `-Z`, with `cp` as
  the real command. This is an accepted deny, not an over-deny.

  The hook had a bug. A bare `{}` word matched a kubectl mutating verb by mistake. The match
  happened at the command slot. This fix removes that match. `{}` stays dynamic in all other
  positions (claude-factory-p43v.28).

  Before this fix, the hook read `{}` after `cp` or `delete`. The hook read it as a kubectl
  mutating verb. The hook then denied an ordinary command. The command was
  `xargs -I {} cp {} dest`. That command has no git, gh, kubectl, ko or helm call.

  A later fix (claude-factory-p43v.29) kept the command-slot exemption, but made `{}` dynamic
  again in every other position. Now `find -exec` cannot hide a real git call behind `{}`, and
  `xargs -I {}` cannot hide a real gh call behind `{}` either.

  Only 3 call sites in `src/worker-hook.ts` still skip `{}` at the command slot. One site is
  `commandAnchors`. The other 2 sites are the `cmd[0]` check in `anyDynamicCommandReason`, and
  the `cmd[0]` check in `anyDynamicLiveApplyReason`.

  The dynamic command-word check for `kubectl, ko, helm` (claude-factory-p43v.10) now returns
  `DYNAMIC_VERB_REASON`, not `LIVE_REASON`. `LIVE_REASON` names `kubectl`, `ko` or `helm` by name.
  This check can deny a command that names none of those 3 tools, such as `$PIP install
  requests` (claude-factory-p43v.17).

  A dynamic `git` branch-change argument also marks the branch as changed.
  The table below lists each verb, the push rule, and the loop rule.

  | Case | Example | Note |
  |---|---|---|
  | Branch-change verb `stash` | `git stash $V main` | marks the branch changed |
  | Branch-change verb `branch` | `git branch $F main` | marks the branch changed |
  | Branch-change verbs `bisect, rebase, symbolic-ref, update-ref` | same rule | marks the branch changed |
  | Push after a branch change | `git push origin HEAD` in the same command | denies with `PUSH_REASON` |
  | Loop, not a verb slot | `for f in a b; do git add $f; done` | still allows (claude-factory-p43v) |

- Fix: an existing `git` or `gh` alias cannot hide a denied verb.
  `gitReason` and `ghReason` resolve a verb word that is not a builtin.
  For git, they use `git config --get-regexp ^alias\.`. For gh, they use `gh alias list`.
  They read the alias table at the tool call's own cwd only.
  Then they check the alias text again as the real command.

  Before this fix, these commands passed unseen:

  - A host that had `alias.co=checkout`: `git co main && git push o HEAD` pushed a protected branch.
  - A host that had `alias.br=branch`: `git br -M main && git push o HEAD` did the same.
  - A host's default `gh` alias `co` for `pr checkout`: `gh co 5 && git push` did the same.

  This guard denies the command with `ALIAS_USE_REASON`. It does so when it cannot find a safe answer for the verb word:

  - The guard cannot read the alias table.
  - The alias is a `!` shell alias, or its text has an unclosed quote or a trailing backslash.
  - The alias chain has a depth of more than 10 levels.
  - An earlier change makes the right alias table unknown. These changes are: `cd`, `pushd`, `popd`, `chdir`, `env -C`, `--git-dir`, `--bare`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` or `HOME`.

  A `-C` word also denies the command outright. This guard never follows `-C` to a new directory; see claude-factory-bemr.16 below. The guard checks 2 cases:

  - The verb position is certain, and a `-C` word sits before the verb.
  - The verb position is unsure, and a `-C` word sits anywhere in the command.

  An unknown global flag can also make the verb position unsure. In that case, a later non-flag word can match a key in the table. The guard then denies the command.

  `gitReason` skips these git global flags with certainty when it looks for the verb word. None of them takes a value word.

  - No-value flags: `-p -P --paginate --no-pager --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --no-advice --no-lazy-fetch`
  - For example, `git --no-pager co main && git push o HEAD` still denies. `--no-pager` does not hide `co` as an alias for `checkout`.
  - `git --bare status` still allows. `status` is a builtin verb, so the alias check does not run for it.

  `gitReason` steps past the one value word of `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--attr-source`, `--config-env`. It does so even when that value word is a literal `--`. Real git has no end-of-options marker before the verb. So this guard's scans do not stop at one either. For example, `git --attr-source -- p origin main` pushes a protected branch when `alias.p=push` is set.

  claude-factory-bemr.16: Three review rounds (bemr.8, bemr.14, bemr.16) each found one more command. In each one, this guard's own fold of `-C` into a directory path did not match real git's parser. So a command passed that the guard must deny.

  This guard no longer folds `-C` into a directory. It reads the alias table at the tool call's own cwd only. When a `-C` word can move that read elsewhere, the guard denies the command outright. It does not calculate where the read can move.

  For example, `git -C a -C b p origin main` now denies. It does so even when `alias.p=push` is set only at `a/b`, not at the tool call's own cwd.

  `git sw -C main && git push origin HEAD` also now denies, with `alias.sw=switch`. The `-C` here is not a global flag. It is `switch`'s own create-and-switch flag. The earlier fold still misread it as a global flag. So it moved the alias-table read to an alias-free directory, which is an incorrect one.

  `gitDashCPushDenied` reads a `-c name=value` pair only as 2 separate words. Real git has no attached `-c name=value` form.

  It reads a `--config-env` pair as `name=envvar`. The pair can be attached, or be 2 words. In this form, `envvar` is the name of an environment variable. It is not a literal value.

  It denies the same keys either way: `alias.*`, `remote.*.push`, `remote.*.mirror`, `push.default`, `include.path` and `includeIf.*.path`. It does so because it cannot read the environment variable's own text.

  `anyGitReason` and `anyGhReason` check every word of a command, not only the command word. So a `git` or `gh` word in the argument of another command still opens this alias scan. For example, `grep git README.md`.

  On a host with a readable, empty alias table, the guard allows this command. `README.md` is not a key in the table.

  The guard denies `cd docs && grep git README.md` with `ALIAS_USE_REASON` instead. The `cd` makes the alias table unknown.

  The code now exports `GIT_BUILTIN_VERBS` and `GH_BUILTIN_VERBS`. Their tests check the shipped sets, not a separate copy. A `gh` alias chain also has its own depth-cap test. It sits next to the git test. Bead IDs:

  - claude-factory-bemr, claude-factory-bemr.5, claude-factory-bemr.6, claude-factory-bemr.7
  - claude-factory-bemr.8, claude-factory-bemr.9, claude-factory-bemr.10, claude-factory-bemr.11
  - claude-factory-bemr.13, claude-factory-bemr.14, claude-factory-axok
  - claude-factory-bemr.16, claude-factory-bemr.17, claude-factory-bemr.18

- The worker hook now denies a shell function definition: a `name()` pair, the `function` keyword, a zsh `functions[...]` write, and a bash `BASH_FUNC_` import. A function name could hide a `git push`, `sh -c` or `rm` word from every guard. The deny reason is `FUNCTION_DEF_REASON`. A more specific reason still wins. Write the commands plainly, or write the function to a `.scratch` script file with the Write tool and run it with `bash` or `zsh` (claude-factory-4i60).
- The worker hook now reads the `-c` script after a dynamic word in the shell slot. Before, `SH=sh; $SH -c 'git push origin main'`, `/bin/s? -c '...'` and `s{h,} -c '...'` ran the script unchecked, because the guard matched only the literal names `sh`, `bash`, `zsh` and `dash`. A word with `$`, a glob, a brace or a leading `~` now takes the same path. The guard denies only when the script itself is denied, so `$CC -c foo.c` stays allowed. The `bd` scan has the same fix (claude-factory-sft4).
- Fixed: the worker hook did not read the script of a shell that has no `-c` script. Such a shell is a `sh`, `bash`, `zsh` or `dash` word, or a dynamic command word. It reads its script from a pipe, a redirect or a here-string. Example: `echo 'git push origin main' | sh` ran unchecked. Now the hook denies it with `SHELL_STDIN_REASON`, when the command holds a `|`, a `<`, a `>(`, a `=(` or a `coproc` word. The hook reads a redirect that sticks to the shell word (`sh<<<P`), `source` and `.` with a stdin operand, and `xargs` with a replace flag (`-I`, `-i`, `-J`, `--replace`) before a shell word. The hook also denies `xargs` before a shell word that has no literal `-c` script. The hook also folds `//`, `./` and `..` in a stdin operand, reads a redirect glued to it, and counts one value for each `o` or `O` letter in a flag cluster. The operand check now denies by default. A shell passes only with a `-c` script or a plain script path, so a `#` comment word, a quoted word or a glob as the operand denies. `xargs` before any shell word denies. `sh script.sh` and `bash -x file.sh` stay allowed (claude-factory-l43b). It also reads xargs in any letter case and the bash rcfile value and a redirect glued to the xargs word (l43b.20-.22).
- Fixed: a slow `bd sync` no longer holds the start of ready beads. The sync now runs in its own `factory sync` pass. The pass syncs the due rigs in parallel, and kills each call after `FACTORY_SYNC_TIMEOUT_MS` (default 120000). A rig that fails the same way again waits 5, 10, 20, 40, then 60 minutes, and the board row shows the count and the next try. `dispatch.json` now has a `skip` row with the reason for each ready bead that dispatch did not start. A `factory` child of a parent with no `factory` label and no live run now starts on its own (claude-factory-2rik).
- Fixed: the worker hook did not see a zsh `=cmd` word as dynamic. Example: `=sh -c 'git push origin main'` and `=git push origin main` ran unchecked, because zsh expands a leading `=` word to the command path. The command word and the shell word now deny when they start with a single `=`. The words `x=y`, `--flag=value` and `a==b` stay allowed (claude-factory-jsy0).
- The worker hook now denies a `#` comment line or a here-document that has a quote, a backtick or a backslash, when more text follows. Before, a quote in this text hid a later push to main from `segments()`. Examples are `true # don't` and `cat <<EOF` with `don't` in the body. `segments()` returns the same words as before, and two deny-only flags add the denies (`COMMENT_REASON`, `HEREDOC_REASON`). A commit message with a `cat <<'EOF'` substitution still passes. Some safe commands deny too. In that case, run the later commands in a separate Bash call (claude-factory-wmsr).
- Fixed: a redirect target or write operand with thousands of `*` could make the worker hook outlast its 10 s timeout, so the command ran unchecked. Example: `echo x > H` with 8000 `*` and `x`. The HEAD-name test now collapses star runs and denies a glob with more than 4 stars, as the global git config test does. It also spends scan work for each glob test (claude-factory-267o).
- Fixed: an AX worker that never started now fails at the station deadline with the cause (`worker never started on AX after N min: task phase Pending`, `egress policy not created` or `brief.md not yet copied to the VM`), not `no report within N min`. `factory metrics` lists it as `not started`. A local pane that never started (`the worker never started in pane ...`) has the same class. Two such fails in a row ask the person, and the next deadline stays the same length.
- Fixed: the worker hook did not see a zsh `=rm` word as `rm`. Example: `=rm -rf /`, `sudo =rm -rf /`, `=sudo rm -rf /` and `find / -exec =rm -rf {} +` ran unchecked, because zsh expands `=cmd` to the path of `cmd` in every word position. The hook now reads `=cmd` as `cmd` (`==x` and a lone `=` stay as they are). Bead claude-factory-6sz8.
- Fixed: the worker hook did not see the command inside a brace group. Example: `{ rm -rf /; }` and `{ A=x rm -rf /; }` ran unchecked, because the hook read `{` as the command word. The `{` word is now a shell prefix, like `if` and `then`. `echo {a,b}` and `find . -exec ls {} +` stay allowed. Some older deny reasons change: `x | { rm -rf /; }` and `coproc { rm -rf /; }` now give the `rm` reason, and so does `f() { rm "$@"; }; f -rf /tmp/x` (claude-factory-fmeu).
- Fixed: the worker hook let `A+=x rm -rf /` run. Bash and zsh read `NAME+=value` as a prefix assignment. zsh also reads `NAME[sub]=value`, `NAME[sub]+=value` and non-ASCII names. The hook read these words as the command. A new `shellAssignmentWord` test covers these forms in `commandAnchors` and the `env` scan. A new deny-only check, `assignmentReadingsDeny`, reads each word with `=` as the command and as an assignment. It denies when `rm` or `find -exec rm` runs under either reading. An ambiguous assignment prefix denies with `ASSIGNMENT_PREFIX_REASON`. `realCommand` has the same text as before, so the hook allows no command that it denied before (claude-factory-mmc9).
- Fixed: the worker hook did not see the command after the zsh word `repeat N`. Example: `repeat 1 rm -rf /` ran unchecked, because the hook read `repeat` as the command. zsh runs the rest N times. The hook now skips `repeat` and its count word, and reads the rest as the command. The hook denies a dynamic count word (`repeat $N ls`). Bash has no `repeat`. `repeat 1 ls` and `echo repeat 1` stay allowed (claude-factory-dtr2).
- Fixed: the worker hook did not see the sub word of `gh pr` or `gh repo` after a flag. Example: `gh pr -R o/r merge 1` and `gh pr --repo=o/r merge 1` ran unchecked, because the guard took the flag as the sub word. The hook now steps past the `-R` and `--repo` values to find the sub word. After an unknown flag, it denies `merge`, `sync` and `ready` (and tracks `checkout`) when the word is present. `gh pr -R o/r view 1` stays allowed (claude-factory-zsj0).
- Fixed: the worker hook did not see a glob in the command word. Example: `/bin/[r]m -rf /` and `/bin/r? -rf /` ran unchecked, because bash and zsh expand the glob to `rm`. The hook now denies a command word that has `*`, `?` or a `[..]` pair. This includes the word after `sudo`, `env`, `nice`, `time`, `nohup`, `timeout`, `exec` or `command`. It also includes the word after `find -exec`, `-execdir`, `-ok` or `-okdir`. A glob in an operand (`ls *.md`) and the `[` and `[[` test words stay allowed (claude-factory-clcc).
- Fixed: the worker hook did not see a quoted or escaped assignment name as a command. Examples are `"d"=1/rm -r ./d`, `d\=1/rm -r ./d` and `A=1 "d"=1/rm -r ./d`. Bash and zsh run such a word as a command. But `segments()` removes the quotes, and `realCommand` skipped the word as `NAME=value`. The hook now marks a word with a quote or a backslash before its first `=`. It denies the word with `QUOTED_ASSIGNMENT_REASON` when `realCommand` skips it. `segments()` and `realCommand` return the same words as before. `sudo` and `env` with such a word also deny, although they are safe. `A=1 ls`, `A="x y" ls` and `echo "d"=1` stay allowed (claude-factory-upag).
- Fixed: the worker hook did not see a verb or sub word behind an empty word or a lone `-`. Example: `gh pr '' merge 1`, `gh pr - merge 1`, `kubectl --context acme '' apply -f x.yaml` and `helm --kube-context acme - upgrade r c` ran unchecked. The cobra tools (gh, kubectl, helm, ko) skip such a word at the verb and sub word slots. The hook now does a second, deny-only scan that skips it there. A flag value stays a flag value: `gh pr -R - merge 1` still denies. `git '' push` is not affected (claude-factory-t1xo).
- Fixed: the worker hook did not see the command after a zsh `-` word. Example: `- rm -r ./d` and `A=1 - rm -r ./d` ran unchecked, because zsh runs the next word as the command. The hook now reads a lone `-` as a wrapper. `cat -` and `git diff -` stay allowed (claude-factory-tyz6).
- Fixed: the worker hook did not see a `<` or `>` redirect glued to a command, verb or sub word. Examples: `rm>/dev/null -rf /`, `gh>/dev/null pr merge 1`, `gh pr>f merge 1` and `git push>f origin main` ran unchecked. `segments()` kept `rm>f` as one word, but bash and zsh run `rm`. Now the hook reads the command a second time, with each such word cut at the operator. The second reading only adds denies. `segments()` returns the same words as before. `ls>f`, `git log>f`, `rm\>f -rf /` and `'rm>f' -rf /` stay allowed (claude-factory-4a4o).
- Fixed: the worker hook did not see a command that a glued shell expansion splits into words. Example: `rm${IFS}-rf${IFS}/`, `rm$IFS-rf$IFS/`, `git${IFS}push${IFS}origin${IFS}main` and `rm$(echo " ")-rf /` ran unchecked, because the shell splits the expansion at run time and the guard read one word. The hook now reads the command again with each expansion that touches other text as a word break. It adds a deny only, and it runs after the other checks, so every earlier reason stays first. A whole-word `$X` and text such as `echo a${X}b` stay allowed (claude-factory-j1ki).
- Fixed: the worker hook did not see `rm` behind a wrapper flag that it does not know. Example: `/usr/bin/time -l rm -rf /`, `nice -5 rm -rf /`, `timeout --foreground 5 rm -rf /`. The hook now reads each unknown flag as a bare flag and as a flag with a value word, and denies if either reading reaches a risky `rm` or `find -exec rm`. The hook also denies `time -l echo rm -rf /`, because `-l` can take `echo` as a value. The hook also reads a lone `-` after `env` or after `env --`, an `a.b=1` operand after `env` or `sudo`, and each `xargs` flag as a bare flag and as a flag with a value. `command -v rm` stays allowed. This also fixes claude-factory-9l9w. (claude-factory-21ux)
- Fixed: the worker hook did not see a recursive `rm` when a redirect word came before the flag. Example: `rm 2>o -r src` ran unchecked, because the hook stopped reading flags at the redirect word. The shell takes the redirect out of the `rm` arguments. The hook now skips the redirect word and its target, and reads the flags after them. `rm 2>o a.txt` and `ls 2>o -R` stay allowed (claude-factory-g4l4).
- Fixed: the worker hook did not see a command after a comment line that ends in a backslash. A shell keeps that backslash in a comment, so the next line runs. Example: `true #a\` then a new line with `git push origin main`. The hook joined the two lines and read the push as comment words. The hook now denies a comment line that ends in a backslash when more text follows, with `COMMENT_CONTINUATION_REASON`. It also reads the scripts of `sh -c` and `eval`. It also covers a double-quoted `$( )` body (claude-factory-mozp).
- Fixed: the worker hook did not read the options of `sudo`. An unknown option, such as `-E`, `-s`, `-H`, `-n` or `--preserve-env`, hid the command, so `sudo -E rm -rf /` ran unchecked. The hook now reads `sudo` options as `getopt_long` does: option clusters, attached values, long names and unique prefixes, `NAME=value` words and `--`. It reads an unknown option as a bare flag.
- Fixed: the worker hook did not see a lone variable command word that runs the command the variable holds. Example: `X="rm -rf /"; $X`. Bash splits an unquoted `$X` into words. Now the hook reads a value that the same command text sets (`NAME=value`, `export`, `declare`) as the command. It also reads it behind `eval`, `bash -c` and wrappers. It denies a set value that it cannot read (a substitution, a glob, `+=`, `for`, `read`, a set `IFS`). A name set twice with different values, a `declare` flag, `${X:=v}`, an `eval` script write and `env NAME=v` also count. A name with no visible set, such as `$EDITOR a.txt`, stays allowed (claude-factory-miqy).
- Fixed: the worker hook did not see the command after the zsh modifiers `noglob` and `nocorrect`. Example: `noglob rm -rf /` and `nocorrect A=x rm -rf /` ran unchecked, because zsh runs the next word as the command. The hook now skips both words like `sudo`. Bash does not run them (claude-factory-563n).
- Fixed: the worker hook did not see a command word that expands to `rm`. Example: `${RM:-rm} -rf /`, `r${x}m -rf /`, `rm$x -rf /` and `>f ${RM:-rm} -rf /` ran unchecked, because the hook read the literal word. Now one fail-closed rule covers a command word that has `$`, a backtick or a glob character. It does not model shell expansion. The hook denies the word in these cases. The word has an open `${`, `${!` or a backtick. Recursive flags or flag text follow the word or sit in it, so `r$x"m" -rf /` cannot hide `rm`. Another segment holds flag text. The word can read as `rm` or `find` and a target is risky. `$EDITOR acme.txt`, `echo $x rm` and `$x ls` stay allowed. `$GREP -r x .` now denies with the rm message (claude-factory-pwy0).
- Tests: new rows pin how the worker hook reads `sudo` NAME=value words before an option, such as `sudo A=1 -u root rm -rf /` and `sudo A=1 -- ./d=1/rm -r ./d`. The hook denies these rows. `sudo A=1 -u root ls` stays allowed. The fix came with claude-factory-aylh (claude-factory-p6wn).
- Fixed: the worker hook did not deny a quoted `git push` inside a double-quoted substitution when a false comment or here-document hid it. Example: `echo "$(echo <(true)#x ; 'g'it push origin main)"`. The cleaner blanked the quote characters, so the hook read the wrong words. The hook now also reads the raw body. This adds a deny reading only (claude-factory-j1dr).
- Fixed: the worker hook did not see `rm` behind a wrapper word, or behind `-ok` and `-okdir`, in a `find` exec slot. Example: `find / -exec env rm -rf {} \;`, `find / -exec sudo rm -rf {} \;`, `find / -ok rm -rf {} \;` and `>f find / -exec rm -rf {} \;` ran unchecked. The hook now reads `-ok` and `-okdir` like `-exec`. If the word after the slot is a wrapper, the hook looks for a recursive `rm` after it. The hook also reads the command again without redirect words. This adds a deny only. `find . -exec env FOO=1 cat {} \;` and `find . -exec rm {} +` stay allowed (claude-factory-j471).
- Fixed: the worker hook did not deny an `rm` with a brace list that hides a path outside the root. Example: `rm {,../}x` and `rm {x,/etc/passwd}` ran unchecked, because the shell expands the list before `rm` runs. The hook now treats a `{` in an `rm` target as risky, like a glob character. This adds a deny only (claude-factory-q462).
- Fixed: the worker hook did not see a command inside a zsh brace group that starts in the middle of a segment. Example: `repeat 1 { rm -rf /; }`, `if [[ 1 ]] { rm -rf /; }`, `while [[ 1 ]] { ... }` and `{ true } always { rm -rf / }` ran unchecked, because the hook read only the first command of the segment. The hook now reads the words after each `{` word (not at the first position) as a new command, for the `rm`, `find -exec rm`, `cd` and dynamic-word checks. This reading only denies. A segment with more than 16 such `{` words denies with `SCAN_BUDGET_REASON`. Some safe commands deny too, for example `echo { rm -rf / }`. zsh also opens the group when the command word touches the brace, for example `repeat 1 {rm -rf / }`. The hook now reads that form too. A body after a spaced `{` gets the same wrapper-flag and dynamic-word checks as an outer command, for example `repeat 1 { nice --foo 3 rm -rf / }` and `repeat 1 { $X -rf / }`. A glued opener also holds its own closing brace or a brace list, for example `repeat 1 {sh}` and `repeat 1 {rm{,} -rf / }`. Only an unquoted word with no space that is wholly brace lists (`{a,b}`, `{1..3}`, `{acme,widget}/{src,test}`) is not an opener, and a quoted word such as `'{print$1}'` or `'{ rm -rf / }'` is never one, so those stay allowed. A glued `{` word opens a group only where a command starts (the segment start, after a reserved word, `repeat N`, a wrapper, `]]` or `} always`). In an argument it is a plain word, so `echo {a[0]} x` and `printf %s {a[1]} y` stay allowed. Beads claude-factory-4iod, claude-factory-4iod.5, claude-factory-4iod.7, claude-factory-4iod.11 and claude-factory-4iod.12.
- Fixed: the worker hook did not deny a command that defines a shell alias and then runs it with `eval`, `trap`, `source` or a substitution. The alias table of the hook holds only the aliases of the shell snapshot, so `alias g='git push origin main'; eval g` ran unchecked. The hook now denies a command that may define an alias and also runs more than plain `alias` commands. The hook also denies an expansion in an argument of a command that is not an external program (`set -A ${n}ases`) when the command has a second segment or a substitution. A command word with a slash is an external program, so `/abs/bin/factory memory search "alias"` stays allowed. This adds a deny only (claude-factory-mn2y).
- Fixed: the worker hook did not deny a command word `$_`. Example: `: rm; $_ -rf /`. The shell sets `$_` to the last argument of the previous command, so it can hold any command. The hook now denies `$_` and `${_...}` at a command position, also behind `sudo`, `env` and `command`. `echo $_` and `cd "$_"` stay allowed. This adds a deny only (claude-factory-teku).
- Fixed: the worker hook did not see `rm` or `find -exec rm` after a dynamic command word. Example: `X=command; $X rm -rf /`, `$X -p rm -rf /` and `sudo $X rm -rf /` ran unchecked, because `$X` can expand to `command`, `sudo` or `env`. The hook now reads the word after each dynamic command word (past flags and wrappers) with the same `rm` and `find` rules. `$N ls` and `echo $N rm` stay allowed. A dynamic word before a recursive `rm` now denies, for example `$GIT rm -r --cached x`. Literal `git rm -r` stays allowed (claude-factory-2a3i).
- Fixed: the worker hook did not deny `find -exec rm` when a glob word hid the action. Example: `find . -exe? rm -rf / ';'`. The shell can expand `-exe?` to a file named `-exec`. Then `find` runs the action. The hook now reads a find word as an exec action if it starts with `-`, `*`, `?` or `[` and has a glob character. This adds a deny only (claude-factory-dnaf).
- Fixed: the worker hook did not read a bash `{fd}>f` redirect word as a redirect. Example: `X=rm; {fd}> f $X -rf ./x`, `echo x {fd}>~/.gitconfig` and `echo x | {fd}> f $SH` ran unchecked. The word hid the command word, the git config path or the shell word. Three readers now accept an optional `{NAME}` or `{NAME[sub]}` prefix before the operator. `{ echo x; }` and `echo {a,b}>f` stay allowed. The hook also reads `rm` and `find -exec rm` again without redirect words. The cd and rm pair rule counts them. This adds a deny only (claude-factory-sdur).
- Fixed: the worker hook did not see a command that a glued nested default splits into words. Example: `rm${X:-${IFS}}-rf${X:-${IFS}}/` and `git${X:-${IFS}}push${X:-${IFS}}origin${X:-${IFS}}main` ran unchecked, because the hook ended the `${...}` at the first `}`. The hook now ends it at the matching `}`. A `${` adds depth, a bare `{` does not. The hook also reads the old way (the first `}` ends the span) and reads a stray `}` that is left over as a word break. It denies if either reading denies. The hook also reads the raw command text, where quotes and backslashes are visible. It reads each unquoted and unescaped glued `${...}` or `$NAME` as a space, so an escaped or single-quoted `${` cannot hide a command. If no matching `}` exists, it ends at the first `}`. `echo ${X:-${HOME}}x` stays allowed (claude-factory-dnw1).
- Fixed: the worker hook did not read a `trap` action as a script. Example: `trap 'git push origin main' EXIT` ran unchecked, because the shell runs the action later. The hook now reads the action word, and each dash-led word before it (zsh has no trap options), like an `eval` script. `trap - EXIT`, `trap -p` and `trap 'echo hi' EXIT` stay allowed. `source <(...)` was already denied (claude-factory-81tz).
- Fixed: the worker hook did not deny a later dynamic word after a dynamic command word and its wrapper flags. In `$X -u root $Y -rf /`, `$X` can be `env` and `$Y` can be `rm`. The hook now denies a later dynamic word that has recursive flags or a risky target (claude-factory-0xw4).
- Fixed: the worker hook let `eval -- rm -rf /` run. The `--` word hid the real head of the eval script. The hook now skips every leading `--` word or `-` word of an eval script before it reads the script. Bash `eval` has no options, and zsh `eval` skips each leading `-` word, so this only adds denies. Example: `eval - - rm -rf /` was not read. (claude-factory-sbfo)
- Fixed: the worker hook did not deny an `rm` with a leading `=cmd` target, such as `rm =ls`. zsh expands that word to the path of a command, which is outside the worktree. The hook now treats it as a risky `rm` target (claude-factory-e39x).
- Fixed: the worker hook did not see a push after a redirect word that follows a dynamic command word. Example: `$G >f push origin main` and `$G 2>&1 push origin main` ran unchecked. This adds a deny reading only (claude-factory-lpiu).
- Fixed: the worker hook did not see the global git config file under a ligature name. Example: `printf x >> ~/.gitcon` plus U+FB01 plus `g`. APFS folds case fully, so that name opens the real file, but a regex `i` flag folds only simply. The path tests now fold a non-ASCII word as `baseWord` does (claude-factory-93fx).
- Fixed: the worker hook did not deny a zsh brace-less flag run or a glued subscript as the head of a set name. Example: `X="git push origin main"; eval $~X`, `$=~X` and `X=bd; $X[(w)1] init` ran unchecked, because the hook read only `$=NAME` and `${...NAME...}` as an operator head. The hook now reads `$~X`, `$^X`, `$=~X`, `$X[1,2]`, an open `$X[(w)1]` and a `:modifier` suffix such as `$=X:l` as an operator head of the set name, and denies it. `$~X`, `$X[1,-1]` and `eval $~X` with no set, and `$^foo a.txt`, `echo $~X` and `$X[1] a.txt` stay allowed. This adds a deny reading only (claude-factory-bc1u).
- Fixed: the worker hook did not see the key of a `git config` call with a `--comment` or `--value` flag. It read the value word as the key, so `remote.origin.push` and `core.worktree` writes ran unchecked. The hook now reads `--comment`, `--value`, `--blob` and `--url` as flags with a value word. It also reads a unique long-flag prefix (`--comm`) and a short cluster whose first `f` or `t` is its last letter (`-zf`) the same way (claude-factory-v5iw).
- Fixed: the worker hook did not deny `find` with a brace word that expands to the `-exec rm` action. Example: `find . {-exec,rm} -rf /` and `find . {-exec,nice} -n 5 rm -rf /`. The same holds for brace flag words after `-ok` and `-okdir`. (claude-factory-gj9l)
- Fixed: the worker hook did not read a command word that glues text to a set variable. Example: `X=' push origin HEAD:main'; git${X}` and `X='sh -c'; ${X}x 'rm -rf /'` ran unchecked, because the shell splits the value into words. The hook now denies such a word when the name is set in the text. A path such as `HOME=/x; ${HOME%/}/bin/tool` stays allowed when a literal `/` follows the last expansion and the value is plain. `git${UNSET} status` and `${PAGER:-less} README.md` stay allowed. `B=bun; ${B}x test` now denies (claude-factory-piqf).
- Fixed: the worker hook did not see `rm` after a redirect word. Example: `>/dev/null rm -rf /`, `2>&1 rm -rf /`, `sudo >f rm -rf /`, `X=1 >f rm -rf /`, `find / -exec >f rm -rf {} \;` and `{x}>f rm -rf /` ran unchecked, because the redirect word read as the command word. A second, deny-only reading now drops the redirect words and reads the command again. `echo x > out.txt`, `cat < acme.txt` and `>/dev/null rm acme.txt` stay allowed. The zsh `repeat` and brace rows wait for claude-factory-9qvg (claude-factory-7xmz).
- Fixed: the worker hook did not deny a dollar command word after another segment sets `IFS`. Example: `IFS=_; y=rm_../acme.txt; $y` and `y=rm_-rf_/; IFS=_; $y` ran `rm` unchecked. The shell splits the value at run time. Now one rule applies. It has no list of forms. A command word with a dollar or a backtick denies in these cases: the text has 2 or more segments; its own segment starts with a `NAME=` or `NAME+=` prefix; an outer `eval`, `sh -c` or substitution scan had one of these. Examples: `export I$z=_`, `eval $a$b$c=_`, `y='rm ../acme.txt'`. This covers `printf -v`, `read`, a loop, `set --` and a nested shell. A specific reason (push, alias, here-document) wins over this one. This adds a deny only. `$EDITOR acme.txt` and `$x ls` stay allowed. Three false denies are accepted (fail closed): `export EDITOR=vim; $EDITOR acme.txt`, `SH=sh; $SH -c 'echo x'` and `export${IFS}PATH=/x; git status` (claude-factory-k8iz).
- Fixed: the worker hook did not see a command in a dynamic `sh -c` script. Example: `y='rm ../acme.txt'; bash -c "$y"` ran unchecked, because the shell expands `$y` at run time. The hook now denies a `sh`, `bash`, `zsh` or `dash` call with a `-c` flag cluster when a word after it holds `$` or a backtick, with `SH_DYNAMIC_SCRIPT_REASON`. This adds a deny only. Literal scripts such as `bash -c 'echo hi'` stay allowed. `bash -c 'echo $HOME'`, `sh -c "$CMD"` and `find -exec sh -c '...' _ {} \;` with a positional `$1` now deny (claude-factory-3frd).
- Fixed: the worker hook did not see a command word with a glued glob group. Example: `/bin/r(m) -rf /`, `/bin/rm(.) -rf /` and `/bin/@(r)m -rf /` ran unchecked, because zsh (and bash with `extglob`) runs the group as part of the command name. The hook now denies a word in the command slot that has an unquoted `(` glued to it, also behind `sudo`, `env`, `xargs`, `find -exec`, redirects and `bash -c`. `echo a(b)`, `(ls)`, `a=(1 2)` and `<(cmd)` stay allowed (claude-factory-5hjj).
- New: AX workers can push to the zach-source repos (claude-factory-192.11). The egress policy has two path-prefixed GitHub rules that use `GITHUB_ZS` and `GITHUB_ZS_BASIC` (vault keys). A worker of a zach-source rig uses them on every path. Other repos keep `GITHUB` and `GITHUB_BASIC`. Do not merge before the Substrate rollout of `pathPrefixes` (`ateapi`, `atenet`, `kubectl-ate`). See docs/remote-runner.md.
- Fixed: `factory repos sync` and the AX worker failed with "No active beads workspace found" for a rig with no `beadsRemote`. bd needs a `.beads/config.yaml`, and the bootstrap wrote one only for a Dolt remote. It now writes `sync.remote: "git+<origin>"` for the origin case. The origin must hold `refs/dolt/data`, else set `beadsRemote` (claude-factory-192.10).
- Added: backup of the AX manager home to a private git branch. AX keeps a task workspace only across suspend and resume, so deleting `f-manager` lost `FACTORY_HOME` and the manager's Claude memory and sessions. With `FACTORY_AX_BACKUP_REMOTE` set, `factory manager host` pushes both to the branch `manager-home` (`FACTORY_AX_BACKUP_BRANCH`) every `FACTORY_AX_BACKUP_EVERY` ms (default 600000). When the home is empty at host start, it restores the branch first. The push is fast-forward only. A file with a token shape stops the backup. Login files, locks, `bin/`, `devenv/` and logs stay out. With the variable unset, nothing changes. `factory status` in the task prints the backup age (claude-factory-192.9).
- Fixed: the worker hook did not see a here-document after an escaped `<` (for example `cat \<<<EOF`). A shell reads `\<` as a plain word and `<<EOF` as a here-document. The hook took it for a `<<<` here-string and skipped the check, so a quote in the body hid a push to main. The check now skips only after a real `<` (claude-factory-wmsr.35).
- Fixed: the worker hook missed the end of an unquoted here-document when a backslash and a newline split the end word (for example `EO\` then `F`). A shell first removes each backslash-newline in an unquoted body. The joined line then ends the body, and the next lines run as commands. The hook now denies an unquoted body that has a line ending in a backslash. A quoted delimiter such as `<<'EOF'` is not affected (claude-factory-wmsr.36).
- Fixed: the worker hook did not see the `kubectl rollout`, `auth` or `certificate` sub word after a flag. Example: `kubectl --context acme rollout -n x restart deploy/x`. The hook now finds the sub word past flags. If an unknown flag makes the slot uncertain, the hook denies a mutating word or a dynamic word before `--`. (claude-factory-qbtz.2)
- Fixed: the worker hook did not see `rm` after a flag-shaped word with a dynamic character. Example: `env -u root -$Y -rf /`, `sudo -$Y -rf /` and `xargs -$Y -rf /` ran unchecked. If `$Y` holds ` rm`, the shell splits `-$Y` into `-` and `rm`, and `env` reads a lone `-` as `-i`. The hook now reads such a word as a possible command word. This holds after `env`, `sudo`, `nice`, `command`, `xargs` or a dynamic head. The hook denies such a word when any risky operand follows it, such as `env -u root -$Y ls -d /`. This is a cost: the hook now denies that command. The hook still allows `env -$Y ls` and `nice -n$N make all`. (claude-factory-cwt9)
- Fixed: the worker hook did not read a word cut at a substitution after a dynamic command word and its wrapper flags. In `$X -u root $(cat f) ../x` with `X=env`, the shell runs `env -u root rm ../x`. The hook now denies a later word that ends in `$`, holds a backtick, or is `(` after `<` (claude-factory-hevt).
- Fixed: the worker hook did not see a quote hidden in a here-document inside a backtick substitution. A shell ends such a body at a line with the delimiter and a closing backtick. The hook looked for an exact delimiter line, found a later one, and skipped the check. The hook now denies when a body line starts with the delimiter but is not equal to it (claude-factory-wmsr.37).
- Fixed: the worker hook let `sudo ${=X}` run the value of a set name. In `X="git push origin main"; sudo ${=X}`, zsh splits the value and sudo runs it. The hook took `${=X}` for a `NAME=value` word and skipped it. A wrapper can skip a word. The hook now denies that word if it expands a set name. Examples: `sudo -u $X` and `nice -n ${=X}`. (claude-factory-xbr1)
- Fixed: the worker hook did not see zsh glob qualifier code. A glued group such as `ls *(e:...:)` or `ls *(+name)` runs a command for each file. The hook now denies an unquoted group glued to a word that holds `e`, `+`, `$` or a backtick (claude-factory-1r7x).
- New: the console Interview tab shows every run that parked on an owner-only step in one `Owner steps (N)` group, across all rigs, with the exact command, run, rig and age (claude-factory-n340). Each answer still mails only its own run. `factory waiting` already did this.

## 0.13.0 (2026-10-18)

- Sweeps now move out of `factories/lifecycle.ts`. They run in their own factory,
  `factories/sweeps.ts`. `factory tick` starts each due `(rig, sweep)` pass on its own cadence.
  A lifecycle run no longer loops on a sweep station. (claude-factory-8pc)

  - `factories/sweeps.ts` is a new, self-contained factory. It has 3 start stations.

    `monitor` runs at an interval of 30 min. It is a read-only production check. It must have a rig's `--slo` command.

    `maintain` runs daily. It does dependency, advisory, test and docs maintenance. `improve` runs daily. It turns through a lens for refactor, performance, cost and factory-health.

    Each pass goes straight to `done`. It makes beads from what it finds. It does not stay as a run.

  - `src/sweeps.ts` is a new module. `sweepNames(def)` reads a factory's `everyMin` nodes.
    `dueSweeps` picks the due `(rig, sweep)` pairs. `sigOf` and `clipUtf8` support `monitor`'s
    read-only `--slo` hash-and-skip-on-no-change check. `sweepFiler(b)` reads a bead's
    `created_by` field to tell a sweep-filed bead from a person's bead.

  - `sweepGuard` is a guard against too many sweep-filed beads. It sets a maximum of 5
    sweep-filed beads for each rig in each 24 hour window.

    `sweepGuard` identifies a sweep-filed bead by its `created_by` field. It uses `sweepFiler`
    to read that field. It does not use the `sweep:<name>` label. A worker can set that label on
    a bead itself.

    A bead above the cap loses the `factory` label. It then waits for a person. The bead starts
    by itself only if it has one of these labels: `sweep-queue:incident`,
    `sweep-queue:main-ci-red`, or `sweep-queue:critical-advisory`.

  - `guardHandled`, `markGuardHandled` and `pruneGuardState` keep the guard's "already scored"
    mark in `$FACTORY_HOME/sweep-guard.json`, not on the bead itself. A sweep worker's own
    `bd create -l factory -l sweep:maintain` command has no access to that file, so it cannot
    pre-set the mark and skip the guard (claude-factory-8pc.18).

  - `src/cli.ts`'s `sweep()` runs on `factory tick`'s cadence. It calls `hasBeads(rig.repo)`
    first, so a rig with no bd never runs a sweep pass (claude-factory-8pc.19).

  - The flood guard in `dispatch()` scores each sweep-filed bead. This includes a bead that
    `b.every()` misses for more than 24 hours (claude-factory-8pc.21). This also includes a closed
    bead (claude-factory-8pc.22). The guard continues to count a closed bead toward the
    cap. The guard does not write `bd defer` or a label update on that bead.

  - `factories/lifecycle.ts` no longer has the `monitor`, `maintain` and `improve` nodes. A
    comment points to `factories/sweeps.ts` as the alternative. A run that keeps the old shape
    loads and ticks the previous nodes (AC7, tested in `factories/lifecycle.test.ts`). Its
    `factory.json` continues to hold the previous nodes.

  - The console's Backlog tab now groups a rig's beads by their `sweep:<name>` label. Each
    label gets its own heading, apart from the priority tiers.

  - `brief()` (`src/cli.ts`) now indents every mail's continuation line. It uses CRLF, LF, CR,
    NEL, LS and PS as line breaks. This stops a line in raw `--slo` output that reads
    `- from manager: ...` from being its own top-level inbox bullet. Such a bullet can forge
    the mail channel (claude-factory-8pc.23, .26).

  - `src/worker-hook.ts` now denies a command that sets, clears, exports, unsets or declares
    `BEADS_ACTOR`. This includes these forms: `env -u`, `env -i` and `export -n`. `sweepFiler`
    trusts the bead's `created_by` field. `BEADS_ACTOR` controls that field.

    This denial is defense in depth only. It covers only the forms that the guard knows. A
    worker can still bypass it in other ways. The gap stays open
    (claude-factory-8pc.24, .27; the remaining `env -u`/`env -i` sibling forms are follow-up
    claude-factory-igj).

- An edge into `done` can now carry `requeue: true` or `requeue: { factory?, station? }`. The
  run ends, but the bead stays open, ready and `factory`-labeled instead of closed or deferred,
  so the next dispatch starts a new run on it, in the factory and station its labels name (for
  example, `lifecycle` to `release`, with no hand `factory start`). Dispatch now reads a
  `factory:<name>` label next to `station:<name>` to pick which factory to compile a run from.
  `factory metrics` counts this ending as `requeued`, ahead of `rejected`/`closed` and apart from
  the ship rate. A run with a bead gets a brief line to read the bead's comments first, since a
  requeued bead's comments are earlier runs' reports. (claude-factory-wnm)
  - `src/machine.ts`: `Edge.requeue` and `validate()` rules that refuse `requeue` off an edge not
    into `done`, beside `defer`/`reject`, or with a bad factory/station name (checked against
    `beads.ts`'s own `NAME` pattern, not a second copy).
  - `src/beads.ts`: `factoryOf(b)` reads the `factory:<name>` label (never from a Linear-sourced
    bead, never a path; never a bead with two such labels). `requeue(id, runId, to?)` releases the
    claim, keeps the bead open and `factory`-labeled, swaps labels one field at a time when `to`
    names one (`factory` swaps `factory:*`, `station` swaps `station:*`), and stamps
    `requeued_from`, `requeued_at`, `requeues` in metadata. A requeue edge on a Linear-sourced bead
    defers instead, since dispatch cannot read its labels back.
  - `src/cli.ts`: `track()` settles a `requeue` edge (capped by `REQUEUE_MAX = 5`, then
    deferred, with the `requeues` metadata reset to 0 so an undefer starts a fresh count); it
    also clears a stale `requeued` flag when a person revives an ended run with `GOTO`.
    `dispatch()` resolves each bead's `factory:<name>` through a new
    `namedFactorySource(name, repo)` (never `factorySource`'s literal-path branch), and defers
    only that bead on an unknown name, a factory that fails to load, or a `station:<name>` the
    named factory lacks. `precheckSkip` makes 0 `gh` calls for the one dispatch right after a
    requeue, for the bead carrying `requeued_from`; dispatch clears that metadata once it has
    started that one run.
  - `src/metrics.ts`: `fate()` returns `requeued` before `rejected`/`closed`; `shipRate` leaves it
    out of the ended-run count.
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
  - A round-3 review found 5 more bypasses. The hook now closes each one too.
    - `gh api graphql --input <file>` reads `<file>` as JSON. It checks only the `query` string
      in that JSON for a mutation name. A raw-text scan missed a mutation name that GitHub
      decodes from a backslash-u escape, for example `merge\u0050ullRequest` for
      `mergePullRequest`. A body that is not correct JSON denies the command at once.
    - The shared `normalizeEndpoint` function removes a trailing `#fragment`, then a `?query`,
      then a `/`. Each REST and GraphQL endpoint check uses the result. The `gh` tool
      removes a `#fragment` before it sends the request. A check that read the raw endpoint
      text missed a path, such as `pulls/5/merge#x` or `graphql#x`.
    - The branch-name check on a `git/refs/heads/<branch>` path captures a full branch name
      with a slash, such as `acme/deploy`. Before, it stopped at the first slash. The check also
      accepts the singular `git/ref/heads/` path and decodes a percent-encoded branch name. A
      bad encoding denies the command. A `contents` write's `branch` field removes a
      `refs/heads/` or `heads/` prefix, as the ref-create field does.
    - `gh alias set` and `gh alias import` always deny the command. That scan read only the alias
      expansion's own text. It missed a `!shell` expansion and the `-` stdin form. It also missed
      a call that comes after the alias is set and adds its own words to the new alias name. For
      example: `gh p merge 5` after `gh alias set p pr`.
    - A `git -c alias.<name>=<value>` or `git config alias.<name> <value>` write denies all
      values. The check no longer covers only a value that reads as a literal `push` command. It
      also denies a `!shell` value, such as `!git push`. A new `push.default` check denies the
      `upstream` and `tracking` values. These values change the default branch of a bare
      `git push`, as a `remote.*.push` value does. All these checks, and the `remote.*.push`
      check, also read the `git config set <name> <value>` syntax that git 2.46 has.
  - A round-4 review found 1 more bypass. The hook now closes it too.
    - `gh api` used to match a REST pattern against the raw, still-encoded path.
      GitHub decodes the whole path first. A percent-encoded slash, such as `heads%2Fmain`,
      has no literal slash in the raw text. So the branch-name pattern never matched it.
      The hook now decodes the whole path once, before any REST pattern reads it.
      A bad encoding denies the command, the same rule it already used for a branch name alone.
  - Security's first review round found 5 more bypasses. The hook now closes each one too.
    - `git -c push.default=matching` and any `push.default` value the hook does not know now
      deny the command. Real git confirmed `matching` sends every local branch to a remote
      branch of the same name, with no refspec that names any of them. Only `current`,
      `simple` and `nothing` stay allowed.
    - A bare `:` refspec, such as `git push origin :`, now denies the command. Real git
      confirmed it pushes every matching branch, the same broad reach as `--all`.
    - `xargs` right before a `git` or `gh` word now denies the command. `xargs` can read its
      own operand from stdin, a push refspec or a `gh` verb, that the hook's own text scan
      never sees.
    - `git --config-env=<name>=<envvar>` now denies the same 3 config keys `-c <name>=<value>`
      already denies (`alias.*`, `remote.*.push`, `push.default`). The hook cannot read the
      named environment variable's own text, so it denies the write itself.
    - `git send-pack`, the plumbing command `git push` calls, now goes through the same
      refspec and protected-branch check as `git push` itself. It had no `push` word of its
      own for the hook's verb search to find.
  - A review round after security's first round found 3 sibling bypasses of those 5. The hook
    now closes each one too.
    - `xargs` denies on a `git` or `gh` word anywhere after it in the same segment, not only
      the word right after `xargs`'s own flags. Real git moved `main` through a value flag
      with its value as a separate word (`xargs -n 1 git push origin`) and a wrapper between
      `xargs` and `git` (`xargs env git push origin`, `xargs sudo ...`, `xargs timeout 5 ...`).
    - `git send-pack` with no ref denies the command. Real git confirmed this pushes every
      local branch to a same-named remote branch, the same broad reach as
      `push.default=matching`, not a push of `HEAD` alone. `--stdin` (refs read from the
      command's own stdin) and `--mirror` (the same broad reach as `--all`, with deletes)
      now deny outright too.
    - `git -c remote.<name>.mirror=<value>` and `git config remote.<name>.mirror <value>` now
      deny the command, the same as the existing `remote.*.push` check. `include.path` and
      `includeIf.<cond>.path` deny too: either one loads another config file the hook cannot
      read, and that file can set any key the hook already denies. The hook also denies a
      command that sets `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`,
      `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG`, `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` (a
      plain assignment or an `export`) together with a `git` word anywhere in the command
      text, even on a later, `;`-separated line. These environment variables replace git's
      own config lookup outright, with no value left on the command line for the hook to
      check.
  - A later review found 4 more bypasses. The hook now closes each one too.
    - `env -S '<command>'` and `env --split-string='<command>'` (also a short-flag cluster
      and the attached `-S'<command>'` form) now deny the command. BSD and GNU `env` split
      `<command>` into words and run it, the same hazard as `eval`. The hook now reads that
      value and checks it the same way it checks an `eval` or `sh -c` argument.
    - A dashed git-core binary name, such as `git-push` or `git-send-pack`, now denies the
      same way `git push` or `git send-pack` does. It runs the same code, found on `PATH`
      or under `git --exec-path`, with no `git` word anywhere in the command line.
    - The check that denies a `GIT_CONFIG_*` environment variable paired with a `git` word
      used to read only one segment's own first word, past wrapper-stripping. Real git moved
      `main` through `nice -n 5 git push origin`, `command -p git push origin`,
      `stdbuf -o0 git push origin`, and the same pairing behind an `eval` or `bash -c`
      argument. The check now reads a `git` word anywhere in the full raw command text.
    - `HOME=<dir>` and `XDG_CONFIG_HOME=<dir>` now deny the command when paired with a `git`
      word, the same as `GIT_CONFIG_GLOBAL`: git reads `$HOME/.gitconfig` and
      `$XDG_CONFIG_HOME/git/config` as its own global config. `GIT_DIR=<dir>` and
      `GIT_COMMON_DIR=<dir>` deny the same way: each one points git at a different
      repository's config file.
  - A sibling of the `env -S`/`env --split-string` fix above still let a value flag's own
    value word hide a later `-S`. The hook now reads past that word too.
    - `env -u NAME`/`--unset NAME`, `-C DIR`/`--chdir DIR`, `-P PATH` (BSD), and
      `-a ARG`/`--argv0 ARG` (GNU) each take a value word of their own. The old scan stopped
      at that word, read as `env`'s own command, and so never reached a later `-S`. It now
      reads a value flag's own value instead, so `env -u FOO -S 'git push origin main'` and
      `env -C /tmp -S 'gh pr merge 5'` still deny the command.
    - A short cluster that ends in a value flag, such as `-iu FOO`, skips one word the same
      way. GNU `getopt_long` also accepts a prefix of a long option name, so `--spl ...` and
      `--sp=...` deny the command the same as `--split-string ...` and `--split-string=...`.
      (claude-factory-dgf)
  - Owner step still open: the `ax` rig has no `protectedBranches` set yet. Its own
    non-`main` default branch stays unprotected until a person adds it with
    `factory rig add ax ... --protected-branch <name>`. A VM-runner rig gets the new hook
    only after a person rebuilds and pushes its worker image (`hack/push-worker.sh`).
- `factory gc --worktrees` now reclaims a merged `factory/*` branch on a rig with 1000 or more
  pull requests. `prFacts()` used to call `gh pr list --limit 1000`. A rig with more pull
  requests than the cap always read as facts-unavailable. So gc never removed a branch on a
  large rig (one real rig has about 3058 pull requests). (claude-factory-ph8)
  - `src/cli.ts`: `prFacts()` now runs `gh api graphql --paginate` once per rig. Its query reads
    `number`, `state`, `headRefName`, `headRefOid` and `isCrossRepository` for every pull
    request, ordered by `CREATED_AT`. It passes `owner` and `name` with `-f`, not `-F`
    (claude-factory-ph8.5). `-F` reads a value as a JSON type, or as a file path. So a repo
    named `2048`, or one that starts with `@`, broke the query forever.
  - `src/gc.ts`: new export `parsePrPages(stdout)` parses the paginated NDJSON stdout into
    `PrFact[]`. It returns `null` on any doubt: a line that fails to parse, a wrong shape, a
    missing or non-boolean `isCrossRepository`, or a count of distinct pull request numbers
    under the first page's `totalCount` (a lost page). This keeps the `isCrossRepository` guard
    from claude-factory-ulv working: the query, `PrPageNode` and `isPrPageNode` all need it
    as a boolean, and fail closed on a missing or wrong-typed value (claude-factory-ph8.4).

- A hidden `briefer` subagent writes an evidence brief into each gate's decision item. The
  manager no longer needs to read the pull request and the journal itself. (claude-factory-2u2)
  - `src/gatebrief.ts`: `gateKey()` and `clipBrief()`. `src/cli.ts`: `factory gate-brief facts
    <run>` prints the pull request, the verify and review summaries, and the run's goal as
    JSON, only at a live gate; `factory gate-brief set <key> <file>` checks the key against
    the live gate, strips control characters, keeps 8 lines of 200 characters or fewer each,
    and stores the brief in `<home>/gate-briefs.json`; `row()` adds `gate.brief`.
  - `mod/hooks/view.ts`: `briefContext()` and `interviews()` put the brief into the gate
    Interview item: `context` is a redacted one-line summary, `details` is the whole brief.
  - `mod/hooks/register.tsx`: a new `factory:briefer` subagent (`BRIEFER_TYPE`), spawned once
    for each gate visit by `briefNow()`, with no tools at all. Its `turn.complete` writes the
    brief through `gate-brief set` and logs one line to `<home>/brief-log.jsonl`. `tool.call`
    denies every Bash call from a briefer agent, `factory decide` included. The person still
    decides every gate. `userConfig.briefer` (default `true`) turns the briefer off.
- A station at its round cap now re-plans once with the round's findings instead of holding for a
  hand goto, and a repeated red on the same acceptance criterion mails the manager on its own.
  (claude-factory-qgz)
  - Cause: a run review found 40% of reviews send work back, but a run held at its round cap most
    often got a hand goto to implement, so the loop kept going (one run: 8 review rounds, 10
    implement passes).
  - `src/machine.ts`: `Node.onRounds` names the node a capped report re-plans to, carrying every
    round's own-outcome summary (oldest first, each clipped to fit near 24,000 characters). The
    first report past `rounds` re-plans; a second cap in the same run still holds for the manager,
    now naming the earlier re-plan. With no `onRounds`, a station's rounds cap holds for the
    manager exactly as before. The re-plan's own log entry sets a new `Entry.replan: true` field,
    so metrics and the repeat-mail check can tell it apart from a manager's own `goto plan`.
    `Node.repeatMail` names an outcome in `next`; when a station reports it twice in a row and
    both reports name the same `AC<n>` id on their own `Failing: AC2, AC6` line, the machine mails
    the manager from `'factory'`, naming the station, the shared ids and both report times, and
    the run still follows the normal edge. A `replan` entry between the two reports breaks the
    streak, since a re-plan can renumber acceptance criteria. New exports `acIdsIn`,
    `failingAcIds`, `prevReport`, `repeatMailText` and `capReplanMail`. `validate()` refuses an
    `onRounds` with no `rounds`, or one that names an unknown node, `'done'`, or the node itself;
    it refuses a `repeatMail` that is not a key of `next`.

  - A manager `goto` command writes no log entry. A hand `goto plan` after a repeat mail left no
    `replan: true` entry (claude-factory-qgz, review round 2, finding .11).

    The streak check now also breaks on an entry for a `replanTargets` node between the two
    reports. A `replanTargets` node is a node named in a different node's `onRounds` field.
    `replanTargets` is a new export in `src/machine.ts`.

  - `factories/lifecycle.ts`: `review` sets `onRounds: 'plan'` (`rounds` stays 3); `verify` sets
    `repeatMail: 'red'` and its prompt now asks for one fixed `Failing: AC2, AC6` line naming only
    the still-failing ids. `plan`'s prompt numbers acceptance criteria `AC1`, `AC2`, ....
  - `mod/hooks/register.tsx`: the manager's patrol prompt now forbids a goto to implement past a
    station's round cap (a stuck mail that says "already re-planned once" already went through one
    re-plan), and tells the manager to steer implement or goto plan on a mail that says a station
    "reported `<outcome>` again on `<AC ids>`", never goto implement with no new direction.
  - `src/metrics.ts`: `metrics()` adds `runsWith3PlusReviewRounds`, `implementPassesPerShippedRun`
    (null at 0 shipped runs; skips `handoff`, `blocked` and a pre-launch PR park) and `capReplans`
    (counts only a log entry with `replan: true`, never any `review` -> `plan` pair, so a
    manager's own goto plan after a stuck hold or a review fail does not count). `render()` prints
    them on one line.
- A short note's `until` marker (a bead id, `owner/repo#N`, a GitHub pull URL, or a `YYYY-MM-DD`
  date) now retires the note on its own schedule, apart from the dream's own judgment. `dream`
  and `memory compact` retire a note once its date has passed, its named bead has closed, or its
  named PR has merged or closed. A lookup that fails or finds nothing only flags the note; it
  never retires it. (claude-factory-3u1.1.4, FR-016)
  - `src/memory.ts`: new `untilStatus(until, now, deps)` gives the verdict for one marker, from
    injected `UntilDeps` (`bead`, `pr`) with no file or network access of its own. `ShortCandidate`
    gains `expired`, `expiredReason` and `untilFlag`. `decide()` emits a `retire` decision for an
    expired note (right after the superseded check, at any age or usage) and a `flag` decision for
    an unreachable marker; a retire shares the archive cap with `archive`, and a flag never counts
    toward the topic cap. `applyTiers(dir, { untilDeps })` judges each short note's marker, writes
    a retire like an archive (`.archive/<topic>.md`, removed file, rewritten README link), and
    returns `retired` and `flagged` counts. With no `untilDeps`, a bead or PR marker gets no
    verdict, so a caller that skips it keeps its old output; a date marker is always judged.
  - `src/cli.ts`: new `untilDeps()` looks up a bead through the rig whose bd prefix matches it
    (longest match first) and `gh pr view <url> --json state` for a PR, each memoized for one pass
    and capped at 50 `gh` calls. A rig whose own prefix lookup fails is set apart. That rig cannot
    rule out owning an id, so the lookup reads "lookup failed" for it, never "not found". `dream()`
    and both `memory compact` paths (`--dry-run` and real) now pass it to `applyTiers()`.
    `compactMessage()` adds `, N retired` and `, N flagged` clauses when either count is over 0.
- Fixed: `denyAt`'s `find` branch (`src/worker-hook.ts`) no longer scans the
  `-exec`/`-execdir` words of a `find` command in quadratic time. (claude-factory-lbn)
  - Before this fix, a long `find ... -exec` command can time out the 10-second
    PreToolUse hook. The hook then fails open and skips the deny check.
  - Cause: for each `-exec`/`-execdir` word, the branch ran `cmd.slice(i + 1)`. It
    then checked the first word of the slice. A run of n such words cost O(n^2).
    Proof: this took 1.36 s at n=80000 words (480 KB). Past about 1.3 MB, this runs
    past the hook's 10-second timeout.
  - Fix: `isRecursiveRm()` now takes a start index. It reads `cmd` in place, with
    no slice. The `find` branch first checks `baseWord(cmd[i + 1]) === 'rm'` in
    O(1) time. It then calls `isRecursiveRm(cmd, i + 1)`. Each scan starts at an
    `rm` word, and stops at the first non-flag word. The scans do not overlap, so
    the whole loop costs O(n).
  - Proof: `bun run src/worker-hook.bench.ts find 200000` now takes 191.2 ms.
    Before the fix, the same shape with a trailing `rm -rf x` took 11451.9 ms.
  - `find . -exec rm -f x \;` still allows. `find . -name x -exec rm -rf {} +`
    still denies. All 230 `worker-hook.test.ts` tests pass.
- The lifecycle factory has a new triage outcome, `small`, for a docs-only, test-only or tiny
  change. Before this fix, every run paid for the full loop. The full loop has an Opus plan, a
  separate verify station, a separate review station, security and soak. A small run now takes
  a shorter path: `triage -> quick -> check -> release -> deploy`. This path skips the Opus
  plan. It also skips security, unless `check` flags the diff as security-sensitive, or the
  diff touches a factory definition (`.factory/` or `factories/`). In that case the run still
  goes through security before release. (claude-factory-wnn)
  - `factories/lifecycle.ts`: `triage`'s prompt names the new `small` outcome. It also names the
    rules that exclude a run from this outcome: a security-sensitive goal, or a change to a
    factory definition. Two new stations support this route. `quick` runs on Sonnet with a
    60-minute limit; on a `full` outcome it joins the plan loop, because the work was bigger
    than small. `check` runs on Opus with a 60-minute limit and 3 rounds; on a `changes` outcome
    it loops back to `quick` and closes each task it filed, with its commit, the same way
    `implement` closes `review`'s findings; on a `security` outcome it goes to the existing
    `security` station. `check`'s prompt keeps the pull request a draft; only `release` marks
    it ready. `security`'s prompts now name `check`'s report and `triage`'s summary, as well as
    `review`'s report and the plan's risk section, so a small run's security pass reads the
    right station.
  - `src/metrics.ts`: `metrics()` now reports `small: { runs, hoursToShip: { median, p90 } }`.
    `runs` counts every run that `triage` ever sent down the `small` route, found anywhere in
    its log, not only in its first entry. This way a run that failed triage once, then went
    `small`, still counts. `hoursToShip` covers only the runs that shipped, and excludes any run
    that `quick` sent to the full loop. `reviewLoops` now also counts `check`'s `changes`
    outcome. `render()` adds one line: `small runs N, to ship Xh median / Yh p90`.
  - `README.md`: the lifecycle table gains a `small` row. Two new paragraphs say when `triage`
    picks this route, and what the route skips.

- `factory gc --worktrees` fixes two gaps the PR #70 security review found. (claude-factory-ulv)
  - `src/cli.ts`: `snapshotWorktree()` used to set `GIT_INDEX_FILE` to a path that other
    processes can predict: `factory-gc-index-<runId>-<pid>` in the shared tmpdir. A write race
    between `git add -A` and `git write-tree` can snapshot the wrong tree before the caller
    force-removes the worktree. The function now uses `mkdtempSync` to make a private,
    unpredictable 0700 directory for the index file. It removes this directory in its `finally`
    block.
  - `src/gc.ts`: `coverTip()` used to trust a cross-repo (fork) PR's CLOSED or MERGED state as
    proof that a tip merged. `PrFact` now carries a required `isCrossRepository` field.
    `coverTip()` ignores each `PrFact` where this field is `true`. `prFacts()` (`src/cli.ts`)
    asks `gh` for `isCrossRepository`. It fails closed, with no branch deletes in that rig, when
    a PR entry has no boolean `isCrossRepository` value. `beadClosedFacts()` builds its CLOSED
    set from non-cross-repo PRs only. It never runs `bd show` for a fork PR's bead.

- `factory gc --worktrees` now matches a GitHub origin only on the exact host `github.com`. The
  old regex had no host anchor. An origin like `https://mygithub.com/owner/repo` parsed as the
  GitHub slug `owner/repo`. `gc` then read PR state for a different repo on `github.com`. It
  could apply that repo's MERGED or CLOSED state to this rig's own branch deletes.
  (claude-factory-0u0)
  - `src/cli.ts`: `githubSlug()` now uses `parseRemote()` (`src/prs.ts`) and `forgeOf()`. This is
    the same parser that `originRef()` uses for GitLab. `githubSlug()` is now exported. It also
    accepts origin forms with userinfo, for example `https://user@github.com/...` and
    token-auth clone URLs. The old regex rejected these forms.

- `reconcile()` now has a direct test for the escalated deadline from `timeoutOf()` (`onTimeout`,
  claude-factory-3t2). `src/remote.test.ts` sends a real `factory tick` through a timeout fail, a
  backoff and a new spawn. The test checks the warn and fail minutes against the escalated
  limit, not the plain `timeoutMin`. (claude-factory-9ff)
- `factory plan facts` failures now back off and log, the same as a failed spawn. The old
  code retried every 60 s forever and wrote no log, even with `bd` down. (claude-factory-4hb)
  - `mod/hooks/register.tsx`: the facts-failed branch in `pmNow()` now:
    - runs `rt.pmFailures += 1`
    - waits `pmRetryDelay(rt.pmFailures)` (60 s doubling, capped at 60 min), not the fixed
      60 s `PM_RETRY_MS` (removed)
    - adds a `pm-log.jsonl` entry `{ reason: 'facts-failed', error }`, the same shape as the
      two spawn-failed sites
- `factory gc --worktrees` no longer journals a secret from a remote URL's userinfo
  (`user:pass@` or a bare `token@`). A failed `git push` or `git worktree remove` can print the
  URL in its stderr. That stderr line used to reach `HOME/gc-worktrees.jsonl` unscrubbed.
  (claude-factory-0lt)
  - `src/gc.ts`: new export `scrubUrlUserinfo(text)`. It removes the userinfo part of each
    `scheme://` URL in `text`. It leaves an scp-style remote (`git@github.com:acme/widget`) alone.
  - `src/cli.ts`: `gcLog()` now scrubs every string value of its entry with
    `scrubUrlUserinfo()`, before it writes the journal line. This covers arrays and objects too.
    `reviveWorktree`'s `ls-remote` and `fetch` calls now also run with `GIT_NETWORK_ENV`
    (`GIT_TERMINAL_PROMPT=0`) and the `GIT_NETWORK_TIMEOUT_MS` timeout (still 30 s), the same as
    every other network-reaching git call in this file. A stuck credential prompt now fails fast
    instead of waiting out the timeout.
- `memory helped` now refuses a directory, `.`, or a non-`.md` file: exit 1, print
  `not a note in <dir>: <path>`. Before this fix it exited 0 and added a usage line for the
  path. `memory compact` now removes such a usage line. (claude-factory-5o7)
  - `src/memory.ts`: `noteExists()` for a path with no `#` now needs
    `path.endsWith('.md') && statSync().isFile()`, the same `.md`-only rule as `walk()`.

- Each memory topic now has a cap of 15 short notes (`TOPIC_CAP`). Set
  `FACTORY_MEMORY_TOPIC_CAP` to override it. `decide()` merges a topic's oldest notes once the
  topic holds more notes than the cap. `dream` and `memory compact` name topics still over the
  cap after a pass. (claude-factory-3u1.1.3)
  - `src/memory.ts`: `TOPIC_CAP = 15`. `envTopicCap()` reads the env override. It needs a whole
    number of 1 or more; any other value falls back to 15. `decide(short, long, sims, {
    topicCap })` adds a `merge` decision for a topic's oldest notes once the topic holds more
    notes than the cap. Each picked note is 7 or more days old, has no decision yet, is not
    superseded, and is not in inbox. `applyTiers()` passes `envTopicCap()` into `decide()`. It
    returns `overCap`: the topics still over the cap, with their counts. The new export
    `overCapTopics(dir)` reads the live store. `dreamPrompt()` now takes the over-cap topics and
    a `topicCap`. It adds a "Topics over the short-note cap" section that tells the dream to
    merge or drop notes there.
  - `src/cli.ts`: `dream()` passes `overCapTopics(MEMORY)` and `envTopicCap()` into
    `dreamPrompt()`. The `memory compact` commit message and its `--dry-run` output name topics
    still over the cap. The help text names `FACTORY_MEMORY_TOPIC_CAP` (default 15).
- A station can now set `onTimeout: { timeoutMin, prompt? }`: the attempt right after a timeout
  fail gets this longer limit and an extra brief section instead of the plain retry. lifecycle's
  `security` uses it (45 min, then 75 min with a prompt that works from review's diff summary
  instead of rereading the whole branch); a 2nd timeout in a row still goes to `isRepeatFail`'s
  stuck state and one manager mail, unchanged. (claude-factory-3t2)
  - Cause: a run review found 5 of 65 security visits (8%) timed out at 45 min, all on one large
    AX rig, 4 in a row on two runs until the launch budget held them.
  - `src/machine.ts`: `Node.onTimeout`, `afterTimeout(c, id)` (true when the node's own run of log
    entries, read back from the end, holds a timeout fail), `timeoutOf(node, c, id)`, and two
    `validate()` refusals (`onTimeout` on a gate; `onTimeout.timeoutMin` at or under `timeoutMin`).
  - `src/cli.ts`: `reconcile()`'s deadline check now reads the limit from `timeoutOf()`; `brief()`
    adds a "The previous attempt timed out" section with the longer limit and the node's prompt.
  - `factories/lifecycle.ts`: `security.onTimeout` (75 min); `review`'s prompt now says its report,
    when it reaches security, carries `git diff --stat origin/main...HEAD` (at most 60 files, then
    "+N more") and one line per changed area.
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
- Added: `factory gc --worktrees [--dry-run] [--rig NAME]`. For each rig, it removes a finished
  run's worktree, and its `factory/*` branch (local and on `origin`) once every tip is merged
  into main, or its pull request is closed and its bead is closed. It never touches a live
  run's worktree, or a branch with unmerged commits in no pull request. (claude-factory-l38)
  - Cause: a 2026-10-16 review found 990 worktrees across 11 rigs. 711 belonged to done or
    aborted runs. 800 local and 533 remote `factory/*` branches remained after their runs
    finished. `factory rm` removes a run's worktree by hand, but it always keeps the branch.
  - Fix: `gc.worktreePlan()` (`src/gc.ts`) is a pure plan over `git worktree`, branch, pull
    request and bead facts. `gcWorktreesPass()` (`src/cli.ts`) reads those facts for real and
    carries out the plan: `git worktree remove`, a snapshot commit at `refs/factory-gc/<runId>`
    before a dirty worktree's forced removal, and a compare-and-swap branch delete
    (`git update-ref -d`, `git push --force-with-lease`). A dirty worktree over 50 MiB of
    untracked files, a locked worktree, and a run finished under 1 hour ago all stay. Each
    action appends one line to `HOME/gc-worktrees.jsonl`; `--dry-run` writes nothing at all.
  - `tick()` now starts one pass at most once a day (`FACTORY_GC_WORKTREES_MS`).
    `FACTORY_GC_WORKTREES=0` turns this off. The first tick with no `gc-worktrees.stamp` only
    writes the stamp, so a fresh `FACTORY_HOME` never deletes a branch on its first tick.
  - `spawn()` (`src/cli.ts`) now revives a run whose worktree gc removed: `goto` or `retry`
    recreates it from the local branch, else from `origin/<branch>`. When neither branch
    survives, it fails, naming gc, the branch and `refs/factory-gc/<runId>`, and starts no
    worker.
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
- Fix forward: `pm`'s `userConfig` default is `true` again (`mod/.claude-plugin/plugin.json`).
  (claude-factory-dun)
  - Corrected cause: the rollback bullet above named the wrong cause. The manager process
    that looped had started on 2026-10-15, before commit f9c7bf2 (2026-10-16) added
    `Agent` to `MANAGER_TOOLS` (`src/cli.ts`). Its own `--tools` argv had no `Agent` entry,
    so every `$.agent.spawn` call threw. This was not a `session.start`/hot-reload
    registration gap.
  - Fix: `pmNow()` (`mod/hooks/register.tsx`) now checks `$.tool.list()` for `Agent`
    before each `factory plan facts` call. With no `Agent` tool, it sets `rt.pmBlocked`
    once per process, writes one `<home>/pm-log.jsonl` entry and one status line, and
    returns at once on every later call: no more `factory plan facts` or
    `$.agent.spawn` for that process, only a restart clears it (claude-factory-dun.28,
    .29). A spawn that is denied or throws for any other reason now backs off
    (`pmRetryDelay`: 60 s, 120 s, 240 s, doubling to a 60 minute cap) instead of a fixed
    60 second retry. The Rigs tab shows a red "pm blocked: ..." line while blocked
    (claude-factory-dun.30). `factory plan show` prints the newest `pm-log.jsonl` error
    and its time when no `plan.json` exists yet (claude-factory-dun.31).
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
- Fixed: a long multi-push `git push` command can outrun the worker
  `PreToolUse` hook's 10-second timeout and run unchecked. The 8192-character
  length cap guarded only a rig with a `--person-only-context` set.
  (claude-factory-dts)
  - Cause: `gitReason` called `gate.headOf(dir)` once for each push segment,
    and `protectedBranchSet` called `gate.originHead()` once for each push
    segment (inside `gitPushDenied`/`sendPackDenied`). Neither call was
    cached. A command of 583 `git push o b;` segments plus a trailing
    protected push (8182 characters, under the old cap) took 10527 ms at a
    load average of 52, through `bun src/worker-hook.ts`.
  - Fix: `memoGate(gate)` (`src/worker-hook.ts`) wraps `gate.headOf` and
    `gate.originHead` once at the `denyReason` entry. `originHead` now runs
    at most once per call, caching an unresolved (`undefined`) result too.
    `headOf` caches one result for each distinct `dir`, up to
    `MAX_HEAD_DIRS` (8); past that, it returns `undefined` with no git
    spawn, the same fail-closed rule an unresolvable `headOf` already used
    (claude-factory-zl5.12). `denyReason` now checks `MAX_COMMAND_LENGTH` on
    every rig, not only one with `--person-only-context`, before any scan.
    The real scan moved to a new exported `scanReason`, with no length cap
    of its own, so a recursive `eval`/`sh -c` call (a substring of a command
    `denyReason` already capped) needs no cap either.
    `LONG_COMMAND_REASON`'s own text dropped the person-only-context
    wording and now tells the worker to put a long report summary, bd
    description or pull request body in a file under `.scratch/`, and pass
    it with `--body-file`, or as `"$(cat .scratch/<name>)"`.
    `src/worker-hook.bench.ts` now times `scanReason`, matching the removed
    cap. README.md's 8192-character sentence now says "on every rig".
- Fixed: `memoGate` (claude-factory-dts) bounded the spawn count, not the
  spawn time. A stuck or slow git process can still spend its own full
  2-second timeout on each of up to 8 `headOf` spawns plus 1 `originHead`
  spawn: 9 full timeouts, past the hook's 10-second `PreToolUse` timeout.
  (claude-factory-dts.4)
  - Cause: 8 dirs with a `mkfifo .git/HEAD` (`git symbolic-ref` blocks on
    open) took 16.1 seconds at a load average of 10, through
    `bun src/worker-hook.ts`.
  - Fix: `memoGate` now sets a shared deadline, `GATE_BUDGET_MS` (6000 ms)
    after the memo is built. `gate.headOf` and `gate.originHead` gained an
    optional `timeoutMs` parameter; `memoGate` passes each real call at most
    the time left before the deadline, capped at 2000 ms. Past the deadline,
    a call skips the spawn outright and returns `undefined` (fail closed,
    the same rule `MAX_HEAD_DIRS` already uses). `gitSymbolicRef` and the
    `headOf`/`originHead` closures in `main()` now thread `timeoutMs`
    through to `Bun.spawnSync`'s own `timeout` option.
- Added: `factory memory add` now takes `--kind fact|rule|recipe` and
  `--until <bead|owner/repo#N|pull-URL|YYYY-MM-DD>`. It refuses the note
  before it checks for a duplicate. (claude-factory-3u1.1.1)
  - `gate(note)` (`src/memory.ts`) is a pure, exported check. It uses no
    `fs`, clock or env access. It refuses a note with a missing or invalid
    `--kind`. It refuses a note with an invalid `--until` value. It refuses
    a `fact` or `rule` note that cites a bead id or a pull request in its
    summary or body, with no `--until`; a `recipe` note is exempt from this
    last check. `citesTracker(text)` finds a bead id or a pull request
    reference in the text. `isUntil(value)` checks a bead id, an
    `owner/repo#N` reference, a GitHub pull request URL, or a real
    `YYYY-MM-DD` date.
  - `memory add` in `src/cli.ts` calls `gate()` before `memory.same()`, the
    duplicate check. A refused note costs no embedding call. It logs no
    `helped` or `confirmed` event. A refusal sets exit code 2 and names the
    missing or bad flag on stderr. It never throws `fail()`, which sets exit
    code 1. `--anyway` still skips only the duplicate check; it never skips
    the gate.
  - `parse()` and `format()` (`src/memory.ts`) carry `kind` and `until`
    frontmatter fields between `at:` and `superseded:`. An old note with no
    `kind` still parses. Its `kind` and `until` both come out `undefined`.
    `format()` of such a note stays byte-identical to the output before this
    change.
  - `mod/hooks/register.tsx` and the worker brief's usage text now show the
    `--kind` and `--until` flags.
- Fixed: `anyShellReason` (`src/worker-hook.ts`) no longer scans a long
  sh/bash/zsh/dash word segment in quadratic time. (claude-factory-1by)
  - Before this fix, a 120 KB command can time out the 10-second
    PreToolUse hook. The hook then fails open.
  - Cause: each sh/bash/zsh/dash word with no `-c` cluster called
    `shCFlagIndex(words.slice(j))`. This is an O(n-j) slice and scan. It
    then moved on by one word. A segment of n such words cost O(n^2).
    Proof: 9.0 s at n=40000 (120 KB), 34 s at n=80000 (240 KB). Both times
    are past the hook's timeout.
  - Fix: keep two monotone forward pointers per segment across calls, in
    place of the per-word slice and rescan. One pointer tracks the next
    short-flag `-c` cluster index. The other tracks the next literal `--`
    index. The scan is now amortized O(n) per segment. Proof: 5 ms at
    n=40000, 22 ms at n=80000.
  - `sh eval rm -rf x`, `sh foo -- bash -c "rm -rf x"`, and `sh -x -lc "rm
    -rf x"` still deny. A trailing bare `-c` with no script still allows.
    All 230 `worker-hook.test.ts` tests pass.
- `factory memory add` now logs a duplicate hit as `confirmed`, not `helped`.
  It also takes a new `--supersedes <note path>` flag. (claude-factory-3u1.1.2)
  - When `memory.same()` finds a note that is already there, `src/cli.ts`
    logs `confirmed` in `.usage.jsonl`. `memory.use()`, `tallyRaw()` and
    `tally()` (`src/memory.ts`) now carry `confirmed` and `contradicted`
    counts per note, next to `shown` and `helped`. Each count defaults to
    0. `compact()` folds `confirmed` and `contradicted` into each note's
    line. A compact, then a tally, give the same counts.
  - `--supersedes <note path>` resolves the path through `resolvePath()`
    (the rename log). It writes the new note, adds one `superseded: <new
    note path>` frontmatter line to the old note, and logs a
    `contradicted` event on the old note.
  - The flag refuses with exit 2 and writes nothing in each of these
    cases: the path is missing a value; the path starts with `--` or
    `..`; the path has a dot segment (such as `.archive`); the path names
    a topic's whole `README.md`, `LONG.md` or `CORE.md` with no `#`; the
    path is a directory; or the path is a `#` path whose file part is a
    directory.
  - PR #73 first shipped the last two refusals above as a crash
    (`EISDIR`, exit 1) that left a note behind with no `superseded:`
    marker. PR #76 fixed the directory-as-`--supersedes` case. PR #78
    fixed the `#`-path case (for example `beads#x`, where `beads` is a
    directory).
- `worker-hook` now denies an `env -S`/`env --split-string` value that holds a dollar sign, for
  example `git ${FOO} origin main`. `env` changes a `${NAME}` word into one command word when it
  runs, so the old check on the typed text alone can miss a real push or merge hidden this way.
  (claude-factory-z1p)

- The worker-hook deny gate now denies an `env -S`/`--split-string` value with a backslash or a
  real newline, for example `env -S 'git\_push acme/widget main'`. `env` reads `\_` or a real
  newline there as a word break, but the old gate read the whole value as one word, so it let
  the command pass. (claude-factory-vco)
  - `src/worker-hook.ts` adds the `ENV_SPLIT_ESCAPE_REASON` constant. `anyShellReason` checks
    for this mark before it calls `denyAt`.

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
