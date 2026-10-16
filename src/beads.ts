// Beads (bd) as the factory's task tracker. A run's bead is its epic: claimed by the run, its
// station reports mirrored as comments, closed (or deferred for a person) when the run ends.
// The plan's tasks are the bead's children. In a rig, ready beads labeled `factory`
// become runs. Claiming decides who owns work; everything else is best-effort bookkeeping.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type Bead = {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  labels?: string[]
  parent?: string
  status?: string
  close_reason?: string
  assignee?: string
  priority?: number
  issue_type?: string
  metadata?: Record<string, unknown>
  /** `bd blocked` only: the beads whose open work holds this one back */
  blocked_by?: string[]
  /** ISO timestamps `bd show`/`bd list --json` carry; plan.ts's findings read these for progress */
  created_at?: string
  started_at?: string
  closed_at?: string
  /** `bd linear pull` writes this to the issue's Linear URL; a person-made bead never carries one */
  external_ref?: string
}

export const LABEL = 'factory'
/** a bead a station rejected: open, out of the queue until a person queues it again */
export const REJECTED = 'rejected'
export const hasBeads = (repo: string) => existsSync(join(repo, '.beads'))
/** the run owns its bead under this name; its workers write as `<actor>/<station>` */
export const actorOf = (runId: string) => `factory/${runId}`

/** what a run is asked to do, from its bead */
export const goalOf = (b: Bead) =>
  [`${b.id}: ${b.title}`, b.description, b.acceptance_criteria && `Acceptance: ${b.acceptance_criteria}`]
    .filter(Boolean)
    .join('\n\n')

/** its owner recorded decisions governing it (fabriek's pilots): the owner hands it out, not the factory */
export const isOwned = (b: Bead) => !!b.metadata?.owner_decisions

/**
 * True when `bd linear pull` set this bead's `external_ref` to a Linear issue URL.
 * `bd` copies every Linear label onto the bead, with no filter.
 * Anyone with Linear write access can set such a label (claude-factory-b6c.27).
 */
export const linearSourced = (b: Bead) => !!b.external_ref?.toLowerCase().includes('linear.app')

/**
 * A `station:<name>` label starts the run there, not at the factory's start station.
 * A person adds this label by hand: `bd create ... -l station:<name>`.
 * A Linear-sourced bead (`linearSourced`) never uses this label to pick a station.
 * A Linear-side label must never skip the stations before the named one (claude-factory-b6c.27).
 * A person can still send such a run to a chosen station, with `factory fork <run> <station>`.
 */
export const stationOf = (b: Bead) =>
  (!linearSourced(b) && b.labels?.find(l => l.startsWith('station:'))?.slice('station:'.length)) || undefined

/** a bead's parent: bd's parent-child edge, else the id's own `<parent>.<n>` */
export const parentOf = (b: Bead) =>
  b.parent ?? (/\.\d+$/.test(b.id) ? b.id.replace(/\.\d+$/, '') : undefined)

/** a bead as the Backlog tab draws it, with the tree around it */
export type SlimBead = {
  id: string
  title: string
  priority?: number
  type?: string
  labels?: string[]
  parent?: string
  /** its children closed and in all, counting the ones no longer listed */
  children?: { done: number; total: number }
  /** the open beads it waits on */
  blockedBy?: string[]
}

/**
 * The Backlog's two lists from one rig's bd listings (ready, blocked, every bead), no call per bead.
 * A blocked bead is listed too, marked with its open blockers: labeled, or a child of a queued one, it
 * waits in the queue; otherwise it waits for a person. Claimed and deferred beads are not backlog.
 */
