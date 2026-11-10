// claude-factory-y3f8w.10: watch the manager's OpenAI key: a codex step that gets a 401 records it, mails once, and a success clears it
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCodexAuth, codexAuth, codexAuthMail, isCodexAuthError, recordCodexAuth } from './codex-auth'
import type { ModelResult } from './once'
import { runStep } from './steps'

const home = () => mkdtempSync(join(tmpdir(), 'cauth-'))
const res = (o: Partial<ModelResult>): ModelResult => ({
  durationMs: 1,
  isOk: true,
  text: '',
  reason: 'completed',
  commands: [],
  calls: [],
  ...o,
})

test('it knows an auth error from another failure', () => {
  expect(isCodexAuthError('unexpected status 401 Unauthorized: invalid_api_key')).toBe(true)
  expect(isCodexAuthError('Incorrect API key provided')).toBe(true)
  expect(isCodexAuthError('exceeded retry limit, last status: 429')).toBe(false)
  expect(isCodexAuthError('codex exited 1')).toBe(false)
  expect(isCodexAuthError(undefined)).toBe(false)
})

test('a record keeps no key, mails once per failure, and a clear ends it', () => {
  const h = home()
  expect(codexAuth(h)).toBeNull()
  recordCodexAuth(h, 1000, 'status 401: Incorrect API key provided: ' + 'sk-' + 'proj-abcdefghij0123456789')
  const a = codexAuth(h)!
  expect(a.at).toBe(1000)
  expect(JSON.stringify(a)).not.toContain('sk-proj')
  recordCodexAuth(h, 2000, 'status 401 again') // the same failure: the first time stays
  expect(codexAuth(h)!.at).toBe(1000)
  const mail = codexAuthMail(3000, h)
  expect(mail).toHaveLength(1)
  expect(mail[0]!.text).toContain('key refused')
  expect(codexAuthMail(4000, h)).toEqual([]) // once
  clearCodexAuth(h)
  expect(codexAuth(h)).toBeNull()
  recordCodexAuth(h, 5000, 'status 401')
  expect(codexAuthMail(6000, h)).toHaveLength(1) // a new failure mails again
})

test('runStep on codex records a 401 and clears it on the next success', async () => {
  const h = home()
  await runStep(h, 'pm', { system: 's', input: 'i', codex: 'gpt-x' }, async () =>
    res({ isOk: false, error: 'unexpected status 401 Unauthorized', reason: 'failed' }),
  )
  expect(codexAuth(h)).not.toBeNull()
  await runStep(h, 'pm', { system: 's', input: 'i', codex: 'gpt-x' }, async () => res({}))
  expect(codexAuth(h)).toBeNull()
  // a Claude step never touches it
  recordCodexAuth(h, 1, '401')
  await runStep(h, 'pm', { system: 's', input: 'i' }, async () => res({}))
  expect(codexAuth(h)).not.toBeNull()
})
