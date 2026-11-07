import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main as clientMain } from './client'
import { parseFlags, serve } from './server'
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

const start = (tick: () => unknown = () => ({ runs: ['r1'] })) => {
  const calls: string[][] = []
  const run = async (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    return { code: 0, out: '{"ok":1}\n', err: '', ...({} as object) }
  }
  const home = tmp()
  let s: ReturnType<typeof serve>
  const handle = clientHandler({ home, run, board: () => s.board() })
  s = serve({
    home,
    port: 0,
    everyMs: 50,
    leaseMs: 1000,
    tick,
    log: () => {},
    client: {
      port: 0,
      cert: read(A, 'server.crt'),
      key: read(A, 'server.key'),
      ca: read(A, 'ca.crt'),
      handle,
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

describe('request grammar of the client listener', () => {
  const send = async (port: number, text: string) => {
    const p = Bun.spawn(
      [
        ...['openssl', 's_client', '-connect', `localhost:${port}`, '-servername', 'localhost'],
        ...['-CAfile', join(A, 'ca.crt'), '-quiet', '-tls1_3', '-cert', join(A, 'person.crt')],
        ...['-key', join(A, 'person.key')],
      ],
      { stdin: new Blob([text]), stdout: 'pipe', stderr: 'ignore', timeout: 5000 },
    )
    return ((await new Response(p.stdout).text()).match(/^HTTP\/1\.1 (\d+)/) ?? [])[1] ?? 'none'
  }
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
      expect(want.split(' or ')).toContain(await send(t.s.clientPort!, text))
      expect(t.calls.length).toBe(0)
    })
  test('a valid GET and a valid POST are served', async () => {
    const t = start()
    expect(await send(t.s.clientPort!, 'GET /v1/prs HTTP/1.1\r\nHost: x\r\n\r\n')).toBe('200')
    const body = '{"mode":"stop"}'
    const post = `POST /v1/halt HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\nidempotency-key: once-only-key\r\ncontent-length: ${body.length}\r\n\r\n${body}`
    expect(await send(t.s.clientPort!, post)).toBe('200')
    expect(t.calls).toEqual([['prs'], ['stop']])
  })
})

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
