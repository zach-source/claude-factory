// claude-factory-gakb: a worker with FACTORY_RUN set cannot run a run-scoped factory command for another run.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { otherRunRefusal } from './cli.ts'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `run-scope-${process.pid}`)
const home = join(dir, 'home')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string | undefined> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_GC: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

function makeRun(id: string) {
  const d = join(home, 'runs', id)
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: file, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
  const seq = (actor.getSnapshot().context as { seq: number }).seq
  return { seq, lines: () => readFileSync(join(d, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean) }
}

test('report for another run is refused and posts nothing; own run still reports', () => {
  const a = makeRun('run-a')
  const b = makeRun('run-b')
  for (const id of ['run-b', '', 'run-a ', 'RUN-A', 'run-']) {
    for (const extra of [{}, { FACTORY_OUTBOX: join(dir, 'outbox') }]) {
      const r = factory(['report', id, String(b.seq), 'ready', 'x'], { FACTORY_RUN: 'run-a', ...extra })
      expect(r.code).toBe(1)
      expect(r.err).toContain('refused')
    }
  }
  expect(factory(['report'], { FACTORY_RUN: 'run-a' }).code).toBe(1)
  expect(b.lines()).toEqual([])
  expect(a.lines()).toEqual([])
  expect(existsSync(join(dir, 'outbox'))).toBe(false)
  const ok = factory(['report', 'run-a', String(a.seq), 'ready', 'x'], { FACTORY_RUN: 'run-a' })
  expect(ok.code).toBe(0)
  expect(a.lines().length).toBe(1)
  expect(b.lines()).toEqual([])
})

test('mail for another run is refused with no inbox write', () => {
  const a = makeRun('run-a')
  const b = makeRun('run-b')
  const r = factory(['mail', 'run-b', 'manager', 'x'], { FACTORY_RUN: 'run-a' })
  expect(r.code).toBe(1)
  expect(b.lines()).toEqual([])
  expect(factory(['mail', 'run-a', 'manager', 'x'], { FACTORY_RUN: 'run-a' }).code).toBe(0)
  expect(a.lines().length).toBe(1)
})

const ENV = { FACTORY_RUN: 'A' }
test.each(['report', 'decide', 'mail', 'poke', 'retry', 'goto', 'abort'])(
  'otherRunRefusal: %s names one run',
  cmd => {
    expect(otherRunRefusal(cmd, ['B', '1'], ENV)).toContain('refused')
    expect(otherRunRefusal(cmd, [], ENV)).toContain('refused')
    expect(otherRunRefusal(cmd, ['a'], ENV)).toContain('refused')
    expect(otherRunRefusal(cmd, ['A', '1'], ENV)).toBeUndefined()
    expect(otherRunRefusal(cmd, ['B', '1'], {})).toBeUndefined()
    expect(otherRunRefusal(cmd, ['B', '1'], { FACTORY_RUN: '' })).toBeUndefined()
  },
)

test('otherRunRefusal: commands that name no run are never refused', () => {
  expect(otherRunRefusal('show', ['B'], ENV)).toBeUndefined()
  expect(otherRunRefusal('status', [], ENV)).toBeUndefined()
  expect(otherRunRefusal('memory', ['search', '--from', 'B/plan', 'q'], ENV)).toBeUndefined()
  expect(otherRunRefusal(undefined, [], ENV)).toBeUndefined()
})

test.each(['add', 'helped'])('otherRunRefusal: memory %s checks every --from', verb => {
  expect(otherRunRefusal('memory', [verb, '--from', 'B/plan', 's', 'b'], ENV)).toContain('refused')
  expect(otherRunRefusal('memory', [verb, '--from', 'A/plan', '--from', 'B/x'], ENV)).toContain('refused')
  expect(otherRunRefusal('memory', [verb, '--from', 'A/plan', 's'], ENV)).toBeUndefined()
  expect(otherRunRefusal('memory', [verb, 's'], ENV)).toBeUndefined()
  expect(otherRunRefusal('memory', [verb, '--from'], ENV)).toContain('refused')
})

test('memory add for another run writes nothing', () => {
  mkdirSync(home, { recursive: true })
  const r = factory(['memory', 'add', '--from', 'B/plan', '--kind', 'fact', 's', 'b'], { FACTORY_RUN: 'A' })
  expect(r.code).toBe(1)
  expect(existsSync(join(home, 'memory', 'inbox'))).toBe(false)
})
