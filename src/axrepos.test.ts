import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  axRepoPath,
  bdEnv,
  beadsDirOf,
  httpsRemote,
  mapRigs,
  isLaptopPane,
  mapRunRepo,
  mapRunWorktree,
  planRepoSync,
  stationRunnerName,
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

test('a laptop run worktree maps under the factory home; a task run and the laptop keep theirs', () => {
  const run = { id: 'r1', repo: '/home/u/repos/beta', worktree: '/home/u/wt/beta/r1' }
  const env = { ...AX, FACTORY_HOME: '/workspace/w/home' }
  expect(mapRunWorktree(rigs, run, env)).toBe('/workspace/w/home/worktrees/r1')
  expect(mapRunWorktree(rigs, run, {})).toBe('/home/u/wt/beta/r1')
  const own = { ...run, repo: '/workspace/w/repos/beta', worktree: '/workspace/w/wt/r1' }
  expect(mapRunWorktree(rigs, own, env)).toBe('/workspace/w/wt/r1')
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

const local = (n: string) => n === 'herdr'

test('on the laptop a station keeps its own runner, else the rig, else the default', () => {
  expect(stationRunnerName(false, 'herdr', 'ax', 'herdr', local)).toBe('herdr')
  expect(stationRunnerName(false, undefined, 'ax', 'herdr', local)).toBe('ax')
  expect(stationRunnerName(false, undefined, undefined, 'herdr', local)).toBe('herdr')
})

test('in the AX manager a herdr station runner gives way to the rig, else a remote default, never herdr', () => {
  expect(stationRunnerName(true, 'herdr', 'ax', 'herdr', local)).toBe('ax')
  expect(stationRunnerName(true, 'herdr', undefined, 'ax', local)).toBe('ax')
  expect(stationRunnerName(true, 'ax', 'herdr', 'herdr', local)).toBe('ax')
  expect(stationRunnerName(true, undefined, 'ax', 'herdr', local)).toBe('ax')
})

test('in the AX manager, with no remote runner anywhere, a station falls back to ax', () => {
  expect(stationRunnerName(true, undefined, undefined, 'herdr', local)).toBe('ax')
  expect(stationRunnerName(true, 'herdr', 'herdr', 'herdr', local)).toBe('ax')
  expect(stationRunnerName(true, 'herdr', undefined, 'herdr', local)).toBe('ax')
})

test('only a bare herdr pane id is a laptop pane, and only in the AX manager', () => {
  expect(isLaptopPane(true, 'wA6:p1')).toBe(true)
  expect(isLaptopPane(true, 'ax://f-run')).toBe(false)
  expect(isLaptopPane(true, null)).toBe(false)
  expect(isLaptopPane(false, 'wA6:p1')).toBe(false)
})

test('repos sync reports a rig with no beadsRemote whose origin has no refs/dolt/data, and makes no store', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-sync-'))
  const origin = join(root, 'origin')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  mkdirSync(join(origin, '.beads'), { recursive: true })
  writeFileSync(join(origin, '.beads', 'config.yaml'), 'issue-prefix: acme\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const bd = join(root, 'bd')
  writeFileSync(bd, '#!/bin/sh\nmkdir -p .beads/embeddeddolt\n', { mode: 0o755 })
  const saved = process.env.FACTORY_BD
  process.env.FACTORY_BD = bd
  try {
    const home = join(root, 'home')
    const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
    const problems = syncRepos([{ name: 'widget', repo: '/x', remote: origin }], home, env)
    expect(problems.join('\n')).toContain('no refs/dolt/data')
    const dir = beadsDirOf(home, join(root, 'repos', 'widget'))
    expect(existsSync(join(dir, '.beads', 'embeddeddolt'))).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.FACTORY_BD
    else process.env.FACTORY_BD = saved
  }
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
  git('update-ref', 'refs/dolt/data', 'HEAD')
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
