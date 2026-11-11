import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCommand,
  build,
  checkout,
  cacheKey,
  cacheProposal,
  configMissing,
  DOCKERFILE,
  isDue,
  remoteDevenv,
  writeGhcrConfig,
  type ProposalRig,
} from './devenv'

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
  expect(isDue({ ...stamp, ok: false }, key)).toBe(true) // a failed build is retried on the next pass
  expect(isDue(stamp, cacheKey(first.blobs, 'img@2'))).toBe(true)

  // code changes leave the devenv as it was; a lock change is a new build, seen after a fetch
  writeFileSync(join(origin, 'main.go'), 'package main // two\n')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'code')
  expect(cacheKey(remoteDevenv(clone).blobs, 'img@1')).toBe(key)
  writeFileSync(join(origin, 'devenv.lock'), '{"v":2}\n')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'lock')
  expect(isDue(stamp, cacheKey(remoteDevenv(clone).blobs, 'img@1'))).toBe(true)
}, 30_000) // real git init, commit and clone: about 17 git spawns

test('the devenv builds at the path the VM clones to, since its derivations depend on it', () => {
  expect(DOCKERFILE).toContain('cp -a /src/. /workspace/w/repo/ && cd /workspace/w/repo')
})

test('the build mounts the source context, drops the gh secret, and uses a GitHub token only when present', () => {
  expect(DOCKERFILE).toContain('--mount=type=bind,from=src,target=/src')
  expect(DOCKERFILE).toContain('id=github,required=false')
  expect(DOCKERFILE).not.toContain('id=gh,')
  expect(DOCKERFILE).not.toContain('fetch')
  expect(DOCKERFILE).toContain('if [ -s /run/secrets/github ]')
  expect(DOCKERFILE).toContain('git add -f -A')
})

const job = { cfg: { builder: 'tcp://b:443', token: 't', push: 'p' }, image: 'img', rev: 'r1', key: 'k1' }
const paths = { ctx: '/c', src: '/s', ca: '/ca.pem' }

test('buildCommand uses buildx where it exists and buildctl with a source context where it does not', () => {
  const x = buildCommand(job, paths, { buildx: true, github: false })
  expect(x.slice(0, 3)).toEqual(['docker', 'buildx', 'build'])
  expect(x).toContain('src=/s')
  expect(x.join(' ')).not.toContain('id=github')
  const c = buildCommand({ ...job, force: true }, paths, {
    buildx: false,
    github: true,
    prefix: ['nix', 'shell'],
  })
  expect(c.slice(0, 4)).toEqual(['nix', 'shell', 'buildctl', '--addr'])
  expect(c).toContain('tcp://b:443')
  expect(c).toContain('context:src=local:src')
  expect(c).toContain('src=/s')
  expect(c).toContain('id=github,env=FACTORY_DEVENV_GH')
  expect(c).toContain('--no-cache')
  expect(c.join(' ')).not.toContain('x-access-token')
})

test('checkout writes every file of a rev, export-ignore files too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devenv-co-'))
  const repo = join(dir, 'repo')
  git(dir, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, '.gitattributes'), 'secret.txt export-ignore\n')
  writeFileSync(join(repo, 'secret.txt'), 'kept\n')
  writeFileSync(join(repo, '.dockerignore'), '*\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one')
  const out = join(dir, 'out')
  mkdirSync(out)
  expect(checkout(repo, 'HEAD', out, dir).ok).toBe(true)
  expect(readFileSync(join(out, 'secret.txt'), 'utf8')).toBe('kept\n')
  expect(readFileSync(join(out, '.dockerignore'), 'utf8')).toBe('*\n')
})

test('build gives the reason of a failed token command, writes it to the log, and prints no token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devenv-b-'))
  const log = join(dir, 'x.log')
  const r = build({ ...job.cfg, token: 'echo no op here >&2; exit 1' }, { ...job, repo: dir, log })
  expect(r.ok).toBe(false)
  expect(r.why).toBe('tokens: token command failed: no op here')
  expect(readFileSync(log, 'utf8')).toContain('token command failed')
  const g = build({ ...job.cfg, token: 'echo t', githubToken: 'exit 3' }, { ...job, repo: dir, log })
  expect(g.why).toContain('githubToken command failed')
})

