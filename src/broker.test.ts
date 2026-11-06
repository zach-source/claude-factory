import { expect, test } from 'bun:test'
import * as ax from './ax'
import { configFrom, handle, MAX_BODY, route, workerPolicyRefusal, type Run } from './broker'

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

test('GET /controller returns only the readiness fields of the ax-controller Deployment', async () => {
  const full = {
    metadata: { generation: 3, name: 'ax-controller', annotations: { secret: 'x' } },
    spec: { replicas: 1, template: { spec: { containers: [{ env: [{ name: 'K', value: 'v' }] }] } } },
    status: { observedGeneration: 3, readyReplicas: 1, availableReplicas: 1 },
  }
  const { calls, c } = setup(() => ({ code: 0, out: JSON.stringify(full) }))
  const res = await handle(req('GET', '/controller'), c)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    metadata: { generation: 3 },
    spec: { replicas: 1 },
    status: { observedGeneration: 3, readyReplicas: 1, availableReplicas: 1 },
  })
  expect(calls[0]!.argv).toEqual([
    'kubectl',
    'get',
    'deployment',
    'ax-controller',
    '-n',
    'ax-system',
    '-o',
    'json',
    '--request-timeout=5s',
  ])
  const denied = setup(() => ({ code: 1, err: 'denied' }))
  expect((await handle(req('GET', '/controller'), denied.c)).status).toBe(502)
  const junk = setup(() => ({ code: 0, out: 'not json' }))
  expect((await handle(req('GET', '/controller'), junk.c)).status).toBe(502)
  expect(route('POST', '/controller', c)).toMatchObject({ status: 404 })
})

const swapEnv = { CLAUDE_TOKEN_ITEM: 'item-x', FACTORY_BROKER_ENDPOINT: 'api.example.svc:443' }

test('POST /token/best runs claude-token best and returns its first stdout line, never a token', async () => {
  const calls: string[][] = []
  const opFlags: (boolean | undefined)[] = []
  const run: Run = async (argv, _stdin, op) => {
    calls.push(argv)
    opFlags.push(op)
    return {
      code: 0,
      out: 'slot 2 is live; agent-vault picks it up within 5 minutes\nsk-ant-secret\n',
      err: '',
    }
  }
  const c = configFrom(swapEnv, run)
  const res = await handle(req('POST', '/token/best'), c)
  expect(opFlags).toEqual([true])
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toBe('slot 2 is live; agent-vault picks it up within 5 minutes\n')
  expect(calls).toEqual([['claude-token', 'best']])
  expect(route('GET', '/token/best', c)).toMatchObject({ status: 404 })
})

test('POST /token/best is 404 when CLAUDE_TOKEN_ITEM is unset, and runs nothing', async () => {
  const { calls, c } = setup()
  const res = await handle(req('POST', '/token/best'), c)
  expect(res.status).toBe(404)
  expect(calls).toEqual([])
})

test('POST /token/best answers 409 while a swap runs, then 502 with a fixed body', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const slow: Run = async () => {
    await gate
    return { code: 1, out: '', err: "claude-token: couldn't update the item\nsk-ant-secret\n" }
  }
  const c = configFrom(swapEnv, slow)
  const first = handle(req('POST', '/token/best'), c)
  const second = await handle(req('POST', '/token/best'), c)
  expect(second.status).toBe(409)
  release()
  const done = await first
  expect(done.status).toBe(502)
  expect(await done.text()).toBe('token swap failed\n')
  const again = await handle(
    req('POST', '/token/best'),
    configFrom(swapEnv, async () => ({ code: 0, out: 'slot 1 is live', err: '' })),
  )
  expect(again.status).toBe(200)
})

const U = (key: string) => 'ate-secret://agent-vault/v1/' + key
const withHeader = (h: Record<string, unknown>) => ({
  rules: [{ https: { hostnames: ['a.example.com'], replaceHeaders: [h] } }],
})
const withPath = (hostnames: unknown, extra: Record<string, unknown> = { pathPrefixes: ['/x/'] }) => ({
  rules: [{ https: { hostnames, ...extra } }],
})
const hdr = (credentialUri: unknown) => withHeader({ header: 'Authorization', credentialUri })

