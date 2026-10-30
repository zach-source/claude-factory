// The runner with an AX worker, end to end through bin/factory: a fake `ax` stands in for the cluster.
import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import {
  githubSlug,
  httpsRemote,
  overwritten,
  progressSig,
  replayable,
  rigBeadsSync,
  vmClaudeFlags,
  vmCodexHome,
} from './cli'
import * as worker from './worker'
import { runnerOf, runners } from './runner'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `remote-${process.pid}`)
const home = join(dir, 'home')
const calls = join(dir, 'calls.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    // FACTORY_SELF_UPDATE=0: this dev worktree's own branch is never 'main', so a real kick
    // would refuse and mail the manager a new "branch is ..., not main" reason, landing in
    // `home` on a later tick and inflating manager-mail assertions (claude-factory-5h9.8)
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_AX: join(dir, 'ax'),
      FACTORY_KUBECTL: readyController(),
      FACTORY_SELF_UPDATE: '0',
      ...env,
    },
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

// claude-factory-0u0: githubSlug must anchor the host at exactly github.com, not merely a URL
// that contains "github.com" somewhere, and must still accept userinfo (a token or username
// before the @) since this host's rigs use that form.
test('githubSlug accepts only an exact github.com origin, with or without userinfo', () => {
  for (const url of [
    'https://github.com/acme/widget',
    'https://github.com/acme/widget.git',
    'git@github.com:acme/widget.git',
    'ssh://git@github.com/acme/widget.git',
    'https://user@github.com/acme/widget.git',
    'https://x-access-token:e2e@github.com/acme/widget.git',
  ])
    expect(githubSlug(url)).toBe('acme/widget')
  for (const url of [
    'https://mygithub.com/acme/widget',
    'git@mygithub.com:acme/widget.git',
    'ssh://git@notgithub.com/acme/widget.git',
    'https://github.com.evil.example/acme/widget',
    'https://evil.example/github.com/acme/widget',
    'https://github.com/acme/widget/extra',
  ])
    expect(githubSlug(url)).toBeNull()
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

test('inside a VM, `report`/`mail`/`memory add --help`|`-h` print usage and exit 0, nothing queued (claude-factory-4x1)', () => {
  mkdirSync(dir, { recursive: true })
  const outbox = join(dir, 'outbox-help.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  for (const args of [
    ['report', '--help'],
    ['report', '-h'],
    ['mail', '--help'],
    ['memory', 'add', '--help'],
  ]) {
    const r = factory(args, env)
    expect(r.code).toBe(0)
    expect(r.out).toContain('usage: factory')
    expect(r.out).not.toContain('queued for the factory')
  }
  expect(existsSync(outbox)).toBe(false) // nothing was appended
})

test('inside a VM, malformed report/mail args refuse on stderr with exit 1, nothing queued (claude-factory-4x1)', () => {
  mkdirSync(dir, { recursive: true })
  const outbox = join(dir, 'outbox-bad.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  const tooFew = factory(['report', 'r1'], env)
  expect(tooFew.code).toBe(1)
  expect(tooFew.err).toContain('usage: factory report')
  const badSeq = factory(['report', 'r1', 'two', 'ready', 'x'], env)
  expect(badSeq.code).toBe(1)
  expect(badSeq.err).toContain('usage: factory report')
  expect(existsSync(outbox)).toBe(false)
})

test('inside a VM, a well-formed report/mail still queues, and "-h" in free text is not help (claude-factory-4x1)', () => {
  mkdirSync(dir, { recursive: true })
  const outbox = join(dir, 'outbox-ok.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  expect(factory(['mail', 'r1', 'manager', 'hi'], env).code).toBe(0)
  const r = factory(['report', 'r1', '3', 'ready', 'fixed', 'the', '-h', 'flag'], env)
  expect(r.code).toBe(0)
  expect(r.out).toContain('queued for the factory')
  const lines = readFileSync(outbox, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l).argv)
  expect(lines).toEqual([
    ['mail', 'r1', 'manager', 'hi'],
    ['report', 'r1', '3', 'ready', 'fixed', 'the', '-h', 'flag'],
  ])
})

test('outboxUsage: --help/-h only in a positional slot, malformed args, else null to queue (claude-factory-4x1)', () => {
  expect(worker.outboxUsage('report', ['--help'])).toBe('help')
  expect(worker.outboxUsage('report', ['-h'])).toBe('help')
  expect(worker.outboxUsage('mail', ['--help'])).toBe('help')
  expect(worker.outboxUsage('memory', ['add', '--help'])).toBe('help')
  expect(worker.outboxUsage('report', ['r1'])).toContain('usage: factory report')
  expect(worker.outboxUsage('report', ['r1', 'two', 'ready', 'x'])).toContain('usage: factory report')
  expect(worker.outboxUsage('report', ['r1', '3', '-bad', 'x'])).toContain('usage: factory report')
  expect(worker.outboxUsage('mail', ['r1'])).toContain('usage: factory mail')
  expect(worker.outboxUsage('memory', ['add'])).toContain('usage: factory memory add')
  expect(worker.outboxUsage('mail', ['r1', 'manager', 'hi'])).toBeNull()
  expect(worker.outboxUsage('report', ['r1', '3', 'ready', 'fixed', 'the', '-h', 'flag'])).toBeNull()
  expect(worker.outboxUsage('memory', ['add', 'a lesson'])).toBeNull()
})

const def: Factory = { name: 'one', start: 'a', nodes: { a: { prompt: 'do a', next: { ready: 'done' } } } }
/** a run as the tick that launched its task left it: working at a, its worker ax://<task>; returns the worker's seq */
function launched(id: string, policy = true, task = 't') {
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
  actor.send({ type: 'SPAWNED', seq, pane: `ax://${task}`, at: Date.now() })
  writeFileSync(join(runDir, `${task}.json`), JSON.stringify({ node: 'a', seq, policy }))
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  return seq
}
/** node a's def for claude-factory-9ff.1: it times out at 45 min, or at 75 min after a timeout fail */
const escalatingDef: Factory = {
  name: 'one',
  start: 'a',
  nodes: { a: { prompt: 'do a', timeoutMin: 45, onTimeout: { timeoutMin: 75 }, next: { ready: 'done' } } },
}
/**
 * A run after node a's worker fails once, and the backoff relaunches it. The run is now on the
 * escalated attempt, working, with its SPAWNED `at` elapsedMin ago. This sends the real actor FAIL,
 * then a TICK past retryAt (backoff), then a fresh SPAWNED. So timeoutOf()'s afterTimeout() check sees
 * the log a real run would see (claude-factory-9ff). Returns the escalated attempt's seq.
 */
function launchedAfterFail(id: string, priorFailReason: string, elapsedMin: number, task = 't') {
  const runDir = join(home, 'runs', id)
  const worktree = join(dir, 'wt')
  mkdirSync(runDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(home, 'dream.stamp'), '') // no dream in a test
  writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(escalatingDef)}`)
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
  const actor = createActor(compile(escalatingDef)).start()
  actor.send({ type: 'TICK', at: Date.now() })
  const firstSeq = actor.getSnapshot().context.seq
  actor.send({ type: 'SPAWNED', seq: firstSeq, pane: `ax://${task}`, at: Date.now() })
  actor.send({ type: 'FAIL', seq: firstSeq, reason: priorFailReason, at: Date.now() })
  actor.send({ type: 'TICK', at: actor.getSnapshot().context.retryAt }) // past the backoff: a fresh launch
  const seq = actor.getSnapshot().context.seq
  actor.send({ type: 'SPAWNED', seq, pane: `ax://${task}`, at: Date.now() - elapsedMin * 60_000 })
  writeFileSync(join(runDir, `${task}.json`), JSON.stringify({ node: 'a', seq, policy: true }))
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
function readyController() {
  const path = join(dir, 'ready-controller')
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
  *"get deployment ax-controller"*) echo '{"metadata":{"generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"readyReplicas":1,"availableReplicas":1}}' ;;
  *) echo CA ;;
esac
`,
  )
  chmodSync(path, 0o755)
  return path
}
// the default FACTORY_AX_CAPABILITIES (SETUID,SETGID,CHOWN): every `ax ssh` command runs as the worker user
const AS_WORKER = 'setpriv --reuid=worker --regid=worker --init-groups env HOME=/home/worker USER=worker'
const inbox = (id: string) => readFileSync(join(home, 'runs', id, 'inbox.jsonl'), 'utf8')
/** the fake cluster, but a distinct poll per task (ax://<task>): lets two runs' workers disagree at once */
function clusterByTask(phase: string, pollByTask: Record<string, object>) {
  rmSync(calls, { force: true })
  for (const [task, poll] of Object.entries(pollByTask))
    writeFileSync(join(dir, `ssh-${task}`), JSON.stringify(poll))
  const cases = Object.keys(pollByTask)
    .map(task => `    ${task}) cat ${dir}/ssh-${task} ;;`)
    .join('\n')
  writeFileSync(
    join(dir, 'ax'),
    `#!/bin/sh
echo "$*" >> ${calls}
case "$3" in
  get) printf 'status:\\n  phase: ${phase}\\n' ;;
  ssh)
    case "$4" in
${cases}
    esac
    ;;
esac
`,
  )
  chmodSync(join(dir, 'ax'), 0o755)
}
/**
 * unlike cluster()/clusterByTask(), which echo the same canned poll for any cursor (so a line-count-cursor
 * bug would pass vacuously), this slices like the real worker.poll(cursor) does: one ssh-c<n> file per
 * n in 0..lines.length, each holding {status, lines: lines.slice(n)}, keyed by the poll's actual last arg.
 * `lines` is the outbox's real, current content; call again with new content once the worker edits it
 * (claude-factory-4x1)
 */
function clusterCursor(phase: string, status: string, lines: string[]) {
  rmSync(calls, { force: true })
  for (const f of readdirSync(dir)) if (f.startsWith('ssh-c')) rmSync(join(dir, f))
  for (let n = 0; n <= lines.length; n++)
    writeFileSync(join(dir, `ssh-c${n}`), JSON.stringify({ status, lines: lines.slice(n) }))
  writeFileSync(
    join(dir, 'ax'),
    `#!/bin/sh
echo "$*" >> ${calls}
case "$3 $4" in
  "get task") printf 'status:\\n  phase: ${phase}\\n' ;;
esac
case "$3" in
  ssh)
    n=0
    for a in "$@"; do n="$a"; done
    if [ -f ${dir}/ssh-c"$n" ]; then cat ${dir}/ssh-c"$n"; else echo '{"status":"${status}","lines":[]}'; fi
    ;;
esac
`,
  )
  chmodSync(join(dir, 'ax'), 0o755)
}
/** the laptop's record of which outbox lines (by content hash) it has already replayed for a task */
const seenOf = (id: string, task = 't') =>
  JSON.parse(readFileSync(join(home, 'runs', id, `${task}.seen`), 'utf8')) as {
    seen: Record<string, number>
    missing: number
  }
const seenTotal = (id: string, task = 't') => Object.values(seenOf(id, task).seen).reduce((a, b) => a + b, 0)

test("a tick replays an AX worker's report from its outbox, and cleans up even when the controller is unavailable", () => {
  const seq = launched('r1')
  const report = JSON.stringify({ argv: ['report', 'r1', String(seq), 'ready', 'built a'], from: 'a', at: 1 })
  cluster('Running', { status: 'idle', session: 's1', lines: [report] })

  const kubectl = join(dir, 'down-controller')
  writeFileSync(kubectl, '#!/bin/sh\nexit 1\n')
  chmodSync(kubectl, 0o755)
  const env = { FACTORY_KUBECTL: kubectl }
  const first = factory(['tick'], env)
  expect(first.code).toBe(0)
  expect(JSON.parse(first.out).runs[0]).toMatchObject({ id: 'r1', node: 'a', agent: 'idle', pane: 'ax://t' })
  expect(seenTotal('r1')).toBe(1)
  expect(inbox('r1')).toContain('"outcome":"ready"')
  expect(called()).toContain(`-a factory ssh t -- ${AS_WORKER} factory worker poll 0`)

  const second = factory(['tick'], env)
  expect(JSON.parse(second.out).runs[0]).toMatchObject({ id: 'r1', node: 'done' })
  expect(called()).toContain('-a factory delete task t')
  expect(called()).toContain('-a factory delete workspace t')
  rmSync(join(home, 'runs', 'r1'), { recursive: true })
})

test('a tick on an AX-only rig still runs with no herdr installed (claude-factory-5h9.4)', () => {
  const seq = launched('r1h')
  const report = JSON.stringify({
    argv: ['report', 'r1h', String(seq), 'ready', 'built a'],
    from: 'a',
    at: 1,
  })
  cluster('Running', { status: 'idle', session: 's1', lines: [report] })

  // a path with no file at it: the same shape as a box that never installed herdr
  const first = factory(['tick'], { FACTORY_HERDR: join(dir, 'no-such-herdr') })
  expect(first.code).toBe(0)
  expect(JSON.parse(first.out).runs[0]).toMatchObject({ id: 'r1h', node: 'a', agent: 'idle', pane: 'ax://t' })
  rmSync(join(home, 'runs', 'r1h'), { recursive: true })
})

test('reap() closes a finished run\'s workspace through FACTORY_HERDR, not a literal "herdr" (claude-factory-5h9.12)', () => {
  const seq = launched('r1x')
  const report = JSON.stringify({
    argv: ['report', 'r1x', String(seq), 'ready', 'built a'],
    from: 'a',
    at: 1,
  })
  cluster('Running', { status: 'idle', session: 's1', lines: [report] })
  factory(['tick']) // 'a' goes idle: the report is replayed. A tick with a worker marker is refused since 3c4w (worker-control.test.ts)
  const second = factory(['tick']) // the station ends: the run is over
  expect(JSON.parse(second.out).runs[0]).toMatchObject({ id: 'r1x', node: 'done' })

  // This fake binary is herdr-shaped, but its name is not "herdr". A call to the literal
  // string `Bun.spawnSync(['herdr', ...])` finds nothing on PATH. It throws instead of
  // running. Its `pane list` answer names a pane in this finished run's own workspace and
  // worktree. launched() always uses ws 'w1' and worktree join(dir, 'wt'). reap() then has
  // one workspace to close. The test also sets a minimal PATH built from this box's own
  // bun/git/dirname/realpath (so it works on any OS), with no herdr in it. This proves the
  // fix calls FACTORY_HERDR. It rules out a PATH lookup of "herdr" that happens to succeed,
  // as it does on a box where herdr is installed.
  const worktree = join(dir, 'wt') // the fixed worktree launched() always uses
  const fakeHerdr = join(dir, 'fakeherdr')
  const herdrCalls = join(dir, 'herdr-calls.log')
  rmSync(herdrCalls, { force: true })
  writeFileSync(
    fakeHerdr,
    `#!/bin/sh
