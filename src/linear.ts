// This is the Linear pull loop (claude-factory-b6c).
// The loop moves Linear issues from each opted-in rig's configured team(s) into that rig's beads
// store, routing each issue to at most one rig (claude-factory-b6c.18). It never pushes a change
// back to Linear.
//
// `bd` has no project or label filter on a pull: `bd linear sync --pull --team <ids>` always
// imports every issue of a team. So the loop lists each team's issues itself (`fetchLinearIssues`,
// read-only), decides which rig, if any, each issue belongs to (`routeLinearIssue`), then asks
// `bd` to pull only the routed issues into that rig (`bd linear pull <ref...>`, never `--push`).
//
// The loop gets the Linear API key on demand from a secret-broker REST service (claude-factory-b6c.17,
// the person's decision of 2026-10-16). It never asks for an interactive approval.
// The loop must keep the key off disk, out of the command-line arguments, out of a log, out of a bead,
// and out of git.
//
// This repo is public. The broker's host, and the vault name it reads, name real private
// infrastructure, so this file never hardcodes them: every run reads them from its own environment or
// Keychain, set up once, by hand, outside git (see docs/beads.md). The item name "LinearBotsApiKey" and
// the field name "credential" are not infrastructure names, so they stay as constants below.
//
// The same rule holds for a rig's Linear project and label names (`--linear-projects`,
// `--linear-labels`): they name a real team's project and label taxonomy, so this file ships no
// default list for any rig name. The person sets them per rig, outside git (see docs/beads.md).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The argument of `--linear <team_id[,team_id]>`: one or more Linear team UUIDs. */
export function parseLinearTeams(spec: string): string[] {
  const ids = spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const bad = ids.find(id => !UUID.test(id))
  if (bad !== undefined) throw new Error(`--linear team id "${bad}" is not a UUID`)
  if (!ids.length) throw new Error('--linear needs at least one team UUID')
  return ids
}

/** The argument of `--linear-projects <name[,name]>` or `--linear-labels <name[,name]>`: one or
 * more exact Linear project or label names, comma-separated. A name must not itself hold a comma. */
export function parseLinearList(spec: string): string[] {
  const names = spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (!names.length) throw new Error('needs at least one name')
  return names
}

/** A rig's Linear configuration (`rigs.json`'s `linear` field): the team(s) it pulls from, and the
 * exact project names and label names that route an issue to it (claude-factory-b6c.18). `projects`
 * and `labels` are each optional: a rig with neither still gets an issue whose project name starts
 * with `[<rig-name>]` (see `routeLinearIssue`), but nothing else. */
export type LinearRouting = { team: string[]; projects?: string[]; labels?: string[] }

/** One Linear issue, as `routeLinearIssue` needs it: its project name, if any, and its label names. */
export type LinearIssue = { project?: string; labels: string[] }

/** A rig, as `routeLinearIssue` needs it: its name, and its Linear routing config, if opted in. */
export type RoutableRig = { name: string; linear?: LinearRouting }

/**
 * Routes one Linear issue to at most one opted-in rig (claude-factory-b6c.18). `bd` has no such
 * filter itself, so the loop decides this in its own code, before it asks `bd` to pull anything.
 *
 * Rule 1 (always on, no config): a project name shaped `[<name>] ...` routes to the opted-in rig
 * named `<name>`. This rule is final (claude-factory-b6c.23): a bracket that names no opted-in rig
 * (for example a project of another team, or a typo) routes to no rig. It never falls through to
 * rule 2, even when some opted-in rig's own `projects` or `labels` list would otherwise match. The
 * bracket is the person's own routing choice; a rule-2 match on the same issue is not.
 *
 * Rule 2 (only when the project name holds no `[...]` prefix at all): a project name, or a label,
 * that is in some opted-in rig's own `projects` or `labels` list (`rig add
 * --linear-projects`/`--linear-labels`) routes to that rig. The first opted-in rig, in `rigs`
 * order, that matches wins.
 *
 * No rule matches: the function returns `undefined`. The issue lands in no rig.
 */
export function routeLinearIssue(issue: LinearIssue, rigs: RoutableRig[]): string | undefined {
  const opted = rigs.filter((r): r is RoutableRig & { linear: LinearRouting } => !!r.linear?.team?.length)
  const bracket = issue.project?.match(/^\[([^[\]]+)\]/)
  if (bracket) return opted.find(r => r.name === bracket[1])?.name
  for (const r of opted) {
    if (issue.project && r.linear.projects?.includes(issue.project)) return r.name
    if (issue.labels.some(l => r.linear.labels?.includes(l))) return r.name
  }
  return undefined
}

