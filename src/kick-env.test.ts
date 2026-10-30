import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { kickEnv } from './kick-env'

test('kickEnv drops FACTORY_PATROL, keeps the rest and sets FACTORY_HOME', () => {
  const env = kickEnv({ FACTORY_PATROL: '1', FOO: 'x', FACTORY_HOME: 'old' }, '/h')
  expect(env).toEqual({ FOO: 'x', FACTORY_HOME: '/h' })
})

test('every kick of self-update, gc, gc --worktrees and sweep spawns with kickEnv', () => {
  const src = readFileSync(join(import.meta.dir, 'cli.ts'), 'utf8')
  for (const args of ["['self-update']", "['gc']", "['gc', '--worktrees']", "['sweep']"]) {
    const at = src.indexOf(`spawnChild(CLI, ${args}, {`)
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 150)).toContain('env: kickEnv(process.env, HOME)')
  }
})
