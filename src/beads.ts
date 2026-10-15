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

/** a `station:<name>` label starts the run there instead of at the factory's start */
export const stationOf = (b: Bead) =>
  b.labels?.find(l => l.startsWith('station:'))?.slice('station:'.length) || undefined

/** a bead's parent: bd's parent-child edge, else the id's own `<parent>.<n>` */
export const parentOf = (b: Bead) =>
  b.parent ?? (/\.\d+$/.test(b.id) ? b.id.replace(/\.\d+$/, '') : undefined)

/** unowned top-level work only: a child is a task of some run's plan (children inherit the label) */
export const dispatchable = (ready: Bead[], linked: Set<string>, room: number) =>
  ready.filter(b => !b.parent && !b.assignee && !linked.has(b.id)).slice(0, Math.max(0, room))

function bd(repo: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(['bd', ...args, '--actor', actor], { cwd: repo, env: process.env })
  const out = p.stdout.toString().trim()
  return { isOk: p.exitCode === 0, out, err: p.stderr.toString().trim() || out }
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
   */
  lookup: (id: string): Bead | null => {
    const r = bd(repo, actor, 'show', id, '--json')
    if (r.isOk) {
      const parsed = JSON.parse(r.out)
      return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
    }
    const body = r.out.startsWith('{') ? JSON.parse(r.out) : null
    if (body?.error) return null // bd's own "not found" JSON body: a real answer, not a lookup failure
    throw new Error(`bd show ${id}: ${r.err.split('\n')[0]}`)
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
  respond: (id: string, text: string) => must(bd(repo, actor, 'human', 'respond', id, '-r', text), 'human respond'),
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
      const r = bd(repo, actor, 'list', '--all', '--metadata-field', `factory_create=${token}`, '--json', '-n', '2')
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
