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

test('mod cutText leaves no lone high surrogate', async () => {
  const { cutText } = await import('../mod/hooks/view')
  expect(cutText('a'.repeat(599) + '😀', 600)).toBe('a'.repeat(599))
  expect(cutText('abc', 10)).toBe('abc')
})
