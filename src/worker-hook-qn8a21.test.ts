import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as hook from './worker-hook'

// claude-factory-qn8a.21: a write to the hook source or to .claude/settings(.local).json turns the guard off.
const H = '/f/acme-factory'
const ROOT = '/w/acme'
const R: string = hook.HOOK_CONTROL_REASON ?? 'missing'
const env = { home: '/h/u', xdg: undefined }
const bash = (cmd: string, cwd = ROOT) => hook.denyReason(cmd, ROOT, undefined, { cwd, hookDir: H })
const file = (p: string, cwd = ROOT) => hook.fileWriteReason(p, cwd, env, ROOT, H)

describe('AC1 Write tool, hook dir', () => {
  test.each([
    `${H}/src/worker-hook.ts`,
    `${H}/src/home-guard.ts`,
    `${H}/src/cut.ts`,
    `${H}/package.json`,
    `${H}/SRC/Worker-Hook.ts`,
    `${H}/src/../src/cut.ts`,
  ])('denies %s', p => expect(file(p)).toBe(R))
  test('denies a symlink in root that points into the hook dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'qn21-'))
    try {
      const hd = join(d, 'fac')
      const rt = join(d, 'root')
      mkdirSync(join(hd, 'src'), { recursive: true })
      mkdirSync(rt)
      writeFileSync(join(hd, 'src', 'worker-hook.ts'), '')
      symlinkSync(hd, join(rt, 'l'))
      expect(hook.fileWriteReason(join(rt, 'l', 'src', 'worker-hook.ts'), rt, env, rt, hd)).toBe(R)
    } finally {
      rmSync(d, { recursive: true })
    }
  })
})

describe('AC2 Write tool, settings', () => {
  test.each([
    `${ROOT}/.claude/settings.local.json`,
    `${ROOT}/.claude/settings.json`,
    '.claude/Settings.Local.json',
    '/x/.claude/settings.json',
    `${ROOT}/.claude`,
  ])('denies %s', p => expect(file(p)).toBe(R))
  test('denies a symlink whose real path ends in .claude/settings.json', () => {
    const d = mkdtempSync(join(tmpdir(), 'qn21-'))
    try {
      mkdirSync(join(d, '.claude'))
      writeFileSync(join(d, '.claude', 'settings.json'), '')
      symlinkSync(join(d, '.claude', 'settings.json'), join(d, 'ln'))
      expect(hook.fileWriteReason(join(d, 'ln'), d, env, d, H)).toBe(R)
    } finally {
      rmSync(d, { recursive: true })
    }
  })
})

