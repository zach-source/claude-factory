import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main as clientMain } from './client'
import type { Port } from './core/catalog'
import { parseFlags, serve } from './server'
import { sign } from './tokens'
import { clientHandler, personCerts, type RunResult } from './server-api'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sapi-t-'))
  dirs.push(d)
  return d
}
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const A = join(mkdtempSync(join(tmpdir(), 'sapi-ca-')), 'a')
const B = join(mkdtempSync(join(tmpdir(), 'sapi-cb-')), 'b')
personCerts(A, 'localhost')
personCerts(B, 'localhost')
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8')

/** a laptop HOME with the files that src/client.ts reads: `who` makes the client cert, `pin` makes ca.crt */
const laptop = (who: string, pin: string) => {
  const home = tmp()
  const d = join(home, '.config', 'factory')
  mkdirSync(d, { recursive: true })
  cpSync(join(who, 'person.crt'), join(d, 'person.crt'))
  cpSync(join(who, 'person.key'), join(d, 'person.key'))
  cpSync(join(pin, 'ca.crt'), join(d, 'ca.crt'))
  return home
}

const start = (tick: () => unknown = () => ({ runs: ['r1'] }), idleMs?: number, delayMs = 0) => {
  const calls: string[][] = []
  const run = async (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    if (delayMs) await Bun.sleep(delayMs)
    return { code: 0, out: '{"ok":1}\n', err: '', ...({} as object) }
  }
  // the moved reads run in process: status and prs answer here, the other port functions must not run
  const port = new Proxy(
    {
      status: async (_id: unknown, print: (l: string) => void) => {
        calls.push(['status'])
        if (delayMs) await Bun.sleep(delayMs)
        print('{"ok":1}')
      },
      prs: async () => {
        calls.push(['prs'])
        if (delayMs) await Bun.sleep(delayMs)
        return { ok: 1 }
      },
    },
    {
      get: (t, k) =>
        (t as Record<string, unknown>)[k as string] ??
        (() => {
          throw new Error(`port.${String(k)} must not be called`)
        }),
    },
  ) as unknown as Port
  const home = tmp()
  let s: ReturnType<typeof serve>
  const handle = clientHandler({ home, run, port, board: () => s.board() })
  const onBoard = handle.publish
  s = serve({
    home,
    port: 0,
    everyMs: 50,
    leaseMs: 1000,
    tick,
    onBoard,
    log: () => {},
    client: {
      port: 0,
      cert: read(A, 'server.crt'),
      key: read(A, 'server.key'),
      ca: read(A, 'ca.crt'),
      handle,
      idleMs,
    },
  })
  stops.push(() => s.stop())
  return { s, calls, url: `https://localhost:${s.clientPort}` }
}

// Bun pools connections by host: a fresh connection each call keeps one test from riding on the last test's session.
const fresh = ((u: string, init: RequestInit) => fetch(u, { ...init, keepalive: false })) as typeof fetch
const cli = async (url: string, home: string, cmd: string, args: string[] = []) => {
  const out: string[] = []
  const err: string[] = []
  const code = await clientMain(cmd, args, { FACTORY_SERVER: url, HOME: home }, fresh, {
    out: s => out.push(s),
    err: s => err.push(s),
  })
  return { code, out: out.join(''), err: err.join('') }
}

/**
 * One HTTPS request from `openssl s_client`: the status code, or 'none' when the server gave no answer.
 * Bun's own TLS client is not a safe test client. In one process it can send a certificate other than the one named,
 * so a stranger row passes or fails by chance. An openssl child process has no such state.
 */
const raw = async (port: number, who?: { cert: string; key: string }, headers = '') => {
  const p = Bun.spawn(
    [
      ...['openssl', 's_client', '-connect', `localhost:${port}`, '-servername', 'localhost'],
      ...['-CAfile', join(A, 'ca.crt'), '-quiet', '-tls1_3'],
      ...(who ? ['-cert', who.cert, '-key', who.key] : []),
    ],
    {
      stdin: new Blob([`GET /v1/status HTTP/1.1\r\nHost: localhost\r\n${headers}Connection: close\r\n\r\n`]),
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5000,
    },
  )
  const out = await new Response(p.stdout).text()
  return out.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 'none'
}
const pair = (dir: string, name = 'person') => ({
  cert: join(dir, `${name}.crt`),
  key: join(dir, `${name}.key`),
})

