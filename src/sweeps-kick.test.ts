// This tests `factory tick` spawning `factory sweep` (claude-factory-8pc.4).
//
// kickSweeps (src/cli.ts) is the only caller of a sweep pass from tick. tick() must spawn it at
// most once every FACTORY_SWEEP_MS (default 300000ms). It must never spawn it twice inside the
// same window. It must never spawn it at all when FACTORY_SWEEPS=0, or while the factory is
// halted. These tests follow src/gc-kick.test.ts's kickGcWorktrees pattern: they drive `factory
// tick` itself, not `factory sweep` directly.
//
// No rig is configured here: `sweep()` then loops over zero rigs and writes no sweeps.jsonl line,
// but it still must run to completion and refresh sweeps.stamp, the same way a direct `factory gc`
// run refreshes gc.stamp (src/cli.ts's case 'gc') and `factory gc --worktrees` refreshes
// gc-worktrees.stamp (case 'gc' with --worktrees). A doneRun() fixture is still required: tick's
// finally block only kicks anything when a run or a rig exists.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `sweeps-kick-${process.pid}`)
const home = join(dir, 'home')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_GC_WORKTREES: '0',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

/** a done run: tick's finally block only kicks anything when a run or a rig exists. Its own files
 * are irrelevant here (no gc pass runs in this file: both gc kicks are off above). */
function doneRun(id: string): string {
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: factoryFile, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 's', at: Date.now() })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
  return d
}

const reset = () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
}

/** backdates sweeps.stamp past `ms`, as if an earlier tick had seeded it */
const backdateStamp = (ms: number) => {
  const f = join(home, 'sweeps.stamp')
  writeFileSync(f, '')
  const old = new Date(Date.now() - ms)
  utimesSync(f, old, old)
}

async function waitForStampChange(before: number, tries = 300): Promise<void> {
  const file = join(home, 'sweeps.stamp')
  for (let i = 0; i < tries; i++) {
    if (existsSync(file) && statSync(file).mtimeMs !== before) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitForStampChange: sweeps.stamp was never refreshed')
}

test('the first tick ever only seeds sweeps.stamp, spawning no pass (claude-factory-8pc.4)', async () => {
  reset()
  doneRun('r1')
  expect(existsSync(join(home, 'sweeps.stamp'))).toBe(false)
  factory(['tick'])
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(existsSync(join(home, 'sweeps.stamp'))).toBe(true)
  expect(existsSync(join(home, 'sweeps.jsonl'))).toBe(false) // seeded only: no pass ran
})

test('tick spawns one sweep pass once the stamp is old enough, refreshing it, then spawns none inside that window', async () => {
  reset()
  doneRun('r1')
  backdateStamp(6000)
  const before = statSync(join(home, 'sweeps.stamp')).mtimeMs
  factory(['tick'], { FACTORY_SWEEP_MS: '5000' })
  await waitForStampChange(before) // proves the spawned pass ran to completion and refreshed the stamp
  const firstMtime = statSync(join(home, 'sweeps.stamp')).mtimeMs
  factory(['tick'], { FACTORY_SWEEP_MS: '5000' }) // immediately after: well inside the same 5s window
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(statSync(join(home, 'sweeps.stamp')).mtimeMs).toBe(firstMtime) // untouched: no second pass spawned
})

test('tick spawns no sweep pass while another one still holds sweeps.lock', async () => {
  reset()
  doneRun('r1')
  backdateStamp(1000)
  const before = statSync(join(home, 'sweeps.stamp')).mtimeMs
  mkdirSync(join(home, 'sweeps.lock'))
  writeFileSync(join(home, 'sweeps.lock', 'pid'), String(process.pid)) // this test process: alive
  factory(['tick'], { FACTORY_SWEEP_MS: '100' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(statSync(join(home, 'sweeps.stamp')).mtimeMs).toBe(before) // the lock held: no pass ran
})

test('FACTORY_SWEEPS=0 turns it off entirely: tick never even seeds the stamp', async () => {
  reset()
  doneRun('r1')
  factory(['tick'], { FACTORY_SWEEPS: '0' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(existsSync(join(home, 'sweeps.stamp'))).toBe(false)
  expect(existsSync(join(home, 'sweeps.jsonl'))).toBe(false)
})
