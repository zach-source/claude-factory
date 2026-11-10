# Feature Specification: Prove factory

**Feature Branch**: `spec/009-prove-factory`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "A new factory workflow named prove, modeled on DeepMind AlphaProof Code. A rig picks properties of its own code, proves them in Lean, and keeps the proofs checked in CI. Build it as a workflow next to `factories/lifecycle.ts`, `ship.ts` and `sweeps.ts`. The person approval steps must be decisions. Obey constitution Principle II (front-end parity)."

## Context

On 2026-11-10, DeepMind published AlphaProof Code. It is an agent framework for formal verification. The sources are:

- The blog: <https://deepmind.google/blog/introducing-alphaproof-code/>
- The paper: <https://google-deepmind.github.io/code-verification/>
- The repo: <https://github.com/google-deepmind/code-verification>

Their pipeline has these steps:

1. A spec-writer agent and the person decide what to prove. The agent writes Lean theorem statements.
2. Reviewer agents from a different model family check the statements. Vacuity checks, mutation tests and historical-bug checks test the statements.
   - A vacuity check shows that each hypothesis holds on some reachable state.
   - A mutation test injects a bug into the code. Then an agent proves the theorem false on the changed code.
   - A historical-bug check applies a known old bug again. Then an agent proves the theorem false on that code.
3. The person approves the statements. The approved commit is the baseline.
4. A gatekeeper copies the approved statements into a held-out directory that no agent can write.
5. An architect divides the proof. Team leads and prover workers prove the parts. An integrator merges the proofs.
6. A deterministic gatekeeper accepts a proof only if two checks pass:
   - The Lean kernel accepts the proof. The proof uses no `sorry` and only the standard axioms.
   - `comparator` confirms that the proof proves exactly the held-out statements.
7. A prover can propose a change to the statements (an amendment). A critic accepts it only if it is necessary, small and not weaker. Then the person approves it.

DeepMind proved properties of compiled AArch64 machine code of libsignal. Their Lean semantics loads the ELF bytes of an unmodified program that stock `rustc` builds.

The factory has no workflow that proves properties of code. The `lifecycle` workflow tests code. Tests find bugs in the cases that they run. A proof covers all inputs that the theorem names. This feature adds a `prove` workflow. A rig can then prove properties of its own code and keep the proofs checked.

### Upstream reuse and licenses (checked 2026-11-10, upstream `main` at `808b4b7ffef1`)

| Part | Where | License | Use in phase 1 |
| --- | --- | --- | --- |
| Lean AArch64 Linux semantics, `ProofLib`, `c_spec` and `rust_spec` DSLs, `rust-obj2lean` | `arm64-semantics/` in google-deepmind/code-verification | Apache-2.0 (`arm64-semantics/LICENSE`) | Yes, as a pinned Lake dependency. Its README says that downstream repos can use it as a submodule or a Lake dependency. |
| `comparator` | <https://github.com/leanprover/comparator> | Apache-2.0 | Yes, pinned. |
| `landrun` (the Landlock sandbox that `comparator` uses) | <https://github.com/Zouuup/landrun> | MIT | Yes, pinned. |
| The repo root, its scripts and its case studies | google-deepmind/code-verification | Apache-2.0 by the root README ("All code is licensed under the Apache License, Version 2.0", copyright 2026 Google LLC). The root `LICENSE` file lists only the third-party exceptions (MIT parts and the AGPL-3.0 libsignal files). GitHub cannot read a license from that file, so it shows `NOASSERTION`. | Not needed. The factory writes its own `comparator` run script. Do not copy the libsignal files: they are AGPL-3.0-only. |
| `third_party/libsignal` | same repo | AGPL-3.0-only | No. |

Result: the factory can reuse the AArch64 semantics and `comparator`. The license of each part that phase 1 uses is clear, so this is not an owner question. Neither repo has a release. Thus each rig pins a commit, not a version. The factory does not copy upstream files into this repo. Each rig that uses `prove` keeps the upstream `LICENSE` text with the dependency.

## Decisions (owner, 2026-11-10)