describe('mTLS on the client port', () => {
  test('a person cert reaches the handler through client.main', async () => {
    const t = start()
    const r = await cli(t.url, laptop(A, A), 'status')
    expect(r).toMatchObject({ code: 0, out: '{"ok":1}\n' })
    expect(t.calls).toEqual([['status']])
  })
  test('control: a person cert over openssl gets 200', async () => {
    const t = start()
    expect(await raw(t.s.clientPort!, pair(A))).toBe('200')
    expect(t.calls.length).toBe(1)
  })
  test('a stranger cert from a second CA gets no answer', async () => {
    const t = start()
    expect(await raw(t.s.clientPort!, pair(B))).toBe('none')
    expect(t.calls.length).toBe(0)
  })
  test('no client cert gets no answer', async () => {
    const t = start()
    expect(await raw(t.s.clientPort!)).toBe('none')
    expect(t.calls.length).toBe(0)
  })
  test('the server cert is not a client cert (serverAuth only)', async () => {
    const t = start()
    expect(await raw(t.s.clientPort!, pair(A, 'server'))).toBe('none')
    expect(t.calls.length).toBe(0)
  })
  test('a worker token with a person cert gets 403 and no call', async () => {
    const t = start()
    expect(await raw(t.s.clientPort!, pair(A), 'Authorization: Bearer v1.a.b\r\n')).toBe('403')
    expect(t.calls.length).toBe(0)
  })
  test('a slow handler outlives the idle limit and still answers', async () => {
    const t = start(undefined, 200, 800)
    expect(await raw(t.s.clientPort!, pair(A))).toBe('200')
  })
  test('a real signed worker token with a person cert gets 403 and no call', async () => {
    const t = start()
    const now = Date.now()
    const token = sign(
      tmp(),
      Buffer.alloc(32, 7),
      { task: 't', run: 'r', node: 'n', seq: 1, exp: now + 3600_000 },
      now,
    )
    expect(await raw(t.s.clientPort!, pair(A), `Authorization: Bearer ${token}\r\n`)).toBe('403')
    expect(t.calls.length).toBe(0)
  })
  test('tick answers the last tick result and runs nothing', async () => {
    const t = start()
    await Bun.sleep(300)
    const r = await cli(t.url, laptop(A, A), 'tick')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ runs: ['r1'] })
    expect(t.calls.length).toBe(0)
  })
  test('decide is not served on the health listener (FR-009)', async () => {
    const t = start()
    const res = await fetch(`http://127.0.0.1:${t.s.port}/v1/runs/r1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'once-only-key' },
      body: JSON.stringify({ outcome: 'approve', note: '' }),
    })
    expect(res.status).toBe(404)
    expect(t.calls.length).toBe(0)
  })
})

describe('stranger certificates never reach the handler', () => {
  // Bun.serve with rejectUnauthorized ran the handler for 4 to 8 percent of immediate requests.
  test('30 immediate requests from the second CA make 0 calls', async () => {
    const t = start()
    const answers = await Promise.all(Array.from({ length: 30 }, () => raw(t.s.clientPort!, pair(B))))
    expect(answers.filter(a => a !== 'none')).toEqual([])
    expect(t.calls.length).toBe(0)
  })
  test('30 immediate requests with the server cert make 0 calls', async () => {
    const t = start()
    const answers = await Promise.all(
      Array.from({ length: 30 }, () => raw(t.s.clientPort!, pair(A, 'server'))),
    )
    expect(answers.filter(a => a !== 'none')).toEqual([])
    expect(t.calls.length).toBe(0)
  })
})

const send = async (port: number, text: string) => {
  const start = performance.now()
  const p = Bun.spawn(
    [
      ...['openssl', 's_client', '-connect', `localhost:${port}`, '-servername', 'localhost'],
      ...['-CAfile', join(A, 'ca.crt'), '-quiet', '-tls1_3', '-cert', join(A, 'person.crt')],
      ...['-key', join(A, 'person.key')],
    ],
    { stdin: new Blob([text]), stdout: 'pipe', stderr: 'ignore', timeout: 5000 },
  )
  const out = await new Response(p.stdout).text()
  await p.exited
  return {
    status: out.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 'none',
    body: out.split('\r\n\r\n').slice(1).join('\r\n\r\n'),
    ms: performance.now() - start,
  }
}
describe('request grammar of the client listener', () => {
  const rows: [string, string, string][] = [
    ['chunked body', 'GET /v1/prs HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', '400'],
    ['Expect header', 'GET /v1/prs HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\n\r\n', '400'],
    [
      'repeated content-length',
      'POST /v1/halt HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
      '400',
    ],
    ['repeated header', 'GET /v1/prs HTTP/1.1\r\nX-A: 1\r\nX-A: 1\r\n\r\n', '400'],
    ['bad content-length', 'POST /v1/halt HTTP/1.1\r\nContent-Length: -1\r\n\r\n', '400'],
    ['body over 256 KiB', 'POST /v1/halt HTTP/1.1\r\nContent-Length: 300000\r\n\r\n', '400'],
    ['HTTP/1.0', 'GET /v1/prs HTTP/1.0\r\n\r\n', '400'],
    ['no leading slash', 'GET v1/prs HTTP/1.1\r\n\r\n', '400'],
    ['lowercase method', 'get /v1/prs HTTP/1.1\r\n\r\n', '400'],
    ['bad header line', 'GET /v1/prs HTTP/1.1\r\nbad header\r\n\r\n', '400'],
    ['head over 16 KiB', `GET /v1/prs HTTP/1.1\r\nX-A: ${'a'.repeat(20000)}\r\n\r\n`, '431 or none'],
  ]
  for (const [name, text, want] of rows)
    test(`${name} gives ${want} and no call`, async () => {
      const t = start()
      expect(want.split(' or ')).toContain((await send(t.s.clientPort!, text)).status)
      expect(t.calls.length).toBe(0)
    })
  test('a valid GET and a valid POST are served', async () => {
    const t = start()
    expect((await send(t.s.clientPort!, 'GET /v1/prs HTTP/1.1\r\nHost: x\r\n\r\n')).status).toBe('200')
    const body = '{"mode":"stop"}'
    const post = `POST /v1/halt HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\nidempotency-key: once-only-key\r\ncontent-length: ${body.length}\r\n\r\n${body}`
    expect((await send(t.s.clientPort!, post)).status).toBe('200')
    expect(t.calls).toEqual([['prs'], ['stop']])
  })
})

const postRequest = (path: string, value: unknown, key = '') => {
  const body = JSON.stringify(value)
  return `POST ${path} HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\n${key ? `idempotency-key: ${key}\r\n` : ''}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

test('guard.check answers through mTLS within one second', async () => {
  const t = start()
  for (const command of [
    'factory decide r1 ok',
    ('#x\\\n' + 'factory start factory wiki '.repeat(3000)).slice(0, 65536),
  ]) {
    const r = await send(t.s.clientPort!, postRequest('/v1/guard/check', { command, role: 'manager' }))
    expect(r.status).toBe('200')
    expect(JSON.parse(r.body).decision).toBe(command.startsWith('#') ? 'deny' : 'ask')
    console.log(`guard.check mTLS: ${r.ms.toFixed(1)} ms`)
    expect(r.ms).toBeLessThan(1000)
  }
})

test('guard.check does not wait for a mutating POST', async () => {
  const t = start(undefined, undefined, 3000)
  let finished = false
  const action = send(
    t.s.clientPort!,
    postRequest('/v1/start', { factory: 'lifecycle', rig: 'acme', goal: 'x' }, 'guard-start-key'),
  ).then(r => {
    finished = true
    return r
  })
  try {
    const until = performance.now() + 5000
    while (t.calls.length === 0 && performance.now() < until) await Bun.sleep(10)
    expect(t.calls.length).toBe(1)
    const r = await send(
      t.s.clientPort!,
      postRequest('/v1/guard/check', { command: 'factory status', role: 'manager' }),
    )
    expect(r.status).toBe('200')
    expect(JSON.parse(r.body)).toEqual({ decision: 'allow' })
    console.log(`guard.check during action: ${r.ms.toFixed(1)} ms`)
    expect(r.ms).toBeLessThan(1000)
    expect(finished).toBe(false)
  } finally {
    await action
  }
}, 15000)

describe('parseFlags', () => {
  const all = ['--client-port', '8444', '--tls-cert', '/c', '--tls-key', '/k', '--person-ca', '/ca']
  test('none of the four gives no client', () => {
    expect(parseFlags([]).client).toBeUndefined()
  })
  test('all four give the client', () => {
    expect(parseFlags(all).client).toEqual({ port: 8444, cert: '/c', key: '/k', ca: '/ca' })
  })
  for (let i = 0; i < 4; i++)
    test(`three of four (without pair ${i}) is a usage error`, () => {
      const a = all.filter((_, j) => Math.floor(j / 2) !== i)
      expect(() => parseFlags(a)).toThrow(/usage/)
    })
  test('a repeated flag, a flag without a value and the health port are usage errors', () => {
    expect(() => parseFlags([...all, '--tls-key', '/k2'])).toThrow(/usage/)
    expect(() => parseFlags([...all.slice(0, 7)])).toThrow(/usage/)
    expect(() => parseFlags(['--port', '8444', ...all])).toThrow(/usage/)
    expect(() => parseFlags(['--client-port', '70000', ...all.slice(2)])).toThrow(/usage/)
  })
})

describe('events over mTLS: replay then live', () => {
  test('held ticks: replay crosses into live once, an equal tick adds nothing, stop ends every stream', async () => {
    let cur: unknown = { n: 0 }
    let free = false
    const waiting: (() => void)[] = []
    const tick = async () => {
      if (!free) await new Promise<void>(r => waiting.push(r))
      return cur
    }
    const pause = async (ok: () => boolean) => {
      const until = performance.now() + 5000
      while (!ok() && performance.now() < until) await Bun.sleep(5)
      expect(ok()).toBe(true)
    }
    // A release ends the held tick. The next tick is held again only after the board went to onBoard.
    const release = async (board: unknown) => {
      await pause(() => waiting.length > 0)
      cur = board
      waiting.shift()?.()
      await pause(() => waiting.length > 0)
    }
    const t = start(tick)
    const who = pair(A)
    const readers: { pump: Promise<void>; kill: () => void; exited: Promise<number> }[] = []
    const reader = (after: number) => {
      const p = Bun.spawn(
        [
          ...['curl', '-sN', '-i', '--max-time', '20', '--cacert', join(A, 'ca.crt')],
          ...['--cert', who.cert, '--key', who.key],
          ...['--resolve', `localhost:${t.s.clientPort}:127.0.0.1`],
          `${t.url}/v1/events?after=${after}`,
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      const rd = p.stdout.getReader()
      const dec = new TextDecoder()
      const frames: string[] = []
      let head = ''
      let buf = ''
      let eof = false
      const take = (chunk: string) => {
        buf += chunk
        if (!head) {
          const k = buf.indexOf('\r\n\r\n')
          if (k < 0) return
          head = buf.slice(0, k)
          buf = buf.slice(k + 4)
        }
        for (let k = buf.indexOf('\n\n'); k >= 0; k = buf.indexOf('\n\n')) {
          frames.push(buf.slice(0, k + 2))
          buf = buf.slice(k + 2)
        }
      }
      const pump = (async () => {
        for (;;) {
          const r = await rd.read()
          if (r.done) break
          take(dec.decode(r.value, { stream: true }))
        }
        take(dec.decode())
        eof = true
      })()
      const x = {
        frames,
        head: () => head,
        rest: () => buf,
        eof: () => eof,
        pump,
        kill: () => p.kill(),
        exited: p.exited,
      }
      readers.push(x)
      return x
    }
    try {
      await release({ n: 1, t: 'é€' })
      const a = reader(0)
      const b = reader(0)
      await pause(() => a.frames.length >= 1 && b.frames.length >= 1)
      expect(a.head().toLowerCase()).toContain('content-type: text/event-stream; charset=utf-8')
      expect(a.frames).toEqual(['id: 1\ndata: {"n":1,"t":"é€"}\n\n'])
      await release({ n: 2, nested: { a: [1] } })
      await pause(() => a.frames.length >= 2 && b.frames.length >= 2)
      const c = reader(1)
      await pause(() => c.frames.length >= 1)
      expect(c.frames).toEqual(['id: 2\ndata: {"n":2,"nested":{"a":[1]}}\n\n'])
      await release(null)
      await pause(() => [a, b, c].every(r => r.frames.length >= (r === c ? 2 : 3)))
      await release(null)
      await release({ marker: 4 })
      await pause(() => [a, b, c].every(r => r.frames.length >= (r === c ? 3 : 4)))
      free = true
      for (const r of waiting.splice(0)) r()
      await t.s.stop()
      // The server close must end every stream. The socket ends without TLS close_notify, so curl exits 56 by itself (seen 1 of 1 run; 28 is a timeout and a kill has a signal).
      await within('stream EOF', 5000, Promise.all(readers.map(r => r.pump)))
      expect(await within('curl exit', 5000, Promise.all(readers.map(r => r.exited)))).toEqual([56, 56, 56])
      const f = [
        'id: 1\ndata: {"n":1,"t":"é€"}\n\n',
        'id: 2\ndata: {"n":2,"nested":{"a":[1]}}\n\n',
        'id: 3\ndata: null\n\n',
        'id: 4\ndata: {"marker":4}\n\n',
      ]
      expect(a.frames).toEqual(f)
      expect(b.frames).toEqual(f)
      expect(c.frames).toEqual(f.slice(1))
      for (const r of [a, b, c]) {
        expect(r.eof()).toBe(true)
        expect(r.rest()).toBe('')
      }
    } finally {
      free = true
      for (const r of waiting.splice(0)) r()
      for (const r of readers) r.kill()
      await Promise.all(readers.map(r => r.exited))
    }
  }, 30000)
})

// Wait for a promise, or fail at the deadline. The timer is cleared so it cannot outlive the test.
const within = async <T>(what: string, ms: number, p: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what}: not done in ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('events over mTLS: barriers', () => {
  test('headers come before the first tick ends, two live changes arrive once each, and server stop ends the stream', async () => {
    let cur: unknown = { n: 0 }
    let free = false
    const waiting: (() => void)[] = []
    const tick = async () => {
      if (!free) await new Promise<void>(r => waiting.push(r))
      return cur
    }
    const release = async (board: unknown) => {
      const until = performance.now() + 5000
      while (waiting.length === 0 && performance.now() < until) await Bun.sleep(5)
      expect(waiting.length).toBeGreaterThan(0)
      cur = board
      waiting.shift()?.()
    }
    const t = start(tick)
    const who = pair(A)
    const p = Bun.spawn(
      [
        ...['openssl', 's_client', '-connect', `localhost:${t.s.clientPort}`, '-servername', 'localhost'],
        ...['-CAfile', join(A, 'ca.crt'), '-quiet', '-tls1_3', '-cert', who.cert, '-key', who.key],
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 15000 },
    )
    try {
      // curl keeps a header until the first body byte. This test sends the request by hand and keeps stdin open.
      p.stdin.write('GET /v1/events?after=0 HTTP/1.1\r\nHost: localhost\r\n\r\n')
      await p.stdin.flush()
      const rd = p.stdout.getReader()
      const dec = new TextDecoder()
      let text = ''
      let done = false
      const until = async (re: RegExp) => {
        while (!re.test(text) && !done) {
          const r = await within('read', 10000, rd.read())
          if (r.done) done = true
          else text += dec.decode(r.value)
        }
      }
      // the first tick is held: the stream is open and has no event yet
      await until(/\r\n\r\n/)
      expect(waiting.length).toBe(1)
      expect(text.toLowerCase()).toContain('content-type: text/event-stream')
      expect(text).not.toContain('id:')
      await release({ n: 1 })
      await until(/id: 1\ndata: \{"n":1\}\n\n/)
      await release({ n: 2 })
      await until(/id: 2\ndata: \{"n":2\}\n\n/)
      // a later tick sees an equal board; the reader stays active until the stop closes the stream
      await release({ n: 2 })
      free = true
      for (const r of waiting.splice(0)) r()
      await t.s.stop()
      // The server close must end the stream before the client deadline, and openssl must exit by itself.
      await within('stream EOF', 5000, until(/never/))
      expect(done).toBe(true)
      expect(text.match(/^id: /gm)?.length).toBe(2)
      expect(text.endsWith('id: 2\ndata: {"n":2}\n\n')).toBe(true)
      const code = await within('openssl exit', 5000, p.exited)
      expect(p.signalCode).toBeNull()
      // The server ends the socket without TLS close_notify: openssl exits 1 with this EOF diagnostic (seen 4 of 4 runs).
      expect(code).toBe(1)
      expect(await new Response(p.stderr).text()).toContain('unexpected eof while reading')
    } finally {
      free = true
      for (const r of waiting.splice(0)) r()
      p.kill()
      await p.exited
      await t.s.stop()
    }
  }, 20000)
})
