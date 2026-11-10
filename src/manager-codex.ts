import { MANAGER_CWD } from './ax'
import { stepPrompt } from './steps'

/** env names the codex chat session inherits: the shell basics, the CA, the home, and the AX and beads settings */
const KEEP =
  /^(PATH|HOME|TERM|LANG|LC_\w+|TZ|USER|SHELL|CODEX_HOME|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_SSL_CAINFO|HTTPS?_PROXY|NO_PROXY|FACTORY_[A-Z_]+|AX_[A-Z_]+|BEADS_[A-Z_]+|BD_[A-Z_]+)$/
/** a name that holds a credential: it passes only as the literal placeholder */
const SECRET = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/i
/** the gate token and the codex pin: the person's Allow never reaches the session, so gated kinds stay refused */
const DROP = new Set(['FACTORY_ALLOW', 'FACTORY_PATROL'])

/**
 * the codex session that stands in for the manager's Claude chat when every Claude slot is at its limit
 * (claude-factory-y3f8w.4). It gets the same role text as the core chat (src/steps/chat.md). FACTORY_MAIN_CHAT=1
 * and no FACTORY_ALLOW make mainChatRefusal refuse every gated kind: v1 has no Allow prompt in codex.
 * In the AX manager task the API key is the placeholder, and the gateway adds the real one (managerEgress).
 */
export function codexChatLaunch(o: { cli: string; home: string; env: Record<string, string | undefined> }) {
  const inAx = o.env.FACTORY_IN_AX === '1'
  const kept = Object.entries(o.env).filter(
    (e): e is [string, string] =>
      KEEP.test(e[0]) &&
      !DROP.has(e[0]) &&
      e[1] !== undefined &&
      (!SECRET.test(e[0]) || e[1] === 'placeholder'),
  )
  const env: Record<string, string> = {
    ...Object.fromEntries(kept),
    FACTORY_HOME: o.home,
    FACTORY_MAIN_CHAT: '1',
    ...(inAx && { FACTORY_IN_AX: '1' }),
    ...(inAx && o.env.FACTORY_AX_VAULT && { OPENAI_API_KEY: 'placeholder', CODEX_API_KEY: 'placeholder' }),
  }
  const prompt =
    stepPrompt('chat', { cli: o.cli }) +
    (inAx
      ? `\nIn this shell, run \`eval "$(${o.cli} repos bd-env 2>/dev/null)"\` in the same command before each bd call.`
      : '') +
    '\nThe person is not here to approve a gated command. If the factory refuses one, tell the person the command and stop.'
  const argv = [o.env.FACTORY_CODEX ?? 'codex', '--dangerously-bypass-approvals-and-sandbox', prompt]
  return { argv, env, cwd: inAx ? MANAGER_CWD : process.cwd() }
}
