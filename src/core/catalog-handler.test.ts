import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientHandler, type RunResult } from '../server-api'
import type { Port } from './catalog'
import { CATALOG } from './catalog'

// the board and catalog tests call no port function
const port = new Proxy({} as Port, {
  get: (_t, k) => () => {
    throw new Error(`port.${String(k)} must not be called`)
  },
})
const setup = (board: () => unknown = () => null) => {
  const home = mkdtempSync(join(tmpdir(), 'cat-h-'))
  const calls: string[][] = []
  const run = async (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    return { code: 0, out: 'ok\n', err: '' }
  }
  const logs: string[] = []
  return { home, logs, calls, h: clientHandler({ home, run, port, board, log: s => logs.push(s) }) }
}
type H = ReturnType<typeof setup>['h']
const get = (h: H, path: string) => h(new Request(`http://x${path}`), '1.2.3.4')
let seq = 0
const post = (h: H, path: string, body: unknown) =>
  h(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `key-${String(++seq).padStart(8, '0')}`,
      },
      body: JSON.stringify(body),
    }),
    '1.2.3.4',
  )

const NAMES = [
  'backlog.show',
  'board.show',
  'catalog.echo',
  'catalog.show',
  'chat.send',
  'chat.show',
  'decisions.answer',
  'decisions.list',
  'factory.halt',
  'flows.show',
  'gates.brief',
  'gates.decide',
  'gc.run',
  'guard.check',
  'lease.show',
  'mail.list',
  'manager.brief',
  'manager.context',
  'manager.log',
  'manager.say',
  'manager.show',
  'metrics.show',
  'plan.show',
  'prs.show',
  'rigs.list',
  'runners.show',
  'runs.abort',
  'runs.goto',
  'runs.mail',
  'runs.screen',
  'runs.show',
  'runs.start',
  'runs.status',
  'snapshot.show',
  'steps.reports',
]

test('n69b2 AC1 gc route has no GET mutation or CLI bridge', async () => {
  const calls: string[] = []
  const gcPort = new Proxy({} as Port, {
    get:
      (_t, key) =>
      (...args: any[]) => {
        calls.push(String(key))
        if (key === 'gcHold') return () => calls.push('release')
        if (key === 'gcRigs') return ['acme']
        if (key === 'gcPass') {
          args[2]('plain')
          args[3]('skip diagnostic')
          if (args[0] === 1) throw new Error('gc failed')
        }
        if (key === 'gcWorktreesPass') args[2]('worktrees')
      },
  })
  const home = mkdtempSync(join(tmpdir(), 'gc-handler-'))
  let cliCalls = 0
  const h = clientHandler({
    home,
    port: gcPort,
    board: () => null,
    run: async () => {
      cliCalls++
      throw new Error('no CLI bridge')
    },
  })
  expect((await get(h, '/v1/gc')).status).toBe(404)
  expect(calls).toEqual([])
  for (const [body, out] of [
    [{}, 'plain\n'],
    [{ worktrees: true, dryRun: true, rig: 'acme' }, 'worktrees\n'],
  ] as const) {
    const r = await post(h, '/v1/gc', body)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(await r.json()).toEqual({ code: 0, out, err: body.worktrees ? '' : 'skip diagnostic\n' })
  }
  const repeat = () =>
    h(
      new Request('http://x/v1/gc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'aaaaaaaaaaaa' },
        body: '{"dryRun":true}',
      }),
      'ip',
    )
  const first = await repeat()
  const second = await repeat()
  expect(await second.text()).toBe(await first.text())
  expect(calls.filter(c => c === 'gcPass')).toHaveLength(2)
  expect(calls.filter(c => c === 'gcWorktreesPass')).toHaveLength(1)
  const failed = await post(h, '/v1/gc', { days: '1' })
  expect(failed.status).toBe(422)
  expect(await failed.json()).toEqual({ refused: 'skip diagnostic\nfactory: gc failed\n' })
  expect(calls.filter(c => c === 'gcPass')).toHaveLength(3)
  expect(cliCalls).toBe(0)
})

