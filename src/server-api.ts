// Client API of `factory server` on port 8444 (claude-factory-akiq.7). Contract: specs/004-factory-server/contracts/client-api.md.
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { STATUS_CODES } from 'node:http'
import type { Socket } from 'node:net'
import { join, resolve, sep } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
import {
  CATALOG,
  boardView,
  OpError,
  readBody,
  readQuery,
  type Ctx,
  type Input,
  type Op,
  type Port,
  type RunResult,
  type Runner,
} from './core/catalog'
export type { RunResult, Runner } from './core/catalog'

const NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Make a new folder with the person CA, the person certificate and the server certificate.
 * If the folder exists or the name is bad, throw before any write. Call openssl with an argv array, not a shell.
 * ponytail: the person CA also signs the server certificate, because the client pins one ca.crt. That certificate has serverAuth only, so the CA does not accept it as a client certificate.
 */
export function personCerts(dir: string, serverName: string) {
  if (!NAME.test(serverName)) throw new Error('server-name must match ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$')
  if (existsSync(dir)) throw new Error(`${dir} exists: choose a new folder, no key is overwritten`)
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
  const ssl = (...a: string[]) => {
    const r = Bun.spawnSync(['openssl', ...a], { cwd: dir })
    if (r.exitCode !== 0) throw new Error(`openssl ${a[0]} failed: ${r.stderr.toString().slice(0, 300)}`)
  }
  const key = (n: string) => {
    ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${n}.key`)
    chmodSync(join(dir, `${n}.key`), 0o600)
  }
  const leaf = (n: string, cn: string, ext: string) => {
    key(n)
    ssl('req', '-new', '-key', `${n}.key`, '-subj', `/CN=${cn}`, '-out', `${n}.csr`)
    writeFileSync(join(dir, `${n}.ext`), ext)
    ssl(
      ...['x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial'],
      ...['-days', '825', '-sha256', '-extfile', `${n}.ext`, '-out', `${n}.crt`],
    )
  }
  try {
    key('ca')
    ssl(
      ...[
        'req',
        '-x509',
        '-new',
        '-key',
        'ca.key',
        '-sha256',
        '-days',
        '825',
        '-subj',
        '/CN=factory-person-ca',
      ],
      ...[
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign',
        '-out',
        'ca.crt',
      ],
    )
    leaf('person', 'person', 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n')
    const san = IPV4.test(serverName) ? `IP:${serverName}` : `DNS:${serverName}`
    leaf(
      'server',
      serverName,
      `extendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nsubjectAltName=${san}\n`,
    )
    for (const f of ['person.csr', 'person.ext', 'server.csr', 'server.ext', 'ca.srl'])
      rmSync(join(dir, f), { force: true })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  return [
    `made ${dir}: ca.key ca.crt person.key person.crt server.key server.crt. Next steps for the owner:`,
    `  1. Copy person.crt, person.key and ca.crt to ~/.config/factory/ on the laptop (person.key mode 0600).`,
    `  2. kubectl -n factory create secret tls factory-server-tls --cert=${dir}/server.crt --key=${dir}/server.key`,
    `  3. kubectl -n factory create secret generic factory-person-ca --from-file=ca.crt=${dir}/ca.crt`,
    `  4. Keep ca.key offline: move it off this machine.`,
  ].join('\n')
}

export type ClientOpts = {
  home: string
  run: Runner
  /** the cli.ts helpers that the in-process operations call */
  port: Port
  /** the last tick result, null before the first tick */
  board: () => unknown
  log?: (line: string) => void
  /** the limit of one call, 60 s by default */
  callTimeoutMs?: number
}

const WORKER_ENV = [
  'FACTORY_SERVER',
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'FACTORY_OUTBOX',
  'BEADS_ACTOR',
]

/** the env of a CLI call for the person: no worker marker, no server mode, and the server home */
export function personEnv(env: Record<string, string | undefined>, home: string) {
  const e = { ...env }
  for (const n of WORKER_ENV) delete e[n]
  return { ...e, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' } as Record<string, string>
}

/**
 * The real runner: one `bun cli.ts <argv>` process for each call, with cwd = home. It has no shell.
 * Mail text goes through <home>/text/<uuid>.md and --text-file. The file is gone when the call ends.
 * ponytail: one bun process per call (about 0.3 s). Upgrade path: export the command functions from cli.ts and call them in process.
 */
export function cliRunner(home: string, cli = join(import.meta.dir, 'cli.ts'), timeoutMs = 60_000): Runner {
  return async (argv, text) => {
    let file: string | undefined
    try {
      if (text !== undefined) {
        mkdirSync(join(home, 'text'), { recursive: true })
        file = join(home, 'text', `${randomUUID()}.md`)
        writeFileSync(file, text, { mode: 0o600 })
      }
      const proc = Bun.spawn([process.execPath, cli, ...argv, ...(file ? ['--text-file', file] : [])], {
        cwd: home,
        env: personEnv(process.env, home),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      let timedOut = false as boolean
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeoutMs)
      try {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { code, out, err, ...(timedOut ? { timedOut } : {}) }
      } finally {
        clearTimeout(timer)
      }
    } finally {
      if (file) rmSync(file, { force: true })
    }
  }
}

const KEY = /^[A-Za-z0-9-]{8,128}$/
const MAX_BODY = 128 * 1024
const DAY = 24 * 3600_000
const EVENTS_KEEP = 256

const reply = (status: number, body: string, json = true) =>
  new Response(body, { status, headers: { 'content-type': json ? 'application/json' : 'text/plain' } })
const refuse = (status: number, why: string) => reply(status, `${JSON.stringify({ refused: why })}\n`)
const looksJson = (s: string) => /^\s*[{[]/.test(s)

/** match a request path to an operation of the catalog; the segments are not checked yet */
function match(method: string, path: string): { op: Op; params: string[] } | undefined {
  const parts = path.split('/')
  for (const op of CATALOG) {
    const want = op.route.path.split('/')
    if (op.route.method !== method || want.length !== parts.length) continue
    if (want.every((w, i) => w.startsWith(':') || w === parts[i]))
      return { op, params: parts.filter((_, i) => want[i]!.startsWith(':')) }
  }
}

/** true when `cwd` is the run worktree or under it (a path separator bounds the prefix) */
function insideRunWorktree(home: string, id: string, cwd: string): boolean {
  let run: { worktree?: unknown; repo?: unknown }
  try {
    run = JSON.parse(readFileSync(join(home, 'runs', id, 'run.json'), 'utf8'))
  } catch {
    return false // no run: the CLI answers that
  }
  if (typeof run.worktree !== 'string' || !run.worktree || run.worktree === run.repo) return false
  const real = (p: string) => {
    try {
      return realpathSync(resolve(p))
    } catch {
      return resolve(p)
    }
  }
  const wt = real(run.worktree)
  const here = real(cwd)
  return here === wt || here.startsWith(wt + sep)
}

type Row = { at: number; hash: string; status: number; body: string }

/** the store rows, {} when the file is missing, 'bad' when it does not parse */
function readStore(file: string): Record<string, Row> | 'bad' {
  if (!existsSync(file)) return {}
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : 'bad'
  } catch {
    return 'bad'
  }
}

function writeStore(file: string, rows: Record<string, Row>, now: number) {
  const keep = Object.fromEntries(Object.entries(rows).filter(([, r]) => now - r.at < DAY))
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(keep))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file) // atomic: a reader never sees half a store
}

/**
 * The handler of the client port. The listener has already checked the person certificate (the TLS handshake is the identity).
 * Each refusal answers before the runner and writes no idempotency row. Actions run one at a time.
 */
export function clientHandler(o: ClientOpts) {
  const storeFile = join(o.home, 'client-idempotency.json')
  const auditFile = join(o.home, 'client-actions.jsonl')
  let chain: Promise<unknown> = Promise.resolve()
  // The ring of board changes. ponytail: volatile, 256 events, the ids restart with the process. Upgrade path: a durable log.
  let lastJson = 'null'
  let lastId = 0n
  const ring: { id: bigint; frame: string }[] = []
  type Sub = { send: (id: bigint, frame: string) => void }
  const subs = new Set<Sub>()
  const publish = (board: unknown) => {
    let view: unknown
    try {
      view = boardView(board) // a client frame never holds env, params or beadsRemote
    } catch {
      return // fail closed: a malformed board makes no frame
    }
    const json = JSON.stringify(view ?? null)
    if (json === lastJson) return
    lastJson = json
    const ev = { id: ++lastId, frame: `id: ${lastId}\ndata: ${json}\n\n` }
    ring.push(ev)
    if (ring.length > EVENTS_KEEP) ring.shift()
    for (const sub of [...subs]) sub.send(ev.id, ev.frame)
  }
  const events = (after: bigint, signal?: AbortSignal): Response => {
    const enc = new TextEncoder()
    let sub: Sub
    let seen = after
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          // a slow client that leaves more than 256 frames unread is closed, never skipped
          sub = {
            send(id, frame) {
              if (id <= seen) return
              if ((c.desiredSize ?? 0) <= 0) {
                subs.delete(sub)
                return c.close()
              }
              seen = id
              c.enqueue(enc.encode(frame))
            },
          }
          const stop = () => {
            subs.delete(sub)
            try {
              c.close()
            } catch {}
          }
          if (signal?.aborted) return stop()
          signal?.addEventListener('abort', stop, { once: true })
          for (const ev of ring) sub.send(ev.id, ev.frame)
          subs.add(sub)
        },
        cancel: () => void subs.delete(sub),
      },
      { highWaterMark: EVENTS_KEEP },
    )
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
  const call = async (op: Op, input: Input): Promise<Response> => {
    // a new env for each call, as cliRunner gave a new env to each subprocess
    const ctx: Ctx = {
      home: o.home,
      cli: o.run,
      board: o.board,
      env: personEnv(process.env, o.home),
      port: o.port,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // the work can continue after the 504 (ponytail: no cancel; upgrade path: an AbortSignal in the port)
      const limit = new Promise<{ timedOut: true }>(res => {
        timer = setTimeout(() => res({ timedOut: true }), o.callTimeoutMs ?? 60_000)
      })
      const r = await Promise.race([op.run(ctx, input), limit])
      if (r.timedOut) return refuse(504, 'the command timed out')
      if (r.code !== 0) return refuse(422, r.err.slice(0, 500))
      if (op.name === 'gc.run') return reply(200, JSON.stringify(r), true)
      return reply(200, r.out, op.output === 'json' || looksJson(r.out))
    } catch (e) {
      if (e instanceof OpError) return refuse(e.status, e.message)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  const handle = async (req: Request, ip: string): Promise<Response> => {
    // A worker token must not open this port, whatever the value or the route (FR-010).
    if (req.headers.has('authorization'))
      return refuse(403, 'worker tokens are not accepted on the client port')
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const a = /^(?:|\?after=([0-9]+))$/.exec(url.search)
      return a
        ? events(BigInt(a[1] ?? 0), req.signal)
        : refuse(400, 'the query must be empty or after=<digits>')
    }
    const m = match(req.method, url.pathname)
    if (!m) return refuse(404, 'no such route')
    const { op, params } = m
    const q = readQuery(op, params, url.search)
    if (typeof q === 'string') return refuse(400, q)
    // ponytail: op.rights is not enforced. Every caller holds the person certificate, so every caller is the owner. Enforcement needs identity transport (aya5.6).
    if (op.route.method === 'GET') {
      try {
        return await call(op, q)
      } catch (e) {
        return refuse(500, `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      }
    }

    const key = req.headers.get('idempotency-key') ?? ''
    if (op.mutates && !KEY.test(key)) return refuse(400, 'Idempotency-Key must match ^[A-Za-z0-9-]{8,128}$')
    if (!/^application\/json\s*(;.*)?$/i.test(req.headers.get('content-type') ?? ''))
      return refuse(400, 'content-type must be application/json')
    const len = Number(req.headers.get('content-length') ?? 0)
    if (len > MAX_BODY) return refuse(400, 'body over 128 KiB')
    const raw = await req.text()
    if (Buffer.byteLength(raw) > MAX_BODY) return refuse(400, 'body over 128 KiB')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return refuse(400, 'body is not JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return refuse(400, 'body must be an object')
    const body = readBody(op, q, parsed as Record<string, unknown>)
    if (typeof body === 'string') return refuse(400, body)
    if (op.name === 'runs.start' && (body.goal as string).split(/\s+/).includes('--owned'))
      return refuse(400, 'the goal must not hold the word --owned: set owned')
    if (op.name === 'runs.mail' && insideRunWorktree(o.home, body.id as string, body.cwd as string))
      return refuse(403, 'a worker cannot send mail as the manager from inside the run worktree')

    if (!op.mutates) {
      try {
        return await call(op, body)
      } catch (e) {
        return refuse(500, `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      }
    }

    const path = url.pathname
    const hash = createHash('sha256').update(`${req.method}\0${path}\0${raw}`).digest('hex')
    const work = async (): Promise<Response> => {
      const rows = readStore(storeFile)
      let res: Response
      if (rows === 'bad') res = refuse(503, 'the idempotency store is corrupt')
      else {
        const now = Date.now()
        const row = rows[key]
        if (row && now - row.at < DAY) {
          res =
            row.hash === hash
              ? reply(row.status, row.body, looksJson(row.body))
              : refuse(409, 'Idempotency-Key was used for another request')
        } else {
          res = await call(op, body)
          rows[key] = { at: now, hash, status: res.status, body: await res.clone().text() }
          writeStore(storeFile, rows, now)
        }
      }
      const line: Record<string, unknown> = {
        at: new Date().toISOString(),
        ip,
        method: req.method,
        path,
        key,
        status: res.status,
      }
      if (op.name === 'gates.decide') line.outcome = body.outcome
      try {
        appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 })
      } catch (e) {
        o.log?.(`audit write failed: ${(e as Error).message}`)
      }
      o.log?.(`client ${req.method} ${path} ${res.status} from ${ip}`)
      return res
    }
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next.catch(e => refuse(500, `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
  }
  return Object.assign(handle, {
    /** record a board; an equal board adds no event */
    publish,
    /** the number of open event streams */
    subscribers: () => subs.size,
  })
}

const HEAD_MAX = 16 * 1024
const BODY_MAX = 256 * 1024
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const HEADER = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):[ \t]*([^\r\n\0]*?)[ \t]*$/

/**
 * Read one HTTP/1.1 request from an authorized socket and write one answer, then close.
 * The grammar is closed: no chunked body, no pipelining, no keep-alive, and a duplicate of a header that the handler reads is an error.
 */
export function serveSocket(
  sock: Socket,
  handle: (req: Request, ip: string) => Promise<Response>,
  idleMs: number,
  policy?: { bodyMax: number; validTarget: (target: string) => boolean },
) {
  const reply = (status: number, body: string, type = 'application/json', extra = '') => {
    sock.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Status'}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n${extra}\r\n${body}`,
    )
  }
  const bad = (status: number, why: string) => {
    done = true
    if (deadline) clearTimeout(deadline)
    if (policy) reply(400, JSON.stringify({ error: 'invalid_request' }))
    else reply(status, `${JSON.stringify({ refused: why })}\n`)
  }
  const deadline = policy ? setTimeout(() => sock.destroy(), idleMs) : undefined
  sock.once('close', () => {
    if (deadline) clearTimeout(deadline)
  })
  // the idle limit covers the read of the request only: a CLI call can run to its own 60 s limit and answer 504
  sock.setTimeout(idleMs, () => sock.destroy())
  sock.on('error', () => sock.destroy())
  let buf = Buffer.alloc(0)
  let head: { method: string; target: string; headers: Headers; length: number; end: number } | undefined
  let done = false
  const finish = async () => {
    done = true
    if (deadline) clearTimeout(deadline)
    sock.setTimeout(0)
    try {
      const body = buf.subarray(head!.end, head!.end + head!.length)
      const ip = sock.remoteAddress ?? ''
      const gone = new AbortController()
      sock.once('close', () => gone.abort())
      const req = new Request(`https://client.invalid${head!.target}`, {
        signal: gone.signal,
        method: head!.method,
        headers: head!.headers,
        ...(head!.method !== 'GET' && head!.method !== 'HEAD' && { body }),
      })
      const res = await handle(req, ip)
      if (res.headers.get('content-type')?.startsWith('text/event-stream') && res.body) {
        // close-delimited stream: no content-length, and the socket drain paces the reader
        // wait for drain or close when a write returns false; remove both paired listeners
        const flushed = (ok: boolean) =>
          ok || sock.destroyed
            ? undefined
            : new Promise<void>(r => {
                const go = () => {
                  sock.off('drain', go)
                  sock.off('close', go)
                  r()
                }
                sock.on('drain', go)
                sock.on('close', go)
              })
        const rd = res.body.getReader()
        sock.on('close', () => void rd.cancel().catch(() => {}))
        try {
          await flushed(
            sock.write(
              `HTTP/1.1 200 OK\r\ncontent-type: ${res.headers.get('content-type')}\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n`,
            ),
          )
          for (;;) {
            const { value, done } = await rd.read()
            if (done || sock.destroyed) break
            await flushed(sock.write(value))
          }
        } finally {
          sock.end()
        }
        return
      }
      const out = Buffer.from(await res.arrayBuffer())
      sock.write(
        `HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? 'Status'}\r\ncontent-type: ${res.headers.get('content-type') ?? 'text/plain'}\r\ncontent-length: ${out.length}\r\nconnection: close\r\n\r\n`,
      )
      sock.end(out)
    } catch {
      if (!sock.destroyed) bad(500, 'internal error')
    }
  }
  sock.on('data', (chunk: Buffer) => {
    if (done) return
    let tail: Buffer | undefined
    if (policy && !head) {
      const prefix = Buffer.concat([buf, chunk.subarray(0, HEAD_MAX + 4 - buf.length)])
      const at = prefix.indexOf('\r\n\r\n')
      if (at < 0) {
        buf = prefix
        return buf.length > HEAD_MAX ? bad(400, 'request head too large') : undefined
      }
      tail = chunk.subarray(at + 4 - buf.length)
      buf = prefix.subarray(0, at + 4)
    } else {
      if (policy && head && buf.length + chunk.length > head.end + head.length)
        return bad(400, 'unexpected data')
      buf = Buffer.concat([buf, chunk])
    }
    if (!head) {
      const at = buf.indexOf('\r\n\r\n')
      if (at < 0) return buf.length > HEAD_MAX ? bad(431, 'request head too large') : undefined
      if (at > HEAD_MAX) return bad(431, 'request head too large')
      const [line, ...rest] = buf.subarray(0, at).toString('latin1').split('\r\n')
      const m = /^([A-Z]{1,16}) (\/\S{0,4000}) HTTP\/1\.1$/.exec(line ?? '')
      if (!m) return bad(400, 'bad request line')
      if (policy && !policy.validTarget(m[2]!)) return bad(400, 'bad target')
      const headers = new Headers()
      const seen = new Set<string>()
      for (const l of rest) {
        const h = HEADER.exec(l)
        if (!h || !TOKEN.test(h[1]!)) return bad(400, 'bad header')
        const name = h[1]!.toLowerCase()
        // a repeated header could mean two things to two parsers
        if (seen.has(name) && name !== 'accept') return bad(400, 'repeated header')
        seen.add(name)
        headers.append(name, h[2]!)
      }
      if (seen.has('transfer-encoding') || seen.has('expect') || seen.has('upgrade'))
        return bad(400, 'chunked bodies, Expect and Upgrade are not served')
      const cl = headers.get('content-length')
      if (cl !== null && !/^\d{1,9}$/.test(cl)) return bad(400, 'bad content-length')
      const length = cl === null ? 0 : Number(cl)
      if (length > (policy?.bodyMax ?? BODY_MAX)) return bad(400, 'body too large')
      if (policy && (m[1] === 'GET' || m[1] === 'HEAD') && length !== 0) return bad(400, 'unexpected body')
      head = { method: m[1]!, target: m[2]!, headers, length, end: at + 4 }
    }
    if (tail) {
      if (tail.length > head.length) return bad(400, 'unexpected data')
      buf = Buffer.concat([buf, tail])
    }
    if (buf.length >= head.end + head.length) void finish()
  })
}

