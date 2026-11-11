# Research: Factory wiki

## R1. Where the pages live and how they reach readers

- **Decision**: `$HOME/wiki/` is its own git repo, like `memory/`.
  - Its remote is `FACTORY_WIKI_REMOTE`, a private repo (example: `git@github.com:<org>/factory-wiki.git`).
  - The git host shows Markdown and keeps history.
  - Push uses `git push origin HEAD:main`.
- **Rationale**: the owner chose one private git repo (FR-019). Memory already uses the pattern of a git repo in the home that the factory commits to (`commitMemory()`, `src/cli.ts:4282`). The host gives search, history, blame and PR review at no cost.
- **Alternatives considered**: (a) Push to a `wiki` branch of the home's origin, as `CONFIG_SYNC` does for `memory`. Rejected: the home origin holds config, so readers would need access to it. (b) The GitHub wiki feature of a repo. Rejected: it has no PRs, so grooming approval (FR-020) cannot work.

## R2. Private rigs (FR-014)

- **Decision**: one wiki repo holds all rigs of a factory home. That repo must be private.
  - Before each push, the factory reads `gh repo view <remote> --json visibility` once each 24 h.
  - The factory caches the result in `wiki-state.json`.
  - If the value is not `PRIVATE` or `INTERNAL`, the factory does not push.
  - The factory writes a `wiki: remote is public` error to the journal.
- **Rationale**: `rigs.json` has no visibility field (`Rig`, `src/cli.ts:6729`). One private repo makes all pages visible only to people who can already be given access. A per-rig visibility setting is not needed while the wiki is one private repo.
- **Alternatives considered**: a `private` field on each rig and a filter. Rejected (YAGNI). If a home needs a public wiki later, add the field then.

## R3. Secret scan (FR-013)

- **Decision**: before each commit, run `secretFile()` and the `SECRETS` patterns (`src/homebackup.ts:38-58`) on each staged page. Export them if needed.
  - If a page matches, unstage it and return the page to its last committed version.
  - Write `wiki: secret shape in <path>, page kept at last version` to the journal. Do not include the match text.
  - Replace token shapes with `TOKEN_SHAPE` in all source text before the text goes into an LLM prompt.
- **Rationale**: no check guards memory writes or worker reports today (finding 4). `secretFile` is the existing token-shape list, and it never returns the match. A check at commit time covers all three passes and also human edits that the factory pushes.
- **Alternatives considered**: an LLM self-check in the prompt only. Rejected because it is not deterministic.

## R4. Rig pages without an LLM (FR-001..003)

- **Decision**: `renderRigPage(rig, rows, waiting, merged, now)` is a pure function. It uses data that already exists:
  - `row()` for the goal, value and age (`src/cli.ts:3696`)
  - `waiting()` (`src/sidebar.ts:65`)
  - the merged cache (`src/cli.ts:10055`)
  - `shipQueues()` for the queued items

  The plain summary is the bead title. It also has the first sentence of the last report, without the `node#n outcome:` prefix. A glossary link replaces each station name.
- **Rationale**: 30-minute updates for 8 rigs with an LLM cost a lot and gain little, because bead titles are already plain. A pure function makes SC-003 (rig pages agree with the run list) testable.
- **Alternatives considered**: an LLM summary for each item. Rejected because of the cost and drift. The write pass can improve the text of solution pages instead.

## R5. Which closed beads get a solution page (FR-004, FR-006)

