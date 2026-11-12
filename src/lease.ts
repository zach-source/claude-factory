import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The local manager lease (claude-factory-s01d.2). Only its holder ticks and patrols a factory home.
 * The Claude mod, the Herdr mod and `factory loop` take it before a tick or a patrol.
 *
 * The holder renews it on each tick. With no renewal for LEASE_STALE_MS, the lease is stale.
 * A dead recorded pid also makes it stale. Any holder can take a stale lease.
 */
export type Lease = { holder: string; kind: string; pid?: number; at: number }

/** a tick runs each 5 s, so one minute with no renewal means the holder stopped */
export const LEASE_STALE_MS = 60_000

export const leaseFile = (home: string) => join(home, 'manager.lease')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** true when nobody can count on this lease any more */
export const isStale = (l: Lease, now: number, isAlive = alive) =>
  now - l.at > LEASE_STALE_MS || (l.pid !== undefined && !isAlive(l.pid))

/**
 * pure: the lease after `want` asks for it, or the other holder's lease when it is live.
 * In server mode (claude-factory-gogxc.4), a lease of kind `server` is the pod's: only the pod takes it over, even when it is stale.
 */
export function decide(
  cur: Lease | undefined,
  want: Lease,
  now: number,
  isAlive = alive,
  serverMode = false,
) {
  const podOnly = serverMode && cur?.kind === 'server' && want.kind !== 'server'
  if (!cur || cur.holder === want.holder || (isStale(cur, now, isAlive) && !podOnly))
    return { ok: true as const, lease: want }
  return { ok: false as const, lease: cur }
}

export function readLease(home: string): Lease | undefined {
  const f = leaseFile(home)
  if (!existsSync(f)) return undefined
  try {
    const l = JSON.parse(readFileSync(f, 'utf8')) as Lease
    return typeof l.holder === 'string' && typeof l.at === 'number' ? l : undefined
  } catch {
    return undefined // a torn or bad file is no lease: the next take writes a good one
  }
}

/** takes or renews the lease. The caller must hold a lock around this, so two takes never race. */
export function take(home: string, want: Lease, now = Date.now(), serverMode = false) {
  const d = decide(readLease(home), want, now, alive, serverMode)
  if (d.ok) {
    const f = leaseFile(home)
    writeFileSync(`${f}.tmp`, JSON.stringify(d.lease))
    renameSync(`${f}.tmp`, f)
  }
  return d
}

export const release = (home: string) => rmSync(leaseFile(home), { force: true })

/**
 * Who asks for the lease. FACTORY_LEASE_HOLDER and FACTORY_LEASE_KIND name a holder.
 * The Herdr mod sets them.
 *
 * With no name, the holder is the herdr pane, else the parent process.
 * All ticks of the Claude mod come from one claude process, so they share one holder.
 * The parent pid makes the lease of a dead manager stale at once.
 */
export function asker(env: Record<string, string | undefined>, ppid: number, now = Date.now()): Lease {
  const kind = env.FACTORY_LEASE_KIND || (env.HERDR_PANE_ID ? 'claude' : 'cli')
  if (env.FACTORY_LEASE_HOLDER) return { holder: env.FACTORY_LEASE_HOLDER, kind, at: now }
  if (env.HERDR_PANE_ID) return { holder: `pane:${env.HERDR_PANE_ID}`, kind, at: now }
  return { holder: `ppid:${ppid}`, kind, pid: ppid, at: now }
}

/** the server pod asks for the lease under one fixed holder, so a restart of the pod renews its own lease */
export const podAsker = (host: string, now = Date.now()): Lease => ({
  holder: `server:${host}`,
  kind: 'server',
  at: now,
})

/** one line for a person: who holds the lease and how fresh it is */
export const leaseLine = (l: Lease | undefined, now: number) =>
  l
    ? `${l.holder} (${l.kind}${l.pid ? `, pid ${l.pid}` : ''}) holds the manager lease, renewed ${Math.round((now - l.at) / 1000)}s ago${isStale(l, now) ? ', stale' : ''}`
    : 'nobody holds the manager lease'
