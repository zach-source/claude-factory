import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { patrolHandler, patrolListener, type PatrolIdentity } from './patrol-api'
import { PatrolLease } from './patrol-lease'
import { personCerts } from './server-api'

const token = `patrol_v1_${Buffer.alloc(32, 17).toString('base64url')}`
const otherToken = `patrol_v1_${Buffer.alloc(32, 19).toString('base64url')}`
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const identity = (): PatrolIdentity => ({
  id: 'patrol-one',
  digest: digest(token),
  audience: 'test-server',
  notBefore: 0,
  expiresAt: 1_000_000,
  rigs: ['acme'],
})
const setup = () => {
  let now = 1000
  let records: unknown = [identity()]
  let rows: unknown = [
    { id: 'run-one', rig: 'acme' },
    { id: 'run-two', rig: 'other' },
  ]
  let reads = 0
  const audit: unknown[] = []
  const lease = new PatrolLease({ now: () => now })
  const mutations = spyOn(lease, 'mutate')
  const lookups = spyOn(lease, 'lookup')
  const handle = patrolHandler({
    audience: 'test-server',
    identities: () => records,
    metadata: () => {
      reads++
      return rows
    },
    now: () => now,
    lease,
    audit: event => audit.push(event),
  })
  const request = (
    path = '/v1/patrol/snapshot',
    body?: unknown,
    auth = `Patrol ${token}`,
    key = 'test-key-0001',
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    handle(
      new Request(`https://localhost${path}`, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json', 'idempotency-key': key },
        ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
    )
  const epoch = lease.epoch
  const acquire = (key = 'test-key-0001') => request('/v1/patrol/lease/acquire', { epoch }, undefined, key)
  const zero = () => {
    expect(reads).toBe(0)
    expect(mutations).not.toHaveBeenCalled()
    expect(lookups).not.toHaveBeenCalled()
  }
  const clear = () => {
    reads = 0
    mutations.mockClear()
    lookups.mockClear()
  }
  return {
    handle,
    request,
    acquire,
    epoch,
    lease,
    audit,
    zero,
    clear,
    reads: () => reads,
    records: (v: unknown) => {
      records = v
    },
    rows: (v: unknown) => {
      rows = v
    },
    time: (v: number) => {
      now = v
    },
  }
}

describe('1ocuv AC1 identity before application access', () => {
  test('valid identity reaches only scoped metadata', async () => {
    const t = setup()
    expect((await t.request()).status).toBe(200)
    expect(t.reads()).toBe(1)
    t.time(0)
    expect((await t.request()).status).toBe(200)
  })
  for (const auth of [
    '',
    'Bearer v1.worker.token',
    'Patrol arbitrary',
    `Bearer ${token}`,
    `Patrol ${token}=`,
    `Patrol ${token.slice(0, -1)}B`,
    `Patrol ${otherToken}`,
  ])
    test(`invalid credential row ${auth.length} ${auth.slice(0, 6)}`, async () => {
      const t = setup()
      await t.acquire()
      t.clear()
      expect((await t.request(undefined, undefined, auth)).status).toBe(401)
      t.zero()
    })
  const invalid: [string, (r: PatrolIdentity) => unknown][] = [
    ['future', r => [{ ...r, notBefore: 1001 }]],
    ['expired', r => [{ ...r, expiresAt: 1000 }]],
    ['audience', r => [{ ...r, audience: 'elsewhere' }]],
    ['revoked', () => []],
    ['rotated', r => [{ ...r, id: 'new-id', digest: digest(otherToken) }]],
    ['duplicate id', r => [r, { ...r, digest: digest(otherToken) }]],
    ['duplicate digest', r => [r, { ...r, id: 'other' }]],
    ['unknown field', r => [{ ...r, secret: 'zqsecret' }]],
    ['bad id', r => [{ ...r, id: '../run' }]],
    ['bad digest', r => [{ ...r, digest: r.digest.toUpperCase() }]],
    ['bad time', r => [{ ...r, notBefore: -1 }]],
    ['unsafe time', r => [{ ...r, expiresAt: Number.MAX_SAFE_INTEGER + 1 }]],
    ['empty interval', r => [{ ...r, expiresAt: 0 }]],
    ['empty scope', r => [{ ...r, rigs: [] }]],
    ['wildcard', r => [{ ...r, rigs: ['*'] }]],
    ['duplicate rig', r => [{ ...r, rigs: ['acme', 'acme'] }]],
    ['too many rigs', r => [{ ...r, rigs: Array.from({ length: 101 }, (_, i) => `rig-${i}`) }]],
    [
      'too many records',
      r => Array.from({ length: 101 }, (_, i) => ({ ...r, id: `id-${i}`, digest: digest(`fake-${i}`) })),
    ],
    ['null', () => null],
  ]
  for (const [name, change] of invalid)
    test(name, async () => {
      const t = setup()
      await t.acquire()
      t.clear()
      t.records(change(identity()))
      expect((await t.acquire()).status).toBe(401)
      t.zero()
    })
  test('revocation and rotation take effect without restart', async () => {
    const t = setup()
    await t.acquire()
    t.records([{ ...identity(), id: 'new-id', digest: digest(otherToken) }])
    expect((await t.request(undefined, undefined, `Patrol ${otherToken}`)).status).toBe(200)
    t.clear()
    expect((await t.acquire()).status).toBe(401)
    t.zero()
  })
  test('provider failures refuse access without raw errors', async () => {
    const t = setup()
    const handle = patrolHandler({
      audience: 'test-server',
      identities: () => {
        throw new Error('zqsecret')
      },
      metadata: () => {
        throw new Error('must not run')
      },
      lease: t.lease,
      now: () => 1000,
      audit: e => t.audit.push(e),
    })
    const response = await handle(
      new Request('https://localhost/v1/patrol/snapshot', { headers: { authorization: `Patrol ${token}` } }),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid_identity' })
    expect(JSON.stringify(t.audit)).not.toContain('zqsecret')
    t.zero()
  })
  test('a noncanonical token fails even when its digest is registered', async () => {
    const t = setup()
    const malformed = token.slice(0, -1) + 'B'
    expect(Buffer.from(malformed.slice('patrol_v1_'.length), 'base64url').toString('base64url')).not.toBe(
      malformed.slice('patrol_v1_'.length),
    )
    t.records([{ ...identity(), digest: digest(malformed) }])
    expect((await t.request(undefined, undefined, `Patrol ${malformed}`)).status).toBe(401)
    t.zero()
  })
})

describe('1ocuv AC2 closed grammar', () => {
  test('key boundaries and field order remain valid', async () => {
    for (const key of ['a'.repeat(8), 'Z'.repeat(128)]) {
      const t = setup()
      const acquired = (await (await t.acquire(key)).json()) as { generation: string }
      expect(
        (
          await t.request(
            '/v1/patrol/lease/renew',
            { generation: acquired.generation, epoch: t.epoch },
            undefined,
            'renew-key',
          )
        ).status,
      ).toBe(200)
    }
  })
  test('canonical JSON rejects duplicate keys, whitespace, and alternate escapes with a valid epoch', async () => {
    const t = setup()
    for (const text of [
      ` {"epoch":"${t.epoch}"}`,
      `{"epoch":"${t.epoch}","epoch":"${t.epoch}"}`,
      `{"epoch":"${t.epoch.replace('-', '\\u002d')}"}`,
    ]) {
      expect((await t.request('/v1/patrol/lease/acquire', text)).status).toBe(400)
      t.zero()
    }
  })
  test('generation and outcome use closed types and values', async () => {
    const t = setup()
    for (const generation of [null, 1, 'not-a-uuid', '11111111-1111-4111-8111-11111111111A']) {
      expect((await t.request('/v1/patrol/lease/renew', { epoch: t.epoch, generation })).status).toBe(400)
      t.zero()
    }
    for (const outcome of [null, true, 1, 'unknown']) {
      expect(
        (
          await t.request('/v1/patrol/lease/complete', {
            epoch: t.epoch,
            generation: '11111111-1111-4111-8111-111111111111',
            outcome,
          })
        ).status,
      ).toBe(400)
      t.zero()
    }
  })
  test('an oversized stream is cancelled before further reads', async () => {
    const t = setup()
    let cancelled = false
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(4097))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await t.handle(
      new Request('https://localhost/v1/patrol/lease/acquire', {
        method: 'POST',
        headers: {
          authorization: `Patrol ${token}`,
          'content-type': 'application/json',
          'idempotency-key': 'test-key-0001',
        },
        body: stream,
      }),
    )
    expect(response.status).toBe(400)
    expect(cancelled).toBe(true)
    t.zero()
  })
  test('revocation during a body read prevents a lease call', async () => {
    const t = setup()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    const pending = t.handle(
      new Request('https://localhost/v1/patrol/lease/acquire', {
        method: 'POST',
        headers: {
          authorization: `Patrol ${token}`,
          'content-type': 'application/json',
          'idempotency-key': 'test-key-0001',
        },
        body: stream,
      }),
    )
    t.records([])
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ epoch: t.epoch })))
    controller.close()
    expect((await pending).status).toBe(401)
    t.zero()
  })
  const paths = [
    'decisions',
    'gates',
    'start',
    'owned-start',
    'goto',
    'abort',
    'halt',
    'wake',
    'held',
    'screen',
    'logs',
    'catalog',
    'mail',
    'workers/mail',
    'files',
    'shell',
  ]
  for (const path of paths)
    for (const prefix of ['/v1/', '/v1/patrol/'])
      test(`deny ${prefix}${path}`, async () => {
        const t = setup()
        expect((await t.request(`${prefix}${path}`, { command: 'no' })).status).toBe(403)
        t.zero()
      })
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])
    test(`deny ${method}`, async () => {
      const t = setup()
      expect((await t.request('/v1/patrol/snapshot', undefined, undefined, undefined, method)).status).toBe(
        403,
      )
      t.zero()
    })
  for (const route of ['acquire', 'renew', 'complete']) {
    for (const body of [
      null,
      [],
      1,
      {},
      { epoch: 1 },
      { epoch: 'bad' },
      { epoch: 'bad', unknown: true },
      '{"epoch":"a","epoch":"b"}',
      ' {"epoch":"a"}',
      '{ "epoch": "a" }',
      'x'.repeat(4097),
    ])
      test(`${route} invalid body ${JSON.stringify(body).slice(0, 45)}`, async () => {
        const t = setup()
        expect((await t.request(`/v1/patrol/lease/${route}`, body)).status).toBe(400)
        t.zero()
      })
    test(`${route} rejects an unknown field in an otherwise valid body`, async () => {
      const t = setup()
      const generation = '11111111-1111-4111-8111-111111111111'
      const body =
        route === 'acquire'
          ? { epoch: t.epoch }
          : route === 'renew'
            ? { epoch: t.epoch, generation }
            : { epoch: t.epoch, generation, outcome: 'failed' }
      expect((await t.request(`/v1/patrol/lease/${route}`, { ...body, unknown: true })).status).toBe(400)
      t.zero()
    })
  }
  for (const key of ['', 'short', 'has space-000', 'x'.repeat(129), 'underscore_000'])
    test(`bad idempotency key ${key.length}`, async () => {
      const t = setup()
      expect((await t.acquire(key)).status).toBe(400)
      t.zero()
    })
  for (const path of [
    '/v1/patrol/snapshot?',
    '/v1/patrol/snapshot?x=1',
    '/v1/patrol/snapshot/',
    '/v1//patrol/snapshot',
    '/v1/patrol/runs/%72un-one',
    '/v1/patrol/runs/a.b',
  ])
    test(`invalid target ${path}`, async () => {
      const t = setup()
      expect((await t.request(path)).status).toBe(400)
      t.zero()
    })
  test('POST needs the exact content type', async () => {
    const t = setup()
    const r = await t.handle(
      new Request('https://localhost/v1/patrol/lease/acquire', {
        method: 'POST',
        headers: { authorization: `Patrol ${token}`, 'idempotency-key': 'test-key-0001' },
        body: JSON.stringify({ epoch: t.epoch }),
      }),
    )
    expect(r.status).toBe(400)
    t.zero()
  })
})

