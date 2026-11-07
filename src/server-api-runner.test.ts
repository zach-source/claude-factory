import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliRunner, personEnv } from './server-api'

const tmp = () => mkdtempSync(join(tmpdir(), 'sapi-r-'))
const NAMES = [
  'FACTORY_SERVER',
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'FACTORY_OUTBOX',
  'BEADS_ACTOR',
]

describe('personEnv', () => {
  for (const name of NAMES)
    test(`drops ${name}`, () => {
      const e = personEnv({ [name]: 'x', KEEP: 'y' }, '/h')
      expect(name in e).toBe(false)
      expect(e.KEEP).toBe('y')
    })
  test('sets FACTORY_HOME and FACTORY_SELF_UPDATE=0 over the caller value', () => {
    const e = personEnv({ FACTORY_HOME: '/other', FACTORY_SELF_UPDATE: '1' }, '/h')
    expect(e.FACTORY_HOME).toBe('/h')
    expect(e.FACTORY_SELF_UPDATE).toBe('0')
  })
})

describe('cliRunner', () => {
  const env = () => {
    for (const n of NAMES) delete process.env[n]
  }
  test('status on a fresh home exits 0', async () => {
    env()
    const home = tmp()
    const r = await cliRunner(home)(['status'])
    expect(r.code).toBe(0)
    expect(r.out.length).toBeGreaterThan(0)
  })
  test('a mail call leaves no text file, also when the CLI exits 1', async () => {
    env()
    const home = tmp()
    const r = await cliRunner(home)(['mail', 'nope', 'plan'], 'secret body')
    expect(r.code).toBe(1)
    expect(r.err).toContain('no run')
    const dir = join(home, 'text')
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })
  test('a timeout kills the process and reports timedOut', async () => {
    env()
    const home = tmp()
    const r = await cliRunner(home, undefined, 50)(['status'])
    expect(r.timedOut).toBe(true)
  })
})
