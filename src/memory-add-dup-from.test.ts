// `factory memory add`'s duplicate branch must pass --from through to the helped line it logs
// (claude-factory-59r.16): without it, tally()'s `runs` falls back to counting UTC days, so a long
// entry helped by 3 different runs on the same day never reaches decide()'s promote threshold.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-add-dup-from-${process.pid}`)
const home = join(dir, 'home')

const run = (args: string[]) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], { env: { ...laptop, FACTORY_HOME: home } })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

test('a duplicate `memory add` logs the finding run under its own note, not with no `by` at all', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const first = run([
    'memory',
    'add',
    '--rig',
    'fabriek',
    '--from',
    'run1/implement',
    'fabriek has no CHANGELOG file or per-PR version bump convention',
    'checked the whole history',
  ])
  expect(first.code).toBe(0)

  const second = run([
    'memory',
    'add',
    '--rig',
    'fabriek',
    '--from',
    'run2/verify',
    'no changelog or version bump convention exists in fabriek',
    'hit the same thing',
  ])
  expect(second.code).toBe(0)
  expect(second.out).toContain('already noted')

  const lines = readFileSync(join(home, 'memory', '.usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  const helped = lines.find(l => l.helped === 1)
  expect(helped?.by).toBe('run2/verify')
}, 60_000)
