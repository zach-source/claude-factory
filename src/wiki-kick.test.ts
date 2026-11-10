// `factory tick` starts `factory wiki refresh` (claude-factory-tx6c.5) and `factory wiki groom`
// (claude-factory-tx6c.9). kickWiki in src/cli.ts is the only caller. Refresh runs at most once in
// FACTORY_WIKI_REFRESH_MIN minutes (default 30), also while halted. Groom runs once in FACTORY_WIKI_GROOM_MIN
// minutes (default 1440), not while halted. At most one pass starts in each tick, and only when wiki/.git exists.
// The tests follow src/gc-kick.test.ts.
import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(realpathSync(tmpdir()), `wiki-kick-${process.pid}`)
let n = 0
let home = ''

// Child ownership (AC10). Every `bun` that the CLI starts goes through a shim that loads SUPERVISOR. SUPERVISOR
// holds each Node and Bun child handle. The process exits only after each child has exited. A scope holds the
// handles that the test owns. The hook removes a fixture only when each handle has exit proof. A signal, a lock,
// a stamp, a timeout or a death by signal is not proof.
type Handle = {
  kill(sig?: string | number): void
  exited: Promise<unknown>
  readonly exitCode: number | null
  readonly signalCode: string | null
}
type Owned = { h: Handle; supervised: boolean; settled: boolean }
type Scope = { dir: string; handles: Owned[]; linked: Scope[]; synthetic?: boolean }
type Exit = { exitCode: number | null; signalCode: string | null }
const main: Scope = { dir, handles: [], linked: [] }
/** fake handles: only a synthetic scope (no process in it) accepts them without a real exit */
const fakes = new WeakSet<object>()
let synth = 0
/** own a child in a scope (the main scope by default). A supervised handle needs SIGTERM, so that it awaits its own children. */
function own<T extends Handle>(h: T, supervised = false, scope = main): T {
  if (scope.synthetic && !fakes.has(h)) throw new Error('a synthetic scope owns fake handles only')
  const o: Owned = { h, supervised, settled: false }
  scope.handles.push(o)
  void h.exited.then(
    () => (o.settled = true),
    () => (o.settled = true),
  )
  return h
}
/** a scope in a subdirectory of the fixture: the hook cleans it before the main scope */
function linkedScope(): Scope {
  const s: Scope = { dir: join(dir, `scope-${++synth}`), handles: [], linked: [] }
  mkdirSync(s.dir, { recursive: true })
  main.linked.push(s)
  return s
}
/** a scope with its own directory and no process: the test removes the directory itself */
function syntheticScope(): Scope {
  const s: Scope = { dir: `${dir}-synthetic-${++synth}`, handles: [], linked: [], synthetic: true }
  mkdirSync(s.dir, { recursive: true })
  return s
}
/** a handle that the test controls: kill(sig, resolve) decides what a signal does */
function fakeHandle(kill: (sig: string | number | undefined, resolve: (r: Exit) => void) => void = () => {}) {
  let done!: (r: Exit) => void
  const exited = new Promise<unknown>(r => (done = r))
  const h = {
    exitCode: null as number | null,
    signalCode: null as string | null,
    exited,
    kill(sig?: string | number) {
      kill(sig, resolve)
    },
  }
  const resolve = (r: Exit) => {
    h.exitCode = r.exitCode
    h.signalCode = r.signalCode
    done(r)
  }
  fakes.add(h)
  return { handle: h as Handle, resolve }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const exitedWithin = (c: Handle, ms: number) =>
  Promise.race([c.exited.then(() => true), sleep(ms).then(() => false)])
// Fixture children are single Bun processes: a shell would leave a `sleep` descendant that no handle owns.
const q = (s: string) => JSON.stringify(s)
// the nested row (AC10 assertion cleanup) shortens the hook wait; a normal run keeps this
let hookMs = 10_000
/** exit proof: a direct handle has exited; a supervised handle has exited and was not killed by a signal */
const proof = (o: Owned) => o.settled && (!o.supervised || o.h.signalCode === null)
/** the first signal to one owned handle; an error is returned as text. A settled handle gets none. */
function signal(o: Owned): string | undefined {
  if (o.settled) return undefined
  try {
    o.h.kill(o.supervised ? 'SIGTERM' : 'SIGKILL')
  } catch (e) {
    return String(e)
  }
  return undefined
}
/** await the exit of one owned handle; a supervisor that stays gets SIGKILL, which proves nothing about its children */
async function settle(o: Owned, ms: number) {
  if (!(await exitedWithin(o.h, ms)) && o.supervised) {
    try {
      o.h.kill('SIGKILL')
    } catch {}
    await exitedWithin(o.h, ms)
  }
  return proof(o)
}
/** signal every owned handle (a signal error does not stop the next), await each exit, keep the handles without proof; remove the fixture only when none is left */
async function cleanup(scope: Scope, ms = hookMs): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  const linked = await Promise.all(scope.linked.map(async s => ({ s, r: await cleanup(s, ms) })))
  for (const { s, r } of linked) {
    errors.push(...r.errors)
    if (r.ok) scope.linked = scope.linked.filter(x => x !== s)
  }
  for (const o of scope.handles) {
    const e = signal(o)
    if (e) errors.push(e)
  }
  const results = await Promise.all(scope.handles.map(o => settle(o, ms)))
  scope.handles = scope.handles.filter((_, i) => !results[i])
  const ok = scope.handles.length === 0 && scope.linked.length === 0
  if (ok) rmSync(scope.dir, { recursive: true, force: true })
  return { ok, errors }
}
afterEach(async () => {
  // no exit proof: keep the fixture, so no child works on a deleted home
  const r = await cleanup(main)
  if (!r.ok) throw new Error(`an owned child did not exit: fixture kept in ${dir}: ${r.errors.join('; ')}`)
  rmSync(`${dir}-log`, { recursive: true, force: true })
})

