import { readFileSync } from 'node:fs'
import { SECRETS } from './secrets'
import { writeFresh } from './write-fresh'

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
  // launchTask reads the file from the cwd of the process that launches, so a relative path breaks
  { key: 'ax.env', env: 'FACTORY_AX_ENV', check: /^\// },
  { key: 'kubectl', env: 'FACTORY_KUBECTL', default: 'kubectl' },
  // a non-number makes Number() give NaN, and NaN removes the run cap (cli.ts)
  { key: 'max-runs', env: 'FACTORY_MAX_RUNS', default: '16', check: /^[1-9][0-9]*$/ },
  // a launch uses cursor only while the weekly pool is under this percent (src/cursor-meter.ts); a number from 0 to 100
  { key: 'cursor.cap', env: 'FACTORY_CURSOR_CAP', default: '60', check: /^(100|[1-9]?[0-9])$/ },
  // an optional dollar cap on the Grok spend of the last 7 days (src/grok-meter.ts); unset means no gate
  // how an AX grok worker signs in: session (the owner's SuperGrok plan, through the gateway) or key (the paid xAI API)
  { key: 'grok.auth', env: 'FACTORY_GROK_AUTH', default: 'session', check: /^(session|key)$/ },
  { key: 'grok.weeklyBudgetUsd', env: 'FACTORY_GROK_WEEKLY_BUDGET_USD', check: /^\d+(\.\d+)?$/ },
  // the harness order of a station (cli.ts pickAgent). A gate refusal or a usage limit moves it to the next. cursor is in it only when named
  {
    key: 'agents.order',
    env: 'FACTORY_AGENTS_ORDER',
    default: 'claude,codex,grok,pi',
    check: /^(claude|codex|grok|pi|cursor)(,(claude|codex|grok|pi|cursor))*$/,
  },
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

/** a key for an error message: a secret-class key prints as `<hidden>` */
const shown = (k: string) => (isSecret(k) ? HIDDEN : JSON.stringify(k))

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

/** Escapes each control, format and line-separator character as `\u{XXXX}`, so a value cannot move the cursor or hide text. */
const escape = (v: string) =>
  v.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, c => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`)

/**
 * One line per setting, in table order: `key  value  source`. An environment value that differs from the stored one reads
 * `environment (overrides stored)`; the stored value never prints. Pass the env from before `loadIntoEnv`, or every stored key looks overridden.
 */
export const settingsRows = (
  stored: Record<string, string>,
  env: Record<string, string | undefined>,
): string[] =>
  resolveSettings(stored, env).map(({ key, value, source }) => {
    const has = Object.hasOwn(stored, key)
    const envValue = env[BY_KEY.get(key)!.env ?? '']
    let label: string = source
    if (source === 'environment' && has)
      label = envValue === stored[key] ? 'stored' : 'environment (overrides stored)'
    return `${key}  ${value === undefined ? '(unset)' : escape(value)}  ${label}`
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
    if (!BY_KEY.has(k)) throw new Error(`${file} holds the unknown setting ${shown(k)}`)
    if (typeof v !== 'string') throw new Error(`${file}: the value of ${k} is not a string`)
  }
  return o as Record<string, string>
}

const known = (key: string) => {
  const s = BY_KEY.get(key)
  if (!s) throw new Error(`unknown setting ${shown(key)}`)
  return s
}

// ponytail: no lock, so two writers at the same time can lose one update. Upgrade path: the lock of src/rigs-edit.ts.
const atomic = (file: string, text: string) => writeFresh(file, text, `${file}.${process.pid}.tmp`)

const write = (file: string, o: Record<string, string>) => {
  const sorted: Record<string, string> = {}
  for (const { key } of SETTING_KEYS) if (Object.hasOwn(o, key)) sorted[key] = o[key]!
  atomic(file, JSON.stringify(sorted, null, 2) + '\n')
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

/** The keys stored in devenv.json, not settings.json: its fields are builder, token and push. */
export const DEVENV_KEYS = ['devenv.builder', 'devenv.token', 'devenv.push'] as const
export const isDevenvKey = (k: string) => (DEVENV_KEYS as readonly string[]).includes(k)

/** Reads devenv.json. A missing file gives {}. Any other defect throws with the path; the text never goes in the message. */
export const readDevenv = (file: string): Record<string, unknown> => {
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
  return o as Record<string, unknown>
}

const devenvField = (key: string) => {
  if (!isDevenvKey(key)) throw new Error(`unknown setting ${shown(key)}`)
  return key.slice('devenv.'.length)
}

/** Stores one devenv field and keeps the others. Refuses an empty value, a control character and a secret-class value. */
export const setDevenv = (file: string, key: string, value: string) => {
  const field = devenvField(key)
  if (value === '') throw new Error(`the value of ${key} is empty`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`the value of ${key} holds a control character`)
  if (isSecret(value)) throw new Error(`the value of ${key} looks like a secret; store a name or a command`)
  const o = readDevenv(file)
  o[field] = value
  atomic(file, JSON.stringify(o, null, 2) + '\n')
}

/** Removes one devenv field. An absent field or file creates no file. */
export const unsetDevenv = (file: string, key: string) => {
  const field = devenvField(key)
  const o = readDevenv(file)
  if (!Object.hasOwn(o, field)) return
  delete o[field]
  atomic(file, JSON.stringify(o, null, 2) + '\n')
}

/** `key  value  stored` or `key  (unset)  default` for each devenv key. A secret-class value shows as `<hidden>`. */
export const devenvRows = (o: Record<string, unknown>): string[] =>
  DEVENV_KEYS.map(key => {
    const v = o[key.slice('devenv.'.length)]
    if (typeof v !== 'string') return `${key}  (unset)  default`
    return `${key}  ${isSecret(v) ? HIDDEN : escape(v)}  stored`
  })