test('n69b2 AC2 gc transport and invalid input refuse before every port effect', async () => {
  const calls: string[] = []
  const h = clientHandler({
    home: mkdtempSync(join(tmpdir(), 'gc-denial-')),
    board: () => null,
    run: async () => {
      calls.push('cli')
      throw new Error('unexpected CLI call')
    },
    port: new Proxy({} as Port, {
      get: (_target, key) => () => {
        calls.push(`port.${String(key)}`)
        throw new Error('unexpected port effect')
      },
    }),
  })
  for (const body of [
    null,
    [],
    { path: '/x' },
    { dryRun: false },
    { days: 7 },
    { days: 'Infinity' },
    { days: '0x7' },
    { rig: 'acme' },
    { worktrees: true, days: '7' },
  ]) {
    expect((await post(h, '/v1/gc', body)).status).toBeGreaterThanOrEqual(400)
  }
  expect((await post(h, '/v1/gc?dryRun=1', {})).status).toBe(400)
  for (const [headers, status] of [
    [{ authorization: 'Bearer v1.a.b' }, 403],
    [{ 'content-type': 'text/plain', 'idempotency-key': 'gc-key-123' }, 400],
    [{ 'content-type': 'application/json' }, 400],
  ] as const) {
    expect(
      (await h(new Request('http://x/v1/gc', { method: 'POST', headers, body: '{"dryRun":true}' }), 'ip'))
        .status,
    ).toBe(status)
  }
  expect(calls).toEqual([])
})

describe('GET /v1/catalog', () => {
  test('serves the envelope with the 30 operations', async () => {
    const { h, calls } = setup()
    const r = await get(h, '/v1/catalog')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
    const j = (await r.json()) as any
    expect(j.schemaVersion).toBe(1)
    expect(typeof j.factoryId).toBe('string')
    expect(j.revision).toBe(0)
    expect(new Date(j.observedAt).toISOString()).toBe(j.observedAt)
    expect(j.data.version).toBe(1)
    expect(j.data.operations.map((o: any) => o.name)).toEqual(NAMES)
    for (const o of j.data.operations)
      expect(Object.keys(o).sort()).toEqual(
        ['inputs', 'long', 'mutates', 'name', 'output', 'rights', 'route', 'since', 'summary'].sort(),
      )
    const abort = j.data.operations.find((o: any) => o.name === 'runs.abort')
    expect(abort.summary).toBe('Abort a run and close its worker.')
    expect(abort.inputs).toEqual([{ name: 'id', kind: 'id', required: true, help: 'the run id' }])
    expect(abort.route).toEqual({ method: 'POST', path: '/v1/runs/:id/abort' })
    expect(calls).toEqual([])
  })
  test('refuses a query and a POST', async () => {
    const { h } = setup()
    expect((await get(h, '/v1/catalog?x=1')).status).toBe(400)
    expect((await post(h, '/v1/catalog', {})).status).toBe(404)
  })
})

