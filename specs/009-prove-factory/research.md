# Research: Prove factory

Facts come from a survey of these sources:

- The code at `origin/main` 8d6a84ed (2026-11-10).
- google-deepmind/code-verification at `main` `808b4b7ffef1` (2026-11-10).
- The `substrate` rig at its `main` on 2026-11-10.

## R1. Reuse of the upstream semantics and comparator

**Decision**: Reuse `arm64-semantics/` of google-deepmind/code-verification and `leanprover/comparator`. Pin both at a commit. Write our own `comparator` run script and configs.

**Rationale**: The licenses are clear for the parts that phase 1 uses:

| Part | Evidence | License |
| --- | --- | --- |
| `arm64-semantics/` | Its own `LICENSE` file (the full Apache 2.0 text). Its README: "All code is licensed under the Apache License, Version 2.0". | Apache-2.0 |
| The repo root and its scripts | The root README: "Copyright 2026 Google LLC. All code is licensed under the Apache License, Version 2.0". | Apache-2.0 |
| The root `LICENSE` file | Nine lines. It lists only the third-party exceptions: MIT parts (hashbrown, the Rust standard library, musl) and AGPL-3.0 files in `third_party/libsignal`. GitHub cannot find a known license in it, so the repo shows `NOASSERTION`. | — |
| `leanprover/comparator` | Its own `LICENSE` file. | Apache-2.0 |
| `landrun` | GitHub license field. | MIT |

License facts that the owner checked on 2026-11-10:

- The README of google-deepmind/code-verification says that all code is Apache 2.0 (Copyright 2026 Google LLC).
- Only the `third_party/libsignal` files are AGPL-3.0. Phase 1 does not need them.
- The hashbrown, Rust standard library and musl parts are MIT.

Result: phase 1 can reuse `arm64-semantics/` and `comparator` under Apache 2.0. Apache 2.0 section 4 requires that the rig keeps the license text and any `NOTICE` text with the dependency. On 2026-11-10, the repo root and `arm64-semantics/` have no `NOTICE` file. If a later pinned commit adds one, the rig must keep it in `LICENSE-upstream`.

Neither repo has a release (0 releases on 2026-11-10). So the rig pins a commit. The upstream `comparator/run.sh` runs `comparator` on two configs and fails unless both print `Your solution is okay!`. Its `install-tools.sh` builds `comparator` and `lean4export` at their `v4.34.0` tags, and `landrun` at a pinned commit. The factory copies this behavior, not the files.

**Alternatives**: Copy the upstream files into this repo. That adds about 7,600 lines of trusted Lean to a public repo that does not run Lean. It also makes the upstream fixes hard to take.

## R2. Where the gatekeeper runs

**Decision**: The gatekeeper is one script in the rig (`proofs/gate.sh`). The rig's CI runs it on Linux in a job named `prove-gate`. The `gatekeep` station of the run does not start a worker. The runner reads the result of the `prove-gate` check on the head commit of the run's pull request. Then it posts the outcome `pass` or `fail`.

**Rationale**:

- `comparator` uses `landrun`, and `landrun` uses Landlock. Landlock is Linux only. The laptop runs macOS.
- The upstream core build needs about 6 GB and about 15 minutes. A full upstream build needs about 25 GiB. The manager process must not run a build of that size.
- `substrate` is public and its CI uses `ubuntu-latest` (4 vCPU, 16 GB for a public repo). The core build fits.
- FR-022 says that the gatekeeper is the same command in a run and in CI. When the run uses the CI result, there is only one command.
- An agent cannot decide the result. The runner reads the check state from GitHub. No worker report goes into it.

**Alternatives**:

- A runner-side `spawnSync`, like `mergeCheck` (`src/cli.ts:4407`). It needs Linux and a large memory on the manager host.
- A worker station that runs the script and reports the outcome. An agent then reports the result, so it is not deterministic (FR-019).
- An AX worker sized for Lean. This spec must not change the cluster.

## R3. A deterministic station: the `ciCheck` node field

