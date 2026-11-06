import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `rigs-edit-cli-${process.pid}`)
const home = join(dir, 'home')
const herdr = join(dir, 'herdr')
const file = () => join(home, 'rigs.json')
const text = () => readFileSync(file(), 'utf8')
const jsonError = (s: string) => {
  try {
    JSON.parse(s)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('text parses')
}
const names = () => JSON.parse(text()).map((r: { name: string }) => r.name)

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(herdr, '#!/bin/sh\nexit 1\n')
  chmodSync(herdr, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...rest } = process.env
  const laptop = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('HERDR_')))
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_NO_KICK: '1',
      FACTORY_SELF_UPDATE: '0',
      FACTORY_HERDR: herdr,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
function repo(name: string) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  return r
}

test('rig add writes the list, replaces a rig by name and refuses a second name for one repo', () => {
  const a = repo('a')
  expect(factory(['rig', 'add', 'x', a]).code).toBe(0)
  expect(text()).toBe(JSON.stringify(JSON.parse(text()), null, 2))
  expect(names()).toEqual(['x'])
  expect(factory(['rig', 'add', 'x', a, '--max', '2']).code).toBe(0)
  expect(names()).toEqual(['x'])
  expect(JSON.parse(text())[0].maxRuns).toBe(2)
  const before = text()
  const dup = factory(['rig', 'add', 'y', a])
  expect(dup.code).not.toBe(0)
  expect(dup.err).toContain('is already rig x')
  expect(text()).toBe(before)
  expect(factory(['rig', 'add', 'z', repo('b')]).code).toBe(0)
  expect(names()).toEqual(['x', 'z'])
})

test('rig rm removes a rig and refuses an unknown name', () => {
  factory(['rig', 'add', 'x', repo('a')])
  factory(['rig', 'add', 'y', repo('b')])
  const rm = factory(['rig', 'rm', 'x'])
  expect(rm.code).toBe(0)
  expect(rm.out).toContain('removed rig x')
  const before = text()
  const bad = factory(['rig', 'rm', 'nope'])
  expect(bad.code).not.toBe(0)
  expect(bad.err).toContain('no rig "nope" (rigs: y)')
  expect(text()).toBe(before)
})

test('an invalid rig file refuses rig add and rig rm, naming the file; the history keeps the old text', () => {
  const a = repo('a')
  factory(['rig', 'add', 'x', a])
  const first = text()
  factory(['rig', 'add', 'x', a, '--max', '3'])
  const hist = join(home, 'rigs-history')
  expect(readdirSync(hist)).toHaveLength(1)
  expect(readFileSync(join(hist, readdirSync(hist)[0]!), 'utf8')).toBe(first)
  writeFileSync(file(), '[{')
  for (const args of [
    ['rig', 'add', 'q', repo('c')],
    ['rig', 'rm', 'x'],
  ]) {
    const r = factory(args)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(file())
    expect(r.err).toContain(`not valid JSON (${jsonError('[{')})`)
  }
  expect(text()).toBe('[{')
  expect(existsSync(`${file()}.lock`)).toBe(false)
})

const hist = () => join(home, 'rigs-history')
const snaps = () => (existsSync(hist()) ? readdirSync(hist()).sort() : [])
function twoEdits() {
  const a = repo('a')
  factory(['rig', 'add', 'x', a])
  const A = text()
  factory(['rig', 'add', 'x', a, '--max', '2'])
  return { a, A, B: text() }
}

test('rig undo restores the earlier file; a second undo reverses it', () => {
  const { A, B } = twoEdits()
  expect(factory(['rig', 'undo']).code).toBe(0)
  expect(text()).toBe(A)
  expect(factory(['rig', 'undo']).code).toBe(0)
  expect(text()).toBe(B)
})

test('rig undo n restores the nth newest snapshot', () => {
  const { a, A } = twoEdits()
  factory(['rig', 'add', 'x', a, '--max', '3'])
  expect(snaps()).toHaveLength(2)
  expect(factory(['rig', 'undo', '2']).code).toBe(0)
  expect(text()).toBe(A)
})

test('rig history lists the newest 20, newest first', () => {
  const a = repo('a')
  for (let i = 0; i < 22; i++) factory(['rig', 'add', 'x', a, '--max', String(i + 1)])
  const r = factory(['rig', 'history'])
  expect(r.code).toBe(0)
  const lines = r.out.trim().split('\n')
  expect(lines).toHaveLength(20)
  const newest = snaps().at(-1)!.replace(/\.json$/, '')
  expect(lines[0]).toBe(`1  ${newest}  1 rigs: x`)
  expect(lines[19]!.startsWith('20  ')).toBe(true)
})

test('rig history shows an unparsable snapshot and says so when there is none', () => {
  expect(factory(['rig', 'history'])).toMatchObject({ code: 0, out: 'no rig history\n' })
  mkdirSync(hist(), { recursive: true })
  writeFileSync(join(hist(), '20260101T000000000Z.json'), '[{')
  expect(factory(['rig', 'history']).out).toBe('1  20260101T000000000Z  not valid JSON\n')
})

test('rig undo refuses a bad n or a bad snapshot and changes nothing', () => {
  twoEdits()
  const before = text()
  const n = snaps().length
  for (const x of ['0', '-1', 'abc', '1.5', '21', '3']) expect(factory(['rig', 'undo', x]).code).not.toBe(0)
  const two = '{"name":"x","repo":"/a","factory":"lifecycle"}'
  for (const body of ['[{', '{}', `[${two},${two}]`]) {
    const bad = join(hist(), '99990101T000000000Z.json')
    writeFileSync(bad, body)
    expect(factory(['rig', 'undo']).code).not.toBe(0)
    rmSync(bad)
  }
  expect(text()).toBe(before)
  expect(snaps()).toHaveLength(n)
  expect(existsSync(`${file()}.lock`)).toBe(false)
})

test('rig undo without history is refused', () => {
  const r = factory(['rig', 'undo'])
  expect(r.code).not.toBe(0)
  expect(existsSync(file())).toBe(false)
})

test('a worker cannot run rig undo or rig history', () => {
  const { B } = twoEdits()
  for (const sub of ['undo', 'history']) {
    const p = Bun.spawnSync([CLI, 'rig', sub], {
      env: { ...process.env, FACTORY_HOME: home, FACTORY_RUN: 'r1', FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1' },
    })
    expect(p.exitCode).not.toBe(0)
  }
  expect(text()).toBe(B)
})
