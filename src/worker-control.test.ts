// claude-factory-5y7b: a worker cannot run factory say, stop, resume, start or fork.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `worker-control-${process.pid}`)
const home = join(dir, 'home')
const axLog = join(dir, 'ax.log')
const halt = join(home, 'halt.json')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** a fresh home and a fake ax that logs its argv; runs the CLI once with the given extra env */
function run(args: string[], env: Record<string, string>, seedHalt = false) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'runs'), { recursive: true })
  const ax = join(dir, 'fake-ax')
  writeFileSync(ax, `#!/bin/sh\necho "$@" >> ${axLog}\n`, { mode: 0o755 })
  if (seedHalt) writeFileSync(halt, JSON.stringify({ state: 'stopping', at: 1, told: {}, closed: {} }))
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DEF_NAME, BEADS_ACTOR, ...rest } = process.env
  void [FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DEF_NAME, BEADS_ACTOR]
  return Bun.spawnSync([CLI, ...args], {
    env: { ...rest, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_GC: '0', FACTORY_AX: ax, ...env },
  })
}
const runs = () => readdirSync(join(home, 'runs')).length

const markers: Record<string, Record<string, string>> = {
  FACTORY_FROM: { FACTORY_FROM: 'implement' },
  'FACTORY_FROM manager': { FACTORY_FROM: 'manager' },
  FACTORY_RUN: { FACTORY_RUN: 'lifecycle-x' },
  FACTORY_DEF_NAME: { FACTORY_DEF_NAME: 'lifecycle' },
  BEADS_ACTOR: { BEADS_ACTOR: 'factory/lifecycle-x/implement' },
}
const refused = /a worker cannot run factory (say|stop|resume|start|fork)/

for (const [name, env] of Object.entries(markers)) {
  test(`${name}: say is refused and runs no ax`, () => {
    const p = run(['say', 'hello'], env)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(refused)
    expect(existsSync(axLog)).toBe(false)
  })
  test(`${name}: stop is refused and writes no halt.json`, () => {
    const p = run(['stop'], env)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(refused)
    expect(existsSync(halt)).toBe(false)
  })
  test(`${name}: resume is refused and keeps halt.json`, () => {
    const p = run(['resume'], env, true)
    expect(p.exitCode).toBe(1)
    expect(p.stderr.toString()).toMatch(refused)
    expect(existsSync(halt)).toBe(true)
  })
  for (const args of [
    ['start', 'lifecycle', dir, 'g'],
    ['fork', 'r1', 'implement'],
  ]) {
    test(`${name}: ${args.slice(0, 3).join(' ')} is refused and makes no run`, () => {
      const p = run(args, env)
      expect(p.exitCode).toBe(1)
      expect(p.stderr.toString()).toMatch(refused)
      expect(runs()).toBe(0)
    })
  }
}

test('no marker: say runs ax', () => {
  expect(run(['say', 'hello'], {}).exitCode).toBe(0)
  expect(existsSync(axLog)).toBe(true)
})
test('no marker: stop writes halt.json', () => {
  expect(run(['stop'], {}).exitCode).toBe(0)
  expect(existsSync(halt)).toBe(true)
})
test('no marker: resume removes halt.json', () => {
  expect(run(['resume'], {}, true).exitCode).toBe(0)
  expect(existsSync(halt)).toBe(false)
})
