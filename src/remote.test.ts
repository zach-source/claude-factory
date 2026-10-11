// The runner with an AX worker, end to end through bin/factory: a fake `ax` stands in for the cluster.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { httpsRemote, vmClaudeFlags } from './cli'
import { runnerOf, runners } from './runner'

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

test('git remotes become https remotes the VM clones', () => {
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

test("a worker's address picks its runner: a bare pane id is herdr's, `<name>:` is that runner's", () => {
  expect(runnerOf('w1-2').name).toBe('herdr')
  expect(runnerOf('ax:f-r1-1').name).toBe('ax')
  expect(runnerOf('nope:x').name).toBe('herdr') // not registered: runs in flight keep their herdr behavior
  expect(Object.keys(runners).sort()).toEqual(['ax', 'herdr'])
  expect(runners.herdr!.local).toBe(true)
  expect(runners.ax!.local).toBe(false)
})

/** a git repo with beads, which is what a rig needs to be defined */
function repo() {
  const r = join(dir, 'repo')
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  return r
}
test('rig add --runner names a registered runner, and the error lists them', () => {
  const r = repo()
  const bad = factory(['rig', 'add', 'x', r, '--runner', 'nope'])
  expect(bad.code).not.toBe(0)
  expect(bad.err).toContain('--runner is herdr, ax (not "nope")')
  expect(factory(['rig', 'add', 'x', r, '--runner', 'ax']).code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({ runner: 'ax' })
  // herdr is the default: it is not stored
  expect(factory(['rig', 'add', 'x', r, '--runner', 'herdr']).code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0].runner).toBeUndefined()
})

test('rig add --egress and --agent are for a runner that can take them', () => {
  const r = repo()
  const add = (...a: string[]) => factory(['rig', 'add', 'x', r, ...a])
  expect(add('--egress', 'api.openai.com=OPENAI').err).toContain('add --runner ax')
  expect(add('--runner', 'ax', '--egress', 'https://x.com').err).toContain('not a hostname')
  expect(add('--runner', 'ax', '--egress', 'api.openai.com=openai').err).toContain('SCREAMING_SNAKE_CASE')
  expect(add('--runner', 'ax', '--agent', 'my-script').err).toContain('claude, codex or pi')
  expect(add('--runner', 'ax', '--mcp', join(dir, 'mcp.json')).err).toContain('--mcp does not reach')
  const ok = add(
    ...['--runner', 'ax', '--agent', 'codex -m o3', '--egress', 'api.openai.com=OPENAI'],
    ...['--egress', 'pypi.org,files.pythonhosted.org'],
  )
  expect(ok.code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({
    runner: 'ax',
    agent: 'codex -m o3',
    egress: [{ hosts: ['api.openai.com'], key: 'OPENAI' }, { hosts: ['pypi.org', 'files.pythonhosted.org'] }],
  })
})

test("inside a VM Claude keeps the worker's tools and prompt but none of the laptop's settings", () => {
  const flags = vmClaudeFlags({ maxContextK: 150 })
  expect(flags.slice(0, 4)).toEqual([
    '--tools',
    expect.stringContaining('Bash,Read,Edit'),
    '--setting-sources',
    'project,local',
  ])
  const settings = JSON.parse(flags[flags.indexOf('--settings') + 1]!)
  expect(settings).toEqual({
    autoMemoryEnabled: false,
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    skipDangerousModePermissionPrompt: true,
    autoCompactWindow: 300_000,
  })
  expect(flags.at(-1)).toBe('/opt/factory/src/worker-system.md')
})

test("Claude's trust dialog does not hold an AX rig's run: the VM runs the agent headless", () => {
  const worktree = join(dir, 'wt')
  mkdirSync(worktree, { recursive: true })
  const config = join(dir, 'claude-config')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ projects: {} })) // trusts nothing
  const runDir = join(home, 'runs', 'r3')
  mkdirSync(join(runDir, 'prompts'), { recursive: true })
  writeFileSync(join(home, 'dream.stamp'), '')
  writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(def)}`)
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'r3',
      factory: join(runDir, 'factory.ts'),
      repo: worktree,
      goal: 'g',
      ws: 'w1',
      worktree,
      branch: 'factory/r3',
    }),
  )
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'TICK', at: Date.now() })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  const rig = (runner?: string) =>
    writeFileSync(
      join(home, 'rigs.json'),
      JSON.stringify([{ name: 'x', repo: worktree, factory: 'one', ...(runner && { runner }) }]),
    )
  const tick = () =>
    JSON.parse(factory(['tick'], { CLAUDE_CONFIG_DIR: config }).out).runs.find(
      (r: { id: string }) => r.id === 'r3',
    )

  rig() // a herdr rig waits at the dialog
  expect(tick().agent).toBe('awaiting trust')
  rig('ax') // an ax rig goes on to launch, which here has no image to launch with
  const row = tick()
  expect(row.agent).not.toBe('awaiting trust')
  expect(row.error).toContain('FACTORY_AX_IMAGE')
  rmSync(runDir, { recursive: true })
})