| Topic | Decision |
| --- | --- |
| Proof target | The proofs are about the compiled code that ships, as DeepMind did. The theorem talks about the machine code (or the WebAssembly code) that a pinned compiler makes. It does not talk about a hand-written Lean model of the code. |
| Shared pipeline | All languages use the same pipeline: spec writer, reviewers, vacuity and mutation checks, the held-out spec, the provers, and a gatekeeper with the Lean kernel and `comparator`. |
| Semantics | Reuse the DeepMind Lean AArch64 Linux semantics and `comparator`, because the licenses permit it (see the table above). |
| Languages by priority | Go and TypeScript first. Rust is supported. Python maybe. Java is a note only. |
| One target path for each language | Each language has one path to a compiled artifact (see "Target paths by language"). |
| Proven artifact | The proven artifact must be the artifact that ships. The spec names the gap for each language where this is not fully true. |
| Person steps | Each person step is a decision of the factory (a gate). The person answers it from any front end. |
| Later proof targets | A Lean model tied to the code by differential tests, and a Rust verifier (Verus, or Aeneas to Lean), are not in this spec. |

This decision replaces an earlier draft. That draft put Go and TypeScript in later work.

### Phases (owner, 2026-11-10)

| Phase | Scope | Depends on |
| --- | --- | --- |
| 1 | Go: the shared pipeline, the `prove` workflow, and the Go path on the AArch64 semantics. Pilot: `HostnamePattern.Matches` in `substrate`. Go holds most of the logic of our rigs. | The upstream AArch64 semantics and `comparator`. |
| 2 | TypeScript cores through `.wasm`. | The research on a WebAssembly semantics in Lean (it runs now). A separate spec or a spec amendment adds this phase. |
| 3 | Rust and C native (static musl `aarch64`). Python through `.wasm` or a Rust extension. | Phase 1 for Rust and C. Phase 2 for Python through `.wasm`. |
| — | Java stays a note. | — |

This spec has the full detail for phase 1 only. Phases 2 and 3 are later work. Each one gets beads under the epic, and each one is blocked until its dependency is done.

### Pilot of phase 1

The pilot is `HostnamePattern.Matches` in `substrate` (`internal/egresspolicy/egresspolicy.go`). Reasons:

- It is a pure leaf function. It does no I/O and it does not allocate: a comment in the code says that `dotSuffix` is built once "so Matches does not allocate per call".
- It is security-relevant. It decides which host names the egress policy lets out. A match bug lets traffic out.
- It has a real historical bug for the historical-bug check. Before commit `6621f2b4`, an empty host name matched a pattern with an empty exact name. The theorem must be false on that old code.
- It has a twin in Rust (`pattern_matches`), and a comment says that the two "must agree". One Lean reference matcher can serve both. Phase 3 can then prove the Rust twin against the same reference.
- It is small (11 lines), but it calls `strings.CutSuffix` and `strings.Contains`. `strings.Contains` with a one-byte string calls `internal/bytealg.IndexByteString`, which is hand-written arm64 assembly. So the pilot also tests the instruction coverage and the hook contracts.

Other Go candidates (not the pilot): the other pure parsers and matchers in `internal/egresspolicy` (for example `ParseHostnamePattern` and the CIDR checks). They allocate or return errors, so they need the `mallocgc` hook.

### Limits of the AArch64 semantics

The upstream semantics models one process with these limits:

- One thread. No threads, no concurrent memory.
- Static linking. No dynamic loader, no shared libraries at run time.
- No signals. Panic paths end in `SIGABRT`.
- User-mode AArch64 Linux, with a small set of system calls (31) and instructions (467).
- The pinned toolchain upstream: `rustc` 1.98.1, target `aarch64-unknown-linux-musl`, and Lean `v4.34.0`.

Each path below works inside these limits, or it uses a different semantics.

### Target paths by language

