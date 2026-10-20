import { expect, test } from 'bun:test'
import { egressPolicy } from './ax'
import { configFrom, handle, MAX_BODY, route, type Run } from './broker'

type Call = { argv: string[]; stdin?: string }
const setup = (
  reply: (argv: string[]) => { code: number; out?: string; err?: string } = () => ({ code: 0 }),
  env: Record<string, string> = {},
) => {
  const calls: Call[] = []
  const run: Run = async (argv, stdin) => {
    calls.push({ argv, stdin })
    const r = reply(argv)
    return { code: r.code, out: r.out ?? '', err: r.err ?? '' }
  }
  return {
    calls,
    c: configFrom(
      { FACTORY_BROKER_ENDPOINT: 'api.example.svc:443', FACTORY_BROKER_TOKEN: TOKEN, ...env },
      run,
    ),
  }
}
const TOKEN = 'test-bearer'
const req = (method: string, path: string, body?: string, auth: string | null = `Bearer ${TOKEN}`) =>
  new Request(`http://broker.example.svc${path}`, {
    method,
    body,
    headers: auth === null ? {} : { authorization: auth },
  })
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

test('GET /ax-ready answers 200 when the controller is ready and 503 with the reason when not', async () => {
  const dep = (readyReplicas: number) =>
    JSON.stringify({
      metadata: { generation: 2 },
      spec: { replicas: 1 },
      status: { observedGeneration: 2, readyReplicas, availableReplicas: readyReplicas },
    })
  const ready = setup(() => ({ code: 0, out: dep(1) }))
  const ok = await handle(req('GET', '/ax-ready'), ready.c)
  expect([ok.status, await ok.text()]).toEqual([200, 'ready\n'])
  expect(ready.calls[0]!.argv.slice(0, 7)).toEqual([
    'kubectl',
    'get',
    'deployment',
    'ax-controller',
    '-n',
    'ax-system',
    '-o',
  ])
  const down = await handle(req('GET', '/ax-ready'), setup(() => ({ code: 0, out: dep(0) })).c)
  expect(down.status).toBe(503)
  expect(await down.text()).toContain('is not ready at its current generation')
  const gone = await handle(req('GET', '/ax-ready'), setup(() => ({ code: 1, err: 'forbidden' })).c)
  expect(gone.status).toBe(503)
  expect(await gone.text()).toContain('could not be observed')
})

test('the atespaces and the manager come from the environment', () => {
  const c = configFrom({ FACTORY_BROKER_ATESPACES: 'a,b', FACTORY_AX_MANAGER: 'mgr' })
  expect(route('PUT', '/policy/b/x', c)).toMatchObject({ op: 'put' })
  expect(route('PUT', '/policy/a/mgr', c)).toMatchObject({ status: 403 })
  expect(c.ate).toEqual(['kubectl', 'ate', '--token-file', '/var/run/secrets/ate-api/token'])
})

const withVault = (extra: Record<string, string> = {}) =>
  setup(undefined, { FACTORY_AX_VAULT: 'fv', FACTORY_AX_GITHUB_KEYS: 'other=GITHUB_OO', ...extra })
const rule = (hostnames: string[], key: string, vault = 'fv') => ({
  https: {
    hostnames,
    effects: {
      replaceHeaders: [
        {
          header: 'Authorization',
          prefix: 'Bearer ',
          credentialUri: `ate-secret://agent-vault/${vault}/${key}`,
        },
      ],
    },
  },
})
const put = (c: ReturnType<typeof setup>['c'], rules: unknown[]) =>
  handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify({ rules })), c)

test('PUT refuses a credential that goes to a foreign host', async () => {
  const { calls, c } = withVault()
  expect((await put(c, [rule(['evil.example.com'], 'GITHUB')])).status).toBe(400)
  expect((await put(c, [rule(['api.github.com', 'evil.example.com'], 'GITHUB')])).status).toBe(400)
  expect((await put(c, [rule(['api.github.com'], 'GITHUB', 'other-vault')])).status).toBe(400)
  expect(calls).toEqual([])
})

test('PUT refuses an unknown key, a credential nested out of place, and any credential with no vault', async () => {
  const { calls, c } = withVault()
  expect((await put(c, [rule(['api.github.com'], 'SECRET')])).status).toBe(400)
  const nested = {
    https: {
      hostnames: ['evil.example.com'],
      extra: [{ credentialUri: 'ate-secret://agent-vault/fv/GITHUB' }],
    },
  }
  expect((await put(c, [nested])).status).toBe(400)
  expect((await put(setup().c, [rule(['api.github.com'], 'GITHUB')])).status).toBe(400)
  expect(calls).toEqual([])
})

test('PUT refuses a rule that names the broker, and allows a rule with no credential', async () => {
  const { calls, c } = withVault()
  const broker = {
    http: { hostnames: ['factory-policy-broker.factory-broker.svc'], ports: { numbers: [8080] } },
  }
  expect((await put(c, [broker])).status).toBe(400)
  expect((await put(c, [{ https: { hostnames: ['factory-policy-broker'] } }])).status).toBe(400)
  expect((await put(c, [{ https: { hostnames: ['*'] } }])).status).toBe(400)
  expect(calls).toEqual([])
  expect((await put(c, [{ https: { hostnames: ['dolt.example.com'] } }])).status).toBe(200)
})

test('PUT accepts the policy that egressPolicy builds', async () => {
  const { c } = withVault({ FACTORY_BROKER_KEY_HOSTS: 'GITLAB=gl.example.com,GITLAB_BASIC=gl.example.com' })
  const extra = [{ hosts: ['dolt.example.com'], port: 50051 }]
  for (const [gitlab, owner] of [
    [undefined, undefined],
    ['gl.example.com', undefined],
    [undefined, 'GITHUB_OO'],
  ] as const) {
    const res = await handle(
      req(
        'PUT',
        '/policy/factory/f-r1-1',
        JSON.stringify(egressPolicy('fv', extra, undefined, gitlab, owner)),
      ),
      c,
    )
    expect(res.status).toBe(200)
  }
})

test('policy writes need the bearer token; the GET routes do not', async () => {
  const { calls, c } = setup()
  for (const method of ['PUT', 'DELETE']) {
    const path = '/policy/factory/f-r1-1'
    expect((await handle(req(method, path, POLICY, null), c)).status).toBe(401)
    expect((await handle(req(method, path, POLICY, 'Bearer wrong-token'), c)).status).toBe(401)
    expect((await handle(req(method, path, POLICY, `Bearer ${TOKEN}x`), c)).status).toBe(401)
    expect((await handle(req(method, path, POLICY, `Basic ${TOKEN}`), c)).status).toBe(401)
  }
  expect(calls).toEqual([])
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', POLICY), c)).status).toBe(200)
  const open = setup(undefined, { FACTORY_BROKER_TOKEN: '' }).c
  expect((await handle(req('GET', '/healthz', undefined, null), open)).status).toBe(200)
})

test('policy writes are refused with 503 when the broker has no token', async () => {
  const { calls, c } = setup(undefined, { FACTORY_BROKER_TOKEN: '' })
  const res = await handle(req('PUT', '/policy/factory/f-r1-1', POLICY), c)
  expect(res.status).toBe(503)
  expect(await res.text()).toContain('FACTORY_BROKER_TOKEN')
  expect((await handle(req('DELETE', '/policy/factory/f-r1-1'), c)).status).toBe(503)
  expect(calls).toEqual([])
})
