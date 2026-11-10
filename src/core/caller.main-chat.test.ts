import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATED_KINDS } from '../../mod/hooks/view'
import { MAIN_CHAT_KINDS, mainChatKind, mainChatRefusal } from './caller'

test('mainChatKind is a closed table (AC3)', () => {
  const k = mainChatKind
  expect(k('decide', ['r1', 'ship'])).toBe('decide')
  expect(k('decisions', ['answer', 'a', 'b'])).toBe('answer')
  expect(k('decisions', ['propose', 'x'])).toBeUndefined()
  expect(k('start', ['lifecycle', 'api', 'x', '--owned'])).toBe('owned')
  expect(k('start', ['lifecycle', 'api', 'x'])).toBeUndefined()
  expect(k('wiki', ['init'])).toBe('wiki-init')
  expect(k('wiki', ['find', 'x'])).toBeUndefined()
  expect(k('image', [])).toBe('image')
  expect(k('token', ['use', 'a'])).toBe('token')
  expect(k('token', ['best'])).toBe('token')
  expect(k('token', [])).toBeUndefined()
  expect(k('token', ['list'])).toBeUndefined()
  expect(k('status', [])).toBeUndefined()
  expect(new Set(MAIN_CHAT_KINDS)).toEqual(new Set(GATED_KINDS.map(g => g.id)))
})

const fresh = () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-'))
  mkdirSync(join(home, 'allow'))
  return home
}
const U = '123e4567-e89b-12d3-a456-426614174000'
const put = (home: string, name: string, body: string) => writeFileSync(join(home, 'allow', name), body)
const ok = (kinds: string[] = ['decide'], exp = Date.now() + 60_000) => JSON.stringify({ kinds, exp })
const DENIED = "without the person's Allow (FACTORY_MAIN_CHAT is set)"

test('mainChatRefusal rows (AC4)', () => {
  const home = fresh()
  const r = (env: Record<string, string | undefined>, kind = 'decide') => mainChatRefusal(env, home, kind)
  const M = { FACTORY_MAIN_CHAT: '1' }
  expect(r({})).toBeUndefined()
  expect(r(M)).toContain(DENIED)
  for (const bad of ['../x', 'a/b', '']) {
    put(home, 'x.json', ok())
    expect(r({ ...M, FACTORY_ALLOW: bad })).toContain(DENIED)
    expect(existsSync(join(home, 'allow', 'x.json'))).toBe(true)
  }
  put(home, `${U}.json`, ok())
  expect(r({ ...M, FACTORY_ALLOW: U })).toBeUndefined()
  expect(existsSync(join(home, 'allow', `${U}.json`))).toBe(false)
  expect(r({ ...M, FACTORY_ALLOW: U })).toContain(DENIED)
  put(home, `${U}.json`, ok(['answer']))
  expect(r({ ...M, FACTORY_ALLOW: U })).toContain(DENIED)
  put(home, `${U}.json`, ok(['decide'], Date.now() - 1))
  expect(r({ ...M, FACTORY_ALLOW: U })).toContain(DENIED)
  put(home, `${U}.json`, '')
  expect(r({ ...M, FACTORY_ALLOW: U })).toContain(DENIED)
  put(home, `${U}.json`, '{nope')
  expect(r({ ...M, FACTORY_ALLOW: U })).toContain(DENIED)
})
