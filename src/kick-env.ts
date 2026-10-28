/** env for a pass that tick kicks (self-update, gc, gc --worktrees, sweep): no FACTORY_PATROL, because
 * a patrol's start or fork runs tick in-process, and these verbs refuse a patrol (claude-factory-3c4w.8) */
export function kickEnv(
  env: Record<string, string | undefined>,
  home: string,
): Record<string, string | undefined> {
  const { FACTORY_PATROL: _patrol, ...rest } = env
  return { ...rest, FACTORY_HOME: home }
}