const ITEM_TITLE = 'LinearBotsApiKey'
const FIELD_LABEL = 'credential'

/** The one-time setup the person runs, once, so the loop never needs an interactive `op` call again.
 * This text names only the setup command, never a value. */
export const CONNECT_SETUP_HELP =
  'no secret-broker credentials for Linear: run the one-time setup in docs/beads.md (section Linear)'

/** The values every Connect request needs: the broker's own host and vault, and the 3 headers that
 * authenticate to it. Cloudflare Access strips a plain `Authorization` header, and the broker's proxy
 * remaps `X-OP-Token`, so the loop sends all 3 as their own headers. None of these 5 values is ever a
 * constant in this file: the host and vault name real private infrastructure, and the 3 headers are
 * secrets. */
export type ConnectCreds = { host: string; vault: string; token: string; cfId: string; cfSecret: string }

/**
 * Reads one macOS Keychain generic password, service `claude-factory`.
 * Returns `undefined` on any failure: a missing entry, a locked keychain, or no `security` command at
 * all (every non-macOS host, including this factory's own Linux CI runner). Never logs the value.
 */
function keychainRead(account: string): string | undefined {
  try {
    const p = Bun.spawnSync(
      ['security', 'find-generic-password', '-s', 'claude-factory', '-a', account, '-w'],
      { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 },
    )
    if (p.exitCode !== 0) return undefined
    const out = p.stdout.toString().replace(/\r?\n+$/, '')
    return out || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolves the 5 Connect values: the broker's host and vault name, and 3 header values.
 *
 * It checks two sources, in this order:
 * 1. The environment: `OP_CONNECT_HOST`, `OP_CONNECT_VAULT`, `OP_CONNECT_TOKEN`,
 *    `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
 * 2. The macOS Keychain, service `claude-factory`, for the 3 header values only: accounts
 *    `op-connect-token`, `cf-access-client-id`, `cf-access-client-secret`. The host and vault name have
 *    no Keychain fallback: they are not secrets, but they are private, so each run's own environment
 *    must set them (see docs/beads.md).
 *
 * `FACTORY_NO_KEYCHAIN=1` skips the Keychain lookup, reading the environment only. A test sets this, so
 * it never shells out to the real `security` command. A real Keychain entry on the same machine as a
 * test run can hold a live credential; this flag keeps that value out of a test's own output (for
 * example an assertion failure that prints the whole return value).
 *
 * When a value is missing from every source it has, this function throws `CONNECT_SETUP_HELP`. It
 * never falls back to an interactive `op` call.
 */
export function resolveConnectCreds(env: NodeJS.ProcessEnv = process.env): ConnectCreds {
  const host = env.OP_CONNECT_HOST
  const vault = env.OP_CONNECT_VAULT
  const noKeychain = env.FACTORY_NO_KEYCHAIN === '1'
  const token = env.OP_CONNECT_TOKEN || (noKeychain ? undefined : keychainRead('op-connect-token'))
  const cfId = env.CF_ACCESS_CLIENT_ID || (noKeychain ? undefined : keychainRead('cf-access-client-id'))
  const cfSecret =
    env.CF_ACCESS_CLIENT_SECRET || (noKeychain ? undefined : keychainRead('cf-access-client-secret'))
  if (!host || !vault || !token || !cfId || !cfSecret) throw new Error(CONNECT_SETUP_HELP)
  return { host, vault, token, cfId, cfSecret }
}

const connectHeaders = (creds: ConnectCreds): Record<string, string> => ({
  'X-OP-Token': creds.token,
  'CF-Access-Client-Id': creds.cfId,
  'CF-Access-Client-Secret': creds.cfSecret,
})

/** This is the time limit on each fetch to the secret broker or the Linear API (claude-factory-b6c.22).
 * A broker or Linear endpoint can accept a connection and never answer. With no limit, that
 * endpoint can stall every rig's dispatch and label pass. `linearPass` holds `beads.lock` during
 * the wait.
 *
 * `FACTORY_LINEAR_FETCH_TIMEOUT_MS` can override this limit. `FACTORY_SELF_UPDATE_MS` (src/cli.ts)
 * uses the same pattern. A test can set this override. The override makes the timeout fire fast,
 * with no 30-second wait. Production code never sets it. */
const FETCH_TIMEOUT_MS = Number(process.env.FACTORY_LINEAR_FETCH_TIMEOUT_MS) || 30_000

/**
 * This is `fetch`, with `redirect: 'error'`. A 3xx response fails. It never forwards a request, or
 * its secret headers, to the redirect's own target host (claude-factory-b6c.28). Neither the secret
 * broker nor Linear's GraphQL endpoint sends a legitimate redirect.
 *
 * Bun's own error for this case names the request URL. `url` can be the secret broker's own private
 * host. This function replaces that error with a fixed, generic one. It keeps the URL out of a
 * caller's error text, out of a log, a bead, and mail (the same rule `redact()` applies elsewhere here).
 */
async function noRedirectFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error' })
  } catch (err) {
    if ((err as { code?: string }).code === 'UnexpectedRedirect') throw new Error('unexpected redirect')
    throw err
  }
}

async function connectGet(creds: ConnectCreds, path: string): Promise<unknown> {
  const res = await noRedirectFetch(`${creds.host}${path}`, {
    headers: connectHeaders(creds),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`secret broker request failed: ${res.status}`)
  return res.json()
}

/** The vault and item id, cached across calls in the same process. The loop caches only these ids,
 * never the key itself. */
export type ConnectCache = { vaultId?: string; itemId?: string }

// Error text below never echoes `creds.vault` or `ITEM_TITLE`: that would put a private name into a
// log, a bead, or mail. Each message is fixed, generic text instead.
async function resolveIds(
  creds: ConnectCreds,
  cache: ConnectCache,
): Promise<{ vaultId: string; itemId: string }> {
  if (!cache.vaultId) {
    const vaults = (await connectGet(creds, '/v1/vaults')) as { id: string; name?: string; title?: string }[]
    const vault = vaults.find(v => (v.name ?? v.title) === creds.vault)
    if (!vault) throw new Error('secret broker: the configured vault was not found')
    cache.vaultId = vault.id
  }
  if (!cache.itemId) {
    const filter = encodeURIComponent(`title eq "${ITEM_TITLE}"`)
    const items = (await connectGet(creds, `/v1/vaults/${cache.vaultId}/items?filter=${filter}`)) as {
      id: string
    }[]
    const item = items[0]
    if (!item) throw new Error('secret broker: the Linear key item was not found in the configured vault')
    cache.itemId = item.id
  }
  return { vaultId: cache.vaultId, itemId: cache.itemId }
}

/**
 * Fetches the Linear API key from the configured secret broker.
 * It reads the item named "LinearBotsApiKey", field "credential", from the configured vault.
 * This function holds the key in memory only.
 * The caller must give the key to `bd` as the `LINEAR_API_KEY` env value.
 * The caller must never write the key to disk, a log, a bead, or the journal.
 */
export async function resolveLinearApiKey(creds: ConnectCreds, cache: ConnectCache = {}): Promise<string> {
  const { vaultId, itemId } = await resolveIds(creds, cache)
  const item = (await connectGet(creds, `/v1/vaults/${vaultId}/items/${itemId}`)) as {
    fields?: { label?: string; value?: string }[]
  }
  const field = item.fields?.find(f => f.label === FIELD_LABEL)
  if (!field?.value) throw new Error('secret broker: the Linear key item has no "credential" field')
  return field.value
}

const LINEAR_ENV_KEYS = [
  'LINEAR_API_KEY',
  'LINEAR_OAUTH_CLIENT_ID',
  'LINEAR_OAUTH_CLIENT_SECRET',
  'LINEAR_TEAM_ID',
  'LINEAR_TEAM_IDS',
]

/**
 * This function makes the environment for the command `bd linear pull`.
 * It puts the resolved key in one environment variable, `LINEAR_API_KEY`.
 * It puts the rig's team ids in `LINEAR_TEAM_IDS`, comma-joined.
 * `bd linear pull` needs a configured team, even to pull named refs: with no `bd config
 * linear.team_id(s)` and no team env var, it fails `no Linear team ID configured`
 * (claude-factory-b6c.20).
 * It does not put the key or the team ids on disk, in the command-line arguments, or in a bead.
 *
 * This environment can still carry `LINEAR_API_KEY`, `LINEAR_OAUTH_CLIENT_ID`,
 * `LINEAR_OAUTH_CLIENT_SECRET`, `LINEAR_TEAM_ID`, or `LINEAR_TEAM_IDS` from an earlier operation.
 * This function removes each of these five variables first.
 * This stops a stale OAuth pair from outranking the key this function sets: `bd` prefers OAuth over
 * `LINEAR_API_KEY`. It also stops a stale team id from outranking the rig's own team ids.
 */
export function syncEnv(
  apiKey: string,
  teams: string[],
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const stripped = Object.fromEntries(Object.entries(base).filter(([k]) => !LINEAR_ENV_KEYS.includes(k)))
  return { ...stripped, LINEAR_API_KEY: apiKey, LINEAR_TEAM_IDS: teams.join(',') }
}

/** This is the argv for `bd linear pull <ref...>`.
 * Each ref is a Linear identifier, for example `STI-123`, never the issue's URL.
 * `bd` matches a ref against `issue.Identifier` exactly, so a URL never matches (claude-factory-b6c.19).
 * `routeLinearIssue`'s caller passes only the refs it has routed to this rig.
 * This argv must not include `--push` or the key: `bd linear pull` has no such flag. */
export const pullArgs = (refs: string[]): string[] => ['linear', 'pull', ...refs, '--json']

export type SyncOutcome = { pulled: number; created: number; updated: number } | { error: string }

/**
 * `bd linear pull <ref...> --json` (bd 1.3.0) returns one of three shapes.
 *
 * The first shape is a pull that ran clean. It has a `stats` object with the fields `pulled`,
 * `created`, `updated`, `skipped`, `errors`, and more. `skipped` and `errors` are both 0.
 *
 * The second shape is a pull that ran, but could not pull every ref. `bd` counts a ref it could
 * not find (for example, a URL instead of an identifier) in `stats.skipped`, and a ref whose fetch
 * failed in `stats.errors`. It prints a `Warning: ...` line on stderr for each one, but still exits
 * 0. This function treats `skipped > 0` or `errors > 0` as a failure too (claude-factory-b6c.21): a
 * silent `pulled 0` would hide a routing or auth bug that imports nothing.
 *
 * The third shape is an engine error. It has an `error` field and a nonzero exit code.
 *
 * A nonzero exit code that has none of these shapes is also an error. `stderr` is optional: when
 * stdout has no usable detail, the error message falls back to stderr's first line, so a crash with
 * empty stdout still names what failed.
 */
export function parseSync(stdout: string, exitCode: number, stderr = ''): SyncOutcome {
  const errDetail = () => stderr.trim().split('\n')[0]
  const warnLine = () =>
    stderr
      .split('\n')
      .find(l => l.trim().startsWith('Warning'))
      ?.trim()
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return {
      error:
        exitCode === 0
          ? 'bd linear pull: no JSON on stdout'
          : stdout.trim() || errDetail() || `bd linear pull exited ${exitCode}`,
    }
  }
  const j = json as Record<string, unknown>
  if (j?.error) return { error: String(j.error) }
  if (exitCode !== 0)
    return {
      error: errDetail()
        ? `bd linear pull exited ${exitCode}: ${errDetail()}`
        : `bd linear pull exited ${exitCode}`,
    }
  const s = (j?.stats as Record<string, number>) ?? {}
  const skipped = s.skipped ?? 0
  const errors = s.errors ?? 0
  if (skipped > 0 || errors > 0)
    return { error: warnLine() ?? `bd linear pull: skipped ${skipped}, errors ${errors}` }
  return { pulled: s.pulled ?? 0, created: s.created ?? 0, updated: s.updated ?? 0 }
}

const LINEAR_API_URL = () => process.env.LINEAR_API_URL || 'https://api.linear.app/graphql'

const ISSUES_QUERY = `
  query Issues($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(first: $first, after: $after, filter: $filter) {
      nodes { identifier updatedAt project { name } labels { nodes { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`

/** One Linear issue, as the loop lists it: its identifier (for example `STI-123`, the exact ref
 * `bd linear pull` takes: `bd` matches a pull ref against `issue.Identifier` exactly, so a URL or
 * any other form never matches, claude-factory-b6c.19), its project name, if any, its label
 * names, and its `updatedAt` (an ISO-8601 string, used to pull only changed issues, claude-factory-b6c.24). */
export type LinearIssueRef = LinearIssue & { ref: string; updatedAt: string }

/** A real Linear identifier's own shape: letters and digits, a dash, then digits (for example
 * `STI-123`). `fetchLinearIssues` checks every `identifier` the API returns against this shape.
 * Reason (claude-factory-b6c.29): with no check, a ref that starts with `-` would reach `bd linear
 * pull <ref...>`'s argv as an unintended flag. */
const REF_SHAPE = /^[A-Za-z0-9]+-[0-9]+$/

type IssuesPage = {
  data?: {
    issues?: {
      nodes: {
        identifier: string
        updatedAt: string
        project?: { name: string } | null
        labels?: { nodes: { name: string }[] }
      }[]
      pageInfo: { hasNextPage: boolean; endCursor: string }
    }
  }
  errors?: { message: string }[]
}

/** What `fetchLinearIssues` found: the issues themselves, and whether it stopped at the 50-page
 * cap with more pages still unread (claude-factory-b6c.24). A caller must not treat `truncated:
 * true` as a complete listing: the unrouted count, and the incremental `updatedAt` cutoff, both
 * undercount when some of a team's issues never reached this list. */
export type LinearIssuesPage = { issues: LinearIssueRef[]; truncated: boolean }

/**
 * Lists every issue of the given Linear team(s): its identifier, its `updatedAt`, its project
 * name, if any, and its label names. This is a read: it never creates, updates, or closes a
 * Linear issue.
 *
 * `bd` has no project or label filter on a pull (claude-factory-b6c.18), so the loop lists issues
 * itself, routes each one in its own code (`routeLinearIssue`), then asks `bd` to pull only the
 * routed refs. `endpoint` defaults to Linear's own API; a test overrides it with a fake server.
 *
 * This stops after 50 pages (5,000 issues at 100 per page), a safety bound against a malformed
 * response that never reports its last page. When the team genuinely has more, the result's
 * `truncated` is `true` instead of a silent drop (claude-factory-b6c.24).
 */
export async function fetchLinearIssues(
  apiKey: string,
  teamIds: string[],
  endpoint: string = LINEAR_API_URL(),
): Promise<LinearIssuesPage> {
  const issues: LinearIssueRef[] = []
  let after: string | undefined
  let truncated = false
  for (let page = 0; page < 50; page++) {
    // claude-factory-b6c.28: a redirect would forward the Authorization header (the Linear API key)
    // to whatever host it names. Linear's own GraphQL endpoint never sends a legitimate redirect.
    const res = await noRedirectFetch(endpoint, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: ISSUES_QUERY,
        variables: { filter: { team: { id: { in: teamIds } } }, first: 100, after },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Linear API request failed: ${res.status}`)
    const json = (await res.json()) as IssuesPage
    if (json.errors?.length) throw new Error(`Linear API error: ${json.errors[0]!.message}`)
    const page_ = json.data?.issues
    if (!page_) throw new Error('Linear API: no issues in response')
    for (const n of page_.nodes) {
      // claude-factory-b6c.29: a `ref` goes straight into `bd linear pull <ref...>`'s argv (no
      // shell runs, but a ref shaped like a flag, for example "--force", would still reach bd as
      // one). This check fails the whole pass instead of silently dropping the bad ref.
      if (!REF_SHAPE.test(n.identifier))
        throw new Error(`Linear API: issue identifier "${n.identifier.slice(0, 40)}" is not shaped <KEY>-<n>`)
      issues.push({
        ref: n.identifier,
        updatedAt: n.updatedAt,
        project: n.project?.name,
        labels: n.labels?.nodes.map(l => l.name) ?? [],
      })
    }
    if (!page_.pageInfo.hasNextPage) break
    after = page_.pageInfo.endCursor
    if (page === 49) truncated = true
  }
  return { issues, truncated }
}

const TOKEN_SHAPE = /lin_(api|oauth)_\S+/g
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g

// This function cleans error text before the text goes into a log, a bead, or mail.
// It removes each secret value named in `secrets`.
// A failed resolver can leave `secrets` empty or miss one value, while its own error text
// still carries a token (security#1.14). This function also removes any text shaped like
// a Linear key or OAuth secret, so a token stays hidden even then.
// It also removes control characters, for example an ANSI escape code (security#1.15).
// It then cuts the text to 200 characters, when the text is longer than that.
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets.filter(Boolean)) out = out.split(s).join('***')
  out = out.replace(TOKEN_SHAPE, '***').replace(CONTROL_CHARS, '')
  return out.length > 200 ? `${out.slice(0, 200)}…` : out
}
