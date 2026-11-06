// Pure core of `factory ui`: counts and epic progress from a rig's `bd list --all --json` rows.
// The counting rules are those of the epic-progress script: a bead that is not an epic counts
// under every epic above it at all depths, a sub-epic shows indented, and an open bead with no
// parent bead is a one-off.

export type Issue = {
  id: string
  title: string
  status?: string
  issue_type?: string
  priority?: number
  parent?: string
  assignee?: string
  labels?: string[]
  description?: string
  acceptance_criteria?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  close_reason?: string
  /** `bd list --json` rows carry these: this bead depends on `depends_on_id` (type `blocks` or `parent-child`) */
  dependencies?: { depends_on_id: string; type?: string }[]
}

export const STATUSES = ['closed', 'in_progress', 'blocked', 'deferred', 'open'] as const
export type Status = (typeof STATUSES)[number]
export type Counts = Record<Status, number> & { total: number }

/** a status that is not in STATUSES counts as open, as the epic-progress script does */
export const bucket = (s?: string): Status =>
  (STATUSES as readonly string[]).includes(s ?? '') ? (s as Status) : 'open'

export const count = (issues: Issue[]): Counts => {
  const c: Counts = { closed: 0, in_progress: 0, blocked: 0, deferred: 0, open: 0, total: issues.length }
  for (const i of issues) c[bucket(i.status)]++
  return c
}

export type EpicRow = {
  id: string
  title: string
  status: string
  priority: number
  depth: number
  counts: Counts
  /** ids of the beads that count under this epic */
  beads: string[]
}

const index = (issues: Issue[]) => {
  const byId = new Map(issues.map(i => [i.id, i]))
  const kids = new Map<string, Issue[]>()
  for (const i of issues)
    if (i.parent && byId.has(i.parent)) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i])
  return { byId, kids }
}

/** the beads that are not epics, anywhere under an epic */
const leaves = (id: string, kids: Map<string, Issue[]>): Issue[] =>
  (kids.get(id) ?? []).flatMap(k => (k.issue_type === 'epic' ? leaves(k.id, kids) : [k]))

const byPriority = (a: Issue, b: Issue) => (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id)

/**
 * The epics in display order. A top epic has no epic as its parent. Its sub-epics follow it with
 * depth + 1. Open epics come first. `showClosed` false drops the closed epics.
 */
export function epicRows(issues: Issue[], showClosed = false): EpicRow[] {
  const { byId, kids } = index(issues)
  const shown = (e: Issue) => showClosed || e.status !== 'closed'
  const row = (e: Issue, depth: number): EpicRow[] => {
    const l = leaves(e.id, kids)
    const sub = (kids.get(e.id) ?? [])
      .filter(k => k.issue_type === 'epic' && shown(k))
      .sort(byPriority)
      .flatMap(k => row(k, depth + 1))
    return [
      {
        id: e.id,
        title: e.title,
        status: e.status ?? 'open',
        priority: e.priority ?? 9,
        depth,
        counts: count(l),
        beads: l.map(i => i.id),
      },
      ...sub,
    ]
  }
  return issues
    .filter(e => e.issue_type === 'epic' && byId.get(e.parent ?? '')?.issue_type !== 'epic' && shown(e))
    .sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || byPriority(a, b))
    .flatMap(e => row(e, 0))
}

/** the unique beads under the top epics that show: the "Overall" line of the epic-progress script */
export function overall(issues: Issue[], showClosed = false): Counts {
  const { kids } = index(issues)
  const seen = new Map<string, Issue>()
  for (const r of epicRows(issues, showClosed))
    if (r.depth === 0) for (const l of leaves(r.id, kids)) seen.set(l.id, l)
  return count([...seen.values()])
}

/** open beads that are not epics and have no parent bead */
export function oneOffs(issues: Issue[]): Issue[] {
  const { byId } = index(issues)
  return issues
    .filter(i => i.issue_type !== 'epic' && i.status !== 'closed' && !byId.has(i.parent ?? ''))
    .sort(byPriority)
}

export type SyncState = { state: 'never' | 'ok' | 'failed' | 'skipped'; at?: number; message?: string }