const SUPERVISOR = `const cp = require('node:child_process')
const spawn = cp.spawn
const bunSpawn = Bun.spawn
const realExit = process.exit.bind(process)
const live = []
const ended = []
let pending = 0
let cancelling = false
let exitCode
let finishing = false
function track(c, p) {
  pending++
  live.push(c)
  ended.push(p)
  const done = () => { pending-- }
  Promise.resolve(p).then(done, done)
  if (cancelling) try { c.kill('SIGTERM') } catch {}
}
async function finish(code) {
  if (exitCode === undefined) exitCode = code
  if (finishing) return
  finishing = true
  while (pending > 0) await Promise.allSettled(ended)
  realExit(exitCode)
}
cp.spawn = function (...a) {
  const c = spawn.apply(this, a)
  c.unref = () => c
  track(c, new Promise(r => { c.once('exit', r); c.once('error', () => { if (c.pid === undefined) r() }) }))
  return c
}
Bun.spawn = function (...a) {
  const c = bunSpawn.apply(this, a)
  try { c.unref = () => {} } catch {}
  track(c, c.exited)
  return c
}
process.exit = code => {
  if (pending === 0) realExit(code ?? process.exitCode ?? 0)
  finish(code ?? process.exitCode ?? 0)
}
process.on('SIGTERM', () => {
  cancelling = true
  for (const c of live) try { c.kill('SIGTERM') } catch {}
  finish(143)
})
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.error(e); finish(1) })
`
/** fixture gh, glab, claude and codex first on PATH: each records its call in forge-calls and fails. The bun shim adds the supervisor. */
const fx = () => join(dir, 'fx')
const forgeCalls = () => join(dir, 'forge-calls')
function fixtureTools() {
  mkdirSync(fx(), { recursive: true })
  for (const name of ['gh', 'glab', 'claude', 'codex']) {
    writeFileSync(join(fx(), name), `#!/bin/sh\necho "${name} $*" >> '${forgeCalls()}'\nexit 1\n`)
    chmodSync(join(fx(), name), 0o755)
  }
  writeFileSync(join(fx(), 'supervisor.js'), SUPERVISOR)
  const shim = join(fx(), 'bun')
  writeFileSync(
    shim,
    `#!/bin/sh\nexec '${process.execPath}' --preload '${join(fx(), 'supervisor.js')}' "$@"\n`,
  )
  chmodSync(shim, 0o755)
}
/** run the CLI; it returns after the CLI and every child it spawned have exited. On a timeout it sends SIGTERM and awaits the supervisor. */
const factory = async (args: string[], env: Record<string, string> = {}, timeout = 120_000) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_NO_KICK, FACTORY_WIKI_REMOTE, ...laptop } =
    process.env
  fixtureTools()
  const p = own(
    Bun.spawn([CLI, ...args], {
      env: {
        ...laptop,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_GC: '0',
        FACTORY_CLAUDE: join(fx(), 'claude'),
        ...env,
        PATH: `${fx()}:${env.PATH ?? laptop.PATH}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    true,
  )
  const out = new Response(p.stdout as ReadableStream).text()
  const err = new Response(p.stderr as ReadableStream).text()
  const o = main.handles.find(x => x.h === p)!
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<boolean>(r => (timer = setTimeout(() => r(true), timeout)))
  const timedOut = await Promise.race([p.exited.then(() => false), late])
  clearTimeout(timer!)
  if (timedOut) signal(o)
  await settle(o, hookMs) // a supervisor that stays has no exit proof: the entry stays and the hook refuses
  if (proof(o)) main.handles = main.handles.filter(x => x !== o)
  const code = p.exitCode
  return { code, out: await out, err: await err, timedOut }
}
const stamp = () => join(home, 'wiki-refresh.stamp')
const groomStampPath = () => join(home, 'wiki-groom.stamp')

/** a new home with one rig; `repo` is a wiki repo with the seed pages when true */
async function setup(withWiki = true, groomStamp = true) {
  home = join(dir, `home${++n}`)
  mkdirSync(home, { recursive: true })
  const repo = join(dir, `repo${n}`)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'acme', repo, factory: join(dir, 'f.ts') }]))
  if (withWiki) expect((await factory(['wiki', 'init'], { FACTORY_NO_KICK: '1' })).code).toBe(0)
  // a fresh write stamp: the refresh tests must not race a write pass for wiki.lock
  writeFileSync(join(home, 'wiki-write.stamp'), '')
  if (groomStamp) writeFileSync(groomStampPath(), '')
}

test('AC7 a tick with a wiki repo and no stamp writes the stamp and the rig page', async () => {
  await setup()
  await factory(['tick'])
  expect(existsSync(stamp())).toBe(true)
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
}, 30_000)

test('AC7 a tick without wiki/.git makes no stamp and no wiki dir', async () => {
  await setup(false)
  await factory(['tick'])
  expect(existsSync(stamp())).toBe(false)
  expect(existsSync(join(home, 'wiki'))).toBe(false)
})

test('AC7 a halted factory still gets the refresh', async () => {
  await setup()
  writeFileSync(
    join(home, 'halt.json'),
    JSON.stringify({ state: 'paused', at: Date.now(), told: {}, closed: {} }),
  )
  await factory(['tick'])
  expect(existsSync(stamp())).toBe(true)
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
}, 30_000)

test('AC7 a fresh stamp starts no refresh', async () => {
  await setup()
  writeFileSync(stamp(), '')
  const t = statSync(stamp()).mtimeMs
  await factory(['tick'])
  expect(statSync(stamp()).mtimeMs).toBe(t)
  expect(existsSync(join(home, 'wiki', 'rigs'))).toBe(false)
})

test('AC7 FACTORY_WIKI_REFRESH_MIN=1 and a stamp 2 min old: the tick refreshes', async () => {
  await setup()
  writeFileSync(stamp(), '')
  const old = new Date(Date.now() - 120_000)
  utimesSync(stamp(), old, old)
  await factory(['tick'], { FACTORY_WIKI_REFRESH_MIN: '1' })
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
  expect(statSync(stamp()).mtimeMs).toBeGreaterThan(old.getTime() + 60_000)
}, 30_000)

test('AC7 a held wiki.lock starts no refresh', async () => {
  await setup()
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  await factory(['tick'])
  expect(existsSync(stamp())).toBe(false)
})

test('AC7 a negative FACTORY_WIKI_REFRESH_MIN falls back to 30 min', async () => {
  await setup()
  writeFileSync(stamp(), '')
  const t = statSync(stamp()).mtimeMs
  await factory(['tick'], { FACTORY_WIKI_REFRESH_MIN: '-5' })
  expect(statSync(stamp()).mtimeMs).toBe(t)
})

// ---- the write kick (claude-factory-tx6c.7): every 180 min, never while halted ----
const wstamp = () => join(home, 'wiki-write.stamp')
/** a rig with .beads and a bd that waits `ms` on its first call and fails: a pass holds wiki.lock long enough. One process only (exec). */
function slowPass(ms = 1000) {
  mkdirSync(join(dir, `repo${n}`, '.beads'), { recursive: true })
  fixtureTools()
  const marker = join(dir, `bd-slow-${n}`)
  const bun = process.execPath
  writeFileSync(
    join(fx(), 'bd'),
    `#!/bin/sh\nif [ -e '${marker}' ]; then exec '${bun}' -e 'process.exit(1)'; fi\n: > '${marker}'\nexec '${bun}' -e 'setTimeout(() => process.exit(1), ${ms})'\n`,
  )
  chmodSync(join(fx(), 'bd'), 0o755)
}
/** the write stamp, set `min` minutes old */
function aged(min: number) {
  writeFileSync(wstamp(), '')
  const t = new Date(Date.now() - min * 60_000)
  utimesSync(wstamp(), t, t)
}
/** ticks and tells whether the stamp moved: a moved stamp means one launch */
async function launched(env: Record<string, string> = {}) {
  const t = existsSync(wstamp()) ? statSync(wstamp()).mtimeMs : 0
  writeFileSync(stamp(), '') // a fresh refresh stamp: one wiki pass in each tick, so refresh must not take it
  if (!existsSync(join(dir, `repo${n}`, '.beads'))) slowPass()
  await factory(['tick'], env)
  const moved = existsSync(wstamp()) && statSync(wstamp()).mtimeMs !== t
  return moved
}

test('write AC6 kick matrix: age, wiki, lock, halt, NO_KICK', async () => {
  await setup()
  rmSync(wstamp())
  expect(await launched()).toBe(true) // no stamp
  await setup()
  aged(181)
  expect(await launched()).toBe(true)
  await setup()
  aged(10)
  expect(await launched()).toBe(false)
  await setup(false)
  aged(181)
  expect(await launched()).toBe(false)
  await setup()
  aged(181)
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  expect(await launched()).toBe(false)
  for (const state of ['paused', 'stopping']) {
    await setup()
    aged(181)
    writeFileSync(join(home, 'halt.json'), JSON.stringify({ state, at: Date.now(), told: {}, closed: {} }))
    expect(await launched()).toBe(false)
  }
  await setup()
  aged(181)
  expect(await launched({ FACTORY_NO_KICK: '1' })).toBe(false)
}, 60_000)

test('write AC6 FACTORY_WIKI_WRITE_MIN: 1 moves a 2 min stamp; bad values keep 180', async () => {
  await setup()
  aged(2)
  expect(await launched({ FACTORY_WIKI_WRITE_MIN: '1' })).toBe(true)
  for (const v of ['0', '-5', 'abc', 'Infinity']) {
    await setup()
    aged(10)
    expect([v, await launched({ FACTORY_WIKI_WRITE_MIN: v })]).toEqual([v, false])
    aged(181)
    expect([v, await launched({ FACTORY_WIKI_WRITE_MIN: v })]).toEqual([v, true])
  }
}, 60_000)

test('write AC6 a launch whose pass fails at once is not repeated by the next two ticks', async () => {
  await setup()
  rmSync(wstamp())
  // a rig with .beads and a bd that fails after 1 s: the pass ends in an error
  mkdirSync(join(dir, `repo${n}`, '.beads'))
  const bin = join(dir, `bin${n}`)
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'bd'),
    `#!/bin/sh\nexec '${process.execPath}' -e 'setTimeout(() => process.exit(1), 1000)'\n`,
  )
  chmodSync(join(bin, 'bd'), 0o755)
  const env = { PATH: `${bin}:${process.env.PATH}` }
  expect(await launched(env)).toBe(true)
  const t = statSync(wstamp()).mtimeMs
  expect(await launched(env)).toBe(false)
  expect(await launched(env)).toBe(false)
  expect(statSync(wstamp()).mtimeMs).toBe(t)
}, 60_000)

