import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJson } from './cli'
import { writeFresh } from './write-fresh'

const dirs: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'write-fresh-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('e0qu AC3 stale temp mode: writeJson target ends with mode 0600', () => {
  const d = fresh()
  const f = join(d, 'state.json')
  writeFileSync(`${f}.tmp`, 'stale')
  chmodSync(`${f}.tmp`, 0o644)
  writeJson(f, { a: 1 })
  expect(statSync(f).mode & 0o777).toBe(0o600)
  expect(existsSync(`${f}.tmp`)).toBe(false)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ a: 1 })
})

test('e0qu AC4 symlink at the temp name: the victim keeps its text', () => {
  const d = fresh()
  const f = join(d, 'state.json')
  const victim = join(d, 'victim.txt')
  writeFileSync(victim, 'keep')
  symlinkSync(victim, `${f}.tmp`)
  writeJson(f, { a: 1 })
  expect(lstatSync(f).isFile()).toBe(true)
  expect(readFileSync(victim, 'utf8')).toBe('keep')
  expect(existsSync(`${f}.tmp`)).toBe(false)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ a: 1 })
})

test('e0qu AC7 a directory at the temp name fails closed', () => {
  const d = fresh()
  const f = join(d, 'x.json')
  writeFileSync(f, 'old')
  mkdirSync(`${f}.tmp`)
  expect(() => writeFresh(f, 'new')).toThrow()
  expect(readFileSync(f, 'utf8')).toBe('old')
  expect(lstatSync(`${f}.tmp`).isDirectory()).toBe(true)
})

test('e0qu AC8 a fresh write has mode 0600, leaves no temp file and a second write replaces the text', () => {
  const d = fresh()
  const f = join(d, 'y.json')
  writeFresh(f, 'one')
  expect(statSync(f).mode & 0o777).toBe(0o600)
  expect(existsSync(`${f}.tmp`)).toBe(false)
  writeFresh(f, 'two')
  expect(readFileSync(f, 'utf8')).toBe('two')
})
