// claude-factory-gogxc.7: exactly one process ticks a server-mode home (specs/010-server-pod, user story 1).
// Real processes on a temp home: the server, a mod-style tick, a CLI tick, stop and resume, a manager restart.
import { afterEach, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLease } from './lease'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const kids: Subprocess[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const p of kids.splice(0)) p.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const newHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'one-ticker-'))
  dirs.push(d)
  const home = join(d, 'home')
  mkdirSync(home)
  return home
}
const env = (home: string, more: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_SERVER, FACTORY_WORKER, ...laptop } = process.env
  return {
    ...laptop,
    FACTORY_HOME: home,
    FACTORY_SERVER_MODE: '1',
    FACTORY_SELF_UPDATE: '0',
    FACTORY_NO_KICK: '1',
    FACTORY_GC: '0',
    ...more,
  }
}
/** the server, ticking each 100 ms; it prints its port when it is up */
async function startServer(home: string) {
  const p = Bun.spawn([CLI, 'server', '--port', '0', '--every-ms', '100', '--lease-ms', '1000'], {
    env: env(home),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  kids.push(p)
  const text = new TextDecoder().decode((await p.stdout.getReader().read()).value)
  const port = Number(/on :(\d+) as/.exec(text)?.[1])
  if (!port) throw new Error(`no start line: ${text}`)
  return { p, port }
}
const ticks = async (port: number) =>
  ((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ticks: number }).ticks
/** a factory command as its own process, so two of them can run at the same time */
const run = async (home: string, args: string[], more: Record<string, string> = {}) => {
  const p = Bun.spawn([CLI, ...args], { env: env(home, more), stdout: 'pipe', stderr: 'pipe' })
  kids.push(p)
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
}
const modTick = (home: string, pane = 'p1') =>
  run(home, ['tick'], { FACTORY_LEASE_HOLDER: `pane:${pane}`, FACTORY_LEASE_KIND: 'claude' })
const haltOf = (home: string) =>
  existsSync(join(home, 'halt.json')) ? JSON.parse(readFileSync(join(home, 'halt.json'), 'utf8')) : null
/** wait until `ok()` holds, up to `ms` */
const until = async (ok: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await ok()) return
  throw new Error('timeout')
}

test('scenario 2: a mod-style tick and a CLI tick at once refuse and name the pod', async () => {
  const home = newHome()
  const s = await startServer(home)
  await until(() => readLease(home)?.kind === 'server')
  const holder = readLease(home)!.holder
  const before = await ticks(s.port)
  const [mod, cli] = await Promise.all([modTick(home), run(home, ['tick'])])
  for (const r of [mod, cli]) {
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).readOnly).toContain(`${holder} (server) holds the manager lease`)
  }
  await until(async () => (await ticks(s.port)) > before) // the pod keeps ticking
  expect(readLease(home)!.holder).toBe(holder)
}, 30_000)

test('scenario 1: stop and resume while the pod ticks; the last command wins', async () => {
  const home = newHome()
  const s = await startServer(home)
  await until(() => readLease(home)?.kind === 'server')
  for (let i = 0; i < 5; i++) {
    expect((await run(home, ['stop'])).code).toBe(0)
    expect((await run(home, ['resume'])).code).toBe(0)
  }
  expect(haltOf(home)).toBeNull()
  const before = await ticks(s.port)
  await until(async () => (await ticks(s.port)) > before + 3) // no tick brings the old halt back
  expect(haltOf(home)).toBeNull()
  expect(existsSync(join(home, 'halt-cmd.jsonl'))).toBe(false)
  expect((await run(home, ['stop'])).code).toBe(0)
  expect(haltOf(home)).not.toBeNull() // the last command was stop
}, 60_000)

test('scenario 1: stop and resume that find a busy tick queue; the next tick applies them in order', async () => {
  const home = newHome()
  mkdirSync(join(home, 'tick.lock')) // a running tick, held by this live process
  writeFileSync(join(home, 'tick.lock', 'pid'), String(process.pid))
  const stop = run(home, ['stop'])
  await sleep(200)
  const resume = run(home, ['resume'])
  const [a, b] = await Promise.all([stop, resume]) // each waits for the lock, then queues
  expect(a.out).toContain('queued as')
  expect(b.out).toContain('queued as')
  expect(haltOf(home)).toBeNull() // nothing changed while the tick held the lock
  rmSync(join(home, 'tick.lock'), { recursive: true })
  const s = await startServer(home)
  await until(() => !existsSync(join(home, 'halt-cmd.jsonl')) && readLease(home)?.kind === 'server')
  expect(haltOf(home)).toBeNull() // stop, then resume: the resume is not lost
  expect(await ticks(s.port)).toBeGreaterThan(0)
}, 60_000)

test('scenario 3: a restart of the manager task or the pod keeps the halt state', async () => {
  const home = newHome()
  const s = await startServer(home)
  await until(() => readLease(home)?.kind === 'server')
  expect((await run(home, ['stop'])).code).toBe(0)
  const halt = haltOf(home)
  expect(halt).not.toBeNull()
  // the manager task restarts: a new process with a new holder reads the board and does not tick
  const holder = readLease(home)!.holder
  const m = await modTick(home, 'p2')
  expect(JSON.parse(m.out).readOnly).toContain(holder)
  expect(haltOf(home)!.at).toBe(halt.at)
  // the pod restarts: the same holder name renews its own lease at once
  s.p.kill('SIGTERM')
  await s.p.exited
  const s2 = await startServer(home)
  await until(async () => (await ticks(s2.port)) > 2)
  expect(haltOf(home)!.at).toBe(halt.at)
  expect(readLease(home)!.holder).toBe(holder)
}, 60_000)
