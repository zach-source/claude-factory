import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cursorAllowed, pickAgent } from './cli'
import {
  cursorCap,
  cursorLine,
  cursorMeter,
  cursorVerdict,
  METER_EVERY_MS,
  parseUsage,
  refreshCursorMeter,
} from './cursor-meter'

const NOW = 1_800_000_000_000
const home = () => mkdtempSync(join(tmpdir(), 'cursor-meter-'))
const body = (pct: number | string) => ({
  billingCycleStart: '1',
  billingCycleEnd: '1800500000000',
  planUsage: { totalPercentUsed: pct },
})

test('parseUsage reads the percent and the cycle end, and nothing else', () => {
  expect(parseUsage(body(0.0758), 5)).toEqual({ pct: 0.0758, resetsAt: 1800500000000, at: 5 })
  expect(parseUsage(body('63.5'), 5)?.pct).toBe(63.5)
  for (const bad of [
    null,
    {},
    body(-1),
    body('x'),
    { billingCycleEnd: '1' },
    { planUsage: { totalPercentUsed: 1 } },
  ])
    expect(parseUsage(bad, 5)).toBeUndefined()
  expect(parseUsage({ ...body(1), planUsage: { totalPercentUsed: null } }, 5)).toBeUndefined()
})

test('the cap is 60 unless FACTORY_CURSOR_CAP is a number from 0 to 100', () => {
  expect(cursorCap({})).toBe(60)
  expect(cursorCap({ FACTORY_CURSOR_CAP: '35' })).toBe(35)
  expect(cursorCap({ FACTORY_CURSOR_CAP: '0' })).toBe(0)
  for (const bad of ['101', '-1', 'x', '']) expect(cursorCap({ FACTORY_CURSOR_CAP: bad })).toBe(60)
})

test('a launch may use cursor only with a known meter under the cap', () => {
  const m = (pct: number) => ({ pct, resetsAt: 1, at: 1 })
  expect(cursorVerdict(m(59.99), 60).use).toBe(true)
  expect(cursorVerdict(m(60), 60)).toEqual({ use: false, why: 'the Cursor pool is at 60% (cap 60%)' })
  expect(cursorVerdict(m(0), 0).use).toBe(false)
  expect(cursorVerdict(undefined, 60)).toEqual({
    use: false,
    why: 'the Cursor pool meter is unknown (cap 60%)',
  })
})

test('the status line shows the percent, the cap and the reset, or says the meter is unknown', () => {
  const line = cursorLine({ pct: 0.0758, resetsAt: NOW, at: NOW }, 60)
  expect(line).toStartWith('Cursor: 0.08% of the weekly pool used (cap 60%), resets ')
  expect(cursorLine(undefined, 60)).toContain('meter is unknown (cap 60%)')
})

test('the meter exchanges the key, reads the usage every 5 minutes at most, and writes no key or token', async () => {
  const h = home()
  const calls: [string, Record<string, string>][] = []
  const post = async (url: string, headers: Record<string, string>) => {
    calls.push([url, headers])
    return url.endsWith('exchange_user_api_key') ? { accessToken: 'tok-1' } : body(12.5)
  }
  const env = { CURSOR_API_KEY: 'key-1' }
  await refreshCursorMeter(h, env, NOW, post)
  expect(calls.map(c => c[0])).toEqual([
    'https://api2.cursor.sh/auth/exchange_user_api_key',
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
  ])
  expect(calls[0]![1].Authorization).toBe('Bearer key-1')
  expect(calls[1]![1]).toEqual({ 'Connect-Protocol-Version': '1', Authorization: 'Bearer tok-1' })
  expect(cursorMeter(h, NOW)).toEqual({ pct: 12.5, resetsAt: 1800500000000, at: NOW })
  const text = readFileSync(join(h, 'cursor-meter.json'), 'utf8')
  expect(text).not.toMatch(/key-1|tok-1/)
  await refreshCursorMeter(h, env, NOW + METER_EVERY_MS - 1, post) // too soon
  expect(calls).toHaveLength(2)
  await refreshCursorMeter(h, env, NOW + METER_EVERY_MS, post) // the token from memory: no new exchange
  expect(calls.map(c => c[0].split('/').pop())).toEqual([
    'exchange_user_api_key',
    'GetCurrentPeriodUsage',
    'GetCurrentPeriodUsage',
  ])
})

