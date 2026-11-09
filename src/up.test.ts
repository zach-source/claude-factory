import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultHome, inStore, needsInstall, platformHome, upCheck, upDir } from './up'

const HERDR = 'factory up: not in a herdr pane; start herdr first so workers get panes'

test('upCheck: names each missing tool, bun first', () => {
  expect(upCheck(() => true, {}).errors).toEqual([])
  expect(upCheck(t => t !== 'bun', {}).errors).toEqual(['bun not on PATH'])
  expect(upCheck(t => t !== 'claude', {}).errors).toEqual(['claude not on PATH'])
  expect(upCheck(() => false, {}).errors).toEqual(['bun not on PATH', 'claude not on PATH'])
})

test('upCheck: only HERDR_ENV=1 stops the herdr warning', () => {
  expect(upCheck(() => true, { HERDR_ENV: '1' }).warnings).toEqual([])
  for (const v of [undefined, '', '0', 'true'])
    expect(upCheck(() => true, { HERDR_ENV: v }).warnings).toEqual([HERDR])
})

test('upDir: first arg, else FACTORY_HOME, else the default home', () => {
  expect(upDir(['/x', '--resume', 's'], {}, '/home/u', '/d')).toEqual({ dir: '/x', rest: ['--resume', 's'] })
  expect(upDir(['--resume', 's'], { FACTORY_HOME: '/h' }, '/home/u', '/d')).toEqual({
    dir: '/h',
    rest: ['--resume', 's'],
  })
  expect(upDir([], {}, '/home/u', '/d')).toEqual({ dir: '/d', rest: [] })
  expect(upDir([], { FACTORY_HOME: '' }, '/home/u', '/d').dir).toBe('/d')
  expect(upDir(['-'], {}, '/home/u', '/d')).toEqual({ dir: '/d', rest: ['-'] })
  expect(upDir(['rel'], {}, '/home/u', '/d').dir).toBe(resolve('rel'))
  expect(upDir(['~/x'], {}, '/home/u', '/d').dir).toBe('/home/u/x')
  expect(upDir([], {}, '/home/u', '/u/Application Support/f').dir).toBe('/u/Application Support/f')
})

test('platformHome: XDG_DATA_HOME, else the macOS or Linux data dir', () => {
  expect(platformHome({ XDG_DATA_HOME: '/x' }, 'darwin', '/u')).toBe('/x/claude-factory')
  expect(platformHome({ XDG_DATA_HOME: '' }, 'darwin', '/u')).toBe(
    '/u/Library/Application Support/claude-factory',
  )
  expect(platformHome({}, 'linux', '/u')).toBe('/u/.local/share/claude-factory')
})

test('defaultHome: the new dir, unless only an old default holds a factory', () => {
  const has = (dirs: string[]) => (d: string) => dirs.includes(d)
  expect(defaultHome('/new', ['/a', '/b'], has([]))).toEqual({ dir: '/new' })
  expect(defaultHome('/new', ['/a', '/b'], has(['/new', '/a']))).toEqual({ dir: '/new' })
  const old = defaultHome('/new', ['/a', '/b'], has(['/b']))
  expect(old.dir).toBe('/b')
  expect(old.note).toContain('/new')
})

test('needsInstall: missing or older node_modules', () => {
  expect(needsInstall(undefined, 5)).toBe(true)
  expect(needsInstall(4, 5)).toBe(true)
  expect(needsInstall(5, 5)).toBe(false)
  expect(needsInstall(6, 5)).toBe(false)
})

test('inStore: only a Nix store path', () => {
  expect(inStore('/nix/store/abc-claude-factory/share/claude-factory')).toBe(true)
  expect(inStore('/home/u/claude-factory')).toBe(false)
})

const CLI = join(import.meta.dir, 'cli.ts')
const tmp = join(tmpdir(), `up-test-${process.pid}`)
const bin = join(tmp, 'bin')
const log = join(tmp, 'claude.log')
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** a fresh tmp with a fake claude (logs cwd|FACTORY_HOME|FACTORY_AX_IMAGE|argv); bun is linked into bin unless dropped */
function fresh(tools = ['claude', 'bun']) {
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  if (tools.includes('claude'))
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$(pwd -P)" "$FACTORY_HOME" "$FACTORY_AX_IMAGE" "$*" >> ${log}\n`,
      { mode: 0o755 },
    )
  if (tools.includes('bun')) Bun.spawnSync(['ln', '-s', process.execPath, join(bin, 'bun')])
}

