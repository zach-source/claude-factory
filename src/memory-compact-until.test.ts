// `factory memory compact` must retire a note whose `until` marker ended (claude-factory-3u1.1.4,
// AC10/AC11). A past date always ends a marker. A bead or PR marker ends only once a fake bd or
// gh on PATH answers it that way.
import { afterAll, afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-compact-until-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const repo = join(dir, 'rig-repo')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[], env: Record<string, string> = {}) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, PATH, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, PATH: `${bin}:${PATH}`, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
    timeout: 30_000,
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const gitMemory = (...args: string[]) =>
  Bun.spawnSync(['git', '-C', join(home, 'memory'), ...args])
    .stdout.toString()
    .trim()

/**
 * A fake `bd` on PATH.
 *
 * `config get issue_prefix` answers BD_PREFIX. The default is "acme-widget".
 *
 * `show <id> --json` answers BD_SHOW_MODE. The value is one of closed, open, notfound or timeout.
 *
 * The script branches on an env var. It does not branch on $PWD or an argument. So one script
 * serves every case that bd(repo, actor) can hit.
 */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    'config)',
    '  printf \'%s\' "${BD_PREFIX:-acme-widget}"; exit 0;;',
    'show)',
    '  case "$BD_SHOW_MODE" in',
    '    closed) printf \'%s\' \'[{"id":"\'"$2"\'","status":"closed"}]\'; exit 0;;',
    '    open) printf \'%s\' \'[{"id":"\'"$2"\'","status":"open"}]\'; exit 0;;',
    '    notfound) echo "Issue $2 not found" >&2; printf \'%s\' \'{"error":"not found"}\'; exit 1;;',
    '    timeout) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    '  esac;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

/** A fake `gh` on PATH. `pr view <url> --json state` answers GH_STATE: a PrState prints as JSON;
 * "FAIL" exits 1 with no stdout, like a down or rate-limited gh. */
function fakeGh() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    '"pr view")',
    '  if [ "$GH_STATE" = "FAIL" ]; then exit 1; fi',
    '  printf \'%s\' \'{"state":"\'"$GH_STATE"\'"}\'; exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'gh'), script)
  chmodSync(join(bin, 'gh'), 0o755)
}

/** a rig whose repo has .beads (hasBeads()), so untilDeps() looks up a bead id against it */
function seedRig() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(repo, '.beads'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'acme', repo, factory: 'lifecycle' }]))
  fakeBd()
  fakeGh()
}

afterEach(() => {
  delete process.env.BD_SHOW_MODE
  delete process.env.GH_STATE
})

test('memory compact --dry-run retires a note whose date until marker passed', () => {
  seedRig()
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'stale.md'),
    '---\nsummary: a fact that holds only until a date\nuntil: 2026-01-01\n---\nbody text\n',
  )
  const dry = run(['memory', 'compact', '--dry-run'])
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('retire  beads/stale.md: date 2026-01-01 passed')
})

test('memory compact --dry-run retires a note whose bead until marker closed, through a fake bd', () => {
  seedRig()
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'cites-bead.md'),
    '---\nsummary: a fact that cites a bead\nuntil: acme-widget-h7c\n---\nbody text\n',
  )
  const dry = run(['memory', 'compact', '--dry-run'], { BD_SHOW_MODE: 'closed' })
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('retire  beads/cites-bead.md: bead acme-widget-h7c closed')
})

test('memory compact --dry-run flags, and never retires, a note whose bead lookup fails', () => {
  seedRig()
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'cites-bead.md'),
    '---\nsummary: a fact that cites a bead\nuntil: acme-widget-h7c\n---\nbody text\n',
  )
  const dry = run(['memory', 'compact', '--dry-run'], { BD_SHOW_MODE: 'timeout' })
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('flag  beads/cites-bead.md: bead acme-widget-h7c lookup failed')
  expect(dry.out).not.toContain('retire  ')
})

test('memory compact --dry-run retires a note whose PR until marker merged, through a fake gh', () => {
  seedRig()
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'cites-pr.md'),
    '---\nsummary: a fact that cites a PR\nuntil: acme/widget#70\n---\nbody text\n',
  )
  const dry = run(['memory', 'compact', '--dry-run'], { GH_STATE: 'MERGED' })
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('retire  beads/cites-pr.md: PR acme/widget#70 merged')
})

test('memory compact --dry-run flags, and never retires, a note whose PR lookup fails', () => {
  seedRig()
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'cites-pr.md'),
    '---\nsummary: a fact that cites a PR\nuntil: acme/widget#70\n---\nbody text\n',
  )
  const dry = run(['memory', 'compact', '--dry-run'], { GH_STATE: 'FAIL' })
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('flag  beads/cites-pr.md: PR acme/widget#70 lookup failed')
  expect(dry.out).not.toContain('retire  ')
})

test('memory compact (not dry) commits a retired note and names it in the commit message', () => {
  seedRig()
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'stale.md'),
    '---\nsummary: a fact that holds only until a date\nuntil: 2026-01-01\n---\nbody text\n',
  )
  const real = run(['memory', 'compact'])
  expect(real.code).toBe(0)
  expect(real.out).toContain('1 retired')
  expect(gitMemory('status', '--porcelain')).toBe('')
  const log = readFileSync(join(home, 'dream.log'), 'utf8')
  expect(log).toContain('retire  beads/stale.md: date 2026-01-01 passed')
})
