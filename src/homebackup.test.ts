import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, backupAge, EXCLUDES, restore, secretFile, type BackupCfg } from './homebackup'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'homebackup-'))
  dirs.push(d)
  return d
}
const sh = (...a: string[]) => {
  const p = Bun.spawnSync(['git', ...a])
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}
const remote = () => {
  const d = tmp()
  sh('init', '-q', '--bare', d)
  return d
}
const put = (f: string, s = 'x') => {
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, s)
}
const SLUG = '-workspace-w'
/** a manager workspace: home/ and the Claude config dir, with one session */
function workspace() {
  const ws = tmp()
  const home = join(ws, 'home')
  put(join(home, 'rigs.json'), '[{"name":"acme"}]')
  put(join(home, 'runs', 'r1', 'state.json'), '{}')
  put(join(home, 'memory', 'a.md'), 'note')
  put(join(home, 'decisions.json'), '[]')
  put(join(home, 'metrics.jsonl'), '{}\n')
  put(join(home, 'manager-sessions.json'), JSON.stringify([{ session: 's1', cwd: '/workspace/w' }]))
  put(join(ws, 'claude', 'projects', SLUG, 's1.jsonl'), '{"a":1}\n')
  put(join(ws, 'claude', 'projects', SLUG, 'memory', 'm.md'), 'mem')
  put(join(ws, 'claude', '.credentials.json'), 'login')
  return ws
}
const cfg = (ws: string, r: string | undefined): BackupCfg => ({ ws, remote: r, branch: 'manager-home' })
const empty = () => {
  const ws = tmp()
  mkdirSync(join(ws, 'home'))
  return ws
}

test('AC1: a backup restores into an empty home with the same state', () => {
  const r = remote()
  const a = workspace()
  const out = backup(cfg(a, r), true)
  expect(out.error).toBeUndefined()
  expect(out.sha).toBe(sh('--git-dir', r, 'rev-parse', 'manager-home'))
  const b = empty()
  const got = restore(cfg(b, r))
  expect(got.restored).toBe(out.sha)
  for (const f of [
    'home/rigs.json',
    'home/runs/r1/state.json',
    'home/memory/a.md',
    'home/decisions.json',
    'home/metrics.jsonl',
    'home/manager-sessions.json',
    `claude/projects/${SLUG}/s1.jsonl`,
    `claude/projects/${SLUG}/memory/m.md`,
  ])
    expect(readFileSync(join(b, f), 'utf8')).toBe(readFileSync(join(a, f), 'utf8'))
  expect(readFileSync(join(b, 'home', '.migrated'), 'utf8')).toContain(`restored ${out.sha}`)
  // the next backup from the restored home pushes on top
  put(join(b, 'home', 'memory', 'b.md'), 'more')
  expect(backup(cfg(b, r), true).error).toBeUndefined()
})

test('AC2: the login files, locks, bin, devenv, logs and rigs.json backups stay out', () => {
  const r = remote()
  const ws = workspace()
  const never = [
    'home/.claude.json',
    'home/.credentials.json',
    'home/settings.json',
    'home/rigs.json.bak',
    'home/tick.lock',
    'home/gc.lock',
    'home/bin/factory',
    'home/devenv/x',
    'home/herdr.log',
    'home/backup.json',
    'home/runs/r1/worktrees/acme/f.txt',
    `claude/.credentials.json`,
    `claude/projects/${SLUG}/other.jsonl`,
  ]
  for (const f of never) put(join(ws, f), 'x')
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const files = sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')
  for (const f of never) expect(files).not.toContain(f)
  expect(files).toContain('home/rigs.json')
})

