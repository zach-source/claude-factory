// `factory ui`: a local web page for the beads of every rig. It binds 127.0.0.1 only and never pushes.
// The pure counting is in ui-data.ts. The page is src/ui.html. See docs/ui.md.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBounded, syncTimeoutMs } from './sync'
import {
  count,
  epicRows,
  etagMatches,
  etagOf,
  hashOf,
  isStale,
  needBeads,
  oneOffs,
  overall,
  pullArgv,
  singleFlight,
  sortNeeds,
  unchanged,
  type Counts,
  type EpicRow,
  type Issue,
  type NeedItem,
  type SyncState,
} from './ui-data'

export type UiRig = { name: string; repo: string; beadsRemote?: { name: string; user: string } }
/** What the API serves for a rig. A refresh makes a new one. The page never makes bd run. */
export type Snapshot = {
  /** the Dolt main commit that `issues` came from */
  hash: string | null
  /** the last time the data was known current: a read, or a check that found the same hash, with no failed sync */
  asOf?: number
  issues: Issue[]
  view: {
    totals: Counts
    overall: Counts
    epics: EpicRow[]
    epicRows: EpicRow[]
    oneOffs: number
    needs: NeedItem[]
  }
  sync: SyncState
  error?: string
}

export const SYNC_EVERY_MS = 10 * 60_000
const HOST = '127.0.0.1'
const empty = (): Snapshot => snapshot([], null, undefined, { state: 'never' })

/** the file of a rig's snapshot: the rig name with every character outside [A-Za-z0-9_.-] made `_` */
export const cacheFile = (dir: string, rig: string) => join(dir, `${rig.replace(/[^\w.-]/g, '_')}.json`)

/** every rig that has a beads store in its repo */
export const withBeads = <R extends { repo: string }>(rigs: R[]) =>
  rigs.filter(r => existsSync(join(r.repo, '.beads')))

/** pull the rig's beads from its Dolt remote. It returns the sync state, and it never throws */
async function pull(rig: UiRig): Promise<SyncState> {
  const at = Date.now()
  if (!rig.beadsRemote) return { state: 'skipped', at, message: 'no beadsRemote in rigs.json' }
  const timeoutMs = syncTimeoutMs()
  try {
    const show = await runBounded(['bd', 'dolt', 'show', '--json'], { cwd: rig.repo, timeoutMs })
    if (show.code !== 0) throw new Error(`bd dolt show: ${show.err.trim().split('\n').at(-1) || 'failed'}`)
    const argv = pullArgv(rig.beadsRemote, JSON.parse(show.out))
    if (!argv) throw new Error('beadsRemote name or user has a character outside [A-Za-z0-9_.-]')
    const env = { ...process.env, DOLT_CLI_PASSWORD: process.env.BEADS_DOLT_PASSWORD ?? '' }
    const p = await runBounded(argv, { cwd: rig.repo, env, timeoutMs })
    if (p.timedOut) throw new Error(`pull timed out after ${timeoutMs} ms`)
    if (p.code !== 0) throw new Error(p.err.trim().split('\n').at(-1) || 'pull failed')
    return { state: 'ok', at }
  } catch (e) {
    return { state: 'failed', at, message: e instanceof Error ? e.message : String(e) }
  }
}

/** the computed progress is part of the snapshot, so the API only copies it */
function snapshot(
  issues: Issue[],
  hash: string | null,
  asOf: number | undefined,
  sync: SyncState,
  error?: string,
): Snapshot {
  const rows = epicRows(issues)
  return {
    hash,
    asOf,
    // the dependencies are used above, then dropped: they are most of the bytes of a row
    issues: issues.map(({ dependencies: _d, ...i }) => i),
    view: {
      totals: count(issues),
      overall: overall(issues),
      epics: rows.filter(e => e.depth === 0 && e.counts.total > 0),
      epicRows: rows,
      oneOffs: oneOffs(issues).length,
      // the rig name is set when the API serves it
      needs: needBeads(issues, ''),
    },
    sync,
    ...(error && { error }),
  }
}

/** the Dolt main commit of the rig, or null when bd cannot tell */
async function mainHash(rig: UiRig): Promise<string | null> {
  const p = await runBounded(['bd', 'sql', '--json', "SELECT DOLT_HASHOF('main') AS h"], {
    cwd: rig.repo,
    timeoutMs: syncTimeoutMs(),
  })
  return p.code === 0 ? hashOf(p.out) : null
}

/** the bead rows, or an error text */
async function list(rig: UiRig): Promise<{ issues: Issue[] } | { error: string }> {
  const p = await runBounded(['bd', 'list', '--all', '--json', '--limit', '0'], {
    cwd: rig.repo,
    timeoutMs: syncTimeoutMs(),
  })
  if (p.code !== 0) return { error: p.err.trim().split('\n').at(-1) || 'bd list failed' }
  try {
    const data = JSON.parse(p.out || '[]')
    return { issues: Array.isArray(data) ? data : (data.issues ?? []) }
  } catch {
    return { error: 'bd list gave no JSON' }
  }
}

/**
 * The next snapshot of a rig from the previous one. It skips `bd list` when the main commit did not change.
 * Pure but for `deps`, so the tests can pass fakes.
 */
