import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cacheKey, DOCKERFILE, isDue, remoteDevenv } from './devenv'

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-C', cwd, ...a], { stderr: 'pipe' })

test("a rig's devenv is rebuilt when its devenv files or the worker image change, and not otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), 'devenv-'))
  const origin = join(dir, 'origin')
  const clone = join(dir, 'clone')
  git(dir, 'init', '-q', '-b', 'main', origin)
  writeFileSync(join(origin, 'devenv.nix'), '{ }\n')
  writeFileSync(join(origin, 'devenv.lock'), '{"v":1}\n')
  writeFileSync(join(origin, 'main.go'), 'package main\n')
  git(origin, 'add', '.')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one')
  git(dir, 'clone', '-q', origin, clone)

  const first = remoteDevenv(clone)
  expect(first.hasDevenv).toBe(true)
  const key = cacheKey(first.blobs, 'img@1')
  const stamp = { key, ok: true, at: 1, rev: first.rev }
  expect(isDue(undefined, key)).toBe(true)
  expect(isDue(stamp, key)).toBe(false)
  expect(isDue(stamp, key, true)).toBe(true)
  expect(isDue(stamp, cacheKey(first.blobs, 'img@2'))).toBe(true)

  // code changes leave the devenv as it was; a lock change is a new build, seen after a fetch
  writeFileSync(join(origin, 'main.go'), 'package main // two\n')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'code')
  expect(cacheKey(remoteDevenv(clone).blobs, 'img@1')).toBe(key)
  writeFileSync(join(origin, 'devenv.lock'), '{"v":2}\n')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'lock')
  expect(isDue(stamp, cacheKey(remoteDevenv(clone).blobs, 'img@1'))).toBe(true)
})

test('the devenv builds at the path the VM clones to, since its derivations depend on it', () => {
  expect(DOCKERFILE).toContain('mkdir -p /workspace/w/repo && cd /workspace/w/repo')
})