echo "$*" >> ${herdrCalls}
case "$1 $2" in
  "pane list") printf '{"result":{"panes":[{"pane_id":"p1","workspace_id":"w1","cwd":"${worktree}"}]}}\\n' ;;
  *) echo '{}' ;;
esac
`,
  )
  chmodSync(fakeHerdr, 0o755)
  const minBin = join(dir, 'minbin')
  mkdirSync(minBin, { recursive: true })
  // bin/factory's shebang needs dirname and realpath; cli.ts itself needs bun on PATH. Symlink
  // this box's own copies, so the test works on any OS, without picking up herdr from the same
  // directory those tools happen to live in.
  for (const bin of ['bun', 'git', 'dirname', 'realpath']) {
    const real = Bun.which(bin)
    if (real) Bun.spawnSync(['ln', '-sf', real, join(minBin, bin)])
  }
  expect(Bun.which('herdr', { PATH: minBin })).toBeNull()

  try {
    const third = factory(['tick'], { FACTORY_HERDR: fakeHerdr, PATH: minBin })
    expect(third.code).toBe(0) // a crash on the literal 'herdr' call would exit non-zero (or throw before exit)
    const herdrCallLog = existsSync(herdrCalls) ? readFileSync(herdrCalls, 'utf8') : ''
    expect(herdrCallLog).toContain('pane list')
    expect(herdrCallLog).toContain('workspace close w1')
  } finally {
    rmSync(join(home, 'runs', 'r1x'), { recursive: true, force: true })
  }
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
  expect(called()).toContain(`-a factory ssh t -- ${AS_WORKER} factory worker prompt ${text}`)
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
  expect(seenTotal('r3')).toBe(6) // a malformed line is refused and passed, not retried every tick
  expect(inbox('r3')).not.toContain('"outcome"')
  expect(inbox('r3')).toContain('"from":"a","to":"manager","text":"hi"') // not as the manager it claimed
  expect(called().match(/worker prompt/g)).toHaveLength(5) // each refusal told to the worker

  factory(['tick']) // the same outbox again: nothing already replayed re-runs or re-prompts
  expect(called().match(/worker prompt/g)).toHaveLength(5)
  rmSync(join(home, 'runs', 'r3'), { recursive: true })
})

test("a tick replays memory helped as the worker's station, and refuses a path outside the memory dir", () => {
  launched('r20')
  const memDir = join(home, 'memory')
  mkdirSync(join(memDir, 'topic'), { recursive: true })
  writeFileSync(join(memDir, 'topic', 'n.md'), '---\nsummary: s\n---\nbody\n')
  const usage = join(memDir, '.usage.jsonl')
  const line = (argv: string[]) => JSON.stringify({ argv, from: 'a', at: 1 })
  cluster('Running', {
    status: 'working',
    lines: [line(['memory', 'helped', '--from', 'forged/x', 'topic/n.md'])],
  })
  factory(['tick'])
  const rows = readFileSync(usage, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ path: 'topic/n.md', helped: 1, by: 'r20/a' })
  expect(called()).not.toContain('worker prompt')
  factory(['tick']) // nothing replays twice
  expect(readFileSync(usage, 'utf8').trim().split('\n')).toHaveLength(1)

  rmSync(usage)
  cluster('Running', {
    status: 'working',
    lines: [
      line(['memory', 'helped', '../../etc/passwd']),
      line(['memory', 'helped', '/etc/passwd']),
      line(['memory', 'helped', 'topic/missing.md']),
    ],
  })
  rmSync(join(home, 'runs', 'r20', 't.seen'))
  factory(['tick'])
  expect(existsSync(usage)).toBe(false)
  expect(called().match(/worker prompt/g)).toHaveLength(3) // each refusal told to the worker
  rmSync(join(home, 'runs', 'r20'), { recursive: true })
  rmSync(memDir, { recursive: true })
})

test('memory search --from logs shown with the run and station; without it, no by', () => {
  const memDir = join(home, 'memory')
  mkdirSync(join(memDir, 'topic'), { recursive: true })
  writeFileSync(
    join(memDir, 'topic', 'n.md'),
    '---\nsummary: bd init locks the shared Dolt server\n---\nbody\n',
  )
  const usage = join(memDir, '.usage.jsonl')
  const rows = () =>
    readFileSync(usage, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
  expect(factory(['memory', 'search', '--from', 'r1/plan', 'dolt lock']).code).toBe(0)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toMatchObject({ path: 'topic/n.md', shown: 1, by: 'r1/plan' })
  expect(factory(['memory', 'search', 'dolt lock']).code).toBe(0)
  expect(rows()[1].by).toBeUndefined()
  rmSync(memDir, { recursive: true })
}, 60_000)

test('a report appended after the worker deletes its already-replayed probes still replays (claude-factory-4x1)', () => {
  const seq = launched('r8')
  const probe1 = JSON.stringify({ argv: ['mail', 'r8', 'manager', 'probe one'], from: 'a', at: 1 })
  const probe2 = JSON.stringify({ argv: ['mail', 'r8', 'manager', 'probe two'], from: 'a', at: 2 })
  const report = JSON.stringify({ argv: ['report', 'r8', String(seq), 'ready', 'did it'], from: 'a', at: 3 })

  // tick 1: the outbox holds two probes; both replay
  clusterCursor('Running', 'idle', [probe1, probe2])
  factory(['tick'])
  expect(inbox('r8')).toContain('probe one')
  expect(inbox('r8')).toContain('probe two')

  // the worker deletes both probes with the Edit tool, then appends its real report: the outbox now holds
  // 1 line, not 3. A line-count cursor of 2 would put this line's index (0) below it and lose it forever
  clusterCursor('Running', 'idle', [report])
  factory(['tick'])
  expect(inbox('r8')).toContain('"outcome":"ready"')
  rmSync(join(home, 'runs', 'r8'), { recursive: true })
})

test('polling the same outbox twice replays nothing the second time (claude-factory-4x1)', () => {
  launched('r9')
  const mail = JSON.stringify({ argv: ['mail', 'r9', 'manager', 'hello'], from: 'a', at: 1 })
  clusterCursor('Running', 'idle', [mail])
  factory(['tick'])
  const once = inbox('r9')
  expect(once).toContain('hello')
  factory(['tick']) // the same outbox, unchanged: no new mail, no prompt either
  expect(inbox('r9')).toBe(once)
  expect(called().match(/worker prompt/g)).toBeNull()
  rmSync(join(home, 'runs', 'r9'), { recursive: true })
})

test('two identical outbox lines both replay, counted as a multiset like today (claude-factory-4x1)', () => {
  launched('r10')
  const mail = JSON.stringify({ argv: ['mail', 'r10', 'manager', 'dup'], from: 'a', at: 1 })
  clusterCursor('Running', 'idle', [mail, mail])
  factory(['tick'])
  expect(inbox('r10').match(/"text":"dup"/g)).toHaveLength(2)
  expect(seenTotal('r10')).toBe(2)
  rmSync(join(home, 'runs', 'r10'), { recursive: true })
})

test('a task mid-flight at upgrade (an old .cursor, no .seen yet) treats its first N lines as already replayed', () => {
  const seq = launched('r11')
  const probe = JSON.stringify({ argv: ['mail', 'r11', 'manager', 'old probe'], from: 'a', at: 1 })
  const report = JSON.stringify({ argv: ['report', 'r11', String(seq), 'ready', 'done'], from: 'a', at: 2 })
  // as a pre-upgrade laptop left it: 1 line already replayed, no .seen file written yet
  writeFileSync(join(home, 'runs', 'r11', 't.cursor'), '1')
  clusterCursor('Running', 'idle', [probe, report])
  factory(['tick'])
  expect(inbox('r11')).not.toContain('old probe') // already counted as replayed before the upgrade
  expect(inbox('r11')).toContain('"outcome":"ready"') // the rest replays once
  expect(seenTotal('r11')).toBe(2)
  rmSync(join(home, 'runs', 'r11'), { recursive: true })
})

test('lines already replayed going missing from the outbox are told once per increase, not every tick (claude-factory-4x1)', () => {
  launched('r12')
  const probe1 = JSON.stringify({ argv: ['mail', 'r12', 'manager', 'p1'], from: 'a', at: 1 })
  const probe2 = JSON.stringify({ argv: ['mail', 'r12', 'manager', 'p2'], from: 'a', at: 2 })
  const editedFile = join(home, 'runs', 'r12', 't.outbox-edited')

  clusterCursor('Running', 'idle', [probe1, probe2])
  factory(['tick']) // both replay; nothing missing yet
  expect(existsSync(editedFile)).toBe(false)

  clusterCursor('Running', 'idle', []) // the worker deletes both
  factory(['tick'])
  const marker = readFileSync(editedFile, 'utf8')
  expect(marker).toContain('missing 2 of 2 consumed lines')
  const promptsAfterFirstEdit = (called().match(/worker prompt/g) ?? []).length
  expect(promptsAfterFirstEdit).toBeGreaterThan(0) // the worker is told

  factory(['tick']) // the edit is unchanged since: no new marker line, no new prompt
  expect(readFileSync(editedFile, 'utf8')).toBe(marker)
  expect((called().match(/worker prompt/g) ?? []).length).toBe(promptsAfterFirstEdit)
  rmSync(join(home, 'runs', 'r12'), { recursive: true })
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
  expect(called()).toContain(`ssh t -- ${AS_WORKER} factory worker put brief.md 0 3 `)
  expect(called()).toContain(`ssh t -- ${AS_WORKER} factory worker put brief.md 2 3 `)
  expect(called()).toContain(`ssh t -- ${AS_WORKER} factory worker put beads.jsonl.gz 0 1 `)
  expect(JSON.parse(readFileSync(side, 'utf8')).put).toEqual([])
  cluster('Running', { status: 'working', lines: [] })
  factory(['tick'])
  expect(called()).not.toContain('worker put')
  rmSync(join(home, 'runs', 'r6'), { recursive: true })
})

test('a put that fails over ax ssh leaves the station pending inside its 5 min grace, then fails the attempt with the ax error', () => {
  launched('r7')
  const side = join(home, 'runs', 'r7', 't.json')
  writeFileSync(side, JSON.stringify({ ...JSON.parse(readFileSync(side, 'utf8')), put: ['brief.md'] }))
  writeFileSync(join(home, 'runs', 'r7', 't.brief.md'), 'hello')
  rmSync(calls, { force: true })
  writeFileSync(
    join(dir, 'ax'),
    `#!/bin/sh
echo "$*" >> ${calls}
case "$3 $4" in
  "get task") printf 'status:\\n  phase: Running\\n' ;;
  ssh*)
    case "$*" in
      *"worker put"*) echo 'EACCES: permission denied, mkdir /workspace/w/.factory-worker/put' >&2; exit 1 ;;
      *) cat ${dir}/ssh ;;
    esac
    ;;
esac
`,
  )
  chmodSync(join(dir, 'ax'), 0o755)
  writeFileSync(join(dir, 'ssh'), JSON.stringify({ status: 'working', lines: [] }))

  const first = factory(['tick'])
  const row1 = JSON.parse(first.out).runs.find((r: { id: string }) => r.id === 'r7')
  expect(row1).toMatchObject({ agent: 'pending' }) // inside the grace: the station is still working
  const afterFirst = JSON.parse(readFileSync(side, 'utf8'))
  expect(afterFirst.putError).toContain('EACCES')
  expect(afterFirst.put).toEqual(['brief.md']) // not cleared: the put never landed
  expect(typeof afterFirst.putFailedAt).toBe('number')

  // backdate the first failure past the 5 min grace, as if this had been failing a while
  writeFileSync(side, JSON.stringify({ ...afterFirst, putFailedAt: Date.now() - 6 * 60_000 }))
  const second = factory(['tick'])
  const row2 = JSON.parse(second.out).runs.find((r: { id: string }) => r.id === 'r7')
  expect(row2.agent).toBe('failed')
  expect(row2.error).toContain('EACCES')
  rmSync(join(home, 'runs', 'r7'), { recursive: true })
})

test('a task gone because serve exited fails the attempt with serve\'s log, not just "was closed"', () => {
  launched('r8')
  cluster('Running', {
    status: 'exited',
    log: 'serve died: Error: the laptop never sent brief.md',
    lines: [],
  })
  const out = factory(['tick'])
  const row = JSON.parse(out.out).runs.find((r: { id: string }) => r.id === 'r8')
  expect(row.agent).toBe('gone')
  expect(row.error).toContain('serve died: Error: the laptop never sent brief.md')
  expect(existsSync(join(home, 'runs', 'r8', 't.gone'))).toBe(true)
  rmSync(join(home, 'runs', 'r8'), { recursive: true })
})

test("a task's egress policy is tried again each tick until its actor shows, without waiting in the tick", () => {
  launched('r4', false)
  const kubectl = join(dir, 'kubectl')
  writeFileSync(
    kubectl,
    `#!/bin/sh\ncase "$*" in *"get deployment ax-controller"*) exec ${readyController()} "$@" ;; esac\necho "kubectl $*" >> ${calls}\n[ -f ${dir}/actor ]\n`,
  )
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

