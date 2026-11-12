import { expect, test } from 'bun:test'
import * as ax from './ax'
import {
  configFrom,
  handle,
  keyHostRefusal,
  keyHostsFrom,
  MAX_BODY,
  route,
  updateBody,
  workerPolicyRefusal,
  type Run,
} from './broker'
import { codexEgress, cursorEgress, grokEgress } from './cli'

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
  return { calls, c: configFrom({ FACTORY_BROKER_ENDPOINT: 'api.example.svc:443', ...env }, run) }
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

test('PUT creates the policy from the body when the get finds none', async () => {
  const { calls, c } = setup(a =>
    a.includes('get') ? { code: 1, err: 'egress policy not found' } : { code: 0 },
  )
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
    [...ate, 'get', 'egress-policy', 'f-r1-1', '-a', 'factory', '-o', 'json'],
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

test('PUT updates a stored policy in place with its uid and version, and never deletes it', async () => {
  const meta = { atespace: 'factory', name: 'default', uid: 'u-1', version: '3' }
  const stored = JSON.stringify({ metadata: meta, rules: [] })
  const { calls, c } = setup(a => (a.includes('get') ? { code: 0, out: stored } : { code: 0 }))
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', POLICY), c)).status).toBe(200)
  expect(calls.map(x => x.argv.slice(6, 8))).toEqual([
    ['get', 'egress-policy'],
    ['update', 'egress-policy'],
  ])
  expect(JSON.parse(calls[1]!.stdin!)).toEqual({ ...JSON.parse(POLICY), metadata: meta })
})

test('updateBody puts the stored metadata on the new rules; none without a uid and a version', () => {
  const meta = { uid: 'u', version: '1', name: 'default' }
  expect(JSON.parse(updateBody(POLICY, JSON.stringify({ metadata: meta }))!)).toEqual({
    ...JSON.parse(POLICY),
    metadata: meta,
  })
  for (const bad of ['', '{bad', '{}', JSON.stringify({ metadata: { uid: 'u' } })])
    expect(updateBody(POLICY, bad)).toBeUndefined()
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
  ])
  // in a pod, --request-timeout makes kubectl skip the in-cluster config and call localhost:8080 (the broker)
  expect(calls[0]!.argv.some(a => a.startsWith('--request-timeout'))).toBe(false)
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

test('lntv AC1 trusted vault config', () => {
  for (const vault of ['acme-vault', '-', '', undefined])
    expect(configFrom({ FACTORY_AX_VAULT: vault })).toMatchObject({ vault: vault || undefined })
  for (const vault of [' ', ' acme', 'acme ', 'acme\n', 'ACME', 'a_b', 'a/b', '.', 'a%2Fb', 'é'])
    expect(() => configFrom({ FACTORY_AX_VAULT: vault }), vault).toThrow('FACTORY_AX_VAULT')
})

test('lntv AC2 handler pins every credential path before commands', async () => {
  const inVault = (rule: unknown, vault: string) =>
    JSON.parse(JSON.stringify(rule).replaceAll('agent-vault/v1/', `agent-vault/${vault}/`))
  const check = async (body: unknown, vault: string | undefined, status: number) => {
    for (const update of [false, true]) {
      const { calls, c } = setup(
        a =>
          a.includes('get')
            ? update
              ? { code: 0, out: JSON.stringify({ metadata: { uid: 'u', version: '1' }, rules: [] }) }
              : { code: 1, err: 'egress policy not found' }
            : { code: 0 },
        vault === undefined ? {} : { FACTORY_AX_VAULT: vault },
      )
      const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
      expect([vault, body, res.status]).toEqual([vault, body, status])
      if (status === 400) expect(calls).toEqual([])
      else {
        expect(calls).toHaveLength(2)
        expect(calls[0]!.argv).toContain('get')
        expect(calls[1]!.argv).toContain(update ? 'update' : 'create')
      }
    }
  }
  const generic = hostRule(['api.anthropic.com'], 'ANTHROPIC')
  const api = inVault(reviewerRule(), 'acme-vault')
  const git = inVault(gitRule(), 'acme-vault')
  for (const vault of ['acme-vault', 'other-vault', '-', 'acme-vault-extra', 'acme']) {
    const g = inVault(generic, vault)
    const a = inVault(reviewerRule(), vault)
    const b = inVault(gitRule(), vault)
    for (const body of [
      rulesOf(g),
      rulesOf(a),
      rulesOf(a, git),
      rulesOf(api, b),
      rulesOf(a, b),
      rulesOf(inVault(generic, 'acme-vault'), g),
    ]) {
      expect(workerPolicyRefusal(body, 'acme-vault') === null).toBe(vault === 'acme-vault')
      expect(workerPolicyRefusal(body)).toBeNull()
      expect(workerPolicyRefusal(body, '')).toBeNull()
      await check(body, 'acme-vault', vault === 'acme-vault' ? 200 : 400)
      await check(body, undefined, 200)
      await check(body, '', 200)
    }
  }
  for (const suffix of ['\n', '?q=x', '#x', '/extra'])
    for (const rule of [generic, reviewerRule(), gitRule()]) {
      const malformed = JSON.parse(JSON.stringify(inVault(rule, 'acme-vault')))
      malformed.effects.replaceHeaders[0].credentialUri += suffix
      const body = rule.hostnames[0] === 'github.com' ? rulesOf(api, malformed) : rulesOf(malformed)
      expect(workerPolicyRefusal(body, 'acme-vault')).not.toBeNull()
      await check(body, 'acme-vault', 400)
    }
  for (const vault of ['acme%2Dvault', 'ACME', 'é'])
    await check(rulesOf(inVault(generic, vault)), 'acme-vault', 400)
  for (const body of [
    rulesOf(inVault(hostRule(['api.anthropic.com'], 'AX_AUTH'), 'acme-vault')),
    rulesOf(inVault(hostRule(['relay.example.com'], 'ANTHROPIC'), 'acme-vault')),
    { credentialUri: 'ate-secret://agent-vault/acme-vault/ANTHROPIC', rules: [] },
    rulesOf({ ...api, paths: ['/user'] }),
  ])
    await check(body, 'acme-vault', 400)
  for (const vault of ['acme-vault', 'other-vault', '', undefined])
    await check(rulesOf({ hostnames: ['example.com'] }), vault, 200)
  await check(rulesOf(inVault(generic, 'other-vault')), 'other-vault', 200)
  const first = setup(undefined, { FACTORY_AX_VAULT: 'acme-vault' })
  const second = setup(undefined, { FACTORY_AX_VAULT: 'other-vault' })
  const body = JSON.stringify(rulesOf(inVault(generic, 'acme-vault')))
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', body), first.c)).status).toBe(200)
  expect((await handle(req('PUT', '/policy/factory/f-r1-1', body), second.c)).status).toBe(400)
  expect(second.calls).toEqual([])
})
const withHeader = (h: Record<string, unknown>, host = 'a.example.com') => ({
  rules: [{ https: { hostnames: [host], effects: { replaceHeaders: [h] } } }],
})
const withPath = (hostnames: unknown, extra: Record<string, unknown> = { pathPrefixes: ['/x/'] }) => ({
  rules: [{ https: { hostnames, ...extra } }],
})
const hdr = (credentialUri: unknown, host?: string) =>
  withHeader({ header: 'Authorization', credentialUri }, host)

test('PUT refuses a worker policy that names a manager-only key or a github path rule, before any command runs', async () => {
  const refused: Record<string, unknown> = {
    AX_AUTH: hdr(U('AX_AUTH')),
    GITHUB_BASIC_MANAGER: hdr(U('GITHUB_BASIC_MANAGER')),
    'key CredentialURI': withHeader({ CredentialURI: U('AX_AUTH') }),
    'key credential_uri': withHeader({ credential_uri: 'https://x.example.com/ax' }),
    'key with U+017F': withPath(['a.example.com'], { pathPrefixeſ: ['/x/'] }),
    'vault x%2FAX_AUTH%23': hdr('ate-secret://agent-vault/x%2FAX_AUTH%23/X'),
    'vault v%2FGITHUB_%52EVIEWER': hdr('ate-secret://agent-vault/v%2FGITHUB_%52EVIEWER/X'),
    'vault %76': hdr('ate-secret://agent-vault/%76/X'),
    'vault ..': hdr('ate-secret://agent-vault/../X'),
    'vault .': hdr('ate-secret://agent-vault/./X'),
    'vault upper Factory': hdr('ate-secret://agent-vault/Factory/X'),
    'vault underscore my_vault': hdr('ate-secret://agent-vault/my_vault/X'),
    'vault non-ASCII': hdr('ate-secret://agent-vault/vı/X'),
    'vault empty': hdr('ate-secret://agent-vault//X'),
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
  const keys = ['AX_AUTH_X', 'MY_AX_AUTH'].map(k => ({
    header: 'A',
    prefix: 'Bearer ',
    credentialUri: U(k),
  }))
  const allowed: Record<string, unknown> = {
    current: JSON.parse(POLICY),
    'github owner key': hdr(U('GITHUB_ZS_BASIC'), 'github.com'),
    gitlab: hdr(U('GITLAB')),
    'vault factory': hdr('ate-secret://agent-vault/factory/GITHUB', 'github.com'),
    'vault with hyphen and digit': hdr('ate-secret://agent-vault/my-vault-2/GITHUB', 'github.com'),
    'look-alike keys': {
      rules: [
        { https: { hostnames: ['a.example.com'], effects: { replaceHeaders: keys } } },
        { https: hostRule(['github.com'], 'GITHUB_BASIC') },
      ],
    },
    'path on other host': withPath(['gitlab.example.com']),
    'path on look-alike host': withPath(['notgithub.com']),
    'path on *.org': withPath(['*.org']),
    'path on *.notgithub.com': withPath(['*.notgithub.com']),
    'any host no path': withPath(['*'], {}),
    'any .com no path': withPath(['*.com'], {}),
  }
  const keyHosts = JSON.stringify({
    GITLAB: ['a.example.com'],
    AX_AUTH_X: ['a.example.com'],
    MY_AX_AUTH: ['a.example.com'],
  })
  for (const [name, body] of Object.entries(allowed)) {
    const { calls, c } = setup(undefined, { FACTORY_BROKER_KEY_HOSTS: keyHosts })
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
    'vault v%2FGITHUB_%52EVIEWER': withHdr({
      credentialUri: 'ate-secret://agent-vault/v%2FGITHUB_%52EVIEWER/GITHUB_REVIEWER',
    }),
    'vault AX_AUTH': withHdr({ credentialUri: 'ate-secret://agent-vault/AX_AUTH/GITHUB_REVIEWER' }),
    'vault ..': withHdr({ credentialUri: 'ate-secret://agent-vault/../GITHUB_REVIEWER' }),
    'vault Factory': withHdr({ credentialUri: 'ate-secret://agent-vault/Factory/GITHUB_REVIEWER' }),
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
const REVIEWER_HOSTS = JSON.stringify({ REVIEWER: ['a.example.com'], BUILDBUDDY: ['a.example.com'] })
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
    'git vault v%2FX': gitWith({
      effects: {
        replaceHeaders: [
          { ...gitHdr, credentialUri: 'ate-secret://agent-vault/v%2FX/GITHUB_REVIEWER_BASIC' },
        ],
      },
    }),
    'git vault AX_AUTH': gitWith({
      effects: {
        replaceHeaders: [
          { ...gitHdr, credentialUri: 'ate-secret://agent-vault/AX_AUTH/GITHUB_REVIEWER_BASIC' },
        ],
      },
    }),
    'git vault ..': gitWith({
      effects: {
        replaceHeaders: [{ ...gitHdr, credentialUri: 'ate-secret://agent-vault/../GITHUB_REVIEWER_BASIC' }],
      },
    }),
    'api effects extra key': rulesOf(
      reviewerRule({ effects: { replaceHeaders: api.effects.replaceHeaders, replace_headers: [] } }),
    ),
    'api header extra key': rulesOf(
      reviewerRule({
        effects: { replaceHeaders: [{ ...api.effects.replaceHeaders[0], credential_uri: 'x' }] },
      }),
    ),
    'git effects extra key': gitWith({ effects: { replaceHeaders: [gitHdr], replace_headers: [] } }),
    'git header extra key': gitWith({
      effects: { replaceHeaders: [{ ...gitHdr, credential_uri: 'x' }] },
    }),
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
    'look-alike GITHUB_REVIEW': rulesOf(hostRule(['github.com'], 'GITHUB_REVIEW')),
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
    const { calls, c } = setup(undefined, { FACTORY_BROKER_KEY_HOSTS: REVIEWER_HOSTS })
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 200])
    expect(calls.length).toBe(2)
  }
})

test('a policy with the reviewer API rule gets no other key on a github host', async () => {
  const api = reviewerRule()
  const author = hostRule(['github.com'], 'GITHUB_BASIC')
  const refused: Record<string, unknown> = {
    'api + GITHUB_BASIC on github.com': rulesOf(api, author),
    'api + GITHUB on api.github.com': rulesOf(api, hostRule(['api.github.com'], 'GITHUB')),
    'pair + *.com': rulesOf(api, gitRule(), hostRule(['*.com'], 'GITHUB_ZS_BASIC')),
    'api + *': rulesOf(api, hostRule(['*'], 'GITHUB')),
    'api + *.github.com': rulesOf(api, hostRule(['*.github.com'], 'GITHUB')),
    'case and trailing dot': rulesOf(api, hostRule(['GitHub.com.'], 'GITHUB_BASIC')),
    'keyed rule before api': rulesOf(author, api),
    'http wrapper': { rules: [{ https: api }, { http: author }] },
    'extra key, no credential': rulesOf(api, {
      hostnames: ['codeload.github.com'],
      effects: { replaceHeaders: [] },
    }),
    'mixed host list': rulesOf(api, hostRule(['a.example.com', 'github.com'], 'BUILDBUDDY')),
    'github host, no key, then key on relay': rulesOf(
      api,
      { hostnames: ['github.com'] },
      hostRule(['relay.example.com'], 'GITHUB_BASIC'),
    ),
    'pair + GITHUB on relay': rulesOf(api, gitRule(), hostRule(['relay.example.com'], 'GITHUB')),
    'api + GITHUB_ZS_BASIC on relay': rulesOf(api, hostRule(['relay.example.com'], 'GITHUB_ZS_BASIC')),
    'hostnames as a string, with a key': rulesOf(api, {
      hostnames: 'github.com',
      effects: hostRule(['x'], 'BUILDBUDDY').effects,
    }),
  }
  for (const [name, body] of Object.entries(refused)) {
    expect([name, typeof workerPolicyRefusal(body)]).toEqual([name, 'string'])
    const { calls, c } = setup()
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 400])
    expect(calls).toEqual([])
  }
  const accepted: Record<string, unknown> = {
    'api alone': rulesOf(api),
    pair: rulesOf(api, gitRule()),
    'pair + codeload': rulesOf(api, gitRule(), { hostnames: ['codeload.github.com'] }),
    'pair + codeload + ports': rulesOf(api, gitRule(), {
      hostnames: ['codeload.github.com'],
      ports: { numbers: [443] },
    }),
    'pair + keyed other host': rulesOf(api, gitRule(), hostRule(['a.example.com'], 'BUILDBUDDY')),
    'no reviewer rule, GITHUB and GITHUB_BASIC': rulesOf(
      hostRule(['github.com'], 'GITHUB'),
      hostRule(['github.com'], 'GITHUB_BASIC'),
    ),
    'egressPolicy reviewer with extras': ax.egressPolicy(
      'v',
      [{ hosts: ['codeload.github.com'] }, { hosts: ['a.example.com'], key: 'BUILDBUDDY' }],
      undefined,
      undefined,
      'acme',
      undefined,
      true,
      false,
      'widget',
    ),
  }
  for (const [name, body] of Object.entries(accepted)) {
    expect([name, workerPolicyRefusal(body)]).toEqual([name, null])
    const { calls, c } = setup(undefined, { FACTORY_BROKER_KEY_HOSTS: REVIEWER_HOSTS })
    const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
    expect([name, res.status]).toEqual([name, 200])
    expect(calls.length).toBe(2)
  }
})

