// claude-factory-sg4s3: a tick that read halt.json before `factory resume` must not write its stale copy back.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'halt-race-'))
process.env.FACTORY_HOME = home
const { writeHaltIfSame } = await import('./cli')
const halt = join(home, 'halt.json')
const stale = { state: 'paused' as const, at: 100, told: {}, closed: {} }

test('a stale tick write after resume does not bring halt.json back', () => {
  writeFileSync(halt, JSON.stringify(stale))
  rmSync(halt) // factory resume removes it between the tick's read and its write
  writeHaltIfSame(stale)
  expect(existsSync(halt)).toBe(false)
})

test('a stale tick write does not replace a newer stop', () => {
  writeFileSync(halt, JSON.stringify({ ...stale, at: 200, state: 'stopping' }))
  writeHaltIfSame(stale)
  expect(JSON.parse(readFileSync(halt, 'utf8')).at).toBe(200)
})

test('a tick write still lands while halt.json is the one it read', () => {
  writeFileSync(halt, JSON.stringify(stale))
  writeHaltIfSame(stale, { ...stale, closed: { r1: 1 } })
  expect(JSON.parse(readFileSync(halt, 'utf8')).closed).toEqual({ r1: 1 })
  rmSync(home, { recursive: true, force: true })
})
