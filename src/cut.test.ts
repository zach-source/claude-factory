import { expect, test } from 'bun:test'
import { cut } from './cut'
import { clipBrief } from './gatebrief'
import { clip } from './hygiene'

const lone = /[\uD800-\uDBFF]$/
test('cut leaves no lone high surrogate', () => {
  expect(cut('a'.repeat(199) + '😀', 200)).toBe('a'.repeat(199))
  expect(cut('a'.repeat(198) + '😀', 200)).toBe('a'.repeat(198) + '😀')
  expect(cut('abc', 10)).toBe('abc')
  expect(cut('😀', 0)).toBe('')
})
test('exported callers use cut', () => {
  expect(clip('a'.repeat(119) + '😀', 120)).not.toMatch(lone)
  expect(clipBrief('a'.repeat(198) + '😀')).not.toMatch(/[\uD800-\uDBFF]…$/)
})

test('cli clip, clipReport and worker diedText use cut', async () => {
  const { clipReport } = await import('./cli')
  const { diedText } = await import('./worker')
  expect(clipReport('a'.repeat(31_999) + '😀' + 'b')).not.toMatch(/[\uD800-\uDBFF]\n\[clipped/)
  expect(diedText(new Error('a'.repeat(499) + '😀'))).not.toMatch(/[\uD800-\uDBFF]\n/)
})

test('mod cutText leaves no lone high surrogate', async () => {
  const { cutText, line } = await import('../mod/hooks/view')
  expect(line('a'.repeat(9) + '😀' + 'b', 11)).toBe('a'.repeat(9) + '…')
  expect(cutText('a'.repeat(599) + '😀', 600)).toBe('a'.repeat(599))
  expect(cutText('abc', 10)).toBe('abc')
})
