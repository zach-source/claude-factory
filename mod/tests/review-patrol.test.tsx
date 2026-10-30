import { expect, mock, test } from 'claude-code/testing'
import { patrol } from '../hooks/view'

// claude-factory-ag2.6: the reviewer's verdict reaches the patrol prompt and the manager's manual.
const SLOW = { timeoutMs: 30_000 }
const NOW = 1_000_000
const sk = {
  key: 'skill:sk:aaaaaaaaaaaa',
  kind: 'skill' as const,
  name: 'sk',
  change: 'new',
  recommendation: 'install' as const,
  why: 'Safe and saves work.',
}
const pr = { key: 'proposal:pr:bbbbbbbbbbbb', kind: 'proposal' as const, name: 'pr', change: 'pending' }
const call = (reviews: Parameters<typeof patrol>[10], seen = new Set<string>(), isDue = false) =>
  patrol([], [], seen, isDue, [], undefined, new Set(), [], undefined, NOW, reviews)

test('a new verdict wakes the patrol alone, names the item, the verdict and why, and returns its key', () => {
  const due = call([sk, pr])
  expect(due).not.toBeNull()
  expect(due!.text).toContain('Proposals to review:')
  expect(due!.text).toContain(
    '- skill sk (new): reviewer says install: Safe and saves work. -> run: factory skills install sk',
  )
  const rej = call([{ ...pr, recommendation: 'reject' as const, why: 'Unsafe.' }])
  expect(rej!.text).toContain('reviewer says reject: Unsafe.')
  expect(rej!.text).not.toContain('-> run')
  expect(call([{ ...pr, recommendation: 'install' as const, why: 'ok' }])!.text).toContain(
    'ok -> run: factory proposals install pr',
  )
  expect(due!.text).toContain('- proposal pr (pending): not reviewed yet')
  expect(due!.text).toContain('reviewer: skill sk is install')
  expect(due!.keys).toEqual([`verdict:${sk.key}`])
})

test('a verdict already in seen is not news: no wake, and the section shows only with another reason to wake', () => {
  const seen = new Set([`verdict:${sk.key}`])
  expect(call([sk, pr], seen)).toBeNull()
  const due = call([sk, pr], seen, true)
  expect(due).toBeNull() // no run is working and no rig has room: still no wake
})

test('items with no verdict are never news', () => {
  expect(call([pr])).toBeNull()
})

test('no reviews: the prompt text has no review section, byte for byte as before', () => {
  const mail = [{ run: 'r1', from: 'implement', text: 'blocked', at: 1 }]
  const before = patrol([], mail, new Set(), false, [], undefined, new Set(), [], undefined, NOW)
  const after = patrol([], mail, new Set(), false, [], undefined, new Set(), [], undefined, NOW, [])
  expect(after!.text).toBe(before!.text)
  expect(after!.text).not.toContain('Proposals to review')
})

test('a review section rides on mail too, with each pending item once', () => {
  const mail = [{ run: 'r1', from: 'implement', text: 'blocked', at: 1 }]
  const due = patrol(
    [],
    mail,
    new Set([`verdict:${sk.key}`]),
    false,
    [],
    undefined,
    new Set(),
    [],
    undefined,
    NOW,
    [sk, pr],
  )
  expect(due!.text).toContain('Proposals to review:')
  expect(due!.text.match(/skill sk/g)).toHaveLength(1)
  expect(due!.text).not.toContain('reviewer: skill sk is install')
})

test('the patrol prompt rule and the manager manual name the reviewer verdict', SLOW, async ($, on) => {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('command.register', () => ({ value: { command: 'factory' } }) as never)
  const registered: { name: string; prompt?: string }[] = []
  on('agent.register', ($, e) => {
    registered.push(e as unknown as { name: string; prompt?: string })
    return { value: { agent: `factory:${(e as unknown as { name: string }).name}` } } as never
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  const rule = registered.find(r => r.name === 'patrol')!.prompt!
  expect(rule).toContain('Proposals to review')
  expect(rule).toContain('reviewer')
  expect(rule).toContain('install or reject')
  expect(rule).toContain('never run')
})
