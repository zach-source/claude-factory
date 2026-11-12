import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grokAllowed, pickAgent } from './cli'
import { grokBudget, grokLine, grokSpent, grokVerdict, logGrokSpend, WEEK_MS } from './grok-meter'
import type { Usage } from './metrics'

const NOW = 1_800_000_000_000
const home = () => mkdtempSync(join(tmpdir(), 'grok-meter-'))
const row = (node: string, costMicro?: number): Usage => ({
  ...{ node, seq: 1, session: 's', model: 'grok-4.7', input: 5, cacheWrite: 0, cacheRead: 3, output: 2 },
  ...{ turns: 1, peak: 8, ...(costMicro && { costMicro }) },
})

test('the spend logs each costed row, sums the last 7 days and skips bad lines', () => {
  const h = home()
  expect(grokSpent(h, NOW)).toBe(0)
  logGrokSpend(h, 'r1', [row('plan', 1_500_000), row('verify')], NOW - WEEK_MS - 1) // too old
  logGrokSpend(h, 'r1', [row('plan', 1_500_000), row('verify')], NOW - 1000)
  logGrokSpend(h, 'r2', [row('implement', 250_000)], NOW)
  expect(readFileSync(join(h, 'grok-spend.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
  expect(JSON.parse(readFileSync(join(h, 'grok-spend.jsonl'), 'utf8').split('\n')[0]!)).toEqual({
    ...{ at: NOW - WEEK_MS - 1, run: 'r1', node: 'plan', costMicro: 1_500_000, tokens: 10 },
  })
  expect(grokSpent(h, NOW)).toBe(1.75) // 1.5 + 0.25 in the week
})

test('the budget reads a number from the env, and the verdict gates only with a budget', () => {
  expect(grokBudget({})).toBeUndefined()
  expect(grokBudget({ FACTORY_GROK_WEEKLY_BUDGET_USD: ' 12.5 ' })).toBe(12.5)
  expect(grokBudget({ FACTORY_GROK_WEEKLY_BUDGET_USD: 'lots' })).toBeUndefined()
  expect(grokVerdict(99, undefined).use).toBe(true)
  expect(grokVerdict(9.99, 10).use).toBe(true)
  expect(grokVerdict(10, 10).use).toBe(false)
  expect(grokVerdict(10, 10).why).toContain('$10.00 (budget $10)')
  expect(grokLine(1.234)).toBe('Grok: $1.23 this week')
  expect(grokLine(1.234, 10)).toBe('Grok: $1.23 this week (budget $10)')
})

const def = {
  name: 'f',
  start: 'a',
  agent: 'claude',
  params: { grok: 'grok -m x', grok_share: '1' },
  nodes: { a: { prompt: '', next: { ok: 'done' }, split: { agent: '{grok}', share: 'grok_share' } } },
} as unknown as Parameters<typeof pickAgent>[1]

test('a grok pick that the gate refuses becomes the station agent; a claude pick never asks the gate', () => {
  const asked: string[] = []
  const gate = (use: boolean) => (run: string, node: string) => (asked.push(`${run}/${node}`), use)
  const pin = import.meta.path
  const never = gate(true)
  expect(pickAgent('r1', def, 'a', undefined, 'herdr', {}, pin, never, gate(true))).toBe('grok -m x')
  expect(pickAgent('r1', def, 'a', undefined, 'herdr', {}, pin, never, gate(false))).toBe('claude')
  expect(pickAgent('r1', def, 'a', { agent: 'grok' }, 'herdr', {}, pin, never, gate(false))).toBe('claude')
  expect(asked).toEqual(['r1/a', 'r1/a', 'r1/a'])
  asked.length = 0
  expect(pickAgent('r1', def, 'a', { agent: 'codex' }, 'herdr', {}, pin, never, gate(false))).toBe('codex')
  expect(asked).toEqual([])
})

test('the gate is open without a budget; with one it logs why, and keeps its answer for 6 hours', () => {
  const h = home()
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const env = { FACTORY_GROK_AUTH: 'key', FACTORY_GROK_WEEKLY_BUDGET_USD: '2' }
  try {
    logGrokSpend(h, 'r1', [row('plan', 1_000_000)], NOW)
    expect(grokAllowed('r1', 'a', { FACTORY_GROK_AUTH: 'key' }, NOW, h)).toBe(true) // no budget
    expect(grokAllowed('r1', 'a', env, NOW, h)).toBe(true) // $1 of $2
    logGrokSpend(h, 'r1', [row('plan', 1_500_000)], NOW)
    expect(grokAllowed('r1', 'a', env, NOW + 1000, h)).toBe(true) // kept
    expect(grokAllowed('r1', 'b', env, NOW + 1000, h)).toBe(false) // another station sees $2.50
    // other tests in this process can log too: read the gate's own lines
    const lines = () => log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('grok gate'))
    expect(lines()[0]).toContain(
      'grok gate: r1 b uses its other agent: the Grok spend of the last 7 days is $2.50 (budget $2)',
    )
    expect(grokAllowed('r1', 'a', env, NOW + 6 * 3_600_000, h)).toBe(false) // asked again after 6 hours
    expect(lines()).toHaveLength(2)
  } finally {
    log.mockRestore()
  }
})
