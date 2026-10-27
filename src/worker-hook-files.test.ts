// claude-factory-g4du: the file-tool guard of worker-hook.ts (Write, Edit, MultiEdit, NotebookEdit)
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_WRITE_REASON, fileWriteReason } from './worker-hook'

let base: string
let root: string
let home: string
let cfg: string
let xdg: string
const env = () => ({ home, xdg })

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'g4du-')))
  root = join(base, 'root')
  home = join(base, 'home')
  cfg = join(base, 'claude')
  xdg = join(base, 'xdg')
  for (const d of [root, home, cfg, xdg]) mkdirSync(d, { recursive: true })
})
afterAll(() => rmSync(base, { recursive: true }))

const deny = (p: unknown, cwd = '/nowhere', e = env()) => expect(fileWriteReason(p, cwd, e)).toBe(FILE_WRITE_REASON)
const allow = (p: unknown, cwd = '/nowhere', e = env()) => expect(fileWriteReason(p, cwd, e)).toBeUndefined()

test('AC1: a .git path component is denied at any depth, in any case', () => {
  for (const p of [
    '.git/config',
    '.git/HEAD',
    '.GIT/head',
    '.git',
    'sub/../.git/config',
    '.git/hooks/pre-push',
  ])
    deny(join(root, p), root)
  deny('/r/acme/.git/worktrees/w/HEAD')
  deny('.git/config', root)
  allow(join(root, '.github/workflows/ci.yml'))
  allow(join(root, '.gitignore'))
  allow(join(root, 'widget.git/config'))
  allow(join(root, 'widget.git/HEAD'))
  allow(join(root, 'src/.gitkeep'))
})

test('AC2: the global git config is denied', () => {
  for (const p of [
    '/Users/acme/.gitconfig',
    '/home/acme/.gitconfig',
    '~/.gitconfig',
    '/etc/gitconfig',
    '/Users/acme/.config/git/config',
    '/Users/acme/.config/git/ignore',
    '/Users/acme/.GitConfig',
    '~/.config/git/config',
    '/nix/store/x/etc/gitconfig',
  ])
    deny(p)
  deny(join(xdg, 'git/config'))
  allow(join(xdg, 'other/config'))
  allow(join(root, 'vite.config.ts'))
  allow(join(root, '.config/nvim/init.lua'))
  allow(join(root, 'docs/gitconfig.md'))
  // out of scope: the gh config
  allow('/Users/acme/.config/gh/config.yml')
})

test('AC2: XDG_CONFIG_HOME is read from env, so an unset value denies nothing extra', () => {
  allow(join(xdg, 'git/config'), '/nowhere', { home, xdg: undefined })
})

test('AC3: the shell-snapshots folder is denied', () => {
  deny(join(cfg, 'shell-snapshots/snapshot-zsh-1.sh'))
  deny('~/.claude/shell-snapshots/x.sh')
  allow(join(root, '.scratch/snapshot.sh'))
  // out of scope here: ~/.claude/settings.json (claude-factory-qn8a.21)
  allow('~/.claude/settings.json')
})

test('AC4: a symlink into a protected folder is denied, a new dir is allowed', () => {
  mkdirSync(join(home, '.config/git'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(home, '.claude/shell-snapshots'), { recursive: true })
  symlinkSync(join(home, '.config/git'), join(root, 'cfg'))
  symlinkSync(join(root, '.git'), join(root, 'r'))
  symlinkSync(join(home, '.claude/shell-snapshots'), join(root, 's'))
  deny(join(root, 'cfg/config'))
  deny(join(root, 'r/HEAD'))
  deny(join(root, 's/x.sh'))
  allow(join(root, 'new/dir/a.ts'))
})

test('AC4: a missing or odd path fails closed', () => {
  for (const p of ['', undefined, 5, 'a\0b', '~acme/x']) deny(p)
})

// AC5: the hook as Claude Code runs it
const run = async (input: object) => {
  const p = Bun.spawn(['bun', join(import.meta.dir, 'worker-hook.ts')], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: 'pipe',
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, XDG_CONFIG_HOME: '' },
  })
  return (await new Response(p.stdout).text()).trim()
}
const denied = (out: string) => {
  const o = JSON.parse(out).hookSpecificOutput
  expect(o.permissionDecision).toBe('deny')
  expect(o.permissionDecisionReason).toBe(FILE_WRITE_REASON)
}

test('AC5: the hook spawn denies a file tool write to a protected path and prints nothing otherwise', async () => {
  denied(await run({ tool_name: 'Write', tool_input: { file_path: '/Users/acme/.gitconfig', content: 'x' } }))
  denied(await run({ tool_name: 'Edit', tool_input: { file_path: join(root, '.git/config') } }))
  denied(await run({ tool_name: 'MultiEdit', tool_input: { file_path: join(home, '.config/git/config') } }))
  denied(await run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(root, '.git/x.ipynb') } }))
  denied(await run({ tool_name: 'Write', tool_input: { content: 'x' } }))
  expect(await run({ tool_name: 'Write', tool_input: { file_path: join(root, 'src/a.ts') } })).toBe('')
  expect(await run({ tool_name: 'Read', tool_input: { file_path: join(root, '.git/config') } })).toBe('')
})
