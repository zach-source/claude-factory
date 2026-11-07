import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { personCerts } from './server-api'

const tmp = () => mkdtempSync(join(tmpdir(), 'sapi-'))
const x509 = (file: string) =>
  Bun.spawnSync(['openssl', 'x509', '-in', file, '-noout', '-text']).stdout.toString()

describe('personCerts', () => {
  test('makes 6 files, a 0700 dir and 0600 keys', () => {
    const dir = join(tmp(), 'certs')
    personCerts(dir, '10.0.0.5')
    expect(readdirSync(dir).sort()).toEqual([
      'ca.crt',
      'ca.key',
      'person.crt',
      'person.key',
      'server.crt',
      'server.key',
    ])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const k of ['ca.key', 'person.key', 'server.key'])
      expect(statSync(join(dir, k)).mode & 0o777).toBe(0o600)
  })
  test('refuses an existing dir and changes nothing', () => {
    const dir = join(tmp(), 'certs')
    personCerts(dir, 'factory.lan')
    const before = readFileSync(join(dir, 'ca.key'), 'utf8')
    expect(() => personCerts(dir, 'factory.lan')).toThrow(/exists/)
    expect(readFileSync(join(dir, 'ca.key'), 'utf8')).toBe(before)
  })
  test('refuses a bad server name and makes no dir', () => {
    const dir = join(tmp(), 'certs')
    for (const n of ['', '-x', 'a b', 'a;b', 'a/b', '$(id)'])
      expect(() => personCerts(dir, n)).toThrow(/server-name/)
    expect(existsSync(dir)).toBe(false)
  })
  test('server cert has the SAN; person cert is a client cert for CN=person', () => {
    const dir = join(tmp(), 'certs')
    personCerts(dir, '10.0.0.5')
    expect(x509(join(dir, 'server.crt'))).toContain('IP Address:10.0.0.5')
    expect(x509(join(dir, 'person.crt'))).toMatch(/CN\s*=\s*person/)
    expect(x509(join(dir, 'person.crt'))).toContain('TLS Web Client Authentication')
    const d2 = join(tmp(), 'c2')
    personCerts(d2, 'factory.lan')
    expect(x509(join(d2, 'server.crt'))).toContain('DNS:factory.lan')
  })
})
