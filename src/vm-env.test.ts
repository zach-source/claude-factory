import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'vm-env-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// the fixture imports vm-env first, then writes a marker and runs a child with NO env option (Bun's start env)
const fixture = join(dir, 'fixture.ts')
writeFileSync(
  fixture,
  `import ${JSON.stringify(join(import.meta.dir, 'vm-env'))}
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.MARKER!, 'x')
const r = Bun.spawnSync(['sh', '-c', 'echo "$PACKED|$KEPT|${'${FACTORY_VM_ENV-absent}'}"; exit "$CODE"'])
process.stdout.write(r.stdout)
process.exit(r.exitCode)
`,
)

let n = 0
function run(vmEnv: string | undefined, extra: Record<string, string> = {}) {
  const marker = join(dir, `marker${n++}`)
  const env: Record<string, string> = { PATH: process.env.PATH!, MARKER: marker, CODE: '0', ...extra }
  if (vmEnv !== undefined) env.FACTORY_VM_ENV = vmEnv
  const r = Bun.spawnSync([process.execPath, fixture], { env })
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    runs: existsSync(marker) ? readFileSync(marker, 'utf8').length : 0,
  }
}

describe('vm-env', () => {
  test('a packed var reaches a child that has no env option, and FACTORY_VM_ENV does not', () => {
    const r = run(JSON.stringify({ PACKED: 'p1' }), { KEPT: 'k' })
    expect(r.out).toBe('p1|k|absent\n')
    expect(r.runs).toBe(1)
  })
  test('a packed value overrides an inherited one', () => {
    expect(run(JSON.stringify({ PACKED: 'new' }), { PACKED: 'old' }).out).toBe('new||absent\n')
  })
  test('the exit code of the child passes through', () => {
    expect(run(JSON.stringify({ A: 'b' }), { CODE: '3' }).code).toBe(3)
  })
  test('unset FACTORY_VM_ENV: no re-exec', () => {
    const r = run(undefined, { PACKED: 'q' })
    expect(r.out).toBe('q||absent\n')
    expect(r.runs).toBe(1)
  })
  const bad: [string, string][] = [
    ['not JSON', 'nope'],
    ['empty string', ''],
    ['an array', '["A"]'],
    ['null', 'null'],
    ['a number value', '{"A":1}'],
    ['a null value', '{"A":null}'],
    ['a key with =', '{"A=B":"x"}'],
    ['a key with a space', '{"A B":"x"}'],
    ['an empty key', '{"":"x"}'],
    ['a key that starts with a digit', '{"1A":"x"}'],
  ]
  for (const [name, v] of bad)
    test(`fails closed: ${name}`, () => {
      const r = run(v)
      expect(r.code).toBe(1)
      expect(r.err).toContain('FACTORY_VM_ENV')
      expect(r.runs).toBe(0)
    })
  test('bin/factory worker poll reads the dir that FACTORY_VM_ENV packs', () => {
    const w = mkdtempSync(join(dir, 'w-'))
    writeFileSync(join(w, 'outbox.jsonl'), '{"hello":"packed"}\n')
    const { FACTORY_OUTBOX: _o, FACTORY_FROM: _f, FACTORY_WORKER_DIR: _w, ...base } = process.env
    const r = Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'factory'), 'worker', 'poll', '0'], {
      env: {
        ...base,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_HOME: mkdtempSync(join(dir, 'h-')),
        FACTORY_VM_ENV: JSON.stringify({ FACTORY_WORKER_DIR: w }),
      },
    })
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout.toString()).lines).toEqual(['{"hello":"packed"}'])
  })
  test('the error never prints a value', () => {
    expect(run('{"A":1,"SECRETISH":"zqsecret"}').err).not.toContain('zqsecret')
  })
})
