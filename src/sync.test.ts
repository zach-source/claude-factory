import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beads } from './beads'
import { nextSyncEntry, runBounded, syncDue, SYNC_BASE_MS, SYNC_MAX_MS } from './sync'

const MIN = 60_000

test('a rig never synced is due; a fresh success waits the base interval', () => {
  expect(syncDue(undefined, 1000)).toBe(true)
  const e = nextSyncEntry(undefined, { ms: 40 }, 1000)
  expect(e).toEqual({ at: 1000, failures: 0, ms: 40 })
  expect(syncDue(e, 1000 + SYNC_BASE_MS - 1)).toBe(false)
  expect(syncDue(e, 1000 + SYNC_BASE_MS)).toBe(true)
})

test('the same error doubles the wait up to the cap: 5, 10, 20, 40, 60, 60 min', () => {
  let e = nextSyncEntry(undefined, { error: 'x', ms: 1 }, 0)
  const waits = [e.nextAt! - e.at]
  for (let i = 0; i < 5; i++) {
    e = nextSyncEntry(e, { error: 'x', ms: 1 }, e.nextAt!)
    waits.push(e.nextAt! - e.at)
  }
  expect(waits).toEqual([5, 10, 20, 40, 60, 60].map(m => m * MIN))
  expect(e.failures).toBe(6)
  expect(waits.at(-1)).toBe(SYNC_MAX_MS)
})

test('a different error resets the wait to the base; a success resets the count', () => {
  const a = nextSyncEntry(undefined, { error: 'x' }, 0)
  const b = nextSyncEntry(a, { error: 'x' }, 10)
  expect(b.failures).toBe(2)
  const c = nextSyncEntry(b, { error: 'y' }, 20)
  expect(c.failures).toBe(1)
  expect(c.nextAt).toBe(20 + SYNC_BASE_MS)
  const d = nextSyncEntry(c, { ms: 5 }, 30)
  expect(d.failures).toBe(0)
  expect(d.error).toBeUndefined()
  expect(d.nextAt).toBeUndefined()
})

test('an old {at, error} entry is due at + 5 min, and counts as one failure', () => {
  const old = { at: 1000, error: 'x' }
  expect(syncDue(old, 1000 + SYNC_BASE_MS - 1)).toBe(false)
  expect(syncDue(old, 1000 + SYNC_BASE_MS)).toBe(true)
  expect(nextSyncEntry(old, { error: 'x' }, 5000).failures).toBe(2)
})

test('nextAt wins over at when set', () => {
  expect(syncDue({ at: 0, error: 'x', failures: 3, nextAt: 20 * MIN }, 19 * MIN)).toBe(false)
  expect(syncDue({ at: 0, error: 'x', failures: 3, nextAt: 20 * MIN }, 20 * MIN)).toBe(true)
})

const dir = join(tmpdir(), `sync-unit-${process.pid}`)
const path = process.env.PATH
afterEach(() => {
  process.env.PATH = path
  delete process.env.FACTORY_SYNC_TIMEOUT_MS
  rmSync(dir, { recursive: true, force: true })
})
const fakeBd = (script: string) => {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(
    join(dir, 'bin', 'bd'),
    `#!/bin/sh
${script}
`,
  )
  chmodSync(join(dir, 'bin', 'bd'), 0o755)
  process.env.PATH = `${join(dir, 'bin')}:${path}`
}

test('b.sync kills a hung bd sync at the cap and says so', async () => {
  fakeBd('case "$1" in dolt) echo ok;; sync) exec sleep 600;; esac')
  process.env.FACTORY_SYNC_TIMEOUT_MS = '1500'
  const t0 = Date.now()
  await expect(beads(dir, 'factory').sync()).rejects.toThrow('bd sync: timed out after 2 s')
  expect(Date.now() - t0).toBeLessThan(10_000)
})

test('b.sync kills a hung dolt remote list too', async () => {
  fakeBd('case "$1" in dolt) exec sleep 600;; esac')
  process.env.FACTORY_SYNC_TIMEOUT_MS = '1000'
  await expect(beads(dir, 'factory').sync()).rejects.toThrow('timed out after 1 s')
})

test('b.sync: no remote is false; a clean sync is true; a failure keeps its last line', async () => {
  fakeBd('case "$1" in dolt) echo "No remotes configured";; esac')
  expect(await beads(dir, 'factory').sync()).toBe(false)
  fakeBd('case "$1" in dolt) echo ok;; sync) echo fine;; esac')
  expect(await beads(dir, 'factory').sync()).toBe(true)
  fakeBd('case "$1" in dolt) echo ok;; sync) echo boom >&2; exit 1;; esac')
  await expect(beads(dir, 'factory').sync()).rejects.toThrow('bd sync: boom')
})

test('runBounded returns once the killed process exits, though a child holds the pipe', async () => {
  mkdirSync(dir, { recursive: true })
  const t0 = Date.now()
  const r = await runBounded(['sh', '-c', 'sleep 30 & exec sleep 600'], { cwd: dir, timeoutMs: 500 })
  expect(r.timedOut).toBe(true)
  expect(Date.now() - t0).toBeLessThan(5000)
})

test('runBounded returns near the cap after a normal exit, though a child holds the pipe', async () => {
  mkdirSync(dir, { recursive: true })
  const t0 = Date.now()
  const r = await runBounded(['sh', '-c', 'sleep 30 & echo hi; exit 0'], { cwd: dir, timeoutMs: 500 })
  expect(r.code).toBe(0)
  expect(r.out).toBe('hi\n')
  expect(Date.now() - t0).toBeLessThan(5000)
})

test('runBounded: a normal exit is not timed out, though the cap fires in the pipe grace', async () => {
  mkdirSync(dir, { recursive: true })
  const r = await runBounded(['sh', '-c', 'sleep 8 & echo hi; exit 0'], { cwd: dir, timeoutMs: 500 })
  expect(r.code).toBe(0)
  expect(r.timedOut).toBe(false)
})

test('runBounded: a process that leaves a child on the pipe still exits soon', async () => {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'probe.ts')
  writeFileSync(
    script,
    `import { runBounded } from ${JSON.stringify(join(import.meta.dir, 'sync.ts'))}
await runBounded(['sh', '-c', 'sleep 30 & echo hi; exit 0'], { cwd: ${JSON.stringify(dir)}, timeoutMs: 5000 })
await runBounded(['sh', '-c', 'sleep 30 & exec sleep 60'], { cwd: ${JSON.stringify(dir)}, timeoutMs: 300 })
`,
  )
  const t0 = Date.now()
  const p = Bun.spawn(['bun', script], { stdout: 'ignore', stderr: 'ignore' })
  await p.exited
  expect(Date.now() - t0).toBeLessThan(6000)
})
