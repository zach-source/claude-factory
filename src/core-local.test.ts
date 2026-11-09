import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Op } from './core/catalog'
import { leaseFile, readLease, type Lease } from './lease'
import type { RunResult } from './server-api'
import { CoreRefusal, dueSteps, parseCoreFlags, startCore, type CoreOpts } from './server'

const tmp = () => mkdtempSync(join(tmpdir(), 'core-'))
const TOKEN = 'cd'.repeat(32)
type Core = ReturnType<typeof startCore>
const open: Core[] = []
afterEach(async () => {
  for (const c of open.splice(0)) await c.stop()
})

type Counters = { tick: number; run: number; step: number; lease: number }
const make = (over: Partial<CoreOpts> = {}, home = tmp()) => {
  const n: Counters = { tick: 0, run: 0, step: 0, lease: 0 }
  const o: CoreOpts = {
    home,
    everyMs: 100,
    tick: async () => {
      n.tick++
      return { runs: [{ id: 'r1', node: 'a' }] }
    },
    lease: () => {
      n.lease++
      return undefined
    },
    runner: async () => {
      n.run++
      return { code: 0, out: '{"ok":1}\n', err: '' }
    },
    step: async () => {
      n.step++
      return { code: 0, out: '', err: '' }
    },
    steps: [],
    log: () => {},
    ...over,
  }
  const core = startCore(o)
  open.push(core)
  return { core, n, home, o }
}
type Res = Omit<Response, 'json'> & { json: () => Promise<any> }
type Init = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
const req = (core: Core, path: string, init: Init = {}) =>
  core.handle(
    new Request(`http://127.0.0.1:${core.port}${path}`, {
      ...init,
      headers: { host: `127.0.0.1:${core.port}`, ...init.headers },
    }),
  ) as Promise<Res>
const authed = (core: Core, home: string, path: string, init: Init = {}) =>
  req(core, path, {
    ...init,
    headers: { authorization: `Bearer ${readFileSync(join(home, 'core.token'), 'utf8')}`, ...init.headers },
  })
const until = async (f: () => boolean, ms = 5000) => {
  const t0 = Date.now()
  while (!f() && Date.now() - t0 < ms) await Bun.sleep(10)
  expect(f()).toBe(true)
}

describe('parseCoreFlags', () => {
  test('good forms', () => {
    expect(parseCoreFlags([])).toEqual({})
    expect(parseCoreFlags(['--port', '0'])).toEqual({ port: 0 })
    expect(parseCoreFlags(['--home', 'd', 'status'])).toEqual({ home: 'd', sub: 'status' })
    expect(parseCoreFlags(['stop', '--home', 'd'])).toEqual({ home: 'd', sub: 'stop' })
  })
  const bad: string[][] = [
    ['--bogus'],
    ['--port', 'x'],
    ['--port', '70000'],
    ['--port', '1', '--port', '2'],
    ['--home', 'a', '--home', 'b'],
    ['--port'],
    ['--home', '--port', '1'],
    ['status', 'extra'],
    ['status', 'stop'],
    ['status', '--port', '1'],
  ]
  for (const a of bad) test(`refuses ${a.join(' ')}`, () => expect(() => parseCoreFlags(a)).toThrow('usage:'))
})

describe('dueSteps', () => {
  const S = [
    { name: 'patrol', everyMs: 60_000 },
    { name: 'brief', everyMs: 120_000 },
  ]
  test('rows', () => {
    expect(dueSteps(0, S, {}, new Set(), false)).toEqual(['patrol', 'brief'])
    expect(dueSteps(60_000, S, { patrol: 0, brief: 0 }, new Set(), false)).toEqual(['patrol'])
    expect(dueSteps(59_999, S, { patrol: 0, brief: 0 }, new Set(), false)).toEqual([])
    expect(dueSteps(500_000, S, { patrol: 0, brief: 0 }, new Set(['patrol']), false)).toEqual(['brief'])
    expect(dueSteps(0, S, {}, new Set(), true)).toEqual([])
  })
})