const KEEP = JSON.stringify({
  GITLAB: ['gitlab.acme.example'],
  GITLAB_BASIC: ['gitlab.acme.example'],
  DOLT_BASIC: ['dolt.acme.example'],
  BUILDBUDDY: ['cache.acme.example'],
})
const keyed = (hostnames: unknown, key: string, over: Record<string, unknown> = {}) => ({
  rules: [
    {
      https: {
        hostnames,
        effects: { replaceHeaders: [{ header: 'Authorization', prefix: 'Bearer ', credentialUri: U(key) }] },
        ...over,
      },
    },
  ],
})
const put = async (body: unknown, keyHosts?: string) => {
  const { calls, c } = setup(undefined, keyHosts ? { FACTORY_BROKER_KEY_HOSTS: keyHosts } : {})
  const res = await handle(req('PUT', '/policy/factory/f-r1-1', JSON.stringify(body)), c)
  return { status: res.status, calls: calls.length, keyHosts: c.keyHosts }
}

test('every worker egressPolicy output passes the key pins', async () => {
  const dolt = ax.withDoltEgress([], { beadsRemote: { url: 'https://dolt.acme.example/acme/beads' } })!
  expect(dolt.some(e => e.key === 'DOLT_BASIC')).toBe(true)
  const rows: Record<string, [unknown, string | undefined]> = {
    acme: [ax.egressPolicy('v', [], undefined, undefined, 'acme'), undefined],
    'zach-source': [ax.egressPolicy('v', [], undefined, undefined, 'zach-source'), undefined],
    reviewer: [
      ax.egressPolicy('v', [], undefined, undefined, 'acme', undefined, true, false, 'widget'),
      undefined,
    ],
    grok: [ax.egressPolicy('v', grokEgress([]), undefined, undefined, 'acme'), undefined],
    cursor: [ax.egressPolicy('v', cursorEgress([]), undefined, undefined, 'acme'), undefined],
    codex: [ax.egressPolicy('v', codexEgress([]), undefined, undefined, 'acme'), undefined],
    gitlab: [ax.egressPolicy('v', [], undefined, 'gitlab.acme.example', 'acme'), KEEP],
    buildbuddy: [
      ax.egressPolicy(
        'v',
        [{ hosts: ['cache.acme.example'], key: 'BUILDBUDDY' }],
        undefined,
        undefined,
        'acme',
      ),
      KEEP,
    ],
    dolt: [ax.egressPolicy('v', dolt, undefined, undefined, 'acme'), KEEP],
  }
  for (const [name, [body, env]] of Object.entries(rows)) {
    const r = await put(body, env)
    expect([name, workerPolicyRefusal(body), keyHostRefusal(body, r.keyHosts)]).toEqual([name, null, null])
    expect([name, r.status, r.calls]).toEqual([name, 200, 2])
  }
})

