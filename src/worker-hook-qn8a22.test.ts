// claude-factory-qn8a.22: the hook checks the paths of a codex apply_patch, and denies a shell apply_patch
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPLY_PATCH_REASON,
  APPLY_PATCH_SHELL_REASON,
  FACTORY_CONFIG_REASON,
  FILE_WRITE_REASON,
  HOOK_CONTROL_REASON,
  applyPatchPaths,
  applyPatchReason,
  denyReason,
} from './worker-hook'

let base: string
let root: string
let home: string
let cfg: string
let xdg: string
const env = (): { home: string; xdg?: string | undefined } => ({ home, xdg })

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'qn8a22-')))
  root = join(base, 'root')
  home = join(base, 'home')
  cfg = join(base, 'claude')
  xdg = join(base, 'xdg')
  for (const d of [root, home, cfg, xdg]) mkdirSync(d, { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  symlinkSync(join(root, '.git'), join(root, 'r'))
})
afterAll(() => rmSync(base, { recursive: true }))

const wrap = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n')
const add = (p: string) => wrap(`*** Add File: ${p}`, '+x')
const reason = (command: unknown, cwd = root) =>
  applyPatchReason({ command }, cwd, env(), root, join(base, 'hook'))

test('AC1: a protected header path is denied with the reason of fileWriteReason', () => {
  for (const p of [
    '.git/config',
    '.git/hooks/pre-push',
    'sub/../.git/config',
    'r/config',
    join(home, '.gitconfig'),
    join(xdg, 'git/config'),
  ])
    expect(reason(add(p))).toBe(FILE_WRITE_REASON)
  expect(reason(wrap('*** Delete File: .git/index'))).toBe(FILE_WRITE_REASON)
  expect(reason(wrap('*** Update File: ok.txt', '*** Move to: .git/config', '@@', '-a', '+b'))).toBe(
    FILE_WRITE_REASON,
  )
  expect(reason(wrap('*** Add File: src/a.ts', '+x', '*** Add File: .git/config', '+x'))).toBe(
    FILE_WRITE_REASON,
  )
  for (const pre of ['\t', '\u0085'])
    expect(reason(wrap(pre + '*** Add File: .git/config'))).toBe(FILE_WRITE_REASON)
  expect(reason(add('.git/config').replace(/\n/g, '\r\n'))).toBe(FILE_WRITE_REASON)
  expect(reason(add('.claude/settings.local.json'))).toBe(HOOK_CONTROL_REASON)
  expect(reason(add(join(base, 'elsewhere/rigs.json')))).toBe(FACTORY_CONFIG_REASON)
})

test('AC1: a safe patch is allowed', () => {
  for (const p of ['src/a.ts', '.scratch/x.txt', '.github/workflows/ci.yml', '.gitignore'])
    expect(reason(add(p))).toBeUndefined()
  expect(
    reason(
      wrap(
        '*** Update File: src/b.ts',
        '*** Move to: src/c.ts',
        '@@',
        '+see .git/config',
        '+*** bold',
        '-*** old',
        ' * comment',
        '*** End of File',
      ),
    ),
  ).toBeUndefined()
  expect(reason(wrap('*** Delete File: .scratch/x.txt'))).toBeUndefined()
})

test('AC2: a malformed input denies with APPLY_PATCH_REASON before any path check', () => {
  for (const ti of [
    undefined,
    'x',
    [],
    {},
    { command: 5 },
    { command: '' },
    { command: 'a\0b' },
    { command: add('src/a.ts') + '\0' },
  ])
    expect(applyPatchReason(ti, root, env(), root)).toBe(APPLY_PATCH_REASON)
  expect(applyPatchReason({ command: add('src/a.ts'), path: 'x' }, root, env(), root)).toBe(
    APPLY_PATCH_REASON,
  )
  for (const c of [
    wrap('+x'),
    wrap('*** Move to: src/a.ts'),
    wrap('*** Move to: .git/config'),
    wrap('*** Environment ID: e1', '*** Add File: a'),
    wrap('*** add file: a'),
    wrap('***Add File: a'),
    wrap('*** Copy File: a'),
    wrap('*** Add File: '),
    add('~/.gitconfig'),
    add('~acme/x'),
  ])
    expect(reason(c)).toBe(APPLY_PATCH_REASON)
  expect(reason(wrap('*** Environment ID: e1', '*** Add File: .git/config'))).toBe(APPLY_PATCH_REASON)
  expect(reason(wrap('*** Environment ID: e1', '*** Add File: src/a.ts'))).toBe(APPLY_PATCH_REASON)
})