test('write AC6 a tick after a launch starts no second pass at once', async () => {
  await setup()
  rmSync(wstamp())
  expect(await launched()).toBe(true)
  expect(await launched()).toBe(false)
  expect(await launched()).toBe(false)
}, 60_000)

/** a fake claude that leaves a marker file: a groom pass with no remote must never reach it */
function fakeClaude() {
  const claude = join(dir, 'claude')
  const marker = join(dir, 'claude-ran')
  writeFileSync(claude, `#!/bin/sh\ntouch ${marker}\n`)
  chmodSync(claude, 0o755)
  return { env: { FACTORY_CLAUDE: claude }, marker }
}
const wikiLogText = () =>
  existsSync(join(home, 'wiki.log')) ? readFileSync(join(home, 'wiki.log'), 'utf8') : ''

test('AC10 a fresh refresh stamp and no groom stamp: the tick starts a groom pass', async () => {
  await setup(true, false)
  writeFileSync(stamp(), '')
  const c = fakeClaude()
  await factory(['tick'], c.env)
  expect(existsSync(groomStampPath())).toBe(true)
  expect(wikiLogText()).toContain('wiki groom: no remote, skipped')
  expect(existsSync(c.marker)).toBe(false)
}, 30_000)

test('AC10 a fresh groom stamp starts no groom pass', async () => {
  await setup()
  writeFileSync(stamp(), '')
  const t = statSync(groomStampPath()).mtimeMs
  await factory(['tick'])
  expect(statSync(groomStampPath()).mtimeMs).toBe(t)
})

