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
  'gates.brief',
  'gates.decide',
  'guard.check',
  'lease.show',
  'mail.list',
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
  'steps.reports',
]

describe('GET /v1/catalog', () => {
  test('serves the envelope with the 27 operations', async () => {
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
    '/v1/board?&',
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
