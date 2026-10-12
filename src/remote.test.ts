// The runner with an AX worker, end to end through bin/factory: a fake `ax` stands in for the cluster.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { httpsRemote, overwritten, replayable, rigBeadsSync, vmClaudeFlags } from './cli'
import * as worker from './worker'
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

test("a rig's beads sync through its shared Dolt remote as its user, else through the repo's origin", () => {
  expect(rigBeadsSync(undefined, 'push')).toEqual(['bd', 'dolt', 'push'])
  const r = { name: 'fleet', url: 'https://dolt.example.com:50051/app', user: 'beads' }
  const conn = { host: '127.0.0.1', port: 3308, database: 'app', user: 'root', tls: false }
  // the laptop's Dolt server pushes, and only SQL tells it the user; through the dolt CLI, which waits it out
  expect(rigBeadsSync(r, 'push', conn)).toEqual([
    ...['dolt', '--host', '127.0.0.1', '--port', '3308', '--user', 'root', '--no-tls', '--use-db', 'app'],
    ...['sql', '-r', 'json', '-q', "CALL DOLT_PUSH('--user', 'beads', 'fleet', 'main')"],
  ])
  // a pull commits the laptop's writes, merges, and keeps the VM's row where both changed one, in one transaction
  const pull = rigBeadsSync(r, 'pull', conn).at(-1)!
  expect(pull).toStartWith('SET @@autocommit = 0; ')
  expect(pull).toContain("CALL DOLT_PULL('--user', 'beads', 'fleet', 'main')")
  expect(pull).toContain("CALL DOLT_CONFLICTS_RESOLVE('--theirs', '.')")
  expect(pull).toEndWith('COMMIT')
  expect(() => rigBeadsSync(r, 'push')).toThrow('no Dolt server')
})

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
/** a run as the tick that launched its task left it: working at a, its worker ax://t; returns the worker's seq */
function launched(id: string, policy = true) {
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
  actor.send({ type: 'SPAWNED', seq, pane: 'ax://t', at: Date.now() })
  writeFileSync(join(runDir, 't.json'), JSON.stringify({ node: 'a', seq, policy }))
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
  expect(JSON.parse(first.out).runs[0]).toMatchObject({ id: 'r1', node: 'a', agent: 'idle', pane: 'ax://t' })
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
  rmSync(join(home, 'runs', 'r2'), { recursive: true })
})

test("an outbox replays only the worker's own report, its run's mail and memory, sent as its station", () => {
  const seq = launched('r3')
  const line = (argv: string[], from = 'a') => JSON.stringify({ argv, from, at: 1 })
  cluster('Running', {
    status: 'working',
    lines: [
      line(['decide', 'r3', 'approve']),
      line(['report', 'r3', String(seq + 1), 'ready', 'not my attempt']),
      line(['report', 'other', String(seq), 'ready', 'not my run']),
      line(['mail', 'r3', 'manager', 'hi'], 'manager'),
      'not json',
      JSON.stringify({ argv: ['report', 'r3', seq] }), // not all strings
    ],
  })
  factory(['tick'])
  expect(readFileSync(join(home, 'runs', 'r3', 't.cursor'), 'utf8')).toBe('6') // a malformed line is refused and passed, not retried every tick
  expect(inbox('r3')).not.toContain('"outcome"')
  expect(inbox('r3')).toContain('"from":"a","to":"manager","text":"hi"') // not as the manager it claimed
  expect(called().match(/worker prompt/g)).toHaveLength(5) // each refusal told to the worker
  rmSync(join(home, 'runs', 'r3'), { recursive: true })
})

test('files too big for the env (the brief) go to the VM over ssh in parts once the task runs, then never again', () => {
  launched('r6')
  const side = join(home, 'runs', 'r6', 't.json')
  writeFileSync(
    side,
    JSON.stringify({ ...JSON.parse(readFileSync(side, 'utf8')), put: ['brief.md', 'beads.jsonl.gz'] }),
  )
  writeFileSync(join(home, 'runs', 'r6', 't.brief.md'), 'x'.repeat(150_000)) // two parts
  writeFileSync(join(home, 'runs', 'r6', 't.beads.jsonl.gz'), Bun.gzipSync('{"id":"x-1"}'))
  cluster('Running', { status: 'working', lines: [] })
  factory(['tick'])
  expect(called()).toContain('ssh t -- factory worker put brief.md 0 3 ')
  expect(called()).toContain('ssh t -- factory worker put brief.md 2 3 ')
  expect(called()).toContain('ssh t -- factory worker put beads.jsonl.gz 0 1 ')
  expect(JSON.parse(readFileSync(side, 'utf8')).put).toEqual([])
  cluster('Running', { status: 'working', lines: [] })
  factory(['tick'])
  expect(called()).not.toContain('worker put')
  rmSync(join(home, 'runs', 'r6'), { recursive: true })
})

