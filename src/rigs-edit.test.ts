import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editRigs } from './rigs-edit'

const dir = join(tmpdir(), `rigs-edit-${process.pid}`)
const file = join(dir, 'rigs.json')
const hist = join(dir, 'rigs-history')
const rig = (n: string, repo = `/r/${n}`) => ({ name: n, repo })

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** nothing changed: same bytes (or no file), no snapshot, no lock */
function untouched(before: string | undefined) {
  expect(existsSync(file) ? readFileSync(file, 'utf8') : undefined).toBe(before)
  expect(existsSync(hist)).toBe(false)
  expect(existsSync(`${file}.lock`)).toBe(false)
}

test('parallel writers lose no change', async () => {
  const mod = join(import.meta.dir, 'rigs-edit.ts')
  const code = (i: number) =>
    `import { editRigs } from ${JSON.stringify(mod)}
editRigs(${JSON.stringify(file)}, rigs => { Bun.sleepSync(50); return [...rigs, { name: 'r${i}', repo: '/r/${i}' }] }, { waitMs: 30000 })`
  const kids = Array.from({ length: 8 }, (_, i) => Bun.spawn(['bun', '-e', code(i)], { stderr: 'pipe' }))
  expect(await Promise.all(kids.map(k => k.exited))).toEqual(Array(8).fill(0))
  const names = JSON.parse(readFileSync(file, 'utf8')).map((r: { name: string }) => r.name)
  expect(names.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `r${i}`).sort())
})

test('invalid JSON refuses and names the file', () => {
  for (const [text, msg] of [
    ['[{', 'not valid JSON'],
    ['{}', 'not a JSON array'],
  ] as const) {
    writeFileSync(file, text)
    expect(() => editRigs(file, r => r)).toThrow(file)
    expect(() => editRigs(file, r => r)).toThrow(msg)
    untouched(text)
  }
})

test('the history keeps 20', () => {
  const texts: string[] = []
  for (let i = 0; i < 25; i++) {
    if (existsSync(file)) texts.push(readFileSync(file, 'utf8'))
    editRigs(file, r => [...r, rig(`r${i}`)])
  }
  const files = readdirSync(hist)
    .filter(f => f.endsWith('.json'))
    .sort()
  expect(files).toHaveLength(20)
  expect(readFileSync(join(hist, files[19]!), 'utf8')).toBe(texts[23]!)
  expect(readFileSync(join(hist, files[0]!), 'utf8')).toBe(texts[4]!)
})

test('a failed edit changes nothing', () => {
  editRigs(file, () => [rig('a')])
  const before = readFileSync(file, 'utf8')
  rmSync(hist, { recursive: true, force: true })
  const bad: Array<() => unknown> = [
    () => {
      throw new Error('boom')
    },
    () => ({}),
    () => [{ repo: '/x' }],
    () => [{ name: 'x' }],
    () => [{ name: '', repo: '/x' }],
    () => [{ name: 'x', repo: '' }],
    () => [rig('a'), rig('a', '/other')],
    () => [rig('a'), rig('b', '/r/a')],
  ]
  for (const fn of bad) {
    expect(() => editRigs(file, fn as never)).toThrow()
    untouched(before)
  }
})

test('a missing file reads as [] and makes no snapshot', () => {
  expect(editRigs(file, r => [...r, rig('a')])).toEqual([rig('a')])
  expect(existsSync(hist)).toBe(false)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([rig('a')])
})

test('a stale lock is broken', () => {
  mkdirSync(`${file}.lock`)
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.lock`, old, old)
  editRigs(file, () => [rig('a')])
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([rig('a')])
  expect(existsSync(`${file}.lock`)).toBe(false)
})

test('a fresh lock makes the edit wait, then refuse, and stays', () => {
  editRigs(file, () => [rig('a')])
  const before = readFileSync(file, 'utf8')
  mkdirSync(`${file}.lock`)
  const t = Date.now()
  expect(() => editRigs(file, () => [], { waitMs: 300 })).toThrow(`${file}.lock`)
  expect(Date.now() - t).toBeGreaterThanOrEqual(300)
  expect(existsSync(`${file}.lock`)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(before)
})
