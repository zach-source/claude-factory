import { expect, mock, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STEPS, fillStep, stepPrompt } from './steps'

mock.module('claude-code', () => ({
  atom: (r: unknown, v: unknown) => ({ r, v }),
  read: () => {},
  update: () => {},
  derive: () => ({}),
  memberOf: () => ({}),
}))
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: () => null, Fragment: 'f' }))
const reg = await import('../mod/hooks/register.tsx')

const cli = '/x/bin/factory'

test('src/steps holds one file for each step and nothing else', () => {
  expect(readdirSync(join(import.meta.dir, 'steps')).sort()).toEqual(STEPS.map(s => `${s}.md`).sort())
})

test('the step files give the prompts the mod has inline today, byte for byte', () => {
  expect(stepPrompt('patrol', { cli, factories: '/x/factories/' })).toBe(reg.PATROL(cli))
  expect(stepPrompt('pm', { cli })).toBe(reg.PM(cli))
  expect(stepPrompt('briefer')).toBe(reg.BRIEFER())
  expect(stepPrompt('reviewer')).toBe(reg.REVIEWER())
})

test('fillStep fills in one pass and fails closed', () => {
  expect(fillStep('a {{x}} b {{x}}', { x: '1' })).toBe('a 1 b 1')
  expect(fillStep('a {{x}}', { x: '{{x}}' })).toBe('a {{x}}')
  expect(fillStep('no placeholders', {})).toBe('no placeholders')
  expect(fillStep('{ {x} } {{ x }} {{x-y}}', {})).toBe('{ {x} } {{ x }} {{x-y}}')
  expect(() => fillStep('a {{x}}', {})).toThrow('{{x}}')
  expect(() => fillStep('a', { x: '1' })).toThrow('{{x}}')
  expect(() => fillStep('{{x}}', { x: '1', y: '2' })).toThrow('{{y}}')
})

test('stepPrompt strips exactly one final newline', () => {
  expect(stepPrompt('briefer').endsWith('\n')).toBe(false)
  expect(stepPrompt('briefer')).toBe(reg.BRIEFER())
})
