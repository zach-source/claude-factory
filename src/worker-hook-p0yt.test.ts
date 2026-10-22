import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { clampTimeout } from './worker-hook'

// claude-factory-p0yt: a Bash call's timeout never runs past the station's deadline
const NOW = 1_000_000

test('clampTimeout cuts a timeout to what is left, with a 30 s floor, and leaves a call that ends in time', () => {
  expect(clampTimeout({}, NOW + 60_000, NOW)).toBe(60_000) // the 2 min default is too long
  expect(clampTimeout({ timeout: 600_000 }, NOW + 300_000, NOW)).toBe(300_000)
  expect(clampTimeout({ timeout: 10_000 }, NOW + 300_000, NOW)).toBeUndefined()
  expect(clampTimeout({}, NOW + 600_000, NOW)).toBeUndefined()
  expect(clampTimeout({}, NOW + 5_000, NOW)).toBe(30_000)
  expect(clampTimeout({}, NOW - 60_000, NOW)).toBe(30_000) // past the deadline: a report still runs
  expect(clampTimeout({ timeout: 20_000 }, NOW - 60_000, NOW)).toBeUndefined()
  expect(clampTimeout({ run_in_background: true }, NOW + 1_000, NOW)).toBeUndefined()
  expect(clampTimeout({}, Number.NaN, NOW)).toBeUndefined()
})

const hook = (input: object, deadline?: string) => {
  const p = Bun.spawnSync(['bun', join(import.meta.dir, 'worker-hook.ts')], {
    stdin: Buffer.from(JSON.stringify(input)),
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/tmp', FACTORY_DEADLINE: deadline ?? '' },
  })
  const out = p.stdout.toString().trim()
  return out ? JSON.parse(out).hookSpecificOutput : undefined
}

test('the hook rewrites the timeout near the deadline, never without one, and a deny still wins', () => {
  const soon = String(Date.now() + 60_000)
  const out = hook(
    { tool_name: 'Bash', cwd: '/tmp', tool_input: { command: 'make test', timeout: 600_000 } },
    soon,
  )
  expect(out.permissionDecision).toBe('allow')
  expect(out.updatedInput.command).toBe('make test')
  expect(out.updatedInput.timeout).toBeGreaterThan(50_000)
  expect(out.updatedInput.timeout).toBeLessThanOrEqual(60_000)
  expect(hook({ tool_name: 'Bash', cwd: '/tmp', tool_input: { command: 'make test' } })).toBeUndefined()
  const denied = hook({ tool_name: 'Bash', cwd: '/tmp', tool_input: { command: 'rm -rf /' } }, soon)
  expect(denied.permissionDecision).toBe('deny')
  expect(denied.updatedInput).toBeUndefined()
})
