// Characterization tests for the change commands that move into catalog operations (claude-factory-2j6f):
// decide, decisions answer, mail, goto and abort. Each row spawns the real `bin/factory` with a fresh home
// and pins the exit code, the exact bytes of stdout and stderr, the new inbox lines, the bd call log and
// decisions.json. The goldens (ops-cli-changes.golden.json) come from origin/main 6ec30894, before the move.
// The server rows send the same actions through clientHandler with corePort and expect the same bytes.
// To write the goldens again: UPDATE_GOLDEN=1 bun test src/core/ops-cli-changes.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from '../machine'

const ROOT = join(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'bin', 'factory')
const GOLDEN = join(import.meta.dir, 'ops-cli-changes.golden.json')
const dir = join(tmpdir(), `ops-cli-changes-${process.pid}`)
const bin = join(dir, 'bin')
const OUT = join(dir, 'out')
const REPO = join(dir, 'repo')
const WT = join(dir, 'wt')
const RAPI = join(dir, 'r-api')
let n = 0

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
  'FACTORY_MAX_RUNS',
]

const cleanEnv = (home: string, extra: Record<string, string> = {}) => {
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

const DEF: Factory = {
  name: 'lifecycle',
  start: 'verify',
  nodes: {
    verify: { prompt: 'run the tests', next: { green: 'review' } },
    review: { prompt: 'review the diff', next: { approve: 'g' } },
    g: { prompt: 'ship it?', gate: true, next: { approve: 'done' } },
  },
}
const SHIP: Factory = {
  name: 'ship',
  start: 'release',
  nodes: {
    release: { prompt: 'ship it', next: { ready: 'deploy' } },
    deploy: { prompt: 'deploy it', awaitsPr: true, holdMail: true, next: { deployed: 'done' } },
  },
}
const PR = 'https://github.com/acme/widget/pull/42'

function writeRun(home: string, id: string, def: Factory, snapshot: unknown) {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(def)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: file,
      repo: REPO,
      goal: 'g',
      ws: 'ws1',
      worktree: WT,
      branch: `factory/${id}`,
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot }))
}

const atGate = () => {
  const a = createActor(compile(DEF)).start()
  for (const outcome of ['green', 'approve'])
    a.send({ type: 'DONE', seq: a.getSnapshot().context.seq, outcome, summary: `${outcome}: ok`, at: 1 })
  return a.getPersistedSnapshot()
}
const parked = () => {
  const a = createActor(compile(SHIP)).start()
  a.send({ type: 'GOTO', node: 'release', at: 0 })
  a.send({
    type: 'DONE',
    seq: a.getSnapshot().context.seq,
    outcome: 'ready',
    summary: `ready to ship ${PR}`,
    at: Date.now() - 120_000,
  })
  return a.getPersistedSnapshot()
}

/** a fresh home with runs r1 (at gate g), r2 (at verify), r3 (parked at deploy) and the rig api */
function freshHome(): string {
  const home = join(dir, `h${n++}`)
  mkdirSync(join(home, 'text'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'api', repo: RAPI, factory: 'lifecycle' }]))
  writeRun(home, 'r1', DEF, atGate())
  writeRun(home, 'r2', DEF, createActor(compile(DEF)).start().getPersistedSnapshot())
  writeRun(home, 'r3', SHIP, parked())
  return home
}

const calls = () => join(dir, 'calls.log')

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const d of [bin, OUT, REPO, WT, join(WT, 'sub'), join(RAPI, '.beads')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n')
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      `"human list") printf '%s' '[{"id":"api-1","title":"t"}]';;`,
      `"ready --json") printf '%s' '[]';;`,
      `*) echo "$*" >> ${calls()}; echo answered;;`,
      'esac',
    ].join('\n'),
  )
  for (const f of ['gh', 'bd']) chmodSync(join(bin, f), 0o755)
  Bun.spawnSync(['git', 'init', '-q', RAPI])
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const norm = (home: string, s: string) =>
  s
    .split(home)
    .join('<HOME>')
    .split(WT)
    .join('<WT>')
    .split(REPO)
    .join('<REPO>')
    .split(RAPI)
    .join('<RAPI>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<TIME>')

const inbox = (home: string, id: string): unknown[] => {
  const f = join(home, 'runs', id, 'inbox.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const { at: _at, ...rest } = JSON.parse(l)
      return rest
    })
}
const state = (home: string) => {
  const f = join(home, 'decisions.json')
  return {
    bd: existsSync(calls()) ? norm(home, readFileSync(calls(), 'utf8')).trim().split('\n') : [],
    decisions: existsSync(f) ? Object.keys(JSON.parse(readFileSync(f, 'utf8'))).sort() : null,
    inbox: ['r1', 'r2', 'r3'].flatMap(id => inbox(home, id).map(e => ({ run: id, ...(e as object) }))),
  }
}

