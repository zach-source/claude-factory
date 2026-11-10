import { afterEach, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { backup } from './homebackup'
import { claim, leaseFile, parseFlags, release, serve, serverBackupCfg } from './server'

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

test('stop keeps the lease renewed while it waits for a tick longer than the lease', async () => {
  const home = mkdtempSync(join(tmpdir(), 'server-drain-'))
  dirs.push(home)
  let done = false
  const s = serve({
    home,
    port: 0,
    everyMs: 50,
    leaseMs: 100,
    holder: 'a',
    log: () => {},
    tick: async () => {
      await new Promise(r => setTimeout(r, 600))
      done = true
    },
  })
  await new Promise(r => setTimeout(r, 50))
  const stopped = s.stop()
  await new Promise(r => setTimeout(r, 300))
  expect(done).toBe(false)
  expect(claim(leaseFile(home), 'b', Date.now(), 100).held).toBe(false)
  await stopped
  expect(done).toBe(true)
  expect(existsSync(leaseFile(home))).toBe(false)
  await new Promise(r => setTimeout(r, 200))
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
async function start(home: string, extra: Record<string, string> = {}) {
  const p = Bun.spawn([CLI, 'server', ...FAST], {
    env: { ...env(home), ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  kids.push(p)
  const reader = p.stdout.getReader()
  const first = await reader.read()
  const text = new TextDecoder().decode(first.value)
  const m = /on :(\d+) as (\S+)/.exec(text)
  if (!m) throw new Error(`no start line: ${text}`)
  /** wait `ms` ms, then give all text after the first chunk */
  let buf = ''
  void (async () => {
    for (;;) {
      const r = await reader.read()
      if (r.done) return
      buf += new TextDecoder().decode(r.value)
    }
  })()
  const more = async (ms: number) => {
    await sleep(ms)
    return buf
  }
  return { p, port: Number(m[1]), holder: m[2]!, first: text, more }
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

test('a second server on a busy port exits non-zero and makes no lease file', async () => {
  const a = await start(newHome())
  const home = newHome()
  const p = Bun.spawn([CLI, 'server', '--port', String(a.port), '--every-ms', '100', '--lease-ms', '1000'], {
    env: env(home),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  kids.push(p)
  const code = await Promise.race([p.exited, sleep(10_000).then(() => 'alive')])
  expect(code).not.toBe('alive')
  expect(code).not.toBe(0)
  expect(existsSync(leaseFile(home))).toBe(false)
}, 30_000)

test('a waiting server logs "lease held by" once per holder, not at each renewal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'server-log-'))
  dirs.push(home)
  claim(leaseFile(home), 'other', Date.now(), 60_000)
  const lines: string[] = []
  const s = serve({
    home,
    port: 0,
    everyMs: 20,
    leaseMs: 60,
    holder: 'me',
    log: l => lines.push(l),
    tick: () => {},
  })
  await sleep(300)
  // the other holder renews: the until value changes, the holder does not
  claim(leaseFile(home), 'other', Date.now(), 61_000)
  await sleep(300)
  await s.stop()
  expect(lines.filter(l => l.startsWith('lease held by other'))).toHaveLength(1)
}, 30_000)

test('a tick that throws is logged and the loop keeps ticking', async () => {
  const home = mkdtempSync(join(tmpdir(), 'server-fail-'))
  dirs.push(home)
  const lines: string[] = []
  let n = 0
  const s = serve({
    home,
    port: 0,
    everyMs: 20,
    leaseMs: 200,
    holder: 'me',
    log: l => lines.push(l),
    tick: () => {
      n++
      throw new Error('boom\nsecond line')
    },
  })
  await sleep(400)
  const h = (await fetch(`http://127.0.0.1:${s.port}/healthz`).then(r => r.json())) as any
  await s.stop()
  expect(n).toBeGreaterThanOrEqual(3)
  expect(lines.filter(l => l === 'tick failed: boom').length).toBeGreaterThanOrEqual(3)
  expect(h.tickOk).toBe(false)
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

test('onBoard gets each accepted tick result, not a busy or a thrown one', async () => {
  const seen: unknown[] = []
  const results: unknown[] = [{ a: 1 }, { busy: true }, 'throw', { a: 2 }]
  const s = serve({
    home: lease().replace(/\/[^/]+$/, ''),
    port: 0,
    everyMs: 20,
    leaseMs: 1000,
    log: () => {},
    tick: () => {
      const r = results.shift()
      if (r === 'throw') throw new Error('x')
      return r
    },
    onBoard: b => seen.push(b),
  })
  const until = Date.now() + 3000
  while (results.length && Date.now() < until) await Bun.sleep(10)
  await Bun.sleep(30)
  await s.stop()
  expect(seen.slice(0, 2)).toEqual([{ a: 1 }, { a: 2 }])
})

test('a962 AC4: the start line says backup on or the off reason, and never the remote or the token', async () => {
  const { ws, home } = wsHome()
  const bk = bkEnv(home, 'eHE6enE=', { FACTORY_SERVER_BACKUP_REMOTE: join(ws, 'remote.git') })
  const a = await start(home, bk)
  const out = a.first + (await a.more(1000))
  expect(out).toContain('backup on: branch server-home every 600000 ms')
  expect(out).not.toContain('remote.git')
  expect(out).not.toContain('eHE6enE=')
  a.p.kill('SIGKILL')
  const home2 = wsHome().home
  const b = await start(home2, { ...bkEnv(home2, 'eHE6enE='), FACTORY_SERVER_BACKUP_BRANCH: 'manager-home' })
  expect(b.first + (await b.more(1000))).toContain('backup off: bad branch')
  const c = await start(wsHome().home)
  expect(c.first + (await c.more(500))).not.toContain('backup')
}, 30_000)

// a962: server home backup config and loop
const bkEnv = (home: string, auth: string | null, extra: Record<string, string> = {}) => {
  const f = join(dirs[dirs.push(mkdtempSync(join(tmpdir(), 'server-auth-'))) - 1]!, 'basic')
  if (auth !== null) writeFileSync(f, auth + '\n')
  return {
    FACTORY_SERVER_BACKUP_REMOTE: 'https://github.com/acme/widget.git',
    FACTORY_SERVER_BACKUP_AUTH_FILE: f,
    ...extra,
  }
}
const wsHome = () => {
  const ws = mkdtempSync(join(tmpdir(), 'server-ws-'))
  dirs.push(ws)
  const home = join(ws, 'home')
  mkdirSync(join(home, 'runs'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), '[]')
  return { ws, home }
}

test('a962 AC2: serverBackupCfg is off unless every check passes, and no off text leaks the remote or the token', () => {
  const { ws, home } = wsHome()
  const on = bkEnv(home, 'eHE6enE=')
  expect(serverBackupCfg({}, home)).toBeUndefined()
  expect(serverBackupCfg({ FACTORY_SERVER_BACKUP_REMOTE: '' }, home)).toBeUndefined()
  const off = (e: Record<string, string | undefined>, h = home) =>
    (serverBackupCfg(e, h) as { off: string }).off
  const BAD = 'backup off: the remote is not an https URL with no user info'
  for (const r of [
    'https://zqsecret@github.com/acme/widget.git',
    'https://x:zqsecret@github.com/acme/widget.git',
    'https://github.com/acme/w@x.git',
    'git@github.com:acme/widget.git',
    'ssh://github.com/acme/widget.git',
    'http://github.com/acme/widget.git',
    'https://github.com/acme/widget.git\nx',
    'file:///tmp/r.git',
  ])
    expect(off({ ...on, FACTORY_SERVER_BACKUP_REMOTE: r })).toBe(BAD)
  expect(
    off({ ...on, FACTORY_SERVER_BACKUP_AUTH_FILE: undefined, FACTORY_SERVER_BACKUP_REMOTE: 'git@x:y' }),
  ).toBe(BAD)
  expect(off(on, join(ws, 'elsewhere'))).toBe('backup off: FACTORY_HOME is not <workspace>/home')
  expect(off({ ...on, FACTORY_SERVER_BACKUP_BRANCH: 'manager-home' })).toBe('backup off: bad branch')
  expect(off({ ...on, FACTORY_SERVER_BACKUP_BRANCH: 'a b' })).toBe('backup off: bad branch')
  expect(off({ ...on, FACTORY_SERVER_BACKUP_AUTH_FILE: undefined })).toBe('backup off: no auth file')
  const gone = join(ws, 'nope')
  expect(off({ ...on, FACTORY_SERVER_BACKUP_AUTH_FILE: gone })).toBe(
    `backup off: cannot read the auth file ${gone}`,
  )
  const o7 = off(bkEnv(home, 'zqsecret token!'))
  expect(o7).toBe('backup off: the auth file is not base64')
  expect(o7).not.toContain('zqsecret')
  // on
  const r = serverBackupCfg(on, home) as { cfg: any; everyMs: number }
  expect(r.cfg).toMatchObject({
    ws,
    branch: 'server-home',
    auth: 'eHE6enE=',
    remote: on.FACTORY_SERVER_BACKUP_REMOTE,
  })
  expect(r.cfg.excludes).toContain('/home/server-lease.json*')
  expect(r.everyMs).toBe(600_000)
  for (const [v, ms] of [
    ['59999', 600_000],
    ['abc', 600_000],
    ['60000', 60_000],
  ] as const)
    expect((serverBackupCfg({ ...on, FACTORY_SERVER_BACKUP_EVERY: v }, home) as any).everyMs).toBe(ms)
})

test('a962 AC2: the server config leaves the lease file out, so a second backup finds no change', () => {
  const { ws, home } = wsHome()
  const bin = join(ws, 'gitleaks')
  writeFileSync(bin, "#!/bin/sh\necho '[]'\n", { mode: 0o755 })
  const bare = mkdtempSync(join(tmpdir(), 'server-bare-'))
  dirs.push(bare)
  expect(Bun.spawnSync(['git', 'init', '-q', '--bare', bare]).exitCode).toBe(0)
  const c = serverBackupCfg({ ...bkEnv(home, 'eHE6enE='), FACTORY_SERVER_BACKUP_REMOTE: bare }, home) as {
    cfg: any
  }
  expect(backup({ ...c.cfg, gitleaks: bin }, true).error).toBeUndefined()
  writeFileSync(join(home, 'server-lease.json'), '{"holder":"x","until":2}')
  writeFileSync(join(home, 'server-lease.json.x.tmp'), 'x')
  const o = backup({ ...c.cfg, gitleaks: bin }, true)
  expect(o.error).toBeUndefined()
  expect(o.changed).toBe(false)
}, 60_000)

test('a962 AC3: the backup timer runs only for the lease holder, one run at a time, and survives a failure', async () => {
  const mk = (backupOpt: { everyMs: number; run: () => Promise<unknown> }, holder = 'a', home?: string) => {
    const h = home ?? mkdtempSync(join(tmpdir(), 'server-bk-'))
    if (!home) dirs.push(h)
    const logs: string[] = []
    const s = serve({
      home: h,
      port: 0,
      everyMs: 50,
      leaseMs: 1000,
      holder,
      log: l => logs.push(l),
      tick: () => {},
      backup: backupOpt,
    })
    return { s, h, logs }
  }
  // (0) the first run comes after everyMs
  let n0 = 0
  const z = mk({ everyMs: 200, run: async () => void n0++ })
  await sleep(100)
  expect(n0).toBe(0)
  await z.s.stop()
  // (a) a holder runs again and again
  let na = 0
  const a = mk({ everyMs: 50, run: async () => void na++ })
  await sleep(400)
  expect(na).toBeGreaterThanOrEqual(2)
  await a.s.stop()
  // (b) a run that never ends is not started a second time
  let nb = 0
  const b = mk({ everyMs: 50, run: () => (nb++, new Promise(() => {})) })
  await sleep(400)
  expect(nb).toBe(1)
  await b.s.stop()
  // (c) a server that waits for the lease never runs
  let nc = 0
  const h1 = mkdtempSync(join(tmpdir(), 'server-bk-'))
  dirs.push(h1)
  const c1 = mk({ everyMs: 50, run: async () => {} }, 'a', h1)
  const c2 = mk({ everyMs: 50, run: async () => void nc++ }, 'b', h1)
  await sleep(400)
  expect(nc).toBe(0)
  await c2.s.stop()
  await c1.s.stop()
  // (d) a failure is logged and the loop goes on
  let nd = 0
  const d = mk({ everyMs: 50, run: () => (nd++, Promise.reject(new Error('exit 3'))) })
  await sleep(400)
  expect(nd).toBeGreaterThanOrEqual(2)
  expect(d.logs).toContain('backup failed: exit 3')
  await d.s.stop()
  // (e) after stop() no run starts
  let ne = 0
  const e = mk({ everyMs: 50, run: async () => void ne++ })
  await sleep(200)
  await e.s.stop()
  const at = ne
  await sleep(200)
  expect(ne).toBe(at)
}, 30_000)

// a962 AC4: the `factory server backup` child
async function child(home: string, extra: Record<string, string>, args: string[] = []) {
  const p = Bun.spawn([CLI, 'server', 'backup', ...args], {
    env: { ...env(home), ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  kids.push(p)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}
const gitOf = (dir: string, ...a: string[]) => Bun.spawnSync(['git', '--git-dir', dir, ...a])
function childSetup() {
  const { ws, home } = wsHome()
  mkdirSync(join(ws, 'bin'))
  writeFileSync(join(ws, 'bin', 'gitleaks'), "#!/bin/sh\necho '[]'\n", { mode: 0o755 })
  const ws2 = mkdtempSync(join(tmpdir(), 'server-remote-'))
  dirs.push(ws2)
  const bare = join(ws2, 'remote.git')
  expect(Bun.spawnSync(['git', 'init', '-q', '--bare', bare]).exitCode).toBe(0)
  writeFileSync(join(ws2, 'basic'), 'eHE6enE=\n')
  const extra: Record<string, string> = {
    FACTORY_SERVER_BACKUP_REMOTE: bare,
    FACTORY_SERVER_BACKUP_AUTH_FILE: join(ws2, 'basic'),
    PATH: `${join(ws, 'bin')}:${process.env.PATH}`,
  }
  const tip = () => gitOf(bare, 'rev-parse', 'server-home')
  const files = () => gitOf(bare, 'ls-tree', '-r', '--name-only', 'server-home').stdout.toString().split('\n')
  return { ws, home, bare, extra, tip, files }
}

test('a962 AC4: the child backs up the home, leaves the lease file out and removes stale git locks', async () => {
  const s = childSetup()
  writeFileSync(join(s.home, 'server-lease.json'), '{}')
  writeFileSync(join(s.home, 'server-lease.json.x.tmp'), 'x')
  const a = await child(s.home, s.extra)
  expect(a.code).toBe(0)
  expect(s.tip().exitCode).toBe(0)
  expect(s.files()).toContain('home/rigs.json')
  expect(s.files()).not.toContain('home/server-lease.json')
  expect(s.files()).not.toContain('home/server-lease.json.x.tmp')
  expect(a.out + a.err).not.toContain('eHE6enE=')
  const before = s.tip().stdout.toString()
  writeFileSync(join(s.home, 'note.txt'), 'x')
  writeFileSync(join(s.ws, 'backup.git', 'index.lock'), '')
  writeFileSync(join(s.ws, 'backup.git', 'mem.index.lock'), '')
  const b = await child(s.home, s.extra)
  expect(b.code).toBe(0)
  expect(s.tip().stdout.toString()).not.toBe(before)
  expect(s.files()).toContain('home/note.txt')
}, 60_000)

test('a962 AC4: the child skips when another backup holds backup.lock', async () => {
  const s = childSetup()
  mkdirSync(join(s.home, 'backup.lock'))
  writeFileSync(join(s.home, 'backup.lock', 'pid'), String(process.pid))
  const a = await child(s.home, s.extra)
  expect(a.code).toBe(0)
  expect(a.out).toContain('backup skipped: another backup runs')
  expect(s.tip().exitCode).not.toBe(0)
}, 30_000)

test('a962 AC4: the child refuses a home that is not ready and goes off without a remote or on the manager branch', async () => {
  const s = childSetup()
  rmSync(join(s.home, 'rigs.json'))
  const a = await child(s.home, s.extra)
  expect(a.code).toBe(0)
  expect(a.out).toContain('backup refused: home is not ready')
  expect(s.tip().exitCode).not.toBe(0)
  const { FACTORY_SERVER_BACKUP_REMOTE: _r, ...noRemote } = s.extra
  const b = await child(s.home, noRemote)
  expect(b).toMatchObject({ code: 0, out: 'backup off: no remote\n' })
  const c = await child(s.home, { ...s.extra, FACTORY_SERVER_BACKUP_BRANCH: 'manager-home' })
  expect(c).toMatchObject({ code: 0, out: 'backup off: bad branch\n' })
  expect(existsSync(join(s.ws, 'backup.git'))).toBe(false)
  expect(s.tip().exitCode).not.toBe(0)
  const d = await child(s.home, s.extra, ['x'])
  expect(d.code).toBe(1)
  expect(d.err).toContain('usage: factory server backup')
}, 30_000)

// akiq.15 AC8: the patrol job
test('akiq.15 AC8: the patrol job runs only for the lease holder, one at a time, and survives a failure', async () => {
  const mk = (run: () => Promise<unknown>, holder = 'a', home?: string) => {
    const h = home ?? mkdtempSync(join(tmpdir(), 'server-pt-'))
    if (!home) dirs.push(h)
    const logs: string[] = []
    const s = serve({
      home: h,
      port: 0,
      everyMs: 50,
      leaseMs: 1000,
      holder,
      log: l => logs.push(l),
      tick: () => {},
      patrol: { everyMs: 50, run },
    })
    return { s, h, logs }
  }
  let na = 0
  const a = mk(async () => void na++)
  await sleep(400)
  expect(na).toBeGreaterThanOrEqual(2)
  await a.s.stop()
  let nb = 0
  const b = mk(() => (nb++, new Promise(() => {})))
  await sleep(400)
  expect(nb).toBe(1)
  await b.s.stop()
  let nc = 0
  const h1 = mkdtempSync(join(tmpdir(), 'server-pt-'))
  dirs.push(h1)
  const c1 = mk(async () => {}, 'a', h1)
  const c2 = mk(async () => void nc++, 'b', h1)
  await sleep(400)
  expect(nc).toBe(0)
  await c2.s.stop()
  await c1.s.stop()
  let nd = 0
  const d = mk(() => (nd++, Promise.reject(new Error('exit 3'))))
  await sleep(400)
  expect(nd).toBeGreaterThanOrEqual(2)
  expect(d.logs).toContain('patrol failed: exit 3')
  await d.s.stop()
}, 30_000)

test('akiq.15 AC8: --patrol-every-ms is off by default and must be at least --every-ms', () => {
  expect(parseFlags([]).patrolMs).toBe(0)
  expect(parseFlags(['--patrol-every-ms', '60000']).patrolMs).toBe(60000)
  expect(() => parseFlags(['--every-ms', '100', '--patrol-every-ms', '50'])).toThrow('usage')
  expect(() => parseFlags(['--patrol-every-ms', 'x'])).toThrow('usage')
})

/** a server child with a fake claude, on a home with one kept mail */
async function patrolServer(extra: string[]) {
  const home = newHome()
  const stub = join(home, '..', `claude-${basename(home)}.sh`)
  writeFileSync(
    stub,
    `#!/bin/sh\ncat > /dev/null\nenv > '${home}/child-env.txt'\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`,
  )
  chmodSync(stub, 0o755)
  writeFileSync(
    join(home, 'patrol-state.json'),
    JSON.stringify({
      unsent: [{ run: 'r1', from: 'build', text: 'which branch?', at: 5 }],
      seen: [],
      patrolAt: 0,
    }),
  )
  const p = Bun.spawn([CLI, 'server', ...FAST, ...extra], {
    env: { ...env(home), FACTORY_CLAUDE: stub },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  kids.push(p)
  return { home, p, stub }
}

test('akiq.15 AC8: the server runs the patrol with its own HOME; with the flag off it runs none', async () => {
  const on = await patrolServer(['--patrol-every-ms', '200'])
  const steps = join(on.home, 'agent-steps.jsonl')
  for (let i = 0; i < 100 && !existsSync(steps); i++) await sleep(100)
  expect(JSON.parse(readFileSync(steps, 'utf8').split('\n')[0]!)).toMatchObject({
    step: 'patrol',
    outcome: 'ok',
  })
  expect(readFileSync(join(on.home, 'child-env.txt'), 'utf8')).toContain(`HOME=${on.home}/steps/patrol\n`)
  on.p.kill('SIGKILL')
  rmSync(on.stub)
  const off = await patrolServer([])
  await sleep(1500)
  expect(existsSync(join(off.home, 'agent-steps.jsonl'))).toBe(false)
  rmSync(off.stub)
}, 30_000)