/**
 * The mTLS listener of the client API. It checks the client certificate itself with node:tls, before it reads a byte of the request.
 * Bun.serve with rejectUnauthorized did not gate the handler in Bun 1.3.13: it ran for a certificate from another CA
 * in 4 to 8 percent of the tries that sent the request at once (claude-factory-akiq.7).
 * An authorized client has a certificate that the person CA signed for client use. The server certificate has serverAuth only, so Node refuses it.
 * ponytail: one request for each connection and no keep-alive. Upgrade path: Bun.serve, when its client-certificate check gates the handler.
 */
export function clientListener(o: {
  port: number
  cert: string
  key: string
  ca: string
  handle: (req: Request, ip: string) => Promise<Response>
  idleMs?: number
}) {
  const open = new Set<Socket>()
  const srv = createTlsServer(
    {
      cert: o.cert,
      key: o.key,
      ca: [o.ca],
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
    sock => {
      if (!sock.authorized) return sock.destroy()
      open.add(sock)
      sock.on('close', () => open.delete(sock))
      serveSocket(sock, o.handle, o.idleMs ?? 30_000)
    },
  )
  srv.on('tlsClientError', () => {})
  srv.on('error', () => {})
  srv.listen(o.port)
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error(`cannot listen on client port ${o.port}`)
  return {
    port: addr.port,
    stop() {
      for (const s of open) s.destroy()
      srv.close()
    },
  }
}
