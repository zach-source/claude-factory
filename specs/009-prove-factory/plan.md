# Implementation Plan: Prove factory

**Branch**: `spec/009-prove-factory` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-prove-factory/spec.md`

## Summary

Add a workflow `factories/prove.ts` next to `lifecycle`, `ship` and `sweeps`. It follows the AlphaProof Code pipeline:

- A spec writer and the person pick properties.
- A reviewer of a different model family, vacuity witnesses, mutant disproofs and historical-bug disproofs test the statements.
- The person approves. The core freezes the statements.
- An architect, team leads, provers and an integrator prove them.
- A deterministic gatekeeper (the Lean kernel and `comparator`) accepts the proof.

The factory model gets three node fields:

- `ciCheck`: a station with no worker that reads a CI check.
- `freeze`: a gate that writes the approval record and the held-out copy.
- `heldout`: compares the rig's record with the core's record.

The gatekeeper is one script in the rig. The rig's CI runs it on Linux.

Phase 1 is Go. It proves functions of the `GOARCH=arm64 CGO_ENABLED=0` proof build on the DeepMind AArch64 semantics. A Go engine package adds the Go ABI, the Go linker output, the runtime hook contracts and the missing instructions. The pilot is one pure Go function in the owner's main private Go rig. Its private bead names it. `HostnamePattern.Matches` in `substrate` is the second target. Proof work runs on AX workers with a `prove` image (Lean `v4.34.0` and a Lake cache). A setting, `prove.max-sessions`, limits the active prove runs. Each runtime contract and each exact-proof part gets its own owner decision. Phases 2 (TypeScript through `.wasm`) and 3 (Rust and C native, Python) are beads that stay blocked.

## Technical Context

**Language/Version**: TypeScript on Bun (the factory, as today). Lean `v4.34.0` (the rig's proofs and the Go engine). Go from the rig's `go.mod` (`go 1.27.0` in `substrate`).

**Primary Dependencies**: none new in claude-factory. In the rig, the dependencies are these. `arm64-semantics/` of google-deepmind/code-verification at a pinned commit. `leanprover/comparator` and `lean4export` at `v4.34.0`. `landrun` at a pinned commit. The Go engine package at a pinned commit.

**Storage**: the factory home files. New paths are `<factory home>/proofs/<run id>/approvals.jsonl` and `heldout/`.

**Testing**: `bun test --timeout 30000 src factories`, `bunx tsc --noEmit`, prettier. In the rig: `proofs/gate.sh` and its bad-case tests. In the Go engine: `lake build` and the differential tests against `qemu-aarch64` and Unicorn.

**Target Platform**: the factory on the laptop or on AX, as today. The gatekeeper runs on a Linux CI runner (`ubuntu-latest`).

**Project Type**: a workflow and three core features in the factory, a template for the rig, and a Lean package.

**Performance Goals**: `prove-gate` finishes in under 30 minutes on `ubuntu-latest` (4 vCPU, 16 GB) with a warm `.lake` cache. The upstream core build alone takes about 15 minutes and about 6 GB.

**Constraints**:

- The gatekeeper is not an agent (FR-019). The runner reads a CI check.
- `comparator` needs Linux (Landlock).
- claude-factory is public. No private names in a commit. The `guard-private` hook must pass.
- This spec does not change the cluster, `f-manager` or a rollout.

**Scale/Scope**: 16 stations, 3 node fields, 1 new read operation, 3 new settings, 1 sweep change, 1 rig template, 1 image target, 1 Lean package. Pilot: one function of about 6 lines.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle | Check | Result |
| --- | --- | --- |
| I. Worker Parity | The stations use the shared rules and skills. `review` and `critic` set `agent` to Codex, as `lifecycle` does for some stations. The held-out guard is in `src/worker-hook.ts`, which all backends use. The Codex `apply_patch` path (`applyPatchReason`) gets the same deny. The hash check of R4 does not depend on a backend. | Pass |
| II. Front-end Parity | The prove decisions use `decisions.list`, `gates.brief` and `gates.decide`, which reach the four front ends (spec 008). The new `proofs.show` goes into the catalog. Each front end gets it through its generic view. If a front end cannot show it, the change adds a gap entry and a bead. No front end holds prove logic. | Pass |
| Governance | The PR names each gap. | Pass |

Re-check after Phase 1: pass. The freeze, the hash compare and the CI read are in the core and the runner. No front end decides a prove gate.

## Reconciliation with specs 008, `ship` and `sweeps`

| Existing part | Use in this feature | Change |
| --- | --- | --- |
| Spec 008 gate operations | The `choose`, `approve` and `amend` gates | `gates.decide` writes the record for a `freeze` node. `gates.brief` adds the prove facts. |
| `ship` workflow | `gatekeep` passes into a `ship` edge. `ship` owns the release, the wait for the person's merge, and the rest. | None. |
| `sweeps` `ci` station | Finds a red `prove-gate` on the default branch. | The label is `station:repair` and `factory:prove` for `prove-gate`. |
| `mergeCheck` and `awaitsPr` | The model for `ciCheck`. | None. |

## Project Structure

### Documentation (this feature)

```text
specs/009-prove-factory/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/prove.md
└── checklists/requirements.md
```

### Source Code (repository root)

```text
src/machine.ts            # ciCheck, freeze, heldout: types, validate(), compile
src/machine.test.ts       # validate() refusals and walks for the new fields
src/cli.ts                # runner: ciCheck read, heldout compare; gates.decide freeze; approvals store
src/core/catalog.ts       # proofs.show
src/core/ops/proofs.ts    # proofs.show
src/worker-hook.ts        # deny writes to <factory home>/proofs/*/heldout
factories/prove.ts        # the workflow
factories/prove.test.ts   # walks each station and edge
factories/sweeps.ts       # ci: prove-gate goes to station:repair
templates/prove/          # the rig template: lakefile.lean, gate.sh, comparator.json, prove-gate.yml, LICENSE-upstream
```

The Go engine is a Lean package in its own repo (research.md R13; owner question). The pilot's proofs are in `proofs/` of the main private Go rig.

## Delivery

Phase 1, in order. Each slice is one bead and one pull request.

| Slice | Where | Work | Depends on |
| --- | --- | --- | --- |
| E0 | Go engine | Build the upstream core at the pinned commit on `ubuntu-latest`. Prove a small Rust subroutine as upstream does. Measure the time and the memory. | Owner answer R13 |
| E1 | Go engine | Disassemble the pilot and each routine that it calls. List the instructions that the upstream semantics does not have. Decide: add `IndexByteString` instructions, or hook it. | E0 |
| E2 | Go engine | `go-elf2lean`: a Go function from the linked ELF into a Lean module, on `PlacedLib.LinkedIn`. | E0 |
| E3 | Go engine | `go_spec`: the `ABIInternal` arm64 surface and the stack-check precondition. Prove `func add(a, b int) int`. | E2 |
| E4 | Go engine | The panic hook contracts. The added instructions with differential tests against `qemu-aarch64` and Unicorn, with `GODEBUG=asyncpreemptoff=1` and `GOMAXPROCS=1`. | E1, E3 |
| F1 | claude-factory | `ciCheck`, `freeze` and `heldout` in `src/machine.ts`, with `validate()` rules and tests. | — |
| F2 | claude-factory | The runner: the `ciCheck` read, the `heldout` compare, the `freeze` on `gates.decide`, the approvals store, and the worker-hook deny. | F1 |
| F3 | claude-factory | `proofs.show` in the catalog. The front ends through their generic views. The prove facts in `gates.brief`. | F2 |
| F4 | claude-factory | `factories/prove.ts` and `factories/prove.test.ts`: the stations, the prompts and the child-bead flow. | F1 |
| F5 | claude-factory | `templates/prove/`: `gate.sh` with draft mode, `comparator.json`, `prove-gate.yml`, `lakefile.lean`. A test with the bad cases of quickstart step 2. | E3, F4 |
| F6 | claude-factory | The `ci` sweep: `prove-gate` goes to `station:repair`. | F4 |
| F7 | claude-factory | The settings `prove.max-sessions`, `prove.image` and `prove.sandbox-class` in `src/settings.ts`. `room()` counts the active prove runs (research.md R15). Prove runs use the prove image and sandbox class. | F4 |
| F8 | claude-factory | One decision for each part: the `part` station, the child bead for each part in `proofs/parts.json`, the refusal of the `approve` freeze while a part is open, and the rig bead for an exact-proof part (research.md R16). | F2, F4 |
| I1 | claude-factory | The `prove` target of `Dockerfile.worker` (research.md R14). Build it, and record the size of each layer. Check Landlock in the Kata guest. The owner pushes and rolls the image. | E0 |
| P1 | main private Go rig | The pilot run on the function that its bead names. The person makes the decisions, one for each part, and merges. | E4, F2, F3, F5, F6, F7, F8, I1 |
| P2 | main private Go rig | Break the function on a test branch. Show SC-004. | P1 |

Phase 2 base: the Lean 4 WebAssembly semantics (research.md R12). It lives in its own repo with a generic name. Rigs use it as a Lake dependency. It does not wait for phase 1, and phase 1 does not wait for it.

| Slice | Where | Work | Depends on |
| --- | --- | --- | --- |
| W0 | owner | Make the repo with a generic name (default `lean-wasm-semantics`). | — |
| W1 | Wasm repo | Evaluate argumentcomputer/Wasm.lean and linobit-corp/wasm-lean (both MIT). Pick a fork or a new build. Read only the public docs of the AGPL and GPL projects. Copy no code from them. | — |
| W2 | Wasm repo | The executable semantics: Wasm 2.0 MVP plus bulk memory and sign extension. A runs-to relation with partial and total forms, in the style of `ElfRunsTo`. | W0, W1 |
| W3 | Wasm repo | The decoder for the same subset, in Lean. `wasm-tools` is a test oracle only. | W2 |
| W4 | Wasm repo | The gate before any proof: differential tests against the WebAssembly/spec reference interpreter and the official testsuite for the subset, in CI. | W3 |

Later work. Each bead stays blocked until its dependency is done:

| Bead | Work | Blocked by |
| --- | --- | --- |
| L2 | Phase 2: the `wasm` path in `prove` for TypeScript cores, with bun running the same `.wasm` | W4, F4, F5 |
| L3 | Phase 3: the Rust and C native path (static musl `aarch64`), with `pattern_matches` as its pilot against the same Lean reference matcher | P1 |
| L4 | Phase 3 (maybe): Python through `.wasm` or a PyO3 extension | L2 |

Java stays a note in the spec. It gets no bead.

## Rollout

1. F1 to F6 merge with no rig that uses them. The new fields change no current workflow. The tests show it.
2. E0 to E4 merge in the Go engine repo.
3. The owner pushes the `prove` image and sets `prove.image`.
4. P1 runs on the main private Go rig only. The person merges the pilot pull request.
5. After P2, a second Go rig can start `prove`. The second target is `HostnamePattern.Matches` in `substrate`. Forked repos are out of scope.

## Open owner questions

1. Where does the Go engine live? Default: a new public repo in the owner's GitHub org, with a generic name, that the owner makes (research.md R13). Other choices: `lean/` in claude-factory, or a copy in each rig.
Answered on 2026-11-10: the hook contracts and the exact-proof parts get one decision for each part (research.md R16). The Wasm repo is in the owner's GitHub org, with a generic name.

## Complexity Tracking

| Addition | Why it is necessary | Simpler choice and why it is not enough |
| --- | --- | --- |
| `ciCheck` node field | FR-019: no agent can decide the gatekeeper result. | A worker that runs `gate.sh` and reports: an agent then reports the result. |
| `freeze` and `heldout` | FR-013 and FR-014: a worker must not change the approved statements. | A path guard only: a shell command can bypass it. |
| A Go engine package | Go is not in the upstream DSLs (C and Rust only). | Wait for upstream Go support: no plan for it exists. |