**Decision**: Add a node field `ciCheck: { name, pass, fail }` to the factory model (`src/machine.ts`). A node with `ciCheck` starts no worker. The runner finds the run's pull request and reads the named check at the head commit:

- If the check is green, the runner posts `DONE` with the `pass` outcome.
- If it is red, the runner posts `DONE` with the `fail` outcome and the failed step's summary.
- If it is pending, the run waits, as a node with `awaitsPr` waits.

`validate()` refuses `ciCheck` together with `gate`, `agent`, `split` or `awaitsPr`, as it refuses other conflicts today (`src/machine.ts:330-365`).

**Rationale**: The runner already posts an outcome with no worker for `mergeCheck` (`src/cli.ts:4407-4426`). The `awaitsPr` wait (`src/machine.ts:722-733`) already parks a run on a pull request. `ciCheck` uses both mechanisms. It is general: a later workflow can wait for any named check.

**Alternatives**: A `prove`-only hook in the runner. It is the same code with a narrower name.

## R4. The held-out spec

**Decision**: Three layers:

1. When the person answers "approve statements", the core copies the statement files at the approved commit to `<factory home>/proofs/<run id>/heldout/`. It writes the approval record with a sha256 for each file (FR-007). The rig's worktree does not hold this directory.
2. The run's commit adds `proofs/approved.json` to the rig: the decision id, the commit and the sha256 of each statement file. `proofs/gate.sh` fails first if a statement file does not match `approved.json`. `comparator` uses the statement files as the challenge.
3. The runner compares `proofs/approved.json` at the head commit with the core's approval record. It does this before the `gatekeep` station reads the CI check. If a worker changed both the statements and `approved.json`, the hashes do not match the core's record. Then the station fails.

The worker hook (`src/worker-hook.ts`, `fileWriteReason`) also denies a write to the held-out directory.

**Rationale**: A path guard alone is not enough. A worker can write a file through a shell command that the hook does not parse. The hash check against the core's record does not depend on the guard. Only the core writes the record, and only on a person's decision.

**Alternatives**: A read-only mount of the spec in the worker sandbox. Only the AX VM runner has a sandbox, so a laptop worker gets no protection (constitution Principle I). `CODEOWNERS` and branch protection: not every rig has them, and the person merges every pull request anyway.

## R5. Many provers at the same time

**Decision**: The `architect` station files one child bead for each lemma group. Each child has the labels `factory:prove` and `station:lemma`. Each child names the one proof file that it owns. Each child is a run of its own. The parent run parks at `integrate` (a `BLOCKED` report) until all child beads are closed.

**Rationale**: A run of the factory is at one node at a time (`src/machine.ts`). The factory already runs many beads at the same time, with a slot limit for each rig. One file for each child bead meets FR-017 (one worker edits a proof file at a time). The `architect` plan lists the file of each child. A test refuses a plan in which two children own the same file.

**Alternatives**: Many panes in one run. The machine has no model for that.

## R6. A different model family for the reviewer and the critic

**Decision**: The `review` and `critic` nodes set `agent` to the Codex worker command. The `pick`, `draft`, `architect`, `lead`, `lemma` and `integrate` nodes use the Claude worker command.

**Rationale**: Nodes can already set `agent` (`src/machine.ts:49-173`). `lifecycle` uses `split` with Codex for `plan` and `implement`. FR-008 needs a different family for each review, so `review` uses `agent`, not `split`.

**Alternatives**: `split`. It sends only a share of the runs to Codex.

## R7. The Go path on the AArch64 semantics

**Decision**: The Go path adds these parts on top of `arm64-semantics/`. Each one is new trusted code (`tcb`), except where the table says "proof" or "test".

