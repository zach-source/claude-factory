import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { revoke, sign } from './tokens'
import { workerHandler, type RunResult } from './server-api'

const KEY = Buffer.alloc(32, 7)
const T0 = 1_800_000_000_000
const DAY = 24 * 3600_000
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Call = { argv: string[]; text: string | undefined; env: Record<string, string> }
const state = (home: string, run: string, node: string, seq: number) => {
  mkdirSync(join(home, 'runs', run), { recursive: true })
  writeFileSync(
    join(home, 'runs', run, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: { value: { [node]: 'working' }, context: { seq } } }),
  )
}
const setup = (
  o: { result?: Partial<RunResult>; runner?: () => Promise<RunResult>; held?: () => boolean } = {},
) => {
  const home = mkdtempSync(join(tmpdir(), 'sapi-w-'))
  dirs.push(home)
  const calls: Call[] = []
  let t = T0
  const run = async (argv: string[], text: string | undefined, env: Record<string, string>) => {
    calls.push({ argv, text, env })
    if (o.runner) return o.runner()
    return { code: 0, out: 'done\n', err: '', ...o.result } as RunResult
  }
  const h = workerHandler({ home, key: KEY, run, held: o.held ?? (() => true), now: () => t })
  state(home, 'r1', 'plan', 2)
  const token = (c: Partial<{ run: string; node: string; seq: number; exp: number }> = {}) =>
    sign(home, KEY, { task: 't', run: 'r1', node: 'plan', seq: 2, exp: T0 + 3600_000, ...c }, T0)
  let n = 0
  const post = (
    path: string,
    body: unknown,
    over: {
      token?: string | null
      auth?: string
      key?: string | null
      type?: string | null
      method?: string
    } = {},
  ) => {
    const headers: Record<string, string> = {}
    const tok = over.token === undefined ? defTok : over.token
    if (over.auth !== undefined) headers.authorization = over.auth
    else if (tok !== null) headers.authorization = `Bearer ${tok}`
    const k = over.key === undefined ? `key-${String(++n).padStart(8, '0')}` : over.key
    if (k !== null) headers['idempotency-key'] = k
    if (over.type !== null) headers['content-type'] = over.type ?? 'application/json'
    return h(
      new Request(`https://x.invalid${path}`, {
        method: over.method ?? 'POST',
        headers,
        body: over.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      '1.2.3.4',
    )
  }
  const defTok = token()
  const file = join(home, 'worker-calls.json')
  const rows = () => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>) : {})
  const text = () => (existsSync(file) ? readFileSync(file, 'utf8') : null)
  return { home, calls, post, rows, text, token, file, tick: (ms: number) => (t += ms), defTok }
}
const REP = { outcome: 'ready', summary: 'done' }
const body = async (r: Response) => JSON.parse(await r.text())

