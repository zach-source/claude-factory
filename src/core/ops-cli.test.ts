// Characterization tests for the read commands that move into catalog operations (claude-factory-hpmc.2).
// Each row spawns the real `bin/factory` and pins the exit code and the exact bytes of stdout and stderr.
// The goldens come from origin/main f80d1fe0, before the move. The same bytes must hold after it.
// The fixtures copy gatebrief-cli.test.ts: a run `r1` at a gate and a run `r2` at `verify`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from '../machine'

const CLI = join(import.meta.dir, '..', '..', 'bin', 'factory')
const dir = join(tmpdir(), `ops-cli-${process.pid}`)
const bin = join(dir, 'bin')
const repoDir = join(dir, 'repo')
const H0 = join(dir, 'h0')
const H1 = join(dir, 'h1')
const H2 = join(dir, 'h2')
const RA = join(dir, 'r-alpha')
const RB = join(dir, 'r-beta')
const RG = join(dir, 'r-gamma')
const SW = join(dir, 'sw', 'tidysweeps.ts')

// keys that change the output between machines
const STRIP = [
  'FACTORY_OUTBOX',
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_PATROL',
  'FACTORY_DEF_NAME',
  'BEADS_ACTOR',
  'FACTORY_SERVER',
  'FACTORY_IN_AX',
  'FACTORY_AX_BACKUP_REMOTE',
  'CURSOR_API_KEY',
  'FACTORY_CURSOR_CAP',
  'FACTORY_GROK_WEEKLY_BUDGET_USD',
  'FACTORY_MAX_RUNS',
]

export const cleanEnv = (home: string, extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of STRIP) delete env[k]
  return {
    ...env,
    FACTORY_HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FACTORY_SELF_UPDATE: '0',
    FACTORY_NO_KICK: '1',
    ...extra,
  } as Record<string, string>
}

/** replace the machine-bound paths, so the output is the same everywhere */
export const norm = (s: string) =>
  s
    .split(H1)
    .join('<HOME>')
    .split(H2)
    .join('<HOME>')
    .split(H0)
    .join('<HOME>')
    .split(RA)
    .join('<RA>')
    .split(RB)
    .join('<RB>')
    .split(RG)
    .join('<RG>')
    .split(repoDir)
    .join('<REPO>')

const factory = (home: string, args: string[], extra: Record<string, string> = {}) => {
  if (home === H2) writeLinearSync()
  const p = Bun.spawnSync([CLI, ...args], { env: cleanEnv(home, extra), timeout: 30_000 })
  return { code: p.exitCode, out: norm(p.stdout.toString()), err: norm(p.stderr.toString()) }
}

/** written just before each spawn, so the age in the golden is always 10m */
const writeLinearSync = () => {
  const at = Date.now() - 600_000
  writeFileSync(
    join(H2, 'linear-sync.json'),
    JSON.stringify({ alpha: { at, pulled: 3, unrouted: 1, truncated: true }, beta: { at, error: 'boom' } }),
  )
}

const DEF: Factory = {
  name: 'lifecycle',
  start: 'verify',
  nodes: {
    verify: { prompt: 'run the tests', next: { green: 'review' } },
    review: { prompt: 'review the diff', next: { approve: 'g' } },
    g: { prompt: 'ship it?', gate: true, next: { approve: 'done' } },
  },
}

