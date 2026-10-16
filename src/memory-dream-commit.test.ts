// This file tests `factory dream` and `factory memory compact` end to end, through bin/factory
// (claude-factory-503.3).
// compact() rewrites .usage.jsonl and appends .renames.jsonl (memory.ts:572-602).
// Today both calls run after the git commit that follows them, so they leave the memory repo dirty
// (' M .renames.jsonl') right after a dream or a compact.
// The old gitignore also excludes .usage.jsonl* outright, so git never gets the usage counts.
// compact() must run before each commit, and only .index.json* and .usage.jsonl.tmp (compact's own
// crash-safe temp file) can stay ignored.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-dream-commit-${process.pid}`)
const home = join(dir, 'home')
const DAY_MS = 24 * 60 * 60 * 1000

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[], env: Record<string, string> = {}) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const gitMemory = (...args: string[]) =>
  Bun.spawnSync(['git', '-C', join(home, 'memory'), ...args])
    .stdout.toString()
    .trim()

/**
 * a fake `claude -p` that files the one inbox note under topic/, so dream() has a real rename to
 * compact before its commit (harness.ts:25 reads FACTORY_CLAUDE for the agent's command line).
 */
function fakeClaude() {
  const file = join(dir, 'fake-claude.sh')
  writeFileSync(
    file,
    ['#!/bin/sh', 'set -e', 'mkdir -p topic', 'git mv inbox/x.md topic/x.md', 'echo "filed x.md under topic/x.md"', ''].join(
      '\n',
    ),
  )
  chmodSync(file, 0o755)
  return file
}

function seedInbox() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory', 'inbox'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'inbox', 'x.md'),
    '---\nsummary: a fixture note waiting to be filed\n---\nbody text\n',
  )
  writeFileSync(
    join(home, 'memory', '.usage.jsonl'),
    `${JSON.stringify({ path: 'inbox/x.md', shown: 1, at: Date.now() - 1000 })}\n`,
  )
}

for (const [label, tiersEnv] of [
  ['tiers on (default)', {}],
  ['FACTORY_MEMORY_TIERS=0', { FACTORY_MEMORY_TIERS: '0' }],
] as const) {
  test(`factory dream leaves the memory repo clean after it commits (${label})`, () => {
    seedInbox()
    const claude = fakeClaude()
    const result = run(['dream'], { FACTORY_CLAUDE: claude, ...tiersEnv })
    expect(result.code).toBe(0)
    expect(existsSync(join(home, 'memory', 'topic', 'x.md'))).toBe(true) // the fake claude filed it

    // A1: nothing left to commit right after dream()
    expect(gitMemory('status', '--porcelain')).toBe('')

    // A3: the gitignore tracks .usage.jsonl and .renames.jsonl; only .index.json* and the compact
    // temp file stay ignored
    expect(readFileSync(join(home, 'memory', '.gitignore'), 'utf8')).toBe('.index.json*\n.usage.jsonl.tmp\n')
    const ignoreUsage = Bun.spawnSync(['git', '-C', join(home, 'memory'), 'check-ignore', '-q', '.usage.jsonl'])
    expect(ignoreUsage.exitCode).toBe(1) // not ignored
    const tracked = gitMemory('ls-files').split('\n')
    expect(tracked).toContain('.usage.jsonl')
    expect(tracked).toContain('.renames.jsonl')

    // A4: the dream commit itself holds the rename and the usage line under the new path
    const dreamCommit = gitMemory('log', '-1', '--grep=^dream:', '--format=%H')
    const dreamFiles = gitMemory('show', '--name-only', '--format=', dreamCommit).split('\n')
    expect(dreamFiles).toContain('.renames.jsonl')
    expect(dreamFiles).toContain('.usage.jsonl')
    const renames = gitMemory('show', `${dreamCommit}:.renames.jsonl`)
    expect(renames).toContain('"old":"inbox/x.md"')
    expect(renames).toContain('"new":"topic/x.md"')
    const usage = gitMemory('show', `${dreamCommit}:.usage.jsonl`)
    expect(usage).toContain('"path":"topic/x.md"')
    expect(usage).not.toContain('"path":"inbox/x.md"')

    if (label === 'tiers on (default)') {
      // A4: the tiering pass makes its own compact: commit, and it too leaves the tree clean
      const compactCommit = gitMemory('log', '-1', '--grep=^compact:', '--format=%H')
      expect(compactCommit).not.toBe('')
      expect(compactCommit).not.toBe(dreamCommit)
    }
  })
}

