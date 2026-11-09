import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientHandler, type RunResult } from '../server-api'
import type { Port } from './catalog'

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
  return { calls, h: clientHandler({ home, run, port, board }) }
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
  'decisions.answer',
  'decisions.list',
  'factory.halt',
  'gates.brief',
  'gates.decide',
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
  'runs.show',
  'runs.start',
  'runs.status',
  'steps.reports',
]

describe('GET /v1/catalog', () => {
  test('serves the envelope with the 23 operations', async () => {
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

describe('runs.screen route', () => {
  const screenHandler = () => {
    const calls: unknown[] = []
    const p = new Proxy({} as Port, {
      get: (_t, key) => async (...args: unknown[]) => {
        calls.push([key, ...args])
        return { code: 0, out: 'screen bytes', err: '' }
      },
    })
    return { calls, h: clientHandler({ home: mkdtempSync(join(tmpdir(), 'screen-h-')), port: p, board: () => null, run: async () => { throw new Error('no CLI') } }) }
  }
  test('GET calls only screen once', async () => {
    const { h, calls } = screenHandler()
    const response = await get(h, '/v1/runs/r1/screen')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('screen bytes')
    expect(calls).toEqual([['screen', 'r1']])
  })
  for (const path of ['/v1/runs//screen', '/v1/runs/%2E%2E/screen', '/v1/runs/a%2Fb/screen', '/v1/runs/-r1/screen', `/v1/runs/${'a'.repeat(129)}/screen`, '/v1/runs/r1/screen?lines=1'])
    test(`refuses ${path}`, async () => {
      const { h, calls } = screenHandler()
      expect((await get(h, path)).status).toBeGreaterThanOrEqual(400)
      expect(calls).toEqual([])
    })
  test('POST and authorization headers call no port', async () => {
    const { h, calls } = screenHandler()
    expect((await post(h, '/v1/runs/r1/screen', {})).status).toBe(404)
    expect((await h(new Request('http://x/v1/runs/r1/screen', { headers: { authorization: 'Bearer fake' } }), '1.2.3.4')).status).toBe(403)
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
