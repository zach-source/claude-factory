// `factory show` and `factory tick` rows name the model of the station's worker (claude-factory-oulo):
// the console's Runners tab draws it. Same on-disk run fixture as gatebrief-cli.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const home = join(tmpdir(), `row-model-${process.pid}`)

afterEach(() => rmSync(home, { recursive: true, force: true }))

const DEF: Factory = {
  name: 'lifecycle',
  start: 'build',
  nodes: {
    build: { prompt: 'build it', agent: "claude --model 'claude-test-1'", next: { ok: 'g' } },
    g: { prompt: 'ship it?', gate: true, next: { approve: 'done' } },
  },
}

function run(id: string, atGate: boolean) {
  const actor = createActor(compile(DEF)).start()
  if (atGate)
    actor.send({ type: 'DONE', seq: actor.getSnapshot().context.seq, outcome: 'ok', summary: 's', at: 1 })
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'factory.ts'), `export default ${JSON.stringify(DEF)}`)
  const repo = join(home, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: join(d, 'factory.ts'),
      repo,
      goal: 'g',
      ws: 'w',
      worktree: repo,
      branch: 'b',
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

const show = (id: string) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'show', id], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
    timeout: 30_000,
  })
  return JSON.parse(p.stdout.toString())
}

test("a run's row names its station's model, and a gate's row names none", () => {
  run('rw', false)
  run('rg', true)
  expect(show('rw').model).toBe('claude-test-1')
  expect(show('rg').node).toBe('g')
  expect(show('rg').model).toBeUndefined()
})