test('configMissing names the fields that are absent, empty or not a string', () => {
  expect(configMissing({})).toEqual(['builder', 'token', 'push'])
  expect(configMissing({ builder: 'b' })).toEqual(['token', 'push'])
  expect(configMissing({ builder: '', token: 't', push: 'p' })).toEqual(['builder'])
  expect(configMissing({ builder: 1, token: 't', push: 'p' })).toEqual(['builder'])
  expect(configMissing({ builder: 'b', token: 't', push: 'p' })).toEqual([])
})

// claude-factory-ad6r AC7: factory devenv --missing
const CACHE = 'https://cache.example:8443/devenv devenv:key='
const tpl = (o: object = {}) => ({
  name: 'tpl',
  repo: '/r/tpl',
  runner: 'ax',
  env: { FACTORY_NIX_CACHE: CACHE },
  egress: [{ hosts: ['cache.example'], key: 'NIX_CACHE', port: 8443 }],
  ...o,
})
const cand = (o: object = {}) => ({ name: 'acme', repo: '/r/acme', runner: 'ax', ...o })
const proposal = (rigs: object[], has = true) => {
  const calls: string[] = []
  const lines = cacheProposal(rigs as ProposalRig[], r => (calls.push(r.name), has))
  return { lines, calls }
}
const COPY =
  'acme: copy FACTORY_NIX_CACHE and the egress rule for cache.example from rig tpl (factory rig show tpl)'

test('cacheProposal prints the two commands for an ax rig with a devenv and no cache', () => {
  const { lines, calls } = proposal([tpl(), cand()])
  expect(lines).toEqual([
    `factory rig env set acme 'FACTORY_NIX_CACHE=${CACHE}'`,
    `factory rig egress add acme 'cache.example=NIX_CACHE' --port 8443`,
  ])
  expect(calls).toEqual(['acme'])
  const withHeader = tpl({
    egress: [{ hosts: ['cache.example'], key: 'NIX_CACHE', header: 'Authorization', prefix: 'Bearer ' }],
  })
  expect(proposal([withHeader, cand()]).lines[1]).toBe(
    `factory rig egress add acme 'cache.example=NIX_CACHE:Authorization:Bearer '`,
  )
})

test('cacheProposal keeps the runtime header and prefix defaults of the rule', () => {
  const line = (o: object) =>
    proposal([tpl({ egress: [{ hosts: ['cache.example'], key: 'NIX_CACHE', ...o }] }), cand()]).lines[1]
  const add = (s: string) => `factory rig egress add acme '${s}'`
  expect(line({})).toBe(add('cache.example=NIX_CACHE'))
  expect(line({ prefix: 'Basic ' })).toBe(add('cache.example=NIX_CACHE:Authorization:Basic '))
  expect(line({ prefix: '' })).toBe(add('cache.example=NIX_CACHE:Authorization:'))
  expect(line({ header: 'X-Key' })).toBe(add('cache.example=NIX_CACHE:X-Key:Bearer '))
  expect(line({ header: 'X-Key', prefix: '' })).toBe(add('cache.example=NIX_CACHE:X-Key:'))
})

test('cacheProposal skips a rig with the cache, with no devenv.nix, or off ax', () => {
  expect(proposal([tpl(), cand({ env: { FACTORY_NIX_CACHE: CACHE } })]).lines).toEqual([])
  expect(proposal([tpl(), cand()], false).lines).toEqual([])
  const herdr = proposal([tpl(), cand({ runner: undefined })])
  expect(herdr.lines).toEqual([])
  expect(herdr.calls).toEqual([])
})