export function backlogOf(
  ready: Bead[],
  unqueued: Bead[],
  blocked: Bead[],
  all: Bead[],
): { queued: SlimBead[]; unqueued: SlimBead[] } {
  const counts = new Map<string, { done: number; total: number }>()
  for (const x of all) {
    const p = parentOf(x)
    if (p) {
      const c = counts.get(p) ?? { done: 0, total: 0 }
      counts.set(p, { done: c.done + (x.status === 'closed' ? 1 : 0), total: c.total + 1 })
    }
  }
  const isOpen = new Set(all.filter(x => x.status !== 'closed').map(x => x.id))
  const slim = (x: Bead): SlimBead => ({
    id: x.id,
    title: x.title,
    priority: x.priority,
    type: x.issue_type,
    labels: x.labels,
    parent: parentOf(x),
    children: counts.get(x.id),
    blockedBy: x.blocked_by?.filter(id => isOpen.has(id)),
  })
  const waiting = blocked.filter(
    x => !x.assignee && (x.status === undefined || ['open', 'blocked'].includes(x.status)),
  )
  const heads = new Set(dispatchable(ready, new Set(), 50).map(x => x.id))
  const queuedWaiting = waiting.filter(x => !x.parent && x.labels?.includes(LABEL))
  for (const x of queuedWaiting) heads.add(x.id)
  // a queued bead's children ride in its run: listed under it, never started on their own
  const isQueued = (x: Bead) => heads.has(x.id) || (!x.assignee && heads.has(parentOf(x) ?? ''))
  const inQueue = [...ready, ...waiting].filter(isQueued)
  const queuedIds = new Set(inQueue.map(x => x.id))
  return {
    queued: inQueue.map(slim),
    unqueued: [...unqueued, ...waiting.filter(x => !queuedIds.has(x.id) && !x.labels?.includes(LABEL))].map(
      slim,
    ),
  }
}

/** unowned top-level work only: a child is a task of some run's plan (children inherit the label) */
export const dispatchable = (ready: Bead[], linked: Set<string>, room: number) =>
  ready.filter(b => !b.parent && !b.assignee && !linked.has(b.id)).slice(0, Math.max(0, room))

function bd(repo: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(['bd', ...args, '--actor', actor], { cwd: repo, env: process.env })
  const out = p.stdout.toString().trim()
  const stderr = p.stderr.toString().trim()
  return { isOk: p.exitCode === 0, out, err: stderr || out, stderr }
}
const must = (r: ReturnType<typeof bd>, what: string) => {
  if (!r.isOk) throw new Error(`bd ${what}: ${r.err.split('\n')[0]}`)
  return r.out
}

