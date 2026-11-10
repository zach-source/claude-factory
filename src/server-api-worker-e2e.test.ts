// The worker API with a real TLS listener and the real CLI (claude-factory-akiq.9, Quickstart 1 and 2 in process).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'
import { cliRunner, personCerts, workerHandler, workerListener } from './server-api'
import { sign } from './tokens'

const KEY = Buffer.alloc(32, 9)
const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}
const ENV = ['FACTORY_OUTBOX', 'FACTORY_FROM', 'FACTORY_RUN', 'FACTORY_SERVER', 'FACTORY_GC'] as const
const saved: Record<string, string | undefined> = {}
let dir = ''
let home = ''
let stop = () => {}
beforeEach(() => {
  for (const n of ENV) saved[n] = process.env[n]
  for (const n of ENV) delete process.env[n]
  process.env.FACTORY_GC = '0'
  dir = mkdtempSync(join(tmpdir(), 'sapi-we-'))
  home = join(dir, 'home')
})
afterEach(() => {
  stop()
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
  rmSync(dir, { recursive: true, force: true })
})

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
  return {
    seq: (actor.getSnapshot().context as { seq: number }).seq,
    lines: () =>
      readFileSync(join(d, 'inbox.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l)),
  }
}

test('report once, mail from the station, a foreign run refused, no client certificate', async () => {
  const run = makeRun('r1')
  const certs = join(dir, 'certs')
  personCerts(certs, 'localhost')
  const now = Date.now()
  const token = sign(
    home,
    KEY,
    { task: 't', run: 'r1', node: 'implement', seq: run.seq, exp: now + 3600_000 },
    now,
  )
  const handle = workerHandler({ home, key: KEY, run: cliRunner(home), held: () => true })
  const l = workerListener({
    port: 0,
    cert: readFileSync(join(certs, 'server.crt'), 'utf8'),
    key: readFileSync(join(certs, 'server.key'), 'utf8'),
    handle,
  })
  stop = () => l.stop()
  const ca = readFileSync(join(certs, 'ca.crt'), 'utf8')
  const post = (path: string, body: unknown, key: string) =>
    fetch(`https://localhost:${l.port}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      keepalive: false,
      tls: { ca },
    })

  const rep = { outcome: 'ready', summary: 'worker api summary' }
  const a = await post('/v1/report', rep, 'report-key-1')
  expect(a.status).toBe(200)
  const b = await post('/v1/report', rep, 'report-key-1')
  expect(b.status).toBe(200)
  const done = run.lines().filter(x => x.type === 'DONE' && x.summary === rep.summary)
  expect(done.length).toBe(1)

  const m = await post('/v1/mail', { to: 'manager', text: 'hi' }, 'mail-key-001')
  expect(m.status).toBe(200)
  expect(run.lines().some(x => x.from === 'implement' && JSON.stringify(x).includes('hi'))).toBe(true)

  const before = readFileSync(join(home, 'runs', 'r1', 'inbox.jsonl'), 'utf8')
  const f = await post('/v1/report', { run: 'other', outcome: 'ok', summary: 'x' }, 'other-key-01')
  expect(f.status).toBe(403)
  const rows = Object.values(JSON.parse(readFileSync(join(home, 'worker-calls.json'), 'utf8'))) as {
    status: string
  }[]
  expect(rows.some(r => r.status === 'refused')).toBe(true)
  expect(readFileSync(join(home, 'runs', 'r1', 'inbox.jsonl'), 'utf8')).toBe(before)
  expect(existsSync(join(home, 'worker-calls.json'))).toBe(true)
}, 30_000)
