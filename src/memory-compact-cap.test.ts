// `factory memory compact`, end to end through bin/factory (claude-factory-503.2).
// The fixture has 30 notes. Each note is never shown and is 20 to 49 days old.
// One old usage line sits on an unrelated path, to pass the 14-day usage-history guard.
// The default cap is 25: it must hold the 5 youngest notes and archive the 25 oldest.
// Compact must log the plan to dream.log before it writes anything.
import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-compact-cap-${process.pid}`)
const home = join(dir, 'home')
const DAY_MS = 24 * 60 * 60 * 1000

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[]) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

function seed() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  const now = Date.now()
  // 30 never-shown notes, 20..49 days old: cap 25 must archive the 25 oldest and hold the 5 youngest
  for (let age = 20; age <= 49; age++) {
    const at = new Date(now - age * DAY_MS).toISOString().slice(0, 10)
    writeFileSync(
      join(home, 'memory', 'beads', `n${age}.md`),
      `---\nsummary: fixture note ${age} days old\nat: ${at}\n---\nnever shown, ${age} days old.\n`,
    )
  }
  // 20 days of usage history, on a path none of the fixture notes use: old enough to pass the
  // 14-day usage-history guard, without marking any fixture note as shown
  appendFileSync(
    join(home, 'memory', '.usage.jsonl'),
    `${JSON.stringify({ path: 'beads/unrelated.md', shown: 1, at: now - 20 * DAY_MS })}\n`,
  )
}

test('memory compact --dry-run plans the cap and holds the 5 youngest, writing nothing', () => {
  seed()
  const dry = run(['memory', 'compact', '--dry-run'])
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('cap 25')
  const heldLines = dry.out.split('\n').filter(l => l.startsWith('held  '))
  expect(heldLines).toHaveLength(5)
  expect(existsSync(join(home, 'memory', '.git'))).toBe(false)
})

test('memory compact archives the 25 oldest, holds 5, and logs the plan to dream.log first', () => {
  seed()
  const real = run(['memory', 'compact'])
  expect(real.code).toBe(0)
  expect(real.out).toContain('25 archived, 5 held by the archive cap')

  const log = readFileSync(join(home, 'dream.log'), 'utf8')
  expect(log).toContain('tier plan:')
  const archiveLines = log.split('\n').filter(l => l.startsWith('archive  '))
  expect(archiveLines).toHaveLength(25)
})
