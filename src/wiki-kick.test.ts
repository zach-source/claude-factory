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

// Child ownership (AC10). A launch is owned when it is registered before it can outlive its caller. Two ways:
// the `bun` shim in fx() writes a receipt when it starts (bin/factory ends in `exec bun`, so the shim covers the
// tick and every detached pass it starts); register() writes the same receipt for a child the test starts itself.
// A receipt is a file named <pid> that holds the start identity of that pid, then `;` and the sanitized arguments. A direct Bun child is also owned by
// handle. Only a receipt or a handle authorises a signal, and only while the start identity still matches. No host
// scan finds a child: a process without a receipt is not ours. A descendant that no shim or register() call
// names (for example the `sleep` in a fixture shell script) is not owned.
const handles: ReturnType<typeof Bun.spawn>[] = []
/** own a direct child: cleanup kills it and awaits child.exited */
function own<T extends ReturnType<typeof Bun.spawn>>(child: T): T {
  handles.push(child)
  return child
}
const receipts = () => join(dir, 'receipts')
const readStat = (pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8')
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code
/** only ESRCH proves the pid is gone; EPERM and any other error mean a live pid. A zombie has exited. */
function alive(pid: number, stat: (pid: number) => string = readStat) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return errCode(e) !== 'ESRCH'
  }
  try {
    return !/^\d+ \([^)]*\) Z/.test(stat(pid))
  } catch {
    return true // a failed /proc read is not proof of exit
  }
}
/** the start identity of a pid; undefined when the host cannot say, which is never proof of anything */
type Identity = (pid: number) => string | undefined
/** Linux: field 22 of /proc/<pid>/stat, the start time. The shim writes the same value. */
const procIdentity: Identity = pid => {
  try {
    const s = readStat(pid)
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}
/** macOS: `ps -o lstart=` with blanks as underscores. A failed ps gives no identity. */
const psIdentity =
  (
    run: (pid: number) => { exitCode: number; stdout: { toString(): string } } = pid =>
      Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)]),
  ): Identity =>
  pid => {
    const r = run(pid)
    return r.exitCode === 0 ? r.stdout.toString().trim().replace(/\s+/g, '_') || undefined : undefined
  }
const procOk = existsSync('/proc/self/stat')
const hostIdentity = (): Identity => (procOk ? procIdentity : psIdentity())
let identityOf: Identity = hostIdentity()
/** record a launch the test started itself, with the same receipt the shim writes */
function register(pid: number) {
  mkdirSync(receipts(), { recursive: true })
  writeFileSync(join(receipts(), String(pid)), identityOf(pid) ?? '')
}
/** every receipt ever seen, with its identity: an entry stays until exit is proved. Key: pid/identity. */
const owned = new Map<string, { pid: number; id: string; args: string }>()
/** read the receipts; a malformed name or content throws before any signal or removal */
function scanReceipts() {
  if (!existsSync(receipts())) return
  for (const f of readdirSync(receipts())) {
    if (f.startsWith('.')) continue // a receipt that is being written
    if (!/^\d+$/.test(f)) throw new Error(`bad receipt name: ${f}`)
    const body = readFileSync(join(receipts(), f), 'utf8').trim()
    if (!/^[\w.:-]*(;[\w.:-]*)?$/.test(body)) throw new Error(`bad receipt content for ${f}`)
    const [id = '', args = ''] = body.split(';')
    owned.delete(`${f}/`) // an identity that arrived late replaces the empty entry
    owned.set(`${f}/${id}`, { pid: Number(f), id, args })
  }
}
/**
 * live owned pids. `mine`: live with the recorded identity, so they can be signalled. `unproven`: live, but the
 * recorded or the current identity is unavailable, so they cannot be signalled and do not count as exited. A pid
 * with another identity is a reused pid: it is not ours, and it gets no signal.
 */
