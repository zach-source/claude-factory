// claude-factory-e1vu: a token swap ends the usage-limit holds of its runner, capped by the free slots.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { pickUnholds, runTokenSwap, trustedUnhold } from './cli'
import { compile, type Ev, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `unhold-${process.pid}`)
const home = join(dir, 'home')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    FACTORY_RUN,
    FACTORY_PATROL,
    BEADS_ACTOR,
    FACTORY_DEF_NAME,
    ...laptop
  } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_NO_KICK: '1',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const def = (runner: string): Factory => ({
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', runner, next: { ready: 'done' } } },
})

const LIMIT = 'Claude usage limit (seven_day) until 2026-11-08T01:00:00Z'
let n = 0
/** a run held at implement by `reason` at time `at` */
function held(runner: string, reason = LIMIT, at = 100, extra: Ev[] = []) {
  const id = `ship-${Date.now().toString(36)}x${n++}`
  const d = join(home, 'runs', id)
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  const f = def(runner)
  writeFileSync(file, `export default ${JSON.stringify(f)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: file, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(f)).start()
  actor.send({ type: 'TICK', at: 0 })
  actor.send({ type: 'SPAWNED', seq: 1, pane: 'w1:p1', at: 1 })
  actor.send({ type: 'FAIL', seq: 1, reason, hold: Date.now() + 9e8, at } as Ev)
  for (const e of extra) actor.send(e)
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
  return { id, wakes: () => wakeLines(d) }
}
const wakeLines = (d: string) =>
  readFileSync(join(d, 'inbox.jsonl'), 'utf8')
    .split('\n')
    .filter(l => l.includes('"wake":true'))
const mark = (name: string, m: object) => {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, name), JSON.stringify(m))
}
const wakesOf = (r: { id: string }) => wakeLines(join(home, 'runs', r.id))

test('AC1/AC4: a mark wakes the held stations of its runner only', () => {
  const a = held('ax')
  const h = held('herdr')
  const egress = held('ax', 'egress gateway: model API unreachable')
  const codex = held('ax', 'Codex usage limit (seven_day) until 2026-11-08T01:00:00Z')
  const fresh = held('ax', LIMIT, Date.now() + 60_000) // a limit hit after the swap
  mark('unhold-ax.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  const tick = factory(['tick'])
  expect(tick.code).toBe(0)
  expect(wakesOf(a)).toHaveLength(1)
  expect(wakesOf(a)[0]).toContain('"from":"factory"')
  for (const r of [h, egress, codex, fresh]) expect(wakesOf(r)).toHaveLength(0)
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(false) // no candidate left
  expect(tick.out).toContain('Woke 1 stations')
})

test('AC1: before from, nothing wakes', () => {
  const a = held('ax')
  mark('unhold-ax.json', { before: Date.now() + 1000, from: Date.now() + 200_000, woke: 0 })
  factory(['tick'])
  expect(wakesOf(a)).toHaveLength(0)
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(true)
})

test('AC4: a Codex mark wakes Codex holds only', () => {
  const c = held('ax', 'Codex usage limit (seven_day) until 2026-11-08T01:00:00Z')
  const cl = held('ax')
  mark('unhold-ax-codex.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  factory(['tick'])
  expect(wakesOf(c)).toHaveLength(1)
  expect(wakesOf(cl)).toHaveLength(0)
})

test('AC4: a malformed mark wakes nothing and is deleted', () => {
  const a = held('ax')
  mark('unhold-ax.json', { before: 'x', from: 0, woke: 0 })
  factory(['tick'])
  expect(wakesOf(a)).toHaveLength(0)
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(false)
})

test('AC2/AC5: FACTORY_MAX_RUNS caps the wake per tick; the mark stays until none is left', () => {
  const rs = [held('ax'), held('ax'), held('ax')]
  mark('unhold-ax.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  factory(['tick'], { FACTORY_MAX_RUNS: '2' })
  const woke = () => rs.filter(r => wakesOf(r).length).length
  expect(woke()).toBe(2)
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(true)
})

test('AC4: while halted, the pass does nothing', () => {
  const a = held('ax')
  mark('unhold-ax.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  writeFileSync(join(home, 'halt.json'), JSON.stringify({ state: 'paused', at: 1 }))
  factory(['tick'])
  expect(wakesOf(a)).toHaveLength(0)
})

test('AC2: pickUnholds takes the oldest first, within the town cap and each rig cap', () => {
  const r1 = { name: 'r1', maxRuns: 1 }
  const r2 = { name: 'r2' }
  const c = [
    { id: 'a', rig: r1, at: 3 },
    { id: 'b', rig: r1, at: 1 },
    { id: 'c', rig: r2, at: 2 },
    { id: 'd', rig: r2, at: 4 },
  ]
  expect(pickUnholds(c, [], [], 16).map(x => x.id)).toEqual(['b', 'c', 'd'])
  expect(pickUnholds(c, [], [], 2).map(x => x.id)).toEqual(['b', 'c'])
  expect(pickUnholds(c, ['r2', 'r2'], [], 2)).toEqual([])
  expect(pickUnholds(c, [], ['r1'], 16).map(x => x.id)).toEqual(['c', 'd'])
})

test('AC4: trustedUnhold reads a good mark and deletes a bad one', () => {
  mkdirSync(home, { recursive: true })
  const f = join(home, 'm.json')
  writeFileSync(f, JSON.stringify({ before: 10, from: 20, woke: 1 }))
  expect(trustedUnhold(f, 1000)).toEqual({ before: 10, from: 20, woke: 1 })
  for (const bad of [{ before: 1e15, from: 0, woke: 0 }, { before: 1, from: 1e15, woke: 0 }, [], null, 'x']) {
    writeFileSync(f, JSON.stringify(bad))
    expect(trustedUnhold(f, 1000)).toBeUndefined()
    expect(existsSync(f)).toBe(false)
  }
})

function swapBin(code: number) {
  mkdirSync(home, { recursive: true })
  const bin = join(dir, `swap${code}`)
  writeFileSync(bin, `#!/bin/sh\necho "slot 2 is live"\nexit ${code}\n`, { mode: 0o755 })
  return bin
}

test('AC1: a good swap writes the mark of its runner and harness; a failed swap writes none', () => {
  const send = () => {}
  const prev = [process.env.FACTORY_AX_TOKEN_SWAP, process.env.FACTORY_AX_CODEX_TOKEN_SWAP]
  try {
    process.env.FACTORY_AX_TOKEN_SWAP = swapBin(1)
    runTokenSwap({ at: 1, resetsAt: 0 }, 5_000, 'ax', send, 'implement', 'claude', home)
    expect(existsSync(join(home, 'unhold-ax.json'))).toBe(false)
    rmSync(join(home, 'token-swap-ax.json'))
    process.env.FACTORY_AX_TOKEN_SWAP = swapBin(0)
    runTokenSwap({ at: 1, resetsAt: 0 }, 5_000, 'ax', send, 'implement', 'claude', home)
    expect(JSON.parse(readFileSync(join(home, 'unhold-ax.json'), 'utf8'))).toEqual({
      before: 5_000,
      from: 5_000 + 300_000,
      woke: 0,
    })
    expect(existsSync(join(home, 'unhold-ax-codex.json'))).toBe(false)
    process.env.FACTORY_AX_CODEX_TOKEN_SWAP = swapBin(0)
    runTokenSwap({ at: 1, resetsAt: 0 }, 6_000, 'ax', send, 'implement', 'codex', home)
    expect(existsSync(join(home, 'unhold-ax-codex.json'))).toBe(true)
  } finally {
    for (const [i, k] of ['FACTORY_AX_TOKEN_SWAP', 'FACTORY_AX_CODEX_TOKEN_SWAP'].entries())
      if (prev[i] === undefined) delete process.env[k]
      else process.env[k] = prev[i]
  }
})

test('AC3: factory unhold ax wakes the held stations of the ax runner only', () => {
  const a = held('ax')
  const h = held('herdr')
  const e = held('ax', 'egress gateway: model API unreachable')
  const out = factory(['unhold', 'ax'])
  expect(out.code).toBe(0)
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(true)
  factory(['tick'])
  expect(wakesOf(a)).toHaveLength(1)
  expect(wakesOf(h)).toHaveLength(0)
  expect(wakesOf(e)).toHaveLength(0)
})

test('AC3: factory unhold ax --codex writes the Codex mark', () => {
  mkdirSync(home, { recursive: true })
  expect(factory(['unhold', 'ax', '--codex']).code).toBe(0)
  expect(existsSync(join(home, 'unhold-ax-codex.json'))).toBe(true)
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(false)
})

test('AC6: factory unhold refuses a worker, a patrol, a local runner, and bad arguments', () => {
  mkdirSync(home, { recursive: true })
  const bad: [string[], Record<string, string>][] = [
    [['unhold', 'ax'], { FACTORY_RUN: 'ship-x' }],
    [['unhold', 'ax'], { FACTORY_PATROL: '1' }],
    [['unhold', 'herdr'], {}],
    [['unhold', 'nope'], {}],
    [['unhold'], {}],
    [['unhold', 'ax', 'extra'], {}],
    [['unhold', 'ax', '--codex', '--codex'], {}],
  ]
  for (const [args, env] of bad) {
    // factory() strips the worker env of this shell; each row adds back only its own
    const p = factory(args, env)
    expect(p.code).toBe(1)
    expect(p.err).not.toBe('')
  }
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(false)
})

test('AC5: a mark with no held station is deleted and sends no mail', () => {
  mark('unhold-ax.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  const tick = factory(['tick'])
  expect(tick.out).not.toContain('Woke')
  expect(existsSync(join(home, 'unhold-ax.json'))).toBe(false)
})

const CODEX = 'Codex usage limit (seven_day) until 2026-11-08T01:00:00Z'
test('AC2: one Claude mark and one Codex mark share one cap in a tick', () => {
  const rs = [held('ax'), held('ax'), held('ax', CODEX), held('ax', CODEX)]
  mark('unhold-ax.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  mark('unhold-ax-codex.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  factory(['tick'], { FACTORY_MAX_RUNS: '2' })
  expect(rs.filter(r => wakesOf(r).length)).toHaveLength(2)
})

test('a run that does not load does not stop the tick: the held ax run wakes', () => {
  const bad = held('nope')
  const a = held('ax')
  mark('unhold-ax.json', { before: Date.now() + 1000, from: 0, woke: 0 })
  const tick = factory(['tick'])
  expect(tick.code).toBe(0)
  expect(tick.err).not.toContain('unhold:')
  expect(wakesOf(bad)).toHaveLength(0)
  expect(wakesOf(a).length).toBeGreaterThan(0)
})
