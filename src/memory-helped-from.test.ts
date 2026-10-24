// claude-factory-p11 (FR-017): `memory helped` must name the run it helped, by --from or by the worker env.
// Without a run, usage()'s `runs` counts UTC days, which skews decide()'s promote threshold.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format, helpedBy } from './memory'

test.each<[string, string | undefined, Record<string, string>, string | undefined]>([
  ['--from wins', 'r1/verify', { FACTORY_RUN: 'r9', FACTORY_STATION: 'implement' }, 'r1/verify'],
  [
    'the env gives run/station',
    undefined,
    { FACTORY_RUN: 'r9', FACTORY_STATION: 'implement' },
    'r9/implement',
  ],
  ['a run with no station is not enough', undefined, { FACTORY_RUN: 'r9' }, undefined],
  ['nothing at all', undefined, {}, undefined],
  ['an empty --from is no run', '', {}, undefined],
])('helpedBy: %s', (_, from, env, want) => {
  expect(helpedBy(from, env)).toBe(want)
})

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-helped-from-${process.pid}`)
const home = join(dir, 'home')
const mem = join(home, 'memory')
const run = (args: string[], env: Record<string, string> = {}) => {
  // the laptop's environment: no worker variables another test file left in this process
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_STATION, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], { env: { ...laptop, ...env, FACTORY_HOME: home } })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}
const usageLines = () =>
  readFileSync(join(mem, '.usage.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

test('memory helped: refused with exit 2 and usage text without --from or env; logs `by` with either', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(mem, 'beads'), { recursive: true })
  writeFileSync(join(mem, 'beads', 'a.md'), format({ summary: 'a note', body: 'body' }))

  const bare = run(['memory', 'helped', 'beads/a.md'])
  expect(bare.code).toBe(2)
  expect(bare.err).toContain('--from run/station')
  expect(bare.err).toContain('usage: factory memory helped')

  expect(run(['memory', 'helped', '--from', 'r1/verify', 'beads/a.md']).code).toBe(0)
  expect(
    run(['memory', 'helped', 'beads/a.md'], { FACTORY_RUN: 'r2', FACTORY_STATION: 'implement' }).code,
  ).toBe(0)
  expect(usageLines().map(u => u.by)).toEqual(['r1/verify', 'r2/implement'])
  rmSync(dir, { recursive: true, force: true })
})