export async function nextSnapshot(
  prev: Snapshot,
  sync: SyncState,
  deps: {
    hash: () => Promise<string | null>
    list: () => Promise<{ issues: Issue[] } | { error: string }>
    now: () => number
  },
): Promise<Snapshot> {
  const hash = await deps.hash()
  const at = sync.state === 'failed' ? prev.asOf : deps.now()
  if (unchanged(prev.hash, hash) && !prev.error) return { ...prev, asOf: at, sync }
  const r = await deps.list()
  // a failed read keeps the old rows and the old as-of time, and shows the error on the card
  if ('error' in r) return { ...prev, sync, error: r.error }
  return snapshot(r.issues, hash, at, sync)
}

/** a snapshot from disk, or null when the file is absent or does not parse */
function readCache(dir: string, rig: string): Snapshot | null {
  try {
    const s = JSON.parse(readFileSync(cacheFile(dir, rig), 'utf8'))
    return Array.isArray(s.issues) && Array.isArray(s.view?.needs) && s.sync ? s : null
  } catch {
    return null
  }
}

/** write by a temp file and a rename, so a crash never leaves half a file. A failed write is not an error. */
function writeCache(dir: string, rig: string, s: Snapshot) {
  try {
    mkdirSync(dir, { recursive: true })
    const f = cacheFile(dir, rig)
    writeFileSync(`${f}.tmp`, JSON.stringify(s))
    renameSync(`${f}.tmp`, f)
  } catch {}
}

const json = (req: Request, v: unknown) => {
  const body = JSON.stringify(v)
  const etag = etagOf(body)
  const headers = { etag, 'cache-control': 'no-cache' }
  return etagMatches(req.headers.get('if-none-match'), etag)
    ? new Response(null, { status: 304, headers })
    : new Response(body, { headers: { ...headers, 'content-type': 'application/json' } })
}
const err = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export function startUi(opts: {
  rigs: UiRig[]
  port: number
  sync: boolean
  cacheDir?: string
  /** the factory runs that wait on a person (waitingItems in src/sidebar.ts); read from local run state */
  runNeeds?: () => Promise<NeedItem[]>
}) {
  const page = readFileSync(new URL('./ui.html', import.meta.url), 'utf8')
  // the disk snapshots first, so the page has data before the first sync ends
  const snaps = new Map<string, Snapshot>(
    opts.rigs.map(r => [r.name, (opts.cacheDir && readCache(opts.cacheDir, r.name)) || empty()]),
  )
  const flights = new Map<string, Promise<void>>()

  /** one refresh of one rig. A call while one runs for that rig joins it. */
  const refreshRig = (rig: UiRig, pullFirst: boolean) =>
    singleFlight(flights, rig.name, async () => {
      const prev = snaps.get(rig.name)!
      const sync = pullFirst ? await pull(rig) : prev.sync
      const next = await nextSnapshot(prev, sync, {
        hash: () => mainHash(rig),
        list: () => list(rig),
        now: Date.now,
      })
      snaps.set(rig.name, next)
      if (opts.cacheDir) writeCache(opts.cacheDir, rig.name, next)
    })
  let runItems: NeedItem[] = []
  let runError: string | undefined
  const refreshRuns = () =>
    singleFlight(flights, '(runs)', async () => {
      try {
        runItems = (await opts.runNeeds?.()) ?? []
        runError = undefined
      } catch (e) {
        runError = e instanceof Error ? e.message : String(e)
      }
    })
  const refreshAll = (pullFirst: boolean) =>
    Promise.all([refreshRuns(), ...opts.rigs.map(r => refreshRig(r, pullFirst))]).then(() => {})
  /** every item that waits on a person, oldest first. The bead items come from the rig snapshots. */
  const needs = () =>
    sortNeeds([
      ...runItems,
      ...opts.rigs.flatMap(r => snaps.get(r.name)!.view.needs.map(n => ({ ...n, rig: r.name }))),
    ])

  const summary = (rig: UiRig) => {
    const s = snaps.get(rig.name)!
    const { totals, overall, epics, oneOffs } = s.view
    return {
      name: rig.name,
      totals,
      overall,
      epics,
      oneOffs,
      sync: s.sync,
      error: s.error,
      asOf: s.asOf,
      stale: isStale(s.asOf, Date.now(), SYNC_EVERY_MS),
      syncing: flights.has(rig.name),
      needs: needs().filter(n => n.rig === rig.name).length,
    }
  }

  const server = Bun.serve({
    hostname: HOST,
    port: opts.port,
    fetch: async req => {
      const url = new URL(req.url)
      // a page on another site must not read this server through DNS rebinding
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.get('host') ?? ''))
        return err(403, 'bad host')
      if (url.pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        await refreshAll(opts.sync)
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === '/api/needs') {
        const items = needs()
        return json(req, { count: items.length, items, error: runError })
      }
      if (url.pathname === '/api/rigs') return json(req, { rigs: opts.rigs.map(summary) })
      const m = url.pathname.match(/^\/api\/rigs\/([^/]+)$/)
      const rig = m && opts.rigs.find(r => r.name === decodeURIComponent(m[1]!))
      if (rig) {
        const s = snaps.get(rig.name)!
        return json(req, {
          ...summary(rig),
          epicRows: s.view.epicRows,
          issues: s.issues,
          needItems: needs().filter(n => n.rig === rig.name),
        })
      }
      return err(404, 'not found')
    },
  })
  void refreshAll(opts.sync)
  const timer = opts.sync ? setInterval(() => void refreshAll(true), SYNC_EVERY_MS) : undefined
  return { server, stop: () => (clearInterval(timer), server.stop(true)) }
}
