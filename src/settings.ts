import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { SECRETS } from './secrets'

/** One factory setting. `env` is the variable that overrides it. `check` is the shape a stored value must have. */
export type SettingKey = { key: string; env?: string; default?: string; check?: RegExp }
export type Source = 'environment' | 'stored' | 'default'
export type Resolved = { key: string; value: string | undefined; source: Source }

export const HIDDEN = '<hidden>'

/** The table of data-model.md ("Factory setting"). A key outside it is refused. The defaults copy src/ax.ts and src/cli.ts. */
export const SETTING_KEYS: readonly SettingKey[] = [
  { key: 'ax.image', env: 'FACTORY_AX_IMAGE' },
  { key: 'ax.manager-image', env: 'FACTORY_AX_MANAGER_IMAGE' },
  { key: 'ax.vault', env: 'FACTORY_AX_VAULT' },
  { key: 'ax.context', env: 'FACTORY_AX_CONTEXT' },
  { key: 'ax.atespace', env: 'FACTORY_AX_ATESPACE', default: 'factory' },
  { key: 'ax.capabilities', env: 'FACTORY_AX_CAPABILITIES', default: 'SETUID,SETGID,CHOWN' },
  { key: 'ax.env', env: 'FACTORY_AX_ENV' },
  { key: 'kubectl', env: 'FACTORY_KUBECTL', default: 'kubectl' },
  // a non-number makes Number() give NaN, and NaN removes the run cap (cli.ts)
  { key: 'max-runs', env: 'FACTORY_MAX_RUNS', default: '16', check: /^[1-9][0-9]*$/ },
  { key: 'image.registry' },
  { key: 'image.builder' },
  { key: 'token.read' },
  { key: 'token.write' },
  { key: 'token.live-field' },
  { key: 'token.slot-field' },
  { key: 'token.active-field' },
]

// a Map, not an object: 'toString' and '__proto__' must not count as keys
const BY_KEY = new Map(SETTING_KEYS.map(s => [s.key, s]))

const isSecret = (v: string) => SECRETS.some(re => re.test(v))

/** Environment beats stored beats default. A secret-class value shows as `<hidden>`. Pure: no file, no change to the arguments. */
export const resolveSettings = (
  stored: Record<string, string>,
  env: Record<string, string | undefined>,
): Resolved[] =>
  SETTING_KEYS.map(({ key, env: name, default: def }) => {
    let value: string | undefined = def
    let source: Source = 'default'
    if (name !== undefined && env[name] !== undefined) {
      value = env[name]
      source = 'environment'
    } else if (Object.hasOwn(stored, key)) {
      value = stored[key]
      source = 'stored'
    }
    return { key, value: value !== undefined && isSecret(value) ? HIDDEN : value, source }
  })

/** Reads settings.json. A missing file gives {}. Any other defect throws with the path; the text never goes in the message. */
export const readSettings = (file: string): Record<string, string> => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`cannot read ${file}`)
  }
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`${file} is not a JSON object`)
  for (const [k, v] of Object.entries(o)) {
    if (!BY_KEY.has(k)) throw new Error(`${file} holds the unknown setting ${JSON.stringify(k)}`)
    if (typeof v !== 'string') throw new Error(`${file}: the value of ${k} is not a string`)
  }
  return o as Record<string, string>
}

const known = (key: string) => {
  const s = BY_KEY.get(key)
  if (!s) throw new Error(`unknown setting ${JSON.stringify(key)}`)
  return s
}

// ponytail: no lock, so two writers at the same time can lose one update. Upgrade path: the lock of src/rigs-edit.ts.
const write = (file: string, o: Record<string, string>) => {
  const sorted: Record<string, string> = {}
  for (const { key } of SETTING_KEYS) if (Object.hasOwn(o, key)) sorted[key] = o[key]!
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(sorted, null, 2) + '\n')
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
  closeSync(fd)
  renameSync(tmp, file)
}

/** Stores one value. Refuses an unknown key, a control character, a bad shape and a secret-class value. */
export const setSetting = (file: string, key: string, value: string) => {
  const s = known(key)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`the value of ${key} holds a control character`)
  if (s.check && !s.check.test(value)) throw new Error(`the value of ${key} must match ${s.check}`)
  if (isSecret(value)) throw new Error(`the value of ${key} looks like a secret; store a name or a command`)
  const o = readSettings(file)
  o[key] = value
  write(file, o)
}

/** Removes one key. An absent key on a missing file creates no file. */
export const unsetSetting = (file: string, key: string) => {
  known(key)
  const o = readSettings(file)
  if (!Object.hasOwn(o, key)) return
  delete o[key]
  write(file, o)
}

/** Fills env from the stored settings. An env var that is already set wins. A missing file changes nothing. */
export const loadIntoEnv = (file: string, env: Record<string, string | undefined> = process.env) => {
  let stored: Record<string, string>
  try {
    stored = readSettings(file)
  } catch (e) {
    console.error(`factory: ignoring ${file}: ${(e as Error).message}`)
    return
  }
  for (const { key, env: name } of SETTING_KEYS)
    if (name !== undefined && env[name] === undefined && Object.hasOwn(stored, key)) env[name] = stored[key]
}