describe('1ocuv AC3 metadata projection', () => {
  test('metadata exceptions give only the fixed unavailable error', async () => {
    const t = setup()
    const handle = patrolHandler({
      audience: 'test-server',
      identities: () => [identity()],
      metadata: () => {
        throw new Error('zqsecret')
      },
      lease: t.lease,
      now: () => 1000,
      audit: e => t.audit.push(e),
    })
    const response = await handle(
      new Request('https://localhost/v1/patrol/snapshot', { headers: { authorization: `Patrol ${token}` } }),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
    expect(JSON.stringify(t.audit)).not.toContain('zqsecret')
  })
  test('the projection drops provider prototypes and serialization hooks', async () => {
    const t = setup()
    const row = Object.assign(
      Object.create({
        toJSON() {
          return { secret: 'zqsecret' }
        },
      }),
      { id: 'one', rig: 'acme' },
    )
    t.rows([row])
    expect(await (await t.request()).json()).toEqual({ epoch: t.epoch, runs: [{ id: 'one', rig: 'acme' }] })
    expect(await (await t.request('/v1/patrol/runs/one')).json()).toEqual({ run: { id: 'one', rig: 'acme' } })
  })
  test('exact keys, scope, sort, and identifier boundaries', async () => {
    const t = setup()
    const boundary = `A${'x'.repeat(127)}`
    t.rows([
      { id: boundary, rig: 'acme' },
      { id: '0', rig: 'acme' },
      { id: 'hidden', rig: 'other' },
    ])
    expect(await (await t.request()).json()).toEqual({
      epoch: t.epoch,
      runs: [
        { id: '0', rig: 'acme' },
        { id: boundary, rig: 'acme' },
      ],
    })
    expect(await (await t.request(`/v1/patrol/runs/${boundary}`)).json()).toEqual({
      run: { id: boundary, rig: 'acme' },
    })
    for (const id of ['hidden', 'absent']) expect((await t.request(`/v1/patrol/runs/${id}`)).status).toBe(404)
  })
  for (const rows of [
    null,
    {},
    [{ id: 'one' }],
    [{ id: 'one', rig: '*' }],
    [{ id: 'a'.repeat(129), rig: 'acme' }],
    [{ id: 'one', rig: 'acme', token: 'zqsecret', logs: { text: 'zqsecret' } }],
    [
      { id: 'one', rig: 'acme' },
      { id: 'one', rig: 'other' },
    ],
    Array.from({ length: 1001 }, (_, i) => ({ id: `r-${i}`, rig: 'acme' })),
  ])
    test(`reject malformed metadata ${JSON.stringify(rows).length}`, async () => {
      const t = setup()
      t.rows(rows)
      const r = await t.request()
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ error: 'unavailable' })
      expect(JSON.stringify(t.audit)).not.toContain('zqsecret')
    })
})

