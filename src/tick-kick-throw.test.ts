// A kick that throws on its stamp must not stop the kicks after it (claude-factory-50vr).
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `tick-kick-throw-${process.pid}`)

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('tick survives kickSelfUpdate throwing and still runs kickSweeps', () => {
  const home = join(dir, 'home')
  mkdirSync(join(home, 'runs', 'r1'), { recursive: true }) // a run makes tick kick
  writeFileSync(join(home, 'runs', 'r1', 'inbox.jsonl'), '')
  const stamp = join(home, 'self-update.stamp')
  mkdirSync(stamp) // writeFileSync(stamp) fails with EISDIR
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(stamp, old, old) // due
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_NO_KICK, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'tick'], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '1', FACTORY_GC: '0', FACTORY_GC_WORKTREES: '0' },
  })
  expect(p.stderr.toString()).toContain('kickSelfUpdate failed')
  expect(p.exitCode).toBe(0)
  expect(existsSync(join(home, 'sweeps.stamp'))).toBe(true) // seeded by a later kick
})
