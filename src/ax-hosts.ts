// The vault keys a worker policy may carry and the hosts each goes to. egressPolicy (ax.ts) builds its rules from
// these, and the policy broker (broker.ts) checks a body against them, so the two cannot drift. No imports: the
// broker image copies only this file, broker.ts and ax-ready.ts.

export const ANTHROPIC_HOSTS = ['api.anthropic.com']
export const GITHUB_API_HOSTS = ['api.github.com', 'uploads.github.com']
export const GITHUB_GIT_HOSTS = ['github.com']

const OWNER = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/i
/**
 * `FACTORY_AX_GITHUB_KEYS=<owner>=<KEY>[,<owner>=<KEY>...]`: for a GitHub owner, the vault holds a token `<KEY>`
 * (Bearer) and a git header `<KEY>_BASIC` (Basic) from that owner's App installation. A bad entry is an error.
 */
export function parseGithubKeys(spec = process.env.FACTORY_AX_GITHUB_KEYS): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const entry of (spec ?? '').split(',').filter(Boolean)) {
    const [owner = '', key = '', ...rest] = entry.split('=')
    if (rest.length || !OWNER.test(owner))
      throw new Error(`FACTORY_AX_GITHUB_KEYS entry "${entry}" is <owner>=<KEY> (other-owner=GITHUB_OO)`)
    if (!/^[A-Z][A-Z0-9_]*$/.test(key))
      throw new Error(`FACTORY_AX_GITHUB_KEYS key "${key}" is SCREAMING_SNAKE_CASE, as agent-vault names it`)
    keys[owner] = key
  }
  return keys
}

/**
 * the hosts each vault key may go to: the fixed keys, and the owner keys of FACTORY_AX_GITHUB_KEYS (`<KEY>` to the
 * GitHub API, `<KEY>_BASIC` to git). `extra` is `KEY=host+host,...` for the keys that depend on a rig: a GitLab
 * host's `GITLAB` and `GITLAB_BASIC`, a rig egress entry's own key
 */
export function keyHosts(githubKeys?: string, extra?: string): Record<string, string[]> {
  const hosts: Record<string, string[]> = {
    ANTHROPIC: ANTHROPIC_HOSTS,
    GITHUB: GITHUB_API_HOSTS,
    GITHUB_BASIC: GITHUB_GIT_HOSTS,
  }
  for (const key of Object.values(parseGithubKeys(githubKeys))) {
    hosts[key] = GITHUB_API_HOSTS
    hosts[`${key}_BASIC`] = GITHUB_GIT_HOSTS
  }
  for (const entry of (extra ?? '').split(',').filter(Boolean)) {
    const [key = '', list = ''] = entry.split('=')
    if (key) hosts[key] = list.split('+').filter(Boolean)
  }
  return hosts
}