/** every prompt sent to the fake ax, decoded: the worker prompt argument is base64 */
const prompted = () =>
  called()
    .split('\n')
    .filter(l => l.includes('worker prompt '))
    .map(l => Buffer.from(l.split('worker prompt ')[1] ?? '', 'base64').toString())
    .join('\n')
/** a weekly-limit refusal with no quotaLimits (claude-factory-s6b8), whose reset is two days away, as serve prints it */
function weeklyRefusal() {
  const reset = new Date(Date.now() + 2 * 86_400_000)
  reset.setUTCHours(2, 0, 0, 0)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    reset.getUTCMonth()
  ]
  const text = `You've hit your weekly limit · resets ${mon} ${reset.getUTCDate()}, 2am (UTC)`
  const tail = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() + 1000).toISOString(),
    error: 'rate_limit',
    apiErrorStatus: 429,
    isApiErrorMessage: true,
    message: { content: [{ type: 'text', text }] },
  })
  return { tail, resetsAt: reset.getTime() }
}

test('a VM worker refused for a long usage limit parks the station until the reset, not nudged', () => {
  launched('r5')
  const { tail, resetsAt } = weeklyRefusal()
  cluster('Running', { status: 'idle', session: 's1', lines: [], tail })
  factory(['tick']) // learns the session
  factory(['tick'])
  const state = JSON.parse(readFileSync(join(home, 'runs', 'r5', 'state.json'), 'utf8'))
  expect(state.snapshot.value).toMatchObject({ a: 'waiting' })
  expect(state.snapshot.context.wakeAt).toBeGreaterThanOrEqual(resetsAt)
  expect(state.snapshot.context.attempt).toBe(1)
  const last = state.snapshot.context.log.at(-1)
  expect(last.outcome).toBe('outage')
  expect(last.summary).toStartWith('usage limit (seven_day)')
  expect(called()).not.toContain('worker prompt')
  expect(called()).toContain('delete')
  const held = (state.snapshot.context.mail.manager ?? []).filter((m: { text: string }) =>
    m.text.includes('held, not failed'),
  )
  expect(held).toHaveLength(1)
  expect(held[0].from).toBe('factory')
  rmSync(join(home, 'runs', 'r5'), { recursive: true })
})

test('a token swap that worked keeps the in-place wait, then the idle worker is nudged and the notice never makes it ask', () => {
  const runDir = join(home, 'runs', 'r6')
  const seq = launched('r6')
  const swap = join(dir, 'swap')
  writeFileSync(swap, `#!/bin/sh\necho x >> ${join(dir, 'swaps.log')}\necho 'slot 2 is live'\n`)
  chmodSync(swap, 0o755)
  rmSync(join(dir, 'swaps.log'), { force: true })
  const { tail } = weeklyRefusal()
  cluster('Running', { status: 'idle', session: 's1', lines: [], tail })
  const env = { FACTORY_AX_TOKEN_SWAP: swap }
  factory(['tick'], env) // learns the session
  const waited = factory(['tick'], env)
  expect(JSON.parse(waited.out).runs[0]).toMatchObject({ agent: 'usage limit' })
  factory(['tick'], env)
  expect(readFileSync(join(dir, 'swaps.log'), 'utf8')).toBe('x\n') // once per hit
  const mid = readFileSync(join(runDir, 'state.json'), 'utf8')
  expect(mid).not.toContain('"outcome":"outage"')
  expect(mid).not.toContain('"outcome":"fail"')
  const mail = (JSON.parse(mid).snapshot.context.mail.manager ?? []) as { from: string; text: string }[]
  expect(mail.filter(m => m.text.includes('slot 2 is live')).map(m => m.from)).toEqual(['factory'])
  expect(mail.filter(m => m.text.includes('usage limit')).map(m => m.from)).toEqual(['factory'])
  // the refresh window ends and the worker has sat idle: it is nudged, not suspended
  const old = Date.now() - 40 * 60_000
  const actor = createActor(compile(def), { snapshot: JSON.parse(mid).snapshot }).start()
  actor.send({ type: 'SPAWNED', seq, pane: 'ax://t', at: old })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  const swapFile = join(home, 'token-swap-ax.json')
  writeFileSync(
    swapFile,
    JSON.stringify({ ...JSON.parse(readFileSync(swapFile, 'utf8')), until: Date.now() - 1_000 }),
  )
  factory(['tick'], env)
  expect(prompted()).toContain('You have not reported')
  expect(called()).not.toContain('suspend')
  rmSync(runDir, { recursive: true })
  rmSync(join(home, 'token-swap-ax.json'), { force: true })
  rmSync(join(home, 'limit-paged-ax.json'), { force: true })
})

test('an idle VM worker with no limit hit is nudged, and the next tick delivers the manager mail', () => {
  const runDir = join(home, 'runs', 'r95')
  const seq = launched('r95')
  const old = Date.now() - 10 * 60_000
  const actor = createActor(compile(def), {
    snapshot: JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot,
  }).start()
  actor.send({ type: 'SPAWNED', seq, pane: 'ax://t', at: old })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  cluster('Running', { status: 'idle', session: 's1', lines: [] })
  factory(['tick'])
  factory(['mail', 'r95', 'a', 'please check the branch'], { FACTORY_FROM: 'manager' })
  factory(['tick'])
  expect(prompted()).toContain('You have not reported')
  expect(prompted()).toContain('[factory mail from manager]')
  rmSync(runDir, { recursive: true })
})

test('an egress outage mails the manager once, spends no idle nudge while serve retries, and fails named once it gives up', () => {
  launched('r7')
  const since = Date.now() - 120_000
  const egress = (tries: number) => ({
    since,
    tries,
    last: 'upstream connect error or disconnect/reset before headers: remote connection failure',
  })
  cluster('Running', { status: 'working', session: 's1', lines: [], egress: egress(1) })
  factory(['tick']) // learns the session, sees the outage: mails the manager once
  expect(called()).not.toContain('worker prompt')

  cluster('Running', { status: 'working', session: 's1', lines: [], egress: egress(2) }) // same outage (same since)
  factory(['tick'])
  expect(called()).not.toContain('worker prompt')
  const afterTwo = readFileSync(join(home, 'runs', 'r7', 'state.json'), 'utf8')
  const mails = afterTwo.match(/egress gateway is refusing/g) ?? []
  expect(mails).toHaveLength(1) // not a second mail for the same outage

  cluster('Running', { status: 'idle', session: 's1', lines: [], egress: egress(5) }) // serve gave up
  const failed = factory(['tick'])
  expect(JSON.parse(failed.out).runs[0]).toMatchObject({ id: 'r7' })
  expect(called()).not.toContain('worker prompt') // no nudge spent on a known cause
  const state = readFileSync(join(home, 'runs', 'r7', 'state.json'), 'utf8')
  expect(state).toContain('egress gateway: model API unreachable since')
  expect(state).toContain('(5 retries)')
  // held, not failed: the station waits and keeps its attempt
  const snap = JSON.parse(state).snapshot
  expect(snap.value).toMatchObject({ a: 'waiting' })
  expect(snap.context.attempt).toBe(1)
  expect(snap.context.log.at(-1)).toMatchObject({ outcome: 'outage', attempt: 1 })
  rmSync(join(home, 'runs', 'r7'), { recursive: true })
})

test('a VM worker stopped under an active usage limit page is held, not failed, once its nudges are spent', () => {
  const runDir = join(home, 'runs', 'r91')
  const seq = launched('r91')
  const old = Date.now() - 40 * 60_000
  const actor = createActor(compile(def), {
    snapshot: JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot,
  }).start()
  actor.send({ type: 'SPAWNED', seq, pane: 'ax://t', at: old })
  for (let i = 0; i < 4; i++) actor.send({ type: 'NUDGED', seq, at: old })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  const until = Date.now() + 2 * 3_600_000
  const page = join(home, 'limit-paged-ax.json')
  writeFileSync(page, JSON.stringify(until))
  cluster('Running', { status: 'idle', session: 's1', lines: [] })
  factory(['tick'])
  const snap = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot
  expect(snap.value).toMatchObject({ a: 'waiting' })
  expect(snap.context.wakeAt).toBeGreaterThanOrEqual(until)
  expect(snap.context.log.at(-1)).toMatchObject({
    outcome: 'outage',
    summary: 'worker stopped without reporting',
  })
  rmSync(runDir, { recursive: true })
  rmSync(page)
})

test("a worker's own fail report with the egress text spends an attempt: only the reconciler holds", () => {
  const seq = launched('r92')
  factory(['report', 'r92', String(seq), 'fail', 'egress gateway: model API unreachable since x'])
  factory(['tick'])
  const snap = JSON.parse(readFileSync(join(home, 'runs', 'r92', 'state.json'), 'utf8')).snapshot
  rmSync(join(home, 'runs', 'r92'), { recursive: true })
  expect(snap.context.log.at(-1)).toMatchObject({ outcome: 'fail' })
  expect(snap.context.attempt).toBe(1)
})

test('a single retry is pluralized in the egress FAIL reason, like the mail already is', () => {
  launched('r12')
  cluster('Running', {
    status: 'idle',
    session: 's1',
    lines: [],
    egress: {
      since: Date.now() - 1_000,
      tries: 1,
      last: 'upstream connect error or disconnect/reset before headers',
    },
  })
  factory(['tick'])
  const state = readFileSync(join(home, 'runs', 'r12', 'state.json'), 'utf8')
  expect(state).toContain('(1 retry)')
  expect(state).not.toContain('(1 retries)')
  rmSync(join(home, 'runs', 'r12'), { recursive: true })
})

test('two runs in the same egress outage each get their own mail, not a shared dedup file', () => {
  launched('r8', true, 't1')
  launched('r9', true, 't2')
  const egress = (since: number) => ({
    since,
    tries: 1,
    last: 'upstream connect error or disconnect/reset before headers: remote connection failure',
  })
  const pollByTask = {
    t1: { status: 'working', session: 's1', lines: [], egress: egress(Date.now() - 60_000) },
    t2: { status: 'working', session: 's2', lines: [], egress: egress(Date.now() - 30_000) },
  }
  clusterByTask('Running', pollByTask)
  factory(['tick']) // both outages are new: one mail each
  clusterByTask('Running', pollByTask) // unchanged: the same two outages, a second tick
  factory(['tick'])
  const mailsIn = (id: string) =>
    (readFileSync(join(home, 'runs', id, 'state.json'), 'utf8').match(/egress gateway is refusing/g) ?? [])
      .length
  expect(mailsIn('r8')).toBe(1) // not a second mail for the same outage
  expect(mailsIn('r9')).toBe(1) // r9's own outage, not blocked or duplicated by r8's
  rmSync(join(home, 'runs', 'r8'), { recursive: true })
  rmSync(join(home, 'runs', 'r9'), { recursive: true })
})

test('an egress outage suppresses the stall guard: standing still that long alone is not nudged or failed', () => {
  const seq = launched('r11')
  const tail = 'same output, never changes while serve retries the turn itself'
  const since = Date.now() - 60_000
  const poll = {
    status: 'working',
    session: 's1',
    lines: [],
    tail,
    egress: { since, tries: 1, last: 'upstream connect error or disconnect/reset before headers' },
  }
  cluster('Running', poll)
  factory(['tick']) // learns the session; an AX worker's tail is read from info.tail regardless (claude-factory-xq3)
  // the stall guard's own fingerprint: tail unchanged since long before STALL_MS (20 min), and already
  // nudged once, so with no egress this would fail on this very tick (see `stalled` in src/cli.ts).
  // progressSig(tail, '', undefined) with no head/bytes in this poll: same shape as the bare tail fingerprint
  const sig = `${tail.length}${tail.slice(-300)}`
  writeFileSync(
    join(home, 'runs', 'r11', 'progress.json'),
    JSON.stringify({ seq, sig, at: Date.now() - 41 * 60_000, nudged: true }),
  )
  cluster('Running', poll) // the same outage, still working, tail still unchanged
  factory(['tick'])
  expect(called()).not.toContain('worker prompt') // no nudge, no fail delivered to the worker
  const state = readFileSync(join(home, 'runs', 'r11', 'state.json'), 'utf8')
  expect(state).not.toContain('stalled: no output for')
  rmSync(join(home, 'runs', 'r11'), { recursive: true })
})

test('a committing AX worker is not called stalled even with an unchanging tail, since its VM repo head and live stream size move too (claude-factory-xq3)', () => {
  const seq = launched('r13')
  // one long agentic call: the tail a pre-xq3 laptop saw stayed this, unchanging, for the turn's whole length
  const tail = 'same output, mid-turn: the brief is one long call'
  cluster('Running', { status: 'working', session: 's1', lines: [], tail, head: 'sha1', bytes: 100 })
  factory(['tick']) // first sighting
  // back-date progress.json to simulate 41 min stood still on the CURRENT fingerprint shape (tail, head and
  // bytes all folded in) for the head/bytes this same poll reported, so the only thing that can reset `at` on
  // the next tick is head or bytes actually moving -- not a sig-format mismatch (claude-factory-xq3.5, PR #19
  // review finding 2: backdating with the old tail-only shape made the "not stalled" assertion pass even when
  // head/bytes stayed put, since the format change alone looked like progress)
  writeFileSync(
    join(home, 'runs', 'r13', 'progress.json'),
    JSON.stringify({ seq, sig: progressSig(tail, 'sha1', 100), at: Date.now() - 41 * 60_000, nudged: true }),
  )
  // the tail is still exactly the same, but the VM committed (head moved) and its live stream grew (bytes
  // moved) in between: the worker was never actually quiet
  cluster('Running', { status: 'working', session: 's1', lines: [], tail, head: 'sha2', bytes: 250 })
  factory(['tick'])
  expect(called()).not.toContain('worker prompt') // no nudge delivered
  const state = readFileSync(join(home, 'runs', 'r13', 'state.json'), 'utf8')
  expect(state).not.toContain('stalled: no output for') // and not failed as stalled
  rmSync(join(home, 'runs', 'r13'), { recursive: true })
})

