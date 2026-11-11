# Contract: one writer for the halt state

Covers FR-003. Bead claude-factory-sg4s3 makes the same fix for the current design. This contract reuses it.

## Rules

1. `stop`, `resume` and the tick change `halt.json` and `resume.json` only while they hold `tick.lock`. This applies to the CLI, `/v1/halt` and the mod.
2. A command that cannot get the lock in 10 s posts its change to the queue file `halt-cmd.jsonl`. Then it returns `queued` with the seq. The next tick applies the queue first, in seq order, before it reads the halt state.
3. Each person command raises `seq` by one. The tick reads `halt.json` again under the lock right before it writes. It writes only if `seq` did not change since it read it.
4. A tick never writes `paused` when `halt.json` is absent and `resume.json` has a newer seq.
5. `factory status`, `/v1/status` and `/v1/board` show the halt state and its age at the top. The herdr status line shows it too.

## Tests (each fails before the fix)

- A tick reads `stopping`. Then a resume lands. The tick ends. Result: no `halt.json`, and the workers resume.
- Two resumes and one stop in one tick time: the last command wins.
- `stop` while a tick holds the lock: the result is `queued`, and the next tick applies it.
