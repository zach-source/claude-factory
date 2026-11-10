# Contract: the prove workflow, the core and the rig

## 1. The factory model

New node fields in `src/machine.ts`:

| Field | Type | Meaning | `validate()` refuses |
| --- | --- | --- | --- |
| `ciCheck` | `{ name: string; pass: string; fail: string }` | The runner starts no worker. It reads the named check on the head commit of the run's pull request. Green posts `pass`. Red posts `fail` with the summary of the failed step. Pending parks the run. | `ciCheck` with `gate`, `agent`, `split`, `awaitsPr`, `mergeCheck` or `runner`; `pass` or `fail` that is not a key of `next` |
| `freeze` | `{ on: string; dir: string; record: string }` | Only on a `gate`. When the person answers with the outcome `on`, the core hashes each file under `dir` at the run branch head. It writes the approval record and the held-out copy. Then it writes `record` (for example `proofs/approved.json`) to the run branch as a commit. | `freeze` on a node with no `gate`; `on` that is not a key of `next` |
| `heldout` | `true` | Only on a `ciCheck` node. Before the runner reads the check, it compares the `record` file at the head with the core's last approval record. A mismatch posts `fail` with check `hash`. | `heldout` with no `ciCheck`, or in a factory with no `freeze` node |

## 2. Core operations

The prove decisions use the existing operations. They need no new operation:

| Operation | Use |
| --- | --- |
| `decisions.list` | Lists the open `choose`, `approve` and `amend` gates. |
| `gates.brief` | The brief of a prove gate. It adds the statements, the check results, the hook contracts and the trusted base (data-model.md). |
| `gates.decide` | Answers a prove gate. It refuses a worker or a patrol (`src/core/ops/gates.ts`). For a node with `freeze`, it writes the record before it posts `DONE`. If the write fails, the decision fails, and the run stays at the gate. |

One new read operation:

| Operation | Input | Output | Rights |
| --- | --- | --- | --- |
| `proofs.show` | `run` | The approval records, the held-out file list with hashes, and the last gatekeeper result | read |

Each front end gets `proofs.show` through its generic view (spec 008, `contracts/frontends.md`). If a front end cannot show it, the change adds a gap entry to `parity-gaps.json` and files a bead.

## 3. The rig

The first prove run on a rig adds these files from `templates/prove/` in claude-factory:

```text
proofs/
  lakefile.lean        # pins arm64-semantics, the Go engine, lean4export and comparator by commit
  lean-toolchain       # leanprover/lean4:v4.34.0
  Spec/                # the statements (trusted): main, vacuity, mutant, historical, hook
  Proofs/              # the proofs (not trusted)
  Generated/           # from go-elf2lean; not checked in; the gate makes it again
  mutants/             # one patch file for each mutant
  approved.json        # { decision, commit, files: { path: sha256 } }
  plan.json            # the proof plan
  comparator.json      # modules, theorem_names, permitted_axioms
  gate.sh              # the gatekeeper
  LICENSE-upstream     # the Apache 2.0 text and any NOTICE text of arm64-semantics and comparator
.github/workflows/prove-gate.yml   # runs proofs/gate.sh on ubuntu-latest, on each pull request and on the default branch
```

### `proofs/gate.sh`

The script runs these checks in this order. It stops at the first failure. It prints one line `prove-gate: <check>: <theorem or file>: <reason>` and exits 1. If all pass, it prints `prove-gate: pass` and exits 0.

| Order | Check | Pass when |
| --- | --- | --- |
| 1 | `toolchain` | The Go toolchain, Lean, `comparator`, `lean4export` and `landrun` are the pinned versions. |
| 2 | `hash` | Each file under `proofs/Spec/` has the sha256 of `approved.json`, and no file is added or removed. |
| 3 | `bytes` | A fresh proof build (`CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false`) gives the same bytes for each proved function and each routine that it calls, as the generated module. The same applies to each mutant build. |
| 4 | `kernel` | `lake build` passes. |
| 5 | `axioms` | No theorem uses `sorry` or `native_decide`. No proof uses an axiom other than `propext`, `Quot.sound` and `Classical.choice`. |
| 6 | `comparator` | `comparator` prints `Your solution is okay!` for `comparator.json`. It replays the environment that `lean4export` exports in a fresh kernel. |

The script reads only file paths and theorem names. It does not read a worker report.

Draft mode: if `proofs/approved.json` does not exist, the script skips the `hash` check. Then the `kernel`, `axioms` and `comparator` checks apply only to the `vacuity`, `mutant` and `historical` theorems. A `main` theorem can have the proof `sorry`. The `precheck` station uses draft mode before the approval. After the approval, the `gatekeep` station runs with `heldout`. Thus, a head with no `approved.json` fails the `hash` compare in the runner. A worker cannot get draft mode by a delete of the file.

## 4. The `ci` sweep

If the red workflow on the default branch is `prove-gate`, the bead gets the labels `factory:prove` and `station:repair`. It keeps the key `ci-red:<workflow id>-<SHA>` as today.
