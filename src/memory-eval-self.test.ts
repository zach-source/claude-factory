// `factory memory eval --self [n] [--seed s]` scores search with cases built from the notes
// themselves, so a store with no .eval.jsonl still has a baseline (claude-factory-9l7).
import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-eval-self-${process.pid}`)
const home = join(dir, 'home')

const run = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], { env: { ...laptop, FACTORY_HOME: home } })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

test('eval --self reports recall@5, MRR and n on a store with no curated cases, the same for one seed', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  cpSync(join(import.meta.dir, 'fixtures', 'memory-lifecycle', 'memory'), join(home, 'memory'), {
    recursive: true,
  })
  const a = run(['memory', 'eval', '--self', '5', '--seed', '3'])
  expect(a.err).toBe('')
  expect(a.code).toBe(0)
  expect(a.out).toMatch(/^recall@5 \d\.\d\d {2}mrr \d\.\d\d {2}n=5$/m)
  expect(run(['memory', 'eval', '--self', '5', '--seed', '3']).out).toBe(a.out)
  // no n: the default sample, capped at the notes there are (8 with a body in the fixture)
  expect(run(['memory', 'eval', '--self', '--seed', '3']).out).toMatch(/n=8$/m)
  rmSync(dir, { recursive: true, force: true })
}, 120_000)

test('eval --self refuses a sample size that is not a positive number', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = run(['memory', 'eval', '--self', 'lots'])
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('--self')
  rmSync(dir, { recursive: true, force: true })
})
