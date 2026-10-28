// Test for `factory memory compact` with FACTORY_MEMORY_TOPIC_CAP set (claude-factory-3u1.1.3.4).
// The fixture has 1 topic with 5 notes: 1 old note (10 days old) and 4 new notes (1 day old).
// MERGE_AGE_DAYS is 7. Only the old note is old enough to merge.
// The cap is 3. The pass merges the 1 old note into LONG.md.
// The topic still has 4 short notes left: that is over the cap of 3.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-compact-topiccap-${process.pid}`)
const home = join(dir, 'home')
const DAY_MS = 24 * 60 * 60 * 1000

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[]) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_MEMORY_TOPIC_CAP: '3' },
    timeout: 30_000,
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

function seed() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  const now = Date.now()
  const oldAt = new Date(now - 10 * DAY_MS).toISOString().slice(0, 10)
  writeFileSync(
    join(home, 'memory', 'beads', 'old.md'),
    `---\nsummary: old fixture note, 10 days old\nat: ${oldAt}\n---\nnever shown, 10 days old.\n`,
  )
  for (let i = 0; i < 4; i++) {
    const at = new Date(now - 1 * DAY_MS).toISOString().slice(0, 10)
    writeFileSync(
      join(home, 'memory', 'beads', `new${i}.md`),
      `---\nsummary: new fixture note ${i}, 1 day old\nat: ${at}\n---\nnever shown, 1 day old.\n`,
    )
  }
}

test('memory compact --dry-run prints an over line when a topic stays over the cap, writing nothing', () => {
  seed()
  const dry = run(['memory', 'compact', '--dry-run'])
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('over  beads: 4 short notes, cap 3')
  expect(existsSync(join(home, 'memory', '.git'))).toBe(false)
})

test('memory compact merges the one old note and the commit message names the topic still over the cap', () => {
  seed()
  const real = run(['memory', 'compact'])
  expect(real.code).toBe(0)
  expect(real.out).toContain('1 merged')
  expect(real.out).toContain('1 topic(s) over the cap of 3: beads (4)')

  const log = readFileSync(join(home, 'dream.log'), 'utf8')
  expect(log).toContain('tier plan:')
  expect(existsSync(join(home, 'memory', 'beads', 'LONG.md'))).toBe(true)
})
