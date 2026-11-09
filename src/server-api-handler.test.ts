import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Port } from './core/catalog'
import { clientHandler, type RunResult } from './server-api'

type Call = { argv: string[]; text?: string } | { port: string; args: unknown[] }
let seq = 0
const setup = (o: { board?: unknown; result?: Partial<RunResult> } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'sapi-h-'))
  const calls: Call[] = []
  const logs: string[] = []
  const run = async (argv: string[], text?: string): Promise<RunResult> => {
    calls.push({ argv, text })
    return { code: 0, out: '{"ok":1}\n', err: '', ...o.result }
  }
  // each port function logs into the same array as the runner, so a "zero calls" check counts both
  const log = (port: string, args: unknown[]) => calls.push({ port, args })
  const port: Port = {
    show: async id => (log('show', [id]), { ok: 1 }),
    status: async (id, print) => (log('status', [id]), print('{"ok":1}')),
    backlog: async () => (log('backlog', []), { ok: 1 }),
    prs: async () => (log('prs', []), { ok: 1 }),
    decisionsList: () => (log('decisionsList', []), { ok: 1 }),
    planShowText: () => (log('planShowText', []), '{"ok":1}'),
    gateBriefFacts: async id => (log('gateBriefFacts', [id]), { ok: 1 }),
    records: () => (log('records', []), []),
    refreshMerges: async recs => (log('refreshMerges', [recs]), []),
    managerUsage: since => (log('managerUsage', [typeof since]), []),
    rigList: async print => (log('rigList', []), print('{"ok":1}')),
    decide: async (id, outcome, note, print) => (log('decide', [id, outcome, note]), print('{"ok":1}')),
    decisionsAnswer: (rig, bead, text, print) => (
      log('decisionsAnswer', [rig, bead, text]),
      print('{"ok":1}')
    ),
    goto: async (id, node, print) => (log('goto', [id, node]), print('{"ok":1}')),
    abort: id => void log('abort', [id]),
  }
  const make = () =>
    clientHandler({
      home,
      run,
      port,
      board: () => (o.board === undefined ? null : o.board),
      log: l => logs.push(l),
    })
  return { home, calls, logs, h: make(), make }
}
type H = ReturnType<typeof setup>['h']
const get = (h: H, path: string, headers: Record<string, string> = {}) =>
  h(new Request(`http://x${path}`, { headers }), '1.2.3.4')
const post = (
  h: H,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  key = `key-${String(++seq).padStart(8, '0')}`,
) =>
  h(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    '1.2.3.4',
  )