test('a pinned vault key on another host is refused', async () => {
  const rows: Record<string, unknown> = {}
  for (const k of [
    'GITHUB_BASIC',
    'GITHUB',
    'GITHUB_ZS_BASIC',
    'ANTHROPIC',
    'XAI_API_KEY',
    'GROK_SESSION',
    'CURSOR_API_KEY',
    'CODEX_CHATGPT',
    'CODEX_CHATGPT_ACCOUNT',
  ])
    rows['relay ' + k] = keyed(['relay.example.com'], k)
  Object.assign(rows, {
    'ANTHROPIC on github': keyed(['api.github.com'], 'ANTHROPIC'),
    'GITHUB on anthropic': keyed(['api.anthropic.com'], 'GITHUB'),
    'XAI on chatgpt': keyed(['chatgpt.com'], 'XAI_API_KEY'),
    'mixed list': keyed(['api.anthropic.com', 'relay.example.com'], 'ANTHROPIC'),
    'upper case': keyed(['API.ANTHROPIC.COM'], 'ANTHROPIC'),
    'trailing dot': keyed(['api.anthropic.com.'], 'ANTHROPIC'),
    star: keyed(['*'], 'ANTHROPIC'),
    'star anthropic': keyed(['*.anthropic.com'], 'ANTHROPIC'),
    'star github': keyed(['*.github.com'], 'GITHUB'),
    'star com': keyed(['*.com'], 'GITHUB'),
    'codex second entry': keyed(['chatgpt.com'], 'CODEX_CHATGPT', {
      effects: {
        replaceHeaders: [
          { header: 'Authorization', prefix: 'Bearer ', credentialUri: U('CODEX_CHATGPT') },
          { header: 'X-Key', prefix: '', credentialUri: U('ANTHROPIC') },
        ],
      },
    }),
  })
  for (const [name, body] of Object.entries(rows)) {
    expect([name, workerPolicyRefusal(body)]).toEqual([name, null])
    expect([name, typeof keyHostRefusal(body, {})]).toEqual([name, 'string'])
    const r = await put(body)
    expect([name, r.status, r.calls]).toEqual([name, 400, 0])
  }
  const cfg = JSON.stringify({ GITLAB: ['gitlab.acme.example'] })
  for (const h of [['relay.example.com'], ['gitlab.acme.example', 'relay.example.com']]) {
    const r = await put(keyed(h, 'GITLAB'), cfg)
    expect([h, r.status, r.calls]).toEqual([h, 400, 0])
  }
  const ok: [string[], string, Record<string, unknown>?][] = [
    [['api.github.com'], 'GITHUB'],
    [['uploads.github.com'], 'GITHUB'],
    [['github.com'], 'GITHUB_BASIC'],
    [['api.anthropic.com'], 'ANTHROPIC'],
    [['api.x.ai'], 'XAI_API_KEY'],
    [['api2.cursor.sh'], 'CURSOR_API_KEY'],
    [['chatgpt.com'], 'CODEX_CHATGPT', { ports: { numbers: [443] } }],
    [['chatgpt.com'], 'CODEX_CHATGPT_ACCOUNT'],
  ]
  for (const [h, k, over] of ok) {
    const r = await put(keyed(h, k, over))
    expect([k, h, r.status, r.calls]).toEqual([k, h, 200, 2])
  }
})

