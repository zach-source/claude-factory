import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, route, serverMode, serverUrl, tlsFor } from './client'

const ROOT = mkdtempSync(join(tmpdir(), 'client-test-'))
const tmp = (name: string) => {
  const d = join(ROOT, name)
  mkdirSync(d, { recursive: true })
  return d
}

test('n69b2 AC3 gc server routes preserve both modes and flag orders', () => {
  const rows: [string[], Record<string, unknown>][] = [
    [[], {}],
    [['--days', '7'], { days: '7' }],
    [['--dry-run'], { dryRun: true }],
    [['--days', '.5', '--dry-run'], { days: '.5', dryRun: true }],
    [['--dry-run', '--days', '+1e2'], { days: '+1e2', dryRun: true }],
    [['--worktrees'], { worktrees: true }],
    [['--worktrees', '--dry-run'], { worktrees: true, dryRun: true }],
  ]
  const flags = ['--worktrees', '--dry-run', '--rig']
  for (const a of flags)
    for (const b of flags.filter(f => f !== a)) {
      const c = flags.find(f => f !== a && f !== b)!
      rows.push([
        [a, b, c].flatMap(f => (f === '--rig' ? [f, 'acme'] : [f])),
        { worktrees: true, dryRun: true, rig: 'acme' },
      ])
    }
  for (const [args, body] of rows) expect(route('gc', args)).toEqual({ method: 'POST', path: '/v1/gc', body })
})

test('n69b2 AC2 invalid gc forms cause no HTTP request', async () => {
  const rows = [
    ['--days'],
    ['--rig'],
    ['word'],
    ['--'],
    ['--days=7'],
    ['--unknown'],
    ['--days', '7', '--days', '8'],
    ['--dry-run', '--dry-run'],
    ['--worktrees', '--worktrees'],
    ['--rig', 'acme'],
    ['--worktrees', '--days', '7'],
    ['--worktrees', '--rig', '../acme'],
    ['--worktrees', '--rig', 'acme', '--rig', 'acme'],
    ...['0', '-1', 'NaN', 'Infinity', '1e999', ' 7', '7 ', '0x7', '7days', ''].map(v => ['--days', v]),
  ]
  let requests = 0
  const fetchFn = (async () => {
    requests++
    throw new Error('unexpected HTTP request')
  }) as unknown as typeof fetch
  for (const args of rows) {
    expect(typeof route('gc', args)).toBe('string')
    expect(
      await main('gc', args, { FACTORY_SERVER: 'http://127.0.0.1:9' }, fetchFn, {
        out: () => {},
        err: () => {},
      }),
    ).toBe(1)
  }
  expect(requests).toBe(0)
})

test('n69b2 AC2 each gc caller marker refuses before HTTP, including previews', async () => {
  let requests = 0
  const fetchFn = (async () => {
    requests++
    return new Response('ok\n')
  }) as unknown as typeof fetch
  const io = { out: () => {}, err: () => {} }
  for (const marker of [
    { FACTORY_FROM: 'implement' },
    { FACTORY_RUN: 'r1' },
    { FACTORY_DEF_NAME: 'lifecycle' },
    { BEADS_ACTOR: 'factory/r1/implement' },
    { FACTORY_PATROL: '1' },
  ]) {
    for (const args of [[], ['--dry-run'], ['--worktrees', '--dry-run']])
      expect(await main('gc', args, { FACTORY_SERVER: 'http://127.0.0.1:9', ...marker }, fetchFn, io)).toBe(1)
  }
  expect(requests).toBe(0)
  expect(await main('gc', [], { FACTORY_SERVER: 'http://127.0.0.1:9' }, fetchFn, io)).toBe(0)
  expect(requests).toBe(1)
})

