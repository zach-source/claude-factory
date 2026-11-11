import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientListener, managerCert, personCerts } from './server-api'

const root = mkdtempSync(join(tmpdir(), 'mcert-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const dir = join(root, 'c')
personCerts(dir, 'localhost')
const read = (f: string) => readFileSync(join(dir, f), 'utf8')

test('managerCert makes a CN=manager cert; the key is 0600; no helper file stays', () => {
  const out = managerCert(dir)
  expect(out).toContain('manager.crt')
  expect(statSync(join(dir, 'manager.key')).mode & 0o777).toBe(0o600)
  const subject = Bun.spawnSync(['openssl', 'x509', '-noout', '-subject', '-in', join(dir, 'manager.crt')])
  expect(subject.stdout.toString().replace(/ /g, '')).toContain('CN=manager')
  for (const f of ['manager.csr', 'manager.ext', 'ca.srl']) expect(Bun.file(join(dir, f)).size).toBe(0)
})

test('managerCert refuses to overwrite, and a folder with no CA', () => {
  expect(() => managerCert(dir)).toThrow(/exists/)
  expect(() => managerCert(join(root, 'none'))).toThrow(/no ca/)
})

test('the manager cert passes mTLS and maps to the manager role; the person cert stays person', async () => {
  const seen: string[] = []
  const l = clientListener({
    port: 0,
    cert: read('server.crt'),
    key: read('server.key'),
    ca: read('ca.crt'),
    handle: async (_r, _ip, who) => (seen.push(who), new Response('ok')),
  })
  const get = (who: string) =>
    new Promise<number>((ok, bad) => {
      const r = request(
        {
          host: 'localhost',
          port: l.port,
          path: '/v1/status',
          cert: read(`${who}.crt`),
          key: read(`${who}.key`),
          ca: read('ca.crt'),
          agent: false,
        },
        res => (res.resume(), ok(res.statusCode ?? 0)),
      )
      r.on('error', bad)
      r.end()
    })
  try {
    expect(await get('manager')).toBe(200)
    expect(await get('person')).toBe(200)
    expect(seen).toEqual(['manager', 'person'])
  } finally {
    l.stop()
  }
})
