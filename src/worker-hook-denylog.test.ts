import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as hook from './worker-hook'
import { HOME_REASON } from './home-guard'

const HOOK = join(import.meta.dir, 'worker-hook.ts')
let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'denylog-'))
  cwd = mkdtempSync(join(tmpdir(), 'denylog-cwd-'))
})
afterEach(() => {
  rmSync(home, { recursive: true })
  rmSync(cwd, { recursive: true })
})

const bash = (command: string) => ({ tool_name: 'Bash', cwd, tool_input: { command } })
function run(input: unknown, env: Record<string, string | undefined> = {}, argv = ['--harness', 'codex']) {
  const e: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
    FACTORY_HOME: home,
    FACTORY_RUN: 'r1',
    FACTORY_FROM: 'implement',
    FACTORY_OUTBOX: undefined,
    FACTORY_DENY_LOG: undefined,
    ...env,
  }
  const p = Bun.spawnSync(['bun', HOOK, ...argv], { stdin: Buffer.from(JSON.stringify(input)), env: e })
  return { out: p.stdout.toString(), code: p.exitCode }
}
const file = () => join(home, 'runs', 'r1', 'denials.jsonl')
const lines = () =>
  readFileSync(file(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

describe('deny log', () => {
  beforeEach(() => mkdirSync(join(home, 'runs', 'r1'), { recursive: true }))

  test('a denied Bash command writes one line with the reason name', () => {
    const r = run(bash('f() { ls; }'))
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason).toBe(hook.FUNCTION_DEF_REASON)
    const l = lines()
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({
      run: 'r1',
      station: 'implement',
      harness: 'codex',
      reason: 'FUNCTION_DEF_REASON',
      command: 'f() { ls; }',
    })
    expect(Number.isFinite(l[0].at)).toBe(true)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  test('the command is cut to 200 chars', () => {
    run(bash('f() { ls; } # ' + 'x'.repeat(500)))
    expect(lines()[0].command).toHaveLength(200)
  })

  test('a denied file write logs FILE_WRITE_REASON', () => {
    run({ tool_name: 'Write', cwd, tool_input: { file_path: join(cwd, '.git', 'config') } })
    expect(lines()[0].reason).toBe('FILE_WRITE_REASON')
  })

  test('the stdout is the same with and without the log', () => {
    const a = run(bash('f() { ls; }'))
    const b = run(bash('f() { ls; }'), { FACTORY_RUN: undefined })
    expect(a.out).toBe(b.out)
    expect(a.out).not.toBe('')
  })

  test('a missing or unknown harness is unknown', () => {
    run(bash('f() { ls; }'), {}, [])
    run(bash('f() { ls; }'), {}, ['--harness', 'evil'])
    expect(lines().map(l => l.harness)).toEqual(['unknown', 'unknown'])
  })

  test('text with no constant is UNKNOWN', () => {
    expect(hook.reasonName('some other text')).toBe('UNKNOWN')
    expect(hook.reasonName(HOME_REASON)).toBe('HOME_REASON')
  })

  test('reasonName round-trips every exported reason', () => {
    const all = Object.entries({ ...hook, HOME_REASON }).filter(
      (e): e is [string, string] => e[0].endsWith('REASON') && typeof e[1] === 'string',
    )
    expect(all.length).toBeGreaterThan(30)
    for (const [k, v] of all) expect(hook.reasonName(v)).toBe(all.find(e => e[1] === v)![0])
    expect(hook.reasonName(hook.PUSH_REASON)).toBe('PUSH_REASON')
  })

  test('no line for an allowed command', () => {
    run(bash('ls src'))
    expect(existsSync(file())).toBe(false)
  })

  test.each([undefined, '', '.', '..', '../x', 'a/b'])('FACTORY_RUN %p writes nothing', id => {
    const r = run(bash('f() { ls; }'), { FACTORY_RUN: id })
    expect(r.out).toContain('deny')
    expect(existsSync(file())).toBe(false)
    expect(existsSync(join(home, 'x'))).toBe(false)
    expect(existsSync(join(home, 'denials.jsonl'))).toBe(false) // FACTORY_RUN '..'
    expect(existsSync(join(home, 'runs', 'denials.jsonl'))).toBe(false) // FACTORY_RUN '.'
  })

  test('no run dir: no mkdir, same deny', () => {
    const r = run(bash('f() { ls; }'), { FACTORY_RUN: 'r2' })
    expect(r.out).toContain('deny')
    expect(existsSync(join(home, 'runs', 'r2'))).toBe(false)
  })

  test('denials.jsonl as a dir: deny printed, exit 0', () => {
    rmSync(join(home, 'runs', 'r1'), { recursive: true })
    mkdirSync(file(), { recursive: true })
    const r = run(bash('f() { ls; }'))
    expect(r.code).toBe(0)
    expect(r.out).toContain('deny')
  })

  test('an outbox without FACTORY_DENY_LOG writes no outbox line', () => {
    const box = join(home, 'outbox.jsonl')
    run(bash('f() { ls; }'), { FACTORY_OUTBOX: box })
    expect(existsSync(box)).toBe(false)
  })

  test('FACTORY_OUTBOX and FACTORY_DENY_LOG=1 write one outbox deny line', () => {
    const box = join(home, 'outbox.jsonl')
    run(bash('f() { ls; }'), { FACTORY_OUTBOX: box, FACTORY_DENY_LOG: '1' })
    const l = readFileSync(box, 'utf8').trim().split('\n')
    expect(l).toHaveLength(1)
    const o = JSON.parse(l[0]!)
    expect(o.deny).toMatchObject({ harness: 'codex', reason: 'FUNCTION_DEF_REASON', command: 'f() { ls; }' })
    expect(Object.keys(o.deny).sort()).toEqual(['at', 'command', 'harness', 'reason'])
    expect(o.from).toBe('implement')
    expect(o.argv).toBeUndefined()
  })
})