test('serverUrl: https, or http on loopback, an origin only', () => {
  const ok = (u: string) => expect(serverUrl({ FACTORY_SERVER: u })).toHaveProperty('url')
  const no = (u: string) => expect(serverUrl({ FACTORY_SERVER: u })).toHaveProperty('error')
  ok('https://gw.example:8444')
  ok('http://127.0.0.1:9')
  ok('http://localhost:9/')
  ok('http://[::1]:9')
  for (const u of [
    'http://gw.example:8444',
    'ftp://x',
    'https://u:p@x',
    'https://x/v1',
    'https://x/?a=1',
    'https://x/#h',
    'not a url',
  ])
    no(u)
  expect(serverUrl({})).toBeNull()
  expect(serverUrl({ FACTORY_SERVER: '' })).toBeNull()
})

test('route: the closed table', () => {
  const g = (path: string) => ({ method: 'GET', path })
  const rows: [string, string[], unknown][] = [
    ['tick', [], g('/v1/board')],
    ['show', ['r1'], g('/v1/runs/r1')],
    ['status', [], g('/v1/status')],
    ['status', ['r1'], g('/v1/status?run=r1')],
    ['prs', [], g('/v1/prs')],
    ['tick', ['--board', '--slim'], g('/v1/board?slim=1')],
    ['snapshot', ['--views', 'board,decisions'], g('/v1/snapshot?views=board,decisions')],
    ['backlog', [], g('/v1/backlog')],
    ['decisions', [], g('/v1/decisions')],
    ['decisions', ['list'], g('/v1/decisions')],
    ['plan', [], g('/v1/plan')],
    ['plan', ['show'], g('/v1/plan')],
    ['metrics', [], g('/v1/metrics')],
    [
      'metrics',
      ['--rig', 'a', '--since', '7d', '--json', '--tokens'],
      g('/v1/metrics?rig=a&since=7d&json=1&tokens=1'),
    ],
    [
      'decide',
      ['r1', 'approve', 'looks', 'good'],
      { method: 'POST', path: '/v1/runs/r1/decide', body: { outcome: 'approve', note: 'looks good' } },
    ],
    [
      'mail',
      ['r1', 'manager', '--wake', 'hi', 'there'],
      {
        method: 'POST',
        path: '/v1/runs/r1/mail',
        body: { to: 'manager', text: 'hi there', from: 'manager', cwd: process.cwd(), wake: true },
      },
    ],
    [
      'mail',
      ['r1', 'plan', 'hi'],
      {
        method: 'POST',
        path: '/v1/runs/r1/mail',
        body: { to: 'plan', text: 'hi', from: 'manager', cwd: process.cwd() },
      },
    ],
    ['goto', ['r1', 'plan'], { method: 'POST', path: '/v1/runs/r1/goto', body: { node: 'plan' } }],
    ['abort', ['r1'], { method: 'POST', path: '/v1/runs/r1/abort', body: {} }],
    ['stop', [], { method: 'POST', path: '/v1/halt', body: { mode: 'stop' } }],
    ['resume', [], { method: 'POST', path: '/v1/halt', body: { mode: 'resume' } }],
    [
      'start',
      ['lifecycle@plan', 'acme', 'do', 'it', '--owned'],
      {
        method: 'POST',
        path: '/v1/start',
        body: { factory: 'lifecycle', station: 'plan', rig: 'acme', goal: 'do it', owned: true },
      },
    ],
    [
      'decisions',
      ['answer', 'acme', 'b-1', 'yes', 'please'],
      { method: 'POST', path: '/v1/decisions/acme/b-1/answer', body: { text: 'yes please' } },
    ],
  ]
  for (const [cmd, args, want] of rows) expect(route(cmd, args)).toEqual(want as never)
})

