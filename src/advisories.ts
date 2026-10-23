// Pure logic for the advisories sweep (claude-factory-yex).
// The sweep worker writes advisories to one JSON file. `factory advisories file <path>` (cli.ts) reads it here.
// Treat the input as untrusted. Each field must match a strict pattern.
// A bead holds only checked fields, never free text.

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type Advisory = {
  id: string
  aliases: string[]
  severity: Severity
  package: string
  ecosystem: string
  installed: string | null
  fixed: string | null
  source: string
  manifest?: string
}
export type AdvisoryInput = { repo: string; dependabot: 'ok' | 'off'; advisories: Advisory[] }

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/
const CVE = /^CVE-\d{4}-\d{4,7}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PKG = /^[@A-Za-z0-9._/+:-]{1,214}$/
const VER = /^[A-Za-z0-9._+~:-]{1,64}$/
const TAG = /^[a-z0-9_-]{1,32}$/
const SEVERITIES = ['critical', 'high', 'medium', 'low']

const isId = (s: unknown): s is string => typeof s === 'string' && (GHSA.test(s) || CVE.test(s))
const str = (v: unknown, re: RegExp, what: string): string => {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`bad ${what}`)
  return v
}
const ver = (v: unknown, what: string): string | null => (v === null ? null : str(v, VER, what))

/** Checks the sweep worker's file. One bad field throws: nothing is filed from a partly bad input. */
export function parseAdvisoryInput(raw: unknown): AdvisoryInput {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('input is not an object')
  const repo = str(o.repo, REPO, 'repo')
  if (o.dependabot !== 'ok' && o.dependabot !== 'off') throw new Error('bad dependabot')
  if (!Array.isArray(o.advisories)) throw new Error('advisories is not an array')
  const advisories = o.advisories.map((x: Record<string, unknown>, i: number): Advisory => {
    try {
      if (!x || typeof x !== 'object') throw new Error('not an object')
      if (!isId(x.id)) throw new Error('bad id')
      const aliases = x.aliases ?? []
      if (!Array.isArray(aliases) || !aliases.every(isId)) throw new Error('bad aliases')
      if (!SEVERITIES.includes(x.severity as string)) throw new Error('bad severity')
      return {
        id: x.id,
        aliases,
        severity: x.severity as Severity,
        package: str(x.package, PKG, 'package'),
        ecosystem: str(x.ecosystem, TAG, 'ecosystem'),
        installed: ver(x.installed, 'installed'),
        fixed: ver(x.fixed, 'fixed'),
        source: str(x.source, TAG, 'source'),
        ...(x.manifest === undefined ? {} : { manifest: str(x.manifest, PKG, 'manifest') }),
      }
    } catch (err) {
      throw new Error(`advisories[${i}]: ${(err as Error).message}`)
    }
  })
  return { repo, dependabot: o.dependabot, advisories }
}

/** the metadata key that marks an advisory id as filed: `adv_ghsa_abcd_efgh_2345` */
export const advisoryKey = (id: string): string => `adv_${id.toLowerCase().replace(/[^a-z0-9]/g, '_')}`

const VERSION_HEAD = /^v?(\d+)(?:\.(\d+))?/

/** True when the fix is a major bump (0.x: a minor bump). null when a version does not parse: the
 * caller must then hold the advisory for a person. A Docker tag such as `18-alpine` reads as 18. */
export function isMajorBump(installed: string, fixed: string): boolean | null {
  const a = VERSION_HEAD.exec(installed)
  const b = VERSION_HEAD.exec(fixed)
  if (!a || !b) return null
  const [ma, na, mb, nb] = [+a[1]!, +(a[2] ?? 0), +b[1]!, +(b[2] ?? 0)]
  return mb > ma || (ma === 0 && mb === 0 && nb > na)
}

export type FileOp = {
  keys: string[]
  title: string
  body: string
  labels: string[]
  priority: number
  queued: boolean
}
export type Plan = {
  ownerStep: { title: string; body: string } | null
  files: FileOp[]
  digestRows: string[]
}

export const QUEUE_LABELS = ['factory', 'station:plan', 'sweep-queue:critical-advisory']
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const url = (id: string) =>
  id.startsWith('GHSA') ? `https://github.com/advisories/${id}` : `https://nvd.nist.gov/vuln/detail/${id}`