export const beads = (repo: string, actor: string) => ({
  prefix: () => {
    const r = bd(repo, actor, 'config', 'get', 'issue_prefix')
    return r.isOk ? r.out : ''
  },
  show: (id: string): Bead | null => {
    const r = bd(repo, actor, 'show', id, '--json')
    const parsed = r.isOk ? JSON.parse(r.out) : null
    return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
  },
  /**
   * null only for bd's own "not found" (a real answer); any other failure (a timeout, bd down) throws
   * instead of being indistinguishable from a 404. For a goal that is shaped like one of this rig's own
   * bead ids, a failed lookup must never fall through to creating a bead titled with the id itself.
   *
   * bd 1.3.0 prints the *same* "no issues found matching the provided IDs" JSON body on stdout, exit 1,
   * both for a genuine not-found and for a query-time failure after the store opened (e.g. a timeout) --
   * the stdout body alone cannot tell them apart. Only stderr can: a real not-found says exactly
   * "Issue <id> not found" (plus a "Hint:" line); a query-time failure says "Error fetching <id>: <err>"
   * instead. A loose /not found/i match on stderr is not enough: a store-open failure (the shared server
   * up but this rig's own database missing) also says "not found" -- "database ... not found on Dolt
   * server at ..." -- and must throw, not read as a genuine not-found.
   */
  lookup: (id: string): Bead | null => {
    const r = bd(repo, actor, 'show', id, '--json')
    if (r.isOk) {
      const parsed = JSON.parse(r.out)
      return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
    }
    if (/^Error fetching\b/m.test(r.stderr)) throw new Error(`bd show ${id}: ${r.stderr.split('\n')[0]}`)
    if (/^Issue \S+ not found$/m.test(r.stderr)) return null
    throw new Error(`bd show ${id}: ${(r.stderr || r.out).split('\n')[0]}`)
  },
  /** the rig's bead-id prefix, thrown on failure instead of prefix()'s lenient "" (bd down looks the same as no prefix) */
  prefixStrict: () => must(bd(repo, actor, 'config', 'get', 'issue_prefix'), 'config get issue_prefix'),
  ready: (): Bead[] =>
    JSON.parse(must(bd(repo, actor, 'ready', '--label', LABEL, '--json', '-n', '50'), 'ready')),
  /** ready work nobody has handed to the factory yet: what a person prioritizes, children with their parents */
  unqueued: (): Bead[] =>
    (JSON.parse(must(bd(repo, actor, 'ready', '--json', '-n', '100'), 'ready')) as Bead[]).filter(
      b => !b.assignee && !b.labels?.includes(LABEL),
    ),
  /** open work held back by an open bead, each with `blocked_by`; bd prints null when none */
  blocked: (): Bead[] => {
    const out = must(bd(repo, actor, 'blocked', '--json'), 'blocked')
    return out === 'null' ? [] : JSON.parse(out)
  },
  /** every bead, closed too, without the free text: one listing for the Backlog's child counts */
  every: (): Bead[] => {
    const out = must(bd(repo, actor, 'list', '--all', '--brief', '--json', '-n', '0'), 'list')
    return out === 'null' ? [] : JSON.parse(out)
  },
  /** beads flagged for a human decision (`bd human`): bd prints null, not [], when none are */
  human: (): Bead[] => {
    const out = must(bd(repo, actor, 'human', 'list', '--json'), 'human list')
    return out === 'null' ? [] : JSON.parse(out)
  },
  /** ready, unassigned beads that are the owner's call to start, not the factory's */
  owned: (): Bead[] =>
    (JSON.parse(must(bd(repo, actor, 'ready', '--json', '-n', '100'), 'ready')) as Bead[]).filter(
      b => isOwned(b) && !b.assignee,
    ),
  /** answers a human-flagged bead: a comment, and bd closes it */
  respond: (id: string, text: string) =>
    must(bd(repo, actor, 'human', 'respond', id, '-r', text), 'human respond'),
  /** hands a bead to the factory: a rig starts it at the next dispatch, a rejected one too */
  queue: (id: string, station?: string) =>
    must(
      bd(
        repo,
        actor,
        'update',
        id,
        '--add-label',
        LABEL,
        '--remove-label',
        REJECTED,
        ...(station ? ['--add-label', `station:${station}`] : []),
      ),
      'update',
    ),
  /** atomic: false when someone else holds it */
  claim: (id: string) => bd(repo, actor, 'update', id, '--claim').isOk,
  /**
   * a create bd itself may have lost the answer to (a timeout after the write landed): tags the attempt
   * with a token in its metadata, so a failure is checked against that token before any retry, instead of
   * risking a silent duplicate. One retry only: a second failure's caller re-runs by hand.
   */
  create: (title: string, description: string, ...extra: string[]) => {
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const attempt = () =>
      bd(
        repo,
        actor,
        'create',
        title,
        '-d',
        description,
        '-l',
        LABEL,
        '--silent',
        '--metadata',
        `{"factory_create":"${token}"}`,
        ...extra,
      )
    const landed = (afterErr: string) => {
      const r = bd(
        repo,
        actor,
        'list',
        '--all',
        '--metadata-field',
        `factory_create=${token}`,
        '--json',
        '-n',
        '2',
      )
      if (!r.isOk)
        throw new Error(
          `bd create: ${afterErr}; it may have landed: bd list --all --metadata-field factory_create=${token}`,
        )
      return (JSON.parse(r.out) as Bead[])[0]?.id
    }
    let r = attempt()
    if (r.isOk) return r.out
    let found = landed(r.err.split('\n')[0] ?? '')
    if (found) return found
    r = attempt() // absent: one retry, same token, then give up
    if (r.isOk) return r.out
    found = landed(r.err.split('\n')[0] ?? '')
    if (found) return found
    throw new Error(`bd create: ${r.err.split('\n')[0]}`)
  },
  /**
   * keeps the claim's lease alive, taking it back if a reaper reclaimed it. Lost only when the bead
   * names another assignee: bd being unreachable (a shared server's maintenance lock) throws instead
   */
  heartbeat: (id: string) => {
    if (bd(repo, actor, 'heartbeat', id).isOk || bd(repo, actor, 'update', id, '--claim').isOk) return true
    const r = bd(repo, actor, 'show', id, '--json')
    const b = r.isOk ? [JSON.parse(r.out)].flat()[0] : null
    if (!b) throw new Error(`bd unavailable, the claim is kept and retried: ${r.err.split('\n')[0]}`)
    return !b.assignee || b.assignee === actor
  },
  comment: (id: string, text: string) => must(bd(repo, actor, 'comment', id, text), 'comment'),
  /** false when bd refuses, e.g. while the bead still has open tasks */
  close: (id: string, reason: string) => bd(repo, actor, 'close', id, '--reason', reason).isOk,
  /** unassigned and out of bd ready until a person undefers it, which hands it back to the factory */
  defer: (id: string, reason: string) => {
    bd(repo, actor, 'unclaim', id)
    return must(bd(repo, actor, 'defer', id, '--reason', reason), 'defer')
  },
  /**
   * a station judged it not the factory's to do: still open and ready for a person, but out of the factory's
   * queue (`queue` puts it back), labeled and with who said so, when and why
   */
  reject: (id: string, by: string, reason: string) => {
    bd(repo, actor, 'unclaim', id)
    return must(
      bd(
        repo,
        actor,
        'update',
        id,
        '--remove-label',
        LABEL,
        '--add-label',
        REJECTED,
        '--set-metadata',
        `rejected_by=${by}`,
        '--set-metadata',
        `rejected_at=${new Date().toISOString()}`,
        '--set-metadata',
        `reject_reason=${reason}`,
      ),
      'update',
    )
  },
  /** a revived run takes its bead back from closed or deferred */
  reopen: (id: string) => {
    bd(repo, actor, 'reopen', id)
    bd(repo, actor, 'undefer', id)
    return bd(repo, actor, 'update', id, '--claim').isOk
  },
  release: (id: string) => bd(repo, actor, 'unclaim', id).isOk,
  children: (id: string): Bead[] => {
    const r = bd(repo, actor, 'children', id, '--json')
    return r.isOk ? JSON.parse(r.out) : []
  },
  /** every bead, closed included, that already carries `<field>=<value>` in its metadata. The pm
   * (`factory plan set`, claude-factory-dun) uses this to dedupe a finding by its `pm_finding` key
   * before filing it: a finding already filed, even one whose bead later closed, is never filed
   * again. Throws rather than answering false on a real bd failure, the same as `lookup` above. */
  hasMetadata: (field: string, value: string): boolean => {
    const r = bd(repo, actor, 'list', '--all', '--metadata-field', `${field}=${value}`, '--json', '-n', '2')
    if (!r.isOk) throw new Error(`bd list --metadata-field ${field}=${value}: ${r.err.split('\n')[0]}`)
    return r.out !== 'null' && (JSON.parse(r.out) as Bead[]).length > 0
  },
  /**
   * Files a plan finding or proposal (claude-factory-dun) as a new bead, with no `factory` label
   * (unlike `create`, above): the factory itself must never start it as a run. `human` adds the
   * `human` label instead, which puts it in the console's Interview tab as a decision item; without
   * it, the bead files unlabeled, for a person to triage like any other backlog item. The caller
   * checks `hasMetadata('pm_finding', key)` first; this call always creates.
   */
  fileFinding: (title: string, description: string, key: string, { human = false } = {}): string =>
    must(
      bd(
        repo,
        actor,
        'create',
        title,
        '-d',
        description,
        '--metadata',
        `{"pm_finding":"${key}"}`,
        ...(human ? ['-l', 'human'] : []),
      ),
      'create',
    ),
  /**
   * pull, repair and push against the repo's Dolt remote (`bd sync`), so other machines' beads and
   * claims reach dispatch and ours reach them; false with no remote. Bounded: a hung remote must not
   * hold the pass that heartbeats every claim.
   */
  sync: () => {
    if (/No remotes configured/.test(bd(repo, actor, 'dolt', 'remote', 'list').out)) return false
    const p = Bun.spawnSync(['bd', 'sync', '--actor', actor], { cwd: repo, timeout: 120_000 })
    const out = `${p.stdout}\n${p.stderr}`.trim()
    // a remote nobody pushed to yet: seeding it publishes the repo's beads, so that is the person's call
    if (/not found on remote/.test(out))
      throw new Error('bd sync: the remote holds no beads yet; seed it once with bd dolt push')
    if (p.exitCode !== 0 || /sync failed/.test(out))
      throw new Error(`bd sync: ${out.split('\n').at(-1) || 'timed out'}`)
    return true
  },
})
