import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dir, '..', 'bin', 'factory')
const U = '123e4567-e89b-12d3-a456-426614174000'
const REFUSED = "without the person's Allow (FACTORY_MAIN_CHAT is set)"
const MARKERS = [
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'FACTORY_SERVER',
  'FACTORY_OUTBOX',
  'FACTORY_MAIN_CHAT',
  'FACTORY_ALLOW',
]

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, 'allow'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), '{}')
  symlinkSync(BIN, join(dir, 'd'))
  const run = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env } as Record<string, string | undefined>
    for (const k of MARKERS) delete base[k]
    const p = Bun.spawnSync([join(dir, 'd'), ...args], {
      env: { ...base, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env } as Record<string, string>,
    })
    return p.stderr.toString()
  }
  return { home, run }
}
const M = { FACTORY_MAIN_CHAT: '1' }

test('a symlink to the CLI is refused under the marker; a token permits one call (AC5)', () => {
  const { home, run } = setup()
  expect(run(['decide', 'r1', 'ship'], M)).toContain(REFUSED)
  expect(run(['status'], M)).not.toContain(REFUSED)
  expect(run(['decide', 'r1', 'ship'])).not.toContain(REFUSED)
  const exp = Date.now() + 60_000
  writeFileSync(join(home, 'allow', `${U}.json`), JSON.stringify({ kinds: ['decide'], exp }))
  expect(run(['decide', 'r1', 'ship'], { ...M, FACTORY_ALLOW: U })).not.toContain(REFUSED)
  expect(run(['decide', 'r1', 'ship'], { ...M, FACTORY_ALLOW: U })).toContain(REFUSED)
})

test('the refusal comes before the server forward (AC6)', () => {
  const { run } = setup()
  const err = run(['decide', 'r1', 'ship'], { ...M, FACTORY_SERVER: 'http://127.0.0.1:9' })
  expect(err).toContain(REFUSED)
})
