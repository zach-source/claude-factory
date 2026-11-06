import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { SECRETS } from './secrets'

export const LOCK_WAIT_MS = 5_000
export const LOCK_STALE_MS = 30_000
export const HISTORY_KEEP = 20

type Rig = { name: string; repo: string }

function validate(rigs: unknown, file: string): asserts rigs is Rig[] {
  if (!Array.isArray(rigs)) throw new Error(`${file}: the edit did not give an array`)
  const names = new Set<string>()
  const repos = new Set<string>()
  for (const r of rigs) {
    if (!r || typeof r.name !== 'string' || !r.name || typeof r.repo !== 'string' || !r.repo)
      throw new Error(`${file}: every rig needs a name and a repo`)
    if (names.has(r.name)) throw new Error(`${file}: two rigs are named ${r.name}`)
    if (repos.has(r.repo)) throw new Error(`${file}: two rigs have the repo ${r.repo}`)
    names.add(r.name)
    repos.add(r.repo)
  }
}

function lock(dir: string, waitMs: number, staleMs: number) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(dir)
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    try {
      // ponytail: two waiters can break one stale lock at the same time. The second rmdir can then
      // remove a new lock. Upgrade path: put a pid in the lock dir, as hold() does in cli.ts.
      if (Date.now() - statSync(dir).mtimeMs > staleMs) {
        rmdirSync(dir)
        continue
      }
    } catch (e) {
      // the holder released it between our mkdir and stat; any other error waits for the deadline
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
    }
    if (Date.now() >= deadline) throw new Error(`${dir} is held by another rig edit; try again`)
    Bun.sleepSync(50)
  }
}

/** snapshot name that sorts by time */
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '')

/** the snapshot files beside `file`, newest first, at most HISTORY_KEEP; a missing dir is [] */
export function snapshots(file: string): string[] {
  const hist = join(dirname(file), 'rigs-history')
  if (!existsSync(hist)) return []
  return readdirSync(hist)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, HISTORY_KEEP)
    .map(f => join(hist, f))
}

/**
 * Change the rig list under a lock. A missing `file` is []. Steps: run `fn`, check its result, copy the
 * old file to `rigs-history/` (keep the newest 20), write a temp file, rename it over `file`.
 * `fn` must throw and must not exit. A throw frees the lock.
 */
export function editRigs<R extends Rig>(
  file: string,
  fn: (rigs: R[]) => R[],
  opts: { waitMs?: number; staleMs?: number } = {},
): R[] {
  const dir = `${file}.lock`
  lock(dir, opts.waitMs ?? LOCK_WAIT_MS, opts.staleMs ?? LOCK_STALE_MS)
  try {
    const had = existsSync(file)
    let cur: unknown = []
    if (had) {
      try {
        cur = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        throw new Error(`${file}: not valid JSON (${(e as Error).message})`)
      }
      if (!Array.isArray(cur)) throw new Error(`${file}: not a JSON array`)
    }
    const next = fn(cur as R[])
    validate(next, file)
    if (had) {
      const hist = join(dirname(file), 'rigs-history')
      mkdirSync(hist, { recursive: true })
      let snap = join(hist, `${stamp()}.json`)
      while (existsSync(snap)) {
        Bun.sleepSync(1)
        snap = join(hist, `${stamp()}.json`)
      }
      copyFileSync(file, snap)
      const old = readdirSync(hist)
        .filter(f => f.endsWith('.json'))
        .sort()
      for (const f of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) rmSync(join(hist, f))
    }
    const fd = openSync(`${file}.tmp`, 'w')
    try {
      writeSync(fd, JSON.stringify(next, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(`${file}.tmp`, file)
    return next
  } finally {
    rmdirSync(dir)
  }
}

/** Write the `set` fields over `rig` and remove the `unset` keys. A key that exists keeps its place. */
export function applyRigChange<R extends object>(
  rig: R,
  set: Record<string, unknown>,
  unset: string[],
): Partial<R> {
  const next: Record<string, unknown> = { ...rig, ...set }
  for (const k of unset) delete next[k]
  return next as Partial<R>
}

const HIDDEN = '<hidden>'
const SECRET_KEY = /(TOKEN|SECRET|KEY|PASSWORD)/i

/**
 * Return a copy of the rig that is safe to print. Each string that matches SECRETS becomes `<hidden>`.
 * In `env` and `params`, each string value with a secret-like key also becomes `<hidden>`.
 * ponytail: a secret of unknown shape outside `env` and `params` is not found. Upgrade: a field table.
 */
export function redactRig<R extends object>(rig: R): R {
  const walk = (v: unknown, keyed: boolean): unknown => {
    if (typeof v === 'string') return SECRETS.some(p => p.test(v)) ? HIDDEN : v
    if (Array.isArray(v)) return v.map(x => walk(x, false))
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          keyed && SECRET_KEY.test(k) && typeof x === 'string' ? HIDDEN : walk(x, false),
        ]),
      )
    return v
  }
  return Object.fromEntries(
    Object.entries(rig).map(([k, v]) => [k, walk(v, k === 'env' || k === 'params')]),
  ) as R
}
