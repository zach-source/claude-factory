// claude-factory-gf16e.1 and .3: agents.order moves a refused or limited station to the next harness
import { expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentsOrder, clearHarnessLimit, harnessLimited, pickAgent, recordHarnessLimit } from './cli'
import type { Harness } from './harness'

const def = {
  name: 'f',
  start: 'a',
  agent: 'claude --model x',
  params: { codex: 'codex', grok: 'grok', pi: 'pi', cursor: 'cursor-agent', share: '1', cshare: '1' },
  nodes: {
    a: { prompt: '', next: { ok: 'done' }, split: { agent: '{codex} -m y', share: 'share' } },
    b: { prompt: '', next: { ok: 'done' }, split: { agent: '{cursor}', share: 'cshare' } },
  },
} as unknown as Parameters<typeof pickAgent>[1]
const pin = import.meta.path // a file that exists: the host has the codex pin
const yes = () => true
const no = () => false
const pick = (o: {
  node?: string
  env?: Record<string, string>
  limited?: Harness[]
  rig?: object
  home?: string
  grok?: boolean
}) =>
  pickAgent(
    'run-1',
    def,
    o.node ?? 'a',
    o.rig,
    'herdr',
    o.env ?? {},
    pin,
    yes,
    o.grok === false ? no : yes,
    h => (o.limited ?? []).includes(h),
    1000,
    o.home ?? mkdtempSync(join(tmpdir(), 'order-')),
  )

test('the default order is claude, codex, grok, pi; cursor is in it only when named', () => {
  expect(agentsOrder({})).toEqual(['claude', 'codex', 'grok', 'pi'])
  expect(agentsOrder({ FACTORY_AGENTS_ORDER: 'grok,cursor,bogus' })).toEqual(['grok', 'cursor'])
})

test('the share picks first; a limited pick moves to the first free harness of the order', () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(pick({})).toBe('codex -m y')
    expect(pick({ limited: ['codex'] })).toBe('claude --model x')
    expect(pick({ limited: ['codex', 'claude'] })).toBe('grok')
    // pi has no deny hook yet: it is never a move target (claude-factory-gf16e.5)
    expect(pick({ limited: ['codex', 'claude'], grok: false })).toBe('codex -m y')
    expect(pick({ limited: ['codex', 'claude'], env: { FACTORY_AGENTS_ORDER: 'cursor' } })).toBe(
      'cursor-agent',
    )
    // a rig's MCP servers reach only claude and codex
    expect(pick({ limited: ['codex', 'claude'], rig: { mcp: '/m.json' } })).toBe('codex -m y')
    // a rig's agent pins its harness
    expect(pick({ limited: ['codex', 'claude'], rig: { agent: 'codex' } })).toBe('codex')
    expect(log.mock.calls.flat().join('\n')).toContain(
      'order gate: run-1 a moves from codex to claude: usage limit',
    )
  } finally {
    log.mockRestore()
  }
})

test('cursor refused by its gate moves along the order; FACTORY_AX_GROK gates grok on ax', () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const p = (env: Record<string, string>, limited: Harness[]) =>
      pickAgent(
        'run-1',
        def,
        'b',
        undefined,
        'ax',
        env,
        pin,
        no,
        yes,
        h => limited.includes(h),
        1000,
        tmpdir(),
      )
    expect(p({ FACTORY_AX_CODEX: '1' }, [])).toBe('claude --model x')
    expect(p({ FACTORY_AX_CODEX: '1' }, ['claude'])).toBe('codex')
    expect(p({}, ['claude'])).toBe('claude --model x') // nothing free: the own agent waits out its limit
    expect(p({ FACTORY_AX_GROK: '1' }, ['claude'])).toBe('grok')
  } finally {
    log.mockRestore()
  }
})

test('a pick sticks in the run dir, so a worker in flight keeps its harness when a limit lands', () => {
  const home = mkdtempSync(join(tmpdir(), 'order-'))
  mkdirSync(join(home, 'runs', 'run-1'), { recursive: true })
  expect(pick({ home })).toBe('codex -m y')
  expect(pick({ home, limited: ['codex'] })).toBe('codex -m y')
  expect(readFileSync(join(home, 'runs', 'run-1', 'order-gate.json'), 'utf8')).toContain('"use": "codex"')
})

test('a recorded limit holds until it lifts', () => {
  const home = mkdtempSync(join(tmpdir(), 'order-'))
  recordHarnessLimit('ax', 'claude', 5000, home)
  recordHarnessLimit('ax', 'codex', 9000, home)
  expect(harnessLimited('ax', 'claude', 4000, home)).toBe(true)
  expect(harnessLimited('ax', 'claude', 6000, home)).toBe(false)
  expect(harnessLimited('ax', 'codex', 6000, home)).toBe(true)
  expect(harnessLimited('herdr', 'codex', 6000, home)).toBe(false)
})

test('clearHarnessLimit drops only the named harness entry', () => {
  const home = mkdtempSync(join(tmpdir(), 'order-'))
  const far = Date.now() + 3600_000
  recordHarnessLimit('ax', 'claude', far, home)
  recordHarnessLimit('ax', 'codex', far, home)
  clearHarnessLimit('ax', 'claude', home)
  expect(harnessLimited('ax', 'claude', Date.now(), home)).toBe(false)
  expect(harnessLimited('ax', 'codex', Date.now(), home)).toBe(true)
  clearHarnessLimit('herdr', 'claude', home) // no file: no error
})