describe('1ocuv AC4 handler lease and audit', () => {
  test('exact acquire replay, renew, and complete', async () => {
    const t = setup()
    const first = (await (await t.acquire()).json()) as {
      epoch: string
      generation: string
      expiresAt: number
    }
    expect(first).toEqual({
      epoch: t.epoch,
      generation: expect.stringMatching(/^[a-f0-9-]{36}$/),
      expiresAt: 61000,
    })
    expect(await (await t.acquire()).json()).toEqual(first)
    expect((await t.acquire('different-key')).status).toBe(409)
    t.time(2000)
    const body = { epoch: t.epoch, generation: first.generation }
    expect(await (await t.request('/v1/patrol/lease/renew', body, undefined, 'renew-key')).json()).toEqual({
      ...body,
      expiresAt: 62000,
    })
    const done = { ...body, outcome: 'success' }
    expect(
      await (await t.request('/v1/patrol/lease/complete', done, undefined, 'complete-key')).json(),
    ).toEqual({ completed: true })
    expect((await t.request('/v1/patrol/lease/complete', done, undefined, 'complete-key')).status).toBe(200)
    expect(t.audit).toContainEqual({
      at: 2000,
      epoch: t.epoch,
      generation: first.generation,
      identity: 'patrol-one',
      operation: 'complete',
      reason: 'ok',
      status: 200,
    })
    await t.acquire('new-acquire')
    t.clear()
    expect((await t.request('/v1/patrol/lease/complete', done, undefined, 'complete-key')).status).toBe(409)
    expect(t.lease.lookup).not.toHaveBeenCalled()
  })
  test('audit uses only fixed fields and labels', async () => {
    const t = setup()
    await t.request()
    await t.request('/v1/patrol/shell/zqsecret', { secret: 'zqsecret' })
    await t.request(undefined, undefined, 'Bearer zqsecret')
    await t.acquire()
    for (const event of t.audit) {
      expect(Object.keys(event as object).sort()).toEqual([
        'at',
        'epoch',
        'generation',
        'identity',
        'operation',
        'reason',
        'status',
      ])
      expect(event).toMatchObject({ at: 1000, epoch: t.epoch })
    }
    expect(t.audit).toContainEqual({
      at: 1000,
      epoch: t.epoch,
      generation: null,
      identity: 'patrol-one',
      operation: 'snapshot',
      reason: 'ok',
      status: 200,
    })
    const text = JSON.stringify(t.audit)
    for (const secret of ['zqsecret', token, digest(token), 'shell/']) expect(text).not.toContain(secret)
  })
})

