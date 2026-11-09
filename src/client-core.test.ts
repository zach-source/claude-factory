import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCore } from './client'
import { take } from './lease'

const TOKEN = 'ab'.repeat(32)
const good = (o: { json?: object | null; lease?: object | null; token?: string | null } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'fc-'))
  const holder = `core:${process.pid}`
  if (o.json !== null)
    writeFileSync(
      join(home, 'core.json'),
      JSON.stringify({ port: 4321, pid: process.pid, holder, startedAt: 'x', catalogVersion: 1, ...o.json }),
    )
  if (o.lease !== null) take(home, { holder, kind: 'core', pid: process.pid, at: Date.now(), ...o.lease })
  if (o.token !== null) writeFileSync(join(home, 'core.token'), o.token ?? TOKEN)
  return home
}

test('a running core is found', () => {
  expect(findCore(good())).toEqual({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    port: 4321,
    pid: process.pid,
    holder: `core:${process.pid}`,
    catalogVersion: 1,
  })
  expect(findCore(good({ token: `${TOKEN}\n` }))?.token).toBe(TOKEN)
})

const nulls: [string, () => string][] = [
  ['no core.json', () => good({ json: null })],
  ['a stopped core (no pid)', () => good({ json: { pid: undefined, holder: undefined } })],
  ['a lease of another holder', () => good({ lease: { holder: 'pane:p9', kind: 'claude' } })],
  ['a lease of another holder with kind core', () => good({ lease: { holder: 'core:1', kind: 'core' } })],
  ['a lease of another kind', () => good({ lease: { kind: 'claude' } })],
  ['no lease', () => good({ lease: null })],
  ['a stale lease', () => good({ lease: { at: Date.now() - 120_000 } })],
  ['a dead pid', () => good({ json: { pid: 2 ** 22 + 99 } })],
  ['no token', () => good({ token: null })],
  ['a bad token', () => good({ token: 'abc' })],
  ['an upper case token', () => good({ token: TOKEN.toUpperCase() })],
  ['a token with two newlines', () => good({ token: `${TOKEN}\n\n` })],
]
for (const [name, mk] of nulls) test(`null for ${name}`, () => expect(findCore(mk())).toBeNull())