test('a committing AX worker IS called stalled when its tail, head and bytes all truly stand still that long (control for the test above)', () => {
  const seq = launched('r14')
  const tail = 'same output, mid-turn: the brief is one long call'
  cluster('Running', { status: 'working', session: 's1', lines: [], tail, head: 'sha1', bytes: 100 })
  factory(['tick']) // first sighting
  writeFileSync(
    join(home, 'runs', 'r14', 'progress.json'),
    JSON.stringify({ seq, sig: progressSig(tail, 'sha1', 100), at: Date.now() - 41 * 60_000, nudged: true }),
  )
  // tail, head and bytes are all exactly the same as the backdated poll: truly no progress for 41 min
  cluster('Running', { status: 'working', session: 's1', lines: [], tail, head: 'sha1', bytes: 100 })
  factory(['tick'])
  const state = readFileSync(join(home, 'runs', 'r14', 'state.json'), 'utf8')
  expect(state).toContain('stalled: no output for') // failed as stalled
  rmSync(join(home, 'runs', 'r14'), { recursive: true })
})

// claude-factory-9ff: reconcile()'s real FAIL/warn path must use timeoutOf()'s escalated deadline
// (75 min after a timeout fail), not only the plain timeoutMin (45 min). Each case below runs one real
// `factory tick` and reads its state.json back, like the stall tests above.
// Each run's seed already has a prior FAIL. Its own reason is 'no report within 45 min' (so
// afterTimeout() sees a real timeout entry). So a plain whole-file `toContain('no report within')`
// check would always pass, for the wrong reason. The log/mail checks below read the persisted context
// instead. They see only what the tested tick itself adds.
const ctxOf = (id: string) =>
  (JSON.parse(readFileSync(join(home, 'runs', id, 'state.json'), 'utf8')) as { snapshot: { context: any } })
    .snapshot.context

test('escalated, elapsed 50 min: under the escalated 75 min deadline, so not warned or failed (claude-factory-9ff)', () => {
  launchedAfterFail('r20', 'no report within 45 min', 50)
  cluster('Running', { status: 'working', session: 's1', lines: [], tail: 't' })
  expect(factory(['tick']).code).toBe(0)
  const ctx = ctxOf('r20')
  expect(ctx.log).toHaveLength(1) // no new fail past the seed
  expect(JSON.stringify(ctx.mail)).not.toContain('minutes are up')
  rmSync(join(home, 'runs', 'r20'), { recursive: true })
})

test('escalated, elapsed 80 min: past the escalated 75 min deadline, warned at 75, not failed (claude-factory-9ff)', () => {
  launchedAfterFail('r21', 'no report within 45 min', 80)
  cluster('Running', { status: 'working', session: 's1', lines: [], tail: 't' })
  expect(factory(['tick']).code).toBe(0)
  const ctx = ctxOf('r21')
  expect(ctx.log).toHaveLength(1) // warned, not failed: no new log entry
  expect(JSON.stringify(ctx.mail)).toContain('75 minutes are up')
  rmSync(join(home, 'runs', 'r21'), { recursive: true })
})

test('escalated, elapsed 115 min: past 1.5x the escalated 75 min deadline, failed at 75 (claude-factory-9ff)', () => {
  launchedAfterFail('r22', 'no report within 45 min', 115)
  cluster('Running', { status: 'working', session: 's1', lines: [], tail: 't' })
  expect(factory(['tick']).code).toBe(0)
  const ctx = ctxOf('r22')
  expect(ctx.log).toHaveLength(2) // a new fail, past the seed
  expect(ctx.log.at(-1)).toMatchObject({ outcome: 'fail', summary: 'no report within 75 min' })
  rmSync(join(home, 'runs', 'r22'), { recursive: true })
})

test('control: a prior fail that is not a timeout keeps the plain 45 min deadline, warned at 45 at 50 min (claude-factory-9ff)', () => {
  launchedAfterFail('r23', 'worker pane w1:p1 was closed', 50)
  cluster('Running', { status: 'working', session: 's1', lines: [], tail: 't' })
  expect(factory(['tick']).code).toBe(0)
  const state = readFileSync(join(home, 'runs', 'r23', 'state.json'), 'utf8')
  expect(state).toContain('45 minutes are up')
  rmSync(join(home, 'runs', 'r23'), { recursive: true })
})

test('status and show still list a run whose AX server is unreachable, naming it on that run', () => {
  launched('r30')
  writeFileSync(
    join(dir, 'ax'),
    `#!/bin/sh
echo 'dial tcp 127.0.0.1:8080: connect: connection refused' >&2
exit 1
`,
  )
  for (const args of [['status'], ['show', 'r30']]) {
    const r = factory(args)
    expect(r.code).toBe(0)
    expect(r.out).toContain('unreachable')
  }
  rmSync(join(home, 'runs', 'r30'), { recursive: true })
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
  expect(add('--runner', 'ax', '--agent', 'codex -m o3').err).toContain('FACTORY_AX_CODEX=1')
  expect(add('--runner', 'ax', '--mcp', join(dir, 'mcp.json')).err).toContain('--mcp does not reach')
  const ok = add(
    ...['--runner', 'ax', '--agent', 'pi', '--egress', 'api.openai.com=OPENAI'],
    ...['--egress', 'pypi.org,files.pythonhosted.org'],
  )
  expect(ok.code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({
    runner: 'ax',
    agent: 'pi',
    egress: [{ hosts: ['api.openai.com'], key: 'OPENAI' }, { hosts: ['pypi.org', 'files.pythonhosted.org'] }],
  })
})

test('rig add --egress warns, but still adds, when a host is a package registry a pkg-gate would strip', () => {
  const r = repo()
  const add = (...a: string[]) => factory(['rig', 'add', 'x', r, ...a])
  const warned = add('--runner', 'ax', '--egress', 'pypi.org,api.openai.com=OPENAI')
  expect(warned.code).toBe(0)
  expect(warned.err).toContain('pypi.org is a package registry host')
  expect(warned.err).not.toContain('api.openai.com is a package registry host')
  const clean = add('--runner', 'ax', '--egress', 'api.openai.com=OPENAI')
  expect(clean.code).toBe(0)
  expect(clean.err).not.toContain('package registry host')
})

test('rig add --egress warns on a mixed-case registry host too, since parseEgress accepts any case (ei0.16)', () => {
  const r = repo()
  const warned = factory([
    'rig',
    'add',
    'x',
    r,
    '--runner',
    'ax',
    '--egress',
    'PyPI.org,api.openai.com=OPENAI',
  ])
  expect(warned.code).toBe(0)
  expect(warned.err).toContain('PyPI.org is a package registry host')
})

// claude-factory-25z.2: a rig's personOnlyContexts, repeatable --person-only-context, validated and
// stored; defineRig refuses a comma or space in the value, so a worker can never comma-split one into many
test('rig add --person-only-context stores Rig.personOnlyContexts; a bad value fails with a usage error', () => {
  const r = repo()
  const add = (...a: string[]) => factory(['rig', 'add', 'x', r, ...a])
  expect(add('--person-only-context', 'acme').code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({
    personOnlyContexts: ['acme'],
  })
  const two = add('--person-only-context', 'acme', '--person-only-context', 'other')
  expect(two.code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({
    personOnlyContexts: ['acme', 'other'],
  })
  const comma = add('--person-only-context', 'acme,other')
  expect(comma.code).not.toBe(0)
  expect(comma.err).toContain('--person-only-context is a kube context name')
  const space = add('--person-only-context', 'acme other')
  expect(space.code).not.toBe(0)
  expect(space.err).toContain('--person-only-context is a kube context name')
})

// claude-factory-zl5.4: a rig's protectedBranches, repeatable --protected-branch, validated and stored;
// defineRig refuses a comma or space in the value, so a worker can never comma-split one into many
test('rig add --protected-branch stores Rig.protectedBranches; a bad value fails with a usage error', () => {
  const r = repo()
  const add = (...a: string[]) => factory(['rig', 'add', 'x', r, ...a])
  expect(add('--protected-branch', 'acme-deploy').code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({
    protectedBranches: ['acme-deploy'],
  })
  const two = add('--protected-branch', 'acme-deploy', '--protected-branch', 'release')
  expect(two.code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]).toMatchObject({
    protectedBranches: ['acme-deploy', 'release'],
  })
  const comma = add('--protected-branch', 'acme-deploy,release')
  expect(comma.code).not.toBe(0)
  expect(comma.err).toContain('--protected-branch is a branch name')
  const space = add('--protected-branch', 'acme-deploy release')
  expect(space.code).not.toBe(0)
  expect(space.err).toContain('--protected-branch is a branch name')
})

test('rig add --linear writes team UUIDs to rigs.json, refuses a non-UUID naming it, and omits the key when absent', () => {
  const r = repo()
  const id1 = '04114abf-ddb7-4a6f-bb47-814fd2c44373'
  const id2 = '11111111-2222-3333-4444-555555555555'
  const before = existsSync(join(home, 'rigs.json'))
    ? readFileSync(join(home, 'rigs.json'), 'utf8')
    : undefined
  const bad = factory(['rig', 'add', 'x', r, '--linear', 'not-a-uuid'])
  expect(bad.code).not.toBe(0)
  expect(bad.err).toContain('"not-a-uuid"')
  expect(
    existsSync(join(home, 'rigs.json')) ? readFileSync(join(home, 'rigs.json'), 'utf8') : undefined,
  ).toBe(before)
  const ok = factory(['rig', 'add', 'x', r, '--linear', `${id1},${id2}`])
  expect(ok.code).toBe(0)
  const rigged = JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8')).find(
    (x: { name: string }) => x.name === 'x',
  )
  expect(rigged).toMatchObject({ linear: { team: [id1, id2] } })
  const list = factory(['rig', 'list'])
  expect(list.out).toContain(`linear: team ${id1},${id2}`)

  // redefining the rig with no --linear drops the field: `rig add` replaces, it never merges
  const plain = factory(['rig', 'add', 'x', r])
  expect(plain.code).toBe(0)
  const replaced = JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8')).find(
    (x: { name: string }) => x.name === 'x',
  )
  expect(replaced.linear).toBeUndefined()
})

test("inside a VM Claude keeps the worker's tools and prompt but none of the laptop's settings", () => {
  const flags = vmClaudeFlags({ maxContextK: 150 })
  expect(flags.slice(0, 4)).toEqual([
    '--tools',
    expect.stringContaining('Bash,Read,Edit'),
    '--setting-sources',
    'project,local',
  ])
  expect(flags[1]!.split(',')).toContain('Skill') // mv9: so it can load the asd-ste100 skill
  const settings = JSON.parse(flags[flags.indexOf('--settings') + 1]!)
  expect(settings).toEqual({
    autoMemoryEnabled: false,
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_ENV_FILE: '/opt/factory/src/worker-shell-env.sh' },
    skipDangerousModePermissionPrompt: true,
    autoCompactWindow: 300_000,
    disableBundledSkills: true, // mv9: Skill alone would add ~2.2k tokens/turn of bundled-skill listings
    // claude-factory-cr6: the same deny-rm-rf PreToolUse hook a laptop worker gets, run from the VM image
    hooks: {
      PreToolUse: [
        ...['Bash', 'Write|Edit|MultiEdit|NotebookEdit'].map(matcher => ({
          matcher,
          hooks: [
            {
              type: 'command',
              command: "'/usr/local/bin/bun' '/opt/factory/src/worker-hook.ts'",
              timeout: 10,
            },
          ],
        })),
      ],
    },
  })
  expect(flags[flags.indexOf('--system-prompt-file') + 1]).toBe('/opt/factory/src/worker-system.md')
  // claude-factory-fxu: the image's plugins, as a laptop worker gets the person's (constitution I)
  expect(flags.slice(-2)).toEqual(['--plugin-dir', '/opt/plugins/asd-ste100'])
})

// claude-factory-qda.4: a station with no skills gets no plugin dir
test('vmClaudeFlags passes a plugin dir for each skill of the station, and none for an empty set', () => {
  expect(
    vmClaudeFlags({ maxContextK: 150 }, undefined, undefined, undefined, ['asd-ste100']).slice(-2),
  ).toEqual(['--plugin-dir', '/opt/plugins/asd-ste100'])
  expect(vmClaudeFlags({ maxContextK: 150 }, undefined, undefined, undefined, [])).not.toContain(
    '--plugin-dir',
  )
})

// claude-factory-25z.2: vmClaudeFlags carries the rig's personOnlyContexts to the VM hook's own argv too
test("vmClaudeFlags carries a rig's personOnlyContexts on the deny hook's own argv", () => {
  const flags = vmClaudeFlags({ maxContextK: 150 }, ['acme'])
  const settings = JSON.parse(flags[flags.indexOf('--settings') + 1]!)
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
    "'/usr/local/bin/bun' '/opt/factory/src/worker-hook.ts' --person-only-contexts 'acme'",
  )
  expect(settings.hooks.PreToolUse[1].hooks[0].command).toBe(settings.hooks.PreToolUse[0].hooks[0].command)
  // no list: today's command, unchanged
  expect(vmClaudeFlags({ maxContextK: 150 })).toEqual(vmClaudeFlags({ maxContextK: 150 }, []))
})

