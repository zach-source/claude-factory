// `factory settings list|set|unset` end to end: a fresh FACTORY_HOME for each test.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const TOKEN = 'ghp_' + 'z'.repeat(36)

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'settings-cli-'))
  dirs.push(home)
  const file = join(home, 'settings.json')
  const run = (args: string[], env: Record<string, string> = {}) => {
    const clean = { ...process.env } as Record<string, string | undefined>
    for (const k of Object.keys(clean))
      if (/^(FACTORY_(OUTBOX|FROM|RUN|DEF_NAME|AX_.*|KUBECTL|MAX_RUNS)|BEADS_ACTOR)$/.test(k)) delete clean[k]
    const p = Bun.spawnSync([CLI, ...args], {
      env: {
        ...clean,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_GC: '0',
        FACTORY_NO_KICK: '1',
        ...env,
      } as Record<string, string>,
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  return { file, run }
}

describe('settings list', () => {
  test('set then list shows stored and default sources; unset puts the row back', () => {
    const { run } = setup()
    const set = run(['settings', 'set', 'ax.vault', 'acme-vault'])
    expect(set.code).toBe(0)
    expect(set.out).toContain('set ax.vault')
    const list = run(['settings', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toContain('ax.vault  acme-vault  stored')
    expect(list.out).toContain('kubectl  kubectl  default')
    const un = run(['settings', 'unset', 'ax.vault'])
    expect(un.code).toBe(0)
    expect(un.out).toContain('unset ax.vault')
    expect(run(['settings']).out).toContain('ax.vault  (unset)  default')
  })
  test('an environment value over a stored one is named, and the stored value stays hidden', () => {
    const { run } = setup()
    run(['settings', 'set', 'ax.vault', 'acme-vault'])
    const list = run(['settings', 'list'], { FACTORY_AX_VAULT: 'other' })
    expect(list.out).toContain('ax.vault  other  environment (overrides stored)')
    expect(list.out).not.toContain('acme-vault')
    const same = run(['settings', 'list'], { FACTORY_AX_VAULT: 'acme-vault' })
    expect(same.out).toContain('ax.vault  acme-vault  stored')
    expect(run(['settings', 'list']).out).not.toContain('overrides')
  })
  test('an environment value with no stored key is plain environment', () => {
    const { run } = setup()
    expect(run(['settings', 'list'], { FACTORY_AX_VAULT: 'v' }).out).toContain('ax.vault  v  environment\n')
  })
  test('a secret value from the environment prints hidden', () => {
    const { run } = setup()
    const r = run(['settings', 'list'], { FACTORY_AX_VAULT: TOKEN })
    expect(r.out).toContain('<hidden>')
    expect(r.out + r.err).not.toContain(TOKEN)
  })
})

describe('settings set and unset errors', () => {
  test('a secret value is refused, never stored, never printed', () => {
    const { run, file } = setup()
    const r = run(['settings', 'set', 'ax.vault', TOKEN])
    expect(r.code).toBe(1)
    expect(r.out + r.err).not.toContain(TOKEN)
    expect(existsSync(file)).toBe(false)
  })
  test.each([
    [['settings', 'set', 'nope', 'x']],
    [['settings', 'unset', 'nope']],
    [['settings', 'set', TOKEN, 'x']],
    [['settings', 'set', 'max-runs', 'abc']],
    [['settings', 'bogus']],
    [['settings', 'set', 'ax.vault']],
    [['settings', 'set', 'ax.vault', 'a', 'b']],
    [['settings', 'unset']],
    [['settings', 'unset', 'ax.vault', 'extra']],
    [['settings', 'list', 'extra']],
  ])('%j exits 1 and changes no file', args => {
    const { run, file } = setup()
    const r = run(args)
    expect(r.code).toBe(1)
    expect(r.out + r.err).not.toContain(TOKEN)
    expect(existsSync(file)).toBe(false)
  })
})

describe('a worker', () => {
  test.each([[{ FACTORY_FROM: 'implement' }], [{ BEADS_ACTOR: 'factory/r1/plan' }]])(
    '%j cannot set or unset',
    env => {
      const { run, file } = setup()
      for (const args of [
        ['settings', 'set', 'ax.vault', 'x'],
        ['settings', 'unset', 'ax.vault'],
        ['settings', 'set', 'devenv.builder', 'x'],
        ['settings', 'unset', 'devenv.builder'],
      ]) {
        const r = run(args, env)
        expect(r.code).toBe(1)
        expect(r.err).toContain('a worker cannot run factory settings')
      }
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(file, '..', 'devenv.json'))).toBe(false)
    },
  )
  test('the file keeps its form after a set', () => {
    const { run, file } = setup()
    run(['settings', 'set', 'max-runs', '4'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'max-runs': '4' })
  })
})

describe('settings devenv.*', () => {
  const PUSH = `nix shell nixpkgs#attic-client -c sh -euc 'attic login c <cache-server> "$(cat /run/secrets/cache)" >/dev/null && attic push c:<cache> $ROOTS'`
  const TOK = 'op read op://<vault>/cache/credential'
  test('set writes devenv.json, list shows rows, unset removes one', () => {
    const { run, file } = setup()
    const df = join(file, '..', 'devenv.json')
    for (const [k, v] of [
      ['builder', 'acme-builder'],
      ['token', TOK],
      ['push', PUSH],
    ] as const)
      expect(run(['settings', 'set', `devenv.${k}`, v]).out).toContain(`set devenv.${k}`)
    expect(JSON.parse(readFileSync(df, 'utf8'))).toEqual({ builder: 'acme-builder', token: TOK, push: PUSH })
    expect(existsSync(file)).toBe(false)
    expect(run(['settings', 'list']).out).toContain('devenv.builder  acme-builder  stored')
    expect(run(['settings', 'unset', 'devenv.builder']).code).toBe(0)
    expect(JSON.parse(readFileSync(df, 'utf8'))).toEqual({ token: TOK, push: PUSH })
    expect(run(['settings', 'list']).out).toContain('devenv.builder  (unset)  default')
  })
  test.each([
    ['devenv.foo', 'x'],
    ['devenv.token', TOKEN],
    ['devenv.token', ''],
  ])('%s %j is refused and writes nothing', (k, v) => {
    const { run, file } = setup()
    const r = run(['settings', 'set', k, v])
    expect(r.code).toBe(1)
    expect(r.out + r.err).not.toContain(TOKEN)
    expect(existsSync(join(file, '..', 'devenv.json'))).toBe(false)
  })
})
