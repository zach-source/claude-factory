// claude-factory-y3f8w.4: the codex chat of a limited manager keeps the gate and holds no secret
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainChatRefusal } from './core/caller'
import { codexChatLaunch } from './manager-codex'

const env = {
  PATH: '/bin',
  HOME: '/root',
  FACTORY_IN_AX: '1',
  FACTORY_AX_VAULT: 'v',
  FACTORY_ALLOW: '11111111-1111-4111-8111-111111111111',
  OPENAI_API_KEY: 'sk-real-looking',
  CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
  AX_AUTH_TOKEN: 'real-token',
  GH_TOKEN: 'ghs_x',
}

test('the codex chat launch sets the main-chat gate and carries no secret', () => {
  const l = codexChatLaunch({ cli: '/x/factory', home: '/h', env })
  expect(l.argv[0]).toBe('codex')
  expect(l.argv.at(-1)).toContain('/x/factory')
  expect(l.env.FACTORY_MAIN_CHAT).toBe('1')
  expect(l.env.FACTORY_HOME).toBe('/h')
  expect(l.env.FACTORY_IN_AX).toBe('1')
  expect(l.env.FACTORY_ALLOW).toBeUndefined()
  expect(l.env.OPENAI_API_KEY).toBe('placeholder')
  expect(l.env.AX_AUTH_TOKEN).toBeUndefined()
  expect(l.env.GH_TOKEN).toBeUndefined()
  expect(JSON.stringify(l)).not.toMatch(/sk-real|real-token|ghs_x/)
})

test('a gated kind is refused in the codex chat env, even if an Allow file exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'cchat-'))
  mkdirSync(join(home, 'allow'))
  const token = '11111111-1111-4111-8111-111111111111'
  writeFileSync(
    join(home, 'allow', `${token}.json`),
    JSON.stringify({ kinds: ['decide'], exp: Date.now() + 60_000 }),
  )
  const l = codexChatLaunch({ cli: 'factory', home, env })
  expect(mainChatRefusal(l.env, home, 'decide')).toContain("the person's call")
})
