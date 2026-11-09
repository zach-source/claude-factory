// Tests for `factory tick` spawning `factory gc` (claude-factory-503.1.4).
//
// kickGc (src/cli.ts) is the only caller of a gc pass. tick() must spawn it at most once an hour
// (FACTORY_GC_MS). It must never spawn it twice inside the same window. It must never spawn it at
// all when FACTORY_GC=0.
//
// These tests drive `factory tick` itself, not `factory gc`. kickGc is tick's own gate before it
// spawns that process. The cadence tests follow src/watch.test.ts's kickWatch tests
// (claude-factory-960.7).
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `gc-kick-${process.pid}`)
// A new home per test: detached tick children of an earlier test write into its old home, not the next one.
let homeN = 0
let home = join(dir, 'home')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}
const DAY = 24 * 3_600_000

/** a done run, 10 days old, with a clean git worktree. A gc pass reaps the whole run dir.
 * The missing run dir is the test's proof that a spawned gc pass ran to completion. */
function doneRun(id: string): string {
  const repo = join(dir, 'repo')
  const g = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'f',
        GIT_AUTHOR_EMAIL: 'f@localhost',
        GIT_COMMITTER_NAME: 'f',
        GIT_COMMITTER_EMAIL: 'f@localhost',
      },
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  }
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true })
    g('init', '-q', '-b', 'main')
    g('commit', '-q', '--allow-empty', '-m', 'root')
  }
  const wt = join(home, 'worktrees', id)
  g('worktree', 'add', '-q', '-b', `factory/${id}`, wt)
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo,
      goal: 'g',
      ws: 'w1',
      worktree: wt,
      branch: `factory/${id}`,
    }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 's', at: Date.now() - 10 * DAY })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  mkdirSync(join(d, 'prompts'), { recursive: true })
  writeFileSync(join(d, 'prompts', `${seq}-implement.md`), 'the brief')
  writeFileSync(join(d, 'inbox.jsonl'), '')
  return d
}

const reset = () => {
  rmSync(dir, { recursive: true, force: true })
  home = join(dir, `home-${++homeN}`)
  mkdirSync(home, { recursive: true })
}

/** a spawned gc pass writes gc.stamp once it takes gc.lock (gcPass, src/cli.ts); this waits for
 * one to land, polling rather than a flat sleep (a flat 150ms wait was seen flaky before) */
async function waitForGcStamp(tries = 300): Promise<void> {
  const file = join(home, 'gc.stamp')
  for (let i = 0; i < tries; i++) {
    if (existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitForGcStamp: no gc pass landed in time')
}

test('tick spawns one gc pass, then none while still inside that pass’s hour (claude-factory-503.1.4)', async () => {
  reset()
  const d = doneRun('r1')
  expect(existsSync(join(home, 'gc.stamp'))).toBe(false)
  factory(['tick'])
  await waitForGcStamp()
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(d)).toBe(false) // the spawned pass actually ran, not just stamped
  expect(existsSync(join(home, 'metrics.jsonl'))).toBe(true)
  const firstMtime = statSync(join(home, 'gc.stamp')).mtimeMs
  factory(['tick']) // immediately after: well inside the same hour, so this must spawn nothing
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(statSync(join(home, 'gc.stamp')).mtimeMs).toBe(firstMtime) // untouched since the first pass
})

test('tick spawns no gc pass while another one still holds gc.lock (claude-factory-503.1.4)', async () => {
  reset()
  const d = doneRun('r1')
  mkdirSync(join(home, 'gc.lock'))
  writeFileSync(join(home, 'gc.lock', 'pid'), String(process.pid)) // this test process: alive
  factory(['tick'])
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(join(home, 'gc.stamp'))).toBe(false)
  expect(existsSync(d)).toBe(true) // the lock held: no pass ran
})

test('FACTORY_GC=0: tick spawns no gc pass at all (claude-factory-503.1.4)', async () => {
  reset()
  const d = doneRun('r1')
  factory(['tick'], { FACTORY_GC: '0' })
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(join(home, 'gc.stamp'))).toBe(false)
  expect(existsSync(d)).toBe(true)
})