test('AC2: applyPatchPaths reads paths as codex does', () => {
  expect(applyPatchPaths({ command: add('src/a.ts') })).toEqual(['src/a.ts'])
  expect(applyPatchPaths({ command: wrap('*** Add File:   sp.txt  \r', '+x') })).toEqual(['  sp.txt'])
  expect(applyPatchPaths({ command: '﻿*** Add File: bom.txt' })).toBeUndefined()
  expect(applyPatchPaths({ command: 'x' })).toBeUndefined()
})

// AC3: the hook as codex runs it
const run = async (input: object, extra: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    CLAUDE_PROJECT_DIR: root,
    XDG_CONFIG_HOME: '',
    ...extra,
  }
  delete e.FACTORY_OUTBOX
  delete e.FACTORY_FROM
  const p = Bun.spawn(['bun', join(import.meta.dir, 'worker-hook.ts'), '--harness', 'codex'], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: 'pipe',
    env: e,
  })
  return (await new Response(p.stdout).text()).trim()
}
const ap = (command: string) => ({ tool_name: 'apply_patch', cwd: root, tool_input: { command } })
const why = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason

test('AC3: the hook spawn checks an apply_patch event', async () => {
  expect(why(await run(ap(add('.git/config'))))).toBe(FILE_WRITE_REASON)
  expect(why(await run(ap(wrap('*** Environment ID: e1', '*** Add File: a'))))).toBe(APPLY_PATCH_REASON)
  expect(await run(ap(add('src/a.ts')))).toBe('')
})

test('AC3: a deny is logged with the codex harness', async () => {
  const fh = join(base, 'fh')
  mkdirSync(join(fh, 'runs/r1'), { recursive: true })
  await run(ap(add('.git/config')), { FACTORY_HOME: fh, FACTORY_RUN: 'r1' })
  const rows = readFileSync(join(fh, 'runs/r1/denials.jsonl'), 'utf8').trim().split('\n')
  expect(rows).toHaveLength(1)
  const row = JSON.parse(rows[0]!)
  expect(row.reason).toBe('FILE_WRITE_REASON')
  expect(row.harness).toBe('codex')
  expect(row.command.startsWith('apply_patch ')).toBe(true)
})

test('AC4: a shell apply_patch is denied', () => {
  const body = "<<'EOF'\n*** Begin Patch\n*** Add File: ok.txt\n+x\n*** End Patch\nEOF\n"
  for (const c of [
    'apply_patch x',
    "apply_patch '*** Begin Patch\n*** Add File: .git/config\n+x\n*** End Patch\n'",
    'applypatch x',
    'Apply_Patch x',
    '/usr/local/bin/apply_patch x',
    'env apply_patch x',
    'command applypatch x',
    'ls; apply_patch x',
  ])
    expect(denyReason(c)).toBe(APPLY_PATCH_SHELL_REASON)
  for (const c of [`apply_patch ${body}`, `cd sub && apply_patch ${body}`, "bash -lc 'apply_patch x'"])
    expect(denyReason(c)).toBeDefined()
})

test('AC4: a command that only names apply_patch is allowed', () => {
  for (const c of [
    'grep -rn apply_patch src',
    'echo apply_patch',
    'git log --grep=apply_patch',
    'rg applypatch src',
    'bun test src/worker-hook-qn8a22.test.ts',
    'cat src/apply_patch.md',
  ])
    expect(denyReason(c)).toBeUndefined()
})
