import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wikiNewFile } from './cli'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('wikiNewFile refuses every entry but a missing name or a one-link regular file', () => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'wnf-'))
  const p = (n: string) => join(dir, n)
  expect(wikiNewFile(p('new'), 'T')).toBe('made')
  expect(readFileSync(p('new'), 'utf8')).toBe('T')
  writeFileSync(p('reg'), 'mine')
  expect(wikiNewFile(p('reg'), 'T')).toBe('kept')
  expect(readFileSync(p('reg'), 'utf8')).toBe('mine')
  symlinkSync(p('gone'), p('dangling'))
  expect(wikiNewFile(p('dangling'), 'T')).toBe('bad')
  expect(existsSync(p('gone'))).toBe(false)
  symlinkSync(p('reg'), p('sym'))
  expect(wikiNewFile(p('sym'), 'T')).toBe('bad')
  linkSync(p('reg'), p('hard'))
  expect(wikiNewFile(p('hard'), 'T')).toBe('bad')
  mkdirSync(p('d'))
  expect(wikiNewFile(p('d'), 'T')).toBe('bad')
  expect(wikiNewFile(p('reg/x'), 'T')).toBe('bad')
  expect(existsSync(p('reg/x'))).toBe(false)
  expect(Bun.spawnSync(['mkfifo', p('fifo')]).exitCode).toBe(0)
  expect(wikiNewFile(p('fifo'), 'T')).toBe('bad')
})
