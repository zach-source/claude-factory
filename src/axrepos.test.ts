import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  planRepoSync,
  stationRunnerName,
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

test('only a bare herdr pane id is a laptop pane, and only in the AX manager', () => {
  expect(isLaptopPane(true, 'wA6:p1')).toBe(true)
  expect(isLaptopPane(true, 'ax://f-run')).toBe(false)
  expect(isLaptopPane(true, null)).toBe(false)
  expect(isLaptopPane(false, 'wA6:p1')).toBe(false)
})
