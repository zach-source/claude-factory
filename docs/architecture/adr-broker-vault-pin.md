# ADR: Pin the worker vault in the broker

## Context

Bead: `claude-factory-lntv`. Base: `42254bcd`.
No tracked CLAUDE.md, AGENTS.md, or CONTRIBUTING file exists in this checkout.
The broker accepts every vault name that matches `[a-z0-9-]+` at `src/broker.ts:145`.
Its config has no vault setting at `src/broker.ts:90`.
Reviewer rules bypass the generic walk at `src/broker.ts:253`.
The request handler checks key-to-host pins separately at `src/broker.ts:432`.
The actual agent-vault grants remain unverified. This change supplies defense in depth without a live grant probe.

## Decision

Read `FACTORY_AX_VAULT` from the trusted broker environment into Config.
Pass this value explicitly from `handle` to `workerPolicyRefusal` as an optional argument.
Apply the same constraint to generic credentials, reviewer API rules, and reviewer Git rules.
Keep the optional argument absent for current local callers in `src/ax.ts`.
Do not read a vault choice from the request or from process.env inside the validator.

The fail-closed rule is: every recognized credential URI must have valid syntax and the configured vault, when present.
Compare the complete vault segment as exact text. Do not decode, normalize, trim, or match a prefix.
An absent or empty config value preserves the current alphabet-only check.
A nonempty config value must match `[a-z0-9-]+` in full; otherwise configFrom must throw before service startup.
This deliberately retains the current acceptance of `-` as a vault name.

Use the existing regular expressions and a small shared comparison, if necessary.
Keep the code in `src/broker.ts`; Dockerfile.broker copies that file alone.
No new dependency, framework, flag, or complete EgressPolicy parser is necessary.

Closed credential grammar:

- URI: exactly `ate-secret://agent-vault/<vault>/<KEY>`; vault is `[a-z0-9-]+`, key is `[A-Z][A-Z0-9_]*`.
- No extra segment, query, fragment, percent escape, whitespace, Unicode, or trailing newline is valid.
- Credential location: `rules[i].https.effects.replaceHeaders[j].credentialUri` only.
- A keyed rule has only `https`; its fields are `hostnames`, optional `ports`, `pathPrefixes`, `paths`, and `effects`.
- `effects` has only `replaceHeaders`; each header entry has only `header`, `prefix`, and `credentialUri`.
- Preserve the existing field type checks, key-to-host pins, manager-key exclusions, and recursive alias checks.
- Reviewer API fields are exactly `hostnames`, `pathPrefixes`, `paths`, and `effects`.
- Its hosts are a nonempty subset of `api.github.com` and `uploads.github.com`.
- Its single prefix is `/repos/<owner>/<repo>/`; each segment matches `[A-Za-z0-9_.-]+`, except `.` and `..`.
- Its exact paths list is `['/graphql']`.
- Its one header has exactly `header: Authorization`, `prefix: 'Bearer '`, and the `GITHUB_REVIEWER` credential URI.
- Reviewer Git fields are exactly `hostnames` and `effects`, with hosts exactly `['github.com']`.
- Its one header has exactly `header: Authorization`, `prefix: 'Basic '`, and the `GITHUB_REVIEWER_BASIC` credential URI.
- The Git rule needs the API rule. Each reviewer rule can occur once. Their vault checks have no exception.

Refuse every other credential form before any downstream command. Preserve the existing grammar for unkeyed rules.
This is a constraint on credential references, not a redesign of all policy fields.
Out of scope: arbitrary secret text outside credential fields, caller authentication, reviewer identity, and agent-vault grants.
Related beads `claude-factory-ngu0v`, `claude-factory-w3dpb`, and `claude-factory-mzoy` cover separate boundaries.

Rejected alternatives:

- A fixed vault name in source cannot serve deployments with different vault names.
- A vault name from the manager request does not establish a trusted constraint.
- A required setting breaks current deployments before the owner can supply the value.
- A generic-walk-only check misses the reviewer rules.
- Agent-vault grants alone leave the broker dependent on another access boundary.

## Acceptance criteria

### AC1: Trusted configuration and compatibility

Add tests named `lntv AC1` in `src/broker.test.ts`.
Prove configFrom retains `acme-vault`, treats absent and empty values as unpinned, and rejects invalid nonempty values.
Invalid rows: space, leading or trailing whitespace, newline, uppercase, underscore, slash, dot, percent escape, and non-ASCII text.
Test `-` as valid config to preserve the existing alphabet.
Use two configs in one process to prove no shared global vault choice.
Proof: `bun test --timeout 30000 src/broker.test.ts`.

### AC2: Enforce the vault across every credential path

Add tests named `lntv AC2` with the broker vault set to `acme-vault`.
Cover a generic ANTHROPIC rule on `api.anthropic.com`, reviewer API alone, and the reviewer API/Git pair.
Accept the configured vault for each path.
Reject `other-vault`, `-`, `acme-vault-extra`, and `acme` for each path.
For pairs, change only the API vault, only the Git vault, then both vaults.
Include a mixed generic policy with one matching credential and one different vault.
Preserve all syntax refusals from the grammar, including suffix newline, query, fragment, and encoded vault names.
Absent and empty config must allow multiple alphabet-valid vaults, including `-`, with otherwise valid policies.
An unkeyed policy must remain allowed with or without a pin.
Prove matching-vault manager keys, wrong hosts, misplaced credentials, and malformed reviewer shapes still fail.
Test the validator directly and `handle` through the existing mock Run.
Every rejected PUT must return 400 and leave the command list empty, including no policy lookup.
Every valid PUT must return 200 and retain the expected lookup plus create or update calls.
Proof: `bun test --timeout 30000 src/broker.test.ts src/ax.test.ts`.

