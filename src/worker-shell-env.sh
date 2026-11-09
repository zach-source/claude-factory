# Claude Code sources this file before each worker Bash command, after it sources the shell snapshot.
# The snapshot holds the user's aliases (gp, gco). They hide git and gh from the deny hook, so clear them.
# zsh keeps suffix aliases (alias -s) after unalias -a, so clear them too. bash rejects -s: hide that.
# A user CLAUDE_ENV_FILE value arrives in FACTORY_USER_ENV_FILE and runs first.
if [ -n "${FACTORY_USER_ENV_FILE:-}" ] && [ -r "$FACTORY_USER_ENV_FILE" ]; then . "$FACTORY_USER_ENV_FILE"; fi
unalias -a 2>/dev/null || true
unalias -s -a 2>/dev/null || true
