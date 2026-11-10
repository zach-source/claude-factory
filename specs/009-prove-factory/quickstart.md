# Quickstart: Prove factory (phase 1, Go)

These steps show that phase 1 works from end to end. The station names and the files are in [data-model.md](data-model.md) and [contracts/prove.md](contracts/prove.md).

## Prerequisites

- The owner's main private Go rig is in `rigs.json`. Below, `<rig>` is its name and `<function>` is the pilot function that its bead names.
- The `prove` image is pushed, and `prove.image` is set.
- The Go engine package exists and is pinned (research.md R13).
- The rig's CI can run `ubuntu-latest` with 16 GB.

## 1. The factory model (no Lean)

```sh
bun test --timeout 30000 src factories
```

Expected: `factories/prove.test.ts` walks each station and each edge. `src/machine.test.ts` shows that `validate()` refuses each bad `ciCheck`, `freeze` and `heldout` combination. The compile test of `factories/lifecycle.test.ts` compiles `prove.ts`.

## 2. The gatekeeper refuses bad proofs (SC-002)

In a scratch clone of the rig, on a test branch, make each bad case. Run `proofs/gate.sh` for each one.

| Change | Expected line |
| --- | --- |
| Put `sorry` in a proof | `prove-gate: axioms: <theorem>: uses sorry` |
| Add `axiom cheat : False` and use it | `prove-gate: axioms: <theorem>: uses axiom cheat` |
| Weaken a statement in `proofs/Spec/` | `prove-gate: hash: proofs/Spec/<file>: does not match approved.json` |
| Weaken the statement and update `approved.json` | `proofs/gate.sh` passes the hash check, but the `gatekeep` station fails with check `hash` (the core's record differs) |
| Change one line of `<function>` | `prove-gate: bytes: <symbol>: the machine code changed` |
| No change | `prove-gate: pass` |

## 3. One run on the pilot (SC-001, SC-001a, SC-003)

```sh
factory start prove <rig> 'prove <function>'
factory decisions                 # the "choose" gate lists properties of <function>
factory decide <run> picked 'property 1'   # or from any other front end
```

Expected:

1. The run stops at `approve`. The gate brief (`gates.brief`) shows the statement, a vacuity witness and at least one mutant disproof. It also shows the historical-bug disproof for the code before the fix, the hook contracts and the trusted base. The trusted base shows the arm64 to amd64 gap.
2. Each runtime contract is a `part` gate on its own child run. Answer each one. Until each one has an answer, `factory decide <run> approve` refuses and names the open parts.
3. `factory decide <run> approve` writes `<factory home>/proofs/<run>/approvals.jsonl` and the held-out copy. `factory proofs show <run>` lists the hashes.
4. The run files child beads for the lemmas, and the `lemma` runs prove them.
5. `gatekeep` passes. The run hands the pull request to `ship`. The person merges it.

## 4. A change breaks the proof (SC-004)

On a test branch of the rig, change `<function>`. Open a pull request.

Expected: `prove-gate` fails in the pull request with check `bytes`. After a red change merges to the default branch, the next `ci` sweep files one bead with `factory:prove` and `station:repair`. Then one repair run starts.

## 5. Front ends (SC-005)

Stop a run at `approve`. Open the web UI, the CLI, the Claude mod and the Herdr mod. Each one shows the same brief. Answer from one of them. The others show the answer. A worker that runs `factory decide` gets a refusal.

## 6. The held-out guard (SC-006)

From a worker pane, try to write a file in `<factory home>/proofs/<run>/heldout/`. Expected: the worker hook denies it.
