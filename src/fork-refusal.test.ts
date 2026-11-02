// forkRefusal: a fork may start only when its source run is over or an ABORT is its last queued route event.
import { expect, test } from 'bun:test'
import { forkRefusal } from './cli'
import type { Ev } from './machine'

type T = 'ABORT' | 'GOTO' | 'RETRY' | 'MAIL'
const ev = (type: T): Ev =>
  type === 'GOTO'
    ? { type, node: 'plan', at: 1 }
    : type === 'MAIL'
      ? { type, from: 'manager', to: 'implement', text: 'x', at: 1 }
      : { type, at: 1 }

const allowed: [string, T[]][] = [
  ['done', []],
  ['aborted', []],
  ['implement', ['ABORT']],
  ['done', ['GOTO', 'ABORT']],
  ['implement', ['GOTO', 'ABORT']],
  ['implement', ['RETRY', 'ABORT']],
  ['implement', ['ABORT', 'MAIL']],
]
const refused: [string, T[]][] = [
  ['triage', []],
  ['implement', ['MAIL']],
  ['implement', ['ABORT', 'GOTO']],
  ['implement', ['ABORT', 'RETRY']],
  ['review', ['GOTO']],
  ['done', ['GOTO']],
  ['aborted', ['ABORT', 'GOTO']],
  ['verify', []],
  ['', []],
]

test.each(allowed)('fork of %s with %p queued is allowed', (node, types) => {
  expect(forkRefusal(node, types.map(ev))).toBeUndefined()
})

test.each(refused)('fork of %s with %p queued is refused', (node, types) => {
  const why = forkRefusal(node, types.map(ev))
  expect(why).toBeString()
  expect(why).toContain(`live at ${node}`)
})