test("a task's egress policy is tried again each tick until its actor shows, without waiting in the tick", () => {
  launched('r4', false)
  const kubectl = join(dir, 'kubectl')
  writeFileSync(kubectl, `#!/bin/sh\necho "kubectl $*" >> ${calls}\n[ -f ${dir}/actor ]\n`)
  chmodSync(kubectl, 0o755)
  cluster('Running', { status: 'working', lines: [] })
  const first = factory(['tick'], { FACTORY_KUBECTL: kubectl })
  expect(JSON.parse(first.out).runs[0]).toMatchObject({ agent: 'pending' })
  expect(called()).not.toContain('worker poll')
  writeFileSync(join(dir, 'actor'), '')
  factory(['tick'], { FACTORY_KUBECTL: kubectl })
  expect(called()).toContain('worker poll')
  expect(JSON.parse(readFileSync(join(home, 'runs', 'r4', 't.json'), 'utf8')).policy).toBe(true)
  rmSync(join(home, 'runs', 'r4'), { recursive: true })
})

test('a VM worker refused for the usage limit is held until the reset, not nudged', () => {
  launched('r5')
  const refused = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() + 1000).toISOString(),
    error: 'rate_limit',
    quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 3600 },
  })
  cluster('Running', { status: 'idle', session: 's1', lines: [], tail: refused })
  factory(['tick']) // learns the session
  const held = factory(['tick'])
  expect(JSON.parse(held.out).runs[0]).toMatchObject({ agent: 'usage limit' })
  expect(readFileSync(join(home, 'runs', 'r5', 'state.json'), 'utf8')).toContain(
    'at its usage limit (five_hour)',
  ) // the manager is told
  expect(called()).not.toContain('worker prompt')
  rmSync(join(home, 'runs', 'r5'), { recursive: true })
})

