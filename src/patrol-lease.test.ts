import { describe, expect, spyOn, test } from 'bun:test'
import { PatrolLease } from './patrol-lease'

const principal = {
  id: 'patrol-one',
  digest: 'a'.repeat(64),
  audience: 'server',
  notBefore: 0,
  expiresAt: 1_000_000,
  rigs: ['acme'],
}
const setup = () => {
  let now = 1000
  const lease = new PatrolLease({ now: () => now })
  const lookup = spyOn(lease, 'lookup')
  const call = (
    operation: 'acquire' | 'renew' | 'complete',
    body: Record<string, unknown>,
    key = 'test-key-0001',
    who = principal,
  ) => lease.mutate(who, operation, body, key, [who])
  const acquire = (key = 'test-key-0001') => call('acquire', { epoch: lease.epoch }, key)
  const first = () => acquire().body as { epoch: string; generation: string; expiresAt: number }
  return {
    lease,
    lookup,
    call,
    acquire,
    first,
    time: (v: number) => {
      now = v
    },
  }
}

describe('1ocuv AC4 remote lease exclusion and replay', () => {
  test('lease expiry must remain a safe integer', () => {
    const now = Number.MAX_SAFE_INTEGER - 1
    const lease = new PatrolLease({ now: () => now })
    const who = { ...principal, expiresAt: Number.MAX_SAFE_INTEGER }
    expect(lease.mutate(who, 'acquire', { epoch: lease.epoch }, 'test-key-0001', [who]).status).toBe(503)
  })
  test('overlap has one winner and exact retries have no new transition', async () => {
    const t = setup()
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => t.acquire(`acquire-${i}`))),
    )
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(results.filter(r => r.status === 409)).toHaveLength(19)
    expect(t.acquire('acquire-0')).toEqual(results[0]!)
    expect(
      t.call('renew', { epoch: t.lease.epoch, generation: (results[0]!.body as any).generation }, 'acquire-0')
        .status,
    ).toBe(409)
  })
  test('renew replay retains the original expiry; changed body conflicts', () => {
    const t = setup()
    const first = t.first()
    t.time(2000)
    const body = { epoch: t.lease.epoch, generation: first.generation }
    const renewed = t.call('renew', body, 'renew-key')
    expect(renewed.body).toEqual({ ...body, expiresAt: 62000 })
    t.time(3000)
    expect(t.call('renew', body, 'renew-key')).toEqual(renewed)
    expect(t.call('complete', { ...body, outcome: 'success' }, 'renew-key').status).toBe(409)
  })
  for (const time of [61000, 61001, 999])
    test(`expiry or backward clock ${time} fences before replay`, () => {
      const t = setup()
      const first = t.first()
      t.time(time)
      t.lookup.mockClear()
      expect(t.acquire().status).toBe(409)
      expect(
        t.call('renew', { epoch: t.lease.epoch, generation: first.generation }, 'renew-key').status,
      ).toBe(409)
      expect(t.lookup).not.toHaveBeenCalled()
      expect(t.acquire('fresh-key').status).toBe(200)
    })
  for (const outcome of ['success', 'failed'])
    test(`completion ${outcome} has a fenced terminal receipt`, () => {
      const t = setup()
      const first = t.first()
      const body = { epoch: t.lease.epoch, generation: first.generation, outcome }
      const done = t.call('complete', body, 'complete-key')
      expect(done).toEqual({ status: 200, body: { completed: true } })
      expect(t.call('complete', body, 'complete-key')).toEqual(done)
      t.lookup.mockClear()
      expect(t.acquire().status).toBe(409)
      expect(t.call('complete', body, 'new-complete-key').status).toBe(409)
      expect(
        t.call('renew', { epoch: t.lease.epoch, generation: first.generation }, 'new-renew-key').status,
      ).toBe(409)
      expect(t.lookup).not.toHaveBeenCalled()
      expect(
        t.call('complete', { ...body, outcome: outcome === 'success' ? 'failed' : 'success' }, 'complete-key')
          .status,
      ).toBe(409)
      const newer = t.acquire('new-acquire')
      expect(newer.status).toBe(200)
      t.lookup.mockClear()
      expect(t.call('complete', body, 'complete-key').status).toBe(409)
      expect(t.lookup).not.toHaveBeenCalled()
      expect(t.acquire('new-acquire')).toEqual(newer)
    })
  test('terminal receipt expires at its original lease boundary', () => {
    const t = setup()
    const first = t.first()
    const body = { epoch: t.lease.epoch, generation: first.generation, outcome: 'success' }
    t.call('complete', body, 'complete-key')
    t.time(61000)
    t.lookup.mockClear()
    expect(t.call('complete', body, 'complete-key').status).toBe(409)
    expect(t.lookup).not.toHaveBeenCalled()
  })
  test('old keys cannot read receipts after a new generation starts', () => {
    const t = setup()
    const first = t.first()
    t.call(
      'complete',
      { epoch: t.lease.epoch, generation: first.generation, outcome: 'success' },
      'complete-key',
    )
    const newer = t.acquire('new-acquire').body as { generation: string }
    t.lookup.mockClear()
    expect(t.acquire().status).toBe(409)
    expect(t.lookup).not.toHaveBeenCalled()
    expect(
      t.call('renew', { epoch: t.lease.epoch, generation: newer.generation }, 'test-key-0001').status,
    ).toBe(409)
    expect(t.lookup).not.toHaveBeenCalled()
  })
  test('a stale generation with a fresh key has no renewal or release effect', () => {
    const t = setup()
    const first = t.first()
    t.call(
      'complete',
      { epoch: t.lease.epoch, generation: first.generation, outcome: 'success' },
      'complete-key',
    )
    const newer = t.acquire('new-acquire')
    t.lookup.mockClear()
    expect(
      t.call('renew', { epoch: t.lease.epoch, generation: first.generation }, 'stale-renew').status,
    ).toBe(409)
    expect(
      t.call(
        'complete',
        { epoch: t.lease.epoch, generation: first.generation, outcome: 'success' },
        'stale-complete',
      ).status,
    ).toBe(409)
    expect(t.lookup).not.toHaveBeenCalled()
    expect(t.acquire('new-acquire')).toEqual(newer)
  })
  test('identity and generation fences precede even the replay key index', () => {
    const t = setup()
    const first = t.first()
    const index = spyOn((t.lease as unknown as { replays: Map<string, unknown> }).replays, 'has')
    const who = { ...principal, id: 'second', digest: 'b'.repeat(64) }
    expect(
      t.lease.mutate(who, 'acquire', { epoch: t.lease.epoch }, 'other-key', [principal, who]).status,
    ).toBe(409)
    expect(t.call('renew', { epoch: t.lease.epoch, generation: 'stale' }, 'stale-key').status).toBe(409)
    expect(index).not.toHaveBeenCalled()
    t.time(first.expiresAt)
    expect(
      t.call(
        'complete',
        { epoch: t.lease.epoch, generation: first.generation, outcome: 'success' },
        'expired-key',
      ).status,
    ).toBe(409)
    expect(index).not.toHaveBeenCalled()
  })
  test('restart refuses an old epoch before replay', () => {
    const old = setup().first()
    const t = setup()
    expect(t.call('acquire', { epoch: old.epoch }).status).toBe(409)
    expect(t.call('complete', { ...old, outcome: 'success' }, 'complete-key').status).toBe(409)
    expect(t.lookup).not.toHaveBeenCalled()
  })
  for (const change of [
    { id: 'rotated' },
    { digest: 'b'.repeat(64) },
    { audience: 'new-server' },
    { rigs: ['other'] },
    { notBefore: 1 },
    { expiresAt: 999_999 },
  ])
    test(`changed identity ${Object.keys(change).join(',')} cannot replay`, () => {
      const t = setup()
      const first = t.first()
      const who = { ...principal, ...change }
      t.lookup.mockClear()
      expect(
        t.call('renew', { epoch: t.lease.epoch, generation: first.generation }, 'renew-key', who).status,
      ).toBe(409)
      expect(t.lookup).not.toHaveBeenCalled()
      expect(t.acquire('new-key-000').status).toBe(200)
    })
  test('another identity cannot read a live acquire receipt', () => {
    const t = setup()
    const first = t.first()
    const who = { ...principal, id: 'second', digest: 'b'.repeat(64) }
    t.lookup.mockClear()
    expect(
      t.lease.mutate(who, 'acquire', { epoch: t.lease.epoch }, 'test-key-0001', [principal, who]).status,
    ).toBe(409)
    expect(t.lookup).not.toHaveBeenCalled()
    expect(t.acquire().body).toEqual(first)
  })
  test('capacity refuses new effects and retains exact receipts', () => {
    const t = setup()
    const first = t.first()
    const body = { epoch: t.lease.epoch, generation: first.generation }
    for (let i = 1; i < 4096; i++) expect(t.call('renew', body, `renew-${i}`).status).toBe(200)
    expect(t.call('complete', { ...body, outcome: 'success' }, 'complete-key').status).toBe(503)
    expect(t.acquire()).toEqual({ status: 200, body: first })
    expect(t.call('renew', body, 'renew-1').status).toBe(200)
  })
})
