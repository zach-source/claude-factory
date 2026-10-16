// `factory memory compact`, end to end through bin/factory (claude-factory-59r.13).
// A live dream holds dream.lock while it merges and archives notes.
// A concurrent `memory compact` can race it and lose a rename or an archive decision.
// `memory compact` (not --dry-run) must take the same lock. It must refuse while a dream holds it.
// It must release the lock, so a later compact can still run.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-compact-lock-${process.pid}`)
const home = join(dir, 'home')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[]) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], { env: { ...laptop, FACTORY_HOME: home } })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

test('factory memory compact refuses while a dream holds dream.lock, and runs once it lets go', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'dream.lock'), { recursive: true })
  // this test process's own pid: alive for as long as the test runs, so hold() sees a live holder
  writeFileSync(join(home, 'dream.lock', 'pid'), String(process.pid))

  const blocked = run(['memory', 'compact'])
  expect(blocked.code).toBe(0)
  expect(blocked.out).toContain('a dream is already running')
  expect(existsSync(join(home, 'memory', '.git'))).toBe(false) // nothing written while blocked

  rmSync(join(home, 'dream.lock'), { recursive: true, force: true })
  const ok = run(['memory', 'compact'])
  expect(ok.code).toBe(0)
  expect(ok.out).toContain('compact: 0 merged, 0 archived')
  expect(existsSync(join(home, 'memory', '.git'))).toBe(true)
  expect(existsSync(join(home, 'dream.lock'))).toBe(false) // released after it finished
})

test('factory memory compact --dry-run never takes the lock: it reports only, so it never races a dream', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'dream.lock'), { recursive: true })
  writeFileSync(join(home, 'dream.lock', 'pid'), String(process.pid))

  const dry = run(['memory', 'compact', '--dry-run'])
  expect(dry.code).toBe(0)
  expect(dry.out).toContain('nothing to merge or archive')
})

// a fresh CI runner (ubuntu-latest) has no `git config --global user.name`/`user.email`: PR #45's
// first real CI run failed this exact way (claude-factory-5h9.17). GIT_CONFIG_GLOBAL/SYSTEM point
// at a file that does not exist, so git sees no identity anywhere, the same as that runner.
test('factory memory compact commits even with no git identity configured anywhere (a fresh CI runner)', () => {
  rmSync(dir, { recursive: true, force: true })
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL,
    ...laptop
  } = process.env
  const p = Bun.spawnSync([CLI, 'memory', 'compact'], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      GIT_CONFIG_GLOBAL: join(dir, 'no-such-gitconfig'),
      GIT_CONFIG_SYSTEM: join(dir, 'no-such-gitconfig'),
    },
  })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toContain('compact: 0 merged, 0 archived')
  expect(existsSync(join(home, 'memory', '.git'))).toBe(true)
})

// claude-factory-5h9.18: a box with a real git identity in global config, but no GIT_* env vars,
// must keep that identity. The factory@localhost fallback is for a box with NO identity anywhere.
test('factory memory compact keeps a configured git identity instead of overriding it with factory@localhost', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const configFile = join(dir, 'gitconfig-with-identity')
  writeFileSync(configFile, '[user]\n\tname = Zach Taylor\n\temail = zach@example.com\n')
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL,
    ...laptop
  } = process.env
  const p = Bun.spawnSync([CLI, 'memory', 'compact'], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      GIT_CONFIG_GLOBAL: configFile,
      GIT_CONFIG_SYSTEM: join(dir, 'no-such-gitconfig'),
    },
  })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toContain('compact: 0 merged, 0 archived')
  const author = Bun.spawnSync(['git', '-C', join(home, 'memory'), 'log', '-1', '--format=%an <%ae>'])
    .stdout.toString()
    .trim()
  expect(author).toBe('Zach Taylor <zach@example.com>')
})
