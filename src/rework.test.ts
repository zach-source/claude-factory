import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshBase, reworkBase } from './cli'

const g = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@x', ...a])
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

test('a rework run starts on the queued PR branch from origin, and only when that branch exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'rework-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const clone = join(root, 'clone')
  g(root, 'init', '--bare', '-q', origin)
  g(root, 'clone', '-q', origin, work)
  writeFileSync(join(work, 'a'), 'a')
  g(work, 'add', 'a')
  g(work, 'commit', '-q', '-m', 'a')
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/factory/run-1')
  g(root, 'clone', '-q', origin, clone)
  expect(reworkBase(clone, 'factory/run-1')).toBe('origin/factory/run-1')
  expect(reworkBase(clone, 'factory/gone')).toBeUndefined()
})

test('a branch that is not a factory branch name gives no base', () => {
  for (const b of ['-x', 'main', '../x', 'factory/../x']) expect(reworkBase('.', b)).toBeUndefined()
})

test('freshBase starts at the rig base_branch tip on origin, and falls back to the origin default branch, never unpushed local commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const clone = join(root, 'clone')
  const sha = (cwd: string) => Bun.spawnSync(['git', '-C', cwd, 'rev-parse', 'HEAD']).stdout.toString().trim()
  const commit = (cwd: string, f: string) => {
    writeFileSync(join(cwd, f), f)
    g(cwd, 'add', f)
    g(cwd, 'commit', '-q', '-m', f)
  }
  g(root, 'init', '--bare', '-q', '-b', 'main', origin)
  g(root, 'clone', '-q', origin, work)
  commit(work, 'a')
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/deploy')
  g(root, 'clone', '-q', origin, clone)
  commit(clone, 'local') // one unpushed commit
  const mainTip = sha(work) // origin/main; the clone's local main is one commit ahead
  const local = sha(clone)
  expect(local).not.toBe(mainTip)
  commit(work, 'd1')
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/deploy')
  const deployTip = sha(work)
  const rig = (base_branch: string) => ({ params: { base_branch } })

  expect(freshBase(clone, rig('deploy'))).toBe(deployTip) // A: fetched, not the stale origin/deploy
  expect(freshBase(clone, rig(' deploy '))).toBe(deployTip)
  expect(freshBase(clone, rig(''))).toBe(mainTip) // B: never the unpushed local commit
  for (const b of ['a..b', '-x', 'x y', '$(id)', 'deploy~0', 'nope'])
    expect(freshBase(clone, rig(b))).toBe(mainTip) // D, E

  const clone2 = join(root, 'clone2')
  g(root, 'clone', '-q', origin, clone2)
  commit(work, 'm1')
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  expect(freshBase(clone2, {})).toBe(sha(work)) // C
})
