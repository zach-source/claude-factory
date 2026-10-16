# Quickstart: validate the memory lifecycle

Prereqs: a scratch `FACTORY_HOME` copied from fixtures (generic notes, never a real memory repo), `bun install`.

1. **Retention**: `FACTORY_HOME=$tmp factory gc --dry-run` lists bytes per kind and changes nothing (`git status` and `du` are unchanged). Then `factory gc`: finished runs older than 7 d have no `prompts/`; active runs are untouched.
2. **Write gate**: `factory memory add "x" body` exits 2 and names `--kind`. `factory memory add "x" "wait for abc-1xy" --kind fact` exits 2 and names `--until`. Adding with `--until abc-1xy` succeeds.
3. **Confirm**: adding the same summary again prints `already noted` and adds a `confirmed` line to `.usage.jsonl`.
4. **Expiry**: close the fixture bead `abc-1xy` (or stub `closedBeads()`), run `factory memory compact --dry-run`, and see `retire ... until abc-1xy closed`.
5. **Cap**: a fixture with 40 never-shown notes 20 d old shows a dry run with exactly 25 archives, oldest first.
6. **Score**: `bun test src/memory.test.ts -t activation` checks the table of event histories, scores and decisions.
7. **Proposals**: put a journal with 3 runs failing `implement` for one reason into the fixture, run a dream with a stub claude, and `factory proposals` shows one pending entry with its evidence. Then `install` (rung core → a CORE.md line) and `reject` (an inbox note).
8. **Eval**: `factory memory eval --self 60 --seed 1` prints recall@5 and MRR, and running it twice gives the same output.
9. **Clean repo**: after a dream, `git -C $tmp/memory status --porcelain` is empty and `.usage.jsonl` is in `git ls-files`.

Run `npm test` (src, factories and mod) after each phase.