type Row = {
  id: string
  calls: { argv: string[]; env?: Record<string, string>; cwd?: string }[]
  seed?: (home: string) => void
}
const seedKeys = (home: string) =>
  writeFileSync(
    join(home, 'decisions.json'),
    JSON.stringify(
      Object.fromEntries(
        ['bd:api:api-1', 'bd:api:api-7', 'own:api:api-7'].map(k => [
          k,
          { question: 'q', options: ['a', 'b'], at: 1 },
        ]),
      ),
    ),
  )
const c = (...argv: string[]) => ({ argv })
const ROWS: Row[] = [
  { id: 'D1', calls: [c('decide', 'r1', 'approve', 'looks', 'good')] },
  { id: 'D2', calls: [c('decide', 'r1', 'approve')] },
  { id: 'D3', calls: [c('decide', 'r1', 'nope')] },
  { id: 'D4', calls: [c('decide', 'r2', 'approve')] },
  { id: 'D5', calls: [{ argv: ['decide', 'r1', 'approve'], env: { FACTORY_PATROL: '1' } }] },
  { id: 'D6', calls: [{ argv: ['decide', 'r1', 'approve'], env: { FACTORY_FROM: 'review' } }] },
  { id: 'Q1', calls: [c('decisions', 'answer', 'api', 'api-1', 'go', 'now')] },
  { id: 'Q2', calls: [{ argv: ['decisions', 'answer', 'api', 'api-1', 'x'], env: { FACTORY_PATROL: '1' } }] },
  { id: 'Q3', calls: [c('decisions', 'answer', 'api')] },
  { id: 'Q4', seed: seedKeys, calls: [c('decisions', 'answer', 'api', 'api-1', 'go')] },
  { id: 'Q5', seed: seedKeys, calls: [c('decisions', 'answer', 'api', 'api-7', 'start', 'it')] },
  { id: 'M1', calls: [c('mail', 'r1', 'review', 'hello', 'there')] },
  { id: 'M2', calls: [c('mail', 'r1', 'review', '--wake', 'hi')] },
  { id: 'M3', calls: [c('mail', 'r1', 'nobox', 'x')] },
  { id: 'M4', calls: [{ argv: ['mail', 'r1', 'review', 'x'], cwd: join(WT, 'sub') }] },
  { id: 'M5', calls: [{ argv: ['mail', 'r1', 'review', 'x'], env: { BEADS_ACTOR: 'factory/x/y' } }] },
  { id: 'M6', calls: [{ argv: ['mail', 'r1', 'review', 'x'], env: { FACTORY_FROM: 'review' } }] },
  { id: 'M7', calls: [{ argv: ['mail', 'r1', 'review', 'x'], env: { FACTORY_FROM: 'nowhere' } }] },
  { id: 'M8', calls: [c('mail', 'r1', 'review', '--text-file', '<HOME>/text/m.md')] },
  { id: 'MH', calls: [c('mail', 'r3', 'deploy', 'hello')] },
  { id: 'G1', calls: [c('goto', 'r1', 'review')] },
  { id: 'G2', calls: [c('goto', 'r1', 'review'), c('goto', 'r1', 'review')] },
  { id: 'G3', calls: [c('goto', 'r1', 'nowhere')] },
  { id: 'G4', calls: [{ argv: ['goto', 'r1', 'review'], env: { FACTORY_PATROL: '1' } }] },
  { id: 'A1', calls: [c('abort', 'r1')] },
  { id: 'A2', calls: [c('abort', 'nope')] },
  { id: 'A3', calls: [{ argv: ['abort', 'r1'], env: { BEADS_ACTOR: 'factory/x/y' } }] },
]

const runRow = (row: Row) => {
  rmSync(calls(), { force: true })
  const home = freshHome()
  writeFileSync(join(home, 'text', 'm.md'), 'hi from file\n')
  row.seed?.(home)
  const results = row.calls.map(k => {
    const argv = k.argv.map(a => a.replace('<HOME>', home))
    const p = Bun.spawnSync([CLI, ...argv], {
      env: cleanEnv(home, k.env),
      cwd: k.cwd ?? OUT,
      timeout: 30_000,
    })
    return { code: p.exitCode, out: norm(home, p.stdout.toString()), err: norm(home, p.stderr.toString()) }
  })
  return { results, ...state(home) }
}

const golden: Record<string, unknown> = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {}
const update = process.env.UPDATE_GOLDEN === '1'
const fresh: Record<string, unknown> = {}
afterAll(() => {
  if (update) writeFileSync(GOLDEN, JSON.stringify(fresh, null, 2) + '\n')
})