// claude-factory-zl5.4: vmClaudeFlags carries the rig's protectedBranches to the VM hook's own argv too
test("vmClaudeFlags carries a rig's protectedBranches on the deny hook's own argv", () => {
  const flags = vmClaudeFlags({ maxContextK: 150 }, undefined, ['acme-deploy'])
  const settings = JSON.parse(flags[flags.indexOf('--settings') + 1]!)
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
    "'/usr/local/bin/bun' '/opt/factory/src/worker-hook.ts' --protected-branches 'acme-deploy'",
  )
  expect(settings.hooks.PreToolUse[1].hooks[0].command).toBe(settings.hooks.PreToolUse[0].hooks[0].command)
  // both lists together: person-only-contexts first, then protected-branches
  const both = vmClaudeFlags({ maxContextK: 150 }, ['ctx'], ['acme-deploy'])
  const bothSettings = JSON.parse(both[both.indexOf('--settings') + 1]!)
  expect(bothSettings.hooks.PreToolUse[0].hooks[0].command).toBe(
    "'/usr/local/bin/bun' '/opt/factory/src/worker-hook.ts' --person-only-contexts 'ctx' --protected-branches 'acme-deploy'",
  )
  // no list: today's command, unchanged
  expect(vmClaudeFlags({ maxContextK: 150 })).toEqual(vmClaudeFlags({ maxContextK: 150 }, [], []))
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

test('a replayed memory helped carries the run id in --from; other memory words are not replayable', () => {
  const side = { node: 'plan', seq: 1 }
  expect(replayable(['memory', 'helped', '--from', 'forged/x', 'p'], side, 'r1')).toEqual([
    'memory',
    'helped',
    'p',
    '--from',
    'r1/plan',
  ])
  expect(replayable(['memory', 'helped', 'p', '--from'], side, 'r1')).toEqual([
    'memory',
    'helped',
    'p',
    '--from',
    'r1/plan',
  ])
  for (const sub of ['search', 'compact', 'dream', 'confirmed'])
    expect(replayable(['memory', sub, 'x'], side, 'r1')).toBeNull()
})

test('inside a VM, memory helped queues; help and no path queue nothing', () => {
  mkdirSync(dir, { recursive: true })
  const outbox = join(dir, 'outbox-helped.jsonl')
  const env = { FACTORY_OUTBOX: outbox, FACTORY_FROM: 'a' }
  for (const args of [
    ['memory', 'helped', '--help'],
    ['memory', 'helped', '-h'],
  ]) {
    const r = factory(args, env)
    expect(r.code).toBe(0)
    expect(r.out).toContain('usage: factory memory helped')
  }
  for (const args of [
    ['memory', 'helped'],
    ['memory', 'helped', '--from', 'r/a'],
  ])
    expect(factory(args, env).code).toBe(1)
  expect(existsSync(outbox)).toBe(false)
  const r = factory(['memory', 'helped', '--from', 'x', 'topic/n.md'], env)
  expect(r.code).toBe(0)
  expect(r.out).toContain('queued for the factory')
  expect(JSON.parse(readFileSync(outbox, 'utf8').trim()).argv).toEqual([
    'memory',
    'helped',
    '--from',
    'x',
    'topic/n.md',
  ])
})

test('a replayed memory add carries the run id in --from', () => {
  const argv = ['memory', 'add', '--from', 'x', '--kind', 'fact', 's', 'b']
  expect(replayable(argv, { node: 'plan', seq: 1 }, 'r1')).toEqual([
    'memory',
    'add',
    '--kind',
    'fact',
    's',
    'b',
    '--from',
    'r1/plan',
  ])
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
      FACTORY_RUN: '',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(p.exitCode).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('dolt pull shared=0\ndolt push shared=0\n')
  expect(readFileSync(join(vm, 'outbox.jsonl'), 'utf8')).toContain('"report"')
  // no conflict happened, so no "your version was kept" notice prints
  expect(p.stderr.toString()).not.toContain('your version was kept')

  // a push that never goes through refuses the report: queued, it would end the VM with the writes in it.
  // the refusal names the failed step and bd's own last error line, with its URL redacted, and tells the
  // worker to mail the manager instead of looping on it alone
  rmSync(join(vm, 'outbox.jsonl'))
  writeFileSync(
    join(vm, 'bd'),
    `#!/bin/sh\n[ "$2" = push ] && { echo "push to https://dolt.example.com:50051/app_beads: connection refused" >&2; exit 1; }\nexit 0\n`,
  )
  const refused = Bun.spawnSync([CLI, 'report', 'r1', '1', 'ready', 'done'], {
    env: {
      ...process.env,
      FACTORY_OUTBOX: join(vm, 'outbox.jsonl'),
      FACTORY_FROM: 'a',
      FACTORY_RUN: '',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(refused.exitCode).toBe(1)
  const pushErr = refused.stderr.toString()
  expect(pushErr).toContain('bd dolt push failed')
  expect(pushErr).toContain('connection refused')
  expect(pushErr).toContain('factory mail')
  expect(pushErr).not.toContain('dolt.example.com')
  expect(existsSync(join(vm, 'outbox.jsonl'))).toBe(false)

  // a pull that fails both plain and with --strategy ours (some other error, not a conflict) refuses too,
  // naming 'pull' as the failed step
  rmSync(join(vm, 'outbox.jsonl'), { force: true })
  writeFileSync(
    join(vm, 'bd'),
    `#!/bin/sh\n[ "$2" = pull ] && { echo "pull from https://dolt.example.com:50051/app_beads: i/o timeout" >&2; exit 1; }\nexit 0\n`,
  )
  const refusedPull = Bun.spawnSync([CLI, 'report', 'r1', '1', 'ready', 'done'], {
    env: {
      ...process.env,
      FACTORY_OUTBOX: join(vm, 'outbox.jsonl'),
      FACTORY_FROM: 'a',
      FACTORY_RUN: '',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(refusedPull.exitCode).toBe(1)
  const pullErr = refusedPull.stderr.toString()
  expect(pullErr).toContain('bd dolt pull failed')
  expect(pullErr).toContain('i/o timeout')
  expect(pullErr).toContain('factory mail')
  expect(pullErr).not.toContain('dolt.example.com')
  expect(existsSync(join(vm, 'outbox.jsonl'))).toBe(false)
})

test('a conflicted pull retries with --strategy ours (the VM keeps its own writes) and the report goes through', () => {
  const vm = join(dir, 'vm-conflict')
  mkdirSync(vm, { recursive: true })
  const log = join(vm, 'bd.log')
  writeFileSync(
    join(vm, 'bd'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${log}`,
      '[ "$1 $2" = "dolt pull" ] && [ "$3" != "--strategy" ] && {',
      '  echo "Error: merge origin/main: merge conflicts in dependencies require operator resolution; merge aborted and working set restored" >&2',
      '  exit 1',
      '}',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(join(vm, 'bd'), 0o755)
  const p = Bun.spawnSync([CLI, 'report', 'r1', '1', 'ready', 'done'], {
    env: {
      ...process.env,
      FACTORY_OUTBOX: join(vm, 'outbox.jsonl'),
      FACTORY_FROM: 'a',
      FACTORY_RUN: '',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(p.exitCode).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('dolt pull\ndolt pull --strategy ours\ndolt push\n')
  expect(readFileSync(join(vm, 'outbox.jsonl'), 'utf8')).toContain('"report"')
  expect(p.stderr.toString()).toContain(
    'bd sync: your bd changes and upstream changed the same rows; your version was kept',
  )
})

test('a plain pull failing for a reason other than a conflict, that the --strategy ours retry still clears, prints no conflict notice', () => {
  const vm = join(dir, 'vm-nonconflict')
  mkdirSync(vm, { recursive: true })
  const log = join(vm, 'bd.log')
  writeFileSync(
    join(vm, 'bd'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${log}`,
      '[ "$1 $2" = "dolt pull" ] && [ "$3" != "--strategy" ] && {',
      '  echo "Error: transient i/o timeout" >&2',
      '  exit 1',
      '}',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(join(vm, 'bd'), 0o755)
  const p = Bun.spawnSync([CLI, 'report', 'r1', '1', 'ready', 'done'], {
    env: {
      ...process.env,
      FACTORY_OUTBOX: join(vm, 'outbox.jsonl'),
      FACTORY_FROM: 'a',
      FACTORY_RUN: '',
      FACTORY_BD: join(vm, 'bd'),
      BEADS_DIR: join(vm, '.beads'),
      FACTORY_HOME: join(vm, 'nohome'),
    },
  })
  expect(p.exitCode).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('dolt pull\ndolt pull --strategy ours\ndolt push\n')
  expect(p.stderr.toString()).not.toContain('your version was kept')
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
  const out = factory(['tick'], { FACTORY_AX_IMAGE: 'img', FACTORY_KUBECTL: readyController() }).out
  const row = JSON.parse(out).runs.find((r: { id: string }) => r.id === 'r4')
  expect(row.error).toBeNull()
  expect(sh(worktree, 'git', 'log', '--format=%s')).toBe('work\nplan\nbase') // its plan once, as the VM wrote it
  expect(sh(worktree, 'git', 'status', '--short')).toBe('') // the export the stash could not put back is the worker's
  expect(called()).toContain('apply -f -')
  rmSync(runDir, { recursive: true })
}, 30_000) // git clones and a whole tick

test("a launch stores the origin's GitHub owner in the side file and sends the matching policy keys", () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
    return p.stdout.toString().trim()
  }
  mkdirSync(dir, { recursive: true })
  const sent = join(dir, 'launch-policy-sent')
  const kubectl = join(dir, 'capture-launch-create')
  writeFileSync(
    kubectl,
    `#!/bin/sh\ncase "$*" in *create*) cat > ${sent} ;; *) exec ${readyController()} "$@" ;; esac\n`,
  )
  chmodSync(kubectl, 0o755)
  const cases = [
    ['r5a', 'github.com/zach-source/widget.git', 'zach-source', ['GITHUB_ZS', 'GITHUB_ZS_BASIC']],
    ['r5b', 'github.com/acme/widget.git', 'acme', ['GITHUB', 'GITHUB_BASIC']],
    ['r5c', 'gitlab.example.com/acme/widget.git', undefined, ['GITHUB', 'GITHUB_BASIC']],
  ] as const
  for (const [id, path, owner, keys] of cases) {
    rmSync(sent, { force: true })
    const origin = join(dir, id, path)
    const worktree = join(dir, id, 'wt')
    mkdirSync(join(dir, id), { recursive: true })
    sh(dir, 'git', 'init', '-q', '--bare', origin)
    sh(dir, 'git', 'clone', '-q', origin, worktree)
    writeFileSync(join(worktree, 'a'), 'a\n')
    sh(worktree, 'git', 'add', '.')
    sh(worktree, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    sh(worktree, 'git', 'push', '-q', 'origin', `HEAD:refs/heads/factory/${id}`)
    const runDir = join(home, 'runs', id)
    mkdirSync(join(runDir, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'dream.stamp'), '')
    writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(def)}`)
    const run = { id, factory: join(runDir, 'factory.ts'), repo: worktree, goal: 'g', ws: 'w1', worktree }
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...run, branch: `factory/${id}` }))
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
    const out = factory(['tick'], {
      FACTORY_AX_IMAGE: 'img',
      FACTORY_KUBECTL: kubectl,
      FACTORY_AX_VAULT: 'factory',
    }).out
    expect(JSON.parse(out).runs.find((r: { id: string }) => r.id === id).error).toBeNull()
    const sideName = readdirSync(runDir).find(f => /^f-.*\.json$/.test(f))!
    const side = JSON.parse(readFileSync(join(runDir, sideName), 'utf8'))
    expect(side.githubOwner).toBe(owner)
    const sentKeys = JSON.parse(readFileSync(sent, 'utf8'))
      .rules.slice(1, 3)
      .map((r: any) => r.https.effects.replaceHeaders[0].credentialUri.split('/').at(-1))
    expect(sentKeys).toEqual(keys as unknown as string[])
    rmSync(runDir, { recursive: true })
  }
}, 60_000) // git clones and whole ticks

test('an ax brief says AWS is read-only once, only when the rig env holds the broker URI (claude-factory-5n22)', () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
  }
  mkdirSync(dir, { recursive: true })
  for (const [id, env] of [
    ['aws1a', { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'https://broker.example/creds' }],
    ['aws1b', {}],
  ] as const) {
    const origin = join(dir, id, 'origin.git')
    const worktree = join(dir, id, 'wt')
    mkdirSync(join(dir, id), { recursive: true })
    sh(dir, 'git', 'init', '-q', '--bare', origin)
    sh(dir, 'git', 'clone', '-q', origin, worktree)
    writeFileSync(join(worktree, 'a'), 'a\n')
    sh(worktree, 'git', 'add', '.')
    sh(worktree, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    sh(worktree, 'git', 'push', '-q', 'origin', `HEAD:refs/heads/factory/${id}`)
    const runDir = join(home, 'runs', id)
    mkdirSync(join(runDir, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'dream.stamp'), '')
    writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(def)}`)
    const run = {
      id,
      factory: join(runDir, 'factory.ts'),
      repo: worktree,
      goal: 'read aws',
      ws: 'w1',
      worktree,
    }
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...run, branch: `factory/${id}` }))
    const actor = createActor(compile(def)).start()
    actor.send({ type: 'TICK', at: Date.now() })
    writeFileSync(
      join(runDir, 'state.json'),
      JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
    )
    writeFileSync(
      join(home, 'rigs.json'),
      JSON.stringify([{ name: 'x', repo: worktree, factory: 'one', runner: 'ax', env }]),
    )
    cluster('Running', { status: 'idle', lines: [] })
    const out = factory(['tick'], { FACTORY_AX_IMAGE: 'img' }).out
    expect(JSON.parse(out).runs.find((r: { id: string }) => r.id === id).error).toBeNull()
    const brief = readFileSync(
      join(
        runDir,
        readdirSync(runDir).find(f => f.endsWith('.brief.md'))!,
      ),
      'utf8',
    )
    if (id === 'aws1a') {
      expect(brief.split('- AWS reads work:').length - 1).toBe(1)
      expect(brief).toContain('Every write, and every secret read')
    } else expect(brief).not.toContain('AWS_CONTAINER_CREDENTIALS_FULL_URI')
    rmSync(runDir, { recursive: true })
  }
}, 60_000)

test('an ax launch searches the laptop memory once and puts the top notes in the brief', () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
  }
  mkdirSync(dir, { recursive: true })
  const memDir = join(home, 'memory')
  for (const [id, withNote] of [
    ['r21a', true],
    ['r21b', false],
  ] as const) {
    rmSync(memDir, { recursive: true, force: true })
    if (withNote) {
      mkdirSync(join(memDir, 'topic'), { recursive: true })
      writeFileSync(
        join(memDir, 'topic', 'n.md'),
        '---\nsummary: bd init locks the shared Dolt server\n---\nbody\n',
      )
    }
    const origin = join(dir, id, 'origin.git')
    const worktree = join(dir, id, 'wt')
    mkdirSync(join(dir, id), { recursive: true })
    sh(dir, 'git', 'init', '-q', '--bare', origin)
    sh(dir, 'git', 'clone', '-q', origin, worktree)
    writeFileSync(join(worktree, 'a'), 'a\n')
    sh(worktree, 'git', 'add', '.')
    sh(worktree, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    sh(worktree, 'git', 'push', '-q', 'origin', `HEAD:refs/heads/factory/${id}`)
    const runDir = join(home, 'runs', id)
    mkdirSync(join(runDir, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'dream.stamp'), '')
    writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(def)}`)
    const run = {
      id,
      factory: join(runDir, 'factory.ts'),
      repo: worktree,
      goal: 'fix the dolt lock',
      ws: 'w1',
      worktree,
    }
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...run, branch: `factory/${id}` }))
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
    const out = factory(['tick'], { FACTORY_AX_IMAGE: 'img' }).out
    expect(JSON.parse(out).runs.find((r: { id: string }) => r.id === id).error).toBeNull()
    const briefFile = readdirSync(runDir).find(f => f.endsWith('.brief.md'))!
    const brief = readFileSync(join(runDir, briefFile), 'utf8')
    const usage = join(memDir, '.usage.jsonl')
    if (withNote) {
      expect(brief).toContain('The factory already searched for your goal and station')
      expect(brief).toContain('bd init locks the shared Dolt server')
      expect(brief).toContain(join(memDir, 'topic', 'n.md'))
      const rows = readFileSync(usage, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      expect(rows).toHaveLength(1) // one launch, one shown line, not one per read of the brief
      expect(rows[0]).toMatchObject({ path: 'topic/n.md', shown: 1, by: `${id}/a` })
    } else {
      expect(brief).not.toContain('already searched')
      expect(existsSync(usage)).toBe(false)
    }
    rmSync(runDir, { recursive: true })
  }
  rmSync(memDir, { recursive: true, force: true })
}, 60_000) // git clones and whole ticks

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

// A controller outage must not spend station attempts on workers that cannot exist.
test('unavailable AX holds an expired Pending task and refuses retry without changing its budget', () => {
  const id = 'ax-unavailable'
  const seq = launchedAfterFail(id, 'old failure', 120)
  cluster('Pending', { status: 'idle', lines: [] })
  const kubectl = join(dir, 'unavailable-kubectl')
  writeFileSync(
    kubectl,
    `#!/bin/sh\nprintf '%s' '{"metadata":{"generation":3},"spec":{"replicas":1},"status":{"observedGeneration":3,"readyReplicas":0,"availableReplicas":0}}'\n`,
  )
  chmodSync(kubectl, 0o755)
  const env = { FACTORY_KUBECTL: kubectl }
  const state = () => JSON.parse(readFileSync(join(home, 'runs', id, 'state.json'), 'utf8')).snapshot.context
  const before = state()
  const first = JSON.parse(factory(['tick'], env).out)
  const row = first.runs.find((r: { id: string }) => r.id === id)
  expect(row.agent).toBe('AX executor unavailable')
  expect(state()).toMatchObject({ seq, attempt: before.attempt, budget: before.budget, pane: 'ax://t' })
  expect(state().log).toEqual(before.log)
  expect(first.manager.filter((m: { run: string }) => m.run === id)).toHaveLength(1)
  const second = JSON.parse(factory(['tick'], env).out)
  expect(second.manager.filter((m: { run: string }) => m.run === id)).toHaveLength(0)
  const notStuck = factory(['retry', id], env)
  expect(notStuck.code).toBe(1)
  expect(notStuck.err).toContain(`${id} is at a/working, not stuck`)
  expect(notStuck.err).toContain(`goto ${id} a`)
  expect(existsSync(join(home, 'runs', id, 'inbox.jsonl'))).toBe(false)
  const statePath = join(home, 'runs', id, 'state.json')
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  saved.snapshot.value = { a: 'stuck' }
  writeFileSync(statePath, JSON.stringify(saved))
  const retry = factory(['retry', id], env)
  expect(retry.code).toBe(1)
  expect(retry.err).toContain('AX executor unavailable')
  expect(existsSync(join(home, 'runs', id, 'inbox.jsonl'))).toBe(false)
  expect(called()).not.toContain('delete')
  expect(called()).not.toContain('apply')
  cluster('Running', { status: 'idle', lines: [] })
  const recovered = factory(['retry', id], { FACTORY_KUBECTL: readyController() })
  expect(recovered.code).toBe(0)
  expect(inbox(id)).toContain('"type":"RETRY"')
  rmSync(join(home, 'runs', id), { recursive: true })
})

test('unavailable AX prevents a fresh launch before git, Beads sync or AX apply', () => {
  const id = 'ax-no-launch'
  launched(id)
  const path = join(home, 'runs', id, 'state.json')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  saved.snapshot.context.pane = null
  writeFileSync(path, JSON.stringify(saved))
  writeFileSync(
    join(home, 'runs', id, 'factory.ts'),
    `export default ${JSON.stringify({ ...def, nodes: { a: { ...def.nodes.a, runner: 'ax' } } })}`,
  )
  const kubectl = join(dir, 'unknown-controller')
  writeFileSync(kubectl, '#!/bin/sh\nexit 1\n')
  chmodSync(kubectl, 0o755)
  cluster('Pending', {})
  const output = JSON.parse(factory(['tick'], { FACTORY_KUBECTL: kubectl }).out)
  expect(output.runs.find((r: { id: string }) => r.id === id).agent).toBe('AX executor unavailable')
  const context = JSON.parse(readFileSync(path, 'utf8')).snapshot.context
  expect(context).toMatchObject({
    pane: null,
    seq: saved.snapshot.context.seq,
    budget: saved.snapshot.context.budget,
  })
  expect(existsSync(join(home, 'runs', id, 'prompts'))).toBe(false)
  expect(called()).not.toContain('apply')
  expect(called()).not.toContain('delete')
  rmSync(join(home, 'runs', id), { recursive: true })
})

// A deadline on a worker that never started must name the cause, not say "no report".
describe('an AX worker that never started', () => {
  const ctxOf = (id: string) =>
    JSON.parse(readFileSync(join(home, 'runs', id, 'state.json'), 'utf8')).snapshot.context
  const lastFail = (id: string): string =>
    ctxOf(id)
      .log.filter((e: { outcome: string }) => e.outcome === 'fail')
      .at(-1)?.summary ?? ''
  const setSide = (id: string, patch: object) => {
    const side = join(home, 'runs', id, 't.json')
    writeFileSync(side, JSON.stringify({ ...JSON.parse(readFileSync(side, 'utf8')), ...patch }))
  }
  const refuseCreate = () => {
    const kubectl = join(dir, 'refuse-create')
    writeFileSync(
      kubectl,
      `#!/bin/sh\ncase "$*" in *"get deployment ax-controller"*) exec ${readyController()} "$@" ;; esac\nexit 1\n`,
    )
    chmodSync(kubectl, 0o755)
    return kubectl
  }

  test('a task still in phase Pending past the deadline fails naming the phase, with no TIME_UP mail', () => {
    const id = 'nostart-phase'
    launchedAfterFail(id, 'old failure', 50)
    cluster('Pending', { status: 'idle', lines: [] })
    factory(['tick'])
    expect(lastFail(id)).toBe('worker never started on AX after 45 min: task phase Pending')
    expect(JSON.stringify(ctxOf(id).mail)).not.toContain('minutes are up')
    rmSync(join(home, 'runs', id), { recursive: true })
  })

  test('a Running task whose egress policy is refused fails naming the policy', () => {
    const id = 'nostart-policy'
    launchedAfterFail(id, 'old failure', 120)
    setSide(id, { policy: false, egress: [], gitlabHost: 'gitlab.example' })
    cluster('Running', { status: 'working', lines: [] })
    factory(['tick'], { FACTORY_KUBECTL: refuseCreate() })
    expect(lastFail(id)).toBe('worker never started on AX after 45 min: egress policy not created')
    rmSync(join(home, 'runs', id), { recursive: true })
  })

  test('a retried policy uses the reviewer key only when the side file says reviewer (claude-factory-0gww.2)', () => {
    const sent = join(dir, 'rv-retry-sent')
    const kubectl = join(dir, 'capture-rv-retry')
    for (const [id, reviewer] of [
      ['rvretry-yes', true],
      ['rvretry-old', undefined],
    ] as const) {
      launchedAfterFail(id, 'old failure', 120)
      writeFileSync(
        kubectl,
        `#!/bin/sh\ncase "$*" in *"get deployment ax-controller"*) exec ${readyController()} "$@" ;; esac\ncat > ${sent}\n`,
      )
      chmodSync(kubectl, 0o755)
      cluster('Running', { status: 'working', lines: [] })
      setSide(id, { policy: false, egress: [], githubOwner: 'acme', ...(reviewer && { reviewer }) })
      factory(['tick'], { FACTORY_KUBECTL: kubectl, FACTORY_AX_VAULT: 'factory' })
      expect(readFileSync(sent, 'utf8').includes('GITHUB_REVIEWER')).toBe(!!reviewer)
      rmSync(join(home, 'runs', id), { recursive: true })
    }
  })

  test("a retried egress policy keeps the task's GitHub owner, so a zach-source rig keeps its keys", () => {
    const sent = join(dir, 'policy-sent')
    const kubectl = join(dir, 'capture-create')
    const keysOf = () =>
      JSON.parse(readFileSync(sent, 'utf8'))
        .rules.slice(1, 3)
        .map((r: any) => r.https.effects.replaceHeaders[0].credentialUri.split('/').at(-1))
    for (const [id, owner, keys] of [
      ['nostart-owner-zs', 'zach-source', ['GITHUB_ZS', 'GITHUB_ZS_BASIC']],
      ['nostart-owner-none', undefined, ['GITHUB', 'GITHUB_BASIC']],
    ] as const) {
      launchedAfterFail(id, 'old failure', 120)
      writeFileSync(
        kubectl,
        `#!/bin/sh\ncase "$*" in *"get deployment ax-controller"*) exec ${readyController()} "$@" ;; esac\ncat > ${sent}\n`,
      )
      chmodSync(kubectl, 0o755)
      cluster('Running', { status: 'working', lines: [] })
      setSide(id, { policy: false, egress: [], githubOwner: owner })
      factory(['tick'], { FACTORY_KUBECTL: kubectl, FACTORY_AX_VAULT: 'factory' })
      expect(keysOf()).toEqual(keys as unknown as string[])
      rmSync(join(home, 'runs', id), { recursive: true })
    }
  })

  test('a Running task whose brief.md is not yet put fails naming the brief', () => {
    const id = 'nostart-brief'
    launchedAfterFail(id, 'old failure', 120)
    setSide(id, { put: ['brief.md'] })
    writeFileSync(join(home, 'runs', id, 't.brief.md'), 'hello')
    writeFileSync(
      join(dir, 'ax'),
      `#!/bin/sh
case "$3 $4" in
  "get task") printf 'status:\\n  phase: Running\\n' ;;
  ssh*) echo 'no route' >&2; exit 1 ;;
esac
`,
    )
    chmodSync(join(dir, 'ax'), 0o755)
    factory(['tick'])
    expect(lastFail(id)).toBe('worker never started on AX after 45 min: brief.md not yet copied to the VM')
    rmSync(join(home, 'runs', id), { recursive: true })
  })

  test('a started worker that is idle past the deadline still fails "no report"', () => {
    const id = 'nostart-control'
    launchedAfterFail(id, 'old failure', 120)
    cluster('Running', { status: 'idle', lines: [] })
    factory(['tick'])
    expect(lastFail(id)).toBe('no report within 45 min')
    rmSync(join(home, 'runs', id), { recursive: true })
  })
})

// claude-factory-l3tl: --merge-authority is the only way to set Rig.mergeAuthority; a redefine clears it
test('rig add --merge-authority stores Rig.mergeAuthority; a rig add without it clears it; rig lists it', () => {
  const r = repo()
  const stored = () => JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0]
  expect(factory(['rig', 'add', 'x', r]).code).toBe(0)
  expect(stored()).not.toHaveProperty('mergeAuthority')
  expect(factory(['rig', 'add', 'x', r, '--protected-branch', 'acme-deploy']).code).toBe(0)
  expect(stored()).not.toHaveProperty('mergeAuthority')
  expect(factory(['rig']).out).not.toContain('merge authority')
  expect(factory(['rig', 'add', 'x', r, '--merge-authority']).code).toBe(0)
  expect(stored().mergeAuthority).toBe(true)
  expect(factory(['rig']).out).toContain('merge authority: ship release station')
  expect(factory(['rig', 'add', 'x', r]).code).toBe(0)
  expect(stored()).not.toHaveProperty('mergeAuthority')
  // a hand-edited value other than true counts as off
  const rigs = JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ ...rigs[0], mergeAuthority: 'yes' }]))
  expect(factory(['rig']).out).not.toContain('merge authority')
})

