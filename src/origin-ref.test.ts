// originRef() reads a repo's origin as GitHub only for the host github.com (claude-factory-9qw)
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originRef } from './cli'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repoWith(origin: string): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'origin-ref-'))
  dirs.push(d)
  Bun.spawnSync(['git', '-C', d, 'init', '-q'])
  Bun.spawnSync(['git', '-C', d, 'remote', 'add', 'origin', origin])
  return d
}

test('a host that merely ends in github.com is not GitHub', () => {
  expect(originRef(repoWith('https://mygithub.com/acme/widget'))).toBeUndefined()
  expect(originRef(repoWith('git@evilgithub.com:acme/widget.git'))).toBeUndefined()
})

test('github.com origins give acme/widget', () => {
  for (const u of [
    'https://github.com/acme/widget',
    'https://github.com/acme/widget.git',
    'git@github.com:acme/widget.git',
    'ssh://git@github.com/acme/widget',
  ])
    expect(originRef(repoWith(u))).toEqual({
      owner: 'acme',
      repo: 'widget',
      forge: 'github',
      host: 'github.com',
    })
})