test("a worker's address picks its runner: a bare pane id is herdr's, `<name>://` is that runner's", () => {
  expect(runnerOf('w1-2').name).toBe('herdr')
  expect(runnerOf('wA6:p1').name).toBe('herdr')
  expect(runnerOf('ax:p1').name).toBe('herdr') // a herdr id, even one that starts like a runner's name
  expect(runnerOf('ax://f-r1-1').name).toBe('ax')
  expect(runnerOf('nope://x').name).toBe('herdr') // not registered: runs in flight keep their herdr behavior
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

test("a VM's bd writes go to GitHub, not the outbox, and its report pushes them first", () => {
  expect(replayable(['bd', 'close', 'x-1'], { node: 'a', seq: 1 }, 'r1')).toBeNull()
  const vm = join(dir, 'vm-sync')
  mkdirSync(vm, { recursive: true })
  const log = join(vm, 'bd.log')
  writeFileSync(join(vm, 'bd'), `#!/bin/sh\necho "$* shared=$BEADS_DOLT_SHARED_SERVER" >> ${log}\n`)
  chmodSync(join(vm, 'bd'), 0o755)
  const p = Bun.spawnSync([CLI, 'report', 'r1', '1', 'ready', 'done'], {
    env: {
      ...process.env,
      FACTORY_OUTBOX: join(vm, 'outbox.jsonl'),
      FACTORY_FROM: 'a',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(p.exitCode).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('dolt pull shared=0\ndolt push shared=0\n')
  expect(readFileSync(join(vm, 'outbox.jsonl'), 'utf8')).toContain('"report"')

  // a push that never goes through refuses the report: queued, it would end the VM with the writes in it
  rmSync(join(vm, 'outbox.jsonl'))
  writeFileSync(join(vm, 'bd'), `#!/bin/sh\n[ "$2" = push ] && exit 1\nexit 0\n`)
  const refused = Bun.spawnSync([CLI, 'report', 'r1', '1', 'ready', 'done'], {
    env: {
      ...process.env,
      FACTORY_OUTBOX: join(vm, 'outbox.jsonl'),
      FACTORY_FROM: 'a',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(refused.exitCode).toBe(1)
  expect(refused.stderr.toString()).toContain('report again')
  expect(existsSync(join(vm, 'outbox.jsonl'))).toBe(false)
})

test("a launch starts from a gone worker's pushed commits instead of pushing the stale worktree over them", () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
    return p.stdout.toString().trim()
  }
  mkdirSync(dir, { recursive: true })
  const origin = join(dir, 'origin.git')
  const worktree = join(dir, 'wt4')
  const vm = join(dir, 'vm4')
  sh(dir, 'git', 'init', '-q', '--bare', origin)
  sh(dir, 'git', 'clone', '-q', origin, worktree)
  writeFileSync(join(worktree, 'issues.jsonl'), 'a\n')
  sh(worktree, 'git', 'add', '.')
  sh(worktree, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  sh(worktree, 'git', 'push', '-q', 'origin', 'HEAD:refs/heads/factory/r4')
  writeFileSync(join(worktree, 'plan.md'), 'p\n')
  sh(worktree, 'git', 'add', '.')
  sh(worktree, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'plan')
  sh(worktree, 'git', 'push', '-q', 'origin', 'HEAD:refs/heads/factory/r4')
  // the worker's VM rewrote the branch (its plan commit anew, as a rebase does) and pushed its work, then went
  // without reporting; bd rewrote the laptop's export meanwhile
  sh(dir, 'git', 'clone', '-q', '-b', 'factory/r4', origin, vm)
  sh(
    vm,
    'git',
    '-c',
    'user.name=v',
    '-c',
    'user.email=v@v',
    'commit',
    '-q',
    '--amend',
    '--no-edit',
    '--reset-author',
  )
  writeFileSync(join(vm, 'issues.jsonl'), 'a\nb\n')
  sh(vm, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'work')
  sh(vm, 'git', 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/factory/r4')
  writeFileSync(join(worktree, 'issues.jsonl'), 'a\nc\n')

  const runDir = join(home, 'runs', 'r4')
  mkdirSync(join(runDir, 'prompts'), { recursive: true })
  writeFileSync(join(home, 'dream.stamp'), '')
  writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(def)}`)
  const run = { id: 'r4', factory: join(runDir, 'factory.ts'), repo: worktree, goal: 'g', ws: 'w1', worktree }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...run, branch: 'factory/r4' }))
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'TICK', at: Date.now() })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'x', repo: worktree, factory: 'one', runner: 'ax' }]),
  )
  cluster('Running', { status: 'idle', lines: [] })
  writeFileSync(join(dir, 'kubectl'), '#!/bin/sh\necho CA\n')
  chmodSync(join(dir, 'kubectl'), 0o755)

  const out = factory(['tick'], { FACTORY_AX_IMAGE: 'img', FACTORY_KUBECTL: join(dir, 'kubectl') }).out
  const row = JSON.parse(out).runs.find((r: { id: string }) => r.id === 'r4')
  expect(row.error).toBeNull()
  expect(sh(worktree, 'git', 'log', '--format=%s')).toBe('work\nplan\nbase') // its plan once, as the VM wrote it
  expect(sh(worktree, 'git', 'status', '--short')).toBe('') // the export the stash could not put back is the worker's
  expect(called()).toContain('apply -f -')
  rmSync(runDir, { recursive: true })
}, 30_000) // git clones and a whole tick

test("a pull that kept the VM's version of an issue says on it what the laptop had", () => {
  // what dolt sql -r json printed for the pull's statements, one line each
  const out = [
    '{}',
    '{"rows": [{"conflicts":"1","fast_forward":"0","message":"merge has unresolved conflicts"}]}',
    '{"rows": [{"base_id":"x-1","base_status":"open","our_diff_type":"modified","our_id":"x-1","our_notes":"laptop","our_status":"blocked","their_diff_type":"modified","their_id":"x-1","their_notes":"laptop","their_status":"closed"},' +
      '{"our_diff_type":"removed","our_id":null,"their_diff_type":"modified","their_id":"x-2","their_status":"open"}]}',
    '{"rows": [{"status":"0"}]}',
  ].join('\n')
  expect(overwritten(out)).toEqual([
    {
      id: 'x-1',
      text: "[factory] The laptop and a VM both changed this issue; the VM's version was kept. The laptop had status=blocked.",
    },
    {
      id: 'x-2',
      text: "[factory] The laptop and a VM both changed this issue; the VM's version was kept. The laptop had deleted it.",
    },
  ])
  expect(overwritten('{}\n{"rows": [{"status":"0"}]}')).toEqual([])
})
