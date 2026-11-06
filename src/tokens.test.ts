// Worker tokens (claude-factory-akiq.4): sign, check, revoke. Every test passes `now` and uses a fresh home.
import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, revoke, sign } from './tokens'

const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 9)
const NOW = 1_000_000
const claims = { task: 'task-1', run: 'run-1', node: 'implement', seq: 3, exp: NOW + 60_000 }
const home = () => mkdtempSync(join(tmpdir(), 'tokens-'))
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const mac = (k: Buffer, part: string) => createHmac('sha256', k).update(`v1.${part}`).digest('base64url')
/** a token with a correct HMAC over any payload object: the parse, not the signature, must refuse it */
const forge = (payload: unknown, k = key) => {
  const p = b64(JSON.stringify(payload))
  return `v1.${p}.${mac(k, p)}`
}
const reason = (r: ReturnType<typeof check>) => (r.ok ? 'ok' : r.reason)

test('AC1: a valid token passes and the claims match', () => {
  const h = home()
  const r = check(h, key, sign(h, key, claims, NOW), NOW)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.claims).toEqual(claims)
    expect(r.id).toMatch(/^[0-9a-f]{32}$/)
  }
})

test('AC2: an expired token fails at exp and after', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  expect(reason(check(h, key, t, claims.exp - 1))).toBe('ok')
  expect(reason(check(h, key, t, claims.exp))).toBe('expired')
  expect(reason(check(h, key, t, claims.exp + 1))).toBe('expired')
})

test('AC3: revoke fails the token, once, and only for the match', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const sibling = sign(h, key, { ...claims, node: 'review' }, NOW)
  const seq2 = sign(h, key, { ...claims, seq: 4 }, NOW)
  const other = sign(h, key, { ...claims, run: 'run-2' }, NOW)
  expect(revoke(h, { run: 'run-1', node: 'implement', seq: 3 }, NOW)).toBe(1)
  expect(reason(check(h, key, t, NOW))).toBe('revoked')
  expect(revoke(h, { run: 'run-1', node: 'implement', seq: 3 }, NOW)).toBe(0)
  expect(reason(check(h, key, sibling, NOW))).toBe('ok')
  expect(reason(check(h, key, seq2, NOW))).toBe('ok')
  expect(revoke(h, { run: 'run-1' }, NOW)).toBe(2)
  expect(reason(check(h, key, sibling, NOW))).toBe('revoked')
  expect(reason(check(h, key, other, NOW))).toBe('ok')
})

test('AC4: a tampered or wrongly signed token fails', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const [v, p, s] = t.split('.')
  const flip = (x: string) => (x[0] === 'A' ? 'B' : 'A') + x.slice(1)
  expect(reason(check(h, key, `${v}.${flip(p!)}.${s}`, NOW))).toBe('bad signature')
  expect(reason(check(h, key, `${v}.${p}.${flip(s!)}`, NOW))).toBe('bad signature')
  expect(reason(check(h, otherKey, t, NOW))).toBe('bad signature')
  expect(reason(check(h, key, forge({ ...claims, id: 'a'.repeat(32) }, otherKey), NOW))).toBe('bad signature')
})

test('AC4: a payload outside the grammar is malformed even with a correct HMAC', () => {
  const h = home()
  const ok = { id: 'a'.repeat(32), ...claims }
  expect(reason(check(h, key, forge(ok), NOW))).toBe('unknown') // grammar is fine; no row
  const { task: _t, ...missing } = ok
  for (const bad of [
    { ...ok, extra: 1 },
    missing,
    { ...ok, seq: -1 },
    { ...ok, seq: 1.5 },
    { ...ok, seq: '3' },
    { ...ok, run: 'a/b' },
    { ...ok, run: 'a b' },
    { ...ok, task: 'x'.repeat(129) },
    { ...ok, id: 'xyz' },
    { ...ok, exp: 'soon' },
    null,
    [],
  ])
    expect(reason(check(h, key, forge(bad), NOW))).toBe('malformed')
})

test('AC5: the token must match its store row', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const id = (check(h, key, t, NOW) as { id: string }).id
  expect(reason(check(home(), key, t, NOW))).toBe('unknown')
  const file = join(h, 'worker-tokens.json')
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  for (const [f, v] of [
    ['task', 'other'],
    ['run', 'other'],
    ['node', 'other'],
    ['seq', 9],
    ['expires_at', claims.exp + 1],
  ] as const) {
    writeFileSync(file, JSON.stringify({ [id]: { ...rows[id], [f]: v } }))
    expect(reason(check(h, key, t, NOW))).toBe('unknown')
  }
})

test('AC5: a store that does not parse refuses check and keeps its bytes on sign and revoke', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const file = join(h, 'worker-tokens.json')
  writeFileSync(file, '{not json')
  expect(reason(check(h, key, t, NOW))).toBe('unknown')
  expect(() => sign(h, key, claims, NOW)).toThrow()
  expect(() => revoke(h, { run: 'run-1' }, NOW)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('{not json')
})

test('AC6: a token outside the closed grammar is malformed; check never throws', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const [, p, s] = t.split('.')
  for (const bad of [
    '',
    'Bearer x',
    `v2.${p}.${s}`,
    `v1.${p}`,
    `${t}.x`,
    `v1.${p}.${s}!`,
    `${t}${'a'.repeat(4096)}`,
  ])
    expect(reason(check(h, key, bad, NOW))).toBe('malformed')
  expect(reason(check(h, key, 'v1.%%.%%', NOW))).toBe('malformed')
  expect(reason(check(h, key, forge('x').replace(/\.[^.]+$/, '.' + b64('x')), NOW))).toBe('bad signature')
  expect(reason(check(h, key, `v1.${b64('not json')}.${mac(key, b64('not json'))}`, NOW))).toBe('malformed')
})

test('AC6: a short key throws in sign and check; sign refuses bad claims', () => {
  const h = home()
  const short = Buffer.alloc(31, 1)
  expect(() => sign(h, short, claims, NOW)).toThrow()
  expect(() => check(h, short, 'x', NOW)).toThrow()
  expect(() => sign(h, key, { ...claims, run: 'a/b' }, NOW)).toThrow()
  expect(() => sign(h, key, { ...claims, exp: NOW }, NOW)).toThrow()
})

test('AC7: the store holds no token or signature and has mode 0600', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const file = join(h, 'worker-tokens.json')
  const text = readFileSync(file, 'utf8')
  expect(text).not.toContain(t.split('.')[2]!)
  expect(text).not.toContain(t.split('.')[1]!)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('S1: a now that is not a safe integer throws in sign, check and revoke', () => {
  const h = home()
  const t = sign(h, key, claims, NOW)
  const file = join(h, 'worker-tokens.json')
  const before = readFileSync(file, 'utf8')
  for (const bad of [NaN, Infinity, -Infinity, 1.5]) {
    expect(() => sign(h, key, claims, bad)).toThrow()
    expect(() => check(h, key, t, bad)).toThrow()
    expect(() => revoke(h, { run: claims.run }, bad)).toThrow()
  }
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(reason(check(h, key, t, NOW))).toBe('ok')
  expect(revoke(h, { run: claims.run }, NOW)).toBe(1)
  expect(reason(check(h, key, t, NOW))).toBe('revoked')
})

test('sign drops rows that expired before it', () => {
  const h = home()
  sign(h, key, claims, NOW)
  sign(h, key, { ...claims, node: 'review', exp: claims.exp + 100 }, claims.exp + 1)
  expect(Object.keys(JSON.parse(readFileSync(join(h, 'worker-tokens.json'), 'utf8')))).toHaveLength(1)
})