describe('AC3 Bash, hook dir', () => {
  test.each([
    `echo x > ${H}/src/worker-hook.ts`,
    `cp .scratch/a.ts ${H}/src/`,
    `sed -i s/a/b/ ${H}/src/worker-hook.ts`,
    `tee ${H}/src/home-guard.ts`,
    `dd if=a of=${H}/src/cut.ts`,
    `cp x ${H}`,
    `ln -s ${H} .scratch/l`,
    `cd ${H} && tee x`,
    `env -C ${H} tee x`,
    `git -C ${H} checkout x`,
    `echo x > ${H}/../acme-factory/src/cut.ts`,
    `tee {${H},/x}/src/cut.ts`,
    `tee ${H}/src/*.ts`,
    'tee {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}',
    `tee '${H}/src/worker-hook.ts'`,
    `tee $D/acme-factory/src/x`,
    'tee $D/worker-hook.ts',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test('denies a git work tree in the hook dir (ty8y gives its own reason)', () =>
    expect(bash(`git --work-tree=${H} checkout x`)).toBeDefined())
  test('denies a backtick path (an earlier guard gives its own reason)', () =>
    expect(bash('tee `pwd`/src/cut.ts')).toBeDefined())
})

describe('AC4 Bash, settings', () => {
  test.each([
    'echo {} > .claude/settings.local.json',
    'tee .claude/settings.json',
    'cp .scratch/s.json .claude/settings.local.json',
    'cd .claude && tee settings.json',
    'tee $D/settings.local.json',
    'mv .scratch/c .claude',
    'tee .claude/settings.*',
    'cd .claude/skills && tee x',
    'tee ".claude"/settings.json',
    'sed -i s/a/b/ ./.claude//settings.json',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test('denies a bare name when the cwd is .claude', () =>
    expect(bash('echo x > settings.json', `${ROOT}/.claude`)).toBe(R))
})

describe('AC3 Bash, a parent of the hook dir', () => {
  test.each([
    'cp -R .scratch/acme-factory /f/',
    'cp -R .scratch/acme-factory /f',
    'cp -R .scratch/f/. /f/',
    'rsync -a .scratch/f/ /f/',
    'tar -C /f -xf a.tar',
    'unzip a.zip -d /f',
    'mv .scratch/acme-factory /f/',
    'cp -R .scratch/root/. /',
    'cd /f && tar -xf a.tar',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each(['ls -d /', 'find / -name x', 'cat /f/x', 'cd / && ls', 'tar -C / -tf a.tar'])('allows %s', c =>
    expect(bash(c)).toBeUndefined(),
  )
})

describe('AC7 allowed rows', () => {
  test.each([
    'echo x > .scratch/a.txt',
    'tee .scratch/*',
    'cp src/worker-hook.ts .scratch/b.ts',
    'git checkout -- src/worker-hook.ts',
    'git add src/worker-hook.ts',
    'git show origin/main:src/worker-hook.ts',
    `cat ${H}/src/worker-hook.ts`,
    `grep x ${H}/src/cut.ts`,
    'echo x > .vscode/settings.json',
    'echo x > settings.json',
    'ls .claude',
    'cat .claude/settings.json',
    'bun test src/worker-hook.test.ts',
    "bd comment acme-1 'settings.local.json guard'",
    'tee .claude/skills/x/SKILL.md',
  ])('allows %s', c => expect(bash(c)).toBeUndefined())
  test('allows a Write to the root copy of the hook source and a scratch settings.json', () => {
    expect(file(`${ROOT}/src/worker-hook.ts`)).toBeUndefined()
    expect(file(`${ROOT}/.scratch/settings.json`)).toBeUndefined()
    expect(file(`${ROOT}/.claude/skills/x/SKILL.md`)).toBeUndefined()
  })
})

test('reasonName names the reason', () => expect(hook.reasonName(R)).toBe('HOOK_CONTROL_REASON'))

describe('AC6 deny log and AC5 bun flags', () => {
  const HOOK = join(import.meta.dir, 'worker-hook.ts')
  test('a spawned hook with a hostile bunfig and .env in its cwd still denies, and logs the reason name', () => {
    const home = mkdtempSync(join(tmpdir(), 'qn21h-'))
    const cwd = mkdtempSync(join(tmpdir(), 'qn21c-'))
    try {
      mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
      writeFileSync(join(cwd, 'pre.ts'), 'process.exit(0)\n')
      writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./pre.ts"]\n')
      writeFileSync(join(cwd, '.env'), 'FACTORY_HOME=/nonexistent\n')
      const e: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PROJECT_DIR: cwd,
        FACTORY_HOME: home,
        FACTORY_RUN: 'r1',
        FACTORY_FROM: 'implement',
        FACTORY_OUTBOX: undefined,
        FACTORY_SELF_UPDATE: '0',
      }
      const go = (input: unknown) =>
        Bun.spawnSync(['bun', '--no-env-file', '--config=/dev/null', HOOK, '--harness', 'claude'], {
          cwd,
          stdin: Buffer.from(JSON.stringify(input)),
          env: e,
        }).stdout.toString()
      const b = go({ tool_name: 'Bash', cwd, tool_input: { command: 'tee .claude/settings.json' } })
      expect(JSON.parse(b).hookSpecificOutput.permissionDecision).toBe('deny')
      const w = go({
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: join(cwd, '.claude', 'settings.local.json') },
      })
      expect(JSON.parse(w).hookSpecificOutput.permissionDecision).toBe('deny')
      const rows = require('node:fs')
        .readFileSync(join(home, 'runs', 'r1', 'denials.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l: string) => JSON.parse(l))
      expect(rows.map((r: { reason: string }) => r.reason)).toEqual([
        'HOOK_CONTROL_REASON',
        'HOOK_CONTROL_REASON',
      ])
    } finally {
      rmSync(home, { recursive: true })
      rmSync(cwd, { recursive: true })
    }
  })
})
