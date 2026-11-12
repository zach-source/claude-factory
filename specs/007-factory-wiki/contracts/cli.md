# Contract: `factory wiki` CLI and settings

All commands use `FACTORY_HOME`. All commands except `find` and `status` take `wiki.lock`. If the lock is held, they exit 0 with `wiki: busy`.

| Command | Does | Exit |
|---------|------|------|
| `factory wiki init [--remote <url>]` | Makes `$HOME/wiki/` a git repo if it is not one. Seeds `index.md` and `glossary.md`. Sets `origin` to `--remote` or `FACTORY_WIKI_REMOTE`. Checks visibility. | 0, or 1 when the seed commit fails, the remote is public, its visibility is unknown or the repo config has a key outside the allow-list |
| `factory wiki refresh [--dry-run]` | Makes `rigs/*.md` and the rig list in `index.md`, then commits and pushes. `--dry-run` prints the changed paths and writes nothing. | 0 |
| `factory wiki write [--dry-run] [--bead <id>]` | Runs the write pass on the beads closed since `lastWriteAt`, or on one bead. `--dry-run` prints the input groups and does not run the agent. | 0, or 1 when the agent fails (the stamp stays written) |
| `factory wiki groom [--dry-run]` | Runs the groom pass and opens a PR. `--dry-run` prints the plan and does not apply it. It skips when a groom PR is open. | 0 |
| `factory wiki find <bead\|pr\|word>` | Prints `path<TAB>title<TAB>url` for each page whose frontmatter or title matches. | 0, or 1 when nothing matches |
| `factory wiki status` | Prints a JSON object with these fields: `lastRefresh`, `lastWrite`, `lastGroom`, `groomPr`, `pending` (closed beads with no page), `flags` (lines in `needs-person.md`) and `visibility`. | 0 |

## Kicks (in the `tick()` `finally` block)

| Pass | Stamp | Period | Env override |
|------|-------|--------|--------------|
| refresh | `wiki-refresh.stamp` | 30 min | `FACTORY_WIKI_REFRESH_MIN` |
| write | `wiki-write.stamp` | 3 h | `FACTORY_WIKI_WRITE_MIN` |
| groom | `wiki-groom.stamp` | 24 h | `FACTORY_WIKI_GROOM_MIN` |

- While `$HOME/wiki/.git` is missing, the factory does not kick any wiki pass. The feature is opt-in, so the owner must run `factory wiki init` first.
- When the factory halts, it does not kick write or groom. It still kicks refresh, and the rig pages then show the halt.
- `FACTORY_NO_KICK=1` turns off all wiki kicks. It also turns off the other kicks.

## Settings

| Env | Default | Meaning |
|-----|---------|---------|
| `FACTORY_WIKI_REMOTE` | (none) | The private git remote. If it is not set, the factory commits but does not push. |
| `FACTORY_WIKI_GROOM_CAP` | 15 | The maximum number of page actions in one groom plan |
| `FACTORY_WIKI_WRITE_CAP` | 20 | The maximum number of input groups in one write pass |
| `FACTORY_DREAM_CODEX` | (unset) | When it is set, write and groom run codex in place of `claude -p`, as the dream does. Groom runs `codex exec -s read-only` for the plan call and `codex exec -s workspace-write` for the apply call, with the private home `HOME/codex-groom` |

## Journal lines

- `wiki refresh: <n> rig pages, <changed> changed`
- `wiki write: <n> pages from <m> beads; <k> waiting`
- `wiki groom: PR <url> with <n> actions`
- `wiki groom: skipped, PR <url> open`
- `wiki groom: plan call failed (exit <n>)`
- `wiki groom: apply call failed (exit <n>), nothing committed`
- `wiki groom: <path> is not in the plan, reverted`
- `wiki groom: FACTORY_DREAM_CODEX is not a model name, skipped`
- `wiki groom: the wiki holds .codex, codex refused`
- `wiki groom: secret shape in the plan, skipped`
- `wiki: secret shape in <path>, page kept at last version`
- `wiki: person's line in <path>, page kept, flagged`
- `wiki: remote is public, push refused`
- `wiki: repo config not allowed, push refused`
- `wiki: repo config not allowed, nothing committed`
- `wiki: repo config not allowed, pull skipped`
- `wiki groom: repo config not allowed, skipped`
- `wiki groom: repo config not allowed, nothing committed`

## Commits

- Author: the factory identity (`git -c user.name=factory -c user.email=factory@<host>`).
- Message: `wiki <refresh|write|groom>: <summary>`.