test('AC10 FACTORY_WIKI_GROOM_MIN=1 and a groom stamp 2 min old: the tick grooms', async () => {
  await setup()
  writeFileSync(stamp(), '')
  const old = new Date(Date.now() - 120_000)
  utimesSync(groomStampPath(), old, old)
  await factory(['tick'], { FACTORY_WIKI_GROOM_MIN: '1' })
  expect(statSync(groomStampPath()).mtimeMs).toBeGreaterThan(old.getTime() + 60_000)
})

test('AC10 a halted factory gets no groom pass', async () => {
  await setup(true, false)
  writeFileSync(stamp(), '')
  writeFileSync(
    join(home, 'halt.json'),
    JSON.stringify({ state: 'paused', at: Date.now(), told: {}, closed: {} }),
  )
  await factory(['tick'])
  expect(existsSync(groomStampPath())).toBe(false)
})

test('AC10 one wiki pass in each tick: no stamps at all gives the refresh stamp only', async () => {
  await setup(true, false)
  await factory(['tick'])
  expect(existsSync(stamp())).toBe(true)
  expect(existsSync(groomStampPath())).toBe(false)
})

test('AC10 an ambient wiki remote reaches no setup or tick child', async () => {
  // fake gh and git first on PATH: gh records every call, git records and refuses transport commands
  const bin = join(dir, `bin-${++n}`)
  mkdirSync(bin, { recursive: true })
  const calls = join(dir, `calls-${n}`)
  const realGit = Bun.which('git')
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${calls}'\necho PRIVATE\n`)
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase " $* " in *" push "*|*" fetch "*|*" pull "*|*" ls-remote "*|*" clone "*) echo "$*" >> '${calls}'; exit 1;; esac\nexec '${realGit}' "$@"\n`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  chmodSync(join(bin, 'git'), 0o755)
  const seeded: Record<string, string> = {
    FACTORY_WIKI_REMOTE: 'https://example.invalid/acme/ambient.git',
    FACTORY_OUTBOX: join(dir, 'outbox'),
    FACTORY_FROM: 'ambient',
    FACTORY_RUN: 'ambient-run',
    PATH: `${bin}:${process.env.PATH}`,
  }
  const before = Object.fromEntries(Object.keys(seeded).map(k => [k, process.env[k]]))
  Object.assign(process.env, seeded)
  try {
    await setup()
    slowPass()
    await factory(['tick'])
    expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
    expect(existsSync(forgeCalls())).toBe(false)
    expect(
      Bun.spawnSync(['git', '-C', join(home, 'wiki'), 'config', '--get', 'remote.origin.url']).exitCode,
    ).not.toBe(0)
    expect(existsSync(calls)).toBe(false)
    expect(existsSync(join(dir, 'outbox'))).toBe(false)
    for (const [k, v] of Object.entries(seeded)) expect(process.env[k]).toBe(v)
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}, 30_000)

const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
const waitFor = async (f: () => boolean, ms = 10_000) => {
  for (const t = Date.now(); !f(); await sleep(50)) if (Date.now() - t > ms) throw new Error('timeout')
}
/** a script run through the shim (so with the supervisor) that starts one detached child and records its pid */
function supervised(childArgs: string, pidFile: string) {
  const file = join(fx(), `main-${++n}.js`)
  writeFileSync(
    file,
    `const { spawn } = require('node:child_process')
const c = spawn(${q(process.execPath)}, ['-e', ${q(childArgs)}], { detached: true, stdio: 'ignore' })
c.unref()
require('node:fs').writeFileSync(${q(pidFile)}, String(c.pid))
`,
  )
  return own(Bun.spawn([join(fx(), 'bun'), file], { stdout: 'ignore', stderr: 'ignore' }), true)
}

test('AC10 supervisor: a process ends only after its detached child exits', async () => {
  fixtureTools()
  const pidFile = join(dir, 'kid.pid')
  const t = Date.now()
  const p = supervised('setTimeout(() => {}, 1500)', pidFile)
  expect(await p.exited).toBe(0)
  expect(Date.now() - t).toBeGreaterThanOrEqual(1400)
  expect(gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
}, 30_000)

test('AC10 supervisor: SIGTERM kills the child by handle and awaits it before exit', async () => {
  fixtureTools()
  const pidFile = join(dir, 'kid.pid')
  const p = supervised('setTimeout(() => {}, 60000)', pidFile)
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')
  const kid = Number(readFileSync(pidFile, 'utf8'))
  expect(gone(kid)).toBe(false)
  p.kill('SIGTERM')
  expect(await exitedWithin(p, 10_000)).toBe(true)
  expect(gone(kid)).toBe(true) // the supervisor exited only after its child
}, 30_000)

test('AC10 supervisor: a tick returns only after its detached pass ended', async () => {
  await setup()
  slowPass()
  await factory(['tick'])
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true) // the refresh pass finished
  expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
  expect(main.handles).toEqual([])
}, 60_000)

// ---- AC10.1 order and ready files live in ${dir}-log, outside the fixture the hook removes ----
const logDir = () => `${dir}-log`
const O = () => join(logDir(), 'order')
const R = () => join(logDir(), 'ready')
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
const has = (f: string, line: string) => lines(f).includes(line)
/** the start of every fixture script: ap(file, line) appends a line; O and R are the order and ready files */
const PRE = () =>
  `const fs = require('node:fs'); const { spawn } = require('node:child_process'); const O = ${q(O())}, R = ${q(R())}; const ap = (f, s) => fs.appendFileSync(f, s + '\\n');`
/** a plain Bun child script (no supervisor) with a lifetime cap: a signal listener alone does not keep Bun alive */
const kid = (js: string) => `${PRE()} setTimeout(() => process.exit(0), 30000); ${js}`
const SLEEP = 'setTimeout(() => {}, 60000)'
/** write a script and run it through the shim (with the supervisor): the supervisor is an owned, supervised handle */
function runSup(js: string, name = `s${++n}.js`) {
  fixtureTools()
  mkdirSync(logDir(), { recursive: true })
  const file = join(fx(), name)
  writeFileSync(file, `${PRE()}\n${js}`)
  return own(Bun.spawn([join(fx(), 'bun'), file], { stdout: 'ignore', stderr: 'ignore' }), true)
}
/** a Node spawn line for a child script */
const sp = (js: string, v = 'c') =>
  `const ${v} = spawn(${q(process.execPath)}, ['-e', ${q(kid(js))}], { stdio: 'ignore' }); ${v}.on('error', () => {});`

test('AC10 cancellation awaits descendant scope: tool exits, then pass, then supervisor, then removal', async () => {
  fixtureTools()
  mkdirSync(logDir(), { recursive: true })
  const pass = join(fx(), 'pass.js')
  const tool = kid(`process.on('SIGTERM', () => { ap(O, 'tool'); process.exit(0) }); ap(R, 't')`)
  writeFileSync(
    pass,
    `${PRE()} process.on('exit', () => ap(O, 'pass')); Bun.spawn([${q(process.execPath)}, '-e', ${q(tool)}])`,
  )
  const s = runSup(
    `process.on('exit', () => ap(O, 'supervisor')); spawn(${q(join(fx(), 'bun'))}, [${q(pass)}], { stdio: 'ignore' })`,
  )
  const unrelated = Bun.spawn([process.execPath, '-e', SLEEP])
  try {
    await waitFor(() => has(R(), 't'))
    const r = await cleanup(main)
    expect(r.ok).toBe(true)
    expect(lines(O())).toEqual(['tool', 'pass', 'supervisor'])
    expect(s.signalCode).toBeNull()
    expect(s.exitCode).toBe(143)
    expect(existsSync(dir)).toBe(false)
    expect(unrelated.exitCode === null && unrelated.signalCode === null).toBe(true) // no signal
  } finally {
    unrelated.kill('SIGKILL')
    await unrelated.exited
  }
}, 60_000)

test('AC10 cancellation awaits descendant scope: a spawn after cancel', async () => {
  const s = runSup(`let c3
spawn(${q(process.execPath)}, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }) // a live child: the supervisor waits, so the listener below still runs
process.on('SIGTERM', () => { c3 = spawn(${q(process.execPath)}, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); ap(O, 'c3-spawned') })
process.on('exit', () => { ap(O, 'c3:' + c3.signalCode); ap(O, 'supervisor') })
ap(R, 'ready'); setTimeout(() => {}, 30000)`)
  await waitFor(() => has(R(), 'ready'))
  expect((await cleanup(main)).ok).toBe(true)
  expect(lines(O())).toEqual(['c3-spawned', 'c3:SIGTERM', 'supervisor'])
  expect(s.exitCode).toBe(143)
}, 60_000)

test('AC10 cancellation awaits descendant scope: a throwing kill', async () => {
  runSup(`process.on('exit', () => ap(O, 'supervisor'))