mkdirSync(join(import.meta.dir, '..', '.scratch'), { recursive: true })
const home = mkdtempSync(join(import.meta.dir, '..', '.scratch', 'patrol-tls-'))
const certDir = join(home, 'certs')
personCerts(certDir, 'localhost')
afterAll(() => rmSync(home, { recursive: true, force: true }))
const raw = (
  port: number,
  target: string,
  headers = `Authorization: Patrol ${token}\r\n`,
  method = 'GET',
  body = '',
) =>
  new Promise<string>((resolve, reject) => {
    const sock = connect(
      {
        port,
        host: 'localhost',
        servername: 'localhost',
        ca: readFileSync(join(certDir, 'ca.crt')),
        minVersion: 'TLSv1.2',
      },
      () =>
        sock.write(
          `${method} ${target} HTTP/1.1\r\nHost: localhost\r\n${headers}Connection: close\r\n\r\n${body}`,
        ),
    )
    let out = ''
    sock.on('data', b => {
      out += b.toString()
    })
    sock.on('end', () => resolve(out))
    sock.on('error', reject)
    sock.setTimeout(5000, () => sock.destroy(new Error('TLS test timeout')))
  })

test('1ocuv AC1 AC2 real TLS checks raw targets and duplicate headers before application access', async () => {
  const t = setup()
  const server = patrolListener({
    port: 0,
    cert: readFileSync(join(certDir, 'server.crt'), 'utf8'),
    key: readFileSync(join(certDir, 'server.key'), 'utf8'),
    handle: t.handle,
  })
  try {
    expect(await raw(server.port, '/v1/patrol/snapshot')).toContain('HTTP/1.1 200')
    t.clear()
    expect(await raw(server.port, '/v1/patrol/snapshot', '')).toContain('HTTP/1.1 401')
    t.zero()
    for (const target of [
      '/v1/patrol/../patrol/snapshot',
      '/v1/patrol/runs/%2fetc',
      'https://localhost/v1/patrol/snapshot',
      '/v1/patrol/snapshot?',
      '/v1/patrol//snapshot',
    ]) {
      expect(await raw(server.port, target)).toContain('HTTP/1.1 400')
      t.zero()
    }
    for (const extra of [
      'Authorization: Patrol duplicate\r\n',
      'Content-Length: 0\r\nContent-Length: 0\r\n',
      'Transfer-Encoding: chunked\r\n',
    ]) {
      expect(
        await raw(server.port, '/v1/patrol/snapshot', `Authorization: Patrol ${token}\r\n${extra}`),
      ).toContain('HTTP/1.1 400')
      t.zero()
    }
    expect(
      await raw(
        server.port,
        '/v1/patrol/snapshot',
        `Authorization: Patrol ${token}\r\nContent-Length: 1\r\n`,
        'GET',
        'x',
      ),
    ).toContain('HTTP/1.1 400')
    expect(
      await raw(
        server.port,
        '/v1/patrol/lease/acquire',
        `Authorization: Patrol ${token}\r\nContent-Length: 4097\r\n`,
        'POST',
      ),
    ).toContain('HTTP/1.1 400')
    t.zero()
  } finally {
    server.stop()
  }
})

test('1ocuv AC5 lease failure, expiry, restart, and forbidden mail preserve mail bytes', async () => {
  const path = join(home, 'mail.json')
  const bytes = '{"mail":[{"id":"m1","text":"zqsecret"}]}\n'
  writeFileSync(path, bytes)
  const t = setup()
  const first = (await (await t.acquire()).json()) as { epoch: string; generation: string; expiresAt: number }
  await t.request(
    '/v1/patrol/lease/complete',
    { epoch: t.epoch, generation: first.generation, outcome: 'failed' },
    undefined,
    'failed-key',
  )
  t.time(61000)
  await t.request(
    '/v1/patrol/lease/renew',
    { epoch: t.epoch, generation: first.generation },
    undefined,
    'expired-key',
  )
  await setup().request(
    '/v1/patrol/lease/complete',
    { epoch: t.epoch, generation: first.generation, outcome: 'success' },
    undefined,
    'old-key-000',
  )
  expect((await t.request('/v1/patrol/mail', { run: 'run-one', text: 'no' })).status).toBe(403)
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})