test('PUT refuses a worker policy that names a manager-only key or a github path rule, before any command runs', async () => {
  const refused: Record<string, unknown> = {
    AX_AUTH: hdr(U('AX_AUTH')),
    GITHUB_BASIC_MANAGER: hdr(U('GITHUB_BASIC_MANAGER')),
    'key CredentialURI': withHeader({ CredentialURI: U('AX_AUTH') }),
    'key credential_uri': withHeader({ credential_uri: 'https://x.example.com/ax' }),
    'key with U+017F': withPath(['a.example.com'], { pathPrefixeſ: ['/x/'] }),
    'lowercase value': hdr(U('ax_auth')),
    'query suffix': hdr(U('AX_AUTH') + '?x=1'),
    'trailing slash': hdr(U('AX_AUTH') + '/'),
    'percent escape': hdr(U('AX%5FAUTH')),
    'number value': hdr(5),
    'object value': hdr({ a: 1 }),
    'other field': withHeader({ header: 'AX_AUTH' }),
    'api.github.com path': withPath(['api.github.com'], { pathPrefixes: ['/repos/zach-source/'] }),
    'github.com path': withPath(['github.com'], { pathPrefixes: ['/zach-source/'] }),
    'GitHub.COM. path': withPath(['GitHub.COM.']),
    'wildcard github': withPath(['*.github.com']),
    'uploads.github.com': withPath(['uploads.github.com']),
    'any host': withPath(['*']),
    'any .com host': withPath(['*.com']),
    'ANY.COM. host': withPath(['*.COM.']),
    'path_prefixes key': withPath(['github.com'], { path_prefixes: ['/x/'] }),
    'no hostnames': { rules: [{ https: { pathPrefixes: ['/x/'] } }] },
    'hostnames string': withPath('github.com'),
  }
  for (const [name, body] of Object.entries(refused)) {
    const { calls, c } = setup()
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 400])
    expect(calls).toEqual([])
  }
  const deep = '['.repeat(20_000) + ']'.repeat(20_000)
  const { calls, c } = setup()
  const res = await handle(req('PUT', '/policy/factory/f-r1-1', `{"rules":[${deep}]}`), c)
  expect(res.status).toBe(400)
  expect(calls).toEqual([])
})

test('PUT still creates a normal worker policy', async () => {
  const keys = ['AX_AUTH_X', 'MY_AX_AUTH', 'GITHUB_BASIC'].map(k => ({ header: 'A', credentialUri: U(k) }))
  const allowed: Record<string, unknown> = {
    current: JSON.parse(POLICY),
    'github owner key': hdr(U('GITHUB_ZS_BASIC')),
    gitlab: hdr(U('GITLAB')),
    'look-alike keys': { rules: [{ https: { hostnames: ['a.example.com'], replaceHeaders: keys } }] },
    'path on other host': withPath(['gitlab.example.com']),
    'path on look-alike host': withPath(['notgithub.com']),
    'path on *.org': withPath(['*.org']),
    'path on *.notgithub.com': withPath(['*.notgithub.com']),
    'any host no path': withPath(['*'], {}),
    'any .com no path': withPath(['*.com'], {}),
  }
  for (const [name, body] of Object.entries(allowed)) {
    const { calls, c } = setup()
    const text = JSON.stringify(body)
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', text), c)
    expect([name, res.status]).toEqual([name, 200])
    expect(calls.length).toBe(2)
    expect(calls[1]!.stdin).toBe(text)
  }
})

test('a failed token swap logs the exit code only, never the child stderr', async () => {
  const logged: unknown[][] = []
  const old = console.error
  console.error = (...a: unknown[]) => void logged.push(a)
  try {
    const c = configFrom(swapEnv, async () => ({
      code: 3,
      out: '',
      err: "claude-token: couldn't update the item\nzqsecret-tok\n",
    }))
    const res = await handle(req('POST', '/token/best'), c)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('token swap failed\n')
  } finally {
    console.error = old
  }
  expect(logged).toEqual([['token swap failed: exit 3']])
})