describe('read routes', () => {
  // the moved reads run in process: the port call and its arguments, never the runner
  const p = (port: string, ...args: unknown[]): Call => ({ port, args })
  const rows: [string, Call[]][] = [
    ['/v1/runs/r1', [p('show', 'r1')]],
    ['/v1/status', [p('status', undefined)]],
    ['/v1/status?run=r1', [p('status', 'r1')]],
    ['/v1/prs', [p('prs')]],
    ['/v1/backlog', [p('backlog')]],
    ['/v1/decisions', [p('decisionsList')]],
    ['/v1/rigs', [p('rigList')]],
    ['/v1/plan', [p('planShowText')]],
    ['/v1/runs/r1/brief', [p('gateBriefFacts', 'r1')]],
  ]
  for (const [path, calls] of rows)
    test(`GET ${path} calls the port`, async () => {
      const t = setup()
      const r = await get(t.h, path)
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('{"ok":1}\n')
      expect(t.calls).toEqual(calls)
    })
  test('GET /v1/metrics reads the records and the merges', async () => {
    const t = setup()
    expect((await get(t.h, '/v1/metrics')).status).toBe(200)
    expect(t.calls).toEqual([p('records'), p('refreshMerges', [])])
  })
  test('GET /v1/metrics with every input also reads the manager usage', async () => {
    const t = setup()
    expect((await get(t.h, '/v1/metrics?rig=acme&since=7d&json=1&tokens=1')).status).toBe(200)
    expect(t.calls).toEqual([p('records'), p('refreshMerges', []), p('managerUsage', 'number')])
  })
  test('GET /v1/lease calls no port function and answers the lease line', async () => {
    const t = setup()
    const r = await get(t.h, '/v1/lease')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('nobody holds the manager lease\n')
    expect(t.calls).toEqual([])
  })
  test('the lease is shown to the person even when the server env says patrol (personEnv)', async () => {
    const old = process.env.FACTORY_PATROL
    process.env.FACTORY_PATROL = '1'
    try {
      expect((await get(setup().h, '/v1/lease')).status).toBe(200)
    } finally {
      if (old === undefined) delete process.env.FACTORY_PATROL
      else process.env.FACTORY_PATROL = old
    }
  })
  test('a moved read that throws gives 422 with the CLI line', async () => {
    const t = setup()
    const r = await get(t.h, '/v1/metrics?since=0d')
    expect(r.status).toBe(422)
    expect(JSON.parse(await r.text()).refused).toBe(
      'factory: usage: factory metrics [--rig r] [--since <days>d] [--json] [--tokens]\n',
    )
    expect(t.calls).toEqual([])
  })
  test('GET /v1/board answers the last tick and runs nothing; 503 before the first tick', async () => {
    const t = setup({ board: { runs: [] } })
    const r = await get(t.h, '/v1/board')
    expect(r.status).toBe(200)
    expect(JSON.parse(await r.text())).toEqual({ runs: [] })
    const u = setup()
    expect((await get(u.h, '/v1/board')).status).toBe(503)
    expect(t.calls.length + u.calls.length).toBe(0)
  })
  test('a non-zero exit gives 422 with the stderr, a timeout gives 504', async () => {
    const t = setup({ result: { code: 1, out: '', err: 'x'.repeat(900) } })
    const r = await post(t.h, '/v1/halt', { mode: 'stop' })
    expect(r.status).toBe(422)
    expect(JSON.parse(await r.text()).refused.length).toBe(500)
    const u = setup({ result: { code: -1, timedOut: true } })
    expect((await post(u.h, '/v1/halt', { mode: 'stop' })).status).toBe(504)
  })
})

describe('action routes', () => {
  const p = (port: string, ...args: unknown[]): Call => ({ port, args })
  const rows: [string, unknown, Call[]][] = [
    ['/v1/runs/r1/decide', { outcome: 'approve', note: 'ok' }, [p('decide', 'r1', 'approve', 'ok')]],
    ['/v1/runs/r1/decide', { outcome: 'approve', note: '' }, [p('decide', 'r1', 'approve', '')]],
    [
      '/v1/runs/r1/mail',
      { to: 'plan', text: 'hello', from: 'manager', cwd: '/elsewhere' },
      [{ argv: ['mail', 'r1', 'plan'], text: 'hello' }],
    ],
    [
      '/v1/runs/r1/mail',
      { to: 'plan', text: 'hi', from: 'manager', cwd: '/elsewhere', wake: true },
      [{ argv: ['mail', 'r1', 'plan', '--wake'], text: 'hi' }],
    ],
    ['/v1/runs/r1/goto', { node: 'plan' }, [p('goto', 'r1', 'plan')]],
    ['/v1/runs/r1/abort', {}, [p('abort', 'r1')]],
    [
      '/v1/start',
      { factory: 'lifecycle', rig: 'acme', goal: 'do it' },
      [{ argv: ['start', 'lifecycle', 'acme', 'do it'] }],
    ],
    [
      '/v1/start',
      { factory: 'lifecycle', station: 'plan', rig: 'acme', goal: 'g', owned: true },
      [{ argv: ['start', 'lifecycle@plan', 'acme', 'g', '--owned'] }],
    ],
    ['/v1/halt', { mode: 'stop' }, [{ argv: ['stop'] }]],
    ['/v1/halt', { mode: 'resume' }, [{ argv: ['resume'] }]],
    ['/v1/decisions/acme/b1/answer', { text: 'yes' }, [p('decisionsAnswer', 'acme', 'b1', 'yes')]],
  ]
  for (const [path, body, calls] of rows)
    test(`POST ${path} ${JSON.stringify(body).slice(0, 40)}`, async () => {
      const t = setup()
      const r = await post(t.h, path, body)
      expect(r.status).toBe(200)
      expect(t.calls).toEqual(calls)
    })
})

