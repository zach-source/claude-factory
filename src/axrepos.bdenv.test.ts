import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bdExports, beadsDirOf } from './axrepos'

// claude-factory-d289.26: the manager model's shell bd gets the beads env of the rig repo of its cwd

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bdenv-'))
  const home = join(root, 'home')
  const repos = join(root, 'repos')
  const repo = join(repos, 'alpha')
  mkdirSync(repo, { recursive: true })
  Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
  const dir = beadsDirOf(home, repo)
  mkdirSync(join(dir, '.beads'), { recursive: true })
  writeFileSync(join(dir, 'env.json'), JSON.stringify({ DOLT_REMOTE_USER: "u'x" }))
  const env = { FACTORY_IN_AX: '1', FACTORY_HOME: home, FACTORY_REPOS: repos }
  return { root, repo, dir, env }
}

test('bdExports gives the rig store env in a rig repo, and nothing elsewhere', () => {
  const { root, repo, dir, env } = setup()
  expect(bdExports(repo, env)).toEqual({
    BEADS_DIR: join(dir, '.beads'),
    BEADS_DOLT_SHARED_SERVER: '0',
    BD_NON_INTERACTIVE: '1',
    DOLT_REMOTE_USER: "u'x",
  })
  expect(bdExports(join(root, 'other'), env)).toEqual({}) // not under the repos root
  expect(bdExports(join(env.FACTORY_REPOS, 'beta'), env)).toEqual({}) // no store yet
  expect(bdExports(undefined, env)).toEqual({}) // not in a git repo
  expect(bdExports(repo, { ...env, FACTORY_IN_AX: undefined })).toEqual({}) // the laptop
})

test('`factory repos bd-env` lets a shell bd see the store, from a subdirectory; outside a rig repo bd sees nothing', () => {
  const { root, repo, dir, env } = setup()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'bd'), '#!/bin/sh\necho "${BEADS_DIR:-none} ${DOLT_REMOTE_USER:-none}"\n')
  chmodSync(join(bin, 'bd'), 0o755)
  mkdirSync(join(repo, 'sub'))
  const cli = join(import.meta.dir, 'cli.ts')
  const run = (cwd: string) =>
    Bun.spawnSync(['bash', '-c', `eval "$(bun ${cli} repos bd-env 2>/dev/null)"; bd`], {
      cwd,
      env: {
        ...process.env,
        BEADS_DIR: undefined,
        DOLT_REMOTE_USER: undefined,
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
      },
    })
      .stdout.toString()
      .trim()
  expect(run(join(repo, 'sub'))).toBe(`${join(dir, '.beads')} u'x`)
  expect(run(root)).toBe('none none')
})
