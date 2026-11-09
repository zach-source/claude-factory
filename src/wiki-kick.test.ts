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

// Child ownership (AC10). The tick starts detached passes, so the test holds no handle for them. Every child of a
// factory() call carries TAG in its environment, and its own children inherit it: /proc names them whatever the
// lock or the home says. A direct Bun child is owned by handle. Cleanup stops all of them and proves exit.
const TAG = `wk-${process.pid}-${Date.now()}`
const handles: ReturnType<typeof Bun.spawn>[] = []
/** own a direct child: cleanup kills it and awaits child.exited */
function own<T extends ReturnType<typeof Bun.spawn>>(child: T): T {
  handles.push(child)
  return child
}
const readStat = (pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8')
/** a zombie that init has not reaped has exited; a failed /proc read is not proof of exit */
function alive(pid: number, stat: (pid: number) => string = readStat) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/^\d+ \([^)]*\) Z/.test(stat(pid))
  } catch {
    return true // kill(pid, 0) succeeded, so a failed /proc read is not proof of exit
  }
}
/** the live processes that carry TAG, in any home; never the test itself */
function tagged() {
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    const pid = Number(name)
    if (!pid || pid === process.pid) continue
    try {
      if (
        readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`FACTORY_WIKI_TEST_TAG=${TAG}\0`) &&
        alive(pid)
      )
        out.push(pid)
    } catch {
      // gone, or not ours to read
    }
  }
  return out
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** stop every owned child and wait for its exit; false when one is still alive at the deadline */
async function stopOwned(ms = 10_000) {
  for (const h of handles.splice(0)) {
    h.kill(9)
    await h.exited
  }
  for (const t = Date.now(); ; await sleep(50)) {
    const pids = tagged()
    if (!pids.length) return true
    if (Date.now() - t > ms) return false
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }
}
/** every owned child has exited (the passes end by themselves); a deadline stops them and throws */
async function settled(ms = 15_000) {
  for (const t = Date.now(); tagged().length; await sleep(100)) {
    if (Date.now() - t > ms) {
      if (!(await stopOwned())) throw new Error('an owned child did not exit: fixture kept')
      throw new Error('a pass did not end')
    }
  }
}
afterEach(async () => {
  try {
    await settled(5_000)
  } catch {
    // stopOwned already ran
  }
  // no exit proof: keep the fixture, so no child works on a deleted home
  if (!(await stopOwned())) throw new Error(`an owned child did not exit: fixture kept in ${dir}`)
  rmSync(dir, { recursive: true, force: true })
})

/** fixture gh, glab, claude and codex first on PATH: each records its call in forge-calls and fails */
const fx = () => join(dir, 'fx')
const forgeCalls = () => join(dir, 'forge-calls')
function fixtureTools() {
  mkdirSync(fx(), { recursive: true })
  for (const name of ['gh', 'glab', 'claude', 'codex']) {
    writeFileSync(join(fx(), name), `#!/bin/sh\necho "${name} $*" >> '${forgeCalls()}'\nexit 1\n`)
    chmodSync(join(fx(), name), 0o755)
  }
}
const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_NO_KICK, FACTORY_WIKI_REMOTE, ...laptop } =
    process.env
  fixtureTools()
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_WIKI_TEST_TAG: TAG,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_CLAUDE: join(fx(), 'claude'),
      ...env,
      PATH: `${fx()}:${env.PATH ?? laptop.PATH}`,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const stamp = () => join(home, 'wiki-refresh.stamp')
const groomStampPath = () => join(home, 'wiki-groom.stamp')

/** a new home with one rig; `repo` is a wiki repo with the seed pages when true */
function setup(withWiki = true, groomStamp = true) {
  home = join(dir, `home${++n}`)
  mkdirSync(home, { recursive: true })
  const repo = join(dir, `repo${n}`)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'acme', repo, factory: join(dir, 'f.ts') }]))
  if (withWiki) expect(factory(['wiki', 'init'], { FACTORY_NO_KICK: '1' }).code).toBe(0)
  // a fresh write stamp: the refresh tests must not race a write pass for wiki.lock
  writeFileSync(join(home, 'wiki-write.stamp'), '')
  if (groomStamp) writeFileSync(groomStampPath(), '')
}
/**
 * a detached pass has ended: wait for it to take wiki.lock, then for the lock to go, then for every owned child to
 * exit. The owned set does not depend on the lock. A deadline stops the owned children, awaits them and throws.
 */
async function passEnded(startMs = 10_000, endMs = 15_000) {
  const lock = join(home, 'wiki.lock')
  const pidFile = join(lock, 'pid')
  let pid = 0
  for (const t = Date.now(); !pid; await sleep(50)) {
    if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8')) || 0
    if (!pid && Date.now() - t > startMs) {
      if (!(await stopOwned())) throw new Error('an owned child did not exit: fixture kept')
      throw new Error('the pass never took wiki.lock')
    }
  }
  for (const t = Date.now(); existsSync(lock) || tagged().length || alive(pid); await sleep(100)) {
    if (Date.now() - t > endMs) {
      if (!(await stopOwned())) throw new Error('an owned child did not exit: fixture kept')
      throw new Error('the pass did not end')
    }
  }
}

