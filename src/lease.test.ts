// The local manager lease (claude-factory-s01d.2): take, refuse, stale, and two managers on one home.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asker, decide, LEASE_STALE_MS, leaseFile, readLease, take } from './lease'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `lease-${process.pid}`)
const home = join(dir, 'home')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const a = { holder: 'herdr:a', kind: 'herdr', at: 1_000 }
const b = { holder: 'pane:p1', kind: 'claude', at: 2_000 }

test('the first asker takes the lease, and its holder renews it', () => {
  expect(decide(undefined, a, 1_000)).toEqual({ ok: true, lease: a })
  expect(decide(a, { ...a, at: 5_000 }, 5_000).ok).toBe(true)
})

test('a live lease refuses another holder and names the holder', () => {
  expect(decide(a, b, 2_000)).toEqual({ ok: false, lease: a })
})

test('a lease with no renewal for the stale time goes to the next asker', () => {
  expect(decide(a, b, a.at + LEASE_STALE_MS + 1).ok).toBe(true)
})

test('a lease whose pid is dead is stale at once', () => {
  const held = { ...a, pid: 42 }
  expect(decide(held, b, 2_000, () => false).ok).toBe(true)
  expect(decide(held, b, 2_000, () => true).ok).toBe(false)
})

test('take writes the lease file, and a bad file counts as no lease', () => {
  mkdirSync(home, { recursive: true })
  expect(take(home, a, 1_000).ok).toBe(true)
  expect(readLease(home)).toEqual(a)
  expect(take(home, b, 2_000).ok).toBe(false)
  writeFileSync(leaseFile(home), '{torn')
  expect(take(home, b, 2_000).ok).toBe(true)
})

test('asker: a named holder, else the pane, else the parent pid', () => {
  expect(asker({ FACTORY_LEASE_HOLDER: 'herdr:x', FACTORY_LEASE_KIND: 'herdr' }, 7, 1)).toEqual({
    holder: 'herdr:x',
    kind: 'herdr',
    at: 1,
  })
  expect(asker({ HERDR_PANE_ID: 'w1:p2' }, 7, 1)).toEqual({ holder: 'pane:w1:p2', kind: 'claude', at: 1 })
  expect(asker({}, 7, 1)).toEqual({ holder: 'ppid:7', kind: 'cli', pid: 7, at: 1 })
})

const factory = (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...process.env,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_NO_KICK: '1',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

test('two managers on one home: the second gets a read-only board and does not tick', () => {
  const first = factory(['tick'], { FACTORY_LEASE_HOLDER: 'herdr:one', FACTORY_LEASE_KIND: 'herdr' })
  expect(first.code).toBe(0)
  expect(JSON.parse(first.out).readOnly).toBeUndefined()
  // a tick takes tick.lock; a read-only tick never does, so a held tick.lock cannot make it busy
  mkdirSync(join(home, 'tick.lock'))
  writeFileSync(join(home, 'tick.lock', 'pid'), String(process.pid))
  const second = factory(['tick'], { FACTORY_LEASE_HOLDER: 'pane:p9', FACTORY_LEASE_KIND: 'claude' })
  expect(second.code).toBe(0)
  const res = JSON.parse(second.out)
  expect(res.busy).toBeUndefined()
  expect(res.readOnly).toContain('herdr:one (herdr) holds the manager lease')
  expect(res.runs).toEqual([])
  expect(factory(['lease', 'status']).out).toContain('herdr:one')
  expect(factory(['lease', 'release']).code).toBe(0)
  expect(existsSync(leaseFile(home))).toBe(false)
  expect(factory(['lease', 'status']).out).toContain('nobody holds the manager lease')
})