/** why an item cannot start on its own, or null when it can */
function holdReason(a: Advisory): string | null {
  if (!a.installed) return `no installed version for ${a.package}`
  if (!a.fixed) return `no fixed version for ${a.package}`
  const major = isMajorBump(a.installed, a.fixed)
  if (major === null) return `version of ${a.package} does not parse`
  return major ? `${a.package} needs a major bump (${a.installed} to ${a.fixed})` : null
}

/**
 * Groups the items that share an id or alias. Then it decides what to file.
 * `seen(field, value)` says if a bead (a closed bead too) has that metadata.
 * The plan skips a group when any of its keys is seen.
 * A critical or high group with a safe fix gets `QUEUE_LABELS`.
 * A critical or high group without a safe fix is held: the same bead, no queue label.
 * Medium and low items go in the digest.
 */
export function planAdvisories(input: AdvisoryInput, seen: (field: string, value: string) => boolean): Plan {
  const plan: Plan = { ownerStep: null, files: [], digestRows: [] }
  if (input.dependabot === 'off') {
    if (!seen('advisory_owner_step', input.repo))
      plan.ownerStep = {
        title: `Enable Dependabot alerts on ${input.repo}`,
        body:
          `The advisories sweep got 403 or 404 from the Dependabot alerts API for ${input.repo}.\n` +
          `Question: Enable Dependabot alerts on ${input.repo}?\n` +
          `Options: enabled: I turned alerts on in Settings > Code security | token: I gave the factory's GitHub token the Dependabot alerts read permission | skip: leave alerts off, use the audit tool only\n` +
          `The factory never changes a repo setting itself.`,
      }
  }
  // union-find over ids and aliases
  const groups: Advisory[][] = []
  const keyGroup = new Map<string, Advisory[]>()
  for (const a of input.advisories) {
    const ids = [a.id, ...a.aliases]
    const hits = [...new Set(ids.map(i => keyGroup.get(i)).filter((g): g is Advisory[] => !!g))]
    const g = hits[0] ?? []
    if (!hits.length) groups.push(g)
    for (const other of hits.slice(1)) {
      g.push(...other)
      groups.splice(groups.indexOf(other), 1)
      for (const [k, v] of keyGroup) if (v === other) keyGroup.set(k, g)
    }
    g.push(a)
    for (const i of ids) keyGroup.set(i, g)
  }
  for (const g of groups) {
    const worst = g.reduce((m, a) => (RANK[a.severity] < RANK[m] ? a.severity : m), 'low' as Severity)
    const ids = [...new Set(g.flatMap(a => [a.id, ...a.aliases]))]
    const keys = ids.map(advisoryKey)
    if (worst === 'medium' || worst === 'low') {
      for (const a of g)
        plan.digestRows.push(
          `${a.severity} ${a.id} ${a.package} ${a.installed ?? '?'} -> ${a.fixed ?? 'no fix'} (${a.ecosystem}, ${a.source})`,
        )
      continue
    }
    if (keys.some(k => seen(k, '1'))) continue
    const holds = g.map(holdReason).filter((r): r is string => !!r)
    const queued = holds.length === 0
    const pkgs = [...new Set(g.map(a => a.package))]
    plan.files.push({
      keys,
      title: `advisory ${ids[0]}: ${worst} in ${pkgs.join(', ')}`.slice(0, 200),
      body: [
        `Repo: ${input.repo}`,
        `Severity: ${worst}`,
        ...g.map(
          a =>
            `Package: ${a.package} (${a.ecosystem}) installed ${a.installed ?? 'unknown'}, fixed ${a.fixed ?? 'none'}, from ${a.source}${a.manifest ? `, in ${a.manifest}` : ''}`,
        ),
        ...ids.map(i => `Advisory: ${url(i)}`),
        queued
          ? 'This fix is not a major bump. The factory starts it at the plan station.'
          : `Held for a person: ${holds.join('; ')}.`,
      ].join('\n'),
      labels: queued ? QUEUE_LABELS : [],
      priority: worst === 'critical' ? 1 : 2,
      queued,
    })
  }
  plan.files.sort((x, y) => x.priority - y.priority)
  return plan
}
