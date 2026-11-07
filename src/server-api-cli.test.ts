import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = () => mkdtempSync(join(tmpdir(), 'sapi-'))
const cli = join(import.meta.dir, 'cli.ts')
const WORKER = [
  'FACTORY_OUTBOX',
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'BEADS_ACTOR',
]
const cleanEnv = (home: string) => {
  const e: Record<string, string | undefined> = {
    ...process.env,
    FACTORY_HOME: home,
    FACTORY_SELF_UPDATE: '0',
  }
  for (const k of WORKER) delete e[k]
  return e as Record<string, string>
}
const cert = (dir: string, ...rest: string[]) =>
  Bun.spawnSync([process.execPath, cli, 'cert', 'person', dir, ...rest], { env: cleanEnv(tmp()) })

describe('factory cert person', () => {
  test('prints the owner steps and no key text', () => {
    const dir = join(tmp(), 'out')
    const p = cert(dir, 'factory.lan')
    expect(p.exitCode).toBe(0)
    const out = p.stdout.toString()
    expect(out).toContain('factory-server-tls')
    expect(out).toContain('factory-person-ca')
    expect(out).not.toContain('PRIVATE KEY')
    expect(existsSync(join(dir, 'person.crt'))).toBe(true)
  })
  test('a second run on the same dir exits 1', () => {
    const dir = join(tmp(), 'out')
    expect(cert(dir, 'factory.lan').exitCode).toBe(0)
    expect(cert(dir, 'factory.lan').exitCode).toBe(1)
  })
  test('a missing server-name exits 1 and writes nothing', () => {
    const dir = join(tmp(), 'out')
    expect(cert(dir).exitCode).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })
})
