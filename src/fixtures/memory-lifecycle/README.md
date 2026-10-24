# Memory lifecycle fixtures

Generic test data for spec 003 (memory lifecycle). Copy it to a temp dir before a test writes to it.

- `memory/`: a memory store. It has notes of each kind (`fact`, `rule`, `recipe`), one old note with no kind, a note with `until:`, a superseded note, an inbox note, `CORE.md` and a `.usage.jsonl` with `shown`, `helped`, `confirmed` and `contradicted` events.
- `runs/`: three runs, one done, one aborted and one still at work. The `implement` station of each run reported `failed` for the same reason, so the journal holds one failure class over 3 runs.

The `state.json` files hold real xstate snapshots of a one-station factory (`factory.ts`).
