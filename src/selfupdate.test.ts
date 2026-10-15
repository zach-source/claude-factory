import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isDue, selfUpdate } from './selfupdate'

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg)
}
const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD')

// a real bare origin plus a clone, the way `devenv.test.ts` sets up its own real-git fixture
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'selfupdate-'))
  const origin = join(dir, 'origin')
  const clone = join(dir, 'clone')
  git(dir, 'init', '-q', '-b', 'main', origin)
  commit(origin, 'a.txt', 'one\n', 'one')
  git(dir, 'clone', '-q', origin, clone)
  git(clone, 'branch', '--set-upstream-to=origin/main', 'main')
  return { dir, origin, clone }
}

test('a clean clone fast-forwards to its origin/main, and reports the old and new HEAD', () => {
  const { origin, clone } = fixture()
  const before = head(clone)
  commit(origin, 'b.txt', 'two\n', 'two')
  const after = head(origin)

  const s = selfUpdate(clone, { enabled: true })
  expect(s.ok).toBe(true)
  expect(s.from).toBe(before)
  expect(s.to).toBe(after)
  expect(head(clone)).toBe(after)
}, 30_000)

test('already up to date: no fetch finds a new commit, ok stays true, from equals to', () => {
  const { clone } = fixture()
  const before = head(clone)
  const s = selfUpdate(clone, { enabled: true })
  expect(s).toMatchObject({ ok: true, from: before, to: before, why: 'already up to date' })
}, 30_000)

test('FACTORY_SELF_UPDATE=0 (enabled: false) refuses and changes nothing, named by its own switch', () => {
  const { origin, clone } = fixture()
  const before = head(clone)
  commit(origin, 'b.txt', 'two\n', 'two')

  const s = selfUpdate(clone, { enabled: false })
  expect(s.ok).toBe(false)
  expect(s.why).toBe('FACTORY_SELF_UPDATE=0')
  expect(head(clone)).toBe(before) // unchanged: no fetch, no merge
}, 30_000)

test('a branch other than main refuses and changes nothing, naming the branch', () => {
  const { origin, clone } = fixture()
  git(clone, 'checkout', '-qb', 'not-main')
  const before = head(clone)
  commit(origin, 'b.txt', 'two\n', 'two')

  const s = selfUpdate(clone, { enabled: true })
  expect(s.ok).toBe(false)
  expect(s.why).toBe('branch is not-main, not main')
  expect(head(clone)).toBe(before)
}, 30_000)

test('a branch with no upstream (or the wrong one) refuses and changes nothing', () => {
  const { clone } = fixture()
  git(clone, 'branch', '--unset-upstream', 'main')
  const before = head(clone)

  const s = selfUpdate(clone, { enabled: true })
  expect(s.ok).toBe(false)
  expect(s.why).toBe('upstream is (none), not origin/main')
  expect(head(clone)).toBe(before)
}, 30_000)

test('a dirty tree (tracked changes) refuses and changes nothing; an untracked file is fine on its own', () => {
  const { origin, clone } = fixture()
  const before = head(clone)
  commit(origin, 'b.txt', 'two\n', 'two')
  writeFileSync(join(clone, 'a.txt'), 'edited\n') // a.txt is tracked: this is a dirty tree

  const s = selfUpdate(clone, { enabled: true })
  expect(s.ok).toBe(false)
  expect(s.why).toBe('the tree has tracked changes')
  expect(head(clone)).toBe(before)
}, 30_000)

test('history diverged (a local commit origin/main does not contain) refuses and changes nothing', () => {
  const { origin, clone } = fixture()
  commit(clone, 'local-only.txt', 'mine\n', 'local commit, never pushed')
  const before = head(clone)
  commit(origin, 'b.txt', 'two\n', 'two') // origin moves on without this local commit

  const s = selfUpdate(clone, { enabled: true })
  expect(s.ok).toBe(false)
  expect(s.why).toContain('is not an ancestor of')
  expect(s.why).toContain('history diverged')
  expect(head(clone)).toBe(before)
}, 30_000)

test('an untracked file the merge would overwrite refuses (git merge --ff-only itself refuses it) and changes nothing', () => {
  const { origin, clone } = fixture()
  const before = head(clone)
  commit(origin, 'b.txt', 'from origin\n', 'adds b.txt')
  writeFileSync(join(clone, 'b.txt'), 'untracked local copy\n') // never git add'ed

  const s = selfUpdate(clone, { enabled: true })
  expect(s.ok).toBe(false)
  expect(s.why).toContain('merge --ff-only')
  expect(head(clone)).toBe(before)
}, 30_000)

test('bun install runs only when bun.lock changed between the old and new HEAD (a fake runner proves both branches)', () => {
  const { origin, clone } = fixture()
  const calls: string[][] = []
  const fakeRun = (cwd: string, cmd: string[]) => {
    calls.push(cmd)
    if (cmd[0] === 'bun') return { code: 0, out: '', err: '' }
    const p = Bun.spawnSync(cmd, { cwd })
    return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
  }

  commit(origin, 'b.txt', 'no lock change\n', 'unrelated change')
  const s1 = selfUpdate(clone, { enabled: true, run: fakeRun })
  expect(s1.ok).toBe(true)
  expect(calls.some(c => c[0] === 'bun')).toBe(false)

  commit(origin, 'bun.lock', '{"v":2}\n', 'bump a dependency')
  const s2 = selfUpdate(clone, { enabled: true, run: fakeRun })
  expect(s2.ok).toBe(true)
  expect(s2.why).toContain('ran bun install')
  expect(calls.filter(c => c[0] === 'bun')).toEqual([['bun', 'install', '--frozen-lockfile']])
}, 30_000)

test('a failing injected bun install reports ok: false but keeps the already-merged commit (git already moved)', () => {
  const { origin, clone } = fixture()
  commit(origin, 'bun.lock', '{"v":2}\n', 'bump a dependency')
  const after = head(origin)
  const failRun = (_cwd: string, cmd: string[]) =>
    cmd[0] === 'bun' ? { code: 1, out: '', err: 'simulated bun install failure' } : runReal(_cwd, cmd)
  function runReal(cwd: string, cmd: string[]) {
    const p = Bun.spawnSync(cmd, { cwd })
    return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
  }

  const s = selfUpdate(clone, { enabled: true, run: failRun })
  expect(s.ok).toBe(false)
  expect(s.why).toContain('bun install failed')
  expect(head(clone)).toBe(after) // the merge itself already succeeded
}, 30_000)

test('isDue: true with no lastAt, true once intervalMs has passed, false before it', () => {
  expect(isDue(undefined, 1_000, 500)).toBe(true)
  expect(isDue(1_000, 1_499, 500)).toBe(false)
  expect(isDue(1_000, 1_500, 500)).toBe(true)
})
