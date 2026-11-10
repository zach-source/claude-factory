# Data Model: Prove factory

## Stations of `factories/prove.ts`

The parent run walks these stations. A `lemma` run is a child run on a child bead.

| Station | Kind | Role | Outcomes → next |
| --- | --- | --- | --- |
| `pick` | worker (Claude) | Spec writer. Reads the code. Checks the fit (FR-004). Proposes properties. | `proposed` → `choose`; `nofit` → done (reject) |
| `choose` | gate | The person picks properties. | `picked` → `draft`; `again` → `pick`; `stop` → done (reject) |
| `draft` | worker (Claude) | Spec writer. Writes the Lean statements and the hook contracts that they need. | `drafted` → `review` |
| `review` | worker (Codex) | Reviewer of a different model family. | `ok` → `checks`; `changes` → `draft` |
| `checks` | worker (Claude) | Writes the vacuity witnesses, the mutants and their disproofs, and the historical-bug disproofs. Pushes the run branch and opens a draft pull request. | `written` → `precheck`; `nohistory` → `precheck` (the brief says that no historical bug was found) |
| `precheck` | `ciCheck` | No worker. Reads `prove-gate` on the head. With no `proofs/approved.json`, `gate.sh` runs in draft mode (contracts/prove.md). | `pass` → `approve`; `fail` → `draft` |
| `approve` | gate, `freeze` | The person approves the statements and the hook contracts. The core writes the approval record and the held-out copy. | `approve` → `architect`; `changes` → `draft`; `stop` → done (reject) |
| `architect` | worker (Claude, Opus) | Writes the proof plan. Files one child bead for each lemma group. | `planned` → `integrate` |
| `integrate` | worker (Claude) | Parks until each child bead is closed. Merges the proofs. Removes duplicates. Pushes. The only role that commits to the run branch. | `ready` → `gatekeep`; `stuck` → `lead` |
| `lead` | worker (Claude) | Team lead. Takes an unproved lemma. Tries to disprove it. Divides it again, or proposes an amendment. | `redivided` → `integrate`; `amend` → `critic` |
| `critic` | worker (Codex) | Reviews an amendment. Does not see the proof attempts. | `accept` → `amend`; `refuse` → `lead`; `weaker` → `lead` (files a bead) |
| `amend` | gate, `freeze` | The person approves an amendment. The core changes the held-out copy and the record. | `approve` → `integrate`; `refuse` → `lead` |
| `gatekeep` | `ciCheck` | No worker. Compares `proofs/approved.json` with the core's record, then reads the `prove-gate` check. | `pass` → done (ship); `fail` → `integrate` |
| `repair` | worker (Claude) | Entry station for a red `prove-gate` on the default branch. Updates the proofs for the new machine code. | `updated` → `integrate`; `amend` → `critic` |
| `lemma` | worker (Claude) | Prover on a child run. Owns one proof file. | `proved` → done; `unproved` → done (defer, with the reason) |

## Entities

### Property

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | Unique in the run. |
| `rig` | string | A rig of `rigs.json`. |
| `function` | string | The full Go symbol, for example `substrate/internal/egresspolicy.HostnamePattern.Matches`. |
| `claim` | string | Plain English. |
| `path` | `go-arm64` (phase 1) | Later: `wasm`, `rust-musl-arm64`. |
| `fit` | `fits` or a list of limits | FR-004. |

### Statement

| Field | Type | Rule |
| --- | --- | --- |
| `file` | path | Under `proofs/Spec/` in the rig. |
| `theorem` | string | A fully qualified Lean name. |
| `kind` | `main`, `vacuity`, `mutant`, `historical`, `hook` | `hook` is a trusted contract of a runtime routine. |
| `property` | Property id | |

### Approval record

The core stores it in `<factory home>/proofs/<run id>/approvals.jsonl`. Only the core writes it, and only on a gate decision.

| Field | Type | Rule |
| --- | --- | --- |
| `decision` | string | The gate decision id. |
| `kind` | `statements` or `amendment` | |
| `person` | string | From the decision. A worker or a patrol cannot answer (FR-005). |
| `at` | ISO time | |
| `commit` | git SHA | The approved commit of the run branch. |
| `files` | map of path → sha256 | Each statement file at `commit`. |
| `amendment` | Amendment id | Only for `kind: amendment`. |

### Held-out spec

`<factory home>/proofs/<run id>/heldout/`: a copy of the `files` of the last approval record. The worker hook denies a write to it. The rig's `proofs/approved.json` holds the same `decision`, `commit` and `files`.

### Proof plan

`proofs/plan.json` in the run branch.

| Field | Type | Rule |
| --- | --- | --- |
| `lemmas` | list of `{ id, file, statement, deps, bead }` | Each `file` is in one lemma only (FR-017). |
| `owner` | per lemma: a child bead id | |

### Amendment

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | |
| `theorem` | string | |
| `diff` | text | The change to the statement file. |
| `reason` | text | |
| `evidence` | `disproof`, `counterexample` or `argument`, with a path | FR-023. |
| `critic` | `accept`, `refuse` or `weaker`, with a reason | FR-024. |
| `decision` | gate decision id | Only after `accept`. |

### Gatekeeper result

| Field | Type | Rule |
| --- | --- | --- |
| `result` | `pass` or `fail` | |
| `check` | `hash`, `bytes`, `kernel`, `axioms`, `comparator`, `toolchain` | The first check that failed. |
| `theorem` | string | The failed theorem, if there is one. |
| `head` | git SHA | |

### Trusted base

Each `approve` and `amend` brief shows:

- the commit of `arm64-semantics/` and of the Go engine
- the Go toolchain version and the build flags
- each hook contract
- the standard axioms: `propext`, `Quot.sound`, `Classical.choice`
- the gap: production runs the amd64 binary, and the proof covers the arm64 binary

## State changes

- `approve` with outcome `approve`: the core writes an approval record of `kind: statements` and the held-out copy. Then the run goes to `architect`.
- `amend` with outcome `approve`: the core writes an approval record of `kind: amendment` and changes the held-out copy. Then the run goes to `integrate`.
- `gatekeep` with outcome `fail` and check `hash`: the runner also mails the manager. A changed statement with no decision is a guard event, not a proof failure.
