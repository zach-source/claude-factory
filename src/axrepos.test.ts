import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  axRepoPath,
  bdEnv,
  beadsDirOf,
  hasRigBeads,
  httpsRemote,
  mapRigs,
  mapRunRepo,
  planRepoSync,
  syncRepos,
} from './axrepos'
import { bootstrapBeads, clone } from './worker'

const AX = { FACTORY_IN_AX: '1' }
const URL = 'https://github.com/acme/widget.git'

/** make git read the https URL as the local path `origin`; the returned function restores the env */
function mapOrigin(origin: string) {
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
  const saved = keys.map(k => process.env[k])
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.${origin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = URL
  return () =>
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k]
      else process.env[k] = saved[i]
    })
}

/** a fake git on PATH that logs its argv; ls-remote prints a refs/dolt/data line */
function fakeGit(root: string, exit: number) {
  const fake = join(root, 'bin')
  const log = join(root, 'git.log')
  mkdirSync(fake, { recursive: true })
  writeFileSync(
    join(fake, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = ls-remote ] && printf 'abc\\trefs/dolt/data\\n'\nexit ${exit}\n`,
    { mode: 0o755 },
  )
  return { fake, log }
}
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
  const restore = mapOrigin(origin)
  try {
    const home = join(root, 'home')
    const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
    const problems = syncRepos([{ name: 'widget', repo: '/x', remote: URL }], home, env)
    expect(problems.join('\n')).toContain('no refs/dolt/data')
    const dir = beadsDirOf(home, join(root, 'repos', 'widget'))
    expect(existsSync(join(dir, '.beads', 'embeddeddolt'))).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.FACTORY_BD
    else process.env.FACTORY_BD = saved
    restore()
  }
})

test('a rig with no .beads in git has beads in the task when it has a beadsRemote or a store in the home', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-has-'))
  const home = join(root, 'home')
  const env = { ...AX, FACTORY_HOME: home }
  const repo = join(root, 'repos', 'widget')
  const remote = { url: 'dolt://dolt.example/widget', user: 'u' }
  const plain = [{ name: 'widget', repo }]
  const remoted = [{ name: 'widget', repo, beadsRemote: remote }]
  expect(hasRigBeads(repo, plain, env)).toBe(false)
  expect(hasRigBeads(repo, remoted, env)).toBe(true)
  expect(hasRigBeads(join(root, 'other'), remoted, env)).toBe(false)
  mkdirSync(join(beadsDirOf(home, repo), '.beads'), { recursive: true })
  expect(hasRigBeads(repo, plain, env)).toBe(true)
  // a .beads in the repo counts everywhere
  mkdirSync(join(root, 'git', '.beads'), { recursive: true })
  expect(hasRigBeads(join(root, 'git'), plain, {})).toBe(true)
})

test('on the laptop a beadsRemote and a home store do not make beads: only the repo .beads does', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-has-'))
  const repo = join(root, 'widget')
  const rig = { name: 'widget', repo, beadsRemote: { url: 'dolt://dolt.example/widget', user: 'u' } }
  mkdirSync(join(beadsDirOf(join(root, 'home'), repo), '.beads'), { recursive: true })
  expect(hasRigBeads(repo, [rig], { FACTORY_HOME: join(root, 'home') })).toBe(false)
})

test('repos sync bootstraps a rig with a beadsRemote and no .beads in git, from the remote', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-sync-'))
  const origin = join(root, 'origin')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  mkdirSync(origin, { recursive: true })
  writeFileSync(join(origin, 'README'), 'x\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const bd = join(root, 'bd')
  writeFileSync(bd, '#!/bin/sh\nmkdir -p .beads/embeddeddolt\n', { mode: 0o755 })
  const saved = process.env.FACTORY_BD
  process.env.FACTORY_BD = bd
  const restore = mapOrigin(origin)
  try {
    const home = join(root, 'home')
    const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
    const beadsRemote = { url: 'dolt://dolt.example/widget', user: 'u' }
    const problems = syncRepos([{ name: 'widget', repo: '/x', remote: URL, beadsRemote }], home, env)
    expect(problems).toEqual([])
    const clone = join(root, 'repos', 'widget')
    const dir = beadsDirOf(home, clone)
    expect(readFileSync(join(dir, '.beads', 'config.yaml'), 'utf8')).toBe(
      `sync.remote: "${beadsRemote.url}"\n`,
    )
    expect(JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')).DOLT_REMOTE_USER).toBe('u')
    expect(bdEnv(clone, env).BEADS_DIR).toBe(join(dir, '.beads'))
  } finally {
    if (saved === undefined) delete process.env.FACTORY_BD
    else process.env.FACTORY_BD = saved
    restore()
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
  const restore = mapOrigin(origin)
  try {
    const home = join(root, 'home')
    const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
    const problems = syncRepos([{ name: 'widget', repo: '/x', remote: URL }], home, env)
    expect(problems).toEqual([])
    const clone = join(root, 'repos', 'widget')
    const dir = beadsDirOf(home, clone)
    expect(readFileSync(join(dir, '.beads', 'config.yaml'), 'utf8')).toBe(`sync.remote: "git+${origin}"\n`)
    expect(readFileSync(join(dir, 'env.json'), 'utf8')).toBe('{}')
    expect(bdEnv(clone, env).BEADS_DIR).toBe(join(dir, '.beads'))
  } finally {
    if (saved === undefined) delete process.env.FACTORY_BD
    else process.env.FACTORY_BD = saved
    restore()
  }
})

const SHAPE = 'it must be an https:// or git@ URL'
const USER = 'it carries a user or password'
const CLONE = { rig: 'widget', path: '/workspace/w/repos/widget', do: 'clone', url: URL }
const refused = (why: string) => ({
  rig: 'widget',
  path: '/workspace/w/repos/widget',
  do: 'missing',
  why: `rig widget: the "remote" in rigs.json is refused: ${why}`,
})

test('remoteRefusal: only https (git@ maps to it) with no user or password goes to git', () => {
  const rows: [string, unknown][] = [
    [URL, CLONE],
    ['git@github.com:acme/widget.git', CLONE],
    ['ssh://git@github.com/acme/widget.git', CLONE],
    ...[
      '--upload-pack=touch x',
      '-c',
      'http://github.com/acme/widget.git',
      'ssh://deploy@github.com/acme/widget.git',
      'file:///srv/widget',
      '/srv/widget',
      'ext::sh -c touch% x',
      ` ${URL}`,
      `${URL}\n`,
      'https://',
      'https://[github.com/acme/widget.git',
      'https://github.com:99999/acme/widget.git',
    ].map((u): [string, unknown] => [u, refused(SHAPE)]),
    ...[
      'https://user:zqsecret@github.com/acme/widget.git',
      'https://zqsecret@github.com/acme/widget.git',
      'https://@github.com/acme/widget.git',
      'https://github.com@evil.example/acme/widget.git',
      'https:///user:zqsecret@github.com/acme/widget.git',
      'https:////user:zqsecret@github.com/acme/widget.git',
      'https://github.com\\@evil.example/x',
      'git@u:tok@github.com/acme/widget',
    ].map((u): [string, unknown] => [u, refused(USER)]),
  ]
  for (const [remote, want] of rows) {
    const got = planRepoSync([{ name: 'widget', repo: '/x', remote }], () => false, AX)
    expect(got).toEqual([want as never])
    expect(JSON.stringify(got)).not.toContain('zqsecret')
  }
})

function withFakePath<T>(fake: string, f: () => T) {
  const saved = process.env.PATH
  process.env.PATH = `${fake}:${saved}`
  try {
    return f()
  } finally {
    process.env.PATH = saved
  }
}

test('a refused remote makes no git call and no repos dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-sync-'))
  const home = join(root, 'home')
  const { fake, log } = fakeGit(root, 1)
  const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
  const problems = withFakePath(fake, () =>
    syncRepos([{ name: 'widget', repo: '/x', remote: '--upload-pack=touch x' }], home, env),
  )
  expect(problems).toEqual([`rig widget: the "remote" in rigs.json is refused: ${SHAPE}`])
  expect(existsSync(log)).toBe(false)
  expect(existsSync(join(root, 'repos'))).toBe(false)
})

test('git clone gets -- before the URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-sync-'))
  const home = join(root, 'home')
  const { fake, log } = fakeGit(root, 1)
  const env = { ...AX, FACTORY_HOME: home, FACTORY_REPOS: join(root, 'repos') }
  const problems = withFakePath(fake, () =>
    syncRepos([{ name: 'widget', repo: '/x', remote: URL }], home, env),
  )
  expect(problems).toHaveLength(1)
  expect(problems[0]).toStartWith('widget: git clone:')
  expect(readFileSync(log, 'utf8')).toBe(`clone -q -- ${URL} ${join(root, 'repos', 'widget')}\n`)
})

test('bootstrapBeads gives git -- before the origin in ls-remote and remote add', () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-sync-'))
  const { fake, log } = fakeGit(root, 0)
  const bd = join(root, 'bd')
  writeFileSync(bd, '#!/bin/sh\nmkdir -p .beads/embeddeddolt\n', { mode: 0o755 })
  const saved = process.env.FACTORY_BD
  process.env.FACTORY_BD = bd
  try {
    bootstrapBeads(join(root, 'store'), undefined, URL, {
      ...process.env,
      PATH: `${fake}:${process.env.PATH}`,
    })
  } finally {
    if (saved === undefined) delete process.env.FACTORY_BD
    else process.env.FACTORY_BD = saved
  }
  const lines = readFileSync(log, 'utf8').split('\n')
  expect(lines).toContain(`ls-remote -- ${URL} refs/dolt/data`)
  expect(lines).toContain(`remote add -- origin ${URL}`)
})

test('clone gives git -- before FACTORY_REPO in both clone calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'axrepos-clone-'))
  const fake = join(root, 'bin')
  const log = join(root, 'git.log')
  mkdirSync(fake, { recursive: true })
  writeFileSync(
    join(fake, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho 'Remote branch main not found in upstream origin' >&2\nexit 1\n`,
    { mode: 0o755 },
  )
  const keys = ['FACTORY_REPO', 'FACTORY_BRANCH', 'FACTORY_WORKER_DIR', 'FACTORY_WORKER_REPO', 'PATH']
  const saved = keys.map(k => process.env[k])
  process.env.FACTORY_REPO = URL
  process.env.FACTORY_BRANCH = 'main'
  process.env.FACTORY_WORKER_DIR = join(root, 'own')
  process.env.FACTORY_WORKER_REPO = join(root, 'repo')
  process.env.PATH = `${fake}:${process.env.PATH}`
  mkdirSync(process.env.FACTORY_WORKER_DIR, { recursive: true })
  try {
    await clone({ tries: 1, waitMs: 0 }).catch(() => undefined)
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])))
  }
  const lines = readFileSync(log, 'utf8').split('\n')
  expect(lines.some(l => l.startsWith(`clone --branch main -- ${URL} `))).toBe(true)
  expect(lines.some(l => l.startsWith(`clone -- ${URL} `))).toBe(true)
})
