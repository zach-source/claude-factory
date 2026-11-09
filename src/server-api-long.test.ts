import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Op, Port } from './core/catalog'
import { clientHandler, cliRunner, type RunResult } from './server-api'

let seq = 0
const tmp = () => mkdtempSync(join(tmpdir(), 'sapi-l-'))
const fixture = (run: () => Promise<RunResult>, long = true): Op => ({
  name: 'fixture.wait',
  summary: 'fixture',
  inputs: [],
  output: 'json',
  rights: 'owner',
  mutates: true,
  long,
  route: { method: 'POST', path: '/v1/fixture/wait' },
  since: 1,
  run,
})
const ok = async (): Promise<RunResult> => ({ code: 0, out: '{"ok":1}', err: '' })
const post = (
  h: ReturnType<typeof clientHandler>,
  body: unknown,
  key = `key-${String(++seq).padStart(8, '0')}`,
) =>
  h(
    new Request('http://x/v1/fixture/wait', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    }),
    '1.2.3.4',
  )
const make = (op: Op, long?: (o: Op, run: () => Promise<Response>) => Response) =>
  clientHandler({
    home: tmp(),
    run: async () => ({ code: 0, out: '', err: '' }),
    port: {} as Port,
    board: () => null,
    ops: [op],
    long,
  })

describe('long operations (core hook)', () => {
  test('with the hook, a long op answers 202 and the same key replays the 202', async () => {
    const started: string[] = []
    const h = make(fixture(ok), (o, run) => {
      started.push(o.name)
      void run()
      return new Response('{"commandId":"c1"}\n', { status: 202 })
    })
    expect((await post(h, {}, 'key-longlong1')).status).toBe(202)
    const b = await post(h, {}, 'key-longlong1')
    expect(b.status).toBe(202)
    expect(await b.text()).toBe('{"commandId":"c1"}\n')
    expect(started).toEqual(['fixture.wait'])
  })
  test('a bad body answers 400 and starts nothing', async () => {
    const started: string[] = []
    const h = make(fixture(ok), o => {
      started.push(o.name)
      return new Response('{}', { status: 202 })
    })
    expect((await post(h, { n: 5 })).status).toBe(400)
    expect(started).toEqual([])
  })
  test('with no hook, or long false, the op answers 200 at once', async () => {
    expect((await post(make(fixture(ok)), {})).status).toBe(200)
    const started: string[] = []
    const h = make(fixture(ok, false), o => {
      started.push(o.name)
      return new Response('{}', { status: 202 })
    })
    expect((await post(h, {})).status).toBe(200)
    expect(started).toEqual([])
  })
  test('a 503 from the hook stores no row: the same key runs again', async () => {
    let status = 503
    const h = make(fixture(ok), () => new Response('{}', { status }))
    expect((await post(h, {}, 'key-busybusy1')).status).toBe(503)
    status = 202
    expect((await post(h, {}, 'key-busybusy1')).status).toBe(202)
  })
})

describe('cliRunner opts', () => {
  test('opts.env reaches the child and wins over personEnv', async () => {
    const home = tmp()
    const cli = join(home, 'env.ts')
    writeFileSync(cli, 'console.log(process.env.FACTORY_SELF_UPDATE + "|" + process.env.ZQ_X)\n')
    const r = await cliRunner(home, cli, 10_000, { env: { FACTORY_SELF_UPDATE: '7', ZQ_X: 'y' } })([])
    expect(r.out.trim()).toBe('7|y')
  })
  test('an abort of the signal ends the child', async () => {
    const home = tmp()
    const cli = join(home, 'slow.ts')
    writeFileSync(cli, 'await Bun.sleep(30_000)\n')
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 100)
    const r = await cliRunner(home, cli, 20_000, { signal: ac.signal })([])
    expect(r.code).not.toBe(0)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
  test('a signal that is aborted already ends the child', async () => {
    const home = tmp()
    const cli = join(home, 'slow.ts')
    writeFileSync(cli, 'await Bun.sleep(30_000)\n')
    const r = await cliRunner(home, cli, 20_000, { signal: AbortSignal.abort() })([])
    expect(r.code).not.toBe(0)
  })
})
