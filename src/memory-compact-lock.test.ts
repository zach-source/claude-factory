// `factory memory compact`, end to end through bin/factory (claude-factory-59r.13).
// A live dream holds dream.lock while it merges and archives notes.
// A concurrent `memory compact` can race it and lose a rename or an archive decision.
// `memory compact` (not --dry-run) must take the same lock. It must refuse while a dream holds it.
// It must release the lock, so a later compact can still run.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-compact-lock-${process.pid}`)
const home = join(dir, 'home')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[]) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], { env: { ...laptop, FACTORY_HOME: home } })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

test('factory memory compact refuses while a dream holds dream.lock, and runs once it lets go', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'dream.lock'), { recursive: true })
  // this test process's own pid: alive for as long as the test runs, so hold() sees a live holder
  writeFileSync(join(home, 'dream.lock', 'pid'), String(process.pid))

  const blocked = run(['memory', 'compact'])
  expect(blocked.code).toBe(0)
  expect(blocked.out).toContain('a dream is already running')
  expect(existsSync(join(home, 'memory', '.git'))).toBe(false) // nothing written while blocked

  rmSync(join(home, 'dream.lock'), { recursive: true, force: true })
  const ok = run(['memory', 'compact'])
  expect(ok.code).toBe(0)
  expect(ok.out).toContain('compact: 0 merged, 0 archived')
  expect(existsSync(join(home, 'memory', '.git'))).toBe(true)
  expect(existsSync(join(home, 'dream.lock'))).toBe(false) // released after it finished
})

test('factory memory compact --dry-run never takes the lock: it reports only, so it never races a dream', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'dream.lock'), { recursive: true })
  writeFileSync(join(home, 'dream.lock', 'pid'), String(process.pid))

  const dry = run(['memory', 'compact', '--dry-run'])
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('nothing to merge or archive')
})
