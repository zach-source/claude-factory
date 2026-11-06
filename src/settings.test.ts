import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HIDDEN, readSettings, resolveSettings, SETTING_KEYS, setSetting, unsetSetting } from './settings'

const dirs: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'settings-'))
  dirs.push(d)
  return { d, file: join(d, 'settings.json') }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const get = (rows: ReturnType<typeof resolveSettings>, key: string) => rows.find(r => r.key === key)!
const TOKEN = 'sk-ant-' + 'zq'.repeat(12)

describe('AC1: order', () => {
  test('AC1 env only', () => {
    expect(get(resolveSettings({}, { FACTORY_AX_VAULT: 'e' }), 'ax.vault')).toEqual({
      key: 'ax.vault',
      value: 'e',
      source: 'environment',
    })
  })
  test('AC1 stored only', () => {
    expect(get(resolveSettings({ 'ax.vault': 's' }, {}), 'ax.vault')).toEqual({
      key: 'ax.vault',
      value: 's',
      source: 'stored',
    })
  })
  test('AC1 env beats stored', () => {
    const r = get(resolveSettings({ 'ax.vault': 's' }, { FACTORY_AX_VAULT: 'e' }), 'ax.vault')
    expect(r.value).toBe('e')
    expect(r.source).toBe('environment')
  })
  test('AC1 stored beats default', () => {
    expect(get(resolveSettings({ kubectl: 'k' }, {}), 'kubectl')).toEqual({
      key: 'kubectl',
      value: 'k',
      source: 'stored',
    })
  })
  test('AC1 default, and undefined without a default', () => {
    expect(get(resolveSettings({}, {}), 'kubectl')).toEqual({
      key: 'kubectl',
      value: 'kubectl',
      source: 'default',
    })
    expect(get(resolveSettings({}, {}), 'ax.atespace').value).toBe('factory')
    expect(get(resolveSettings({}, {}), 'ax.capabilities').value).toBe('SETUID,SETGID,CHOWN')
    expect(get(resolveSettings({}, {}), 'max-runs').value).toBe('16')
    expect(get(resolveSettings({}, {}), 'ax.vault')).toEqual({
      key: 'ax.vault',
      value: undefined,
      source: 'default',
    })
  })
  test('AC1 an empty env value counts as set', () => {
    const r = get(
      resolveSettings({ 'ax.capabilities': 'A' }, { FACTORY_AX_CAPABILITIES: '' }),
      'ax.capabilities',
    )
    expect(r.value).toBe('')
    expect(r.source).toBe('environment')
  })
  test('AC1 a key with no env name ignores the environment', () => {
    const r = get(resolveSettings({}, { IMAGE_REGISTRY: 'x', 'image.registry': 'x' }), 'image.registry')
    expect(r.source).toBe('default')
    expect(r.value).toBeUndefined()
  })
})

describe('AC2: unknown key refused', () => {
  for (const k of [
    'nope',
    'toString',
    '__proto__',
    'constructor',
    'AX_IMAGE',
    'FACTORY_AX_IMAGE',
    'devenv.builder',
  ]) {
    test(`AC2 ${k}`, () => {
      const { file } = fresh()
      expect(() => setSetting(file, k, 'v')).toThrow()
      expect(() => unsetSetting(file, k)).toThrow()
      expect(existsSync(file)).toBe(false)
      setSetting(file, 'kubectl', 'k')
      const before = readFileSync(file)
      expect(() => setSetting(file, k, 'v')).toThrow()
      expect(() => unsetSetting(file, k)).toThrow()
      expect(readFileSync(file).equals(before)).toBe(true)
    })
  }
})

