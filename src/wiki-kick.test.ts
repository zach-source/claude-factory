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

// Child ownership (AC10). The CLI starts detached passes and then exits, so the test cannot hold their handles.
// So every `bun` the CLI starts goes through a shim that adds a preload (supervisor). The supervisor wraps
// node:child_process.spawn in that process: it keeps every child handle and neutralises unref(), so the process
// ends only after each child it spawned has exited (the Node handle in the spawning process is the authority).
// A tick, and each pass it starts, is therefore finished when factory() returns. On SIGTERM the supervisor kills
// the children it holds by handle, awaits them and exits. A scope that the test had to time out has no exit
// proof: it is recorded in `stuck`, and the hook keeps the fixture. Direct Bun children the test starts are
// owned with own(). Limit: a child started by Bun.spawn or Bun.$ inside the CLI is not tracked.
const handles: ReturnType<typeof Bun.spawn>[] = []
/** handles of supervised processes: they need SIGTERM, so that they await their own children */
const supervisors = new WeakSet<object>()
/** own a direct child: cleanup kills it and awaits child.exited */
function own<T extends ReturnType<typeof Bun.spawn>>(child: T, supervised = false): T {
  handles.push(child)
  if (supervised) supervisors.add(child)
  return child
}
/** scopes without exit proof (a forced supervisor death): they block cleanup */
const stuck: string[] = []
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const exitedWithin = (c: ReturnType<typeof Bun.spawn>, ms: number) =>
  Promise.race([c.exited.then(() => true), sleep(ms).then(() => false)])
// Fixture children are single Bun processes: a shell would leave a `sleep` descendant that no handle owns.
const q = (s: string) => JSON.stringify(s)
const script = (js: string) => Bun.spawn([process.execPath, '-e', `const fs = require('node:fs'); ${js}`])
// the nested row (AC10 assertion cleanup) shortens the hook wait; a normal run keeps this
let hookMs = 10_000
/** stop one handle by its own handle; a signal error keeps it. true only when its exit is awaited. */
async function stopOne(h: ReturnType<typeof Bun.spawn>, ms: number) {
  const sup = supervisors.has(h)
  try {
    h.kill(sup ? 'SIGTERM' : 'SIGKILL')
  } catch {} // a signal error is not exit proof: wait for the handle
  if (await exitedWithin(h, ms)) return true
  if (sup) {
    // forced death of a supervisor cannot prove that its descendants exited
    try {
      h.kill('SIGKILL')
    } catch {}
    stuck.push('forced supervisor death')
  }
  return false
}
/** stop every owned child and await its exit; false when one did not exit or a scope has no exit proof */
async function stopOwned(ms = hookMs) {
  const all = handles.splice(0)
  const done = await Promise.all(all.map(h => stopOne(h, ms)))
  all.forEach((h, i) => {
    if (!done[i]) handles.push(h) // no exit proof: keep it
  })
  return stuck.length === 0 && done.every(Boolean)
}
afterEach(async () => {
  // no exit proof: keep the fixture, so no child works on a deleted home
  if (!(await stopOwned())) throw new Error(`an owned child did not exit: fixture kept in ${dir}`)
  rmSync(dir, { recursive: true, force: true })
})

const SUPERVISOR = `const cp = require('node:child_process')
const spawn = cp.spawn
const live = []
const ended = []
cp.spawn = function (...a) {
  const c = spawn.apply(this, a)
  live.push(c)
  ended.push(new Promise(r => { c.once('exit', r); c.once('error', () => { if (c.pid === undefined) r() }) }))
  c.unref = () => c
  return c
}
process.on('SIGTERM', () => {
  for (const c of live) c.kill('SIGKILL')
  Promise.all(ended).then(() => process.exit(143))
})
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
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    p.kill('SIGTERM')
  }, timeout)
  const code = await p.exited
  clearTimeout(timer)
  handles.splice(handles.indexOf(p), 1) // exit awaited: this scope has its proof
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
/** a rig with .beads and a bd that waits 1 s and fails: a pass holds wiki.lock long enough */
function slowPass() {
  mkdirSync(join(dir, `repo${n}`, '.beads'), { recursive: true })
  fixtureTools()
  writeFileSync(join(fx(), 'bd'), '#!/bin/sh\nsleep 1\nexit 1\n')
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
  writeFileSync(join(bin, 'bd'), '#!/bin/sh\nsleep 1\nexit 1\n')
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
  const main = join(fx(), `main-${++n}.js`)
  writeFileSync(
    main,
    `const { spawn } = require('node:child_process')