test('AC2: each exclude rule is needed', () => {
  // a rule removed from EXCLUDES lets its file in
  const rules = EXCLUDES.filter(x => !x.startsWith('#'))
  expect(rules.length).toBeGreaterThanOrEqual(10)
  const probes: Record<string, string> = {
    '.claude.json': 'home/.claude.json',
    '.credentials.json': 'home/.credentials.json',
    'settings*.json': 'home/settings.json',
    'rigs.json.*': 'home/rigs.json.bak',
    '*.lock': 'home/tick.lock',
    '/home/bin/': 'home/bin/factory',
    '/home/devenv/': 'home/devenv/x',
    '/home/herdr.log': 'home/herdr.log',
    '/home/backup.json': 'home/backup.json',
    'worktrees/': 'home/runs/r1/worktrees/acme/f.txt',
  }
  for (const [rule, file] of Object.entries(probes)) {
    expect(rules).toContain(rule)
    const r = remote()
    const ws = workspace()
    put(join(ws, file), 'x')
    expect(backup({ ...cfg(ws, r), excludes: rules.filter(x => x !== rule) }, true).error).toBeUndefined()
    expect(sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')).toContain(file)
  }
})

test('AC3: a secret in a staged file stops the commit and the push, and the error names the file', () => {
  const r = remote()
  const ws = workspace()
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const before = sh('--git-dir', r, 'rev-parse', 'manager-home')
  const token = 'ghp_' + 'a'.repeat(36)
  put(join(ws, 'home', 'memory', 'leak.md'), `token ${token}`)
  const out = backup(cfg(ws, r), true)
  expect(out.error).toContain('home/memory/leak.md')
  expect(out.error).not.toContain(token)
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(before)
  // nothing stays staged: the next backup without the file works
  rmSync(join(ws, 'home', 'memory', 'leak.md'))
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
})

test('secretFile finds the usual token shapes and no plain text', () => {
  const hit = [
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'a'.repeat(30),
    'sk-ant-' + 'a'.repeat(30),
    'AKIA' + 'A'.repeat(16),
    'xoxb-1234567890-abcdef',
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'Authorization: Basic ' + 'QUJD'.repeat(6),
  ]
  for (const s of hit) expect(secretFile(Buffer.from(`x ${s} y`))).toBe(true)
  expect(secretFile(Buffer.from('plain notes about ghp and sk'))).toBe(false)
})

test('AC4: an unready home never pushes, and a rejected push never forces', () => {
  const r = remote()
  const ws = workspace()
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const good = sh('--git-dir', r, 'rev-parse', 'manager-home')
  const e = empty()
  expect(backup(cfg(e, r), false).error).toContain('not ready')
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(good)
  // someone else moved the branch: a second workspace with the same remote has diverged history
  const other = workspace()
  expect(backup(cfg(other, remote()), true).error).toBeUndefined() // local history, not the remote's
  expect(backup(cfg(other, r), true).error).toContain('git push')
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(good)
})

test('AC5: restore does nothing to a used home', () => {
  const r = remote()
  expect(backup(cfg(workspace(), r), true).error).toBeUndefined()
  for (const f of ['rigs.json', 'runs/x/state.json', '.migrated']) {
    const ws = empty()
    put(join(ws, 'home', f), 'mine')
    const out = restore(cfg(ws, r))
    expect(out.restored).toBeUndefined()
    expect(out.skipped).toBe('used')
    expect(readFileSync(join(ws, 'home', f), 'utf8')).toBe('mine')
    expect(existsSync(join(ws, 'home', 'memory'))).toBe(false)
  }
})

test('AC6: no remote and no branch fall back without an error', () => {
  const ws = empty()
  expect(restore(cfg(ws, undefined)).skipped).toBe('no remote')
  expect(backup(cfg(workspace(), undefined), true).skipped).toBe('no remote')
  const out = restore(cfg(ws, remote()))
  expect(out.skipped).toBe('no backup')
  expect(existsSync(join(ws, 'home', '.migrated'))).toBe(false)
})

test('a memory repo with a commit is backed up as a bundle and restored as a repo', () => {
  const r = remote()
  const a = workspace()
  const mem = join(a, 'home', 'memory')
  sh('-C', mem, 'init', '-q')
  sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', 'add', '-A')
  sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'one')
  const out = backup(cfg(a, r), true)
  expect(out.error).toBeUndefined()
  const files = sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')
  expect(files).toContain('home/memory.bundle')
  expect(files.some(f => f.startsWith('home/memory/'))).toBe(false)
  // no change in the repo: the bundle is not written again, so no new commit
  expect(backup(cfg(a, r), true).changed).toBe(false)
  const b = empty()
  expect(restore(cfg(b, r)).restored).toBe(out.sha)
  expect(readFileSync(join(b, 'home', 'memory', 'a.md'), 'utf8')).toBe('note')
  expect(sh('-C', join(b, 'home', 'memory'), 'log', '--format=%s')).toBe('one')
})

test('a secret in a memory repo file stops the backup', () => {
  const r = remote()
  const a = workspace()
  const mem = join(a, 'home', 'memory')
  sh('-C', mem, 'init', '-q')
  put(join(mem, 'leak.md'), 'ghp_' + 'a'.repeat(36))
  sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', 'add', '-A')
  sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'one')
  expect(backup(cfg(a, r), true).error).toContain('home/memory/leak.md')
})

test('a token in an old memory commit stops the backup even when the work tree is clean', () => {
  const r = remote()
  const a = workspace()
  const mem = join(a, 'home', 'memory')
  const g = (...x: string[]) => sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', ...x)
  sh('-C', mem, 'init', '-q')
  put(join(mem, 'leak.md'), 'ghp_' + 'a'.repeat(36))
  g('add', '-A')
  g('commit', '-q', '-m', 'one')
  put(join(mem, 'leak.md'), 'clean')
  g('commit', '-q', '-am', 'two')
  const out = backup(cfg(a, r), true)
  expect(out.error).toContain('history of home/memory')
  expect(Bun.spawnSync(['git', '--git-dir', r, 'rev-parse', '--verify', 'manager-home']).exitCode).not.toBe(0)
})