test('with no key there is no call and no cache', async () => {
  const h = home()
  await refreshCursorMeter(h, {}, NOW, async () => {
    throw new Error('called')
  })
  expect(existsSync(join(h, 'cursor-meter.json'))).toBe(false)
  expect(cursorMeter(h, NOW)).toBeUndefined()
})

test('a failing API keeps the last reading for an hour, then the meter is unknown', async () => {
  const h = home()
  const env = { CURSOR_API_KEY: 'key-2' }
  writeFileSync(
    join(h, 'cursor-meter.json'),
    JSON.stringify({ tried: NOW, reading: { pct: 70, resetsAt: NOW + 1, at: NOW } }),
  )
  const fail = async () => {
    throw new Error('HTTP 500')
  }
  await refreshCursorMeter(h, env, NOW + METER_EVERY_MS, fail)
  expect(cursorMeter(h, NOW + 3_599_000)?.pct).toBe(70)
  expect(cursorMeter(h, NOW + 3_600_001)).toBeUndefined()
  expect(readFileSync(join(h, 'cursor-meter.json'), 'utf8')).toContain(`"tried":${NOW + METER_EVERY_MS}`)
})

const def = {
  name: 'f',
  start: 'a',
  agent: 'claude',
  params: { cursor: 'cursor-agent --force', cursor_share: '1' },
  nodes: { a: { prompt: '', next: { ok: 'done' }, split: { agent: '{cursor}', share: 'cursor_share' } } },
} as unknown as Parameters<typeof pickAgent>[1]

test('a cursor pick that the gate refuses becomes the station agent; a claude pick never asks the gate', () => {
  const asked: string[] = []
  const gate = (use: boolean) => (run: string, node: string) => (asked.push(`${run}/${node}`), use)
  const pin = import.meta.path
  expect(pickAgent('r1', def, 'a', undefined, 'herdr', {}, pin, gate(true))).toBe('cursor-agent --force')
  expect(pickAgent('r1', def, 'a', undefined, 'herdr', {}, pin, gate(false))).toBe('claude')
  expect(pickAgent('r1', def, 'a', { agent: 'cursor-agent' }, 'herdr', {}, pin, gate(false))).toBe('claude')
  expect(asked).toEqual(['r1/a', 'r1/a', 'r1/a'])
  asked.length = 0
  expect(pickAgent('r1', def, 'a', { agent: 'codex' }, 'herdr', {}, pin, gate(false))).toBe('codex')
  expect(asked).toEqual([])
})

test('the gate logs one line why, and keeps its answer for 6 hours so a worker in flight keeps its agent', () => {
  const h = home()
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(cursorAllowed('r1', 'a', {}, NOW, h)).toBe(false) // no meter: unknown
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain(
      'r1 a uses its other agent: the Cursor pool meter is unknown (cap 60%)',
    )
    writeFileSync(
      join(h, 'cursor-meter.json'),
      JSON.stringify({ tried: NOW, reading: { pct: 1, resetsAt: NOW + 1, at: NOW } }),
    )
    expect(cursorAllowed('r1', 'a', {}, NOW + 1000, h)).toBe(false) // kept
    expect(cursorAllowed('r1', 'b', {}, NOW + 1000, h)).toBe(true) // another station
    expect(cursorAllowed('r1', 'a', {}, NOW + 6 * 3_600_000, h)).toBe(false) // the reading is over an hour old
    writeFileSync(
      join(h, 'cursor-meter.json'),
      JSON.stringify({ tried: NOW, reading: { pct: 1, resetsAt: NOW + 1, at: NOW + 12 * 3_600_000 } }),
    )
    expect(cursorAllowed('r1', 'a', {}, NOW + 12 * 3_600_000 + 1, h)).toBe(true) // asked again after 6 hours
    expect(log).toHaveBeenCalledTimes(2) // the second no, at +6h, logs again
  } finally {
    log.mockRestore()
  }
})
