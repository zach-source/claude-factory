import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reworkBase } from './cli'

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
