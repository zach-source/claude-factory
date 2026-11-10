// claude-factory-y3f8w.3: the manager's limit is recorded when no account is free, and cleared when it is served
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearManagerLimit, managerLimited, recordManagerLimit } from './cli'

const home = () => mkdtempSync(join(tmpdir(), 'mlimit-'))

test('a recorded manager limit holds until it lifts, then clears', () => {
  const h = home()
  const now = Date.now()
  expect(managerLimited(now, h)).toBeNull()
  recordManagerLimit({ at: now, kind: 'seven_day', resetsAt: now + 60_000 }, h)
  expect(managerLimited(now, h)).toEqual({ kind: 'seven_day', until: now + 60_000 })
  expect(managerLimited(now + 61_000, h)).toBeNull() // lifted
  clearManagerLimit(h)
  expect(managerLimited(now, h)).toBeNull()
  clearManagerLimit(h) // none: no error
})

test('a limit with no known reset holds for a short time', () => {
  const h = home()
  const now = Date.now()
  recordManagerLimit({ at: now, kind: 'usage', resetsAt: 0 }, h)
  expect(managerLimited(now + 60_000, h)?.kind).toBe('usage')
  expect(managerLimited(now + 3600_000, h)).toBeNull()
})