for (const row of ROWS)
  test(`${row.id}: ${row.calls[0]!.argv.join(' ')}`, () => {
    const got = runRow(row)
    if (update) fresh[row.id] = got
    else expect(got).toEqual(golden[row.id] as typeof got)
  })

// ---- the same actions through the client port handler ----
const SCRIPT = `
import { corePort } from ${JSON.stringify(join(ROOT, 'src', 'cli.ts'))}
import { clientHandler, cliRunner } from ${JSON.stringify(join(ROOT, 'src', 'server-api.ts'))}
const [home, path, body] = process.argv.slice(2)
const h = clientHandler({ home, run: cliRunner(home), port: corePort, board: () => null } as any)
const res = await h(new Request('http://x' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-' + Math.random().toString(36).slice(2) + '12345678' }, body }), '127.0.0.1')
console.log(JSON.stringify({ status: res.status, body: await res.text() }))
`

const post = (home: string, path: string, body: object, cwd = OUT) => {
  const sf = join(dir, 'post.ts')
  writeFileSync(sf, SCRIPT)
  const p = Bun.spawnSync([process.execPath, sf, home, path, JSON.stringify(body)], {
    env: cleanEnv(home),
    cwd,
    timeout: 60_000,
  })
  if (p.exitCode !== 0) throw new Error(`post failed: ${p.stderr.toString()}`)
  const r = JSON.parse(p.stdout.toString().trim().split('\n').at(-1)!) as { status: number; body: string }
  return { status: r.status, body: norm(home, r.body), ...state(home) }
}
const outOf = (id: string) => (golden[id] as { results: { out: string; err: string }[] }).results.at(-1)!
const lineOf = (id: string) => (golden[id] as { inbox: unknown[] }).inbox
const refusedOf = (id: string) => JSON.stringify({ refused: outOf(id).err.slice(0, 500) }) + '\n'

if (!update) {
  test('server: decide', () => {
    const r = post(freshHome(), '/v1/runs/r1/decide', { outcome: 'approve', note: 'looks good' })
    expect(r.status).toBe(200)
    expect(r.body).toBe(outOf('D1').out)
    expect(r.inbox).toEqual(lineOf('D1'))
  })
  test('server: decide with a bad outcome', () => {
    const r = post(freshHome(), '/v1/runs/r1/decide', { outcome: 'nope', note: '' })
    expect(r.status).toBe(422)
    expect(r.body).toBe(refusedOf('D3'))
    expect(r.inbox).toEqual([])
  })
  test('server: decisions answer', () => {
    rmSync(calls(), { force: true })
    const r = post(freshHome(), '/v1/decisions/api/api-1/answer', { text: 'go now' })
    expect(r.status).toBe(200)
    expect(r.body).toBe(outOf('Q1').out)
    expect(r.bd).toEqual((golden.Q1 as { bd: string[] }).bd)
  })
  test('server: decisions answer drops the proposal keys', () => {
    rmSync(calls(), { force: true })
    const home = freshHome()
    seedKeys(home)
    const r = post(home, '/v1/decisions/api/api-1/answer', { text: 'go' })
    expect(r.status).toBe(200)
    expect(r.body).toBe(outOf('Q4').out)
    expect(r.decisions).toEqual((golden.Q4 as { decisions: string[] }).decisions)
  })
  test('server: mail ignores the cwd of the server process, and refuses a cwd inside the worktree', () => {
    const body = { to: 'review', text: 'hello there\n', from: 'manager', cwd: OUT }
    const ok = post(freshHome(), '/v1/runs/r1/mail', body, WT)
    expect(ok.status).toBe(200)
    expect(ok.body).toBe(outOf('M1').out)
    expect(ok.inbox).toEqual(lineOf('M1'))
    const bad = post(freshHome(), '/v1/runs/r1/mail', { ...body, cwd: join(WT, 'sub') })
    expect(bad.status).toBe(403)
    expect(bad.inbox).toEqual([])
  })
  test('server: mail to a held box prints the held line', () => {
    const r = post(freshHome(), '/v1/runs/r3/mail', {
      to: 'deploy',
      text: 'hello',
      from: 'manager',
      cwd: OUT,
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe(outOf('MH').out)
    expect(r.inbox).toEqual(lineOf('MH'))
  })
  test('server: goto', () => {
    const r = post(freshHome(), '/v1/runs/r1/goto', { node: 'review' })
    expect(r.status).toBe(200)
    expect(r.body).toBe(outOf('G1').out)
    expect(r.inbox).toEqual(lineOf('G1'))
  })
  test('server: abort', () => {
    const r = post(freshHome(), '/v1/runs/r1/abort', {})
    expect(r.status).toBe(200)
    expect(r.body).toBe(outOf('A1').out)
    expect(r.inbox).toEqual(lineOf('A1'))
  })
}
