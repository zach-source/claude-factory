# CLI contract changes

## factory memory add
`factory memory add "<summary>" [body...] --kind fact|rule|recipe [--until <bead|pr|YYYY-MM-DD>] [--supersedes <note path>] [--rig R] [--from run/station] [--anyway]`
- exit 2 and usage text: `--kind` is missing or invalid; the body cites a bead/PR without `--until` and kind is not recipe; the `--supersedes` path is not a note.
- duplicate: prints `already noted ...` and logs `confirmed` (was `helped`).
- `--from` defaults to `$FACTORY_RUN/$FACTORY_STATION` when those are set.

## factory memory helped
`factory memory helped <path>... --from run/station` — refused (exit 2) without `--from` and without the env.

## factory memory eval
`factory memory eval [--self N] [--seed S]` → `recall@5 0.87  mrr 0.75  n=60` plus one line per category when curated cases carry `category`.

## factory memory compact
Unchanged flags. The dry run now also prints retire, demote and capped-out entries, and the cap.

## factory gc (new)
`factory gc [--days 7] [--dry-run]` → per-kind byte totals, runs pruned, launch scripts removed. It also runs from the tick, at most hourly. A dry run changes nothing.

## factory proposals (new; mirrors `factory skills`)
- `factory proposals` — list pending proposals: name, rung, target, one-line change.
- `factory proposals install <name>` — rung core: appends to CORE.md and commits. Higher rungs: `bd create` in the factory rig, then records the bead id. Prints what it did.
- `factory proposals reject <name> <why>` — status rejected; the reason goes to an inbox note.

## Manager mail
After a dream that leaves pending proposals, the manager gets one message per new set, like `skillMail()`.