test('a key with no pinned hosts is refused', async () => {
  for (const [k, h] of [
    ['BUILDBUDDY', 'cache.acme.example'],
    ['GITLAB', 'gitlab.acme.example'],
    ['DOLT_BASIC', 'dolt.acme.example'],
  ] as const) {
    const r = await put(keyed([h], k))
    expect([k, r.status, r.calls]).toEqual([k, 400, 0])
  }
  const cfg = JSON.stringify({ BUILDBUDDY: ['cache.acme.example'] })
  expect((await put(keyed(['cache.acme.example'], 'BUILDBUDDY'), cfg)).status).toBe(200)
  expect((await put(keyed(['cache.acme.example'], 'KUBE_READ'), cfg)).status).toBe(400)
})

test('a credentialUri or effects outside rules[i].https.effects.replaceHeaders is refused', async () => {
  const entry = { header: 'Authorization', prefix: 'Bearer ', credentialUri: U('ANTHROPIC') }
  const effects = { replaceHeaders: [entry] }
  const hostnames = ['api.anthropic.com']
  const rule = (https: unknown) => ({ rules: [{ https }] })
  const rows: Record<string, unknown> = {
    'no effects': rule({ hostnames, replaceHeaders: [entry] }),
    'http effects': { rules: [{ http: { hostnames, effects } }] },
    'effects beside https': { rules: [{ https: { hostnames }, effects }] },
    'Effects spelling': rule({ hostnames, Effects: effects }),
    'Hostnames spelling': rule({ hostnames, Hostnames: ['relay.example.com'], effects }),
    'extra field in https': rule({ hostnames, effects, extra: 1 }),
    'extra field in rule': { rules: [{ https: { hostnames, effects }, extra: 1 }] },
    'http beside https': { rules: [{ https: { hostnames, effects }, http: { hostnames } }] },
    'two effects keys': rule({ hostnames, effects: { replaceHeaders: [entry], setHeaders: [] } }),
    'replaceHeaders object': rule({ hostnames, effects: { replaceHeaders: entry } }),
    'effects array': rule({ hostnames, effects: [] }),
    'effects null': rule({ hostnames, effects: null }),
    'entry credential_uri': rule({
      hostnames,
      effects: { replaceHeaders: [{ ...entry, credential_uri: U('ANTHROPIC') }] },
    }),
    'entry hostnames': rule({
      hostnames,
      effects: { replaceHeaders: [{ ...entry, hostnames: ['relay.example.com'] }] },
    }),
    'entry only credential_uri': rule({
      hostnames,
      effects: { replaceHeaders: [{ header: 'Authorization', credential_uri: U('ANTHROPIC') }] },
    }),
    'no hostnames': rule({ effects }),
    'empty hostnames': rule({ hostnames: [], effects }),
    'string hostnames': rule({ hostnames: 'api.anthropic.com', effects }),
    'number hostnames': rule({ hostnames: [5], effects }),
    'number hostnames, no entry': rule({ hostnames: [5], effects: { replaceHeaders: [] } }),
    'credentialUri array': rule({
      hostnames,
      effects: { replaceHeaders: [{ header: 'Authorization', credentialUri: [U('ANTHROPIC')] }] },
    }),
    'empty effects beside https': { rules: [{ https: { hostnames }, effects: {} }] },
    'empty effects in http': { rules: [{ http: { hostnames, effects: {} } }] },
    'top level credentialUri': { ...rule({ hostnames, effects }), credentialUri: U('ANTHROPIC') },
  }
  for (const [name, body] of Object.entries(rows)) {
    const r = await put(body)
    expect([name, typeof keyHostRefusal(body, {}), r.status, r.calls]).toEqual([name, 'string', 400, 0])
  }
  const ok: Record<string, unknown> = {
    'no effects, any host': rule({ hostnames: ['relay.example.com'] }),
    'no prefix': rule({
      hostnames,
      effects: { replaceHeaders: [{ header: 'Authorization', credentialUri: U('ANTHROPIC') }] },
    }),
    'empty replaceHeaders': rule({ hostnames: ['relay.example.com'], effects: { replaceHeaders: [] } }),
  }
  for (const [name, body] of Object.entries(ok)) {
    const r = await put(body)
    expect([name, r.status, r.calls]).toEqual([name, 200, 2])
  }
})