test("vmClaudeFlags and vmCodexHome carry --merge-authority on the hook's argv only when asked", () => {
  const flags = vmClaudeFlags({ maxContextK: 150 }, undefined, undefined, 'acme/widget')
  const settings = JSON.parse(flags[flags.indexOf('--settings') + 1]!)
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
    "'/usr/local/bin/bun' '/opt/factory/src/worker-hook.ts' --merge-authority 'acme/widget'",
  )
  const off = vmClaudeFlags({ maxContextK: 150 }, undefined, undefined, undefined)
  expect(off).toEqual(vmClaudeFlags({ maxContextK: 150 }))
  expect(JSON.stringify(off)).not.toContain('merge-authority')
  const codex = vmCodexHome({ maxContextK: 150 }, ['acme'], ['release'], 'acme/widget')
  expect(codex['hooks.json']).toMatch(/--protected-branches 'release' --merge-authority 'acme\/widget'/)
  expect(vmCodexHome({ maxContextK: 150 })['hooks.json']).not.toContain('merge-authority')
})

test('a reviewer station of a rig whose owner is FACTORY_AX_REVIEWER_OWNER gets the reviewer key, the env and the brief line; others do not (claude-factory-0gww.2)', () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
    return p.stdout.toString().trim()
  }
  mkdirSync(dir, { recursive: true })
  const sent = join(dir, 'rv-policy-sent')
  const applied = join(dir, 'rv-applied')
  const kubectl = join(dir, 'capture-rv')
  writeFileSync(
    kubectl,
    `#!/bin/sh\ncase "$*" in *create*) cat > ${sent} ;; *) exec ${readyController()} "$@" ;; esac\n`,
  )
  chmodSync(kubectl, 0o755)
  const cases = [
    ['rv1', 'review', 'acme', 'acme', true],
    ['rv2', 'security', 'acme', 'acme', true],
    ['rv3', 'check', 'acme', 'acme', true],
    ['rv4', 'implement', 'acme', 'acme', false],
    ['rv5', 'review', 'acme', 'other', false],
    ['rv6', 'review', 'acme', undefined, false],
  ] as const
  for (const [id, node, owner, flag, reviewer] of cases) {
    rmSync(sent, { force: true })
    rmSync(applied, { force: true })
    const rdef: Factory = {
      name: 'one',
      start: node,
      nodes: { [node]: { prompt: 'do', next: { ready: 'done' } } },
    }
    const origin = join(dir, id, `github.com/${owner}/widget.git`)
    const worktree = join(dir, id, 'wt')
    mkdirSync(join(dir, id), { recursive: true })
    sh(dir, 'git', 'init', '-q', '--bare', origin)
    sh(dir, 'git', 'clone', '-q', origin, worktree)
    writeFileSync(join(worktree, 'a'), 'a\n')
    sh(worktree, 'git', 'add', '.')
    sh(worktree, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    sh(worktree, 'git', 'push', '-q', 'origin', `HEAD:refs/heads/factory/${id}`)
    const runDir = join(home, 'runs', id)
    mkdirSync(join(runDir, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'dream.stamp'), '')
    writeFileSync(join(runDir, 'factory.ts'), `export default ${JSON.stringify(rdef)}`)
    const run = { id, factory: join(runDir, 'factory.ts'), repo: worktree, goal: 'g', ws: 'w1', worktree }
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...run, branch: `factory/${id}` }))
    const actor = createActor(compile(rdef)).start()
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
    // the cluster fake, but it keeps the manifest that ax apply reads on stdin
    writeFileSync(
      join(dir, 'ax'),
      `#!/bin/sh
echo "$*" >> ${calls}
case "$3 $4" in
  "apply -f") cat > ${applied} ;;
  "get task") printf 'status:\\n  phase: Running\\n' ;;
  ssh*) cat ${dir}/ssh ;;
esac
`,
    )
    const out = factory(['tick'], {
      FACTORY_AX_IMAGE: 'img',
      FACTORY_KUBECTL: kubectl,
      FACTORY_AX_VAULT: 'factory',
      ...(flag && { FACTORY_AX_REVIEWER_OWNER: flag }),
    }).out
    expect(JSON.parse(out).runs.find((r: { id: string }) => r.id === id).error).toBeNull()
    const sideName = readdirSync(runDir).find(f => /^f-.*\.json$/.test(f))!
    const side = JSON.parse(readFileSync(join(runDir, sideName), 'utf8'))
    const policy = readFileSync(sent, 'utf8')
    const brief = readFileSync(join(runDir, sideName.replace(/\.json$/, '.brief.md')), 'utf8')
    expect(side.reviewer).toBe(reviewer ? true : undefined)
    expect(policy.includes('GITHUB_REVIEWER')).toBe(reviewer)
    expect(readFileSync(applied, 'utf8').includes('FACTORY_GH_REVIEWER')).toBe(reviewer)
    expect(brief.includes('reviewer identity')).toBe(reviewer)
    rmSync(runDir, { recursive: true })
  }
}, 90_000) // git clones and whole ticks

