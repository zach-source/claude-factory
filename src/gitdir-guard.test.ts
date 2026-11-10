// gitDirSnapshot() and gitDirKept() (claude-factory-f1zc): the control area of .git comes back after a change.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDirKept, gitDirSnapshot } from './cli'

const dir = join(tmpdir(), `gitdir-guard-${process.pid}`)
const g = (...p: string[]) => join(dir, 'r', '.git', ...p)
let snap: ReturnType<typeof gitDirSnapshot>

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'r'), { recursive: true })
  expect(Bun.spawnSync(['git', 'init', '-q', join(dir, 'r')]).exitCode).toBe(0)
  writeFileSync(join(dir, 'r', 'page.md'), 'x')
  snap = gitDirSnapshot(join(dir, 'r'))
  expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
})
afterAll(() => {
  for (const p of ['hooks', 'info/z']) if (existsSync(g(p))) chmodSync(g(p), 0o755)
  rmSync(dir, { recursive: true, force: true })
})
const kept = () => gitDirKept(join(dir, 'r'), snap)
const mode = (p: string) => lstatSync(p).mode & 0o7777

test('1 no change', () => expect(kept()).toBe('same'))

test('2 one changed byte in config', () => {
  const was = readFileSync(g('config'))
  writeFileSync(g('config'), 'x' + was.toString().slice(1))
  expect(kept()).toBe('changed')
  expect(readFileSync(g('config'))).toEqual(was)
})

test('3 a new file in hooks', () => {
  writeFileSync(g('hooks', 'post-commit'), '#!/bin/sh\n')
  expect(kept()).toBe('changed')
  expect(existsSync(g('hooks', 'post-commit'))).toBe(false)
})

test('4 a removed description comes back with its mode', () => {
  const m = mode(g('description'))
  rmSync(g('description'))
  expect(kept()).toBe('changed')
  expect(mode(g('description'))).toBe(m)
})

test('5 config replaced by a symlink', () => {
  const was = readFileSync(g('config'))
  rmSync(g('config'))
  symlinkSync(join(dir, 'r', 'page.md'), g('config'))
  expect(kept()).toBe('changed')
  expect(lstatSync(g('config')).isFile()).toBe(true)
  expect(readFileSync(g('config'))).toEqual(was)
})

test('6 config replaced by a hard link', () => {
  rmSync(g('config'))
  linkSync(join(dir, 'r', 'page.md'), g('config'))
  expect(kept()).toBe('changed')
  expect(lstatSync(g('config')).nlink).toBe(1)
})

test('7 a fifo in info', () => {
  Bun.spawnSync(['mkfifo', g('info', 'f')])
  expect(kept()).toBe('changed')
  expect(existsSync(g('info', 'f'))).toBe(false)
})

test('8 a changed dir mode comes back', () => {
  chmodSync(g('hooks'), 0o700)
  expect(kept()).toBe('changed')
  expect(mode(g('hooks'))).toBe(0o755)
})

test('8b unreadable dirs are chmoded and the sweep goes on', () => {
  mkdirSync(g('info', 'z'), { mode: 0o000 })
  chmodSync(g('hooks'), 0o000)
  expect(kept()).toBe('changed')
  expect(existsSync(g('info', 'z'))).toBe(false)
  expect(mode(g('hooks'))).toBe(0o755)
})

test('9 data set paths do not count', () => {
  writeFileSync(g('objects', 'x'), 'x')
  writeFileSync(g('refs', 'heads', 'x'), 'x')
  mkdirSync(g('logs'), { recursive: true })
  writeFileSync(g('logs', 'x'), 'x')
  for (const f of ['index', 'HEAD', 'gc.log', 'config.lock']) writeFileSync(g(f), 'x')
  expect(kept()).toBe('same')
})

test('10 .git replaced by a file fences the dir', () => {
  rmSync(g(), { recursive: true })
  writeFileSync(g(), 'gitdir: elsewhere\n')
  expect(kept()).toBe('restore failed')
  expect(existsSync(join(dir, 'r.fenced'))).toBe(true)
})

test('11 a dir named *.lock is in the control area', () => {
  mkdirSync(g('worktrees', 'a.lock'), { recursive: true })
  writeFileSync(g('worktrees', 'a.lock', 'config'), 'x')
  expect(kept()).toBe('changed')
  expect(existsSync(g('worktrees', 'a.lock'))).toBe(false)
})

test('12 a nested .git is removed', () => {
  mkdirSync(join(dir, 'r', 'sub'))
  writeFileSync(join(dir, 'r', 'sub', '.GIT'), 'gitdir: g\n')
  expect(kept()).toBe('changed')
  expect(existsSync(join(dir, 'r', 'sub', '.GIT'))).toBe(false)
})