test('spawn strips OP_SERVICE_ACCOUNT_TOKEN from the child env unless op is set', async () => {
  const old = process.env.OP_SERVICE_ACCOUNT_TOKEN
  process.env.OP_SERVICE_ACCOUNT_TOKEN = 'zqsecret-op'
  try {
    const { run } = configFrom({})
    const plain = await run(['/usr/bin/env'])
    expect(plain.code).toBe(0)
    expect(plain.out).not.toContain('OP_SERVICE_ACCOUNT_TOKEN=')
    const withOp = await run(['/usr/bin/env'], undefined, true)
    expect(withOp.out).toContain('OP_SERVICE_ACCOUNT_TOKEN=zqsecret-op')
  } finally {
    if (old === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = old
  }
})

const reviewerRule = (over: Record<string, unknown> = {}) => ({
  hostnames: ['api.github.com', 'uploads.github.com'],
  pathPrefixes: ['/repos/acme/widget/'],
  paths: ['/graphql'],
  effects: {
    replaceHeaders: [{ header: 'Authorization', prefix: 'Bearer ', credentialUri: U('GITHUB_REVIEWER') }],
  },
  ...over,
})
const pol = (rule: Record<string, unknown>) => ({ rules: [{ https: rule }] })
const dropKey = (k: string) => {
  const r: Record<string, unknown> = reviewerRule()
  delete r[k]
  return r
}
const withHdr = (h: Record<string, unknown>) =>
  pol(reviewerRule({ effects: { replaceHeaders: [{ ...reviewerRule().effects.replaceHeaders[0], ...h }] } }))

test('the reviewer API rule is the one path rule a worker policy can have on a github host', async () => {
  const accept: Record<string, unknown> = {
    reviewer: pol(reviewerRule()),
    'api only': pol(reviewerRule({ hostnames: ['api.github.com'] })),
    'dot repo': pol(reviewerRule({ pathPrefixes: ['/repos/acme/.github/'] })),
  }
  for (const [name, body] of Object.entries(accept)) {
    expect([name, workerPolicyRefusal(body)]).toEqual([name, null])
    const { calls, c } = setup()
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 200])
    expect(calls.length).toBe(2)
  }
  const refused: Record<string, unknown> = {
    'add github.com': pol(reviewerRule({ hostnames: ['api.github.com', 'github.com'] })),
    'add gist': pol(reviewerRule({ hostnames: ['api.github.com', 'gist.github.com'] })),
    'add *': pol(reviewerRule({ hostnames: ['api.github.com', '*'] })),
    'add *.com': pol(reviewerRule({ hostnames: ['*.com'] })),
    'upper case host': pol(reviewerRule({ hostnames: ['API.github.com'] })),
    'trailing dot host': pol(reviewerRule({ hostnames: ['api.github.com.'] })),
    'no hosts': pol(reviewerRule({ hostnames: [] })),
    'owner prefix': pol(reviewerRule({ pathPrefixes: ['/repos/acme/'] })),
    'repos prefix': pol(reviewerRule({ pathPrefixes: ['/repos/'] })),
    'root prefix': pol(reviewerRule({ pathPrefixes: ['/'] })),
    'deep prefix': pol(reviewerRule({ pathPrefixes: ['/repos/acme/widget/x/'] })),
    'dot dot owner': pol(reviewerRule({ pathPrefixes: ['/repos/acme/../'] })),
    'dot repo segment': pol(reviewerRule({ pathPrefixes: ['/repos/./widget/'] })),
    'two prefixes': pol(reviewerRule({ pathPrefixes: ['/repos/acme/widget/', '/repos/acme/other/'] })),
    'paths /user': pol(reviewerRule({ paths: ['/user'] })),
    'paths two': pol(reviewerRule({ paths: ['/graphql', '/user'] })),
    'paths slash': pol(reviewerRule({ paths: ['/graphql/'] })),
    'no paths': pol(dropKey('paths')),
    'no pathPrefixes': pol(dropKey('pathPrefixes')),
    'key GITHUB': withHdr({ credentialUri: U('GITHUB') }),
    'key GITHUB_ZS': withHdr({ credentialUri: U('GITHUB_ZS') }),
    'key REVIEWER_BASIC': withHdr({ credentialUri: U('GITHUB_REVIEWER_BASIC') }),
    'key lower case': withHdr({ credentialUri: U('github_reviewer') }),
    'two headers': pol(
      reviewerRule({
        effects: {
          replaceHeaders: [
            reviewerRule().effects.replaceHeaders[0],
            reviewerRule().effects.replaceHeaders[0],
          ],
        },
      }),
    ),
    'other header': withHdr({ header: 'X-Key' }),
    'other prefix': withHdr({ prefix: 'Basic ' }),
    'no effects': pol(dropKey('effects')),
    ports: pol(reviewerRule({ ports: { numbers: [443] } })),
    path_prefixes: pol(reviewerRule({ path_prefixes: ['/repos/acme/widget/'] })),
    'unknown key': pol(reviewerRule({ extra: 1 })),
    'paths on github.com': pol({ hostnames: ['github.com'], paths: ['/x'] }),
    'paths on *': pol({ hostnames: ['*'], paths: ['/x'] }),
  }
  for (const [name, body] of Object.entries(refused)) {
    expect([name, typeof workerPolicyRefusal(body)]).toEqual([name, 'string'])
    const { calls, c } = setup()
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 400])
    expect(calls).toEqual([])
  }
  for (const h of ['chatgpt.com', 'a.example.com'])
    expect(workerPolicyRefusal(pol({ hostnames: [h], paths: ['/x'], pathPrefixes: ['/y/'] }))).toBeNull()
})