### AC3: Deploy configuration and operator instructions

Add `FACTORY_AX_VAULT` to the broker container environment in `deploy/broker.yaml`.
Add it to both manifest-header and `docs/remote-runner.md` envsubst lists.
Document exact-match behavior, empty/unset compatibility, invalid-config refusal, and the need to match the manager vault.
Do not alter the token-swap vault setting `CLAUDE_TOKEN_VAULT`.
Check the manifest text and instructions with `rg -n 'FACTORY_AX_VAULT|envsubst' deploy/broker.yaml docs/remote-runner.md`.
Render to `.scratch/` with a synthetic `acme-vault` value and a dummy image; never pipe the render to kubectl.
Inspect the rendered broker env for the exact value and no unresolved vault placeholder.
Also render an empty value and confirm the documented unpinned mode.
Run `bunx prettier@3.9.9 --check deploy/broker.yaml docs/remote-runner.md`.
No live apply is a pre-merge acceptance criterion.

### AC4: Regression proof and required checks

Write AC1 and AC2 tests first. Record their failure on the base before the fix.
Use handler tests for the initial red proof so a missing optional parameter does not become the only failure.
Commit tests first, then the implementation. Both commits must ship in one PR with green final checks.
After the fix commit, run `factory mutate <file:line> <old> <new> -- bun test --timeout 30000 src/broker.test.ts`.
Mutate the config-to-handler argument, generic comparison, reviewer API comparison, and reviewer Git comparison independently where each exists.
Also mutate invalid-config rejection if a separate branch implements it.
For a single shared comparison, mutate that comparison and each independent call-site bypass instead of duplicate expressions.
Each mutant must compile and fail a targeted assertion; mutation exit 0 means killed.
Do not count a syntax or type error as evidence. Verify a clean worktree after each mutation.

Run the checks from `.github/workflows/ci.yml`:

```sh
bun test --timeout 30000 src factories
claude plugin test mod
bunx tsc --noEmit -p .
bunx prettier@3.9.9 --check .
gitleaks detect --log-opts=origin/main..HEAD
bun audit
```

Use the CI prerequisite flags and tools where available. Report any local gap explicitly.
The required `test`, `plugin`, `typecheck`, and `format` checks must pass on the final PR SHA.
CI omits `tsc -p mod` because engine types are absent from fresh checkouts.

## Risk

This is security-sensitive credential validation and infrastructure access code.
A wrong configured vault can stop worker policy creation. An empty value leaves the cross-vault gap open.
Existing policies remain unchanged until the broker receives a new PUT.
There is no database, stored-data, or credential migration. No credential value enters a test, log, or document.
Local AX callers retain the current optional-argument behavior. The broker owns the trusted pin.
The current agent-vault grants and active broker config remain unverified.
Security-sensitive: yes (credential validation and infrastructure access)

## Rollout and rollback

Use one draft PR. A person must merge after verify, review, and security.
The owner must select the existing worker vault and supply it to the broker Deployment.
Use a broker image with this fix before or with the new config. An old image ignores the variable.
No new vault, secret, grant, or key is necessary.
Owner-only: push an image to a production registry and apply the rendered manifest.
The apply command is `kubectl apply -f <approved-rendered-broker-manifest>`.
No worker can run that command without approval for that exact step.
Keep the previous manifest and image digest for rollback.
For rollback, open a revert PR for a person to merge; the owner restores the approved manifest and image.
Rollback or an empty pin restores the gap. Prefer a fix forward for a wrong config value.

## Observability

Use the existing 400 response and `policy refused for <atespace>/<actor>: <reason>` log.
Keep refusal output bounded and escaped. Do not add raw policy or credential logs.
An accepted policy PUT returns 200. `/healthz` alone proves no vault constraint.
Ship soak records the released image digest, active vault config, and normal worker policy success after owner rollout.
Use authorized reads only. Live logs or active probes need the owner permission that the factory rules require.
Do not submit a cross-vault policy to a real worker as a probe.
Use the isolated mocked handler suite from the released revision for negative evidence.
No AC is must-see-live; all acceptance criteria have local proofs.
Soak must state when the owner rollout or live evidence is absent; it must not claim active protection without evidence.

## Tasks

1. `claude-factory-lntv.1`: Add AC1 and AC2 tests in `src/broker.test.ts`. Check the expected base failure, then commit.
2. `claude-factory-lntv.2`: Add the constraint in `src/broker.ts`. Pass AC1 and AC2, then commit and prove mutations.
3. `claude-factory-lntv.3`: Add the manifest env and operator instructions. Complete AC3 and AC4, then commit.

Each task blocks the next. All three tasks fit one 120-minute implementation pass and one PR.
No external bead or PR blocks implementation. Owner rollout remains outside these pre-merge tasks.
Plan commits only this ADR. Implement changes the four named source, test, deploy, and operator-document files.
No factory definition change is necessary. No discovered bug becomes worse through this change.
