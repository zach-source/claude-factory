import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainChatRefusal } from './caller'

// claude-factory-d289.25: the token of an Allow for this turn (turn: true) is read and kept
const U = '123e4567-e89b-12d3-a456-426614174000'
const DENIED = "without the person's Allow (FACTORY_MAIN_CHAT is set)"

test('mainChatRefusal keeps a turn token for many calls and refuses it empty, expired or too far out', () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-'))
  mkdirSync(join(home, 'allow'))
  const file = join(home, 'allow', `${U}.json`)
  const r = (kind = 'answer') => mainChatRefusal({ FACTORY_MAIN_CHAT: '1', FACTORY_ALLOW: U }, home, kind)
  const turn = (exp: number, kinds = ['answer']) => JSON.stringify({ kinds, exp, turn: true })
  writeFileSync(file, turn(Date.now() + 60_000))
  expect(r()).toBeUndefined()
  expect(r()).toBeUndefined()
  expect(r()).toBeUndefined()
  expect(existsSync(file)).toBe(true)
  expect(r('decide')).toContain(DENIED)
  writeFileSync(file, turn(Date.now() - 1))
  expect(r()).toContain(DENIED)
  writeFileSync(file, turn(Date.now() + 31 * 60_000))
  expect(r()).toContain(DENIED)
  writeFileSync(file, '')
  expect(r()).toContain(DENIED)
})