// claude-factory-hr94: an AX worker sends its usage with its report
const usageRow = (over: Record<string, unknown> = {}) => ({
  session: 's1',
  model: 'claude-opus-4-7',
  input: 1,
  cacheWrite: 2,
  cacheRead: 300,
  output: 4,
  turns: 5,
  peak: 303,
  ...over,
})
const storedRows = (id: string) =>
  readFileSync(join(home, 'runs', id, 'usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))

test("inside a VM, a report carries the session's usage, subagents included (hr94 AC6)", () => {
  mkdirSync(dir, { recursive: true })
  const own = join(dir, 'vm-own')
  const claudeHome = join(dir, 'vm-claude')
  mkdirSync(join(claudeHome, 'projects', 'p', 'sess-9', 'subagents'), { recursive: true })
  mkdirSync(own, { recursive: true })
  writeFileSync(join(own, 'state.json'), JSON.stringify({ status: 'working', session: 'sess-9', pid: 1 }))
  const turn = (id: string, model: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 2 } },
    })
  writeFileSync(join(claudeHome, 'projects', 'p', 'sess-9.jsonl'), turn('a', 'claude-opus-4-7') + '\n')
  writeFileSync(
    join(claudeHome, 'projects', 'p', 'sess-9', 'subagents', 'agent-1.jsonl'),
    turn('b', 'claude-haiku-5-5') + '\n',
  )
  const outbox = join(dir, 'outbox-usage.jsonl')
  const env = {
    FACTORY_OUTBOX: outbox,
    FACTORY_FROM: 'a',
    FACTORY_RUN: '',
    FACTORY_WORKER_DIR: own,
    CLAUDE_CONFIG_DIR: claudeHome,
  }
  expect(factory(['report', 'r1', '1', 'ready', 'done'], env).code).toBe(0)
  const line = JSON.parse(readFileSync(outbox, 'utf8').trim())
  expect(line.argv).toEqual(['report', 'r1', '1', 'ready', 'done'])
  expect(line.usage.map((u: { model: string }) => u.model).sort()).toEqual([
    'claude-haiku-5-5',
    'claude-opus-4-7',
  ])
  expect(line.usage[0]).toMatchObject({ session: 'sess-9', input: 1, cacheRead: 9, output: 2 })
})

test("a replayed AX report stores the VM's usage as its station, and bad usage never refuses the report (hr94 AC6, AC7)", () => {
  const seq = launched('ru1')
  const rows = [
    usageRow({ node: 'evil', seq: 99 }), // node and seq come from the laptop, not the VM
    usageRow({ model: 'bad model!' }),
    usageRow({ session: 's2', cacheRead: NaN }),
    usageRow({ session: 's3', output: -1 }),
    usageRow({ session: 's4', peak: 1e13 }),
    usageRow({ session: 's5', turns: 1.5 }),
    usageRow({ session: 's6', model: 'claude-haiku-5-5' }),
    'junk',
  ]
  const report = JSON.stringify({
    argv: ['report', 'ru1', String(seq), 'ready', 'built a'],
    from: 'a',
    at: 1,
    usage: rows,
  })
  cluster('Running', { status: 'idle', session: 's1', lines: [report] })
  expect(factory(['tick']).code).toBe(0)
  expect(inbox('ru1')).toContain('"outcome":"ready"')
  const stored = storedRows('ru1')
  expect(stored.map(r => [r.session, r.model, r.node, r.seq])).toEqual([
    ['s1', 'claude-opus-4-7', 'a', seq],
    ['s6', 'claude-haiku-5-5', 'a', seq],
  ])
  rmSync(join(home, 'runs', 'ru1'), { recursive: true })
})

test('AX usage with 21 rows, or not an array, is ignored and the report still lands (hr94 AC7)', () => {
  for (const [id, usage] of [
    ['ru2', Array.from({ length: 21 }, () => usageRow())],
    ['ru3', 'lots'],
  ] as const) {
    const seq = launched(id)
    const report = JSON.stringify({
      argv: ['report', id, String(seq), 'ready', 'x'],
      from: 'a',
      at: 1,
      usage,
    })
    cluster('Running', { status: 'idle', session: 's1', lines: [report] })
    expect(factory(['tick']).code).toBe(0)
    expect(inbox(id)).toContain('"outcome":"ready"')
    expect(existsSync(join(home, 'runs', id, 'usage.jsonl'))).toBe(false)
    rmSync(join(home, 'runs', id), { recursive: true })
  }
})

/** the fake cluster with a task in `phase` whose status.conditions hold `conds` (YAML list lines) */
function clusterConds(phase: string, conds: string) {
  rmSync(calls, { force: true })
  writeFileSync(join(dir, 'cond.yaml'), `status:\n  phase: ${phase}\n${conds}`)
  writeFileSync(
    join(dir, 'ax'),
    `#!/bin/sh
echo "$*" >> ${calls}
case "$3 $4" in
  "get task") cat ${dir}/cond.yaml ;;
esac
`,
  )
  chmodSync(join(dir, 'ax'), 0o755)
}
const RESUME_MSG = 'resuming actor f/t: while running runsc restore: exit status 128'
const RESUME_FAILED = `  conditions:\n  - type: Ready\n    status: "False"\n    reason: ActorResumeFailed\n    message: "${RESUME_MSG}"\n`

test('a Failed task carries its Ready condition into the failure reason, read with one ax get task', () => {
  launched('r30')
  clusterConds('Failed', RESUME_FAILED)
  const row = JSON.parse(factory(['tick']).out).runs.find((r: { id: string }) => r.id === 'r30')
  expect(row.agent).toBe('gone')
  expect(row.error).toContain('ActorResumeFailed')
  expect(row.error).toContain('runsc restore: exit status 128')
  expect(readFileSync(join(home, 'runs', 'r30', 't.gone'), 'utf8')).toContain('ActorResumeFailed')
  expect(called().match(/get task/g)).toHaveLength(1)
  rmSync(join(home, 'runs', 'r30'), { recursive: true })
})

test('a Failed task with no condition keeps the bare "phase Failed" reason', () => {
  launched('r31')
  clusterConds('Failed', '')
  const row = JSON.parse(factory(['tick']).out).runs.find((r: { id: string }) => r.id === 'r31')
  expect(row.agent).toBe('gone')
  expect(row.error).toBe('phase Failed')
  rmSync(join(home, 'runs', 'r31'), { recursive: true })
})

test("a serve that died on a git clone failure fails the attempt with git's fatal line, past a long stack", () => {
  launched('r32')
  const fatal =
    'fatal: unable to access https://github.com/acme/widget.git/: Recv failure: Connection reset by peer'
  const stack = `Error: git clone x\n${'    at frame (/x/worker.ts:1:1)\n'.repeat(80)}`.slice(0, 2000)
  cluster('Running', {
    status: 'exited',
    log: `2026-10-28T00:00:00Z serve died: git clone https://github.com/acme/widget.git: Cloning into 'r' | ${fatal}\n${stack}`,
    lines: [],
  })
  const row = JSON.parse(factory(['tick']).out).runs.find((r: { id: string }) => r.id === 'r32')
  expect(row.agent).toBe('gone')
  expect(row.error).toContain('Recv failure: Connection reset by peer')
  expect(row.error.startsWith('serve exited: serve died: ')).toBe(true)
  rmSync(join(home, 'runs', 'r32'), { recursive: true })
})

test('a serve exit with no "serve died:" line keeps the whole log as the reason', () => {
  launched('r33')
  cluster('Running', { status: 'exited', log: 'h exited 1: boom', lines: [] })
  const row = JSON.parse(factory(['tick']).out).runs.find((r: { id: string }) => r.id === 'r33')
  expect(row.error).toBe('serve exited; its log: h exited 1: boom')
  rmSync(join(home, 'runs', 'r33'), { recursive: true })
})