/** runs `factory up` with only bin, /usr/bin and /bin on PATH and none of the worker markers */
function up(args: string[], env: Record<string, string> = {}) {
  const e: Record<string, string | undefined> = { ...process.env }
  for (const k of [
    'FACTORY_OUTBOX',
    'FACTORY_FROM',
    'FACTORY_RUN',
    'FACTORY_DEF_NAME',
    'BEADS_ACTOR',
    'FACTORY_PATROL',
    'FACTORY_AX_CONTEXT',
    'HERDR_ENV',
    'FACTORY_AX_IMAGE',
  ])
    delete e[k]
  const p = Bun.spawnSync([process.execPath, CLI, 'up', ...args], {
    timeout: 30000,
    env: {
      ...e,
      PATH: `${bin}:/usr/bin:/bin`,
      FACTORY_HOME: join(tmp, 'caller'),
      FACTORY_SELF_UPDATE: '0',
      FACTORY_GC: '0',
      FACTORY_NO_KICK: '1',
      ...env,
    },
  })
  return { p, err: p.stderr.toString() }
}

test('AC4: a new directory gets a factory and the manager starts', () => {
  fresh()
  const dir = join(tmp, 'new')
  const { p, err } = up([dir, '--resume', 's1'])
  expect(p.exitCode).toBe(0)
  expect(readFileSync(join(dir, 'rigs.json'), 'utf8').trim()).toBe('[]')
  const rows = readFileSync(log, 'utf8').trim().split('\n')
  expect(rows).toHaveLength(1)
  const [cwd, home, , argv] = rows[0]!.split('|')
  expect(cwd).toBe(realpathSync(dir))
  expect(home).toBe(dir)
  expect(argv).toContain('--resume')
  expect(argv).toContain('s1')
  expect(err).toContain(HERDR)
})

test('AC4: HERDR_ENV=1 gives no warning', () => {
  fresh()
  const { p, err } = up([join(tmp, 'new')], { HERDR_ENV: '1' })
  expect(p.exitCode).toBe(0)
  expect(err).not.toContain('not in a herdr pane')
})

test('AC4: an existing factory keeps its rigs.json and init does not run', () => {
  fresh()
  const dir = join(tmp, 'old')
  mkdirSync(dir)
  writeFileSync(join(dir, 'rigs.json'), '[ ]\n')
  const { p, err } = up([dir])
  expect(p.exitCode).toBe(0)
  expect(readFileSync(join(dir, 'rigs.json'), 'utf8')).toBe('[ ]\n')
  expect(err).not.toContain('a new factory')
})

test('AC5: a missing tool exits 1, names it, makes nothing', () => {
  for (const [tools, name] of [
    [['bun'], 'claude'],
    [['claude'], 'bun'],
  ] as const) {
    fresh([...tools])
    const { p, err } = up([join(tmp, 'new')])
    expect(p.exitCode).toBe(1)
    expect(err).toContain(`${name} not on PATH`)
    expect(existsSync(join(tmp, 'new', 'rigs.json'))).toBe(false)
    expect(existsSync(log)).toBe(false)
  }
})

test('the default home has a space (the macOS path): up makes the factory there and the manager runs in it', () => {
  fresh()
  const data = join(tmp, 'Application Support')
  const dir = join(data, 'claude-factory')
  const { p, err } = up([], { FACTORY_HOME: '', XDG_DATA_HOME: data, HOME: join(tmp, 'u') })
  expect(p.exitCode).toBe(0)
  expect(readFileSync(join(dir, 'rigs.json'), 'utf8').trim()).toBe('[]')
  const [cwd, home] = readFileSync(log, 'utf8').trim().split('|')
  expect(cwd).toBe(realpathSync(dir))
  expect(home).toBe(dir)
  expect(err).not.toContain('old default home')
})

test('an old ~/factory with a rigs.json stays the home, with a note naming the new path', () => {
  fresh()
  const u = join(tmp, 'u')
  mkdirSync(join(u, 'factory'), { recursive: true })
  writeFileSync(join(u, 'factory', 'rigs.json'), '[]\n')
  const data = join(tmp, 'data')
  const { p, err } = up([], { FACTORY_HOME: '', XDG_DATA_HOME: data, HOME: u })
  expect(p.exitCode).toBe(0)
  expect(err).toContain(`the new default is ${join(data, 'claude-factory')}`)
  expect(existsSync(join(data, 'claude-factory'))).toBe(false)
})

test('AC6: a patrol cannot run up', () => {
  fresh()
  const { p, err } = up([join(tmp, 'new')], { FACTORY_PATROL: '1' })
  expect(p.exitCode).toBe(1)
  expect(err).toContain('a patrol cannot run factory up')
  expect(existsSync(join(tmp, 'new'))).toBe(false)
})

test('AC7: the caller home settings do not reach the manager; env does', () => {
  fresh()
  const caller = join(tmp, 'caller')
  mkdirSync(caller)
  writeFileSync(join(caller, 'settings.json'), JSON.stringify({ 'ax.image': 'leak' }))
  const image = () => {
    const row = readFileSync(log, 'utf8').trim().split('\n')[0]!
    rmSync(log)
    return row.split('|')[2]
  }
  expect(up([join(tmp, 'b')]).p.exitCode).toBe(0)
  expect(image()).toBe('')
  expect(up([join(tmp, 'b')], { FACTORY_AX_IMAGE: 'keep' }).p.exitCode).toBe(0)
  expect(image()).toBe('keep')
})
