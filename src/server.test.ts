import { afterEach, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, leaseFile, release, serve } from './server'

const dirs: string[] = []
const lease = () => {
  const d = mkdtempSync(join(tmpdir(), 'server-lease-'))
  dirs.push(d)
  return join(d, 'server-lease.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('claim takes a missing lease and renews its own', () => {
  const f = lease()
  expect(claim(f, 'a', 1000, 500)).toEqual({ held: true, lease: { holder: 'a', until: 1500 } })
  expect(claim(f, 'a', 1200, 500).held).toBe(true)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ holder: 'a', until: 1700 })
})

test('claim leaves a live lease of another holder unchanged', () => {
  const f = lease()
  claim(f, 'a', 1000, 500)
  const before = readFileSync(f, 'utf8')
  expect(claim(f, 'b', 1499, 500)).toEqual({ held: false, lease: { holder: 'a', until: 1500 } })
  expect(readFileSync(f, 'utf8')).toBe(before)
})

test('claim takes an expired lease (until <= now)', () => {
  const f = lease()
  claim(f, 'a', 1000, 500)
  expect(claim(f, 'b', 1500, 500).held).toBe(true)
  expect(JSON.parse(readFileSync(f, 'utf8')).holder).toBe('b')
})

test('a corrupt lease counts as live until its mtime is older than ttl', () => {
  const f = lease()
  writeFileSync(f, '{not json')
  const now = Date.now()
  expect(claim(f, 'b', now, 60_000).held).toBe(false)
  expect(readFileSync(f, 'utf8')).toBe('{not json')
  const old = new Date(now - 120_000)
  utimesSync(f, old, old)
  expect(claim(f, 'b', now, 60_000).held).toBe(true)
})

test('release removes only its own lease and never throws', () => {
  const f = lease()
  claim(f, 'a', 1000, 500)
  release(f, 'b')
  expect(existsSync(f)).toBe(true)
  release(f, 'a')
  expect(existsSync(f)).toBe(false)
  release(f, 'a')
})

test('a tick longer than the lease keeps the lease, and stop waits for that tick', async () => {
  const home = mkdtempSync(join(tmpdir(), 'server-loop-'))
  dirs.push(home)
  let done = false
  const s = serve({
    home,
    port: 0,
    everyMs: 50,
    leaseMs: 300,
    holder: 'a',
    log: () => {},
    tick: async () => {
      await new Promise(r => setTimeout(r, 900))
      done = true
    },
  })
  await new Promise(r => setTimeout(r, 700))
  expect(claim(leaseFile(home), 'b', Date.now(), 300).held).toBe(false)
  await s.stop()
  expect(done).toBe(true)
  expect(existsSync(leaseFile(home))).toBe(false)
}, 30_000)

// Process tests: real `factory server` children on one FACTORY_HOME.
const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const kids: Subprocess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const newHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'server-home-'))
  dirs.push(d)
  mkdirSync(join(d, 'runs'), { recursive: true })
  return d
}
const env = (home: string) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, ...laptop } = process.env
  return { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1' }
}
const FAST = ['--port', '0', '--every-ms', '100', '--lease-ms', '1000']
async function start(home: string) {
  const p = Bun.spawn([CLI, 'server', ...FAST], { env: env(home), stdout: 'pipe', stderr: 'pipe' })
  kids.push(p)
  const first = await p.stdout.getReader().read()
  const text = new TextDecoder().decode(first.value)
  const m = /on :(\d+) as (\S+)/.exec(text)
  if (!m) throw new Error(`no start line: ${text}`)
  return { p, port: Number(m[1]), holder: m[2]! }
}
const health = async (port: number) =>
  (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as Promise<any>
const holderOf = (home: string) => {
  try {
    return JSON.parse(readFileSync(leaseFile(home), 'utf8')).holder
  } catch {
    return null
  }
}

test('two servers on one home: the second waits, the first ticks and holds the lease', async () => {
  const home = newHome()
  const a = await start(home)
  const b = await start(home)
  const seen = new Set<string>()
  for (let i = 0; i < 16; i++) {
    seen.add(String(holderOf(home)))
    await sleep(100)
  }
  expect([...seen]).toEqual([a.holder])
  const ha = await health(a.port)
  const hb = await health(b.port)
  expect(ha.lease).toBe('held')
  expect(ha.ticks).toBeGreaterThanOrEqual(2)
  expect(Object.keys(ha).sort()).toEqual(['holder', 'lease', 'tickAt', 'tickOk', 'ticks', 'until'])
  expect(hb).toMatchObject({ lease: 'waiting', ticks: 0, holder: a.holder })
}, 30_000)

test('the waiting server takes over after SIGKILL of the holder', async () => {
  const home = newHome()
  const a = await start(home)
  const b = await start(home)
  a.p.kill('SIGKILL')
  const t0 = Date.now()
  let h = await health(b.port)
  while (h.ticks < 1 && Date.now() - t0 < 6000) {
    await sleep(100)
    h = await health(b.port)
  }
  expect(h).toMatchObject({ lease: 'held', holder: b.holder })
  expect(h.ticks).toBeGreaterThanOrEqual(1)
  expect(Date.now() - t0).toBeLessThan(3500)
}, 30_000)

test('SIGTERM finishes the tick, releases the lease and exits 0; the waiter takes it fast', async () => {
  const home = newHome()
  const a = await start(home)
  const b = await start(home)
  await sleep(300)
  a.p.kill('SIGTERM')
  expect(await a.p.exited).toBe(0)
  expect(holderOf(home)).not.toBe(a.holder)
  const t0 = Date.now()
  while (holderOf(home) !== b.holder && Date.now() - t0 < 3000) await sleep(50)
  expect(holderOf(home)).toBe(b.holder)
  expect(Date.now() - t0).toBeLessThan(1000)
}, 30_000)

test('healthz answers GET only; other methods and paths give 404', async () => {
  const a = await start(newHome())
  expect((await fetch(`http://127.0.0.1:${a.port}/healthz`, { method: 'POST' })).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${a.port}/nope`)).status).toBe(404)
}, 30_000)

test('bad flags exit non-zero with the usage and make no lease file', () => {
  for (const args of [
    ['--port', 'x'],
    ['--port', '-1'],
    ['--every-ms', '0'],
    ['--every-ms', '100', '--lease-ms', '150'],
    ['--bogus', '1'],
    ['--port'],
  ]) {
    const home = newHome()
    const p = Bun.spawnSync([CLI, 'server', ...args], { env: env(home), timeout: 5000 })
    expect(p.exitCode).not.toBe(0)
    expect(p.stderr.toString()).toContain('usage: factory server')
    expect(existsSync(leaseFile(home))).toBe(false)
  }
}, 30_000)

test('a worker cannot run factory server', () => {
  const home = newHome()
  const e = { ...env(home), FACTORY_RUN: 'r1', FACTORY_OUTBOX: join(home, 'o') }
  const p = Bun.spawnSync([CLI, 'server', ...FAST], { env: e })
  expect(p.exitCode).not.toBe(0)
  expect(existsSync(leaseFile(home))).toBe(false)
}, 30_000)