function writeRun(home: string, id: string, goal: string, snapshot: unknown) {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo: repoDir,
      goal,
      ws: 'ws1',
      worktree: repoDir,
      branch: `factory/${id}`,
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot }))
}

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(repoDir, { recursive: true })
  // fake gh: no call may reach the network
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'gh'), 0o755)
  for (const h of [H0, H1, H2]) {
    mkdirSync(h, { recursive: true })
    writeFileSync(join(h, 'rigs.json'), '[]')
  }
  const a = createActor(compile(DEF)).start()
  a.send({
    type: 'DONE',
    seq: a.getSnapshot().context.seq,
    outcome: 'green',
    summary: 'verify: all green',
    at: 1,
  })
  a.send({
    type: 'DONE',
    seq: a.getSnapshot().context.seq,
    outcome: 'approve',
    summary: 'review: looks good',
    at: 2,
  })
  writeRun(H1, 'r1', 'ship the thing', a.getPersistedSnapshot())
  writeRun(H1, 'r2', 'g', createActor(compile(DEF)).start().getPersistedSnapshot())
  writeRun(H2, 'r1', 'ship the thing', a.getPersistedSnapshot())
  writeRun(H2, 'r2', 'g', createActor(compile(DEF)).start().getPersistedSnapshot())
  mkdirSync(join(dir, 'sw'), { recursive: true })
  writeFileSync(
    SW,
    `export default ${JSON.stringify({ name: 'tidysweeps', start: 'tidy', nodes: { tidy: { prompt: 'tidy', everyMin: 60, next: { done: 'done', more: 'look' } }, look: { prompt: 'look', next: { done: 'done' } } } })}`,
  )
  mkdirSync(RG, { recursive: true })
  for (const r of [RA, RB]) {
    mkdirSync(r, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', r])
  }
  Bun.spawnSync(['git', '-C', RB, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git'])
  writeFileSync(
    join(H2, 'rigs.json'),
    JSON.stringify([
      {
        name: 'alpha',
        repo: RA,
        factory: 'lifecycle',
        maxRuns: 2,
        sweeps: [],
        goal: 'ship acme',
        slo: 'true',
        drift: 'true',
        agent: 'claude',
        personOnlyContexts: ['acme-prod'],
        protectedBranches: ['main'],
        mergeAuthority: true,
        mcp: '/x/mcp.json',
        params: { tier: 'small' },
        linear: { team: ['T1'], projects: ['p1'], labels: ['l1'] },
      },
      {
        name: 'beta',
        repo: RB,
        factory: 'lifecycle',
        sweeps: ['s1', 's2'],
        mergeAuthority: true,
        linear: { team: ['T2'] },
      },
      { name: 'gamma', repo: RG, factory: 'lifecycle', sweepsFactory: SW },
      { name: 'delta', repo: repoDir, factory: 'lifecycle', sweepsFactory: join(dir, 'sw', 'missing.ts') },
    ]),
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Row = { code: number; out: string; err: string }
// [golden key, home, argv, extra env]
const ROWS: [string, string, string[], Record<string, string>?][] = [
  ['a', H1, ['show', 'r1']],
  ['b', H1, ['show', 'nope']],
  ['c', H1, ['status']],
  ['d', H1, ['status', 'r1']],
  ['e', H0, ['plan']],
  ['e', H0, ['plan', 'show']],
  ['f', H0, ['lease']],
  ['f', H0, ['lease', 'status']],
  ['g1', H0, ['lease', 'status'], { FACTORY_FROM: 'implement' }],
  ['g2', H0, ['lease', 'status'], { FACTORY_PATROL: '1' }],
  ['h', H0, ['metrics', '--json']],
  ['i', H0, ['metrics', '--since', '0d']],
  ['j', H1, ['gate-brief', 'facts', 'r1']],
  ['k', H1, ['gate-brief', 'facts', 'r2']],
  ['l1', H1, ['backlog']],
  ['l2', H1, ['prs']],
  ['l3', H1, ['decisions']],
  ['l3', H1, ['decisions', 'list']],
  ['m', H0, ['status', 'nope']],
  ['n0', H0, ['rig']],
  ['n0', H0, ['rig', 'list']],
  ['n2', H2, ['rig', 'list']],
  ['n2', H2, ['rig', 'list'], { FACTORY_FROM: 'triage' }],
]

/** the goldens: the output of origin/main f80d1fe0 after normalization (`<HOME>`, `<REPO>`) */
const GOLD: Record<string, Row> = {
  a: {
    code: 0,
    out: '{"id":"r1","factory":"lifecycle","goal":"ship the thing","node":"g","sub":"working","attempt":1,"attempts":3,"pane":null,"agent":"awaiting decision","ws":"ws1","error":null,"last":{"node":"review","attempt":1,"outcome":"approve","summary":"review: looks good","at":2},"trail":["verify","review"],"mailedAt":2,"gate":{"question":"ship it?","outcomes":["approve"]},"seq":3,"wakeAt":0,"startedAt":0,"run":{"id":"r1","factory":"<HOME>/runs/r1/factory.ts","repo":"<REPO>","goal":"ship the thing","ws":"ws1","worktree":"<REPO>","branch":"factory/r1"},"log":[{"node":"verify","attempt":1,"outcome":"green","summary":"verify: all green","at":1},{"node":"review","attempt":1,"outcome":"approve","summary":"review: looks good","at":2}],"inbox":[{"from":"review","text":"review: looks good","at":2}],"start":"verify","stations":[{"id":"verify","gate":false,"next":[{"outcome":"green","to":"review"}]},{"id":"review","gate":false,"next":[{"outcome":"approve","to":"g"}]},{"id":"g","gate":true,"next":[{"outcome":"approve","to":"done"}]}],"tasks":null,"isWorking":true}\n',
    err: '',
  },
  b: {
    code: 1,
    out: '',
    err: 'factory: no run "nope" (runs: r1, r2)\n',
  },
  c: {
    code: 0,
    out: "r1  g/working  try 1/3  pane - (awaiting decision)\n  goal: ship the thing\n  gate: ship it?\n  decide: factory decide r1 <approve> '[note]'\n  unread: g 1\n  review#1 approve: review: looks good\nr2  verify/working  try 1/3  pane - (-)\n  goal: g\n",
    err: '',
  },
  d: {
    code: 0,
    out: "r1  g/working  try 1/3  pane - (awaiting decision)\n  goal: ship the thing\n  factory: <HOME>/runs/r1/factory.ts\n  gate: ship it?\n  decide: factory decide r1 <approve> '[note]'\n  unread: g 1\n  verify#1 green: verify: all green\n  review#1 approve: review: looks good\n",
    err: '',
  },
  e: {
    code: 0,
    out: 'no plan.json yet: `factory plan facts` then `factory plan set <file>`, or wait for the pm\n',
    err: '',
  },
  f: {
    code: 0,
    out: 'nobody holds the manager lease\n',
    err: '',
  },
  g1: {
    code: 1,
    out: '',
    err: 'a worker cannot run factory lease (FACTORY_FROM is set): mail the manager instead\n',
  },
  g2: {
    code: 1,
    out: '',
    err: 'factory: a patrol cannot run factory lease: leave it for the person or the manager\n',
  },
  h: {
    code: 0,
    out: '{"grok":{"spentUsd":0,"budgetUsd":null},"all":{"runs":0,"fates":{},"shipRate":null,"hoursToShip":{"median":null,"p90":null},"small":{"runs":0,"hoursToShip":{"median":null,"p90":null}},"approveWaitHours":{"median":null,"p90":null},"reviewLoops":0,"deploySessionsPerShippedRun":null,"triageAlreadyDone":0,"runsWith3PlusReviewRounds":0,"implementPassesPerShippedRun":null,"capReplans":0,"fails":{},"stations":{}},"precheck":{"skipped":0,"mergedPr":0,"liveRun":0,"failOpen":0},"launches":[],"denials":{},"rigs":{}}\n',
    err: '',
  },
  i: {
    code: 1,
    out: '',
    err: 'factory: usage: factory metrics [--rig r] [--since <days>d] [--json] [--tokens]\n',
  },
  j: {
    code: 0,
    out: '{"key":"gate:r1@0","goal":"ship the thing","gate":{"question":"ship it?","outcomes":["approve"]},"verify":"verify: all green","review":"review: looks good","prs":[]}\n',
    err: '',
  },
  k: {
    code: 1,
    out: '',
    err: 'factory: r2 is not at a gate (it is at verify)\n',
  },
  l1: {
    code: 0,
    out: '[]\n',
    err: '',
  },
  l2: {
    code: 0,
    out: '[{"run":"r1","node":"g","ended":false,"at":null,"error":"gh api: pull list failed","prs":[]},{"run":"r2","node":"verify","ended":false,"at":null,"error":"gh api: pull list failed","prs":[]}]\n',
    err: '',
  },
  l3: {
    code: 0,
    out: '{"rigs":[],"proposals":{}}\n',
    err: '',
  },
  n0: {
    code: 0,
    out: 'no rigs: factory rig add <name> <repo> [factory]\ntown: busy 0/16, stuck 0\n',
    err: '',
  },
  n2: {
    code: 0,
    out: 'alpha  <RA>  lifecycle  busy 0/2  sweeps none\n  goal: ship acme\n  slo: true\n  drift: true\n  agent: claude\n  person-only contexts: acme-prod\n  protected branches: main\n  merge authority: ship release station, no origin: off\n  mcp: /x/mcp.json\n  param tier: small\n  linear: team T1, projects p1, labels l1 (pulled 3, unrouted 1, 10m ago, list truncated at 50 pages)\nbeta  <RB>  lifecycle  busy 0  sweeps s1,s2\n  merge authority: ship release station, acme/widget\n  linear: team T2 (error 10m ago: boom)\ngamma  <RG>  lifecycle  busy 0  sweeps tidy\ndelta  <REPO>  lifecycle  busy 1  sweeps none\ntown: busy 1/16, stuck 0\n',
    err: '',
  },
  m: {
    code: 1,
    out: "no runs yet: factory start <factory> <repo> '<goal...>'\n",
    err: 'factory: no run "nope" (runs: none)\n',
  },
}

for (const [key, home, args, extra] of ROWS)
  test(`factory ${args.join(' ')}${extra ? ` ${JSON.stringify(extra)}` : ''} keeps its output (${key})`, () => {
    expect(factory(home, args, extra)).toEqual(GOLD[key]!)
  })

// The server answers the same bytes in process: a script gives corePort to clientHandler and GETs each path.
const serverGet = (home: string, paths: string[]): { status: number; body: string }[] => {
  const script = join(dir, 'serve.ts')
  writeFileSync(
    script,
    [
      `import { corePort } from ${JSON.stringify(join(import.meta.dir, '..', 'cli.ts'))}`,
      `import { clientHandler } from ${JSON.stringify(join(import.meta.dir, '..', 'server-api.ts'))}`,
      `const run = async () => { throw new Error('the runner must not run') }`,
      `const h = clientHandler({ home: process.env.FACTORY_HOME!, run, port: corePort, board: () => null })`,
      `for (const p of process.argv.slice(2)) {`,
      `  const r = await h(new Request('http://x' + p), '1.2.3.4')`,
      `  console.log(JSON.stringify({ status: r.status, body: await r.text() }))`,
      `}`,
      `process.exit(0)`,
    ].join('\n'),
  )
  const p = Bun.spawnSync([process.execPath, script, ...paths], { env: cleanEnv(home), timeout: 30_000 })
  expect(p.stderr.toString()).toBe('')
  return p.stdout
    .toString()
    .trim()
    .split('\n')
    .map(l => {
      const j = JSON.parse(l) as { status: number; body: string }
      return { status: j.status, body: norm(j.body) }
    })
}
const refused = (body: string) => (JSON.parse(body) as { refused: string }).refused

test('the server answers the CLI bytes for the moved reads of H1', () => {
  const paths: [string, string][] = [
    ['/v1/runs/r1', 'a'],
    ['/v1/status', 'c'],
    ['/v1/status?run=r1', 'd'],
    ['/v1/runs/r1/brief', 'j'],
    ['/v1/backlog', 'l1'],
    ['/v1/prs', 'l2'],
    ['/v1/decisions', 'l3'],
  ]
  const got = serverGet(
    H1,
    paths.map(p => p[0]),
  )
  expect(got).toEqual(paths.map(([, k]) => ({ status: 200, body: GOLD[k]!.out })))
})

test('the server answers the CLI bytes for the moved reads of H0', () => {
  const got = serverGet(H0, ['/v1/plan', '/v1/lease', '/v1/metrics?json=1'])
  expect(got).toEqual(['e', 'f', 'h'].map(k => ({ status: 200, body: GOLD[k]!.out })))
})

test('the server answers the CLI bytes for the rig list', () => {
  writeLinearSync()
  const [a] = serverGet(H2, ['/v1/rigs'])
  expect(a).toEqual({ status: 200, body: GOLD.n2!.out })
  const [b] = serverGet(H0, ['/v1/rigs'])
  expect(b).toEqual({ status: 200, body: GOLD.n0!.out })
})

test('a refusal of the server holds the CLI stderr line', () => {
  const [a, b] = serverGet(H1, ['/v1/runs/nope', '/v1/runs/r2/brief'])
  expect(a!.status).toBe(422)
  expect(refused(a!.body)).toBe(GOLD.b!.err)
  expect(b!.status).toBe(422)
  expect(refused(b!.body)).toBe(GOLD.k!.err)
  const [c] = serverGet(H0, ['/v1/metrics?since=0d'])
  expect(c!.status).toBe(422)
  expect(refused(c!.body)).toBe(GOLD.i!.err)
})

const screenFixture = (pane: unknown) => {
  const home = join(dir, 'screen')
  mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), '[]')
  writeFileSync(join(home, 'runs', 'r1', 'run.json'), JSON.stringify({ id: 'r1' }))
  writeFileSync(join(home, 'runs', 'r1', 'state.json'), JSON.stringify({ snapshot: { context: { pane } } }))
  writeFileSync(join(home, 'outbox.jsonl'), 'unchanged\n')
  const calls = join(home, 'calls.jsonl')
  writeFileSync(calls, '')
  const fake = join(home, 'transport')
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, writeFileSync, writeSync } from 'node:fs'
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
writeFileSync(${JSON.stringify(join(home, 'pid'))}, String(process.pid))
const mode = process.env.SCREEN_MODE
if (mode === 'failure') { writeSync(2, 'zqsecret'); process.exit(1) }
if (mode?.includes('flood')) {
  for (let i = 0; i < 128; i++) { writeSync(1, Buffer.alloc(65536, 'x')); writeSync(2, Buffer.alloc(65536, 'e')) }
  writeSync(1, '€latest screen')
}
if (mode?.includes('hang')) setInterval(() => {}, 1000)
else if (!mode?.includes('flood')) writeSync(1, 'last screen')
`)
  chmodSync(fake, 0o755)
  const runner = join(home, 'request.ts')
  writeFileSync(runner, `
import { corePort } from ${JSON.stringify(join(import.meta.dir, '..', 'cli.ts'))}
import { clientHandler } from ${JSON.stringify(join(import.meta.dir, '..', 'server-api.ts'))}
const h = clientHandler({ home: process.env.FACTORY_HOME!, port: corePort, board: () => null, run: async () => { throw new Error('no runner') } })
const start = Date.now()
await Promise.all(process.argv.slice(2).map(async path => {
  const response = await h(new Request('http://x' + path), '1.2.3.4')
  console.log(JSON.stringify({ path, status: response.status, body: await response.text(), elapsed: Date.now() - start }))
}))
`)
  const files = ['runs/r1/run.json', 'runs/r1/state.json', 'outbox.jsonl', 'rigs.json']
  const before = files.map(f => readFileSync(join(home, f), 'utf8'))
  return {
    home,
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    unchanged: () => expect(files.map(f => readFileSync(join(home, f), 'utf8'))).toEqual(before),
    request: async (mode = '', paths = ['/v1/runs/r1/screen']) => {
      const p = Bun.spawn([process.execPath, runner, ...paths], {
        env: cleanEnv(home, { FACTORY_HERDR: fake, FACTORY_AX: fake, FACTORY_AX_CONTEXT: 'acme', FACTORY_AX_ATESPACE: 'screens', FACTORY_AX_CAPABILITIES: 'SETUID,SETGID', SCREEN_MODE: mode }),
        stdout: 'pipe', stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      expect({ code, err }).toEqual({ code: 0, err: '' })
      return out.trim().split('\n').map(l => JSON.parse(l) as { path: string; status: number; body: string; elapsed: number })
    },
    exited: () => {
      const pid = Number(readFileSync(join(home, 'pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    },
  }
}

for (const pane of ['w1:p1', 'opaque-1'])
  test(`runs.screen reads herdr pane ${pane} with exact argv`, async () => {
    const t = screenFixture(pane)
    const [r] = await t.request()
    expect(r).toMatchObject({ status: 200, body: 'last screen' })
    expect(t.calls()).toEqual([['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '60']])
    t.unchanged()
  })

test('runs.screen gives reasons for absent runs and panes', async () => {
  const t = screenFixture(null)
  const [missing, idle] = await t.request('', ['/v1/runs/absent/screen', '/v1/runs/r1/screen'])
  expect(missing!.status).toBe(404)
  expect(idle!.status).toBe(409)
  expect(refused(missing!.body).length).toBeGreaterThan(0)
  expect(refused(idle!.body).length).toBeGreaterThan(0)
  expect(t.calls()).toEqual([])
  t.unchanged()
})

for (const pane of [false, 1, {}, [], '', ' ', 'a b', '-pane', '/pane', 'a/b', 'a;id', 'a$(id)', 'a\nb', 'a'.repeat(129), 'ax://', 'ax://-bad', 'ax://Bad', 'ax://a/b', 'ax://a b', 'ax://bad-', `ax://${'a'.repeat(64)}`])
  test(`runs.screen refuses stored address ${JSON.stringify(pane)}`, async () => {
    const t = screenFixture(pane)
    const [r] = await t.request()
    expect(r!.status).toBe(422)
    expect(refused(r!.body).length).toBeGreaterThan(0)
    expect(t.calls()).toEqual([])
    t.unchanged()
  })

for (const task of ['f-acme-1', 'a', 'a'.repeat(63)])
  test(`runs.screen reads AX task ${task} as the worker`, async () => {
    const t = screenFixture(`ax://${task}`)
    const [r] = await t.request()
    expect(r).toMatchObject({ status: 200, body: 'last screen' })
    expect(t.calls()).toEqual([['--context', 'acme', '-a', 'screens', 'ssh', task, '--', 'setpriv', '--reuid=worker', '--regid=worker', '--init-groups', 'env', 'HOME=/home/worker', 'USER=worker', 'factory', 'worker', 'screen']])
    t.unchanged()
  })

for (const pane of ['w1:p1', 'ax://f-acme-1']) {
  test(`runs.screen hides transport errors for ${pane}`, async () => {
    const t = screenFixture(pane)
    const [r] = await t.request('failure')
    expect(r!.status).toBe(422)
    expect(refused(r!.body)).not.toContain('zqsecret')
    expect(refused(r!.body).length).toBeGreaterThan(0)
    expect(t.calls()).toHaveLength(1)
    t.unchanged()
  })
  test(`runs.screen caps a stdout and stderr flood for ${pane}`, async () => {
    const t = screenFixture(pane)
    const [r] = await t.request('flood')
    expect(r!.status).toBe(200)
    expect(Buffer.byteLength(r!.body)).toBe(65536)
    expect(r!.body.endsWith('€latest screen')).toBe(true)
    expect(r!.body).not.toContain('�')
    t.exited()
    t.unchanged()
  }, 30000)
  for (const mode of ['hang', 'flood-hang'])
    test(`runs.screen reaps ${mode} for ${pane} without a blocked fast read`, async () => {
      const t = screenFixture(pane)
      const rows = await t.request(mode, ['/v1/runs/r1/screen', '/v1/catalog/echo?text=fast'])
      const fast = rows.find(r => r.path.includes('echo'))!
      const hung = rows.find(r => r.path.includes('/screen'))!
      expect(fast).toMatchObject({ status: 200, body: 'fast\n' })
      expect(fast.elapsed).toBeLessThan(2000)
      expect(hung.status).toBe(504)
      expect(hung.elapsed).toBeGreaterThanOrEqual(8900)
      expect(hung.elapsed).toBeLessThan(10000)
      t.exited()
      t.unchanged()
    }, 30000)
}

test('worker screen accepts no extra operands or flags', () => {
  const home = join(dir, 'verb-screen')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'claude.jsonl'), 'only stream')
  const extra = { FACTORY_WORKER_DIR: home, FACTORY_HARNESS: 'claude' }
  expect(factory(home, ['worker', 'screen'], extra)).toEqual({ code: 0, out: 'only stream', err: '' })
  for (const arg of ['claude', '--lines', '../codex.jsonl']) {
    const r = factory(home, ['worker', 'screen', arg], extra)
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).not.toContain('only stream')
  }
  expect(existsSync(join(home, 'outbox.jsonl'))).toBe(false)
})