const gitRule = (over: Record<string, unknown> = {}) => ({
  hostnames: ['github.com'],
  effects: {
    replaceHeaders: [
      { header: 'Authorization', prefix: 'Basic ', credentialUri: U('GITHUB_REVIEWER_BASIC') },
    ],
  },
  ...over,
})
const hostRule = (hostnames: string[], key: string) => ({
  hostnames,
  effects: { replaceHeaders: [{ header: 'Authorization', prefix: 'Bearer ', credentialUri: U(key) }] },
})
const rulesOf = (...rs: Record<string, unknown>[]) => ({ rules: rs.map(https => ({ https })) })

test('the reviewer keys appear only in one pair of reviewer rules', async () => {
  const api = reviewerRule()
  const gitHdr = gitRule().effects.replaceHeaders[0]
  const gitWith = (over: Record<string, unknown>) => rulesOf(api, gitRule(over))
  const refused: Record<string, unknown> = {
    'host-only api+uploads': rulesOf(hostRule(['api.github.com', 'uploads.github.com'], 'GITHUB_REVIEWER')),
    'host-only api': rulesOf(hostRule(['api.github.com'], 'GITHUB_REVIEWER')),
    'reviewer key on other host': rulesOf(hostRule(['a.example.com'], 'GITHUB_REVIEWER')),
    'host-only basic, no api rule': rulesOf(gitRule()),
    'basic key on other host': rulesOf(hostRule(['a.example.com'], 'GITHUB_REVIEWER_BASIC')),
    'two api rules, two repos': rulesOf(api, reviewerRule({ pathPrefixes: ['/repos/acme/other/'] })),
    'two api rules, same repo': rulesOf(api, api),
    'two git rules': rulesOf(api, gitRule(), gitRule()),
    'api plus third rule': rulesOf(api, hostRule(['a.example.com'], 'GITHUB_REVIEWER')),
    'spelling GITHUBREVIEWER': rulesOf(api, hostRule(['a.example.com'], 'GITHUBREVIEWER')),
    'spelling GITHUB__REVIEWER': rulesOf(api, hostRule(['a.example.com'], 'GITHUB__REVIEWER')),
    'spelling in header field': rulesOf(api, { hostnames: ['a.example.com'], header: 'github_reviewer' }),
    'token as object key': rulesOf(api, { hostnames: ['a.example.com'], GITHUB_REVIEWER: 1 }),
    'git extra ports': gitWith({ ports: { numbers: [443] } }),
    'git pathPrefixes': gitWith({ pathPrefixes: ['/acme/'] }),
    'git extra host': gitWith({ hostnames: ['github.com', 'gist.github.com'] }),
    'git prefix Bearer': gitWith({ effects: { replaceHeaders: [{ ...gitHdr, prefix: 'Bearer ' }] } }),
    'git header X-Key': gitWith({ effects: { replaceHeaders: [{ ...gitHdr, header: 'X-Key' }] } }),
    'git key GITHUB_REVIEWER': gitWith({
      effects: { replaceHeaders: [{ ...gitHdr, credentialUri: U('GITHUB_REVIEWER') }] },
    }),
    'git two headers': gitWith({ effects: { replaceHeaders: [gitHdr, gitHdr] } }),
    'api rule with extra key': { rules: [{ https: api, extra: 1 }] },
    'api rule nested in an array': { rules: [[{ https: api }]] },
  }
  for (const [name, body] of Object.entries(refused)) {
    expect([name, typeof workerPolicyRefusal(body)]).toEqual([name, 'string'])
    const { calls, c } = setup()
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 400])
    expect(calls).toEqual([])
  }
  const accepted: Record<string, unknown> = {
    'api rule alone': rulesOf(api),
    'api plus git rule': rulesOf(api, gitRule()),
    'look-alike GITHUB_REVIEW': rulesOf(hostRule(['a.example.com'], 'GITHUB_REVIEW')),
    'look-alike REVIEWER': rulesOf(hostRule(['a.example.com'], 'REVIEWER')),
    'egressPolicy non-reviewer': ax.egressPolicy('v', [], undefined, undefined, 'acme'),
  }
  for (const o of ['acme', 'zach-source'])
    accepted['egressPolicy ' + o] = ax.egressPolicy(
      'v',
      [],
      undefined,
      undefined,
      o,
      undefined,
      true,
      false,
      'widget',
    )
  for (const [name, body] of Object.entries(accepted)) {
    expect([name, workerPolicyRefusal(body)]).toEqual([name, null])
    const { calls, c } = setup()
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 200])
    expect(calls.length).toBe(2)
  }
})
