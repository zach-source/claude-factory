// `factory server`: one long-lived process that ticks, holds the writer lease and answers /healthz
// (claude-factory-akiq.1, spec 004-factory-server FR-001, FR-007).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export type Lease = { holder: string; until: number }

export const leaseFile = (home: string) => join(home, 'server-lease.json')

function read(file: string): Lease | null | 'bad' {
  if (!existsSync(file)) return null
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))
    return typeof l?.holder === 'string' && Number.isFinite(l.until) ? l : 'bad'
  } catch {
    return 'bad'
  }
}

const other = (file: string): Lease | null => {
  const l = read(file)
  return l === 'bad' ? null : l
}

/**
 * Take, renew or refuse the lease. Return the lease in the file and whether `holder` owns it.
 * Take a lease that is missing or expired (until <= now). A corrupt file counts as live until its
 * mtime is older than ttlMs, so the check fails closed.
 * ponytail: two takers of one expired lease can both write. The last rename wins. The other taker
 * steps down at its next claim. Upgrade path: a Dolt `lease` row with compare-and-set (spec step S6).
 */
export function claim(
  file: string,
  holder: string,
  now: number,
  ttlMs: number,
): { held: boolean; lease: Lease | null } {
  const cur = read(file)
  if (cur === 'bad') {
    let age = 0
    try {
      age = now - statSync(file).mtimeMs
    } catch {}
    if (age <= ttlMs) return { held: false, lease: null }
  } else if (cur && cur.holder !== holder && cur.until > now) return { held: false, lease: cur }
  const mine: Lease = { holder, until: now + ttlMs }
  const tmp = `${file}.${holder.replace(/\W/g, '_')}.tmp`
  try {
    if (!cur) writeFileSync(file, JSON.stringify(mine), { flag: 'wx' })
    else {
      writeFileSync(tmp, JSON.stringify(mine))
      renameSync(tmp, file)
    }
  } catch {
    return { held: false, lease: other(file) }
  }
  const back = other(file)
  return back?.holder === holder ? { held: true, lease: mine } : { held: false, lease: back }
}

/** remove the lease only when `holder` owns it; never throws */
export function release(file: string, holder: string) {
  try {
    if (other(file)?.holder === holder) rmSync(file, { force: true })
  } catch {}
}

export const newHolder = () => `${hostname()}/${process.pid}/${randomBytes(4).toString('hex')}`