const c = spawn(${q(process.execPath)}, ['-e', ${q(childArgs)}], { detached: true, stdio: 'ignore' })
c.unref()
require('node:fs').writeFileSync(${q(pidFile)}, String(c.pid))
`,
  )
  return own(Bun.spawn([join(fx(), 'bun'), main], { stdout: 'ignore', stderr: 'ignore' }), true)
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
  expect(stuck).toEqual([])
}, 60_000)

test('AC10 cancellation awaits the descendant scope: a timed-out run ends only after its tool and pass exit', async () => {
  await setup(false)
  const r = await factory(['tick'], {}, 1)
  expect(r.timedOut).toBe(true)
  expect(handles).toEqual([]) // the supervisor exit was awaited
  expect(stuck).toEqual([])
}, 30_000)

test('AC10 signal error retains all handles: the first handle throws on kill, the second is still awaited', async () => {
  const bad = {
    kill: () => {
      throw new Error('EPERM')
    },
    exited: new Promise(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>
  const good = own(Bun.spawn(['sleep', '60']))
  own(bad)
  expect(await stopOwned(100)).toBe(false)
  expect(gone(good.pid)).toBe(true)
  expect(handles).toEqual([bad]) // kept
  expect(await stopOwned(100)).toBe(false) // a repeat cleanup still denies removal
  handles.length = 0
})

test('AC10 forced supervisor death keeps the fixture: no exit proof for its descendants', async () => {
  const stubborn = { kill: () => {}, exited: new Promise(() => {}) } as unknown as ReturnType<
    typeof Bun.spawn
  >
  own(stubborn, true)
  expect(await stopOwned(50)).toBe(false)
  expect(stuck).toEqual(['forced supervisor death'])
  handles.length = 0
  stuck.length = 0
})

test('AC10 delayed launch survives the deadline: a supervised process waits for a child it starts after 4 s', async () => {
  fixtureTools()
  const pidFile = join(dir, 'late.pid')
  const main = join(fx(), 'late.js')
  writeFileSync(
    main,
    `const { spawn } = require('node:child_process')
setTimeout(() => {
  const c = spawn(${q(process.execPath)}, ['-e', 'setTimeout(() => {}, 500)'], { detached: true, stdio: 'ignore' })
  c.unref()
  require('node:fs').writeFileSync(${q(pidFile)}, String(c.pid))
}, 4000)
`,
  )
  const p = own(Bun.spawn([join(fx(), 'bun'), main], { stdout: 'ignore', stderr: 'ignore' }), true)
  expect(await p.exited).toBe(0)
  expect(gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
}, 30_000)

test('AC10 spawn error: before a child exists it resolves; after one exists it is not exit proof', async () => {
  fixtureTools()
  const pidFile = join(dir, 'err.pid')
  const main = join(fx(), 'err.js')
  writeFileSync(
    main,
    `const { spawn } = require('node:child_process')
spawn('/nonexistent/acme-tool', [], { stdio: 'ignore' }).on('error', () => {})
const c = spawn(${q(process.execPath)}, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
c.unref()
c.on('error', () => {})
c.emit('error', new Error('late'))
require('node:fs').writeFileSync(${q(pidFile)}, String(c.pid))
`,
  )
  const p = own(Bun.spawn([join(fx(), 'bun'), main], { stdout: 'ignore', stderr: 'ignore' }), true)
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')
  p.kill('SIGTERM')
  expect(await exitedWithin(p, 10_000)).toBe(true)
  expect(gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
}, 30_000)

test('AC10 control: a direct child is killed and awaited; an unrelated child gets no signal', async () => {
  const mine = own(Bun.spawn(['sleep', '60']))
  const other = Bun.spawn(['sleep', '60'])
  try {
    expect(await stopOwned()).toBe(true)
    expect(mine.exitCode === null && mine.signalCode === null).toBe(false)
    expect(gone(mine.pid)).toBe(true)
    expect(gone(other.pid)).toBe(false)
  } finally {
    other.kill(9)
    await other.exited
  }
}, 30_000)

test('AC10 control: a direct child that does not exit keeps the handle and denies proof', async () => {
  const fake = { kill: () => {}, exited: new Promise(() => {}) } as unknown as ReturnType<typeof Bun.spawn>
  own(fake)
  expect(await stopOwned(100)).toBe(false)
  expect(handles).toEqual([fake]) // kept: still unproven
  handles.length = 0
})

// ---- AC10 assertion cleanup: a nested `bun test` runs only the fixture test below, with this file's real afterEach ----
// The nested test starts its own child (a handle in its process) and fails an assertion on purpose. The outer test
// knows the nested pid, so it knows the nested fixture path and removes it itself.
const nestedRow = process.env.FACTORY_WIKI_NESTED
test.skipIf(!nestedRow)('AC10 nested fixture (started by the AC10 assertion cleanup test)', async () => {
  await setup(false)
  hookMs = 1_000
  const child = own(Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 15000)']))
  writeFileSync(process.env.FACTORY_WIKI_NESTED_OUT!, String(child.pid))
  if (nestedRow === 'denied') stuck.push('nested') // a scope without exit proof
  expect(1).toBe(2) // the intentional assertion error
})

async function nestedRun(row: 'clean' | 'denied') {
  const out = join(dir, `nested-${row}.pid`)
  mkdirSync(dir, { recursive: true })
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
        env: { ...process.env, FACTORY_WIKI_NESTED: row, FACTORY_WIKI_NESTED_OUT: out },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    ),
  )
  const exit = await p.exited
  return {
    exit,
    child: Number(readFileSync(out, 'utf8')),
    nestedDir: join(realpathSync(tmpdir()), `wiki-kick-${p.pid}`), // known to the outer test, not read from the nested run
  }
}

test('AC10 assertion cleanup: after a failed assertion the hook stops the child, then removes the fixture', async () => {
  const r = await nestedRun('clean')
  expect(r.exit).not.toBe(0)
  expect(gone(r.child)).toBe(true)
  expect(existsSync(r.nestedDir)).toBe(false)
}, 60_000)

test('AC10 assertion cleanup: without exit proof the hook fails and the fixture stays', async () => {
  const r = await nestedRun('denied')
  try {
    expect(r.exit).not.toBe(0)
    expect(existsSync(r.nestedDir)).toBe(true)
  } finally {
    rmSync(r.nestedDir, { recursive: true, force: true }) // the outer test removes it, by the path it knows
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