| Part | What it does | Kind |
| --- | --- | --- |
| `go-elf2lean` | Reads the linked `GOARCH=arm64` ELF (the Go linker output, not an `ld.lld` output). It finds a function by its symbol in `.symtab` (`substrate/internal/egresspolicy.HostnamePattern.Matches`). It writes the code bytes and the address as a Lean module. It uses the upstream model of a stock-linked executable (`PlacedLib.LinkedIn`). | tcb |
| `go_spec` | A surface that writes a pre- and post-condition for a Go function under `ABIInternal` on arm64. It lowers to the upstream separation-logic predicates. Integer and pointer arguments and results use R0 to R15. A `string` is two words (a pointer and a length). The closure context is R26. The current goroutine `g` is R28. | tcb |
| Stack check | Each Go function with a frame starts with a compare of SP with `g.stackguard0` and a branch to `runtime.morestack`. The precondition says that the stack has room (`SP - frame > g.stackguard0`). Then the branch is not taken, and `morestack` needs no hook for a leaf function. | tcb (precondition) |
| Hook contracts | `runtime.mallocgc`, the write barriers (`runtime.gcWriteBarrier*`), `runtime.morestack` and the panic entry points (`runtime.gopanic`, `runtime.panicIndex` and the others). Each hook has a contract. The owner approves each contract with the statements (FR-004c). The pilot does not allocate, so it needs only the panic entry points. | tcb, owner-approved |
| Instructions | The pilot's code and the routines that it calls use AArch64 instructions. The upstream semantics (467 instructions) does not have some of these. `strings.Contains` with a one-byte string calls `internal/bytealg.IndexByteString`, which is hand-written arm64 assembly that can use SIMD instructions. Either the semantics adds them, or a hook contract covers `IndexByteString`. Slice E1 of the plan measures the list first. | tcb + test |
| Differential tests | Each added instruction runs in lockstep against `qemu-aarch64` and Unicorn, with the upstream test tools. | test |

`GODEBUG=asyncpreemptoff=1` and `GOMAXPROCS=1` apply to the differential tests and to any run of the proof build. A function-level proof does not run the scheduler, so the settings do not change the proof. They make the test runs match the model of one thread.

**Rationale**: The upstream engine already proves a subroutine contract against placed machine code (`subroutine_ok`) and ties it to a stock-linked executable. The Go-specific parts are the ABI, the linker output and the runtime calls. The stack-check precondition removes the most common runtime call from a leaf function with no hook.

**Alternatives**: Prove the Go function through `gccgo` or `-linkshared`. Production does not use them, so the proof is about a different artifact.

## R8. The same bytes on a fresh build

**Decision**: The proof build is `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false` with the toolchain of the rig's `go.mod`. `proofs/gate.sh` builds it again and compares the bytes of each proved function with the bytes in the generated Lean module.

**Rationale**: Go builds are reproducible with `-trimpath` and a pinned toolchain. The compare uses the function bytes, not the whole binary. So an unrelated change elsewhere in the binary keeps the proof. A change to the function or to a routine that it calls fails the gate (User Story 7).

**Alternatives**: Compare the whole binary. Then each change to the rig breaks every proof.

## R9. The pilot

**Decision**: `HostnamePattern.Matches` in `substrate` (`internal/egresspolicy/egresspolicy.go:342`). The spec gives the reasons ("Pilot of phase 1").

The historical bug for the historical-bug check is the code before commit `6621f2b4`. That code had no `case hostname == ""` and no `case p.any`. An empty host name then matched a pattern with an empty exact name.

## R10. Mutation tests and vacuity witnesses

**Decision**: The `checks` station writes:

- A vacuity witness as a Lean theorem: there is an input and a state that make every hypothesis true.
- Each mutation as a patch file under `proofs/mutants/`. For each mutation, a Lean theorem says that the main theorem is false. The claim covers the machine code of the mutant build.
- The historical bug as a mutant that is a reverse patch of the fix commit.

These theorems are part of the approved statements. So `comparator` checks them, and `proofs/gate.sh` builds each mutant and checks its proof.

**Rationale**: DeepMind's checks are proofs that the kernel checks, not test runs. When the checks are theorems, the gatekeeper covers them with no new trusted code.

**Alternatives**: Run the mutants as tests. A test cannot show that the theorem is false. It can only show that the code behaves differently.

## R11. The proof check after a merge

**Decision**: The `ci` sweep (`factories/sweeps.ts`) already files one bead for each red workflow on the default branch. If the red workflow is `prove-gate`, the bead gets the labels `factory:prove` and `station:repair` instead of `station:plan`.

