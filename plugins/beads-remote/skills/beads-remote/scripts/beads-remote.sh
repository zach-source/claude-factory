#!/usr/bin/env bash
# Sync a repo's beads through a git remote: Dolt keeps them under refs/dolt/data, so any git host works
# (GitLab, GitHub, a bare repo on disk). Safe to run again: it only does the steps not done yet.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: beads-remote.sh [--url URL] [--prefix P] [--name N] [--cache-dir DIR]

  --url        git remote for the beads (default: the repo's origin). https://, http://, ssh://,
               git@host:path, file:// or a path; git+ is added for Dolt
  --prefix     issue prefix for a new database (default: the repo's directory name; ignored when the
               remote already has beads, which bring their own)
  --name       Dolt remote name (default: origin)
  --cache-dir  keep Dolt's git-remote-cache here, on local disk, when the repo is on a network
               filesystem (EFS, NFS); the directory is created, a cache already there is moved aside
EOF
  exit "${1:-0}"
}
die() {
  echo "beads-remote: $*" >&2
  exit 1
}

url='' prefix='' name=origin cache=''
while [ $# -gt 0 ]; do
  case "$1" in
  --url) url=${2:?}; shift 2 ;;
  --prefix) prefix=${2:?}; shift 2 ;;
  --name) name=${2:?}; shift 2 ;;
  --cache-dir) cache=${2:?}; shift 2 ;;
  -h | --help) usage ;;
  *) usage 1 >&2 ;;
  esac
done

command -v bd >/dev/null || die "bd is not installed"
cd "$(git rev-parse --show-toplevel)" || die "not inside a git repo"
[ -n "$url" ] || url=$(git remote get-url origin 2>/dev/null) || die "no --url and the repo has no origin"

# the same remote as git sees it, and as Dolt wants it
plain=${url#git+}
case "$plain" in
*://*) ;;
/*) plain="file://$plain" ;;
*@*:*) plain="ssh://${plain%%:*}/${plain#*:}" ;; # git@host:group/repo.git
*) die "cannot tell what kind of git URL $url is" ;;
esac
dolt="git+$plain"

has_data=$(git ls-remote "$plain" refs/dolt/data)

if [ ! -d .beads ]; then
  if [ -n "$has_data" ]; then
    echo "beads-remote: cloning the beads already on $plain"
    bd init --non-interactive --stealth --remote "$dolt" ${prefix:+--prefix "$prefix"}
  else
    bd init --non-interactive --stealth --prefix "${prefix:-$(basename "$PWD")}"
  fi
fi

current=$(bd dolt remote list 2>/dev/null | awk -v n="$name" '$1 == n { print $2 }')
if [ -z "$current" ]; then
  # --allow-git-origin: beads riding in the code repo's own remote is the point here
  bd dolt remote add "$name" "$dolt" --allow-git-origin
elif [ "$current" != "$dolt" ]; then
  die "Dolt remote $name is $current, not $dolt: bd dolt remote remove $name first to repoint it"
fi
bd config set sync.remote "$dolt" >/dev/null

db=$(find .beads -maxdepth 4 -type d -name .dolt -print -quit)
if [ -n "$cache" ] && [ -z "$db" ]; then
  echo "beads-remote: --cache-dir skipped: the database is not under .beads (a shared Dolt server keeps its own)" >&2
elif [ -n "$cache" ]; then
  mkdir -p "$cache"
  link="$db/git-remote-cache"
  if [ -e "$link" ] && [ ! -L "$link" ]; then mv "$link" "$link.old"; fi
  ln -sfn "$cache" "$link"
  echo "beads-remote: $link -> $cache (recreate $cache after a reboot wipes it)"
fi

if [ -n "$has_data" ]; then bd dolt pull; fi
bd dolt push
[ -n "$(git ls-remote "$plain" refs/dolt/data)" ] || die "push finished but $plain has no refs/dolt/data"
echo "beads-remote: beads sync through $dolt"
