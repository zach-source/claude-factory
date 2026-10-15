#!/usr/bin/env bash
# beads-remote.sh against a bare repo on disk: set up, run again, then a second clone gets the same beads
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/beads-remote.sh
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t BD_NON_INTERACTIVE=1
unset BEADS_DOLT_SHARED_SERVER # embedded, so the database and its cache live under .beads

git init -q --bare "$dir/origin.git"
git init -q "$dir/a"
cd "$dir/a"
git commit -q --allow-empty -m init
git remote add origin "$dir/origin.git"
git push -q origin HEAD:main

"$script" --prefix demo --cache-dir "$dir/cache"
id=$(bd create "travels with the repo" -t task --silent)
"$script" # again: nothing to set up, just a push
[ -L "$(find .beads -maxdepth 4 -type d -name .dolt -print -quit)/git-remote-cache" ]

git clone -q "$dir/origin.git" "$dir/b"
cd "$dir/b"
"$script"
[[ $(bd show "$id") == *"travels with the repo"* ]]
echo "ok: $id synced through $dir/origin.git"