test('route: denied forms are a string, and local commands stay local', () => {
  const denied: [string, string[]][] = [
    ['tick', ['x']],
    ['prs', ['x']],
    ['snapshot', ['--views']],
    ['snapshot', ['--views', 'a/b']],
    ['stop', ['now']],
    ['metrics', ['--bogus']],
    ['metrics', ['--rig']],
    ['show', []],
    ['decide', ['r1']],
    ['show', ['..']],
    ['show', ['.x']],
    ['show', ['a/b']],
    ['show', ['a%2fb']],
    ['show', ['a'.repeat(129)]],
    ['plan', ['facts']],
    ['plan', ['set', 'f']],
    ['decisions', ['propose', 'k', 'q', 'o']],
    ['decisions', ['answer', 'a', 'b']],
    ['mail', ['r1', 'manager']],
    ['mail', ['r1', 'manager', '--wake']],
    ['start', ['lifecycle', 'acme']],
    ['start', ['a@b@c', 'acme', 'g']],
    ['rig', ['add', 'n', 'r']],
    ['rig', ['rm', 'n']],
    ...['beads', 'loop', 'queue', 'rm', 'retry', 'poke', 'gc', 'server', 'home', 'memory'].map(
      c => [c, ['search', 'q']] as [string, string[]],
    ),
  ]
  for (const [cmd, args] of denied) expect(typeof route(cmd, args)).toBe('string')
  expect(route('beads', [])).toBe(
    'factory beads has no server mode: unset FACTORY_SERVER to run it on the local home',
  )
  for (const c of [
    undefined,
    'help',
    '--help',
    '-h',
    'check',
    'mutate',
    'ci',
    'pg-scratch',
    'devenv',
    'parity',
  ])
    expect(route(c, [])).toEqual({ local: true })
})

test('serverMode: workers stay local, the manager uses the server', () => {
  const S = { FACTORY_SERVER: 'https://x' }
  expect(serverMode(S)).toBe(true)
  expect(serverMode({})).toBe(false)
  expect(serverMode({ ...S, FACTORY_FROM: 'manager' })).toBe(true)
  expect(serverMode({ ...S, FACTORY_FROM: 'implement' })).toBe(false)
  expect(serverMode({ ...S, FACTORY_RUN: 'r1' })).toBe(false)
  expect(serverMode({ ...S, FACTORY_DEF_NAME: 'lifecycle' })).toBe(false)
  expect(serverMode({ ...S, BEADS_ACTOR: 'factory/r1/plan' })).toBe(false)
})

type Call = { url: string; init: Record<string, any> }
const fake = (status: number, body: string, calls: Call[] = []) =>
  (async (url: string, init: Record<string, any>) => {
    calls.push({ url, init })
    return new Response(body, { status })
  }) as unknown as typeof fetch
const io = () => {
  const o = { out: '', err: '' }
  return { o, io: { out: (s: string) => (o.out += s), err: (s: string) => (o.err += `${s}\n`) } }
}

