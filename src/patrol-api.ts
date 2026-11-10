import { createHash, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { createServer } from 'node:tls'
import type { PatrolLease } from './patrol-lease'
import { serveSocket } from './server-api'

export type PatrolIdentity = {
  id: string
  digest: string
  audience: string
  notBefore: number
  expiresAt: number
  rigs: string[]
}
type Operation = 'snapshot' | 'run' | 'acquire' | 'renew' | 'complete' | 'unknown'
type Reason =
  'ok' | 'invalid_request' | 'invalid_identity' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable'
export type PatrolAudit = {
  at: number
  operation: Operation
  status: number
  reason: Reason
  identity: string | null
  epoch: string
  generation: string | null
}
type Row = { id: string; rig: string }
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const name = (v: unknown): v is string => typeof v === 'string' && identifier.test(v)
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function identities(value: unknown): PatrolIdentity[] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const ids = new Set<string>(),
    digests = new Set<string>()
  const result: PatrolIdentity[] = []
  for (const r of value) {
    if (
      !object(r) ||
      !fields(r, ['id', 'digest', 'audience', 'notBefore', 'expiresAt', 'rigs']) ||
      !name(r.id) ||
      !name(r.audience) ||
      typeof r.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(r.digest) ||
      !time(r.notBefore) ||
      !time(r.expiresAt) ||
      r.expiresAt <= r.notBefore ||
      !Array.isArray(r.rigs) ||
      r.rigs.length < 1 ||
      r.rigs.length > 100 ||
      !r.rigs.every(name) ||
      new Set(r.rigs).size !== r.rigs.length ||
      ids.has(r.id) ||
      digests.has(r.digest)
    )
      return null
    ids.add(r.id)
    digests.add(r.digest)
    result.push({
      id: r.id,
      digest: r.digest,
      audience: r.audience,
      notBefore: r.notBefore,
      expiresAt: r.expiresAt,
      rigs: [...r.rigs],
    })
  }
  return result
}

function authenticate(req: Request, records: PatrolIdentity[], audience: string, now: number) {
  const match = /^Patrol (patrol_v1_([A-Za-z0-9_-]{43}))$/.exec(req.headers.get('authorization') ?? '')
  if (!match || !time(now) || Buffer.from(match[2]!, 'base64url').toString('base64url') !== match[2])
    return null
  const digest = createHash('sha256').update(match[1]!).digest()
  let found: PatrolIdentity | null = null
  for (const record of records) {
    if (timingSafeEqual(digest, Buffer.from(record.digest, 'hex'))) found = record
  }
  return found && found.audience === audience && found.notBefore <= now && now < found.expiresAt
    ? found
    : null
}

function validTarget(target: string) {
  if (!/^\/[A-Za-z0-9_/-]+$/.test(target) || target.includes('//') || target.endsWith('/')) return false
  const run = /^\/v1\/patrol\/runs\/([^/]+)$/.exec(target)
  return !run || identifier.test(run[1]!)
}

async function body(req: Request) {
  if (
    req.headers.get('content-type') !== 'application/json' ||
    !/^[A-Za-z0-9-]{8,128}$/.test(req.headers.get('idempotency-key') ?? '')
  )
    return null
  const reader = req.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 4096) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
    const bytes = Buffer.concat(chunks)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed: unknown = JSON.parse(text)
    return object(parsed) && Buffer.from(JSON.stringify(parsed)).equals(bytes) ? parsed : null
  } catch {
    return null
  }
}