test('cacheProposal copies by hand when it cannot be sure of the rule', () => {
  const rule = (o: object) => tpl({ egress: [{ hosts: ['cache.example'], key: 'NIX_CACHE', ...o }] })
  const cases: object[] = [
    tpl({ egress: [] }), // no cache rule
    tpl({ egress: [{ hosts: ['cache.example'] }] }), // no key
    rule({ headers: [{ header: 'X', prefix: '', key: 'K' }] }),
    rule({ pathPrefixes: ['/a/'] }),
    rule({ http: true }),
    rule({ key: 'bad-key' }), // parseEgress refuses it
    tpl({ env: { FACTORY_NIX_CACHE: "https://cache.example:8443/d it's=" } }),
    tpl({ env: { FACTORY_NIX_CACHE: `https://cache.example:8443/d ghp_${'a'.repeat(36)}` } }),
    tpl({ env: { FACTORY_NIX_CACHE: 'https://u:p@cache.example/d key=' } }),
    tpl({ env: { FACTORY_NIX_CACHE: 'https://:p@cache.example/d key=' } }), // a password only: SECRETS matches it too
  ]
  for (const t of cases) expect(proposal([t, cand()]).lines).toEqual([COPY])
  // the candidate has the host in upper case
  expect(proposal([tpl(), cand({ egress: [{ hosts: ['CACHE.example'] }] })]).lines).toEqual([COPY])
})

test('cacheProposal prints one line and asks hasDevenv for no rig when it has no usable template', () => {
  const none = 'no ax rig has a usable FACTORY_NIX_CACHE: nothing to copy'
  for (const rigs of [
    [cand()],
    [tpl({ env: { FACTORY_NIX_CACHE: 'https://cache.example' } }), cand()], // one word
    [tpl({ env: { FACTORY_NIX_CACHE: 'not-a-url key=' } }), cand()],
    [tpl({ runner: undefined }), cand()],
  ]) {
    const { lines, calls } = proposal(rigs)
    expect(lines).toEqual([none])
    expect(calls).toEqual([])
  }
})

test('factory devenv --missing prints the commands, changes no file and refuses other args', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devenv-missing-'))
  const origin = join(dir, 'origin')
  const clone = join(dir, 'clone')
  git(dir, 'init', '-q', '-b', 'main', origin)
  writeFileSync(join(origin, 'devenv.nix'), '{ }\n')
  git(origin, 'add', '.')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one')
  git(dir, 'clone', '-q', origin, clone)
  const home = join(dir, 'home')
  mkdirSync(home)
  const rigsFile = join(home, 'rigs.json')
  writeFileSync(rigsFile, JSON.stringify([tpl(), cand({ repo: clone })]))
  const before = readFileSync(rigsFile, 'utf8')
  const env = {
    ...process.env,
    FACTORY_HOME: home,
    FACTORY_SELF_UPDATE: '0',
    FACTORY_NO_KICK: '1',
  } as Record<string, string | undefined>
  delete env.FACTORY_OUTBOX
  delete env.FACTORY_FROM
  const cli = join(import.meta.dir, '..', 'bin', 'factory')
  const ok = Bun.spawnSync([cli, 'devenv', '--missing'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(ok.stderr.toString()).toBe('')
  expect(ok.stdout.toString().trim().split('\n')).toEqual([
    `factory rig env set acme 'FACTORY_NIX_CACHE=${CACHE}'`,
    `factory rig egress add acme 'cache.example=NIX_CACHE' --port 8443`,
  ])
  expect(readFileSync(rigsFile, 'utf8')).toBe(before)
  const bad = Bun.spawnSync([cli, 'devenv', '--missing', 'x'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(bad.exitCode).toBe(1)
  expect(bad.stderr.toString()).toContain(
    'usage: factory devenv [rig...] [--force] | factory devenv --missing',
  )
}, 60_000)

test('writeGhcrConfig writes a placeholder ghcr.io login and no real secret', () => {
  const dir = writeGhcrConfig(join(mkdtempSync(join(tmpdir(), 'devenv-g-')), 'docker'))
  const c = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  expect(Buffer.from(c.auths['ghcr.io'].auth, 'base64').toString()).toBe('placeholder:placeholder')
})