describe('refusals make zero calls', () => {
  const ok = { outcome: 'approve', note: '' }
  const bad: [string, (h: H) => Promise<Response>, number][] = [
    ['Authorization on a GET', h => get(h, '/v1/prs', { authorization: 'Bearer x' }), 403],
    [
      'Authorization v1 token',
      h => post(h, '/v1/runs/r1/decide', ok, { authorization: 'Bearer v1.a.b' }),
      403,
    ],
    ['Authorization empty', h => get(h, '/v1/prs', { authorization: '' }), 403],
    ['Authorization on an unknown path', h => get(h, '/nope', { authorization: 'x' }), 403],
    ['unknown path', h => get(h, '/v1/nope'), 404],
    ['rigs with a query', h => get(h, '/v1/rigs?x=1'), 400],
    ['events not served', h => get(h, '/v1/events'), 404],
    ['rigs PUT', h => h(new Request('http://x/v1/rigs/a', { method: 'PUT', body: '{}' }), 'ip'), 404],
    ['rigs DELETE', h => h(new Request('http://x/v1/rigs/a', { method: 'DELETE' }), 'ip'), 404],
    ['GET on a POST path', h => get(h, '/v1/halt'), 404],
    ['POST on a GET path', h => post(h, '/v1/prs', {}), 404],
    ['extra query', h => get(h, '/v1/prs?x=1'), 400],
    ['brief with an encoded slash', h => get(h, '/v1/runs/..%2f/brief'), 400],
    ['brief with two segments', h => get(h, '/v1/runs/a/b/brief'), 404],
    ['lease with a query', h => get(h, '/v1/lease?x=1'), 400],
    ['POST on the lease', h => post(h, '/v1/lease', {}), 404],
    ['status run with dots', h => get(h, '/v1/status?run=../x'), 400],
    ['unknown query key', h => get(h, '/v1/status?x=1'), 400],
    ['duplicate query key', h => get(h, '/v1/status?run=a&run=b'), 400],
    ['bad query value', h => get(h, '/v1/metrics?json=2'), 400],
    ['encoded slash seg', h => get(h, '/v1/runs/..%2Fx'), 400],
    ['leading dot seg', h => get(h, '/v1/runs/.x'), 400],
    ['dotdot seg (the URL parser drops it)', h => get(h, '/v1/runs/..'), 404],
    ['long seg', h => get(h, `/v1/runs/${'a'.repeat(129)}`), 400],
    ['query on a POST', h => post(h, '/v1/halt?x=1', { mode: 'stop' }), 400],
    ['missing key', h => post(h, '/v1/halt', { mode: 'stop' }, { 'idempotency-key': '' }), 400],
    ['short key', h => post(h, '/v1/halt', { mode: 'stop' }, {}, 'abc'), 400],
    ['bad key chars', h => post(h, '/v1/halt', { mode: 'stop' }, {}, 'abcdefgh!'), 400],
    ['no content-type', h => post(h, '/v1/halt', { mode: 'stop' }, { 'content-type': 'text/plain' }), 400],
    ['extra body key', h => post(h, '/v1/halt', { mode: 'stop', x: 1 }), 400],
    ['missing body key', h => post(h, '/v1/halt', {}), 400],
    ['wrong type', h => post(h, '/v1/halt', { mode: 1 }), 400],
    ['bad enum', h => post(h, '/v1/halt', { mode: 'pause' }), 400],
    ['array body', h => post(h, '/v1/halt', '[]'), 400],
    ['null body', h => post(h, '/v1/halt', 'null'), 400],
    ['not json', h => post(h, '/v1/halt', '{'), 400],
    ['body over 128 KiB', h => post(h, '/v1/decisions/a/b/answer', { text: 'x'.repeat(140000) }), 400],
    ['text over 65536', h => post(h, '/v1/decisions/a/b/answer', { text: 'x'.repeat(65537) }), 400],
    ['empty text', h => post(h, '/v1/decisions/a/b/answer', { text: '' }), 400],
    ['NUL in text', h => post(h, '/v1/decisions/a/b/answer', { text: 'a\u0000b' }), 400],
    ['bad outcome seg', h => post(h, '/v1/runs/r1/decide', { outcome: '-x', note: '' }), 400],
    ['goal with --owned', h => post(h, '/v1/start', { factory: 'f', rig: 'r', goal: 'a --owned b' }), 400],
    ['owned false', h => post(h, '/v1/start', { factory: 'f', rig: 'r', goal: 'g', owned: false }), 400],
    [
      'mail from not manager',
      h => post(h, '/v1/runs/r1/mail', { to: 'p', text: 't', from: 'plan', cwd: '/x' }),
      400,
    ],
    [
      'mail cwd relative',
      h => post(h, '/v1/runs/r1/mail', { to: 'p', text: 't', from: 'manager', cwd: 'x' }),
      400,
    ],
    [
      'wake false',
      h => post(h, '/v1/runs/r1/mail', { to: 'p', text: 't', from: 'manager', cwd: '/x', wake: false }),
      400,
    ],
  ]
  for (const [name, f, status] of bad)
    test(name, async () => {
      const t = setup()
      const r = await f(t.h)
      expect(r.status).toBe(status)
      expect(t.calls.length).toBe(0)
      expect(existsSync(join(t.home, 'client-idempotency.json'))).toBe(false)
      expect(existsSync(join(t.home, 'client-actions.jsonl'))).toBe(false)
    })
})