test('AC7 a tick with a wiki repo and no stamp writes the stamp and the rig page', async () => {
  setup()
  factory(['tick'])
  await settled()
  expect(existsSync(stamp())).toBe(true)
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
}, 30_000)

test('AC7 a tick without wiki/.git makes no stamp and no wiki dir', async () => {
  setup(false)
  factory(['tick'])
  await settled()
  expect(existsSync(stamp())).toBe(false)
  expect(existsSync(join(home, 'wiki'))).toBe(false)
})

test('AC7 a halted factory still gets the refresh', async () => {
  setup()
  writeFileSync(
    join(home, 'halt.json'),
    JSON.stringify({ state: 'paused', at: Date.now(), told: {}, closed: {} }),
  )
  factory(['tick'])
  await settled()
  expect(existsSync(stamp())).toBe(true)
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
}, 30_000)

test('AC7 a fresh stamp starts no refresh', async () => {
  setup()
  writeFileSync(stamp(), '')
  const t = statSync(stamp()).mtimeMs
  factory(['tick'])
  await settled()
  expect(statSync(stamp()).mtimeMs).toBe(t)
  expect(existsSync(join(home, 'wiki', 'rigs'))).toBe(false)
})

test('AC7 FACTORY_WIKI_REFRESH_MIN=1 and a stamp 2 min old: the tick refreshes', async () => {
  setup()
  writeFileSync(stamp(), '')
  const old = new Date(Date.now() - 120_000)
  utimesSync(stamp(), old, old)
  factory(['tick'], { FACTORY_WIKI_REFRESH_MIN: '1' })
  await settled()
  expect(existsSync(join(home, 'wiki', 'rigs', 'acme.md'))).toBe(true)
  expect(statSync(stamp()).mtimeMs).toBeGreaterThan(old.getTime() + 60_000)
}, 30_000)

test('AC7 a held wiki.lock starts no refresh', async () => {
  setup()
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  factory(['tick'])
  await settled()
  expect(existsSync(stamp())).toBe(false)
})

test('AC7 a negative FACTORY_WIKI_REFRESH_MIN falls back to 30 min', async () => {
  setup()
  writeFileSync(stamp(), '')
  const t = statSync(stamp()).mtimeMs
  factory(['tick'], { FACTORY_WIKI_REFRESH_MIN: '-5' })
  await settled()
  expect(statSync(stamp()).mtimeMs).toBe(t)
})

// ---- the write kick (claude-factory-tx6c.7): every 180 min, never while halted ----
const wstamp = () => join(home, 'wiki-write.stamp')
/** a rig with .beads and a bd that waits 1 s and fails: a pass holds wiki.lock long enough for passEnded to see it */
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
  factory(['tick'], env)
  const moved = existsSync(wstamp()) && statSync(wstamp()).mtimeMs !== t
  if (moved) await passEnded()
  return moved
}

test('write AC6 kick matrix: age, wiki, lock, halt, NO_KICK', async () => {
  setup()
  rmSync(wstamp())
  expect(await launched()).toBe(true) // no stamp
  setup()
  aged(181)
  expect(await launched()).toBe(true)
  setup()
  aged(10)
  expect(await launched()).toBe(false)
  setup(false)
  aged(181)
  expect(await launched()).toBe(false)
  setup()
  aged(181)
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  expect(await launched()).toBe(false)
  for (const state of ['paused', 'stopping']) {
    setup()
    aged(181)
    writeFileSync(join(home, 'halt.json'), JSON.stringify({ state, at: Date.now(), told: {}, closed: {} }))
    expect(await launched()).toBe(false)
  }
  setup()
  aged(181)
  expect(await launched({ FACTORY_NO_KICK: '1' })).toBe(false)
}, 60_000)

test('write AC6 FACTORY_WIKI_WRITE_MIN: 1 moves a 2 min stamp; bad values keep 180', async () => {
  setup()
  aged(2)
  expect(await launched({ FACTORY_WIKI_WRITE_MIN: '1' })).toBe(true)
  for (const v of ['0', '-5', 'abc', 'Infinity']) {
    setup()
    aged(10)
    expect([v, await launched({ FACTORY_WIKI_WRITE_MIN: v })]).toEqual([v, false])
    aged(181)
    expect([v, await launched({ FACTORY_WIKI_WRITE_MIN: v })]).toEqual([v, true])
  }
}, 60_000)

test('write AC6 a launch whose pass fails at once is not repeated by the next two ticks', async () => {
  setup()
  rmSync(wstamp())
  // a rig with .beads and a bd that fails after 1 s: the pass ends in an error, and passEnded can see it
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
  setup()
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
  setup(true, false)
  writeFileSync(stamp(), '')
  const c = fakeClaude()
  factory(['tick'], c.env)
  await settled()
  expect(existsSync(groomStampPath())).toBe(true)
  expect(wikiLogText()).toContain('wiki groom: no remote, skipped')
  expect(existsSync(c.marker)).toBe(false)
}, 30_000)