describe('token file', () => {
  test('a new token is 64 hex, mode 0600, kept on restart', async () => {
    const { core, home } = make()
    const f = join(home, 'core.token')
    expect(readFileSync(f, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    expect((await Bun.file(f).stat()).mode & 0o777).toBe(0o600)
    const t = readFileSync(f, 'utf8')
    await core.stop()
    open.pop()
    make({}, home)
    expect(readFileSync(f, 'utf8')).toBe(t)
  })
  const refuses: [string, (f: string, home: string) => void][] = [
    ['mode 0644', f => (writeFileSync(f, TOKEN), chmodSync(f, 0o644))],
    [
      'a symlink to a good token',
      (f, home) => {
        const real = join(home, 'real')
        writeFileSync(real, TOKEN, { mode: 0o600 })
        symlinkSync(real, f)
      },
    ],
    ['content abc', f => writeFileSync(f, 'abc', { mode: 0o600 })],
    ['an empty file', f => writeFileSync(f, '', { mode: 0o600 })],
  ]
  for (const [name, mk] of refuses)
    test(`refuses ${name}: no lease, no port`, () => {
      const home = tmp()
      mk(join(home, 'core.token'), home)
      const n = { lease: 0 }
      expect(() =>
        make(
          {
            lease: () => {
              n.lease++
              return undefined
            },
          },
          home,
        ),
      ).toThrow(CoreRefusal)
      expect(n.lease).toBe(0)
      expect(existsSync(join(home, 'core.json'))).toBe(false)
      try {
        make({}, home)
      } catch (e) {
        expect((e as Error).message).toContain(join(home, 'core.token'))
        expect((e as Error).message).toContain('remove the file')
      }
    })
  test('a good token with a trailing newline starts', () => {
    const home = tmp()
    writeFileSync(join(home, 'core.token'), `${TOKEN}\n`, { mode: 0o600 })
    make({}, home)
  })
})

describe('start, lease and core.json', () => {
  test('core.json holds port, pid, holder; the stop form drops pid and holder', async () => {
    const { core, home } = make()
    const j = JSON.parse(readFileSync(join(home, 'core.json'), 'utf8'))
    expect(j).toMatchObject({
      port: core.port,
      pid: process.pid,
      holder: `core:${process.pid}`,
      catalogVersion: 1,
    })
    await core.stop()
    open.pop()
    const s = JSON.parse(readFileSync(join(home, 'core.json'), 'utf8'))
    expect(s.pid).toBeUndefined()
    expect(s.holder).toBeUndefined()
    expect(s.port).toBe(core.port)
    expect(typeof s.stoppedAt).toBe('string')
  })
  test('the next start reuses the port of core.json', async () => {
    const { core, home } = make()
    const port = core.port
    await core.stop()
    open.pop()
    expect(make({}, home).core.port).toBe(port)
  })
  test('a busy core.json port falls back to a free port; a busy --port refuses and releases the lease', () => {
    const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    try {
      const home = tmp()
      writeFileSync(join(home, 'core.json'), JSON.stringify({ port: blocker.port }))
      const { core } = make({ port: undefined }, home)
      expect(core.port).not.toBe(blocker.port)
      const home2 = tmp()
      expect(() => make({ port: blocker.port }, home2)).toThrow('cannot listen')
      expect(existsSync(join(home2, 'core.json'))).toBe(false)
    } finally {
      void blocker.stop(true)
    }
  })
  test('a live lease of another holder refuses and names it', () => {
    const l: Lease = { holder: 'pane:p9', kind: 'claude', at: Date.now() }
    expect(() => make({ lease: () => l })).toThrow('pane:p9')
  })
  test('a busy lock (holder unknown) is retried 10 times, then refused', () => {
    let calls = 0
    const t0 = Date.now()
    expect(() =>
      make({
        lease: () => {
          calls++
          return { holder: 'unknown' } as Lease
        },
      }),
    ).toThrow(CoreRefusal)
    expect(calls).toBe(10)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1700)
  })
  test('the tick interval must be an integer from 100 to 5000', () => {
    for (const ms of [99, 5001, NaN, 1.5]) expect(() => make({ everyMs: ms })).toThrow('FACTORY_CORE_TICK_MS')
  })
  test('home is made with mode 0700', () => {
    const home = join(tmp(), 'a', 'b')
    make({}, home)
    expect(statSync(home).mode & 0o777).toBe(0o700)
  })
})

describe('request guard', () => {
  const hosts = (port: number) => [
    `evil.example:${port}`,
    `127.0.0.1:${port + 1}`,
    '127.0.0.1',
    `127.0.0.1.evil.example:${port}`,
  ]
  test('bad host gives 403 before the token is looked at', async () => {
    const { core, home, n } = make()
    for (const h of hosts(core.port)) {
      const r = await core.handle(
        new Request(`http://127.0.0.1:${core.port}/v1/core`, {
          headers: { host: h, authorization: `Bearer ${readFileSync(join(home, 'core.token'), 'utf8')}` },
        }),
      )
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ refused: 'bad host' })
    }
    const none = await core.handle(new Request(`http://127.0.0.1:${core.port}/v1/core`))
    expect(none.status).toBe(403)
    expect(n.run).toBe(0)
  })
  test('localhost:<port> is a good host', async () => {
    const { core, home } = make()
    const r = await core.handle(
      new Request(`http://localhost:${core.port}/v1/core`, {
        headers: {
          host: `localhost:${core.port}`,
          authorization: `Bearer ${readFileSync(join(home, 'core.token'), 'utf8')}`,
        },
      }),
    )
    expect(r.status).toBe(200)
  })
  test('token rows give 401', async () => {
    const { core, home, n } = make()
    const t = readFileSync(join(home, 'core.token'), 'utf8')
    const rows: (string | null)[] = [
      null,
      'Bearer ' + 'ab'.repeat(32),
      `Bearer ${t}x`,
      `bearer ${t}`,
      `Basic ${t}`,
      t,
      `Bearer ${t}, Bearer ${t}`,
      '',
    ]
    for (const a of rows) {
      const r = await req(core, '/v1/core', a === null ? {} : { headers: { authorization: a } })
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toBe('Bearer')
      const body = await r.text()
      expect(body).not.toContain(t)
    }
    expect(n.run).toBe(0)
  })
  test('every response has no-store and nosniff', async () => {
    const { core, home } = make()
    for (const r of [
      await req(core, '/v1/core'),
      await core.handle(new Request('http://x/v1/core')),
      await authed(core, home, '/v1/core'),
      await authed(core, home, '/v1/nope'),
    ]) {
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })
  test('browser rule for a change', async () => {
    const { core, home } = make()
    const post = (headers: Record<string, string>) =>
      authed(core, home, '/v1/runs/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'abcdefgh1', ...headers },
        body: '{}',
      })
    const own = `http://127.0.0.1:${core.port}`
    const intent = { 'x-factory-intent': 'operator-ui-v1' }
    expect((await post({ origin: 'http://evil.example', ...intent })).status).toBe(403)
    expect((await post({ origin: own })).status).toBe(403)
    expect((await post({ origin: own, ...intent, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ ...intent, 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await post({ origin: own, ...intent })).status).not.toBe(403)
    expect((await post({ origin: own, ...intent, 'sec-fetch-site': 'same-origin' })).status).not.toBe(403)
    expect((await post({})).status).not.toBe(403) // the CLI: no origin, no sec-fetch-site
    const read = await authed(core, home, '/v1/core', { headers: { origin: 'http://evil.example' } })
    expect(read.status).toBe(200)
  })
  test('a real socket gives 401 and 403', async () => {
    const { core } = make()
    // ponytail: the fetch handler is the unit; this row proves the listener is wired to it
    const bad = await fetch(`http://127.0.0.1:${core.port}/v1/core`)
    expect(bad.status).toBe(401)
    const host = await fetch(`http://localhost:${core.port}/v1/core`, { headers: { host: 'evil.example' } })
    expect(host.status).toBe(403)
  })
})

describe('routes', () => {
  test('GET /v1/core', async () => {
    const { core, home } = make({ steps: [{ name: 'patrol', everyMs: 60_000, argv: ['patrol'] }] })
    const r = await (await authed(core, home, '/v1/core')).json()
    expect(r).toMatchObject({
      state: 'ticking',
      holder: `core:${process.pid}`,
      pid: process.pid,
      port: core.port,
      catalogVersion: 1,
    })
    expect(Object.keys(r).sort()).toEqual(
      [
        'catalogVersion',
        'eventSeq',
        'holder',
        'lastTickAt',
        'lastTickOk',
        'pid',
        'port',
        'startedAt',
        'state',
        'steps',
        'ticks',
      ].sort(),
    )
    expect(r.steps.patrol).toBeDefined()
  })
  test('catalog routes go to clientHandler; the token is not passed on', async () => {
    const { core, home } = make()
    const c = await (await authed(core, home, '/v1/catalog')).json()
    expect(c.data.version).toBe(1)
    const e = await authed(core, home, '/v1/catalog/echo?text=hi')
    expect(e.status).toBe(200)
    expect(await e.text()).toContain('hi')
  })
  test('board: 503 before the first tick, the tick JSON after', async () => {
    let go!: () => void
    const gate = new Promise<void>(r => (go = r))
    const { core, home } = make({
      tick: async () => {
        await gate
        return { runs: [{ id: 'r1', node: 'a' }] }
      },
    })
    expect((await authed(core, home, '/v1/board')).status).toBe(503)
    go()
    let r: Response
    for (let i = 0; i < 100; i++) {
      r = await authed(core, home, '/v1/board')
      if (r.status === 200) break
      await Bun.sleep(20)
    }
    expect(r!.status).toBe(200)
    expect(await r!.text()).toContain('"r1"')
  })
  test('GET /v1/commands/:id: 404 for a bad or unknown id', async () => {
    const { core, home } = make()
    for (const id of ['nope', '0'.repeat(36), '..%2f..']) {
      const r = await authed(core, home, `/v1/commands/${id}`)
      expect(r.status).toBe(404)
      expect(await r.json()).toEqual({ refused: 'no such command' })
    }
  })
})

describe('tick loop', () => {
  test('ticks repeat; a throw is logged and the loop goes on; a busy tick keeps the board', async () => {
    const logs: string[] = []
    let i = 0
    const { core, home } = make({
      log: l => logs.push(l),
      tick: async () => {
        i++
        if (i === 2) throw new Error('boom\nsecond line')
        if (i === 3) return { busy: true }
        return { runs: [{ id: 'r1', i }] }
      },
    })
    await until(() => i >= 5)
    expect(logs).toContain('tick failed: boom')
    const b = await (await authed(core, home, '/v1/board')).json()
    expect(b.runs[0].i).not.toBe(3)
    const st = await (await authed(core, home, '/v1/core')).json()
    expect(st.ticks).toBeGreaterThanOrEqual(4)
  })
  test('the next tick starts after the last one ends', async () => {
    let active = 0
    let max = 0
    make({
      tick: async () => {
        max = Math.max(max, ++active)
        await Bun.sleep(250)
        active--
        return {}
      },
    })
    await Bun.sleep(900)
    expect(max).toBe(1)
  })
  test('the lease renews on its own interval, also while a tick runs', async () => {
    const { n } = make({ tick: () => Bun.sleep(1500).then(() => ({})) })
    await until(() => n.lease >= 4)
  })
})

describe('lease lost and busy', () => {
  test('a live lease of another holder at a renew stops the core, keeps the lease and gives code 1', async () => {
    let lost = false
    const logs: string[] = []
    const home = tmp()
    const { core } = make(
      {
        log: l => logs.push(l),
        lease: () => (lost ? { holder: 'pane:p9', kind: 'claude', at: Date.now() } : undefined),
      },
      home,
    )
    writeFileSync(
      leaseFile(home),
      JSON.stringify({ holder: `core:${process.pid}`, kind: 'core', at: Date.now() }),
    )
    lost = true
    expect(await core.done).toBe(1)
    expect(logs.some(l => l.startsWith('lease lost: pane:p9'))).toBe(true)
    expect(readLease(home)).toBeDefined()
  })
  test('a busy renew (unknown or own holder) is skipped', async () => {
    let mode = 0
    const { core, n } = make({
      lease: () =>
        mode === 0
          ? undefined
          : mode === 1
            ? ({ holder: 'unknown' } as Lease)
            : { holder: `core:${process.pid}`, kind: 'core', at: Date.now() },
    })
    mode = 1
    await Bun.sleep(350)
    mode = 2
    await Bun.sleep(350)
    expect(n.tick).toBeGreaterThan(0)
    await core.stop()
    open.pop()
  })
  test('stop releases the lease only when it is the own holder', async () => {
    const home = tmp()
    const { core } = make({}, home)
    writeFileSync(leaseFile(home), JSON.stringify({ holder: 'pane:p9', kind: 'claude', at: Date.now() }))
    await core.stop()
    open.pop()
    expect(readLease(home)?.holder).toBe('pane:p9')
    const home2 = tmp()
    const c2 = make({}, home2)
    writeFileSync(leaseFile(home2), JSON.stringify({ holder: c2.core.holder, kind: 'core', at: Date.now() }))
    await c2.core.stop()
    open.pop()
    expect(existsSync(leaseFile(home2))).toBe(false)
  })
})

describe('steps', () => {
  test('a due step runs, logs, emits step:<name>; a halted board runs none', async () => {
    const logs: string[] = []
    const seen: string[][] = []
    let halt = false
    const { core, home } = make({
      log: l => logs.push(l),
      steps: [
        { name: 'patrol', everyMs: 60_000, argv: ['patrol', '--once'] },
        { name: 'decisions', everyMs: 60_000, argv: ['decisions'] },
      ],
      tick: async () => ({ runs: [], halt }),
      step: async argv => {
        seen.push(argv)
        return { code: 0, out: 'same', err: '' }
      },
    })
    await until(() => seen.length === 2)
    await until(() => logs.filter(l => l.startsWith('step ')).length === 2)
    expect(logs.some(l => /^step patrol exit 0 in \d+s$/.test(l))).toBe(true)
    const ev = await authed(core, home, `/v1/events?after=${'00000000'}-0`)
    expect(ev.status).toBe(409) // another epoch
    halt = true
    await Bun.sleep(300)
    expect(seen.length).toBe(2)
  })
  test('stop aborts a running step with the signal and waits for it', async () => {
    let aborted = false
    let started = false
    const { core } = make({
      steps: [{ name: 'patrol', everyMs: 60_000, argv: ['patrol'] }],
      step: (_a, sig) =>
        new Promise(r => {
          started = true
          sig.addEventListener('abort', () => {
            aborted = true
            setTimeout(() => r({ code: 143, out: '', err: '' }), 50)
          })
        }),
    })
    await until(() => started)
    await core.stop()
    open.pop()
    expect(aborted).toBe(true)
    expect(await core.done).toBe(0)
  })
  test('a refused request makes no runner, tick or step call', async () => {
    const { core, n } = make({ tick: async () => ({}) })
    await Bun.sleep(150)
    const before = { ...n }
    await core.handle(new Request('http://evil.example/v1/status', { headers: { host: 'evil.example' } }))
    await req(core, '/v1/status')
    expect(n.run).toBe(before.run)
    expect(n.step).toBe(before.step)
  })
})

describe('events', () => {
  const frames = async (res: Response, enough: (t: string) => boolean) => {
    const rd = res.body!.getReader()
    let t = ''
    const dec = new TextDecoder()
    const t0 = Date.now()
    while (!enough(t) && Date.now() - t0 < 5000) {
      const c = await rd.read()
      if (c.done) break
      t += dec.decode(c.value)
    }
    await rd.cancel()
    return t
  }
  test('run:<id> and board events for a new, a changed and a gone row; none for a same row', async () => {
    let step = 0
    const rows = [[{ id: 'r1', node: 'a' }], [{ id: 'r1', node: 'a' }], [{ id: 'r1', node: 'b' }], []]
    const { core, home } = make({
      tick: async () => ({ runs: rows[Math.min(step++, 3)] }),
    })
    await until(() => step >= 6)
    const epoch = (await (await authed(core, home, '/v1/events?after=zz')).json()).refused
    expect(epoch).toBe('bad cursor')
    const cur = (await authed(core, home, '/v1/core')).json()
    const seq = (await cur).eventSeq as number
    expect(seq).toBe(6) // run new + board, run changed + board, run gone + board
    const stale = await authed(core, home, '/v1/events?after=00000000-0')
    expect(stale.status).toBe(409)
  })
  test('over a real socket new events come as SSE frames', async () => {
    let step = 0
    const { core, home } = make({
      tick: async () => ({ runs: [{ id: 'r1', node: String(step++) }] }),
    })
    await until(() => step >= 4)
    const headers = { authorization: `Bearer ${readFileSync(join(home, 'core.token'), 'utf8')}` }
    const base = `http://127.0.0.1:${core.port}`
    const { eventSeq } = (await (await fetch(`${base}/v1/core`, { headers })).json()) as { eventSeq: number }
    expect(eventSeq).toBeGreaterThanOrEqual(3)
    const first = await authed(core, home, '/v1/events?after=zzzzzzzz-0')
    expect(first.status).toBe(400)
    const res = await fetch(`${base}/v1/events`, { headers })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const txt = await frames(res, t => t.includes('event: change'))
    expect(txt).toMatch(
      /^id: [0-9a-f]{8}-\d+\nevent: change\ndata: \{"seq":\d+,"resource":"[^"]+","revision":\d+\}\n\n/,
    )
  })
  test('stop closes open streams', async () => {
    const { core, home } = make()
    const res = await authed(core, home, '/v1/events')
    const rd = res.body!.getReader()
    const p = rd.read()
    await core.stop()
    open.pop()
    let guard = 0
    let r = await p
    while (!r.done && guard++ < 100) r = await rd.read()
    expect(r.done).toBe(true)
  })
})

describe('long operations', () => {
  const fixture = (wait: Promise<RunResult>): Op => ({
    name: 'fixture.wait',
    summary: 'fixture',
    inputs: [],
    output: 'json',
    rights: 'owner',
    mutates: true,
    long: true,
    route: { method: 'POST', path: '/v1/fixture/wait' },
    since: 1,
    run: () => wait,
  })
  const post = (core: Core, home: string, key: string) =>
    authed(core, home, '/v1/fixture/wait', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: '{}',
    })
  test('202 and a command id; GET shows running, then done; the same key gives the same id', async () => {
    let go!: (r: RunResult) => void
    const wait = new Promise<RunResult>(r => (go = r))
    const { core, home } = make({ ops: [fixture(wait)] })
    const a = await post(core, home, 'key-aaaaaaa1')
    expect(a.status).toBe(202)
    const { commandId, status } = await a.json()
    expect(status).toBe('accepted')
    const g1 = await (await authed(core, home, `/v1/commands/${commandId}`)).json()
    expect(g1.status).toBe('running')
    go({ code: 0, out: '{"x":1}', err: '' })
    let g2: { status: string; result: { status: number } }
    for (let i = 0; i < 100; i++) {
      g2 = await (await authed(core, home, `/v1/commands/${commandId}`)).json()
      if (g2.status === 'done') break
      await Bun.sleep(20)
    }
    expect(g2!.status).toBe('done')
    expect(g2!.result.status).toBe(200)
    const again = await post(core, home, 'key-aaaaaaa1')
    expect(again.status).toBe(202)
    expect((await again.json()).commandId).toBe(commandId)
  })
  test('a run that answers 422 gives failed', async () => {
    const { core, home } = make({ ops: [fixture(Promise.resolve({ code: 1, out: '', err: 'no' }))] })
    const { commandId } = await (await post(core, home, 'key-bbbbbbb1')).json()
    let g: { status: string }
    for (let i = 0; i < 100; i++) {
      g = await (await authed(core, home, `/v1/commands/${commandId}`)).json()
      if (g.status !== 'running') break
      await Bun.sleep(20)
    }
    expect(g!.status).toBe('failed')
  })
})
