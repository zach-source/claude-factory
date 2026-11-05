// claude-factory-8v8z: the bun test preload (src/test-env.ts) must keep every test away from the host's real herdr.
// A spawned `factory tick` of a home with a run calls herdr (showInSidebar). A logging fake herdr sits first on PATH.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `test-env-${process.pid}`)
const bin = join(dir, 'bin')
const log = join(dir, 'calls.log')
const home = join(dir, 'home')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

function setup() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "$*" >> ${log}\nexit 1\n`)
  chmodSync(join(bin, 'herdr'), 0o755)
  const d = join(home, 'runs', 'r1')
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id: 'r1',
      factory: factoryFile,
      repo: dir,
      goal: 'g',
      ws: 'w1',
      worktree: dir,
      branch: 'b',
    }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
}

/** the number of herdr calls a spawned tick makes, with the fake herdr first on PATH */
function ticks(env: Record<string, string> = {}): number {
  setup()
  Bun.spawnSync([CLI, 'tick'], {
    env: {
      ...process.env,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      PATH: `${bin}:${process.env['PATH']}`,
      ...env,
    },
  })
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
}

test('the preload strips HERDR_* and points FACTORY_HERDR at no binary', () => {
  expect(Object.keys(process.env).filter(k => k.startsWith('HERDR_'))).toEqual([])
  expect(Bun.which(process.env['FACTORY_HERDR'] ?? 'herdr')).toBeNull()
})

test('a spawned tick reaches no herdr, even with one first on PATH', () => {
  expect(ticks()).toBe(0)
})

test('positive control: the same tick with FACTORY_HERDR set to the fake logs a call', () => {
  expect(ticks({ FACTORY_HERDR: join(bin, 'herdr') })).toBeGreaterThan(0)
})