describe('mail cwd', () => {
  const wt = (t: ReturnType<typeof setup>) => {
    mkdirSync(join(t.home, 'runs', 'r1'), { recursive: true })
    writeFileSync(join(t.home, 'runs', 'r1', 'run.json'), JSON.stringify({ worktree: '/wt', repo: '/repo' }))
  }
  const mail = (t: ReturnType<typeof setup>, cwd: string) =>
    post(t.h, '/v1/runs/r1/mail', { to: 'plan', text: 't', from: 'manager', cwd })
  test('equal to the worktree or under it gives 403 and no call', async () => {
    const t = setup()
    wt(t)
    expect((await mail(t, '/wt')).status).toBe(403)
    expect((await mail(t, '/wt/sub/dir')).status).toBe(403)
    expect((await mail(t, '/wt/../wt/x')).status).toBe(403)
    expect(t.calls.length).toBe(0)
  })
  test('a sibling that shares a prefix passes', async () => {
    const t = setup()
    wt(t)
    expect((await mail(t, '/wt-other')).status).toBe(200)
    expect(t.calls.length).toBe(1)
  })
  test('a run whose worktree is its repo has no worktree to guard', async () => {
    const t = setup()
    mkdirSync(join(t.home, 'runs', 'r1'), { recursive: true })
    writeFileSync(
      join(t.home, 'runs', 'r1', 'run.json'),
      JSON.stringify({ worktree: '/repo', repo: '/repo' }),
    )
    expect((await mail(t, '/repo/x')).status).toBe(200)
  })
})