| Priority | Language | Target layer | The shipped artifact | Gap between the proof and the shipped artifact |
| --- | --- | --- | --- | --- |
| 1 (phase 1) | Go | Function-level proofs on the `GOARCH=arm64 CGO_ENABLED=0` proof build, on the AArch64 semantics. Runtime calls (`runtime.mallocgc`, write barriers, `morestack`, `panic`) are hooked routines with trusted contracts that the owner approves. DeepMind hooks crypto routines in the same way. The proof run uses `GODEBUG=asyncpreemptoff=1` and `GOMAXPROCS=1`. The path adds a trusted spec of the Go `ABIInternal` calling convention and of the AArch64 instructions that Go emits and that the upstream semantics does not have. | Production stays on amd64. The proof covers the arm64 binary of the same commit and the same compiler, not the shipped amd64 binary. | The arm64 to amd64 gap: the brief and the trusted base name it for each proof. The hooked runtime routines are trusted, not proved. The production binary runs with many threads and with async preemption. The proof covers one function on one goroutine. |
| 2 (phase 2) | TypeScript | bun compiles TypeScript at run time (JIT), so there is no fixed machine code. The proven core is compiled ahead of time to WebAssembly (with AssemblyScript or Rust). bun runs that same `.wasm` file in production. The proof is against a WebAssembly semantics in Lean. | The same `.wasm` file. | No mature WebAssembly semantics exists in Lean on 2026-11-10. WasmCert-Coq (Coq) and an Isabelle mechanization exist, and a small Lean package (`wasm` on Reservoir) exists. A port or new work can be necessary. bun's WebAssembly engine is trusted. The TypeScript glue that calls the `.wasm` is not proved. Alternative: a Rust native module through `bun:ffi`, on the Rust path. |
| 3 (phase 3) | Rust and C | Static musl `aarch64` code on the AArch64 semantics, as is. This path is also the base that the Go path builds on. | A static musl `aarch64` binary or object. | If the shipped form is a `cdylib` (dynamic loading) or another target, the proof does not cover it. |
| 3 (phase 3, maybe) | Python | The same idea as TypeScript: the core goes to WebAssembly, or to a Rust extension (PyO3) on the Rust path. `mypyc` output links `libpython`, so it does not fit. | The `.wasm` file or the extension. | The Python glue is not proved. The Python runtime is trusted. |
| Note only | Java | Java runs on a JIT. Only a GraalVM `native-image` binary can fit, and its runtime has a garbage collector and threads. | — | No work planned. |

A path fits a pure function with no I/O best: a parser, a matcher, a policy decision, an encoder.

### Rigs and target paths (checked 2026-11-10)

| Path | Rigs | Code that can fit |
| --- | --- | --- |
| Go | `substrate`, `blocks-operator`, `beveil` and four other rigs (seven Go rigs) | Leaf pure functions. Example: `HostnamePattern.Matches` in `substrate` (`internal/egresspolicy`). |
| TypeScript | `claude-factory`, `fabriek`, `sluis`, and the TypeScript parts of two Go rigs | A pure core that moves to WebAssembly. Example: a rule check in `src/machine.ts` (`validate`). |
| Rust and C | `substrate` (the Envoy egress-policy crate), `stek` (the `validate` crate) | `pattern_matches`, `transport_verdict` and `tls_verdict` in `substrate`. `pattern_matches` is the Rust twin of the Go `HostnamePattern.Matches`: a comment in the code says that the two must agree. The `stek` crate uses `tokio` with many threads and the network. Only a pure helper in a crate of its own can fit. |
| Python (maybe) | `stek` and three config rigs | Not checked. The config rigs hold Nix, manifests and scripts, with no core to prove. |
| Java | none | — |

The full list of rig names is in the factory home (`rigs.json`). This table names a rig only if its name is public.

## Clarifications

### Session 2026-11-10

- Q: What are the proofs about: a Lean model of the code tied to it by differential tests, a Rust verifier (Verus, or Aeneas to Lean), or the compiled code? → A: The compiled code that ships, as DeepMind did (owner, 2026-11-10). The factory reuses the upstream Lean AArch64 Linux semantics (Apache-2.0) and `comparator` (Apache-2.0, with `landrun`, MIT). The Lean model and the Rust verifier are not in this spec.
- Q: Which languages, and in which order? → A: Go and TypeScript first, Rust supported, Python maybe, Java a note only (owner, 2026-11-10). Each language has one target path. The proven artifact must be the artifact that ships, and the spec names each gap. See "Target paths by language".
- Q: Which language path is phase 1? → A: Go, because Go holds most of our logic (owner, 2026-11-10). Phase 1 proves functions of the `GOARCH=arm64 CGO_ENABLED=0` proof build on the AArch64 semantics. Runtime calls are hooked with contracts that the owner approves. Production stays on amd64, and the spec names that gap. Phase 2 is TypeScript cores through `.wasm`. Phase 3 is Rust and C native, and Python through `.wasm`. Java stays a note. Pilot (recommended): `HostnamePattern.Matches` in `substrate`. See "Pilot of phase 1".

