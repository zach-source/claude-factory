// claude-factory-y3f8w.5: FACTORY_PATROL=1 refuses in core what the Claude patrol-guard hook refuses, for any harness
import { expect, test } from 'bun:test'
import { patrolBdRefusal, patrolRefusal } from './core/caller'

const P = { FACTORY_PATROL: '1' }

test('a patrol refuses the gated kinds, a skill install and a decision answer', () => {
  for (const [cmd, args] of [
    ['decide', ['x']],
    ['skills', ['install', 's']],
    ['skills', ['reject', 's', 'why']],
    ['proposals', ['install', 'p']],
    ['token', ['rotate']],
    ['settings', ['set', 'a', 'b']],
  ] as const)
    expect(patrolRefusal(cmd, [...args], P)).toContain('a patrol cannot')
})

test('a patrol keeps its reads and its own verbs; with no FACTORY_PATROL nothing is refused', () => {
  expect(patrolRefusal('mail', ['r1', 'hi'], P)).toBeUndefined()
  expect(patrolRefusal('skills', [], P)).toBeUndefined()
  expect(patrolRefusal('start', ['r', 'bd-1'], P)).toBeUndefined()
  expect(patrolRefusal('decide', ['x'], {})).toBeUndefined()
})

test('the bd shim of a patrol refuses what bdWrite refuses and allows a read', () => {
  expect(patrolBdRefusal(['show', 'x-1'])).toBeUndefined()
  expect(patrolBdRefusal(['comments', 'add', 'x-1', '-f', 'a.txt'])).toBeUndefined()
  expect(patrolBdRefusal(['update', 'x-1', '--set-metadata', 'a=b'])).toContain('subagent')
  expect(patrolBdRefusal(['update', 'x-1', '--add-label', 'hold:x'])).toContain('subagent')
  expect(patrolBdRefusal(['close', 'x-1'])).toContain('subagent')
  expect(patrolBdRefusal(['show', '$(id)'])).toBeUndefined() // quoted as one literal argument
})
