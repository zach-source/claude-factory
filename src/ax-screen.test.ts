// claude-factory-hpmc.3: ax.screen(task) reads the worker screen with one ssh call and nothing else
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ax from './ax'

const dir = mkdtempSync(join(tmpdir(), 'axscreen-'))
const calls = join(dir, 'calls.log')
const fake = join(dir, 'ax')
writeFileSync(
  fake,
  `#!/bin/sh
echo "$*" >> ${calls}
[ -f ${dir}/fail ] && { echo 'secret-token-zq' >&2; exit 1; }
cat ${dir}/ssh
`,
)
chmodSync(fake, 0o755)
const saved = { ...process.env }
const log = () => readFileSync(calls, 'utf8').trim().split('\n')
beforeEach(() => {
  process.env = { ...saved, FACTORY_AX: fake }
  delete process.env.FACTORY_AX_CONTEXT
  delete process.env.FACTORY_AX_CAPABILITIES
  rmSync(calls, { force: true })
  rmSync(join(dir, 'fail'), { force: true })
  writeFileSync(join(dir, 'ssh'), 'the screen')
})
afterAll(() => {
  process.env = saved
  rmSync(dir, { recursive: true, force: true })
})

test('runs.screen AX fixture: one ssh call to the saved task with the fixed worker verb', () => {
  process.env.FACTORY_AX_CONTEXT = 'acme'
  expect(ax.screen('f-run-1')).toBe('the screen')
  const l = log()
  expect(l).toHaveLength(1)
  expect(l[0]).toStartWith('--context acme -a factory ssh f-run-1 -- setpriv --reuid=')
  expect(l[0]).toEndWith(' factory worker screen')
})

test('without SETUID and SETGID the verb goes as given', () => {
  process.env.FACTORY_AX_CAPABILITIES = ''
  expect(ax.screen('f-run-1')).toBe('the screen')
  expect(log()).toEqual(['-a factory ssh f-run-1 -- factory worker screen'])
})

test('runs.screen byte cap: the newest 65536 bytes, no cut character', () => {
  process.env.FACTORY_AX_CAPABILITIES = ''
  writeFileSync(join(dir, 'ssh'), '€'.repeat(40000) + 'END')
  const got = ax.screen('f-run-1')
  expect(got.includes('�')).toBe(false)
  expect(Buffer.byteLength(got)).toBeLessThanOrEqual(65536)
  expect(got.endsWith('€END')).toBe(true)
})

test('a failed ssh gives a reason without the remote stderr; an overflow gives a reason', () => {
  process.env.FACTORY_AX_CAPABILITIES = ''
  writeFileSync(join(dir, 'fail'), '')
  let err = ''
  try {
    ax.screen('f-run-1')
  } catch (e) {
    err = (e as Error).message
  }
  expect(err).toBe('worker screen could not be read')
  rmSync(join(dir, 'fail'))
  writeFileSync(join(dir, 'ssh'), 'a'.repeat(200_000))
  expect(() => ax.screen('f-run-1')).toThrow('too large')
})

test('a missing ax executable gives a reason', () => {
  process.env.FACTORY_AX = join(dir, 'no-such-ax')
  expect(() => ax.screen('f-run-1')).toThrow('could not be read')
})
