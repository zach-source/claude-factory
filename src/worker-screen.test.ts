// claude-factory-hpmc.3: `factory worker screen` reads the tail of the harness stream, never the whole file
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { screen } from './worker'

describe('worker screen', () => {
  let dir: string
  const saved = { ...process.env }
  const stream = (h: string) => join(dir, `${h}.jsonl`)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wscreen-'))
    process.env.FACTORY_WORKER_DIR = dir
    delete process.env.FACTORY_HARNESS
  })
  afterEach(() => {
    process.env = { ...saved }
    rmSync(dir, { recursive: true, force: true })
  })

  test('worker screen stream: each harness reads its own stream, an absent harness reads claude', () => {
    for (const h of ['claude', 'codex', 'cursor', 'grok', 'pi']) writeFileSync(stream(h), `screen of ${h}`)
    for (const h of ['claude', 'codex', 'cursor', 'grok', 'pi']) {
      process.env.FACTORY_HARNESS = h
      expect(screen()).toBe(`screen of ${h}`)
    }
    delete process.env.FACTORY_HARNESS
    expect(screen()).toBe('screen of claude')
  })

  test('an empty regular stream succeeds; no stream gives a reason', () => {
    writeFileSync(stream('claude'), '')
    expect(screen()).toBe('')
    rmSync(stream('claude'))
    expect(() => screen()).toThrow('no stream')
  })

  test('worker screen bounded read: the last 65536 bytes, ASCII and multibyte', () => {
    for (const n of [65535, 65536, 65537, 500_000]) {
      writeFileSync(stream('claude'), 'a'.repeat(n - 3) + 'END')
      const got = screen()
      expect(Buffer.byteLength(got)).toBe(Math.min(n, 65536))
      expect(got.endsWith('aaEND')).toBe(true)
    }
    // 3-byte characters: the cut lands inside one; its partial prefix is dropped, not shown as U+FFFD
    for (const pad of ['', 'x', 'xx']) {
      writeFileSync(stream('claude'), '€'.repeat(40000) + pad + 'END')
      const got = screen()
      expect(got.includes('�')).toBe(false)
      expect(Buffer.byteLength(got)).toBeLessThanOrEqual(65536)
      expect(Buffer.byteLength(got)).toBeGreaterThan(65533)
      expect(got.endsWith('€' + pad + 'END')).toBe(true)
    }
  })

  test('reads at most 65536 bytes of a file that is far larger', () => {
    const big = Buffer.alloc(200_000_000, 0x61)
    big.write('END', big.length - 3)
    writeFileSync(stream('claude'), big)
    const t0 = performance.now()
    expect(Buffer.byteLength(screen())).toBe(65536)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  test('rejects an unknown harness, a symlink, a directory and a FIFO', () => {
    writeFileSync(join(dir, 'real'), 'secret')
    writeFileSync(join(dir, 'evil.jsonl'), 'secret')
    process.env.FACTORY_HARNESS = 'evil'
    expect(() => screen()).toThrow('harness')
    process.env.FACTORY_HARNESS = 'claude'
    symlinkSync(join(dir, 'real'), stream('claude'))
    expect(() => screen()).toThrow('not a regular file')
    rmSync(stream('claude'))
    mkdirSync(stream('claude'))
    expect(() => screen()).toThrow('not a regular file')
    rmSync(stream('claude'), { recursive: true })
    expect(Bun.spawnSync(['mkfifo', stream('claude')]).exitCode).toBe(0)
    expect(() => screen()).toThrow('not a regular file')
  })
})
