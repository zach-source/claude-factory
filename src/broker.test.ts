import { expect, test } from 'bun:test'
import { configFrom, handle, MAX_BODY, route, type Run } from './broker'

type Call = { argv: string[]; stdin?: string }
const setup = (
  reply: (argv: string[]) => { code: number; out?: string; err?: string } = () => ({ code: 0 }),
) => {
  const calls: Call[] = []
  const run: Run = async (argv, stdin) => {
    calls.push({ argv, stdin })
    const r = reply(argv)
    return { code: r.code, out: r.out ?? '', err: r.err ?? '' }
  }
  return { calls, c: configFrom({ FACTORY_BROKER_ENDPOINT: 'api.example.svc:443' }, run) }
}
const req = (method: string, path: string, body?: string) =>
  new Request(`http://broker.example.svc${path}`, { method, body })
const POLICY = JSON.stringify({ rules: [{ https: { hostnames: ['a.example.com'] } }] })

test('route accepts a served atespace and an actor that is not the manager', () => {
  const c = { atespaces: ['factory'], manager: 'f-manager' }
  expect(route('PUT', '/policy/factory/f-r1-1', c)).toEqual({
    op: 'put',
    atespace: 'factory',
    actor: 'f-r1-1',
  })
  expect(route('DELETE', '/policy/factory/f-r1-1', c)).toMatchObject({ op: 'delete' })
  expect(route('GET', '/policy/factory/f-r1-1', c)).toMatchObject({ status: 404 })
  expect(route('PUT', '/policy/other/f-r1-1', c)).toMatchObject({ status: 403 })
  expect(route('PUT', '/policy/factory/f-manager', c)).toMatchObject({ status: 403 })
  expect(route('DELETE', '/policy/factory/f-manager', c)).toMatchObject({ status: 403 })
  for (const bad of ['F-R1', 'a_b', '-a', 'a-', 'x'.repeat(64), '..', '%2e'])
    expect(route('PUT', `/policy/factory/${bad}`, c)).toMatchObject({ status: 400 })
})

test('PUT deletes the old policy, then creates the new one from the body', async () => {
  const { calls, c } = setup()
  const res = await handle(req('PUT', '/policy/factory/f-r1-1', POLICY), c)
  expect(res.status).toBe(200)
  const ate = [
    'kubectl',
    'ate',
    '--endpoint',
    'api.example.svc:443',
    '--token-file',
    '/var/run/secrets/ate-api/token',
  ]
  expect(calls.map(x => x.argv)).toEqual([
    [...ate, 'delete', 'egress-policy', 'f-r1-1', '-a', 'factory'],
    [...ate, 'create', 'egress-policy', 'f-r1-1', '-a', 'factory', '-f', '-'],
  ])
  expect(JSON.parse(calls[1]!.stdin!)).toEqual(JSON.parse(POLICY))
})

test('PUT answers 502 with the create error, and 400 or 413 before any command runs', async () => {
  const { calls, c } = setup(a => (a.includes('create') ? { code: 1, err: 'actor not found' } : { code: 1 }))
  const res = await handle(req('PUT', '/policy/factory/f-r1-1', POLICY), c)
  expect(res.status).toBe(502)
  expect(await res.text()).toContain('actor not found')
  calls.length = 0
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', 'not json'), c)).status).toBe(400)
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', '{"a":1}'), c)).status).toBe(400)
  const big = JSON.stringify({ rules: ['x'.repeat(MAX_BODY)] })
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', big), c)).status).toBe(413)
  expect(calls).toEqual([])
})

test('DELETE succeeds when the policy is gone already, and fails on any other error', async () => {
  const gone = setup(() => ({ code: 1, err: 'actor "x" not found' }))
  expect((await handle(req('DELETE', '/policy/factory/f-r1-1'), gone.c)).status).toBe(200)
  const bad = setup(() => ({ code: 1, err: 'unauthenticated' }))
  expect((await handle(req('DELETE', '/policy/factory/f-r1-1'), bad.c)).status).toBe(502)
})

test('GET /ca returns the bundle, GET /healthz answers ok, and a manager policy is refused', async () => {
  const { calls, c } = setup(() => ({ code: 0, out: 'PEM\n' }))
  const ca = await handle(req('GET', '/ca'), c)
  expect(await ca.text()).toBe('PEM\n')
  expect(calls[0]!.argv.slice(0, 4)).toEqual([
    'kubectl',
    'get',
    'clustertrustbundle',
    'egress-mitm.ate.dev:mitm:primary-bundle',
  ])
  expect((await handle(req('GET', '/healthz'), c)).status).toBe(200)
  calls.length = 0
  expect((await handle(req('PUT', '/policy/factory/f-manager', POLICY), c)).status).toBe(403)
  expect(calls).toEqual([])
  expect((await handle(req('GET', '/ca'), setup(() => ({ code: 1, err: 'denied' })).c)).status).toBe(502)
})

test('the atespaces and the manager come from the environment', () => {
  const c = configFrom({ FACTORY_BROKER_ATESPACES: 'a,b', FACTORY_AX_MANAGER: 'mgr' })
  expect(route('PUT', '/policy/b/x', c)).toMatchObject({ op: 'put' })
  expect(route('PUT', '/policy/a/mgr', c)).toMatchObject({ status: 403 })
  expect(c.ate).toEqual(['kubectl', 'ate', '--token-file', '/var/run/secrets/ate-api/token'])
})
