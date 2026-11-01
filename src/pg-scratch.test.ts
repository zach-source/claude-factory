import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { guardRm, pgScratch, sockDir } from './pg-scratch'

const CLI = join(import.meta.dir, 'cli.ts')
const INITDB = Bun.which('initdb')
const HAVE = !!INITDB && !!Bun.which('psql')
const REQUIRE = process.env.PG_SCRATCH_REQUIRE === '1'
const WHY = 'no initdb (set PG_SCRATCH_REQUIRE=1 to fail)'
if (REQUIRE && !HAVE)
  test('pg-scratch [REQUIRED: initdb or psql missing from PATH]', () => {
    throw new Error('PG_SCRATCH_REQUIRE=1 but initdb or psql is not on PATH')
  })
const dbTest = (name: string, fn: () => void | Promise<void>) =>
  HAVE ? test(name, fn, 60000) : test.skip(`${name} [${WHY}]`, fn)

const roots: string[] = []
const repo = (parent = tmpdir(), name = 'pgs-test-'): string => {
  const d = realpathSync(mkdtempSync(join(parent, name)))
  roots.push(d)
  Bun.spawnSync(['git', 'init', '-q', d])
  return d
}
const clean = (extra: Record<string, string> = {}) => {
  const env = {
    ...process.env,
    FACTORY_SELF_UPDATE: '0',
    FACTORY_HOME: mkdtempSync(join(tmpdir(), 'pgs-home-')),
    ...extra,
  }
  delete env.FACTORY_OUTBOX
  delete env.FACTORY_FROM
  delete env.FACTORY_RUN
  return env as Record<string, string>
}
const cli = (cwd: string, args: string[], env = clean()) => {
  const r = Bun.spawnSync(['bun', CLI, 'pg-scratch', ...args], { cwd, env })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const psql = (url: string, sql: string) => {
  const r = Bun.spawnSync(['psql', url, '-Atc', sql])
  return { code: r.exitCode, out: r.stdout.toString().trim() }
}
const urlOf = (out: string) => out.trim().replace(/^TEST_DATABASE_URL=/, '')

afterAll(() => {
  for (const d of roots) {
    Bun.spawnSync(['bun', CLI, 'pg-scratch', 'stop'], { cwd: d, env: clean() })
    rmSync(d, { recursive: true, force: true })
  }
})

dbTest('start prints one URL line, psql answers, stop removes everything (AC1, AC2, AC3, AC4)', () => {
  const top = repo()
  const t0 = Date.now()
  const a = cli(top, ['start'])
  expect(a.code).toBe(0)
  expect(a.out).toMatch(/^TEST_DATABASE_URL=postgres:\/\/postgres@\/postgres\?host=\S+&sslmode=disable\n$/)
  const url = urlOf(a.out)
  expect(psql(url, 'select 1')).toEqual({ code: 0, out: '1' })
  expect(Date.now() - t0).toBeLessThan(30000)
  expect(existsSync(join(top, '.scratch', 'pg-scratch', 'data'))).toBe(true)
  expect(psql(url, 'show listen_addresses').out).toBe('')
  // a second start prints the same URL and keeps the server
  const pid = psql(url, 'select pg_backend_pid()').out
  const b = cli(top, ['start'])
  expect(b.code).toBe(0)
  expect(b.out).toBe(a.out)
  expect(b.err).not.toContain('initdb')
  const s = cli(top, ['stop'])
  expect(s.code).toBe(0)
  expect(existsSync(join(top, '.scratch', 'pg-scratch'))).toBe(false)
  expect(psql(url, 'select 1').code).not.toBe(0)
  expect(pid).not.toBe('')
  expect(cli(top, ['stop']).code).toBe(0)
})

dbTest('start reuses a stopped data dir without initdb (AC3)', () => {
  const top = repo()
  expect(cli(top, ['start']).code).toBe(0)
  const data = join(top, '.scratch', 'pg-scratch', 'data')
  const url = urlOf(cli(top, ['start']).out)
  const mark = psql(url, "create table keep(x int); insert into keep values (7); select 'ok'").code
  expect(mark).toBe(0)
  const bin = dirname(realpathSync(INITDB!))
  expect(Bun.spawnSync([join(bin, 'pg_ctl'), '-D', data, '-m', 'fast', '-w', 'stop']).exitCode).toBe(0)
  const again = cli(top, ['start'])
  expect(again.code).toBe(0)
  expect(psql(urlOf(again.out), 'select x from keep').out).toBe('7')
  expect(cli(top, ['stop']).code).toBe(0)
})

dbTest('a long path and a path with a space use /tmp/pgs-<hash> and still answer (AC2)', () => {
  const long = repo(tmpdir(), 'pgs-' + 'x'.repeat(90) + '-')
  const space = repo(tmpdir(), 'pgs space-')
  for (const top of [long, space]) {
    expect(sockDir(top)).toMatch(/^\/tmp\/pgs-[0-9a-f]{12}$/)
    const r = cli(top, ['start'])
    expect(r.code).toBe(0)
    expect(urlOf(r.out)).toContain(`host=${sockDir(top)}&`)
    expect(psql(urlOf(r.out), 'select 1').out).toBe('1')
    expect(cli(top, ['stop']).code).toBe(0)
    expect(existsSync(sockDir(top))).toBe(false)
    expect(existsSync(join(top, '.scratch', 'pg-scratch'))).toBe(false)
  }
})

dbTest('two worktrees run side by side (AC5)', () => {
  const [a, b] = [repo(), repo()]
  const ua = urlOf(cli(a, ['start']).out)
  const ub = urlOf(cli(b, ['start']).out)
  expect(ua).not.toBe(ub)
  expect(psql(ua, 'show data_directory').out).toBe(join(a, '.scratch', 'pg-scratch', 'data'))
  expect(psql(ub, 'show data_directory').out).toBe(join(b, '.scratch', 'pg-scratch', 'data'))
  expect(cli(a, ['stop']).code).toBe(0)
  expect(psql(ub, 'select 1').out).toBe('1')
  expect(cli(b, ['stop']).code).toBe(0)
})

test('sockDir uses .scratch for a short path (AC2)', () => {
  expect(sockDir('/w/a')).toBe('/w/a/.scratch/pg-scratch')
})

test('guardRm deletes only the two directories the command makes (AC4)', () => {
  const top = '/w/repo'
  for (const bad of [
    '/',
    top,
    join(top, '.scratch'),
    '/tmp/pgs-x',
    '/tmp/pgs-0123456789abc',
    '/tmp/pgs-0123456789ab/..',
    join(top, '.scratch', 'pg-scratch', 'data'),
  ])
    expect(() => guardRm(bad, top)).toThrow('refusing')
  expect(guardRm(join(top, '.scratch', 'pg-scratch'), top)).toBe(join(top, '.scratch', 'pg-scratch'))
  expect(guardRm('/tmp/pgs-0123456789ab', top)).toBe('/tmp/pgs-0123456789ab')
})

test('a bad form prints the usage, exits 2 and spawns no initdb (AC6)', () => {
  const top = repo()
  const bindir = join(top, 'fakebin')
  mkdirSync(bindir)
  const mark = join(top, 'ran')
  writeFileSync(join(bindir, 'initdb'), `#!/bin/sh\ntouch ${mark}\n`)
  chmodSync(join(bindir, 'initdb'), 0o755)
  const env = clean({ PATH: `${bindir}:${process.env.PATH}` })
  for (const args of [[], ['status'], ['start', 'x'], ['--help'], ['-h'], ['stop', 'x']]) {
    const r = cli(top, args, env)
    expect(r.code).toBe(2)
    expect(r.err).toContain('usage: factory pg-scratch start|stop')
  }
  expect(existsSync(mark)).toBe(false)
})

test('outside a git worktree it exits 1 and makes nothing (AC6)', () => {
  const d = realpathSync(mkdtempSync(join('/tmp', 'pgs-nogit-')))
  roots.push(d)
  const r = cli(d, ['start'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('pg-scratch: not in a git worktree')
  expect(existsSync(join(d, '.scratch'))).toBe(false)
})

test('uid 0 is refused before any spawn (AC6)', () => {
  const top = repo()
  expect(pgScratch(['start'], { cwd: top, env: { PATH: '' }, uid: 0 })).toBe(1)
  expect(existsSync(join(top, '.scratch'))).toBe(false)
})

test('binaries: no initdb and no nix gives the error; a fake nix gives the bin dir (AC7)', () => {
  const top = repo()
  // git lives next to initdb on the laptop, so the PATH gets symlinks to bun and git only
  const tools = join(top, 'tools')
  mkdirSync(tools)
  symlinkSync(process.execPath, join(tools, 'bun'))
  symlinkSync(Bun.which('git')!, join(tools, 'git'))
  const none = cli(top, ['start'], clean({ PATH: tools }))
  expect(none.code).toBe(1)
  expect(none.err).toContain('pg-scratch: no initdb on PATH and nix build nixpkgs#postgresql failed')
  const out = join(top, 'store')
  mkdirSync(join(out, 'bin'), { recursive: true })
  for (const n of ['initdb', 'pg_ctl']) {
    writeFileSync(join(out, 'bin', n), `#!/bin/sh\necho "fake $0" >&2\nexit 9\n`)
    chmodSync(join(out, 'bin', n), 0o755)
  }
  const bin = join(top, 'nixbin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'nix'), `#!/bin/sh\necho ${out}\n`)
  chmodSync(join(bin, 'nix'), 0o755)
  const via = cli(top, ['start'], clean({ PATH: `${bin}:${tools}` }))
  expect(via.err).toContain(`fake ${join(out, 'bin', 'initdb')}`)
  expect(via.err).toContain('pg-scratch: initdb failed')
})

dbTest('a PATH symlink to the real bin works (AC7)', () => {
  const top = repo()
  const link = join(top, 'linkbin')
  mkdirSync(link)
  symlinkSync(realpathSync(INITDB!), join(link, 'initdb'))
  const r = cli(top, ['start'], clean({ PATH: `${link}:${process.env.PATH}` }))
  expect(r.code).toBe(0)
  expect(cli(top, ['stop']).code).toBe(0)
})
