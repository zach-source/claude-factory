import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HIDDEN, readSettings, SETTING_KEYS, setSetting, settingsRows, unsetSetting } from './settings'

const dirs: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'settings-rows-'))
  dirs.push(d)
  return join(d, 'settings.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const TOKEN = 'sk-ant-' + 'zq'.repeat(12)
const row = (rows: string[], key: string) => rows.find(r => r.startsWith(key + '  '))!

describe('settingsRows', () => {
  test('default, stored, environment and override rows', () => {
    const rows = settingsRows({ 'ax.vault': 'acme-vault', 'ax.image': 'img' }, { FACTORY_AX_VAULT: 'other' })
    expect(rows).toHaveLength(SETTING_KEYS.length)
    expect(row(rows, 'kubectl')).toBe('kubectl  kubectl  default')
    expect(row(rows, 'ax.context')).toBe('ax.context  (unset)  default')
    expect(row(rows, 'ax.image')).toBe('ax.image  img  stored')
    expect(row(rows, 'ax.vault')).toBe('ax.vault  other  environment (overrides stored)')
    expect(rows.join('\n')).not.toContain('acme-vault')
  })
  test('environment without a stored key, and equal to the stored value', () => {
    expect(row(settingsRows({}, { FACTORY_AX_VAULT: 'v' }), 'ax.vault')).toBe('ax.vault  v  environment')
    expect(row(settingsRows({ 'ax.vault': 'v' }, { FACTORY_AX_VAULT: 'v' }), 'ax.vault')).toBe(
      'ax.vault  v  stored',
    )
  })
  test('a secret value prints hidden', () => {
    const rows = settingsRows({ 'ax.vault': 'acme-vault' }, { FACTORY_AX_VAULT: TOKEN })
    expect(rows.join('\n')).not.toContain(TOKEN)
    expect(row(rows, 'ax.vault')).toContain(HIDDEN)
  })
  test('control, format and line-separator characters are escaped', () => {
    const bad = '\u001b\u009b\u0085  ‮'
    const out = row(settingsRows({ 'ax.image': 'a' + bad }, {}), 'ax.image')
    for (const c of bad) expect(out).not.toContain(c)
    expect(out).toContain('\\u{1B}')
    expect(out).toContain('\\u{202E}')
    expect(out).toContain('\\u{2028}')
  })
})

describe('a secret-class key in an error', () => {
  const msg = (f: () => void) => {
    try {
      f()
    } catch (e) {
      return (e as Error).message
    }
    return ''
  }
  test('setSetting, unsetSetting and readSettings print hidden', () => {
    const file = fresh()
    writeFileSync(file, JSON.stringify({ [TOKEN]: 'x' }))
    const other = fresh()
    for (const m of [
      msg(() => setSetting(other, TOKEN, 'x')),
      msg(() => unsetSetting(other, TOKEN)),
      msg(() => readSettings(file)),
    ]) {
      expect(m).toContain(HIDDEN)
      expect(m).not.toContain(TOKEN)
    }
  })
})