test('FACTORY_BROKER_KEY_HOSTS is parsed and a bad value throws', () => {
  expect(configFrom({}).keyHosts).toEqual({})
  expect(configFrom({ FACTORY_BROKER_KEY_HOSTS: '' }).keyHosts).toEqual({})
  const good = { GITLAB: ['gitlab.acme.example', 'a-b.example.com'], K1: ['x.example.com'] }
  expect(configFrom({ FACTORY_BROKER_KEY_HOSTS: JSON.stringify(good) }).keyHosts).toEqual(good)
  expect(keyHostsFrom(JSON.stringify(good))).toEqual(good)
  for (const bad of [
    'not json',
    '[]',
    'null',
    '"x"',
    '{"gitlab":["a.example.com"]}',
    '{"GITHUB_X":["a.example.com"]}',
    '{"ANTHROPIC":["a.example.com"]}',
    '{"CODEX_CHATGPT":["a.example.com"]}',
    '{"XAI_API_KEY":["a.example.com"]}',
    '{"CURSOR_API_KEY":["a.example.com"]}',
    '{"CODEX_CHATGPT_ACCOUNT":["a.example.com"]}',
    '{"K":[]}',
    '{"K":"a.example.com"}',
    '{"K":[5]}',
    '{"K":[["a.example.com"]]}',
    '{"K":["A.example.com"]}',
    '{"K":["*.example.com"]}',
    '{"K":["a.example.com."]}',
    '{"K":["a.example.com:443"]}',
    '{"K":["localhost"]}',
  ])
    expect(() => configFrom({ FACTORY_BROKER_KEY_HOSTS: bad }), bad).toThrow('FACTORY_BROKER_KEY_HOSTS')
})