test('a token in a binary blob of an old memory commit stops the backup', () => {
  const r = remote()
  const a = workspace()
  const mem = join(a, 'home', 'memory')
  const g = (...x: string[]) => sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', ...x)
  sh('-C', mem, 'init', '-q')
  writeFileSync(
    join(mem, 'x.bin'),
    Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('ghp_' + 'a'.repeat(36))]),
  )
  g('add', '-A')
  g('commit', '-q', '-m', 'one')
  g('rm', '-q', 'x.bin')
  g('commit', '-q', '-m', 'two')
  expect(backup(cfg(a, r), true).error).toContain('history of home/memory')
  expect(Bun.spawnSync(['git', '--git-dir', r, 'rev-parse', '--verify', 'manager-home']).exitCode).not.toBe(0)
})

test('a memory dir that blocks the clone is an error, and a retry finishes the restore', () => {
  const r = remote()
  const a = workspace()
  const mem = join(a, 'home', 'memory')
  sh('-C', mem, 'init', '-q')
  sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', 'add', '-A')
  sh('-C', mem, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'one')
  expect(backup(cfg(a, r), true).error).toBeUndefined()
  const b = empty()
  put(join(b, 'home', 'memory', 'old.md'), 'stale')
  const out = restore(cfg(b, r))
  expect(out.restored).toBeUndefined()
  expect(out.error).toBeDefined()
  expect(existsSync(join(b, 'home', '.migrated'))).toBe(false)
  // rigs.json is there now, but the restore is still open: the next call must not say "used"
  rmSync(join(b, 'home', 'memory'), { recursive: true, force: true })
  const again = restore(cfg(b, r))
  expect(again.restored).toBeDefined()
  expect(readFileSync(join(b, 'home', 'memory', 'a.md'), 'utf8')).toBe('note')
})

test('a failing remote is an error in restore, an empty remote is "no backup"', () => {
  const ws = empty()
  const out = restore(cfg(ws, join(tmp(), 'missing.git')))
  expect(out.error).toBeDefined()
  expect(out.skipped).toBeUndefined()
  expect(restore(cfg(ws, remote())).skipped).toBe('no backup')
  // a remote that works after the failure restores
  const r = remote()
  expect(backup(cfg(workspace(), r), true).error).toBeUndefined()
  expect(restore(cfg(ws, r)).restored).toBeDefined()
})

test('a first backup after a skipped restore goes on top of the remote branch', () => {
  const r = remote()
  const first = backup(cfg(workspace(), r), true)
  const b = workspace() // migrated by hand: no local history, the remote has a branch
  put(join(b, 'home', 'memory', 'new.md'), 'n')
  const out = backup(cfg(b, r), true)
  expect(out.error).toBeUndefined()
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(out.sha!)
  expect(sh('--git-dir', r, 'merge-base', '--is-ancestor', first.sha!, out.sha!)).toBe('')
})

test('the lock is free during the push, and a held lock skips the backup', () => {
  const r = remote()
  const ws = workspace()
  expect(backup(cfg(ws, r), true, () => null).skipped).toBe('lock')
  let pushedAtRelease: boolean | undefined
  const out = backup(cfg(ws, r), true, () => () => {
    pushedAtRelease =
      Bun.spawnSync(['git', '--git-dir', r, 'rev-parse', '--verify', 'manager-home']).exitCode === 0
  })
  expect(out.error).toBeUndefined()
  expect(pushedAtRelease).toBe(false) // released before the push
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(out.sha!)
})

test('the file and byte counts come from the tree', () => {
  const r = remote()
  const ws = workspace()
  const out = backup(cfg(ws, r), true)
  expect(out.error).toBeUndefined()
  const j = JSON.parse(readFileSync(join(ws, 'home', 'backup.json'), 'utf8'))
  expect(j.files).toBeGreaterThan(0)
  expect(j.bytes).toBeGreaterThan(0)
})

test('a backup with no change makes no commit; backup.json records the last run', () => {
  const r = remote()
  const ws = workspace()
  const a = backup(cfg(ws, r), true)
  const b = backup(cfg(ws, r), true)
  expect(b.sha).toBe(a.sha)
  expect(b.changed).toBe(false)
  const j = JSON.parse(readFileSync(join(ws, 'home', 'backup.json'), 'utf8'))
  expect(j.sha).toBe(a.sha)
  expect(backupAge(join(ws, 'home'), Date.parse(j.at) + 5000)).toBe(5000)
  expect(backupAge(tmp(), Date.now())).toBeUndefined()
})