${sp(`process.on('SIGTERM', () => {}); ap(R, 'c1-ready'); setTimeout(() => { ap(O, 'c1'); process.exit(0) }, 2500)`, 'c1')}
${sp(`process.on('SIGTERM', () => { ap(O, 'c2'); process.exit(0) }); ap(R, 'c2-ready')`, 'c2')}
c1.kill = () => { throw new Error('EPERM') }`)
  await waitFor(() => has(R(), 'c1-ready') && has(R(), 'c2-ready'))
  expect((await cleanup(main)).ok).toBe(true)
  expect(lines(O())).toEqual(['c2', 'c1', 'supervisor'])
}, 60_000)

test('AC10 cancellation awaits descendant scope: forced death keeps the fixture', async () => {
  const y = syntheticScope()
  try {
    const f = fakeHandle((sig, resolve) => {
      if (sig === 'SIGKILL') resolve({ exitCode: null, signalCode: 'SIGKILL' })
    })
    own(f.handle, true, y)
    const r = await cleanup(y, 200)
    expect(r.ok).toBe(false)
    expect(y.handles.map(o => o.h)).toEqual([f.handle]) // a forced death proves nothing about descendants
    expect(existsSync(y.dir)).toBe(true)
  } finally {
    rmSync(y.dir, { recursive: true, force: true }) // no process exists in a synthetic scope
  }
})

test('AC10 signal error retains all handles', async () => {
  const l = linkedScope()
  const h1 = fakeHandle(() => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  })
  own(h1.handle, false, l)
  const h2 = own(Bun.spawn([process.execPath, '-e', SLEEP]), false, l)
  const r = await cleanup(l, 200)
  expect(r.ok).toBe(false)
  expect(r.errors.length).toBe(1)
  expect(r.errors[0]).toContain('EPERM')
  expect(h2.signalCode).toBe('SIGKILL') // the signal went on after the first error
  expect(l.handles.map(o => o.h)).toEqual([h1.handle])
  expect(existsSync(l.dir)).toBe(true)
  expect((await cleanup(l, 200)).ok).toBe(false) // a repeat does not release
  expect(existsSync(l.dir)).toBe(true)
  h1.resolve({ exitCode: 0, signalCode: null })
  await h1.handle.exited
  const last = await cleanup(l, 200)
  expect(last.ok).toBe(true)
  expect(last.errors).toEqual([]) // a settled handle gets no signal
  expect(existsSync(l.dir)).toBe(false)
})

test('AC10 delayed launch survives deadline: cancellation resolves the intent', async () => {
  await setup(false)
  mkdirSync(join(home, 'wiki.lock'))
  rmSync(join(home, 'wiki.lock'), { recursive: true }) // a removed lock does not release ownership
  const s = runSup(`setTimeout(() => { ${sp(SLEEP)} ap(O, 'launched') }, 4000)`)
  await expect(waitFor(() => has(O(), 'launched'), 3000)).rejects.toThrow('timeout')
  expect(main.handles.some(o => o.h === s)).toBe(true)
  expect(s.exitCode).toBeNull()
  await sleep(200)
  expect((await cleanup(main)).ok).toBe(true)
  expect(s.signalCode).toBeNull()
  expect(s.exitCode).toBe(143)
  expect(existsSync(dir)).toBe(false)
  await sleep(1500) // past 4 s
  expect(has(O(), 'launched')).toBe(false)
}, 60_000)

test('AC10 spawn error is not live child exit: a failed spawn with no child completes', async () => {
  const s = runSup(`spawn('/nonexistent/acme-tool', [], { stdio: 'ignore' }).on('error', () => {})`)
  expect(await exitedWithin(s, 10_000)).toBe(true)
  expect(s.exitCode).toBe(0)
  expect((await cleanup(main)).ok).toBe(true)
}, 30_000)

test('AC10 spawn error is not live child exit: a Bun.spawn that throws completes', async () => {
  const s = runSup(`try { Bun.spawn(['/nonexistent/acme-tool']) } catch {}`)
  expect(await exitedWithin(s, 10_000)).toBe(true)
  expect(s.exitCode).toBe(0)
}, 30_000)

test('AC10 spawn error is not live child exit: an error after the child exists is no proof', async () => {
  const s = runSup(`process.on('exit', () => ap(O, 'supervisor'))