test('AC10 a fresh groom stamp starts no groom pass', async () => {
  setup()
  writeFileSync(stamp(), '')
  const t = statSync(groomStampPath()).mtimeMs
  factory(['tick'])
  await settled()
  expect(statSync(groomStampPath()).mtimeMs).toBe(t)
})

test('AC10 FACTORY_WIKI_GROOM_MIN=1 and a groom stamp 2 min old: the tick grooms', async () => {
  setup()
  writeFileSync(stamp(), '')
  const old = new Date(Date.now() - 120_000)
  utimesSync(groomStampPath(), old, old)
  factory(['tick'], { FACTORY_WIKI_GROOM_MIN: '1' })
  await settled()
  expect(statSync(groomStampPath()).mtimeMs).toBeGreaterThan(old.getTime() + 60_000)
})

test('AC10 a halted factory gets no groom pass', async () => {
  setup(true, false)
  writeFileSync(stamp(), '')
  writeFileSync(
    join(home, 'halt.json'),
    JSON.stringify({ state: 'paused', at: Date.now(), told: {}, closed: {} }),
  )
  factory(['tick'])
  await settled()
  expect(existsSync(groomStampPath())).toBe(false)
})

test('AC10 one wiki pass in each tick: no stamps at all gives the refresh stamp only', async () => {
  setup(true, false)
  factory(['tick'])
  await settled()
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
    setup()
    slowPass()
    factory(['tick'])
    await passEnded() // the detached children end before the checks and the cleanup
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

test('AC10 control: a child that starts after 3 s is waited for; assertions follow its exit', async () => {
  setup()
  const lock = join(home, 'wiki.lock')
  const child = own(
    Bun.spawn(['sh', '-c', `sleep 3; mkdir '${lock}'; echo $$ > '${lock}/pid'; sleep 1; rm -r '${lock}'`]),
  )
  await passEnded()
  expect(alive(child.pid)).toBe(false)
  await child.exited
}, 30_000)

test('AC10 control: a child that starts after the start deadline is stopped and awaited', async () => {
  setup()
  const lock = join(home, 'wiki.lock')
  const marker = join(dir, 'late-ran')
  const child = own(
    Bun.spawn(['sh', '-c', `sleep 1; touch '${marker}'; mkdir '${lock}'; echo $$ > '${lock}/pid'; sleep 60`]),
  )
  await expect(passEnded(300, 300)).rejects.toThrow('never took')
  expect(await child.exited).not.toBe(0) // killed: it cannot use the fixture later
  expect(alive(child.pid)).toBe(false)
  await sleep(1200)
  expect(existsSync(marker)).toBe(false)
}, 30_000)

test('AC10 control: a child that never completes with its lock present is stopped and awaited', async () => {
  setup()
  const lock = join(home, 'wiki.lock')
  const child = own(Bun.spawn(['sleep', '60']))
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'pid'), String(child.pid))
  await expect(passEnded(300, 300)).rejects.toThrow('did not end')
  expect(alive(child.pid)).toBe(false)
  await child.exited
}, 30_000)

test('AC10 control: a child that removes its lock but stays alive is stopped by identity', async () => {
  setup()
  const lock = join(home, 'wiki.lock')
  const child = own(
    Bun.spawn(['sh', '-c', `mkdir '${lock}'; echo $$ > '${lock}/pid'; sleep 1; rm -r '${lock}'; sleep 60`]),
  )
  await expect(passEnded(5_000, 4_000)).rejects.toThrow('did not end')
  expect(existsSync(lock)).toBe(false)
  expect(alive(child.pid)).toBe(false)
  await child.exited
}, 30_000)

test('AC10 control: a tagged child that no handle and no lock names is found and stopped', async () => {
  setup()
  const p = Bun.spawn(['sh', '-c', 'sleep 60 & wait'], {
    env: { ...process.env, FACTORY_WIKI_TEST_TAG: TAG },
  })
  own(p)
  await sleep(300)
  expect(tagged().length).toBeGreaterThan(1) // the shell and its sleep
  expect(await stopOwned()).toBe(true)
  expect(tagged()).toEqual([])
  await p.exited
}, 30_000)

test('AC10 control: children of two homes in one test are all accounted for', async () => {
  const kids = []
  for (let i = 0; i < 2; i++) {
    setup()
    kids.push(own(Bun.spawn(['sleep', '60'], { env: { ...process.env, FACTORY_WIKI_TEST_TAG: TAG } })))
  }
  await sleep(300)
  expect(tagged().sort()).toEqual(kids.map(k => k.pid).sort())
  expect(await stopOwned()).toBe(true)
  for (const k of kids) expect(alive(k.pid)).toBe(false)
}, 30_000)

test('AC10 control: a live pid with an unreadable /proc record counts as alive', () => {
  expect(
    alive(process.pid, () => {
      throw new Error('EACCES')
    }),
  ).toBe(true)
  expect(alive(process.pid, () => `${process.pid} (sh) Z 1`)).toBe(false)
})

test('AC10 control: a policy row that launches nothing starts no wiki pass and calls no forge', async () => {
  setup()
  aged(10)
  expect(await launched()).toBe(false)
  await settled() // the tick starts other passes (sweeps); none of them is a wiki pass
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