## User Scenarios & Testing _(mandatory)_

### User Story 1 - The person and an agent decide what to prove (Priority: P1)

The person starts `prove` on a rig. A spec-writer agent reads the rig's code. It proposes a short list of properties. For each property it gives the function, a plain-English statement and a draft Lean theorem about the compiled machine code. The person picks the properties, or asks for changes. The spec-writer agent then writes the theorem statements in the rig's proof directory.

**Why this priority**: A proof is only as good as the statement. A wrong statement gives a proof that means nothing. The person must own what the factory proves.

**Independent Test**: Start `prove` on the `substrate` rig. The run stops at a decision. The decision lists properties of `HostnamePattern.Matches`. The person answers from the CLI. The run continues with the picked properties only.

**Acceptance Scenarios**:

1. **Given** a rig with Go code that fits the phase 1 path. **When** the person starts `prove`. **Then** the run stops at the decision "pick properties". The decision shows each property, its function and its draft statement.
2. **Given** that decision, **When** the person answers it from any front end, **Then** the core records the answer. The run continues with the same result in all four front ends.
3. **Given** a rig with no code that fits a path of this spec. **When** the person starts `prove`. **Then** the run ends with the reason "no code fits". It names the limit that each part of the code breaks.

---

### User Story 2 - Agents and checks attack the statements before approval (Priority: P1)

Before the person approves the statements, the factory tests them:

