import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bumpVersion,
  checkVersions,
  cut,
  notes,
  parseVersion,
  readVersion,
  setVersion,
  tagExists,
  unreleasedBody,
} from './release'

// The real CHANGELOG.md preamble and one real Unreleased bullet, as they stood right before commit
// b641b64 (`release: 0.12.0`, 2026-10-15): `git show b641b64^:CHANGELOG.md | head -8`.
const PREAMBLE = `# Changelog

Each release is tagged \`v<version>\` and its version is set in \`package.json\` and
\`mod/.claude-plugin/plugin.json\`. Versions follow [semver](https://semver.org); until 1.0 a
minor release may change the factory format, the CLI or the run state.

## Unreleased

`
const BULLET =
  "- Fixed: `claude plugin test mod` has no `--timeout` flag, so each test used the kit's fixed 5000 ms limit. (claude-factory-abm)\n"
const OLD_SECTION = `## 0.11.0 (2026-10-15)

- Console: the Board is a kanban.
`

const before = PREAMBLE + BULLET + '\n' + OLD_SECTION
// commit b641b64 inserted exactly these two lines right after "## Unreleased\\n\\n", and changed nothing
// else: `git show b641b64:CHANGELOG.md | head -10` lines up with this.
const after = PREAMBLE + '## 0.12.0 (2026-10-15)\n\n' + BULLET + '\n' + OLD_SECTION

test('cut() reproduces the real b641b64 CHANGELOG edit byte for byte', () => {
  expect(cut(before, '0.12.0', '2026-10-15')).toBe(after)
})

test('cut() refuses an empty Unreleased section: nothing to release', () => {
  const empty = PREAMBLE + OLD_SECTION
  expect(() => cut(empty, '0.13.0', '2026-10-15')).toThrow(/Unreleased section is empty/)
})

test('cut() refuses an Unreleased section that is only blank lines', () => {
  const blank = PREAMBLE + '\n\n' + OLD_SECTION
  expect(() => cut(blank, '0.13.0', '2026-10-15')).toThrow(/Unreleased section is empty/)
})

test('unreleasedBody returns the bullets under Unreleased, trimmed', () => {
  expect(unreleasedBody(before)).toBe(BULLET.trimEnd())
})

test('notes() returns the bullets released under a version heading', () => {
  expect(notes(after, '0.12.0')).toBe(BULLET.trimEnd())
  expect(notes(after, '0.11.0')).toBe('- Console: the Board is a kanban.')
})

test('notes() refuses a version with no heading', () => {
  expect(() => notes(after, '9.9.9')).toThrow(/heading not found/)
})

test('bumpVersion: patch, minor and major, each resetting what comes after it', () => {
  expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
  expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
  expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
  expect(bumpVersion('0.12.0', 'minor')).toBe('0.13.0')
})

test('bumpVersion refuses an unknown bump kind', () => {
  expect(() => bumpVersion('1.2.3', 'banana' as never)).toThrow(/unknown bump kind/)
})

test('parseVersion refuses a non-semver string', () => {
  expect(() => parseVersion('v1.2.3')).toThrow(/not a semver/)
  expect(() => parseVersion('1.2')).toThrow(/not a semver/)
})

test('setVersion edits only the version field, byte for byte everywhere else', () => {
  const pkg = '{\n  "name": "claude-factory",\n  "version": "0.12.0",\n  "private": true\n}\n'
  const want = '{\n  "name": "claude-factory",\n  "version": "0.13.0",\n  "private": true\n}\n'
  expect(setVersion(pkg, '0.13.0')).toBe(want)
})

test('readVersion/setVersion refuse a JSON file with no version field', () => {
  expect(() => readVersion('{"name": "x"}')).toThrow(/no "version" field/)
  expect(() => setVersion('{"name": "x"}', '1.0.0')).toThrow(/no "version" field/)
})

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

test('tagExists finds a tag on origin even when the local clone fetched no tags, the shape actions/checkout leaves by default (claude-factory-5h9.15)', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-tagexists-'))
  try {
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const local = join(root, 'local')
    git(root, 'init', '--bare', '-q', remote)
    git(root, 'init', '-q', '-b', 'main', seed)
    git(seed, 'config', 'user.email', 'test@example.com')
    git(seed, 'config', 'user.name', 'test')
    writeFileSync(join(seed, 'f'), 'x')
    git(seed, 'add', 'f')
    git(seed, 'commit', '-q', '-m', 'seed')
    git(seed, 'tag', '-m', 'test tag', 'v1.0.0')
    git(seed, 'remote', 'add', 'origin', remote)
    git(seed, 'push', '-q', 'origin', 'HEAD:main', 'v1.0.0')
    // a shallow, tagless clone: actions/checkout's default (fetch-tags: false)
    git(root, 'clone', '-q', '--no-tags', '--depth', '1', '--branch', 'main', remote, local)

    // the clone really has no local tag: the old rev-parse-based check would say "not found" here
    const rp = Bun.spawnSync(['git', '-C', local, 'rev-parse', '-q', '--verify', 'refs/tags/v1.0.0'])
    expect(rp.exitCode).not.toBe(0)

    expect(tagExists('1.0.0', local)).toBe(true)
    expect(tagExists('9.9.9', local)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('checkVersions returns the shared version, or refuses a drift between the two files', () => {
  const pkg = '{"version": "0.12.0"}'
  const plugin = '{"version": "0.12.0"}'
  expect(checkVersions(pkg, plugin)).toBe('0.12.0')
  const driftedPlugin = '{"version": "0.11.0"}'
  expect(() => checkVersions(pkg, driftedPlugin)).toThrow(
    /package.json is 0.12.0 but mod\/.claude-plugin\/plugin.json is 0.11.0/,
  )
})