${sp(`process.on('SIGTERM', () => { ap(O, 'child-term'); process.exit(0) }); ap(R, 'ready')`)}
c.emit('error', new Error('late'))`)
  await waitFor(() => has(R(), 'ready'))
  expect(await exitedWithin(s, 1500)).toBe(false)
  expect((await cleanup(main)).ok).toBe(true)
  expect(lines(O())).toEqual(['child-term', 'supervisor'])
}, 60_000)

test('AC10 spawn error is not live child exit: an explicit exit waits for the child', async () => {
  const t = Date.now()
  const s = runSup(`process.on('exit', () => ap(O, 'supervisor'))
${sp(`setTimeout(() => { ap(O, 'child'); process.exit(0) }, 1500)`)}
process.exit(3)`)
  await s.exited
  expect(s.exitCode).toBe(3)
  expect(s.signalCode).toBeNull()
  expect(Date.now() - t).toBeGreaterThanOrEqual(1400)
  expect(lines(O())).toEqual(['child', 'supervisor'])
}, 30_000)

test('AC10 spawn error is not live child exit: a crash waits for the child', async () => {
  const s = runSup(`process.on('exit', () => ap(O, 'supervisor'))
${sp(`setTimeout(() => { ap(O, 'child'); process.exit(0) }, 1500)`)}
setTimeout(() => { throw new Error('acme') }, 0)`)
  await s.exited
  expect(s.exitCode).toBe(1)
  expect(lines(O())).toEqual(['child', 'supervisor'])
}, 30_000)

test('AC10 spawn error is not live child exit: a CLI timeout keeps descendant exit proof', async () => {
  await setup()
  rmSync(wstamp())
  writeFileSync(stamp(), '')
  slowPass(6000)
  const r = await factory(['tick'], {}, 3000)
  expect(r.timedOut).toBe(true)
  expect(r.code).toBe(143)
  expect(main.handles).toEqual([]) // factory() returned only after the supervisor exit was awaited
  expect((await cleanup(main)).ok).toBe(true)
}, 60_000)

test('AC10 control: a direct child is killed and awaited; an unrelated child gets no signal', async () => {
  const mine = own(Bun.spawn([process.execPath, '-e', SLEEP]))
  const other = Bun.spawn([process.execPath, '-e', SLEEP])
  try {
    expect((await cleanup(main)).ok).toBe(true)
    expect(mine.signalCode).toBe('SIGKILL')
    expect(other.exitCode === null && other.signalCode === null).toBe(true)
  } finally {
    other.kill('SIGKILL')
    await other.exited
  }
}, 30_000)

test('AC10 control: a direct child that does not exit keeps the handle and denies proof', async () => {
  const l = linkedScope()
  const f = fakeHandle()
  own(f.handle, false, l)
  expect((await cleanup(l, 100)).ok).toBe(false)
  expect(l.handles.map(o => o.h)).toEqual([f.handle]) // kept: still unproven
  f.resolve({ exitCode: 0, signalCode: null }) // an independent exit
  await f.handle.exited
  expect((await cleanup(l, 100)).ok).toBe(true)
})

// ---- AC10.3 assertion cleanup: a nested `bun test` runs only the fixture test below, with this file's real afterEach ----
// The nested test starts K, which holds the nested stdout pipe and stops when the outer test makes a stop file (an
// inherited stdin does not work: `bun test` closes it at exit, and K would stop at once). The outer test owns the
// nested process, so it knows the nested fixture path. EOF on that pipe comes only after K and the nested runner
// have exited. The nested run does not use the shim: a preloaded `bun test` hangs.
const nestedRow = process.env.FACTORY_WIKI_NESTED
test.skipIf(!nestedRow)('AC10 nested fixture (started by the AC10 assertion cleanup tests)', async () => {
  await setup(false)
  hookMs = 1_000
  const k = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const f = process.env.FACTORY_WIKI_NESTED_STOP; setInterval(() => { if (require('node:fs').existsSync(f)) process.exit(0) }, 50); setTimeout(() => process.exit(0), 30000)",
    ],
    { stdin: 'ignore', stdout: 'inherit', stderr: 'ignore' },
  )
  if (nestedRow === 'denied') {
    // a handle whose signal is refused: the hook keeps the fixture and the child
    own({
      kill() {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      exited: k.exited,
      get exitCode() {
        return k.exitCode
      },
      get signalCode() {
        return k.signalCode
      },
    })
  } else own(k)
  expect(1).toBe(2) // the intentional assertion error
})

const stopFile = () => join(logDir(), 'k-stop')
async function nestedRun(row: 'clean' | 'denied') {
  mkdirSync(logDir(), { recursive: true })
  const p = own(
    Bun.spawn(
      [
        process.execPath,
        'test',
        '--timeout',
        '60000',
        import.meta.path,
        '--test-name-pattern',
        'AC10 nested fixture',
      ],
      {
        env: { ...process.env, FACTORY_WIKI_NESTED: row, FACTORY_WIKI_NESTED_STOP: stopFile() },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      },
    ),
  )
  // EOF on stdout: every process that holds the write end (the nested runner and K) has exited
  const eof = new Response(p.stdout as ReadableStream).text()
  return { p, eof, nestedDir: join(realpathSync(tmpdir()), `wiki-kick-${p.pid}`) }
}

test('AC10 assertion cleanup: clean', async () => {
  const { p, eof, nestedDir } = await nestedRun('clean')
  await Promise.race([eof, sleep(10_000).then(() => Promise.reject(new Error('no stdout EOF: K is live')))]) // K has not seen a stop file
  await p.exited
  expect(p.exitCode).not.toBe(0)
  expect(existsSync(stopFile())).toBe(false)
  expect(existsSync(nestedDir)).toBe(false)
}, 60_000)

test('AC10 assertion cleanup: denied', async () => {
  const { p, eof, nestedDir } = await nestedRun('denied')
  try {
    await p.exited
    expect(p.exitCode).not.toBe(0)
    expect(existsSync(nestedDir)).toBe(true)
    expect(await Promise.race([eof.then(() => 'eof'), sleep(1000).then(() => 'live')])).toBe('live') // K is live
  } finally {
    writeFileSync(stopFile(), '') // the outer test stops K
    await Promise.race([eof, sleep(10_000).then(() => Promise.reject(new Error('K did not exit')))])
    rmSync(nestedDir, { recursive: true, force: true })
  }
}, 60_000)

test('AC10 control: a policy row that launches nothing starts no wiki pass and calls no forge', async () => {
  await setup()
  aged(10)
  expect(await launched()).toBe(false)
  expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
  expect(existsSync(forgeCalls())).toBe(false)
})

test('AC10 each default stub records an explicit call and refuses it', () => {
  fixtureTools()
  for (const name of ['gh', 'glab', 'claude', 'codex']) {
    const r = Bun.spawnSync([join(fx(), name), 'probe'])
    expect([name, r.exitCode]).toEqual([name, 1])
  }
  expect(readFileSync(forgeCalls(), 'utf8').trim().split('\n')).toEqual([
    'gh probe',
    'glab probe',
    'claude probe',
    'codex probe',
  ])
})
