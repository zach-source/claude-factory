import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  axRepoPath,
  bdEnv,
  beadsDirOf,
  httpsRemote,
  mapRigs,
  mapRunRepo,
  planRepoSync,
  syncRepos,
} from './axrepos'

const AX = { FACTORY_IN_AX: '1' }
const rigs = [
  { name: 'alpha', repo: '/home/u/repos/alpha', remote: 'git@github.com:example/alpha.git' },
  { name: 'beta', repo: '/home/u/repos/beta' },
]

test('on the laptop the rigs and run repos stay as written', () => {
  expect(mapRigs(rigs, {})).toEqual(rigs)
  expect(mapRunRepo(rigs, '/home/u/repos/alpha', {})).toBe('/home/u/repos/alpha')
})

test('in the task each rig repo is a clone under FACTORY_REPOS, default /workspace/w/repos', () => {
  expect(axRepoPath('alpha', AX)).toBe('/workspace/w/repos/alpha')
  expect(axRepoPath('alpha', { ...AX, FACTORY_REPOS: '/srv/r' })).toBe('/srv/r/alpha')
  expect(mapRigs(rigs, AX).map(r => r.repo)).toEqual(['/workspace/w/repos/alpha', '/workspace/w/repos/beta'])
})

test('a run written with a laptop repo path maps to its rig clone; an unknown path stays', () => {
  expect(mapRunRepo(rigs, '/home/u/repos/beta', AX)).toBe('/workspace/w/repos/beta')
  expect(mapRunRepo(rigs, '/elsewhere', AX)).toBe('/elsewhere')
})

test('ssh and git@ GitHub URLs become https; https stays', () => {
  expect(httpsRemote('git@github.com:example/r.git')).toBe('https://github.com/example/r.git')
  expect(httpsRemote('ssh://git@github.com/example/r.git')).toBe('https://github.com/example/r.git')
  expect(httpsRemote('https://github.com/example/r.git')).toBe('https://github.com/example/r.git')
})

test('repos sync clones what is missing, fetches what is there, names a rig with no remote', () => {
  const have = new Set(['/workspace/w/repos/beta/.git'])
  const steps = planRepoSync([...rigs, { name: 'gamma', repo: '/x' }], p => have.has(p), AX)
  expect(steps).toEqual([
    {
      rig: 'alpha',
      path: '/workspace/w/repos/alpha',
      do: 'clone',
      url: 'https://github.com/example/alpha.git',
    },
    { rig: 'beta', path: '/workspace/w/repos/beta', do: 'fetch' },
    {
      rig: 'gamma',
      path: '/workspace/w/repos/gamma',
      do: 'missing',
      why: 'rig gamma has no "remote" in rigs.json',
    },
  ])
})

test('bd gets its own store in the task once bootstrapped, and the laptop env is untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'axrepos-'))
  const repo = '/workspace/w/repos/alpha'
  const env = { ...AX, FACTORY_HOME: home }
  expect(bdEnv(repo, env)).toBe(env) // no store yet
  const dir = beadsDirOf(home, repo)
  mkdirSync(join(dir, '.beads'), { recursive: true })
  writeFileSync(join(dir, 'env.json'), JSON.stringify({ DOLT_REMOTE_USER: 'u' }))
  expect(bdEnv(repo, env)).toMatchObject({
    BEADS_DIR: join(dir, '.beads'),
    BEADS_DOLT_SHARED_SERVER: '0',
    DOLT_REMOTE_USER: 'u',
  })
  const laptop = { FACTORY_HOME: home }
  expect(bdEnv(repo, laptop)).toBe(laptop)
})

test('repos sync gives a rig with no beadsRemote a store from its git origin, and no problem line', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-sync-'))
  const origin = join(root, 'origin')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  mkdirSync(join(origin, '.beads'), { recursive: true })
  writeFileSync(join(origin, '.beads', 'config.yaml'), 'issue-prefix: acme\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  // like bd 1.3.0: no .beads/config.yaml, no workspace
  const bd = join(root, 'bd')
  writeFileSync(
    bd,
    "#!/bin/sh\n[ -f .beads/config.yaml ] || { printf '%s\\n' 'Error: No active beads workspace found.' >&2; exit 1; }\nmkdir -p .beads/embeddeddolt\n",
    { mode: 0o755 },
  )
  const saved = process.env.FACTORY_BD
  process.env.FACTORY_BD = bd
  try {
    const home = join(root, 'home')
    const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
    const problems = syncRepos([{ name: 'widget', repo: '/x', remote: origin }], home, env)
    expect(problems).toEqual([])
    const clone = join(root, 'repos', 'widget')
    const dir = beadsDirOf(home, clone)
    expect(readFileSync(join(dir, '.beads', 'config.yaml'), 'utf8')).toBe(`sync.remote: "git+${origin}"\n`)
    expect(readFileSync(join(dir, 'env.json'), 'utf8')).toBe('{}')
    expect(bdEnv(clone, env).BEADS_DIR).toBe(join(dir, '.beads'))
  } finally {
    if (saved === undefined) delete process.env.FACTORY_BD
    else process.env.FACTORY_BD = saved
  }
})
