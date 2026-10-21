#!/bin/bash
# Check inside the AX manager task that every rig has a repo clone and a beads store (192.4,
# docs/remote-runner.md, Repos and beads in the task). Run it in the manager VM:
#   hack/ax-repos-check.sh
# It prints PASS or FAIL for each check and exits 1 on any FAIL. It reads only.
# AX_CHECK_START=1 also runs 'factory start' on each rig. That makes a real run on each rig: run it
# only with the person's OK. It checks the worktree, the pushed run branch and the AX worker task.
set -u
fail=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

HOME_DIR=${FACTORY_HOME:-$HOME}
REPOS=${FACTORY_REPOS:-/workspace/w/repos}
rigs=$(factory rig | grep -E '^[^ ]' | awk '{print $1}')
[ -n "$rigs" ] || { bad "factory rig lists no rig"; exit 1; }

for r in $rigs; do
  repo=$REPOS/$r
  if git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then ok "$r repo $repo"; else bad "$r repo $repo is missing"; continue; fi
  store=$HOME_DIR/beads/$r
  if [ -d "$repo/.beads" ]; then
    if BEADS_DIR=$store/.beads BEADS_DOLT_SHARED_SERVER=0 bd list -n 1 >/dev/null 2>&1; then ok "$r bd store"; else bad "$r bd store $store"; fi
  else
    echo "SKIP $r bd store (the rig has no .beads)"
  fi
  [ "${AX_CHECK_START:-}" = 1 ] || continue
  out=$(factory start lifecycle "$r" "ax-repos-check: $(date +%s)" 2>&1)
  run=$(echo "$out" | grep -oE 'lifecycle-[a-z0-9]+' | head -1)
  [ -n "$run" ] || { bad "$r start: no run id"; continue; }
  wt=$(git -C "$repo" worktree list | grep "factory-$run" | awk '{print $1}')
  [ -n "$wt" ] && ok "$r worktree" || bad "$r worktree for $run"
  git -C "$repo" ls-remote --exit-code --heads origin "factory/$run" >/dev/null 2>&1 && ok "$r pushed factory/$run" || bad "$r run branch factory/$run is not pushed"
  ax get tasks 2>/dev/null | grep -q "$run" && ok "$r AX worker" || bad "$r no AX worker task for $run"
done
exit $fail
