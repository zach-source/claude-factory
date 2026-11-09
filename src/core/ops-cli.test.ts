// Characterization tests for the read commands that move into catalog operations (claude-factory-hpmc.2).
// Each row spawns the real `bin/factory` and pins the exit code and the exact bytes of stdout and stderr.
// The goldens come from origin/main f80d1fe0, before the move. The same bytes must hold after it.
// The fixtures copy gatebrief-cli.test.ts: a run `r1` at a gate and a run `r2` at `verify`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  s.split(H1).join('<HOME>').split(H0).join('<HOME>').split(repoDir).join('<REPO>')

const factory = (home: string, args: string[], extra: Record<string, string> = {}) => {
  const p = Bun.spawnSync([CLI, ...args], { env: cleanEnv(home, extra), timeout: 30_000 })
  return { code: p.exitCode, out: norm(p.stdout.toString()), err: norm(p.stderr.toString()) }
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
  for (const h of [H0, H1]) {
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
    out: '{"grok":{"spentUsd":0,"budgetUsd":null},"all":{"runs":0,"fates":{},"shipRate":null,"hoursToShip":{"median":null,"p90":null},"small":{"runs":0,"hoursToShip":{"median":null,"p90":null}},"approveWaitHours":{"median":null,"p90":null},"reviewLoops":0,"security":{"builds":0,"sent":0,"escalated":0,"verdicts":0,"changes":0},"deploySessionsPerShippedRun":null,"triageAlreadyDone":0,"runsWith3PlusReviewRounds":0,"implementPassesPerShippedRun":null,"capReplans":0,"fails":{},"stations":{}},"precheck":{"skipped":0,"mergedPr":0,"liveRun":0,"failOpen":0},"launches":[],"denials":{},"rigs":{}}\n',
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
