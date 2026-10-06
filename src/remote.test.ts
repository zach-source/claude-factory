// The runner with an AX worker, end to end through bin/factory: a fake `ax` stands in for the cluster.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { httpsRemote } from './cli'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `remote-${process.pid}`)
const home = join(dir, 'home')
const calls = join(dir, 'calls.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_AX: join(dir, 'ax'), ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

test('git remotes become https remotes the VM clones through the proxy', () => {
  expect(httpsRemote('git@github.com:o/app.git')).toBe('https://github.com/o/app.git')
  expect(httpsRemote('ssh://git@github.com/o/app.git')).toBe('https://github.com/o/app.git')
  expect(httpsRemote('https://github.com/o/app.git')).toBe('https://github.com/o/app.git')
})

test("inside a VM, a worker's report and mail wait in the outbox instead of touching a run", () => {
  mkdirSync(dir, { recursive: true })
  const outbox = join(dir, 'outbox.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  expect(factory(['report', 'r1', '1', 'ready', 'did', 'it'], env).out).toContain('you are done, stop now')
  expect(factory(['memory', 'add', 'a lesson'], env).code).toBe(0)
  const lines = readFileSync(outbox, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(lines.map(l => [l.argv, l.from])).toEqual([
    [['report', 'r1', '1', 'ready', 'did', 'it'], 'a'],
    [['memory', 'add', 'a lesson'], 'a'],
  ])
  expect(existsSync(home)).toBe(false) // nothing on this side was touched
})

const def: Factory = { name: 'one', start: 'a', nodes: { a: { prompt: 'do a', next: { ready: 'done' } } } }
/** a run as the tick that launched its task left it: working at a, its worker ax:t; returns the worker's seq */
function launched(id: string) {
  const runDir = join(home, 'runs', id)
  const worktree = join(dir, 'wt')
  mkdirSync(runDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(home, 'dream.stamp'), '') // no dream in a test
  writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(def)}`)
  const run = {
    id,
    factory: join(runDir, 'factory.ts'),
    repo: worktree,
    goal: 'g',
    ws: 'w1',
    worktree,
    branch: `factory/${id}`,
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'TICK', at: Date.now() })
  const seq = actor.getSnapshot().context.seq
  actor.send({ type: 'SPAWNED', seq, pane: 'ax:t', at: Date.now() })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  return seq
}
/** the fake cluster: the task's phase and what the worker's poll prints */
function cluster(phase: string, poll: object) {
  rmSync(calls, { force: true })
  writeFileSync(join(dir, 'ssh'), JSON.stringify(poll))
  writeFileSync(
    join(dir, 'ax'),
    `#!/bin/sh
echo "$*" >> ${calls}
case "$3 $4" in
  "get task") printf 'status:\\n  phase: ${phase}\\n' ;;
  ssh*) cat ${dir}/ssh ;;
esac
`,
  )
  chmodSync(join(dir, 'ax'), 0o755)
}
const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')
const inbox = (id: string) => readFileSync(join(home, 'runs', id, 'inbox.jsonl'), 'utf8')

test("a tick replays an AX worker's report from its outbox, and the task goes when the station ends", () => {
  const seq = launched('r1')
  const report = JSON.stringify({ argv: ['report', 'r1', String(seq), 'ready', 'built a'], from: 'a', at: 1 })
  cluster('Running', { status: 'idle', session: 's1', lines: [report] })

  const first = factory(['tick'])
  expect(first.code).toBe(0)
  expect(JSON.parse(first.out).runs[0]).toMatchObject({ id: 'r1', node: 'a', agent: 'idle', pane: 'ax:t' })
  expect(readFileSync(join(home, 'runs', 'r1', 't.cursor'), 'utf8')).toBe('1')
  expect(inbox('r1')).toContain('"outcome":"ready"')
  expect(called()).toContain('-a factory ssh t -- factory worker poll 0')

  const second = factory(['tick'])
  expect(JSON.parse(second.out).runs[0]).toMatchObject({ id: 'r1', node: 'done' })
  expect(called()).toContain('-a factory delete task t')
  expect(called()).toContain('-a factory delete workspace t')
  rmSync(join(home, 'runs', 'r1'), { recursive: true })
})

test('a worker waiting on the manager is suspended, and woken by the answer before it is delivered', () => {
  launched('r2')
  const ask = JSON.stringify({ argv: ['mail', 'r2', 'manager', 'which db?'], from: 'a', at: 1 })
  cluster('Running', { status: 'idle', session: 's1', lines: [ask] })
  factory(['tick']) // the question is replayed: it reaches the manager's box
  expect(inbox('r2')).toContain('which db?')
  factory(['tick']) // asked and idle
  expect(called()).toContain('-a factory suspend task t')

  expect(factory(['mail', 'r2', 'a', 'postgres']).code).toBe(0)
  cluster('Suspended', { status: 'idle', lines: [] })
  const woken = factory(['tick'])
  expect(JSON.parse(woken.out).runs[0]).toMatchObject({ agent: 'suspended' })
  expect(called()).toContain('-a factory resume task t')
  expect(called()).not.toContain('worker prompt')

  cluster('Running', { status: 'idle', lines: [] })
  factory(['tick'])
  const text = Buffer.from('[factory mail from manager] postgres').toString('base64')
  expect(called()).toContain(`-a factory ssh t -- factory worker prompt ${text}`)
})