test('main: headers, body, response and exit code', async () => {
  const calls: Call[] = []
  const a = io()
  const env = { FACTORY_SERVER: 'http://127.0.0.1:9' }
  expect(await main('status', [], env, fake(200, 'plain text', calls), a.io)).toBe(0)
  expect(a.o.out).toBe('plain text\n')
  expect(calls[0]!.url).toBe('http://127.0.0.1:9/v1/status')
  expect(calls[0]!.init.method).toBe('GET')
  expect(calls[0]!.init.tls).toBeUndefined()
  expect(calls[0]!.init.headers['Idempotency-Key']).toBeUndefined()

  const b = io()
  expect(await main('tick', [], env, fake(200, '{"a":1}\n'), b.io)).toBe(0)
  expect(b.o.out).toBe('{"a":1}\n')

  await main('stop', [], env, fake(200, '{}', calls), a.io)
  await main('stop', [], env, fake(200, '{}', calls), a.io)
  const [p, q] = [calls[1]!.init, calls[2]!.init]
  expect(p.method).toBe('POST')
  expect(p.headers['content-type']).toBe('application/json')
  expect(p.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  expect(p.headers['Idempotency-Key']).not.toBe(q.headers['Idempotency-Key'])
  expect(JSON.parse(p.body)).toEqual({ mode: 'stop' })

  const c = io()
  expect(await main('goto', ['r1', 'plan'], env, fake(409, 'conflict'), c.io)).toBe(1)
  expect(c.o.err).toBe('factory server: 409 conflict\n')
  const d = io()
  expect(await main('prs', [], env, fake(500, 'x'.repeat(2000)), d.io)).toBe(1)
  expect(d.o.err).toBe(`factory server: 500 ${'x'.repeat(500)}\n`)
})

test('main: FACTORY_FROM and patrol refuse what local mode refuses', async () => {
  const calls: Call[] = []
  const S = 'http://127.0.0.1:9'
  const code = async (cmd: string, args: string[], env: Record<string, string>) =>
    main(cmd, args, { FACTORY_SERVER: S, ...env }, fake(200, '{}', calls), io().io)
  const forms: [string, string[]][] = [
    ['decide', ['r1', 'approve']],
    ['start', ['lifecycle', 'rig', 'goal', '--owned']],
    ['stop', []],
    ['resume', []],
    ['goto', ['r1', 'plan']],
    ['abort', ['r1']],
    ['decisions', ['answer', 'rig', 'b1', 'yes']],
    ['tick', []],
  ]
  for (const [c, a] of forms) expect(await code(c, a, { FACTORY_FROM: 'manager' })).toBe(1)
  for (const [c, a] of forms.filter(([c]) => c === 'start' || c === 'decisions'))
    expect(await code(c, a, { FACTORY_PATROL: '1' })).toBe(1)
  expect(calls.length).toBe(0)
  for (const [c, a] of <[string, string[]][]>[
    ['mail', ['r1', 'plan', 'hi']],
    ['show', ['r1']],
    ['status', []],
    ['prs', []],
    ['backlog', []],
    ['decisions', []],
    ['plan', []],
    ['metrics', []],
  ])
    expect(await code(c, a, { FACTORY_FROM: 'manager' })).toBe(0)
  expect(calls.length).toBe(8)
})

test('main: refusals make zero requests; local commands return null', async () => {
  const calls: Call[] = []
  const f = fake(200, '{}', calls)
  const run = async (cmd: string | undefined, args: string[], env: Record<string, string>) => {
    const r = io()
    return { code: await main(cmd, args, env, f, r.io), err: r.o.err }
  }
  const S = 'http://127.0.0.1:9'
  expect((await run('status', [], {})).code).toBeNull()
  expect((await run('status', [], { FACTORY_SERVER: '' })).code).toBeNull()
  expect((await run('check', ['x'], { FACTORY_SERVER: S })).code).toBeNull()
  expect((await run('check', ['x'], { FACTORY_SERVER: 'bad url' })).code).toBeNull()
  expect((await run('status', [], { FACTORY_SERVER: 'http://gw.example' })).code).toBe(1)
  expect((await run('beads', [], { FACTORY_SERVER: S })).code).toBe(1)
  expect((await run('tick', ['x'], { FACTORY_SERVER: S })).code).toBe(1)
  for (const c of ['tick', 'stop', 'resume', 'decide']) {
    const r = await run(c, ['r1', 'approve'].slice(0, c === 'decide' ? 2 : 0), {
      FACTORY_SERVER: S,
      FACTORY_PATROL: '1',
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain('a patrol cannot run factory')
  }
  expect(calls.length).toBe(0)
})

test('main: no fallback when the server is unreachable', async () => {
  const r = io()
  const boom = (async () => {
    throw new Error('connect refused')
  }) as unknown as typeof fetch
  expect(await main('stop', [], { FACTORY_SERVER: 'http://127.0.0.1:9' }, boom, r.io)).toBe(1)
  expect(r.o.err).toBe(
    'factory server http://127.0.0.1:9 unreachable: connect refused; unset FACTORY_SERVER to work on the local home\n',
  )
})

test('tls: https reads the person certificate; a missing file names its path, never a key', async () => {
  const home = tmp('tls')
  const dir = join(home, '.config', 'factory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'person.crt'), 'CERT')
  writeFileSync(join(dir, 'person.key'), 'SECRETKEYTEXT')
  const url = new URL('https://gw.example:8444')
  expect(() => tlsFor(url, home)).toThrow(join(dir, 'ca.crt'))
  const r = io()
  const calls: Call[] = []
  const env = { FACTORY_SERVER: 'https://gw.example:8444', HOME: home }
  expect(await main('status', [], env, fake(200, '{}', calls), r.io)).toBe(1)
  expect(r.o.err).toContain(join(dir, 'ca.crt'))
  expect(r.o.err).not.toContain('SECRETKEYTEXT')
  expect(calls.length).toBe(0)

  writeFileSync(join(dir, 'ca.crt'), 'CA')
  expect(tlsFor(url, home)).toEqual({ cert: 'CERT', key: 'SECRETKEYTEXT', ca: 'CA' })
  const ok = io()
  expect(await main('status', [], env, fake(200, '{}', calls), ok.io)).toBe(0)
  expect(calls[0]!.init.tls).toEqual({ cert: 'CERT', key: 'SECRETKEYTEXT', ca: 'CA' })
  expect(tlsFor(new URL('http://127.0.0.1:9'), home)).toBeUndefined()
})

// spawn rows: the real CLI, local mode and server mode against a fake server
const CLI = join(import.meta.dir, 'cli.ts')
const hits: { method: string; path: string; body: string; key: string | null }[] = []
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      hits.push({
        method: req.method,
        path: u.pathname + u.search,
        body: await req.text(),
        key: req.headers.get('idempotency-key'),
      })
      return new Response('{"fake":true}')
    },
  })
})
afterAll(() => server.stop(true))

