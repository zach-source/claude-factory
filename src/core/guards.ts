// The rule body stays in the mod until hpmc.9. The mod cannot import src/.
import { INSTALL_VERB, META_WRITE, bdWrite, gatedCommand } from '../../mod/hooks/view'
export { INSTALL_VERB, META_WRITE, PATROL_VERB, bdWrite, gatedCommand } from '../../mod/hooks/view'

export type Role = 'manager' | 'subagent'
export type Verdict =
  | { decision: 'allow' }
  | { decision: 'ask'; question: string; reason: string }
  | { decision: 'deny'; reason: string }

export function check(command: string, role: Role): Verdict {
  const gated = gatedCommand(command)
  if (role === 'manager') {
    if (!gated) return { decision: 'allow' }
    return gated.ask
      ? { decision: 'ask', question: gated.question, reason: gated.deny }
      : { decision: 'deny', reason: gated.deny }
  }
  if (gated)
    return { decision: 'deny', reason: `${gated.deny} A patrol never decides this: leave it for the person.` }
  const joined = command.replace(/\\\n/g, '')
  if (INSTALL_VERB.test(joined))
    return {
      decision: 'deny',
      reason:
        'a subagent never installs or rejects a skill or proposal: only the manager or the person installs',
    }
  if (META_WRITE.test(joined)) return { decision: 'deny', reason: 'a subagent never writes bead metadata' }
  if (bdWrite(joined))
    return {
      decision: 'deny',
      reason:
        'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first',
    }
  return { decision: 'allow' }
}
