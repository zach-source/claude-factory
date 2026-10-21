#!/bin/bash
# Check inside the AX manager task that its secrets and egress work with no secret on disk
# (docs/remote-runner.md, Manager secrets). Run it in the manager VM:
#   RIG_REPO=<rig clone> BEADS_RIG_REPO=<rig clone with a beadsRemote> hack/ax-manager-check.sh
# AC1-AC5 call out; AC6 and AC7 read the VM. It prints PASS or FAIL for each check and exits 1 on any FAIL.
# It creates one probe task and one probe branch dry-run, and it removes the task. It prints no secret.
set -u
fail=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
check() { local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }

RIG_REPO=${RIG_REPO:-}
BEADS_RIG_REPO=${BEADS_RIG_REPO:-}
HOME_DIR=${FACTORY_HOME:-$HOME}

# AC1 gh with GH_TOKEN=placeholder (the gateway adds the token)
if [ -n "$RIG_REPO" ]; then
  slug=$(git -C "$RIG_REPO" remote get-url origin | sed -E 's#^.*github.com[:/]##; s#\.git$##')
  check "AC1 gh pr list" gh pr list -R "$slug" -L 1
  # AC2 git push through the gateway: a dry run to a new branch
  out=$(git -C "$RIG_REPO" push --dry-run origin HEAD:refs/heads/factory/ax-check-probe 2>&1)
  case "$out" in *"new branch"*) ok "AC2 git push --dry-run" ;; *) bad "AC2 git push --dry-run" ;; esac
else
  bad "AC1/AC2 need RIG_REPO"
fi

# AC3 bd dolt pull through the DOLT_BASIC rule
if [ -n "$BEADS_RIG_REPO" ]; then
  check "AC3 bd dolt pull" env -C "$BEADS_RIG_REPO" bd dolt pull
else
  bad "AC3 needs BEADS_RIG_REPO"
fi

# AC4 token swap through the broker
if [ -n "${FACTORY_AX_TOKEN_SWAP:-}" ]; then
  out=$($FACTORY_AX_TOKEN_SWAP 2>&1)
  case "$out" in *"slot "*" is live"*) ok "AC4 token swap" ;; *) bad "AC4 token swap" ;; esac
else
  bad "AC4 FACTORY_AX_TOKEN_SWAP is not set"
fi

# AC5 an AX task apply, and the controller check through the broker
probe="f-check-$(date +%s)"
if [ -n "${AX_PROBE_FILE:-}" ] && [ -f "$AX_PROBE_FILE" ]; then
  sed "s/__NAME__/$probe/g" "$AX_PROBE_FILE" | ax apply -f - >/dev/null 2>&1 && ax get task "$probe" >/dev/null 2>&1 \
    && ok "AC5 ax apply" || bad "AC5 ax apply"
  ax delete task "$probe" >/dev/null 2>&1
else
  bad "AC5 needs AX_PROBE_FILE (a task manifest with __NAME__ as its name)"
fi
check "AC5 controller via broker" curl -sSf -m 10 "${FACTORY_POLICY_BROKER:-http://unset.invalid}/controller"

# AC6 Linear: the VM sends a placeholder
[ "${FACTORY_IN_AX:-}" = 1 ] && ok "AC6 FACTORY_IN_AX=1" || bad "AC6 FACTORY_IN_AX is not 1"

# AC7 no secret in env or on disk
for v in CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN DOLT_REMOTE_PASSWORD LINEAR_API_KEY; do
  val=${!v:-placeholder}
  [ "$val" = placeholder ] && ok "AC7 $v" || bad "AC7 $v is not a placeholder"
done
for v in OP_SERVICE_ACCOUNT_TOKEN OP_CONNECT_TOKEN; do
  [ -z "${!v:-}" ] && ok "AC7 $v unset" || bad "AC7 $v is set"
done
[ -z "$(git config --global --get credential.helper 2>/dev/null)" ] && ok "AC7 no credential.helper" || bad "AC7 credential.helper is set"
if grep -qs oauth_token "${XDG_CONFIG_HOME:-$HOME/.config}/gh/hosts.yml"; then bad "AC7 gh hosts.yml holds a token"; else ok "AC7 gh hosts.yml"; fi
hits=$(grep -rIlE 'sk-ant-|ghs_|ghp_|gho_|github_pat_|lin_api_|ops_' "$HOME" "$HOME_DIR" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" \
  --exclude-dir=repos --exclude-dir=.git 2>/dev/null | head -5)
[ -z "$hits" ] && ok "AC7 disk scan" || { bad "AC7 disk scan found secret-shaped text in: $hits"; }

exit $fail
