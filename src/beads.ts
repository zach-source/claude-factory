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
  assignee?: string
  priority?: number
  issue_type?: string
}

export const LABEL = 'factory'
export const hasBeads = (repo: string) => existsSync(join(repo, '.beads'))
/** the run owns its bead under this name; its workers write as `<actor>/<station>` */
export const actorOf = (runId: string) => `factory/${runId}`

/** what a run is asked to do, from its bead */
export const goalOf = (b: Bead) =>
  [`${b.id}: ${b.title}`, b.description, b.acceptance_criteria && `Acceptance: ${b.acceptance_criteria}`]
    .filter(Boolean)
    .join('\n\n')

/** a `station:<name>` label starts the run there instead of at the factory's start */
export const stationOf = (b: Bead) =>
  b.labels?.find(l => l.startsWith('station:'))?.slice('station:'.length) || undefined

/** unowned top-level work only: a child is a task of some run's plan (children inherit the label) */
export const dispatchable = (ready: Bead[], linked: Set<string>, room: number) =>
  ready.filter(b => !b.parent && !b.assignee && !linked.has(b.id)).slice(0, Math.max(0, room))

function bd(repo: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(['bd', ...args, '--actor', actor], { cwd: repo })
  const out = p.stdout.toString().trim()
  return { isOk: p.exitCode === 0, out, err: p.stderr.toString().trim() || out }
}
const must = (r: ReturnType<typeof bd>, what: string) => {
  if (!r.isOk) throw new Error(`bd ${what}: ${r.err.split('\n')[0]}`)
  return r.out
}

export const beads = (repo: string, actor: string) => ({
  show: (id: string): Bead | null => {
    const r = bd(repo, actor, 'show', id, '--json')
    const parsed = r.isOk ? JSON.parse(r.out) : null
    return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
  },
  ready: (): Bead[] =>
    JSON.parse(must(bd(repo, actor, 'ready', '--label', LABEL, '--json', '-n', '50'), 'ready')),
  /** ready work nobody has handed to the factory yet: what a person prioritizes */
  unqueued: (): Bead[] =>
    (JSON.parse(must(bd(repo, actor, 'ready', '--json', '-n', '100'), 'ready')) as Bead[]).filter(
      b => !b.parent && !b.assignee && !b.labels?.includes(LABEL),
    ),
  /** hands a bead to the factory: a rig starts it at the next dispatch */
  queue: (id: string, station?: string) =>
    must(
      bd(
        repo,
        actor,
        'update',
        id,
        '--add-label',
        LABEL,
        ...(station ? ['--add-label', `station:${station}`] : []),
      ),
      'update',
    ),
  /** atomic: false when someone else holds it */
  claim: (id: string) => bd(repo, actor, 'update', id, '--claim').isOk,
  create: (title: string, description: string, ...extra: string[]) =>
    must(bd(repo, actor, 'create', title, '-d', description, '-l', LABEL, '--silent', ...extra), 'create'),
  /** keeps the claim's lease alive, taking it back if a reaper reclaimed it */
  heartbeat: (id: string) =>
    bd(repo, actor, 'heartbeat', id).isOk || bd(repo, actor, 'update', id, '--claim').isOk,
  comment: (id: string, text: string) => must(bd(repo, actor, 'comment', id, text), 'comment'),
  /** false when bd refuses, e.g. while the bead still has open tasks */
  close: (id: string, reason: string) => bd(repo, actor, 'close', id, '--reason', reason).isOk,
  /** unassigned and out of bd ready until a person undefers it, which hands it back to the factory */
  defer: (id: string, reason: string) => {
    bd(repo, actor, 'unclaim', id)
    return must(bd(repo, actor, 'defer', id, '--reason', reason), 'defer')
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
})
