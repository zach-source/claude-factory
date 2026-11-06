import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, release } from './server'

const dirs: string[] = []
const lease = () => {
  const d = mkdtempSync(join(tmpdir(), 'server-lease-'))
  dirs.push(d)
  return join(d, 'server-lease.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('claim takes a missing lease and renews its own', () => {
  const f = lease()
  expect(claim(f, 'a', 1000, 500)).toEqual({ held: true, lease: { holder: 'a', until: 1500 } })
  expect(claim(f, 'a', 1200, 500).held).toBe(true)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ holder: 'a', until: 1700 })
})

test('claim leaves a live lease of another holder unchanged', () => {
  const f = lease()
  claim(f, 'a', 1000, 500)
  const before = readFileSync(f, 'utf8')
  expect(claim(f, 'b', 1499, 500)).toEqual({ held: false, lease: { holder: 'a', until: 1500 } })
  expect(readFileSync(f, 'utf8')).toBe(before)
})

test('claim takes an expired lease (until <= now)', () => {
  const f = lease()
  claim(f, 'a', 1000, 500)
  expect(claim(f, 'b', 1500, 500).held).toBe(true)
  expect(JSON.parse(readFileSync(f, 'utf8')).holder).toBe('b')
})

test('a corrupt lease counts as live until its mtime is older than ttl', () => {
  const f = lease()
  writeFileSync(f, '{not json')
  const now = Date.now()
  expect(claim(f, 'b', now, 60_000).held).toBe(false)
  expect(readFileSync(f, 'utf8')).toBe('{not json')
  const old = new Date(now - 120_000)
  utimesSync(f, old, old)
  expect(claim(f, 'b', now, 60_000).held).toBe(true)
})

test('release removes only its own lease and never throws', () => {
  const f = lease()
  claim(f, 'a', 1000, 500)
  release(f, 'b')
  expect(existsSync(f)).toBe(true)
  release(f, 'a')
  expect(existsSync(f)).toBe(false)
  release(f, 'a')
})