describe('guard.check', () => {
  const check = (h: H, body: string, headers: Record<string, string> = {}) =>
    h(
      new Request('http://x/v1/guard/check', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...headers },
      }),
      '1.2.3.4',
    )
  const clean = (t: ReturnType<typeof setup>) => {
    expect(existsSync(join(t.home, 'client-idempotency.json'))).toBe(false)
    expect(existsSync(join(t.home, 'client-actions.jsonl'))).toBe(false)
    expect(t.calls).toEqual([])
    expect(t.logs).toEqual([])
  }
  test('answers without a key, runner call, audit, or idempotency file', async () => {
    const t = setup()
    for (const [command, role, decision] of [
      ['factory decide r1 ok', 'manager', 'ask'],
      ['factory status', 'manager', 'allow'],
      ['bd close x', 'subagent', 'deny'],
    ]) {
      const r = await check(t.h, JSON.stringify({ command, role }))
      expect(r.status).toBe(200)
      const body = (await r.json()) as any
      expect(body.decision).toBe(decision)
      if (decision === 'ask') expect(body.question).toContain('Allow it?')
    }
    expect(
      (await check(t.h, '{"command":"factory status","role":"manager"}', { 'idempotency-key': 'x' })).status,
    ).toBe(200)
    clean(t)
  })
  for (const body of [
    { role: 'manager' },
    { command: '', role: 'manager' },
    { command: 'x'.repeat(65537), role: 'manager' },
    { command: '\u0000', role: 'manager' },
    { command: 5, role: 'manager' },
    { command: 'x', role: 'person' },
    { command: 'x' },
    { command: 'x', role: 'manager', cwd: '/x' },
    [],
    { command: '"'.repeat(65536), role: 'manager' },
  ])
    test(`rejects bad body ${JSON.stringify(body).slice(0, 80)}`, async () => {
      const t = setup()
      expect((await check(t.h, JSON.stringify(body))).status).toBe(400)
      clean(t)
    })
  test('rejects bad JSON, content type, method, and worker authorization', async () => {
    const t = setup()
    expect((await check(t.h, 'no')).status).toBe(400)
    expect((await check(t.h, '{}', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await get(t.h, '/v1/guard/check')).status).toBe(404)
    expect((await check(t.h, '{}', { authorization: 'Bearer x' })).status).toBe(403)
    clean(t)
  })
  test('an internal error gives 500 without files or logs', async () => {
    const op = CATALOG.find(o => o.name === 'guard.check')!
    const run = op.run
    const t = setup()
    try {
      op.run = async () => {
        throw new Error('guard failed')
      }
      const r = await check(t.h, '{"command":"x","role":"manager"}')
      expect(r.status).toBe(500)
      expect(await r.json()).toEqual({ refused: 'internal error: guard failed' })
      clean(t)
    } finally {
      op.run = run
    }
  })
})

describe('catalog.echo', () => {
  test('returns the text with no runner call', async () => {
    const { h, calls } = setup()
    const r = await get(h, '/v1/catalog/echo?text=hi')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hi\n')
    expect(calls).toEqual([])
  })
  for (const q of ['', '?text=', '?text=a%00b', '?text=a&x=1', '?text=a&text=b'])
    test(`refuses ${q || 'no query'}`, async () => {
      const { h, calls } = setup()
      expect((await get(h, `/v1/catalog/echo${q}`)).status).toBe(400)
      expect(calls).toEqual([])
    })
})