function metadata(value: unknown, rigs: string[]): Row[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null
  const ids = new Set<string>(),
    result: Row[] = []
  for (const row of value) {
    if (!object(row) || !fields(row, ['id', 'rig']) || !name(row.id) || !name(row.rig) || ids.has(row.id))
      return null
    ids.add(row.id)
    if (rigs.includes(row.rig)) result.push({ id: row.id, rig: row.rig })
  }
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function patrolHandler(o: {
  audience: string
  identities: () => unknown
  metadata: () => unknown
  lease: PatrolLease
  now?: () => number
  audit: (event: PatrolAudit) => void
}) {
  if (!name(o.audience)) throw new Error('invalid patrol audience')
  const now = o.now ?? Date.now
  const emit = (event: Omit<PatrolAudit, 'at' | 'epoch'>) => {
    try {
      o.audit({ at: now(), epoch: o.lease.epoch, ...event })
    } catch {}
  }
  const handle = async (req: Request, method = req.method): Promise<Response> => {
    let who: PatrolIdentity | null = null
    let operation: Operation = 'unknown'
    const respond = (status: number, data?: unknown, completedGeneration: string | null = null) => {
      const reason: Reason =
        (
          {
            200: 'ok',
            400: 'invalid_request',
            401: 'invalid_identity',
            403: 'forbidden',
            404: 'not_found',
            409: 'conflict',
            503: 'unavailable',
          } as const
        )[status as 200] ?? 'unavailable'
      const generation =
        status === 200 && object(data) && typeof data.generation === 'string'
          ? data.generation
          : completedGeneration
      emit({ operation, status, reason, identity: who?.id ?? null, generation })
      return Response.json(status === 200 ? data : { error: reason }, { status })
    }
    const auth = () => {
      try {
        const records = identities(o.identities())
        const identity = records && authenticate(req, records, o.audience, now())
        return identity ? { identity, records: records! } : null
      } catch {
        return null
      }
    }
    const initial = auth()
    if (!initial) return respond(401)
    who = initial.identity
    const url = new URL(req.url)
    const target = url.pathname + url.search + (req.url.endsWith('?') ? '?' : '')
    if (!validTarget(target)) return respond(400)
    if (method === 'GET' && target === '/v1/patrol/snapshot') operation = 'snapshot'
    else if (method === 'GET' && /^\/v1\/patrol\/runs\/[A-Za-z0-9_-]+$/.test(target)) operation = 'run'
    else if (method === 'POST' && target === '/v1/patrol/lease/acquire') operation = 'acquire'
    else if (method === 'POST' && target === '/v1/patrol/lease/renew') operation = 'renew'
    else if (method === 'POST' && target === '/v1/patrol/lease/complete') operation = 'complete'
    else return respond(403)
    if (operation === 'snapshot' || operation === 'run') {
      if (req.body || (req.headers.has('content-length') && req.headers.get('content-length') !== '0'))
        return respond(400)
      try {
        const rows = metadata(o.metadata(), who.rigs)
        if (!rows) return respond(503)
        if (operation === 'snapshot') return respond(200, { epoch: o.lease.epoch, runs: rows })
        const run = rows.find(row => row.id === target.slice('/v1/patrol/runs/'.length))
        return run ? respond(200, { run }) : respond(404)
      } catch {
        return respond(503)
      }
    }
    const parsed = await body(req)
    const expected =
      operation === 'acquire'
        ? ['epoch']
        : operation === 'renew'
          ? ['epoch', 'generation']
          : ['epoch', 'generation', 'outcome']
    if (
      !parsed ||
      !fields(parsed, expected) ||
      typeof parsed.epoch !== 'string' ||
      !uuid.test(parsed.epoch) ||
      (operation !== 'acquire' && (typeof parsed.generation !== 'string' || !uuid.test(parsed.generation))) ||
      (operation === 'complete' && parsed.outcome !== 'success' && parsed.outcome !== 'failed')
    )
      return respond(400)
    const current = auth()
    if (!current) {
      who = null
      return respond(401)
    }
    who = current.identity
    const result = o.lease.mutate(
      who,
      operation,
      parsed,
      req.headers.get('idempotency-key')!,
      current.records,
    )
    return respond(
      result.status,
      result.body,
      result.status === 200 && operation === 'complete' ? (parsed.generation as string) : null,
    )
  }
  return Object.assign(handle, {
    invalid: (status: 400 | 503) =>
      emit({
        operation: 'unknown',
        status,
        reason: status === 400 ? 'invalid_request' : 'unavailable',
        identity: null,
        generation: null,
      }),
  })
}

export function patrolListener(o: {
  port: number
  cert: string
  key: string
  handle: ReturnType<typeof patrolHandler>
}) {
  const open = new Set<Socket>()
  const server = createServer(
    { cert: o.cert, key: o.key, minVersion: 'TLSv1.2', requestCert: false },
    sock => {
      open.add(sock)
      sock.once('close', () => open.delete(sock))
      serveSocket(sock, (req, _ip, method) => o.handle(req, method), 30_000, {
        bodyMax: 4096,
        validTarget,
        onInvalid: o.handle.invalid,
      })
    },
  )
  server.on('tlsClientError', () => {})
  server.listen(o.port)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('cannot listen on patrol port')
  return {
    port: address.port,
    stop() {
      for (const sock of open) sock.destroy()
      server.close()
    },
  }
}
