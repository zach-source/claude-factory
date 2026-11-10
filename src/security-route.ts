// The runner decides whether a build goes to the security station.
// It reads changed paths, the rig's sensitivePaths, the plan's Security-sensitive line and the bead labels.
// Pure functions, no I/O.

/** A reviewer's reason to send a not-required route to security: one line `Security-reason: <path>:<line> <text>`. */
export const SECURITY_REASON = /^[ \t]*(?:[-*][ \t]+)?Security-reason:[ \t]*\S+:\d+[ \t]+\S/m

const FILE_RES = [
  /^dockerfile[^/]*$/,
  /^(claude|agents)\.md$/,
  /^\.(mcp\.json|gitmodules|gitattributes|npmrc|envrc|pre-commit-config\.yaml)$/,
  /^\.yarnrc[^/]*$/,
  /^bunfig\.toml$/,
  /^docker-compose[^/]*$/,
  /^[^/]*\.tf$/,
  /^codeowners$/,
  /^\.gitleaks[^/]*$/,
  /^requirements[^/]*\.txt$/,
  /^(package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.mod|go\.sum|cargo\.toml|cargo\.lock|pyproject\.toml|poetry\.lock|uv\.lock|flake\.nix|flake\.lock|module\.bazel)$/,
]

const DIRS = new Set([
  '.factory',
  '.claude',
  '.codex',
  '.cursor',
  '.agents',
  '.husky',
  '.cargo',
  'factories',
  '.github',
  'deploy',
  'k8s',
  'kustomize',
  'helm',
  'charts',
  'terraform',
  'flux',
  'clusters',
  'infrastructure',
  'manifests',
])

const WORDS = new Set(
  `auth oauth authz authn login logout session sessions token tokens secret secrets credential credentials cred creds password passwords passwd key keys crypto cipher encrypt decrypt sign signing signature signed cert certs certificate tls ssl jwt permission permissions rbac acl policy policies sandbox egress vault redact redaction hook hooks guard guards security sudo ssh gpg parse parser parsers lexer grammar deserialize unmarshal`.split(
    ' ',
  ),
)

/** The reason a path is sensitive (`file`, `dir:<segment>`, `word:<word>`), or ''. */
export function sensitivePath(path: string): string {
  const segs = path.split('/')
  const last = (segs.pop() ?? '').toLowerCase()
  if (FILE_RES.some(re => re.test(last))) return 'file'
  for (const s of segs) if (DIRS.has(s.toLowerCase())) return `dir:${s.toLowerCase()}`
  const spaced = path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  for (const w of spaced.split(/[^a-z0-9]+/)) if (WORDS.has(w)) return `word:${w}`
  return ''
}

/** What the plan says: the last `Security-sensitive: yes|no` line, else a loose scan. */
export function planSecurity(summary: string | undefined): 'yes' | 'no' | undefined {
  if (!summary) return undefined
  const hits = [...summary.matchAll(/^\s*[-*]?\s*Security-sensitive:\s*(yes|no)\b/gim)]
  if (hits.length) return hits[hits.length - 1]![1]!.toLowerCase() as 'yes' | 'no'
  const loose = summary
    .split('\n')
    .some(l => /security-sensitive/i.test(l) && !/\b(not|non)[\s-]+security-sensitive/i.test(l))
  return loose ? 'yes' : undefined
}

/** One rig sensitivePaths entry: a repo path or directory (segments of letters, digits, . _ -; no . or .. segment; no glob). */
export const SENSITIVE_ENTRY =
  /^(?!.{201})(?!(?:.*\/)?\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/

/** The rig's sensitivePaths: [] when unset, the list when every entry is valid, else null (malformed). */
export function rigPaths(v: unknown): string[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every(e => typeof e === 'string' && SENSITIVE_ENTRY.test(e))) return null
  return v
}

const rigHit = (p: string, list: string[]): string => {
  const e = list.find(x => {
    const d = x.replace(/\/$/, '')
    return p === d || p.startsWith(d + '/')
  })
  return e === undefined ? '' : `rig:${e}`
}

export type SecurityRoute = { required: boolean; why: string[] }

// A file name can hold a newline: strip control characters and clip before it goes in a brief.
const clean = (p: string): string => p.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, '?').slice(0, 200)

export function securityRoute(facts: {
  paths: string[] | null
  plan?: string
  labels: string[] | null
  rigPaths?: string[] | null
}): SecurityRoute {
  const why: string[] = []
  if (facts.paths === null) why.push('paths unknown')
  if (facts.labels === null) why.push('bead labels unknown')
  if (facts.rigPaths === null) why.push('rig sensitivePaths malformed')
  const hits = (facts.paths ?? []).flatMap(p => {
    const r = sensitivePath(p) || rigHit(p, facts.rigPaths ?? [])
    return r ? [`${clean(p)} (${r})`] : []
  })
  why.push(...hits.slice(0, 5))
  if (hits.length > 5) why.push(`+${hits.length - 5} more`)
  if (planSecurity(facts.plan) === 'yes') why.push('plan says security-sensitive')
  if (facts.labels?.includes('security')) why.push('bead label security')
  return { required: why.length > 0, why }
}

export function routeLine(route: SecurityRoute): string {
  return route.required
    ? `required: ${route.why.join('; ')}`
    : 'not required: no changed path matches the sensitive-path rule, the plan does not say security-sensitive, and the bead has no label security'
}