describe('input checks', () => {
  for (const p of [
    '/v1/board?x=1',
    '/v1/board?slim=x',
    '/v1/board?slim=1&slim=1',
    '/v1/prs?&',
    '/v1/prs?toString=x',
    '/v1/status?__proto__=x',
    '/v1/runs/a%2Eb',
  ])
    test(`GET ${p} gives 400`, async () => {
      const { h, calls } = setup(() => ({ runs: [] }))
      expect((await get(h, p)).status).toBe(400)
      expect(calls).toEqual([])
    })
  for (const [p, b] of [
    ['/v1/halt?&', { mode: 'stop' }],
    ['/v1/halt', { mode: 'stop', toString: 'x' }],
    ['/v1/runs/r1/goto', { node: 'plan', id: 'r2' }],
  ] as [string, unknown][])
    test(`POST ${p} gives 400`, async () => {
      const { h, calls } = setup()
      expect((await post(h, p, b)).status).toBe(400)
      expect(calls).toEqual([])
    })
  test('the board is JSON', async () => {
    const { h } = setup(() => ({ runs: [] }))
    const r = await get(h, '/v1/board')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
  })
  test('a board value that does not start with a brace is still JSON', async () => {
    const r = await get(setup(() => 'idle').h, '/v1/board')
    expect(r.headers.get('content-type')).toBe('application/json')
  })
  test('board.show omits private rig fields', async () => {
    const rig = {
      name: 'alpha',
      repo: 'acme/widget',
      factory: 'lifecycle',
      maxRuns: 0,
      sweeps: [],
      goal: 'ship acme',
      runner: 'ax',
      sandboxClass: 'gvisor',
      linear: { team: ['T1'], projects: ['p1'], labels: ['l1'], zqExtra: 'zqsecret' },
      linearSync: {
        at: 5,
        pulled: 3,
        created: 1,
        updated: 2,
        stripped: 0,
        unrouted: 1,
        error: 'boom',
        zqExtra: 'zqsecret',
      },
      env: { FOO: 'zqsecret', API_KEY: 'zqsecret' },
      params: { FOO: 'zqsecret', API_KEY: 'zqsecret' },
      beadsRemote: 'https://user:zqsecret@example.test/x',
      zqUnknown: 'zqsecret',
    }
    const bare = { name: 'beta', repo: 'acme/gadget', factory: 'lifecycle', env: { FOO: 'zqsecret' } }
    const { h, calls, logs } = setup(() => ({ runs: [{ id: 'r1' }], halt: null, rigs: [rig, bare] }))
    const r = await get(h, '/v1/board')
    const text = await r.text()
    expect(r.status).toBe(200)
    expect(text).not.toContain('zqsecret')
    for (const k of ['env', 'params', 'beadsRemote', 'zqUnknown', 'zqExtra']) expect(text).not.toContain(k)
    const body = JSON.parse(text)
    expect(body.runs).toEqual([{ id: 'r1' }])
    expect(body.rigs[0]).toEqual({
      name: 'alpha',
      repo: 'acme/widget',
      factory: 'lifecycle',
      maxRuns: 0,
      sweeps: [],
      goal: 'ship acme',
      runner: 'ax',
      sandboxClass: 'gvisor',
      linear: { team: ['T1'], projects: ['p1'], labels: ['l1'] },
      linearSync: { at: 5, pulled: 3, created: 1, updated: 2, stripped: 0, unrouted: 1, error: 'boom' },
    })
    expect(body.rigs[1]).toEqual({ name: 'beta', repo: 'acme/gadget', factory: 'lifecycle' })
    expect(calls).toEqual([])
    expect(logs.join('')).not.toContain('zqsecret')
  })
  test('board.show projection preserves internal state', async () => {
    const src = Object.freeze({
      runs: [],
      rigs: Object.freeze([{ name: 'a', repo: 'r', factory: 'f', env: { FOO: 'zqsecret' } }]),
    })
    const { h } = setup(() => src)
    await get(h, '/v1/board')
    expect(await (await get(h, '/v1/board')).json()).toEqual({
      runs: [],
      rigs: [{ name: 'a', repo: 'r', factory: 'f' }],
    })
    expect(src.rigs[0]!.env.FOO).toBe('zqsecret')
    expect(await (await get(setup(() => ({ runs: [] })).h, '/v1/board')).json()).toEqual({ runs: [] })
    expect(await (await get(setup(() => ({ rigs: [] })).h, '/v1/board')).json()).toEqual({ rigs: [] })
  })
  test('board.show keeps halt, mail, lease and review fields and both runners', async () => {
    const rest = {
      runs: [{ id: 'r1', review: { round: 2 } }],
      halt: { mode: 'stop' },
      mail: [{ to: 'manager', text: 'hi' }],
      lease: { holder: 'm1' },
    }
    const rigs = [
      { name: 'a', repo: 'r1', factory: 'f', runner: 'ax', env: { K: 'zqsecret' } },
      { name: 'b', repo: 'r2', factory: 'f', runner: 'herdr', params: { K: 'zqsecret' } },
    ]
    const r = await get(setup(() => ({ ...rest, rigs })).h, '/v1/board')
    const body = (await r.json()) as { rigs: unknown }
    expect(body).toEqual({
      ...rest,
      rigs: [
        { name: 'a', repo: 'r1', factory: 'f', runner: 'ax' },
        { name: 'b', repo: 'r2', factory: 'f', runner: 'herdr' },
      ],
    })
  })
  test('POST /v1/board and /v1/rigs give no rig data', async () => {
    const { h, calls } = setup(() => ({ rigs: [{ name: 'a', repo: 'r', factory: 'f' }] }))
    for (const p of ['/v1/board', '/v1/rigs']) {
      const r = await post(h, p, {})
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(await r.text()).not.toContain('"rigs"')
    }
    expect(calls).toEqual([])
  })
  const okRig = { name: 'a', repo: 'r', factory: 'f' }
  const badLeaves: Record<string, unknown>[] = [
    ...['name', 'repo', 'factory', 'goal', 'runner', 'sandboxClass'].map(k => ({ [k]: { env: 'zqsecret' } })),
    { maxRuns: 'zqsecret' },
    { maxRuns: { env: 'zqsecret' } },
    { sweeps: [{ env: 'zqsecret' }] },
    { sweeps: 'zqsecret' },
    { linear: { team: [{ env: 'zqsecret' }] } },
    { linear: { team: 'zqsecret' } },
    { linear: { projects: [{ a: 'zqsecret' }] } },
    { linear: { labels: [['zqsecret']] } },
    { linear: ['zqsecret'] },
    ...['at', 'pulled', 'created', 'updated', 'stripped', 'unrouted'].map(k => ({
      linearSync: { [k]: { beadsRemote: 'zqsecret' } },
    })),
    { linearSync: { error: { beadsRemote: 'zqsecret' } } },
    { linearSync: 'zqsecret' },
  ]
  for (const bad of badLeaves)
    test(`board.show refuses ${JSON.stringify(Object.keys(bad))} ${JSON.stringify(bad).length} without echo`, async () => {
      const { h, calls } = setup(() => ({ rigs: [{ ...okRig, ...bad }] }))
      const r = await get(h, '/v1/board')
      expect(r.status).toBe(500)
      expect(await r.text()).not.toContain('zqsecret')
      expect(calls).toEqual([])
    })
  test('board.show fails on a malformed rig without echoing it', async () => {
    for (const rigs of ['zqsecret', { x: 'zqsecret' }, ['zqsecret'], [null]]) {
      const r = await get(setup(() => ({ rigs })).h, '/v1/board')
      expect(r.status).toBe(500)
      expect(await r.text()).not.toContain('zqsecret')
    }
  })
  test('the board gives 503 before the first tick', async () => {
    expect((await get(setup().h, '/v1/board')).status).toBe(503)
  })
  test('a board that throws gives 500', async () => {
    const { h } = setup(() => {
      throw new Error('boom')
    })
    expect((await get(h, '/v1/board')).status).toBe(500)
  })
})

