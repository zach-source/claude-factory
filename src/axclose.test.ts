import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = join(tmpdir(), `axclose-${process.pid}`)
mkdirSync(dir, { recursive: true })
const fake = join(dir, 'ax')
writeFileSync(fake, '#!/bin/sh\necho forbidden >&2\nexit 1\n')
chmodSync(fake, 0o755)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the ax runner close writes a failed delete to ax.log', () => {
  // a child process: cli.ts reads FACTORY_HOME once, when it loads
  const p = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      "await import('./src/cli'); (await import('./src/runner')).runners.ax.close('ax://f-acme-1')",
    ],
    { cwd: join(import.meta.dir, '..'), env: { ...process.env, FACTORY_HOME: dir, FACTORY_AX: fake } },
  )
  expect(p.exitCode).toBe(0)
  expect(readFileSync(join(dir, 'ax.log'), 'utf8')).toContain(
    'remove f-acme-1 failed: delete task: forbidden',
  )
})