test('a direct "factory gc" run (not through tick) still writes gc.stamp and prunes (sanity check)', () => {
  reset()
  const d = doneRun('r1')
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  expect(existsSync(join(home, 'gc.stamp'))).toBe(true)
  expect(existsSync(d)).toBe(false)
})

// Tests for `factory tick` spawning `factory gc --worktrees` (claude-factory-l38.4).
//
// kickGcWorktrees (src/cli.ts) is the only caller. Its lock is gc-worktrees.lock. Its stamp is
// gc-worktrees.stamp. Both are separate from the plain gc pass's gc.lock and gc.stamp above.
//
// Every test here sets FACTORY_GC: '0'. This stops the plain gc pass from also spawning and
// racing these fixtures.

/** a spawned worktree gc pass always appends a 'pass' line to gc-worktrees.jsonl (gcWorktreesPass,
 * src/cli.ts), even with no rigs configured; this waits for one to land, as waitForGcStamp does */
async function waitForGcWorktreesJournal(tries = 300): Promise<void> {
  const file = join(home, 'gc-worktrees.jsonl')
  for (let i = 0; i < tries; i++) {
    if (existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitForGcWorktreesJournal: no worktree gc pass landed in time')
}
/** backdates gc-worktrees.stamp past GC_WORKTREES_MS (a day), as if an earlier tick had seeded it */
const backdateWorktreesStamp = () => {
  const f = join(home, 'gc-worktrees.stamp')
  writeFileSync(f, '')
  const old = new Date(Date.now() - 25 * 3_600_000)
  utimesSync(f, old, old)
}

test('the first tick ever only seeds gc-worktrees.stamp, spawning no pass (claude-factory-l38.4, AC8)', async () => {
  reset()
  doneRun('r1') // tick's finally block only kicks once a run or a rig exists
  expect(existsSync(join(home, 'gc-worktrees.stamp'))).toBe(false)
  factory(['tick'], { FACTORY_GC: '0' })
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(join(home, 'gc-worktrees.stamp'))).toBe(true)
  expect(existsSync(join(home, 'gc-worktrees.jsonl'))).toBe(false) // seeded only: no pass ran
})

test('tick spawns one worktree gc pass once the stamp is a day old, then none inside that window (claude-factory-l38.4, AC8)', async () => {
  reset()
  doneRun('r1')
  backdateWorktreesStamp()
  factory(['tick'], { FACTORY_GC: '0' })
  await waitForGcWorktreesJournal()
  await new Promise(resolve => setTimeout(resolve, 1200))
  const firstMtime = statSync(join(home, 'gc-worktrees.stamp')).mtimeMs
  factory(['tick'], { FACTORY_GC: '0' }) // immediately after: well inside the same day, so this spawns nothing
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(statSync(join(home, 'gc-worktrees.stamp')).mtimeMs).toBe(firstMtime) // untouched since the first pass
})

test('tick spawns no worktree gc pass while another one still holds gc-worktrees.lock (claude-factory-l38.4, AC8)', async () => {
  reset()
  doneRun('r1')
  backdateWorktreesStamp()
  mkdirSync(join(home, 'gc-worktrees.lock'))
  writeFileSync(join(home, 'gc-worktrees.lock', 'pid'), String(process.pid)) // this test process: alive
  factory(['tick'], { FACTORY_GC: '0' })
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(join(home, 'gc-worktrees.jsonl'))).toBe(false)
})

test('FACTORY_GC_WORKTREES=0: tick spawns no worktree gc pass and never even seeds the stamp (claude-factory-l38.4, AC8)', async () => {
  reset()
  doneRun('r1')
  factory(['tick'], { FACTORY_GC: '0', FACTORY_GC_WORKTREES: '0' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(existsSync(join(home, 'gc-worktrees.stamp'))).toBe(false)
  expect(existsSync(join(home, 'gc-worktrees.jsonl'))).toBe(false)
})