describe('runs.screen', () => {
  const withScreen = (screen: (id: string) => Promise<string>) => {
    const calls: string[] = []
    const p = new Proxy({} as Port, {
      get: (_t, k) =>
        k === 'screen'
          ? async (id: string) => (calls.push(id), screen(id))
          : () => {
              throw new Error(`port.${String(k)} must not be called`)
            },
    })
    const home = mkdtempSync(join(tmpdir(), 'cat-s-'))
    const run = async (): Promise<RunResult> => {
      throw new Error('the runner must not run')
    }
    return { calls, h: clientHandler({ home, run, port: p, board: () => null }) }
  }
  test('runs.screen catalog and route: the exact bytes, no newline added', async () => {
    const { h, calls } = withScreen(async () => 'line 1\nline 2')
    const r = await get(h, '/v1/runs/r1/screen')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('line 1\nline 2')
    expect(calls).toEqual(['r1'])
    const cat = (await (await get(h, '/v1/catalog')).json()) as any
    const op = cat.data.operations.find((o: any) => o.name === 'runs.screen')
    expect(op).toMatchObject({ rights: 'read', mutates: false, long: false, output: 'text' })
    expect(op.inputs).toEqual([{ name: 'id', kind: 'id', required: true, help: 'the run id' }])
    expect(op.route).toEqual({ method: 'GET', path: '/v1/runs/:id/screen' })
  })
  test('an empty screen succeeds', async () => {
    const { h } = withScreen(async () => '')
    const r = await get(h, '/v1/runs/r1/screen')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('')
  })
  test('a reason gives 422 with that reason', async () => {
    const { h } = withScreen(async () => {
      throw new Error('run has no worker')
    })
    const r = await get(h, '/v1/runs/r1/screen')
    expect(r.status).toBe(422)
    expect(((await r.json()) as any).refused).toContain('run has no worker')
  })
  test('refused rows make no port call', async () => {
    const { h, calls } = withScreen(async () => 'x')
    expect((await post(h, '/v1/runs/r1/screen', {})).status).toBe(404)
    for (const p of [
      '/v1/runs/r1/screen?x=1',
      '/v1/runs/r1/screen?id=r2',
      '/v1/runs/a%2Fb/screen',
      '/v1/runs/a%2Eb/screen',
      '/v1/runs/-x/screen',
    ])
      expect((await get(h, p)).status).toBe(400)
    const auth = await h(
      new Request('http://x/v1/runs/r1/screen', { headers: { authorization: 'Bearer zq' } }),
      '1.2.3.4',
    )
    expect(auth.status).toBe(403)
    expect(calls).toEqual([])
  })
})