- Reviewer agents from a different model family than the spec writer look for statements that are weak, wrong or too strong.
- A vacuity check gives, for each theorem, a witness: a concrete input that makes all hypotheses true.
- A mutation test injects a bug into the function. Then it proves that the theorem is false on the changed machine code.
- A historical-bug check applies each known old bug again (from the rig's git history or beads). Then it proves that the theorem is false on that code.

The factory shows all results to the person in one brief.

**Why this priority**: These checks find a statement that says nothing (vacuous) or a statement that a bug does not break (too weak). The person cannot find these by reading alone.

**Independent Test**: Give the factory a statement with a false hypothesis. The vacuity check fails. The brief names the theorem and the hypothesis. Give a statement that a mutation does not break. The mutation test fails. The brief names the mutation.

**Acceptance Scenarios**:

1. **Given** draft statements. **When** the review step runs. **Then** each theorem has a vacuity witness and at least one mutation result. Each theorem also has a result for each known historical bug of that function. The Lean kernel checks each result.
2. **Given** a theorem with no vacuity witness, or a mutation that the theorem does not catch. **When** the review ends. **Then** the run goes back to the spec writer with the finding. It does not go to approval.
3. **Given** that all checks pass, **When** the review ends, **Then** the run stops at the decision "approve statements". The brief shows the statements, the reviewer findings, the witnesses and the mutation and historical-bug results.

---

### User Story 3 - The approved statements are frozen (Priority: P1)

The person approves the statements. The factory records the approval with the commit and a hash of each statement file. The factory copies the statements to a held-out location. No agent of the run can write to it. All later checks compare against the held-out copy, not against the worker's copy.

**Why this priority**: If a prover can change the statement, it can make the statement easy to prove. The proof then means nothing.

**Independent Test**: After approval, a prover worker changes a statement file in its worktree. The gatekeeper refuses the proof. It names the changed theorem.

**Acceptance Scenarios**:

1. **Given** an approval. **When** the core records it. **Then** the record holds the person, the time and the commit. It also holds a hash of each statement file.
2. **Given** a frozen spec, **When** a worker tries to write to the held-out location, **Then** the factory refuses the write.
3. **Given** a frozen spec, **When** a worker changes a statement in its worktree, **Then** the gatekeeper fails. The gatekeeper names the changed theorem.

---

### User Story 4 - Agents prove the statements (Priority: P1)

An architect agent divides each theorem into lemmas. It writes the plan of the proof. Team lead agents own a group of lemmas. They try to disprove a lemma before they assign it.

Prover workers prove one lemma each. An integrator merges the proofs into the proof library. It removes duplicate lemmas. The integrator is the only role that commits to the run's branch.

**Why this priority**: This is the work that makes the proof. It is P1 with the statements and the gatekeeper, because each one alone gives no value.

**Independent Test**: Run `prove` on one approved theorem of `substrate`. The run ends with a proof that the gatekeeper accepts, with no step that the person does by hand.

**Acceptance Scenarios**:

1. **Given** a frozen spec, **When** the architect step ends, **Then** the plan lists each lemma, its owner and its dependencies.
2. **Given** a lemma that a prover cannot prove after its retries. **When** the retries end. **Then** the team lead gets the lemma back. It can divide it again, or propose an amendment (User Story 6).
3. **Given** two provers on the same proof file. **When** both start. **Then** only one of them can edit that file at a time.

---

### User Story 5 - A deterministic gatekeeper accepts the proof (Priority: P1)

The gatekeeper is a command, not an agent. It sees only file paths and theorem names. It does not read the provers' text or reports. It accepts a proof only if all of these are true:

- The pinned compiler builds the code again, and the bytes are the same as the bytes in the proof.
- The Lean kernel checks every proof in a fresh environment.
- No proof uses `sorry`, `native_decide`, or an axiom other than the standard Lean axioms (`propext`, `Quot.sound`, `Classical.choice`).
- `comparator` confirms that each theorem and its definitions are equal to the held-out copy.

**Why this priority**: The gatekeeper is the reason to trust the result. An agent can be wrong or can be misled. The kernel and `comparator` are the trusted parts.

**Independent Test**: Give the gatekeeper four bad proofs. They are these: one with `sorry`, one with a new axiom and one that proves a weaker theorem. The fourth is for old machine code. It refuses each one and gives the reason. Give it a good proof. It accepts it.

**Acceptance Scenarios**:

1. **Given** a proof with `sorry` or a new axiom, **When** the gatekeeper runs, **Then** it fails and names the theorem and the axiom.
2. **Given** a proof of a theorem that is not equal to the held-out copy. **When** the gatekeeper runs. **Then** `comparator` fails. The gatekeeper names the theorem.
3. **Given** a good proof, **When** the gatekeeper runs, **Then** it passes. The run makes a pull request with the statements, the proofs, the pinned dependencies and a CI job. The run hands the pull request to the rig's `ship` run.
4. **Given** the gatekeeper result. **When** the person looks at any front end. **Then** the result and its reason are the same in all four front ends.

---

### User Story 6 - A prover proposes an amendment (Priority: P2)

A prover finds that a statement is false for the real code, or that it cannot be proved as written. The prover proposes an amendment. A critic agent reviews it. The critic does not see the proof attempts. The critic accepts the amendment only if all of these are true:

- It is necessary. A machine-checked disproof, a counterexample or a code-based argument shows the need.
- It is small.
- It is not weaker. Each new hypothesis holds of the real code. The amendment keeps the vacuity witnesses.

If the critic accepts, the run stops at the decision "approve amendment". If the person approves, the factory applies the amendment to the held-out copy and records it. If an amendment makes the statement weaker so that it fits the code, the critic refuses it. The factory files a bead on the rig: the code can have a bug.

**Why this priority**: Real code often differs from the first statement. Without this step, a run stops for good, or a prover weakens the statement in secret. It is P2 because phase 1 can stop the run and ask the person instead.

**Independent Test**: A prover proposes an amendment that adds a false hypothesis, and the critic refuses it. A prover proposes a necessary, small amendment, and the critic accepts it. The run stops at the decision. The person approves it. The held-out copy changes, and the record names the person.

**Acceptance Scenarios**:

1. **Given** an amendment that is weaker, **When** the critic reviews it, **Then** the critic refuses it. The factory files a bead with the counterexample.
2. **Given** an accepted amendment, **When** the person approves the decision, **Then** the factory changes the held-out copy. It records the amendment, the reason, the critic's result and the person.
3. **Given** an accepted amendment, **When** the person refuses the decision, **Then** the held-out copy does not change. The run goes back to the team lead.

---

### User Story 7 - CI keeps the proofs checked (Priority: P1)

After the pull request merges, the rig's CI runs the gatekeeper on each pull request and on the default branch. If a code change breaks a proof, CI fails. A sweep of the factory sees the failed check. It files a bead and queues a `prove` run at the repair station. The repair run proves the theorem again for the new machine code. It does not change the approved statements without an amendment decision.

**Why this priority**: A proof of old code has no value. The proof must follow the code, or the check must fail.

**Independent Test**: Change one line of a proved function in a test branch. CI fails and names the theorem. The factory files a bead and queues a repair run.

**Acceptance Scenarios**:

1. **Given** proofs on the default branch. **When** a pull request changes a proved function. **Then** CI runs the gatekeeper. CI fails if the proof does not hold for the new machine code.
2. **Given** a failed proof check on the default branch. **When** the next sweep runs. **Then** the factory files one bead (not one bead per run of the sweep). It queues one repair run.
3. **Given** a change that does not touch a proved function, **When** CI runs, **Then** the proof check passes.

---

### User Story 8 - The person sees and answers prove decisions from any front end (Priority: P2)

The person sees the prove run, its station, its decisions and its gatekeeper results. The views are the web UI, the CLI, the Claude mod and the Herdr mod. The person answers the decisions "pick properties", "approve statements" and "approve amendment" from any of them. The core owns the decision and its rules.

**Why this priority**: Constitution Principle II requires it. It is P2 because the existing gate operations already reach the four front ends. This story makes sure that the prove decisions use them with no logic in a front end.

**Independent Test**: Stop a run at "approve statements". Open each front end. Each front end shows the same brief. Answer from the Herdr mod. The CLI shows the answer.

**Acceptance Scenarios**:

1. **Given** a prove decision. **When** each front end opens. **Then** it shows the decision through the core's decision and gate operations.
2. **Given** a worker or a patrol, **When** it tries to answer a prove decision, **Then** the core refuses it.

### Edge Cases

- The rig's code changes while a run proves it. The gatekeeper builds the code at the run's commit. If the default branch has moved, the run rebases. Then the gatekeeper runs again.
- The pinned toolchain is not on the runner. The gatekeeper fails with "toolchain missing". It does not skip the check.
- The gatekeeper needs Linux: `comparator` uses Landlock. A laptop on macOS cannot run it. The gatekeeper then runs on a Linux runner. If no Linux runner is free, the run waits. It does not pass.
- A full upstream build needs about 25 GiB of memory and about 40 minutes on 12 cores. The core libraries need about 6 GB and about 15 minutes. A runner with less memory fails with "out of memory". It does not pass.
- The proof is large. A run that uses all of its budget (steps or tokens) stops at a decision. It does not merge part of a proof as complete.
- A historical bug is not in the code's history. The brief says "no historical bug found for this function". This is not a failure.
- Two `prove` runs on the same rig change the same proof library. Only one `prove` run on a rig can be at the integrate or gatekeeper station at a time.
- The upstream semantics has a bug. A proof that the kernel accepts can be false for the real CPU. The brief names the trusted base: the semantics, the hooked routines and the compiler pin. The person then knows what the proof trusts.

## Requirements _(mandatory)_

### Functional Requirements

**Workflow**

- **FR-001**: The factory MUST have a workflow named `prove` in `factories/prove.ts`. It MUST use the same factory model (stations, edges, gates) as `lifecycle`, `ship` and `sweeps`.
- **FR-002**: The workflow MUST have stations for these roles:

  - spec writer
  - reviewer
  - spec checks (vacuity, mutation, historical bug)
  - architect
  - team lead
  - prover
  - integrator
  - critic
  - gatekeeper
  - repair
- **FR-003**: A rig MUST be able to start `prove` on a bead (`factory:prove`) and at a station (`prove@repair`), as with other workflows.
- **FR-004**: The workflow MUST refuse code that does not fit a path that the factory has. It MUST name the limit that the code breaks (threads, dynamic linking, signals, JIT, I/O, an unsupported target or language).
- **FR-004a**: Phase 1 MUST support the Go path: function-level proofs on the `GOARCH=arm64 CGO_ENABLED=0` proof build of the same commit and compiler as production.
- **FR-004b**: The Go path MUST have a trusted spec of the Go `ABIInternal` calling convention for arm64.
- **FR-004c**: The Go path MUST hook the runtime calls (`runtime.mallocgc`, the write barriers, `runtime.morestack`, `runtime.gopanic` and the panic entry points) with contracts. The owner MUST approve each contract with a decision before a proof can use it.
- **FR-004d**: The Go path MUST add the AArch64 instructions that the Go compiler and the Go runtime assembly emit and that the upstream semantics does not have. Each added instruction MUST pass differential tests against the upstream test tools (Unicorn, Sail or `qemu-aarch64`), as the upstream instructions do.
- **FR-004e**: The proof run MUST use `GODEBUG=asyncpreemptoff=1` and `GOMAXPROCS=1`.
- **FR-004f**: The brief and the trusted base of each Go proof MUST name the gap: production runs the amd64 binary, and the proof covers the arm64 binary.

**Decisions**

- **FR-005**: "Pick properties", "approve statements" and "approve amendment" MUST be gates of the core. Only the person can answer them. The core MUST refuse an answer from a worker or a patrol.
- **FR-006**: Each prove decision MUST have a brief from the core. The "approve statements" brief MUST show the statements, the reviewer findings, the vacuity witnesses, the mutation results, the historical-bug results and the trusted base.
- **FR-007**: The core MUST record each approval with the person, the time, the commit and a hash of each statement file.

**Spec checks**

- **FR-008**: The reviewer station MUST use a model family other than the spec writer's model family.
- **FR-009**: Each theorem MUST have a vacuity witness that the Lean kernel checks.
- **FR-010**: Each theorem MUST have at least one mutation test. A mutation test MUST change the code and build it with the pinned compiler. It MUST prove the theorem false on the new machine code.
- **FR-011**: The factory MUST look for historical bugs of each proved function in the rig's git history and beads. For each one that it finds, it MUST prove the theorem false on the code with that bug.
- **FR-012**: A failed spec check MUST send the run back to the spec writer. It MUST NOT go to approval.

**Held-out spec**

- **FR-013**: After approval, the factory MUST keep a copy of the statements in a location that no worker can write.
- **FR-014**: The gatekeeper MUST compare the proof with the held-out copy and with the hashes in the approval record. It MUST NOT trust the worker's copy.
- **FR-015**: Only an approved amendment decision can change the held-out copy.

**Proof**

- **FR-016**: The architect MUST write a plan that lists each lemma, its owner and its dependencies.
- **FR-017**: Only one worker MUST edit a proof file at a time.
- **FR-018**: Only the integrator role MUST commit to the run's branch.

**Gatekeeper**

- **FR-019**: The gatekeeper MUST be a deterministic command. No agent can decide its result. It MUST see only file paths and theorem names.
- **FR-020**: The gatekeeper MUST pass only if all of these pass:

  - A fresh build of the code gives the same bytes.
  - The Lean kernel checks all proofs in a fresh environment.
  - No proof uses `sorry`, `native_decide` or an axiom other than `propext`, `Quot.sound` and `Classical.choice`.
  - `comparator` confirms each theorem against the held-out copy.
- **FR-021**: If the gatekeeper fails, it MUST name the theorem and the failed check.
- **FR-022**: The gatekeeper MUST be the same command in a run and in the rig's CI.

**Amendment**

- **FR-023**: A prover MUST be able to propose an amendment with its reason and its evidence.
- **FR-024**: The critic MUST NOT see the proof attempts. It MUST accept an amendment only if it is necessary, small and not weaker.
- **FR-025**: If an amendment is weaker, the critic MUST refuse it and the factory MUST file a bead that says the code can have a bug.

**CI and repair**

- **FR-026**: The pull request of a run MUST add a CI job to the rig that runs the gatekeeper on each pull request and on the default branch.
- **FR-027**: A sweep MUST find a failed proof check on a rig's default branch. It MUST file one bead and queue one `prove@repair` run.

**Upstream**

- **FR-028**: The rig MUST pin the upstream semantics, `comparator` and `landrun` at fixed commits, with their license text.
- **FR-029**: The factory MUST NOT copy AGPL-3.0 files from the upstream repo.

**Front ends**

- **FR-030**: Every prove operation and decision MUST be an operation of the core. All four front ends MUST get them through the core interface (constitution Principle II). If a front end cannot show a part, the change MUST file a bead for that gap and name it in the PR.

### Key Entities

- **Property**: a plain-English claim about one function. It has the function, the rig and the reason to prove it.
- **Statement**: a Lean theorem about the compiled machine code of a function. It has a file path and a theorem name.
- **Spec check result**: the result of a vacuity, mutation or historical-bug check. It has the theorem, the kind, the input or the mutation, and the kernel result.
- **Approval record**: the person, the time, the commit and a hash of each statement file.
- **Held-out spec**: the frozen copy of the approved statements, outside every worker's reach.
- **Proof plan**: the lemmas, their owners and their dependencies.
- **Amendment**: a proposed change to a statement, with its reason, its evidence, the critic's result and the person's decision.
- **Gatekeeper result**: pass or fail, with the failed theorem and check.
- **Trusted base**: what the proof trusts: the semantics commit, the hooked routines, the compiler pin and the standard axioms.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: One property of `HostnamePattern.Matches` in `substrate` is proved on its arm64 proof build, checked by the gatekeeper and merged with a CI job. The person does no step by hand other than the decisions.
- **SC-002**: The gatekeeper refuses 100% of a set of bad proofs (`sorry`, a new axiom, a weaker theorem, old machine code, a changed statement) and accepts the good proof.
- **SC-001a**: The theorem of the pilot is proved false on the code before commit `6621f2b4` (the historical-bug check).
- **SC-003**: Each approved theorem has a vacuity witness and at least one mutation test that the Lean kernel checks.
- **SC-004**: After a change to a proved function, CI fails in the same pull request, and the factory files one bead and queues one repair run.
- **SC-005**: The person answers each prove decision from each of the four front ends, and the core gives the same result.
- **SC-006**: No worker can change the held-out spec. A test that tries it from a worker fails 100% of the time.

## Assumptions

- The upstream `subroutine_ok` and the separation-logic predicates can state a contract for a Go function under `ABIInternal`. The upstream DSLs are for C and Rust only, so a Go surface is new trusted code. The plan must confirm this with a small case first.
- The Go toolchain version is the version in the rig's `go.mod` (`go 1.27.0` in `substrate` on 2026-11-10). The proof pins it.
- The rig's proof code lives in the rig's repo, in one directory (for example, `proofs/`), as a Lake package.
- A Linux runner with at least 16 GB of memory is available to the factory. A laptop on macOS cannot run `comparator`.
- The existing gate and decision operations of the core (`gates.decide`, `gates.brief`, `decisions.list`, `decisions.answer`) are enough for the prove decisions. Spec 008 already makes them reach all front ends.
- The upstream semantics is correct for the code that phase 1 proves. The brief names it as trusted.

## Dependencies

- Spec 008 (front-end parity): the core interface and the gate operations.
- google-deepmind/code-verification `arm64-semantics/` (Apache-2.0), `comparator` (Apache-2.0) and `landrun` (MIT).
- Lean `v4.34.0` through elan. The Go toolchain of the rig (`GOARCH=arm64`). `rustc` 1.98.1 to build the upstream tools.
- The `ship` workflow for the pull request and the merge. The person merges.
- The `sweeps` workflow for the proof check on the default branch.

## Out of Scope

- A Lean model of the code tied to it by differential tests. Later step, for Go and TypeScript rigs.
- A Rust verifier (Verus, or Aeneas to Lean). Later step.
- Phase 2 (TypeScript through `.wasm`) and phase 3 (Rust and C native, Python). This spec lists them and the epic has beads for them, but they need their own spec work.
- A proof of the amd64 binary that production runs. There is no x86-64 semantics.
- Proofs about the shipped `cdylib` that Envoy loads (dynamic linking).
- Threads, signals, dynamic linking and async code. These wait for upstream support.
- Proofs about a protocol or a security game (as DeepMind did for Signal). Phase 1 proves function contracts.
- Changes to the upstream semantics. The factory reports an upstream bug. It does not fix it in this repo.