describe('idempotency', () => {
  const body = { mode: 'stop' }
  test('the same key and request replays the stored answer with one call, also after a restart', async () => {
    const t = setup()
    const a = await post(t.h, '/v1/halt', body, {}, 'key-same-0001')
    const b = await post(t.h, '/v1/halt', body, {}, 'key-same-0001')
    const c = await post(t.make(), '/v1/halt', body, {}, 'key-same-0001')
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(await b.text()).toBe(await a.text())
    expect(t.calls.length).toBe(1)
  })
  test('the same key with another request gives 409 and no call', async () => {
    const t = setup()
    await post(t.h, '/v1/halt', body, {}, 'key-same-0002')
    const r = await post(t.h, '/v1/halt', { mode: 'resume' }, {}, 'key-same-0002')
    expect(r.status).toBe(409)
    expect(t.calls.length).toBe(1)
  })
  test('the store is 0600 and rows older than 24 h are pruned', async () => {
    const t = setup()
    const f = join(t.home, 'client-idempotency.json')
    writeFileSync(
      f,
      JSON.stringify({
        'old-key-0001': { at: Date.now() - 25 * 3600_000, hash: 'x', status: 200, body: '' },
      }),
    )
    await post(t.h, '/v1/halt', body, {}, 'key-new-0001')
    const rows = JSON.parse(readFileSync(f, 'utf8'))
    expect(Object.keys(rows)).toEqual(['key-new-0001'])
    expect(require('node:fs').statSync(f).mode & 0o777).toBe(0o600)
  })
  test('an expired row is not replayed', async () => {
    const t = setup()
    writeFileSync(
      join(t.home, 'client-idempotency.json'),
      JSON.stringify({
        'old-key-0002': { at: Date.now() - 25 * 3600_000, hash: 'x', status: 200, body: 'stale' },
      }),
    )
    const r = await post(t.h, '/v1/halt', body, {}, 'old-key-0002')
    expect(await r.text()).toBe('{"ok":1}\n')
    expect(t.calls.length).toBe(1)
  })
  for (const bad of ['{', '[]', 'null', '"x"'])
    test(`a corrupt store (${bad}) gives 503 and no call`, async () => {
      const t = setup()
      writeFileSync(join(t.home, 'client-idempotency.json'), bad)
      const r = await post(t.h, '/v1/halt', body)
      expect(r.status).toBe(503)
      expect(t.calls.length).toBe(0)
      expect(readFileSync(join(t.home, 'client-idempotency.json'), 'utf8')).toBe(bad)
    })
  test('two calls with one key at once run the action once', async () => {
    const t = setup()
    const rs = await Promise.all([
      post(t.h, '/v1/halt', body, {}, 'key-race-0001'),
      post(t.h, '/v1/halt', body, {}, 'key-race-0001'),
    ])
    expect(rs.map(r => r.status)).toEqual([200, 200])
    expect(t.calls.length).toBe(1)
  })
})

describe('audit', () => {
  test('a decide writes one line with ip and outcome and no note text', async () => {
    const t = setup()
    await post(t.h, '/v1/runs/r1/decide', { outcome: 'approve', note: 'SECRET-NOTE' }, {}, 'key-audit-0001')
    const raw = readFileSync(join(t.home, 'client-actions.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines.length).toBe(1)
    const l = JSON.parse(lines[0]!)
    expect(l).toMatchObject({
      ip: '1.2.3.4',
      method: 'POST',
      path: '/v1/runs/r1/decide',
      key: 'key-audit-0001',
      status: 200,
      outcome: 'approve',
    })
    expect(Number.isFinite(Date.parse(l.at))).toBe(true)
    expect(raw).not.toContain('SECRET-NOTE')
    expect(t.logs).toEqual(['client POST /v1/runs/r1/decide 200 from 1.2.3.4'])
  })
  test('a goto has no outcome field and a GET writes no line', async () => {
    const t = setup()
    await post(t.h, '/v1/runs/r1/goto', { node: 'plan' })
    await get(t.h, '/v1/prs')
    const lines = readFileSync(join(t.home, 'client-actions.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect('outcome' in JSON.parse(lines[0]!)).toBe(false)
  })
})
