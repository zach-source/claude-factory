# Releasing claude-factory

This repo is public. Every release comes from a GitHub Actions workflow. Nobody edits
a version file or a tag by hand (claude-factory-5h9).

## The recipe

1. Open the repo's Actions tab. Select the **release** workflow
   ([.github/workflows/release.yml](../.github/workflows/release.yml)).

2. Run the workflow with `workflow_dispatch`. Select `bump` (`patch`, `minor` or `major`) and `dry_run`.

   - `dry_run: true` runs `bun src/release.ts prepare <bump>`. It prints the version and the diff. It does not open a branch or a pull request. Use it to check the bump first.

   - `dry_run: false` does the same bump. It opens pull request `release/vX.Y.Z` against `main`. The PR bumps `package.json` and `mod/.claude-plugin/plugin.json` to the same version. It moves the CHANGELOG's `## Unreleased` section under a new `## X.Y.Z (date)` heading.

   - `src/release.ts` refuses an empty Unreleased section, a version mismatch between the two JSON files, or a tag that already exists.

3. The release job also runs `gh workflow run ci.yml --ref release/vX.Y.Z`. A pull request that `GITHUB_TOKEN` opens starts no `pull_request` run on its own. This step makes the CI checks report on the release PR's head SHA.

4. Wait for the `ci.yml` checks (`test`, `plugin`, `typecheck`, `format`) to go green on
   the PR.

5. Merge the PR with the exact head SHA that the checks ran on:

   ```sh
   gh pr merge <N> --merge --match-head-commit <SHA>
   ```

   `--match-head-commit` makes the merge fail if the branch changes after the last green check.
   This flag closes the late-commit risk in the goal of claude-factory-5h9. PR #18 merged before
   its second commit landed. A later fix, #20, had to catch up by hand. A commit that you push to
   `release/vX.Y.Z` after this merge does not ship with it. It needs a new PR.

6. After the merge, [.github/workflows/release-tag.yml](../.github/workflows/release-tag.yml)
   runs on its own, and it does these actions:
   - Read the merged version.
   - Stop if the tag already exists.
   - Tag the merge commit `vX.Y.Z`.
   - Push the tag.
   - Run `gh release create vX.Y.Z --verify-tag --notes-file <file>` with the notes read back from the same CHANGELOG section (`bun src/release.ts notes X.Y.Z`).

   No step needs a hand edit.

## Tag signing: gitsign, not a stored key

[gitsign](https://github.com/sigstore/gitsign), the keyless signer from Sigstore, runs inside `release-tag.yml` and signs each new tag. The job sets `GITSIGN_TOKEN_PROVIDER=github-actions` and has the `id-token: write` permission. gitsign trades the job's short-lived GitHub OIDC token for a one-time certificate from Sigstore's Fulcio. It uses that certificate to sign the tag. This repo's secrets never hold a long-lived key that signs tags. A public repo's CI must not carry such a key.

Verify a new tag:

```sh
gitsign verify-tag vX.Y.Z \
  --certificate-identity=https://github.com/zach-source/claude-factory/.github/workflows/release-tag.yml@refs/heads/main \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
```

A person made the tags up to and including `v0.12.0` by hand with `git tag -s`. Git signed them with SSH. Verify one of these tags with the earlier method:

```sh
git verify-tag v0.12.0   # or: git verify-commit, for a commit
```

## What CI runs, and what it skips

[.github/workflows/ci.yml](../.github/workflows/ci.yml) has 4 jobs, each a required check on
`main`:

- **test**: `PKGGATE_E2E_REQUIRE=1 bun test --timeout 30000 src factories`. The runner
  installs 6 binaries that the pkg-gate e2e tests need: `go`, `node` with `npm`, `python3` with
  `pip`, `uv`, and `zip`.
  - The `zip` binary is already on `ubuntu-latest`.
  - `PKGGATE_E2E_REQUIRE=1` makes a missing binary a named failing test.
  - It never produces a quiet skip (claude-factory-5h9.3).
- **plugin**: `claude plugin test mod`, with a pinned Claude Code CLI version and an empty
  `HOME`. This needs no login and no network.
- **typecheck**: `bunx tsc --noEmit -p .` only. It skips `tsc -p mod` on purpose.
  `tsc -p mod` needs `mod/.claude-plugin/types/`, a directory only a live Claude Code
  session writes when it loads the mod. `claude plugin test mod` does not write that
  directory, so without it `tsc -p mod` fails with `TS5083`
  (`Cannot read file .../types/tsconfig.json`). No unattended CI step can make that
  directory today.
- **format**: `bunx prettier@3.9.9 --check .`.

## The late-commit risk (goal A6)

The required checks in `ci.yml` run against the exact head SHA of a pull request. GitHub's branch protection blocks a merge after a newer, unchecked commit lands on that branch. The merge command in step 5, `gh pr merge <N> --merge --match-head-commit <SHA>`, adds a second check.

It refuses to merge unless the branch's current head still equals the SHA that the checks ran on. Together, these two checks block a merge of any commit that the required checks never saw. A commit pushed after the merge is not part of it. It needs its own PR and green checks.

## Keep the manager's checkout current

`factory self-update` fast-forwards the local checkout that holds `bin/factory` to `origin/main`. `tick()` runs it at most once every `FACTORY_SELF_UPDATE_MS` (5 minutes by default). It runs under the tick lock, so it never races a tick that is in progress. The command refuses and changes nothing in these cases:

- The tree is dirty.
- The branch is not `main`.
- History has diverged.
- The configured remote or branch is wrong.
- `FACTORY_SELF_UPDATE=0`.

It runs `bun install` only when `bun.lock` changed. `factory` writes each outcome to `$FACTORY_HOME/self-update.json`. It mails each outcome to the manager, once per new outcome.

This closes the goal's story about PR #18/#20. After #18 merged, the manager's checkout kept the old version until someone pulled by hand. Self-update now does that pull on its own.