describe('AC3: secret-class value hidden', () => {
  test('AC3 hidden from env and from stored', () => {
    expect(get(resolveSettings({}, { FACTORY_AX_VAULT: TOKEN }), 'ax.vault').value).toBe(HIDDEN)
    expect(get(resolveSettings({ 'ax.vault': TOKEN }, {}), 'ax.vault').value).toBe(HIDDEN)
    expect(HIDDEN).toBe('<hidden>')
  })
  test('AC3 setSetting refuses it and the error holds no value', () => {
    const { file } = fresh()
    let msg = ''
    try {
      setSetting(file, 'ax.vault', TOKEN)
    } catch (e) {
      msg = String(e)
    }
    expect(msg).not.toBe('')
    expect(msg).not.toContain(TOKEN)
    expect(msg).not.toContain('zqzq')
    expect(existsSync(file)).toBe(false)
  })
  test('AC3 a command and a name show as written', () => {
    const cmd = 'op read op://<vault>/x/credential'
    const rows = resolveSettings({ 'token.read': cmd, 'ax.vault': 'acme' }, {})
    expect(get(rows, 'token.read').value).toBe(cmd)
    expect(get(rows, 'ax.vault').value).toBe('acme')
    const { file } = fresh()
    setSetting(file, 'token.read', cmd)
    expect(readSettings(file)['token.read']).toBe(cmd)
  })
})

describe('AC4: the file holds only the table', () => {
  test('AC4 set and unset sequence', () => {
    const { file } = fresh()
    setSetting(file, 'max-runs', '4')
    setSetting(file, 'ax.vault', 'acme')
    setSetting(file, 'max-runs', '8')
    unsetSetting(file, 'ax.vault')
    setSetting(file, 'kubectl', 'k')
    const o = JSON.parse(readFileSync(file, 'utf8'))
    expect(o).toEqual({ kubectl: 'k', 'max-runs': '8' })
    const keys = new Set(SETTING_KEYS.map(s => s.key))
    for (const [k, v] of Object.entries(o)) {
      expect(keys.has(k)).toBe(true)
      expect(typeof v).toBe('string')
    }
  })
  test('AC4 unset of an absent key on a missing file creates no file', () => {
    const { file } = fresh()
    unsetSetting(file, 'kubectl')
    expect(existsSync(file)).toBe(false)
  })
  test('AC4 a missing file reads as empty', () => {
    expect(readSettings(fresh().file)).toEqual({})
  })
  const bad: [string, string][] = [
    ['invalid JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown key', '{"nope":"x"}'],
    ['a prototype key', '{"__proto__":"x"}'],
    ['a non-string value', '{"kubectl":1}'],
  ]
  for (const [name, text] of bad) {
    test(`AC4 readSettings throws on ${name}`, () => {
      const { file } = fresh()
      writeFileSync(file, text)
      expect(() => readSettings(file)).toThrow(file)
      expect(() => setSetting(file, 'kubectl', 'k')).toThrow(file)
      expect(readFileSync(file, 'utf8')).toBe(text)
    })
  }
})

describe('AC5: atomic write', () => {
  test('AC5 no tmp file stays and the mode is 0600', () => {
    const { d, file } = fresh()
    setSetting(file, 'kubectl', 'k')
    unsetSetting(file, 'kubectl')
    setSetting(file, 'max-runs', '3')
    expect(readdirSync(d)).toEqual(['settings.json'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('AC6: value checks', () => {
  for (const v of ['a\nb', 'a\x00b', 'a\x1bb']) {
    test(`AC6 control character ${JSON.stringify(v)}`, () => {
      const { file } = fresh()
      for (const { key } of SETTING_KEYS) expect(() => setSetting(file, key, v)).toThrow()
      expect(existsSync(file)).toBe(false)
    })
  }
  test('AC6 max-runs', () => {
    const { file } = fresh()
    for (const v of ['0', '-1', 'abc', '1.5', '']) expect(() => setSetting(file, 'max-runs', v)).toThrow()
    setSetting(file, 'max-runs', '16')
    expect(readSettings(file)['max-runs']).toBe('16')
  })
})

describe('AC7: pure resolve', () => {
  test('AC7 one row per key, in table order, arguments unchanged', () => {
    const stored = { kubectl: 'k' }
    const env = { FACTORY_MAX_RUNS: '3' }
    const rows = resolveSettings(stored, env)
    expect(rows.map(r => r.key)).toEqual(SETTING_KEYS.map(s => s.key))
    expect(SETTING_KEYS.length).toBe(16)
    expect(stored).toEqual({ kubectl: 'k' })
    expect(env).toEqual({ FACTORY_MAX_RUNS: '3' })
  })
})
