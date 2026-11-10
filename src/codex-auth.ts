// claude-factory-y3f8w.10: <home>/manager-codex-auth.json, set when a codex step of the manager gets an auth error.
// The OpenAI key can expire or be revoked, and the manager would then fail with no sign. The state shows on the board,
// mails the manager once per failure, and clears on the next success. It never holds the key.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type State = { at: number; text: string; mailed?: boolean }
const fileOf = (home: string) => join(home, 'manager-codex-auth.json')

/** a 401 or a key the provider refuses; a rate limit or an exit code alone is not one */
export const isCodexAuthError = (text?: string): boolean =>
  !!text &&
  /(^|\D)401(\D|$)|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|authentication (failed|error)|key (has been )?(revoked|expired)/i.test(
    text,
  )

/** the text with each key-like token cut out, shortened */
const safe = (t: string) =>
  t
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{6,}/g, '[key]')
    .replace(/\s+/g, ' ')
    .slice(0, 200)

export function codexAuth(home: string): State | null {
  try {
    return existsSync(fileOf(home)) ? (JSON.parse(readFileSync(fileOf(home), 'utf8')) as State) : null
  } catch {
    return null
  }
}

/** records a failure; one that is already recorded keeps its first time (and its mailed mark) */
export function recordCodexAuth(home: string, at: number, text: string) {
  if (codexAuth(home)) return
  writeFileSync(fileOf(home), JSON.stringify({ at, text: safe(text) }))
}

export const clearCodexAuth = (home: string) => rmSync(fileOf(home), { force: true })

/** one mail for each failure, for the manager */
export function codexAuthMail(
  now: number,
  home: string,
): { run: string; from: string; text: string; at: number }[] {
  const s = codexAuth(home)
  if (!s || s.mailed) return []
  writeFileSync(fileOf(home), JSON.stringify({ ...s, mailed: true }))
  return [
    {
      run: 'factory',
      from: 'factory',
      at: now,
      text: `manager codex: key refused (${s.text}). The OpenAI key of the manager has expired or was revoked. The owner must set a new key in the vault (OPENAI). The board shows this until a codex step works again.`,
    },
  ]
}
