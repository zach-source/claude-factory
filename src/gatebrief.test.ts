import { expect, test } from 'bun:test'
import { clipBrief, gateKey } from './gatebrief'

test('gateKey names one gate visit by run id and startedAt', () => {
  expect(gateKey('lifecycle-abc', 0)).toBe('gate:lifecycle-abc@0')
  expect(gateKey('lifecycle-abc', 1700000000000)).toBe('gate:lifecycle-abc@1700000000000')
  // two different visits of the same run (a restart that re-enters the gate) get different keys
  expect(gateKey('r1', 1)).not.toBe(gateKey('r1', 2))
})

test('clipBrief drops blank lines, trims each line, and keeps at most 8', () => {
  const raw = ['  first  ', '', '  ', 'second', 'third'].join('\n')
  expect(clipBrief(raw)).toBe('first\nsecond\nthird')
  const nineLines = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')
  const kept = clipBrief(nineLines).split('\n')
  expect(kept).toHaveLength(8)
  expect(kept[0]).toBe('line 1')
  expect(kept.at(-1)).toBe('line 8') // oldest first: line 9 is dropped, not line 1
})

test('clipBrief shortens an over-long line to maxLineLen, with an ellipsis mark', () => {
  const long = 'x'.repeat(250)
  const out = clipBrief(long, 8, 200)
  expect(out.length).toBe(200)
  expect(out).not.toBe('x'.repeat(200)) // the last character is the ellipsis mark, not an "x"
  expect(out.slice(0, 199)).toBe('x'.repeat(199))
})

test('clipBrief strips C0 control characters (a NUL, a BEL), keeping the visible text', () => {
  const dirty = 'safe\x07text\x00and more'
  expect(clipBrief(dirty)).toBe('safetextand more')
})

test('clipBrief returns empty for text that is only blank lines or control characters', () => {
  expect(clipBrief('')).toBe('')
  expect(clipBrief('   \n\n\t\t\n')).toBe('')
  expect(clipBrief('\x00\x07')).toBe('')
})