test('factory memory compact leaves the memory repo clean after it merges a note and rewrites .usage.jsonl/.renames.jsonl', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  const now = Date.now()
  // 10 days old and shown once: old enough and used enough for decide()'s merge rule (MERGE_AGE_DAYS=7)
  writeFileSync(
    join(home, 'memory', 'beads', 'x.md'),
    `---\nsummary: a fixture note old enough to merge\nat: ${new Date(now - 10 * DAY_MS).toISOString().slice(0, 10)}\n---\nbody text\n`,
  )
  writeFileSync(
    join(home, 'memory', '.usage.jsonl'),
    `${JSON.stringify({ path: 'beads/x.md', shown: 1, at: now - 9 * DAY_MS })}\n`,
  )

  const result = run(['memory', 'compact'])
  expect(result.code).toBe(0)
  expect(result.out).toContain('1 merged')
  expect(existsSync(join(home, 'memory', 'beads', 'x.md'))).toBe(false) // merged away into LONG.md

  // A2
  expect(gitMemory('status', '--porcelain')).toBe('')
  const tracked = gitMemory('ls-files').split('\n')
  expect(tracked).toContain('.usage.jsonl')
  expect(tracked).toContain('.renames.jsonl')
  const renames = readFileSync(join(home, 'memory', '.renames.jsonl'), 'utf8')
  expect(renames).toContain('"old":"beads/x.md"')
  expect(renames).toContain('"new":"beads/LONG.md#')
  const usage = readFileSync(join(home, 'memory', '.usage.jsonl'), 'utf8')
  expect(usage).toContain('"path":"beads/LONG.md#')
  expect(usage).not.toContain('"path":"beads/x.md"')
})

// A5: a home whose memory repo already tracked notes under the OLD gitignore ('.index.json*\n.usage.jsonl*\n')
// starts tracking .usage.jsonl the next time it dreams, even on a day with nothing new to file.
test('a home with the old gitignore starts tracking .usage.jsonl on its next dream', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory'), { recursive: true })
  Bun.spawnSync(['git', '-C', join(home, 'memory'), 'init', '-q'])
  writeFileSync(join(home, 'memory', '.gitignore'), '.index.json*\n.usage.jsonl*\n')
  Bun.spawnSync(['git', '-C', join(home, 'memory'), 'add', '-A'])
  Bun.spawnSync([
    'git',
    '-C',
    join(home, 'memory'),
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '-m',
    'old gitignore',
  ])
  // under the old gitignore this file is excluded, so it was never tracked
  writeFileSync(join(home, 'memory', '.usage.jsonl'), `${JSON.stringify({ path: 'beads/old.md', shown: 2 })}\n`)
  expect(gitMemory('ls-files', '.usage.jsonl')).toBe('')

  const result = run(['dream']) // no inbox, no journal: returns early, but the gitignore migration runs first
  expect(result.code).toBe(0)
  expect(result.out).toBe('nothing new since the last dream')

  expect(gitMemory('ls-files', '.usage.jsonl')).toBe('.usage.jsonl')
  expect(readFileSync(join(home, 'memory', '.gitignore'), 'utf8')).toBe('.index.json*\n.usage.jsonl.tmp\n')
  expect(gitMemory('status', '--porcelain')).toBe('')
})
