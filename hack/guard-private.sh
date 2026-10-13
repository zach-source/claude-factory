#!/usr/bin/env sh
# Refuses a commit whose added lines carry a secret (gitleaks), or whose added lines, message or author name
# private infrastructure: this repo is public.
# The patterns (one extended regex a line, matched without case) live outside the repo, in
# <git common dir>/info/private-patterns, since listing them here would publish them.
#   guard-private.sh staged        the staged diff's added lines and the author (pre-commit)
#   guard-private.sh msg <file>    a commit message (commit-msg)
set -eu
if [ "$1" = staged ]; then
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks git --staged --redact --no-banner --log-level warn || { echo "guard-private: gitleaks found a secret in the staged changes" >&2; exit 1; }
  else
    echo "guard-private: gitleaks is not installed, secrets not checked" >&2
  fi
fi
patterns="$(git rev-parse --git-common-dir)/info/private-patterns"
[ -s "$patterns" ] || { echo "guard-private: no $patterns, nothing checked" >&2; exit 0; }
case "$1" in
  staged) text=$( (git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++ '; git var GIT_AUTHOR_IDENT) || true) ;;
  msg) text=$(grep -v '^#' "$2" || true) ;;
  *) echo "usage: guard-private.sh staged | msg <file>" >&2; exit 2 ;;
esac
hits=$(printf '%s\n' "$text" | grep -n -i -E -f "$patterns" || true)
[ -z "$hits" ] && exit 0
echo "guard-private: this would publish private infrastructure ($1); reword or move it out of the repo:" >&2
printf '%s\n' "$hits" | cut -c1-200 >&2
exit 1