const markerOf = (rig: string) => join(home, `ax-no-suspend-${rig}.json`)
/** the manager's mails from the factory in the run's saved state, about a failed restore */
const resumeMails = (id: string): { from: string; text: string }[] =>
  (
    JSON.parse(readFileSync(join(home, 'runs', id, 'state.json'), 'utf8')).snapshot.context.mail.manager ?? []
  ).filter(
    (m: { from: string; text: string }) => m.from === 'factory' && m.text.includes('ActorResumeFailed'),
  )

test('ActorResumeFailed writes the rig no-suspend marker and mails the manager once', () => {
  rmSync(markerOf('wt'), { force: true })
  launched('r34')
  clusterConds('Failed', RESUME_FAILED)
  factory(['tick'])
  const marker = JSON.parse(readFileSync(markerOf('wt'), 'utf8'))
  expect(typeof marker.at).toBe('number')
  expect(marker.why).toContain('runsc restore: exit status 128')
  expect(resumeMails('r34')).toHaveLength(1)
  const text = resumeMails('r34')[0]!.text
  expect(text).toContain('wt')
  expect(text).toContain('24 h')
  factory(['tick']) // the same failure again: the marker is fresh, so no second mail
  expect(resumeMails('r34')).toHaveLength(1)
  // another run of the same rig fails the same way inside the window: no new mail, the marker stays
  launched('r41')
  clusterConds('Failed', RESUME_FAILED)
  factory(['tick'])
  expect(resumeMails('r41')).toHaveLength(0)
  expect(JSON.parse(readFileSync(markerOf('wt'), 'utf8')).at).toBe(marker.at)
  rmSync(join(home, 'runs', 'r41'), { recursive: true })
  rmSync(markerOf('wt'), { force: true })
  rmSync(join(home, 'runs', 'r34'), { recursive: true })
})

test('only an ActorResumeFailed writes the marker: another reason, no condition or a serve exit does not', () => {
  rmSync(markerOf('wt'), { force: true })
  launched('r35')
  clusterConds(
    'Failed',
    '  conditions:\n  - type: Ready\n    status: "False"\n    reason: Other\n    message: m\n',
  )
  factory(['tick'])
  rmSync(join(home, 'runs', 'r35'), { recursive: true })
  launched('r36')
  clusterConds('Failed', '')
  factory(['tick'])
  rmSync(join(home, 'runs', 'r36'), { recursive: true })
  launched('r37')
  cluster('Running', { status: 'exited', log: 'serve died: ActorResumeFailed', lines: [] })
  factory(['tick'])
  rmSync(join(home, 'runs', 'r37'), { recursive: true })
  expect(existsSync(markerOf('wt'))).toBe(false)
})

/** a run r whose repo is `repo`, after the worker asked the manager and went idle on a Running task */
function askingIdle(id: string, repo: string) {
  launched(id)
  const runFile = join(home, 'runs', id, 'run.json')
  writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, 'utf8')), repo }))
  const ask = JSON.stringify({ argv: ['mail', id, 'manager', 'which db?'], from: 'a', at: 1 })
  cluster('Running', { status: 'idle', session: 's1', lines: [ask] })
  factory(['tick']) // the question is replayed
  factory(['tick']) // asked and idle
}

test('a rig with a fresh no-suspend marker keeps its asking idle worker running; another rig and an old marker do not', () => {
  const mark = (rig: string, ageH: number) =>
    writeFileSync(markerOf(rig), JSON.stringify({ at: Date.now() - ageH * 3_600_000, why: 'x' }))
  mark('wt', 1)
  askingIdle('r38', join(dir, 'wt'))
  expect(called()).not.toContain('suspend task')
  rmSync(join(home, 'runs', 'r38'), { recursive: true })

  askingIdle('r39', join(dir, 'other-rig')) // marker is for wt, not this rig
  expect(called()).toContain('suspend task t')
  rmSync(join(home, 'runs', 'r39'), { recursive: true })

  mark('wt', 25)
  askingIdle('r40', join(dir, 'wt'))
  expect(called()).toContain('suspend task t')
  rmSync(join(home, 'runs', 'r40'), { recursive: true })
  rmSync(markerOf('wt'), { force: true })
})

// claude-factory-xbzd S1: an AX-rig run needs no herdr. createRun makes a plain git worktree at herdr's layout.
describe('an AX-rig run with herdr failing (claude-factory-xbzd S1)', () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
    return p.stdout.toString().trim()
  }
  const two: Factory = {
    name: 'two',
    start: 'a',
    nodes: { a: { prompt: 'do a', next: { ready: 'b' } }, b: { prompt: 'do b', next: { ready: 'done' } } },
  }
  /** a rig repo cloned from a bare origin, a fake herdr that logs every call and fails, and the rig's file */
  function setup(tag: string, runner?: string, fdef: Factory = two) {
    const root = join(dir, tag)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    sh(root, 'git', 'init', '-q', '--bare', 'origin.git')
    sh(root, 'git', 'clone', '-q', 'origin.git', 'widget')
    const repo = realpathSync(join(root, 'widget')) // rigs.json holds the resolved path
    writeFileSync(join(repo, 'a'), 'a\n')
    sh(repo, 'git', 'add', '.')
    sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    sh(repo, 'git', 'push', '-q', 'origin', 'HEAD')
    const fdefFile = join(root, 'two.json')
    writeFileSync(fdefFile, JSON.stringify(fdef))
    const herdrLog = join(root, 'herdr.log')
    const fake = join(root, 'fakeherdr')
    writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${herdrLog}\nexit 1\n`)
    chmodSync(fake, 0o755)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'dream.stamp'), '')
    writeFileSync(
      join(home, 'rigs.json'),
      JSON.stringify([{ name: 'x', repo, factory: fdefFile, ...(runner && { runner }) }]),
    )
    cluster('Running', { status: 'idle', lines: [] })
    const env = {
      HOME: join(root, 'home'),
      FACTORY_HERDR: fake,
      FACTORY_AX_IMAGE: 'img',
      FACTORY_AX_VAULT: 'factory',
    }
    const herdrCalls = () => (existsSync(herdrLog) ? readFileSync(herdrLog, 'utf8') : '')
    return {
      repo,
      fdefFile,
      env,
      herdrCalls,
      tree: (id: string) => join(env.HOME, '.herdr/worktrees/widget', `factory-${id}`),
    }
  }
  const startedId = (out: string) => /started (\S+) in/.exec(out)![1]!
  const seqOf = (id: string) =>
    JSON.parse(readFileSync(join(home, 'runs', id, 'state.json'), 'utf8')).snapshot.context.seq

  test('start makes a git worktree at the herdr layout, with no herdr call and ws empty (AC5)', () => {
    const s = setup('s1a', 'ax')
    const out = factory(['start', s.fdefFile, s.repo, 'goal text'], s.env)
    expect(out.err).toBe('')
    const id = startedId(out.out)
    const run = JSON.parse(readFileSync(join(home, 'runs', id, 'run.json'), 'utf8'))
    expect(run.ws).toBe('')
    expect(run.worktree).toBe(s.tree(id))
    expect(run.branch).toBe(`factory/${id}`)
    expect(existsSync(join(run.worktree, 'a'))).toBe(true)
    expect(sh(s.repo, 'git', 'worktree', 'list')).toContain(s.tree(id))
    expect(sh(run.worktree, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`factory/${id}`)
    expect(s.herdrCalls()).not.toContain('worktree create')
    expect(out.out).not.toContain('herdr workspace')
  }, 30_000)

  test('start, launch, report and the next launch never call herdr to create, tab or run (AC6)', () => {
    const s = setup('s1b', 'ax')
    const id = startedId(factory(['start', s.fdefFile, s.repo, 'goal text'], s.env).out)
    expect(called()).toContain('apply -f') // the first launch
    const seq = seqOf(id)
    cluster('Running', { status: 'idle', lines: [] })
    expect(factory(['report', id, String(seq), 'ready', 'a done'], s.env).code).toBe(0)
    expect(factory(['tick'], s.env).code).toBe(0)
    expect(called()).toContain('apply -f') // b launched
    expect(seqOf(id)).toBeGreaterThan(seq)
    const log = s.herdrCalls()
    for (const bad of ['worktree create', 'tab create', 'pane run']) expect(log).not.toContain(bad)
  }, 60_000)

  test('rm of the done AX run removes its worktree with git (AC7)', () => {
    const one: Factory = { name: 'one', start: 'a', nodes: { a: { prompt: 'x', next: { ready: 'done' } } } }
    const s = setup('s1c', 'ax', one)
    const id = startedId(factory(['start', s.fdefFile, s.repo, 'goal text'], s.env).out)
    expect(factory(['report', id, String(seqOf(id)), 'ready', 'ok'], s.env).code).toBe(0)
    factory(['tick'], s.env)
    const rm = factory(['rm', id], s.env)
    expect(rm.err).toBe('')
    expect(existsSync(s.tree(id))).toBe(false)
    expect(sh(s.repo, 'git', 'worktree', 'list')).not.toContain(`factory-${id}`)
    expect(sh(s.repo, 'git', 'branch', '--list', `factory/${id}`)).toContain(`factory/${id}`)
  }, 60_000)

  test('a bad factory removes the new worktree with git and the run directory', () => {
    const bad: Factory = {
      name: 'bad',
      start: 'a',
      nodes: { a: { prompt: 'x', next: { ok: { to: 'done', ship: true } } } },
    }
    const s = setup('s1d', 'ax', bad)
    const before = existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')) : []
    const out = factory(['start', s.fdefFile, s.repo, 'goal text'], s.env)
    expect(out.code).not.toBe(0)
    expect(out.err).toContain('is not a valid factory')
    expect(sh(s.repo, 'git', 'worktree', 'list')).not.toContain('.herdr/worktrees')
    expect(readdirSync(join(home, 'runs'))).toEqual(before)
    expect(s.herdrCalls()).toBe('')
  }, 30_000)

  test.each([['herdr'], [undefined]])(
    'a rig with runner %p still creates its worktree through herdr',
    runner => {
      const s = setup(`s1e-${runner}`, runner)
      const out = factory(['start', s.fdefFile, s.repo, 'goal text'], s.env)
      expect(out.code).not.toBe(0)
      expect(s.herdrCalls()).toContain('worktree create')
    },
    30_000,
  )

  test("an AX rig's herdr-runner station reopens its worktree through herdr worktree open", () => {
    const mixed: Factory = {
      name: 'mixed',
      start: 'a',
      nodes: { a: { prompt: 'x', runner: 'herdr', next: { ready: 'done' } } },
    }
    const s = setup('s1f', 'ax', mixed)
    factory(['start', s.fdefFile, s.repo, 'goal text'], s.env)
    expect(s.herdrCalls()).toContain('worktree open')
    expect(s.herdrCalls()).not.toContain('worktree create')
  }, 30_000)
})

const BOOT = 'serve died: beads in the VM: bd bootstrap -y: Error: exit 1'
const bootMails = (id: string) =>
  ((ctxOf(id).mail.manager ?? []) as { from: string; text: string }[]).filter(m =>
    m.text.includes('bd bootstrap fails'),
  )
/** a serve that exited with `log`, then one tick */
function serveExit(id: string, log: string) {
  cluster('Running', { status: 'exited', log, lines: [] })
  factory(['tick'])
  return ctxOf(id)
}
/** the run wakes at wakeAt and a fresh worker starts, as the next tick would do */
function relaunch(id: string) {
  const runDir = join(home, 'runs', id)
  const snap = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot
  const actor = createActor(compile(def), { snapshot: snap }).start()
  actor.send({ type: 'TICK', at: snap.context.wakeAt })
  const seq = actor.getSnapshot().context.seq
  actor.send({ type: 'SPAWNED', seq, pane: 'ax://t', at: Date.now() })
  writeFileSync(join(runDir, 't.json'), JSON.stringify({ node: 'a', seq, policy: true }))
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
}

test('a first bd bootstrap exit holds the station 2 min and spends no attempt, without a mail', () => {
  launched('b1')
  const before = Date.now()
  const c = serveExit('b1', BOOT)
  expect(c.attempt).toBe(1)
  expect(c.log.at(-1).outcome).toBe('outage')
  expect(c.wakeAt).toBeGreaterThanOrEqual(before + 120_000 - 5_000)
  expect(c.wakeAt).toBeLessThanOrEqual(Date.now() + 120_000 + 60_000)
  expect(bootMails('b1')).toHaveLength(0)
  rmSync(join(home, 'runs', 'b1'), { recursive: true })
})

test('a second bootstrap exit in a row waits the streak floor and mails the manager once, from the factory', () => {
  launched('b2')
  serveExit('b2', BOOT)
  relaunch('b2')
  const before = Date.now()
  const c = serveExit('b2', BOOT)
  expect(c.attempt).toBe(1)
  expect(c.log.at(-1).outcome).toBe('outage')
  expect(c.wakeAt).toBeGreaterThanOrEqual(before + 30 * 60_000 - 5_000)
  expect(bootMails('b2').map(m => [m.from, m.text])).toEqual([['factory', 'bd bootstrap fails on wt VMs']])
  relaunch('b2')
  serveExit('b2', BOOT)
  expect(bootMails('b2')).toHaveLength(1)
  rmSync(join(home, 'runs', 'b2'), { recursive: true })
})

test('only a serve died with a bd bootstrap -y step is the bootstrap class: the rest spends an attempt', () => {
  for (const [i, log] of [
    'serve died: beads in the VM: origin has no refs/dolt/data',
    'serve died: beads in the VM: git init -q .: boom',
    'serve died: git clone https://github.com/acme/widget.git: boom',
    'bd bootstrap -y',
  ].entries()) {
    const id = `bn${i}`
    launched(id)
    const c = serveExit(id, log)
    expect(c.log.at(-1).outcome).toBe('fail')
    rmSync(join(home, 'runs', id), { recursive: true })
  }
})