async function cli(args: string[], extra: Record<string, string> = {}) {
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    FACTORY_RUN,
    FACTORY_DEF_NAME,
    BEADS_ACTOR,
    FACTORY_PATROL,
    FACTORY_SERVER,
    ...base
  } = process.env
  const home = tmp(`home-${Math.random().toString(36).slice(2)}`)
  writeFileSync(join(home, 'rigs.json'), '[]')
  const p = Bun.spawn(['bun', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...base,
      FACTORY_HOME: home,
      HOME: tmp(`h-${Math.random().toString(36).slice(2)}`),
      FACTORY_SELF_UPDATE: '0',
      ...extra,
    },
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err, home }
}
const url = () => `http://127.0.0.1:${server.port}`

/** a FACTORY_HOME with text/<name>, the only place textFileArg reads from */
function textHome(name: string, text: string) {
  const home = tmp(`th-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(home, 'text'))
  writeFileSync(join(home, 'rigs.json'), '[]')
  const file = join(home, 'text', name)
  writeFileSync(file, text)
  return { home, file }
}

test('spawn: local mode makes no request (AC1, AC9)', async () => {
  hits.length = 0
  const s = await cli(['status'])
  const show = await cli(['show', 'nope'])
  const tick = await cli(['tick'])
  const decide = await cli(['decide', 'nope', 'approve'])
  const th = textHome('mail.txt', 'from file')
  const mail = await cli(['mail', 'nope', 'plan', '--text-file', th.file], { FACTORY_HOME: th.home })
  expect(s.code).toBe(0)
  expect(show.code).toBe(1)
  expect(show.err).not.toContain('factory server')
  expect(tick.code).toBe(0)
  expect(tick.out).not.toContain('"fake"')
  expect([decide.code, mail.code]).toEqual([1, 1])
  expect(decide.err + mail.err).not.toContain('factory server')
  expect(hits.length).toBe(0)
})

test('spawn: mail --text-file reads the file in server mode (AC9)', async () => {
  hits.length = 0
  const th = textHome('mail2.txt', 'long text')
  const m = await cli(['mail', 'r1', 'plan', '--text-file', th.file], {
    FACTORY_SERVER: url(),
    FACTORY_HOME: th.home,
  })
  expect(m.code).toBe(0)
  expect(JSON.parse(hits[0]!.body).text).toBe('long text')
})

test('spawn: AC7 patrol refusal for decide, resume and tick', async () => {
  hits.length = 0
  for (const a of [['decide', 'r1', 'approve'], ['resume'], ['tick'], ['start', 'f', 'r', 'g']])
    expect((await cli(a, { FACTORY_SERVER: url(), FACTORY_PATROL: '1' })).code).toBe(1)
  expect(hits.length).toBe(0)
})

test('spawn: server mode sends the table request and prints the body (AC9)', async () => {
  hits.length = 0
  const status = await cli(['status'], { FACTORY_SERVER: url() })
  expect(status.out).toBe('{"fake":true}\n')
  const tick = await cli(['tick'], { FACTORY_SERVER: url() })
  const asManager = await cli(['status'], { FACTORY_SERVER: url(), FACTORY_FROM: 'manager' })
  const decide = await cli(['decide', 'r1', 'approve', 'ok'], { FACTORY_SERVER: url() })
  expect([status.code, tick.code, asManager.code, decide.code]).toEqual([0, 0, 0, 0])
  expect(hits.map(h => `${h.method} ${h.path}`)).toEqual([
    'GET /v1/status',
    'GET /v1/board',
    'GET /v1/status',
    'POST /v1/runs/r1/decide',
  ])
  expect(JSON.parse(hits[3]!.body)).toEqual({ outcome: 'approve', note: 'ok' })
  expect(hits[3]!.key).toBeTruthy()
})

test('spawn: mail text goes through; a worker marker keeps the local path (AC8)', async () => {
  hits.length = 0
  const m = await cli(['mail', 'r1', 'manager', 'hello'], { FACTORY_SERVER: url() })
  expect(m.code).toBe(0)
  expect(JSON.parse(hits[0]!.body)).toEqual({
    to: 'manager',
    text: 'hello',
    from: 'manager',
    cwd: process.cwd(),
  })
  hits.length = 0
  for (const extra of <Record<string, string>[]>[
    { FACTORY_FROM: 'implement' },
    { FACTORY_RUN: 'r1' },
    { FACTORY_DEF_NAME: 'lifecycle' },
    { BEADS_ACTOR: 'factory/r1/plan' },
  ])
    await cli(['status'], { FACTORY_SERVER: url(), ...extra })
  expect(hits.length).toBe(0)
})

test('spawn: patrol refusal and no fallback leave the home untouched (AC5, AC7)', async () => {
  hits.length = 0
  const p = await cli(['stop'], { FACTORY_SERVER: url(), FACTORY_PATROL: '1' })
  expect(p.code).toBe(1)
  expect(hits.length).toBe(0)
  const dead = await cli(['stop'], { FACTORY_SERVER: 'http://127.0.0.1:9' })
  expect(dead.code).toBe(1)
  expect(dead.err).toContain('unreachable')
  const d2 = await cli(['decide', 'r1', 'approve'], { FACTORY_SERVER: 'http://127.0.0.1:9' })
  expect(d2.code).toBe(1)
  expect(existsSync(join(dead.home, 'halt.json'))).toBe(false)
  expect(readdirSync(dead.home)).toEqual(['rigs.json'])
  expect(readdirSync(d2.home)).toEqual(['rigs.json'])
})

test('spawn: a redirect is refused and the target gets no request', async () => {
  const third: string[] = []
  const target = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      third.push(req.url)
      return new Response('leak')
    },
  })
  const redirector = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/leak` } }),
  })
  try {
    const d = await cli(['decide', 'r1', 'approve', 'note'], {
      FACTORY_SERVER: `http://127.0.0.1:${redirector.port}`,
    })
    expect(d.code).toBe(1)
    expect(third.length).toBe(0)
  } finally {
    redirector.stop(true)
    target.stop(true)
  }
})
