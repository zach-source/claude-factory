// `factory token` end to end with a fake file store: a fresh FACTORY_HOME for each test.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const USAGE = 'usage: factory token [list] | use <n> | best'

const setup = (store = true, overrides: Record<string, string> = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'token-cli-'))
  dirs.push(tmp)
  const home = join(tmp, 'home')
  mkdirSync(home)
  mkdirSync(join(tmp, 'store'))
  const read = (file: string) => (existsSync(join(tmp, file)) ? readFileSync(join(tmp, file), 'utf8') : '')
  const log = `printf '%s\\n' "$0 $*" >> '${tmp}/argv.log'\n`
  writeFileSync(join(tmp, 'read.sh'), `${log}[ -f '${tmp}/store/'"$1" ] || exit 1\ncat '${tmp}/store/'"$1"\n`)
  writeFileSync(
    join(tmp, 'write.sh'),
    `${log}printf '%s\\n' "$1" >> '${tmp}/writes.log'\ncat > '${tmp}/store/'"$1"\n`,
  )
  for (const [field, value] of Object.entries({
    account_1_token: 'zqsecret-1',
    account_2_token: 'zqsecret-2',
    live: 'old',
    active: '1',
  }))
    writeFileSync(join(tmp, 'store', field), value)
  if (store)
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        'token.read': `sh '${tmp}/read.sh' "$1"`,
        'token.write': `sh '${tmp}/write.sh' "$1"`,
        'token.live-field': 'live',
        'token.slot-field': 'account_%s_token',
        'token.active-field': 'active',
        ...overrides,
      }),
    )
  const run = (args: string[], env: Record<string, string> = {}) => {
    const clean = { ...process.env } as Record<string, string | undefined>
    for (const k of Object.keys(clean))
      if (/^(FACTORY_(OUTBOX|FROM|RUN|DEF_NAME|PATROL|SERVER|AX_.*|KUBECTL|MAX_RUNS)|BEADS_ACTOR)$/.test(k))
        delete clean[k]
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
    const r = { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
    expect(r.out + r.err + read('argv.log')).not.toContain('zqsecret')
    return r
  }
  return { read, run, live: () => readFileSync(join(tmp, 'store', 'live'), 'utf8') }
}

describe('factory token', () => {
  test('token use 2 makes slot 2 live', () => {
    const { run, live, read } = setup()
    const r = run(['token', 'use', '2'])
    expect(r.code).toBe(0)
    expect(r.out).toBe('slot 2 is live; agent-vault picks it up within 5 minutes\n')
    expect(live()).toBe('zqsecret-2')
    expect(read('store/active')).toBe('2')
  })

  test('unconfigured store prints how to set token.read and token.write', () => {
    const { run } = setup(false)
    for (const args of [[], ['list'], ['use', '2'], ['best']]) {
      const r = run(['token', ...args])
      expect(r.code).toBe(1)
      expect(r.err).toContain('token.read')
      expect(r.err).toContain('token.write')
      expect(r.err).toContain('factory settings set')
    }
  })

  test('a locked store exits 1 with no change', () => {
    const { run, live, read } = setup(true, { 'token.read': 'exit 1' })
    for (const args of [['list'], ['use', '2']]) {
      const r = run(['token', ...args])
      expect(r.code).toBe(1)
      expect(r.out).toBe('')
    }
    expect(read('writes.log')).toBe('')
    expect(live()).toBe('old')
  })

  test('a bad argument form exits 1 with the usage and no store call', () => {
    const { run, read } = setup()
    for (const args of [['use', '1e1'], ['swap']]) {
      const r = run(['token', ...args])
      expect(r.code).toBe(1)
      expect(r.err).toContain(USAGE)
    }
    expect(read('argv.log')).toBe('')
  })

  test('workers and patrols cannot run factory token', () => {
    const { run, read } = setup()
    for (const env of <Record<string, string>[]>[
      { FACTORY_FROM: 'x' },
      { FACTORY_RUN: 'r1' },
      { FACTORY_PATROL: '1' },
    ])
      for (const args of [['list'], ['use', '2']]) {
        const r = run(['token', ...args], env)
        expect(r.code).toBe(1)
        expect(r.err).toContain('cannot run factory token')
      }
    expect(read('argv.log')).toBe('')
  })

  test('help names factory token', () => {
    const { run } = setup(false)
    const r = run(['help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "  token [list] | use <n> | best        Claude token slots: the live slot and each slot's 7d and 5h use; make slot n live, or the slot with the lowest 7d use\n",
    )
  })
})