/**
 * The argv of a pull from the rig's Dolt remote, run as the remote's user. It only pulls: no push, and
 * no local commit. A name or user outside [A-Za-z0-9_.-] gives null, since both go into SQL text.
 */
export function pullArgv(
  remote: { name: string; user: string },
  conn: { host: string; port: number; database: string; user: string; tls: boolean },
): string[] | null {
  if (![remote.name, remote.user].every(s => /^[\w.-]+$/.test(s))) return null
  return [
    ...['dolt', '--host', conn.host, '--port', String(conn.port), '--user', conn.user],
    ...(conn.tls ? [] : ['--no-tls']),
    ...['--use-db', conn.database, 'sql', '-q'],
    `CALL DOLT_PULL('--user', '${remote.user}', '${remote.name}', 'main')`,
  ]
}

/** the re-read of a rig can be skipped when its Dolt main commit is the one the snapshot holds */
export const unchanged = (cached: string | null | undefined, now: string | null) =>
  !!cached && !!now && cached === now

/** the commit hash in the output of `SELECT DOLT_HASHOF('main')` (32 chars, base32), or null */
export const hashOf = (out: string): string | null => out.match(/\b[0-9a-v]{32}\b/)?.[0] ?? null

/**
 * Single flight: one run of `fn` for each key at a time. A call while a run is open joins that run.
 * `flights` is the map of the open runs.
 */
export function singleFlight<T>(
  flights: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const open = flights.get(key)
  if (open) return open
  const p = fn().finally(() => flights.delete(key))
  flights.set(key, p)
  return p
}

/** a snapshot is stale when its as-of time is older than twice the sync period, or when it has none */
export const isStale = (asOf: number | undefined, now: number, everyMs: number) =>
  asOf === undefined || now - asOf > 2 * everyMs

/** a strong ETag of a body: 64-bit FNV-1a in hex, in quotes. Fast, and not for security. */
export function etagOf(body: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < body.length; i++)
    h = BigInt.asUintN(64, (h ^ BigInt(body.charCodeAt(i))) * 0x100000001b3n)
  return `"${h.toString(16)}"`
}

/** whether an If-None-Match header holds the ETag (a list, `*`, or a weak form all count) */
export const etagMatches = (header: string | null, etag: string) =>
  !!header && header.split(',').some(t => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag)

/** one thing that waits on a person. `since` is a time in ms, when it is known. */
export type NeedItem = {
  kind: 'run' | 'ship' | 'owner' | 'human'
  rig: string
  id: string
  title: string
  since?: number
  prs: string[]
  /** run: the hold, the station and the command that answers */
  hold?: string
  station?: string
  bead?: string
  answer?: string
  /** owner and human beads: how many open beads this one blocks */
  blocks?: number
  priority?: number
}

/**
 * The open beads that wait on a person: label `owner` or label `human`. Each has the number of open beads
 * that depend on it with a `blocks` dependency. The rows already carry their dependencies, so this needs
 * no bd call for each bead. The age is the bead's created_at: the rows do not say when the label was added.
 */
export function needBeads(issues: Issue[], rig: string): NeedItem[] {
  const open = issues.filter(i => i.status === 'open')
  const blocked = new Map<string, number>()
  for (const i of open)
    for (const d of i.dependencies ?? [])
      if (d.type === 'blocks') blocked.set(d.depends_on_id, (blocked.get(d.depends_on_id) ?? 0) + 1)
  return open.flatMap(i => {
    const kind = i.labels?.includes('owner') ? 'owner' : i.labels?.includes('human') ? 'human' : null
    if (!kind) return []
    const at = Date.parse(i.created_at ?? '')
    return [
      {
        kind,
        rig,
        id: i.id,
        title: i.title,
        since: Number.isFinite(at) ? at : undefined,
        prs: [],
        blocks: blocked.get(i.id) ?? 0,
        priority: i.priority,
      },
    ]
  })
}

/** oldest first; an item with no time goes last, then by rig and id so the order is stable */
export const sortNeeds = (items: NeedItem[]): NeedItem[] =>
  [...items].sort(
    (a, b) =>
      (a.since ?? Infinity) - (b.since ?? Infinity) || a.rig.localeCompare(b.rig) || a.id.localeCompare(b.id),
  )