describe('rig endpoints: refusals and controls', () => {
  const counted = (rigs: unknown = [{ name: 'a', repo: 'r', factory: 'f' }]) => {
    const home = mkdtempSync(join(tmpdir(), 'cat-r-'))
    const n = { board: 0, port: 0, run: 0 }
    const p = new Proxy({} as Port, {
      get: () => () => {
        n.port++
        throw new Error('port must not be called')
      },
    })
    const run = async (): Promise<RunResult> => {
      n.run++
      return { code: 0, out: 'ok\n', err: '' }
    }
    const logs: string[] = []
    const board = () => {
      n.board++
      return { rigs }
    }
    return { n, logs, h: clientHandler({ home, run, port: p, board, log: s => logs.push(s) }) }
  }
  const refusals: [string, string, RequestInit | undefined, number][] = []
  for (const p of ['/v1/board', '/v1/rigs']) {
    refusals.push(['Authorization header', p, { headers: { authorization: 'Bearer zqsecret' } }, 403])
    refusals.push(['unknown query', p + '?zq=zqsecret', undefined, 400])
    refusals.push(['duplicate query', p + '?zq=1&zq=2', undefined, 400])
    refusals.push([
      'POST',
      p,
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      404,
    ])
  }
  for (const [what, p, init, status] of refusals)
    test(p + ' ' + what + ' gives ' + status + ' and calls nothing', async () => {
      const t = counted()
      const r = await t.h(new Request('http://x' + p, init), '1.2.3.4')
      expect(r.status).toBe(status)
      expect(await r.text()).not.toContain('zqsecret')
      expect(t.n).toEqual({ board: 0, port: 0, run: 0 })
      expect(t.logs.join('')).not.toContain('zqsecret')
    })

  const secretRows = {
    'env.FOO': { env: { FOO: 'zqsecret' } },
    'env.API_KEY': { env: { API_KEY: 'zqsecret' } },
    'params.FOO': { params: { FOO: 'zqsecret' } },
    'params.API_KEY': { params: { API_KEY: 'zqsecret' } },
    beadsRemote: { beadsRemote: 'https://u:zqsecret@example.test/x' },
  }
  const shapes: [string, (rigs: unknown[]) => Record<string, unknown>][] = [
    ['normal', rigs => ({ runs: [{ id: 'r1', review: { round: 1 } }], halt: null, rigs })],
    ['halted', rigs => ({ runs: [], halt: { mode: 'stop', at: 5 }, rigs })],
    ['read-only', rigs => ({ readOnly: true, runs: [], halt: null, rigs })],
  ]
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object') {
      Object.freeze(o)
      for (const v of Object.values(o)) deepFreeze(v)
    }
    return o
  }
  for (const [shape, mk] of shapes)
    for (const [row, extra] of Object.entries(secretRows))
      for (const runner of ['ax', 'herdr'])
        test(
          'board.show ' + shape + ' board hides ' + row + ' on a ' + runner + ' rig, source unchanged',
          async () => {
            const rig = { name: 'a', repo: 'r', factory: 'f', runner, ...extra }
            const src = deepFreeze({
              ...mk([rig]),
              mail: [{ to: 'manager', text: 'hi' }],
              lease: { holder: 'm1' },
            }) as any
            const before = JSON.stringify(src)
            const t = counted()
            const h = clientHandler({
              home: mkdtempSync(join(tmpdir(), 'cat-r-')),
              run: async () => {
                t.n.run++
                return { code: 0, out: '', err: '' }
              },
              port: new Proxy({} as Port, {
                get: () => () => {
                  t.n.port++
                  throw new Error('port')
                },
              }),
              board: () => src,
              log: s => t.logs.push(s),
            })
            for (let i = 0; i < 2; i++) {
              const r = await get(h, '/v1/board')
              const text = await r.text()
              expect(r.status).toBe(200)
              expect(text).not.toContain('zqsecret')
              const body = JSON.parse(text)
              expect(body.rigs).toEqual([{ name: 'a', repo: 'r', factory: 'f', runner }])
              expect(body.mail).toEqual(src.mail)
              expect(body.lease).toEqual(src.lease)
              expect(body.halt).toEqual(src.halt)
              expect(body.runs).toEqual(src.runs)
            }
            expect(JSON.stringify(src)).toBe(before)
            expect(t.n.port).toBe(0)
            expect(t.n.run).toBe(0)
            expect(t.logs.join('')).not.toContain('zqsecret')
          },
        )

  for (const key of ['linear', 'linearSync'])
    for (const [what, v] of [
      ['null', null],
      ['array', ['zqsecret']],
      ['primitive', 'zqsecret'],
      ['number', 7],
    ] as [string, unknown][])
      test('board.show ' + key + ' ' + what + ': no echo, no calls', async () => {
        const t = counted([{ name: 'a', repo: 'r', factory: 'f', [key]: v }])
        const r = await get(t.h, '/v1/board')
        const text = await r.text()
        expect(text).not.toContain('zqsecret')
        expect(r.status).toBe(500)
        expect(t.n.port).toBe(0)
        expect(t.n.run).toBe(0)
        expect(t.logs.join('')).not.toContain('zqsecret')
      })
})

describe('board slim and snapshot (claude-factory-hpmc.23)', () => {
  const board = () => ({ runs: [{ id: 'r1', trail: [{ node: 'plan' }], last: 'text' }], rigs: [] })
  test('GET /v1/board?slim=1 gives a board with no trail', async () => {
    const { h } = setup(board)
    const res = await get(h, '/v1/board?slim=1')
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).not.toContain('"trail"')
  })
  test('GET /v1/snapshot needs views', async () => {
    const { h } = setup(board)
    expect((await get(h, '/v1/snapshot')).status).toBe(400)
  })
  test('GET /v1/snapshot?views=board gives the slim board', async () => {
    const { h } = setup(board)
    const res = await get(h, '/v1/snapshot?views=board')
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).not.toContain('"trail"')
  })
})