- **Decision**: the write pass takes beads that closed since `lastWriteAt` and have a merged PR. It gets the PR from bead metadata `ship_pr` or from `mergedPrsFor` (`src/cli.ts:7172`). `trivial(files)` drops a PR when all of its files are in one of these groups:
  - docs (`*.md`, `docs/`)
  - tests (`*.test.*`, `test/`, `tests/`)
  - `.factory/`
  - lock or version files (`*.lock`, `package.json` with only a version change, `CHANGELOG.md`)

  These classes are the same ones that ship uses for `published`.
  Some beads share a PR. Also, one bead can have a PR pair. Put each of these into one group, as one input item.
  Example: the `claude-factory-3w8o` case (#590 and #591).
- **Rationale**: SC-004 asks for 90% of non-trivial changes within 24 h. A pass each 3 h with a cap of 20 items fits about 60 merges each day.
- **Alternatives considered**: a new ship station that writes the page at deploy. Rejected: each rig's ship flow would change, and it would hold the ship lane.

## R6. Agent passes and their tools

- **Decision**: write and groom follow `dream()` (`src/cli.ts:4511`). Each one does these steps:
  1. Take `wiki.lock`. Write its stamp first.
  2. Run `claude -p --permission-mode acceptEdits` in `cwd: wiki/`.
     - Permit these tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`.
     - Permit these Bash patterns: `Bash(git mv:*)`, `Bash(git rm:*)`.
  3. Give read-only `--add-dir` access to each rig's repo. Groom can then check stale facts.
  4. Use codex with `FACTORY_DREAM_CODEX`.
  5. Stop after a 45 min timeout. Write the output to `wiki.log`.

  Each prompt has the source text inline: bead, comments, PR body and report log. The agent does not need `bd` or `gh`.
- **Rationale**: this reuses a proven pattern, with no new station, factory definition or run directory.
- **Alternatives considered**: a `wiki` sweeps station for each rig. Rejected: one wiki covers all rigs, and a station has no write access to a non-rig repo.

## R7. A person's edits (FR-012)

- **Decision**: before an agent pass, record `git blame --line-porcelain` for each page. A line belongs to a person when its author email is not the factory identity (`factory@<host>`). The factory sets this identity with `git -c user.email` on every factory commit.
  - After the pass, `humanLines(before, after)` lists each person's line that the pass changed or removed.
  - For each such page:
    1. Return the page to its earlier version.
    2. Add a short flag to `wiki/needs-person.md`. The flag has the page, the line and the agent's reason from its output.
    3. Keep the rest of the pass.
- **Rationale**: this is deterministic and needs no markers in the pages. git already knows who wrote each line.
- **Alternatives considered**: the prompt rule only, or protected regions marked in the pages. Rejected: the first is not enforced, and the second is noise for readers.

## R8. Grooming approval (FR-009, FR-010, FR-020)

- **Decision**: groom runs on a branch `groom/<YYYY-MM-DD>` from `origin/main`.
  - First, the prompt asks for a plan of up to 15 page actions. Each action has this form: `merge|rewrite|stale|supersede <path> — <reason>`.
  - `groomPlan()` parses the plan and applies the cap.
  - The agent then applies only the planned actions.
  - Code checks that the changed paths are in the plan. It reverts any extra path.
  - The plan becomes the PR body.
  - The factory pushes the branch and runs `gh pr create --repo <remote>`. It does not merge the PR.
  - If a groom PR from the factory is open, the pass skips. One groom PR is open at a time.
  - When the person merges the PR, the next refresh or write runs `git pull --rebase`.
  - If a write pass changed a page on main that the groom PR also changes, the PR shows a conflict for the person. The next groom pass makes the plan again from new data.
- **Rationale**: the owner chose option B. The cap and the plan log follow the memory tier pass (`ARCHIVE_CAP`, `planLines()`). A PR gives the person one place to approve. One revert of the merge commit removes all of it.
- **Alternatives considered**: the factory merges after a set time. Rejected, because it is against the owner's answer.

## R9. Deleted pages (FR-017)

- **Decision**: a page that a person's commit removed goes into `wiki-state.json` `tombstones` with its path and date. The factory finds these with `git log --diff-filter=AD` and the author check. A later add of the same path by a person lifts the tombstone. An add by the factory never lifts it. If the add and the delete have the same date, the tombstone stays. The write prompt lists the tombstones, and code refuses to make a tombstoned path again. The agent can write a new page on that topic only for a bead that closed after the tombstone date. The new path must end in `-<YYYY-MM>`.
- **Rationale**: the rule is simple and enforced in code, and it agrees with "until new work arrives".

## R10. Find (FR-015)

- **Decision**: each page's frontmatter lists `beads:` and `prs:`. The index page lists rigs and topics. `factory wiki find <bead|pr|word>` runs a grep on the frontmatter and titles, and it prints paths and the host URL. The host's code search covers full text.
- **Rationale**: SC-002 (2 minutes) needs a way in, not a search engine.

## R11. Glossary and STE

- **Decision**: `wiki/glossary.md` is a page in the seed that a person or groom keeps. Its first terms are station, soak, rig, ship lane, bead and run. The prompts tell the agent to write in ASD-STE100 and to link a glossary term on first use. Pages do not run the STE score hook, because the hook runs only in Claude Code sessions.
