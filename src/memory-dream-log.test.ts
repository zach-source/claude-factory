// `factory dream` appends to dream.log and rotates it to dream.log.1 past 256 KB (claude-factory-c1h0.3).
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-dream-log-${process.pid}`)
const home = join(dir, 'home')
const log = join(home, 'dream.log')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function seed() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory', 'inbox'), { recursive: true })
  writeFileSync(join(home, 'memory', 'inbox', 'x.md'), '---\nsummary: a fixture note\n---\nbody\n')
  const claude = join(dir, 'fake-claude.sh')
  writeFileSync(claude, '#!/bin/sh\necho "dream said hi"\n')
  chmodSync(claude, 0o755)
  return claude
}

const dream = (claude: string) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'dream'], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_CLAUDE: claude },
  })
  expect(p.exitCode).toBe(0)
}
const headers = () => (readFileSync(log, 'utf8').match(/^\S+ exit 0$/gm) ?? []).length

test('two dreams leave two headers in dream.log, with no rotation', () => {
  const claude = seed()
  dream(claude)
  dream(claude)
  expect(headers()).toBe(2)
  expect(existsSync(`${log}.1`)).toBe(false)
}, 60_000)

test('a dream.log over 256 KB moves to dream.log.1; a 255 KB log stays', () => {
  const claude = seed()
  writeFileSync(log, `OLD\n${'x'.repeat(255 * 1024)}\n`)
  dream(claude)
  expect(existsSync(`${log}.1`)).toBe(false)
  expect(readFileSync(log, 'utf8').startsWith('OLD\n')).toBe(true)
  writeFileSync(log, `OLD\n${'x'.repeat(300 * 1024)}\n`)
  dream(claude)
  expect(readFileSync(`${log}.1`, 'utf8').startsWith('OLD\n')).toBe(true)
  expect(readFileSync(log, 'utf8')).toMatch(/^\S+ exit 0\n/)
  expect(headers()).toBe(1)
}, 60_000)
