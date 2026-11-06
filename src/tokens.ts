// Worker tokens (claude-factory-akiq.4): `v1.<b64url payload>.<b64url HMAC-SHA256(key, 'v1.' + payload part)>`.
// The payload is {id, task, run, node, seq, exp}. check() takes no request data: run, node and seq come only
// from the signed payload, and the token must also match its worker_tokens row (specs/004-factory-server).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export type Claims = { task: string; run: string; node: string; seq: number; exp: number }
export type CheckResult =
  | { ok: true; id: string; claims: Claims }
  | { ok: false; reason: 'malformed' | 'bad signature' | 'expired' | 'unknown' | 'revoked' }
type Row = {
  task: string
  run: string
  node: string
  seq: number
  expires_at: number
  revoked_at: number | null
}

const MAX_TOKEN = 4096
const NAME = /^[A-Za-z0-9._-]{1,128}$/
const ID = /^[0-9a-f]{32}$/
const SHAPE = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
const KEYS = ['id', 'task', 'run', 'node', 'seq', 'exp']

// ponytail: one writer (the server under the lease), a JSON file on the PVC. Upgrade: the Dolt worker_tokens table (spec step S6).
const storePath = (home: string) => join(home, 'worker-tokens.json')

function needKey(key: Buffer) {
  if (key.length < 32) throw new Error('worker key must be at least 32 bytes')
}
const mac = (key: Buffer, part: string) => createHmac('sha256', key).update(`v1.${part}`).digest()
const isName = (v: unknown): v is string => typeof v === 'string' && NAME.test(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const validClaims = (c: Claims) =>
  isName(c.task) && isName(c.run) && isName(c.node) && isInt(c.seq) && c.seq >= 0 && isInt(c.exp)

/** a missing file is an empty store; a file that does not parse throws, so nothing writes over it */
function readStore(home: string): Record<string, Row> {
  let text: string
  try {
    text = readFileSync(storePath(home), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  const v = JSON.parse(text)
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error('worker-tokens.json is not an object')
  return v
}
function writeStore(home: string, rows: Record<string, Row>) {
  const tmp = `${storePath(home)}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(rows))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, storePath(home)) // atomic: a reader never sees half a store
}

/** issue a token and store its row; rows that expired before `now` are dropped */
export function sign(home: string, key: Buffer, claims: Claims, now: number): string {
  needKey(key)
  if (!validClaims(claims) || claims.exp <= now) throw new Error('invalid token claims')
  const rows = readStore(home)
  for (const [k, r] of Object.entries(rows)) if (r.expires_at <= now) delete rows[k]
  const id = randomBytes(16).toString('hex')
  const { task, run, node, seq, exp } = claims
  rows[id] = { task, run, node, seq, expires_at: exp, revoked_at: null }
  writeStore(home, rows)
  const part = Buffer.from(JSON.stringify({ id, task, run, node, seq, exp })).toString('base64url')
  return `v1.${part}.${mac(key, part).toString('base64url')}`
}

/** accept only a correctly signed, well-formed, live token whose store row matches; never throws on a bad token */
export function check(home: string, key: Buffer, token: string, now: number): CheckResult {
  needKey(key)
  const no = (reason: Exclude<CheckResult, { ok: true }>['reason']) => ({ ok: false as const, reason })
  const m = token.length <= MAX_TOKEN ? SHAPE.exec(token) : null
  if (!m) return no('malformed')
  const want = mac(key, m[1]!)
  const got = Buffer.from(m[2]!, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return no('bad signature')
  let p: Record<string, unknown>
  try {
    p = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'))
  } catch {
    return no('malformed')
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return no('malformed')
  const names = Object.keys(p)
  if (names.length !== KEYS.length || !KEYS.every(k => names.includes(k))) return no('malformed')
  const { id, task, run, node, seq, exp } = p
  if (typeof id !== 'string' || !ID.test(id)) return no('malformed')
  const c = { task, run, node, seq, exp } as Claims
  if (!validClaims(c)) return no('malformed')
  if (c.exp <= now) return no('expired')
  let row: Row | undefined
  try {
    const rows = readStore(home)
    row = Object.hasOwn(rows, id) ? rows[id] : undefined
  } catch {
    return no('unknown') // a store that does not parse refuses every worker
  }
  if (
    !row ||
    row.task !== c.task ||
    row.run !== c.run ||
    row.node !== c.node ||
    row.seq !== c.seq ||
    row.expires_at !== c.exp
  )
    return no('unknown')
  if (row.revoked_at !== null) return no('revoked')
  return { ok: true, id, claims: c }
}

/** revoke each live row of a run, or of one node and seq (station end); returns the count */
export function revoke(
  home: string,
  scope: { run: string; node?: string; seq?: number },
  now: number,
): number {
  const rows = readStore(home)
  let n = 0
  for (const r of Object.values(rows)) {
    if (r.revoked_at !== null || r.run !== scope.run) continue
    if (scope.node !== undefined && r.node !== scope.node) continue
    if (scope.seq !== undefined && r.seq !== scope.seq) continue
    r.revoked_at = now
    n++
  }
  if (n) writeStore(home, rows)
  return n
}
