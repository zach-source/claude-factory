# Releasing claude-factory

This repo is public. Every release comes from a GitHub Actions workflow. Nobody edits
a version file or a tag by hand (claude-factory-5h9).

## One-time repo setting

`release.yml`'s "open the release PR" step runs `gh pr create`. It uses the job's own
`GITHUB_TOKEN`. GitHub refuses this call under one repo setting: "Allow GitHub Actions
to create and approve pull requests" set to off.

Check the setting:

```sh
gh api repos/zach-source/claude-factory/actions/permissions/workflow
```

Turn it on. Keep `default_workflow_permissions` at `read`:

```sh
gh api -X PUT repos/zach-source/claude-factory/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

Do this once. Do it before the first real dispatch of `release.yml`
(`dry_run: false`) (claude-factory-5h9.16).

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

6. The merge lands as a push to `main`. The push runs
   [.github/workflows/release-tag.yml](../.github/workflows/release-tag.yml) on its own.
   It does these actions:
   - Read `main`'s current version.
   - Check the tag `vX.Y.Z` and the release `vX.Y.Z` on their own
     (claude-factory-5h9.19). Stop here, with nothing else to do, only when both
     already exist.
     - A push that is not a release merge leaves the version unchanged. Both the tag
       and the release for it already exist, so the workflow stops.
     - When only the tag exists (an earlier run pushed the tag, then failed before it
       published the release), the workflow skips the tagging steps below. It goes
       straight to `gh release create`.
   - Refuse if `## Unreleased` is not empty at this commit (`bun src/release.ts
     check-no-late-unreleased`), unless the tag already exists (see above).
     - A commit can land on `main` after the release PR's cut, before the release PR
       itself merges. Its own bullet stays under `## Unreleased`.
     - The release notes below come from the already-cut `## X.Y.Z (...)` section, so
       they miss that bullet (claude-factory-5h9.11).
     - This check runs before the workflow makes the tag. So a refusal here leaves
       `vX.Y.Z` with no tag and no release, not a tag that ships the missed code.
     - The code itself stays on `main` either way. It reaches a release only once a
       later release bumps the version. That release cuts the current `##
       Unreleased` section, late bullet included, into its own new heading.
     - Until that later release runs, every push to `main` hits this same refusal.
       This workflow is not a required check, so a refusal here does not block a
       merge.
   - Sign the tag `vX.Y.Z` with gitsign.
   - Verify the signature.
   - Push the tag.
   - Run `gh release create vX.Y.Z --verify-tag --notes-file <file>`. The notes come
     from the same CHANGELOG section (`bun src/release.ts notes X.Y.Z`).

   No step needs a hand edit.

   This workflow runs on `push`. It does not run on `pull_request: types: [closed]`.
   Here is why. gitsign's Fulcio certificate carries a SAN. The SAN comes from the
   job's own OIDC `job_workflow_ref`. A `pull_request`-triggered run has a ref that
   ends `@refs/pull/N/merge`. It never ends `@refs/heads/main`. The verify command
   below pins the branch ref. On every release, this verify failed right after the
   tag push. A rerun had no clean path: it refused with "tag exists"
   (claude-factory-5h9.14). A `push`-triggered run has the real ref,
   `refs/heads/main`. The same verify command succeeds on it.

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