function status() {
  scanReceipts()
  const s = { mine: [] as number[], unproven: [] as number[] }
  for (const { pid, id } of owned.values()) {
    if (!alive(pid)) continue
    const now = identityOf(pid)
    if (!id || !now) s.unproven.push(pid)
    else if (now === id) s.mine.push(pid)
  }
  return s
}
const pending = () => {
  const s = status()
  return [...s.mine, ...s.unproven]
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// the nested row (AC10 assertion cleanup) shortens the hook waits; a normal run keeps these
let hookMs = 10_000
let settleMs = 5_000
/** stop every owned child and wait for its exit; false when one is still alive or unproven at the deadline */
async function stopOwned(ms = hookMs) {
  for (const h of handles.splice(0)) {
    h.kill(9)
    await h.exited
  }
  for (const t = Date.now(); ; await sleep(50)) {
    const s = status()
    if (!s.mine.length && !s.unproven.length) return true
    if (Date.now() - t > ms) return false
    for (const pid of s.mine) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }
}
/** passes a tick launched (its stamp moved) whose own receipt has not been seen yet */
let awaiting: { pass: string; old: Set<string> }[] = []
/**
 * A tick returns before its detached pass has run the shim. The stamp is written before the spawn, so a moved
 * stamp proves a launch. Wait for that pass's receipt (args end in wiki_<pass>); if it never comes, stop the
 * owned children and throw.
 */
async function launchSeen(ms = 10_000) {
  for (const t = Date.now(); awaiting.length; await sleep(20)) {
    scanReceipts()
    awaiting = awaiting.filter(
      w => ![...owned].some(([key, o]) => !w.old.has(key) && o.args.endsWith(`_wiki_${w.pass}`)),
    )
    if (awaiting.length && Date.now() - t > ms) {
      const left = awaiting.splice(0)
      if (!(await stopOwned())) throw new Error('an owned child did not exit: fixture kept')
      throw new Error(`a launched pass never registered: ${left.map(w => w.pass)}`)
    }
  }
}
/** every owned child has exited (the passes end by themselves); a deadline stops them and throws */
async function settled(ms = 15_000) {
  await launchSeen()
  for (const t = Date.now(); pending().length; await sleep(100)) {
    if (Date.now() - t > ms) {
      if (!(await stopOwned())) throw new Error('an owned child did not exit: fixture kept')
      throw new Error('a pass did not end')
    }
  }
}
afterEach(async () => {
  try {
    await settled(settleMs)
  } catch {
    // stopOwned already ran
  }
  // no exit proof: keep the fixture, so no child works on a deleted home
  if (!(await stopOwned())) throw new Error(`an owned child did not exit: fixture kept in ${dir}`)
  rmSync(dir, { recursive: true, force: true })
})

/** fixture gh, glab, claude and codex first on PATH: each records its call in forge-calls and fails. The bun shim registers each launch. */
const fx = () => join(dir, 'fx')
const forgeCalls = () => join(dir, 'forge-calls')
function fixtureTools() {
  mkdirSync(fx(), { recursive: true })
  for (const name of ['gh', 'glab', 'claude', 'codex']) {
    writeFileSync(join(fx(), name), `#!/bin/sh\necho "${name} $*" >> '${forgeCalls()}'\nexit 1\n`)
    chmodSync(join(fx(), name), 0o755)
  }
  const shim = join(fx(), 'bun')
  writeFileSync(
    shim,
    `#!/bin/sh
d="$FACTORY_WIKI_TEST_RECEIPTS"
if [ -n "$d" ]; then
  s=$(cut -d' ' -f22 /proc/$$/stat 2>/dev/null) || s=
  [ -n "$s" ] || s=$(ps -o lstart= -p $$ 2>/dev/null | tr ' ' '_')
  a=$(printf %s "$*" | tr -c 'A-Za-z0-9._-' '_')
  echo "$s;$a" > "$d/.$$" && mv "$d/.$$" "$d/$$"
fi
exec '${process.execPath}' "$@"
`,
  )
  chmodSync(shim, 0o755)
}
const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_NO_KICK, FACTORY_WIKI_REMOTE, ...laptop } =
    process.env
  fixtureTools()
  mkdirSync(receipts(), { recursive: true })
  const stampOf = (pass: string) => {
    try {
      return statSync(join(home, `wiki-${pass}.stamp`)).mtimeMs
    } catch {
      return 0
    }
  }
  scanReceipts()
  const old = new Set(owned.keys())
  const before = ['refresh', 'groom', 'write'].map(pass => [pass, stampOf(pass)] as const)
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_WIKI_TEST_RECEIPTS: receipts(),
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_CLAUDE: join(fx(), 'claude'),
      ...env,
      PATH: `${fx()}:${env.PATH ?? laptop.PATH}`,
    },
  })
  if (args[0] === 'tick')
    for (const [pass, t] of before) if (stampOf(pass) !== t) awaiting.push({ pass, old })
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
  await launchSeen()
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
  for (const t = Date.now(); existsSync(lock) || pending().length || alive(pid); await sleep(100)) {
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

test('AC10 control: a registered child that no handle and no lock names is found and stopped', async () => {
  setup()
  const p = Bun.spawn(['sleep', '60'])
  register(p.pid)
  expect(pending()).toEqual([p.pid])
  expect(await stopOwned()).toBe(true)
  expect(alive(p.pid)).toBe(false)
  await p.exited
}, 30_000)

test('AC10 control: a child with no receipt is not ours: no signal, no wait', async () => {
  const p = Bun.spawn(['sleep', '60'])
  try {
    expect(pending()).toEqual([])
    expect(await stopOwned(300)).toBe(true)
    expect(alive(p.pid)).toBe(true)
  } finally {
    p.kill(9)
    await p.exited
  }
}, 30_000)

test('AC10 control: children of two homes in one test are all accounted for', async () => {
  const kids = []
  for (let i = 0; i < 2; i++) {
    setup()
    const k = Bun.spawn(['sleep', '60'])
    register(k.pid)
    kids.push(k)
  }
  expect(pending().sort()).toEqual(kids.map(k => k.pid).sort())
  expect(await stopOwned()).toBe(true)
  for (const k of kids) {
    expect(alive(k.pid)).toBe(false)
    await k.exited
  }
}, 30_000)

test('AC10 control: the bun shim registers every tick launch with its start identity', () => {
  setup()
  const files = readdirSync(receipts()).filter(f => !f.startsWith('.'))
  expect(files.length).toBeGreaterThan(0) // factory wiki init ran through the shim
  for (const f of files) {
    expect(f).toMatch(/^\d+$/)
    const id = readFileSync(join(receipts(), f), 'utf8').split(';')[0]
    if (procOk) expect(id).toMatch(/^\d+$/)
  }
})

test('AC10 control: an identity read that fails after a sighting keeps the child owned, unsignalled', async () => {
  const p = Bun.spawn(['sleep', '60'])
  register(p.pid)
  expect(status().mine).toEqual([p.pid])
  identityOf = () => undefined
  try {
    expect(status()).toEqual({ mine: [], unproven: [p.pid] })
    expect(await stopOwned(300)).toBe(false) // no identity: no signal and no exit proof
    expect(alive(p.pid)).toBe(true)
  } finally {
    identityOf = hostIdentity()
  }
  expect(await stopOwned()).toBe(true)
  expect(alive(p.pid)).toBe(false)
  await p.exited
}, 30_000)

test('AC10 control: a receipt without an identity blocks cleanup and keeps the fixture', async () => {
  setup(false)
  const child = Bun.spawn(['sleep', '60'])
  try {
    mkdirSync(receipts(), { recursive: true })
    writeFileSync(join(receipts(), String(child.pid)), ';') // the identity never arrived
    expect(await stopOwned(500)).toBe(false) // a live child is not a successful cleanup
    expect(alive(child.pid)).toBe(true) // and it got no signal
    await expect(settled(300)).rejects.toThrow('fixture kept')
    expect(alive(child.pid)).toBe(true)
    expect(existsSync(dir)).toBe(true)
  } finally {
    child.kill(9)
    await child.exited
  }
  expect(await stopOwned()).toBe(true) // exit is proved: the pid is gone
}, 30_000)

test('AC10 control: a reused pid (another identity) gets no signal and is not waited for', async () => {
  const p = Bun.spawn(['sleep', '60'])
  try {
    mkdirSync(receipts(), { recursive: true })
    writeFileSync(join(receipts(), String(p.pid)), '1') // not the identity of this process
    expect(status()).toEqual({ mine: [], unproven: [] })
    expect(await stopOwned(300)).toBe(true)
    expect(alive(p.pid)).toBe(true)
  } finally {
    p.kill(9)
    await p.exited
  }
}, 30_000)

test('AC10 control: a malformed receipt throws before any signal', async () => {
  const p = Bun.spawn(['sleep', '60'])
  try {
    register(p.pid)
    const rows: [string, string][] = [
      ['abc', ''],
      [String(p.pid + 1), 'x y'],
    ]
    for (const [name, body] of rows) {
      writeFileSync(join(receipts(), name), body)
      expect(() => status()).toThrow('bad receipt')
      rmSync(join(receipts(), name))
    }
    expect(alive(p.pid)).toBe(true)
  } finally {
    p.kill(9)
    await p.exited
  }
}, 30_000)

test('AC10 supported hosts: the ps identity gives the same exit contract without /proc', async () => {
  const child = Bun.spawn(['sleep', '60'])
  const out =
    (s: string, exitCode = 0) =>
    () => ({ exitCode, stdout: s })
  try {
    expect(psIdentity(out(' Mon Nov  9 10:00:00 2026\n'))(child.pid)).toBe('Mon_Nov_9_10:00:00_2026')
    expect(psIdentity(out('', 1))(child.pid)).toBeUndefined() // a failed ps gives no identity
    expect(psIdentity(out('  \n'))(child.pid)).toBeUndefined()
    identityOf = psIdentity(out('Mon Nov  9 10:00:00 2026'))
    register(child.pid)
    expect(status().mine).toEqual([child.pid])
    identityOf = psIdentity(out('', 1)) // ps fails later: unproven, no signal
    expect(await stopOwned(300)).toBe(false)
    expect(alive(child.pid)).toBe(true)
    identityOf = psIdentity(out('Tue Nov 10 10:00:00 2026')) // another start time: a reused pid
    expect(status()).toEqual({ mine: [], unproven: [] })
    expect(alive(child.pid)).toBe(true)
    identityOf = psIdentity(out('Mon Nov  9 10:00:00 2026'))
    expect(await stopOwned()).toBe(true)
    expect(alive(child.pid)).toBe(false)
  } finally {
    identityOf = hostIdentity()
    child.kill(9)
    await child.exited
  }
}, 30_000)

// ---- AC10 assertion cleanup: a nested `bun test` runs only the fixture test below, with this file's real afterEach ----
const nestedRow = process.env.FACTORY_WIKI_NESTED
test.skipIf(!nestedRow)('AC10 nested fixture (started by the AC10 assertion cleanup test)', async () => {
  setup(false)
  hookMs = settleMs = 300
  const child = Bun.spawn(['sleep', '60'])
  register(child.pid)
  if (nestedRow === 'clean') own(child)
  else identityOf = () => undefined // no exit proof is possible for this receipt
  await sleep(200)
  writeFileSync(process.env.FACTORY_WIKI_NESTED_OUT!, JSON.stringify({ pid: child.pid, dir }))
  expect(1).toBe(2) // the intentional assertion error
})

async function nestedRun(row: 'clean' | 'denied') {
  const out = join(dir, `nested-${row}.json`)
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
  return { exit, ...(JSON.parse(readFileSync(out, 'utf8')) as { pid: number; dir: string }) }
}

test('AC10 assertion cleanup: after a failed assertion the hook stops the child, then removes the fixture', async () => {
  const r = await nestedRun('clean')
  expect(r.exit).not.toBe(0)
  expect(alive(r.pid)).toBe(false)
  expect(existsSync(r.dir)).toBe(false)
}, 60_000)

test('AC10 assertion cleanup: without exit proof the hook fails and the fixture stays', async () => {
  let r: { exit: number; pid: number; dir: string } | undefined
  try {
    r = await nestedRun('denied')
    expect(r.exit).not.toBe(0)
    expect(alive(r.pid)).toBe(true) // the hook could not prove exit, and it did not signal the pid
    expect(existsSync(r.dir)).toBe(true)
  } finally {
    if (r) {
      process.kill(r.pid, 'SIGKILL')
      for (let i = 0; i < 100 && alive(r.pid); i++) await sleep(50)
      expect(alive(r.pid)).toBe(false)
      rmSync(r.dir, { recursive: true, force: true })
    }
  }
}, 60_000)

test('AC10 control: a live pid with an unreadable /proc record counts as alive', () => {
  expect(
    alive(process.pid, () => {
      throw new Error('EACCES')
    }),
  ).toBe(true)
  expect(alive(process.pid, () => `${process.pid} (sh) Z 1`)).toBe(false)
  expect(alive(2 ** 22 + 12345)).toBe(false) // ESRCH: gone
  expect(alive(1, () => '1 (init) S 0')).toBe(true) // EPERM for another user's pid: alive, not gone
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