describe('worker API', () => {
  test('report: applies once with the token identity', async () => {
    const s = setup()
    const was = { o: process.env.FACTORY_OUTBOX, s: process.env.FACTORY_SERVER }
    process.env.FACTORY_OUTBOX = '/x'
    process.env.FACTORY_SERVER = 'https://x'
    try {
      const r = await s.post('/v1/report', REP)
      expect(r.status).toBe(200)
      expect((await body(r)).ok).toBe(true)
    } finally {
      if (was.o === undefined) delete process.env.FACTORY_OUTBOX
      else process.env.FACTORY_OUTBOX = was.o
      if (was.s === undefined) delete process.env.FACTORY_SERVER
      else process.env.FACTORY_SERVER = was.s
    }
    expect(s.calls.length).toBe(1)
    expect(s.calls[0]!.argv).toEqual(['report', 'r1', '2', 'ready', 'done'])
    expect(s.calls[0]!.text).toBeUndefined()
    const env = s.calls[0]!.env
    expect(env.FACTORY_FROM).toBe('plan')
    expect(env.FACTORY_RUN).toBe('r1')
    expect(env.FACTORY_HOME).toBe(s.home)
    expect(env.FACTORY_SELF_UPDATE).toBe('0')
    expect('FACTORY_OUTBOX' in env).toBe(false)
    expect('FACTORY_SERVER' in env).toBe(false)
    const rows = Object.values(s.rows())
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'report', status: 'applied', run: 'r1', node: 'plan', seq: 2 })
    expect(rows[0]!.token).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(rows[0])).not.toContain(s.defTok)
  })

  describe('idempotency', () => {
    test('a repeated key replays the first answer', async () => {
      const s = setup()
      const a = await s.post('/v1/report', REP, { key: 'same-key-1' })
      const b = await s.post('/v1/report', REP, { key: 'same-key-1' })
      expect(b.status).toBe(a.status)
      expect(await b.text()).toBe(await a.text())
      expect(s.calls.length).toBe(1)
      expect(Object.keys(s.rows()).length).toBe(1)
    })
    test('concurrent', async () => {
      const s = setup({ runner: async () => (await Bun.sleep(30), { code: 0, out: '', err: '' }) })
      const [a, b] = await Promise.all([
        s.post('/v1/report', REP, { key: 'same-key-1' }),
        s.post('/v1/report', REP, { key: 'same-key-1' }),
      ])
      expect([a.status, b.status]).toEqual([200, 200])
      expect(s.calls.length).toBe(1)
    })
    test('other body', async () => {
      const s = setup()
      await s.post('/v1/report', REP, { key: 'same-key-1' })
      const b = await s.post('/v1/report', { ...REP, summary: 'other' }, { key: 'same-key-1' })
      expect(b.status).toBe(409)
      expect(s.calls.length).toBe(1)
    })
    test('other token', async () => {
      const s = setup()
      await s.post('/v1/report', REP, { key: 'same-key-1' })
      const b = await s.post('/v1/report', REP, { key: 'same-key-1', token: s.token() })
      expect(b.status).toBe(409)
      expect(s.calls.length).toBe(1)
    })
    test('pending after a failed write', async () => {
      let home = ''
      const s = setup({
        runner: async () => {
          mkdirSync(join(home, 'worker-calls.json.tmp'))
          return { code: 0, out: '', err: '' }
        },
      })
      home = s.home
      const a = await s.post('/v1/report', REP, { key: 'same-key-1' })
      expect(a.status).toBe(500)
      const b = await s.post('/v1/report', REP, { key: 'same-key-1' })
      expect(b.status).toBe(409)
      expect(JSON.stringify(await body(b))).toContain('did not finish')
      expect(s.calls.length).toBe(1)
      expect(s.rows()['same-key-1'].status).toBe('pending')
    })
  })

  test('identity: a body that names another run, node or seq is refused', async () => {
    for (const path of ['/v1/report', '/v1/mail']) {
      const base = path === '/v1/report' ? REP : { to: 'manager', text: 'hi' }
      for (const extra of [{ run: 'r2' }, { node: 'review' }, { seq: 3 }, { seq: '2' }]) {
        const s = setup()
        const r = await s.post(path, { ...base, ...extra })
        expect(r.status).toBe(403)
        expect((await body(r)).refused).toContain('the token is for run r1 node plan seq 2')
        const rows = Object.values(s.rows())
        expect(rows.length).toBe(1)
        expect(rows[0]).toMatchObject({ run: 'r1', node: 'plan', seq: 2, status: 'refused' })
        expect(s.calls.length).toBe(0)
      }
    }
    const s = setup()
    const ok = await s.post('/v1/report', { run: 'r1', node: 'plan', seq: 2, ...REP })
    expect(ok.status).toBe(200)
    expect(s.calls.length).toBe(1)
  })

  test('row size: a big nested value or many keys do not grow the refused row', async () => {
    const big = { ...REP, run: Array.from({ length: 12000 }, () => 'x'.repeat(5)) }
    const many = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${i}`, 1]))
    for (const bodyIn of [big, { ...REP, ...many }]) {
      const s = setup()
      const r = await s.post('/v1/report', bodyIn)
      expect([400, 403]).toContain(r.status)
      const row = Object.values(s.rows())[0]!
      expect(row.status).toBe('refused')
      expect(JSON.stringify(row).length).toBeLessThan(4096)
      expect(s.calls.length).toBe(0)
    }
  })

  test('token: each bad token is refused before any row', async () => {
    const s = setup()
    const good = s.token()
    const parts = good.split('.')
    const sig = parts[2]!
    const changed = `${parts[0]}.${parts[1]}.${(sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)}`
    const expired = sign(s.home, KEY, { task: 't', run: 'r1', node: 'plan', seq: 2, exp: T0 + 10 }, T0)
    s.tick(1000)
    const revoked = s.token()
    const other = mkdtempSync(join(tmpdir(), 'sapi-w2-'))
    dirs.push(other)
    const foreign = sign(other, KEY, { task: 't', run: 'r1', node: 'plan', seq: 2, exp: T0 + 3600_000 }, T0)
    revoke(s.home, { run: 'r1', node: 'plan', seq: 2 }, T0 + 1)
    const bads: { token?: string | null; auth?: string }[] = [
      { token: null },
      { auth: 'Basic x' },
      { auth: 'Bearer' },
      { auth: 'Bearer a b' },
      { token: 'v1.zz.zz' },
      { token: changed },
      { token: expired },
      { token: revoked },
      { token: foreign },
    ]
    for (const b of bads) {
      const r = await s.post('/v1/report', REP, b)
      expect(r.status).toBe(403)
    }
    // the claims checks need a live token: use a fresh home with its own tokens
    const h2 = setup()
    for (const c of [{ run: '..' }, { run: '.' }, { node: '..' }, { node: 'manager' }]) {
      const r = await h2.post('/v1/report', REP, { token: h2.token(c) })
      expect(r.status).toBe(403)
      expect((await body(r)).refused).toBe('token claims are not a run station')
    }
    expect(s.text()).toBeNull()
    expect(h2.text()).toBeNull()
    expect(s.calls.length + h2.calls.length).toBe(0)
    // a run id with a dot is a good name
    state(h2.home, 'lifecycle-a.b', 'plan', 2)
    const ok = await h2.post('/v1/report', REP, { token: h2.token({ run: 'lifecycle-a.b' }) })
    expect(ok.status).toBe(200)
  })

  test('route: only the three worker routes', async () => {
    const s = setup()
    expect((await s.post('/v1/report', REP, { key: null })).status).toBe(400)
    expect((await s.post('/v1/report', REP, { key: 'short' })).status).toBe(400)
    expect(s.text()).toBeNull()
    for (const [path, method] of [
      ['/v1/report', 'GET'],
      ['/v1/runs/r1/decide', 'POST'],
      ['/v1/runs/r1/mail', 'POST'],
      ['/v1/memory/add', 'POST'],
      ['/v1/report?x=1', 'POST'],
    ] as const) {
      const r = await s.post(path, REP, { method })
      expect(r.status).toBe(404)
    }
    expect(s.calls.length).toBe(0)
    expect(s.text()).toBeNull()
  })

  test('body: the closed grammar of each endpoint', async () => {
    const big = (n: number) => 'x'.repeat(n)
    const cases: [string, unknown, { type?: string | null }?][] = [
      ['/v1/report', 'not json'],
      ['/v1/report', []],
      ['/v1/report', 'null'],
      ['/v1/report', JSON.stringify(REP), { type: 'text/plain' }],
      ['/v1/report', JSON.stringify({ ...REP, summary: big(131072) })],
      ['/v1/report', { ...REP, wake: true }],
      ['/v1/report', { summary: 'x' }],
      ['/v1/report', { outcome: 'Ready!', summary: 'x' }],
      ['/v1/report', { outcome: 'ready', summary: 7 }],
      ['/v1/report', { outcome: 'ready', summary: '  ' }],
      ['/v1/report', { outcome: 'ready', summary: big(102401) }],
      ['/v1/mail', { to: 'manager', text: 'x', wake: true }],
      ['/v1/mail', { to: 'a b', text: 'x' }],
      ['/v1/mail', { to: '--wake', text: 'x' }],
      ['/v1/mail', { to: '--text-file', text: 'x' }],
      ['/v1/mail', { to: 'manager', text: ' ' }],
      ['/v1/progress', { note: big(2001) }],
      ['/v1/progress', { note: ' ' }],
      ['/v1/progress', { note: 'x', extra: 1 }],
    ]
    for (const [path, b, over] of cases) {
      const s = setup()
      const r = await s.post(path, b, over)
      expect(r.status).toBe(400)
      expect(Object.values(s.rows()).length).toBe(1)
      expect(Object.values(s.rows())[0]!.status).toBe('refused')
      expect(s.calls.length).toBe(0)
    }
    const s = setup()
    const ok1 = await s.post('/v1/report', REP, { type: 'Application/JSON; charset=utf-8' })
    expect(ok1.status).toBe(200)
    const ok2 = await s.post('/v1/report', { outcome: 'ready', summary: big(102400) })
    expect(ok2.status).toBe(200)
  })

  test('station: an old seq or another node is refused', async () => {
    const bodies: [string, unknown][] = [
      ['/v1/report', REP],
      ['/v1/mail', { to: 'manager', text: 'hi' }],
      ['/v1/progress', { note: 'x' }],
    ]
    for (const [path, b] of bodies) {
      for (const st of ['seq3', 'review', 'missing', 'empty', 'garbage'] as const) {
        const s = setup()
        if (st === 'seq3') state(s.home, 'r1', 'plan', 3)
        if (st === 'review') state(s.home, 'r1', 'review', 2)
        if (st === 'missing') rmSync(join(s.home, 'runs', 'r1', 'state.json'))
        if (st === 'garbage') writeFileSync(join(s.home, 'runs', 'r1', 'state.json'), '{')
        if (st === 'empty')
          writeFileSync(
            join(s.home, 'runs', 'r1', 'state.json'),
            JSON.stringify({ cursor: 0, snapshot: { value: {}, context: { seq: 2 } } }),
          )
        const r = await s.post(path, b)
        expect(r.status).toBe(409)
        expect(Object.values(s.rows())[0]!.status).toBe('refused')
        expect(s.calls.length).toBe(0)
      }
    }
  })

  test('apply: a CLI refusal is a refused row', async () => {
    const s = setup({ result: { code: 1, out: '', err: 'outcome must be one of: ready\n' } })
    const a = await s.post('/v1/report', REP, { key: 'same-key-1' })
    expect(a.status).toBe(409)
    expect(await body(a)).toEqual({ refused: 'outcome must be one of: ready' })
    expect(s.rows()['same-key-1']).toMatchObject({
      status: 'refused',
      reason: 'outcome must be one of: ready',
    })
    const b = await s.post('/v1/report', REP, { key: 'same-key-1' })
    expect(b.status).toBe(409)
    expect(s.calls.length).toBe(1)

    const t = setup({ result: { code: 1, out: '', err: '', timedOut: true } })
    expect((await t.post('/v1/report', REP)).status).toBe(504)
    expect(Object.values(t.rows())[0]!.status).toBe('refused')

    const x = setup({
      runner: async () => {
        throw new Error('boom')
      },
    })
    const r = await x.post('/v1/report', REP)
    expect(r.status).toBe(500)
    expect(await body(r)).toEqual({ refused: 'internal error' })
    expect(Object.values(x.rows())[0]).toMatchObject({ status: 'refused', reason: 'internal error' })
  })

  test('mail and progress', async () => {
    const s = setup()
    const m = await s.post('/v1/mail', { to: 'manager', text: '--wake hi' })
    expect(m.status).toBe(200)
    expect(s.calls[0]!.argv).toEqual(['mail', 'r1', 'manager'])
    expect(s.calls[0]!.text).toBe('--wake hi')
    expect(s.calls[0]!.env.FACTORY_FROM).toBe('plan')
    expect(s.calls[0]!.env.FACTORY_RUN).toBe('r1')
    const p = await s.post('/v1/progress', { note: 'x' })
    expect(p.status).toBe(200)
    expect(await body(p)).toEqual({ ok: true })
    expect(s.calls.length).toBe(1)
    expect(Object.values(s.rows()).map(r => r.kind)).toEqual(['mail', 'progress'])
  })

  test('store: lease, corrupt file, 7 day window', async () => {
    const a = setup({ held: () => false })
    expect((await a.post('/v1/report', REP)).status).toBe(503)
    expect(a.text()).toBeNull()
    expect(a.calls.length).toBe(0)

    let n = 0
    const b = setup({ held: () => ++n === 1 })
    expect((await b.post('/v1/report', REP)).status).toBe(503)
    expect(b.text()).toBeNull()
    expect(b.calls.length).toBe(0)

    const c = setup()
    writeFileSync(c.file, '{')
    expect((await c.post('/v1/report', REP)).status).toBe(503)
    expect(c.text()).toBe('{')
    expect(c.calls.length).toBe(0)
  })

  test('store: rows older than 7 days are dropped and replay only inside', async () => {
    const d = setup()
    const long = (c: number) =>
      sign(d.home, KEY, { task: 't', run: 'r1', node: 'plan', seq: 2, exp: T0 + c }, T0)
    const tok = long(20 * DAY)
    await d.post('/v1/report', REP, { key: 'old-key-001', token: tok })
    d.tick(6 * DAY)
    await d.post('/v1/report', REP, { key: 'old-key-001', token: tok })
    expect(d.calls.length).toBe(1)
    d.tick(2 * DAY) // 8 days after the first call
    await d.post('/v1/report', REP, { key: 'new-key-001', token: tok })
    expect(d.rows()['old-key-001']).toBeUndefined()
    expect(d.rows()['new-key-001']).toBeDefined()
    await d.post('/v1/report', REP, { key: 'old-key-001', token: tok })
    expect(d.calls.length).toBe(3)
  })
})