**Rationale**: The sweep already deduplicates by the key `ci-red:<workflow id>-<SHA>` (FR-027: one bead, not one for each pass).

**Alternatives**: A new sweep. It repeats the dedupe and the CI read.

## R12. Phase 2 research: a WebAssembly semantics in Lean (owner, 2026-11-10)

**Result**: No mature Lean 4 WebAssembly semantics exists.

| Candidate | Language | State | License |
| --- | --- | --- | --- |
| cajal-technologies/talos | Lean | Executable, a spec-test runner, a WP calculus. Work in progress. No binary decoder: it uses `wasm-tools`. | AGPL-3.0 |
| T-Brick/lean-wasm | Lean | A formal semantics that targets a C0 compiler. | GPL-3.0 |
| aionescu/lean-wasm | Lean | A typed interpreter. | GPL-3.0 |
| argumentcomputer/Wasm.lean | Lean | A parser. No change since 2023. | MIT |
| WasmCert-Coq | Rocq | Wasm 2.0, mature. Not Lean. | — |
| SpecTec | — | Has Rocq output. Lean output is only planned. | — |

| linobit-corp/wasm-lean | Lean | "Formalization of WebAssembly in Lean 4". Last push 2026-04-25. Scope not known. | MIT |

**Decision (owner, 2026-11-10)**: Phase 2 uses a new Lean 4 WebAssembly semantics. It does not use Rocq.

- **Fork or build.** The fork base candidates are only the permissive ones: argumentcomputer/Wasm.lean (MIT, has a parser, no change since 2023) and linobit-corp/wasm-lean (MIT, scope not known). Task W1 evaluates both and picks a fork or a new build.
- **Clean code.** Do not copy from AGPL or GPL code: Talos (AGPL-3.0), T-Brick/lean-wasm (GPL-3.0) and aionescu/lean-wasm (GPL-3.0). Read only their public docs. Our code then stays clean for a public repo.
- **Scope.** Wasm 2.0 MVP plus bulk memory and sign extension. The semantics is executable. It has a decoder for that subset.
- **State shape.** The top-level relation has the DeepMind style: a runs-to relation such as `ElfRunsTo` (`arm64-semantics/Arm64/Trusted/Process/Semantics.lean:126`), with partial and total forms. The same gatekeeper and `comparator` flow then work for phase 2.
- **Gate before any proof.** The semantics must pass differential tests against the WebAssembly/spec reference interpreter and the official testsuite for the subset. No proof on it starts before this gate passes.
- **Repo.** It lives in its own repo with a generic name. Rigs use it as a Lake dependency.
- **Order.** It is phase 2 work with its own beads (W0 to W4). Phase 1 (Go on AArch64) does not wait for it.
- **Build of the cores.** Build Rust cores with `-Ctarget-cpu=mvp` and `-Zbuild-std`, so that the `.wasm` uses only the MVP features.

**Alternatives** (not chosen):

- Rocq: WasmCert-Coq (`LICENSE.txt` mostly MIT, some vendored directories LGPL 2.1 or later) with logsem/iriswasm (Iris-Wasm, a separation logic on WasmCert, MIT). It gives a mature semantics and a program logic. But it adds a second proof assistant and a second gatekeeper flow.
- A fork of Talos or a GPL Lean project: the licenses may not fit a public repo.
- `wasm-tools` as the decoder: it can stay as a differential-test oracle, outside the trusted base.

## R13. Where the Go engine lives

**Decision (default, owner question)**: The Go path is a Lean package in a new public repo that the owner makes. The package holds `go-elf2lean`, `go_spec`, the hook contracts and the added instructions. Each rig pins it, as it pins `arm64-semantics/`. The `substrate` proofs live in `substrate/proofs/`.

**Rationale**: Seven Go rigs use the same engine. One package gets one review of its trusted code. claude-factory does not build Lean in its CI.

**Alternatives**:

- `lean/` in claude-factory. Its CI then needs Lean and about 6 GB.
- In each rig. Seven copies of trusted code.
- A fork of code-verification. Upstream changes then need a merge.
