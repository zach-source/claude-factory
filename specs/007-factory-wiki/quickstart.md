# Quickstart: validate the factory wiki

## Prerequisites

- A copy of a factory home, for example `cp -a <factory home> /tmp/wiki-home`. Do not use the live home for steps 1 to 5.
- An empty private repo for the test, for example `<org>/factory-wiki-test`.
- `gh` with access to that repo.
- `export FACTORY_HOME=/tmp/wiki-home FACTORY_NO_KICK=1`, so that no tick starts a pass.

## 1. Opt-in and the private guard (FR-014, FR-019)

1. Run `factory wiki init --remote git@github.com:<org>/factory-wiki-test.git`. Expect exit 0, and expect `wiki/index.md` and `wiki/glossary.md` to exist.
2. Run `factory wiki init --remote <a public repo>`. Expect exit 1, and expect the journal line `wiki: remote is public, push refused`.

## 2. Rig pages agree with the run list (US1, SC-003)

1. Run `factory wiki refresh --dry-run`. Expect one path for each rig in `rigs.json`.
2. Run `factory wiki refresh`. For one rig, compare `wiki/rigs/<rig>.md` with `factory status` and `factory waiting`:
   - Each live run shows under "In progress" or "Waits on a person".
   - Each waiting item shows its question.
   - "Last update" is the time of the run.
3. Expect a commit by the factory identity on the remote's `main`.

## 3. Solution pages (US2, SC-001, SC-004)

1. Run `factory wiki write --dry-run`. Expect one input group for each closed, non-trivial bead with a merged PR. A docs-only PR must not show.
2. Run `factory wiki write --bead claude-factory-3w8o`. Expect one page in `solutions/2026-11/` that names PR #590 and PR #591, with all 7 sections.
3. Give the page to a developer who did not work on the change. They must answer "what changed and why" in 5 min or less.

## 4. Guards (FR-012, FR-013, FR-017)

1. Put a line of fake token shape into a solution page, for example `ghp_` followed by 36 letters. Then run `factory wiki write --bead <id>`. Expect the page to stay at its last version, and expect the journal line `wiki: secret shape in …`.
2. As yourself (not the factory identity), edit one line of a solution page and commit it. Run a write or groom pass that changes that line. Expect your line to stay, and expect a flag in `needs-person.md`.
3. As yourself, delete a solution page and commit. Run `factory wiki write` again. Expect the factory not to make the same path again.

## 5. Grooming (US3, FR-009, FR-010, FR-020)

1. Seed two pages on the same topic, and one page that names a removed env var.
2. Run `factory wiki groom --dry-run`. Expect a plan of 15 lines or fewer with a merge and a stale action.
3. Run `factory wiki groom`. Expect a PR on a `groom/<date>` branch whose body is the plan, and expect no change on `main`.
4. Run `factory wiki groom` again. Expect `wiki groom: skipped, PR <url> open`.
5. Merge the PR.
6. Run `git revert -m 1 <merge>`. Expect the pages to return to their earlier versions.

## 6. Find (US4, SC-002)

1. Run `factory wiki find claude-factory-3w8o`. Expect the solution page.
2. Run `factory wiki find 591`. Expect the same page.

## 7. Live roll-out

1. On the live home, the owner runs `factory wiki init --remote <private repo>`.
2. After 30 min, the rig pages must exist.
3. After 3 h, the solution pages for the beads closed since init must exist.
4. Check `factory wiki status` each day for one week. `pending` must stay below 10% of the merges of that week.