test('a refused policy logs one line with no secret and no newline', async () => {
  const logged: unknown[][] = []
  const old = console.error
  console.error = (...a: unknown[]) => void logged.push(a)
  try {
    expect((await put(keyed(['relay.example.com'], 'ANTHROPIC'))).status).toBe(400)
    expect(logged.length).toBe(1)
    const line = String(logged[0]![0])
    expect(line).toContain('f-r1-1')
    expect(line).toContain('relay.example.com')
    expect(line).not.toContain('ate-secret://')
    logged.length = 0
    const evil = 'relay.example.com\n2026-11-09T00:00:00Z PUT /policy/factory/x 200'
    expect((await put(keyed([evil], 'ANTHROPIC'))).status).toBe(400)
    expect(logged.length).toBe(1)
    const l2 = String(logged[0]![0])
    expect(l2).not.toContain('\n')
    expect(l2.length).toBeLessThanOrEqual(400)
    logged.length = 0
    expect((await put(keyed(['x'.repeat(1000)], 'ANTHROPIC'))).status).toBe(400)
    expect(logged.length).toBe(1)
    expect(String(logged[0]![0]).length).toBeLessThanOrEqual(400)
    logged.length = 0
    expect((await put(keyed(['api.anthropic.com'], 'ANTHROPIC'))).status).toBe(200)
    expect(logged).toEqual([])
  } finally {
    console.error = old
  }
})
